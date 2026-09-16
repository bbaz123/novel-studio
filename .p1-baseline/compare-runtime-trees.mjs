#!/usr/bin/env node
/**
 * compare-runtime-trees.mjs —— 比较两代 dsh 运行时为**同一个 profile** 组合出的插件树。
 *
 * 用途：回答"把小说工坊的运行时从 0.1.1 升到 0.1.5，AI 能力会不会更强"。
 * 关键在于分清两类差异：
 *   · **模型能感知的**（人设/system-prompt、工具面、上下文相关插件、模型与强度默认值）
 *     —— 这些变了，模型看到的东西就变了，能力/行为才会跟着变；
 *   · **纯基础设施**（加载器、日志、沙箱、CLI 自身）—— 变了也不影响模型看到什么。
 *
 * 用法: node compare-runtime-trees.mjs <a.txt> <b.txt> [--label-a 全局0.1.5] [--label-b 仓库0.1.1]
 */
import fs from 'node:fs';

const A = process.argv[2], B = process.argv[3];
const argVal = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LA = argVal('--label-a', 'A'), LB = argVal('--label-b', 'B');

const linesA = fs.readFileSync(A, 'utf8').split('\n');
const linesB = fs.readFileSync(B, 'utf8').split('\n');

/** 从组合树里抽出 "id → 该行附近的名字" 映射。 */
function pluginIds(lines) {
  const ids = new Map();
  for (const l of lines) {
    const m = l.match(/^\s*-\s*id:\s*(\S+)\s*$/);
    if (m) ids.set(m[1], true);
  }
  return ids;
}
const idsA = pluginIds(linesA), idsB = pluginIds(linesB);
const onlyA = [...idsA.keys()].filter((k) => !idsB.has(k));
const onlyB = [...idsB.keys()].filter((k) => !idsA.has(k));

console.log(`═══ 组合树比较：${LA}（${linesA.length} 行） vs ${LB}（${linesB.length} 行）═══\n`);
console.log(`插件条目数：${LA} ${idsA.size} / ${LB} ${idsB.size}`);
console.log(`\n【只在 ${LA} 里出现】${onlyA.length} 个`);
onlyA.forEach((k) => console.log(`  + ${k}`));
console.log(`\n【只在 ${LB} 里出现】${onlyB.length} 个`);
onlyB.forEach((k) => console.log(`  - ${k}`));

// ── 模型能感知的那些行，是否真的不同 ──────────────────────────────────────
const SENSITIVE = /persona|system-prompt|agent-instructions|instruction|prompt|tool-|model|effort|reasoning|skill|context|compaction|memory/i;
const sensA = linesA.map((l, i) => [i, l]).filter(([, l]) => SENSITIVE.test(l));
const sensB = linesB.map((l, i) => [i, l]).filter(([, l]) => SENSITIVE.test(l));
console.log(`\n═══ 模型相关行：${LA} ${sensA.length} 行 / ${LB} ${sensB.length} 行 ═══`);

// 只看"id 行 + name 行"，比较集合差异（配置正文差异另行抽样）
const norm = (arr) => arr.map(([, l]) => l.trim()).filter((l) => /^(- id:|name:)/.test(l));
const setA = new Set(norm(sensA)), setB = new Set(norm(sensB));
const diffA = [...setA].filter((l) => !setB.has(l));
const diffB = [...setB].filter((l) => !setA.has(l));
console.log(`\n【${LA} 独有的模型相关条目】${diffA.length}`);
diffA.slice(0, 40).forEach((l) => console.log(`  + ${l}`));
console.log(`\n【${LB} 独有的模型相关条目】${diffB.length}`);
diffB.slice(0, 40).forEach((l) => console.log(`  - ${l}`));

// ── 整体差异规模（便于判断"差得多不多"） ──────────────────────────────────
const allA = new Set(linesA.map((l) => l.trim()).filter(Boolean));
const allB = new Set(linesB.map((l) => l.trim()).filter(Boolean));
const onlyLinesA = [...allA].filter((l) => !allB.has(l));
const onlyLinesB = [...allB].filter((l) => !allA.has(l));
console.log(`\n═══ 整树差异 ═══`);
console.log(`  仅 ${LA} 有 ${onlyLinesA.length} 行 / 仅 ${LB} 有 ${onlyLinesB.length} 行`);
console.log(`  共同行 ${[...allA].filter((l) => allB.has(l)).length} 行`);
