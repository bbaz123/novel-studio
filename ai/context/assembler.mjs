/**
 * 唯一上下文装配器（P2）。
 *
 * 设计目标（对应 docs/context-contract.md 的不变量）：
 *   I1 装配结果 ≤ 总预算；压不动时**显式标记溢出**，不静默超限。
 *   I2 cap 是正文的硬上界；层在 assembled 中的真实占用 = 标题 + 正文 + 提示语，可核算。
 *   I3 零损失层（fixed）永不参与收缩。
 *   I7 装配结果可复现：输出 manifest（每层的 cap / 正文长 / 实际占用 / 是否截断）。
 *
 * 与旧实现的兼容性：本模块的 renderSection 与收敛循环是**逐字节复刻** server.js 原有的
 * `section()`（:1701-1708）与收敛循环（:1786-1798）——P2 的抽取阶段必须先证明行为等价
 * （用 P1 基线逐字节对照），再谈改进。
 *
 * 纯函数、零依赖、不碰数据库：数据由调用方按层给好，本模块只负责「预算内如何排布」。
 */

import {
  headerOf, truncationNotice, EMPTY_PLACEHOLDER,
  FLEX_ORDER, FLEX_CAPS, TOTAL_BUDGET, computeFloor, RETRIEVAL,
  provenanceOf, trimPriorityOf, LAYERS,
} from './layers.mjs';
import { estimateTokens, TOKEN_ESTIMATE_NOTE } from './tokens.mjs';
import { verifyContextIntegrity, shortHash } from './integrity.mjs';

/**
 * 渲染一层。
 * @param {number} cap 正文上限
 * @param {{retrievalTool?: string}} [options] 该层的查回工具名（来自 RETRIEVAL），
 *        用于生成**准确**的截断提示——早先写死 novel_lookup，而它查不到长期记忆/事件账本。
 * @returns {{text: string, bodyLength: number, emitted: number, truncated: boolean, empty: boolean}}
 */
export function renderSection(label, text, cap, options = {}) {
  const body = String(text || '');
  if (!body) {
    return { text: `${headerOf(label)}${EMPTY_PLACEHOLDER}`, bodyLength: 0, emitted: 0, truncated: false, empty: true };
  }
  if (cap && body.length > cap) {
    // 注意：提示语追加在 cap 之外（正文严格 ≤ cap）。层在 assembled 中的真实占用因此
    // 恒等于 标题 + cap + 提示语，是可核算的上界。
    return {
      text: `${headerOf(label)}${body.slice(0, cap)}${truncationNotice(body.length, options.retrievalTool)}`,
      bodyLength: body.length, emitted: cap, truncated: true, empty: false,
    };
  }
  return { text: `${headerOf(label)}${body}`, bodyLength: body.length, emitted: body.length, truncated: false, empty: false };
}

/**
 * 在预算内装配各层。
 *
 * @param {Array<{id:string,label:string,text:string,cap:number,kind?:string}>} layers 按渲染顺序；null/undefined 项会被跳过
 * @param {{mode?:string,totalBudget?:number,flexOrder?:string[],flexCaps?:number[]}} [options]
 * @returns {{text:string,manifest:object[],overflow:object|null,shrinkLog:object[],stats:object}}
 */
/**
 * 渲染选项：把该层在 RETRIEVAL 里声明的查回工具带进截断提示语，
 * 让模型看到的是**真实可用**的工具名——早先提示语写死 novel_lookup，
 * 而它覆盖不到长期记忆与事件账本，等于让模型去查一个查不到的地方。
 */
function renderOptionsOf(layerId) {
  const decl = RETRIEVAL[layerId];
  return { retrievalTool: (decl && decl.tool) || '' };
}

export function assemble(layers, options = {}) {
  const mode = options.mode || 'full';  const budget = options.totalBudget ?? (mode === 'settings' ? TOTAL_BUDGET.settings : TOTAL_BUDGET.default);
  const flexOrder = options.flexOrder || FLEX_ORDER;
  const flexCaps = options.flexCaps || FLEX_CAPS;

  // 过滤空层（与旧实现的 .filter(Boolean) 一致），保持数组下标与层一一对应
  const rows = layers.filter(Boolean).map((l) => ({
    id: l.id || l.label,
    label: l.label,
    kind: l.kind || 'fixed',
    cap: l.cap,
    text: l.text,
    section: null,
    // 与**数据相关**的那一半溯源：这次到底取了哪几行、命中分数如何。
    // 由调用方按层传入（只有它知道），装配器只负责放进清单、不编造。
    sourceIds: Array.isArray(l.sourceIds) ? l.sourceIds : null,
    scores: l.scores && typeof l.scores === 'object' ? l.scores : null,
    note: typeof l.note === 'string' ? l.note : '',
  }));
  for (const r of rows) r.section = renderSection(r.label, r.text, r.cap, renderOptionsOf(r.id));

  const sections = rows.map((r) => r.section.text);
  let joined = sections.join('\n\n');
  const initialLength = joined.length;

  // ── 收敛：按弹性层顺序逐档压缩，直到进入预算或压到下限 ──────────────
  const shrinkLog = [];
  if (joined.length > budget) {
    for (const id of flexOrder) {
      if (joined.length <= budget) break;
      const idx = rows.findIndex((r) => r.id === id || r.label === id);
      if (idx < 0) continue;
      for (const cap of flexCaps) {
        if (joined.length <= budget) break;
        rows[idx].section = renderSection(rows[idx].label, rows[idx].text, cap, renderOptionsOf(rows[idx].id));
        rows[idx].shrunk = true; // 记录「被收敛循环压过」——与「被自身 cap 截断」是两件事
        sections[idx] = rows[idx].section.text;
        joined = sections.join('\n\n');
        shrinkLog.push({ id: rows[idx].id, appliedCap: cap, totalAfter: joined.length });
      }
    }
  }

  // ── I1：压到下限仍超限 → 显式标记，不静默 ────────────────────────────
  const overflow = joined.length > budget
    ? { budget, actual: joined.length, over: joined.length - budget,
        hint: '所有弹性层已压到下限仍超出预算：应下调不收缩层的 cap，或提高总预算。' }
    : null;

  const manifest = rows.map((r) => {
    const dropped = r.section.bodyLength - r.section.emitted;
    const prov = provenanceOf(r.id);
    const recovery = RETRIEVAL[r.id] || null;
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      declaredCap: Number.isFinite(r.cap) ? r.cap : null,   // 声明的正文上限（entity 层为构建函数上限）
      bodyLength: r.section.bodyLength,                     // 原始正文长度
      emitted: r.section.emitted,                           // 实际进入上下文的正文字数
      renderedLength: r.section.text.length,                // 该层在 assembled 中的真实占用
      truncated: r.section.truncated,
      shrunk: !!r.shrunk,                                   // 是否被总预算收敛循环压过（仅弹性层可能为 true）
      empty: r.section.empty,
      dropped,                                              // 被裁掉的正文字数（零损失审计用）
      estimatedTokens: estimateTokens(r.section.text),      // 该层大约占多少 token（估算，不参与裁剪）
      // ── 2026-09-24 起新增（全部为 additive，旧消费方不受影响）──
      // 溯源：这段字从哪来、讲的是哪个时间、怎么选出来的、被裁时怎么取回、为什么它值得占位置
      source: prov ? prov.source : '',
      sourceId: r.sourceIds,                 // 本次实际取用的行 id（null = 该层未声明）
      temporalScope: prov ? prov.temporal_scope : '',
      knowledgeScope: prov ? prov.knowledge_scope : '',
      selection: prov ? prov.selection : '',
      trimPriority: trimPriorityOf(r.id),    // 从 FLEX_ORDER/kind 派生，不另设一套数字
      reason: prov ? prov.reason : '',
      knownGap: prov && prov.known_gap ? prov.known_gap : '',
      scores: r.scores,                      // 检索类层的命中分布（如语义召回）
      note: r.note || '',
      recoveryPath: recovery
        ? { tool: recovery.tool || '', intrinsic: recovery.intrinsic === true,
            endpoint: recovery.endpoint || '', note: recovery.note || '', gap: recovery.gap || '' }
        : null,
      // 「为什么最后是这个样子」——由**实测结果**推导，不是另记一份可能漂移的说明
      outcomeReason: r.section.empty ? '本层没有数据（占位说明）'
        : (dropped > 0
          ? (r.shrunk ? `被总预算收敛压到 ${r.section.emitted} 字（原 ${r.section.bodyLength} 字）`
                      : `超过本层上限，截到 ${r.section.emitted} 字（原 ${r.section.bodyLength} 字）`)
          : '完整进入上下文'),
    };
  });

  const contentId = shortHash(joined);

  const stats = {
    mode,
    budget,
    length: joined.length,
    initialLength,
    layerCount: rows.length,
    truncatedLayers: manifest.filter((m) => m.truncated).length,
    droppedChars: manifest.reduce((n, m) => n + m.dropped, 0),
    shrinkSteps: shrinkLog.length,
    // 2026-09-24 新增（additive）：规模估算。**不参与**任何预算/裁剪决策，只用于横向比较。
    estimatedTokens: estimateTokens(joined),
    tokenEstimateNote: TOKEN_ESTIMATE_NOTE,
  };

  // ── 完整性：清单与文字必须自洽（不合格要响亮，不许"看起来有护栏"）──
  const integrity = verifyContextIntegrity({
    text: joined, manifest, overflow, budget, contextId: contentId,
  });

  // ── 本次装配的信封（request/context 身份 + 预算 + selected/trimmed/excluded）──
  // 「被排除的层」由**层规格**反推：声明了却没进这次装配的层，以及它为什么不在。
  const presentIds = new Set(manifest.map((m) => m.id));
  // 门控层（gated）不进 excluded：它在未打开开关的作品里**根本不属于这一套层**，
  // 列进"被排除的层"会让每部作品的信封凭空多一条，也会误导读者以为"这次本可以有它"。
  const excluded = LAYERS
    .filter((spec) => !presentIds.has(spec.id) && spec.gated !== true)
    .map((spec) => ({
      id: spec.id,
      label: spec.label,
      reason: (mode === 'settings' && spec.skipInSettings)
        ? '本模式（settings：设定类生成）按层规格跳过该层'
        : '本次没有该层的数据（条件层未命中 / 构建结果为空）',
    }));

  const envelope = {
    requestId: options.requestId || '',
    contextId: contentId,
    workId: options.workId ?? null,
    chapterId: options.chapterId ?? null,
    mode,
    budget,
    length: joined.length,
    estimatedTokens: stats.estimatedTokens,
    tokenEstimateNote: TOKEN_ESTIMATE_NOTE,
    selected: manifest.map((m) => m.id),
    trimmed: manifest.filter((m) => m.truncated || m.dropped > 0).map((m) => ({
      id: m.id,
      dropped: m.dropped,
      emitted: m.emitted,
      bodyLength: m.bodyLength,
      recoveryTool: m.recoveryPath ? (m.recoveryPath.tool || '') : '',
      recoveryIntrinsic: !!(m.recoveryPath && m.recoveryPath.intrinsic),
    })),
    excluded,
    integrity,
  };

  return { text: joined, manifest, overflow, shrinkLog, stats, contextId: contentId, integrity, envelope };
}

export { computeFloor };
