#!/usr/bin/env node
/**
 * 基线对照器（P2 等价性验证的核心工具）。
 *
 * 用途：证明「把装配器抽成模块」这一步是**行为等价**的——同一批用例，
 * 新旧实现的 `assembled` 必须逐字节一致。任何差异都必须能解释。
 *
 * 用法:
 *   node compare-baseline.mjs <baseA目录> <baseB目录> [--full]
 *     默认只比 assembled；--full 则同时比 context_manifest 的层构成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { noticePrefix } from '../ai/context/layers.mjs';

const [dirA, dirB, ...flags] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error('用法: node compare-baseline.mjs <baseA目录> <baseB目录> [--full] [--ignore-notice]');
  process.exit(2);
}
const full = flags.includes('--full');
// --ignore-notice：比较前把「已按预算截断」提示语归一。
// 用途：P5 起提示语会写明该层**真实可用**的查回工具（不同层工具名不同），
// 这类差异是预期的；用它把「只差提示语」与「正文真的变了」区分开。
const ignoreNotice = flags.includes('--ignore-notice');
// 提示语前缀从层规格派生，而不是在这里手写正则——
// 手写正则踩过字符差异（…、全角括号），导致归一完全没生效却不报错。
const NOTICE_START = noticePrefix();
/**
 * 归一截断提示语。用**括号配对**而不是「找下一个 ）」——
 * 提示语内部还可能再嵌一对括号（如「被截掉的部分当前没有查回路径（已知缺口）」），
 * 早先按首个 ） 截断，会在归一化结果里留下一个多余的 ）从而误判为真实差异。
 */
function normalizeNotice(s) {
  let out = String(s || '');
  if (!ignoreNotice) return out;
  let idx = out.indexOf(NOTICE_START);
  while (idx !== -1) {
    const open = out.indexOf('（', idx);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let k = open; k < out.length; k++) {
      if (out[k] === '（') depth++;
      else if (out[k] === '）') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end === -1) break;
    out = out.slice(0, idx) + '…（截断提示）' + out.slice(end + 1);
    idx = out.indexOf(NOTICE_START, idx + 6);
  }
  return out;
}

const filesOf = (dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json').sort() : [];

const a = filesOf(dirA);
const b = filesOf(dirB);
const all = [...new Set([...a, ...b])].sort();

console.log(`A = ${dirA}  (${a.length} 个用例)`);
console.log(`B = ${dirB}  (${b.length} 个用例)\n`);

let same = 0;
const diffs = [];
const missing = [];

for (const f of all) {
  const pa = path.join(dirA, f);
  const pb = path.join(dirB, f);
  if (!fs.existsSync(pa) || !fs.existsSync(pb)) { missing.push(f); continue; }
  const ja = JSON.parse(fs.readFileSync(pa, 'utf8'));
  const jb = JSON.parse(fs.readFileSync(pb, 'utf8'));

  const rawA = ja.assembled;
  const rawB = jb.assembled;
  if (normalizeNotice(rawA) === normalizeNotice(rawB)) {
    same++;
    if (full) {
      const la = (ja.context_manifest || []).map((m) => `${m.id}:${m.emitted}`).join(',');
      const lb = (jb.context_manifest || []).map((m) => `${m.id}:${m.emitted}`).join(',');
      if (la !== lb) diffs.push({ f, kind: 'manifest', detail: `A=[${la}]\n      B=[${lb}]` });
    }
    continue;
  }

  // 定位首个差异（按归一化后的文本定位，便于看清正文差异）
  const A = normalizeNotice(rawA);
  const B = normalizeNotice(rawB);
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  diffs.push({
    f,
    kind: 'assembled',
    detail: `长度 A=${A.length} B=${B.length}；首个差异在第 ${i} 字符\n      A: …${JSON.stringify(A.slice(Math.max(0, i - 30), i + 60))}\n      B: …${JSON.stringify(B.slice(Math.max(0, i - 30), i + 60))}`,
  });
}

for (const d of diffs) console.log(`  ✗ ${d.f}  [${d.kind}]\n      ${d.detail}`);
for (const m of missing) console.log(`  ? ${m}  （仅一侧存在）`);

console.log(`\n逐字节一致: ${same}/${all.length - missing.length}`);
if (missing.length) console.log(`仅一侧存在: ${missing.length}`);
console.log(diffs.length === 0 && missing.length === 0 ? '\n结论: IDENTICAL（完全一致）' : `\n结论: DIFFERENT（${diffs.length} 处差异）`);
process.exit(diffs.length === 0 && missing.length === 0 ? 0 : 1);
