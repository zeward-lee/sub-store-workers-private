# Sub-Store Workers 项目总图

> 生成时间: 2026-04-23 15:11（最近更新: 2026-11-23）
> 项目: sub-store-workers
> 类型: project-level codemap

## 1. 项目定位

将 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 后端从 Node.js 移植到 Cloudflare Workers 运行时。**仅替换平台相关层，核心业务逻辑零修改**（构建时从 `../Sub-Store/backend/src/` 引入）。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│              Cloudflare Workers Runtime              │
│                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │ index.js │──▶│ express.js   │──▶│ 上游 restful │ │
│  │  入口     │   │ 路由适配层    │   │ 路由处理器    │ │
│  └────┬─────┘   └──────────────┘   └──────────────┘ │
│       │                                              │
│  ┌────▼─────┐   ┌──────────────┐   ┌──────────────┐ │
│  │open-api  │──▶│ KV Namespace │   │ esbuild.js   │ │
│  │存储适配层 │   │ (持久化)      │   │ 构建桥接      │ │
│  └──────────┘   └──────────────┘   └──────────────┘ │
└─────────────────────────────────────────────────────┘
```

## 3. 文件清单与职责

### 3.1 平台适配层（`src/`，本项目自有）

| 文件 | 职责 |
|---|---|
| `src/index.js` | **Workers 入口**（对应上游 `main.js` 的 43 行启动脚本，不参与 patch）：CORS 预检、KV 绑定校验、路径前缀鉴权（含未配置警告头）、KV 初始化、路由分发、Cron 定时同步 |
| `src/vendor/express.js` | **Express 适配**：将 Workers fetch handler 适配为类 Express 的 req/res 路由 |
| `src/vendor/open-api.js` | **OpenAPI 适配**：KV 替代 fs 存储、fetch 替代 undici、日志/通知/推送 |
| `src/vendor/quickjs-executor.js` | **QuickJS 脚本沙箱**：替代上游 `new Function()` 执行用户脚本（Script Operator/Filter），支持 func / nodeFunc / content 三种模式，详见 4.5 |
| `src/vendor/quickjs-timeout.js` | **脚本时间预算中断器**：deadline 式 `setInterruptHandler`，替代旧的指令计数式超时（避免跨脚本残余计数误杀） |
| `src/vendor/quickjs.wasm` | QuickJS 引擎二进制，由 Wrangler 作为原生 WASM module 上传 |
| `src/vendor/geoip-czdb.js` | **脚本内 GeoIP**：从节点提取 IP 字面量，批量查 czdb 接口后注入同步 `geoip.lookup()`；`GEOIP_CZDB_BASE` 可覆盖或置 `off` 关闭 |
| `src/vendor/x-cache.js` | **`/download` 下载缓存层**：Cache API + KV 双层（含 stale-on-error 兜底）、自学习预热清单、"保存即作废"失效机制 |
| `src/utils/env.js` | 环境检测变量，`backend = 'Workers'`，`isWorker = true`（**整文件覆盖**） |
| `src/restful/miscs.js` | 工具 API：`/api/utils/env`（暴露 `SUB_STORE_*` 给前端）、`/api/utils/worker-status`（KV/鉴权/能力诊断）、Gist 备份/还原、存储管理、刷新（**整文件覆盖**） |

> `src/core/app.js`、`src/restful/token.js` **已不在 `src/` 中**：它们由 `patches/` 基于上游原件打补丁后生成到 `.generated/`，详见 4.3。

### 3.2 构建层

| 文件 | 职责 |
|---|---|
| `esbuild.js` | **构建脚本**：4 个 esbuild 插件桥接 Workers 与上游源码；同时把上游 `createDynamicFunction` 替换为 QuickJS 沙箱执行（`SCRIPT_ENGINE=disabled` 可关闭） |
| `wrangler.toml.example` | Workers 部署配置模板：KV 绑定、Cron、环境变量（路径密码推荐改用 Worker Secret）。仓库不提交 `wrangler.toml`，部署前需 `cp wrangler.toml.example wrangler.toml` 并填 KV ID |
| `package.json` | 依赖与脚本（`deploy`、`deploy:pages`、`rotate-secret`、`rotate-secret:sh`） |

### 3.3 运维脚本（`scripts/`）

| 文件 | 职责 |
|---|---|
| `scripts/rotate-secret.ps1` | Windows PowerShell：生成随机 URL-safe 密码，通过管道写入 Cloudflare Worker Secret `SUB_STORE_FRONTEND_BACKEND_PATH`，并复制到剪贴板 |
| `scripts/rotate-secret.sh` | Linux/macOS Bash：同上，自动选择 `pbcopy`/`wl-copy`/`xclip`/`xsel` |
| `scripts/apply-patches.js` | 把 `patches/*.patch` 应用到上游原件，生成 `.generated/` 与 `.manifest.json`；支持 `--upstream=<dir>`、`--verify-only` |
| `scripts/check-upstream-drift.js` | 整文件覆盖层的上游漂移检测（git blob SHA 对比 `.upstream-watch.json`）；`--update <file>` 回写记录，检测模式永不阻断 |
| `scripts/lib/digest.js` | 计算 `patches/` 内容摘要 `patchesDigest`，供 apply-patches 写 manifest、esbuild 判定 `.generated` 是否过期 |
| `scripts/test-geoip-czdb.mjs` | `src/vendor/geoip-czdb.js` 的运行时单测（fake fetch/env） |
| `scripts/test-quickjs-timeout.mjs` | `src/vendor/quickjs-timeout.js` 的时间预算中断器单测 |
| `scripts/test-x-cache.mjs` | `src/vendor/x-cache.js` 下载缓存层单测（fake Cache API / KV / fetch） |

### 3.4 上游源码（构建时引入，`../Sub-Store/backend/src/`）

通过 esbuild `@/` 别名解析，**三级顺序**：

```
@/xxx → .generated/xxx（上游原件 + patches 结果）
      → src/xxx（本项目整文件覆盖）
      → ../Sub-Store/backend/src/xxx（上游原始文件）
```

命中 `.generated/` 前，esbuild 会校验 `.generated/.manifest.json` 存在且其 `patchesDigest` 与当前 `patches/` 内容摘要一致；manifest 缺失、无法解析或摘要不同即 `exit 1`，防止用过期产物构建。

关键上游模块：
- `restful/subscriptions` — 订阅 CRUD
- `restful/collections` — 组合订阅
- `restful/artifacts` — 制品生成 + Gist 同步
- `restful/download` / `restful/preview` — 分享链接（公开 API）
- `core/proxy-utils/` — 代理协议解析（Surge/Loon/QX peggy 语法）
- `utils/migration` — 数据迁移

## 4. 核心流程

### 4.1 HTTP 请求处理

```
Browser → fetch()
  │
  ├─ OPTIONS → 返回 CORS headers
  │
  ├─ KV 绑定校验（缺失 SUB_STORE_DATA → 500 明确错误）
  │
  ├─ 路径前缀鉴权（可选）
  │   ├─ 未配置 SUB_STORE_FRONTEND_BACKEND_PATH 且访问 /api/*
  │   │     → 控制台警告 + 响应头 X-Sub-Store-Security-Warning
  │   ├─ 已配置时：/api/* 无前缀 → 401
  │   ├─ /backendPath 精确 → 302 重定向
  │   └─ /backendPath/... → 剥离前缀
  │
  ├─ $.initFromKV(KV) → 加载缓存
  ├─ migrate() → 数据迁移
  ├─ $app.handleRequest(request) → Express 路由分发
  │   ├─ 中间件链
  │   ├─ dispatchRoute() → 最长匹配路由
  │   └─ 404 兜底
  │
  └─ ctx.waitUntil($.persistCache()) → 回写 KV
```

### 4.2 Cron 定时同步

```
scheduled() → cronSyncArtifacts()
  ├─ 检查 GitHub Token / artifacts
  ├─ 预生成订阅缓存（并行）
  ├─ 生成所有 artifacts（并行）
  ├─ syncToGist(files)
  ├─ 更新 artifact URL
  ├─ gistBackupAction('upload')
  └─ $.persistCache()
```

### 4.3 补丁层与漂移检测

上游有四个文件需要适配，但策略不同：

| 目标 | 策略 | 存放位置 |
|---|---|---|
| `core/app.js` | 补丁（去掉 polyfill import） | `patches/core-app.patch` → `.generated/core/app.js` |
| `restful/token.js` | 补丁（Workers 签 token + 重复 token 幂等覆盖） | `patches/token.patch` → `.generated/restful/token.js` |
| `restful/miscs.js`、`utils/env.js` | 整文件覆盖 | `src/` |

```
npm run build
  └─ prebuild: node scripts/apply-patches.js
       ├─ 清空 .generated/ 并重建
       ├─ 逐 patch：上游原件 → .generated/<target>（sha256 一致性断言）
       ├─ git apply --check（与正式应用共用 APPLY_ARGS，不带 -C / 无 fuzz）
       ├─ git apply 正式应用 → 校验产物 LF
       ├─ 特征校验 patches/<同名>.features.json（must_contain 必须非空）
       └─ 写 .generated/.manifest.json（patchesDigest）
  └─ esbuild：命中 .generated 前校验 manifest 与 patchesDigest
```

失败路径：任一环节不满足即**清空 `.generated/` 并 `exit 1`**，构建中止（不会静默使用旧版/错误产物）。整文件覆盖层另由 `scripts/check-upstream-drift.js` 每日检测（不阻断构建），漂移后用 `--update <file>` 回写 `.upstream-watch.json`。完整 SOP 见 [`patches/README.md`](../../patches/README.md) 与 README「补丁层与上游同步」。

### 4.4 esbuild 构建管线

```
esbuild.js
  ├─ aliasPlugin: @/ → .generated/（校验 manifest）→ src/ → 上游 src/
  ├─ peggyPrecompilePlugin: PEG 语法 → 预编译 JS 解析器
  ├─ evalRewritePlugin: eval() → Workers 兼容替换
  └─ nodeStubPlugin: Node 模块 → Proxy 存根
```

### 4.5 QuickJS 脚本执行（Script Operator/Filter）

上游用 `new Function()` 动态执行用户脚本，Workers 禁止运行时代码生成，改用 QuickJS WASM 沙箱（`src/vendor/quickjs-executor.js`）。按输入类型分三种模式：

```
createScriptFunction(script, name)
  ├─ func 模式：IIFE 包裹脚本 → 返回 function operator/filter → 调用
  ├─ 失败且输入是节点数组 → nodeFunc 模式：快捷脚本逐 $server 遍历
  └─ 失败且输入含 $content/$files（文件/覆写场景） → content 模式：
       ├─ mihomoConfig/mihomoProfile 文件：沙箱内取脚本的 main 函数，
       │    宿主侧 YAML 解析 $content → main(config) → YAML 序列化回 $content
       │    （YAML 在宿主侧处理，因沙箱内无 ProxyUtils）
       └─ 其他文件：注入 $content/$files 全局变量直接执行脚本，回读结果
```

> 背景：早期实现缺少 content 模式，$content 输入被当作节点数组遍历（对象无
> length，循环不执行），导致 convert.js 类覆写脚本不报错但输出空配置。

## 5. 数据存储

- **KV Key: `sub-store`** — 主缓存（订阅/组合/设置/tokens/artifacts）
- **KV Key: `root`** — 根数据
- **写入策略**：请求结束时 `persistCache()` 对比 snapshot，变化才写（防止无意义写入）
- **读取策略**：`cacheTtl: 60` 秒边缘缓存

## 6. 安全机制

- **路径前缀鉴权**：`SUB_STORE_FRONTEND_BACKEND_PATH`，**推荐用 Cloudflare Worker Secret 存放**（`wrangler secret put` 或 `npm run rotate-secret`），不要写在 `wrangler.toml [vars]` 里——后者明文存仓库且会被 `wrangler deploy` 覆盖同名 Secret。
- **未配置鉴权告警**：未配置时管理 API 访问会输出控制台警告并附加响应头 `X-Sub-Store-Security-Warning`，提醒部署者尽快设置密码。
- **公开路径白名单**：`/api/download`、`/api/preview`、`/api/sub/flow` 不受鉴权限制
- **CORS**：全局 `Access-Control-Allow-Origin: *`
- **Script Operator 沙箱化**：构建期改写 `createDynamicFunction` 为 QuickJS WASM 沙箱执行（内存/栈/指令数限制），避免 `eval`/`new Function`；可用 `SCRIPT_ENGINE=disabled` 关闭。
- **状态自检**：`/api/utils/worker-status` 输出 KV 绑定、鉴权、能力降级（脚本/socks/本地文件系统/cron）等运行时信息，方便部署后快速验证。

## 7. 外部依赖

| 依赖 | 用途 |
|---|---|
| `peggy` | PEG 语法编译（构建时） |
| `js-base64` | Base64 编解码 |
| `nanoid` | Token 生成 |
| `ms` | 时间字符串解析 |
| `lodash` | 工具函数 |
| `ip-address` | IP 地址处理 |
| `static-js-yaml` | YAML 解析 |
| `esbuild` | 构建（dev） |
| `wrangler` | 部署 CLI（dev） |

## 8. 已知风险与注意事项

1. **并发安全**：Workers 无状态但 `$.cache` 是全局 in-memory 对象，高并发下可能 read-modify-write 竞争
2. **KV 最终一致性**：KV 读有 60s cacheTtl，写入后可能延迟可见
3. **上游兼容性**：上游 Sub-Store 更新可能引入 Node-only API，需要构建时通过存根或适配处理
4. **CPU 时限**：Workers 免费版 10ms CPU / 请求，复杂订阅处理可能超时
5. **全局状态污染**：`globalThis.__workerEnv` 在并发请求间共享，理论上存在竞态
6. **Pages 与 Workers 配置不互通**：`wrangler.toml` 的 `[vars]`/`[[kv_namespaces]]` 不影响 Pages 项目，需要在 Cloudflare Dashboard 单独绑定 KV 与设置 `SUB_STORE_FRONTEND_BACKEND_PATH`（建议设为 Pages Secret）。
7. **`[vars]` 与 Worker Secret 同名冲突**：若同时存在，`wrangler deploy` 会用 `[vars]` 明文覆盖 Secret，破坏 CI Secret 管理流程；只用其中一种。
8. **路径密码不可恢复**：Worker Secret 在 Dashboard 看不到原文，遗忘只能通过 `npm run rotate-secret` 重置。
