#!/usr/bin/env node
/**
 * 用法：node scripts/apply-patches.js [--upstream=<上游 backend/src 目录>]
 *
 * 将 patches/ 下的补丁应用到上游原始文件，输出到 .generated/。
 * 每个 patch 的目标路径取补丁头部的 b/ 路径，源文件为 <upstream>/<路径>。
 * 优先使用 git apply --directory=.generated -p1，失败时回退 patch -p1 --fuzz=3。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(REPO_ROOT, '.generated');
const PATCH_DIR = path.join(REPO_ROOT, 'patches');
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

function readTargetPaths(patchFile) {
    const text = fs.readFileSync(patchFile, 'utf8');
    const lines = text.split(/\r?\n/);
    let oldPath = null;
    let newPath = null;
    for (const line of lines) {
        if (oldPath === null && line.startsWith('--- ')) {
            oldPath = line.slice(4).split('\t')[0].trim();
        } else if (newPath === null && line.startsWith('+++ ')) {
            newPath = line.slice(4).split('\t')[0].trim();
        }
        if (oldPath !== null && newPath !== null) break;
    }
    return { oldPath, newPath };
}

function stripPrefix(p) {
    return p.replace(/^[ab]\//, '');
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

function printFailure(patchName, targetRel, output) {
    console.error(`\n[patch failed] ${patchName}`);
    console.error(`target: .generated/${targetRel}`);

    const failedHunk = output.match(/Hunk #(\d+) FAILED at (\d+)/);
    const targetFile = path.join(GENERATED_DIR, targetRel);
    if (failedHunk && fs.existsSync(targetFile)) {
        const lineNo = parseInt(failedHunk[2], 10);
        const all = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/);
        const start = Math.max(0, lineNo - 1 - 10);
        const end = Math.min(all.length, lineNo + 10);
        console.error(`hunk #${failedHunk[1]} at line ${lineNo}, context:`);
        for (let i = start; i < end; i++) {
            console.error(`${String(i + 1).padStart(6)}: ${all[i]}`);
        }
    } else {
        console.error('no hunk line info; raw output:');
        console.error(output.trim());
    }
}

function main() {
    const { upstream } = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(PATCH_DIR)) {
        console.error(`patches directory not found: ${PATCH_DIR}`);
        process.exit(1);
    }
    if (!fs.existsSync(upstream)) {
        console.error(`upstream source not found: ${upstream}`);
        process.exit(1);
    }

    if (fs.existsSync(GENERATED_DIR)) {
        fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
    }

    const patchFiles = fs
        .readdirSync(PATCH_DIR)
        .filter((f) => f.endsWith('.patch'))
        .sort();

    if (patchFiles.length === 0) {
        console.error(`no *.patch files in ${PATCH_DIR}`);
        process.exit(1);
    }

    const results = [];

    for (const patchName of patchFiles) {
        const patchFile = path.join(PATCH_DIR, patchName);
        const { oldPath, newPath } = readTargetPaths(patchFile);
        if (!oldPath || !newPath) {
            console.error(`[invalid patch] ${patchName}: missing ---/+++ header`);
            process.exit(1);
        }
        if (oldPath === '/dev/null' || newPath === '/dev/null') {
            console.error(`[unsupported] ${patchName}: file creation/deletion patch`);
            process.exit(1);
        }

        const targetRel = stripPrefix(newPath);
        const sourceFile = path.join(upstream, targetRel);
        if (!fs.existsSync(sourceFile)) {
            console.error(`[missing upstream] ${patchName}: ${sourceFile}`);
            process.exit(1);
        }

        const destFile = path.join(GENERATED_DIR, targetRel);
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(sourceFile, destFile);

        const gitResult = run(
            'git',
            ['apply', '--directory=.generated', '-p1', patchFile],
            REPO_ROOT,
        );
        if (gitResult.status === 0) {
            results.push({ patchName, targetRel, status: 'ok (git apply)' });
            continue;
        }

        const patchResult = run(
            'patch',
            ['-p1', '--fuzz=3', '--directory=.generated', '-i', patchFile],
            REPO_ROOT,
        );
        if (patchResult.status === 0) {
            results.push({ patchName, targetRel, status: 'ok (patch fallback)' });
            continue;
        }

        results.push({ patchName, targetRel, status: 'failed' });
        for (const r of results) {
            console.error(`- ${r.patchName}: ${r.status}`);
        }
        printFailure(patchName, targetRel, `${gitResult.stdout}${gitResult.stderr}\n${patchResult.stdout}${patchResult.stderr}`);
        process.exit(1);
    }

    for (const r of results) {
        console.log(`- ${r.patchName} -> .generated/${r.targetRel}: ${r.status}`);
    }
    console.log('All patches applied.');
}

main();