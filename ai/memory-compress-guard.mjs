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

/**
 * 按"**在章节里出现过没有**"把实体分成两侧（用户 2026-09-16 的规格）。
 *
 * 为什么必须这么分：实测作品 #2 的角色表有 **23** 个名字，而章节正文里真正出现过的只有 **5** 个——
 * 其余 18 个是设定卡里的配角/背景，故事里从没露过面。
 * 拿整张表当"必须保留"，等于**逼模型去写没出场的人**：既造成假阳性（把好摘要判成丢人），
 * 又与"没出现的一个都不许出现"直接冲突。
 *
 * 于是两侧各有各的判据：
 *   · `appeared` —— 出现过的（主角与配角）**一个都不许丢**；
 *   · `absent`  —— 从未出现的**一个都不许冒出来**。
 *
 * 判据是确定性的字符串出现检查（含别名变体），不调模型。
 */
export function partitionByAppearance({ characters = [], worldEntries = [], chapterText = '' } = {}) {
  const hay = String(chapterText || '');
  const appearedIn = (raw) => {
    const variants = entityVariants(raw);
    return (variants.length ? variants : [String(raw ?? '').trim()]).some((v) => v && hay.includes(v));
  };
  const chars = characters.filter((c) => c && String(c.name || '').trim());
  const worlds = worldEntries.filter((w) => w && String(w.title || '').trim());
  return {
    appearedChars: chars.filter((c) => appearedIn(c.name)),
    absentChars: chars.filter((c) => !appearedIn(c.name)),
    appearedWorlds: worlds.filter((w) => appearedIn(w.title)),
    absentWorlds: worlds.filter((w) => !appearedIn(w.title)),
  };
}

/**
 * 「无中生有」的处置策略（用户 2026-09-16 决定：**例外直接放行**）。
 *
 * 用户给的规格是「没有出现的一个都不许出现**或者根据剧情需要出现**」——
 * 后半个分句是允许。而"剧情需不需要"机器判不了，所以：
 *   · **默认放行**（`allow`）：把出现过的未出场角色**如实记进日志**，但不拦落库；
 *   · 需要严格时可设 `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1` 改成拒绝。
 *
 * 刻意不静默：放行归放行，**摘要里多了谁必须留痕**——否则"允许例外"就变成了
 * "看不见越界"，而这类污染是会被喂给之后每一章的。
 */
export const STRICT_NO_INVENTION = process.env.NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION === '1';

/**
 * @param {string[]} invented 摘要里出现的、从未出场的实体
 * @returns {'none'|'allow'|'reject'}
 */
export function inventionVerdict(invented = [], { strict = STRICT_NO_INVENTION } = {}) {
  if (!Array.isArray(invented) || invented.length === 0) return 'none';
  return strict ? 'reject' : 'allow';
}

/**
 * 「无中生有」检查：摘要里**不得出现**从未出场的角色。
 *
 * 与 `checkCompression` 的完整性检查是一对：那边防"丢人"，这边防"编人"。
 * 注意本函数只**报告**，处置由 `inventionVerdict` 决定（默认放行，见上）。
 */
export function checkNoInvention({ compressed, mustNotMention = [] } = {}) {
  const text = String(compressed ?? '').trim();
  const wanted = [...new Set(mustNotMention.map((k) => String(k ?? '').trim()).filter(Boolean))];
  const invented = wanted.filter((raw) => {
    const variants = entityVariants(raw);
    return (variants.length ? variants : [raw]).some((v) => v && text.includes(v));
  });
  return {
    ok: invented.length === 0,
    invented,
    checked: wanted.length,
    reasons: invented.length ? [`记忆里出现了从未出场的角色：${invented.join('、')}`] : [],
  };
}

/**
 * 「**模型自压缩**」的整份判据（D8-#3 续，2026-09-18）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 护栏此前只保护**服务端自动压缩**那一条路（`compressStoryMemory`）。而插件的人设
 * 恰恰教模型「参考旧摘要自行压缩合并为 ≤800 字新摘要后调 `novel_memory_update`」——
 * 那条路此前**没有护栏**：模型丢掉一个角色照样静默落库，而这段摘要会喂给之后每一章。
 * 把判据收在这里，是为了它**可离线单测**，且服务端与工具侧只有一份判据。
 *
 * 两侧与自动压缩**完全一致**（刻意复用同一对函数，避免判据抄两份后漂移）：
 *   · 完整性：**出场过的**（主角+配角，含别名变体）一个都不许丢 → 拒绝落库；
 *   · 无中生有：从未出场的被提及 → 默认放行（`allow`），严格模式才拒绝。
 *
 * ⚠️ `strictInvention` / `minCoverage` 做成**参数**而不是只读模块级常量：测试必须能把
 *    策略显式钉住，否则用例会随调用方的环境变量漂移（这个坑在 D8 里犯过两次）。
 */
export function agentMemoryUpdateVerdict({
  characters = [],
  worldEntries = [],
  chapterText = '',
  summary = '',
  minChars = MIN_COMPRESSED_CHARS,
  minCoverage = MIN_ENTITY_COVERAGE,
  strictInvention = STRICT_NO_INVENTION,
} = {}) {
  const cast = partitionByAppearance({ characters, worldEntries, chapterText });
  const guard = checkCompression({
    compressed: summary,
    mustKeep: mustKeepEntities({ characters: cast.appearedChars, worldEntries: cast.appearedWorlds }),
    minChars,
    minCoverage,
  });
  const invention = checkNoInvention({
    compressed: summary,
    mustNotMention: cast.absentChars.map((c) => c.name),
  });
  const inventionAction = inventionVerdict(invention.invented, { strict: strictInvention });
  const reasons = [...guard.reasons, ...(inventionAction === 'reject' ? invention.reasons : [])];
  return { ok: reasons.length === 0, reasons, guard, invention, inventionAction, cast };
}

/**
 * 工具侧用来标记「这次写入来自 AI 自压缩」的字段值。
 *
 * ⚠️ 插件（`harness-plugins/novel-writing/novel-tools.mjs`）**不能** import 本文件：
 *    它同时会被 `install.ps1` 复制到 `~/.dsh/.agent-presets/novel-writing/`，
 *    那份副本旁边没有 `ai/` 目录，相对导入会直接崩。所以两边靠**字面量契约**对齐，
 *    并由 `.p1-baseline/test-agent-memory-guard.mjs` 断言两侧一致。
 */
export const AGENT_GUARD_MARKER = 'agent';

/**
 * 这次长期记忆写入**要不要过护栏**（纯判据，四种输入各有明确语义）。
 *
 * 为什么不是一个简单的 `body.guard === 'agent'`：
 *   · `proposed` —— 提案先落提案表、不碰正式账本，等作者确认时**再**走正式写入，
 *     那时才该设闸。在这里拦等于让模型没法提案。
 *   · 无标记 —— 作者在工坊界面手改长期记忆走的是同一条 `PUT /api/story_memory`。
 *     作者的意图优先，**不在本防区**：用机器判据挡住作者的手是本末倒置。
 *   · 只有 `summary` —— `delta` 经 `mergeMemoryDraft` 是**纯拼接**（不截断），丢不了东西。
 *
 * 判据写成纯函数而不是散在 handler 里，是为了它**可离线断言语义**——
 * 而不是去读 server.js 的代码形状（形状型断言在本项目已失效三次）。
 */
export function needsAgentMemoryGuard(body = {}) {
  if (!body || body.proposed === true) return false;
  if (body.guard !== AGENT_GUARD_MARKER) return false;
  return Boolean(String(body.summary ?? '').trim());
}
