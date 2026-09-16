#!/usr/bin/env node
/**
 * exp-concurrent-models.mjs —— 决策 D8-#2 的端到端证明（零计费）。
 *
 * 要证明的三件事：
 *   1. **并发**：两个 dsh 任务可以同时在跑（此前它们被全局 settings 互斥串行化）；
 *   2. **各用各的模型**：同一时刻两个任务的请求里，模型名分别是各自指定的那个；
 *   3. **不碰全局**：用户的 `~/.dsh/settings.yaml` 在这次实验前后**逐字节未变**。
 *
 * 做法：黑洞端点收请求 + dump 原始报文（模型名就在请求体里）。
 * 两个任务各自拿一份物化好的 settings 文档 + 指向它的 `--patch`。
 *
 * 自带**阴性对照**：同样两个任务，但**都不带** `--patch` ——
 * 这时两次请求里应当只有**真实**模型名、没有任何哨兵名。
 * 没有这组对照，"哨兵名出现"就可能只是碰巧。
 *
 * 用法: node .p1-baseline/exp-concurrent-models.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startBlackhole } from './blackhole.mjs';
import { buildSettingsRedirectPatch, buildTaskArgs, TASK_SETTINGS_PREFIX } from '../ai/task-settings.mjs';

const REPO = process.cwd();
const DSH_REPO = process.env.DSH_REPO || path.resolve(REPO, '..', 'deepseek-harness');
const REAL_SETTINGS = process.env.DSH_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml');
const WORK = path.join(REPO, '.p1-baseline', '.exp-settings');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const say = (ok, text) => console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'} ${text}`);

function resolveDshLaunch() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DSH_REPO, 'package.json'), 'utf8'));
  const m = String(pkg.scripts.dsh).match(/^node\s+([\s\S]+)$/);
  const parts = m[1].trim().split(/\s+/).filter(Boolean);
  const entry = parts[parts.length - 1];
  return {
    args: [...parts.slice(0, -1), entry.startsWith('.') ? path.join(DSH_REPO, entry) : entry],
    cwd: DSH_REPO,
  };
}

/** 物化一份每任务 settings（与 harness.js 的 materializeTaskSettings 同构）。 */
function materialize(model, tag) {
  const original = fs.readFileSync(REAL_SETTINGS, 'utf8');
  const content = original.replace(/^(\s*model:\s*).*$/m, `$1${model}`);
  if (content === original) throw new Error(`哨兵替换失败：真实 settings 里没有可替换的 model 行`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TASK_SETTINGS_PREFIX}${tag}-`));
  const settingsPath = path.join(dir, 'settings.yaml');
  const patchPath = path.join(dir, 'redirect-settings.patch.yml');
  fs.writeFileSync(settingsPath, content, 'utf8');
  fs.writeFileSync(patchPath, buildSettingsRedirectPatch(settingsPath), 'utf8');
  return { dir, patchPath };
}

/** 起一个 dsh 任务，等它连上黑洞。返回句柄（不阻塞别人）。 */
function launch(label, port, patchPath) {
  const launchInfo = resolveDshLaunch();
  const args = [...launchInfo.args, ...buildTaskArgs({
    profile: 'novel', prompt: `Reply with the single word: ${label}`, patchPath,
  })];
  const h = { label, connectedAt: null, child: null };
  h.child = spawn(process.execPath, args, {
    cwd: launchInfo.cwd,
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
      DEEPSEEK_API_KEY: 'sk-isolation-sentinel-not-a-real-key',
      NOVELSTUDIO_OV_DISABLED: '1',
      NOVELSTUDIO_BASE_URL: 'http://127.0.0.1:3737',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  h.child.stdout.on('data', () => {});
  h.child.stderr.on('data', () => {});
  return h;
}

async function runOnce({ label, withPatch }) {
  fs.mkdirSync(WORK, { recursive: true });
  const dumpPath = path.join(WORK, `${label}.dump.txt`);
  const logPath = path.join(WORK, `${label}.conn.jsonl`);
  fs.rmSync(dumpPath, { force: true });
  const bh = await startBlackhole({ port: 0, logPath, dumpPath });

  const models = withPatch
    ? { A: `probe-concurrent-aaa-${Date.now() % 100000}`, B: `probe-concurrent-bbb-${Date.now() % 100000}` }
    : { A: null, B: null };

  const mats = [];
  if (withPatch) {
    mats.push(materialize(models.A, 'A'));
    mats.push(materialize(models.B, 'B'));
  }

  const t0 = Date.now();
  const a = launch('A', bh.port, withPatch ? mats[0].patchPath : null);
  const b = launch('B', bh.port, withPatch ? mats[1].patchPath : null);

  // ⚠️ 等的必须**不是"连接建立"**：dsh 会先建 TCP、稍后才发请求体。
  // 第一版就是等到 2 个连接就读转储，于是 B 的报文还没到就被判"没出现"——
  // 那是**等错了条件**造成的假失败，不是功能问题。
  const want = withPatch
    ? [models.A, models.B]
    : [(fs.readFileSync(REAL_SETTINGS, 'utf8').match(/^\s*model:\s*(\S+)/m) || [])[1]].filter(Boolean);
  const readDump = () => (fs.existsSync(dumpPath) ? fs.readFileSync(dumpPath, 'utf8') : '');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const d = readDump();
    if (want.every((m) => d.includes(m))) break;
    if (a.child.exitCode !== null && b.child.exitCode !== null) break;
    await new Promise((s) => setTimeout(s, 1000));
  }
  const conns = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  await new Promise((s) => setTimeout(s, 1200));

  const dump = readDump();
  // 用 taskkill /T 杀**整棵进程树**：dsh 经 tsx 拉起子进程，只 kill 父进程会留下孤儿。
  for (const h of [a, b]) {
    try { spawn('taskkill', ['/pid', String(h.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
  await new Promise((s) => setTimeout(s, 800));
  await bh.close();
  for (const m of mats) { try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }

  return { dump, conns, models, elapsed: Date.now() - t0 };
}

console.log('═══ 实验：两个并发任务各用各的模型，且不碰全局 settings ═══');
console.log(`真实 settings : ${REAL_SETTINGS}`);
const before = sha(REAL_SETTINGS);

console.log('\n【带 --patch：两个任务各拿一份独立 settings】');
const withPatch = await runOnce({ label: 'with-patch', withPatch: true });
say(withPatch.conns.length >= 2, `两个任务都连上了黑洞（连接数 ${withPatch.conns.length}）`);
const hitA = withPatch.dump.includes(withPatch.models.A);
const hitB = withPatch.dump.includes(withPatch.models.B);
say(hitA, `请求里出现任务 A 的模型名 ${withPatch.models.A}`);
say(hitB, `请求里出现任务 B 的模型名 ${withPatch.models.B}`);

console.log('\n【阴性对照：都不带 --patch，应当只有真实模型名】');
const control = await runOnce({ label: 'control', withPatch: false });
const realModel = (fs.readFileSync(REAL_SETTINGS, 'utf8').match(/^\s*model:\s*(\S+)/m) || [])[1] || '';
say(control.conns.length >= 2, `两个任务都连上了黑洞（连接数 ${control.conns.length}）`);
say(control.dump.includes(realModel), `请求里是真实模型名 ${realModel}`);
say(!/probe-concurrent-/.test(control.dump), '对照里**没有**任何哨兵模型名（排除假阳性）');

const after = sha(REAL_SETTINGS);
console.log('\n【全局文件未被改动】');
say(before === after, `~/.dsh/settings.yaml 逐字节未变（sha256 ${before.slice(0, 12)}…）`);

console.log('\n═══ 结论 ═══');
const pass = hitA && hitB && before === after && control.dump.includes(realModel) && !/probe-concurrent-/.test(control.dump);
if (pass) {
  console.log('  ✓ **每任务独立 settings 成立**：同一时刻两个任务各自读到了自己的模型，');
  console.log('    且用户的全局 settings 一个字节都没动。');
  console.log('    ⇒ 没有共享可变状态，「改全局 → 跑 → 还原」的互斥锁不再是必要条件，');
  console.log('      吞吐可以从 1 回到 2（上限仍由 HARNESS_CONCURRENCY 约束）。');
} else {
  console.log('  ✗ 未能证明：见上面未通过的判据。不要据此改动互斥逻辑。');
}
console.log('\n零计费依据：三次运行全部指向黑洞端点，转储里可核对模型名。');
process.exitCode = pass ? 0 : 1;
