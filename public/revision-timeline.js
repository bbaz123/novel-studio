/*
 * 剧情时间线结构化（revision-timeline）—— 纯函数、零依赖、浏览器与 Node 测试共用（UMD）。
 *
 * 为什么需要它（v1.2.4 方案 §2.3 / §7.1 / P1）：
 *   两轮真实章稿里最硬的一类缺陷是**时序矛盾**：
 *     · B-02：先写"10:41 看手机没有新消息"，后写"母亲的消息是 10:23 发的"；
 *     · B-03：写"这个点刚交完班"，同时写"晚上十点出门、早上八点半回来"。
 *   这两条用关键词替换永远判不出来（把 10:23 改成"刚发的"就能骗过字符串判据），
 *   必须把"时刻 → 事件 → 谁在什么时候知道"抽成结构，再检查顺序与间隔。
 *
 * 本模块只做**可确定性判定的那一半**（方案 §7.1 的原则）：
 *   · 明确的时间冲突 → 确定性失败（hard）；
 *   · 需要理解"人物认知/回忆/转述"的判断 → 交语义层，不在这里猜。
 * 不做：全文知识图谱、跨章引用、主观"节奏"评价。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NovelRevisionTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  const VERSION = '1.0.0';

  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const PERIOD = [
    { re: /(凌晨)/, offset: 0 },
    { re: /(清晨|早上|上午|早晨)/, offset: 0 },
    { re: /(中午|正午)/, offset: 12 },
    { re: /(下午)/, offset: 12 },
    { re: /(傍晚|黄昏)/, offset: 12 },
    { re: /(晚上|夜里|夜间|夜晚)/, offset: 12 },
  ];

  const textOf = (x) => String(x == null ? '' : x);

  function cnNumber(s) {
    const raw = textOf(s).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw.length === 1) return CN[raw] == null ? null : CN[raw];
    const m = raw.match(/^([一二两三四五六七八九])?(十)([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN[m[1]] : 1) * 10 + (m[3] ? CN[m[3]] : 0);
    return null;
  }

  function periodOffset(phrase) {
    for (const p of PERIOD) if (p.re.test(phrase)) return p.offset;
    return 0;
  }

  /** 分钟 → `HH:MM`；> 24h 或负数返回原样（不假装归一）。 */
  function fmtClock(minutes) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 0 || n >= 1440) return String(minutes);
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }

  /**
   * 抽取全部时刻提及。两种形态都认：
   *   ① 数字钟点 `10:41` / `10：41`；
   *   ② 中文钟点 `早上八点半` / `晚上十点` / `下午三点一刻` / `上午九点十五分`。
   * 每条都带 `index`（原文偏移）与 `minutes`（0–1439；无法判定为 null）。
   */
  function extractClocks(text) {
    const s = textOf(text);
    const out = [];
    const taken = [];
    const overlaps = (a, b) => a < b.end && b.start < a.end;

    // ① 数字钟点
    const reDial = /(\d{1,2})\s*[:：]\s*(\d{2})/g;
    let m;
    while ((m = reDial.exec(s))) {
      const h = Number(m[1]);
      const min = Number(m[2]);
      const span = { start: m.index, end: m.index + m[0].length };
      if (h > 23 || min > 59) continue;
      const minutes = h * 60 + min;
      out.push({ kind: 'clock', form: 'digital', raw: m[0], index: m.index, minutes, quote: s.slice(Math.max(0, m.index - 8), span.end + 8) });
      taken.push(span);
    }

    // ② 中文钟点（含"点钟""点整"）
    const reCn = /(凌晨|清晨|早上|上午|早晨|中午|正午|下午|傍晚|黄昏|晚上|夜里|夜间|夜晚)?\s*([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*[点时](?:钟)?\s*(半|一刻|三刻|(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*分)?/g;
    while ((m = reCn.exec(s))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (taken.some((t) => overlaps(span, t))) continue;
      // "一点" 这类在中文里可能是"一点点"，要求出现时段词或明确分钟单位才采纳
      const period = m[1] || '';
      const hourNum = cnNumber(m[2]);
      if (hourNum == null || hourNum > 24) continue;
      const suffix = m[3] || '';
      let min = 0;
      if (suffix === '半') min = 30;
      else if (suffix === '一刻') min = 15;
      else if (suffix === '三刻') min = 45;
      else if (suffix) { const n = cnNumber(suffix.replace(/分/g, '').trim()); if (n != null && n < 60) min = n; }
      if (!period && !suffix && !/点钟|点整/.test(m[0])) continue;
      let hour = hourNum === 24 ? 0 : hourNum;
      // 12 小时制 + 时段词：下午/晚上/傍晚/中午 的 1–11 点要 +12
      if (period && periodOffset(period) === 12 && hour < 12) hour += 12;
      if (!period && hour <= 7) {
        // 无时段词的 1–7 点：可能是下午，也可能是凌晨 —— 如实标 unknown，不猜
        out.push({ kind: 'clock', form: 'cn', raw: m[0].trim(), index: m.index, minutes: null, ambiguous: true, quote: s.slice(Math.max(0, m.index - 8), span.end + 8) });
        taken.push(span);
        continue;
      }
      const minutes = (hour % 24) * 60 + min;
      out.push({ kind: 'clock', form: 'cn', raw: m[0].trim(), index: m.index, minutes, quote: s.slice(Math.max(0, m.index - 8), span.end + 8) });
      taken.push(span);
    }

    // ③ 相对时刻（只用于排序与提示，不参与绝对冲突判定）
    const reRel = /(次日|第二天|隔天|翌日|半小时后|一个小时后|两个小时后|一小时后|当天下午|当天晚上)/g;
    while ((m = reRel.exec(s))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (taken.some((t) => overlaps(span, t))) continue;
      out.push({ kind: 'relative', form: 'relative', raw: m[0], index: m.index, minutes: null, quote: s.slice(Math.max(0, m.index - 10), span.end + 10) });
    }

    return out.sort((a, b) => a.index - b.index);
  }

  /** 严格递增的绝对时刻序列（用于"时间轴是否倒退"这类观察）。 */
  function describeTimeline(text) {
    return extractClocks(text)
      .filter((e) => e.kind === 'clock' && e.minutes != null)
      .map((e) => ({ at: e.minutes, label: fmtClock(e.minutes), raw: e.raw, index: e.index, kind: e.kind }));
  }

  const firstConcrete = (clocks) => clocks.find((c) => c.kind === 'clock' && c.minutes != null) || null;

  function paragraphOf(text, index) {
    const s = textOf(text);
    const before = s.lastIndexOf('\n\n', Math.max(0, index - 1));
    const after = s.indexOf('\n\n', index);
    return s.slice(before < 0 ? 0 : before + 2, after < 0 ? s.length : after);
  }

  /**
   * 检测可确定性判定的时序问题。
   *
   * @param {string} text 候选正文
   * @param {{requiredTerms?:string[], currentClock?:number}} opts
   *        · requiredTerms：蓝图要求必须落地的字面（如纪年 "3751"）
   *        · currentClock：本章"现在"的时刻（分钟）；缺省用正文里第一个具体时刻
   * @returns {{issues:Array, advisories:Array, clocks:Array}}
   *   issues 里的 `hard:true` 项会由验收器当作**字面事实**（模型说 pass 也挡不住）；
   *   advisories 只作提示，**不进 checks**（否则会污染"软判断"这一层）。
   */
  function detectTemporalIssues(text, opts = {}) {
    const s = textOf(text);
    const clocks = extractClocks(s);
    const issues = [];
    const advisories = [];
    const now = Number.isFinite(Number(opts.currentClock)) ? Number(opts.currentClock) : (firstConcrete(clocks) ? firstConcrete(clocks).minutes : null);

    // ① 先读后到：写完"没有新消息"之后（或之前）又给了更早的发送时刻 → 矛盾
    const readAt = (() => {
      const re = /(没有新消息|没收到消息|暂无新消息|没有未读消息)/g;
      const m = re.exec(s);
      if (!m) return null;
      // 同一句里优先取句内时刻
      const para = paragraphOf(s, m.index);
      const inPara = extractClocks(para).filter((c) => c.kind === 'clock' && c.minutes != null);
      return { index: m.index, minutes: inPara.length ? inPara[0].minutes : now, sentence: para };
    })();
    if (readAt && readAt.minutes != null) {
      const reSent = /([0-9]{1,2}\s*[:：]\s*[0-9]{2})\s*(?:发|发送|只发|发来)/g;
      let m;
      while ((m = reSent.exec(s))) {
        const at = extractClocks(m[1])[0];
        if (!at || at.minutes == null) continue;
        if (at.minutes < readAt.minutes) {
          issues.push({
            code: 'MESSAGE_AFTER_READ', hard: true,
            criterion: `消息到达时序自洽（${at.raw} 发出 vs ${fmtClock(readAt.minutes)} 查看）`,
            detail: `正文先写 ${fmtClock(readAt.minutes)} 查看时"没有新消息"，却又说消息是 ${at.raw} 发的：消息早于查看时间却未被看到`,
            index: m.index,
          });
        }
      }
    }

    // ② 班次间隔：写完"这个点刚交完班/刚下班"，同时给了回家时刻且与"现在"相差明显
    const justOff = /(刚交完班|刚下班|才交完班|刚换班)/.exec(s);
    if (justOff && now != null) {
      const home = /([^。！？\n]{0,20}?)(回来|到家|回到家里)/.exec(s);
      let homeAt = null;
      if (home) {
        const para = paragraphOf(s, home.index);
        const inPara = extractClocks(para).filter((c) => c.kind === 'clock' && c.minutes != null);
        homeAt = inPara.length ? inPara[inPara.length - 1].minutes : null;
      }
      if (homeAt != null && now - homeAt >= 30) {
        issues.push({
          code: 'SHIFT_GAP_CONFLICT', hard: true,
          criterion: `班次与"刚交班"的时间间隔自洽（现在 ${fmtClock(now)} vs 回家 ${fmtClock(homeAt)}）`,
          detail: `写"这个点刚交完班"，但正文给出的归家时刻是 ${fmtClock(homeAt)}，与"现在"${fmtClock(now)} 相差 ${now - homeAt} 分钟 —— 按这个时刻她早该到家了`,
          index: justOff.index,
        });
      }
    }

    // ③ 蓝图要求的字面（纪年/单号）必须落地
    const required = (Array.isArray(opts.requiredTerms) ? opts.requiredTerms : []).map(textOf).map((x) => x.trim()).filter(Boolean);
    for (const term of required) {
      if (!s.includes(term)) {
        issues.push({
          code: 'ANCHOR_MISSING', hard: true,
          criterion: `设定要求的字面必须出现：${term}`,
          detail: `蓝图/设定要求 ${term} 在正文落地，但候选里一次都没出现`,
          index: -1,
        });
      }
    }

    // ④ 只作提示：跨天的相对关系未声明（不进 checks）
    const hasEvening = /(晚上|夜里|夜间)/.test(s);
    const hasMorning = /(早上|上午|清晨)/.test(s);
    const hasDate = /(\d{3,4}\s*年|\d{1,2}\s*月|\d{1,2}\s*[日号]|次日|第二天)/.test(s);
    if (hasEvening && hasMorning && !hasDate) {
      advisories.push({
        code: 'DAY_ROLLOVER_UNDECLARED',
        criterion: '跨天关系未声明（晚上 → 次日早上）',
        detail: '正文同时出现晚上与早上的时刻，但没有给出跨天/日期的锚点：读起来"像同一天"，需要作者或语义层确认是否故意',
      });
    }

    return { issues, advisories, clocks };
  }

  return { VERSION, extractClocks, describeTimeline, detectTemporalIssues, fmtClock, cnNumber };
});
