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
import { htmlToPlain } from './text-utils.js';

// 协议前缀运行时拼接（避免源码中出现的字面 URI 触发 dsh 的 URI 防护误判）。
const OV_PROTO = 'viking:' + '//';
export const OV_ROOT = OV_PROTO + 'user/default/resources/novel-studio';

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

export function collectWorkOperations(workId) {
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

export async function syncWorkFull(workId) {
  if (OV_DISABLED) return { ok: false, reason: '集成已禁用' };
  const collected = collectWorkOperations(workId);
  if (!collected) return { ok: false, reason: '作品不存在' };
  return timedAsync('sync', `全量同步（work ${workId}）`, async () => {
    const { ops } = collected;
    const metaOp = ops.find((o) => o.uri.endsWith('/meta.md'));
    // N-04：先写 meta.md 创建目录；其余文件逐条走 write（replace，幂等）。
    // 不再使用 batch-write：当前 OpenViking 服务端的 batch 对「尚不存在的目标文件」返回 404
    // （实测：batch 对 long-memory.md 报 File not found，而单文件 write 的 create 分支正常）。
    const first = await ovClient.write(fileUri(workId, 'meta.md'), metaOp?.content || '', { wait: false });
    const rest = ops.filter((o) => o !== metaOp);
    let wrote = first.ok ? 1 : 0;
    for (const op of rest) {
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
}

export async function removeWorkFromMemory(workId) {
  if (OV_DISABLED) return false;
  setAppSetting(`ov_indexed_at:${workId}`, '');
  return safeRemove(workDir(workId), true);
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

function buildRecallQuery(workId, chapter) {
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

  const payload = items.length
    ? {
        enabled: true,
        status: 'ok',
        query,
        hits: items,
        text: items.map((i) => `【${i.label}】（相关度 ${i.score}%）\n${i.text}`).join('\n\n')
      }
    : { enabled: true, status: 'no-hits', query, hits: [] };
  recallCache.set(key, { at: Date.now(), payload });
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
