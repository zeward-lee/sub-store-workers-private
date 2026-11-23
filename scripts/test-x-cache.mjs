#!/usr/bin/env node
/**
 * [x-cache] 缓存层单测（无框架，node 直跑：node scripts/test-x-cache.mjs）
 *
 * 覆盖：
 *  - normalizeCacheUrl 易变参数剥离 + 参数排序 + 参数顺序无关性
 *  - validateCandidate 200 字节阈值边界
 *  - kvKey 前缀 + SHA-1 已知向量
 *  - 预热清单 upsert 上限/去重前置/写冷却
 *  - cron 路由判断 + /download 路径判断 + refresh/nocache bypass
 *  - readCachedDownload（Cache API 命中 / KV 命中 / 未命中）
 *  - storeDownload（合法写入 / 坏结果不缓存 / KV 写冷却 / 预热清单落库）
 *  - runPreheat（只判状态码不读响应体、单 URL 3 次、总预算 9 次、清单空跳过）
 *  - applyCacheLabel 标签前置（可写/不可变 headers、非法值、幂等）
 *  - 预热并轨（planCronRun / runScheduledTasks：单 cron = 探测 + legacy 同步）
 *  - 缓存索引 upsertCacheIndex（新键/去重置顶/队首跳写/超限截断+告警）
 *  - invalidateAllDownloads（正常清理+索引键删除/失败条目写回/分批并发/空索引清预热清单兜底/容错）
 *  - storeDownload bypassRead 语义（冷却窗口跳写 vs 强制覆盖）+ index.js 失效接线
 *  - cacheRequestKey 键哈希化（SHA-256/xcache.invalid/明文凭据不进键）+ 三处 Cache API 读写删贯穿
 *  - stale-on-error（KV 年龄分层 6h 新鲜窗口+未来时间戳防护 / readStaleFromKv 兜底+24h age 双保险
 *    +STALE 标签+ACAO+FakeKV TTL 过期模拟 / index.js 接线+早退补冲刷）
 *  - 源码接线检查（index.js 挂钩、wrangler.toml 单 cron）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 动态 import 走 file:// URL（Windows 下绝对路径不能直接 import）
const xc = await import(pathToFileURL(path.join(ROOT, 'src/vendor/x-cache.js')).href);

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

class FakeKV {
    constructor(init = {}) {
        this.map = new Map(Object.entries(init));
        this.puts = [];
        this.deletes = [];
        this.now = null; // 可选：模拟当前时间(ms)。非 null 时 get 按 expiresAt 判过期；null = 不做 TTL 过期判定
    }
    async get(key) {
        if (!this.map.has(key)) return null;
        const rec = this.map.get(key);
        if (rec && typeof rec === 'object' && '__expiresAt' in rec) {
            if (this.now !== null && this.now >= rec.__expiresAt) {
                this.map.delete(key);
                return null;
            }
            return rec.__value;
        }
        return rec;
    }
    async put(key, value, opts) {
        const rec =
            opts && Number.isFinite(opts.expirationTtl)
                ? { __value: value, __expiresAt: (this.now ?? Date.now()) + opts.expirationTtl * 1000 }
                : value;
        this.map.set(key, rec);
        this.puts.push({ key, value, opts });
    }
    async delete(key) {
        this.deletes.push(key);
        this.map.delete(key);
    }
    writesFor(key) {
        return this.puts.filter((p) => p.key === key);
    }
}

class FakeCache {
    constructor() {
        this.map = new Map();
        this.puts = [];
        this.deletes = [];
    }
    async match(req) {
        const url = typeof req === 'string' ? req : req.url;
        return this.map.has(url) ? this.map.get(url) : null;
    }
    async put(req, resp) {
        const url = typeof req === 'string' ? req : req.url;
        this.puts.push(url);
        this.map.set(url, resp);
    }
    async delete(req) {
        const url = typeof req === 'string' ? req : req.url;
        this.deletes.push(url);
        return this.map.delete(url);
    }
}

function fakeProbeResponse(status) {
    const state = { bodyRead: false, cancelled: 0 };
    const resp = {
        status,
        __state: state,
        async text() {
            state.bodyRead = true;
            return 'should-not-be-read';
        },
        async json() {
            state.bodyRead = true;
            return {};
        },
    };
    Object.defineProperty(resp, 'body', {
        get() {
            return {
                cancel: async () => {
                    state.cancelled += 1;
                },
            };
        },
    });
    return resp;
}

const BODY = 'proxies:\n' + '- {name: node-1, server: 1.2.3.4}\n'.repeat(10);
const DL_URL = 'https://ssub.feeee.cc.cd/download/airport-a?token=secret&target=mihomo';

// ---------------------------------------------------------------------------
// 1. normalizeCacheUrl
// ---------------------------------------------------------------------------
console.log('\n[1] normalizeCacheUrl');

check('剥离易变参数 refresh/t/nonce/_/timestamp/nocache', () => {
    eq(
        xc.normalizeCacheUrl('https://ssub.feeee.cc.cd/download/a?refresh=1&token=sec&t=123&nonce=n&_=9&timestamp=456&nocache=1'),
        'https://ssub.feeee.cc.cd/download/a?token=sec',
    );
});

check('剩余参数按名排序（b=2&a=1 → a=1&b=2）', () => {
    eq(xc.normalizeCacheUrl('https://h/download/a?b=2&a=1'), 'https://h/download/a?a=1&b=2');
});

check('参数顺序不同 → 缓存键相同', () => {
    eq(
        xc.normalizeCacheUrl('https://h/download/a?target=mihomo&token=x'),
        xc.normalizeCacheUrl('https://h/download/a?token=x&target=mihomo'),
    );
});

check('白名单之外的参数一律保留（不误删影响输出的参数）', () => {
    eq(
        xc.normalizeCacheUrl('https://h/download/a?keep=1&target=surge&flag=2'),
        'https://h/download/a?flag=2&keep=1&target=surge',
    );
});

check('保留 origin + pathname，丢弃 hash', () => {
    eq(xc.normalizeCacheUrl('https://h:8443/download/x/y#frag'), 'https://h:8443/download/x/y');
});

check('接受 URL 对象且不改原对象', () => {
    const u = new URL('https://h/download/a?z=1&a=2');
    eq(xc.normalizeCacheUrl(u), 'https://h/download/a?a=2&z=1');
    eq(u.search, '?z=1&a=2');
});

// ---------------------------------------------------------------------------
// 2. validateCandidate
// ---------------------------------------------------------------------------
console.log('\n[2] validateCandidate');

check('200 + 201 字节 → 允许缓存', () => ok(xc.validateCandidate(200, 201) === true));
check('200 + 200 字节（阈值边界，严格大于）→ 拒绝', () => ok(xc.validateCandidate(200, 200) === false));
check('200 + 199 字节 → 拒绝', () => ok(xc.validateCandidate(200, 199) === false));
check('201 + 巨大 body → 拒绝（只认 200）', () => ok(xc.validateCandidate(201, 100000) === false));
check('500 + 巨大 body → 拒绝', () => ok(xc.validateCandidate(500, 100000) === false));
check('NaN / undefined body → 拒绝', () => {
    ok(xc.validateCandidate(200, NaN) === false);
    ok(xc.validateCandidate(200, undefined) === false);
});

// ---------------------------------------------------------------------------
// 3. kvKey
// ---------------------------------------------------------------------------
console.log('\n[3] kvKey');

await checkAsync('前缀 xcache: + 40 位 hex', async () => {
    const key = await xc.kvKey('abc');
    ok(key.startsWith('xcache:'), '缺 xcache: 前缀');
    ok(/^xcache:[0-9a-f]{40}$/.test(key), `格式不符: ${key}`);
});

await checkAsync('SHA-1 已知向量（sha1("abc")）', async () => {
    eq(await xc.kvKey('abc'), 'xcache:a9993e364706816aba3e25717850c26c9cd0d89d');
});

await checkAsync('确定性 + 不同输入不同键', async () => {
    eq(await xc.kvKey('https://h/a'), await xc.kvKey('https://h/a'));
    ok((await xc.kvKey('https://h/a')) !== (await xc.kvKey('https://h/b')));
});

// ---------------------------------------------------------------------------
// 4. 路由/旁路判断
// ---------------------------------------------------------------------------
console.log('\n[4] isDownloadPath / shouldBypassCacheRead / isPreheatCron');

check('/download 前缀 + GET → true', () => {
    ok(xc.isDownloadPath('/download', 'GET') === true);
    ok(xc.isDownloadPath('/download/airport-a', 'GET') === true);
    ok(xc.isDownloadPath('/download/airport-a/mihomo', 'GET') === true);
});
check('非 /download 或非 GET → false', () => {
    ok(xc.isDownloadPath('/share/sub/airport-a', 'GET') === false);
    ok(xc.isDownloadPath('/api/sub/flow', 'GET') === false);
    ok(xc.isDownloadPath('/download/airport-a', 'POST') === false);
    ok(xc.isDownloadPath(undefined, 'GET') === false);
});
check('refresh / nocache → 跳过读缓存', () => {
    ok(xc.shouldBypassCacheRead('https://h/download/a?refresh=1') === true);
    ok(xc.shouldBypassCacheRead('https://h/download/a?nocache') === true);
    ok(xc.shouldBypassCacheRead('https://h/download/a?t=1') === false);
    ok(xc.shouldBypassCacheRead('https://h/download/a') === false);
});
check('cron 路由：仅两个新 cron 走预热', () => {
    ok(xc.isPreheatCron('40 18 * * *') === true);
    ok(xc.isPreheatCron('30 11 * * *') === true);
    ok(xc.isPreheatCron('55 15 * * *') === false);
    ok(xc.isPreheatCron(undefined) === false);
    ok(xc.isPreheatCron('40 18 * * *') === true, '带空格的写法应可用');
    eq(xc.PREHEAT_CRONS.length, 2);
});

// ---------------------------------------------------------------------------
// 5. readCachedDownload
// ---------------------------------------------------------------------------
console.log('\n[5] readCachedDownload');

await checkAsync('未命中（空 cache + 空 kv）→ null', async () => {
    const r = await xc.readCachedDownload({ cache: new FakeCache(), kv: new FakeKV(), request: new Request(DL_URL) });
    eq(r, null);
});

await checkAsync('Cache API 命中 → X-Cache: CACHE-HIT，内容与头保留，Cache-Control 为 public 60/300', async () => {
    const cache = new FakeCache();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    const keyReq = await xc.cacheRequestKey(canonical);
    cache.map.set(
        keyReq.url,
        new Response(BODY, {
            status: 200,
            headers: { 'Content-Type': 'text/yaml', 'Content-Disposition': 'attachment; filename="airport-a.yaml"' },
        }),
    );
    const r = await xc.readCachedDownload({ cache, kv: new FakeKV(), request: new Request(DL_URL) });
    ok(r !== null, '应命中');
    eq(r.headers.get('X-Cache'), 'CACHE-HIT');
    eq(r.headers.get('Content-Type'), 'text/yaml');
    eq(r.headers.get('Content-Disposition'), 'attachment; filename="airport-a.yaml"');
    eq(r.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
    eq(r.headers.get('CDN-Cache-Control'), 'public, max-age=300');
    eq(r.headers.get('Access-Control-Allow-Origin'), '*', 'CACHE-HIT 与 KV-HIT/STALE 的 CORS 行为应一致');
    eq(await r.text(), BODY);
});

await checkAsync('KV 命中 → X-Cache: KV-HIT，重建 body + 补 Content-Disposition', async () => {
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    const key = await xc.kvKey(canonical);
    await kv.put(
        key,
        JSON.stringify({
            body: BODY,
            contentType: 'text/yaml',
            contentDisposition: 'attachment; filename="airport-a.yaml"',
            storedAt: new Date().toISOString(),
        }),
        { expirationTtl: xc.KV_TTL_SECONDS },
    );
    const r = await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) });
    ok(r !== null, '应命中');
    eq(r.headers.get('X-Cache'), 'KV-HIT');
    eq(r.headers.get('Content-Disposition'), 'attachment; filename="airport-a.yaml"');
    eq(r.headers.get('Cache-Control'), 'public, max-age=60, s-maxage=300');
    eq(r.headers.get('Access-Control-Allow-Origin'), '*');
    eq(await r.text(), BODY);
});

await checkAsync('Cache API 优先于 KV', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    cache.map.set((await xc.cacheRequestKey(canonical)).url, new Response('from-cache', { status: 200 }));
    await kv.put(await xc.kvKey(canonical), JSON.stringify({ body: 'from-kv', storedAt: new Date().toISOString() }));
    const r = await xc.readCachedDownload({ cache, kv, request: new Request(DL_URL) });
    eq(r.headers.get('X-Cache'), 'CACHE-HIT');
    eq(await r.text(), 'from-cache');
});

await checkAsync('KV 命中时使用规范化后的键（refresh/t 等易变参数不影响键）', async () => {
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    await kv.put(await xc.kvKey(canonical), JSON.stringify({ body: BODY, storedAt: new Date().toISOString() }));
    const r = await xc.readCachedDownload({
        cache: null,
        kv,
        request: new Request(`${DL_URL}&t=999&_=888`),
    });
    eq(r?.headers.get('X-Cache'), 'KV-HIT');
});

await checkAsync('KV 值非法（非 JSON / 无 body）→ 不命中且不抛错', async () => {
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    await kv.put(await xc.kvKey(canonical), 'not-json{{{');
    eq(await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) }), null);
    const kv2 = new FakeKV();
    await kv2.put(await xc.kvKey(canonical), JSON.stringify({ contentType: 'text/yaml' }));
    eq(await xc.readCachedDownload({ cache: null, kv: kv2, request: new Request(DL_URL) }), null);
});

await checkAsync('cache 抛错 → 回落 KV，不抛错', async () => {
    const brokenCache = {
        match: async () => {
            throw new Error('cache down');
        },
        put: async () => {},
    };
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    await kv.put(await xc.kvKey(canonical), JSON.stringify({ body: BODY, storedAt: new Date().toISOString() }));
    const r = await xc.readCachedDownload({ cache: brokenCache, kv, request: new Request(DL_URL) });
    eq(r?.headers.get('X-Cache'), 'KV-HIT');
});

// ---------------------------------------------------------------------------
// 6. storeDownload
// ---------------------------------------------------------------------------
console.log('\n[6] storeDownload');

await checkAsync('合法响应 → 写 Cache API(哈希键) + KV(TTL 86400) + 预热清单', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const resp = new Response(BODY, {
        status: 200,
        headers: { 'Content-Type': 'text/yaml', 'Content-Disposition': 'attachment; filename="a.yaml"' },
    });
    const r = await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: resp });
    eq(r.stored, true);
    eq(r.cache, true);
    eq(r.kv, true);

    const canonical = xc.normalizeCacheUrl(DL_URL);
    const cacheKeyUrl = (await xc.cacheRequestKey(canonical)).url;
    eq(cache.puts, [cacheKeyUrl]);
    ok(cacheKeyUrl.startsWith('https://xcache.invalid/'), `Cache API 键应为哈希形态: ${cacheKeyUrl}`);
    ok(!cacheKeyUrl.includes('secret'), 'Cache API 键不应含明文 token');
    const cachedResp = cache.map.get(cacheKeyUrl);
    eq(cachedResp.headers.get('Cache-Control'), `public, max-age=60, s-maxage=${xc.CACHE_TTL_SECONDS}`);

    const key = await xc.kvKey(canonical);
    const kvWrites = kv.writesFor(key);
    eq(kvWrites.length, 1);
    eq(kvWrites[0].opts, { expirationTtl: xc.KV_TTL_SECONDS });
    const entry = JSON.parse(kvWrites[0].value);
    eq(entry.body, BODY);
    eq(entry.contentType, 'text/yaml');
    eq(entry.contentDisposition, 'attachment; filename="a.yaml"');
    ok(typeof entry.storedAt === 'string' && !Number.isNaN(Date.parse(entry.storedAt)), 'storedAt 应为可解析时间');

    const list = await xc.readPreheatList(kv);
    eq(list, [canonical]);
});

await checkAsync('200 但响应体 ≤200 字节 → 不缓存（坏结果不入缓存）', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const r = await xc.storeDownload({
        cache,
        kv,
        request: new Request(DL_URL),
        response: new Response('too short', { status: 200 }),
    });
    eq(r.stored, false);
    eq(r.reason, 'invalid-candidate');
    eq(cache.puts, []);
    eq(kv.puts, []);
});

await checkAsync('非 200（503/404）→ 不缓存', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    for (const status of [404, 503, 500]) {
        const r = await xc.storeDownload({
            cache,
            kv,
            request: new Request(DL_URL),
            response: new Response(BODY, { status }),
        });
        eq(r.stored, false, `status=${status}`);
    }
    eq(cache.puts, []);
    eq(kv.puts, []);
});

await checkAsync('KV 写冷却：10min 内重复写 → 跳过 KV 写，Cache API 仍刷新', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const now = Date.parse('2026-09-22T10:00:00.000Z');
    const mk = () => new Response(BODY, { status: 200, headers: { 'Content-Type': 'text/yaml' } });

    const first = await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mk(), now });
    eq(first.kv, true);
    const key = await xc.kvKey(xc.normalizeCacheUrl(DL_URL));
    eq(kv.writesFor(key).length, 1);

    const second = await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mk(), now: now + 9 * 60 * 1000 });
    eq(second.stored, true);
    eq(second.kv, false);
    eq(kv.writesFor(key).length, 1, '冷却窗口内不应重复写 KV');
    eq(second.cache, true);
    eq(cache.puts.length, 2, 'Cache API 每次都应刷新');
});

await checkAsync('KV 写冷却：超过 10min → 再次写 KV', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const now = Date.parse('2026-09-22T10:00:00.000Z');
    const mk = () => new Response(BODY, { status: 200, headers: { 'Content-Type': 'text/yaml' } });
    await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mk(), now });
    const third = await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mk(), now: now + 11 * 60 * 1000 });
    eq(third.kv, true);
    const key = await xc.kvKey(xc.normalizeCacheUrl(DL_URL));
    eq(kv.writesFor(key).length, 2);
});

await checkAsync('cache 抛错 → KV 仍写入，返回 stored=true', async () => {
    const brokenCache = {
        match: async () => null,
        put: async () => {
            throw new Error('cache put failed');
        },
    };
    const kv = new FakeKV();
    const r = await xc.storeDownload({
        cache: brokenCache,
        kv,
        request: new Request(DL_URL),
        response: new Response(BODY, { status: 200, headers: { 'Content-Type': 'text/yaml' } }),
    });
    eq(r.cache, false);
    eq(r.kv, true);
    eq(r.stored, true);
});

await checkAsync('无 response → stored=false 不抛错', async () => {
    eq((await xc.storeDownload({ cache: null, kv: new FakeKV(), request: new Request(DL_URL) })).stored, false);
});

// ---------------------------------------------------------------------------
// 7. 预热清单 upsert
// ---------------------------------------------------------------------------
console.log('\n[7] upsertPreheatList');

await checkAsync('新条目 unshift，超过 10 条 pop', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 12; i++) {
        await xc.upsertPreheatList(kv, `https://h/download/a${i}`);
    }
    const list = await xc.readPreheatList(kv);
    eq(list.length, 10);
    eq(list[0], 'https://h/download/a12');
    eq(list[9], 'https://h/download/a3');
});

await checkAsync('重复 URL 去重并前置（不产生副本）', async () => {
    const kv = new FakeKV();
    for (const u of ['https://h/download/a', 'https://h/download/b', 'https://h/download/a']) {
        await xc.upsertPreheatList(kv, u);
    }
    const list = await xc.readPreheatList(kv);
    eq(list, ['https://h/download/a', 'https://h/download/b']);
});

await checkAsync('已是队首 → 跳过 KV 写（省配额）', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    const before = kv.puts.length;
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    eq(kv.puts.length, before, '不应重复写');
});

await checkAsync('清单值非法 → 视为空清单', async () => {
    const kv = new FakeKV({ [xc.PREHEAT_LIST_KEY]: '{bad json' });
    eq(await xc.readPreheatList(kv), []);
    const kv2 = new FakeKV({ [xc.PREHEAT_LIST_KEY]: JSON.stringify({ a: 1 }) });
    eq(await xc.readPreheatList(kv2), []);
    const kv3 = new FakeKV({ [xc.PREHEAT_LIST_KEY]: JSON.stringify(['https://h/a', 42, '', null]) });
    eq(await xc.readPreheatList(kv3), ['https://h/a']);
});

await checkAsync('预热清单键名固定为 xcache:preheat-list', async () => {
    eq(xc.PREHEAT_LIST_KEY, 'xcache:preheat-list');
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    eq(kv.puts[0].key, 'xcache:preheat-list');
});

// ---------------------------------------------------------------------------
// 8. runPreheat
// ---------------------------------------------------------------------------
console.log('\n[8] runPreheat');

await checkAsync('清单为空 → 不发任何请求', async () => {
    let calls = 0;
    const r = await xc.runPreheat({
        kv: new FakeKV(),
        fetchFn: async () => {
            calls++;
            return fakeProbeResponse(200);
        },
    });
    eq(r, { probed: 0, ok: 0, failed: 0 });
    eq(calls, 0);
});

await checkAsync('探测只判状态码，绝不读响应体，且释放 body', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    const responses = [];
    const fetchFn = async (url, opts) => {
        ok(opts.method === 'GET', '应为 GET');
        ok(!!opts.signal, '应带超时 signal');
        const resp = fakeProbeResponse(200);
        responses.push(resp);
        return resp;
    };
    const r = await xc.runPreheat({ kv, fetchFn });
    eq(r, { probed: 1, ok: 1, failed: 0 });
    eq(responses.length, 1);
    ok(responses[0].__state.bodyRead === false, '不应读响应体（text/json 均未调用）');
    eq(responses[0].__state.cancelled, 1, '应 cancel() 释放 body');
});

await checkAsync('单 URL 失败最多重试 3 次', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    let calls = 0;
    const responses = [];
    const r = await xc.runPreheat({
        kv,
        fetchFn: async () => {
            calls++;
            const resp = fakeProbeResponse(503);
            responses.push(resp);
            return resp;
        },
    });
    eq(calls, xc.PREHEAT_ATTEMPTS_PER_URL);
    eq(r, { probed: 3, ok: 0, failed: 1 });
    ok(responses.every((x) => x.__state.bodyRead === false), '失败响应也不得读 body');
});

await checkAsync('首次失败后成功 → 立即停止重试', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    let calls = 0;
    const r = await xc.runPreheat({
        kv,
        fetchFn: async () => {
            calls++;
            return fakeProbeResponse(calls === 2 ? 200 : 500);
        },
    });
    eq(calls, 2);
    eq(r, { probed: 2, ok: 1, failed: 0 });
});

await checkAsync('fetch 抛错 → 计入失败但不中断', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    const r = await xc.runPreheat({
        kv,
        fetchFn: async () => {
            throw new Error('network down');
        },
    });
    eq(r, { probed: 3, ok: 0, failed: 1 });
});

await checkAsync('总预算 ≤9 次 subrequest（10 条 URL 全失败）', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 10; i++) await xc.upsertPreheatList(kv, `https://h/download/a${i}`);
    let calls = 0;
    const r = await xc.runPreheat({
        kv,
        fetchFn: async () => {
            calls++;
            return fakeProbeResponse(500);
        },
    });
    eq(calls, xc.PREHEAT_FETCH_BUDGET);
    ok(calls <= 9, `subrequest 数 ${calls} 应 ≤9`);
    eq(r.probed, 9);
    eq(r.failed, 3, '9 次预算 / 每 URL 3 次 → 3 条 URL 判定失败');
});

await checkAsync('稳定的清单 → 9 次预算内尽量多预热', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 10; i++) await xc.upsertPreheatList(kv, `https://h/download/a${i}`);
    let calls = 0;
    const r = await xc.runPreheat({
        kv,
        fetchFn: async () => {
            calls++;
            return fakeProbeResponse(200);
        },
    });
    eq(calls, 9);
    eq(r, { probed: 9, ok: 9, failed: 0 });
});

// ---------------------------------------------------------------------------
// 9. applyCacheLabel（标签前置，批次03）
// ---------------------------------------------------------------------------
console.log('\n[9] applyCacheLabel 标签前置');

check('可写 headers：直接 set X-Cache', () => {
    const resp = new Response('body', { status: 200 });
    const out = xc.applyCacheLabel(resp, xc.CACHE_LABEL.miss);
    eq(out.headers.get('X-Cache'), 'MISS');
});

check('非法/空标签 → 不写头，且不抛', () => {
    const resp = new Response('body', { status: 200 });
    xc.applyCacheLabel(resp, 'BYPASS');
    eq(resp.headers.get('X-Cache'), null);
    xc.applyCacheLabel(resp, '');
    eq(resp.headers.get('X-Cache'), null);
    xc.applyCacheLabel(undefined, 'MISS');
});

check('headers 不可变（immutable guard）→ 重建响应仍带标签', () => {
    const base = new Response('hello-body', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    // 用 Proxy 模拟 Workers 里 cache.match/fetch 返回的 immutable headers guard
    const immutable = new Proxy(base, {
        get(target, prop) {
            if (prop === 'headers') {
                return new Proxy(target.headers, {
                    get(h, p) {
                        if (p === 'set') {
                            return () => {
                                throw new TypeError("Can't modify immutable headers.");
                            };
                        }
                        const v = h[p];
                        return typeof v === 'function' ? v.bind(h) : v;
                    },
                });
            }
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
    let threw = false;
    try {
        immutable.headers.set('X-Cache', 'x');
    } catch {
        threw = true;
    }
    ok(threw, '测试替身未模拟出 immutable 行为');
    const out = xc.applyCacheLabel(immutable, xc.CACHE_LABEL.hit);
    eq(out.headers.get('X-Cache'), 'CACHE-HIT');
    eq(out.headers.get('Content-Type'), 'text/plain');
    eq(out.status, 200);
});

check('透传标签：CACHE-HIT 的命中响应打标幂等', () => {
    const resp = new Response('b', { status: 200, headers: { 'X-Cache': 'KV-HIT' } });
    eq(xc.applyCacheLabel(resp, resp.headers.get('X-Cache')).headers.get('X-Cache'), 'KV-HIT');
});

// ---------------------------------------------------------------------------
// 10. 预热并轨（planCronRun / runScheduledTasks，批次03）
// ---------------------------------------------------------------------------
console.log('\n[10] 预热并轨（单 cron 触发 = 探测 + legacy 都跑）');

check('planCronRun：legacy cron（含 undefined）→ 探测+同步；预热 cron → 仅探测', () => {
    eq(xc.planCronRun('55 15 * * *'), { preheat: true, sync: true });
    eq(xc.planCronRun(undefined), { preheat: true, sync: true });
    eq(xc.planCronRun('40 18 * * *'), { preheat: true, sync: false });
    eq(xc.planCronRun('30 11 * * *'), { preheat: true, sync: false });
});

await checkAsync('并轨执行：先探测、后 legacy 同步，各执行一次', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    const order = [];
    const r = await xc.runScheduledTasks({
        cron: '55 15 * * *',
        kv,
        fetchFn: async () => {
            order.push('preheat');
            return fakeProbeResponse(200);
        },
        runSync: async () => {
            order.push('sync');
        },
    });
    eq(order, ['preheat', 'sync']);
    eq(r.synced, true);
    eq(r.preheated.probed, 1);
});

await checkAsync('预热专用 cron：只探测，legacy 同步不执行', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    let syncCalls = 0;
    const r = await xc.runScheduledTasks({
        cron: '40 18 * * *',
        kv,
        fetchFn: async () => fakeProbeResponse(200),
        runSync: async () => {
            syncCalls++;
        },
    });
    eq(syncCalls, 0);
    eq(r.synced, false);
    eq(r.preheated.probed, 1);
});

await checkAsync('探测异常/清单为空 → 不阻断 legacy 同步', async () => {
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/a');
    const order = [];
    const r = await xc.runScheduledTasks({
        cron: '55 15 * * *',
        kv,
        fetchFn: async () => {
            throw new Error('network down');
        },
        runSync: async () => {
            order.push('sync');
        },
    });
    eq(order, ['sync']);
    eq(r.synced, true);

    const empty = await xc.runScheduledTasks({
        cron: '55 15 * * *',
        kv: new FakeKV(),
        fetchFn: async () => fakeProbeResponse(200),
        runSync: async () => {
            order.push('sync-empty');
        },
    });
    eq(order, ['sync', 'sync-empty']);
    eq(empty.preheated, { probed: 0, ok: 0, failed: 0 });
});

// ---------------------------------------------------------------------------
// 11. 源码接线检查
// ---------------------------------------------------------------------------
console.log('\n[11] 接线检查（index.js / wrangler.toml）');

check('index.js 引入 x-cache 并挂钩 fetch + scheduled（并轨编排）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    ok(src.includes("from '@/vendor/x-cache'"), '缺少 x-cache import');
    ok(src.includes('xCache.isDownloadPath('), '缺少 /download 路径判断');
    ok(src.includes('xCache.readCachedDownload('), '缺少缓存读路径');
    ok(src.includes('xCache.storeDownload('), '缺少缓存写路径');
    ok(src.includes('xCache.runScheduledTasks('), '缺少 cron 并轨编排');
    ok(src.includes('cronSyncArtifacts(env)'), '原有同步 cron 逻辑被破坏');
});

check('标签前置：applyCacheLabel 先于写缓存调度，且无后置 set X-Cache', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    ok(src.includes('xCache.applyCacheLabel('), '缺少标签前置调用');
    ok(src.includes('let cacheLabel'), '缺少读阶段定值变量 cacheLabel');
    ok(src.includes('cacheLabel = xCache.CACHE_LABEL.miss'), '读阶段未把未命中定值为 MISS');
    const iLabel = src.indexOf('xCache.applyCacheLabel(response, cacheLabel)');
    const iStore = src.indexOf('xCache.storeDownload(');
    ok(iLabel > 0, '未在响应生成后立刻打标');
    ok(iStore > iLabel, '标签应先于写缓存调度写入');
    ok(!src.includes("response.headers.set('X-Cache'"), '不应再有后置 X-Cache set');
    ok(/catch[\s\S]*applyCacheLabel\(/.test(src), '异常路径未补标签');
});

check('scheduled 内不改 cron 配置，legacy 同步作为 runSync 传入', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    const sched = src.slice(src.indexOf('async scheduled'), src.indexOf('async fetch'));
    ok(sched.includes('xCache.runScheduledTasks('), 'scheduled 未走并轨编排');
    ok(sched.includes('runSync: () => cronSyncArtifacts(env)'), 'legacy 同步未接进并轨编排');
    ok(!/crons\s*=/.test(sched), 'scheduled 内不应出现 cron 配置改写');
});

check('X-Cache 头取值走 CACHE_LABEL 枚举（x-cache.js）', () => {
    const x = fs.readFileSync(path.join(ROOT, 'src/vendor/x-cache.js'), 'utf8');
    ok(x.includes('export const CACHE_LABEL'), '缺少 CACHE_LABEL 枚举');
    for (const v of ['CACHE-HIT', 'KV-HIT', 'MISS']) ok(x.includes(v), `x-cache.js 缺 ${v}`);
});

check('wrangler.toml 回退为单条 cron（不占新增配额）', () => {
    const t = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
    const line = t.split(/\r?\n/).find((l) => l.trim().startsWith('crons'));
    ok(line, '缺少 crons 配置行');
    eq(JSON.parse(line.slice(line.indexOf('['))), ['55 15 * * *']);
});

check('预热专用 cron pattern 仍保留在 x-cache.js（未来释放配额即启用）', () => {
    const x = fs.readFileSync(path.join(ROOT, 'src/vendor/x-cache.js'), 'utf8');
    ok(x.includes("'40 18 * * *'") && x.includes("'30 11 * * *'"), '预热 cron pattern 丢失');
    eq(xc.PREHEAT_CRONS, ['40 18 * * *', '30 11 * * *']);
});

check('x-cache.js 无外部 import（保证可被 node 直接单测）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/vendor/x-cache.js'), 'utf8');
    ok(!/^\s*import\s/m.test(src), 'x-cache.js 不应有 import 语句');
});

// ---------------------------------------------------------------------------
// 12. 缓存索引 upsertCacheIndex（「保存即作废」依据）
// ---------------------------------------------------------------------------
console.log('\n[12] upsertCacheIndex');

await checkAsync('常量取值固定：键名 xcache:index / 上限 100 / TTL 604800 / 分批 8', async () => {
    eq(xc.CACHE_INDEX_KEY, 'xcache:index');
    eq(xc.CACHE_INDEX_LIMIT, 100);
    eq(xc.CACHE_INDEX_TTL_SECONDS, 604800);
    eq(xc.INVALIDATE_BATCH_SIZE, 8);
});

await checkAsync('新键写入：写 xcache:index + TTL 604800', async () => {
    const kv = new FakeKV();
    const next = await xc.upsertCacheIndex(kv, 'https://h/download/a');
    eq(next, ['https://h/download/a']);
    eq(kv.puts.length, 1);
    eq(kv.puts[0].key, xc.CACHE_INDEX_KEY);
    eq(kv.puts[0].opts, { expirationTtl: xc.CACHE_INDEX_TTL_SECONDS });
    eq(JSON.parse(kv.puts[0].value), ['https://h/download/a']);
});

await checkAsync('重复 URL 去重并置顶', async () => {
    const kv = new FakeKV();
    await xc.upsertCacheIndex(kv, 'https://h/download/a');
    await xc.upsertCacheIndex(kv, 'https://h/download/b');
    const next = await xc.upsertCacheIndex(kv, 'https://h/download/a');
    eq(next, ['https://h/download/a', 'https://h/download/b']);
});

await checkAsync('已是队首 → 跳写（kv.put 未被调，省配额）', async () => {
    const kv = new FakeKV();
    await xc.upsertCacheIndex(kv, 'https://h/download/a');
    const before = kv.puts.length;
    const r = await xc.upsertCacheIndex(kv, 'https://h/download/a');
    eq(kv.puts.length, before, '队首重复登记不应产生 KV 写');
    eq(r, ['https://h/download/a']);
});

await checkAsync('超限截断到 CACHE_INDEX_LIMIT(100)，最新在前', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 102; i++) await xc.upsertCacheIndex(kv, `https://h/download/u${i}`);
    const list = await xc.readCacheIndex(kv);
    eq(list.length, 100);
    eq(list[0], 'https://h/download/u102');
    eq(list[99], 'https://h/download/u3');
});

await checkAsync('索引达上限后再插入 → 截断且 console.warn 可见（漏清可观测）', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 100; i++) await xc.upsertCacheIndex(kv, `https://h/download/u${i}`);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.map(String).join(' '));
    try {
        await xc.upsertCacheIndex(kv, 'https://h/download/new');
    } finally {
        console.warn = origWarn;
    }
    const list = await xc.readCacheIndex(kv);
    eq(list.length, 100);
    eq(list[0], 'https://h/download/new');
    ok(warns.some((w) => w.includes('截断')), `应有截断告警，实际 warn=${JSON.stringify(warns)}`);
});

await checkAsync('去重替换未超上限 → 不告警', async () => {
    const kv = new FakeKV();
    for (let i = 1; i <= 100; i++) await xc.upsertCacheIndex(kv, `https://h/download/u${i}`);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.map(String).join(' '));
    try {
        await xc.upsertCacheIndex(kv, 'https://h/download/u50');
    } finally {
        console.warn = origWarn;
    }
    eq(warns, [], '去重未增长不应触发截断告警');
});

await checkAsync('kv 不可用 → 返回 [] 不抛', async () => {
    eq(await xc.upsertCacheIndex(null, 'https://h/download/a'), []);
    eq(await xc.upsertCacheIndex({}, 'https://h/download/a'), []);
});

// ---------------------------------------------------------------------------
// 13. invalidateAllDownloads（保存即作废）
// ---------------------------------------------------------------------------
console.log('\n[13] invalidateAllDownloads');

async function seedIndex(kv, urls) {
    for (const u of urls) await xc.upsertCacheIndex(kv, u);
}

await checkAsync('正常清理：逐条删 Cache API + KV，收尾删索引键（非写 \'[]\'）', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const urls = ['https://h/download/a?token=x', 'https://h/download/b'];
    await seedIndex(kv, urls);
    const putsAfterSeed = kv.puts.length;
    const r = await xc.invalidateAllDownloads({ cache, kv });
    eq(r, { cleared: 2, failed: 0 });

    const canon = urls.map((u) => xc.normalizeCacheUrl(u));
    const cacheKeyUrls = [];
    for (const c of canon) cacheKeyUrls.push((await xc.cacheRequestKey(c)).url);
    eq(cache.deletes.sort(), cacheKeyUrls.sort(), '每条 URL 的 Cache API（哈希键）都应被删除');

    const keys = [];
    for (const c of canon) keys.push(await xc.kvKey(c));
    eq(kv.deletes.sort(), [...keys, xc.CACHE_INDEX_KEY].sort(), '每条 URL 的 KV 键 + 收尾的索引键都应被删除');

    // P1 收尾：全成 → kv.delete 索引键（不用 put '[]' 覆盖并发登记），全程不应有任何索引写
    ok(kv.deletes.includes(xc.CACHE_INDEX_KEY), '收尾应删除索引键本身');
    eq(await kv.get(xc.CACHE_INDEX_KEY), null, '索引键应不存在（而非 \'[]\'）');
    eq(kv.puts.length, putsAfterSeed, '清理阶段不应有任何 kv.put（杜绝覆盖并发 upsert）');
});

await checkAsync('空清单幂等：不做任何删除，也不写 KV', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    eq(await xc.invalidateAllDownloads({ cache, kv }), { cleared: 0, failed: 0 });
    eq(await xc.invalidateAllDownloads({}), { cleared: 0, failed: 0 }, 'deps 全缺也不抛');
    eq(cache.deletes, []);
    eq(kv.deletes, []);
    eq(kv.puts, []);
});

await checkAsync('单条 cache.delete 抛错 → 继续清其余，失败条目写回索引待重试', async () => {
    const kv = new FakeKV();
    await seedIndex(kv, ['https://h/download/a', 'https://h/download/b']);
    const cache = new FakeCache();
    const failUrl = (await xc.cacheRequestKey('https://h/download/a')).url;
    const origDelete = cache.delete.bind(cache);
    cache.delete = async (req) => {
        if (req.url === failUrl) throw new Error('delete boom');
        return origDelete(req);
    };
    const r = await xc.invalidateAllDownloads({ cache, kv });
    eq(r, { cleared: 1, failed: 1 });
    ok(cache.deletes.includes((await xc.cacheRequestKey('https://h/download/b')).url), '其余条目仍应被清理（哈希键）');
    eq(kv.deletes.length, 2, '两条 URL 的 KV 删除与 Cache 删除互不影响，都应执行（失败路径收尾走 put，无索引键删除）');

    // P1 收尾：有失败 → 失败条目写回索引（带 TTL），留给下次保存即作废重试
    const idx = await xc.readCacheIndex(kv);
    eq(idx, ['https://h/download/a'], '失败的条目应留在索引，成功的应被移除');
    const lastPut = kv.puts[kv.puts.length - 1];
    eq(lastPut.key, xc.CACHE_INDEX_KEY);
    eq(lastPut.opts, { expirationTtl: xc.CACHE_INDEX_TTL_SECONDS });
    eq(JSON.parse(lastPut.value), ['https://h/download/a']);
});

await checkAsync('分批并发删（每批 ≤8、批间串行），全部清完且收尾删索引键', async () => {
    const kv = new FakeKV();
    const urls = [];
    for (let i = 1; i <= 20; i++) urls.push(`https://h/download/b${i}`);
    await seedIndex(kv, urls);
    const cache = new FakeCache();
    let inFlight = 0;
    let maxInFlight = 0;
    const origDelete = cache.delete.bind(cache);
    cache.delete = async (req) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            return await origDelete(req);
        } finally {
            inFlight--;
        }
    };
    const r = await xc.invalidateAllDownloads({ cache, kv });
    eq(r, { cleared: 20, failed: 0 }, '20 条应全部清理成功');
    eq(cache.deletes.length, 20);
    eq(maxInFlight, xc.INVALIDATE_BATCH_SIZE, '20 条 = 批 8/8/4，最大并发应恰为批大小 8');
    const keys = [];
    for (const u of urls) keys.push(await xc.kvKey(u));
    eq(kv.deletes.sort(), [...keys, xc.CACHE_INDEX_KEY].sort(), '每条 KV 键 + 收尾的索引键都应被删除');
    eq(await kv.get(xc.CACHE_INDEX_KEY), null);
});

await checkAsync('索引为空 → 兜底清预热清单里的 URL', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    await xc.upsertPreheatList(kv, 'https://h/download/p1');
    await xc.upsertPreheatList(kv, 'https://h/download/p2');
    const r = await xc.invalidateAllDownloads({ cache, kv });
    eq(r, { cleared: 2, failed: 0 });
    const pKeys = [
        (await xc.cacheRequestKey('https://h/download/p1')).url,
        (await xc.cacheRequestKey('https://h/download/p2')).url,
    ];
    eq(cache.deletes.sort(), pKeys.sort(), '预热清单 URL 应被兜底删除（哈希键）');
    const keys = [await xc.kvKey('https://h/download/p1'), await xc.kvKey('https://h/download/p2')];
    eq(kv.deletes.sort(), [...keys, xc.CACHE_INDEX_KEY].sort(), '预热清单 KV 键 + 收尾索引键都应被删除');
});

await checkAsync('读索引抛错（kv.get 异常）→ 整体容错返回不抛', async () => {
    const brokenKv = {
        get: async () => {
            throw new Error('kv down');
        },
        put: async () => {},
        delete: async () => {},
    };
    const r = await xc.invalidateAllDownloads({ cache: new FakeCache(), kv: brokenKv });
    eq(r, { cleared: 0, failed: 0 });
});

// ---------------------------------------------------------------------------
// 14. storeDownload bypassRead 语义 + 索引登记 + index.js 接线
// ---------------------------------------------------------------------------
console.log('\n[14] storeDownload bypassRead 语义');

const THROTTLED_NOW = Date.parse('2026-09-22T10:00:00.000Z');
const mkYamlResp = () => new Response(BODY, { status: 200, headers: { 'Content-Type': 'text/yaml' } });

await checkAsync('KV 写冷却窗口内 bypassRead=false → 仍跳写 KV（保持现状）', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const key = await xc.kvKey(xc.normalizeCacheUrl(DL_URL));
    await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mkYamlResp(), now: THROTTLED_NOW });
    const second = await xc.storeDownload({
        cache,
        kv,
        request: new Request(DL_URL),
        response: mkYamlResp(),
        now: THROTTLED_NOW + 9 * 60 * 1000,
        bypassRead: false,
    });
    eq(second.kv, false);
    eq(kv.writesFor(key).length, 1);
});

await checkAsync('KV 写冷却窗口内 bypassRead=true → 强制覆盖 KV，索引被 upsert', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    const key = await xc.kvKey(canonical);
    await xc.storeDownload({ cache, kv, request: new Request(DL_URL), response: mkYamlResp(), now: THROTTLED_NOW });
    const second = await xc.storeDownload({
        cache,
        kv,
        request: new Request(DL_URL),
        response: mkYamlResp(),
        now: THROTTLED_NOW + 9 * 60 * 1000,
        bypassRead: true,
    });
    eq(second.kv, true, 'bypass 应跳过写冷却强制覆盖');
    eq(kv.writesFor(key).length, 2);
    const idx = await xc.readCacheIndex(kv);
    eq(idx, [canonical], '强制覆盖时索引应被登记');
});

await checkAsync('坏结果不缓存 → 索引不登记', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    await xc.storeDownload({
        cache,
        kv,
        request: new Request(DL_URL),
        response: new Response('too short', { status: 200 }),
    });
    eq(await xc.readCacheIndex(kv), []);
    eq(kv.puts, []);
});

check('index.js 接线：配置写成功调度失效 + storeDownload 传 bypassRead + 结果打日志', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    ok(src.includes('xCache.invalidateAllDownloads('), '缺少失效清空调用');
    ok(src.includes("['GET', 'HEAD', 'OPTIONS'].includes(request.method)"), '缺少非 GET/HEAD/OPTIONS 判断');
    ok(/response\.status >= 200 &&[\s\S]{0,80}?response\.status < 300/.test(src), '缺少 2xx 判断');
    ok(src.includes('bypassRead: cacheBypass'), 'storeDownload 未传 bypassRead');
    ok(src.includes('cleared=${r?.cleared ?? 0} failed=${r?.failed ?? 0}'), '失效结果 {cleared,failed} 应打进日志');
    const iStore = src.indexOf('xCache.storeDownload(');
    const iInvalidate = src.indexOf('xCache.invalidateAllDownloads(');
    ok(iInvalidate > iStore, '失效触发应放在写缓存调度之后');
});

// ---------------------------------------------------------------------------
// 15. cacheRequestKey（Cache API 键哈希化）
// ---------------------------------------------------------------------------
console.log('\n[15] cacheRequestKey');

await checkAsync('返回 GET Request，url 形如 https://xcache.invalid/<64hex>', async () => {
    const req = await xc.cacheRequestKey('https://h/download/a?token=x');
    ok(req instanceof Request, '应返回 Request 实例');
    eq(req.method, 'GET');
    ok(/^https:\/\/xcache\.invalid\/[0-9a-f]{64}$/.test(req.url), `url 形态不符: ${req.url}`);
});

await checkAsync('SHA-256 已知向量（sha256("abc")）', async () => {
    const req = await xc.cacheRequestKey('abc');
    eq(req.url, 'https://xcache.invalid/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await checkAsync('同 URL 同键、不同 URL 不同键', async () => {
    const a1 = (await xc.cacheRequestKey('https://h/download/a?token=x')).url;
    const a2 = (await xc.cacheRequestKey('https://h/download/a?token=x')).url;
    const b = (await xc.cacheRequestKey('https://h/download/b?token=x')).url;
    eq(a1, a2, '同 URL 应产生同键');
    ok(a1 !== b, '不同 URL 应产生不同键');
});

await checkAsync('明文凭据不进键（token 值不出现在 url）', async () => {
    const req = await xc.cacheRequestKey(DL_URL);
    ok(!req.url.includes('secret'), '键中不得出现明文 token 值');
    ok(!req.url.includes('token='), '键中不得出现明文参数段');
});

// ---------------------------------------------------------------------------
// 16. 三处 Cache API 读写删全部走哈希键（明文 URL 不出现在 fake cache 收到的键里）
// ---------------------------------------------------------------------------
console.log('\n[16] Cache API 键哈希化贯穿');

await checkAsync('storeDownload 写入的是哈希键（不含明文 URL/token）', async () => {
    const cache = new FakeCache();
    const r = await xc.storeDownload({ cache, kv: new FakeKV(), request: new Request(DL_URL), response: mkYamlResp() });
    eq(r.cache, true);
    eq(cache.puts.length, 1);
    ok(/^https:\/\/xcache\.invalid\/[0-9a-f]{64}$/.test(cache.puts[0]), `应为哈希键: ${cache.puts[0]}`);
    ok(!cache.puts[0].includes('secret'), '键不得含明文 token');
    ok(!cache.puts[0].includes('download'), '键不得含明文 URL 片段');
});

await checkAsync('readCachedDownload 用哈希键匹配（明文 URL 键下无条目仍命中）', async () => {
    const cache = new FakeCache();
    const seen = [];
    const origMatch = cache.match.bind(cache);
    cache.match = async (req) => {
        seen.push(req.url);
        return origMatch(req);
    };
    const canonical = xc.normalizeCacheUrl(DL_URL);
    cache.map.set((await xc.cacheRequestKey(canonical)).url, new Response(BODY, { status: 200 }));
    const r = await xc.readCachedDownload({ cache, kv: new FakeKV(), request: new Request(DL_URL) });
    eq(r?.headers.get('X-Cache'), 'CACHE-HIT');
    eq(seen.length, 1);
    ok(/^https:\/\/xcache\.invalid\//.test(seen[0]), `match 应发哈希键: ${seen[0]}`);
    ok(!seen[0].includes('secret'), 'match 键不得含明文 token');
    ok(!cache.map.has(canonical), '明文 URL 键下不应有条目');
});

await checkAsync('invalidateAllDownloads 删除的是哈希键', async () => {
    const cache = new FakeCache();
    const kv = new FakeKV();
    await seedIndex(kv, ['https://h/download/a?token=x']);
    const r = await xc.invalidateAllDownloads({ cache, kv });
    eq(r, { cleared: 1, failed: 0 });
    eq(cache.deletes.length, 1);
    ok(/^https:\/\/xcache\.invalid\/[0-9a-f]{64}$/.test(cache.deletes[0]), `应为哈希键: ${cache.deletes[0]}`);
    ok(!cache.deletes[0].includes('secret'), '删除键不得含明文 token');
});

// ---------------------------------------------------------------------------
// 17. stale-on-error（KV 年龄分层 + readStaleFromKv 兜底）
// ---------------------------------------------------------------------------
console.log('\n[17] stale-on-error');

check('常量钉值：STALE 标签 / KV_TTL 86400 / 新鲜窗口 21600 / 预热清单 TTL 保持 21600', () => {
    eq(xc.CACHE_LABEL.stale, 'STALE');
    eq(xc.KV_TTL_SECONDS, 86400);
    eq(xc.KV_FRESH_WINDOW_SECONDS, 21600);
    eq(xc.PREHEAT_LIST_TTL_SECONDS, 21600);
});

check('applyCacheLabel 接受 STALE（CACHE_LABEL_VALUES 由 Object.values 生成，自动收录）', () => {
    const resp = new Response('b', { status: 200 });
    eq(xc.applyCacheLabel(resp, xc.CACHE_LABEL.stale).headers.get('X-Cache'), 'STALE');
});

async function seedStaleKv(ageMs, body = BODY) {
    const kv = new FakeKV();
    const canonical = xc.normalizeCacheUrl(DL_URL);
    await kv.put(
        await xc.kvKey(canonical),
        JSON.stringify({
            body,
            contentType: 'text/yaml',
            contentDisposition: 'attachment; filename="a.yaml"',
            storedAt: new Date(Date.now() - ageMs).toISOString(),
        }),
        { expirationTtl: xc.KV_TTL_SECONDS },
    );
    return kv;
}

const SIX_H_MS = xc.KV_FRESH_WINDOW_SECONDS * 1000;

await checkAsync('KV 条目 5h59m 龄 → readCachedDownload 正常命中 KV-HIT', async () => {
    const kv = await seedStaleKv(SIX_H_MS - 60 * 1000);
    const r = await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) });
    eq(r?.headers.get('X-Cache'), 'KV-HIT');
});

await checkAsync('KV 条目恰好 6h 龄（>= 阈值）→ 不作为正常命中', async () => {
    const kv = await seedStaleKv(SIX_H_MS);
    eq(await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) }), null);
});

await checkAsync('KV 条目 7h 龄 → readCachedDownload 不命中（走原路径重新拉取）', async () => {
    const kv = await seedStaleKv(7 * 3600 * 1000);
    eq(await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) }), null);
});

await checkAsync('上游 500 场景：readStaleFromKv 对 7h 龄条目命中，回吐 X-Cache: STALE + 200 + 头重建', async () => {
    const kv = await seedStaleKv(7 * 3600 * 1000);
    const r = await xc.readStaleFromKv({ kv, request: new Request(DL_URL) });
    ok(r !== null, '应命中 stale');
    eq(r.status, 200);
    eq(r.headers.get('X-Cache'), 'STALE');
    eq(r.headers.get('Content-Type'), 'text/yaml');
    eq(r.headers.get('Content-Disposition'), 'attachment; filename="a.yaml"');
    eq(r.headers.get('Cache-Control'), 'no-store, no-cache, must-revalidate');
    eq(r.headers.get('CDN-Cache-Control'), 'no-store');
    eq(r.headers.get('Access-Control-Allow-Origin'), '*', 'STALE 替换失败响应后不应丢 CORS 头');
    eq(await r.text(), BODY);
});

await checkAsync('refresh(bypass) 失败场景同样命中：readStaleFromKv 不区分 bypass 参数', async () => {
    const kv = await seedStaleKv(7 * 3600 * 1000);
    const r = await xc.readStaleFromKv({ kv, request: new Request(`${DL_URL}&refresh=1`) });
    eq(r?.headers.get('X-Cache'), 'STALE');
});

await checkAsync('KV 无条目 / body 非字符串 / kv 不可用 / kv.get 抛错 / URL 非法 → 一律 null 不抛', async () => {
    eq(await xc.readStaleFromKv({ kv: new FakeKV(), request: new Request(DL_URL) }), null);
    const bad = new FakeKV();
    await bad.put(await xc.kvKey(xc.normalizeCacheUrl(DL_URL)), JSON.stringify({ contentType: 'text/yaml' }));
    eq(await xc.readStaleFromKv({ kv: bad, request: new Request(DL_URL) }), null);
    eq(await xc.readStaleFromKv({ kv: null, request: new Request(DL_URL) }), null);
    eq(await xc.readStaleFromKv({ kv: {}, request: new Request(DL_URL) }), null);
    const broken = {
        get: async () => {
            throw new Error('kv down');
        },
    };
    eq(await xc.readStaleFromKv({ kv: broken, request: new Request(DL_URL) }), null);
    eq(await xc.readStaleFromKv({ kv: new FakeKV(), request: { url: 'not-a-url' } }), null);
});

await checkAsync('KV 条目 storedAt 在未来 → readCachedDownload 不命中（未来时间戳防护，对齐 isFreshEntry）', async () => {
    const kv = await seedStaleKv(-5 * 60 * 1000); // 未来 5 分钟
    eq(await xc.readCachedDownload({ cache: null, kv, request: new Request(DL_URL) }), null);
});

await checkAsync('23h59m 龄 STALE 命中，且命中日志可见 age 小时数', async () => {
    const kv = await seedStaleKv(23 * 3600 * 1000 + 59 * 60 * 1000);
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.map(String).join(' '));
    let r;
    try {
        r = await xc.readStaleFromKv({ kv, request: new Request(DL_URL) });
    } finally {
        console.log = origLog;
    }
    eq(r?.headers.get('X-Cache'), 'STALE');
    ok(logs.some((l) => l.includes('age=') && l.includes('h)')), `STALE 命中日志应含 age 小时数: ${JSON.stringify(logs)}`);
});

await checkAsync('双保险：KV 未过期但 storedAt 超过 KV_TTL(24h) → readStaleFromKv 返回 null', async () => {
    const kv = await seedStaleKv(25 * 3600 * 1000);
    eq(await xc.readStaleFromKv({ kv, request: new Request(DL_URL) }), null);
});

await checkAsync('双保险：storedAt 在未来（时钟偏移）→ readStaleFromKv 返回 null', async () => {
    const kv = await seedStaleKv(-60 * 1000);
    eq(await xc.readStaleFromKv({ kv, request: new Request(DL_URL) }), null);
});

await checkAsync('FakeKV TTL 过期模拟：到期后 get 返回 null，readStaleFromKv 同步为 null', async () => {
    const kv = new FakeKV();
    kv.now = Date.now();
    const key = await xc.kvKey(xc.normalizeCacheUrl(DL_URL));
    await kv.put(key, JSON.stringify({ body: BODY, storedAt: new Date(kv.now).toISOString() }), { expirationTtl: 3600 });
    ok((await kv.get(key)) !== null, '未过期应可读');
    kv.now += 3601 * 1000;
    eq(await kv.get(key), null, '到期后 get 应返回 null（模拟 KV TTL 过期）');
    eq(await xc.readStaleFromKv({ kv, request: new Request(DL_URL) }), null);
});

await checkAsync('STALE 命中路径不回写缓存、不延长 TTL', async () => {
    const kv = await seedStaleKv(7 * 3600 * 1000);
    const key = await xc.kvKey(xc.normalizeCacheUrl(DL_URL));
    const putsBefore = kv.puts.length;
    const r = await xc.readStaleFromKv({ kv, request: new Request(DL_URL) });
    ok(r !== null, '应命中');
    eq(kv.puts.length, putsBefore, 'STALE 命中不应产生任何 KV 写');
    kv.now = Date.now();
    kv.now += (xc.KV_TTL_SECONDS - 1) * 1000;
    ok((await kv.get(key)) !== null, '原 TTL 窗口内仍应可读');
    kv.now += 2 * 1000;
    eq(await kv.get(key), null, 'TTL 未被延长：按原到期时间正常过期');
});

// ---------------------------------------------------------------------------
// 18. index.js stale-on-error 接线检查
// ---------------------------------------------------------------------------
console.log('\n[18] index.js stale 接线');

check('index.js stale 接线（存在性检查）：status>=400 / 回吐日志 / try/catch / 早退补冲刷', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    ok(src.includes('xCache.readStaleFromKv('), '缺少 stale 兜底调用');
    ok(src.includes('response.status >= 400'), '缺少 status>=400 触发条件');
    ok(src.includes('回吐 STALE 缓存'), '缺少 stale 回吐日志');
    const iStale = src.indexOf('xCache.readStaleFromKv(');
    const iStore = src.indexOf('xCache.storeDownload(');
    ok(iStale > 0 && iStore > iStale, 'stale 兜底应存在且在写缓存调度之前（失败响应不进写入流程）');
    const block = src.slice(iStale, iStore);
    ok(block.includes('} catch'), 'stale 兜底应整体 try/catch（异常回落原失败响应）');
    ok(
        block.includes('$.persistCache(') && block.includes('$.pendingPushes = []'),
        'STALE 早退前应补例行冲刷（不丢 KV 回写与 pendingPushes）',
    );
});

check('x-cache.js 含 STALE 标签 / readStaleFromKv / cacheRequestKey', () => {
    const x = fs.readFileSync(path.join(ROOT, 'src/vendor/x-cache.js'), 'utf8');
    ok(x.includes("stale: 'STALE'"), 'CACHE_LABEL 缺 stale');
    ok(x.includes('readStaleFromKv'), '缺 readStaleFromKv');
    ok(x.includes('cacheRequestKey'), '缺 cacheRequestKey');
    ok(x.includes('KV_FRESH_WINDOW_SECONDS'), '缺新鲜窗口常量');
});

// ---------------------------------------------------------------------------
// 19. 认证绕过 / 只读产物请求 / R2 外置接线
// ---------------------------------------------------------------------------
console.log('\n[19] Authorization 绕过 + 只读请求 + R2 外置接线');

check('hasAuthorizationHeader：有头 true，无头/异常 false', () => {
    eq(xc.hasAuthorizationHeader(new Request(DL_URL, { headers: { Authorization: 'Bearer x' } })), true);
    eq(xc.hasAuthorizationHeader(new Request(DL_URL)), false);
    eq(xc.hasAuthorizationHeader(null), false);
    eq(xc.hasAuthorizationHeader({}), false);
});

check('index.js：Authorization 绕过缓存 + 只读请求标记 + 产物 public 头', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
    ok(src.includes('xCache.hasAuthorizationHeader(request)'), '缺少 Authorization 绕过判断');
    ok(src.includes('$.readOnlyRequest = isDownloadRequest'), '缺少只读请求标记');
    ok(
        src.includes('persistCache({ readOnly: isDownloadRequest })'),
        'persistCache 未按请求传入 readOnly（并发安全）',
    );
    ok(
        src.includes("response.headers.set('Cache-Control', 'public, max-age=60, s-maxage=300')"),
        '产物 200 响应缺少 public 缓存头',
    );
    ok(src.includes("pathname.startsWith('/artifact/')"), '缺少 /artifact/ 直读路由');
    ok(src.includes('putArtifactToR2('), '缺少 R2 写入');
    ok(src.includes('SUBSTORE_R2'), '缺少 R2 binding 引用');
    ok(src.includes('artifact.url = r2Info.url'), '产物 URL 未回写 R2 路由');
});

check('open-api.js：模块级 KV 解析复用 + 只读请求不回写', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/vendor/open-api.js'), 'utf8');
    ok(src.includes('KV_MEMO_TTL_MS'), '缺少 memo TTL');
    ok(src.includes('kvMemo.kv === kvBinding'), '缺少 memo 命中判断');
    ok(src.includes('this.readOnlyRequest = false'), '构造函数缺少 readOnlyRequest 初始化');
    ok(src.includes('async persistCache({ readOnly = false } = {})'), 'persistCache 缺少 readOnly 参数');
});

// ---------------------------------------------------------------------------
console.log(`\n结果: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error?.message ?? f.error}`);
}
process.exit(failures.length > 0 ? 1 : 0);