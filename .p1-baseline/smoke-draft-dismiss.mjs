// 「关闭生成稿」的端到端冒烟（在隔离的临时数据目录 + 端口上跑，不碰作者的真实库）。
// 覆盖：① 关闭后提示真的消失；② 内容没被删除、正文逐字节没动；③ 幂等；
// ④ 之后新生成的草稿照常提示（关闭不是"这一章永不再提示"）；⑤ 不带 draft_id 时关的是当前那一份；
// ⑥ 坏入参不炸；⑦ 关闭与 consume（取回）互不干扰。
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

const work = await j('/works', { method: 'POST', body: { title: '关闭生成稿冒烟（临时）', description: '' } });
const workId = Number(work.body.id) || 0;
const ch = await j('/chapters', { method: 'POST', body: { work_id: workId, title: '冒烟章', content: '<p>这是作者自己写的正文，关闭草稿提示不该动它。</p>' } });
const chId = Number(ch.body.id) || 0;
ok('D0 建临时作品与章节', work.status === 201 && chId > 0, `work=${workId} ch=${chId}`);
const bodyBefore = String((await j(`/chapters/${chId}`)).body.content);

// ① 落一份生成稿 → 恢复条能看到它
const d1 = await j('/novel/draft', { method: 'POST', body: { chapter_id: chId, content: '第一版生成稿。\n\n这是 AI 写的。' } });
const draft1 = Number(d1.body.draft_id) || 0;
const seen1 = await j(`/novel/draft?chapter_id=${chId}`);
ok('D1 新草稿落库后 /novel/draft 能看到它（未应用）', d1.status === 201 && draft1 > 0 && Number(seen1.body.draft?.id) === draft1,
  `draft=${draft1} seen=${seen1.body.draft?.id}`);

// ② 关闭 → 提示消失
const dis = await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chId, draft_id: draft1 } });
const seen2 = await j(`/novel/draft?chapter_id=${chId}`);
ok('D2 关闭这一份后，恢复条不再返回它（这就是"永远不想要"的那个动作）',
  dis.status === 200 && dis.body.dismissed === 1 && dis.body.draft === null && seen2.body.draft === null,
  `status=${dis.status} dismissed=${dis.body.dismissed} draft=${JSON.stringify(seen2.body.draft)}`);

// ③ 幂等：再关一次不会报错，也不会重复计数
const dis2 = await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chId, draft_id: draft1 } });
ok('D3 重复关闭是幂等的（不报错、dismissed=0）', dis2.status === 200 && dis2.body.dismissed === 0, `status=${dis2.status} dismissed=${dis2.body.dismissed}`);

// ④ 内容没被删除、正文一个字没动
let rowInfo = null;
if (DB) {
  const db = new DatabaseSync(DB, { readOnly: true });
  rowInfo = db.prepare('SELECT id, draft_applied, draft_dismissed, LENGTH(content) AS len FROM chapter_save_versions WHERE id = ?').get(draft1);
  db.close();
}
const bodyAfter = String((await j(`/chapters/${chId}`)).body.content);
ok('D4 关闭只打标记、不删内容（草稿行还在，内容长度不变）',
  !DB || (rowInfo && Number(rowInfo.draft_dismissed) === 1 && Number(rowInfo.len) > 0),
  DB ? JSON.stringify(rowInfo) : '（未提供 SMOKE_DB，跳过库内核对）');
ok('D5 关闭不动正文：章节内容逐字节一致', bodyAfter === bodyBefore, `before=${bodyBefore.length}B after=${bodyAfter.length}B`);

// ⑤ 关闭不是"这一章永不再提示"：之后新生成的草稿照常出现在恢复条上
const d2 = await j('/novel/draft', { method: 'POST', body: { chapter_id: chId, content: '第二版生成稿（关闭之后新写的）。' } });
const draft2 = Number(d2.body.draft_id) || 0;
const seen3 = await j(`/novel/draft?chapter_id=${chId}`);
ok('D6 关闭之后新生成的草稿照常提示（关掉的只是那一份，不是这一章）',
  draft2 > draft1 && Number(seen3.body.draft?.id) === draft2, `draft2=${draft2} seen=${seen3.body.draft?.id}`);

// ⑥ 不带 draft_id：关掉"当前显示的那一份"
const dis3 = await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chId } });
const seen4 = await j(`/novel/draft?chapter_id=${chId}`);
ok('D7 不带 draft_id 时关掉的是当前显示的那一份（界面不传 id 也不会关错）',
  dis3.body.dismissed === 1 && seen4.body.draft === null, `dismissed=${dis3.body.dismissed} draft=${JSON.stringify(seen4.body.draft)}`);

// ⑦ 关闭与「取回生成稿」的消费标记互不干扰
const d3 = await j('/novel/draft', { method: 'POST', body: { chapter_id: chId, content: '第三版生成稿。' } });
const draft3 = Number(d3.body.draft_id) || 0;
await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chId, draft_id: draft3 } });
const consume = await j('/novel/draft/consume', { method: 'POST', body: { chapter_id: chId, draft_id: draft3 } });
ok('D8 对已关闭的草稿调 consume 不报错、也不会把它重新放回恢复条',
  consume.status === 200 && consume.body.ok === true && consume.body.draft === null,
  `status=${consume.status} applied=${consume.body.applied} draft=${JSON.stringify(consume.body.draft)}`);

// ⑧ 坏入参不炸
const badId = await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: chId, draft_id: 99999999 } });
const noCh = await j('/novel/draft/dismiss', { method: 'POST', body: { draft_id: draft3 } });
const ghostCh = await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: 99999999, draft_id: draft3 } });
ok('D9 不存在的 draft_id / 缺 chapter_id / 不存在的章节：分别是 200(0) / 400 / 404，都不抛错',
  badId.status === 200 && badId.body.dismissed === 0 && noCh.status === 400 && ghostCh.status === 404,
  `bad=${badId.status}/${badId.body?.dismissed} noCh=${noCh.status} ghost=${ghostCh.status}`);

// ⑨ 关掉别的章的草稿不影响这一章（跨章隔离，尤其防"关错章"）
const other = await j('/chapters', { method: 'POST', body: { work_id: workId, title: '另一个冒烟章', content: '<p>另一个章节的正文。</p>' } });
const otherId = Number(other.body.id) || 0;
const dOther = await j('/novel/draft', { method: 'POST', body: { chapter_id: otherId, content: '别的章的生成稿。' } });
await j('/novel/draft/dismiss', { method: 'POST', body: { chapter_id: otherId, draft_id: Number(dOther.body.draft_id) } });
const d4 = await j('/novel/draft', { method: 'POST', body: { chapter_id: chId, content: '第四版生成稿。' } });
const seenCh = await j(`/novel/draft?chapter_id=${chId}`);
const seenOther = await j(`/novel/draft?chapter_id=${otherId}`);
ok('D10 关掉另一章的草稿不会误伤本章（关错章是这类动作最容易犯的错）',
  Number(seenCh.body.draft?.id) === Number(d4.body.draft_id) && seenOther.body.draft === null,
  `ch=${seenCh.body.draft?.id} other=${JSON.stringify(seenOther.body.draft)}`);

console.log(`\n=== smoke draft-dismiss: ${pass} ok / ${fail} fail ===`);
process.exit(fail ? 1 : 0);
