#!/usr/bin/env node
/**
 * exp-per-task-settings.mjs —— 实验：能否把**单个 dsh 任务的 settings 文档**重定向走？
 *
 * 为什么做这个实验（决策 D8-#2 的前置）：
 *   小说工坊的界面路径处处显式传模型，而 dsh 的默认模型存在**全局** `~/.dsh/settings.yaml` 里，
 *   于是 `harness.js` 只能「改全局文件 → 跑任务 → 还原」并为此加锁串行化——
 *   服务端允许 2 并发，**实际吞吐却只有 1**。
 *
 *   已知两条事实（都不是推断）：
 *     1. dsh 的 headless CLI **没有**任务级模型参数（`.p0-recon/headless.help.txt` 实抓）；
 *     2. 但 `dsh --patch <file>` 会叠加配置层（`bin.js` 的 option 列表），
 *        而 settings 插件的文档路径是**可配置**的
 *        （`packages/settings/settings-file/src/index.ts:56`：`config.path ?? <harness home>/settings.yaml`）。
 *
 *   若 (2) 成立 → 每个任务可持有各自的 settings 文档 → 没有共享可变状态 → 互斥可以拆掉、吞吐到 2。
 *
 * 怎么证明（零计费）：
 *   起**黑洞端点**（接受连接、永不响应、dump 原始请求体），把 dsh 指过去；
 *   再在哨兵 settings 里写一个**只在重定向生效时才会出现**的模型名。
 *   于是「请求体里出现哨兵模型名」= 重定向真的生效——不靠读代码猜。
 *
 * ⚠️ 必须带**阴性对照**：不带 `--patch` 跑一次，请求体里应当是**真实**模型名。
 *    没有对照组，就无法排除「哨兵名字碰巧出现」这类假阳性。
 *
 * 用法: node .p1-baseline/exp-per-task-settings.mjs
 * 退出码: 0 = 结论明确（无论正反）；1 = 实验无效（拿不到证据）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBlackhole } from './blackhole.mjs';

const REPO = process.cwd();
const DSH_REPO = process.env.DSH_REPO || path.resolve(REPO, '..', 'deepseek-harness');
const REAL_SETTINGS = process.env.DSH_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml');
const WORK = path.join(REPO, '.p1-baseline', '.exp-settings');
const SENTINEL_MODEL = 'dsh-settings-redirect-probe';
const SENTINEL_EFFORT = 'low';   // 真实文件里是 max，两者都可区分

const say = (ok, text) => console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'} ${text}`);

/** 从解析后的 dsh 仓库 package.json 取启动方式（与 harness.js 的 resolveDshLaunch 同源）。 */
function resolveDshLaunch() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DSH_REPO, 'package.json'), 'utf8'));
  const script = String((pkg.scripts && pkg.scripts.dsh) || '').trim();
  const m = script.match(/^node\s+([\s\S]+)$/);
  if (!m) throw new Error(`无法从 package.json 解析 dsh 启动方式：${JSON.stringify(script)}`);
  const parts = m[1].trim().split(/\s+/).filter(Boolean);
  const entry = parts[parts.length - 1];
  const resolved = entry.startsWith('.') || !entry.includes(':') ? path.join(DSH_REPO, entry) : entry;
  return { args: [...parts.slice(0, -1), resolved], cwd: DSH_REPO };
}

/** 跑一次 dsh 任务，返回黑洞 dump 出来的原始请求字节。 */
async function runOnce(label, { patchPath }) {
  const dumpPath = path.join(WORK, `${label}.dump.txt`);
  const logPath = path.join(WORK, `${label}.conn.jsonl`);
  fs.rmSync(dumpPath, { force: true });
  const bh = await startBlackhole({ port: 0, logPath, dumpPath });

  const launch = resolveDshLaunch();
  const args = [...launch.args, '--profile', 'novel'];
  if (patchPath) args.push('--patch', patchPath);
  args.push('Reply with the single word: ok');

  console.log(`\n[${label}] 起 dsh：${patchPath ? '带 --patch' : '不带 --patch（阴性对照）'}，黑洞 127.0.0.1:${bh.port}`);
  const child = spawn(process.execPath, args, {
    cwd: launch.cwd,
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${bh.port}`,
      DEEPSEEK_API_KEY: 'sk-isolation-sentinel-not-a-real-key',
      NOVELSTUDIO_OV_DISABLED: '1',
      NOVELSTUDIO_BASE_URL: 'http://127.0.0.1:3737',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  // 等到黑洞收到字节（= dsh 真的把请求发出去了），最多 100 秒
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    if (fs.existsSync(dumpPath) && fs.statSync(dumpPath).size > 0) break;
    if (child.exitCode !== null) break;
    await new Promise((s) => setTimeout(s, 1000));
  }
  await new Promise((s) => setTimeout(s, 1500));   // 让同一连接的后续字节落盘
  try { child.kill(); } catch { /* 已退出 */ }
  await bh.close();

  const dump = fs.existsSync(dumpPath) ? fs.readFileSync(dumpPath, 'utf8') : '';
  console.log(`  黑洞收到 ${dump.length} 字节${child.exitCode !== null ? `（dsh 已退出 code=${child.exitCode}）` : ''}`);
  if (!dump && out) console.log(`  dsh 输出片段：${out.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
  return { dump, out };
}

// ── 准备哨兵文件 ────────────────────────────────────────────────────────────
fs.mkdirSync(WORK, { recursive: true });
const sentinelSettings = path.join(WORK, 'sentinel-settings.yaml');
fs.writeFileSync(sentinelSettings, [
  'agent-default-model:',
  '  provider: deepseek-official',
  `  model: ${SENTINEL_MODEL}`,
  `  reasoningEffort: ${SENTINEL_EFFORT}`,
  '',
].join('\n'), 'utf8');

const patchFile = path.join(WORK, 'redirect-settings.patch.yml');
fs.writeFileSync(patchFile, [
  '# 把 settings 插件的文档路径指向哨兵文件（只影响本次 --patch 的进程）',
  '- id: settings',
  '  config:',
  `    path: '${sentinelSettings.replace(/\\/g, '/')}'`,
  '',
].join('\n'), 'utf8');

console.log('═══ 实验：能否把单个 dsh 任务的 settings 文档重定向走 ═══');
console.log(`真实 settings : ${REAL_SETTINGS}`);
console.log(`哨兵 settings : ${sentinelSettings}`);
console.log(`补丁文件      : ${patchFile}`);
console.log(`哨兵模型名    : ${SENTINEL_MODEL}（只在重定向生效时才会出现在请求体里）`);

const real = fs.readFileSync(REAL_SETTINGS, 'utf8');
const realModel = (real.match(/^\s*model:\s*(\S+)/m) || [])[1] || '(未解析出)';
console.log(`真实模型名    : ${realModel}（阴性对照应当看到它）`);

// ── 两次运行 ────────────────────────────────────────────────────────────────
const withPatch = await runOnce('with-patch', { patchPath: patchFile });
const control = await runOnce('control', { patchPath: null });

console.log('\n═══ 判据 ═══');
let invalid = 0;
if (!control.dump) {
  say(false, '阴性对照没拿到任何请求字节 → 实验无效（不能据此下结论）');
  invalid++;
} else {
  say(control.dump.includes(realModel),
    `阴性对照：不带 --patch 时，请求体里是**真实**模型名 ${realModel}`);
  say(!control.dump.includes(SENTINEL_MODEL),
    `阴性对照：请求体里**没有**哨兵模型名（排除假阳性）`);
}
if (!withPatch.dump) {
  say(false, '带 --patch 的那次没拿到请求字节 → 实验无效');
  invalid++;
} else {
  const hit = withPatch.dump.includes(SENTINEL_MODEL);
  say(hit, `带 --patch 时，请求体里${hit ? '**出现**' : '**没有出现**'}哨兵模型名`);
}

console.log('\n═══ 结论 ═══');
if (invalid) {
  console.log('  ✗ 实验无效：至少一次运行没拿到证据，不能下结论。');
  process.exitCode = 1;
} else if (withPatch.dump.includes(SENTINEL_MODEL)) {
  console.log('  ✓ **重定向成立**：`--patch` 能把单个任务的 settings 文档换掉。');
  console.log('    ⇒ 每任务独立 settings 在原理上可行，互斥锁有望拆掉、吞吐到 2。');
  console.log('    （下一步仍需验证：并发两个任务各自读到自己的文档，且没有别的共享状态）');
} else {
  console.log('  ✗ **重定向不成立**：`--patch` 没能改掉 settings 文档路径。');
  console.log('    ⇒ 吞吐 1 是 dsh 的结构性限制；可选做法只剩「如实把并发上限调成 1」。');
}
console.log('\n零计费依据：两次都指向黑洞端点，且转储里可核对模型名。');
