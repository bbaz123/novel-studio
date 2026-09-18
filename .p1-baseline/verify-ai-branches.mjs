#!/usr/bin/env node
/**
 * AI 全分支核对表（P4 验收工具）。
 *
 * 起因：2026-09-13 的复盘里有一条硬教训——
 *   「改模型/通道路由，必须把**全部分支**（主路径 + 每个回退分支）一起核对，
 *     并在注释里写明回退分支用的模型；共享回退分支即使极少触发也要注明。」
 * 当时正是因为只核对了主路径、漏了共享回退分支，注释与实现才不符。
 *
 * 本工具做两件事：
 *   1) **清点**所有 AI 调用点的模型/强度取值（file:line + 原样表达式），
 *      让「主路径与每个回退分支各用什么」一眼可见，不需要通读代码；
 *   2) **查违规**：模型名只允许出现在 ai/policy.mjs；调用点必须经
 *      policyModel()/resolveModel() 解析，不得写死模型字面量。
 *
 * 允许的例外（会在报告里显式列出，不静默放过）：
 *   - ai/policy.mjs 自身（策略真源）
 *   - 面向用户的模型下拉列表（用户要给自己的 API 配置选模型）
 *   - policy 未就绪时的兜底常量（DEFAULT_AI_MODEL / QUALITY_AI_MODEL）
 *
 * 用法: node verify-ai-branches.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODELS, EFFORTS, PIPELINE_EFFORT_BY_MODE } from '../ai/policy.mjs';

// 扫描清单。**db.js 是 2026-09-18 补进来的**：它此前把 'deepseek-flash' 写死在建表默认值与
// 迁移 SQL 里，而清单里没有它 → 工具永远报"0 处绕过"，改分工时那两处会静默留在旧名上。
// 现在 db.js 从 ai/policy.mjs 取模型名（测试 test-policy-tiers.mjs 会钉住这一点）。
const FILES = ['public/app.js', 'server.js', 'harness.js', 'db.js'];

/** 允许出现模型字面量的行（人工确认过的例外，逐条列出原因）。 */
const ALLOWED_LITERAL_LINES = [
  { file: 'public/app.js', match: /const (DEFAULT|QUALITY)_AI_MODEL = /, why: '策略未就绪时的兜底常量' },
  { file: 'public/app.js', match: /\['deepseek-/, why: '面向用户的模型下拉列表' },
  { file: 'public/app.js', match: /modelSelectHtml\(/, why: '下拉默认值（用户 API 配置，非策略）' },
];

// 只匹配**模型名**形态的字面量。早先写成 /deepseek-[a-z0-9.-]+/ 会把
// 'deepseek-harness'（目录名）误报为模型——已收紧到已知模型名集合。
const MODEL_LITERAL_RE = /['"`](deepseek-(?:flash|v4-pro|v4-flash|v4-flash-vision-exp|chat|reasoner))['"`]/gi;
/** 调用点的模型取值：`model: <expr>`，取到行尾逗号为止。 */
const MODEL_ASSIGN_RE = /model:\s*([^,\n]+)/g;
/** 强度取值。 */
const EFFORT_ASSIGN_RE = /(?:reasoning_effort|reasoningEffort):\s*([^,\n]+)/g;

const rows = [];
const violations = [];
const allowed = [];

for (const rel of FILES) {
  const abs = path.resolve(rel);
  if (!fs.existsSync(abs)) { violations.push(`缺少文件 ${rel}`); continue; }
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // ── 调用点的模型取值 ────────────────────────────────────────────
    for (const m of trimmed.matchAll(MODEL_ASSIGN_RE)) {
      const expr = m[1].trim();
      rows.push({ file: rel, line: lineNo, kind: 'model', expr });
    }
    // ── 调用点的强度取值 ────────────────────────────────────────────
    for (const m of trimmed.matchAll(EFFORT_ASSIGN_RE)) {
      const expr = m[1].trim();
      rows.push({ file: rel, line: lineNo, kind: 'effort', expr });
    }
    // ── 模型字面量 ──────────────────────────────────────────────────
    const lit = [...trimmed.matchAll(MODEL_LITERAL_RE)].map((x) => x[1]);
    if (!lit.length) return;
    const exception = ALLOWED_LITERAL_LINES.find((a) => a.file === rel && a.match.test(trimmed));
    if (exception) allowed.push({ file: rel, line: lineNo, lit: lit.join(','), why: exception.why, text: trimmed.slice(0, 90) });
    else violations.push({ file: rel, line: lineNo, lit: lit.join(','), text: trimmed.slice(0, 110) });
  });
}

// ── 报告 ─────────────────────────────────────────────────────────────
console.log('═══ 策略真源（ai/policy.mjs）═══');
console.log(`  模型档位      : ${Object.entries(MODELS).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`  思考强度白名单: ${EFFORTS.join(' | ')}`);
console.log(`  工作台档位→强度: ${Object.entries(PIPELINE_EFFORT_BY_MODE).map(([k, v]) => `${k}=${v}`).join('  ')}`);

console.log(`\n═══ AI 调用点的模型/强度取值（${rows.length} 处）═══`);
const byFile = new Map();
for (const r of rows) {
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file).push(r);
}
for (const [file, list] of byFile) {
  console.log(`\n  ── ${file}（${list.length} 处）`);
  for (const r of list) {
    // 只有「表达式里含模型字面量」才是问题；其余是变量透传（options.model / okModel 等）
    const hasLiteral = /deepseek-(?:flash|v4-pro|v4-flash)/.test(r.expr);
    console.log(`   ${hasLiteral ? '✗' : '·'} ${String(r.line).padStart(5)}  ${r.kind === 'model' ? '模型' : '强度'}  ${r.expr.slice(0, 70)}`);
  }
}

console.log(`\n═══ 允许的模型字面量例外（${allowed.length} 处）═══`);
for (const a of allowed) console.log(`   ${a.file}:${a.line}  [${a.lit}]  ${a.why}`);

console.log(`\n═══ 绕过策略的模型字面量（${violations.length} 处）═══`);
for (const v of violations) console.log(`   ✗ ${v.file}:${v.line}  [${v.lit}]  ${v.text}`);

const ok = violations.length === 0;
console.log(`\n结论: ${ok ? '✓ 所有模型取值都经 policy.mjs 解析（无散落字面量）' : `✗ ${violations.length} 处绕过策略`}`);
console.log('\n提醒（人工核对项，工具无法判定）：');
console.log('  · 每个回退分支用的模型是否与主路径一致、注释是否写明？');
console.log('  · 共享回退分支（如直连失败回退 harness）是否被单独核对过？');
process.exitCode = ok ? 0 : 1;
