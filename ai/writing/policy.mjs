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
export const WRITING_POLICY_VERSION = '2026-10-08.2';

export const WRITING_RULES = [
  {
    id: 'length_is_advisory',
    type: 'preference',
    scopes: ['blueprint', 'draft', 'expand', 'rewrite'],
    priority: 70,
    text: '目标字数是范围参考，不是配额。篇幅不足但剧情已经完整时，允许按已成立的章尾收笔，不要为凑字数强行往下续写。'
  },
  {
    // 2026-10-08（作者明确要求）：**允许 AI 带一点人工作者的坏习惯**。
    // 为什么需要一条"允许冗余"的偏好：此前所有规则方向一致地指向"删重复、压信息、去解释"，
    // 于是成文变成一种"每句话都必须有功能"的密度——那本身就是最容易被读成 AI 的特征。
    // 真人连载是有波动的：会有一段没推进剧情、会重复一次已经说过的立场、会有多余的寒暄。
    // ⚠️ 写法上刻意**不给配额**（"每章至少一段废话"会立刻变成新的模板，与文件头那条纪律冲突）：
    // 它只是把"允许"写明白，让模型不必把每一段都写成有效信息。
    id: 'allow_human_slack',
    type: 'preference',
    scopes: ['draft', 'expand'],
    priority: 58,
    text: '允许保留人类作者会有的松弛：可以有一小段不推进剧情、只是过场或闲聊的内容；人物可以把已经表达过的立场再说一遍（真人会重复自己）；'
      + '一段对话不必每句都承担信息。但这不是"必须注水"——**不要**为了凑这种效果刻意加水，也不要把每一段都拉长；'
      + '松弛与紧凑的差别正是真人写作的节奏波动。判断标准是"这一段读起来像有人写的，还是像按功能清单填的"。'
  },
  {
    // 与上一条成对：加了"允许松弛"就必须防止修稿器把它当成"低价值重复证据"删掉。
    // 这两条分开写在不同的 scope（draft/expand vs rewrite），是因为它们要求动作相反。
    id: 'protect_human_slack',
    type: 'preference',
    scopes: ['rewrite'],
    priority: 66,
    text: '修稿时不要把人味当冗余删掉：一段没有推进剧情但读起来自然的过场与闲聊、人物重复说过一次的立场、'
      + '与主线无关的一句寒暄，可能正是这一章的节奏来源。只有当你**能指出**它前后已经用同样力道表达过同一件事、'
      + '且删掉不影响读者理解时，才作为"低价值重复证据"处理；拿不准就保留。'
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
    // 2026-10-08（第五批）：与上一条**成对但不同向** —— 上一条管"别把机制再演示一遍"，
    // 这一条管"那第一遍怎么办"。缺了它，模型在"避免重复"的压力下会把首次完整展示也压掉，
    // 于是读者学不会这套规则、后面第二次的"差异"也没有参照。
    // 这正是作者对第一章的判断："第一次出现的机制完整保留；第二次及以后只写结果、差异、人物反应"。
    id: 'first_showing_stays_complete',
    type: 'preference',
    scopes: ['draft', 'rewrite', 'expand'],
    priority: 62,
    text: '同类机制**第一次**出现时把过程写足（读者需要这一次才能理解规则），后面再出现只写变化；'
      + '不要为了"避免重复"把第一次也压缩掉——那样第二次的差异就没有参照了。'
      + '判断法：把第一遍压成一句话，读者还知不知道这套机制怎么运作？不知道就别压。'
  },
  {
    // 2026-10-08（第五批）：世界观的信息释放方式。
    // 起因是作者对第一章第三段的意见：一次性交代了暗黄D/青绿C/浅蓝B/金红A + 更高一档 +
    // 检测石承载极限 + 光柱视觉规则，"读者不需要任何解释就能感到这是最低的"。
    id: 'prefer_progressive_revelation',
    type: 'preference',
    scopes: ['blueprint', 'draft'],
    priority: 57,
    text: '世界观随事件**渐进揭示**：等级、规则、术语优先让读者从当场发生的事里自己连线'
      + '（谁出了什么等级、旁人怎么反应、屏幕打了什么字），而不是先集中解释一遍再让事件来印证。'
      + '本章不出现的档位/设定就不必交代，留到它第一次真正出场时交给读者去感知。'
      + '注意：这不是"不许解释"——当一条规则不解释读者就会误解时，解释是必要的；'
      + '要避免的是"把整套体系一次性说明白"。'
  },
  {
    // 2026-10-08（第五批）：把"重复流程优先写结果"从一句口号变成可执行的取舍。
    id: 'prefer_result_over_repeated_process',
    type: 'preference',
    scopes: ['draft', 'rewrite', 'expand'],
    priority: 59,
    text: '同一类事第二次发生时，默认写**结果与差异**（这次和上次哪里不一样、人物因此怎么想），'
      + '不复述过程步骤；只有当这一次带来新规则、新异常、新风险或新人物关系时，才重新展开过程。'
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
  },
  {
    // 2026-10-08（第五批）：时间轴密度。
    // 只报"密"，不报"删哪个"——因为"该不该在这一章标出这个时间"取决于它有没有承担新剧情功能，
    // 那是语义判断（机器判不了）。所以判据只做两件事：数时段型锚点、给位置。
    // 与 diag_repeated_mechanism 的分工：那条管"同一流程写了两遍"，这条管"时间被反复标注"。
    id: 'diag_timeline_density',
    type: 'diagnostic',
    scopes: ['verify_style'],
    priority: 53,
    text: '时段型时间锚点（早上/上午/中午/下午/傍晚/天黑这类，含绑定的钟点）是否过密，'
      + '以及**每个锚点是否承担了新的剧情功能**——如果某个锚点只是告诉读者"又换了个时段"而没有带来新事件，'
      + '它是可以删掉的。只提示密度与位置，不设"最多几个"的上限：一整天的时间跨度本来就该有多个锚点。'
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