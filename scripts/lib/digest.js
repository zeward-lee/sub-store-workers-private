#!/usr/bin/env node
/**
 * patches 内容摘要（P1-4）
 *
 * apply-patches.js 写 manifest 时记录该摘要；esbuild.js 在命中 .generated
 * 之前重算并与 manifest 比对，不一致即判定 .generated 过期，拒绝构建。
 *
 * 规则：patches/ 下所有 .patch 与 .features.json，按文件名排序，
 * 逐个取 sha256(文件内容)，把这些十六进制串按序拼接后再取一次 sha256。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 计算 patches 目录的内容摘要（十六进制） */
function computePatchesDigest(patchDir) {
    if (!fs.existsSync(patchDir) || !fs.statSync(patchDir).isDirectory()) {
        throw new Error(`patches directory not found: ${patchDir}`);
    }
    const files = fs
        .readdirSync(patchDir)
        .filter((f) => f.endsWith('.patch') || f.endsWith('.features.json'))
        .sort();
    if (files.length === 0) {
        throw new Error(`no *.patch / *.features.json files in ${patchDir}`);
    }
    const perFile = files.map((f) =>
        sha256(fs.readFileSync(path.join(patchDir, f))),
    );
    return sha256(Buffer.from(perFile.join(''), 'utf8'));
}

module.exports = { computePatchesDigest, sha256 };