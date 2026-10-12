/**
 * 真实付费评测 · 第 3 步：对**已保存的原始回复**做判决分析（**零计费**，不再调用模型）。
 *
 * ⚠️ 本文件记录一次真实的装置错误链（保留它，因为教训比结论更可复用）：
 *   要判"某个扫描信号是否被**定罪**"，我先后用了三种文本包含写法，**三次都是假阳性**：
 *     ① `JSON.stringify(整份报告).includes('微微')` → 命中 `scan_verdicts` 里的 not_applicable 记录与 summary；
 *     ② `JSON.stringify(issue)` → summary 与 issues 是同一解析对象的**并列键**，仍被混入；
 *     ③ 只读 issue 的 text/evidence → 模型**引用了原句**「她微微侧过身，让出了一条路。」来论述篇幅，仍含「微微」。
 *   正确判据是可核验的**结构化字段**：某条 issue 显式声明 `signal_hit` 等于该信号，且 `verdict` 属定罪档
 *   （confirmed / hypothesis）。与本仓既有教训一致：**判据要落在事实字段上，不要落在文本子串上**。
 */
import fs from 'node:fs';
import path from 'node:path';

const j = JSON.parse(fs.readFileSync(path.resolve('.narrative-repair-116/paid-eval-s01.json'), 'utf8'));

const parseJSONish = (s) => {
  const t = String(s || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cands = [fenced && fenced[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of cands) { try { return JSON.parse(c); } catch (_) {} }
  return null;
};
const A = parseJSONish(j.raw_replies[0]);
const B = parseJSONish(j.raw_replies[1]);

const issues = (r) => (Array.isArray(r && r.issues) ? r.issues : []);
const issueTexts = (r) => issues(r).map((x) => [x && x.text, x && x.evidence, x && x.quote].filter(Boolean).join(' '));

/** 某扫描信号是否被**定罪**：只看结构化字段 signal_hit + verdict。 */
const signalVerdict = (r, kw) => {
  const hit = issues(r).find((x) => String((x && x.signal_hit) || '').includes(kw));
  return hit ? String(hit.verdict || '') : null;
};
const scanVerdict = (r, kw) => {
  const v = (Array.isArray(r && r.scan_verdicts) ? r.scan_verdicts : []).find((x) => String((x && x.signal_hit) || '').includes(kw));
  return v ? String(v.verdict || '') : null;
};
const scanCounter = (r, kw) => {
  const v = (Array.isArray(r && r.scan_verdicts) ? r.scan_verdicts : []).find((x) => String((x && x.signal_hit) || '').includes(kw));
  return v ? String(v.counterevidence || '') : '';
};

const A1 = {
  parsed: !!A,
  weiwei_signalled_in_issue: signalVerdict(A, '微微'),
  weiwei_in_scan_verdicts: scanVerdict(A, '微微'),
  weiwei_counterevidence_len: scanCounter(A, '微微').length,
  issue_count: issues(A).length,
  issue_heads: issueTexts(A).map((t) => t.slice(0, 34)),
  summary_keeps_weiwei: /微微[^。]{0,80}(正常|不宜|不报|保留)/.test(String((A && A.summary) || '')),
};
const B1 = {
  parsed: !!B,
  issue_count: issues(B).length,
  redundancy_issues: issueTexts(B).filter((t) => /没关系|也没关系|没有关系/.test(t)).length,
  negation_issues: issueTexts(B).filter((t) => /没有任何|否定式|否定句/.test(t)).length,
};

const assertions = [
  { id: 'S01-A1', desc: '合法语境的「微微」没有被任何 issue 定罪（不存在 signal_hit=微微 且 verdict 为 confirmed/hypothesis 的条目）',
    pass: A ? !['confirmed', 'hypothesis'].includes(A1.weiwei_signalled_in_issue) : null,
    observed: { weiwei_signalled_in_issue: A1.weiwei_signalled_in_issue } },
  { id: 'S01-A2', desc: '「微微」在 scan_verdicts 里被明确判 not_applicable（命中可被否决）',
    pass: A ? A1.weiwei_in_scan_verdicts === 'not_applicable' : null, observed: { verdict: A1.weiwei_in_scan_verdicts } },
  { id: 'S01-A3', desc: '该 not_applicable 带反证（counterevidence 非空）',
    pass: A ? A1.weiwei_counterevidence_len > 0 : null, observed: { len: A1.weiwei_counterevidence_len } },
  { id: 'S01-A4', desc: '总评明说「微微」是正常用法、不宜硬报（措辞可核）',
    pass: A ? A1.summary_keeps_weiwei : null, observed: { matched: A1.summary_keeps_weiwei } },
  { id: 'S01-B1', desc: '真实冗余/否定句堆叠被报成 issue（不是"零命中"放过）',
    pass: B ? B1.issue_count >= 1 : null, observed: { issue_count: B1.issue_count } },
  { id: 'S01-B2', desc: '至少一条 issue 指向"和…没关系／也没关系"这处可定位引用',
    pass: B ? B1.redundancy_issues >= 1 : null, observed: { matched: B1.redundancy_issues } },
  { id: 'S01-AB', desc: '两侧有区分力：A 侧「微微」不被定罪且被记 not_applicable，B 侧真问题成立',
    pass: (A && B) ? (!['confirmed', 'hypothesis'].includes(A1.weiwei_signalled_in_issue) && A1.weiwei_in_scan_verdicts === 'not_applicable' && B1.issue_count >= 1) : null,
    observed: { a_signal_verdict: A1.weiwei_signalled_in_issue, a_scan_verdict: A1.weiwei_in_scan_verdicts, b_issues: B1.issue_count } },
];

const out = {
  spend_yuan_so_far: j.spend_yuan,
  budget_yuan: 2,
  calls: j.calls,
  replies_parseable: [!!A, !!B],
  A: A1, B: B1, assertions,
  device_error_log: [
    '① 用整份报告做字符串包含 → 命中 scan_verdicts/summary（假阳性）',
    '② 用单个 issue 对象做 stringify → 混入并列的 summary 键（假阳性）',
    '③ 只读 issue 的 text → 引用原句本身含关键词（假阳性）',
    '最终：改用结构化字段 signal_hit + verdict（可核验）',
  ],
};
fs.writeFileSync(path.resolve('.narrative-repair-116/paid-eval-s01-analysis.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ spend_yuan_so_far: out.spend_yuan_so_far, replies_parseable: out.replies_parseable, A: A1, B: B1, assertions }, null, 2));
