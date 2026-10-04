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

export const EDITING_RULE_VERSION = '1.2.0';

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
 * 组装本次编辑的规则块（确定性；同一选择 → 同一 hash）。
 * 规则文本按顺序拼接：保护规则 → 档位 → （题材侧重）→ 各能力。
 * @param {{enabled:boolean,tier:string,abilities:string[],genre:string}} selection
 * @param {{task?:string, includeProtection?:boolean}} opts
 */
export function buildEditingRuleBlock(selection, { task = 'write', includeProtection = true } = {}) {
  const sel = selection || {};
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
    parts.push(`【${ability.name}】\n${ability.rule}`);
    sources.push({ id: `ability:${ability.id}`, kind: 'ability', version: EDITING_RULE_VERSION, hash: ruleHash(ability.rule), chars: ability.rule.length });
  }
  const text = parts.join('\n\n');
  return {
    block_id: 'edit-rules',
    version: EDITING_RULE_VERSION,
    hash: ruleHash(text),
    chars: text.length,
    tier: tier.id,
    genre: genre.id,
    task,
    text,
    sources,
    decisions,
  };
}
