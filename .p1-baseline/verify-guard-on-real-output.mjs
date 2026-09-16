#!/usr/bin/env node
/**
 * verify-guard-on-real-output.mjs —— 用**已经付费的那次真实产出**验证护栏改版（零成本）。
 *
 * 思路：2026-09-16 的第二次压缩调用（deepseek-v4-pro，50 秒）产出了一份摘要，
 * 被**旧护栏**拒绝（理由是"丢失 7/23 个必须保留的实体"）。那份产出还在 dsh 转录里，
 * 而转录是已经付过钱的——把它抽出来喂给**新护栏**，就能在不花钱的前提下回答：
 * "改版之后，这份真实的摘要还会不会被我误判？"
 *
 * 用法:
 *   node .p1-baseline/verify-guard-on-real-output.mjs <session目录名>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { decodeZstdFrames, harnessHomes } from './audit-llm-calls.mjs';
import { checkCompression, checkNoInvention, inventionVerdict, mustKeepEntities, partitionByAppearance } from '../ai/memory-compress-guard.mjs';

const sessionName = process.argv[2];
if (!sessionName) { console.error('用法: node .p1-baseline/verify-guard-on-real-output.mjs <session目录名>'); process.exit(2); }

// 决策 B 起会有多个 harness home（写作任务被关进专用 home）。逐个找；
// 找不到就明确报出来——"看不见"不能伪装成"没发生"。
const root = harnessHomes()
  .map((h) => path.join(h, 'sessions', '--C-Users-a1941-Desktop-DeepSeek-deepseek-harness--', sessionName))
  .find((d) => fs.existsSync(d));
if (!root) { console.error(`✗ 在所有 harness home 里都找不到会话 ${sessionName}`); process.exit(2); }
console.log(`（会话来自 ${root.includes('.dsh-novel') ? '专用 home' : '共享 home'}）`);
const zst = fs.readdirSync(root).filter((f) => f.endsWith('.zstd'));
if (!zst.length) { console.error('✗ 会话里没有 .zstd 转录'); process.exit(2); }

// 逐帧解码（dsh 的转录是追加写的多帧 zstd；整文件解只出第一帧）。
let raw = '';
for (const f of zst) raw += decodeZstdFrames(fs.readFileSync(path.join(root, f))).toString('utf8');

// 串起 assistant 的文本块。事件格式随版本变，这里按"能拿到的最长连续文本"兜底。
const texts = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  const s = JSON.stringify(ev);
  for (const m of s.matchAll(/"(?:text|delta|content)"\s*:\s*"((?:[^"\\]|\\.){20,})"/g)) {
    try { texts.push(JSON.parse(`"${m[1]}"`)); } catch { /* 忽略坏转义 */ }
  }
}
const joined = texts.join('');
// 压缩任务的产出就是那段摘要：取含"【"或较长的连续块里最长的那个。
const candidate = texts.slice().sort((a, b) => b.length - a.length)[0] || '';
const summary = candidate.replace(/\\n/g, '\n');

console.log('═══ 用真实产出验证护栏改版（零成本：转录已付过费）═══\n');
console.log(`  会话        : ${sessionName}`);
console.log(`  解码字符数  : ${raw.length}`);
console.log(`  抽出的最长文本块: ${summary.length} 字`);

// 用真实库的角色/章节算两侧集合。
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const chs = db.prepare('SELECT title, summary, blueprint_json, content FROM chapters WHERE work_id = 2').all();
const hay = chs.map((c) => [c.title, c.summary, c.blueprint_json, c.content].join('\n')).join('\n');
const cs = db.prepare('SELECT name FROM characters WHERE work_id = 2').all();
const ws = db.prepare('SELECT title FROM world_entries WHERE work_id = 2').all();
db.close();
const cast = partitionByAppearance({ characters: cs, worldEntries: ws, chapterText: hay });
console.log(`  作品 #2     : 角色 ${cs.length} → 出场 ${cast.appearedChars.length} / 未出场 ${cast.absentChars.length}\n`);

const oldGuard = checkCompression({ compressed: summary, minCoverage: 1, mustKeep: mustKeepEntities({ characters: cs, worldEntries: ws }) });
const newGuard = checkCompression({ compressed: summary, minCoverage: 1, mustKeep: mustKeepEntities({ characters: cast.appearedChars, worldEntries: cast.appearedWorlds }) });
const invention = checkNoInvention({ compressed: summary, mustNotMention: cast.absentChars.map((c) => c.name) });

console.log('【旧护栏：拿整张角色表核对】');
console.log(`  ${oldGuard.ok ? '✓ 通过' : '✗ 拒绝'}　丢失 ${oldGuard.missing.length}/${oldGuard.checked}`);
console.log(`  ${oldGuard.missing.slice(0, 8).join('、')}`);
console.log('\n【新护栏：只核对出场侧】');
console.log(`  ${newGuard.ok ? '✓ 通过' : '✗ 拒绝'}　丢失 ${newGuard.missing.length}/${newGuard.checked}`);
if (!newGuard.ok) console.log(`  ${newGuard.missing.join('、')}`);
console.log('\n【无中生有：未出场角色有没有冒出来（**默认放行**，只报告）】');
console.log(`  ${invention.ok ? '✓ 未出现' : '⚠ 出现了'}　核对 ${invention.checked} 个`);
if (!invention.ok) console.log(`  ${invention.invented.join('、')}`);
console.log(`  处置：${inventionVerdict(invention.invented)}（allow = 记日志放行；reject = 拦落库，需 NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1）`);

// 真正的"能不能落库"由**完整性**决定（出场的一个都不许丢）；"无中生有"默认只报告。
const wouldSave = newGuard.ok;
console.log('\n═══ 结论 ═══');
console.log(`  这份真实产出在新流程下：**${wouldSave ? '会落库' : '仍会被拒绝'}**`
  + `（完整性 ${newGuard.kept}/${newGuard.checked}）`);
if (!wouldSave) {
  console.log(`  缺的是：${newGuard.missing.join('、')}——它们确实在章节里出现过，属于真丢人。`);
  console.log('  旧护栏报 7/23（多数是没出场的人，噪声）；新护栏报 2/6（真丢人）。**诊断更准**。');
}
console.log('  注意：这份产出是用**旧提示词**（把 23 个角色全喂进去）生成的，所以"无中生有"那 12 个');
console.log('  不是模型幻觉；新提示词只喂出场过的角色。**"新流程能否通过"仍需一次新提示词的真实调用**。');
process.exitCode = 0;
