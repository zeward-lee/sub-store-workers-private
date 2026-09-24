/**
 * [geoip-czdb] 脚本内 IP 归属地查询（Workers 覆盖层新增文件，与上游零冲突）
 *
 * 职责：
 *  1. 从 proxies 提取节点 server 中的 IP 字面量（域名跳过，不做 DNS 解析）—— extractIps
 *  2. 走自建 czdb 批量接口一次预取归属地 —— geoipBatchLookup（≤500/批，5s 超时，全容错）
 *  3. 把结果包装成注入沙箱的同步查询 API —— createGeoipInjector / makeApi
 *
 * 接入模式（预取注入）：宿主在脚本进沙箱前完成批量查询，脚本内同步调用：
 *   geoip.lookup(ip) → { country, province, city, isp } 或 null
 * 仅当脚本文本含 'geoip' 字样才触发预取（零引用零开销）。
 *
 * 配置：
 *  - 代码内置默认 BASE（GEOIP_DEFAULT_BASE，自建 czdb 批量端点）
 *  - env.GEOIP_CZDB_BASE 可覆盖 BASE（读 globalThis.__workerEnv，每次调用时取，测试可动态改）
 *  - env 值为 'off' / 'disabled'（不区分大小写）→ 整个功能关闭：不预取，lookup 恒返回 null
 *
 * 注意：
 *  - 仅对 server 为 IP 字面量的节点生效；域名节点（多数机场）不做 DNS 解析，lookup 返回 null
 *  - 批量请求全部并行发起、受总预算（timeoutMs）约束：预算耗尽的批次跳过、已得结果保留；
 *    硬错误（HTTP/畸形/网络）→ 整体空 Map；任何路径都不阻塞脚本执行
 *  - prefetch 结果带 60s 短 TTL 签名缓存（同 IP 集合复用，上限 8 条），返回 Map 附 .disabled/.base 元信息
 *
 * 设计约束（仿 x-cache.js）：
 *  - 本模块不 import 任何其它模块（保证可被 node 直接单测；也不引入循环依赖）
 *  - fetch 通过参数注入（fetchFn），便于单测传 fake 实现
 *  - 网络相关函数内部全 try/catch，任何异常一律 fail-closed（空 Map）
 */

/** 自建 czdb 批量端点默认 BASE（env.GEOIP_CZDB_BASE 可覆盖） */
export const GEOIP_DEFAULT_BASE = 'https://czdb-query.pages.dev/c234ee7de877875847a3d6fd/czbatch';

/** 单次批量请求的 IP 上限（端点约束 500/批） */
export const GEOIP_BATCH_SIZE = 500;

/** 单次预取提取的 IP 总量上限（去重后，超出部分忽略） */
export const GEOIP_IP_LIMIT = 2000;

/** 单次批量请求超时（毫秒），走 AbortSignal.timeout */
export const GEOIP_TIMEOUT_MS = 5000;

/** 归属地记录只保留这四个字段（多余字段一律丢弃，防响应体污染沙箱数据） */
const GEOIP_FIELDS = ['country', 'province', 'city', 'isp'];

/** prefetch 结果短 TTL 缓存时长（毫秒）：签名=排序后 IP 集合 join */
export const GEOIP_CACHE_TTL_MS = 60000;

/** prefetch 缓存条目上限（按签名计），超限删最旧（插入序） */
export const GEOIP_CACHE_LIMIT = 8;

/** 关闭功能的环境变量取值（不区分大小写） */
const OFF_VALUES = ['off', 'disabled'];

/** IPv4 严格正则：四段 0-255，拒绝前导零（01.2.3.4 视为非法，避免八进制歧义） */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv6 粗判：含 ':' 且只含十六进制/冒号/点（兼容 ::ffff:1.2.3.4 形态），长度 ≤45 */
const IPV6_ROUGH_RE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * 判断字符串是否为 IP 字面量
 *
 * @param {*} str 待判断的值
 * @returns {boolean} IPv4 严格校验（0-255 四段，无前导零）；IPv6 粗判（含 ':' 且字符集合法）。
 *   已知可接受误报：'12:34' 这类纯十六进制+冒号串会被当作 IPv6（端点会对其返回 {}，即未知）。
 */
export function isIpLiteral(str) {
    if (typeof str !== 'string') return false;
    const s = str.trim();
    if (s.length < 2 || s.length > 45) return false;
    if (IPV4_RE.test(s)) return true;
    return s.indexOf(':') !== -1 && IPV6_ROUGH_RE.test(s);
}

/**
 * 从 proxies 数组提取节点 server 中的 IP 字面量
 *
 * 规则：域名跳过（不做 DNS 解析）；去重且保序（首个出现位置）；上限 GEOIP_IP_LIMIT(2000)。
 *
 * @param {Array} proxies 代理节点数组（元素可能缺 server / 非对象 / server 非字符串，全部容错）
 * @returns {string[]} 去重保序的 IP 字面量数组
 */
export function extractIps(proxies) {
    const out = [];
    if (!Array.isArray(proxies)) return out;
    const seen = new Set(); // Set 判重：避免 2000 上限下 indexOf 的 O(n²)
    for (let i = 0; i < proxies.length && out.length < GEOIP_IP_LIMIT; i++) {
        const p = proxies[i];
        if (!p || typeof p !== 'object') continue;
        const server = p.server;
        if (typeof server !== 'string') continue;
        const s = server.trim();
        if (!isIpLiteral(s)) continue;
        if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}

/**
 * 把 geoipBatchLookup 产出的 Map 摊平为普通对象（ip → 归属地记录 或 不存在=未知）
 *
 * 用途：QuickJS 沙箱注入走 JSON.stringify 边界，Map 与函数都过不去，
 * 只能以纯对象形态传给 injectAPI，再在沙箱内组装 geoip.lookup。
 *
 * @param {Map} map ip → {country,province,city,isp}
 * @returns {Object} 纯对象（JSON 安全）
 */
export function geoipMapToRecord(map) {
    const rec = {};
    if (!map || typeof map.forEach !== 'function') return rec;
    map.forEach((value, key) => {
        if (typeof key !== 'string' || key === '' || key === '__proto__' || key === 'constructor' || key === 'prototype') return;
        if (!value || typeof value !== 'object') return;
        rec[key] = value;
    });
    return rec;
}

/**
 * 规整单条归属地记录：只保留四个字符串字段，全空则视为未知（null）
 *
 * @param {*} raw 端点返回的单条记录
 * @returns {Object|null} {country,province,city,isp}（字段可能不全）或 null
 */
function sanitizeRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    let has = false;
    for (const f of GEOIP_FIELDS) {
        if (typeof raw[f] === 'string' && raw[f] !== '') {
            out[f] = raw[f];
            has = true;
        }
    }
    return has ? out : null;
}

/**
 * 解析生效 BASE：显式传入的 base 优先，'off'/'disabled' 返回 null（功能关闭），
 * 空串/未传回退默认 BASE
 *
 * @param {*} base 配置的 BASE 值
 * @returns {string|null} 生效 BASE 或 null（关闭）
 */
function resolveBaseValue(base) {
    let t = '';
    if (typeof base === 'string') t = base.trim();
    else if (base !== undefined && base !== null) t = String(base).trim();
    if (t === '') return GEOIP_DEFAULT_BASE;
    if (OFF_VALUES.indexOf(t.toLowerCase()) !== -1) return null;
    return t;
}

/**
 * 自建 czdb 批量归属地查询
 *
 * 分批（≤GEOIP_BATCH_SIZE）POST JSON {"ips":[...]}，期望响应
 * {"ok":true,"ver":{...},"results":{"1.2.3.4":{country,province,city,isp} 或 {}}}。
 *
 * 预算模型（防最坏 批数×单批超时 阻塞沙箱执行）：
 *  - 全部批次 Promise.all **并行发起**，总预算 = timeoutMs（从进入函数起算）
 *  - 每批 signal 超时 = min(总剩余预算, timeoutMs) → 总耗时最坏 ≈ timeoutMs（2000 IP 也一样）
 *  - 预算耗尽/超时中断的批次按失败**跳过**，已完成批次的结果**保留**
 *  - 硬错误（HTTP 非 2xx / 响应畸形 / fetch 网络抛错）仍整体 fail-closed → 空 Map
 *  - 外层任何意外异常 → 空 Map（不抛错）
 *
 * @param {string[]} ips 已去重的 IP 字面量数组（去重由 extractIps 保证，此处不再去重）
 * @param {Object} opts
 * @param {string} opts.base 批量端点 BASE（必须为非空字符串；空/缺失/'off'/'disabled' → 不请求直接空 Map）
 * @param {Function} [opts.fetchFn] fetch 实现（默认 globalThis.fetch）
 * @param {number} [opts.timeoutMs=5000] 总预算（毫秒），兼作单批超时上限（AbortSignal.timeout）
 * @returns {Promise<Map<string, Object>>} ip → 归属地记录；未知 IP 不在 Map 中
 */
export async function geoipBatchLookup(ips, opts = {}) {
    const empty = new Map();
    try {
        if (!Array.isArray(ips) || ips.length === 0) return empty;
        // 低层 fail-closed：base 必须是显式的非空非关闭值；空/缺失不猜默认值
        // （默认 BASE 的回退由 createGeoipInjector 在调用前解析完成）
        const base = typeof opts.base === 'string' ? opts.base.trim() : opts.base != null ? String(opts.base).trim() : '';
        if (base === '' || OFF_VALUES.indexOf(base.toLowerCase()) !== -1) return empty;

        const fetchFn = typeof opts.fetchFn === 'function'
            ? opts.fetchFn
            : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
        if (!fetchFn) return empty;

        const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : GEOIP_TIMEOUT_MS;

        const start = Date.now();
        const chunks = [];
        for (let i = 0; i < ips.length; i += GEOIP_BATCH_SIZE) {
            chunks.push(ips.slice(i, i + GEOIP_BATCH_SIZE));
        }

        // 并行发起全部批次：每批超时 = min(总剩余预算, timeoutMs)
        const tasks = chunks.map(function (chunk) {
            const remain = timeoutMs - (Date.now() - start);
            if (remain <= 0) return Promise.resolve({ ok: false, timeout: true, records: null });
            const per = Math.min(remain, timeoutMs);
            return fetchFn(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ips: chunk }),
                signal: AbortSignal.timeout(per),
            }).then(async function (resp) {
                if (!resp || !resp.ok) {
                    throw new Error('geoip HTTP ' + (resp && resp.status ? resp.status : 'no-response'));
                }
                const data = await resp.json();
                if (!data || typeof data !== 'object' || data.ok !== true || !data.results || typeof data.results !== 'object') {
                    throw new Error('geoip 响应体畸形');
                }
                const records = {};
                for (const ip of chunk) {
                    const rec = sanitizeRecord(data.results[ip]);
                    if (rec) records[ip] = rec;
                }
                return { ok: true, timeout: false, records: records };
            }).catch(function (e) {
                return { ok: false, timeout: isBudgetAbort(e), records: null };
            });
        });

        const settled = await Promise.all(tasks);

        let hardFail = false;
        for (const r of settled) {
            if (r.ok) {
                for (const ip in r.records) empty.set(ip, r.records[ip]);
            } else if (!r.timeout) {
                hardFail = true; // 硬错误维持整体 fail-closed
            }
            // timeout（预算耗尽/中断）→ 该批跳过，已得结果保留
        }
        if (hardFail) return new Map();
    } catch (e) {
        // fail-closed：任何意外错误都返回空 Map，绝不阻塞脚本执行
        return new Map();
    }
    return empty;
}

/**
 * 判定批次失败是否属于「超时/预算中断」类（此类保留已得结果，其余按硬错误整体空 Map）
 *
 * 说明：AbortSignal.timeout 在不同运行时抛 DOMException('TimeoutError') 或 AbortError，
 * fake fetch 可能 reject 普通Error带 abort/timeout 字样，这里按 name+message 宽容匹配。
 *
 * @param {*} e 批次 catch 到的错误（可能为 undefined，如 remain<=0 的直接短路）
 * @returns {boolean}
 */
function isBudgetAbort(e) {
    if (!e) return true;
    const name = e.name || '';
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    return /abort|timed?\s*out/i.test(String(e.message || ''));
}

/**
 * 读取 env.GEOIP_CZDB_BASE（globalThis.__workerEnv，每次调用时取，便于测试动态切换）
 *
 * @returns {string} 环境变量值（未设置返回空串）
 */
function readEnvBase() {
    try {
        const env = globalThis.__workerEnv;
        if (env && typeof env.GEOIP_CZDB_BASE === 'string') return env.GEOIP_CZDB_BASE;
    } catch (e) { /* ignore */ }
    return '';
}

/**
 * 创建 geoip 预取注入器
 *
 * BASE 优先级：opts.base（显式传入，单测用）> env.GEOIP_CZDB_BASE > GEOIP_DEFAULT_BASE；
 * 生效值为 'off'/'disabled'（不区分大小写）→ 功能关闭（isDisabled()=true，prefetch 不发请求）。
 *
 * @param {Object} [opts]
 * @param {string} [opts.base] 显式 BASE（优先于 env；'off'/'disabled' 关闭）
 * @param {Function} [opts.fetchFn] fetch 实现（默认 globalThis.fetch）
 * @param {number} [opts.timeoutMs] 单批超时（默认 GEOIP_TIMEOUT_MS）
 * @returns {{shouldPrefetch: Function, prefetch: Function, makeApi: Function, isDisabled: Function}}
 *   - shouldPrefetch(scriptText)：脚本文本含 'geoip'（不区分大小写）才预取——零引用零开销
 *   - prefetch(proxies) → Promise<Map>：提取 IP → 批量查询；关闭/无 IP/任何失败 → 空 Map（不抛错）
 *   - makeApi(map) → { lookup(ip) }：宿主侧查询对象；命中返回 {country,province,city,isp}，否则 null
 *     （函数无法跨沙箱 JSON 边界，沙箱内注入由 quickjs-executor 的 injectAPI 用数据 + 沙箱侧函数组装）
 *   - isDisabled()：功能是否处于关闭状态
 */
export function createGeoipInjector(opts = {}) {
    const optBase = typeof opts.base === 'string' ? opts.base : undefined;
    const optFetch = typeof opts.fetchFn === 'function' ? opts.fetchFn : null;

    // prefetch 结果短 TTL 缓存：签名=排序后 IP 集合 join，60s 内同签名直接复用；
    // 上限 GEOIP_CACHE_LIMIT(8)，超限删最旧（Map 迭代序=插入序）
    const cache = new Map();

    function cacheGet(sig) {
        const hit = cache.get(sig);
        if (!hit) return null;
        if (Date.now() - hit.at > GEOIP_CACHE_TTL_MS) {
            cache.delete(sig);
            return null;
        }
        return hit.map;
    }

    function cachePut(sig, map) {
        if (cache.has(sig)) cache.delete(sig);
        cache.set(sig, { at: Date.now(), map: map });
        while (cache.size > GEOIP_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    }

    /** 空 Map 附上 disabled/base 元信息（挂在 Map 对象上，保持对调用方 Map 形态兼容） */
    function withMeta(map, disabled, base) {
        map.disabled = disabled;
        map.base = base;
        return map;
    }

    function resolveBase() {
        const raw = optBase !== undefined ? optBase : readEnvBase();
        return resolveBaseValue(raw);
    }

    return {
        /** 功能是否关闭（env/base 为 'off'/'disabled'） */
        isDisabled() {
            return resolveBase() === null;
        },

        /**
         * 触发条件判断：仅当脚本文本含 'geoip' 字样才预取（零引用零开销）。
         * 注意：不在此处判断关闭状态——关闭时仍需注入恒 null 的 lookup，
         * 由 prefetch 内部跳过请求实现「不预取」。
         */
        shouldPrefetch(scriptText) {
            if (typeof scriptText !== 'string') return false;
            return scriptText.toLowerCase().indexOf('geoip') !== -1;
        },

        /**
         * 预取：proxies → IP 提取 → 签名查缓存 → 批量查询。
         * 关闭（不发请求）/无 IP 字面量/查询失败 → 空 Map。
         * 返回 Map 附带元信息：map.disabled（功能是否关闭）、map.base（生效 BASE，关闭时 null），
         * 供调用方复用判定（免重复读 env / 再调 isDisabled）。
         *
         * @param {Array} proxies 代理节点数组
         * @returns {Promise<Map<string, Object>>} ip → {country,province,city,isp}（带 .disabled/.base）
         */
        async prefetch(proxies) {
            const base = resolveBase();
            if (base === null) return withMeta(new Map(), true, null);
            const ips = extractIps(proxies);
            if (ips.length === 0) return withMeta(new Map(), false, base);

            const sig = ips.slice().sort().join(',');
            const hit = cacheGet(sig);
            if (hit) return hit;

            const map = await geoipBatchLookup(ips, {
                base: base,
                fetchFn: optFetch,
                timeoutMs: opts.timeoutMs,
            });
            withMeta(map, false, base);
            cachePut(sig, map);
            return map;
        },

        /**
         * 组装宿主侧查询 API
         *
         * @param {Map} map prefetch 产出（空 Map → lookup 恒 null，即关闭/失败模式）
         * @returns {{lookup: Function}} geoip.lookup(ip) → {country,province,city,isp}|null
         */
        makeApi(map) {
            const data = geoipMapToRecord(map);
            return {
                lookup(ip) {
                    if (typeof ip !== 'string') return null;
                    // hasOwnProperty 防御：否则 lookup('__proto__') 会沿原型链摸到 Object.prototype
                    if (!Object.prototype.hasOwnProperty.call(data, ip)) return null;
                    const r = data[ip];
                    return r === undefined || r === null ? null : r;
                },
            };
        },
    };
}
