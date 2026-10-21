/**
 * ai/quality-auditor/status.mjs —— 状态文案与"还缺什么"（方案 §11.3 / §4.4）。
 *
 * 严格区分 12 个界面状态（已发现/已授权/已定位/已生成补丁/补丁已应用/等待语义复验/
 * 部分修复/复验失败/缺少上下文/验收通过/已合并正文）与 run 状态机。
 *
 * 为什么两套并存：run 状态是**流程**（DSH 跑到哪），界面状态是**结果**（这一条问题怎么样）。
 * 把"补丁已应用"显示成绿色成功态，就等于把"改过"冒充"改对"。
 */
import { RUN_STATUS, TERMINAL_STATUSES, DIMENSIONS } from './contracts.mjs';

export const RUN_STATUS_LABELS = Object.freeze({
  [RUN_STATUS.CREATED]: '已创建',
  [RUN_STATUS.INPUT_FROZEN]: '输入已冻结',
  [RUN_STATUS.DSH_STARTED]: '审计进程已启动',
  [RUN_STATUS.RUNNING]: '审计进行中',
  [RUN_STATUS.BLIND_SUBMITTED]: '盲审已提交（等待对照）',
  [RUN_STATUS.COMPARE_RUNNING]: '初审对照中',
  [RUN_STATUS.RESULT_RECEIVED]: '结果已收到（等待主机校验）',
  [RUN_STATUS.HOST_VERIFIED]: '主机校验通过',
  [RUN_STATUS.MERGED]: '已合并（等待收尾）',
  [RUN_STATUS.COMPLETED]: '已完成',
  [RUN_STATUS.FAILED_CONTRACT]: '失败：契约不合法',
  [RUN_STATUS.FAILED_AUTH]: '失败：鉴权不通过',
  [RUN_STATUS.FAILED_DSH]: '失败：DSH 不可用',
  [RUN_STATUS.AUDIT_NOT_SUBMITTED]: '失败：未结构化提交',
  [RUN_STATUS.INTERRUPTED]: '中断（可安全重跑）',
  [RUN_STATUS.CANCELLED]: '已取消',
  [RUN_STATUS.STALE]: '已过期（候选稿变了）',
});

/** 单条问题的界面终态（§11.3）。 */
export const ISSUE_STATUS_LABELS = Object.freeze({
  FOUND: '已发现',
  AUTHORIZED: '已授权',
  LOCATED: '已定位',
  PATCH_GENERATED: '已生成补丁',
  PATCH_APPLIED: '补丁已应用',
  AWAITING_SEMANTIC: '等待语义复验',
  PARTIAL: '部分修复',
  FAIL: '复验失败',
  NEED_CONTEXT: '缺少上下文',
  BLOCKED_SCOPE: '越权/保护区',
  STALE: '已过期',
  PASS: '验收通过',
  MERGED: '已合并正文',
  AWAITING_AUDIT: '等待独立审计',
});

/**
 * 还缺什么才能"完成"。这是给作者看的**可执行清单**，不是错误码堆。
 * @param {object} run store.getRun 的行（或 runToClient 的对象）
 * @param {{hasBlind?:boolean, hasFinal?:boolean, coverage?:object}} [facts]
 */
export function missingRequirements(run, facts = {}) {
  if (!run) return ['审计不存在'];
  const kind = String(run.kind || '');
  const status = String(run.status || '');
  if (TERMINAL_STATUSES.has(status)) {
    return status === RUN_STATUS.COMPLETED ? [] : [`审计已结束：${RUN_STATUS_LABELS[status] || status}`];
  }
  const out = [];
  if (kind === 'review') {
    if (!facts.hasBlind && ![RUN_STATUS.BLIND_SUBMITTED, RUN_STATUS.COMPARE_RUNNING, RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED, RUN_STATUS.MERGED].includes(status)) {
      out.push('blind 盲审结果尚未提交（novel_quality_submit(blind_draft)）');
    }
    if (!facts.hasFinal && ![RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED, RUN_STATUS.MERGED].includes(status)) {
      out.push('初审对照结果尚未提交（novel_quality_submit(final)）');
    }
    const cov = facts.coverage || null;
    if (cov && cov.dimensions && typeof cov.dimensions === 'object') {
      const missing = DIMENSIONS.filter((d) => !(d in cov.dimensions));
      if (missing.length) out.push(`审查维度未结论：${missing.join('、')}`);
    }
  } else if (kind === 'revision') {
    if (!facts.hasFinal && ![RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED, RUN_STATUS.MERGED].includes(status)) {
      out.push('逐项终验结果尚未提交（novel_quality_submit(final)）');
    }
  }
  if (![RUN_STATUS.RESULT_RECEIVED, RUN_STATUS.HOST_VERIFIED, RUN_STATUS.MERGED].includes(status)) {
    out.push('等待 Novel Studio 主机校验（host verify）');
  }
  return out;
}

/** 只读状态载荷（插件 novel_quality_status 与 UI 共用）。 */
export function statusPayload(row, facts = {}) {
  const run = row || {};
  return {
    audit_id: String(run.id || ''),
    kind: String(run.kind || ''),
    status: String(run.status || ''),
    status_label: RUN_STATUS_LABELS[String(run.status || '')] || String(run.status || ''),
    phase: String(run.phase || ''),
    missing_requirements: missingRequirements(run, facts),
    last_error: run.error_code ? { code: String(run.error_code), detail: String(run.error_detail || '') } : null,
    base_hash: String(run.base_hash || ''),
    candidate_hash: run.candidate_hash == null ? null : String(run.candidate_hash),
    terminal: TERMINAL_STATUSES.has(String(run.status || '')),
  };
}

/** 把内部 verdict 映射成界面状态文案（"补丁已应用"绝不能显示成"验收通过"）。 */
export function issueStatusLabel(verdict) {
  return ISSUE_STATUS_LABELS[String(verdict || '').toUpperCase()] || String(verdict || '未知');
}
