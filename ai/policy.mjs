/**
 * AI 通道与模型的**单点策略表**（P4）。
 *
 * 为什么要有它：在 P4 之前，模型与思考强度的选择散落在四处——
 *   - `public/app.js`：2 个顶部常量 + **12 处硬编码 `'deepseek-flash'`** + 4 处 `QUALITY_AI_MODEL`
 *   - `server.js`：`KNOWN_DEEPSEEK_MODELS` / `QUALITY_AI_MODEL` / `DEEPSEEK_REASONING_EFFORTS`
 *   - `harness.js`：**另一份重复的强度白名单** `REASONING_EFFORTS`
 *   - 各处注释与实现已经不一致（如 app.js 顶部称 QUALITY 管「成文轮」，成文实际硬编码 fast）
 *
 * 而 app.js:6-8 的注释本身就记录过代价：「散落的字面量一旦被批量替换，就会把刻意的
 * 质量选择悄悄改掉（本会话已因此误伤过 4 处）」。
 *
 * 本模块是所有模型名与强度取值的唯一来源。改分工改这里，不要改各处字面量。
 * `.p1-baseline/verify-ai-branches.mjs` 会扫描源码，把任何绕过本表的模型/强度字面量报出来。
 */

/** 模型档位 → 实际模型名。「档位」是策略层的概念，模型名是实现细节。 */
export const MODELS = {
  /** 快而省：提问/澄清、质检轮、入账整理、润色/扩写/细纲、AI 写作、批量生成、工作台三档。 */
  fast: 'deepseek-flash',
  /** 质量优先：直接产出正文/整部设定，或结果会喂给之后每一章的环节。 */
  quality: 'deepseek-v4-pro'
};

/**
 * 在售 / 仍可归一的 DeepSeek 模型名。
 * deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 的模型已下线，但**旧名仍被服务端路由到
 * V4.1 Flash**，故保留在表内，保证存量配置仍能正确归一；
 * deepseek-chat / deepseek-reasoner 官方已于 2026-07-24 停止服务（调用直接报错），不再列入。
 */
export const KNOWN_DEEPSEEK_MODELS = [
  MODELS.fast,
  MODELS.quality,
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp'
];

/** 思考强度白名单（唯一来源）。取值依据：dsh-llm-deepseek 设置层公布的 off | low | high | max。 */
export const EFFORTS = ['off', 'low', 'high', 'max'];

/** 创作工作台三档 → 思考强度。fast 用 low 而非 off：保留思考、只压缩思考预算，不为提速牺牲质量。 */
export const PIPELINE_EFFORT_BY_MODE = {
  fast: 'low',
  balanced: 'high',
  deep: 'max'
};

/** 档位解析：接受档位名（fast/quality）或直接给模型名。 */
export function resolveModel(tier, fallback = MODELS.fast) {
  if (!tier) return fallback;
  return MODELS[tier] || String(tier);
}

/** 模型名大小写归一；未知模型原样返回（允许用户配第三方模型）。 */
export function normalizeModel(model) {
  if (!model) return model;
  const raw = String(model).trim();
  const lower = raw.toLowerCase();
  return KNOWN_DEEPSEEK_MODELS.includes(lower) ? lower : raw;
}

/** 思考强度归一化；非法值返回空串（调用方据此决定不下发该字段）。 */
export function normalizeEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return EFFORTS.includes(v) ? v : '';
}

/**
 * 暴露给前端的策略快照（`GET /api/ai/policy`）。
 * 前端用它把散落的字面量换成档位查询，同时保留下线时的兜底常量。
 */
export function policySnapshot() {
  return {
    models: { ...MODELS },
    known_models: [...KNOWN_DEEPSEEK_MODELS],
    efforts: [...EFFORTS],
    pipeline_effort_by_mode: { ...PIPELINE_EFFORT_BY_MODE }
  };
}
