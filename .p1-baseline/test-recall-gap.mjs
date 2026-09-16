#!/usr/bin/env node
/**
 * test-recall-gap.mjs —— 决策 D8-#5 的离线单测（零成本）。
 *
 * 被验证的行为：**语义召回层不可用时不得静默消失**。
 * 修复前：`status !== 'ok'` 时该层直接不存在——模型不知道自己本该有一层召回。
 * 修复后：期望有召回却没拿到时，往上下文插一层**显式占位**（说明缺什么、为什么、怎么自取），
 * 且两个响应端点报告同一判据。
 *
 * 这里钉三件事：
 *   1. 判据真值表（哪些状态算缺口、哪些不算）；
 *   2. **阴性对照（变异测试）**：把判据换成修复前的行为，同一张表必须判它失败——
 *      否则这张表根本区分不出对错，等于没测；
 *   3. 接线：三个使用点（装配 + 两个端点）都用同一个来源，没有各写一份 if。
 *
 * 用法: node .p1-baseline/test-recall-gap.mjs
 */
import fs from 'node:fs';
import { recallGapReason, RECALL_GAP_CN } from '../ai/context/layers.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

/** 期望表：输入 → 是否构成缺口。 */
const CASES = [
  ['检索成功（ok）', { enabled: true, status: 'ok' }, false],
  ['应召回却没命中（no-hits）', { enabled: true, status: 'no-hits' }, true],
  ['记忆服务不可用（unavailable）', { enabled: true, status: 'unavailable' }, true],
  ['检索过程出错（error）', { enabled: true, status: 'error' }, true],
  ['配置主动停用（disabled）', { enabled: false, status: 'disabled' }, false],
  ['查询为空（empty）', { enabled: true, status: 'empty' }, false],
  ['未接入（null）', null, false],
  ['未知状态', { enabled: true, status: 'something-new' }, false],
];

console.log('【1. 缺口判据真值表】');
for (const [name, input, expectGap] of CASES) {
  const reason = recallGapReason(input);
  ok(`${name} → ${expectGap ? '算缺口' : '不算缺口'}`,
    expectGap ? reason.length > 0 : reason === '',
    `reason=${JSON.stringify(reason)}`);
}
ok('每条缺口原因都有可读文案（不是布尔值充数）',
  Object.values(RECALL_GAP_CN).every((s) => typeof s === 'string' && s.length >= 6),
  JSON.stringify(RECALL_GAP_CN));

console.log('\n【2. 阴性对照（变异测试）：把判据换回修复前的行为，这张表必须判它失败】');
{
  // 修复前的行为：只要 enabled 且 status !== 'ok' 就算缺口（于是 disabled/empty 也会被插占位）。
  const mutant = (r) => (r && r.enabled === true && r.status !== 'ok') ? '（缺口）' : '';
  const disagreements = CASES.filter(([, input, expectGap]) => (mutant(input).length > 0) !== expectGap);
  ok('变异体与期望表存在分歧（说明这张表确实能区分对错）',
    disagreements.length > 0,
    `分歧 ${disagreements.length} 处：${disagreements.map((d) => d[0]).join('、')}`);
  ok('分歧点正是「disabled / empty 不该算缺口」这条设计决定',
    disagreements.some((d) => /disabled|empty/.test(d[0])),
    disagreements.map((d) => d[0]).join('、'));

  // 第二个变异体：永远返回空 —— 那就是"静默消失"的老毛病，必须被抓住。
  const silent = () => '';
  const silentMissed = CASES.filter(([, input, expectGap]) => expectGap && silent(input) === '');
  ok('变异体「永远静默」被抓住（3 个应报缺口的状态全部漏报）',
    silentMissed.length === 3, `漏报 ${silentMissed.length} 处`);
}

console.log('\n【3. 接线：三个使用点同源（不允许各写一份 if）】');
{
  const src = fs.readFileSync('server.js', 'utf8');
  const layers = fs.readFileSync('ai/context/layers.mjs', 'utf8');
  ok('判据定义在内核模块（可离线单测），不在 server.js 里另起一份',
    /export function recallGapReason/.test(layers) && !/function recallGapReason/.test(src));
  ok('server.js 从内核模块导入它',
    /import \{[^}]*recallGapReason[^}]*\} from '\.\/ai\/context\/layers\.mjs'/.test(src));
  ok('装配时用它决定是否插占位层',
    /recallGapText \? L\('recall', recallGapText\)/.test(src));
  const uses = (src.match(/recallGapReason\(/g) || []).length;
  ok('两个响应端点都调用了同一个判据（导入行之外出现 2 次以上）', uses >= 2, `出现 ${uses} 次`);
  ok('两个端点都回传 gap / gap_reason（界面不能只靠 status 猜）',
    (src.match(/gap_reason:/g) || []).length >= 2);
}

console.log(`\n══════════════════════════════`);
console.log(`召回缺口离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
