#!/usr/bin/env node
/**
 * e2e-adopt-realdata-20261006.mjs —— 在**作者真实作品库的副本**上重放那次报错的采纳（零计费）。
 *
 * 为什么要有这个脚本：单元/隔离测试只能证明"逻辑对"，回答不了作者的问题——
 * 「我点的那次覆盖，现在到底能不能把内容写进正文」。
 * 所以这里直接拿活库 data/novel.db 做一份**一致性快照**（`VACUUM INTO`，只读打开活库），
 * 在副本上起一个隔离实例，按界面真实的入参重放一次，然后逐项核对结果。
 *
 * ⚠️ 活库只被只读打开一次；所有写入都发生在临时副本里，跑完即删。
 *
 * 用法: node .p1-baseline/e2e-adopt-realdata-20261006.mjs
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
const LIVE_DB = join(REPO, 'data', 'novel.db');
const WORK_ID = 18;   // 《无敌系统：我只想安静读完高中》（事故现场那本书）

let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-e2e-'));
const snapshotPath = join(DATA_DIR, 'novel.db');

// ── 1) 一致性快照（只读打开活库，写入发生在副本）─────────────────────────────
{
  const live = new DatabaseSync(LIVE_DB, { readOnly: true });
  try {
    live.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } finally { live.close(); }
  console.log(`活库快照：${LIVE_DB} → ${snapshotPath}`);
}

async function pickFreePort() {
  return new Promise((res, rej) => {
    const p = net.createServer();
    p.once('error', rej);
    p.listen(0, '127.0.0.1', () => { const port = p.address().port; p.close(() => res(port)); });
  });
}
const PORT = await pickFreePort();
const BASE = `http://127.0.0.1:${PORT}`;

let server = null; let serverLog = '';
async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'e2e-adopt-guard' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => { serverLog += c; });
  server.stderr.on('data', (c) => { serverLog += c; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/novel/ping'); if (r.status === 200) return true; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function stopServer() {
  if (!server) return;
  const proc = server; server = null;
  await new Promise((res) => { proc.once('exit', res); try { proc.kill(); } catch { res(); } setTimeout(res, 4000); });
}

async function jfetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const dbGet = (sql, ...p) => { const d = new DatabaseSync(snapshotPath); try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...p); } finally { d.close(); } };

console.log(`\n真实数据端到端（作品 #${WORK_ID}，隔离端口 ${PORT}）`);
let ready = false;
try {
  ready = await startServer();
  if (!ready) { console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000)); }
  else {
    // ── 2) 现场对齐：这次采纳的入参 = 界面真实的勾选集合 ─────────────────────
    const proposals = (await jfetch(`/api/novel/proposals?work_id=${WORK_ID}`)).data.proposals || [];
    const events = proposals.filter((p) => p.type === 'event');
    const memories = proposals.filter((p) => p.type === 'memory');
    console.log(`  待处理提案：事件 ${events.length} 条、长期记忆 ${memories.length} 条`);
    ok('E2E-1 现场复现：pending 里同时存在事件提案与长期记忆提案（两表 id 同号）',
      events.length > 0 && memories.length > 0,
      JSON.stringify({ events: events.length, memories: memories.length }));

    const refs = [...events.map((p) => `event:${p.id}`), ...memories.map((p) => `memory:${p.id}`)];
    const ids = [...new Set([...events, ...memories].map((p) => Number(p.id)))];
    const guarded = memories.find((m) => m.guard === 'agent' && String(m.summary || '').trim());
    ok('E2E-2 现场复现：其中一条长期记忆带模型自压缩标记（会被零损失护栏核对）', !!guarded,
      JSON.stringify(memories.map((m) => ({ id: m.id, guard: m.guard, len: String(m.summary || '').length }))));

    // 挑一章有正文的章（取正文最多的那一章，最接近真实写作现场）
    const chRow = dbGet(`SELECT id, length(content) AS n FROM chapters WHERE work_id = ? ORDER BY length(content) DESC, id ASC LIMIT 1`, WORK_ID);
    const chapterId = Number(chRow.id);
    const before = (await jfetch(`/api/chapters/${chapterId}`)).data;
    const versionsBefore = ((await jfetch(`/api/chapter_versions?chapter_id=${chapterId}`)).data || []).length;
    const memoryBefore = String((dbGet('SELECT summary FROM story_memories WHERE work_id = ?', WORK_ID) || {}).summary || '');
    console.log(`  目标章节：#${chapterId}（正文 ${String(before.content || '').length} 字符），历史版本 ${versionsBefore} 条`);

    // ── 3) 重放：界面现在真的会发的那一次采纳 ────────────────────────────────
    const MARK = '【E2E 护栏不挡正文验证 2026-10-06】';
    const opKey = `e2e-guard-${Date.now().toString(36)}`;
    const r = await jfetch('/api/novel/adopt', {
      method: 'POST',
      body: {
        work_id: WORK_ID, chapter_id: chapterId,
        content: `<p>${MARK}</p>${String(before.content || '')}`,
        legacy_proposal_ids: ids,
        legacy_proposal_refs: refs,
        operation_key: opKey,
        adopt_kind: 'e2e_verify',
      },
    });
    const legacy = (r.data && r.data.adopt && r.data.adopt.legacy) || {};
    const gf = Array.isArray(legacy.guard_failed) ? legacy.guard_failed : [];

    ok('E2E-3 采纳返回 200（不再 409「采纳失败（已整体回滚，未写入任何内容）」）',
      r.status === 200 && r.data.ok === true, `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    const after = (await jfetch(`/api/chapters/${chapterId}`)).data;
    ok('E2E-4 ★ 正文确实被改动，作者这次执行的内容完整写在正文里',
      String(after.content || '').includes(MARK), `正文长度 ${String(before.content || '').length} → ${String(after.content || '').length}`);
    // ⚠️ 不用 `/api/chapter_versions` 的条数当判据：它有 `LIMIT 10`（只给界面最近 10 条），
    // 而 #119 这种反复修稿过的章早就有 10 条 —— 加了新版本条数照样是 10，会假红。
    // 真正要证明的是"覆盖前那一版被留下来了"，所以核对最新一条历史版本的内容。
    const newestVersion = dbGet(`SELECT content, created_at FROM chapter_save_versions
      WHERE chapter_id = ? AND kind = 'manual' ORDER BY created_at DESC, id DESC LIMIT 1`, chapterId);
    ok('E2E-5 旧稿进了历史版本（最新一条历史版本 = 覆盖前那一版，逐字一致）',
      !!newestVersion && String(newestVersion.content || '') === String(before.content || ''),
      JSON.stringify({ newestLen: String(newestVersion && newestVersion.content || '').length, beforeLen: String(before.content || '').length }));
    ok('E2E-6 被护栏拦下的那条记忆提案如实回报（含提案号与缺失实体）',
      !!guarded && gf.length === 1 && Number(gf[0].proposal_id) === Number(guarded.id) && (gf[0].reasons || []).length > 0,
      JSON.stringify(gf).slice(0, 300));
    ok('E2E-7 被拦的记忆提案仍 pending（保留待处理，没有被静默丢掉）',
      !!dbGet(`SELECT id FROM story_memory_proposals WHERE id = ? AND work_id = ? AND status = 'pending'`, Number(guarded.id), WORK_ID));
    ok('E2E-8 13 条事件提案全部入账（作者勾选的那部分真的落地了）', events.length > 0
      && !dbGet(`SELECT id FROM story_event_proposals WHERE work_id = ? AND status = 'pending' AND id <= ?`, WORK_ID, Number(events[events.length - 1].id)));
    ok('E2E-9 长期记忆没有被护栏判不合格的那一版污染（零损失护栏的初衷没被削弱）',
      String((dbGet('SELECT summary FROM story_memories WHERE work_id = ?', WORK_ID) || {}).summary || '') !== String(guarded.summary || ''));
    ok('E2E-10 采纳记录落库（事务是提交，不是回滚）', !!dbGet('SELECT idempotency_key FROM adoption_operations WHERE idempotency_key = ?', opKey));
    ok('E2E-11 不再出现「达标 x/y」这类自相矛盾的计数文案',
      !/达标/.test(JSON.stringify(r.data)) && !/未全部入账/.test(JSON.stringify(r.data)));
  }
} catch (e) {
  fails.push('端到端执行异常');
  console.error('✗ 端到端执行异常：', e && e.stack ? e.stack : e);
} finally {
  await stopServer();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\n真实数据端到端：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
console.log('（活库 data/novel.db 全程只读，未写入；所有写入都发生在临时副本里）');
process.exitCode = fails.length ? 1 : 0;
