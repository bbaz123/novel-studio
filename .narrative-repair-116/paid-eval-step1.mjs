/**
 * 真实付费评测 · 第 1 步：连通性与**实测**计费标定（单次极小调用）。
 *
 * 目的：在花任何第二笔钱之前，先用一次 max_tokens=16 的调用确认
 *   ① 隔离实例真的能用服务端凭据发起调用；② OpenAI 兼容响应里带 usage；
 *   ③ 拿到真实 token 数，用来推算后续评测的总花费上界。
 *
 * 预算：本步预期远低于 0.01 元。若失败则如实记 not_run，不重试、不旁路。
 */
import { makeIsolatedDataDir, startIsolatedServer, BASE } from './paid-eval-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const META = process.env.NOVELSTUDIO_DATA_DIR || path.resolve('data');
const cfg = makeIsolatedDataDir();
console.log(JSON.stringify({ step: 'setup', temp_dir: cfg.dir, config_id: cfg.configId, key_sha8: cfg.keySha8, model: cfg.model, base_url: cfg.baseUrl }, null, 2));

const { stop } = await startIsolatedServer(cfg.dir);
const out = { calls: [], usageTotal: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
try {
  const r = await fetch(`${BASE}/api/ai/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: cfg.configId }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => null);
  const usage = j && j.raw && j.raw.usage ? j.raw.usage : null;
  out.calls.push({ action: 'test', status: r.status, ok: !!(j && j.ok), reply: j && j.reply, model: j && j.raw && j.raw.model, usage });
  if (usage) {
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) out.usageTotal[k] += Number(usage[k]) || 0;
  }
  console.log(JSON.stringify({ step: 'probe', ...out.calls[0] }, null, 2));
} catch (e) {
  out.error = String(e && e.message ? e.message : e);
  console.log(JSON.stringify({ step: 'probe', error: out.error }, null, 2));
} finally {
  stop();
}
console.log(JSON.stringify({ step: 'usage_total', ...out.usageTotal }, null, 2));
fs.writeFileSync(path.resolve('.narrative-repair-116/paid-eval-step1.json'), JSON.stringify({ cfg: { ...cfg, dir: '(temp)' }, out }, null, 2));
