/**
 * tests/nsdsh/stage-runner.test.mjs —— 阶段运行器**纯判据**的断言面（S01，零依赖、零计费）。
 *
 * 这里断言的全是 `scripts/nsdsh/check-stage.mjs` 导出的**纯函数**（不跑真实阶段、不起子进程，
 * 只调一次 `bootstrap` 报告写盘做前置证据的阴性对照）。为什么坚持"import 而不是复制判据"：
 * 判据一旦在测试里抄一份，测试就只证明"抄的那份对"，而真实门禁可以静默漂移。
 *
 * 覆盖的失败模式（每一条都对应一次真实误判）：
 *   · 空测试清单被判成通过（"没找到测试"= 绿）；
 *   · 产物缺失却因为命令退出码 0 而通过；
 *   · 零测试 / 解析不出计数却因为退出码 0 而通过；
 *   · 环境阻断（spawn EPERM）被记成回归；
 *   · 前置阶段报告还在、但交付物早被改过（陈旧证据）；
 *   · 未知阶段 id 被"宽宏大量"地放过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyCommand, collectRequiredTestFiles, computeStageStatus, evaluateStageShape,
  readTestCounts, runStage, verifyRequiredArtifacts,
} from '../../scripts/nsdsh/check-stage.mjs';
import { parseTestCounts } from '../../scripts/nsdsh/lib/gate.mjs';
import { REPO, findStage, loadStages, makeReport, readReport, reportPath, verifyPrerequisite, writeReport } from '../../scripts/nsdsh/lib/report.mjs';

function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      const r = fn();
      // 同步用例不该返回 thenable：真返回了就说明这个用例其实是异步的，
      // 用错 suite() 会让断言在套件汇总**之后**才抛出（计数显示通过、进程却红）。
      if (r && typeof r.then === 'function') {
        throw new Error('异步用例必须放进 suiteAsync()，否则断言抛在汇总之后');
      }
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

/** 异步用例版（runStage 是 async；语义与 suite 相同）。 */
async function suiteAsync(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

/** 一个形状合法的最小阶段声明（各用例只改它关心的那一处）。 */
const baseStage = (over = {}) => ({
  id: 'TX',
  status: 'pending',
  dependencies: [],
  requiredArtifacts: ['package.json'],
  requiredTestFiles: ['tests/nsdsh/isolation.test.mjs'],
  commands: [{ id: 'noop', argv: ['-e', 'process.exit(0)'], cwd: '.', zeroTestGuard: true }],
  networkPolicy: 'loopback-only',
  ...over,
});

await suite('nsdsh/stage-runner', [
  ['空的 requiredTestFiles 必须判失败（0 tests ≠ pass）', () => {
    const r = evaluateStageShape(baseStage({ requiredTestFiles: [] }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((f) => f.code), ['TEST_LIST_EMPTY']);
  }],

  ['形状合法的最小阶段必须判通过（判据不是恒真）', () => {
    const r = evaluateStageShape(baseStage());
    assert.equal(r.ok, true, `不该失败：${JSON.stringify(r.failures)}`);
    assert.deepEqual(r.failures, []);
  }],

  ['commands 为空且 status != done → 只能 BLOCKED，不能 PASS（形状上不是失败）', () => {
    const r = evaluateStageShape(baseStage({ commands: [] }));
    assert.deepEqual(r.failures, [], '清单没写错，不该记 failure');
    assert.equal(r.blocked.length, 1);
    assert.equal(r.blocked[0].code, 'NO_COMMANDS_NOT_DONE');
    assert.equal(computeStageStatus({ blocked: r.blocked }).status, 'PARTIAL');
  }],

  ['唯一合法的空测试清单形态：status=done 且 commands 为空', () => {
    const r = evaluateStageShape(baseStage({ status: 'done', commands: [] }));
    assert.equal(r.ok, true, `不该失败：${JSON.stringify(r.failures)}`);
  }],

  ['requiredArtifacts 缺失的文件必须判失败', () => {
    const r = verifyRequiredArtifacts(['scripts/nsdsh/__definitely_missing__.mjs']);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].code, 'ARTIFACT_MISSING');
  }],

  ['requiredArtifacts 是空文件也必须判失败（产物不算交付）', () => {
    const p = path.join(REPO, '.nsdsh', 'empty-artifact-probe.txt');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
    try {
      const r = verifyRequiredArtifacts([path.relative(REPO, p)]);
      assert.equal(r.failures.length, 1);
      assert.equal(r.failures[0].code, 'ARTIFACT_EMPTY');
    } finally { fs.rmSync(p, { force: true }); }
  }],

  ['requiredTestFiles 的 pattern 匹配 0 个文件必须判失败', () => {
    const r = collectRequiredTestFiles(['tests/nsdsh/__no_such_suite__*.test.mjs']);
    assert.equal(r.files.length, 0);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].code, 'TEST_PATTERN_EMPTY');
  }],

  ['requiredTestFiles 展开成真实文件（glob 由 Node 展开，不靠 shell）', () => {
    const r = collectRequiredTestFiles(['tests/nsdsh/*.test.mjs']);
    assert.equal(r.failures.length, 0);
    assert.ok(r.files.length >= 3, `期望至少 3 个套件，实际 ${r.files.length}`);
    assert.ok(r.files.every((f) => f.endsWith('.test.mjs')));
  }],

  ['zeroTestGuard：输出里没有汇总行 → FAIL（无法证明测试数量）', () => {
    const r = classifyCommand(baseStage().commands[0], { status: 0, stdout: '啥也没打印', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason, /解析不出测试数量/);
  }],

  ['zeroTestGuard：解析到 0 条测试 → FAIL', () => {
    const r = classifyCommand(baseStage().commands[0], { status: 0, stdout: '通过 0 / 未通过 0', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason, /0 条测试/);
  }],

  ['zeroTestGuard：退出码 0 且计数 > 0 → PASS', () => {
    const r = classifyCommand(baseStage().commands[0], { status: 0, stdout: '  ok a\n通过 3 / 未通过 0', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'PASS');
    assert.equal(r.counts.total, 3);
  }],

  ['zeroTestGuard：退出码 0 但报告有失败 → FAIL', () => {
    const r = classifyCommand(baseStage().commands[0], { status: 0, stdout: '通过 2 / 未通过 1', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'FAIL');
    assert.match(r.reason, /1 条失败/);
  }],

  ['无 zeroTestGuard：退出码 0 → PASS（不强制要求计数）', () => {
    const cmd = baseStage({ commands: [{ id: 'plain', argv: ['-e', '0'] }] }).commands[0];
    const r = classifyCommand(cmd, { status: 0, stdout: '', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'PASS');
  }],

  ['环境阻断（进程没跑起来）→ BLOCKED，不是 FAIL', () => {
    const r = classifyCommand(baseStage().commands[0], { status: null, stdout: '', stderr: '', transport: 'file-redirect', environmentBlocked: true, error: 'EPERM' });
    assert.equal(r.status, 'BLOCKED');
    assert.match(r.reason, /环境阻断/);
  }],

  ['环境阻断（子进程自己再 spawn 被拒）→ BLOCKED，不是 FAIL', () => {
    const r = classifyCommand(baseStage({ commands: [{ id: 'x', argv: ['-e', '0'] }] }).commands[0], {
      status: 1, stdout: '', stderr: 'Error: spawn EPERM errno: -4048', transport: 'pipe',
    });
    assert.equal(r.status, 'BLOCKED');
  }],

  ['真失败：status=1 且没有环境指纹 → FAIL', () => {
    const r = classifyCommand(baseStage({ commands: [{ id: 'x', argv: ['-e', '0'] }] }).commands[0], { status: 1, stdout: 'assertion failed', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'FAIL');
  }],

  ['清单声明的 blockedSignatures 命中即 BLOCKED', () => {
    const cmd = { id: 'x', argv: ['-e', '0'], blockedSignatures: ['sandbox refused'] };
    const r = classifyCommand(cmd, { status: 2, stdout: 'Sandbox Refused to start', stderr: '', transport: 'pipe' });
    assert.equal(r.status, 'BLOCKED');
    assert.match(r.reason, /blockedSignatures/);
  }],

  ['零测试读数：优先采信 NSDSH-SUMMARY 标记行，而不是子套件打印的那一行', () => {
    // 真实场景：run-nsdsh-tests 的输出里**先**出现子套件的 `通过 11 / 未通过 0`，
    // 再出现本命令自己的标记行。parseTestCounts 只取第一处匹配 → 会报 11（子套件的读数）。
    const text = '子套件输出……\n' + '  ok a\n[nsdsh/isolation] PASS 11 / FAIL 0\n'
      + '合计：通过 44，未通过 0（断言总数 44 条）\n'
      + 'NSDSH-SUMMARY: suites=3 suitesFailed=0 passed=44 failed=0 total=44\n';
    assert.equal(parseTestCounts(text).total, 11, '前提：裸解析确实会取到子套件的读数');
    const c = readTestCounts(text);
    assert.equal(c.source, 'summary-marker');
    assert.equal(c.total, 44, '标记行给出了本命令自己的断言总数');
    assert.equal(c.failed, 0);
    // 没有标记行时退回解析，语义与从前一致。
    const fallback = readTestCounts('通过 7 / 未通过 0\n');
    assert.equal(fallback.source, 'parsed-output');
    assert.equal(fallback.total, 7);
  }],

  ['阶段状态：有 FAIL → FAIL；只有 BLOCKED → PARTIAL；全干净 → PASS', () => {
    assert.equal(computeStageStatus({ failures: [{ detail: 'x' }] }).status, 'FAIL');
    assert.equal(computeStageStatus({ blocked: [{ check: 'x' }] }).status, 'PARTIAL');
    assert.equal(computeStageStatus({}).status, 'PASS');
    assert.equal(computeStageStatus({ failures: [], blocked: [{ check: 'a' }, { check: 'b' }] }).status, 'PARTIAL');
  }],

  ['阶段状态：必检项 SKIPPED（未被评估）不得给出 PASS', () => {
    const r = computeStageStatus({ skippedChecks: ['某项未实现自动判定'] });
    assert.equal(r.status, 'PARTIAL');
    assert.match(r.reason, /SKIPPED/);
  }],

  ['docs/nsdsh/stages.json 里 S01 的清单形状合法（不是合成样例）', () => {
    const doc = loadStages();
    const s01 = findStage(doc, 'S01');
    assert.ok(s01, 'stages.json 里必须有 S01');
    const shape = evaluateStageShape(s01);
    assert.equal(shape.ok, true, `S01 形状不合法：${JSON.stringify(shape.failures)}`);
    assert.ok(s01.frozenArtifacts.length >= 10, 'S01 必须声明冻结交付物清单');
  }],

  ['前置证据：交付物在报告之后被改动 → verifyPrerequisite 必须拒绝', () => {
    // 报告文件路径带 pid：check-stage 的验收项会**同时**再起一份本套件，
    // 用固定文件名两份会互相覆盖报告与产物，产生与判据无关的假红（实测踩到）。
    const id = `TXPREREQ${process.pid}`;
    // 两个交付物：一个进**冻结清单**，一个只进 artifactDigest（模拟 STATUS.md 这类按设计会长的文档）。
    const frozenRel = `.nsdsh/reports/__txprereq_frozen_${process.pid}.txt`;
    const looseRel = `.nsdsh/reports/__txprereq_loose_${process.pid}.txt`;
    const abs = (r) => path.join(REPO, r);
    fs.mkdirSync(path.dirname(abs(frozenRel)), { recursive: true });
    fs.writeFileSync(abs(frozenRel), '版本一', 'utf8');
    fs.writeFileSync(abs(looseRel), '会长大的文档', 'utf8');
    const report = makeReport({
      stage: id, status: 'PASS', artifacts: [frozenRel, looseRel], frozenArtifacts: [frozenRel],
      artifactChecks: [{ name: '合成前置检查', passed: true, detail: 'test' }],
    });
    writeReport(report, { force: true });
    try {
      assert.equal(verifyPrerequisite(id, { frozenArtifacts: [frozenRel] }).ok, true);

      // ① 只改**非冻结**交付物：前置证据必须仍然有效（否则 STATUS.md 那种文档一追加就误判失效）。
      fs.writeFileSync(abs(looseRel), '又长了一截', 'utf8');
      assert.equal(verifyPrerequisite(id, { frozenArtifacts: [frozenRel] }).ok, true,
        '非冻结交付物变化不得让前置证据失效');

      // ② 改**冻结**交付物：报告仍在、状态仍是 PASS，但证据必须失效。
      fs.writeFileSync(abs(frozenRel), '版本二（被改过）', 'utf8');
      const after = verifyPrerequisite(id, { frozenArtifacts: [frozenRel] });
      assert.equal(after.ok, false);
      assert.match(after.reason, /冻结交付物在报告之后被改动/);

      // ③ 不管冻结清单，摘指纹永远算的是当前文件内容 —— 改了就是改了。
      assert.equal(report.frozenDigest.files.length, 1);
      assert.equal(report.artifactDigest.files.length, 2);
    } finally {
      fs.rmSync(abs(frozenRel), { force: true });
      fs.rmSync(abs(looseRel), { force: true });
      fs.rmSync(reportPath(id), { force: true });
    }
  }],

  ['前置证据：已 PASS 的报告里若有未通过验收项 → 拒绝', () => {
    const id = `TXPREREQ2_${process.pid}`;
    writeReport(makeReport({
      stage: id, status: 'PASS', artifacts: [], frozenArtifacts: [],
      artifactChecks: [{ name: '未通过的项', passed: false, detail: '故意失败' }],
    }), { force: true });
    try {
      const r = verifyPrerequisite(id, { frozenArtifacts: [] });
      assert.equal(r.ok, false);
      assert.match(r.reason, /验收项未通过/);
    } finally { fs.rmSync(reportPath(id), { force: true }); }
  }],

  ['前置证据：缺少报告 → 拒绝，且理由说清缺哪份', () => {
    const r = verifyPrerequisite('TXNOSUCHREPORT', { frozenArtifacts: [] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /缺少 TXNOSUCHREPORT 的阶段报告/);
  }],
]);

await suiteAsync('nsdsh/stage-runner（异步：真实 runStage）', [
  ['未知阶段 id → runStage 明确报"未知"并给出已知 id（不静默放过）', async () => {
    const doc = loadStages();
    const r = await runStage('S99', { doc });
    assert.equal(r.usageError, true);
    assert.ok(r.known.includes('S01'));
    assert.equal(readReport('S99'), null, '未知阶段不得写出任何报告');
  }],

  ['networkPolicy 需要显式构建前置条件的阶段：--offline 下记 BLOCKED 且一条命令都不跑', async () => {
    // 直接构造一个合成清单，避免把真实阶段的状态（可能尚未实现）当成判据。
    const doc = {
      stages: [{
        id: 'TXNET', title: '合成：构建前置阶段', status: 'pending', dependencies: [],
        requiredArtifacts: ['package.json'], requiredTestFiles: ['tests/nsdsh/isolation.test.mjs'],
        commands: [{ id: 'should-not-run', argv: ['-e', 'process.exit(0)'] }],
        networkPolicy: 'build-prereq-explicit',
        frozenArtifacts: [],
        requiredAcceptanceChecks: [],
      }],
    };
    const r = await runStage('TXNET', { doc, offline: true });
    // 显式构建前置阶段报 BLOCKED（不是 PARTIAL）：整条命令链按设计就不该跑。
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.commands.length, 0, '不得执行任何命令');
    assert.ok(r.blocked.some((b) => b.check === 'network-policy'));
  }],

  ['产物缺失时一条命令都不跑（不用假红污染报告）', async () => {
    const doc = {
      stages: [{
        id: 'TXMISS', title: '合成：产物缺失', status: 'pending', dependencies: [],
        requiredArtifacts: ['__no_such_artifact__.mjs'], requiredTestFiles: ['tests/nsdsh/isolation.test.mjs'],
        commands: [{ id: 'should-not-run', argv: ['-e', 'process.exit(0)'] }],
        networkPolicy: 'loopback-only', frozenArtifacts: [], requiredAcceptanceChecks: [],
      }],
    };
    const r = await runStage('TXMISS', { doc });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.commands.length, 0);
    assert.ok(r.failures.some((f) => f.code === 'ARTIFACT_MISSING'));
  }],

  ['S00 这类"运行器之前就完成"的阶段：结论只来自既有报告，命令块保持为空', async () => {
    const doc = loadStages();
    const r = await runStage('S00', { doc });
    assert.equal(r.commands.length, 0, 'S00 的 commands 本来就是空的，不许补造');
    assert.ok(['PASS', 'FAIL'].includes(r.status));
    assert.ok(r.notes.some((n) => n.includes('既有报告') || n.includes('未能作为证据')));
  }],
]);
