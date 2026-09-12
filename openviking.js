// OpenViking 共享记忆库客户端（小说工坊内嵌，零依赖）。
//
// 与 @openviking/dsh-memory-plugin 共用同一套凭证解析链，保证工坊、
// GUI dsh 会话、headless dsh 任务读写的是同一个 OpenViking 服务器与记忆库：
//   1. OPENVIKING_* 环境变量
//   2. ~/.openviking/ovcli.conf
//   3. ~/.openviking/ov.conf（server 段）
//   4. 默认 http://127.0.0.1:1933
//
// 写入失败（服务器未启动等）时落本地 pending 队列（data/openviking-pending.jsonl），
// 服务器恢复后自动重放，与插件离线消息队列同一思路。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DEFAULT_ENDPOINT = 'http://127.0.0.1:1933';

function str(v, fb = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : fb;
}

function tryLoadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

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

// ---------- 凭证解析（与插件 shared/credentials.mjs 同链） ----------
function resolveEndpoint(env, cliFile, ovFile) {
  const envUrl = str(env.OPENVIKING_URL, str(env.OPENVIKING_BASE_URL, ''));
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const cliUrl = str(cliFile.url, '');
  if (cliUrl) return cliUrl.replace(/\/+$/, '');
  const server = ovFile.server || {};
  const ovUrl = str(server.url, '');
  if (ovUrl) return ovUrl.replace(/\/+$/, '');
  const host = str(server.host, '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  const port = Number.isFinite(Number(server.port)) ? Math.floor(Number(server.port)) : 1933;
  return `http://${host}:${port}`;
}

export function resolveOpenVikingConfig(env = process.env) {
  const cliPath = env.OPENVIKING_CLI_CONFIG_FILE || path.join(HOME, '.openviking', 'ovcli.conf');
  const ovPath = env.OPENVIKING_CONFIG_FILE || path.join(HOME, '.openviking', 'ov.conf');
  const cliFile = tryLoadJson(cliPath) || {};
  const ovFile = tryLoadJson(ovPath) || {};
  const ovServer = ovFile.server || {};

  // 与 harness.js 的 OPENVIKING_PEER_ID 一致：优先显式配置，否则按工坊目录派生，
  // 使 GUI 会话、headless 任务、工坊本体全部归属同一个 peer（共享记忆库）。
  const peerId = str(env.OPENVIKING_PEER_ID, str(env.NOVELSTUDIO_OPENVIKING_PEER_ID, ''))
    || str(cliFile.actor_peer_id, str(cliFile.peer_id, ''))
    || String(__dirname).replace(/[^A-Za-z0-9]/g, '-');

  return {
    endpoint: resolveEndpoint(env, cliFile, ovFile),
    apiKey: str(env.OPENVIKING_BEARER_TOKEN, str(env.OPENVIKING_API_KEY, str(cliFile.api_key, str(ovServer.root_api_key, '')))),
    account: str(env.OPENVIKING_ACCOUNT, str(cliFile.account, str(cliFile.account_id, ''))),
    user: str(env.OPENVIKING_USER, str(cliFile.user, str(cliFile.user_id, ''))),
    peerId,
    requestTimeoutMs: Number(env.OPENVIKING_REQUEST_TIMEOUT_MS) || 10000
  };
}

// ---------- HTTP 客户端（镜像插件 client.mjs 的响应信封） ----------
export class OpenVikingClient {
  constructor(config) {
    this.config = config;
    this.connected = false;
  }

  headers(options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    if (this.config.account) headers['X-OpenViking-Account'] = this.config.account;
    if (this.config.user) headers['X-OpenViking-User'] = this.config.user;
    if (this.config.peerId) headers['X-OpenViking-Actor-Peer'] = this.config.peerId;
    if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
    return headers;
  }

  async fetchJSON(path, init = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.endpoint}${path}`, {
        ...init,
        headers: { ...this.headers(options), ...(init.headers || {}) },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.status === 'error') {
        this.connected = false; // HTTP 4xx/5xx 也标记不可用，避免被误判为 no-hits
        return {
          ok: false,
          result: null,
          status: response.status,
          error: body?.error || { message: `HTTP ${response.status}` }
        };
      }
      this.connected = true;
      return { ok: true, result: body?.result ?? body, status: response.status };
    } catch (error) {
      this.connected = false;
      return {
        ok: false,
        result: null,
        status: 0,
        error: { message: error instanceof Error ? error.message : String(error) }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    const r = await this.fetchJSON('/health', {}, { timeoutMs: 4000 });
    return r.ok;
  }

  // 写一个文件（父目录自动创建）；写完后服务器自动刷新相关语义与向量。
  async write(uri, content, options = {}) {
    return this.fetchJSON('/api/v1/content/write', {
      method: 'POST',
      body: JSON.stringify({
        uri,
        content: String(content),
        mode: options.mode || 'replace',
        wait: options.wait === true
      })
    }, { timeoutMs: options.timeoutMs ?? 30000 });
  }

  // 批量写（≤256 个操作/请求；语义与向量在整批写完后统一刷新一次）。
  async batchWrite(rootUri, operations, options = {}) {
    return this.fetchJSON('/api/v1/content/batch-write', {
      method: 'POST',
      body: JSON.stringify({
        root_uri: rootUri,
        operations,
        wait: options.wait !== false
      })
    }, { timeoutMs: options.timeoutMs ?? 120000 });
  }

  async remove(uri, options = {}) {
    const recursive = options.recursive === true;
    return this.fetchJSON(
      `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=${recursive}`,
      { method: 'DELETE' },
      { timeoutMs: options.timeoutMs ?? 30000 }
    );
  }

  // 语义检索：targetUri 限定子树（作品目录），scoreThreshold 过滤相关度。
  async find(query, options = {}) {
    const body = { query: String(query) };
    if (options.targetUri) body.target_uri = options.targetUri;
    if (options.limit) body.limit = options.limit;
    if (options.scoreThreshold !== undefined) body.score_threshold = options.scoreThreshold;
    const response = await this.fetchJSON('/api/v1/search/find', {
      method: 'POST',
      body: JSON.stringify(body)
    }, { timeoutMs: options.timeoutMs ?? 8000 });
    if (!response.ok || !response.result) return [];

    const results = [];
    for (const bucket of ['memories', 'resources', 'skills']) {
      const entries = response.result[bucket];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        results.push({
          uri: entry?.uri || '',
          contextType: entry?.context_type || (bucket === 'memories' ? 'memory' : bucket === 'skills' ? 'skill' : 'resource'),
          score: Number(entry?.score || 0),
          abstract: entry?.abstract || '',
          overview: entry?.overview || null
        });
      }
    }
    return results;
  }

  async readContent(uri, options = {}) {
    const params = [`uri=${encodeURIComponent(uri)}`];
    if (options.offset !== undefined) params.push(`offset=${Number(options.offset) || 0}`);
    if (options.limit !== undefined && options.limit > 0) params.push(`limit=${Number(options.limit)}`);
    const response = await this.fetchJSON(`/api/v1/content/read?${params.join('&')}`, {}, { timeoutMs: options.timeoutMs ?? 8000 });
    if (!response.ok) return { ok: false, text: '' };
    const text = typeof response.result === 'string'
      ? response.result
      : response.result?.content || response.result?.text || '';
    return { ok: true, text: String(text) };
  }

}

export const ovClient = new OpenVikingClient(resolveOpenVikingConfig());

// ---------- 离线 pending 队列 ----------
// 内存权威队列 + 文件持久化镜像：入队与重放都以内存为准，避免「重放结束整文件覆盖写」
// 把重放期间新入队的操作（含同 URI 合并的最新内容）静默抹掉（OV-01 丢失更新竞态）。
const QUEUE_FILE = path.join(DATA_DIR, 'openviking-pending.jsonl');
const DEAD_FILE = path.join(DATA_DIR, 'openviking-dead.jsonl');
const QUEUE_MAX_ATTEMPTS = 3;
const QUEUE_MAX_ITEMS = 1000;
let queueDraining = false;
let queueCache = null;

const opKey = (op) => (op.kind === 'remove' ? `rm:${op.uri}` : op.kind === 'batch' ? `batch:${op.rootUri}` : `wr:${op.uri}`);

function readQueue() {
  if (queueCache !== null) return queueCache;
  const items = [];
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      for (const line of fs.readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try { items.push(JSON.parse(line)); }
        catch {
          // 坏行隔离到 .corrupt，不把整批待重放操作静默丢弃。
          try { fs.appendFileSync(`${QUEUE_FILE}.corrupt`, line + '\n', 'utf8'); } catch (_) { /* 忽略 */ }
        }
      }
    }
  } catch { /* 读失败返回空，等下次重放 */ }
  queueCache = items;
  return queueCache;
}

function writeQueue(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const content = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
    const tmp = `${QUEUE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, QUEUE_FILE); // 原子替换，避免崩溃截断丢失全部待重放操作
  } catch { /* 队列写盘失败不阻塞主流程 */ }
}

export function enqueueOpenVikingOp(op) {
  const items = readQueue();
  const key = opKey(op);
  const entry = { ...op, ts: Date.now(), tries: 0 };
  const idx = items.findIndex((i) => opKey(i) === key);
  if (idx >= 0) items[idx] = entry; // 同 URI 合并，只保留最新一次
  else items.push(entry);
  while (items.length > QUEUE_MAX_ITEMS) {
    items.shift();
    log({ level: 'warn', layer: 'openviking', kind: 'queue_overflow', message: '离线队列超限，已丢弃最旧条目' });
  }
  writeQueue(items);
  return items.length;
}

export function pendingQueueLength() {
  return readQueue().length;
}

// 直写成功后清除队列中对应旧条目，防止离线期间入队的旧内容在恢复后被重放、覆盖刚写入的新内容。
export function clearQueuedOpForUri(uri) {
  const queue = readQueue();
  const keys = [`wr:${uri}`, `rm:${uri}`];
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (keys.includes(opKey(queue[i]))) { queue.splice(i, 1); changed = true; }
  }
  if (changed) writeQueue(queue);
}

export function clearQueuedOpsForWork(workUri) {
  const queue = readQueue();
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    const k = opKey(queue[i]);
    const isBatch = k.startsWith(`batch:${workUri}`);
    const isWrite = (k.startsWith('wr:') || k.startsWith('rm:')) && k.slice(3).startsWith(workUri);
    if (isBatch || isWrite) { queue.splice(i, 1); changed = true; }
  }
  if (changed) writeQueue(queue);
}

async function applyOp(op) {
  if (op.kind === 'remove') return ovClient.remove(op.uri, { recursive: true });
  if (op.kind === 'batch') return ovClient.batchWrite(op.rootUri, op.operations || [], { wait: false });
  return ovClient.write(op.uri, op.content || '', { wait: false, mode: op.mode || 'replace' });
}

export async function drainOpenVikingQueue() {
  if (queueDraining) return 0;
  queueDraining = true;
  try {
    const queue = readQueue();
    if (!queue.length) return 0;
    const ok = await ovClient.health();
    if (!ok) return 0;
    const snapshot = queue.slice(); // 快照迭代，避免边重放边改索引
    let done = 0;
    for (const op of snapshot) {
      const r = await applyOp(op);
      if (r.ok) {
        // 成功：仅当该 key 仍是快照同一条目时才移除（若重放期间被 enqueue 覆盖为更新条目则保留）。
        const idx = queue.findIndex((i) => opKey(i) === opKey(op));
        if (idx >= 0 && queue[idx].ts === op.ts) queue.splice(idx, 1);
        done += 1;
        continue;
      }
      op.tries = (op.tries || 0) + 1;
      const idx = queue.findIndex((i) => opKey(i) === opKey(op));
      if (idx >= 0 && queue[idx].ts === op.ts) queue[idx].tries = op.tries;
      if (op.tries >= QUEUE_MAX_ATTEMPTS) {
        // 死信：连续失败后写死信文件供人工检查，再移除。
        try { fs.appendFileSync(DEAD_FILE, JSON.stringify(op) + '\n', 'utf8'); } catch (_) { /* 忽略 */ }
        const di = queue.findIndex((i) => opKey(i) === opKey(op));
        if (di >= 0 && queue[di].ts === op.ts) queue.splice(di, 1);
        log({ level: 'warn', layer: 'openviking', kind: 'queue_dropped', message: `队列操作放弃（${op.kind} ${op.uri || op.rootUri}）：${r.error?.message || 'unknown'}` });
      }
    }
    writeQueue(queue);
    return done;
  } catch (e) {
    log({ level: 'warn', layer: 'openviking', kind: 'queue_error', message: `队列重放异常：${e.message}`, error: e });
    return 0;
  } finally {
    queueDraining = false;
  }
}

// 每 45 秒重放一次离线队列（进程内定时器，不阻塞请求）。
setInterval(() => { drainOpenVikingQueue().catch(() => {}); }, 45 * 1000).unref();
