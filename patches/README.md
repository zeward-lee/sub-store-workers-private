# patches/ 维护指南

本目录存放「上游 Sub-Store 文件 + 少量 Workers 适配」的补丁。构建时 `scripts/apply-patches.js` 把这里的补丁应用到 `../Sub-Store/backend/src/` 的原件上，产物写入 `.generated/`（已 gitignore），`@/` 解析优先命中 `.generated/`。

## 现有补丁

| 补丁 | 目标 | 作用 |
|---|---|---|
| `core-app.patch` | `core/app.js` | 去掉 `import 'fastestsmallesttextencoderdecoder'`（Workers 不需要该 polyfill），改为使用本项目 `@/vendor/open-api` 的 OpenAPI |
| `token.patch` | `restful/token.js` | Workers 适配：① 去掉 Node `require('nanoid')` 分支，直接走 Web Crypto / `customAlphabet`；② 移除上游「非 Node 环境禁止签发 token」的拦截；③ 重复 token 改为**幂等覆盖**（先删旧再建新），规避 KV `cacheTtl` 导致前端 DELETE+POST 读到旧数据 |

每个补丁都必须配一个同名 `.features.json`（见下）。

## 严格策略（脚本强制）

- 一个 patch 只能对应**一个目标文件**；多目标、`/dev/null` 增删文件、`---`/`+++` 路径不一致都会直接失败。
- `git apply` 参数固定为 `apply --whitespace=nowarn -p1 --directory=.generated`，**不带 `-C`**：所有 context 行必须精确匹配，不做 fuzz。
- 预检 `--check` 与正式应用共用同一组参数，作用在同一份 `.generated` 副本上。
- 应用前会先把上游原件写入 `.generated/<target>` 并做 sha256 一致性断言；应用后校验产物为 LF（含 CRLF 即失败）。
- 任一步失败：打印冲突上下文 → 删除整个 `.generated/` → `exit 1`。不会留下半成品。
- 成功后写 `.generated/.manifest.json`，`patchesDigest` 覆盖 `patches/` 下全部 `.patch` 与 `.features.json`；esbuild 命中 `.generated` 前会重算该摘要，不一致即拒绝构建。

## 生成 / 更新补丁

以 `core-app.patch` 为例，先手工把 `.generated/<target>` 调到期望结果，再基于新的上游原文件生成：

```bash
# 1. 确保 .generated 是干净的上游副本（失败也没关系，主要是拿到上游原文件）
node scripts/apply-patches.js

# 2. 用编辑器把 .generated/core/app.js 改到期望状态

# 3. 基于上游原文件生成补丁，路径头固定 a/ 与 b/
cd /path/to/parent   # Sub-Store 与 sub-store-workers 的父目录
diff -u Sub-Store/backend/src/core/app.js sub-store-workers/.generated/core/app.js \
  | sed -e '1s|.*|--- a/core/app.js|' -e '2s|.*|+++ b/core/app.js|' \
  > sub-store-workers/patches/core-app.patch
```

> 补丁文件必须是 LF 换行；Windows 下用 Git Bash / `sed` 生成可避免 CRLF。
> 不要手工编辑 `@@` 行号：直接用 `diff -u` 产生，git 会按 context 精确校验。

## features.json 格式与约束

```json
{
  "target": "core/app.js",
  "must_contain": ["new OpenAPI('sub-store')"],
  "must_not_contain": ["fastestsmallesttextencoderdecoder"]
}
```

| 字段 | 约束 |
|---|---|
| `target` | 必填，必须与补丁的 `+++ b/` 路径完全一致 |
| `must_contain` | 必填，**必须是非空数组**（至少一个正向锚点）。产物缺任一项即失败——防止补丁"应用成功"但实际没改到目标内容 |
| `must_not_contain` | 可选数组。产物中出现任一项即失败——通常填被删掉的上游代码特征 |

锚点要选**补丁带来的**、且上游稳定存在的短字符串（函数名、关键调用、固定注释），不要选整行大段代码，也不要选上游迟早会改的文案。

## 失败排查

### 1. apply 失败（`[patch failed]`）

```
[patch failed] core-app.patch
target: .generated/core/app.js
git apply output:
error: patch failed: core/app.js:1
```

原因：上游改了补丁涉及的行，context 对不上。
处理：`cd Sub-Store && git pull` → 按上面「生成 / 更新补丁」基于新上游重新生成 → 更新 `features.json` 锚点 → 本地 `node scripts/apply-patches.js` + `npm run build` 验证。

### 2. 特征校验失败（`[feature check failed]`）

```
[feature check failed] token.patch -> .generated/restful/token.js
- must_contain 缺失: "consumeShareTokenForRequest"
```

原因：补丁应用成功了，但产物没有期望特征（多半是上游重命名了函数/变量）。
处理：确认 `.generated/<target>` 的实际内容是否符合预期。符合 → 更新 `features.json` 锚点为新名称；不符合 → 修补丁重新生成。

### 3. manifest stale（`[stale .generated]`）

```
[stale .generated] patches 已变更，请先运行 node scripts/apply-patches.js
```

原因：改了 `patches/` 但没重新应用，`.generated/` 还是旧产物。
处理：`node scripts/apply-patches.js`（或直接 `npm run build`，`prebuild` 会自动跑）。

## 维护约束

**补丁产物的目标文件里不能出现 `eval(require(...))` 之类的动态 `eval` 写法。**

- 原因：`esbuild.js` 的 `evalRewritePlugin`（`onLoad` 过滤 `.js`，开头即 `if (!args.path.startsWith(ORIGINAL_SRC)) return null`）**只改写上游原文件**，不处理 `.generated/` 下的补丁产物。补丁产物里保留这类写法，会原样进入 bundle，在 Workers 运行时直接抛错（Workers 禁止运行时 `eval` / `new Function`）。
- 现状无影响：`token.patch` 已删除上游原来的 `eval(require("nanoid"))` 分支，改走 Web Crypto / `customAlphabet`。
- 上游未来若在补丁目标文件中新增同类写法，**必须在补丁里同步移除或改写**，不能指望构建时的 eval 重写兜底——它是按路径白名单生效的，`.generated/` 不在其中。

## 常用命令

```bash
node scripts/apply-patches.js                 # 重新应用全部补丁
node scripts/apply-patches.js --verify-only   # 不重应用，只校验现有产物的特征锚点
npm run build                                 # prebuild 自动应用 + 校验，然后 bundle
```