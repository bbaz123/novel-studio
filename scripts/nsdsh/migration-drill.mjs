#!/usr/bin/env node
/**
 * scripts/nsdsh/migration-drill.mjs —— S16：迁移演练与灰度（旧库 → 新 schema）。
 *
 * 为什么要有"演练"而不只是"幂等测试"：幂等测试证明的是"重复启动不出错"，
 * 但**升级一台已有旧库的机器**是另一回事 —— 它要回答：
 *   ① 旧库里的数据还在吗（不是"表建出来了"）；
 *   ② schema 真的前进了吗（`schema_migrations` 账本 + 新表）；
 *   ③ 再跑一次还是同一个结果吗（幂等）；
 *   ④ 出问题时**怎么退回去**（回滚产物 + 可执行步骤）；
 *   ⑤ 灰度怎么做（先演练副本，再切换）。
 *
 * 本脚本只操作**副本**（`.p1-baseline/data/novel.db`），绝不碰作者真实 `data/`。
 *
 * 用法：
 *   node scripts/nsdsh/migration-drill.mjs            # 演练并打印步骤
 *   node scripts/nsdsh/migration-drill.mjs --json
 *
 * 退出码：0 = 演练全部成立；1 = 有失败（门禁应据此判红）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OLD_DB = path.join(REPO, '.p1-baseline', 'data', 'novel.db');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
}

/** 纯函数：在给定目录里对**副本**做一次完整演练。 */
export function drill({ oldDbPath = OLD_DB } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-migration-drill-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(oldDbPath)) {
    return { ok: false, checks: [{ name: '旧库副本存在', ok: false, detail: oldDbPath }], root };
  }
  const copyPath = path.join(dataDir, 'novel.db');
  fs.copyFileSync(oldDbPath, copyPath);
  const beforeHash = sha256File(copyPath);

  // ① 迁移前：旧库的规模（表数 / 账本是否存在）
  let oldTables = [];
  {
    const db = new DatabaseSync(copyPath, { readOnly: true });
    oldTables = tableNames(db);
    db.close();
  }
  add('旧库副本可只读打开', oldTables.length > 0, `${oldTables.length} 张表`);
  const ledgerBefore = oldTables.includes('schema_migrations');

  // ② 跑一次迁移（真实启动路径：import db.js）
  const runMigrate = () => execFileSync(process.execPath, ['-e', "import('./db.js').then(()=>process.exit(0)).catch((e)=>{console.error('MIGRATE_FAIL '+e.message);process.exit(3)})"], {
    cwd: REPO,
    env: { ...process.env, NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let migrateOk = true;
  let migrateErr = '';
  try { runMigrate(); } catch (e) { migrateOk = false; migrateErr = String(e.stderr || e.message); }
  add('第一次迁移成功（exit 0）', migrateOk, migrateOk ? '' : migrateErr.split('\n').pop());

  // ③ 迁移后：schema 前进 + 数据仍在
  let afterTables = [];
  let ledgerRows = 0;
  let worksRows = 0;
  let chaptersRows = 0;
  {
    const db = new DatabaseSync(copyPath);
    afterTables = tableNames(db);
    try { ledgerRows = Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n); } catch { ledgerRows = 0; }
    try { worksRows = Number(db.prepare('SELECT COUNT(*) AS n FROM works').get().n); } catch { worksRows = 0; }
    try { chaptersRows = Number(db.prepare('SELECT COUNT(*) AS n FROM chapters').get().n); } catch { chaptersRows = 0; }
    db.close();
  }
  const added = afterTables.filter((t) => !oldTables.includes(t));
  add('schema 前进：新增了表', added.length > 0, `新增 ${added.length} 张：${added.slice(0, 5).join(',')}${added.length > 5 ? '…' : ''}`);
  add('迁移账本已建立并记账', afterTables.includes('schema_migrations') && ledgerRows > 0,
    `ledgerBefore=${ledgerBefore} ledgerRows=${ledgerRows}`);
  add('旧数据仍在（works / chapters 行数 > 0）', worksRows > 0 && chaptersRows > 0, `works=${worksRows} chapters=${chaptersRows}`);

  // ④ 幂等：再跑一次，schema 与账本不得变化
  const hashAfterFirst = sha256File(copyPath);
  let secondOk = true;
  try { runMigrate(); } catch (e) { secondOk = false; }
  let secondLedger = 0;
  let secondTables = [];
  {
    const db = new DatabaseSync(copyPath);
    secondTables = tableNames(db);
    try { secondLedger = Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n); } catch { secondLedger = 0; }
    db.close();
  }
  add('第二次迁移成功（幂等）', secondOk);
  add('账本行数不变（不重复记账）', secondLedger === ledgerRows, `${ledgerRows} → ${secondLedger}`);
  add('表集合不变（不重复建表/不漂移）', secondTables.length === afterTables.length,
    `${afterTables.length} → ${secondTables.length}`);
  add('迁移后的库文件可再次打开（不是损坏的）', secondTables.length > 0);

  // ⑤ 回滚产物：迁移前的逐字节副本 + 摘要 + 可执行步骤
  const backupPath = path.join(root, 'novel.db.before-migration');
  fs.copyFileSync(oldDbPath, backupPath);
  const rollback = {
    backup: backupPath,
    backup_sha256: beforeHash,
    steps: [
      `停止服务（避免迁移中的写入）`,
      `把 ${copyPath} 替换为备份：${backupPath}`,
      `校验 sha256 等于 ${beforeHash.slice(0, 16)}…`,
      `启动服务并确认 schema_migrations 行数回到迁移前（ledgerBefore=${ledgerBefore}）`,
    ],
  };
  add('回滚产物可生成（备份 + 摘要 + 步骤）', fs.existsSync(backupPath) && !!rollback.backup_sha256 && rollback.steps.length >= 3);

  // ⑥ 灰度计划：先演练副本、再切换、再观察
  const grayscale = [
    { phase: 1, name: '副本演练', done: migrateOk && secondOk, detail: '在旧库副本上跑两次迁移并核对账本/数据' },
    { phase: 2, name: '校验报告', done: checks.every((c) => c.ok), detail: '所有演练检查通过后才允许切换' },
    { phase: 3, name: '切换前备份', done: fs.existsSync(backupPath), detail: '保留迁移前逐字节副本' },
    { phase: 4, name: '切换后观察', done: false, detail: '需真实服务启动并观察（本脚本不做，标为未执行）' },
  ];
  add('灰度计划含未执行项（不假装已切换）', grayscale.some((g) => !g.done), '第 4 阶段需真实服务，脚本不代做');

  return {
    ok: checks.every((c) => c.ok),
    checks,
    drill: {
      root,
      data_dir: dataDir,
      old_tables: oldTables.length,
      new_tables_added: added.length,
      ledger_before: ledgerBefore,
      ledger_rows: ledgerRows,
      works_rows: worksRows,
      chapters_rows: chaptersRows,
      before_sha256: beforeHash,
      after_first_sha256: hashAfterFirst,
    },
    rollback,
    grayscale,
  };
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  const r = drill();
  if (has('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log('迁移演练（旧库副本 → 新 schema，零计费）');
    for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (r.drill) console.log(`  规模：旧 ${r.drill.old_tables} 表 → 新增 ${r.drill.new_tables_added} 表；账本 ${r.drill.ledger_rows} 条；works=${r.drill.works_rows} chapters=${r.drill.chapters_rows}`);
    if (r.rollback) {
      console.log('  回滚步骤：');
      for (const s of r.rollback.steps) console.log('    - ' + s);
    }
    if (r.grayscale) {
      console.log('  灰度：');
      for (const g of r.grayscale) console.log(`    ${g.done ? '✓' : '·'} 阶段${g.phase} ${g.name} — ${g.detail}`);
    }
  }
  process.exit(r.ok ? 0 : 1);
}
