#!/usr/bin/env node
/**
 * test-migration-idempotent.mjs —— 任务书 §18「新 migration 在空库、旧库副本、重复启动及中途失败场景下数据与 schema 状态正确」的离线对照（零计费）。
 *
 * 钉四件事：
 *   A. 空库首启：契约声明的 47 张表全部建成（含本批次新增的 12 张）；
 *   B. 重复启动：同一数据目录再次初始化，schema 指纹与数据行数不变（不重建、不丢行）；
 *   C. 旧库副本：只读打开冻结副本，schema 指纹仍等于契约冻结值（旧作品仍可打开）；
 *   D. 损坏库：无法打开的库必须**响亮失败**（非零退出 + 原文件字节不变），不得被静默当成空库重建。
 *
 * 用法: node .p1-baseline/test-migration-idempotent.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/host-contract.v1.json'), 'utf8'));

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

// 子进程探针：在指定数据目录 import db.js（即真实启动路径的建库/迁移），回报 schema 指纹与行数。
const PROBE = [
  "import('./db.js').then((m) => {",
  '  const { db } = m;',
  "  const schema = db.prepare(\"SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY name\").all();",
  "  const crypto = require('node:crypto');",
  "  const sha = crypto.createHash('sha256').update(schema.map((r) => r.name + '::' + (r.sql || '')).join(String.fromCharCode(10))).digest('hex').slice(0, 16);",
  "  const tables = schema.filter((r) => r.type === 'table').map((r) => r.name);",
  "  if (process.env.NOVELSTUDIO_PROBE_INSERT === '1') { db.prepare('INSERT INTO author_samples (work_id, title, text, chars) VALUES (1, ?, ?, ?)').run('迁移幂等探针', '样文正文', 4); }",
  "  const samples = db.prepare('SELECT COUNT(*) AS n FROM author_samples').get().n;",
  '  console.log(JSON.stringify({ fingerprint: sha, tables, samples }));',
  '  process.exit(0);',
  "}).catch((e) => { console.error('PROBE_FAIL ' + e.message); process.exit(3); });",
].join(NL);

const runProbe = (dir, insert) => {
  const out = execFileSync(process.execPath, ['-e', PROBE], {
    cwd: ROOT,
    env: { ...process.env, NOVELSTUDIO_DATA_DIR: dir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_PROBE_INSERT: insert ? '1' : '0' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split(NL).pop());
};

const NEW_TABLES = ['author_approvals', 'adoption_operations', 'projection_outbox', 'ov_projection_audit',
  'author_samples', 'style_profiles', 'author_intents', 'branch_sandboxes', 'branch_candidates',
  'import_rebuild_runs', 'import_rebuild_batches', 'library_docs'];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-migration-'));
let first = null;
try {
  console.log('【A. 空库首启（从零建库）】');
  const dirA = path.join(tmpRoot, 'empty');
  fs.mkdirSync(dirA, { recursive: true });
  first = runProbe(dirA, false);
  const declared = CONTRACT.db.tables;
  const missing = declared.filter((t) => !first.tables.includes(t));
  ok('A1 契约声明的 ' + declared.length + ' 张表全部建成', missing.length === 0, '缺：' + missing.join('、'));
  const missingNew = NEW_TABLES.filter((t) => !first.tables.includes(t));
  ok('A2 本批次新增的 ' + NEW_TABLES.length + ' 张表全部建成', missingNew.length === 0, '缺：' + missingNew.join('、'));
  ok('A3 有 schema 指纹可对账（非空）', /^[0-9a-f]{16}$/.test(first.fingerprint), first.fingerprint);

  console.log('【B. 重复启动（同一数据目录再初始化）】');
  const withRow = runProbe(dirA, true);
  ok('B1 新表可写（author_samples 插入 1 行）', withRow.samples === 1, 'samples=' + withRow.samples);
  const second = runProbe(dirA, false);
  ok('B2 第二次初始化的 schema 指纹与首次一致（不重建、不漂移）', second.fingerprint === first.fingerprint, first.fingerprint + ' → ' + second.fingerprint);
  ok('B3 第二次初始化后数据仍在（行数不变）', second.samples === 1, 'samples=' + second.samples);
  ok('B4 表数量不变（没有把新库当成空库重来）', second.tables.length === first.tables.length, first.tables.length + ' → ' + second.tables.length);

  console.log('【C. 旧库副本（只读）】');
  const oldDb = path.join(ROOT, '.p1-baseline', 'data', 'novel.db');
  if (!fs.existsSync(oldDb)) {
    console.log('  – 旧库副本不存在，跳过（跳过≠通过）：' + oldDb);
  } else {
    const db = new DatabaseSync(oldDb, { readOnly: true });
    const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY name").all();
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha256').update(schema.map((r) => r.name + '::' + (r.sql || '')).join(NL)).digest('hex').slice(0, 16);
    const tables = new Set(schema.filter((r) => r.type === 'table').map((r) => r.name));
    const frozen = CONTRACT.db.frozen_tables || [];
    const missingFrozen = frozen.filter((t) => !tables.has(t));
    ok('C1 旧库只读打开成功（旧作品仍可打开）', tables.size > 0, '表数 ' + tables.size);
    ok('C2 旧库 schema 指纹与契约冻结值一致（' + CONTRACT.db.old_db_schema_sha16_at_freeze + '）', sha === CONTRACT.db.old_db_schema_sha16_at_freeze, '实际 ' + sha);
    ok('C3 契约冻结的表在旧库里都存在', missingFrozen.length === 0, '缺：' + missingFrozen.join('、'));
  }

  console.log('【D. 损坏库（中途失败的阴性对照）】');
  const dirD = path.join(tmpRoot, 'corrupt');
  fs.mkdirSync(dirD, { recursive: true });
  const bad = path.join(dirD, 'novel.db');
  fs.writeFileSync(bad, Buffer.from('this is not a sqlite database — corrupt probe — '.repeat(64), 'utf8'));
  const before = fs.readFileSync(bad);
  let failed = false; let status = 0; let stderr = '';
  try {
    execFileSync(process.execPath, ['-e', PROBE], {
      cwd: ROOT,
      env: { ...process.env, NOVELSTUDIO_DATA_DIR: dirD, NOVELSTUDIO_OV_DISABLED: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { failed = true; status = e.status; stderr = String(e.stderr || ''); }
  const after = fs.readFileSync(bad);
  ok('D1 损坏库必须响亮失败（非零退出）', failed && status !== 0, 'status=' + status);
  ok('D2 失败原因可见（不是静默吞掉）', /PROBE_FAIL|not a database|file is not a database/i.test(stderr), stderr.trim().split(NL).pop() || '(空)');
  ok('D3 失败不篡改原文件（字节不变）', Buffer.compare(before, after) === 0, before.length + ' → ' + after.length + ' 字节');
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* 清理尽力而为 */ }
}

console.log('');
if (fails.length) {
  console.log('迁移幂等离线测试：通过 ' + pass + ' / 失败 ' + fails.length);
  for (const f of fails) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('迁移幂等离线测试：通过 ' + pass + ' / 失败 0');
