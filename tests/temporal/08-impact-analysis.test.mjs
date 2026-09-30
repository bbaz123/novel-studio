#!/usr/bin/env node
/**
 * tests/temporal/08-impact-analysis.test.mjs —— T3「全下游失效 + 隐性因果复核」验收（零计费、零生成）。
 *
 * 覆盖任务书 §7.2 强制夹具（真实服务 + 临时隔离库 + 本机确定性 fake provider）：
 *   夹具 A  第6章无姓名但等待接应（依赖王师傅存活）→ 因果前提冲突，进入修订候选
 *   夹具 B  第6章无姓名且任务完全独立 → 复核通过，正文 revision 不变，新增验证绑定
 *   夹具 C  第7章依赖夹具 A 中第6章的旧结果 → 第7章复核输入使用第6章的新候选前缀（T3 证明接线；修稿在 T4）
 *   夹具 D  第8章人物直接参与当下行动 → 报告显式冲突（叙事时间证据）
 *   夹具 E  第8章仅回忆/梦境 → 不因姓名误报复活（needs_review，不出现"复活"冲突）
 *   变异测试：把覆盖集合改成仅显式命中（explicit_hits_only）后夹具 A 必须失败。
 *
 * 同时断言：模型适配器收到的输入包含"已变化的上游事实 + 行动前提"（AC-04）；
 * writer.generate 调用数严格为 0、正文 hash / 修订数不变（AC-14）；根事实未确认 → 仅 tentative（AC-13）；
 * 原生成来源保留、新增验证来源（AC-31）。
 */
import { createHash } from 'node:crypto';
import { isolatedDir, suiteAsync, seedWork } from './harness.mjs';

isolatedDir('ns-impact-');
const { db } = await import('../../db.js');
const T = await import('../../ai/story-state/temporal/index.mjs');
const A = await import('../../ai/repair/analyzer.mjs');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sha1 = (s) => createHash('sha1').update(String(s == null ? '' : s)).digest('hex');

const cellChar = (name, predicate = 'status') => ({ domain: 'character', entityId: name, predicate, scope: 'canon' });
const cellItem = (name) => ({ domain: 'item', entityId: name, predicate: 'owner', scope: 'canon' });
const cellFact = (name) => ({ domain: 'world_fact', entityId: name, predicate: 'known', scope: 'canon' });

/** 章前该 cell 的真实值 → expected（与生产抽取口径一致：expected 必须是章前状态）。 */
function expectedOf(workId, chapterId, cell) {
  const view = T.stateAtChapter({ workId, chapterId, boundary: 'before' });
  const key = T.cellKey(cell);
  if (view && view.state instanceof Map && view.state.has(key)) return { kind: 'value', value: view.state.get(key) };
  return { kind: 'missing' };
}
function opSet(workId, chapterId, cell, value) {
  return { type: 'set', cell, expected: expectedOf(workId, chapterId, cell), value };
}
function eventOf(ops, quote, narrative = 'present') {
  return { ops, evidence: [{ quote, narrative }] };
}

/** 生产口径的正文写入（先写 chapters.content，再走统一保存后处理）。 */
function writeContent(chapterId, text) {
  db.prepare('UPDATE chapters SET content = ?, updated_at = ? WHERE id = ?').run(`<p>${text}</p>`, new Date().toISOString(), chapterId);
}

/** 确定性 fake 抽取 provider：按章返回 events/assumptions（引文必须来自正文）。 */
function extractionFake(byChapter) {
  const calls = [];
  const fn = async ({ chapter_id, user, system }) => {
    calls.push({ chapter_id: Number(chapter_id), purpose: 'extraction', user, system });
    const spec = byChapter[Number(chapter_id)];
    if (!spec) return JSON.stringify({ events: [], assumptions: [] });
    const events = typeof spec.events === 'function' ? spec.events() : (spec.events || []);
    return JSON.stringify({ events, assumptions: spec.assumptions || [] });
  };
  fn.calls = calls;
  fn.purpose = 'extraction';
  return fn;
}

/** 一次保存 → 自动抽取（force）→ 提案组 → 作者确认（走真实服务）。 */
async function saveAnalyzeConfirm({ workId, chapterId, text, generate }) {
  writeContent(chapterId, text);
  const saved = T.recordContentSave({ workId, chapterId, contentHtml: `<p>${text}</p>`, origin: { kind: 'editor_save' } });
  if (!saved.enabled || !saved.recorded) throw new Error(`保存后处理未记录修订：${JSON.stringify(saved).slice(0, 240)}`);
  const res = await T.analyzeChapter({ workId, chapterId, generate, force: true, provider: 'fake' });
  if (!res.ok || res.status !== 'done') throw new Error(`抽取未完成：${JSON.stringify(res).slice(0, 320)}`);
  const groups = T.listProposalGroups({ workId, chapterId });
  const proposal = (groups.proposals || [])[0];
  if (!proposal) throw new Error(`第 ${chapterId} 章没有待确认提案组`);
  const conf = T.confirmBinding({ workId, chapterId, bindingId: proposal.binding_id });
  if (!conf.ok) throw new Error(`第 ${chapterId} 章确认失败：${JSON.stringify(conf).slice(0, 400)}`);
  return { bindingId: proposal.binding_id, revisionId: conf.revision_id, commitId: conf.commit_id, validation: conf.validation };
}

/** 确定性 fake 复核 provider：结论完全由输入（变化清单 + 章前状态 + 正文 + 行动前提）决定。 */
function impactFake() {
  const calls = [];
  const fn = async (args) => {
    calls.push({ chapter_id: Number(args.chapter_id), purpose: args.purpose, user: args.user, system: args.system, run_id: args.run_id, model: args.model });
    return decide(args.user);
  };
  fn.calls = calls;
  fn.purpose = 'impact_analysis';
  return fn;
}
function section(user, re, nextRe) {
  const i = user.indexOf(re);
  if (i < 0) return '';
  const rest = user.slice(i + re.length);
  const j = nextRe ? rest.search(nextRe) : -1;
  return (j >= 0 ? rest.slice(0, j) : rest).trim();
}
function decide(user) {
  const namesLine = (/(?:^|\n)正文姓名命中[^\n]*：([^\n]*)/.exec(user) || [])[1] || '';
  const names = /^（无/.test(namesLine) ? [] : namesLine.split('、').filter(Boolean);
  const changesBlock = section(user, '【世界线变化', '【章前最新状态');
  const assumptionsBlock = section(user, '【本章既有行动前提', '【本章正文');
  const textBlock = section(user, '【本章正文（原文，未改动）】', '请输出 JSON');
  const dead = /战死|死亡|死了/.test(changesBlock);
  for (const name of names) {
    for (const sentence of textBlock.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (!sentence.includes(name)) continue;
      if (/回忆|想起|梦见|梦到|当年|曾经|据说|转述|要是|如果/.test(sentence)) {
        return JSON.stringify({
          decision: 'needs_review', conflicts: [],
          checked: [{ assumption: `${name} 只出现在回忆/梦境/转述中`, verdict: 'unknown', quote: sentence.slice(0, 40) }],
          notes: '叙述类型不是当下行动：不能据此报告现状。',
        });
      }
      return JSON.stringify({
        decision: 'conflict',
        conflicts: [{ kind: 'explicit', premise: `${name} 在新世界线下不能参与当下行动`, quote: sentence.slice(0, 40), detail: '正文把该角色写进当下行动' }],
        checked: [], notes: '显式冲突：结合故事时间与已确认事实。',
      });
    }
  }
  if (dead && /王师傅|接应/.test(assumptionsBlock)) {
    return JSON.stringify({
      decision: 'conflict',
      conflicts: [{ kind: 'implicit_causal', premise: '本章行动依赖王师傅仍能履约（旧前提已失效）', quote: '', detail: '正文无姓名，但行动前提/资源/承诺依赖已死亡角色。' }],
      checked: [{ assumption: '接应安排依赖王师傅仍能履约', verdict: 'fails', quote: '' }],
      notes: '隐性因果冲突：无姓名也必须复核动机与行动前提。',
    });
  }
  return JSON.stringify({
    decision: 'valid', conflicts: [],
    checked: [{ assumption: '本章行动前提在新世界线下仍成立', verdict: 'holds', quote: '' }],
    notes: '正文在新世界线下仍然完全成立。',
  });
}

const ROOT_TEXT = '王师傅战死在黑风谷口。';

/** 1–5 章公共前情（真实保存 → 抽取 → 确认链路）。 */
async function setupPrologue(title, chapters = 8) {
  const { workId, chapterIds } = seedWork(db, { title, chapters });
  T.setTemporalConfig(workId, { temporal_enabled: true, auto_analysis_enabled: true, repair_enabled: true });
  const [c1, c2, c3, c4, c5] = chapterIds;
  const extract = extractionFake({
    [c1]: { events: () => [eventOf([opSet(workId, c1, cellChar('王师傅'), '在青云镇')], '王师傅是青云镇的老镖师')], assumptions: [] },
    [c2]: { events: () => [eventOf([opSet(workId, c2, cellChar('主角'), '在青云镇')], '主角在青云镇替人看病')], assumptions: [] },
    [c3]: { events: () => [eventOf([opSet(workId, c3, cellChar('主角', 'title'), '有徒弟')], '主角收了个徒弟')], assumptions: [] },
    [c4]: { events: () => [eventOf([opSet(workId, c4, cellFact('黑风谷'), true)], '黑风谷是条险路')], assumptions: [] },
    [c5]: { events: () => [eventOf([opSet(workId, c5, cellChar('王师傅'), '同行')], '王师傅收拾行装')], assumptions: [] },
  });
  await saveAnalyzeConfirm({ workId, chapterId: c1, text: '王师傅是青云镇的老镖师。', generate: extract });
  await saveAnalyzeConfirm({ workId, chapterId: c2, text: '主角在青云镇替人看病。', generate: extract });
  await saveAnalyzeConfirm({ workId, chapterId: c3, text: '主角收了个徒弟叫阿禾。', generate: extract });
  await saveAnalyzeConfirm({ workId, chapterId: c4, text: '黑风谷是条险路，常年有匪。', generate: extract });
  await saveAnalyzeConfirm({ workId, chapterId: c5, text: '王师傅收拾行装，说要陪主角走一趟。', generate: extract });
  return { workId, chapterIds, c1, c2, c3, c4, c5, c6: chapterIds[5], c7: chapterIds[6], c8: chapterIds[7] };
}

/** 对已保存的待确认正文执行抽取 + 作者确认（不重复保存）。 */
async function analyzeConfirmPending({ workId, chapterId, generate }) {
  const res = await T.analyzeChapter({ workId, chapterId, generate, force: true, provider: 'fake' });
  if (!res.ok || res.status !== 'done') throw new Error(`抽取未完成：${JSON.stringify(res).slice(0, 320)}`);
  const groups = T.listProposalGroups({ workId, chapterId });
  const proposal = (groups.proposals || [])[0];
  if (!proposal) throw new Error(`第 ${chapterId} 章没有待确认提案组`);
  const conf = T.confirmBinding({ workId, chapterId, bindingId: proposal.binding_id });
  if (!conf.ok) throw new Error(`第 ${chapterId} 章确认失败：${JSON.stringify(conf).slice(0, 400)}`);
  return { bindingId: proposal.binding_id, revisionId: conf.revision_id, commitId: conf.commit_id, validation: conf.validation };
}

/** 根变更：第 5 章王师傅 存活(同行) → 战死（保存新正文 → 抽取 → 作者确认）。 */
async function changeRoot(workId, c5, { alreadySaved = false } = {}) {
  const extract = extractionFake({
    [c5]: { events: () => [eventOf([opSet(workId, c5, cellChar('王师傅'), '战死')], '王师傅战死在黑风谷口')], assumptions: [] },
  });
  if (alreadySaved) return analyzeConfirmPending({ workId, chapterId: c5, generate: extract });
  return saveAnalyzeConfirm({ workId, chapterId: c5, text: ROOT_TEXT, generate: extract });
}

function countRevisions(chapterIds) {
  return db.prepare(`SELECT COUNT(*) c FROM story_chapter_revisions WHERE chapter_id IN (${chapterIds.map(() => '?').join(',')})`).get(...chapterIds).c;
}
function contentHashes(chapterIds) {
  return chapterIds.map((id) => sha1(db.prepare('SELECT content FROM chapters WHERE id = ?').get(id).content));
}
function bindingOf(chapterId) {
  const row = db.prepare(`SELECT b.* FROM story_chapter_bindings b WHERE b.chapter_id = ? AND b.validity = 'valid' ORDER BY b.created_at DESC, b.id DESC LIMIT 1`).get(chapterId);
  return row ? T.getBinding(row.id) : null;
}
function bindingCount(chapterId) {
  return db.prepare('SELECT COUNT(*) c FROM story_chapter_bindings WHERE chapter_id = ?').get(chapterId).c;
}

await suiteAsync('[08] T3 全下游失效与隐性因果复核', [
  ['夹具 A + C + 变异对照：无姓名隐性因果必须被保守覆盖送入复核（AC-04/06/13/14/31）', async () => {
    const { workId, chapterIds, c5, c6, c7 } = await setupPrologue('T3 夹具A/C（自动化测试，自清理）', 7);
    // 夹具 A：第6章没有王师傅姓名，但等待"说好的接应"（隐性因果前提）
    // 夹具 C：第7章依赖第6章的结果（通行令牌）
    const extractAC = extractionFake({
      [c6]: {
        events: () => [eventOf([opSet(workId, c6, cellChar('主角'), '在黑风谷')], '他按约定动身前往黑风谷')],
        assumptions: [{ kind: 'promise', statement: '接应安排依赖王师傅仍能履约（旧前提：王师傅活着）', quote: '等待那支说好的接应' }],
      },
      [c7]: {
        events: () => [eventOf([opSet(workId, c7, cellItem('通行令牌'), '主角')], '拿到了约定中的通行令牌')],
        assumptions: [{ kind: 'resource', statement: '通行令牌来自接应人，其履约依赖王师傅存活', quote: '拿到了约定中的通行令牌' }],
      },
    });
    await saveAnalyzeConfirm({ workId, chapterId: c6, text: '夜色里，主角守在镇口，等待那支说好的接应。三更时分，他按约定动身前往黑风谷。', generate: extractAC });
    await saveAnalyzeConfirm({ workId, chapterId: c7, text: '主角在黑风谷与接应人碰头，拿到了约定中的通行令牌。', generate: extractAC });
    // ── 根变更先保存、不确认：影响只能 tentative（AC-13）──
    writeContent(c5, ROOT_TEXT);
    T.recordContentSave({ workId, chapterId: c5, contentHtml: `<p>${ROOT_TEXT}</p>`, origin: { kind: 'editor_save' } });
    const bindingsBeforeTentative = bindingCount(c6) + bindingCount(c7);
    const tentativeFake = impactFake();
    const tentative = await A.runImpactAnalysis({ workId, rootChapterId: c5, generate: tentativeFake, refresh: true });
    ok('AC-13 根事实未确认 → 仅 tentative', tentative.ok === true && tentative.tentative === true && tentative.report.tentative === true && tentative.run.status === 'needs_review');
    ok('AC-13 tentative 不调用模型', tentativeFake.calls.length === 0, `calls=${tentativeFake.calls.length}`);
    ok('AC-13 tentative 不产生候选绑定', bindingCount(c6) + bindingCount(c7) === bindingsBeforeTentative);
    // ── 作者确认根变更（真实链路）→ 下游应已被标记待验证 ──
    await changeRoot(workId, c5, { alreadySaved: true });
    const trust = T.trustReport({ workId });
    const staleIds = trust.chapters.filter((x) => x.validity === 'stale').map((x) => Number(x.chapter_id));
    ok('根变更确认后下游进入 stale（先保守标记）', staleIds.includes(c6) && staleIds.includes(c7), JSON.stringify(staleIds));
    const ch6Before = bindingOf(c6);
    const ch7Before = bindingOf(c7);
    const revisionsBefore = countRevisions([c6, c7]);
    const hashesBefore = contentHashes(chapterIds);
    const fake = impactFake();
    const writer = { calls: 0, generate: () => { writer.calls += 1; return '不应被调用的生成稿'; } };
    const run = await A.runImpactAnalysis({ workId, rootChapterId: c5, generate: fake, writer, model: 'fake-impact', provider: 'fake' });
    const report = run.report || {};
    ok('运行完成且覆盖全部下游（保守 all_downstream）', run.ok === true && report.coverage && report.coverage.mode === 'all_downstream' && report.totals.downstream === 2 && report.coverage.chapters.join(',') === `${c6},${c7}`);
    const e6 = (report.downstream || []).find((x) => x.chapter_id === c6) || {};
    const e7 = (report.downstream || []).find((x) => x.chapter_id === c7) || {};

    ok('夹具A：无姓名（显式出场/依赖为空）仍判因果前提冲突', e6.status === 'conflict' && (e6.explicit_appearances || []).length === 0 && (e6.explicit_dependencies || []).length === 0 && (e6.implicit_causal || []).length > 0, JSON.stringify({ status: e6.status, app: e6.explicit_appearances, dep: e6.explicit_dependencies, imp: e6.implicit_causal }).slice(0, 300));
    const call6 = fake.calls.find((x) => x.chapter_id === c6);
    ok('AC-04 第6章确实被送入模型复核，且输入含变化后的上游事实与行动前提', !!call6 && call6.purpose === 'impact_analysis' && call6.user.includes('战死') && call6.user.includes('接应') && call6.user.includes('等待那支说好的接应'), call6 ? `has战死=${call6.user.includes('战死')} has接应=${call6.user.includes('接应')}` : 'no call');
    ok('AC-14 第6章正文修订未变（不生成修订稿）', String((T.latestRevisionOf(c6) || {}).id) === String(ch6Before.revision_id) && e6.revision_unchanged === true);
    ok('夹具C：第7章复核输入使用第6章候选提交（新前缀），并停在新候选冲突处而非旧计划', e7.status === 'blocked' && e7.input && e7.input.commit_id === e6.candidate_commit_id && e7.input.stop && Number(e7.input.stop.chapter_id) === c6 && String(e7.input.stop.reason) === 'conflict', JSON.stringify({ status: e7.status, input: e7.input && { commit_id: e7.input.commit_id, stop: e7.input.stop } }).slice(0, 300));
    const call7 = fake.calls.find((x) => x.chapter_id === c7);
    ok('夹具C：第7章仍被送入初筛复核（跨冲突不静默跳过）', !!call7 && call7.user.includes('战死'));
    ok('AC-31 原生成来源保留、新增验证来源（旧绑定不变，新绑定指向旧绑定）', !!ch6Before && (T.getBinding(ch6Before.id) || {}).validity === 'valid' && String(ch6Before.revision_id) === String(e6.kept_revision_id || ch6Before.revision_id) && (T.getBinding(e6.candidate_binding_id).validation.revalidation || {}).base_binding_id === ch6Before.id);
    ok('AC-14 后文生成适配器调用数为 0 且无新修订/正文 hash 不变', writer.calls === 0 && report.totals.generated_revisions === 0 && countRevisions([c6, c7]) === revisionsBefore && JSON.stringify(contentHashes(chapterIds)) === JSON.stringify(hashesBefore));
    ok('全部模型调用都只是复核（purpose=impact_analysis），没有生成请求', fake.calls.length >= 2 && fake.calls.every((x) => x.purpose === 'impact_analysis'));
    const steps = A.impactRunView({ workId, runId: run.run.id });
    ok('运行与逐章步骤已落库（可恢复断点）', steps.ok === true && steps.steps.length === 2 && steps.steps.some((s) => Number(s.chapter_id) === c6 && s.status === 'conflict') && steps.steps.some((s) => Number(s.chapter_id) === c7 && s.status === 'blocked'));
    ok('第7章旧绑定未被改写（生成来源保留）', !!ch7Before && (T.getBinding(ch7Before.id) || {}).validity === 'valid');
    // ── 变异测试：去掉"全后缀保守传播"（只留显式命中）后，夹具A 必须失败 ──
    const mutation = await A.runImpactAnalysis({ workId, rootChapterId: c5, coverage: 'explicit_hits_only', refresh: true, generate: impactFake(), model: 'fake-mutation' });
    const mReport = mutation.report || {};
    const m6 = (mReport.downstream || []).find((x) => x.chapter_id === c6);
    ok('变异对照：仅显式命中时夹具A 不再被发现（保守传播是必要条件）', mutation.ok === true && mReport.coverage.mode === 'explicit_hits_only' && mReport.coverage.skipped >= 1 && !m6, JSON.stringify({ mode: mReport.coverage && mReport.coverage.mode, skipped: mReport.coverage && mReport.coverage.skipped, m6: !!m6 }).slice(0, 240));
  }],
  ['夹具 B + D：独立章节保留原文、显式出场报告冲突（AC-05/07/31）', async () => {
    const { workId, chapterIds, c5, c6, c7, c8 } = await setupPrologue('T3 夹具B/D（自动化测试，自清理）', 8);
    const extract = extractionFake({
      [c6]: {
        events: () => [eventOf([{ type: 'set', cell: { domain: 'knowledge', entityId: '账册疑点', predicate: 'known', scope: 'character', holderId: '主角' }, expected: { kind: 'missing' }, value: true }], '独自在书房翻查账册')],
        assumptions: [{ kind: 'goal', statement: '独立查账：不依赖任何人的履约或存活', quote: '独自在书房翻查账册' }],
      },
      [c7]: {
        events: () => [eventOf([opSet(workId, c7, cellItem('册子'), '县衙')], '把抄好的册子交给县衙的师爷')],
        assumptions: [{ kind: 'goal', statement: '独立送册：只依赖自己抄好的册子', quote: '把抄好的册子交给县衙的师爷' }],
      },
      [c8]: {
        events: () => [eventOf([opSet(workId, c8, cellFact('山谷伏击'), true)], '并肩杀入山谷')],
        assumptions: [],
      },
    });
    await saveAnalyzeConfirm({ workId, chapterId: c6, text: '主角独自在书房翻查账册，把可疑的数目抄进册子。', generate: extract });
    await saveAnalyzeConfirm({ workId, chapterId: c7, text: '主角把抄好的册子交给县衙的师爷。', generate: extract });
    await saveAnalyzeConfirm({ workId, chapterId: c8, text: '王师傅提刀冲在最前面，与主角并肩杀入山谷。', generate: extract });
    await changeRoot(workId, c5);
    const ch6Before = bindingOf(c6);
    const revisionsBefore = countRevisions([c6, c7, c8]);
    const hashesBefore = contentHashes(chapterIds);
    const fake = impactFake();
    const writer = { calls: 0, generate: () => { writer.calls += 1; return '不应被调用的生成稿'; } };
    const run = await A.runImpactAnalysis({ workId, rootChapterId: c5, generate: fake, writer, provider: 'fake' });
    const report = run.report || {};
    const e6 = (report.downstream || []).find((x) => x.chapter_id === c6) || {};
    const e7 = (report.downstream || []).find((x) => x.chapter_id === c7) || {};
    const e8 = (report.downstream || []).find((x) => x.chapter_id === c8) || {};
    ok('AC-05 夹具B：复核通过、保留原文、新增验证绑定', e6.status === 'kept' && String(e6.kept_revision_id) === String(ch6Before.revision_id) && e6.candidate_binding_id !== ch6Before.id && e6.revision_unchanged === true, JSON.stringify({ status: e6.status, kept: e6.kept_revision_id, before: ch6Before.revision_id }).slice(0, 240));
    const cand6 = T.getBinding(e6.candidate_binding_id);
    ok('AC-31 新绑定记录验证来源（base_binding_id + 输出状态哈希），旧绑定保持 valid', !!cand6 && (cand6.validation.revalidation || {}).base_binding_id === ch6Before.id && !!cand6.validation.revalidation.output_state_content_hash && (T.getBinding(ch6Before.id) || {}).validity === 'valid');
    ok('夹具C（保留型）：第7章基于第6章新候选前缀复核并通过', e7.status === 'kept' && e7.input && e7.input.commit_id === e6.candidate_commit_id && (e7.input.source_bindings || []).some((r) => r.chapter_id === c6 && r.binding_id === e6.candidate_binding_id), JSON.stringify({ status: e7.status, commit: e7.input && e7.input.commit_id, cand: e6.candidate_commit_id }).slice(0, 240));
    ok('AC-07 夹具D：显式出场结合叙事时间报告冲突（不是靠姓名直判）', e8.status === 'conflict' && (e8.explicit_conflicts || []).length > 0 && (e8.explicit_conflicts || [])[0].kind === 'explicit' && ((e8.explicit_conflicts || [])[0].quote || '').length > 0, JSON.stringify(e8.explicit_conflicts).slice(0, 260));
    const call8 = fake.calls.find((x) => x.chapter_id === c8);
    ok('AC-07 复核输入包含正文姓名命中与当下行动原文', !!call8 && call8.user.includes('王师傅') && call8.user.includes('提刀冲在最前面'));
    ok('AC-14 本轮不生成任何正文（writer=0，修订数不变）', writer.calls === 0 && countRevisions([c6, c7, c8]) === revisionsBefore && JSON.stringify(contentHashes(chapterIds)) === JSON.stringify(hashesBefore));
    ok('报告统计与显式出场汇总一致', report.totals.kept === 2 && report.totals.conflict === 1 && (report.explicit_appearances || []).some((x) => x.chapter_id === c8 && x.names.includes('王师傅')));
  }],
  ['夹具 E：回忆/梦境不因姓名误报复活（AC-08/14）', async () => {
    const { workId, chapterIds, c5, c6, c7, c8 } = await setupPrologue('T3 夹具E（自动化测试，自清理）', 8);
    const extract = extractionFake({
      [c6]: { events: () => [eventOf([opSet(workId, c6, cellFact('账册'), true)], '翻过账册的每一页')], assumptions: [{ kind: 'goal', statement: '独立追查账目', quote: '翻过账册的每一页' }] },
      [c7]: { events: () => [eventOf([opSet(workId, c7, cellItem('账册'), '主角')], '把账册收进随身的包袱')], assumptions: [{ kind: 'goal', statement: '独立保管账册', quote: '把账册收进随身的包袱' }] },
      [c8]: { events: () => [eventOf([opSet(workId, c8, cellChar('主角'), '夜半独坐')], '醒来后他披衣坐起')], assumptions: [] },
    });
    await saveAnalyzeConfirm({ workId, chapterId: c6, text: '主角翻过账册的每一页，记下疑点。', generate: extract });
    await saveAnalyzeConfirm({ workId, chapterId: c7, text: '主角把账册收进随身的包袱。', generate: extract });
    await saveAnalyzeConfirm({ workId, chapterId: c8, text: '夜里，主角梦见王师傅还在镇上教他扎马步。醒来后他披衣坐起。', generate: extract });
    await changeRoot(workId, c5);
    const fake = impactFake();
    const revisionsBefore = countRevisions([c6, c7, c8]);
    const run = await A.runImpactAnalysis({ workId, rootChapterId: c5, generate: fake, provider: 'fake' });
    const report = run.report || {};
    const e8 = (report.downstream || []).find((x) => x.chapter_id === c8) || {};
    const call8 = fake.calls.find((x) => x.chapter_id === c8);
    ok('AC-08 姓名出现但叙述类型是梦境 → needs_review，不判冲突', e8.status === 'needs_review' && (e8.explicit_conflicts || []).length === 0 && (e8.implicit_causal || []).length === 0, JSON.stringify({ status: e8.status, ex: e8.explicit_conflicts, im: e8.implicit_causal }).slice(0, 240));
    ok('AC-08 复核输入包含梦境原文（判据来自输入而非姓名）', !!call8 && call8.user.includes('梦见'));
    ok('报告不出现"复活"式显式冲突', !(report.explicit_dependencies || []).some((x) => x.chapter_id === c8) && (report.blocked || []).length === 0);
    ok('AC-14 正文保持不变、无新修订、无生成调用', countRevisions([c6, c7, c8]) === revisionsBefore && (report.totals || {}).generated_revisions === 0 && fake.calls.every((x) => x.purpose === 'impact_analysis'));
  }],
]);

console.log(`\n[08] 合计：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log(`---- ${f.name}\n${f.detail}`);
  process.exitCode = 1;
}
