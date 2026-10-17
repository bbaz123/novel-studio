#!/usr/bin/env node
/**
 * scripts/nsdsh/capture-model-contract.mjs —— S10：捕获"模型实际收到了什么"。
 *
 * 为什么必须有它：只测"提示词生成器返回了字符串"是不够的 —— 真正决定模型行为的，
 * 是**最终发出去的那个请求体**（messages 结构、tools 契约、参数）。S10 明确要求
 * "捕获 fake provider 收到的实际请求与工具契约"。
 *
 * 做法：
 *   ① 在**回环地址**上起一个一次性 fake provider（零计费、不出本机）；
 *   ② 用真实的 `createTaskEnvelope` + 路由结果构造信封，指向这个 fake provider；
 *   ③ 跑 `createDirectAdapter`，让适配器真的发一次 HTTP；
 *   ④ 把 fake provider **实际收到**的 header / body / messages 形状打印出来，并做契约断言。
 *
 * 用法：
 *   node scripts/nsdsh/capture-model-contract.mjs --fixture          # 打印契约（CI 用）
 *   node scripts/nsdsh/capture-model-contract.mjs --fixture --json   # 机器可读
 *
 * 退出码：0 = 契约成立；1 = 契约不成立（会被门禁判红）。
 */
import http from 'node:http';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
if (!args.has('--fixture')) {
  console.error('拒绝执行：capture-model-contract 只支持 --fixture（不连真实模型）');
  process.exit(1);
}

const E = await import('../../ai/model-broker/envelope.mjs');
const A = await import('../../ai/model-broker/adapters.mjs');

/** 一次性 fake provider：记录收到的请求，返回一个合法的 chat completion。 */
function startFakeProvider() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      captured.push({
        method: String(req.method || ''),
        path: String(req.url || ''),
        content_type: String(req.headers['content-type'] || ''),
        has_authorization: !!req.headers.authorization,
        body_chars: raw.length,
        body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"events":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, captured, port: server.address().port }));
  });
}

const fake = await startFakeProvider();
const baseUrl = `http://127.0.0.1:${fake.port}/v1`;

const problems = [];
try {
  const route = {
    ok: true, version: 'route-v1', purpose: 'analysis', work_id: 1,
    route: { source: 'work', purpose: 'analysis', api_config_id: 1 },
    config: { id: 1, name: 'fixture-provider', base_url: baseUrl, model: 'fixture-model', api_key: '' },
    needs_api_key: false, has_api_key: false,
  };
  const envelope = E.createTaskEnvelope({
    workId: 1, purpose: 'analysis', route, taskId: 42, chapterId: 3, revisionId: 'rev_fixture',
    budget: { maxRequests: 3, deadlineMs: 30_000 },
  });
  const ledger = E.createBudgetLedger(envelope);

  // 真实发一次请求：走 direct 适配器 + 客户端已存在的 callAI 形态（这里用最小 fetch 实现）
  const callAI = async (cfg, messages) => {
    ledger.takeRequest({ note: 'capture-model-contract' });
    const r = await fetch(`${cfg.base_url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}) },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
    });
    const j = await r.json();
    const out = { text: String(j?.choices?.[0]?.message?.content ?? ''), usage: j?.usage || null };
    ledger.recordUsage(out.usage || {});
    return out;
  };
  const direct = A.createDirectAdapter({ callAI });
  const result = await direct.run(envelope, {
    messages: [
      { role: 'system', content: '你是状态记账员。只输出 JSON。' },
      { role: 'user', content: '本章正文：甲推开门。' },
    ],
  });

  if (fake.captured.length !== 1) problems.push(`fake provider 应收到 1 次请求，实际 ${fake.captured.length}`);
  const req0 = fake.captured[0] || {};
  if (!/\/chat\/completions$/.test(String(req0.path || ''))) problems.push(`请求路径应为 …/chat/completions，实际 ${req0.path}`);
  if (!/application\/json/.test(String(req0.content_type || ''))) problems.push('content-type 应为 application/json');
  const msgs = req0.body && Array.isArray(req0.body.messages) ? req0.body.messages : null;
  if (!msgs || msgs.length < 2) problems.push('请求体必须带 messages 数组（system + user）');
  else {
    if (msgs[0].role !== 'system') problems.push('第一条消息必须是 system');
    if (!msgs.some((m) => m.role === 'user')) problems.push('必须有一条 user 消息');
  }
  if (req0.body && req0.body.model !== envelope.model.model) problems.push('请求体的 model 必须等于信封里的模型');
  // 信封里不得带密钥；本地 provider 也不该被塞 Authorization
  if (JSON.stringify(envelope).includes('"api_key"')) problems.push('信封不得包含 api_key 字段');
  if (req0.has_authorization) problems.push('本地无 key provider 不应发送 Authorization');
  // 结果契约
  const resultProblems = A.assertResultContract(result);
  if (resultProblems.length) problems.push(`结果契约不成立：${resultProblems.join(', ')}`);
  if (!result.ok || result.status !== 'done') problems.push(`本次调用应当成功，实际 ok=${result.ok} status=${result.status} error=${result.error}`);
  if (!result.usage || result.usage.total_tokens !== 18) problems.push(`usage 必须被归一化记录，实际 ${JSON.stringify(result.usage)}`);

  const out = {
    version: 'capture-v1',
    capture: {
      method: req0.method, path: req0.path, content_type: req0.content_type,
      has_authorization: req0.has_authorization,
      body_keys: req0.body ? Object.keys(req0.body).sort() : [],
      message_roles: msgs ? msgs.map((m) => m.role) : [],
      model: req0.body ? req0.body.model : null,
    },
    envelope: {
      version: envelope.version, purpose: envelope.purpose, work_id: envelope.work_id,
      route: envelope.route, model: envelope.model, budget: envelope.budget,
      frozen: Object.isFrozen(envelope),
    },
    result: { ok: result.ok, status: result.status, usage: result.usage, provider: result.provider },
    budget: ledger.snapshot(),
    problems,
  };

  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('模型请求契约捕获（fixture，零计费）');
    console.log(`  端点 ${req0.method} ${req0.path}  content-type=${req0.content_type}  authorization=${req0.has_authorization}`);
    console.log(`  请求体字段：${(out.capture.body_keys || []).join(', ')}`);
    console.log(`  消息角色：${(out.capture.message_roles || []).join(' → ')}`);
    console.log(`  模型：${out.capture.model}（来自信封，不是"第一个有 key 的配置"）`);
    console.log(`  信封冻结：${out.envelope.frozen}；预算：requests=${out.budget.requests}/${out.budget.limits.max_requests}`);
    console.log(`  结果：ok=${out.result.ok} status=${out.result.status} usage.total=${out.result.usage?.total_tokens}`);
    if (problems.length) { console.log('  ✗ 契约问题：'); for (const p of problems) console.log('    - ' + p); }
    else console.log('  ✓ 请求契约 / 信封不可变 / 预算记账 / 结果契约 均成立');
  }
} finally {
  if (typeof fake.server.closeAllConnections === 'function') fake.server.closeAllConnections();
  await new Promise((r) => fake.server.close(r));
}

process.exit(problems.length ? 1 : 0);
