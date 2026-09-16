#!/usr/bin/env node
/**
 * check-utf8.mjs —— 扫描仓库里所有文本文件，找出"不是合法 UTF-8"的（混编码/GBK 残留）。
 *
 * 由来：本轮自审发现 .p1-baseline/.gitignore 被 Add-Content（PS 5.1 默认 GBK）
 * 写成了 UTF-8/GBK 混编，连 `read` 工具都报 invalid UTF-8。
 * 这类损坏 git 不会报错（git 按字节存储），只能靠解码扫出来。
 * 用法: node .p1-baseline/check-utf8.mjs [根目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const EXTS = ['.mjs', '.js', '.md', '.yml', '.yaml', '.json', '.ts', '.html', '.css', '.txt'];
const SKIP = ['node_modules', '.git', 'data', 'gate-data', 'stress-data', 'suite-data', '.rehearsal', '.verify', '.blind', '.exp-settings', '.revert-matrix'];

let bad = 0, total = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.includes(e.name)) continue;
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXTS.includes(path.extname(e.name))) continue;
    total++;
    const buf = fs.readFileSync(p);
    // 严格 UTF-8 校验：TextDecoder 默认非致命会替换坏字节；用 fatal:true 试一遍。
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      bad++;
      console.log(`  ✗ ${p}（非法 UTF-8，${buf.length} 字节）`);
    }
  }
};
walk(ROOT);
console.log(`\n扫描 ${total} 个文本文件，非法 UTF-8：${bad} 个。`);
process.exitCode = bad ? 1 : 0;
