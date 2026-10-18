/*
 * 世界观词条「强弱约束」（revision-canon-strength）—— 纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要区分强弱（v1.2.4 方案 §2.3 / §5.3 / §7.3 / P1）：
 *   两轮真实稿里"词条冲突"其实有两种完全不同的东西：
 *     · **硬约束**：等级体系、职业方向、纪年、身份——违反就是设定崩了，必须交作者裁决
 *       （A-02「职业方向栏写成基础战斗能力」、A-03「D 级评价两种口径」、B-07「缺 3751 纪年」）；
 *     · **弱约束**：用词偏好、称呼习惯、风格倾向——违反只该给作者"建议核对"，不该拦下修稿
 *       （否则每一次都变成"蓝图冲突"，作者会被迫在无关紧要的地方做裁决）。
 *   旧实现把两类都塞进 `canonConflict` 一个布尔值：要么全都拦，要么全都不拦。
 *
 * 本模块只做**分类**，不做语义判断：分类依据是可核对的结构事实（显式 strength 字段 >
 * 词条 kind/title 的设定类关键词 > 默认弱约束），并如实返回 `basis` 让人能复核。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionCanonStrength = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';

  /** 硬约束的设定类关键词：命中即"违反会破坏设定一致性"，需要作者裁决。 */
  const HARD_PATTERN = /等级|等级体系|评级|职业|身份|纪年|年号|历法|规则|制度|禁令|权限|能力|属性|货币|门派|序列|品阶/;
  /** 弱约束关键词：命中即"风格/称呼/偏好"，只给建议。 */
  const SOFT_PATTERN = /风格|文风|语气|称呼|习惯|偏好|口味|口头禅|用词/;

  const textOf = (x) => String(x == null ? '' : x);

  /**
   * 分类一个词条的约束强度。
   * @returns {{strength:'hard'|'soft'|'unknown', basis:string, reason:string}}
   */
  function classifyEntryStrength(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    // ① 显式字段优先（作者/导入可以标）
    const explicit = textOf(e.strength || e.constraint_strength || '').toLowerCase();
    if (explicit === 'hard' || explicit === 'soft') {
      return { strength: explicit, basis: 'explicit', reason: `词条显式声明 strength=${explicit}` };
    }
    // ② 结构事实：is_pinned（作者钉住的核心设定）
    if (Number(e.is_pinned) === 1) {
      return { strength: 'hard', basis: 'pinned', reason: '词条被作者钉住（is_pinned=1）：属于不可随意改动的核心设定' };
    }
    // ③ 关键词：先硬后软（"等级"与"风格"同时出现时按硬处理，方向偏保守）
    const hay = [textOf(e.title), textOf(e.kind || e.kind_name), textOf(e.keywords), textOf(e.content).slice(0, 200)].join(' ');
    if (HARD_PATTERN.test(hay)) {
      return { strength: 'hard', basis: 'keyword-hard', reason: `词条标题/类型/关键词命中设定类判据：${(hay.match(HARD_PATTERN) || [''])[0]}` };
    }
    if (SOFT_PATTERN.test(hay)) {
      return { strength: 'soft', basis: 'keyword-soft', reason: `词条属于风格/偏好类：${(hay.match(SOFT_PATTERN) || [''])[0]}` };
    }
    // ④ 两条都不命中：**不知道**，不猜
    return { strength: 'unknown', basis: 'no-evidence', reason: '词条没有可核对的强弱依据（既非显式声明、也非设定类关键词）' };
  }

  /**
   * 为一条审稿问题找到它引用的权威词条。
   *
   * 匹配方式是**逐字**的两种：
   *   ① 词条标题出现在问题文本里（最强证据）；
   *   ② 词条的 `keywords` 里某个 ≥2 字的词出现在问题文本里（审稿通常不会照抄词条标题，
   *      但会写"D 级""晋升规则"这类关键词）。
   * 为什么不做语义相似匹配：这里要的是**可核对**——匹配不到就返回 null，
   * 由调用方按 `NEED_CONTEXT` 处理（方案 A-03：「缺权威词条则 NEED_CONTEXT」）。
   *
   * @param {object} finding 结构化 finding（title/explanation/evidence[].quote）
   * @param {Array} entries state.worldEntries
   * @returns {{entry:object, strength:object, matched_by:string, needle:string}|null}
   */
  function matchEntry(finding, entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return null;
    const hay = [
      textOf(finding && finding.title),
      textOf(finding && finding.explanation),
      ...((finding && Array.isArray(finding.evidence) ? finding.evidence : []).map((e) => textOf(e && e.quote))),
    ].join('\n');
    let best = null;
    const consider = (entry, needle, by) => {
      if (!needle) return;
      // 命中更长的词条优先；长度相同按 is_pinned / priority 兜底，保证结果确定。
      const score = [needle.length, Number(entry.is_pinned) === 1 ? 1 : 0, Number(entry.priority) || 0];
      if (!best) { best = { entry, strength: classifyEntryStrength(entry), matched_by: by, needle, score }; return; }
      const cmp = score[0] - best.score[0]
        || score[1] - best.score[1]
        || score[2] - best.score[2];
      if (cmp > 0) best = { entry, strength: classifyEntryStrength(entry), matched_by: by, needle, score };
    };
    for (const e of list) {
      const title = textOf(e && e.title).trim();
      // 单字标题会到处误命中，不参与匹配
      if (title.length >= 2 && hay.includes(title)) consider(e, title, 'title-verbatim');
      // ⚠️ 关键词分隔符**不能含空格**：`D 级` 这种带空格的词条关键词会被空格切成
      // `D` / `级` 两个单字，而单字被长度过滤丢弃 → 整条词条匹配不上（实测踩过）。
      const kws = textOf(e && e.keywords).split(/[,，;；|/]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
      for (const kw of kws) if (hay.includes(kw)) consider(e, kw, 'keyword-verbatim');
    }
    return best ? { entry: best.entry, strength: best.strength, matched_by: best.matched_by, needle: best.needle } : null;
  }

  /**
   * 批量归因：给每条 finding 算出"强弱 + 是否需要作者裁决"。
   *
   * 判定规则（写死，便于复核）：
   *   · 匹配到 hard 词条 且 finding.type === 'canon_conflict' → `conflictIds`（交作者裁决）
   *   · 匹配到 hard 词条 但 finding 不是 canon_conflict → 只在 `strengthByIssue` 记录强度（不拦）
   *   · 匹配到 soft / unknown → 只在 `strengthByIssue` 记录（违反只作建议）
   *   · 完全匹配不到词条 → `unmatched`（调用方据此给 NEED_CONTEXT，不擅自判冲突）
   *
   * @returns {{conflictIds:string[], strengthByIssue:object, unmatched:string[], matched:object}}
   */
  function resolveCanon(findingList, entries) {
    const list = Array.isArray(findingList) ? findingList : [];
    const conflictIds = [];
    const strengthByIssue = {};
    const unmatched = [];
    const matched = {};
    for (const f of list) {
      const id = textOf(f && f.id);
      if (!id) continue;
      const hit = matchEntry(f, entries);
      if (!hit) {
        unmatched.push(id);
        strengthByIssue[id] = { strength: 'unknown', basis: 'no-entry', reason: '没有匹配到权威词条' };
        continue;
      }
      strengthByIssue[id] = { strength: hit.strength.strength, basis: hit.strength.basis, reason: hit.strength.reason, entry_id: hit.entry.id, entry_title: textOf(hit.entry.title) };
      matched[id] = { entry_id: hit.entry.id, title: textOf(hit.entry.title), strength: hit.strength.strength };
      if (hit.strength.strength === 'hard' && textOf(f.type) === 'canon_conflict') conflictIds.push(id);
    }
    return { conflictIds, strengthByIssue, unmatched, matched };
  }

  /**
   * 词条版本归因：finding 记录了它引用的是哪一版时，与当前版本比对。
   * 版本不一致**不是**"冲突结论"，而是"按旧版判的，得先看新版"——因此只作为可解释事实返回。
   */
  function resolveEntryVersions(findingList, entries) {
    const out = {};
    for (const f of Array.isArray(findingList) ? findingList : []) {
      const id = textOf(f && f.id);
      if (!id) continue;
      const hit = matchEntry(f, entries);
      if (!hit) continue;
      const current = Number(hit.entry.version);
      const referenced = f.entry_version != null ? Number(f.entry_version) : (Number.isFinite(current) ? current : null);
      if (!Number.isFinite(current) || referenced == null || !Number.isFinite(referenced)) continue;
      out[id] = { entry_id: hit.entry.id, referenced_version: referenced, current_version: current };
    }
    return out;
  }

  return { VERSION, classifyEntryStrength, matchEntry, resolveCanon, resolveEntryVersions, HARD_PATTERN, SOFT_PATTERN };
});
