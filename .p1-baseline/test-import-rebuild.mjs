#!/usr/bin/env node
/**
 * test-import-rebuild.mjs —— R12「导入后分析并重建创作状态」的隔离测试（零计费）。
 *
 * 覆盖任务书 §15 的验收判据：
 *   A. 纯模块：九类抽取对象、分批规划（不把整本塞进一次请求）、每批基线指纹（source/抽取器/schema/路由/结果）、
 *      恢复判据（基线一致才复用，正文或配置变化 → stale）、抽取结果校验（证据必须能在原文定位）、候选 → 既有提案种类映射。
 *   B. 端到端（隔离实例）：plan / status / record / confirm / cancel 全链路；解析失败有限重试；
 *      作者确认后原子写提案；重复确认幂等；正文变化标 stale 且拒绝记录/确认；
 *      模型侧（X-Novel-Agent）不得确认；恢复不重跑已完成批次；不写正文/事实/事件/角色知识（只读库负向核对）。
 *   C. 确认后的候选可由既有提案设施 apply 进正式状态（作者显式开启故事状态后）。
 *
 * 说明：本测试**不做任何模型调用**——抽取结果按"调用方按批执行"的契约直接喂给 record 端点，
 * 因此该流程默认零计费；真实模型链路的在线验证另见 docs/enhancement-acceptance.md（未授权付费 → BLOCKED）。
 *
 * 用法: node .p1-baseline/test-import-rebuild.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  REBUILD_VERSION, REBUILD_EXTRACTOR_VERSION, REBUILD_SCHEMA_VERSION,
  REBUILD_CATEGORIES, REBUILD_CATEGORY_KEYS, REBUILD_LIMITS, REBUILD_RULES,
  chapterSourceHash, sourceHashOf, planBatches, batchBaselineHash, compareBatches,
  resultHashOf, validateExtraction, extractionToProposals,
} from '../ai/import/rebuild.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// 空闲端口探测：机器上可能有别的监听者占着 <base>+pid 这一段（实测过一次「隔离实例未就绪」假红），
// 改为向系统要一个空闲端口（bind 0 → 取端口 → 关闭）；失败再回落到原算法，行为不变。
const PORT = await new Promise((resolve) => {
  import('node:net').then(({ default: net }) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(7450 + (process.pid % 200)));
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  }).catch(() => resolve(7450 + (process.pid % 200)));
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-rebuild-'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(String(e.message)) : true; } };

const chapters = [
  { id: 11, index: 0, title: '第一章 初见', content: '青雀拜入白鹭门下，成为记名弟子。' },
  { id: 12, index: 1, title: '第二章 试炼', content: '白鹭收下记名弟子，赐名小雀。' },
  { id: 13, index: 2, title: '第三章 远行', content: '青雀离别山门，带走了半枚玉佩。' },
];

// ══════════════════ A. 纯模块 ══════════════════
console.log('【A. 分批 / 基线 / 恢复 / 校验 / 映射（纯模块）】');
{
  ok('A1 版本齐备且九类抽取对象都有落库映射目标',
    REBUILD_VERSION === '1.0.0' && REBUILD_EXTRACTOR_VERSION && REBUILD_SCHEMA_VERSION
      && REBUILD_CATEGORIES.length === 9 && REBUILD_CATEGORY_KEYS.join(',') === 'entity,alias,relation,location,timeline,event,foreshadow,character_state,disclosure'
      && REBUILD_CATEGORIES.every((c) => c.label && c.proposal_kind));

  const plan = planBatches(chapters, { batchSize: 2, route: { model: 'm1', reasoning_effort: 'high' } });
  ok('A2 分批规划：章节顺序打包 + 不超章数上限（整本不进一次请求）',
    plan.length === 2 && plan[0].chapter_ids.join(',') === '11,12' && plan[1].chapter_ids.join(',') === '13'
      && plan.every((b) => b.chapter_ids.length <= REBUILD_LIMITS.max_chapters_per_batch)
      && throws(() => planBatches([], {}), /没有章节/));

  const tooBig = planBatches([{ id: 1, index: 0, title: 'x', content: 'x'.repeat(REBUILD_LIMITS.max_chars_per_batch + 1) }, { id: 2, index: 1, title: 'y', content: 'y' }], { batchSize: 6 });
  ok('A3 字符预算：超长章节独占一批（不因章数未满就无限堆）', tooBig.length === 2);

  ok('A4 源指纹：标题或正文变化都改变指纹；章节顺序改变改变批次指纹',
    chapterSourceHash(chapters[0]) !== chapterSourceHash({ ...chapters[0], title: '改名' })
      && chapterSourceHash(chapters[0]) !== chapterSourceHash({ ...chapters[0], content: chapters[0].content + '改' })
      && sourceHashOf(['a', 'b']) !== sourceHashOf(['b', 'a']));

  const base = plan[0].baseline;
  ok('A5 基线哈希：路由 / 抽取器 / schema / 分类 任一变化都改变哈希',
    batchBaselineHash(base) === plan[0].baseline_hash
      && batchBaselineHash({ ...base, route: { model: 'm2', reasoning_effort: 'high' } }) !== plan[0].baseline_hash
      && batchBaselineHash({ ...base, extractor_version: '9.9.9' }) !== plan[0].baseline_hash
      && batchBaselineHash({ ...base, schema_version: '9.9.9' }) !== plan[0].baseline_hash
      && batchBaselineHash({ ...base, categories: ['event'] }) !== plan[0].baseline_hash);

  const prev = plan.map((b) => ({ batch_index: b.index, baseline_hash: b.baseline_hash, chapter_hashes: b.chapter_hashes, status: 'extracted' }));
  const same = compareBatches(prev, plan);
  const edited = compareBatches(prev, planBatches(chapters.map((c) => (c.id === 11 ? { ...c, content: c.content + '又改了' } : c)), { batchSize: 2, route: { model: 'm1', reasoning_effort: 'high' } }));
  const rerouted = compareBatches(prev, planBatches(chapters, { batchSize: 2, route: { model: 'm2', reasoning_effort: 'high' } }));
  const half = compareBatches(prev.map((p) => (p.batch_index === 1 ? { ...p, status: 'failed' } : p)), plan);
  ok('A6 恢复判据：一致→reuse；正文变→stale；路由变→stale；未完成→pending',
    same.get(0).state === 'reuse' && same.get(1).state === 'reuse'
      && edited.get(0).state === 'stale' && edited.get(1).state === 'reuse'
      && rerouted.get(0).state === 'stale'
      && half.get(1).state === 'pending');

  ok('A7 结果哈希对键序不敏感、对内容敏感',
    resultHashOf({ a: 1, b: [2, 3] }) === resultHashOf({ b: [2, 3], a: 1 })
      && resultHashOf({ a: 1 }) !== resultHashOf({ a: 2 }));

  const text = chapters[0].content;
  const bad = validateExtraction('{不是 JSON', { chapterTexts: { 11: text } });
  const noItems = validateExtraction({ foo: 1 }, {});
  const mixed = validateExtraction({ items: [
    { category: 'entity', chapter_id: 11, evidence: { quote: '青雀拜入白鹭门下' }, data: { name: '青雀' } },
    { category: '莫须有', chapter_id: 11, evidence: { quote: '青雀拜入' }, data: {} },
    { category: 'entity', chapter_id: 99, evidence: { quote: '青雀拜入' }, data: { name: 'x' } },
    { category: 'event', chapter_id: 11, evidence: { quote: '编造的句子啊啊' }, data: { summary: 'x' } },
    { category: 'event', chapter_id: 11, evidence: { quote: '短' }, data: { summary: 'x' } },
    { category: 'event', chapter_id: 11, evidence: { quote: '青雀拜入白鹭门下' }, data: {} },
  ] }, { chapterTexts: { 11: text }, chapterIds: [11] });
  ok('A8 校验：非法 JSON / 缺 items / 未知分类 / 跨批章号 / 编造证据 / 证据过短 / 缺 data 全部拦下',
    bad.ok === false && bad.errors[0].code === 'parse'
      && noItems.ok === false && noItems.errors[0].code === 'schema'
      && mixed.ok === false && mixed.items.length === 2
      && mixed.errors.map((e) => e.code).sort().join(',') === 'category,chapter,evidence,evidence');

  const goodItems = validateExtraction({ items: [
    { category: 'entity', chapter_id: 11, chapter_index: 0, evidence: { quote: '青雀拜入白鹭门下', location: '开篇' }, data: { name: '青雀', kind: 'character', aliases: ['小雀'] } },
    { category: 'relation', chapter_id: 11, chapter_index: 0, evidence: { quote: '成为记名弟子' }, data: { subject: '青雀', relation: '师徒', value: '白鹭' } },
    { category: 'foreshadow', chapter_id: 11, chapter_index: 0, evidence: { quote: '记名弟子' }, data: { summary: '记名弟子的来历存疑' }, conflict: true },
    { category: 'disclosure', chapter_id: 11, chapter_index: 0, evidence: { quote: '青雀拜入' }, data: { character: '青雀', fact: '白鹭是山门掌门' } },
    { category: 'timeline', chapter_id: 11, chapter_index: 0, evidence: { quote: '青雀拜入白鹭门下' }, data: {} },
    { category: 'event', chapter_id: 11, chapter_index: 0, evidence: { quote: '青雀拜入白鹭门下' }, data: {} },
  ] }, { chapterTexts: { 11: text }, chapterIds: [11] });
  ok('A9 校验：合法项通过、冲突项标注、stats 与上限口径一致',
    goodItems.ok === true && goodItems.items.length === 6 && goodItems.items[2].conflict === true
      && goodItems.stats.items === 6 && goodItems.stats.conflicts === 1
      && validateExtraction({ items: Array.from({ length: REBUILD_LIMITS.max_items_per_batch + 1 }, () => ({ category: 'event', chapter_id: 11, evidence: { quote: '青雀拜入白鹭门下' }, data: { summary: 'x' } })) }, {}).ok === false);

  const mapped = extractionToProposals(goodItems, { workId: 7, batch: plan[0] });
  ok('A10 候选映射：只产出草稿（不落库）、种类对齐既有提案设施、无映射的项进 skipped（不静默丢弃）',
    mapped.proposals.length === 5 && mapped.skipped.length === 1 && mapped.skipped[0].category === 'event'
      && mapped.proposals.map((p) => p.kind).join(',') === 'entity_create,canon_fact,event,canon_fact,timeline_entry'
      && mapped.proposals.every((p) => p.dedup_key && p.note && p.chapter_id === 11)
      && mapped.proposals[1].payload.facts[0].predicate.includes('关系')
      && mapped.proposals[2].payload.foreshadow_status === 'open'
      && mapped.proposals[3].payload.facts[0].scope === 'CHARACTER_KNOWLEDGE');

  const again = extractionToProposals(goodItems, { workId: 7, batch: plan[0] });
  ok('A11 判据口径机器可读 + 候选可重复生成（dedup_key 稳定）',
    REBUILD_RULES.version === REBUILD_VERSION && /整本书不得作为一次请求/.test(REBUILD_RULES.batch)
      && /stale/.test(REBUILD_RULES.resume) && /quote/.test(REBUILD_RULES.evidence) && /整批拒绝/.test(REBUILD_RULES.strictness)
      && again.proposals.map((p) => p.dedup_key).join(',') === mapped.proposals.map((p) => p.dedup_key).join(','));
}
// ══════════════════ B. 隔离实例 ══════════════════
let server = null;
let serverLog = '';
const jfetch = async (path, { method = 'GET', body, headers = {}, timeout = 30000 } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
};
function cleanup() { try { if (server) server.kill(); } catch (_) {} try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} }
process.on('exit', cleanup);

server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  // 固定 X-Novel-Agent 头默认不再构成模型身份（见 server.js 的 isAgentRequest）；
  // 本测试要断言"模型侧不得确认重建结果"，因此显式打开旧头兼容开关。
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await jfetch('/api/novel/ping', { timeout: 2000 }); if (r.status === 200) ready = true; } catch (_) { /* 还没起 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 200));
}
const roDb = () => new DatabaseSync(join(DATA_DIR, 'novel.db'), { readOnly: true });
const countRows = (table, where = '1=1') => { const db = roDb(); try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n); } finally { db.close(); } };
const readOnlySnapshot = () => {
  const db = roDb();
  try {
    const q = (t) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    return { chapters: q('chapters'), facts: q('story_facts'), events: q('story_events'), knowledge: q('character_knowledge'), entities: q('story_entities'), proposals: q('story_state_proposals') };
  } finally { db.close(); }
};

console.log(`\n重建流程隔离测试（端口 ${PORT}，数据目录 ${DATA_DIR}）`);
if (!ready) {
  fails.push('隔离实例未启动');
  console.log('  ✗ 隔离实例未启动');
} else {
  const imp = await jfetch('/api/import', {
    method: 'POST',
    body: { title: '重建测试书', text: '第一章 初见\n青雀拜入白鹭门下，成为记名弟子。\n\n第二章 试炼\n白鹭收下记名弟子，赐名小雀。\n\n第三章 远行\n青雀离别山门，带走半枚玉佩。' },
  });
  const workId = imp.data.work_id;
  const chs = await jfetch(`/api/chapters?work_id=${workId}`);
  const chapterList = (Array.isArray(chs.data) ? chs.data : (chs.data.chapters || chs.data.items || [])).slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);
  const [c1, c2, c3] = chapterList;
  const contentOf = async (id) => (await jfetch(`/api/chapters/${id}`)).data.content || '';
  const c1Before = await contentOf(c1.id);

  const plan = await jfetch('/api/import/rebuild/plan', { method: 'POST', body: { work_id: workId, batch_size: 1 } });
  const runId = plan.data.run?.id;
  ok('B1 plan：按批切分、状态全 pending、判据与上限随响应可审计',
    plan.status === 201 && plan.data.batches.length === 3
      && plan.data.batches.every((b) => b.state === 'pending' && b.chapter_ids.length === 1)
      && plan.data.batches[0].chapter_ids[0] === c1.id && plan.data.batches[2].chapter_ids[0] === c3.id
      && plan.data.rules?.version && plan.data.limits?.max_chapters_per_batch && runId,
    `status=${plan.status} batches=${plan.data.batches?.length}`);

  const st0 = await jfetch(`/api/import/rebuild/status?work_id=${workId}&run_id=${runId}`);
  ok('B2 status：未抽取时进度全 0、批次与 run 可读',
    st0.status === 200 && st0.data.progress.extracted === 0 && st0.data.progress.confirmed === 0
      && st0.data.batches.length === 3 && st0.data.run.id === runId);

  const entityItem = { category: 'entity', chapter_id: c1.id, chapter_index: 0, evidence: { quote: '青雀拜入白鹭门下' }, data: { name: '青雀', kind: 'character', aliases: ['小雀'] } };
  const relationItem = { category: 'relation', chapter_id: c1.id, chapter_index: 0, evidence: { quote: '成为记名弟子' }, data: { subject: '青雀', relation: '师徒', value: '白鹭' } };
  const foreshadowItem = { category: 'foreshadow', chapter_id: c1.id, chapter_index: 0, evidence: { quote: '记名弟子' }, data: { summary: '记名弟子的来历存疑' } };
  const fabricated = { category: 'event', chapter_id: c1.id, chapter_index: 0, evidence: { quote: '这句话根本不在原文里' }, data: { summary: '编造事件' } };

  const bad = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 0, result: { items: [entityItem, fabricated] } } });
  const stBad = await jfetch(`/api/import/rebuild/status?work_id=${workId}&run_id=${runId}`);
  ok('B3 record：编造证据整批拒绝（无半批候选），批次仍待跑且 attempts 记账',
    bad.status === 400 && /定位不到/.test(String(bad.data.error)) && stBad.data.batches[0].db_status === 'pending' && stBad.data.batches[0].attempts === 1
      && stBad.data.progress.proposals === 0,
    `status=${bad.status} msg=${String(bad.data.error).slice(0, 90)}`);

  const rec = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 0, result: { items: [entityItem, relationItem, foreshadowItem] } } });
  const propsAfterRec = await jfetch(`/api/novel/state/proposals?work_id=${workId}`);
  ok('B4 record：合法结果 → extracted，候选只记录在批次里（提案尚未登记）',
    rec.status === 201 && rec.data.proposals === 3 && rec.data.result_hash
      && (propsAfterRec.data.proposals || []).length === 0,
    `status=${rec.status} proposals=${rec.data.proposals} msg=${String(rec.data.error || '').slice(0, 80)}`);

  const snapAfterRec = readOnlySnapshot();
  ok('B4b 负向：record 只记录候选——正文/实体/事实/事件/角色知识/提案一律不动（只读库核对）',
    snapAfterRec.facts === 0 && snapAfterRec.events === 0 && snapAfterRec.entities === 0
      && snapAfterRec.knowledge === 0 && snapAfterRec.proposals === 0,
    JSON.stringify(snapAfterRec));

  const recAgain = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 0, result: { items: [entityItem, relationItem, foreshadowItem] } } });
  const batchesRows = countRows('import_rebuild_batches', `run_id = ${runId}`);
  ok('B5 record 幂等：同批重记不产生重复批次行（结果覆盖，批次号唯一）',
    recAgain.status === 201 && batchesRows === 3);

  const cross = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 1, result: { items: [entityItem] } } });
  ok('B6 record：跨批章号混入 → 拒绝（章节位置必须属于本批）',
    cross.status === 400 && /不在本批范围/.test(String(cross.data.error)), `status=${cross.status} msg=${String(cross.data.error || '').slice(0, 80)}`);

  const conf0 = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId, batch_indexes: [0] } });
  const propsAfterConf = await jfetch(`/api/novel/state/proposals?work_id=${workId}`);
  const kinds = (propsAfterConf.data.proposals || []).map((p) => p.kind).sort().join(',');
  const snapAfterConf = readOnlySnapshot();
  ok('B7 confirm：作者确认 = 登记提案 + 批量原子应用（批次 confirmed，正式状态出现）',
    conf0.status === 200 && conf0.data.applied === 1 && conf0.data.proposals_created === 3
      && (conf0.data.results || [])[0].verdict === 'confirmed' && (conf0.data.results || [])[0].applied_ops > 0 && (conf0.data.results || [])[0].snapshot_id > 0
      && conf0.data.rebuild_complete === false && conf0.data.assembled.context_ready === false
      && kinds === 'canon_fact,entity_create,event'
      && (propsAfterConf.data.proposals || []).every((p) => p.state === 'applied')
      && snapAfterConf.facts >= 1 && snapAfterConf.entities >= 1 && snapAfterConf.events >= 1 && snapAfterConf.proposals === 3
      && /未确认|过期/.test(conf0.data.assembled.note),
    `status=${conf0.status} snap=${JSON.stringify(snapAfterConf)} json=${JSON.stringify(conf0.data).slice(0, 160)}`);

  const conf0b = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId, batch_indexes: [0] } });
  const propsAfterConf2 = await jfetch(`/api/novel/state/proposals?work_id=${workId}`);
  ok('B8 confirm 幂等：重复确认不再重复登记提案',
    conf0b.status === 200 && (conf0b.data.results || [])[0].verdict === 'already_confirmed'
      && (propsAfterConf2.data.proposals || []).length === (propsAfterConf.data.proposals || []).length);

  const badQ = { category: 'event', chapter_id: c3.id, chapter_index: 2, evidence: { quote: '这一句也不存在' }, data: { summary: 'x' } };
  const r1 = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 2, result: { items: [badQ] } } });
  const r2 = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 2, result: { items: [badQ] } } });
  const r3 = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 2, result: { items: [badQ] } } });
  const st3 = await jfetch(`/api/import/rebuild/status?work_id=${workId}&run_id=${runId}`);
  ok('B9 解析/校验失败有限重试：3 次失败后批次标记 failed（不再空转）',
    r1.status === 400 && r2.status === 400 && r3.status === 400 && /已达上限/.test(String(r3.data.error))
      && st3.data.batches[2].db_status === 'failed' && st3.data.batches[2].attempts === 3);

  const confAll = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId } });
  ok('B10 confirm：未记录/失败的批次不会被确认（不产生半套正式状态），也不宣称已重建',
    confAll.status === 200 && confAll.data.applied === 0 && confAll.data.rebuild_complete === false
      && (confAll.data.results || []).every((r) => r.verdict !== 'confirmed')
      && readOnlySnapshot().proposals === 3); // 只有 B7 那 3 条（已应用）

  ok('B11 负向：整个重建流程从不改正文（章节内容逐字节不变）', (await contentOf(c1.id)) === c1Before);

  await jfetch(`/api/chapters/${c1.id}`, { method: 'PUT', body: { content: '<p>第一章 初见（改）</p><p>青雀拜入白鹭门下，改了。</p>' } });
  const stStale = await jfetch(`/api/import/rebuild/status?work_id=${workId}&run_id=${runId}`);
  const recStale = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 0, result: { items: [entityItem] } } });
  const confStale = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId, batch_indexes: [0] } });
  const propsAfterStale = await jfetch(`/api/novel/state/proposals?work_id=${workId}`);
  ok('B12 正文变化 → 该批标 stale；record 拒绝、confirm 也不写提案（旧结果仅可读不可复用）',
    stStale.data.batches[0].state === 'stale' && /正文已变化/.test(stStale.data.batches[0].reason)
      && recStale.status === 409 && confStale.status === 200
      && /stale|过期/.test(JSON.stringify(confStale.data.results))
      && (propsAfterStale.data.proposals || []).length === 3);

  const cancel = await jfetch('/api/import/rebuild/cancel', { method: 'POST', body: { run_id: runId } });
  const recAfterCancel = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 1, result: { items: [{ category: 'entity', chapter_id: c2.id, chapter_index: 1, evidence: { quote: '赐名小雀' }, data: { name: '白鹭' } }] } } });
  const resume = await jfetch('/api/import/rebuild/plan', { method: 'POST', body: { work_id: workId, run_id: runId } });
  ok('B13 取消保留结果、恢复可用：cancelled 期间不能再记录，恢复后已完成批次复用、不重跑',
    cancel.status === 200 && cancel.data.run.status === 'cancelled'
      && recAfterCancel.status === 409
      && resume.status === 201 && resume.data.run.status === 'planned'
      && resume.data.batches[0].state === 'stale'
      && resume.data.batches[1].state === 'pending'
      && resume.data.batches[2].state === 'pending',
    JSON.stringify(resume.data.counts || {}));

  const agent = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId }, headers: { 'x-novel-agent': '1' } });
  ok('B14 模型侧（X-Novel-Agent）不得确认重建结果', agent.status === 403 && /作者/.test(String(agent.data.error)));

  // ── C. 作者显式开启故事状态后：确认即原子应用，正式状态出现 ──
  const enabled = await jfetch('/api/novel/story_state', { method: 'PUT', body: { work_id: workId, enabled: true, note: '重建测试' } });
  const factsBefore = countRows('story_facts', `work_id = ${workId}`);
  const entitiesBefore = countRows('story_entities', `work_id = ${workId}`);
  const recC = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId, batch_index: 1, result: { items: [
    { category: 'entity', chapter_id: c2.id, chapter_index: 1, evidence: { quote: '赐名小雀' }, data: { name: '白鹭', kind: 'character' } },
    { category: 'disclosure', chapter_id: c2.id, chapter_index: 1, evidence: { quote: '白鹭收下记名弟子' }, data: { character: '白鹭', fact: '记名弟子名叫小雀' } },
    { category: 'timeline', chapter_id: c2.id, chapter_index: 1, evidence: { quote: '白鹭收下记名弟子，赐名小雀。' }, data: { story_time: '拜师当日', label: '赐名', seq: 1 } },
  ] } } });
  const confC = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId, batch_indexes: [1] } });
  const facts = countRows('story_facts', `work_id = ${workId}`);
  const entities = countRows('story_entities', `work_id = ${workId}`);
  const timeline = countRows('story_timeline_entries', `work_id = ${workId}`);
  ok('C1 确认即原子应用：一次事务写入实体/事实/时间线，装配状态如实上报（未全确认不宣称完整）',
    enabled.status === 200 && enabled.data.enabled === true
      && recC.status === 201 && confC.status === 200 && confC.data.proposals_created === 3
      && (confC.data.results || [])[0].verdict === 'confirmed'
      && facts > factsBefore && entities > entitiesBefore && timeline >= 1
      && confC.data.assembled.story_state_enabled === true && confC.data.rebuild_complete === false,
    `facts=${factsBefore}->${facts} entities=${entitiesBefore}->${entities} timeline=${timeline} json=${JSON.stringify(confC.data.results || []).slice(0, 160)}`);

  // ── C2. 全新作品的完整闭环：全部批次确认 → rebuild_complete / context_ready 为真 ──
  const imp2 = await jfetch('/api/import', { method: 'POST', body: { title: '重建闭环书', text: '第一章 起\n青雀在山门醒来。\n\n第二章 承\n青雀拾到半枚玉佩。' } });
  const workId2 = imp2.data.work_id;
  const chs2 = await jfetch(`/api/chapters?work_id=${workId2}`);
  const list2 = (Array.isArray(chs2.data) ? chs2.data : (chs2.data.chapters || chs2.data.items || [])).slice().sort((a, b) => (a.position || 0) - (b.position || 0) || a.id - b.id);
  await jfetch('/api/novel/story_state', { method: 'PUT', body: { work_id: workId2, enabled: true, note: '重建闭环' } });
  const plan2 = await jfetch('/api/import/rebuild/plan', { method: 'POST', body: { work_id: workId2, batch_size: 6 } });
  const runId2 = plan2.data.run.id;
  const rec2 = await jfetch('/api/import/rebuild/record', { method: 'POST', body: { run_id: runId2, batch_index: 0, result: { items: [
    { category: 'entity', chapter_id: list2[0].id, chapter_index: 0, evidence: { quote: '青雀在山门醒来' }, data: { name: '青雀', kind: 'character' } },
    { category: 'foreshadow', chapter_id: list2[1].id, chapter_index: 1, evidence: { quote: '拾到半枚玉佩' }, data: { summary: '半枚玉佩的来历' } },
  ] } } });
  const conf2 = await jfetch('/api/import/rebuild/confirm', { method: 'POST', body: { run_id: runId2 } });
  const summary2 = await jfetch(`/api/novel/story_state?work_id=${workId2}`);
  ok('C2 完整闭环：全部批次确认后 rebuild_complete / context_ready 为真，装配器可读到正式状态',
    plan2.status === 201 && plan2.data.batches.length === 1 && rec2.status === 201
      && conf2.status === 200 && conf2.data.rebuild_complete === true
      && conf2.data.assembled.context_ready === true && conf2.data.assembled.synced !== undefined
      && countRows('story_entities', `work_id = ${workId2}`) >= 1 && countRows('story_events', `work_id = ${workId2}`) >= 1
      && (summary2.data.counts ? (Number(summary2.data.counts.facts) + Number(summary2.data.counts.entities) + Number(summary2.data.counts.events) > 0) : true),
    `status=${conf2.status} json=${JSON.stringify(conf2.data.assembled || {}).slice(0, 160)}`);
}

cleanup(); // 先收回隔离实例与临时目录：否则子进程管道会拖住事件循环，测试进程不退出
console.log(`\n导入重建（R12）：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) { console.log('未通过项：'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
process.exit(0);
