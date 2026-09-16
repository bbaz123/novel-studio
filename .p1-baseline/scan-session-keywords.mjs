#!/usr/bin/env node
/**
 * scan-session-keywords.mjs —— 在会话转录里按关键词找"说了什么"，并打印上下文。
 *
 * 为什么需要：会话 4MB、单条消息几万字，直接读会淹没重点。
 * 这里按关键词定位句子，再打印前后若干字符，用来快速判断"提案是什么"。
 *
 * 用法: node scan-session-keywords.mjs <session.v3.jsonl> "关键词1,关键词2" [--win 400] [--only assistant|user|all]
 */
import fs from 'node:fs';

const file = process.argv[2];
const keys = String(process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const argVal = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const WIN = Number(argVal('--win', 400));
const ONLY = argVal('--only', 'all');

const lines = fs.readFileSync(file, 'utf8').split('\n');

function textOf(ev) {
  const out = [];
  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    if (typeof v.text === 'string' && v.text.trim()) out.push(v.text);
    else if (typeof v.content === 'string' && v.content.trim()) out.push(v.content);
    if (v.type === 'tool_use' || v.type === 'tool_result') return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && ['text', 'content', 'message', 'prompt'].includes(k)) continue;
      if (k === 'tool_calls' || k === 'tools') continue;
      walk(val, depth + 1);
    }
  };
  walk(ev);
  return [...new Set(out)].join('\n');
}

let shown = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  const role = String(ev.role || ev.type || '?');
  if (ONLY !== 'all' && !role.includes(ONLY)) continue;
  const text = textOf(ev);
  if (!text) continue;
  for (const k of keys) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(k, from);
      if (at < 0) break;
      from = at + k.length;
      const seg = text.slice(Math.max(0, at - WIN), Math.min(text.length, at + k.length + WIN));
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`L${i + 1}  [${role}]  命中「${k}」@${at}  消息长度 ${text.length}`);
      console.log('─'.repeat(70));
      console.log(seg.replace(/\n{3,}/g, '\n\n'));
      shown++;
      if (shown > 40) { console.log('\n（命中过多，已截断）'); process.exit(0); }
    }
  }
}
console.log(`\n合计展示 ${shown} 段。`);
