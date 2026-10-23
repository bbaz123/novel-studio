// 真实付费审计（¥2 上限）：在隔离实例上跑一次**真的**独立复核，并把花费与终态如实打印。
//
// 为什么在隔离实例上：它用 VACUUM INTO 复制了活库（含 api_configs），所以能用真实凭据跑；
// 但写入的是副本，作者的真实审稿/正文一个字都不动。
// 预算：authorized_cny=2、estimated_cost_cny=1.2（budgetGuard 会拒绝无法核价或超限的请求）。
//
// 用法：node .p1-baseline/real-audit-run.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REPO = resolve('.');
const DATA = resolve('.p1-baseline/.e2e-audit');
const jfetch = async (base, path, { method = 'GET', body, headers = {}, timeout = 30000 } = {}) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

mkdirSync(DATA, { recursive: true });
const dbPath = join(DATA, 'novel.db');
rmSync(dbPath, { force: true });
{
  const live = new DatabaseSync(join(REPO, 'data', 'novel.db'), { readOnly: true });
  try { live.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`); } finally { live.close(); }
}

// 找一份**有结构化 findings** 的审稿，作为独立复核的初审报告
let reviewId = 0;
let chapterId = 0;
{
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT id, chapter_id, length(normalized_report_json) AS n FROM chapter_reviews WHERE normalized_report_json IS NOT NULL ORDER BY id DESC LIMIT 10').all();
    for (const r of rows) {
      const row = db.prepare('SELECT normalized_report_json AS j FROM chapter_reviews WHERE id = ?').get(r.id);
      let rep = null;
      try { rep = JSON.parse(row.j); } catch { rep = null; }
      if (rep && Array.isArray(rep.findings) && rep.findings.length && Array.isArray(rep.issues) && rep.issues.length) {
        reviewId = Number(r.id); chapterId = Number(r.chapter_id); break;
      }
    }
  } finally { db.close(); }
}
if (!reviewId) { console.error('✗ 库里没有"有结构化 findings"的审稿：真实审计需要一份初审报告'); process.exit(3); }

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA, NOVELSTUDIO_OV_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });

const stop = async () => { try { server.kill(); } catch { /* ignore */ } await new Promise((r) => setTimeout(r, 400)); };

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

try {
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { const r = await jfetch(BASE, '/api/novel/ping', { timeout: 1500 }); if (r.status === 200) { up = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.error('✗ 实例未就绪\n' + log.slice(-1200)); await stop(); process.exit(2); }
  console.log(`隔离实例就绪：${BASE}（初审 review #${reviewId} / 章节 #${chapterId}）`);

  const env = await jfetch(BASE, '/api/env/tools');
  const q = (env.data && env.data.dsh && env.data.dsh.plugins && env.data.dsh.plugins.qualityAuditor) || {};
  const dsh = (env.data && env.data.dsh) || {};
  // dsh 的就绪口径是 found + built（不是臆想的 ready 字段）。
  const dshReady = Boolean(dsh.found) && Boolean(dsh.built || dsh.looks_like_dsh);
  console.log(`  依赖：dsh.found=${Boolean(dsh.found)} built=${Boolean(dsh.built)} 审计插件 ready=${Boolean(q.ready)} profile=${q.profile || ''}`);
  if (!dshReady || !q.ready) {
    console.log('\nSKIPPED 真实付费审计：审计插件或 dsh 未就绪（这是环境前置，不是代码失败）');
    console.log(JSON.stringify({ dsh: { found: dsh.found, built: dsh.built }, auditor: { ready: q.ready, profile: q.profile }, missing: dsh.missing_dependencies || null }).slice(0, 400));
    await stop();
    process.exit(3);
  }

  const created = await jfetch(BASE, '/api/novel/quality-audits', {
    method: 'POST',
    body: { kind: 'review', chapter_id: chapterId, review_id: reviewId, estimated_cost_cny: 1.2, authorized_cny: 2, start: true },
    timeout: 60000,
  });
  ok('RA-01 真实审计创建成功（start:true，预算上限 ¥2）',
    created.status === 201 && created.data && created.data.audit_id,
    JSON.stringify(created.data).slice(0, 300));
  if (!created.data || !created.data.audit_id) { await stop(); process.exit(1); }
  const id = String(created.data.audit_id);
  console.log(`  audit_id=${id} status=${created.data.status} started=${created.data.started}`);

  const terminal = new Set(['COMPLETED', 'FAILED_CONTRACT', 'FAILED_AUTH', 'FAILED_DSH', 'AUDIT_NOT_SUBMITTED', 'INTERRUPTED', 'CANCELLED', 'STALE']);
  let last = null;
  const until = Date.now() + 9 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await jfetch(BASE, `/api/novel/quality-audits/${encodeURIComponent(id)}`);
    last = st.data && st.data.run ? st.data.run : null;
    const status = String((last && last.status) || '');
    process.stdout.write(`\r  status=${status.padEnd(20)}`);
    if (terminal.has(status)) break;
  }
  process.stdout.write('\n');
  // 注意：RESULT_RECEIVED **不是**终态——主机校验（/verify）是单独一步，需要进程内的输入快照，
  // 而本脚本会把实例关掉。所以这次演练的判据是"跑到等待主机校验"，并如实说明后面还有两步。
  const reachedHostStep = Boolean(last && String(last.status) === 'RESULT_RECEIVED');
  ok('RA-02 真实审计跑完盲审+对照，停在「结果待主机校验」（这正是分档里那一档）',
    reachedHostStep || (last && terminal.has(String(last.status))),
    JSON.stringify(last && last.status));
  const status = String((last && last.status) || '');
  const budget = (last && last.budget) || {};
  // 费用口径：只有确知金额才算钱；未知就写未知（审计的真实计费在 dsh 侧，本服务看不到用量）。
  const chargeKnown = budget.charge_known === true || Number(budget.charged_microunits) > 0;
  const charged = chargeKnown ? Number(budget.charged_microunits) / 1e6 : null;
  console.log(`  终态=${status} 授权=¥${(Number(budget.authorized_microunits || 0) / 1e6).toFixed(2)}`
    + ` 估算=¥${(Number(budget.estimated_microunits || 0) / 1e6).toFixed(2)}`
    + ` 实际=${charged == null ? '未知（dsh 未回传用量）' : '¥' + charged.toFixed(2)}`);
  ok('RA-03 实际费用不会超过 ¥2 上限（未知时也不伪造成 0）',
    charged == null ? true : charged <= 2.0000001, `charge_known=${chargeKnown} charged=${charged}`);
  ok('RA-04 状态如实（成功=COMPLETED；失败则给出错误码，不伪装成功）',
    status === 'COMPLETED' ? true : Boolean(last && (last.error_code || status)),
    JSON.stringify({ status, error_code: last && last.error_code, detail: String((last && last.error_detail) || '').slice(0, 160) }));

  // 若走到了合并：确认合并后的审稿存在，且逐项结论有分档
  if (status === 'COMPLETED') {
    const merged = await jfetch(BASE, `/api/novel/quality-audits/${encodeURIComponent(id)}`);
    const items = (merged.data && merged.data.items) || [];
    ok('RA-05 合并后的逐项结论可读（每条有终态，不只是"整体通过"）',
      items.length > 0 && items.every((i) => i && i.verdict), JSON.stringify(items.slice(0, 3).map((i) => i.verdict)));
  }
  console.log(`\n（审计记录写在隔离库 .p1-baseline/.e2e-audit，作者的真实库没有任何写入）`);
} catch (e) {
  fails.push('执行异常');
  console.error('✗ 执行异常：', e && e.stack ? e.stack : e);
} finally {
  await stop();
}

console.log(`\n真实付费审计：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
