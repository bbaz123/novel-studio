#!/usr/bin/env node
/**
 * scripts/nsdsh/benchmark.mjs —— S15：合成夹具性能实测（100 / 1000 章）。
 *
 * 为什么必须在**合成夹具**上测：真实作品数据属于作者，不能拿来做压测；
 * 而"感觉挺快"不是证据。本脚本建一个隔离库、灌入 N 章，测量**可重复的**几件事：
 *   · 冷启动：从零建库 + 迁移 + 灌数据的总耗时；
 *   · 热读取：同一进程内第二次查询（命中缓存/已预热）的耗时；
 *   · 缓存命中/未命中：同一查询在有/无缓存时的差异。
 *
 * 输出必须包含**硬件与计时边界**（验收要求），否则数字无法比较：
 *   node 版本、平台、CPU 型号、总内存、计时器精度、样本数、min/median/max。
 *
 * 用法：
 *   node scripts/nsdsh/benchmark.mjs --fixture --chapters 100
 *   node scripts/nsdsh/benchmark.mjs --fixture --chapters 1000 --json
 *
 * 退出码：0 = 跑完并给出报告；1 = 运行错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIsolatedEnv } from './lib/isolate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 硬件与计时边界 —— 没有这些，性能数字不可比较。 */
export function hardwareProfile() {
  const cpus = os.cpus() || [];
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu_model: cpus.length ? String(cpus[0].model || '').trim() : '(unknown)',
    cpu_count: cpus.length,
    total_mem_mb: Math.round(os.totalmem() / (1024 * 1024)),
    free_mem_mb: Math.round(os.freemem() / (1024 * 1024)),
    // Node 的 process.hrtime.bigint 纳秒级；但调度抖动远大于它，故声明"毫秒、含抖动"
    timer: 'process.hrtime.bigint（纳秒精度；报告单位为毫秒，包含调度抖动）',
    note: '单机单进程样本，不代表并发场景；未做磁盘缓存预热，冷/热差异含 OS 页缓存影响。',
  };
}

function ms(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, min: Number(s[0].toFixed(2)), median: Number(med.toFixed(2)), max: Number(s[s.length - 1].toFixed(2)) };
}

/** 建合成夹具：一部作品 + N 章（含正文与摘要），全部在隔离库里。 */
async function buildFixture(db, chapters) {
  const now = new Date().toISOString();
  const t0 = process.hrtime.bigint();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(`bench-${chapters}`, now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  const insChapter = db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < chapters; i += 1) {
    // 用确定性文本：长度随章节增长，模拟真实长篇的规模差异
    const body = `<p>第${i + 1}章 测试正文 `.concat('甲'.repeat(200 + (i % 50)), '</p>');
    insChapter.run(workId, `第${i + 1}章`, body, i, now, now);
  }
  db.exec('COMMIT');
  return { workId, buildMs: ms(t0) };
}

export async function benchmark({ chapters = 100, samples = 5 } = {}) {
  const env = makeIsolatedEnv({ label: `nsdsh-bench-${chapters}-` }).install();
  const tCold = process.hrtime.bigint();
  const { db } = await import('../../db.js');
  const importMs = ms(tCold);

  const fixture = await buildFixture(db, chapters);

  // 预热一次（建立语句缓存），之后才是"热"样本
  const q = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE work_id = ?');
  q.get(fixture.workId);

  const hot = [];
  for (let i = 0; i < samples; i += 1) {
    const t = process.hrtime.bigint();
    q.get(fixture.workId);
    hot.push(ms(t));
  }

  // 缓存未命中：每轮换一个新查询（不同 SQL 文本 → 不共享 prepared statement 缓存）
  const miss = [];
  for (let i = 0; i < samples; i += 1) {
    const t = process.hrtime.bigint();
    db.prepare(`SELECT COUNT(*) AS n FROM chapters WHERE work_id = ? AND position >= ${i}`).get(fixture.workId);
    miss.push(ms(t));
  }

  // 正文读取（大字段）：取一章完整正文
  const bodySamples = [];
  const pick = db.prepare('SELECT content FROM chapters WHERE work_id = ? ORDER BY position DESC LIMIT 1');
  for (let i = 0; i < samples; i += 1) {
    const t = process.hrtime.bigint();
    pick.get(fixture.workId);
    bodySamples.push(ms(t));
  }

  // 库体积：数据目录里所有 .db / -wal / -shm 文件之和（WAL 模式下只看 novel.db 会低估）
  const dbBytes = (() => {
    try {
      const dir = String(process.env.NOVELSTUDIO_DATA_DIR || (env && env.dataDir) || '');
      if (!dir || !fs.existsSync(dir)) return null;
      let total = 0;
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(db|db-wal|db-shm)$/.test(name)) continue;
        total += fs.statSync(path.join(dir, name)).size;
      }
      return total > 0 ? total : null;
    } catch { return null; }
  })();

  const out = {
    version: 'benchmark-v1',
    mode: 'fixture',
    chapters,
    samples,
    hardware: hardwareProfile(),
    timings: {
      import_db_ms: Number(importMs.toFixed(2)),
      build_fixture_ms: Number(fixture.buildMs.toFixed(2)),
      total_ms: Number((importMs + fixture.buildMs).toFixed(2)),
      hot_query: stats(hot),
      cache_miss_query: stats(miss),
      body_read: stats(bodySamples),
    },
    db_bytes: dbBytes,
    boundaries: [
      '单进程、单机、同步 SQLite；不含网络与模型调用',
      '冷/热差异包含 OS 页缓存影响，未做 drop_caches',
      '样本数较少（默认 5），用于量级判断而非精确基准',
    ],
  };
  try { env.cleanup(); } catch { /* 尽力清理 */ }
  return out;
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  if (!has('--fixture')) {
    console.error('拒绝执行：benchmark 只支持 --fixture（不碰作者真实库）');
    process.exit(1);
  }
  const chapters = Number(val('--chapters', '100')) || 100;
  if (!Number.isSafeInteger(chapters) || chapters <= 0 || chapters > 5000) {
    console.error('--chapters 必须是 1..5000 的整数');
    process.exit(1);
  }
  const r = await benchmark({ chapters, samples: Number(val('--samples', '5')) || 5 });
  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`合成夹具性能（${r.chapters} 章，fixture，零计费）`);
    console.log(`  硬件：${r.hardware.cpu_model} ×${r.hardware.cpu_count} / ${r.hardware.total_mem_mb}MB / node ${r.hardware.node} / ${r.hardware.platform}`);
    console.log(`  冷启动：import ${r.timings.import_db_ms}ms + 灌数据 ${r.timings.build_fixture_ms}ms = ${r.timings.total_ms}ms`);
    const f = (t) => `n=${t.n} min ${t.min} / median ${t.median} / max ${t.max} ms`;
    console.log(`  热查询（命中）：${f(r.timings.hot_query)}`);
    console.log(`  新查询（未命中）：${f(r.timings.cache_miss_query)}`);
    console.log(`  正文读取（大字段）：${f(r.timings.body_read)}`);
    if (r.db_bytes) console.log(`  库体积：${(r.db_bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log('  计时边界：');
    for (const b of r.boundaries) console.log('    - ' + b);
  }
  process.exit(0);
}
