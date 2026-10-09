/*
 * 局部补丁协议 v2（Revision Patch v2）——纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要它（2026-10-08，《叙事性专项修复》E01／P0）：现有链路有四个真实缺陷，
 * 每一个都会把"只改被点名的几处"变成"改坏正文"或"多花一次钱"：
 *   ① **删不掉**：`applyRevisionPatches` 把「改后内容为空」一律判成 unresolved，
 *      于是"然后她不一样了。"这种整段删除只能靠换一句同样多余的旁白来绕开。
 *   ② **坏元素被折叠成"合法空补丁"**：`{"patches":[{}]}` 在旧实现里被逐条丢掉后返回 `[]`，
 *      而 `[]` 是合法 noop —— 界面于是显示"模型判断没有需要改动"，把一次解析事故说成结论。
 *   ③ **少量定位授权整段替换**：`anchor` 落在某段内部时，旧实现直接替换**整段**，
 *      与"只授权这一句"的授权范围不一致（P06）。
 *   ④ **失败扩大为整章重写**：解析失败/全部未命中都会回退整章重写（一次付费、且没有门禁的整章覆盖）。
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
    UNSUPPORTED_MAPPING: 'unsupported_mapping',
    BUDGET_EXHAUSTED: 'budget_exhausted',
    CANCELLED: 'cancelled',
  };

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
   * @returns {{ok:true, mode:'v2'|'legacy', patch:object, legacy:boolean}
   *          |{ok:false, error_code:string, errors:Array, mode:string}}
   */
  function decodePatchOutput(raw) {
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
      let op = opRaw;
      if (op === undefined || op === null) op = 'replace';
      if (op !== 'replace' && op !== 'delete') {
        opError(errors, 'unknown_op', `${at}.op`, `未知操作：${JSON.stringify(opRaw)}（只接受 replace / delete）`);
        dropped += 1;
        return;
      }
      if (!hasReplacement) {
        // 关键区分：**缺失** replacement 不是删除。
        opError(errors, 'missing_replacement', `${at}.replacement`,
          op === 'delete' ? 'delete 必须显式给出 replacement:""（缺失不等于删除）' : 'replace 缺少 replacement 字段');
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
        if (!['patched', 'keep', 'deferred', 'blocked'].includes(status)) {
          return { ok: false, error_code: ERROR_CODES.SCHEMA_ERROR, mode, errors: [{ code: 'bad_disposition_status', path: `${at}.status`, message: `未知处置状态：${JSON.stringify(d.status)}（只接受 patched / keep / deferred / blocked）` }] };
        }
        dispositions.push({ issue_id: d.issue_id, status, reason: isStr(d.reason) ? d.reason : '' });
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
   * 把解好的补丁落到具体跨度上，并做**授权范围**校验。
   *
   * 校验项（§6.3/§6.4/§6.5）：
   *   · snapshot_id / base_hash 必须与当前快照一致 —— 否则 `stale`（不猜、不重定位）；
   *   · `original` 必须与快照跨度**逐字相等** —— 否则 `anchor_mismatch`；
   *   · issue_ids 必须是**本次已选**的问题 —— 否则 `out_of_scope` / `selection_mismatch`；
   *   · 跨度必须属于本章 —— 否则 `out_of_scope`（别章 / 上下文专用跨度）；
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
    for (const sp of buildSpans(text, { sentences: true, chapter_id: spanChapter })) spans.set(sp.span_id, sp);
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
        spanObj = spanObj || { span_id: p.span_id || `${start}-${end}`, kind: 'explicit', start, end, text: text.slice(start, end), chapter_id: chapterId };
      } else if (span) {
        bodyStart = span.start;
        bodyEnd = span.end;
        start = span.start;
        end = span.end;
        if (p.op === 'delete') {
          // 删除整段时连同段尾分隔符一起授权（否则会凭空多出一个空段）。
          // ① 句子跨度正好等于它的父段落（单句成段）→ 按段落删除处理：
          //    否则同一意图"删掉这一句"会因为模型选 p1 还是 p1s1 而得到两种文本（空段 vs 干净）。
          const parent = span.kind === 'sentence' && span.parent_span_id ? spans.get(span.parent_span_id) : null;
          const whole = parent && String(parent.text) === text.slice(span.start, span.end) ? parent : null;
          const target = whole || span;
          end = target.sep_end;
          // ② 删的是文末那一段：把紧邻在前的分隔符一并纳入，
          //    否则候选会以 "\n\n" 结尾（差别预览与采纳后都多一个空段）。
          if (end >= text.length) {
            const m = text.slice(0, target.start).match(/[\r\n]+$/);
            if (m) start = target.start - m[0].length;
          }
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
    const coverage = [];
    for (const id of selected ? [...selected] : []) {
      const d = dispositionMap.get(String(id));
      if (patchedIssues.has(String(id))) {
        coverage.push({ issue_id: String(id), status: 'patched', reason: d ? d.reason : '' });
        continue;
      }
      if (d && (d.status === 'keep' || d.status === 'deferred' || d.status === 'blocked')) {
        coverage.push({ issue_id: String(id), status: d.status, reason: d.reason });
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
   * 门禁不可用/抛错 → 放行全部但标 `safety_unavailable`（候选可看，不得称为已验证）。
   *
   * ⚠️ 2026-10-09（审查修复，高）：门禁的定位/应用模型是**段落级**（patch-safety 的
   *   `locateParagraph` + `applyOne` 里 `next[at] = revised` / `splice(at,1)`），因此**不能**
   *   把"跨度原文/跨度替换"当 anchor/revised 递进去 —— 那等于告诉门禁"整段被换成了这一句"，
   *   于是"段内只改一句"会被按"整段被删"误判（实测：`object_provenance` 误拦，作者看到
   *   "删掉了后文仍在使用的物件来源"，而实际上那个词还在同一段里）。
   *   这里改成按**段落级 before/after** 构造模拟补丁：anchor = 该跨度所属段落的原文，
   *   revised = 该段落应用本补丁后的全文（整段删除 → 空串，与门禁的 splice 语义一致）。
   */
  function gatePlanPatches(baseText, plan, engine, opts = {}) {
    const patches = (plan && Array.isArray(plan.patches) ? plan.patches : []);
    if (!patches.length) return { available: true, allowed: [], blocked: [], findings: [], allBlocked: false };
    if (!engine || typeof engine.gatePatches !== 'function') {
      return {
        available: false,
        allowed: patches.slice(),
        blocked: [],
        findings: [{ code: ERROR_CODES.SAFETY_UNAVAILABLE, reason: '安全门禁模块未加载：本次没有任何补丁被拦截（这一版需要人工复核）' }],
        allBlocked: false,
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
        allowed: patches.slice(),
        blocked: [],
        findings: [{ code: ERROR_CODES.SAFETY_UNAVAILABLE, reason: `安全门禁执行出错（${e && e.message ? e.message : e}）：本次没有任何补丁被拦截` }],
        allBlocked: false,
      };
    }
  }

  /** 一次完整解码+校验+门禁+写回+组合核验的编排（确定性部分），供 app.js 与测试共用同一入口。 */
  function runRevisionPipeline({ snapshot, raw, selectedIssueIds, contextOnlySpanIds, chapterId, engine, gateOpts } = {}) {
    const baseText = String(snapshot && snapshot.body_text != null ? snapshot.body_text : '');
    const decoded = decodePatchOutput(raw);
    if (!decoded.ok) {
      return { ok: false, error_code: decoded.error_code, errors: decoded.errors, mode: decoded.mode, text: baseText, applied: [], unresolved: [], coverage: [], noop: false };
    }
    const planned = planPatchApplication(snapshot, decoded, { selectedIssueIds, contextOnlySpanIds, chapter_id: chapterId });
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
      if (c.status === 'unaccounted' || c.status === 'blocked') unresolved.push({ issue_id: c.issue_id, reason: c.reason || c.status, status: c.status });
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
      noop_reasons: result.noop,
    };

    // ② 没有任何补丁进候选：可能是"合法无修改"（模型说都是 keep），也可能是"全被拦下"。
    if (!activePlan.patches.length) {
      const noop = !gate.blocked.length;
      const combined = result.text === baseText
        ? { status: 'unchanged', findings: [], hard: [], blocked: false, verified: false, note: '候选与原文逐字相同：没有需要核验的改动' }
        : verifyCombinedCandidate(baseText, result.text, { engine, opts: gateOpts, plan: activePlan });
      return {
        ...base,
        noop,
        allBlocked: gate.allBlocked || (!noop && result.text === baseText),
        combined,
        status_note: noop
          ? '合法无修改：本批次没有任何补丁需要应用'
          : '本批次的补丁全部被安全门禁拦下（正文保持原样），未回退整章重写',
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
  };
});
