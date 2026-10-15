/**
 * nsdsh/lib/network-guard.cjs —— 子进程用的**网络拒绝**补丁（CommonJS，供 `--require` 注入）。
 *
 * 为什么必须是 CommonJS：Node 的 `--require` 只接受 CJS。本项目主代码是纯 ESM，
 * 但这个文件**不进业务 import 路径**，只作为子进程启动参数被加载。
 *
 * 它做什么：把 `fetch` / `http.request` / `https.request` 包一层 ——
 * 目标主机**必须是回环地址**（127.0.0.0/8、::1、localhost）或 Unix socket，
 * 否则抛 `NSDSH_EGRESS_DENIED`，并把违规记录追加到 `NSDSH_EGRESS_LOG` 指向的文件。
 *
 * 为什么不能只靠"清空环境变量"：方案稿 §13.3 明说不允许用清环境变量冒充网络控制。
 * 环境变量可以清掉，而这里的拒绝发生在**调用点**，起点不是配置。
 *
 * 覆盖不到的地方（如实记录，不假装完整）：
 *   · `node:net` 直接建 socket、`dgram`、原生 addon —— 未拦；测试里由 `assertNoEgress`
 *     读违规日志的**空**作为证据，日志非空即判失败。
 *   · 已有进程在补丁生效前建立的连接 —— S01 的注入发生在 `--require` 阶段，
 *     早于被测模块 import，因此被测代码拿到的已经是打过补丁的版本。
 */
'use strict';
const fs = require('node:fs');

const ALLOW = (host) => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true; // 空主机 = 同进程/相对地址，交给上层
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h)) return true;
  if (h === '0.0.0.0') return true; // 监听地址，不是外发目标
  return false;
};

function record(target, kind) {
  const line = `${new Date().toISOString()}\t${kind}\t${target}\n`;
  const p = process.env.NSDSH_EGRESS_LOG;
  if (p) {
    try { fs.appendFileSync(p, line, 'utf8'); } catch (_) { /* 日志写不进去也不能让拒绝失效 */ }
  }
  if (process.env.NSDSH_EGRESS_VERBOSE === '1') process.stderr.write(`[nsdsh-egress] ${line}`);
}

function deny(target, kind) {
  record(target, kind);
  const e = new Error(`NSDSH_EGRESS_DENIED: 隔离测试禁止访问非回环地址 ${target}`);
  e.code = 'NSDSH_EGRESS_DENIED';
  throw e;
}

const http = require('node:http');
const https = require('node:https');

function wrap(mod, scheme, kind) {
  const orig = mod.request;
  mod.request = function patchedRequest(...args) {
    // 两种调用式：request(url[, options][, cb]) 与 request(options[, cb])
    let host = null;
    let port = null;
    const first = args[0];
    if (typeof first === 'string' || first instanceof URL) {
      try {
        const u = new URL(String(first));
        host = u.hostname; port = u.port;
      } catch (_) { host = null; }
    } else if (first && typeof first === 'object') {
      host = first.hostname || first.host || null;
      port = first.port || null;
    }
    if (host && !ALLOW(host)) deny(`${scheme}://${host}${port ? `:${port}` : ''}`, kind);
    return orig.apply(this, args);
  };
  mod.get = function patchedGet(...args) {
    const r = mod.request(...args);
    r.end();
    return r;
  };
}
wrap(http, 'http', 'http.request');
wrap(https, 'https', 'https.request');

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    let host = null;
    try {
      if (typeof input === 'string' || input instanceof URL) host = new URL(String(input)).hostname;
      else if (input && typeof input === 'object' && input.url) host = new URL(input.url).hostname;
    } catch (_) { host = null; }
    if (host && !ALLOW(host)) deny(`fetch://${host}`, 'fetch');
    return origFetch.call(this, input, init);
  };
}
