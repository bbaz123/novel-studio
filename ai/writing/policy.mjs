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
 *
 * 2026-10-06 第二批（诊断层）：新增 information_saturation / functional_redundancy /
 * negative_explanation / false_foreshadow / detail_function_density 五条诊断，以及
 * scene_detail_budget / protect_high_identity 两条偏好。诊断依旧只提示疑点 —— 一旦被塞进
 * draft 就会变成新模板，因此仍靠 scopes 把它们挡在生成阶段之外。
 */
import { WRITING_SCOPES } from './scopes.mjs';

/** 策略版本：任何规则文本/作用域变更都应递增，便于把"检查结果"绑到具体版本。 */
export const WRITING_POLICY_VERSION = '2026-10-06.2';

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
  {
    id: 'scene_detail_budget',
    type: 'preference',
    scopes: ['blueprint', 'draft'],
    priority: 63,
    text: '动笔前先回答“这个场景值得把叙述资源花在哪里”：先定它的主要功能（建立哪条信息、哪段关系、哪种处境），次要项可以略写或跳过；不设细节数量、字数比例或固定配比。'
  },
  {
    id: 'protect_high_identity',
    type: 'preference',
    scopes: ['rewrite'],
    priority: 68,
    text: '修稿只做最小改动：优先删除或合并低价值的重复证据、去掉含义已由动作或对白表达之后的总结句，不要全文重写；承担多项功能、有辨识度的人物选择与对白（例如从安慰自然转到“饭吃了没有”）保持原样，不要润色成更完整、更煽情或更工整的版本。'
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
  },
  {
    id: 'diag_information_saturation',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 62,
    text: '某项信息是否已经被足够强的证据建立，后面还在用功能相同的细节继续证明（例如住宅老旧已由“六层无电梯 + 外墙掉瓷砖”建立，之后接连写多个坏灯）？只提示疑点，不规定同一信息最多出现几次——高潮、恐怖、压迫、喜剧都可能故意累积。'
  },
  {
    id: 'diag_functional_redundancy',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 61,
    text: '句子虽然不同，是否承担完全相同的叙事功能（有人摇头 / 有人议论 / 有人惋惜，都在证明“大家觉得可惜”）？按功能判断，不要只查重复句式。'
  },
  {
    id: 'diag_false_foreshadow',
    type: 'diagnostic',
    scopes: ['verify_fact'],
    priority: 58,
    text: '疑似伏笔、未知等级、暂未解释的异常，是“有意留白”还是“为显得神秘而塞入、却没有后续意义”？本章判不出来就归入 deferred 待后续章节核验，不要写成硬伤、也不要当作设定冲突。'
  },
  {
    id: 'diag_negative_explanation',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 52,
    text: '“没说 / 没问 / 没解释 / 没有别的 / 没再看”这类否定式短句，是否连续承担“作者不直接总结、但仍在解释人物心理”的功能？只在明显重复时提示，不设禁词。'
  },
  {
    id: 'diag_detail_function_density',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 48,
    text: '这个细节除了当前作用，是否还有第二作用（同时推进人物、关系或处境）？只有“功能单一且已被别处证明”的细节才提示为可删或可合并，不要机械打分。'
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