#!/usr/bin/env node
/**
 * test-adopt-atomic.mjs —— R03「正文 + 选中提案 = 一次原子采纳」HTTP 级隔离测试（零计费）。
 *
 * 覆盖矩阵：
 *   A. 正文与提案同事务落库；旧稿进历史版本；提案状态流转；投影 outbox 与提交同事务
 *   B. 幂等：同 key + 同 payload → 原样重放（不重复写）；同 key + 不同 payload → 409
 *   C. 完整性：选中项里有一条取不到 / 状态已变（陈旧、已处理）→ 整次回滚
 *   D. 基线绑定：正文 hash / 提案版本 hash 不符 → 409（不覆盖新内容）
 *   E. 模型侧（X-Novel-Agent）不得调用整次采纳 → 403
 *   G. 提案 id 跨两表同号（2026-10-06）：带类型引用精确命中，裸 id 只解析成唯一一行
 *   H. 零损失护栏不得挡住正文（2026-10-06）：被拦的记忆提案保留 pending + 如实回包，正文照写
 *   F. 投影可见 + restart 恢复：提交后进程重启，只凭 outbox 记录续跑（attempts 递增）
 *
 * 隔离配方：NOVELSTUDIO_DATA_DIR=<tmp> / PORT=<random> / NOVELSTUDIO_OV_DISABLED=1。
 * 用法: node .p1-baseline/test-adopt-atomic.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-adopt-'));
const AGENT = { 'x-novel-agent': '1' };
/** 端口不再猜：让操作系统分配空闲端口。固定区间（5800+pid%300）在多次运行/CI 上会撞上占用或 TIME_WAIT，
 *  症状是「隔离实例未就绪」这种与被测代码无关的假红（2026-09-27 实测一次）。 */
async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}
let PORT = await pickFreePort();
let BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

async function jfetch(path, { method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
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
const req = (path, opts = {}) => jfetch(path, opts);
const agentReq = (path, opts = {}) => jfetch(path, { ...opts, headers: { ...AGENT, ...(opts.headers || {}) } });
const getChapter = async (id) => (await req(`/api/chapters/${id}`)).data;
const getProposal = async (workId, id) => (await req(`/api/novel/proposals?work_id=${workId}`)).data.proposals.find((p) => p.id === id) || null;
const versionsOf = async (chapterId) => (await req(`/api/chapter_versions?chapter_id=${chapterId}`)).data;
const projectionsOf = async (workId) => (await req(`/api/novel/projections?work_id=${workId}`)).data;

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

let server = null;
let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR,
      NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'enh-adopt-test',
      // 见 test-approval-boundary.mjs 的同名说明：固定 X-Novel-Agent 头默认不再构成模型身份。
      NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { serverLog += c; });
  server.stderr.on('data', (c) => { serverLog += c; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await jfetch('/api/novel/ping', { timeout: 2000 }); if (r.status === 200) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function stopServer() {
  if (!server) return;
  const proc = server;
  server = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    try { proc.kill(); } catch { resolve(); }
    setTimeout(resolve, 4000);
  });
}

console.log(`整次采纳隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
let ready = await startServer();
if (!ready) {
  console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000));
  await stopServer();
  process.exit(2);
}

try {
  // ── 准备 ────────────────────────────────────────────────────────────────
  const w1 = await req('/api/works', { method: 'POST', body: { title: '采纳测试·甲书' } });
  const w2 = await req('/api/works', { method: 'POST', body: { title: '采纳测试·乙书' } });
  const work1 = w1.data.id; const work2 = w2.data.id;
  await req('/api/novel/story_state', { method: 'PUT', body: { work_id: work1, enabled: true } });
  const c1 = await req('/api/chapters', { method: 'POST', body: { work_id: work1, title: '第一章' } });
  const c2 = await req('/api/chapters', { method: 'POST', body: { work_id: work2, title: '乙书章' } });
  const ch1 = c1.data.id; const ch2 = c2.data.id;
  await req('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch1, content: '<p>原始正文甲</p>' } });
  ok('准备：两本书 / 章节 / 基线正文 / 故事状态开启', !!(work1 && work2 && ch1 && ch2));

  // ── A. 正文 + 旧提案原子采纳 ────────────────────────────────────────────
  let evId = 0;
  const opA = `adopt-A-${Date.now().toString(36)}`;
  {
    const evp = await req('/api/novel/events', { method: 'POST', body: { work_id: work1, chapter_id: ch1, summary: '事件·原子采纳', proposed: true } });
    evId = evp.data.proposal_id;
    const beforeVersions = (await versionsOf(ch1)).length || 0;
    const r = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work1, chapter_id: ch1, content: '<p>采纳后的正文甲</p>',
        legacy_proposal_ids: [evId], operation_key: opA, adopt_kind: 'ai_result',
      },
    });
    ok('A1 正文 + 旧提案整次采纳 → 200', r.status === 200 && r.data.ok === true, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    ok('A2 正文已写回', (await getChapter(ch1)).content.includes('采纳后的正文甲'));
    ok('A3 旧稿进历史版本（版本数 +1）', ((await versionsOf(ch1)).length || 0) === beforeVersions + 1);
    ok('A4 提案已入账（不再 pending）', (await getProposal(work1, evId)) === null);
    ok('A5 事件账本已有该事件', ((await req(`/api/novel/events?work_id=${work1}`)).data.events || []).some((e) => e.summary === '事件·原子采纳'));
    ok('A6 采纳记录落库（幂等账本）', !!dbGet('SELECT idempotency_key FROM adoption_operations WHERE idempotency_key = ?', opA));
    const proj = await projectionsOf(work1);
    ok('A7 投影 outbox 与提交同事务落库', (proj.projections || []).some((p) => String(p.payload.operation_key) === opA));
    ok('A8 投影状态可见（done 或 failed + 原因，绝不显示"假成功"）',
      (proj.projections || []).every((p) => ['done', 'failed', 'pending', 'running'].includes(p.status)
        && (p.status !== 'failed' || String(p.last_error || '').length > 0)),
      JSON.stringify(proj.summary));
  }

  // ── B. 幂等 ─────────────────────────────────────────────────────────────
  {
    const versionsBefore = (await versionsOf(ch1)).length || 0;
    const replay = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work1, chapter_id: ch1, content: '<p>采纳后的正文甲</p>',
        legacy_proposal_ids: [evId], operation_key: opA, adopt_kind: 'ai_result',
      },
    });
    ok('B1 同 key + 同 payload 重放 → 200 replayed', replay.status === 200 && replay.data.replayed === true, `${replay.status} ${JSON.stringify(replay.data).slice(0, 160)}`);
    ok('B2 重放未重复写版本', ((await versionsOf(ch1)).length || 0) === versionsBefore);
    ok('B3 重放未重复投影', (await projectionsOf(work1)).projections.filter((p) => String(p.payload.operation_key) === opA).length === 1);
    const conflict = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>换了内容的同 key</p>', legacy_proposal_ids: [evId], operation_key: opA },
    });
    ok('B4 同 key + 不同 payload → 409 冲突', conflict.status === 409, `实际 ${conflict.status}`);
    ok('B5 冲突未覆盖正文', (await getChapter(ch1)).content.includes('采纳后的正文甲'));
  }

  // ── C. 完整性（真正的"全有或全无"只剩这一类）────────────────────────────
  {
    // 已处理过的提案（A 已入账）混在选中集合里 → 预检 409
    const ev2 = await req('/api/novel/events', { method: 'POST', body: { work_id: work1, summary: '事件·待用', proposed: true } });
    const opC = `adopt-C-${Date.now().toString(36)}`;
    const mixed = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>不该写进去</p>', legacy_proposal_ids: [ev2.data.proposal_id, evId], operation_key: opC },
    });
    ok('C1 选中集合含已处理提案 → 409', mixed.status === 409, `实际 ${mixed.status}`);
    ok('C2 无任何写入（正文未变）', !(await getChapter(ch1)).content.includes('不该写进去'));
    ok('C3 无采纳记录（回滚彻底）', !dbGet('SELECT idempotency_key FROM adoption_operations WHERE idempotency_key = ?', opC));
    ok('C4 有效提案仍 pending（可重新选择）', !!(await getProposal(work1, ev2.data.proposal_id)));

    // 陈旧状态提案（创建后状态被其它应用推进）→ 事务内失败 → 整次回滚
    const pStale = await req('/api/novel/state/proposals', { method: 'POST', body: { work_id: work1, chapter_id: ch1, kind: 'canon_fact', payload: { subject: '陈旧', predicate: '状态', value: '旧' } } });
    const pFresh = await req('/api/novel/state/proposals', { method: 'POST', body: { work_id: work1, chapter_id: ch1, kind: 'canon_fact', payload: { subject: '推进', predicate: '状态', value: '新' } } });
    await req('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: work1, id: pFresh.data.id } });
    const opC2 = `adopt-C2-${Date.now().toString(36)}`;
    const r2 = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>陈旧路径不该写</p>', state_proposal_ids: [pStale.data.id], operation_key: opC2 },
    });
    ok('C5 陈旧状态提案 → 409（整次回滚）', r2.status === 409, `${r2.status} ${JSON.stringify(r2.data).slice(0, 160)}`);
    ok('C6 陈旧路径正文未写', !(await getChapter(ch1)).content.includes('陈旧路径不该写'));
    ok('C7 陈旧提案状态保留（未误标）', ['pending', 'stale'].includes((await req(`/api/novel/state/proposals?work_id=${work1}`)).data.proposals.find((p) => p.id === pStale.data.id)?.state));
    ok('C8 无采纳记录', !dbGet('SELECT idempotency_key FROM adoption_operations WHERE idempotency_key = ?', opC2));
  }

  // ── D. 基线 / 版本绑定 ──────────────────────────────────────────────────
  {
    const cur = await getChapter(ch1);
    const opD = `adopt-D-${Date.now().toString(36)}`;
    const wrongBase = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>基线不符</p>', operation_key: opD, expected: { content_hash: 'deadbeefdeadbeef' } },
    });
    ok('D1 正文基线 hash 不符 → 409', wrongBase.status === 409, `实际 ${wrongBase.status}`);
    ok('D2 未覆盖正文', (await getChapter(ch1)).content === cur.content);

    const ev3 = await req('/api/novel/events', { method: 'POST', body: { work_id: work1, summary: '事件·版本绑定', proposed: true } });
    const opD2 = `adopt-D2-${Date.now().toString(36)}`;
    const wrongHash = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work1, chapter_id: ch1, content: '<p>版本不符</p>', legacy_proposal_ids: [ev3.data.proposal_id],
        operation_key: opD2, expected: { legacy_hashes: { [String(ev3.data.proposal_id)]: 'deadbeefdeadbeef' } },
      },
    });
    ok('D3 提案版本 hash 不符 → 409', wrongHash.status === 409, `实际 ${wrongHash.status}`);
    ok('D4 提案仍 pending', !!(await getProposal(work1, ev3.data.proposal_id)));

    const wrongWork = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work2, chapter_id: ch1, content: '<p>跨书</p>', operation_key: `adopt-D3-${Date.now().toString(36)}` },
    });
    ok('D5 章节不属于该作品 → 400', wrongWork.status === 400, `实际 ${wrongWork.status}`);
  }

  // ── E. 模型侧不得整次采纳 ───────────────────────────────────────────────
  {
    const r = await agentReq('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>模型整次采纳</p>', operation_key: `adopt-E-${Date.now().toString(36)}` },
    });
    ok('E1 模型侧 adopt → 403（作者界面动作）', r.status === 403, `实际 ${r.status}`);
    ok('E2 正文未被写入', !(await getChapter(ch1)).content.includes('模型整次采纳'));
    const noKey = await req('/api/novel/adopt', { method: 'POST', body: { work_id: work1, chapter_id: ch1, content: '<p>x</p>' } });
    ok('E3 缺 operation_key → 400', noKey.status === 400, `实际 ${noKey.status}`);
  }

  // ── G. 提案 id 在两表之间同号（2026-10-06 事故的根因）──────────────────
  // 事件提案与长期记忆提案是**两张表、各自独立的 id 序列**，都从 1 开始。旧实现拿裸 id
  // 去两张表各查一遍，于是作者勾的 13 条事件提案把同号的 2 条记忆提案一起卷进采纳，
  // 计数变成"达标 14/13"自相矛盾的值 → 整次回滚 → 正文一个字都没写进去。
  {
    const mkPair = async (tag) => {
      const ev = await req('/api/novel/events', { method: 'POST', body: { work_id: work1, summary: `事件·同号 ${tag}`, proposed: true } });
      const id = Number(ev.data.proposal_id);
      dbExec('DELETE FROM story_memory_proposals WHERE id = ?', id);
      dbExec(`INSERT INTO story_memory_proposals (id, work_id, summary, delta, note, guard, status) VALUES (?, ?, ?, '', '', '', 'pending')`, id, work1, `记忆·同号 ${tag}`);
      return id;
    };
    const idA = await mkPair('A');
    const opG1 = `adopt-G1-${Date.now().toString(36)}`;
    const g1 = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>G1 裸 id</p>', legacy_proposal_ids: [idA], operation_key: opG1 },
    });
    const lg1 = (g1.data && g1.data.adopt && g1.data.adopt.legacy) || {};
    ok('G1 裸 id 只解析成一行（事件优先）：事件 +1、记忆 +0',
      g1.status === 200 && Number(lg1.events) === 1 && Number(lg1.memories) === 0,
      `${g1.status} ${JSON.stringify(lg1)}`);
    ok('G2 同号记忆提案仍 pending（作者没勾它就不许被卷进来）',
      !!dbGet(`SELECT id FROM story_memory_proposals WHERE id = ? AND status = 'pending'`, idA));

    const opG2 = `adopt-G2-${Date.now().toString(36)}`;
    const g2 = await req('/api/novel/adopt', {
      method: 'POST',
      body: { work_id: work1, chapter_id: ch1, content: '<p>G2 指定记忆</p>', legacy_proposal_refs: [`memory:${idA}`], operation_key: opG2 },
    });
    const lg2 = (g2.data && g2.data.adopt && g2.data.adopt.legacy) || {};
    ok('G3 带类型引用「记忆」只动记忆（事件 +0、记忆 +1）',
      g2.status === 200 && Number(lg2.events) === 0 && Number(lg2.memories) === 1,
      `${g2.status} ${JSON.stringify(lg2)}`);
    ok('G4 该号记忆提案已入账（不再 pending）',
      !dbGet(`SELECT id FROM story_memory_proposals WHERE id = ? AND status = 'pending'`, idA));

    const idB = await mkPair('B');
    const opG3 = `adopt-G3-${Date.now().toString(36)}`;
    const g3 = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work1, chapter_id: ch1, content: '<p>G3 refs 优先</p>',
        legacy_proposal_ids: [idB], legacy_proposal_refs: [`memory:${idB}`], operation_key: opG3,
      },
    });
    const lg3 = (g3.data && g3.data.adopt && g3.data.adopt.legacy) || {};
    ok('G5 refs 与裸 ids 同时给出 → 以 refs 为准（不求并集、不多勾一条）',
      g3.status === 200 && Number(lg3.events) === 0 && Number(lg3.memories) === 1,
      `${g3.status} ${JSON.stringify(lg3)}`);
    ok('G6 该号事件提案仍 pending（未被裸 ids 多带走一条）',
      !!dbGet(`SELECT id FROM story_event_proposals WHERE id = ? AND status = 'pending'`, idB));

    const idC = await mkPair('C');
    const opG4 = `adopt-G4-${Date.now().toString(36)}`;
    const g4 = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work1, chapter_id: ch1, content: '<p>G4 去重</p>',
        legacy_proposal_refs: [`event:${idC}`, `event:${idC}`, `memory:${idC}`], operation_key: opG4,
      },
    });
    const lg4 = (g4.data && g4.data.adopt && g4.data.adopt.legacy) || {};
    ok('G7 重复引用去重：事件 +1、记忆 +1（计数不因重复失真）',
      g4.status === 200 && Number(lg4.events) === 1 && Number(lg4.memories) === 1,
      `${g4.status} ${JSON.stringify(lg4)}`);
  }

  // ── H. 零损失护栏不得挡住正文（2026-10-06 作者要求）─────────────────────
  // 判据：正文写入与"提案入账"解耦。被护栏拦下的记忆提案留在 pending、原因如实回包，
  // 但**不许**再让整次采纳回滚 —— 作者点的那一次写入必须留在正文里。
  let work3 = 0; let ch3 = 0; let memProposalId = 0;
  {
    const w3 = await req('/api/works', { method: 'POST', body: { title: '采纳测试·护栏书' } });
    work3 = w3.data.id;
    const c3 = await req('/api/chapters', { method: 'POST', body: { work_id: work3, title: '护栏章' } });
    ch3 = c3.data.id;
    await req('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: ch3, content: '<p>林晚走进拾线坊，把线轴放在柜台上。</p>' } });
    dbExec(`INSERT INTO characters (work_id, name) VALUES (?, ?)`, work3, '林晚');
    dbExec(`INSERT INTO world_entries (work_id, title) VALUES (?, ?)`, work3, '拾线坊');
    // guard='agent' = 模型自压缩来源标记 → 采纳时会过零损失护栏；摘要短到必然丢实体。
    dbExec(`INSERT INTO story_memory_proposals (work_id, summary, delta, note, guard, status) VALUES (?, ?, '', '模型自压缩', 'agent', 'pending')`, work3, '他们见面了。');
    memProposalId = Number(dbGet(`SELECT id FROM story_memory_proposals WHERE work_id = ? ORDER BY id DESC LIMIT 1`, work3).id);
    const memBefore = String((dbGet('SELECT summary FROM story_memories WHERE work_id = ?', work3) || {}).summary || '');
    const versionsBefore = (await versionsOf(ch3)).length || 0;
    const opH = `adopt-H-${Date.now().toString(36)}`;
    const h = await req('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: work3, chapter_id: ch3, content: '<p>改好之后的护栏章正文</p>',
        legacy_proposal_refs: [`memory:${memProposalId}`], operation_key: opH,
      },
    });
    const lh = (h.data && h.data.adopt && h.data.adopt.legacy) || {};
    const gf = Array.isArray(lh.guard_failed) ? lh.guard_failed : [];
    ok('H1 记忆提案被零损失护栏拦下时，整次采纳仍 200（不再 409 回滚）',
      h.status === 200 && h.data && h.data.ok === true, `${h.status} ${JSON.stringify(h.data).slice(0, 200)}`);
    ok('H2 正文已写回（作者执行的内容完整出现在正文里）',
      (await getChapter(ch3)).content.includes('改好之后的护栏章正文'));
    ok('H3 旧稿进历史版本（版本数 +1）', ((await versionsOf(ch3)).length || 0) === versionsBefore + 1);
    ok('H4 被拦原因如实回包（含提案号与原因，不谎报成功）',
      gf.length === 1 && Number(gf[0].proposal_id) === memProposalId && (gf[0].reasons || []).length > 0,
      JSON.stringify(gf).slice(0, 240));
    ok('H5 被拦的记忆提案仍 pending（保留待处理，可修正后再采纳）',
      !!dbGet(`SELECT id FROM story_memory_proposals WHERE id = ? AND status = 'pending'`, memProposalId));
    ok('H6 长期记忆未被改写（护栏的初衷没有被削弱）',
      String((dbGet('SELECT summary FROM story_memories WHERE work_id = ?', work3) || {}).summary || '') === memBefore);
    ok('H7 采纳记录已落库（事务是提交，不是回滚）',
      !!dbGet('SELECT idempotency_key FROM adoption_operations WHERE idempotency_key = ?', opH));
    ok('H8 不再出现"达标 x/y"这类自相矛盾的计数文案', !/达标/.test(String((h.data && h.data.message) || '')));
  }

  // ── F. 重启恢复（只凭 outbox 续跑）──────────────────────────────────────
  {
    const row = dbGet(`SELECT * FROM projection_outbox WHERE payload_json LIKE '%adopt-A-%' ORDER BY id DESC LIMIT 1`);
    ok('F1 找到 A 的投影记录', !!row, '记录不存在');
    if (row) {
      dbExec(`UPDATE projection_outbox SET status = 'pending', last_error = '', updated_at = ? WHERE id = ?`, new Date().toISOString(), row.id);
      const before = Number(dbGet('SELECT attempts FROM projection_outbox WHERE id = ?', row.id).attempts) || 0;
      await stopServer();
      PORT = await pickFreePort(); BASE = `http://127.0.0.1:${PORT}`;
      ready = await startServer();
      ok('F2 重启后实例就绪', ready);
      if (ready) {
        const deadline = Date.now() + 15000;
        let after = dbGet('SELECT status, attempts, last_error FROM projection_outbox WHERE id = ?', row.id);
        while (Date.now() < deadline && after && after.status === 'pending') {
          await new Promise((r) => setTimeout(r, 400));
          after = dbGet('SELECT status, attempts, last_error FROM projection_outbox WHERE id = ?', row.id);
        }
        ok('F3 重启后仅凭持久化记录续跑（attempts 递增）', after && Number(after.attempts) > before, JSON.stringify(after));
        ok('F4 结束状态非 pending（done 或 failed 均可，绝不静默丢失）', after && after.status !== 'pending', JSON.stringify(after));
        const retry = await req('/api/novel/projections/retry', { method: 'POST', body: { work_id: work1 } });
        ok('F5 投影 retry 入口可用', retry.status === 200 && typeof retry.data.reset === 'number', JSON.stringify(retry.data).slice(0, 160));
        ok('F6 状态查询可见 summary', typeof (await projectionsOf(work1)).summary === 'object');
      }
    }
  }
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  await stopServer();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\n整次采纳：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
