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
} from './layers.mjs';

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

  const manifest = rows.map((r) => ({
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
    dropped: r.section.bodyLength - r.section.emitted,    // 被裁掉的正文字数（零损失审计用）
  }));

  const stats = {
    mode,
    budget,
    length: joined.length,
    initialLength,
    layerCount: rows.length,
    truncatedLayers: manifest.filter((m) => m.truncated).length,
    droppedChars: manifest.reduce((n, m) => n + m.dropped, 0),
    shrinkSteps: shrinkLog.length,
  };

  return { text: joined, manifest, overflow, shrinkLog, stats };
}

/**
 * 把 manifest 渲染成人可读的裁剪清单（供日志、验收报告、UI 展示）。
 * 零损失审计的依据：清单里每一条 `dropped > 0` 的层，都必须能通过工具查回原文。
 */
export function describeManifest(manifest, { onlyTruncated = false } = {}) {
  const rows = onlyTruncated ? manifest.filter((m) => m.truncated) : manifest;
  const lines = rows.map((m) => {
    const mark = m.truncated ? '✂' : m.empty ? '∅' : ' ';
    const cap = m.declaredCap === null ? '∞' : m.declaredCap;
    return `${mark} ${m.label.padEnd(24)} cap=${String(cap).padStart(5)} 正文=${String(m.bodyLength).padStart(6)} 采用=${String(m.emitted).padStart(6)} 占用=${String(m.renderedLength).padStart(6)}${m.dropped > 0 ? ` 裁掉=${m.dropped}` : ''}`;
  });
  return lines.join('\n');
}

export { computeFloor };
