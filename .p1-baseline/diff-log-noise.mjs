#!/usr/bin/env node
/**
 * diff-log-noise.mjs —— 只读诊断：为什么 app_logs 副本比真实库多？
 *
 * 目的：确认「多出来的行」位于副本（= 隔离事故的噪声），而不是真实库被删除。
 * 判据：
 *   1) 真实库中存在、副本中不存在的 app_logs 行数（= 真实库被删除的行数，应为 0）
 *   2) 副本中存在、真实库中不存在的 app_logs 行数（= 副本噪声，可 > 0）
 *   3) 副本噪声的时间范围与内容特征（是否出自探针/验证脚本）
 *
 * 只读：两个库均以 readonly 打开；不写任何文件（除 stdout）。
 * 陷阱：不要 import 本项目任何模块（db.js/logger.js 会在模块顶层打开真实库）。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const REAL = path.join(REPO, 'data', 'novel.db');
const COPY = process.argv[2] || path.join(HERE, 'data', 'novel.db');

for (const p of [REAL, COPY]) {
  if (!existsSync(p)) {
    console.error(`缺少数据库：${p}`);
    process.exit(2);
  }
}

function openRO(p) {
  return new DatabaseSync(p, { readOnly: true });
}

function rows(db) {
  // id 是自增主键，足以做集合差；ts 用于时间范围描述。
  return db.prepare('SELECT id, ts, layer, level, kind, message FROM app_logs ORDER BY id').all();
}

const real = openRO(REAL);
const copy = openRO(COPY);
const r = rows(real);
const c = rows(copy);

const rIds = new Set(r.map((x) => x.id));
const cIds = new Set(c.map((x) => x.id));

const onlyReal = r.filter((x) => !cIds.has(x.id));
const onlyCopy = c.filter((x) => !rIds.has(x.id));

console.log('═══ app_logs 集合差（按 id） ═══');
console.log(`  真实库 ${r.length} 行 / 副本 ${c.length} 行`);
console.log(`  仅真实库有（= 真实库被删的行）: ${onlyReal.length}`);
console.log(`  仅副本有  （= 副本噪声）      : ${onlyCopy.length}`);

function span(list) {
  if (!list.length) return '（无）';
  return `${list[0].ts} … ${list[list.length - 1].ts}`;
}
console.log(`  真实库时间范围: ${span(r)}`);
console.log(`  副本时间范围  : ${span(c)}`);

if (onlyReal.length) {
  console.log('\n═══ ⚠ 仅真实库有的行（真实库丢失了数据） ═══');
  for (const x of onlyReal.slice(0, 50)) {
    console.log(`  #${x.id} ${x.ts} [${x.layer}/${x.level}/${x.kind}] ${String(x.message || '').slice(0, 160)}`);
  }
  if (onlyReal.length > 50) console.log(`  … 其余 ${onlyReal.length - 50} 行略`);
}

if (onlyCopy.length) {
  console.log('\n═══ 仅副本有的行（噪声来源，用于归因） ═══');
  for (const x of onlyCopy) {
    console.log(`  #${x.id} ${x.ts} [${x.layer}/${x.level}/${x.kind}] ${String(x.message || '').slice(0, 160)}`);
  }
  const idMin = Math.min(...onlyCopy.map((x) => x.id));
  const idMax = Math.max(...onlyCopy.map((x) => x.id));
  console.log(`\n  噪声 id 区间: ${idMin} … ${idMax}`);
  const realMax = r.length ? Math.max(...r.map((x) => x.id)) : 0;
  console.log(`  真实库最大 id: ${realMax}`);
  if (idMin > realMax) {
    console.log('  → 噪声全部大于真实库最大 id：副本在被采样的时刻「后来居上」，是副本自己写入的。');
  } else {
    console.log('  → 噪声与真实库 id 区间重叠，需人工判断（可能两库曾来自同一祖先后被分叉）。');
  }

  // 归因：噪声里是否出现探针/验证脚本特征
  const sig = /(verify-|probe-|diff-real-db|compare-baseline|capture-baseline|harness-gate|make-stress|\.p1-baseline|\.p0-recon)/i;
  const hits = onlyCopy.filter((x) => sig.test(String(x.message || '')));
  console.log(`\n  命中「探针/验证脚本」特征的行: ${hits.length} / ${onlyCopy.length}`);
  for (const x of hits.slice(0, 20)) {
    console.log(`    #${x.id} ${String(x.message || '').slice(0, 160)}`);
  }
}

console.log('\n═══ 结论 ═══');
if (onlyReal.length === 0) {
  console.log('  ✓ 真实库没有任何 app_logs 行在副本中缺失 —— 真实库未被删除数据。');
  console.log('    副本多出的行是副本自身写入的噪声（探针环境隔离不彻底的历史痕迹）。');
  process.exit(0);
} else {
  console.log(`  ✗ 真实库有 ${onlyReal.length} 行在副本中找不到 —— 需要进一步排查真实库是否被写过（删除）。`);
  process.exit(1);
}
