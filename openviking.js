// OpenViking 共享记忆库客户端（小说工坊内嵌，零依赖）。
//
// 与 @openviking/dsh-memory-plugin 的凭证解析链**逐档对齐**（2026-09-18 拿插件
// shared/credentials.mjs 逐行核对并补齐差异），保证工坊、GUI dsh 会话、headless dsh 任务
// 读写的是同一个 OpenViking 服务器与记忆库：
//   1. OPENVIKING_* 环境变量（受 OPENVIKING_CREDENTIAL_SOURCE=auto|env|cli 约束，默认 auto）
//   2. 工坊内设置（AI 设置页「OpenViking 记忆库」卡写入 app_settings）
//   3. ~/.openviking/ovcli.conf（路径可被 OPENVIKING_CLI_CONFIG_FILE 覆盖，支持 `~` 展开）
//   4. ~/.openviking/ov.conf（server 段；路径可被 OPENVIKING_CONFIG_FILE 覆盖）
//   5. 默认 http://127.0.0.1:1933
//
// 刻意不实现（已知差异，别再当漏做去"补"）：插件还认 OPENVIKING_MCP_URL 及
// account/user/peer 一组环境变量、以及"旧安装把 ovcli 形状的文件放在 OPENVIKING_CONFIG_FILE"
// 的兼容分支；工坊只用 HTTP（endpoint + api_key + peer_id）与 JSON 配置文件。
//
// ⚠️ 第 2 层为什么存在：会命令行、会改 ~/.openviking 配置的人是少数；
// 界面给了输入框才叫「填了就能用」。它由 server.js 从 app_settings 读出后注入
// （本模块**不 import db**，保持零依赖、可离线单测）。
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

// ---------- 工坊内设置层（AI 设置页填写） ----------
// 只保存**显式填过**的两项：地址与 Key。其余（account/user/peer）仍走原有链，
// 避免界面变成"半套配置"的来源不明。
let workshopConfig = { endpoint: '', apiKey: '' };

/** 由 server.js 在启动时与保存时注入；传空串表示回到下层（配置文件/默认值）。 */
export function setOpenVikingWorkshopConfig(next = {}) {
  workshopConfig = { endpoint: str(next.endpoint, ''), apiKey: str(next.apiKey, '') };
  return { ...workshopConfig };
}

export function getOpenVikingWorkshopConfig() {
  return { ...workshopConfig };
}

// ---------- 凭证解析（与插件 shared/credentials.mjs 同链） ----------
// 来源标签供界面如实展示「现在这份凭证是从哪来的」——不展示来源的配置界面，
// 遇到"填了没生效"时作者与助手都只能靠猜。
const SOURCE_LABELS = {
  env: '环境变量',
  workshop: '工坊内设置（本页填写）',
  cli: '~/.openviking/ovcli.conf',
  conf: '~/.openviking/ov.conf',
  default: '默认值',
  none: '未配置'
};

/** 与插件 shared/credentials.mjs 的 normalizePath 同语义：`~`、`~/x`、相对路径都要能解析。
 *  为什么必须照抄：两个 env 覆盖点（OPENVIKING_CLI_CONFIG_FILE / OPENVIKING_CONFIG_FILE）
 *  是**插件与工坊共用**的。作者按插件习惯写成 `~/.openviking/ovcli.conf` 时，
 *  插件能展开、工坊不展开 → 工坊读不到文件、来源标签退回 default、连到默认 127.0.0.1:1933，
 *  而 dsh 侧读的是另一个地址 —— 正是本模块开头要消灭的「工坊连上了、AI 写作却召回不到」。
 *  （2026-09-18 第四轮重审：拿插件源码逐行比对后补上。） */
function normalizePath(value) {
  const raw = str(value, '');
  if (!raw) return '';
  if (raw === '~') return HOME;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.resolve(path.join(HOME, raw.slice(2)));
  return path.resolve(raw);
}

/** 配置文件路径（两个 env 覆盖点与解析链共用同一份，避免两处各拼一次）。 */
function openVikingConfigPaths(env = process.env) {
  return {
    cli: normalizePath(env.OPENVIKING_CLI_CONFIG_FILE) || path.join(HOME, '.openviking', 'ovcli.conf'),
    conf: normalizePath(env.OPENVIKING_CONFIG_FILE) || path.join(HOME, '.openviking', 'ov.conf')
  };
}

/** 凭证来源模式（与插件的 sourceMode 同语义）：auto | env | cli。 */
function ovSourceMode(env) {
  const raw = str(env.OPENVIKING_CREDENTIAL_SOURCE, str(env.OPENVIKING_CREDENTIALS_SOURCE, 'auto')).toLowerCase();
  if (raw === 'env' || raw === 'environment') return 'env';
  if (raw === 'cli' || raw === 'ovcli' || raw === 'file' || raw === 'config') return 'cli';
  return 'auto';
}

// 地址与 Key 的优先级阶梯**只在这里定义一次**（取值与来源同源，不另算一套）。
// mode 与插件一致：'cli' 跳过环境变量与工坊内设置；'env' 跳过配置文件（只认环境变量）。
function pickEndpoint(env, cliFile, ovFile, workshop, mode = 'auto') {
  const ladder = [
    { source: 'env', value: mode === 'cli' ? '' : str(env.OPENVIKING_URL, str(env.OPENVIKING_BASE_URL, '')) },
    { source: 'workshop', value: mode === 'cli' ? '' : str(workshop.endpoint, '') },
    { source: 'cli', value: mode === 'env' ? '' : str(cliFile.url, '') },
    { source: 'conf', value: mode === 'env' ? '' : str((ovFile.server || {}).url, '') }
  ];
  for (const step of ladder) {
    if (step.value) return { value: step.value.replace(/\/+$/, ''), source: step.source };
  }
  const server = ovFile.server || {};
  const host = str(server.host, '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  const port = Number.isFinite(Number(server.port)) ? Math.floor(Number(server.port)) : 1933;
  // 用 host/port 拼出来的地址**也来自 ov.conf**：来源必须如实标成 conf，不能标 default。
  // （离线测试 A3 抓到过这一处：值取自配置文件、标签却写"默认值"——配置界面上，
  //  一句会撒谎的来源标签比没有标签更糟。）
  const fromConf = mode !== 'env'
    && Boolean(str(server.host, '') || (server.port !== undefined && server.port !== null && String(server.port).trim() !== ''));
  return { value: `http://${host}:${port}`, source: fromConf ? 'conf' : 'default' };
}

function pickApiKey(env, cliFile, ovServer, workshop, mode = 'auto') {
  const ladder = [
    { source: 'env', value: mode === 'cli' ? '' : str(env.OPENVIKING_BEARER_TOKEN, str(env.OPENVIKING_API_KEY, '')) },
    { source: 'workshop', value: mode === 'cli' ? '' : str(workshop.apiKey, '') },
    { source: 'cli', value: mode === 'env' ? '' : str(cliFile.api_key, '') },
    { source: 'conf', value: mode === 'env' ? '' : str(ovServer.root_api_key, '') }
  ];
  for (const step of ladder) {
    if (step.value) return { value: step.value, source: step.source };
  }
  return { value: '', source: 'none' };
}

export function resolveOpenVikingConfig(env = process.env, workshop = workshopConfig) {
  const paths = openVikingConfigPaths(env);
  const cliFile = tryLoadJson(paths.cli) || {};
  const ovFile = tryLoadJson(paths.conf) || {};
  const ovServer = ovFile.server || {};
  // 来源模式与插件同源：作者设了 OPENVIKING_CREDENTIAL_SOURCE=cli 时，
  // 工坊也必须只用 ovcli.conf（否则两侧连的可能不是同一个服务器）。
  const mode = ovSourceMode(env);
  const endpoint = pickEndpoint(env, cliFile, ovFile, workshop, mode);
  const apiKey = pickApiKey(env, cliFile, ovServer, workshop, mode);

  // 与 harness.js 的 OPENVIKING_PEER_ID 一致：优先显式配置，否则按工坊目录派生，
  // 使 GUI 会话、headless 任务、工坊本体全部归属同一个 peer（共享记忆库）。
  const peerId = str(env.OPENVIKING_PEER_ID, str(env.NOVELSTUDIO_OPENVIKING_PEER_ID, ''))
    || str(cliFile.actor_peer_id, str(cliFile.peer_id, ''))
    || String(__dirname).replace(/[^A-Za-z0-9]/g, '-');

  return {
    endpoint: endpoint.value,
    endpointSource: endpoint.source,
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    account: str(env.OPENVIKING_ACCOUNT, str(cliFile.account, str(cliFile.account_id, ''))),
    user: str(env.OPENVIKING_USER, str(cliFile.user, str(cliFile.user_id, ''))),
    peerId,
    requestTimeoutMs: Number(env.OPENVIKING_REQUEST_TIMEOUT_MS) || 10000
  };
}

/** 供界面显示：解析到的地址/Key 来源与配置文件落点（不含 Key 明文）。 */
export function openVikingConfigInfo(env = process.env) {
  const cfg = resolveOpenVikingConfig(env);
  return {
    endpoint: cfg.endpoint,
    endpoint_source: cfg.endpointSource,
    endpoint_source_label: SOURCE_LABELS[cfg.endpointSource] || cfg.endpointSource,
    api_key_source: cfg.apiKeySource,
    api_key_source_label: SOURCE_LABELS[cfg.apiKeySource] || cfg.apiKeySource,
    has_api_key: Boolean(cfg.apiKey),
    config_paths: openVikingConfigPaths(env)
  };
}

// ---------- 一键把工坊内设置写入全局 ovcli.conf（让 dsh 侧共用同一套凭证） ----------
// 为什么需要：工坊、GUI dsh 会话、headless 写作任务读的都是这一份文件。
// 只在工坊内保存时 dsh 侧仍读旧凭证，会出现「工坊连上了、AI 写作却召回不到」的错觉。
//
// 安全纪律（三条都不可省）：
//   1) 只改 url / api_key 两个字段，其它字段（account/user/peer_id…）原样保留；
//   2) 写前**先备份**到 <path>.bak-<时间戳>，并把还原方法回给界面；
//   3) 原文件存在但不是合法 JSON 时**拒绝写入**——绝不用一份新文件覆盖读不懂的旧文件。
const LOCAL_STAMP = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');

export function writeGlobalOpenVikingConfig({ endpoint, apiKey } = {}, env = process.env) {
  const cliPath = openVikingConfigPaths(env).cli;
  let existed = false;
  let originalText = '';
  try {
    if (fs.existsSync(cliPath)) {
      existed = true;
      originalText = fs.readFileSync(cliPath, 'utf8');
    }
  } catch (e) {
    return { ok: false, path: cliPath, error: `读取失败：${e.message}` };
  }

  let doc = {};
  if (existed) {
    try {
      doc = JSON.parse(originalText);
    } catch {
      return { ok: false, path: cliPath, error: `${cliPath} 不是合法 JSON，已拒绝写入（请先人工确认这个文件）` };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, path: cliPath, error: `${cliPath} 顶层不是 JSON 对象，已拒绝写入` };
    }
  }

  const nextEndpoint = str(endpoint, '');
  const nextKey = str(apiKey, '');
  const changed = [];
  if (nextEndpoint && doc.url !== nextEndpoint) { doc.url = nextEndpoint; changed.push('url'); }
  if (nextKey && doc.api_key !== nextKey) { doc.api_key = nextKey; changed.push('api_key'); }
  if (!changed.length) {
    return { ok: true, path: cliPath, backup: '', changed: [], message: '全局配置已是同一份凭证，未改动' };
  }

  let backup = '';
  try {
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    if (existed) {
      backup = `${cliPath}.bak-${LOCAL_STAMP()}`;
      fs.writeFileSync(backup, originalText, 'utf8');
    }
    // 原子替换：先写临时文件再 rename，避免写到一半崩溃留下半个配置文件。
    const tmp = `${cliPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, cliPath);
  } catch (e) {
    return { ok: false, path: cliPath, backup, error: `写入失败：${e.message}` };
  }
  return {
    ok: true,
    path: cliPath,
    backup,
    changed,
    restore_hint: backup
      ? `还原：把 ${backup} 复制回 ${cliPath}`
      : `还原：删除 ${cliPath}（写入前它不存在）`
  };
}

// ---------- HTTP 客户端（镜像插件 client.mjs 的响应信封） ----------
class OpenVikingClient {
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

  // ⚠️ 这里曾有一个 `batchWrite()`（/api/v1/content/batch-write）。2026-09-06 实测证伪：
  // 服务端对**尚不存在的目标文件**的 batch 返回 404，而首轮同步恰恰全是新建文件 →
  // openviking-sync.js 已改为逐文件 `write(replace)`（见其文件头注释）。
  // 2026-09-18 清理：客户端方法与队列里的 batch 分支一并删除——留着等于把已被证伪的
  // 路径伪装成"还能用"，下一个人很可能重新启用它。

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

// ⚠️ 客户端必须**可重建**：作者在 AI 设置页改完地址/Key 后，若这里仍是启动时创建的
// 那一个，界面会显示"已保存"，而所有真实请求还在打旧地址、用旧 Key——正是
// 「改了就会被看到」那条教训的反面形态。保存后由 server.js 调 reloadOpenVikingClient()。
// export let（而不是 const）+ ESM 活绑定：openviking-sync.js / server.js 里
// `ovClient.xxx(...)` 的读法在重建后自动指向新实例，无需改动任何调用点。
export let ovClient = new OpenVikingClient(resolveOpenVikingConfig());

/** 用当前解析链重建客户端，返回新配置（供保存接口立即复测连通性）。 */
export function reloadOpenVikingClient() {
  ovClient = new OpenVikingClient(resolveOpenVikingConfig());
  return ovClient.config;
}

// ---------- 离线 pending 队列 ----------
// 内存权威队列 + 文件持久化镜像：入队与重放都以内存为准，避免「重放结束整文件覆盖写」
// 把重放期间新入队的操作（含同 URI 合并的最新内容）静默抹掉（OV-01 丢失更新竞态）。
const QUEUE_FILE = path.join(DATA_DIR, 'openviking-pending.jsonl');
const DEAD_FILE = path.join(DATA_DIR, 'openviking-dead.jsonl');
const QUEUE_MAX_ATTEMPTS = 3;
const QUEUE_MAX_ITEMS = 1000;
let queueDraining = false;
let queueCache = null;

const opKey = (op) => (op.kind === 'remove' ? `rm:${op.uri}` : `wr:${op.uri}`);

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
    const isWrite = (k.startsWith('wr:') || k.startsWith('rm:')) && k.slice(3).startsWith(workUri);
    if (isWrite) { queue.splice(i, 1); changed = true; }
  }
  if (changed) writeQueue(queue);
}

async function applyOp(op) {
  if (op.kind === 'remove') return ovClient.remove(op.uri, { recursive: true });
  if (op.kind === 'write') return ovClient.write(op.uri, op.content || '', { wait: false, mode: op.mode || 'replace' });
  // 未知 kind（例如旧版本遗留的 'batch'）：**显式判失败**而不是往下走。
  // 往下走会拿 undefined uri 去发请求，报错信息与真实原因无关；显式失败会走满重试次数后落死信文件，
  // 让人能在 openviking-dead.jsonl 里看见"这条操作类型已经没人支持了"。
  return { ok: false, error: { message: `不支持的队列操作类型：${String(op.kind)}（batch 路径已于 2026-09-18 移除）` } };
}

// 仅本文件使用（文件末尾的 45 秒定时器调用）；2026-09-18 去掉 export。
async function drainOpenVikingQueue() {
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
