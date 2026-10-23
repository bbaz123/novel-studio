#!/usr/bin/env node
/**
 * test-acceptance-checks.mjs —— 逐项验收的**子条件合成**（REV-03…REV-08，零计费）。
 *
 * 依据：docs/quality-audit-p0-merge-protection-plan-20261022.md §5。
 *
 * 为什么必须拆成子条件（方案 §2 的真实六项）：
 *   R-0004 = 「群众重复叹息已压缩」+「主角放松的状态可见」两件独立的事。
 *   只让模型给一个词时，它很容易把"我删了重复"当成"这项修好了" —— 于是作者看到 PASS，
 *   正文里却依然看不到主角的状态。这里把合成规则钉死：先严后宽，模型单独说的那个词不作数。
 *
 * 用法: node scripts/quality-auditor/test-acceptance-checks.mjs
 */
import { effectiveVerdictOf, normalizeChecks, revisionOverallVerdict, repairTargets } from '../../ai/quality-auditor/revision-integrity.mjs';
import { mergeRevision } from '../../ai/quality-auditor/merge-revision.mjs';
import { validateRevisionAuditPayload } from '../../ai/quality-auditor/contracts.mjs';

let pass = 0;
const fails = [];
const ok = (id, name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${id} ${name}`); }
  else { fails.push(`${id} ${name}`); console.log(`  ✗ ${id} ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('逐项验收子条件（REV-03…REV-08，零计费）');

// ── REV-03：多子条件，其中一个未达成 → PARTIAL（不能只凭删了重复就 PASS）────
{
  const r = effectiveVerdictOf({
    verdict: 'PASS',
    checks: [
      { key: 'duplicate_crowd_sigh_reduced', kind: 'soft', status: 'PASS', evidence: '第二次叹息已压缩' },
      { key: 'hero_relief_visible', kind: 'soft', status: 'FAIL', evidence: '候选里没有任何"放松/缓了一口气"的可见反应' },
    ],
  });
  ok('REV-03', 'R-0004 形态：群众重复已压缩 + 主角状态不可见 → PARTIAL（模型说 PASS 也不算）',
    r.verdict === 'PARTIAL' && r.derived === true && /hero_relief_visible/.test(r.reason),
    JSON.stringify(r));
}

// ── REV-04：硬条件 FAIL 压过一切（含模型 PASS）──────────────────────────────
{
  const r = effectiveVerdictOf({
    verdict: 'PASS',
    checks: [
      { key: 'keep_math_deadline', kind: 'hard', status: 'FAIL' },
      { key: 'style_ok', kind: 'soft', status: 'PASS' },
    ],
  });
  ok('REV-04', '硬条件未通过 → FAIL（不被任何软条件或模型结论覆盖）',
    r.verdict === 'FAIL' && /硬条件/.test(r.reason), JSON.stringify(r));
}

// ── REV-05：缺资料不得自动上调（NEED_CONTEXT 不能被 PASS 掉）────────────────
{
  const r = effectiveVerdictOf({
    verdict: 'PASS',
    checks: [
      { key: 'system_voice_carrier', kind: 'context', status: 'UNKNOWN' },
      { key: 'others_ok', kind: 'soft', status: 'PASS' },
    ],
  });
  ok('REV-05', 'context 类子条件未确认 → NEED_CONTEXT（不能说"其余都过所以通过"）',
    r.verdict === 'NEED_CONTEXT', JSON.stringify(r));
}

// ── REV-06：全部必需通过才算 PASS；状态缺失按未判定处理 ─────────────────────
{
  const allPass = effectiveVerdictOf({ checks: [{ key: 'a', kind: 'hard', status: 'PASS' }, { key: 'b', kind: 'soft', status: 'PASS' }] });
  const missing = effectiveVerdictOf({ verdict: 'PASS', checks: [{ key: 'a', kind: 'soft', status: 'PASS' }, { key: 'b', kind: 'soft' }] });
  const illegal = effectiveVerdictOf({ verdict: 'PASS', checks: [{ key: 'a', kind: 'soft', status: 'MAYBE' }] });
  ok('REV-06', '全部 PASS 才 PASS；状态缺失/非法一律按未判定（PARTIAL），不得默认通过',
    allPass.verdict === 'PASS' && missing.verdict === 'PARTIAL' && illegal.verdict === 'PARTIAL',
    JSON.stringify({ allPass: allPass.verdict, missing: missing.verdict, illegal: illegal.verdict }));
}

// ── REV-07：与「确定性硬失败优先」共存：接口层拿到的终态仍是最终裁决 ─────────
{
  const deterministic = {
    ok: true,
    hard_failures: [],
    issues: [{ issue_id: 'R-0004', deterministic: 'PARTIAL', reason: '等待语义复核', checks: [] }],
  };
  const auditor = {
    issues: [{
      issue_id: 'R-0004', verdict: 'PASS',
      checks: [
        { key: 'duplicate_crowd_sigh_reduced', kind: 'soft', status: 'PASS' },
        { key: 'hero_relief_visible', kind: 'soft', status: 'FAIL' },
      ],
    }],
  };
  const v = revisionOverallVerdict({ deterministic, auditor });
  const item = v.issues[0];
  ok('REV-07', '子条件合成进入最终裁决：declared=PASS 但合成 PARTIAL，且原裁决被留下',
    item.final === 'PARTIAL' && item.auditor_verdict === 'PARTIAL' && item.verdict_declared === 'PASS'
      && item.verdict_derived === true && item.acceptance_checks.length === 2,
    JSON.stringify(item));
}

// ── REV-08：定向复修目标只包含未通过项；回归项单独上报 ─────────────────────
{
  const deterministic = {
    ok: true, hard_failures: [], issues: [
      { issue_id: 'R-0001', deterministic: 'PASS', checks: [] },
      { issue_id: 'R-0005', deterministic: 'PARTIAL', checks: [] },
    ],
  };
  const auditor = {
    issues: [
      { issue_id: 'R-0001', verdict: 'PASS', checks: [] },
      { issue_id: 'R-0005', verdict: 'PARTIAL', checks: [{ key: 'no_repeat_rounds', kind: 'hard', status: 'FAIL' }] },
    ],
    regressions: [{ issue_id: 'R-0001', reason: '本轮把上一轮已通过的 R-0001 改回去了' }],
  };
  const merged = mergeRevision({ deterministic, auditor, round: 0, maxRounds: 2 });
  const r5 = merged.result.issues.find((i) => i.issue_id === 'R-0005');
  ok('REV-08', '只把未通过项列进复修目标；整体不得显示"全部完成"；回归项单独上报',
    merged.repair.issue_ids.join(',') === 'R-0005'
      && merged.all_pass === false
      && merged.result.overall !== 'PASS'
      && merged.regressions.length === 1,
    JSON.stringify({ targets: merged.repair.issue_ids, overall: merged.result.overall, allPass: merged.all_pass }));
  ok('REV-08b', '子条件的失败证据进入 remaining_evidence（驱动定向复修的那份线索）',
    (r5.remaining_evidence || []).some((e) => e.from === 'acceptance_check' && e.key === 'no_repeat_rounds'),
    JSON.stringify(r5.remaining_evidence));
}

// ── 契约：子条件形状非法必须可定位（否则合成规则会被脏数据绕过）──────────────
{
  const bad = validateRevisionAuditPayload({
    schema_version: 'revision-audit.v1', overall: 'PARTIAL',
    issues: [{ issue_id: 'R-0006', verdict: 'PASS', checks: [{ key: '', kind: 'soft', status: 'PASS' }, { key: 'x', kind: 'weird', status: 'MAYBE' }] }],
  }, { selectedIssueIds: ['R-0006'] });
  const fields = bad.defects.map((d) => d.field_path);
  ok('REV-09', '子条件缺 key / kind 非法 / status 非法 → 逐字段缺陷，且提交被拒',
    bad.ok === false && fields.some((f) => /checks\[\]\.key/.test(f))
      && fields.some((f) => /checks\[x\]\.kind/.test(f)) && fields.some((f) => /checks\[x\]\.status/.test(f)),
    JSON.stringify(fields));

  const good = validateRevisionAuditPayload({
    schema_version: 'revision-audit.v1', overall: 'PARTIAL',
    issues: [{ issue_id: 'R-0006', verdict: 'PARTIAL', reason: '尾段仍复述死线', checks: [{ key: 'no_repeated_deadline', kind: 'soft', status: 'FAIL', evidence: '数学卷还等着他' }] }],
  }, { selectedIssueIds: ['R-0006'] });
  ok('REV-10', '形状合法的子条件提交通过（fail-closed 不能把正常路径也挡住）',
    good.ok === true, JSON.stringify(good.errors));

  ok('REV-11', 'normalizeChecks 不吞掉非法值（kind/status 非法会被标出来，而不是静默改成合法）',
    (() => {
      const list = normalizeChecks([{ key: 'a', kind: 'weird', status: 'MAYBE' }]);
      return list.length === 1 && list[0].kind === 'soft' && list[0].kind_invalid === true
        && list[0].status === 'UNKNOWN' && list[0].status_invalid === true;
    })());
}

console.log(`\n子条件合成：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
