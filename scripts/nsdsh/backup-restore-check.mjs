#!/usr/bin/env node
/**
 * nsdsh/backup-restore-check.mjs —— 备份/恢复演练：证明"备份能恢复，而且比对真的能发现篡改"（S01）。
 *
 * 为什么要有这条演练：方案稿 G1–G4 全押在"作者正文不会丢"上，而备份方案只有在**被演练过**
 * 之后才算存在。一个只会说"相等"的比对器等于没有比对器——所以本文件强制跑**阴性对照**：
 * 故意篡改一份副本，如果比对器还说"相等"，那它就是在自证无用。
 *
 * 三条纪律：
 *   1. **只碰临时库**。它自己建 `makeIsolatedEnv()`，并在建库前拒绝任何指向真实 `data/` 的
 *      数据目录 —— 作者的真实库 data/novel.db 在任何路径上都不该被这个脚本读写。
 *   2. **用项目自己的 schema**：动态 import `db.js`（在 install() 之后，顺序不能反），
 *      不手写 CREATE TABLE。手写的那份迟早与 db.js 漂移，演练就变成演另一套东西。
 *   3. **恢复要一致**：用 `VACUUM INTO` 而不是复制文件。WAL 模式下直接复制 `.db` 会得到
 *      一个"少了最近若干次提交"的库，而它看起来完全正常——这正是备份演练最容易漏掉的坑。
 *
 * 用法:
 *   node scripts/nsdsh/backup-restore-check.mjs --fixture [--json]
 * 退出码：0 = 全部通过；1 = 有失败；2 = 用法错误 / 拒绝执行。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeIsolatedEnv, REPO } from './lib/isolate.mjs';

/** 真正参与内容比对的表（种子只写这几张；行数覆盖全部表）。 */
export const SEEDED_TABLES = ['works', 'chapters', 'story_chapter_revisions'];

/**
 * 拒绝条件：数据目录指向真实库，或不在**合法临时根**之下。返回原因或 null。
 *
 * 合法临时根有两个候选，必须都认：
 *   · `os.tmpdir()` —— 系统临时目录；
 *   · `NSDSH_ISOLATED_ROOT` —— 隔离夹具给自己的那份根。
 * 第二个不能省：`makeIsolatedEnv().install()` 会把 TMPDIR/TEMP/TMP 一并指到隔离根内的 tmp/，
 * 于是一旦在 install() **之后**再调 `os.tmpdir()`，它返回的已经是隔离根内部的路径，
 * 而数据目录反而不在其中 —— 只认第一个候选会把合法隔离环境误判成"越界"（实测踩到）。
 */
export function refuseReason(dataDir, isolatedRoot = process.env.NSDSH_ISOLATED_ROOT) {
  if (!dataDir) return 'NOVELSTUDIO_DATA_DIR 未设置（本脚本只允许在临时库上运行）';
  const d = path.resolve(String(dataDir)).toLowerCase();
  const real = path.resolve(REPO, 'data').toLowerCase();
  if (d === real) return `拒绝在作者真实库上运行：${path.join(REPO, 'data')}`;
  const roots = [path.resolve(os.tmpdir())];
  if (isolatedRoot) roots.push(path.resolve(String(isolatedRoot)));
  const inside = roots.some((r) => {
    const rl = r.toLowerCase();
    return d === rl || d.startsWith(rl.endsWith(path.sep) ? rl : rl + path.sep);
  });
  if (!inside) return `拒绝在系统临时目录之外运行：${path.resolve(String(dataDir))}`;
  return null;
}

/** 该库里的用户表（排除 SQLite 内部表）。 */
export function listUserTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => String(r.name));
}

/**
 * 表内容摘指纹。
 *
 * 为什么按主键排序再序列化，而不是直接哈希 rowid 顺序：SQLite 不保证全表扫描顺序，
 * 两次相同的查询可能给出不同顺序，那样"篡改检测"会退化成"顺序检测"（时而报差异）。
 * 这里按 `id` 排序（没有 id 的表退到 rowid），并要求调用方传确定的列集合。
 */
export function tableDigest(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.length) return null;
  const names = cols.map((c) => String(c.name));
  const orderBy = cols.some((c) => String(c.name) === 'id') ? 'id' : 'rowid';
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  const lines = rows.map((r) => names.map((n) => JSON.stringify(r[n] ?? null)).join('\u0001'));
  return {
    rows: rows.length,
    digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
    columns: names.length,
  };
}

/** 全库清单：每张表的行数 + 种子表的内容摘指纹。 */
export function computeManifest(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = listUserTables(db);
    const rowCounts = {};
    for (const t of tables) {
      rowCounts[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    }
    const content = {};
    for (const t of SEEDED_TABLES) {
      if (!tables.includes(t)) continue;
      content[t] = tableDigest(db, t);
    }
    return { path: dbPath, tables: tables.length, rowCounts, content };
  } finally {
    db.close();
  }
}

/** 比较两个清单：只比"种子表的内容摘指纹"与"这些表的行数"。 */
export function compareManifests(a, b) {
  const diffs = [];
  if (a.tables !== b.tables) diffs.push(`表数量不同：${a.tables} vs ${b.tables}`);
  for (const t of Object.keys(a.content || {})) {
    const ca = a.content[t];
    const cb = (b.content || {})[t];
    if (!cb) { diffs.push(`缺少表 ${t} 的内容`); continue; }
    if (ca.digest !== cb.digest) diffs.push(`表 ${t} 内容摘指纹不同（${ca.digest.slice(0, 12)} vs ${cb.digest.slice(0, 12)}）`);
    if (ca.rows !== cb.rows) diffs.push(`表 ${t} 行数不同：${ca.rows} vs ${cb.rows}`);
  }
  for (const [t, n] of Object.entries(a.rowCounts || {})) {
    if ((b.rowCounts || {})[t] !== n) diffs.push(`表 ${t} 行数不同：${n} vs ${(b.rowCounts || {})[t]}`);
  }
  return { equal: diffs.length === 0, diffs };
}

/**
 * 建库 + 播种。
 * `db.js` 必须在 `env.install()` **之后**动态 import：它一 import 就解析数据目录并建库，
 * 顺序反了就会在真实目录里建库（本项目真实发生过这类顺序事故）。
 */
async function buildFixture(dataDir) {
  const dbUrl = pathToFileURL(path.join(REPO, 'db.js')).href;
  const { db, withTransaction } = await import(`${dbUrl}?fixture=${Date.now()}`);

  const seeded = { works: 0, chapters: 0, revisions: 0, revisionError: null };
  let firstChapterId = null;
  withTransaction(() => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO works (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('NSDSH 备份演练作品', '只存在于临时库的合成数据', now, now);
    const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
    seeded.works = 1;
    const wanted = [
      ['第一章 演练开始', '<p>第一章的正文：张三走进了教室，窗外在下雨。</p>'],
      ['第二章 演练继续', '<p>第二章的正文：李四把伞收好，坐到了最后一排。</p>'],
      ['第三章 演练收束', '<p>第三章的正文：雨停了，黑板上的字被擦掉了一半。</p>'],
    ];
    wanted.forEach(([title, content], i) => {
      const r = db.prepare('INSERT INTO chapters (work_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workId, title, content, i, now, now);
      // 用 INSERT 的 lastInsertRowid 而不是再查一次"最大 id"：再查一次在并发/顺序变化下
      // 可能拿到别的行，而这个 id 后面要用来种修订行。
      if (firstChapterId === null) firstChapterId = Number(r.lastInsertRowid);
      seeded.chapters += 1;
    });
    return workId;
  });

  // 修订行：走项目的真实入口（内容寻址、幂等），不手写 INSERT —— 手写的值可能违反表约束，
  // 那样演练的是"我编的 schema"而不是"项目的 schema"。
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  const chapterId = firstChapterId;
  try {
    const temporal = await import(`${pathToFileURL(path.join(REPO, 'ai/story-state/temporal/index.mjs')).href}?fixture=${Date.now()}`);
    const r = temporal.recordRevision({
      workId,
      chapterId,
      contentHtml: '<p>第一章的正文：张三走进了教室，窗外在下雨。</p>',
      origin: { kind: 'fixture', actor: 'nsdsh-backup-check', source: 'backup-restore-check.mjs' },
    });
    seeded.revisions = r && r.revision ? 1 : 0;
  } catch (e) {
    // 时态 API 不可用时如实记录：这一行是"加分项"，但**不许静默**。
    seeded.revisionError = `${e.message}`;
  }

  // 收口 WAL：让主库文件本身包含全部已提交内容。VACUUM INTO 也会自带这一步，
  // 这里显式做一次是为了让"原库"与"备份"的起点都明确（可复核）。
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, seeded, workId, chapterId };
}

/** 用 VACUUM INTO 做一致快照（不是复制文件：WAL 下复制会丢最近的提交）。 */
export function vacuumInto(db, targetPath) {
  // SQLite 不会替我们建目标目录：目录不存在时报 "unable to open database"，
  // 那个报错看起来像权限问题，实际是"父目录没了"。这里显式建出来。
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.rmSync(targetPath, { force: true });
  db.exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
  return targetPath;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--fixture')) {
    console.error('用法: node scripts/nsdsh/backup-restore-check.mjs --fixture [--json]');
    process.exit(2);
  }
  const json = argv.includes('--json');

  // 第一道闸：调用方若已把数据目录指向真实库，直接拒跑（在建任何临时环境之前）。
  const refuse = refuseReason(process.env.NOVELSTUDIO_DATA_DIR);
  if (refuse && process.env.NOVELSTUDIO_DATA_DIR) {
    console.error(`✗ ${refuse}`);
    process.exit(2);
  }

  const env = makeIsolatedEnv({ label: 'nsdsh-backup' });
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  let manifests = null;
  try {
    env.install();
    // 第二道闸：隔离夹具**自己**建出来的目录也必须合法（防御"夹具改坏了"）。
    const refuse2 = refuseReason(process.env.NOVELSTUDIO_DATA_DIR);
    if (refuse2) {
      console.error(`✗ 隔离夹具给出的数据目录不合法：${refuse2}`);
      process.exit(2);
    }

    const originalPath = path.join(env.dataDir, 'novel.db');
    const { db, seeded } = await buildFixture(env.dataDir);
    const backupPath = vacuumInto(db, path.join(env.root, 'backup', 'novel.db'));
    db.close();

    add('用项目自己的 schema 建出临时库', fs.existsSync(originalPath), `${originalPath}`);
    add('种下一部作品', seeded.works === 1, '1 行 works');
    add('种下 >=3 章且正文各不相同', seeded.chapters >= 3, `${seeded.chapters} 章`);
    add('种下至少一条修订/事件行', seeded.revisions > 0,
      seeded.revisions > 0 ? '1 行 story_chapter_revisions（走 recordRevision）' : `未能写入：${seeded.revisionError}`);
    add('备份用 VACUUM INTO 生成（一致快照）', fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0,
      `${backupPath}（${fs.existsSync(backupPath) ? fs.statSync(backupPath).size : 0} 字节）`);

    // 恢复 = 把备份**读到另一个位置**再比对（不是原地复用同一个文件）。
    const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsdsh-restore-'));
    const restorePath = path.join(restoreDir, 'novel.db');
    fs.copyFileSync(backupPath, restorePath);

    const originalManifest = computeManifest(originalPath);
    const backupManifest = computeManifest(backupPath);
    const restoreManifest = computeManifest(restorePath);
    const vsOriginal = compareManifests(originalManifest, restoreManifest);
    const vsBackup = compareManifests(backupManifest, originalManifest);

    add('备份与原始库清单一致', vsBackup.equal, vsBackup.equal ? '行数与内容摘指纹全部相同' : vsBackup.diffs.join('；'));
    add('恢复副本与原始库清单一致', vsOriginal.equal, vsOriginal.diffs.length ? vsOriginal.diffs.join('；') : '行数与内容摘指纹全部相同');

    // 阴性对照：**必须先于结论**跑。一个只会说"相等"的比对器等于没有比对器，
    // 所以这里真的改掉一份副本里的一行，并要求比对器报出差异。
    const tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsdsh-tamper-'));
    const tamperPath = path.join(tamperDir, 'novel.db');
    fs.copyFileSync(backupPath, tamperPath);
    const tamperDb = new DatabaseSync(tamperPath);
    const targetId = Number(tamperDb.prepare('SELECT id FROM chapters ORDER BY id LIMIT 1').get().id);
    const changes = tamperDb.prepare('UPDATE chapters SET content = ? WHERE id = ?').run('<p>被篡改过的正文</p>', targetId).changes;
    tamperDb.close();
    const tamperManifest = computeManifest(tamperPath);
    const negative = compareManifests(originalManifest, tamperManifest);
    add('阴性对照：篡改一份副本后比对必须报差异', negative.equal === false && changes === 1,
      negative.equal ? '篡改后仍报"相等" → 比对器无检测能力' : `改动 ${changes} 行；${negative.diffs.join('；')}`);

    manifests = { original: originalManifest, backup: backupManifest, restore: restoreManifest, tamper: tamperManifest, tamperedChapterId: targetId };
    fs.rmSync(restoreDir, { recursive: true, force: true });
    fs.rmSync(tamperDir, { recursive: true, force: true });
  } catch (e) {
    add('演练整体执行', false, `${e && e.message}`);
  } finally {
    env.cleanup();
  }

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: failed === 0, passed, failed, checks, manifests }, null, 2)}\n`);
  } else {
    for (const c of checks) console.log(`  ${c.passed ? 'ok  ' : 'FAIL'} ${c.name} — ${c.detail}`);
    console.log(`\n通过 ${passed} / 未通过 ${failed}`);
  }
  process.exitCode = failed ? 1 : 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && (invoked === self || invoked.endsWith(path.sep + path.basename(self)))) {
  await main();
}
