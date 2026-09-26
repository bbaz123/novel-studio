/**
 * memory-compress-prompt.mjs —— **长期记忆压缩提示词的组装**（纯函数、零依赖、可离线验证）。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────────────
 * 这段提示词决定「模型看得到哪些章节内容」，而被压缩出来的长期记忆会喂给之后**每一章**。
 * 它此前内联在 `compressStoryMemory` 里——那个函数内部有 AI 调用，**离线测不了**，
 * 于是"提示词里某一段实际是空的"这种缺陷可以一直不被发现（下面记的就是这么一件事）。
 * 现在组装部分收成纯函数，`.p1-baseline/test-memory-compress-prompt.mjs` 用合成作品
 * 直接断言"最近几章的正文确实进了提示词"。
 *
 * ── 2026-09-24 修掉的真实缺陷（质量回归）──────────────────────────────────────
 * 2026-09-19（709cc8f）为了让「出场判定」覆盖长章节中段，把每章正文改成
 * `substr(content,1,2000) AS content_head` + 尾部 `AS content_tail` 两个**查询别名**，
 * 并在提示词里引用它们；2026-09-21（5c38a22）把出场判定改成读**整章正文**时删掉了这两个
 * 别名，**却留下了提示词里的引用**。后果：`c.content_head` / `c.content_tail` 恒为
 * `undefined`，于是
 *   ① 「最近章节尾部」那一段**永远是空的**（只剩三个标题）；
 *   ② 没写摘要的章节在"全部章节摘要"里只剩一个标题，正文一个字都进不去。
 * 即：提示词开头写着"后为最近章节尾部"，实际什么都没给。压缩器只能靠摘要工作，
 * 而摘要对**正在写的新章**往往还是空的——最新剧情最可能被漏掉，且不会报错。
 *
 * 现在两处都改用**整章正文**（`compressStoryMemory` 本来就已经把整章读进内存，
 * 这里只是正确引用它；不新增任何数据库查询）。
 */

import { plainText, plainTextHead, plainTextTail } from '../text-utils.js';

/** 全部章节摘要的预算（字符）。覆盖优先：每章至少保留一段，不被"先到先得"吃掉。 */
export const SUMMARY_BUDGET = 4400;
/** 最近章节尾部的预算（字符）。 */
export const TAIL_BUDGET = 1500;
/** 取"最近几章"的尾部——新剧情最可能还没进摘要，用原文尾部兜住。 */
export const TAIL_COUNT = 3;
/** 单章缺摘要时，退而用正文头部多少字。 */
export const HEAD_FALLBACK_CHARS = 260;
/** 最近章节尾部每章取多少字。 */
export const TAIL_CHARS = 700;
/** 已出场角色 / 世界观块各自的预算（字符）。 */
export const ENTITY_BUDGET = 3000;

/**
 * 把按行组织的一段提示词文本压缩进预算：优先保留全部条目（覆盖优先），
 * 每条按均分额度截断；总长最终仍受预算约束。
 */
export function compactLinesWithinBudget(text, budget) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  const cap = Math.max(1, Math.floor(budget / lines.length));
  let result = '';
  for (const line of lines) {
    const clipped = line.length > cap ? `${line.slice(0, cap)}…` : line;
    if ((result ? result.length + 1 : 0) + clipped.length > budget) break;
    result += (result ? '\n' : '') + clipped;
  }
  return result;
}

// 实体清单压缩：先保留每个角色/词条的名称，再把剩余预算分给描述。
// 普通的按行截断会在预算耗尽时直接 break，导致后期实体连名字都进不了压缩提示词。
export function compactEntityLinesWithinBudget(text, budget) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length || budget <= 0) return '';
  const rows = lines.map((line) => {
    const end = line.indexOf('】');
    const prefix = end >= 0 ? line.slice(0, end + 1) : '';
    return { prefix, rest: prefix ? line.slice(end + 1).trim() : line };
  });
  const mandatory = rows.reduce((n, r) => n + r.prefix.length, 0) + Math.max(0, rows.length - 1);
  if (mandatory > budget) {
    // 预算极端不足时仍按顺序写入可容纳的名称片段，并显式标记省略。
    let out = '';
    for (const row of rows) {
      const sep = out ? '\n' : '';
      const room = budget - out.length - sep.length;
      if (room <= 0) break;
      out += sep + row.prefix.slice(0, room);
    }
    return out;
  }
  const perRest = Math.max(0, Math.floor((budget - mandatory) / rows.length));
  let remainder = Math.max(0, budget - mandatory - perRest * rows.length);
  return rows.map((row) => {
    const extra = perRest + (remainder-- > 0 ? 1 : 0);
    const body = row.rest.slice(0, extra);
    return `${row.prefix}${body}${body.length < row.rest.length ? '…' : ''}`;
  }).join('\n');
}

/**
 * 「章节」那一段：全部章节摘要（覆盖优先）+ 最近几章的正文尾部。
 *
 * @param {Array<{title?:string, summary?:string, content?:string}>} chapters 按 position 升序
 * @returns {string}
 */
/**
 * 「最近章节尾部」那一段的压缩：**保留标题前缀 + 取正文的结尾**。
 *
 * 为什么不复用上面的 `compactLinesWithinBudget`：那个是**从头截断**（对"章节摘要"是对的，
 * 摘要的重点在前几句）。但"章节尾部"这一段的用途恰恰相反——它存在的理由就是**最新写下的那几段**，
 * 从头截断等于把最该给压缩器看的部分丢掉（实测：700 字尾部按均分额度会被砍到 486 字，
 * 被砍掉的正是最后 214 字，也就是"最新发生的剧情"）。
 *
 * 与实体块同一个姿态：**前缀（哪一章）永不丢弃**，预算不够时先保前缀、再按尾部截正文。
 */
export function compactTailLinesWithinBudget(text, budget) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length || budget <= 0) return '';
  const rows = lines.map((line) => {
    const end = line.indexOf('】');
    const prefix = end >= 0 ? line.slice(0, end + 1) : '';
    return { prefix, rest: prefix ? line.slice(end + 1).trim() : line };
  });
  const mandatory = rows.reduce((n, r) => n + r.prefix.length, 0) + Math.max(0, rows.length - 1);
  if (mandatory > budget) {
    let out = '';
    for (const row of rows) {
      const sep = out ? '\n' : '';
      const room = budget - out.length - sep.length;
      if (room <= 0) break;
      out += sep + row.prefix.slice(0, room);
    }
    return out;
  }
  // 每行预留 1 个字符给截断省略号，保证**总量**仍然 ≤ 预算（预算的意义就是可核算的上界）。
  const perRest = Math.max(0, Math.floor((budget - mandatory - rows.length) / rows.length));
  let remainder = Math.max(0, budget - mandatory - rows.length - perRest * rows.length);
  return rows.map((row) => {
    const extra = perRest + (remainder-- > 0 ? 1 : 0);
    const clipped = row.rest.length > extra;
    const body = clipped ? row.rest.slice(-extra) : row.rest;
    return `${row.prefix}${clipped ? '…' : ''}${body}`;
  }).join('\n');
}

export function buildChapterPromptText(chapters, opts = {}) {
  const summaryBudget = opts.summaryBudget ?? SUMMARY_BUDGET;
  const tailBudget = opts.tailBudget ?? TAIL_BUDGET;
  const tailCount = opts.tailCount ?? TAIL_COUNT;
  const headChars = opts.headFallbackChars ?? HEAD_FALLBACK_CHARS;
  const tailChars = opts.tailChars ?? TAIL_CHARS;

  const list = Array.isArray(chapters) ? chapters : [];
  // ⚠️ 缺摘要时用**整章正文的头部**兜底：此前这里读的是并不存在的 `content_head`
  // 查询别名，结果整行只剩一个标题（见文件头）。
  const summaries = list
    .map((c) => `【${c.title}】${c.summary || plainTextHead(c.content || '', headChars)}`)
    .join('\n');
  const summaryText = compactLinesWithinBudget(summaries, summaryBudget);

  const recent = list.slice(-Math.max(0, tailCount))
    .map((c) => `【${c.title} · 章节尾部】${plainTextTail(c.content || '', tailChars)}`)
    .join('\n');
  const tailText = compactTailLinesWithinBudget(recent, tailBudget);
  return `${summaryText}\n${tailText}`.trim();
}

/**
 * 组装完整的记忆压缩提示词。模板与原实现**逐字相同**（只改了取值来源）。
 *
 * @param {{work:{title?:string, description?:string}, chapters:Array, characterText?:string, worldText?:string}} input
 *        `characterText` / `worldText` 是逐行「【名称】描述」的**未压缩**实体清单，
 *        由调用方按"是否出场"过滤后传入（那部分是数据库相关的判定，不放进本模块）。
 * @returns {string}
 */
export function buildCompressionPrompt(input = {}) {
  const work = input.work || {};
  const chapterPromptText = buildChapterPromptText(input.chapters, input);
  const characterPromptText = compactEntityLinesWithinBudget(input.characterText || '', ENTITY_BUDGET);
  const worldPromptText = compactEntityLinesWithinBudget(input.worldText || '', ENTITY_BUDGET);

  return `你是一位小说长期记忆压缩器。请根据以下作品内容，生成一段不超过 800 字的中文长期记忆摘要，记录已经发生的重要剧情、伏笔、角色当前状态、世界设定关键信息，方便后续 AI 写作保持一致。\n\n作品名：${work.title}\n简介：${work.description}\n\n章节（前为全部章节摘要，后为最近章节尾部）：\n${chapterPromptText}\n\n已出场角色（**只允许提到这些角色，不要引入任何未在此列的角色**）：\n${characterPromptText}\n\n世界观：\n${worldPromptText}\n\n请只输出压缩后的记忆摘要。`;
}

export default buildCompressionPrompt;