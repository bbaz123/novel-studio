#!/usr/bin/env node
/**
 * perf-temporal-baseline.mjs —— 时态故事状态重构 · 可复现性能基线（AC-48 / T8 §12.1）
 *
 * 合成 100 / 500 / 1000 章作品，在临时目录（NOVELSTUDIO_DATA_DIR = mkdtemp）测时态引擎成本：
 *   · 保存路径：recordContentSave（所有正文写入口统一调用的保存后处理）
 *   · 作者确认：applyChapterEvents（逐章确认 + 章边界快照 + 提交清单）
 *   · 状态查询：stateAtChapter（最后一章 / 中间章）与 trustReport
 *   · 章节面板：chapterPanel(includeFull)（正文下方状态面板的数据源）
 *   · SQL 语句次数（DatabaseSync.prepare 计数）、库体积、峰值 RSS
 *
 * 纪律：零模型、零计费；严禁真实作品做夹具——正文全部合成；只写临时目录。
 * 用法：node scripts/perf-temporal-baseline.mjs --size 100
 *       （100 / 500 / 1000 各跑一次；输出 PERF_JSON 行可被脚本采集）
 */
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const SIZE = (() => {
  const i = process.argv.indexOf('--size');
  const n = i >= 0 ? Number(process.argv[i + 1]) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
})();

// 隔离必须在 import db.js 之前生效（与 tests/temporal/harness.mjs 同一纪律）
const dir = mkdtempSync(join(tmpdir(), `ns-perf-${SIZE}-`));
process.env.NOVELSTUDIO_DATA_DIR = dir;
process.env.NOVELSTUDIO_OV_DISABLED = '1';

// SQL 计数：db.js 用 new DatabaseSync(...) 建库；在 import 之前挂原型补丁。
// stmtCount = 语句**执行**次数（run/get/all）；prepareCount = 语句**编译**次数。
// （重构后读取路径使用进程内语句缓存，编译次数与执行次数不再相等，必须分开报告。）
let stmtCount = 0;
let prepareCount = 0;
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function countedPrepare(...args) {
  prepareCount += 1;
  return origPrepare.apply(this, args);
};
for (const method of ['run', 'get', 'all']) {
  const orig = StatementSync.prototype[method];
  StatementSync.prototype[method] = function countedStatement(...args) {
    stmtCount += 1;
    return orig.apply(this, args);
  };
}

const T = await import('../ai/story-state/temporal/index.mjs');
const { db } = await import('../db.js');

const now = () => new Date().toISOString();
const ms = (t0) => Number((performance.now() - t0).toFixed(2));
let rssPeak = process.memoryUsage().rss;
const trackRss = () => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); };

/** 合成正文：每章约 1.1k 字；完全虚构，不来自任何真实作品。 */
function chapterText(i) {
  const n = i + 1;
  const npc = `角色${(i % 20) + 1}`;
  const place = `地点${(i % 10) + 1}`;
  const blocks = [];
  for (let p = 0; p < 12; p += 1) {
    blocks.push(`第${n}章第${p + 1}段：${npc}在${place}遇到了新的线索，他停下来观察四周，记下需要处理的事情，然后继续前进。本段为性能基线的合成文本。`);
  }
  return `<p>${blocks.join('</p><p>')}</p>`;
}

const wallStart = performance.now();

// ── 合成作品与章节（直接落库；不计入保存路径耗时）──────────────────────────
let t0 = performance.now();
db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`性能基线-${SIZE}章`, now(), now());
const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
const chapterIds = [];
const contents = [];
for (let i = 0; i < SIZE; i += 1) {
  const html = chapterText(i);
  contents.push(html);
  db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workId, `合成第${i + 1}章`, html, i, now(), now());
  chapterIds.push(Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id));
}
const seedMs = ms(t0);
const contentChars = contents.reduce((a, c) => a + c.length, 0);
const contentBytes = contents.reduce((a, c) => a + Buffer.byteLength(c), 0);

T.setTemporalConfig(workId, { temporal_enabled: true });

// ── 保存路径：每个正文写入口都会走的 recordContentSave ──────────────────────
t0 = performance.now();
for (let i = 0; i < SIZE; i += 1) {
  const r = T.recordContentSave({ workId, chapterId: chapterIds[i], contentHtml: contents[i], origin: { kind: 'perf_seed' } });
  if (!r || r.enabled !== true || r.recorded !== true) throw new Error(`recordContentSave 失败 @${i}: ${JSON.stringify(r).slice(0, 200)}`);
}
const recordMs = ms(t0);
trackRss();

// ── 作者确认：逐章 applyChapterEvents（前置条件必须成立；1 个可变单元 + 1 个新单元）──
t0 = performance.now();
for (let i = 0; i < SIZE; i += 1) {
  const chapterId = chapterIds[i];
  const revision = T.latestRevisionOf(chapterId);
  const ops = [
    { type: 'set', cell: { domain: 'world_fact', entityId: `合成事实${i}`, predicate: 'value', scope: 'canon', holderId: null }, expected: { kind: 'missing' }, value: i },
    {
      type: 'set', cell: { domain: 'character', entityId: '主角', predicate: 'status', scope: 'canon', holderId: null },
      expected: i === 0 ? { kind: 'missing' } : { kind: 'value', value: `状态${i - 1}` },
      value: `状态${i}`,
    },
  ];
  const res = T.applyChapterEvents({
    workId, chapterId,
    events: [{ cursor: T.cursorOfChapter(workId, chapterId), ops, evidence: [{ revision_id: revision.id, quote: `第${i + 1}章第1段`, narrative: 'present' }] }],
  });
  if (!res || res.ok !== true) throw new Error(`applyChapterEvents 失败 @${i}: ${(res && res.reason) || JSON.stringify(res).slice(0, 200)}`);
}
const confirmMs = ms(t0);
trackRss();

// ── 状态查询（重置语句计数，分别测）────────────────────────────────────────
const finalChapterId = chapterIds[SIZE - 1];
const midChapterId = chapterIds[Math.floor(SIZE / 2)];

stmtCount = 0;
t0 = performance.now();
const lastQuery = T.stateAtChapter({ workId, chapterId: finalChapterId, boundary: 'after' });
const queryLastMs = ms(t0);
const queryLastStmts = stmtCount;
const lastEntries = lastQuery.state_json ? Object.keys(lastQuery.state_json).length : 0;

stmtCount = 0;
t0 = performance.now();
const midQuery = T.stateAtChapter({ workId, chapterId: midChapterId, boundary: 'after' });
const queryMidMs = ms(t0);
const queryMidStmts = stmtCount;
const midEntries = midQuery.state_json ? Object.keys(midQuery.state_json).length : 0;

stmtCount = 0;
t0 = performance.now();
const trust = T.trustReport({ workId });
const trustMs = ms(t0);
const trustStmts = stmtCount;

stmtCount = 0;
t0 = performance.now();
const panel = T.chapterPanel({ workId, chapterId: finalChapterId, boundary: 'after', includeFull: true });
const panelMs = ms(t0);
const panelStmts = stmtCount;
trackRss();

const dbBytes = statSync(join(dir, 'novel.db')).size;
const wallMs = ms(wallStart);

const report = {
  env: {
    date: now(), node: process.version, platform: `${process.platform} ${process.arch}`,
    cpu: (cpus()[0] || {}).model || '', ram_gb: Number((totalmem() / 1073741824).toFixed(1)),
    isolation: 'mkdtemp + NOVELSTUDIO_DATA_DIR（合成数据，零模型）',
  },
  size_chapters: SIZE,
  content_chars_total: contentChars,
  content_bytes_total: contentBytes,
  seed_ms: seedMs,
  save_path_record_total_ms: recordMs,
  save_path_record_avg_ms: Number((recordMs / SIZE).toFixed(3)),
  confirm_total_ms: confirmMs,
  confirm_avg_ms: Number((confirmMs / SIZE).toFixed(3)),
  state_entries_final: lastEntries,
  query_last_ms: queryLastMs, query_last_entries: lastEntries, query_last_sql_statements: queryLastStmts,
  query_mid_ms: queryMidMs, query_mid_entries: midEntries, query_mid_sql_statements: queryMidStmts,
  trust_ms: trustMs, trust_chapters: (trust.chapters || []).length, trust_sql_statements: trustStmts,
  panel_ms: panelMs, panel_sql_statements: panelStmts,
  sql_stats_note: 'sql_statements_* = 语句执行次数（run/get/all）；sql_prepare_count_total = 语句编译次数',
  sql_prepare_count_total: prepareCount,
  panel_characters: (panel.characters || []).length,
  db_bytes: dbBytes,
  rss_peak_mb: Number((rssPeak / 1048576).toFixed(1)),
  wall_ms: wallMs,
};

console.log(`\n[perf] ${SIZE} 章 · 正文 ${(contentChars / 1000).toFixed(1)}k 字 / ${(contentBytes / 1024).toFixed(0)} KiB · 库 ${(dbBytes / 1048576).toFixed(2)} MiB`);
console.log(`  保存后处理 ${recordMs}ms（均 ${report.save_path_record_avg_ms}ms/章）｜逐章确认 ${confirmMs}ms（均 ${report.confirm_avg_ms}ms/章）`);
console.log(`  状态查询：末章 ${queryLastMs}ms（${lastEntries} 条 / ${queryLastStmts} SQL）｜中间章 ${queryMidMs}ms（${midEntries} 条 / ${queryMidStmts} SQL）`);
console.log(`  可信前缀报告 ${trustMs}ms（${report.trust_chapters} 章）｜章节面板 ${panelMs}ms（${panelStmts} SQL）｜峰值 RSS ${report.rss_peak_mb} MiB｜总墙钟 ${wallMs}ms`);
console.log('PERF_JSON: ' + JSON.stringify(report));
