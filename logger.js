// Novel Studio 日志系统（零依赖，仅用 Node 内置模块）。
//
// 双写：
//   1) SQLite app_logs 表（工坊「日志」界面可筛选查看，db 句柄由 initLogger 注入）；
//   2) data/logs/app-YYYY-MM-DD.log 滚动 JSONL 文件（应用卡死/崩溃后仍可排查）。
//
// 每条日志自带：发生时间（ISO 毫秒）、技术栈层级 layer、级别 level、类型 kind、
// 消息 message、代码位置（file:line:func，由调用栈自动解析）、文件地址 code_file、
// 完整堆栈 stack、上下文 context（JSON）。
//
// 层级约定（layer）：
//   server     HTTP API（server.js）
//   db         数据库操作
//   harness    dsh headless 任务（harness.js）
//   ai         AI API 直连调用
//   openviking OpenViking 客户端（openviking.js）
//   sync       OpenViking 同步层（openviking-sync.js）
//   plugin     dsh 插件进程（novel-tools.mjs，经 POST /api/logs 上报）
//   frontend   浏览器端（public/app.js，经 POST /api/logs 上报）
//   process    进程级事件（崩溃/退出等）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据目录与 db.js 保持一致（NOVELSTUDIO_DATA_DIR 可重定向，冒烟测试用）。
function resolveDataDir(env = process.env) {
  if (env.NOVELSTUDIO_DATA_DIR) {
    const p = path.isAbsolute(env.NOVELSTUDIO_DATA_DIR)
      ? env.NOVELSTUDIO_DATA_DIR
      : path.join(process.cwd(), env.NOVELSTUDIO_DATA_DIR);
    return path.resolve(p);
  }
  return path.join(__dirname, 'data');
}
export const DATA_DIR = resolveDataDir();
export const LOG_DIR = path.join(DATA_DIR, 'logs');

export const LEVELS = ['debug', 'info', 'warn', 'slow', 'error'];
export const LAYERS = ['server', 'db', 'harness', 'ai', 'openviking', 'sync', 'plugin', 'frontend', 'process'];
// 远端上报（前端/插件进程）只允许这两个层级，保证 layer 语义可信。
export const REMOTE_LAYERS = ['frontend', 'plugin'];

// 慢请求阈值（server.js 使用）
export const SLOW_REQUEST_MS = 500;

// 保留策略
const MAX_DB_ROWS = 5000;
const MAX_DB_AGE_DAYS = 30;
const MAX_FILE_AGE_DAYS = 14;

// 防刷屏去重窗口（毫秒）；同 layer+level+kind+message 在该窗口内只记一条。
const DEFAULT_DEDUP_MS = 10 * 1000;

let logDb = null; // 惰性注入的 DatabaseSync 句柄（由 server.js 的 initLogger 传入，避免与 db.js 循环依赖）
let dbInitFailed = false;
let dedupMap = new Map(); // key -> last logged timestamp
const stmtCache = new Map();

// 可读错误消息：取第一行非栈帧文本，截断到 400 字符。server.js 与 harness.js 共用（避免重复实现）。
export function readableErrorMessage(err, fallback = '未知错误') {
  const text = String(err?.message || err || '').trim();
  if (!text) return fallback;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const first = lines.find((l) => l && !/^\s*at\s+/.test(l)) || lines[0] || '';
  return (first.length > 400 ? first.slice(0, 400) + '…' : first) || fallback;
}

// 安全序列化：处理循环引用并限制长度，避免日志落盘/落库时因序列化抛错而静默丢日志。
function safeStringify(obj, maxLen = 64000) {
  const seen = new WeakSet();
  let s;
  try {
    s = JSON.stringify(obj, (k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch (_) {
    s = JSON.stringify({ stringify_error: 'unserializable' });
  }
  return String(s || '').slice(0, maxLen);
}

// 批量缓冲：info/warn/slow/debug 走内存缓冲异步落盘，error 走同步直写（崩溃取证）。
let fileBuf = [];
let dbBuf = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushLogs(); }, 1000);
  if (flushTimer.unref) flushTimer.unref();
}

// 定期清理过期去重键，避免 Map 长期膨胀。
setInterval(() => {
  const cutoff = Date.now() - Math.max(DEFAULT_DEDUP_MS, 60 * 1000);
  for (const [k, ts] of dedupMap) if (ts < cutoff) dedupMap.delete(k);
}, 60 * 1000).unref();

// 旧库空格时间戳 → ISO 归一化（与 db.js 迁移一致）。
function normalizeTs(s) {
  const t = String(s || '');
  if (!t) return new Date().toISOString();
  if (t.includes('T')) return t;
  if (t.includes(' ')) return t.replace(' ', 'T') + 'Z';
  return t;
}

function prepare(sql) {
  if (!logDb) return null;
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = logDb.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// ---------- 调用栈解析：定位「发生位置」的代码位置与文件地址 ----------
function parseFrameLine(line) {
  // 形如：    at funcName (file:///C:/.../server.js:123:45)
  //        at file:///C:/.../server.js:123:45
  const m = String(line || '').match(/^\s*at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/);
  if (!m) return null;
  // file:/// 是 3 个斜杠（Windows），剥掉后可能还剩一个前导 /。
  const file = String(m[2] || '').replace(/^file:\/{2,3}/, '').replace(/^\//, '');
  const lineNo = Number(m[3]);
  if (!file || !Number.isInteger(lineNo)) return null;
  return { func: String(m[1] || '').trim(), file, line: lineNo };
}

// 从调用栈中取出第一个「业务代码」帧（跳过本模块与 node 内部），
// 作为日志的代码位置（file:line:func）与文件地址。
function captureCaller() {
  const stack = String(new Error().stack || '').split(/\r?\n/);
  // Windows 下调用栈用 / 分隔，__filename 用 \，统一后比较才能正确跳过本模块帧。
  const selfFile = __filename.replace(/\\/g, '/');
  for (const line of stack.slice(2)) {
    const frame = parseFrameLine(line);
    if (!frame) continue;
    if (frame.file === selfFile || frame.file.startsWith('node:')) continue;
    return frame;
  }
  return null;
}

// 从 error.stack 提取首个业务帧 + 完整堆栈文本。
function errorFrames(error) {
  const stackText = String(error?.stack || '');
  const lines = stackText.split(/\r?\n/);
  let frame = null;
  for (let i = 1; i < lines.length; i++) {
    const f = parseFrameLine(lines[i]);
    if (f) { frame = f; break; }
  }
  return { frame, stackText: stackText.slice(0, 16000) };
}

// ---------- 文件日志（滚动 JSONL） ----------
function logFilePath(date = new Date()) {
  const d = date.toISOString().slice(0, 10);
  return path.join(LOG_DIR, `app-${d}.log`);
}

function writeFileLog(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFilePath(), safeStringify(record) + '\n', 'utf8');
  } catch (_) { /* 文件写失败不影响主流程 */ }
}

function writeDbLog(record) {
  if (!logDb || dbInitFailed) return;
  try {
    prepare(`
      INSERT INTO app_logs (ts, layer, level, kind, message, code_file, code_line, code_func, stack, context, dedup_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)?.run(
      record.ts, record.layer, record.level, record.kind, record.message,
      record.code_file, record.code_line ?? null, record.code_func,
      record.stack, safeStringify(record.context || {}, 8000), record.dedup_key
    );
  } catch (e) { /* 日志落库失败不影响主流程（如数据库被占用） */ }
}

// 冲刷缓冲：把内存中的 info/warn/slow 日志批量落盘/落库。查询前、进程退出前调用。
export function flushLogs() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (fileBuf.length) {
    const lines = fileBuf.join('\n') + '\n';
    fileBuf = [];
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(logFilePath(), lines, 'utf8');
    } catch (_) { /* 忽略 */ }
  }
  if (dbBuf.length) {
    const records = dbBuf;
    dbBuf = [];
    if (logDb && !dbInitFailed) {
      try {
        const stmt = prepare(`
          INSERT INTO app_logs (ts, layer, level, kind, message, code_file, code_line, code_func, stack, context, dedup_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        if (stmt) {
          logDb.exec('BEGIN');
          try {
            for (const r of records) {
              stmt.run(r.ts, r.layer, r.level, r.kind, r.message, r.code_file, r.code_line ?? null, r.code_func, r.stack, r.context, r.dedup_key);
            }
            logDb.exec('COMMIT');
          } catch (e) {
            try { logDb.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
          }
        }
      } catch (_) { /* 忽略 */ }
    }
  }
}

function consoleEcho(record, where) {
  const loc = where ? ` (${where.file}${where.line != null ? ':' + where.line : ''})` : '';
  const text = `[logger:${record.layer}] ${record.message}${loc}`;
  if (record.level === 'error') console.error(text);
  else if (record.level === 'warn' || record.level === 'slow') console.warn(text);
  else console.log(text);
}

/**
 * 记录一条日志。永不抛异常——日志系统自身故障不得影响主流程。
 *
 * @param {object} entry
 *   level   'debug'|'info'|'warn'|'slow'|'error'（默认 'info'）
 *   layer   技术栈层级（LAYERS 之一）
 *   kind    事件类型（如 http_error / slow_request / block / timeout / ai_error）
 *   message 一行可读消息
 *   error   可选 Error 对象：自动解析其堆栈为代码位置/文件地址
 *   context 可选上下文对象（work_id、endpoint、duration_ms 等）
 *   remote  true 表示来自远端上报：使用 entry 给定的 code_file/code_line/code_func/stack，不再解析服务端调用栈
 *   dedupMs 去重窗口（默认 10s；同 layer+kind+message 内只记一条）
 */
export function log(entry = {}) {
  try {
    const level = LEVELS.includes(entry.level) ? entry.level : 'info';
    const layer = LAYERS.includes(entry.layer) ? entry.layer : 'server';
    const kind = String(entry.kind || 'event').slice(0, 40);
    const message = String(entry.message ?? '').slice(0, 4000);
    const context = (entry.context && typeof entry.context === 'object') ? entry.context : {};

    // 防刷屏：同 layer+kind+message 在 dedup 窗口内只记第一条。
    const dedupKey = `${layer}|${level}|${kind}|${message.slice(0, 160)}`;
    const dedupMs = Number(entry.dedupMs) > 0 ? Number(entry.dedupMs) : DEFAULT_DEDUP_MS;
    const nowMs = Date.now();
    const last = dedupMap.get(dedupKey);
    if (last && nowMs - last < dedupMs) return;
    dedupMap.set(dedupKey, nowMs);
    if (dedupMap.size > 4000) {
      // 批量清理过期键，避免 Map 无限增长
      for (const [k, ts] of dedupMap) if (nowMs - ts > Math.max(dedupMs, 60 * 1000)) dedupMap.delete(k);
    }

    // 定位发生位置：远端上报用自带坐标；本地用调用栈解析。
    let codeFile = '';
    let codeLine = null;
    let codeFunc = '';
    let stackText = '';
    if (entry.remote) {
      codeFile = String(entry.code_file || '').slice(0, 2000);
      codeLine = Number.isInteger(Number(entry.code_line)) ? Number(entry.code_line) : null;
      codeFunc = String(entry.code_func || '').slice(0, 200);
      stackText = String(entry.stack || '').slice(0, 16000);
    } else if (entry.error) {
      const { frame, stackText: st } = errorFrames(entry.error);
      if (frame) { codeFile = frame.file; codeLine = frame.line; codeFunc = frame.func; }
      stackText = st;
    } else if (level === 'warn' || level === 'slow' || level === 'error') {
      // 仅 warn/slow/error 解析调用栈；高频 info/debug 省去 new Error().stack 的开销。
      const caller = captureCaller();
      if (caller) { codeFile = caller.file; codeLine = caller.line; codeFunc = caller.func; }
    }

    const record = {
      ts: new Date().toISOString(),
      layer,
      level,
      kind,
      message,
      code_file: codeFile,
      code_line: codeLine,
      code_func: codeFunc,
      stack: stackText,
      context,
      dedup_key: dedupKey
    };

    if (level === 'error') {
      writeFileLog(record);
      writeDbLog(record);
    } else {
      // 非 error 走内存缓冲，1 秒批量落盘/落库，避免每条日志同步 I/O 阻塞主线程。
      fileBuf.push(safeStringify(record));
      dbBuf.push({ ...record, context: safeStringify(record.context || {}, 8000) });
      scheduleFlush();
    }
    consoleEcho(record, codeFile ? { file: path.basename(codeFile), line: codeLine } : null);
  } catch (_) { /* 日志自身异常一律吞掉 */ }
}

/**
 * 测量一段同步代码耗时，超过阈值自动记 slow 日志（把「不流畅」归因到具体代码位置）。
 * @returns {*} fn() 的返回值
 */
export function timed(layer, label, fn, thresholdMs = SLOW_REQUEST_MS) {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms > thresholdMs) {
      log({
        level: 'slow', layer, kind: 'slow_op',
        message: `${label} 耗时 ${Math.round(ms)}ms（阈值 ${thresholdMs}ms）`,
        context: { label, duration_ms: Math.round(ms) },
        dedupMs: 30 * 1000
      });
    }
  }
}

/**
 * 测量一段异步操作耗时（用于 await 流程），超阈值记 slow 日志。
 */
export async function timedAsync(layer, label, promiseFactory, thresholdMs = SLOW_REQUEST_MS) {
  const t0 = performance.now();
  try {
    return await promiseFactory();
  } finally {
    const ms = performance.now() - t0;
    if (ms > thresholdMs) {
      log({
        level: 'slow', layer, kind: 'slow_op',
        message: `${label} 耗时 ${Math.round(ms)}ms（阈值 ${thresholdMs}ms）`,
        context: { label, duration_ms: Math.round(ms) },
        dedupMs: 30 * 1000
      });
    }
  }
}

// ---------- 事件循环滞后监测：检测主线程卡顿（阻塞） ----------
let lagMonitorStarted = false;
export function startLagMonitor({
  intervalMs = 1000,
  warnMs = 400,
  errorMs = 1500,
  quietMs = 30 * 1000
} = {}) {
  if (lagMonitorStarted) return;
  lagMonitorStarted = true;
  let lastTick = Date.now();
  let lastLagLogAt = 0;
  let maxLag = 0;
  let maxLagAt = 0;
  const timer = setInterval(() => {
    const nowMs = Date.now();
    const lag = nowMs - lastTick - intervalMs;
    lastTick = nowMs;
    if (lag >= warnMs) {
      if (lag > maxLag) { maxLag = lag; maxLagAt = nowMs; }
      // 静默期内不重复刷日志（同一次卡顿多次触发只报一次，取峰值）
      if (nowMs - lastLagLogAt >= quietMs) {
        const level = maxLag >= errorMs ? 'error' : 'warn';
        log({
          level, layer: 'process', kind: 'block',
          message: `事件循环阻塞 ${maxLag}ms（阈值 ${warnMs}ms），期间界面/接口会卡顿`,
          context: { lag_ms: maxLag, detected_at: new Date(maxLagAt).toISOString(), interval_ms: intervalMs }
        });
        lastLagLogAt = nowMs;
        maxLag = 0;
        maxLagAt = 0;
      }
    }
  }, intervalMs);
  timer.unref();
}

// ---------- 进程级兜底：崩溃/未处理拒绝/退出 ----------
let processGuardsInstalled = false;
let exitHandler = null;
export function installProcessGuards(onExit) {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  exitHandler = typeof onExit === 'function' ? onExit : null;

  process.on('uncaughtException', (err) => {
    log({
      level: 'error', layer: 'process', kind: 'crash',
      message: `未捕获异常：${String(err?.message || err)}`,
      error: err
    });
    flushLogs();
    // 状态可能已损坏，按 Node 官方建议退出；延迟片刻确保日志已落盘。
    setTimeout(() => process.exit(1), 200);
  });

  process.on('unhandledRejection', (reason) => {
    // 仅记录不退出：多数未处理拒绝是单次请求副作用，退出会掩盖并放大故障面；
    // 真正崩溃由 uncaughtException 兜底。此策略与本地服务的容错取向一致。
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log({
      level: 'error', layer: 'process', kind: 'crash',
      message: `未处理的 Promise 拒绝：${String(err.message)}`,
      error: err
    });
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) { process.exit(0); return; } // 第二次信号强制退出
    shuttingDown = true;
    log({
      level: 'info', layer: 'process', kind: 'lifecycle',
      message: `服务退出（${signal}）`,
      context: { signal }
    });
    // 有序退出：先冲刷防抖同步（server 传入 onExit），再冲刷日志，最后退出。
    Promise.resolve()
      .then(() => (exitHandler ? exitHandler() : null))
      .catch(() => {})
      .finally(() => { flushLogs(); setTimeout(() => process.exit(0), 100); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------- 保留策略 ----------
export function pruneLogs() {
  // 数据库：保留最新 MAX_DB_ROWS 条，且删除超过 MAX_DB_AGE_DAYS 天的行。
  if (logDb && !dbInitFailed) {
    try {
      prepare(`
        DELETE FROM app_logs WHERE id NOT IN (
          SELECT id FROM app_logs ORDER BY id DESC LIMIT ?
        )
      `)?.run(MAX_DB_ROWS);
      prepare(`
        DELETE FROM app_logs WHERE ts < ?
      `)?.run(new Date(Date.now() - MAX_DB_AGE_DAYS * 24 * 3600 * 1000).toISOString());
    } catch (_) { /* 清理失败无碍 */ }
  }
  // 文件：删除超过 MAX_FILE_AGE_DAYS 天的 app-*.log。
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - MAX_FILE_AGE_DAYS * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const f = path.join(LOG_DIR, name);
      try {
        if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f);
      } catch (_) { /* 单个文件清理失败跳过 */ }
    }
  } catch (_) { /* 目录读取失败无碍 */ }
}

// ---------- 查询（供 /api/logs 使用） ----------
function parseContext(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * 按筛选条件查询日志。
 * @returns {{ entries: Array, stats: { total: number, by_level: object } }}
 */
export function queryLogs({ level = '', layer = '', kind = '', q = '', limit = 100, beforeId = null } = {}) {
  flushLogs(); // 查询前先冲刷缓冲，确保界面能看到刚发生的日志
  if (!logDb || dbInitFailed) return { entries: [], stats: { total: 0, by_level: {} } };
  const where = [];
  const params = [];
  const statsWhere = [];
  const statsParams = [];
  const addFilter = (sql, p) => { where.push(sql); params.push(p); statsWhere.push(sql); statsParams.push(p); };
  if (LEVELS.includes(level)) addFilter('level = ?', level);
  if (LAYERS.includes(layer)) addFilter('layer = ?', layer);
  if (kind) addFilter('kind = ?', String(kind).slice(0, 40));
  if (q) addFilter('message LIKE ?', `%${String(q).slice(0, 200)}%`);
  if (beforeId) { where.push('id < ?'); params.push(Number(beforeId)); } // 翻页条件不参与统计
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const statsWhereSql = statsWhere.length ? `WHERE ${statsWhere.join(' AND ')}` : '';
  const limitN = Math.min(Math.max(Number(limit) || 100, 1), 500);

  const rows = prepare(`
    SELECT id, ts, layer, level, kind, message, code_file, code_line, code_func, stack, context
    FROM app_logs ${whereSql}
    ORDER BY id DESC LIMIT ?
  `)?.all(...params, limitN) || [];

  const statsRows = prepare(`
    SELECT level, COUNT(*) AS c FROM app_logs ${statsWhereSql} GROUP BY level
  `)?.all(...statsParams) || [];
  const byLevel = {};
  let total = 0;
  for (const r of statsRows) { byLevel[r.level] = r.c; total += r.c; }

  const entries = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    layer: r.layer,
    level: r.level,
    kind: r.kind,
    message: r.message,
    code_file: r.code_file,
    code_line: r.code_line,
    code_func: r.code_func,
    stack: r.stack,
    context: parseContext(r.context)
  }));
  return { entries, stats: { total, by_level: byLevel } };
}

export function clearLogs() {
  flushLogs();
  if (logDb && !dbInitFailed) {
    try { prepare('DELETE FROM app_logs')?.run(); } catch (_) { /* 忽略 */ }
  }
  // 同步清空滚动日志文件（历史日期文件由保留策略按期清理）。
  try {
    if (fs.existsSync(LOG_DIR)) {
      for (const name of fs.readdirSync(LOG_DIR)) {
        if (/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) {
          fs.writeFileSync(path.join(LOG_DIR, name), '', 'utf8');
        }
      }
    }
  } catch (_) { /* 忽略 */ }
  dedupMap.clear();
  return true;
}

// 兼容旧 ai_error_logs：把历史 AI 错误迁移进统一日志表（一次性，靠 dedup_key 幂等）。
function migrateAiErrorLogs() {
  if (!logDb || dbInitFailed) return;
  try {
    // 一次性迁移：完成即打标记，避免保留策略删掉已迁移行后每次启动重复插入。
    const done = logDb.prepare("SELECT value FROM app_settings WHERE key = 'ai_errors_migrated'").get();
    if (done) return;
    const old = logDb.prepare('SELECT * FROM ai_error_logs ORDER BY id ASC').all();
    const insert = prepare(`
      INSERT INTO app_logs (ts, layer, level, kind, message, code_file, code_line, code_func, stack, context, dedup_key)
      VALUES (?, 'ai', 'error', 'ai_error', ?, '', NULL, '', ?, ?, ?)
    `);
    const exists = logDb.prepare('SELECT 1 FROM app_logs WHERE dedup_key = ?');
    for (const row of old) {
      const key = `migrated-ai-${row.id}`;
      if (exists.get(key)) continue;
      const context = {
        action: row.action || '',
        endpoint: row.endpoint || '',
        error_code: row.error_code || '',
        migrated: true
      };
      insert?.run(normalizeTs(row.created_at), String(row.message || '').slice(0, 4000), String(row.stack || '').slice(0, 16000), JSON.stringify(context), key);
    }
    logDb.prepare("INSERT INTO app_settings (key, value) VALUES ('ai_errors_migrated', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  } catch (_) { /* 迁移失败不阻塞启动 */ }
}

/**
 * 初始化日志系统（server.js 启动时调用一次）：注入 SQLite 句柄、迁移旧 AI 错误、
 * 清理过期数据、安装进程兜底与卡顿监测、定时执行保留策略。
 */
let initialized = false;
export function initLogger(db, options = {}) {
  if (initialized) return; // 幂等：重复调用不重复装定时器/迁移/监测
  initialized = true;
  logDb = db;
  try {
    migrateAiErrorLogs();
    pruneLogs();
  } catch (e) {
    dbInitFailed = true; // 降级为仅文件日志
    console.warn(`[logger] 初始化失败，降级为仅文件日志：${e.message}`);
  }
  const pruneTimer = setInterval(() => { flushLogs(); pruneLogs(); }, 6 * 3600 * 1000);
  pruneTimer.unref();
  if (options.lagMonitor !== false) startLagMonitor(options.lagMonitorOptions);
  if (options.processGuards !== false) installProcessGuards(options.onExit);
  log({
    level: 'info', layer: 'server', kind: 'lifecycle',
    message: 'Novel Studio 服务启动',
    context: { node: process.version, platform: process.platform, pid: process.pid }
  });
  flushLogs();
}
