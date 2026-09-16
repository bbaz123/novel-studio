#!/usr/bin/env node
/**
 * verify-harness-gate.mjs —— 并发闸门验证（P4 遗留修复的验收）。
 *
 * 被验证的行为：闸门是「防止刷出大量 dsh 子进程拖垮机器」。修复前只有 `/harness/run`
 * 被计数，两条直接跑 harness 的路由（`/harness/generate_novel`、`/story_memory/compress`）
 * **完全绕过**它；修复后它们也要占槽位。
 *
 * ⚠️⚠️ 这个检查会**真的创建 harness 任务**，因此**默认拒绝运行**。
 * 2026-09-15 事故：作者曾以为「把 DEEPSEEK_BASE_URL 指向死端口 = 零成本」，
 * 结果多轮"零成本"验证实际产生了真实 LLM 调用（证据见
 * `.p1-baseline/audit-llm-calls.mjs`），其中一次还写进了生产 OpenViking 记忆库。
 * 所以本脚本设了三道闸：
 *   1. **前置闸**：必须显式设置 `NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1`，否则 exit 2；
 *   2. **断言闸**：429 必须**带闸门自己的文案**才算通过——上游 provider 的 429
 *      也会被路由映射成 429，只断言状态码会把「被限流」误判成「被闸门拦住」；
 *   3. **跑后闸**：跑完自动审计本次窗口内是否产生真实 LLM 调用，有则判**失败**——
 *      把「悄悄花钱」变成红灯；
 *   4. **证明闸**（`--require-blackhole <port>`）：要求黑洞端点**确实收到本次连接**，
 *      并核对测试指向的实例就是隔离启动器登记的那个。没有它，「通过」不构成隔离证明。
 *
 * 另外：「槽位已满」是**有寿命**的前置条件。作业一旦结束，后续请求被放行是**合法**的，
 * 不是代码缺陷；所以每条断言前都要重新占满槽位，占不住就**失败关闭**（不是判过）。
 *
 * 推荐用法（一条命令搭环境，见 `gate-env.mjs`）:
 *   node .p1-baseline/gate-env.mjs                 # 起黑洞端点 + 隔离实例（前台）
 *   $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
 *   node .p1-baseline/verify-harness-gate.mjs http://127.0.0.1:<port> --require-blackhole <黑洞端口>
 */
import { countRealCallsSince } from './audit-llm-calls.mjs';
import { readBlackholeLog } from './blackhole.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GATE_LIMIT = 2;
export const GATE_MESSAGE_KEY = '已有任务运行中';

/**
 * 判定一次 429 是否**确实来自闸门**。
 * 只有状态码不够：`server.js` 的路由把上游错误也映射成 429
 * （`e.status === 429 ? 429 : …`），所以必须校验闸门自己的文案与并发上限数字。
 */
export function isGateRejection(status, bodyText, limit = GATE_LIMIT) {
  if (Number(status) !== 429) return false;
  const s = String(bodyText || '');
  if (!s.includes(GATE_MESSAGE_KEY)) return false;
  return new RegExp(`并发上限\\s*${limit}`).test(s);
}

/**
 * 对一次「期望被拦」的探测做裁决。**纯函数**，便于离线做阴性对照。
 *
 * @returns {{verdict:'pass'|'fail'|'retry', reason:string}}
 */
export function classifyBlockedProbe({ status, body, limit = GATE_LIMIT, loadBefore, hung = false }) {
  if (hung) {
    return { verdict: 'fail', reason: '请求挂起：它没有被拦住，真的开始跑了' };
  }
  // 前置条件本身不成立 —— 槽位在调用前就没满，放行是合法的，本轮不可判。
  if (loadBefore < limit) {
    return { verdict: 'retry', reason: `调用前只占住 ${loadBefore}/${limit} 个槽位，前置条件不成立` };
  }
  if (Number(status) === 429) {
    if (isGateRejection(status, body, limit)) return { verdict: 'pass', reason: '被闸门拦截' };
    // 槽位满、却收到一个「不是闸门文案」的 429：无法区分是闸门漏拦还是上游限流，
    // 不能判过（失败关闭），只能重试。
    return { verdict: 'retry', reason: `429 但不是闸门文案（疑似上游限流）：${String(body || '').slice(0, 80)}` };
  }
  return { verdict: 'fail', reason: `槽位已满却放行（status=${status}）：${String(body || '').slice(0, 80)}` };
}

/** 判定一次「空载期望放行」的探测是否成立（闸门不该在空载时拦人）。 */
export function classifyIdleProbe({ status, body, limit = GATE_LIMIT }) {
  if (isGateRejection(status, body, limit)) {
    return { verdict: 'fail', reason: '空载时闸门拦了请求（计数泄漏或上限算错）' };
  }
  return { verdict: 'pass', reason: `空载未被闸门拦（status=${status}）` };
}

/** 从 base url 里取端口，用于与启动器登记的端口核对。 */
export function portOfBase(baseUrl) {
  try { return Number(new URL(baseUrl).port) || 80; } catch { return NaN; }
}

/**
 * 环境吻合闸：测试指向的实例，必须就是隔离启动器登记的那个。
 * 这一条直接针对 2026-09-15 事故的根因之一——测试打到了另一个不受控的实例。
 */
export function classifyEnvMatch(marker, baseUrl) {
  if (!marker) return { verdict: 'fail', reason: '找不到隔离环境 marker（未用 gate-env.mjs 启动？）' };
  const want = portOfBase(baseUrl);
  if (Number(marker.port) !== want) {
    return { verdict: 'fail', reason: `测试指向端口 ${want}，但登记的隔离实例在 ${marker.port} —— 打错实例了` };
  }
  return { verdict: 'pass', reason: `实例端口吻合（${want}，数据目录 ${marker.dataDir}）` };
}

/**
 * 黑洞证明闸：只有当黑洞端点**确实收到本次连接**时，"通过"才成立。
 * 这是唯一能证明「LLM 流量走了隔离端点」的证据；没有它就只能失败关闭。
 */
export function classifyBlackholeProof(connections, required = 1) {
  if (Array.isArray(connections) && connections.length >= required) {
    return { verdict: 'pass', reason: `黑洞端点收到 ${connections.length} 条连接（首字节可取证）` };
  }
  return {
    verdict: 'fail',
    reason: '黑洞端点未收到任何连接 —— 无法证明 LLM 流量走了隔离端点'
      + '（很可能 DEEPSEEK_BASE_URL 未生效）。失败关闭。',
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const BASE = process.argv[2] || '';
const argVal = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
};
/** --require-blackhole <port>：要求黑洞端点收到本次连接，否则失败关闭。 */
const REQUIRE_BLACKHOLE = argVal('--require-blackhole');
const CALL_TIMEOUT_MS = 8000;   // 期望被拦的调用必须**很快**返回；挂起即证明没拦住
const DEFAULT_TIMEOUT_MS = 60000;

async function api(method, p, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function jobStatus(id) {
  try {
    const r = await api('GET', `/api/harness/job?id=${encodeURIComponent(id)}`);
    const j = JSON.parse(r.text);
    return (j.status || j.job?.status || 'unknown');
  } catch { return 'unknown'; }
}

const LIVE_STATES = ['queued', 'running'];

/** 占住槽位：不足就补作业，直到达到上限或超时。返回实际占住的数量。 */
async function ensureSlotsFull(jobs, { budgetMs = 20000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const liveCount = async () => {
    let n = 0;
    for (const id of jobs) if (LIVE_STATES.includes(await jobStatus(id))) n++;
    return n;
  };
  let live = await liveCount();
  while (live < GATE_LIMIT && Date.now() < deadline) {
    const r = await api('POST', '/api/harness/run', { prompt: 'Reply with the single word: ok', timeout: 120000 });
    if (r.status === 202) {
      try { const j = JSON.parse(r.text); if (j.job_id) jobs.push(j.job_id); } catch { /* 忽略 */ }
    } else if (isGateRejection(r.status, r.text, GATE_LIMIT)) {
      // 收到闸门 429 说明**别的**作业正占着槽位（不是我们记录的）——等一会儿再数。
      await new Promise((s) => setTimeout(s, 1500));
    } else {
      await new Promise((s) => setTimeout(s, 1000));
    }
    live = await liveCount();
  }
  return live;
}

// ── 预检模式：不创建任何作业，只验证「环境是否值得授权」──────────────────
// 目的是把事故的两个根因（打错实例、隔离没生效）在**花钱之前**就暴露出来。
// 它不需要 NOVELSTUDIO_GATE_CONFIRMED_ISOLATED —— 预检本身就是用来决定要不要授权的。
async function preflight() {
  const t0 = Date.now();
  let bad = 0;
  const line = (v, name, reason = '') => {
    const mark = v === 'pass' ? '✓' : '✗';
    if (v !== 'pass') bad++;
    console.log(`  ${mark} ${name}${reason ? '  — ' + reason : ''}`);
  };
  console.log(`预检目标：${BASE}\n`);

  console.log('【1. 实例可达性】');
  {
    const r = await api('GET', '/api/works').catch(() => null);
    line(r && r.status === 200 ? 'pass' : 'fail', '实例可达且 /api/works 正常',
      r ? `status=${r.status}` : '连接失败');
  }

  console.log('\n【2. 空载不应被闸门拦（顺带确认闸门文案格式在位）】');
  {
    const r = await api('POST', '/api/story_memory/compress', { work_id: 999999 }).catch(() => null);
    if (!r) line('fail', '空载 compress 探测', '连接失败');
    else {
      const d = classifyIdleProbe({ status: r.status, body: r.text });
      line(d.verdict, '空载 compress 未被闸门拦（应为 404）', d.reason);
    }
  }

  console.log('\n【3. 指向的实例是否就是隔离启动器登记的那个】');
  if (!REQUIRE_BLACKHOLE) {
    console.log('  – 未传 --require-blackhole，跳过（此时「通过」不构成隔离证明）');
  } else {
    const markerPath = path.join('.p1-baseline', 'gate-env.json');
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { /* 由判定函数报 */ }
    const d = classifyEnvMatch(marker, BASE);
    line(d.verdict, '测试指向的实例与 marker 一致', d.reason);

    console.log('\n【4. 黑洞端点是否真的在监听且永不响应】');
    const bhUp = await new Promise((resolve) => {
      const s = net.connect(Number(REQUIRE_BLACKHOLE), '127.0.0.1');
      let bytes = 0;
      s.on('data', (x) => { bytes += x.length; });
      s.once('connect', () => {
        s.write('POST /chat/completions HTTP/1.1\r\nHost: preflight\r\n\r\n');
        setTimeout(() => { s.destroy(); resolve({ ok: true, bytes }); }, 1200);
      });
      s.once('error', () => resolve({ ok: false, bytes: 0 }));
    });
    line(bhUp.ok ? 'pass' : 'fail', `黑洞端点 ${REQUIRE_BLACKHOLE} 可连接`, bhUp.ok ? '' : '连接失败');
    if (bhUp.ok) line(bhUp.bytes === 0 ? 'pass' : 'fail', '黑洞端点未回写任何字节', `收到 ${bhUp.bytes} 字节`);
    console.log(`  （预检自身会产生 1 条黑洞连接记录；正式运行按 t0 过滤，不会混入证明）`);
  }

  console.log(`\n预检耗时 ${Date.now() - t0}ms，${bad ? `发现 ${bad} 处问题` : '全部通过'}。`);
  if (bad) {
    console.log('✗ 预检未通过：不要授权正式运行。');
    process.exitCode = 1;
  } else {
    console.log('✓ 预检通过。授权并运行正式验证：');
    console.log(`  $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'`);
    console.log(`  node .p1-baseline/verify-harness-gate.mjs ${BASE}`
      + (REQUIRE_BLACKHOLE ? ` --require-blackhole ${REQUIRE_BLACKHOLE}` : ''));
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
// ⚠️ 必须比较 argv[1] 的 file URL，不能用 `import.meta.url.endsWith(文件名)`：
// 后者在被 import 时同样为真，会让「导入本模块做离线断言测试」变成「真的去跑任务」。
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (!BASE) {
    console.error('用法: node .p1-baseline/verify-harness-gate.mjs <base-url> [--require-blackhole <port>] [--preflight]');
    process.exit(2);
  }
  // 预检：不创建任何作业、不需要授权。用来在花钱之前判断环境是否可信。
  if (process.argv.includes('--preflight')) {
    await preflight();
    // ⚠️ 必须在这里结束。第一版忘了 exit，预检跑完**穿透**进了正式流程：
    // 既建了作业，又因为走的是 if 分支而**绕过了授权闸**。
    // 是「跑后审计 + 证明闸」把这件事如实报出来的（两条都为通过，所以没造成计费）。
    process.exit(process.exitCode || 0);
  } else if (process.env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED !== '1') {
    console.error(`拒绝运行：这个检查会真的创建 harness 任务。

2026-09-15 事故：曾以为把 DEEPSEEK_BASE_URL 指向死端口就是零成本，结果产生了
未经批准的真实 LLM 调用。所以在**证明隔离成立之前**，本脚本默认不跑。

请先把目标实例搭成可证明的隔离环境（建议：用一个只记连接、永不响应的
"黑洞"端口作为 LLM 端点，作业会长时间占槽且不出网），并在确认后显式授权：

  $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
  node .p1-baseline/verify-harness-gate.mjs ${BASE || '<base-url>'}

隔离是否真的成立，跑完会由本脚本自己审计（见输出末段）。`);
    process.exit(2);
  }

  const t0 = Date.now();
  let pass = 0;
  const fails = [];
  const check = (name, verdict, reason) => {
    if (verdict === 'pass') { pass++; console.log(`  ✓ ${name}`); }
    else { fails.push({ name, reason }); console.log(`  ✗ ${name}${reason ? '  — ' + reason : ''}`); }
  };

  console.log(`目标实例：${BASE}`);
  console.log(`闸门上限：${GATE_LIMIT}（断言以响应体文案为准，不只看状态码）\n`);

  // 1) 空载：用不存在的作品打 compress，应为 404，**不应**是闸门 429
  console.log('【空载】');
  {
    const r = await api('POST', '/api/story_memory/compress', { work_id: 999999 });
    const d = classifyIdleProbe({ status: r.status, body: r.text });
    check('空载时 compress 不被闸门拦（应为 404，而非 429）', d.verdict, d.reason);
  }

  // 2) 占满槽位，逐条断言旁路与第三个作业
  console.log('\n【槽位占满后】');
  const created = await api('POST', '/api/works', {
    title: '闸门验证·临时作品', description: '验证并发闸门，用完即删',
  });
  let wid = null;
  try { wid = JSON.parse(created.text)?.id ?? JSON.parse(created.text)?.work_id; } catch { /* 忽略 */ }
  check('创建临时作品', wid ? 'pass' : 'fail', wid ? '' : `status=${created.status} body=${created.text.slice(0, 80)}`);

  const jobs = [];
  {
    const live = await ensureSlotsFull(jobs);
    check(`占满 ${GATE_LIMIT} 个槽位`, live === GATE_LIMIT ? 'pass' : 'fail',
      live === GATE_LIMIT ? '' : `只占住 ${live} 个；若目标实例指向真实 LLM，作业会秒退，`
        + `此时**无法**验证闸门——请改用不会失败的端点（如黑洞端口）`);
  }

  /** 期望被拦的调用：每条之前都重新占满槽位，占不住就失败关闭。 */
  async function expectBlocked(name, method, p, body) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const live = await ensureSlotsFull(jobs);
      if (live < GATE_LIMIT) {
        check(name, 'fail', `无法维持占槽窗口（${live}/${GATE_LIMIT}），本条无法判定——失败关闭`);
        return;
      }
      let r = null, hung = false;
      try {
        r = await api(method, p, body, CALL_TIMEOUT_MS);
      } catch { hung = true; }
      const d = classifyBlockedProbe({
        status: r?.status, body: r?.text, loadBefore: live, hung,
      });
      if (d.verdict === 'pass') { check(name, 'pass'); return; }
      if (d.verdict === 'fail') { check(name, 'fail', d.reason); return; }
      if (attempt === 3) { check(name, 'fail', `重试 3 次仍不可判：${d.reason}`); return; }
      console.log(`    …重试（${d.reason}）`);
    }
  }

  if (wid) {
    await expectBlocked('槽位满时 compress 被闸门拦（429 + 闸门文案）', 'POST', '/api/story_memory/compress', { work_id: wid });
    await expectBlocked('槽位满时 generate_novel 被闸门拦（429 + 闸门文案）', 'POST', '/api/harness/generate_novel', { prompt: '测试' });
    await expectBlocked('槽位满时第三个 /harness/run 被拦（429 + 闸门文案）', 'POST', '/api/harness/run', { prompt: '第三个作业' });
  }

  // 3) 作业结束后槽位应释放（计数不泄漏）
  console.log('\n【作业结束后】');
  {
    const deadline = Date.now() + 240000;
    for (const id of jobs) {
      let status = 'running';
      while (Date.now() < deadline) {
        status = await jobStatus(id);
        if (!LIVE_STATES.includes(status) && status !== 'unknown') break;
        await new Promise((s) => setTimeout(s, 3000));
      }
      check(`作业 ${id} 已进入终态`, LIVE_STATES.includes(status) ? 'fail' : 'pass',
        LIVE_STATES.includes(status) ? `仍为 ${status}` : `最终 status=${status}`);
    }
    const r = await api('POST', '/api/story_memory/compress', { work_id: 999999 });
    const d = classifyIdleProbe({ status: r.status, body: r.text });
    check('作业结束后闸门放行（槽位已释放）', d.verdict, d.reason);
  }

  if (wid) await api('DELETE', `/api/works/${wid}`);

  // 4) 跑后闸：本次窗口内是否产生了真实 LLM 调用
  console.log('\n【跑后审计：本次是否真的花钱了】');
  {
    const { total, real, rows } = countRealCallsSince(t0);
    if (real > 0) {
      check('本次运行未产生真实 LLM 调用', 'fail',
        `窗口内检出 ${real} 条真实调用（会话共 ${total} 条）：`
        + rows.map((r) => `${r.ts} ${r.model} 「${r.userMsgs[0] || '?'}」`).join('；'));
    } else {
      check('本次运行未产生真实 LLM 调用', 'pass', '');
    }
  }

  // 5) 证明闸：只有黑洞端点真的收到流量，「通过」才成立
  if (REQUIRE_BLACKHOLE) {
    console.log('\n【证明闸：LLM 流量是否真的进了黑洞端点】');
    const markerPath = path.join('.p1-baseline', 'gate-env.json');
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { /* 缺 marker 由判定函数报错 */ }
    {
      const d = classifyEnvMatch(marker, BASE);
      check('测试指向的实例与隔离启动器登记的一致', d.verdict, d.reason);
    }
    {
      const logPath = marker?.blackholeLog || '';
      const conns = readBlackholeLog(logPath, t0);
      const d = classifyBlackholeProof(conns);
      check(`黑洞端点收到本次连接（端口 ${REQUIRE_BLACKHOLE}）`, d.verdict,
        d.reason + (conns.length
          ? `；取证：${conns.map((c) => `「${String(c.firstBytes || '(无数据)').slice(0, 50)}」`).join(' ')}`
          : `（日志 ${logPath || '未登记'}）`));
    }
  } else {
    console.log('\n（未传 --require-blackhole：跳过证明闸，本次「通过」不构成隔离证明）');
  }

  console.log(`\n══════════════════════════════`);
  console.log(`并发闸门验证：通过 ${pass} / 失败 ${fails.length}`);
  for (const f of fails) console.log(`  · ${f.name}${f.reason ? '  — ' + f.reason : ''}`);
  process.exitCode = fails.length ? 1 : 0;
}
