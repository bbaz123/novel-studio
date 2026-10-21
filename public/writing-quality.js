/*
 * 写作终止与质检诊断（writing-quality）—— 纯函数、零依赖、UMD。
 * 方案《AI 写作截断与质检闭环》§3/§5：
 * "连接正常结束"≠"模型写完"；"字数够"≠"蓝图完成"；"质检解析失败"≠"没有 issues"。
 * 本模块只判定，不调用模型、不写文件。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelWritingQuality = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
  const GENERATION_STATUS = {
    PROVIDER_STOP: 'PROVIDER_STOP', OUTPUT_LIMIT_REACHED: 'OUTPUT_LIMIT_REACHED',
    EMPTY_OUTPUT: 'EMPTY_OUTPUT', STREAM_INTERRUPTED: 'STREAM_INTERRUPTED',
    USER_CANCELLED: 'USER_CANCELLED', PROVIDER_BLOCKED: 'PROVIDER_BLOCKED',
    UNKNOWN_TERMINATION: 'UNKNOWN_TERMINATION',
  };
  const textOf = (x) => String(x == null ? '' : x);

  /** 终止原因 → 状态；缺字段一律 UNKNOWN，绝不伪造 stop。 */
  function generationStatusOf(input = {}) {
    if (input.cancelled === true) return GENERATION_STATUS.USER_CANCELLED;
    if (input.interrupted === true) return GENERATION_STATUS.STREAM_INTERRUPTED;
    if (!textOf(input.text).trim()) return GENERATION_STATUS.EMPTY_OUTPUT;
    const fr = input.finishReason == null ? null : textOf(input.finishReason).trim();
    if (fr === 'length') return GENERATION_STATUS.OUTPUT_LIMIT_REACHED;
    if (fr === 'content_filter') return GENERATION_STATUS.PROVIDER_BLOCKED;
    if (fr === 'stop' || fr === 'end_turn') return GENERATION_STATUS.PROVIDER_STOP;
    return GENERATION_STATUS.UNKNOWN_TERMINATION;
  }

  /** 质检跳过 → 作者看得懂的真实原因（不再一律归到"长正文分段模块不可用"）。 */
  function qualitySkipText(reason) {
    const r = textOf(reason);
    const map = {
      unparsed: '质检返回格式无效，未得到可靠结论',
      channel_unavailable: '质检通道暂时不可用',
      long_text_engine_unavailable: '长正文质检模块不可用',
      over_single_request_limit: '正文超过单请求质检上限（未分段质检）',
      cancelled: '质检已被取消',
    };
    return map[r] || `本次质检未完成（${r || '未知原因'}）`;
  }

  /**
   * 篇幅诊断（与蓝图完成度分开）：生成状态/质检状态优先于字数。
   * truncated=明确输出上限；unverified=质检跳过/unknown，不能判"短但完整"。
   */
  function classifyLength(input = {}) {
    const chars = Number(input.chars) || 0;
    const target = Number(input.target) || 0;
    const gen = textOf(input.generation && input.generation.status);
    if (gen === GENERATION_STATUS.OUTPUT_LIMIT_REACHED) {
      return { status: 'truncated', chars, target, gap: Math.max(0, target - chars), generation_status: gen };
    }
    const verdict = input.verdict || null;
    if (verdict && verdict.skipped) return { status: 'unverified', chars, target, gap: Math.max(0, target - chars), reason: textOf(verdict.reason) };
    if (verdict && textOf(verdict.verdict) === 'unknown') return { status: 'unverified', chars, target, gap: Math.max(0, target - chars), reason: 'unknown' };
    if (!target || chars >= target) return { status: 'ok', chars, target, gap: 0 };
    const issues = (verdict && Array.isArray(verdict.issues)) ? verdict.issues : [];
    const missed = issues.some((x) => /遗漏|缺失|未写|未出现|未交代|漏掉|漏写|没有交代/.test(String(x)));
    return { status: missed ? 'missing_content' : 'short_but_complete', chars, target, gap: target - chars };
  }

  /** 从作者确认的蓝图提取必需情节点；没有显式 required_beats 时返回空（不猜）。 */
  function requiredBeatsFromBlueprint(blueprint) {
    const list = blueprint && Array.isArray(blueprint.required_beats) ? blueprint.required_beats : [];
    return list.map((b, i) => (typeof b === 'string'
      ? { id: `B${String(i + 1).padStart(2, '0')}`, description: b, required: true }
      : {
        id: String(b && b.id || `B${String(i + 1).padStart(2, '0')}`),
        description: String(b && (b.description || b.text) || ''),
        required: !(b && b.required === false),
      })).filter((b) => b.description);
  }

  /** 把质检回包里的逐条 beats 覆盖转成门禁结论；缺证据/含糊一律 UNVERIFIED/MISSING。 */
  function beatsGateOf(beats, verdict) {
    const required = (Array.isArray(beats) ? beats : []).filter((b) => b.required !== false);
    if (!required.length) return null;
    const coverage = new Map(((verdict && Array.isArray(verdict.beats)) ? verdict.beats : []).map((b) => [String(b && b.id), b]));
    const unresolved = [];
    let unclear = 0;
    for (const beat of required) {
      const row = coverage.get(beat.id);
      const status = textOf(row && row.status).toLowerCase();
      if (status === 'met') continue;
      if (status === 'missing' || status === 'not_met') unresolved.push(beat.id);
      else unclear += 1;
    }
    if (unresolved.length) return { status: 'MISSING_REQUIRED_BEATS', unresolved };
    if (unclear > 0) return { status: 'UNVERIFIED', reason: 'BEAT_COVERAGE_INCOMPLETE' };
    return { status: 'VERIFIED' };
  }

  /**
   * 蓝图完成度（方案 §4）：只回答"能否按正常完成交付"，不发明蓝图。
   * - truncated / 质检跳过 / unknown → UNVERIFIED（ready=false）
   * - 质检 issues 非空 → MISSING_REQUIRED_BEATS（ready=false，unresolved 用真实 issues）
   * - pass → VERIFIED（ready=true）
   * 注意：这是最小门禁；required_beats 账本与逐条证据仍待后续实现。
   */
  function blueprintStatusOf(input = {}) {
    const length = input.length || {};
    const verdict = input.verdict || null;
    if (length.status === 'truncated') return { status: 'UNVERIFIED', ready_for_normal_delivery: false, unresolved: [], reason: 'OUTPUT_LIMIT_REACHED' };
    if (!verdict || verdict.skipped) return { status: 'UNVERIFIED', ready_for_normal_delivery: false, unresolved: [], reason: textOf(verdict && verdict.reason) || 'NO_VERIFICATION' };
    const beats = Array.isArray(input.requiredBeats) ? input.requiredBeats : requiredBeatsFromBlueprint(input.blueprint);
    const gate = beatsGateOf(beats, verdict);
    if (gate) {
      if (gate.status === 'VERIFIED') return { status: 'VERIFIED', ready_for_normal_delivery: true, unresolved: [], required_beats: beats.length };
      return { status: gate.status, ready_for_normal_delivery: false, unresolved: gate.unresolved || [], required_beats: beats.length, reason: gate.reason || '' };
    }
    const issues = Array.isArray(verdict.issues) ? verdict.issues : [];
    if (verdict.verdict === 'issues' || issues.length > 0) return { status: 'MISSING_REQUIRED_BEATS', ready_for_normal_delivery: false, unresolved: issues };
    if (verdict.verdict === 'unknown') return { status: 'UNVERIFIED', ready_for_normal_delivery: false, unresolved: [], reason: 'UNKNOWN' };
    return { status: 'VERIFIED', ready_for_normal_delivery: true, unresolved: [] };
  }

  /** 定向续写决策（§6）：只在有明确缺口/截断且作者已授权时允许，其他一律不续写。 */
  function continuationDecision(input = {}) {
    const gen = textOf(input.generation && input.generation.status);
    const missing = Array.isArray(input.missingBeatIds) ? input.missingBeatIds : [];
    if (input.cancelled === true) return { allow: false, reason: 'USER_CANCELLED' };
    if (input.readyForDelivery === true) return { allow: false, reason: 'BLUEPRINT_COMPLETE' };
    if (input.authorAuthorized !== true) return { allow: false, reason: 'NEED_AUTHOR_AUTHORIZATION' };
    if (!missing.length && gen !== 'OUTPUT_LIMIT_REACHED') return { allow: false, reason: 'NO_EVIDENCE_OF_MISSING_CONTENT' };
    return { allow: true, reason: gen === 'OUTPUT_LIMIT_REACHED' ? 'OUTPUT_LIMIT' : 'MISSING_BEATS', missing_beat_ids: missing };
  }

  /** 冻结必需情节点：绑定蓝图 revision + beats 内容哈希（FNV-1a），用于确认"核对的是哪一版蓝图"。 */
  function freezeRequiredBeats(blueprint) {
    const beats = requiredBeatsFromBlueprint(blueprint);
    const revision = textOf(blueprint && (blueprint.revision || blueprint.version || blueprint.blueprint_revision));
    const payload = JSON.stringify({ revision, beats });
    let h = 0x811c9dc5;
    for (let i = 0; i < payload.length; i += 1) {
      h ^= payload.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return { blueprint_revision: revision, beats, required_beats_hash: `fnv1a:${(h >>> 0).toString(16)}` };
  }

  return { GENERATION_STATUS, generationStatusOf, qualitySkipText, classifyLength, requiredBeatsFromBlueprint, beatsGateOf, blueprintStatusOf, continuationDecision, freezeRequiredBeats };
});
