/**
 * tests/narrative-repair/02-fixtures.test.mjs —— R 类（样本与来源）：R01 / R12。
 *
 * R01 冻结两版样本：六组替换能完整重建后稿；正文里不夹评论；附录 A/B 的 hash 与字符数一致。
 * R12 给样本打来源标签：这两版是 **AI 生成的回归材料**，不得被自动登记成"真人作者基线"。
 *
 * 只读：本套件不修改 fixtures，也不写任何作品数据。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createChecks, loadFixtures } from './harness.mjs';

const { check, finish } = createChecks();
const { before, after, manifest, dir } = loadFixtures();

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const compact = (s) => s.replace(/\s+/gu, '');
const count = (s) => [...s].length;

// ── R01 ────────────────────────────────────────────────────────────────────
check('R01-a', '审稿前原文 hash 与清单一致（不可改写的基线）', sha256(before) === manifest.before.sha256, `${sha256(before)} vs ${manifest.before.sha256}`);
check('R01-b', '审稿后原文 hash 与清单一致', sha256(after) === manifest.after.sha256, `${sha256(after)} vs ${manifest.after.sha256}`);
check('R01-c', '字符数口径一致（码点 / 去空白）',
  count(before) === manifest.before.chars && count(compact(before)) === manifest.before.compact_chars
  && count(after) === manifest.after.chars && count(compact(after)) === manifest.after.compact_chars,
  JSON.stringify({ before: [count(before), count(compact(before))], after: [count(after), count(compact(after))] }));

let rebuilt = compact(before);
let ok = true;
const detail = [];
for (const change of manifest.changes) {
  const from = compact(change.before);
  const to = compact(change.after);
  const at = rebuilt.indexOf(from);
  const unique = at >= 0 && rebuilt.indexOf(from, at + from.length) < 0;
  if (!unique) { ok = false; detail.push(`${change.id}:not-unique`); continue; }
  rebuilt = rebuilt.slice(0, at) + to + rebuilt.slice(at + from.length);
  detail.push(change.id);
}
check('R01-d', '六组替换能精确重建后稿（改动清单不是"看起来差不多"）',
  ok && manifest.changes.length === 6 && rebuilt === compact(after), detail.join(','));
check('R01-e', '正文里不夹评论（样本是纯正文，不是评审对话）',
  !/审稿前[:：]|审稿后[:：]|你认为这篇文章|AI 味|编辑建议/.test(before)
  && !/审稿前[:：]|审稿后[:：]|你认为这篇文章|AI 味|编辑建议/.test(after));
check('R01-f', '相似度是文本序列指标，不是质量分（清单里写明了这一点）',
  /text_sequence_similarity/.test(manifest.comparison.meaning));

// ── R12 ────────────────────────────────────────────────────────────────────
// 样本是"AI 生成的回归材料"。它**可以**作为回归输入，但不能被当成"真人作者基线"，
// 也不能因为进了仓库就自动变成风格参考（§5.5）。这里可验证的部分是：
// ① 清单声明了来源是两版 AI 产出（不是作者手写样文）；
// ② fixtures 目录里没有任何风格档案/人工批准产物（没有"顺手登记基线"的痕迹）。
check('R12', '样本带来源标签：来自两版 AI 产出，不是真人作者基线',
  /粘贴的文本/.test(String(manifest.canonical_originals)) && /粘贴的 markdown/.test(String(manifest.advice_source)),
  JSON.stringify({ canonical: manifest.canonical_originals, advice: manifest.advice_source }));
check('R12-b', '样本不被写成风格基线（清单与目录里都没有人工批准/风格参考标记）',
  !/use_as_style_reference|approved_by_author|human_authored/.test(JSON.stringify(manifest))
  && !fs.readdirSync(dir).some((f) => /style|profile|baseline/i.test(f)),
  fs.readdirSync(dir).join(','));

finish('02-fixtures');
