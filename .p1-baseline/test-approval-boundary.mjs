#!/usr/bin/env node
/**
 * test-approval-boundary.mjs —— R02.2「作者审批 = 模型侧写入的执行边界」HTTP 级隔离测试（零计费）。
 *
 * 为什么必须做 HTTP 级：审批的语义全部在**服务端事务**里（谁创建、何时消费、基线怎么算、
 * 消费与写入是否同生共死）。只读源码或只测模块函数都证明不了这些，必须对着一个真实实例打请求。
 *
 * 隔离配方（绝不碰作者正式库 / 正式 OV namespace）：
 *   NOVELSTUDIO_DATA_DIR=<tmp>  PORT=<random>  NOVELSTUDIO_OV_DISABLED=1
 *   NOVELSTUDIO_OPENVIKING_PEER_ID=enh-approval-test
 *
 * 覆盖矩阵：
 *   A. 模型侧（X-Novel-Agent）无审批写入 → 403，正文不变；布尔型 approved=true 无授权效力
 *   B. 作者通道不带标记 → 语义与旧版一致（不需要审批）
 *   C. 审批只能由作者创建/撤销；模型创建/撤销 → 403
 *   D. 绑定校验：章节 / 作品 / 操作类型 / 基线 hash / 快照 / 提案集合（越界提案不放行）
 *   E. 单次消费：重放 → 403 consumed；并发双写只有一次成功
 *   F. 过期 / 撤销 / 消费后失效（含状态字变化）
 *   G. 消费与写入同一事务：写入中途失败 → 正文不变、审批仍未消费（可重试）
 *   H. 故事状态提案 apply / 旧提案 apply / 快照 rollback 的模型侧边界
 *
 * 用法: node .p1-baseline/test-approval-boundary.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(5400 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(5400 + (process.pid % 400)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-approval-'));
const AGENT = { 'x-novel-agent': '1' };

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

async function jfetch(path, { method = 'GET', body, headers = {}, timeout = 15000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const authorReq = (path, opts = {}) => jfetch(path, opts);
const agentReq = (path, opts = {}) => jfetch(path, { ...opts, headers: { ...AGENT, ...(opts.headers || {}) } });

console.log(`审批边界隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    NOVELSTUDIO_DATA_DIR: DATA_DIR,
    NOVELSTUDIO_OV_DISABLED: '1',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'enh-approval-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try {
    const r = await jfetch('/api/novel/ping', { timeout: 2000 });
    if (r.status === 200) ready = true;
  } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) {
  console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000));
  try { server.kill(); } catch { /* 已退出 */ }
  process.exit(2);
}

/** 直连隔离库改一行（只在测试进程内用；服务端此刻空闲，无并发写）。 */
function dbExec(sql, ...params) {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本无此 PRAGMA */ }
  try { return d.prepare(sql).run(...params); } finally { d.close(); }
}
function dbGet(sql, ...params) {
  const d = new DatabaseSync(join(DATA_DIR, 'novel.db'));
  try { d.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本无此 PRAGMA */ }
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}
const getChapter = async (id) => (await authorReq(`/api/chapters/${id}`)).data;
const approvalOf = async (workId, id) => {
  const r = await authorReq(`/api/novel/approvals?work_id=${workId}&status=all&limit=200`);
  return (r.data.approvals || []).find((a) => a.id === id) || null;
};

try {
  // ── 准备：作品 / 章节 / 正文 ───────────────────────────────────────────────
  const w1 = await authorReq('/api/works', { method: 'POST', body: { title: '审批边界·甲书' } });
  const w2 = await authorReq('/api/works', { method: 'POST', body: { title: '审批边界·乙书' } });
  const work1 = w1.data.id; const work2 = w2.data.id;
  const c1 = await authorReq('/api/chapters', { method: 'POST', body: { work_id: work1, title: '第一章' } });
  const c2 = await authorReq('/api/chapters', { method: 'POST', body: { work_id: work1, title: '第二章' } });
  const c3 = await authorReq('/api/chapters', { method: 'POST', body: { work_id: work2, title: '乙书第一章' } });
  const ch1 = c1.data.id; const ch2 = c2.data.id; const ch3 = c3.data.id;
  await authorReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>基线正文甲</p>' } });
  await authorReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch2, content: '<p>基线正文乙</p>' } });
  await authorReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch3, content: '<p>基线正文丙</p>' } });
  ok('准备：两本书 + 三章 + 基线正文', !!(work1 && work2 && ch1 && ch2 && ch3), JSON.stringify({ work1, work2, ch1, ch2, ch3 }));

  // ── A. 模型侧无审批 / 布尔自报 ────────────────────────────────────────────
  {
    const r1 = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>模型直写</p>' } });
    ok('A1 模型侧无审批 chapter_save → 403', r1.status === 403, `实际 ${r1.status}`);
    ok('  └ 错误信息可操作（含 approval_id 指引）', String(r1.data.error || '').includes('approval_id'), String(r1.data.error || ''));
    ok('A2 正文未被写入', !(await getChapter(ch1)).content.includes('模型直写'));

    const r2 = await agentReq('/api/novel/chapter_save', {
      method: 'POST', body: { chapter_id: ch1, content: '<p>布尔自报</p>', approved: true, approved_by_user: true },
    });
    ok('A3 客户端布尔 approved=true 不具授权效力 → 403', r2.status === 403, `实际 ${r2.status}`);
    ok('A4 正文仍未被写入', !(await getChapter(ch1)).content.includes('布尔自报'));
  }

  // ── B. 作者通道不受影响 ───────────────────────────────────────────────────
  {
    const r = await authorReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>作者手写甲</p>' } });
    ok('B1 作者通道 chapter_save 无需审批（旧语义保持）', r.status === 200, `实际 ${r.status}`);
  }

  // ── C. 审批只能由作者创建/撤销 ────────────────────────────────────────────
  {
    const r = await agentReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    ok('C1 模型侧创建审批 → 403', r.status === 403, `实际 ${r.status}`);
    const r2 = await agentReq('/api/novel/approvals/revoke', { method: 'POST', body: { id: 'apv_x' } });
    ok('C2 模型侧撤销审批 → 403', r2.status === 403, `实际 ${r2.status}`);
    const r3 = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'nonsense', chapter_id: ch1 } });
    ok('C3 非法 op 审批 → 400', r3.status === 400, `实际 ${r3.status}`);
  }

  // ── D/E. 绑定校验 + 单次消费 + 正确路径 ───────────────────────────────────
  {
    const ap = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    const apId = ap.data.id;
    ok('D1 作者创建 chapter_save 审批 → 201 且 id 不可预测（apv_+随机）', ap.status === 201 && /^apv_[A-Za-z0-9_-]{20,}$/.test(apId), `${ap.status} ${apId}`);

    const wrongChapter = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch2, content: '<p>串章</p>', approval_id: apId } });
    ok('D2 审批绑定的章节不符 → 403', wrongChapter.status === 403, `实际 ${wrongChapter.status}`);
    ok('  └ 审批未被错误消费', (await approvalOf(work1, apId))?.status === 'active');

    const wrongWork = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch3, content: '<p>串书</p>', approval_id: apId } });
    ok('D3 审批绑定的作品不符（跨书）→ 403', wrongWork.status === 403, `实际 ${wrongWork.status}`);

    const snapD = await authorReq('/api/novel/state/snapshot', { method: 'POST', body: { work_id: work1, reason: 'D4 公证快照' } });
    const wrongOp = await agentReq('/api/novel/state/rollback', { method: 'POST', body: { snapshot_id: snapD.data.id, approval_id: apId, work_id: work1 } });
    ok('D4 审批操作类型不符（chapter_save 用于 rollback）→ 403', wrongOp.status === 403, `实际 ${wrongOp.status} ${JSON.stringify(wrongOp.data).slice(0, 120)}`);

    const good = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>模型经授权写入</p>', approval_id: apId } });
    ok('E1 模型侧带有效审批写入 → 200', good.status === 200, `实际 ${good.status} ${JSON.stringify(good.data).slice(0, 200)}`);
    ok('E2 正文确实更新 + 旧稿进历史版本', (await getChapter(ch1)).content.includes('模型经授权写入') && Number(good.data.version_id) > 0);

    const replay = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>重放写入</p>', approval_id: apId } });
    ok('E3 同一审批重放 → 403（单次消费）', replay.status === 403, `实际 ${replay.status}`);
    ok('  └ 原因码 consumed', String(replay.data.error || '').includes('consumed'), String(replay.data.error || ''));
    ok('E4 重放未覆盖正文', !(await getChapter(ch1)).content.includes('重放写入'));
    ok('E5 审批状态字 = consumed', (await approvalOf(work1, apId))?.status === 'consumed');

    // 并发双写：同一审批同时发两枪，只允许一枪成功
    const ap2 = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    const ap2Id = ap2.data.id;
    const [g1, g2] = await Promise.all([
      agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>并发甲</p>', approval_id: ap2Id } }),
      agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>并发乙</p>', approval_id: ap2Id } }),
    ]);
    const successes = [g1, g2].filter((g) => g.status === 200).length;
    ok('E6 同一审批并发双写只有一次成功', successes === 1, `成功 ${successes} 次（${g1.status}/${g2.status}）`);
    ok('E7 并发后审批已消费', (await approvalOf(work1, ap2Id))?.status === 'consumed');
  }

  // ── F. 基线变化 / 过期 / 撤销 ─────────────────────────────────────────────
  {
    const ap = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    const apId = ap.data.id;
    await authorReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>作者在审批后改了正文</p>' } });
    const r = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>陈旧审批写入</p>', approval_id: apId } });
    ok('F1 审批后正文基线变化 → 403', r.status === 403, `实际 ${r.status}`);
    ok('  └ 原因码 baseline_mismatch', String(r.data.error || '').includes('baseline_mismatch'), String(r.data.error || ''));
    ok('F2 陈旧审批未覆盖作者新正文', (await getChapter(ch1)).content.includes('作者在审批后改了正文'));

    const apExp = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1, ttl_ms: 60000 } });
    dbExec('UPDATE author_approvals SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', apExp.data.id);
    const rx = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>过期写入</p>', approval_id: apExp.data.id } });
    ok('F3 过期审批 → 403', rx.status === 403, `实际 ${rx.status}`);
    ok('  └ 状态字转为 expired', (await approvalOf(work1, apExp.data.id))?.status === 'expired');

    const apRev = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    const rev = await authorReq('/api/novel/approvals/revoke', { method: 'POST', body: { id: apRev.data.id } });
    ok('F4 作者撤销审批 → 200', rev.status === 200, `实际 ${rev.status}`);
    const rr = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>撤销后写入</p>', approval_id: apRev.data.id } });
    ok('F5 已撤销审批 → 403', rr.status === 403, `实际 ${rr.status}`);
    ok('  └ 正文未被覆盖', !(await getChapter(ch1)).content.includes('撤销后写入'));
  }

  // ── G. 消费与写入同一事务（中途失败整体回滚）─────────────────────────────
  {
    const ap = await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'chapter_save', chapter_id: ch1 } });
    const apId = ap.data.id;
    const before = (await getChapter(ch1)).content;
    dbExec("CREATE TRIGGER zz_approval_test_fail BEFORE UPDATE ON chapters WHEN NEW.title = 'ZZFAIL' BEGIN SELECT RAISE(ABORT, 'induced failure'); END");
    const r = await agentReq('/api/novel/chapter_save', {
      method: 'POST', body: { chapter_id: ch1, title: 'ZZFAIL', content: '<p>注定失败</p>', approval_id: apId },
    });
    ok('G1 写入中途失败 → 403（整体回滚）', r.status === 403 && String(r.data.error || '').includes('回滚'), `${r.status} ${String(r.data.error || '').slice(0, 120)}`);
    ok('G2 正文未变', (await getChapter(ch1)).content === before);
    ok('G3 审批未被消费（失败不吞授权）', (await approvalOf(work1, apId))?.status === 'active');
    dbExec('DROP TRIGGER zz_approval_test_fail');
    const retry = await agentReq('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>失败后重试成功</p>', approval_id: apId } });
    ok('G4 同一审批在失败后可重试成功 → 200', retry.status === 200, `实际 ${retry.status}`);
  }

  // ── H. 故事状态提案 / 旧提案 / 快照回滚 ───────────────────────────────────
  {
    const en = await authorReq('/api/novel/story_state', { method: 'PUT', body: { work_id: work1, enabled: true } });
    ok('H0 开启确定性故事状态', en.status === 200, `实际 ${en.status}`);

    const mk = async (subject) => {
      const r = await authorReq('/api/novel/state/proposals', {
        method: 'POST', body: { work_id: work1, chapter_id: ch1, kind: 'canon_fact', payload: { subject, predicate: '身份', value: '测试' } },
      });
      return r.data.id;
    };
    const p1 = await mk('甲'); const p2 = await mk('乙');

    const noAp = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: p1 } });
    ok('H1 模型侧 apply 无审批 → 403', noAp.status === 403, `实际 ${noAp.status}`);
    const batch = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, ids: [p1, p2] } });
    ok('H2 模型侧批量 apply → 403（一次一条）', batch.status === 403, `实际 ${batch.status}`);
    const all = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, all: true } });
    ok('H3 模型侧 all=true → 403', all.status === 403, `实际 ${all.status}`);

    const authorApply = await authorReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: p1 } });
    ok('H4 作者通道 apply 无需审批 → 200', authorApply.status === 200 && authorApply.data.applied === 1, `实际 ${authorApply.status} ${JSON.stringify(authorApply.data).slice(0, 160)}`);

    // H4 推进了状态：提案必须**重新创建**才是 fresh 基线（这正是 stale 语义要证明的事）
    const pB = await mk('戊'); const pC = await mk('己'); const pD = await mk('庚');
    const apId = (await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'state_proposal_apply', ids: [pB] } })).data.id;
    const outOfScope = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: pC, approval_id: apId } });
    ok('H5 审批未覆盖的提案 → 403', outOfScope.status === 403, `实际 ${outOfScope.status} ${JSON.stringify(outOfScope.data).slice(0, 140)}`);
    ok('  └ 越界写入被拦下（提案仍 pending）', (await authorReq(`/api/novel/state/proposals?work_id=${work1}`)).data.proposals.find((p) => p.id === pC)?.state === 'pending');
    const okApply = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: pB, approval_id: apId } });
    ok('H6 审批覆盖的提案 apply → 200', okApply.status === 200 && okApply.data.applied === 1, `实际 ${okApply.status} ${JSON.stringify(okApply.data).slice(0, 160)}`);
    const replayApply = await agentReq('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: pD, approval_id: apId } });
    ok('H7 已消费审批再 apply 其它提案 → 403', replayApply.status === 403, `实际 ${replayApply.status} ${JSON.stringify(replayApply.data).slice(0, 120)}`);

    // 旧提案（story_event_proposals）apply
    const evp = await authorReq('/api/novel/events', { method: 'POST', body: { work_id: work1, summary: '旧提案·测试事件', proposed: true } });
    const evId = evp.data.proposal_id;
    const legacyNoAp = await agentReq('/api/novel/proposals/apply', { method: 'POST', body: { work_id: work1, id: evId } });
    ok('H8 模型侧旧提案 apply 无审批 → 403', legacyNoAp.status === 403, `实际 ${legacyNoAp.status}`);
    const legacyAll = await agentReq('/api/novel/proposals/apply', { method: 'POST', body: { work_id: work1, all: true } });
    ok('H9 模型侧旧提案 all=true → 403', legacyAll.status === 403, `实际 ${legacyAll.status}`);
    const apLegacy = (await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'proposal_apply', ids: [evId] } })).data.id;
    const legacyOk = await agentReq('/api/novel/proposals/apply', { method: 'POST', body: { work_id: work1, id: evId, approval_id: apLegacy } });
    ok('H10 旧提案带审批 apply → 200', legacyOk.status === 200, `实际 ${legacyOk.status} ${JSON.stringify(legacyOk.data).slice(0, 160)}`);

    // 快照 / 回滚
    const snap1 = await authorReq('/api/novel/state/snapshot', { method: 'POST', body: { work_id: work1, reason: '测试快照A' } });
    const snap2 = await authorReq('/api/novel/state/snapshot', { method: 'POST', body: { work_id: work1, reason: '测试快照B' } });
    const noApRollback = await agentReq('/api/novel/state/rollback', { method: 'POST', body: { work_id: work1, snapshot_id: snap1.data.id } });
    ok('H11 模型侧 rollback 无审批 → 403', noApRollback.status === 403, `实际 ${noApRollback.status}`);
    const apRoll = (await authorReq('/api/novel/approvals', { method: 'POST', body: { work_id: work1, op: 'state_rollback', snapshot_id: snap1.data.id } })).data.id;
    const wrongSnap = await agentReq('/api/novel/state/rollback', { method: 'POST', body: { work_id: work1, snapshot_id: snap2.data.id, approval_id: apRoll } });
    ok('H12 审批绑定的快照不符 → 403', wrongSnap.status === 403, `实际 ${wrongSnap.status}`);
    const okRoll = await agentReq('/api/novel/state/rollback', { method: 'POST', body: { work_id: work1, snapshot_id: snap1.data.id, approval_id: apRoll } });
    ok('H13 快照回滚带审批 → 200', okRoll.status === 200, `实际 ${okRoll.status} ${JSON.stringify(okRoll.data).slice(0, 160)}`);
  }
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\n审批边界：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
