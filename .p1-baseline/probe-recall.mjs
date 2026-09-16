#!/usr/bin/env node
/** P1 探查：收敛是否触发（看 continuation 的弹性层）+ 语义召回为何零命中。 */
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:3739';
const SUMMARY = process.argv[3] || '.p1-baseline/baselines-stress/summary.json';

const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));

console.log('═══ 弹性层是否被收敛循环压缩（对比各模式）═══');
const byCase = new Map();
for (const c of summary.cases) {
  if (!c.layers) continue;
  byCase.set(`w${c.work_id}/c${c.chapter_id}`, byCase.get(`w${c.work_id}/c${c.chapter_id}`) || {});
  byCase.get(`w${c.work_id}/c${c.chapter_id}`)[c.mode] = { total: c.assembled_length, layers: c.layers };
}
const FLEX = ['前文衔接', '卷/剧情线/章节进度（大纲）', '激活的世界观设定（优先级排列）'];
for (const [k, modes] of byCase) {
  if (!k.startsWith('w16/')) continue;
  console.log(`\n  ${k}`);
  console.log(`    模式            ${['full', 'continuation', 'fragment', 'settings'].map((m) => m.padStart(14)).join('')}`);
  console.log(`    合计            ${['full', 'continuation', 'fragment', 'settings'].map((m) => String(modes[m]?.total ?? '-').padStart(14)).join('')}`);
  for (const label of FLEX) {
    const cells = ['full', 'continuation', 'fragment', 'settings'].map((m) => {
      const l = modes[m]?.layers.find((x) => x.label === label);
      return (l ? `${l.length}${l.truncated ? '✂' : ''}` : '-').padStart(14);
    });
    console.log(`    ${label.slice(0, 12).padEnd(14)}${cells.join('')}`);
  }
}
console.log('\n  → 同一章在 continuation 下的「前文衔接」若明显小于其 cap(4000)，即收敛循环被触发并压缩过。');

console.log('\n═══ 语义召回探查 ═══');
const works = [2, 9, 16];
for (const w of works) {
  for (const path of [`/api/novel/semantic?work_id=${w}`]) {
    try {
      const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      console.log(`  ${path} -> HTTP ${r.status}`);
      console.log('   ', JSON.stringify(j).slice(0, 500));
    } catch (e) {
      console.log(`  ${path} -> ${e.message}`);
    }
  }
}

console.log('\n═══ OpenViking 侧 ═══');
try {
  const r = await fetch('http://127.0.0.1:1933/health', { signal: AbortSignal.timeout(4000) });
  console.log(`  health -> HTTP ${r.status}`);
} catch (e) {
  console.log(`  health -> ${e.message}`);
}
