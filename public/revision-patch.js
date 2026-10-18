/*
 * 局部补丁协议 v2（Revision Patch v2）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要它（2026-10-08，《叙事性专项修复》E01／P0）：**当时的**现有链路有四个真实缺陷，
 * 每一个都会把"只改被点名的几处"变成"改坏正文"或"多花一次钱"：
 *   ① **删不掉**：`applyRevisionPatches` 把「改后内容为空」一律判成 unresolved，
 *      于是"然后她不一样了。"这种整段删除只能靠换一句同样多余的旁白来绕开。
 *   ② **坏元素被折叠成"合法空补丁"**：`{"patches":[{}]}` 在旧实现里被逐条丢掉后返回 `[]`，
 *      而 `[]` 是合法 noop —— 界面于是显示"模型判断没有需要改动"，把一次解析事故说成结论。
 *   ③ **少量定位授权整段替换**：`anchor` 落在某段内部时，旧实现直接替换**整段**，
 *      与"只授权这一句"的授权范围不一致（P06）。
 *   ④ **失败扩大为整章重写**：解析失败/全部未命中都会回退整章重写（一次付费、且没有门禁的整章覆盖）。
 *      —— **该行为已在本模块落地时移除**：现在失败一律终态拒绝（见 ERROR_CODES 的说明与
 *      `status_note` 里的"未回退整章重写"），整章重写只能由作者在界面里主动选。
 *
 * 本模块只做**确定性**的那一半：严格解码 → 跨度校验 → 分组原子化 → 精确定位 → 写回 → 组合核验。
 * 它不调用模型、不产生费用、同一输入同一输出。语义判断（"这句该不该改"）仍在审稿/修稿侧。
 *
 * 与 public/patch-safety.js 的分工：
 *   · patch-safety 回答"这条改动**该不该自动应用**"（逐条：物件来源/先行语/场景锚点/事实锁）；
 *   · 本模块回答"这条改动**能不能被精确执行**"，并负责把**组合后**的候选再交给 patch-safety 核验
 *     （两条单独安全的删除，合起来可能删光先行语——P08）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionPatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  /** 协议版本。字段/语义变更必须递增，便于把"检查结果"绑到具体协议版本。 */
  const VERSION = '2.0.0';
  const SCHEMA_VERSION = 2;
  /** 正文快照的口径版本：normalization_version=raw_v1 表示"不 trim、不丢空行、不归一标点"。 */
  const NORMALIZATION_VERSION = 'raw_v1';
  /** 单个字符串字段的上限：超过即 schema_error，而不是先 String(...) 再当正文。 */
  const MAX_VALUE_CHARS = 20000;
  const MAX_PATCHES = 200;

  /** 失败码（§6.6）。任何一个都属于"不扩大范围、不自动整章重写"的终态，由调用方如实展示。 */
  const ERROR_CODES = {
    PARSE_ERROR: 'parse_error',
    SCHEMA_ERROR: 'schema_error',
    ANCHOR_MISMATCH: 'anchor_mismatch',
    AMBIGUOUS_ANCHOR: 'ambiguous_anchor',
    OVERLAP: 'overlap',
    OUT_OF_SCOPE: 'out_of_scope',
    SELECTION_MISMATCH: 'selection_mismatch',
    STALE: 'stale',
    SAFETY_BLOCKED: 'safety_blocked',
    SAFETY_UNAVAILABLE: 'safety_unavailable',
    /**
     * 2026-10-13（T33，《0731 增补方案》§2 P0-A）：理由与它声称处理的问题对不上。
     *
     * 事故形态（R06）：#6 号码纸动作的补丁，理由却写的是 #9 深海母神角色卡的时点。
     * 原实现把补丁带的理由原样当成"已改理由"渲染，作者会据此相信一个错误的因果说明 ——
     * 比没有理由更糟，因为它看起来可信。
     *
     * 注意：这不是"补丁被拒"的终态，而是**该理由不得显示为可信依据**的标记。
     * 补丁本身照常按跨度与 ops 校验应用（理由错配 ≠ 改错了地方）。
     */
    REASON_UNVERIFIED: 'reason_unverified',
    UNSUPPORTED_MAPPING: 'unsupported_mapping',
    BUDGET_EXHAUSTED: 'budget_exhausted',
    CANCELLED: 'cancelled',
    /** 新任务（expected_schema_version:2）收到旧格式响应：格式不兼容，不按旧语义应用（K4/E01-D）。 */
    INCOMPATIBLE_LEGACY: 'incompatible_legacy_format',
    /**
     * 期望 v2 语义却**没有拿到 Host 授权表**：第②重授权（"这个 issue 有权改这个跨度吗"）无从校验。
     * 2026-10-11（S05-1 / §6.3 双重授权）：旧实现在这种输入下**静默降级**成弱校验——只查
     * "issue 是否属于本次已选"，然后照常把补丁应用掉。这与"必须双重授权"的契约相反，且属 fail-open
     * （审计状态缺失时朝"放行"方向出错）。现在改为 fail-closed，正文一个字符都不动。
     */
    AUTHORIZATION_REQUIRED: 'authorization_required',
    /**
     * 2026-10-13（P0-B 第三重授权）：跨度与逐字原文都对了，但**这个 op 不在该条授权里**。
     *
     * 为什么需要独立的码：授权表一直带着 `ops` 字段（`08-authorization.test.mjs:51` 就在传
     * `ops:['replace','delete']`），可引擎**从未读过它** —— 于是"授权了这个跨度"被悄悄
     * 放大成"这个跨度上想做什么都行"。`delete` 落到只授权 `replace` 的跨度上就是这种放大。
     * 归到 out_of_scope 会丢失"哪一重授权没过"的信息，作者无法区分
     * "你改的不是我批的那段"与"我批了这段、但没批这种改法"。
     */
    OP_NOT_AUTHORIZED: 'op_not_authorized',
  };

  /**
   * 从一段文字里取出它**显式引用**的 issue 编号（2026-10-13，T33）。
   *
   * 只认带编号标记的两种写法：`#6`、`问题6`。为什么必须带标记：
   *   正文与理由里到处都是数字（"改了 2 处""第 3 句"），裸数字会把正常理由判成错配，
   *   而这条判据的代价是"作者看到一个不可信的理由"，误报会直接损害可信度。
   *
   * 为什么不用全局正则字面量：`/g` 的 `lastIndex` 会在多次调用之间残留，
   *   导致**偶发漏检**（本文件第三次踩"有状态正则"的坑，见 gradeBefore 的 match 事件）。
   */
  function referencedIssueIds(text) {
    const ids = new Set();
    const re = /(?:\uFF03|#)\s*([0-9A-Za-z\u4e00-\u9fa5_-]{1,12})|\u95ee\u9898\s*([0-9A-Za-z\u4e00-\u9fa5_-]{1,12})/g;
    let m = re.exec(String(text == null ? '' : text));
    while (m) {
      ids.add(String(m[1] || m[2]));
      m = re.exec(String(text == null ? '' : text));
    }
    return ids;
  }

  /**
   * 判定一条理由是否与它声称处理的问题对不上（T33）。
   *
   * 只做**可判定的那一半**：理由里显式引用的编号不属于本补丁/本处置的 issue 集合时，
   * 该理由不得显示为可信依据。不做语义相似度判断 —— 那既不可离线断言，
   * 也会把"模型用了不同措辞"误判成错配。
   *
   * @returns {{ok:boolean, foreign:string[]}} foreign = 被引用的、不属于本 issue 集合的编号
   */
  function checkReasonBinding(reason, ownIssueIds) {
    const text = String(reason == null ? '' : reason).trim();
    if (!text) return { ok: true, foreign: [] };
    const own = new Set((ownIssueIds || []).map((x) => String(x)));
    const foreign = [...referencedIssueIds(text)].filter((id) => !own.has(id));
    return { ok: foreign.length === 0, foreign };
  }

  /**
   * 修后核验：`issue_coverage` 候选（《0731 增补方案》§4）。
   *
   * 覆盖表说某个问题 `patched` / `partially_resolved`，但它当初的**逐字证据**在修后正文里
   * 仍然原样存在 —— 这时"已解决"这个结论站不住，必须作为**候选**如实列出。
   * 这正是方案里 R05 的形态（"假装没看见"改成"没人再看他"之后，陌生人那句通用安慰仍在）。
   *
   * 为什么是候选而不是阻断：证据句可能被**有意**保留（改了别处，或那句话本身还承载别的功能）。
   * 判据只做可判定的那一半（逐字仍在 / 已不在），不做语义相似度 —— 与 reason_unverified 同一口径。
   *
   * 为什么设最小长度：短句（"嗯。""好。"）在章内反复出现属正常节奏，
   * 拿它当"问题仍在"的证据会持续误报；而误报的代价是作者不再看这份清单。
   * 4 字是实测定的下限：R05 的真实证据句「假装没看见」是 5 字，必须保留；
   * 而"嗯。""他不知道。"（2–5 字的应答/常规叙述）不该触发。第一版设 6 字，
   * 结果把 5 字的真实证据一起滤掉了（由 IC-a 断言当场抓到）。
   */
  const MIN_COVERAGE_QUOTE_CHARS = 4;
  /**
   * 该条问题是否被作者**选中**？未选中的问题既不评"已改"、也不评"改失败"（V118-11）。
   * `selectedIssues` 缺省时返回 null（未提供勾选集合 ≠ 未选中）。
   */
  function selectionOf(issueId, item, selectedIssues) {
    if (item && item.selected === false) return false;
    if (!Array.isArray(selectedIssues)) return null;
    return selectedIssues.some((x) => String(x && typeof x === 'object' ? x.id : x) === String(issueId));
  }

  function issueCoverageCandidates({ issues, coverage, revisedText, selectedIssues } = {}) {
    const text = String(revisedText == null ? '' : revisedText);
    const cov = new Map((Array.isArray(coverage) ? coverage : []).map((c) => [String(c && c.issue_id), c]));
    const candidates = [];
    const unaccounted = [];
    for (const item of (Array.isArray(issues) ? issues : [])) {
      const id = String(item && item.id != null ? item.id : '');
      if (!id) continue;
      const c = cov.get(id);
      const selected = selectionOf(id, item, selectedIssues);
      /*
       * 2026-03-17（v118 0317 专项 §4/§6 · V118-11）：未选中/未处置的问题必须显式入账。
       *
       * 事故形态：作者这一轮**没有勾选** R04/R05，报告却把"没有变化"读成"修稿失败"；
       * 反过来，旧实现在"没有覆盖记录"时直接 `continue`，于是未选中项**凭空消失** ——
       * 作者既看不到"这两条我没有选"，也看不到"它们没有被处理"。
       * 现在：只要选中状态为"未选中"，或覆盖状态是 unaccounted/缺失，就进 unaccounted，
       * 并明确标 disposition/selection_status，供界面渲染成"未选中"而不是"已改"或"失败"。
       */
      if (selected === false || !c || c.status === 'unaccounted') {
        unaccounted.push({
          issue_id: id,
          disposition: selected === false ? 'not_selected' : 'unaccounted',
          selection_status: selected === false ? 'not_selected' : (selected === null ? 'selection_unspecified' : 'selected'),
          status: c ? String(c.status || '') : 'no_coverage_record',
          note: selected === false
            ? '作者本轮未勾选这一条：既不算"已改"，也不算"修改失败"（N/A），不产生任何修稿结论'
            : '这一条没有处置记录：不得据此声称它已解决或已改',
        });
        continue;
      }
      if (c.status !== 'patched' && c.status !== 'partially_resolved') continue;
      const quotes = (Array.isArray(item.quotes) ? item.quotes : [item.quote])
        .map((q) => String(q == null ? '' : q).trim())
        .filter((q) => q.length >= MIN_COVERAGE_QUOTE_CHARS);
      const still = quotes.filter((q) => text.includes(q));
      if (!still.length) continue;
      candidates.push({
        issue_id: id,
        status: c.status,
        quote: still[0],
        still_present: still.length,
        // ⚠️ 这里**不是**"确定性层已经判定问题解决"，而是"覆盖表声明已处理"。
        //    两者必须分开读（§4）：claimed_resolved 只转述处置状态，最终结论要过 coverageVerdict。
        claimed_resolved: c.status === 'patched',
        note: `本条声称已处理（${c.status}），但它当初的逐字证据在修后正文里仍原样存在`
          + `${still.length > 1 ? `（共 ${still.length} 处）` : ''}：请确认这一条是否真的解决了。`,
      });
    }
    return { candidates, count: candidates.length, unaccounted, unaccounted_count: unaccounted.length };
  }

  /**
   * 修后核验的**结论闸**（2026-03-17，v118 0317 专项 §4 · V118-12）。
   *
   * 本节最重要的一句话（写进代码以免漂回去）：
   *   **旧引文从正文里消失 ≠ 问题被解决。**
   *
   * R01 的新时间句 original 消失了，而"为什么两人测完却没走"的因果缺口仍在；
   * R07 去掉了"二十米"，而"再挪两步就能看见"与"几十个人遮挡"的空间关系并未得到证明。
   * 确定性层只能证明"这段字还在不在"，它**没有**语义判断力。因此：
   *   · 语义未跑（默认）→ `semantic_status:'not_run'`，状态最多 `partially_resolved`，**永不 resolved**；
   *   · 语义跑了但明确失败 → `needs_review`，同样不给 resolved；
   *   · 只有语义层**明确跑过并判定通过**，且证据已消失，才允许 `resolved`。
   *
   * 这不是"永远不许 resolved"：它只是要求 resolved 必须有**来自语义层**的证据，
   * 而不是由"补丁存在 / 旧引文不见"倒推出来。
   */
  function coverageVerdict({ semantic, stillPresent = 0, covered = false } = {}) {
    const sem = semantic && typeof semantic === 'object' ? semantic : null;
    const semStatus = !sem ? 'not_run' : (sem.status == null ? 'not_run' : String(sem.status));
    const still = Number(stillPresent) || 0;
    if (semStatus === 'not_run') {
      return {
        status: still > 0 ? 'partially_resolved' : 'needs_review',
        semantic_status: 'not_run',
        reason: still > 0
          ? '这条问题当初的逐字证据在修后正文里仍原样存在：不可能是 resolved'
          : '旧引文已消失，但语义核验未运行 —— 确定性层不证明"问题已解决"，因此不报 resolved',
      };
    }
    if (semStatus !== 'pass' && semStatus !== 'passed' && semStatus !== 'ok') {
      return {
        status: 'needs_review',
        semantic_status: semStatus,
        reason: `语义核验状态为 ${semStatus}：未给出通过结论，不得据此报 resolved`,
      };
    }
    if (still > 0) {
      return { status: 'partially_resolved', semantic_status: semStatus, reason: '语义层通过，但其逐字证据仍在正文里：至多 partially_resolved' };
    }
    if (!covered) {
      return { status: 'needs_review', semantic_status: semStatus, reason: '缺少"已被处理"的覆盖记录：不得报 resolved' };
    }
    return { status: 'resolved', semantic_status: semStatus, reason: '证据已消失且语义层明确判定通过：允许 resolved' };
  }

  // ── 一、严格 JSON ──────────────────────────────────────────────────────────
  /**
   * 严格 JSON 解析器（只解析，不做容错）：
   *   · 拒绝重复 key（`JSON.parse` 会静默取最后一个 —— 这正是"两份冲突字段"被无声吞掉的地方）；
   *   · 拒绝尾随垃圾、单引号、裸逗号等一切非标准形态。
   * 为什么不复用 `JSON.parse` + 正则查重：正则在字符串值里会误判（值里可以包含 `"a":` 这样的文本）。
   * @returns {{ok:true,value:any}|{ok:false,error:string,at:number}}
   */
  function parseStrictJSON(text) {
    const s = String(text == null ? '' : text);
    let i = 0;
    const err = (error, at) => ({ ok: false, error, at: at == null ? i : at });
    const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i += 1; };
    function fail(error) { throw { __json: true, error, at: i }; }

    function value() {
      ws();
      const c = s[i];
      if (c === '{') return object();
      if (c === '[') return array();
      if (c === '"') return str();
      if (c === '-' || (c >= '0' && c <= '9')) return num();
      if (s.startsWith('true', i)) { i += 4; return true; }
      if (s.startsWith('false', i)) { i += 5; return false; }
      if (s.startsWith('null', i)) { i += 4; return null; }
      fail('非法字面量');
    }
    function object() {
      const out = {};
      const seen = new Set();
      i += 1; // {
      ws();
      if (s[i] === '}') { i += 1; return out; }
      for (;;) {
        ws();
        if (s[i] !== '"') fail('对象的键必须是字符串');
        const key = str();
        if (seen.has(key)) fail(`重复的键：${key}`);
        seen.add(key);
        ws();
        if (s[i] !== ':') fail('键后缺少冒号');
        i += 1;
        out[key] = value();
        ws();
        if (s[i] === ',') { i += 1; continue; }
        if (s[i] === '}') { i += 1; return out; }
        fail('对象里缺少 , 或 }');
      }
    }
    function array() {
      const out = [];
      i += 1; // [
      ws();
      if (s[i] === ']') { i += 1; return out; }
      for (;;) {
        out.push(value());
        ws();
        if (s[i] === ',') { i += 1; continue; }
        if (s[i] === ']') { i += 1; return out; }
        fail('数组里缺少 , 或 ]');
      }
    }
    function str() {
      i += 1; // 开引号
      let out = '';
      for (;;) {
        if (i >= s.length) fail('字符串没有结束引号');
        const c = s[i];
        if (c === '"') { i += 1; return out; }
        if (c === '\\') {
          const n = s[i + 1];
          if (n === 'u') {
            const hex = s.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('非法 \\u 转义');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(n in map)) fail(`非法转义 \\${n}`);
          out += map[n];
          i += 2;
          continue;
        }
        if (c === '\n' || c === '\r') fail('字符串里不能出现裸换行');
        out += c;
        i += 1;
      }
    }
    function num() {
      const start = i;
      if (s[i] === '-') i += 1;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1;
      if (s[i] === '.') { i += 1; while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1; }
      if (s[i] === 'e' || s[i] === 'E') {
        i += 1;
        if (s[i] === '+' || s[i] === '-') i += 1;
        while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1;
      }
      const raw = s.slice(start, i);
      if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) fail(`非法数字：${raw}`);
      return Number(raw);
    }

    try {
      const v = value();
      ws();
      if (i !== s.length) return err('JSON 之后还有多余内容', i);
      return { ok: true, value: v };
    } catch (e) {
      if (e && e.__json) return { ok: false, error: e.error, at: e.at };
      throw e;
    }
  }

  /**
   * 从模型输出里取出**所有**顶层 JSON 对象 / 数组（按大括号配对，字符串与转义都被正确跳过）。
   * 用途：模型偶尔吐两份互相冲突的 JSON；旧实现只取"第一个 { 到最后一个 }"，
   * 于是两份被拼成一段非法文本或静默取到其中一份。这里如实列出全部，由调用方判定冲突。
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function extractJSONCandidates(text) {
    const s = String(text == null ? '' : text);
    const out = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') { i += 1; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        // 只有处在候选对象内部时，字符串才有意义；否则它只是外面的一段引文。
        if (depth > 0) inStr = true;
        continue;
      }
      if (c === '{' || c === '[') {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (c === '}' || c === ']') {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start >= 0) out.push({ start, end: i + 1, text: s.slice(start, i + 1) });
        }
        continue;
      }
    }
    return out;
  }

  // ── 二、快照与跨度 ────────────────────────────────────────────────────────
  /** 正文指纹（FNV-1a 32 位 + UTF-16 长度）：与 app.js 的 textFingerprint / contentHashOf 同口径。 */
  function textFingerprint(text) {
    const s = String(text == null ? '' : text);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv1a:${h.toString(16)}:${s.length}`;
  }

  /**
   * 生成不可变正文快照。
   * ⚠️ 口径：`body_text` 就是**实际作为模型输入的那份文本**，逐字保存；
   * `body_hash` 对它直接计算，不做 trim / 不删空行 / 不归一标点 —— 一旦"顺手清理"，
   * 补丁偏移就会与授权范围错位（§6.1）。
   * `sha256` 可选注入（Node 侧用 node:crypto）；浏览器没有同步 sha256 时如实标注 hash_alg。
   */
  function snapshotOf(bodyText, meta = {}) {
    const text = String(bodyText == null ? '' : bodyText);
    const sha = typeof meta.sha256 === 'function' ? meta.sha256(text) : null;
    const hash = sha ? `sha256:${sha}` : textFingerprint(text);
    return {
      schema_version: SCHEMA_VERSION,
      work_id: meta.work_id == null ? '' : String(meta.work_id),
      chapter_id: meta.chapter_id == null ? '' : String(meta.chapter_id),
      revision: meta.revision == null ? '' : String(meta.revision),
      snapshot_id: String(meta.snapshot_id || `${meta.chapter_id == null ? 'ch' : meta.chapter_id}@${hash}`),
      body_text: text,
      body_sha256: sha || null,
      body_hash: hash,
      hash_alg: sha ? 'sha256' : 'fnv1a32+len',
      policy_version: String(meta.policy_version || ''),
      style_profile_version: meta.style_profile_version == null ? null : String(meta.style_profile_version),
      normalization_version: NORMALIZATION_VERSION,
      created_at: String(meta.created_at || ''),
    };
  }

  /**
   * 把正文切成稳定跨度（Host 侧生成的授权单位）。
   *
   * 口径（必须写死，否则"精确替换"退化成"整段替换"）：
   *   · 段跨度 `pN`：**包含段尾的换行分隔符**。为什么：删除整段时若把分隔符留在原地，
   *     会凭空多出一个空段（正文里多出一行空白）；把分隔符并进跨度，"授权范围"与"实际改动范围"才一致。
   *   · 句跨度 `pNsM`：段内按句末标点（。！？…；以及收尾引号）切分，不含任何换行。
   *   · 偏移一律是 **UTF-16 code unit 的 [start,end)**（与 JS 字符串索引一致）。
   *     跨语言脚本必须自行换算，不能把 Python 的码点索引直接当 JS 索引。
   */
  function buildSpans(text, opts = {}) {
    const s = String(text == null ? '' : text);
    const withSentences = opts.sentences !== false;
    const spans = [];
    let index = 0;
    let i = 0;
    while (i < s.length) {
      // 段分隔：2 个以上换行（允许 \r\n 混排）。前导分隔符归上一段的尾部。
      let j = i;
      let paraEnd = -1;
      while (j < s.length) {
        if (s[j] === '\n') {
          let k = j + 1;
          let breaks = 1;
          while (k < s.length) {
            if (s[k] === '\n') { breaks += 1; k += 1; continue; }
            if (s[k] === '\r' && s[k + 1] === '\n') { breaks += 1; k += 2; continue; }
            break;
          }
          if (breaks >= 2) { paraEnd = k; break; }
          j = k;
          continue;
        }
        j += 1;
      }
      if (paraEnd < 0) paraEnd = s.length;
      const raw = s.slice(i, paraEnd);
      const bodyLen = raw.replace(/[\r\n]+$/, '').length;
      const span = {
        span_id: `p${index + 1}`,
        kind: 'paragraph',
        paragraph_index: index,
        start: i,
        end: i + bodyLen,          // 纯正文（不含段尾换行）
        sep_end: i + raw.length,   // 含段尾分隔符的边界（删除整段用这个）
        text: s.slice(i, i + bodyLen),
        paragraph_id: `p${index + 1}`,
        chapter_id: opts.chapter_id == null ? '' : String(opts.chapter_id),
        granularity_hint: 'paragraph',
      };
      spans.push(span);
      if (withSentences && bodyLen > 0) {
        const sentSpans = splitSentences(s, i, i + bodyLen);
        sentSpans.forEach((sp, si) => {
          spans.push({
            span_id: `${span.span_id}s${si + 1}`,
            kind: 'sentence',
            paragraph_index: index,
            parent_span_id: span.span_id,
            start: sp.start,
            end: sp.end,
            sep_end: sp.end,
            text: s.slice(sp.start, sp.end),
            paragraph_id: span.span_id,
            chapter_id: span.chapter_id,
            granularity_hint: 'sentence',
          });
        });
      }
      index += 1;
      i = paraEnd;
      if (paraEnd >= s.length) break;
    }
    return spans;
  }

  /** 句末标点（含中文省略号）与收尾符号：句跨度在**标点之后**结束，引号/括回属于上一句。 */
  const SENTENCE_END = /[。！？!?…]/;
  const CLOSERS = /[”’"』」）)】》]/;
  function splitSentences(s, start, end) {
    const out = [];
    let cur = start;
    let i = start;
    while (i < end) {
      if (SENTENCE_END.test(s[i])) {
        let j = i + 1;
        while (j < end && SENTENCE_END.test(s[j])) j += 1;
        while (j < end && CLOSERS.test(s[j])) j += 1;
        out.push({ start: cur, end: j });
        cur = j;
        i = j;
        continue;
      }
      i += 1;
    }
    if (cur < end) out.push({ start: cur, end });
    return out;
  }

  /** 按 span_id 取跨度（同一份正文重新计算即可，不必把偏移下发给模型）。 */
  function spanIndex(text, opts) {
    const map = new Map();
    for (const sp of buildSpans(text, opts)) map.set(sp.span_id, sp);
    return map;
  }

  // ── 三、严格解码 PatchV2 ──────────────────────────────────────────────────
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v) => typeof v === 'string';
  const opError = (list, code, path, message) => { list.push({ code, path, message }); };

  /**
   * 解码 PatchV2。
   *
   * 纪律（§6.4）：
   *   1. 只接受对象、已知版本和正确字段类型；拒绝重复 JSON key、未知操作、缺字段、超长值。
   *   2. `replace` 要求 replacement 是非空字符串；`delete` 要求 replacement **明确为 ""**。
   *      **缺失 replacement 永远是格式错误，不是删除。**
   *   3. 兼容旧形态（无 schema_version、用 `anchor`/`revised`）：交给 legacy 分支，
   *      但**坏元素不得被折叠成合法空补丁**（旧实现的事故形态）。
   *
   * @param {string|object} raw 模型原始输出或已解析对象
   * @param {{expectedSchemaVersion?:number, allowLegacy?:boolean}} [opts]
   *   · `expectedSchemaVersion: 2` —— 本次是**新**的 v2 修稿作业：响应里没有 schema_version（旧
   *     `anchor/revised` 形态）时按格式不兼容拒绝，**不**落进 legacy 分支。
   *     为什么：旧分支带着"anchor 唯一包含 → 替换整段"的历史语义，新请求一旦能落进去，
   *     就等于让新任务用兼容路径绕过 PatchV2 的跨度约束（《修复.md》E01-D）。存量仍需可读 →
   *     由默认（不传）或显式 `allowLegacy: true` 提供**独立**通道。
   *   · `allowLegacy: false` —— 与上等价的显式"不要兼容"姿态。
   * @returns {{ok:true, mode:'v2'|'legacy', patch:object, legacy:boolean}
   *          |{ok:false, error_code:string, errors:Array, mode:string}}
   */
  function decodePatchOutput(raw, opts = {}) {
    const errors = [];
    let parsed = null;
    let mode = 'unknown';
    let rawText = '';

    if (typeof raw === 'string') {
      rawText = raw;
      const trimmed = raw.trim();
      if (!trimmed) return { ok: false, error_code: ERROR_CODES.PARSE_ERROR, errors: [{ code: 'empty_output', path: '$', message: '输出为空' }], mode };
      const candidates = extractJSONCandidates(raw);
      if (!candidates.length) {
        return { ok: false, error_code: ERROR_CODES.PARSE_ERROR, errors: [{ code: 'json_invalid', path: '$', message: '输出里找不到完整的 JSON 对象（半截 JSON 不能靠猜补全）' }], mode };
      }
      const decoded = [];
      const broken = [];
      for (const c of candidates) {
        const r = parseStrictJSON(c.text);
        if (r.ok) decoded.push({ text: c.text, value: r.value });
        else broken.push({ code: 'json_invalid', path: `$[${c.start}]`, message: r.error, at: r.at });
      }
      if (!decoded.length) {
        // 两份都坏 / 半截 JSON：如实报错。**不**丢掉坏元素后报 noop。
        const dupe = detectDuplicateKeyMessage(raw);
        return {
          ok: false, error_code: ERROR_CODES.PARSE_ERROR, mode,
          errors: dupe ? dupe.concat(broken) : broken,
        };
      }
      if (broken.length) {
        // 2026-10-09（审查修复）：一份能解析、另一份坏掉时**不得静默挑一份执行**（§6.6）。
        // 模型只被要求输出一个 JSON 对象；出现第二份且它坏了，说明输出本身不可信。
        return {
          ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode,
          errors: broken.concat([{
            code: 'partial_json_ignored', path: '$',
            message: `输出里有 ${candidates.length} 份 JSON，其中 ${broken.length} 份无法解析：不从多份里挑一份执行`,
          }]),
        };
      }
      if (decoded.length > 1) {
        // 多份顶层 JSON：内容一致视为重复粘贴，不一致按冲突拒绝。
        const norm = (x) => JSON.stringify(x);
        const allSame = decoded.every((d) => norm(d.value) === norm(decoded[0].value));
        if (!allSame) {
          return {
            ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode,
            errors: [{ code: 'conflicting_json', path: '$', message: `输出里有 ${decoded.length} 份内容不一致的 JSON，无法判断哪一份是本次结果` }],
          };
        }
      }
      parsed = decoded[0].value;
    } else if (isPlainObject(raw)) {
      parsed = raw;
    } else {
      return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, errors: [{ code: 'not_object', path: '$', message: '补丁输出必须是 JSON 对象' }], mode };
    }

    if (!isPlainObject(parsed)) {
      return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'not_object', path: '$', message: '补丁输出必须是 JSON 对象' }] };
    }

    const hasVersion = 'schema_version' in parsed;
    const isV2 = Number(parsed.schema_version) === SCHEMA_VERSION;
    if (hasVersion && !isV2) {
      return {
        ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode: 'v2',
        errors: [{ code: 'unknown_schema_version', path: '$.schema_version', message: `未知协议版本：${JSON.stringify(parsed.schema_version)}（本实现只接受 ${SCHEMA_VERSION}）` }],
      };
    }
    mode = isV2 ? 'v2' : 'legacy';

    // 新任务不接受 legacy 自动应用（E01-D / K4）：兼容是给**存量**读的独立通道。
    if (!isV2 && (Number(opts.expectedSchemaVersion) === SCHEMA_VERSION || opts.allowLegacy === false)) {
      return {
        ok: false, error_code: ERROR_CODES.INCOMPATIBLE_LEGACY, mode: 'legacy',
        errors: [{
          code: ERROR_CODES.INCOMPATIBLE_LEGACY, path: '$.schema_version',
          message: `本次是协议 v${SCHEMA_VERSION} 修稿作业，但响应是旧格式（没有 schema_version，用 anchor/revised）：`
            + '按格式不兼容处理 —— 不会用旧"包含命中即替换整段"的语义应用；请按 v2 重发，'
            + '或走显式的存量兼容入口（allowLegacy）。',
        }],
      };
    }

    if (!Array.isArray(parsed.patches)) {
      return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'missing_patches', path: '$.patches', message: '缺少 patches 数组（不能把"没有 patches 字段"当成空补丁）' }] };
    }
    if (parsed.patches.length > MAX_PATCHES) {
      return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'too_many_patches', path: '$.patches', message: `补丁条数 ${parsed.patches.length} 超过上限 ${MAX_PATCHES}` }] };
    }

    const patches = [];
    let dropped = 0;
    parsed.patches.forEach((p, i) => {
      const at = `$.patches[${i}]`;
      if (!isPlainObject(p)) {
        opError(errors, 'patch_not_object', at, '补丁项必须是对象');
        dropped += 1;
        return;
      }
      const legacy = !isV2;
      const originalRaw = legacy ? pickField(p, ['anchor', 'original', 'old']) : pickField(p, ['original']);
      const hasReplacement = legacy ? ('revised' in p || 'replacement' in p || 'new' in p) : ('replacement' in p);
      const replacementRaw = legacy ? pickField(p, ['revised', 'replacement', 'new']) : pickField(p, ['replacement']);
      const opRaw = 'op' in p ? p.op : (legacy ? undefined : undefined);

      // ⚠️ 顺序很重要：`op` 必须在"original 非空"检查**之前**解析出来，
      // 因为 `insert` 的 original 按定义就是空串（零宽插入点）。
      // 旧实现在这里就先要求非空，等于从语法上封死了插入 —— 这正是 R07 无合法路径的原因。
      let op = opRaw;
      if (op === undefined || op === null) op = 'replace';
      if (op !== 'replace' && op !== 'delete' && op !== 'insert') {
        opError(errors, 'unknown_op', `${at}.op`, `未知操作：${JSON.stringify(opRaw)}（只接受 replace / delete / insert）`);
        dropped += 1;
        return;
      }

      if (op === 'insert') {
        // 2026-10-13（P0-B / R07）：零宽插入。四道约束，缺一不可 ——
        //   ① original 必须为空串：insert 不认领任何原文，所以不能用它顺带"替换"掉一段正文；
        //   ② 必须显式给 replacement，且非空（空插入没有意义，应直接不发这条）；
        //   ③ 位置只能由 span_id 对应的**授权插入点**给出（见 resolveAuthorizedRange）；
        //   ④ 该授权条目必须显式包含 'insert'（缺 ops 字段的历史条目视为未声明 → 拒绝）。
        // 为什么不用"anchor 处插入"：那会让插入位置随原文匹配漂移，而 P0-B 要的是精确授权范围。
        if (isStr(originalRaw) && originalRaw !== '') {
          opError(errors, 'insert_requires_empty_original', `${at}.original`,
            'insert 的 original 必须是空字符串 ""（零宽插入点）；要替换原文请用 op:"replace"');
          dropped += 1;
          return;
        }
        if (!isStr(replacementRaw) || replacementRaw.length === 0) {
          opError(errors, 'insert_requires_nonempty_replacement', `${at}.replacement`,
            'insert 必须给出非空 replacement（插入的内容）');
          dropped += 1;
          return;
        }
        if (replacementRaw.length > MAX_VALUE_CHARS) {
          opError(errors, 'value_too_long', `${at}.replacement`, `插入内容超过 ${MAX_VALUE_CHARS} 字符上限`);
          dropped += 1;
          return;
        }
      } else {
      if (!isStr(originalRaw) || !originalRaw.trim()) {
        opError(errors, 'missing_original', at, '缺少 original/anchor（无法定位要改的原文）');
        dropped += 1;
        return;
      }
      if (originalRaw.length > MAX_VALUE_CHARS) {
        opError(errors, 'value_too_long', `${at}.original`, `原文超过 ${MAX_VALUE_CHARS} 字符上限`);
        dropped += 1;
        return;
      }
      if (!hasReplacement) {
        // 关键区分：**缺失** replacement 不是删除。
        opError(errors, 'missing_replacement', `${at}.replacement`,
          op === 'delete' ? 'delete 必须显式给出 replacement:""（缺失不等于删除）' : `${op} 缺少 replacement 字段`);
        dropped += 1;
        return;
      }
      if (!isStr(replacementRaw)) {
        opError(errors, 'bad_replacement_type', `${at}.replacement`, 'replacement 必须是字符串（null / 数字 / 对象都不是合法正文）');
        dropped += 1;
        return;
      }
      if (replacementRaw.length > MAX_VALUE_CHARS) {
        opError(errors, 'value_too_long', `${at}.replacement`, `改后内容超过 ${MAX_VALUE_CHARS} 字符上限`);
        dropped += 1;
        return;
      }
      if (op === 'replace' && replacementRaw.length === 0) {
        opError(errors, 'replace_requires_nonempty', `${at}.replacement`, 'replace 的 replacement 必须是非空字符串；整段删除请用 op:"delete"');
        dropped += 1;
        return;
      }
      if (op === 'delete' && replacementRaw !== '') {
        opError(errors, 'delete_requires_empty', `${at}.replacement`, 'delete 的 replacement 必须是空字符串 ""');
        dropped += 1;
        return;
      }
      }

      const issueIds = normalizeIssueIds(p.issue_ids != null ? p.issue_ids : (p.issue != null ? p.issue : []), at, errors);
      const spanId = p.span_id == null ? '' : String(p.span_id);
      const explicitSpan = isPlainObject(p.span) ? p.span : null;
      // span 只对协议 v2 是必填：旧格式靠 anchor 定位（兼容器负责它的"包含式退位"语义）。
      if (isV2 && !spanId && !explicitSpan) {
        opError(errors, 'missing_span', at, '缺少 span_id（或显式 span:{start,end}）：无法证明改动落在授权范围内');
        dropped += 1;
        return;
      }
      if (explicitSpan) {
        const st = Number(explicitSpan.start);
        const en = Number(explicitSpan.end);
        if (!Number.isInteger(st) || !Number.isInteger(en) || st < 0 || en < st) {
          opError(errors, 'bad_span', `${at}.span`, 'span 的 start/end 必须是非负整数且 start <= end');
          dropped += 1;
          return;
        }
      }
      patches.push({
        patch_id: isStr(p.patch_id) && p.patch_id ? p.patch_id : `patch-${i + 1}`,
        group_id: isStr(p.group_id) && p.group_id ? p.group_id : (isStr(p.patch_id) && p.patch_id ? p.patch_id : `patch-${i + 1}`),
        issue_ids: issueIds,
        span_id: spanId,
        span: explicitSpan ? { start: Number(explicitSpan.start), end: Number(explicitSpan.end) } : null,
        op,
        original: originalRaw,
        replacement: replacementRaw,
        // 2026-10-13（T33）：可选理由 + 它是否可核验。**纯增量**：旧载荷不带该字段时
        // reason 为空串、reason_unverified 为 false，与改动前逐字节等价。
        reason: isStr(p.reason) ? p.reason : '',
        reason_unverified: !checkReasonBinding(isStr(p.reason) ? p.reason : '', issueIds).ok,
        legacy,
      });
    });

    if (dropped) {
      // ⚠️ 这就是 2026-10-08 的事故形态：旧实现把坏元素丢光后返回 `[]`，
      //    而 `[]` 是合法 noop —— 一次解析事故被显示成"模型判断无需修改"。
      return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors };
    }

    let dispositions = [];
    if (parsed.dispositions !== undefined) {
      if (!Array.isArray(parsed.dispositions)) {
        return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'bad_dispositions', path: '$.dispositions', message: 'dispositions 必须是数组' }] };
      }
      for (let i = 0; i < parsed.dispositions.length; i += 1) {
        const d = parsed.dispositions[i];
        const at = `$.dispositions[${i}]`;
        if (!isPlainObject(d) || !isStr(d.issue_id) || !d.issue_id) {
          return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'bad_disposition', path: at, message: '每条处置必须有非空 issue_id' }] };
        }
        const status = String(d.status || '');
        // 2026-10-11（T19，《修改方案.md》§8 E04）：接受 `partially_resolved`。
        // 为什么必须显式接收而不是让模型改写：本文档把"只解决局部"列为一等完成态，
        // 而旧白名单只有 patched/keep/deferred/blocked —— 模型想说"只改了一半"时只能被迫说
        // `patched`，于是**局部解决被显示成完全解决**（正是 §6.4 与 T19 要禁止的）。
        if (!['patched', 'keep', 'deferred', 'blocked', 'partially_resolved'].includes(status)) {
          return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'bad_disposition_status', path: `${at}.status`, message: `未知处置状态：${JSON.stringify(d.status)}（只接受 patched / partially_resolved / keep / deferred / blocked）` }] };
        }
        // 声明"只解决局部"必须给理由，否则与"完全解决"无从区分（且不得进可采纳集）。
        if (status === 'partially_resolved' && !String(d.reason || '').trim()) {
          return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'partial_without_reason', path: `${at}.reason`, message: 'partially_resolved 必须说明"哪一部分仍未解决"（缺理由时无法与完全解决区分）' }] };
        }
        // 2026-10-13（T33，R06 的实际形态）：处置声明它处理 issue X，理由里却写着"#Y"（Y≠X）
        // ——例如 #6 号码纸动作的处置，理由谈的是 #9 深海母神角色卡。这种理由必须被标成
        // 不可核验，而不是原样渲染成"已改理由"。补丁照常应用：理由错配不代表改错了地方。
        const reasonBinding = checkReasonBinding(isStr(d.reason) ? d.reason : '', [d.issue_id]);
        dispositions.push({
          issue_id: d.issue_id,
          status,
          reason: isStr(d.reason) ? d.reason : '',
          reason_unverified: !reasonBinding.ok,
          foreign_reference: reasonBinding.foreign,
        });
      }
    }

    return {
      ok: true,
      mode,
      legacy: mode === 'legacy',
      patch: {
        schema_version: isV2 ? SCHEMA_VERSION : 1,
        snapshot_id: isStr(parsed.snapshot_id) ? parsed.snapshot_id : '',
        base_hash: isStr(parsed.base_hash) ? parsed.base_hash : '',
        patches,
        dispositions,
      },
    };
  }

  function pickField(obj, names) {
    for (const n of names) if (n in obj) return obj[n];
    return undefined;
  }
  function normalizeIssueIds(v, at, errors) {
    if (v === undefined || v === null || v === '') return [];
    const list = Array.isArray(v) ? v : [v];
    const out = [];
    for (const x of list) {
      if (typeof x === 'number' && Number.isFinite(x)) { out.push(String(x)); continue; }
      if (typeof x === 'string' && x.trim()) { out.push(x.trim()); continue; }
      opError(errors, 'bad_issue_ref', at, `非法的 issue 引用：${JSON.stringify(x)}`);
    }
    return out;
  }
  /** 重复键的定位文案（单独扫一遍原文，只为了给出可操作的信息）。 */
  function detectDuplicateKeyMessage(raw) {
    const s = String(raw == null ? '' : raw);
    const seen = new Set();
    const hits = [];
    const keyRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g;
    let m;
    while ((m = keyRe.exec(s))) {
      if (seen.has(m[1])) hits.push(m[1]);
      else seen.add(m[1]);
    }
    if (!hits.length) return null;
    return [{ code: 'duplicate_key', path: '$', message: `输出里有重复的键：${[...new Set(hits)].join('、')}（重复键必须拒绝，不能静默取最后一个）` }];
  }

  // ── 四、跨度校验与计划编译 ────────────────────────────────────────────────
  /**
   * Host 授权表条目是否覆盖这条补丁（E01-B）。
   *
   * 三条等价判据（任一成立即算授权）：
   *   · span_id 相同；或
   *   · start/end 与 Host 登记值完全一致；或
   *   · `original` 与 Host 登记的**逐字原文**相等。
   * 为什么保留第三条：分段修稿时 Host 的计划与分片的 span 命名空间不同（p12 在整章 vs p3 在片内），
   * 但 `original` 必须与快照切片逐字相等（上面已判），而 Host 侧 `locateFragment` 又保证被登记的原文
   * 在快照里唯一可定位 —— 于是"逐字相等"就是"同一处"，不是近似匹配。
   *
   * `ops` / `allowed_ops` 提供时按它限制操作类型；都不提供表示该条目不限制。
   */
  /**
   * 一条授权条目声明的允许操作（2026-10-13）。
   *
   * 为什么同时接受两种拼写：方案《0731 增补方案》§2 P0-B 把该字段写成
   * `authorizations:[{issue_id,span_id,start,end,allowed_ops}]`，而宿主既有的授权表用的是
   * `ops`。同时接受两者，既让引擎兑现方案写明的契约，又不会让已经按 `ops` 写好的授权表失效。
   * 两者都缺 → 返回空数组（"未声明"），调用方据此保持"不限制"的老行为，
   * 不追溯否决历史授权。
   */
  function entryAllowedOps(entry) {
    if (!entry || typeof entry !== 'object') return [];
    const raw = Array.isArray(entry.allowed_ops) ? entry.allowed_ops : entry.ops;
    return Array.isArray(raw) ? raw : [];
  }

  function authorizationEntryMatches(entry, resolved) {
    if (!entry || typeof entry !== 'object') return false;
    const allowed = entryAllowedOps(entry);
    if (allowed.length && !allowed.includes(resolved.op)) return false;
    // 2026-10-13（P0-B / R07）：`insert` 的 original 按定义是空串，与入口登记的 `text` **永不相等**，
    // 于是下面那条"身份以逐字原文为准"的规则会把所有合法插入一律判成未授权
    // （实测：授权写对了仍报 out_of_scope）。插入不认领原文，身份只能靠 span_id + 显式 ops 声明。
    // 位置由 resolveAuthorizedRange 从授权条目自身给出，不随原文匹配漂移。
    if (resolved.op === 'insert') {
      if (!allowed.includes('insert')) return false;
      return String(entry.span_id == null ? '' : entry.span_id) === String(resolved.span_id);
    }
    // ⚠️ 2026-10-10（分段命名空间）：Host 登记了**逐字原文**时，身份以原文为准 ——
    //    `span_id` 与偏移在"整章"和"分片"两种命名空间下含义不同（分片的 p2s1 与整章的 p2s1
    //    是两句不同的话）。若还让 span_id 单独放行，就会在分片里把 A 句的授权用到 B 句上。
    //    位置仍由下方既有的 `p.original === text.slice(start,end)` 逐字校验兜住，
    //    而 Host 侧 `locateFragment` 已保证被登记的原文在快照里唯一可定位。
    const hasText = typeof entry.text === 'string' && entry.text !== '';
    if (hasText) return entry.text === resolved.original;
    const spanId = entry.span_id == null ? '' : String(entry.span_id);
    const idOk = !!spanId && spanId === resolved.span_id;
    const rangeOk = Number.isFinite(Number(entry.start)) && Number.isFinite(Number(entry.end))
      && Number(entry.start) === resolved.start && Number(entry.end) === resolved.end;
    return idOk || rangeOk;
  }

  /** 授权表里的 protected 条目：跨度 id 命中，或补丁范围与该条目登记的区间有交集。 */
  function authorizationRangeHit(entry, resolved) {
    if (authorizationEntryMatches(entry, resolved)) return true;
    const s = Number(entry && entry.start);
    const e = Number(entry && entry.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return resolved.start < e && s < resolved.end;
  }

  /**
   * 删除时的分隔符边界（**两条路径共用同一口径**：原生跨度分支与授权表分支）。
   *
   * 为什么必须共用：同一个意图（"删掉这一段"）不能因为模型写的是整段 span_id 还是片段原文
   * 而得到两种文本（留下一行空段 vs 干净删除）。旧实现只在前一条路径上做这件事，
   * 片段级授权路径会把 `\n\n` 留在原地 —— 那正是"执行器里悄悄多删/少删分隔符"的反面。
   */
  function expandDeleteRange(text, paraSpans, start, end) {
    const para = (paraSpans || []).find((sp) => sp.start <= start && end <= sp.sep_end);
    if (!para) return { start, end };
    let s = start;
    let e = end;
    // ① 授权范围正好等于它所在的一整段 → 连同段尾分隔符一起删（否则凭空多一个空段）。
    if (String(para.text) === text.slice(start, end)) e = para.sep_end;
    // ② 删的是文末那一段 → 把紧邻在前的分隔符一并纳入，否则候选会以 "\n\n" 结尾。
    if (e >= text.length) {
      const m = text.slice(0, s).match(/[\r\n]+$/);
      if (m) s -= m[0].length;
    }
    return { start: s, end: e };
  }

  /**
   * 解析 **Host 登记过的片段级跨度**（E01-B 的后半句："若允许局部 fragment 的显式 offset，
   * 范围必须由 Host 计划事先登记，`original` 与 Host 快照逐字相等"）。
   *
   * 为什么需要：`buildRevisionPlan` 把授权跨度收紧到"那一刻文字"时，span_id 是
   * `${包含它的跨度}~${相对偏移}`（例如 `p1s1~11`）——它是**计划的身份**，不是 `buildSpans`
   * 的原生 id，因此执行器 `spans.get(...)` 必然找不到它。旧行为会直接判 `out_of_scope`，
   * 结果是"最窄、最该被允许的那一类授权补丁一条也执行不了"（而整段跨度反而能用）。
   *
   * 现在：只有 **授权表里登记过** 的同名条目才算数，并且要逐字核验
   * `patch.original === entry.text`，且这段原文在当前底稿里**唯一可定位**。
   * 也就是说"能不能改这里"仍然完全由 Host 数据决定，模型无法凭自造 span_id 获得位置。
   *
   * ⚠️ 为什么用"逐字原文 + 唯一性"定位、而**不**直接采信 entry 的 start/end：
   * 分段修稿的校验底稿是**片**（`seg.target.text`），而 Host 计划登记的是**整章**偏移 ——
   * 两个命名空间不同，直接拿整章偏移切片必然错位，会把**合法授权全判成越权**，
   * 而片段级授权恰恰是分段修稿唯一能用的那类补丁。逐字原文 + "在底稿里唯一"
   * 在整章与分片下同时成立，且不放松任何约束：定位到之后仍要满足下方既有的
   * `p.original === text.slice(start, end)` 逐字校验。
   */
  /**
   * 授权表读数统一口径（v1.2.1 质量闭环 v2）。
   *
   * v1 的键是 `authorized`，v2 的键是 `authorized_targets`（方案 §6.2 第 5 条）。
   * 两个键**指向同一张表**；这里只决定读哪一个，不做合并/兜底猜测 ——
   * 若两个键同时存在且内容不同，说明调用方把两套许可混在一起了，此时以 `authorized` 为准
   * （历史键优先，保持旧行为），而不是"取并集"把权限放大。
   */
  function authorizationTable(authorization) {
    if (!authorization || typeof authorization !== 'object') return {};
    const a = authorization.authorized;
    if (a && typeof a === 'object' && !Array.isArray(a)) return a;
    const t = authorization.authorized_targets;
    return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
  }

  function resolveAuthorizedRange(authorization, p, text, spans) {
    if (!authorization || !p.span_id) return null;
    const table = authorizationTable(authorization);
    const want = String(p.original == null ? '' : p.original);
    // ⚠️ `op === 'insert'` 时 original 按定义就是空串，**不能**在这里提前返回 null ——
    //    否则插入永远走不到下面那条"授权插入点"分支（本函数的第一个实现就是这么错的：
    //    授权写对了却报 out_of_scope，等于新能力一上线就是死的）。
    if (!want && p.op !== 'insert') return null;
    for (const key of Object.keys(table)) {
      const list = Array.isArray(table[key]) ? table[key] : [];
      for (const e of list) {
        if (!e || String(e.span_id || '') !== String(p.span_id)) continue;
        // 2026-10-13（P0-B 第三重授权）：授权表一直带 `ops`，但引擎从没读过它 ——
        // "授权了这个跨度"被当成了"这个跨度上想做什么都行"。现在按 op 逐条校验。
        // 字段名同时接受 `allowed_ops`（方案 §2 P0-B 的写法）与 `ops`（既有授权表写法）。
        // ⚠️ 两者都缺的历史条目**保持放行**（08/11 号套件里就有一批不带 ops 的写法）：
        //    新约束只能收紧显式声明过的授权，不能把老条目一并判死。
        const declaredOps = entryAllowedOps(e);
        if (declaredOps.length && !declaredOps.includes(p.op)) {
          return { denied: 'op_not_authorized', span_id: String(p.span_id), allowed: [...declaredOps] };
        }
        // 零宽插入点：insert 不认领原文，位置完全由"哪条授权"给出。
        // 必须显式授权（未声明或声明里没有 insert 都拒绝）——"哪里都能插"是最危险的放宽。
        if (p.op === 'insert') {
          if (!declaredOps.includes('insert')) {
            return { denied: 'op_not_authorized', span_id: String(p.span_id), allowed: [...declaredOps] };
          }
          const at = Number.isInteger(e.start) ? e.start : text.indexOf(String(e.text == null ? '' : e.text));
          if (!Number.isInteger(at) || at < 0) return { denied: 'anchor_mismatch', span_id: String(p.span_id) };
          const para = (spans || []).find((sp) => sp.kind === 'paragraph' && sp.start <= at && at < sp.sep_end);
          return {
            start: at, end: at, span_id: String(p.span_id),
            paragraph_index: para ? para.paragraph_index : Number(e.paragraph_index),
            kind: 'authorized_insert',
          };
        }
        if (String(e.text == null ? '' : e.text) !== want) continue;   // Host 登记的原文必须逐字相等
        const at = text.indexOf(want);
        if (at < 0) continue;
        if (text.indexOf(want, at + 1) >= 0) continue;                 // 底稿里出现多次 → 位置不唯一，不认
        const para = (spans || []).find((sp) => sp.kind === 'paragraph' && sp.start <= at && at < sp.sep_end);
        return {
          start: at, end: at + want.length, span_id: String(p.span_id),
          paragraph_index: para ? para.paragraph_index : Number(e.paragraph_index),
          kind: 'authorized_fragment',
        };
      }
    }
    return null;
  }

  /**
   * 把解好的补丁落到具体跨度上，并做**授权范围**校验。
   *
   * 校验项（§6.3/§6.4/§6.5）：
   *   · snapshot_id / base_hash 必须与当前快照一致 —— 否则 `stale`（不猜、不重定位）；
   *   · `original` 必须与快照跨度**逐字相等** —— 否则 `anchor_mismatch`；
   *   · issue_ids 必须是**本次已选**的问题 —— 否则 `out_of_scope` / `selection_mismatch`；
   *   · 跨度必须属于本章 —— 否则 `out_of_scope`（别章 / 上下文专用跨度）；
   *   · 给了 `opts.authorization` 时，补丁的跨度/逐字原文必须落在**该 issue 的授权表**里 ——
   *     否则 `out_of_scope`（同章但未授权同样拒绝，E01-B）；命中 `protected` 同样拒绝；
   *   · 同一跨度上多条互不一致的操作 → 整组拒绝（`overlap`）；
   *   · 不同补丁跨度重叠 → 整组拒绝，不做"先到先得"；
   *   · 同跨度、同操作的多条合并为一条（避免同一处写两遍）。
   *
   * @returns {{ok:true, plan:{...}}|{ok:false, error_code:string, errors:Array, conflicts:Array}}
   */
  function planPatchApplication(snapshot, decoded, opts = {}) {
    const errors = [];
    const conflicts = [];
    const text = String(snapshot && snapshot.body_text != null ? snapshot.body_text : '');
    const snapshotId = String((snapshot && snapshot.snapshot_id) || '');
    const baseHash = String((snapshot && snapshot.body_hash) || textFingerprint(text));
    const patch = decoded && decoded.patch ? decoded.patch : null;
    if (!patch) return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, errors: [{ code: 'no_patch', path: '$', message: '没有可用的补丁对象' }], conflicts };

    if (patch.snapshot_id && snapshotId && patch.snapshot_id !== snapshotId) {
      return { ok: false, error_code: ERROR_CODES.STALE, errors: [{ code: 'stale_snapshot', path: '$.snapshot_id', message: `补丁针对快照 ${patch.snapshot_id}，当前快照是 ${snapshotId}：源稿已变化，不猜测重定位` }], conflicts };
    }
    if (patch.base_hash && patch.base_hash !== baseHash) {
      return { ok: false, error_code: ERROR_CODES.STALE, errors: [{ code: 'stale_base_hash', path: '$.base_hash', message: '补丁的 base_hash 与当前正文不符：源稿已变化，不猜测重定位' }], conflicts };
    }

    const spans = new Map();
    // ⚠️ 跨度必须按**快照所属章**打标（2026-10-09 审查修复）：此前用的是调用方传进来的
    // `opts.chapter_id`，于是下面那条"别章跨度"判据恒成立（跨度章 == 调用章），永远不触发。
    // 现在跨度带的是快照的章号，调用方只有在编辑**同一章**时才通得过 —— 判据才真的可判。
    const spanChapter = String((snapshot && snapshot.chapter_id) || '') || (opts.chapter_id == null ? '' : String(opts.chapter_id));
    const spanList = buildSpans(text, { sentences: true, chapter_id: spanChapter });
    for (const sp of spanList) spans.set(sp.span_id, sp);
    // 段落跨度单独留一份（数组）：片段级授权要按"落在哪一段"归位，组合核验按段号重放。
    const paraSpans = spanList.filter((sp) => sp.kind === 'paragraph');
    const selected = opts.selectedIssueIds ? new Set(opts.selectedIssueIds.map(String)) : null;
    const contextOnly = new Set((opts.contextOnlySpanIds || []).map(String));
    const chapterId = opts.chapter_id == null ? '' : String(opts.chapter_id);

    const planned = [];
    const evaluated = [];
    const groupFailures = new Map(); // group_id -> [错误码]
    const failGroup = (p, code, path, message) => {
      errors.push({ code, path, message });
      const g = p.group_id || p.patch_id;
      if (!groupFailures.has(g)) groupFailures.set(g, []);
      groupFailures.get(g).push(code);
    };
    for (const p of patch.patches) {
      const span = p.span_id ? spans.get(p.span_id) : null;
      let start;
      let end;
      let bodyStart;
      let bodyEnd;
      let spanObj = span;
      if (p.span) {
        start = p.span.start;
        end = p.span.end;
        bodyStart = start;
        bodyEnd = end;
        // span_id 与显式 span 同时出现且互相矛盾 → 无法证明改动落在授权范围内：直接拒绝。
        // （旧实现取 span 的偏移、却保留 span_id 的身份，于是"身份"与"位置"可以各说各话。）
        const declared = p.span_id ? spans.get(p.span_id) : null;
        if (declared && (declared.start !== start || declared.end !== end)) {
          failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`,
            `补丁同时声明了 span_id「${p.span_id}」与不一致的 span:{start,end}：两者必须一致，否则无法证明改动落在授权范围内`);
          continue;
        }
        spanObj = declared || { span_id: p.span_id || `${start}-${end}`, kind: 'explicit', start, end, text: text.slice(start, end), chapter_id: spanChapter };
      } else if (opts.authorization) {
        // ⚠️ 有授权表时，位置**一律**由 Host 登记（span_id + 逐字原文）决定，
        //    **不**采信 buildSpans 的原生 id —— 分段修稿的底稿是"片"，
        //    片内的 `p2s1` 与整章的 `p2s1` 是两句不同的话，认 id 就等于认错位置。
        const authorized = resolveAuthorizedRange(opts.authorization, p, text, paraSpans);
        // 第三重授权没过时给**专属**错误码：作者要能区分"你改的不是我批的那段"
        // （out_of_scope）与"我批了这段、但没批这种改法"（op_not_authorized）。
        if (authorized && authorized.denied) {
          if (authorized.denied === 'op_not_authorized') {
            failGroup(p, ERROR_CODES.OP_NOT_AUTHORIZED, `$.patches[${p.patch_id}]`,
              `op「${p.op}」不在该跨度的授权操作内（该跨度已获授权，但 Host 只批了：`
              + `${(authorized.allowed || []).length ? authorized.allowed.join(' / ') : '未声明任何操作'}）`);
          } else {
            failGroup(p, ERROR_CODES.ANCHOR_MISMATCH, `$.patches[${p.patch_id}]`,
              `授权插入点无法在底稿中确定（span_id ${p.span_id}）：不猜位置`);
          }
          continue;
        }
        if (!authorized) {
          failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`,
            `补丁不在授权表登记的跨度内（span_id ${p.span_id}，原文「${String(p.original).slice(0, 20)}」）：`
            + 'Host 只授权了计划里登记过的跨度 / 逐字原文');
          continue;
        }
        start = authorized.start;
        end = authorized.end;
        if (p.op === 'delete') {
          // 删除的分隔符边界与原生跨度分支同一口径（见 expandDeleteRange 的说明）。
          const rng = expandDeleteRange(text, paraSpans, start, end);
          start = rng.start;
          end = rng.end;
        }
        bodyStart = authorized.start;
        bodyEnd = authorized.end;
        spanObj = {
          span_id: authorized.span_id, kind: authorized.kind, start, end, sep_end: end,
          text: text.slice(start, end), paragraph_index: authorized.paragraph_index,
          chapter_id: spanChapter, granularity_hint: 'fragment',
        };
      } else if (span) {
        bodyStart = span.start;
        bodyEnd = span.end;
        start = span.start;
        end = span.end;
        if (p.op === 'delete') {
          // 删除的分隔符边界：与授权表分支共用同一口径（见 expandDeleteRange 的说明）。
          // 旧实现把这段逻辑内联在这里，于是片段级授权路径漏掉了它（会留空段）。
          const rng = expandDeleteRange(text, paraSpans, span.start, span.end);
          start = rng.start;
          end = rng.end;
        }
        spanObj = { ...span, end };
      } else {
        failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`, `span_id「${p.span_id}」不在本章授权跨度内`);
        continue;
      }
      if (contextOnly.has(spanObj.span_id)) {
        failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`, `span「${spanObj.span_id}」是只读上下文（context-only），不能修改`);
        continue;
      }
      if (spanObj.chapter_id && chapterId && String(spanObj.chapter_id) !== chapterId) {
        failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`, `span「${spanObj.span_id}」属于第 ${spanObj.chapter_id} 章，不是本次授权章节`);
        continue;
      }
      const body = text.slice(bodyStart, bodyEnd);
      const actual = text.slice(start, end);
      // 逐字相等是**唯一**合法依据：不做"包含式退让"，也不猜"可能指的是哪一段"。
      if (p.original !== body && p.original !== actual) {
        failGroup(p, ERROR_CODES.ANCHOR_MISMATCH, `$.patches[${p.patch_id}]`,
          'original 与授权跨度不逐字相等：拒绝按近似文本改动（不猜测、不扩大范围）');
        continue;
      }
      if (selected && p.issue_ids.length) {
        const outside = p.issue_ids.filter((id) => !selected.has(id));
        if (outside.length) {
          failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`, `引用了本次未勾选的问题：${outside.join('、')}`);
          continue;
        }
      }
      if (selected && !p.issue_ids.length) {
        failGroup(p, ERROR_CODES.SELECTION_MISMATCH, `$.patches[${p.patch_id}]`, '补丁没有声明它处理哪个已选问题（selection_mismatch）');
        continue;
      }
      // ── 授权表（E01-B）："问题被选中"不等于"这个跨度被授权" ──────────────────
      // 只有 Host 计划事先登记的跨度/逐字原文才放行；**同章但没授权的跨度同样拒绝**。
      // 旧实现只判 issue_ids ⊆ 已选 → 模型挑一个已选 issue 就能改全章任意一处（K2）。
      if (opts.authorization) {
        const table = authorizationTable(opts.authorization);
        const resolved = { span_id: String(spanObj.span_id || ''), start, end, original: p.original, op: p.op };
        const missing = p.issue_ids.filter((id) => !(Array.isArray(table[id]) ? table[id] : []).some((e) => authorizationEntryMatches(e, resolved)));
        if (missing.length) {
          failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`,
            `补丁落在 issue「${missing.join('、')}」未授权的跨度上`
            + `（span_id ${resolved.span_id}，原文「${String(p.original).slice(0, 20)}」）：`
            + 'Host 只授权了这些问题在计划里登记的跨度/逐字原文，同章其它跨度一律不可改');
          continue;
        }
        const prot = Array.isArray(opts.authorization.protected) ? opts.authorization.protected : [];
        if (prot.some((e) => authorizationRangeHit(e, resolved))) {
          failGroup(p, ERROR_CODES.OUT_OF_SCOPE, `$.patches[${p.patch_id}]`,
            `补丁落在授权表标记为 protected 的范围上（span_id ${resolved.span_id}）：不得作为改动对象`);
          continue;
        }
      }
      evaluated.push({ p, spanObj, start, end, bodyStart, bodyEnd });
    }

    // 依赖组原子化：**同组一条失败，整组不进入可采纳候选**（独立组仍可单独预览）。
    const failedGroups = new Set(groupFailures.keys());
    const surviving = evaluated.filter((e) => !failedGroups.has(e.p.group_id || e.p.patch_id));
    const skipped = evaluated.filter((e) => failedGroups.has(e.p.group_id || e.p.patch_id));
    if (patch.patches.length && !surviving.length) {
      return { ok: false, error_code: errors.length ? errors[0].code : ERROR_CODES.ANCHOR_MISMATCH, errors, conflicts, group_failures: [...groupFailures.entries()].map(([group_id, codes]) => ({ group_id, codes })) };
    }

    const bySpan = new Map();   // "start:end" -> { span, ops:Set, issueIds:Set, patches:[] }
    for (const e of surviving) {
      const { p, spanObj, start, end } = e;
      const key = `${start}:${end}`;
      const bucket = bySpan.get(key) || { span: spanObj, start, end, ops: new Set(), issueIds: new Set(), patches: [] };
      if (bucket.ops.size && !bucket.ops.has(p.op)) {
        conflicts.push({ span_id: spanObj.span_id, group_id: p.group_id || p.patch_id, reason: `同一跨度上出现了互不一致的操作（${[...bucket.ops].join(' / ')} 与 ${p.op}）`, patches: [...bucket.patches.map((x) => x.patch_id), p.patch_id] });
        continue;
      }
      bucket.ops.add(p.op);
      p.issue_ids.forEach((id) => bucket.issueIds.add(id));
      bucket.patches.push(p);
      bySpan.set(key, bucket);
    }

    for (const [, bucket] of bySpan) {
      const replacements = new Set(bucket.patches.map((x) => x.replacement));
      if (bucket.ops.size > 1 || replacements.size > 1) {
        conflicts.push({ span_id: bucket.span.span_id, reason: '同一跨度上有多条内容不同的补丁：拒绝整组（不做"先到先得"或顺序覆盖）', patches: bucket.patches.map((x) => x.patch_id) });
        continue;
      }
      const op = [...bucket.ops][0];
      const replacement = [...replacements][0];
      planned.push({
        span_id: bucket.span.span_id,
        paragraph_index: bucket.span.paragraph_index,
        start: bucket.start,
        end: bucket.end,
        op,
        original: text.slice(bucket.start, bucket.end),
        replacement,
        issue_ids: [...bucket.issueIds],
        patch_ids: bucket.patches.map((x) => x.patch_id),
        // 2026-10-13（T33）：理由与"是否可核验"必须跟着跨度一起带出来，
        // 否则覆盖表只能显示理由、显示不出它不可信（＝把错误理由当可信依据渲染）。
        // 同一跨度上多条补丁时，只要有一条理由对不上，整条跨度就标为不可核验。
        reason: (bucket.patches.find((x) => String(x.reason || '').trim()) || {}).reason || '',
        reason_unverified: bucket.patches.some((x) => x.reason_unverified === true),
      });
    }

    if (conflicts.length) {
      return { ok: false, error_code: ERROR_CODES.OVERLAP, errors: [{ code: ERROR_CODES.OVERLAP, path: '$', message: '跨度冲突：整批拒绝，未生成本次候选' }], conflicts };
    }
    // 不同补丁的跨度互相重叠（不是同一跨度）→ 同样整批拒绝。
    const sorted = planned.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].start < sorted[i - 1].end) {
        return {
          ok: false, error_code: ERROR_CODES.OVERLAP,
          errors: [{ code: ERROR_CODES.OVERLAP, path: '$', message: `跨度 ${sorted[i - 1].span_id} 与 ${sorted[i].span_id} 重叠：整批拒绝` }],
          conflicts: [{ span_id: `${sorted[i - 1].span_id}/${sorted[i].span_id}`, reason: '两个授权跨度互相重叠，无法判定应用顺序', patches: [...sorted[i - 1].patch_ids, ...sorted[i].patch_ids] }],
        };
      }
    }

    // 问题覆盖：每个已选问题都必须有处置（patched 必须能反向找到补丁）。
    const dispositionMap = new Map();
    for (const d of patch.dispositions || []) dispositionMap.set(String(d.issue_id), d);
    const patchedIssues = new Set();
    const noopIssues = [];
    for (const pl of planned) pl.issue_ids.forEach((id) => patchedIssues.add(id));
    /**
     * 2026-10-13（T33）：把"理由是否可核验"一路带到覆盖表。
     * 之前只搬 reason，新加的标记会被这一层**静默丢掉** —— 也就是"实现写了但界面拿不到"，
     * 与 §2 P0-A 要求的"不能直接渲染成已改理由"正相反。
     * 取"第一个处理该 issue 的补丁"的理由：同 issue 多补丁时只要有一条理由对不上，
     * 就不该把整条处置显示为可信。
     */
    const reasonUnverifiedFor = (issueId) => {
      const own = planned.filter((pl) => pl.issue_ids.map(String).includes(String(issueId)));
      const bad = own.find((pl) => pl.reason_unverified === true);
      const first = own.find((pl) => String(pl.reason || '').trim());
      return {
        unverified: !!bad || (first ? first.reason_unverified === true : false),
        reason: first ? first.reason : '',
      };
    };
    const coverage = [];
    for (const id of selected ? [...selected] : []) {
      const d = dispositionMap.get(String(id));
      if (patchedIssues.has(String(id))) {
        // T19：模型明确声明"只解决局部"时，覆盖表必须如实照搬 —— 不能因为"有补丁落在授权跨度上"
        // 就把它显示成完全解决（"改了 2 个 span" ≠ "2 个问题全部解决"，§6.4）。
        const partial = d && d.status === 'partially_resolved';
        const rv = reasonUnverifiedFor(id);
        coverage.push({
          issue_id: String(id),
          status: partial ? 'partially_resolved' : 'patched',
          reason: d ? d.reason : '',
          // 理由错配的两种来源：处置自述（R06 形态）或补丁自述。**任一**就算不可核验。
          reason_unverified: !!(d && d.reason_unverified) || rv.unverified,
          ...(d && d.foreign_reference && d.foreign_reference.length ? { foreign_reference: d.foreign_reference } : {}),
        });
        continue;
      }
      if (d && (d.status === 'keep' || d.status === 'deferred' || d.status === 'blocked')) {
        coverage.push({
          issue_id: String(id),
          status: d.status,
          reason: d.reason,
          reason_unverified: !!d.reason_unverified,
          ...(d.foreign_reference && d.foreign_reference.length ? { foreign_reference: d.foreign_reference } : {}),
        });
        continue;
      }
      if (d && d.status === 'patched') {
        // 声称改了，却找不到对应补丁 —— 不能只信一句"已修复"。
        coverage.push({ issue_id: String(id), status: 'unaccounted', reason: `声明 patched 但没有对应补丁${d.reason ? `（${d.reason}）` : ''}` });
        continue;
      }
      coverage.push({ issue_id: String(id), status: 'unaccounted', reason: '模型没有给出处置（既没有补丁，也没有 keep/deferred/blocked 理由）' });
    }
    const staleDispositions = (patch.dispositions || []).filter((d) => selected && !selected.has(String(d.issue_id)));

    return {
      ok: true,
      plan: {
        schema_version: SCHEMA_VERSION,
        snapshot_id: snapshotId,
        base_hash: baseHash,
        chapter_id: chapterId,
        patches: planned,
        coverage,
        coverage_ok: coverage.every((c) => c.status !== 'unaccounted'),
        unaccounted: coverage.filter((c) => c.status === 'unaccounted'),
        stale_dispositions: staleDispositions,
        legacy: !!decoded.legacy,
        // 同组失败的跨度与原因必须可见（"未完成项要显示"，不能因为它没进候选就消失）。
        group_failures: [...groupFailures.entries()].map(([group_id, codes]) => ({ group_id, codes })),
        skipped_spans: skipped.map((e) => ({ span_id: e.spanObj.span_id, patch_id: e.p.patch_id, group_id: e.p.group_id || e.p.patch_id })),
        errors,
      },
    };
  }

  // ── 五、写回 ─────────────────────────────────────────────────────────────
  /**
   * 按计划写回正文：**从后向前**在原文切片上重建。
   * 关键不变量：未授权范围的字符**逐字不变**（不是"看起来差不多"，而是同一份切片）。
   * @returns {{text:string, applied:Array, noop:Array, unchanged_ok:boolean}}
   */
  function applyPlan(text, plan) {
    const base = String(text == null ? '' : text);
    const patches = (plan && Array.isArray(plan.patches) ? plan.patches : []).slice().sort((a, b) => b.start - a.start);
    let out = base;
    const applied = [];
    const noop = [];
    for (const p of patches) {
      if (base.slice(p.start, p.end) !== p.original) {
        // 计划是对着这份快照编译的；真到写回时原文已经不同 → 不猜，交给上层按 stale 处理。
        return { text: base, applied: [], noop: [], unchanged_ok: false, stale_patch: p.span_id };
      }
      if (p.op === 'replace' && p.replacement === p.original) {
        noop.push({ span_id: p.span_id, issue_ids: p.issue_ids, reason: 'replacement 与原文逐字相同：合法 no-op，不计入实际改动' });
        continue;
      }
      if (p.op === 'delete' && p.original === '') {
        noop.push({ span_id: p.span_id, issue_ids: p.issue_ids, reason: '空跨度删除：合法 no-op' });
        continue;
      }
      out = out.slice(0, p.start) + (p.op === 'delete' ? '' : p.replacement) + out.slice(p.end);
      applied.push({ span_id: p.span_id, issue_ids: p.issue_ids, op: p.op, original: p.original, replacement: p.op === 'delete' ? '' : p.replacement, start: p.start, end: p.end });
    }
    return { text: out, applied, noop, unchanged_ok: true };
  }

  /** 授权的连续跨度合并（E05：需要合并两个相邻段时，Host 显式授予覆盖两段的连续 span）。 */
  function mergeAdjacentSpans(text, spans) {
    const src = String(text == null ? '' : text);
    const list = (spans || []).slice()
      .map((sp) => ({ ...sp, end: sp.end == null ? sp.start : sp.end, sep_end: sp.sep_end == null ? sp.end : sp.sep_end }))
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const sp of list) {
      const last = out[out.length - 1];
      // 相邻 = 本跨度起点落在上一跨度（含其段尾分隔符）之内或紧接其后。
      if (last && sp.start <= last.sep_end) {
        last.end = Math.max(last.end, sp.end);
        last.sep_end = Math.max(last.sep_end, sp.sep_end);
        last.span_id = `${last.span_id}+${sp.span_id}`;
        last.text = src.slice(last.start, last.end);
        last.merged = true;
      } else out.push({ ...sp });
    }
    return out;
  }

  // ── 六、组合安全核验 ─────────────────────────────────────────────────────
  /**
   * 组合核验（§6.5 + P08）：**单条通过不等于整组通过**。
   * 两条单独安全的删除，合起来可能删光"她"的先行语或直播来源。
   *
   * 做法：对**组合后的候选文本**跑一次 patch-safety 的 verifyPatchedText（它专门回答
   * "被删掉的这段里，有哪些东西是后文还在用的"），把硬码命中视为"本组不可自动采纳"。
   * 门禁不可用 / 抛错 → `safety_unavailable`：**候选仍可看**，但不得被称为"已验证"。
   *
   * @param {string} baseText 原快照正文
   * @param {string} candidateText 组合后的候选正文
   * @param {{engine?:object, opts?:object}} ctx engine 显式注入便于测试（默认取 globalThis.NovelPatchSafety）
   */
  function verifyCombinedCandidate(baseText, candidateText, ctx = {}) {
    const engine = ctx.engine !== undefined ? ctx.engine : (typeof globalThis !== 'undefined' ? globalThis.NovelPatchSafety : null);
    const base = String(baseText == null ? '' : baseText);
    const candidate = String(candidateText == null ? '' : candidateText);
    if (candidate === base) {
      return { status: 'unchanged', findings: [], hard: [], blocked: false, verified: false, note: '候选与原文逐字相同：没有需要核验的改动' };
    }
    const missing = !engine
      || typeof engine.deletionRisks !== 'function'
      || typeof engine.paragraphsOf !== 'function';
    const unavailable = (why) => ({
      status: ERROR_CODES.SAFETY_UNAVAILABLE,
      findings: [{ code: ERROR_CODES.SAFETY_UNAVAILABLE, reason: why }],
      hard: [],
      blocked: false,
      verified: false,
      note: '候选可看，但不能被称为"已验证"（未核验 ≠ 安全）',
    });
    if (missing) return unavailable('组合核验模块未加载：这一版候选没有被核验（不等于安全）');

    const findings = [];
    let malformed = null;
    const hasPlan = !!(ctx.plan && Array.isArray(ctx.plan.patches) && ctx.plan.patches.length);
    try {
      if (hasPlan) {
        // ① 精确路径（2026-10-09 审查修复）：**不再**用 `verifyPatchedText` 的"改过的段 = 被删的段"
        //    那套对齐 —— 它把 `revised` 传成空串，于是"段内只改一句"在证据面里等于"整段被删"，
        //    与真实候选不是同一份文本（实测会把安全改动误判成 object_provenance）。
        //    这里按真实计划逐段落重放（含转场桥），再补上全章级判据（事实锁 / 跨段重复）。
        const more = combinedDeletionFindings(base, candidate, ctx.plan, engine, ctx.opts || {});
        if (more === null) malformed = 'deletionRisks 返回畸形结果（不是数组）';
        else findings.push(...more);
        if (!malformed) findings.push(...chapterLevelFindings(base, candidate, engine, ctx.opts || {}));
      } else {
        // ② 没有计划（历史/外部调用）→ 沿用既有 verifyPatchedText 的整章对照语义。
        if (typeof engine.verifyPatchedText === 'function') {
          const v = engine.verifyPatchedText(base, candidate, ctx.opts || {});
          if (!v || !Array.isArray(v.findings)) malformed = 'verifyPatchedText 返回畸形结果（findings 不是数组）';
          else findings.push(...v.findings);
        }
      }
    } catch (e) {
      return unavailable(`组合核验执行出错（${e && e.message ? e.message : e}）：这一版候选没有被核验`);
    }
    if (malformed) return unavailable(`${malformed}：这一版候选没有被核验（畸形结果不得被当成"没有断裂"）`);
    // 每条 finding 必须是有 code 的对象：门禁返回半截数据结构时，宁可标成"未核验"。
    if (findings.some((f) => !f || typeof f !== 'object' || typeof f.code !== 'string' || !f.code)) {
      return unavailable('核验结果里存在没有结论码的条目：按"未核验"处理，不冒充安全通过');
    }
    const hard = new Set((engine.HARD_CODES && engine.HARD_CODES.length ? engine.HARD_CODES : ['protected_content', 'story_fact', 'object_provenance', 'reference_anchor', 'scene_anchor', 'fact_lock_conflict']));
    // 同一处断裂可能同时被"整段消失"与"组合逐段重算"两条路径发现 —— 去重后再报，不重复占用作者注意力。
    const seen = new Set();
    const unique = [];
    for (const f of findings) {
      const key = `${f.code}|${f.paragraph}|${f.excerpt}|${f.token || ''}|${f.subject || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(f);
    }
    const hardHits = unique.filter((f) => hard.has(f.code));
    const mappingFailed = unique.some((f) => f.code === ERROR_CODES.UNSUPPORTED_MAPPING);
    return {
      status: hardHits.length ? ERROR_CODES.SAFETY_BLOCKED : (mappingFailed ? ERROR_CODES.UNSUPPORTED_MAPPING : 'ok'),
      findings: unique,
      hard: hardHits,
      blocked: hardHits.length > 0,
      verified: !mappingFailed,
      note: hardHits.length
        ? '组合后仍有结构性断裂：本组不进入可自动采纳集（候选保留给作者判断）'
        : (mappingFailed ? '组合稿映射不确定：候选可看，但不得被称为"已验证"' : '组合核验未发现新增断裂'),
    };
  }

  /**
   * 全章级判据（事实锁冲突 / 跨段逐字重复 / 百分比合计）：与既有 `verifyPatchedText` 同源，
   * 但用的是**导出原语**，所以能和精确路径共存而不必借道它的"改过=被删"对齐。
   * `fact_lock_conflict` 只报**本版新制造**的那些（底稿自带的历史矛盾不算在这一次改动头上），
   * 与 verifyPatchedText 的口径一致（标记 `blocked:true` 让它按硬码上报）。
   */
  function chapterLevelFindings(baseText, candidateText, engine, opts) {
    const out = [];
    if (typeof engine.scanFactLock === 'function') {
      const before = engine.scanFactLock(baseText, opts).filter((f) => f && f.code === 'fact_lock_conflict');
      for (const f of engine.scanFactLock(candidateText, opts)) {
        if (!f || typeof f.code !== 'string') continue;
        if (f.code !== 'fact_lock_conflict') { out.push(f); continue; }
        if (before.some((b) => b.value === f.value && b.reason === f.reason)) continue;
        out.push({ ...f, blocked: true });
      }
    }
    if (typeof engine.scanCrossParagraphDuplicates === 'function') {
      const dup = engine.scanCrossParagraphDuplicates(candidateText);
      if (Array.isArray(dup)) out.push(...dup);
    }
    return out;
  }

  /**
   * 组合专项核验：把"这一批补丁**一起**应用后的全文"当作 deletionRisks 的证据面。
   * 逐条判定（gatePatches）看不到的正是这一类：两处各自都还留下一个人称锚点，
   * 合起来一个也不剩。返回 findings（不判"该不该改"，只报断裂）。
   */
  function combinedDeletionFindings(baseText, candidateText, plan, engine, opts) {
    const out = [];
    const spans = buildSpans(baseText, { sentences: false });
    const byPara = new Map();
    for (const p of plan.patches) {
      let idx = Number(p.paragraph_index);
      if (!Number.isFinite(idx)) {
        idx = spans.findIndex((sp) => sp.start <= p.start && p.end <= sp.sep_end);
      }
      if (!Number.isFinite(idx) || idx < 0 || !spans[idx]) continue;
      if (!byPara.has(idx)) byPara.set(idx, []);
      byPara.get(idx).push(p);
    }
    if (!byPara.size) return out;

    const trimmed = (x) => String(x == null ? '' : x).trim();
    const rows = [];
    for (let i = 0; i < spans.length; i += 1) {
      const sp = spans[i];
      // ⚠️ 坐标系必须统一（2026-10-09 审查修复）：`sp.text` 是**原始**段落文本（可能带前导空白），
      // 而 plan 的 start/end 也是相对原文的。此前先用 trimmed 文本、又拿原始偏移去切，
      // 段落一带缩进就会切错位 → 重建与候选不符 → 组合核验直接 early return 并给作者一条假警告。
      const rawPara = String(sp.text == null ? '' : sp.text);
      const before = trimmed(rawPara);
      const pats = (byPara.get(i) || []).slice().sort((a, b) => b.start - a.start);
      let removed = false;
      let text = rawPara;
      for (const p of pats) {
        // 只有 **delete** 且覆盖整段时才是"这一段没了"；replace 覆盖整段是"这一段被换掉"。
        if (p.op === 'delete' && p.start <= sp.start && p.end >= sp.end) { removed = true; text = ''; continue; }
        const relStart = Math.max(0, Math.min(rawPara.length, p.start - sp.start));
        const relEnd = Math.max(relStart, Math.min(rawPara.length, p.end - sp.start));
        text = text.slice(0, relStart) + (p.op === 'delete' ? '' : p.replacement) + text.slice(relEnd);
      }
      rows.push({ before, after: removed ? '' : trimmed(text), changed: !!pats.length });
    }
    // 段号口径与 applyOne 一致：整段被删时，是"后一段顶上来的位置"。
    const candidateJoin = rows.map((r) => r.after).filter(Boolean).join('\n\n');
    // 自证：逐段重放出来的组合稿必须与真实候选正文（按同一分段口径）一致。
    // 不一致说明"计划 → 候选"的映射不可靠 —— 如实报出来，而不是拿另一份文本当证据。
    const expectedJoin = engine.paragraphsOf(candidateText).join('\n\n');
    if (expectedJoin !== candidateJoin) {
      out.push({
        code: ERROR_CODES.UNSUPPORTED_MAPPING,
        combined: true,
        reason: '组合稿的段落重建与候选正文不一致：本组的组合核验结论不成立（映射不确定，未验证）',
      });
      return out;
    }
    let cursor = 0;
    for (const r of rows) {
      const index = cursor;
      if (r.after) cursor += 1;
      if (!r.changed || r.before === r.after) continue;
      const risks = engine.deletionRisks(candidateJoin, r.before, r.after, index, opts);
      if (!Array.isArray(risks)) return null;   // 畸形返回：由调用方标成"未核验"，不静默当成"没有断裂"
      for (const risk of risks) out.push({ ...risk, combined: true });
      // 转场桥：与 verifyPatchedText 同口径（它也是逐段调这个函数），但这里用的是**真实**改前/改后。
      if (typeof engine.sceneBridgeRisks === 'function') {
        const bridges = engine.sceneBridgeRisks(candidateJoin, r.before, r.after, index, opts);
        if (Array.isArray(bridges)) for (const b of bridges) out.push({ ...b, combined: true });
      }
    }
    return out;
  }

  // ── 七、幂等与版本 ───────────────────────────────────────────────────────
  /** 选择集指纹（作者勾了哪些问题）：同一次选择重复提交必须得到同一个键。 */
  function selectionHash(issueIds, snapshotId) {
    const ids = (Array.isArray(issueIds) ? issueIds : []).map(String).slice().sort();
    return textFingerprint(`${String(snapshotId || '')}::${ids.join('|')}`);
  }
  /**
   * 幂等键（P11）：取消后晚到的响应、刷新后的"接回进度"、重复点击"采纳"都应落到同一个键。
   * 键里必须含快照与选择集 —— 换了稿或换了勾选就是**新任务**，不应复用旧候选。
   */
  function idempotencyKey({ snapshotId, baseHash, issueIds, patches }) {
    const patchIds = (Array.isArray(patches) ? patches : []).map((p) => `${p.span_id || ''}:${p.op || ''}`).sort();
    return `rev2:${textFingerprint(`${snapshotId || ''}|${baseHash || ''}|${selectionHash(issueIds, snapshotId)}|${patchIds.join(',')}`)}`;
  }

  /** 源稿是否已变化（P10）：与快照比对，变化即 stale —— 不猜、不重定位。 */
  function staleCheck(snapshot, currentText) {
    const base = String(snapshot && snapshot.body_text != null ? snapshot.body_text : '');
    const cur = String(currentText == null ? '' : currentText);
    if (cur === base) return { stale: false };
    const expected = String((snapshot && snapshot.body_hash) || textFingerprint(base));
    return {
      stale: true,
      expected_hash: expected,
      actual_hash: textFingerprint(cur),
      reason: '源稿在审稿/修稿期间发生了变化：旧补丁不得套用到新稿（既不猜位置，也不覆盖新稿）',
    };
  }

  /** 有界重试预算（§6.6）：跨刷新恢复共享同一预算，不叠成无限调用。 */
  function createRetryBudget({ max = 2, used = 0 } = {}) {
    let spent = Math.max(0, Number(used) || 0);
    const limit = Math.max(0, Number(max) || 0);
    return {
      limit,
      get used() { return spent; },
      get remaining() { return Math.max(0, limit - spent); },
      take() {
        if (spent >= limit) return { ok: false, error_code: ERROR_CODES.BUDGET_EXHAUSTED, remaining: 0 };
        spent += 1;
        return { ok: true, remaining: limit - spent };
      },
      toJSON() { return { max: limit, used: spent, remaining: Math.max(0, limit - spent) }; },
    };
  }

  /**
   * 逐条门禁：复用既有 patch-safety 的 `gatePatches`（逐条粒度、判据与词表都在那边）。
   *
   * 为什么要先过门禁再写回，而不是写完再核验：
   *   "命中的那一条补丁**不进差异稿**"是既有产品语义（frontend-test 94b/94d/94e/94k），
   *   全部命中时正文必须**原样保留**、且**不产生整章重写**。
   *
   * ⚠️ 2026-10-09（审查修复，高）：门禁的定位/应用模型是**段落级**（patch-safety 的
   *   `locateParagraph` + `applyOne` 里 `next[at] = revised` / `splice(at,1)`），因此**不能**
   *   把"跨度原文/跨度替换"当 anchor/revised 递进去 —— 那等于告诉门禁"整段被换成了这一句"，
   *   于是"段内只改一句"会被按"整段被删"误判（实测：`object_provenance` 误拦，作者看到
   *   "删掉了后文仍在使用的物件来源"，而实际上那个词还在同一段里）。
   *   这里改成按**段落级 before/after** 构造模拟补丁：anchor = 该跨度所属段落的原文，
   *   revised = 该段落应用本补丁后的全文（整段删除 → 空串，与门禁的 splice 语义一致）。
   *
   * 门禁不可用/抛错 → **fail-closed：`allowed: []`** + `safety_unavailable`
   * （2026-10-12，0731 增补方案 P0-C）。
   *
   * ⚠️ 为什么这里从"放行全部"改成"全部不放行"：旧行为在门禁缺失或抛错时返回
   *   `allowed: patches.slice()`，虽然界面会显示"未验证 / 安全阻断"，但**候选文本仍被形成**，
   *   于是"安全门禁没跑"这件事的实际后果是"补丁照常可被采纳"——门禁失灵时保护恰好消失，
   *   这是最坏的一种默认值。改成 fail-closed 后：拿不到安全结论就不产出可应用候选，
   *   原文哈希不变；作者仍有明确的手动编辑、独立授权的整章任务与历史报告浏览能力，
   *   机器门禁失灵**不阻断人的自主编辑**。
   */
  function gatePlanPatches(baseText, plan, engine, opts = {}) {
    const patches = (plan && Array.isArray(plan.patches) ? plan.patches : []);
    if (!patches.length) return { available: true, allowed: [], blocked: [], findings: [], allBlocked: false };
    // fail-closed：不产出可应用候选，但把每一条都列进 blocked 并说明"安全结论缺失"，
    // 而不是静默丢弃——作者需要看到"这些补丁为什么没被应用"。
    const unavailableBlocked = () => patches.map((p) => ({
      span_id: p.span_id, patch_ids: p.patch_ids, issue_ids: p.issue_ids,
      code: ERROR_CODES.SAFETY_UNAVAILABLE,
      reason: '安全门禁不可用：本次不产出任何可自动应用的候选（原文未改动）。请人工核对后再决定是否手改。',
      conflict: null, risks: [],
    }));
    if (!engine || typeof engine.gatePatches !== 'function') {
      return {
        available: false,
        allowed: [],
        blocked: unavailableBlocked(),
        findings: [{ code: ERROR_CODES.SAFETY_UNAVAILABLE, reason: '安全门禁模块未加载：本次没有任何补丁被放行（原文未改动，需人工复核）' }],
        allBlocked: patches.length > 0,
      };
    }
    try {
      const paraSpans = buildSpans(String(baseText == null ? '' : baseText), { sentences: false });
      const shaped = patches.map((p) => {
        const para = paraSpans.find((sp) => sp.start <= p.start && p.end <= sp.sep_end) || null;
        if (!para) {
          // 找不到所属段落（理论上不会发生：计划由同一份文本编译）：退回跨度形态并**如实标注**，
          // 而不是假装按段落算过。
          return { issue: p.issue_ids.length ? p.issue_ids[0] : 0, anchor: p.original, revised: p.op === 'delete' ? '' : p.replacement };
        }
        const raw = para.text;
        const relStart = Math.max(0, Math.min(raw.length, p.start - para.start));
        const relEnd = Math.max(relStart, Math.min(raw.length, p.end - para.start));
        const afterPara = raw.slice(0, relStart) + (p.op === 'delete' ? '' : p.replacement) + raw.slice(relEnd);
        return { issue: p.issue_ids.length ? p.issue_ids[0] : 0, anchor: raw, revised: afterPara };
      });
      const g = engine.gatePatches(baseText, shaped, opts || {});
      const blockedIdx = new Set((Array.isArray(g.blocked) ? g.blocked : []).map((b) => Number(b && b.index)).filter((n) => Number.isFinite(n)));
      const allowed = [];
      const blocked = [];
      patches.forEach((p, i) => {
        if (blockedIdx.has(i)) {
          const b = g.blocked.find((x) => Number(x.index) === i) || {};
          blocked.push({
            span_id: p.span_id, patch_ids: p.patch_ids, issue_ids: p.issue_ids,
            code: b.code || 'safety_blocked', reason: b.reason || '被安全门禁拦下',
            conflict: b.conflict || null, risks: b.risks || [],
          });
          return;
        }
        // 跨度内的"事实增量过大"：门禁的 expansion 判据是**段落级**比值（`r.length > a.length*2 && Δ>=60`），
        // 按段落整形后它对"在授权跨度里塞进一整段新内容"不再敏感。这里按**跨度级**补回同一判据
        // （只收紧、不放松），否则修上面那处误拦会顺带开一个真实的缺口。
        const grew = p.op !== 'delete' && p.replacement.length > p.original.length * 2
          && p.replacement.length - p.original.length >= 60;
        if (grew) {
          blocked.push({
            span_id: p.span_id, patch_ids: p.patch_ids, issue_ids: p.issue_ids,
            code: 'story_fact',
            reason: `这条改动在授权跨度内把内容撑到原文的 ${(p.replacement.length / Math.max(1, p.original.length)).toFixed(1)} 倍`
              + `（+${p.replacement.length - p.original.length} 字）：疑似顺手新增剧情，按安全策略不自动应用`,
            conflict: null,
            risks: [{ code: 'span_expansion', span_id: p.span_id, reason: '跨度级事实增量过大', evidence: `${p.original.length}→${p.replacement.length} 字` }],
          });
          return;
        }
        allowed.push(p);
      });
      return {
        available: true,
        allowed,
        blocked,
        findings: Array.isArray(g.findings) ? g.findings : [],
        allBlocked: allowed.length === 0 && blocked.length > 0,
      };
    } catch (e) {
      return {
        available: false,
        allowed: [],
        blocked: unavailableBlocked(),
        findings: [{ code: ERROR_CODES.SAFETY_UNAVAILABLE, reason: `安全门禁执行出错（${e && e.message ? e.message : e}）：本次没有任何补丁被放行（原文未改动，需人工复核）` }],
        allBlocked: patches.length > 0,
      };
    }
  }

  /** 一次完整解码+校验+门禁+写回+组合核验的编排（确定性部分），供 app.js 与测试共用同一入口。 */
  function runRevisionPipeline({ snapshot, raw, selectedIssueIds, contextOnlySpanIds, chapterId, engine, gateOpts, authorization, expectedSchemaVersion, allowLegacy, issueQuotes } = {}) {
    const baseText = String(snapshot && snapshot.body_text != null ? snapshot.body_text : '');
    const decoded = decodePatchOutput(raw, { expectedSchemaVersion, allowLegacy });
    if (!decoded.ok) {
      return { ok: false, error_code: decoded.error_code, errors: decoded.errors, mode: decoded.mode, text: baseText, applied: [], unresolved: [], coverage: [], noop: false };
    }
    // 双保险：调用方显式 `allowLegacy:false` 时，即便载荷没有版本字段也不接受兼容语义。
    if (decoded.legacy && allowLegacy === false) {
      return {
        ok: false, error_code: ERROR_CODES.INCOMPATIBLE_LEGACY, mode: 'legacy',
        errors: [{ code: ERROR_CODES.INCOMPATIBLE_LEGACY, path: '$', message: '本次修稿不接受旧格式（anchor/revised）：按格式不兼容处理，未改动任何文字' }],
        text: baseText, applied: [], unresolved: [], coverage: [], noop: false,
      };
    }
    // ⚠️ 2026-10-11（S05-1，§6.3 双重授权）：期望 v2 的作业**必须**带 Host 授权表。
    //   授权表缺失时 `planPatchApplication` 会退到"只认 issue 在已选集合里 + 采信模型自报的
    //   span_id/span 偏移"这条**弱校验**路径 —— 那正是"选中 ≠ 授权"的越权面。
    //   fail-closed：这里在规划之前就拒绝，而不是让它带着一半校验跑完。
    if (Number(expectedSchemaVersion) === SCHEMA_VERSION && !authorization) {
      return {
        ok: false, error_code: ERROR_CODES.OUT_OF_SCOPE, mode: decoded.mode,
        errors: [{
          code: ERROR_CODES.AUTHORIZATION_REQUIRED, path: '$',
          message: '本次是 v2 修稿作业但缺少 Host 授权表：无法校验"该问题是否有权改这个跨度"，'
            + '按双重授权契约拒绝执行，未改动任何文字',
        }],
        text: baseText, applied: [], unresolved: [], coverage: [], noop: false,
      };
    }
    const planned = planPatchApplication(snapshot, decoded, { selectedIssueIds, contextOnlySpanIds, chapter_id: chapterId, authorization });
    if (!planned.ok) {
      return { ok: false, error_code: planned.error_code, errors: planned.errors, conflicts: planned.conflicts, mode: decoded.mode, text: baseText, applied: [], unresolved: [], coverage: [], noop: false };
    }
    const plan = planned.plan;
    // ① 逐条门禁（拦下的那条不进候选）。
    const gate = gatePlanPatches(baseText, plan, engine, gateOpts || {});
    const activePlan = { ...plan, patches: gate.allowed };
    const result = applyPlan(baseText, activePlan);
    if (!result.unchanged_ok) {
      return { ok: false, error_code: ERROR_CODES.STALE, errors: [{ code: 'stale_at_apply', path: `$.patches[${result.stale_patch}]`, message: '写回时原文与计划不一致：按 stale 处理，未改动任何字符' }], mode: decoded.mode, text: baseText, applied: [], unresolved: [], coverage: plan.coverage, noop: false };
    }
    const unresolved = [];
    for (const c of plan.coverage) {
      // T19：`partially_resolved` 也是"未完成项"——作者必须能看到"这条还没解决完"，
      // 不能因为它是模型主动声明的就把它从未完成清单里漏掉。
      if (c.status === 'unaccounted' || c.status === 'blocked' || c.status === 'partially_resolved') unresolved.push({ issue_id: c.issue_id, reason: c.reason || c.status, status: c.status });
    }
    // 失败的依赖组里的**已解析**补丁不会进候选，但必须显示给作者（"未完成项"）。
    for (const s of plan.skipped_spans || []) {
      unresolved.push({ span_id: s.span_id, patch_id: s.patch_id, group_id: s.group_id, status: 'blocked', reason: '同组另一条补丁未通过校验：整组不进入本次候选' });
    }
    for (const b of gate.blocked) {
      unresolved.push({ span_id: b.span_id, patch_ids: b.patch_ids, issue_ids: b.issue_ids, status: 'blocked', code: b.code, reason: b.reason, conflict: b.conflict });
    }
    const blockedIssueIds = new Set(gate.blocked.flatMap((b) => b.issue_ids || []).map(String));
    const coverage = plan.coverage.map((c) => (blockedIssueIds.has(String(c.issue_id)) && c.status === 'patched'
      ? { ...c, status: 'blocked', reason: '这条问题的补丁被安全门禁拦下（未进候选）' }
      : c));

    const base = {
      ok: true, mode: decoded.mode, text: result.text,
      applied: result.applied, unresolved,
      plan: activePlan, blocked: gate.blocked,
      safety_findings: gate.findings,
      safety_available: gate.available,
      allBlocked: gate.allBlocked,
      coverage, coverage_ok: coverage.every((c) => c.status !== 'unaccounted'),
      unaccounted: coverage.filter((c) => c.status === 'unaccounted'),
      // §4 修后核验：候选（不阻断），需要调用方提供每个 issue 的逐字引用（来自结构化审稿的
      // `findings[].evidence[].quote`）。缺它时为空 —— 如实"没做这项核验"，不伪造结论。
      issue_coverage: issueCoverageCandidates({ issues: issueQuotes, coverage, revisedText: result.text }),
      noop_reasons: result.noop,
    };

    // ② 没有任何补丁进候选：三种情况必须分开（2026-10-12，0731 增补方案 P0-C）——
    //    a) 门禁不可用/抛错 → fail-closed：正文不变，状态如实是 `safety_unavailable`；
    //    b) 补丁全部被门禁拦下 → 正文不变，状态如实是 `blocked`；
    //    c) 模型本来就都是 keep → 才是真正的 `unchanged`（"没有需要核验的改动"）。
    //    ⚠️ 旧实现在这里只问 `result.text === baseText` 就返回 `unchanged`：于是 a)/b) 两件
    //    **安全事件**被降级成 c) 那句"没有需要核验的改动"——把一次门禁失效说成无事发生。
    if (!activePlan.patches.length) {
      const noop = !gate.blocked.length;
      const safetyUnavailable = !gate.available;
      const combined = safetyUnavailable
        ? {
          status: ERROR_CODES.SAFETY_UNAVAILABLE,
          findings: gate.findings,
          hard: [], blocked: false, verified: false,
          note: '安全门禁不可用：本次未核验任何补丁，正文保持原样（未核验 ≠ 安全，可人工编辑后重试）',
        }
        : (result.text === baseText
          ? { status: 'unchanged', findings: [], hard: [], blocked: false, verified: false, note: '候选与原文逐字相同：没有需要核验的改动' }
          : verifyCombinedCandidate(baseText, result.text, { engine, opts: gateOpts, plan: activePlan }));
      return {
        ...base,
        noop,
        allBlocked: gate.allBlocked || (!noop && result.text === baseText),
        combined,
        status_note: safetyUnavailable
          ? '安全门禁不可用：本次没有任何补丁被放行（正文保持原样），需人工复核'
          : (noop
            ? '合法无修改：本批次没有任何补丁需要应用'
            : '本批次的补丁全部被安全门禁拦下（正文保持原样），未回退整章重写'),
        verified: false,
        safety_blocked: !noop && gate.blocked.length > 0,
      };
    }

    // ③ 组合核验（单条通过 ≠ 整组通过）。
    const combined = verifyCombinedCandidate(baseText, result.text, { engine, opts: gateOpts, plan: activePlan });
    const noop = result.applied.length === 0;
    return {
      ...base,
      noop,
      combined,
      safety_blocked: combined.blocked || gate.blocked.length > 0 || !gate.available,
      verified: gate.available && combined.verified && !combined.blocked && gate.blocked.length === 0,
    };
  }

  return {
    VERSION,
    SCHEMA_VERSION,
    NORMALIZATION_VERSION,
    MAX_VALUE_CHARS,
    ERROR_CODES,
    parseStrictJSON,
    extractJSONCandidates,
    textFingerprint,
    snapshotOf,
    buildSpans,
    spanIndex,
    splitSentences,
    decodePatchOutput,
    planPatchApplication,
    gatePlanPatches,
    applyPlan,
    mergeAdjacentSpans,
    verifyCombinedCandidate,
    selectionHash,
    idempotencyKey,
    staleCheck,
    createRetryBudget,
    runRevisionPipeline,
    // v1.2.1 质量闭环：v2 授权表键（authorized_targets）与 v1（authorized）读同一张表。
    authorizationTable,
    // §4 修后核验：单独导出，便于离线断言直接喂 (issues, coverage, revisedText) 而不必经整条管线。
    issueCoverageCandidates,
    // 2026-03-17（v118 0317 §4 · V118-12）：修后结论闸单独导出 ——
    // 它是"旧引文消失 ≠ 问题解决"这句契约的唯一落点，必须能被单独断言（含语义层通过的反例）。
    coverageVerdict,
  };
});
