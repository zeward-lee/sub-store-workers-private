#!/usr/bin/env node
/**
 * 用法：node scripts/apply-patches.js [--upstream=<上游 backend/src 目录>] [--verify-only]
 *
 * 将 patches/ 下的补丁应用到上游原始文件，输出到 .generated/。
 * 每个 patch 的目标路径取补丁头部的 b/ 路径，源文件为 <upstream>/<路径>。
 *
 * 严格策略（不允许任何"容错"路径产出成功状态）：
 * - 正式应用只用 git apply --whitespace=nowarn -C1 -p1 --directory=.generated；
 *   应用前先跑不带 -C 的 git apply --check（全部上下文必须精确匹配），
 *   预检失败即失败，杜绝 -C1 容忍上下文偏差后"成功"落地错误内容。
 * - 绝不使用 patch --fuzz 回退（fuzz 会忽略上下文错位并"成功"应用错误内容）。
 * - 任何失败：打印冲突详情 -> 删除 .generated -> exit 1（不留半成品）。
 * - 每次启动先删除 .generated 再重建，杜绝残留。
 * - 生成 .generated/.manifest.json 记录来源；esbuild 侧要求该文件存在。
 * - 应用成功后按 patches/<同名>.features.json 做特征行校验。
 * - 一个 patch 只能对应一个目标文件；同一目标不允许多个 patch。
 *
 * --verify-only：不重新应用，只对现有 .generated 跑特征校验（调试/CI 用）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(REPO_ROOT, '.generated');
const MANIFEST_FILE = path.join(GENERATED_DIR, '.manifest.json');
const PATCH_DIR = path.join(REPO_ROOT, 'patches');
const DEFAULT_UPSTREAM = path.resolve(REPO_ROOT, '..', 'Sub-Store', 'backend', 'src');

/** P2-2：统一按 LF 处理（CRLF / 孤立 CR 都归一为 LF） */
function normalizeEol(text) {
    return text.replace(/\r\n?/g, '\n');
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseArgs(argv) {
    let upstream = DEFAULT_UPSTREAM;
    let verifyOnly = false;
    for (const arg of argv) {
        if (arg.startsWith('--upstream=')) {
            upstream = path.resolve(arg.slice('--upstream='.length));
        } else if (arg === '--verify-only') {
            verifyOnly = true;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    return { upstream, verifyOnly };
}

function stripPrefix(p) {
    return p.replace(/^[ab]\//, '');
}

function cleanPatchPath(raw) {
    // 去掉 git 头部的时间戳后缀
    return raw.split('\t')[0].trim();
}

/** 临时文件管理（归一化后的补丁） */
let tmpRoot = null;
const tmpFiles = [];

function cleanupTemp() {
    for (const f of tmpFiles) {
        try {
            fs.unlinkSync(f);
        } catch {
            /* ignore */
        }
    }
    tmpFiles.length = 0;
    if (tmpRoot) {
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
        tmpRoot = null;
    }
}

function removeGenerated() {
    try {
        fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
    } catch (e) {
        console.error(`[cleanup] failed to remove .generated: ${e.message}`);
    }
}

/** 失败统一出口：可选打印原因 -> 清理 .generated 与临时文件 -> 指定退出码 */
function fail(code, message) {
    if (message) console.error(message);
    removeGenerated();
    cleanupTemp();
    process.exit(code);
}

/**
 * P2-3：扫描补丁里全部 `--- ` / `+++ ` 段；一个 patch 只能对应一个目标文件。
 * 返回目标相对路径（多目标直接 exit 2）。
 */
function readPatchHeader(patchName, text) {
    const lines = text.split('\n');
    const oldPaths = [];
    const newPaths = [];
    for (const line of lines) {
        if (line.startsWith('--- ')) {
            oldPaths.push(cleanPatchPath(line.slice(4)));
        } else if (line.startsWith('+++ ')) {
            newPaths.push(cleanPatchPath(line.slice(4)));
        }
    }
    if (oldPaths.length === 0 || newPaths.length === 0) {
        fail(1, `[invalid patch] ${patchName}: missing ---/+++ header`);
    }
    if (oldPaths.length > 1 || newPaths.length > 1) {
        const all = [...new Set([...oldPaths, ...newPaths].map(stripPrefix))].join(', ');
        fail(
            2,
            `[multi-file patch] ${patchName}: 检测到 ${Math.max(
                oldPaths.length,
                newPaths.length,
            )} 个目标文件（${all}）。一个 patch 只能对应一个目标文件，请拆分。`,
        );
    }
    const oldPath = oldPaths[0];
    const newPath = newPaths[0];
    if (oldPath === '/dev/null' || newPath === '/dev/null') {
        fail(1, `[unsupported] ${patchName}: file creation/deletion patch`);
    }
    if (stripPrefix(oldPath) !== stripPrefix(newPath)) {
        fail(
            1,
            `[invalid patch] ${patchName}: --- 与 +++ 目标不一致（${oldPath} vs ${newPath}）`,
        );
    }
    return stripPrefix(newPath);
}

function run(cmd, args, cwd) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return {
        status: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: res.error,
    };
}

function printApplyFailure(patchName, targetRel, output) {
    console.error(`\n[patch failed] ${patchName}`);
    console.error(`target: .generated/${targetRel}`);
    console.error('git apply output:');
    console.error(output.trim() || '(empty)');

    const failedLine = output.match(/patch failed:.*:(\d+)/);
    const targetFile = path.join(GENERATED_DIR, targetRel);
    if (failedLine && fs.existsSync(targetFile)) {
        const lineNo = parseInt(failedLine[1], 10);
        const all = fs.readFileSync(targetFile, 'utf8').split('\n');
        const start = Math.max(0, lineNo - 1 - 10);
        const end = Math.min(all.length, lineNo + 10);
        console.error(`context around line ${lineNo} of .generated/${targetRel}:`);
        for (let i = start; i < end; i++) {
            console.error(`${String(i + 1).padStart(6)}: ${all[i]}`);
        }
    }
}

/** P2-2：把补丁写成 LF-only 临时文件，避免 CRLF 影响匹配或污染产物 */
function makeNormalizedPatch(patchName, text) {
    if (!tmpRoot) {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'substore-patches-'));
    }
    const tmpFile = path.join(
        tmpRoot,
        `${patchName}.${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.writeFileSync(tmpFile, text, 'utf8');
    tmpFiles.push(tmpFile);
    return tmpFile;
}

function readFeatures(patchName, targetRel) {
    const featuresFile = path.join(
        PATCH_DIR,
        patchName.replace(/\.patch$/, '.features.json'),
    );
    if (!fs.existsSync(featuresFile)) {
        fail(
            1,
            `[missing features] ${patchName}: 缺少 ${path.basename(
                featuresFile,
            )}（每个 patch 必须有特征校验文件）`,
        );
    }
    let features;
    try {
        features = JSON.parse(fs.readFileSync(featuresFile, 'utf8'));
    } catch (e) {
        fail(1, `[invalid features] ${path.basename(featuresFile)}: ${e.message}`);
    }
    if (!features || typeof features !== 'object') {
        fail(1, `[invalid features] ${path.basename(featuresFile)}: 不是对象`);
    }
    if (features.target !== targetRel) {
        fail(
            1,
            `[invalid features] ${path.basename(
                featuresFile,
            )}: target=${JSON.stringify(features.target)} 与补丁目标 ${targetRel} 不一致`,
        );
    }
    const mustContain = features.must_contain || [];
    const mustNotContain = features.must_not_contain || [];
    if (!Array.isArray(mustContain) || !Array.isArray(mustNotContain)) {
        fail(
            1,
            `[invalid features] ${path.basename(
                featuresFile,
            )}: must_contain / must_not_contain 必须是数组`,
        );
    }
    return { mustContain, mustNotContain };
}

/** P1-4：按特征行校验产物内容；不满足即失败（不使用绝对 sha256，避免上游无关改动误报） */
function verifyFeatures(patchName, targetRel, features) {
    const generatedFile = path.join(GENERATED_DIR, targetRel);
    if (!fs.existsSync(generatedFile)) {
        fail(1, `[feature check] ${patchName}: 产物 .generated/${targetRel} 不存在`);
    }
    const content = normalizeEol(fs.readFileSync(generatedFile, 'utf8'));
    const problems = [];
    for (const needle of features.mustContain) {
        if (!content.includes(needle)) {
            problems.push(`must_contain 缺失: ${JSON.stringify(needle)}`);
        }
    }
    for (const needle of features.mustNotContain) {
        if (content.includes(needle)) {
            problems.push(`must_not_contain 命中: ${JSON.stringify(needle)}`);
        }
    }
    if (problems.length > 0) {
        console.error(`\n[feature check failed] ${patchName} -> .generated/${targetRel}`);
        for (const p of problems) console.error(`- ${p}`);
        fail(1, `[feature check failed] ${patchName}: 已清理 .generated。`);
    }
}

function main() {
    const { upstream, verifyOnly } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(PATCH_DIR)) {
        fail(1, `patches directory not found: ${PATCH_DIR}`);
    }

    const patchFiles = fs
        .readdirSync(PATCH_DIR)
        .filter((f) => f.endsWith('.patch'))
        .sort();

    if (patchFiles.length === 0) {
        fail(1, `no *.patch files in ${PATCH_DIR}`);
    }

    // 先读完所有补丁头：多文件检测（exit 2）与同目标重复检测（exit 1）
    const plans = [];
    const targetToPatch = new Map();
    for (const patchName of patchFiles) {
        const patchFile = path.join(PATCH_DIR, patchName);
        const text = normalizeEol(fs.readFileSync(patchFile, 'utf8'));
        const targetRel = readPatchHeader(patchName, text);

        const existing = targetToPatch.get(targetRel);
        if (existing) {
            fail(
                1,
                `[duplicate target] ${patchName} 与 ${existing} 都作用于 ${targetRel}；请合并为一个 patch。`,
            );
        }
        targetToPatch.set(targetRel, patchName);

        plans.push({ patchName, patchFile, text, targetRel });
    }

    if (verifyOnly) {
        if (!fs.existsSync(GENERATED_DIR)) {
            fail(
                1,
                '.generated 不存在，--verify-only 无可校验产物；先跑不带参数的 apply-patches。',
            );
        }
        for (const plan of plans) {
            const features = readFeatures(plan.patchName, plan.targetRel);
            verifyFeatures(plan.patchName, plan.targetRel, features);
            console.log(`- ${plan.patchName} -> .generated/${plan.targetRel}: features ok`);
        }
        cleanupTemp();
        console.log('All feature checks passed (verify-only).');
        return;
    }

    if (!fs.existsSync(upstream)) {
        fail(1, `upstream source not found: ${upstream}`);
    }

    // P1-3：启动即清理，杜绝残留
    removeGenerated();
    fs.mkdirSync(GENERATED_DIR, { recursive: true });

    const manifestItems = [];
    const results = [];

    for (const plan of plans) {
        const { patchName, text, targetRel } = plan;
        const sourceFile = path.join(upstream, targetRel);
        if (!fs.existsSync(sourceFile)) {
            fail(1, `[missing upstream] ${patchName}: ${sourceFile}`);
        }

        // P2-2：源文件按 LF 落地
        const upstreamText = normalizeEol(fs.readFileSync(sourceFile, 'utf8'));
        const destFile = path.join(GENERATED_DIR, targetRel);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.writeFileSync(destFile, upstreamText, 'utf8');

        const normalizedPatch = makeNormalizedPatch(patchName, text);

        const failApply = (output) => {
            results.push({ patchName, targetRel, status: 'failed' });
            for (const r of results.slice(0, -1)) {
                console.error(`- ${r.patchName}: ${r.status}`);
            }
            printApplyFailure(patchName, targetRel, output);
            fail(1, `\n[patch failed] ${patchName}: git apply 失败，已清理 .generated。`);
        };

        // P1-1：先做严格预检（-C 不带参数 = 全部上下文必须精确匹配，零容错）。
        // 预检通过才进入正式应用；正式应用按约定使用 -C1，但上下文已被严格门锁死。
        const strictCheck = run(
            'git',
            [
                'apply',
                '--whitespace=nowarn',
                '-p1',
                '--directory=.generated',
                '--check',
                normalizedPatch,
            ],
            REPO_ROOT,
        );
        if (strictCheck.status !== 0) {
            failApply(`${strictCheck.stdout}${strictCheck.stderr}`);
        }

        const gitResult = run(
            'git',
            [
                'apply',
                '--whitespace=nowarn',
                '-C1',
                '-p1',
                '--directory=.generated',
                normalizedPatch,
            ],
            REPO_ROOT,
        );

        if (gitResult.status !== 0) {
            failApply(`${gitResult.stdout}${gitResult.stderr}`);
        }

        // P2-2：确认产物为 LF
        const generatedText = fs.readFileSync(destFile, 'utf8');
        if (generatedText.includes('\r\n')) {
            fail(
                1,
                `[eol] ${patchName}: 产物 .generated/${targetRel} 含 CRLF，已清理 .generated。`,
            );
        }

        // P1-4：特征校验
        const features = readFeatures(patchName, targetRel);
        verifyFeatures(patchName, targetRel, features);

        manifestItems.push({
            patch: patchName,
            target: targetRel,
            upstreamSha: sha256(upstreamText),
        });
        results.push({ patchName, targetRel, status: 'ok (git apply + features)' });
    }

    // P1-3：写 manifest（esbuild 要求存在才允许使用 .generated）
    const manifest = {
        generatedAt: new Date().toISOString(),
        upstreamRoot: upstream,
        items: manifestItems,
    };
    fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    for (const r of results) {
        console.log(`- ${r.patchName} -> .generated/${r.targetRel}: ${r.status}`);
    }
    console.log(`Manifest: ${path.relative(REPO_ROOT, MANIFEST_FILE)}`);
    console.log('All patches applied.');

    cleanupTemp();
}

main();