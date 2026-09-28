#!/usr/bin/env node
/**
 * R08 长正文分段处理离线测试（零计费、无网络、无模型）。
 *
 * 被测对象是 public/long-text.js —— 浏览器与测试共用同一实现：
 * 计划（按最终序列化请求判定单请求/分段）、切片（稳定片号）、
 * 覆盖清单（首/尾/章尾哨兵/唯一/顺序/缺片/重复/context-only 未改）、
 * 合并（不通过就拒绝）、断点续跑（成功且版本匹配的片不重跑）、
 * 越界拒绝（模型把邻接段吐回来时必须拒绝）。
 *
 * 用法: node .p1-baseline/test-long-text.mjs
 */
import '../public/long-text.js';

const L = globalThis.NovelLongText;
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const makeChapter = (n, per = 120) => Array.from({ length: n }, (_, i) =>
  `第${i + 1}段：他推开门，雨点砸在台阶上。${'这是一句用来凑长度的测试文本，不含任何真实书稿。'.repeat(Math.ceil(per / 24))}`).join('\n\n');

const TIGHT = { max_segment_chars: 600, min_segment_chars: 100, request_chars: 3000, output_reserve_chars: 1000, protocol_chars: 200 };

console.log('【1. 稳定 hash 与段落定位】');
{
  ok('同输入同 hash（跨调用稳定）', L.hashText('测试文本', 16) === L.hashText('测试文本', 16));
  ok('不同输入不同 hash', L.hashText('测试文本') !== L.hashText('测试文本。'));
  ok('hash 长度可控且是十六进制', /^[0-9a-f]{10}$/.test(L.hashText('x', 10)));
  const src = '第一段。\n\n第二段有\n软换行。\n\n\n第四段。';
  const spans = L.paragraphSpans(src);
  ok('空行切分得到 3 段', spans.length === 3, String(spans.length));
  ok('段偏移指向原文自身', spans.every((s) => src.slice(s.start, s.end) === s.text), JSON.stringify(spans.map((s) => src.slice(s.start, s.end) === s.text)));
  ok('软换行不切段', spans[1].text.includes('软换行'));
}

console.log('\n【2. 切片：稳定片号 + 全量覆盖】');
{
  const src = makeChapter(40);
  const a = L.buildSegments(src, TIGHT);
  const b = L.buildSegments(src, TIGHT);
  ok('同输入片号逐字相同（片号不随机）', JSON.stringify(a.segments.map((s) => s.segment_id)) === JSON.stringify(b.segments.map((s) => s.segment_id)));
  ok('片号唯一', new Set(a.segments.map((s) => s.segment_id)).size === a.segments.length);
  ok('首片从 0 开始', a.segments[0].target.start === 0);
  ok('尾片覆盖到正文末尾', a.segments[a.segments.length - 1].target.end === src.length, `${a.segments[a.segments.length - 1].target.end} vs ${src.length}`);
  ok('片序与原始顺序一致', a.segments.every((s, i) => s.ordinal === i + 1));
  ok('章尾哨兵落在最后一片里', a.segments[a.segments.length - 1].target.text.includes(a.sentinel));
  ok('片内容 hash 与片长非空', a.segments.every((s) => s.target.hash && s.target.chars === s.target.text.length));
  const joined = a.segments.map((s) => s.target.text).join('\n\n');
  ok('所有片拼回等于原文（无遗漏、无截断）', joined === src, `合并 ${joined.length} / 原文 ${src.length}`);
  // 前文修改只影响被改到的片：后面段的片号不变
  const edited = '新增了一句开头。\n\n' + src;
  const c = L.buildSegments(edited, TIGHT);
  const tailA = a.segments[a.segments.length - 1].segment_id;
  ok('前文新增内容后，尾部片的片号保持不变（不依赖字符 offset）', c.segments.some((s) => s.segment_id === tailA), `${tailA} 不在 ${c.segments.map((s) => s.segment_id).join(',')}`);
  const dup = '重复段。\n\n重复段。\n\n重复段。';
  const d = L.buildSegments(dup, { max_segment_chars: 20, min_segment_chars: 1 });
  ok('完全重复的段也能拿到唯一片号', new Set(d.segments.map((s) => s.segment_id)).size === d.segments.length, d.segments.map((s) => s.segment_id).join(','));
  const big = L.buildSegments('很长的一句话。'.repeat(400), { max_segment_chars: 500, min_segment_chars: 10 });
  ok('超长单段被按句切分且拼回等于原文', big.segments.map((s) => s.target.text).join('') === '很长的一句话。'.repeat(400));
}

console.log('\n【3. 计划：按最终序列化请求判定，而不是正文字符数】');
{
  const src = makeChapter(10);
  const msg = (text) => [{ role: 'system', content: '你是编辑。' }, { role: 'user', content: '需要处理的内容：\n' + text }];
  const single = L.planTask({ text: src, kind: 'polish', probeMessages: msg(src) });
  ok('短正文 → 单请求', single.mode === 'single', single.mode);
  ok('单请求不给分片', single.segments.length === 0);
  const long = L.planTask({ text: makeChapter(80), kind: 'polish', probeMessages: msg(makeChapter(80)), limits: TIGHT });
  ok('超限正文 → 分段', long.mode === 'segmented', long.mode);
  ok('分段时给出片数与预算口径', long.segments.length > 1 && long.budget.usable === TIGHT.request_chars - TIGHT.output_reserve_chars - TIGHT.protocol_chars);
  const overhead = L.planTask({ text: '短正文', kind: 'polish', probeMessages: msg('短正文').concat([{ role: 'system', content: 'x'.repeat(20000) }]), limits: TIGHT });
  ok('正文短但整包请求超限 → 仍然分段（按序列化请求判定）', overhead.mode === 'segmented', overhead.mode);
  ok('序列化字符数包含 JSON 包装开销', L.serializedChars(msg('abc')) > 'abc'.length);
}

console.log('\n【4. 单片消息：target 与 context-only 显式分离】');
{
  const src = makeChapter(20);
  const plan = L.planTask({ text: src, kind: 'polish', limits: TIGHT });
  const seg = plan.segments[1];
  const messages = L.segmentMessages({ system: '你是编辑。', context: '作品背景若干。', instruction: '更口语化', segment: seg, kind: 'polish' });
  const user = messages[1].content;
  ok('target 全文进请求（没有 6000 字截断）', user.includes(seg.target.text));
  ok('target 段被命名（segment_id 可见）', user.includes(seg.segment_id));
  ok('上文邻接段被标成 context-only', !!seg.context_before && user.includes(seg.context_before) && user.includes('context-only'));
  ok('作品背景也被标成 context-only', user.includes('作品背景若干。'));
  ok('消息形状仍是 system+user（不改调用链）', messages.length === 2 && messages[0].role === 'system');
}

console.log('\n【5. 越界拒绝：邻接段不许被改】');
{
  const src = makeChapter(20);
  const plan = L.planTask({ text: src, kind: 'polish', limits: TIGHT });
  const seg = plan.segments[1];
  const good = L.verifySegmentOutput({ segment: seg, output: '他推开门，雨点砸在台阶上，声音闷闷的。' });
  ok('正常改写通过', good.ok, good.reasons.join(','));
  ok('空输出拒绝', L.verifySegmentOutput({ segment: seg, output: '   ' }).reasons.includes('empty-output'));
  const echo = L.verifySegmentOutput({ segment: seg, output: seg.context_before });
  ok('把上文邻接段原样吐回 → 拒绝', !echo.ok && echo.reasons.includes('echoed-context'), echo.reasons.join(','));
  const marker = L.verifySegmentOutput({ segment: seg, output: '【上下文（仅供衔接参考）】\n改了改' });
  ok('输出里出现 context-only 标记 → 拒绝', !marker.ok && marker.reasons.includes('echoed-context-marker'));
  const fenced = L.verifySegmentOutput({ segment: seg, output: '```\n改好的 target 文本\n```' });
  ok('Markdown 代码围栏被剥离后再判定', fenced.ok && fenced.cleaned === '改好的 target 文本');
}

console.log('\n【6. 覆盖清单：这是"整章真的处理完"的唯一证明】');
{
  const src = makeChapter(30);
  const plan = L.planTask({ text: src, kind: 'polish', limits: TIGHT });
  const done = (seg) => ({ segment_id: seg.segment_id, ordinal: seg.ordinal, source_version: plan.source_version, status: 'done', output: seg.target.text + '（润色）', output_hash: L.hashText(seg.target.text + '（润色）', 16) });
  const results = plan.segments.map(done);
  const m = L.buildCoverageManifest({ source: src, plan, results });
  ok('全覆盖 → 通过', m.ok, m.unresolved.join('；'));
  ok('首/尾/哨兵三项都有结论', m.first_ok && m.tail_ok && m.sentinel_ok);
  ok('无缺片/重复/顺序问题', !m.missing.length && !m.duplicates.length && m.order_ok);
  const miss = L.buildCoverageManifest({ source: src, plan, results: results.filter((r) => r.segment_id !== plan.segments[2].segment_id) });
  ok('缺片 → 不通过且点名片号', !miss.ok && miss.missing.includes(plan.segments[2].segment_id), miss.unresolved.join('；'));
  const dup = L.buildCoverageManifest({ source: src, plan, results: results.concat([results[0]]) });
  ok('重复片 → 不通过', !dup.ok && dup.duplicates.length === 1, dup.unresolved.join('；'));
  const bad = L.buildCoverageManifest({ source: src, plan, results: results.map((r, i) => (i === 1 ? { ...r, output: plan.segments[0].target.text } : r)) });
  ok('某片改了邻接内容 → 不通过（越界可见）', !bad.ok && bad.violations.length === 1, bad.unresolved.join('；'));
  const flagged = L.buildCoverageManifest({ source: src, plan, results: results.map((r, i) => (i === 1 ? { ...r, status: 'violation', verification: { ok: false, reasons: ['echoed-context'] } } : r)) });
  ok('越界与"没跑成"分开记账（violations 与 missing 不混）', !flagged.ok && flagged.violations.length === 1 && flagged.missing.length === 0,
    `violations=${flagged.violations.length} missing=${flagged.missing.length}`);
  const swapped = L.buildCoverageManifest({ source: src, plan, results: results.map((r) => ({ ...r, ordinal: r.ordinal + (r.ordinal === 1 ? 1 : 0) })) });
  ok('片顺序与计划不符 → 不通过', !swapped.ok && swapped.order_mismatch.length === 1, swapped.order_mismatch.join(','));
  const stale = L.buildCoverageManifest({ source: src, plan, results, current_version: 'deadbeefdeadbeef' });
  ok('源正文已变化 → 候选过期、不通过', !stale.ok && stale.stale === true, stale.unresolved.join('；'));
  const tampered = { ...plan, segments: plan.segments.map((s, i) => (i === 0 ? { ...s, target: { ...s.target, start: 3 } } : s)) };
  ok('首段没盖住开头 → 不通过', !L.buildCoverageManifest({ source: src, plan: tampered, results }).ok);
}

console.log('\n【7. 合并：不通过就拒绝合并】');
{
  const src = makeChapter(24);
  const plan = L.planTask({ text: src, kind: 'expand', limits: TIGHT });
  const mk = (seg) => ({ segment_id: seg.segment_id, ordinal: seg.ordinal, source_version: plan.source_version, status: 'done', output: seg.target.text + '（扩写）', output_hash: L.hashText(seg.target.text + '（扩写）', 16) });
  const results = plan.segments.map(mk).reverse();
  const merged = L.mergeResults({ source: src, plan, results });
  ok('结果数组乱序也能按计划顺序合并', merged.ok && merged.merged.indexOf('（扩写）') === merged.merged.lastIndexOf('（扩写）') - 0 ? true : merged.ok);
  const joinedLen = merged.ok ? plan.segments.reduce((n, s) => n + s.target.text.length + 2, 0) : 0;
  const orderOk = merged.ok && plan.segments.every((s, i, arr) => {
    const at = merged.merged.indexOf(s.target.text + '（扩写）');
    if (at < 0) return false;
    return i === 0 ? true : at > merged.merged.indexOf(arr[i - 1].target.text + '（扩写）');
  });
  ok('合并正文按计划顺序拼接（逐片递增、无重排）', merged.ok && orderOk, merged.ok ? `长度 ${merged.merged.length} / 期望 ${joinedLen - 2}` : merged.reasons.join('；'));
  const half = L.mergeResults({ source: src, plan, results: results.slice(1) });
  ok('有缺片时拒绝合并（merged=null）', half.ok === false && half.merged === null);
  const staleMerge = L.mergeResults({ source: src, plan, results, current_version: 'ffffffffffffffff' });
  ok('源版本不匹配时拒绝合并', staleMerge.ok === false && staleMerge.reasons.some((r) => r.includes('过期')));
}

console.log('\n【8. 断点续跑：成功且仍匹配的片不重跑（不重复计费）】');
{
  const src = makeChapter(18);
  const plan = L.planTask({ text: src, kind: 'polish', limits: TIGHT });
  const calls = [];
  const runner = async (seg) => {
    calls.push(seg.segment_id);
    if (seg.ordinal === 2 && calls.filter((c) => c === seg.segment_id).length === 1) throw new Error('模拟网络失败');
    return seg.target.text + '（结果）';
  };
  const first = await L.runSegmentedTask({ plan, messagesFor: (s) => L.segmentMessages({ segment: s, system: 'x' }), runner });
  ok('失败片被标记为 failed，其它片完成', first.results.filter((r) => r.status === 'failed').length === 1 && first.results.filter((r) => r.status === 'done').length === plan.segments.length - 1);
  const statuses = L.segmentStatuses(plan, first.results, plan.source_version);
  ok('状态清单逐片可读', statuses.length === plan.segments.length && statuses[1].status === 'failed' && statuses[1].error.includes('网络失败'));
  const resume = L.resumeSegments(plan, first.results, plan.source_version);
  ok('续跑只点名失败片', resume.rerun.length === 1 && resume.rerun[0] === plan.segments[1].segment_id, JSON.stringify(resume.rerun));
  const before = calls.length;
  const second = await L.runSegmentedTask({ plan, results: first.results, messagesFor: (s) => L.segmentMessages({ segment: s, system: 'x' }), runner });
  ok('续跑只调用了失败的那一片（已成功的片不重跑）', calls.length === before + 1 && calls[calls.length - 1] === plan.segments[1].segment_id, calls.slice(before).join(','));
  const finalManifest = L.buildCoverageManifest({ source: src, plan, results: second.results });
  ok('续跑后覆盖清单通过', finalManifest.ok, finalManifest.unresolved.join('；'));
  // 中途取消：片间生效，不继续调用 runner
  const signal = { cancelled: false };
  const calls2 = [];
  const cancelRun = await L.runSegmentedTask({
    plan, signal,
    messagesFor: (s) => L.segmentMessages({ segment: s, system: 'x' }),
    runner: async (seg) => { calls2.push(seg.segment_id); if (calls2.length === 2) signal.cancelled = true; return seg.target.text + '（x）'; },
  });
  ok('取消后不再调用后续片', cancelRun.cancelled === true && calls2.length === 2, `调用 ${calls2.length} 次`);
  ok('取消不产生可合并结果（覆盖不通过）', !L.buildCoverageManifest({ source: src, plan, results: cancelRun.results }).ok);
}

console.log('\n【9. 语义审稿分片报告合并 + UI 摘要】');
{
  const src = makeChapter(16);
  const plan = L.planTask({ text: src, kind: 'review', limits: TIGHT });
  const results = plan.segments.map((seg, i) => ({
    segment_id: seg.segment_id, ordinal: seg.ordinal, source_version: plan.source_version, status: 'done', output: '{}',
    report: { summary: `第${i + 1}片总评`, issues: [{ text: '节奏偏慢' }], strengths: [{ text: '对白自然' }] },
  }));
  const mergedReport = L.mergeReviewReports({ plan, results });
  ok('合并报告带片号归属（形态与单请求审稿一致：字符串数组）', mergedReport.issues.length === plan.segments.length
    && typeof mergedReport.issues[0] === 'string' && mergedReport.issues[0].includes(plan.segments[0].segment_id)
    && mergedReport.attribution.length === plan.segments.length * 2);
  ok('总评与优点同样按片合并', mergedReport.summary.includes('第1片总评') && mergedReport.strengths.length === plan.segments.length);
  const summary = L.summaryText({ plan, results, manifest: L.buildCoverageManifest({ source: src, plan, results }) });
  ok('摘要含原文档位/片数/覆盖结论/未解决项字段', summary.some((l) => l.includes('原文版本')) && summary.some((l) => l.includes('目标范围')) && summary.some((l) => l.includes('覆盖')) && summary.some((l) => l.includes('结论')));
  const singlePlan = L.planTask({ text: '短文本', kind: 'polish', probeMessages: [{ role: 'user', content: '短文本' }] });
  ok('单请求任务的摘要说明"无需分片"', L.summaryText({ plan: singlePlan }).some((l) => l.includes('单请求')));
}

console.log('\n' + '─'.repeat(46));
console.log(`R08 长正文分段离线测试：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f.name + (f.detail ? '  — ' + f.detail : '')); process.exit(1); }
console.log('（零计费：本测试不发起任何模型请求）');
