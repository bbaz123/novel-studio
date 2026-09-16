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
export function decodeZstdFrames(buf) {
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
 * 扫描会话目录，返回每条转录的统计。
 * @param {{sinceMs?: number, dirName?: string}} opts
 */
export function auditSessions({ sinceMs = 0, dirName = HARNESS_SESSION_DIR } = {}) {
  const root = path.join(os.homedir(), '.dsh', 'sessions', dirName);
  if (!fs.existsSync(root)) return { root, exists: false, rows: [] };

  const rows = [];
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

      let model = '', requests = 0, chunks = 0, texts = 0, reason = 0, toolCalls = 0;
      let assistantChars = 0, retries = 0, errorFinishes = 0;
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
            if (typeof txt === 'string' && txt) assistantChars += txt.length;
          }
        }
        if (t === 'llm/retry') retries++;
        if (t === 'text-chunks') {
          texts++;
          const arr = o.data?.chunks ?? o.chunks ?? o.data?.text ?? o.text;
          if (Array.isArray(arr)) {
            for (const x of arr) {
              const s = typeof x === 'string' ? x : (x?.text ?? '');
              if (s) assistantChars += s.length;
            }
          } else if (typeof arr === 'string') assistantChars += arr.length;
        }
        if (t === 'reasoning-chunks') reason++;
        if (t === 'assistant/message') {
          const d = o.data || {};
          const c = d.content ?? d.message?.content ?? o.content;
          if (Array.isArray(c)) {
            for (const x of c) {
              const s = typeof x === 'string' ? x : (x?.text ?? '');
              if (s) assistantChars += s.length;
            }
          } else if (typeof c === 'string') assistantChars += c.length;
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
      rows.push({
        session: name,
        file: f,
        ts: new Date(st.mtimeMs).toISOString(),
        startTs: firstTurn ? new Date(firstTurn).toISOString() : '',
        model, requests, toolCalls,
        // 产出以**模型文本字符数**为准（不再是"chunk 个数"）。
        assistantChars,
        textChunks: texts, chunks, reasoningEntries: reason,
        retries, errorFinishes,
        tools: [...tools].slice(0, 8),
        userMsgs,
      });
    }
  }
  rows.sort((a, b) => a.ts.localeCompare(b.ts));
  return { root, exists: true, rows };
}

/** 便捷入口：自某时刻起真实调用的条数与明细。 */
export function countRealCallsSince(sinceMs, dirName = HARNESS_SESSION_DIR) {
  const { rows } = auditSessions({ sinceMs, dirName });
  const real = rows.filter(isRealCall);
  return { total: rows.length, real: real.length, rows: real };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
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
