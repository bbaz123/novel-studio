#!/usr/bin/env node
/**
 * reconcile-tasks.mjs —— 审计 / 恢复持久化分析任务（S04）。
 *
 * 设计原则（方案稿 §S04 第 7 条）：**默认只报告计划变更**。
 * 这是刻意的：本脚本会碰真实库里的任务状态，而"恢复"这件事包含一个不可逆的判断——
 * 已发送的请求要不要重发。默认 dry-run 让作者先看清要发生什么，再决定是否 `--apply`。
 *
 * 三级处置（与 queue-store 的 reconciliation 一致）：
 *   · `requeue`      —— 租约过期且 `transport_state='not_sent'`：请求肯定没发出去，可安全重跑
 *   · `mark_unknown` —— 租约过期但 `='sent'`：**请求可能已发出、可能已计费** → 不自动重发，转人工
 *   · `leave`        —— 已是 unknown：保持不动
 *
 * 用法：
 *   node scripts/nsdsh/reconcile-tasks.mjs --fixture --dry-run      # 临时库演练（CI 用）
 *   node scripts/nsdsh/reconcile-tasks.mjs --dry-run                # 真实库只读审计
 *   node scripts/nsdsh/reconcile-tasks.mjs --apply                  # 真正执行（需显式指定）
 *
 * ⚠️ 默认**不开** `--apply`；没有 `--dry-run` 也没有 `--apply` 时按 dry-run 处理并提示。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIsolatedEnv } from './lib/isolate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const fixture = args.has('--fixture');
const apply = args.has('--apply');
const dryRun = !apply; // 默认 dry-run

/** 造一个 fixture 任务集（只在 --fixture 下用；绝不碰作者的真实库）。 */
async function buildFixture(db, Q) {
  const nowIso = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run('reconcile-fixture', nowIso, nowIso);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, '第1章', '<p>x</p>', 0, nowIso, nowIso);
  const chapterId = Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id);
  const T0 = 1_000_000;
  // ① 未发送 → 应 requeue
  Q.recordIntent(db, { workId, chapterId, nowMs: T0, debounceMs: 0, maxWaitMs: 1000 });
  const a = Q.claimNext(db, { owner: 'fixture-old', nowMs: T0, leaseMs: 100 });
  // ② 已发送 → 应 mark_unknown
  db.prepare("INSERT INTO story_analysis_tasks (work_id, chapter_id, kind, status, not_before_ms, max_wait_ms, created_at_ms, updated_at_ms) VALUES (?, ?, 'impact', 'queued', ?, ?, ?, ?)")
    .run(workId, chapterId, T0, T0 + 1000, T0, T0);
  const b = Q.claimNext(db, { owner: 'fixture-old', kind: 'impact', workId, nowMs: T0, leaseMs: 100 });
  Q.markSent(db, { taskId: b.id, owner: 'fixture-old', generation: b.lease_generation, nowMs: T0 + 5 });
  // ③ 已经是 unknown → 应 leave
  db.prepare("INSERT INTO story_analysis_tasks (work_id, chapter_id, kind, status, transport_state, not_before_ms, max_wait_ms, created_at_ms, updated_at_ms) VALUES (?, ?, 'analysis', 'unknown', 'unknown', ?, ?, ?, ?)")
    .run(workId, chapterId, T0, T0 + 1000, T0, T0);
  return { workId, chapterId, claimed: [a && a.id, b && b.id], nowMs: T0 + 500 };
}

async function main() {
  let env = null;
  let fixtureInfo = null;
  if (fixture) {
    env = makeIsolatedEnv({ label: 'nsdsh-reconcile-' });
    env.install();
  }
  const { db } = await import(path.join(REPO, 'db.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const Q = await import(path.join(REPO, 'ai', 'jobs', 'queue-store.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  if (fixture) fixtureInfo = await buildFixture(db, Q);

  const nowMs = fixtureInfo ? fixtureInfo.nowMs : Date.now();
  const workId = fixtureInfo ? fixtureInfo.workId : 0;
  const plan = Q.planReconciliation(db, { nowMs, workId });
  const applied = dryRun ? plan.map((p) => ({ ...p, applied: false })) : Q.applyReconciliation(db, { nowMs, workId });
  const after = Q.overview(db, { workId });

  if (asJson) {
    console.log(JSON.stringify({ dryRun, plan, applied, overview: after, fixture: !!fixture }, null, 2));
  } else {
    console.log(`分析任务审计（${dryRun ? 'DRY-RUN：只报告，不改库' : 'APPLY：已执行'}）`);
    if (fixture) console.log(`  fixture：work=${fixtureInfo.workId} chapter=${fixtureInfo.chapterId}`);
    console.log(`  租约已过期的 running 任务：${plan.length} 条`);
    for (const p of applied) {
      console.log(`    · 任务 ${p.taskId} → ${p.action}（${p.reason}）`);
    }
    if (!plan.length) console.log('    （没有需要处理的任务：要么没有过期租约，要么都已回收）');
    console.log(`  当前快照：${JSON.stringify(after)}`);
    if (dryRun && plan.length) console.log('\n要真正执行，请显式加 --apply');
  }

  if (env) env.cleanup();
  // 有需要人工处理的任务时给出非零退出，让 CI 能发现"卡住的 unknown"。
  const needsHuman = after.byStatus && after.byStatus.unknown ? after.byStatus.unknown : 0;
  return needsHuman > 0 ? 3 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error(`✗ reconcile-tasks 失败：${(e && e.message) || e}`);
  process.exitCode = 1;
});
