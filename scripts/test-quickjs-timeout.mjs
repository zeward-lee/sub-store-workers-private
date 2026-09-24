#!/usr/bin/env node
/**
 * [quickjs-timeout] 时间预算中断器单测（无框架，node 直跑：node scripts/test-quickjs-timeout.mjs）
 *
 * 背景：quickjs-executor.js 依赖 './quickjs.wasm'（Wrangler 原生 WASM import），
 * node 无法直接 import，因此本测试手工复刻 executor 的 runtime 配置
 * （16MB 内存 / 1MB 栈 / setInterruptHandler(guard.handler)）与 arm/disarm 流程。
 *
 * 覆盖：
 *  - createDeadlineGuard 单元（假时钟）：未武装/武装/重arm覆盖/disarm/非法参数回退
 *  - evalCode 死循环 → 预算 + 2s 容差内抛 "Script timeout: exceeded Nms"
 *  - callFunction 同步死循环 → 同上
 *  - async 函数内死循环（pending jobs 路径）→ 同上
 *  - 正常小脚本（map + filter）→ 正常完成且结果正确（防误杀）
 *  - 重 CPU 有限循环（200 万次累加）→ 8s 预算内正常完成
 *  - async 函数 + 多个 Promise 微任务 → 正常完成（async 基本路径不回归）
 *  - 连续两次死循环 → 两次都能在预算内被掐，且第二次不是被残留 deadline 立即误杀
 *  - async 抛普通错误 → 消息不被误改写为 timeout（interrupt 识别不误伤）
 */

import { newQuickJSWASMModule, RELEASE_SYNC } from 'quickjs-emscripten';
import {
    createDeadlineGuard,
    SCRIPT_TIMEOUT_MS,
    isDeadlineExceeded,
    formatScriptError,
} from '../src/vendor/quickjs-timeout.js';

let passed = 0;
const failures = [];

function ok(cond, label) {
    if (!cond) throw new Error(label || '断言失败');
}

function eq(actual, expected, label = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label} 期望 ${b} 实际 ${a}`);
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
}

// ---------------------------------------------------------------------------
// 复刻 quickjs-executor.js 的 runtime 配置与执行流程
// ---------------------------------------------------------------------------

/** 与 initQuickJS 一致的 runtime 配置（16MB / 1MB / deadline handler） */
async function makeEnv() {
    const QuickJS = await newQuickJSWASMModule(RELEASE_SYNC);
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(1024 * 1024 * 16); // 16MB 内存限制
    runtime.setMaxStackSize(1024 * 1024);     // 1MB 栈限制
    const guard = createDeadlineGuard();
    runtime.setInterruptHandler(guard.handler);
    const context = runtime.newContext();
    return { QuickJS, runtime, context, guard };
}

/** 复刻 getErrorMessage：读 error.message，回退 dump */
function readMessage(context, errorHandle) {
    try {
        const msgHandle = context.getProp(errorHandle, 'message');
        const msg = context.getString(msgHandle);
        msgHandle.dispose();
        if (msg) return msg;
    } catch (e) { /* 回退 dump */ }
    try {
        const dumped = context.dump(errorHandle);
        if (typeof dumped === 'string') return dumped;
        if (dumped && typeof dumped === 'object' && dumped.message) return String(dumped.message);
        return String(dumped);
    } catch (e2) {
        return 'Unknown QuickJS error';
    }
}

/** 宿主参数 → QuickJS 值（复刻 serializeArgs 的 JSON 往返） */
function serializeArg(context, value) {
    const jsonStr = JSON.stringify(JSON.stringify(value));
    const r = context.evalCode('JSON.parse(' + jsonStr + ')');
    if (r.error) {
        const msg = readMessage(context, r.error);
        r.error.dispose();
        throw new Error('serializeArg failed: ' + msg);
    }
    return r.value;
}

/**
 * 复刻 executeInSandbox + callSandboxFunction 的完整执行流程：
 *   IIFE 包裹 → evalCode（arm/disarm 包裹）→ callFunction + pending jobs（arm/disarm 包裹）
 * 返回宿主环境结果；超时等错误以 Error 抛出（消息经 toScriptErrorMessage 改写）。
 */
async function runScript(env, script, fnName, args) {
    fnName = fnName || 'fn';
    args = args || [];
    const { context, runtime, guard } = env;

    // ===== executeInSandbox 段（判定快照在 disarm 前取，与 executor 一致）=====
    const wrappedScript = '(function(){\n' + script + '\nreturn ' + fnName + ';\n})()';
    guard.arm();
    let evalResult;
    let evalTimedOut = false;
    try {
        evalResult = context.evalCode(wrappedScript);
    } finally {
        evalTimedOut = isDeadlineExceeded(guard);
        guard.disarm();
    }
    if (evalResult.error) {
        const msg = readMessage(context, evalResult.error);
        evalResult.error.dispose();
        throw new Error(formatScriptError('Script evaluation failed', msg, evalTimedOut, SCRIPT_TIMEOUT_MS));
    }
    const fnHandle = evalResult.value;
    try {
        if (context.typeof(fnHandle) !== 'function') {
            throw new Error("'" + fnName + "' is not a function (got " + context.typeof(fnHandle) + ')');
        }

        // ===== callSandboxFunction 段：整段同一预算窗口，finally disarm =====
        const callArgs = args.map((a) => serializeArg(context, a));
        guard.arm();
        try {
            const callResult = context.callFunction(fnHandle, context.null, callArgs);
            for (const h of callArgs) {
                try { h.dispose(); } catch (e) { /* ignore */ }
            }
            if (callResult.error) {
                const msg = readMessage(context, callResult.error);
                callResult.error.dispose();
                throw new Error(formatScriptError('Script execution failed', msg, isDeadlineExceeded(guard), SCRIPT_TIMEOUT_MS));
            }

            let finalValue = callResult.value;
            if (context.typeof(finalValue) === 'object') {
                const resolvedPromise = context.resolvePromise(finalValue);
                const pendingJobsResult = runtime.executePendingJobs();
                if (pendingJobsResult && pendingJobsResult.error) {
                    const msg = readMessage(context, pendingJobsResult.error);
                    pendingJobsResult.error.dispose();
                    finalValue.dispose();
                    throw new Error(formatScriptError('Script pending jobs failed', msg, isDeadlineExceeded(guard), SCRIPT_TIMEOUT_MS));
                }
                // await 前 disarm（此后无沙箱执行），超时判定用 disarm 前快照
                const asyncTimedOut = isDeadlineExceeded(guard);
                guard.disarm();
                const resolvedResult = await resolvedPromise;
                if (resolvedResult.error) {
                    const msg = readMessage(context, resolvedResult.error);
                    resolvedResult.error.dispose();
                    finalValue.dispose();
                    throw new Error(formatScriptError('Script async execution failed', msg, asyncTimedOut, SCRIPT_TIMEOUT_MS));
                }
                finalValue.dispose();
                finalValue = resolvedResult.value;
            }

            const resultStr = context.dump(finalValue);
            finalValue.dispose();
            if (resultStr === undefined || resultStr === 'undefined') return undefined;
            try { return JSON.parse(resultStr); } catch (e) { return resultStr; }
        } finally {
            guard.disarm();
        }
    } finally {
        try { fnHandle.dispose(); } catch (e) { /* ignore */ }
    }
}

/** 断言一次执行在预算 + 容差内被掐，且错误消息带 "Script timeout" 与毫秒数 */
function assertTimedOut(label, err, elapsed) {
    const budget = SCRIPT_TIMEOUT_MS + 2000;
    ok(err && typeof err.message === 'string', `${label}: 应抛错`);
    ok(err.message.indexOf('Script timeout') !== -1, `${label}: 消息应含 "Script timeout"，实际: ${err.message}`);
    ok(err.message.indexOf(String(SCRIPT_TIMEOUT_MS)) !== -1, `${label}: 消息应含 ${SCRIPT_TIMEOUT_MS} 毫秒数，实际: ${err.message}`);
    ok(elapsed <= budget, `${label}: 耗时 ${elapsed}ms 应 ≤ 预算+容差 ${budget}ms`);
    ok(elapsed >= SCRIPT_TIMEOUT_MS * 0.5, `${label}: 耗时 ${elapsed}ms 应 ≥ 预算一半（防被残留 deadline 立即误杀）`);
}

// ---------------------------------------------------------------------------
// 1. createDeadlineGuard 单元（假时钟，不依赖 WASM）
// ---------------------------------------------------------------------------
console.log('\n[1] createDeadlineGuard 单元（假时钟）');

await checkAsync('未武装（初始态）→ handler 恒 false', async () => {
    let now = 1000;
    const guard = createDeadlineGuard({ now: () => now });
    ok(guard.handler() === false, '未武装不应超时');
    now = 99999999;
    ok(guard.handler() === false, '无论 now 走多远，未武装都不超时');
});

await checkAsync('arm 后：预算内 false、过预算 true', async () => {
    let now = 1000;
    const guard = createDeadlineGuard({ timeoutMs: 500, now: () => now });
    guard.arm();
    ok(guard.deadline === 1500, 'deadline = now + 预算');
    ok(guard.handler() === false, '预算内不超时');
    now = 1500;
    ok(guard.handler() === false, '恰好到点（> 严格比较）不超时');
    now = 1501;
    ok(guard.handler() === true, '过点即超时');
});

await checkAsync('重新 arm 覆盖旧 deadline（防跨执行残留）', async () => {
    let now = 1000;
    const guard = createDeadlineGuard({ timeoutMs: 500, now: () => now });
    guard.arm();
    now = 10000; // 第一个预算早过期
    ok(guard.handler() === true, '旧预算已超时');
    guard.arm(); // 新一次执行重新武装
    ok(guard.deadline === 10500, '新 deadline = 新 now + 预算，不被旧值影响');
    ok(guard.handler() === false, '新执行窗口内不超时');
});

await checkAsync('disarm 恢复永不超时（finally 语义）', async () => {
    let now = 1000;
    const guard = createDeadlineGuard({ timeoutMs: 500, now: () => now });
    guard.arm();
    guard.disarm();
    ok(guard.deadline === Infinity, 'disarm 后 deadline = Infinity');
    now = 999999999;
    ok(guard.handler() === false, 'disarm 后无论 now 多大都不超时');
});

await checkAsync('非法参数回退：timeoutMs 非法 → SCRIPT_TIMEOUT_MS；now 非函数 → Date.now', async () => {
    let now = 0;
    const g1 = createDeadlineGuard({ timeoutMs: -1, now: () => 0 });
    g1.arm();
    eq(g1.deadline, SCRIPT_TIMEOUT_MS, '非法 timeoutMs 应回退默认预算');
    const g2 = createDeadlineGuard({ timeoutMs: NaN, now: () => 0 });
    g2.arm();
    eq(g2.deadline, SCRIPT_TIMEOUT_MS, 'NaN 回退默认预算');
    const g3 = createDeadlineGuard({ timeoutMs: 0, now: () => 0 });
    g3.arm();
    eq(g3.deadline, SCRIPT_TIMEOUT_MS, '0 回退默认预算');
    const g4 = createDeadlineGuard({ now: 'not-a-fn' });
    g4.arm();
    ok(typeof g4.deadline === 'number' && Number.isFinite(g4.deadline), '非法 now 应回退 Date.now');
    ok(g4.deadline - Date.now() <= SCRIPT_TIMEOUT_MS + 50, '回退时钟按 Date.now 计');
});

await checkAsync('isDeadlineExceeded：武装未过期 false / 过期 true / disarmed false / guard 空 false', async () => {
    let now = 1000;
    const nowFn = () => now;
    const guard = createDeadlineGuard({ timeoutMs: 500, now: nowFn });

    ok(isDeadlineExceeded(null, nowFn) === false, 'guard 为 null 应判未超时');
    ok(isDeadlineExceeded(undefined, nowFn) === false, 'guard 为 undefined 应判未超时');
    ok(isDeadlineExceeded(guard, nowFn) === false, '未武装（deadline=Infinity）应判未超时');

    guard.arm();
    ok(isDeadlineExceeded(guard, nowFn) === false, '武装后未过期应判未超时');
    now = 1501;
    ok(isDeadlineExceeded(guard, nowFn) === true, '武装后过期应判超时');

    guard.disarm();
    now = 999999999;
    ok(isDeadlineExceeded(guard, nowFn) === false, 'disarm 后即使 now 巨大也应判未超时');
});

await checkAsync('formatScriptError：超时文案含 Script timeout + 毫秒数；非超时原样透传', async () => {
    const to = formatScriptError('Script execution failed', 'interrupted', true, SCRIPT_TIMEOUT_MS);
    ok(to === 'Script execution failed: Script timeout: exceeded ' + SCRIPT_TIMEOUT_MS + 'ms (interrupted: interrupted)', `超时文案不符: ${to}`);
    ok(to.indexOf('Script timeout') !== -1 && to.indexOf(String(SCRIPT_TIMEOUT_MS)) !== -1, '超时文案必须含 Script timeout 与毫秒数');

    const notTo = formatScriptError('Script execution failed', 'boom', false, SCRIPT_TIMEOUT_MS);
    ok(notTo === 'Script execution failed: boom', `非超时应原样透传: ${notTo}`);
    ok(notTo.indexOf('Script timeout') === -1, '非超时绝不误标');

    const fallback = formatScriptError('P', 'x', true, NaN);
    ok(fallback.indexOf('exceeded ' + SCRIPT_TIMEOUT_MS + 'ms') !== -1, `非法 timeoutMs 应回退默认预算: ${fallback}`);
});

// ---------------------------------------------------------------------------
// 2. 集成：真实 QuickJS runtime（复刻 executor 配置）
// ---------------------------------------------------------------------------
console.log(`\n[2] 集成（真实 QuickJS，SCRIPT_TIMEOUT_MS=${SCRIPT_TIMEOUT_MS}）`);

const env = await makeEnv();

await checkAsync('evalCode 死循环 → 预算+2s 内抛 Script timeout', async () => {
    const t0 = Date.now();
    let err = null;
    try {
        await runScript(env, 'while(true){}');
    } catch (e) {
        err = e;
    }
    assertTimedOut('死循环', err, Date.now() - t0);
});

await checkAsync('callFunction 同步死循环 → 预算+2s 内抛 Script timeout', async () => {
    const t0 = Date.now();
    let err = null;
    try {
        await runScript(
            env,
            'function fn() { while(true){} }',
            'fn',
            [],
        );
    } catch (e) {
        err = e;
    }
    assertTimedOut('同步函数死循环', err, Date.now() - t0);
});

await checkAsync('async 函数内死循环（pending jobs 路径）→ 预算+2s 内抛 Script timeout', async () => {
    const t0 = Date.now();
    let err = null;
    try {
        await runScript(
            env,
            'async function fn() { await Promise.resolve(1); while(true){} }',
            'fn',
            [],
        );
    } catch (e) {
        err = e;
    }
    assertTimedOut('async 死循环', err, Date.now() - t0);
});

await checkAsync('正常小脚本（map + filter）→ 正常完成且结果正确（防误杀）', async () => {
    const t0 = Date.now();
    const r = await runScript(
        env,
        'function fn(list) { return list.map(function(x){ return x * 2; }).filter(function(x){ return x > 2; }); }',
        'fn',
        [[1, 2, 3, 4]],
    );
    eq(r, [4, 6, 8]);
    ok(Date.now() - t0 < 2000, `小脚本应秒级完成，实际 ${Date.now() - t0}ms`);
});

await checkAsync('重 CPU 有限循环（200 万次累加）→ 预算内正常完成', async () => {
    const t0 = Date.now();
    const r = await runScript(
        env,
        'function fn() { var s = 0; for (var i = 0; i < 2000000; i++) { s += i; } return s; }',
        'fn',
        [],
    );
    eq(r, 1999999000000);
    const elapsed = Date.now() - t0;
    ok(elapsed < SCRIPT_TIMEOUT_MS, `200 万次循环应 < ${SCRIPT_TIMEOUT_MS}ms，实际 ${elapsed}ms`);
});

await checkAsync('async 函数 + 多个 Promise 微任务 → 正常完成（async 基本路径不回归）', async () => {
    const r = await runScript(
        env,
        'async function fn() { var s = 0; for (var i = 0; i < 10; i++) { s += await Promise.resolve(i); } return s; }',
        'fn',
        [],
    );
    eq(r, 45);
});

await checkAsync('连续两次死循环 → 两次都被掐，第二次非被残留 deadline 立即误杀', async () => {
    // 第一次
    let t0 = Date.now();
    let err1 = null;
    try { await runScript(env, 'while(true){}'); } catch (e) { err1 = e; }
    assertTimedOut('第一次死循环', err1, Date.now() - t0);
    const firstElapsed = Date.now() - t0;

    // 第二次：guard disarm 已恢复 Infinity，arm 重设新 deadline，不应被旧状态影响
    t0 = Date.now();
    let err2 = null;
    try { await runScript(env, 'while(true){}'); } catch (e) { err2 = e; }
    assertTimedOut('第二次死循环', err2, Date.now() - t0);
    console.log(`        （两次耗时 ${firstElapsed}ms / ${Date.now() - t0}ms，均在预算附近）`);
});

await checkAsync('async 抛普通错误 → 消息原样透传，不被误改写为 Script timeout', async () => {
    let err = null;
    try {
        await runScript(
            env,
            'async function fn() { throw new Error("boom"); }',
            'fn',
            [],
        );
    } catch (e) {
        err = e;
    }
    ok(err && err.message.indexOf('boom') !== -1, `应保留原始错误，实际: ${err?.message}`);
    ok(err.message.indexOf('Script timeout') === -1, '普通错误不应被改成超时');
});

await checkAsync('脚本抛 Error("interrupted by user")（callFunction 阶段）→ deadline 判定不误标，消息原样透传', async () => {
    // 回归动机：旧「消息含 interrupt 子串」判定会把该消息误标成超时；
    // 新逻辑只看 deadline 是否真实过期，预算未到期必须透传。
    let err = null;
    try {
        await runScript(
            env,
            'function fn() { throw new Error("interrupted by user"); }',
            'fn',
            [],
        );
    } catch (e) {
        err = e;
    }
    ok(err && err.message.indexOf('interrupted by user') !== -1, `应保留原始消息，实际: ${err?.message}`);
    ok(err.message.indexOf('Script timeout') === -1, `含 interrupt 子串的正常错误不得误标为超时: ${err?.message}`);
});

await checkAsync('脚本抛 Error("interrupted by user")（evalCode 阶段）→ 同样不误标', async () => {
    let err = null;
    try {
        await runScript(
            env,
            'throw new Error("interrupted by user");',
            'fn',
            [],
        );
    } catch (e) {
        err = e;
    }
    ok(err && err.message.indexOf('interrupted by user') !== -1, `应保留原始消息，实际: ${err?.message}`);
    ok(err.message.indexOf('Script timeout') === -1, `含 interrupt 子串的正常错误不得误标为超时: ${err?.message}`);
});

env.context.dispose();
env.runtime.dispose();

// ---------------------------------------------------------------------------
console.log(`\n结果: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
}
process.exit(failures.length > 0 ? 1 : 0);
