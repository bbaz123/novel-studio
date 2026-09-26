#!/usr/bin/env node
/**
 * probe-harness-tool-loop.mjs —— 零计费验证「模型 → 工具 → 模型」这个循环**真的**跑得起来。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────────────────
 * 慢通道（harness）与直连通道的真正差别不是延迟，而是**工具循环**：读回被预算裁掉的原文、
 * 把提案写回工坊、查事件账本……这些都要求「模型先发起工具调用 → dsh 执行 → 结果回灌 →
 * 模型再作答」。在 2026-09-25 之前，本仓库的假 LLM 端点只会回**正文**，于是这台机器上
 * 没有任何办法证明这个循环是通着的——只能靠读代码推断。这条探针把推断换成证据。
 *
 * ── 它断言什么（四条，缺一不可）────────────────────────────────────────────────
 *   1. 端点收到 **≥2** 条请求：第一轮回工具调用，第二轮才可能收尾；
 *   2. 第一条请求 `tool_turn=true`（我们确实回了工具调用）；
 *   3. 第二条请求 `tool_results≥1`（dsh **执行了**工具并把结果回灌给模型）；
 *   4. 任务最终回复的正文 = 我们第二轮给的罐头文本，且进程正常结束。
 * 另外（可选证据，失败即红）：工具结果里应出现被请求的那个文件名——证明工具**真的执行了**
 * 而不是被策略拒绝后回了错误信息。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────────
 * · 会真的 spawn dsh，因此**必须显式授权**：`NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`；
 * · 自设假端点（本文件内起，端口由内核分配），**零计费、不出海**；
 * · 数据目录用临时目录，绝不指向作者的真实库；
 * · 只打**形状与计数**（条数/字数/工具名/命中与否），不把 prompt 或工具结果正文写进仓库。
 *
 * 用法：
 *   $env:NOVELSTUDIO_ALLOW_HARNESS_SPAWN='1'; node .p1-baseline/probe-harness-tool-loop.mjs
 *   node .p1-baseline/probe-harness-tool-loop.mjs --keep-dump   # 保留落盘原文供人工排查（默认删）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const KEEP_DUMP = process.argv.includes('--keep-dump');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail == null ? '' : `　— ${detail}`}`);
};

if (!process.env.NOVELSTUDIO_ALLOW_HARNESS_SPAWN) {
  console.error('这条探针会真的 spawn dsh。确认隔离后显式授权：NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1');
  process.exit(3);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novelstudio-toolloop-'));
process.env.NOVELSTUDIO_DATA_DIR = dataDir;
process.env.NOVELSTUDIO_OV_DISABLED = '1';
process.env.NOVELSTUDIO_OPENVIKING_PEER_ID = 'tool-loop-probe';

const { startFakeLLM } = await import(pathToFileURL(path.join(HERE, 'fake-llm.mjs')).href);
const { harnessRuntimeInfo } = await import(pathToFileURL(path.join(REPO, 'harness.js')).href);
const { harnessChildEnv } = await import(pathToFileURL(path.join(REPO, 'ai', 'harness-env.mjs')).href);

/** 让"模型"第一轮就调这个工具：只读、零副作用、结果里必然出现文件名（可核对）。 */
const TOOL_NAME = 'glob';
const TOOL_ARGS = { pattern: 'package.json' };
const FINAL_TEXT = '工具循环完成';

const info = harnessRuntimeInfo();
const dumpPath = path.join(dataDir, 'tool-loop-dump.jsonl');
const llm = await startFakeLLM({
  port: 0,
  logPath: path.join(dataDir, 'fake-llm.jsonl'),
  dumpPath,
  reply: '（不该用到这条）',
  replies: [FINAL_TEXT],
  toolCall: { name: TOOL_NAME, arguments: TOOL_ARGS },
});
console.log(`假 LLM 端点：http://127.0.0.1:${llm.port}（零计费，只会回工具名与罐头正文）`);
console.log(`dsh 仓库：${info.dir}`);
console.log(`数据目录：${path.basename(dataDir)}（临时）\n`);

const env = harnessChildEnv({
  peerId: 'tool-loop-probe',
  env: {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`,
    DEEPSEEK_API_KEY: 'tool-loop-probe-sentinel',
  },
});

const PROMPT = '先用工具确认一下当前目录里有没有 package.json，然后用一句话回答。';
const { runHarnessTaskWithProgress } = await import(pathToFileURL(path.join(REPO, 'harness.js')).href);

let reply = '';
let failed = null;
const t0 = Date.now();
try {
  reply = await runHarnessTaskWithProgress(PROMPT, { timeout: 240000, env: { DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY } }, () => {});
} catch (e) {
  failed = e;
}
const totalMs = Date.now() - t0;

// ── 断言 ──────────────────────────────────────────────────────────────────────
const reqs = llm.requests;
console.log('\n端点侧看到的请求序列（形状，不含正文）：');
for (const [i, r] of reqs.entries()) {
  console.log(`  ${i + 1}. path=${r.path} messages=${r.messages_count} prompt=${r.prompt_chars}字 工具轮=${r.tool_turn} 工具结果=${r.tool_results} 工具名=${r.tool_name ?? '—'}`);
}

// ── 自证行：这条会话的模型文本全部由**本机**假端点服务 ─────────────────────────
// 套件总闸（verify-all 第 7 节）要求每条"拿到模型文本"的转录都能被归属；少了这行，
// 零计费的本地假端点会被误判成"真的调了远端模型"（实测假红）。四重自证见
// audit-llm-calls.mjs 的 attributeSyntheticSessions()。即使下面的断言失败也要打这行：
// 总闸问的是"钱有没有花"，不是"探针过没过"。
console.log('SYNTHETIC_MODEL_SESSION ' + JSON.stringify({
  kind: 'local-fake-llm',
  probe: 'probe-harness-tool-loop',
  endpoint: `http://127.0.0.1:${llm.port}`,
  servedRequests: reqs.length,
  toolTurns: reqs.filter((r) => r.tool_turn === true).length,
  finalText: FINAL_TEXT,
  servedFrom: t0,
  servedTo: Date.now(),
}));

check('端点收到 ≥2 条请求（第一轮回工具调用、第二轮收尾）', reqs.length >= 2, `实际 ${reqs.length} 条`);
check('第一条请求是工具轮（我们确实回了 tool_use / tool_calls）', reqs[0]?.tool_turn === true, `tool_turn=${reqs[0]?.tool_turn}`);
check('第二条请求带回了工具结果（dsh 执行了工具并回灌）', (reqs[1]?.tool_results ?? 0) >= 1, `tool_results=${reqs[1]?.tool_results}`);
check('第二轮之后模型能收尾：任务回复等于罐头正文', String(reply).includes(FINAL_TEXT), `reply=${JSON.stringify(String(reply).slice(0, 40))}`);
check('任务正常结束（没有抛错）', !failed, failed ? failed.message : 'ok');

// 工具"真的执行了"的独立证据：工具结果正文里应出现被请求的文件名。
// 只看"是否出现该文件名 + 结果长度"，不打印正文（工具结果可能含仓库内容，不进日志/仓库）。
let dumpText = '';
if (fs.existsSync(dumpPath)) { try { dumpText = fs.readFileSync(dumpPath, 'utf8'); } catch { /* 读不到就按未命中处理 */ } }
const hitToolArtifact = dumpText.includes('package.json');
check('工具结果里确实出现了被请求的文件（不是被策略拒绝后的空结果）', hitToolArtifact,
  hitToolArtifact ? '命中 package.json' : `dump 里未出现（dump 字节数 ${dumpText.length}）`);
check('总耗时在预期量级（<240s；这里只报数不设卡）', totalMs < 240000, `${totalMs}ms`);

await llm.close();
if (!KEEP_DUMP && fs.existsSync(dumpPath)) { try { fs.rmSync(dumpPath, { force: true }); } catch { /* 忽略 */ } }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

const passed = results.filter((r) => r.ok).length;
const failedN = results.length - passed;
console.log(`\n工具循环探针：通过 ${passed} / 失败 ${failedN}`);
if (failedN) {
  console.log('提示：工具执行受 dsh 权限策略约束。若「工具结果」那条红，先看是不是工具被拒绝执行；');
  console.log('      策略拒绝会**照常回灌一条 tool_result**（所以循环断言仍绿），只有这条独立证据能识破。');
  process.exit(1);
}
console.log('结论：模型 → 工具 → 模型的循环在此环境上真实跑通（零计费）。');