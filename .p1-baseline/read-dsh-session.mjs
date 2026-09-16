#!/usr/bin/env node
/**
 * read-dsh-session.mjs —— 只读解析 dsh 会话转录（zstd 压缩的 JSONL）。
 *
 * 为什么需要：判定「一次 harness 任务到底有没有真的调用 LLM、花了多少 token」，
 * 唯一可信的证据是 dsh 自己写的会话转录。日志里的 task_done 只证明子进程退出码为 0，
 * 不能区分「模型真的回了」和「dsh 自己失败但退出码 0」。
 *
 * 只读：只解压并打印，不写任何文件。
 * 用法: node .p1-baseline/read-dsh-session.mjs <session.v3.jsonl.zstd | session.jsonl.zstd> [...]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * dsh 的会话文件是**追加写的多帧 zstd**：每次写入追加一个独立帧。
 * zstdDecompressSync 只解第一帧（实测 13260B 只解出 191B —— 差点据此误判「没有模型回复」）。
 * 所以必须按魔数切帧、逐帧解、再拼接。
 */
function readZstdAllFrames(buf) {
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i !== -1) { starts.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4); }
  if (!starts.length) return null;
  const parts = [];
  let ok = 0, bad = 0;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)));
      ok++;
    } catch {
      // 帧尾可能被截断（正在写入）；逐字节回退找最近的合法结尾
      let done = false;
      for (let cut = to - 1; cut > from + 8 && cut > to - 64; cut--) {
        try { parts.push(zlib.zstdDecompressSync(buf.subarray(from, cut))); ok++; done = true; break; } catch { /* 继续回退 */ }
      }
      if (!done) bad++;
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length, ok, bad };
}

function readAny(p) {
  const buf = fs.readFileSync(p);
  const z = readZstdAllFrames(buf);
  if (z && z.text.trim()) return { text: z.text, how: `zstd ${z.ok}/${z.frames} 帧${z.bad ? `（${z.bad} 帧解不开）` : ''}` };
  return { text: buf.toString('utf8'), how: 'plain' };
}

for (const p of process.argv.slice(2)) {
  console.log('═'.repeat(70));
  console.log(`文件: ${p}`);
  if (!fs.existsSync(p)) { console.log('  不存在'); continue; }
  const st = fs.statSync(p);
  const { text, how } = readAny(p);
  console.log(`  压缩 ${st.size}B → 解压 ${text.length}B（方式 ${how}）`);
  console.log(`  修改时间 ${st.mtime.toISOString()}`);

  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(`  JSONL 行数: ${lines.length}`);

  let model = '';
  let usage = null;
  const assistantTexts = [];
  const roles = {};
  let toolCalls = 0;
  let errors = [];

  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    // dsh 的信封是 { type, ...payload }；模型名在 request/header，产出在 assistant/*。
    const t = o.type || o.role || o.message?.role || '';
    if (t) roles[t] = (roles[t] || 0) + 1;

    if (t === 'request/header' || t === 'request/context') {
      const s = JSON.stringify(o);
      const mm = s.match(/"(?:model|modelId|model_id)"\s*:\s*"([^"]+)"/);
      if (mm) model = mm[1];
    }
    const m2 = o.model || o.message?.model || o.response?.model;
    if (m2) model = m2;
    const u = o.usage || o.message?.usage || o.response?.usage;
    if (u) usage = u;

    // 文本产出：text-chunks / assistant/message / assistant/chunk
    const pushText = (v) => { if (typeof v === 'string' && v) assistantTexts.push(v); };
    if (t === 'text-chunks' || t === 'assistant/message') {
      const c = o.chunks ?? o.content ?? o.text;
      if (Array.isArray(c)) c.forEach((x) => pushText(typeof x === 'string' ? x : x?.text));
      else pushText(c);
    }
    if (t === 'assistant/chunk') pushText(o.text ?? o.delta ?? o.content);

    const content = o.content ?? o.message?.content ?? o.text ?? o.delta;
    if (typeof content === 'string' && (o.role === 'assistant')) pushText(content);
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'tool_use' || c?.type === 'tool-call') toolCalls++;
      }
    }
    if (o.error) errors.push(JSON.stringify(o).slice(0, 300));
  }

  console.log(`  条目类型分布: ${JSON.stringify(roles)}`);
  console.log(`  模型: ${model || '（转录里未出现）'}`);
  console.log(`  用量: ${usage ? JSON.stringify(usage) : '（转录里未出现）'}`);
  console.log(`  tool_use 次数: ${toolCalls}`);
  if (errors.length) {
    console.log(`  ⚠ 错误条目 ${errors.length} 条:`);
    for (const e of errors.slice(0, 5)) console.log(`      ${e}`);
  }
  const joined = assistantTexts.join('\n').trim();
  console.log(`  助手文本累计 ${joined.length} 字`);
  console.log(`  助手文本前 700 字:\n---\n${joined.slice(0, 700)}\n---`);

  // 真实调用的判据：出现 request/header（发出了请求）且有 assistant 产出。
  const sentRequest = (roles['request/header'] || 0) > 0 || (roles['request/context'] || 0) > 0;
  const gotOutput = joined.length > 0 || (roles['assistant/chunk'] || 0) > 0
    || (roles['text-chunks'] || 0) > 0 || (roles['reasoning-chunks'] || 0) > 0;
  console.log(`  ⇒ 判定: ${sentRequest && gotOutput
    ? '★ 真实 LLM 调用（已发出请求且有流式产出）——按已产生费用对待'
    : sentRequest ? '发出了请求但无模型产出（可能在调用层失败）' : '未发出请求'}`);
}
