/**
 * 确定性编辑扫描（2026-09-27，R07）——「确定性层」：规则、位置、摘录、严重性与建议。
 *
 * 定位（任务书 §10.2）：确定性与语义分离。
 *   · 本模块只做**可复现的文本事实检查**（计数/位置/模式/结构），输出结构化 finding；
 *   · 它不假装是模型审稿：语义问题（重复解释、角色声音同质、空泛升华的**判断**）仍走既有模型链
 *     （novel_review 语义审稿），本模块不替代它、也不自动改 Canon；
 *   · 所有 finding 都是"给人看的线索"：带规则 id、位置（段号/字符区间）、摘录、严重性、建议；
 *   · 纯函数、零依赖、可离线单测；同一文本 → 同一结果（确定性验证的判据）。
 *
 * 与能力（§10.3）的对应：扫描器按能力启停——关闭的能力不产生 finding（"UI 有开关"不算证据，这里有真实输出差）。
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** 常见机械表达（确定性匹配；只标"命中位置"，是否该改由作者决定）。 */
const AI_TELLS = [
  { pattern: /仿佛|彷佛/g, label: '「仿佛」式比喻' },
  { pattern: /似乎/g, label: '「似乎」模糊化' },
  { pattern: /不由得/g, label: '「不由得」套语' },
  { pattern: /嘴角(勾起|扬起|浮现)[^。！？\n]{0,6}(笑|弧度)/g, label: '万能笑' },
  { pattern: /(心中一|心头一)(紧|颤|暖|沉)/g, label: '模板化心理' },
  { pattern: /空气(仿佛|似乎)?(都)?(凝固|安静下来)/g, label: '套语·空气凝固' },
  { pattern: /(时间|世界)(仿佛|似乎)?(静止|停止)/g, label: '套语·时间静止' },
  { pattern: /(深邃|幽深)的(眼眸|眸子|目光)/g, label: '套语·深邃眼眸' },
  { pattern: /(淡淡|轻轻|缓缓)地/g, label: '副词堆叠（淡淡/轻轻/缓缓）' },
  { pattern: /(不是|并非)[^，。！？\n]{1,12}，而是/g, label: '「不是…而是」排比句' },
  { pattern: /这一切[^。！？\n]{0,10}(都)?(值得|有了意义)/g, label: '空泛升华' },
];

/** 无功能重复检测的窗口（段内 + 跨段相邻重复）。 */
const REPEAT_WINDOW = 2;

const paragraphsOf = (text) => String(text || '')
  .split(/\n+/)
  .map((raw, i) => ({ index: i, text: raw.trim(), offset: 0 }))
  .filter((p) => p.text.length > 0)
  .map((p, i) => ({ ...p, index: i }));

const excerpt = (s, max = 40) => (s.length <= max ? s : `${s.slice(0, max)}…`);

function pushFinding(out, f) {
  out.push({
    rule_id: f.rule_id,
    layer: 'deterministic',
    severity: f.severity || 'low',
    paragraph: Number.isFinite(f.paragraph) ? f.paragraph : null,
    excerpt: excerpt(String(f.excerpt || '')),
    message: String(f.message || ''),
    suggestion: String(f.suggestion || ''),
  });
}

/** 去 AI 腔：机械表达命中（位置 + 摘录）。 */
function scanHumanizer(paras, out) {
  for (const p of paras) {
    for (const tell of AI_TELLS) {
      tell.pattern.lastIndex = 0;
      const m = tell.pattern.exec(p.text);
      if (!m) continue;
      pushFinding(out, {
        rule_id: 'deterministic:ai-tell',
        severity: 'low',
        paragraph: p.index,
        excerpt: p.text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8),
        message: `命中机械表达：${tell.label}`,
        suggestion: '改为具体动作 / 感官细节 / 潜台词；若这里的重复或模糊是刻意效果，保留即可。',
      });
    }
  }
}

/** 对白编辑：连续对白过长（没有动作节拍）、对白段落里的资料倾倒。 */
function scanDialogue(paras, out) {
  let run = 0;
  for (const p of paras) {
    const isTalk = /^[「"'“]|^——/.test(p.text) || /[」"'”]$/.test(p.text);
    run = isTalk ? run + 1 : 0;
    if (run === 5) {
      pushFinding(out, {
        rule_id: 'deterministic:dialogue-run',
        severity: 'medium',
        paragraph: p.index,
        excerpt: p.text,
        message: '连续 5 段以上对白没有动作/环境节拍，读者容易失去方位感',
        suggestion: '在两三句对白之间补一个具体动作或环境反应，让说话人和场景可辨。',
      });
    }
    if (isTalk && p.text.length >= 120) {
      pushFinding(out, {
        rule_id: 'deterministic:dialogue-info-dump',
        severity: 'medium',
        paragraph: p.index,
        excerpt: p.text,
        message: '单段对白过长（可能在对白里倾倒设定资料）',
        suggestion: '把信息拆进动作、冲突或提问里；对白只保留人物此刻真的会说的话。',
      });
    }
  }
}

/** 网文节奏：单段过长、整章平均段长偏高。 */
function scanPacing(paras, out) {
  const longLimit = 220;
  for (const p of paras) {
    if (p.text.length > longLimit) {
      pushFinding(out, {
        rule_id: 'deterministic:paragraph-length',
        severity: p.text.length > longLimit * 1.6 ? 'medium' : 'low',
        paragraph: p.index,
        excerpt: p.text,
        message: `单段 ${p.text.length} 字（超过 ${longLimit} 字参考线）`,
        suggestion: '按动作/视角/时间切分段落；网文阅读节奏偏好短段。',
      });
    }
  }
  if (paras.length >= 6) {
    const avg = paras.reduce((n, p) => n + p.text.length, 0) / paras.length;
    if (avg > 160) {
      pushFinding(out, {
        rule_id: 'deterministic:avg-paragraph',
        severity: 'low',
        paragraph: null,
        excerpt: `平均 ${Math.round(avg)} 字/段`,
        message: '全章平均段长偏长（参考线 160 字/段）',
        suggestion: '考虑在情绪转折与对话密集处多分段，提升推进感。',
      });
    }
  }
}

/** 章末钩子：章尾是否存在未完成动作 / 悬念 / 新信息。 */
function scanChapterHook(paras, out) {
  if (!paras.length) return;
  const tail = paras.slice(-2).map((p) => p.text).join('\n');
  const hookish = /[？?]$/.test(tail.trim())
    || /(忽然|突然|就在这时|下一刻|门外|身后|脚步|声音|电话|消息|来信|短信|敲门|还没有|尚未|来不及)/.test(tail)
    || /(：「|："|——)$/.test(tail.trim());
  if (!hookish) {
    pushFinding(out, {
      rule_id: 'deterministic:chapter-hook',
      severity: 'medium',
      paragraph: paras[paras.length - 1].index,
      excerpt: paras[paras.length - 1].text,
      message: '章尾没有明显的未完成动作 / 悬念 / 新信息',
      suggestion: '由本章已有内容自然生长出一个牵引（新信息、被打断的动作或一个疑问），不要凭空抛新事件。',
    });
  }
}

/** 角色声音：同一章里出现"说话方式"标记的堆叠（口癖/语气词过度一致）。 */
function scanCharacterVoice(paras, out, ctx) {
  const characters = Array.isArray(ctx && ctx.characters) ? ctx.characters : [];
  const names = characters.map((c) => String(c && c.name || '').trim()).filter(Boolean);
  if (!names.length) return;
  const voiceMarks = /(?:冷笑|淡淡道|低声道|沉声道|轻声道|叹了口气|摇了摇头|点了点头)/g;
  const hits = [];
  for (const p of paras) {
    voiceMarks.lastIndex = 0;
    let m;
    while ((m = voiceMarks.exec(p.text))) hits.push({ mark: m[0], paragraph: p.index, text: p.text });
  }
  const byMark = new Map();
  for (const h of hits) byMark.set(h.mark, (byMark.get(h.mark) || 0) + 1);
  for (const [mark, n] of byMark) {
    if (n >= 4) {
      pushFinding(out, {
        rule_id: 'deterministic:voice-repeat',
        severity: 'low',
        paragraph: null,
        excerpt: `${mark} ×${n}`,
        message: `角色说话方式标记「${mark}」在本章重复 ${n} 次（容易被读成同一种声音）`,
        suggestion: '按角色卡给不同人物不同的措辞与句式；重复也可能是刻意节拍，由作者判断。',
      });
    }
  }
}

/** 悬疑审视（确定性部分）：伏笔清单里"已回收"标记缺失的项，与本章相关的提醒。 */
function scanMystery(paras, out, ctx) {
  const foreshadows = Array.isArray(ctx && ctx.foreshadows) ? ctx.foreshadows : [];
  const open = foreshadows.filter((f) => f && (f.status === 'open' || !f.status));
  if (open.length >= 3) {
    pushFinding(out, {
      rule_id: 'deterministic:foreshadow-open',
      severity: 'low',
      paragraph: null,
      excerpt: `未回收伏笔 ${open.length} 条`,
      message: '本章时点仍有较多未回收伏笔（线索公平性需要作者核对）',
      suggestion: '核对读者在揭示前是否见过必要线索；不要把谜底建立在本章首次出现的信息上。',
    });
  }
}

/** 感情线（确定性部分）：感情推进只靠旁白宣布（"他意识到自己爱上了"式句子）。 */
function scanRomance(paras, out) {
  const tellPattern = /(意识到|才发现|明白了)[^。！？\n]{0,12}(爱|心动|喜欢|感情)/g;
  for (const p of paras) {
    tellPattern.lastIndex = 0;
    const m = tellPattern.exec(p.text);
    if (!m) continue;
    pushFinding(out, {
      rule_id: 'deterministic:romance-tell',
      severity: 'medium',
      paragraph: p.index,
      excerpt: p.text.slice(Math.max(0, m.index - 8), m.index + m[0].length + 8),
      message: '感情变化由旁白直接宣布（读者没有见证过程）',
      suggestion: '把"意识到"换成一次具体选择或举动，让关系变化可被观察。',
    });
  }
}

/** 无功能重复：相邻窗口内完全相同的段落（多半是误粘贴或机械重复）。 */
function scanRepeats(paras, out) {
  for (let i = 0; i < paras.length; i += 1) {
    for (let j = i + 1; j <= Math.min(i + REPEAT_WINDOW, paras.length - 1); j += 1) {
      if (paras[i].text === paras[j].text && paras[i].text.length >= 12) {
        pushFinding(out, {
          rule_id: 'deterministic:duplicate-paragraph',
          severity: 'high',
          paragraph: j,
          excerpt: paras[j].text,
          message: `与第 ${i + 1} 段逐字重复（相邻窗口内）`,
          suggestion: '删除或改写重复段；若是有意复沓，请确认它承担了明确的节奏功能。',
        });
      }
    }
  }
}

/**
 * 确定性扫描入口。
 * @param {string} text 章节正文（纯文本）
 * @param {{abilities?:string[], genre?:string, task?:string, characters?:object[], foreshadows?:object[]}} opts
 *   abilities 为**已启用**的能力 id 列表（未启用 = 不产生对应 finding）。
 * @returns {{findings:object[], scanned:object, skipped:object[]}}
 */
export function scanEditing(text, opts = {}) {
  const abilities = Array.isArray(opts.abilities) ? opts.abilities : [];
  const has = (id) => abilities.includes(id);
  const paras = paragraphsOf(text);
  const findings = [];
  const skipped = [];
  const noteSkip = (id, reason) => skipped.push({ id, reason });

  scanRepeats(paras, findings); // 重复与档位无关：误粘贴在任何档位都该被指出
  if (has('fiction-humanizer')) scanHumanizer(paras, findings); else noteSkip('fiction-humanizer', 'disabled');
  if (has('dialogue-editor')) scanDialogue(paras, findings); else noteSkip('dialogue-editor', 'disabled');
  if (has('webnovel-pacing')) scanPacing(paras, findings); else noteSkip('webnovel-pacing', 'disabled');
  if (has('character-voice')) scanCharacterVoice(paras, findings, opts); else noteSkip('character-voice', 'disabled');
  if (has('chapter-hook')) scanChapterHook(paras, findings); else noteSkip('chapter-hook', 'disabled');
  if (has('mystery-review')) scanMystery(paras, findings, opts); else noteSkip('mystery-review', 'disabled');
  if (has('romance-review')) scanRomance(paras, findings); else noteSkip('romance-review', 'disabled');

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || ((a.paragraph ?? -1) - (b.paragraph ?? -1)));
  return {
    findings,
    skipped,
    scanned: {
      paragraphs: paras.length,
      chars: String(text || '').length,
      abilities: [...abilities],
      genre: String(opts.genre || 'general'),
      task: String(opts.task || 'review'),
      // 明确口径：计数来自确定性规则；语义判断不在这里，见 novel_review 语义审稿。
      deterministic: true,
    },
  };
}
