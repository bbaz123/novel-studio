#!/usr/bin/env node
/**
 * 提取 dsh 会话导出里的指定行，打印其**文本内容**（去掉工具调用等噪声）。
 * 用法: node extract-session-lines.mjs <session.v3.jsonl> <行号,行号,...> [--max 4000]
 */
import fs from 'node:fs';

const file = process.argv[2];
const want = String(process.argv[3] || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const maxArg = process.argv.indexOf('--max');
const MAX = maxArg > 0 ? Number(process.argv[maxArg + 1]) : 4000;

const lines = fs.readFileSync(file, 'utf8').split('\n');

/** 从任意形状的事件里尽力抽出纯文本。 */
function textOf(ev) {
  const out = [];
  const push = (s) => { if (typeof s === 'string' && s.trim()) out.push(s); };
  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v !== 'object') return;
    // 常见文本字段
    for (const k of ['text', 'content', 'message', 'prompt']) {
      if (typeof v[k] === 'string') push(v[k]);
    }
    // 工具调用与工具结果不是"他说的话"，跳过
    if (v.type === 'tool_use' || v.type === 'tool_result') return;
    for (const [k, val] of Object.entries(v)) {
      // ⚠️ 只在**字符串**时跳过：这几个键也可能装数组（如 content: [{type:'text',text}]），
      // 第一版无条件 continue，于是整棵内容树都没走到，抽出 0 字。
      if (typeof val === 'string' && ['text', 'content', 'message', 'prompt'].includes(k)) continue;
      if (k === 'tool_calls' || k === 'tools') continue;
      walk(val, depth + 1);
    }
  };
  walk(ev);
  // 去重并保序
  return [...new Set(out)];
}

for (const n of want) {
  const line = lines[n - 1];
  if (!line) { console.log(`\n===== L${n}（不存在）=====`); continue; }
  let ev; try { ev = JSON.parse(line); } catch { console.log(`\n===== L${n}（解析失败）=====`); continue; }
  const parts = textOf(ev);
  const body = parts.join('\n\n---\n\n');
  console.log(`\n${'='.repeat(70)}`);
  console.log(`L${n}  role=${ev.role || '?'}  type=${ev.type || '?'}  抽出 ${body.length} 字${body.length > MAX ? `（截断到 ${MAX}）` : ''}`);
  console.log('='.repeat(70));
  if (!body) {
    // 抽不到时把原始片段打出来，便于对着真实 schema 改提取逻辑
    console.log(`[调试] 顶层键：${Object.keys(ev).join(',')}`);
    console.log(`[调试] 原始前 400 字：${line.slice(0, 400)}`);
    continue;
  }
  console.log(body.slice(0, MAX));
}
