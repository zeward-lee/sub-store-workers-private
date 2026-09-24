#!/usr/bin/env node
/**
 * [geoip-czdb] 脚本内 IP 归属地查询单测（无框架，node 直跑：node scripts/test-geoip-czdb.mjs）
 *
 * 覆盖：
 *  - isIpLiteral：IPv4 严格正则（0-255/段数/前导零拒绝）、IPv6 粗判（含 ':' 字符集合法）、
 *    非字符串/空串/域名/带端口/zone-id 拒绝；已知可接受误报（'12:34'）钉值
 *  - extractIps：域名跳过（不做 DNS）、server 缺失/非字符串/元素非对象容错、去重保序、
 *    前后空格 trim、上限 2000 截断
 *  - geoipMapToRecord：Map 摊平 + __proto__/constructor 等危险键拒收（防原型污染）
 *  - geoipBatchLookup（fake fetch）：正常命中+字段白名单裁剪、未知 IP 不入 Map、
 *    501 IP 分 2 批（≤500/批）、超时（AbortSignal 真触发）、HTTP 500、响应体畸形
 *    （json 抛错/ok:false/缺 results/results 非对象）、fetch 抛错、空输入不发请求、
 *    base='off' 不发请求、任一批失败整体空 Map（fail-closed）
 *  - createGeoipInjector：shouldPrefetch（含 'geoip' 触发、大小写不敏感、非字符串 false）、
 *    makeApi.lookup（命中/未命中/非字符串/关闭模式空 Map）、env.GEOIP_CZDB_BASE 覆盖
 *    BASE、env='off'/'disabled' 关闭、显式 base 优先于 env、未配置回退默认 BASE、
 *    prefetch 对 proxies 混合 server 只取 IP 字面量并去重
 *  - injectAPI geoip 片段语义（模拟沙箱）：lookup 命中/未命中/非字符串
 *  - 源码接线检查（quickjs-executor.js 预取注入 + geoip-czdb.js 零依赖）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 动态 import 走 file:// URL（Windows 下绝对路径不能直接 import）
const gi = await import(pathToFileURL(path.join(ROOT, 'src/vendor/geoip-czdb.js')).href);

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('check() 不接受 async 用例，请用 checkAsync');
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.log(`  FAIL  ${name}\n        ${e?.message ?? e}`);
    }
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

function eq(actual, expected, label = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label} 期望 ${b} 实际 ${a}`);
}

function ok(cond, label) {
    if (!cond) throw new Error(label || '断言失败');
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

/** 记录调用的 fake fetch：handler(url, init, callIndex) → Response 形对象 */
function makeFetch(handler) {
    const calls = [];
    const fetchFn = async (url, init) => {
        calls.push({ url, init });
        return handler(url, init, calls.length);
    };
    fetchFn.calls = calls;
    return fetchFn;
}

function jsonResponse(obj) {
    return { ok: true, status: 200, async json() { return obj; } };
}

/** 挂起并在 signal abort 时 reject 的 fake fetch（模拟真实超时路径） */
function hangingFetch(url, init) {
    return new Promise((resolve, reject) => {
        if (init && init.signal) {
            if (init.signal.aborted) {
                reject(new Error('aborted'));
                return;
            }
            init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true });
        }
        // 永不 resolve
    });
}

// ---------------------------------------------------------------------------
// 1. isIpLiteral
// ---------------------------------------------------------------------------
console.log('\n[1] isIpLiteral');

check('IPv4 合法（边界 0/255、常规地址）', () => {
    for (const s of ['1.2.3.4', '0.0.0.0', '255.255.255.255', '8.8.8.8', '127.0.0.1', '192.168.1.100']) {
        ok(gi.isIpLiteral(s) === true, `${s} 应为合法 IPv4`);
    }
});

check('IPv4 非法（越界/段数/前导零/垃圾字符）', () => {
    for (const s of ['256.1.1.1', '1.2.3.256', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', '', 'abc', '1.2.3.4a', '999.999.999.999', '-1.2.3.4']) {
        ok(gi.isIpLiteral(s) === false, `${s} 应为非法 IPv4`);
    }
});

check('IPv6 粗判通过（含冒号且字符集合法，含 v4-mapped）', () => {
    for (const s of ['::1', 'fe80::1', '2001:db8::8a2e:370:7334', '::ffff:1.2.3.4', '2408:8207::abcd:1']) {
        ok(gi.isIpLiteral(s) === true, `${s} 应粗判为 IPv6`);
    }
});

check('IPv6 粗判拒绝（域名/端口串含非法字符/zone-id/非字符串）', () => {
    for (const s of ['example.com', 'x:1', 'fe80::1%eth0', '1.2.3.4:443%', '', null, undefined, 123, {}]) {
        ok(gi.isIpLiteral(s) === false, `${String(s)} 不应判为 IP`);
    }
});

check('已知可接受误报（粗判放行，端点会返回 {} 即未知）', () => {
    ok(gi.isIpLiteral('12:34') === true, "'12:34' 粗判放行（钉值，防行为漂移）");
    ok(gi.isIpLiteral('1.2.3.4:443') === true, "'1.2.3.4:443' 粗判放行（钉值）");
});

// ---------------------------------------------------------------------------
// 2. extractIps
// ---------------------------------------------------------------------------
console.log('\n[2] extractIps');

check('混合 proxies：域名跳过、IP 保留、去重保序、trim', () => {
    const proxies = [
        { name: 'a', server: '1.2.3.4' },
        { name: 'b', server: 'example.com' },
        { name: 'c', server: '2001:db8::1' },
        { name: 'd', server: '1.2.3.4' },
        { name: 'e', server: '  5.6.7.8  ' },
        { name: 'f' },
        {},
        { name: 'g', server: 123 },
        null,
        'not-an-object',
        { name: 'h', server: '8.8.8.8' },
    ];
    eq(gi.extractIps(proxies), ['1.2.3.4', '2001:db8::1', '5.6.7.8', '8.8.8.8']);
});

check('非数组输入 → 空数组', () => {
    eq(gi.extractIps(null), []);
    eq(gi.extractIps(undefined), []);
    eq(gi.extractIps({ server: '1.2.3.4' }), []);
    eq(gi.extractIps('proxies'), []);
});

check('上限 2000：2100 个唯一 IP 截断到 2000，保序取前 2000', () => {
    const proxies = [];
    for (let i = 0; i < 2100; i++) proxies.push({ server: `10.${Math.floor(i / 256)}.${i % 256}.1` });
    const out = gi.extractIps(proxies);
    eq(out.length, gi.GEOIP_IP_LIMIT);
    eq(out[0], '10.0.0.1');
    eq(out[1999], '10.7.207.1'); // 1999 → (7, 207)
});

// ---------------------------------------------------------------------------
// 3. geoipMapToRecord
// ---------------------------------------------------------------------------
console.log('\n[3] geoipMapToRecord');

check('Map 摊平为普通对象（JSON 安全）', () => {
    const map = new Map([['1.2.3.4', { country: '中国', province: '广东', city: '深圳', isp: '电信' }]]);
    eq(gi.geoipMapToRecord(map), { '1.2.3.4': { country: '中国', province: '广东', city: '深圳', isp: '电信' } });
});

check('危险键拒收（__proto__ 不进对象、原型不被污染）', () => {
    const map = new Map([
        ['__proto__', { country: 'X' }],
        ['constructor', { country: 'Y' }],
        ['1.2.3.4', { country: '中国' }],
    ]);
    const rec = gi.geoipMapToRecord(map);
    eq(Object.keys(rec), ['1.2.3.4']);
    eq({}.country, undefined, 'Object.prototype 不应被污染');
    eq(gi.geoipMapToRecord(null), {});
    eq(gi.geoipMapToRecord('map'), {});
});

// ---------------------------------------------------------------------------
// 4. geoipBatchLookup
// ---------------------------------------------------------------------------
console.log('\n[4] geoipBatchLookup');

await checkAsync('正常：命中裁剪白名单字段，未知 IP 不入 Map，请求形态正确', async () => {
    const fetchFn = makeFetch(() =>
        jsonResponse({
            ok: true,
            ver: { v4: 'x', v6: 'y' },
            results: {
                '1.2.3.4': { country: '中国', province: '广东', city: '深圳', isp: '电信', raw: 'junk-extra' },
                '8.8.4.4': {},
                '9.9.9.9': null,
            },
        }),
    );
    const map = await gi.geoipBatchLookup(['1.2.3.4', '8.8.4.4', '9.9.9.9'], {
        base: 'https://cz.example/batch',
        fetchFn,
    });
    eq(map.size, 1, '只有 1.2.3.4 有有效记录');
    eq(map.get('1.2.3.4'), { country: '中国', province: '广东', city: '深圳', isp: '电信' }, '多余字段 raw 应被裁掉');
    ok(!map.has('8.8.4.4'), '空记录 = 未知，不入 Map');
    ok(!map.has('9.9.9.9'));

    eq(fetchFn.calls.length, 1);
    const { url, init } = fetchFn.calls[0];
    eq(url, 'https://cz.example/batch');
    eq(init.method, 'POST');
    eq(init.headers['Content-Type'], 'application/json');
    eq(JSON.parse(init.body), { ips: ['1.2.3.4', '8.8.4.4', '9.9.9.9'] });
    ok(!!init.signal, '应带 AbortSignal 超时信号');
});

await checkAsync('分批：501 个 IP → 2 次请求（500+1），跨批结果合并', async () => {
    const ips = [];
    for (let i = 0; i < 501; i++) ips.push(`10.${Math.floor(i / 256)}.${i % 256}.1`);
    const fetchFn = makeFetch((url, init, idx) => {
        const { ips: chunk } = JSON.parse(init.body);
        ok(chunk.length <= gi.GEOIP_BATCH_SIZE, `单批应 ≤${gi.GEOIP_BATCH_SIZE}`);
        const results = {};
        for (const ip of chunk) results[ip] = { country: `C${idx}` };
        return jsonResponse({ ok: true, results });
    });
    const map = await gi.geoipBatchLookup(ips, { base: 'https://cz.example/batch', fetchFn });
    eq(fetchFn.calls.length, 2);
    eq(JSON.parse(fetchFn.calls[0].init.body).ips.length, 500);
    eq(JSON.parse(fetchFn.calls[1].init.body).ips.length, 1);
    eq(map.size, 501, '两批结果应合并');
    eq(map.get('10.0.0.1'), { country: 'C1' });
    eq(map.get(ips[500]), { country: 'C2' });
});

await checkAsync('超时：fetch 挂起 + AbortSignal 真触发 → 空 Map 不抛', async () => {
    let sawSignal = false;
    const fetchFn = (url, init) => {
        sawSignal = !!(init && init.signal);
        return hangingFetch(url, init);
    };
    // node 的 AbortSignal.timeout 定时器不 ref 事件循环，测试需自备 keep-alive 才能等到触发
    const keepAlive = setTimeout(() => {}, 1000);
    let map;
    try {
        map = await gi.geoipBatchLookup(['1.2.3.4'], {
            base: 'https://cz.example/batch',
            fetchFn,
            timeoutMs: 50,
        });
    } finally {
        clearTimeout(keepAlive);
    }
    ok(sawSignal, '应向 fetch 传入 signal');
    eq(map.size, 0, '超时应返回空 Map');
});

await checkAsync('HTTP 500 → 空 Map 不抛', async () => {
    const fetchFn = makeFetch(() => ({ ok: false, status: 500, async json() { return {}; } }));
    const map = await gi.geoipBatchLookup(['1.2.3.4'], { base: 'https://cz.example/batch', fetchFn });
    eq(map.size, 0);
});

await checkAsync('响应体畸形（json 抛错/ok:false/缺 results/results 非对象）→ 空 Map', async () => {
    const malformed = [
        { ok: true, status: 200, async json() { throw new Error('bad json'); } },
        jsonResponse({ ok: false, results: {} }),
        jsonResponse({ ok: true }),
        jsonResponse({ ok: true, results: 'not-object' }),
        jsonResponse({ ok: true, results: [] }),
        jsonResponse(null),
    ];
    for (const resp of malformed) {
        const fetchFn = makeFetch(() => resp);
        const map = await gi.geoipBatchLookup(['1.2.3.4'], { base: 'https://cz.example/batch', fetchFn });
        eq(map.size, 0, `畸形响应应返回空 Map: ${JSON.stringify(String(resp))}`);
    }
});

await checkAsync('fetch 抛错（网络失败）→ 空 Map 不抛', async () => {
    const fetchFn = async () => {
        throw new Error('network down');
    };
    const map = await gi.geoipBatchLookup(['1.2.3.4'], { base: 'https://cz.example/batch', fetchFn });
    eq(map.size, 0);
});

await checkAsync('任一批硬错误 → 整体空 Map（fail-closed，不留部分结果）', async () => {
    const ips = [];
    for (let i = 0; i < 501; i++) ips.push(`10.${Math.floor(i / 256)}.${i % 256}.1`);
    const fetchFn = makeFetch((url, init, idx) => {
        if (idx === 2) throw new Error('second batch boom');
        const results = {};
        for (const ip of JSON.parse(init.body).ips) results[ip] = { country: 'C1' };
        return jsonResponse({ ok: true, results });
    });
    const map = await gi.geoipBatchLookup(ips, { base: 'https://cz.example/batch', fetchFn });
    eq(map.size, 0, '第二批硬错误应丢弃第一批结果');
});

await checkAsync('总预算钉死：4 批全部挂起 → 并行发起，总耗时 < timeoutMs+500ms（非 4×timeoutMs）', async () => {
    const ips = [];
    for (let i = 0; i < 1600; i++) ips.push(`10.${Math.floor(i / 256)}.${i % 256}.1`); // 4 批(500/500/500/100)
    const t0 = Date.now();
    const keepAlive = setTimeout(() => {}, 2000); // node AbortSignal.timeout 不 ref 事件循环，需自备 keep-alive
    let map, calls;
    try {
        const fetchFn = makeFetch((url, init) => hangingFetch(url, init));
        map = await gi.geoipBatchLookup(ips, { base: 'https://cz.example/batch', fetchFn, timeoutMs: 300 });
        calls = fetchFn.calls;
    } finally {
        clearTimeout(keepAlive);
    }
    const elapsed = Date.now() - t0;
    eq(calls.length, 4, '4 批应全部并行发起');
    ok(elapsed < 300 + 500, `总耗时 ${elapsed}ms 应 < 800ms（串行会到 1200ms）`);
    eq(map.size, 0, '全部批次超时 → 空 Map');
});

await checkAsync('预算耗尽部分保留：第 1 批正常、第 2 批挂起超时 → 保留第 1 批已得结果', async () => {
    const ips = [];
    for (let i = 0; i < 501; i++) ips.push(`10.${Math.floor(i / 256)}.${i % 256}.1`);
    const keepAlive = setTimeout(() => {}, 2000);
    let map;
    try {
        const fetchFn = makeFetch((url, init, idx) => {
            if (idx === 1) {
                const results = {};
                for (const ip of JSON.parse(init.body).ips) results[ip] = { country: 'C1' };
                return jsonResponse({ ok: true, results });
            }
            return hangingFetch(url, init); // 第 2 批挂起 → 被 AbortSignal 掐
        });
        map = await gi.geoipBatchLookup(ips, { base: 'https://cz.example/batch', fetchFn, timeoutMs: 250 });
    } finally {
        clearTimeout(keepAlive);
    }
    eq(map.size, 500, '超时批次跳过，已完成批次结果保留');
    eq(map.get('10.0.0.1'), { country: 'C1' });
});

await checkAsync('空输入/关闭/缺 fetch → 不发请求直接空 Map', async () => {
    const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: {} }));
    eq((await gi.geoipBatchLookup([], { base: 'https://cz.example/batch', fetchFn })).size, 0);
    eq((await gi.geoipBatchLookup(null, { base: 'https://cz.example/batch', fetchFn })).size, 0);
    eq((await gi.geoipBatchLookup(['1.2.3.4'], { base: 'off', fetchFn })).size, 0);
    eq((await gi.geoipBatchLookup(['1.2.3.4'], { base: 'disabled', fetchFn })).size, 0);
    eq((await gi.geoipBatchLookup(['1.2.3.4'], { base: '', fetchFn })).size, 0, '空 base 视为无效配置');
    eq((await gi.geoipBatchLookup(['1.2.3.4'], { base: 'https://cz.example/batch', fetchFn: null })).size, 0);
    eq(fetchFn.calls.length, 0, '以上用例均不应发请求');
});

// ---------------------------------------------------------------------------
// 5. createGeoipInjector
// ---------------------------------------------------------------------------
console.log('\n[5] createGeoipInjector');

check('shouldPrefetch：含 geoip 触发（大小写不敏感），否则 false', () => {
    const inj = gi.createGeoipInjector({});
    ok(inj.shouldPrefetch('function operator(proxies){ return geoip.lookup(proxies[0].server) }') === true);
    ok(inj.shouldPrefetch('GEOIP.lookup("1.2.3.4")') === true, '大写也应触发');
    ok(inj.shouldPrefetch("proxies[0].name.includes('香港')") === false);
    ok(inj.shouldPrefetch('') === false);
    ok(inj.shouldPrefetch(undefined) === false);
    ok(inj.shouldPrefetch(123) === false);
});

await checkAsync('未配置 env/base → 回退内置默认 BASE', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: { '1.2.3.4': { country: '中国' } } }));
        const inj = gi.createGeoipInjector({ fetchFn });
        eq(inj.isDisabled(), false);
        const map = await inj.prefetch([{ server: '1.2.3.4' }]);
        eq(fetchFn.calls[0].url, gi.GEOIP_DEFAULT_BASE, '应使用内置默认 BASE');
        eq(map.get('1.2.3.4'), { country: '中国' });
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('env.GEOIP_CZDB_BASE 覆盖 BASE；显式 base 优先于 env', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = { GEOIP_CZDB_BASE: 'https://env.example/batch' };
    try {
        const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: {} }));
        const inj = gi.createGeoipInjector({ fetchFn });
        await inj.prefetch([{ server: '1.2.3.4' }]);
        eq(fetchFn.calls[0].url, 'https://env.example/batch', 'env 应覆盖默认 BASE');

        const inj2 = gi.createGeoipInjector({ fetchFn, base: 'https://explicit.example/batch' });
        await inj2.prefetch([{ server: '1.2.3.4' }]);
        eq(fetchFn.calls[1].url, 'https://explicit.example/batch', '显式 base 应优先于 env');
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync("env='off' / 'disabled'（任意大小写）→ 功能关闭：不发请求、isDisabled、恒 null", async () => {
    const saved = globalThis.__workerEnv;
    try {
        for (const val of ['off', 'OFF', 'disabled', 'Disabled']) {
            globalThis.__workerEnv = { GEOIP_CZDB_BASE: val };
            const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: {} }));
            const inj = gi.createGeoipInjector({ fetchFn });
            eq(inj.isDisabled(), true, `env=${val} 应关闭`);
            eq(inj.shouldPrefetch('geoip.lookup("1.2.3.4")'), true, '文本触发条件不受关闭影响（仍会注入恒 null 的 lookup）');
            const map = await inj.prefetch([{ server: '1.2.3.4' }]);
            eq(map.size, 0, '关闭模式不预取');
            eq(fetchFn.calls.length, 0, '关闭模式不发请求');
            const api = inj.makeApi(map);
            eq(api.lookup('1.2.3.4'), null, '关闭模式 lookup 恒 null');
        }
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('prefetch 对 proxies 混合 server：只取 IP 字面量并去重', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const fetchFn = makeFetch(() =>
            jsonResponse({ ok: true, results: { '1.2.3.4': { country: '中国', province: '广东', city: '深圳', isp: '电信' } } }),
        );
        const inj = gi.createGeoipInjector({ fetchFn, base: 'https://cz.example/batch' });
        const map = await inj.prefetch([
            { server: '1.2.3.4' },
            { server: 'example.com' },
            { server: '1.2.3.4' },
            { server: '2001:db8::1' },
            { name: 'no-server' },
        ]);
        const sent = JSON.parse(fetchFn.calls[0].init.body).ips;
        eq(sent, ['1.2.3.4', '2001:db8::1'], '域名跳过 + 去重');
        eq(map.get('1.2.3.4'), { country: '中国', province: '广东', city: '深圳', isp: '电信' });
        ok(!map.has('2001:db8::1'), '端点未返回的 IP = 未知');
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('prefetch 失败 → 空 Map 不抛（容错路径）', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const inj = gi.createGeoipInjector({ base: 'https://cz.example/batch', fetchFn: async () => { throw new Error('boom'); } });
        const map = await inj.prefetch([{ server: '1.2.3.4' }]);
        eq(map.size, 0);
        eq(map.disabled, false, '失败(非关闭)模式 disabled 应为 false');
        eq(map.base, 'https://cz.example/batch');
        eq(inj.makeApi(map).lookup('1.2.3.4'), null);
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('prefetch 元信息：正常带 disabled=false/base；关闭带 disabled=true/base=null', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: { '1.2.3.4': { country: '中国' } } }));
        const inj = gi.createGeoipInjector({ fetchFn, base: 'https://cz.example/batch' });
        const r = await inj.prefetch([{ server: '1.2.3.4' }]);
        eq(r.disabled, false);
        eq(r.base, 'https://cz.example/batch');
        ok(typeof r.size === 'number', '返回仍是 Map 形态（.size 可用）');

        globalThis.__workerEnv = { GEOIP_CZDB_BASE: 'off' };
        const offInj = gi.createGeoipInjector({ fetchFn }); // env 关闭需无显式 base（显式 base 优先于 env）
        const off = await offInj.prefetch([{ server: '1.2.3.4' }]);
        eq(off.disabled, true);
        eq(off.base, null);
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('TTL 缓存：同 IP 集合 60s 内复用（只请求一次），不同集合各查，过期前重复集合命中', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: {} }));
        const inj = gi.createGeoipInjector({ fetchFn, base: 'https://cz.example/batch' });

        const pA = [{ server: '1.2.3.4' }, { server: 'example.com' }, { server: '1.2.3.4' }];
        const pA2 = [{ server: 'example.org' }, { server: '1.2.3.4' }]; // 同签名（1.2.3.4）
        await inj.prefetch(pA);
        const r2 = await inj.prefetch(pA2);
        eq(fetchFn.calls.length, 1, '同签名（排序后 IP 集合相同）应命中缓存');
        eq(r2.disabled, false, '缓存命中结果同样带元信息');

        await inj.prefetch([{ server: '5.6.7.8' }]);
        eq(fetchFn.calls.length, 2, '不同签名应重新请求');
        await inj.prefetch(pA);
        eq(fetchFn.calls.length, 2, '第一个签名未过期未挤出 → 仍命中');
    } finally {
        globalThis.__workerEnv = saved;
    }
});

await checkAsync('缓存上限 8：9 个签名后最旧被挤出，再查最旧签名需重新请求', async () => {
    const saved = globalThis.__workerEnv;
    globalThis.__workerEnv = undefined;
    try {
        const fetchFn = makeFetch(() => jsonResponse({ ok: true, results: {} }));
        const inj = gi.createGeoipInjector({ fetchFn, base: 'https://cz.example/batch' });

        for (let i = 1; i <= 9; i++) {
            await inj.prefetch([{ server: `10.0.0.${i}` }]);
        }
        eq(fetchFn.calls.length, 9);
        await inj.prefetch([{ server: '10.0.0.1' }]); // s1 已被挤出(只留 s2..s9) → 应重新请求
        eq(fetchFn.calls.length, 10, '超出上限后最旧签名应被驱逐');
        await inj.prefetch([{ server: '10.0.0.9' }]); // s9 仍在缓存 → 命中
        eq(fetchFn.calls.length, 10, '未被驱逐的签名应命中缓存');
    } finally {
        globalThis.__workerEnv = saved;
    }
});

check('makeApi.lookup：命中/未命中/非字符串/危险键', () => {
    const inj = gi.createGeoipInjector({});
    const map = new Map([['1.2.3.4', { country: '中国', province: '广东', city: '深圳', isp: '电信' }]]);
    const api = inj.makeApi(map);
    eq(api.lookup('1.2.3.4'), { country: '中国', province: '广东', city: '深圳', isp: '电信' });
    eq(api.lookup('9.9.9.9'), null, '未命中 → null');
    eq(api.lookup(123), null, '非字符串 → null');
    eq(api.lookup(null), null);
    eq(api.lookup('__proto__'), null);
    eq(inj.makeApi(new Map()).lookup('1.2.3.4'), null, '空 Map（关闭/失败模式）→ 恒 null');
});

// ---------------------------------------------------------------------------
// 6. injectAPI geoip 片段语义（模拟沙箱：同一 snippet 在纯 JS 里跑）
// ---------------------------------------------------------------------------
console.log('\n[6] injectAPI geoip 片段');

await checkAsync('geoip.lookup 片段：命中返回记录、未命中/非字符串返回 null', async () => {
    const snippet =
        'var geoip = {\n' +
        '  lookup: function(ip) {\n' +
        '    if (typeof ip !== "string") return null;\n' +
        '    if (!Object.prototype.hasOwnProperty.call(__geoipData, ip)) return null;\n' +
        '    var r = __geoipData[ip];\n' +
        '    return (r === undefined || r === null) ? null : r;\n' +
        '  }\n' +
        '};';
    // 用 new Function 模拟沙箱 evalCode：__geoipData 与注入时同为全局纯数据
    const make = new Function('__geoipData', snippet + '\n return geoip;');
    const geoip = make({ '1.2.3.4': { country: '中国', province: '广东', city: '深圳', isp: '电信' } });
    eq(geoip.lookup('1.2.3.4'), { country: '中国', province: '广东', city: '深圳', isp: '电信' });
    eq(geoip.lookup('8.8.8.8'), null);
    eq(geoip.lookup(42), null);
    eq(geoip.lookup(undefined), null);
    eq(geoip.lookup('__proto__'), null, '危险键不应沿原型链摸到 Object.prototype');
});

// ---------------------------------------------------------------------------
// 7. 源码接线检查
// ---------------------------------------------------------------------------
console.log('\n[7] 接线检查（quickjs-executor.js / geoip-czdb.js）');

check('quickjs-executor.js 接线：import/预取/日志(一次性)/数据注入/injectAPI 特例(fail-open)齐全', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/vendor/quickjs-executor.js'), 'utf8');
    ok(src.includes("from './geoip-czdb'"), '缺少 geoip-czdb import');
    ok(src.includes('getGeoipInjector()'), '缺少注入器获取');
    ok(src.includes('_geoipInjector.shouldPrefetch(script)'), '缺少 shouldPrefetch 触发判断');
    ok(src.includes('await _geoipInjector.prefetch(proxies)'), '缺少 prefetch 调用');
    ok(src.includes('api.__geoipData = geoipMapToRecord(_geoipMap)'), '缺少 JSON 安全数据注入');
    ok(src.includes("[geoip] 预取 '"), '缺少预取日志');
    ok(src.includes("[geoip] 功能已关闭"), '缺少关闭模式日志');
    ok(src.includes('__geoipLogShown'), '缺少日志一次性标志（高频路径防刷屏）');
    ok(src.includes("lookup: function(ip)"), 'injectAPI 缺少沙箱侧 lookup 组装');
    ok(src.includes("[geoip] 注入失败(已忽略)"), 'injectAPI 注入失败应 fail-open 只告警');
    ok(!src.includes("throw new Error('Failed to inject geoip"), 'injectAPI 注入失败不应 throw（会把可选增强变成脚本失败）');
    // 预取块应在 func 模式 try 之前（两条执行路径都拿到注入）
    const iPrefetch = src.indexOf('geoip 归属地预取注入');
    const iFuncMode = src.indexOf('========== func 模式 ==========');
    ok(iPrefetch > 0 && iFuncMode > iPrefetch, '预取应发生在 func 模式执行之前');
});

check('geoip-czdb.js 零依赖 + 预算/缓存常量（保证可被 node 直接单测）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/vendor/geoip-czdb.js'), 'utf8');
    ok(!/^\s*import\s/m.test(src), 'geoip-czdb.js 不应有 import 语句');
    ok(src.includes("export const GEOIP_DEFAULT_BASE = 'https://czdb-query.pages.dev/"), '缺少默认 BASE 常量');
    ok(src.includes('GEOIP_BATCH_SIZE = 500'), '缺少分批上限常量');
    ok(src.includes('GEOIP_IP_LIMIT = 2000'), '缺少提取上限常量');
    ok(src.includes('GEOIP_TIMEOUT_MS = 5000'), '缺少默认超时常量');
    ok(src.includes('GEOIP_CACHE_TTL_MS = 60000'), '缺少缓存 TTL 常量');
    ok(src.includes('GEOIP_CACHE_LIMIT = 8'), '缺少缓存上限常量');
    ok(src.includes('Promise.all('), '分批应并行发起（总预算约束）');
    ok(src.includes('seen = new Set()'), 'extractIps 应使用 Set 判重');
});

// ---------------------------------------------------------------------------
console.log(`\n结果: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
}
process.exit(failures.length > 0 ? 1 : 0);
