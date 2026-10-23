/**
 * ai/quality-auditor/contracts.mjs —— 质量审计的**契约与状态机**（纯函数，无 IO）。
 *
 * 这一层只做四件事：
 *   ① 定义 run 状态机与合法迁移（服务端事务据此拒绝跳态）；
 *   ② 定义 review-audit.v1 / revision-audit.v1 的结构校验（含证据逐字核验的入口）；
 *   ③ 定义资源名、分页与体积上限（越界一律拒绝，不截断后当成通过）；
 *   ④ 定义错误码（前端按真实码显示，不把所有失败归为"DSH 不可用"）。
 *
 * 为什么把校验写成纯函数：它要被 API、协调器、离线测试三处调用。写成"顺手在 handler 里判"，
 * 三处的判据必然漂移 —— 而"结果是否合法"正是这套审计唯一的产出物，判据不能有两份。
 */

export const CONTRACT_VERSION = 'novel-quality-audit.v1';
export const REVIEW_AUDIT_SCHEMA = 'review-audit.v1';
export const REVISION_AUDIT_SCHEMA = 'revision-audit.v1';

/** Run 状态机（方案 §6.2）。 */
export const RUN_STATUS = Object.freeze({
  CREATED: 'CREATED',
  INPUT_FROZEN: 'INPUT_FROZEN',
  DSH_STARTED: 'DSH_STARTED',
  RUNNING: 'RUNNING',
  BLIND_SUBMITTED: 'BLIND_SUBMITTED',
  COMPARE_RUNNING: 'COMPARE_RUNNING',
  RESULT_RECEIVED: 'RESULT_RECEIVED',
  HOST_VERIFIED: 'HOST_VERIFIED',
  MERGED: 'MERGED',
  COMPLETED: 'COMPLETED',
  FAILED_CONTRACT: 'FAILED_CONTRACT',
  FAILED_AUTH: 'FAILED_AUTH',
  FAILED_DSH: 'FAILED_DSH',
  AUDIT_NOT_SUBMITTED: 'AUDIT_NOT_SUBMITTED',
  INTERRUPTED: 'INTERRUPTED',
  CANCELLED: 'CANCELLED',
  STALE: 'STALE',
});

/** 终态：不再接受新的提交/迁移（INTERRUPTED 可安全重跑，但不是"可继续"）。 */
export const TERMINAL_STATUSES = Object.freeze(new Set([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.FAILED_CONTRACT,
  RUN_STATUS.FAILED_AUTH,
  RUN_STATUS.FAILED_DSH,
  RUN_STATUS.AUDIT_NOT_SUBMITTED,
  RUN_STATUS.INTERRUPTED,
  RUN_STATUS.CANCELLED,
  RUN_STATUS.STALE,
]));

/** 失败分支：可以由重试/人工处置推进。 */
export const FAILURE_STATUSES = Object.freeze(new Set([
  RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.FAILED_AUTH, RUN_STATUS.FAILED_DSH,
  RUN_STATUS.AUDIT_NOT_SUBMITTED, RUN_STATUS.INTERRUPTED, RUN_STATUS.STALE,
]));

/**
 * 合法迁移表。刻意是**白名单**：插件/重试不能凭"我觉得可以"跳态。
 * 注意 CREATED→INPUT_FROZEN 与 INPUT_FROZEN→DSH_STARTED 是两个不同事实：
 * 冻结失败不能再启动；启动失败可以重试（但 attempt 必须增加）。
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [RUN_STATUS.CREATED]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.CANCELLED],
  // INPUT_FROZEN 直接接受 blind/result：这是"外部 runner"模式（创建时 start:false，
  // 由调用方自己拉起 DSH）。仍然必须持有一次性 token —— 只是不强制服务器亲自 spawn。
  [RUN_STATUS.INPUT_FROZEN]: [RUN_STATUS.DSH_STARTED, RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.FAILED_DSH, RUN_STATUS.CANCELLED, RUN_STATUS.STALE],
  // 真实 start:true 路径里，子进程第一件事就是 open/read/submit：状态停在 DSH_STARTED，
  // 不会有人替它补一次 RUNNING。所以 DSH_STARTED 必须能直接进 BLIND_SUBMITTED / RESULT_RECEIVED ——
  // 旧表漏了这一条，导致真实联调的 blind 提交被自己的状态机拒绝（CT 套件用 start:false 测不到）。
  [RUN_STATUS.DSH_STARTED]: [RUN_STATUS.RUNNING, RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.FAILED_DSH, RUN_STATUS.AUDIT_NOT_SUBMITTED, RUN_STATUS.INTERRUPTED, RUN_STATUS.CANCELLED, RUN_STATUS.STALE],
  [RUN_STATUS.RUNNING]: [RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.FAILED_DSH, RUN_STATUS.AUDIT_NOT_SUBMITTED, RUN_STATUS.INTERRUPTED, RUN_STATUS.CANCELLED, RUN_STATUS.STALE],
  [RUN_STATUS.BLIND_SUBMITTED]: [RUN_STATUS.COMPARE_RUNNING, RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.INTERRUPTED, RUN_STATUS.CANCELLED, RUN_STATUS.STALE],
  [RUN_STATUS.COMPARE_RUNNING]: [RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.FAILED_DSH, RUN_STATUS.AUDIT_NOT_SUBMITTED, RUN_STATUS.INTERRUPTED, RUN_STATUS.CANCELLED, RUN_STATUS.STALE],
  [RUN_STATUS.RESULT_RECEIVED]: [RUN_STATUS.HOST_VERIFIED, RUN_STATUS.FAILED_CONTRACT, RUN_STATUS.STALE, RUN_STATUS.CANCELLED],
  [RUN_STATUS.HOST_VERIFIED]: [RUN_STATUS.MERGED, RUN_STATUS.STALE, RUN_STATUS.FAILED_CONTRACT],
  [RUN_STATUS.MERGED]: [RUN_STATUS.COMPLETED, RUN_STATUS.STALE],
  // 失败分支可以被显式重跑（新 attempt 从 INPUT_FROZEN 起）或取消。
  [RUN_STATUS.FAILED_CONTRACT]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.CANCELLED],
  [RUN_STATUS.FAILED_AUTH]: [RUN_STATUS.CANCELLED],
  [RUN_STATUS.FAILED_DSH]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.CANCELLED],
  [RUN_STATUS.AUDIT_NOT_SUBMITTED]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.CANCELLED],
  [RUN_STATUS.INTERRUPTED]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.CANCELLED],
  [RUN_STATUS.CANCELLED]: [],
  [RUN_STATUS.STALE]: [RUN_STATUS.INPUT_FROZEN, RUN_STATUS.CANCELLED],
  // 已完成的历史结论在被新候选取代后必须立即 STALE（方案硬要求：candidate hash 变化→旧审计作废）。
  // 只标状态，事件与条目保留 —— 历史仍可追溯。
  [RUN_STATUS.COMPLETED]: [RUN_STATUS.STALE],
});

/** 错误码（方案 §7.2）。前端按真实码显示。 */
export const ERROR_CODES = Object.freeze({
  AUDIT_NOT_FOUND: 'AUDIT_NOT_FOUND',
  AUDIT_TOKEN_INVALID: 'AUDIT_TOKEN_INVALID',
  AUDIT_TOKEN_EXPIRED: 'AUDIT_TOKEN_EXPIRED',
  AUDIT_SCOPE_MISMATCH: 'AUDIT_SCOPE_MISMATCH',
  AUDIT_PHASE_INVALID: 'AUDIT_PHASE_INVALID',
  AUDIT_CONTRACT_INVALID: 'AUDIT_CONTRACT_INVALID',
  AUDIT_COVERAGE_INCOMPLETE: 'AUDIT_COVERAGE_INCOMPLETE',
  AUDIT_QUOTE_NOT_FOUND: 'AUDIT_QUOTE_NOT_FOUND',
  AUDIT_HASH_MISMATCH: 'AUDIT_HASH_MISMATCH',
  AUDIT_ALREADY_SUBMITTED: 'AUDIT_ALREADY_SUBMITTED',
  AUDIT_RESULT_CONFLICT: 'AUDIT_RESULT_CONFLICT',
  AUDIT_CANCELLED: 'AUDIT_CANCELLED',
  AUDIT_BUDGET_EXCEEDED: 'AUDIT_BUDGET_EXCEEDED',
  REVIEW_ID_MAPPING_BROKEN: 'REVIEW_ID_MAPPING_BROKEN',
  AUDIT_NOT_SUBMITTED: 'AUDIT_NOT_SUBMITTED',
  AUDIT_FORBIDDEN_ORIGIN: 'AUDIT_FORBIDDEN_ORIGIN',
  AUDIT_PAYLOAD_TOO_LARGE: 'AUDIT_PAYLOAD_TOO_LARGE',
  AUDIT_IDEMPOTENCY_CONFLICT: 'AUDIT_IDEMPOTENCY_CONFLICT',
  AUDIT_STALE_CANDIDATE: 'AUDIT_STALE_CANDIDATE',
});

/**
 * 对照结论的合法取值。
 *
 * 为什么要有 ADVISORY_NEEDS_REVIEW：审计员给的反例可能与主张**不是同一件事**
 *（2026-10-22 实测：拿"平头男生一直在说话"否掉"系统首次上线保持克制"）。
 * 这种时候正确形态是"需要人工判断"，而不是"已被驳倒"——它既不能算作者判错，
 * 也不该被悄悄删掉。判定由 relevance.mjs 的确定性筛选给出，模型不能自己声明。
 */
export const INITIAL_FINDING_VERDICTS = Object.freeze([
  'COVERED', 'DISPUTED', 'NEED_CONTEXT', 'INVALID_EVIDENCE', 'ADVISORY_NEEDS_REVIEW',
]);

/** 审查维度（review audit 的 coverage.dimensions 必须全部给结论）。 */

export const DIMENSIONS = Object.freeze([
  'blueprint', 'continuity', 'character', 'causality', 'repetition',
  'style', 'pacing_hook', 'temporal_foreshadowing', 'evidence_integrity',
]);

/** 资源名（blind 阶段禁止 initial_review）。 */
export const RESOURCE_NAMES = Object.freeze([
  'article', 'base_article', 'blueprint', 'context', 'initial_review',
  'candidate', 'selected_findings', 'patch_trace',
]);
export const BLIND_FORBIDDEN_RESOURCES = Object.freeze(new Set(['initial_review', 'selected_findings', 'patch_trace']));

export const LIMITS = Object.freeze({
  maxBodyBytes: 512 * 1024,
  maxFindings: 200,
  maxEvidencePerFinding: 20,
  maxQuoteChars: 2000,
  maxReasonChars: 4000,
  maxTitleChars: 300,
  maxResourceChars: 2_000_000,
  defaultPageChars: 16000,
  maxPageChars: 20000,
  maxCoverageRanges: 500,
  maxSelectedIssues: 200,
  maxTotalQuotesChars: 200_000,
});

/** 阶段（review: blind→compare；revision: revision）。 */
export const PHASES = Object.freeze({ BLIND: 'blind', COMPARE: 'compare', REVISION: 'revision' });

/**
 * 状态迁移判定（纯函数）。
 * @returns {{ok:true, to:string}|{ok:false, code:string, detail:string}}
 */
export function canTransition(from, to) {
  if (!RUN_STATUS[from]) return { ok: false, code: ERROR_CODES.AUDIT_CONTRACT_INVALID, detail: `未知原状态 ${from}` };
  if (!RUN_STATUS[to]) return { ok: false, code: ERROR_CODES.AUDIT_CONTRACT_INVALID, detail: `未知目标状态 ${to}` };
  if (from === to) return { ok: true, to };
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return { ok: false, code: ERROR_CODES.AUDIT_CONTRACT_INVALID, detail: `不允许从 ${from} 迁移到 ${to}` };
  }
  return { ok: true, to };
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status));
}

// ── 通用小工具 ────────────────────────────────────────────────────────────────
const str = (v) => String(v == null ? '' : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * 逐字证据核验：quote 必须**原样出现**在被审文本里。
 * 为什么是 includes 而不是"模糊匹配"：审计的全部价值在于"这条问题指哪句话"。
 * 允许近似匹配，就等于允许它指向一句并不存在的话。
 */
export function quoteExists(text, quote) {
  const q = str(quote).trim();
  if (!q) return false;
  return str(text).includes(q);
}

/**
 * 校验 finding 的证据。
 * @returns {{ok:boolean, quote_not_found:string[], missing_evidence:boolean}}
 */
export function validateFindingEvidence(finding, text) {
  const ev = arr(finding && finding.evidence);
  const quoteNotFound = [];
  for (const e of ev) {
    const q = str(e && (e.quote != null ? e.quote : e));
    // 没有底本时不做"存在性"判定（标记为待核验，而不是伪造通过）。
    if (!str(text)) continue;
    if (!quoteExists(text, q)) quoteNotFound.push(q.slice(0, 80));
  }
  return {
    ok: quoteNotFound.length === 0,
    quote_not_found: quoteNotFound,
    missing_evidence: ev.filter((e) => str(e && (e.quote != null ? e.quote : e)).trim()).length === 0,
  };
}

function checkText(field, value, max, errors) {
  const s = str(value);
  if (s.length > max) errors.push(`${field} 超过 ${max} 字符（${s.length}）`);
}

function checkArrayLimit(field, value, max, errors) {
  if (arr(value).length > max) errors.push(`${field} 条目数 ${arr(value).length} 超过上限 ${max}`);
}

/**
 * 缺字段的**处理路径**（§3.2 要求每条缺陷说清"能不能免费修"）。
 *   FREE_REPARSE    —— 不花模型调用就能修：服务端能归一化，或 runner 补一个常量/顺序号；
 *   PAID_REGENERATE —— 只能让模型重新给（引用、证据、验收条件都是模型产出）；
 *   AUTHOR_CONFIRM  —— 结构没问题、语义要作者裁定。
 */
export const DEFECT_RESOLUTION = Object.freeze({
  FREE_REPARSE: 'FREE_REPARSE', PAID_REGENERATE: 'PAID_REGENERATE', AUTHOR_CONFIRM: 'AUTHOR_CONFIRM',
});

const typeOfValue = (v) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/**
 * 结构化缺字段诊断（§3.2）。
 *
 * 为什么不是只返回一串 errors：作者看到的"6 条缺字段"必须能定位到
 * **哪条 finding / 哪个字段 / 期望什么类型 / 实际什么类型 / 能不能免费修**，
 * 否则它既不能指导 runner 重试，也不能让作者判断该不该再花一次钱。
 *
 * 与 validateReviewAuditPayload 同源：errors 由这里生成的 detail 逐字拼出，
 * 不维护第二份判据（判据两份必然漂移）。
 */
export function defectsOf(kind, payload, ctx = {}) {
  const out = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  const auditId = str(ctx.auditId || p.audit_id || '');
  const push = (d) => out.push({
    audit_id: auditId,
    finding_id: str(d.finding_id || ''),
    field_path: str(d.field_path || ''),
    expected_type: str(d.expected_type || ''),
    actual_type: typeOfValue(d.actual),
    source: str(d.source || 'result'),
    error_code: str(d.error_code || ERROR_CODES.AUDIT_CONTRACT_INVALID),
    severity: d.severity || 'medium',
    resolution_path: d.resolution_path || DEFECT_RESOLUTION.PAID_REGENERATE,
    detail: str(d.detail || ''),
  });
  if (kind === 'revision') {
    const issues = arr(p.issues);
    const verdicts = ['PASS', 'PARTIAL', 'FAIL', 'NEED_CONTEXT', 'BLOCKED_SCOPE'];
    for (const it of issues) {
      const id = str(it && it.issue_id);
      const v = str(it && it.verdict);
      if (!id) {
        push({
          field_path: 'issues[].issue_id', expected_type: 'string（已选项 id）', actual: it && it.issue_id, source: 'auditor',
          severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
          detail: 'issues 条目缺少 issue_id',
        });
      }
      if (!verdicts.includes(v)) {
        push({
          finding_id: id, field_path: `issues[${id}].verdict`, expected_type: verdicts.join('|'), actual: it && it.verdict,
          source: 'auditor', severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
          detail: `issues[${id}] verdict 必须是 ${verdicts.join('|')}`,
        });
      }
      // 子条件（§5）：存在就必须可合成 —— key 必填且同项内唯一，kind/status 必须在枚举内。
      const checks = arr(it && it.checks);
      const seenKeys = new Set();
      for (const chk of checks) {
        const key = str(chk && chk.key);
        const ckind = str(chk && chk.kind);
        const cstatus = str(chk && chk.status).toUpperCase();
        if (!key) {
          push({
            finding_id: id, field_path: `issues[${id}].checks[].key`, expected_type: 'string', actual: chk && chk.key, source: 'auditor',
            severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
            detail: `issues[${id}] 的子条件缺少 key`,
          });
          continue;
        }
        if (seenKeys.has(key)) {
          push({
            finding_id: id, field_path: `issues[${id}].checks[${key}]`, expected_type: '唯一 key', actual: key, source: 'auditor',
            severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
            detail: `issues[${id}] 的子条件 key 重复：${key}`,
          });
        }
        seenKeys.add(key);
        if (ckind && !['hard', 'soft', 'context'].includes(ckind)) {
          push({
            finding_id: id, field_path: `issues[${id}].checks[${key}].kind`, expected_type: 'hard|soft|context', actual: ckind, source: 'auditor',
            severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
            detail: `issues[${id}] 子条件 ${key} 的 kind 非法：${ckind}`,
          });
        }
        if (cstatus && !['PASS', 'FAIL', 'UNKNOWN'].includes(cstatus)) {
          push({
            finding_id: id, field_path: `issues[${id}].checks[${key}].status`, expected_type: 'PASS|FAIL|UNKNOWN', actual: chk && chk.status, source: 'auditor',
            severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
            detail: `issues[${id}] 子条件 ${key} 的 status 非法：${chk && chk.status}`,
          });
        }
      }
    }
    return out;
  }
  if (kind !== 'review') return out;

  if (str(p.schema_version) !== REVIEW_AUDIT_SCHEMA) {
    push({
      field_path: 'schema_version', expected_type: REVIEW_AUDIT_SCHEMA, actual: p.schema_version, source: 'server',
      severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
      detail: `schema_version 必须是 ${REVIEW_AUDIT_SCHEMA}`,
    });
  }
  const verdicts = ['COMPLETE_WITH_EVIDENCE', 'IMPORTANT_OMISSIONS_FOUND', 'NEED_CONTEXT'];
  if (!verdicts.includes(str(p.verdict))) {
    push({
      field_path: 'verdict', expected_type: verdicts.join('|'), actual: p.verdict, source: 'auditor',
      severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
      detail: `verdict 必须是 ${verdicts.join('|')}`,
    });
  }

  // coverage：没有覆盖率就没有"整体结论"的资格
  const cov = p.coverage && typeof p.coverage === 'object' ? p.coverage : {};
  const resources = arr(cov.resources);
  if (!resources.length) {
    push({
      field_path: 'coverage.resources', expected_type: 'array[1..50]', actual: cov.resources, source: 'auditor',
      severity: 'blocker', resolution_path: DEFECT_RESOLUTION.PAID_REGENERATE,
      detail: 'coverage.resources 不能为空（必须证明读过哪些资源）',
    });
  }
  if (resources.length > 50) {
    push({
      field_path: 'coverage.resources', expected_type: 'array[1..50]', actual: resources, source: 'auditor',
      severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
      detail: `coverage.resources 条目数 ${resources.length} 超过上限 50`,
    });
  }
  for (const r of resources) {
    if (!RESOURCE_NAMES.includes(str(r && r.name))) {
      push({
        field_path: 'coverage.resources.name', expected_type: RESOURCE_NAMES.join('|'), actual: r && r.name, source: 'auditor',
        severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: `coverage.resources 含未知资源 ${str(r && r.name)}`,
      });
    }
    const ranges = arr(r && r.ranges);
    if (ranges.length > LIMITS.maxCoverageRanges) {
      push({
        field_path: 'coverage.ranges', expected_type: `array[0..${LIMITS.maxCoverageRanges}]`, actual: ranges, source: 'auditor',
        severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: `coverage.ranges 条目数 ${ranges.length} 超过上限 ${LIMITS.maxCoverageRanges}`,
      });
    }
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !Number.isFinite(Number(range[0])) || !Number.isFinite(Number(range[1]))) {
        push({
          field_path: 'coverage.resources.ranges[]', expected_type: '[number, number]', actual: range, source: 'auditor',
          severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
          detail: `coverage range 形状非法：${JSON.stringify(range)}`,
        });
      } else if (Number(range[1]) < Number(range[0])) {
        push({
          field_path: 'coverage.resources.ranges[]', expected_type: '[start, end] 且 end>=start', actual: range, source: 'auditor',
          severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
          detail: `coverage range 结束小于开始：${JSON.stringify(range)}`,
        });
      }
    }
  }
  const dims = cov.dimensions && typeof cov.dimensions === 'object' ? cov.dimensions : {};
  for (const d of DIMENSIONS) {
    if (!(d in dims)) {
      push({
        field_path: `coverage.dimensions.${d}`, expected_type: 'boolean|string', actual: dims[d], source: 'auditor',
        severity: 'medium', resolution_path: DEFECT_RESOLUTION.PAID_REGENERATE,
        detail: `coverage.dimensions 缺少维度 ${d}`,
      });
    } else if (typeof dims[d] !== 'boolean' && typeof dims[d] !== 'string') {
      push({
        field_path: `coverage.dimensions.${d}`, expected_type: 'boolean|string', actual: dims[d], source: 'auditor',
        severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: `维度 ${d} 的结论必须是布尔或字符串`,
      });
    }
  }

  // initial_findings：每条都要有 id、合法结论；说 DISPUTED 就必须交出反例的逐字证据
  const initial = arr(p.initial_findings);
  if (initial.length > LIMITS.maxFindings) {
    push({
      field_path: 'initial_findings', expected_type: `array[0..${LIMITS.maxFindings}]`, actual: initial, source: 'auditor',
      severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
      detail: `initial_findings 条目数 ${initial.length} 超过上限 ${LIMITS.maxFindings}`,
    });
  }
  for (const f of initial) {
    const id = str(f && f.issue_id);
    if (!id) {
      push({
        field_path: 'initial_findings[].issue_id', expected_type: 'string（初审 finding id）', actual: f && f.issue_id, source: 'auditor',
        severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: 'initial_findings 条目缺少 issue_id',
      });
    }
    const v = str(f && f.verdict);
    if (!INITIAL_FINDING_VERDICTS.includes(v)) {
      push({
        finding_id: id, field_path: `initial_findings[${id}].verdict`, expected_type: INITIAL_FINDING_VERDICTS.join('|'), actual: f && f.verdict,
        source: 'auditor', severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: `initial_findings[${id}] 的 verdict 非法`,
      });
    }
    if (v === 'DISPUTED') {
      const counter = f && (f.counter_evidence != null ? f.counter_evidence : null);
      const counterList = Array.isArray(counter) ? counter : (counter == null ? [] : [counter]);
      const hasQuote = counterList.some((e) => str(e && (e.quote != null ? e.quote : e)).trim());
      if (!hasQuote) {
        push({
          finding_id: id, field_path: `initial_findings[${id}].counter_evidence`, expected_type: 'array[1..] 逐字引用', actual: counter,
          source: 'auditor', severity: 'blocker', resolution_path: DEFECT_RESOLUTION.PAID_REGENERATE,
          detail: `initial_findings[${id}] 判 DISPUTED 却没有 counter_evidence（反例必须是原文逐字引用）`,
        });
      }
    }
  }

  // new_findings
  const news = arr(p.new_findings);
  if (news.length > LIMITS.maxFindings) {
    push({
      field_path: 'new_findings', expected_type: `array[0..${LIMITS.maxFindings}]`, actual: news, source: 'auditor',
      severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
      detail: `new_findings 条目数 ${news.length} 超过上限 ${LIMITS.maxFindings}`,
    });
  }
  for (const f of news) {
    const id = str(f && f.id);
    if (!id) {
      push({
        field_path: 'new_findings[].id', expected_type: 'QA-R-0001 形态', actual: f && f.id, source: 'auditor',
        severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: 'new_findings 条目缺少 id（必须是 QA-R-xxxx）',
      });
    } else if (!/^QA-[A-Z]-\d{4}$/.test(id)) {
      push({
        finding_id: id, field_path: `new_findings[${id}].id`, expected_type: 'QA-R-0001 形态', actual: id, source: 'auditor',
        severity: 'blocker', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE,
        detail: `new_findings id 必须是 QA-R-0001 形态：${id}`,
      });
    }
    if (str(f && f.title).length > LIMITS.maxTitleChars) {
      push({ finding_id: id, field_path: `new_findings[${id}].title`, expected_type: `string<=${LIMITS.maxTitleChars}`, actual: str(f && f.title).length, source: 'auditor', severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE, detail: `new_findings.title 超过 ${LIMITS.maxTitleChars} 字符（${str(f && f.title).length}）` });
    }
    if (str(f && f.explanation).length > LIMITS.maxReasonChars) {
      push({ finding_id: id, field_path: `new_findings[${id}].explanation`, expected_type: `string<=${LIMITS.maxReasonChars}`, actual: str(f && f.explanation).length, source: 'auditor', severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE, detail: `new_findings.explanation 超过 ${LIMITS.maxReasonChars} 字符（${str(f && f.explanation).length}）` });
    }
    const ev = arr(f && f.evidence);
    if (ev.length > LIMITS.maxEvidencePerFinding) {
      push({ finding_id: id, field_path: `new_findings[${id}].evidence`, expected_type: `array[0..${LIMITS.maxEvidencePerFinding}]`, actual: ev, source: 'auditor', severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE, detail: `new_findings.evidence 条目数 ${ev.length} 超过上限 ${LIMITS.maxEvidencePerFinding}` });
    }
    for (const e of ev) {
      if (str(e && e.quote).length > LIMITS.maxQuoteChars) {
        push({ finding_id: id, field_path: `new_findings[${id}].evidence.quote`, expected_type: `string<=${LIMITS.maxQuoteChars}`, actual: str(e && e.quote).length, source: 'auditor', severity: 'medium', resolution_path: DEFECT_RESOLUTION.FREE_REPARSE, detail: `new_findings.evidence.quote 超过 ${LIMITS.maxQuoteChars} 字符（${str(e && e.quote).length}）` });
      }
    }
    const acc = (f && f.acceptance) || {};
    if (!str(acc.rule) && !arr(acc.must_contain).length) {
      push({ finding_id: id, field_path: `new_findings[${id}].acceptance`, expected_type: 'rule 或 must_contain', actual: acc, source: 'auditor', severity: 'medium', resolution_path: DEFECT_RESOLUTION.PAID_REGENERATE, detail: `new_findings[${id}] 缺少 acceptance.rule 或 must_contain` });
    }
  }
  return out;
}

/**
 * FREE_REPARSE 的**自动补齐**（§3.2 的实现，不只是分类）。
 *
 * 边界必须先说清：只有"服务端能按契约唯一确定"的字段才自动补 ——
 *   · `schema_version`：常量；
 *   · `initial_findings[].issue_id`：仅当条数与冻结初审**完全一致**时按顺序补（隐式链接的口径）；
 *   · `new_findings[].id`：审计员自己的编号空间，按 `QA-R-00NN` 取未占用的号。
 * 其余一律不补：反例引用、验收条件、覆盖率都是模型产出，补了就是**代它编造**，
 * 那比"拒绝"更坏（作者会以为模型真的核过）。补完必须重新校验；补不干净就把剩余缺陷原样交回。
 *
 * @returns {{ok:boolean, payload:object, applied:string[], remaining:Array}}
 */
export function autoRepairPayload(kind, payload, ctx = {}) {
  const p = JSON.parse(JSON.stringify(payload && typeof payload === 'object' ? payload : {}));
  const applied = [];
  const want = kind === 'revision' ? REVISION_AUDIT_SCHEMA : REVIEW_AUDIT_SCHEMA;
  if (str(p.schema_version) !== want) { p.schema_version = want; applied.push('schema_version'); }

  if (kind !== 'revision') {
    const initialIds = arr(ctx.initialIssueIds).map(String);
    const list = arr(p.initial_findings);
    const lacking = list.filter((f) => !str(f && f.issue_id)).length;
    // 只在"条数与冻结初审一致"时按位置补：条数不一致说明它对少/多了几条，
    // 这时按下标去补等于给它编一份对不上号的结论。
    if (lacking && initialIds.length === list.length) {
      p.initial_findings = list.map((f, i) => (str(f && f.issue_id) ? f : { ...f, issue_id: initialIds[i] }));
      applied.push(`initial_findings[].issue_id x${lacking}`);
    }
    const news = arr(p.new_findings);
    const used = new Set([...news.map((f) => str(f && f.id)).filter(Boolean), ...initialIds]);
    let seq = 1;
    let filled = 0;
    p.new_findings = news.map((f) => {
      if (str(f && f.id)) return f;
      while (seq <= 9999 && used.has(`QA-R-${String(seq).padStart(4, '0')}`)) seq += 1;
      const id = `QA-R-${String(seq).padStart(4, '0')}`;
      used.add(id); seq += 1; filled += 1;
      return { ...f, id };
    });
    if (filled) applied.push(`new_findings[].id x${filled}`);
  }

  const remaining = defectsOf(kind, p, ctx);
  return { ok: remaining.length === 0, payload: p, applied, remaining };
}

/** 校验 review audit 的 final 结果（review-audit.v1）。 */
export function validateReviewAuditPayload(payload, ctx = {}) {
  const defects = defectsOf('review', payload, ctx);
  const errors = defects.map((d) => d.detail);
  // errors 由 defects 逐字拼出：一份判据，两种呈现（人读摘要 / 机器可定位台账）。
  return { ok: errors.length === 0, errors, defects };
}
/** 校验 revision audit 的 final 结果（revision-audit.v1）。 */
export function validateRevisionAuditPayload(payload, ctx = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // 身份/结论/子条件形状由 defectsOf 统一产出（与 review 同源、可定位），
  // 这里只保留"跨条目的关系"校验（重复、未选项、整体自洽）。
  const defects = defectsOf('revision', p, ctx);
  const errors = defects.map((d) => d.detail);
  if (str(p.schema_version) !== REVISION_AUDIT_SCHEMA) errors.push(`schema_version 必须是 ${REVISION_AUDIT_SCHEMA}`);
  const issues = arr(p.issues);
  if (!issues.length) errors.push('issues 不能为空（必须逐个已选项给终态）');
  checkArrayLimit('issues', issues, LIMITS.maxSelectedIssues, errors);
  const selected = arr(ctx.selectedIssueIds).map(String);
  const seen = new Set();
  for (const it of issues) {
    const id = str(it && it.issue_id);
    if (seen.has(id)) errors.push(`issues 重复 issue_id：${id}`);
    seen.add(id);
    if (selected.length && !selected.includes(id)) errors.push(`issues 含未选择的 issue_id：${id}`);
    checkText(`issues[${id}].reason`, it && it.reason, LIMITS.maxReasonChars, errors);
    checkText(`issues[${id}].repair_hint`, it && it.repair_hint, LIMITS.maxReasonChars, errors);
    checkArrayLimit(`issues[${id}].remaining_evidence`, it && it.remaining_evidence, LIMITS.maxEvidencePerFinding, errors);
    for (const e of arr(it && it.remaining_evidence)) checkText('remaining_evidence.quote', e && e.quote, LIMITS.maxQuoteChars, errors);
  }
  if (selected.length) {
    const missing = selected.filter((id) => !seen.has(id));
    if (missing.length) errors.push(`缺少这些已选项的终态：${missing.join('、')}`);
  }
  const overall = ['PASS', 'PARTIAL', 'FAIL', 'STALE'];
  if (!overall.includes(str(p.overall))) errors.push(`overall 必须是 ${overall.join('|')}`);
  checkArrayLimit('regressions', p.regressions, LIMITS.maxFindings, errors);
  checkArrayLimit('unauthorized_changes', p.unauthorized_changes, LIMITS.maxFindings, errors);
  // 结论自洽：任一项非 PASS 时 overall 不能是 PASS
  const anyNotPass = issues.some((it) => str(it && it.verdict) !== 'PASS');
  if (anyNotPass && str(p.overall) === 'PASS') errors.push('存在非 PASS 的已选项时 overall 不能是 PASS');
  return { ok: errors.length === 0, errors, defects };
}

/** 校验 blind_draft 提交。 */
export function validateBlindDraftPayload(payload) {
  const errors = [];
  const p = payload && typeof payload === 'object' ? payload : {};
  const ranges = arr(p.scanned_ranges);
  if (!ranges.length) errors.push('blind_draft 必须包含 scanned_ranges（证明读过全文）');
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) errors.push(`scanned_ranges 形状非法：${JSON.stringify(r)}`);
  }
  const findings = arr(p.findings);
  checkArrayLimit('findings', findings, LIMITS.maxFindings, errors);
  for (const f of findings) {
    if (!str(f && f.id)) errors.push('blind finding 缺少 id');
    if (!/^QA-[A-Z]-\d{4}$/.test(str(f && f.id))) errors.push(`blind finding id 必须是 QA-R-0001 形态：${str(f && f.id)}`);
    checkArrayLimit('evidence', f && f.evidence, LIMITS.maxEvidencePerFinding, errors);
    for (const e of arr(f && f.evidence)) checkText('evidence.quote', e && e.quote, LIMITS.maxQuoteChars, errors);
  }
  return { ok: errors.length === 0, errors };
}

/** payload 的字节体积（JSON）。 */
export function payloadBytes(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload == null ? null : payload), 'utf8'); } catch { return Infinity; }
}

/** 体积上限：超过就拒绝（不是截断后当成合法）。 */
export function checkPayloadSize(payload) {
  const bytes = payloadBytes(payload);
  if (bytes > LIMITS.maxBodyBytes) {
    return { ok: false, code: ERROR_CODES.AUDIT_PAYLOAD_TOO_LARGE, detail: `提交体 ${bytes} 字节超过上限 ${LIMITS.maxBodyBytes}` };
  }
  return { ok: true, bytes };
}

/**
 * 统一错误对象（服务端与协调器共用形状）。
 *
 * extra 用来携带**可定位的缺陷台账**（§3.2）：契约不合法时，一句人读摘要不够，
 * 调用方（插件/界面）需要拿到"哪条 finding、哪个字段、能不能免费修"，否则只能整份重跑。
 */
export function auditError(code, detail = '', extra = null) {
  const out = { ok: false, error: true, code, detail };
  if (extra && typeof extra === 'object') Object.assign(out, extra);
  return out;
}

/** 覆盖率是否完整（缺任何维度/资源都不算 COMPLETE）。 */
export function coverageComplete(coverage) {
  const cov = coverage && typeof coverage === 'object' ? coverage : {};
  const resources = arr(cov.resources);
  const dims = cov.dimensions && typeof cov.dimensions === 'object' ? cov.dimensions : {};
  const missingDims = DIMENSIONS.filter((d) => !(d in dims) || dims[d] === false);
  const incompleteResources = resources.filter((r) => r && r.complete === false).map((r) => str(r.name));
  if (!resources.length) return { ok: false, missing_dims: missingDims, incomplete_resources: ['article'] };
  return { ok: missingDims.length === 0 && incompleteResources.length === 0, missing_dims: missingDims, incomplete_resources: incompleteResources };
}
