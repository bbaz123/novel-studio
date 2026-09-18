#!/usr/bin/env node
/**
 * test-policy-tiers.mjs —— 模型档位/思考强度/长任务超时的**离线**单元测试。
 *
 * 为什么需要它（2026-09-18 决策）：
 *   用户决定把质量档从 `deepseek-v4-pro` 统一为 **V4.1 Flash**（`deepseek-flash`），
 *   并把「质量优先」改由**思考强度**表达（`EFFORT_BY_TIER.quality = 'high'`）。
 *   这个改动有两个"静默失败"面，必须钉住：
 *     ① 两档模型悄悄不一致（有人把 quality 改回 pro）→ 用户会以为统一了，其实没有；
 *     ② 强度补偿丢了（删掉 EFFORT_BY_TIER 或调用点不再传）→ 质量档退化成"和快档一样"，
 *        而这**不会报错**，只会让审稿/修稿/压缩变差。
 *   两类都属于"看起来在做事、实际被短路"，靠肉眼看注释发现不了。
 *
 * 另外两条来自本项目既有教训：
 *   - `db.js` 曾把模型名写成字面量，而 `verify-ai-branches` 的扫描清单只有三个文件 →
 *     工具永远报"0 处绕过"。这里断言 db.js 是**引用策略表**而不是抄名字。
 *   - 手写清单必然漏项：所以本测试的检查项从源码/模块**派生**（读 db.js 源、读 server.js 的
 *     超时上限），而不是把期望值再抄一遍。
 *
 * 只读、零依赖、不联网、不碰任何实例。用法：node .p1-baseline/test-policy-tiers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
}

// 断言助手自检：签名写错会让条件恒判通过，而输出里只会多一个突兀的 true（记在 OpenViking 的 F7 条）。
{
  const before = failures;
  const realLog = console.log;
  console.log = () => {};
  check('__selfcheck__', false);
  console.log = realLog;
  const caught = failures === before + 1;
  failures = before;
  check('T0 断言助手自检：假条件会被计入失败', caught);
}

const P = await import('file:///' + path.join(ROOT, 'ai/policy.mjs').replace(/\\/g, '/'));
const { MODELS, KNOWN_DEEPSEEK_MODELS, EFFORT_BY_TIER, effortForTier, LONG_AI_TIMEOUT_MS, policySnapshot } = P;

console.log('\n== A. 两档模型统一为 V4.1 Flash ==');
check('A1 fast 档 = deepseek-flash（V4.1 Flash）', MODELS.fast === 'deepseek-flash', MODELS.fast);
check('A2 quality 档 = deepseek-flash（2026-09-18 决策：不再是 v4-pro）', MODELS.quality === 'deepseek-flash', MODELS.quality);
check('A3 两档取值相同（"统一"这件事本身）', MODELS.fast === MODELS.quality, `${MODELS.fast} / ${MODELS.quality}`);
check('A4 已知模型表里没有重复项（否则下拉框会出现两个同 value 选项）',
  new Set(KNOWN_DEEPSEEK_MODELS).size === KNOWN_DEEPSEEK_MODELS.length, KNOWN_DEEPSEEK_MODELS.join(','));
check('A5 旧名 deepseek-v4-pro 仍在已知表内（存量配置要能正确归一）',
  KNOWN_DEEPSEEK_MODELS.includes('deepseek-v4-pro'), KNOWN_DEEPSEEK_MODELS.join(','));

console.log('\n== B. 质量优先改由思考强度表达 ==');
check('B1 quality 档有强度补偿（不是空串）', EFFORT_BY_TIER.quality === 'high', JSON.stringify(EFFORT_BY_TIER));
check('B2 fast 档仍不指定强度（保持改动前行为）', EFFORT_BY_TIER.fast === '', JSON.stringify(EFFORT_BY_TIER.fast));
check('B3 effortForTier(quality) 与表一致', effortForTier('quality') === EFFORT_BY_TIER.quality, effortForTier('quality'));
check('B4 effortForTier 对未知档位返回空串（不抛错）', effortForTier('nope') === '', JSON.stringify(effortForTier('nope')));
check('B5 快照把强度表下发给前端（否则前端无法补偿）',
  policySnapshot().effort_by_tier && policySnapshot().effort_by_tier.quality === 'high', JSON.stringify(policySnapshot().effort_by_tier));

console.log('\n== C. 长任务超时（③）==');
check('C1 统一超时为 30 分钟', LONG_AI_TIMEOUT_MS === 30 * 60 * 1000, `${LONG_AI_TIMEOUT_MS}ms`);
check('C2 快照下发该值', policySnapshot().long_ai_timeout_ms === LONG_AI_TIMEOUT_MS);
// 上限与默认值都从 server.js 派生（不把 60 分钟/30 分钟再抄一遍）
const srvSrc = read('server.js');
const clampLine = srvSrc.split('\n').find((l) => /Math\.min\(Math\.max\(1000/.test(l)) || '';
const clampMatch = /,\s*([0-9]+(?:\s*\*\s*[0-9]+)+)\s*\)/.exec(clampLine.trim());
const clampMs = clampMatch ? clampMatch[1].split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1) : NaN;
check('C3 服务端作业超时上限 ≥ 统一超时（否则会被 clamp 悄悄截短）',
  Number.isFinite(clampMs) && clampMs >= LONG_AI_TIMEOUT_MS, `clamp=${clampMs}ms (${clampMs / 60000} 分钟) 行=${clampLine.trim().slice(0, 70)}`);
check('C3b 服务端"未传 timeout"的默认值也同源（不是另一个 10 分钟字面量）',
  (srvSrc.match(/Number\(body\.timeout\) \|\| LONG_AI_TIMEOUT_MS/g) || []).length === 2
  && !/Number\(body\.timeout\) \|\| 10 \* 60 \* 1000/.test(srvSrc),
  (srvSrc.match(/Number\(body\.timeout\) \|\| LONG_AI_TIMEOUT_MS/g) || []).length + ' 处同源');
const frontSrc = read('public/app.js');
check('C4 前端不再残留 timeout: 600000 的字面量',
  !/timeout:\s*600000/.test(frontSrc), (frontSrc.match(/timeout:\s*600000/g) || []).length + ' 处');
check('C5 前端统一走 longAiTimeout()', /function longAiTimeout\(/.test(frontSrc) && (frontSrc.match(/longAiTimeout\(\)/g) || []).length >= 8,
  (frontSrc.match(/longAiTimeout\(\)/g) || []).length + ' 处');

console.log('\n== D. db.js 引用策略表而不是抄模型名 ==');
// ⚠️ D1–D4 是**接线（源码形状）断言**，不是行为断言——独立复核指出这与
// 「test-harness-env 把形状断言改成语义断言」的教训相悖。保留它们的理由：
// 它们钉的是"以后改分工时，别把清单又抄回 SQL 里"，这一层用形状判据最便宜；
// 代价是**等价重构会假红**（例如把 DDL 默认值改成 resolveModel('fast')）。
// 已知缺口（交付说明里如实标注，未修）：**迁移本身没有自动化行为断言**——
// 「两次独立进程重开库 → 旧模型名被改写」目前是人工实测（见 README 的验证段），
// 没有进套件。要做的话得开子进程建库、插旧值、再重开库读回（约两次 spawn）。
const dbSrc = read('db.js');
// 只在**代码**里检查字面量：注释里合法地会提到旧名（说明"这里以前写死过"）。
// ⚠️ 不能用 `/\/\/.*$/` 去注释：db.js 是 **CRLF**，而 `.` 不匹配 `\r`、非多行 `$` 又要求行尾，
// 结果是**一条都没剥掉**，把注释里的示例当成缺陷报出来（第一版就是这样假失败的）。
// 用 `[^\n]*` 并同时剥块注释，才与行尾无关。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/[^\n]*/, '')).join('\n');
const dbCode = stripComments(dbSrc);
check('D1 db.js 从 ai/policy.mjs 取模型名', /import\s*\{[^}]*MODELS[^}]*\}\s*from\s*'\.\/ai\/policy\.mjs'/.test(dbCode));
check('D2 建表默认值是插值（不是字面量）', /model TEXT NOT NULL DEFAULT '\$\{MODELS\.fast\}'/.test(dbCode));
check('D3 迁移清单来自策略表（不是抄在 SQL 里）',
  /LEGACY_MODEL_NAMES/.test(dbCode) && /IN \(\$\{LEGACY_MODEL_NAMES/.test(dbCode),
  (dbCode.match(/LEGACY_MODEL_NAMES/g) || []).length + ' 处引用');
check('D3b 旧名清单里确实含 deepseek-v4-pro（本轮要收敛的那个）',
  Array.isArray(P.LEGACY_MODEL_NAMES) && P.LEGACY_MODEL_NAMES.includes('deepseek-v4-pro'), JSON.stringify(P.LEGACY_MODEL_NAMES));
check('D4 代码里没有裸的模型名字面量（注释不算）',
  !/['"]deepseek-(?:flash|v4-pro)['"]/.test(dbCode.replace(/'deepseek-chat'|'deepseek-reasoner'|'deepseek-v4-pro'/g, '')),
  (dbCode.match(/['"]deepseek-(?:flash|v4-pro)['"]/g) || []).join(','));

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
