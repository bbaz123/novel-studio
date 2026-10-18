#!/usr/bin/env node
// v1.2.0 回归套件 · T07：P08 分析 attempt fencing。由 test-1018-hardening.mjs 串联执行。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'novel-1018-t07-'));
process.env.NOVELSTUDIO_DATA_DIR = dir;
process.env.NOVELSTUDIO_OV_DISABLED = '1';

const { db } = await import('../db.js');
const T = await import('../ai/story-state/temporal/index.mjs');

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };
const seedWork = (title) => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(title, now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(workId, '第1章', '<p>第一章 风起</p>', now, now);
  const chapterId = Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
  return { workId, chapterId };
};
const cell = (domain, entityId, predicate) => ({ domain, entityId, predicate, scope: 'canon' });
const setOp = (c, value) => ({ type: 'set', cell: c, expected: { kind: 'missing' }, value, evidence: [{ quote: '', narrative: 'present' }] });
const countEvents = (chapterId) => Number(db.prepare('SELECT COUNT(*) AS n FROM story_state_events WHERE chapter_id = ?').get(chapterId).n);
const analysisOf = (bindingId) => {
  const row = db.prepare('SELECT validation_json FROM story_chapter_bindings WHERE id = ?').get(bindingId);
  let v = {}; try { v = JSON.parse(row?.validation_json || '{}'); } catch { v = {}; }
  return v.analysis || {};
};

try {
  console.log('【A. 当前 attempt 的 token 校验】');
  const s1 = seedWork('T07-fencing');
  T.setTemporalConfig(s1.workId, { temporal_enabled: true, auto_analysis_enabled: true });
  T.recordContentSave({ workId: s1.workId, chapterId: s1.chapterId, contentHtml: '<p>第一章 风起</p>', origin: { kind: 'manual_save' } });
  ok('A 存在待确认提案', !!T.analysisTarget({ workId: s1.workId, chapterId: s1.chapterId }).binding);
  const begun = T.beginAnalysis({ workId: s1.workId, chapterId: s1.chapterId });
  const token = begun.analysis?.request_id;
  const attemptNo = begun.analysis?.attempts;
  ok('A beginAnalysis 返回 request_id 与 attempt', begun.ok === true && !!token && Number(attemptNo) >= 1, JSON.stringify(begun.analysis));

  const events = [{ cursor: T.cursorOfChapter(s1.workId, s1.chapterId), ops: [setOp(cell('world_fact', '风', 'exists'), true)] }];

  const noToken = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events });
  ok('A 无 token 完成 → stale', noToken.ok === false && noToken.decision === 'stale', JSON.stringify(noToken).slice(0, 200));
  ok('A 无 token 未写事件', countEvents(s1.chapterId) === 0, `events=${countEvents(s1.chapterId)}`);
  ok('A 无 token 未改任务状态', analysisOf(begun.binding_id).status === 'running', JSON.stringify(analysisOf(begun.binding_id)));

  const wrongToken = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events, requestId: 'an_old_attempt', attempt: attemptNo });
  ok('A 旧 token 完成 → stale', wrongToken.ok === false && wrongToken.decision === 'stale', JSON.stringify(wrongToken).slice(0, 200));
  ok('A 旧 token 无数据库副作用', countEvents(s1.chapterId) === 0 && analysisOf(begun.binding_id).status === 'running');

  const wrongAttempt = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events, requestId: token, attempt: Number(attemptNo) + 99 });
  ok('A attempt 不匹配 → stale', wrongAttempt.ok === false && wrongAttempt.decision === 'stale', JSON.stringify(wrongAttempt).slice(0, 200));
  ok('A attempt 不匹配无数据库副作用', countEvents(s1.chapterId) === 0);

  const doneOk = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events, requestId: token, attempt: attemptNo });
  ok('A 正确 token 完成 → ok', doneOk.ok === true, JSON.stringify(doneOk).slice(0, 200));
  ok('A 事件已写入', countEvents(s1.chapterId) > 0, `events=${countEvents(s1.chapterId)}`);
  ok('A 任务状态为 done', analysisOf(begun.binding_id).status === 'done', JSON.stringify(analysisOf(begun.binding_id)));

  const before = countEvents(s1.chapterId);
  const repeated = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events, requestId: token, attempt: attemptNo });
  ok('A 同 token 重复完成 → 幂等回执', repeated.ok === true && repeated.repeated === true, JSON.stringify(repeated).slice(0, 200));
  ok('A 重复完成不重复写事件', countEvents(s1.chapterId) === before, `${before} → ${countEvents(s1.chapterId)}`);

  const lateOld = T.completeAnalysis({ workId: s1.workId, chapterId: s1.chapterId, bindingId: begun.binding_id, events, requestId: 'an_old_attempt', attempt: attemptNo });
  ok('A 新 attempt 完成后旧 token 仍被拒', lateOld.ok === false && lateOld.decision === 'stale', JSON.stringify(lateOld).slice(0, 200));
  ok('A 旧 token 不叠加事件', countEvents(s1.chapterId) === before);

  console.log('【B. finishAnalysis 同样受 token 约束】');
  const s2 = seedWork('T07-finish');
  T.setTemporalConfig(s2.workId, { temporal_enabled: true, auto_analysis_enabled: true });
  T.recordContentSave({ workId: s2.workId, chapterId: s2.chapterId, contentHtml: '<p>第一章 雨落</p>', origin: { kind: 'manual_save' } });
  const begun2 = T.beginAnalysis({ workId: s2.workId, chapterId: s2.chapterId });
  const badFinish = T.finishAnalysis({ workId: s2.workId, chapterId: s2.chapterId, bindingId: begun2.binding_id, status: 'failed', error: '旧 worker 的失败回调', requestId: 'an_wrong' });
  ok('B 旧 token 失败回调 → stale', badFinish.ok === false && badFinish.decision === 'stale', JSON.stringify(badFinish).slice(0, 160));
  ok('B 当前任务仍是 running（未被旧回调改写）', analysisOf(begun2.binding_id).status === 'running', JSON.stringify(analysisOf(begun2.binding_id)));
  const goodFinish = T.finishAnalysis({ workId: s2.workId, chapterId: s2.chapterId, bindingId: begun2.binding_id, status: 'failed', error: '本次失败', requestId: begun2.analysis.request_id, attempt: begun2.analysis.attempts });
  ok('B 正确 token 失败回调 → ok', goodFinish.ok === true && goodFinish.status === 'failed', JSON.stringify(goodFinish).slice(0, 160));
  ok('B 状态如实记为 failed', analysisOf(begun2.binding_id).status === 'failed');

  console.log('【C. 纯函数判据（阴性对照）】');
  ok('C 没有 request_id 的绑定放行（兼容历史夹具）', T.analysisFenceVerdict({ status: 'pending' }, {}).ok === true);
  ok('C running 但无 token 拒绝', T.analysisFenceVerdict({ status: 'running', request_id: 'an_x' }, {}).ok === false);
  ok('C token 一致放行', T.analysisFenceVerdict({ status: 'running', request_id: 'an_x', attempts: 2 }, { requestId: 'an_x', attempt: 2 }).ok === true);
  ok('C token 不一致拒绝', T.analysisFenceVerdict({ status: 'done', request_id: 'an_x', attempts: 2 }, { requestId: 'an_y' }).ok === false);
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { db.close(); } catch { /* 已关闭 */ }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ }
}
console.log(`\nT07 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
