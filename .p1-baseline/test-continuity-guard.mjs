#!/usr/bin/env node
/**
 * test-continuity-guard.mjs —— 确定性连续性预检的离线单测（零成本、零网络、零 AI）。
 *
 * 被验证的行为：预检**只报能判定的事**，且每条判据都带阴性对照——
 * 「不报」的用例和「报」的用例一样重要：一个见谁都报的检查会被作者直接关掉，
 * 那时它连真问题也一起不报了。
 *
 * 阴性对照（本文件的重点）：
 *   · 角色卡只有卷号、没有「卷末」→ **不报**（证明判据不是"见到卷号就报"）；
 *   · 系统出场次数**等于**上限、或低于下限 → 不报（证明"只判超限"这一侧）；
 *   · 篇幅**不足** → 不报（那是成文弹窗 `articleLengthHint` 的职责，重复报会让作者脱敏）；
 *   · 支线在作品早期还没起线 → 不报（证明"不拿 50 章规划全量算空档"）。
 *
 * 用法: node .p1-baseline/test-continuity-guard.mjs
 */
import fs from 'node:fs';
import {
  cnNumeralToInt, parseSystemMentionMax, parseChapterLengthRange, parseVolumeMarkers,
  checkCharacterTimePoint, checkSystemFrequency, checkChapterLength, checkPlotlineProgress,
  runContinuityChecks, partitionExempt, dropExempt, findingKey, plainLen, summarizeFindings,
  findingsPromptText, DEFAULT_SYSTEM_MENTION_MAX, VOLUME_END_LEAD_CHAPTERS,
} from '../ai/continuity-guard.mjs';
import { gatherContinuityInput, computeContinuityGuard, CONTINUITY_EXEMPTIONS_PREFIX } from '../ai/continuity-guard-source.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// 真实风格文本片段（取自 work#18 的 style_positive，不是编的）
const STYLE = '网文风格，快节奏；每章至少一个钩子，结尾留悬念。单章 3000～5000 字（默认 4000），一章一审，不批量生成。\n'
  + '写作节奏：校园日常约 70% / 超凡事件约 20% / 系统互动约 10%。\n'
  + '系统每章有效出场约 5～15 次，不要每段都有，避免变成"系统聊天记录"。\n'
  + '完整能力面板不要频繁弹出，第一卷前期约 3～5 章出现一次。';

console.log('【1. 解析器：风格文本 → 阈值（解析不到就返回 null，不猜）】');
{
  ok('系统出场上限：从"系统每章有效出场约 5～15 次"解析出 15', parseSystemMentionMax(STYLE) === 15, String(parseSystemMentionMax(STYLE)));
  ok('风格文本里没有这条 → null（而不是默认值被当成解析结果）', parseSystemMentionMax('快节奏，结尾留悬念。') === null);
  const lr = parseChapterLengthRange(STYLE);
  ok('篇幅区间：3000～5000、默认 4000', lr && lr.min === 3000 && lr.max === 5000 && lr.default === 4000, JSON.stringify(lr));
  ok('没有字数要求 → null', parseChapterLengthRange('每章至少一个钩子。') === null);

  ok('中文数字：三 → 3', cnNumeralToInt('三') === 3);
  ok('中文数字：十一 → 11', cnNumeralToInt('十一') === 11);
  ok('中文数字：二十 → 20', cnNumeralToInt('二十') === 20);
  ok('阿拉伯数字原样：12 → 12', cnNumeralToInt('12') === 12);
  ok('认不出 → null（不是 0、不是 NaN）', cnNumeralToInt('甲') === null);

  const m = parseVolumeMarkers('第一卷末：暗夜修罗身份引发全城追查；学生身份仍稳定，继续装普通人。');
  ok('卷标记：第一卷末 → {volume:1, atVolumeEnd:true}', m && m.volume === 1 && m.atVolumeEnd === true, JSON.stringify(m));
  ok('卷标记：只有卷一（无"末"）→ atVolumeEnd:false', parseVolumeMarkers('第一卷：发现岳宸炎"太稳定"')?.atVolumeEnd === false);
  ok('卷标记：最终卷 → finalVolume:true', parseVolumeMarkers('最终卷 毕业与终焉')?.finalVolume === true);
  ok('没有卷标记 → null（不猜）', parseVolumeMarkers('性格冷淡，不轻易相信人') === null);
}

console.log('\n【2. 角色卡时点：真实案例 + 阴性对照】');
{
  const CHAPTER = { id: 123, position: 4, label: '第五章 第一次使用力量', volumeOrdinal: 0, indexInVolume: 4, chaptersInVolume: 50, isFinalVolume: false };
  const YUE = { id: 67, name: '岳宸炎', status: '第一卷末：暗夜修罗身份引发全城追查；学生身份仍稳定，继续装普通人。', identity: '海澜市第三高级中学高三七班学生（转学生）' };
  const f1 = checkCharacterTimePoint({ chapter: CHAPTER, characters: [YUE] });
  ok('真实案例：卷末状态用在第一卷第 5 章 → 命中 1 条 warning',
    f1.length === 1 && f1[0].severity === 'warning' && f1[0].category === 'character_time_point', JSON.stringify(f1.map((x) => x.severity)));
  ok('实体键指向角色（豁免用得上）', f1[0].entity_id === 'character:67', f1[0].entity_id);

  // 阴性对照①：只有卷号、没有"卷末" → 不报
  const linXue = { id: 69, name: '林清雪', status: '第一卷：发现岳宸炎"太稳定，不像普通人"；后续逐渐接近真相。', identity: '岳宸炎同桌；海澜三中高三七班学生' };
  ok('阴性对照：只有"第一卷"没有"卷末" → 不报（不是见卷号就报）',
    checkCharacterTimePoint({ chapter: CHAPTER, characters: [linXue] }).length === 0);

  // 阴性对照②：卷末状态用在**卷末**那一章 → 合法
  const last = { ...CHAPTER, indexInVolume: 49 };
  ok('阴性对照：卷末状态用在卷末章 → 不报',
    checkCharacterTimePoint({ chapter: last, characters: [YUE] }).length === 0);
  // 允许区 = 卷内最后 N 章（idx >= total - N）。total=50、N=2 → idx 48/49 才允许"卷末"状态。
  const nearEnd = { ...CHAPTER, indexInVolume: 50 - VOLUME_END_LEAD_CHAPTERS };
  ok('卷末前 N 章（N=VOLUME_END_LEAD_CHAPTERS）以内 → 不报（留出过渡带）',
    checkCharacterTimePoint({ chapter: nearEnd, characters: [YUE] }).length === 0);
  ok('过渡带之外（倒数第 N+1 章）→ 仍然报', checkCharacterTimePoint({
    chapter: { ...CHAPTER, indexInVolume: 50 - VOLUME_END_LEAD_CHAPTERS - 1 }, characters: [YUE],
  }).length === 1);

  // 跨卷方向
  const ahead = { id: 1, name: '甲', status: '第二卷：已经是联赛冠军', identity: '' };
  const fa = checkCharacterTimePoint({ chapter: CHAPTER, characters: [ahead] });
  ok('后续卷的状态用在前面卷 → warning', fa.length === 1 && fa[0].severity === 'warning');
  const stale = { id: 2, name: '乙', status: '第一卷：刚认识', identity: '' };
  const fs2 = checkCharacterTimePoint({ chapter: { ...CHAPTER, volumeOrdinal: 1 }, characters: [stale] });
  ok('更早卷的状态用在后面卷 → 只报 info（可能已过期，不是错）', fs2.length === 1 && fs2[0].severity === 'info');

  // 没有卷信息就不判（避免瞎猜）
  ok('缺卷信息（volumeOrdinal:null）→ 一条都不报',
    checkCharacterTimePoint({ chapter: { ...CHAPTER, volumeOrdinal: null }, characters: [YUE] }).length === 0);
  ok('最终卷标记 + 本章不在最终卷 → 报', checkCharacterTimePoint({
    chapter: CHAPTER, characters: [{ id: 3, name: '丙', status: '最终卷：成为规则之外的存在', identity: '' }],
  }).length === 1);
}

console.log('\n【3. 系统频率：只判上限，两档严重度】');
{
  const mk = (n) => '系统'.repeat(n) + '他低头写题。';
  const ch = { id: 123, position: 4 };
  ok('等于上限（15）→ 不报', checkSystemFrequency({ chapter: ch, text: mk(15), max: 15 }).length === 0);
  ok('低于下限（3 次）→ 不报（系统出场少是叙事选择）', checkSystemFrequency({ chapter: ch, text: mk(3), max: 15 }).length === 0);
  const over = checkSystemFrequency({ chapter: ch, text: mk(19), max: 15 });
  ok('刚过线（19/15）→ info（字面命中只是"有效出场"的近似）', over.length === 1 && over[0].severity === 'info', JSON.stringify(over.map((f) => f.severity)));
  const hard = checkSystemFrequency({ chapter: ch, text: mk(25), max: 15 });
  ok('明显超出（25 ≥ 15×1.5）→ warning', hard.length === 1 && hard[0].severity === 'warning');
  ok('零命中 → 不报', checkSystemFrequency({ chapter: ch, text: '他低头写题。', max: 15 }).length === 0);
  // 15 次"系统" + 1 次别名 = 16 > 15 → 报；证明别名不是被忽略的
  ok('别名（守护者协议）也计入', checkSystemFrequency({ chapter: ch, text: '守护者协议' + mk(15), max: 15, aliases: ['守护者协议'] }).length === 1);
  ok('默认上限常量可用（解析不到风格文本时的兜底）', DEFAULT_SYSTEM_MENTION_MAX === 15);
}

console.log('\n【4. 篇幅：口径冲突 + 超上限；不足不在这里报】');
{
  const ch = { id: 123, position: 4 };
  const lr = parseChapterLengthRange(STYLE);
  const conflict = checkChapterLength({ chapter: ch, plainLength: 3051, chapterTarget: 3000, workDefault: 4000, styleRange: lr });
  ok('真实案例：章节目标 3000 vs 作品默认 4000 → 报口径冲突（info）',
    conflict.length === 1 && conflict[0].category === 'chapter_length_target_conflict' && conflict[0].severity === 'info', JSON.stringify(conflict.map((x) => x.category)));
  ok('口径一致（都是 4000）→ 不报', checkChapterLength({ chapter: ch, plainLength: 3051, chapterTarget: 4000, workDefault: 4000, styleRange: lr }).length === 0);
  const over = checkChapterLength({ chapter: ch, plainLength: 5200, chapterTarget: 4000, workDefault: 4000, styleRange: lr });
  ok('超上限（5200 > 5000）→ warning', over.length === 1 && over[0].category === 'chapter_length_over' && over[0].severity === 'warning');
  ok('定稿 3897 字（在 3000～5000 内）→ 不报超限',
    checkChapterLength({ chapter: ch, plainLength: 3897, chapterTarget: 4000, workDefault: 4000, styleRange: lr }).length === 0);
  ok('阴性对照：不足目标（1500/4000）→ 这里不报（成文弹窗已经会提示）',
    checkChapterLength({ chapter: ch, plainLength: 1500, chapterTarget: 4000, workDefault: 4000, styleRange: lr }).length === 0);
  const inferred = checkChapterLength({ chapter: ch, plainLength: 5100, chapterTarget: 4000, workDefault: 4000, styleRange: null });
  ok('没有风格区间时按目标×1.25 推定上限（5100 > 5000）→ warning', inferred.length === 1 && inferred[0].category === 'chapter_length_over');
}

console.log('\n【5. 剧情线推进：两档 + 阈值可覆盖】');
{
  const plotlines = [{ id: 39, title: '隐藏身份的无敌高中生' }, { id: 40, title: '感情线' }];
  const chapters = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => ({ position: p, plotline_id: 39 })),
    { position: 13, plotline_id: 40 },
  ];
  const cur = 5;
  ok('主线刚推进过（gap=0）→ 不报',
    checkPlotlineProgress({ plotlines, chapters, writtenPositions: [0, 1, 2, 3, 4, 5], currentPosition: cur, stallThreshold: 4 }).length === 0);
  const stalled = checkPlotlineProgress({ plotlines, chapters, writtenPositions: [0, 1, 2], currentPosition: 7, stallThreshold: 4 });
  ok('连续 5 章无推进（阈值 4）→ warning plotline_stalled',
    stalled.length === 1 && stalled[0].category === 'plotline_stalled' && stalled[0].severity === 'warning', JSON.stringify(stalled.map((x) => x.category)));
  ok('阈值调到 6 → 同一条不再报（阈值是作者口径）',
    checkPlotlineProgress({ plotlines, chapters, writtenPositions: [0, 1, 2], currentPosition: 7, stallThreshold: 6 }).length === 0);
  ok('阴性对照：支线首个归属章在第 13 章、当前才第 6 章 → 不报（作品早期不算漏写）',
    checkPlotlineProgress({ plotlines, chapters, writtenPositions: [0, 1, 2, 3, 4, 5], currentPosition: cur, stallThreshold: 4 }).length === 0);
  // ⚠️ 夹具要点：归属它的那一章**还没写**（不在 writtenPositions 里），
  //    否则会走进"停滞"分支（推进过 → 看间隔），根本到不了"未起线"这一条。
  const shouldHaveStarted = checkPlotlineProgress({
    plotlines, chapters: [{ position: 3, plotline_id: 40 }], writtenPositions: [0, 1, 2, 4, 5], currentPosition: cur, stallThreshold: 4,
  });
  ok('该起线却没起线（归属章在第 4 章、已写到第 6 章）→ info plotline_not_started',
    shouldHaveStarted.length === 1 && shouldHaveStarted[0].category === 'plotline_not_started' && shouldHaveStarted[0].severity === 'info');
  ok('没有 currentPosition → 一条都不报（缺一半判据不猜）',
    checkPlotlineProgress({ plotlines, chapters, writtenPositions: [0], currentPosition: null }).length === 0);
}

console.log('\n【6. 豁免：键的稳定性（措辞与章节都不进键）】');
{
  const a = { category: 'character_time_point', entity_id: 'character:67', severity: 'warning', message: '措辞 A', chapter: 4 };
  const b = { category: 'character_time_point', entity_id: 'character:67', severity: 'warning', message: '完全不同的措辞 B（检查改进了）', chapter: 41 };
  ok('同一 fact、不同措辞与章节 → 同一个键', findingKey(a) === findingKey(b), findingKey(a));
  ok('换个实体 → 换键', findingKey(a) !== findingKey({ ...a, entity_id: 'character:75' }));
  const { kept, exempted } = partitionExempt([a, b, { ...a, entity_id: 'chapter:123', category: 'system_frequency' }], [findingKey(a)]);
  // a 与 b 是**同一个 fact 的两次表现**（措辞不同、章节不同）→ 一次豁免必须把两条都带走：
  // 剩下 1 条（另一类别的），被豁免 2 条。这正是"键不含措辞与章节"要的效果。
  ok('按 fact 豁免后，同一 fact 的其它表现一起消失', kept.length === 1 && exempted.length === 2, `kept=${kept.length} exempted=${exempted.length}`);
  ok('dropExempt 是 partitionExempt 的薄封装', dropExempt([a], [findingKey(a)]).length === 0);
  ok('豁免集为空 → 原样返回', dropExempt([a], []).length === 1);
}

console.log('\n【7. 汇总与提示词文本】');
{
  const fs2 = [
    { category: 'system_frequency', entity_id: 'chapter:1', severity: 'info', message: '系统偏多' },
    { category: 'character_time_point', entity_id: 'character:67', severity: 'warning', message: '卡时点越界' },
  ];
  const s = summarizeFindings(fs2);
  ok('汇总计数：按严重度与类别各分一份', s.total === 2 && s.bySeverity.warning === 1 && s.byCategory.system_frequency === 1, JSON.stringify(s));
  ok('零命中时给的是"没有发现问题"而不是空串', summarizeFindings([]).text.includes('零命中'));
  ok('空 findings → 提示词片段为空串（调用方据此决定不加那一段）', findingsPromptText([]) === '');
  const t = findingsPromptText(fs2);
  ok('提示词片段带严重度与建议', /\[warning\]/.test(t) && t.split('\n').length === 2, t);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...fs2[0], entity_id: `chapter:${i}` }));
  ok('提示词片段有上限（默认 12 行），不会挤掉正文', findingsPromptText(many).split('\n').length === 12);
  ok('plainLen 去掉所有空白（与界面同口径）', plainLen('他 写 了\n三 行') === 5, String(plainLen('他 写 了\n三 行')));
}

console.log('\n【8. 装配：假 deps 离线跑通（含"字数口径只有一条路"的回归）】');
{
  const fake = {
    all: (sql) => {
      if (/FROM volumes/.test(sql)) return [{ id: 23, title: '第一卷', position: 0 }, { id: 24, title: '第二卷', position: 1 }];
      if (/FROM characters/.test(sql)) return [{ id: 67, name: '岳宸炎', status: '第一卷末：全城追查', identity: '' }];
      if (/FROM plotlines/.test(sql)) return [{ id: 39, title: '主线', kind: 'main' }];
      if (/LENGTH\(TRIM\(COALESCE\(content/.test(sql)) return [{ position: 0 }];
      if (/FROM chapters/.test(sql)) return [{ id: 119, position: 0, plotline_id: 39, volume_id: 23, title: '第一章', target_words: 4000 }];
      return [];
    },
    get: (sql) => {
      if (/FROM works/.test(sql)) return { id: 18, title: '测试作品', default_chapter_words: 4000, style_positive: STYLE };
      if (/FROM chapters/.test(sql)) return { id: 119, work_id: 18, volume_id: 23, plotline_id: 39, title: '第一章', content: '<p>他 说：「系统。」</p>', position: 0, target_words: 4000 };
      return null;
    },
  };
  const input = gatherContinuityInput(fake, { workId: 18, chapterId: 119 });
  ok('装配出卷内位置（0 基）：第 1 章 / 本卷 1 章', input.chapter.volumeOrdinal === 0 && input.chapter.indexInVolume === 0 && input.chapter.chaptersInVolume === 1, JSON.stringify(input.chapter));
  ok('isFinalVolume 按 volumes.position 最大值判（本章在第一卷、还有第二卷 → false）', input.chapter.isFinalVolume === false);
  ok('库里正文以 HTML 存：装配后按**纯文本**计字（"他 说：「系统。」" → 8 字）', plainLen(input.text) === 8, `${plainLen(input.text)} / ${input.text}`);
  const r = computeContinuityGuard(fake, { workId: 18, chapterId: 119 });
  ok('computeContinuityGuard 端到端可用', r.ok === true && Array.isArray(r.result.findings));
  ok('作品不存在 → ok:false（调用方据此返回 404，而不是抛异常）',
    computeContinuityGuard({ all: () => [], get: () => null }, { workId: 999 }).ok === false);
  ok('app_settings 键前缀常量与报告一致（零迁移的落点）', CONTINUITY_EXEMPTIONS_PREFIX === 'continuity_exemptions:');
  // 没有章号时（前端"恢复"刷新预检块的那条路径）**不许**产出"空章号键"：
  // `chapter:` 这种键与列表里的键对不上 → 豁免静默失效、界面多出看不懂的条目。
  // 2026-09-22 复盘在隔离实例上实测到：同一份草稿，带章号报 2 条、不带章号报 1 条且键是 `chapter:`。
  // 双向对照：同一份文本**带章号时必须照常报**——否则"不报"可能只是因为判据被写死了。
  const longDraft = '系统'.repeat(30) + '字'.repeat(9000);
  const withCh = computeContinuityGuard(fake, { workId: 18, chapterId: 119, text: longDraft });
  const bare = computeContinuityGuard(fake, { workId: 18, text: longDraft });
  const chapterScopedCategories = ['character_time_point', 'system_frequency', 'chapter_length_over', 'chapter_length_target_conflict'];
  ok('对照：带章号时系统出场/篇幅超限照常报（证明判据没被写死）',
    withCh.ok === true
    && withCh.result.findings.some((f) => f.category === 'system_frequency')
    && withCh.result.findings.some((f) => f.category === 'chapter_length_over'),
    JSON.stringify(withCh.result.findings.map((f) => f.key)));
  ok('不带章号：只跑作品级检查（不产出空章号键、不报需要章的类别）',
    bare.ok === true
    && !bare.result.findings.some((f) => String(f.entity_id || '').endsWith(':'))
    && !bare.result.findings.some((f) => chapterScopedCategories.includes(f.category)),
    JSON.stringify(bare.result.findings.map((f) => f.key)));
}

console.log('\n【9. 静态接线：模块必须真的被用上（防"写了没接"）】');
{
  const server = fs.readFileSync('server.js', 'utf8');
  ok('server.js 导入了装配/检查入口', /from '\.\/ai\/continuity-guard-source\.mjs'/.test(server));
  ok('server.js 有 determinism 端点 continuity_guard', /'continuity_guard'/.test(server));
  ok('server.js 有豁免读写端点', /'continuity_exemption'/.test(server));
  ok('豁免落 app_settings（键前缀取自模块常量，不写字面量）', /CONTINUITY_EXEMPTIONS_PREFIX/.test(server));
  const app = fs.readFileSync('public/app.js', 'utf8');
  ok('前端有预检结果渲染函数', /function continuityGuardSummaryHtml\(/.test(app));
  ok('前端把预检结果内联进审稿提示词（Step 4）', /buildContinuityGuardText/.test(app));
  ok('前端渲染对消息做了转义（不注入原始文本）', /esc\(String\(f\.message/.test(app));
  ok('前端有"标记为故意"动作', /continuity-exempt/.test(app));
}

console.log(`\n══════════════════════════════`);
console.log(`确定性预检离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
