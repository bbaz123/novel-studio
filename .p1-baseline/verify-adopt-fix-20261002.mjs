// 临时验证脚本（只读设计：只打本地隔离实例 127.0.0.1:3738，绝不指向 3737 主实例）。
// 目的：把 2026-10-02 的真实事故形状在隔离副本上复刻一遍，逐条核对本轮修复。
const BASE = 'http://127.0.0.1:3738/api';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
async function get(path) {
  const res = await fetch(BASE + path);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

// ── 1. 事故章节的现场数据是否被完整带进隔离副本 ────────────────────────────────
const ch = await get('/chapters/121');
check('隔离副本含真实事故现场：第 121 章 updated_at=2026-10-02T11:40:38.477Z',
  ch.json?.updated_at === '2026-10-02T11:40:38.477Z', `updated_at=${ch.json?.updated_at}`);
check('单章读取返回权威内容基线 content_hash（新增字段）',
  typeof ch.json?.content_hash === 'string' && ch.json.content_hash.length === 16, `content_hash=${ch.json?.content_hash}`);

const d0 = await get('/novel/draft?chapter_id=121');
// 注：/novel/draft 返回的是"最新一份未应用草稿"。事故当时那一份是 id=39（4679 字符 HTML，
// 纯文本 4162 字 —— 与截图里「4162 字，19:39:51」一致）；点 11:39:51 生成。
check('隔离副本含事故当时那份未应用草稿 id=39（HTML 4679 字符 / 纯文本 4162 字）',
  Number(d0.json?.draft?.id) === 39 && Number(d0.json?.draft?.chars) === 4162, `id=${d0.json?.draft?.id} chars=${d0.json?.draft?.chars}`);

// ── 2. 修复后的采纳时序：先读权威基线 → 采纳（旧实现在这里必被 409 回滚） ────────
const admit = await post('/novel/adopt', {
  work_id: 18, chapter_id: 121,
  content: '<p>验证：采纳应当放行，并把本次消费的草稿标记为已应用。</p>',
  operation_key: 'verify-incident-adopt-0001', adopt_kind: 'verify',
  expected: { content_hash: ch.json.content_hash }
});
check('同页保存过之后再采纳：不再被误判为并发冲突（200，而不是旧的 409）',
  admit.status === 200, `status=${admit.status} ${admit.json?.error || ''}`);
check('采纳响应回传被消费的草稿 id（draft_applied_id=39）',
  Number(admit.json?.adopt?.draft_applied_id) === 39, `draft_applied_id=${admit.json?.adopt?.draft_applied_id}`);
check('采纳前后内容指纹如实记录（hash_after 与写入内容一致）',
  admit.json?.adopt?.content_hash_before === ch.json.content_hash && !!admit.json?.adopt?.content_hash_after,
  `before=${admit.json?.adopt?.content_hash_before} after=${admit.json?.adopt?.content_hash_after}`);

const d1 = await get('/novel/draft?chapter_id=121');
check('采纳后草稿不再被当成"未应用的生成稿"（恢复条不再提示）',
  d1.json?.draft === null, `draft=${JSON.stringify(d1.json?.draft)}`);

// ── 3. 并发保护没有被削弱：内容真的变了仍然拒绝 ────────────────────────────────
const stale = await post('/novel/adopt', {
  work_id: 18, chapter_id: 121, content: '<p>验证：内容基线过期应当被拒。</p>',
  operation_key: 'verify-stale-baseline-0002', adopt_kind: 'verify',
  expected: { content_hash: ch.json.content_hash }   // 上一轮采纳已经把内容换掉了
});
check('别人的写入改动了正文内容时仍然 409（保护未被削弱）',
  stale.status === 409 && /基线 hash 不一致/.test(stale.json?.error || ''), `status=${stale.status}`);
const afterStale = await get('/chapters/121');
check('被拒绝的采纳什么都没写（正文保持上一轮采纳后的内容）',
  afterStale.json?.content_hash === admit.json?.adopt?.content_hash_after, `hash=${afterStale.json?.content_hash}`);

// ── 4. 老客户端（只带 updated_at）：如实提示"本页保存推进了版本"，并让作者重试 ──
const legacy = await post('/novel/adopt', {
  work_id: 18, chapter_id: 121, content: '<p>验证：老客户端形态。</p>',
  operation_key: 'verify-legacy-ts-0003', adopt_kind: 'verify',
  expected: { updated_at: '2026-10-02T11:40:38.477Z' }
});
check('老客户端仍被时间戳闸门拦下，且文案不再谎称"其它窗口"',
  legacy.status === 409 && /本页保存/.test(legacy.json?.error || '') && !/其它窗口/.test(legacy.json?.error || ''),
  `status=${legacy.status} ${legacy.json?.error || ''}`);

// ── 5. 草稿取回标记（/novel/draft/consume 路由必须可达） ───────────────────────
const d2 = await post('/novel/draft', { chapter_id: 121, content: '验证草稿：应当能被 consume 标记掉（取回生成稿走这条路）。' });
check('新草稿落库成功（POST /novel/draft 仍走原路由）', d2.status === 201, `status=${d2.status} ${d2.json?.error || ''}`);
const consume = await post('/novel/draft/consume', { chapter_id: 121, draft_id: d2.json?.draft_id });
check('POST /novel/draft/consume 可达且标记成功（此前会被 draft POST 抢走 → 400）',
  consume.status === 200 && Number(consume.json?.applied) === 1, `status=${consume.status} applied=${consume.json?.applied}`);
const d3 = await get('/novel/draft?chapter_id=121');
check('consume 之后草稿查询返回 null', d3.json?.draft === null, `draft=${JSON.stringify(d3.json?.draft)}`);

// ── 6. 级联标记：更早的未应用草稿不再顶上来（实测撞到过的 id=10 现象） ─────────
const oldEra = await get('/novel/draft?chapter_id=124');
const beforeId = Number(oldEra.json?.draft?.id) || 0;
const ch124 = await get('/chapters/124');
await post('/novel/adopt', {
  work_id: 18, chapter_id: 124, content: '<p>验证：级联标记更早的未应用草稿。</p>',
  operation_key: 'verify-cascade-0004', adopt_kind: 'verify',
  expected: { content_hash: ch124.json.content_hash }
});
const afterCascade = await get('/novel/draft?chapter_id=124');
check(`采纳后该章不再有"未应用草稿"残留（采纳前最新未应用草稿 id=${beforeId}）`,
  afterCascade.json?.draft === null, `draft=${JSON.stringify(afterCascade.json?.draft)}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过${failed.length ? '，失败：' + failed.map((f) => f.name).join(' | ') : ''} ===`);
process.exit(failed.length ? 1 : 0);
