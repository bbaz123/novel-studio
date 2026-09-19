#!/usr/bin/env node
/**
 * probe-sdk-runtime.mjs —— **零计费**的端到端：真实 dsh（`--profile novel-sdk`）+ 常驻池 + 假 LLM 端点。
 *
 * ── 它回答什么问题 ────────────────────────────────────────────────────────────
 * 协议取证、"离线假 dsh"测试都证明不了最后一件事：**真实 dsh 到底说不说这套协议、
 * 这个 profile 到底起不起得来、模型输出到底能不能从 `session.event` 里取出来**。
 * 这一步必须用真 dsh 跑，但**不必要花钱**：把 `DEEPSEEK_BASE_URL` 指向本仓库的
 * 假 LLM 端点（`.p1-baseline/fake-llm.mjs`，会真的应答），于是全链路跑通而零出海。
 *
 * ── 通过的前提里必须包含"端点真的被打了" ────────────────────────────────────────
 * 这是本项目用血换来的纪律（2026-09-15 事故：以为死端口=零成本，实际打到生产实例）。
 * 所以判据不是"任务返回了文本"，而是：
 *   ① 假 LLM 的请求计数 ≥1 **且** 返回的正文等于它配置的罐头正文；
 *   ② 否则判失败（哪怕任务"看起来成功"）。
 * 只断言"拿到了文本"会漏掉最危险的形态：任务其实打到了**真实端点**并且成功了。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *   node .p1-baseline/probe-sdk-runtime.mjs            # 跑一次（约 20–60 秒）
 *   node .p1-baseline/probe-sdk-runtime.mjs --keep     # 失败时保留临时数据目录便于排查
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const keep = process.argv.includes('--keep');

// ⚠️ 隔离纪律（docs 的隔离与验证教训 §一）：import harness.js 会连带拉起 logger/db 的
// **模块级副作用**，它们按 NOVELSTUDIO_DATA_DIR 解析数据目录，未设时默认就是项目的 data/。
// 所以必须在**任何 import 之前**把数据目录指到临时目录。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelstudio-sdk-probe-'));
process.env.NOVELSTUDIO_DATA_DIR = dataDir;
process.env.NOVELSTUDIO_OV_DISABLED = '1';
process.env.NOVELSTUDIO_OPENVIKING_PEER_ID = 'sdk-probe';

const { startFakeLLM } = await import(pathToFileURL(path.join(HERE, 'fake-llm.mjs')).href);
const { createSpawnWorker } = await import(pathToFileURL(path.join(REPO, 'ai', 'harness-sdk-worker.mjs')).href);
const { runPromptOnWorker } = await import(pathToFileURL(path.join(REPO, 'ai', 'harness-pool.mjs')).href);
const { harnessRuntimeInfo } = await import(pathToFileURL(path.join(REPO, 'harness.js')).href);
const { harnessChildEnv } = await import(pathToFileURL(path.join(REPO, 'ai', 'harness-env.mjs')).href);

const CANNED = '【成文】这是零成本假端点返回的正文。';
const PROFILE = 'novel-sdk';
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};

/** 包式安装（npm 全局）没有 `scripts.dsh`，只能以 `node <pkg>/lib/bin.js` 启动。 */
function resolvePackagedDshLaunch() {
  const roots = [
    path.join(process.env.APPDATA || '', 'npm-global', 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm-global', 'node_modules'),
  ];
  for (const root of roots) {
    const pkgDir = path.join(root, '@deepseek-ai', 'dsh');
    const bin = path.join(pkgDir, 'lib', 'bin.js');
    if (fs.existsSync(bin)) return { args: [bin], cwd: pkgDir, version: readVersion(pkgDir) };
  }
  return null;
}
function readVersion(pkgDir) {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || '?'; } catch { return '?'; }
}

let llm = null;
let entry = null;
try {
  // 1) 起假 LLM 端点（会真的应答；不落 prompt 原文）
  llm = await startFakeLLM({ port: 0, reply: CANNED, logPath: path.join(dataDir, 'fake-llm.jsonl') });
  console.log(`假 LLM 端点：http://127.0.0.1:${llm.port}（零计费；罐头正文 ${CANNED.length} 字）`);

  // 2) 解析 dsh 实际位置（用**生产代码自己的解析器**，不是这里另写一份）
  const info = harnessRuntimeInfo();
  console.log(`dsh 目录：${info.dir}（来源 ${info.source}，像不像仓库=${info.looks_like_dsh}，已构建=${info.built}）`);
  check('前置：解析到了 dsh 仓库且已构建', info.found && info.looks_like_dsh && info.built, info.dir);
  if (failures) throw new Error('前置不满足，无法继续');

  // 2b) `--npm-dsh`：改用**包式安装**的那一份做对照实验。
  //     动机：源码仓库这份（0.1.1-rc.2）没有 sdk-app bundle，"常驻起不来"到底是
  //     "我的协议/池写错了"还是"这份构建里没这个 bundle"，必须用另一份构建把它分开。
  let launchOverride = null;
  let dirForWorker = info.dir;
  if (process.argv.includes('--npm-dsh')) {
    const pkgLaunch = resolvePackagedDshLaunch();
    if (!pkgLaunch) throw new Error('找不到包式安装的 @deepseek-ai/dsh（--npm-dsh）');
    launchOverride = { args: pkgLaunch.args, cwd: pkgLaunch.cwd };
    dirForWorker = pkgLaunch.cwd;
    console.log(`对照实验：改用**包式安装**的 dsh ${pkgLaunch.version}：${pkgLaunch.cwd}`);
  }

  // 3) 子进程环境走**生产代码自己的**契约（顺带把模型端点指到假端点）
  const env = harnessChildEnv({
    peerId: 'sdk-probe',
    env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`, DEEPSEEK_API_KEY: 'probe-sentinel-key' },
  });
  check('前置：子进程环境确实带上了假端点（否则这次验收毫无意义）',
    env.DEEPSEEK_BASE_URL === `http://127.0.0.1:${llm.port}`, String(env.DEEPSEEK_BASE_URL));

  // 4) 起一条常驻 dsh 并握手
  const spawnWorker = createSpawnWorker({
    harnessDir: dirForWorker,
    profile: PROFILE,
    env,
    readyTimeoutMs: 180000,
    launch: launchOverride,
    log: (lvl, kind, msg) => console.log(`      dsh[${lvl}/${kind}] ${msg}`),
  });
  const t0 = Date.now();
  entry = await spawnWorker({ provider: 'deepseek-official', model: 'deepseek-flash' });
  const bootMs = Date.now() - t0;
  check('常驻 dsh 起得来并完成 initialize 握手', !!entry && !!entry.worker, `耗时 ${bootMs}ms，pid=${entry.pid}`);

  // 5) 发一条任务，从 session.event 里取最终正文
  const sid = 'probe-' + Date.now().toString(36);
  const t1 = Date.now();
  const out = await runPromptOnWorker(entry.worker, {
    sessionId: sid,
    prompt: '请只回复一句话，不要调用任何工具。',
    timeoutMs: 180000,
    onProgress: (line) => console.log(`      进度：${line}`),
  });
  const taskMs = Date.now() - t1;

  // 6) 判据：**端点真的被打了** 且 取回的正文就是罐头正文
  check('假 LLM 端点确实收到了请求（隔离与零计费的自证）', llm.count() >= 1, `端点请求数=${llm.count()}`);
  check('从 session.event 取回的正文与罐头正文一致（全链路跑通）',
    String(out.text || '').includes(CANNED), JSON.stringify(String(out.text || '').slice(0, 120)));

  console.log(`\n耗时：冷启动+握手 ${bootMs}ms，任务 ${taskMs}ms`);
  console.log('端点请求明细：');
  for (const r of llm.requests.slice(0, 5)) console.log(`   ${r.method} ${r.path} model=${r.model} stream=${r.stream} prompt_chars=${r.prompt_chars}`);

  // 7) 复用同一条常驻进程跑第二条任务（这正是"热备池"要的复用能力；会话必须互不串扰）
  const sid2 = sid + '-b';
  const out2 = await runPromptOnWorker(entry.worker, { sessionId: sid2, prompt: '再回一句。', timeoutMs: 180000 });
  check('同一条常驻进程可复用跑第二条任务，且会话互不串扰',
    String(out2.text || '').includes(CANNED) && !String(out2.text || '').includes(String(out.text || '').slice(0, 0) + 'x'),
    JSON.stringify(String(out2.text || '').slice(0, 60)));
} catch (e) {
  failures += 1;
  console.log(`FAIL  探测过程抛错：${e.message}`);
  if (e.stderrTail) console.log(`--- dsh stderr 尾部 ---\n${String(e.stderrTail).slice(-1500)}`);
  if (e.detail) console.log(`--- detail ---\n${JSON.stringify(e.detail).slice(0, 800)}`);
} finally {
  if (entry) { try { entry.dispose(); } catch { /* 忽略 */ } }
  if (llm) { try { await llm.close(); } catch { /* 忽略 */ } }
  // ⚠️ 不调 process.exit：Node 24/Windows 下"用 fetch 打过本地端点再 exit"会触发 libuv 断言
  // （子代理实测的 undici 陷阱）。让进程自然退出即可。--keep 时保留临时数据目录供排查。
  if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  else console.log(`（--keep）临时数据目录：${dataDir}`);
}

console.log(`\n=== ${failures ? failures + ' FAILURES' : 'ALL PASS（零计费）'} ===`);
process.exitCode = failures ? 1 : 0;
