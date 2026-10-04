// 「关闭上次审稿提示」的端到端冒烟（隔离的临时数据目录 + 端口，不碰作者的真实库）。
// 与草稿/任务两处关闭的**关键差别**在这里被固定下来：关闭审稿提示**不隐藏审稿报告**
// （GET /novel/review 照常返回该行，带 dismissed=1）——"别再提示我"不等于"把报告删了"。
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3799';
const DB = process.env.SMOKE_DB || '';
const j = async (p, opts = {}) => {
  const res = await fetch(`${BASE}/api${p}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
};
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`);
  if (cond) pass += 1; else fail += 1;
};
const reviewText = (n, tag) => JSON.stringify({
  summary: `第 ${n} 次审稿总评（${tag}）`,
  issues: [{ text: `问题A-${n}` }, { text: `问题B-${n}` }],
  strengths: [`优点-${n}`],
});

const work = await j('/works', { method: 'POST', body: { title: '关闭审稿提示冒烟（临时）', description: '' } });
const workId = Number(work.body.id) || 0;
const ch = await j('/chapters', { method: 'POST', body: { work_id: workId, title: '冒烟章', content: '<p>作者自己写的正文，关闭审稿提示不该动它。</p>' } });
const chId = Number(ch.body.id) || 0;
ok('R0 建临时作品与章节', work.status === 201 && chId > 0, `work=${workId} ch=${chId}`);
const bodyBefore = String((await j(`/chapters/${chId}`)).body.content);

// ① 落一份审稿 → 恢复条能看到它（dismissed=0）
const fin = await j('/novel/finalize', { method: 'POST', body: { kind: 'review', chapter_id: chId, output: reviewText(1, 'parseable') } });
const reviewId = Number(fin.body.review_id) || 0;
const seen = await j(`/novel/review?chapter_id=${chId}`);
ok('R1 审稿落库后 /novel/review 返回它，且 dismissed=0（照常提示）',
  fin.status === 201 && reviewId > 0 && Number(seen.body.review?.id) === reviewId
  && Number(seen.body.review?.dismissed) === 0 && seen.body.review?.parsed === true && Number(seen.body.review?.issue_count) === 2,
  `status=${fin.status} id=${reviewId} dismissed=${seen.body.review?.dismissed} issues=${seen.body.review?.issue_count}`);

// ② 关闭 → 标记 dismissed=1
const dis = await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: chId, review_id: reviewId } });
ok('R2 关闭这份审稿提示：dismissed=1（恢复条据此不再显示那一条）',
  dis.status === 200 && dis.body.dismissed === 1 && Number(dis.body.review?.dismissed) === 1,
  `status=${dis.status} dismissed=${dis.body.dismissed}`);

// ③ 关键差别：报告**没有**被藏起来（这是与草稿/任务两处关闭不同的地方）
const after = await j(`/novel/review?chapter_id=${chId}`);
ok('R3 关闭只影响恢复条那一条提示：GET /novel/review 仍返回这份报告（dismissed=1，内容齐全）',
  Number(after.body.review?.id) === reviewId && Number(after.body.review?.dismissed) === 1
  && Number(after.body.review?.issue_count) === 2 && String(after.body.review?.report?.summary || '').includes('第 1 次审稿总评'),
  JSON.stringify({ id: after.body.review?.id, dismissed: after.body.review?.dismissed, summary: String(after.body.review?.report?.summary || '').slice(0, 24) }));

// ④ 幂等
const dis2 = await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: chId, review_id: reviewId } });
ok('R4 重复关闭是幂等的（不报错、dismissed=0）', dis2.status === 200 && dis2.body.dismissed === 0, `status=${dis2.status} dismissed=${dis2.body.dismissed}`);

// ⑤ 关掉的是那一份，不是这一章：之后新审稿照常提示
const fin2 = await j('/novel/finalize', { method: 'POST', body: { kind: 'review', chapter_id: chId, output: reviewText(2, 'parseable') } });
const review2 = Number(fin2.body.review_id) || 0;
const seenNew = await j(`/novel/review?chapter_id=${chId}`);
ok('R5 关闭之后新审的稿照常提示（关掉的是那一份，不是这一章）',
  review2 > reviewId && Number(seenNew.body.review?.id) === review2 && Number(seenNew.body.review?.dismissed) === 0,
  `new=${review2} seen=${seenNew.body.review?.id} dismissed=${seenNew.body.review?.dismissed}`);

// ⑥ 不带 review_id：关掉"当前显示的那一份"
const dis3 = await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: chId } });
const seen3 = await j(`/novel/review?chapter_id=${chId}`);
ok('R6 不带 review_id 时关掉的是最新那一份（界面不传 id 也不会关错）',
  dis3.body.dismissed === 1 && Number(seen3.body.review?.id) === review2 && Number(seen3.body.review?.dismissed) === 1,
  `dismissed=${dis3.body.dismissed} id=${seen3.body.review?.id}`);

// ⑦ 坏入参不炸、也不会误关
const bad = await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: chId, review_id: 99999999 } });
const noCh = await j('/novel/review/dismiss', { method: 'POST', body: { review_id: reviewId } });
const ghost = await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: 99999999, review_id: reviewId } });
ok('R7 不存在的 review_id / 缺 chapter_id / 不存在的章节：200(0) / 400 / 404，都不抛错',
  bad.status === 200 && bad.body.dismissed === 0 && noCh.status === 400 && ghost.status === 404,
  `bad=${bad.status}/${bad.body?.dismissed} noCh=${noCh.status} ghost=${ghost.status}`);

// ⑧ 跨章隔离：关掉别的章的审稿不影响这一章
const other = await j('/chapters', { method: 'POST', body: { work_id: workId, title: '另一个冒烟章', content: '<p>另一章正文。</p>' } });
const otherId = Number(other.body.id) || 0;
const finO = await j('/novel/finalize', { method: 'POST', body: { kind: 'review', chapter_id: otherId, output: reviewText(3, 'parseable') } });
await j('/novel/review/dismiss', { method: 'POST', body: { chapter_id: otherId, review_id: Number(finO.body.review_id) } });
const fin4 = await j('/novel/finalize', { method: 'POST', body: { kind: 'review', chapter_id: chId, output: reviewText(4, 'parseable') } });
const seenCh = await j(`/novel/review?chapter_id=${chId}`);
const seenOther = await j(`/novel/review?chapter_id=${otherId}`);
ok('R8 关掉另一章的审稿不会误伤本章',
  Number(seenCh.body.review?.id) === Number(fin4.body.review_id) && Number(seenCh.body.review?.dismissed) === 0
  && Number(seenOther.body.review?.dismissed) === 1,
  `ch=${seenCh.body.review?.id}/${seenCh.body.review?.dismissed} other=${seenOther.body.review?.dismissed}`);

// ⑨ 正文不动 + 审稿记录没被删除
const bodyAfter = String((await j(`/chapters/${chId}`)).body.content);
ok('R9 关闭不动正文：章节内容逐字节一致', bodyAfter === bodyBefore, `before=${bodyBefore.length}B after=${bodyAfter.length}B`);
if (DB) {
  const db = new DatabaseSync(DB, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM chapter_reviews').get().n;
  const keeper = db.prepare('SELECT id, dismissed, LENGTH(report_json) AS len FROM chapter_reviews WHERE id = ?').get(reviewId);
  db.close();
  ok('R10 关闭不删除审稿记录（行还在、报告 JSON 还在，只是 dismissed=1）',
    n === 4 && Number(keeper?.dismissed) === 1 && Number(keeper?.len) > 0,
    JSON.stringify({ rows: n, keeper }));
} else {
  ok('R10 关闭不删除审稿记录（未提供 SMOKE_DB，跳过库内核对）', true, 'SKIP≠PASS：本项未做库内核对');
}

console.log(`\n=== smoke review-dismiss: ${pass} ok / ${fail} fail ===`);
process.exit(fail ? 1 : 0);
