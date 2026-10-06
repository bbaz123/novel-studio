/**
 * 写作规则的**单点策略源**（去 AI 味 P0，2026-10-06）。
 *
 * 背景：在它之前，「每章 3～5 个场景」「系统出现 5～15 次」这类经验同时散落在
 *   - public/app.js 的蓝图/成文/质检提示词
 *   - harness-plugins/novel-writing/novel-tools.mjs 的自检清单
 *   - docs/chapter-acceptance-checklist.md
 * 改一处不会改到其它处，"删配额"永远删不干净；而且模型会因为"不补够可能被判不合格"
 * 而把文字写成工整的填充 —— 这正是"AI 味"的结构性来源。
 *
 * 三类规则（见 type）：
 *   - fact        事实约束：必须检查；缺失或矛盾不能自动认定通过
 *   - preference  创作偏好：按作品与场景生效，允许作者覆盖
 *   - diagnostic  诊断指标：只提示疑点，**不得**直接变成正文禁令
 *
 * 消费方：
 *   - 服务端 `server.js` 经 `GET /api/ai/writing-policy` 下发快照；
 *   - `public/app.js` 取回快照，取不到时用同文兜底常量（frontend-test.mjs 断言两侧一致，防漂移）；
 *   - `harness-plugins/novel-writing/novel-tools.mjs` 因"复制到 ~/.dsh 预设、无法相对 import"
 *     只保留无配额的简述，不再复制配额文本。
 */
import { WRITING_SCOPES } from './scopes.mjs';

/** 策略版本：任何规则文本/作用域变更都应递增，便于把"检查结果"绑到具体版本。 */
export const WRITING_POLICY_VERSION = '2026-10-06.1';

export const WRITING_RULES = [
  {
    id: 'length_is_advisory',
    type: 'preference',
    scopes: ['blueprint', 'draft', 'expand', 'rewrite'],
    priority: 70,
    text: '目标字数是范围参考，不是配额。篇幅不足但剧情已经完整时，允许按已成立的章尾收笔，不要为凑字数强行往下续写。'
  },
  {
    id: 'scene_count_no_quota',
    type: 'preference',
    scopes: ['blueprint', 'draft'],
    priority: 65,
    text: '场面数量按剧情需要决定：可以只有一个值得展开的场面，也可以有多个；不要靠增加场景或情节点凑字数，也不要把篇幅平均分配给每个场面。'
  },
  {
    id: 'avoid_repeated_full_mechanism',
    type: 'preference',
    scopes: ['draft', 'rewrite', 'expand'],
    priority: 60,
    text: '同一机制已经完整展示过后，再次出现时优先写差异、结果或人物反应，不要自动完整复现一遍。'
  },
  {
    id: 'system_airtime_no_quota',
    type: 'preference',
    scopes: ['draft'],
    priority: 55,
    text: '系统按本章剧情需要出场，不设次数配额；每次发言都应带来新信息或改变人物处境，纯播报式【】不要占多数。'
  },
  {
    id: 'allow_omission',
    type: 'preference',
    scopes: ['blueprint', 'draft'],
    priority: 50,
    text: '存在一个事件不等于必须形成完整场景；存在一个情绪不等于必须配一个动作；存在群众不等于必须给群众反应；存在重要角色不等于登场时必须突出。允许略写、跳过、沉默与突然结束。'
  },
  // ── 诊断项：只提示疑点，不是正文禁令 ──────────────────────────────────
  {
    id: 'diag_state_regression',
    type: 'diagnostic',
    scopes: ['verify_fact'],
    priority: 80,
    text: '已完成的任务/移动/持有物，是否在没有任何新事件的情况下回退成"未完成"？'
  },
  {
    id: 'diag_space_gap',
    type: 'diagnostic',
    scopes: ['verify_fact'],
    priority: 60,
    text: '人物是否从一个地点直接出现在另一个地点而缺少必要过渡？当前视点是否看得见所描写的东西？'
  },
  {
    id: 'diag_world_boundary',
    type: 'diagnostic',
    scopes: ['verify_fact'],
    priority: 55,
    text: '新出现的等级/术语/制度，与既有设定是"冲突"还是"未知"？没有明确闭集证据时只标记待核对，不要自行补设定。'
  },
  {
    id: 'diag_repeated_mechanism',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 60,
    text: '同一种流程是否被完整复现第二次，而新增信息主要来自人物反应？'
  },
  {
    id: 'diag_over_explanation',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 55,
    text: '含义已经由动作/对白/结果表达之后，是否又补了一句总结或解释？'
  },
  {
    id: 'diag_crowd_rotation',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 50,
    text: '是否存在连续多段只承担布景任务、不改变任何人物路线或信息的匿名群众反应？'
  },
  {
    id: 'diag_voice_convergence',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 45,
    text: '去掉姓名后，不同人物的对白是否还能区分？情绪是否总靠小动作翻译？'
  }
];

/** 按阶段（+类型/优先级）编译规则。返回副本，调用方改不到真源。 */
export function compileWritingRules(scope, { types = null, minPriority = 0 } = {}) {
  const s = String(scope || '');
  return WRITING_RULES
    .filter((r) => r.scopes.includes(s))
    .filter((r) => !types || types.includes(r.type))
    .filter((r) => (r.priority || 0) >= minPriority)
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((r) => ({ ...r, scopes: [...r.scopes] }));
}

/** 暴露给前端的策略快照（`GET /api/ai/writing-policy`）。 */
export function writingPolicySnapshot() {
  return {
    version: WRITING_POLICY_VERSION,
    scopes: [...WRITING_SCOPES],
    rules: WRITING_RULES.map((r) => ({ ...r, scopes: [...r.scopes] }))
  };
}