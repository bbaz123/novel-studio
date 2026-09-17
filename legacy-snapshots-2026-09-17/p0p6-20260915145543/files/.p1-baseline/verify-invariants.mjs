#!/usr/bin/env node
/**
 * 契约不变量校验器（P2 验收工具）。
 *
 * 读取基线快照里的 `context_manifest` / `context_stats` / `assembled`，
 * 逐条校验 docs/context-contract.md 的不变量。
 *
 * 可离线校验的（免费、可回归）：
 *   I1  装配结果 ≤ 总预算；超限必须有 overflow 标记（不静默）
 *   I2  cap 是正文硬上界：正文采用量 ≤ cap；渲染占用 ≤ 标题+cap+提示语
 *   I3  零损失层（kind=fixed）**不参与收敛收缩**（它们的 cap 必须始终等于规格里的 cap）
 *   I7  可复现：各层占用之和 + 层间分隔 == assembled 长度
 *
 * 不可离线校验的：I4「凡裁剪必可查回」需要检索侧断言（P3）。
 * 但本工具会输出 **I4 工作清单**：哪些层被裁掉了多少字——那些就是必须能查回的内容。
 *
 * ⚠️ I3 的口径澄清：零损失层**不参与收敛收缩**，但它们仍受自身 cap 约束（会被截断）。
 *    「收缩」与「截断」是两件事：前者是总预算压不下时的逐档下调，后者是单层上限。
 *    本工具早先把两者混为一谈，误报了 48 处——已修正。
 *
 * 用法: node verify-invariants.mjs <基线目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import { LAYERS, FLEX_ORDER, headerOf, capOf, noticeSampleLength } from '../ai/context/layers.mjs';

const dir = process.argv[2];
if (!dir) { console.error('用法: node verify-invariants.mjs <基线目录>'); process.exit(2); }

// 提示语长度的上界**从层规格派生**，不在这里手写：
// 早先这里用 truncationNotice(N) 单参调用（那时提示语还没带工具名），P5 给提示语加上
// 「可用哪个工具查回」后，上界被算小，误报 45 处 I2 违反——校验器必须跟着规格走。
const NOTICE_LEN = noticeSampleLength();
const NOTICE_TOLERANCE = 6; // 真实提示语里的数字位数会有浮动
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json').sort();

const violations = [];
const notes = [];
/** 零损失审计：layerId -> { label, cases, dropped } */
const lossAudit = new Map();
let checked = 0;

// ── I3 静态部分：收缩顺序里只能出现 flex 层 ─────────────────────────────
for (const id of FLEX_ORDER) {
  const spec = LAYERS.find((l) => l.id === id);
  if (!spec) violations.push(`[I3-静态] FLEX_ORDER 里的 id=${id} 在层规格中不存在`);
  else if (spec.kind !== 'flex') violations.push(`[I3-静态] FLEX_ORDER 里的 ${id} 不是 flex 层（kind=${spec.kind}）—— 零损失层被拉进收缩链`);
}

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!j.context_manifest) { notes.push(`${f}: 无 context_manifest（非 /api/novel/context 响应）`); continue; }
  checked++;
  const m = j.context_manifest;
  const st = j.context_stats;
  const assembled = j.assembled || '';
  const mode = j.mode || 'full';

  // I1 预算上界 + 溢出必须显式
  if (assembled.length > st.budget && !j.context_overflow) {
    violations.push(`[I1] ${f}: 长度 ${assembled.length} > 预算 ${st.budget} 但没有 overflow 标记`);
  }
  if (j.context_overflow && assembled.length <= st.budget) {
    violations.push(`[I1] ${f}: 有 overflow 标记但长度未超预算`);
  }

  for (const layer of m) {
    const spec = LAYERS.find((l) => l.id === layer.id);
    if (!spec) { violations.push(`[I2] ${f}: manifest 出现未知层 id=${layer.id}`); continue; }
    const cap = capOf(spec, mode);

    // I2 正文硬上界
    if (Number.isFinite(cap) && layer.emitted > cap) {
      violations.push(`[I2] ${f}/${layer.label}: 正文采用 ${layer.emitted} > cap ${cap}`);
    }
    const bound = headerOf(spec.label).length + (Number.isFinite(cap) ? cap : layer.emitted)
      + (layer.truncated ? NOTICE_LEN + NOTICE_TOLERANCE : 0);
    if (Number.isFinite(cap) && !spec.entityCap && layer.renderedLength > bound) {
      violations.push(`[I2] ${f}/${layer.label}: 渲染占用 ${layer.renderedLength} > 核算上界 ${bound}`);
    }

    // I3 逐例：fixed 层的 cap 必须仍是规格里的 cap（若被收敛链压过，会变成 FLEX_CAPS 的档位值）
    if (layer.kind === 'fixed' && layer.declaredCap !== null && Number.isFinite(cap) && layer.declaredCap !== cap) {
      violations.push(`[I3] ${f}/${layer.label}: 零损失层的 cap 被改成 ${layer.declaredCap}（规格为 ${cap}）`);
    }

    // I4 工作清单：任何被裁掉正文的层都要登记
    if (layer.dropped > 0) {
      const cur = lossAudit.get(layer.id) || { label: layer.label, kind: layer.kind, cases: 0, dropped: 0, maxDropped: 0 };
      cur.cases += 1;
      cur.dropped += layer.dropped;
      cur.maxDropped = Math.max(cur.maxDropped, layer.dropped);
      lossAudit.set(layer.id, cur);
    }
  }

  // I7 自洽
  const sumRendered = m.reduce((n, l) => n + l.renderedLength, 0);
  const expected = sumRendered + Math.max(0, m.length - 1) * 2;
  if (expected !== assembled.length) {
    violations.push(`[I7] ${f}: 各层占用之和+分隔 = ${expected}，assembled = ${assembled.length}`);
  }

  if (j.context_overflow) notes.push(`${f}: ⚠ 出现 overflow（压到下限仍超预算）`);
}

console.log(`校验目录: ${dir}`);
console.log(`用例数: ${checked}（跳过 ${files.length - checked}）\n`);

if (violations.length) {
  console.log(`✗ 违反 ${violations.length} 处：`);
  for (const v of violations.slice(0, 30)) console.log('   ' + v);
  if (violations.length > 30) console.log(`   …（其余 ${violations.length - 30} 处省略）`);
} else {
  console.log('✓ I1 预算上界 / I2 cap 硬上界 / I3 零损失层未被收缩 / I7 清单自洽：全部成立');
}

if (lossAudit.size) {
  console.log(`\n── I4 工作清单（被裁掉正文的层 → 这些内容必须能通过工具查回）──`);
  const rows = [...lossAudit.entries()].sort((a, b) => b[1].dropped - a[1].dropped);
  for (const [id, v] of rows) {
    console.log(`   ${id.padEnd(12)} ${v.kind.padEnd(6)} 出现 ${String(v.cases).padStart(2)} 次，累计裁掉 ${String(v.dropped).padStart(7)} 字（单次最多 ${v.maxDropped}）  ${v.label}`);
  }
  const fixedLoss = rows.filter(([, v]) => v.kind === 'fixed');
  if (fixedLoss.length) {
    console.log(`\n   ⚠ 其中 ${fixedLoss.length} 个是**零损失层**（${fixedLoss.map(([id]) => id).join(', ')}）——`);
    console.log(`     它们被自身 cap 截断，而契约 I4 要求「凡裁剪必可查回」；P3 必须为这些层建可查回路径。`);
  }
}

if (notes.length) {
  console.log(`\n观察（非违规）：`);
  for (const n of notes.slice(0, 12)) console.log('   ' + n);
}
process.exit(violations.length ? 1 : 0);
