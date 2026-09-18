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
 *
 * ── 2026-09-18 决策：质量档统一为 V4.1 Flash（**勿"顺手恢复"**）──────────────────
 * `quality` 档过去是 `deepseek-v4-pro`（2026-09-13 定稿：直接产出正文/整部设定、或结果会
 * 喂给之后每一章的环节，按「质量优先」不省钱）。2026-09-18 **用户明确决定**统一为
 * V4.1 Flash：V4 Pro 是上一代，官方基准显示 V4.1 Flash 在推理/Agentic 任务上反超，
 * 且单价与输入缓存命中价低得多。
 *
 * 「质量优先」的**意图保留、改用思考强度表达**（见 `EFFORT_BY_TIER.quality = 'high'`）：
 *   以前 = 这几个环节换更贵更慢的模型；现在 = 同样便宜的模型 + 更多思考预算。
 * 因此：**不要**把 `quality` 改回 `deepseek-v4-pro`，也**不要**删掉 `EFFORT_BY_TIER` ——
 * 那等于把质量基线静默降成「和快档一样不做额外思考」，与本决策正好相反。
 * （写这段注释的原因：本项目 2026-09-13 最贵的一次失误，就是为「统一」覆盖了刻意决定，
 *   还顺手抹掉了决策依据。决策要留痕，回滚要有据。）
 */

/** 模型档位 → 实际模型名。「档位」是策略层的概念，模型名是实现细节。 */
export const MODELS = {
  /** 快而省：提问/澄清、质检轮、入账整理、润色/扩写/细纲、AI 写作、批量生成、工作台三档。 */
  fast: 'deepseek-flash',
  /**
   * 结果会喂给之后每一章的环节：AI 审稿、AI 修稿、设定生成的成文轮、AI 自动创建小说、长期记忆压缩。
   * 取值与 `fast` 相同（V4.1 Flash）——「质量优先」由 `EFFORT_BY_TIER.quality` 的思考预算体现，
   * 不再是换模型。
   */
  quality: 'deepseek-flash'
};

/**
 * 在售 / 仍可归一的 DeepSeek 模型名（**去重**：质量档并入 fast 后不能出现两个同名字面量，
 * 否则下拉框/白名单会出现两个 value 相同的选项——2026-09-13 踩过的坑）。
 * deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 的模型已下线，但**旧名仍被服务端路由到
 * V4.1 Flash**，故保留在表内，保证存量配置仍能正确归一；
 * deepseek-v4-pro 保留在表内**仅供旧值归一**（存量 `api_configs.model` 由 db.js 的一次性迁移
 * 改写为当前默认模型），它不再作为任何档位的取值、也不再出现在界面下拉里；
 * deepseek-chat / deepseek-reasoner 官方已于 2026-07-24 停止服务（调用直接报错），不再列入。
 */
export const KNOWN_DEEPSEEK_MODELS = [
  ...new Set([
    MODELS.fast,
    MODELS.quality,
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-pro'
  ])
];

/** 思考强度白名单（唯一来源）。取值依据：dsh-llm-deepseek 设置层公布的 off | low | high | max。 */
export const EFFORTS = ['off', 'low', 'high', 'max'];

/**
 * 启动时会被**一次性改写**的旧模型名（存量数据清理清单，**不是**"可选模型"）：
 *   - deepseek-chat / deepseek-reasoner：官方 2026-07-24 停止服务，留着会让 AI 调用直接报错；
 *   - deepseek-v4-pro：2026-09-18 起质量档并入 V4.1 Flash（见文件头决策），存量配置一并对齐。
 * db.js 用这份清单跑迁移。放这里而不是抄进 SQL 字面量，是为了让"还有哪些旧名要清"只有一个出处
 * ——此前它抄在 db.js 里，而 verify-ai-branches 的扫描清单又不含 db.js，于是改了分工也没人发现。
 */
export const LEGACY_MODEL_NAMES = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-pro'];

/** 创作工作台三档 → 思考强度。fast 用 low 而非 off：保留思考、只压缩思考预算，不为提速牺牲质量。 */
export const PIPELINE_EFFORT_BY_MODE = {
  fast: 'low',
  balanced: 'high',
  deep: 'max'
};

/**
 * 模型档位 → 思考强度。**这是「质量优先」现在的表达方式**（2026-09-18 起，见文件头决策）。
 *   fast    = 不指定（沿用 dsh `settings.yaml` 的全局设置）——与改动前完全一致；
 *   quality = high（审稿/修稿/设定成文轮/创建小说/记忆压缩这几个"结果会喂给之后每一章"的环节）。
 * ⚠️ 不要把它当作可选的装饰：去掉它，质量档就退化成"和快档一模一样"。
 */
export const EFFORT_BY_TIER = {
  fast: '',
  quality: 'high'
};

export function effortForTier(tier) {
  return EFFORT_BY_TIER[tier] ?? '';
}

/**
 * 长 AI 任务的统一超时（AI 审稿 / AI 修稿 / AI 自动创建小说 / 创作工作台 / 长期记忆压缩）。
 *
 * 为什么要有它：此前 `600000` 这个字面量散落在前端 11 处调用点 + 服务端 3 处默认值 + harness 默认值里，
 * 想调大要改十几个地方（手写清单必然漏项）。而 10 分钟对"通读整章 + 输出整章"本来就偏紧：
 * 2026-09-18 实测一条修稿跑到 505 秒仍在生成，距超时只剩 95 秒 —— 再晚一点就是白等一场。
 * 服务端作业超时上限是 60 分钟（server.js 的 clamp），30 分钟在上限之内。
 */
export const LONG_AI_TIMEOUT_MS = 30 * 60 * 1000;

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
    pipeline_effort_by_mode: { ...PIPELINE_EFFORT_BY_MODE },
    // 档位→强度：前端据此给质量档带上思考预算（此前前端只能拿到模型名，无法表达"质量优先"）
    effort_by_tier: { ...EFFORT_BY_TIER },
    // 长 AI 任务统一超时：前端不再各自写 600000
    long_ai_timeout_ms: LONG_AI_TIMEOUT_MS
  };
}
