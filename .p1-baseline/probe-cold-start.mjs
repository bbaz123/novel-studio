#!/usr/bin/env node
/**
 * probe-cold-start.mjs —— 零计费测"每任务冷启动到底花在哪"。
 *
 * ── 为什么值得单独测 ──────────────────────────────────────────────────────────
 * README 记着"慢通道每个任务多花 ≈17–18 秒（冷启动 + 智能体循环）"，但那个数字把两件事
 * 混在一起了：**进程启动/模块加载** 与 **模型往返**。要提速就得先把它拆开 ——
 * 拆法是把模型端点指向本仓库的假 LLM（会真的应答、零计费），于是：
 *
 *     冷启动 = 子进程启动 → 假端点收到第一个请求    （这段是纯开销，与模型快慢无关）
 *     其余   = 端点收到请求 → 子进程退出            （这段才是模型与智能体循环）
 *
 * ── 顺带对照两条启动路径 ──────────────────────────────────────────────────────
 * 源码仓库的 `scripts.dsh` 是 `node --import tsx/esm apps/cli/src/bin.ts`（**现场转译**），
 * 而仓库里同时存在已构建的 `apps/cli/lib/bin.js`。两者启动同一套 profile，
 * 差别只在"要不要现译一遍 TS"。这条差异值多少秒，就是这个脚本要回答的。
 *
 * 用法：node .p1-baseline/probe-cold-start.mjs [--runs 2]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RUNS = Math.max(1, Number(arg('--runs', '2')) || 2);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelstudio-cold-'));
process.env.NOVELSTUDIO_DATA_DIR = dataDir;
process.env.NOVELSTUDIO_OV_DISABLED = '1';
process.env.NOVELSTUDIO_OPENVIKING_PEER_ID = 'cold-probe';

const { startFakeLLM } = await import(pathToFileURL(path.join(HERE, 'fake-llm.mjs')).href);
const { harnessRuntimeInfo } = await import(pathToFileURL(path.join(REPO, 'harness.js')).href);
const { harnessChildEnv } = await import(pathToFileURL(path.join(REPO, 'ai', 'harness-env.mjs')).href);

const info = harnessRuntimeInfo();
const PROMPT = '不要调用任何工具，也不要读写文件，只回复两个字：好的';
const PROFILE = 'novel';

/** 跑一次一次性任务；返回 { totalMs, coldMs, reply, exitCode }。 */
function runOnce(launch, env, llm) {
  return new Promise((resolve) => {
    const before = llm.count();
    const t0 = Date.now();
    const child = spawn(process.execPath, [...launch.args, '--profile', PROFILE, PROMPT], {
      cwd: launch.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
    const kill = setTimeout(() => { try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ } }, 240000);
    child.on('close', (code) => {
      clearTimeout(kill);
      const totalMs = Date.now() - t0;
      // 冷启动 = 从进程启动到**第一个模型请求到达假端点**（用端点侧时间戳，不是猜测）
      const first = llm.requests.slice(before).map((r) => Date.parse(r.ts)).filter(Number.isFinite);
      const coldMs = first.length ? Math.min(...first) - t0 : null;
      resolve({ totalMs, coldMs, reply: out.trim(), exitCode: code, calls: llm.count() - before, err });
    });
  });
}

const launches = [
  { name: 'A 现状：tsx 现场转译源码', launch: { args: ['--import', 'tsx/esm', path.join(info.dir, 'apps/cli/src/bin.ts')], cwd: info.dir } },
  { name: 'B 对照：预构建 apps/cli/lib/bin.js', launch: { args: [path.join(info.dir, 'apps/cli/lib/bin.js')], cwd: info.dir } },
];

const llm = await startFakeLLM({ port: 0, reply: '好的', logPath: path.join(dataDir, 'fake-llm.jsonl') });
console.log(`假 LLM 端点：http://127.0.0.1:${llm.port}（零计费）`);
console.log(`dsh 仓库：${info.dir}\n`);
const env = harnessChildEnv({
  peerId: 'cold-probe',
  env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`, DEEPSEEK_API_KEY: 'cold-probe-sentinel' },
});

const summary = [];
for (const { name, launch } of launches) {
  console.log(`== ${name} ==`);
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = await runOnce(launch, env, llm);
    times.push(r);
    console.log(`   第 ${i + 1} 次：总 ${r.totalMs}ms｜冷启动 ${r.coldMs == null ? '(端点没收到请求!)' : r.coldMs + 'ms'}｜模型请求 ${r.calls} 次｜退出码 ${r.exitCode}｜回复 ${JSON.stringify(r.reply.slice(0, 24))}`);
    if (r.err) console.log(`   stderr 尾部：${r.err.slice(-300)}`);
  }
  const cold = times.map((t) => t.coldMs).filter((x) => x != null);
  summary.push({ name, cold: cold.length ? Math.round(cold.reduce((a, b) => a + b, 0) / cold.length) : null, total: Math.round(times.reduce((a, b) => a + b.totalMs, 0) / times.length) });
}

// ── C：**生产路径**。不再自己拼启动参数，而是直接调 harness.js 的导出函数，
//    于是这次测量的就是 `resolveDshLaunch()` 真实选出来的那条路。──
{
  console.log('== C 生产路径：harness.js 的 runHarnessTaskWithProgress ==');
  const { runHarnessTaskWithProgress } = await import(pathToFileURL(path.join(REPO, 'harness.js')).href);
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const before = llm.count();
    const t0 = Date.now();
    let reply = '';
    let failed = null;
    try {
      reply = await runHarnessTaskWithProgress(PROMPT, { timeout: 240000, env: env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY } : {} }, () => {});
    } catch (e) { failed = e; }
    const totalMs = Date.now() - t0;
    const first = llm.requests.slice(before).map((r) => Date.parse(r.ts)).filter(Number.isFinite);
    const coldMs = first.length ? Math.min(...first) - t0 : null;
    times.push({ totalMs, coldMs });
    console.log(`   第 ${i + 1} 次：总 ${totalMs}ms｜冷启动 ${coldMs == null ? '(端点没收到请求!)' : coldMs + 'ms'}｜回复 ${JSON.stringify(String(reply).slice(0, 24))}${failed ? `｜失败：${failed.message}` : ''}`);
  }
  const cold = times.map((t) => t.coldMs).filter((x) => x != null);
  summary.push({ name: 'C 生产路径：harness.js 实际选择的启动方式', cold: cold.length ? Math.round(cold.reduce((a, b) => a + b, 0) / cold.length) : null, total: Math.round(times.reduce((a, b) => a + b.totalMs, 0) / times.length) });
}
await llm.close();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n== 汇总（均值）==');
for (const s of summary) console.log(`   ${s.name}\n      冷启动 ${s.cold == null ? '—' : s.cold + 'ms'}｜端到端 ${s.total}ms`);
if (summary.length === 2 && summary[0].cold != null && summary[1].cold != null) {
  console.log(`\n   两条路径的冷启动差：${summary[0].cold - summary[1].cold}ms`);
}
