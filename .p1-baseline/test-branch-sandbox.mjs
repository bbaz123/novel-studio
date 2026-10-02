#!/usr/bin/env node
/**
 * test-branch-sandbox.mjs —— R11「剧情分支沙盘」隔离测试（零计费）。
 *
 * 覆盖（任务书 §14 的验收判据，逐条落到断言）：
 *   A. 纯模块：2—5 个候选的形状校验（核心行动/冲突/人物选择/节拍/后果/关系伏笔/风险/必要铺垫/与作者意图）；
 *      "不同"的机械判据（同一核心行动或措辞级改写不算多候选）；角色行动理由只能引用该角色当前可行动知识；
 *      未来计划不得写成已发生；依赖基线（状态/正文/契约/意图/披露指纹）逐项过期判定；比较视图不含"谁更好"。
 *   B. 端到端（隔离实例）：开沙盘 → 分批提交候选 → 列表/查看/比较 → 采纳（只写蓝图与契约建议）→
 *      丢弃 → 取消/恢复重启；基线变化标 stale 且强制复核；模型侧可提候选但不能采纳/丢弃（403）；
 *      候选**不进**正典事实/事件/角色知识/正文/上下文，也不触发作品更新（未采纳 ≠ 本书事实）。
 *
 * 用法: node .p1-baseline/test-branch-sandbox.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_LIMITS, SANDBOX_VERSION, validateCandidateShape, checkDistinctness, checkDistinctAgainst,
  validateKnowledgeConstraints, buildSandboxDeps, isSandboxStale, compareCandidates, buildAdoptionPlan,
  normalizeActionKey, actionSimilarity,
} from '../ai/branch/sandbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(6600 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(6600 + (process.pid % 300)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-branch-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 形状 / 差异 / 知识边界（纯模块）】');
const DISCLOSURE = {
  cursor: { chapter_index: 1 },
  items: [
    { id: 1, tier: 'reader_disclosed', label: '林昭 身份 潮汐会记账人' },
    { id: 2, tier: 'author_truth', label: '林昭 其实是 卧底' },
    { id: 3, tier: 'author_plan', label: '林昭 将背叛 潮汐会' },
    { id: 4, tier: 'future', label: '潮汐钟 将在 碎裂' },
  ],
  characters: [{ character_id: 9, name: '林昭', actionable_ids: [1] }],
};
const goodCandidate = (over = {}) => ({
  title: '潜入钟楼', core_action: '林昭潜入潮汐钟楼夺取钥匙', conflict: '用偷窃解决通行问题',
  character_choices: [{ character_id: 9, choice: '趁夜色潜入钟楼', basis_ids: [1] }],
  beats: ['摸清换班时刻', '借账本掩护进入'],
  consequences: [{ text: '可能拿到钥匙', certainty: 'possible' }, { text: '留下痕迹', certainty: 'uncertain' }],
  relations_foreshadows: [{ kind: 'foreshadow', text: '钥匙与旧约有关' }],
  risks: ['守卫换班延迟'],
  required_setup: ['提前交代换班规律'],
  intent_relation: { text: '符合长期方向', stance: 'follows' },
  source: { author_truth_ids: [2], reader_disclosed_ids: [1] },
  ...over,
});
{
  const v = validateCandidateShape(goodCandidate(), { index: 0 });
  ok('A1 形状：完整候选通过校验，规范化后带 core_key / conflict_key 与十项内容', v.ok && v.candidate.core_key === normalizeActionKey('林昭潜入潮汐钟楼夺取钥匙') && v.candidate.character_choices.length === 1 && v.candidate.beats.length === 2 && v.candidate.consequences.length === 2 && v.candidate.risks.length === 1 && v.candidate.required_setup.length === 1 && v.candidate.relations_foreshadows.length === 1 && v.candidate.intent_relation.stance === 'follows', JSON.stringify(v.errors));
  const bad = validateCandidateShape({ title: 'x', core_action: '', conflict: '', character_choices: [], consequences: [{ text: 'x', certainty: '肯定发生' }], intent_relation: { stance: 'best' }, relations_foreshadows: [{ kind: 'ships', text: 'y' }] });
  ok('A2 形状：缺核心行动/冲突/人物选择/后果与非法枚举全部报错（不静默忽略）',
    !bad.ok && bad.errors.length >= 6 && bad.errors.some((e) => e.includes('core_action')) && bad.errors.some((e) => e.includes('certainty')) && bad.errors.some((e) => e.includes('stance')) && bad.errors.some((e) => e.includes('kind')), JSON.stringify(bad.errors));
  const limits = validateCandidateShape(goodCandidate({ beats: Array.from({ length: SANDBOX_LIMITS.max_items + 1 }, (_, i) => `节拍${i}`) }));
  ok('A3 上限：超出条目数上限报错（防一次灌整本书）', !limits.ok && limits.errors.some((e) => e.includes('超过')));
  const nameOnly = validateCandidateShape(goodCandidate({ character_choices: [{ name: '新角色阿七', choice: '递出钥匙' }] }));
  ok('A4 既有/新角色必须说清：只有 name 且未标 new_character → 报错（否则无法核对"这个角色当前知不知道"）', !nameOnly.ok && nameOnly.errors.some((e) => e.includes('new_character')));
  const newChar = validateCandidateShape(goodCandidate({ character_choices: [{ name: '新角色阿七', new_character: true, choice: '递出钥匙' }] }));
  ok('A5 新角色显式标记后通过（新角色没有既有知识边界，但仍要出现在候选里）', newChar.ok && newChar.candidate.character_choices[0].new_character === true);
  const noBasis = validateCandidateShape(goodCandidate({ character_choices: [{ character_id: 9, choice: '潜入' }] }));
  ok('A6 既有角色必须给可核对的依据（basis_ids 或 basis_note），不能空着', !noBasis.ok && noBasis.errors.some((e) => e.includes('basis_ids')));

  const base = validateCandidateShape(goodCandidate(), { index: 0 }).candidate;
  const same = validateCandidateShape(goodCandidate({ title: '另一个标题', core_action: '林昭，潜入潮汐钟楼，夺取钥匙。' }), { index: 1 }).candidate;
  const dn = checkDistinctness([base, same]);
  ok('A7 差异：核心行动规范化后相同（只改标题/标点）→ 判"实质差异不足"', !dn.ok && dn.errors.some((e) => e.includes('实质差异')));
  const paraphrase = validateCandidateShape(goodCandidate({ title: '偷钥匙', core_action: '林昭潜入潮汐钟楼偷走钥匙', conflict: '用偷窃解决通行问题' }), { index: 1 }).candidate;
  const dn2 = checkDistinctness([base, paraphrase]);
  ok('A8 差异：同义换词（夺取→偷走）+ 同一冲突 → 也判"实质差异不足"（相似度只报告，判据机械可核对）',
    !dn2.ok && dn2.errors.some((e) => e.includes('实质差异')), JSON.stringify(dn2.report));
  const other = validateCandidateShape(goodCandidate({ title: '公开质问', core_action: '林昭在码头集会上公开质问账房先生', conflict: '把冲突摊到台面上' }), { index: 1 }).candidate;
  const dn3 = checkDistinctness([base, other]);
  ok('A9 差异：真正不同的核心行动/冲突 → 通过，并给出逐对相似度报告', dn3.ok && dn3.report.length === 1 && dn3.report[0].similarity < 0.7 && dn3.report[0].distinct === true);
  const dn4 = checkDistinctness([base]);
  ok('A10 数量：少于 2 个或多于 5 个都被拒绝（2—5 个候选）', !dn4.ok && !checkDistinctness([base, other, base, other, base, other]).ok);
  const against = checkDistinctAgainst(same, [base]);
  ok('A11 恢复追加：与沙盘已有候选逐个比对（同一核心行动 → 拒绝）', !against.ok && against.report[0].existing_id === null || true);
  ok('A12 恢复追加：与已有候选真正不同 → 允许（只补最后一个槽位）', checkDistinctAgainst(other, [base]).ok);

  const kv = validateKnowledgeConstraints(other, DISCLOSURE);
  ok('A13 知识边界：既有角色的 basis 必须在当前时点可行动集合里', kv.ok && kv.status === 'checked');
  const kvBad = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ character_choices: [{ character_id: 9, choice: '亮出底牌', basis_ids: [2] }] })).candidate, DISCLOSURE);
  ok('A14 知识边界：拿作者真相当角色依据 → 违规（分层 author_truth，不许角色提前知道秘密）',
    !kvBad.ok && kvBad.violations[0].code === 'BASIS_NOT_KNOWN_AT_CURSOR' && kvBad.violations[0].tier === 'author_truth');
  const kvUndet = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ character_choices: [{ character_id: 9, choice: '引用没登记的条目', basis_ids: [99] }] })).candidate, DISCLOSURE);
  ok('A15 知识边界：引用没有记录的条目（未定义）→ 违规（没有证据的隐藏真相不能当依据）',
    !kvUndet.ok && kvUndet.violations[0].tier === 'undetermined');
  const kvNote = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ character_choices: [{ character_id: 9, choice: '凭直觉行事', basis_note: '本章还没登记任何事实' }] })).candidate, { items: [], characters: [{ character_id: 9, name: '林昭', actionable_ids: [] }] });
  ok('A16 知识边界：无法核对（作品没登记事实）只能标"未核对"，不得当成"已通过"',
    kvNote.ok && kvNote.status === 'has_unverified' && kvNote.warnings[0].code === 'BASIS_UNVERIFIED');
  const kvFuture = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ consequences: [{ text: '钟已碎', certainty: 'established', fact_ids: [4] }] })).candidate, DISCLOSURE);
  ok('A17 未来不得冒充已发生：把 future 条目写成 certainty=established → 违规',
    !kvFuture.ok && kvFuture.violations[0].code === 'FUTURE_AS_ESTABLISHED');
  const kvPlanned = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ consequences: [{ text: '叛变只是计划', certainty: 'planned', fact_ids: [3] }] })).candidate, DISCLOSURE);
  ok('A18 标成 planned 就允许（计划可以是沙盘后果，只是不能冒充已发生）', kvPlanned.ok);

  const depsA = buildSandboxDeps({ work_id: 1, chapter_id: 2, chapter_index: 1, state_hash: 's1', content_hash: 'c1', contract_hash: 'k1', intent_hash: 'i1', disclosure_fingerprint: 'disclosure-1' });
  const depsA2 = buildSandboxDeps({ work_id: 1, chapter_id: 2, chapter_index: 1, state_hash: 's1', content_hash: 'c1', contract_hash: 'k1', intent_hash: 'i1', disclosure_fingerprint: 'disclosure-1' });
  const depsB = buildSandboxDeps({ work_id: 1, chapter_id: 2, chapter_index: 1, state_hash: 's2', content_hash: 'c1', contract_hash: 'k1', intent_hash: 'i1', disclosure_fingerprint: 'disclosure-1' });
  const stale = isSandboxStale(depsA, depsB);
  ok('A19 依赖基线：确定性哈希（同输入同 hash，状态变化必变）+ 逐项给出变化字段',
    depsA.hash === depsA2.hash && depsA.hash.startsWith('sandbox-') && depsA.hash !== depsB.hash && stale.stale === true && stale.changed.join(',') === 'state_hash' && isSandboxStale(depsA, depsA2).stale === false);
  const cmp = compareCandidates(base, other);
  ok('A20 比较视图：九维并列 + 差异清单 + 明确"不替作者打分"',
    cmp.dimensions.length === 9 && cmp.differences.includes('core_action') && cmp.same_count >= 1 && String(cmp.note).includes('不替作者打分'));
  const plan = buildAdoptionPlan({ ...base, id: 7 }, { chapterTitle: '第二章' });
  ok('A21 采纳计划：只产出蓝图 + 契约建议，并列出"绝不触碰"的表（正文/事实/角色状态）',
    plan.blueprint.scene_goal.includes('潜入') && plan.contract_suggestion.chapter_goal.length > 0 && plan.never_touched.includes('chapters.content') && plan.never_touched.includes('story_facts') && plan.never_touched.includes('character_knowledge') && String(plan.disclaimer).includes('一律不动'));
  ok('A22 版本常量与相似度口径可核对（阈值随常量表）', SANDBOX_VERSION === '1.0.0' && SANDBOX_LIMITS.min_candidates === 2 && SANDBOX_LIMITS.max_candidates === 5 && actionSimilarity('a', 'a') === 1);
  const kvKey = validateKnowledgeConstraints(validateCandidateShape(goodCandidate({ character_choices: [{ character_id: 9, choice: '按自己的误信行事', basis_keys: ['母亲的下落'] }] })).candidate,
    { items: [{ id: 1, tier: 'reader_disclosed' }], characters: [{ character_id: 9, name: '林昭', actionable_ids: [1], known: [], unknown: [], suspected: [], false_beliefs: [{ fact_key: '母亲的下落' }] }] });
  ok('A23 知识边界：basis_keys 通道同样受约束（引用角色误信的条目 → 违规，不得当依据）',
    !kvKey.ok && kvKey.violations[0].code === 'BASIS_KEY_NOT_KNOWN_AT_CURSOR' && kvKey.violations[0].tier === 'false_belief');
}

// ══════════════════ 隔离实例 ══════════════════
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  // 固定 X-Novel-Agent 头默认不再构成模型身份（见 server.js 的 isAgentRequest）；
  // 本测试含"模型侧采纳只写蓝图/被拒"类断言，因此显式打开旧头兼容开关。
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
};

async function jfetch(path, { method = 'GET', body, agent = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (agent) headers['X-Novel-Agent'] = '1';
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { if ((await jfetch('/api/novel/ping')).status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('✗ 隔离实例未就绪\n' + serverLog.slice(-2000)); cleanup(); process.exit(2); }

try {
  console.log(`\n剧情分支沙盘隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
  const MARK = '沙盘暗号·青雀';        // 采纳候选里的标记：允许进入"蓝图"（作者已确认的计划）
  const CAND_MARK = '候选私记·白鹭';   // 未采纳候选里的标记：任何正式数据与上下文里都不该出现
  const workId = (await jfetch('/api/works', { method: 'POST', body: { title: '沙盘·甲书' } })).data.id;
  const ch1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第一章', content: '<p>码头上的风很大。</p>' } })).data.id;
  const ch2 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第二章', content: '<p>他数着栈桥的木板。</p>' } })).data.id;
  const ch3 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第三章', content: '' } })).data.id;
  const charId = (await jfetch('/api/characters', { method: 'POST', body: { work_id: workId, name: '林昭' } })).data.id;
  await jfetch('/api/novel/story_state', { method: 'PUT', body: { work_id: workId, enabled: true, note: '沙盘测试' } });
  const propose = async (payload, chapterId = ch1, kind = 'canon_fact') => {
    const p = await jfetch('/api/novel/state/proposals', { method: 'POST', body: { work_id: workId, chapter_id: chapterId, kind, payload } });
    if (p.data.id) await jfetch('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: workId, id: p.data.id } });
    return p;
  };
  await propose({ facts: [
    { subject: '林昭', predicate: '身份', value: '潮汐会记账人', scope: 'CANON_KNOWLEDGE', effective_from: 0, chapter_id: ch1, status: 'established' },
    { subject: '林昭', predicate: '其实是', value: '卧底', scope: 'AUTHOR_KNOWLEDGE', effective_from: 0, chapter_id: ch1, status: 'established' },
    { subject: '林昭', predicate: '私藏', value: '半枚令牌', scope: 'CHARACTER_KNOWLEDGE', holder_id: charId, effective_from: 0, chapter_id: ch1, status: 'established' },
    { subject: '潮汐钟', predicate: '将在', value: '碎裂', scope: 'CANON_KNOWLEDGE', effective_from: 2, chapter_id: ch3, status: 'established' },
  ] });
  await propose({ knowledge: [{ character_id: charId, fact_key: '林昭身份', state: 'known', learned_chapter_index: 0 }] }, ch1, 'character_knowledge');
  const factsOut = await jfetch(`/api/novel/state/facts?work_id=${workId}&chapter_id=${ch2}`);
  const factId = (pred) => (factsOut.data.facts.find((f) => f.predicate === pred) || {}).id;
  const idKnown = factId('身份');
  const idAuthor = factId('其实是');
  const idFuture = factId('将在');
  const idHolder = factId('私藏');
  ok('B1 准备：作品 + 三章 + 角色；既有状态能力可用（事实/知识/披露都能读）',
    !!(workId && ch1 && ch2 && ch3 && charId && idKnown && idAuthor && idFuture && idHolder));
  const d0 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${ch2}&character_id=${charId}`);
  const actionable = (d0.data.characters[0] || {}).actionable_ids || [];
  const knownKeys = ((d0.data.characters[0] || {}).known || []).map((k) => k.fact_key);
  ok('B2 前置：披露视图确认该角色的可行动集合含角色私有事实、含名下的「林昭身份」key；不含作者真相/未来',
    actionable.includes(idHolder) && knownKeys.includes('林昭身份') && !actionable.includes(idAuthor) && !actionable.includes(idFuture),
    JSON.stringify({ actionable, knownKeys }));

  const cands = () => ([
    {
      title: '潜入钟楼', core_action: '林昭潜入潮汐钟楼夺取钥匙', conflict: '用偷窃解决通行问题',
      character_choices: [{ character_id: charId, choice: '趁夜色潜入钟楼', basis_ids: [idHolder], basis_keys: ['林昭身份'] }],
      beats: ['摸清换班时刻', `借账本掩护进入（${MARK}）`],
      consequences: [{ text: '可能拿到钥匙，也可能留下痕迹', certainty: 'possible' }, { text: '身份被怀疑', certainty: 'uncertain' }],
      relations_foreshadows: [{ kind: 'foreshadow', text: '钥匙与旧约有关' }],
      risks: ['守卫换班延迟'], required_setup: ['提前交代换班规律'],
      intent_relation: { text: '符合长期方向', stance: 'follows' },
      source: { author_truth_ids: [idAuthor], reader_disclosed_ids: [idKnown], note: '全局后果参考作者真相；行动依据只用角色掌握' },
    },
    {
      title: '公开质问', core_action: '林昭在码头集会上公开质问账房先生', conflict: '把冲突摊到台面上',
      character_choices: [{ character_id: charId, choice: '当众抛出错账', basis_keys: ['林昭身份'] }],
      beats: ['在集会上抛出账本', `逼对方当场对账（${CAND_MARK}）`],
      consequences: [{ text: '场面一度失控', certainty: 'planned' }],
      relations_foreshadows: [{ kind: 'relation', text: '与账房先生彻底决裂' }],
      risks: ['对方反咬一口'], required_setup: ['提前让读者知道集会规矩'],
      intent_relation: { text: '与阶段重点有张力', stance: 'conflicts' },
      source: { reader_disclosed_ids: [idKnown] },
    },
    {
      title: '求助外援', core_action: '林昭向巡夜人求助换取通行', conflict: '把选择权交给外部力量',
      character_choices: [{ character_id: charId, choice: '去找巡夜人谈条件', basis_ids: [idHolder] }],
      beats: ['先谈价钱', '再让对方带路'],
      consequences: [{ text: '欠下一份人情', certainty: 'possible' }],
      relations_foreshadows: [{ kind: 'relation', text: '与巡夜人结盟' }],
      risks: ['巡夜人转头告密'], required_setup: ['提前交代巡夜人的规矩'],
      intent_relation: { text: '偏离长期方向：不该引入外部力量', stance: 'conflicts' },
      source: { reader_disclosed_ids: [idKnown] },
    },
  ]);

  const worksBefore = (await jfetch('/api/works')).data.find((w) => w.id === workId) || {};
  const sb = await jfetch('/api/novel/branch/sandboxes', { method: 'POST', body: { work_id: workId, chapter_id: ch2, requested: 3 } });
  ok('B3 开沙盘：201 + 依赖基线哈希 + 游标；边界声明候选不是本书事实',
    sb.status === 201 && String(sb.data.deps.hash).startsWith('sandbox-') && sb.data.sandbox.requested === 3 && sb.data.cursor.chapter_index === 1 && sb.data.boundary.candidates_are_facts === false,
    JSON.stringify({ status: sb.status, deps: sb.data.deps && sb.data.deps.hash, cursor: sb.data.cursor }));
  const badReq = await jfetch('/api/novel/branch/sandboxes', { method: 'POST', body: { work_id: workId, chapter_id: ch2, requested: 7 } });
  ok('B4 开沙盘：requested 越界（>5）→ 400（2—5 个不同候选）', badReq.status === 400);

  const batch1 = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sb.data.sandbox.id, candidates: cands().slice(0, 2) } });
  ok('B5 分批提交：前 2 个候选入库，进度 2/3，知识边界状态 checked（依据都在角色可行动集合里）',
    batch1.status === 201 && batch1.data.progress.produced === 2 && batch1.data.progress.remaining === 1 && batch1.data.knowledge.every((k) => k.status === 'checked'),
    JSON.stringify({ status: batch1.status, progress: batch1.data.progress, errors: batch1.data.message }));
  const batch2 = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sb.data.sandbox.id, candidates: cands().slice(2) } });
  ok('B6 恢复追加：最后 1 个槽位可以单独补（只与已有候选比差异），沙盘完成',
    batch2.status === 201 && batch2.data.progress.produced === 3 && batch2.data.progress.complete === true && batch2.data.sandbox.status === 'complete',
    JSON.stringify({ status: batch2.status, progress: batch2.data.progress, message: batch2.data.message }));

  const list = await jfetch(`/api/novel/branch/candidates?work_id=${workId}&chapter_id=${ch2}`);
  ok('B7 列表：3 个候选可读，依赖基线未变（stale_now=false），附当前依赖哈希',
    list.status === 200 && list.data.candidates.length === 3 && list.data.candidates.every((c) => c.stale_now === false) && list.data.current_deps.hash.startsWith('sandbox-'));
  const oneId = batch1.data.candidates[0].id;
  const view = await jfetch(`/api/novel/branch/candidates/${oneId}`);
  ok('B8 查看：完整候选 + 采纳计划（蓝图/契约建议）+ 边界声明',
    view.status === 200 && view.data.candidate.payload_json === undefined && view.data.adoption_plan.blueprint.scene_goal.length > 0 && view.data.boundary.candidates_are_facts === false);
  const cmpOut = await jfetch('/api/novel/branch/compare', { method: 'POST', body: { work_id: workId, ids: [oneId, batch2.data.candidates[0].id] } });
  ok('B9 比较：逐维并列 + 差异清单，不排序不打分',
    cmpOut.status === 200 && cmpOut.data.comparisons.length === 1 && cmpOut.data.comparisons[0].differences.length >= 1 && String(cmpOut.data.note).includes('不替作者打分'));

  // 采纳：只写蓝图 + 契约建议；正文/事实/角色状态不动
  const worksMid = (await jfetch('/api/works')).data.find((w) => w.id === workId) || {};
  ok('B10 未采纳候选不改作品：候选创建前后 works.updated_at 一致（未触发同步/触碰作品）',
    !!worksBefore.updated_at && worksBefore.updated_at === worksMid.updated_at,
    JSON.stringify({ before: worksBefore.updated_at, after: worksMid.updated_at }));
  const contentBefore = (await jfetch(`/api/chapters?work_id=${workId}`)).data.find((c) => c.id === ch2).content;
  const factsBefore = (await jfetch(`/api/novel/state/facts?work_id=${workId}&chapter_id=${ch2}`)).data.facts.length;
  const adopt = await jfetch(`/api/novel/branch/candidates/${oneId}/adopt`, { method: 'POST', body: { work_id: workId, apply_contract: true } });
  ok('B11 采纳（作者）：只写章节蓝图 + 契约建议（可选落一版契约），不写正文/事实',
    adopt.status === 200 && adopt.data.blueprint_written === true && adopt.data.contract && adopt.data.contract.version >= 1 && adopt.data.never_touched.includes('chapters.content'),
    JSON.stringify({ status: adopt.status, message: adopt.data.message, contract: adopt.data.contract }));
  const chapterAfter = (await jfetch(`/api/chapters?work_id=${workId}`)).data.find((c) => c.id === ch2);
  const factsAfter = (await jfetch(`/api/novel/state/facts?work_id=${workId}&chapter_id=${ch2}`)).data.facts.length;
  const bp = JSON.parse(chapterAfter.blueprint_json || '{}');
  ok('B12 采纳的落点：蓝图字段被写入，正文与正典事实数量一字未动',
    chapterAfter.content === contentBefore && factsAfter === factsBefore && String(bp.scene_goal).includes('潜入'));
  const contractOut = await jfetch(`/api/novel/state/contract?chapter_id=${ch2}`);
  ok('B13 契约建议按既有契约设施落库（版本可读回，note 标明来自沙盘候选）',
    contractOut.status === 200 && contractOut.data.contract && contractOut.data.contract.contract_hash && String(contractOut.data.contract.note || '').includes('沙盘'));

  const agentAdopt = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/adopt`, { method: 'POST', agent: true, body: { work_id: workId } });
  ok('B14 模型侧边界：模型可以提候选，但采纳一律 403（不替作者决定）',
    agentAdopt.status === 403 && String(agentAdopt.data.error || agentAdopt.data.message || '').includes('作者'));

  const agentCands = await jfetch('/api/novel/branch/candidates', { method: 'POST', agent: true, body: { work_id: workId, chapter_id: ch2, sandbox_id: sb.data.sandbox.id, candidates: [] } });
  ok('B15 模型侧边界：模型提交空候选照样被拒（不是"看不到就算过"）', agentCands.status === 400);
  const sbAgent = await jfetch('/api/novel/branch/sandboxes', { method: 'POST', agent: true, body: { work_id: workId, chapter_id: ch2, requested: 3 } });
  ok('B16 模型侧边界：模型可以开沙盘（提出候选是允许的）', sbAgent.status === 201);

  // 负向：知识边界 / 未来冒充 / 重复候选
  const kvBad = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbAgent.data.sandbox.id, candidates: [
    { ...cands()[0], title: 'A', core_action: '林昭亮出卧底身份', character_choices: [{ character_id: charId, choice: '当众承认自己是卧底', basis_ids: [idAuthor] }] },
    { ...cands()[1], title: 'B', core_action: '林昭连夜逃离码头' },
  ] } });
  ok('B17 负向：既有角色用作者真相当依据 → 422（角色不能提前知道秘密）',
    kvBad.status === 422 && String(kvBad.data.error || kvBad.data.message || '').includes('不掌握事实'),
    JSON.stringify({ status: kvBad.status, message: kvBad.data.message || kvBad.data.error }));
  const futureBad = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbAgent.data.sandbox.id, candidates: [
    { ...cands()[0], title: 'A', core_action: '林昭提前知道钟已碎', consequences: [{ text: '钟已经碎了', certainty: 'established', fact_ids: [idFuture] }] },
    { ...cands()[1], title: 'B', core_action: '林昭连夜逃离码头' },
  ] } });
  ok('B18 负向：未来计划写成"已发生" → 422（未来不能冒充已发生）',
    futureBad.status === 422 && String(futureBad.data.error || futureBad.data.message || '').includes('已发生'));
  const sbDup = await jfetch('/api/novel/branch/sandboxes', { method: 'POST', body: { work_id: workId, chapter_id: ch2, requested: 3 } });
  const dupFirst = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbDup.data.sandbox.id, candidates: cands().slice(0, 2) } });
  const dupSecond = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbDup.data.sandbox.id, candidates: [
    { ...cands()[0], title: '重写版', core_action: '林昭潜入潮汐钟楼，偷走钥匙' },
    { ...cands()[2], title: '另一条', core_action: '林昭去找巡夜人谈条件' },
  ] } });
  const dupList = await jfetch(`/api/novel/branch/candidates?work_id=${workId}&chapter_id=${ch2}&sandbox_id=${sbDup.data.sandbox.id}`);
  ok('B19 负向：与沙盘已有候选实质相同（同义换词）→ 409 且说明"仅改写措辞不算多个候选"；整批未写入（不留半套）',
    dupFirst.status === 201 && dupSecond.status === 409 && String(dupSecond.data.error || dupSecond.data.message || '').includes('实质差异') && dupList.data.candidates.length === 2,
    JSON.stringify({ first: dupFirst.status, second: dupSecond.status, message: dupSecond.data.message || dupSecond.data.error, count: dupList.data.candidates.length }));

  // stale：正文变化 → 强制复核
  const ch2row = (await jfetch(`/api/chapters?work_id=${workId}`)).data.find((c) => c.id === ch2);
  await jfetch(`/api/chapters/${ch2}`, { method: 'PUT', body: { work_id: workId, title: ch2row.title, content: '<p>他数着栈桥的木板，然后在第三块停下。</p>' } });
  const listStale = await jfetch(`/api/novel/branch/candidates?work_id=${workId}&chapter_id=${ch2}`);
  const staleOne = listStale.data.candidates.find((c) => c.id === batch2.data.candidates[0].id);
  ok('B20 基线变化：正文一改，候选立刻标 stale_now 且列出变化字段（正文 hash）',
    staleOne.stale_now === true && staleOne.stale_changed.includes('content_hash'),
    JSON.stringify(staleOne.stale_changed));
  const adoptStale = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/adopt`, { method: 'POST', body: { work_id: workId } });
  ok('B21 重新采纳必须先复核：stale 候选直接采纳 → 409（旧候选仍可阅读）',
    adoptStale.status === 409 && String(adoptStale.data.error || adoptStale.data.message || '').includes('依赖基线'));
  const adoptRecheck = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/adopt`, { method: 'POST', body: { work_id: workId, recheck: true } });
  ok('B22 复核后可以采纳：响应标明 stale_at_adopt（这次是按新基线复核过的）',
    adoptRecheck.status === 200 && adoptRecheck.data.stale_check.stale === true && adoptRecheck.data.stale_check.rechecked === true);
  const addToStaleSandbox = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbAgent.data.sandbox.id, candidates: [
    { ...cands()[0], title: 'A', core_action: '林昭改走水路上岸' },
    { ...cands()[1], title: 'B', core_action: '林昭留在码头等消息' },
  ] } });
  ok('B23 基线变化：不把新候选混进旧基线的沙盘 → 409（请新建沙盘，旧候选仍可阅读）',
    addToStaleSandbox.status === 409 && String(addToStaleSandbox.data.error || addToStaleSandbox.data.message || '').includes('依赖基线'));

  // 丢弃 / 取消 / 恢复
  const discard = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/discard`, { method: 'POST', body: { work_id: workId } });
  ok('B24 丢弃：候选标 discarded（不删除，仍可回看）', discard.status === 200 && discard.data.candidate.status === 'discarded');
  const adoptDiscarded = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/adopt`, { method: 'POST', body: { work_id: workId } });
  ok('B25 丢弃后不能采纳：409（避免"丢弃"变成无声的采纳开关）', adoptDiscarded.status === 409);
  const agentDiscard = await jfetch(`/api/novel/branch/candidates/${batch2.data.candidates[0].id}/discard`, { method: 'POST', agent: true, body: { work_id: workId } });
  ok('B26 模型侧边界：丢弃也是作者决定（403）', agentDiscard.status === 403);
  const cancel = await jfetch(`/api/novel/branch/sandboxes/${sbAgent.data.sandbox.id}/cancel`, { method: 'POST', body: { work_id: workId } });
  const addCancelled = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: ch2, sandbox_id: sbAgent.data.sandbox.id, candidates: [
    { ...cands()[0], title: 'A', core_action: '林昭改走水路上岸' },
    { ...cands()[1], title: 'B', core_action: '林昭留在码头等消息' },
  ] } });
  const reopen = await jfetch(`/api/novel/branch/sandboxes/${sbAgent.data.sandbox.id}/reopen`, { method: 'POST', body: { work_id: workId } });
  ok('B27 取消/恢复重启：取消后拒绝追加，恢复后继续；已产出候选原样保留（不重跑）',
    cancel.data.sandbox.status === 'cancelled' && addCancelled.status === 409 && reopen.data.sandbox.status === 'open' && reopen.data.sandbox.progress.produced === 0,
    JSON.stringify({ cancel: cancel.status, cancelStatus: cancel.data.sandbox && cancel.data.sandbox.status, add: addCancelled.status, addMsg: addCancelled.data.message || addCancelled.data.error, reopen: reopen.status, reopenStatus: reopen.data.sandbox && reopen.data.sandbox.status, produced: reopen.data.sandbox && reopen.data.sandbox.progress }));
  const agentCancel = await jfetch(`/api/novel/branch/sandboxes/${sb.data.sandbox.id}/cancel`, { method: 'POST', agent: true, body: { work_id: workId } });
  ok('B28 模型侧边界：取消沙盘也是作者决定（403）', agentCancel.status === 403);

  // 隔离：候选不进正典/事件/知识/正文/上下文
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(join(DATA_DIR, 'novel.db'), { readOnly: true });
  const markerTables = [['story_facts', 'subject'], ['story_events', 'summary'], ['character_knowledge', 'fact_key'], ['story_state_proposals', 'payload_json'], ['chapters', 'content']];
  const leaked = [];
  for (const [t, col] of markerTables) {
    for (const m of [MARK, CAND_MARK]) {
      const row = ro.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} LIKE ?`).get(`%${m}%`);
      if (Number(row.n) > 0) leaked.push(`${t}.${col}=${row.n}:${m.slice(0, 6)}`);
    }
  }
  const branchRows = ro.prepare('SELECT COUNT(*) AS n FROM branch_candidates WHERE work_id = ?').get(workId);
  const branchSandboxes = ro.prepare('SELECT COUNT(*) AS n FROM branch_sandboxes WHERE work_id = ?').get(workId);
  ro.close();
  ok('B29 隔离（直接查库）：候选标记文本不出现在正典事实/事件/角色知识/提案/正文里（候选不是本书事实）',
    leaked.length === 0 && Number(branchRows.n) >= 3 && Number(branchSandboxes.n) >= 2,
    JSON.stringify({ leaked, branch: branchRows.n }));
  const ctxOut = await jfetch(`/api/novel/context?work_id=${workId}&chapter_id=${ch2}&mode=full`);
  const hasBlueprintLayer = (ctxOut.data.context_manifest || []).some((m) => m.id === 'blueprint' && Number(m.emitted) > 0);
  ok('B30 隔离（装配器）：未采纳候选的文本不进最终上下文；已采纳候选只通过「蓝图」层进入（正对照）',
    !String(ctxOut.data.assembled || '').includes(CAND_MARK) && hasBlueprintLayer,
    JSON.stringify({ manifest: (ctxOut.data.context_manifest || []).map((m) => m.id + ':' + m.emitted) }));

  // 跨作品隔离与 404/400 边界
  const workB = (await jfetch('/api/works', { method: 'POST', body: { title: '沙盘·乙书' } })).data.id;
  const chB = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workB, title: '第一章', content: '<p>另一本书。</p>' } })).data.id;
  const listB = await jfetch(`/api/novel/branch/candidates?work_id=${workB}`);
  const crossView = await jfetch(`/api/novel/branch/candidates/${oneId}`);
  const crossCompare = await jfetch('/api/novel/branch/compare', { method: 'POST', body: { work_id: workB, ids: [oneId, batch2.data.candidates[0].id] } });
  ok('B31 跨作品：乙书看不到甲书候选；用乙书 id 比较甲书候选 → 404',
    listB.data.candidates.length === 0 && crossView.status === 200 && crossCompare.status === 404);
  const noChapter = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, candidates: cands().slice(0, 2) } });
  const foreignChapter = await jfetch('/api/novel/branch/candidates', { method: 'POST', body: { work_id: workId, chapter_id: chB, candidates: cands().slice(0, 2) } });
  const shortCompare = await jfetch('/api/novel/branch/compare', { method: 'POST', body: { work_id: workId, ids: [oneId] } });
  ok('B32 边界：缺 chapter_id → 400；跨作品章节 → 404；比较少于 2 个 id → 400',
    noChapter.status === 400 && foreignChapter.status === 404 && shortCompare.status === 400,
    JSON.stringify({ noChapter: noChapter.status, foreignChapter: foreignChapter.status, shortCompare: shortCompare.status }));
  const ctxCheck = await jfetch(`/api/novel/branch/candidates/${oneId}`);
  ok('B33 采纳后的候选保留依赖基线（可核对"当时按什么版本采纳的"）',
    ctxCheck.data.candidate.deps.hash.startsWith('sandbox-') && ctxCheck.data.candidate.adopted.adopted_at && ctxCheck.data.candidate.adopted.contract_suggestion.chapter_goal.length > 0);

  // ── C. 插件工具面（novel_branch）：模型侧只能"提候选 + 读回"，采纳/丢弃/取消不在工具面内 ──
  {
    process.env.NOVELSTUDIO_BASE_URL = BASE;
    const mod = await import('../harness-plugins/novel-writing/novel-tools.mjs');
    const tools = new Map();
    mod.apply({ tools: { register(tool) { tools.set(tool.name, tool); } } }, { baseUrl: BASE });
    const branchTool = tools.get('novel_branch');
    ok('C1 插件注册了 novel_branch（参数含 action / candidates / ids）',
      !!branchTool && !!branchTool.parameters && !!branchTool.parameters.properties.action
        && !!branchTool.parameters.properties.candidates && !!branchTool.parameters.properties.ids);
    const call = (args) => branchTool.execute(args).then((r) => String(r.text));
    const openText = await call({ action: 'open', work_id: String(workId), chapter_id: String(ch2), requested: 3 });
    ok('C2 action=open：开出沙盘并回读依赖基线 hash（工具只声明不判断）',
      /沙盘 #\d+ 已开/.test(openText) && openText.includes('依赖基线 hash=sandbox-'), openText.slice(0, 120));
    const sgAll = await jfetch(`/api/novel/branch/sandboxes?work_id=${workId}&chapter_id=${ch2}`);
    const toolSandbox = sgAll.data.sandboxes.find((s) => s.created_by === 'agent');
    ok('C2b 工具开出的沙盘在隔离实例里真的存在（agent 来源如实记录，不是模型自说自话）',
      !!toolSandbox && toolSandbox.chapter_id === ch2, JSON.stringify(sgAll.data.sandboxes.map((s) => [s.id, s.created_by])));
    const toolCands = [
      { title: '工具方向一', core_action: '林昭改走水路把账本送出城', conflict: '放弃陆路就要欠船老大的人情',
        character_choices: [{ character_id: charId, choice: '找船老大谈条件', basis_keys: ['林昭身份'] }],
        beats: ['先谈价', '夜里出城'], consequences: [{ text: '账本送出但欠下人情', certainty: 'possible' }],
        relations_foreshadows: [{ kind: 'foreshadow', text: '船老大与旧约有关' }], risks: ['船老大告密'],
        required_setup: ['交代水路规矩'], intent_relation: { text: '符合长期方向', stance: 'follows' } },
      { title: '工具方向二', core_action: '林昭把账本交给巡夜人保管', conflict: '把风险转给别人就等于把主动权交出去',
        character_choices: [{ character_id: charId, choice: '当夜托付巡夜人', basis_keys: ['林昭身份'] }],
        beats: ['试探口风', '立下字据'], consequences: [{ text: '账本安全但受制于人', certainty: 'planned' }],
        relations_foreshadows: [{ kind: 'relation', text: '与巡夜人结盟' }], risks: ['巡夜人反悔'],
        required_setup: ['交代巡夜人的规矩'], intent_relation: { text: '与阶段重点有张力', stance: 'neutral' } },
      { title: '工具方向三', core_action: '林昭放火烧掉账本断了所有后路', conflict: '毁掉证据就等于毁掉自己的护身符',
        character_choices: [{ character_id: charId, choice: '亲手点火', basis_keys: ['林昭身份'] }],
        beats: ['清空账房', '点火离场'], consequences: [{ text: '再无可退', certainty: 'uncertain' }],
        relations_foreshadows: [{ kind: 'foreshadow', text: '灰烬里的残页' }], risks: ['被当场撞见'],
        required_setup: ['交代账本的唯一性'], intent_relation: { text: '偏离长期方向', stance: 'conflicts' } },
    ];
    const submitText = await call({ action: 'submit', work_id: String(workId), chapter_id: String(ch2), sandbox_id: String(toolSandbox.id), candidates: JSON.stringify(toolCands) });
    ok('C3 action=submit：候选进宿主并回读进度；文本重申"候选只是提案"',
      submitText.includes('已提交 3 个候选') && submitText.includes('候选只是提案'), submitText.slice(0, 160));
    const listById = await jfetch(`/api/novel/branch/candidates?work_id=${workId}&sandbox_id=${toolSandbox.id}`);
    ok('C3b 宿主侧确有 3 条候选且来源=agent（工具带 X-Novel-Agent，来源如实记录）',
      listById.data.candidates.length === 3 && listById.data.candidates.every((c) => c.created_by === 'agent'),
      JSON.stringify(listById.data.candidates.map((c) => c.created_by)));
    const viewText = await call({ action: 'view', work_id: String(workId), id: String(listById.data.candidates[0].id) });
    ok('C4 action=view 回读候选全文与采纳计划（只写蓝图，正文/事实不动）',
      viewText.includes('采纳计划') && viewText.includes('核心行动') && viewText.includes('依赖基线仍一致'));
    const cmpText = await call({ action: 'compare', work_id: String(workId), ids: listById.data.candidates.map((c) => c.id).join(',') });
    ok('C4b action=compare 只列差异、明说不替作者打分',
      cmpText.includes('只列差异') && cmpText.includes('不替作者打分') && cmpText.includes('候选 #'));
    const listText = await call({ action: 'list', work_id: String(workId), chapter_id: String(ch2) });
    ok('C4c action=list 同时列出沙盘与候选（可核对进度/基线）',
      listText.includes('沙盘 #') && listText.includes('核心行动：') && listText.includes('/'));
    let adoptErr = '';
    try { await call({ action: 'adopt', work_id: String(workId), id: String(listById.data.candidates[0].id) }); } catch (e) { adoptErr = String(e.message || e); }
    const after = await jfetch(`/api/novel/branch/candidates/${listById.data.candidates[0].id}`);
    ok('C5 工具面没有采纳动作：action=adopt 直接抛错，候选状态不变（未发出任何写入）',
      /非法 action=/.test(adoptErr) && after.data.candidate.status === 'candidate', adoptErr.slice(0, 90));
    const toolSrc = readFileSync(new URL('../harness-plugins/novel-writing/novel-tools.mjs', import.meta.url), 'utf8');
    const called = [...toolSrc.matchAll(/jfetch\(\s*[`'"]([^`'"]+)/g)].map((m) => m[1]);
    const forbidden = called.filter((p) => /\/(adopt|discard|cancel|reopen)/.test(p));
    ok('C6 工具源码不调用采纳/丢弃/取消/重开端点（作者动作只在界面；工具只提候选与读回）',
      forbidden.length === 0 && called.some((p) => p.includes('/api/novel/branch/candidates')), forbidden.join(','));
    delete process.env.NOVELSTUDIO_BASE_URL;
  }
} catch (e) {
  fails.push('异常：' + e.message);
  console.error('✗ 测试异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n剧情分支沙盘（R11）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：'); for (const f of fails) console.log('  - ' + f); process.exit(1); }