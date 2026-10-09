/**
 * 小说编辑规则资产（2026-09-27，R07）——三档编辑 + 编辑保护规则 + 七项能力 + 题材档。
 *
 * 定位：**规则单一来源**。它回答三个问题：
 *   1. 这次编辑按哪一档做（轻度润色 / 去 AI 腔 / 深度修稿）；
 *   2. 有哪些可选的创作能力被作者打开（七项），哪些因为题材不适用而**不该**加载；
 *   3. 无论哪一档、哪条能力，都必须遵守同一条「编辑保护规则」（事实保真基线）。
 *
 * 纪律（任务书 §10）：
 *   · 规则文本为本项目自行撰写（不摘抄上游项目），每条规则有稳定 id / version / content hash；
 *   · 新增能力**默认关闭**——旧作品不因为升级而悄悄改变既有生成行为；
 *   · 选择解析走白名单：未知 tier/能力/题材一律忽略并如实回报（不猜、不静默放行）；
 *   · 这里是纯函数（零依赖、可离线单测）；宿主装配器与 HTTP 接口共用同一实现。
 */
import { sha16 } from '../story-state/hash.mjs';

export const EDITING_RULE_VERSION = '1.5.0';

/**
 * 编辑保护规则：所有档位、所有能力共用的保真底线。
 * 语义（§10.1）：本轮编辑的原稿就是事实基线；允许改措辞，不允许改事实。
 */
export const PROTECTION_RULES = [
  '【编辑保护规则（所有档位共用）】',
  '1. 本轮提交给你的原稿就是事实基线：是否已是 Canon 由真实状态决定，不得把草稿当正典、也不得把正典当草稿。',
  '2. 保护：人物与姓名、人物关系、时间与地点、事件因果、角色已知信息、世界规则、道具与资源、伏笔、叙述视角、数字与专有名词。',
  '3. 不得为了"更自然"新增背景、回忆、动机、关系，或任何一旦写入就会成为剧情事实的新细节。',
  '4. 允许调整：措辞、句法、节奏、重复、修辞与对白表达。',
  '5. 遇到无法判断是否改变事实的地方：保留原文，并明确指出不确定之处（不要替作者决定）。',
  '6. 角色口癖，以及有功能的重复、短句、排比、破折号与悬念，不得机械删除。',
  '7. 改变剧情只能提出候选变更（章节蓝图 / 契约建议），不能偷偷改正史。',
  // 2026-10-08（第四批）：第 8、9 条来自一次**真实事故**，不是假想规则 ——
  // 复核稿里 `1738` 被单点改成 `1736`（与同章 `1736号王磊` 撞号、还与播报 `1720` 冲突），
  // 以及「画面切回江陵本地的队伍」被删后「外面在下雪」失去观察视角。
  // 两条都写成"必须做什么"而不是"不许做什么"，否则模型会把它们读成新的禁词表。
  '8. 数字锁：编号、排号、号码、年龄、日期、等级、概率与百分比是**既有事实**，不是表达方式。除非本轮明确要求改事实，否则一个字都不许动；如果发现原文自相矛盾，不要自己选一个改掉，把两处位置并列报出来。',
  '9. 转场桥：明确交代"镜头/画面/视角从 A 到 B"的句子是读者的方位来源。压缩时可以缩短它，但不能删掉它——删掉之后紧接着出现的室外景物（下雪、广场、车顶）会突然失去来源，读者不知道自己在看哪儿。',
  // 2026-10-08（第五批）：第 10 条针对**结构层**的压缩冲动。
  // 为什么写成"必须保留哪一次"而不是"不许重复"：修稿器在"删重复"这条授权下最容易做的事，
  // 就是把首次完整展示也一起压掉——那样读者就再也学不会这套机制，第二次的"差异"也无从被感知。
  '10. 同类机制只完整演示一次：本章里同一种流程（检测、登记、叫号、播报这一级）被完整演示过一遍之后，'
    + '后面再出现时只保留**结果、差异与人物反应**；但**第一次那次必须保留**——'
    + '它是读者学会这套规则的唯一机会，压掉它会让后面的"差异"没有参照。'
    + '人物对白（尤其承担辨识度的应答）不适用本条，不得以"重复"为由改写。',
].join('\n');

/** 三档编辑：改动幅度递增，保护规则不变。 */
export const EDIT_TIERS = [
  {
    id: 'light',
    name: '轻度润色',
    summary: '病句、用词、重复、局部节奏，最小改动',
    instruction: '本档要求：最小改动。只处理病句、用词不当、明显重复与局部节奏，能不动的地方不要动；不要重写段落结构，不要增加描写。',
  },
  {
    id: 'deai',
    name: '去 AI 腔',
    summary: '中文小说里的机械表达与语义问题，必须保持剧情',
    instruction: '本档要求：清除中文小说里的机械表达（万能比喻、空泛升华、对白资料倾倒、同质化角色声音、过度排比与解释性总结），必须保持剧情与信息量不变。',
  },
  {
    id: 'deep',
    name: '深度修稿',
    summary: '较大的表达与段落调整；改变剧情只能提出候选',
    instruction: '本档要求：可做较大的表达与段落调整（合并/拆分段落、重写场景开合、调整叙述顺序），但剧情事实、角色行为逻辑与信息揭示顺序不得改变；确需改变剧情时，只输出候选变更建议，不要直接改写事实。',
  },
];

/**
 * 阶段档（2026-10-08，E02）：同一能力 ID 在不同阶段注入**不同内容**，而不是把同一段话塞给所有阶段。
 *
 * 为什么必须拆（《叙事性专项修复》§5.2）：把"诊断标准 + 反例大全 + 逐项评分任务"塞进生成阶段，
 * 会把"写正文"变成"边写边自评"，模型于是去满足评分项（这正是 AI 味的结构性来源之一）；
 * 反过来，把"允许略写、允许留白"这类**生成期许可**塞进诊断阶段，等于让审稿器把有效留白报成问题。
 *
 * 三条纪律：
 *   · 只保留旧能力 ID（`fiction-humanizer` 等），不新增 `humanizer-write` / `humanizer-review`
 *     这种用户选项 —— 旧作者设置继续可用（`resolveEditingSelection` 白名单不变）；
 *   · `stage_rules` 是**可选**的：不传 stage 时逐字使用 `rule`，与接入前完全一致（旧调用点零变化）；
 *   · 找不到对应阶段 → 回落 `rule`，并在审计摘要里标 `base_fallback`（不假装阶段变体生效了）。
 */
export const STAGE_ALIASES = {
  blueprint: 'draft', draft: 'draft', expand: 'draft',
  rewrite: 'rewrite', polish: 'rewrite', revision: 'rewrite',
  review: 'verify_style', verify_style: 'verify_style', verify_fact: 'verify_style',
};

/**
 * 取某能力在某阶段应注入的规则文本。
 * @returns {{text:string, stage:string, used:'stage'|'stage_alias'|'base'|'base_fallback'}}
 */
export function stageRuleFor(ability, stage) {
  const base = String((ability && ability.rule) || '');
  const wanted = String(stage || '').trim();
  if (!ability || !wanted) return { text: base, stage: '', used: 'base' };
  const map = ability.stage_rules && typeof ability.stage_rules === 'object' ? ability.stage_rules : null;
  if (!map) return { text: base, stage: '', used: 'base_fallback' };
  if (typeof map[wanted] === 'string' && map[wanted]) return { text: map[wanted], stage: wanted, used: 'stage' };
  const alias = STAGE_ALIASES[wanted];
  if (alias && typeof map[alias] === 'string' && map[alias]) {
    return { text: map[alias], stage: alias, used: 'stage_alias' };
  }
  return { text: base, stage: '', used: 'base_fallback' };
}

/**
 * 七项创作能力（§10.3）。它们不是七个工具，而是小说 bundle 的可选规则/profile。
 * `tasks` 声明能力起作用的任务；`genre_affinity` 声明适用的题材档（空数组 = 不挑题材）；
 * `rule` 是真正会进入请求的规则文本；`signals` 交给确定性扫描器（scan.mjs）用。
 */
export const ABILITIES = [
  {
    id: 'fiction-humanizer',
    name: '去 AI 腔（Humanizer）',
    summary: '识别机械表达与语义问题，保留原意',
    tasks: ['write', 'review'],
    genre_affinity: [],
    rule: '能力·去 AI 腔：逐处识别机械表达（"仿佛/似乎/不由得"堆叠、万能情绪句、空泛升华、整齐排比、解释性总结），给出更具体的动作、感官或潜台词；保留原意与信息量，不新增事实。另有四类**词表测不到**的痕迹必须一并避开：①「不是 X。是 Y。」式先否定再重定义的短语判断，以及连续三短句总结；②给抽象判断配视觉化动作或比喻（"把那句话放在桌面上，让它自己立住"）、以及全篇均匀的比喻密度；③为了让前文意象、数字、颜色或口头禅再出现一次而回扣；④把普通场景写成镜头调度，或用“像……或者只是……”“其实……根本……”替读者反复校正画面。呼应要有叙事必要，允许细节全章只出现一次，也允许人物在章内没有想通。',
    // 阶段化内容：生成期只给正向许可，诊断期给完整判据与反证要求，修稿期只管已选问题。
    stage_rules: {
      draft: '能力·去 AI 腔（生成期·只给正向许可，不给评分任务）：写的时候只避开两类机械感——'
        + '① 万能情绪句与空泛升华（"仿佛/似乎/不由得"堆叠、整齐排比、替读者总结刚写过的东西）；'
        + '② 每个念头都给出完整认知闭环。详略带由内容决定：可以有一段不推进剧情、只过场或闲聊的内容，'
        + '允许有些细节全章只出现一次，也允许人物的想法在章内没有想通。'
        + '**不要**为了"显得自然"刻意加水、刻意打乱句长或故意不均匀——那会变成另一种模板。'
        + '这一阶段不做逐项评分，也不要输出审查报告。',
      verify_style: '能力·去 AI 腔（诊断期·完整判据 + 反证要求）：逐处识别机械表达，每条都要给出**正文原文引用**'
        + '与它伤害的阅读效果：① 万能情绪句（"仿佛/似乎/不由得"堆叠）、空泛升华、整齐排比、'
        + '含义已由动作或对白表达之后又补一句的解释性总结；②「不是 X。是 Y。」式先否定再重定义的短语判断、'
        + '连续三个短句当总结；③ 给抽象判断配视觉化动作或比喻、以及全篇均匀的比喻密度；'
        + '④ 为了让前文意象、数字、颜色或口头禅再出现一次而回扣；⑤ 把普通场景写成镜头调度，'
        + '或用“像……或者只是……”“其实……根本……”替读者反复校正画面。'
        + '**反证要求**：作者可能故意排比、故意累积（高潮/恐怖/压迫）、故意留白、故意写直接心理——'
        + '给不出"为什么这不是有意手法"的就不要报，放 deferred。只报告，不改写正文。',
      rewrite: '能力·去 AI 腔（修稿期）：只处理本次清单里**已经选定**的问题，不重新评审全文、不顺带润色其它地方。'
        + '改法优先"删掉含义已由动作或对白表达之后的总结句、合并承担同一功能的重复证据"；'
        + '删除重复说明要使用显式 delete，不要另造一个动作或旁白来填位。'
        + '每个已选问题都要给出处置（patched / keep / deferred / blocked）与理由；拿不准就保留并说明。'
    },
  },
  {
    // 2026-10-02（作者第三轮逐句意见）：这一类不是"用词"问题，而是**叙述者在场**的问题。
    // 旧规则（humanizer）管的是词面套语（仿佛/似乎/淡淡的），管不到"谁在说话、他站在人物里面还是外面"，
    // 于是作者点名的两处（"转顺了，顺到张嘴就能说出来"、"这个年纪遇到这种事"）在规则里完全没有对应项。
    id: 'narrative-distance',
    name: '叙述距离',
    summary: '叙述者是否越界：替人物解释、替他打磨要说的话',
    tasks: ['write', 'review'],
    genre_affinity: [],
    rule: '能力·叙述距离（谁的视角、叙述者有没有出场）：避免两类越界。'
      + '① **过程交代**——不要写"这句话/这个念头在他心里怎么被磨到能说出口"（"他在心里把这句话转了很多遍，转顺了，顺到张嘴就能说出来"）。'
      + '直接给那句话或那个念头本身即可；交代打磨过程是在替读者铺垫情绪，收掉它力度反而更大。'
      + '② **外部评论**——叙述者不要站到人物外面替他解释（"这个年纪遇到这种事…""换了谁都会…""正常人都会…"）。'
      + '这类句子把人物放回人群作参照，读者会感到有个外人站在旁边；改成他此刻的动作、或让他自己把那句话说出口。'
      + '③ 人物想不通的地方就让它想不通：不要每段都给认知闭环（这条与 humanizer 第③条同源，此处只管"叙述者是否替他收尾"）。',
  },
  {
    // 作者原话："剑到底最开始就在主袋还是某个更深夹层，最好稍微确定一下。……空间关系清楚，
    // 会让整个场景更可信。" + "每个前文细节都要再次调出来使用" —— 两类都属于**场景/道具的一致性**。
    id: 'scene-logic',
    name: '场景逻辑',
    summary: '物件方位与细节调出的自洽性',
    tasks: ['write', 'review'],
    genre_affinity: [],
    rule: '能力·场景逻辑（物件的空间关系与细节经济）：'
      + '① **物件方位自洽**——一件道具在章内只允许有一个明确位置（哪个包、哪一层、哪个口袋）。'
      + '若写了"再往里摸/更深的地方"，就必须先交代那一层是什么（例如"主袋里侧还有个夹层"）；'
      + '后文再次提到它时，一律按这个位置说，不要在主袋与夹层之间漂移。蓝图里给每个关键道具写明"在哪个位置"。'
      + '② **细节经济**——同一个编号、纸条、道具被反复"调出来用"会让文本显得在清点前文：'
      + '首次出现可以写足（材质、笔画、毛边都行），之后每次回想**只保留关键连接**'
      + '（"纸条上那四个数字，和短信前面那四个一样"就够了），不要重新描述一遍外观。'
      + '③ 允许有些细节全章只出现一次、之后不再回收。',
  },
  {
    id: 'dialogue-editor',
    name: '对白编辑',
    summary: '对白节奏、潜台词与说话人辨识度',
    tasks: ['write', 'review'],
    genre_affinity: [],
    rule: '能力·对白编辑：检查对白是否承担推进/人物/信息中至少一项职责；避免对白资料倾倒（用对话背诵设定）；让不同角色的用词、句长、礼貌层级可区分；连续对白之间补必要的动作节拍。',
    // 阶段化（E02）：这条原来把"补动作节拍"当成**写作指令**发给所有阶段。
    // 在诊断/修稿阶段它变成了相反的要求（别把动作节拍当节拍器），所以必须拆开。
    stage_rules: {
      draft: '能力·对白编辑（生成期）：让不同角色的用词、句长、礼貌层级可区分；每段对白至少要承担推进、'
        + '塑造人物或传递信息中的一项。动作节拍按需补：需要"停一下"时才补，同一个动作在本章写到第二遍基本不再提供新信息。',
      verify_style: '能力·对白编辑（诊断期）：逐段核对对白是否承担推进/人物/信息中至少一项；是否存在"对白资料倾倒"'
        + '（用对话背诵设定）；去掉姓名后不同人物的台词是否还能区分；动作节拍是否被当成了节拍器之间（每段都补、'
        + '且都在同一功能上）。每条给正文原文引用；判不出就放 deferred，不要写成硬伤。',
      rewrite: '能力·对白编辑（修稿期）：只改本次选定的对白问题；人物独特的应答方式与承担辨识度的台词保持原样，'
        + '不得以"重复""不够工整"为由把对白改平、改短或换成同一套模板。',
    },
  },
  {
    id: 'webnovel-pacing',
    name: '网文节奏',
    summary: '段落长度、爽点与章内推进节奏',
    tasks: ['write', 'review'],
    genre_affinity: ['general', 'xuanhuan', 'urban', 'romance'],
    rule: '能力·网文节奏：控制单段长度与信息密度，保证每章有明确的推进与情绪落点；避免长时间铺垫不给出反馈；在合适的节拍上给读者"下一步会怎样"的牵引。',
  },
  {
    id: 'mystery-review',
    name: '悬疑审视',
    summary: '线索、伏笔与公平性',
    tasks: ['review'],
    genre_affinity: ['general', 'mystery'],
    rule: '能力·悬疑审视：核对线索是否在揭示前已公平出现、伏笔是否有回收计划、推理链是否有跳步；不得替作者发明尚未揭示的秘密（保持 unknown）。',
  },
  {
    id: 'romance-review',
    name: '感情线审视',
    summary: '关系推进节拍与情感可信度',
    tasks: ['review'],
    genre_affinity: ['general', 'romance', 'urban'],
    rule: '能力·感情线审视：核对关系推进是否有铺垫与转折、角色情感变化是否与其已知信息一致；避免用旁白直接宣布感情。',
  },
  {
    id: 'character-voice',
    name: '角色声音',
    summary: '说话与思维方式的一致性',
    tasks: ['write', 'review'],
    genre_affinity: [],
    rule: '能力·角色声音：以角色卡（人设、口癖、对话示例）为准核对台词与内心戏；不同角色不得说同一种话；状态变化要有来由，不靠"突然想通"。',
  },
  {
    id: 'chapter-hook',
    name: '章末钩子',
    summary: '章尾牵引与下一章期待',
    tasks: ['write', 'review'],
    genre_affinity: ['general', 'xuanhuan', 'urban', 'mystery', 'romance'],
    rule: '能力·章末钩子：章尾给出未完成的动作、悬念或新信息，让读者有继续读的理由；钩子必须由本章内容自然生长，不得凭空抛出新事件。',
  },
  {
    // R10（2026-10-02）：结构型 AI 痕迹的确定性计数。
    // ⚠ 只挂 `review`：write 任务下 abilityDecision 返回 task_not_applicable，
    // 因此这条能力的 rule **不会**进入任何生成请求的规则块——作者要的是"把超线事实报给我"，
    // 不是"给生成加上限"。扫描端点（/api/novel/editing/scan）按 task='review' 运行，报告给作者。
    id: 'style-density',
    name: '结构密度审视',
    summary: '短句占比 / 同构句式 / 意象复现 / 微操作链（只报告，不约束生成）',
    tasks: ['review'],
    genre_affinity: [],
    rule: '能力·结构密度：只做确定性计数与线索报告（短句占比、同构句式次数、意象复现次数、微操作动词密度、镜头调度词、自我撤回、身体动作链与代读式章尾），口径写在 ai/editing/scan.mjs 的 DENSITY 常量里；不下"好/坏"结论，也不返回"应当改成什么"。',
  },
  {
    // 第四批（2026-10-08）：数值与事实一致性。
    // 起因是作者复核稿里的两处真实事故：`1738` 被单点改成 `1736`、以及
    // `D级 95% + C级 万分之一 + B级 十万分之一` 合计不到 100%。
    // 前端另有**硬拦**版（public/patch-safety.js 的 fact_lock_conflict，只作用于补丁）——
    // 这里是**诊断**版：对已经落定的正文只报告、不替作者改（同一件事在两条路径上姿态不同，
    // 因为它们面对的风险不同：补丁是"还没写进去"，成稿是"作者已经决定了"）。
    id: 'number-lock',
    name: '数值一致性',
    summary: '编号冲突 / 同一编号两个主人 / 百分比合计（只报告）',
    tasks: ['review'],
    genre_affinity: [],
    rule: '能力·数值一致性：只做确定性核对并报告——① 同一实体在本章被写成两个不同编号（"岳宸炎的排号纸是1736"与"…是1738"）；'
      + '② 同一编号挂在不同人物名下；③ 本章列出的百分比合计不为 100%（含"万分之一"这类稀有度写法）。'
      + '口径写在 ai/editing/scan.mjs 的 FACT_LOCK 常量里。**不返回"应当改成哪个"**：'
      + '哪一处是笔误、哪一处是作者有意改设定，判断权在作者。',
  },
  {
    // 第四批（2026-10-08）：转场桥。
    id: 'scene-bridge',
    name: '转场桥',
    summary: '删掉场景来源句之后，外景是否失去观察来源（只报告）',
    tasks: ['review'],
    genre_affinity: [],
    rule: '能力·转场桥：只报告一种后果——某个段落交代了"镜头/画面/视角从 A 到 B"（或大屏切到某地），'
      + '而它消失之后紧接着的段落直接写只可能来自外景的东西（下雪、广场、车顶、天空）。'
      + '判据是"删掉之后读者会不会失去方位"，不是"有没有用某个调度词"；真的处在转播视角时可以成立，'
      + '因此这里只报线索、不判违规。口径见 ai/editing/scan.mjs 的 TRANSITION 常量。',
  },
  {
    // 第四批（2026-10-08）：体系展示密度 + 未来设定质感。
    // 起因是作者复核稿里的三条判断：「等级图鉴式展示」「3751 年只是贴纸」「系统结尾太通用」。
    // 三条都是**取舍问题**而非错误，所以只报测量值与线索，绝不产出"应当改成什么"。
    id: 'promise-identity',
    name: '体系辨识度',
    summary: '等级展示密度 / 未来年份的社会细节 / 金手指承诺差异（只报告）',
    tasks: ['review'],
    genre_affinity: [],
    rule: '能力·体系辨识度：只做三类描述性测量并报告——'
      + '① **体系展示密度**：本章正面展示了几次等级/能力/阵营结果（叫号、播报、检测石亮起、排名刷新都算一次），'
      + '超过参考线时提示"像在逐项跑等级表"，不规定减到几次；'
      + '② **年份质感**：作品设定在远未来，而正文里出现了"当代日常符号"（纸质排号单、中央空调、打印机、校服）'
      + '却没有任何与之相配的时代细节时，报告这个落差——它不说明作者写错了，只说明读者读不出年代；'
      + '③ **金手指承诺**：章末系统/外挂台词是否只给出通用功能（"符合绑定条件"这一级），'
      + '而没有任何能体现本书特有机制的承诺。三条都只报线索，口径见 ai/editing/scan.mjs 的 PROMISE 常量。',
  },
  {
    // 第五批（2026-10-08）：**叙事结构**层面的机械感。
    // 起因是作者对第一章的结构层审稿结论："这一章的问题不是词汇层面的 AI 味（没有'嘴角勾起一抹'
    // 这类典型 AI 词），而是叙事结构层面的机械感 —— AI 太认真地把所有事情都交代清楚了。"
    // 它点名的前几类（同形流程完整复现、时间轴过密、群众反应功能重复、主角摄像机化）
    // 全部是**分布/形态**判断，词表型红线永远测不到。
    // ⚠ 同样只挂 `review`：作者要的是"把结构事实报给我"，不是让生成端去规避判据。
    id: 'story-shape',
    name: '叙事结构',
    summary: '同形流程复现 / 时间轴密度 / 群众反应功能重复 / 摄像机化叙述（只报告）',
    tasks: ['review'],
    genre_affinity: [],
    rule: '能力·叙事结构：只做四类结构性测量并报告——'
      + '① **同形流程复现**：同类机制（检测/登记/叫号/播报这一级）是否被**再次完整演示**，'
      + '而不是只写结果、差异与人物反应；判据是"机制动作 + 结果呈现"同段成立，'
      + '假设句与梦境不算（那是人物在说话，不是流程被演示了一遍）；'
      + '② **时间轴密度**：时段型时间锚点的条数与落点段占比（只有绑定了钟点/相对日的时段词才算推进，'
      + '"你从早上念到现在"这类把时间当参照的不算）；'
      + '③ **群众反应功能重复**：几段匿名群众反应（没有具名主体、不改变任何人物路线）落在同一功能上；'
      + '④ **摄像机化叙述**：主视角人物的"看/听"段数与主动动作段数的比值，以及**不在转播/拍摄上下文里**'
      + '却出现的镜头调度词（真的处在直播/转播视角时，镜头词是合法的）。'
      + '四类都只报事实与位置，不下"好/坏"结论；口径与参考线见 ai/editing/scan.mjs 的 STORY_SHAPE 常量。',
  },
];

/** 题材档（§10.3）：可选创作侧重点，不是所有小说必须遵守的模板。默认「通用」= 不加载题材侧重。 */
export const GENRES = [
  { id: 'general', name: '通用', focus: '' },
  { id: 'xuanhuan', name: '玄幻/奇幻', focus: '题材侧重·玄幻/奇幻：设定与力量体系的代价要具体可感；升级与战斗要落在人物处境上，避免数值流水账。' },
  { id: 'urban', name: '都市', focus: '题材侧重·都市：生活细节与社会关系要真实可信；冲突落在利益、情感与身份上，避免悬浮的成功叙事。' },
  { id: 'mystery', name: '悬疑', focus: '题材侧重·悬疑：信息给得有次序，读者与角色掌握的信息差就是张力来源；每次揭示都要能被前文支持。' },
  { id: 'romance', name: '言情', focus: '题材侧重·言情：情感推进靠具体互动与选择，克制自我感动式抒情；关系变化要能被读者见证。' },
  { id: 'history', name: '历史', focus: '题材侧重·历史：时代语汇、礼制与器物不得穿越；虚构人物可以参与真实框架，但不改写已知史实的因果。' },
  { id: 'comedy', name: '喜剧', focus: '题材侧重·喜剧：笑点来自人物性格与处境的错位，而不是叙述者解释笑话；节奏短促，包袱前不堆解释。' },
];

const TIER_IDS = new Set(EDIT_TIERS.map((t) => t.id));
const ABILITY_IDS = new Set(ABILITIES.map((a) => a.id));
const GENRE_IDS = new Set(GENRES.map((g) => g.id));

/** 规则文本的内容指纹（口径与宿主其它 hash 一致，仅用于版本追踪/比对）。 */
export function ruleHash(text) {
  return sha16(String(text || '').trim());
}

/** 给界面/接口用的目录（含每条规则的版本与 hash；不伪造精确测量数字）。 */
export function editingRuleCatalog() {
  return {
    version: EDITING_RULE_VERSION,
    protection: { id: 'edit-protection', version: EDITING_RULE_VERSION, hash: ruleHash(PROTECTION_RULES), chars: PROTECTION_RULES.length, text: PROTECTION_RULES },
    tiers: EDIT_TIERS.map((t) => ({ ...t, version: EDITING_RULE_VERSION, hash: ruleHash(t.instruction), chars: t.instruction.length })),
    abilities: ABILITIES.map((a) => ({ ...a, version: EDITING_RULE_VERSION, hash: ruleHash(a.rule), chars: a.rule.length, default_enabled: false })),
    genres: GENRES.map((g) => ({ ...g, version: EDITING_RULE_VERSION, hash: ruleHash(g.focus), chars: g.focus.length })),
  };
}

/**
 * 解析作者选择（白名单）。未知值不静默采用：进 `invalid`，并按默认值处理。
 * @param {object} settings `edit_rules_enabled` / `edit_tier` / `edit_abilities` / `edit_genre`
 */
export function resolveEditingSelection(settings = {}) {
  const enabled = String(settings.edit_rules_enabled ?? '0') === '1';
  const rawTier = String(settings.edit_tier ?? 'light');
  const rawGenre = String(settings.edit_genre ?? 'general') || 'general';
  const rawAbilities = settings.edit_abilities;
  const list = Array.isArray(rawAbilities)
    ? rawAbilities.map((x) => String(x))
    : String(rawAbilities ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const invalid = [];
  const tier = TIER_IDS.has(rawTier) ? rawTier : (invalid.push(`tier:${rawTier}`), 'light');
  const genre = GENRE_IDS.has(rawGenre) ? rawGenre : (invalid.push(`genre:${rawGenre}`), 'general');
  const abilities = [];
  for (const id of list) {
    if (!ABILITY_IDS.has(id)) { invalid.push(`ability:${id}`); continue; }
    if (!abilities.includes(id)) abilities.push(id);
  }
  return { enabled, tier, abilities, genre, invalid };
}

/** 序列化回设置存储（写盘用；顺序稳定，便于比对）。 */
export function editingSelectionToSettings(selection = {}) {
  const tier = TIER_IDS.has(String(selection.tier)) ? String(selection.tier) : 'light';
  const genre = GENRE_IDS.has(String(selection.genre)) ? String(selection.genre) : 'general';
  const abilities = (Array.isArray(selection.abilities) ? selection.abilities : [])
    .map((x) => String(x)).filter((id) => ABILITY_IDS.has(id));
  return {
    edit_rules_enabled: selection.enabled === true || String(selection.enabled) === '1' ? '1' : '0',
    edit_tier: tier,
    edit_abilities: [...new Set(abilities)].join(','),
    edit_genre: genre,
  };
}

/**
 * 一条能力在本次任务/题材下是否加载。
 * @returns {{load:boolean, reason:string}}
 */
export function abilityDecision(ability, { task = 'write', genre = 'general' } = {}) {
  if (!ability) return { load: false, reason: 'unknown_ability' };
  const tasks = Array.isArray(ability.tasks) ? ability.tasks : [];
  if (!tasks.includes(task)) return { load: false, reason: `task_not_applicable(${task})` };
  const affinity = Array.isArray(ability.genre_affinity) ? ability.genre_affinity : [];
  if (genre && genre !== 'general' && affinity.length && !affinity.includes(genre)) {
    return { load: false, reason: `genre_not_applicable(${genre})` };
  }
  return { load: true, reason: 'ok' };
}

/**
 * 组装本次编辑的规则块（确定性；同一选择 + 同一阶段 → 同一 hash）。
 * 规则文本按顺序拼接：保护规则 → 档位 → （题材侧重）→ 各能力。
 *
 * 阶段（`stage`，可选）只影响**有 `stage_rules` 的能力**；不传 stage 时行为与接入前逐字一致。
 * 返回值额外给出**审计摘要**（不含正文、不含密钥）：用什么阶段、进了哪些规则 id、各类型几条、
 * 哪些能力回落到了基础文本。它的用途是证实"诊断规则确实没有流入生成阶段"，而不是声称已解耦。
 *
 * @param {{enabled:boolean,tier:string,abilities:string[],genre:string}} selection
 * @param {{task?:string, stage?:string, includeProtection?:boolean}} opts
 */
export function buildEditingRuleBlock(selection, { task = 'write', stage = '', includeProtection = true } = {}) {
  const sel = selection || {};
  const stageKey = String(stage || '').trim();
  const tier = EDIT_TIERS.find((t) => t.id === sel.tier) || EDIT_TIERS[0];
  const genre = GENRES.find((g) => g.id === sel.genre) || GENRES[0];
  const parts = [];
  const sources = [];
  const decisions = [];
  if (includeProtection) {
    parts.push(PROTECTION_RULES);
    sources.push({ id: 'edit-protection', kind: 'protection', version: EDITING_RULE_VERSION, hash: ruleHash(PROTECTION_RULES), chars: PROTECTION_RULES.length });
  }
  parts.push(`【编辑档位：${tier.name}】\n${tier.instruction}`);
  sources.push({ id: `tier:${tier.id}`, kind: 'tier', version: EDITING_RULE_VERSION, hash: ruleHash(tier.instruction), chars: tier.instruction.length });
  if (genre.focus) {
    parts.push(`【题材档：${genre.name}】\n${genre.focus}`);
    sources.push({ id: `genre:${genre.id}`, kind: 'genre', version: EDITING_RULE_VERSION, hash: ruleHash(genre.focus), chars: genre.focus.length });
  }
  for (const id of Array.isArray(sel.abilities) ? sel.abilities : []) {
    const ability = ABILITIES.find((a) => a.id === id);
    if (!ability) { decisions.push({ id: String(id), load: false, reason: 'unknown_ability' }); continue; }
    const dec = abilityDecision(ability, { task, genre: genre.id });
    decisions.push({ id: ability.id, load: dec.load, reason: dec.reason });
    if (!dec.load) continue;
    const variant = stageRuleFor(ability, stageKey);
    parts.push(`【${ability.name}】\n${variant.text}`);
    sources.push({
      id: `ability:${ability.id}${variant.stage ? `@${variant.stage}` : ''}`,
      kind: 'ability',
      version: EDITING_RULE_VERSION,
      hash: ruleHash(variant.text),
      chars: variant.text.length,
      stage: variant.stage || null,
      variant: variant.used,
      // 兼容/可追踪：无论是否走阶段变体，都记下基础文本的 hash，便于比对"这一段到底换没换"。
      base_hash: ruleHash(ability.rule),
    });
    decisions[decisions.length - 1].stage_variant = variant.used;
  }
  const text = parts.join('\n\n');
  const countsByType = {};
  for (const s of sources) countsByType[s.kind] = (countsByType[s.kind] || 0) + 1;
  return {
    block_id: 'edit-rules',
    version: EDITING_RULE_VERSION,
    hash: ruleHash(text),
    chars: text.length,
    tier: tier.id,
    genre: genre.id,
    task,
    stage: stageKey || null,
    text,
    sources,
    decisions,
    // 审计摘要：证实"哪个阶段进了哪些规则"，以及哪些能力回落到了基础文本。
    audit: {
      stage: stageKey || '(unspecified)',
      policy_version: EDITING_RULE_VERSION,
      task,
      rule_ids: sources.map((s) => s.id),
      rule_sources: sources.map((s) => ({ id: s.id, kind: s.kind, hash: s.hash, chars: s.chars, stage: s.stage || null, variant: s.variant || null })),
      counts_by_type: countsByType,
      stage_variants_used: sources.filter((s) => s.stage).map((s) => s.id),
      base_fallbacks: stageKey ? sources.filter((s) => s.kind === 'ability' && s.variant === 'base_fallback').map((s) => s.id) : [],
      truncated_layers: [],
    },
  };
}
