/**
 * [quickjs-timeout] QuickJS 脚本时间预算中断器（deadline 式，替代旧的指令计数式）
 *
 * 职责：
 *  - 提供 SCRIPT_TIMEOUT_MS：脚本单次执行的 wall-clock 时间预算
 *  - 提供 createDeadlineGuard：产出可挂到 runtime.setInterruptHandler 的
 *    interrupt handler，以及 arm()/disarm() 两个生命周期开关
 *
 * 为什么用时间预算而不是指令计数：
 *  - 旧方案（每 5000 条指令中断一次）有两个致命缺陷：
 *    1) 计数器挂在 runtime 闭包上，跨脚本执行共享——前次脚本执行了一半的残余
 *       计数会让下一个无辜脚本提前被"误杀"；
 *    2) 与时间完全脱钩——快脚本被打断（白耗 5000 条指令的重置开销），
 *       慢脚本反而拦不住（每 5000 条指令才看一眼，单位时间内放过的指令数无上限）。
 *  - deadline 方案：arm() 时记下 deadline = now + 预算，interruptHandler 每次被调
 *    只做一次 now > deadline 比较。超时 → 返回 true，QuickJS 立即抛出
 *    "interrupted" 错误终止执行。
 *
 * 设计约束（brief 已定）：
 *  - 本模块零依赖、零 import（quickjs-executor.js 依赖 ./quickjs.wasm，
 *    node 无法直接加载，timeout 逻辑必须独立成小文件以便单测直跑）
 *  - QuickJS 的 interruptHandler 只在沙箱 JS 执行期间被回调，宿主 await 期间
 *    不计时——因此 wall-clock 预算对 I/O 等待天然公平，不会误杀慢网络场景
 *  - handler 由 QuickJS C 层直接回调，this 不可控，因此用闭包捕获 guard 对象
 *    读写 deadline（语义等价于 this.deadline，但对调用方式免疫）
 */

/**
 * 脚本单次执行 wall-clock 预算（毫秒）。
 * QuickJS interruptHandler 只在 JS 执行期间被调，宿主 await 期间不计时，天然公平。
 */
export const SCRIPT_TIMEOUT_MS = 8000;

/** deadline 的"未武装"哨兵值：永远大于 now()，handler 恒返回 false */
const DISARMED_DEADLINE = Infinity;

/**
 * 创建时间预算中断器
 *
 * 用法（quickjs-executor.js）：
 *   const guard = createDeadlineGuard();
 *   runtime.setInterruptHandler(guard.handler);
 *   guard.arm();                        // 执行用户脚本前
 *   try { context.evalCode(script); }
 *   finally { guard.disarm(); }         // 成功/抛错都要解除，防止残留 deadline 误杀下个脚本
 *
 * @param {{timeoutMs?: number, now?: () => number}} [opts]
 *        timeoutMs 超时预算毫秒数（非法值回退 SCRIPT_TIMEOUT_MS）
 *        now       时钟函数（默认 Date.now；单测可注入假时钟）
 * @returns {{deadline: number, arm: () => void, disarm: () => void, handler: () => boolean}}
 *          deadline   当前生效的截止时间戳（Infinity 表示未武装，仅供观测）
 *          arm        武装：deadline = now() + timeoutMs（每次执行前必须调用，覆盖旧值）
 *          disarm     解除：deadline = Infinity（执行结束后必须调用，防残留误杀）
 *          handler    interruptHandler 回调：超时返回 true 请求 QuickJS 中断
 */
export function createDeadlineGuard({ timeoutMs, now } = {}) {
    // 防御式参数兜底：非法 timeoutMs / 非函数 now 一律回退默认值
    const budget =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : SCRIPT_TIMEOUT_MS;
    const nowFn = typeof now === 'function' ? now : Date.now;

    const guard = {
        deadline: DISARMED_DEADLINE,

        /** 武装：记下本次执行的截止时间（覆盖旧值，天然防跨执行残留） */
        arm() {
            guard.deadline = nowFn() + budget;
        },

        /** 解除：恢复为永不超时（成功返回与抛错路径都要走到） */
        disarm() {
            guard.deadline = DISARMED_DEADLINE;
        },

        /**
         * QuickJS interruptHandler 回调（JS 执行期间被周期性调用）。
         * 返回 true → QuickJS 立即中断，抛出 "interrupted" 错误。
         * 恒返回 false → 正常执行，单次检查成本仅一次数值比较。
         */
        handler() {
            return nowFn() > guard.deadline;
        },
    };

    return guard;
}

/**
 * 判定 deadline 是否真实过期（超时判定的唯一依据）
 *
 * 不再用「错误消息含 interrupt 子串」判定——用户脚本可能合法抛出
 * new Error('interrupted by user') 这类含该子串的消息，子串匹配会误标成超时。
 * 改为直接看 guard 状态：只有 deadline 已武装且被 now() 真实越过得才判超时。
 *
 * 注意：调用时机必须在 disarm() 之前（disarm 后 deadline=Infinity，恒判未超时）；
 * executor 的错误处理点均满足此前置条件（finally disarm 前取判定或快照）。
 *
 * @param {{deadline: number}|null|undefined} guard - createDeadlineGuard 产物（可为空，空值判未超时）
 * @param {() => number} [now] - 时钟函数（默认 Date.now；单测可注入假时钟）
 * @returns {boolean} true 表示本次执行确实因时间预算到期被中断
 */
export function isDeadlineExceeded(guard, now) {
    if (!guard || typeof guard.deadline !== 'number') return false;
    if (guard.deadline === DISARMED_DEADLINE) return false;
    const nowFn = typeof now === 'function' ? now : Date.now;
    return nowFn() > guard.deadline;
}

/**
 * 统一格式化脚本错误消息（超时/非超时两个出口）
 *
 * 超时：`<prefix>: Script timeout: exceeded <timeoutMs>ms (interrupted: <rawMsg>)`
 * 非超时：`<prefix>: <rawMsg>`（原样透传，绝不误标）
 *
 * @param {string} prefix - 错误前缀（如 'Script evaluation failed'）
 * @param {string} rawMsg - getErrorMessage 提取的原始消息
 * @param {boolean} isTimedOut - isDeadlineExceeded 的判定结果
 * @param {number} timeoutMs - 生效的时间预算（消息内的毫秒数；非法值回退 SCRIPT_TIMEOUT_MS）
 * @returns {string} 最终 Error 消息
 */
export function formatScriptError(prefix, rawMsg, isTimedOut, timeoutMs) {
    if (isTimedOut) {
        const budget = Number.isFinite(timeoutMs) ? timeoutMs : SCRIPT_TIMEOUT_MS;
        return prefix + ': Script timeout: exceeded ' + budget + 'ms (interrupted: ' + rawMsg + ')';
    }
    return prefix + ': ' + rawMsg;
}
