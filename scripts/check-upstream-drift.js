#!/usr/bin/env node
/**
 * 用法：node scripts/check-upstream-drift.js [--upstream=<上游 backend/src 目录>]
 *
 * 检测「无法 patch、只能整文件覆盖」的移植层文件在上游是否发生变更。
 * 记录值来自仓库根的 .upstream-watch.json（git blob SHA）。
 *
 * 每个文件：
 *   - 用 git hash-object 计算当前上游文件 blob SHA
 *   - 与记录值相同 -> ok
 *   - 不同或文件缺失 -> drift，打印提示并写入 GITHUB_STEP_SUMMARY（若存在）
 *
 * 注意：本脚本只做告警，不阻断构建，任何情况下都以 0 退出。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WATCH_FILE = path.join(REPO_ROOT, '.upstream-watch.json');
const DEFAULT_UPSTREAM = path.resolve(REPO_ROOT, '..', 'Sub-Store', 'backend', 'src');

function parseArgs(argv) {
    let upstream = DEFAULT_UPSTREAM;
    for (const arg of argv) {
        if (arg.startsWith('--upstream=')) {
            upstream = path.resolve(arg.slice('--upstream='.length));
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    return { upstream };
}

function hashFile(upstream, relPath) {
    const abs = path.join(upstream, relPath);
    if (!fs.existsSync(abs)) {
        return { sha: null, error: 'file not found' };
    }
    const res = spawnSync('git', ['hash-object', relPath], {
        cwd: upstream,
        encoding: 'utf8',
    });
    if (res.error) {
        return { sha: null, error: res.error.message };
    }
    if (res.status !== 0) {
        return {
            sha: null,
            error: (res.stderr || res.stdout || '').trim() || `git hash-object exited ${res.status}`,
        };
    }
    return { sha: res.stdout.trim(), error: null };
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

function main() {
    const { upstream } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(WATCH_FILE)) {
        console.error(`watch file not found: ${WATCH_FILE}`);
        process.exit(0);
    }
    if (!fs.existsSync(upstream)) {
        console.error(`upstream source not found: ${upstream}`);
        process.exit(0);
    }

    let watch;
    try {
        watch = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
    } catch (err) {
        console.error(`invalid .upstream-watch.json: ${err.message}`);
        process.exit(0);
    }

    const files = watch && typeof watch.files === 'object' && watch.files ? watch.files : {};
    const names = Object.keys(files).sort();

    if (names.length === 0) {
        console.log('No files in .upstream-watch.json, nothing to check.');
        process.exit(0);
    }

    const results = [];
    for (const relPath of names) {
        const expected = String(files[relPath] || '').trim();
        const { sha, error } = hashFile(upstream, relPath);

        if (error) {
            results.push({ relPath, expected, actual: null, status: 'drift', reason: error });
            console.log(`DRIFT: ${relPath} 上游已变更，需要人工同步移植层 (${error})`);
            continue;
        }
        if (sha === expected) {
            results.push({ relPath, expected, actual: sha, status: 'ok', reason: null });
            console.log(`ok: ${relPath} (${sha})`);
        } else {
            results.push({ relPath, expected, actual: sha, status: 'drift', reason: null });
            console.log(`DRIFT: ${relPath} 上游已变更，需要人工同步移植层`);
            console.log(`  expected ${expected || '(none)'}`);
            console.log(`  actual   ${sha}`);
        }
    }

    const drifted = results.filter((r) => r.status === 'drift');
    console.log('');
    console.log('Summary:');
    for (const r of results) {
        console.log(`- ${r.relPath}: ${r.status}`);
    }

    const summary = ['## 移植层上游漂移检测', '', '| 文件 | 状态 | 记录 SHA | 当前 SHA |', '| --- | --- | --- | --- |'];
    for (const r of results) {
        const mark = r.status === 'ok' ? 'ok' : 'drift';
        summary.push(
            `| \`${r.relPath}\` | ${mark} | \`${r.expected || '-'}\` | \`${r.actual || r.reason || '-'}\` |`,
        );
    }
    if (drifted.length > 0) {
        summary.push('', `> ⚠️ ${drifted.length} 个文件已被上游修改，需要人工同步移植层（不阻断构建）。`);
    }
    writeSummary(summary);

    if (drifted.length > 0) {
        console.log(`\n${drifted.length} file(s) drifted. Manual port needed (non-blocking).`);
    } else {
        console.log('\nAll watched files match. No drift.');
    }

    // 永不阻断
    process.exit(0);
}

main();