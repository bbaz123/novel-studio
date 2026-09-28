#!/usr/bin/env node
/**
 * verify-library-realmachine.mjs —— P1 真机硬证据（计划验收 §5「真机」条目）。
 *
 * 配方：真实 OpenViking（本机，经 resolveOpenVikingConfig 解析）+ 隔离小说实例（临时数据目录、空闲端口）。
 *   1. 手放 3 个 md 到共享资料根——写入前确认根为空，非空即放弃（fail-closed，不动作者资料）；
 *   2. find 命中预览（带分数）：确认 3 篇真实可召回（write wait:true 写后即完成索引）；
 *   3. 开某作品的 library_enabled → 装配出现 library 层：条目标注「参考资料｜」、
 *      内容取前 30 行窗口、单条压 ≤300 字、canon 记 reference；
 *      窗口之外的内容（远端标记）不得出现——「readContent 按行取回」的硬证据；
 *   4. 未开开关的作品：library_recall.enabled=false、层与资料内容都不出现（零影响）；
 *   5. NOVELSTUDIO_OV_DISABLED=1 冒烟：library 链完全消失（enabled=false / status=disabled）、无报错；
 *   6. 清理：删除 3 篇 + 两个分类目录（开始时根为空 → 目录里只可能是本次写入），
 *      逐个回读确认删除，最终根 0 残留。
 *
 * 绝不写作品命名空间：隔离实例里的作品/章节直接用 SQL 插入临时库（不走 POST /api/works），
 * 不会触发 syncWorkFull 往真实记忆库的作品子树写文件。唯一真实写入 = 共享资料根本次的 3 篇。
 *
 * 用法: node .p1-baseline/verify-library-realmachine.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ovClient } from '../openviking.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RESULT_FILE = join(HERE, 'verify-library-realmachine.result.json');

const ROOT = 'viking://user/default/resources/novel-studio-library';
const CAT_A = `${ROOT}/方法`;
const CAT_B = `${ROOT}/范例`;

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docText({ title, oneLine, use, sections, farMarker }) {
  const lines = [`# ${title}`, '', `一句话结论：${oneLine}`, `适用场景：${use}`, ''];
  for (const [h, items] of sections) {
    lines.push(`## ${h}`, '');
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  }
  lines.push('## 远端附录', '', `${farMarker}：此段在 30 行取回窗口之外，只用于验证按行取回的边界；预览里不应出现它。`);
  const text = lines.join('\n') + '\n';
  const farLine = text.split('\n').findIndex((l) => l.includes(farMarker)) + 1;
  if (farLine <= 30) throw new Error(`夹具错误：远端标记在第 ${farLine} 行，未超出 30 行窗口`);
  return text;
}

const DOCS = [
  {
    uri: `${CAT_A}/冲突设计.md`, near: '标记-冲突-甲', far: '远端标记-冲突-乙',
    text: docText({
      title: '冲突设计：让每个场景都有两难',
      oneLine: '冲突设计不是让角色吵架，而是让「想做的事」与「代价」正面相撞（标记-冲突-甲）。',
      use: '需要角色在两难中选择、并承担后果的段落；与节奏控制配合使用。',
      sections: [
        ['是什么', ['冲突 = 目标 + 阻力 + 代价；目标越具体，阻力越贴身。', '雪线场景的经典两难：继续前进（可能冻伤）与下撤（错过窗口）。']],
        ['怎么写', ['先写角色最想要的东西，再让第一个障碍出现在同一页。', '把选择的代价写进场景细节：燃料、时间、伤口、同伴的信任。', '每次选择都改变处境：赢下一局，也要失去点什么。', '两难要对称：两个选项都有明确、可感知的损失。', '冲突升级用代价必须当场兑现来锚定。']],
        ['常见错误', ['只写吵架，不写选择。', '阻力太远，角色感受不到。', '冲突解决得太干净，没有留下余波。', '把巧合当转折，读者会觉得被骗。']],
        ['对照表', ['目标模糊 → 读者不紧张。', '目标具体 → 每个障碍都可感。', '代价可兑现 → 选择有重量。', '代价抽象 → 冲突变空话。']],
      ],
      farMarker: '远端标记-冲突-乙',
    }),
  },
  {
    uri: `${CAT_A}/节奏控制.md`, near: '标记-节奏-甲', far: '远端标记-节奏-乙',
    text: docText({
      title: '节奏控制：松紧交替的长短句',
      oneLine: '节奏控制是句子长度、场景长度与信息密度的统一调度（标记-节奏-甲）。',
      use: '需要在动作与停顿之间切换张力的段落；与冲突设计配合使用。',
      sections: [
        ['是什么', ['节奏 = 单位篇幅里的信息密度与情绪变化速度。', '快：短句、动作、连续选择；慢：长句、观察、后果。']],
        ['怎么写', ['动作段用短句，停顿段用长句，交替出现。', '每 3–5 段给一次呼吸；紧太久读者会麻木。', '高潮前主动降速，让读者把注意力放到选择上。', '场景结束留一个未解的钩子。', '复读时先数句子长度，再谈感受。']],
        ['常见错误', ['全程快：读起来喘不过气。', '全程慢：读起来像说明书。', '用形容词代替动作加速。', '在段落中途换速，读者会出戏。']],
        ['对照表', ['短句 → 压迫感。', '长句 → 沉思感。', '长短交替 → 呼吸感。', '一直同速 → 疲劳。']],
      ],
      farMarker: '远端标记-节奏-乙',
    }),
  },
  {
    uri: `${CAT_B}/雪线场景写法.md`, near: '标记-雪线-甲', far: '远端标记-雪线-乙',
    text: docText({
      title: '范例：雪线场景的写法（范例，非本书事实）',
      oneLine: '雪线场景的书写要点：低温、视野、体力与决定窗口（标记-雪线-甲）。',
      use: '高海拔、风雪、体能受限场景的写法参考。',
      sections: [
        ['是什么', ['雪线场景的特征：冷、白、滑、看不清与时间窗口有限。', '景物即阻力：风、雪、坡度都在消耗角色。']],
        ['怎么写', ['用体感写温度：手指、膝盖、呼吸的水汽。', '用视野写危险：白雾里只能靠绳结计数。', '用时间写压力：窗口在几小时内关闭。', '用装备写代价：绳索、燃料、备用镜。', '让环境替角色说一句话：风把答案吹走。']],
        ['常见错误', ['只写风景，不写体感。', '危险来得没有铺垫。', '装备变成装饰品。', '角色体力无限，紧张感消失。']],
        ['对照表', ['体感 → 代入。', '视野 → 恐惧。', '时间 → 压力。', '装备 → 代价。']],
      ],
      farMarker: '远端标记-雪线-乙',
    }),
  },
];

const out = {
  started_at: new Date().toISOString(),
  root: ROOT,
  docs: DOCS.map((d) => d.uri),
  write: [],
  preview: null,
  enabled_work: null,
  disabled_work: null,
  ov_disabled_smoke: null,
  cleanup: null,
};
const writtenUris = [];
let wroteAnything = false;

async function cleanupLibrary() {
  for (const uri of writtenUris) await ovClient.remove(uri, { timeoutMs: 20000 }).catch(() => { /* 尽力 */ });
  if (wroteAnything) {
    for (const dir of [CAT_A, CAT_B]) await ovClient.remove(dir, { recursive: true, timeoutMs: 20000 }).catch(() => { /* 尽力 */ });
  }
  const reads = [];
  for (const d of DOCS) {
    const r = await ovClient.readContent(d.uri, { timeoutMs: 5000 }).catch(() => ({ ok: false, text: '' }));
    reads.push({ uri: d.uri, ok: r.ok, text_len: String(r.text || '').length });
  }
  const ls = await ovClient.list(ROOT, { recursive: true, timeoutMs: 10000 }).catch(() => ({ ok: false, entries: [] }));
  return {
    removed: writtenUris.slice(),
    read_back: reads,
    residue: ls.ok ? ls.entries.map((e) => e.uri) : ['<ls 失败>'],
    clean: Boolean(ls.ok) && ls.entries.length === 0 && reads.every((r) => !r.ok || r.text_len === 0),
  };
}

function freePort() {
  return new Promise((resolvePort) => {
    import('node:net').then(({ default: net }) => {
      const probe = net.createServer();
      probe.once('error', () => resolvePort(5850 + (process.pid % 200)));
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
    }).catch(() => resolvePort(5850 + (process.pid % 200)));
  });
}

async function startInstance(dataDir, extraEnv = {}) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      NOVELSTUDIO_DATA_DIR: dataDir,
      NOVELSTUDIO_OV_AUTOINDEX: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i += 1) {
    try {
      const r = await fetch(`${base}/api/novel/ping`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) return { server, base, log: () => log };
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  try { server.kill(); } catch { /* 已退出 */ }
  throw new Error(`隔离实例未就绪：${log.slice(-1500)}`);
}

function dbRun(dbFile, sql, ...params) {
  const d = new DatabaseSync(dbFile);
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).run(...params); } finally { d.close(); }
}
function dbGet(dbFile, sql, ...params) {
  const d = new DatabaseSync(dbFile);
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).get(...params); } finally { d.close(); }
}
function seedWork(dbFile, { title, description, chapterTitle, chapterContent }) {
  dbRun(dbFile, "INSERT INTO works (title, description, ov_uri) VALUES (?, ?, '')", title, description);
  const w = dbGet(dbFile, 'SELECT id, ov_uri FROM works ORDER BY id DESC LIMIT 1');
  dbRun(dbFile, 'INSERT INTO chapters (work_id, title, summary, content, position) VALUES (?, ?, ?, ?, 0)',
    w.id, chapterTitle, '本章测试资料库门控层。', chapterContent);
  const c = dbGet(dbFile, 'SELECT id FROM chapters WHERE work_id = ? ORDER BY id DESC LIMIT 1', w.id);
  return { workId: w.id, chapterId: c.id, ovUri: w.ov_uri };
}
async function contextOf(base, workId, chapterId) {
  const res = await fetch(`${base}/api/novel/context?work_id=${workId}&chapter_id=${chapterId}&mode=full`, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

const QUERY_TERMS = '冲突设计的两难抉择与节奏控制；雪线场景写法（写作方法）';

async function main() {
  // ── 0. 真机前提 ──
  console.log('【0. 真机前提】');
  const healthy = await ovClient.health();
  ok('Z1 真实 OpenViking 在线（/health）', healthy === true);
  if (!healthy) throw new Error('OV 不在线，放弃（不触碰任何数据）');
  const rootBefore = await ovClient.list(ROOT, { recursive: true, timeoutMs: 10000 });
  ok('Z2 共享资料根在线且为空（写前 fail-closed：非空即放弃）', rootBefore.ok === true && rootBefore.entries.length === 0,
    JSON.stringify((rootBefore.entries || []).map((e) => e.uri).slice(0, 5)));
  if (!rootBefore.ok || rootBefore.entries.length) throw new Error('资料根非空，放弃本次真机验证（不动作者资料）');

  // ── 1. 手放 3 篇（write wait:true = 等索引完成）──
  console.log('\n【1. 手放 3 篇 md（写后索引完成）】');
  for (const d of DOCS) {
    const t0 = Date.now();
    const r = await ovClient.write(d.uri, d.text, { wait: true, timeoutMs: 120000 }).catch((e) => ({ ok: false, error: { message: e.message } }));
    const took = Date.now() - t0;
    out.write.push({ uri: d.uri, ok: r.ok === true, took_ms: took });
    if (r.ok) { wroteAnything = true; writtenUris.push(d.uri); }
    ok(`W ${d.uri.split('/').pop()} 写入成功（${(took / 1000).toFixed(1)}s）`, r.ok === true, JSON.stringify(r).slice(0, 200));
  }

  // ── 2. 命中预览（独立 find，与装配同一阈值 0.40）──
  console.log('\n【2. 命中预览（find / targetUri=共享根 / 阈值 0.40）】');
  let preview = [];
  for (let i = 0; i < 20 && preview.length === 0; i += 1) {
    preview = await ovClient.find(QUERY_TERMS, { targetUri: ROOT, limit: 8, scoreThreshold: 0.4, timeoutMs: 8000 }).catch(() => []);
    if (!preview.length) await sleep(3000);
  }
  out.preview = { query: QUERY_TERMS, hits: preview.map((h) => ({ uri: h.uri, score: h.score, abstract: String(h.abstract || '').slice(0, 120) })) };
  ok('P1 至少 1 篇可召回（阈值 0.40 下调得到）', preview.length >= 1,
    JSON.stringify(out.preview.hits.map((h) => [h.uri.split('/').pop(), h.score])));
  for (const h of preview) console.log(`    · ${h.uri.split('/').pop()}  score=${h.score}`);

  // ── 3. 开开关的作品：装配出现 library 层 ──
  console.log('\n【3. 开开关的作品（library_enabled=1）】');
  const dir1 = mkdtempSync(join(tmpdir(), 'novel-lib-real-on-'));
  const inst1 = await startInstance(dir1, { NOVELSTUDIO_OV_DISABLED: '0' });
  try {
    const db1 = join(dir1, 'novel.db');
    const seeded = seedWork(db1, {
      title: '雪线冲突设计', description: '关于雪线上的两难抉择与节奏控制的写作实验。',
      chapterTitle: '暴风雪中的冲突设计', chapterContent: `这一段是测试正文：${QUERY_TERMS}。`,
    });
    dbRun(db1, "INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value", `library_enabled:${seeded.workId}`);
    const ctx = await contextOf(inst1.base, seeded.workId, seeded.chapterId);
    const rec = (ctx.data && ctx.data.library_recall) || {};
    const assembled = String((ctx.data && ctx.data.assembled) || '');
    const manifest = (ctx.data && ctx.data.context_manifest) || [];
    const hits = rec.hits || [];
    out.enabled_work = {
      work_id: seeded.workId, status: ctx.status, ov_uri: seeded.ovUri,
      library_recall: { enabled: rec.enabled, status: rec.status, hits: hits.map((h) => ({ uri: h.uri, label: h.label, score: h.score, text_len: String(h.text || '').length, canon: (h.source_meta || {}).canon })), omitted: rec.omitted || [] },
      layer_in_manifest: manifest.some((m) => m.id === 'library'),
      assembled_has_label: assembled.includes('参考资料（非本书事实）'),
      assembled_len: assembled.length,
    };
    ok('R1 装配 HTTP 200 且 library_recall.status=ok', ctx.status === 200 && rec.status === 'ok', JSON.stringify({ http: ctx.status, status: rec.status }));
    ok('R2 命中 ≥1 且全部落在共享资料根内', hits.length >= 1 && hits.every((h) => String(h.uri).startsWith(`${ROOT}/`)),
      JSON.stringify(hits.map((h) => h.uri)));
    ok('R3 层进入 assembled 与清单（标题注明「非本书事实」）', out.enabled_work.assembled_has_label && out.enabled_work.layer_in_manifest === true);
    ok('R4 条目标注与正典状态：label 带「参考资料｜」、canon=reference（永不 canon）',
      hits.every((h) => String(h.label || '').startsWith('参考资料｜') && (h.source_meta || {}).canon === 'reference'));
    ok('R5 单条文本 ≤300 字（压窗口）', hits.every((h) => String(h.text || '').length <= 301),
      JSON.stringify(hits.map((h) => String(h.text || '').length)));
    const nearDocs = hits.filter((h) => DOCS.some((d) => d.uri === h.uri && h.text.includes(d.near)));
    ok('R6 取回内容含各篇「近端标记」（前 30 行窗口内）', nearDocs.length >= 1 && nearDocs.length === hits.length,
      JSON.stringify(hits.map((h) => ({ uri: h.uri.split('/').pop(), has_near: DOCS.some((d) => d.uri === h.uri && h.text.includes(d.near)) }))));
    ok('R7 窗口之外的内容（远端标记）不出现——readContent 按行取回的硬证据',
      hits.every((h) => !DOCS.some((d) => d.uri === h.uri && h.text.includes(d.far))) && hits.every((h) => !String(h.text || '').includes('远端标记')),
      JSON.stringify(hits.filter((h) => String(h.text || '').includes('远端标记')).map((h) => h.uri)));
    ok('R8 assembled 里确有资料正文（而不只是层标题）且不含窗口外内容',
      nearDocs.some((h) => assembled.includes(String(h.text).slice(0, 40))) && !assembled.includes('远端标记'));
    // P1 真机实测（本轮首次跑出的问题）：OV 给目录生成 .abstract/.overview 伴随文件，
    // 分数常高于正文（实测 0.72/0.64 vs 0.67/0.56/0.48）——它们必须被保留前缀规则拦下，
    // 且「先过滤、后截断」保证 3 篇真资料都不被挤出（见 ai/library/library-roots.mjs）。
    const previewCompanions = (out.preview.hits || [])
      .map((h) => h.uri)
      .filter((u) => /\/(\.[^/]+)$/.test(u));
    ok('R9 伴随文件（.abstract/.overview）不进层且带 library_reserved 归因；3 篇真资料全部进层',
      hits.length === DOCS.length
        && hits.every((h) => DOCS.some((d) => d.uri === h.uri))
        && previewCompanions.every((u) => (rec.omitted || []).some((o) => o.uri === u && o.code === 'library_reserved'))
        && (rec.omitted || []).every((o) => o.code === 'library_reserved'),
      JSON.stringify({ hits: hits.map((h) => h.uri.split('/').slice(-2).join('/')), companions: previewCompanions.map((u) => u.split('/').slice(-2).join('/')), omitted: (rec.omitted || []).map((o) => [o.uri.split('/').slice(-2).join('/'), o.code]) }));
  } finally {
    try { inst1.server.kill(); } catch { /* 已退出 */ }
    try { rmSync(dir1, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给临时目录清理 */ }
  }

  // ── 4. 未开开关的作品：零影响 ──
  console.log('\n【4. 未开开关的作品（默认关闭）】');
  const dir2 = mkdtempSync(join(tmpdir(), 'novel-lib-real-off-'));
  const inst2 = await startInstance(dir2, { NOVELSTUDIO_OV_DISABLED: '0' });
  try {
    const db2 = join(dir2, 'novel.db');
    const seeded2 = seedWork(db2, {
      title: '雪线冲突设计（未开开关）', description: '与开启作品同题材，验证未开开关时资料不进入。',
      chapterTitle: '暴风雪中的冲突设计（未开开关）', chapterContent: `这一段是测试正文：${QUERY_TERMS}。`,
    });
    const ctx2 = await contextOf(inst2.base, seeded2.workId, seeded2.chapterId);
    const rec2 = (ctx2.data && ctx2.data.library_recall) || {};
    const assembled2 = String((ctx2.data && ctx2.data.assembled) || '');
    out.disabled_work = {
      work_id: seeded2.workId, status: ctx2.status,
      library_recall: { enabled: rec2.enabled, status: rec2.status, hits: (rec2.hits || []).length },
      assembled_has_label: assembled2.includes('参考资料（非本书事实）'),
      assembled_has_doc_text: DOCS.some((d) => assembled2.includes(d.near)),
    };
    ok('O1 未开开关：library_recall.enabled=false、零命中', ctx2.status === 200 && rec2.enabled === false && (rec2.hits || []).length === 0,
      JSON.stringify(out.disabled_work.library_recall));
    ok('O2 未开开关：层与资料正文都不在 assembled（同题材、同查询下）',
      !out.disabled_work.assembled_has_label && !out.disabled_work.assembled_has_doc_text);
  } finally {
    try { inst2.server.kill(); } catch { /* 已退出 */ }
    try { rmSync(dir2, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给临时目录清理 */ }
  }

  // ── 5. NOVELSTUDIO_OV_DISABLED=1 冒烟 ──
  console.log('\n【5. 总闸关闭冒烟（NOVELSTUDIO_OV_DISABLED=1）】');
  const dir3 = mkdtempSync(join(tmpdir(), 'novel-lib-real-offswitch-'));
  const inst3 = await startInstance(dir3, { NOVELSTUDIO_OV_DISABLED: '1' });
  try {
    const db3 = join(dir3, 'novel.db');
    const seeded3 = seedWork(db3, {
      title: '雪线冲突设计（总闸关闭）', description: '', chapterTitle: '第一章', chapterContent: `正文：${QUERY_TERMS}。`,
    });
    dbRun(db3, "INSERT INTO app_settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value", `library_enabled:${seeded3.workId}`);
    const ctx3 = await contextOf(inst3.base, seeded3.workId, seeded3.chapterId);
    const rec3 = (ctx3.data && ctx3.data.library_recall) || {};
    const assembled3 = String((ctx3.data && ctx3.data.assembled) || '');
    out.ov_disabled_smoke = {
      status: ctx3.status, library_recall: { enabled: rec3.enabled, status: rec3.status },
      assembled_has_label: assembled3.includes('参考资料（非本书事实）'),
      server_log_tail: inst3.log().slice(-400),
    };
    ok('S1 总闸关闭：library 链完全消失（enabled=false / status=disabled）且响应 200 无报错',
      ctx3.status === 200 && rec3.enabled === false && rec3.status === 'disabled' && !out.ov_disabled_smoke.assembled_has_label,
      JSON.stringify(out.ov_disabled_smoke.library_recall));
  } finally {
    try { inst3.server.kill(); } catch { /* 已退出 */ }
    try { rmSync(dir3, { recursive: true, force: true }); } catch { /* Windows 文件锁：留给临时目录清理 */ }
  }
}

try {
  await main();
} catch (e) {
  fails.push('执行异常');
  console.error('✗ 执行异常：', e && e.stack ? e.stack : e);
} finally {
  console.log('\n【6. 清理】');
  out.cleanup = await cleanupLibrary().catch((e) => ({ clean: false, error: String(e && e.message) }));
  out.pass = pass;
  out.fails = fails;
  out.finished_at = new Date().toISOString();
  writeFileSync(RESULT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`  残留检查：${out.cleanup.clean ? '根 0 残留、回读全部失败（干净）' : JSON.stringify(out.cleanup).slice(0, 300)}`);
  console.log(`\n真机验证（共享资料根）：通过 ${pass} / 未通过 ${fails.length}`);
  console.log(`证据文件：${RESULT_FILE}`);
  if (fails.length) { console.log('未通过项：\n' + fails.map((f) => '  - ' + f).join('\n')); process.exitCode = 1; }
  if (!out.cleanup || out.cleanup.clean !== true) process.exitCode = 1;
}
