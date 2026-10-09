/**
 * tests/narrative-repair/03-stage-rules.test.mjs —— E02：阶段化规则编译（离线、零计费）。
 *
 * 覆盖《叙事性专项修复》§5.1/§5.2 的三条要求：
 *   · 同一能力 ID 在不同阶段注入**不同内容**（生成期只给正向许可 / 诊断期给完整判据与反证 / 修稿期只管已选问题）；
 *   · 不传阶段时行为与接入前**逐字一致**（旧调用点零变化，旧作者设置继续可用）；
 *   · 审计摘要可核对"哪个阶段进了哪些规则"，并证明诊断规则**没有**流入生成阶段。
 *
 * 纪律：断言落在**真实编译产物**上（规则块文本/hash/审计字段），不做全文关键字搜索式的假断言。
 */
import { createChecks } from './harness.mjs';
import {
  ABILITIES, EDIT_TIERS, PROTECTION_RULES, EDITING_RULE_VERSION,
  abilityDecision, buildEditingRuleBlock, editingRuleCatalog,
  editingSelectionToSettings, resolveEditingSelection, stageRuleFor,
} from '../../ai/editing/rules.mjs';
import { WRITING_RULES, WRITING_POLICY_VERSION, compileWritingRules as compilePolicyRules } from '../../ai/writing/policy.mjs';

const { check, finish } = createChecks();

const humanizer = ABILITIES.find((a) => a.id === 'fiction-humanizer');
const dialogue = ABILITIES.find((a) => a.id === 'dialogue-editor');
const sel = { enabled: true, tier: 'deai', abilities: ['fiction-humanizer', 'dialogue-editor'], genre: 'general' };
const blockFor = (stage, task = 'write') => buildEditingRuleBlock(sel, { task, stage });

// ── 基础：不传阶段 = 接入前行为 ────────────────────────────────────────────
{
  const base = buildEditingRuleBlock(sel, { task: 'write' });
  check('E02-a', '不传阶段时，规则块逐字使用能力的基础文本（旧调用点零变化）',
    base.text.includes(humanizer.rule) && base.text.includes(dialogue.rule)
    && base.stage === null && base.audit.stage === '(unspecified)'
    && base.audit.stage_variants_used.length === 0 && base.audit.base_fallbacks.length === 0,
    JSON.stringify({ stage: base.stage, variants: base.audit.stage_variants_used.length }));
  check('E02-b', '能力 ID 与版本号仍是同一套（旧作者设置/旧报告可读）',
    EDITING_RULE_VERSION === '1.5.0'
    && editingSelectionToSettings(resolveEditingSelection({ edit_rules_enabled: '1', edit_abilities: 'fiction-humanizer' })).edit_abilities === 'fiction-humanizer'
    && editingRuleCatalog().abilities.some((a) => a.id === 'fiction-humanizer' && a.default_enabled === false),
    EDITING_RULE_VERSION);
}

// ── 阶段变体：内容不同、可追踪 ─────────────────────────────────────────────
{
  const draft = blockFor('draft');
  const verify = blockFor('verify_style', 'review');
  const rewrite = blockFor('rewrite');
  check('E02-c', '三个阶段编译出三个不同的规则块（同一能力不同内容）',
    new Set([draft.hash, verify.hash, rewrite.hash]).size === 3
    && draft.text !== verify.text && verify.text !== rewrite.text && draft.text !== rewrite.text,
    JSON.stringify({ draft: draft.hash, verify: verify.hash, rewrite: rewrite.hash }));
  check('E02-d', '阶段变体真的替换了文本：块里是变体、不是基础 rule（且基础 hash 仍被记录）',
    [draft, verify, rewrite].every((b) => b.sources.some((s) => s.kind === 'ability' && s.stage))
    && [draft, verify, rewrite].every((b) => !b.text.includes(humanizer.rule))
    && draft.sources.every((s) => s.kind !== 'ability' || (s.base_hash && /^[0-9a-f]{16}$/.test(s.base_hash))),
    JSON.stringify(draft.sources.filter((s) => s.kind === 'ability').map((s) => s.id)));
  check('E02-e', '审计摘要给出阶段 / 规则 id / 各类型条数 / 变体与回落（不含正文）',
    draft.audit.stage === 'draft' && draft.audit.policy_version === EDITING_RULE_VERSION
    && draft.audit.rule_ids.includes('edit-protection')
    && draft.audit.rule_ids.some((id) => id === 'ability:fiction-humanizer@draft')
    && draft.audit.counts_by_type.ability === 2 && draft.audit.counts_by_type.protection === 1
    && JSON.stringify(draft.audit).length < 4000,
    JSON.stringify(draft.audit.counts_by_type));
}

// ── 生成期不许带诊断口径；诊断期必须有反证要求 ─────────────────────────────
{
  const draft = blockFor('draft').text;
  const verify = blockFor('verify_style', 'review').text;
  const rewrite = blockFor('rewrite').text;
  check('E02-f', '生成期只给正向许可：不含"完整判据/反证要求/逐处识别"这类评分任务',
    !/完整判据/.test(draft) && !/反证要求/.test(draft) && !/逐处识别/.test(draft)
    && /只给正向许可，不给评分任务/.test(draft),
    draft.slice(draft.indexOf('（生成期'), draft.indexOf('（生成期') + 40));
  check('E02-g', '诊断期带完整判据与反证要求（判不出就 deferred，不报成问题）',
    /完整判据/.test(verify) && /反证要求/.test(verify) && /放 deferred/.test(verify),
    verify.slice(verify.indexOf('（诊断期'), verify.indexOf('（诊断期') + 40));
  check('E02-h', '修稿期只处理已选问题：要求显式 delete 与逐条处置',
    /已经选定/.test(rewrite) && /显式 delete/.test(rewrite) && /处置（patched/.test(rewrite)
    && !/逐处识别/.test(rewrite),
    rewrite.slice(rewrite.indexOf('（修稿期'), rewrite.indexOf('（修稿期') + 40));
  check('E02-i', '写作策略源同样按 scope 隔离：draft 取不到诊断项，verify_style 才取得到',
    compilePolicyRules('draft', { types: ['diagnostic'] }).length === 0
    && compilePolicyRules('verify_style', { types: ['diagnostic'] }).length > 0
    && compilePolicyRules('draft', { types: ['preference'] }).length > 0,
    JSON.stringify({
      draftDiag: compilePolicyRules('draft', { types: ['diagnostic'] }).length,
      verifyDiag: compilePolicyRules('verify_style', { types: ['diagnostic'] }).length,
    }));
}

// ── 未知阶段 / 无变体的能力：回落必须可见，不假装生效 ───────────────────────
{
  const unknown = buildEditingRuleBlock(sel, { task: 'write', stage: 'nonsense' });
  const base = buildEditingRuleBlock(sel, { task: 'write' });
  check('E02-j', '未知阶段 → 回落基础文本，且审计里标出 base_fallback（不假装阶段生效）',
    unknown.hash === base.hash && unknown.audit.base_fallbacks.length === 2
    && unknown.audit.base_fallbacks.every((id) => /^ability:/.test(id)),
    JSON.stringify(unknown.audit.base_fallbacks));
  const protection = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: [], genre: 'general' }, { task: 'write', stage: 'draft' });
  check('E02-k', '保护规则与档位不受阶段影响（事实限制仍在）',
    protection.text.includes(PROTECTION_RULES) && protection.sources.some((s) => s.kind === 'tier')
    && protection.audit.base_fallbacks.length === 0);
}

// ── 与既有的任务/题材门控叠加时的顺序 ─────────────────────────────────────
{
  const onlyReview = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: ['mystery-review'], genre: 'mystery' }, { task: 'write', stage: 'draft' });
  check('E02-l', '阶段变体不越过任务门控（review 能力在 write 任务下仍不加载）',
    !onlyReview.sources.some((s) => s.kind === 'ability')
    && onlyReview.decisions.some((d) => d.id === 'mystery-review' && !d.load && d.reason.startsWith('task_not_applicable')));
  const dec = abilityDecision(humanizer, { task: 'write', genre: 'general' });
  check('E02-m', '阶段不改变能力可用性判定本身（同一 task/genre 结论不变）', dec.load === true && dec.reason === 'ok');
  const unknownAbility = buildEditingRuleBlock({ enabled: true, tier: 'light', abilities: ['not-a-real-ability'], genre: 'general' }, { task: 'write', stage: 'draft' });
  check('E02-n', '未知能力仍然被如实拒绝（不因为带了 stage 就被放过）',
    unknownAbility.decisions[0].load === false && unknownAbility.decisions[0].reason === 'unknown_ability');
}

// ── stageRuleFor 本身的三态 ────────────────────────────────────────────────
{
  check('E02-o', 'stageRuleFor 的四种结果可区分（stage / stage_alias / base / base_fallback）',
    stageRuleFor(humanizer, 'draft').used === 'stage'
    && stageRuleFor(humanizer, 'review').used === 'stage_alias'
    && stageRuleFor(humanizer, 'review').stage === 'verify_style'
    && stageRuleFor(humanizer, '').used === 'base'
    && stageRuleFor(humanizer, 'nonsense').used === 'base_fallback'
    && stageRuleFor({ id: 'x', rule: 'R' }, 'draft').used === 'base_fallback'
    && stageRuleFor({ id: 'x', rule: 'R' }, '').text === 'R');
  check('E02-p', '阶段文本不引入上游项目名（规则仍是本项目自写）',
    !/SillyTavern|Humanizer|InkOS|webnovel-writer|Oh Story/.test(
      ABILITIES.flatMap((a) => Object.values(a.stage_rules || {})).join('')
      + ABILITIES.map((a) => a.rule).join('') + PROTECTION_RULES + EDIT_TIERS.map((t) => t.instruction).join('')));
  check('E02-q', '写作策略版本与规则清单未因本轮改动漂移（仍可绑定检查结果）',
    typeof WRITING_POLICY_VERSION === 'string' && WRITING_RULES.length > 0
    && writingRulesIdsUnique());
}

function writingRulesIdsUnique() {
  const ids = WRITING_RULES.map((r) => r.id);
  return new Set(ids).size === ids.length;
}

finish('03-stage-rules');
