/**
 * 确定性编辑扫描（2026-09-27，R07）——「确定性层」：规则、位置、摘录、严重性与建议。
 *
 * 定位（任务书 §10.2）：确定性与语义分离。
 *   · 本模块只做**可复现的文本事实检查**（计数/位置/模式/结构），输出结构化 finding；
 *   · 它不假装是模型审稿：语义问题（重复解释、角色声音同质、空泛升华的**判断**）仍走既有模型链
 *     （novel_review 语义审稿），本模块不替代它、也不自动改 Canon；
 *   · 所有 finding 都是"给人看的线索"：带规则 id、位置（段号/字符区间）、摘录、严重性、建议；
 *   · 纯函数、零依赖、可离线单测；同一文本 → 同一结果（确定性验证的判据）。
 *
 * 与能力（§10.3）的对应：扫描器按能力启停——关闭的能力不产生 finding（"UI 有开关"不算证据，这里有真实输出差）。
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * ── 2026-10-02（作者第三轮逐句意见）新增的两类"叙述者在场"痕迹，正则集中在这里定义 ──
 * 为什么集中定义：同一口径要同时供**逐段定位**（AI_TELLS）与**整章密度**（scanStyleDensity）使用，
 * 各写一份必然漂移。它们在旧规则里**完全没有对应项**（旧规则只管"仿佛/似乎/淡淡的"这类词面，
 * 管不到"叙述越界"）——这正是它们会被稳定反复写出来的直接原因。
 *
 * ① 「过程交代」：把"这句话/这个念头在心里怎么被磨到能说出口"写出来。
 *    作者点名："转顺了，顺到张嘴就能说出来。"
 * ② 「叙述者越界」：叙述者站到人物外面，拿年龄/常理替他解释、或把人放回人群作参照。
 *    作者点名："这个年纪遇到这种事…"——"会突然出现一个站在人物外面的叙述者"。
 */
const PROCESS_EXPLAIN_PATTERNS = [
  /(?:转|想|念|琢磨|排练|预演|顺|捋)[^。！？\n]{0,6}(?:了)?[^。！？\n]{0,6}(?:很多|好几|几)?(?:遍|次)[^。！？\n]{0,18}(?:顺|熟|自然|能说|能开口|说出口)/g,
  /(?:把|将)?(?:那句话|这句话|要说的话|措辞|说辞|台词)[^。！？\n]{0,14}(?:顺了|顺过|磨|练|捋|组织好|排练|预演|说出口|咽回去)/g,
];
const PROCESS_EXPLAIN_RE = new RegExp(PROCESS_EXPLAIN_PATTERNS.map((r) => r.source).join('|'), 'g');
const NARRATOR_INTRUSION_PATTERNS = [
  /(?:这个|那个)?(?:年纪|岁数)(?:的人)?[^。！？\n]{0,8}(?:遇到|碰上|碰到|摊上)[^。！？\n]{0,10}(?:这种|这|这样)事/g,
  /(?:换|放)(?:了|成|作)?(?:谁|别人|任何人|个人|个正常|正常人)[^。！？\n]{0,10}(?:都|也|早)(?:会|要|得|就)/g,
  /(?:正常人|普通人|一般人|任何人)[^。！？\n]{0,8}(?:都|也)(?:会|要|得)/g,
];
const NARRATOR_INTRUSION_RE = new RegExp(NARRATOR_INTRUSION_PATTERNS.map((r) => r.source).join('|'), 'g');

/** 常见机械表达（确定性匹配；只标"命中位置"，是否该改由作者决定）。 */
// 结构统一为 `[标签, 单个正则]`：多个模式**共用一个 global 正则**去扫，扫描结果天然不重叠
// （`String.match` 返回非重叠匹配），因此同一处不会被两条模式各报一次。
// 早期版本按模式各扫一遍，于是「他在心里把这句话转了很多遍，转顺了」同时命中"把话磨到能说出口"
// 与"组织要说的话"，界面上同一句话出现两条 finding —— 那是噪音，不是发现。
const AI_TELLS = [
  ['「仿佛」式比喻', /仿佛|彷佛/],
  ['「似乎」模糊化', /似乎/],
  ['「不由得」套语', /不由得/],
  ['万能笑', /嘴角(勾起|扬起|浮现)[^。！？\n]{0,6}(笑|弧度)/],
  ['模板化心理', /(心中一|心头一)(紧|颤|暖|沉)/],
  ['套语·空气凝固', /空气(仿佛|似乎)?(都)?(凝固|安静下来)/],
  ['套语·时间静止', /(时间|世界)(仿佛|似乎)?(静止|停止)/],
  ['套语·深邃眼眸', /(深邃|幽深)的(眼眸|眸子|目光)/],
  ['副词堆叠（淡淡/轻轻/缓缓）', /(淡淡|轻轻|缓缓)地/],
  // 2026-10-02：旧口径只认「不是…，而是」，而作者逐句指认的那一类恰恰是**句号断开**的二次定义
  //（"不是轻。是没有重量。"）——它躲过了旧正则，也躲过了所有词表型红线，是最典型的密度型 AI 味来源。
  ['「不是X。是Y。」式二次定义', /(?:不是|并非)[^。！？\n]{1,14}[。，]\s*(?:是|而是)[^。！？\n]{1,14}[。]/],
  // 「X 就是 X」式同义复沓：**必须是同一个词面真的重复**。
  // 旧写法 `([^\s，。！？、]{2,8})就是\1` 是坏的：首个字符类可以只吃下一个字，
  // 于是"现**在就是**明天早上"（在=在）、"也**就是**说"（就=就）这类叠字全被误报成复沓——
  // work#18 第三章实测 3 处全是误报（2026-10-02 抓出）。现在要求：① 词面 ≥2 字并排除标点空白；
  // ② 用否定前瞻钉住"与自身不重叠"，把纯叠字（在在/就就）排除掉；③ 允许中间夹一个逗号。
  ['「X 就是 X」式同义复沓', /([^\s，。！？、]{2,8})，(?:也就是|就是)\1|([^\s，。！？、]{2,8})(?!\2)就是\2/],
  ['空泛升华', /这一切[^。！？\n]{0,10}(都)?(值得|有了意义)/],
];
// 2026-10-02（作者第三轮逐句意见）：「叙述者在场」的两类痕迹。它们**不是用词**问题，
// 旧规则里完全没有对应项（旧规则只管"仿佛/似乎/淡淡的"这类词面，管不到"叙述越界"）——
// 这是它们会被稳定反复写出来的直接原因。正则集中在上面 PROCESS/NARRATOR 常量里定义，
// 逐段定位（下面这几条）与整章密度（scanStyleDensity ⑦）共用同一份口径。
const NARRATIVE_AI_TELLS = [
  ['过程交代·把话磨到能说出口', PROCESS_EXPLAIN_PATTERNS[0]],
  ['过程交代·组织/排练要说的话', PROCESS_EXPLAIN_PATTERNS[1]],
  ['叙述者越界·替人物按年龄解释', NARRATOR_INTRUSION_PATTERNS[0]],
  ['叙述者越界·「换了谁都会…」', NARRATOR_INTRUSION_PATTERNS[1]],
  ['叙述者越界·拿"正常人"作参照', NARRATOR_INTRUSION_PATTERNS[2]],
];
const toSources = (pairs) => pairs.map(([, re]) => re.source);

/**
 * 把一份 `[标签, 正则]` 清单合成一个 global 正则并逐处打标签。
 * 返回 { index, text, label } —— 区间天然不重叠（`matchAll` 返回非重叠匹配），一处只说一次。
 *
 * 两个必须踩过的坑（2026-10-02 实测）：
 * ① 打标签**不能**用 `new RegExp(re.source).test(matchedText)` 回测：带捕获组/回溯引用的模式
 *    （如 `/([^\s，。！？、]{2,8})就是\1/`）在孤立片段上会失配 → 所有命中退化成无标签的"机械表达"。
 * ② 也不能靠"数捕获组"反推分支：手写 source 里的 `(?:…)`、`\1`、嵌套组都会让偏移算错。
 * 正确做法：给每个分支套一个**命名捕获组** `p<i>`，由 `m.groups` 直接告诉我们哪个分支命中。
 */
function makeLabeler(pairs, name = 'p') {
  const combined = new RegExp(
    pairs.map(([, re], i) => `(?<${name}${i}>${re.source})`).join('|'),
    'g'
  );
  return (text) => {
    const out = [];
    for (const m of String(text || '').matchAll(combined)) {
      let label = null;
      for (let i = 0; i < pairs.length; i += 1) {
        if (m.groups && m.groups[`${name}${i}`] !== undefined) { label = pairs[i][0]; break; }
      }
      out.push({ index: m.index, text: m[0], label: label || pairs[0][0] });
    }
    return out;
  };
}
const labelAiTells = makeLabeler(AI_TELLS, 'a');
const labelNarrativeTells = makeLabeler(NARRATIVE_AI_TELLS, 'n');

/**
 * ── 第四批（2026-10-08）：数值一致性 / 转场桥 / 体系辨识度 ───────────────────────
 *
 * 起因：作者拿"审稿前 vs 审稿后"两版正文做了一次对比复核，点名了六类问题，其中三类
 * **在源码里完全没有对应项**（旧规则只管用词与密度，量不出"编号撞号""等级图鉴""年份是贴纸"）：
 *   ① `1738` 被单点改成 `1736`（与同章 `1736号王磊` 撞号）——数值一致性；
 *   ② 「画面切回江陵本地的队伍」被删 →「外面在下雪」失去观察视角——转场桥；
 *   ③ 无名 B 级 + 两个 A 级 + S 级依次正面展示 = 等级图鉴；`3751年` 却全是当代日常；
 *      章末「检测完成，宿主符合绑定条件」可以接在任何系统文后面——体系辨识度。
 *
 * 三条都**只报告**（与 style-density 同一纪律）：它们是取舍问题，不是错误；
 * 写成硬规则必然误伤（等级该展示几次、未来要不要写悬浮车，都不是机器能替作者决定的）。
 * 常量集中定义在这里，避免"逐处定位"与"整章密度"各写一份（第三批踩过的坑）。
 */
const FACT_LOCK = {
  /** 百分比合计容差（百分点）：判据是数值加总，可以卡得很死。 */
  percentTolerance: 0.5,
  /** 上限：同一类最多报几条。 */
  maxFindings: 3,
};

/** 编号/数值的明确后缀（与 public/patch-safety.js 的 ID_SUFFIX 同源；用途不同，故各自成表）。 */
const ID_SUFFIX = '号|编号|排号|座号|学号|考号|号码|班级|年级|届|楼层|层|房间|室|岁|年';
const LINK_WORDS = '的|排号纸|排号单|号码纸|编号|成绩单|结果单|纸|是|为';
const LABEL_MULTI_STOPWORDS = ['排号纸', '排号单', '号码纸', '成绩单', '结果单', '编号', '号码', '数字', '上面', '下面', '里面', '前面', '后面', '旁边', '中间', '时候', '地方', '东西'];
const LABEL_EDGE_CHARS = new Set('的了是把在就也都和与被给着过这那他她它我你其张个份只把为地场里中后前看说'.split(''));

/** 稀有度词（`万分之一` 这一级）：它本身就是概率陈述。 */
const RARITY_FORMS = /(百万分之一|十万分之一|万分之一|千分之一|百分之一)/g;
const RARITY_VALUE = { 百万分之一: 0.0001, 十万分之一: 0.001, 万分之一: 0.01, 千分之一: 0.1, 百分之一: 1 };
const PERCENT_RE = /([0-9]{1,2}(?:\.[0-9]{1,4})?)\s*[%％]/g;
const CN_NUM_RE = /百分之[零一二两三四五六七八九十百]{1,5}|[零一二两三四五六七八九十百]{1,5}/g;
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };
const PROBABILITY_CONTEXT_RE = /(概率|几率|占比|出现率|觉醒率|约|大约|将近|不足|不到|超过|以上|以下|分之)/;

/** 外景标记：只可能来自室外/场地外的具体景物（不含"外面""远处"这类通用方位词，误报太高）。 */
const EXTERIOR_MARKERS = ['下雪', '雪落', '雪花', '雨点', '暴雨', '广场', '街头', '街上', '马路', '车顶', '屋顶', '天空', '夜空', '天色', '风吹', '风声'];

/**
 * ── 转场桥 ──────────────────────────────────────────────────────────────────
 * 三类句子是"读者当前在看哪儿"的来源：
 *   ① 来源交代：`画面上方挂着一行字：海澜市觉醒中心`；
 *   ② 视点载体：`整个画面都白了`；
 *   ③ 明确切换：`画面没再切回检测台，直接切回了江陵本地的队伍`。
 * 判据（只报 §③ 这一种，因为它是**同段内同时出现"从哪来"和"到哪去"**的唯一形态）：
 *   段内有场景词 + 段内有切换动词 → 这是一座桥；它之后 N 段内出现外景标记 → 报"本章的
 *   外景只有这一座桥撑着"，供作者在压缩/删段时注意。
 *   ⚠️ 扫描器只看得见"章内有没有桥"，判不出"这一版比上一版少了一座桥"——
 *   删改比对由 public/patch-safety.js 的 sceneBridgeRisks 负责（那里有改前/改后两份文本）。
 */
const TRANSITION = {
  /** 切换动词：只有它们才把"大屏/画面"从一个地点带到另一个地点。 */
  switchRe: /(切到|切回|转到|转向|拉远|拉近|拉到|拉回|回到|带回|再切)/,
  /** 一座桥之后多少段内出现外景，才算"外景依赖这座桥"。 */
  window: 3,
  /** 外景段落的最大长度：超过它就是在写一整段景物，不是"交代一句外面在发生什么"。 */
  exteriorMaxChars: 30,
};

/**
 * ── 体系展示密度与年份质感 ──────────────────────────────────────────────────
 * 口径全部是**描述性测量**：报"展示了 N 次"，不报"应当减到 M 次"。
 * 参考线取自作者复核稿的判断（第一章：无名B级、王磊C级、李拓A级、第二个A级、林清雪S级、
 * 主角D级 = 六次正面展示，作者原话是"几乎把等级展示表完整走了一遍"），因此 line = 4。
 */
const PROMISE = {
  /**
   * 正面展示一次"等级结果"的形态：**叫号**（`1721号，李拓——`）与**检测石亮起/变色**。
   *
   * ⚠️ 刻意**不**把"广播念出等级"单独计数（2026-10-08 探针抓到：这样会把每一次展示算成三次，
   * 第一章本来 7 次展示被算成 16 次）。广播与叫号是同一次展示的两个侧面，只取其一。
   */
  showcasePatterns: [
    /[0-9]{3,4}号，[^\n]{0,12}——/g,
    /检测石[^\n]{0,16}(?:亮|烧|光)/g,
    /(?:排名|榜单)[^\n]{0,12}(?:刷新|更新)/g,
  ],
  showcaseLine: 4,
  /**
   * 远未来年份的形态。
   * ⚠️ `3751年，全民觉醒日` 里"年"后面紧跟的是逗号而不是空格（2026-10-08 探针：
   * 旧写法 `([0-9]{4})\s*年` 因为 `\s` 不含全角逗号而抓不到它，**年份质感这条判据整条没生效**）。
   * 现在年份与前缀解耦：只要正文里出现 4 位年份（3000 年以后）就认。
   */
  farFutureRe: /([0-9]{4})\s*年/,
  farFutureThreshold: 3000,
  /** 当代日常符号：它们本身没错，但"远未来 + 只有这些"读不出年代。 */
  contemporaryMarks: /(?:校服|书包|空调|打印机|排号纸|排号单|大屏幕|大屏|手机|电话|学费|补贴|广播|校门|教室|操场|纸币|现金|汽车|出租车|公交)/g,
  /** 与远未来相配的细节形态（命中一条就够）。 */
  /**
   * 与远未来相配的细节形态（命中一条就够，因此**不带 g**：带 g 的 lastIndex 会在多次 test 之间残留）。
   * ⚠️ **不含** `觉醒者 / 觉醒中心 / 妖兽` 这类本书的基础设定词 —— 它们是这本书的前提，
   * 不是"时代细节"；把它们算进来会让判据在每一章都失效（2026-10-08 探针抓到）。
   */
  futureDetailRe: /(?:防护墙|防护罩|防护阵列|能量阵列|灵能|灵网|悬浮|反重力|基因登记|身份腕环|腕环|智脑|终端机|全息|城墙|城防)/,
  /** 通用金手指台词（没有本书特征的功能承诺）。 */
  genericSystemRe: /(?:符合|满足)(?:绑定|契约|激活|开启)条件|绑定(?:成功|完成)|系统(?:激活|绑定|开启)成功/,
  /** 章尾窗口：只看最后几段，避免把正文里的机制说明误当承诺。 */
  tailParagraphs: 3,
};

/**
 * ── 第五批（2026-10-08）：叙事结构机械感 ──────────────────────────────────────
 *
 * 起因：作者对第一章《觉醒日》做了一轮结构层审稿，结论是"这一章的问题不是词汇层面的 AI 味，
 * 而是叙事结构层面的机械感"，并给了五个结构特征：
 *   S1 重复机制完整复现（觉醒检测流程完整演示 4 次）
 *   S2 时间轴过密（早六点→十点多→中午→下午→傍晚六点多→天黑）
 *   S3 群众反应功能重复（4 次"大厅所有人站起来/欢呼/叹气"承担同一功能）
 *   S4 世界观集中解释（D/C/B/A/SS + 检测石承载极限一次性交代）
 *   S5 主角摄像机化（全程看屏幕→看人→看单→看王磊，缺少主动注意力）
 *
 * 为什么必须做成**确定性判据**而不是再加几条提示词：这五条全部是"分布/形态"层面的判断，
 * 词表型红线（微微/缓缓/仿佛/眸/嘴角）永远测不到它们；而只写在能力文本里，模型可以无视。
 * 前四批的经验（见 scanStyleDensity 与 PROMISE）是：词表测不到的痕迹必须给出**可复算的测量值**。
 *
 * 三条纪律（与 style-density / PROMISE 同一套，刻意不变）：
 *   ① **测量值常驻**：`scanned.style_shape` 无条件返回，界面可以直接显示，与能力开关无关；
 *   ② **finding 只在无可辩驳时产出**：形态重复必须真的同形，功能重复必须真的没有具名主体，
 *      镜头语言必须先确认"不在转播/拍摄上下文里"；
 *   ③ **阈值是参考线不是配额**：超线只说明"值得看一眼"，不说明"必须改"。
 * 另外 S4（世界观集中解释）**刻意不做判据**：它需要区分"设定词是不是书名/作品前提"
 * （见 PROMISE.futureDetailRe 那条注释踩过的坑），机器判不出"这一章该不该现在解释"，
 * 只留在能力文本里由模型审。这是能力边界，不是遗漏。
 */
const STORY_SHAPE = {
  /** 时间锚点：判别"是不是时间推进"的形态。 */
  periodRe: /(凌晨|清晨|早上|早晨|上午|中午|正午|下午|傍晚|黄昏|晚上|夜里|深夜|天完全黑|天黑了|天黑|天亮)/g,
  clockRe: /([01]?[0-9]|2[0-3])\s*[点時时](?:\s*[0-9]{1,2}\s*分)?/g,
  relativeDayRe: /(第二天|次日|翌日|第三天|隔天|头天|前一天|当晚|当天|那天)/g,
  /**
   * 只由一个笼统时段词构成的时间锚点（不含"早上六点""十点多"这类带钟点的）。
   * 为什么需要它：`早上` 在正文里出现两次，一次是"**早上六点**就有人来占位置"（真的在推进），
   * 一次是"你从**早上**念到现在"（人物在说"从一开始"，不是时间推进）。
   * 校准探针抓到了后者被算成锚点 —— 判据必须能把这两种用法分开：
   * **只有"该段内除这个时段词以外还有钟点/相对日"，或该时段词带数量（"两分钟""三秒"）时才算推进**。
   */
  vagueOnlyRe: /^(凌晨|清晨|早上|早晨|上午|中午|正午|下午|傍晚|黄昏|晚上|夜里|深夜|天黑|天亮|天黑了|天完全黑)$/,
  /**
   * 时间锚点段落占比参考线；以及"时段型锚点"的条数参考线（钟点型不参与出 finding ——
   * "三秒""五秒"这类计数型时间不是时间轴推进）。
   */
  anchorLine: 6,
  periodAnchorLine: 5,
  /** 两个相邻时间锚点之间至少隔几段才算"真的在推进"（仅在**锚点值不同**时才判：同段两个词不算过密）。 */
  minGapParagraphs: 1,
  /**
   * 流程形状模板：一个"流程再现"段落必须同时命中 ≥2 类标记才成立。
   * 依据（作者原文）："第一次出现的机制完整保留；第二次及以后只写结果、差异、人物反应"。
   * 因此"机制动作 + 结果呈现"同段成立 = 一段流程被正面演示了。
   *
   * ⚠️ 第一版校准（2026-10-08）在这里翻过车：`seq` 含裸 `再/先/然后`、`trigger` 含 `出现/亮起`，
   * 于是"王磊把耳机戴上去，又摘下来""红光从石板底下蹿起来"都被判成流程，凑出 6 段假簇。
   * 现在三组都收窄到**流程语义**：步骤（显式枚举/计数）、机制动作（人的操作动词）、结果呈现（屏幕上/等级/判语）。
   */
  processGroupMin: 2,
  processMinChars: 10,
  processMaxChars: 220,
  /**
   * 同形流程再现几次才出 finding。
   * 参考线取 2：**同一段流程被写第二遍**就是作者点名的那件事（"第二次及以后只写结果、差异"），
   * 阈值放到 3 会让本章两个真实簇全部静默（校准实测：检测石演示、C 级播报各只出现 2 次）。
   * 代价是同一章可能给出 2–3 条同族 finding —— 这是刻意的：每条各自指出一组段落，
   * 合并成一条反而让作者看不出"到底是哪两段在重复"。
   */
  processClusterLine: 2,
  /**
   * 群众反应段：必须真的"没有具名主体"、**且不是对话/应答**才成立
   * （校准抓到的假正例："队伍里安静了两分钟，又有人开口。"——它是叙述过渡，不是群众布景）。
   */
  crowdMaxChars: 70,
  /** 同一功能的群众反应出现几段才出 finding（作者原文：群众反应 4 次承担同一功能）。 */
  crowdClusterLine: 2,
  /**
   * 转播/拍摄上下文：出现这些词时，镜头调度词是**合法**的（作者原文：
   * "只有镜头变化改变读者看到的信息时才写镜头"；本章林清雪那段就是全国直播）。
   * 因此判据只报"不在转播上下文里仍用分镜词"。
   * ⚠️ 前后**都要看**（第一版只看前一段，把"镜头里她的脸还是没什么表情"报成越界——
   * 它整场都在全国直播里，后面的"字幕迟了一拍才挂上去"就是上下文）。
   */
  mediaWindow: 2,
  /** 摄像机化 POV：主视角人物的"看/听"段数参考线与主动动作比参考线。 */
  povPerceiveLine: 8,
  povActiveRatioLine: 0.35,
};

const TIMELINE = {
  period: STORY_SHAPE.periodRe,
  clock: STORY_SHAPE.clockRe,
  relative: STORY_SHAPE.relativeDayRe,
};

/** 流程标记：步骤（显式枚举、叫号式推进、计数式重复）—— 判据的核心信号。 */
const PROCESS_SEQ_RE = /(第[一二三四五六七八九十]|[0-9]{3,4}\s*号|下一位|下一个|轮到|开始检测|依次|逐个|[0-9]{1,2}\s*(?:秒|分))/g;
/** 机制动作：**人的操作动词**才是"流程被演示"，物体自己发光不算（校准教训，见 STORY_SHAPE 注释）。 */
const PROCESS_TRIGGER_RE = /(按上去|按上|按下去|按下|按满|把手放上去|把手放上|把手|手掌|伸出手|走上台|上台|进馆|进场|排队|叫号|喇叭|念到|念出|排号|登记|提交|递交|递过去|接过|收下|签名|刷卡|扫码|交出|取出|放上去|贴上|对准|搓了搓手|呶)/g;
/** 结果呈现：等级/颜色/屏幕读数/判语。 */
const PROCESS_RESULT_RE = /(级|暗黄|青绿|浅蓝|金红|白光|无战斗能力|屏幕上|屏幕念|屏幕打出|打出|显示|结论|判|合格|不合格|通过|不通过|符合|不符合|亮起来|亮起|熄灭)/g;
const PROCESS_COUNT_RE = /(一秒|两秒|三秒|[0-9]{1,2}\s*秒|[0-9]{1,2}\s*分|一瞬|好一会儿|几秒)/g;
const PROCESS_COPY_RE = /(大厅里|全场|所有人|没有人喊|没有人跳|欢呼|站起来|鼓掌|叹气)/g;
/**
 * 假设/臆想标记：这类段落里的"按上去……A级"是**人物在说梦/说如果**，不是机制被演示了一遍。
 * 校准实测（2026-10-08）：第 11 段"我**梦见**我按上去，金红光柱，直接冲到馆顶。A级。"命中了
 * count+result+trigger 三组，与主角真实检测的"三秒…暗黄光"凑成一个假簇。
 * "假设不是复现"——把它排除掉，判据才守得住零误报。
 */
const PROCESS_HYPOTHETICAL_RE = /(梦见|梦里|做梦|如果|要是|假如|万一|想(?:说|着)?要是)/;

/** 群众反应标记。匿名性由"段内没有具名角色"保证（逐段且需传入角色表）。 */
const CROWD_RE = /(全场|大厅里|人群|所有人|众人|大家|台下|周围|后排|前面几个|排队的人|观众)/g;
/** ⚠️ 刻意不含"安静/低声/低声商量"这类**叙述过渡**词：它们不是群众反应，校准第一版因此产生假正例。 */
const CROWD_REACT_RE = /(站起|起身|鼓掌|欢呼|叹气|摇头|议论|交头接耳|哄|喊|叫好|吹口哨|惊呼|哗然|骚动|凑过去|窃窃|可惜)/g;

/**
 * 转播/拍摄上下文的标记（同段或相邻段命中即认为镜头词合法）。
 * ⚠️ 这里刻意**只收媒体来源**（直播/转播/字幕/主持人/大屏/摄像机），不收"画面里/镜头里"
 * 这类调度词本身 —— 第一版把它们也算作上下文，判据就自我实现了：
 * "镜头拉远，画面里只剩下一个背影"整句都在自证"这是转播"，于是永远不报。
 */
const MEDIA_CONTEXT_RE = /(直播|转播|字幕|导播|主持人|屏幕|大屏|大屏幕|摄像机|摄影|切来切去|被拍|拍进)/;
/** 明确的镜头调度词（比 DENSITY 那条更窄：只算真的在调度镜头的词）。 */
const CAMERA_WORD_RE = /(镜头|画面|导播|特写|远景|近景|摇镜|推近|拉远|拉近)/g;
/** 段落内出现这些时，说明"屏幕上/画面里"是**显示设备**（读者在看屏幕），不是叙事自己在调度镜头。 */
const MEDIA_DEVICE_RE = /(屏幕|大屏|大屏幕|字幕|直播|转播|主持人|导播)/;

/** 主视角人物的"看/听"。**要求"看/听"是谓语**（后面跟宾语或标点），
 * 否则"他看了看"这类会被算成"没在行动"，比率就失真了（校准第一版把主动动作算成 1 段）。 */
const POV_PERCEIVE_RE = /(看|望|盯|听|抬眼|抬头|低头|扫了一眼)(?:着|了|见|到|向|过去|起来)?(?:屏幕|大屏|大屏幕|画面|镜头|排号|号码|叫号单|手机|他|她|台下|台上|门|自己|一眼|[，。！？、]|$)/g;
const POV_ACTIVE_RE = /(把|摸出|掏出|上前|转身|走|站起|坐下|开口|问|答|接过|递|拿|放下|搁|塞|对折|按|压|搓|攥|收|跳|扶|蹲|挤|停|决定)/g;
const POV_OBJECT_RE = /(屏幕|大屏|大屏幕|画面|镜头|排号|号码|叫号单|手机)/g;

const PERIOD_ANCHOR_KEYS = new Set(['凌晨', '清晨', '早上', '早晨', '上午', '中午', '正午', '下午', '傍晚', '黄昏', '晚上', '夜里', '深夜', '天黑', '天黑了', '天完全黑']);

/** 段落切句计数（"三秒。"三句各自成段 → 3 个流程标记）。 */
function processShapeOf(text) {
  const hit = (re) => { re.lastIndex = 0; return re.test(text); };
  const groups = [];
  if (hit(PROCESS_SEQ_RE)) groups.push('seq');
  if (hit(PROCESS_TRIGGER_RE)) groups.push('trigger');
  if (hit(PROCESS_RESULT_RE)) groups.push('result');
  if (hit(PROCESS_COUNT_RE)) groups.push('count');
  if (hit(PROCESS_COPY_RE)) groups.push('copy');
  return groups;
}

/** 时间锚点抽取：返回 {kind, value, paragraph} 列表（同段同值去重）。
 *
 * 两个必须过的筛（都由 2026-10-08 校准探针在真实正文上抓出来）：
 *  ① 只由一个笼统时段词构成的用法要看上下文：`你从早上念到现在` 里的"早上"是在说
 *     "自始至终"，不是时间推进。该段内除它以外还有钟点/相对日才算锚点。
 *     注意保留"天完全黑下来"这类**状态型**锚点（`vagueOnlyRe` 不含"天完全黑"的完整形态时
 *     会把它误删——所以只在**恰好等于**某个纯时段词、且段内无其它时间依据时才丢弃）。
 *  ② 段落里带数量（"两分钟""三秒"）的时段词是在说时长，不是时间轴位置。
 */
function timelineAnchorsOf(paras) {
  const out = [];
  const seen = new Set();
  const add = (kind, value, paragraph) => {
    const key = `${paragraph}|${kind}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value, paragraph });
  };
  for (const p of paras) {
    const t = p.text;
    const periodMatches = [...t.matchAll(STORY_SHAPE.periodRe)];
    const clockMatches = [...t.matchAll(STORY_SHAPE.clockRe)];
    const relMatches = [...t.matchAll(STORY_SHAPE.relativeDayRe)];
    for (const m of clockMatches) add('clock', `${m[1]}点`, p.index);
    for (const m of relMatches) add('relative', m[1], p.index);
    for (const m of periodMatches) {
      const tail = t.slice(m.index, m.index + 8);
      // ① 时长用法：**这个时段词自己带数量**（"两分钟""三秒""十几年""一上午""两分钟"）→ 它在说
      //    经过了多久，不是时间轴位置。
      //    ⚠️ 判据必须只看**紧跟在时段词之后**的那几个字。第一版用整段 after 串去搜数字，于是
      //    "早上**六**点就有人来占位置"里的"六"被当成时长数字，真实锚点被整条删光（校准实测 0 个）。
      if (/^(?:[一二三四五六七八九十两几]|[0-9]{1,3})\s*(?:分钟|秒|年|个月|天|上午|下午|晚上)/.test(t.slice(m.index + m[0].length))) continue;
      // ③ 笼统时段词（早上/上午/中午…）单独出现时说明不了"推进"：它后面必须紧跟钟点/相对日。
      //    "早上六点" ✓（有钟点）／"你从早上念到现在" ✗（把时间当参照）／"十点多的时候" ✓（钟点）。
      //    ⚠️ 判据是"**紧跟在时段词之后**"，不是"时段词整串等于某个词"：正文是「天完全黑**下来**」，
      //    用 `^...$` 全等判断会把它当成笼统时段词再删掉（校准实测：这个状态锚点整条丢失）。
      if (STORY_SHAPE.vagueOnlyRe.test(m[0]) || /天黑|天亮/.test(m[0])) {
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 4);
        const bound = /^\s*(?:[0-9]{1,2}|[一二三四五六七八九十两几]|多|半)\s*[点時时]/.test(after)
          || /^\s*(?:那批|这批|那批人|下来|了|的时候)/.test(after);
        if (!bound && relMatches.length === 0) continue;
      }
      add('period', m[0], p.index);
    }
  }
  return out.sort((a, b) => a.paragraph - b.paragraph);
}

/**
 * 叙事结构机械感：四条结构性判据。
 *
 * 调用方（scanEditing）负责按能力开关决定是否调用；测量值另外由 storyShapeMeasures() 单独算，
 * 保证"关掉能力仍能看到数字"（与 PROMISE 的 system_showcase_count 同一套做法）。
 */
function scanStoryShape(paras, out, ctx) {
  const chars = paras.map((p) => p.text).join('\n').length;
  const anchors = timelineAnchorsOf(paras);
  const periodAnchors = anchors.filter((a) => a.kind === 'period' || a.kind === 'relative');

  // ① 时间轴过密（S2）：段落占比 + 时段型锚点条数双条件，且要求锚点不在同一段扎堆。
  const anchorParas = new Set(anchors.map((a) => a.paragraph));
  const anchorRatio = paras.length ? anchorParas.size / paras.length : 0;
  let tightGaps = 0;
  for (let i = 1; i < anchors.length; i += 1) {
    const samePara = anchors[i].paragraph === anchors[i - 1].paragraph;
    const sameValue = anchors[i].value === anchors[i - 1].value;
    // 同一段里出现两个不同时间词（"中午…一上午过去"）是正常叙述，不是"标注过密"。
    if (samePara || sameValue) continue;
    if (anchors[i].paragraph - anchors[i - 1].paragraph < STORY_SHAPE.minGapParagraphs) tightGaps += 1;
  }
  if (periodAnchors.length >= STORY_SHAPE.periodAnchorLine
    && anchorRatio > 0.2
    && tightGaps === 0
    && paras.length >= 12) {
    pushFinding(out, {
      rule_id: 'deterministic:timeline-density',
      severity: 'low',
      paragraph: anchors[0].paragraph,
      excerpt: anchors.map((a) => a.value).join('→'),
      message: `本章出现 ${periodAnchors.length} 个时段型时间锚点（时间词落在 ${anchorParas.size}/${paras.length} 段，${Math.round(anchorRatio * 1000) / 10}%），时间线被标注得较密`,
      suggestion: '时间词只有在"读者需要知道过了多久"时才必须出现；'
        + '若某些锚点只是告诉读者"我们又换了个时段"而没有带来新事件，可以删掉——'
        + '让场景的光线/人物状态变化自己承担时间感。参考线不是配额：一整天的时间跨度本来就该有多个锚点，命中只说明值得看一眼。',
    });
  }

  // ② 同类流程完整再现（S1）
  const shapeParas = [];
  for (const p of paras) {
    if (p.text.length < STORY_SHAPE.processMinChars || p.text.length > STORY_SHAPE.processMaxChars) continue;
    if (PROCESS_HYPOTHETICAL_RE.test(p.text)) continue;   // 假设/梦境不是"机制被演示了一遍"
    const gs = processShapeOf(p.text);
    if (gs.length >= STORY_SHAPE.processGroupMin) shapeParas.push({ paragraph: p.index, groups: gs, text: p.text });
  }
  const bySig = new Map();
  for (const s of shapeParas) {
    const sig = [...s.groups].sort().join('+');
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(s);
  }
  // 同一组段落可能因为标记组合略有不同而被拆成几个簇（"检测段"既算 copy+result 也算
  // count+result），若逐簇报出，作者会在同一组段号上看到 2–3 条几乎一样的 finding。
  // 这里按**段号集合**去重：同一组段落只报一次，并按"组内段数多、标记多"优先。
  const clusterList = [...bySig.entries()]
    .filter(([, list]) => list.length >= STORY_SHAPE.processClusterLine)
    .sort((a, b) => (b[1].length - a[1].length) || (b[0].split('+').length - a[0].split('+').length));
  const seenGroups = new Set();
  let reported = 0;
  for (const [sig, list] of clusterList) {
    if (reported >= 2) break;
    const key = list.map((s) => s.paragraph).sort((a, b) => a - b).join(',');
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    reported += 1;
    pushFinding(out, {
      rule_id: 'deterministic:process-shape-repeat',
      severity: 'low',
      paragraph: list[0].paragraph,
      excerpt: list.map((s) => `第${s.paragraph + 1}段：${s.text}`).join(' / '),
      message: `${list.length} 段呈现同一种流程形态（标记组合 ${sig}）：第 ${list.map((s) => s.paragraph + 1).join('、')} 段。`
        + '内容不同，但读者读到的过程是重复的（同类机制被再次完整演示）',
      suggestion: '第一次完整展示保留；之后同类流程只写**结果、差异与人物反应**，'
        + '除非这一次带来了新规则、新异常或新风险。判断法：把第 2 段起的流程压成一句话，信息是否减少。',
    });
  }

  // ③ 群众反应功能重复（S3）
  const castNames = (Array.isArray(ctx && ctx.characters) ? ctx.characters : [])
    .map((c) => String((c && c.name) || '').trim()).filter((n) => n.length >= 2);
  const crowdParas = [];
  for (const p of paras) {
    if (p.text.length > STORY_SHAPE.crowdMaxChars) continue;
    CROWD_RE.lastIndex = 0;
    CROWD_REACT_RE.lastIndex = 0;
    if (!CROWD_RE.test(p.text) || !CROWD_REACT_RE.test(p.text)) continue;
    if (castNames.some((n) => p.text.includes(n))) continue;   // 有具名主体 → 不是匿名群众布景
    // 引号占一半以上的段落是对话/应答，不是群众布景（校准抓到的假正例：
    // "队伍里安静了两分钟，又有人开口。"——它是叙述过渡；带引号的那类则是对白）。
    const quoted = (p.text.match(/[“”"「」]/g) || []).length;
    if (quoted * 2 >= p.text.length) continue;
    crowdParas.push(p);
  }
  // 分簇口径刻意**不按具体反应动词**分：作者的原话是"4 次'大厅所有人站起来/欢呼/叹气'
  // 承担**同一功能**"——不同动词恰恰是同一功能的不同说法。第一版按动词分组，
  // 于是"有人吹口哨"与"有人鼓掌"落进两个簇、都不够参考线，正例反而漏报（探针抓到）。
  const crowdCluster = crowdParas.length >= STORY_SHAPE.crowdClusterLine ? { list: crowdParas } : null;
  if (crowdCluster) {
    pushFinding(out, {
      rule_id: 'deterministic:crowd-function-repeat',
      severity: 'low',
      paragraph: crowdCluster.list[0].index,
      excerpt: crowdCluster.list.map((p) => p.text).join(' / '),
      message: `${crowdCluster.list.length} 段匿名群众反应落在同一功能上（第 ${crowdCluster.list.map((p) => p.index + 1).join('、')} 段）：`
        + '都没有具名主体、也不改变任何人物的路线，句子不同但都在证明同一件事',
      suggestion: '群众反应只在"读者的注意力需要被带过去"时写一次；'
        + '第二次起把反应交回某个具名人物（他做了什么、说了什么），或干脆跳过——'
        + '同一件事被不同的群众反应证明多次，读起来是布景在重复，不是场面在推进。',
    });
  }

  // ④ 非转播上下文里的镜头语言（S5 的一半：叙述被切片）
  const cameraParas = [];
  for (const p of paras) {
    CAMERA_WORD_RE.lastIndex = 0;
    if (!CAMERA_WORD_RE.test(p.text)) continue;
    // 上下文的判定必须**前后都看**：讲解章林清雪那一段是整场全国直播，
    // "镜头里她的脸还是没什么表情"后面的"字幕迟了一拍才挂上去"才是它的上下文。
    // 校准第一版只看前一段，于是这一句被误报成"非转播上下文用分镜词"。
    let inContext = MEDIA_CONTEXT_RE.test(p.text) && MEDIA_DEVICE_RE.test(p.text);
    if (!inContext) {
      for (let k = 1; k <= STORY_SHAPE.mediaWindow && !inContext; k += 1) {
        const prev = paras[p.index - k];
        const next = paras[p.index + k];
        if (prev && MEDIA_CONTEXT_RE.test(prev.text)) inContext = true;
        if (next && MEDIA_CONTEXT_RE.test(next.text)) inContext = true;
      }
    }
    cameraParas.push({ paragraph: p.index, inContext, text: p.text });
  }
  const outside = cameraParas.filter((c) => !c.inContext);
  if (outside.length) {
    pushFinding(out, {
      rule_id: 'deterministic:camera-outside-media',
      severity: 'low',
      paragraph: outside[0].paragraph,
      excerpt: outside.map((c) => c.text).join(' / '),
      message: `有 ${outside.length} 段出现镜头调度词，但不在任何转播/拍摄上下文里（同段与相邻段都没有直播、字幕、主持人、画面切等标记）`,
      suggestion: '先确认这一段是不是真的处在"被拍/被播"的视角：'
        + '如果不是，把"镜头拉到/画面切到"改成人物此刻看到的那件具体东西；'
        + '如果是转播视角，保留即可——镜头词本身没有错，错的是没有摄像机的场合。',
    });
  }

  // ⑤ 主角摄像机化（S5）：只做测量，出 finding 需要同时满足两条参考线（避免误报）。
  const povNames = castNames.length ? castNames : [];
  const perceive = [];
  const active = [];
  for (const p of paras) {
    const mine = povNames.length === 0 || povNames.some((n) => p.text.includes(n));
    POV_PERCEIVE_RE.lastIndex = 0;
    POV_ACTIVE_RE.lastIndex = 0;
    if (mine && POV_PERCEIVE_RE.test(p.text)) perceive.push(p.index);
    if (mine && POV_ACTIVE_RE.test(p.text)) active.push(p.index);
  }
  const activeRatio = perceive.length ? new Set(active).size / new Set(perceive).size : 1;
  if (perceive.length >= STORY_SHAPE.povPerceiveLine && activeRatio < STORY_SHAPE.povActiveRatioLine) {
    pushFinding(out, {
      rule_id: 'deterministic:pov-observer',
      severity: 'low',
      paragraph: perceive[0],
      excerpt: `看/听动作 ${perceive.length} 段，主动动作 ${new Set(active).size} 段`,
      message: `主视角人物有 ${perceive.length} 段在"看/听"，只有 ${new Set(active).size} 段主动做事（比值 ${Math.round(activeRatio * 100) / 100}），叙述容易读成摄像机`,
      suggestion: '让人物在被动接收信息之前先有**主动的期待或准备**（他想过什么、做过什么准备、在意哪个数字），'
        + '结果落下来时才有落点；不需要加心理描写，加一个他做过的具体动作就够。',
    });
  }

  return {
    timeline: {
      anchors,
      count: anchors.length,
      period_count: periodAnchors.length,
      paragraphs: anchorParas.size,
      ratio: Math.round(anchorRatio * 1000) / 1000,
      tight_gaps: tightGaps,
    },
    process_shapes: [...bySig.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5)
      .map(([sig, list]) => ({ shape: sig, count: list.length, paragraphs: list.map((s) => s.paragraph) })),
    crowd_reactions: crowdParas.map((p) => p.index),
    camera: {
      total: cameraParas.length,
      outside_media: outside.map((c) => c.paragraph),
      paragraphs: cameraParas,
    },
    pov: {
      perceive_paragraphs: perceive,
      active_paragraphs: [...new Set(active)],
      active_ratio: Math.round(activeRatio * 1000) / 1000,
      object_mentions: (() => { POV_OBJECT_RE.lastIndex = 0; return (paras.map((p) => p.text).join('\n').match(POV_OBJECT_RE) || []).length; })(),
    },
    chars,
  };
}

/**
 * 结构测量值（**与能力开关无关**）：界面可以直接显示"本章时间锚点 N 个 / 同形流程 N 簇"，
 * 开关只控制要不要产出 finding（与 PROMISE 的 system_showcase_count 同一套做法）。
 *
 * ⚠️ 刻意**复用 scanStoryShape 本身**（传一个丢弃用的数组），而不是另写一套计算：
 * 上一版这里各算了一遍，结果两处返回的形状不一致（`timeline.count` vs `timeline_anchor_count`），
 * 探针一跑就崩——同一口径两份实现必然漂移，这是本仓库反复踩过的坑，直接消除掉。
 */
function storyShapeMeasures(text, opts = {}) {
  const sink = [];
  const full = scanStoryShape(paragraphsOf(text), sink, opts);
  return full;
}

/**
 * 过渡性套式动作（"他慢慢点了一下头""他沉默了片刻"这类）。
 * 与词表型套语的区别：这些动作本身**都对**，作者有时就是要用它（人物真的在权衡时点一下头）。
 * 所以这里只统计**密度与种类数**、给作者一个可对照的数字，不产出"应当删掉"的判断。
 * 依据：2026-10-02 作者逐句意见（"慢慢点头/沉默片刻/深吸一口气都没错，只是大模型很容易拿它们当过渡"）。
 * 参考线取自 work#18 第一至三章实测（每 1000 字 ≤ 1.0 为常见区间）。
 */
const GESTURE_CLICHE_RE = /(?:慢慢|缓缓|轻轻|微微)?(?:点了一下头|点了点头|摇了摇头|沉默片刻|沉默了几秒|沉默了一下|顿了一下|顿了顿|深吸一口气|深吸了一口气|吐出一口气|眯起眼|眯起了眼|皱了一下眉|皱了皱眉|抿了一下嘴|抿了抿嘴|扯了一下嘴角|苦笑了一下|苦笑|闭上了眼|闭了闭眼|睁开了眼)/g;

/** 无功能重复检测的窗口（段内 + 跨段相邻重复）。 */
const REPEAT_WINDOW = 2;

const paragraphsOf = (text) => String(text || '')
  .split(/\n+/)
  .map((raw, i) => ({ index: i, text: raw.trim(), offset: 0 }))
  .filter((p) => p.text.length > 0)
  .map((p, i) => ({ ...p, index: i }));

const excerpt = (s, max = 40) => (s.length <= max ? s : `${s.slice(0, max)}…`);

function pushFinding(out, f) {
  out.push({
    rule_id: f.rule_id,
    layer: 'deterministic',
    severity: f.severity || 'low',
    paragraph: Number.isFinite(f.paragraph) ? f.paragraph : null,
    excerpt: excerpt(String(f.excerpt || '')),
    message: String(f.message || ''),
    suggestion: String(f.suggestion || ''),
  });
}

/**
 * 去 AI 腔：机械表达命中（位置 + 摘录）。
 * 只管**用词**层面的套语；「叙述者在场」那两类（过程交代 / 叙述者越界）由 narrative-distance
 * 能力单独负责 —— 同一处只允许一个能力报出来，否则两个能力都开时同一句话会出现两条 finding。
 */
function scanHumanizer(paras, out) {
  for (const p of paras) {
    for (const hit of labelAiTells(p.text)) {
      pushFinding(out, {
        rule_id: 'deterministic:ai-tell',
        severity: 'low',
        paragraph: p.index,
        excerpt: p.text.slice(Math.max(0, hit.index - 8), hit.index + hit.text.length + 8),
        message: `命中机械表达：${hit.label}`,
        suggestion: '改为具体动作 / 感官细节 / 潜台词；若这里的重复或模糊是刻意效果，保留即可。',
      });
    }
  }
}

/** 对白编辑：连续对白过长（没有动作节拍）、对白段落里的资料倾倒。 */
function scanDialogue(paras, out) {
  let run = 0;
  for (const p of paras) {
    const isTalk = /^[「"'“]|^——/.test(p.text) || /[」"'”]$/.test(p.text);
    run = isTalk ? run + 1 : 0;
    if (run === 5) {
      pushFinding(out, {
        rule_id: 'deterministic:dialogue-run',
        severity: 'medium',
        paragraph: p.index,
        excerpt: p.text,
        message: '连续 5 段以上对白没有动作/环境节拍，读者容易失去方位感',
        suggestion: '在两三句对白之间补一个具体动作或环境反应，让说话人和场景可辨。',
      });
    }
    if (isTalk && p.text.length >= 120) {
      pushFinding(out, {
        rule_id: 'deterministic:dialogue-info-dump',
        severity: 'medium',
        paragraph: p.index,
        excerpt: p.text,
        message: '单段对白过长（可能在对白里倾倒设定资料）',
        suggestion: '把信息拆进动作、冲突或提问里；对白只保留人物此刻真的会说的话。',
      });
    }
  }
}

/** 网文节奏：单段过长、整章平均段长偏高。 */
function scanPacing(paras, out) {
  const longLimit = 220;
  for (const p of paras) {
    if (p.text.length > longLimit) {
      pushFinding(out, {
        rule_id: 'deterministic:paragraph-length',
        severity: p.text.length > longLimit * 1.6 ? 'medium' : 'low',
        paragraph: p.index,
        excerpt: p.text,
        message: `单段 ${p.text.length} 字（超过 ${longLimit} 字参考线）`,
        suggestion: '按动作/视角/时间切分段落；网文阅读节奏偏好短段。',
      });
    }
  }
  if (paras.length >= 6) {
    const avg = paras.reduce((n, p) => n + p.text.length, 0) / paras.length;
    if (avg > 160) {
      pushFinding(out, {
        rule_id: 'deterministic:avg-paragraph',
        severity: 'low',
        paragraph: null,
        excerpt: `平均 ${Math.round(avg)} 字/段`,
        message: '全章平均段长偏长（参考线 160 字/段）',
        suggestion: '考虑在情绪转折与对话密集处多分段，提升推进感。',
      });
    }
  }
}

/** 章末钩子：章尾是否存在未完成动作 / 悬念 / 新信息。 */
function scanChapterHook(paras, out) {
  if (!paras.length) return;
  const tail = paras.slice(-2).map((p) => p.text).join('\n');
  EXPLAINED_HOOK_RE.lastIndex = 0;
  const explainedObjectHook = EXPLAINED_HOOK_RE.test(tail);
  EXPLAINED_HOOK_RE.lastIndex = 0;
  const hookish = /[？?]$/.test(tail.trim())
    || /(忽然|突然|就在这时|下一刻|门外|身后|脚步|声音|电话|消息|来信|短信|敲门|还没有|尚未|来不及)/.test(tail)
    || /(：「|："|——)$/.test(tail.trim())
    || explainedObjectHook;
  if (!hookish) {
    pushFinding(out, {
      rule_id: 'deterministic:chapter-hook',
      severity: 'medium',
      paragraph: paras[paras.length - 1].index,
      excerpt: paras[paras.length - 1].text,
      message: '章尾没有明显的未完成动作 / 悬念 / 新信息',
      suggestion: '由本章已有内容自然生长出一个牵引（新信息、被打断的动作或一个疑问），不要凭空抛新事件。',
    });
  }
}

/** 角色声音：同一章里出现"说话方式"标记的堆叠（口癖/语气词过度一致）。 */
function scanCharacterVoice(paras, out, ctx) {
  const characters = Array.isArray(ctx && ctx.characters) ? ctx.characters : [];
  const names = characters.map((c) => String(c && c.name || '').trim()).filter(Boolean);
  if (!names.length) return;
  const voiceMarks = /(?:冷笑|淡淡道|低声道|沉声道|轻声道|叹了口气|摇了摇头|点了点头)/g;
  const hits = [];
  for (const p of paras) {
    voiceMarks.lastIndex = 0;
    let m;
    while ((m = voiceMarks.exec(p.text))) hits.push({ mark: m[0], paragraph: p.index, text: p.text });
  }
  const byMark = new Map();
  for (const h of hits) byMark.set(h.mark, (byMark.get(h.mark) || 0) + 1);
  for (const [mark, n] of byMark) {
    if (n >= 4) {
      pushFinding(out, {
        rule_id: 'deterministic:voice-repeat',
        severity: 'low',
        paragraph: null,
        excerpt: `${mark} ×${n}`,
        message: `角色说话方式标记「${mark}」在本章重复 ${n} 次（容易被读成同一种声音）`,
        suggestion: '按角色卡给不同人物不同的措辞与句式；重复也可能是刻意节拍，由作者判断。',
      });
    }
  }
}

/** 悬疑审视（确定性部分）：伏笔清单里"已回收"标记缺失的项，与本章相关的提醒。 */
function scanMystery(paras, out, ctx) {
  const foreshadows = Array.isArray(ctx && ctx.foreshadows) ? ctx.foreshadows : [];
  const open = foreshadows.filter((f) => f && (f.status === 'open' || !f.status));
  if (open.length >= 3) {
    pushFinding(out, {
      rule_id: 'deterministic:foreshadow-open',
      severity: 'low',
      paragraph: null,
      excerpt: `未回收伏笔 ${open.length} 条`,
      message: '本章时点仍有较多未回收伏笔（线索公平性需要作者核对）',
      suggestion: '核对读者在揭示前是否见过必要线索；不要把谜底建立在本章首次出现的信息上。',
    });
  }
}

/** 感情线（确定性部分）：感情推进只靠旁白宣布（"他意识到自己爱上了"式句子）。 */
function scanRomance(paras, out) {
  const tellPattern = /(意识到|才发现|明白了)[^。！？\n]{0,12}(爱|心动|喜欢|感情)/g;
  for (const p of paras) {
    tellPattern.lastIndex = 0;
    const m = tellPattern.exec(p.text);
    if (!m) continue;
    pushFinding(out, {
      rule_id: 'deterministic:romance-tell',
      severity: 'medium',
      paragraph: p.index,
      excerpt: p.text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8),
      message: '感情变化由旁白直接宣布（读者没有见证过程）',
      suggestion: '把"意识到"换成一次具体选择或举动，让关系变化可被观察。',
    });
  }
}

/** 无功能重复：相邻窗口内完全相同的段落（多半是误粘贴或机械重复）。 */
function scanRepeats(paras, out) {
  for (let i = 0; i < paras.length; i += 1) {
    for (let j = i + 1; j <= Math.min(i + REPEAT_WINDOW, paras.length - 1); j += 1) {
      if (paras[i].text === paras[j].text && paras[i].text.length >= 12) {
        pushFinding(out, {
          rule_id: 'deterministic:duplicate-paragraph',
          severity: 'high',
          paragraph: j,
          excerpt: paras[j].text,
          message: `与第 ${i + 1} 段逐字重复（相邻窗口内）`,
          suggestion: '删除或改写重复段；若是有意复沓，请确认它承担了明确的节奏功能。',
        });
      }
    }
  }
}

/**
 * 结构密度参考线（2026-10-02，R10）。**只报线索，不作改写依据。**
 *
 * 起因（实测）：第三章对既有 28 条红线与 7 项能力扫描 **0 命中**，但读者/作者都能看出
 * "像 AI 写的"——因为那类痕迹不是词，是**密度**：短句占比 34.4%、"三秒"复现 11 次、
 * 微操作动词（拧/按/对准/折）连成精确到齿痕的细节链。词表型规则天生测不到"用得太整齐"，
 * 所以这里补的是**分布**判据，口径全部写在常量上（可离线复算，不是模型打分）。
 *
 * 数值来源：work#18 第一至三章的实测值（文档见 docs/deai-trace-baseline-*.md）。
 * 它们只是"参考线"：超线不代表必须改，未超线也不代表没问题，判断权在作者。
 */
const DENSITY = {
  shortMaxChars: 6,        // 「短句」口径：≤6 个字符（不含首尾空白）
  shortRatioLine: 0.25,    // 整章 ≤6 字句占比参考线
  shortRatioWarn: 0.33,    // 明显趋同
  motifMinCount: 4,        // 同一词面复现次数参考线
  motifMinParas: 3,        // 且必须跨 ≥3 段出现（避免正常称呼/单段内重复被误报）
  motifTop: 5,             // 最多报几个意象
  actionRunMin: 4,         // 同段连续短动作句参考线
  actionRunMaxChars: 12,   // 「短动作句」口径：≤12 字
  actionPer1000Line: 9,    // 微操作动词密度参考线（每 1000 字）
  // 比喻提示词密度（口径：像 / 如同 / 仿佛 / 似的 / 犹如 / 宛如 每 1000 汉字；
  // 「像」已覆盖"好像/像是"）。2026-10-02 实测：第一章 2.9、第二章 3.3、第三章 5.9——
  // 作者对这一章的判断正是"几乎每隔一小段就有一个非常完整的比喻"，参考线因此放在 4.5。
  metaphorPer1000Line: 4.5,
  isoMinCount: 2,          // 同一同构句式家族出现几次才报
  maxFindings: 3,          // 单类最多报几条（避免刷屏）
  // 2026-10-02（作者第三轮意见新增，全部为**描述性**测量，不产出"必须改成什么"）：
  // 过渡性套式动作密度（"慢慢点了一下头""沉默了片刻"这一级，每 1000 字）。
  gesturePer1000Line: 1.0,
  // 同一个过渡动作在本章重复几次才报（作者对本章的意见正是"同一种动作写了两遍"，
  // 而全章密度只有 0.2/千字 —— 只报密度会漏掉它，所以重复单独设线）。
  gestureRepeatMin: 2,
  // 「过程交代」与「叙述者越界」的密度参考线（每 1000 字）。两者都是"叙述者在场"的痕迹：
  // 前者把"话怎么被磨到能说出口"讲出来，后者替人物按年龄/常理解释。
  // 它们不是用词问题，词表型红线测不到 —— 所以单独给密度口径，而不是塞进 AI_TELLS 就完事。
  processPer1000Line: 1.5,
  narratorPer1000Line: 1.5,
  // 「细节二次调出」：同一个含数字的短词面（如 0731）出现在 ≥ 该段数的段落里才报。
  // 口径刻意保守：普通章节里数字本来就少，跨 4 段复现基本只可能是"被反复调出来用"。
  callbackTokenMinParas: 4,
  // 「摄像机叙事」：镜头/画面/远景等词在真实转播场景里可以成立，
  // 这里只把高密度当作线索，不把单个词判成错误。
  cameraPer1000Line: 3.0,
  // 「自我撤回」：像……或者只是……、其实……根本……这类作者替读者校正画面的句式。
  hedgeCorrectionMin: 1,
  // 「作者代读」章尾：异常物件 + 主角未察觉，常是模型自动补出的悬念解释。
  explainedHookMin: 1,
  // 身体部位 + 微动作在相邻短句中成串出现，专门提示“手/嘴/眼/后颈/裤腿”轮播。
  bodyActionChainMin: 2,
};

/** 微操作动词：精确到"齿痕/丝纹"式细节链的动作核心。 */
const MICRO_ACTION_RE = /(拧|按住|按下|按回|按|折回|折|对准|对|转|插|拔出|拔|搓|压|拉|推|放回|放|收|摸|碰|捏|握|塞|抽|擦|敲|勾|划|扣|解开|系|蹭|抠|刮|捋|掖|拽|碾|摩|递|接|抱|拎|托)/g;

const BODY_PART_RE = /(手|手心|手背|指尖|手指|嘴|嘴唇|眼睛|眼|目光|后颈|肩膀|肩|裤腿|耳机线|耳朵|脸)/g;
const BODY_ACTION_RE = /(摸|碰|蹭|插|抽|握|捏|塞|扯|抿|张|闭|睁|盯|看|转|缩|垂|抬|低|绕|抓|擦|按|收|放)/g;
const CAMERA_LANGUAGE_RE = /(镜头|画面|远景|近景|特写|切回|切到|推到|拉远|镜头抖|画面白)/g;
const SELF_WITHDRAWAL_RE = /(?:像是|像在|似乎|仿佛)[^。！？\n]{0,24}(?:或者|也可能|只是)/g;
const REALITY_CORRECTION_RE = /(?:其实|不过其实|但其实)[^。！？\n]{0,20}(?:根本|并不|看不到|没有)/g;
const EXPLAINED_HOOK_RE = /(?:书包|背包|口袋|手里|身后|门后|抽屉|包里)[^。！？\n]{0,18}(?:多了|多出|多着|有了|传来|动了|沉了|重了|响了)[^。！？\n]{0,18}(?:。|！|？|\n){0,1}\s*(?:他|她|主角)?(?:没有|未曾|没)[^。！？\n]{0,8}(?:察觉|发现|注意|意识到)/g;

/** 同构句式家族：只统计形态与次数，不判断好坏（作者自行取舍）。 */
const ISO_PATTERNS = [
  { id: 'not-is', label: '「不是X。是Y。」式二次定义', re: /(?:不是|并非)[^。！？\n]{1,14}[。，]\s*(?:是|而是)[^。！？\n]{1,14}[。]/g },
  { id: 'x-is-x', label: '「X 就是 X」式同义复沓', re: /([^\s，。！？、]{2,8})就是\1/g },
  { id: 'no-a-no-b', label: '「没有A。也没有B。」式并列否定', re: /没有[^。！？\n]{1,12}。\s*也?没有[^。！？\n]{1,12}。/g },
  { id: 'triple-short', label: '连续三个 ≤4 字短句', re: /[^。！？\n]{1,4}。[^。！？\n]{1,4}。[^。！？\n]{1,4}。/g },
];

/** 意象统计要排除的虚词/泛词（避免把"没有""一个"读成意象）。 */
const MOTIF_STOP = new Set(['没有', '不是', '就是', '还是', '什么', '那个', '这个', '自己', '一个', '两个', '他的', '她的', '他们', '我们', '可以', '不能', '已经', '时候', '东西', '地方', '然后', '因为', '所以', '但是', '如果', '只有', '只是', '一样', '有点', '一点', '起来', '出来', '过来', '上去', '下去', '一声', '一下', '一眼', '一句', '有人', '有个人']);

/**
 * 虚词/功能字：n-gram 会切出"了一""他把""的时候"这类跨词碎片，
 * 规则是——**意象词的第一个和最后一个字都不该是功能字**（"检测""书包""三秒"能过，"了一""他把"过不了）。
 */
const MOTIF_FUNC_CHARS = new Set('的了把是在有就也都和与被给着过这那他她它一个上下里外来去时候你我它们很再又还只才更最没不么呢吗啊呀然后因为所以如果'.split(''));

/** 以动词收尾的 n-gram 多半是跨词碎片（"抬头看""回头看他"切出的"头看"），不作为意象统计。 */
const MOTIF_VERB_TAIL = new Set('看说道想听走笑问答站坐瞧望盯喊叫'.split(''));

const isContentishToken = (t) => t.length >= 2 && !MOTIF_FUNC_CHARS.has(t[0]) && !MOTIF_FUNC_CHARS.has(t[t.length - 1]) && !MOTIF_VERB_TAIL.has(t[t.length - 1]);

/** 切句（与 ai/story-state/style-quality.mjs 同口径：段落 → 句末标点；本模块保持零依赖，故本地实现）。 */
function splitSentencesLocal(text) {
  const out = [];
  for (const para of String(text || '').split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    let buf = '';
    for (const ch of p) {
      buf += ch;
      if (/[。！？!?…]/.test(ch)) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

/** 高频词面（意象/物件/口头禅）统计：2–5 字中文 n-gram，按段去重后计数。 */
function motifStats(paras, exclude = []) {
  const map = new Map();
  for (const p of paras) {
    for (let n = 2; n <= 5; n += 1) {
      for (let i = 0; i + n <= p.text.length; i += 1) {
        const tok = p.text.slice(i, i + n);
        if (!/^[\u4e00-\u9fa5]+$/.test(tok)) continue;
        if (MOTIF_STOP.has(tok)) continue;
        if (!isContentishToken(tok)) continue;
        if (exclude.some((x) => x && x.includes(tok))) continue;
        const e = map.get(tok) || { token: tok, count: 0, paragraphs: new Set() };
        e.count += 1;
        e.paragraphs.add(p.index);
        map.set(tok, e);
      }
    }
  }
  // 先筛出够线的候选（数量小，后续嵌套判断才不至于爆掉），再按出现次数优先排序。
  const cands = [...map.values()].filter((e) => e.count >= DENSITY.motifMinCount && e.paragraphs.size >= DENSITY.motifMinParas);
  // 去嵌套三则：① 已被采纳词包含的长词让位；② 包含已采纳词的超集让位（"检测石"让位于"检测"）；
  // ③ 本身是另一个"同样常见"的更长词面的碎片时让位（"测中"来自"检测中心"，不是独立意象）。
  const accepted = [];
  for (const e of cands.sort((a, b) => (b.count - a.count) || (b.token.length - a.token.length))) {
    if (accepted.some((a) => a.token.includes(e.token) || e.token.includes(a.token))) continue;
    if (cands.some((o) => o.token.length > e.token.length && o.token.includes(e.token) && o.count >= Math.max(DENSITY.motifMinCount, e.count * 0.5))) continue;
    accepted.push(e);
    if (accepted.length >= DENSITY.motifTop) break;
  }
  return accepted.map((e) => ({ token: e.token, count: e.count, paragraphs: e.paragraphs.size }));
}

/**
 * 结构密度审视：四类**分布**判据（短句占比 / 同构句式 / 意象复现 / 微操作链）。
 * 返回本次的测量值，供调用方原样报告给作者（不返回"应当改成什么"）。
 */
function scanStyleDensity(paras, out, ctx) {
  const text = paras.map((p) => p.text).join('\n');
  const chars = text.length;
  const sentences = splitSentencesLocal(text);
  const lens = sentences.map((s) => s.length);
  const shortCount = lens.filter((n) => n <= DENSITY.shortMaxChars).length;
  const ratio = sentences.length ? shortCount / sentences.length : 0;

  // ① 短句占比：整章节奏趋同
  if (sentences.length >= 20 && ratio > DENSITY.shortRatioLine) {
    pushFinding(out, {
      rule_id: 'deterministic:short-sentence-ratio',
      severity: ratio > DENSITY.shortRatioWarn ? 'medium' : 'low',
      paragraph: null,
      excerpt: `≤${DENSITY.shortMaxChars} 字句 ${shortCount}/${sentences.length}（${Math.round(ratio * 1000) / 10}%）`,
      message: `短句占比 ${Math.round(ratio * 1000) / 10}%，超过参考线 ${Math.round(DENSITY.shortRatioLine * 100)}%（整章断句方式趋同）`,
      suggestion: '把一部分短句并回长句，或在短句之间插入动作、对话与环境变化；刻意留白可以保留，但不要整章都是同一种断句节奏。',
    });
  }

  // ② 同构句式家族
  const iso = {};
  for (const fam of ISO_PATTERNS) {
    fam.re.lastIndex = 0;
    const found = text.match(fam.re) || [];
    iso[fam.id] = found.length;
    if (found.length < DENSITY.isoMinCount) continue;
    pushFinding(out, {
      rule_id: 'deterministic:isomorphic-sentence',
      severity: 'low',
      paragraph: null,
      excerpt: found[0],
      message: `${fam.label}在本章出现 ${found.length} 次（同一句式反复使用，容易被读成模板）`,
      suggestion: '保留最有力度的一两处，其余改用不同句式或直接把意思写进动作与对话里。',
    });
  }

  // ③ 意象/物件复现
  const names = (Array.isArray(ctx && ctx.characters) ? ctx.characters : [])
    .map((c) => String((c && c.name) || '').trim()).filter(Boolean);
  const motifs = motifStats(paras, names);
  if (motifs.length) {
    pushFinding(out, {
      rule_id: 'deterministic:motif-repeat',
      severity: motifs[0].count >= DENSITY.motifMinCount * 2 ? 'medium' : 'low',
      paragraph: null,
      excerpt: motifs.map((m) => `${m.token}×${m.count}`).join('、'),
      message: `以下词面复现偏多：${motifs.map((m) => `${m.token}×${m.count}`).join('、')}（参考线：单个 ≤${DENSITY.motifMinCount - 1} 次）`,
      suggestion: '同一意象全章最多承担两三次；其余用代称、换感官通道，或干脆留一处不回收——呼应不必处处闭环。',
    });
  }

  // ④ 比喻密度：稳定的"文学输出功率"（每隔一小段就有一句完整比喻）是最像 AI 的特征之一。
  const METAPHOR_RE = /像|如同|仿佛|似的|犹如|宛如/g;
  const metaphorHits = text.match(METAPHOR_RE) || [];
  const metaphorPer1000 = chars ? Math.round((metaphorHits.length * 1000) / chars * 10) / 10 : 0;
  if (metaphorPer1000 > DENSITY.metaphorPer1000Line) {
    pushFinding(out, {
      rule_id: 'deterministic:metaphor-density',
      severity: metaphorPer1000 > DENSITY.metaphorPer1000Line * 1.5 ? 'medium' : 'low',
      paragraph: null,
      excerpt: `比喻提示词 ${metaphorHits.length} 次（${metaphorPer1000}/千字）`,
      message: `比喻密度 ${metaphorPer1000}/千字，超过参考线 ${DENSITY.metaphorPer1000Line}（比喻的质量与密度都太均匀，读起来像持续的"文学输出功率"）`,
      suggestion: '只保留真正有力的那几处，多数段落用普通叙述即可；真人写作的比喻密度是有波动的，不必每一小段都"好看"。',
    });
  }

  // ⑤ 微操作链：精确到齿痕/丝纹的动作密度
  MICRO_ACTION_RE.lastIndex = 0;
  const actionHits = text.match(MICRO_ACTION_RE) || [];
  const per1000 = chars ? Math.round((actionHits.length * 1000) / chars * 10) / 10 : 0;
  const runs = [];
  for (const p of paras) {
    const sents = splitSentencesLocal(p.text);
    let run = 0;
    for (const s of sents) {
      MICRO_ACTION_RE.lastIndex = 0;
      const isMicro = s.length <= DENSITY.actionRunMaxChars && MICRO_ACTION_RE.test(s);
      run = isMicro ? run + 1 : 0;
      if (run === DENSITY.actionRunMin) { runs.push({ paragraph: p.index, excerpt: s }); break; }
    }
  }
  if (per1000 > DENSITY.actionPer1000Line || runs.length) {
    pushFinding(out, {
      rule_id: 'deterministic:micro-action-density',
      severity: runs.length >= DENSITY.maxFindings ? 'medium' : 'low',
      paragraph: runs.length ? runs[0].paragraph : null,
      excerpt: runs.length ? runs[0].excerpt : `微操作动词 ${actionHits.length} 次（${per1000}/千字）`,
      message: `微操作动作密度 ${per1000}/千字（参考线 ${DENSITY.actionPer1000Line}），其中 ${runs.length} 段出现连续 ${DENSITY.actionRunMin} 个以上短动作句（拧/按/对准/折这一级）`,
      suggestion: '一个场景只保留一到两处"精确到毫米"的动作，其余改成结果或感受（他合上笔帽 → 声音很脆），不必把每个环节都写出来。',
    });
  }

  // ⑥ 过渡性套式动作（"慢慢点了一下头""沉默了片刻"）：只测密度与种类，不判"该不该用"。
  //    为什么不做成词表型红线（ai-tell）：这些动作本身都对，人物真在权衡时点一下头是正常的；
  //    大模型的毛病是**把它当节拍器用**——一需要停顿就来一个。密度与种类数才是判据。
  //    两条判据分开：① 密度超线（整章用量）；② **同一种重复**（同章里同一个动作写两遍以上）。
  //    作者对本章的判断正是后者："「他慢慢点了一下头」有点常规生成动作"，而不是全章泛滥——
  //    所以"种类少而重复多"必须能报出来，只报密度会把它漏掉（本章实测密度仅 0.2/千字）。
  GESTURE_CLICHE_RE.lastIndex = 0;
  const gestureHits = text.match(GESTURE_CLICHE_RE) || [];
  const gestureKinds = new Set(gestureHits).size;
  const gesturePer1000 = chars ? Math.round((gestureHits.length * 1000) / chars * 10) / 10 : 0;
  const gestureDupes = [...gestureHits.reduce((m, g) => m.set(g, (m.get(g) || 0) + 1), new Map())]
    .filter(([, n]) => n >= DENSITY.gestureRepeatMin).sort((a, b) => b[1] - a[1]);
  if (gesturePer1000 > DENSITY.gesturePer1000Line) {
    pushFinding(out, {
      rule_id: 'deterministic:gesture-cliche-density',
      severity: gestureHits.length >= 8 ? 'medium' : 'low',
      paragraph: null,
      excerpt: gestureHits.slice(0, 6).join('、') + (gestureHits.length > 6 ? ` 等 ${gestureHits.length} 处` : ''),
      message: `过渡性动作 ${gestureHits.length} 处（${gesturePer1000}/千字，${gestureKinds} 种），超过参考线 ${DENSITY.gesturePer1000Line}`,
      suggestion: '这类动作本身没错，问题是当节拍器用：需要"停一下"就来一个点头/沉默/吸气。'
        + '检查每一处——如果删掉它，读者得到的**信息**没有减少、只是少了一次停顿，那它就是填充；'
        + '真在权衡、真的没话说时保留即可。',
    });
  }
  if (gestureDupes.length) {
    pushFinding(out, {
      rule_id: 'deterministic:gesture-cliche-repeat',
      severity: 'low',
      paragraph: null,
      excerpt: gestureDupes.map(([g, n]) => `${g}×${n}`).join('、'),
      message: `同一个过渡动作在本章写了 ${gestureDupes.map(([g, n]) => `${n} 次（${g}）`).join('、')}`,
      suggestion: '保留一处即可：这类动作写第二遍时几乎不再提供新信息，反而让节奏显得是"按模板补拍"。'
        + '若要保留两处，第二处换个具体动作（做一件与当下目标有关的事）而不是换个副词。',
    });
  }

  // ⑦ 「过程交代」与「叙述者越界」的密度（2026-10-02 作者点名的两类）。
  //    这两类**不是用词**问题，而是叙述者在场的问题：①把"话怎么被磨到能说出口"讲出来；
  //    ②叙述者站到人物外面，拿年龄/常理替他解释。词表型红线永远测不到，所以单独给口径。
  //    判据口径：**出现即值得看**（作者是按逐处读的），但只在 ≥2 处时升级为"整章密度"表述，
  //    一处时仍报出来——它可能就是全章唯一的叙述者越界点，静默略过等于把线索丢掉。
  const procHits = text.match(PROCESS_EXPLAIN_RE) || [];
  const procPer1000 = chars ? Math.round((procHits.length * 1000) / chars * 10) / 10 : 0;
  if (procHits.length) {
    pushFinding(out, {
      rule_id: 'deterministic:process-explanation',
      severity: 'low',
      paragraph: null,
      excerpt: procHits[0],
      message: procHits.length === 1
        ? '1 处「把话/念头在心里磨到位」的过程交代'
        : `「把话/念头在心里磨到位」的过程交代 ${procHits.length} 处（${procPer1000}/千字）`,
      suggestion: '写他"想说什么"通常比写他"怎么把它想顺"更有力：'
        + '直接给那句话或那个念头即可；磨的过程多数时候是在替读者铺垫情绪，收掉它力度反而更大。',
    });
  }
  const narrHits = text.match(NARRATOR_INTRUSION_RE) || [];
  const narrPer1000 = chars ? Math.round((narrHits.length * 1000) / chars * 10) / 10 : 0;
  if (narrHits.length) {
    pushFinding(out, {
      rule_id: 'deterministic:narrator-intrusion',
      severity: 'low',
      paragraph: null,
      excerpt: narrHits[0],
      message: narrHits.length === 1
        ? '1 处叙述者替人物按年龄/常理作解释'
        : `叙述者替人物按年龄/常理作解释 ${narrHits.length} 处（${narrPer1000}/千字）`,
      suggestion: '「这个年纪遇到这种事…」「换了谁都会…」是把人物放回人群作参照，读者会感到有个外人站在旁边。'
        + '改成他本人此刻的动作或那句话；真要解释，留给人物自己说。',
    });
  }

  // ⑧ 「细节二次调出」（测量值）：同一个编号/道具在多段里被反复引用（如 0731 出现在 4 段）。
  //    这里只把数字**报给界面**（density.callback_tokens）；要不要出 finding 由 scene-logic 能力决定，
  //    避免两处各报一条同名 finding（同一件事在报告里出现两遍就是噪音）。
  const callbacks = numericRecallTokens(paras);

  // ⑨「摄像机叙事」与自我撤回：这是视角/叙述姿态问题，不是单纯禁词。
  CAMERA_LANGUAGE_RE.lastIndex = 0;
  const cameraHits = text.match(CAMERA_LANGUAGE_RE) || [];
  const cameraPer1000 = chars ? Math.round((cameraHits.length * 1000) / chars * 10) / 10 : 0;
  const withdrawals = text.match(SELF_WITHDRAWAL_RE) || [];
  const corrections = text.match(REALITY_CORRECTION_RE) || [];
  if (cameraPer1000 > DENSITY.cameraPer1000Line) {
    pushFinding(out, {
      rule_id: 'deterministic:camera-narration-density',
      severity: cameraPer1000 > DENSITY.cameraPer1000Line * 2 ? 'medium' : 'low',
      paragraph: null,
      excerpt: cameraHits.slice(0, 6).join('、'),
      message: `镜头/画面调度词 ${cameraHits.length} 次（${cameraPer1000}/千字），叙述可能被读成分镜脚本`,
      suggestion: '检查是否真的需要转播视角；若只是人物所见，改写成角色当下看到/听到的一个具体东西。',
    });
  }
  if (withdrawals.length + corrections.length >= DENSITY.hedgeCorrectionMin) {
    pushFinding(out, {
      rule_id: 'deterministic:self-withdrawal',
      severity: 'low',
      paragraph: null,
      excerpt: [...withdrawals, ...corrections][0],
      message: `发现 ${withdrawals.length + corrections.length} 处“像……或者只是……”或现实性自我校正`,
      suggestion: '删去作者替读者撤回/校正的半句，保留人物真正看到的东西；不确定性应由人物处境承担。',
    });
  }

  // ⑩ 身体部位 + 微动作链：只在相邻短句成串时提示，避免把正常动作一律判成 AI。
  let bodyChainRuns = 0;
  for (const p of paras) {
    const ss = splitSentencesLocal(p.text);
    let run = 0;
    for (const s of ss) {
      BODY_PART_RE.lastIndex = 0;
      BODY_ACTION_RE.lastIndex = 0;
      const body = BODY_PART_RE.test(s);
      const action = BODY_ACTION_RE.test(s);
      run = body && action && s.length <= 32 ? run + 1 : 0;
      if (run >= DENSITY.bodyActionChainMin) { bodyChainRuns += 1; break; }
    }
  }
  if (bodyChainRuns) {
    pushFinding(out, {
      rule_id: 'deterministic:body-action-chain',
      severity: 'low',
      paragraph: null,
      excerpt: `相邻短句链 ${bodyChainRuns} 段`,
      message: `发现 ${bodyChainRuns} 段“身体部位 + 微动作”连续链，可能在用动作轮播代替情绪`,
      suggestion: '只保留真正改变局面的动作；其余直接写结果、选择或一句潜台词。',
    });
  }

  // ⑪ 章尾作者代读：把“异常发生 + 主角没察觉”说透，常使悬念显得自动生成。
  const explainedHooks = text.match(EXPLAINED_HOOK_RE) || [];
  if (explainedHooks.length >= DENSITY.explainedHookMin) {
    pushFinding(out, {
      rule_id: 'deterministic:explained-hook',
      severity: 'low',
      paragraph: null,
      excerpt: explainedHooks[0],
      message: '章内出现“异常物件 + 主角未察觉”的代读式悬念句',
      suggestion: '让异常只通过物理变化发生，或停在主角最后一个动作；不要替读者解释“他不知道”。',
    });
  }
  return {
    chars,
    sentences: sentences.length,
    short_sentence_ratio: Math.round(ratio * 1000) / 1000,
    metaphor_count: metaphorHits.length,
    metaphor_per_1000: metaphorPer1000,
    micro_action_count: actionHits.length,
    micro_action_per_1000: per1000,
    action_runs: runs.length,
    gesture_count: gestureHits.length,
    gesture_kinds: gestureKinds,
    gesture_per_1000: gesturePer1000,
    process_explanation_count: procHits.length,
    process_explanation_per_1000: procPer1000,
    narrator_intrusion_count: narrHits.length,
    narrator_intrusion_per_1000: narrPer1000,
    callback_tokens: callbacks,
    camera_count: cameraHits.length,
    camera_per_1000: cameraPer1000,
    self_withdrawal_count: withdrawals.length,
    reality_correction_count: corrections.length,
    body_action_chain_runs: bodyChainRuns,
    explained_hook_count: explainedHooks.length,
    motifs,
    iso,
    thresholds: { ...DENSITY, motifTop: undefined },
  };
}

/**
 * 物件方位陈述的识别（用于"位置是否自相矛盾"这一条确定性判据）。
 *
 * 作者原话："剑到底最开始就在主袋还是某个更深夹层，最好稍微确定一下。不是什么大问题，
 * 但空间关系清楚，会让整个场景更可信。"
 *
 * 判据的正则直接写在 scanSceneLogic 里（它需要把 obj/container/level 三组一起用），
 * 这里只留说明：**能力边界是刻意的** —— 只有当"同一个物件名"在章内被陈述到两个不同层级/容器时
 * 才报（零误报口径）。跨句的空间推断（例如"清单显示这一层装着别的东西"）纯文本做不可靠，
 * 那部分交给 scene-logic 能力的提示词文本，由模型读蓝图/正文时核对。
 */

/** 含数字的编号/道具在多段里被反复调出的统计（0731 这类）。密度判据与场景逻辑共用。 */
function numericRecallTokens(paras) {
  const map = new Map();
  for (const p of paras) {
    for (const m of p.text.matchAll(/\d{2,6}/g)) {
      const tok = m[0];
      const e = map.get(tok) || { token: tok, paragraphs: new Set() };
      e.paragraphs.add(p.index);
      map.set(tok, e);
    }
  }
  return [...map.values()].filter((e) => e.paragraphs.size >= DENSITY.callbackTokenMinParas)
    .map((e) => ({ token: e.token, paragraphs: e.paragraphs.size }))
    .sort((a, b) => b.paragraphs - a.paragraphs);
}

/** 「叙述者在场」两类痕迹的逐段定位（过程交代 / 叙述者越界）。 */
function scanNarrativeDistance(paras, out) {
  for (const p of paras) {
    for (const hit of labelNarrativeTells(p.text)) {
      pushFinding(out, {
        rule_id: 'deterministic:narrator-distance',
        severity: 'low',
        paragraph: p.index,
        excerpt: p.text.slice(Math.max(0, hit.index - 8), hit.index + hit.text.length + 8),
        message: `叙述者痕迹：${hit.label}`,
        suggestion: hit.label.startsWith('过程交代')
          ? '直接写他"想说什么"（那句话本身）即可：交代它怎么被磨到能说出口，是在替读者铺垫情绪；收掉它力度反而更大。'
          : '把解释交回人物：写他此刻的动作或那句话；叙述者站出来按年龄/常理替他说明，读者会感到有个外人在场。',
      });
    }
  }
}

/**
 * 跨段整句重复（第四批）：同一句去标点后逐字相同，且出现在 **≥3 个段落** → 报。
 *
 * 与 `scanRepeats`（相邻 2 段窗口的整段重复）的分工：那条管"整段被粘贴两遍"，
 * 这条管"某**一句**在章内被复制到别处"——作者复核稿里的事故正是这一种
 * （「岳宸炎把手从石板上拿开。」在相邻两段各出现一次），而窗口只有 2 段时会漏掉隔段的那次。
 *
 * 门槛（为什么是 3 段、为什么 ≥10 字）：
 *   · 正常的刻意复沓（强调句、口头禅、排比）最多跨两段，压到 2 段会立刻误伤；
 *   · 太短的句子（"嗯。""他不知道。"）在章内重复是正常节奏，不是事故。
 */
const DUPLICATE_MIN_CHARS = 10;
const normalizeSentence = (s) => String(s || '').replace(/[\s，。！？、；：,.!?;:「」“”"'（）()【】…—\-]/g, '');
function scanDuplicateSentences(paras, out) {
  const groups = new Map();
  for (const p of paras) {
    for (const sent of p.text.split(/(?<=[。！？!?…])/)) {
      const norm = normalizeSentence(sent);
      if (norm.length < DUPLICATE_MIN_CHARS) continue;
      const g = groups.get(norm) || { raw: String(sent).trim(), paragraphs: [] };
      if (!g.paragraphs.includes(p.index)) g.paragraphs.push(p.index);
      groups.set(norm, g);
    }
  }
  for (const g of groups.values()) {
    if (g.paragraphs.length < 3) continue;
    pushFinding(out, {
      rule_id: 'deterministic:duplicate-sentence',
      severity: 'high',
      paragraph: g.paragraphs[0],
      excerpt: g.raw,
      message: `同一句在 ${g.paragraphs.length} 个段落里逐字重复（第 ${g.paragraphs.map((i) => i + 1).join('、')} 段）`,
      suggestion: '删除或改写重复句；若是有意复沓，请确认它承担了明确的节奏功能，并把出现次数压到两处以内。',
    });
  }
}

/** 中文数字串 → 数值（只支持"九十五""十""一百"这一级）。 */
function cnNumber(s) {
  const t = String(s || '');
  if (!t) return NaN;
  if (!/[十百]/.test(t)) {
    let n = 0;
    for (const c of t) {
      if (CN_DIGITS[c] === undefined) return NaN;
      n = n * 10 + CN_DIGITS[c];
    }
    return n;
  }
  let total = 0;
  let section = 0;
  let num = 0;
  for (const c of t) {
    const v = CN_DIGITS[c];
    if (v === undefined) return NaN;
    if (v === 10) { section += (num || 1) * 10; num = 0; }
    else if (v === 100) { total += (section + (num || 1)) * 100; section = 0; num = 0; }
    else num = v;
  }
  return total + section + num;
}

/** 与 patch-safety.js 同口径的实体名候选还原（去连接词 + 剥首尾单字虚词）。 */
function labelFromWindow(before) {
  let s = String(before || '');
  for (const w of LABEL_MULTI_STOPWORDS) s = s.split(w).join('');
  s = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let g = 0; g < 12 && s.length > 1 && LABEL_EDGE_CHARS.has(s[0]); g += 1) s = s.slice(1);
  for (let g = 0; g < 12 && s.length > 1 && LABEL_EDGE_CHARS.has(s[s.length - 1]); g += 1) s = s.slice(0, -1);
  return s;
}

/** 离这个数字最近的人物卡名字（同段内搜索）。 */
function nearestName(paragraph, at, names) {
  const p = String(paragraph || '');
  let best = '';
  let bestDist = Infinity;
  for (const n of names || []) {
    if (!n) continue;
    let from = 0;
    for (;;) {
      const idx = p.indexOf(n, from);
      if (idx < 0) break;
      const dist = idx <= at ? at - idx : idx - at;
      if (dist < bestDist) { bestDist = dist; best = n; }
      from = idx + n.length;
    }
  }
  return best;
}

/** 本章的编号事实（与补丁门禁同一契约：编号+后缀，或数字前的连线词）。 */
function factCandidates(paras, ctx) {
  const names = (Array.isArray(ctx && ctx.characters) ? ctx.characters : []).map((c) => String((c && c.name) || '').trim()).filter((s) => s.length >= 2);
  const numRe = /([0-9０-９]{1,8})(?:号|编号|排号|座号|学号|考号|号码|班级|年级|届|楼层|层|房间|室|岁|年)?/g;
  const suffixRe = new RegExp(`^\\s*(?:${ID_SUFFIX})`);
  const preLabelRe = new RegExp(`(${LINK_WORDS})$`);
  const out = [];
  for (const p of paras) {
    for (const m of p.text.matchAll(numRe)) {
      const digits = String(m[1]).replace(/[^0-9０-９]/g, '');
      const value = digits.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/^0+(?=\d)/, '');
      if (!value || value.length > 6) continue;
      if (/[0-9０-９]/.test(p.text.slice(m.index + m[1].length, m.index + m[1].length + 1))) continue;
      const tail = p.text.slice(m.index + m[1].length);
      const suffix = suffixRe.test(tail) ? (tail.match(suffixRe) || [''])[0].trim() : '';
      const winText = p.text.slice(Math.max(0, m.index - 20), m.index);
      if (!suffix && !preLabelRe.test(winText)) continue;
      const label = labelFromWindow(winText);
      const owner = nearestName(p.text, m.index, names);
      if (!label && !owner) continue;
      out.push({ value, label, owner, paragraph: p.index, excerpt: p.text.slice(Math.max(0, m.index - 10), m.index + m[0].length + 10) });
    }
  }
  return out;
}

/** 本章列出的所有概率数值（百分比 + 稀有度词；口径与 patch-safety.js 的 collectPercents 同源）。 */
function collectPercents(text) {
  const base = String(text || '');
  const out = [];
  for (const m of base.matchAll(PERCENT_RE)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 100) out.push(v);
  }
  for (const m of base.matchAll(CN_NUM_RE)) {
    const raw = m[0];
    const tail = base.slice(m.index + raw.length, m.index + raw.length + 3);
    const before2 = base.slice(Math.max(0, m.index - 3), m.index);
    // "X分之一"结构交给稀有度词表；"十万分之一"里的"十"后面跟的是"万分"，两个方向都要判。
    if (/^(分之|万分|千分)/.test(tail) || /分之$/.test(before2)) continue;
    if (!raw.startsWith('百分之') && !PROBABILITY_CONTEXT_RE.test(base.slice(Math.max(0, m.index - 16), m.index))) continue;
    const v = raw.startsWith('百分之') ? cnNumber(raw.slice(3)) : cnNumber(raw);
    if (Number.isFinite(v) && v > 0 && v <= 100) out.push(v);
  }
  for (const m of base.matchAll(RARITY_FORMS)) out.push(RARITY_VALUE[m[1]]);
  return out;
}

/**
 * 数值一致性（能力 number-lock）：编号冲突 / 同一编号两个主人 / 百分比合计。**只报告**。
 */
function scanNumberLock(paras, out, ctx) {
  const text = paras.map((p) => p.text).join('\n');
  const cands = factCandidates(paras, ctx);
  // ① 同一实体两个值
  const byLabel = new Map();
  for (const e of cands) {
    if (!e.label) continue;
    const arr = byLabel.get(e.label) || [];
    arr.push(e);
    byLabel.set(e.label, arr);
  }
  let reported = 0;
  for (const [label, arr] of byLabel) {
    if (reported >= FACT_LOCK.maxFindings) break;
    const values = [...new Set(arr.map((e) => e.value))];
    if (values.length < 2) continue;
    const where = values.map((v) => `第 ${(arr.find((e) => e.value === v) || {}).paragraph + 1} 段「${v}」`).join('、');
    reported += 1;
    pushFinding(out, {
      rule_id: 'deterministic:number-conflict',
      severity: 'high',
      paragraph: arr[0].paragraph,
      excerpt: arr[0].excerpt,
      message: `同一实体「${label}」在本章被写成两个不同编号（${where}）`,
      suggestion: '编号是既有事实：核对哪一处是笔误，并检查全章对同一个号的引用是否一致。'
        + '（改稿时这类改动会被修稿安全门禁拦下，不会自动写进正文。）',
    });
  }
  // ② 同一编号两个主人
  const byValue = new Map();
  for (const e of cands) {
    if (!e.owner) continue;
    const arr = byValue.get(e.value) || [];
    arr.push(e);
    byValue.set(e.value, arr);
  }
  reported = 0;
  for (const [value, arr] of byValue) {
    if (reported >= FACT_LOCK.maxFindings) break;
    const owners = [...new Set(arr.map((e) => e.owner))];
    if (owners.length < 2) continue;
    const where = owners.map((o) => `第 ${(arr.find((e) => e.owner === o) || {}).paragraph + 1} 段「${o}」`).join('、');
    reported += 1;
    pushFinding(out, {
      rule_id: 'deterministic:number-conflict',
      severity: 'high',
      paragraph: arr[0].paragraph,
      excerpt: arr[0].excerpt,
      message: `编号「${value}」在本章同时挂在两个人物名下（${where}）`,
      suggestion: '同一检测中心/考场不会有两个相同的号：核对是否有一处被改错。',
    });
  }
  // ③ 百分比合计
  const pcts = collectPercents(text);
  if (new Set(pcts).size >= 2) {
    const sum = Math.round(pcts.reduce((a, b) => a + b, 0) * 100) / 100;
    if (Math.abs(sum - 100) > FACT_LOCK.percentTolerance) {
      pushFinding(out, {
        rule_id: 'deterministic:percent-sum',
        severity: 'medium',
        paragraph: null,
        excerpt: `本章出现的百分比：${[...new Set(pcts)].join(' / ')}`,
        message: `本章列出的百分比合计为 ${sum}%（应为 100%）`,
        suggestion: '等级概率是世界观事实，读者会拿计算器核对：'
          + '补齐缺的那一档，或改成"绝大多数 / 不到千分之一"这类不报精确数字的写法。',
      });
    }
  }
}

/**
 * 转场桥（能力 scene-bridge）。
 *
 * 判据的三次修正（2026-10-08 探针逐个抓出来；前两版都不可用）：
 *   · 第一版：段内有场景词 + 段内有切换动词 → 报"这座桥后面有外景"。
 *     问题：**正确稿也命中**——它只证明"桥与外景在同一章"，判据对真正的缺陷不敏感。
 *   · 第二版：要求外景**紧挨**着桥。问题：仍会命中正确稿（`镜头拉到场地外面。` 的下一段
 *     就是 `外面在下雪。`），因为"贴着桥的外景"本来就是正确写法。
 *   · 现在：把**触发句式**与**触发段落**合起来看 ——
 *     触发段落必须是"紧接在一段**画面/镜头描写**之后的外景段落"（即出问题的那一段），
 *     且它的上一段没有交代切换（交代了就有来源，不报）。
 *     这样：桥还在（上一段是"镜头拉到场地外面"）→ 不报；桥被删（上一段只剩"整个画面都白了"）
 *     → 报。**判据因此对"删没删桥"敏感**，而不只是对"有没有桥"敏感。
 *
 * ⚠️ 扫描器只看得见**一份**文本，严格说它判不出"这一版比上一版少了一座桥"——
 * 在删改那一刻拦截的是 public/patch-safety.js 的 sceneBridgeRisks（它手上同时有改前/改后）。
 * 这里报的是"外景段落看起来漏掉了来源交代"，给作者一个可核对的线索。
 */
function scanSceneBridge(paras, out) {
  let reported = 0;
  for (let i = 1; i < paras.length; i += 1) {
    if (reported >= TRANSITION.maxFindings) break;
    const p = paras[i];
    const exterior = EXTERIOR_MARKERS.find((m) => p.text.includes(m));
    if (!exterior) continue;
    // 外景段落必须短（是"交代一句外面在发生什么"的形态，不是一整段景物描写）。
    if (p.text.length > TRANSITION.exteriorMaxChars) continue;
    const prev = paras[i - 1];
    CAMERA_LANGUAGE_RE.lastIndex = 0;
    if (!CAMERA_LANGUAGE_RE.test(prev.text)) continue; // 上一段不是画面/镜头描写 → 与外景无关
    // 上一段自己交代了切换（`镜头拉到场地外面`）→ 来源还在，不报。
    TRANSITION.switchRe.lastIndex = 0;
    if (TRANSITION.switchRe.test(prev.text)) continue;
    reported += 1;
    pushFinding(out, {
      rule_id: 'deterministic:scene-bridge',
      severity: 'low',
      paragraph: p.index,
      excerpt: p.text,
      message: `第 ${p.index + 1} 段是「${exterior}」这类外景，上一段（第 ${p.index} 段）还在写画面/镜头，`
        + '但两段之间没有一句交代"镜头切到了哪里"',
      suggestion: '读者会突然不知道"我们现在看的是现场还是屏幕"。补一句来源交代（"镜头拉到场地外面""画面切回大厅"），'
        + '或把外景并进上一段的同一次镜头运动里。'
        + '（改稿时删掉这类转场句会被修稿安全门禁拦下，不会自动写进正文。）',
    });
  }
}

/**
 * 体系辨识度（能力 promise-identity）：等级展示密度 / 年份质感 / 金手指承诺差异。**只报告**。
 */
function scanPromiseIdentity(paras, out) {
  const text = paras.map((p) => p.text).join('\n');
  // ① 体系展示密度
  let showcases = 0;
  const samples = [];
  for (const re of PROMISE.showcasePatterns) {
    const found = text.match(re) || [];
    showcases += found.length;
    for (const f of found) if (samples.length < 6) samples.push(f.replace(/\s+/g, ' ').slice(0, 24));
  }
  if (showcases > PROMISE.showcaseLine) {
    pushFinding(out, {
      rule_id: 'deterministic:system-showcase-density',
      severity: 'low',
      paragraph: null,
      excerpt: samples.join('、'),
      message: `本章正面展示等级/能力结果约 ${showcases} 次（参考线 ≤${PROMISE.showcaseLine} 次）`,
      suggestion: '依次把每一个档位都正面展示一遍，会读起来像在跑等级表。'
        + '可考虑：只重点写与主角直接相关的那几个，其余压成一句背景（"半小时前还出过一个 B 级，至今仍有人谈论"）。'
        + '具体保留几个由作者判断，此判据不规定次数。',
    });
  }
  // ② 年份质感
  //    ⚠️ 两个自身缺陷（2026-10-08 探针抓到）：
  //      ① `3751年，全民觉醒日` 里的"年"后面是**全角逗号**，旧写法 `([0-9]{4})\s*年` 抓不到 →
  //         年份质感这条判据整条没生效；
  //      ② 判据收得太泛：`觉醒中心` 是这本书的**基础设定词**（不是未来质感），
  //         连"检测石"都算细节，于是判据永远不响。现在只认明确属于未来基础设施/制度的词。
  const yearMatch = text.match(PROMISE.farFutureRe);
  const year = yearMatch ? Number(yearMatch[1]) : 0;
  if (year >= PROMISE.farFutureThreshold) {
    const contemporary = [...new Set(text.match(PROMISE.contemporaryMarks) || [])];
    const futureDetail = text.match(PROMISE.futureDetailRe);
    if (contemporary.length >= 3 && !futureDetail) {
      pushFinding(out, {
        rule_id: 'deterministic:era-texture',
        severity: 'low',
        paragraph: null,
        excerpt: `${yearMatch[0]}｜当代符号：${contemporary.slice(0, 6).join('、')}`,
        message: `作品设定在 ${year} 年，而本章的时代细节与当代日常几乎完全一致（命中 ${contemporary.slice(0, 6).join('、')} 等 ${contemporary.length} 类，`
          + '没有一项与远未来相配的设定细节）',
        suggestion: '这不是"写错了"，而是"读者读不出年代"。两条都可选：'
          + '① 把年份改成近未来或"新纪元XX年"，让读者不产生未来预期；'
          + '② 只加两三处**会影响人物此刻行为**的细节（防护墙检修、能源优先供应、身份腕环识别），不必铺高科技名词。',
      });
    }
  }
  // ③ 金手指承诺
  const tail = paras.slice(-PROMISE.tailParagraphs).map((p) => p.text).join('\n');
  if (PROMISE.genericSystemRe.test(tail)) {
    pushFinding(out, {
      rule_id: 'deterministic:generic-hook-promise',
      severity: 'low',
      paragraph: paras.length ? paras[paras.length - 1].index : null,
      excerpt: tail.slice(-60),
      message: '章末的系统/外挂台词只给出了通用功能承诺（"符合绑定条件"这一级），看不出本书机制与别的系统文有什么不同',
      suggestion: '章末承诺是读者决定要不要点下一章的地方：让它至少回答一个问题——'
        + '本书的外挂**多给了什么**、或**发现了什么别处没有的东西**（"发现一项未登记天赋""公共检测结果存在错误"这一级）。'
        + '具体措辞由作者定，此判据只指出"承诺没有被差异化"。',
    });
  }
}


/**
 * 场景逻辑（确定性部分）：① 同一容器的物件方位是否自相矛盾；② 同一编号/道具是否被反复调出。
 * 这两条都出自作者对第三章的意见，且都**不需要语义理解**就能判定，所以放在确定性扫描里，
 * 而不是留给语义审稿（语义审稿会漂移、会漏、还依赖模型可用）。
 */
function scanSceneLogic(paras, out, ctx = {}) {
  const text = paras.map((p) => p.text).join('\n');
  // ① 同一物件的方位自相矛盾：**零误报**口径 —— 只认"物件名 + 方位词 + 容器（+ 层级词）"这种
  // 明确陈述，且必须**同一个物件**在章内被陈述到两个不同容器/层级。
  //
  // 三轮才收敛到这个判据（过程留痕，避免以后又往回改）：
  //   · 第一版按"容器出现处 ±10 字里有深度词"判 → 把动作句"再往里摸"读成方位陈述，**误报**；
  //   · 第二版按句级"容器 + 深度词 vs 在…里"判 → 对本章**静默漏报**（"主袋里是卷子错题本"是存在式，
  //     而物件那一侧压根没被陈述）；
  //   · 现版把主语钉在**物件**上：`<物件>(?:还|仍|就)?在<容器>(?:里|中|内)?<层级?>`
  //     —— 同一个物件落在两个不同层级/容器才算矛盾。
  //
  // 能力边界（诚实记录）：像本章这样"物件被陈述在 A 层，而物品清单显示 A 层装着别的具体东西"
  // 的**跨句空间推断**，纯文本判据做不可靠 —— 那部分交给 scene-logic 这条**能力文本**
  //（进模型提示词，由模型读蓝图/正文时核对），确定性扫描不假装能做。
  // 这样分工的收益：确定性这一半零误报（可以放心常开），难的那一半有明确归属。
  // ⚠️ 层级词必须排在"里/中/内"**前面**且都参与匹配：写成 `(?:里|中|内)?(层级)?` 时，
  // 正则会把「书包夹层里」的"层"留给层级、把"里"留给尾缀吗？不会——"夹层"本身以"层"结尾，
  // 回溯会让 `(?:里|中|内)?` 先吃掉"里"，层级组于是永远抓不到（实测：「剑在书包夹层里」
  // 被记成"一般层"，判据成了死规则）。正确顺序：层级词 → 可选尾缀。
  // ⚠️ 物件名必须写成 `[^…]{1,8}?`（"不是标点/空白的 1–8 字"），**不能**写成
  // `[\u4e00-\u9fa5]{1,8}?`：方括号里的 `\u4e00-\u9fa5` 是**否定式**（等价于 [^\u4e00-\u9fa5]），
  // 于是它匹配的是"不是汉字的东西"——判据会对中文句子整体失配，成为一条**永远不响的死规则**
  // （2026-10-02 实测：正例输入下没有任何 finding，就是这个字类写错导致的）。
  // ⚠️ 用"两个分支各自完整"的正则，**不要**写成 `…(层级)?(?:里|中|内)?`：
  // 层级以"层/面/侧"等字结尾、尾缀是"里/中/内"，两条可选组会互相吃掉对方要的字。
  // 实测形状：「剑在书包夹层里」被记成"一般层"（层级组永远抓不到）→ 判据成了死规则。
  // 分支 A：容器后紧跟**可判层级**的词（夹层/内侧/底层/最深/更深/里面一点/最里面）
  // 分支 B：容器后是"里/中/内"这类**一般层**尾缀
  const PLACE_DEEP = /([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(夹层|内侧|底层|最深|更深|里面一点|最里面)(?:里|中|内)?/g;
  const PLACE_PLAIN = /([^，。！？、\s]{1,8}?)(?:还|仍|就)?在(书包|背包|包|口袋|兜|抽屉|鞋柜|柜子|箱子|主袋|侧袋)(?:里|中|内)/g;
  // 句子里出现"更…"这类深度提示、却没被上面两条捕获时（例如"往书包更深的地方探"，
  // 层级在"的地方"里、判不出来）：**整句跳过**。宁可不报，也不把"更深"记成"一般层"
  // —— 记错方向会让判据产出假矛盾（第一版就是被"再往里摸"这种动作句坑的）。
  const DEPTH_HINT = /(更深|更深的地方|再往里|往里面|最里面|里侧)/;
  // 物件名过滤：**不能**用"长度 ≥2"来挡（单字物件正是最常见的一类：剑/笔/伞/钱/钥匙…，
  // 一刀切会把它们全部漏掉，判据对"剑"永远不响）。改用黑名单 + 前置词白名单式的排除：
  //   · 代词/连词/方位词/量词不是物件；
  //   · 抓到的片段若以把/被/给/对/向/往/从 开头，那是处置式/介词结构的尾巴，不是物件名。
  const NOT_OBJECT = /^(他|她|它|我|你|咱|这|那|其|谁|的东西|东西|时候|地方|里面|前面|后面|上面|下面|旁边|中间|一个|两个|并且|但是|因为|所以|然后|于是|只是|就是|还是|或者|如果|不是|没有|所有|一切|什么|怎么|这样|那样)$/;
  const byObject = new Map();
  const record = (obj, container, level) => {
    const e = byObject.get(obj) || { obj, places: new Map() };
    const key = `${container}/${level}`;
    e.places.set(key, (e.places.get(key) || 0) + 1);
    byObject.set(obj, e);
  };
  const usableObject = (obj) => Boolean(obj)
    && !NOT_OBJECT.test(obj)
    && !/^[把被给对向往从和与及并且但而]/.test(obj);
  for (const p of paras) {
    for (const s of splitSentencesLocal(p.text)) {
      const seen = new Set();
      for (const m of s.matchAll(PLACE_DEEP)) {
        if (seen.has(m[1]) || !usableObject(m[1])) continue;
        seen.add(m[1]);
        record(m[1], m[2], m[3]);
      }
      for (const m of s.matchAll(PLACE_PLAIN)) {
        if (seen.has(m[1]) || !usableObject(m[1])) continue;
        if (DEPTH_HINT.test(s)) continue;   // 层级判不出来的句子不参与（见上）
        seen.add(m[1]);
        record(m[1], m[2], '一般层');
      }
    }
  }
  for (const e of byObject.values()) {
    const levels = new Set([...e.places.keys()].map((k) => k.split('/')[1]));
    const containers = new Set([...e.places.keys()].map((k) => k.split('/')[0]));
    const conflicting = levels.size > 1 || containers.size > 1;
    if (!conflicting || e.places.size < 2) continue;
    pushFinding(out, {
      rule_id: 'deterministic:object-placement-conflict',
      severity: 'medium',
      paragraph: null,
      excerpt: `「${e.obj}」：${[...e.places.keys()].join(' / ')}`,
      message: `「${e.obj}」在本章被陈述在两个不同方位/层级（${[...e.places.keys()].join('、')}），读者无法确定它到底在哪一层`,
      suggestion: '选一种并全章一致：要么它本来就在那一层，要么明确写一处夹层，后文一律按这个位置说。',
    });
  }

  // ② 编号/道具被反复调出（0731 这类）：首次写足，之后只保留关键连接。
  const recalls = numericRecallTokens(paras);
  if (recalls.length) {
    pushFinding(out, {
      rule_id: 'deterministic:detail-recall',
      severity: 'low',
      paragraph: null,
      excerpt: recalls.map((c) => `${c.token}（${c.paragraphs} 段）`).join('、'),
      message: `同一个编号/道具在 ${recalls[0].paragraphs} 段里被再次调出（${recalls.map((c) => c.token).join('、')}）`,
      suggestion: '首次出现可以写足（钢笔、笔画、毛边都可以写）；之后每次回想只保留**关键连接**'
        + '（"和短信前面那四个一样"就够了），不必把外观再描述一遍——否则读起来像每个前文细节都要被再次使用。',
    });
  }
}

/**
 * 确定性扫描入口。
 * @param {string} text 章节正文（纯文本）
 * @param {{abilities?:string[], genre?:string, task?:string, characters?:object[], foreshadows?:object[]}} opts
 *   abilities 为**已启用**的能力 id 列表（未启用 = 不产生对应 finding）。
 * @returns {{findings:object[], scanned:object, skipped:object[]}}
 */
export function scanEditing(text, opts = {}) {
  const abilities = Array.isArray(opts.abilities) ? opts.abilities : [];
  const has = (id) => abilities.includes(id);
  const paras = paragraphsOf(text);
  const findings = [];
  const skipped = [];
  const noteSkip = (id, reason) => skipped.push({ id, reason });

  scanRepeats(paras, findings); // 重复与档位无关：误粘贴在任何档位都该被指出
  // 第四批（2026-10-08）：跨段整句重复。同样与档位/能力无关——"这一版里有句子被复制过"
  // 是一个事实，任何一种润色档位都不该把它留在成稿里（作者复核稿里的真实事故：
  // 「岳宸炎把手从石板上拿开。」相邻两段各出现一次；相邻窗口 2 段的 scanRepeats 抓不到它，
  // 因为它要求**整段**逐字相同，而这里只重复了一句）。
  scanDuplicateSentences(paras, findings);
  if (has('fiction-humanizer')) scanHumanizer(paras, findings); else noteSkip('fiction-humanizer', 'disabled');
  // 「叙述者在场」两类（过程交代 / 叙述者越界）：独立能力，默认关闭。
  // 与 humanizer 的分工：humanizer 管**用词**（仿佛/似乎/淡淡的这一级），这条管**叙述越界**
  //（谁在说话、他站在人物里面还是外面）——后者不是词表能测的，只能靠逐处定位 + 整章密度。
  if (has('narrative-distance')) scanNarrativeDistance(paras, findings); else noteSkip('narrative-distance', 'disabled');
  // 「场景逻辑」：物件位置在章内是否自洽、细节是否被反复调出（2026-10-02 作者意见第三、四类）。
  if (has('scene-logic')) scanSceneLogic(paras, findings, opts); else noteSkip('scene-logic', 'disabled');
  if (has('dialogue-editor')) scanDialogue(paras, findings); else noteSkip('dialogue-editor', 'disabled');
  if (has('webnovel-pacing')) scanPacing(paras, findings); else noteSkip('webnovel-pacing', 'disabled');
  if (has('character-voice')) scanCharacterVoice(paras, findings, opts); else noteSkip('character-voice', 'disabled');
  if (has('chapter-hook')) scanChapterHook(paras, findings); else noteSkip('chapter-hook', 'disabled');
  if (has('mystery-review')) scanMystery(paras, findings, opts); else noteSkip('mystery-review', 'disabled');
  if (has('romance-review')) scanRomance(paras, findings); else noteSkip('romance-review', 'disabled');
  // R10：结构密度（分布判据）。默认关闭；开启后只产出线索与测量值，不进入生成请求、不改正文。
  let density = null;
  if (has('style-density')) density = scanStyleDensity(paras, findings, opts); else noteSkip('style-density', 'disabled');
  // 第四批（2026-10-08）：三条默认关闭的诊断能力。都只报告，不返回"应当改成什么"。
  if (has('number-lock')) scanNumberLock(paras, findings, opts); else noteSkip('number-lock', 'disabled');
  if (has('scene-bridge')) scanSceneBridge(paras, findings); else noteSkip('scene-bridge', 'disabled');
  if (has('promise-identity')) scanPromiseIdentity(paras, findings); else noteSkip('promise-identity', 'disabled');
  // 第五批（2026-10-08）：叙事结构机械感（S1 重复机制 / S2 时间轴过密 / S3 群众反应功能重复 /
  // S5 主角摄像机化）。默认关闭；无论开关如何，测量值都进 scanned.style_shape。
  if (has('story-shape')) scanStoryShape(paras, findings, opts); else noteSkip('story-shape', 'disabled');

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || ((a.paragraph ?? -1) - (b.paragraph ?? -1)));
  return {
    findings,
    skipped,
    scanned: {
      paragraphs: paras.length,
      chars: String(text || '').length,
      abilities: [...abilities],
      genre: String(opts.genre || 'general'),
      task: String(opts.task || 'review'),
      // 明确口径：计数来自确定性规则；语义判断不在这里，见 novel_review 语义审稿。
      deterministic: true,
      // 第四批测量值（**不管开关**都算）：这三个数是描述性的，界面可以直接显示
      // "本章等级正面展示 N 次 / 是否有远未来年份 / 章末承诺是否通用"，
      // 开关只控制**要不要产出 finding**（与 style-density 的 callback_tokens 同一套做法）。
      promise: {
        system_showcase_count: (() => {
          const t = text;
          let n = 0;
          for (const re of PROMISE.showcasePatterns) n += (t.match(re) || []).length;
          return n;
        })(),
        year: (() => { const m = text.match(PROMISE.farFutureRe); return m ? Number(m[1]) : null; })(),
      },
      // 结构密度测量值（仅当 style-density 能力启用时存在）：原样报告给作者，不驱动改写。
      ...(density ? { density } : {}),
      // 第五批（2026-10-08）：叙事结构测量值 —— **与能力开关无关**（与 promise 同一套做法）。
      // 能力开关只决定要不要产出 finding；"本章有几个时间锚点、有没有同形流程簇"是描述性事实，
      // 界面随时可以显示，也便于把"改了系统还是只改了某一章"变成可对比的数字。
      style_shape: storyShapeMeasures(text, opts),
    },
  };
}

/**
 * 内部件的离线复算出口（供探针脚本单独验证判据，不必跑整套 scanEditing）。
 *
 * 为什么要把内部函数导出来：扫描器只反映"装配后的结果"，而判据本身（时间锚点口径、
 * 流程形状分组、量程阈值）需要能在**固定输入**上逐条断言——否则调参时只能看整体输出变没变，
 * 无法确认"到底哪一条被改了"。第四批的探针也是这个路子（见 probe-fact-lock-20261008.mjs）。
 * ⚠️ 这些是内部实现，不是对外契约：只有本模块的探针脚本应当 import 它们。
 */
export const __internals = {
  STORY_SHAPE,
  DENSITY,
  timelineAnchorsOf,
  processShapeOf,
  storyShapeMeasures,
  scanStoryShape,
};
