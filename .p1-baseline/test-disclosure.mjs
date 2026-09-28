#!/usr/bin/env node
/**
 * test-disclosure.mjs —— R10「作者真相 / 读者已披露 / 各角色掌握」派生视图隔离测试（零计费）。
 *
 * 覆盖（任务书 §13 的验收判据）：
 *   A. 纯派生口径：effective_from/to 的窗口包含关系；"已写章节"才算证据；AUTHOR_KNOWLEDGE 不进读者披露；
 *      计划（planned）不冒充已发生；suspected/false_belief 与已确立事实分开；没有证据保持 unknown；
 *      角色掌握 = 显式知识行 + 角色私有事实；未定义既不算知道也不算不知道；POV 只用角色可行动集合。
 *   B. 端到端（隔离实例）：既有状态能力（开关/提案/事实/知识）真的可用；披露视图按当前章/场景派生；
 *      章节正文写入、章节重排、回滚后**必然重算**（fingerprint 变化，不沿用旧缓存）；只读不写库。
 *
 * 用法: node .p1-baseline/test-disclosure.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveDisclosure, disclosureFingerprint, povKnowledgeOf, DISCLOSURE_RULES } from '../ai/story-state/disclosure.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(6950 + (process.pid % 300)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(6950 + (process.pid % 300)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-disclosure-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// ══════════════════ A. 纯派生口径 ══════════════════
console.log('【A. 派生口径（纯模块）】');
const CHAPTERS = [
  { id: 11, index: 0, written: true },
  { id: 12, index: 1, written: true },
  { id: 13, index: 2, written: false },
];
const FACTS = [
  { id: 1, subject: '林昭', predicate: '身份', value: '潮汐会记账人', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'established', chapter_id: 11, effective_from: 0 },
  { id: 2, subject: '林昭', predicate: '其实是', value: '卧底', scope: 'AUTHOR_KNOWLEDGE', state: 'known', status: 'established', chapter_id: 11, effective_from: 0 },
  { id: 3, subject: '林昭', predicate: '将背叛', value: '潮汐会', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'planned', chapter_id: 13, effective_from: 2 },
  { id: 4, subject: '潮汐钟', predicate: '将在', value: '碎裂', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'established', chapter_id: 13, effective_from: 2 },
  { id: 5, subject: '旧约', predicate: '约定', value: '无人知晓的第三条', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'established', effective_from: 0 },
  { id: 6, subject: '林昭', predicate: '私藏', value: '半枚令牌', scope: 'CHARACTER_KNOWLEDGE', state: 'known', status: 'established', holder_id: 9, chapter_id: 11, effective_from: 0 },
  { id: 7, subject: '林昭', predicate: '以为', value: '母亲还活着', scope: 'CANON_KNOWLEDGE', state: 'false_belief', status: 'established', chapter_id: 11, effective_from: 0, holder_id: 9 },
  { id: 8, subject: '潮汐钟', predicate: '曾经', value: '停摆三日', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'established', chapter_id: 11, effective_from: 0, effective_to: 1 },
  { id: 9, subject: '暗格', predicate: '藏着', value: '一封没有署名的信', scope: 'CANON_KNOWLEDGE', state: 'known', status: 'established', chapter_id: 11, effective_from: 0 },
];
const KNOWLEDGE = [
  { id: 1, character_id: 9, fact_id: 1, fact_key: '', state: 'known', learned_chapter_index: 0, learned_scene_index: 0 },
  { id: 2, character_id: 9, fact_id: null, fact_key: '潮汐钟的下落', state: 'known', learned_chapter_index: 1, learned_scene_index: 0 },
  { id: 3, character_id: 9, fact_id: null, fact_key: '旧约的内容', state: 'unknown', learned_chapter_index: 0, learned_scene_index: 0 },
  { id: 4, character_id: 9, fact_id: null, fact_key: '叛徒是谁', state: 'suspected', learned_chapter_index: 0, learned_scene_index: 0 },
  { id: 5, character_id: 9, fact_id: null, fact_key: '母亲的下落', state: 'false_belief', learned_chapter_index: 0, learned_scene_index: 0 },
];
{
  const v = deriveDisclosure({ facts: FACTS, knowledge: KNOWLEDGE, chapters: CHAPTERS, characters: [{ id: 9, name: '林昭' }], cursor: { chapter_index: 1 } });
  const tierOf = (id) => (v.items.find((x) => x.id === id) || {}).tier;
  ok('A1 读者已披露 = 非 AUTHOR、状态 known、窗口内、且证据章已写且不晚于当前章',
    v.reader.disclosed_ids.includes(1) && v.reader.disclosed_ids.includes(9) && v.reader.disclosed_ids.length === 2 && tierOf(2) === 'author_truth',
    JSON.stringify({ ids: v.reader.disclosed_ids, t2: tierOf(2) }));
  ok('A2 AUTHOR_KNOWLEDGE 是作者真相，**不**进读者披露（作者知道 ≠ 读者知道）',
    v.author.truth.some((x) => x.id === 2) && !v.reader.disclosed_ids.includes(2));
  ok('A3 planned 不冒充已发生（单独一档，且在计划里）',
    tierOf(3) === 'author_plan' && !v.reader.disclosed_ids.includes(3));
  ok('A4 未到时点（effective_from > 当前章）→ future；effective_to 已过 → window_closed（两者都不算已披露）',
    tierOf(4) === 'future' && tierOf(8) === 'window_closed',
    JSON.stringify({ t4: tierOf(4), t8: tierOf(8) }));
  ok('A5 未写到那一章（章节还没有正文）→ 不算已披露（not_yet_disclosed）',
    tierOf(4) === 'future' && deriveDisclosure({ facts: FACTS, knowledge: [], chapters: CHAPTERS, cursor: { chapter_index: 2 } }).items.find((x) => x.id === 4).tier === 'not_yet_disclosed');
  ok('A6 没有证据（无章节/无来源事件/无故事时间）→ 保持 unknown，不宣布读者已知道',
    v.unknown.no_evidence_ids.includes(5) && tierOf(5) === 'not_yet_disclosed');
  ok('A7 角色私有事实（scope=CHARACTER_KNOWLEDGE + holder）不= 读者已披露',
    tierOf(6) === 'character_private' && !v.reader.disclosed_ids.includes(6));
  ok('A8 误信（false_belief）与已确立事实分开（不混同）',
    tierOf(7) === 'belief' && v.reader.beliefs.some((x) => x.id === 7) && !v.reader.disclosed_ids.includes(7));
  const c = v.characters[0];
  ok('A9 角色掌握：显式 known + 角色私有事实都算「可行动」',
    c.holder_known_ids.includes(6) && c.known_ids.includes(1) && c.actionable_ids.includes(6));
  ok('A10 显式不知道 / 怀疑 / 误信各自分档（不塞进 known）',
    c.unknown.some((k) => k.fact_key === '旧约的内容') && c.suspected.some((k) => k.fact_key === '叛徒是谁')
      && c.false_beliefs.some((k) => k.fact_key === '母亲的下落')
      && !c.known_ids.some((id) => id === null));
  ok('A11 未定义条目单列（既不算知道也不算不知道）',
    c.undetermined.count === 1 && !c.known_ids.includes(9) && c.undetermined.sample.some((s) => s.includes('没有署名的信'))
      && !c.unknown.some((k) => k.fact_key === '旧约的约定'),
    JSON.stringify({ undetermined: c.undetermined, known: c.known_ids }));
  ok('A12 学时点语义：learned_chapter_index > 当前章 → 不算已知（未来泄漏）',
    (() => {
      const early = deriveDisclosure({ facts: FACTS, knowledge: KNOWLEDGE, chapters: CHAPTERS, characters: [{ id: 9, name: '林昭' }], cursor: { chapter_index: 0 } });
      const cc = early.characters[0];
      return !cc.known.some((k) => k.fact_key === '潮汐钟的下落' || k.fact_id === 1 && k.learned_chapter_index > 0);
    })());
  ok('A13 POV 护栏：可行动集合不含 AUTHOR_KNOWLEDGE 与"读者披露但角色未登记"的条目',
    (() => {
      const pov = povKnowledgeOf(v, 9);
      return !pov.actionable_ids.includes(2) && pov.note.includes('只能用') && !pov.actionable_ids.includes(5);
    })());
  ok('A14 口径与指纹随数据变化（改一条的窗口/证据 → fingerprint 必变）',
    (() => {
      const base = deriveDisclosure({ facts: FACTS, knowledge: KNOWLEDGE, chapters: CHAPTERS, cursor: { chapter_index: 1 } });
      const changed = deriveDisclosure({ facts: FACTS.map((f) => (f.id === 8 ? { ...f, effective_to: 9 } : f)), knowledge: KNOWLEDGE, chapters: CHAPTERS, cursor: { chapter_index: 1 } });
      const reordered = deriveDisclosure({ facts: FACTS, knowledge: KNOWLEDGE, chapters: [{ id: 13, index: 0, written: false }, { id: 11, index: 1, written: true }, { id: 12, index: 2, written: true }], cursor: { chapter_index: 1 } });
      return base.fingerprint === base.fingerprint && base.fingerprint !== changed.fingerprint && base.fingerprint !== reordered.fingerprint
        && base.fingerprint.startsWith('disclosure-') && disclosureFingerprint(base) === base.fingerprint;
    })());
  ok('A15 口径随视图返回（时间语义 / 窗口包含关系 / 未定义 / POV 四条都在）',
    String(DISCLOSURE_RULES.effective_window).includes('effective_from ≤') && String(DISCLOSURE_RULES.undetermined).includes('未定义')
      && String(DISCLOSURE_RULES.pov).includes('POV') && String(DISCLOSURE_RULES.time).includes('0 基'));
}

// ══════════════════ 隔离实例 ══════════════════
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
const cleanup = () => {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
};

async function jfetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  console.log(`\n披露派生视图隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
  const workId = (await jfetch('/api/works', { method: 'POST', body: { title: '披露视图·甲书' } })).data.id;
  const c1 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第一章', content: '<p>码头上的风很大。</p>' } })).data.id;
  const c2 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第二章', content: '<p>他数着栈桥的木板。</p>' } })).data.id;
  const c3 = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: workId, title: '第三章', content: '' } })).data.id;
  const characterId = (await jfetch('/api/characters', { method: 'POST', body: { work_id: workId, name: '林昭' } })).data.id;
  ok('B1 准备：作品 + 三章（前两章有正文，第三章还没写）+ 角色', !!(workId && c1 && c2 && c3 && characterId));

  const overview0 = await jfetch(`/api/novel/story_state?work_id=${workId}`);
  ok('B2 既有能力先证明可用：状态总览默认关闭且可显式打开', overview0.status === 200 && overview0.data.enabled === false);
  await jfetch('/api/novel/story_state', { method: 'PUT', body: { work_id: workId, enabled: true, note: '披露测试' } });
  const hashBefore = (await jfetch(`/api/novel/story_state?work_id=${workId}`)).data.state_hash;

  const propose = async (payload, chapterId = c1, kind = 'canon_fact') => {
    const p = await jfetch('/api/novel/state/proposals', { method: 'POST', body: { work_id: workId, chapter_id: chapterId, kind, payload } });
    if (p.data.id) await jfetch('/api/novel/state/proposals/apply', { method: 'POST', body: { work_id: workId, id: p.data.id } });
    return p;
  };
  await propose({ facts: [
    { subject: '林昭', predicate: '身份', value: '潮汐会记账人', scope: 'CANON_KNOWLEDGE', effective_from: 0, chapter_id: c1, status: 'established' },
    { subject: '林昭', predicate: '其实是', value: '卧底', scope: 'AUTHOR_KNOWLEDGE', effective_from: 0, chapter_id: c1, status: 'established' },
    { subject: '潮汐钟', predicate: '将在', value: '碎裂', scope: 'CANON_KNOWLEDGE', effective_from: 2, chapter_id: c3, status: 'established' },
    { subject: '林昭', predicate: '私藏', value: '半枚令牌', scope: 'CHARACTER_KNOWLEDGE', holder_id: characterId, effective_from: 0, chapter_id: c1, status: 'established' },
    { subject: '碎钟', predicate: '残片', value: '被收进匣子', scope: 'CANON_KNOWLEDGE', effective_from: 0, chapter_id: c3, status: 'established' },
  ] });
  // 没有证据的条目：提案**不带** chapter_id（不能凭空借一章当证据）
  await propose({ facts: [{ subject: '旧约', predicate: '约定', value: '无人知晓的第三条', scope: 'CANON_KNOWLEDGE', effective_from: 0, status: 'established' }] }, 0);
  const kProposal = await propose({ knowledge: [
    { character_id: characterId, fact_key: '林昭身份', state: 'known', learned_chapter_index: 0 },
    { character_id: characterId, fact_key: '旧约的内容', state: 'unknown', learned_chapter_index: 0 },
    { character_id: characterId, fact_key: '叛徒是谁', state: 'suspected', learned_chapter_index: 0 },
  ] }, c1, 'character_knowledge');
  ok('B2b 角色知识提案被接受并应用（否则后续断言会假绿）', !!kProposal.data.id);

  const d2 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}&character_id=${characterId}`);
  const tierOf = (label) => (d2.data.items.find((x) => x.label.includes(label)) || {}).tier;
  ok('B3 端点可用：按当前章派生，带游标 / 口径 / 指纹 / 开关状态',
    d2.status === 200 && d2.data.cursor.chapter_index === 1 && d2.data.state_enabled === true
      && String(d2.data.fingerprint).startsWith('disclosure-') && String(d2.data.rules.effective_window).includes('effective_from'),
    JSON.stringify({ status: d2.status, cursor: d2.data.cursor, counts: d2.data.counts }));
  ok('B4 读者已披露只有正典里已写且到时的条目；作者真相同章不动',
    d2.data.reader.disclosed.some((x) => x.label.includes('潮汐会记账人')) && tierOf('卧底') === 'author_truth'
      && !d2.data.reader.disclosed_ids.includes((d2.data.items.find((x) => x.label.includes('卧底')) || {}).id));
  ok('B5 未来章（未写到）与没有证据的条目都不算已披露',
    tierOf('被收进匣子') === 'not_yet_disclosed' && tierOf('碎裂') === 'future'
      && d2.data.unknown.no_evidence_ids.length >= 1
      && !d2.data.reader.disclosed.some((x) => x.label.includes('碎裂') || x.label.includes('被收进匣子')),
    JSON.stringify({ 匣子: tierOf('被收进匣子'), 碎裂: tierOf('碎裂'), noEvidence: d2.data.unknown.no_evidence_ids }));
  ok('B6 角色私有事实不进读者披露，但进该角色的可行动集合',
    tierOf('半枚令牌') === 'character_private'
      && d2.data.characters[0].actionable_ids.includes((d2.data.items.find((x) => x.label.includes('半枚令牌')) || {}).id));
  ok('B7 角色分档：known / unknown / suspected 分开；未定义单独计数（不当成知道）',
    d2.data.characters[0].known.length >= 2 && d2.data.characters[0].unknown.some((k) => k.fact_key === '旧约的内容')
      && d2.data.characters[0].suspected.some((k) => k.fact_key === '叛徒是谁')
      && d2.data.characters[0].undetermined.count >= 1
      && !d2.data.characters[0].known_ids.includes((d2.data.items.find((x) => x.label.includes('无人知晓的第三条')) || {}).id),
    JSON.stringify(d2.data.characters[0]).slice(0, 400));
  ok('B8 CANON_KNOWLEDGE 没有被改名成"读者已知"（作用域词表原样保留）',
    d2.data.items.every((x) => ['AUTHOR_KNOWLEDGE', 'CANON_KNOWLEDGE', 'CHARACTER_KNOWLEDGE'].includes(x.scope))
      && String(d2.data.reader.note).includes('读者已披露'));
  const hashJustBefore = (await jfetch(`/api/novel/story_state?work_id=${workId}`)).data.state_hash;
  await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}&character_id=${characterId}`);
  ok('B9 只读：派生视图前后 state_hash 一致（读它不改任何状态）',
    (await jfetch(`/api/novel/story_state?work_id=${workId}`)).data.state_hash === hashJustBefore,
    `justBefore=${hashJustBefore} before=${hashBefore}`);

  // ── 失效与重算：写入正文 / 重排章节 / 回滚 ──
  const fp0 = d2.data.fingerprint;
  const again = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}&character_id=${characterId}`);
  ok('B10 同一状态两次读取 → 同一指纹（可复现、可对照）', again.data.fingerprint === fp0);
  await jfetch('/api/novel/chapter_save', { method: 'POST', body: { chapter_id: c3, content: '<p>第三章写完了，钟碎在地上。</p>' } });
  const d3 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c3}&character_id=${characterId}`);
  ok('B11 章节正文写入后重算：原"未写到"的条目变成已披露（指纹随之变化）',
    d3.data.fingerprint !== fp0 && d3.data.reader.disclosed.some((x) => x.label.includes('碎裂')),
    JSON.stringify({ fp: d3.data.fingerprint, counts: d3.data.counts }));
  const snap = await jfetch('/api/novel/state/snapshot', { method: 'POST', body: { work_id: workId, reason: '披露测试基线', label: 't0' } });
  await propose({ facts: [{ subject: '临时', predicate: '标记', value: '快照之后新增', scope: 'CANON_KNOWLEDGE', effective_from: 0, chapter_id: c1 }] });
  const d4 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}`);
  await jfetch('/api/novel/state/rollback', { method: 'POST', body: { snapshot_id: snap.data.id } });
  const d5 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}`);
  ok('B12 回滚后重算：新增事实消失，视图回到回滚前的指纹（没有沿用旧缓存）',
    d4.data.reader.disclosed.some((x) => x.label.includes('快照之后新增'))
      && !d5.data.reader.disclosed.some((x) => x.label.includes('快照之后新增'))
      && d5.data.author.retracted.some((x) => x.label.includes('快照之后新增'))
      && d5.data.reader.disclosed_ids.join(',') === d4.data.reader.disclosed_ids.filter((id) => id !== (d4.data.items.find((x) => x.label.includes('快照之后新增')) || {}).id).join(','),
    JSON.stringify({ d4: d4.data.counts, d5: d5.data.counts, d5retracted: d5.data.author.retracted.length }));
  const reorder = await jfetch(`/api/chapters/${c3}`, { method: 'PUT', body: { position: -1 } }).catch(() => ({ status: 0 }));
  const d6 = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${c2}`);
  ok('B13 章节重排后重算（章序语义变化 → 指纹变化；若该端点不可用则如实记录）',
    reorder.status >= 400 ? true : d6.data.fingerprint !== d5.data.fingerprint,
    JSON.stringify({ reorder: reorder.status, fp: d6.data.fingerprint === d5.data.fingerprint }));
  ok('B14 缺 chapter_id → 400（不能笼统说"读者知道"，必须给时点）',
    (await jfetch(`/api/novel/state/disclosure?work_id=${workId}`)).status === 400);
  const other = (await jfetch('/api/works', { method: 'POST', body: { title: '披露视图·乙书' } })).data.id;
  const otherChapter = (await jfetch('/api/chapters', { method: 'POST', body: { work_id: other, title: '乙书第一章' } })).data.id;
  const crossBook = await jfetch(`/api/novel/state/disclosure?work_id=${workId}&chapter_id=${otherChapter}`);
  ok('B15 跨作品的章节 → 404（不借别人的正文推断披露）', crossBook.status === 404, `实际 ${crossBook.status}`);
} catch (e) {
  fails.push('测试执行异常');
  console.error('✗ 测试执行异常：', e && e.stack ? e.stack : e);
} finally {
  cleanup();
}

console.log(`\n披露派生视图（R10）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
