#!/usr/bin/env node
/**
 * test-edit-distance.mjs —— 编辑距离的离线单测（零成本、不碰网络、不导入服务端）。
 *
 * 为什么要有它：这个数字会直接出现在「上下文质量有没有变好」的结论里，
 * 算错了比算不出来更糟——所以边界必须钉死：空串、单字符（没有二元组）、
 * 完全相同、完全无关、超长走近似、近似与精确在同一量级。
 *
 * 用法: node .p1-baseline/test-edit-distance.mjs
 */
import {
  editDistance, levenshtein, bigramDiceDistance, editRatio, EXACT_MAX_CELLS,
} from '../ai/edit-distance.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. 精确 Levenshtein 的正确性（手算对照）】');
{
  ok('空 vs 空 = 0', levenshtein('', '') === 0);
  ok('空 vs abc = 3', levenshtein('', 'abc') === 3);
  ok('abc vs 空 = 3', levenshtein('abc', '') === 3);
  ok('相同 = 0', levenshtein('小说正文', '小说正文') === 0);
  ok('kitten vs sitting = 3（经典用例）', levenshtein('kitten', 'sitting') === 3);
  ok('单字替换 = 1', levenshtein('猫', '狗') === 1);
  ok('一次插入 = 1', levenshtein('雾都缝匠', '雾都的缝匠') === 1);
  ok('一次删除 = 1', levenshtein('雾都的缝匠', '雾都缝匠') === 1);
  ok('对称性：d(a,b) === d(b,a)', levenshtein('他走进雨里', '她走进雨里') === levenshtein('她走进雨里', '他走进雨里'));
  ok('三角不等式：d(a,c) <= d(a,b)+d(b,c)',
    levenshtein('一二三四五', '一二X四五') + levenshtein('一二X四五', '一二X四五六') >= levenshtein('一二三四五', '一二X四五六'));
}

console.log('\n【2. 边界：空串与单字符】');
{
  const r1 = editDistance('', '');
  ok('两个空串 → 0 / identical', r1.distance === 0 && r1.method === 'identical', JSON.stringify(r1));
  const r2 = editDistance('', '七个字');
  ok('一边为空 → 距离 = 另一边长度', r2.distance === 3 && r2.method === 'empty', JSON.stringify(r2));
  // ⚠️ 单字符没有二元组：bigram Dice 的分母为 0，若不特判会把 "x" vs "y" 算成 0。
  const r3 = editDistance('甲', '乙', { exactMaxCells: 0 });
  ok('单字符走近似也必须非 0（分母为 0 的特判）', r3.distance === 1 && r3.method === 'bigram-dice',
    JSON.stringify(r3));
  const r4 = bigramDiceDistance('甲', '甲');
  ok('单字符相同 → 0', r4 === 0, String(r4));
}

console.log('\n【3. method 选择与阈值】');
{
  ok('小文本走精确', editDistance('abc', 'abd').method === 'levenshtein');
  ok(`阈值常量存在（${EXACT_MAX_CELLS.toLocaleString('en-US')} 格）`, Number.isFinite(EXACT_MAX_CELLS) && EXACT_MAX_CELLS > 0);
  const longA = '雨'.repeat(6000);
  const longB = '雨'.repeat(5999) + '雪';
  const r = editDistance(longA, longB);
  ok('6000×6000 超过阈值 → 走近似', r.method === 'bigram-dice', JSON.stringify(r));
  ok('超长文本的近似距离量级正确（改了 1 处字，应在小数量级）', r.distance >= 1 && r.distance <= 20,
    `distance=${r.distance}`);
}

console.log('\n【4. 近似的单调性与量级（与精确对照）】');
{
  const base = '他推开门，雨声一下子涌进来，像有人把整条街倒进了屋里。';
  const oneChar = base.replace('推', '踢');
  const half = base.slice(0, Math.floor(base.length / 2)) + '完全不同的后半段内容在这里出现。';
  const d0 = bigramDiceDistance(base, base);
  const d1 = bigramDiceDistance(base, oneChar);
  const d2 = bigramDiceDistance(base, half);
  ok('完全相同 → 0', d0 === 0, String(d0));
  ok('改 1 字 → 远小于改一半', d1 < d2, `d1=${d1} d2=${d2}`);
  ok('改一半 → 与文本长度同量级', d2 > base.length * 0.3, `d2=${d2} len=${base.length}`);
  const exact = levenshtein(base, oneChar);
  ok('近似的 1 字改动与精确值都落在 1..6（不夸大）', d1 >= 1 && d1 <= 6 && exact === 1,
    `approx=${d1} exact=${exact}`);
}

console.log('\n【5. 完全相同/完全无关的极值】');
{
  const a = '第一段。\n第二段。\n第三段。';
  ok('逐字节相同 → 0', editDistance(a, a).distance === 0);
  const b = '甲甲甲。\n乙乙乙。\n丙丙丙。';
  const d = editDistance(a, b).distance;
  ok('完全无关 → 接近较大长度', d >= Math.max(a.length, b.length) * 0.6, `d=${d} max=${Math.max(a.length, b.length)}`);
  ok('距离不可能超过较长文本的长度', d <= Math.max(a.length, b.length), `d=${d}`);
}

console.log('\n【6. editRatio：跨长度可比，且不下结论】');
{
  ok('0 长度 → null（不用 0 假装有结论）', editRatio(0, 0, 0) === null);
  ok('改 1 字 / 10 字 = 0.1', editRatio(1, 10, 10) === 0.1, String(editRatio(1, 10, 10)));
  ok('按较长一边归一', editRatio(5, 10, 50) === 0.1, String(editRatio(5, 10, 50)));
  ok('比例被夹在 0..1', editRatio(999, 10, 10) === 1, String(editRatio(999, 10, 10)));
}

console.log('\n【7. 换行与空白不制造假距离（服务端先 plainText 归一，这里确认模块行为）】');
{
  ok('仅换行差异 → 距离等于差异字符数（不做隐式归一，由调用方负责）',
    editDistance('甲乙\n丙丁', '甲乙丙丁').distance === 1);
}

console.log(`\n══════════════════════════════`);
console.log(`编辑距离离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
