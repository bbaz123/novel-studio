#!/usr/bin/env node
/**
 * verify-host.mjs —— 真实调用 open / status（需要审计环境）。
 *
 * 没有 NOVELSTUDIO_AUDIT_ID/TOKEN 时**明确 SKIPPED**（不是 PASS）：
 * 这不是"没测也行"，而是"这一项需要一次真实审计才能测"。
 * 真实联调由 scripts/quality-auditor/real-host.mjs 负责。
 */
import { apply } from '../lib/index.js';

const env = process.env;
const hasAudit = Boolean(String(env.NOVELSTUDIO_AUDIT_ID || '').trim() && String(env.NOVELSTUDIO_AUDIT_TOKEN || '').trim());
if (!hasAudit) {
  console.log('SKIPPED  verify-host：没有 NOVELSTUDIO_AUDIT_ID / NOVELSTUDIO_AUDIT_TOKEN（需要一次真实审计任务）');
  process.exit(0);
}
const tools = {};
const ctx = { tools: { register(def) { tools[def.name] = def; } }, on() {} };
apply(ctx, {});
const call = async (name, args) => JSON.parse((await tools[name].execute(args)).text);
try {
  const opened = await call('novel_quality_open', {});
  const status = await call('novel_quality_status', {});
  console.log('open:', JSON.stringify({ ok: opened.ok, kind: opened.kind, phase: opened.phase, resources: (opened.resources || []).map((r) => r.name) }));
  console.log('status:', JSON.stringify({ ok: status.ok, status: status.status, missing: status.missing_requirements }));
  if (!opened.ok || !status.ok) process.exit(1);
  console.log('✓ verify-host 通过');
} catch (e) {
  console.error('✗ verify-host 失败：' + (e && e.message || e));
  process.exit(1);
}
