/**
 * nsdsh/lib/isolate.mjs —— 隔离夹具（S01 的可复用核心）。
 *
 * 目标：让任何 nsdsh 测试**不可能**碰到作者的真实环境。逐条对应一类污染：
 *
 *   NOVELSTUDIO_DATA_DIR      → **临时**数据目录（绝不指向 data/、绝不读 data/novel.db）
 *   NOVELSTUDIO_DSH_HOME      → **临时** DSH home（绝不写用户全局 ~/.dsh）
 *   PORT                      → 独立端口（绝不连 3737 的作者实例）
 *   NOVELSTUDIO_OV_DISABLED   → 停用 OpenViking（不写记忆库目录）
 *   NSDSH_EGRESS_LOG + guard  → 网络拒绝（非回环出网即抛 NSDSH_EGRESS_DENIED 并留证）
 *
 * ⚠️ 顺序纪律（本项目的真实事故）：必须在 **import db.js / ai/* 之前**调用
 * `makeIsolatedEnv()` —— 那些模块在 import 时就会解析数据目录并打开库。
 * 因此命名里带 "before import"，且用法在文档与测试里都按"先建环境、再动态 import"写。
 *
 * 为什么还要 `assertNoEgress`：guard 只能证明"我们拦到了调用"，不能证明"没有绕过"。
 * 违规日志为空 + 代码里没有 `node:net` 直连，才是当前能给出的最强证据；两者都不做时
 * 不得声称"已确认无外网访问"。
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GUARD_CJS = path.join(HERE, 'network-guard.cjs');
export const REPO = path.resolve(HERE, '..', '..', '..');

/** 回环判定与 guard 保持一致（同一份规则，避免两处漂移）。 */
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h)) return true;
  if (h === '0.0.0.0') return true;
  return false;
}

/** 端口占用探测（同步、无副作用）。 */
export function isPortFree(port) {
  const srv = net.createServer();
  try {
    srv.listen({ port, host: '127.0.0.1' });
    return true;
  } catch (_) {
    return false;
  } finally {
    try { srv.close(); } catch (_) { /* 未监听 */ }
  }
}

/** 在 [from, to) 里找一个空闲端口；找不到 → 抛错（不猜、不退回 3737）。 */
export function pickFreePort({ from = 38100, to = 38200, exclude = new Set() } = {}) {
  for (let p = from; p < to; p += 1) {
    if (exclude.has(p)) continue;
    let srv;
    try {
      srv = net.createServer();
      srv.listen({ port: p, host: '127.0.0.1' });
    } catch (_) {
      continue;
    } finally {
      try { srv.close(); } catch (_) { /* 未监听 */ }
    }
    return p;
  }
  throw new Error(`在 ${from}-${to} 里找不到空闲端口（不退回 3737：那可能是作者的活实例）`);
}

/**
 * 建隔离环境。**必须在 import db.js / ai/* 之前调用。**
 * @returns 环境句柄（含 env、paths、cleanup、assertNoEgress、fakeProvider）
 */
export function makeIsolatedEnv({ label = 'nsdsh', dshHome = true, egressLog = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'dsh-home');
  const tmpDir = path.join(root, 'tmp');
  const egressPath = path.join(root, 'egress.jsonl');
  for (const d of [dataDir, tmpDir]) fs.mkdirSync(d, { recursive: true });
  if (dshHome) fs.mkdirSync(homeDir, { recursive: true });
  if (egressLog) fs.writeFileSync(egressPath, '', 'utf8');

  const port = pickFreePort();
  const env = {
    ...process.env,
    NOVELSTUDIO_DATA_DIR: dataDir,
    NOVELSTUDIO_OV_DISABLED: '1',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'nsdsh-isolated-peer',
    PORT: String(port),
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    NSDSH_ISOLATED: '1',
    NSDSH_ISOLATED_ROOT: root,
  };
  if (egressLog) env.NSDSH_EGRESS_LOG = egressPath;
  if (dshHome) env.NOVELSTUDIO_DSH_HOME = homeDir;
  // 网络拒绝注入：子进程走 NODE_OPTIONS，同进程走 applyGuardInProcess()。
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS || '', `--require=${GUARD_CJS}`].filter(Boolean).join(' ');

  const handle = {
    label, root, dataDir, homeDir, tmpDir, port, env, egressPath,
    /** 把隔离变量装进当前进程（供随后动态 import 的业务模块读取）。 */
    install() {
      for (const [k, v] of Object.entries(env)) process.env[k] = v;
      return handle;
    },
    /** 撤销隔离变量并把临时目录删干净。幂等。 */
    cleanup() {
      for (const k of ['NOVELSTUDIO_DATA_DIR', 'NOVELSTUDIO_DSH_HOME', 'NSDSH_ISOLATED_ROOT', 'NSDSH_EGRESS_LOG']) {
        if (process.env[k] && process.env[k].startsWith(root)) delete process.env[k];
      }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* 删不掉不掩盖断言 */ }
      return !fs.existsSync(root);
    },
    /** 出网违规记录（原始行）。 */
    egressViolations() {
      if (!egressLog || !fs.existsSync(egressPath)) return [];
      return fs.readFileSync(egressPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    },
    /** 断言"没有出网"：以违规日志为空为证据。 */
    assertNoEgress() {
      const v = handle.egressViolations();
      if (v.length) throw new Error(`隔离环境出现 ${v.length} 次非回环出网：${v[0]}`);
      return true;
    },
  };
  return handle;
}

/**
 * 同进程网络拒绝：给当前进程打 fetch/http/https 补丁。
 * 与子进程的 `--require` 用**同一份规则**（这里复刻，规则短且要能同进程用）。
 */
export function applyGuardInProcess(egressLogPath = process.env.NSDSH_EGRESS_LOG) {
  const record = (target, kind) => {
    if (!egressLogPath) return;
    try { fs.appendFileSync(egressLogPath, `${new Date().toISOString()}\t${kind}\t${target}\n`, 'utf8'); } catch (_) { /* 同上 */ }
  };
  const deny = (target, kind) => {
    record(target, kind);
    const e = new Error(`NSDSH_EGRESS_DENIED: 隔离测试禁止访问非回环地址 ${target}`);
    e.code = 'NSDSH_EGRESS_DENIED';
    throw e;
  };
  for (const [mod, scheme, kind] of [[http, 'http', 'http.request']]) {
    const orig = mod.request;
    mod.request = function patched(...args) {
      let host = null;
      const first = args[0];
      if (typeof first === 'string') { try { host = new URL(first).hostname; } catch (_) { host = null; } }
      else if (first && typeof first === 'object') { host = first.hostname || first.host || null; }
      if (host && !isLoopbackHost(host)) deny(`${scheme}://${host}`, kind);
      return orig.apply(this, args);
    };
  }
  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = function patchedFetch(input, init) {
      let host = null;
      try {
        if (typeof input === 'string' || input instanceof URL) host = new URL(String(input)).hostname;
        else if (input && typeof input === 'object' && input.url) host = new URL(input.url).hostname;
      } catch (_) { host = null; }
      if (host && !isLoopbackHost(host)) deny(`fetch://${host}`, 'fetch');
      return origFetch.call(this, input, init);
    };
  }
  return { record };
}

/**
 * 最小**假模型端点**（零计费、零外网）。
 *
 * 只实现本方案需要的那一点：OpenAI 兼容的 `POST /v1/chat/completions`，
 * 回复内容由调用方给的 `reply` 或 `byPrompt` 决定；**每次请求都被记录**，
 * 供 S02/S06/S10 核对"模型实际收到了什么"（方案稿 §13 的 capture 需求）。
 *
 * ⚠️ 这里必须自己处理 `EADDRINUSE`，不能只依赖 `pickFreePort()`（实测缺陷，2026-10-15）：
 *   `pickFreePort()` 是"绑上、立刻关掉、返回端口号"。只要期间没有流量，端口就**不会**进入
 *   TIME_WAIT，于是连续调用它永远返回同一个号（实测 `pickFreePort() ×5 → 38100 ×5`）。
 *   同一个进程里起第二个假模型时，第一个还占着 38100，`listen` 直接 `EADDRINUSE` 崩掉
 *   ——而 S06/S10 正需要在同一进程里同时挂"被测服务"和"假模型"。
 * 处置：**先试再退**。`listen` 失败就换一个号重试（失败过的号排除掉），最多 `maxAttempts` 次；
 * 仍失败则响亮抛错，不静默换地址、不假装成功。
 */
export async function startFakeModel({ port = null, reply = '{"ok":true}', byPrompt = null, maxAttempts = 8 } = {}) {
  const requests = [];
  const buildServer = () => http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
      requests.push({ method: req.method, url: req.url, body: parsed, raw: body, at: new Date().toISOString() });
      if (req.method === 'GET' && String(req.url).includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'nsdsh-fake', object: 'model' }] }));
        return;
      }
      const text = byPrompt ? byPrompt(parsed) : reply;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'nsdsh-fake-1', object: 'chat.completion', model: 'nsdsh-fake',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });

  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const wanted = attempt === 0 && port != null ? port : pickFreePort({ exclude: tried });
    tried.add(wanted);
    const server = buildServer();
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
        server.once('error', onErr);
        server.listen(wanted, '127.0.0.1', () => resolve());
      });
    } catch (e) {
      lastErr = e;
      try { server.close(); } catch (_) { /* 未监听 */ }
      if (port != null) break; // 调用方指定了端口：不擅自换号
      continue;
    }
    return {
      port: wanted,
      baseUrl: `http://127.0.0.1:${wanted}/v1`,
      requests,
      stop: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }
  throw new Error(`假模型端点启动失败（试过 ${[...tried].join(', ')}）：${(lastErr && lastErr.message) || lastErr}`);
}

/** import 前必须调用的断言：把"忘了建隔离环境"变成响亮失败，而不是静默打开真实库。 */
export function assertIsolated() {
  const dir = process.env.NOVELSTUDIO_DATA_DIR;
  if (!dir) throw new Error('未建立隔离环境：请在 import db.js 之前调用 makeIsolatedEnv().install()');
  const real = path.join(REPO, 'data');
  if (path.resolve(dir).toLowerCase() === path.resolve(real).toLowerCase()) {
    throw new Error(`拒绝把测试数据目录指向真实库：${dir}`);
  }
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()))) {
    throw new Error(`测试数据目录必须位于系统临时目录内，实际为 ${dir}`);
  }
  return dir;
}

/** 供测试文件复用：本模块的 CJS 版本句柄（避免测试自己再拼一份 require）。 */
export const require_ = createRequire(import.meta.url);
