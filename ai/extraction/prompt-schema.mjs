/**
 * ai/extraction/prompt-schema.mjs —— S06：提示词里的 domain / scope / 响应约束由**schema 生成**（修 F06）。
 *
 * 病灶：提示词里列举的 domain / scope / 字段是**手写字符串**，与 `schema.mjs` 的真值各自漂移。
 * 典型后果：schema 新增一个 domain，提示词没跟上 → 模型永远不敢用它；或提示词写了非法值 → 模型照抄。
 *
 * 本模块让示例与约束**从同一份真值派生**，并提供 `validateExample()` 断言示例确实合法。
 * 纯计算：只依赖 schema.mjs 导出的集合。
 */
import { DOMAINS, SCOPES, TEMPORAL_LIMITS, cellKey } from '../story-state/temporal/schema.mjs';

export const PROMPT_SCHEMA_VERSION = 'v1';

/** 由 schema 真值派生"提示词可以列举什么"。 */
export function promptContract() {
  return {
    version: PROMPT_SCHEMA_VERSION,
    domains: [...DOMAINS].sort(),
    scopes: [...SCOPES].sort(),
    max_ops_per_event: TEMPORAL_LIMITS.max_ops_per_event,
    // 响应约束从 schema 常量派生，避免"提示词说 8 个、schema 允许 12 个"这种漂移
    response_constraints: {
      max_ops_per_event: TEMPORAL_LIMITS.max_ops_per_event,
      max_events: 60,
      notes: 'ops 数量超过 max_ops_per_event 会被拒绝；events 超过 max_events 会被截断并要求分批。',
    },
  };
}

/**
 * 生成提示词里的示例（每个示例都保证能被 cellKey 接受）。
 * 只取少量高频 domain 做示例，避免提示词膨胀。
 */
export function exampleCells() {
  const picks = [
    { domain: 'character', entityId: '示例角色', predicate: 'status', scope: 'canon', value: '存活' },
    { domain: 'location', entityId: '示例地点', predicate: 'known', scope: 'canon', value: true },
    { domain: 'knowledge', entityId: '示例角色', predicate: '知道', scope: 'character', holderId: '示例角色', value: true },
  ];
  return picks.map((p) => {
    const key = cellKey({ domain: p.domain, entityId: p.entityId, predicate: p.predicate, scope: p.scope, holderId: p.holderId ?? null });
    return { example: p, key };
  });
}

/** 断言：某个示例在当前 schema 下确实合法（非法会抛 TypeError，由调用方/测试处理）。 */
export function validateExample({ domain, entityId, predicate, scope = 'canon', holderId = null } = {}) {
  return cellKey({ domain, entityId, predicate, scope, holderId });
}

/** 提示词片段：把契约渲染成给人/给模型看的中文说明（内容全部来自 promptContract）。 */
export function renderPromptContract() {
  const c = promptContract();
  return [
    `可用 domain（共 ${c.domains.length} 个）：${c.domains.join('、')}`,
    `可用 scope（共 ${c.scopes.length} 个）：${c.scopes.join('、')}`,
    `每个事件最多 ${c.response_constraints.max_ops_per_event} 个 ops；超过会被拒绝。`,
    `每章最多 ${c.response_constraints.max_events} 个事件；超出的请分批返回。`,
  ].join('\n');
}
