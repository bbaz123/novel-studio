import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { isHarnessAvailable, isHarnessBuilt, runHarnessTask, runHarnessTaskWithProgress, HARNESS_DIR } from './harness.js';

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
function isLocalRequest(req) {
  if (!MUTATING_METHODS.has(req.method || '')) return true;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const local = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    return local(url.hostname);
  } catch (_) {
    return false;
  }
}

const MAX_BODY_BYTES = 2_000_000; // 2MB：正文保存足够，恶意超大 payload 直接拒绝。

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) {
    const err = new Error('Payload too large');
    req.destroy();
    throw err;
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
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
const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

function touchWork(workId) {
  try {
    prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now(), workId);
  } catch (_) { /* ignore */ }
}

// ---------- 通用 CRUD ----------
// 集中管理各资源的表名、字段、排序和默认值，避免多个地方重复定义。
const RESOURCE_CONFIG = {
  works: { table: 'works', order: 'id DESC', fields: ['title', 'description', 'author_note', 'default_chapter_words', 'total_chapters', 'story_structure', 'narrative_pov'], defaults: { description: '', author_note: '', default_chapter_words: 2000, total_chapters: 0, story_structure: '', narrative_pov: '' } },
  volumes: { table: 'volumes', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  plotlines: { table: 'plotlines', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'kind', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  chapters: { table: 'chapters', order: 'position ASC, id ASC', fields: ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'title', 'summary', 'content', 'author_note', 'blueprint_json', 'target_words', 'position'], defaults: { summary: '', content: '', author_note: '', blueprint_json: '', target_words: 0, position: 0 } },
  categories: { table: 'categories', order: 'position ASC, id ASC', fields: ['work_id', 'name', 'color', 'position'], defaults: { color: '#6366f1', position: 0 } },
  terms: { table: 'terms', order: 'updated_at DESC, id DESC', fields: ['work_id', 'category_id', 'title', 'content', 'tags'], defaults: { content: '', tags: '' } },
  characters: { table: 'characters', order: 'name ASC', fields: ['work_id', 'name', 'identity', 'appearance', 'personality', 'background', 'status', 'avatar_color', 'mes_example', 'tags', 'system_prompt'], defaults: { identity: '', appearance: '', personality: '', background: '', status: '', avatar_color: '#8b5cf6', mes_example: '', tags: '', system_prompt: '' } },
  relations: { table: 'character_relations', order: 'id ASC', fields: ['work_id', 'from_character_id', 'to_character_id', 'relation', 'description'], defaults: { relation: '', description: '' } },
  plotline_characters: { table: 'plotline_characters', order: 'id ASC', fields: ['work_id', 'plotline_id', 'character_id', 'status', 'notes'], defaults: { status: '', notes: '' } },
  world_entries: { table: 'world_entries', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'content', 'keywords', 'is_pinned', 'priority', 'position'], defaults: { content: '', keywords: '', is_pinned: 0, priority: 50, position: 0 } },
  creation_tasks: { table: 'creation_tasks', order: 'id DESC', fields: ['work_id', 'prompt', 'status', 'stages_json', 'result_json', 'error'], defaults: { prompt: '', status: 'running', stages_json: '{}', result_json: '{}', error: '' } },
  api_configs: { table: 'api_configs', order: 'id ASC', fields: ['name', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens'], defaults: { base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-v4-pro', temperature: 0.8, max_tokens: 4096 } }
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

function insertRow(resource, data) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  // D4：作品名称必填（后端兜底，前端同样拦截）
  if (resource === 'works' && !String(data.title ?? '').trim()) {
    throw new Error('作品名称不能为空');
  }
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
  if (present.length === 0) return false;
  const sql = `UPDATE ${cfg.table} SET ${present.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`;
  prepare(sql).run(...present.map((f) => normalizeValue(resource, f, data[f])), id);
  return true;
}

function deleteRow(resource, id) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return false;
  prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
  return true;
}

// ---------- search ----------
// 多关键词检索：全部关键词 AND 匹配；标题/名称命中权重最高（×3），标签/身份次之（×2），
// 内容命中兜底；按得分排序取前 20，片段围绕最早命中的关键词截取。
function search(q, workId) {
  const empty = { terms: [], chapters: [], characters: [], plotlines: [] };
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
    queryRows('terms', ['title', 'tags', 'content']).map((t) => ({ ...t, type: 'term' })),
    ['title', 'tags', 'content'], 'title'
  ).map((t) => ({ ...t, snippet: snippetAny(t.content) }));

  const chapters = rank(
    queryRows('chapters', ['title', 'summary', 'content']).map((c) => ({ ...c, type: 'chapter' })),
    ['title', 'summary', 'content'], 'title'
  ).map((c) => ({ ...c, snippet: snippetAny(c.content, c.summary) }));

  const characters = rank(
    queryRows('characters', ['name', 'identity', 'personality', 'background', 'status']).map((c) => ({ ...c, type: 'character' })),
    ['name', 'identity', 'personality', 'background', 'status'], 'name'
  );

  const plotlines = rank(
    queryRows('plotlines', ['title', 'summary']).map((p) => ({ ...p, type: 'plotline' })),
    ['title', 'summary'], 'title'
  ).map((p) => ({ ...p, snippet: snippetAny(p.summary) }));

  return { terms, chapters, characters, plotlines };
}

// ---------- AI ----------
function chatCompletionsUrl(baseUrl) {
  let base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function normalizeModel(model) {
  if (!model) return model;
  const raw = String(model).trim();
  const lower = raw.toLowerCase();
  const known = [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp'
  ];
  return known.includes(lower) ? lower : raw;
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
    model: normalizeModel(config.model || 'deepseek-chat'),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.8,
    max_tokens: maxTokens,
    stream: false
  };

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
  try {
    return await doPost(primary);
  } catch (e) {
    const primaryUsesV1 = /\/v1\/chat\/completions$/i.test(primary);
    const alt = primaryUsesV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    if (alt === primary) throw e;
    const looksLikeUrlIssue = e.status === 404 || e.status === 405 || /missing required messages|missing.*messages|缺少\s*messages|not found|invalid url/i.test(e.message || '');
    if (!looksLikeUrlIssue) throw e;
    return doPost(alt);
  }
}

function getConfigFromBody(body) {
  if (body.config_id) {
    const row = prepare('SELECT * FROM api_configs WHERE id = ?').get(Number(body.config_id));
    if (!row) throw new Error('API 配置不存在');
    return row;
  }
  return {
    base_url: body.base_url || 'https://api.deepseek.com',
    api_key: body.api_key || '',
    model: body.model || 'deepseek-v4-pro',
    temperature: body.temperature ?? 0.8,
    max_tokens: body.max_tokens ?? 4096
  };
}

// ---------- AI error history ----------
// D3/D16：message 只保留一行可读错误；同 action + 同 message 在 30 分钟窗口内去重，避免报错墙堆叠重复。
function readableErrorMessage(error) {
  const text = String(error?.message || error || 'Unknown error');
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^\s*at\s+/.test(l)) || text.split(/\r?\n/)[0].trim();
  return firstLine.slice(0, 300);
}

function logAIError(action, error, endpoint = '') {
  try {
    const message = readableErrorMessage(error);
    const code = String(error?.status || error?.detail?.error?.code || error?.code || '').slice(0, 200);
    const stack = String(error?.stderr || error?.stack || '').slice(0, 4000);
    // 30 分钟窗口内相同的 action+message 视为重复错误，不重复插入。
    const recent = prepare(`
      SELECT id FROM ai_error_logs
      WHERE action = ? AND message = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(action || 'unknown', message, new Date(Date.now() - 30 * 60 * 1000).toISOString());
    if (recent) return;
    prepare(`
      INSERT INTO ai_error_logs (action, message, error_code, stack, endpoint)
      VALUES (?, ?, ?, ?, ?)
    `).run(action || 'unknown', message, code, stack, endpoint || '');
    prepare(`
      DELETE FROM ai_error_logs
      WHERE id NOT IN (
        SELECT id FROM ai_error_logs ORDER BY created_at DESC, id DESC LIMIT 5
      )
    `).run();
  } catch (_) { /* 日志失败不影响主流程 */ }
}

function listAIErrors() {
  return prepare(`
    SELECT id, action, message, error_code, stack, endpoint, created_at
    FROM ai_error_logs
    ORDER BY created_at DESC, id DESC
    LIMIT 5
  `).all();
}

// ---------- chapter manual save versions ----------
function saveChapterVersion(chapterId, title, summary, content) {
  const info = prepare(`
    INSERT INTO chapter_save_versions (chapter_id, title, summary, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chapterId, asString(title), asString(summary), asString(content), now());
  pruneChapterVersions(chapterId);
  return prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(Number(info.lastInsertRowid));
}

function listChapterVersions(chapterId) {
  return prepare(`
    SELECT id, chapter_id, title, summary, content, created_at
    FROM chapter_save_versions
    WHERE chapter_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all(chapterId);
}

function pruneChapterVersions(chapterId) {
  prepare(`
    DELETE FROM chapter_save_versions
    WHERE chapter_id = ?
      AND id NOT IN (
        SELECT id FROM chapter_save_versions
        WHERE chapter_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `).run(chapterId, chapterId);
}

// ---------- AI 上下文（角色卡 / 世界观 / 作者注） ----------
// 简单去掉 HTML 标签，用于关键词匹配。
function plainText(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  db.exec('BEGIN');
  try {
    prepare(`
      INSERT INTO story_memories (work_id, summary, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
    `).run(workId, summary, now());
    const info = prepare(`
      INSERT INTO memory_versions (work_id, summary, source, note)
      VALUES (?, ?, ?, ?)
    `).run(workId, summary, source, note);
    // 版本保留策略：只留最近 MEMORY_VERSION_KEEP 个，最旧的多余版本剪除。
    prepare(`
      DELETE FROM memory_versions
      WHERE work_id = ? AND id NOT IN (
        SELECT id FROM memory_versions WHERE work_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(workId, workId, MEMORY_VERSION_KEEP);
    db.exec('COMMIT');
    return {
      ok: true, work_id: workId, summary, version_id: Number(info.lastInsertRowid), source,
      needs_compression: summary.length > MEMORY_COMPRESS_HINT
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 自动压缩作品内容为长期记忆摘要。
async function compressStoryMemory(workId) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new Error('作品不存在');

  const chapters = prepare('SELECT title, summary, content FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const characters = prepare('SELECT name, identity, personality, status FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const worlds = prepare('SELECT title, content FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);

  const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainText(c.content).slice(0, 500)}`).join('\n');
  const characterText = characters.map((c) => `【${c.name}】${c.identity || ''} ${c.personality || ''} ${c.status || ''}`).join('\n');
  const worldText = worlds.map((w) => `【${w.title}】${w.content}`).join('\n');

  const prompt = `你是一位小说长期记忆压缩器。请根据以下作品内容，生成一段不超过 800 字的中文长期记忆摘要，记录已经发生的重要剧情、伏笔、角色当前状态、世界设定关键信息，方便后续 AI 写作保持一致。\n\n作品名：${work.title}\n简介：${work.description}\n\n章节：\n${chapterText.slice(0, 6000)}\n\n角色：\n${characterText.slice(0, 3000)}\n\n世界观：\n${worldText.slice(0, 3000)}\n\n请只输出压缩后的记忆摘要。`;

  const output = await runHarnessTask(prompt, { timeout: 10 * 60 * 1000, model: 'deepseek-v4-pro' });
  saveStoryMemory(workId, output);
  return output;
}

// 根据章节自动组装 AI 上下文：相关角色卡、激活的世界观词条、作者注。
function buildAIContext(chapterId) {
  const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!chapter) return null;
  const work = prepare('SELECT * FROM works WHERE id = ?').get(chapter.work_id);
  if (!work) return null;

  // 优先取当前剧情线关联角色，否则回退到作品前 8 个角色。
  const characters = [];
  if (chapter.plotline_id) {
    const rows = prepare('SELECT character_id FROM plotline_characters WHERE plotline_id = ? ORDER BY id ASC').all(chapter.plotline_id);
    for (const row of rows) {
      const c = prepare('SELECT * FROM characters WHERE id = ?').get(row.character_id);
      if (c) characters.push(c);
    }
  }
  if (!characters.length) {
    characters.push(...prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC LIMIT 8').all(work.id));
  }

  // 固定词条始终激活；关键词词条在标题/摘要/正文中匹配到关键词时激活。
  const corpus = [chapter.title, chapter.summary, plainText(chapter.content), work.description].join(' ').toLowerCase();
  const allEntries = prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(work.id);
  const worldEntries = allEntries.filter((entry) => {
    if (Number(entry.is_pinned)) return true;
    const keywords = String(entry.keywords || '').split(/[,，、\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
    return keywords.some((k) => corpus.includes(k));
  });

  const charNames = characters.map((c) => c.name).join('、');
  const replaceVars = (text = '') => String(text)
    .replace(/\{title\}/g, chapter.title || '')
    .replace(/\{work\}/g, work.title || '')
    .replace(/\{characters\}/g, charNames)
    .replace(/\{summary\}/g, chapter.summary || '');

  // 创作内核增强：前文衔接尾巴、最近事件、写作红线（供提示词注入/界面预览）
  const allChap = prepare('SELECT id, title, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(work.id);
  const pos = allChap.findIndex((c) => c.id === chapter.id);
  const prevChapRow = pos > 0 ? allChap[pos - 1] : null;
  let storyTail = '';
  if (prevChapRow) {
    const pc = prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapRow.id);
    if (pc) storyTail = plainText(pc.content || '').slice(-1200);
  }
  if (!storyTail) storyTail = plainText(chapter.content || '').slice(-1200);
  const recentEvents = listStoryEvents(work.id, 12);
  const redlineRows = listRedlines(work.id);
  let blueprint = null;
  try { blueprint = JSON.parse(chapter.blueprint_json || '{}'); } catch (_) { blueprint = null; }
  const targetWords = (Number(chapter.target_words) > 0 ? Number(chapter.target_words) : 0)
    || Number(work.default_chapter_words) || 2000;

  return {
    work: {
      id: work.id, title: work.title,
      default_chapter_words: Number(work.default_chapter_words) || 2000,
      total_chapters: Number(work.total_chapters) || 0,
      story_structure: work.story_structure || '',
      narrative_pov: work.narrative_pov || ''
    },
    chapter: { id: chapter.id, title: chapter.title, summary: chapter.summary, blueprint, target_words: targetWords },
    prev_chapter: prevChapRow ? { id: prevChapRow.id, title: prevChapRow.title } : null,
    characters,
    world_entries: worldEntries,
    story_memory: getStoryMemory(work.id),
    story_tail: storyTail,
    recent_events: recentEvents.map((e) => ({ kind: e.kind, summary: e.summary, chapter_id: e.chapter_id, created_at: e.created_at })),
    redlines: redlineRows.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note })),
    style_contract: renderStyleContract(redlineRows),
    work_author_note: replaceVars(work.author_note || ''),
    chapter_author_note: replaceVars(chapter.author_note || '')
  };
}

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
  const row = prepare('SELECT COUNT(*) AS c FROM writing_redlines WHERE work_id IS NULL').get();
  if (Number(row.c) > 0) return;
  db.exec('BEGIN');
  try {
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note) VALUES (NULL, ?, ?, ?)');
    for (const r of DEFAULT_REDLINES) stmt.run(r.kind, r.pattern, r.note || '');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 读取红线：全局默认 + 作品级覆盖（作品级存在时优先于同名全局项）。
function listRedlines(workId) {
  const globalRows = prepare('SELECT * FROM writing_redlines WHERE work_id IS NULL ORDER BY id ASC').all();
  const workRows = workId ? prepare('SELECT * FROM writing_redlines WHERE work_id = ? ORDER BY id ASC').all(workId) : [];
  const byKey = new Map(globalRows.filter((r) => Number(r.enabled)).map((r) => [`${r.kind}:${r.pattern}`, r]));
  for (const r of workRows) {
    const key = `${r.kind}:${r.pattern}`;
    if (Number(r.enabled)) byKey.set(key, r);
    else byKey.delete(key);
  }
  return [...byKey.values()];
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
    }
  }
  db.exec('BEGIN');
  try {
    prepare('DELETE FROM writing_redlines WHERE work_id IS ?').run(workId ?? null);
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note, enabled) VALUES (?, ?, ?, ?, ?)');
    for (const e of entries) {
      stmt.run(workId ?? null, asString(e.kind, 'phrase'), asString(e.pattern, ''), asString(e.note, ''), e.enabled === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listRedlines(workId);
}

// 把红线渲染成给模型看的“写作风格契约”文本。
function renderStyleContract(rows) {
  const enabled = rows.filter((r) => Number(r.enabled));
  if (!enabled.length) return '（未启用任何红线规则）';
  const lines = enabled.map((r) => {
    const kindName = r.kind === 'regex' ? '句式模式' : (r.kind === 'word' ? '慎用词' : '慎用句式');
    return `- [${kindName}] ${r.pattern}${r.note ? `（${r.note}）` : ''}`;
  });
  return [
    '【写作风格红线 · 反 AI 腔】请在写作时主动避免以下词句；若确需使用，每次出现前先问自己是否有更具体、更有画面感的写法：',
    ...lines
  ].join('\n');
}

// 在文本中确定性扫描红线命中（用于生成后自查）。
// opts.skip_dialogue=true 时先剥掉引号内对话再扫：角色台词的口语词不应按叙述标准误杀。
function scanAgainstRedlines(rows, text, opts = {}) {
  const hits = [];
  const source = String(text || '');
  if (!source) return hits;
  const clean = opts.skip_dialogue === true
    ? source.replace(/“[^”]*”|「[^」]*」|‘[^’]*’|『[^』]*』/g, '')
    : source;
  if (!clean) return hits;
  for (const r of rows) {
    if (!Number(r.enabled)) continue;
    const pattern = String(r.pattern || '');
    if (!pattern || pattern.length > 500) continue; // 超长/异常模式跳过（防病态正则）
    let count = 0;
    let sample = '';
    try {
      if (r.kind === 'regex') {
        const re = new RegExp(pattern, 'g');
        const found = clean.match(re) || [];
        count = found.length;
        sample = found[0] || '';
      } else {
        let idx = -1;
        while ((idx = clean.indexOf(pattern, idx + 1)) !== -1) {
          count += 1;
          if (!sample) sample = clean.slice(Math.max(0, idx - 14), idx + pattern.length + 14);
        }
      }
    } catch (_) { /* 非法正则跳过 */ }
    if (count > 0) hits.push({ kind: r.kind, pattern, note: r.note || '', count, sample: sample || '' });
  }
  return hits.sort((a, b) => b.count - a.count);
}

// ---------- 故事事件账本 ----------
// 入账一条事件；支持伏笔状态与回收关联、按 dedup_key 幂等去重。
function addStoryEvent(workId, {
  chapterId,
  kind = 'event',
  summary = '',
  payload = {},
  foreshadowStatus = '',
  resolvesEventId = null,
  dedupKey = ''
}) {
  const summaryText = asString(summary, '');
  const key = asString(dedupKey, '');
  if (key) {
    const dup = prepare('SELECT id FROM story_events WHERE work_id = ? AND dedup_key = ? LIMIT 1').get(workId, key);
    if (dup) return { id: Number(dup.id), duplicate: true };
  }
  db.exec('BEGIN');
  try {
    const info = prepare(`
      INSERT INTO story_events (work_id, chapter_id, kind, summary, payload, foreshadow_status, resolves_event_id, dedup_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workId, chapterId || null, asString(kind, 'event'), summaryText, JSON.stringify(payload || {}),
      asString(foreshadowStatus, kind === 'foreshadow' ? 'open' : ''),
      resolvesEventId ? Number(resolvesEventId) : null, key);
    if (resolvesEventId && kind === 'event') {
      // 回收伏笔：把被回收的伏笔标记为 resolved，并回链到本事件。
      prepare('UPDATE story_events SET foreshadow_status = ? WHERE id = ? AND work_id = ?')
        .run('resolved', Number(resolvesEventId), workId);
    }
    db.exec('COMMIT');
    return { id: Number(info.lastInsertRowid), duplicate: false };
  } catch (e) {
    db.exec('ROLLBACK');
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
      let summary = p.summary || '';
      if (!summary && p.delta) summary = mergeMemoryDraft(getStoryMemory(workId), p.delta);
      saveStoryMemory(workId, summary, { source: 'proposal', note: p.note || '作者确认的 AI 提案' });
      applied.memories += 1;
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
  return { ok: true, work_id: version.work_id, summary: result.summary, version_id: result.version_id };
}

// ---------- 场景化创作上下文（ST 式装配） ----------
// mode: full（默认，整章代写/分析）| continuation（接龙，重视前文尾巴）| fragment（片段补写）
function buildNovelContext(workId, chapterId, mode = 'full') {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) return null;

  const allChapters = prepare('SELECT id, work_id, volume_id, plotline_id, parent_id, title, summary, author_note, blueprint_json, target_words, position, created_at, updated_at FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const plotlines = prepare('SELECT * FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const allCharacters = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const nameById = new Map(allCharacters.map((c) => [c.id, c.name]));

  let chapter = null;
  let chapterIndex = -1;
  if (chapterId) {
    chapterIndex = allChapters.findIndex((c) => c.id === Number(chapterId));
    chapter = chapterIndex >= 0 ? allChapters[chapterIndex] : prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) || null;
  }
  const prevChapter = chapterIndex > 0 ? allChapters[chapterIndex - 1] : null;
  const nextChapter = chapterIndex >= 0 && chapterIndex < allChapters.length - 1 ? allChapters[chapterIndex + 1] : null;
  if (chapter && !chapter.content) {
    const full = prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id);
    chapter = { ...chapter, content: full?.content || '' };
  }

  const corpus = [
    work.title, work.description,
    chapter?.title || '', chapter?.summary || '', plainText(chapter?.content || '').slice(0, 3000),
    prevChapter?.title || '', prevChapter?.summary || ''
  ].join(' ').toLowerCase();

  // 出场角色：当前章节剧情线关联 + 正文/摘要命中 + 兜底前 8 位；去重、限量。
  const sceneCharIds = new Set();
  if (chapter?.plotline_id) {
    const rows = prepare('SELECT character_id FROM plotline_characters WHERE plotline_id = ? ORDER BY id ASC').all(chapter.plotline_id);
    rows.forEach((r) => sceneCharIds.add(Number(r.character_id)));
  }
  for (const c of allCharacters) {
    if (c.name && corpus.includes(c.name.toLowerCase())) sceneCharIds.add(c.id);
  }
  if (!sceneCharIds.size) {
    allCharacters.slice(0, 8).forEach((c) => sceneCharIds.add(c.id));
  }
  const sceneCharacters = allCharacters.filter((c) => sceneCharIds.has(c.id)).slice(0, 12);
  const charCardsText = sceneCharacters.map((c) => {
    const parts = [
      `【${c.name}】`,
      c.identity ? `身份：${c.identity}` : '',
      c.appearance ? `外貌：${c.appearance}` : '',
      c.personality ? `性格：${c.personality}` : '',
      c.background ? `背景：${(c.background || '').slice(0, 500)}` : '',
      c.status ? `当前状态：${c.status}` : '',
      c.tags ? `标签：${c.tags}` : ''
    ].filter(Boolean).join('\n');
    let extra = '';
    if (c.mes_example) extra += `\n对话示例（学习其口吻）：${c.mes_example.slice(0, 400)}`;
    if (c.system_prompt) extra += `\n角色系统提示：${c.system_prompt.slice(0, 400)}`;
    return parts + extra;
  }).join('\n\n');

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

  // 世界观词条：固定(pinned)优先 + 关键词命中，按 priority 降序限量截断。
  const allEntries = prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY is_pinned DESC, priority DESC, position ASC, id ASC').all(workId);
  const worldEntries = [];
  for (const entry of allEntries) {
    if (worldEntries.length >= 30) break;
    const pinned = Number(entry.is_pinned) === 1;
    let matched = pinned;
    if (!matched) {
      const keywords = String(entry.keywords || '').split(/[,，、\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      matched = keywords.some((k) => corpus.includes(k));
    }
    if (matched) worldEntries.push(entry);
  }
  const worldEntriesText = worldEntries.map((w) => `【${w.title}】${String(w.content || '').slice(0, 600)}`).join('\n');

  // 大纲层：卷 + 剧情线 + 章节标题/摘要（长作品只给前 30 + 最近 30，中间省略计数）
  const outlineLines = [];
  for (const v of volumes) outlineLines.push(`【卷】${v.title}${v.summary ? `：${v.summary.slice(0, 200)}` : ''}`);
  for (const p of plotlines) outlineLines.push(`【${p.kind === 'side' ? '支线' : '主线'}】${p.title}${p.summary ? `：${p.summary.slice(0, 200)}` : ''}`);
  const total = allChapters.length;
  const skip = total > 80 ? total - 40 - 30 : -1;
  const shown = allChapters.filter((c, i) => skip < 0 || i < 30 || i >= skip || c.id === chapter?.id);
  if (skip >= 0) outlineLines.push(`（中间 ${total - 40 - 30} 章已省略，仅列最近进展）`);
  for (const c of shown) {
    const marker = c.id === chapter?.id ? '★' : '';
    outlineLines.push(`第${c.position + 1}节${marker} ${c.title}${c.summary ? `：${c.summary.slice(0, 120)}` : ''}`);
  }
  const outlineText = outlineLines.join('\n');

  const storyMemory = getStoryMemory(workId);
  const allEvents = listStoryEvents(workId, 200);
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
  const currentTail = chapter ? plainText(chapter.content || '').slice(-4000) : '';
  const prevFullRow = prevChapter ? prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapter.id) : null;
  const prevTailText = prevFullRow ? plainText(prevFullRow.content || '').slice(-1500) : '';
  let storyTail = '';
  if (mode === 'continuation') {
    storyTail = currentTail;
  } else if (mode === 'fragment') {
    storyTail = currentTail || prevTailText;
  } else {
    storyTail = prevTailText || (currentTail ? currentTail.slice(-1500) : '');
  }
  if (!storyTail) storyTail = prevTailText || (chapter ? plainText(chapter.content || '').slice(-800) : '');

  const redlines = listRedlines(workId);
  const styleContract = renderStyleContract(redlines);

  // 分层预算：每层独立上限，超长截断并注明原文长度；红线层与角色卡保底，
  // 整块装配结果再做一个总上限的收敛截断，避免盲切。
  const needsCompression = storyMemory.length > MEMORY_COMPRESS_HINT;
  const section = (label, text, cap) => {
    const body = String(text || '');
    if (!body) return `【${label}】\n（无）`;
    if (cap && body.length > cap) {
      return `【${label}】\n${body.slice(0, cap)}\n…（本层共 ${body.length} 字，已按预算截断；如需精确内容可用 novel_lookup 查证）`;
    }
    return `【${label}】\n${body}`;
  };

  const memoryBody = storyMemory
    ? `${storyMemory}${needsCompression ? `\n（⚠ 记忆已 ${storyMemory.length} 字，超过 ${MEMORY_COMPRESS_HINT} 字压缩提示线，收尾时请优先用 novel_memory_update 压缩合并）` : ''}`
    : '（无，可建议压缩一次）';

  const sceneBody = chapter
    ? `第${chapter.position + 1}节 ${chapter.title}${chapter.summary ? `\n大纲摘要：${chapter.summary}` : ''}${chapter.author_note ? `\n作者注：${chapter.author_note}` : ''}`
    : '（未指定具体章节）';

  // 本章蓝图（章节写作的常驻锚点）与目标字数：蓝图落库后随上下文带入，生成与核对都以其为准。
  let blueprint = null;
  try { blueprint = JSON.parse(chapter?.blueprint_json || '{}'); } catch (_) { blueprint = null; }
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

  const sections = [
    section('作品', `${work.title}${work.description ? `\n${work.description.slice(0, 600)}` : ''}\n${workConfigText}`, 900),
    section('卷/剧情线/章节进度（大纲）', outlineText, 2800),
    section('长期记忆（已发生的故事摘要）', memoryBody, 2200),
    section('最近事件（事件账本）', eventsText, 1800),
    section('未闭合伏笔（写作时必须照顾）', foreshadowText, 1200),
    section('当前场景', sceneBody, 1200),
    section('本章蓝图（写作必须遵守）', blueprintText || '（暂无蓝图，可在工坊里用「AI 写作」自动生成，或直接成文）', 1500),
    section('前文衔接', storyTail, mode === 'continuation' ? 4000 : 1600),
    section('出场角色卡', charCardsText, 4000),
    relationsText ? section('人物关系', relationsText, 800) : '',
    section('激活的世界观设定（优先级排列）', worldEntriesText, 3000),
    section('写作风格红线', styleContract, 4000)
  ].filter(Boolean);

  // 总预算收敛：超限时从“前文衔接/大纲/世界观”等弹性层依次收缩，红线层不动。
  const TOTAL_BUDGET = 26000;
  const FLEX_ORDER = [7, 1, 10]; // sections 下标：前文衔接 → 大纲 → 世界观
  const flexReduce = [2400, 1600, 800, 400];
  let joined = sections.join('\n\n');
  if (joined.length > TOTAL_BUDGET) {
    for (const idx of FLEX_ORDER) {
      if (joined.length <= TOTAL_BUDGET) break;
      const label = sections[idx]?.split('\n')[0] || '';
      for (const cap of flexReduce) {
        if (joined.length <= TOTAL_BUDGET) break;
        const raw = idx === 7 ? storyTail : idx === 1 ? outlineText : idx === 10 ? worldEntriesText : '';
        sections[idx] = section(label.replace('【', '').replace('】', ''), raw, cap);
        joined = sections.join('\n\n');
      }
    }
  }
  const assembled = joined;

  return {
    ok: true,
    mode,
    work: { id: work.id, title: work.title, default_chapter_words: Number(work.default_chapter_words) || 2000, total_chapters: Number(work.total_chapters) || 0, story_structure: work.story_structure, narrative_pov: work.narrative_pov },
    chapter: chapter ? { id: chapter.id, title: chapter.title, summary: chapter.summary, position: chapter.position, volume_id: chapter.volume_id, plotline_id: chapter.plotline_id, blueprint, target_words: targetWords } : null,
    prev_chapter: prevChapter ? { id: prevChapter.id, title: prevChapter.title } : null,
    next_chapter: nextChapter ? { id: nextChapter.id, title: nextChapter.title } : null,
    story_memory: storyMemory,
    needs_compression: needsCompression,
    events,
    open_foreshadows: openForeshadows.map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id, resolves_event_id: e.resolves_event_id })),
    scene_characters: sceneCharacters.map((c) => ({ id: c.id, name: c.name, identity: c.identity, status: c.status })),
    scene_character_ids: sceneIdList,
    world_entries: worldEntries.map((w) => ({ id: w.id, title: w.title, pinned: Number(w.is_pinned) === 1, priority: Number(w.priority ?? 50), keywords: w.keywords, content_preview: String(w.content || '').slice(0, 600) })),
    relations: relations.map((r) => ({ from: nameById.get(r.from_character_id) || null, to: nameById.get(r.to_character_id) || null, relation: r.relation, description: r.description })),
    redlines: redlines.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note })),
    style_contract: styleContract,
    assembled
  };
}

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

// 段落 → 简单 HTML（适配富文本编辑器；已含标签的原样保留）
function demoToHtml(text) {
  if (!text) return '';
  if (/^</.test(String(text).trim())) return String(text).trim();
  return String(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
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
        mes_example: asString(c.mes_example), tags: asString(c.tags), system_prompt: asString(c.system_prompt)
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
        content: demoToHtml(ch.content),
        position: i
      });
      idMap.chapter.set(ch.title, id);
    });
    db.exec('COMMIT');

    // 长期记忆（新作品无旧记忆，直接写入一次并留快照）
    if (data.memory && asString(data.memory.summary)) {
      saveStoryMemory(workId, asString(data.memory.summary), { source: asString(data.memory.source, 'manual') || 'manual', note: asString(data.memory.note, '示例导入') });
    }
    // 事件账本
    let eventCount = 0;
    (data.events || []).forEach((e) => {
      addStoryEvent(workId, { chapterId: idMap.chapter.get(e.chapter) ?? null, kind: asString(e.kind, 'event'), summary: asString(e.summary), payload: e.payload || {} });
      eventCount += 1;
    });

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
    // 第一次失败或解析失败时，用更明确的指令重试一次
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
        avatar_color: '#8b5cf6'
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
    abort: new AbortController(),
    cancelRequested: false
  };
  harnessJobs.set(jobId, job);
  // 清理：只保留最近 30 个任务，防止长时间运行内存增长。
  if (harnessJobs.size > 30) {
    const oldest = harnessJobs.keys().next().value;
    harnessJobs.delete(oldest);
  }
  (async () => {
    job.status = 'running';
    job.started_at = Date.now();
    try {
      const output = await runHarnessTaskWithProgress(prompt, { ...options, signal: job.abort.signal }, (chunk) => {
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

  if (resource === 'search' && method === 'GET') {
    return sendJSON(res, 200, search(query.q || '', query.work_id ? Number(query.work_id) : null));
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
      return sendJSON(res, 201, { ok: true, ...result });
    } catch (e) {
      return sendError(res, 409, e.message);
    }
  }
  if (resource === 'demo' && method === 'POST' && segments[2] === 'remove') {
    const removed = deleteDemoWork(DEMO_TITLE);
    return sendJSON(res, 200, { ok: true, removed });
  }

  // AI 上下文：角色卡 / 世界观 / 作者注
  if (resource === 'ai_context' && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const ctx = buildAIContext(chapterId);
    if (!ctx) return sendError(res, 404, '章节不存在');
    return sendJSON(res, 200, ctx);
  }

  // 长期记忆 / 故事摘要
  if (resource === 'story_memory' && method === 'POST' && segments[2] === 'compress') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    try {
      const summary = await compressStoryMemory(workId);
      return sendJSON(res, 200, { ok: true, summary });
    } catch (e) {
      return sendError(res, 502, e.message);
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
    const ctx = buildNovelContext(workId, chapterId, mode);
    if (!ctx) return sendError(res, 404, '作品不存在');
    return sendJSON(res, 200, ctx);
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
    // headless 生成任务（NOVELSTUDIO_PROPOSE_MODE=1）先落提案，作者在工坊界面确认后入账。
    if (body.proposed === true) {
      const result = addEventProposal(workId, { ...fields, note: asString(body.note, 'dsh 创作插件提案') });
      return sendJSON(res, 201, { ok: true, ...result, work_id: workId });
    }
    const result = addStoryEvent(workId, fields);
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
    const presentCharacters = prepare('SELECT name, identity, status FROM characters WHERE work_id = ?').all(workId)
      .filter((c) => c.name && text.includes(c.name))
      .map((c) => ({ name: c.name, identity: c.identity, status: c.status }));
    const recentEvents = allEvents.slice(0, 30).map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, foreshadow_status: e.foreshadow_status }));
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
  if (resource === 'novel' && segments[2] === 'chapter_save' && method === 'POST') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    const content = asString(body.content, '');
    if (!content.trim()) return sendError(res, 400, '缺少 content');
    // 旧稿先入历史版本（可恢复），再覆盖正文；返回红线扫描供界面展示。
    const version = saveChapterVersion(chapterId, chapter.title, chapter.summary, chapter.content);
    const title = body.title !== undefined ? asString(body.title, chapter.title) : chapter.title;
    const summary = body.summary !== undefined ? asString(body.summary, chapter.summary) : chapter.summary;
    prepare('UPDATE chapters SET title = ?, summary = ?, content = ?, updated_at = ? WHERE id = ?')
      .run(title, summary, content, now(), chapterId);
    touchWork(chapter.work_id);
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
      dir: HARNESS_DIR
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
    const job = createHarnessJob(String(body.prompt).trim(), {
      timeout: Number(body.timeout) || 10 * 60 * 1000,
      model: body.model || undefined,
      env,
      action: body.action || 'harness',
      workId: Number(body.work_id) || null
    });
    return sendJSON(res, 202, { ok: true, job_id: job.id, status: job.status });
  }

  if (resource === 'harness' && method === 'GET' && segments[2] === 'job') {
    const jobId = query.id || segments[3];
    const job = harnessJobs.get(String(jobId));
    if (!job) return sendError(res, 404, '任务不存在或已过期（服务重启后旧任务会丢失）');
    return sendJSON(res, 200, {
      ok: true,
      id: job.id,
      status: job.status,
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
      try { job.abort?.abort(); } catch (_) { /* 忽略 */ }
      return sendJSON(res, 200, { ok: true, id: job.id, status: 'cancelling' });
    }
    return sendJSON(res, 200, { ok: true, id: job.id, status: job.status });
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'generate_novel') {
    const body = await readBody(req);
    try {
      const result = await generateNovelFromHarness(body.prompt, body.model);
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      logAIError('generate_novel', e, '/api/harness/generate_novel');
      return sendError(res, 502, e.message);
    }
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'stop') {
    // headless 模式每次任务独立进程，无需常驻停止；保留接口便于后续扩展常驻服务。
    return sendJSON(res, 200, { ok: true, message: 'Harness headless 任务无常驻进程' });
  }

  // AI error history
  if (resource === 'ai_errors' && method === 'GET') {
    return sendJSON(res, 200, listAIErrors());
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
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) return sendError(res, 400, '缺少 messages');
      if (action === 'write' || action === 'personality' || action === 'outline' || action === 'chat' || action === 'polish' || action === 'expand' || action === 'pipeline') {
        const data = await callAI(config, messages, { temperature: body.temperature, max_tokens: body.max_tokens });
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
    try {
      if (method === 'GET' && !id) {
        const where = {};
        for (const key of ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'category_id', 'character_id', 'from_character_id', 'to_character_id']) {
          if (query[key] !== undefined) where[key] = Number(query[key]);
        }
        return sendJSON(res, 200, getList(resource, where));
      }
      if (method === 'GET' && id) {
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        return row ? sendJSON(res, 200, row) : sendError(res, 404, 'Not found');
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const newId = insertRow(resource, body);
        if (body.work_id) touchWork(body.work_id);
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(newId);
        return sendJSON(res, 201, row);
      }
      if (method === 'PUT' && id) {
        const body = await readBody(req);
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        updateRow(resource, id, body);
        if (old?.work_id) touchWork(old.work_id);
        if (body.work_id) touchWork(body.work_id);
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        return sendJSON(res, 200, row);
      }
      if (method === 'DELETE' && id) {
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        deleteRow(resource, id);
        if (old?.work_id) touchWork(old.work_id);
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
      fs.createReadStream(filePath).pipe(res);
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

const server = http.createServer(async (req, res) => {
  const { pathname, query } = getPath(req);
  try {
    if (pathname.startsWith('/api/')) {
      await handleAPI(req, res, pathname, query);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    sendError(res, 500, e.message);
  }
});

server.listen(PORT, () => {
  console.log(`Novel Studio is running at http://localhost:${PORT}`);
});
