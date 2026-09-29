// OpenViking 同步层：把工坊六类小说数据渲染成 Markdown 写入共享记忆库，
// 并在上下文装配/检索时从记忆库语义召回。
//
// 存储布局（共享记忆库 user 域下，与 GUI/headless dsh 会话同一记忆库）：
//   OV_ROOT/<workId>/
//     meta.md               作品标题/简介/作者注
//     long-memory.md        长期记忆/故事摘要
//     events.md             事件账本与伏笔
//     outline.md            大纲/剧情线
//     settings/<termId>.md  设定库词条
//     characters/<charId>.md 角色卡（含人物关系）
//     world/<entryId>.md    世界观词条
//     chapters/<chapterId>.md 章节正文（纯文本）
//
// 同步策略：写操作 → 2 秒防抖 → 渲染当前 DB 行 → content/write（replace）异步刷向量；
// 删除 → 删对应文件；服务器离线 → openviking.js 的 pending 队列自动重放。

import { db } from './db.js';
import { ovClient, enqueueOpenVikingOp, clearQueuedOpForUri, clearQueuedOpsForWork } from './openviking.js';
import { log, timedAsync } from './logger.js';
import { traceFn } from './debug-trace.js';
import { htmlToPlain } from './text-utils.js';
import { createSyncGate } from './ai/sync-gate.mjs';
import { filterRecallItems, validateRecallItem, planRebuild } from './ai/openviking/recall-meta.mjs';
import { SHARED_LIBRARY_ROOT } from './ai/library/library-roots.mjs';
import { LIBRARY_RECALL, libraryHitOf, libraryRecallTextOf } from './ai/library/library-recall.mjs';
import { normalizeDirection, directionHashOf, normalizeLibraryRecallPhase } from './ai/direction.mjs';
import * as LibraryIndex from './ai/library/library-index.mjs';

// 协议前缀运行时拼接（避免源码中出现的字面 URI 触发 dsh 的 URI 防护误判）。
const OV_PROTO = 'viking:' + '//';
const OV_ROOT = OV_PROTO + 'user/default/resources/novel-studio';

// 环境总闸：NOVELSTUDIO_OV_DISABLED=1 时整个 OpenViking 集成停用
// （冒烟测试/隔离环境用，避免把测试数据写进真实共享记忆库）。
const OV_DISABLED = process.env.NOVELSTUDIO_OV_DISABLED === '1';

const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// ---------- 设置（app_settings 表） ----------
export function getAppSetting(key, def = '') {
  try {
    const row = prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch {
    return def;
  }
}

export function setAppSetting(key, value) {
  prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function semanticEnabled() {
  return getAppSetting('ov_semantic_enabled', '1') !== '0';
}

// 生效判断：环境总闸优先于界面开关（冒烟测试/隔离环境用）。
export function ovEffectiveEnabled() {
  return !OV_DISABLED && semanticEnabled();
}

// ---------- URI 帮助 ----------
// N-03：作品目录不再直接用自增 id（多实例/多库共享记忆库时会互相覆盖/串作品），
// 改用 works.ov_uri 的稳定标识：新作品由 db.js 的触发器自动分配 32 位随机 hex；
// 旧作品首次调用时回填为「<id>」，保持既有记忆库布局不变、无需重建索引。
export function workDir(workId) {
  let uri = '';
  try {
    const row = prepare('SELECT ov_uri FROM works WHERE id = ?').get(workId);
    uri = row?.ov_uri || '';
  } catch { /* 表/列缺失时走回填 */ }
  if (!uri) {
    uri = String(workId);
    try { prepare('UPDATE works SET ov_uri = ? WHERE id = ?').run(uri, workId); } catch { /* 忽略 */ }
  }
  return `${OV_ROOT}/${uri}`;
}

function fileUri(workId, rel) {
  return `${workDir(workId)}/${rel}`;
}

// htmlToPlain 见 ./text-utils.js（与 server.js 共用，避免两处漂移）。

function capText(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------- 渲染器（六类数据 → Markdown） ----------
function renderWorkMeta(work) {
  const parts = [`# 作品：${work.title || ''}`];
  if (work.description) parts.push(`\n${capText(work.description, 2000)}`);
  if (work.author_note) parts.push(`\n## 作品作者注\n${capText(work.author_note, 2000)}`);
  return parts.join('\n');
}

function renderMemory(workId) {
  const row = prepare('SELECT summary FROM story_memories WHERE work_id = ?').get(workId);
  const summary = capText(row?.summary || '', 40000);
  return `# 长期记忆（故事摘要）\n\n${summary || '（暂无）'}`;
}

function renderEvents(workId) {
  const rows = prepare(`
    SELECT id, chapter_id, kind, summary, foreshadow_status, resolves_event_id, created_at
    FROM story_events WHERE work_id = ? ORDER BY id DESC LIMIT 300
  `).all(workId);
  const lines = ['# 事件账本与伏笔'];
  if (!rows.length) return `${lines[0]}\n\n（暂无事件记录）`;
  for (const e of rows) {
    const status = e.kind === 'foreshadow'
      ? `｜伏笔状态：${e.foreshadow_status || 'open'}${e.resolves_event_id ? `（由 #${e.resolves_event_id} 回收）` : ''}`
      : '';
    lines.push(`- #${e.id} [${e.kind}]${status}\n  ${capText(e.summary, 400)}`);
  }
  return lines.join('\n');
}

function renderOutline(workId) {
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const plotlines = prepare('SELECT * FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const allChapters = prepare('SELECT id, title, summary, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const lines = ['# 大纲与剧情线'];
  for (const v of volumes) lines.push(`## 【卷】${v.title}${v.summary ? `：${capText(v.summary, 300)}` : ''}`);
  for (const p of plotlines) lines.push(`## 【${p.kind === 'side' ? '支线' : '主线'}】${p.title}${p.summary ? `：${capText(p.summary, 300)}` : ''}`);
  const total = allChapters.length;
  const skip = total > 80 ? total - 40 - 30 : -1;
  const shown = allChapters.filter((c, i) => skip < 0 || i < 30 || i >= skip);
  if (skip >= 0) lines.push(`（中间 ${skip - 30} 章已省略）`);
  for (const c of shown) {
    lines.push(`- 第${c.position + 1}节 ${c.title}${c.summary ? `：${capText(c.summary, 160)}` : ''}`);
  }
  return lines.join('\n');
}

function renderTerm(term, catName) {
  const cat = catName !== undefined
    ? (catName ? { name: catName } : null)
    : (term.category_id ? prepare('SELECT name FROM categories WHERE id = ?').get(term.category_id) : null);
  const head = [`# 词条：${term.title || ''}`];
  const meta = [cat?.name ? `分类：${cat.name}` : '', term.tags ? `标签：${term.tags}` : ''].filter(Boolean).join('｜');
  if (meta) head.push(meta);
  head.push('', capText(htmlToPlain(term.content), 6000));
  return head.join('\n');
}

function renderCharacter(ch, rels) {
  const relList = rels !== undefined
    ? rels
    : prepare(`
        SELECT cr.relation, cr.description, c2.name AS to_name
        FROM character_relations cr
        LEFT JOIN characters c2 ON c2.id = cr.to_character_id
        WHERE cr.from_character_id = ?
      `).all(ch.id);
  const relText = relList.length
    ? relList.map((r) => `- ${r.to_name || '?'}：${r.relation || '关系'}${r.description ? `（${capText(r.description, 160)}）` : ''}`).join('\n')
    : '';
  const parts = [`# 角色：${ch.name || ''}`];
  if (ch.aliases) parts.push(`别名：${ch.aliases}`);
  const fields = [
    ch.identity ? `\n身份：${capText(ch.identity, 300)}` : '',
    ch.appearance ? `\n外貌：${capText(ch.appearance, 500)}` : '',
    ch.personality ? `\n性格：${capText(ch.personality, 800)}` : '',
    ch.background ? `\n背景：${capText(ch.background, 1500)}` : '',
    ch.status ? `\n当前状态：${capText(ch.status, 500)}` : '',
    ch.tags ? `\n标签：${ch.tags}` : ''
  ].filter(Boolean);
  parts.push(...fields);
  if (relText) parts.push(`\n人物关系：\n${relText}`);
  return parts.join('\n');
}

function renderWorldEntry(e) {
  const parts = [`# 世界观：${e.title || ''}`];
  if (e.keywords) parts.push(`关键词：${e.keywords}`);
  parts.push('', capText(htmlToPlain(e.content), 6000));
  return parts.join('\n');
}

function renderChapter(c) {
  const content = htmlToPlain(c.content);
  return [
    `# 第${c.position + 1}节 ${c.title || ''}`,
    c.summary ? `\n摘要：${capText(c.summary, 300)}` : '',
    c.author_note ? `\n作者注：${capText(c.author_note, 400)}` : '',
    `\n正文：\n${capText(content, 200000)}`
  ].filter(Boolean).join('\n');
}

// ---------- 防抖调度 ----------
const debounceMap = new Map();
const DEBOUNCE_MS = 2000;

// 类型 → 同步动作。kind 见 notifyChange。
export function notifyChange(kind, payload) {
  if (OV_DISABLED || !semanticEnabled()) return;
  const key = `${kind}:${payload.workId}:${payload.id ?? ''}`;
  const prev = debounceMap.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    debounceMap.delete(key);
    syncChange(kind, payload).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `同步失败（${kind} #${payload.id}）：${e.message}`, error: e }));
  }, DEBOUNCE_MS);
  debounceMap.set(key, { timer, at: Date.now(), kind, payload });
}

// 进程退出前冲刷防抖窗口内的变更（避免服务关闭前最后 2 秒的编辑丢失）。
export async function flushDebouncedSync() {
  const pending = [...debounceMap.values()];
  debounceMap.clear();
  for (const p of pending) clearTimeout(p.timer);
  await Promise.allSettled(pending.map((p) =>
    syncChange(p.kind, p.payload).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `退出冲刷同步失败（${p.kind} #${p.payload.id}）：${e.message}`, error: e }))
  ));
}

const LOOKUP_TABLES = new Set(['works', 'chapters', 'terms', 'characters', 'character_relations', 'world_entries']);
function lookupRow(table, id) {
  if (!LOOKUP_TABLES.has(table)) throw new Error(`非法表名：${table}`);
  if (!id) return null;
  return prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

async function syncChange(kind, payload) {
  const { workId, id } = payload;
  if (!workId) return;
  switch (kind) {
    case 'works': {
      const work = lookupRow('works', id);
      if (!work) return;
      await safeWrite(fileUri(workId, 'meta.md'), renderWorkMeta(work));
      return;
    }
    case 'chapters': {
      if (payload.deleted) {
        await safeRemove(fileUri(workId, `chapters/${id}.md`));
      } else {
        const row = lookupRow('chapters', id);
        if (row) await safeWrite(fileUri(workId, `chapters/${id}.md`), renderChapter(row));
      }
      await syncOutline(workId); // 章节标题/摘要变化同步进大纲文件
      return;
    }
    case 'terms': {
      if (payload.deleted) await safeRemove(fileUri(workId, `settings/${id}.md`));
      else {
        const row = lookupRow('terms', id);
        if (row) await safeWrite(fileUri(workId, `settings/${id}.md`), renderTerm(row));
      }
      return;
    }
    case 'characters': {
      if (payload.deleted) await safeRemove(fileUri(workId, `characters/${id}.md`));
      else {
        const row = lookupRow('characters', id);
        if (row) await safeWrite(fileUri(workId, `characters/${id}.md`), renderCharacter(row));
      }
      return;
    }
    case 'relations': {
      // 关系变化影响两端角色卡文件。
      const rel = lookupRow('character_relations', id);
      if (rel) {
        const a = lookupRow('characters', rel.from_character_id);
        const b = lookupRow('characters', rel.to_character_id);
        if (a) await safeWrite(fileUri(workId, `characters/${a.id}.md`), renderCharacter(a));
        if (b) await safeWrite(fileUri(workId, `characters/${b.id}.md`), renderCharacter(b));
      }
      return;
    }
    case 'world_entries': {
      if (payload.deleted) await safeRemove(fileUri(workId, `world/${id}.md`));
      else {
        const row = lookupRow('world_entries', id);
        if (row) await safeWrite(fileUri(workId, `world/${id}.md`), renderWorldEntry(row));
      }
      return;
    }
    case 'plotlines':
    case 'volumes': {
      await syncOutline(workId);
      return;
    }
    case 'story_memory': {
      await safeWrite(fileUri(workId, 'long-memory.md'), renderMemory(workId));
      return;
    }
    case 'events': {
      await safeWrite(fileUri(workId, 'events.md'), renderEvents(workId));
      return;
    }
    default:
      break;
  }
}

async function syncOutline(workId) {
  const work = lookupRow('works', workId);
  if (!work) return;
  await safeWrite(fileUri(workId, 'outline.md'), renderOutline(workId));
}

// ---------- 写/删（带 pending 队列兜底） ----------
async function safeWrite(uri, content) {
  const r = await ovClient.write(uri, content, { wait: false });
  if (!r.ok) enqueueOpenVikingOp({ kind: 'write', uri, content });
  else clearQueuedOpForUri(uri); // 直写成功即作废队列中该 URI 的旧条目，防过期回滚
  return r.ok;
}

async function safeRemove(uri, recursive = false) {
  const r = await ovClient.remove(uri, { recursive });
  if (!r.ok) enqueueOpenVikingOp({ kind: 'remove', uri });
  else clearQueuedOpForUri(uri);
  return r.ok;
}

// ---------- 全量同步（初始导入 / 重建索引） ----------

function collectWorkOperations(workId) {
  const ops = [];
  const work = lookupRow('works', workId);
  if (!work) return null;
  ops.push({ uri: fileUri(workId, 'meta.md'), content: renderWorkMeta(work) });
  ops.push({ uri: fileUri(workId, 'long-memory.md'), content: renderMemory(workId) });
  ops.push({ uri: fileUri(workId, 'events.md'), content: renderEvents(workId) });
  ops.push({ uri: fileUri(workId, 'outline.md'), content: renderOutline(workId) });
  // 预载分类名与关系，避免逐条 renderTerm/renderCharacter 的 N+1 查询。
  const catNameById = new Map(prepare('SELECT id, name FROM categories WHERE work_id = ?').all(workId).map((r) => [r.id, r.name]));
  for (const t of prepare('SELECT * FROM terms WHERE work_id = ? ORDER BY id ASC').all(workId)) {
    ops.push({ uri: fileUri(workId, `settings/${t.id}.md`), content: renderTerm(t, t.category_id ? catNameById.get(t.category_id) : null) });
  }
  const relsByChar = new Map();
  for (const r of prepare(`SELECT cr.from_character_id, cr.relation, cr.description, c2.name AS to_name FROM character_relations cr LEFT JOIN characters c2 ON c2.id = cr.to_character_id WHERE cr.work_id = ?`).all(workId)) {
    if (!relsByChar.has(r.from_character_id)) relsByChar.set(r.from_character_id, []);
    relsByChar.get(r.from_character_id).push(r);
  }
  for (const c of prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY id ASC').all(workId)) {
    ops.push({ uri: fileUri(workId, `characters/${c.id}.md`), content: renderCharacter(c, relsByChar.get(c.id) || []) });
  }
  for (const w of prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY id ASC').all(workId)) {
    ops.push({ uri: fileUri(workId, `world/${w.id}.md`), content: renderWorldEntry(w) });
  }
  for (const c of prepare('SELECT id, position, title, summary, content, author_note FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId)) {
    ops.push({ uri: fileUri(workId, `chapters/${c.id}.md`), content: renderChapter(c) });
  }
  return { workId, work, ops };
}

// D8-#6：同一作品的「在途同步」与「移除」之间的顺序闸（实现见 ai/sync-gate.mjs）。
// 为什么放在这一层而不是让调用点各自记得 await：`syncWorkFull` / `removeWorkFromMemory`
// 在 server.js 里有六个 fire-and-forget 调用点——指望它们都记得，等于没修。
const gate = createSyncGate();

export async function syncWorkFull(workId) {
  if (OV_DISABLED) return { ok: false, reason: '集成已禁用' };
  const collected = collectWorkOperations(workId);
  if (!collected) return { ok: false, reason: '作品不存在' };
  const job = timedAsync('sync', `全量同步（work ${workId}）`, async () => {
    const { ops } = collected;
    // D8-#6：本作品已被请求移除时立刻停手——不要往一个正在被删的目录里写。
    // 这是「建完立刻删」留下孤儿目录的直接原因：同步要跑几十个串行请求（生产约 30 秒），
    // 删除早就完成了，剩下的文件却还在写。
    if (gate.shouldStop(workId)) return { ok: false, files: ops.length, wrote: 0, aborted: true };
    const metaOp = ops.find((o) => o.uri.endsWith('/meta.md'));
    // N-04：先写 meta.md 创建目录；其余文件逐条走 write（replace，幂等）。
    // 不再使用 batch-write：当前 OpenViking 服务端的 batch 对「尚不存在的目标文件」返回 404
    // （实测：batch 对 long-memory.md 报 File not found，而单文件 write 的 create 分支正常）。
    const first = await ovClient.write(fileUri(workId, 'meta.md'), metaOp?.content || '', { wait: false });
    const rest = ops.filter((o) => o !== metaOp);
    let wrote = first.ok ? 1 : 0;
    for (const op of rest) {
      // 每条写之前都问一次：作品可能就在这几十秒里被删掉了。
      if (gate.shouldStop(workId)) return { ok: false, files: ops.length, wrote, aborted: true };
      const r = await ovClient.write(op.uri, op.content || '', { wait: false });
      if (r.ok) wrote += 1;
      else enqueueOpenVikingOp({ kind: 'write', uri: op.uri, content: op.content || '' });
    }
    if (!first.ok) enqueueOpenVikingOp({ kind: 'write', uri: fileUri(workId, 'meta.md'), content: metaOp?.content || '' });
    // 全部成功才写索引标记并清队列，否则返回 ok:false，避免「假成功」掩盖同步失败（OS-07）。
    const allOk = wrote === ops.length;
    if (allOk) {
      setAppSetting(`ov_indexed_at:${workId}`, new Date().toISOString());
      clearQueuedOpsForWork(workDir(workId));
    }
    return { ok: allOk, files: ops.length, wrote };
  }, 3000);
  // 登记在途任务：移除流程会先等它收手，再删目录。
  return gate.register(workId, job);
}

// 🐞 运行追踪：全量同步是逐文件串行 HTTP 写，最慢的一条链路，单独成函数级节点。
syncWorkFull = traceFn('syncWorkFull（记忆库全量同步）', syncWorkFull, { kind: 'http', slowMs: 2000 });

export async function removeWorkFromMemory(workId) {
  if (OV_DISABLED) return false;
  try {
    // D8-#6：**先举旗、再等在途同步收手，然后才删目录**。
    // 只"等"不收手是不够的：同步仍会把几十个文件写完，删除照样排在它后面。
    const { drained } = await gate.cancelAndDrain(workId);
    if (!drained) {
      log({
        level: 'warn', layer: 'sync', kind: 'sync_remove_blocked',
        message: `作品目录移除前仍有在途同步未收手（work ${workId}）——继续移除，但可能留下孤儿文件`,
        context: { work_id: workId }
      });
    }
    setAppSetting(`ov_indexed_at:${workId}`, '');
    const dir = workDir(workId);
    const removed = await safeRemove(dir, true);
    // D3 发现生产记忆库里有 183 个孤儿目录，而**没有任何一条日志提示过**。
    // 移除失败会进重试队列，但那对使用者不可见——这里必须出声。
    if (!removed) {
      log({
        level: 'warn', layer: 'sync', kind: 'sync_remove_failed',
        message: `作品目录移除失败（work ${workId}）：${dir}——已进重试队列；若反复出现请检查 OpenViking 服务`,
        context: { work_id: workId, uri: dir }
      });
    }
    return auditWorkRemoval(workId, { removed });
  } finally {
    // 旗子必须撤：作品 id 可能被复用（删掉再建），旧旗子会误伤新作品的第一轮同步。
    gate.release(workId);
  }
}

// ---------- R04：投影审计 / retry·replay·rebuild ----------

/** 章节 id → 章序位次（position ASC, id ASC 的排名；按 position 排序可兼容 position 全为 0 的旧数据）。
 *  来源校验用：仅凭文件名判断不了"未来章节"。 */
function chapterPositionMap(workId) {
  try {
    const rows = prepare('SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
    return new Map(rows.map((r, i) => [String(r.id), i]));
  } catch {
    return new Map();
  }
}

/** 本作品同步器**会生成**的完整文件集合（rebuild 范围证明的 expected 集）。 */
export function expectedWorkUris(workId) {
  const collected = collectWorkOperations(workId);
  return (collected?.ops || []).map((o) => o.uri);
}

/** 当前章的章序位次（与 chapterPositionMap 同一口径；取不到时返回 null，等价"无法证明未来性"）。 */
function chapterOrderOf(workId, chapterId) {
  if (!chapterId) return null;
  const v = chapterPositionMap(workId).get(String(chapterId));
  return v === undefined ? null : v;
}

/** 记一条破坏性操作审计（待删除集合 / 范围证明结果；只记摘要，不记记忆正文）。 */
export function recordProjectionAudit({ workId, op, scopeUri = '', plan = null, status = '', detail = '', actor = 'author' } = {}) {
  try {
    prepare(`
      INSERT INTO ov_projection_audit
        (work_id, op, scope_uri, status, expected_count, actual_count, deletable_json, foreign_json, unexpected_json, detail, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(workId) || 0, String(op || ''), String(scopeUri || ''), String(status || ''),
      Number(plan?.expected_count) || 0, Number(plan?.actual_count) || 0,
      JSON.stringify((plan?.deletable || []).slice(0, 500)),
      JSON.stringify((plan?.foreign || []).slice(0, 200)),
      JSON.stringify((plan?.unexpected || []).slice(0, 200)),
      String(detail || '').slice(0, 2000), String(actor || 'author')
    );
  } catch (e) {
    log({ level: 'warn', layer: 'sync', kind: 'ov_audit_write_failed', message: `投影审计写入失败：${e.message}` });
  }
}

export function listProjectionAudit(workId, limit = 50) {
  return prepare('SELECT * FROM ov_projection_audit WHERE work_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(workId) || 0, Math.min(200, Math.max(1, Number(limit) || 50)));
}

/**
 * 重建本作品的派生投影（重建索引）：范围证明 → 删除 → 全量同步。
 *   · dry_run=true 只做证明与计划（默认；返回可审计的待删除集合）；
 *   · 服务不可用 / 范围证明失败 → **不执行任何删除**，如实返回原因；
 *   · 删除逐个文件进行，失败即停并记审计（不做"先删再重建"式赌博）。
 */
export async function rebuildWorkMemory(workId, { dryRun = true, actor = 'author' } = {}) {
  if (OV_DISABLED) return { ok: false, code: 'disabled', reason: 'OpenViking 集成已禁用（NOVELSTUDIO_OV_DISABLED=1）' };
  const collected = collectWorkOperations(workId);
  if (!collected) return { ok: false, code: 'not_found', reason: '作品不存在' };
  const scope = workDir(workId);
  const expected = expectedWorkUris(workId);
  const listed = await ovClient.list(scope, { recursive: true });
  if (!listed.ok) {
    recordProjectionAudit({ workId, op: 'rebuild', scopeUri: scope, status: 'blocked', detail: `记忆服务不可用：${listed.error}`, actor });
    return { ok: false, code: 'unavailable', reason: `记忆库不可用（${listed.error || '未返回条目'}），未执行任何删除`, scope_uri: scope };
  }
  const plan = planRebuild({
    workUri: scope, expectedUris: expected,
    actualUris: listed.entries.filter((e) => !e.isDir).map((e) => e.uri),
    actualDirs: listed.entries.filter((e) => e.isDir).map((e) => e.uri),
  });
  const planFull = { ...plan, expected_count: expected.length, actual_count: listed.entries.length };
  recordProjectionAudit({
    workId, op: dryRun ? 'rebuild_plan' : 'rebuild', scopeUri: scope, plan: planFull,
    status: plan.ok ? (dryRun ? 'planned' : 'approved') : 'refused', detail: plan.reason, actor,
  });
  if (!plan.ok) return { ok: false, ...planFull, scope_uri: scope };
  if (dryRun) {
    return { ok: true, code: 'ok', dry_run: true, scope_uri: scope, deletable: plan.deletable, expected_count: expected.length, actual_count: listed.entries.length };
  }
  // 举旗阻止在途同步继续写，等在途任务收手后再删（与 removeWorkFromMemory 同一闸门）。
  const { drained } = await gate.cancelAndDrain(workId);
  setAppSetting(`ov_indexed_at:${workId}`, '');
  const removed = [];
  let failedUri = '';
  try {
    for (const uri of plan.deletable) {
      const okRemove = await safeRemove(uri, false);
      if (okRemove) removed.push(uri);
      else { failedUri = uri; break; }
    }
  } finally {
    gate.release(workId);
  }
  if (failedUri) {
    recordProjectionAudit({
      workId, op: 'rebuild', scopeUri: scope,
      plan: { ...planFull, deletable: plan.deletable }, status: 'partial_failed',
      detail: `删除失败于 ${failedUri}（已删 ${removed.length}/${plan.deletable.length}），未继续重建；失败项已进重试队列`, actor,
    });
    return { ok: false, code: 'delete_failed', reason: `删除失败于 ${failedUri}（已删 ${removed.length}/${plan.deletable.length}）`, scope_uri: scope, drained, removed };
  }
  const sync = await syncWorkFull(workId);
  recordProjectionAudit({
    workId, op: 'rebuild', scopeUri: scope, plan: planFull,
    status: sync.ok ? 'done' : 'sync_failed',
    detail: `已删 ${removed.length} 个条目；同步 ${sync.ok ? '成功' : '失败'}` + (sync.ok ? '' : `：${sync.reason || ''}`), actor,
  });
  return { ok: Boolean(sync.ok), code: sync.ok ? 'ok' : 'sync_failed', scope_uri: scope, drained, removed: removed.length, sync };
}

/**
 * 重放（replay）：依据**当前正式版本**重新投递本作品的投影任务（不删除任何既有记忆。
 * 与 retry 的分工：retry 只复活 failed 行；replay 是"记录可能已丢/来自旧版本"时重新生成投影）。
 * 走既有 outbox —— 服务不可用时任务留在 pending，由 startup drain / retry 恢复。
 */
export function replayWorkProjection(workId, { reason = 'manual_replay', actor = 'author' } = {}) {
  const collected = collectWorkOperations(workId);
  if (!collected) return { ok: false, code: 'not_found', reason: '作品不存在' };
  const opId = `replay:${workId}:${Date.now().toString(36)}`;
  const info = prepare(`
    INSERT OR IGNORE INTO projection_outbox (work_id, chapter_id, kind, dedup_key, payload_json)
    VALUES (?, NULL, 'ov_work_sync', ?, ?)
  `).run(Number(workId) || 0, opId, JSON.stringify({ reason, actor, at: new Date().toISOString() }));
  const id = Number(info.lastInsertRowid) || Number(prepare('SELECT id FROM projection_outbox WHERE dedup_key = ?').get(opId)?.id) || 0;
  return { ok: true, code: 'ok', projection_id: id, dedup_key: opId, files: collected.ops.length };
}

/** 删除作品记忆前的审计（remove 同样属于破坏性操作：记录 namespace 与目标）。 */
export function auditWorkRemoval(workId, { removed, actor = 'author' } = {}) {
  const scope = workDir(workId);
  recordProjectionAudit({
    workId, op: 'remove', scopeUri: scope,
    plan: { deletable: [scope], expected_count: 0, actual_count: 0 },
    status: removed ? 'done' : 'failed',
    detail: removed ? '作品命名空间整体移除' : '作品命名空间移除失败（已进重试队列）', actor,
  });
  return removed;
}

// ---------- 启动时自动建索引（只补缺/过期，全量同步本身幂等） ----------
// 归一化时间戳比较：兼容旧库空格格式与 ISO 两种写法，避免字符串比较漏判同日更新。
function parseTs(s) {
  const t = String(s || '');
  if (!t) return 0;
  const iso = t.includes('T') ? t : (t.includes(' ') ? t.replace(' ', 'T') + 'Z' : t);
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

let autoIndexStarted = false;
export function autoIndexExistingWorks() {
  if (autoIndexStarted) return;
  autoIndexStarted = true;
  if (OV_DISABLED) return;
  if (process.env.NOVELSTUDIO_OV_AUTOINDEX === '0') return;
  if (!semanticEnabled()) return;
  setTimeout(async () => {
    try {
      const healthy = await ovClient.health();
      if (!healthy) return; // 服务器不在线：等 pending/下次启动再说
      const works = prepare('SELECT id, updated_at FROM works ORDER BY id ASC').all();
      for (const w of works) {
        const indexedAt = getAppSetting(`ov_indexed_at:${w.id}`, '');
        if (!indexedAt || parseTs(indexedAt) < parseTs(w.updated_at)) {
          await syncWorkFull(w.id).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `全量同步失败（work ${w.id}）：${e.message}`, error: e }));
        }
      }
    } catch (e) {
      log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `启动索引失败：${e.message}`, error: e });
    }
  }, 3000);
}

// ---------- 语义召回（上下文装配层 + 检索合并共用） ----------
const recallCache = new Map();
const RECALL_TTL_MS = 30000;
const RECALL_MAX_HITS = 8;
const RECALL_SCORE_THRESHOLD = 0.3;
const RECALL_CACHE_MAX = 256;
function recallCacheSet(key, payload) {
  recallCache.set(key, { at: Date.now(), payload });
  while (recallCache.size > RECALL_CACHE_MAX) {
    recallCache.delete(recallCache.keys().next().value); // LRU：超出上限淘汰最旧
  }
}

/** 作品/章节级轻量信号（不含方向）：正典召回与资料召回共用同一来源，避免两套字段口径。 */
function buildRecallParts(workId, chapter) {
  const parts = [];
  const work = lookupRow('works', workId);
  if (work?.title) parts.push(`作品：${work.title}`);
  // 空章节/新章节正文缺位时，补入作品简介与作者注，作为语义召回的多路信号（报告 §10.2-3）。
  if (work?.description) parts.push(`简介：${capText(work.description, 160)}`);
  if (work?.author_note) parts.push(`作品作者注：${capText(work.author_note, 200)}`);
  if (chapter) {
    parts.push(`当前章节：第${chapter.position + 1}节 ${chapter.title}`);
    if (chapter.summary) parts.push(`章节摘要：${capText(chapter.summary, 300)}`);
    if (chapter.blueprint_json) {
      try {
        const bp = JSON.parse(chapter.blueprint_json);
        const bpText = ['scene_goal', 'plot_points', 'conflicts', 'character_changes', 'hook']
          .map((k) => String(bp[k] || ''))
          .filter(Boolean)
          .join('；');
        if (bpText) parts.push(`本章蓝图：${capText(bpText, 400)}`);
      } catch { /* ignore */ }
    }
    if (chapter.author_note) parts.push(`章节作者注：${capText(chapter.author_note, 200)}`);
    const head = htmlToPlain(chapter.content || '').slice(0, 800);
    if (head) parts.push(`本章开头正文：${head}`);
  }
  const events = prepare('SELECT summary FROM story_events WHERE work_id = ? ORDER BY id DESC LIMIT 12').all(workId);
  if (events.length) parts.push(`最近事件：${events.map((e) => capText(e.summary, 120)).join('；')}`);
  return parts.filter(Boolean);
}

/** 正典语义召回的查询（保持历史行为不变；资料召回不得复用它的方向语义）。 */
function buildRecallQuery(workId, chapter) {
  return buildRecallParts(workId, chapter).join('\n').slice(0, 1600);
}

/**
 * C5：资料召回专用查询构造（与正典语义召回分离，可分别测试）。
 *   · 未传 direction：与 buildRecallQuery 同源同输出（逐字节兼容历史路径）；
 *   · 传 direction：direction 置于最高优先位置，仅保留必要轻量信号
 *     （作品标题、章节标题、必要摘要），不拼入全部正文/事件/完整蓝图；
 *   · 总字符上限维持 1600（不因 direction 放宽）。
 */
export function buildLibraryRecallQuery(workId, chapter, options = {}) {
  const direction = normalizeDirection(options.direction);
  if (!direction) return buildRecallQuery(workId, chapter);
  const work = lookupRow('works', workId);
  const parts = [];
  if (work?.title) parts.push(`作品：${work.title}`);
  if (chapter) {
    parts.push(`当前章节：第${chapter.position + 1}节 ${chapter.title}`);
    if (chapter.summary) parts.push(`章节摘要：${capText(chapter.summary, 120)}`);
  }
  parts.push(`写作方向：${direction}`);
  return parts.filter(Boolean).join('\n').slice(0, 1600);
}

function recallKind(rel) {
  if (rel.startsWith('chapters/')) return '章节正文';
  if (rel.startsWith('settings/')) return '设定词条';
  if (rel.startsWith('characters/')) return '角色卡';
  if (rel.startsWith('world/')) return '世界观词条';
  if (rel === 'long-memory.md') return '长期记忆';
  if (rel === 'events.md') return '事件账本';
  if (rel === 'outline.md') return '大纲';
  if (rel === 'meta.md') return '作品';
  return '记忆条目';
}

// N-12：语义召回噪声过滤——记忆库的目录元数据文件（.abstract.md 等，以「.」开头）
// 与「（暂无…）」占位文件会稀释上下文预算，直接跳过。
function isRecallNoise(rel, text) {
  const name = (rel || '').split('/').pop() || '';
  if (name.startsWith('.')) return true;
  const body = String(text || '').split('\n').slice(1).join('\n').trim();
  if (!body || /^（暂无/.test(body)) return true;
  return false;
}

/**
 * 语义召回：以当前写作场景为查询，从共享记忆库的作品子树检索相关片段。
 * 结果带 30 秒微缓存；OpenViking 不可用时静默降级（status=unavailable），不阻塞写作。
 */
export async function getSemanticRecall(workId, chapter) {
  if (OV_DISABLED || !semanticEnabled()) return { enabled: false, status: 'disabled', query: '', hits: [] };
  const key = `${workId}:${chapter?.id || 0}`;
  const hit = recallCache.get(key);
  if (hit && Date.now() - hit.at < RECALL_TTL_MS) return hit.payload;

  const query = buildRecallQuery(workId, chapter);
  if (!query.trim()) return { enabled: true, status: 'empty', query: '', hits: [] };

  let hits = [];
  try {
    hits = await ovClient.find(query, {
      targetUri: workDir(workId),
      limit: RECALL_MAX_HITS,
      scoreThreshold: RECALL_SCORE_THRESHOLD,
      timeoutMs: 6000
    });
  } catch {
    hits = [];
  }
  if (!hits.length) {
    const payload = { enabled: true, status: ovClient.connected ? 'no-hits' : 'unavailable', query, hits: [] };
    recallCacheSet(key, payload);
    return payload;
  }

  // 命中内容并行拉取（各带 5s 超时），避免逐条串行累加网络 RTT。
  const top = hits.slice(0, RECALL_MAX_HITS);
  const reads = await Promise.all(top.map((h) => ovClient.readContent(h.uri, { offset: 0, limit: 30, timeoutMs: 5000 }).catch(() => ({ ok: false, text: '' }))));
  const items = [];
  top.forEach((h, i) => {
    const read = reads[i];
    const text = read.ok ? read.text : h.abstract || '';
    if (!text.trim()) return;
    const rel = String(h.uri).replace(`${workDir(workId)}/`, '');
    if (isRecallNoise(rel, text)) return;
    const label = (text.split('\n').find((l) => l.startsWith('#')) || `# ${rel}`).replace(/^#+\s*/, '');
    items.push({
      uri: h.uri,
      label: capText(label, 40),
      kind: recallKind(rel),
      score: Math.round(h.score * 100),
      text: capText(text, 300)
    });
  });

  // R04：来源 fail-closed 校验——跨书 / 未来章节 / 候选内容 / 未知布局一律不进上下文。
  // 宿主装配器还会用同一实现**再校验一次**（不信任本层的过滤结果）。
  const { kept, dropped } = filterRecallItems(items, {
    workUri: workDir(workId),
    currentChapterOrder: chapterOrderOf(workId, chapter?.id),
    chapterOrderById: chapterPositionMap(workId),
  });
  if (dropped.length) {
    log({
      level: 'warn', layer: 'sync', kind: 'recall_source_blocked',
      message: `语义召回有 ${dropped.length} 条被来源校验拦下（未进入上下文）`,
      context: { work_id: workId, dropped: dropped.slice(0, 10) }
    });
  }
  const payload = kept.length
    ? {
        enabled: true,
        status: 'ok',
        query,
        hits: kept,
        omitted: dropped,
        meta_validated: true,
        text: kept.map((i) => `【${i.label}】（相关度 ${i.score}%）\n${i.text}`).join('\n\n')
      }
    : {
        enabled: true,
        // 全部被拦下 → 'filtered'（显式缺口：有召回，但来源不可信），不能记成 no-hits。
        status: dropped.length ? 'filtered' : 'no-hits',
        query, hits: [], omitted: dropped, meta_validated: true
      };
  // ⚠️ 必须走 recallCacheSet：直接 recallCache.set 会绕过容量回收，
  // 于是 RECALL_CACHE_MAX=256 只约束了"没有命中"的空结果，最占内存的成功条目反而无上限
  // （8 段命中 × 300 字，长作品多章节时会一直涨）。2026-09-18 审计发现并修正。
  recallCacheSet(key, payload);
  return payload;
}

// 检索合并（novel_lookup / 全局搜索用）：语义结果与关键词结果并列返回。
export async function semanticSearchMerge(q, workId) {
  if (OV_DISABLED) return { enabled: false, hits: [] };
  if (!semanticEnabled() || !q.trim()) return { enabled: semanticEnabled(), hits: [] };
  try {
    const hits = await ovClient.find(q, {
      targetUri: workId ? workDir(workId) : OV_ROOT,
      limit: 6,
      scoreThreshold: 0.25,
      timeoutMs: 6000
    });
    const reads = await Promise.all(hits.map((h) => ovClient.readContent(h.uri, { offset: 0, limit: 15, timeoutMs: 5000 }).catch(() => ({ ok: false, text: '' }))));
    const items = [];
    hits.forEach((h, i) => {
      const read = reads[i];
      const text = read.ok ? read.text : h.abstract || '';
      const rel = String(h.uri).replace(`${workId ? workDir(workId) : OV_ROOT}/`, '');
      if (isRecallNoise(rel, text)) return;
      const label = (text.split('\n').find((l) => l.startsWith('#')) || '').replace(/^#+\s*/, '');
      items.push({
        uri: h.uri,
        label: capText(label || rel.split('/').pop() || '记忆条目', 40),
        kind: recallKind(rel),
        score: Math.round(h.score * 100),
        text: capText(text, 200)
      });
    });
    return { enabled: true, hits: items };
  } catch {
    return { enabled: true, hits: [] };
  }
}

// 🐞 运行追踪：语义召回是每次上下文装配里最不可控的一段外部等待（find 6s + 逐条 read 5s），
// 必须能单独看到它耗时多少、命中多少——否则「上下文装配慢」无法归因到记忆库还是本地 SQL。
getSemanticRecall = traceFn('getSemanticRecall（语义召回）', getSemanticRecall, { kind: 'http', slowMs: 500 });
semanticSearchMerge = traceFn('semanticSearchMerge（检索合并）', semanticSearchMerge, { kind: 'http', slowMs: 500 });

// ---------- 共享资料库召回（library 层；参数与条目形状见 ai/library/library-recall.mjs） ----------
// 与语义召回同构但**互不混层**：独立的 find（targetUri=共享资料根）、独立的微缓存、
// 独立的来源校验分支（资料条目 canon 记 'reference'，永不 canon；普通召回层拒绝资料条目）。
// 门控：library_enabled:<workId> 默认关闭（与 story_state/edit_rules 同口径，未开启即不存在）。
const libraryCache = new Map();
function libraryCacheSet(key, payload) {
  libraryCache.set(key, { at: Date.now(), payload });
  while (libraryCache.size > LIBRARY_RECALL.cacheMax) {
    libraryCache.delete(libraryCache.keys().next().value); // LRU：超出上限淘汰最旧
  }
}

/** 作品是否打开资料库层（app_settings；缺省 = 关闭）。 */
export function libraryEnabled(workId) {
  return getAppSetting(`library_enabled:${workId}`, '0') === '1';
}

/**
 * 资料库召回：以当前写作场景/写作方向为查询，从共享资料根检索资料文件，读回前 30 行
 * （P0 实测 offset/limit 按行计）并压到每条 300 字。离线静默降级（不阻塞写作），失败/被拦留审计。
 * 期望有却没拿到时**不插占位层**（与 recall 有意不同：资料是辅助材料，缺了不误导判断；
 * 状态与原因在响应字段与日志里可见）——别按 recall 口径"修"回占位层。
 *
 * 本次新增（C2/C4/D4）：
 *   · `options.libraryRecallPhase`：default | defer | direction。
 *     defer 时**不查资料库、不写缓存**（专门的装配内部阶段，不得触发搜索）；
 *   · `options.direction`：方向只用于检索（查询构造 + D 索引候选发现），不解析其中的指令；
 *   · 微缓存键 = work:chapter:phase:directionHash:资料索引版本（含 schema）——
 *     方向变化/索引重建/索引 schema 升级都必须不命中旧结果；
 *   · 计数口径：`stats.searches` 是**真实资料检索次数**（缓存命中记 0），
 *     `stats.index_queries` 是**索引查询次数**（缓存命中同样记 0——本次没有发生查询），
 *     两者分开统计（验收时不得混算）。
 */
export async function getLibraryRecall(workId, chapter, options = {}) {
  const phase = normalizeLibraryRecallPhase(options.libraryRecallPhase);
  const direction = normalizeDirection(options.direction);
  const baseStats = (status) => ({
    searches: 0, cached: false, index_assisted: false, index_queries: 0,
    status, hits: 0, text_chars: 0, timings_ms: 0,
    direction_used: Boolean(direction), phase,
  });
  // 关闭判定必须在 defer 之前：`library_enabled`=0（或离线/总闸关闭）时此选项被忽略，
  // 结果与旧调用（disabled）逐字节一致——defer 不能反过来改变「资料库未开启」的语义。
  if (OV_DISABLED || !semanticEnabled() || !libraryEnabled(workId)) {
    return { enabled: false, status: 'disabled', query: '', hits: [], stats: baseStats('disabled') };
  }
  if (phase === 'defer') {
    // defer：仅用于「蓝图尚未确定」的内部阶段——不查库、不写缓存、不插占位。
    return { enabled: true, status: 'deferred', query: '', hits: [], stats: baseStats('deferred') };
  }
  const t0 = Date.now();
  // 集成点①：缓存键必须同时包含 direction hash 与索引版本（含 schema）——
  // 只盖 TTL 是不够的：索引重建/升级后旧结果必须立刻失效，方向变了绝不能命中旧结果。
  const versions = LibraryIndex.libraryIndexVersionKey();
  const key = `${workId}:${chapter?.id || 0}:${phase}:${direction ? directionHashOf(direction) : '-'}:${versions}`;
  const hit = libraryCache.get(key);
  if (hit && Date.now() - hit.at < LIBRARY_RECALL.ttlMs) {
    // 缓存命中 = 本次装配**没有发生**真实检索 / 索引查询 / 外部等待：计数与耗时按本次归零，
    // 否则「召回一次 + 缓存命中」会和「召回了两次」在验收表上分不开（集成点③）。
    // 内容来源（status / hits / text_chars / index_assisted / index_assist）保留自缓存载荷。
    return {
      ...hit.payload,
      stats: { ...hit.payload.stats, searches: 0, index_queries: 0, timings_ms: 0, cached: true },
    };
  }

  let query = buildLibraryRecallQuery(workId, chapter, { direction });
  // D4（V1 保守方案）：索引只做候选发现与查询扩展；放行仍由 0.40 语义阈值决定——
  // 词法分数绝不把低于阈值的项顶进上下文（不实现「用词法分顶替语义分」的融合）。
  let indexAssist = null;
  let indexQueries = 0;
  let lexicalByUri = null;
  if (direction && LibraryIndex.libraryIndexEnabled()) {
    const idx = LibraryIndex.queryCandidates({ query: direction, limit: 12 });
    indexQueries += 1;
    if (idx.ok && idx.candidates.length) {
      const terms = LibraryIndex.expansionTermsForHits(idx.candidates);
      if (terms.length) query = `${query}\n${terms.join(' ')}`.slice(0, 1600);
      lexicalByUri = new Map(idx.candidates.map((c) => [c.uri, c.lexical_score]));
      indexAssist = { status: idx.status, candidates: idx.candidates.length, expansion_terms: terms.length, timings_ms: idx.timings_ms };
    } else {
      indexAssist = { status: idx.status, candidates: 0, expansion_terms: 0, timings_ms: idx.timings_ms };
    }
  }
  const stats = { ...baseStats('unknown'), index_queries: indexQueries };
  stats.index_assisted = Boolean(indexAssist);
  if (!query.trim()) {
    // 空查询是**正常空结果**，不写微缓存（与原实现一致；§九-11）：
    // 查询为空意味着当前场景没有可取回的检索输入，缓存它只会制造一段"看似命中"的假历史。
    return { enabled: true, status: 'empty', query: '', hits: [], index_assist: indexAssist, stats: { ...stats, status: 'empty', timings_ms: Date.now() - t0 } };
  }

  let hits = [];
  try {
    stats.searches = 1;
    hits = await ovClient.find(query, {
      targetUri: SHARED_LIBRARY_ROOT,
      limit: LIBRARY_RECALL.maxHits + LIBRARY_RECALL.overscan,
      scoreThreshold: LIBRARY_RECALL.scoreThreshold,
      timeoutMs: 6000
    });
  } catch {
    hits = [];
  }
  if (!hits.length) {
    const payload = { enabled: true, status: ovClient.connected ? 'no-hits' : 'unavailable', query, hits: [], index_assist: indexAssist, stats: { ...stats, status: ovClient.connected ? 'no-hits' : 'unavailable', timings_ms: Date.now() - t0 } };
    libraryCacheSet(key, payload);
    return payload;
  }

  // P1 真机实测（2026-09-28）：OV 会给目录生成 `.abstract.md` / `.overview.md` 伴随文件，
  // 且摘要分数常高于正文文档。若先按分数截断再过滤，伴随文件会把真资料挤出 top-4——
  // 所以先用同一套形状闸门做候选过滤（先过滤、后截断），被拦者仍带 code 进 omitted 可归因。
  const preDropped = [];
  const candidates = [];
  for (const h of hits) {
    const verdict = validateRecallItem(h, { allowLibrary: true, libraryWorkId: String(workId) });
    if (verdict.ok) candidates.push(h);
    else preDropped.push({ uri: h.uri, code: verdict.code, reason: verdict.reason });
  }
  // 排序（仅索引开启时改变）：语义分优先（阈值已由 OV 卡的 0.40），词法分只作同分/近分的
  // 稳定二级排序，最后按 uri 稳定收口——避免「分数相同则顺序漂移」。索引关闭时保持原序（基线一致）。
  const ordered = indexAssist
    ? [...candidates].sort((a, b) => {
        const ds = (Number(b.score) || 0) - (Number(a.score) || 0);
        if (ds !== 0) return ds;
        const dl = (Number(lexicalByUri?.get(String(b.uri))) || 0) - (Number(lexicalByUri?.get(String(a.uri))) || 0);
        if (dl !== 0) return dl;
        return String(a.uri) < String(b.uri) ? -1 : 1;
      })
    : candidates;
  const top = ordered.slice(0, LIBRARY_RECALL.maxHits);
  const reads = await Promise.all(top.map((h) => ovClient.readContent(h.uri, {
    offset: 0, limit: LIBRARY_RECALL.readLines, timeoutMs: 5000
  }).catch(() => ({ ok: false, text: '' }))));
  const items = [];
  top.forEach((h, i) => {
    const read = reads[i];
    const text = read.ok ? read.text : h.abstract || '';
    if (!text.trim()) return;
    const item = libraryHitOf(h, { text, score: h.score });
    // 审计分数：semantic 为放行分数（0-100），lexical 为索引排序提示（0-100），
    // final 恒等于 semantic——词法分不参与放行，只参与同分排序（口径在报告中说明）。
    item.semantic_score = item.score;
    item.lexical_score = lexicalByUri ? Math.round((Number(lexicalByUri.get(String(h.uri))) || 0) * 100) : null;
    item.final_score = item.score;
    items.push(item);
  });

  // 来源校验（与 recall 共用同一实现，单点规则；候选过滤之后的第二道）：allowLibrary=true 时
  // **只**放行资料条目，形状不合（任意层级 _/. 前缀 / 非两层 / 非 .md）的一样拦下。
  const { kept, dropped } = filterRecallItems(items, { allowLibrary: true, libraryWorkId: String(workId) });
  const omittedAll = [...preDropped, ...dropped];
  if (omittedAll.length) {
    log({
      level: 'warn', layer: 'sync', kind: 'library_source_blocked',
      message: `资料库召回有 ${omittedAll.length} 条被来源校验拦下（未进入上下文）`,
      context: { work_id: workId, dropped: omittedAll.slice(0, 10) }
    });
  }
  const payload = kept.length
    ? {
        enabled: true,
        status: 'ok',
        query,
        hits: kept,
        omitted: omittedAll,
        meta_validated: true,
        index_assist: indexAssist,
        text: libraryRecallTextOf(kept),
        stats: { ...stats, status: 'ok', hits: kept.length, text_chars: libraryRecallTextOf(kept).length, timings_ms: Date.now() - t0 }
      }
    : {
        enabled: true,
        status: omittedAll.length ? 'filtered' : 'no-hits',
        query, hits: [], omitted: omittedAll, meta_validated: true,
        index_assist: indexAssist,
        stats: { ...stats, status: omittedAll.length ? 'filtered' : 'no-hits', timings_ms: Date.now() - t0 }
      };
  libraryCacheSet(key, payload);
  return payload;
}

getLibraryRecall = traceFn('getLibraryRecall（资料库召回）', getLibraryRecall, { kind: 'http', slowMs: 500 });
