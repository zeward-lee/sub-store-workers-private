#!/usr/bin/env node
/**
 * 用法：
 *   node scripts/check-upstream-drift.js [--upstream=<上游 backend/src 目录>]
 *   node scripts/check-upstream-drift.js --update <file> [--update <file> ...] [--upstream=<上游 backend/src 目录>]
 *
 * 检测「无法 patch、只能整文件覆盖」的移植层文件在上游是否发生变更。
 * 记录值来自仓库根的 .upstream-watch.json（git blob SHA）。
 *
 * 检测模式（默认）：
 *   - 用 git hash-object 计算当前上游文件 blob SHA
 *   - 相同 -> ok
 *   - 不同 -> drift，打印提示 + ::warning:: annotation + 写入 GITHUB_STEP_SUMMARY
 *   - 记录值为空/缺失 -> MISSING SHA（单独归类，需 --update）
 *   - git hash-object 失败（spawn 错误/非 0 退出/空输出）-> CHECK ERROR（单独归类，不混入 drift）
 *   - 上游目录缺失 -> ::warning:: annotation + GITHUB_STEP_SUMMARY（可见但不阻断）
 *
 * 更新模式（--update）：
 *   - 计算当前上游 SHA 并回写 .upstream-watch.json（2 空格缩进，结尾换行）
 *   - 打印旧值 -> 新值，可重复 --update 指定多个文件
 *
 * 退出码：检测模式永不阻断（0）；配置结构错误 / --update 失败 以 1 退出。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WATCH_FILE = path.join(REPO_ROOT, '.upstream-watch.json');
const DEFAULT_UPSTREAM = path.resolve(REPO_ROOT, '..', 'Sub-Store', 'backend', 'src');
const SUMMARY_TITLE = '## 移植层上游漂移检测';

function parseArgs(argv) {
    let upstream = DEFAULT_UPSTREAM;
    const updates = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--upstream=')) {
            upstream = path.resolve(arg.slice('--upstream='.length));
        } else if (arg.startsWith('--update=')) {
            updates.push(arg.slice('--update='.length));
        } else if (arg === '--update') {
            const value = argv[i + 1];
            if (!value || value.startsWith('--')) {
                console.error('--update 需要一个文件路径参数');
                process.exit(2);
            }
            updates.push(value);
            i += 1;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }

    const cleaned = updates.map((p) => p.trim()).filter(Boolean);
    if (updates.length > 0 && cleaned.length === 0) {
        console.error('--update 需要一个文件路径参数');
        process.exit(2);
    }

    return { upstream, updates: cleaned };
}

/**
 * 计算上游文件的 git blob SHA。
 * 成功条件：无 spawn 错误 && status === 0 && 有非空 stdout，三者同时满足。
 */
function hashFile(upstream, relPath) {
    const abs = path.join(upstream, relPath);
    if (!fs.existsSync(abs)) {
        return { sha: null, error: 'file not found' };
    }

    const res = spawnSync('git', ['hash-object', relPath], {
        cwd: upstream,
        encoding: 'utf8',
    });

    const stdout = String(res.stdout || '').trim();
    const stderr = String(res.stderr || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(-3)
        .join(' | ');

    if (!res.error && res.status === 0 && stdout) {
        return { sha: stdout, error: null };
    }

    let detail;
    if (res.error) {
        detail = `spawn error: ${res.error.message}`;
    } else if (res.signal) {
        detail = `killed by ${res.signal} (status=${res.status})`;
    } else if (res.status !== 0) {
        detail = `exit ${res.status}${stderr ? `: ${stderr}` : ''}`;
    } else {
        detail = `exit 0 but no output${stderr ? `: ${stderr}` : ''}`;
    }

    return { sha: null, error: `git hash-object failed: ${detail}` };
}

function writeSummary(lines) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    try {
        fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (err) {
        console.error(`failed to write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
}

function warning(message) {
    // GitHub Actions 工作流命令：生成 job 级 warning annotation
    console.log(`::warning::${message}`);
}

/**
 * 读取并校验 watch 文件。返回 { files } 或 null（已打印错误并 exit 1）。
 */
function readWatch() {
    if (!fs.existsSync(WATCH_FILE)) {
        return { missing: true, watch: null };
    }

    let watch;
    try {
        watch = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    } catch (err) {
        console.error(`配置错误：.upstream-watch.json 不是合法 JSON：${err.message}`);
        return { invalid: true, watch: null };
    }

    if (!watch || typeof watch !== 'object' || Array.isArray(watch)) {
        console.error('配置错误：.upstream-watch.json 顶层必须是普通对象');
        return { invalid: true, watch: null };
    }
    if (watch.files === undefined) {
        console.error('配置错误：.upstream-watch.json 缺少 files 字段');
        return { invalid: true, watch: null };
    }
    if (
        watch.files === null ||
        typeof watch.files !== 'object' ||
        Array.isArray(watch.files)
    ) {
        console.error('配置错误：.upstream-watch.json 的 files 必须是普通对象（不能是数组/null）');
        return { invalid: true, watch: null };
    }

    return { watch, files: watch.files };
}

function writeWatch(watch) {
    fs.writeFileSync(WATCH_FILE, `${JSON.stringify(watch, null, 2)}\n`, 'utf8');
}

function runUpdate(upstream, targets) {
    if (!fs.existsSync(upstream)) {
        console.error(`upstream source not found: ${upstream}`);
        console.error('无法写入 SHA：上游源码目录不存在。');
        process.exit(1);
    }

    const loaded = readWatch();
    if (loaded.invalid) process.exit(1);

    const watch = loaded.watch || { files: {} };
    if (!watch.files || typeof watch.files !== 'object' || Array.isArray(watch.files)) {
        watch.files = {};
    }

    let failed = 0;
    for (const relPath of targets) {
        const normalized = relPath.replace(/\\/g, '/');
        const previous = String(watch.files[normalized] || '').trim();
        const { sha, error } = hashFile(upstream, normalized);

        if (error) {
            console.error(`CHECK ERROR: ${normalized} ${error}`);
            warning(`无法计算 ${normalized} 的上游 SHA：${error}`);
            failed += 1;
            continue;
        }

        watch.files[normalized] = sha;
        console.log(`update: ${normalized}: ${previous || '(未记录)'} -> ${sha}`);
    }

    // 有成功项就落盘，保证部分更新可见
    if (failed !== targets.length) {
        writeWatch(watch);
        console.log(`已写入 ${WATCH_FILE}`);
    }
    if (failed > 0) {
        console.error(`${failed} 个文件更新失败。`);
        process.exit(1);
    }

    process.exit(0);
}

function runCheck(upstream) {
    if (!fs.existsSync(upstream)) {
        console.error(`upstream source not found: ${upstream}`);
        warning(`上游源码目录不存在：${upstream}，已跳过移植层漂移检测`);
        writeSummary([
            SUMMARY_TITLE,
            '',
            `> ⚠️ 上游源码目录不存在：\`${upstream}\`，本次跳过检测（不阻断构建）。`,
        ]);
        process.exit(0);
    }

    const loaded = readWatch();
    if (loaded.invalid) {
        process.exit(1);
    }
    if (loaded.missing) {
        console.error(`watch file not found: ${WATCH_FILE}`);
        warning(`.upstream-watch.json 不存在：${WATCH_FILE}，漂移检测被跳过`);
        writeSummary([
            SUMMARY_TITLE,
            '',
            `> ⚠️ \`.upstream-watch.json\` 不存在，本次跳过检测（不阻断构建）。`,
        ]);
        process.exit(0);
    }

    const files = loaded.files;
    const names = Object.keys(files).sort();
    if (names.length === 0) {
        console.log('No files in .upstream-watch.json, nothing to check.');
        process.exit(0);
    }

    const results = [];
    for (const relPath of names) {
        const expected = String(files[relPath] === undefined || files[relPath] === null ? '' : files[relPath]).trim();
        const { sha, error } = hashFile(upstream, relPath);

        if (error) {
            // 取不到当前 SHA：单独归类，绝不能当成“上游变了”
            results.push({ relPath, expected, actual: null, status: 'error', reason: error });
            console.log(`CHECK ERROR: ${relPath} ${error}`);
            warning(`CHECK ERROR: ${relPath} 无法计算上游 SHA：${error}`);
            continue;
        }
        if (!expected) {
            results.push({ relPath, expected: '', actual: sha, status: 'missing', reason: null });
            console.log(`MISSING SHA: ${relPath}，请运行 --update`);
            warning(`MISSING SHA: ${relPath}，请运行 node scripts/check-upstream-drift.js --update ${relPath}`);
            continue;
        }
        if (sha === expected) {
            results.push({ relPath, expected, actual: sha, status: 'ok', reason: null });
            console.log(`ok: ${relPath} (${sha})`);
        } else {
            results.push({ relPath, expected, actual: sha, status: 'drift', reason: null });
            console.log(`DRIFT: ${relPath} 上游已变更，需要人工同步移植层`);
            console.log(`  expected ${expected}`);
            console.log(`  actual   ${sha}`);
            warning(`上游 ${relPath} 已变更，移植层需要人工同步`);
        }
    }

    const drifted = results.filter((r) => r.status === 'drift');
    const errored = results.filter((r) => r.status === 'error');
    const missing = results.filter((r) => r.status === 'missing');

    console.log('');
    console.log('Summary:');
    for (const r of results) {
        console.log(`- ${r.relPath}: ${r.status}`);
    }

    if (drifted.length > 0 || missing.length > 0) {
        console.log('');
        console.log('需要执行：同步移植层 → node scripts/check-upstream-drift.js --update <file> → 提交');
        for (const r of [...drifted, ...missing]) {
            console.log(`  node scripts/check-upstream-drift.js --update ${r.relPath}`);
        }
    }
    if (errored.length > 0) {
        console.log('');
        console.log('检测过程中存在 CHECK ERROR（无法计算上游 SHA），请先修复命令行/git 环境后重跑。');
    }

    const summary = [SUMMARY_TITLE, '', '| 文件 | 状态 | 记录 SHA | 当前 SHA |', '| --- | --- | --- | --- |'];
    for (const r of results) {
        const actual = r.actual || r.reason || '-';
        summary.push(
            `| \`${r.relPath}\` | ${r.status} | \`${r.expected || '-'}\` | \`${actual}\` |`,
        );
    }
    if (drifted.length > 0) {
        summary.push('', `> ⚠️ ${drifted.length} 个文件已被上游修改，需要人工同步移植层（不阻断构建）。`);
    }
    if (missing.length > 0) {
        summary.push('', `> ⚠️ ${missing.length} 个文件缺少记录 SHA，请运行 \`--update\`（不阻断构建）。`);
    }
    if (errored.length > 0) {
        summary.push('', `> ❗ ${errored.length} 个文件检测出错（无法计算上游 SHA），请检查 git 环境后重跑。`);
    }
    if (drifted.length > 0 || missing.length > 0) {
        summary.push(
            '',
            '需要执行：同步移植层 → `node scripts/check-upstream-drift.js --update <file>` → 提交',
        );
    }
    writeSummary(summary);

    if (drifted.length > 0) {
        console.log(`\n${drifted.length} file(s) drifted. Manual port needed (non-blocking).`);
    } else if (missing.length === 0 && errored.length === 0) {
        console.log('\nAll watched files match. No drift.');
    }

    // 永不阻断
    process.exit(0);
}

function main() {
    const { upstream, updates } = parseArgs(process.argv.slice(2));
    if (updates.length > 0) {
        runUpdate(upstream, updates);
        return;
    }
    runCheck(upstream);
}

main();