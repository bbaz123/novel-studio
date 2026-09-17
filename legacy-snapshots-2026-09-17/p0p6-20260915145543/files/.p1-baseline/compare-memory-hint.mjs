#!/usr/bin/env node
/**
 * compare-memory-hint.mjs —— 对照两套基线，要求差异**恰好**是长期记忆压缩提示的挪位。
 *
 * 背景（自审发现 F6）：装配器按 cap **从头部**截断，而长期记忆无界增长；
 * 压缩提示原先拼在正文末尾 → 记忆越长越会被自己截掉。修法是把提示挪到正文开头。
 * 这是一个**刻意的行为变更**，于是「当前输出与 P1 基线逐字节一致」不再成立——
 * 但它不该变成"随便怎么变都行"。本工具把差异**精确刻画**成一条等式：
 *
 *   post === pre.slice(0,i) + H + pre.slice(i, i+W-|H|) + pre.slice(i+W)
 *
 *   P = 层标题等前缀（i = |P|）　H = 提示块（含其后换行）　W = 该层 manifest.emitted（窗口）
 *
 * 等式成立 ⇔「总长不变」+「只有这一处连续替换」+「代价 = 窗口让出 |H| 字」。
 * 任何其它漂移都会让它失败——所以它比"看起来一样"更强。
 *
 * 用法:
 *   node .p1-baseline/compare-memory-hint.mjs <参照目录> <当前目录> [--quiet]
 *   node .p1-baseline/compare-memory-hint.mjs .p1-baseline/baselines-p3 .p1-baseline/baselines-p5
 */
import fs from 'node:fs';
import path from 'node:path';

const [dirA, dirB] = process.argv.slice(2);
const QUIET = process.argv.includes('--quiet');
if (!dirA || !dirB) { console.error('用法: compare-memory-hint.mjs <参照目录> <当前目录> [--quiet]'); process.exit(2); }

const LAYER = '长期记忆';
const HINT_RX = /^（⚠ 记忆已 \d+ 字，超过 \d+ 字压缩提示线，收尾时请优先用 novel_memory_update 压缩合并）\r?\n/;

/** 取长期记忆层在装配结果里的窗口长度（manifest.emitted），以及提示块。 */
export function characterize(preText, postText, windowLen) {
  if (preText === postText) return { kind: 'unchanged' };
  let i = 0;
  while (i < Math.min(preText.length, postText.length) && preText[i] === postText[i]) i++;
  const H = (postText.slice(i).match(HINT_RX) || [''])[0];
  const L = H.length;
  const W = Number(windowLen) || 0;
  if (!W || !L) return { kind: 'unexpected', i, L, W, reason: W ? '提示块没在前缀处' : '拿不到层窗口长度' };
  const exact = preText.length === postText.length
    && postText === preText.slice(0, i) + H + preText.slice(i, i + W - L) + preText.slice(i + W);
  return exact
    ? { kind: 'hint-moved', i, L, W, costPct: (L / W * 100) }
    : { kind: 'unexpected', i, L, W, reason: '不满足刻画等式' };
}

const winOf = (j) => Number((j.context_manifest || j.manifest || []).find((m) => String(m.label).includes(LAYER))?.emitted) || 0;

const files = fs.readdirSync(dirA).filter((f) => f.endsWith('.json') && f !== 'summary.json').sort();
let unchanged = 0, moved = 0, bad = 0;
const details = [];
let costSample = null;
for (const f of files) {
  const pb = path.join(dirB, f);
  if (!fs.existsSync(pb)) { bad++; details.push([f, '✗ 当前目录缺此用例']); continue; }
  const ja = JSON.parse(fs.readFileSync(path.join(dirA, f), 'utf8'));
  const jb = JSON.parse(fs.readFileSync(pb, 'utf8'));
  const r = characterize(String(ja.assembled ?? ''), String(jb.assembled ?? ''), winOf(ja));
  if (r.kind === 'unchanged') unchanged++;
  else if (r.kind === 'hint-moved') {
    moved++;
    if (!costSample) costSample = r;
    details.push([f, `✓ 仅提示挪位：窗口 ${r.W} 字让出 ${r.L} 字（${r.costPct.toFixed(1)}%），总长不变`]);
  } else { bad++; details.push([f, `✗ 预期外的差异：${r.reason}（i=${r.i} L=${r.L} W=${r.W}）`]); }
}

if (!QUIET) {
  console.log(`参照 ${dirA}`);
  console.log(`当前 ${dirB}\n`);
  for (const [f, note] of details) console.log(`  ${note.startsWith('✓') ? '' : ''}${f.padEnd(32)} ${note}`);
  console.log('');
}
console.log(`逐用例：完全未变 ${unchanged}　仅提示挪位 ${moved}　异常 ${bad}（共 ${files.length}）`);
if (costSample) {
  console.log(`代价：含提示的用例里，记忆层窗口让出 ${costSample.L} 字（${costSample.costPct.toFixed(1)}%），总长不变；`);
  console.log(`      被挤掉的部分可经 novel_memory_read 查回（层内截断提示已给出工具名，I4 成立）。`);
}
console.log(bad ? '结论: ✗ 出现了刻画之外的差异' : '结论: ✓ 差异恰好是长期记忆压缩提示的挪位');
process.exitCode = bad ? 1 : 0;
