/**
 * memory-compress-guard.mjs —— 记忆压缩的**零损失护栏**（决策 D8-#3）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 「把长期记忆压缩成一段摘要」是**有损**操作：模型可能顺手把某个角色、某个设定词条
 * 写没了。而长期记忆会喂给之后**每一章**的上下文——丢一次，后面所有章节都受影响，
 * 且**不会报错**：摘要读起来通顺，只是少了东西。这正是最难发现的一类损失。
 *
 * 用户的既有约束是「只接受零损失的上下文优化，拒绝有损摘要压缩」。
 * 压缩本身是用户显式发起的动作，但"压缩结果有没有丢东西"必须由**确定性检查**兜住，
 * 不能靠读一遍觉得还行。
 *
 * ── 它检查什么 ────────────────────────────────────────────────────────────────
 *   1. 压缩结果非空、且不低于最小字数（过短的摘要装不下角色状态与伏笔）；
 *   2. `mustKeep` 里的每个实体（角色名、世界观标题）都必须仍然出现。
 * 不通过就**拒绝落库**并抛错——宁可这次压缩失败重来，也不要静默丢掉设定。
 *
 * ⚠️ 它**不是**质量评价：它只证明"没丢关键实体"，不证明"摘要写得好"。
 *    后者属于人工盲测的范畴。
 *
 * 纯函数、零依赖，可离线单测（含阴性对照）。
 */

/** 低于这个字数就认为摘要装不下必要信息（默认值，可按作品调整）。 */
export const MIN_COMPRESSED_CHARS = 100;

/**
 * 必须保留的实体**覆盖率**下限（默认 1 = 一个都不许丢）。
 *
 * ⚠️ 这是**策略**而不是技术：2026-09-16 两次真实压缩调用显示，一个 23 个角色的作品
 * 让模型写 ≤800 字摘要时，总会有若干配角写不进去（第一次漏 11 个、修好简称匹配后仍漏 7 个）。
 * 于是有两种自洽的立场：
 *   · 1.0（默认，零损失）：宁可这次压缩失败重来，也不接受任何角色从记忆里消失；
 *   · 0.8 等：允许省略次要角色，换取压缩真的可用。
 * 默认取最严的一侧——因为**丢掉的配角不会报错**，只会在此后每一章里静默缺席。
 * 可用环境变量 `NOVELSTUDIO_COMPRESS_MIN_COVERAGE` 放宽（0~1），无需改代码。
 */
export const MIN_ENTITY_COVERAGE = (() => {
  const v = Number(process.env.NOVELSTUDIO_COMPRESS_MIN_COVERAGE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 1;
})();

/**
 * 把一个实体名拆成**可接受的写法集合**。
 *
 * ⚠️ 这条是 2026-09-16 一次**真实调用**教出来的：第一版直接用 `characters.name` 做逐字比对，
 * 而库里的名字带着括号别名（`乔明山（社里人称"乔半醒"）`）。模型写的是 `乔明山"乔半醒"`、
 * `小满`、`老葛`——**人一个没丢**，护栏却把 11 个角色全判成"丢失"并拒绝了整次压缩。
 * 逐字比对带注脚的字符串，等于要求模型照抄我们的写法，那是假阳性，不是零损失。
 *
 * 规则：括号前的主名 + 括号/引号内的别名，任一出现即算保留。
 */
export function entityVariants(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return [];
  const out = new Set();
  // 主名：第一个中英文括号之前的部分
  const base = raw.split(/[（(]/)[0].trim();
  if (base) out.add(base);
  // 别名：括号内被引号包起来的词（中文引号或英文引号），以及"本名/人称/喊"之后的词
  for (const m of raw.matchAll(/[“"']([^”"']{1,20})[”"']/g)) {
    const a = m[1].trim();
    if (a) out.add(a);
  }
  // 兜底：括号内若没有引号，且**内容很短**（说明它是个名字而不是一段描述），
  // 取其中去掉标记词后的中文串（如「本名满秋」→ 满秋）。
  // ⚠️ 必须限长：`旧日支配者（海澜市地底沉睡的那一位；仪式者只敢称"祂"）` 这种括号里是一整句
  // 描述，按最长中文串取会得到「海澜市地底沉睡的那一」这种**不是名字的碎片**——
  // 它只会让判据变松，属于噪声。别名那一侧已由引号规则取到「祂」。
  const paren = raw.match(/[（(]([^）)]*)[）)]/);
  if (paren && paren[1].length <= 8) {
    const inner = paren[1].replace(/本名|人称|街坊|社里|喊|称|又名|化名/g, '');
    for (const n of inner.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) out.add(n[0]);
  }
  return [...out];
}

/**
 * @param {{compressed?: string, mustKeep?: string[], minChars?: number}} o
 *        `mustKeep` 里的每一项可以是「主名（别名）」形式的原始串。
 * @returns {{ok: boolean, reasons: string[], missing: string[], kept: number, checked: number, length: number}}
 */
export function checkCompression({ compressed, mustKeep = [], minChars = MIN_COMPRESSED_CHARS, minCoverage = MIN_ENTITY_COVERAGE } = {}) {
  const text = String(compressed ?? '');
  const trimmed = text.trim();
  const length = trimmed.length;

  // 空项会「永远包含于任何文本」，是最典型的假通过，必须先剔掉。
  const wanted = [...new Set(mustKeep.map((k) => String(k ?? '').trim()).filter(Boolean))];
  // 每个实体只要有**任一变体**出现就算保留。
  const missing = wanted.filter((raw) => {
    const variants = entityVariants(raw);
    if (!variants.length) return !trimmed.includes(raw);   // 拆不出变体时退回原文比对
    return !variants.some((v) => trimmed.includes(v));
  });
  const kept = wanted.length - missing.length;
  const coverage = wanted.length ? kept / wanted.length : 1;

  const reasons = [];
  if (!trimmed) reasons.push('压缩结果为空');
  else if (length < minChars) reasons.push(`压缩结果过短（${length} < ${minChars} 字），装不下角色状态与伏笔`);
  if (wanted.length && coverage < minCoverage) {
    const pct = (coverage * 100).toFixed(0);
    reasons.push(`实体覆盖率 ${pct}% 低于下限 ${(minCoverage * 100).toFixed(0)}%`
      + `（丢失 ${missing.length}/${wanted.length}）：${missing.join('、')}`);
  }

  return { ok: reasons.length === 0, reasons, missing, kept, checked: wanted.length, coverage, length };
}

/** 由作品数据算出"必须保留"的实体清单（角色名 + 世界观标题）。 */
export function mustKeepEntities({ characters = [], worldEntries = [] } = {}) {
  return [
    ...characters.map((c) => c?.name),
    ...worldEntries.map((w) => w?.title),
  ].map((s) => String(s ?? '').trim()).filter(Boolean);
}
