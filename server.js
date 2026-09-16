import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { isHarnessAvailable, isHarnessBuilt, runHarnessTask, runHarnessTaskWithProgress, modelSwitchLoad } from './harness.js';
import { readZip } from './zip-reader.mjs';
import { htmlToPlain } from './text-utils.js';
import { notifyChange, getSemanticRecall, semanticSearchMerge, semanticEnabled, ovEffectiveEnabled, setAppSetting, syncWorkFull, removeWorkFromMemory, autoIndexExistingWorks, workDir, flushDebouncedSync } from './openviking-sync.js';
import { ovClient, pendingQueueLength } from './openviking.js';
import { assemble as assembleContext } from './ai/context/assembler.mjs';
import { LAYERS as CONTEXT_LAYER_SPEC, capOf as contextCapOf, capOfId, entityCapOfId } from './ai/context/layers.mjs';
import { editDistance } from './ai/edit-distance.mjs';
import { MODELS, KNOWN_DEEPSEEK_MODELS, EFFORTS, resolveModel, normalizeModel, normalizeEffort, policySnapshot } from './ai/policy.mjs';
import { log, initLogger, timed, timedAsync, queryLogs, clearLogs, flushLogs, readableErrorMessage, SLOW_REQUEST_MS, REMOTE_LAYERS } from './logger.js';
import {
  traceRequest, traceFn, traceEvent, traceAI, traceHarness, bumpTool, prepareTraced,
  startTracing, stopTracing, pingTracing, checkStaleTracing, traceState, traceNow, traceClockDomain,
  beginOperation, finishOperation, attachClientNodes, sweepIdleOperations,
  listOperations, getOperation, listToolCalls, sessionSummary,
  subscribeStream, listSessions, readSession, purgeSessions, pruneSessions,
  flushTraceFile, traceConfigInfo, DEBUG_DIR, isExcludedPath
} from './debug-trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3737;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
    // 不再返回 Access-Control-Allow-Origin: *：本地工坊存有 API Key 与作品数据，
    // 任何浏览器页面跨源读取都会被浏览器 CORS 拦截；同源 UI 与 dsh 工具（服务端 fetch）不受影响。
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message || 'Internal error' });
}

// 写请求的跨源防护：浏览器页面发起的 POST/PUT/DELETE 必须来自本机工坊页面
// （Origin 为 localhost/127.0.0.1）；不带 Origin 的非浏览器客户端（curl/dsh 工具）放行。
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
function isLocalRequest(req) {
  if (!MUTATING_METHODS.has(req.method || '')) return true;
  const origin = String(req.headers.origin || '');
  if (origin) {
    try {
      return isLocalHost(new URL(origin).hostname);
    } catch (_) {
      return false;
    }
  }
  // 无 Origin 的非浏览器客户端（curl/dsh 工具）：校验 Host 主机名，
  // 拒绝经非本机主机名到达的写请求（如 DNS rebinding 场景）。
  const hostHeader = String(req.headers.host || '');
  if (hostHeader) {
    const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return isLocalHost(host);
  }
  return true;
}

const MAX_BODY_BYTES = 32_000_000; // 32MB：EPUB 导入用（base64 后约 1.33 倍）；写请求有本机 Origin 校验兜底。

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) {
    const err = new Error('Payload too large');
    err.code = 'PAYLOAD_TOO_LARGE';
    req.destroy();
    throw err;
  }
  return new Promise((resolve, reject) => {
    // 按字节累计而非逐块拼接字符串：既保证 32MB 上限按字节生效，
    // 也避免跨 TCP 分块边界拆分的多字节 UTF-8 字符被逐块解码成乱码。
    const chunks = [];
    let received = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_BODY_BYTES) {
        settled = true;
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const data = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        const e = new Error('Invalid JSON');
        e.code = 'INVALID_JSON';
        reject(e);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function getPath(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return {
    pathname: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries())
  };
}

function parseId(str) {
  const id = Number(str);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function now() {
  return new Date().toISOString();
}

// 预编译语句缓存：相同 SQL 只 prepare 一次，减少重复解析开销，提升请求速度。
// debug-trace 的 prepareTraced 只包住「语句方法的调用」并记录 SQL 操作类型/表名/行数/耗时，
// 不记录绑定值（B 选项：不记正文）。未录制时包装层直接走原语句，零额外开销。
const stmtCache = new Map();
const STMT_CACHE_MAX = 500; // 动态 IN 列表会按占位符数量生成不同 SQL，需上限防止无限增长
const prepare = prepareTraced(function prepareStatement(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    // 🐞 运行追踪的分层机制：语句「准备」属于高频、低信息量的动作（缓存命中时几乎零耗时，
    // 一次操作可能发生上百次），逐条记节点只会淹没业务链路。因此这里只累计次数与总耗时
    // （bumpTool），配合真正逐条记录的 SQL 执行节点（prepareTraced），得到
    // 「主干逐条 + 高频聚合」的分层视图。未录制时 bumpTool 第一行即返回。
    const t0 = performance.now();
    if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.clear();
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
    bumpTool(`prepare 语句（缓存未命中）`, performance.now() - t0);
  } else {
    bumpTool('prepare 语句（缓存命中）', 0);
  }
  return stmt;
});

// ---------- 上下文装配缓存（v0.8.0 性能优化） ----------
// 所有写操作都会经 touchWork() 递增版本号，使缓存整体失效（单用户本地应用，全局失效足够）；
// 缓存只作用于 buildNovelContext 的（work, chapter, mode）结果，命中时跳过全部 SQL 装配。
//
// ⚠️ P2 补上时间上界：版本号**只在写操作时前进**，而装配结果里有一层的可用性
// 与「写」无关——语义召回层。建索引完成、OpenViking 重新上线，都不会触发写操作，
// 于是「索引还没建完时算出的 no-hits」会被无限期缓存。
// 实证（P1 发现 F4）：同一个请求在重启实例前后分别返回 23,275 / 24,738 字，
// 召回层从「不存在」变成「存在」。加 TTL 把这类陈旧结果限制在有界时间内。
let CONTEXT_DATA_VERSION = 0;
const CONTEXT_CACHE = new Map();
const CONTEXT_CACHE_MAX = 64;
const CONTEXT_CACHE_TTL_MS = Number(process.env.NOVELSTUDIO_CONTEXT_CACHE_TTL_MS) > 0
  ? Number(process.env.NOVELSTUDIO_CONTEXT_CACHE_TTL_MS)
  : 120000;

function cacheGetContext(key) {
  const hit = CONTEXT_CACHE.get(key);
  if (hit && hit.version === CONTEXT_DATA_VERSION && Date.now() - hit.at < CONTEXT_CACHE_TTL_MS) {
    CONTEXT_CACHE.delete(key);
    CONTEXT_CACHE.set(key, hit); // LRU：命中移到队尾
    return hit.ctx;
  }
  if (hit) CONTEXT_CACHE.delete(key);
  return undefined;
}

function cacheSetContext(key, ctx) {
  CONTEXT_CACHE.set(key, { version: CONTEXT_DATA_VERSION, at: Date.now(), ctx });
  while (CONTEXT_CACHE.size > CONTEXT_CACHE_MAX) {
    const oldest = CONTEXT_CACHE.keys().next().value;
    CONTEXT_CACHE.delete(oldest);
  }
}

function touchWork(workId) {
  CONTEXT_DATA_VERSION += 1;
  try {
    prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now(), workId);
  } catch (e) {
    log({ level: 'warn', layer: 'db', kind: 'db_error', message: `更新作品 updated_at 失败（work ${workId}）：${e.message}` });
  }
}

function getAppSettingDb(key, fallback = '') {
  const row = prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? String(row.value) : fallback;
}

function setAppSettingDb(key, value) {
  prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- 通用 CRUD ----------
// 集中管理各资源的表名、字段、排序和默认值，避免多个地方重复定义。
const RESOURCE_CONFIG = {
  works: { table: 'works', order: 'id DESC', fields: ['title', 'description', 'author_note', 'default_chapter_words', 'total_chapters', 'story_structure', 'narrative_pov', 'style_positive'], defaults: { description: '', author_note: '', default_chapter_words: 2000, total_chapters: 0, story_structure: '', narrative_pov: '', style_positive: '' } },
  volumes: { table: 'volumes', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  plotlines: { table: 'plotlines', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'kind', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  chapters: { table: 'chapters', order: 'position ASC, id ASC', fields: ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'title', 'summary', 'content', 'author_note', 'blueprint_json', 'target_words', 'context_character_ids', 'position'], defaults: { summary: '', content: '', author_note: '', blueprint_json: '', target_words: 0, context_character_ids: '', position: 0 } },
  categories: { table: 'categories', order: 'position ASC, id ASC', fields: ['work_id', 'name', 'color', 'position'], defaults: { color: '#6366f1', position: 0 } },
  terms: { table: 'terms', order: 'updated_at DESC, id DESC', fields: ['work_id', 'category_id', 'title', 'content', 'tags'], defaults: { content: '', tags: '' } },
  characters: { table: 'characters', order: 'name ASC', fields: ['work_id', 'name', 'identity', 'appearance', 'personality', 'background', 'status', 'avatar_color', 'mes_example', 'tags', 'system_prompt', 'aliases'], defaults: { identity: '', appearance: '', personality: '', background: '', status: '', avatar_color: '#8b5cf6', mes_example: '', tags: '', system_prompt: '', aliases: '' } },
  relations: { table: 'character_relations', order: 'id ASC', fields: ['work_id', 'from_character_id', 'to_character_id', 'relation', 'description'], defaults: { relation: '', description: '' } },
  plotline_characters: { table: 'plotline_characters', order: 'id ASC', fields: ['work_id', 'plotline_id', 'character_id', 'status', 'notes'], defaults: { status: '', notes: '' } },
  world_entries: { table: 'world_entries', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'content', 'keywords', 'is_pinned', 'priority', 'position'], defaults: { content: '', keywords: '', is_pinned: 0, priority: 50, position: 0 } },
  creation_tasks: { table: 'creation_tasks', order: 'id DESC', fields: ['work_id', 'prompt', 'status', 'stages_json', 'result_json', 'error'], defaults: { prompt: '', status: 'running', stages_json: '{}', result_json: '{}', error: '' } },
  api_configs: { table: 'api_configs', order: 'id ASC', fields: ['name', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens'], defaults: { base_url: 'https://api.deepseek.com', api_key: '', model: MODELS.fast, temperature: 0.8, max_tokens: 4096 } }
};

const NUMERIC_FIELDS = new Set([
  'work_id', 'volume_id', 'plotline_id', 'parent_id', 'category_id',
  'from_character_id', 'to_character_id', 'character_id', 'position',
  'is_pinned', 'priority', 'temperature', 'max_tokens',
  'default_chapter_words', 'total_chapters', 'target_words'
]);

function getList(resource, where) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  const keys = Object.keys(where);
  const sql = keys.length
    ? `SELECT * FROM ${cfg.table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')} ORDER BY ${cfg.order}`
    : `SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`;
  return prepare(sql).all(...keys.map((k) => where[k]));
}

function coerceValue(resource, field, value) {
  if (value !== undefined && value !== null) return value;
  const defaults = RESOURCE_CONFIG[resource]?.defaults || {};
  return field in defaults ? defaults[field] : null;
}

function normalizeValue(resource, field, value) {
  let v = coerceValue(resource, field, value);
  if (resource === 'api_configs' && field === 'model') {
    v = normalizeModel(v);
  }
  if (NUMERIC_FIELDS.has(field)) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

// 跨作品引用一致性校验：引用 id 必须存在且与目标 work_id 同作品，防止把 A 作品的数据写进 B 作品。
function validateOwnership(resource, data) {
  const wid = Number(data.work_id) || null;
  const check = (table, id, label) => {
    if (id === undefined || id === null || id === '') return;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return;
    const row = prepare(`SELECT work_id FROM ${table} WHERE id = ?`).get(nid);
    if (!row) throw new Error(`${label}不存在`);
    if (wid !== null && Number(row.work_id) !== wid) throw new Error(`${label}不属于该作品`);
  };
  if (resource === 'chapters') {
    check('volumes', data.volume_id, '卷');
    check('plotlines', data.plotline_id, '剧情线');
    check('chapters', data.parent_id, '父章节');
  } else if (resource === 'plotline_characters') {
    check('plotlines', data.plotline_id, '剧情线');
    check('characters', data.character_id, '角色');
  } else if (resource === 'relations') {
    check('characters', data.from_character_id, '角色A');
    check('characters', data.to_character_id, '角色B');
  } else if (resource === 'terms') {
    check('categories', data.category_id, '分类');
  }
}

// API Key 掩码：本地单用户应用虽受 CORS 保护，仍只向界面回显首尾片段，避免明文全量暴露。
function maskApiKey(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function insertRow(resource, data) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  // D4：作品名称必填（后端兜底，前端同样拦截）
  if (resource === 'works' && !String(data.title ?? '').trim()) {
    throw new Error('作品名称不能为空');
  }
  validateOwnership(resource, data);
  const values = cfg.fields.map((f) => normalizeValue(resource, f, data[f]));
  const sql = `INSERT INTO ${cfg.table} (${cfg.fields.join(',')}) VALUES (${cfg.fields.map(() => '?').join(',')})`;
  const info = prepare(sql).run(...values);
  return Number(info.lastInsertRowid);
}

function updateRow(resource, id, data) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  // D4：编辑作品时也不允许把标题清空
  if (resource === 'works' && data.title !== undefined && !String(data.title ?? '').trim()) {
    throw new Error('作品名称不能为空');
  }
  const present = cfg.fields.filter((f) => data[f] !== undefined);
  // api_configs 的 api_key 传 null 表示「不修改」（掩码回显场景：用户未改动 key 时前端传 null）。
  if (resource === 'api_configs' && data.api_key === null) {
    const idx = present.indexOf('api_key');
    if (idx >= 0) present.splice(idx, 1);
  }
  if (present.length === 0) return 0;
  const isWorkless = resource === 'works' || resource === 'api_configs';
  const existing = isWorkless
    ? prepare(`SELECT id FROM ${cfg.table} WHERE id = ?`).get(id)
    : prepare(`SELECT work_id FROM ${cfg.table} WHERE id = ?`).get(id);
  if (!existing) return 0;
  const baseWorkId = data.work_id !== undefined
    ? Number(data.work_id) || null
    : (isWorkless ? null : Number(existing.work_id) || null);
  validateOwnership(resource, { ...data, work_id: baseWorkId });
  // P1-01：章节通用 PUT 同时推进 updated_at，使前端 _if_updated_at 乐观锁的锁值随每次保存前进；
  // 否则锁基准值永远相等，双窗口并发保存会静默覆盖（后写覆盖先写）而不是触发 409。
  const touchUpdatedAt = resource === 'chapters';
  const sql = `UPDATE ${cfg.table} SET ${present.map((f) => `${f} = ?`).join(', ')}${touchUpdatedAt ? ', updated_at = ?' : ''} WHERE id = ?`;
  const info = prepare(sql).run(
    ...present.map((f) => normalizeValue(resource, f, data[f])),
    ...(touchUpdatedAt ? [now()] : []),
    id
  );
  return Number(info.changes);
}

function deleteRow(resource, id) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return false;
  const info = prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
  return Number(info.changes) > 0;
}

// ---------- search ----------
// 多关键词检索：全部关键词 AND 匹配；标题/名称命中权重最高（×3），标签/身份次之（×2），
// 内容命中兜底；按得分排序取前 20，片段围绕最早命中的关键词截取。
function search(q, workId) {
  const empty = { terms: [], chapters: [], characters: [], plotlines: [], world_entries: [], relations: [] };
  if (!q) return empty;
  const keywords = String(q).toLowerCase().split(/\s+/).map((k) => k.trim()).filter(Boolean).slice(0, 5);
  if (!keywords.length) return empty;

  const queryRows = (table, fields, extra = '') => {
    const conds = keywords.map((k) => `(${fields.map((f) => `${f} LIKE ?`).join(' OR ')})`).join(' AND ');
    const params = keywords.flatMap((k) => fields.map(() => `%${k}%`));
    if (workId) params.push(workId);
    const sql = `SELECT * FROM ${table} WHERE ${conds}${workId ? ` AND work_id = ?` : ''}${extra} LIMIT 200`;
    return prepare(sql).all(...params);
  };

  // 字段权重：名称/标题 ×3，标签/身份 ×2，其它 ×1；全词相等 > 前缀 > 包含。
  const scoreRow = (row, fields) => {
    let score = 0;
    for (const k of keywords) {
      for (const f of fields) {
        const v = String(row[f] || '').toLowerCase();
        if (!v) continue;
        if (v === k) score += 100 * (f === fields[0] ? 3 : 1);
        else if (v.startsWith(k)) score += 50 * (f === fields[0] ? 3 : 1);
        else if (v.includes(k)) score += 10 * (f === fields[0] ? 3 : 1);
      }
    }
    return score;
  };

  // 在纯文本里找所有关键词中最早出现的位置，围绕它截片段（多关键词时能定位到最相关的词）。
  const snippetAny = (text, fallback = '') => {
    const plain = plainText(text);
    if (!plain) return fallback ? plainText(fallback).slice(0, 60) : '';
    let best = -1; let bestLen = 0;
    for (const k of keywords) {
      const idx = plain.toLowerCase().indexOf(k);
      if (idx >= 0 && (best < 0 || idx < best)) { best = idx; bestLen = k.length; }
    }
    if (best < 0) return plain.slice(0, 60);
    const start = Math.max(0, best - 30);
    const len = Math.min(80, Math.max(30, bestLen + 40));
    return (start > 0 ? '…' : '') + plain.slice(start, start + len) + (start + len < plain.length ? '…' : '');
  };

  const rank = (rows, fields, sortKey) => rows
    .map((r) => ({ row: r, score: scoreRow(r, fields) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row[sortKey] || '').localeCompare(String(b.row[sortKey] || ''), 'zh'))
    .slice(0, 20)
    .map((x) => x.row);

  const terms = rank(
    queryRows('terms', ['title', 'tags', 'substr(content,1,2000)']).map((t) => ({ ...t, type: 'term' })),
    ['title', 'tags', 'content'], 'title'
  ).map((t) => ({ ...t, snippet: snippetAny(t.content) }));

  const chapters = rank(
    queryRows('chapters', ['title', 'summary', 'substr(content,1,4000)', 'substr(blueprint_json,1,3000)']).map((c) => ({ ...c, type: 'chapter' })),
    ['title', 'summary', 'content', 'blueprint_json'], 'title'
  ).map((c) => ({ ...c, snippet: snippetAny(c.content, c.summary) }));

  const characters = rank(
    queryRows('characters', ['name', 'identity', 'personality', 'background', 'status']).map((c) => ({ ...c, type: 'character' })),
    ['name', 'identity', 'personality', 'background', 'status'], 'name'
  );

  const plotlines = rank(
    queryRows('plotlines', ['title', 'summary']).map((p) => ({ ...p, type: 'plotline' })),
    ['title', 'summary'], 'title'
  ).map((p) => ({ ...p, snippet: snippetAny(p.summary) }));

  // P3：人物关系此前不在检索范围内——而「人物关系」层会把描述截到 160 字，裁掉却查不回。
  // 关系行只存角色 id，这里补上双方姓名，检索结果才对模型可读。
  const charNames = new Map();
  if (workId) {
    for (const c of prepare('SELECT id, name FROM characters WHERE work_id = ?').all(workId)) charNames.set(c.id, c.name);
  }
  const relations = rank(
    queryRows('character_relations', ['relation', 'substr(description,1,2000)']).map((r) => ({
      ...r, type: 'relation',
      from_name: charNames.get(r.from_character_id) || `#${r.from_character_id}`,
      to_name: charNames.get(r.to_character_id) || `#${r.to_character_id}`
    })),
    ['relation', 'description'], 'relation'
  ).map((r) => ({ ...r, snippet: snippetAny(r.description) }));

  // P3：世界观词条此前**不在检索范围内**——而「激活的世界观设定」层是单次被裁最多的层
  // （压力数据实测单次裁掉 15,359 字）。裁剪掉却查不回，直接违反契约 I4。
  const worldEntries = rank(
    queryRows('world_entries', ['title', 'keywords', 'substr(content,1,2000)']).map((w) => ({ ...w, type: 'world_entry' })),
    ['title', 'keywords', 'content'], 'title'
  ).map((w) => ({ ...w, snippet: snippetAny(w.content) }));

  return { terms, chapters, characters, plotlines, world_entries: worldEntries, relations };
}

// 🐞 运行追踪：给关键词检索加函数级节点（耗时归因到具体函数，而不是只看 SQL 层）。
search = traceFn('search（关键词检索）', search, { kind: 'db', slowMs: 200 });

// ---------- AI ----------
function chatCompletionsUrl(baseUrl) {
  let base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  // 归一化：剥离可能存在的 /v1 与 /chat/completions 尾缀，再统一加回，保证拼接幂等，
  // 避免「base 以 /chat/completions 结尾时回退得到 .../chat/completions/v1/chat/completions」这类畸形地址。
  base = base.replace(/(\/v1)?\/chat\/completions$/i, '').replace(/\/v1$/i, '');
  return `${base}/chat/completions`;
}

// 模型名、已知模型表、思考强度白名单与归一化函数**全部来自 ai/policy.mjs**（P4 单点策略表）。
// 本文件不再自行定义这些取值——历史上它们在前端/后端/harness.js 各有一份，且注释与实现已经漂移。
// 这里保留同名局部绑定只是为了不动既有调用点；要改分工，改 policy.mjs。
const QUALITY_AI_MODEL = resolveModel('quality');
const DEEPSEEK_REASONING_EFFORTS = new Set(EFFORTS);
const normalizeReasoningEffort = normalizeEffort;

// 思考控制字段只有 DeepSeek 官方端点认。第三方 OpenAI 兼容服务可能因未知字段直接 400，
// 因此对自定义 base_url 不下发（模型名仍照常转发），避免把用户的第三方配置打挂。
function isDeepSeekEndpoint(baseUrl) {
  try {
    const host = new URL(String(baseUrl || 'https://api.deepseek.com')).hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch (_) {
    return false;
  }
}

// 把归一化后的强度翻译成 OpenAI 格式请求体。注意设置层与线上格式取值不同：
// 强度用 reasoning_effort（low/high/max），关闭思考用 thinking.type=disabled
// —— `off` 并不是合法的 reasoning_effort 值（依据：DeepSeek API 文档《思考模式》）。
// 思考模式默认开启且 effort 默认 high，因此不传即为默认强度。
function applyReasoningEffort(body, effort) {
  if (effort === 'off') body.thinking = { type: 'disabled' };
  else if (effort) body.reasoning_effort = effort;
  return body;
}

// DeepSeek V4 API 当前允许的最大输出 token 数；用于把“无上限”映射到接口实际上限。
const MAX_OUTPUT_TOKENS = 393216;
// 思考模式 + 大 max_tokens 可能耗时较长，放宽请求超时避免中途 abort。
const AI_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

// 调用 OpenAI 兼容的 Chat Completions 接口，带超时与 URL 自动回退。
async function callAI(config, messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('AI 请求缺少 messages 数组');
  }
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      throw new Error('messages 格式错误：每个消息必须包含 role 和 content');
    }
  }
  const base = String(config.base_url || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const rawMaxTokens = options.max_tokens ?? config.max_tokens ?? 4096;
  const maxTokens = Number.isFinite(Number(rawMaxTokens))
    ? Math.min(Math.max(1, Math.floor(Number(rawMaxTokens))), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  const body = {
    model: normalizeModel(config.model || MODELS.fast),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.8,
    max_tokens: maxTokens,
    stream: false
  };
  // 按需下发思考强度；未指定时沿 DeepSeek 默认（开启，effort=high）。
  const effort = normalizeReasoningEffort(options.reasoning_effort);
  if (effort && isDeepSeekEndpoint(config.base_url)) applyReasoningEffort(body, effort);

  const doPost = async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!resp.ok) {
        const detail = data?.error?.message || data?.message || `AI request failed (${resp.status})`;
        const err = new Error(`${detail}（接口：${url}）`);
        err.status = resp.status;
        err.detail = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  };

  const primary = chatCompletionsUrl(base);
  let okModel = body.model;
  const doPostTraced = async (url) => {
    // ⚠️ t0 必须用 traceNow()（追踪专用单调时钟）。曾经这里写 Date.now()，
    // 与 debug-trace 的 hrtime 基准相减得到 -1.787e12ms 的负数耗时。
    const t0 = traceNow();
    try {
      const data = await doPost(url);
      // Token 采集：之前只取 content，provider 返回的 usage 被整个丢弃；
      // 这里把它挂到运行追踪的 AI 节点上（直连通道是唯一能拿到 usage 的通道）。
      okModel = data?.model || okModel;
      traceAI('callAI', {
        t0, usage: data?.usage || null, model: okModel, endpoint: url, stream: false,
        messageStats: messages.map((m) => ({ role: m.role, chars: typeof m.content === 'string' ? m.content.length : 0 })),
        result: data?.choices?.[0]?.message?.content ?? data
      });
      return data;
    } catch (e) {
      traceAI('callAI', { t0, usage: null, model: okModel, endpoint: url, stream: false, status: 'error', error: e });
      throw e;
    }
  };
  try {
    return await doPostTraced(primary);
  } catch (e) {
    // 归一化出另一种路径形态：/v1/chat/completions ↔ /chat/completions
    const alt = /\/v1\/chat\/completions$/i.test(primary)
      ? primary.replace(/\/v1\/chat\/completions$/i, '/chat/completions')
      : primary.replace(/\/chat\/completions$/i, '/v1/chat/completions');
    if (alt === primary) throw e;
    const looksLikeUrlIssue = e.status === 404 || e.status === 405 || /missing required messages|missing.*messages|缺少\s*messages|not found|invalid url/i.test(e.message || '');
    if (!looksLikeUrlIssue) throw e;
    traceEvent('note', 'callAI URL 回退重试', { code: { file: 'server.js', line: null, func: 'callAI' } });
    return doPostTraced(alt);
  }
}

// 流式调用 OpenAI 兼容 Chat Completions（SSE）：边生成边回调 onDelta(delta, fullText)。
// 返回完整拼接文本；与 callAI 共用 URL 形态回退；客户端断开由调用方通过 options.signal 中止。
async function callAIStream(config, messages, options = {}, onDelta) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('AI 请求缺少 messages 数组');
  }
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      throw new Error('messages 格式错误：每个消息必须包含 role 和 content');
    }
  }
  const base = String(config.base_url || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const rawMaxTokens = options.max_tokens ?? config.max_tokens ?? 4096;
  const maxTokens = Number.isFinite(Number(rawMaxTokens))
    ? Math.min(Math.max(1, Math.floor(Number(rawMaxTokens))), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  const body = {
    model: normalizeModel(config.model || MODELS.fast),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.8,
    max_tokens: maxTokens,
    stream: true,
    // Token 采集：OpenAI 兼容的流式接口默认不回 usage，需要显式索取（最后一个 chunk 带 usage、choices 为空）。
    // 只对官方 DeepSeek 端点下发，避免第三方兼容网关因未知字段拒绝整个写作请求。
    ...(isDeepSeekEndpoint(config.base_url) ? { stream_options: { include_usage: true } } : {})
  };
  // 流式成文是质量最敏感的路径，同样按需下发思考强度。
  const effort = normalizeReasoningEffort(options.reasoning_effort);
  if (effort && isDeepSeekEndpoint(config.base_url)) applyReasoningEffort(body, effort);

  let streamUsage = null; // 流式最后一个 chunk 带回的 usage（Token 采集用）
  const streamModel = body.model;

  const doStream = async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (options.signal) options.signal.addEventListener('abort', onAbort);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        const detail = data?.error?.message || data?.message || `AI request failed (${resp.status})`;
        const err = new Error(`${detail}（接口：${url}）`);
        err.status = resp.status;
        err.detail = data;
        throw err;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            // Token 采集：流式的 usage 出现在最后一个 chunk（choices 为空），此前被整个丢弃。
            if (evt?.usage) streamUsage = evt.usage;
            const delta = evt?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              full += delta;
              if (typeof onDelta === 'function') onDelta(delta, full);
            }
          } catch { /* 忽略心跳/非 JSON 行 */ }
        }
      }
      return full;
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  };

  const primary = chatCompletionsUrl(base);
  const doStreamTraced = async (url) => {
    // 同 doPostTraced：追踪耗时基准只能取 traceNow()。
    const t0 = traceNow();
    try {
      const full = await doStream(url);
      traceAI('callAIStream', {
        t0, usage: streamUsage, model: streamModel, endpoint: url, stream: true,
        messageStats: messages.map((m) => ({ role: m.role, chars: typeof m.content === 'string' ? m.content.length : 0 })),
        result: full,
        usage_unavailable_reason: streamUsage ? null : 'provider 未回 usage（非官方 DeepSeek 端点或流式未带 usage chunk）'
      });
      return full;
    } catch (e) {
      traceAI('callAIStream', { t0, usage: null, model: streamModel, endpoint: url, stream: true, status: 'error', error: e });
      throw e;
    }
  };
  try {
    return await doStreamTraced(primary);
  } catch (e) {
    if (options.signal?.aborted) throw e; // 客户端主动断开：不做 URL 回退重试
    const alt = /\/v1\/chat\/completions$/i.test(primary)
      ? primary.replace(/\/v1\/chat\/completions$/i, '/chat/completions')
      : primary.replace(/\/chat\/completions$/i, '/v1/chat/completions');
    if (alt === primary) throw e;
    const looksLikeUrlIssue = e.status === 404 || e.status === 405 || /missing required messages|missing.*messages|缺少\s*messages|not found|invalid url/i.test(e.message || '');
    if (!looksLikeUrlIssue) throw e;
    return doStreamTraced(alt);
  }
}

// POST /api/ai/write_stream：SSE 流式直连成文（质量优先模式）。
// 边生成边下发 delta 事件，结束下发 done 事件（含全文 + 确定性红线扫描报告，与 harness 通道同源）。
// 客户端断开自动中止上游请求。
async function handleAIWriteStream(req, res, body, config) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return sendError(res, 400, '缺少 messages');
  if (body.model) config.model = normalizeModel(body.model);
  const workId = Number(body.work_id) || null;
  const upstream = new AbortController();
  const onClose = () => upstream.abort();
  res.on('close', onClose);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ }
  };
  try {
    let full = '';
    const text = await callAIStream(config, messages, {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort,
      signal: upstream.signal
    }, (delta, acc) => {
      full = acc;
      send({ delta });
    });
    let scan = null;
    if (body.scan !== false && workId) {
      const redlineRows = listRedlines(workId);
      const hits = scanAgainstRedlines(redlineRows, text);
      scan = { enabled: redlineRows.length > 0, total: hits.reduce((s, h) => s + h.count, 0), hits: hits.slice(0, 50) };
    }
    send({ done: true, text, scan });
  } catch (e) {
    if (upstream.signal.aborted) {
      log({ level: 'warn', layer: 'ai', kind: 'ai_stream_aborted', message: '流式直连已被客户端中止' });
    } else {
      logAIError('write_stream', e, '/api/ai/write_stream');
      send({ error: readableErrorMessage(e) });
    }
  } finally {
    res.off('close', onClose);
    try { res.end(); } catch { /* 忽略 */ }
  }
}

function getConfigFromBody(body) {
  if (body.config_id !== undefined && body.config_id !== null && body.config_id !== '') {
    const id = Number(body.config_id);
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error('API 配置不存在或非法');
      err.status = 400;
      throw err;
    }
    const row = prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!row) {
      const err = new Error('API 配置不存在');
      err.status = 400;
      throw err;
    }
    return row;
  }
  return {
    base_url: body.base_url || 'https://api.deepseek.com',
    api_key: body.api_key || '',
    model: body.model || MODELS.fast,
    temperature: body.temperature ?? 0.8,
    max_tokens: body.max_tokens ?? 4096
  };
}

// ---------- AI error history ----------
// D3/D16：message 只保留一行可读错误（readableErrorMessage 见 logger.js，与 harness.js 共用）；
// 与统一日志库（app_logs）合并，30 分钟窗口内同 action + 同 message 去重。

function logAIError(action, error, endpoint = '') {
  log({
    level: 'error', layer: 'ai', kind: 'ai_error',
    message: readableErrorMessage(error),
    error,
    context: {
      action: action || 'unknown',
      endpoint: endpoint || '',
      error_code: String(error?.status || error?.detail?.error?.code || error?.code || '').slice(0, 200)
    },
    dedupMs: 30 * 60 * 1000
  });
}

function listAIErrors() {
  return prepare(`
    SELECT id, ts, message, stack, context
    FROM app_logs
    WHERE kind = 'ai_error'
    ORDER BY ts DESC, id DESC
    LIMIT 5
  `).all().map((row) => {
    let ctx = {};
    try { ctx = JSON.parse(row.context || '{}'); } catch (_) { /* 上下文损坏按空处理 */ }
    return {
      id: row.id,
      action: ctx.action || '',
      message: row.message,
      error_code: ctx.error_code || '',
      stack: row.stack,
      endpoint: ctx.endpoint || '',
      created_at: row.ts
    };
  });
}

// ---------- chapter manual save versions ----------
/**
 * @param {'manual'|'draft'} [kind] manual=手动保存/覆盖前备份的历史版本；draft=AI 生成稿草稿。
 *   草稿与历史版本同表但分区，列表与清理都按 kind 隔离，互不挤占。
 */
function saveChapterVersion(chapterId, title, summary, content, kind = 'manual') {
  const info = prepare(`
    INSERT INTO chapter_save_versions (chapter_id, title, summary, content, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chapterId, asString(title), asString(summary), asString(content), now(), kind === 'draft' ? 'draft' : 'manual');
  pruneChapterVersions(chapterId);
  return prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(Number(info.lastInsertRowid));
}

function listChapterVersions(chapterId) {
  return prepare(`
    SELECT id, chapter_id, title, summary, content, created_at
    FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'manual'
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all(chapterId);
}

/** 最近一份 AI 生成稿草稿（关闭结果弹窗后仍可取回）。 */
function getLatestDraft(chapterId) {
  const row = prepare(`
    SELECT id, chapter_id, title, content, created_at
    FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'draft'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(chapterId);
  if (!row) return null;
  return { ...row, chars: plainText(row.content).length };
}

function pruneChapterVersions(chapterId) {
  // 两个分区各自保留 10 份：草稿不能把历史版本挤掉，反之亦然。
  prepare(`
    DELETE FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'manual'
      AND id NOT IN (
        SELECT id FROM chapter_save_versions
        WHERE chapter_id = ? AND kind = 'manual'
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `).run(chapterId, chapterId);
  prepare(`
    DELETE FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'draft'
      AND id NOT IN (
        SELECT id FROM chapter_save_versions
        WHERE chapter_id = ? AND kind = 'draft'
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `).run(chapterId, chapterId);
}

// ---------- AI 上下文（角色卡 / 世界观 / 作者注） ----------
// 简单去掉 HTML 标签，用于关键词匹配。
// ---------- AI 效果埋点（P5） ----------
// 契约里的结构化不变量只能回答「预算有没有超、内容能不能查回」，
// 回答不了「**上下文质量到底有没有变好**」。后者只能靠作者的真实行为信号：
// 一次成文用不用得上（采纳率）、采纳前改了多少（编辑距离）、送进去多少字（上下文成本）。
// 这张表刻意只记行为与规模，不记正文内容——避免把作品文本复制进一张分析表。
function recordAIEval({ workId, chapterId, action, channel, model, charsIn, charsOut, ms, editDistance, draftKey } = {}) {
  try {
    prepare(`
      INSERT INTO ai_eval_events (work_id, chapter_id, action, channel, model, chars_in, chars_out, ms, edit_distance, draft_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(workId) || null,
      Number(chapterId) || null,
      asString(action, 'generate') || 'generate',
      asString(channel, ''),
      asString(model, ''),
      Math.max(0, Math.round(Number(charsIn) || 0)),
      Math.max(0, Math.round(Number(charsOut) || 0)),
      Math.max(0, Math.round(Number(ms) || 0)),
      Number.isFinite(Number(editDistance)) && editDistance !== null && editDistance !== '' ? Math.max(0, Math.round(Number(editDistance))) : null,
      asString(draftKey, ''),
      now()
    );
    return true;
  } catch (e) {
    // 埋点失败绝不能影响创作：只记一条日志。
    log({ level: 'warn', layer: 'ai', kind: 'eval_record_failed', message: `AI 埋点写入失败：${e.message}`, error: e, dedupMs: 60000 });
    return false;
  }
}

/**
 * 编辑距离的测量点：**作者改动章节后保存**时（PUT /api/chapters/:id）。
 *
 * 为什么不在采纳那一刻量：结果弹窗里的正文是只读预览（`ai-apply-preview`），
 * 采纳写回正文必然等于草稿 → 恒为 0、没有信息量。真正有信息量的是"作者接着改了多少"。
 *
 * 草稿文本不从埋点表取——埋点表刻意**不记正文内容**。草稿本来就在
 * `chapter_save_versions(kind='draft')` 里（生成时就落了库），这里直接读它。
 *
 * 配对规则（都是刻意的、可解释的近似）：
 *   - 取该章节**最近一条尚未测量**的 `adopt` 行；
 *   - 只与**不晚于该采纳**的最近一份草稿配对（避免配到下一次生成的草稿）；
 *   - 测一次就写回 `edit_distance`，之后再次保存不会重复测量。
 *
 * 失败一律静默（与埋点同一条纪律：分析指标绝不能影响创作）。
 *
 * @returns {{distance:number, method:string}|null}
 */
function measureAdoptEditDistance(chapterId, finalContent) {
  try {
    const cid = Number(chapterId);
    if (!cid) return null;
    const finalText = plainText(finalContent);
    if (!finalText) return null;

    const pending = prepare(`
      SELECT id, created_at FROM ai_eval_events
      WHERE chapter_id = ? AND action = 'adopt' AND edit_distance IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(cid);
    if (!pending) return null;

    const draft = prepare(`
      SELECT content, created_at FROM chapter_save_versions
      WHERE chapter_id = ? AND kind = 'draft' AND created_at <= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(cid, pending.created_at);
    if (!draft || !String(draft.content || '').trim()) return null;

    const draftText = plainText(draft.content);
    if (!draftText) return null;

    const { distance, method } = editDistance(draftText, finalText);
    prepare('UPDATE ai_eval_events SET edit_distance = ? WHERE id = ?').run(distance, pending.id);
    log({
      level: 'info', layer: 'ai', kind: 'edit_distance_measured',
      message: `编辑距离已测量：${distance} 字（${method}）`,
      context: { chapter_id: cid, eval_id: pending.id, draft_chars: draftText.length, final_chars: finalText.length, method }
    });
    return { distance, method };
  } catch (e) {
    log({ level: 'warn', layer: 'ai', kind: 'edit_distance_failed', message: `编辑距离测量失败：${e.message}`, error: e, dedupMs: 60000 });
    return null;
  }
}

/**
 * 删作品时连带清理它的 AI 埋点（决策 D6·C-①）。
 *
 * 为什么需要显式删：`ai_eval_events` 建表时 `work_id` / `chapter_id` 写的是裸 INTEGER，
 * 没有外键、也就没有级联——而库里其它二十余张作品域表全都是 `REFERENCES works(id) ON DELETE CASCADE`。
 * 于是删作品后埋点行会留下：任何作品视角都够不到，而**全局聚合**（`/api/ai/eval` 不带 work_id）
 * 会把它们算进采纳率与平均编辑距离 → 指标被已不存在的作品带偏，且表无界增长。
 *
 * SQLite 不支持给已有表补外键（`ALTER TABLE` 做不到），所以这里用显式 DELETE，
 * 与"重建表迁移"相比无需动 schema、可回滚。
 *
 * ⚠️ 调用时机：必须在 `deleteRow('works', id)` **之前**——章节随作品级联删除后，
 * `chapter_id IN (SELECT ... FROM chapters ...)` 就查不到任何东西了。
 *
 * @returns {number} 实际删掉的行数（失败静默返回 0：埋点清理绝不能挡住删作品）
 */
function purgeEvalEventsOfWork(workId) {
  try {
    const r = prepare(`
      DELETE FROM ai_eval_events
      WHERE work_id = ?
         OR chapter_id IN (SELECT id FROM chapters WHERE work_id = ?)
    `).run(workId, workId);
    const n = Number(r.changes) || 0;
    if (n) log({ level: 'info', layer: 'ai', kind: 'eval_purged', message: `删除作品时连带清理 AI 埋点 ${n} 行`, context: { work_id: workId } });
    return n;
  } catch (e) {
    log({ level: 'warn', layer: 'ai', kind: 'eval_purge_failed', message: `AI 埋点清理失败（已忽略，不影响删除）：${e.message}`, error: e, dedupMs: 60000 });
    return 0;
  }
}

function summarizeAIEval(workId) {
  const where = workId ? 'WHERE work_id = ?' : '';
  const args = workId ? [workId] : [];
  const agg = prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN action = 'generate' THEN 1 ELSE 0 END) AS generations,
      SUM(CASE WHEN action = 'adopt'    THEN 1 ELSE 0 END) AS adopts,
      SUM(CASE WHEN action = 'discard'  THEN 1 ELSE 0 END) AS discards,
      AVG(CASE WHEN action = 'generate' THEN chars_in  END) AS avg_chars_in,
      AVG(CASE WHEN action = 'generate' THEN chars_out END) AS avg_chars_out,
      AVG(CASE WHEN action = 'generate' THEN ms        END) AS avg_ms,
      AVG(CASE WHEN action = 'adopt'    THEN edit_distance END) AS avg_edit_distance
    FROM ai_eval_events ${where}
  `).get(...args);
  const generations = Number(agg.generations) || 0;
  const adopts = Number(agg.adopts) || 0;
  const round = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    work_id: workId || null,
    total: Number(agg.total) || 0,
    generations,
    adopts,
    discards: Number(agg.discards) || 0,
    // 采纳率 = 采纳次数 / 生成次数。null 表示样本不足，不要用 0 假装有结论。
    adoption_rate: generations ? Number((adopts / generations).toFixed(3)) : null,
    avg_chars_in: round(agg.avg_chars_in),
    avg_chars_out: round(agg.avg_chars_out),
    avg_ms: round(agg.avg_ms),
    avg_edit_distance: round(agg.avg_edit_distance),
    note: '采纳率与编辑距离用于横向比较上下文质量的改动；样本少时不要下结论。'
  };
}

function plainText(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 上下文装配热点优化：只取头部/尾部时，先按倍数截取原始 HTML 再剥标签，
// 避免整章全文转换浪费（HTML 标签膨胀约 2-3 倍，截取后剥标签即可）。
function plainTextHead(html = '', n = 3000) {
  const raw = String(html).slice(0, n * 3).replace(/<[^>]*$/, '');
  return plainText(raw).slice(0, n);
}

function plainTextTail(html = '', n = 1200) {
  const raw = String(html).slice(-(n * 3)).replace(/^[^<]*>/, '');
  return plainText(raw).slice(-n);
}

// 获取作品的长期记忆摘要。
function getStoryMemory(workId) {
  const row = prepare('SELECT summary FROM story_memories WHERE work_id = ?').get(workId);
  return row?.summary || '';
}

// 长期记忆超过该字数时标记 needs_compression，提示创作上下文里让 AI 优先压缩。
const MEMORY_COMPRESS_HINT = 1200;
// 每个作品最多保留的历史版本数：超出自动剪除最旧的，防止 memory_versions 无限膨胀。
const MEMORY_VERSION_KEEP = 200;

// 保存作品的长期记忆摘要（git 式：每次变更自动写入 memory_versions 快照，可回滚）。
// 兼容旧调用 saveStoryMemory(workId, summary)；新调用可传 { source, note }。
function saveStoryMemory(workId, summary, opts = {}) {
  summary = asString(summary);
  const prev = getStoryMemory(workId);
  if (prev === summary && summary !== '') {
    return { unchanged: true, work_id: workId, summary };
  }
  const source = asString(opts.source, 'manual') || 'manual';
  const note = asString(opts.note, '');
  const tx = opts.tx === true;
  if (!tx) db.exec('BEGIN');
  try {
    prepare(`
      INSERT INTO story_memories (work_id, summary, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
    `).run(workId, summary, now());
    const info = prepare(`
      INSERT INTO memory_versions (work_id, summary, source, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workId, summary, source, note, now());
    // 版本保留策略：只留最近 MEMORY_VERSION_KEEP 个，最旧的多余版本剪除。
    prepare(`
      DELETE FROM memory_versions
      WHERE work_id = ? AND id NOT IN (
        SELECT id FROM memory_versions WHERE work_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(workId, workId, MEMORY_VERSION_KEEP);
    if (!tx) db.exec('COMMIT');
    if (!tx) touchWork(workId);
    return {
      ok: true, work_id: workId, summary, version_id: Number(info.lastInsertRowid), source,
      needs_compression: summary.length > MEMORY_COMPRESS_HINT
    };
  } catch (e) {
    if (!tx) db.exec('ROLLBACK');
    throw e;
  }
}

// 自动压缩作品内容为长期记忆摘要。
async function compressStoryMemory(workId) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new Error('作品不存在');

  // 只取每章正文头部，避免大作品一次性拉取数十 MB 正文再丢弃。
  const chapters = prepare('SELECT title, summary, substr(content, 1, 1500) AS content FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const characters = prepare('SELECT name, identity, personality, status FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const worlds = prepare('SELECT title, content FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);

  const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainTextHead(c.content, 500)}`).join('\n');
  const characterText = characters.map((c) => `【${c.name}】${c.identity || ''} ${c.personality || ''} ${c.status || ''}`).join('\n');
  const worldText = worlds.map((w) => `【${w.title}】${w.content}`).join('\n');

  const prompt = `你是一位小说长期记忆压缩器。请根据以下作品内容，生成一段不超过 800 字的中文长期记忆摘要，记录已经发生的重要剧情、伏笔、角色当前状态、世界设定关键信息，方便后续 AI 写作保持一致。\n\n作品名：${work.title}\n简介：${work.description}\n\n章节：\n${chapterText.slice(0, 6000)}\n\n角色：\n${characterText.slice(0, 3000)}\n\n世界观：\n${worldText.slice(0, 3000)}\n\n请只输出压缩后的记忆摘要。`;

  // 记忆压缩是「读得多、写得少」的摘要任务。
  // 模型用 QUALITY_AI_MODEL：产出的长期记忆会喂给之后**每一章**的上下文，质量影响是累积的，
  // 按用户「质量优先」基线不在这里省（2026-09-13 用户决定由 flash 改回 pro）。
  // 思考强度仍刻意不指定：沿用 ~/.dsh/settings.yaml 的全局设置，避免单方面调低。
  const output = await runHarnessTask(prompt, { timeout: 10 * 60 * 1000, model: QUALITY_AI_MODEL });
  saveStoryMemory(workId, output, { source: 'compress' });
  return output;
}

// 🐞 运行追踪：长期记忆压缩是长任务（内含 AI 调用），单独成节点便于归因耗时。
compressStoryMemory = traceFn('compressStoryMemory（压缩长期记忆）', compressStoryMemory, { kind: 'fn', slowMs: 3000 });

// ---------- 出场角色选择（评分制 · v0.8.0） ----------
// 解决旧实现的三个遗漏源：①兜底只取“按名字前 8”与剧情无关；②名字子串误命中、漏别名；
// ③新章节正文为空时只能靠标题/摘要碰运气。评分维度：剧情线关联 > 正文/摘要命中次数 >
// 蓝图·作者注·最近事件提及 > 最近章节摘要出场 > 人物关系网；兜底改为“最近出场优先”。
const SCENE_CHAR_CAP = 16;        // 出场角色卡数量上限
const SCENE_FALLBACK_COUNT = 8;   // 无命中信号时的兜底数量（最近出场优先，其次名字序）

// 名称出现次数统计：多字名称直接计数；单字 CJK 名称要求左右邻居不是 CJK 字符，
// 避免“云”命中“云彩/李云”这类子串误命中。别名与正式名同样处理。
function countNameHits(name, corpus) {
  const n = String(name || '');
  if (!n) return 0;
  const lower = n.toLowerCase();
  let count = 0;
  let idx = corpus.indexOf(lower);
  if (n.length >= 2) {
    while (idx !== -1) { count += 1; idx = corpus.indexOf(lower, idx + lower.length); }
    return count;
  }
  const isCJK = (ch) => /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch);
  while (idx !== -1) {
    const before = idx > 0 ? corpus[idx - 1] : '';
    const after = idx + 1 < corpus.length ? corpus[idx + 1] : '';
    if (!(isCJK(before) || isCJK(after))) count += 1;
    idx = corpus.indexOf(lower, idx + 1);
  }
  return count;
}

function namesOfCharacter(c) {
  return [c.name, ...String(c.aliases || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)];
}

// 评分制选择出场角色：返回 { sceneCharacters（按得分降序，含兜底）, scores: Map }。
// opts：{ plotlineId, corpus, extraTexts, recentSummaries }
function selectSceneCharacters(workId, opts = {}) {
  const all = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const scores = new Map();
  const add = (id, pts) => scores.set(id, (scores.get(id) || 0) + pts);
  const hitsOf = (c, text) => namesOfCharacter(c).reduce((sum, nm) => sum + countNameHits(nm, text), 0);

  // 1) 剧情线关联（最强信号）
  if (opts.plotlineId) {
    const rows = prepare('SELECT character_id FROM plotline_characters WHERE plotline_id = ? ORDER BY id ASC').all(opts.plotlineId);
    rows.forEach((r) => add(Number(r.character_id), 100));
  }
  // 1b) 作者在「上下文预览」面板手动强制带入的角色（章节级覆盖，最高优先）
  for (const id of opts.forceIds || []) add(Number(id), 1000);

  const corpus = String(opts.corpus || '').toLowerCase();
  const extraCorpus = String((opts.extraTexts || []).join(' ')).toLowerCase();
  const recentCorpus = String((opts.recentSummaries || []).join(' ')).toLowerCase();

  for (const c of all) {
    // 2) 正文/摘要命中：每命中 +12，封顶 60
    const mainHits = hitsOf(c, corpus);
    if (mainHits > 0) add(c.id, Math.min(mainHits * 12, 60));
    // 3) 蓝图/作者注/最近事件提及：每命中 +10，封顶 40
    const extraHits = hitsOf(c, extraCorpus);
    if (extraHits > 0) add(c.id, Math.min(extraHits * 10, 40));
    // 4) 最近章节摘要出场：每章 +8，封顶 24
    const recentHits = hitsOf(c, recentCorpus);
    if (recentHits > 0) add(c.id, Math.min(recentHits * 8, 24));
  }

  // 5) 关系网：与已有信号角色（剧情线/正文命中/蓝图提及，≥10 分）有直接关系的角色 +5/条，封顶 20
  const signaled = new Set([...scores.keys()].filter((id) => (scores.get(id) || 0) >= 10));
  if (signaled.size) {
    const relations = prepare('SELECT from_character_id, to_character_id FROM character_relations WHERE work_id = ?').all(workId);
    const linkCount = new Map();
    for (const r of relations) {
      if (signaled.has(r.from_character_id) && !signaled.has(r.to_character_id)) {
        linkCount.set(r.to_character_id, (linkCount.get(r.to_character_id) || 0) + 1);
      }
      if (signaled.has(r.to_character_id) && !signaled.has(r.from_character_id)) {
        linkCount.set(r.from_character_id, (linkCount.get(r.from_character_id) || 0) + 1);
      }
    }
    for (const [id, n] of linkCount) add(id, Math.min(n * 5, 20));
  }

  const ranked = all
    .map((c) => ({ c, s: scores.get(c.id) || 0 }))
    .sort((a, b) => b.s - a.s || String(a.c.name).localeCompare(String(b.c.name), 'zh'));

  const chosen = ranked.filter((r) => r.s > 0);
  if (chosen.length < SCENE_FALLBACK_COUNT) {
    const rest = ranked.filter((r) => r.s <= 0);
    chosen.push(...rest.slice(0, SCENE_FALLBACK_COUNT - chosen.length));
  }
  return { sceneCharacters: chosen.slice(0, SCENE_CHAR_CAP).map((r) => r.c), scores };
}

// 出场角色卡构建：逐卡截断、核心字段保底，避免“整层头部盲截”把靠后的角色整卡切掉。
// 长字段（背景/对话示例/系统提示/外貌/标签）分级压缩；即使预算耗尽，每张卡的名字/
// 身份/性格/当前状态核心信息必保。
// ⚠️ `cap` 刻意**不给默认值**：它的单点在 `layers.mjs` 的 `entityCap`，
// 调用方一律用 `entityCapOfId('characters')` 取值。早先这里写着 `cap = 4000`，
// 与调用处的 `4000`、规格里的 `entityCap: 4000` 构成三份拷贝。
function buildCharacterCards(chars, cap) {
  if (!Number.isFinite(cap)) throw new Error('buildCharacterCards 需要显式的实体上限（见 layers.mjs 的 entityCapOfId）');
  const FIELD_LABELS = [
    ['background', '背景', [500, 300, 150, 80, 0]],
    ['mes_example', '对话示例（学习其口吻）', [400, 200, 100, 0]],
    ['system_prompt', '角色系统提示', [400, 200, 100, 0]],
    ['appearance', '外貌', [400, 200, 100, 0]],
    ['tags', '标签', [200, 100, 0]]
  ];
  const coreOf = (c) => [
    `【${c.name}】`,
    c.identity ? `身份：${c.identity}` : '',
    c.personality ? `性格：${c.personality}` : '',
    c.status ? `当前状态：${c.status}` : ''
  ].filter(Boolean).join('\n');
  const cardOf = (c, level) => {
    const parts = [coreOf(c)];
    for (const [field, label, limits] of FIELD_LABELS) {
      const lim = limits[Math.min(level, limits.length - 1)];
      const v = String(c[field] || '').trim();
      if (lim > 0 && v) parts.push(`${label}：${v.slice(0, lim)}`);
    }
    return parts.join('\n');
  };
  const maxLevel = Math.max(...FIELD_LABELS.map(([, , limits]) => limits.length)) - 1;
  let level = 0;
  let text = chars.map((c) => cardOf(c, 0)).join('\n\n');
  while (text.length > cap && level < maxLevel) {
    level += 1;
    text = chars.map((c) => cardOf(c, level)).join('\n\n');
  }
  // 极端兜底：所有长字段已丢弃仍超限时，逐卡按均分预算截断（核心信息尽量保留）。
  if (text.length > cap && chars.length) {
    const per = Math.max(160, Math.floor(cap / chars.length));
    text = chars.map((c) => cardOf(c, maxLevel).slice(0, per)).join('\n\n');
  }
  return level > 0 ? `${text}\n…（角色卡层超预算：长字段已分级压缩，每张卡核心信息完整）` : text;
}

// 世界观词条统一筛选：固定(pinned)优先 + 关键词命中，按 priority 降序限量 30。
// buildAIContext（UI 预览）与 buildNovelContext（创作内核）共用，避免两套规则分叉。
function pickWorldEntries(workId, corpus) {
  const rows = prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY is_pinned DESC, priority DESC, position ASC, id ASC').all(workId);
  const out = [];
  for (const entry of rows) {
    if (out.length >= 30) break;
    const pinned = Number(entry.is_pinned) === 1;
    let matched = pinned;
    if (!matched) {
      const keywords = String(entry.keywords || '').split(/[,，、\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      matched = keywords.some((k) => corpus.includes(k));
    }
    if (matched) out.push(entry);
  }
  return out;
}

// 根据章节自动组装 AI 上下文：相关角色卡、激活的世界观词条、作者注。
function buildAIContext(chapterId) {
  const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!chapter) return null;
  const work = prepare('SELECT * FROM works WHERE id = ?').get(chapter.work_id);
  if (!work) return null;

  const allChap = prepare('SELECT id, title, summary, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(work.id);
  const pos = allChap.findIndex((c) => c.id === chapter.id);
  const prevChapRow = pos > 0 ? allChap[pos - 1] : null;

  // 固定词条始终激活；关键词词条在标题/摘要/正文中匹配到关键词时激活。
  const corpus = [chapter.title, chapter.summary, plainTextHead(chapter.content, 3000), work.description].join(' ').toLowerCase();

  // 出场角色：评分制选择（剧情线关联 > 正文/摘要命中 > 蓝图/作者注/最近事件 > 最近章节摘要 > 关系网），
  // 兜底为“最近出场优先”，不再“按名字前 8”；新章节正文为空时蓝图/作者注里的角色也能命中。
  let blueprint = null;
  try { blueprint = JSON.parse(chapter.blueprint_json || '{}'); } catch (_) { blueprint = null; }
  const recentEvents = listStoryEvents(work.id, 12);
  // 未闭合伏笔：与创作内核（buildNovelContext）同源——kind=foreshadow 且未 resolved/dropped；
  // 直连成文不再有 novel_consistency 工具兜底，必须内联进 AI 上下文（质量优先模式）。
  const openForeshadows = listStoryEvents(work.id, 200)
    .filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped')
    .slice(0, 20);
  const forcedIds = String(chapter.context_character_ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const { sceneCharacters: characters } = selectSceneCharacters(work.id, {
    plotlineId: chapter.plotline_id,
    corpus,
    forceIds: forcedIds,
    extraTexts: [chapter.author_note, work.author_note, JSON.stringify(blueprint || {}), recentEvents.map((e) => e.summary).join(' ')],
    recentSummaries: [...allChap.slice(Math.max(0, pos - 3), pos).map((c) => c.summary || ''), chapter.summary || '']
  });

  const worldEntries = pickWorldEntries(work.id, corpus);

  const charNames = characters.map((c) => c.name).join('、');
  const replaceVars = (text = '') => String(text)
    .replace(/\{title\}/g, chapter.title || '')
    .replace(/\{work\}/g, work.title || '')
    .replace(/\{characters\}/g, charNames)
    .replace(/\{summary\}/g, chapter.summary || '');

  // 创作内核增强：前文衔接尾巴、最近事件、写作红线（供提示词注入/界面预览）
  let storyTail = '';
  if (prevChapRow) {
    const pc = prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapRow.id);
    if (pc) storyTail = plainTextTail(pc.content || '', 1200);
  }
  if (!storyTail) storyTail = plainTextTail(chapter.content || '', 1200);
  const redlineRows = listRedlines(work.id);
  const targetWords = (Number(chapter.target_words) > 0 ? Number(chapter.target_words) : 0)
    || Number(work.default_chapter_words) || 2000;

  return {
    _chapter: chapter, // 内部字段：供 /api/ai_context 复用原始章节行做语义召回，返回前删除
    work: {
      id: work.id, title: work.title,
      default_chapter_words: Number(work.default_chapter_words) || 2000,
      total_chapters: Number(work.total_chapters) || 0,
      story_structure: work.story_structure || '',
      narrative_pov: work.narrative_pov || '',
      style_positive: work.style_positive || ''
    },
    chapter: { id: chapter.id, title: chapter.title, summary: chapter.summary, blueprint, target_words: targetWords },
    prev_chapter: prevChapRow ? { id: prevChapRow.id, title: prevChapRow.title } : null,
    characters,
    world_entries: worldEntries,
    story_memory: getStoryMemory(work.id),
    story_tail: storyTail,
    recent_events: recentEvents.map((e) => ({ kind: e.kind, summary: e.summary, chapter_id: e.chapter_id, created_at: e.created_at })),
    open_foreshadows: openForeshadows.map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id, resolves_event_id: e.resolves_event_id })),
    redlines: redlineRows.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note, exceptions: Array.isArray(r.exceptions) ? r.exceptions : [] })),
    style_contract: renderStyleContract(redlineRows, work.style_positive || ''),
    work_author_note: replaceVars(work.author_note || ''),
    chapter_author_note: replaceVars(chapter.author_note || '')
  };
}

// 🐞 运行追踪：出场角色选择与 UI 预览版上下文装配的函数级节点。
// 这两处是「AI 到底带了什么进上下文」的关键路径，耗时与规模都值得单独看。
selectSceneCharacters = traceFn('selectSceneCharacters（选出场角色）', selectSceneCharacters, { kind: 'fn', slowMs: 200 });
buildAIContext = traceFn('buildAIContext（UI 预览上下文）', buildAIContext, { kind: 'fn', slowMs: 300 });

// ---------- 创作内核：写作红线 / 事件账本 / 记忆版本 / 场景上下文 ----------
// 供 dsh 创作插件与后续 UI 调用；生成前取上下文、生成后扫描红线、落事件与记忆快照。

const DEFAULT_REDLINES = [
  { kind: 'word', pattern: '微微', note: 'AI 高频微动作词，尤其“微微一愣/微微一笑”连击，慎用' },
  { kind: 'word', pattern: '缓缓', note: '慢动作万能前缀，易显拖沓' },
  { kind: 'word', pattern: '不禁', note: '典型 AI 腔触发词，慎用' },
  { kind: 'word', pattern: '仿佛', note: '比喻万能引子，一个段落内至多一次' },
  { kind: 'word', pattern: '眸', note: '眸/眼眸/眼底堆砌是 AI 腔重灾区' },
  { kind: 'word', pattern: '嘴角', note: '嘴角微表情模板（勾起/上扬/弧度）' },
  { kind: 'word', pattern: '一抹', note: '“一抹 X”万能量词（神色/笑意/弧度）' },
  { kind: 'word', pattern: '不由得', note: 'AI 腔触发词，慎用' },
  { kind: 'word', pattern: '心中一动', note: '情绪套话' },
  { kind: 'word', pattern: '心念电转', note: '情绪套话' },
  { kind: 'word', pattern: '波澜不惊', note: '装逼套话' },
  { kind: 'word', pattern: '深不可测', note: '装逼套话' },
  { kind: 'word', pattern: '不怒自威', note: '装逼套话' },
  { kind: 'word', pattern: '眼神一凝', note: '反应套话' },
  { kind: 'word', pattern: '沉声道', note: '对话标签套话，改用动作/语气代替' },
  { kind: 'word', pattern: '冷冷道', note: '对话标签套话' },
  { kind: 'word', pattern: '冷哼一声', note: '高频反应模板' },
  { kind: 'word', pattern: '空气仿佛凝固', note: '场景停顿模板句' },
  { kind: 'word', pattern: '时间仿佛静止', note: '场景停顿模板句' },
  { kind: 'phrase', pattern: '眼中闪过', note: '“眼中闪过+神色”万能反应句' },
  { kind: 'phrase', pattern: '眼底掠过', note: '同上' },
  { kind: 'phrase', pattern: '脸上浮现', note: '表情万能句' },
  { kind: 'phrase', pattern: '嘴角勾起一抹', note: '笑容模板句' },
  { kind: 'phrase', pattern: '在这一刻', note: '时间放大模板，慎用' },
  { kind: 'phrase', pattern: '一股强大的气势', note: '气势万能句' },
  { kind: 'phrase', pattern: '一股恐怖的', note: '威压模板' },
  { kind: 'regex', pattern: '(?:眼中|眼底|眸中).{0,8}(?:闪过|掠过|闪过一丝)', note: '“眼中闪过 X”家族' },
  { kind: 'regex', pattern: '浑身一震', note: '“X 浑身一震”型反应模板' }
];

const VALID_REDLINE_KINDS = new Set(['word', 'phrase', 'regex']);

// 首次启动时写入默认红线（work_id 为空 = 全局默认）。
function seedRedlinesIfEmpty() {
  // 用 app_settings 标志判断是否已初始化，而非「全局红线计数为 0」：
  // 用户清空默认红线是合法操作，不应在下次启动被重新灌入。
  if (getAppSettingDb('redlines_seeded', '') === '1') return;
  const row = prepare('SELECT COUNT(*) AS c FROM writing_redlines WHERE work_id IS NULL').get();
  if (Number(row.c) > 0) { setAppSettingDb('redlines_seeded', '1'); return; }
  db.exec('BEGIN');
  try {
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note) VALUES (NULL, ?, ?, ?)');
    for (const r of DEFAULT_REDLINES) stmt.run(r.kind, r.pattern, r.note || '');
    db.exec('COMMIT');
    setAppSettingDb('redlines_seeded', '1');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 读取红线：全局默认 + 作品级覆盖（作品级存在时优先于同名全局项）。
// 解析红线条目的豁免词清单（JSON 数组字符串 → 字符串数组）。
function parseRedlineExceptions(row) {
  try {
    const arr = JSON.parse(String(row.exceptions || '[]'));
    return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [];
  } catch (_) { return []; }
}

function listRedlines(workId) {
  const globalRows = prepare('SELECT * FROM writing_redlines WHERE work_id IS NULL ORDER BY id ASC').all();
  const workRows = workId ? prepare('SELECT * FROM writing_redlines WHERE work_id = ? ORDER BY id ASC').all(workId) : [];
  const byKey = new Map(globalRows.filter((r) => Number(r.enabled)).map((r) => [`${r.kind}:${r.pattern}`, r]));
  for (const r of workRows) {
    const key = `${r.kind}:${r.pattern}`;
    if (Number(r.enabled)) byKey.set(key, r);
    else byKey.delete(key);
  }
  return [...byKey.values()].map((r) => ({ ...r, exceptions: parseRedlineExceptions(r) }));
}

// 全量替换某一 scope 的红线（workId 为空则替换全局默认）。
// 校验：类型白名单、模式非空、长度上限（防病态正则）、regex 可编译。
function replaceRedlines(workId, entries) {
  if (!Array.isArray(entries)) throw new Error('entries 必须是数组');
  const MAX_PATTERN = 500;
  for (const e of entries) {
    const kind = asString(e.kind, 'phrase');
    if (!VALID_REDLINE_KINDS.has(kind)) throw new Error(`未知红线类型：${kind}`);
    const pattern = asString(e.pattern, '');
    if (!pattern.trim()) throw new Error('红线模式不能为空');
    if (pattern.length > MAX_PATTERN) throw new Error(`红线模式过长（上限 ${MAX_PATTERN} 字符）`);
    if (kind === 'regex') {
      try { new RegExp(pattern); } catch (_) { throw new Error(`非法正则：${pattern.slice(0, 80)}`); }
      // 病态正则启发式拦截：嵌套量词（如 (a+)+、(\w+)* 再叠量词）易造成灾难性回溯。
      if (/\([^)]*[+*{][^)]*\)\s*[+*{]/.test(pattern)) {
        throw new Error('正则包含嵌套量词，存在灾难性回溯风险，请简化');
      }
    }
    const exceptions = Array.isArray(e.exceptions)
      ? e.exceptions.map((s) => asString(s, '').trim()).filter(Boolean).slice(0, 20)
      : [];
    if (exceptions.some((s) => s.length > 100)) throw new Error('豁免词过长（单个上限 100 字符）');
  }
  db.exec('BEGIN');
  try {
    prepare('DELETE FROM writing_redlines WHERE work_id IS ?').run(workId ?? null);
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note, exceptions, enabled) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of entries) {
      const exceptions = Array.isArray(e.exceptions)
        ? e.exceptions.map((s) => asString(s, '').trim()).filter(Boolean).slice(0, 20)
        : [];
      stmt.run(workId ?? null, asString(e.kind, 'phrase'), asString(e.pattern, ''), asString(e.note, ''), JSON.stringify(exceptions), e.enabled === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listRedlines(workId);
}

// 把红线渲染成给模型看的“写作风格契约”文本；stylePositive 为作品级正向风格要求。
function renderStyleContract(rows, stylePositive = '') {
  const enabled = rows.filter((r) => Number(r.enabled));
  const lines = enabled.map((r) => {
    const kindName = r.kind === 'regex' ? '句式模式' : (r.kind === 'word' ? '慎用词' : '慎用句式');
    const exceptions = Array.isArray(r.exceptions) && r.exceptions.length ? `（豁免：${r.exceptions.join('、')}）` : '';
    return `- [${kindName}] ${r.pattern}${exceptions}${r.note ? `（${r.note}）` : ''}`;
  });
  const parts = [];
  if (lines.length) {
    parts.push([
      '【写作风格红线 · 反 AI 腔】请在写作时主动避免以下词句；若确需使用，每次出现前先问自己是否有更具体、更有画面感的写法：',
      ...lines
    ].join('\n'));
  }
  const positive = String(stylePositive || '').trim();
  if (positive) {
    parts.push(`【正向风格要求】本作品的风格追求（请主动体现，而非仅仅避免红线）：\n${positive}`);
  }
  return parts.length ? parts.join('\n\n') : '（未启用任何红线规则）';
}

// 在文本中确定性扫描红线命中（用于生成后自查）。
// opts.skip_dialogue=true 时先剥掉引号内对话再扫：角色台词的口语词不应按叙述标准误杀。
function scanAgainstRedlines(rows, text, opts = {}) {
  const hits = [];
  // 扫描文本长度上限：防病态正则叠加超长输入导致的灾难性回溯阻塞事件循环。
  const source = String(text || '').slice(0, 1000000);
  if (!source) return hits;
  const clean = opts.skip_dialogue === true
    ? source.replace(/“[^”]*”|「[^」]*」|‘[^’]*’|『[^』]*』/g, '')
    : source;
  if (!clean) return hits;
  for (const r of rows) {
    if (!Number(r.enabled)) continue;
    const pattern = String(r.pattern || '');
    if (!pattern || pattern.length > 500) continue; // 超长/异常模式跳过（防病态正则）
    const exceptions = Array.isArray(r.exceptions) ? r.exceptions.filter((s) => String(s || '').length <= 100) : [];
    let count = 0;
    let sample = '';
    try {
      if (r.kind === 'regex') {
        const re = new RegExp(pattern, 'g');
        const found = (clean.match(re) || []).filter((m) => !exceptions.some((e) => m.includes(e)));
        count = found.length;
        sample = found[0] || '';
      } else {
        let idx = -1;
        while ((idx = clean.indexOf(pattern, idx + 1)) !== -1) {
          // 豁免：命中位置与某个豁免词重叠时跳过（“眸 → 眼眸/回眸/眸色”这类整词豁免）。
          const exempt = exceptions.some((e) => {
            const start = Math.max(0, idx - e.length + 1);
            const end = Math.min(clean.length, idx + pattern.length + e.length - 1);
            return clean.slice(start, end).includes(e);
          });
          if (exempt) continue;
          count += 1;
          if (!sample) sample = clean.slice(Math.max(0, idx - 14), idx + pattern.length + 14);
        }
      }
    } catch (_) { /* 非法正则跳过 */ }
    if (count > 0) hits.push({ kind: r.kind, pattern, note: r.note || '', count, sample: sample || '' });
  }
  return hits.sort((a, b) => b.count - a.count);
}

// 🐞 运行追踪：红线扫描可能跑大量正则（正文越长越慢），单独成节点便于识别卡顿来源。
scanAgainstRedlines = traceFn('scanAgainstRedlines（写作红线扫描）', scanAgainstRedlines, { kind: 'fn', slowMs: 150 });

// ---------- 故事事件账本 ----------
// 入账一条事件；支持伏笔状态与回收关联、按 dedup_key 幂等去重。
function addStoryEvent(workId, {
  chapterId,
  kind = 'event',
  summary = '',
  payload = {},
  foreshadowStatus = '',
  resolvesEventId = null,
  dedupKey = '',
  tx = false
}) {
  const summaryText = asString(summary, '');
  const key = asString(dedupKey, '');
  const begin = () => { if (!tx) db.exec('BEGIN'); };
  const commit = () => { if (!tx) db.exec('COMMIT'); };
  const rollback = () => { if (!tx) db.exec('ROLLBACK'); };
  begin();
  try {
    // 查重移入事务内，配合 (work_id, dedup_key) 唯一索引兜底并发竞态。
    if (key) {
      const dup = prepare('SELECT id FROM story_events WHERE work_id = ? AND dedup_key = ? LIMIT 1').get(workId, key);
      if (dup) { commit(); return { id: Number(dup.id), duplicate: true }; }
    }
    if (resolvesEventId) {
      const target = prepare('SELECT id, kind FROM story_events WHERE id = ? AND work_id = ?').get(Number(resolvesEventId), workId);
      if (!target) throw new Error('回收目标事件不存在或不属于该作品');
      if (target.kind !== 'foreshadow') throw new Error('回收目标不是伏笔事件');
    }
    const info = prepare(`
      INSERT INTO story_events (work_id, chapter_id, kind, summary, payload, foreshadow_status, resolves_event_id, dedup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workId, chapterId || null, asString(kind, 'event'), summaryText, JSON.stringify(payload || {}),
      asString(foreshadowStatus, kind === 'foreshadow' ? 'open' : ''),
      resolvesEventId ? Number(resolvesEventId) : null, key, now());
    if (resolvesEventId && kind === 'event') {
      // 回收伏笔：把被回收的伏笔标记为 resolved，并回链到本事件。
      prepare('UPDATE story_events SET foreshadow_status = ? WHERE id = ? AND work_id = ?')
        .run('resolved', Number(resolvesEventId), workId);
    }
    commit();
    if (!tx) touchWork(workId);
    return { id: Number(info.lastInsertRowid), duplicate: false };
  } catch (e) {
    rollback();
    if (key && /UNIQUE constraint failed/i.test(String(e?.message || ''))) {
      const dup = prepare('SELECT id FROM story_events WHERE work_id = ? AND dedup_key = ? LIMIT 1').get(workId, key);
      if (dup) return { id: Number(dup.id), duplicate: true };
    }
    throw e;
  }
}

function listStoryEvents(workId, limit = 40) {
  return prepare(`
    SELECT * FROM story_events WHERE work_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(workId, limit).map((e) => {
    let payload = {};
    try { payload = JSON.parse(e.payload || '{}'); } catch (_) {}
    return {
      id: e.id, chapter_id: e.chapter_id, kind: e.kind, summary: e.summary, payload,
      foreshadow_status: e.foreshadow_status || (e.kind === 'foreshadow' ? 'open' : ''),
      resolves_event_id: e.resolves_event_id,
      created_at: e.created_at
    };
  });
}

// ---------- 入账提案（headless 生成任务先提案、作者确认后入账） ----------
function listProposals(workId) {
  const events = prepare('SELECT * FROM story_event_proposals WHERE work_id = ? AND status = ? ORDER BY id ASC')
    .all(workId, 'pending').map((p) => ({ type: 'event', ...p, payload: safeParseJSON(p.payload) }));
  const memories = prepare('SELECT * FROM story_memory_proposals WHERE work_id = ? AND status = ? ORDER BY id ASC')
    .all(workId, 'pending').map((p) => ({ type: 'memory', ...p }));
  return [...events, ...memories];
}

function addEventProposal(workId, fields) {
  const info = prepare(`
    INSERT INTO story_event_proposals (work_id, chapter_id, kind, summary, payload, foreshadow_status, resolves_event_id, dedup_key, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workId, fields.chapterId || null, asString(fields.kind, 'event'), asString(fields.summary, ''),
    JSON.stringify(fields.payload || {}), asString(fields.foreshadowStatus, fields.kind === 'foreshadow' ? 'open' : ''),
    fields.resolvesEventId ? Number(fields.resolvesEventId) : null, asString(fields.dedupKey, ''), asString(fields.note, ''));
  return { proposed: true, proposal_id: Number(info.lastInsertRowid) };
}

function addMemoryProposal(workId, { summary, delta, note }) {
  const info = prepare(`
    INSERT INTO story_memory_proposals (work_id, summary, delta, note, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(workId, asString(summary, ''), asString(delta, ''), asString(note, ''));
  return { proposed: true, proposal_id: Number(info.lastInsertRowid) };
}

// 采纳/拒绝提案：ids 为空 + all=true 时处理该作品全部 pending 提案。
function settleProposals(workId, { ids, all, action }) {
  const mark = (table, id) => prepare(`UPDATE ${table} SET status = ? WHERE id = ? AND work_id = ? AND status = 'pending'`).run(action, id, workId);
  const applied = { events: 0, memories: 0 };
  const rejected = { events: 0, memories: 0 };
  let eventRows = [];
  let memoryRows = [];
  if (all) {
    eventRows = prepare(`SELECT * FROM story_event_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id ASC`).all(workId);
    memoryRows = prepare(`SELECT * FROM story_memory_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id ASC`).all(workId);
  } else {
    const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (list.length) {
      eventRows = prepare(`SELECT * FROM story_event_proposals WHERE work_id = ? AND id IN (${list.map(() => '?').join(',')})`).all(workId, ...list);
      memoryRows = prepare(`SELECT * FROM story_memory_proposals WHERE work_id = ? AND id IN (${list.map(() => '?').join(',')})`).all(workId, ...list);
    }
  }
  for (const p of eventRows) {
    if (action === 'apply') {
      addStoryEvent(workId, {
        chapterId: p.chapter_id, kind: p.kind, summary: p.summary,
        payload: safeParseJSON(p.payload), foreshadowStatus: p.foreshadow_status,
        resolvesEventId: p.resolves_event_id, dedupKey: p.dedup_key
      });
      applied.events += 1;
    } else {
      rejected.events += 1;
    }
    mark('story_event_proposals', p.id);
  }
  for (const p of memoryRows) {
    if (action === 'apply') {
      let summary = asString(p.summary, '');
      if (!summary && p.delta) summary = mergeMemoryDraft(getStoryMemory(workId), p.delta);
      if (summary.trim()) {
        saveStoryMemory(workId, summary, { source: 'proposal', note: p.note || '作者确认的 AI 提案' });
        applied.memories += 1;
      } else {
        rejected.memories += 1; // 空提案按拒绝处理，避免把长期记忆覆盖为空串
      }
    } else {
      rejected.memories += 1;
    }
    mark('story_memory_proposals', p.id);
  }
  return { ok: true, work_id: workId, action, applied, rejected, pending: listProposals(workId).length };
}

function safeParseJSON(text) {
  try { return JSON.parse(text || '{}'); } catch (_) { return {}; }
}

// ---------- 记忆版本 ----------
function listMemoryVersions(workId) {
  return prepare('SELECT id, work_id, summary, source, note, created_at FROM memory_versions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(workId);
}

// 回滚到指定版本：把该版本写回当前生效摘要，并记一条 rollback 快照。
function rollbackMemory(versionId) {
  const version = prepare('SELECT * FROM memory_versions WHERE id = ?').get(versionId);
  if (!version) throw new Error('记忆版本不存在');
  const result = saveStoryMemory(version.work_id, version.summary, { source: 'rollback', note: `回滚到版本 #${version.id}` });
  const version_id = result.version_id
    ?? (prepare('SELECT MAX(id) AS id FROM memory_versions WHERE work_id = ?').get(version.work_id)?.id ?? null);
  return { ok: true, work_id: version.work_id, summary: result.summary, version_id };
}

// ---------- 场景化创作上下文（ST 式装配） ----------
// mode: full（默认，整章代写/分析）| continuation（接龙，重视前文尾巴）| fragment（片段补写）
async function buildNovelContext(workId, chapterId, mode = 'full') {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) return null;

  const allChapters = prepare('SELECT id, work_id, volume_id, plotline_id, parent_id, title, summary, author_note, blueprint_json, target_words, context_character_ids, position, created_at, updated_at FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const plotlines = prepare('SELECT * FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const allCharacters = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const nameById = new Map(allCharacters.map((c) => [c.id, c.name]));

  let chapter = null;
  let chapterIndex = -1;
  if (chapterId) {
    chapterIndex = allChapters.findIndex((c) => c.id === Number(chapterId));
    chapter = chapterIndex >= 0 ? allChapters[chapterIndex] : prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) || null;
    // 防串作品：chapterId 属于其它作品时视为未指定章节。
    if (chapter && chapter.work_id !== workId) { chapter = null; chapterIndex = -1; }
  }
  const prevChapter = chapterIndex > 0 ? allChapters[chapterIndex - 1] : null;
  const nextChapter = chapterIndex >= 0 && chapterIndex < allChapters.length - 1 ? allChapters[chapterIndex + 1] : null;
  if (chapter && !chapter.content) {
    const full = prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id);
    chapter = { ...chapter, content: full?.content || '' };
  }

  const corpus = [
    work.title, work.description,
    chapter?.title || '', chapter?.summary || '', plainTextHead(chapter?.content || '', 3000),
    prevChapter?.title || '', prevChapter?.summary || ''
  ].join(' ').toLowerCase();

  // 出场角色：评分制选择（剧情线关联 > 正文/摘要命中 > 蓝图/作者注/最近事件 > 最近章节摘要 > 关系网）；
  // 兜底改为“最近出场优先”而非“按名字前 8”；角色卡逐卡构建、核心字段保底（见 buildCharacterCards）。
  let blueprint = null;
  try { blueprint = JSON.parse(chapter?.blueprint_json || '{}'); } catch (_) { blueprint = null; }
  const allEvents = listStoryEvents(workId, 200);
  const recentSummaries = [
    ...allChapters.slice(Math.max(0, chapterIndex - 3), chapterIndex).map((c) => c.summary || ''),
    chapter?.summary || ''
  ];
  const forcedIds = String(chapter?.context_character_ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const { sceneCharacters } = selectSceneCharacters(workId, {
    plotlineId: chapter?.plotline_id || null,
    corpus,
    forceIds: forcedIds,
    extraTexts: [
      chapter?.author_note || '', work.author_note || '',
      JSON.stringify(blueprint || {}),
      allEvents.slice(0, 30).map((e) => e.summary).join(' ')
    ],
    recentSummaries
  });
  const charCardsText = buildCharacterCards(sceneCharacters, entityCapOfId('characters'));

  // 人物关系（仅出场角色之间）
  const sceneIdList = sceneCharacters.map((c) => c.id);
  const relations = sceneIdList.length > 1
    ? prepare(`
        SELECT * FROM character_relations WHERE work_id = ? AND
        from_character_id IN (${sceneIdList.map(() => '?').join(',')}) AND to_character_id IN (${sceneIdList.map(() => '?').join(',')})
      `).all(workId, ...sceneIdList, ...sceneIdList)
    : [];
  const relationsText = relations.length
    ? relations.map((r) => `${nameById.get(r.from_character_id) || '?'} —${r.relation || '关系'}→ ${nameById.get(r.to_character_id) || '?'}${r.description ? `（${r.description.slice(0, 160)}）` : ''}`).join('\n')
    : '';

  // 世界观词条：固定(pinned)优先 + 关键词命中，按 priority 降序限量截断（与 UI 预览共用 pickWorldEntries）。
  const worldEntries = pickWorldEntries(workId, corpus);
  const worldEntriesText = worldEntries.map((w) => `【${w.title}】${String(w.content || '').slice(0, 600)}`).join('\n');

  // 大纲层：卷 + 剧情线 + 章节标题/摘要（长作品只给前 30 + 最近 40，中间省略计数）
  const outlineLines = [];
  for (const v of volumes) outlineLines.push(`【卷】${v.title}${v.summary ? `：${v.summary.slice(0, 200)}` : ''}`);
  for (const p of plotlines) outlineLines.push(`【${p.kind === 'side' ? '支线' : '主线'}】${p.title}${p.summary ? `：${p.summary.slice(0, 200)}` : ''}`);
  const total = allChapters.length;
  const skip = total > 70 ? total - 40 : -1;
  const shown = allChapters.filter((c, i) => skip < 0 || i < 30 || i >= skip || c.id === chapter?.id);
  if (skip >= 0) outlineLines.push(`（中间 ${total - 70} 章已省略，仅列最近进展）`);
  for (const c of shown) {
    const marker = c.id === chapter?.id ? '★' : '';
    outlineLines.push(`第${c.position + 1}节${marker} ${c.title}${c.summary ? `：${c.summary.slice(0, 120)}` : ''}`);
  }
  const outlineText = outlineLines.join('\n');

  const storyMemory = getStoryMemory(workId);
  const events = allEvents.slice(0, 30);
  const eventsText = events.length
    ? events.map((e, i) => `${events.length - i}. [${e.kind}] ${e.summary.slice(0, 200)}`).join('\n')
    : '（暂无事件账本记录）';
  // 未闭合伏笔：写作时必须照顾的“欠账”，也是 novel_consistency 的核对依据。
  const openForeshadows = allEvents.filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped').slice(0, 20);
  const foreshadowText = openForeshadows.length
    ? openForeshadows.map((e) => `#${e.id} ${e.summary.slice(0, 160)}${e.resolves_event_id ? `（已被 #${e.resolves_event_id} 回收）` : ''}`).join('\n')
    : '';

  // 前文尾巴：接龙模式取当前章节尾部；新章节/片段取上一章尾部。
  // 4000 = `story_tail` 在 continuation 模式下的 cap（capContinuation），从规格取而不是另写一份。
  const currentTail = chapter ? plainTextTail(chapter.content || '', capOfId('story_tail', 'continuation')) : '';
  const prevFullRow = prevChapter ? prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapter.id) : null;
  const prevTailText = prevFullRow ? plainTextTail(prevFullRow.content || '', 1500) : '';
  let storyTail = '';
  if (mode === 'continuation') {
    storyTail = currentTail;
  } else if (mode === 'fragment') {
    storyTail = currentTail || prevTailText;
  } else {
    storyTail = prevTailText || (currentTail ? currentTail.slice(-1500) : '');
  }
  if (!storyTail) storyTail = prevTailText || (chapter ? plainTextTail(chapter.content || '', 800) : '');

  const redlines = listRedlines(workId);
  const styleContract = renderStyleContract(redlines, work.style_positive || '');

  // 分层预算：渲染 / 每层 cap / 总预算收敛 / 裁剪清单统一由 ai/context/assembler.mjs 负责。
  // 本函数只负责「取数」——把每一层的正文准备好，层的 cap 与 kind 一律从 layers.mjs 读。
  const needsCompression = storyMemory.length > MEMORY_COMPRESS_HINT;

  const memoryBody = storyMemory
    // ⚠️ 压缩提示必须放在**正文开头**：层是按 cap 从**头部**截断的，而长期记忆会随章节无界增长
    //（`mergeMemoryDraft` 新事件置顶、只拼接不压缩）。提示若挂在末尾，记忆越长越会被自己截掉——
    // 恰恰在最该提示压缩的时候提示消失。实测：work#16 记忆 9063 字、cap 2200 → 末尾提示被切掉，
    // 层内只剩截断提示（见 docs/p5-memory-eval-verification.md §四·3）。
    ? `${needsCompression ? `（⚠ 记忆已 ${storyMemory.length} 字，超过 ${MEMORY_COMPRESS_HINT} 字压缩提示线，收尾时请优先用 novel_memory_update 压缩合并）\n` : ''}${storyMemory}`
    : '（无，可建议压缩一次）';

  const sceneBody = chapter
    ? `第${chapter.position + 1}节 ${chapter.title}${chapter.summary ? `\n大纲摘要：${chapter.summary}` : ''}${chapter.author_note ? `\n作者注：${chapter.author_note}` : ''}`
    : '（未指定具体章节）';

  // 本章蓝图（章节写作的常驻锚点）与目标字数：蓝图落库后随上下文带入，生成与核对都以其为准。
  const BLUEPRINT_LABELS = [
    ['scene_goal', '场景目标'], ['plot_points', '情节点'], ['conflicts', '冲突与转折'],
    ['character_changes', '出场角色状态变化'], ['hook', '下一章钩子'], ['references', '参考设定']
  ];
  const blueprintText = blueprint && Object.keys(blueprint).length
    ? BLUEPRINT_LABELS
        .map(([key, label]) => [label, String(blueprint[key] || '')])
        .filter(([, v]) => v.trim())
        .map(([label, v]) => `${label}：${v.slice(0, 600)}`).join('\n')
    : '';
  const targetWords = (Number(chapter?.target_words) > 0 ? Number(chapter.target_words) : 0)
    || Number(work.default_chapter_words) || 2000;

  // 作品级写作配置：总章数/故事结构/叙事视角（有配置时进入上下文，约束大纲与蓝图生成）。
  const workConfigText = [
    Number(work.total_chapters) > 0 ? `总章数：${Number(work.total_chapters)}` : '',
    work.story_structure ? `故事结构：${work.story_structure}` : '',
    work.narrative_pov ? `叙事视角：${work.narrative_pov}` : '',
    `每章目标字数：${targetWords} 字`
  ].filter(Boolean).join('｜');

  // OpenViking 语义召回层：以当前写作场景（章节/蓝图/最近事件）为查询，从共享记忆库的
  // 作品子树召回相关片段（旧章正文、设定词条、角色卡、事件等），弥补固定分层漏掉的信息；
  // OpenViking 不可用时静默跳过，不阻塞写作。
  let semanticRecall = null;
  try {
    semanticRecall = await getSemanticRecall(workId, chapter || null);
  } catch (_) {
    semanticRecall = { enabled: true, status: 'error', query: '', hits: [] };
  }
  const recallLayer = semanticRecall && semanticRecall.status === 'ok' && semanticRecall.text
    ? { label: '相关记忆检索（语义召回）', text: semanticRecall.text, cap: 1400 }
    : null;

  // mode=settings：设定类生成（角色/世界观/词条/剧情线等）专用轻量装配——
  // 这类任务不需要「当前这一章写到哪了」，跳过当前场景/本章蓝图/前文衔接三层。
  // 注意：旧注释写的「三层合计最多省 ~6,700 字/轮」是三层 **cap 之和**，不是实际节省；
  // 实际节省取决于这三层当时的真实长度，可能远小于上限。
  const isSettingsMode = mode === 'settings';
  const specById = new Map(CONTEXT_LAYER_SPEC.map((l) => [l.id, l]));
  // 按 spec 的 id 组装一层：cap 与 kind 一律取自 layers.mjs（单一来源），
  // 这里只负责把该层的正文准备好。
  const L = (id, text) => {
    const spec = specById.get(id);
    if (!spec) throw new Error(`未知的上下文层 id：${id}（layers.mjs 与 buildNovelContext 不同步）`);
    return { id, label: spec.label, kind: spec.kind, text, cap: contextCapOf(spec, mode) };
  };
  const layers = [
    L('work', `${work.title}${work.description ? `\n${work.description.slice(0, 600)}` : ''}\n${workConfigText}`),
    L('outline', outlineText),
    L('memory', memoryBody),
    recallLayer ? L('recall', recallLayer.text) : null,
    L('events', eventsText),
    L('foreshadows', foreshadowText),
    ...(isSettingsMode ? [] : [
      L('scene', sceneBody),
      L('blueprint', blueprintText || '（暂无蓝图，可在工坊里用「AI 写作」自动生成，或直接成文）'),
      L('story_tail', storyTail),
    ]),
    L('characters', charCardsText),
    relationsText ? L('relations', relationsText) : null,
    L('world', worldEntriesText),
    L('redlines', styleContract),
  ].filter(Boolean);

  // 装配：渲染 + 每层 cap + 总预算收敛（弹性层按 FLEX_ORDER 逐档压缩，零损失层绝不参与），
  // 并产出裁剪清单。总预算的「可执行下限」由 layers.mjs 的 computeFloor() 自动核算，
  // 不再靠注释里的手算数字（历史失误 1：预算常量不核算可执行下限）。
  const {
    text: assembled,
    manifest: contextManifest,
    overflow: contextOverflow,
    stats: contextStats,
  } = assembleContext(layers, { mode });

  return {
    ok: true,
    mode,
    work: { id: work.id, title: work.title, default_chapter_words: Number(work.default_chapter_words) || 2000, total_chapters: Number(work.total_chapters) || 0, story_structure: work.story_structure, narrative_pov: work.narrative_pov, style_positive: work.style_positive || '' },
    chapter: chapter ? { id: chapter.id, title: chapter.title, summary: chapter.summary, position: chapter.position, volume_id: chapter.volume_id, plotline_id: chapter.plotline_id, blueprint, target_words: targetWords } : null,
    prev_chapter: prevChapter ? { id: prevChapter.id, title: prevChapter.title } : null,
    next_chapter: nextChapter ? { id: nextChapter.id, title: nextChapter.title } : null,
    story_memory: storyMemory,
    needs_compression: needsCompression,
    events,
    open_foreshadows: openForeshadows.map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id, resolves_event_id: e.resolves_event_id })),
    scene_characters: sceneCharacters.map((c) => ({ id: c.id, name: c.name, identity: c.identity, status: c.status, aliases: c.aliases || '', forced: forcedIds.includes(c.id) })),
    scene_character_ids: sceneIdList,
    world_entries: worldEntries.map((w) => ({ id: w.id, title: w.title, pinned: Number(w.is_pinned) === 1, priority: Number(w.priority ?? 50), keywords: w.keywords, content_preview: String(w.content || '').slice(0, 600) })),
    relations: relations.map((r) => ({ from: nameById.get(r.from_character_id) || null, to: nameById.get(r.to_character_id) || null, relation: r.relation, description: r.description })),
    redlines: redlines.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note })),
    style_contract: styleContract,
    semantic_recall: semanticRecall ? {
      enabled: semanticRecall.enabled,
      status: semanticRecall.status,
      hits: semanticRecall.hits || []
    } : { enabled: false, status: 'unknown', hits: [] },
    assembled,
    // P2 新增（additive，旧消费方不受影响）：
    //   context_manifest  逐层裁剪清单——零损失审计的依据（每层原始长 / 采用长 / 占用 / 被裁字数）
    //   context_overflow  压到下限仍超预算时的显式标记（契约 I1：不静默超限）
    //   context_stats     装配统计（预算 / 实际长度 / 截断层数 / 被裁总字数 / 收缩步数）
    context_manifest: contextManifest,
    context_overflow: contextOverflow,
    context_stats: contextStats
  };
}

// 🐞 运行追踪：创作内核的上下文装配是最重的一段（分层预算 + 语义召回 + 缓存），单列节点。
buildNovelContext = traceFn('buildNovelContext（创作上下文装配）', buildNovelContext, { kind: 'fn', slowMs: 500 });

// 记忆增量更新辅助：在“已有摘要”基础上合并一段“本批次进展”，返回新的摘要文本。
// 只负责文本拼接约定，真正的语义压缩由模型完成；本函数供插件生成可写入的 summary。
function mergeMemoryDraft(prevSummary, deltaEventsText) {
  const base = (prevSummary || '').trim();
  const delta = (deltaEventsText || '').trim();
  if (!delta) return base;
  if (!base) return delta;
  // 新事件置顶、旧摘要压缩保留——模型侧负责进一步精简，这里只做安全合并。
  return `${delta}\n\n【此前进度】${base}`;
}

// ---------- 章节审稿（审稿→确认清单→修稿→差异合并） ----------
/**
 * @param {object} report 结构化审稿报告
 * @param {{ rawText?: string, status?: string }} [extra]
 *   rawText：AI 返回的无法解析的原文。宁可存原文也不丢 —— 一轮审稿要等好几分钟，
 *   因为 JSON 里多一个引号就整份丢弃，是 2026-09-14 真实事故的根因。
 */
function saveReview(workId, chapterId, report, extra = {}) {
  const payload = report && typeof report === 'object' ? { ...report } : {};
  const rawText = asString(extra.rawText, '').slice(0, 200000);
  if (rawText && !asString(payload.raw_text, '')) payload.raw_text = rawText;
  const status = ['parsed', 'raw'].includes(extra.status) ? extra.status : (rawText ? 'raw' : 'parsed');
  const json = JSON.stringify(payload);
  const info = prepare(`
    INSERT INTO chapter_reviews (work_id, chapter_id, report_json, checklist_json, status)
    VALUES (?, ?, ?, '{}', ?)
  `).run(workId, chapterId, json, status);
  // 每个章节只保留最近 10 份审稿
  prepare(`
    DELETE FROM chapter_reviews WHERE chapter_id = ? AND id NOT IN (
      SELECT id FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 10
    )
  `).run(chapterId, chapterId);
  return Number(info.lastInsertRowid);
}

// 审稿报告解析（服务端侧）：严格 JSON 失败时逐字段抢救。
// 必须与前端 extractReviewFromText 同源同义：一轮审稿要跑几分钟，模型返回的 JSON
// 里只要多一个引号，严格解析就会失败、整份报告作废（2026-09-14 真实事故）。
function salvageJSONString(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return '';
  let i = src.indexOf(':', at) + 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '"') return '';
  i += 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i += 2;
      continue;
    }
    if (c === '"') {
      const rest = src.slice(i + 1).replace(/^[\s,]+/, '');
      if (rest.startsWith('}') || rest.startsWith(']') || /^"[A-Za-z_]+"\s*:/.test(rest)) break;
      if (src[i + 1] === '"') { i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.trim().replace(/["']+$/, '');
}

function salvageJSONList(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return [];
  const open = src.indexOf('[', at);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end < 0 ? src.length : end);
  const out = [];
  let cursor = 0;
  for (;;) {
    const t = body.indexOf('"text"', cursor);
    if (t < 0) break;
    const val = salvageJSONString(body.slice(Math.max(0, t - 1)), 'text');
    if (val && !out.includes(val)) out.push(val);
    cursor = t + 6;
  }
  return out;
}

/** 把 AI 的审稿输出变成 { summary, issues, strengths }；救不回来时返回 null。 */
function parseReviewText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    let obj = null;
    try { obj = JSON.parse(slice); } catch (_) {
      try { obj = JSON.parse(slice.replace(/"\s*,\s*"/g, '","').replace(/"\s*,\s*([}\]])/g, '"$1')); } catch (_) { obj = null; }
    }
    if (obj && (asString(obj.summary, '').trim() || Array.isArray(obj.issues))) {
      return {
        summary: asString(obj.summary, ''),
        issues: asArray(obj.issues).map((x) => asString(typeof x === 'string' ? x : x?.text, '')).filter(Boolean),
        strengths: asArray(obj.strengths).map((x) => asString(typeof x === 'string' ? x : x?.text, '')).filter(Boolean)
      };
    }
  }
  const body = start >= 0 ? s.slice(start) : s;
  const salvaged = { summary: salvageJSONString(body, 'summary'), issues: salvageJSONList(body, 'issues'), strengths: salvageJSONList(body, 'strengths') };
  return (salvaged.summary || salvaged.issues.length) ? salvaged : null;
}

function getLatestReview(chapterId) {  const row = prepare('SELECT * FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 1').get(chapterId);
  if (!row) return null;
  let report = {}; let checklist = {};
  try { report = JSON.parse(row.report_json || '{}'); } catch (_) {}
  try { checklist = JSON.parse(row.checklist_json || '{}'); } catch (_) {}
  return { id: row.id, chapter_id: row.chapter_id, report, checklist, status: row.status, created_at: row.created_at };
}

function setReviewChecklist(reviewId, checklist) {
  const row = prepare('SELECT * FROM chapter_reviews WHERE id = ?').get(reviewId);
  if (!row) return null;
  const json = JSON.stringify(checklist && typeof checklist === 'object' ? checklist : {});
  prepare('UPDATE chapter_reviews SET checklist_json = ?, status = ? WHERE id = ?').run(json, 'confirmed', reviewId);
  return Number(reviewId);
}

// ---------- 导入：TXT/Markdown/EPUB → 新建作品自动拆章 ----------
const CHAPTER_HEAD_RE = /^\s*(?:第\s*[0-9一二三四五六七八九十百千零两]+\s*[章回节卷部集]|(?:Chapter|CHAPTER)\s+\d+|序章|楔子|尾声|终章|番外)(?:[：:、\s]+.*)?$/;

function splitTextIntoCapters(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let current = null;
  let preamble = [];
  const flush = () => { if (current) chapters.push(current); };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 60 && CHAPTER_HEAD_RE.test(trimmed)) {
      flush();
      current = { title: trimmed, content: '' };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    } else {
      preamble.push(line);
    }
  }
  flush();
  const pre = preamble.join('\n').trim();
  if (pre) {
    if (chapters.length) chapters[0].content = pre + '\n' + chapters[0].content;
    else chapters.push({ title: '第一章', content: pre });
  }
  return chapters.map((c) => ({ title: c.title, content: c.content.trim() })).filter((c) => c.content || c.title);
}

// 🐞 运行追踪：导入拆章（大文件、正则密集）单独成节点。
splitTextIntoCapters = traceFn('splitTextIntoCapters（导入拆章）', splitTextIntoCapters, { kind: 'fn', slowMs: 300 });

// 纯文本 → 编辑器 HTML（段落 <p>）。
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// EPUB → { title, chapters: [{title, content}] }（零依赖 zip 读取）。
function xmlDecode(s = '') {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseEpub(buffer) {
  const entries = readZip(buffer);
  const containerText = entries.get('META-INF/container.xml')?.toString('utf8');
  if (!containerText) throw new Error('EPUB 缺少 META-INF/container.xml');
  const rootPath = xmlDecode(containerText.match(/full-path=["']([^"']+)["']/)?.[1] || '').trim();
  if (!rootPath) throw new Error('EPUB 无法定位 opf 文件');
  const opf = entries.get(rootPath)?.toString('utf8');
  if (!opf) throw new Error('EPUB 缺少 opf 文件');
  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || '')
    .replace(/<[^>]*>/g, '').trim() || '导入的 EPUB';
  // 兼容命名空间（<opf:item>）与属性任意顺序：分别捕获 id/href/idref 再组装。
  const attrOf = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
  const manifest = {};
  for (const m of opf.matchAll(/<[\w:]*item\b[^>]*\/?>/g)) {
    const id = attrOf(m[0], 'id');
    const href = attrOf(m[0], 'href');
    if (id && href) manifest[id] = xmlDecode(href);
  }
  const spine = [];
  for (const m of opf.matchAll(/<[\w:]*itemref\b[^>]*\/?>/g)) {
    const idref = attrOf(m[0], 'idref');
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }
  if (!spine.length) throw new Error('EPUB spine 为空');
  const opfDir = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
  const chapters = [];
  for (const href of spine) {
    let full = opfDir + href;
    try { full = decodeURIComponent(full); } catch (_) { /* 保留原样 */ }
    full = full.replace(/^\.\//, '');
    const html = entries.get(full)?.toString('utf8');
    if (!html) continue;
    const text = htmlToPlain(html);
    if (!text) continue;
    const head = (html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/)?.[1] || '').replace(/<[^>]*>/g, '').trim();
    chapters.push({ title: head || `第 ${chapters.length + 1} 节`, content: text });
  }
  if (!chapters.length) throw new Error('EPUB 未解析出任何章节内容');
  return { title, chapters };
}

function importWorkFromChapters(title, chapters, description = '') {
  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title: title.trim() || '导入的作品', description });
    chapters.forEach((ch, i) => {
      insertRow('chapters', {
        work_id: workId,
        title: String(ch.title || `第 ${i + 1} 章`).slice(0, 80),
        summary: '',
        content: textToHtml(ch.content),
        position: i
      });
    });
    db.exec('COMMIT');
    return workId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 导出：整书 TXT / 整书 Markdown / 单章 TXT ----------
function buildWorkExport(workId, fmt) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) return null;
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const chapters = prepare('SELECT * FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const volName = (id) => volumes.find((v) => v.id === id)?.title || '';
  const lines = [];
  if (fmt === 'md') {
    lines.push(`# ${work.title}`, '');
    if (work.description) lines.push(`> ${work.description}`, '');
    let lastVol = null;
    for (const c of chapters) {
      const v = volName(c.volume_id);
      if (v && v !== lastVol) { lines.push('', `## ${v}`, ''); lastVol = v; }
      lines.push(`### ${c.title}`, '');
      if (c.summary) lines.push(`> ${c.summary}`, '');
      const plain = htmlToPlain(c.content || '');
      if (plain) lines.push(plain, '');
    }
  } else {
    lines.push(`${work.title}`, work.description ? `简介：${work.description}` : '', '');
    let lastVol = null;
    for (const c of chapters) {
      const v = volName(c.volume_id);
      if (v && v !== lastVol) { lines.push('', `【卷】${v}`, ''); lastVol = v; }
      lines.push(`【${c.title}】`, '');
      if (c.summary) lines.push(`（摘要：${c.summary}）`, '');
      const plain = htmlToPlain(c.content || '');
      if (plain) lines.push(plain, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function buildChapterExport(chapterId) {
  const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!chapter) return null;
  const work = prepare('SELECT title FROM works WHERE id = ?').get(chapter.work_id);
  const lines = [`${work?.title || ''} · ${chapter.title}`, ''];
  if (chapter.summary) lines.push(`（摘要：${chapter.summary}）`, '');
  lines.push(htmlToPlain(chapter.content || ''));
  return lines.join('\n').trim() + '\n';
}

// ---------- 示例小说一键导入（演示数据 demo-data.json） ----------
// 与脚本版 demo/seed-demo.js 等价，走数据库直写；UI 入口在“我的作品”页。
const DEMO_TITLE = '雾都缝匠';
let _demoData = null;

function demoDataJson() {
  if (_demoData === null) {
    try {
      _demoData = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-data.json'), 'utf8'));
    } catch (e) {
      _demoData = { err: `${e && e.code ? e.code + ': ' : ''}${(e && e.message) || e}` }; // 文件缺失/损坏时给出可读错误
    }
  }
  return _demoData;
}

function demoFindWork(title) {
  return prepare('SELECT id FROM works WHERE title = ?').get(title) || null;
}

function deleteDemoWork(title) {
  const row = demoFindWork(title);
  if (!row) return false;
  deleteRow('works', row.id);
  return true;
}

// 导入示例作品；force=true 时先删除同名作品再重建。
function installDemo(force) {
  const data = demoDataJson();
  if (!data) throw new Error('缺少演示数据文件 demo-data.json（请与 server.js 放在同一目录）');
  if (data.err) throw new Error(`演示数据读取失败：${data.err}`);
  const title = asString(data.work.title, DEMO_TITLE);
  if (demoFindWork(title)) {
    if (!force) throw new Error(`示例《${title}》已存在；如需覆盖请用重新导入`);
    deleteDemoWork(title);
  }

  const idMap = { volume: new Map(), plotline: new Map(), category: new Map(), character: new Map(), chapter: new Map() };

  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title, description: asString(data.work.description), author_note: asString(data.work.author_note) });

    (data.volumes || []).forEach((v, i) => {
      idMap.volume.set(v.title, insertRow('volumes', { work_id: workId, title: asString(v.title, `卷${i + 1}`), summary: asString(v.summary), position: i }));
    });
    (data.plotlines || []).forEach((p, i) => {
      const rawTitle = asString(p.title, `线${i + 1}`);
      const title = stripPlotlinePrefix(rawTitle);
      const id = insertRow('plotlines', { work_id: workId, title, kind: p.kind === 'side' ? 'side' : 'main', summary: asString(p.summary), position: i });
      idMap.plotline.set(rawTitle, id);
      idMap.plotline.set(title, id);
    });
    (data.categories || []).forEach((c, i) => {
      idMap.category.set(c.name, insertRow('categories', { work_id: workId, name: asString(c.name, `分类${i + 1}`), color: asString(c.color, '#6366f1'), position: i }));
    });
    (data.terms || []).forEach((t) => {
      insertRow('terms', { work_id: workId, category_id: idMap.category.get(t.category) ?? null, title: asString(t.title, '词条'), content: asString(t.content), tags: asString(t.tags) });
    });
    (data.characters || []).forEach((c) => {
      idMap.character.set(c.name, insertRow('characters', {
        work_id: workId, name: asString(c.name, '角色'),
        identity: asString(c.identity), appearance: asString(c.appearance), personality: asString(c.personality),
        background: asString(c.background), status: asString(c.status), avatar_color: asString(c.avatar_color, '#8b5cf6'),
        mes_example: asString(c.mes_example), tags: asString(c.tags), system_prompt: asString(c.system_prompt), aliases: asString(c.aliases)
      }));
    });
    (data.relations || []).forEach((r) => {
      const fromId = idMap.character.get(r.from);
      const toId = idMap.character.get(r.to);
      if (!fromId || !toId) return;
      insertRow('relations', { work_id: workId, from_character_id: fromId, to_character_id: toId, relation: asString(r.relation), description: asString(r.description) });
    });
    (data.worldEntries || []).forEach((w, i) => {
      insertRow('world_entries', { work_id: workId, title: asString(w.title, `设定${i + 1}`), content: asString(w.content), keywords: asString(w.keywords), is_pinned: Number(w.is_pinned) ? 1 : 0, priority: Number(w.priority) || 50, position: i });
    });
    (data.plotlineCharacters || []).forEach((pc) => {
      const cId = idMap.character.get(pc.character);
      const pId = idMap.plotline.get(pc.plotline);
      if (!cId || !pId) return;
      insertRow('plotline_characters', { work_id: workId, plotline_id: pId, character_id: cId, status: asString(pc.status), notes: asString(pc.notes) });
    });
    (data.chapters || []).forEach((ch, i) => {
      const id = insertRow('chapters', {
        work_id: workId,
        volume_id: idMap.volume.get(ch.volume) ?? null,
        plotline_id: idMap.plotline.get(ch.plotline) ?? null,
        parent_id: null,
        title: asString(ch.title, `第${i + 1}节`),
        summary: asString(ch.summary),
        content: textToHtml(ch.content),
        position: i
      });
      idMap.chapter.set(ch.title, id);
    });
    // 长期记忆与事件账本一并纳入同一事务（tx:true），任一步失败整体回滚，
    // 避免「作品已建但无记忆/事件」的半成品状态。
    let eventCount = 0;
    if (data.memory && asString(data.memory.summary)) {
      saveStoryMemory(workId, asString(data.memory.summary), { source: asString(data.memory.source, 'manual') || 'manual', note: asString(data.memory.note, '示例导入'), tx: true });
    }
    (data.events || []).forEach((e) => {
      addStoryEvent(workId, { chapterId: idMap.chapter.get(e.chapter) ?? null, kind: asString(e.kind, 'event'), summary: asString(e.summary), payload: e.payload || {}, tx: true });
      eventCount += 1;
    });

    db.exec('COMMIT');
    touchWork(workId);

    return {
      work_id: workId, title,
      counts: {
        volumes: (data.volumes || []).length,
        plotlines: (data.plotlines || []).length,
        categories: (data.categories || []).length,
        terms: (data.terms || []).length,
        characters: (data.characters || []).length,
        world_entries: (data.worldEntries || []).length,
        chapters: (data.chapters || []).length,
        events: eventCount
      }
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 事务可能未开始 */ }
    throw e;
  }
}

// 🐞 运行追踪：示例导入会一次性写数百行数据，单列节点便于看清初始化耗时。
installDemo = traceFn('installDemo（导入示例小说）', installDemo, { kind: 'fn', slowMs: 500 });

// ---------- AI auto-create novel ----------
function extractJSON(text) {
  if (!text) throw new Error('AI 没有返回内容');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text.trim());
}

function asString(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v).trim();
}

// D5：剧情线标题前缀剥离（“主线：/支线：”由界面按 kind 显示，存储时不带前缀，避免“主线：主线：…”）
function stripPlotlinePrefix(title) {
  return String(title || '').replace(/^(?:主线|支线)\s*[:：]\s*/, '').trim();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function resolveRef(ref, names, idMap) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'number') {
    const name = names[ref];
    return name ? (idMap.get(name) ?? null) : null;
  }
  return idMap.get(String(ref).trim()) ?? null;
}

const NOVEL_GENERATION_SYSTEM_PROMPT = `你是一位资深小说设定生成器。用户会给你一段关于小说的描述，你需要帮他把这段描述完善成一本轻量小说的完整设定，并自动填充各栏目。

要求：
- 轻量快速规模：角色 3-6 个，设定词条 5-10 条，章节 3-8 个，剧情线 1-3 条。
- 如果用户提供的信息不足，可以合理补全，但不要和用户明显冲突；确实没有的内容可以省略或留空。
- 正文草稿：只在第一个章节的 content 字段里写一段 500-800 字左右的正文种子草稿；其他章节 content 留空字符串。（正式整章 2000 字以上请使用工坊内的「AI 写作」生成。）
- 只输出一个 JSON 对象，不要输出任何解释、不要 Markdown 代码块。

JSON 结构：
{
  "title": "作品名",
  "description": "作品简介",
  "volumes": [{ "title": "卷名", "summary": "卷简介" }],
  "plotlines": [{ "title": "剧情线名", "kind": "main 或 side", "summary": "简介" }],
  "categories": [{ "name": "分类名", "color": "#16进制颜色" }],
  "terms": [{ "title": "词条名", "category": "分类名或空", "content": "详细介绍", "tags": "逗号分隔标签" }],
  "characters": [{ "name": "姓名", "identity": "身份", "appearance": "外貌", "personality": "性格", "background": "背景", "status": "当前状态" }],
  "relations": [{ "from": "角色名A", "to": "角色名B", "relation": "关系", "description": "描述" }],
  "chapters": [{ "title": "章节名", "summary": "大纲摘要", "volume": "卷名或空", "plotline": "剧情线名或空", "content": "正文草稿" }],
  "plotline_characters": [{ "character": "角色名", "plotline": "剧情线名", "status": "在该剧情线中的状态", "notes": "备注" }]
}`;

// AI 自动创建小说主流程：调用模型 → 解析 JSON → 事务写入数据库。
async function generateNovelFromPrompt(prompt, config) {
  if (!prompt || !prompt.trim()) throw new Error('请输入一段小说描述');
  const messages = [
    { role: 'system', content: NOVEL_GENERATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt.trim() }
  ];

  let data;
  try {
    const ai = await callAI(config, messages, { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS });
    data = extractJSON(ai?.choices?.[0]?.message?.content || '');
  } catch (e) {
    // 仅对网络/超时/解析类错误重试一次；认证（401）等确定性错误直接抛出，避免浪费一次付费调用。
    const retryable = !e.status || e.status >= 500 || /timeout|abort|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|JSON|没有返回内容/i.test(String(e?.message || ''));
    if (!retryable) throw e;
    const retryMessages = [
      { role: 'system', content: NOVEL_GENERATION_SYSTEM_PROMPT + '\n\n请严格只输出 JSON，不要包含 ```json 标记，不要输出任何其他文字。' },
      { role: 'user', content: `请根据以下描述生成小说设定 JSON：\n\n${prompt.trim()}` }
    ];
    const ai = await callAI(config, retryMessages, { temperature: 0.3, max_tokens: MAX_OUTPUT_TOKENS });
    data = extractJSON(ai?.choices?.[0]?.message?.content || '');
  }

  return createNovelFromData(data);
}

// 把 AI 产出的简介整理成适合卡片展示的短摘要（D4：避免整篇 Markdown 存入 description）。
function shortDescription(text = '') {
  const plain = String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const first = plain.find((p) => p.length > 0) || '';
  return first.length > 160 ? first.slice(0, 160) + '…' : first;
}

// 把 AI 返回的小说设定 JSON 写入数据库。
function createNovelFromData(data) {
  const title = asString(data.title, '未命名作品');
  const description = shortDescription(asString(data.description, ''));

  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title, description });

    // 分类
    const categories = asArray(data.categories);
    const categoryIdByName = new Map();
    const categoryNames = [];
    categories.forEach((c, i) => {
      const name = asString(c.name, `分类${i + 1}`);
      const id = insertRow('categories', { work_id: workId, name, color: asString(c.color, '#6366f1'), position: i });
      categoryIdByName.set(name, id);
      categoryNames.push(name);
    });

    // 卷
    const volumes = asArray(data.volumes);
    const volumeIdByName = new Map();
    const volumeNames = [];
    volumes.forEach((v, i) => {
      const name = asString(v.title, `第${i + 1}卷`);
      const id = insertRow('volumes', { work_id: workId, title: name, summary: asString(v.summary), position: i });
      volumeIdByName.set(name, id);
      volumeNames.push(name);
    });

    // 剧情线
    const plotlines = asArray(data.plotlines);
    const plotlineIdByName = new Map();
    const plotlineNames = [];
    plotlines.forEach((p, i) => {
      const name = asString(p.title, `剧情线${i + 1}`);
      const kind = asString(p.kind) === 'side' ? 'side' : 'main';
      const id = insertRow('plotlines', { work_id: workId, title: stripPlotlinePrefix(name), kind, summary: asString(p.summary), position: i });
      plotlineIdByName.set(name, id);
      plotlineNames.push(name);
    });

    // 角色
    const characters = asArray(data.characters);
    const charIdByName = new Map();
    const charNames = [];
    characters.forEach((c, i) => {
      const name = asString(c.name, `角色${i + 1}`);
      const id = insertRow('characters', {
        work_id: workId,
        name,
        identity: asString(c.identity),
        appearance: asString(c.appearance),
        personality: asString(c.personality),
        background: asString(c.background),
        status: asString(c.status),
        avatar_color: '#8b5cf6',
        aliases: asString(c.aliases)
      });
      charIdByName.set(name, id);
      charNames.push(name);
    });

    // 设定词条
    const terms = asArray(data.terms);
    terms.forEach((t, i) => {
      const titleText = asString(t.title, `词条${i + 1}`);
      const catRef = resolveRef(t.category, categoryNames, categoryIdByName);
      insertRow('terms', {
        work_id: workId,
        category_id: catRef,
        title: titleText,
        content: asString(t.content),
        tags: asString(t.tags)
      });
    });

    // 章节/场景
    const chapters = asArray(data.chapters);
    chapters.forEach((ch, i) => {
      const titleText = asString(ch.title, `第${i + 1}章`);
      const volRef = resolveRef(ch.volume, volumeNames, volumeIdByName);
      const plRef = resolveRef(ch.plotline, plotlineNames, plotlineIdByName);
      insertRow('chapters', {
        work_id: workId,
        volume_id: volRef,
        plotline_id: plRef,
        parent_id: null,
        title: titleText,
        summary: asString(ch.summary),
        content: asString(ch.content),
        position: i
      });
    });

    // 人物关系
    const relations = asArray(data.relations);
    relations.forEach((r) => {
      const fromId = resolveRef(r.from, charNames, charIdByName);
      const toId = resolveRef(r.to, charNames, charIdByName);
      if (!fromId || !toId) return;
      insertRow('relations', {
        work_id: workId,
        from_character_id: fromId,
        to_character_id: toId,
        relation: asString(r.relation),
        description: asString(r.description)
      });
    });

    // 剧情线级角色状态
    const plotlineCharacters = asArray(data.plotline_characters);
    plotlineCharacters.forEach((pc) => {
      const charId = resolveRef(pc.character, charNames, charIdByName);
      const plId = resolveRef(pc.plotline, plotlineNames, plotlineIdByName);
      if (!charId || !plId) return;
      insertRow('plotline_characters', {
        work_id: workId,
        plotline_id: plId,
        character_id: charId,
        status: asString(pc.status),
        notes: asString(pc.notes)
      });
    });

    db.exec('COMMIT');
    return { work_id: workId, title };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 通过 DeepSeek Harness 生成完整小说并写入数据库。
async function generateNovelFromHarness(prompt, model) {
  if (!prompt || !prompt.trim()) throw new Error('请输入一段小说描述');
  const task = `${NOVEL_GENERATION_SYSTEM_PROMPT}\n\n请根据以下描述生成小说设定 JSON：\n\n${prompt.trim()}`;
  const output = await runHarnessTask(task, { timeout: 10 * 60 * 1000, model: model || undefined });
  const data = extractJSON(output);
  return createNovelFromData(data);
}

// ---------- Harness 任务队列（D1：AI 任务进度） ----------
// POST /harness/run 立即入队返回 job_id，任务在后台执行；
// 前端轮询 GET /harness/job?id= 获取状态、耗时与最近输出。
// D7：任务支持取消（POST /harness/cancel），杀掉 dsh 子进程树后状态置为 cancelled。
const harnessJobs = new Map(); // jobId -> { id, status, started_at, finished_at, output, scan, proposals, error, tail }

// ---------- harness 并发闸门（唯一入口）----------
// 闸门的意图是「防止刷出大量 dsh 子进程拖垮机器」。但此前只有 /harness/run 走作业设施、
// 被计数；另有两条路由直接调 runHarnessTask、不建 job，于是**完全绕过闸门**：
//   · POST /harness/generate_novel
//   · POST /story_memory/compress
// 现在它们也要占一个槽位；闸门值抽成常量，不再在两处各写一个 2。
const HARNESS_CONCURRENCY = 2;
let directHarnessRuns = 0; // 不走作业设施、直接跑 harness 的在途请求数

/** 当前 harness 负载 = 排队/运行中的作业数 + 直接跑的在途数。 */
function harnessLoad() {
  const jobCount = [...harnessJobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  return jobCount + directHarnessRuns;
}

/**
 * 占用一个并发槽位执行 fn；无空位时抛 429。
 * 检查与自增之间没有 await，单线程下即为原子操作。
 */
async function withHarnessSlot(fn) {
  if (harnessLoad() >= HARNESS_CONCURRENCY) {
    const err = new Error(`已有任务运行中，请稍后再试（并发上限 ${HARNESS_CONCURRENCY}）`);
    err.status = 429;
    throw err;
  }
  directHarnessRuns += 1;
  try {
    return await fn();
  } finally {
    directHarnessRuns -= 1;
  }
}

// ---------- 长任务落库（「刷新/重启后续接」的地基） ----------
// 内存里的 harnessJobs 一重启就没了，而一次成文/审稿要跑几分钟。
// 这里把 id/归属/状态/产出持久化，使「刷新页面」甚至「重启服务」后
// 仍能看见任务是否在跑、并把已完成的结果取回来应用。
function persistHarnessJob(job) {
  try {
    prepare(`
      INSERT INTO harness_jobs (id, work_id, chapter_id, kind, stage, status, output, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        output = excluded.output,
        error = excluded.error,
        stage = excluded.stage,
        updated_at = excluded.updated_at
    `).run(
      job.id,
      job.workId || null,
      job.chapterId || null,
      job.kind || 'harness',
      job.stage || '',
      job.status || 'queued',
      // 只在完成时存产出：中途不存半截正文，避免"半个章节"被当成结果应用
      job.status === 'done' ? String(job.output || '') : (job.status === 'failed' || job.status === 'timeout' ? String(job.output || '') : ''),
      job.error ? String(job.error).slice(0, 4000) : '',
      job.created_at || now(),
      now()
    );
    // 行数上限：每条 done 任务都带着整章正文（可达数万字符），表会无限增长。
    // 只保留最近 100 条；更早的任务即使被清掉，产出早已通过草稿/审稿表归档。
    prepare(`
      DELETE FROM harness_jobs WHERE id NOT IN (
        SELECT id FROM harness_jobs ORDER BY updated_at DESC LIMIT 100
      )
    `).run();
  } catch (e) {
    log({ level: 'warn', layer: 'server', kind: 'harness_job_persist_failed', message: `长任务落库失败：${e.message}` });
  }
}

/** 标记任务产出已被应用：恢复条不再把它当「结果待应用」展示。 */
function markHarnessJobApplied(jobId) {
  try {
    prepare(`
      UPDATE harness_jobs SET kind = kind || ':applied', updated_at = ?
      WHERE id = ? AND kind NOT LIKE '%:applied'
    `).run(now(), String(jobId));
  } catch (_) { /* 标记失败只影响恢复条显示 */ }
}

/** 可续接的长任务：运行中的 + 最近完成但还没被应用的。 */
function listRecoverableJobs(workId) {
  const rows = prepare(`
    SELECT id, work_id, chapter_id, kind, stage, status, error, updated_at,
           CASE WHEN status = 'done' THEN 1 ELSE 0 END AS has_output,
           length(output) AS output_chars
    FROM harness_jobs
    WHERE (? IS NULL OR work_id = ?)
      AND kind NOT LIKE '%:applied'
      AND (status IN ('queued', 'running') OR (status = 'done' AND length(output) > 0)
           OR status IN ('failed', 'timeout', 'cancelled'))
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(workId ?? null, workId ?? null);
  // 服务重启后内存里没有的任务标成 interrupted：进程已经没了，任务不可能还在跑。
  return rows.map((r) => {
    const live = harnessJobs.get(r.id);
    const status = live ? live.status : ((r.status === 'queued' || r.status === 'running') ? 'interrupted' : r.status);
    return {
      id: r.id,
      work_id: r.work_id,
      chapter_id: r.chapter_id,
      kind: r.kind,
      stage: r.stage,
      status,
      // ⚠️ 只有真正还在排队/运行中的任务才能「接回进度」。
      // 旧实现 `resumable: !!live` 把任何仍在内存里的任务（包括已完成/已失败的）
      // 都标成可续接，前端会对 done 任务显示「接回进度」按钮。
      resumable: !!live && (live.status === 'queued' || live.status === 'running'),
      has_output: r.has_output === 1,
      output_chars: r.output_chars || 0,
      error: r.error || '',
      updated_at: r.updated_at
    };
  });
}

/** 取回一条长任务：内存里有就优先用内存（进度最新），否则回落到库里的产出。 */
function getRecoverableJob(jobId) {
  const live = harnessJobs.get(String(jobId));
  if (live) {
    return {
      id: live.id, status: live.status, kind: live.kind || 'harness', stage: live.stage || '',
      chapter_id: live.chapterId || null, work_id: live.workId || null,
      elapsed_ms: live.started_at ? (live.finished_at || Date.now()) - live.started_at : 0,
      tail: live.tail.slice(-600),
      output: live.status === 'done' ? (live.output || '') : '',
      error: live.error || '', resumable: live.status === 'queued' || live.status === 'running',
      restart_lost: false
    };
  }
  const row = prepare('SELECT * FROM harness_jobs WHERE id = ?').get(String(jobId));
  if (!row) return null;
  return {
    id: row.id,
    // 服务重启后库里仍是 running 的任务：进程已不在，如实报告为 interrupted
    status: (row.status === 'queued' || row.status === 'running') ? 'interrupted' : row.status,
    kind: row.kind || 'harness',
    stage: row.stage || '',
    chapter_id: row.chapter_id,
    work_id: row.work_id,
    elapsed_ms: 0,
    tail: '',
    output: row.status === 'done' ? (row.output || '') : '',
    error: row.error || '',
    resumable: false,
    restart_lost: row.status === 'queued' || row.status === 'running'
  };
}

function createHarnessJob(prompt, options) {
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: 'queued',
    started_at: null,
    finished_at: null,
    output: null,
    scan: null,
    proposals: null,
    error: null,
    tail: '',
    // 归属与语义：供「后台继续 / 刷新后续接」认出这是哪一章的哪一步任务
    workId: options?.workId || null,
    chapterId: Number(options?.chapterId) || null,
    kind: options?.kind || 'harness',
    stage: String(options?.stage || '').slice(0, 120),
    // 决策 D4：模型槽位状态（'' | 'waiting' | 'running'）。界面据此显示"等待模型槽位"，
    // 而不是把"在队列里等"显示成"运行中"。
    model_slot: '',
    model_waiters: 0,
    created_at: now(),
    abort: new AbortController(),
    cancelRequested: false
  };
  harnessJobs.set(jobId, job);
  persistHarnessJob(job);
  // 清理：只保留最近 30 个任务，防止长时间运行内存增长。
  // 优先淘汰终态任务；若无终态任务，先 abort 最旧的运行中任务再淘汰，避免其「消失」却继续运行。
  if (harnessJobs.size > 30) {
    let evicted = null;
    for (const j of harnessJobs.values()) {
      if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) { evicted = j; break; }
    }
    if (!evicted) {
      evicted = harnessJobs.values().next().value;
      try { evicted?.abort?.abort(); } catch (_) { /* 忽略 */ }
    }
    if (evicted) harnessJobs.delete(evicted.id);
  }
  (async () => {
    job.status = 'running';
    job.started_at = Date.now();
    persistHarnessJob(job);
    try {
      const output = await runHarnessTaskWithProgress(prompt, {
        ...options,
        signal: job.abort.signal,
        // 决策 D4：把「等待模型槽位」如实反映到作业上。
        // ⚠️ 这里原先写着「前端本来就用 job.stage 显示进度，无需改前端」——**那句是错的**：
        // 实时轮询路径（public/app.js 的 pollHarnessJob）只喂 job.tail，从不读 job.stage，
        // 所以排队期间界面一片静止。现在双写：
        //   stage      —— 给人看的文案（也会存进可恢复任务列表）；
        //   model_slot —— 给前端做结构化判断（'' | 'waiting' | 'running'），别去正则匹配中文。
        onPhase: (phase, info) => {
          if (phase === 'waiting-model') {
            job.model_slot = 'waiting';
            job.model_waiters = Number(info?.waiters) || 1;
            if (!job.stage) {
              const ahead = Math.max(0, job.model_waiters - 1);
              job.stage = ahead > 0 ? `等待模型槽位（前面还有 ${ahead} 个任务）` : '等待模型槽位';
            }
          } else if (phase === 'running') {
            job.model_slot = 'running';
            job.model_waiters = 0;
            if (job.stage.startsWith('等待模型槽位')) job.stage = '';
          }
          persistHarnessJob(job);
        },
      }, (chunk) => {
        job.tail = (job.tail + chunk).slice(-2000);
      });
      job.status = 'done';
      job.output = output;
      // 生成后确定性红线扫描（反 AI 腔自检），随结果一起返回，不阻塞正文。
      const redlineRows = listRedlines(Number(options.workId) || null);
      const scanHits = scanAgainstRedlines(redlineRows, output);
      job.scan = { enabled: redlineRows.length > 0, total: scanHits.reduce((s, h) => s + h.count, 0), hits: scanHits.slice(0, 50) };
      // 提案模式收尾：把 AI 在本次任务里提交的事件/记忆提案一并带回，供作者确认。
      if (options.workId) job.proposals = listProposals(Number(options.workId));
    } catch (e) {
      job.status = e.code === 'HARNESS_TIMEOUT' ? 'timeout'
        : (e.code === 'HARNESS_CANCELLED' || job.cancelRequested) ? 'cancelled'
        : 'failed';
      job.error = job.status === 'cancelled' ? '任务已取消' : readableErrorMessage(e);
      job.tail = (job.tail + (e.stdoutTail || '')).slice(-2000);
      if (job.status !== 'cancelled') logAIError(options.action || 'harness', e, '/api/harness/run');
    } finally {
      job.finished_at = Date.now();
      // 终态落库：刷新页面/重启服务后仍能取回产出或得知任务已失败。
      persistHarnessJob(job);
    }
  })().catch(() => { /* 后台任务异常不影响 HTTP 层 */ });
  return job;
}

// ---------- 路由入口 ----------
// 统一处理 /api 下的请求：搜索、统计、AI、历史版本、关闭服务、通用 CRUD。
async function handleAPI(req, res, pathname, query) {
  const method = req.method;
  const segments = pathname.split('/').filter(Boolean);
  const resource = segments[1];
  const id = segments[2] ? parseId(segments[2]) : null;

  // 跨源写请求一律拒绝（浏览器页面防护；同源 UI 与无 Origin 的工具调用不受影响）
  if (!isLocalRequest(req)) {
    return sendError(res, 403, '跨源请求被拒绝：写操作仅允许本机工坊页面发起');
  }

  // ---------- 🐞 运行追踪（调试录制） ----------
  // 本组接口自身不参与追踪（debug-trace 的 isExcludedPath 排除 /api/debug），
  // 否则「查看追踪」这个动作会不断产生新的追踪数据。
  if (resource === 'debug') {
    const action = segments[2];
    if (method === 'GET' && action === 'state') {
      return sendJSON(res, 200, { ok: true, state: traceState(), config: traceConfigInfo() });
    }
    if (method === 'POST' && action === 'start') {
      const body = await readBody(req).catch(() => ({}));
      const out = startTracing({ from: body?.from || 'ui', work_id: body?.work_id ?? null });
      log({ level: 'info', layer: 'server', kind: 'trace_start', message: `运行追踪已开启（会话 ${out.session_id}）`, context: { session_id: out.session_id } });
      return sendJSON(res, 200, out);
    }
    if (method === 'POST' && action === 'stop') {
      const out = stopTracing('user');
      log({ level: 'info', layer: 'server', kind: 'trace_stop', message: `运行追踪已停止（会话 ${out.session_id || ''}）`, context: { summary: out.summary || null } });
      return sendJSON(res, 200, out);
    }
    if (method === 'POST' && action === 'ping') {
      pingTracing();
      return sendJSON(res, 200, { ok: true, ...traceState() });
    }
    if (method === 'POST' && action === 'op') {
      // 前端上报一次操作的客户端节点、渲染结果与 toast（第 9 题：调用时间 + 代码 + 代码响应）。
      const body = await readBody(req).catch(() => ({}));
      const opId = String(body.op_id || '');
      if (!opId) return sendError(res, 400, '缺少 op_id');
      const before = getOperation(opId, { withNodes: false });
      // force：录制刚停止时前端仍可能上报收尾数据，允许补建记录，避免丢掉前端调用链。
      beginOperation(opId, body.title || '前端操作', { source: 'client', force: true });
      const attached = body.nodes ? attachClientNodes(opId, body.nodes) : null;
      // 幂等保护：同一次操作重复上报（例如停录瞬间在途请求的收尾）不得重复收尾，
      // 否则会把已经结束的操作重新标成 running/done 并多写一条 op-end。
      const alreadySettled = before && before.summary && before.summary.status !== 'running';
      const summary = alreadySettled
        ? before.summary
        : finishOperation(opId, { status: body.status, render: body.render, toast: body.toast });
      return sendJSON(res, 200, { ok: true, attached, summary, deduped: !!alreadySettled });
    }
    if (method === 'GET' && action === 'ops') {
      return sendJSON(res, 200, { ok: true, ops: listOperations(), tools: listToolCalls(), summary: sessionSummary() });
    }
    if (method === 'GET' && action === 'op') {
      const opId = String(query.op_id || '');
      const live = opId ? getOperation(opId) : null;
      if (live) return sendJSON(res, 200, { ok: true, source: 'live', ...live });
      // 不在内存中（已停止录制或已被淘汰）→ 回退到会话文件
      const file = String(query.file || '');
      const session = file ? readSession(file) : null;
      const found = session ? session.ops.find((o) => o.opId === opId) : null;
      if (!found) return sendError(res, 404, '未找到该操作记录');
      return sendJSON(res, 200, { ok: true, source: 'file', file: session.file, summary: found.summary, nodes: found.nodes });
    }
    if (method === 'GET' && action === 'sessions') {
      return sendJSON(res, 200, { ok: true, sessions: listSessions(), dir: DEBUG_DIR });
    }
    if (method === 'GET' && action === 'session') {
      const session = readSession(String(query.file || ''), { nodeLimit: Number(query.node_limit) || 0 });
      if (!session) return sendError(res, 404, '未找到该录制文件');
      return sendJSON(res, 200, { ok: true, ...session });
    }
    if (method === 'DELETE' && action === 'purge') {
      const out = purgeSessions();
      return sendJSON(res, 200, { ok: out.ok !== false, ...out });
    }
    if (method === 'GET' && action === 'stream') {
      // SSE 实时推送录制中的节点流（未录制时也保持连接，便于前端一次连接用到底）。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = (batch) => {
        if (res.destroyed) return;
        for (const item of batch) {
          try {
            res.write(`data: ${JSON.stringify(item)}\n\n`);
          } catch (_) { /* 客户端已断开 */ }
        }
      };
      const unsubscribe = subscribeStream(send);
      res.write(`data: ${JSON.stringify({ type: 'hello', state: traceState() })}\n\n`);
      const beat = setInterval(() => {
        if (res.destroyed) return;
        try {
          res.write(': ping\n\n');
        } catch (_) { /* 忽略 */ }
      }, 20000);
      if (typeof beat.unref === 'function') beat.unref();
      const cleanup = () => {
        clearInterval(beat);
        unsubscribe();
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    return sendError(res, 404, `未知的调试接口：${action || ''}`);
  }

  if (resource === 'search' && method === 'GET') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const base = timed('server', '关键词检索（search）', () => search(query.q || '', workId), SLOW_REQUEST_MS);
    // 关键词检索 + OpenViking 语义检索合并返回（novel_lookup 与全局搜索共用）。
    const semantic = await timedAsync('sync', 'OpenViking 语义检索（semanticSearchMerge）', () => semanticSearchMerge(query.q || '', workId), 1000);
    return sendJSON(res, 200, { ...base, semantic });
  }

  if (resource === 'stats' && method === 'GET') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const stats = {};
    for (const [key, table] of Object.entries({
      chapters: 'chapters', terms: 'terms', characters: 'characters',
      plotlines: 'plotlines', volumes: 'volumes'
    })) {
      const row = workId
        ? prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE work_id = ?`).get(workId)
        : prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      stats[key] = row.c;
    }
    return sendJSON(res, 200, stats);
  }

  // 示例小说演示数据：一键导入/删除（UI 在“我的作品”页）
  if (resource === 'demo' && method === 'GET' && segments[2] === 'status') {
    const row = demoFindWork(DEMO_TITLE);
    return sendJSON(res, 200, { ok: true, exists: !!row, title: DEMO_TITLE, work_id: row ? row.id : null });
  }
  if (resource === 'demo' && method === 'POST' && segments[2] === 'install') {
    const body = await readBody(req);
    try {
      const result = installDemo(body.force === true);
      const demo = demoFindWork(DEMO_TITLE);
      if (demo) syncWorkFull(demo.id).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `示例作品同步失败：${e.message}` }));
      return sendJSON(res, 201, { ok: true, ...result });
    } catch (e) {
      const status = /已存在|重新导入/.test(e.message) ? 409 : 500;
      return sendError(res, status, e.message);
    }
  }
  if (resource === 'demo' && method === 'POST' && segments[2] === 'remove') {
    const demo = demoFindWork(DEMO_TITLE);
    const removed = deleteDemoWork(DEMO_TITLE);
    if (removed && demo) removeWorkFromMemory(demo.id).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `示例作品目录移除失败：${e.message}` }));
    return sendJSON(res, 200, { ok: true, removed });
  }

  // 导入：TXT/Markdown 文本 或 EPUB（base64），新建作品并自动拆章。
  if (resource === 'import' && method === 'POST') {
    const body = await readBody(req);
    let title = asString(body.title, '');
    let chapters = [];
    try {
      if (body.base64) {
        const b64 = String(body.base64);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
          return sendError(res, 400, '文件不是有效的 base64/EPUB');
        }
        const bin = Buffer.from(b64, 'base64');
        if (bin.length > 24 * 1024 * 1024) return sendError(res, 413, 'EPUB 文件过大（上限 24MB）');
        const epub = parseEpub(bin);
        title = title || epub.title;
        chapters = epub.chapters;
      } else if (body.text !== undefined) {
        const text = String(body.text);
        if (!text.trim()) return sendError(res, 400, '导入内容为空');
        chapters = splitTextIntoCapters(text);
      } else {
        return sendError(res, 400, '缺少 text 或 base64');
      }
    } catch (e) {
      return sendError(res, 400, `解析失败：${e.message}`);
    }
    if (!chapters.length) return sendError(res, 400, '未能从文件中解析出章节内容');
    try {
      const workId = importWorkFromChapters(title, chapters, '由导入文件创建');
      syncWorkFull(workId).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `导入作品同步失败（work ${workId}）：${e.message}` }));
      return sendJSON(res, 201, { ok: true, work_id: workId, title: title || '导入的作品', chapters: chapters.length });
    } catch (e) {
      const status = /作品名称不能为空/.test(e.message) ? 400 : 500;
      return sendError(res, status, `写入失败：${e.message}`);
    }
  }

  // 导出：整书 TXT / 整书 Markdown / 单章 TXT（浏览器直接下载）。
  if (resource === 'export' && method === 'GET') {
    const fmt = segments[2];
    const workId = Number(query.work_id) || null;
    const chapterId = Number(query.chapter_id) || null;
    let text = null;
    let fileName = 'novel.txt';
    if (fmt === 'txt' && workId) {
      text = timed('server', '整书 TXT 导出（buildWorkExport）', () => buildWorkExport(workId, 'txt'), SLOW_REQUEST_MS);
      const work = prepare('SELECT title FROM works WHERE id = ?').get(workId);
      if (work) fileName = `${work.title || 'novel'}.txt`;
    } else if (fmt === 'md' && workId) {
      text = timed('server', '整书 Markdown 导出（buildWorkExport）', () => buildWorkExport(workId, 'md'), SLOW_REQUEST_MS);
      const work = prepare('SELECT title FROM works WHERE id = ?').get(workId);
      if (work) fileName = `${work.title || 'novel'}.md`;
    } else if (fmt === 'txt' && chapterId) {
      text = timed('server', '单章 TXT 导出（buildChapterExport）', () => buildChapterExport(chapterId), SLOW_REQUEST_MS);
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (chapter) fileName = `${chapter.title || 'chapter'}.txt`;
    }
    if (text === null) return sendError(res, 404, '导出对象不存在或格式不支持');
    const encoded = encodeURIComponent(fileName).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store'
    });
    res.end(text);
    return;
  }

  // AI 上下文：角色卡 / 世界观 / 作者注（+ OpenViking 语义召回层）
  //
  // P2 起，**提示词里实际使用的那段文本**不再由前端拼装，而是走与 /api/novel/context
  // 完全相同的唯一装配器（ai/context/assembler.mjs，经 buildNovelContext）。
  // 原因（契约 I5/I6）：前端 aiContextBlock 的拼装没有任何预算——压力数据下同一章
  // 它喂进去约 7.4 万字，而受预算约束的路径只有 2.4 万字；两条路径渲染同一份数据
  // 却差 3 倍，是上下文质量最大的结构性缺口。
  //
  // buildAIContext 的结构化字段继续返回：界面的「上下文预览」面板仍在用它（需要更细的字段）。
  if (resource === 'ai_context' && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const ctx = timed('server', 'AI 上下文装配（buildAIContext）', () => buildAIContext(chapterId), SLOW_REQUEST_MS);
    if (!ctx) return sendError(res, 404, '章节不存在');
    // 语义召回随 AI 上下文一起注入正文写作提示词；复用 buildAIContext 已加载的章节行，避免二次查询。
    // 先调用一次把召回微缓存焐热，随后的 buildNovelContext 会命中同一个键。
    let recall = { enabled: false, status: 'disabled', hits: [] };
    try {
      recall = await getSemanticRecall(ctx.work.id, ctx._chapter || null);
    } catch (_) { /* 召回失败不阻塞 */ }
    const workId = ctx.work.id;
    delete ctx._chapter; // 内部字段不外泄给前端

    // 预算内的分层装配：与 /api/novel/context 共用同一份缓存与实现（契约 I5/I6）
    const cacheKey = `novel:${workId}:${chapterId}:full`;
    let budgeted = cacheGetContext(cacheKey);
    if (budgeted === undefined) {
      budgeted = await buildNovelContext(workId, chapterId, 'full');
      if (budgeted) cacheSetContext(cacheKey, budgeted);
    }

    return sendJSON(res, 200, {
      ...ctx,
      semantic_recall: { enabled: recall.enabled, status: recall.status, hits: recall.hits || [] },
      // 提示词使用的分层文本（前端 aiContextBlock 直接采用它），以及配套的裁剪清单
      assembled: budgeted ? budgeted.assembled : '',
      context_manifest: budgeted ? budgeted.context_manifest : [],
      context_overflow: budgeted ? budgeted.context_overflow : null,
      context_stats: budgeted ? budgeted.context_stats : null
    });
  }

  // 长期记忆 / 故事摘要
  if (resource === 'story_memory' && method === 'POST' && segments[2] === 'compress') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    try {
      const summary = await withHarnessSlot(() => compressStoryMemory(workId));
      notifyChange('story_memory', { workId, id: workId });
      return sendJSON(res, 200, { ok: true, summary });
    } catch (e) {
      const status = e.status === 429 ? 429 : (/作品不存在/.test(e.message) ? 404 : 502);
      return sendError(res, status, e.message);
    }
  }
  if (resource === 'story_memory' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (segments[2] === 'versions') {
      return sendJSON(res, 200, { work_id: workId, versions: listMemoryVersions(workId) });
    }
    return sendJSON(res, 200, { work_id: workId, summary: getStoryMemory(workId) });
  }
  if (resource === 'story_memory' && method === 'POST' && segments[2] === 'rollback') {
    const body = await readBody(req);
    const versionId = Number(body.version_id);
    if (!versionId) return sendError(res, 400, '缺少 version_id');
    try {
      const result = rollbackMemory(versionId);
      const vrow = prepare('SELECT work_id FROM memory_versions WHERE id = ?').get(versionId);
      if (vrow?.work_id) notifyChange('story_memory', { workId: vrow.work_id, id: vrow.work_id });
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendError(res, 404, e.message);
    }
  }
  if (resource === 'story_memory' && method === 'PUT') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    // headless 生成任务先落提案（作者确认后写入并留版本快照）。
    if (body.proposed === true) {
      const result = addMemoryProposal(workId, {
        summary: asString(body.summary, ''),
        delta: asString(body.delta, ''),
        note: asString(body.note, 'dsh 创作插件提案')
      });
      return sendJSON(res, 200, { ok: true, ...result, work_id: workId });
    }
    // summary 直接提交；或 delta 增量：与当前摘要做安全拼接（语义压缩由调用方模型完成）。
    let summary = asString(body.summary, '');
    if (!summary && body.delta) {
      summary = mergeMemoryDraft(getStoryMemory(workId), asString(body.delta, ''));
    }
    const result = saveStoryMemory(workId, summary, {
      source: body.source || 'manual',
      note: body.note || ''
    });
    notifyChange('story_memory', { workId, id: workId });
    return sendJSON(res, 200, { ...result, work_id: workId });
  }

  // ---------- Novel Studio 创作内核（供 dsh 插件 / 后台自动化调用） ----------
  if (resource === 'novel' && segments[2] === 'ping' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, service: 'novel-studio', engine: 'novel-core', port: PORT });
  }
  if (resource === 'novel' && segments[2] === 'context' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const chapterId = Number(query.chapter_id) || null;
    const mode = asString(query.mode, 'full');
    // 装配结果缓存：任何写操作（touchWork）都会使版本号前进、缓存整体失效。
    const cacheKey = `novel:${workId}:${chapterId || 0}:${mode}`;
    let ctx = cacheGetContext(cacheKey);
    if (ctx === undefined) {
      ctx = await buildNovelContext(workId, chapterId, mode);
      if (ctx) cacheSetContext(cacheKey, ctx);
    }
    if (!ctx) return sendError(res, 404, '作品不存在');
    return sendJSON(res, 200, ctx);
  }
  if (resource === 'novel' && segments[2] === 'semantic' && method === 'GET') {
    const healthy = await ovClient.health();
    return sendJSON(res, 200, {
      ok: true,
      enabled: ovEffectiveEnabled(),
      setting_enabled: semanticEnabled(),
      healthy,
      base: workDir(0).replace(/\/0$/, ''),
      pending: pendingQueueLength()
    });
  }
  if (resource === 'novel' && segments[2] === 'semantic' && method === 'PUT') {
    const body = await readBody(req);
    const enabled = body.enabled !== false;
    setAppSetting('ov_semantic_enabled', enabled ? '1' : '0');
    return sendJSON(res, 200, { ok: true, enabled });
  }
  if (resource === 'novel' && segments[2] === 'semantic_index' && method === 'POST') {
    const body = await readBody(req);
    if (!ovEffectiveEnabled()) return sendError(res, 400, '语义集成未启用（请先在上下文页签打开开关）');
    const workId = Number(body.work_id) || null;
    const healthy = await ovClient.health();
    if (!healthy) return sendError(res, 503, 'OpenViking 服务器不可用，无法建索引');
    const targets = workId
      ? [workId]
      : prepare('SELECT id FROM works ORDER BY id ASC').all().map((w) => w.id);
    for (const wid of targets) {
      syncWorkFull(wid).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `重建索引失败（work ${wid}）：${e.message}` }));
    }
    return sendJSON(res, 202, { ok: true, scheduled: targets.length, message: '索引任务已排队（异步向量化，需要一些时间）' });
  }
  if (resource === 'novel' && segments[2] === 'redlines' && method === 'GET') {
    const workId = Number(query.work_id) || null;
    return sendJSON(res, 200, { work_id: workId, redlines: listRedlines(workId) });
  }
  if (resource === 'novel' && segments[2] === 'redlines' && method === 'PUT') {
    const body = await readBody(req);
    const workId = Number(body.work_id) || null;
    try {
      const redlines = replaceRedlines(workId, body.entries || []);
      touchWork(workId); // 全局红线（workId 为空）同样影响所有作品的上下文缓存，需整体失效
      return sendJSON(res, 200, { ok: true, work_id: workId, redlines });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }
  if (resource === 'novel' && segments[2] === 'scan' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id) || null;
    const hits = scanAgainstRedlines(listRedlines(workId), asString(body.text, ''), { skip_dialogue: body.skip_dialogue === true });
    return sendJSON(res, 200, { ok: true, work_id: workId, total: hits.reduce((s, h) => s + h.count, 0), hits });
  }
  if (resource === 'novel' && segments[2] === 'events' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, { work_id: workId, events: listStoryEvents(workId, Number(query.limit) || 40) });
  }
  if (resource === 'novel' && segments[2] === 'events' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    // 写事件前校验作品存在，避免外键违约冒泡为 500（非法输入应返回 4xx）。
    const work = prepare('SELECT id FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    const fields = {
      chapterId: Number(body.chapter_id) || null,
      kind: asString(body.kind, 'event'),
      summary: asString(body.summary, ''),
      payload: body.payload || {},
      foreshadowStatus: asString(body.foreshadow_status, ''),
      resolvesEventId: Number(body.resolves_event_id) || null,
      dedupKey: asString(body.dedup_key, '')
    };
    if (!fields.summary.trim()) return sendError(res, 400, '缺少 summary');
    if (fields.chapterId) {
      const ch = prepare('SELECT id, work_id FROM chapters WHERE id = ?').get(fields.chapterId);
      if (!ch) return sendError(res, 400, '章节不存在');
      if (Number(ch.work_id) !== workId) return sendError(res, 400, '章节不属于该作品');
    }
    // headless 生成任务（NOVELSTUDIO_PROPOSE_MODE=1）先落提案，作者在工坊界面确认后入账。
    if (body.proposed === true) {
      const result = addEventProposal(workId, { ...fields, note: asString(body.note, 'dsh 创作插件提案') });
      return sendJSON(res, 201, { ok: true, ...result, work_id: workId });
    }
    const result = addStoryEvent(workId, fields);
    notifyChange('events', { workId, id: workId });
    return sendJSON(res, 201, { ok: true, id: result.id, duplicate: result.duplicate, work_id: workId });
  }
  if (resource === 'novel' && segments[2] === 'foreshadows' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const status = asString(query.status, 'open');
    const all = listStoryEvents(workId, 500).filter((e) => e.kind === 'foreshadow');
    const rows = status === 'all' ? all : all.filter((e) => e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped');
    return sendJSON(res, 200, { ok: true, work_id: workId, status, foreshadows: rows });
  }
  if (resource === 'novel' && segments[2] === 'foreshadows' && segments[3] && segments[4] === 'status' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(segments[3]);
    const status = asString(body.status, '');
    if (!['open', 'resolved', 'dropped'].includes(status)) return sendError(res, 400, 'status 必须是 open/resolved/dropped');
    const row = prepare('SELECT * FROM story_events WHERE id = ? AND kind = ?').get(id, 'foreshadow');
    if (!row) return sendError(res, 404, '伏笔不存在');
    prepare('UPDATE story_events SET foreshadow_status = ? WHERE id = ?').run(status, id);
    if (status === 'resolved' && body.resolves_event_id) {
      const rid = Number(body.resolves_event_id);
      const target = prepare('SELECT id FROM story_events WHERE id = ? AND work_id = ?').get(rid, row.work_id);
      if (!target) return sendError(res, 404, '回收事件不存在或不属于该作品');
      prepare('UPDATE story_events SET resolves_event_id = ? WHERE id = ?').run(rid, id);
    }
    touchWork(row.work_id);
    notifyChange('events', { workId: row.work_id, id: row.work_id });
    return sendJSON(res, 200, { ok: true, id, foreshadow_status: status });
  }
  if (resource === 'novel' && segments[2] === 'proposals' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, { ok: true, work_id: workId, proposals: listProposals(workId) });
  }
  if (resource === 'novel' && segments[2] === 'proposals' && method === 'POST' && (segments[3] === 'apply' || segments[3] === 'reject')) {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const result = settleProposals(workId, { ids: body.ids, all: body.all === true, action: segments[3] });
    if (segments[3] === 'apply' && result?.applied && (result.applied.events > 0 || result.applied.memories > 0)) {
      notifyChange('events', { workId, id: workId });
      notifyChange('story_memory', { workId, id: workId });
    }
    return sendJSON(res, 200, result);
  }
  if (resource === 'novel' && segments[2] === 'consistency' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    const text = asString(body.text, '');
    // 确定性装配核对清单：AI 逐项对照 text 判断，报告冲突即可。
    const allEvents = listStoryEvents(workId, 500);
    const openForeshadows = allEvents
      .filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped')
      .map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id }));
    const recentEvents = allEvents.slice(0, 30).map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, foreshadow_status: e.foreshadow_status }));
    // 出场角色按名字/别名整词命中；每个角色附上与它相关的最近事件，
    // 供 AI 判断“角色卡当前状态是否已被最近事件改变”（状态过时检测的依据）。
    const allCharRows = prepare('SELECT * FROM characters WHERE work_id = ?').all(workId);
    const presentCharacters = allCharRows
      .filter((c) => c.name && namesOfCharacter(c).some((nm) => countNameHits(nm, text) > 0))
      .map((c) => ({
        id: c.id, name: c.name, identity: c.identity, status: c.status,
        related_events: recentEvents.filter((e) => namesOfCharacter(c).some((nm) => countNameHits(nm, e.summary) > 0)).slice(0, 5)
      }));
    const scan = scanAgainstRedlines(listRedlines(workId), text);
    const memory = getStoryMemory(workId);
    return sendJSON(res, 200, {
      ok: true, work_id: workId,
      checklist: {
        open_foreshadows: openForeshadows,
        present_characters: presentCharacters,
        recent_events: recentEvents,
        story_memory: memory,
        style_scan: { total: scan.reduce((s, h) => s + h.count, 0), hits: scan.slice(0, 20) }
      }
    });
  }
  // 章节蓝图保存（写作前规划 → 落库 → 随上下文带入 → 一致性核对锚点）。
  if (resource === 'novel' && segments[2] === 'chapter_blueprint' && method === 'PUT') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const raw = body.blueprint && typeof body.blueprint === 'object' ? body.blueprint : {};
    const BLUEPRINT_KEYS = ['scene_goal', 'plot_points', 'conflicts', 'character_changes', 'hook', 'references'];
    const blueprint = {};
    for (const key of BLUEPRINT_KEYS) {
      blueprint[key] = asString(raw[key], '').slice(0, 2000);
    }
    if (!Object.values(blueprint).some((v) => v)) return sendError(res, 400, '蓝图内容不能为空');
    const targetWords = Number(body.target_words) || 0;
    prepare('UPDATE chapters SET blueprint_json = ?, target_words = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(blueprint), targetWords > 0 ? Math.min(Math.max(1, Math.floor(targetWords)), 20000) : 0, now(), chapterId);
    touchWork(chapter.work_id);
    const work = prepare('SELECT default_chapter_words FROM works WHERE id = ?').get(chapter.work_id);
    const effective = targetWords > 0 ? targetWords : (Number(work?.default_chapter_words) || 2000);
    return sendJSON(res, 200, { ok: true, chapter_id: chapterId, blueprint, target_words: effective });
  }
  // 章节审稿：保存报告 / 读取最新 / 提交确认清单
  if (resource === 'novel' && segments[2] === 'review' && method === 'PUT' && !segments[3]) {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const report = body.report && typeof body.report === 'object' ? body.report : {};
    const rawText = asString(body.raw_text, '');
    // 有原文兜底时不再拒绝：报告解析失败也必须留下可回看的证据。
    if (!asString(report.summary, '').trim() && !asArray(report.issues).length && !rawText.trim()) {
      return sendError(res, 400, '审稿报告不能为空');
    }
    const reviewId = saveReview(chapter.work_id, chapterId, report, {
      rawText,
      status: body.status === 'raw' || (!asString(report.summary, '').trim() && !asArray(report.issues).length) ? 'raw' : 'parsed'
    });
    return sendJSON(res, 201, { ok: true, review_id: reviewId, status: rawText && !asString(report.summary, '').trim() ? 'raw' : 'parsed' });
  }
  if (resource === 'novel' && segments[2] === 'review' && method === 'GET') {    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const review = getLatestReview(chapterId);
    if (!review) return sendJSON(res, 200, { ok: true, review: null });
    const report = review.report || {};
    // 让界面不必自己判断可信度：解析成功与否、能否直接走「按清单修稿」。
    return sendJSON(res, 200, {
      ok: true,
      review: {
        ...review,
        parsed: !!(asString(report.summary, '').trim() || asArray(report.issues).length),
        issue_count: asArray(report.issues).length,
        strength_count: asArray(report.strengths).length,
        // 原文可能高达 200KB，回看列表不需要全量——只带预览，完整原文仍在库里可查。
        raw_text: asString(report.raw_text, '').slice(0, 20000),
      }
    });
  }

  // 长任务产出回填：刷新页面或重启服务后，前端拿回输出再交给这里解析落地，
  // 保证「任务跑完了」和「结果存下来了」不依赖页面是否还开着。
  if (resource === 'novel' && segments[2] === 'finalize' && method === 'POST') {
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const chapterId = Number(body.chapter_id) || null;
    const output = asString(body.output, '');
    const jobId = String(body.job_id || '');
    if (!kind) return sendError(res, 400, '缺少 kind');
    if (!output.trim()) return sendError(res, 400, '缺少 output');
    if (kind === 'review') {
      if (!chapterId) return sendError(res, 400, '审稿回填缺少 chapter_id');
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (!chapter) return sendError(res, 404, '章节不存在');
      const parsed = parseReviewText(output);
      const report = parsed || { summary: '', issues: [], strengths: [] };
      const reviewId = saveReview(chapter.work_id, chapterId, report, {
        rawText: parsed ? '' : output.slice(0, 200000),
        status: parsed ? 'parsed' : 'raw'
      });
      if (jobId) markHarnessJobApplied(jobId);
      return sendJSON(res, 201, { ok: true, review_id: reviewId, parsed: !!parsed, issue_count: parsed ? parsed.issues.length : 0 });
    }
    // 成文类产出：落成章节草稿，由界面「取回生成稿」应用，绝不自动覆盖正文。
    if (!chapterId) return sendError(res, 400, '成文回填缺少 chapter_id');
    const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    if (!chapter) return sendError(res, 404, '章节不存在');
    const version = saveChapterVersion(chapterId, chapter.title, '', output, 'draft');
    if (jobId) markHarnessJobApplied(jobId);
    return sendJSON(res, 201, { ok: true, kind, draft_id: Number(version.id), chars: plainText(output).length });
  }

  // 生成稿草稿：AI 成文结果在结果弹窗出现时即落库，关闭弹窗不再等于丢失。
  if (resource === 'novel' && segments[2] === 'draft' && method === 'POST') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const content = asString(body.content, '');
    if (!plainText(content).trim()) return sendError(res, 400, '草稿内容为空');
    const version = saveChapterVersion(chapterId, chapter.title, '', content, 'draft');
    return sendJSON(res, 201, { ok: true, draft_id: Number(version.id), chars: plainText(content).length });
  }
  if (resource === 'novel' && segments[2] === 'draft' && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    return sendJSON(res, 200, { ok: true, draft: getLatestDraft(chapterId) });
  }
  if (resource === 'novel' && segments[2] === 'review' && segments[3] === 'checklist' && method === 'PUT') {
    const body = await readBody(req);
    const reviewId = Number(body.review_id);
    if (!reviewId) return sendError(res, 400, '缺少 review_id');
    const id = setReviewChecklist(reviewId, body.checklist || {});
    if (id === null) return sendError(res, 404, '审稿不存在');
    return sendJSON(res, 200, { ok: true, review_id: id });
  }
  // 批量生成辅助：列出尚无正文的顶层章节（按顺序）
  if (resource === 'novel' && segments[2] === 'empty_chapters' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const rows = prepare(`
      SELECT id, title, summary, position FROM chapters
      WHERE work_id = ? AND (content IS NULL OR content = '') AND parent_id IS NULL
      ORDER BY position ASC, id ASC
    `).all(workId);
    return sendJSON(res, 200, { ok: true, work_id: workId, chapters: rows });
  }
  if (resource === 'novel' && segments[2] === 'chapter_save' && method === 'POST') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const content = asString(body.content, '');
    if (!content.trim()) return sendError(res, 400, '缺少 content');
    // 旧稿先入历史版本（可恢复），再覆盖正文；返回红线扫描供界面展示。
    const version = saveChapterVersion(chapterId, chapter.title, chapter.summary, chapter.content);
    const title = body.title !== undefined ? asString(body.title, chapter.title) : chapter.title;
    const summary = body.summary !== undefined ? asString(body.summary, chapter.summary) : chapter.summary;
    prepare('UPDATE chapters SET title = ?, summary = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(title, summary, content, now(), chapterId);
    touchWork(chapter.work_id);
    notifyChange('chapters', { workId: chapter.work_id, id: chapterId });
    const hits = scanAgainstRedlines(listRedlines(chapter.work_id), plainText(content));
    return sendJSON(res, 200, {
      ok: true, chapter_id: chapterId, version_id: Number(version.id),
      scan: { total: hits.reduce((s, h) => s + h.count, 0), hits: hits.slice(0, 20) }
    });
  }

  // DeepSeek Harness 桥接
  if (resource === 'harness' && method === 'GET' && segments[2] === 'status') {
    return sendJSON(res, 200, {
      ok: true,
      available: isHarnessAvailable(),
      built: isHarnessBuilt(),
      // 决策 D4：模型切换互斥的当前负载。服务端允许 2 个作业，但请求了模型/强度的任务会串行，
      // 这里把真实排队情况暴露出来，而不是让调用方从"运行中"猜。
      model_load: modelSwitchLoad(),
      concurrency: HARNESS_CONCURRENCY
    });
  }

  // D1：AI 任务进度。POST /harness/run 立即返回 job_id，任务在后台执行；
  // 前端通过 GET /harness/job?id= 轮询状态（阶段/耗时/最近输出），解决「界面静止 10 分钟」的问题。

  if (resource === 'harness' && method === 'POST' && segments[2] === 'run') {
    const body = await readBody(req);
    if (!body.prompt || !String(body.prompt).trim()) return sendError(res, 400, '缺少 prompt');
    const env = {
      NOVELSTUDIO_BASE_URL: `http://127.0.0.1:${PORT}`,
      // 提案模式：headless 生成任务里 AI 的事件/记忆入账先落提案，
      // 由作者在工坊界面确认后写入，避免 AI 自作主张污染真实账本。
      NOVELSTUDIO_PROPOSE_MODE: '1'
    };
    if (body.work_id) env.NOVELSTUDIO_WORK_ID = String(body.work_id);
    if (body.chapter_id) env.NOVELSTUDIO_CHAPTER_ID = String(body.chapter_id);
    if (body.mode) env.NOVELSTUDIO_MODE = String(body.mode);
    // 并发上限：同时最多 HARNESS_CONCURRENCY 个运行中/排队任务，防止刷出大量 dsh 子进程拖垮机器。
    // 负载 = 作业设施里的排队/运行中 + 直接跑 harness 的在途请求（两条旁路也算）。
    if (harnessLoad() >= HARNESS_CONCURRENCY) return sendError(res, 429, `已有任务运行中，请稍后再试（并发上限 ${HARNESS_CONCURRENCY}）`);
    // 超时钳制：1s ~ 60min，拒绝近乎无限的后台任务。
    const timeout = Math.min(Math.max(1000, Math.floor(Number(body.timeout) || 10 * 60 * 1000)), 60 * 60 * 1000);
    // 思考强度：非法值在入队前就 400，避免任务排到队才在 dsh 子进程里失败。
    const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort);
    if (body.reasoning_effort && !reasoningEffort) {
      return sendError(res, 400, `非法思考强度：仅允许 ${[...DEEPSEEK_REASONING_EFFORTS].join(' / ')}`);
    }
    const job = createHarnessJob(String(body.prompt).trim(), {
      timeout,
      model: body.model || undefined,
      reasoningEffort: reasoningEffort || undefined,
      env,
      action: body.action || 'harness',
      workId: Number(body.work_id) || null,
      // 归属与语义：让「刷新/重启后续接」知道这是哪一章的哪一步任务。
      chapterId: Number(body.chapter_id) || null,
      kind: String(body.kind || body.action || 'harness').slice(0, 40),
      stage: String(body.stage || '').slice(0, 120)
    });
    return sendJSON(res, 202, { ok: true, job_id: job.id, status: job.status, kind: job.kind, stage: job.stage });
  }

  // 「后台继续 / 刷新后续接」：列出本作品还没收尾（或已完成但可能没用上）的长任务。
  if (resource === 'harness' && method === 'GET' && segments[2] === 'recoverable') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const chapterId = query.chapter_id ? Number(query.chapter_id) : null;
    let jobs = listRecoverableJobs(workId);
    if (chapterId) jobs = jobs.filter((j) => Number(j.chapter_id) === chapterId || j.chapter_id === null);
    return sendJSON(res, 200, { ok: true, jobs });
  }

  // 取回一条长任务（含产出）。刷新页面或重启服务后仍可用。
  if (resource === 'harness' && method === 'GET' && segments[2] === 'recovered') {
    const job = getRecoverableJob(String(query.id || ''));
    if (!job) return sendError(res, 404, '任务记录不存在');
    return sendJSON(res, 200, { ok: true, job });
  }

  // 标记任务产出已被应用（成文弹窗打开 / 审稿报告展示 / 修稿差异预览之后调用）。
  // 作用：恢复条不再把这条任务当「已完成，结果待应用」重复提示。
  if (resource === 'harness' && method === 'POST' && segments[2] === 'mark_applied') {
    const body = await readBody(req).catch(() => ({}));
    const jobId = String(body.job_id || '');
    if (!jobId) return sendError(res, 400, '缺少 job_id');
    markHarnessJobApplied(jobId);
    return sendJSON(res, 200, { ok: true });
  }

  if (resource === 'harness' && method === 'GET' && segments[2] === 'job') {
    const jobId = query.id || segments[3];
    const job = harnessJobs.get(String(jobId));
    if (!job) return sendError(res, 404, '任务不存在或已过期（服务重启后旧任务会丢失）');
    return sendJSON(res, 200, {
      ok: true,
      id: job.id,
      status: job.status,
      kind: job.kind || 'harness',
      stage: job.stage || '',
      // 决策 D4：排队状态必须能被前端**结构化**读到。此前只回 stage 文案，
      // 而实时轮询根本不显示 stage，于是"在等槽位"与"运行中"在界面上无法区分。
      model_slot: job.model_slot || '',
      model_waiters: Number(job.model_waiters) || 0,
      chapter_id: job.chapterId || null,
      work_id: job.workId || null,
      elapsed_ms: job.started_at ? (job.finished_at || Date.now()) - job.started_at : 0,
      tail: job.tail.slice(-600),
      output: job.status === 'done' ? job.output : null,
      scan: job.status === 'done' ? job.scan : null,
      proposals: job.status === 'done' ? job.proposals : null,
      error: job.error
    });
  }

  // D7：取消正在运行的 harness 任务（杀掉 dsh 子进程树，状态置为 cancelled）
  if (resource === 'harness' && method === 'POST' && segments[2] === 'cancel') {
    const body = await readBody(req);
    const job = harnessJobs.get(String(body.job_id || ''));
    if (!job) return sendError(res, 404, '任务不存在或已结束');
    if (job.status === 'queued' || job.status === 'running') {
      job.cancelRequested = true;
      persistHarnessJob(job);
      try { job.abort?.abort(); } catch (_) { /* 忽略 */ }
      return sendJSON(res, 200, { ok: true, id: job.id, status: 'cancelling' });
    }
    return sendJSON(res, 200, { ok: true, id: job.id, status: job.status });
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'generate_novel') {
    const body = await readBody(req);
    try {
      // 同步跑 harness 的路由也要占并发槽位（此前完全绕过闸门）。
      const result = await withHarnessSlot(() => generateNovelFromHarness(body.prompt, body.model));
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      // 429 是闸门拒绝，不是 AI 调用失败——不该混进 AI 错误日志。
      if (e.status === 429) return sendError(res, 429, e.message);
      logAIError('generate_novel', e, '/api/harness/generate_novel');
      return sendError(res, 502, e.message);
    }
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'stop') {
    // headless 模式每次任务独立进程，无常驻进程可停止；明确返回未实现，避免「成功」假象。
    return sendError(res, 501, 'Harness 常驻停止接口未实现');
  }

  // AI error history
  if (resource === 'ai_errors' && method === 'GET') {
    return sendJSON(res, 200, listAIErrors());
  }

  // ---------- 统一日志系统 ----------
  // GET  查询（可按 level/layer/kind/q 筛选，before_id 翻页）；返回 entries + 统计。
  // POST 远端上报（浏览器前端 / dsh 插件进程）；DELETE 清空。
  if (resource === 'logs' && method === 'GET') {
    const result = queryLogs({
      level: query.level || '',
      layer: query.layer || '',
      kind: query.kind || '',
      q: query.q || '',
      limit: query.limit ? Number(query.limit) : 100,
      beforeId: query.before_id ? Number(query.before_id) : null
    });
    return sendJSON(res, 200, result);
  }
  if (resource === 'logs' && method === 'POST') {
    const body = await readBody(req);
    const layer = String(body.layer || '');
    if (!REMOTE_LAYERS.includes(layer)) {
      return sendError(res, 400, '远端上报仅允许 frontend / plugin 层级');
    }
    const message = String(body.message || '').trim();
    if (!message) return sendError(res, 400, '缺少 message');
    log({
      remote: true,
      level: ['error', 'warn', 'slow', 'info'].includes(body.level) ? body.level : 'error',
      layer,
      kind: String(body.kind || 'remote_error').slice(0, 40),
      message: message.slice(0, 4000),
      code_file: String(body.code_file || '').slice(0, 2000),
      code_line: Number.isInteger(Number(body.code_line)) ? Number(body.code_line) : undefined,
      code_func: String(body.code_func || '').slice(0, 200),
      stack: String(body.stack || '').slice(0, 16000),
      context: (() => {
        let ctx = (body.context && typeof body.context === 'object') ? body.context : {};
        try {
          const s = JSON.stringify(ctx);
          if (s.length > 8000) ctx = { truncated: true, preview: s.slice(0, 4000) };
        } catch (_) { ctx = {}; }
        return ctx;
      })()
    });
    flushLogs(); // 上报后立即落盘，保证冒烟测试/崩溃排查能立刻读到
    return sendJSON(res, 201, { ok: true });
  }
  if (resource === 'logs' && method === 'DELETE') {
    clearLogs();
    return sendJSON(res, 200, { ok: true });
  }

  // Chapter manual save versions
  if (resource === 'chapter_versions') {
    if (method === 'GET' && !id) {
      const chapterId = Number(query.chapter_id);
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
      return sendJSON(res, 200, listChapterVersions(chapterId));
    }
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const chapterId = Number(body.chapter_id);
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
      if (!prepare('SELECT id FROM chapters WHERE id = ?').get(chapterId)) return sendError(res, 404, '章节不存在');
      const row = saveChapterVersion(chapterId, body.title, body.summary, body.content);
      return sendJSON(res, 201, row);
    }
    if (method === 'POST' && id && segments[2] && segments[3] === 'restore') {
      const body = await readBody(req);
      const version = prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(id);
      if (!version) return sendError(res, 404, '历史版本不存在');
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(version.chapter_id);
      if (!chapter) return sendError(res, 404, '章节不存在');
      db.exec('BEGIN');
      try {
        if (body.backup_current !== false) {
          saveChapterVersion(chapter.id, chapter.title, chapter.summary, chapter.content);
        }
        prepare('UPDATE chapters SET title = ?, summary = ?, content = ? WHERE id = ?').run(
          version.title || chapter.title,
          version.summary || '',
          version.content || '',
          chapter.id
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const updated = prepare('SELECT * FROM chapters WHERE id = ?').get(chapter.id);
      touchWork(chapter.work_id);
      notifyChange('chapters', { workId: chapter.work_id, id: chapter.id });
      return sendJSON(res, 200, { ok: true, chapter: updated });
    }
    return sendError(res, 405, 'Method not allowed');
  }

  // Graceful shutdown: release port and stop the Node process
  if (resource === 'shutdown' && method === 'POST') {
    sendJSON(res, 200, { ok: true, message: '服务正在关闭' });
    setTimeout(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    }, 80);
    return;
  }

  // AI endpoints
  // AI 效果埋点（P5）：POST 记一条行为信号；GET 取聚合（采纳率 / 编辑距离 / 上下文成本）。
  if (resource === 'ai' && segments[2] === 'eval') {
    if (method === 'POST') {
      const body = await readBody(req);
      const ok = recordAIEval({
        workId: body.work_id, chapterId: body.chapter_id, action: body.action,
        channel: body.channel, model: body.model, charsIn: body.chars_in, charsOut: body.chars_out,
        ms: body.ms, editDistance: body.edit_distance, draftKey: body.draft_key
      });
      return sendJSON(res, 200, { ok });
    }
    if (method === 'GET') {
      return sendJSON(res, 200, { ok: true, ...summarizeAIEval(Number(query.work_id) || null) });
    }
    return sendError(res, 405, 'Method not allowed');
  }
  // AI 策略快照（P4）：前端据此把散落的模型字面量换成档位查询，取得与后端同一份策略。
  // 必须放在下面 /api/ai/* 的 POST 分支之前——它是 GET。
  if (resource === 'ai' && segments[2] === 'policy' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...policySnapshot() });
  }
  if (resource === 'ai' && segments[2]) {
    const action = segments[2];
    if (method !== 'POST') return sendError(res, 405, 'Method not allowed');
    let body;
    try { body = await readBody(req); } catch (e) { return sendError(res, 400, e.message); }
    try {
      const config = getConfigFromBody(body);
      if (!config.api_key) return sendError(res, 400, '请先填写 API Key');
      // 允许请求级覆盖模型（工作台阶段等需要按策略选择 flash/pro）
      if (body.model) config.model = normalizeModel(body.model);
      if (action === 'generate_novel') {
        const result = await generateNovelFromPrompt(body.prompt, config);
        return sendJSON(res, 200, { ok: true, ...result });
      }
      if (action === 'test') {
        const data = await callAI(config, [{ role: 'user', content: '请只回复：连接成功' }], {
          temperature: 0.1,
          max_tokens: 16
        });
        return sendJSON(res, 200, { ok: true, reply: data?.choices?.[0]?.message?.content || '连接成功', raw: data });
      }
      // 流式直连成文：SSE 边生成边下发，结束后带确定性红线扫描报告（质量优先模式）。
      if (action === 'write_stream') {
        return handleAIWriteStream(req, res, body, config);
      }
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) return sendError(res, 400, '缺少 messages');
      if (action === 'write' || action === 'personality' || action === 'outline' || action === 'chat' || action === 'polish' || action === 'expand' || action === 'pipeline') {
        const data = await callAI(config, messages, { temperature: body.temperature, max_tokens: body.max_tokens, reasoning_effort: body.reasoning_effort });
        return sendJSON(res, 200, { ok: true, reply: data?.choices?.[0]?.message?.content || '', raw: data });
      }
      return sendError(res, 404, 'Unknown AI action');
    } catch (e) {
      logAIError(action, e, `/api/ai/${action}`);
      return sendError(res, e.status || 502, e.message || 'AI request failed');
    }
  }

  // Generic CRUD for listed resources
  const crudResources = new Set([
    'works', 'volumes', 'plotlines', 'chapters', 'categories', 'terms',
    'characters', 'relations', 'plotline_characters', 'world_entries', 'creation_tasks', 'api_configs'
  ]);
  if (crudResources.has(resource)) {
    // 存在 id 段但解析失败（如 /api/works/12abc）→ 404，而不是落入列表分支返回全量数据。
    if (segments[2] !== undefined && id === null) return sendError(res, 404, 'Not found');
    const maskRow = (row) => (resource === 'api_configs' && row ? { ...row, api_key: maskApiKey(row.api_key) } : row);
    try {
      if (method === 'GET' && !id) {
        const where = {};
        for (const key of ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'category_id', 'character_id', 'from_character_id', 'to_character_id']) {
          if (query[key] !== undefined) where[key] = Number(query[key]);
        }
        const rows = getList(resource, where) || [];
        return sendJSON(res, 200, resource === 'api_configs' ? rows.map(maskRow) : rows);
      }
      if (method === 'GET' && id) {
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        return row ? sendJSON(res, 200, maskRow(row)) : sendError(res, 404, 'Not found');
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const newId = insertRow(resource, body);
        if (body.work_id) touchWork(body.work_id);
        if (resource === 'works') touchWork(newId);
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(newId);
        // OpenViking 增量同步：新建作品触发全量建索引，其余资源防抖后重写对应文件。
        if (resource === 'works') {
          syncWorkFull(newId).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `新作品同步失败（work ${newId}）：${e.message}` }));
        } else if (resource !== 'plotline_characters') {
          const wid = (row?.work_id ?? Number(body.work_id)) || null;
          if (wid) notifyChange(resource, { workId: wid, id: newId });
        } else if (row?.work_id) {
          // plotline_characters 影响出场角色选择，需失效上下文缓存（无对应记忆库渲染器，故不 notifyChange）。
          touchWork(row.work_id);
        }
        return sendJSON(res, 201, maskRow(row));
      }
      if (method === 'PUT' && id) {
        const body = await readBody(req);
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        // 乐观锁：编辑保存携带读取时的 updated_at，冲突返回 409（前端提示刷新）。
        if (resource === 'chapters' && body._if_updated_at !== undefined) {
          if (old && String(old.updated_at) !== String(body._if_updated_at)) {
            return sendError(res, 409, '内容已在其他窗口被修改，请刷新后重试');
          }
        }
        const changes = updateRow(resource, id, body);
        if (changes === 0) return sendError(res, 404, 'Not found');
        // P5 埋点：章节正文落盘是「AI 草稿 → 作者最终正文」的测量点（见函数注释）。
        // 只在正文真的被写时尝试；没有待测量的采纳行时它是空操作。
        if (resource === 'chapters' && typeof body.content === 'string' && body.content.trim()) {
          measureAdoptEditDistance(id, body.content);
        }
        if (old?.work_id) touchWork(old.work_id);
        if (body.work_id) touchWork(body.work_id);
        if (resource === 'works') touchWork(Number(id));
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        const wid = resource === 'works'
          ? Number(id)
          : ((old?.work_id ?? row?.work_id ?? Number(body.work_id)) || null);
        if (wid && resource !== 'plotline_characters') {
          notifyChange(resource, { workId: wid, id: resource === 'works' ? Number(id) : id });
        } else if (wid) {
          touchWork(wid);
        }
        return sendJSON(res, 200, maskRow(row));
      }
      if (method === 'DELETE' && id) {
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        // P5 埋点的连带清理（决策 D6·C-①）：`ai_eval_events` 的 work_id/chapter_id 是**裸列**，
        // 没有像其它二十余张作品域表那样写 `ON DELETE CASCADE`。不显式删就会留下孤儿行：
        // 谁也够不到它们，而 `GET /api/ai/eval`（不带 work_id）会把它们算进全局聚合，把指标带偏。
        // ⚠️ 必须在 deleteRow **之前**删：章节随作品级联消失后，就再也解析不出 chapter_id 了。
        if (resource === 'works') purgeEvalEventsOfWork(Number(id));
        const removed = deleteRow(resource, id);
        if (!removed) return sendError(res, 404, 'Not found');
        if (old?.work_id) touchWork(old.work_id);
        if (resource === 'works') touchWork(Number(id));
        // OpenViking 增量同步：删除作品 → 整目录移除；其余资源 → 删除对应文件。
        if (resource === 'works') {
          removeWorkFromMemory(Number(id)).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `作品目录移除失败（work ${id}）：${e.message}` }));
        } else if (old?.work_id && resource !== 'plotline_characters') {
          notifyChange(resource, { workId: old.work_id, id, deleted: true });
        } else if (old?.work_id) {
          touchWork(old.work_id);
        }
        return sendJSON(res, 200, { ok: true });
      }
      return sendError(res, 405, 'Method not allowed');
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  return sendError(res, 404, 'API not found');
}

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = path.join(publicDir, 'index.html');
  } else {
    filePath = path.join(publicDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  }
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { try { res.destroy(); } catch (_) { /* 忽略 */ } });
      res.on('error', () => { stream.destroy(); });
      stream.pipe(res);
    } else {
      // SPA fallback: send index.html for non-file paths
      fs.readFile(path.join(publicDir, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      });
    }
  });
}

// 首次启动写入默认红线清单（幂等）
seedRedlinesIfEmpty();

// 日志系统初始化：注入 SQLite、迁移旧 AI 错误、安装进程兜底与卡顿监测、启动保留策略。
initLogger(db, { onExit: () => { flushDebouncedSync(); flushTraceFile(); } });

// 追踪时钟自检：确认「单调时钟」与「Unix 纪元时钟」确实是两个域。
// 若某天两者差值落到 0 附近，说明 nowMs() 的实现被换成了 Date.now()，
// 此时所有以 hrtime 为基准的历史注释与判据都要重新审一遍 —— 提前吵一声，别等数据失真后才发现。
{
  const clock = traceClockDomain();
  if (Math.abs(clock.drift_ms) < 1000) {
    log({
      level: 'error', layer: 'server', kind: 'trace_clock_suspect',
      message: '追踪时钟自检异常：单调时钟与 Unix 纪元时钟几乎重合，nowMs() 可能已被改成 Date.now()',
      context: clock
    });
  } else {
    log({
      level: 'info', layer: 'server', kind: 'trace_clock_ok',
      message: `追踪时钟自检通过（单调与纪元相差 ${Math.round(Math.abs(clock.drift_ms) / 86400000)} 天）`,
      context: clock
    });
  }
}

// 调试录制期间定期检查前端心跳：页面被关闭后自动停止录制，避免「忘关」长期开着。
// 超时 90s（前端 10s ping 的 9 倍）：浏览器把后台标签页定时器节流到约 1 次/分钟，
// 余量太小会把「切到别的标签页」误判成「页面已关闭」。
setInterval(() => {
  try {
    checkStaleTracing(90000);
  } catch (_) { /* 自检失败不影响服务 */ }
}, 15000).unref();

// 空闲收尾：把响应已回完、但前端从未显式结束的服务端操作关掉。
// 没有这一步，这类操作会一直挂在 running，耗时被算到「停录那一刻」（30ms 的检索记成 546469ms）。
// 间隔取 200ms：收尾精度 ≈ 宽限期(1200ms) + 一个 tick，比 15s 心跳高两个数量级，
// 又远低于真实业务操作（秒级～分钟级）的时长，不会把长任务误判成已结束。
// 循环本身极轻：录制未开启时函数第一行即返回。
setInterval(() => {
  try {
    sweepIdleOperations();
  } catch (_) { /* 收尾失败不影响服务 */ }
}, 200).unref();

const server = http.createServer(async (req, res) => {
  const { pathname, query } = getPath(req);
  const startedAt = performance.now();
  try {
    if (pathname.startsWith('/api/')) {
      // traceRequest：录制中为本次请求建立追踪上下文，让整条 await 链归属同一个用户操作；
      // 未录制或被排除的路径（/api/debug、/api/logs 等）直接执行，走原路径零开销。
      await traceRequest(req, res, () => handleAPI(req, res, pathname, query));
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    // 统一错误日志：记录发生时间/层级/代码位置/文件地址（logger 自动解析调用栈）。
    log({
      level: 'error', layer: 'server', kind: 'http_error',
      message: `接口异常：${String(e?.message || e)}`,
      error: e,
      context: { method: req.method, path: pathname, query: String(req.url || '').slice(0, 500) }
    });
    if (!res.destroyed && !res.headersSent) {
      const status = e?.code === 'PAYLOAD_TOO_LARGE' ? 413
        : e?.code === 'INVALID_JSON' ? 400
        : 500;
      sendError(res, status, e?.message);
    }
  } finally {
    // 慢请求监测：API 耗时超标记 slow 日志（“不流畅”的可归因记录）。
    // N-07：AI 通道（直连 /ai/ 与慢通道 /harness）天然秒级起步，用更高阈值避免「慢请求」刷屏。
    const aiLike = pathname.startsWith('/api/ai/') || pathname.startsWith('/api/harness');
    const slowMs = aiLike ? 10000 : SLOW_REQUEST_MS;
    const ms = performance.now() - startedAt;
    if (pathname.startsWith('/api/') && pathname !== '/api/logs' && ms > slowMs) {
      log({
        level: 'slow', layer: 'server', kind: 'slow_request',
        message: `${req.method} ${pathname} 耗时 ${Math.round(ms)}ms（阈值 ${slowMs}ms）`,
        context: { method: req.method, path: pathname, duration_ms: Math.round(ms) },
        dedupMs: 60 * 1000
      });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Novel Studio is running at http://localhost:${PORT}`);
  // 启动后异步把尚未索引的作品导入 OpenViking 共享记忆库（语义召回开启时）。
  autoIndexExistingWorks();
});
