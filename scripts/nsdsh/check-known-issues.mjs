#!/usr/bin/env node
/**
 * check-known-issues.mjs —— `docs/nsdsh/known-issues.json` 的**结构自检**（S02）。
 *
 * 为什么需要一个独立脚本，而不是只在测试里断言：
 *   ① 这份文件是**跨阶段契约**——S03–S18 各自要把它认领的条目关掉；
 *      一旦它的结构坏了（缺 fixStage、到期条件为空、id 重复），后续阶段会"看起来没有待修项"。
 *   ② 它必须能被 CI 与 `check-stage` 直接调用（退出码判定），而不是靠人读 JSON。
 *   ③ 它要检查的是**自洽性**，不是内容正确性：`summary` 里手写的数字必须等于从 `issues` 推导出来的数字。
 *      实测教训：本文件第一次写出来时，我把 high 手写成 6（实际 7）、low 手写成 2（实际 1）——
 *      手写汇总与明细漂移是这类台账最典型的腐烂方式，所以这里**逐项复算**。
 *
 * 退出码：0 = 结构自洽；1 = 有结构问题；2 = 文件缺失/不是合法 JSON。
 *
 * 用法：node scripts/nsdsh/check-known-issues.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(REPO, 'docs', 'nsdsh', 'known-issues.json');
const STAGES_FILE = path.join(REPO, 'docs', 'nsdsh', 'stages.json');

/** 允许的状态取值（与 known-issues.json 的 fieldNotes 对应）。 */
const STATUSES = new Set(['open', 'fixed_locally', 'not_directly_detectable']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

function fail(msg, problems) {
  problems.push(msg);
}

export function check() {
  const problems = [];
  if (!fs.existsSync(FILE)) {
    return { ok: false, problems: [`缺少 ${path.relative(REPO, FILE).replace(/\\/g, '/')}`], doc: null };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    return { ok: false, problems: [`known-issues.json 不是合法 JSON：${e.message}`], doc: null };
  }

  const issues = Array.isArray(doc.issues) ? doc.issues : [];
  if (!issues.length) fail('issues 为空：拒绝把"没有已知问题"当作通过', problems);

  // 阶段顺序取自 stages.json（唯一事实来源），避免这里再抄一份阶段清单。
  let stageOrder = [];
  try {
    const stages = JSON.parse(fs.readFileSync(STAGES_FILE, 'utf8'));
    stageOrder = (stages.stages || []).map((s) => s.id);
  } catch (e) {
    fail(`无法读取阶段清单以校验 fixStage：${e.message}`, problems);
  }
  const stageSet = new Set(stageOrder);
  const orderIndex = new Map(stageOrder.map((id, i) => [id, i]));

  const seen = new Set();
  const sev = {};
  const st = {};
  const byStage = {};
  for (const it of issues) {
    const id = it && it.id;
    if (!id) { fail('存在没有 id 的条目', problems); continue; }
    if (seen.has(id)) fail(`id 重复：${id}`, problems);
    seen.add(id);
    if (!SEVERITIES.has(it.severity)) fail(`${id} 的 severity 非法：${JSON.stringify(it.severity)}`, problems);
    if (!STATUSES.has(it.status)) fail(`${id} 的 status 非法：${JSON.stringify(it.status)}`, problems);
    if (!Array.isArray(it.evidence) || !it.evidence.length) fail(`${id} 缺少 evidence（没有证据的缺陷不得登记为缺陷）`, problems);
    if (!it.fixStage) fail(`${id} 缺少 fixStage`, problems);
    else if (!stageSet.has(it.fixStage)) fail(`${id} 的 fixStage 不在阶段清单里：${it.fixStage}`, problems);
    // 到期条件对**未修**的条目必须有（否则等于永久跳过）；已修的条目改为必须有**修复证据**
    // （不能只写一个状态就宣布修好了——那正是"把描述当通过"的另一种形态）。
    if (it.status === 'fixed_locally') {
      if (!it.evidenceNote || !String(it.evidenceNote).trim()) {
        fail(`${id} 声明 fixed_locally 但没有 evidenceNote（修复证据）：不得只改状态就宣告已修`, problems);
      }
    } else if (!it.expiry || !String(it.expiry).trim()) {
      fail(`${id} 缺少到期条件 expiry`, problems);
    }
    if (!it.behaviorTest || !String(it.behaviorTest).trim()) fail(`${id} 缺少行为表征测试 behaviorTest`, problems);
    // fixStage 门禁按**状态**分开：
    //   · open / not_directly_detectable → 修复必须落在 S02 之后（S02 只表征、不修）；
    //   · fixed_locally → 修复已经发生，fixStage 记的是"它被哪个阶段修掉了"，因此不设下界。
    if ((it.status === 'open' || it.status === 'not_directly_detectable')
      && it.fixStage && orderIndex.has(it.fixStage) && orderIndex.get(it.fixStage) <= orderIndex.get('S02')) {
      fail(`${id} 的 fixStage=${it.fixStage} 不晚于 S02：S02 只做表征，修复必须落在之后的阶段`, problems);
    }
    sev[it.severity] = (sev[it.severity] || 0) + 1;
    st[it.status] = (st[it.status] || 0) + 1;
    (byStage[it.fixStage] = byStage[it.fixStage] || []).push(id);
  }

  // summary 必须与明细一致（逐项复算，不信手写值）。
  const s = doc.summary || {};
  const expect = {
    total: issues.length,
    high: sev.high || 0,
    medium: sev.medium || 0,
    low: sev.low || 0,
    open: st.open || 0,
    notDirectlyDetectable: st.not_directly_detectable || 0,
    fixedLocally: st.fixed_locally || 0,
  };
  for (const [k, v] of Object.entries(expect)) {
    if (s[k] !== v) fail(`summary.${k}=${JSON.stringify(s[k])} 与明细复算值 ${v} 不一致`, problems);
  }
  const declaredStage = s.byFixStage || {};
  const allKeys = new Set([...Object.keys(declaredStage), ...Object.keys(byStage)]);
  for (const k of allKeys) {
    const a = [...(byStage[k] || [])].sort().join(',');
    const b = [...(declaredStage[k] || [])].sort().join(',');
    if (a !== b) fail(`summary.byFixStage.${k}=[${b}] 与明细推导 [${a}] 不一致`, problems);
  }

  return { ok: problems.length === 0, problems, doc, derived: { severity: sev, status: st, byFixStage: byStage } };
}

// CLI：仅在被直接执行时运行（被 import 时不得执行，否则测试会连带写输出）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const asJson = process.argv.includes('--json');
  const r = check();
  if (asJson) {
    console.log(JSON.stringify({ ok: r.ok, problems: r.problems, derived: r.derived || null }, null, 2));
  } else {
    const n = r.doc && Array.isArray(r.doc.issues) ? r.doc.issues.length : 0;
    console.log(`known-issues 结构自检：${n} 条登记`);
    if (r.ok) {
      const s = r.doc.summary;
      console.log(`  ok  severity ${JSON.stringify(r.derived.severity)}`);
      console.log(`  ok  status   ${JSON.stringify(r.derived.status)}`);
      console.log(`  ok  按修复阶段：${Object.entries(r.derived.byFixStage).map(([k, v]) => `${k}(${v.length})`).join(' ')}`);
      console.log(`  ok  summary 与明细复算一致（total=${s.total}）`);
    } else {
      for (const p of r.problems) console.log(`  FAIL ${p}`);
    }
    console.log(`通过 ${r.ok ? 1 : 0}，未通过 ${r.ok ? 0 : 1}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
