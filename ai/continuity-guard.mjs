/**
 * continuity-guard.mjs —— 审稿前的**零 token 确定性连续性预检**（2026-09-22 报告 · 第 1 步）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 你两份真实审稿报告（第 5、6 章）里，占比最高的一类 issue 是「与既有设定/大纲/事件账本冲突」。
 * 这类问题有两个特点，正好是确定性检查的用武之地：
 *   ① 它在**付费的 AI 审稿**里被反复发现，而其中一部分是**机器能直接算出来**的
 *      （角色卡时点、篇幅、系统出场频率、剧情线推进）；
 *   ② AI 在这些量上**不可靠**：第 6 章审稿把 3897 字的正文估成「约五千字以上（估 5000–5600 字）」，
 *      而应用内的字数口径（`public/app.js` 的 `plainLength`：剥标签 + 去掉所有空白）算出来是 3897。
 *      让模型去数数，等于把确定性工作交给一个会算错的执行者。
 *
 * 于是本模块只做**能判定的事**：不调 AI、不读网络、不改任何数据。它输出 findings，
 * 由调用方决定怎么呈现（界面提示 / 内联进审稿提示词 / 只记日志）。
 *
 * ── 与既有机制的分工（不要重复造） ────────────────────────────────────────────
 *   · 反 AI 腔词句 → 已由 `server.js` 的 `scanAgainstRedlines`（写作红线）覆盖，
 *     并且已经在审稿前内联进提示词（`public/app.js` 的 `buildRedlineScanText`）。本模块**不重复**。
 *   · 「正文违反本章蓝图 / 未登记具名实体」→ 已由 `/api/novel/consistency` + `novel_consistency`
 *     工具（确定性装配 + AI 判定）覆盖。本模块只补**不花 AI 也能判**的那几条。
 *   · 成文不足目标字数 → 已有 `articleLengthHint` 在成文弹窗里提示。本模块**只判超上限**，
 *     避免同一件事在界面上报两遍（重复报会让作者对提示脱敏）。
 *
 * ── 判据的立场（重要） ────────────────────────────────────────────────────────
 * 首版只收**有真实燃料**的检查：每条都能在 work#18 的真实库里读到数据。
 * 曾被考虑但**故意不做**的：角色缺席（`chapters.context_character_ids` 全库 0/50 非空，
 * 该字段是作者手动勾选的「强制带入」，从未使用过）、事件 payload 冲突比对
 * （work#18 的 6 条事件 payload 全是 `{}`，结构化事实只存在于示例作品 work#9）。
 * 没有燃料的检查会让界面永远显示「无问题」——那比不检查更糟：它假装检查过了。
 *
 * 纯函数、零依赖，可离线单测（含阴性对照）：`.p1-baseline/test-continuity-guard.mjs`。
 */

/** 检查项 id 清单（顺序即呈现顺序）。改这里要同步 `docs/continuity-guard.md` 与单测。 */
export const GUARD_CHECKS = ['character_time_point', 'system_frequency', 'chapter_length', 'plotline_progress'];

// ── 阈值：全部有默认值，且都能被 `app_settings` 的 continuity_thresholds:<workId> 覆盖 ──
// 「阈值该定多少」是作者口径（报告 C4），所以代码里不写死唯一答案：
// 默认值取**外部参照 + 本作风格文本**，覆盖入口留给作者。

/** 剧情线连续多少章没有推进算「停滞」。参照 Novel-OS 的 DORMANT_THREAD_GAP_CHAPTERS=3；
 *  但那是按「章」计的通用值，本作是 4000 字/章的长章，取 4。 */
export const DEFAULT_PLOTLINE_STALL_CHAPTERS = 4;

/** 「系统」字面命中次数的上限兜底值。真实上限优先从 `style_positive` 解析（本作写的是 5～15 次）。 */
export const DEFAULT_SYSTEM_MENTION_MAX = 15;

/** 明显超限的倍数：命中数 ≥ 上限 × 该比值时报 warning，否则报 info。
 *  为什么分两档：「有效出场」是作者的写作概念，字面命中只是它的近似——
 *  刚过线时（近似误差范围内）只提醒，超出很多才升级为警告。 */
export const SYSTEM_OVERRUN_HARD_RATIO = 1.5;

/** 篇幅上限的兜底倍数（只在风格文本里解析不到明确的字数区间时使用）。 */
export const DEFAULT_LENGTH_OVERRUN_RATIO = 1.25;

/** 「第X卷末」的状态卡用在卷内**倒数第 N 章之前**就算提前（卷末状态提前泄露）。 */
export const VOLUME_END_LEAD_CHAPTERS = 2;

/** 严重度排序：数值越小越靠前。 */
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/**
 * 与应用内显示**同口径**的字数统计：剥掉空白后的字符数。
 * ⚠️ 必须与 `public/app.js` 的 `plainLength`（stripHtml + `replace(/\s/g,'')`）一致，
 *    否则界面上显示 3897 字、预检说 4506 字，作者会先怀疑工具再怀疑正文。
 * 调用方负责先把 HTML 转成纯文本（`server.js` 的 `plainText` / 前端的 `stripHtml`）。
 */
export function plainLen(text) {
  return String(text ?? '').replace(/\s/g, '').length;
}

/** finding 的**稳定身份**：故意不含 message 与章节号（照 Novel-OS 的 Finding.key 设计）。
 *  理由写在对方的代码注释里，也适用于我们：措辞会随检查改进而变化，
 *  同一个矛盾会换个章节再出现——键在这两者上，作者已经做过的「这是故意的」判定会悄悄复活。 */
export function findingKey(f) {
  return `${f?.category || 'unknown'}:${f?.entity_id || ''}`;
}

/** 把 findings 分成「保留」与「已豁免」。豁免集可以是数组或 Set（两种调用方式都常见）。 */
export function partitionExempt(findings = [], exemptions = []) {
  const set = exemptions instanceof Set ? exemptions : new Set(Array.isArray(exemptions) ? exemptions : Object.keys(exemptions || {}));
  const kept = [];
  const exempted = [];
  for (const f of findings) (set.has(findingKey(f)) ? exempted : kept).push(f);
  return { kept, exempted };
}

/** 只保留未豁免的 findings（与 Novel-OS 的 drop_exempt 同名同义，便于对照阅读）。 */
export function dropExempt(findings = [], exemptions = []) {
  return partitionExempt(findings, exemptions).kept;
}

/** 按严重度排序（同级保持稳定顺序：important 的在前）。 */
export function sortFindings(findings = []) {
  return [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

/** 汇总：给界面与日志用的计数。 */
export function summarizeFindings(findings = []) {
  const bySeverity = {};
  const byCategory = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }
  const total = findings.length;
  return {
    total,
    bySeverity,
    byCategory,
    text: total ? `${total} 条：` + Object.entries(byCategory).map(([k, v]) => `${k}×${v}`).join('、') : '零命中（确定性预检没有发现问题）',
  };
}

/** 把 findings 渲染成**给 AI 审稿用的一段**（与红线扫描那段并排）。
 *  只取前 limit 条：这段是"起始上下文"，不是完整报告——写太长会挤掉正文本身。 */
export function findingsPromptText(findings = [], limit = 12) {
  const list = sortFindings(findings);
  if (!list.length) return '';
  return list.slice(0, limit).map((f) =>
    `- [${f.severity}] ${f.message}${f.suggestion ? `（建议：${f.suggestion}）` : ''}`).join('\n');
}

/** 中文数字 → 整数（支持 一…十九、二十、二十一…九十九、百；纯阿拉伯数字原样解析）。 */
export function cnNumeralToInt(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const digit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  let total = 0;
  let section = 0;
  for (const ch of s) {
    if (ch === '百') { section = (section || 1) * 100; total += section; section = 0; continue; }
    if (ch === '十') { section = (section || 1) * 10; total += section; section = 0; continue; }
    if (digit[ch] !== undefined) { section = digit[ch]; continue; }
    return null;
  }
  return total + section;
}

/**
 * 从作品风格文本里解析「系统每章有效出场约 5～15 次」的上限。
 * 为什么解析而不是写死：这条阈值本来就写在作品的 `style_positive` 里，
 * 作者改了风格要求，预检应当跟着改，而不是各说一套。
 */
export function parseSystemMentionMax(styleText) {
  const t = String(styleText ?? '');
  const m = t.match(/系统[^\n。]{0,16}?出场[^\n。]{0,10}?(\d{1,3})\s*[～~\-—至到]\s*(\d{1,3})/);
  if (!m) return null;
  const hi = Number(m[2]);
  return Number.isFinite(hi) && hi > 0 ? hi : null;
}

/** 从作品风格文本里解析「单章 3000～5000 字（默认 4000）」的区间与默认值。 */
export function parseChapterLengthRange(styleText) {
  const t = String(styleText ?? '');
  const m = t.match(/单章[^\n。]{0,12}?(\d{3,5})\s*[～~\-—至到]\s*(\d{3,5})\s*字/);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!(min > 0 && max > min)) return null;
  // ⚠️ 不要把"字"写进默认值的模式里：真实文本是「单章 3000～5000 字（默认 4000）」——
  //    括号紧跟在数字后面，没有"字"。第一版要求了"字"，于是 default 静默变成 null
  //    （离线单测里正是这一条先报出来的）。
  const d = t.match(/默认\s*(\d{3,5})/);
  const def = d && Number(d[1]) > 0 ? Number(d[1]) : null;
  return { min, max, default: def };
}

/**
 * 解析角色卡状态/身份里的**时点标记**：`第一卷`、`第一卷末`、`最终卷`。
 * 为什么只认这一种：它是可判定的（有明确卷号），而「提前知道后续剧情」这类语义判断只能交给 AI。
 * 认不出来就返回 null（**不猜**）——猜错会直接制造假阳性，而假阳性会让作者关掉整个预检。
 */
export function parseVolumeMarkers(text) {
  const t = String(text ?? '');
  if (!t) return null;
  const m = t.match(/第([一二三四五六七八九十百两\d]{1,3})卷(末)?/);
  if (m) {
    const volume = cnNumeralToInt(m[1]);
    if (Number.isFinite(volume) && volume > 0) return { volume, atVolumeEnd: !!m[2], finalVolume: false };
  }
  const f = t.match(/最终卷(末)?/);
  if (f) return { volume: null, atVolumeEnd: !!f[1], finalVolume: true };
  return null;
}

// ─────────────────────────────── 四项检查 ───────────────────────────────

/**
 * ① 角色卡时点越界。
 *
 * ── 为什么这是首版第一项 ──────────────────────────────────────────────────────
 * 第 5、6 章两份审稿报告的**第 1 条 issue 说的都是它**（不是配角问题，是主因）：
 * 岳宸炎的 `characters.status` 写的是「第一卷末：暗夜修罗身份引发全城追查…」，
 * `identity` 写的是转学后的「海澜市第三高级中学高三七班学生（转学生）」——
 * 而这两章的时间点还在江陵三中，转学发生在第七章。
 * 生成端（`server.js` 把 status 以「当前状态：」写进角色卡）与审稿端都拿"卷末/转学后"的事实
 * 去对"转学前"的正文，冲突是必然的。**这不是"状态太薄"，是"状态没有时点"。**
 *
 * input:
 *   chapter: { id, label, volumeOrdinal, indexInVolume, chaptersInVolume, isFinalVolume }
 *            volumeOrdinal 为 0 基（= volumes.position）；缺卷信息（null）时本项**不判**。
 *   characters: [{ id, name, status, identity }]
 */
export function checkCharacterTimePoint({ chapter = {}, characters = [] } = {}) {
  const out = [];
  const ord = Number.isFinite(chapter.volumeOrdinal) ? chapter.volumeOrdinal : null;
  if (ord === null) return out; // 没有卷信息就等于没有判据，不猜
  const idx = Number.isFinite(chapter.indexInVolume) ? chapter.indexInVolume : null;
  const total = Number.isFinite(chapter.chaptersInVolume) ? chapter.chaptersInVolume : null;
  for (const c of characters) {
    if (!c) continue;
    const marker = parseVolumeMarkers(c.status) || parseVolumeMarkers(c.identity);
    if (!marker) continue;
    const entity_id = `character:${c.id ?? c.name ?? ''}`;
    const name = c.name || '(未命名角色)';
    const cardVolumeLabel = marker.finalVolume ? '最终卷' : `第${marker.volume}卷`;
    const evidence = { name, cardVolumeLabel, atVolumeEnd: marker.atVolumeEnd, volumeOrdinal: ord, indexInVolume: idx, chaptersInVolume: total };

    // (a) 卡片带的是**最终卷**，而本章不在最终卷
    if (marker.finalVolume) {
      if (chapter.isFinalVolume === false) {
        out.push({
          severity: 'warning', category: 'character_time_point', entity_id, chapter: chapter.position,
          message: `角色卡时点越界（${name}）：卡的当前状态写的是「最终卷」的事实，而本章不在最终卷。`,
          suggestion: '把卡按卷拆开，或在本章语境里只写本章时点的状态。',
          evidence,
        });
      }
      continue;
    }

    const cardOrd = marker.volume - 1;
    // (b) 卡片是**后续卷**的状态：生成端会照着写、审稿端会照着判
    if (cardOrd > ord) {
      out.push({
        severity: 'warning', category: 'character_time_point', entity_id, chapter: chapter.position,
        message: `角色卡时点越界（${name}）：卡的当前状态写的是「${cardVolumeLabel}${marker.atVolumeEnd ? '末' : ''}」的事实，而本章还在更靠前的卷里。`,
        suggestion: '这是最容易制造"与既有设定冲突"的一处：把卡按卷/按章拆开，或在本章语境里只写本章时点的状态。',
        evidence,
      });
      continue;
    }
    // (c) 同一卷，但把**卷末**状态用在了卷中
    if (cardOrd === ord && marker.atVolumeEnd && idx !== null && total !== null
        && idx < total - VOLUME_END_LEAD_CHAPTERS) {
      out.push({
        severity: 'warning', category: 'character_time_point', entity_id, chapter: chapter.position,
        message: `角色卡时点越界（${name}）：卡的当前状态写的是「${cardVolumeLabel}末」的事实，`
          + `而本章是${cardVolumeLabel}的第 ${idx + 1} 章（本卷规划 ${total} 章）——卷末还没到。`,
        suggestion: '把卡里"卷末"的状态换成本章时点的状态；正文里再补一句时间锚（如"觉醒日之后第几天"）。',
        evidence,
      });
      continue;
    }
    // (d) 反向：卡停在了更早的卷（状态可能已过期）——只提示，不当问题
    if (cardOrd < ord) {
      out.push({
        severity: 'info', category: 'character_time_point', entity_id, chapter: chapter.position,
        message: `角色卡状态可能过期（${name}）：卡写的是「${cardVolumeLabel}」时点，本章已在更靠后的卷。`,
        suggestion: '确认这张卡是否已经落后于剧情；落后就更新，没落后就忽略。',
        evidence,
      });
    }
  }
  return out;
}

/**
 * ② 系统出场频率。
 *
 * 上限取自作品自己的风格要求（本作 `style_positive` 写着「系统每章有效出场约 5～15 次，
 * 不要每段都有」）。第 5 章审稿报告里"系统面板出现频率"那条说的就是它。
 *
 * ⚠️ 只判**超上限**，不判低于下限：系统出场少是叙事选择（第 1 章就该只有 2 次），
 *    多到"每段都有"才是风格问题。少判一侧能让这项几乎不产生假阳性。
 * ⚠️ 计量的是**字面命中次数**，它是"有效出场"的近似（一次出场可能被写多次）——
 *    所以刚过线时只报 info，超出 1.5 倍才升级为 warning。
 */
export function checkSystemFrequency({ chapter = {}, text = '', max = DEFAULT_SYSTEM_MENTION_MAX, aliases = [] } = {}) {
  const terms = ['系统', ...(Array.isArray(aliases) ? aliases : [])].filter(Boolean);
  if (!terms.length || !(Number(max) > 0)) return [];
  let count = 0;
  for (const term of terms) {
    count += (String(text ?? '').match(new RegExp(escapeRegExp(term), 'g')) || []).length;
  }
  if (count <= max) return [];
  const hard = count >= max * SYSTEM_OVERRUN_HARD_RATIO;
  return [{
    severity: hard ? 'warning' : 'info',
    category: 'system_frequency',
    entity_id: `chapter:${chapter.id ?? ''}`,
    chapter: chapter.position,
    message: `系统出场偏多：正文里"系统"字面命中 ${count} 次，超过作品风格写的上限 ${max} 次`
      + `（字面命中是"有效出场"的近似值${hard ? '，且已明显超出' : ''}）。`,
    suggestion: '把面板式播报压到一章一次，其余改成短回合吐槽；系统单次发言不超过 3 句。',
    evidence: { mentions: count, max, terms },
  }];
}

/** 正则元字符转义（用户/风格文本里的词条可能有 `-`、`（` 等字符）。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ③ 篇幅：目标口径 + 超上限。
 *
 * ── 为什么要把"口径冲突"单独报一条 ───────────────────────────────────────────
 * work#18 现在同时存在三套目标：第 5、6 章的 `chapters.target_words=3000`、
 * 作品 `default_chapter_words=4000`、风格文本「单章 3000～5000 字（默认 4000）」。
 * 结果是 AI 写作按 3000 补足、审稿按 4000 判"篇幅不足"——**同一章被两套尺子量**。
 * 这是数据问题，不是写作问题，所以它在预检里的严重度是 info（提醒统一口径），
 * 而不是 warning（正文有问题）。统一口径本身是作者决策（报告 C6）。
 *
 * ⚠️ 只判**超上限**：不足目标已由成文弹窗的 `articleLengthHint` 提示，重复报会让作者脱敏。
 */
export function checkChapterLength({ chapter = {}, plainLength = 0, chapterTarget = 0, workDefault = 0, styleRange = null } = {}) {
  const out = [];
  const entity_id = `chapter:${chapter.id ?? ''}`;
  const target = Number(chapterTarget) > 0 ? Number(chapterTarget) : 0;
  const def = Number(workDefault) > 0 ? Number(workDefault) : 0;
  const rangeText = styleRange ? `、风格区间 ${styleRange.min}～${styleRange.max} 字` : '';

  if (target > 0 && def > 0 && target !== def) {
    out.push({
      severity: 'info', category: 'chapter_length_target_conflict', entity_id, chapter: chapter.position,
      message: `篇幅目标口径不一致：本章目标 ${target} 字、作品默认 ${def} 字${rangeText}。`
        + 'AI 写作按本章目标补足，审稿却按风格文本判——第 5、6 章的篇幅 issue 就是这么来的。',
      suggestion: '定一个权威口径（章节目标 / 作品默认 / 风格区间三选一），其余降为参考。',
      evidence: { chapterTarget: target, workDefault: def, styleRange },
    });
  }

  let upper = styleRange && styleRange.max > 0 ? styleRange.max : 0;
  let upperFrom = '风格区间';
  if (!upper) {
    const base = Math.max(target, def);
    if (base > 0) { upper = Math.round(base * DEFAULT_LENGTH_OVERRUN_RATIO); upperFrom = `目标字数的 ${Math.round((DEFAULT_LENGTH_OVERRUN_RATIO - 1) * 100)}% 余量（推定）`; }
  }
  if (upper > 0 && Number(plainLength) > upper) {
    out.push({
      severity: 'warning', category: 'chapter_length_over', entity_id, chapter: chapter.position,
      message: `篇幅超上限：本章 ${plainLength} 字（应用内口径：剥标签 + 去空白），上限 ${upper} 字（${upperFrom}）。`,
      suggestion: '先砍重复盘算与内心独白，再补外部事件；砍完再跑一次本预检。',
      evidence: { plainLength, upper, upperFrom, styleRange, chapterTarget: target, workDefault: def },
    });
  }
  return out;
}

/**
 * ④ 剧情线推进间隔。
 *
 * 数据早就够用：`chapters.plotline_id` 已把 50 章全量分配到 4 条线，
 * 所以"某条线多久没推进"可以直接用章节序号算，不需要新字段。
 * （work#18 实测：主线 39 号 19 章、支线 40/41/42 号分别 5/8/18 章。）
 *
 * ⚠️ 分两档，避免作品早期噪声：
 *    · 「一章都没轮到的线」→ info：作品才写到第 6 章，支线没起线是正常的
 *      （但若这条线**本应**已经起线——已规划到本章之前——那就是漏写，所以照样报出来，交由作者判）；
 *    · 「推进过、又连续 N 章没动」→ warning：这是真停滞。
 */
export function checkPlotlineProgress({
  plotlines = [], chapters = [], writtenPositions = [], currentPosition = null,
  stallThreshold = DEFAULT_PLOTLINE_STALL_CHAPTERS,
} = {}) {
  const out = [];
  if (currentPosition === null || currentPosition === undefined) return out;
  const written = new Set((Array.isArray(writtenPositions) ? writtenPositions : []).map(Number));
  for (const p of plotlines) {
    if (!p) continue;
    const assigned = chapters.filter((c) => Number(c.plotline_id) === Number(p.id));
    if (!assigned.length) continue;
    const due = assigned.filter((c) => Number(c.position) <= Number(currentPosition));
    const done = assigned.filter((c) => written.has(Number(c.position)));
    const title = p.title || `#${p.id}`;
    const entity_id = `plotline:${p.id}`;
    if (!done.length) {
      if (due.length >= 1) {
        out.push({
          severity: 'info', category: 'plotline_not_started', entity_id, chapter: currentPosition,
          message: `剧情线《${title}》在已规划的范围内（截至第 ${Number(currentPosition) + 1} 章）有 ${due.length} 章归属它，`
            + '但已写正文里一章都没有它——这条线还没起线。',
          suggestion: '作品早期属正常；若这条线本应已经起线，就是漏写，需要补。',
          evidence: { plotline_id: p.id, dueChapters: due.length, writtenChapters: 0 },
        });
      }
      continue;
    }
    const lastPos = Math.max(...done.map((c) => Number(c.position)));
    const gap = Number(currentPosition) - lastPos;
    if (gap >= stallThreshold) {
      out.push({
        severity: 'warning', category: 'plotline_stalled', entity_id, chapter: currentPosition,
        message: `剧情线《${title}》已连续 ${gap} 章没有推进（最近一次推进在第 ${lastPos + 1} 章，当前第 ${Number(currentPosition) + 1} 章；阈值 ${stallThreshold} 章）。`,
        suggestion: '要么在这一章给它一个推进点，要么把它标为"这是故意的"（豁免会记住，不再重复报）。',
        evidence: { plotline_id: p.id, lastWrittenPosition: lastPos, gap, stallThreshold },
      });
    }
  }
  return out;
}

/**
 * 汇总入口：跑全部检查 + 应用豁免。
 *
 * 豁免键 = `category:entity_id`（照 Novel-OS：措辞与章节都不进键，
 * 所以检查改进措辞、或同一矛盾换个章节再出现时，作者做过的"这是故意的"不会失效）。
 * 豁免集由调用方提供（本仓库落 `app_settings` 的 `continuity_exemptions:<workId>`）。
 */
export function runContinuityChecks({
  chapter = {}, characters = [], plotlines = [], chapters = [], text = '',
  chapterTarget = 0, workDefault = 0, styleText = '',
  writtenPositions = [], currentPosition = null,
  thresholds = {}, exemptions = [], systemAliases = [],
} = {}) {
  const styleRange = parseChapterLengthRange(styleText);
  const systemMentionMax = Number(thresholds.systemMentionMax) > 0
    ? Number(thresholds.systemMentionMax)
    : (parseSystemMentionMax(styleText) ?? DEFAULT_SYSTEM_MENTION_MAX);
  const stallThreshold = Number(thresholds.plotlineStallChapters) > 0
    ? Number(thresholds.plotlineStallChapters)
    : DEFAULT_PLOTLINE_STALL_CHAPTERS;

  // ⚠️ 三条「按本章判」的检查必须先确认**章真的存在**：调用方可以只给 work_id
  // （例如前端在拿不到章号时刷新预检块），此时 chapter.id 为 null，检查会算出 `chapter:`
  // 这种**空章号键**——豁免键对不上（点了「这是故意的」不管用），界面上还会多出看不懂的条目。
  // 判据缺一半时**不猜**（与装配层同一条原则）：没有章就不判这三条，只留作品级的剧情线检查。
  const hasChapter = Number.isFinite(Number(chapter?.id)) && Number(chapter.id) > 0;
  const raw = [
    ...(hasChapter ? checkCharacterTimePoint({ chapter, characters }) : []),
    ...(hasChapter ? checkSystemFrequency({ chapter, text, max: systemMentionMax, aliases: systemAliases }) : []),
    ...(hasChapter ? checkChapterLength({ chapter, plainLength: plainLen(text), chapterTarget, workDefault, styleRange }) : []),
    ...checkPlotlineProgress({ plotlines, chapters, writtenPositions, currentPosition, stallThreshold }),
  ];
  const { kept, exempted } = partitionExempt(raw, exemptions);
  return {
    checks: [...GUARD_CHECKS],
    findings: sortFindings(kept),
    exempted,
    summary: summarizeFindings(kept),
    checked: {
      plainLength: plainLen(text),
      systemMentionMax,
      styleRange,
      stallThreshold,
      chapterLabel: chapter.label || '',
      characters: characters.length,
      plotlines: plotlines.length,
    },
  };
}
