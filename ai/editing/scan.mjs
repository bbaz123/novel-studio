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
      // 结构密度测量值（仅当 style-density 能力启用时存在）：原样报告给作者，不驱动改写。
      ...(density ? { density } : {}),
    },
  };
}
