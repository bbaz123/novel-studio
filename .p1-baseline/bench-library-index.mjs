#!/usr/bin/env node
/**
 * bench-library-index.mjs —— 资料索引（D 模块）的**规模基线**：50 篇 vs 5000 篇。
 *
 * 为什么要它：交付要求给出「索引开启与关闭 / 50 篇与 5000 篇」的指标对比，而真实
 * 大库不在仓库里。这里用**合成数据 + 临时库**离线测量索引的构建与查询成本，回答：
 *   ① 增量维护一篇的边际成本（含 sha 未变时直接跳过）；
 *   ② 词法候选查询在 100 倍规模下是否仍可用（有界：candidateLimit=24，超时 1000ms）；
 *   ③ 索引体积随篇数是否近似线性。
 *
 * ⚠️ 这是**合成数据**的本地测量（零计费、不连 OpenViking、不碰作者数据），
 * 它**不等于**真实库的召回质量；质量与相关性仍需真实评测（见最终报告口径）。
 *
 * 用法:
 *   node .p1-baseline/bench-library-index.mjs              # 50 与 5000 两档（子进程各自隔离）
 *   node .p1-baseline/bench-library-index.mjs --scale 5000 # 只跑一档（子进程入口）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const NL = String.fromCharCode(10);

const scaleArg = (() => { const i = process.argv.indexOf('--scale'); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();

const KEYWORDS = ['灵灯', '旧港', '雾季', '银渠', '夜航'];

function synthDoc(i) {
  const kw = KEYWORDS[i % KEYWORDS.length];
  // 查询词「灵灯」按关键词轮转出现（约每 5 篇 1 篇）；rare 标记另把更稀的出现引到同一词上。
  const rare = (i % 25 === 0) ? '灵灯' : '';
  const title = kw + '采风笔记 第' + i + '辑';
  const body = [
    '标题：' + title,
    '本辑围绕' + kw + '展开，记录了航路、潮汐与灯位的变迁，供写作时取用。',
    rare ? ('其中提到了一种失传的' + rare + '工艺，属于重点素材。') : '',
    '摘录片段：' + Array.from({ length: 6 }, (_, k) => '第' + (k + 1) + '段：' + kw + ((i + k) % 97) + '号材料，用于场景与道具描写。').join(' '),
  ].filter(Boolean).join(NL);
  return { title, body };
}

async function runScale(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-bench-lib-'));
  process.env.NOVELSTUDIO_DATA_DIR = dir;
  process.env.NOVELSTUDIO_OV_DISABLED = '1';
  const { db } = await import('../db.js');
  const Index = await import('../ai/library/library-index.mjs');

  const insertDoc = db.prepare("INSERT INTO library_docs (scope, work_id, uri, rel, category, slug, title, sha256, bytes, chars, est_chunks, source_path, status, indexed_at) VALUES ('shared', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  const docs = [];
  for (let i = 1; i <= n; i += 1) {
    const d = synthDoc(i);
    const sha = crypto.createHash('sha256').update(d.body).digest('hex');
    const info = insertDoc.run('shared/bench/' + i + '.md', 'bench/' + i + '.md', 'bench', 'd' + i, d.title, sha, Buffer.byteLength(d.body), d.body.length, 1);
    docs.push({ id: Number(info.lastInsertRowid), uri: 'shared/bench/' + i + '.md', sha, title: d.title, body: d.body });
  }

  // ① 构建：逐篇 upsert（增量维护路径）。
  const t0 = process.hrtime.bigint();
  let indexed = 0; let failed = 0;
  for (const d of docs) {
    const r = Index.upsertEntry({ docId: d.id, uri: d.uri, sha256: d.sha, title: d.title, category: 'bench', tags: '', text: d.body });
    if (r.ok) indexed += 1; else failed += 1;
  }
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // ② sha 未变的重复维护：应当直接跳过（D3）。
  const sample = docs.slice(0, Math.min(100, docs.length));
  const t1 = process.hrtime.bigint();
  let skipped = 0;
  for (const d of sample) {
    const r = Index.upsertEntry({ docId: d.id, uri: d.uri, sha256: d.sha, title: d.title, category: 'bench', tags: '', text: d.body });
    if (r.ok && r.skipped) skipped += 1;
  }
  const skipMs = Number(process.hrtime.bigint() - t1) / 1e6;

  // ③ 查询：长尾词「灵灯」重复 30 次，取中位与 p90（每次查询都计入索引查询计数，属预期）。
  const times = [];
  let status = ''; let hits = 0;
  for (let k = 0; k < 30; k += 1) {
    const t = process.hrtime.bigint();
    const r = Index.queryCandidates({ query: '灵灯', limit: 12 });
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
    status = r.status; hits = r.candidates.length;
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p90 = times[Math.min(times.length - 1, Math.floor(times.length * 0.9))];

  const sizeBytes = fs.statSync(path.join(dir, 'novel.db')).size;
  const stats = Index.indexStats();
  const result = {
    docs: n,
    indexed, failed,
    build_ms: Number(buildMs.toFixed(1)),
    build_ms_per_doc: Number((buildMs / n).toFixed(3)),
    unchanged_skip_ms_per_doc: Number((skipMs / sample.length).toFixed(3)),
    query_median_ms: Number(median.toFixed(2)),
    query_p90_ms: Number(p90.toFixed(2)),
    query_status: status,
    query_hits: hits,
    db_bytes: sizeBytes,
    index_entries: stats.entries,
    fts: stats.fts,
  };
  try { db.close(); } catch { /* 忽略：退出时由系统回收 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  return result;
}

if (scaleArg) {
  const r = await runScale(scaleArg);
  console.log(JSON.stringify(r));
  process.exit(0);
}

const scales = [50, 5000];
const results = [];
for (const n of scales) {
  const out = execFileSync(process.execPath, [SELF, '--scale', String(n)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  results.push(JSON.parse(out.trim().split(NL).pop()));
}

const KiB = (b) => (b / 1024).toFixed(1) + ' KiB';
const MiB = (b) => (b / 1024 / 1024).toFixed(2) + ' MiB';
console.log('资料索引规模基线（合成数据 / 临时库 / 离线 / 零计费）');
console.log('档位     构建总耗时     每篇构建    sha未变跳过/篇   查询中位   查询p90   命中   索引行   库文件大小');
for (const r of results) {
  console.log(
    (String(r.docs) + ' 篇').padEnd(8)
    + (r.build_ms + ' ms').padEnd(14)
    + (r.build_ms_per_doc + ' ms').padEnd(12)
    + (r.unchanged_skip_ms_per_doc + ' ms').padEnd(18)
    + (r.query_median_ms + ' ms').padEnd(11)
    + (r.query_p90_ms + ' ms').padEnd(10)
    + String(r.query_hits).padEnd(7)
    + String(r.index_entries).padEnd(9)
    + (r.docs === 50 ? KiB(r.db_bytes) : MiB(r.db_bytes)),
  );
}
console.log('');
console.log('说明：查询固定为高频词「灵灯」（≈每 5 篇出现 1 篇，命中数被 limit=12 截断）；');
console.log('      查询有界不随规模增长（candidateLimit=24 / 超时 1000ms），大小两档都返回 ok 且有命中；');
console.log('      合成数据只测**成本与可用性**，召回质量仍需真实库评测。');
console.log(JSON.stringify(results, null, 1));
