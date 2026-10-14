/*
 * 修稿安全门禁（Safe Editing / 第三批）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要它：审稿诊断层已经能发现"信息饱和 / 功能重复"，但**补丁无论删什么都不检查**。
 * 于是修稿器会把后文赖以成立的结构桥删掉：王磊递面包的动作被删 → 面包凭空出现；
 * 首次人物主体被删 → "她"没有先行语；"大屏切到海澜市"被删 → 读者不知道在看现场还是屏幕；
 * 为一个轻度时间疑问顺手新增整套 B 区支线。这类改动**每一处单看都"更简洁"**，
 * 合起来却把原本成立的小说修坏——门禁要拦的就是它们。
 *
 * 三条纪律（写在常量上，可离线复核）：
 *   ① 零误报优先：判据只认**能被逐字指出来的证据**（后文真的有回指式使用、代词真的没有先行语、
 *      场景词真的消失且后文真的依赖它）。证据不成立就放行——宁可漏拦，不可误拦。
 *   ② 未命中不表态：本模块不产出"这里应该改"，只产出"这条改动不能自动应用 + 为什么"。
 *   ③ 逐条粒度：命中的那一条不进差异稿并单列原因，同一批其余补丁照旧应用
 *      （文档 §17 要求同时满足"能压缩李拓多余 A 级光效"和"绝不删除王磊递面包"）。
 *
 * 它与 applyRevisionPatches 的分工：
 *   · applyRevisionPatches 回答"这条补丁**能不能定位**"（唯一命中 / 包含退让 / 重叠）；
 *   · 本模块回答"这条补丁**该不该自动应用**"（删掉的东西是不是后文的结构桥）。
 * 两者都在**逐字匹配**上做文章，都不调用模型、不产生费用、同一输入同一输出。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelPatchSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.1.0';

  /** 改动粒度（文档 §9）：只有 story_fact 会被拦，local_structure 过门禁后照常应用。 */
  const SCOPE = { WORDING: 'wording', LOCAL_STRUCTURE: 'local_structure', STORY_FACT: 'story_fact' };

  /** 门禁结论码。`object_provenance / reference_anchor / scene_anchor / story_fact / protected_content /
   *  fact_lock_conflict` 是**硬拦**；`causal_bridge_break / cross_paragraph_duplicate / percent_sum_mismatch`
   *  只报告（前者的"因为"太常见；后两者的判据与补丁本身无关，属于"这一版整体"的问题）。 */
  const HARD_CODES = ['protected_content', 'story_fact', 'object_provenance', 'reference_anchor', 'scene_anchor', 'fact_lock_conflict'];
  const REASON_TEXT = {
    protected_content: '命中作者指定的保护句',
    story_fact: '引入了本章尚未出现的正式事实',
    object_provenance: '删掉了后文仍在使用的物件来源',
    reference_anchor: '删掉了后文代词的先行语',
    scene_anchor: '删掉了场景/视点锚点',
    causal_bridge_break: '删掉了后文仍在承接的原因',
    // 2026-10-08（第四批 · 本文件 v1.1.0）：
    fact_lock_conflict: '与本章中同一数值既有陈述矛盾（不可变信息锁）',
    cross_paragraph_duplicate: '同一句在多个段落里逐字重复',
    percent_sum_mismatch: '百分比合计不为 100%',
    safety_unavailable: '安全门禁不可用（本次未拦截任何补丁）',
    // 2026-10-10（《修复.md》E03 · A01）：
    information_truncation: '删掉引导语后的具体内容，改后只剩一个孤立的栏目名/引导语',
  };

  // ── 词表（集中定义：判据与"为什么"文案共用同一份口径，避免两处漂移） ──────────────

  /** 功能字：n-gram 会切出"了一""他把"这类跨词碎片。意象/物件的首尾字都不该是功能字。 */
  const FUNC_CHARS = new Set('的了把是在有就也都和与被给着过这那他她它一个上下里外来去时候你我它们很再又还只才更最没不么呢吗啊呀然后因所以如果虽但而且以'.split(''));

  /** 以动词收尾的 n-gram 多半是跨词碎片（"抬头看"切出的"头看"），不作为物件候选。 */
  const VERB_TAIL = new Set('看说道想听走笑问答站坐瞧望盯喊叫给递'.split(''));

  /** 抽象/泛用词：它们在后文里天然会带"这/那"，若不排除会误判成"物件来源断裂"。 */
  const STOP_TOKENS = new Set([
    '什么', '怎么', '这样', '那样', '一样', '有点', '一点', '一下', '一句', '一眼', '一声', '一些', '一起',
    '已经', '可以', '不能', '不要', '不是', '就是', '还是', '可是', '但是', '然后', '因为', '所以', '如果',
    '只有', '只是', '而且', '并且', '于是', '突然', '忽然', '慢慢', '轻轻', '缓缓', '时候', '地方', '东西',
    '事情', '问题', '感觉', '意思', '办法', '样子', '结果', '原因', '心里', '身上', '眼里', '脸上', '声音',
    '表情', '动作', '眼神', '语气', '气氛', '情绪', '状态', '情况', '方向', '位置', '机会', '力气', '精神',
  ]);

  /** 人称代词：出现且"此前没有任何人称锚点"时，说明它的先行语被删掉了。 */
  const PRONOUNS = ['他们', '她们', '它们', '我们', '你们', '他', '她', '它'];
  const PRONOUN_RE = /他们|她们|它们|我们|你们|他|她|它/;

  /** 主体名词（"一个女生""那个少年"这一类）：它们常扮演代词先行语，被删即指代断裂。 */
  const SUBJECT_NOUNS = [
    '女生', '男生', '女孩', '男孩', '少女', '少年', '女人', '男人', '老人', '老太太', '中年人', '青年',
    '孩子', '同学', '老师', '医生', '护士', '司机', '店员', '保安', '警察', '母亲', '父亲',
    '哥哥', '姐姐', '弟弟', '妹妹', '大爷', '大妈', '教官', '主播', '主持人', '记者', '考生', '学员',
  ];

  /** 场景/视点来源词（文档 §5 scene_anchor）：删掉它们，读者无法判断当前是现场还是屏幕/转播。 */
  const SCENE_MARKERS = ['大屏', '屏幕', '画面', '镜头', '直播', '转播', '切到', '切回', '远景', '近景', '特写', '监视器', '投影', '电视'];

  // ── 2026-10-08（第四批 · v1.1.0）新增词表 ────────────────────────────────────
  // 起因（作者复核稿，全部是**这一章真实发生的事故**，不是假想）：
  //   ① 1738 被单点改成 1736 → 与「1736号，王磊」撞号、还与播报 1720 冲突；
  //   ② 「岳宸炎把手从石板上拿开。」整句重复了两次；
  //   ③ 删掉「画面切回江陵本地的队伍」→ 下一段「外面在下雪」失去观察视角；
  //   ④ D级 95% + C级 万分之一 + B级 十万分之一，合计不到 100%。
  // 四项判据都遵守文件头三条纪律：零误报优先、未命中不表态、逐条粒度。

  /**
   * 「只在这个场景里成立」的外部标记：下雪 / 街头 / 广场 / 车顶 ……
   * 用途（scene_bridge）：当一条补丁把**唯一的场景来源句**删掉，而紧接着的段落直接写这些
   * 只可能来自外景的东西时，读者会突然失去"我们现在在看哪儿"的来源。
   *
   * ⚠️ 刻意**不**包含「外面」「远处」「下」这类太通用的方位词/单字：单独的"外面"误报率过高，
   * 而单字"下"会被"大屏切到**下**一场"这种正常句子命中（探针 2026-10-08 抓到：
   * 判据在"没有外景"的负例上仍然响了）。判据宁可不响——作者复核稿点名的正是
   * "外面在**下雪**"这一种有具体景物的形态。
   */
  const EXTERIOR_MARKERS = ['下雪', '雪落', '雪花', '雨点', '暴雨', '广场', '街头', '街上', '马路', '车顶', '屋顶', '天空', '夜空', '天色', '风吹', '风声'];

  /** 编号/数值的**明确后缀**：只有这些形态才被当作"可锁定的编号事实"。 */
  const ID_SUFFIX = '号|编号|排号|座号|学号|考号|号码|班级|年级|届|楼层|层|房间|室|岁|年';
  /** 实体名与数字之间允许出现的词（"岳宸炎的排号纸是1736"里的"的排号纸是"）。 */
  const LINK_WORDS = '的|排号纸|排号单|号码纸|编号|成绩单|结果单|纸|是|为|：|:|，|,|、|地|场|上|里|中';
  /**
   * 多字连接词（"排号纸""成绩单""编号"…）：这些是**词**，用子串删除。
   * 单字虚词（的/是/他/她/那/张/个/把/里/中/和/与/及/在/看/说/后/前/上面/下面/里面…）
   * **不能**用子串删除 —— "上"会吃掉"上午"、"看"会吃掉"看守"里的字，
   * 实测把"岳宸炎的排号纸是"剥成过"岳宸"这种半截名字（探针 2026-10-08 抓到）。
   * 单字一律走字符类替换（一次性、按集合剥），不做逐词 split。
   */
  const LABEL_MULTI_STOPWORDS = ['排号纸', '排号单', '号码纸', '成绩单', '结果单', '编号', '号码', '数字', '上面', '下面', '里面', '前面', '后面', '旁边', '中间', '时候', '地方', '东西'];
  /** 单字虚词：只在两侧（开头/结尾）剥，不剥中间的实体名。
   *  注意**不含**"上/下"——剥"上面/下面"已经覆盖了方位用法，而"上"作为单字会误吃常用名。 */
  const LABEL_EDGE_CHARS = new Set('的了是把在就也都和与被给着过这那他她它我你其张个份只把为地场里中后前看说'.split(''));

  /** 还原实体名候选：去掉连接词后剩下的汉字串（首尾的单字虚词剥掉，中间保留）。 */
  function labelFromWindow(before) {
    let s = String(before || '');
    for (const w of LABEL_MULTI_STOPWORDS) s = s.split(w).join('');
    s = s.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let guard = 0; guard < 12 && s.length > 1 && LABEL_EDGE_CHARS.has(s[0]); guard += 1) s = s.slice(1);
    for (let guard = 0; guard < 12 && s.length > 1 && LABEL_EDGE_CHARS.has(s[s.length - 1]); guard += 1) s = s.slice(0, -1);
    return s;
  }

  /**
   * 窗口里有没有"登记主体"（人物卡名字，或同学/女生/男生这类主体名词）？
   *
   * 用途：只有窗口里出现过主体时，剥出来的实体名候选才可信。
   * 反例（探针 2026-10-08）：「广播**叫到**1736号」剥出的是动词碎片"叫到"——
   * 把它当成实体名会产出假矛盾（两条不同措辞的同号陈述会被读成"两个实体"）。
   * 判据宁可不响：窗口里没有主体 → 这条数字不入账。
   */
  const SUBJECT_NOUN_HINT = /(同学|学生|女生|男生|女孩|男孩|少女|少年|老师|教官|考生|学员|选手|队员|家长|记者|主持人|主播|工作人员)/;
  function hasSubject(windowText, names) {
    if (SUBJECT_NOUN_HINT.test(windowText)) return true;
    return (names || []).some((n) => n && windowText.includes(n));
  }

  /**
   * 离这个数字**最近**的人物卡名字（同一段内搜索）。
   *
   * 为什么要"最近"而不是"最长/最先出现"（探针 2026-10-08 抓到的第三个自身缺陷）：
   *   「岳宸炎站在队伍中间……攥着那张排号纸。」+「广播叫到1736号，王磊走上检测台。」
   *   里 1736 的主人明明是王磊，按"名字最长"会挑到岳宸炎，于是**正确稿被报成假矛盾**——
   *   而这是 HARD_CODES（硬拦），一次误报就够让作者不信任整个门禁。
   */
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

  /** 中文数字 → 阿拉伯数字（只覆盖百分比判据会遇到的形态）。 */
  const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };
  /** 百分比表达：`95%` / `95％` / `百分之九十五`。
   * ⚠️ 两个自身缺陷（2026-10-08 探针抓到，都已修）：
   *   ① 旧写法的第一分支 `[0-9]{1,3}(?:\.[0-9]{1,3})?` 在 `0.0001%` 上会**从"0001%"起匹配**，
   *      把 0.0001 读成 1（正确稿于是被算成 199.99% → 误报）；
   *   ② `百分之九十五` 这种**裸中文数字**（不带"百分之"前缀）没被认出来，
   *      而作者这一章写的正是"D级，出现概率百分之九十五"。 */
  /** 百分比表达：`95%` / `95％`。中文数字单独一遍处理（见 collectPercents 的四层口径）。
   *
   * ⚠️ 2026-10-12（0731 增补方案 T44/T45）修掉的两个边界缺陷：
   *   ① 整数部分只允许 1–2 位 → `100%` 从数字**内部**起匹配出 `00%`（值 0 被 `v > 0` 丢弃，
   *      于是 100 整个消失），`100.00%` 同样匹配不到。现在放宽到 1–3 位。
   *   ② 没有**左边界**约束 → `123%` 会截出尾部 `23%`，把非法占比伪装成一个合法的 23%，
   *      再被卷进"合计应为 100%"的加总。现在要求数字前面不是数字/小数点。
   * 两条都是"错在抽取"，不是"错在判据"：抽取一旦截错，后面的加总再准也没有意义。 */
  const PERCENT_RE = /(?<![\d.])([0-9]{1,3}(?:\.[0-9]{1,4})?)\s*[%％]/g;
  /** 中文数字串（含"百分之"前缀）：逐位数字显式判定，避免 `(?:百分之)?` 把"分之一"的尾巴吃进来。 */
  const CN_NUM_RE = /百分之[零一二两三四五六七八九十百]{1,5}|[零一二两三四五六七八九十百]{1,5}/g;
  /**
   * 稀有度词（`万分之一` 这一级）：它不是百分比写法，但**恰恰是在陈述概率**。
   * 判据里把它换算成百分比值参与合计（万分之一 = 0.01%），否则作者这一章
   * "D级 95% + C级 万分之一 + B级 十万分之一"会算成 95%，永远看不出不到 100%。
   */
  const RARITY_FORMS = /(百万分之一|十万分之一|万分之一|千分之一|百分之一)/g;
  const RARITY_VALUE = { 百万分之一: 0.0001, 十万分之一: 0.001, 万分之一: 0.01, 千分之一: 0.1, 百分之一: 1 };
  /** 裸中文数字（不带"百分之"）只有在**概率语境**里才算百分比：否则"倒了一勺铁水"的"一"会被算进去。
   *
   * ⚠️ 2026-10-12（0731 增补方案 T38）删掉了旧词表里的 `分之`：
   *   它的本意是覆盖"概率九十五分之…"这类写法，但它是个**任意两字子串**，
   *   于是 `江陵这种地方一年能出一个吗` 里的"一"前面隔着 16 字的窗口里只要有
   *   "部分/分之"这类字就被判成概率语境 —— 实测该句因此收出 `[1, 0.0001]`，
   *   再被加总成"合计 1.0001%，应为 100%"（对一个**根本没在说等级分布**的句子误报）。
   *   概率语境只保留真正的概率词：稀有度词本身由 RARITY_FORMS 那一层负责，不需要"分之"兜底。 */
  const PROBABILITY_CONTEXT_RE = /(概率|几率|占比|出现率|觉醒率|约|大约|将近|不足|不到|超过|以上|以下)/;
  const ctxHasProbability = (s) => PROBABILITY_CONTEXT_RE.test(String(s || ''));

  /**
   * 收集本章所有"概率陈述"的数值（百分比与稀有度词都算）。
   *
   * ⚠️ 为什么要单独一个函数、还导出：这条判据有三层口径（`%` 写法 / `百分之X` / `X分之一`），
   * 每一层都可能静默失效——只从 `scanFactLock` 的 output 看，会分不清"合计对"与"根本没收到数"
   * （2026-10-08 探针就是这样连吃两次亏：一次是 `0.0001%` 被读成 1%，一次是裸中文数字没进来）。
   * 单独导出后，离线测试可以直接断言"这段话收出了哪些数"。
   *
   * ⚠️ 2026-10-12（0731 增补方案 §3 / T38 / T39 / T45）第三次修正 —— 这次改的是**口径**：
   *   旧实现把"抽取到的数"直接当成"一组分类概率"，于是任何两个不同数值都会被拿去加总，
   *   再判"应为 100%"。但"等级分布加起来 100%"只对**完整、互斥、同一口径**的一组分类概率成立：
   *     · `百万分之一啊。那你说，江陵这种地方一年能出一个吗？`
   *       里没有"一年"这个**概率**——它是口语里的时间量词，却被 `1` 加权进合计（T38 误报）；
   *     · `A级百万分之一` 连说三遍是**同一个**等级的同一份稀有度，不是三种分类概率（T39 重复累计）；
   *     · 缺档的部分数据（只报 D/C/B）根本无"合计"可言，报"应为 100%"是拿作者没写的东西问罪。
   *   因此口径改成：**只把"绑定到某个等级 / 或显式概率语境"的数当候选，并按等级去重**。
   *   去重与同口径筛选都在这一层做，`scanFactLock` 只负责对**已归一的**候选判合计。
   */
  function collectPercents(text) {
    return collectPercentClaims(text).map((c) => c.value);
  }

  /** 百分比数值 > 100 不是占比（`123%`）：既不参与合计，也不当作合法值。
   *  注意**零概率是合法的**（`0%` 表示"该等级不存在"），所以下界是 `>= 0` 而不是 `> 0`——
   *  旧实现的 `v > 0` 会把 `0%` 整条丢掉，等于让一个合法的分类项缺席（T45）。 */
  const isValidPercentValue = (v) => Number.isFinite(v) && v >= 0 && v <= 100;

  /**
   * 概率陈述的**候选**（带等级与来源）：抽取与证据位置，不是无条件的世界观合计。
   *
   * 口径（三层，全部显式判定）：
   *   ① `95%` / `95％`：出现即算（`%` 本身就是概率标记，不需要额外语境）；
   *   ② `百分之九十五`：前缀即概率标记；
   *   ③ 裸中文数字：**必须**落在显式概率语境里，否则"倒了一勺铁水"的"一"会被算成 1%；
   *   ④ 稀有度词（`万分之一`）：它本身就是概率陈述，但**同样要过概率语境**——
   *      "十万分之一"出现在别处的比喻里时不应污染等级分布。
   *
   * @returns {Array<{value:number, grade:string|null, source:string}>}
   */
  function collectPercentClaims(text) {
    const base = String(text == null ? '' : text);
    const claims = [];
    const push = (value, grade, source) => {
      if (!isValidPercentValue(value)) return;
      claims.push({ value, grade, source });
    };

    // ① `95%` / `95％`：数值本身即概率。
    for (const m of base.matchAll(PERCENT_RE)) {
      push(Number(m[1]), gradeBefore(base, m.index), 'percent');
    }

    // ②/③ 中文数字：带"百分之"前缀即概率；裸数字必须在概率语境里，且不能落在"X分之一"结构内。
    for (const m of base.matchAll(CN_NUM_RE)) {
      const raw = m[0];
      const tail = base.slice(m.index + raw.length, m.index + raw.length + 3);
      const before2 = base.slice(Math.max(0, m.index - 3), m.index);
      // 落在"X分之一"结构里的中文数字由 ④ 的稀有度词表负责，这里必须排除。
      // ⚠️ 光判"后面跟不跟分之"不够（2026-10-08 探针抓到的第四个自身缺陷）：
      //   「十万分之一」里的"十"单独被 CN_NUM_RE 匹配到，后面跟的是"万分"而不是"分之"，
      //   于是被当成 10% 计进合计（作者这一章因此被算成 105.01% 而不是 95.01%）。
      //   两个方向都要判：数字后面是 分之/万分/千分，或数字前面是 分之。
      const inFraction = /^(分之|万分|千分)/.test(tail) || /分之$/.test(before2);
      if (inFraction) continue;
      if (!raw.startsWith('百分之')) {
        if (!ctxHasProbability(base.slice(Math.max(0, m.index - 16), m.index))) continue;
      }
      push(cnNumber(raw.startsWith('百分之') ? raw.slice(3) : raw), gradeBefore(base, m.index), 'cn');
    }

    // ④ 稀有度词（`万分之一` / `十万分之一`）：换算成百分比值参与合计。
    //    ⚠️ 这一层**不做**概率语境检查（2026-10-12 实测的回归）：`万分之一` 本身就是概率陈述，
    //    而 `D级，出现概率百分之九十五。C级，万分之一。B级，十万分之一。` 里，
    //    紧跟 `十万分之一` 之前的是 `万分之一。B级，` —— 回看窗口没有任何概率词，
    //    于是真正的那一档 `0.001` 被语境闸门整个丢掉，合计从 95.01% 变成 95%，
    //    恰好**掩盖**了原文那一处真实缺陷。语境闸门只针对**有歧义的**裸中文数字（③），
    //    对显式的 `%` 与显式的 `X分之一` 都不需要——它们不会在普通叙述里被误认成占比。
    for (const m of base.matchAll(RARITY_FORMS)) {
      push(RARITY_VALUE[m[1]], gradeBefore(base, m.index), 'rarity');
    }

    return dedupePercentClaims(claims);
  }

  /**
   * 取这个数值**前面最近**的一个等级标记（`A级` / `D级，` / `S级`）。
   *
   * ⚠️ 必须是"最近"（窗口内**最后一个**），不能是"窗口内第一个"——这是本文件第三次踩同一类坑：
   *   `D级 95%，C级 4.9%，B级 0.09%，A级 0.0099%，S级 0.0001%。` 一句里有五个等级，
   *   取第一个会把五个数值**全部**标成 `D`（2026-10-12 实测正是如此），
   *   于是"五档齐全"永远判不出来，判据被静默关掉。这与 nearestName 取"最近名字"是同一条纪律。
   */
  function gradeBefore(base, index) {
    const win = base.slice(Math.max(0, index - GRADE_LOOKBACK), index);
    let grade = null;
    const re = new RegExp(GRADE_LABEL_RE.source, 'g');
    for (const m of win.matchAll(re)) grade = m[1];
    return grade;
  }
  const GRADE_LABEL_RE = /(SSS|SS|S|A|B|C|D|E|F|[一二三四五六七八九十])\s*级/;
  /** 等级前缀的回看窗口（字符）：`D级，出现概率百分之九十五。` 这类句式需要跨过中间描述。 */
  const GRADE_LOOKBACK = 96;

  /** 判"等级分布是否构成完整口径"时认的等级全集（世界观主线用 D→S）。 */
  const CANONICAL_GRADES = ['D', 'C', 'B', 'A', 'S'];
  /** 显式声明"这是一整套分布"的说法：出现它们才认为作者在给分类概率表。
   *  ⚠️ `从D念到S` 这类要单独放一条可选的"级"——写成 `从…级?念到…` 时，
   *  前半段的 `[^。！？]{0,6}` 会把 `D念到` 整段吃掉，于是永远匹配不上（实测踩过）。 */
  const COMPLETE_DISTRIBUTION_RE = /(各等级|所有等级|全部等级|等级分布|概率分布|完整概率|完整分布|从[^。！？\n]{0,8}念到[^。！？\n]{0,8})/;

  /**
   * 这一章是否**有资格**做"百分比合计必须为 100%"的判定（0731 增补方案 §3）。
   *
   * 契约（很重要，这条把"误报"从判据里摘掉）：
   *   "等级分布是否加起来 100%"只对**完整、互斥、同一口径**的一组分类概率成立。
   *   作者只写 `D级95% + C级万分之一 + B级十万分之一` 时，A/S 两档**没写** ——
   *   报"合计 95.01%，应为 100%"就是拿作者没写的东西问罪（实测会把 D/C/B 三档的真实分级
   *   说成"漏了 4.99%"）。所以要满足下面任一条才判定：
   *     · 五个主线等级（D/C/B/A/S）**都**拿到带等级的概率；
   *     · 正文里出现显式声明（"各等级/所有等级/等级分布/从D念到S…"）。
   *   否则返回 `null` —— 调用方不得拿它当"合计正确"，而要如实说明"分布不完整"。
   *
   * @returns {{grades:string[], missing:string[], declared:boolean}|null}
   */
  function distributionEvidence(claims, base) {
    const grades = [...new Set(claims.map((c) => c.grade).filter(Boolean))];
    const declared = COMPLETE_DISTRIBUTION_RE.test(String(base || ''));
    const missing = CANONICAL_GRADES.filter((g) => !grades.includes(g));
    const coversAll = missing.length === 0;
    if (!coversAll && !declared) return null;
    return { grades, missing, declared };
  }

  /**
   * 归一：**完全相同的概率声明**只算一次（同一等级 + 同一数值）。
   *
   * 为什么这是判据的必要条件而不是可选优化：合计检查的语义是"不同**声明**的概率之和"，
   * 所以 `A级百万分之一` 连说三遍必须在加总**之前**折叠成一条（T39：3×0.0001 不是三个分类概率）。
   *
   * ⚠️ 键必须是 `等级 + 数值`，不能只用 `等级`：等级抽取失败时会退化成"每个等级只留一个数"，
   * 把 `D级95% / B级0.09%` 折成一个声明（2026-10-12 实测 p1/p2/p3 三处正例因此丢掉数值）。
   * 也不能只用 `数值`：那是正常的两档同概率（B级与C级都是 1%）被误折叠。
   */
  function dedupePercentClaims(claims) {
    const seen = new Set();
    const out = [];
    for (const c of claims) {
      const key = `${c.grade == null ? '' : c.grade}\u0000${c.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }

  /** 原因连接词与结果连接词（causal_bridge）：只用于报告，不用于硬拦。 */
  const CAUSE_MARKERS = ['因为', '由于', '为了', '之所以', '正是'];
  const CONSEQUENCE_RE = /(?:所以|因此|于是|结果|这才|才会|才能|只能|便不再|才明白|才知道)/;

  /** 处置类动词：紧跟在前的动词说明这个名词是"被使用的物件"（回指用法），而不是首次引入。 */
  const HANDLE_VERBS = ['吃', '拿', '递', '握', '收', '掏', '塞', '咬', '拆', '撕', '端', '拎', '抱', '摸', '找', '看', '买', '带', '装', '放', '接', '打开', '喝', '闻', '试', '戴', '穿', '举', '抢', '分', '掰', '剥', '切', '倒', '喂', '擦', '洗', '捡', '拾', '抓', '取', '丢', '扔'];

  /** 正式事实的形态（story_fact）：等级 / 地名机构 / 编号 / 新人物——全部要求"本章此前从未出现过"。 */
  const GRADE_RE = /(?:SSS|SS|S|A|B|C|D|E|F|甲|乙|丙|丁|[一二三四五六七八九十])\s*级|等级/g;
  const INSTITUTION_RE = /[\u4e00-\u9fa5]{2,6}(?:市|省|区|县|镇|乡|村|大学|中学|高中|学院|医院|公司|集团|署|协会|中心|大厦|场馆|站|机场)/g;
  const LATIN_ZONE_RE = /[A-Z]\s*(?:区|班|组|队)/g;
  const NUMBER_FACT_RE = /(?:[0-9]+|[一二三四五六七八九十两]+)(?:号|楼|层|班|届|点钟|分钟|岁)/g;

  // ── 基础工具 ────────────────────────────────────────────────────────────────

  /** 段落切分口径与 app.js 的 applyRevisionPatches 对齐（空行分段 → 去空白 → 丢空段）。 */
  function paragraphsOf(text) {
    return String(text == null ? '' : text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  }

  /** 中文 n-gram 候选（2–4 字）：首尾都不能是功能字，也不以动词收尾。 */
  function contentTokens(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, '');
    const out = [];
    for (let n = 4; n >= 2; n -= 1) {
      for (let i = 0; i + n <= s.length; i += 1) {
        const t = s.slice(i, i + n);
        if (!/^[\u4e00-\u9fa5]+$/.test(t)) continue;
        if (STOP_TOKENS.has(t)) continue;
        if (FUNC_CHARS.has(t[0]) || FUNC_CHARS.has(t[t.length - 1])) continue;
        if (VERB_TAIL.has(t[t.length - 1])) continue;
        out.push(t);
      }
    }
    return out;
  }

  const excerptAround = (s, at, len, pad = 8) => {
    const from = Math.max(0, at - pad);
    const to = Math.min(String(s).length, at + len + pad);
    return String(s).slice(from, to);
  };

  /** 后文里的这一次使用是"引入"（一袋面包）还是"回指"（那袋面包 / 吃面包 / 把面包递给）？ */
  function classifyObjectUse(prefix) {
    const p = String(prefix || '').slice(-8);
    if (/[一二两三四五六七八九十百千0-9](?:个|袋|张|枚|块|根|条|件|把|台|部|包|瓶|盒|片|颗|份|只|支|杯|碗|盒)$/.test(p)) return 'introducing';
    if (/(?:那|这|该)(?:个|袋|张|枚|块|根|条|件|把|台|部|包|瓶|盒|片|颗|份|只|支|杯|碗)?$/.test(p)) return 'anaphoric';
    if (/(?:他们|她们|我们|你们|他|她|它|我|你)的$/.test(p)) return 'anaphoric';
    if (/(?:手里|手中|桌上|身上|包里|口袋里|怀里|剩下的|剩下的那|同一个|同一个那)$/.test(p)) return 'anaphoric';
    if (/把$/.test(p)) return 'anaphoric';
    if (HANDLE_VERBS.some((v) => p.endsWith(v))) return 'anaphoric';
    return 'plain';
  }

  /** 某个词面在给定段落里的全部使用（带段号与使用类型）。 */
  function tokenUses(paras, token) {
    const uses = [];
    for (let i = 0; i < paras.length; i += 1) {
      const p = paras[i];
      let from = 0;
      for (;;) {
        const at = p.indexOf(token, from);
        if (at < 0) break;
        uses.push({
          paragraph: i,
          kind: classifyObjectUse(p.slice(0, at)),
          excerpt: excerptAround(p, at, token.length),
        });
        from = at + token.length;
      }
    }
    return uses;
  }

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 地名/场馆候选（场景锚点被删时，后文仍在指代它 → 说明后文依赖该锚点）。 */
  function placeTokens(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(/[\u4e00-\u9fa5]{2,6}(?:市|省|区|县|镇|乡|馆|场|中心|大厦|站)/g)) out.add(m[0]);
    for (const m of String(text || '').matchAll(/[A-Z]\s*区/g)) out.add(m[0]);
    return [...out];
  }

  // ── 四类结构桥的风险判定（共用入口） ────────────────────────────────────────

  /**
   * 一条"改前段落 → 改后段落"的删除依赖检查。
   *
   * @param {string} baseText  该条补丁**单独应用后**的全文（after）——所有"后文"都在它上面看
   * @param {string} before    改前段落原文（被删/被压缩的那一段）
   * @param {string} afterKept 改后保留的段落（空串 = 整段删除）
   * @param {number} paraIndex 该段在 after 里的段号（从 0 开始）
   * @param {object} opts      { characters?: string[], protectedContent?: string[] }
   * @returns {Array<{code, paragraph, excerpt, token?, subject?, markers?, reason}>}
   */
  /**
   * ⑤ information_truncation（E03-A / A01 事故样例）：删掉的是"引导语后面的具体内容"，
   * 改后只剩一个**孤立的栏目名/引导语**。
   *
   * 为什么要单列这条信号：这类改动在协议层**完全合法**（授权跨度逐字相等、单条门禁也看不出
   * 物件来源/人称先行语/场景锚点的断裂），但阅读效果是"信息被削掉一半"：
   *   `屏幕下方滚过一行小字：职业方向——材料修复、灵植培育、检测辅助。`
   *   → `屏幕下方滚过一行小字：职业方向。`
   * 它不是格式错，也不是"AI 味"，而是**局部句意不完整**。
   *
   * 判据刻意窄（不做"所有短句都判错"的扫描器），必须同时满足：
   *   ① 原稿里存在「短引导语 + 分隔符（——/—/：/:）+ 具体内容」；
   *   ② 具体内容在改后**消失**（不是被压缩改写，而是整段不见了）；
   *   ③ 引导语仍在，且它在改后紧跟句末标点/段尾（孤零零地挂着）。
   * 三条缺一不报 —— 与"作者就是要删掉整句提示"区分开：那种情况下引导语也一起没了（②/③不成立）。
   */
  const LABEL_BEFORE_RE = /([^。！？!?…，,；;：:—\n]{1,12})$/;
  function informationTruncationRisks(paraBefore, paraAfter, paraIndex) {
    const out = [];
    const beforeText = String(paraBefore == null ? '' : paraBefore);
    const keptText = String(paraAfter == null ? '' : paraAfter);
    if (!beforeText || !keptText || beforeText === keptText) return out;
    const paragraph = Math.max(0, Number(paraIndex) || 0);
    for (const sep of ['——', '—', '：', ':']) {
      for (let at = beforeText.indexOf(sep); at >= 0; at = beforeText.indexOf(sep, at + sep.length)) {
        const labelMatch = beforeText.slice(0, at).match(LABEL_BEFORE_RE);
        if (!labelMatch) continue;
        const label = labelMatch[1].trim();
        if (!label) continue;
        // 具体内容：分隔符之后到该句结束为止（原稿里真的"列了东西"）。
        const tailMatch = beforeText.slice(at + sep.length).match(/^([^。！？!?\n]*)/);
        const tail = tailMatch ? tailMatch[1].trim() : '';
        if (tail.length < 3) continue;
        if (keptText.includes(tail)) continue;            // ② 内容还在 → 不是截断
        if (!keptText.includes(label)) continue;          // ③a 引导语也一起删了 → 是"整句删除"，不是留半截
        const atKept = keptText.lastIndexOf(label);
        // ③b 引导语在改后**自成一句**（后面到句末标点之间没有任何内容）→ 孤零零地挂着。
        //     用"句"而不是"段"作边界：`能力。他闭上眼。` 里"能力。"同样是残缺句，
        //     只是它后面还跟着别的句子；而 `他说：“今天别出门。”` 的 label 后面接着内容 → 不报。
        const rest = keptText.slice(atKept + label.length);
        const restOfSentence = (rest.match(/^([^。！？!?\n]*)/) || [''])[1];
        if (restOfSentence.trim() !== '') continue;
        out.push({
          code: 'information_truncation',
          subtype: 'orphaned_label',
          label,
          separator: sep,
          lost: tail,
          paragraph,
          excerpt: beforeText.slice(0, 60),
          reason: `删掉了「${label}」后面的具体内容（原稿：${label}${sep}${tail}）：`
            + `改后只剩一个孤立的栏目名/引导语（"${label}"），读者拿不到本来列出的信息 —— `
            + '这不等于"质量改善"，建议人工确认是否补回或改写成完整句',
        });
        return out;   // 一处段落只报一条（同一段里的重复引导语不值得重复占用作者注意力）
      }
    }
    return out;
  }

  function deletionRisks(baseText, before, afterKept, paraIndex, opts = {}) {
    const beforeText = String(before == null ? '' : before);
    const keptText = String(afterKept == null ? '' : afterKept);
    const paras = paragraphsOf(baseText);
    const idx = Math.max(0, Math.min(Number(paraIndex) || 0, paras.length));
    const early = paras.slice(0, idx);
    const later = paras.slice(idx);
    const risks = [];

    // ① object_provenance：删掉的是后文回指使用的物件来源。
    if (beforeText.length <= 600) {
      const lost = [...new Set(contentTokens(beforeText))].filter((t) => !keptText.includes(t));
      for (const token of lost) {
        const uses = tokenUses(later, token);
        if (!uses.length) continue;
        if (early.some((p) => p.includes(token))) continue;      // 前文已经引入过 → 来源还在
        if (uses[0].kind !== 'anaphoric') continue;              // 第一次使用就是"引入式" → 来源重建
        risks.push({
          code: 'object_provenance',
          token,
          paragraph: idx + uses[0].paragraph,
          excerpt: uses[0].excerpt,
          reason: `删掉了后文仍在使用的物件来源「${token}」（后文："${uses[0].excerpt}"，是回指用法而不是首次引入）`,
        });
        if (risks.filter((r) => r.code === 'object_provenance').length >= 5) break;
      }
    }

    // ② reference_anchor：删掉的是后文代词的先行语。
    const anchors = [...new Set([...(Array.isArray(opts.characters) ? opts.characters : []).map(String).filter(Boolean), ...SUBJECT_NOUNS])];
    const lostSubjects = anchors.filter((s) => beforeText.includes(s) && !keptText.includes(s));
    if (lostSubjects.length) {
      const anchorRe = new RegExp(anchors.map(escapeRe).join('|'));
      const window = later.slice(0, 3);
      for (let i = 0; i < window.length; i += 1) {
        const p = window[i];
        const m = PRONOUN_RE.exec(p);
        if (!m) continue;
        // 代词之前是否还有任何"人"的锚点（前文 + 窗口内本段之前的部分）
        const upTo = early.join('\n') + '\n' + window.slice(0, i).join('\n') + '\n' + p.slice(0, m.index);
        if (anchorRe.test(upTo)) continue;
        risks.push({
          code: 'reference_anchor',
          subject: lostSubjects[0],
          pronoun: m[0],
          paragraph: idx + i,
          excerpt: excerptAround(p, m.index, m[0].length),
          reason: `删掉了代词「${m[0]}」的先行语「${lostSubjects[0]}」：后文（"${excerptAround(p, m.index, m[0].length)}"）仍用该代词，而此前已没有任何人称锚点`,
        });
        break;
      }
    }

    // ③ scene_anchor：删掉的是场景/视点来源，而后文仍在同一画面里承接。
    const markers = SCENE_MARKERS.filter((m) => beforeText.includes(m));
    if (markers.length && !SCENE_MARKERS.some((m) => keptText.includes(m))) {
      const window = later.slice(0, 3);
      const windowText = window.join('\n');
      const places = placeTokens(beforeText).filter((p) => windowText.includes(p));
      if (PRONOUN_RE.test(windowText) || places.length) {
        risks.push({
          code: 'scene_anchor',
          markers,
          paragraph: idx,
          excerpt: beforeText.slice(0, 60),
          reason: `删掉了场景/视点锚点（${markers.join('、')}）：后文仍在用代${places.length ? `或地名「${places[0]}」` : '词'}承接同一画面，读者无法判断当前是现场还是屏幕/转播`,
        });
      }
    }

    // ④ causal_bridge_break：只报告（"因为/为了"太常见，硬拦会误伤正常压缩）。
    const causes = CAUSE_MARKERS.filter((m) => beforeText.includes(m));
    if (causes.length && !CAUSE_MARKERS.some((m) => keptText.includes(m))) {
      const windowText = later.slice(0, 4).join('\n');
      if (CONSEQUENCE_RE.test(windowText)) {
        risks.push({
          code: 'causal_bridge_break',
          markers: causes,
          paragraph: idx,
          excerpt: beforeText.slice(0, 60),
          reason: `删掉了原因（${causes.join('、')}）：后文仍在用结果连词承接（"${(windowText.match(CONSEQUENCE_RE) || [''])[0]}"）`,
        });
      }
    }

    // ⑤ information_truncation：与上面四条不同，它不依赖后文 —— 只比"这一段改前/改后"。
    // 为什么放在这里而不是另建扫描器：它和上面四条一样回答"这条改动该不该自动应用"，
    // 只是证据面是**局部句意**而不是后文回指。放进同一个返回值，门禁与组合核验两条路径都自动带上它。
    risks.push(...informationTruncationRisks(beforeText, keptText, idx));

    return risks;
  }

  // ── 改动粒度分级（文档 §9） ─────────────────────────────────────────────────

  /** 会改变"发生了什么"的动作动词：删掉带它们的句子就不是纯表达了。 */
  const EVENT_VERBS = ['递', '拿', '跑', '站', '坐', '问', '喊', '掏出', '塞', '摘', '挂', '绕', '捋', '抬手', '伸手', '转身', '点头', '摇头', '握住', '放下', '推开', '走进', '走出', '接过', '交给'];

  /** 被删掉的句子碎片（anchor 有、revised 里已找不到的整句）。 */
  function removedFragments(anchor, revised) {
    return String(anchor)
      .split(/(?<=[。！？!?…])/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !String(revised).includes(s));
  }

  /** 纯表达压缩：删掉的部分只是描写（无对白、无人称主体、无动作动词）。 */
  function isPureWording(anchor, revised) {
    const frags = removedFragments(anchor, revised);
    if (!frags.length) return false;
    const personRe = new RegExp([...SUBJECT_NOUNS, ...PRONOUNS].map(escapeRe).join('|'));
    return frags.every((f) => !/[「」“”"']/.test(f) && !personRe.test(f) && !EVENT_VERBS.some((v) => f.includes(v)));
  }

  /** 词面在"改前有、改后新出现"的差集（用于 story_fact 证据）。 */
  function newMatches(re, before, after) {
    const seen = new Set((String(before || '').match(re) || []).map((s) => s.replace(/\s+/g, '')));
    return [...new Set((String(after || '').match(re) || []).map((s) => s.replace(/\s+/g, '')))].filter((s) => !seen.has(s));
  }

  // ── 2026-03-17（第五批 · v118 0317 专项：《Novel Studio v1.1.8｜3月17日觉醒日》）─────
  //
  // 本批补的是**上一批判据词形之外**的两个真实缺口（不重做 story_fact 保护，只加窄而可否决的候选）：
  //
  //   ① `new_workflow_rule`：现行 story_fact 只认"等级/机构/分区/编号/人物"这些**实体词形**。
  //      可"下午的号按学校分批往下叫"是一条**新的行政机制/流程事实**——它把叫号规则、分批口径、
  //      以及"下午还有一批人"三件事同时写进正文，却不含任何实体词形，也不到大幅扩写门槛。
  //      实测（本轮探针）：该改动被分类为 `wording`、signals 为空 —— 也就是**直接自动应用**。
  //      事故形态可见于本轮 R01：作者报告"中午只剩十几人、十分钟一个变成三五分钟一个、
  //      王磊测完说走了"，模型为了解释"为何天黑才出门"，**替检测中心发明了一条叫号制度**。
  //
  //   ② `temporal_causal_bridge`：新增时间句让"时间对得上"，但**因果缺口仍在**。
  //      判据只认可逐字指出的形状：底稿已有"离开/结束"类事件收束，而改后出现"天色已暗/入夜"
  //      这类时间推进，且新增内容**只**是无来源的流程声明。有来源的等待事件（点名到具体行为）
  //      不触发——这是本批唯一的误报防线，因此它的放行通道不认"分批复核"这类泛词。
  //
  // 两条都遵守本文件的三条纪律：必须能指出证据原文；未命中不表态；只产出候选与"待授权"标记，
  // **不**自行改故事。R01 的叙事修法（把"中午"挪到傍晚、或由作者批准一个有来源的事件）
  // 属于作者决策，模块只负责"不许静默采纳"。
  const WORKFLOW_PATTERNS = [
    { re: /(?:按|以)[\u4e00-\u9fa5]{1,6}(?:分批|分拨|分组|分片)/, code: 'batch_by_group' },
    { re: /(?:分|按)[一二三四五六七八九十两0-9]{1,2}批/, code: 'numbered_batch' },
    { re: /(?:分批|分时段|分片区|分学校|分年级)[\u4e00-\u9fa5]{0,4}(?:叫号|往下叫|放行|进场|检测|采样|安排)/, code: 'batched_admission' },
  ];
  /** 一句话里同时出现"制度性叫号语"时才认，避免把"下午的号"这类普通叙述当机制。 */
  const WORKFLOW_LINK = /(?:号|叫|排|批次|名单|单)/;

  /**
   * 未经批准的制度/流程事实候选（《0317 增补》§2 P0）。
   *
   * @param {string} anchor 改前文本
   * @param {string} revised 改后文本
   * @param {{baseText?:string}} opts
   * @returns {Array<{code:string,evidence:string,needs_fact_authorization:boolean}>}
   */
  function workflowRuleCandidates(anchor, revised, opts = {}) {
    // ⚠️ 口径：`baseText` 是"**已批准世界**"（含蓝图已允许的既有机制与本章底稿）。
    //    它参与两个方向：① 新增句必须不在 baseText 里；② 同一机制若**已存在于 baseText**，
    //    那么再次应用同一替换不得被永久硬拦（V118-02 的"不过度拒绝"）。
    const approved = String(opts.baseText == null ? anchor : opts.baseText);
    const a = String(anchor == null ? '' : anchor);
    const r = String(revised == null ? '' : revised);
    // 只看**新增**片段：底稿里本来就有的机制不是这次引入的事实（纯删除/替换形态新增为空）。
    const added = r.startsWith(a) ? r.slice(a.length) : (a.startsWith(r) ? '' : r);
    const out = [];
    for (const pat of WORKFLOW_PATTERNS) {
      const m = (added.match(pat.re) || [])[0];
      if (!m) continue;
      if (approved.includes(m)) continue; // 已批准：不再报
      if (!WORKFLOW_LINK.test(added)) continue;
      out.push({ code: 'new_workflow_rule', evidence: m, needs_fact_authorization: true });
      break; // 一句里同一条机制只报一次
    }
    return out;
  }

  /** 时间推进（时间跳跃的**后**半）：天色/入夜/傍晚这类墙面钟标记。 */
  const TIME_ADVANCE = /天色|天黑|入夜|傍晚|黄昏|夜幕|路灯|掌灯/;
  /** "离开/收束"类事件收束（时间跳跃的**前**半）。 */
  const EVENT_CLOSES = /走了|离开了|结束|散场|测完|散了/;

  /**
   * 时间因果桥判定（《0317 增补》§2 P0 · R01 形状）。
   *
   * 为什么不是"两个时间词的距离够不够大"：那会把**任何**时间描写都当缺口（误报高到没人看）。
   * 只认一个可逐字复核的形状：**底稿已经写完整件事、且写了人已经走了**，改后却把出门时间
   * 推到"天色已暗"，而新增内容只是一句**没有来源**的流程声明。
   *
   * ⚠️ 它只判"这条改动没有把因果补上"，不判"小说该怎么改"——把"中午"挪到傍晚是作者的决策。
   *
   * @returns {{code:string,resolved:boolean|null,time_advance:string,close:string,added:string}}
   */
  function assessTemporalBridge(before, after, opts = {}) {
    const b = String(before == null ? '' : before);
    const s = String(after == null ? '' : after);
    const close = (b.match(EVENT_CLOSES) || [])[0] || '';
    if (!close) return { code: 'not_applicable', resolved: null, time_advance: '', close: '', added: '' };
    const advance = (s.match(TIME_ADVANCE) || [])[0] || '';
    if (!advance) return { code: 'not_applicable', resolved: null, time_advance: '', close: '', added: '' };
    const added = s.startsWith(b) ? s.slice(b.length) : (b.startsWith(s) ? '' : s);
    // 有来源的等待事件：点名了一个具体行为 + 具体对象/量（"交回排号单复核一趟""等三点那批"）。
    // 这是**唯一的放行通道**，判据刻意要求"动宾 + 量词/对象"，不接受"分批复核"这类泛词。
    const sourced = /(陪|等|排队|找到|补交|复核|重新|被叫|叫到|进去|出来)[\u4e00-\u9fa5]{0,10}(单|人|趟|次|号|遍)/.test(added)
      || /(陪|等)[\u4e00-\u9fa5]{1,4}(王磊|李拓|他)/.test(added);
    if (sourced) return { code: 'bridged_by_sourced_event', resolved: true, time_advance: advance, close, added };
    return { code: 'time_gap_unresolved', resolved: false, time_advance: advance, close, added };
  }

  /**
   * 同物件状态跨句重叠候选（《0317 增补》§6 · V118-10）。
   *
   * 事故形态：手机先"悬在半空"，后又"举起来想拍大屏，举到一半又放下"——
   * 中间没有复位动作（放下/收回），读者会看到一个物件的状态被两次置位。
   *
   * 判据刻意窄：**同一物件**（同一名词）在**前后相邻句**里各出现一次状态动词，两次状态**不同**，
   * 且中间没有复位动词。不同物件、同一状态重复、或中间有明确复位都不报。
   * 反证通道写在结果里：它可能是"另一只手""中间已复位只是没写"——本判据只提疑点，不定罪。
   */
  const PROP_STATE_VERBS = /(举起|抬起|悬在|放下|收回|掏出|摸出|递出|攥住|捏住|握紧|塞回)/;
  const PROP_RESET_VERBS = /(放下|收回|塞回|揣回|挂回|放回)/;
  function propStateCandidates(text, opts = {}) {
    const s = String(text == null ? '' : text);
    const sentences = s.split(/(?<=[。！？…])/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < sentences.length; i += 1) {
      const cur = sentences[i];
      const vm = PROP_STATE_VERBS.exec(cur);
      if (!vm) continue;
      // 物件名：状态动词之前最近的一个名词性片段（去掉人称与功能词后看尾部）。
      const head = cur.slice(0, vm.index).replace(/[，,、。！？…：:「」“”"'（）()]/g, '');
      const prop = /(手机|书包|评定单|排号纸|号码纸|号码单|检测石|背包|外套|钥匙|水杯|纸|单)$/.exec(head);
      if (!prop) continue;
      for (let j = i + 1; j < Math.min(sentences.length, i + 4); j += 1) {
        const nxt = sentences[j];
        if (!nxt.includes(prop[1])) continue;
        const nm = PROP_STATE_VERBS.exec(nxt);
        if (!nm) continue;
        if (vm[1] === nm[1]) break; // 同一状态重复：属于重复描写，不是状态缺桥
        // 中间有复位动作 → 状态被明确收束，不报。
        const between = sentences.slice(i, j).join('');
        if (PROP_RESET_VERBS.test(between.replace(cur, '')) || PROP_RESET_VERBS.test(nxt.slice(0, nm.index))) break;
        out.push({
          code: 'prop_state_possible_overlap',
          prop: prop[1],
          evidence: `「${prop[1]}」先在「${cur.slice(0, vm.index + vm[1].length)}」处于「${vm[1]}」，`
            + `随后又在「${nxt.slice(0, nm.index + nm[1].length)}」变为「${nm[1]}」，中间没有复位动作`,
          counterevidence: '若两次之间物件已复位（放下/收回/换手）、或这是另一件同类物件、'
            + '又或叙述刻意并置两个时点，本条即不成立——本判据只提疑点，不据此改写正文',
        });
        break;
      }
    }
    return { candidates: out, count: out.length };
  }

  /**
   * 伏笔编号锚的**可见性**判定（《0317 增补》§6 · V118-13）。
   *
   * 事故形态：伏笔 #35 计划用 `0731` 作为身份锚，而正文只写"评定单上是一串数字，没细看"。
   * 这**不是**硬冲突（可能是有意延后公开），因此只返回 `unknown_anchor`，
   * 既不自动补数字，也不判矛盾——判"硬冲突"需要一个与它**冲突**的明写值。
   */
  function anchorStatus({ text, anchor, label = '' } = {}) {
    const t = String(text == null ? '' : text);
    const key = String(anchor == null ? '' : anchor).trim();
    if (!key) return { status: 'no_anchor', label, anchor: key, hard_conflict: false, note: '未给出待核验锚值' };
    if (t.includes(key)) return { status: 'confirmed', label, anchor: key, hard_conflict: false, note: `锚值「${key}」已在正文里明写` };
    // 正文里有**同一锚位**的模糊表述（"一串数字/没细看"）→ 刻意隐藏或尚未披露，均属 unknown。
    const vague = /(一串数字|没细看|没有细看|几个数字|没看清)/.test(t);
    return {
      status: 'unknown_anchor',
      label,
      anchor: key,
      hard_conflict: false,
      vague_mention: vague,
      note: `正文未明写「${key}」${vague ? '（只有"一串数字"这类模糊表述）' : ''}：`
        + '可能是有意延后公开，不判硬冲突、不自动补数；需作者或蓝图确认披露时点',
    };
  }

  /**
   * 这条补丁属于哪个粒度？
   *   wording         纯表达（压缩、换词），不动事件/人物/物件/地点/时间/因果 → 自动应用
   *   local_structure 合并反应、压缩重复、调整局部段落 → 过安全门禁后应用
   *   story_fact      新增事件/制度、改等级/时间线/关系 → **禁止自动应用，只输出建议**
   *
   * story_fact 判据刻意窄：只有"本章此前从未出现过的正式事实形态"才算
   * （等级 / 地名机构 / 拉丁编号区 / 编号日期 / 新人物名 / **新的制度流程** / 未解释的时间因果），
   * 并且必须能指出证据原文。这样"把检测台改写成检测中心"这类同义改写不会被误判成新事实。
   *
   * ⚠️ 与 UI 保存 / 作者手工编辑 / 明确整章重写授权的边界（本轮硬要求）：
   *   本函数只在**机器局部补丁**这条通道上被调用。`authorApprovedTimeAnchors`（作者已批准时间锚调整）
   *   与"整章重写授权"一样属于作者显式决定，此时时间锚类候选直接放行——新 AI 局部门禁**不得**
   *   阻断人的自主编辑与作者已批准的整章任务。
   */
  function classifyEditScope(anchor, revised, opts = {}) {
    const a = String(anchor == null ? '' : anchor);
    const r = String(revised == null ? '' : revised);
    const base = String(opts.baseText == null ? a : opts.baseText);
    const signals = [];
    const isNew = (tok) => tok && !base.includes(tok);

    const grade = newMatches(GRADE_RE, a, r).find(isNew);
    if (grade) signals.push({ code: 'new_grade', evidence: grade });
    // 制度/流程事实（见本批 §2 说明）：在实体词形之外补一条窄候选。
    for (const wf of workflowRuleCandidates(a, r, opts)) signals.push(wf);
    const inst = newMatches(INSTITUTION_RE, a, r).find(isNew);
    if (inst) signals.push({ code: 'new_institution', evidence: inst });
    const zone = newMatches(LATIN_ZONE_RE, a, r).find(isNew);
    if (zone) signals.push({ code: 'new_zone', evidence: zone });
    const num = newMatches(NUMBER_FACT_RE, a, r).find(isNew);
    if (num) signals.push({ code: 'new_number', evidence: num });
    const who = (Array.isArray(opts.characters) ? opts.characters : []).map(String).filter(Boolean)
      .find((n) => r.includes(n) && !a.includes(n) && isNew(n));
    if (who) signals.push({ code: 'new_character', evidence: who });
    // 时间因果桥：底稿已收束、改后靠"天色已暗"交代时间而新增内容无来源。
    // ⚠️ 作者已批准时间锚调整时**不报**：作者显式决定优先于机器门禁（V118-14）。
    if (!opts.authorApprovedTimeAnchors) {
      const bridge = assessTemporalBridge(base, r);
      if (bridge && bridge.code === 'time_gap_unresolved') {
        signals.push({
          code: 'temporal_causal_bridge',
          evidence: `底稿「${bridge.close}」之后以「${bridge.time_advance}」交代时间推进，新增内容未提供有来源的等待事件`,
          needs_fact_authorization: true,
        });
      }
    }
    // 事实增量过大：改后段落比改前长出一倍以上且多出 60 字以上（B 区式"顺手新增支线"的形状）
    if (r.length > a.length * 2 && r.length - a.length >= 60) signals.push({ code: 'expansion', evidence: `${a.length}→${r.length} 字` });

    if (signals.length) {
      return {
        scope: SCOPE.STORY_FACT,
        signals,
        // 任一信号要求"事实授权"时，调用方必须把该条标成"证据不足的候选"，
        // 而不是直接当成可信修稿采纳（《0317 增补》§2 的分层要求）。
        needs_fact_authorization: signals.some((s) => s.needs_fact_authorization === true),
      };
    }
    if (r.length <= a.length * 0.95) {
      // 压缩里只有两种：删掉的只是描写（纯表达 = wording），或删掉了带动作/对白/主体的句子（= local_structure）。
      return isPureWording(a, r)
        ? { scope: SCOPE.WORDING, signals: [{ code: 'descriptive_compression', evidence: `${a.length}→${r.length} 字` }] }
        : { scope: SCOPE.LOCAL_STRUCTURE, signals: [{ code: 'compression', evidence: `${a.length}→${r.length} 字` }] };
    }
    return { scope: SCOPE.WORDING, signals: [] };
  }

  // ── 2026-10-08（第四批 · v1.1.0）：不可变信息锁 / 跨段整句重复 / 转场桥 ────────
  //
  // 判据方向的转变（这一批最重要的一句话）：
  //   旧三判据（v1.0.0）全部问「**删掉**的东西后文还在不在用」——它们只能拦"删多了"。
  //   作者复核稿里的 1738→1736 是**改错**，删掉的东西根本不存在；旧判据对它**完全失明**。
  //   所以这一批补的是另一半：**同一事实在章内被赋了两个值**（改错），
  //   以及"删掉了唯一的场景来源"（删错，但 scene_anchor 的词表测不到），
  //   和"整句逐字重复"（写的错，与删改都无关，是成稿前的最后一道自检）。

  const toHalf = (s) => String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[％]/g, '%');
  const digitsOf = (s) => toHalf(s).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');

  /** 中文数字串 → 整数（只支持"九十五""十""一百"这一级，够百分比判据用）。 */
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

  /**
   * 编号事实的**候选收集**（scanFactLock 与门禁的"值是否被改掉"判定共用同一份）。
   *
   * 拆出来的原因（2026-10-08）：同一套抽取逻辑如果写两份，S/L 两处必然漂移——
   * 而这一批的全部缺陷都出在"抽取条件写窄了一点点"上（后缀看错位置、窗口里没有人名），
   * 两份实现会让"改一处、另一处仍然失明"。这里只抽一次，两个判据都用它。
   */
  function scanFactCandidates(text, opts = {}) {
    const base = String(text == null ? '' : text);
    const paras = paragraphsOf(base);
    const names = (Array.isArray(opts.characters) ? opts.characters : []).map(String).map((s) => s.trim()).filter((s) => s.length >= 2);
    const numRe = /([0-9０-９]{1,8})(?:号|编号|排号|座号|学号|考号|号码|班级|年级|届|楼层|层|房间|室|岁|年)?/g;
    const suffixRe = new RegExp(`^\\s*(?:${ID_SUFFIX})`);
    const preLabelRe = new RegExp(`(${LINK_WORDS})$`);
    const out = [];
    for (let i = 0; i < paras.length; i += 1) {
      const p = paras[i];
      for (const m of p.matchAll(numRe)) {
        const value = digitsOf(m[1]);
        if (!value || value.length > 6) continue;
        // 数字必须是一个完整的数（后一位不能还是数字，如 17361 是另一个数）。
        if (/[0-9０-９]/.test(p.slice(m.index + m[1].length, m.index + m[1].length + 1))) continue;
        // ⚠️ 后缀要看**数字之后**的文本，不能看"整个匹配之后"的文本
        //    （2026-10-08 探针抓到的第五个自身缺陷）：`numRe` 会把 `1736号` 一起吃掉，
        //    于是从 m[0] 末尾再找后缀永远为空 ——「广播叫到1736号，王磊」因此整条不入账，
        //    "同一编号两个主人"这条判据静默失效。
        const numEnd = m.index + m[1].length;
        const tail = p.slice(numEnd);
        const suffix = suffixRe.test(tail) ? (tail.match(suffixRe) || [''])[0].trim() : '';
        const winText = p.slice(Math.max(0, m.index - 20), m.index);
        const linked = preLabelRe.test(winText);
        // ⚠️ 收缩口径：没有后缀、数字前也没有连线词的裸数字（"前面有175个人"）**不入账**——
        // 它没有可以比较的实体键，硬报会让判据在普通叙述上误伤。
        if (!suffix && !linked) continue;
        const label = labelFromWindow(winText);
        const owner = nearestName(p, m.index, names);
        if (!label && !owner) continue;
        out.push({
          value,
          label,
          owner,
          paragraph: i,
          excerpt: excerptAround(p, m.index, m[0].length, 10),
        });
      }
    }
    return out;
  }

  /**
   * 事实锁扫描：章内同一数值/编号的既有陈述是否自相矛盾。
   *
   * 契约（零误报优先，宁可不响）：
   *   · 只认「数字 + 明确编号后缀」（`1736号`）或「数字前的连线词」（`排号纸是1736`）这两种形态；
   *   · 一个实体名出现**两个不同值** → 报（"岳宸炎的排号纸是1736" vs "…是1738"）；
   *   · 一个值出现**两个不同主人**（人物卡名字）→ 报（1736 同时挂在岳宸炎与王磊名下）；
   *   · 一个值被复述两次、主人相同 → **不报**（"1736号，王磊"与"王磊的排号是1736"都是正常写法）；
   *   · 无后缀也无连线词的裸数字（"前面有175个人"）→ 永不参与判定。
   *
   * ⚠️ 它**不做**"单点改名"这类判断（1738 只出现一次、被改成 1736 时章内只剩一个值）：
   * 那需要与改前的章文对比，属门禁侧 `gatePatches` 的第三条判据（见 `lockedValues`）。
   *
   * @returns {Array<{code,value,label,paragraph,excerpt,conflict,reason}>}
   */
  function scanFactLock(text, opts = {}) {
    const entries = scanFactCandidates(text, opts);
    const base = String(text == null ? '' : text);
    const facts = [];
    const seen = new Set();
    const push = (e) => {
      const key = `${e.code}|${e.value}|${e.label}|${e.owner}|${e.paragraph}`;
      if (seen.has(key)) return;
      seen.add(key);
      facts.push(e);
    };
    // ① 同一实体两个值
    const byLabel = new Map();
    for (const e of entries) {
      if (!e.label) continue;
      const arr = byLabel.get(e.label) || [];
      arr.push(e);
      byLabel.set(e.label, arr);
    }
    for (const [label, arr] of byLabel) {
      const values = [...new Set(arr.map((e) => e.value))];
      if (values.length < 2) continue;
      const where = values.map((v) => {
        const at = arr.find((e) => e.value === v);
        return `第 ${at.paragraph + 1} 段「${v}」`;
      }).join('、');
      push({
        code: 'fact_lock_conflict',
        value: values.join('/'),
        label,
        paragraph: arr[0].paragraph,
        excerpt: arr[0].excerpt,
        conflict: where,
        reason: `同一实体「${label}」在本章被写成两个不同编号（${where}）：编号是既有事实，改错会让后文对不上`,
      });
    }
    // ② 同一值两个主人。
    //    ⚠️ 键必须取**本章人物卡名字**，不能取上面那个"实体名候选"（label）：
    //    "叫到1736号"这类句子的候选会剥出"叫到"这种动词碎片，把它当成主人会产出假矛盾
    //    （探针 2026-10-08：正例因此漏报）。没有人物卡名字时**这一条整条不判定** ——
    //    宁可漏，也不猜主人（与文件头"未命中不表态"一致）。
    const byValue = new Map();
    for (const e of entries) {
      if (!e.owner) continue;
      const arr = byValue.get(e.value) || [];
      arr.push(e);
      byValue.set(e.value, arr);
    }
    for (const [value, arr] of byValue) {
      const owners = [...new Set(arr.map((e) => e.owner))];
      if (owners.length < 2) continue;
      const where = owners.map((o) => {
        const at = arr.find((e) => e.owner === o);
        return `第 ${at.paragraph + 1} 段「${o}」`;
      }).join('、');
      push({
        code: 'fact_lock_conflict',
        value,
        label: owners.join('/'),
        paragraph: arr[0].paragraph,
        excerpt: arr[0].excerpt,
        conflict: where,
        reason: `编号「${value}」在本章同时挂在两个人物名下（${where}）：同一检测中心不会有两个相同的号`,
      });
    }
    // ③ 百分比合计（只报告；它是"这一版的设定陈述不自洽"，与某一条补丁无关）
    //
    // ⚠️ 2026-10-12（0731 增补方案 §3）加了**资格判定**：不再"收到两个数就判 100%"。
    //   只有完整互斥的等级分布才谈得上合计；否则如实报"分布不完整"，而不是拿作者没写的
    //   档位去问罪（旧行为会把 `D级95%+万分之一+十万分之一` 说成"漏了 4.99%"）。
    const claims = collectPercentClaims(base);
    const pcts = claims.map((c) => c.value);
    const coverage = distributionEvidence(claims, base);
    if (new Set(pcts).size >= 2) {
      if (!coverage) {
        // 分布不完整：这不是缺陷，是"没写全"。如实说明，且**不**产出 percent_sum_mismatch。
        push({
          code: 'percent_distribution_incomplete',
          value: '',
          label: '',
          paragraph: null,
          excerpt: `本章出现的百分比：${[...new Set(pcts)].join(' / ')}`,
          conflict: '分布不完整',
          reason: `本章只列了部分等级的占比（未覆盖 ${CANONICAL_GRADES.filter((g) => !claims.some((c) => c.grade === g)).join('/')}）：`
            + '缺档的分布没有"合计"可言，因此不做"应为 100%"的判断',
        });
      } else {
        const sum = Math.round(pcts.reduce((a, b) => a + b, 0) * 100) / 100;
        // 容差 0.5%：判据是**数值加总**（不是语言判断），所以可以卡得很死。
        // 口径演变（两次都栽在同一个地方，留痕）：
        //   · 1.0% → 「95 + 4 + 0.09 = 99.09」差 0.91%，刚好躲过，真缺陷被判成"没问题"；
        //   · 1.5% → 更松，同样躲过；
        //   现在 0.5%：作者按两位小数四舍五入时的正常误差（≤0.05%）照过，
        //   而复核稿里这种"不到 100%"的真缺陷能命中。
        if (Math.abs(sum - 100) > 0.5) {
          push({
            code: 'percent_sum_mismatch',
            value: String(sum),
            label: '',
            paragraph: null,
            excerpt: `本章出现的百分比：${[...new Set(pcts)].join(' / ')}`,
            conflict: `合计 ${sum}%`,
            reason: `本章列出的百分比合计为 ${sum}%（应为 100%）：等级概率是世界观事实，读者会拿计算器核对`,
          });
        }
      }
    }
    return facts;
  }

  /** 句子归一（去空白与标点）：用于"整句逐字重复"的跨段比较。 */
  const normalizeSentence = (s) => String(s || '').replace(/[\s，。！？、；：,.!?;:「」“”"'（）()【】…—\-]/g, '');

  /**
   * 跨段整句重复：同一句（去标点后逐字相同）出现在 **≥3 个段落** 里 → 报。
   *
   * 为什么门槛是 3 段而不是 2：正常的刻意复沓（强调句、口头禅、排比）最多跨两段；
   * 作者复核稿里那次事故是「岳宸炎把手从石板上拿开。」**整句复制了一遍**，
   * 形态上是同一句在相邻段落各出现一次 —— 但把它压到 2 段会立刻误伤合法复沓，
   * 所以这里退一步：2 段的重复交给作者的肉眼与差异预览（预览里逐字重复本来就是可见的），
   * 判据只报 ≥3 段这一种**没有任何正常写法会用到**的形态。
   *
   * 为什么门槛是 10 字（去标点后）：短句（"嗯。""他不知道。"）在章内重复是正常节奏，不是事故；
   * 作者这一章被复制的整句是「岳宸炎把手从石板上拿开。」（去标点 11 字），门槛放在 10 才抓得到。
   */
  const MIN_DUP_CHARS = 10;
  function scanCrossParagraphDuplicates(text) {
    const paras = paragraphsOf(text);
    const groups = new Map();
    for (let i = 0; i < paras.length; i += 1) {
      for (const sent of String(paras[i]).split(/(?<=[。！？!?…])/)) {
        const norm = normalizeSentence(sent);
        if (norm.length < MIN_DUP_CHARS) continue;
        const g = groups.get(norm) || { norm, raw: String(sent).trim(), paragraphs: [] };
        if (!g.paragraphs.includes(i)) g.paragraphs.push(i);
        groups.set(norm, g);
      }
    }
    const out = [];
    for (const g of groups.values()) {
      if (g.paragraphs.length < 3) continue;
      out.push({
        code: 'cross_paragraph_duplicate',
        paragraph: g.paragraphs[0],
        excerpt: g.raw.slice(0, 40),
        reason: `同一句在 ${g.paragraphs.length} 个段落里逐字重复（第 ${g.paragraphs.map((i) => i + 1).join('、')} 段）：`
          + `「${g.raw.slice(0, 24)}…」`,
      });
    }
    return out;
  }

  /**
   * 转场桥：删掉了**唯一的场景来源句**，而紧接着的段落直接写只可能来自外景的东西。
   *
   * 与 scene_anchor（v1.0.0 的词表判据）的分工：
   *   · scene_anchor 认的是 `大屏/画面/镜头/切到` 这类**词表词**被删；
   *   · 这一条认的是**删掉之后读者会失去方位**这一后果——即使被删的句子里一个词表词都没有。
   *   · 作者复核稿的实例：「画面切回江陵本地的队伍」被删 → 下一段「外面在下雪」，
   *     中间缺了"镜头到室外"的转场。旧判据只有 SCENE_MARKERS，抓不到"外面"这类外景证据。
   */
  function sceneBridgeRisks(baseText, before, afterKept, paraIndex, opts = {}) {
    const beforeText = String(before == null ? '' : before);
    const keptText = String(afterKept == null ? '' : afterKept);
    const lostScene = SCENE_MARKERS.filter((m) => beforeText.includes(m) && !keptText.includes(m));
    if (!lostScene.length) return [];
    const paras = paragraphsOf(baseText);
    const idx = Math.max(0, Math.min(Number(paraIndex) || 0, paras.length));
    const later = paras.slice(idx);
    const window = later.slice(0, 3).join('\n');
    const exterior = EXTERIOR_MARKERS.filter((m) => window.includes(m));
    if (!exterior.length) return [];
    if (EXTERIOR_MARKERS.some((m) => keptText.includes(m))) return [];
    return [{
      code: 'scene_bridge',
      markers: lostScene,
      paragraph: idx,
      excerpt: beforeText.slice(0, 60),
      reason: `删掉了场景/视点来源（${lostScene.join('、')}），紧接着的段落直接写「${exterior[0]}」这类外景：`
        + '读者会突然不知道"我们现在在看哪儿"。保留转场句，或把外景并回同一句里。',
    }];
  }

  /** 与 applyRevisionPatches 同口径的定位：逐字唯一命中优先，其次长 anchor 的包含退让（须唯一）。 */
  function locateParagraph(paras, anchor) {
    const exact = [];
    for (let i = 0; i < paras.length; i += 1) if (paras[i] === anchor) exact.push(i);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return -1;
    if (anchor.length < 8) return -1;
    const fuzzy = [];
    for (let i = 0; i < paras.length; i += 1) if (paras[i].includes(anchor)) fuzzy.push(i);
    return fuzzy.length === 1 ? fuzzy[0] : -1;
  }

  function applyOne(baseText, anchor, revised) {
    const paras = paragraphsOf(baseText);
    const at = locateParagraph(paras, anchor);
    if (at < 0) return null;
    const next = paras.slice();
    if (revised) next[at] = revised; else next.splice(at, 1);
    // 段号：改后段落所在的位置；整段删除时是"后一段顶上来的位置"。
    const paraIndex = revised ? at : at;
    return { text: next.join('\n\n'), paraIndex };
  }

  // ── 门禁入口 ────────────────────────────────────────────────────────────────

  /**
   * 底稿里**本来就存在**的事实锁冲突（按底稿文本缓存）。
   * 用途：gatePatches 只拦"这条补丁新制造出来的"矛盾；底稿自带的矛盾由诊断层报给作者，
   * 否则一处历史遗留会让此后每一条补丁都被拦死（把门禁变成不可用状态）。
   */
  const LOCK_CACHE = new Map();
  function baseLockFacts(baseText, opts = {}) {
    const key = String(baseText == null ? '' : baseText);
    if (!LOCK_CACHE.has(key)) {
      LOCK_CACHE.set(key, scanFactLock(key, opts).filter((f) => f.code === 'fact_lock_conflict'));
      // 简单上限：门禁在一章内被调用很多次，但底稿文本只会有少数几版；防止长时间会话里无限增长。
      if (LOCK_CACHE.size > 8) LOCK_CACHE.delete(LOCK_CACHE.keys().next().value);
    }
    return LOCK_CACHE.get(key);
  }

  /** 章内"有主人"的编号值（改前/改后各自算一份）：值 → 出现过的段号。 */
  function lockedValues(text, opts = {}) {
    const map = new Map();
    for (const c of scanFactCandidates(text, opts)) {
      if (!c.value || !c.owner) continue;
      const arr = map.get(c.value) || [];
      if (!arr.includes(c.paragraph)) arr.push(c.paragraph);
      map.set(c.value, arr);
    }
    return map;
  }

  /**
   * 逐条裁决整批补丁。
   * @returns {{allowed: Array, allowedMeta: Array, blocked: Array, findings: Array}}
   *   allowed  可自动应用的补丁（原样传回，交给 applyRevisionPatches 定位与写回）
   *   blocked  被拦下的补丁 + 原因 + 粒度（**不进差异稿**，界面必须单列给作者）
   *   findings 不拦但需要告知的结构断裂（causal_bridge_break 等）
   */
  function gatePatches(baseText, patches, opts = {}) {
    const base = String(baseText == null ? '' : baseText);
    const list = Array.isArray(patches) ? patches : [];
    const protectedList = (Array.isArray(opts.protectedContent) ? opts.protectedContent : []).map(String).filter(Boolean);
    const allowed = [];
    const allowedMeta = [];
    const blocked = [];
    const findings = [];

    list.forEach((p, index) => {
      const anchor = String((p && p.anchor) || '').trim();
      const revised = String((p && p.revised) || '').trim();
      const issue = Number(p && p.issue) || 0;
      const scopeOf = classifyEditScope(anchor, revised, { ...opts, baseText: base });

      // ① 作者指定的保护句：改前有、改后没了 → 拦（逐字子串判据，零误报）。
      const hitProtected = protectedList.find((s) => anchor.includes(s) && !revised.includes(s));
      if (hitProtected) {
        blocked.push({ index, issue, anchor, revised, scope: scopeOf.scope, code: 'protected_content', reason: `命中保护句（作者指定不得改写）：「${hitProtected.slice(0, 40)}」` });
        return;
      }

      // ② 正式事实（文档 §9 Level 3）：禁止自动应用，只作为建议。
      if (scopeOf.scope === SCOPE.STORY_FACT) {
        const evidence = scopeOf.signals.map((s) => `${s.code}(${s.evidence})`).join('、');
        blocked.push({ index, issue, anchor, revised, scope: scopeOf.scope, code: 'story_fact', signals: scopeOf.signals, reason: `这条改动引入了本章尚未出现的正式事实（${evidence}）：按安全策略不自动应用，只作为建议列出` });
        return;
      }

      // ③ 删除依赖：在这条补丁**单独应用后**的文本上判定。
      const after = applyOne(base, anchor, revised);
      if (!after) { allowed.push(p); allowedMeta.push({ index, issue, scope: scopeOf.scope, risks: [] }); return; }
      const risks = deletionRisks(after.text, anchor, revised, after.paraIndex, opts);
      // ③b 转场桥（v1.1.0）：与 scene_anchor 同一后果、不同证据（认外景，不认词表）。
      //     只报告：它能发现真事故，但"删场景词 + 后文有外景词"在蒙太奇/多线切换里可能是合法的。
      risks.push(...sceneBridgeRisks(after.text, anchor, revised, after.paraIndex, opts));
      // ③c 事实锁（v1.1.0 → HARD_CODES）：这条补丁**制造了**新的编号矛盾。
      //     ⚠️ 判据是"冲突集合是否新增"而不是"after 里有没有冲突" —— 底稿里本来就存在的矛盾
      //     （例如作者已经在处理一处历史遗留）不能让此后每一条补丁都被拦死。
      const lockAfter = scanFactLock(after.text, opts).filter((f) => f.code === 'fact_lock_conflict');
      const lockBefore = baseLockFacts(base, opts);
      const newLock = lockAfter.find((f) => !lockBefore.some((b) => b.value === f.value && b.reason === f.reason));
      if (newLock) {
        const hardRisks = [...risks, newLock];
        blocked.push({
          index, issue, anchor, revised, scope: scopeOf.scope, code: 'fact_lock_conflict',
          reason: newLock.reason,
          conflict: newLock.conflict,
          risks: hardRisks,
        });
        return;
      }
      // ③d 事实锁（改错这一半，2026-10-08）：这条补丁让一个**有主人的编号**从章内整体消失。
      //
      //     为什么必须单独一条：上面 ③c 只认"章内同时出现两个值"的矛盾，而作者复核稿里那次是
      //     **单点改名**（`…是1738` → `…是1736`，章内 1738 只剩这一处）——改完之后章内只有一个值，
      //     矛盾形态根本不存在，可它正是最典型的一次事实被改错。判据因此改成"改前有主人、改后整体没了"。
      //     只对有主人的值生效：没有主人名时无法区分"作者有意删掉一段"与"改错了号"。
      const beforeLocked = lockedValues(base, opts);
      if (beforeLocked.size) {
        const afterLocked = lockedValues(after.text, opts);
        for (const [value, parasAt] of beforeLocked) {
          if (afterLocked.has(value)) continue;
          blocked.push({
            index, issue, anchor, revised, scope: scopeOf.scope, code: 'fact_lock_conflict',
            reason: `这条改动让本章登记过的编号「${value}」整体消失（它原本出现在第 ${parasAt.map((n) => n + 1).join('、')} 段）：`
              + '编号属于既有事实，改成别的数字会让后文对不上；确需改号请直接手改正文并核对全章引用。',
            conflict: `改前第 ${parasAt.map((n) => n + 1).join('、')} 段「${value}」→ 改后章内已无此编号`,
            risks,
          });
          return;
        }
      }
      const hard = risks.filter((r) => HARD_CODES.includes(r.code));
      if (hard.length) {
        blocked.push({ index, issue, anchor, revised, scope: scopeOf.scope, code: hard[0].code, reason: hard[0].reason, risks });
        return;
      }
      for (const r of risks) findings.push({ index, issue, ...r });
      allowed.push(p);
      allowedMeta.push({ index, issue, scope: scopeOf.scope, risks });
    });

    return { allowed, allowedMeta, blocked, findings };
  }

  /**
   * Diff-aware 修后核验（文档 §12）：对**已经落定的新文**再扫一遍
   * "被删掉的段落里，有哪些东西是后文还在用的"。
   * 与门禁的分工：门禁决定"能不能自动应用"，这里回答"这一版里还剩哪些断裂"——
   * 被门禁拦下的补丁不在新文里，因此两者不会重复报同一处。
   */
  function verifyPatchedText(originalText, patchedText, opts = {}) {
    const before = paragraphsOf(originalText);
    const after = paragraphsOf(patchedText);
    const remaining = new Map();
    for (const p of after) remaining.set(p, (remaining.get(p) || 0) + 1);
    const deleted = [];
    let cursor = 0;
    for (const p of before) {
      if (after[cursor] === p) { cursor += 1; remaining.set(p, remaining.get(p) - 1); continue; }
      if ((remaining.get(p) || 0) > 0) { remaining.set(p, remaining.get(p) - 1); continue; }
      deleted.push({ text: p, index: cursor });
    }
    const findings = [];
    for (const d of deleted) findings.push(...deletionRisks(patchedText, d.text, '', d.index, opts));
    // v1.1.0：整段删除形态（`revised` 为空）也要走一遍转场桥判据。
    // 为什么必须显式加：`deletionRisks` 里的 scene_anchor 用的是**词表**（大屏/画面/切到），
    // 它能发现"转场句被删"，但只有在段号恰好落在新文的承接段上时才报得出后果；
    // 而删段时两侧段号会错开一位（旧实现因此在这条路径上静默，2026-10-08 由前端断言 118j 抓到）。
    // 逐条粒度不变：这里只补一条 finding，不改变任何 blocked 判定。
    for (const d of deleted) findings.push(...sceneBridgeRisks(patchedText, d.text, '', d.index, opts));
    // v1.1.0：整章重写兜底路径没有补丁可过门禁（buildAIRevisionPrompt → revision_full），
    // 所以"这一版整体"的三类问题只能在修后核验里报：
    //   ① 事实锁冲突（改错编号）——同一判据在补丁路径是硬拦，在这里只能报告（整章重写已经写完了，
    //      能做的是把冲突指出来让作者决定，而不是假装没看见）；
    //   ② 百分比合计不为 100%；
    //   ③ 同一句跨 3 段以上逐字重复（成稿前最后一道自检）。
    const lockBefore = baseLockFacts(originalText, opts);
    for (const f of scanFactLock(patchedText, opts)) {
      if (f.code !== 'fact_lock_conflict') { findings.push(f); continue; }
      if (lockBefore.some((b) => b.value === f.value && b.reason === f.reason)) continue;
      findings.push({ ...f, blocked: true });
    }
    findings.push(...scanCrossParagraphDuplicates(patchedText));
    return {
      deleted: deleted.map((d) => d.text),
      findings,
      summary: { deleted: deleted.length, findings: findings.length },
    };
  }

  return {
    VERSION,
    SCOPE,
    HARD_CODES,
    REASON_TEXT,
    paragraphsOf,
    contentTokens,
    classifyEditScope,
    classifyObjectUse,
    deletionRisks,
    informationTruncationRisks,
    gatePatches,
    verifyPatchedText,
    // v1.1.0 新增：三项第四批判据（前两项被 verifyPatchedText 与 gatePatches 使用；
    // 导出是为了让离线测试能**单独**验它们，而不是只能通过整条链路间接观察）。
    scanFactLock,
    scanFactCandidates,
    scanCrossParagraphDuplicates,
    sceneBridgeRisks,
    normalizeSentence,
    // 内部小函数也导出：离线测试要能**单独**验它们（"实体名候选剥对没有"这类缺陷
    // 只通过整条链路观察会被其他分支掩盖——2026-10-08 探针就吃了这个亏）。
    labelFromWindow,
    hasSubject,
    nearestName,
    cnNumber,
    collectPercents,
    // 2026-10-12（0731 增补方案 §3）：概率**候选**单独导出 —— 离线测试要能验"按等级去重"这一步，
    // 只从 collectPercents 的数值数组看，分不清"去重了"与"根本没抽到"。
    collectPercentClaims,
    // §3 的"资格判定"也导出：它决定"要不要判 100%"，是本次收紧的核心，必须能被单独断言。
    distributionEvidence,
    // 2026-03-17（v118 0317 专项）：本批新增的四项判据全部单独导出 ——
    // 它们分别只在一个窄场景里生效（新制度流程 / 时间因果桥 / 同物件状态 / 伏笔锚可见性），
    // 只从 gatePatches 的 blocked 列表看，分不清"没命中"与"根本没接上"，必须能单独断言。
    workflowRuleCandidates,
    assessTemporalBridge,
    propStateCandidates,
    anchorStatus,
  };
});
