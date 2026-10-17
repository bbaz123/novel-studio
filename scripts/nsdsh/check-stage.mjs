#!/usr/bin/env node
/**
 * nsdsh/check-stage.mjs —— 阶段门禁运行器（S01，落实方案稿 §13.3 的契约）。
 *
 * 它回答一个问题：**这个阶段现在算不算通过**，并且把"通过"拆成可核对的三类证据：
 *   ① 产物在不在（requiredArtifacts / requiredTestFiles，glob 由 Node 展开，不靠 shell）；
 *   ② 前置阶阶段报告是否**仍然有效**（交付物没被人在报告之后改过）；
 *   ③ 命令真的跑了没有、退出码是多少、跑了多少条测试（zeroTestGuard）。
 *
 * 三条不许违反的纪律（本项目为此误判过）：
 *   · **PASS 只能来自真实执行**：没跑起来 ≠ 失败，但也绝不等同于通过（`status === null` 时
 *     先按环境阻断判 BLOCKED，而不是记 FAIL——真回归与沙箱限制必须分开）。
 *   · **零测试不算通过**：声明了 `zeroTestGuard` 的命令，解析不出测试数量就判 FAIL。
 *     历史上"清单为空 → 退出码 0"被当成绿过一次，所以这里把"证明跑了多少条"写进判据。
 *   · **SKIPPED ≠ PASS**：没人评估的验收项记 `passed:false / detail:'未实现自动判定'`，
 *     不许沉默地算作通过。
 *
 * 退出码：0 = PASS；1 = FAIL；3 = PARTIAL / BLOCKED；2 = 用法错误。
 *
 * 用法:
 *   node scripts/nsdsh/check-stage.mjs <STAGE_ID> [--offline] [--json] [--write-report] [--force] [--allow-blocked]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksEnvironmentBlocked, parseTestCounts, runCommand } from './lib/gate.mjs';
import { probeEgressDenied, probeLoopbackAllowed } from './lib/egress.mjs';
import { ensureReportsDir, expandGlob, findStage, loadStages, makeReport, readReport, redact, rel, writeLog, writeReport, verifyPrerequisite, abs, REPO } from './lib/report.mjs';
import { startFakeModel } from './lib/isolate.mjs';
// S02 的 known-issues 结构判据只有一份实现：直接复用检查脚本导出的 check()，
// 而不是在门禁里再抄一遍（两套判据必然漂移，本项目历史上已出现过同类问题）。
import { check as checkKnownIssues } from './check-known-issues.mjs';

export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, PARTIAL: 3 };

// ─────────────────────────────── 纯函数层（测试直接 import 这一层）───────────────────────────────

/** 某文件是否存在且非空（0 字节的产物不算交付）。 */
export function fileMissingOrEmpty(relPath) {
  const p = abs(relPath);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return 'missing';
  if (fs.statSync(p).size === 0) return 'empty';
  return null;
}

/**
 * 阶段的**形状**校验：不跑任何命令，只看清单里的声明能不能构成一次合法验收。
 *
 * 两类结论必须分开，因为它们的**下一步动作不同**：
 *   · `failures` —— 清单写错了（该红就红，要有人去改清单）；
 *   · `blocked`  —— 清单没错，但**这个阶段的运行器还没实现**（`commands` 为空且未标 done）。
 *     这种只能报 BLOCKED，不能报 FAIL（那会把"还没开工"说成"回归"），更不能 PASS。
 *
 * 为什么"空 requiredTestFiles"算失败：清单里没有测试文件时，`commands` 全绿也可能只是
 * "什么都没测"。规则是 fail-closed 的：真要做无测试的阶段（例如纯文档阶段），必须在清单里
 * 显式声明 `status: 'done'`——那是"历史事实已确认"，不是"本轮无人评估"，
 * 且 `done` 阶段不许再声明 commands（否则本节自相矛盾）。
 */
export function evaluateStageShape(stage) {
  const s = stage || {};
  const id = String(s.id || '(无 id)');
  const failures = [];
  const blocked = [];
  const requiredTestFiles = Array.isArray(s.requiredTestFiles) ? s.requiredTestFiles : null;
  const requiredArtifacts = Array.isArray(s.requiredArtifacts) ? s.requiredArtifacts : null;
  const commands = Array.isArray(s.commands) ? s.commands : null;
  const status = String(s.status || '');
  const isDone = status === 'done';

  if (!requiredTestFiles) {
    failures.push({ code: 'TEST_LIST_MISSING', detail: `${id} 没有声明 requiredTestFiles 数组（清单结构不对）` });
  } else if (requiredTestFiles.length === 0) {
    const historical = isDone && commands && commands.length === 0;
    if (!historical) {
      failures.push({
        code: 'TEST_LIST_EMPTY',
        detail: `${id} 的 requiredTestFiles 为空：无法证明测过任何东西（拒绝把"没有测试"当通过）`,
      });
    }
    // historical 分支：check-stage.mjs 出现之前完成的阶段（S00），证据是产物 + 既有报告。
    // 这里**不**判失败，也不给 PASS —— 结论由 runStage 从既有报告里读。
  }
  if (!requiredArtifacts) {
    failures.push({ code: 'ARTIFACT_LIST_MISSING', detail: `${id} 没有声明 requiredArtifacts 数组` });
  }
  if (!commands) {
    failures.push({ code: 'COMMAND_LIST_MISSING', detail: `${id} 没有声明 commands 数组` });
  } else if (commands.length === 0 && !isDone) {
    blocked.push({
      code: 'NO_COMMANDS_NOT_DONE',
      detail: `${id} 的 commands 为空且 status=${status || '(未声明)'}：本阶段的运行器尚未实现，只能 BLOCKED，不能 PASS`,
    });
  }
  for (const c of commands || []) {
    if (!Array.isArray(c.argv) || !c.argv.length) {
      failures.push({ code: 'COMMAND_ARGV_INVALID', detail: `${id} 的命令 ${c.id || '(无 id)'} 没有 argv 数组（不许 shell 拼接）` });
    }
  }
  return { id, ok: failures.length === 0, failures, blocked };
}

/**
 * 展开 requiredTestFiles，并逐条要求**至少命中一个真实文件**。
 *
 * 为什么逐个 pattern 检查而不是只看并集：`tests/nsdsh/*.test.mjs` 匹配到 0 个文件时，
 * 并集可能仍非空（别的 pattern 命中了），于是"某个套件整批消失"会被掩盖。
 */
export function collectRequiredTestFiles(patterns = [], expand = expandGlob) {
  const patterns_ = Array.isArray(patterns) ? patterns : [];
  const files = [];
  const failures = [];
  for (const p of patterns_) {
    const matched = expand(p) || [];
    if (!matched.length) {
      failures.push({ code: 'TEST_PATTERN_EMPTY', detail: `requiredTestFiles 里 ${p} 匹配到 0 个真实文件` });
      continue;
    }
    for (const f of matched) if (!files.includes(f)) files.push(f);
  }
  return { files, failures };
}

/** 逐条要求 requiredArtifacts 存在且非空。 */
export function verifyRequiredArtifacts(paths = []) {
  const failures = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const why = fileMissingOrEmpty(p);
    if (why === 'missing') failures.push({ code: 'ARTIFACT_MISSING', detail: `requiredArtifacts 缺失：${p}` });
    else if (why === 'empty') failures.push({ code: 'ARTIFACT_EMPTY', detail: `requiredArtifacts 是空文件：${p}` });
  }
  return { failures };
}

/**
 * 逐条核对前置阶段证据。**必须把该依赖阶段的 frozenArtifacts 传进去**：
 * 不传（默认 null）= 什么都不冻结，于是"报告之后有人改了交付物"就查不出来（假绿）。
 */
export function verifyDependencies(stage, doc, verify = verifyPrerequisite) {
  const failures = [];
  for (const dep of (stage && Array.isArray(stage.dependencies) ? stage.dependencies : [])) {
    const depStage = findStage(doc, dep);
    const frozenArtifacts = (depStage && Array.isArray(depStage.frozenArtifacts)) ? depStage.frozenArtifacts : [];
    const r = verify(dep, { frozenArtifacts });
    if (!r || !r.ok) {
      failures.push({ code: 'DEPENDENCY_INVALID', detail: `前置阶段 ${dep} 证据无效：${(r && r.reason) || '未知原因'}` });
    }
  }
  return { failures };
}

/**
 * 离线策略裁决。
 *
 * 为什么不能"跳过需要联网的命令"：跳过等于把"没验证"记成中性，而中性会被下游读成"没问题"。
 * 因此本阶段 `networkPolicy` 不是 `none` / `loopback-only` 时，命令**不执行**，直接记 BLOCKED
 * （它是显式的构建前置阶段，得由人先把这个前置条件准备好）。
 */
export function checkNetworkPolicy(stage, { offline = false } = {}) {
  const policy = String((stage && stage.networkPolicy) || 'none');
  const allowed = policy === 'none' || policy === 'loopback-only';
  if (allowed) return { failures: [], blocked: [], policy };
  const reason = `${stage.id} 的 networkPolicy=${policy}：需要显式准备构建前置条件（--offline 下不执行，也不跳过）`;
  return { failures: [], blocked: [{ check: 'network-policy', reason }], policy };
}

/** 运行器自报汇总的机器标记（见 scripts/run-nsdsh-tests.mjs 末尾）。 */
export const SUMMARY_MARKER = 'NSDSH-SUMMARY';

/**
 * 从命令输出里取"证明跑了多少条测试"的读数。
 *
 * 为什么不能只用 `parseTestCounts`：它取**第一处**匹配，而汇总行在整条命令输出里可能先被
 * **孙子进程**打印（run-nsdsh-tests → 子套件自己也打印 `通过 N / 未通过 M`）。
 * 那样顶层报告里会出现"跑了 11 条"这种来自被测套件内部、而不是来自被检查命令的读数。
 * 因此清单里的命令若按约定打印 `NSDSH-SUMMARY:` 标记行，就**优先**采信它；
 * 没有标记行时仍退回 `parseTestCounts`（保持对既有脚本的兼容）。
 */
export function readTestCounts(text) {
  const s = String(text || '');
  const m = s.match(/NSDSH-SUMMARY:[^\n]*/);
  if (m) {
    const passed = Number((m[0].match(/passed=(\d+)/) || [])[1] ?? 0);
    const failed = Number((m[0].match(/failed=(\d+)/) || [])[1] ?? 0);
    if (Number.isFinite(passed) && Number.isFinite(failed)) {
      return { passed, failed, skipped: null, total: passed + failed, source: 'summary-marker' };
    }
  }
  return { ...parseTestCounts(s), source: 'parsed-output' };
}

/**
 * 把一条命令的执行结果分类成 PASS / FAIL / BLOCKED。
 *
 * `result.status === null` 表示**进程没跑起来**（沙箱拒绝管道等），这时先判环境阻断，
 * 不判回归——否则几十条检查会在 0–1ms 内全红，看起来像被测代码大面积回归。
 */export function classifyCommand(cmd, result = {}, { blockedSignatures = null } = {}) {
  const id = String((cmd && cmd.id) || '(无 id)');
  const argv = (cmd && cmd.argv) || [];
  const exit = result.status;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const counts = readTestCounts(text);
  const zeroTestGuard = !!(cmd && cmd.zeroTestGuard);
  // 签名来源：调用方显式给的那份（阶段级与命令级已合并），或退化到命令自己声明的那份。
  // 后者是**默认值**而不是替代品 —— 少写一个参数时也要按声明判 BLOCKED，
  // 否则"清单声明了阻断指纹"会被静默忽略（那就成了假红）。
  const signatures = blockedSignatures === null ? ((cmd && cmd.blockedSignatures) || []) : blockedSignatures;

  if (result.environmentBlocked === true) {
    return { status: 'BLOCKED', reason: '环境阻断：子进程没能跑起来或被沙箱拒绝（不计回归）', counts, zeroTestGuard, exit };
  }
  for (const sig of signatures) {
    if (new RegExp(sig, 'i').test(text)) {
      return { status: 'BLOCKED', reason: `命中清单声明的 blockedSignatures/${sig}`, counts, zeroTestGuard, exit };
    }
  }
  if (exit === null) {
    return { status: 'BLOCKED', reason: `命令没跑起来（status=null，error=${result.error || 'unknown'}）`, counts, zeroTestGuard, exit };
  }
  if (exit === 0) {
    if (zeroTestGuard) {
      if (counts.total === null) {
        return { status: 'FAIL', reason: `zeroTestGuard：解析不出测试数量（输出里没有汇总行），拒绝判通过`, counts, zeroTestGuard, exit };
      }
      if (counts.total === 0) {
        return { status: 'FAIL', reason: `zeroTestGuard：解析到 0 条测试，拒绝判通过`, counts, zeroTestGuard, exit };
      }
      if ((counts.failed || 0) > 0) {
        return { status: 'FAIL', reason: `zeroTestGuard：退出码 0 但报告 ${counts.failed} 条失败`, counts, zeroTestGuard, exit };
      }
      return { status: 'PASS', reason: `退出码 0 且证明跑了 ${counts.total} 条测试`, counts, zeroTestGuard, exit };
    }
    return { status: 'PASS', reason: '退出码 0', counts, zeroTestGuard, exit };
  }
  if (looksEnvironmentBlocked(text)) {
    return { status: 'BLOCKED', reason: '输出命中环境阻断指纹（spawn EPERM / errno -4048）', counts, zeroTestGuard, exit };
  }
  return { status: 'FAIL', reason: `退出码 ${exit}`, counts, zeroTestGuard, exit };
}

/**
 * 阶段状态：只要有一条 FAIL → FAIL；没有 FAIL 但有 BLOCKED → PARTIAL；否则 PASS。
 *
 * SKIPPED 必须显式传进来（`skippedChecks`）：它**压不住** PASS ——
 * 一个"没人评估过的必检项"如果被算进 PASS，报告会替事实说话。
 */
export function computeStageStatus({ failures = [], blocked = [], skippedChecks = [] } = {}) {
  const skipped = new Set(skippedChecks.map((s) => (typeof s === 'string' ? s : s && s.name)).filter(Boolean));
  if (failures.length) {
    return { status: 'FAIL', reason: `${failures.length} 项失败：${failures.map((f) => (typeof f === 'string' ? f : f.detail || f.code)).slice(0, 3).join('；')}` };
  }
  if (blocked.length) {
    return { status: 'PARTIAL', reason: `${blocked.length} 项环境阻断：${blocked.map((b) => b.check || b).slice(0, 3).join('；')}` };
  }
  if (skipped.size) {
    // 没有失败、也没有阻断，但有验收项没被评估 —— 这不是 PASS，也不是回归，如实记 PARTIAL。
    return { status: 'PARTIAL', reason: `有 ${skipped.size} 个必检项未被评估（SKIPPED ≠ PASS）` };
  }
  return { status: 'PASS', reason: '全部产物、前置证据与命令检查通过' };
}

// ─────────────────────────────── 执行层 ───────────────────────────────

/** 把一个命令块拼成人读字符串（报告与日志都用这一份形状）。 */
export function formatCommand(argv = []) {
  return [process.execPath, ...argv].join(' ');
}

/**
 * 跑一条命令并存证。**argv 逐字来自清单**（参数数组，不经过 shell）：
 * 走 shell 拼接会让 Windows 与 CI 得到不同的结果，也会让"清单里写的"与"实际跑的"漂移。
 */
export function runStageCommand(cmd, { cwd, env }) {
  const argv = [process.execPath, ...(cmd.argv || [])];
  const r = runCommand(argv, { cwd, env });
  const cls = classifyCommand(cmd, r, { blockedSignatures: cmd.blockedSignatures || [] });
  return {
    entry: {
      id: cmd.id || formatCommand(cmd.argv || []),
      command: (cmd.argv || []).join(' '),
      status: r.status,
      ms: r.ms,
      transport: r.transport,
      zeroTestGuard: !!cmd.zeroTestGuard,
      verdict: cls.status,
      reason: cls.reason,
      counts: cls.counts,
    },
    raw: `\n===== ${cmd.id || ''} :: ${(cmd.argv || []).join(' ')} (exit=${r.status}, ${r.transport}, ${r.ms}ms) =====\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}\n`,
    cls,
  };
}

/** 目录 glob 展开（复用 report.mjs 的 expandGlob 与 glob **同一实现**，避免两套通配语义）。 */
export { expandGlob };

// ─────────────────────────── S01 必检项（机器可判定，不许散文）───────────────────────────

/**
 * 按阶段 id 分派的机器判定集合。
 *
 * 返回的每一项：`{ name, passed, detail, blocked? }`。
 * 判不了就 `passed:false, detail:'未实现自动判定'` —— 沉默通过是本文件最想避免的失败模式。
 */
export async function runAcceptanceChecks(stageId, { stage, doc } = {}) {
  const out = [];
  const id = String(stageId || '').toUpperCase();
  if (id === 'S01') {
    // (a) network-guard.cjs 真的拒非回环出网。
    const denied = probeEgressDenied('http://example.com');
    if (denied.verdict === 'denied') {
      out.push({ name: 'network-guard 拒非回环 fetch（子进程实证）', passed: true, detail: denied.detail });
    } else if (denied.verdict === 'blocked') {
      out.push({ name: 'network-guard 拒非回环 fetch（子进程实证）', passed: false, blocked: true, detail: `子进程没跑起来：${denied.detail}` });
    } else {
      out.push({ name: 'network-guard 拒非回环 fetch（子进程实证）', passed: false, detail: `未被拒绝：${denied.detail}` });
    }

    // (a-对照) guard 不得拦掉合法回环 —— 阴性对照证明"拒绝"不是恒真。
    let model = null;
    try {
      model = await startFakeModel({ reply: '{"ok":true}' });
      const lb = probeLoopbackAllowed(`${model.baseUrl}/models`);
      if (lb.verdict === 'allowed') {
        out.push({ name: 'network-guard 允许回环（阴性对照）', passed: true, detail: `回环 ${model.baseUrl} 可访问` });
      } else if (lb.verdict === 'blocked') {
        out.push({ name: 'network-guard 允许回环（阴性对照）', passed: false, blocked: true, detail: `执行环境限制：子进程向父进程托管的回环 HTTP 取不到响应（裸 TCP 可连、HTTP 超时、无拒网签名）→ 本次无法证明：${lb.detail}` });
      } else {
        out.push({ name: 'network-guard 允许回环（阴性对照）', passed: false, detail: `回环被误拦：${lb.detail}` });
      }
    } catch (e) {
      out.push({ name: 'network-guard 允许回环（阴性对照）', passed: false, blocked: true, detail: `假模型未能启动：${e.message}` });
    } finally {
      if (model) { try { await model.stop(); } catch (_) { /* 已关闭 */ } }
    }

    // (b) 空测试清单必须被判失败：**同进程**调用纯函数，起子进程就证明不了这条。
    const synthetic = evaluateStageShape({
      id: 'SYNTHETIC-S01-CHECK', status: 'active', commands: [{ id: 'noop', argv: ['-e', 'process.exit(0)'] }],
      requiredArtifacts: ['package.json'], requiredTestFiles: [],
    });
    out.push({
      name: 'check-stage 拒绝空 requiredTestFiles',
      passed: synthetic.ok === false && synthetic.failures.some((f) => f.code === 'TEST_LIST_EMPTY'),
      detail: synthetic.ok === false ? synthetic.failures.map((f) => f.code).join(',') : '空清单被判为合法（判据失效）',
    });

    // (c) 三个套件自身必须能报出 > 0 条断言。
    for (const f of (stage && stage.requiredTestFiles) || []) {
      const r = runCommand([process.execPath, f], { cwd: process.cwd() });
      const counts = parseTestCounts(`${r.stdout || ''}\n${r.stderr || ''}`);
      if (r.status === 0 && counts.total !== null && counts.total > 0 && (counts.failed || 0) === 0) {
        out.push({ name: `${f} 真跑并有断言计数`, passed: true, detail: `exit=0，通过 ${counts.passed} / 未通过 ${counts.failed}` });
      } else if (r.status === null || r.environmentBlocked) {
        out.push({ name: `${f} 真跑并有断言计数`, passed: false, blocked: true, detail: `没能跑起来：${r.error || 'status=null'}` });
      } else {
        out.push({ name: `${f} 真跑并有断言计数`, passed: false, detail: `exit=${r.status}，counts=${JSON.stringify(counts)}` });
      }
    }

    // (d) S00 的阶段报告必须能作为前置证据通过校验（这是"阶段链条"真的接起来了的证明）。
    const dep = 'S00';
    const depStage = doc ? findStage(doc, dep) : null;
    const v = verifyPrerequisite(dep, { frozenArtifacts: (depStage && depStage.frozenArtifacts) || [] });
    out.push({ name: `verifyPrerequisite('${dep}') 通过（bootstrap 报告有效）`, passed: !!v.ok, detail: v.reason });
    return out;
  }

  if (id === 'S02') {
    // S02 的验收项全部落在 `docs/nsdsh/known-issues.json` 上，所以先做结构判据（复用同一个脚本，
    // 避免"检查脚本说合法、阶段门禁说非法"两套判据漂移）。
    const ledger = checkKnownIssues();
    if (!ledger.ok) {
      out.push({
        name: 'known-issues.json 结构自洽（summary === 明细复算；每条有 fixStage 与到期条件）',
        passed: false,
        detail: ledger.problems.join(' | '),
      });
      return out;
    }
    out.push({ name: 'known-issues.json 结构自洽（summary === 明细复算；每条有 fixStage 与到期条件）', passed: true, detail: `${ledger.doc.issues.length} 条登记` });

    const byId = new Map(ledger.doc.issues.map((i) => [i.id, i]));
    // (a) F01–F12 每条都有可执行表征或明确记录替代实现。
    const fIds = Array.from({ length: 12 }, (_, k) => `F${String(k + 1).padStart(2, '0')}`);
    const fMissing = fIds.filter((x) => !byId.has(x));
    const fNoTest = fIds.filter((x) => byId.get(x) && !String(byId.get(x).behaviorTest || '').trim());
    out.push({
      name: 'F01–F12 每条都有行为表征（behaviorTest 非空）',
      passed: fMissing.length === 0 && fNoTest.length === 0,
      detail: fMissing.length || fNoTest.length
        ? `缺失=${fMissing.join(',') || '无'}；无表征=${fNoTest.join(',') || '无'}`
        : `${fIds.length} 条齐全`,
    });

    // (b) D1–D6 每条绑定修复阶段与到期条件。
    const dIds = Array.from({ length: 6 }, (_, k) => `D${k + 1}`);
    const dMissing = dIds.filter((x) => !byId.has(x));
    const stageIds = new Set(((doc && doc.stages) || []).map((s) => s.id));
    const dBad = dIds.filter((x) => {
      const it = byId.get(x);
      if (!it) return true;
      return !stageIds.has(it.fixStage) || !String(it.expiry || '').trim();
    });
    out.push({
      name: 'D1–D6 每条绑定修复阶段与到期条件',
      passed: dMissing.length === 0 && dBad.length === 0,
      detail: dMissing.length || dBad.length
        ? `缺失或不合格=${[...dMissing, ...dBad].join(',')}`
        : dIds.map((x) => `${x}→${byId.get(x).fixStage}`).join(' '),
    });

    // (c) 报告必须区分"旧行为已被描述"与"目标正确性已通过"。
    //     S02 期间：任何条目都不许声明已修复（那时还没修）；S03 起：允许声明已修复，
    //     但**必须带修复证据**（evidenceNote），且未修的条目仍必须有到期条件（不许永久跳过）。
    const claimedFixed = ledger.doc.issues.filter((i) => i.status === 'fixed_locally');
    const fixedWithoutEvidence = claimedFixed.filter((i) => !String(i.evidenceNote || '').trim());
    const openNoExpiry = ledger.doc.issues.filter((i) => i.status !== 'fixed_locally' && !String(i.expiry || '').trim());
    out.push({
      name: '区分「旧行为已描述」与「目标正确性已通过」（已修必须带修复证据；未修必须有到期条件）',
      passed: fixedWithoutEvidence.length === 0 && openNoExpiry.length === 0,
      detail: fixedWithoutEvidence.length || openNoExpiry.length
        ? `声明已修但无证据=${fixedWithoutEvidence.map((i) => i.id).join(',') || '无'}；未修却缺到期条件=${openNoExpiry.map((i) => i.id).join(',') || '无'}`
        : `已修 ${claimedFixed.length} 条（均有修复证据）；未修 ${ledger.doc.issues.length - claimedFixed.length} 条（均有到期条件）`,
    });
    return out;
  }

  if (id === 'S15') {
    // S15 = 故障矩阵 / 跨平台 / 性能。判据：性能报告带硬件与计时边界；E1 有归因且不加重试。
    const need = ['scripts/nsdsh/benchmark.mjs', 'scripts/nsdsh/attribute-gate-flakiness.mjs'];
    const miss = need.filter((rel) => !fs.existsSync(abs(rel)));
    if (miss.length) {
      out.push({ name: 'benchmark 与归因脚本存在', passed: false, detail: `缺：${miss.join('、')}` });
      return out;
    }
    const benchSrc = fs.readFileSync(abs('scripts/nsdsh/benchmark.mjs'), 'utf8');
    const attrSrc = fs.readFileSync(abs('scripts/nsdsh/attribute-gate-flakiness.mjs'), 'utf8');

    out.push({
      name: '性能报告包含硬件画像与计时边界',
      passed: /hardwareProfile/.test(benchSrc) && /cpu_model/.test(benchSrc) && /total_mem_mb/.test(benchSrc)
        && /boundaries/.test(benchSrc) && /hrtime/.test(benchSrc),
      detail: '没有硬件与边界的性能数字不可比较',
    });
    out.push({
      name: '合成夹具可跑 100 / 1000 章（冷/热 + 缓存命中/未命中）',
      passed: /buildFixture/.test(benchSrc) && /hot_query/.test(benchSrc) && /cache_miss_query/.test(benchSrc)
        && /--chapters/.test(benchSrc),
      detail: '不碰作者真实库，全部在隔离库内',
    });
    out.push({
      name: 'E1 归因：静态枚举 spawn 敏感项并按实跑结果分流结论',
      passed: /staticAttribution/.test(attrSrc) && /spawn_sensitive/.test(attrSrc)
        && /GATE_SIDE_SANDBOX/.test(attrSrc) && /PROJECT_SIDE_FAILURE/.test(attrSrc),
      detail: '同环境绿→门禁侧；同环境红→项目侧；无实跑→INCONCLUSIVE',
    });
    out.push({
      name: 'E1 纪律：不加重试、不弱化断言（源码断言）',
      passed: !/max[A-Z]?[a-z]*Retries|retryCount|attempts?\s*\+/i.test(attrSrc),
      detail: '到期条件明令禁止"自动重试直到绿"',
    });

    // 台账：E1 必须已给出处置结论
    const issues = JSON.parse(fs.readFileSync(abs('docs/nsdsh/known-issues.json'), 'utf8'));
    const e1 = (issues.issues || []).find((i) => i.id === 'E1');
    out.push({
      name: 'E1 已给出处置结论与证据（门禁侧沙箱 → 本项目不可修）',
      passed: !!e1 && String(e1.evidenceNote || '').length > 50
        && /沙箱|EPERM/.test(String(e1.evidenceNote || ''))
        && String(e1.disposition || '') === 'not_fixable_in_project',
      detail: e1 ? `disposition=${e1.disposition || '(未设)'}` : '台账缺 E1',
    });

    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    out.push({
      name: 'S15 套件已落地并纳入执行',
      passed: fs.existsSync(abs('tests/nsdsh/fault-matrix.test.mjs')) && runner.includes('tests/nsdsh/fault-matrix.test.mjs'),
      detail: '性能报告完整性 + E1 归因纪律',
    });
    return out;
  }

  if (id === 'S14') {
    // S14 = 裁剪发行物与依赖闭包（修 F10）。判据：manifest 可验证、依赖不越界、B/C 等价、许可齐全。
    const need = ['vendor/dsh/runtime-manifest.json', 'scripts/nsdsh/build-runtime.mjs', 'scripts/nsdsh/verify-runtime-closure.mjs'];
    const miss = need.filter((rel) => !fs.existsSync(abs(rel)));
    if (miss.length) {
      out.push({ name: 'runtime manifest 与闭包脚本存在', passed: false, detail: `缺：${miss.join('、')}` });
      return out;
    }
    const manifest = JSON.parse(fs.readFileSync(abs('vendor/dsh/runtime-manifest.json'), 'utf8'));
    const harnessSrc = fs.readFileSync(abs('harness.js'), 'utf8');

    out.push({
      name: 'F10 已修：就绪判据改为 manifest + 入口 + 版本握手',
      passed: /harnessRuntimeState/.test(harnessSrc)
        && /runtime-manifest\.json/.test(harnessSrc) && /expectVersion/.test(harnessSrc)
        && !/typert\.host\.js[\s\S]{0,200}markers\.every/.test(harnessSrc),
      detail: '不再"两个生成文件在就算就绪"',
    });
    out.push({
      name: 'manifest 可验证：基线与 PROVENANCE 一致，入口/版本/协议/许可齐全',
      passed: manifest.baseline && manifest.entry && manifest.handshake && manifest.license
        && Array.isArray(manifest.closure.requiredPackages) && manifest.closure.requiredPackages.length >= 50,
      detail: `闭包 ${manifest.closure && manifest.closure.requiredPackages ? manifest.closure.requiredPackages.length : 0} 个包`,
    });
    out.push({
      name: '协议握手只用上游真实方法（不发明 API）',
      passed: JSON.stringify([...(manifest.handshake.methods || [])].sort())
        === JSON.stringify(['initialize', 'session/prompt', 'shutdown']),
      detail: '与 packages/sdk/protocol/src/types.ts 的 HarnessSdkRequestMap 一致',
    });
    out.push({
      name: '依赖不越界：闭包路径全在基线内，且不与裁剪面重叠',
      passed: Array.isArray(manifest.closure.excludedFromDistribution) && manifest.closure.excludedFromDistribution.length > 0
        && manifest.closure.requiredPackages.every((rel) => !rel.startsWith('/') && !rel.includes('node_modules')),
      detail: '禁止指向全局包或绝对路径',
    });
    out.push({
      name: 'B/C 契约等价由可枚举三要素判定（方法/入口/版本）',
      passed: /contracts/.test(fs.readFileSync(abs('scripts/nsdsh/build-runtime.mjs'), 'utf8')),
      detail: '不是"看起来差不多"，而是逐字比对签名',
    });

    const needTests = [
      'tests/nsdsh/distribution-closure.test.mjs',
      'tests/nsdsh/distribution-clean-room.test.mjs',
      'tests/nsdsh/runtime-equivalence.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S13') {
    // S13 = SDK 子进程、任务会话与取消。
    // 最关键的一条：**不得发明上游方法** —— 锁定基线的协议面没有 session/cancel。
    const rel = 'ai/runtime/dsh-sdk.mjs';
    if (!fs.existsSync(abs(rel))) {
      out.push({ name: 'SDK 运行时模块存在', passed: false, detail: `缺少 ${rel}` });
      return out;
    }
    const src = fs.readFileSync(abs(rel), 'utf8');

    out.push({
      name: '协议面白名单只含上游真实方法（initialize / session/prompt / shutdown）',
      passed: /SDK_PROTOCOL/.test(src)
        && /'initialize'/.test(src) && /'session\/prompt'/.test(src) && /'shutdown'/.test(src)
        && /SDK_PROTOCOL_VIOLATION/.test(src),
      detail: '发现"发明 API"必须本地炸掉（fail-closed）',
    });
    out.push({
      name: '无假取消 API：取消走终止独占进程，且确认已退出',
      passed: /kill_process/.test(src) && /PROCESS_DID_NOT_EXIT/.test(src)
        && !/send\(\s*\{[^}]*method:\s*['"]session\/cancel['"]/.test(src),
      detail: '上游没有 session/cancel，取消只能是杀进程 + 确认退出',
    });
    out.push({
      name: '默认单进程单活跃任务；上一个未确认退出前拒绝新建',
      passed: /ANOTHER_TASK_ACTIVE/.test(src) && /canStartNewTask/.test(src),
      detail: '不做"悄悄并行"',
    });
    out.push({
      name: '会话作用域带 work/chapter/task；结果归属校验拒收不匹配 session',
      passed: /sessionIdFor/.test(src) && /SESSION_MISMATCH/.test(src) && /resolveResult/.test(src),
      detail: '防跨任务结果混淆',
    });
    out.push({
      name: '池化默认关闭且理由可解释（不可安全池化时关闭是正确答案）',
      passed: /poolingDecision/.test(src) && /UNTRUSTED_SESSION_CONTEXT/.test(src)
        && /POOLING_NOT_IMPLEMENTED/.test(src),
      detail: '要说清"不安全"与"还没做"是两件事',
    });

    const needTests = [
      'tests/nsdsh/sdk-lifecycle.test.mjs',
      'tests/nsdsh/sdk-cancel.test.mjs',
      'tests/nsdsh/session-scope.test.mjs',
      'tests/nsdsh/runtime-pool.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测四件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '4/4 就位',
    });
    return out;
  }

  if (id === 'S12') {
    // S12 = 小说专用 profile。核心不变量：**模型实际拿到的工具集合 == 审批允许集合**，
    // 且任何配置覆盖层扩权都失败关闭。
    const profRel = 'harness-plugins/novel-writing/profile.mjs';
    const smokeRel = 'scripts/nsdsh/runtime-smoke.mjs';
    const miss = [profRel, smokeRel].filter((rel) => !fs.existsSync(abs(rel)));
    if (miss.length) {
      out.push({ name: 'profile 清单与冒烟脚本存在', passed: false, detail: `缺：${miss.join('、')}` });
      return out;
    }
    const profSrc = fs.readFileSync(abs(profRel), 'utf8');
    const patchSrc = fs.readFileSync(abs('harness-plugins/novel-writing/cordis.patch.yml'), 'utf8');

    out.push({
      name: '禁用清单来自 patch.yml 单一来源（不手抄）',
      passed: /export function disabledComponents/.test(profSrc) && /cordis\.patch\.yml/.test(profSrc)
        && /disabled:\s*true/.test(patchSrc),
      detail: '手抄清单必然与 yml 漂移',
    });
    out.push({
      name: 'S12 动作 3：编码人格与无关重型工具被禁用',
      passed: /agent-instructions/.test(patchSrc) && /tool-pwsh/.test(patchSrc)
        && /tool-subagent/.test(patchSrc) && /tool-web/.test(patchSrc),
      detail: '模型可见的编码人格必须移除；不复制宽权限配置',
    });
    out.push({
      name: '模型可见工具集合 == 审批允许集合（S09↔S12 接缝）',
      passed: /export function assertToolsMatchCapabilityTable/.test(profSrc)
        && /TOOL_CAPABILITIES/.test(profSrc) && /export function effectiveTools/.test(profSrc),
      detail: '这条不变量一红，就说明模型多/少了一个工具',
    });
    out.push({
      name: '配置扩权失败关闭（DENY，不是警告）',
      passed: /export function auditPatchLayers/.test(profSrc) && /DENY/.test(profSrc)
        && /REENABLES_DISABLED_COMPONENT/.test(profSrc) && /UNKNOWN_TOOL_EXPANSION/.test(profSrc)
        && /EXTERNAL_ENABLE_OF_AUTHOR_CONFIRM_TOOL/.test(profSrc),
      detail: '外部 home patch 不得扩大能力面',
    });
    out.push({
      name: '冒烟脚本 fixture-only、不 spawn 子进程（无残留进程可断言）',
      passed: !/from 'node:child_process'/.test(fs.readFileSync(abs(smokeRel), 'utf8'))
        && /--fixture/.test(fs.readFileSync(abs(smokeRel), 'utf8')),
      detail: 'S12 动作 7：stdout 干净、失败退出、无残留进程',
    });

    const needTests = [
      'tests/nsdsh/novel-profile.test.mjs',
      'tests/nsdsh/effective-tools.test.mjs',
      'tests/nsdsh/runtime-config-isolation.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S11') {
    // S11 = 固定并内置完整 DSH 基线。判定要点：来源可复核、许可齐全、只读校验、不碰用户全局。
    const vRel = 'vendor/dsh/verify-vendor.mjs';
    const pRel = 'vendor/dsh/PROVENANCE.md';
    const miss = [vRel, pRel].filter((rel) => !fs.existsSync(abs(rel)));
    if (miss.length) {
      out.push({ name: '来源记录与校验脚本存在', passed: false, detail: `缺：${miss.join('、')}` });
      return out;
    }
    const vSrc = fs.readFileSync(abs(vRel), 'utf8');
    const pSrc = fs.readFileSync(abs(pRel), 'utf8');

    out.push({
      name: '记录了上游来源：origin / tag / 上游 commit / vendor commit',
      passed: /origin:\s*'https:\/\/github\.com\/deepseek-ai\/deepseek-harness'/.test(vSrc)
        && /upstream_tag:/.test(vSrc) && /upstream_commit:/.test(vSrc) && /vendor_commit:/.test(vSrc)
        && /deepseek-harness/.test(pSrc),
      detail: '来源必须能被机器对账，而不是只写在报告里',
    });
    out.push({
      name: '许可与 lockfile 齐全（分发前提）',
      passed: /license_file:\s*'LICENSE'/.test(vSrc) && /lockfile:\s*'pnpm-lock\.yaml'/.test(vSrc)
        && /LICENSE/.test(pSrc) && /pnpm-lock\.yaml/.test(pSrc),
      detail: '上游是 MIT 族许可，分发必须随附；lockfile 必须保留',
    });
    out.push({
      name: '校验脚本只读：不 clone / install / build，也不碰 ~/.dsh',
      passed: !/git\s+clone/.test(vSrc) && !/pnpm\s+install/.test(vSrc) && !/pnpm\s+run\s+build/.test(vSrc)
        && !/homedir\(\)/.test(vSrc) && !/\.dsh[\/\\]/.test(vSrc),
      detail: 'host 不要求修改用户全局 DSH —— 本阶段验收项之一',
    });
    out.push({
      name: '构建验证已记录（typecheck / build / lint）且写了平台边界',
      passed: /typecheck/.test(pSrc) && /pnpm run build/.test(pSrc) && /lint/.test(pSrc) && /平台/.test(pSrc),
      detail: '不能只在开发机"能跑"却不写清平台；也不能不记录实测命令',
    });
    out.push({
      name: '诚实边界：与方案路径的偏差与"未做什么"都已写明',
      passed: /偏差/.test(pSrc) && /未覆盖|未做|明确不做/.test(pSrc),
      detail: '基线在本仓库外是刻意决定，必须显式记录而不是悄悄建空壳目录',
    });

    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    out.push({
      name: '来源一致性断言已落地并纳入套件执行',
      passed: fs.existsSync(abs('tests/nsdsh/dsh-vendor-provenance.test.mjs'))
        && runner.includes('tests/nsdsh/dsh-vendor-provenance.test.mjs'),
      detail: 'EXPECTED 与 PROVENANCE.md 任何一边改动都会红',
    });
    return out;
  }

  if (id === 'S10') {
    // S10 = 统一模型 broker（修 F04）：按作品+用途路由、同一结果契约、总预算。
    const need = ['ai/model-broker/routing.mjs', 'ai/model-broker/envelope.mjs', 'ai/model-broker/adapters.mjs'];
    const missing = need.filter((rel) => !fs.existsSync(abs(rel)));
    if (missing.length) {
      out.push({ name: '模型 broker 模块存在', passed: false, detail: `缺：${missing.join('、')}` });
      return out;
    }
    const routing = fs.readFileSync(abs('ai/model-broker/routing.mjs'), 'utf8');
    const envelope = fs.readFileSync(abs('ai/model-broker/envelope.mjs'), 'utf8');
    const adapters = fs.readFileSync(abs('ai/model-broker/adapters.mjs'), 'utf8');
    const serverSrc2 = fs.readFileSync(abs('server.js'), 'utf8');

    // 只看**那个函数体内**是否还有"按 id 取第一条"的旧选择。
    // （server.js 别处确实还有合法的 `ORDER BY id ASC LIMIT 1`，例如 projection_outbox 取待处理行，
    //   因此不能对全文做这个否定断言 —— 那会误伤无关代码。）
    const tacIdx = serverSrc2.indexOf('function temporalAnalysisConfig(');
    const tacTail = tacIdx >= 0 ? serverSrc2.slice(tacIdx) : '';
    const tacBody = tacTail.slice(0, tacTail.indexOf('\n}\n'));
    out.push({
      name: 'F04 已修：按作品 + 用途路由，无路由即失败（不再"第一个有 key 的配置"）',
      passed: /export function resolveRoute/.test(routing) && /NO_ROUTE/.test(routing)
        && /ModelBroker\.resolveRoute\(db, \{ workId/.test(serverSrc2)
        && tacIdx >= 0 && !/ORDER BY id ASC LIMIT 1/.test(tacBody) && !/api_configs WHERE api_key/.test(tacBody),
      detail: `作品级 → 全局级 → NO_ROUTE；temporalAnalysisConfig 体内旧选择残留=${/(ORDER BY id ASC LIMIT 1|api_configs WHERE api_key)/.test(tacBody)}`,
    });
    out.push({
      name: '本地回环 provider 免 key；外网无 key 必须失败',
      // 源码里写的是转义过的 127\.0\.0\.1 / localhost / [::1]；这里断言"判定函数 + 三种回环形态"，
      // 而不是去匹配那串带反斜杠的字面量。
      passed: /export function isLocalProvider/.test(routing) && /CONFIG_NO_KEY/.test(routing)
        && /localhost/.test(routing) && /127/.test(routing),
      detail: '不能"试一下"外网无 key 的配置；本地白名单必须只认回环',
    });
    out.push({
      name: '不可变 TaskEnvelope（冻结 + 不携带 api_key）',
      passed: /export function createTaskEnvelope/.test(envelope) && /Object\.freeze\(envelope\)/.test(envelope)
        && !/api_key:/.test(envelope.replace(/api_key 不进信封[\s\S]*?needs_api_key/, '')),
      detail: '信封会被日志/事件携带，密钥不能进去',
    });
    out.push({
      name: '预算同时管总请求数 / 总 token / 期限，且越界抛异常',
      passed: /maxRequests/.test(envelope) && /maxTotalTokens/.test(envelope) && /deadlineMs/.test(envelope)
        && /class BudgetExceeded/.test(envelope) && /MAX_REQUESTS_EXCEEDED/.test(envelope)
        && /DEADLINE_EXCEEDED/.test(envelope),
      detail: 'S10 动作 7：只限单次输出 token 会允许无限次 agent 请求',
    });
    out.push({
      name: 'direct / legacy 同一结果契约（ok 只配 done；not_run ≠ failed）',
      passed: /export function makeResult/.test(adapters) && /export function assertResultContract/.test(adapters)
        && /createDirectAdapter/.test(adapters) && /createLegacyAdapter/.test(adapters)
        && /'not_run'/.test(adapters),
      detail: '两个适配器必须产出同一形状，且失败不抛异常',
    });

    // 捕获脚本必须存在且真的跑过（门禁命令里会跑它）
    out.push({
      name: '模型请求契约可被捕获（capture-model-contract）',
      passed: fs.existsSync(abs('scripts/nsdsh/capture-model-contract.mjs')),
      detail: 'S10 动作 6：要捕获 fake provider 收到的**实际请求**，而不只是提示词生成器返回值',
    });

    const needTests = [
      'tests/nsdsh/model-routing.test.mjs',
      'tests/nsdsh/runtime-adapter-contract.test.mjs',
      'tests/nsdsh/task-budget.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S09') {
    // S09 = 收紧工具能力与作者权限（修 F11 + D6）。
    const capRel = 'harness-plugins/novel-writing/capabilities.mjs';
    if (!fs.existsSync(abs(capRel))) {
      out.push({ name: '能力表模块存在', passed: false, detail: `缺少 ${capRel}` });
      return out;
    }
    const capSrc = fs.readFileSync(abs(capRel), 'utf8');
    const toolsSrc = fs.readFileSync(abs('harness-plugins/novel-writing/novel-tools.mjs'), 'utf8');

    out.push({
      name: '三类能力机器可检查（read_only / proposal / author_confirm）',
      passed: /CAPABILITY\s*=\s*Object\.freeze/.test(capSrc) && /READ_ONLY/.test(capSrc)
        && /PROPOSAL/.test(capSrc) && /AUTHOR_CONFIRM/.test(capSrc) && /TOOL_CAPABILITIES/.test(capSrc),
      detail: 'F11：权限表必须是唯一事实来源，而不是各端点各自判断',
    });
    out.push({
      name: '失败关闭：表里没有的工具一律拒绝（隐藏工具名也拿不到执行器）',
      passed: /UNKNOWN_TOOL/.test(capSrc) && /hasOwnProperty\.call\(TOOL_CAPABILITIES/.test(capSrc),
      detail: '必须用 hasOwnProperty 查表，原型链上的名字不能被当成工具',
    });
    out.push({
      name: '作者确认边界：改正式状态必须带 approval_id，插件不得伪造',
      passed: /APPROVAL_REQUIRED/.test(capSrc) && /APPROVAL_OP/.test(capSrc)
        && /approvalId/.test(capSrc) && !/randomUUID\(\)[^\n]*approval/.test(capSrc),
      detail: '审批 id 只能来自作者通道',
    });
    out.push({
      name: '跨作品隔离：请求 work_id 与绑定 scope 不一致即拒绝',
      passed: /WORK_SCOPE_MISMATCH/.test(capSrc),
      detail: '绑定来源必须是任务启动器注入的环境身份，不是模型参数',
    });
    out.push({
      name: '插件真的在每次执行前过统一判定（表不是装饰）',
      passed: /assertModelCallable\(name,/.test(toolsSrc) && /if \(!verdict\.ok\)/.test(toolsSrc)
        && /process\.env\.NOVELSTUDIO_WORK_ID/.test(toolsSrc),
      detail: '判定必须早于 await execute(args)，且绑定 scope 来自环境身份',
    });
    out.push({
      name: 'D6 已处理：未接线的 NOVELSTUDIO_HARNESS_POOL 已从契约移除且三处声明一致',
      passed: !fs.readFileSync(abs('docs/host-contract.v1.json'), 'utf8').includes('NOVELSTUDIO_HARNESS_POOL')
        && !fs.readFileSync(abs('README.md'), 'utf8').includes('NOVELSTUDIO_HARNESS_POOL'),
      detail: '选择"删除"而不是"接线"：热备池从未被生产代码 import',
    });

    const needTests = [
      'tests/nsdsh/tool-capabilities.test.mjs',
      'tests/nsdsh/author-approval-boundary.test.mjs',
      'tests/nsdsh/cross-work-isolation.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S08') {
    // S08 = 领域事件流与前端闭环。核心不是"有没有推送"，而是三条验收：
    // 断线不漏确认 / 重复事件不重复渲染 / 切章后旧结果不更新新章卡片。
    const beRel = 'ai/story-state/domain-stream.mjs';
    const feRel = 'public/temporal-stream.js';
    const miss = [beRel, feRel].filter((rel) => !fs.existsSync(abs(rel)));
    if (miss.length) {
      out.push({ name: '流与前端模块存在', passed: false, detail: `缺：${miss.join('、')}` });
      return out;
    }
    const be = fs.readFileSync(abs(beRel), 'utf8');
    const fe = fs.readFileSync(abs(feRel), 'utf8');

    out.push({
      name: '断线不漏确认：事件来自持久 outbox + cursor 补读',
      passed: /projection_outbox/.test(be) && /export function readDomainEvents/.test(be) && /id > \?/.test(be),
      detail: 'S08 明令禁止"因关闭推送而丢业务事件"，所以事件源必须是持久表而不是内存广播',
    });
    out.push({
      name: 'watermark 消除初始化窗口',
      passed: /export function snapshotWatermark/.test(be) && /BELOW_WATERMARK/.test(fe),
      detail: '快照之前的旧事件必须无条件跳过，否则重复渲染',
    });
    out.push({
      name: '重连策略：落后太多/游标超前一律 resync（宁可重取，不可漏）',
      passed: /export function resyncPlan/.test(be) && /TOO_FAR_BEHIND/.test(be) && /CURSOR_AHEAD/.test(be),
      detail: '补读被保留窗口截断时会漏确认，因此必须能判定 resync',
    });
    out.push({
      name: '重复事件不重复渲染：id + dedup_key 双去重',
      passed: /export function dedupeEvents/.test(be) && /DUPLICATE_KEY/.test(be) && /seenKeys/.test(be),
      detail: '必须把历史 key 一起带进来，否则"换了 id 的同一变更"会被当成新事件',
    });
    out.push({
      name: '修订守卫：切章后旧结果不更新新章卡片',
      passed: /export function isUpdateApplicable/.test(be) && /CHAPTER_MISMATCH/.test(be) && /CHAPTER_MISMATCH/.test(fe),
      detail: '事件章必须等于卡片章；已确认不得倒退',
    });
    out.push({
      name: '前端消费者无 DOM 依赖（可单测、不干扰编辑器时序）',
      passed: /export function createStreamConsumer/.test(fe) && !/document\.|window\.|addEventListener/.test(fe),
      detail: 'S08 要求逐步迁移、不一次重写 app.js',
    });
    out.push({
      name: '六种状态可区分（saved/analyzing/pending/confirmed/stale/failed）',
      passed: /TEMPORAL_STATES/.test(be) && /TEMPORAL_STATES/.test(fe) && /'stale'/.test(be),
      detail: '未识别的 kind 必须保守判失败，不冒充成功',
    });

    const needTests = [
      'tests/nsdsh/domain-stream.test.mjs',
      'tests/nsdsh/frontend-revision-guard.test.mjs',
      'tests/nsdsh/editor-save-ime.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S07') {
    // S07 = 统一时点读取（强制 worldline/边界/POV/版本 + 溯源），只补溯源、不改 stateAt 语义。
    const rel = 'ai/story-state/temporal/state-query.mjs';
    if (!fs.existsSync(abs(rel))) {
      out.push({ name: '统一查询模块存在', passed: false, detail: `缺少 ${rel}` });
      return out;
    }
    const src = fs.readFileSync(abs(rel), 'utf8');
    out.push({
      name: '三种视图可区分（historical/current/draft），历史视图必须钉提交',
      passed: /VIEWS/.test(src) && /'historical'/.test(src) && /'current'/.test(src) && /'draft'/.test(src)
        && /HISTORICAL_REQUIRES_COMMIT_ID/.test(src),
      detail: '历史视图缺 commitId 必须响亮失败，而不是"历史=当前"',
    });
    out.push({
      name: '溯源四件套：提交 / 世界线 / 边界 / 投影版本',
      passed: /PROJECTION_VERSION/.test(src) && /provenance/.test(src)
        && /commit_id:/.test(src) && /worldline_id:/.test(src) && /boundary:/.test(src),
      detail: '没有溯源就分不清"第 20 章看到的"和"第 80 章看到的"',
    });
    out.push({
      name: '失败不回退最新值：ok:false 时 state 必须是 null',
      passed: /state: null/.test(src) && /STATE_NOT_QUERYABLE/.test(src),
      detail: '返回 {} 会被读成"这章什么都没有"，同样危险',
    });
    out.push({
      name: '硬验收：边界可见性（第 20 章看不到第 80 章事实）',
      passed: /export function factVisibleAt/.test(src) && /BEYOND_BOUNDARY/.test(src) && /BOUNDARY_MISMATCH/.test(src),
      detail: '纯算术 + 确定性：事实章序必须 < 排他上界；不自洽一律不可见',
    });
    out.push({
      name: 'POV 可见性只做确定性过滤（无"名称没出现就不失效"这类启发式）',
      passed: /export function povVisible/.test(src) && /POV_UNKNOWN/.test(src) && /NOT_DISCLOSED/.test(src)
        && !/名称未出现|name.*not.*found.*skip/.test(src),
      detail: 'reader 需显式 disclosed；character 需 holder===POV；canon/world 公开',
    });
    // 内核入口必须导出它（否则调用方拿不到统一入口）
    const idx = fs.readFileSync(abs('ai/story-state/temporal/index.mjs'), 'utf8');
    out.push({
      name: '已从内核入口导出（调用方有唯一入口）',
      passed: /export \* from '.\/state-query\.mjs'/.test(idx),
      detail: 'index.mjs 必须导出 state-query',
    });
    // stateAt 语义不得被改动（S07 只补溯源）
    out.push({
      name: '不改 stateAt 语义（只在其外层加契约）',
      passed: /from '.\/history\.mjs'/.test(src) || !/function stateAt\(/.test(src),
      detail: 'state-query 不得重新实现 stateAt',
    });

    const needTests = [
      'tests/nsdsh/state-query-boundary.test.mjs',
      'tests/nsdsh/projection-provenance.test.mjs',
      'tests/nsdsh/downstream-invalidation.test.mjs',
      'tests/nsdsh/pov-visibility.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测四件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '4/4 就位',
    });
    return out;
  }

  if (id === 'S06') {
    // S06 = 完整抽取覆盖 / schema 派生提示词 / 版本化摘要（修 F05–F08 + D4）。
    const need = {
      coverage: 'ai/extraction/coverage.mjs',
      digest: 'ai/extraction/digest.mjs',
      promptSchema: 'ai/extraction/prompt-schema.mjs',
    };
    const missingMod = Object.values(need).filter((rel) => !fs.existsSync(abs(rel)));
    out.push({
      name: 'F05/F07/F08 的支撑模块已落地',
      passed: missingMod.length === 0,
      detail: missingMod.length ? `缺：${missingMod.join('、')}` : 'coverage/digest/prompt-schema 三件就位',
    });

    if (missingMod.length === 0) {
      const cov = fs.readFileSync(abs(need.coverage), 'utf8');
      out.push({
        name: 'F05 覆盖：分块 + 覆盖清单 + 引文锚点（不允许静默截断）',
        passed: /export function planChunks/.test(cov) && /export function coverageManifest/.test(cov)
          && /export function anchorQuote/.test(cov) && /export function locateQuote/.test(cov),
        detail: 'planChunks/coverageManifest/locateQuote/anchorQuote 齐全',
      });
      const dig = fs.readFileSync(abs(need.digest), 'utf8');
      out.push({
        name: 'F07/F08 摘要：版本化请求身份 + 完整输出摘要',
        passed: /export function requestDigestV2/.test(dig) && /export function responseDigestV2/.test(dig)
          && /REQUEST_DIGEST_VERSION = 'v2'/.test(dig),
        detail: 'requestDigestV2 / responseDigestV2 且版本 v2',
      });
      const ps = fs.readFileSync(abs(need.promptSchema), 'utf8');
      out.push({
        name: 'F06 提示词契约由 schema 派生（不再是手写字符串）',
        passed: /from '..\/story-state\/temporal\/schema.mjs'/.test(ps) && /DOMAINS/.test(ps) && /SCOPES/.test(ps),
        detail: 'domain/scope 直接取自 schema 真值',
      });
    }

    // 生产接线：extraction 必须真的用上它们（不能只"存在模块"）
    const exSrc = fs.readFileSync(abs('ai/story-state/temporal/extraction.mjs'), 'utf8');
    out.push({
      name: 'F05 已接线：抽取结果带全文覆盖清单（含 truncated 可见）',
      passed: /coverageManifest\(/.test(exSrc) && /planChunks\(/.test(exSrc) && /truncated:/.test(exSrc),
      detail: '截断不再静默：coverage.truncated 如实暴露',
    });
    out.push({
      name: 'F07 已接线：input_hash 由 requestDigestV2 生成（已知实体参与身份）',
      passed: /requestDigestV2\(/.test(exSrc) && /input_hash: req\.digest/.test(exSrc)
        && !/known: knownLine\('', \[\]\)/.test(exSrc),
      detail: '旧的"空串占位"必须已消失',
    });

    // D4：迁移账本 + 事务化
    const dbSrc = fs.readFileSync(abs('db.js'), 'utf8');
    out.push({
      name: 'D4 已修：schema_migrations 账本 + 事务化迁移',
      passed: /CREATE TABLE IF NOT EXISTS schema_migrations/.test(dbSrc)
        && /BEGIN IMMEDIATE/.test(dbSrc) && /ROLLBACK/.test(dbSrc)
        && /MIGRATION_FAILURES/.test(dbSrc),
      detail: '幂等判据只认账本；失败整条回滚且不记账',
    });

    // 必测四件套
    const needTests = [
      'tests/nsdsh/extraction-coverage.test.mjs',
      'tests/nsdsh/extraction-schema.test.mjs',
      'tests/nsdsh/request-digest.test.mjs',
      'tests/nsdsh/evidence-anchors.test.mjs',
    ];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missingT = needTests.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = needTests.filter((f) => !runner.includes(f));
    out.push({
      name: '必测四件套已落地并纳入套件执行',
      passed: missingT.length === 0 && notInRunner.length === 0,
      detail: missingT.length || notInRunner.length ? `缺=${missingT.join(',')} 未纳入=${notInRunner.join(',')}` : '4/4 就位',
    });
    return out;
  }

  if (id === 'S05') {
    // S05 = 稳定实体 ID 与迁移解析器（修 F09）。判定要点：
    //   · 身份解析必须是**三态**（unique / missing / ambiguous），ambiguous 绝不自动择一；
    //   · v1 reader **保留**（正式切换留 S16），旧事件哈希不得被就地改写；
    //   · 迁移是 dry-run，且必须有阻断语义（有歧义 → 非零退出）。
    const idRel = 'ai/story-state/temporal/identity.mjs';
    if (!fs.existsSync(abs(idRel))) {
      out.push({ name: '稳定身份模块存在', passed: false, detail: `缺少 ${idRel}` });
      return out;
    }
    const idSrc = fs.readFileSync(abs(idRel), 'utf8');
    out.push({
      name: '身份解析是三态（unique / missing / ambiguous），歧义不返回 entityId',
      passed: /status: 'unique'/.test(idSrc) && /status: 'missing'/.test(idSrc) && /status: 'ambiguous'/.test(idSrc),
      detail: 'F09 的关键：歧义必须交作者，禁止自动择一',
    });
    out.push({
      name: '稳定身份与名称解耦（ent:<id> 编码 + 别名表解析）',
      passed: /export function entityUidOf/.test(idSrc) && /export function parseEntityUid/.test(idSrc)
        && /story_entity_aliases/.test(idSrc),
      detail: '改名不改变身份靠的是 canonical id + 别名表',
    });
    out.push({
      name: 'v2 关系方向显式（(A,B) 与 (B,A) 同 key、方向另存）',
      passed: /RELATION_KIND/.test(idSrc) && /export function canonicalRelation/.test(idSrc),
      detail: '旧数据只有 from/to 名字，没有方向语义',
    });

    // v1 reader 必须保留：compat 的按名投影在 S16 才切换。
    const compatSrc = fs.readFileSync(abs('ai/story-state/temporal/compat.mjs'), 'utf8');
    out.push({
      name: 'v1 reader 保留（旧作品正式切换留到 S16）',
      passed: /WHERE work_id = \? AND name = \?/.test(compatSrc),
      detail: 'S05 明确不在本阶段切换旧作品正式世界线',
    });

    // 迁移脚本：必须强制 dry-run，且有阻断语义。
    const migRel = 'scripts/nsdsh/identity-migration.mjs';
    if (!fs.existsSync(abs(migRel))) {
      out.push({ name: '迁移 dry-run 脚本存在', passed: false, detail: `缺少 ${migRel}` });
      return out;
    }
    const migSrc = fs.readFileSync(abs(migRel), 'utf8');
    out.push({
      name: '迁移脚本强制 dry-run（拒绝非 dry-run 执行）',
      passed: /if \(\!dryRun\)/.test(migSrc) && /process\.exit\(1\)/.test(migSrc),
      detail: 'S05 不写库、不切换世界线',
    });
    out.push({
      name: '迁移脚本有阻断语义（存在歧义/缺失时非零退出）',
      passed: /AMBIGUOUS/.test(migSrc) && /process\.exit\(out\.blockers/.test(migSrc),
      detail: '阻断项必须能被流水线识别，不能静默跳过',
    });

    // 必测三件套必须落地并真的被套件执行。
    const need = ['tests/nsdsh/entity-identity.test.mjs', 'tests/nsdsh/identity-migration.test.mjs', 'tests/nsdsh/relation-direction.test.mjs'];
    let runner = '';
    try { runner = fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'); } catch (_) { runner = ''; }
    const missing = need.filter((f) => !fs.existsSync(abs(f)));
    const notInRunner = need.filter((f) => !runner.includes(f));
    out.push({
      name: '必测三件套已落地并纳入套件执行',
      passed: missing.length === 0 && notInRunner.length === 0,
      detail: missing.length || notInRunner.length ? `缺文件=${missing.join(',')} 未纳入=${notInRunner.join(',')}` : '3/3 就位',
    });
    return out;
  }

  if (id === 'S04') {
    // S04 = 持久任务 / 租约 / outbox / 恢复。判定要点：**保存链路只写意图**、
    // **旧进程内调度器已移除**（不留第二个调度器）、**执行在事务外**、且 R1–R4 有行为断言。
    const srvPath = abs('server.js');
    if (!fs.existsSync(srvPath)) {
      out.push({ name: 'server.js 存在', passed: false, detail: '缺少 server.js' });
      return out;
    }
    const src = fs.readFileSync(srvPath, 'utf8');
    const saveIdx = src.indexOf('function afterTemporalContentSave(');
    const saveTail = saveIdx >= 0 ? src.slice(saveIdx) : '';
    const saveBody = saveTail.slice(0, saveTail.indexOf('\n}\n'));

    out.push({
      name: '保存链路登记持久化意图（不再在事务里排进程内 timer）',
      passed: saveIdx >= 0 && /recordAnalysisIntent\(db, \{/.test(saveBody) && !/scheduleTemporalAnalysis\(/.test(saveBody),
      detail: saveBody ? `意图登记=${/recordAnalysisIntent\(db, \{/.test(saveBody)}、旧调度调用=${/scheduleTemporalAnalysis\(/.test(saveBody)}` : '定位不到 afterTemporalContentSave',
    });
    out.push({
      name: '旧进程内调度器已移除（不得留第二个调度器）',
      passed: !/function scheduleTemporalAnalysis\(/.test(src) && !/const temporalAnalysisQueue = new Map\(\)/.test(src),
      detail: `scheduleTemporalAnalysis=${/function scheduleTemporalAnalysis\(/.test(src)}、temporalAnalysisQueue=${/const temporalAnalysisQueue = new Map\(\)/.test(src)}`,
    });
    out.push({
      name: '生产防抖与最长等待显式传值（800ms，而不是队列默认 15s）',
      passed: /debounceMs: TEMPORAL_ANALYSIS_DEBOUNCE_MS/.test(saveBody) && /maxWaitMs: TEMPORAL_ANALYSIS_MAX_WAIT_MS/.test(saveBody),
      detail: `debounce=${/debounceMs: TEMPORAL_ANALYSIS_DEBOUNCE_MS/.test(saveBody)}、max_wait=${/maxWaitMs: TEMPORAL_ANALYSIS_MAX_WAIT_MS/.test(saveBody)}`,
    });
    out.push({
      name: '启动顺序：先 reconciliation，再事务外领取',
      passed: /function startTemporalDispatcher\(\)/.test(src)
        && /reconcileOnStart\(db, \{ now: Date\.now \}\)/.test(src)
        && /dispatcher\.drain\(\{ max: 5, rearmDelayMs: 800 \}\)/.test(src),
      detail: 'claimNext 只取 queued，不先解放过期 running 就永远碰不到它们',
    });
    out.push({
      name: '后台分析接回追踪上下文（G3c：traceAI 依赖 ALS 上下文）',
      passed: /runWithTraceStore\(/.test(src) && /currentTraceStore\(\)/.test(src),
      detail: '旧 setTimeout 靠请求的 ALS 继承；持久化队列必须显式接回，否则追踪缺 callAI 节点',
    });

    // R1–R4 的"修复前失败、修复后通过"断言必须已落地，并真的被套件执行。
    const fenceRel = 'tests/nsdsh/task-fencing.test.mjs';
    let runnerOk = false;
    try {
      runnerOk = /tests\/nsdsh\/task-fencing\.test\.mjs/.test(fs.readFileSync(abs('scripts/run-nsdsh-tests.mjs'), 'utf8'));
    } catch (_) { runnerOk = false; }
    out.push({
      name: 'R1–R4 行为断言已落地并纳入套件执行',
      passed: fs.existsSync(abs(fenceRel)) && runnerOk,
      detail: `文件=${fs.existsSync(abs(fenceRel))}、已在套件列表=${runnerOk}`,
    });
    return out;
  }

  if (id === 'S03') {
    const svcRel = 'server/services/temporal-services.mjs';
    const svcPath = abs(svcRel);
    if (!fs.existsSync(svcPath)) {
      out.push({ name: '服务模块存在', passed: false, detail: `缺少 ${svcRel}` });
      return out;
    }
    const src = fs.readFileSync(svcPath, 'utf8');

    // (a) 载荷分裂：服务层不得 import server.js / db.js / HTTP / 网络模块。
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const forbidden = imports.filter((s) => /(^|\/)(server\.js|db\.js)$/.test(s) || /^(node:)?(http|https|net|dgram|tls)$/.test(s));
    out.push({
      name: '服务模块不 import server.js / db.js / HTTP / 网络模块',
      passed: forbidden.length === 0,
      detail: forbidden.length ? `违规依赖：${forbidden.join(', ')}` : `import 共 ${imports.length} 个（${imports.join(', ') || '无'}）`,
    });
    const sideEffects = [];
    if (/createServer\s*\(/.test(src)) sideEffects.push('createServer');
    if (/\.listen\s*\(/.test(src)) sideEffects.push('listen');
    if (/new\s+DatabaseSync\s*\(/.test(src)) sideEffects.push('DatabaseSync');
    if (/^\s*await\s/m.test(src)) sideEffects.push('顶层 await');
    out.push({
      name: '服务模块无顶层副作用（不建 server / 不 listen / 不自开数据库 / 无顶层 await）',
      passed: sideEffects.length === 0,
      detail: sideEffects.length ? `发现：${sideEffects.join(', ')}` : '无',
    });

    // (b) 动态：干净子进程 import，断言不监听端口、数据目录仍为空。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nsdsh-s03-check-'));
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const probe = `
import fs from 'node:fs';
const t0 = Date.now();
await import(${JSON.stringify(`file:///${svcPath.replace(/\\/g, '/')}`)});
const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
  .map((h) => h && h.constructor && h.constructor.name).filter(Boolean);
console.log(JSON.stringify({
  ms: Date.now() - t0,
  servers: handles.filter((n) => /Server/.test(n)),
  sockets: handles.filter((n) => /Socket/.test(n)),
  files: fs.readdirSync(${JSON.stringify(dataDir)}),
}));
process.exit(0);`;
      const pr = runCommand([process.execPath, '--input-type=module', '-e', probe], {
        cwd: REPO, timeoutMs: 60000,
        env: { NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1' },
      });
      if (pr.status !== 0) {
        out.push({ name: 'import 服务模块不启动服务、不打开数据库', passed: false, blocked: pr.environmentBlocked, detail: `探针 exit=${pr.status} ${(pr.stderr || '').slice(0, 200)}` });
      } else {
        const info = JSON.parse(String(pr.stdout || '').trim().split('\n').pop());
        const clean = info.servers.length === 0 && info.sockets.length === 0 && info.files.length === 0;
        out.push({
          name: 'import 服务模块不启动服务、不打开数据库',
          passed: clean,
          detail: clean ? `无 Server/Socket 句柄，数据目录仍为空（${info.ms}ms）` : `servers=${info.servers} sockets=${info.sockets} files=${info.files}`,
        });
      }
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 清理失败不掩盖结论 */ }
    }

    // (c) 平权与边界：跑真实套件，只信退出码 + 断言计数。
    for (const [file, label] of [
      ['tests/nsdsh/save-service-parity.test.mjs', '既有夹具的业务输出不变（判据层穷举对照全绿）'],
      ['tests/nsdsh/module-boundaries.test.mjs', '模块边界套件全绿（HTTP 组装留在路由层，用例判据在服务层）'],
    ]) {
      const r = runCommand([process.execPath, file], { cwd: REPO });
      const counts = parseTestCounts(`${r.stdout || ''}\n${r.stderr || ''}`);
      if (r.status === null || r.environmentBlocked) {
        out.push({ name: label, passed: false, blocked: true, detail: `没能跑起来：${r.error || 'status=null'}` });
      } else {
        out.push({
          name: label,
          passed: r.status === 0 && (counts.total || 0) > 0 && (counts.failed || 0) === 0,
          detail: r.status === 0 ? `通过 ${counts.passed} / 未通过 ${counts.failed}` : `exit=${r.status}，counts=${JSON.stringify(counts)}`,
        });
      }
    }
    return out;
  }

  out.push({
    name: `${id} 的 requiredAcceptanceChecks`,
    passed: false,
    detail: '未实现自动判定',
  });
  return out;
}

// ─────────────────────────────── CLI ───────────────────────────────

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    stageId: positional[0] || '',
    offline: flags.has('--offline'),
    json: flags.has('--json'),
    writeReportFlag: flags.has('--write-report'),
    force: flags.has('--force'),
    allowBlocked: flags.has('--allow-blocked'),
    unknown: [...flags].filter((f) => !['--offline', '--json', '--write-report', '--force', '--allow-blocked'].includes(f)),
  };
}

/** 结算：把"该检查什么"算出来，并按需执行命令（供 CLI、--json 与报告骨架共用）。 */
export async function runStage(stageId, { doc, offline = false, cwd = REPO } = {}) {
  const stage = findStage(doc, stageId);
  if (!stage) {
    return { usageError: true, known: (doc.stages || []).map((s) => s.id) };
  }

  const shape = evaluateStageShape(stage);
  if (shape.failures.length) {
    return {
      stage, status: 'FAIL', reason: `清单形状不合法：${shape.failures.map((f) => f.detail).join('；')}`,
      commands: [], artifactChecks: [], failures: shape.failures, blocked: [],
      artifacts: [...(stage.requiredArtifacts || []), ...(stage.requiredTestFiles || [])],
      notes: ['清单形状不合法，因此未执行任何命令（避免用假红污染报告）。'], rawLog: [],
      frozenArtifacts: stage.frozenArtifacts || [],
    };
  }

  // S00 这类"check-stage 出现之前就完成"的阶段：commands 为空、status=done。
  // 它的结论**只能**来自已存在且仍然有效的阶段报告 —— 本工具当时还没写出来，没有命令证据可读。
  // 这一支必须**先**于常规评估：否则空命令列表会被常规逻辑判成"没跑东西 = FAIL"。
  if ((stage.commands || []).length === 0 && String(stage.status) === 'done') {
    const frozenArtifacts = stage.frozenArtifacts || [];
    const v = verifyPrerequisite(stage.id, { frozenArtifacts });
    return {
      stage,
      status: v.ok ? 'PASS' : 'FAIL',
      reason: v.ok ? `历史完成阶段：${v.reason}` : `历史完成阶段的既有报告不可用：${v.reason}`,
      commands: [],
      artifactChecks: (readReport(stage.id) || {}).artifactChecks || [],
      failures: v.ok ? [] : [{ code: 'PREREQUISITE_INVALID', detail: v.reason }],
      blocked: [],
      artifacts: [...(stage.requiredArtifacts || []), ...collectRequiredTestFiles(stage.requiredTestFiles).files],
      notes: [`本阶段在 check-stage.mjs 出现之前完成，commands 本来就是空的：结论取自既有报告（${v.reason}）。`],
      rawLog: [],
      frozenArtifacts,
    };
  }

  const failures = [];
  const blocked = [];
  const notes = [];

  // 运行器尚未实现的阶段：清单没错，只是这个阶段还没开工。记 BLOCKED，永远不判 PASS。
  if (shape.blocked.length) {
    for (const b of shape.blocked) blocked.push({ check: 'stage-runnability', reason: b.detail });
    notes.push(...shape.blocked.map((b) => b.detail));
  }

  const artifacts = verifyRequiredArtifacts(stage.requiredArtifacts);
  failures.push(...artifacts.failures);

  const tests = collectRequiredTestFiles(stage.requiredTestFiles);
  failures.push(...tests.failures);

  const deps = verifyDependencies(stage, doc);
  failures.push(...deps.failures);

  const policy = checkNetworkPolicy(stage, { offline });
  blocked.push(...policy.blocked);
  if (policy.blocked.length) notes.push(`networkPolicy=${policy.policy}：本阶段命令未执行（显式构建前置阶段）。`);

  // 环境不满足时**一条命令都不跑**：跑出来的红是假的，还会污染报告。
  const canRun = failures.length === 0 && blocked.length === 0;
  const commands = [];
  const rawLog = [];
  if (canRun) {
    const env = offline ? { NSDSH_OFFLINE: '1' } : {};
    // blockedSignatures 可以在**阶段**上声明（作用于该阶段所有命令），也可以在**单条命令**上声明。
    // 合并而不是二选一：两者语义相同，都是"命中即环境阻断"，分开处理只会让人猜哪个生效。
    const stageSigs = Array.isArray(stage.blockedSignatures) ? stage.blockedSignatures : [];
    for (const cmd of stage.commands || []) {
      const merged = { ...cmd, blockedSignatures: [...stageSigs, ...(cmd.blockedSignatures || [])] };
      const { entry, raw } = runStageCommand(merged, { cwd, env });
      commands.push(entry);
      rawLog.push(raw);
      if (entry.verdict === 'FAIL') failures.push({ code: 'COMMAND_FAILED', detail: `${entry.id}：${entry.reason}` });
      if (entry.verdict === 'BLOCKED') blocked.push({ check: entry.id, reason: entry.reason });
    }
  } else if (blocked.length === 0 && failures.length) {
    notes.push('存在未满足的产物/前置条件，因此未执行任何命令（避免用假红污染报告）。');
  }

  // 验收项：机器判定，逐条 passed。SKIPPED 项不得让总体变成 PASS。
  //
  // 只在清单**真的声明了**验收项时才跑分派器：没有声明的阶段（例如单测里合成的清单）
  // 不该被塞一条"未实现自动判定"的失败——那会把"这个阶段没声明验收项"误报成"实现缺失"。
  const declared = Array.isArray(stage.requiredAcceptanceChecks) ? stage.requiredAcceptanceChecks : [];
  const artifactChecks = declared.length ? await runAcceptanceChecks(stage.id, { stage, doc }) : [];
  const skippedChecks = artifactChecks.filter((c) => c.blocked);
  for (const c of artifactChecks) {
    if (c.blocked) continue;
    if (!c.passed) failures.push({ code: 'ACCEPTANCE_FAILED', detail: `${c.name}：${c.detail}` });
  }
  for (const c of skippedChecks) blocked.push({ check: c.name, reason: c.detail });

  const computed = computeStageStatus({ failures, blocked, skippedChecks });
  // 显式构建前置阶段（networkPolicy 不是 none/loopback-only）单独报 BLOCKED：
  // 它和"命令跑起来但被沙箱拒了"不是一回事——后者是 PARTIAL（部分证据拿到了），
  // 前者是"整条命令链按设计就不该跑"。两者都用退出码 3，但报告里的字面必须能区分。
  const status = policy.blocked.length && computed.status === 'PARTIAL' ? 'BLOCKED' : computed.status;

  return {
    stage, status, reason: computed.reason, commands, artifactChecks, failures, blocked,
    artifacts: [...(stage.requiredArtifacts || []), ...tests.files], notes, rawLog,
    frozenArtifacts: stage.frozenArtifacts || [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length || !args.stageId) {
    let doc = null;
    try { doc = loadStages(); } catch (_) { /* 清单读不到也要能打出用法 */ }
    const known = doc ? (doc.stages || []).map((s) => s.id).join(', ') : '(清单不可读)';
    console.error(`用法: node scripts/nsdsh/check-stage.mjs <STAGE_ID> [--offline] [--json] [--write-report] [--force] [--allow-blocked]`);
    console.error(`已知阶段：${known}`);
    if (args.unknown.length) console.error(`未知参数：${args.unknown.join(', ')}`);
    process.exit(EXIT.USAGE);
  }

  const doc = loadStages();
  const result = await runStage(args.stageId, { doc, offline: args.offline, cwd: REPO });
  if (result.usageError) {
    console.error(`✗ 未知阶段：${args.stageId}\n已知阶段：${result.known.join(', ')}`);
    process.exit(EXIT.USAGE);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      stage: result.stage.id,
      status: result.status,
      reason: result.reason,
      commands: result.commands,
      artifactChecks: result.artifactChecks,
      artifacts: result.artifacts,
      failures: result.failures,
      blocked: result.blocked,
      notes: result.notes,
    }, null, 2)}\n`);
  } else {
    reportHuman(result);
  }

  if (args.writeReportFlag) {
    ensureReportsDir();
    if (result.rawLog.length) {
      // writeLog 的 suffix 是**不含点号**的（它自己拼 `${id}.${suffix}.log`）。
      // 传默认值 'log' 会得到 `S01.log.log` —— 这里显式传 'raw'，报告日志固定叫 `S01.raw.log`。
      const logPath = writeLog(result.stage.id, redact(result.rawLog.join('')), 'raw');
      console.error(`原始输出已追加：${rel(logPath)}`);
    }
    // 验收项触发的阻断已经在 artifactChecks 里逐条留证；blocked 只保留"命令级"的阻断，
    // 避免同一事实在报告里出现两次（读者会以为阻断项比实际多）。
    const checkNames = new Set(result.artifactChecks.filter((c) => c.blocked).map((c) => c.name));
    const blockedForReport = result.blocked.filter((b) => !checkNames.has(b.check));
    const report = makeReport({
      stage: result.stage.id,
      status: result.status,
      commands: result.commands,
      artifactChecks: result.artifactChecks,
      artifacts: result.artifacts,
      frozenArtifacts: result.frozenArtifacts,
      blocked: blockedForReport,
      notes: [...result.notes, result.reason],
      environment: { offline: args.offline, node: process.version, platform: `${process.platform}-${process.arch}` },
    });
    const w = writeReport(report, { force: args.force });
    console.error(`阶段报告：${rel(w.path)}${w.written ? '' : `（未覆盖：${w.reason}）`}`);
  }

  const code = result.status === 'PASS' ? EXIT.PASS
    : result.status === 'FAIL' ? EXIT.FAIL
      : EXIT.PARTIAL;
  // `--allow-blocked` 是给 CI 的**显式**开关：环境阻断不该把流水线染红，但必须留下痕迹。
  // 它不改任何状态、不写 PASS，只改退出码 —— 没有任何"顺手通过"的空间。
  if (args.allowBlocked && code === EXIT.PARTIAL) {
    console.error(`⚠ --allow-blocked：状态仍是 ${result.status}（环境阻断），仅退出码按 0 返回。这不是通过。`);
    process.exitCode = EXIT.PASS;
  } else {
    process.exitCode = code;
  }
}

function reportHuman(result) {
  const s = result.stage;
  console.log(`阶段 ${s.id} · ${s.title}`);
  console.log(`  清单状态=${s.status} 依赖=[${(s.dependencies || []).join(', ') || '-'}] networkPolicy=${s.networkPolicy || 'none'}`);
  console.log('  命令：');
  if (!result.commands.length) console.log('    （本阶段没有可执行命令 / 或前置条件未满足，未执行）');
  for (const c of result.commands) {
    console.log(`    ${c.verdict} ${c.id}（exit=${c.status} ${c.ms}ms ${c.transport}${c.zeroTestGuard ? ' zeroTestGuard' : ''}）${c.reason}`);
  }
  console.log('  验收项：');
  for (const c of result.artifactChecks) {
    const mark = c.blocked ? 'BLOCKED' : c.passed ? 'ok' : 'FAIL';
    console.log(`    ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  for (const f of result.failures) console.log(`    FAIL ${f.detail}`);
  // 验收项里的阻断已经在上一段逐条打印过（带名字与细节），这里不再重复——
  // 同一个事实打印两遍会让"到底有几项被阻断"看起来比实际更严重。
  const shownBlocked = new Set(result.artifactChecks.filter((c) => c.blocked).map((c) => c.name));
  for (const b of result.blocked) {
    if (shownBlocked.has(b.check)) continue;
    console.log(`    BLOCKED ${b.check}: ${b.reason}`);
  }
  for (const n of result.notes) console.log(`  注：${n}`);
  const failed = result.failures.length + result.commands.filter((c) => c.verdict === 'FAIL').length;
  const passed = result.artifactChecks.filter((c) => c.passed && !c.blocked).length
    + result.commands.filter((c) => c.verdict === 'PASS').length;
  console.log(`\n状态 ${result.status} —— ${result.reason}`);
  console.log(`通过 ${passed}，未通过 ${failed}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && (invoked === self || invoked.endsWith(path.sep + path.basename(self)))) {
  await main();
}

export { main as runCheckStageCli };
