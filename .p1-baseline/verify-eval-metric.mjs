#!/usr/bin/env node
/**
 * verify-eval-metric.mjs —— P5「编辑距离」端到端验证（需活实例；零 LLM 调用、零费用）。
 *
 * 验证的是**测量点是否真的接上**，而不是函数算得对不对（那是离线单测的事）：
 *   1. 生成草稿（落 chapter_save_versions，kind='draft'）
 *   2. 记一条 adopt 埋点（带 draft_key）
 *   3. 作者"不改就保存" → 距离应为 0
 *   4. 再走一轮：作者"改了再保存" → 距离应显著大于 0
 *   5. 重复保存不应重复测量（幂等）
 *   6. 没有采纳行时保存正文 → 不应凭空产生测量
 *
 * ⚠️ 只用 HTTP + 本地库，不触发任何 harness 任务，因此**不产生 API 费用**。
 * 建议指向隔离实例（`node .p1-baseline/gate-env.mjs` 起的那种）。
 *
 * 用法: node .p1-baseline/verify-eval-metric.mjs <base> [--work <id>]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3739';
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};

let pass = 0;
const fails = [];
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log(`目标实例：${BASE}\n`);

// 全局埋点基线：D6 的判据要拿它比对（"删作品后回到基线"）。
const baseGlobal = (await api('GET', '/api/ai/eval')).json || { total: 0 };

// 建临时作品 + 章节
const work = await api('POST', '/api/works', { title: '编辑距离验证·临时作品', description: '用完即删' });
const wid = work.json?.id ?? work.json?.work_id;
check('创建临时作品', !!wid, `status=${work.status} ${work.text.slice(0, 80)}`);
if (!wid) { console.log('\n无法继续：作品未创建。'); process.exit(1); }

const ch = await api('POST', '/api/chapters', { work_id: wid, title: '验证章', content: '起始正文。', position: 1 });
const cid = ch.json?.id;
check('创建临时章节', !!cid, `status=${ch.status} ${ch.text.slice(0, 80)}`);

const DRAFT_A = '他推开门，雨声一下子涌进来，像有人把整条街倒进了屋里。';
const DRAFT_B = '她合上账本，灯芯爆了一声。缝匠铺的招牌在风里晃，像一句没说完的话。';
const evalOf = async () => (await api('GET', `/api/ai/eval?work_id=${wid}`)).json;

async function seedAdopt(draftText, key) {
  await api('POST', '/api/novel/draft', { chapter_id: cid, content: draftText });
  await api('POST', '/api/ai/eval', {
    work_id: wid, chapter_id: cid, action: 'generate', channel: 'harness',
    chars_in: 1000, chars_out: draftText.length, ms: 1000, draft_key: key,
  });
  await api('POST', '/api/ai/eval', {
    work_id: wid, chapter_id: cid, action: 'adopt', channel: 'replace',
    chars_out: draftText.length, draft_key: key,
  });
}

console.log('\n【轮次一：采纳后「不改就保存」→ 距离应为 0】');
await seedAdopt(DRAFT_A, 'k1');
{
  const before = await evalOf();
  check('测量前 avg_edit_distance 为 null（样本不足，不用 0 假装）',
    before.avg_edit_distance === null, JSON.stringify(before.avg_edit_distance));
  const put = await api('PUT', `/api/chapters/${cid}`, { content: DRAFT_A });
  check('保存正文成功', put.status === 200, `status=${put.status} ${put.text.slice(0, 80)}`);
  const after = await evalOf();
  check('保存后 avg_edit_distance 被填上', after.avg_edit_distance !== null, JSON.stringify(after));
  check('未改动的正文 → 距离为 0', after.avg_edit_distance === 0, `实际 ${after.avg_edit_distance}`);
}

console.log('\n【轮次二：采纳后「大改再保存」→ 距离应显著大于 0】');
await seedAdopt(DRAFT_B, 'k2');
{
  const edited = DRAFT_B.slice(0, 6) + '完全换掉的其余内容，长度也不同了。';
  await api('PUT', `/api/chapters/${cid}`, { content: edited });
  const after = await evalOf();
  check('两轮测量的平均值落 (0, 草稿长度] 区间',
    Number(after.avg_edit_distance) > 0 && Number(after.avg_edit_distance) <= DRAFT_B.length,
    `avg=${after.avg_edit_distance} 草稿长度=${DRAFT_B.length}`);
  check('采纳数已累计到 2', after.adopts === 2, `adopts=${after.adopts}`);
}

console.log('\n【幂等：重复保存不应重复测量】');
{
  const a = await evalOf();
  await api('PUT', `/api/chapters/${cid}`, { content: '又一次保存，内容再变。' });
  await api('PUT', `/api/chapters/${cid}`, { content: '第三次保存。' });
  const b = await evalOf();
  check('avg_edit_distance 不再变化（测一次就写回）',
    a.avg_edit_distance === b.avg_edit_distance,
    `前 ${a.avg_edit_distance} → 后 ${b.avg_edit_distance}`);
}

console.log('\n【无采纳行时，保存正文不应凭空产生测量】');
{
  const w2 = await api('POST', '/api/works', { title: '编辑距离验证·无采纳', description: '用完即删' });
  const wid2 = w2.json?.id ?? w2.json?.work_id;
  const c2 = await api('POST', '/api/chapters', { work_id: wid2, title: '章', content: 'x', position: 1 });
  const cid2 = c2.json?.id;
  await api('POST', '/api/novel/draft', { chapter_id: cid2, content: '有草稿但没有采纳记录。' });
  await api('PUT', `/api/chapters/${cid2}`, { content: '作者自己写的，与 AI 无关。' });
  const agg2 = (await api('GET', `/api/ai/eval?work_id=${wid2}`)).json;
  check('该作品 total=0 且 avg_edit_distance=null',
    agg2.total === 0 && agg2.avg_edit_distance === null, JSON.stringify(agg2));
  await api('DELETE', `/api/works/${wid2}`);
}

console.log('\n【D6：删作品时连带删埋点（不留孤儿行）】');
{
  // 用**全局**聚合来判：`ai_eval_events` 没有外键级联，若不在删作品时显式清理，
  // 上面那些临时作品的埋点行会留下，并被全局聚合算进去（指标被已不存在的作品带偏）。
  // 判据用「回到基线」而不是绝对值，因此在空库与有历史的库上都成立。
  await api('DELETE', `/api/works/${wid}`);
  const after = (await api('GET', '/api/ai/eval')).json;
  check('两个临时作品的埋点行已随作品删除而清除（全局 total 回到基线）',
    after.total === baseGlobal.total,
    `基线 total=${baseGlobal.total} → 现在 ${after.total}（差 ${after.total - baseGlobal.total} 行未清）`);
}

console.log(`\n══════════════════════════════`);
console.log(`编辑距离端到端验证：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
