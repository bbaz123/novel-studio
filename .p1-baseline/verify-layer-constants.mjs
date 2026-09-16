#!/usr/bin/env node
/**
 * verify-layer-constants.mjs —— 层规格常量的**单点来源**核对（零成本、纯静态）。
 *
 * 为什么需要（2026-09-15 自审发现 F8）：`layers.mjs` 声明的 `entityCap: 4000`，
 * 被 `server.js` 又抄了两份——调用处 `buildCharacterCards(sceneCharacters, 4000)`
 * 与函数默认值 `cap = 4000`。规格里只留了一句"改动时要同步"的注释，**没有任何检查**。
 * 后果：改了规格忘了调用处，预算核算（`budgetCapOf` 用 entityCap）就与实际渲染脱节，
 * 而契约 I2 对该层的上界也就成了空话。
 * 同类的还有 `capContinuation: 4000` → 前文衔接的取文长度也另写了一份 4000。
 *
 * ⚠️ 本检查是**定点**的，不是"通用重复常量扫描器"：
 * 它只钉住已知的跨模块耦合，避免把 `plainTextTail(..., 1500)` 这类**与规格无关**的
 * 取文长度误报出来。宁可窄而准，也不要宽而吵——吵的检查最后没人看。
 *
 * 判据：
 *   A. `buildCharacterCards(...)` 调用处不得传数字字面量（必须走 `entityCapOfId`）；
 *   B. `buildCharacterCards` 不得给自己留默认 cap（那会是第三份拷贝）；
 *   C. 前文衔接的取文长度必须来自规格（`capOfId('story_tail','continuation')`），
 *      且不得有等于该值的字面量出现在取文调用里；
 *   D. 规格自洽：entity 层必须有有限 `entityCap`；声明 `capContinuation` 的层必须 ≥ 其 `cap`。
 *
 * 用法: node .p1-baseline/verify-layer-constants.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS, capOfId, entityCapOfId } from '../ai/context/layers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
// 只扫代码行，不扫整行注释（注释里会引用字面量作反面教材——本文件与 server.js 都有）。
const codeLines = serverSrc.split(/\r?\n/)
  .map((l, i) => ({ n: i + 1, t: l }))
  .filter(({ t }) => !t.trim().startsWith('//') && !t.trim().startsWith('*'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};
{ // 断言助手自检（防"签名写错导致恒判通过"）
  let n = 0; const probe = (name, cond) => { if (!cond) n++; }; probe('假条件', false);
  if (n !== 1) { fail++; console.log('  ✗ 断言助手自检失败'); } else { pass++; console.log('  ✓ 断言助手自检：假条件会被计入失败'); }
}

const entityCap = entityCapOfId('characters');
const contCap = capOfId('story_tail', 'continuation');

console.log(`\n规格取值：entityCapOfId('characters')=${entityCap}　capOfId('story_tail','continuation')=${contCap}\n`);

// ── A. 调用处不得传字面量 ──────────────────────────────────────────────
const callRe = /buildCharacterCards\(\s*([^)]*)\)/g;
const callSites = [];
for (const { n, t } of codeLines) {
  // ⚠️ 声明行本身也会匹配这个正则。第一版靠"参数文本恰为 `chars, cap`"来排除，
  // 于是给函数加上默认值（`chars, cap = 4000`）后，声明行被当成了**调用处**报出来——
  // 阴性对照当场暴露了这个脆弱判据。改为直接排除含 `function buildCharacterCards(` 的行。
  if (/function\s+buildCharacterCards\s*\(/.test(t)) continue;
  let m;
  while ((m = callRe.exec(t))) callSites.push({ n, args: m[1] });
}
const realCalls = callSites;
check('A. 找到 buildCharacterCards 的调用处', realCalls.length > 0, `共 ${realCalls.length} 处`);
const literalCalls = realCalls.filter((c) => /,\s*\d+\s*$/.test(c.args));
check('A. 调用处不传数字字面量（必须走单点 entityCapOfId）', literalCalls.length === 0,
  literalCalls.map((c) => `L${c.n}`).join(', '));
check('A. 调用处确实引用了 entityCapOfId', realCalls.every((c) => c.args.includes('entityCapOfId')),
  realCalls.map((c) => `L${c.n}:${c.args.trim()}`).join(' | '));

// ── B. 函数不得自留默认 cap ────────────────────────────────────────────
const decl = codeLines.find(({ t }) => /function\s+buildCharacterCards\s*\(/.test(t));
check('B. buildCharacterCards 存在且有参数表', Boolean(decl), decl ? `L${decl.n}` : '');
check('B. buildCharacterCards 不给自己留默认 cap（否则是第三份拷贝）',
  decl ? !/cap\s*=\s*\d+/.test(decl.t) : false, decl ? decl.t.trim().slice(0, 100) : '');

// ── C. 前文衔接取文长度来自规格 ────────────────────────────────────────
const tailCalls = [];
for (const { n, t } of codeLines) {
  const re = /plainTextTail\([^)]*?,\s*(\d+)\s*\)/g;
  let m; while ((m = re.exec(t))) tailCalls.push({ n, val: Number(m[1]) });
}
const dupTail = tailCalls.filter((c) => c.val === contCap);
check(`C. 没有把 continuation 上限（${contCap}）另写成字面量去取文`, dupTail.length === 0,
  dupTail.map((c) => `L${c.n}`).join(', '));
check("C. server.js 确实从规格取该值（capOfId('story_tail', 'continuation')）",
  /capOfId\(\s*'story_tail'\s*,\s*'continuation'\s*\)/.test(serverSrc));

// ── D. 规格自洽 ────────────────────────────────────────────────────────
const entityLayers = LAYERS.filter((l) => l.kind === 'entity');
check('D. 每个 entity 层都声明了有限的 entityCap',
  entityLayers.every((l) => Number.isFinite(l.entityCap)),
  entityLayers.map((l) => `${l.id}=${l.entityCap}`).join(', '));
const contLayers = LAYERS.filter((l) => l.capContinuation != null);
check('D. 声明 capContinuation 的层，其 continuation 上限 ≥ 常规 cap',
  contLayers.every((l) => l.capContinuation >= l.cap),
  contLayers.map((l) => `${l.id}: ${l.cap}→${l.capContinuation}`).join(', '));

console.log(`\n══════════════════════════════`);
console.log(`层规格常量单点核对：通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
