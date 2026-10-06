/**
 * 按阶段编译写作规则（策略源之上的一层薄封装）。
 *
 * 生成/审稿提示词请调用这里，不要再各自硬编码规则文本 —— 那正是"改了 A 处、
 * B 处仍沿用旧要求"的来源。
 */
import { WRITING_SCOPES } from './scopes.mjs';
import { compileWritingRules, writingPolicySnapshot } from './policy.mjs';

/** 某阶段要"遵守"的偏好规则（用于蓝图/成文/扩写提示词）。 */
export function compileWritingLines(scope) {
  return compileWritingRules(scope, { types: ['preference'] }).map((r) => `- ${r.text}`);
}

/** 某阶段要"检查"的诊断项（用于审稿/诊断提示词；只提示疑点，不是正文禁令）。 */
export function compileDiagnosticLines(scope) {
  return compileWritingRules(scope, { types: ['diagnostic'] }).map((r) => `- ${r.text}`);
}

/** 事实约束（必须检查；缺失或矛盾不能自动认定通过）。 */
export function compileFactLines(scope) {
  return compileWritingRules(scope, { types: ['fact'] }).map((r) => `- ${r.text}`);
}

/** 各阶段已编译好的规则文本：服务端据此下发，客户端优先直接用，避免各写一份编译逻辑。 */
export function compiledWritingPolicy() {
  const preference = {};
  const diagnostic = {};
  const fact = {};
  for (const scope of WRITING_SCOPES) {
    preference[scope] = compileWritingLines(scope);
    diagnostic[scope] = compileDiagnosticLines(scope);
    fact[scope] = compileFactLines(scope);
  }
  return { preference, diagnostic, fact };
}

/** `GET /api/ai/writing-policy` 的完整响应体：规则真源 + 已编译分区。 */
export function writingPolicyPayload() {
  return { ...writingPolicySnapshot(), compiled: compiledWritingPolicy() };
}