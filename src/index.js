/** Sub-Store Workers 入口 */

import { version as workersVersion } from '../package.json';
import { version as substoreVersion } from '../../Sub-Store/backend/package.json';
const version = `${substoreVersion}(w${workersVersion})`;
import $ from '@/core/app';
import express from '@/vendor/express';
import * as xCache from '@/vendor/x-cache';
import migrate from '@/utils/migration';

import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerCollectionRoutes from '@/restful/collections';
import registerArtifactRoutes from '@/restful/artifacts';
import registerFileRoutes from '@/restful/file';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerSyncRoutes from '@/restful/sync';
import registerDownloadRoutes from '@/restful/download';
import registerSettingRoutes from '@/restful/settings';
import registerPreviewRoutes from '@/restful/preview';
import registerSortingRoutes from '@/restful/sort';
import registerMiscRoutes from '@/restful/miscs';
import registerNodeInfoRoutes from '@/restful/node-info';
import registerParserRoutes from '@/restful/parser';
import registerLogRoutes from '@/restful/logs';
import registerAgeRoutes from '@/restful/age';

import { produceArtifact } from '@/restful/sync';
import { syncToGist } from '@/restful/artifacts';
import { gistBackupAction } from '@/restful/miscs';
import { consumeShareToken } from '@/restful/token';
import { SETTINGS_KEY, ARTIFACTS_KEY, SUBS_KEY, COLLECTIONS_KEY } from '@/constants';
import { findByName } from '@/utils/database';

// 初始化应用及路由
const $app = express({ substore: $ });

registerCollectionRoutes($app);
registerSubscriptionRoutes($app);
registerDownloadRoutes($app);
registerPreviewRoutes($app);
registerSortingRoutes($app);
registerSettingRoutes($app);
registerArtifactRoutes($app);
registerFileRoutes($app);
registerTokenRoutes($app);
registerArchiveRoutes($app);
registerModuleRoutes($app);
registerSyncRoutes($app);
registerNodeInfoRoutes($app);
registerMiscRoutes($app);
registerParserRoutes($app);
registerLogRoutes($app);
registerAgeRoutes($app);

export default {
    // 定时同步（预热探测并轨：先探测，再跑原有同步逻辑）
    async scheduled(event, env, ctx) {
        const kvError = validateKVBinding(env);
        if (kvError) {
            console.error(`[Cron] ${kvError.message}`);
            return;
        }

        // [x-cache] 预热并轨到现有唯一 cron（"55 15 * * *"，不占额外 cron 配额）：
        // 预热探测先跑（读预热清单、逐 URL 只判状态码，≤9 次子请求、I/O 不占 CPU），
        // 结算后再跑原有 cronSyncArtifacts（逻辑一行未改）。
        // 若 event.cron 命中预热专用 pattern（未来释放配额后追加 cron），则只做预热、不做同步。
        ctx.waitUntil(
            xCache.runScheduledTasks({
                    cron: event?.cron,
                    kv: env.SUB_STORE_DATA,
                    runSync: () => cronSyncArtifacts(env),
                })
                .catch((e) => console.error(`[Cron] 任务异常: ${e?.message ?? e}`)),
        );
    },

    async fetch(request, env, ctx) {
        // [x-cache] 标签前置：标签在「读阶段结束」第一时间定值并在响应对象生成后立刻写入，
        // 后续写缓存/回写 KV/任何异常都不再吞掉 X-Cache 观测头（批次03 修复）
        let isDownloadRequest = false;
        let cacheLabel = '';
        try {
            const kvError = validateKVBinding(env);
            if (kvError) return kvError.response;

            // CORS 预检
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': '*',
                        'Access-Control-Allow-Headers': '*',
                        'Access-Control-Max-Age': '86400',
                    },
                });
            }

            const url = new URL(request.url);
            let pathname = url.pathname;

            // 路径前缀鉴权（可选）
            // 配置 SUB_STORE_FRONTEND_BACKEND_PATH = "/你的密码" 后
            // 前端后端地址填: https://xxx.pages.dev/你的密码
            // 管理 API 需要带前缀才能访问，分享链接（download/preview）不受影响
            const backendPath = env.SUB_STORE_FRONTEND_BACKEND_PATH;
            const isPublicPath = /^\/(api\/download|api\/preview|api\/sub\/flow)/.test(pathname);
            const isManagementApi = !isPublicPath && pathname.startsWith('/api/');
            const isAuthDisabledManagementApi = !backendPath && isManagementApi;
            if (isAuthDisabledManagementApi) {
                console.warn(`[Security] SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is publicly accessible: ${pathname}`);
            }
            if (backendPath) {
                if (!isPublicPath && pathname.startsWith('/api/')) {
                    // 直接访问 /api/* 没带前缀，拒绝
                    return new Response(JSON.stringify({ status: 'failed', message: 'Unauthorized' }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    });
                }
                if (pathname === backendPath) {
                    // 精确匹配前缀，重定向到带 / 的路径
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Location': new URL(backendPath + '/', request.url).toString(),
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }
                if (pathname.startsWith(backendPath + '/')) {
                    // 带了前缀，剥离后交给路由
                    pathname = pathname.slice(backendPath.length);
                    const newUrl = new URL(request.url);
                    newUrl.pathname = pathname;
                    // 通过密码前缀访问才注入 share 标记（与上游 be_merge 行为一致）
                    if (pathname.startsWith('/api/')) {
                        newUrl.searchParams.set('share', 'true');
                    }
                    request = new Request(newUrl.toString(), request);
                }
            }

            // [x-cache] 落点A：/download 缓存层读路径 —— Cache API → KV → 未命中放行
            // 命中直接返回，不加载 KV 数据、不进 express 分发（省 CPU，避免 1102）
            isDownloadRequest = xCache.isDownloadPath(pathname, request.method);
            const cacheBypass = isDownloadRequest && xCache.shouldBypassCacheRead(request.url);
            // 读阶段结束即定标签：未命中（含 bypass）→ MISS；命中路径由 x-cache.js 重建响应时已带标签
            isDownloadRequest && (cacheLabel = xCache.CACHE_LABEL.miss);
            if (isDownloadRequest && !cacheBypass) {
                const cached = await xCache.readCachedDownload({
                    cache: xCache.defaultCache(),
                    kv: env.SUB_STORE_DATA,
                    request,
                });
                if (cached) {
                    console.log(`[x-cache] ${cached.headers.get('X-Cache')} ${pathname}`);
                    // 兜底：命中响应若因任何原因缺标签，这里补上（保证 HIT 路径也不漏头）
                    return xCache.applyCacheLabel(cached, cached.headers.get('X-Cache') || xCache.CACHE_LABEL.hit);
                }
            }

            // 注入环境变量
            globalThis.__workerEnv = env;

            // 从 KV 加载数据
            await $.initFromKV(env.SUB_STORE_DATA);
            if (!$.read(SETTINGS_KEY)) $.write({}, SETTINGS_KEY);
            $.workerEnv = env;

            // 数据迁移
            migrate();

            console.log(`Sub-Store Workers v${version} handling: ${request.method} ${pathname}`);

            // /share/ 路由的 token 验证（与上游 Node.js 版 be_merge 行为一致）
            // 所有 /share/ 请求都必须携带有效 token，未分享的订阅/文件不可直接访问
            if (pathname.startsWith('/share/')) {
                if (request.method.toUpperCase() !== 'GET') {
                    return new Response(JSON.stringify({ status: 'failed', message: 'Method not allowed' }), {
                        status: 405,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    });
                }
                const tokenValue = url.searchParams.get('token');
                if (!tokenValue) {
                    // 未提供 token，拒绝访问
                    return new Response(JSON.stringify({ status: 'failed', message: 'Share token is required' }), {
                        status: 403,
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    });
                }
                const decodedPathname = decodeURIComponent(pathname);
                const shareToken = consumeShareToken({
                    token: tokenValue,
                    pathname: decodedPathname,
                });
                if (!shareToken) {
                    // token 无效
                    const settings = $.read(SETTINGS_KEY);
                    if (settings?.appearanceSetting?.invalidShareFakeNode) {
                        // 返回假节点
                        const fakeUrl = new URL(request.url);
                        fakeUrl.pathname = pathname.replace(/\/share\/.*?\//, '/share/sub/');
                        fakeUrl.searchParams.set('_fakeNode', 'true');
                        request = new Request(fakeUrl.toString(), request);
                    } else {
                        return new Response(JSON.stringify({ status: 'failed', message: 'Invalid or expired share token' }), {
                            status: 404,
                            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                        });
                    }
                }
                // token 有效，继续正常路由
            }

            // 路由分发
            const response = await $app.handleRequest(request);

            // [x-cache] 落点A续：标签第一时间写入（先于写缓存调度，异常也不吞标签）
            if (isDownloadRequest) {
                // [x-cache] stale-on-error：上游失败(status>=400)时优先回吐 KV 里的旧内容兜底
                // （含 refresh/nocache bypass——断粮场景 refresh 恰恰最需要兜底）。
                // 命中则直接返回 STALE 响应替代失败响应（此路径不写缓存、不进 storeDownload）；
                // 未命中/兜底异常时继续走原失败响应路径。必须放在 storeDownload 调度之前：
                // 语义上失败响应不应进写入流程（validateCandidate 也会跳过非 200）。
                if (response.status >= 400) {
                    try {
                        const stale = await xCache.readStaleFromKv({
                            kv: env.SUB_STORE_DATA,
                            request,
                        });
                        if (stale) {
                            console.log(`[x-cache] 上游失败(status=${response.status}),回吐 STALE 缓存 ${pathname}`);
                            // 早退前补同款例行冲刷：失败响应原本也会走到函数末尾的冲刷，
                            // 早退替换响应不能丢掉本次请求积累的 KV 回写与 pendingPushes
                            try {
                                ctx.waitUntil(
                                    Promise.all([
                                        $.persistCache(),
                                        ...($.pendingPushes || []),
                                    ]).catch((e) => console.error(`[x-cache] STALE 早退冲刷失败: ${e?.message ?? e}`)),
                                );
                                $.pendingPushes = [];
                            } catch (e) {
                                console.error(`[x-cache] STALE 早退冲刷调度失败: ${e?.message ?? e}`);
                            }
                            return stale;
                        }
                    } catch (e) {
                        console.error(`[x-cache] STALE 兜底异常: ${e?.message ?? e}`);
                    }
                }
                xCache.applyCacheLabel(response, cacheLabel);
                if (cacheBypass) console.log(`[x-cache] MISS(bypass) ${pathname}`);
                // 未命中/被 bypass 的 /download 请求，异步写两层缓存 + 更新预热清单
                try {
                    ctx.waitUntil(
                        xCache.storeDownload({
                            cache: xCache.defaultCache(),
                            kv: env.SUB_STORE_DATA,
                            request,
                            response: response.clone(),
                            // refresh/nocache 拿到新内容时强制覆盖 KV，绕过 10min 写冷却（防旧内容回潮）
                            bypassRead: cacheBypass,
                        }),
                    );
                } catch (e) {
                    console.error(`[x-cache] 写入调度失败: ${e?.message ?? e}`);
                }
            }

            // [x-cache] 保存即作废：任何配置写接口（非 GET/HEAD/OPTIONS）成功返回（2xx）后，
            // 清空全部 /download 下载缓存，避免用户改完订阅/节点组脚本配置后最长 24h（6-24h 段
            // 仅 stale 兜底可读）读到旧内容。
            // 放在 storeDownload 调度之后；500 catch 路径天然不经过这里，不会误清。
            try {
                const isConfigMutation =
                    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
                    response.status >= 200 &&
                    response.status < 300;
                if (isConfigMutation) {
                    ctx.waitUntil(
                        xCache.invalidateAllDownloads({
                            cache: xCache.defaultCache(),
                            kv: env.SUB_STORE_DATA,
                        })
                            .then((r) =>
                                console.log(`[x-cache] 配置变更(非 GET 2xx)，清空下载缓存完成: cleared=${r?.cleared ?? 0} failed=${r?.failed ?? 0}`),
                            )
                            .catch((e) => console.error(`[x-cache] 清空下载缓存失败: ${e?.message ?? e}`)),
                    );
                    console.log('[x-cache] 配置变更(非 GET 2xx)，已调度清空下载缓存');
                }
            } catch (e) {
                console.error(`[x-cache] 失效调度失败: ${e?.message ?? e}`);
            }

            // 禁止 Cloudflare CDN/边缘节点缓存动态 API 响应
            // 未设置此头时，不同 URL 路径（如 /share/ 和 /download/）的响应可能被独立缓存，
            // 导致同一订阅在不同接口返回不一致（陈旧）的数据
            response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
            response.headers.set('CDN-Cache-Control', 'no-store');

            if (isAuthDisabledManagementApi) {
                response.headers.set('X-Sub-Store-Security-Warning', 'SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is public');
            }

            // 回写 KV + 确保推送完成
            ctx.waitUntil(Promise.all([
                $.persistCache(),
                ...($.pendingPushes || []),
            ]));
            $.pendingPushes = [];

            return response;
        } catch (e) {
            console.error(`Unhandled error: ${e.message}\n${e.stack}`);
            // 出错也尝试回写
            ctx.waitUntil(Promise.all([
                $.persistCache(),
                ...($.pendingPushes || []),
            ]));
            $.pendingPushes = [];
            return xCache.applyCacheLabel(
                new Response(
                    JSON.stringify({
                        status: 'failed',
                        message: 'Internal Server Error',
                    }),
                    {
                        status: 500,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*',
                        },
                    },
                ),
                cacheLabel,
            );
        }
    },
};

function validateKVBinding(env) {
    if (env?.SUB_STORE_DATA?.get && env?.SUB_STORE_DATA?.put) return null;
    const body = JSON.stringify({
        status: 'failed',
        message: 'Missing KV binding: SUB_STORE_DATA. Please bind a Cloudflare KV namespace named SUB_STORE_DATA before running Sub-Store Workers.',
    });
    return {
        message: 'Missing KV binding: SUB_STORE_DATA',
        response: new Response(body, {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        }),
    };
}

/** 定时同步 artifacts 到 Gist */
async function cronSyncArtifacts(env) {
    try {
        globalThis.__workerEnv = env;
        await $.initFromKV(env.SUB_STORE_DATA);
        $.workerEnv = env;

        console.log(`[Cron] Sub-Store Workers v${version} 开始同步...`);

        const settings = $.read(SETTINGS_KEY);
        if (!settings?.githubUser || !settings?.gistToken) {
            console.log('[Cron] 未配置 GitHub Token，跳过同步');
            return;
        }

        const allArtifacts = $.read(ARTIFACTS_KEY);
        if (!allArtifacts || allArtifacts.length === 0) {
            console.log('[Cron] 无 artifacts，跳过同步');
            return;
        }

        const shouldSync = allArtifacts.some((a) => a.sync);
        if (!shouldSync) {
            console.log('[Cron] 无需同步的配置');
            return;
        }

        // 收集需要同步的订阅名
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const subNames = [];
        let enabledCount = 0;

        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source) {
                enabledCount++;
                if (artifact.type === 'subscription') {
                    const sub = findByName(allSubs, artifact.source);
                    if (sub?.url && !subNames.includes(artifact.source)) {
                        subNames.push(artifact.source);
                    }
                } else if (artifact.type === 'collection') {
                    const col = findByName(allCols, artifact.source);
                    if (col?.subscriptions) {
                        for (const sn of col.subscriptions) {
                            const sub = findByName(allSubs, sn);
                            if (sub?.url && !subNames.includes(sn)) {
                                subNames.push(sn);
                            }
                        }
                    }
                }
            }
        }

        if (enabledCount === 0) {
            console.log('[Cron] 无启用同步的配置');
            return;
        }

        // 预生成订阅缓存
        if (subNames.length > 0) {
            await Promise.all(
                subNames.map(async (name) => {
                    try {
                        await produceArtifact({ type: 'subscription', name, awaitCustomCache: true });
                    } catch (e) { /* 忽略 */ }
                }),
            );
        }

        // 生成所有 artifacts
        const files = {};
        const valid = [];
        const invalid = [];

        await Promise.all(
            allArtifacts.map(async (artifact) => {
                try {
                    if (!artifact.sync || !artifact.source) return;
                    console.log(`[Cron] 正在同步：${artifact.name}...`);

                    const output = await produceArtifact({
                        type: artifact.type,
                        name: artifact.source,
                        platform: artifact.platform,
                        produceOpts: {
                            'include-unsupported-proxy': artifact.includeUnsupportedProxy,
                            useMihomoExternal: artifact.platform === 'SurgeMac',
                            prettyYaml: artifact.prettyYaml,
                        },
                    });

                    files[encodeURIComponent(artifact.name)] = { content: output };
                    valid.push(artifact.name);
                } catch (e) {
                    console.error(`[Cron] 生成 ${artifact.name} 失败: ${e.message ?? e}`);
                    invalid.push(artifact.name);
                }
            }),
        );

        console.log(`[Cron] 成功 ${valid.length} 个，失败 ${invalid.length} 个`);

        if (valid.length === 0) {
            console.error('[Cron] 全部失败，跳过上传');
            return;
        }

        // 上传到 Gist
        const resp = await syncToGist(files);
        const body = JSON.parse(resp.body);

        // 更新 artifact URL
        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source && valid.includes(artifact.name)) {
                artifact.updated = new Date().getTime();
                let gistFiles = body.files;
                let isGitLab;
                if (Array.isArray(gistFiles)) {
                    isGitLab = true;
                    gistFiles = Object.fromEntries(gistFiles.map((item) => [item.path, item]));
                }
                const raw_url = gistFiles[encodeURIComponent(artifact.name)]?.raw_url;
                artifact.url = isGitLab ? raw_url : raw_url?.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
            }
        }

        $.write(allArtifacts, ARTIFACTS_KEY);

        // Gist 备份上传
        try {
            console.log('[Cron] 上传 Gist 备份...');
            await gistBackupAction('upload');
            console.log('[Cron] Gist 备份完成');
        } catch (e) {
            console.error(`[Cron] Gist 备份失败: ${e.message ?? e}`);
        }

        await $.persistCache();
        console.log('[Cron] 同步完成');
    } catch (e) {
        console.error(`[Cron] 同步失败: ${e.message ?? e}`);
        // 尝试回写
        try { await $.persistCache(); } catch (_) {}
    }
}
