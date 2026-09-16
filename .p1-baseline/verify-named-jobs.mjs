#!/usr/bin/env node
/**
 * verify-named-jobs.mjs —— 决策 D8-#4 的验收：命名任务真的并进了作业设施。
 *
 * 被验证的缺陷：`generate_novel` 与 `compressStoryMemory` 此前在 HTTP 请求里**同步跑完**，
 * 只占一个并发槽位，没有作业记录——于是界面没有进度、不能取消、刷新就丢、
 * 也不进「可恢复任务」列表。两处执行路径用的还是**无进度**的 `runHarnessTask`，
 * 所以即便把它们塞进作业设施，tail 也永远是空的。
 *
 * 本工具分两段：
 *   【静态】永远跑（零成本、不需要实例）：三处接线是否同源。
 *   【活体】需要显式授权 + 一个**隔离实例**（会真的建作业）：
 *           ── 有进度：作业的 stage/tail 真的在动
 *           ── 可取消：cancel 之后作业进入 cancelled
 *           ── 可落库：作业出现在「可恢复任务」列表里（刷新/重启后能接回）
 *
 * ⚠️ 活体段会创建真实作业，所以必须跑在黑洞端点实例上（零计费）。
 *
 * 用法:
 *   node .p1-baseline/verify-named-jobs.mjs                                  # 只跑静态
 *   node .p1-baseline/gate-env.mjs --data-dir .p1-baseline/stress-data --port 3738
 *   $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
 *   node .p1-baseline/verify-named-jobs.mjs http://127.0.0.1:3738
 */
import fs from 'node:fs';

const BASE = process.argv[2] || '';
const AUTHORIZED = process.env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED === '1';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};

console.log('═══ 命名任务是否真的并进了作业设施（D8-#4）═══\n');

console.log('【静态接线】');
{
  const srv = fs.readFileSync('server.js', 'utf8');
  const app = fs.readFileSync('public/app.js', 'utf8');

  check('作业设施支持"自带运行体"（options.runner）',
    /if \(typeof options\.runner === 'function'\)/.test(srv));
  check('结构化产出走 job.result（不与正文 output 混在一起）', /job\.result = await options\.runner\(/.test(srv));
  check('命名任务入口存在且校验 kind',
    /NAMED_TASKS\[kind\]/.test(srv) && /未知的命名任务/.test(srv));
  check('命名入口与 /harness/run 用同一个并发闸门',
    /segments\[2\] === 'job'[\s\S]{0,400}harnessLoad\(\) >= HARNESS_CONCURRENCY/.test(srv));

  // 按**函数边界**取函数体，而不是按字符数切片——后者在函数变长之后会静默切不到目标，
  // 于是断言开始报假失败（本次就踩了：给函数加了几行注释，两条断言立刻失效）。
  const funcBody = (src, name) => {
    const i = src.indexOf(`async function ${name}(`);
    if (i < 0) return '';
    const end = src.indexOf('\n}\n', i);   // 顶层 `}` 收尾；嵌套块都是缩进的
    return src.slice(i, end < 0 ? src.length : end + 2);
  };

  // "进了作业设施" ≠ "有进度"：执行路径必须真的把过程吐出来。
  const gen = funcBody(srv, 'generateNovelFromHarness');
  check('生成小说改用带进度的入口并把 chunk 转出去',
    /runHarnessTaskWithProgress\(/.test(gen) && /onChunk/.test(gen));
  const comp = funcBody(srv, 'compressStoryMemory');
  check('记忆压缩同样改为带进度的入口',
    /runHarnessTaskWithProgress\(/.test(comp) && /onChunk/.test(comp));
  check('再也没有"无进度的 runHarnessTask"调用点',
    !/await runHarnessTask\(/.test(srv));

  // ⚠️ 这条是活体段实测抓出来的缺陷的回归护栏：命名任务进了作业设施之后，
  // 若运行体不把 abort `signal` 透传给底层的 harness 调用，作业的"取消"就只是
  // 设了个标志位——子进程照跑，作业**永远停在 running**。
  check('两条运行体都把 abort signal 透传下去（否则取消按钮形同虚设）',
    /generateNovelFromHarness\(String\(body\.prompt \|\| ''\)\.trim\(\), body\.model \|\| undefined, onChunk, signal\)/.test(srv)
    && /compressStoryMemory\(Number\(body\.work_id\), onChunk, signal\)/.test(srv));
  check('底层 harness 调用真的接住了 signal',
    /model: model \|\| undefined, signal \}/.test(srv) && /model: QUALITY_AI_MODEL, signal \}/.test(srv));

  check('前端不再直连两个同步端点',
    !app.includes("'/harness/generate_novel'") && !app.includes("'/story_memory/compress'"));
  check('前端两条路径都走 /harness/job 并读 result',
    (app.match(/'\/harness\/job'/g) || []).length >= 2 && /data\.result\?\.summary/.test(app) && /job\.result \|\| \{\}/.test(app));
  check('轮询返回值里带 result（否则前端拿不到结构化产出）',
    /result: job\.result \?\? null/.test(app));
}

if (!BASE) {
  console.log('\n（未给实例地址 → 跳过活体段。它需要隔离实例，见文件头用法。）');
} else if (!AUTHORIZED) {
  console.log('\n✗ 拒绝跑活体段：它会真的创建作业。');
  console.log('  必须跑在可证明的隔离实例上（黑洞 LLM 端点 → 零计费），并显式授权：');
  console.log("  $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'");
  fail++;
} else {
  const api = async (method, p, body) => {
    const r = await fetch(BASE + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  };

  console.log(`\n【活体：目标 ${BASE}】`);
  // 阴性对照先跑：非法 kind 必须被拒，而不是悄悄建一个作业。
  const bad = await api('POST', '/api/harness/job', { kind: '完全不存在的任务' });
  check('未知 kind 被拒（400）', bad.status === 400 && /未知的命名任务/.test(bad.text), `HTTP ${bad.status}`);
  const noWork = await api('POST', '/api/harness/job', { kind: 'compress' });
  check('命名任务缺参数被拒（400）', noWork.status === 400 && /work_id/.test(noWork.text), `HTTP ${noWork.status}`);

  // 真实建一个压缩作业（黑洞端点 → 它会一直卡住，正好用来验证进度与取消）
  const works = await api('GET', '/api/works');
  const workId = Array.isArray(works.json) && works.json.length ? works.json[0].id : null;
  check('拿到一个 work_id 用于建作业', Boolean(workId), `work=${workId}`);

  let jobId = null;
  if (workId) {
    const created = await api('POST', '/api/harness/job', { kind: 'compress', work_id: workId, timeout: 120000 });
    check('作业创建成功（202 + job_id）', created.status === 202 && Boolean(created.json?.job_id), `HTTP ${created.status}`);
    jobId = created.json?.job_id || null;
  }

  if (jobId) {
    // 有进度：作业记录里有 kind/stage
    let job = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      job = (await api('GET', `/api/harness/job?id=${encodeURIComponent(jobId)}`)).json;
      if (job && job.status !== 'pending') break;
      await new Promise((s) => setTimeout(s, 1000));
    }
    check('作业进入 running（不是卡在"没有记录"）', job?.status === 'running', `status=${job?.status}`);
    check('作业带上命名任务的语义（kind + stage）',
      job?.kind === 'compress' && /压缩长期记忆/.test(String(job?.stage || '')), `kind=${job?.kind} stage=${job?.stage}`);
    check('响应里有 result 字段（终态时才有值）', 'result' in (job || {}), Object.keys(job || {}).join(','));

    // 可落库：出现在「可恢复任务」列表里
    const rec = await api('GET', `/api/harness/recoverable?work_id=${workId}`);
    const listed = Array.isArray(rec.json?.jobs) && rec.json.jobs.some((j) => j.id === jobId);
    check('作业出现在「可恢复任务」列表里（刷新/重启后能接回）', listed,
      `列表 ${rec.json?.jobs?.length ?? '?'} 条`);

    // 可取消
    const cancelled = await api('POST', '/api/harness/cancel', { job_id: jobId });
    check('取消请求被接受', cancelled.status === 200, `HTTP ${cancelled.status}`);
    await new Promise((s) => setTimeout(s, 4000));
    const after = (await api('GET', `/api/harness/job?id=${encodeURIComponent(jobId)}`)).json;
    check('取消后作业进入 cancelled（不是永远 running）', after?.status === 'cancelled', `status=${after?.status}`);
  }
}

console.log(`\n══════════════════════════════`);
console.log(`命名任务验收：通过 ${pass} / 失败 ${fail}`);
console.log('复核零计费：node .p1-baseline/audit-llm-calls.mjs --since <本命令开始时刻>');
process.exitCode = fail ? 1 : 0;
