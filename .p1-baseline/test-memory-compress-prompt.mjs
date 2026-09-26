#!/usr/bin/env node
/**
 * test-memory-compress-prompt.mjs —— 记忆压缩提示词组装的**离线单测**（零成本、不碰数据库、不调模型）。
 *
 * 被验证的缺陷（2026-09-24 修）：提示词开头写着「前为全部章节摘要，后为最近章节尾部」，
 * 而 2026-09-21 的重构把 `content_head` / `content_tail` 两个查询别名删掉后，那两个引用变成
 * `undefined` —— 「最近章节尾部」永远是空的，缺摘要的章节也只剩标题。压缩器只能靠摘要工作，
 * 而摘要对**正在写的新章**往往还是空的：最新剧情最可能被漏掉，且不会报错。
 *
 * 这里钉四件事：
 *   1. 最近几章的**正文尾部确实进了提示词**（核心断言）；
 *   2. 缺摘要的章节用**正文头部**兜底，不是只留一个标题；
 *   3. **阴性对照（变异测试）**：把正文换成缺失（= 修复前的形态），同一批断言必须判它失败——
 *      否则这些断言根本区分不出对错，等于没测；
 *   4. 两个预算常量仍受约束（覆盖优先 + 总量不超预算），以及"整章正文"不是"头 1500 字"。
 *
 * 用法: node .p1-baseline/test-memory-compress-prompt.mjs
 */
import fs from 'node:fs';
import {
  buildCompressionPrompt, buildChapterPromptText,
  SUMMARY_BUDGET, TAIL_BUDGET, TAIL_COUNT, HEAD_FALLBACK_CHARS, TAIL_CHARS,
} from '../ai/memory-compress-prompt.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

/** 造一章：正文用可区分的标记，便于断言"到底进了哪一段"。 */
const chapter = (n, { summary = '', content = '' } = {}) => ({
  title: `第${n}章`,
  summary,
  content: `<p>${content}</p>`,
});

/** 合成作品：三章有摘要、一章没摘要；最后一章的尾部带一个**只出现在正文里**的专名。 */
const UNIQUE_TAIL = '密钥是在钟楼第三层找到的';
const UNIQUE_HEAD = '开篇就点明了封锁线';
const chapters = [
  chapter(1, { summary: '主角进城', content: `${UNIQUE_HEAD}。${'前'.repeat(200)}` }),
  chapter(2, { summary: '遇到线人', content: '中段内容'.repeat(80) }),
  chapter(3, { summary: '', content: `${'中'.repeat(300)}尾声前的过渡` }),
  chapter(4, { summary: '拿到线索', content: `${'后'.repeat(600)}。${UNIQUE_TAIL}` }),
];

console.log('【1. 最近章节尾部的正文必须进提示词（修复前恒为空）】');
{
  const text = buildChapterPromptText(chapters);
  ok('最近一章的正文尾部内容出现在提示词里', text.includes(UNIQUE_TAIL), '未找到尾部专名');
  const tailBlocks = text.split('\n').filter((l) => l.includes('章节尾部'));
  ok(`尾部段落数 = TAIL_COUNT（${TAIL_COUNT}）`, tailBlocks.length === TAIL_COUNT, `实际 ${tailBlocks.length}`);
  ok('每个尾部段落都有正文（不是只有标题）',
    tailBlocks.every((l) => l.replace(/^【.*?】/, '').trim().length > 20),
    JSON.stringify(tailBlocks.map((l) => l.length)));
}

console.log('\n【2. 缺摘要的章节用正文头部兜底】');
{
  const text = buildChapterPromptText(chapters);
  const line3 = text.split('\n').find((l) => l.startsWith('【第3章】'));
  ok('第 3 章（无摘要）那行不是光秃秃一个标题', Boolean(line3) && line3.length > 8, JSON.stringify(line3));
  ok('兜底内容确实取自它的正文', Boolean(line3) && line3.includes('中'.repeat(20)), JSON.stringify(line3?.slice(0, 60)));
  const single = [chapter(9, { summary: '', content: UNIQUE_HEAD + '，然后是别的'.repeat(10) })];
  ok('同一条判据对别的章节同样成立（单章、无摘要 → 正文头部进提示词）',
    buildChapterPromptText(single).includes(UNIQUE_HEAD));
}

console.log('\n【3. 阴性对照（变异测试）：缺正文时必须判失败】');
{
  // 修复前的形态：查询里没有 content_head / content_tail，正文取到 undefined。
  const broken = chapters.map((c) => ({ title: c.title, summary: c.summary, content: undefined }));
  const brokenText = buildChapterPromptText(broken);
  ok('（对照）缺正文时尾部专名不在提示词里 —— 证明上面那条断言真的能抓到缺陷',
    !brokenText.includes(UNIQUE_TAIL));
  ok('（对照）缺正文时"每段都有正文"会判失败',
    !brokenText.split('\n').filter((l) => l.includes('章节尾部')).every((l) => l.replace(/^【.*?】/, '').trim().length > 20));
  ok('（对照）缺摘要 + 缺正文时那行只剩标题',
    (brokenText.split('\n').find((l) => l.startsWith('【第3章】')) || '').trim() === '【第3章】');
}

console.log('\n【4. 预算与覆盖（改动不得让提示词失控膨胀）】');
{
  const many = Array.from({ length: 108 }, (_, i) => chapter(i + 1, { summary: `摘要${i + 1}`, content: '正文'.repeat(400) }));
  const text = buildChapterPromptText(many);
  const summaryPart = text.split('\n').filter((l) => !l.includes('章节尾部')).join('\n');
  const tailPart = text.split('\n').filter((l) => l.includes('章节尾部')).join('\n');
  ok(`摘要段 ≤ SUMMARY_BUDGET（${SUMMARY_BUDGET}）`, summaryPart.length <= SUMMARY_BUDGET, `实际 ${summaryPart.length}`);
  ok(`尾部段 ≤ TAIL_BUDGET（${TAIL_BUDGET}）`, tailPart.length <= TAIL_BUDGET, `实际 ${tailPart.length}`);
  ok('覆盖优先：108 章里每一章都还有自己的那一行',
    many.every((c) => text.includes(`【${c.title}】`)),
    '有章节被"先到先得"挤掉了');
}

console.log('\n【5. 常量与接线（模板外置后不得各写一份）】');
{
  const prompt = buildCompressionPrompt({
    work: { title: '测试作品', description: '简介' },
    chapters,
    characterText: '【甲】身份：主角\n【乙】身份：配角',
    worldText: '【钟楼】城北的钟楼',
  });
  ok('提示词带作品名与简介', prompt.includes('测试作品') && prompt.includes('简介'));
  ok('提示词保留"不超过 800 字"的既定产出目标（与护栏下限成对契约）', prompt.includes('不超过 800 字'));
  ok('提示词里没有 undefined / NaN 之类的取值事故',
    !/\bundefined\b|\bNaN\b/.test(prompt), prompt.match(/undefined|NaN/g)?.join(',') || '');
  ok('角色/世界观块仍然进提示词', prompt.includes('【甲】') && prompt.includes('【钟楼】'));
  ok(`缺摘要兜底字数与 TAIL_CHARS 未被就地改写（${HEAD_FALLBACK_CHARS} / ${TAIL_CHARS}）`,
    HEAD_FALLBACK_CHARS === 260 && TAIL_CHARS === 700);

  const src = fs.readFileSync('server.js', 'utf8');
  ok('server.js 不再引用已不存在的查询别名 content_head / content_tail',
    !/content_head|content_tail/.test(src.replace(/\/\/[^\n]*/g, '')));
  ok('server.js 的提示词组装改为调用纯函数模块',
    /buildCompressionPrompt\(\{\s*work,\s*chapters,\s*characterText,\s*worldText\s*\}\)/.test(src));
  const mod = fs.readFileSync('ai/memory-compress-prompt.mjs', 'utf8');
  ok('压缩/截断辅助函数不再在 server.js 里另留一份',
    /export function compactEntityLinesWithinBudget/.test(mod)
    && !/function compactEntityLinesWithinBudget/.test(src));
}

console.log(`\n══════════════════════════════`);
console.log(`记忆压缩提示词离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;