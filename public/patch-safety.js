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

  const VERSION = '1.0.0';

  /** 改动粒度（文档 §9）：只有 story_fact 会被拦，local_structure 过门禁后照常应用。 */
  const SCOPE = { WORDING: 'wording', LOCAL_STRUCTURE: 'local_structure', STORY_FACT: 'story_fact' };

  /** 门禁结论码。`object_provenance / reference_anchor / scene_anchor / story_fact / protected_content`
   *  是**硬拦**；`causal_bridge_break` 只报告（原因是"因为"型连接词太常见，硬拦会误伤正常压缩）。 */
  const HARD_CODES = ['protected_content', 'story_fact', 'object_provenance', 'reference_anchor', 'scene_anchor'];
  const REASON_TEXT = {
    protected_content: '命中作者指定的保护句',
    story_fact: '引入了本章尚未出现的正式事实',
    object_provenance: '删掉了后文仍在使用的物件来源',
    reference_anchor: '删掉了后文代词的先行语',
    scene_anchor: '删掉了场景/视点锚点',
    causal_bridge_break: '删掉了后文仍在承接的原因',
    safety_unavailable: '安全门禁不可用（本次未拦截任何补丁）',
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

  /**
   * 这条补丁属于哪个粒度？
   *   wording         纯表达（压缩、换词），不动事件/人物/物件/地点/时间/因果 → 自动应用
   *   local_structure 合并反应、压缩重复、调整局部段落 → 过安全门禁后应用
   *   story_fact      新增事件/制度、改等级/时间线/关系 → **禁止自动应用，只输出建议**
   *
   * story_fact 判据刻意窄：只有"本章此前从未出现过的正式事实形态"才算
   * （等级 / 地名机构 / 拉丁编号区 / 编号日期 / 新人物名），并且必须能指出证据原文。
   * 这样"把检测台改写成检测中心"这类同义改写不会被误判成新事实。
   */
  function classifyEditScope(anchor, revised, opts = {}) {
    const a = String(anchor == null ? '' : anchor);
    const r = String(revised == null ? '' : revised);
    const base = String(opts.baseText == null ? a : opts.baseText);
    const signals = [];
    const isNew = (tok) => tok && !base.includes(tok);

    const grade = newMatches(GRADE_RE, a, r).find(isNew);
    if (grade) signals.push({ code: 'new_grade', evidence: grade });
    const inst = newMatches(INSTITUTION_RE, a, r).find(isNew);
    if (inst) signals.push({ code: 'new_institution', evidence: inst });
    const zone = newMatches(LATIN_ZONE_RE, a, r).find(isNew);
    if (zone) signals.push({ code: 'new_zone', evidence: zone });
    const num = newMatches(NUMBER_FACT_RE, a, r).find(isNew);
    if (num) signals.push({ code: 'new_number', evidence: num });
    const who = (Array.isArray(opts.characters) ? opts.characters : []).map(String).filter(Boolean)
      .find((n) => r.includes(n) && !a.includes(n) && isNew(n));
    if (who) signals.push({ code: 'new_character', evidence: who });
    // 事实增量过大：改后段落比改前长出一倍以上且多出 60 字以上（B 区式"顺手新增支线"的形状）
    if (r.length > a.length * 2 && r.length - a.length >= 60) signals.push({ code: 'expansion', evidence: `${a.length}→${r.length} 字` });

    if (signals.length) return { scope: SCOPE.STORY_FACT, signals };
    if (r.length <= a.length * 0.95) {
      // 压缩里只有两种：删掉的只是描写（纯表达 = wording），或删掉了带动作/对白/主体的句子（= local_structure）。
      return isPureWording(a, r)
        ? { scope: SCOPE.WORDING, signals: [{ code: 'descriptive_compression', evidence: `${a.length}→${r.length} 字` }] }
        : { scope: SCOPE.LOCAL_STRUCTURE, signals: [{ code: 'compression', evidence: `${a.length}→${r.length} 字` }] };
    }
    return { scope: SCOPE.WORDING, signals: [] };
  }

  // ── 单条补丁单独应用（只用于"如果只有这一条，后文还成立吗"） ──────────────────

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
    gatePatches,
    verifyPatchedText,
  };
});
