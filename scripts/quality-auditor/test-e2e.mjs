#!/usr/bin/env node
/**
 * test-e2e.mjs —— 六项 / 八项样本的端到端断言（零计费，外部 runner 模式）。
 *
 * 与 test-contracts 的分工：那边验协议与边界；这里验**语义结论**：
 *   · 每个已选项都有唯一终态；
 *   · PARTIAL/FAIL 才进入定向复修；
 *   · 任一未通过就不能是"全部完成"；
 *   · 候选 hash 变化让旧审计变 STALE。
 *
 * 样本来自仓库冻结夹具 `tests/narrative-repair/fixtures/chapter1-six-issues`（六项），
 * 八项样本 = 六项 + 两项补充（引用同样取自样本正文），用于验证"分母变大后结论仍自洽"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks } from '../../tests/narrative-repair/harness.mjs';
import { jfetch, startServer, stopServer, waitReady, freePort, tempDir, cleanup } from './harness.mjs';

const { check, finish } = createChecks();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', '..', 'tests', 'narrative-repair', 'fixtures', 'chapter1-six-issues');
const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'review-report.json'), 'utf8'));

// 正文 = 每条 finding 的逐字引用 + 连接句（保证 quote 一定存在；文学质量不是本测试的对象）
const filler = ['雨还在下，窗上水痕慢慢铺开。', '屋里很静，只有纸页翻动的声音。', '门外的脚步声停了又起。'];
const quotes = fixture.findings.map((f) => String((f.evidence && f.evidence[0] && f.evidence[0].quote) || (f.evidence || []).map?.((e) => e.quote).join('') || '')).filter(Boolean);
const ARTICLE = [...quotes.flatMap((q, i) => [q, filler[i % filler.length]]), '陈默把信折好，放回口袋。'].join('\n');

const PORT = await freePort();
const DATA = tempDir('novel-qa-e2e-');
const srv = startServer({ port: PORT, dataDir: DATA });
if (!(await waitReady(srv.base))) { console.error(srv.log.text.slice(-2000)); await stopServer(srv); cleanup(DATA); process.exit(2); }

const work = await jfetch(srv.base, '/api/works', { method: 'POST', body: { title: '六项样本' } });
const chapter = await jfetch(srv.base, '/api/chapters', {
  method: 'POST',
  body: { work_id: work.data.id, title: '第一章', content: ARTICLE.split('\n').map((l) => `<p>${l}</p>`).join('') },
});

// 初审按夹具落库（issues 对象 + findings）
const report = {
  schema_version: 'review.v3',
  summary: fixture.summary || '六项样本',
  strengths: fixture.strengths || [],
  deferred: fixture.deferred || [],
  // 夹具里 issues 是**纯字符串**、findings 自带 Q01…：按同序契约绑定（与服务端同一规则）。
  issues: fixture.issues.map((it, i) => ({
    id: (fixture.findings[i] && fixture.findings[i].id) || `Q0${i + 1}`,
    text: typeof it === 'string' ? it : (it.text || it.title || ''),
    source: 'initial_review', link_mode: 'explicit',
    finding_id: (fixture.findings[i] && fixture.findings[i].id) || `Q0${i + 1}`,
  })),
  findings: fixture.findings.map((f) => ({
    id: f.id, title: f.title || f.type || f.id, type: f.type || 'other', severity: f.severity || 'medium',
    confidence: f.confidence == null ? 0.8 : f.confidence,
    evidence: f.evidence || [],
    // 端到端测的是**裁决管线**，不是夹具的 preserve 语义：去掉 preserve 噪声，
    // 让 PASS/PARTIAL/FAIL 由 auditor 判据 + 证据残留决定。
    acceptance: { rule: (f.acceptance && f.acceptance.rule) || '按问题描述修复', preserve: [] },
  })),
};
const seeded = await jfetch(srv.base, '/api/novel/review', {
  method: 'PUT', body: { chapter_id: chapter.data.id, base_text: ARTICLE, base_hash: 'sha256:e2e-six', report },
});
const reviewId = seeded.data.review_id;
const ids = report.issues.map((i) => i.id);

// 候选稿：Q02/Q05/Q06 的真证据被删（视为已改），Q03 原句保留（视为没改），Q01 只改一半。
const CANDIDATE = (() => {
  let text = ARTICLE;
  for (const sid of ['Q02', 'Q05', 'Q06']) {
    const f = report.findings.find((x) => x.id === sid);
    const q = f && f.evidence && f.evidence[0] && f.evidence[0].quote;
    if (q) text = text.split(q).join('（已改）');
  }
  const f1 = report.findings.find((x) => x.id === 'Q01');
  const q1 = f1 && f1.evidence && f1.evidence[0] && f1.evidence[0].quote;
  if (q1) text = text.replace(q1, q1.slice(0, Math.max(2, Math.floor(q1.length / 2))));
  return text;
})();

const created = await jfetch(srv.base, '/api/novel/quality-audits', {
  method: 'POST',
  body: {
    kind: 'revision', chapter_id: chapter.data.id, review_id: reviewId,
    base_text: ARTICLE, candidate_text: CANDIDATE,
    base_hash: 'sha256:e2e-six', candidate_hash: 'sha256:e2e-cand-1',
    selected_issue_ids: ids,
    findings: report.findings,
    patches: ids.map((id) => ({ issue_id: id, original: (report.findings.find((f) => f.id === id)?.evidence?.[0]?.quote) || '', replacement: '' })),
    start: false,
  },
});
if (created.status !== 201) { console.error('创建修稿审计失败：' + JSON.stringify(created.data).slice(0, 600)); await stopServer(srv); cleanup(DATA); process.exit(2); }
const auditId = created.data.audit_id;
const token = created.data.token;
const TH = { 'x-audit-token': token };

const verdicts = { Q01: 'PARTIAL', Q02: 'PASS', Q03: 'FAIL', Q04: 'NEED_CONTEXT', Q05: 'PASS', Q06: 'PASS' };
const finalPayload = {
  schema_version: 'revision-audit.v1',
  base_hash: 'sha256:e2e-six', candidate_hash: 'sha256:e2e-cand-1',
  issues: ids.map((id) => ({
    issue_id: id, verdict: verdicts[id] || 'PASS',
    reason: `${id} 人工参考真值口径`, remaining_evidence: [], checks: [], repair_hint: verdicts[id] === 'PASS' ? '' : '只处理残留',
  })),
  regressions: [], unauthorized_changes: [],
  overall: 'PARTIAL',
};
const submitted = await jfetch(srv.base, `/api/novel/quality-audits/${auditId}/submissions`, { method: 'POST', headers: TH, body: { operation: 'final', payload: finalPayload } });
const verified = await jfetch(srv.base, `/api/novel/quality-audits/${auditId}/verify`, { method: 'POST', body: {} });
const merged = await jfetch(srv.base, `/api/novel/quality-audits/${auditId}/merge`, { method: 'POST', body: {} });
const m = merged.data?.merged || {};
const byId = Object.fromEntries((m.issues || []).map((i) => [i.issue_id, i.final]));
check('E2E-6.1', '六项样本：每个已选项都有唯一终态，且与审查口径一致',
  submitted.status === 200 && verified.status === 200 && merged.status === 200
    && ids.every((id) => Boolean(byId[id]))
    && byId.Q01 === 'PARTIAL' && byId.Q03 === 'FAIL' && byId.Q04 === 'NEED_CONTEXT'
    && byId.Q02 === 'PASS' && byId.Q05 === 'PASS' && byId.Q06 === 'PASS',
  JSON.stringify({ byId, s: submitted.status, v: verified.status, m: merged.status, data: merged.data, submitted: submitted.data, verified: verified.data }));
check('E2E-6.2', '六项样本：PARTIAL/FAIL 进入定向复修，NEED_CONTEXT 不进，PASS 不进',
  JSON.stringify((m.repair_targets || []).sort()) === JSON.stringify(['Q01', 'Q03'])
    && m.all_pass === false && m.overall !== 'PASS',
  JSON.stringify({ targets: m.repair_targets, overall: m.overall, all_pass: m.all_pass }));
check('E2E-6.3', '六项样本：计数自洽（selected = pass+partial+fail+need_context+blocked+stale）',
  (() => { const c = m.counts || {}; return Number(c.selected) === 6 && (Number(c.pass) + Number(c.partial) + Number(c.fail) + Number(c.need_context) + Number(c.blocked) + Number(c.stale)) === 6; })(),
  JSON.stringify(m.counts));

// ── 八项样本：六项 + 两项补充（引用取自正文）─────────────────────────────────
const extra = [
  { id: 'Q07', title: '补充一：转折处缺少过渡', quote: filler[0], verdict: 'PASS' },
  { id: 'Q08', title: '补充二：越权改动（示例）', quote: filler[1], verdict: 'BLOCKED_SCOPE' },
];
const report8 = {
  ...report,
  issues: [...report.issues, ...extra.map((e) => ({ id: e.id, text: e.title, source: 'initial_review', link_mode: 'explicit', finding_id: e.id }))],
  findings: [...report.findings, ...extra.map((e) => ({ id: e.id, title: e.title, type: 'style', severity: 'low', confidence: 0.8, evidence: [{ quote: e.quote }], acceptance: { rule: '按描述修复', preserve: [] } }))],
};
const seeded8 = await jfetch(srv.base, '/api/novel/review', {
  method: 'PUT', body: { chapter_id: chapter.data.id, base_text: ARTICLE, base_hash: 'sha256:e2e-eight', report: report8 },
});
const ids8 = report8.issues.map((i) => i.id);
const created8 = await jfetch(srv.base, '/api/novel/quality-audits', {
  method: 'POST',
  body: {
    kind: 'revision', chapter_id: chapter.data.id, review_id: seeded8.data.review_id,
    base_text: ARTICLE, candidate_text: CANDIDATE,
    base_hash: 'sha256:e2e-eight', candidate_hash: 'sha256:e2e-cand-8',
    selected_issue_ids: ids8, findings: report8.findings, patches: [], start: false,
  },
});
if (created8.status !== 201) { console.error('八项审计创建失败：' + JSON.stringify(created8.data).slice(0, 600)); await stopServer(srv); cleanup(DATA); process.exit(2); }
const t8 = created8.data.token;
const a8 = created8.data.audit_id;
const verdict8 = { Q01: 'PARTIAL', Q02: 'PASS', Q03: 'FAIL', Q04: 'PASS', Q05: 'PASS', Q06: 'PASS', Q07: 'PASS', Q08: 'BLOCKED_SCOPE' };
const payload8 = {
  schema_version: 'revision-audit.v1', base_hash: 'sha256:e2e-eight', candidate_hash: 'sha256:e2e-cand-8',
  issues: ids8.map((id) => ({ issue_id: id, verdict: verdict8[id] || 'PASS', reason: '样本口径', remaining_evidence: [], checks: [], repair_hint: '' })),
  regressions: [], unauthorized_changes: [], overall: 'PARTIAL',
};
const s8 = await jfetch(srv.base, `/api/novel/quality-audits/${a8}/submissions`, { method: 'POST', headers: { 'x-audit-token': t8 }, body: { operation: 'final', payload: payload8 } });
const v8 = await jfetch(srv.base, `/api/novel/quality-audits/${a8}/verify`, { method: 'POST', body: {} });
const m8 = await jfetch(srv.base, `/api/novel/quality-audits/${a8}/merge`, { method: 'POST', body: {} });
const mm8 = m8.data?.merged || {};
const byId8 = Object.fromEntries((mm8.issues || []).map((i) => [i.issue_id, i.final]));
check('E2E-8.1', '八项样本：全部 8 项都有终态（不靠人工通读发现漏修）',
  s8.status === 200 && v8.status === 200 && m8.status === 200 && ids8.every((id) => Boolean(byId8[id])) && ids8.length === 8,
  JSON.stringify(byId8));
check('E2E-8.2', '八项样本：存在 BLOCKED_SCOPE 时不得显示全部完成；复修目标只含 PARTIAL/FAIL（不含越权项）',
  byId8.Q08 === 'BLOCKED_SCOPE' && mm8.all_pass === false && mm8.overall !== 'PASS'
    && (mm8.repair_targets || []).every((id) => ['PARTIAL', 'FAIL'].includes(byId8[id]))
    && !(mm8.repair_targets || []).includes('Q08'),
  JSON.stringify({ overall: mm8.overall, all_pass: mm8.all_pass, targets: mm8.repair_targets, byId8 }));

// candidate hash 变化 → 旧审计 STALE
{
  const again = await jfetch(srv.base, '/api/novel/quality-audits', {
    method: 'POST',
    body: {
      kind: 'revision', chapter_id: chapter.data.id, review_id: seeded8.data.review_id,
      base_text: ARTICLE, candidate_text: CANDIDATE + '（再改一处）',
      base_hash: 'sha256:e2e-eight', candidate_hash: 'sha256:e2e-cand-9',
      selected_issue_ids: ids8, findings: report8.findings, patches: [], start: false,
    },
  });
  const old = await jfetch(srv.base, `/api/novel/quality-audits/${a8}`);
  check('E2E-STALE', '候选稿 hash 变化：上一份审计立即 STALE，不能继续当「已通过」',
    again.status === 201 && old.data.run.status === 'STALE',
    JSON.stringify({ new: again.status, old: old.data.run.status }));
}

await stopServer(srv);
cleanup(DATA);
finish('六项 / 八项样本端到端');
