#!/usr/bin/env node
/**
 * verify-model-slot.mjs —— 「等待模型槽位」可观测性的端到端验证（决策 D4）。
 *
 * 被验证的行为：服务端允许 2 个作业，但**请求了模型/强度的任务会串行**（要改写 settings.yaml）。
 * 于是第二个作业其实在排队，此前却一律显示"运行中"，作者会以为卡住了。
 * 现在它应当：作业上出现 `model_slot='waiting'`、`stage` 写明"等待模型槽位"，
 * 且 `/api/harness/status` 暴露 `model_load = {busy, waiters}`。
 *
 * 零成本做法：**必须**把实例的 LLM 端点指向黑洞（gate-env.mjs 的配方）。
 * 这样第一个作业会一直卡在"已发出请求、永无响应"，正好把槽位占住，让第二个作业排队——
 * 全程不出网、不计费，且跑完由调用方用 audit-llm-calls 复核。
 *
 * ⚠️ 会真的创建 harness 作业，所以沿用与 verify-harness-gate 相同的授权闸：
 * 必须显式设 NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1。
 *
 * 用法:
 *   node .p1-baseline/gate-env.mjs                      # 另开一个终端，起隔离实例
 *   $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
 *   node .p1-baseline/verify-model-slot.mjs http://127.0.0.1:<port>
 */
const BASE = process.argv[2] || '';
if (!BASE) { console.error('用法: node .p1-baseline/verify-model-slot.mjs <base-url>'); process.exit(2); }
if (process.env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED !== '1') {
  console.error(`拒绝运行：这个检查会真的创建 harness 作业（约 2 个）。

它必须跑在**可证明的隔离实例**上（LLM 端点指向黑洞，作业卡住不出网）。
请先：node .p1-baseline/gate-env.mjs
再显式授权：
  $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
  node .p1-baseline/verify-model-slot.mjs ${BASE}
跑完请用 audit-llm-calls.mjs 复核零计费。`);
  process.exit(2);
}

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};

console.log(`═══ 「等待模型槽位」可观测性验证（零计费，需黑洞端点）═══\n目标：${BASE}\n`);

// 0) 接线检查：服务端回字段 ≠ 作者看得见。这一步在 e2e 之前先确认三方都接上了，
//    否则可能出现"后端对了、界面照旧静止"的假完成（D4 第一版就是这个毛病）。
{
  const fs = await import('node:fs');
  const app = fs.readFileSync('public/app.js', 'utf8');
  const srv = fs.readFileSync('server.js', 'utf8');
  const har = fs.readFileSync('harness.js', 'utf8');
  check('harness.js 会上报 waiting-model / running',
    /onPhase\('waiting-model'/.test(har) && /onPhase\('running'/.test(har));
  check('server.js 把 model_slot 写进作业', /job\.model_slot = 'waiting'/.test(srv));
  check('server.js 把 model_slot 回给前端', /model_slot: job\.model_slot/.test(srv));
  const poll = app.slice(app.indexOf('async function pollHarnessJob'));
  check('前端轮询真的读了 model_slot（不是只回字段没人用）', /job\.model_slot === 'waiting'/.test(poll));
  check('前端把它显示出来（喂给进度卡）', /progress\.update\(\[job\.tail, waiting\]/.test(poll));
}

// 1) 空载时 model_load 应当是干净的
{
  const st = (await api('GET', '/api/harness/status')).json || {};
  check('空载时 /harness/status 暴露 model_load', st.model_load !== undefined, JSON.stringify(st.model_load));
  check('空载时 busy=false / waiters=0',
    st.model_load?.busy === false && st.model_load?.waiters === 0, JSON.stringify(st.model_load));
}

// 2) 起两个**带 model** 的作业（带 model 才会进模型切换互斥）
const jobs = [];
for (const tag of ['槽位测试一', '槽位测试二']) {
  const r = await api('POST', '/api/harness/run', {
    prompt: `Reply with the single word: ${tag}`, model: 'deepseek-flash', timeout: 120000,
  });
  if (r.status === 202 && r.json?.job_id) jobs.push(r.json.job_id);
}
check('两个作业都已入队', jobs.length === 2, `入队 ${jobs.length} 个`);

// 3) 第一个应当 running，第二个应当 waiting（这正是决策 D4 要修的那个显示问题）
// ⚠️ 载荷是**扁平**对象（GET /harness/job?id= 直接回 {id,status,stage,...}），不是 {job:{...}}。
// 早先这里写成 `?.json?.job`，拿到的永远是 undefined，于是"stage 不是等待"一条
// 在字段缺失时也判定通过 —— 空值假通过。现在每条断言都先要求字段**存在**。
const getJob = async (id) => (await api('GET', `/api/harness/job?id=${encodeURIComponent(id)}`)).json;
let first = null, second = null;
{
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    first = await getJob(jobs[0]);
    second = await getJob(jobs[1]);
    if (second?.model_slot === 'waiting') break;
    await new Promise((s) => setTimeout(s, 2000));
  }
  const hasSlot = (j) => typeof j?.model_slot === 'string' && j.model_slot !== '';
  check('作业载荷带 model_slot 字段（结构化，不靠匹配中文）', hasSlot(first) && hasSlot(second),
    `一=${JSON.stringify(first?.model_slot)} 二=${JSON.stringify(second?.model_slot)}`);
  check('第二个作业被标为 waiting（不再是"运行中"）', second?.model_slot === 'waiting',
    `model_slot=${second?.model_slot}`);
  check('它的 stage 写明了在等槽位',
    typeof second?.stage === 'string' && /等待模型槽位/.test(second.stage), `stage=${second?.stage}`);
  check('第一个作业是 running', first?.model_slot === 'running', `model_slot=${first?.model_slot}`);
  check('第一个的 stage 没被写成等待',
    typeof first?.stage === 'string' && !/等待模型槽位/.test(first.stage),
    `stage=${JSON.stringify(first?.stage)}`);
}

// 4) 全局负载也应当如实反映
{
  const st = (await api('GET', '/api/harness/status')).json || {};
  check('全局 model_load 显示忙 + 有人在等',
    st.model_load?.busy === true && Number(st.model_load?.waiters) >= 1, JSON.stringify(st.model_load));
  check('并暴露并发上限', st.concurrency === 2, `concurrency=${st.concurrency}`);
}

// 5) 取消两个作业，别让它们占着槽位
for (const id of jobs) await api('POST', '/api/harness/cancel', { job_id: id }).catch(() => {});
await new Promise((s) => setTimeout(s, 3000));
{
  const st = (await api('GET', '/api/harness/status')).json || {};
  check('取消后负载回落（计数不泄漏）',
    st.model_load?.busy === false && st.model_load?.waiters === 0, JSON.stringify(st.model_load));
}

console.log(`\n══════════════════════════════`);
console.log(`模型槽位可观测性：通过 ${pass} / 失败 ${fail}`);
console.log('复核零计费：node .p1-baseline/audit-llm-calls.mjs --since <本命令开始时刻>');
process.exitCode = fail ? 1 : 0;
