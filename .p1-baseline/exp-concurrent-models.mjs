#!/usr/bin/env node
/**
 * exp-concurrent-models.mjs —— 决策 D8-#2 的端到端证明（零计费）。
 *
 * 要证明的三件事：
 *   1. **并发**：两个 dsh 任务可以同时在跑（此前它们被全局改写互斥串行化）；
 *   2. **各用各的模型**：同一时刻两个任务的请求里，模型名分别是各自指定的那个；
 *   3. **不落地**：两个哨兵模型名**没有**出现在 home 里任何一份持久配置里
 *      （每任务覆盖只活在那一个子进程里 —— 这正是"不需要互斥"的依据）。
 *
 * 做法：黑洞端点收请求 + dump 原始报文（模型名就在请求体里）。
 * 每个任务各拿一份物化好的 `--patch` 覆盖层。
 *
 * 自带**阴性对照**：同样两个任务，但**都不带** `--patch` ——
 * 这时两次请求里应当只有**真实**默认模型名、没有任何哨兵名。
 * 没有这组对照，"哨兵名出现"就可能只是碰巧。
 *
 * ⚠️ 2026-09-24（dsh 0.1.1-rc.2 → 0.1.7-rc.1）两处大改，读代码前先看：
 *   1. **覆盖层的内容变了**。旧做法是「每任务一份 settings 文档 + `- id: settings`
 *      `config.path` 指过去」。0.1.7 删除了 `packages/settings/settings-file`，
 *      settings 文档**只在首次启动时被导入 profile 一次**、路径不可再重定向
 *      （实测取证：`.dsh-upgrade-recon/c8-probe.mjs`），所以现在改成直接覆盖
 *      `- id: agent-default-model` 的 config；
 *   2. **跑在隔离 home 里**。0.1.7 首次启动会把 `<home>/settings.yaml` 改名成
 *      `.imported`（上游的一次性导入，与本次实验无关）——直接拿用户的 `~/.dsh-novel`
 *      做实验会把他的 settings 文件"吃掉"。所以这里整份拷到临时 home 再跑，
 *      用户的 home 一个字节都不碰。因此第 3 条判据的口径是"哨兵没有落进这个 home 的
 *      持久配置"，而不是旧版的"sha 前后相同"（旧口径在 0.1.7 下会被上游改名行为误判为失败）。
 *
 * 用法: node .p1-baseline/exp-concurrent-models.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBlackhole } from './blackhole.mjs';
import { resolveTaskDshHome } from '../ai/harness-env.mjs';
import {
  buildModelOverridePatch, buildTaskArgs,
  parseAgentDefaultFromPatch, resolveDefaultSelection, TASK_SETTINGS_PREFIX,
} from '../ai/task-settings.mjs';

const REPO = process.cwd();
const DSH_REPO = process.env.DSH_REPO || path.resolve(REPO, '..', 'deepseek-harness');
// 与生产同源：harness 任务用的就是 ai/harness-env.mjs 决定的那份 home（决策 B）。
const REAL_HOME = resolveTaskDshHome() || path.join(os.homedir(), '.dsh');
const WORK = path.join(REPO, '.p1-baseline', '.exp-settings');
const HOME = path.join(WORK, 'home');
const PROFILE = 'novel';

const say = (ok, text) => console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'} ${text}`);
const readIfExists = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const linkDir = (target, at) => {
  try { fs.symlinkSync(target, at, 'junction'); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
};

// ── 隔离 home：配置整份拷贝，包农场 junction 到真实目录（只读不写） ──────────
// 为什么必须隔离而不是直接用真实 home：0.1.7 首次启动会改名 settings.yaml（见文件头），
// 而这份实验的目的之一就是观察"我们有没有动持久配置"——考卷和答案不能是同一张纸。
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'profiles'), { recursive: true });
linkDir(path.join(REAL_HOME, 'profiles', 'node_modules'), path.join(HOME, 'profiles', 'node_modules'));
const realProfile = path.join(REAL_HOME, 'profiles', PROFILE);
const tempProfile = path.join(HOME, 'profiles', PROFILE);
fs.mkdirSync(tempProfile, { recursive: true });
const PROFILE_FILES = ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'];
for (const f of PROFILE_FILES) {
  const src = path.join(realProfile, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tempProfile, f));
}
// 插件目录**逐个子目录 junction**、而不是整份 junction 上层：dsh 启动时可能按 profile
// 清单重装依赖，整份 junction 会让它写进用户的真实 profile（升级复盘的 F1 教训）。
const tempNodeModules = path.join(tempProfile, 'node_modules');
fs.mkdirSync(tempNodeModules, { recursive: true });
for (const entry of fs.readdirSync(path.join(realProfile, 'node_modules'))) {
  if (entry.startsWith('.')) continue;                       // .pnpm / .modules.yaml 之类留给 pnpm 自己
  const src = path.join(realProfile, 'node_modules', entry);
  if (entry.startsWith('@')) {
    fs.mkdirSync(path.join(tempNodeModules, entry), { recursive: true });
    for (const sub of fs.readdirSync(src)) linkDir(path.join(src, sub), path.join(tempNodeModules, entry, sub));
  } else {
    linkDir(src, path.join(tempNodeModules, entry));
  }
}
// settings 文档也拷一份（0.1.7 的模型真值来源之一；导入后会被改名，属上游行为）。
const REAL_SETTINGS_SRC = path.join(REAL_HOME, 'settings.yaml');
const realSettings = readIfExists(REAL_SETTINGS_SRC);
if (realSettings != null) fs.copyFileSync(REAL_SETTINGS_SRC, path.join(HOME, 'settings.yaml'));

// 基线默认模型：两份真值来源合起来算（与 harness.js 的 resolveDefaultSelection 同源）。
const baseline = resolveDefaultSelection({
  settingsYaml: realSettings,
  profilePatchYaml: readIfExists(path.join(realProfile, 'cordis.patch.yml')),
});
console.log('═══ 实验：两个并发任务各用各的模型，且不碰持久配置 ═══');
console.log(`真实 home     : ${REAL_HOME}`);
console.log(`隔离 home     : ${HOME}`);
console.log(`基线默认模型  : ${baseline.model || '(无)'}  (provider ${baseline.provider} / 来源 ${baseline.providerSource})`);
if (!baseline.model) {
  console.log('  ✗ 取不到基线模型名 → 阴性对照失去参照物，实验无效（先确认 home 里的 settings/补丁）');
  process.exitCode = 1;
}

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

/** 物化一份每任务覆盖层（与 harness.js 的 materializeTaskSettings 同构）。 */
function materialize(model, tag) {
  const content = buildModelOverridePatch({ provider: baseline.provider, model, reasoningEffort: baseline.reasoningEffort });
  if (content == null) throw new Error(`覆盖层生成失败（模型名 ${model}）`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TASK_SETTINGS_PREFIX}${tag}-`));
  const patchPath = path.join(dir, 'override-default-model.patch.yml');
  fs.writeFileSync(patchPath, content, 'utf8');
  return { dir, patchPath };
}

/** 起一个 dsh 任务，等它连上黑洞。返回句柄（不阻塞别人）。 */
function launch(label, port, patchPath) {
  const launchInfo = resolveDshLaunch();
  const args = [...launchInfo.args, ...buildTaskArgs({
    profile: PROFILE, prompt: `Reply with the single word: ${label}`, patchPath,
  })];
  const h = { label, connectedAt: null, child: null };
  h.child = spawn(process.execPath, args, {
    cwd: launchInfo.cwd,
    env: {
      ...process.env,
      DSH_HOME: HOME,                                        // 只碰隔离 home
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
  const want = withPatch ? [models.A, models.B] : [baseline.model].filter(Boolean);
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

console.log('\n【带 --patch：两个任务各拿一份独立覆盖层】');
const withPatch = await runOnce({ label: 'with-patch', withPatch: true });
say(withPatch.conns.length >= 2, `两个任务都连上了黑洞（连接数 ${withPatch.conns.length}）`);
const hitA = withPatch.dump.includes(withPatch.models.A);
const hitB = withPatch.dump.includes(withPatch.models.B);
say(hitA, `请求里出现任务 A 的模型名 ${withPatch.models.A}`);
say(hitB, `请求里出现任务 B 的模型名 ${withPatch.models.B}`);

console.log('\n【阴性对照：都不带 --patch，应当只有基线模型名】');
const control = await runOnce({ label: 'control', withPatch: false });
say(control.conns.length >= 2, `两个任务都连上了黑洞（连接数 ${control.conns.length}）`);
say(control.dump.includes(baseline.model), `请求里是基线模型名 ${baseline.model}`);
say(!/probe-concurrent-/.test(control.dump), '对照里**没有**任何哨兵模型名（排除假阳性）');

console.log('\n【哨兵没有落进任何持久配置（"不需要互斥"的依据）】');
const profilePatchPath = path.join(tempProfile, 'cordis.patch.yml');
const persistent = [
  ['settings.yaml', path.join(HOME, 'settings.yaml')],
  ['settings.yaml.imported', path.join(HOME, 'settings.yaml.imported')],
  [`profiles/${PROFILE}/cordis.patch.yml`, profilePatchPath],
];
let tainted = 0;
for (const [name, p] of persistent) {
  const text = readIfExists(p);
  if (text == null) { say(null, `${name} 不存在（未参与判定）`); continue; }
  const hit = /probe-concurrent-/.test(text);
  if (hit) tainted += 1;
  say(!hit, `${name} 里没有哨兵模型名`);
}
const effective = parseAgentDefaultFromPatch(readIfExists(profilePatchPath));
const effectiveOk = !baseline.model || effective.model === baseline.model;
say(effectiveOk, `持久默认模型仍是基线值 ${baseline.model || '(无)'}（现值 ${effective.model || '(无)'}）`);

// 上游的一次性导入（与本次实验无关，但要**如实记录**：文件突然改名会被误读成我们的副作用）。
const importedExists = fs.existsSync(path.join(HOME, 'settings.yaml.imported'));
const legacyGone = !fs.existsSync(path.join(HOME, 'settings.yaml'));
say(null, `上游一次性导入：隔离 home 的 settings.yaml ${legacyGone ? '已改名' : '仍在'} / .imported ${importedExists ? '存在' : '不存在'}（0.1.7 行为）`);

// 隔离的隔离自己也要证明：真实 home 的配置没被碰过（否则"没落进持久配置"只是在别人的文件里没查）。
const realStillSame = readIfExists(REAL_SETTINGS_SRC) === realSettings;
say(realStillSame, `真实 home 的 settings.yaml 与实验前逐字节一致（隔离生效）`);
say(!/probe-concurrent-/.test(readIfExists(path.join(realProfile, 'cordis.patch.yml')) || ''),
  `真实 profile 的 cordis.patch.yml 里也没有哨兵`);

console.log('\n═══ 结论 ═══');
const pass = hitA && hitB && control.dump.includes(baseline.model) && !/probe-concurrent-/.test(control.dump)
  && tainted === 0 && effectiveOk && realStillSame;
if (pass) {
  console.log('  ✓ **每任务独立默认模型成立**：同一时刻两个任务各自读到了自己的模型，');
  console.log('    且哨兵没有落进任何持久配置（含用户真实 home）——每任务覆盖只活在那一个子进程里。');
  console.log('    ⇒ 没有共享可变状态，「改全局 → 跑 → 还原」的互斥锁不再是必要条件，');
  console.log('      吞吐可以从 1 回到 2（上限仍由 HARNESS_CONCURRENCY 约束）。');
} else {
  console.log('  ✗ 未能证明：见上面未通过的判据。不要据此改动互斥逻辑。');
}
console.log('\n零计费依据：全部运行都指向黑洞端点，转储里可核对模型名。');
process.exitCode = pass ? 0 : 1;
