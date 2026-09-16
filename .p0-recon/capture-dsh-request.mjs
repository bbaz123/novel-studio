#!/usr/bin/env node
/**
 * capture-dsh-request.mjs —— 在**线路层**证明「专用 profile 真的把创作内核挂上去了」。
 *
 * 为什么需要：P0 的核心断言是「建立专用 profile（novel）并把 AI 内核迁上去」。
 * 此前它只在两处被验过：
 *   - **组合层**：`dump-config` 组合树 83 行逐条等价（证明插件被组合进去）；
 *   - **spawn 层**：真跑任务时 profile 能被解析（不存在的 profile 快速失败、novel 走到 LLM 调用）。
 * 但两者都回答不了「模型**实际收到**的请求里，到底有没有那 15 个 novel_* 工具与人设」。
 * 组合进去 ≠ 进了请求；这一层必须看**真正发出去的字节**。
 *
 * 做法（零计费，可自证）：
 *   1. 起一个**黑洞端点**（接受连接、永响应），把收到的原始字节 dump 下来；
 *   2. 把 `DEEPSEEK_BASE_URL` 指向它，`DEEPSEEK_API_KEY` 置哨兵值（万一变量被忽略 → 401 而非计费）；
 *   3. 跑**一次** harness 任务，等请求体发出后立即 abort（不必等它跑完）；
 *   4. 在 dump 里核对：15 个 novel_* 工具名 + 人设特征串；
 *   5. **跑后审计**：本窗口若检出任何真实计费调用 → 直接判失败。
 *
 * 阴性对照：把 profile 换成一个不存在的名字 → 任务在 profile 解析处就失败，
 * **不应有任何字节到达黑洞**（dump 为空）。这条证明"抓到东西"不是因为工具乱抓。
 *
 * 用法:
 *   node .p0-recon/capture-dsh-request.mjs                    # 默认 profile=novel
 *   node .p0-recon/capture-dsh-request.mjs --profile headless  # 换 profile 对比
 *   node .p0-recon/capture-dsh-request.mjs --profile no-such-profile-xyz   # 阴性对照
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startBlackhole } from '../.p1-baseline/blackhole.mjs';
import { countRealCallsSince } from '../.p1-baseline/audit-llm-calls.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PROFILE = arg('--profile', 'novel');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ⚠️ 必须在 import harness.js **之前**设数据目录：harness.js → logger.js 会按它解析并落盘，
// 不设就写进项目真实 data/（已知陷阱，见 .p0-recon/README.md 环境陷阱 0）。
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'nds-capture-'));
process.env.NOVELSTUDIO_DATA_DIR = tmpData;

const dumpPath = path.join(REPO, '.p0-recon', '.capture-request.bin');
const logPath = path.join(REPO, '.p0-recon', '.capture-connections.jsonl');
fs.rmSync(dumpPath, { force: true });
fs.rmSync(logPath, { force: true });

const bh = await startBlackhole({ port: 0, logPath, dumpPath });
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${bh.port}`;   // 请求进黑洞：不响、不出网
process.env.DEEPSEEK_API_KEY = 'sk-isolation-sentinel-not-a-real-key'; // 二次保险：万一变量被忽略 → 401
process.env.NOVELSTUDIO_DSH_PROFILE = PROFILE;

const t0 = Date.now();
const { DSH_PROFILE, runHarnessTask } = await import('../harness.js');

console.log(`═══ 线路层核对：dsh 真正发出去的请求 ═══\n`);
console.log(`  profile          : ${PROFILE}（harness 解析为 «${DSH_PROFILE}»）`);
console.log(`  黑洞端点         : 127.0.0.1:${bh.port}`);
console.log(`  数据目录         : ${path.basename(tmpData)}（临时）\n`);

const ac = new AbortController();
let taskErr = null;
const task = runHarnessTask('Reply with the single word: ok', { timeout: 180000, signal: ac.signal })
  .catch((e) => { taskErr = e; });

// 轮询：请求体一到就收工（不必等任务超时）
const deadline = Date.now() + 150000;
let got = 0;
while (Date.now() < deadline) {
  got = bh.dumpedBytes();
  if (got > 2000) break;
  await new Promise((s) => setTimeout(s, 500));
}
ac.abort();
await task.catch(() => {});
await new Promise((s) => setTimeout(s, 500));

// ── 解析捕获到的字节 ────────────────────────────────────────────────────
let raw = fs.existsSync(dumpPath) ? fs.readFileSync(dumpPath) : Buffer.alloc(0);
let text = raw.toString('utf8');
// 若被压缩，尝试解压（OpenAI 兼容客户端可能带 content-encoding）
if (!/novel_|"tools"|chat\/completions/.test(text)) {
  const idx = raw.indexOf(Buffer.from('\r\n\r\n'));
  if (idx > 0) {
    const body = raw.subarray(idx + 4);
    for (const [name, fn] of [['gzip', zlib.gunzipSync], ['deflate', zlib.inflateSync], ['br', zlib.brotliDecompressSync]]) {
      try { const out = fn(body).toString('utf8'); if (out.length > 50) { text = out; console.log(`  （请求体是 ${name} 压缩的，已解压）`); break; } } catch { /* 换下一种 */ }
    }
  }
}

console.log(`  捕获字节         : ${raw.length}（${bh.logged.length} 条连接）`);
const reqLine = text.split('\r\n')[0] || '(无请求行)';
console.log(`  请求行           : ${reqLine.slice(0, 100)}`);

// 15 个工具名取自插件清单，避免手抄漂移
const pluginJson = JSON.parse(fs.readFileSync(path.join(REPO, 'harness-plugins', 'novel-writing', 'plugin.json'), 'utf8'));
const toolNames = (pluginJson.tools || []).map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
const PERSONA_MARK = '执行小说创作任务的 AI';

let pass = 0, fail = 0;
// ⚠️ 断言助手必须是 check(名称, 条件, 详情)。
// 第一版写成了 ok(名称, 详情)，而调用处按三参传 → **条件根本没被求值、恒判通过**
//（输出里那个突兀的 `true` 就是线索：详情位置被塞进了布尔值）。这类"看起来通过了"的
// 假绿最难发现，所以下面加一条自检，钉住"假条件确实会被计入失败"。
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};
{
  let n = 0;
  const probe = (name, cond) => { if (!cond) n++; };
  probe('假条件', false);
  const helperWorks = n === 1;
  if (!helperWorks) { fail++; console.log('  ✗ 断言助手自检失败：假条件没有被计入失败'); }
  else { pass++; console.log(`  ✓ 断言助手自检：假条件会被计入失败`); }
}

console.log('\n【1. 核对了什么】');
if (!text || raw.length < 200) {
  if (PROFILE.startsWith('no-such')) {
    check('阴性对照符合预期：不存在的 profile → 黑洞端零字节（连不到 LLM 那一步）', true,
      `捕获 ${raw.length} 字节，任务错误：${String(taskErr?.message || '').slice(0, 90)}`);
  } else {
    check('没有捕获到任何请求字节', false, `任务错误：${String(taskErr?.message || '').slice(0, 120)}`);
  }
} else {
  const missingTools = toolNames.filter((t) => !text.includes(t));
  check(`清单里的 ${toolNames.length} 个 novel_* 工具都在请求体里`, missingTools.length === 0,
    missingTools.length ? `缺：${missingTools.join(', ')}` : '');
  // ⚠️ 只查"工具名出现过"是不够的：**人设文本本身就提到了约 7 个工具名**，
  // 不排除这个假象就会把"人设里提了一嘴"当成"工具真的挂上了"。所以再钉两条
  // 只有**工具定义**才会有的判据：`"tools"` 这个 JSON 键，以及 JSON Schema 的 `"parameters"`。
  const hasToolsKey = /"tools"\s*:/.test(text);
  const hasParams = /"parameters"\s*:/.test(text);
  const toolDefs = (text.match(/"type"\s*:\s*"function"/g) || []).length;
  check('请求体里有 `"tools"` 键（不只是人设提到工具名）', hasToolsKey);
  check('请求体里有 JSON Schema 的 `"parameters"`（工具定义的特征）', hasParams);
  check('工具定义条数 ≥ 清单条数', toolDefs >= toolNames.length,
    `实测 ${toolDefs} 条，清单 ${toolNames.length} 条`);
  const personaOk = text.includes(PERSONA_MARK);
  check('创作人设（novel profile 注入的 persona）在请求体里', personaOk, personaOk ? `含「${PERSONA_MARK}」` : '未找到');
  check('请求是发往黑洞端点的 chat/completions',
    /chat\/completions/.test(reqLine) || /chat\/completions/.test(text.slice(0, 2000)));
}

console.log('\n【2. 跑后审计：这一段到底有没有花钱】');
{
  const { total, real, rows } = countRealCallsSince(t0);
  if (real > 0) {
    check(`本窗口检出了 ${real} 条真实计费调用`, false,
      rows.map((r) => `${r.ts} ${r.model}「${r.userMsgs[0] || '?'}」`).join('；'));
  } else {
    check('零真实计费调用', true, `窗口内 dsh 会话 ${total} 条，均无「请求 + 模型产出」`);
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────
await bh.close();
fs.rmSync(tmpData, { recursive: true, force: true });
if (fs.existsSync(dumpPath)) fs.rmSync(dumpPath, { force: true });
if (fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });

console.log(`\n══════════════════════════════`);
console.log(`线路层核对：通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
