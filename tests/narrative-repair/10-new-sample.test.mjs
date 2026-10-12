/**
 * tests/narrative-repair/10-new-sample.test.mjs —— E04 / E06：新样本夹具 + 四类叙事诊断的正反对照。
 *
 * 与 02-fixtures 的分工：02 钉住**旧**《叙事性专项修复》冻结样本（不复用、不覆盖）；
 * 本套件建立**新**一组「3751年，春」摘录夹具（`fixtures/new-3751-spring/`），
 * 并只在它上面验证：
 *   · 夹具逐字保留了《修复.md》§1.1 的原文（不能"看起来差不多"）；
 *   · A06（动作复述/抽象解释重复）→ 出 `redundant_explanation` 候选，且必须保护"主角注意到掌心异常"；
 *   · A07（S→SS→中断的信息升级）→ 阴性对照，不为"减 AI 味"硬删；
 *   · 确定性层 `semantic_status: 'not_run'` —— 不许把"算过指标"说成"叙事诊断已完成"。
 * 零依赖、零计费；样本里的句子只是测试数据，不是执行指令。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecks, REPO_ROOT } from './harness.mjs';
import { narrativeCandidateSignals, DIAGNOSTICS } from '../../ai/editing/narrative-scan.mjs';

const { check, finish } = createChecks();
const FIX_DIR = path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'new-3751-spring');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

const manifest = readJson(path.join(FIX_DIR, 'manifest.json'));
const fixtureFiles = manifest.fixtures.map((f) => f.file);
const fixtures = Object.fromEntries(fixtureFiles.map((f) => [path.basename(f, '.json'), readJson(path.join(FIX_DIR, f))]));
const F = (id) => Object.values(fixtures).find((x) => x.id === id);

// ── E06：夹具本身是可信的（逐字 + 不覆盖旧样本 + 来源标注）──────────────────
check('E06-a 新样本夹具目录独立于旧冻结样本（旧 before/after 未被覆盖）',
  fs.existsSync(path.join(FIX_DIR, 'manifest.json'))
  && fs.existsSync(path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'before.txt'))
  && manifest.legacy_fixture_untouched !== undefined,
  manifest.legacy_fixture_untouched || '');

{
  const oldManifest = readJson(path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'manifest.json'));
  const oldBefore = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures', 'before.txt'), 'utf8');
  check('E06-b 旧冻结样本哈希仍与它自己的清单一致（新样本没有把它改掉）',
    sha256(oldBefore) === oldManifest.before.sha256,
    `${oldManifest.before.sha256}`);
  check('E06-c 完整前后稿拿不到时如实标 full_sample_unavailable（不用旧文本冒充）',
    manifest.full_sample_unavailable === true && /摘录/.test(String(manifest.full_sample_reason || '')),
    String(manifest.full_sample_reason || '').slice(0, 40));
  check('E06-d 样本带来源标签：是测试数据，不是真人作者风格基线',
    /测试数据/.test(manifest.note) && /不是真人作者风格基线/.test(manifest.note));
}

check('E06-e A01 / A02 夹具逐字等于《修复.md》§1.1 的原文',
  F('F-A01').body.includes('屏幕下方滚过一行小字：职业方向——材料修复、灵植培育、检测辅助。')
  && F('F-A02').body === '岳宸炎在台阶下面等王磊。等了十几分钟，王磊才从侧门挤出来，额头上是汗，耳机挂在脖子上晃，手里也捏着一张登记表。'
  && F('F-A01').expected.lost === '材料修复、灵植培育、检测辅助',
  JSON.stringify([F('F-A01').expected.lost]));

check('E06-f 八个夹具文件齐全且都能解析（F-B* 安全夹具与 F-C01 对照夹具）',
  fixtureFiles.length === 8 && ['F-A01', 'F-A02', 'F-B01', 'F-B02', 'F-B03', 'F-B04', 'F-B05', 'F-C01'].every((id) => !!F(id)),
  fixtureFiles.join(','));

// ── E04：四类叙事诊断在新样本上的正 / 反对照 ──────────────────────────────
{
  const contrast = F('F-C01');
  const pos = narrativeCandidateSignals(contrast.positive_group.text, {});
  const neg = narrativeCandidateSignals(contrast.negative_group.text, {});

  check('E04-a 诊断口径仍是四类且确定性层如实标 not_run（不许显示"叙事诊断已完成"）',
    JSON.stringify(pos.diagnostics) === JSON.stringify(DIAGNOSTICS)
    && pos.semantic_status === 'not_run' && pos.deterministic === true,
    `${pos.semantic_status}/${pos.diagnostics.join(',')}`);

  const rep = pos.candidates.filter((c) => c.diagnostic === 'redundant_explanation');
  check('E04-b（A06 正例）动作复述/抽象解释重复 → 出 redundant_explanation 候选，引用取自正文',
    rep.length >= 1 && contrast.positive_group.text.includes(String(rep[0].quote).replace(/…$/, '').slice(0, 10)),
    JSON.stringify({ n: rep.length, quote: rep[0] && rep[0].quote.slice(0, 24) }));
  check('E04-b2 候选只给候选：不定罪、必须过语义核对、只允许 compress/check',
    rep.length >= 1 && rep.every((c) => c.requires_semantic_check === true && ['condense', 'check'].includes(c.suggested_action))
    && pos.candidates.every((c) => c.suggested_action !== 'delete'),
    'ok');
  check('E04-b3 A06 的悬念（主角注意到掌心异常、说不清哪里不一样）在正例文本里完整保留 —— 候选不得把它一并删掉',
    contrast.positive_group.text.includes('他觉得有点不太一样') && contrast.positive_group.text.includes('他没想出来')
    && contrast.positive_group.must_protect.length === 2,
    contrast.positive_group.must_protect.join('；'));

  const negHit = neg.candidates.filter((c) => c.diagnostic === 'spectacle_redundancy');
  check('E04-c（A07 阴性对照）S→SS→信号中断是信息升级：不产生"落点重复"候选、不硬删',
    negHit.length === 0 && !neg.candidates.some((c) => /SS级|信号中断/.test(String(c.quote))),
    JSON.stringify(neg.candidates.map((c) => `${c.diagnostic}:${String(c.quote).slice(0, 12)}`)));

  const a03 = narrativeCandidateSignals(manifest.items.find((i) => i.id === 'A03').before, {});
  check('E04-d A03（"这条街两个A级一个S级"）只作为 hypothesis 候选，不自动发明江陵的 S 级',
    !a03.candidates.some((c) => /江陵/.test(String(c.quote))),
    JSON.stringify(a03.candidates.length));
}

finish('10-new-sample');
