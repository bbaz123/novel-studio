#!/usr/bin/env node
/**
 * audit-llm-calls.mjs —— 只读审计：本地 dsh 到底发起了多少次真实 LLM 调用。
 *
 * 为什么需要：本轮出现「以为打的是零成本隔离实例，实际打到了有真实密钥的旧实例」，
 * 造成了未经批准的真实调用。要如实报账、并且让后续验证**不可能悄悄花钱**，
 * 就必须能只靠本地转录数出「什么时候、用哪个模型、发了多少次请求」。
 *
 * 判据（全部来自转录自身，不猜测）：
 *   - 出现 `request/header`      = 真的发出了请求
 *   - 出现 `assistant/chunk` / `text-chunks` / `reasoning-chunks` = 真的收到模型产出（计费）
 *   两条同时成立才算「真实调用」。只有其一不算。
 *
 * 只读：只解压/统计，不写文件、不发网络请求。
 *
 * 用法（CLI）:
 *   node .p1-baseline/audit-llm-calls.mjs [--since 2026-09-15T00:00Z] [--dir <会话子目录名>] [--json]
 * 用法（库）:
 *   import { auditSessions, countRealCallsSince } from './audit-llm-calls.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** novel-studio 的 harness 任务 cwd 固定为 dsh 仓库，所以转录落在这个 peer 目录下。 */
export const HARNESS_SESSION_DIR = '--C-Users-a1941-Desktop-DeepSeek-deepseek-harness--';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * dsh 的会话文件是**追加写的多帧 zstd**：每次写入追加一个独立帧。
 * 实测 `zstdDecompressSync(整文件)` 只解出第一帧（13260B → 191B），
 * 差点据此误判「没有模型回复」。必须按魔数切帧、逐帧解、再拼接。
 */
/**
 * 能力自检：本工具依赖 `zlib.zstdDecompressSync`，而它**到 Node 22.15 才有**
 * （22.13 上 `typeof` 是 undefined；实测：v22.13.0 → undefined，v22.15.0 → function）。
 *
 * 为什么缺能力时必须**响亮地失败**而不是返回空：这个文件是「本地到底有没有真的花过钱」的
 * 总闸（verify-all 的「套件总闸」直接吃它的结论）。静默返回 0 = 把"真的调用了模型"
 * 报成"没有调用"——那正是 2026-09-15 事故的形态：以为在看着，其实没看着。
 * 返回：按魔数切帧、逐帧解压后拼接的 UTF-8 文本（截断帧忽略）。
 */
export function assertZstdAvailable() {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(`当前 Node（${process.version}）没有 zlib.zstdDecompressSync，无法审计 dsh 转录：`
      + '请改用 Node ≥ 22.15（22.13 缺这个 API）。'
      + '本工具是"花钱总闸"，缺能力时宁可响亮失败，也不能静默报 0。');
  }
}

/** 解码 dsh 的追加写多帧 zstd 转录；缺能力时由 assertZstdAvailable 响亮失败。 */
export function decodeZstdFrames(buf) {
  assertZstdAvailable();
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4); }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(from, to))); } catch { /* 截断帧忽略 */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 判定一条转录是否是「真实调用」：既发了请求，**又真的拿到了模型文本**。 */
export function isRealCall(row) {
  return row.requests > 0 && row.assistantChars > 0;
}

/**
 * 要扫描的 harness home 列表（决策 B）。
 *
 * ⚠️ 这是 B 的**必要配套**，不是顺手改：写作任务被关进专用 `DSH_HOME` 后，
 * 它的会话转录会写到**新 home** 下。若这里只扫 `~/.dsh`，审计会报"0 会话"——
 * 即使真的花了钱。2026-09-15 那次事故的根因正是"以为在看着、其实没看着"，
 * 所以宁可多扫一个目录，也不能让总闸失去视野。
 */
export function harnessHomes(baseEnv = process.env) {
  const homes = [];
  const explicit = String(baseEnv.NOVELSTUDIO_DSH_HOME || '').trim();
  if (explicit) homes.push(explicit);
  homes.push(path.join(os.homedir(), '.dsh-novel'));   // 决策 B 的默认专用 home
  homes.push(path.join(os.homedir(), '.dsh'));          // 共享 home（GUI 与历史转录）
  return [...new Set(homes)];
}

/**
 * 扫描会话目录，返回每条转录的统计。
 * 决策 B 起会扫描**所有** harness home，并在每行标注它来自哪个 home。
 * @param {{sinceMs?: number, dirName?: string, homes?: string[]}} opts
 */
export function auditSessions({ sinceMs = 0, dirName = HARNESS_SESSION_DIR, homes } = {}) {
  assertZstdAvailable(); // 先证明"看得见"，再谈"看到了几条"
  const roots = (homes || harnessHomes()).map((h) => path.join(h, 'sessions', dirName));
  const rows = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.zstd')) continue;
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (st.mtimeMs < sinceMs) continue;
        let text = '';
        try { text = decodeZstdFrames(fs.readFileSync(full)); } catch { continue; }
        rows.push({ text, dir, file: f, mtimeMs: st.mtimeMs, root });
      }
    }
  }
  if (!rows.length) return { root: roots.join(' | '), exists: false, rows: [] };
  const out = [];
  for (const item of rows) {
    const { text, dir, file, mtimeMs, root } = item;

      let model = '', requests = 0, chunks = 0, texts = 0, reason = 0, toolCalls = 0;
      let assistantChars = 0, retries = 0, errorFinishes = 0;
      // 模型正文**原文**：只在本进程内供总闸做归属核对（见 attributeSyntheticSessions），
      // 不打印、不落盘、不进日志。
      let assistantText = '';
      let firstTurn = 0;
      const tools = new Set();
      const userMsgs = [];
      for (const l of text.split(/\r?\n/)) {
        if (!l) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        const t = o.type || '';
        if (t === 'request/header') {
          requests++;
          const m = JSON.stringify(o).match(/"(?:model|modelId|model_id)"\s*:\s*"([^"]+)"/);
          if (m) model = m[1];
        }
        if (t === 'assistant/chunk') {
          const c = o.data?.chunk;
          // ⚠️ **不是所有 chunk 都是模型产出**：失败时 dsh 会发
          // `{type:'finish', reason:{kind:'error', failure:{code:'TRANSPORT'}}}` 这种**错误结束块**，
          // 然后带退避重试（实测一条失败会话里有 5 次 llm/retry + 6 个这种 chunk，但助手文本 0 字）。
          // 早先一律 chunks++ 并计入"产出"，于是**失败重试被误报成真实计费调用**——
          // 那会让套件总闸对着"死端口失败"的检查误亮红灯。现在只认带文本的 chunk。
          if (c?.type === 'finish' && c?.reason?.kind === 'error') errorFinishes++;
          else {
            chunks++;
            const txt = c?.text ?? o.data?.text ?? o.text ?? o.delta;
            if (typeof txt === 'string' && txt) { assistantChars += txt.length; assistantText += txt; }
          }
        }
        if (t === 'llm/retry') retries++;
        if (t === 'text-chunks') {
          texts++;
          const arr = o.data?.chunks ?? o.chunks ?? o.data?.text ?? o.text;
          if (Array.isArray(arr)) {
            for (const x of arr) {
              const s = typeof x === 'string' ? x : (x?.text ?? '');
              if (s) { assistantChars += s.length; assistantText += s; }
            }
          } else if (typeof arr === 'string') { assistantChars += arr.length; assistantText += arr; }
        }
        if (t === 'reasoning-chunks') reason++;
        if (t === 'assistant/message') {
          const d = o.data || {};
          const c = d.content ?? d.message?.content ?? o.content;
          if (Array.isArray(c)) {
            for (const x of c) {
              const s = typeof x === 'string' ? x : (x?.text ?? '');
              if (s) { assistantChars += s.length; assistantText += s; }
            }
          } else if (typeof c === 'string') { assistantChars += c.length; assistantText += c; }
        }
        if (t === 'tool/call') {
          toolCalls++;
          const m = JSON.stringify(o).match(/"(?:name|tool|toolName)"\s*:\s*"([^"]+)"/);
          if (m) tools.add(m[1]);
        }
        if (t === 'user/message') {
          // 信封: {type,seq,time,data:{content:[{type:'text',text}],source:{kind},role,id}}
          const d = o.data || {};
          let c = d.content ?? o.content ?? '';
          if (Array.isArray(c)) c = c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ');
          c = String(c).replace(/\s+/g, ' ').trim();
          const kind = d.source?.kind || '';
          // 只留**请求方**发的那条（source.kind='user'），其余是插件注入的系统上下文
          if (kind === 'user' && c) userMsgs.push(c.slice(0, 160));
        }
        if (t === 'turn/start' && !firstTurn) firstTurn = o.time || 0;
      }
      out.push({
        session: path.basename(dir),
        file,
        // 决策 B：标注这条转录来自哪个 home —— 专用 home 与共享 home 都要能看见，
        // 且一眼分得清是哪一边的（否则"看不见"会伪装成"没发生"）。
        home: path.basename(path.dirname(path.dirname(root))) || root,
        root,
        ts: new Date(mtimeMs).toISOString(),
        startTs: firstTurn ? new Date(firstTurn).toISOString() : '',
        model, requests, toolCalls,
        // 产出以**模型文本字符数**为准（不再是"chunk 个数"）。
        assistantChars,
        // 正文原文：只给总闸做归属核对（与本地假端点申报的罐头正文比对）；不打印。
        assistantText,
        textChunks: texts, chunks, reasoningEntries: reason,
        retries, errorFinishes,
        tools: [...tools].slice(0, 8),
        userMsgs,
      });
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return { root: roots.join(' | '), exists: true, rows: out };
}

/** 便捷入口：自某时刻起真实调用的条数与明细。 */
export function countRealCallsSince(sinceMs, dirName = HARNESS_SESSION_DIR) {
  const { rows } = auditSessions({ sinceMs, dirName });
  const real = rows.filter(isRealCall);
  return { total: rows.length, real: real.length, rows: real };
}

// ── 总闸第二层：把「拿到模型文本」的会话逐条**归属**（2026-09-25 新增）──────────
// 为什么需要：套件里有检查**故意**用本地假端点充当模型（零计费探针：工具循环、冷启动）。
// 这类会话在转录里与「真的调了远端模型」形态相同（`request/header` + 模型正文），
// 于是总闸把它们误判成花钱——实测：工具循环探针一进套件，总闸立刻假红，
// 而它按构造不可能出海（端点绑 127.0.0.1、应答是罐头文本）。
//
// 但判据不能改成「信探针一句话」，否则总闸就成了能随便哄的看门狗。所以要求**四重自证**，
// 缺一即记「未归属」（= 红灯）：
//   1. 申报端点必须是**回环地址**——远端端点一律不认（真花钱的形态正是它）；
//   2. 端点自报的**实收请求数 ≥ 转录里的请求数**——转录多出来的那条说明有流量没走本地；
//   3. 转录里的模型正文**包含**端点申报的罐头正文——文本对不上就不是它服务的；
//   4. 申报时段与会话时间**必须有交集**——防止一条陈旧申报替另一次运行背书。
// 另外：一条申报只能认领**一个**会话（一次本地假端点运行服务不了两条会话的全部流量）。
//
// 与旧判据（有文本即真实调用）相比，这一层**只严不松**：无法解释的文本会话仍然是红灯。
/** 端点是不是**本机**（回环）——只有本机端点才可能"零计费"。 */
export function isLoopbackEndpoint(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch { return false; }
}

/**
 * 逐条归属「拿到模型文本」的会话。
 * @param {Array} rows auditSessions() 的 rows（需要 assistantText 字段）
 * @param {Array} declarations 申报：{endpoint, servedRequests, finalText, servedFrom, servedTo}
 * @returns {{textSessions: Array, attributed: Array<{session: object, decl: object}>, unexplained: Array}}
 */
export function attributeSyntheticSessions(rows, declarations = [], { slackMs = 120000 } = {}) {
  const textSessions = (rows || []).filter((r) => r.assistantChars > 0);
  const used = new Set();
  const attributed = [];
  const unexplained = [];
  for (const s of textSessions) {
    const sEnd = new Date(s.ts).getTime();
    const sStartRaw = new Date(s.startTs || s.ts).getTime();
    const sFrom = (Number.isFinite(sStartRaw) ? sStartRaw : sEnd) - slackMs;
    const sTo = sEnd + slackMs;
    const hit = declarations.find((d, i) => {
      if (used.has(i)) return false;
      if (!isLoopbackEndpoint(d?.endpoint)) return false;
      if (!(Number(d?.servedRequests) >= s.requests)) return false;
      if (!d?.finalText || !String(s.assistantText || '').includes(String(d.finalText))) return false;
      const dFrom = Number(d.servedFrom);
      const dTo = Number(d.servedTo);
      if (!Number.isFinite(dFrom) || !Number.isFinite(dTo)) return false;
      return dFrom <= sTo && sFrom <= dTo;   // 时段有交集
    });
    if (hit) { used.add(declarations.indexOf(hit)); attributed.push({ session: s, decl: hit }); }
    else unexplained.push(s);
  }
  return { textSessions, attributed, unexplained };
}

/**
 * 归属判据的自检（含阴性对照）：`--self-test`。
 * 每一种「看起来像自证、其实不成立」的形态都必须判红——否则总闸会被一条坏申报哄过去。
 */
export function selfTestMoneyGate() {
  const T0 = Date.parse('2026-09-25T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const row = (over = {}) => ({
    session: 'session-synthetic-1', ts: iso(T0 + 30000), startTs: iso(T0 + 1000),
    model: 'deepseek-flash', requests: 2, assistantChars: 6, assistantText: '工具循环完成',
    userMsgs: ['probe'], ...over,
  });
  const decl = (over = {}) => ({
    endpoint: 'http://127.0.0.1:53123', servedRequests: 2, finalText: '工具循环完成',
    servedFrom: T0, servedTo: T0 + 60000, ...over,
  });
  const cases = [
    ['本地假端点自证 → 归属', [row()], [decl()], 1, 0],
    ['没有任何申报 → 未归属（红灯）', [row()], [], 0, 1],
    ['申报端点是远端（真花钱的形态）→ 不认', [row()], [decl({ endpoint: 'https://api.deepseek.com/anthropic' })], 0, 1],
    ['端点实收数少于转录请求数 → 有流量没走本地', [row({ requests: 3 })], [decl()], 0, 1],
    ['罐头正文对不上 → 不认', [row()], [decl({ finalText: '另一段正文' })], 0, 1],
    ['时段无交集（陈旧申报）→ 不认', [row()], [decl({ servedFrom: T0 - 86400000, servedTo: T0 - 86000000 })], 0, 1],
    ['一条申报不能认领两个会话', [row(), row({ session: 'session-synthetic-2' })], [decl()], 1, 1],
    ['没有模型文本的会话不参与归属', [row({ assistantChars: 0, assistantText: '' })], [], 0, 0],
  ];
  let fail = 0;
  for (const [name, rows, decls, wantAttr, wantUnexp] of cases) {
    const r = attributeSyntheticSessions(rows, decls);
    const ok = r.attributed.length === wantAttr && r.unexplained.length === wantUnexp;
    if (!ok) fail++;
    console.log(`${ok ? '✓' : '✗'} ${name}　— 归属=${r.attributed.length}（期望 ${wantAttr}）未归属=${r.unexplained.length}（期望 ${wantUnexp}）`);
  }
  console.log(`\n花钱总闸归属判据自检：通过 ${cases.length - fail} / 失败 ${fail}`);
  return fail === 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 自检是纯函数（不读转录、不需要 zstd）：缺 zstd 的 Node 也能跑它。
  if (process.argv.includes('--self-test')) process.exit(selfTestMoneyGate() ? 0 : 1);
  const arg = (n, d) => {
    const i = process.argv.indexOf(n);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
  };
  const SINCE = new Date(arg('--since', '2026-09-15T00:00:00Z')).getTime();
  const DIRNAME = arg('--dir', HARNESS_SESSION_DIR);
  const AS_JSON = process.argv.includes('--json');

  const { root, exists, rows } = auditSessions({ sinceMs: SINCE, dirName: DIRNAME });
  if (!exists) { console.log(`找不到会话目录: ${root}`); process.exit(2); }

  const real = rows.filter(isRealCall);
  if (AS_JSON) {
    console.log(JSON.stringify({
      dir: DIRNAME, since: new Date(SINCE).toISOString(),
      total: rows.length, real: real.length, rows: real,
    }, null, 2));
    process.exit(0);
  }

  console.log(`会话目录: ${DIRNAME}`);
  console.log(`统计起点: ${new Date(SINCE).toISOString()}\n`);
  for (const r of rows) {
    const tag = isRealCall(r)
      ? '★真实调用'
      : (r.requests > 0 ? `（发出请求但无模型文本${r.errorFinishes ? `：${r.errorFinishes} 个错误结束块、${r.retries} 次重试` : ''}）` : '（无请求）');
    console.log(`${r.ts}  ${tag}  model=${r.model || '?'} requests=${r.requests} 模型文本=${r.assistantChars} 字 toolCalls=${r.toolCalls}`);
    console.log(`    起点=${r.startTs || '?'}  session=${r.session}`);
    if (r.tools.length) console.log(`    工具: ${r.tools.join(', ')}`);
    for (const u of r.userMsgs) console.log(`    用户消息: ${u.slice(0, 220)}`);
  }
  console.log(`\n合计：会话 ${rows.length} 个，其中**确实拿到模型文本（=计费）的** ${real.length} 个。`);
  console.log('判据：requests>0 **且** assistantChars>0。只发请求、拿到的是错误结束块（如 TRANSPORT 失败重试）不算计费。');
}
