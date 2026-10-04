// 空正文护栏的端到端冒烟（在隔离的临时数据目录 + 端口上跑，不碰作者的真实库）。
// 验证：① 有正文的章不能被空稿覆盖（任何通道）；② 只有显式 confirm_empty 才放行；③ 正常写作语义不变。
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3799';
const j = async (path, opts = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
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
const long = (n) => `<p>${'正文内容'.repeat(Math.ceil(n / 4)).slice(0, n)}</p>`;

const work = await j('/works', { method: 'POST', body: { title: '护栏冒烟（临时）', description: '' } });
const workId = Number(work.body.id) || 0;
ok('S0 建临时作品', work.status === 201 && workId > 0, `status=${work.status}`);
const ch = await j('/chapters', { method: 'POST', body: { work_id: workId, title: '冒烟章', content: long(400) } });
const chId = Number(ch.body.id) || 0;
ok('S0b 建有正文的临时章节', ch.status === 201 && chId > 0, `status=${ch.status}`);

// ① 通用 PUT：空稿覆盖有正文的章 → 必须拒绝，且带机器可判的 code
const emptyPut = await j(`/chapters/${chId}`, { method: 'PUT', body: { content: '<div><br></div>', title: '冒烟章' } });
ok('S1 PUT 空稿覆盖有正文的章被拒绝（409 + EMPTY_OVERWRITE_BLOCKED）',
  emptyPut.status === 409 && emptyPut.body && emptyPut.body.code === 'EMPTY_OVERWRITE_BLOCKED',
  `status=${emptyPut.status} code=${emptyPut.body && emptyPut.body.code}`);
const afterReject = await j(`/chapters/${chId}`);
ok('S2 被拒绝后正文逐字节未变', String(afterReject.body.content) === long(400), `len=${String(afterReject.body.content).length}`);

// ② 只有标签的空稿（`<p><br></p>` 这类）同样算空
const tagOnly = await j(`/chapters/${chId}`, { method: 'PUT', body: { content: '<p><br></p><p>&nbsp;</p>', title: '冒烟章' } });
ok('S3 只有标签/空白的稿子同样被拒绝', tagOnly.status === 409 && tagOnly.body.code === 'EMPTY_OVERWRITE_BLOCKED', `status=${tagOnly.status}`);

// ③ 显式确认才放行
const confirmed = await j(`/chapters/${chId}`, { method: 'PUT', body: { content: '<div><br></div>', title: '冒烟章', confirm_empty: true } });
ok('S4 confirm_empty=true 时放行（清空是合法操作，但必须是显式选择）', confirmed.status === 200, `status=${confirmed.status}`);

// ④ 空章重新写正文不受影响
const rewrite = await j(`/chapters/${chId}`, { method: 'PUT', body: { content: long(300), title: '冒烟章' } });
ok('S5 空章写正文照常成功（护栏只挡"有→无"，不挡正常写作）', rewrite.status === 200, `status=${rewrite.status}`);

// ⑤ chapter_save 通道（AI 写回）同样受护栏保护
const aiEmpty = await j('/novel/chapter_save', { method: 'POST', body: { chapter_id: chId, content: '<div><br></div>' } });
ok('S6 chapter_save 通道写空稿同样被拒绝', aiEmpty.status === 409 && aiEmpty.body.code === 'EMPTY_OVERWRITE_BLOCKED', `status=${aiEmpty.status} code=${aiEmpty.body && aiEmpty.body.code}`);
const aiOk = await j('/novel/chapter_save', { method: 'POST', body: { chapter_id: chId, content: long(320) } });
ok('S7 chapter_save 正常写回照常成功', aiOk.status === 200 && aiOk.body.ok === true, `status=${aiOk.status}`);

// ⑥ 采纳通道（/novel/adopt）不接受空稿
const adopt = await j('/novel/adopt', {
  method: 'POST',
  body: { work_id: workId, chapter_id: chId, content: '<p><br></p>', operation_key: `smoke-${Date.now()}`, expected: {} }
});
ok('S8 adopt 通道写空稿被拒绝（不提供"采纳一版空稿"这种语义）',
  adopt.status === 409 && adopt.body.code === 'EMPTY_OVERWRITE_BLOCKED', `status=${adopt.status} code=${adopt.body && adopt.body.code}`);

// ⑦ 历史版本恢复（作者显式动作）不受护栏阻挡：这是"把正文换回来"的通道
const ver = await j('/chapter_versions', { method: 'POST', body: { chapter_id: chId, title: '冒烟章', summary: '', content: long(400) } });
const restore = await j(`/chapter_versions/${ver.body.id}/restore`, { method: 'POST', body: { backup_current: true } });
ok('S9 历史版本恢复通道不受护栏阻挡（恢复=作者显式换回正文）',
  ver.status === 201 && restore.status === 200 && String(restore.body.chapter.content) === long(400),
  `mk=${ver.status} restore=${restore.status}`);

console.log(`\n=== smoke: ${pass} ok / ${fail} fail ===`);
process.exit(fail ? 1 : 0);
