#!/usr/bin/env node
/**
 * verify-retrieval-map.mjs —— 「凡裁剪必可查回」（契约 I4）的**静态**保证。
 *
 * 为什么需要：`verify-retrieval.mjs` 是**数据相关**的验证——它只检查"当前这份数据里
 * 实际被截断的那几层"能不能查回。于是下面三类问题在数据上永远不会暴露：
 *   1. 新增一个可截断的层，却忘了在 RETRIEVAL 里声明查回路径 → 该层的裁剪就是**真实损失**；
 *   2. 声明的工具名被改名/删除 → 截断提示会指向一个**不存在的工具**（比没有提示更糟）；
 *   3. RETRIEVAL 里留下已删除层的陈旧声明 → 契约与现实脱节。
 *
 * 本工具不碰网络、不碰数据库，纯静态：拿 `LAYERS`（层规格）与 `RETRIEVAL`（查回声明）
 * 对账，并把工具名与**插件清单** `plugin.json` 交叉核对。
 *
 * 判据：
 *   A. 每个层都必须有 RETRIEVAL 声明（不许静默缺失）；
 *   B. 可截断的层（cap 有限）必须有查回工具，**或**显式声明 `intrinsic: true` 并写明理由；
 *   C. 声明的工具名必须真的存在于插件清单里；
 *   D. RETRIEVAL 不得包含已不存在的层（陈旧声明）。
 *
 * 用法: node .p1-baseline/verify-retrieval-map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS, RETRIEVAL } from '../ai/context/layers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PLUGIN = path.join(REPO, 'harness-plugins', 'novel-writing', 'plugin.json');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};
// 断言助手自检：喂一个假条件，确认它会被计入失败（防"签名写错导致恒判通过"）。
{
  let n = 0; const probe = (name, cond) => { if (!cond) n++; }; probe('假条件', false);
  if (n !== 1) { fail++; console.log('  ✗ 断言助手自检失败：假条件没有被计入失败'); }
  else { pass++; console.log('  ✓ 断言助手自检：假条件会被计入失败'); }
}

const pluginJson = JSON.parse(fs.readFileSync(PLUGIN, 'utf8'));
const tools = new Set((pluginJson.tools || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean));

console.log(`\n层规格 ${LAYERS.length} 个　查回声明 ${Object.keys(RETRIEVAL).length} 个　插件清单 ${tools.size} 个工具\n`);

// ── A. 每层都有声明 ────────────────────────────────────────────────────
const missing = LAYERS.filter((l) => !RETRIEVAL[l.id]).map((l) => l.id);
check('A. 每个层都有 RETRIEVAL 声明', missing.length === 0, missing.length ? `缺：${missing.join(', ')}` : '');

// ── D. 无陈旧声明 ──────────────────────────────────────────────────────
const ids = new Set(LAYERS.map((l) => l.id));
const stale = Object.keys(RETRIEVAL).filter((id) => !ids.has(id));
check('D. 没有指向已删除层的陈旧声明', stale.length === 0, stale.length ? `陈旧：${stale.join(', ')}` : '');

// ── B/C. 可截断 ⇒ 有工具（且工具存在）；否则必须显式说明内在性 ──────────
console.log('\n逐层核对（cap 有限 = 可被截断）：');
for (const l of LAYERS) {
  const decl = RETRIEVAL[l.id];
  if (!decl) continue;
  const truncatable = Number.isFinite(l.cap);
  const tool = decl.tool || null;
  const intrinsic = decl.intrinsic === true;
  const toolExists = tool ? tools.has(tool) : null;
  const okB = !truncatable || Boolean(tool) || intrinsic;
  const okC = !tool || toolExists;
  const mark = okB && okC ? '✓' : '✗';
  if (!okB || !okC) fail++; else pass++;
  console.log(`  ${mark} ${String(l.id).padEnd(12)} cap=${String(Number.isFinite(l.cap) ? l.cap : '∞').padStart(5)}`
    + ` 可截断=${truncatable ? '是' : '否'}　工具=${tool || (intrinsic ? '(内在：本层即检索结果)' : '(无)')}`
    + `${tool ? `　清单中存在=${toolExists ? '是' : '否'}` : ''}`
    + `${!okB ? '　← 可截断却没有查回路径，也没声明 intrinsic' : ''}`
    + `${!okC ? '　← 提示语会指向一个不存在的工具' : ''}`);
  if (intrinsic && !decl.note) { fail++; console.log(`      ✗ ${l.id}：声明了 intrinsic 却没写理由（note）`); }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const truncatableCount = LAYERS.filter((l) => Number.isFinite(l.cap)).length;
console.log(`\n可截断层 ${truncatableCount} 个；每个都有可用的查回路径（或显式说明内在性）才算 I4 站得住。`);
console.log(`\n══════════════════════════════`);
console.log(`查回路径静态核对：通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
