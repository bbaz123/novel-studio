#!/usr/bin/env node
/**
 * fake-llm.mjs —— 「假 LLM」端点：本地、**会应答**的零成本替身（OpenAI 形状 + Messages 形状）。
 *
 * 为什么需要：blackhole.mjs 只能证明「流量没出海、作业占得住槽」，但它永不响应，
 * 任何任务都只能等到自己的超时——它**无法证明任务能跑完**。
 * 要验证「完整任务端到端跑通」，就必须有一个真的会回话的对端：
 * 于是这里实现一个最小的、会回话的**双线路**端点，返回罐头正文，成本恒为 0：
 *   · OpenAI 形状 `POST /v1/chat/completions` —— 本仓库直连通道（server.js）走它；
 *   · Messages 形状 `POST /v1/messages` —— dsh 0.1.7 的 llm-deepseek 走它
 *     （官方根 `https://api.deepseek.com/anthropic`，适配器在根后追加 `/v1/messages`）。
 * 两条都要实现：dsh 0.1.7 换了线路协议，只做 OpenAI 形状时慢通道会一路 404，
 * 冷启动/工具循环的测量就全部变成「端点没收到请求」（本仓库实测踩过，见第 4 条）。
 *
 * 三条硬约束（都是本仓库踩过的坑）：
 *   1. **默认不落 prompt 原文**：请求体里可能包含用户的小说正文。日志只记元信息
 *      （条数/长度），要看原文必须显式加 --dump（opt-in），避免验证脚本顺手把正文写进仓库。
 *   2. **所有定时器 unref()**：延迟发包的小定时器如果 ref 着，测试进程会在 close() 之后
 *      继续挂着不退出——本仓库已有「前台守护进程不退，只能人工收尸」的事故记录。
 *   3. **客户端中途断开不能崩**：验证脚本常在收到第一个 chunk 后就 abort，
 *      往已销毁的 socket 写数据会触发 error 事件，必须兜住而不是抛出。
 *   4. **每条请求都留痕（含不认识的路径）**：只记「认得的聊天请求」时，
 *      「连上了但走的是别的端点」与「请求根本没到」在日志里长得一模一样——
 *      probe-cold-start 就曾把 Messages 线路的 404 读成「端点没收到请求」，
 *      进而误判成「冷启动测不出来」。因此另设 hits[]：
 *      ts / method / path / handled / reason，谁来都记账，路径不认识也留证据。
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
 *   node .p1-baseline/fake-llm.mjs --port 0 --tool-call '{"name":"glob","arguments":{"pattern":"package.json"}}'
 *   node .p1-baseline/fake-llm.mjs --status --log <日志>
 *
 * 排查「请求到底有没有到」时看 hits（不是 requests）：
 *   llm.hits                              // 全部请求，含 404/405
 *   llm.hitsCount()                       // 条数；只涨 requests 不涨 = 路径没被识别
 *   GET /health -> { ok, requests, hits }  // 两个口径都在，避免各报各的
 *
 * 把 dsh 指到它（零计费跑完整任务）:
 *   $env:DEEPSEEK_BASE_URL='http://127.0.0.1:<port>'   # dsh 0.1.7：适配器追加 /v1/messages
 *   # 直连通道走 OpenAI 形状：POST {base}/v1/chat/completions
 *
 * 覆盖范围（诚实边界）：默认只回**正文**，不模拟真实计费/缓存口径（usage 是估算）。
 * 显式打开 `toolCall` 后可以回**一轮**工具调用（见下），用来验证「模型→工具→模型」的循环；
 * 但它不会自己规划多步工具链，也不校验工具参数的业务语义。
 *
 * 工具调用（opt-in，2026-09-25 加）：`--tool-call '{"name":"glob","arguments":{"pattern":"*.json"}}'`
 * 或库调用 `toolCall: { name, arguments }`。规则只有一条、且确定性：
 *   **请求里已经带了工具结果 → 回正文；还没带 → 回工具调用。**
 * 于是「第一轮要工具、第二轮收尾」这个最小循环可以零成本复现，且不吃 `--replies` 的轮换
 * （只有真的要回正文的那一轮才取一条罐头）。
 * 为什么值得实现：慢通道的真实价值就在工具循环（读回被裁掉的原文、写回提案），
 * 而此前假端点只会回正文——「工具到底有没有被调起来」在这台机器上无法验证。
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

/**
 * Messages 形状的 prompt 长度：`system`（字符串或多段块）+ 各 message 的 content 块。
 * 与 OpenAI 形状分开算，是因为 Messages 把 system 提在顶层、不在 messages 里——
 * 只数 messages 会漏掉人设/工具说明那一大段，日志里的 prompt 长度就不再可比。
 */
function messagesPromptChars(parsed) {
  let n = contentChars(parsed && parsed.system);
  const msgs = parsed && parsed.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) if (m && typeof m === 'object') n += contentChars(m.content);
  }
  return n;
}

/**
 * 请求里是否**已经带了工具结果**——两种线路各有一套形状：
 *   · OpenAI 形状：`messages[]` 里出现 `role:'tool'`；
 *   · Messages 形状：`messages[].content[]` 里出现 `type:'tool_result'`。
 * 这是「回工具调用」还是「回正文」的唯一判据，所以两种都要认——只认一种会让另一条线路
 * 陷入「无限发工具调用」的死循环（dsh 会一直执行同一个工具直到步数上限）。
 */
function countToolResults(parsed) {
  const msgs = parsed && parsed.messages;
  if (!Array.isArray(msgs)) return 0;
  let n = 0;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') n += 1;
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && typeof b === 'object' && b.type === 'tool_result') n += 1;
    }
  }
  return n;
}

/** 有工具结果 = 上一轮的工具调用已经执行完，这一轮该收尾回正文。 */
function hasToolResult(parsed) {
  return countToolResults(parsed) > 0;
}

/**
 * OpenAI 形状的一轮工具调用（非流式与流式共用消息体）。
 * `arguments` 必须是**字符串**（OpenAI 的形状如此），否则下游解析器会当成非法 JSON。
 */
function openAIToolCallMessage(id, tool) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
    }],
  };
}

/** Messages 形状的 usage：Anthropic 用 input_tokens / output_tokens（命名与 OpenAI 不同）。 */
function messagesUsage(pChars, rChars) {
  return {
    input_tokens: Math.max(1, Math.ceil(pChars / 4)),
    output_tokens: Math.max(1, Math.ceil(rChars / 4)),
  };
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
 * @param {{port?:number, logPath?:string, reply?:string, replies?:string[], dumpPath?:string, chunkDelayMs?:number, toolCall?:{name:string, arguments?:object}}} [opts]
 *   port：0 = 让内核挑空闲端口（测试并发起多个实例时必须用它，避免端口冲突）。
 *   reply：固定罐头正文；replies：JSON 数组，**逐次请求轮换**（多轮任务每轮给不同答案）。
 *   优先级 replies > reply > 环境变量 FAKE_LLM_REPLY > DEFAULT_REPLY：
 *   逐次轮换是「每轮答案不同」的唯一表达方式，一旦给了就应该压过固定单句。
 *   dumpPath：**opt-in** 落原始请求体（含 prompt 原文），默认关闭。
 * @returns {Promise<{port:number, logPath:string, dumpPath:string, requests:Array, count:()=>number, hits:Array, hitsCount:()=>number, close:()=>Promise<void>}>}
 */
export async function startFakeLLM({
  port = 0,
  logPath = DEFAULT_LOG,
  reply,
  replies,
  dumpPath,
  chunkDelayMs = 30,
  toolCall,
} = {}) {
  // 归一化：只接受「有名字」的工具调用；参数缺省给空对象（Anthropic 要求 input 是对象）。
  const tool =
    toolCall && typeof toolCall === 'object' && typeof toolCall.name === 'string' && toolCall.name
      ? {
        name: toolCall.name,
        arguments: toolCall.arguments && typeof toolCall.arguments === 'object' ? toolCall.arguments : {},
      }
      : null;
  const list = Array.isArray(replies) ? replies.filter((s) => typeof s === 'string') : [];
  const fixed = typeof reply === 'string' ? reply : (process.env.FAKE_LLM_REPLY || DEFAULT_REPLY);
  const requests = [];
  /**
   * **全部**请求留痕（含 404/405 这类被拒的路径），字段 ts/method/path/handled/reason。
   * 与 requests 的区别：requests 只装「被本端点识别并应答」的聊天请求；
   * hits 回答的是另一个问题——「对端到底有没有连上来、走的是哪条路」。
   * 两者分开，是因为排查连接类故障时最怕把「走错端点」读成「没连上」。
   */
  const hits = [];
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
    // dsh 0.1.7 的 llm-deepseek 走 Messages：`$DEEPSEEK_BASE_URL` 给的是 Messages 兼容根，
    // 适配器在根后追加 /v1/messages（官方根是 https://api.deepseek.com/anthropic）。
    // 这里把 /messages 与 /anthropic/v1/messages 一起收：有人照抄官方根也不该 404。
    const isMessages = p === '/v1/messages' || p === '/messages' || p === '/anthropic/v1/messages';

    // 留痕**先于**分流：每条请求都进 hits，包括本端点不认识的路。
    // 顺序很要紧——404 之后才发现「没记路径」，就没有证据可查了。
    const hit = {
      ts: new Date().toISOString(),
      method: req.method,
      path: p,
      handled: false,
      reason: 'unhandled',
    };
    hits.push(hit);

    if (req.method === 'GET' && p === '/health') {
      hit.handled = true;
      hit.reason = 'health';
      // hits 一并回报：只给 requests 时，「来了但没被识别」在健康检查里看不出来。
      return sendJson(res, 200, { ok: true, requests: requests.length, hits: hits.length });
    }
    if ((isChat || isMessages) && req.method !== 'POST') {
      hit.reason = 'method-not-allowed';
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (p === '/health') {
      hit.reason = 'method-not-allowed';
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    if (!isChat && !isMessages) {
      // 形似 Messages 的各种根（base 少写或多写一段）：给出**支持列表**，
      // 而不是只说 not found——「路径差一段」与「端点没实现」在调用方看来是一样的。
      const looksMessages = p === '/messages' || /\/messages$/.test(p);
      hit.reason = looksMessages ? 'not-found:messages-path' : 'not-found';
      if (looksMessages) {
        // 用字符串拼接而不是模板串：这段替换文本本身住在模板串里，嵌套反引号会截断它。
        console.warn('[fake-llm] 收到 Messages 形状的路径但根不匹配：'
          + req.method + ' ' + p + '（支持的根：/v1/messages、/messages、/anthropic/v1/messages）');
      }
      return sendJson(res, 404, {
        error: 'not found',
        path: p,
        // 只有真的形似 Messages 时才给提示，普通 404 保持原样（不制造噪声）。
        ...(looksMessages
          ? { hint: '形似 Messages 端点但根路径不匹配；支持 /v1/messages、/messages、/anthropic/v1/messages。' }
          : {}),
      });
    }
    hit.handled = true;
    hit.reason = isMessages ? 'messages' : 'chat.completions';

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
      // 工具轮判定（确定性，见文件头）：配了 toolCall **且**请求里还没带工具结果 → 这一轮回工具调用。
      // 先判后取罐头：工具轮不消费 --replies 的轮换，否则「第一轮工具、第二轮收尾」会错位。
      const toolTurn = Boolean(tool) && !hasToolResult(parsed);
      const picked = toolTurn ? { text: '', index: null } : pickReply();
      const text = picked.text;
      seq += 1;
      const id = `chatcmpl-fake-${seq}-${Date.now().toString(36)}`;
      const toolCallId = `toolu-fake-${seq}-1`;
      const created = Math.floor(Date.now() / 1000);
      // Messages 把 system 提在顶层、不在 messages 里：分形状算，
      // 否则日志里的 prompt 长度会整整缺掉人设/工具说明那一截，跨线路就没法比。
      const pChars = isMessages ? messagesPromptChars(parsed) : promptChars(parsed.messages);

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
        // 这一轮回的是工具调用还是正文；以及（工具轮）那个工具叫什么。
        // 只记名字与「是不是工具轮」，**不记参数**——参数里可能带用户原文片段。
        tool_turn: toolTurn,
        tool_name: toolTurn ? tool.name : null,
        // 请求里带了几条工具结果。只记**条数**：这是「工具到底跑没跑、结果有没有回灌给模型」
        // 的唯一可核对信号，而工具结果正文可能含作品内容，不能进日志。
        tool_results: countToolResults(parsed),
      };
      requests.push(rec);
      if (logPath) {
        try { fs.appendFileSync(logPath, JSON.stringify(rec) + '\n'); } catch { /* 日志失败不影响应答 */ }
      }
      if (dumpPath && body) {
        try { fs.appendFileSync(dumpPath, body + '\n'); } catch { /* 同上 */ }
      }

      // ── Messages 形状（dsh 0.1.7 走的线路）────────────────────────────────
      // 事件序列照 dsh 自家测试端点（@deepseek-ai/dsh-llm-mock-server 的 success 行为）：
      //   message_start → content_block_start(text) → delta… → content_block_stop
      //     → message_delta(stop_reason) → message_stop
      // 少 message_stop 或漏 stop_reason，dsh 的解析器会判 MALFORMED_RESPONSE；
      // 一个块都没有却给了 end_turn，会判 EMPTY_RESPONSE——所以空正文也要发一个空文本块。
      if (isMessages) {
        if (!stream && toolTurn) {
          // 工具轮：content 里是 tool_use 块，stop_reason 必须是 'tool_use'
          // （dsh 的解析器只认 end_turn / stop_sequence / tool_use / max_tokens，其它一律 MALFORMED）。
          return sendJson(res, 200, {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'tool_use', id: toolCallId, name: tool.name, input: tool.arguments }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: messagesUsage(pChars, 0),
          });
        }
        if (!stream) {
          return sendJson(res, 200, {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: messagesUsage(pChars, text.length),
          });
        }
        try {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
        } catch {
          return; // 头都发不出去说明对端已断
        }
        // res 上的 error 必须有主（同 OpenAI 分支）：客户端 abort 后写数据会派发 error。
        res.on('error', () => { /* 对端断开 */ });
        const aliveMsg = () => !res.destroyed && !res.writableEnded;
        const sseMsg = (payload) => {
          if (!aliveMsg()) return false;
          try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); return true; } catch { return false; }
        };
        const msgPieces = splitPieces(text, 4);
        // 整段参数放进 content_block_start 的 input 里，**不**发 input_json_delta：
        // dsh 的解析器允许两种写法，一次性给全更简单，也避免"半截 JSON"被当非法输入。
        // 只在真的要回工具调用时才构造：tool 未配置时是 null，无条件构造会让**普通流式请求**
        // 在 tool.name 上抛错（把"没配工具"变成"端点崩了"，probe-cold-start 就这么被骗过）。
        const toolStartBlock = () => ({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolCallId, name: tool.name, input: tool.arguments },
        });
        void (async () => {
          if (!sseMsg({
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              usage: { input_tokens: messagesUsage(pChars, 0).input_tokens, output_tokens: 0 },
            },
          })) return;
          if (toolTurn) {
            if (!sseMsg(toolStartBlock())) return;
            sseMsg({ type: 'content_block_stop', index: 0 });
            sseMsg({
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 0 },
            });
            sseMsg({ type: 'message_stop' });
            try { res.end(); } catch { /* 对端已断 */ }
            return;
          }
          if (!sseMsg({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })) return;
          for (let i = 0; i < msgPieces.length; i++) {
            if (!aliveMsg()) return;
            const ok = sseMsg({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: msgPieces[i] } });
            if (!ok) return;
            if (i < msgPieces.length - 1) await sleep(chunkDelayMs);
          }
          if (!aliveMsg()) return;
          sseMsg({ type: 'content_block_stop', index: 0 });
          sseMsg({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: messagesUsage(0, text.length).output_tokens },
          });
          sseMsg({ type: 'message_stop' });
          try { res.end(); } catch { /* 对端已断 */ }
        })();
        return;
      }

      if (!stream) {
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: toolTurn ? openAIToolCallMessage(toolCallId, tool) : { role: 'assistant', content: text },
            logprobs: null,
            finish_reason: toolTurn ? 'tool_calls' : 'stop',
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
        if (toolTurn) {
          // OpenAI 形状的工具轮：先发带 id/name 的 delta，再发**整段** arguments（同一个 index），
          // 最后一帧 finish_reason='tool_calls' 收尾。三步缺一，下游组装出的 tool_calls 就是残缺的。
          if (!sse(JSON.stringify({
            ...base,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: tool.name, arguments: '' } }],
              },
              logprobs: null,
              finish_reason: null,
            }],
          }))) return;
          await sleep(chunkDelayMs);
          if (!sse(JSON.stringify({
            ...base,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.arguments) } }] },
              logprobs: null,
              finish_reason: null,
            }],
          }))) return;
          sse(JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'tool_calls' }],
          }));
          sse(JSON.stringify({ ...base, choices: [], usage: makeUsage(pChars, 0) }));
          sse('[DONE]');
          try { res.end(); } catch { /* 对端已断 */ }
          return;
        }
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
    /** 全部请求留痕（含被拒路径），见文件头「每条请求都留痕」一节。 */
    hits,
    /** hits 条数：与 count() 一起看，两个数不同就是「来了但路径没被识别」。 */
    hitsCount: () => hits.length,
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
    toolCall: (() => {
      const raw = arg('--tool-call', '');
      if (!raw) return undefined;
      try {
        const o = JSON.parse(raw);
        if (!o || typeof o.name !== 'string' || !o.name) throw new Error('缺少 name');
        return o;
      } catch (e) {
        // 解析失败**直接退出**：静默忽略会让人以为"工具轮已经开了"，而实际回的是正文——
        // 那种验证比不验证更坏（会得出"工具循环没问题"的假结论）。
        console.error(`--tool-call 需要形如 '{"name":"glob","arguments":{"pattern":"*.json"}}' 的 JSON：${(e && e.message) || e}`);
        process.exit(2);
      }
    })(),
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
