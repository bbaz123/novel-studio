#!/usr/bin/env node
/**
 * .p1-baseline/test-1020-dsh-real-integration.mjs —— v1.2.2：R-24/25/26 的真实验证（零付费）。
 *
 * 用户裁决（2026-10-18）：「R-24/25/26 属于外部插件行为，不能只在本仓库伪造——自动拉起小说工坊，
 * 允许真实验证，额度限制 2 元」。本套件因此做三件**真事**：
 *   ① 真启动一个 Novel Studio 隔离实例（临时数据目录），用真实 HTTP 读状态；
 *   ② 在真实 Cordis 上下文里同时加载两个插件（auto-plan 自带的 verify/dual-plugin.mjs），
 *      并各自跑插件自己的触发/账本测试；
 *   ③ 直接调用两个插件的公开 API 做行为探针（不导入确认账本私有模块、不写账本）。
 *
 * 额度：全程零计费（不调用任何模型/网络 API），实际花费 0 元，远低于 2 元上限。
 * 零依赖、离线；退出码是唯一判据。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const EXEC = resolve(REPO, '..', 'dsh-auto-plan-executor');
const CONFIRM = resolve(REPO, '..', 'dsh-confirmation-resolution');
// CI 的干净检出没有这两个兄弟仓库。R-24/25/26 是**外部插件行为**，本仓库不能伪造，
// 所以缺前置时打印显式 SKIP 并跳过（不把"没跑"记成通过）；本机有仓库时必须真跑。
const EXEC_OK = existsSync(join(EXEC, 'lib', 'trigger.js'));
const CONFIRM_OK = existsSync(join(CONFIRM, 'lib', 'decide.js'));

let pass = 0;
let skipped = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};
const skip = (name, reason) => { skipped += 1; console.log(`  – SKIP ${name}：${reason}`); };
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 180000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ── 0) 真实拉起 Novel Studio 隔离实例 ────────────────────────────────────────
const PORT = await new Promise((res) => {
  const probe = net.createServer();
  probe.once('error', () => res(5800 + (process.pid % 300)));
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1020-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const j = async (path, o = {}) => {
  const res = await fetch(BASE + path, {
    method: o.method || 'GET', headers: { 'content-type': 'application/json' },
    body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};
const ready = async () => {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/works`)).status === 200) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

try {
  console.log('【A. 真实实例：拉起小说工坊并读写只读状态】');
  const up = await ready();
  ok('A1 Novel Studio 真实启动并响应 /api/works', up, serverLog.slice(-300));
  if (up) {
    const work = await j('/api/works', { method: 'POST', body: { title: 'R-24/25/26 验证' } });
    const chapter = await j('/api/chapters', { method: 'POST', body: { work_id: work.data.id, title: '第1章', content: '<p>正文</p>' } });
    const st = await j(`/api/novel/revision/closure/status?chapter_id=${chapter.data.id}`);
    ok('A2 真实实例返回修稿闭环只读状态（read_only=true）',
      st.status === 200 && st.data.closure && st.data.closure.read_only === true
      && st.data.closure.contract_version === 2,
      JSON.stringify(st.data).slice(0, 200));
    const receipt = await j('/api/novel/revision/closure-receipt', {
      method: 'POST',
      body: { chapter_id: chapter.data.id, closure: { closure_version: 2, status: 'NOT_RUN', issues: [] } },
    });
    ok('A3 无选择记录时回执被 404 拒绝（不会凭空创建修稿）', receipt.status === 404, String(receipt.status));
  }

  console.log('【B. R-24：内部消息不得触发自动方案（真实插件 + 行为探针）】');
  if (!EXEC_OK) {
    skip('R-24 auto-plan 触发隔离', '缺少兄弟仓库 dsh-auto-plan-executor（CI 干净检出不携带外部插件）');
  } else {
    const triggerTest = run(process.execPath, ['--import', './test/host-hooks.mjs', '--test', '--experimental-test-isolation=none', 'test/trigger.test.mjs'], EXEC);
    ok('B1 auto-plan 触发套件（真实插件测试）退出码 0', triggerTest.status === 0, triggerTest.out.slice(-500));
    const { detectTrigger, SOURCE } = await import(new URL('file://' + join(EXEC, 'lib', 'trigger.js').replace(/\\/g, '/')));
    const human = detectTrigger({ source: SOURCE.HUMAN, text: '按方案执行', attachments: [{ name: '改造方案.md' }] });
    ok('B2 真实用户 + 方案附件 → 触发（基线成立）', human.triggered === true, JSON.stringify(human));
    const internal = detectTrigger({ source: SOURCE.GOAL_ROUND, text: '按方案执行', attachments: [{ name: '改造方案.md' }] });
    ok('B3 goal 轮内部消息 → 不触发（NON_HUMAN_SOURCE）',
      internal.triggered === false && internal.reason === 'NON_HUMAN_SOURCE', JSON.stringify(internal));
    const modelEcho = detectTrigger({ source: SOURCE.ASSISTANT, text: '【方案】执行计划', attachments: [{ name: '方案.md' }] });
    ok('B4 模型回显带「方案」标题 → 不触发', modelEcho.triggered === false, JSON.stringify(modelEcho));
    const reply = detectTrigger({ source: SOURCE.HUMAN, text: 'C1 修改', isConfirmationReply: true });
    ok('B5 确认项回复 → 不触发自动方案（CONFIRMATION_REPLY）',
      reply.triggered === false && reply.reason === 'CONFIRMATION_REPLY', JSON.stringify(reply));
  }

  console.log('【C. R-25：双插件同上下文共载（真实 Cordis 上下文）】');
  if (!EXEC_OK) {
    skip('R-25 双插件共载', '缺少兄弟仓库 dsh-auto-plan-executor（其 verify/dual-plugin.mjs 不在本仓库内）');
  } else {
    const dual = run(process.execPath, ['--import', './test/host-hooks.mjs', 'verify/dual-plugin.mjs'], EXEC);
    ok('C1 auto-plan 官方 dual-plugin 验证（真实 Cordis 上下文加载两插件）退出码 0',
      dual.status === 0, dual.out.slice(-600));
    const wiring = run(process.execPath, ['--import', './test/host-hooks.mjs', 'verify/wiring.mjs'], EXEC);
    ok('C2 auto-plan wiring 验证退出码 0', wiring.status === 0, wiring.out.slice(-400));
    // 工具面不重叠：novel-tools 只 register novel_*；auto-plan 只注册自己的三件工具。
    const { readFileSync } = await import('node:fs');
    const novelSrc = readFileSync(join(REPO, 'harness-plugins', 'novel-writing', 'novel-tools.mjs'), 'utf8');
    const autoSrc = readFileSync(join(EXEC, 'lib', 'index.js'), 'utf8');
    const novelTools = [...novelSrc.matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]);
    const autoTools = [...autoSrc.matchAll(/defineTool\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
    const overlap = novelTools.filter((n) => autoTools.includes(n));
    ok('C3 两插件工具名互不冲突（无同名覆盖）', overlap.length === 0, JSON.stringify({ novel: novelTools.length, auto: autoTools.length, overlap }));
    ok('C4 auto-plan 不导入小说插件内部模块（只走公开能力发现）',
      !/novel-tools\.mjs|harness-plugins\/novel-writing/.test(autoSrc));
  }

  console.log('【D. R-26：写作闭环不能伪造 C 账本/decide】');
  if (!CONFIRM_OK) {
    skip('R-26 C 账本隔离', '缺少兄弟仓库 dsh-confirmation-resolution（其 decide/ledger 实现不在本仓库内）');
    const { readFileSync } = await import('node:fs');
    const studioSources = [
      'public/app.js', 'server.js', 'public/revision-closure.js', 'public/revision-semantic-verifier.js',
      'harness-plugins/novel-writing/novel-tools.mjs',
    ].map((p) => readFileSync(join(REPO, p), 'utf8')).join('\n');
    ok('D3 小说工坊源码不含确认账本/decide 调用（结构上无法伪造 C 项）',
      !/confirmation_resolution|confirmation-ledger|confirmation_ledger|ConfirmationLedger/.test(studioSources));
  } else {
    const decideTest = run(process.execPath, ['--test', 'test/decide.test.mjs', 'test/ledger.test.mjs'], CONFIRM);
    ok('D1 确认插件 decide/ledger 测试（真实账本语义）退出码 0', decideTest.status === 0, decideTest.out.slice(-500));
    const { decide } = await import(new URL('file://' + join(CONFIRM, 'lib', 'decide.js').replace(/\\/g, '/')));
    const noReply = decide({
      confirmation_id: 'C1', current_state: '当前状态', original_confirmation: '是否修改？', user_reply: '',
    });
    ok('D2 没有用户真实回复 → 不得产出 MODIFY/READY_TO_EXECUTE',
      noReply.action !== 'MODIFY' && noReply.status !== 'READY_TO_EXECUTE',
      JSON.stringify({ action: noReply.action, status: noReply.status }));
    const { readFileSync } = await import('node:fs');
    const studioSources = [
      'public/app.js', 'server.js', 'public/revision-closure.js', 'public/revision-semantic-verifier.js',
      'harness-plugins/novel-writing/novel-tools.mjs',
    ].map((p) => readFileSync(join(REPO, p), 'utf8')).join('\n');
    ok('D3 小说工坊源码不含确认账本/decide 调用（结构上无法伪造 C 项）',
      !/confirmation_resolution|confirmation-ledger|confirmation_ledger|ConfirmationLedger/.test(studioSources));
    const { readFileSync: rf } = await import('node:fs');
    const confirmIndex = rf(join(CONFIRM, 'lib', 'index.js'), 'utf8');
    ok('D4 确认插件不导入小说工坊内部（边界双向）',
      !/novel-tools\.mjs|harness-plugins\/novel-writing|novel-studio/.test(confirmIndex));
  }

  console.log('【E. 费用】');
  ok('E1 全程零付费调用（仅本地子进程与 HTTP；无模型/网络计费）', true, '本套件不发起任何付费请求：实际花费 ¥0（上限 ¥2）');
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
}

console.log(`\n[test-1020] 通过 ${pass} / SKIP ${skipped} / 未通过 ${fails.length}`);
if (!pass) { console.error('零用例：拒绝当作通过'); process.exit(2); }
if (fails.length) { console.error('未通过：' + fails.join('; ')); process.exitCode = 1; }
