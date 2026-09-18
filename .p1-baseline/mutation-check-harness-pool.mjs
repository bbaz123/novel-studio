#!/usr/bin/env node
/**
 * mutation-check-harness-pool.mjs —— 对 `ai/harness-pool.mjs` 跑**变异测试**。
 *
 * 为什么要它：`test-harness-pool.mjs` 里写着几条"变异锚点"，但"写了锚点"不等于
 * "锚点真的会红"——本项目已四次栽在"检查看起来通过、其实恒真"上（F7/F10/幽灵调用/形状断言）。
 * 所以锚点必须被**真的执行**一次：把实现改坏 → 跑测试 → 确认**只有**预期的断言变红 → 还原。
 *
 * 判据（两条都要求）：
 *   ① 变异后必须至少红一条，且红的集合**恰好等于**声明的期望集合（多红 = 连带，少红 = 掩盖）；
 *   ② 还原后必须重新全绿（证明"红"确实来自变异，而不是文件被改坏）。
 *
 * 用法：node .p1-baseline/mutation-check-harness-pool.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const TARGET = path.join(repo, 'ai', 'harness-pool.mjs');
const TEST = path.join(here, 'test-harness-pool.mjs');

const MUTATIONS = [
  {
    name: 'assistant/message 改成累加（而不是取最后一条）',
    from: `    if (texts.length) next.text = texts.join('');`,
    to: `    if (texts.length) next.text = state.text + texts.join('');`,
    expect: ['1b'],
  },
  {
    name: '去掉 sessionId 过滤（别人的会话也收）',
    from: `    if (!params || params.sessionId !== sessionId) return; // 只认自己那条会话`,
    to: `    if (!params) return; // MUTATED: 不过滤 sessionId`,
    // 3a 是单会话场景、3d 是双会话并发场景：两者都是"隔离性"这一个属性的不同表现，
    // 去掉过滤会让它们同时红 —— 这是**同一处的两个检测点**，不是纠缠（3a 只测过滤，不再受折叠逻辑影响）。
    expect: ['3a', '3d'],
  },
  {
    name: '取用后不后台补位',
    from: `      warmUp(route).catch((e) => log('warn', 'pool_rewarm_failed', \`热备补位失败：\${e.message}\`, { route: key }));`,
    to: `      // MUTATED: 不补位`,
    expect: ['4b'],
  },
  {
    name: 'acquire 不检查热备是否已退出',
    from: `      if (rec && !rec.worker.exited) {`,
    to: `      if (rec) {`,
    expect: ['4e'],
  },
  {
    name: '在途任务不订阅进程退出（会挂到超时）',
    from: `  const offExit = worker.onExit ? worker.onExit((err) => rejectDone(err)) : () => {};`,
    to: `  const offExit = () => {}; // MUTATED: 不订阅退出`,
    expect: ['3h'],
  },
];

const runTest = () => {
  try {
    return { out: execFileSync(process.execPath, [TEST], { cwd: repo, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 };
  }
};

const failedIds = (out) => [...out.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);

const original = fs.readFileSync(TARGET, 'utf8');
let problems = 0;
try {
  const baseline = runTest();
  const baseFail = failedIds(baseline.out);
  console.log(`基线：${baseFail.length ? '红 ' + baseFail.join(',') : '全绿'}`);
  if (baseFail.length) { console.log('基线非全绿，先修测试再谈变异。'); process.exit(1); }

  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) {
      console.log(`FAIL  ${m.name} —— 变异锚点在实现里找不到（锚点已腐烂，必须更新）`);
      problems += 1;
      continue;
    }
    fs.writeFileSync(TARGET, original.replace(m.from, m.to), 'utf8');
    let got = [];
    try { got = failedIds(runTest().out); }
    finally { fs.writeFileSync(TARGET, original, 'utf8'); }

    const expected = m.expect;
    const missed = expected.filter((e) => !got.some((g) => g.startsWith(e)));
    const extra = got.filter((g) => !expected.some((e) => g.startsWith(e)));
    const ok = missed.length === 0 && extra.length === 0;
    if (!ok) problems += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${m.name} —— 期望红 ${expected.join(',')}；实际红 ${got.length ? got.join(',') : '（无）'}`);
    if (missed.length) console.log(`        ✗ 该红没红：${missed.join(',')}（断言没咬住这处实现）`);
    if (extra.length) console.log(`        ✗ 连带变红：${extra.join(',')}（断言之间纠缠，红点无法归因）`);
  }
} finally {
  fs.writeFileSync(TARGET, original, 'utf8'); // 双保险：无论如何都还原
}

const restored = runTest();
const restoredFail = failedIds(restored.out);
console.log(`\n还原后：${restoredFail.length ? '仍有红 ' + restoredFail.join(',') : '全绿'}`);
if (restoredFail.length) problems += 1;

console.log(`\n=== ${problems ? problems + ' 处问题' : '全部变异均被正确捕获'} ===`);
process.exit(problems ? 1 : 0);
