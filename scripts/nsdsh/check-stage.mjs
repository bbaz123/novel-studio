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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksEnvironmentBlocked, parseTestCounts, runCommand } from './lib/gate.mjs';
import { probeEgressDenied, probeLoopbackAllowed } from './lib/egress.mjs';
import { ensureReportsDir, expandGlob, findStage, loadStages, makeReport, readReport, redact, rel, writeLog, writeReport, verifyPrerequisite, abs, REPO } from './lib/report.mjs';
import { startFakeModel } from './lib/isolate.mjs';

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
