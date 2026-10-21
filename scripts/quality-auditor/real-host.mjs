#!/usr/bin/env node
/**
 * real-host.mjs —— 真实 DSH 子进程端到端联调（方案 CO-12 / 最终完成条件 2、8）。
 *
 * 链路：创建审计(start:true) → 真实 dsh 子进程 → open → read → blind_draft → compare
 *        → final → 主机校验 → 合并 → 读回最新审稿。
 *
 * 前提（缺一不可）：
 *   · NOVELSTUDIO_REAL_AUDIT=1（显式 opt-in，避免被 CI 误跑花钱）；
 *   · NOVELSTUDIO_DSH_BIN 指向 0.2.0-rc.2 的 lib/bin.js（本机 npm-global 安装）；
 *   · 作者已授权预算（默认单次/累计 ≤ ¥2；未知价格不虚构，只如实记录"未知"）。
 *
 * 成功判据不是"进程退出 0"，而是账本进入 COMPLETED 且合并出新的审稿记录。
 */
import { spawn } from 'node:child_process';
import { jfetch, startServer, stopServer, waitReady, freePort, tempDir, cleanup, ARTICLE, BLUEPRINT, INITIAL_REPORT } from './harness.mjs';

if (process.env.NOVELSTUDIO_REAL_AUDIT !== '1') {
  console.log('SKIPPED  real-host：未设置 NOVELSTUDIO_REAL_AUDIT=1（真实模型调用需显式 opt-in）');
  process.exit(0);
}
const DSH_BIN = String(process.env.NOVELSTUDIO_DSH_BIN || '').trim();
if (!DSH_BIN) {
  // 不设 bin 时走工坊**默认解析**（同级 deepseek-harness 源码仓库）。
  // 这是"版本兼容性探针"路径：用于回答"当前默认环境到底能不能跑通审计"，
  // 与"按固定 0.2.0-rc.2 验证"是两件事，输出里会打印实际用的入口。
  console.log('未设置 NOVELSTUDIO_DSH_BIN：使用工坊默认 dsh 解析（同级 deepseek-harness）');
}

const PORT = await freePort();
const DATA = tempDir('novel-qa-real-');
const srv = startServer({ port: PORT, dataDir: DATA, env: { NOVELSTUDIO_DSH_BIN: DSH_BIN } });
if (!(await waitReady(srv.base))) {
  console.error('实例未就绪：\n' + srv.log.text.slice(-3000));
  await stopServer(srv); cleanup(DATA); process.exit(2);
}

// 更长的样本：真实模型要有可审的东西。
const LONG_ARTICLE = ARTICLE + '\n\n' + [
  '第二天清晨，雨停了。陈默把信摊在桌上，纸背透出两种不同的墨色。',
  '“这封信被改过。”林清雪说。她指着末尾那行小字：三天后见。',
  '陈默没有接话。他想起昨夜她说“你迟到了”时的语气，像是早就知道他会来。',
  '窗外的街市开始喧闹。有人敲了三下门，又停了。',
].join('\n');

const work = await jfetch(srv.base, '/api/works', { method: 'POST', body: { title: '真实联调样本' } });
// 短样本：模型一次 read 就能读全，减少步数与费用（长样本留给人工验收）。
const SAMPLE = ARTICLE;
const chapter = await jfetch(srv.base, '/api/chapters', {
  method: 'POST',
  body: { work_id: work.data.id, title: '第一章 雨夜', content: SAMPLE.split('\n').map((l) => (l ? `<p>${l}</p>` : '')).join('') },
});
// 初审：引用必须逐字存在（服务端会核验）。
const reviewReport = JSON.parse(JSON.stringify(INITIAL_REPORT));
reviewReport.base_text = SAMPLE;
const seeded = await jfetch(srv.base, '/api/novel/review', {
  method: 'PUT',
  body: { chapter_id: chapter.data.id, base_text: SAMPLE, base_hash: 'sha256:real-fixture', report: reviewReport },
});
if (seeded.status !== 201) {
  console.error('初审落库失败：' + JSON.stringify(seeded.data).slice(0, 500));
  await stopServer(srv); cleanup(DATA); process.exit(2);
}

const created = await jfetch(srv.base, '/api/novel/quality-audits', {
  method: 'POST',
  body: {
    kind: 'review', chapter_id: chapter.data.id, review_id: seeded.data.review_id,
    base_hash: 'sha256:real-fixture', start: true, timeout_ms: 15 * 60 * 1000,
    // 费用未知：不传 estimated_cost_cny → budget.cost_known=false，只如实展示，不虚构数字。
  },
});
console.log('create:', JSON.stringify({ status: created.status, audit_id: created.data.audit_id, started: created.data.started, start_error: created.data.start_error }).slice(0, 400));
if (created.status !== 201) {
  console.error('创建审计失败：' + JSON.stringify(created.data).slice(0, 800));
  await stopServer(srv); cleanup(DATA); process.exit(2);
}
const auditId = created.data.audit_id;

const TERMINAL = new Set(['COMPLETED', 'FAILED_CONTRACT', 'FAILED_AUTH', 'FAILED_DSH', 'AUDIT_NOT_SUBMITTED', 'INTERRUPTED', 'CANCELLED', 'STALE']);
let last = null;
const deadline = Date.now() + 16 * 60 * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await jfetch(srv.base, `/api/novel/quality-audits/${auditId}`);
  last = st.data;
  const status = String(st.data?.run?.status || '');
  process.stdout.write(`\rstatus=${status} phase=${st.data?.run?.phase || ''}   `);
  // RESULT_RECEIVED 不是终态，但它是"该宿主接管"的节点：退出轮询去做主机校验 + 合并。
  if (TERMINAL.has(status) || status === 'RESULT_RECEIVED') break;
}

let status = String(last?.run?.status || '');
// 主机校验是**宿主**的职责（DSH 不能自己宣布通过）：收到结果后由本脚本调用 verify。
if (status === 'RESULT_RECEIVED') {
  const v = await jfetch(srv.base, `/api/novel/quality-audits/${auditId}/verify`, { method: 'POST', body: {} });
  console.log('verify:', v.status, v.data?.status || v.data?.code || '');
  if (v.status === 200) status = String(v.data.status || 'HOST_VERIFIED');
}
// 合并（review）由宿主触发；只有 HOST_VERIFIED 才允许。
const mergedOnce = status === 'HOST_VERIFIED'
  ? await jfetch(srv.base, `/api/novel/quality-audits/${auditId}/merge`, { method: 'POST', body: {} })
  : null;
if (mergedOnce && mergedOnce.status === 200 && mergedOnce.data?.status === 'COMPLETED') status = 'COMPLETED';
const events = (last?.events || []).map((e) => e.event_type);
const items = last?.items || [];
console.log('\n\n=== 结果 ===');
console.log('status:', status);
console.log('events:', events.join(' → '));
console.log('items:', items.length, items.map((i) => `${i.issue_id}/${i.source}/${i.verdict || i.kind}`).join(', '));
console.log('budget:', JSON.stringify(last?.run?.budget));
console.log('error:', JSON.stringify(last?.run?.error_code), String(last?.run?.error_detail || '').slice(0, 1200));

let reviewId = mergedOnce && mergedOnce.data ? (mergedOnce.data.review_id || null) : null;
if (status === 'COMPLETED') {
  const readBack = await jfetch(srv.base, `/api/novel/review?chapter_id=${chapter.data.id}`);
  const rep = readBack.data?.review?.report || {};
  console.log('merged_review_id:', reviewId, 'issues:', (rep.issues || []).length, 'findings:', (rep.findings || []).length, 'integrity:', rep.integrity?.code);
}

const ok = status === 'COMPLETED' && Number(reviewId) > 0;
console.log(ok ? '\n✓ real-host 通过（真实 DSH 子进程完成盲审→对照→合并）' : '\n✗ real-host 未通过（见上面的 status/error）');
await stopServer(srv);
cleanup(DATA);
process.exit(ok ? 0 : 1);
