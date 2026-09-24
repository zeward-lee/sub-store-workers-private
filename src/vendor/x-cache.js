/**
 * [x-cache] /download 下载缓存层（Workers 覆盖层新增文件，与上游零冲突）
 *
 * 职责：
 *  1. 缓存键规范化 normalizeCacheUrl —— 剥离易变 query 参数，防缓存碎片化
 *  2. 缓存候选校验 validateCandidate —— 只缓存 200 且体量达标的响应（坏结果不入缓存）
 *  3. Cache API（主缓存，TTL 30min，键哈希化 cacheRequestKey）+ KV（兜底，TTL 24h：
 *     0-6h 新鲜窗口正常命中 / 6-24h 仅作 stale 兜底池）双写、KV 写前查重控配额
 *  4. 自学习预热清单（KV 键 xcache:preheat-list，上限 10 条）与 cron 预热探测
 *  5. X-Cache 标签前置 applyCacheLabel —— 读阶段结束即定值，后续异常不吞观测头
 *  6. 「保存即作废」失效机制：配置写操作成功后按缓存索引（xcache:index）清空全部下载缓存
 *     （索引为空时兜底清预热清单；有删除失败的条目写回索引待下次重试）
 *  7. stale-on-error 兜底 readStaleFromKv —— 上游失败(status>=400)时回吐 KV 旧内容（X-Cache: STALE）
 *
 * 设计约束（brief 已定）：
 *  - 本模块不 import 任何其它模块（保持可被 node 直接单测；也不引入循环依赖）
 *  - Cache API / KV / fetch 一律通过参数注入，便于单测传 fake 实现
 *  - 所有对外函数内部自带 try/catch（除纯函数），缓存层异常绝不影响原响应路径
 *  - KV 键一律 xcache: 前缀，绝不碰 open-api.js 的键空间
 */

/** Cache API 主缓存 TTL（秒） */
export const CACHE_TTL_SECONDS = 1800;
/**
 * KV 兜底缓存 TTL（秒，24h）。
 * 0-6h 为正常新鲜窗口（readCachedDownload 正常命中）；6-24h 仅作 stale 兜底池
 * （上游失败时由 readStaleFromKv 回吐旧内容，正常读取不再命中），到点由 KV 自动过期。
 */
export const KV_TTL_SECONDS = 86400;
/** KV 正常新鲜窗口（秒，6h）：超过此龄的 KV 条目不再作为正常命中，只留给 stale 兜底 */
export const KV_FRESH_WINDOW_SECONDS = 21600;
/** KV 写冷却窗口：已存在且 storedAt 距今 < 10min 则跳过写入（控写配额） */
export const KV_WRITE_THROTTLE_MS = 10 * 60 * 1000;
/** 允许缓存的最小响应体字节数（严格大于） */
export const MIN_BODY_BYTES = 200;
/** 推送探测的总 subrequest 预算 */
export const PREHEAT_FETCH_BUDGET = 9;
/** 单个 URL 的最大探测次数 */
export const PREHEAT_ATTEMPTS_PER_URL = 3;
/** 单次探测超时（毫秒） */
export const PREHEAT_TIMEOUT_MS = 30000;
/** 预热清单上限 */
export const PREHEAT_LIST_LIMIT = 10;
/** 预热清单 KV 键 */
export const PREHEAT_LIST_KEY = 'xcache:preheat-list';
/** 预热清单 TTL（秒，6h）：沿用原 KV_TTL 6h 语义（清单应随热度短衰减），不随下载缓存池 TTL(24h) 变化 */
export const PREHEAT_LIST_TTL_SECONDS = 21600;
/** 缓存索引 KV 键（记录已缓存的 /download 规范化 URL，供「保存即作废」批量清空） */
export const CACHE_INDEX_KEY = 'xcache:index';
/** 缓存索引上限 */
export const CACHE_INDEX_LIMIT = 100;
/** 缓存索引 TTL（秒，7 天；清空后重写仍带此 TTL） */
export const CACHE_INDEX_TTL_SECONDS = 604800;
/** 失效清理的分批并发大小（控制 waitUntil 墙钟，批间串行） */
export const INVALIDATE_BATCH_SIZE = 8;
/** 新增的两个预热 cron（其余 cron 走原有同步逻辑，行为不变） */
export const PREHEAT_CRONS = ['40 18 * * *', '30 11 * * *'];
/** 易变 query 参数 denylist（不搞白名单，怕误删影响输出的参数） */
export const VOLATILE_PARAMS = ['refresh', 'nocache', 't', 'timestamp', 'nonce', '_'];
/** 探测请求 UA（非密钥，便于线上辨识） */
const PREHEAT_UA = 'sub-store-workers-xcache-preheat/1.0';

/** X-Cache 观测头取值（对齐 requirements 枚举） */
export const CACHE_LABEL = {
    /** Cache API 命中 */
    hit: 'CACHE-HIT',
    /** KV 兜底命中 */
    kvHit: 'KV-HIT',
    /** 未命中（含 refresh/nocache bypass） */
    miss: 'MISS',
    /** stale-on-error 兜底命中（上游失败时回吐的 KV 旧内容） */
    stale: 'STALE',
};

/** 标签合法性：只允许枚举内的值（防止内部误传导致观测头污染） */
const CACHE_LABEL_VALUES = Object.values(CACHE_LABEL);

/** 缓存层返回给客户端的头（与原路径 :189-190 保持一致，避免行为漂移） */
const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
};

/** 解析 crypto.subtle（Workers 与 node>=19 均存在 globalThis.crypto） */
function getSubtle() {
    return globalThis.crypto?.subtle ?? null;
}

/**
 * 规范化缓存键 URL：保留 origin + pathname + search，剥离易变参数，剩余参数按名排序重组。
 * @param {string|URL} input 原始 URL
 * @returns {string} 规范化后的绝对 URL
 */
export function normalizeCacheUrl(input) {
    const url = input instanceof URL ? new URL(input.toString()) : new URL(String(input));
    const params = [];
    url.searchParams.forEach((value, name) => {
        if (!VOLATILE_PARAMS.includes(String(name).toLowerCase())) {
            params.push([name, value]);
        }
    });
    // 参数名优先、同名再按值排序，保证同一订阅的不同参数顺序生成同一缓存键
    params.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
        if (a[1] === b[1]) return 0;
        return a[1] < b[1] ? -1 : 1;
    });
    url.search = '';
    url.hash = '';
    for (const [name, value] of params) {
        url.searchParams.append(name, value);
    }
    return url.toString();
}

/**
 * 缓存键：`xcache:` + SHA-1 hex（小写）。
 * @param {string} canonicalUrl normalizeCacheUrl 的产物
 * @returns {Promise<string>}
 */
export async function kvKey(canonicalUrl) {
    const subtle = getSubtle();
    if (!subtle) throw new Error('crypto.subtle unavailable');
    const digest = await subtle.digest('SHA-1', new TextEncoder().encode(String(canonicalUrl)));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `xcache:${hex}`;
}

/**
 * Cache API 缓存键：`https://xcache.invalid/` + SHA-256 hex（小写）的 GET Request。
 * 动机：canonicalUrl 含 ?token= 等明文凭据，直接作 Cache API 键会把明文写进缓存键；
 * 哈希后明文凭据不离开进程。.invalid 是保留 TLD，该 Request 永远不会被真实发出。
 * 兼容性：键形态变化使旧 Cache API 条目自然孤儿（30min TTL 自动淘汰），无需迁移；
 * 索引（xcache:index）仍存 canonicalUrl，失效时按其重算哈希删除，逻辑闭环。
 * @param {string} canonicalUrl normalizeCacheUrl 的产物
 * @returns {Promise<Request>}
 */
export async function cacheRequestKey(canonicalUrl) {
    const subtle = getSubtle();
    if (!subtle) throw new Error('crypto.subtle unavailable');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(canonicalUrl)));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return new Request(`https://xcache.invalid/${hex}`, { method: 'GET' });
}

/**
 * 缓存候选校验：仅 status===200 且响应体字节数 > 200 才允许缓存。
 * @param {number} status HTTP 状态码
 * @param {number} bodyByteLength 响应体字节数
 * @returns {boolean}
 */
export function validateCandidate(status, bodyByteLength) {
    const size = Number(bodyByteLength);
    return Number(status) === 200 && Number.isFinite(size) && size > MIN_BODY_BYTES;
}

/**
 * 是否属于需要走缓存流程的请求：GET 且 pathname 以 /download 开头。
 * @param {string} pathname 已剥离密码前缀的 pathname
 * @param {string} method
 * @returns {boolean}
 */
export function isDownloadPath(pathname, method) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return false;
    return typeof pathname === 'string' && pathname.startsWith('/download');
}

/**
 * 请求是否要求跳过读缓存（refresh / nocache；响应后仍写缓存）。
 * @param {string|URL} input
 * @returns {boolean}
 */
export function shouldBypassCacheRead(input) {
    try {
        const url = input instanceof URL ? input : new URL(String(input));
        return url.searchParams.has('refresh') || url.searchParams.has('nocache');
    } catch {
        return false;
    }
}

/**
 * cron 是否属于预热定时任务。
 * @param {string} cron
 * @returns {boolean}
 */
export function isPreheatCron(cron) {
    return PREHEAT_CRONS.includes(String(cron ?? '').trim());
}

/**
 * cron 任务编排计划（预热并轨，批次03）：
 * 预热对**所有** cron 都跑；仅当 cron 属于预热专用 pattern 时才跳过原有同步任务。
 * @param {string} cron
 * @returns {{preheat: boolean, sync: boolean}}
 */
export function planCronRun(cron) {
    return { preheat: true, sync: !isPreheatCron(cron) };
}

/** 取 Workers 默认缓存实例（测试环境可为 undefined，函数内已做存在性判断） */
export function defaultCache() {
    try {
        return globalThis.caches?.default ?? null;
    } catch {
        return null;
    }
}

/** KV entry 是否仍在写冷却窗口内 */
function isFreshEntry(entry, now) {
    if (!entry || typeof entry !== 'object') return false;
    const storedAt = Date.parse(entry.storedAt);
    if (!Number.isFinite(storedAt)) return false;
    return now - storedAt >= 0 && now - storedAt < KV_WRITE_THROTTLE_MS;
}

/** 读 KV 中的预热清单（容错：非法结构一律视为空清单） */
export async function readPreheatList(kv) {
    if (!kv || typeof kv.get !== 'function') return [];
    try {
        const raw = await kv.get(PREHEAT_LIST_KEY);
        if (raw === null || raw === undefined || raw === '') return [];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => typeof item === 'string' && item.length > 0).slice(0, PREHEAT_LIST_LIMIT);
    } catch (e) {
        console.error(`[x-cache] 预热清单读取失败: ${e?.message ?? e}`);
        return [];
    }
}

/** 读 KV 中的缓存索引（容错：非法结构一律视为空清单） */
export async function readCacheIndex(kv) {
    if (!kv || typeof kv.get !== 'function') return [];
    try {
        const raw = await kv.get(CACHE_INDEX_KEY);
        if (raw === null || raw === undefined || raw === '') return [];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => typeof item === 'string' && item.length > 0).slice(0, CACHE_INDEX_LIMIT);
    } catch (e) {
        console.error(`[x-cache] 缓存索引读取失败: ${e?.message ?? e}`);
        return [];
    }
}

/**
 * 预热清单 upsert：新条目 unshift，超限 pop，已是最新则跳过写（省一次 KV 写）。
 * @returns {Promise<string[]>} 更新后的清单
 */
export async function upsertPreheatList(kv, canonicalUrl, { now = Date.now() } = {}) {
    try {
        if (!kv || typeof kv.put !== 'function') return [];
        const list = await readPreheatList(kv);
        if (list[0] === canonicalUrl) return list;
        const next = [canonicalUrl, ...list.filter((item) => item !== canonicalUrl)].slice(0, PREHEAT_LIST_LIMIT);
        await kv.put(PREHEAT_LIST_KEY, JSON.stringify(next), { expirationTtl: PREHEAT_LIST_TTL_SECONDS });
        return next;
    } catch (e) {
        console.error(`[x-cache] 预热清单写入失败: ${e?.message ?? e}`);
        return [];
    }
}

/**
 * 缓存索引 upsert（「保存即作废」的失效依据）：记录已写入缓存的规范化 URL。
 * 结构仿 upsertPreheatList：已是队首则跳写（省一次 KV 写），否则 unshift 去重并截断到上限。
 * @param {any} kv KV 绑定（缺 put 视为不可用）
 * @param {string} canonicalUrl normalizeCacheUrl 的产物
 * @param {{now?: number}} opts 预留（与 upsertPreheatList 签名对齐）
 * @returns {Promise<string[]>} 更新后的索引（失败返回 []，绝不抛）
 */
export async function upsertCacheIndex(kv, canonicalUrl, { now = Date.now() } = {}) {
    try {
        if (!kv || typeof kv.put !== 'function') return [];
        const list = await readCacheIndex(kv);
        if (list[0] === canonicalUrl) return list;
        const deduped = [canonicalUrl, ...list.filter((item) => item !== canonicalUrl)];
        if (deduped.length > CACHE_INDEX_LIMIT) {
            // 让漏清可见：被挤出索引的条目将无法被「保存即作废」清到，只能等 TTL 兜底过期
            console.warn(`[x-cache] 缓存索引达到上限(${CACHE_INDEX_LIMIT})被截断，被挤出的条目将无法被保存即作废清到`);
        }
        const next = deduped.slice(0, CACHE_INDEX_LIMIT);
        await kv.put(CACHE_INDEX_KEY, JSON.stringify(next), { expirationTtl: CACHE_INDEX_TTL_SECONDS });
        return next;
    } catch (e) {
        console.error(`[x-cache] 缓存索引写入失败: ${e?.message ?? e}`);
        return [];
    }
}

/**
 * 给响应打 X-Cache 标签（标签前置）。
 *
 * 设计动机（批次03）：标签必须在「读阶段结束的第一时间」定值并落到响应对象上，
 * 后续任何写缓存/回写 KV 的异常都不再可能吞掉观测头。
 * - headers 可写：直接 set
 * - headers 不可变（cache.match / fetch 返回的 Response guard=immutable）：复制头部重建响应
 * - 重建也失败：原样返回（缓存层绝不因打标签而破坏原响应路径）
 *
 * @param {Response} response
 * @param {string} label CACHE_LABEL 之一；非法/空值则原样返回
 * @returns {Response}
 */
export function applyCacheLabel(response, label) {
    if (!response || typeof response.headers?.set !== 'function') return response;
    if (!CACHE_LABEL_VALUES.includes(label)) return response;
    try {
        response.headers.set('X-Cache', label);
        return response;
    } catch (e) {
        try {
            const headers = new Headers(response.headers);
            headers.set('X-Cache', label);
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        } catch (e2) {
            console.error(`[x-cache] 标签写入失败(${label}): ${e2?.message ?? e}`);
            return response;
        }
    }
}

/** 用 KV 存的 entry 重建响应（补 Content-Disposition，返回给客户端时头部与原路径一致） */
function buildResponseFromEntry(entry, source) {
    const headers = { ...NO_STORE_HEADERS };
    // 与 index.js 其它失败分支(403/404/500)一致补 ACAO：STALE 替换失败响应后浏览器端仍可读内容
    // （KV-HIT 走同一重建函数，一并覆盖）
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Content-Type'] = entry.contentType || 'text/plain;charset=UTF-8';
    if (entry.contentDisposition) headers['Content-Disposition'] = entry.contentDisposition;
    headers['X-Cache'] = source;
    return new Response(entry.body ?? '', { status: 200, headers });
}

/** 缓存命中的响应：Cache API 返回的 Response 头部不可变，这里重建一份可改头的响应 */
function buildResponseFromCacheHit(hit, body) {
    const headers = { ...NO_STORE_HEADERS };
    // 补 ACAO：与 buildResponseFromEntry 对齐，避免 CACHE-HIT 与 KV-HIT/STALE 两种命中的 CORS 行为分裂
    headers['Access-Control-Allow-Origin'] = '*';
    const contentType = hit.headers.get('Content-Type');
    if (contentType) headers['Content-Type'] = contentType;
    const contentDisposition = hit.headers.get('Content-Disposition');
    if (contentDisposition) headers['Content-Disposition'] = contentDisposition;
    headers['X-Cache'] = CACHE_LABEL.hit;
    return new Response(body, { status: 200, headers });
}

/**
 * 读缓存：Cache API 优先，其次 KV。
 * @param {{cache?: any, kv?: any, request: Request, now?: number}} deps
 * @returns {Promise<Response|null>} 命中返回带 X-Cache 的响应，未命中返回 null
 */
export async function readCachedDownload({ cache, kv, request, now = Date.now() }) {
    let canonicalUrl;
    try {
        canonicalUrl = normalizeCacheUrl(request.url);
    } catch (e) {
        console.error(`[x-cache] 缓存键规范化失败: ${e?.message ?? e}`);
        return null;
    }

    // 1) Cache API（键为哈希形态，见 cacheRequestKey）
    if (cache && typeof cache.match === 'function') {
        try {
            const hit = await cache.match(await cacheRequestKey(canonicalUrl));
            if (hit && hit.status === 200) {
                const body = await hit.text();
                return buildResponseFromCacheHit(hit, body);
            }
        } catch (e) {
            console.error(`[x-cache] Cache API 读取失败: ${e?.message ?? e}`);
        }
    }

    // 2) KV 兜底
    if (kv && typeof kv.get === 'function') {
        try {
            const key = await kvKey(canonicalUrl);
            const raw = await kv.get(key);
            if (raw === null || raw === undefined || raw === '') return null;
            const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!entry || typeof entry !== 'object' || typeof entry.body !== 'string') return null;
            // 年龄判断：超过新鲜窗口(6h)的条目不作为正常命中（返回 null 走原路径重新拉取），
            // 超龄条目只在上游失败时由 readStaleFromKv 兜底使用；
            // storedAt 在未来（时钟偏移）同样不命中——对齐 isFreshEntry 的 now-storedAt>=0 语义
            const storedAt = Date.parse(entry.storedAt);
            const ageMs = now - storedAt;
            if (!Number.isFinite(storedAt) || ageMs < 0 || ageMs >= KV_FRESH_WINDOW_SECONDS * 1000) return null;
            return buildResponseFromEntry(entry, CACHE_LABEL.kvHit);
        } catch (e) {
            console.error(`[x-cache] KV 读取失败: ${e?.message ?? e}`);
        }
    }

    return null;
}

/**
 * stale-on-error 兜底读取：上游失败(status>=400)时从 KV 捞旧内容回吐（X-Cache: STALE）。
 * 不设 6h 新鲜窗口——6-24h 的超龄条目正是本函数的目标数据；上限按 storedAt 复核
 * 不超过 KV_TTL_SECONDS(24h)（双保险：防 KV 实现不严格执行 TTL 时回吐任意陈旧内容），
 * storedAt 在未来（时钟偏移）同样拒绝。命中时日志携带 age 小时数。
 * refresh/nocache bypass 的失败请求同样允许走到这里（断粮场景 refresh 恰恰最需要兜底）。
 * 任何异常返回 null（兜底失败不影响原失败响应的正常返回）。
 * @param {{kv?: any, request: Request, now?: number}} deps 与 readCachedDownload 相同的注入风格
 * @returns {Promise<Response|null>} 命中返回 X-Cache: STALE 的响应，未命中/异常返回 null
 */
export async function readStaleFromKv({ kv, request, now = Date.now() } = {}) {
    try {
        if (!kv || typeof kv.get !== 'function') return null;
        const canonicalUrl = normalizeCacheUrl(request.url);
        const key = await kvKey(canonicalUrl);
        const raw = await kv.get(key);
        if (raw === null || raw === undefined || raw === '') return null;
        const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!entry || typeof entry !== 'object' || typeof entry.body !== 'string') return null;
        const storedAt = Date.parse(entry.storedAt);
        if (!Number.isFinite(storedAt)) return null;
        const ageMs = now - storedAt;
        if (ageMs < 0 || ageMs > KV_TTL_SECONDS * 1000) return null;
        console.log(`[x-cache] STALE 兜底命中 (age=${(ageMs / 3600000).toFixed(1)}h)`);
        return buildResponseFromEntry(entry, CACHE_LABEL.stale);
    } catch (e) {
        console.error(`[x-cache] STALE 兜底读取失败: ${e?.message ?? e}`);
        return null;
    }
}

/**
 * 写缓存：校验通过后写 Cache API + KV + 预热清单，三者互相独立、各自容错。
 * @param {{cache?: any, kv?: any, request: Request, response: Response, bypassRead?: boolean, now?: number}} deps
 *        response 必须是原响应的 clone()，本函数会读干它的 body
 *        bypassRead=true（refresh/nocache 请求）时跳过 KV 写冷却检查，强制覆盖 KV
 * @returns {Promise<{stored: boolean, reason?: string, byteLength?: number}>}
 */
export async function storeDownload({ cache, kv, request, response, bypassRead = false, now = Date.now() }) {
    try {
        if (!response) return { stored: false, reason: 'no-response' };

        let body;
        try {
            body = await response.text();
        } catch (e) {
            console.error(`[x-cache] 响应体读取失败: ${e?.message ?? e}`);
            return { stored: false, reason: 'body-unreadable' };
        }
        const byteLength = new TextEncoder().encode(body).length;
        if (!validateCandidate(response.status, byteLength)) {
            console.log(`[x-cache] 跳过缓存: status=${response.status} bytes=${byteLength}`);
            return { stored: false, reason: 'invalid-candidate', byteLength };
        }

        let canonicalUrl;
        try {
            canonicalUrl = normalizeCacheUrl(request.url);
        } catch (e) {
            console.error(`[x-cache] 缓存键规范化失败: ${e?.message ?? e}`);
            return { stored: false, reason: 'bad-url', byteLength };
        }

        const contentType = response.headers.get('Content-Type') || 'text/plain;charset=UTF-8';
        const contentDisposition = response.headers.get('Content-Disposition') || null;
        const entry = {
            body,
            contentType,
            contentDisposition,
            storedAt: new Date(now).toISOString(),
        };

        const stored = { cache: false, kv: false };

        // 1) Cache API（存自建 Response，带 public,max-age=1800；返回给客户端的响应头不受影响）
        if (cache && typeof cache.put === 'function') {
            try {
                const cacheable = new Response(body, {
                    status: 200,
                    headers: {
                        'Content-Type': contentType,
                        ...(contentDisposition ? { 'Content-Disposition': contentDisposition } : {}),
                        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
                    },
                });
                await cache.put(await cacheRequestKey(canonicalUrl), cacheable);
                stored.cache = true;
            } catch (e) {
                console.error(`[x-cache] Cache API 写入失败: ${e?.message ?? e}`);
            }
        }

        // 2) KV（写前 get 查重：已存在且 10min 内写过则跳过，控写配额）
        // bypassRead 强制覆盖的动机：refresh/nocache 请求拿到了新内容，若被 10min 写冷却跳写，
        // 新内容只进了 30min 的 Cache API；30min 后 Cache API 过期、KV 里的旧内容会「回潮」——
        // 用户明明手动刷新过，却看到最长 24h（其中 6-24h 段仅 stale 兜底可读）的旧订阅。
        if (kv && typeof kv.put === 'function' && typeof kv.get === 'function') {
            try {
                const key = await kvKey(canonicalUrl);
                const existing = await kv.get(key);
                const parsedExisting = existing
                    ? typeof existing === 'string'
                        ? JSON.parse(existing)
                        : existing
                    : null;
                if (isFreshEntry(parsedExisting, now) && !bypassRead) {
                    console.log('[x-cache] KV 命中写冷却窗口，跳过写入');
                } else {
                    await kv.put(key, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
                    stored.kv = true;
                }
            } catch (e) {
                console.error(`[x-cache] KV 写入失败: ${e?.message ?? e}`);
            }
        }

        // 3) 缓存索引（「保存即作废」依据）：任一层写入成功才登记；独立容错，索引写失败不影响返回值
        if (stored.cache || stored.kv) {
            await upsertCacheIndex(kv, canonicalUrl, { now });
        }

        // 4) 预热清单
        await upsertPreheatList(kv, canonicalUrl, { now });

        console.log(`[x-cache] 已缓存 ${canonicalUrl} (bytes=${byteLength}, cache=${stored.cache}, kv=${stored.kv})`);
        return { stored: true, byteLength, ...stored };
    } catch (e) {
        console.error(`[x-cache] 写缓存异常: ${e?.message ?? e}`);
        return { stored: false, reason: 'exception' };
    }
}

/**
 * 「保存即作废」：配置写操作成功后，按缓存索引清空全部 /download 下载缓存。
 * 读索引（为空/不可读时兜底改读预热清单，两者基本重叠，重复 delete 无害）
 * → 分批并发删 Cache API 与 KV（每批 INVALIDATE_BATCH_SIZE 条 Promise.all，批间串行，
 *   单条独立容错，失败不中断其余）→ 收尾：
 *   - 全部删除成功 → kv.delete(CACHE_INDEX_KEY)（不用 put '[]'：避免覆盖「失效读索引之后、
 *     收尾之前」并发 storeDownload 刚 upsert 登记的新条目）；
 *   - 有删除失败 → 把失败条目写回索引（带 TTL），留给下次「保存即作废」重试。
 * 索引为空且预热清单也为空直接返回；任何异常都绝不外抛（失效失败只影响下一次读到旧内容，
 * 不影响主响应）。部分删除失败不丢登记，杜绝「删除失败=永久陈旧」。
 * @param {{cache?: any, kv?: any}} deps 与 storeDownload 相同的注入风格
 * @returns {Promise<{cleared: number, failed: number}>}
 */
export async function invalidateAllDownloads({ cache, kv } = {}) {
    const result = { cleared: 0, failed: 0 };
    try {
        let list = await readCacheIndex(kv);
        if (list.length === 0) {
            // 轻量兜底：索引为空/不可读时，把预热清单里的 URL 也逐条删一遍
            list = await readPreheatList(kv);
        }
        if (list.length === 0) return result;

        const failedUrls = [];
        for (let i = 0; i < list.length; i += INVALIDATE_BATCH_SIZE) {
            const batch = list.slice(i, i + INVALIDATE_BATCH_SIZE);
            // 先逐条算好本批 Cache API 哈希键再并发删（哈希是纯 CPU 微秒级，预计算无感），
            // 保证批内 cache.delete 齐发（与原同步构造 Request 的并发行为一致，批间仍串行）
            const cacheKeys = await Promise.all(batch.map((url) => cacheRequestKey(url)));
            const outcomes = await Promise.all(
                batch.map(async (url, j) => {
                    let ok = true;
                    if (cache && typeof cache.delete === 'function') {
                        try {
                            await cache.delete(cacheKeys[j]);
                        } catch (e) {
                            ok = false;
                            console.error(`[x-cache] 失效删除 Cache API 失败 ${url}: ${e?.message ?? e}`);
                        }
                    }
                    if (kv && typeof kv.delete === 'function') {
                        try {
                            await kv.delete(await kvKey(url));
                        } catch (e) {
                            ok = false;
                            console.error(`[x-cache] 失效删除 KV 失败 ${url}: ${e?.message ?? e}`);
                        }
                    }
                    return { url, ok };
                }),
            );
            for (const { url, ok } of outcomes) {
                if (ok) result.cleared++;
                else {
                    result.failed++;
                    failedUrls.push(url);
                }
            }
        }

        // 收尾（见 JSDoc）：全成 → 删索引键；有失败 → 失败条目写回索引待重试
        try {
            if (failedUrls.length === 0) {
                if (kv && typeof kv.delete === 'function') await kv.delete(CACHE_INDEX_KEY);
            } else if (kv && typeof kv.put === 'function') {
                await kv.put(CACHE_INDEX_KEY, JSON.stringify(failedUrls), { expirationTtl: CACHE_INDEX_TTL_SECONDS });
            }
        } catch (e) {
            console.error(`[x-cache] 缓存索引收尾失败: ${e?.message ?? e}`);
        }
        console.log(`[x-cache] 已清空下载缓存: cleared=${result.cleared} failed=${result.failed}`);
        return result;
    } catch (e) {
        console.error(`[x-cache] 清空下载缓存异常: ${e?.message ?? e}`);
        return result;
    }
}

/** 探测请求超时信号（环境不支持时返回 undefined） */
function preheatSignal() {
    try {
        return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(PREHEAT_TIMEOUT_MS)
            : undefined;
    } catch {
        return undefined;
    }
}

/** 只判状态码，绝不读响应体；有 body 则 cancel() 释放 */
async function probeOnce(fetchFn, url) {
    const resp = await fetchFn(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': PREHEAT_UA, 'Cache-Control': 'no-store' },
        signal: preheatSignal(),
    });
    const ok = resp?.status === 200;
    try {
        if (resp?.body && typeof resp.body.cancel === 'function') {
            await resp.body.cancel();
        }
    } catch {
        /* 忽略：释放 body 失败不影响判定 */
    }
    return ok;
}

/**
 * 预热：读 KV 预热清单，逐个发探测请求（子请求本身命中即由该次调用写缓存）。
 * 只判 resp.status===200，绝不读 body；单 URL 最多 3 次，总 subrequest ≤ 9 次。
 * @param {{kv?: any, fetchFn?: Function, now?: number, budget?: number}} deps
 * @returns {Promise<{probed: number, ok: number, failed: number}>}
 */
export async function runPreheat({ kv, fetchFn, now = Date.now(), budget = PREHEAT_FETCH_BUDGET } = {}) {
    const result = { probed: 0, ok: 0, failed: 0 };
    const doFetch = typeof fetchFn === 'function' ? fetchFn : globalThis.fetch;
    try {
        const list = await readPreheatList(kv);
        if (list.length === 0) {
            console.log('[x-cache][Preheat] 预热清单为空，跳过');
            return result;
        }
        if (typeof doFetch !== 'function') {
            console.error('[x-cache][Preheat] fetch 不可用，跳过');
            return result;
        }

        let remaining = Number.isFinite(budget) ? budget : PREHEAT_FETCH_BUDGET;
        console.log(`[x-cache][Preheat] 清单 ${list.length} 条，预算 ${remaining} 次探测`);

        for (const url of list) {
            if (remaining <= 0) break;
            let ok = false;
            for (let attempt = 1; attempt <= PREHEAT_ATTEMPTS_PER_URL && remaining > 0; attempt++) {
                remaining--;
                result.probed++;
                try {
                    ok = await probeOnce(doFetch, url);
                } catch (e) {
                    console.warn(`[x-cache][Preheat] 探测失败(${attempt}/${PREHEAT_ATTEMPTS_PER_URL}) ${url}: ${e?.message ?? e}`);
                }
                if (ok) break;
            }
            if (ok) {
                result.ok++;
            } else {
                result.failed++;
            }
        }

        console.log(`[x-cache][Preheat] 完成: probed=${result.probed} ok=${result.ok} failed=${result.failed} at=${new Date(now).toISOString()}`);
        return result;
    } catch (e) {
        console.error(`[x-cache][Preheat] 预热异常: ${e?.message ?? e}`);
        return result;
    }
}

/**
 * 定时任务编排（预热并轨）：先跑预热探测（I/O，不占 CPU），结算后再跑原有同步任务。
 * 预热的任何异常都不阻断后续同步（各段独立容错）。
 *
 * @param {{cron?: string, kv?: any, fetchFn?: Function, runSync?: Function, now?: number, budget?: number}} deps
 * @returns {Promise<{preheated: {probed: number, ok: number, failed: number}, synced: boolean}>}
 */
export async function runScheduledTasks({ cron, kv, fetchFn, runSync, now = Date.now(), budget } = {}) {
    const plan = planCronRun(cron);
    let preheated = { probed: 0, ok: 0, failed: 0 };
    if (plan.preheat) {
        try {
            preheated = await runPreheat({ kv, fetchFn, now, budget });
        } catch (e) {
            console.error(`[x-cache][Cron] 预热段异常: ${e?.message ?? e}`);
        }
    }
    let synced = false;
    if (plan.sync && typeof runSync === 'function') {
        synced = true;
        await runSync();
    }
    return { preheated, synced };
}