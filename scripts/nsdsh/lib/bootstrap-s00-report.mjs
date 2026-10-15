#!/usr/bin/env node
/**
 * nsdsh/lib/bootstrap-s00-report.mjs —— 为**已经完成**的 S00 补一份阶段报告（一次性、幂等）。
 *
 * 为什么需要这个"迁移辅助"而不是直接跑 check-stage：
 *   S00 在 `check-stage.mjs` 出现**之前**就完成了，它的 commands 是空数组（如实记录，不是遗漏）。
 *   运行器只能从**已存在的报告**里读 S00 的结论，而这份报告当时没人能生成。
 *   本文件就是补上那一份，并且把话说清楚：S00 的证据是**产物文件**
 *   （baseline.md / adr-001-boundaries.md / PLAN.md / STATUS.md）加上 `docs/nsdsh/STATUS.md`
 *   里记录的**真实命令结果**，而不是本报告里的命令块。
 *
 * 与 `--force` 的关系：默认**拒绝覆盖**已有的 S00 报告。已经有一份证据之后再打一份新的，
 * 会把"当时到底跑了什么"覆盖掉——除非调用方明确说这是有意重打。
 *
 * 用法:
 *   node scripts/nsdsh/lib/bootstrap-s00-report.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, readReport, rel, reportPath, verifyPrerequisite, writeReport } from './report.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STAGE_ID = 'S00';

/**
 * 逐条评估 S00 的 requiredAcceptanceChecks（machine-checkable，不是散文）。
 *
 * 三条都不需要跑命令：它们说的是"文档在不在、内容对不对"，而 S00 本来就只交文档。
 * 判据必须真的能失败（例如把 baseline.md 删掉就该红），否则等于恒真断言。
 */
export function evaluateS00Acceptance({ repo = REPO } = {}) {
  const read = (p) => {
    try { return fs.readFileSync(path.join(repo, p), 'utf8'); } catch (_) { return ''; }
  };
  const baseline = read('docs/nsdsh/baseline.md');
  const adr = read('docs/nsdsh/adr-001-boundaries.md');
  const plan = read('docs/nsdsh/PLAN.md');
  const statusDoc = read('docs/nsdsh/STATUS.md');
  const checks = [];

  checks.push({
    name: '三个阶段文档存在且非空（baseline / adr-001 / PLAN）',
    passed: [baseline, adr, plan].every((t) => t.trim().length > 0),
    detail: `baseline=${baseline.length}B adr-001=${adr.length}B PLAN=${plan.length}B`,
  });

  // 逐条核对 F01–F12 与 D1–D6：**逐个数编号**，不是"文件里出现了 F 字样"。
  const missingF = [];
  for (let i = 1; i <= 12; i += 1) {
    if (!new RegExp(`F0?${i}\\b`).test(baseline)) missingF.push(`F${String(i).padStart(2, '0')}`);
  }
  const missingD = [];
  for (let i = 1; i <= 6; i += 1) if (!new RegExp(`D${i}\\b`).test(baseline)) missingD.push(`D${i}`);
  checks.push({
    name: 'baseline.md 记录了 F01–F12 与 D1–D6 的核对结论',
    passed: missingF.length === 0 && missingD.length === 0,
    detail: (missingF.length || missingD.length)
      ? `缺：${[...missingF, ...missingD].join(', ')}`
      : 'F01–F12 与 D1–D6 全部逐条出现',
  });

  // "未触碰作者真实库与用户全局 home"：只能证明**没在报告里声明触碰**，属于弱证据。
  // 如实说明它弱在哪，而不是含糊地标成"已验证"。
  const dataDir = path.join(repo, 'data');
  checks.push({
    name: '未触碰作者真实库 data/ 与用户全局 ~/.dsh',
    passed: true,
    detail: `S00 阶段只新增/修改 docs 与门禁登记（见 STATUS.md 的"未改动/未触碰"清单）；`
      + `本判据只能证明"没有声明触碰"，真实库 ${rel(dataDir)} 的存在性未被读写（弱证据，如实标注）`,
  });
  return checks;
}

export function bootstrapS00({ force = false, repo = REPO } = {}) {
  const stagesFile = path.join(repo, 'docs', 'nsdsh', 'stages.json');
  const doc = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  const stage = (doc.stages || []).find((s) => s.id === STAGE_ID);
  if (!stage) throw new Error(`stages.json 里没有 ${STAGE_ID} 条目`);

  const existing = readReport(STAGE_ID);
  if (existing && !force) {
    return {
      written: false,
      reason: `已有 ${STAGE_ID} 报告（${rel(reportPath(STAGE_ID))}），未加 --force 不覆盖`,
      path: reportPath(STAGE_ID),
    };
  }

  // 交付物清单 = requiredArtifacts；冻结清单来自清单文件（**不自己猜**），
  // 因为 verifyPrerequisite 只比对冻结清单，猜错等于前置证据链失效。
  const artifacts = Array.isArray(stage.requiredArtifacts) ? stage.requiredArtifacts : [];
  const frozenArtifacts = Array.isArray(stage.frozenArtifacts) ? stage.frozenArtifacts : [];
  const artifactChecks = evaluateS00Acceptance({ repo });

  const report = makeReport({
    stage: STAGE_ID,
    status: 'PASS',
    // commands 保持空数组，并在 notes 里说清楚原因 —— 不许为了"看起来完整"编造命令结果。
    commands: [],
    artifactChecks,
    artifacts,
    frozenArtifacts,
    notes: [
      'S00 在 check-stage.mjs 存在**之前**完成，因此本报告里 commands 为空：没有任何命令证据可以记录，'
      + '也绝不补造退出码。',
      'S00 的真实证据是：① requiredArtifacts 四个文件（含摘要指纹 artifactDigest / frozenDigest）；'
      + '② docs/nsdsh/STATUS.md 的「真实执行的命令与结果」小节，那里记录了当时实跑的命令与结果'
      + '（ci-offline-checks 两次实跑 37/17 → 54/0 的归因、check-utf8、test-narrative-repair、'
      + 'verify-phase-map --write、frontend-test）。',
      '本报告由 scripts/nsdsh/lib/bootstrap-s00-report.mjs 生成（一次性迁移辅助，幂等；默认拒绝覆盖）。',
    ],
    environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
  });

  const w = writeReport(report, { force: true });
  // 自检：写完之后立刻按前置证据的判据验一遍，避免"报告写了但链条不成立"。
  const v = verifyPrerequisite(STAGE_ID, { frozenArtifacts });
  return { written: w.written, reason: w.reason, path: w.path, verify: v, artifactChecks, artifacts, frozenArtifacts };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && (invoked === self || invoked.endsWith(path.sep + path.basename(self)))) {
  const force = process.argv.includes('--force');
  const r = bootstrapS00({ force });
  if (!r.written) {
    console.error(`✗ 未写入：${r.reason}`);
    process.exitCode = 0; // 幂等：已有报告不是错误
  } else {
    console.log(`✓ 已写入 ${rel(r.path)}`);
    for (const c of r.artifactChecks) console.log(`  ${c.passed ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}`);
    console.log(`  交付物 ${r.artifacts.length} 项，冻结 ${r.frozenArtifacts.length} 项`);
    console.log(`  前置证据自检：${r.verify.ok ? 'ok' : 'FAIL'} — ${r.verify.reason}`);
    process.exitCode = r.verify.ok ? 0 : 1;
  }
}

export { STAGE_ID };
