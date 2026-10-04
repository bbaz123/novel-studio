#!/usr/bin/env node
/**
 * 临时验证脚本（2026-10-02）：在隔离实例上验证**思考期心跳**真的下发到 HTTP 流上。
 *
 * 为什么要这样一个脚本：心跳是"服务端 SSE 帧"这一层的事实，DOM 桩只能验证客户端**收到后**
 * 怎么渲染，验证不了"服务端到底发没发、发的内容有没有夹带推理正文"。
 * 做法：本脚本自己起一个假模型端点（只回 SSE，回"很久的思考 + 一点正文"），
 * 通过隔离实例的 /api/api_configs 把 base_url 指过去，再打 /api/ai/write_stream 读原始帧。
 *
 * 纪律：只打 127.0.0.1 上的隔离实例（默认 3738）与本脚本自己的假端点；不触碰 3737 与真实库。
 */
import http from 'node:http';

const NOVEL = process.env.VERIFY_BASE || 'http://127.0.0.1:3738';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// ── 假模型端点：先吐若干帧 reasoning_content（"思考"），再吐正文 delta，最后 usage + [DONE]
const mockFrames = (n) => Array.from({ length: n }, (_, i) => ({
  choices: [{ delta: { reasoning_content: `思考片段${i}-`.repeat(6) } }]
}));
const mock = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  // 思考分 5 批、每批间隔 300ms（总思考期 ≈1.5s，足以触发至少一次 2.5s 心跳吗？
  // 不足 —— 所以下面thinking 批数放大到 12 批 × 300ms ≈3.6s）
  for (const f of mockFrames(12)) { send(f); await new Promise((r) => setTimeout(r, 300)); }
  send({ choices: [{ delta: { content: '正文第一段。' } }] });
  await new Promise((r) => setTimeout(r, 200));
  send({ choices: [{ delta: { content: '正文第二段。' } }] });
  send({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } });
  send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
console.log(`假模型端点：http://127.0.0.1:${mockPort}`);

async function post(path, body, extra = {}) {
  const res = await fetch(NOVEL + '/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

// ── 在隔离实例里建一条指向假端点的 API 配置（不覆盖任何真实配置）
const cfg = await post('/api_configs', {
  name: `心跳验证-${Date.now()}`,
  base_url: `http://127.0.0.1:${mockPort}`,
  api_key: 'sk-verify-heartbeat',
  model: 'deepseek-flash',
  temperature: 0.2,
  max_tokens: 512
});
check('隔离实例接受指向假端点的 API 配置（不消耗真实额度）', cfg.status === 201 && cfg.json && cfg.json.id, `status=${cfg.status}`);
const cfgId = cfg.json && cfg.json.id;

try {
  // ── 打 /api/ai/write_stream，逐帧读取
  const res = await fetch(NOVEL + '/api/ai/write_stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: cfgId, messages: [{ role: 'user', content: '写一段' }], max_tokens: 512 })
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const frames = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { frames.push(JSON.parse(payload)); } catch { /* 忽略非 JSON 行 */ }
    }
  }
  const thinking = frames.filter((f) => f.phase === 'thinking');
  const beats = thinking.filter((f) => f.heartbeat === true);
  const deltas = frames.filter((f) => typeof f.delta === 'string');
  const doneFrame = frames.find((f) => f.done === true);

  check('服务端下发"进入思考"相位', thinking.length >= 1 && thinking[0].heartbeat !== true, `thinking=${thinking.length}`);
  check('思考期心跳按 ≈2.5s 节奏下发（本次思考≈3.6s，应至少 1 次）', beats.length >= 1, `heartbeats=${beats.length}`);
  check('心跳带 elapsed_ms 与 reasoning_chars（让界面能说"已思考 Ns / 思考 M 字"）',
    beats.every((b) => Number(b.elapsed_ms) > 2000 && Number(b.reasoning_chars) > 0),
    JSON.stringify(beats.map((b) => ({ ms: b.elapsed_ms, chars: b.reasoning_chars }))));
  check('心跳**不夹带推理正文**（只有规模量，没有内容字段）',
    beats.every((b) => !('reasoning_content' in b) && !('text' in b) && !('content' in b)),
    JSON.stringify(Object.keys(beats[0] || {})));
  check('正文 delta 照常下发、done 帧照常带全文与用量', deltas.length === 2 && doneFrame && doneFrame.text.includes('正文第一段') && !!doneFrame.usage,
    `deltas=${deltas.length} text=${doneFrame && doneFrame.text}`);

  // 收尾：把验证用的配置删掉（隔离库，仍保持自清理）
  const del = await fetch(NOVEL + `/api/api_configs/${cfgId}`, { method: 'DELETE' });
  check('验证用 API 配置已清理', del.ok || del.status === 404, `status=${del.status}`);
} finally {
  mock.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过${failed.length ? '，失败：' + failed.map((f) => f.name).join(' | ') : ''} ===`);
process.exit(failed.length ? 1 : 0);
