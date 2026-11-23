/** Sub-Store Workers OpenAPI 适配层 */

import { Base64 } from 'js-base64';
import { installConsoleLogCapture } from '@/utils/debug-logs';

// 平台检测
const isQX = false;
const isLoon = false;
const isSurge = false;
const isNode = false;
const isStash = false;
const isShadowRocket = false;
const isEgern = false;
const isLanceX = false;
const isGUIforCores = false;
const isWorker = true;

function isPlainObject(obj) {
    return (
        obj !== null &&
        typeof obj === 'object' &&
        [null, Object.prototype].includes(Object.getPrototypeOf(obj))
    );
}

/**
 * 同 isolate 内的 KV 解析结果复用（60s，与 KV get 的 cacheTtl 对齐）。
 * 每次请求都重新读 2MB(主数据)+1MB(root) 并 JSON.parse 是免费档 CPU 1102 的主要来源；
 * 这里把已解析对象挂在模块级，同一 isolate 60s 内直接复用，跳过 KV 读与解析。
 * 数据更新仍以 KV 为准：其它 isolate 的写入最迟 60s 后被本 isolate 看到（与现有 cacheTtl:60 同语义）。
 */
const KV_MEMO_TTL_MS = 60 * 1000;
let kvMemo = {
    at: 0,
    kv: null,
    cache: null,
    root: null,
    cacheSnapshot: '',
    rootSnapshot: '',
};
/** 并发冷启动合并：多个请求同时命中空 memo 时只解析一次，避免面板并发把 CPU 打爆 */
let kvMemoLoading = null;

function isKvMemoFresh(kvBinding, now) {
    return (
        kvMemo.kv === kvBinding &&
        kvMemo.cache &&
        kvMemo.root &&
        now - kvMemo.at >= 0 &&
        now - kvMemo.at < KV_MEMO_TTL_MS
    );
}

export class OpenAPI {
    constructor(name = 'untitled', debug = false) {
        this.name = name;
        this.debug = debug;

        this.http = HTTP();
        this.env = ENV();

        this.node = null;

        // 内存缓存
        this.cache = {};
        this.root = {};

        this._kvBinding = null; // set by initFromKV()
        this._dirty = false;
        this._rootDirty = false;
        this._cacheSnapshot = '';
        this._rootSnapshot = '';
        // 由 index.js 每个请求显式设置：产物读请求（/download）为 true，跳过所有 KV 回写
        this.readOnlyRequest = false;

        const delay = (t, v) =>
            new Promise(function (resolve) {
                setTimeout(resolve.bind(null, v), t);
            });

        Promise.prototype.delay = async function (t) {
            const v = await this;
            return await delay(t, v);
        };
    }

    /** 从 KV 初始化 */
    async initFromKV(kvBinding) {
        this._kvBinding = kvBinding;
        this._dirty = false;
        this._rootDirty = false;

        const now = Date.now();
        // 快路径：同 isolate 60s 内已解析过同一 KV 绑定，直接复用，省掉 3MB 读+parse
        if (isKvMemoFresh(kvBinding, now)) {
            this.applyKvMemo(kvMemo);
            return;
        }

        // 并发合并：同一 isolate 内多个请求同时冷启动时只解析一次
        if (!kvMemoLoading || kvMemoLoading.kv !== kvBinding) {
            const promise = this.loadKvMemo(kvBinding).then((memo) => {
                kvMemo = memo;
                return memo;
            });
            kvMemoLoading = { kv: kvBinding, promise };
            promise
                .finally(() => {
                    if (kvMemoLoading?.promise === promise) kvMemoLoading = null;
                })
                .catch(() => {});
        }
        const memo = await kvMemoLoading.promise;
        this.applyKvMemo(memo);
    }

    /** 把 memo 挂到当前 $ 实例（每次请求都指向同一批对象，避免重复解析） */
    applyKvMemo(memo) {
        this.cache = memo.cache;
        this.root = memo.root;
        this._cacheSnapshot = memo.cacheSnapshot;
        this._rootSnapshot = memo.rootSnapshot;
        if (!this.readOnlyRequest) installConsoleLogCapture(this);
    }

    /** 真正读 KV 并解析（只在一个 isolate 的冷启动/过期后执行一次） */
    async loadKvMemo(kvBinding) {
        let cache = {};
        let root = {};
        let cacheSnapshot = '{}';
        let rootSnapshot = '{}';

        // 加载主缓存
        try {
            const raw = await kvBinding.get(this.name, 'text', { cacheTtl: 60 });
            if (raw) {
                cache = JSON.parse(raw);
                if (!isPlainObject(cache)) {
                    cache = {};
                }
                cacheSnapshot = raw;
            }
        } catch (e) {
            this.error(`Failed to load cache from KV: ${e.message}`);
            cache = {};
            cacheSnapshot = '{}';
        }

        // 加载根数据
        try {
            const raw = await kvBinding.get('root', 'text', { cacheTtl: 60 });
            if (raw) {
                root = JSON.parse(raw);
                if (!isPlainObject(root)) {
                    root = {};
                }
                rootSnapshot = raw;
            }
        } catch (e) {
            this.error(`Failed to load root from KV: ${e.message}`);
            root = {};
        }

        return {
            at: Date.now(),
            kv: kvBinding,
            cache,
            root,
            cacheSnapshot,
            rootSnapshot,
        };
    }

    // 同步初始化（空操作）
    initCache() {
        // 由 initFromKV 处理
    }

    // 回写缓存到 KV
    async persistCache({ readOnly = false } = {}) {
        if (!this._kvBinding) return;
        // 产物读请求（/download）由调用方显式传 readOnly：本请求不落盘任何 KV
        // （含 console 日志、资源缓存），否则每次下载都会把整个 root（1MB+）
        // JSON.stringify + PUT，直接触发 CPU 1102。
        // 用参数而不是实例标志，避免并发请求之间互相串扰导致管理写被误跳过。
        if (readOnly) {
            this._dirty = false;
            this._rootDirty = false;
            return;
        }
        const promises = [];
        if (this._dirty) {
            const current = JSON.stringify(this.cache, null, 2);
            if (current !== this._cacheSnapshot) {
                promises.push(this._kvBinding.put(this.name, current));
                this._cacheSnapshot = current;
            }
            this._dirty = false;
        }
        if (this._rootDirty) {
            const current = JSON.stringify(this.root, null, 2);
            if (current !== this._rootSnapshot) {
                promises.push(this._kvBinding.put('root', current));
                this._rootSnapshot = current;
            }
            this._rootDirty = false;
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
        // 每次非只读请求结束后都让模块级 memo 指向当前活对象：
        // 覆盖 backup 恢复（$.cache = content 整体替换）等场景，避免 memo 继续指向旧对象。
        kvMemo.cache = this.cache;
        kvMemo.root = this.root;
        kvMemo.cacheSnapshot = this._cacheSnapshot;
        kvMemo.rootSnapshot = this._rootSnapshot;
        kvMemo.kv = this._kvBinding;
    }

    write(data, key) {
        this.log(`SET ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            this.root[key] = data;
            this._rootDirty = true;
        } else {
            this.cache[key] = data;
            this._dirty = true;
        }
        // 请求结束时回写
    }

    read(key) {
        this.log(`READ ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            return this.root[key];
        } else {
            return this.cache[key];
        }
    }

    delete(key) {
        this.log(`DELETE ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            delete this.root[key];
            this._rootDirty = true;
        } else {
            delete this.cache[key];
            this._dirty = true;
        }
    }

    // 通知：日志 + HTTP URL 推送（支持 Bark、Pushover 等）
    notify(title, subtitle = '', content = '', options = {}) {
        const openURL = options['open-url'];
        const mediaURL = options['media-url'];
        const content_ =
            content +
            (openURL ? `\n点击跳转: ${openURL}` : '') +
            (mediaURL ? `\n多媒体: ${mediaURL}` : '');
        console.log(`[Notify] ${title}\n${subtitle}\n${content_}`);

        const push = this.workerEnv?.SUB_STORE_PUSH_SERVICE;
        if (push && /^https?:\/\//.test(push)) {
            const url = push
                .replace('[推送标题]', encodeURIComponent(title || 'Sub-Store'))
                .replace('[推送内容]', encodeURIComponent([subtitle, content_].filter(Boolean).join('\n')));
            const pushPromise = fetch(url)
                .then((resp) => {
                    console.log(`[Push Service] URL: ${url}\nRES: ${resp.status}`);
                })
                .catch((e) => {
                    console.log(`[Push Service] URL: ${url}\nERROR: ${e}`);
                });
            // 收集到 pendingPushes，由 ctx.waitUntil 保证完成
            if (!this.pendingPushes) this.pendingPushes = [];
            this.pendingPushes.push(pushPromise);
        }
    }

    log(msg) {
        if (this.debug) console.log(`[${this.name}] LOG: ${msg}`);
    }

    info(msg) {
        console.log(`[${this.name}] INFO: ${msg}`);
    }

    warn(msg) {
        console.log(`[${this.name}] WARN: ${msg}`);
    }

    error(msg) {
        console.log(`[${this.name}] ERROR: ${msg}`);
    }

    wait(millisec) {
        return new Promise((resolve) => setTimeout(resolve, millisec));
    }

    done(value = {}) {
        // 空操作
    }
}

export function ENV() {
    return {
        isQX,
        isLoon,
        isSurge,
        isNode,
        isStash,
        isShadowRocket,
        isEgern,
        isLanceX,
        isGUIforCores,
        isWorker,
    };
}

export function HTTP(defaultOptions = { baseURL: '' }) {
    const methods = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'PATCH',
    ];
    const URL_REGEX =
        /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

    function send(method, options) {
        options = typeof options === 'string' ? { url: options } : options;
        const baseURL = defaultOptions.baseURL;
        if (baseURL && !URL_REGEX.test(options.url || '')) {
            options.url = baseURL ? baseURL + options.url : options.url;
        }
        options = { ...defaultOptions, ...options };
        const timeout = options.timeout;
        const events = {
            ...{
                onRequest: () => {},
                onResponse: (resp) => resp,
                onTimeout: () => {},
            },
            ...options.events,
        };

        events.onRequest(method, options);

        // 原生 fetch 请求
        const controller = new AbortController();
        const fetchOptions = {
            method: method.toUpperCase(),
            headers: options.headers || {},
            signal: controller.signal,
        };

        if (
            options.body &&
            !['GET', 'HEAD'].includes(method.toUpperCase())
        ) {
            fetchOptions.body =
                typeof options.body === 'string'
                    ? options.body
                    : JSON.stringify(options.body);
        }

        const worker = fetch(options.url, fetchOptions).then(async (resp) => {
            let body;
            if (options.encoding === null) {
                body = await resp.arrayBuffer();
            } else {
                body = await resp.text();
            }
            // 转换响应头
            const headers = {};
            resp.headers.forEach((value, key) => {
                headers[key] = value;
            });
            return {
                statusCode: resp.status,
                headers,
                body,
            };
        });

        let timeoutid;
        const timer = timeout
            ? new Promise((_, reject) => {
                  timeoutid = setTimeout(() => {
                      controller.abort();
                      events.onTimeout();
                      return reject(
                          `${method} URL: ${options.url} exceeds the timeout ${timeout} ms`,
                      );
                  }, timeout);
              })
            : null;

        return (
            timer
                ? Promise.race([timer, worker]).then((res) => {
                      clearTimeout(timeoutid);
                      return res;
                  })
                : worker
        ).then((resp) => events.onResponse(resp));
    }

    const http = {};
    methods.forEach(
        (method) =>
            (http[method.toLowerCase()] = (options) => send(method, options)),
    );
    return http;
}
