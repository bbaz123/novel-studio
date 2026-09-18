#!/usr/bin/env node
/**
 * fake-llm.mjs —— 「假 LLM」端点：本地 OpenAI 兼容、**会应答**的零成本替身。
 *
 * 为什么需要：blackhole.mjs 只能证明「流量没出海、作业占得住槽」，但它永不响应，
 * 任何任务都只能等到自己的超时——它**无法证明任务能跑完**。
 * 要验证「完整任务端到端跑通」，就必须有一个真的会回话的对端：
 * 于是这里实现一个最小的 OpenAI 兼容端点，返回罐头正文，成本恒为 0。
 *
 * 三条硬约束（都是本仓库踩过的坑）：
 *   1. **默认不落 prompt 原文**：请求体里可能包含用户的小说正文。日志只记元信息
 *      （条数/长度），要看原文必须显式加 --dump（opt-in），避免验证脚本顺手把正文写进仓库。
 *   2. **所有定时器 unref()**：延迟发包的小定时器如果 ref 着，测试进程会在 close() 之后
 *      继续挂着不退出——本仓库已有「前台守护进程不退，只能人工收尸」的事故记录。
 *   3. **客户端中途断开不能崩**：验证脚本常在收到第一个 chunk 后就 abort，
 *      往已销毁的 socket 写数据会触发 error 事件，必须兜住而不是抛出。
 *
 * ⚠️ 实测坑（Node 24.19 / Windows，2026-09-18）：用**全局 fetch** 打过本端点之后，
 *   `await llm.close(); process.exit(0)` 会在 undici 的销毁路径上触发 libuv 断言：
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *   进程以 -1073740791（0xC0000409）中止，看起来像「我们的端点崩了」，其实不是。
 *   对照组（都不含本文件的任何代码）：
 *     · 30 行原生 http 服务器 + 「2 次 fetch → 服务端断连 → process.exit」→ **同样崩**；
 *     · 同场景改为**不调 process.exit**（自然退出）→ 3/3 稳定 exit=0（0.26~0.29s）；
 *     · 只用裸 net socket（不碰 fetch）→ destroy + close + process.exit 稳定 exit=0。
 *   两个实验排除了 close() 的时机：等 socket 真正 close 再退出、退出前干等 25ms，都照崩；
 *   真正的变量是「进程里有没有 undici 池化过的 keep-alive 连接」。
 *   因此调用约定：**库调用方请用「close() 之后让进程自然退出」**（本模块无 ref 定时器、
 *   不残留句柄，natural exit 实测 0.14~0.29s）；CLI 分支不碰 fetch，所以那里的
 *   close() + process.exit() 纪律是安全的（已实测 exit=0）。
 *
 * 用法:
 *   node .p1-baseline/fake-llm.mjs --port 19998 [--log .p1-baseline/fake-llm.jsonl]
 *   node .p1-baseline/fake-llm.mjs --port 0 --reply '【成文】自定义正文。'
 *   node .p1-baseline/fake-llm.mjs --port 0 --replies .p1-baseline/replies.json  # 逐次轮换
 *   node .p1-baseline/fake-llm.mjs --port 0 --dump .p1-baseline/.fake-llm-dump.txt  # 落原文（谨慎）
 *   node .p1-baseline/fake-llm.mjs --status --log <日志>
 *
 * 把 dsh 指到它（零计费跑完整任务）:
 *   $env:DEEPSEEK_BASE_URL='http://127.0.0.1:<port>'
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 默认罐头正文：一眼假（【成文】前缀让它不可能被误当成真实产物），
 * 但仍然是一句**结构完整的正文**，好让下游「成文/落库/字数统计」链路有东西可解析。
 */
export const DEFAULT_REPLY = '【成文】这是零成本假端点返回的正文。';

/** 默认日志路径：与 blackhole 的 JSONL 习惯保持一致，便于 verify-all 之类脚本统一收集。 */
export const DEFAULT_LOG = path.join('.p1-baseline', 'fake-llm.jsonl');

/** 请求体上限：正常小说任务远小于它；超过说明调用方有问题，直接 413 而不是把内存吃满。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** 确保日志目录存在；失败不致命（日志写不进去也不该让端点起不来）。 */
function ensureDir(file) {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); } catch { /* 忽略 */ }
}

/** 请求体里 message.content 可能是字符串，也可能是多段 parts（多模态），统一折算成字符数。 */
function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const p of content) {
      if (typeof p === 'string') n += p.length;
      else if (p && typeof p.text === 'string') n += p.text.length;
    }
    return n;
  }
  return 0;
}

/** prompt 总字符数——只记长度不记内容，这是「日志可入仓」的前提。 */
function promptChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) if (m && typeof m === 'object') n += contentChars(m.content);
  return n;
}

/** 按**码点**切片：不能用 slice（会把代理对劈开，产生半个字符的非法 UTF-8）。 */
function splitPieces(text, maxPieces = 4) {
  const chars = Array.from(text);
  if (chars.length === 0) return [''];
  const n = Math.max(1, Math.min(maxPieces, chars.length));
  const size = Math.ceil(chars.length / n);
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/** 可 unref 的 sleep：定时器不能吊住事件循环，否则 close() 之后进程仍不退出。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * token 数是**估算**（4 字符 ≈ 1 token），只为让下游拿到非零且自洽的 usage，
 * 不代表任何真实计费口径。缓存命中固定 0：假端点无法证明缓存链路。
 */
function makeUsage(pChars, rChars) {
  const promptTokens = Math.max(1, Math.ceil(pChars / 4));
  const completionTokens = Math.max(1, Math.ceil(rChars / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_cache_hit_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

/** 统一出口：对端已断开时静默收工，绝不让「客户端先走」变成服务端异常。 */
function sendJson(res, status, obj) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch { /* 忽略：连接已被对端销毁 */ }
}

/**
 * 起一个会应答的本地 LLM 端点。
 * @param {{port?:number, logPath?:string, reply?:string, replies?:string[], dumpPath?:string, chunkDelayMs?:number}} [opts]
 *   port：0 = 让内核挑空闲端口（测试并发起多个实例时必须用它，避免端口冲突）。
 *   reply：固定罐头正文；replies：JSON 数组，**逐次请求轮换**（多轮任务每轮给不同答案）。
 *   优先级 replies > reply > 环境变量 FAKE_LLM_REPLY > DEFAULT_REPLY：
 *   逐次轮换是「每轮答案不同」的唯一表达方式，一旦给了就应该压过固定单句。
 *   dumpPath：**opt-in** 落原始请求体（含 prompt 原文），默认关闭。
 * @returns {Promise<{port:number, logPath:string, dumpPath:string, requests:Array, count:()=>number, close:()=>Promise<void>}>}
 */
export async function startFakeLLM({
  port = 0,
  logPath = DEFAULT_LOG,
  reply,
  replies,
  dumpPath,
  chunkDelayMs = 30,
} = {}) {
  const list = Array.isArray(replies) ? replies.filter((s) => typeof s === 'string') : [];
  const fixed = typeof reply === 'string' ? reply : (process.env.FAKE_LLM_REPLY || DEFAULT_REPLY);
  const requests = [];
  const sockets = new Set();
  let seq = 0;
  let rotating = 0;

  ensureDir(logPath);
  ensureDir(dumpPath);

  /** 取本次要回的正文；返回下标便于日志回溯「第几轮用了哪条罐头」。 */
  const pickReply = () => {
    if (list.length) {
      const i = rotating % list.length;
      rotating += 1;
      return { text: list[i], index: i };
    }
    return { text: fixed, index: null };
  };

  const server = http.createServer((req, res) => {
    // 路径归一：容忍尾部斜杠（`/chat/completions/` 与 `/chat/completions` 等价）。
    const raw = (req.url || '/').split('?')[0];
    const p = raw.replace(/\/+$/, '') || '/';
    const isChat = p === '/chat/completions' || p === '/v1/chat/completions';

    if (req.method === 'GET' && p === '/health') {
      return sendJson(res, 200, { ok: true, requests: requests.length });
    }
    if (isChat && req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (p === '/health') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (!isChat) return sendJson(res, 404, { error: 'not found' });

    // ── 读请求体 ────────────────────────────────────────────────────────
    let body = '';
    let overflow = false;
    req.setEncoding('utf8');
    req.on('data', (d) => {
      if (overflow) return; // 已回 413：继续收但丢弃，不 destroy（destroy 会掩盖响应）
      body += d;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        overflow = true;
        body = '';
        sendJson(res, 413, { error: 'payload too large', limit: MAX_BODY_BYTES });
      }
    });
    req.on('error', () => { /* 请求侧断开是正常的，交给 res 的 close 处理 */ });
    req.on('end', () => {
      if (overflow) return;

      let parsed;
      try {
        parsed = body.trim() ? JSON.parse(body) : {};
      } catch (e) {
        // 400（调用方的问题）而不是 500：验证脚本要能从响应里直接看懂错在哪。
        return sendJson(res, 400, { error: 'invalid json', message: String((e && e.message) || e) });
      }

      const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : 'fake-model';
      const stream = parsed.stream === true;
      const picked = pickReply();
      const text = picked.text;
      seq += 1;
      const id = `chatcmpl-fake-${seq}-${Date.now().toString(36)}`;
      const created = Math.floor(Date.now() / 1000);
      const pChars = promptChars(parsed.messages);

      // 日志只记元信息：正文可能含用户小说原文，落原文必须走 --dump。
      const rec = {
        ts: new Date().toISOString(),
        method: req.method,
        path: p,
        model,
        stream,
        messages_count: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        prompt_chars: pChars,
        reply_chars: text.length,
        id,
        reply_index: picked.index,
      };
      requests.push(rec);
      if (logPath) {
        try { fs.appendFileSync(logPath, JSON.stringify(rec) + '\n'); } catch { /* 日志失败不影响应答 */ }
      }
      if (dumpPath && body) {
        try { fs.appendFileSync(dumpPath, body + '\n'); } catch { /* 同上 */ }
      }

      if (!stream) {
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            logprobs: null,
            finish_reason: 'stop',
          }],
          usage: makeUsage(pChars, text.length),
        });
      }

      // ── SSE 流式 ──────────────────────────────────────────────────────
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
      } catch {
        return; // 头都发不出去说明对端已断
      }
      // res 上的 error 必须有主：客户端 abort 后写数据会派发 error 事件，
      // 没有监听器就是未捕获异常 → 整个验证进程崩。
      res.on('error', () => { /* 对端断开 */ });

      const alive = () => !res.destroyed && !res.writableEnded;
      /** payload 已是字符串：普通 chunk 是 JSON，收尾是字面量 [DONE]（不能被 JSON.stringify 包住）。 */
      const sse = (payload) => {
        if (!alive()) return false;
        try { res.write(`data: ${payload}\n\n`); return true; } catch { return false; }
      };

      const base = { id, object: 'chat.completion.chunk', created, model };
      const pieces = splitPieces(text, 4);
      // 主流程 async：中途断开时每一轮都重新判断 alive()，用 return 收工而不是抛错。
      void (async () => {
        for (let i = 0; i < pieces.length; i++) {
          if (!alive()) return;
          // 首个 chunk 带上 role（贴近真 OpenAI 形状），其余只有 content。
          const delta = i === 0 ? { role: 'assistant', content: pieces[i] } : { content: pieces[i] };
          const ok = sse(JSON.stringify({
            ...base,
            choices: [{
              index: 0,
              delta,
              logprobs: null,
              finish_reason: i === pieces.length - 1 ? 'stop' : null,
            }],
          }));
          if (!ok) return;
          if (i < pieces.length - 1) await sleep(chunkDelayMs);
        }
        if (!alive()) return;
        // usage 单独一帧、choices 为空：与 DeepSeek/OpenAI 的 stream_options.include_usage 形状一致，
        // 让下游「按帧累加 usage」的实现也能被验证到。
        sse(JSON.stringify({ ...base, choices: [], usage: makeUsage(pChars, text.length) }));
        if (!alive()) return;
        sse('[DONE]');
        try { res.end(); } catch { /* 对端已断 */ }
      })();
    });
  });

  // 记录活跃 socket：close() 必须能主动断掉它们。
  // 否则 keep-alive 连接会让 server.close() 一直等——这正是「测试跑完进程不退」的经典成因。
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => { /* 对端 RST 不是异常 */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    logPath,
    dumpPath,
    /** 内存态请求记录（与 JSONL 同一份内容），供断言直接读取。 */
    requests,
    /** 已处理请求数（与 requests.length 同口径，供轮询用）。 */
    count: () => requests.length,
    close: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* 忽略 */ } }
      try { server.closeAllConnections?.(); } catch { /* 老版本 Node 没有，忽略 */ }
      server.close(() => resolve());
    }),
  };
}

/** 读取假端点日志里某时刻之后的请求记录（与 readBlackholeLog 同形，便于脚本复用）。 */
export function readFakeLLMLog(logPath, sinceMs = 0) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (new Date(o.ts).getTime() >= sinceMs) out.push(o);
    } catch { /* 半行忽略（进程被杀时可能留下半行） */ }
  }
  return out;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const LOG = arg('--log', '');
  if (process.argv.includes('--status')) {
    const rows = readFakeLLMLog(LOG, 0);
    console.log(`假端点日志: ${LOG || '（未指定 --log）'}`);
    console.log(`请求记录: ${rows.length} 条`);
    for (const r of rows) {
      console.log(`  ${r.ts}  ${r.method} ${r.path}  model=${r.model}  stream=${r.stream}`
        + `  msgs=${r.messages_count}  prompt=${r.prompt_chars}字  reply=${r.reply_chars}字`);
    }
    process.exit(0);
  }

  const repliesFile = arg('--replies', '');
  let replies;
  if (repliesFile) {
    // 读不到就**直接失败退出**：静默退回默认正文会让调用方以为自己在跑罐头序列，
    // 结果拿到一堆默认句子——这是最难查的一类"验证假通过"。
    try {
      // 先剥 UTF-8 BOM：Windows 上 PowerShell/记事本写出的 .json 常带 BOM，
      // JSON.parse 会直接抛 "Unexpected token '﻿'"——那是**格式误判**，
      // 文件内容其实是好的，不该让调用方以为自己的罐头答案写错了。
      replies = JSON.parse(fs.readFileSync(repliesFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      console.error(`--replies 读取失败: ${repliesFile} → ${(e && e.message) || e}`);
      process.exit(2);
    }
    if (!Array.isArray(replies) || replies.some((s) => typeof s !== 'string')) {
      console.error(`--replies 需要 JSON 字符串数组: ${repliesFile}`);
      process.exit(2);
    }
  }

  const llm = await startFakeLLM({
    port: Number(arg('--port', '0')),
    logPath: LOG || DEFAULT_LOG,
    reply: arg('--reply', undefined),
    replies,
    dumpPath: arg('--dump', ''),
  });
  // 以下是 CLI 分支**唯一**允许写 stdout 的地方（库路径必须保持安静）。
  console.log(`假 LLM 监听中：http://127.0.0.1:${llm.port}（本地 OpenAI 兼容，零成本应答）`);
  console.log(`请求日志：${llm.logPath}`);
  console.log(`把实例指到它，例如 $env:DEEPSEEK_BASE_URL='http://127.0.0.1:${llm.port}'`);

  // close() 之后再 exit()：不留孤儿监听进程。本仓库有过「前台守护进程不退出、
  // 只能靠人工收尸」的事故，所以退出纪律写死在信号处理里，而不是靠调用方自觉。
  const bye = async (code) => { await llm.close(); process.exit(code); };
  process.on('SIGINT', () => { void bye(0); });
  process.on('SIGTERM', () => { void bye(0); });
}
