/**
 * 时态故事状态测试 · 最小夹具（零依赖，不用任何新测试框架）。
 *
 * 隔离纪律：必须在 import db.js **之前**调用 isolatedDir()（测试文件用动态 import），
 * 保证所有读写只发生在系统临时目录，绝不触碰真实 data/。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function isolatedDir(prefix = 'ns-temporal-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.NOVELSTUDIO_DATA_DIR = dir;
  process.env.NOVELSTUDIO_OV_DISABLED = '1';
  return dir;
}
/** 顺序执行用例；任一失败 → 进程非零退出。 */
export function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) {
    console.log(`---- ${label}\n${(e && e.stack) || e}`);
  }
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}
/** 建一部最小作品：卷 + 章节；返回稳定 id。 */
export function seedWork(db, { title = '测试作品', chapters = 10, withVolume = false } = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO works (title, created_at, updated_at) VALUES (?, ?, ?)').run(title, now, now);
  const workId = Number(db.prepare('SELECT id FROM works ORDER BY id DESC LIMIT 1').get().id);
  let volumeId = null;
  if (withVolume) {
    db.prepare('INSERT INTO volumes (work_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(workId, '卷一', 0, now, now);
    volumeId = Number(db.prepare('SELECT id FROM volumes ORDER BY id DESC LIMIT 1').get().id);
  }
  const ids = [];
  for (let i = 0; i < chapters; i += 1) {
    const title = `第${i + 1}章`;
    db.prepare('INSERT INTO chapters (work_id, volume_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workId, volumeId, title, `<p>${title}</p>`, i, now, now);
    ids.push(Number(db.prepare('SELECT id FROM chapters ORDER BY id DESC LIMIT 1').get().id));
  }
  return { workId, chapterIds: ids, volumeId };
}

/** 异步用例版（analyzeChapter 是 async；语义与 suite 相同）。 */
export async function suiteAsync(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      await fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) {
    console.log(`---- ${label}\n${(e && e.stack) || e}`);
  }
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}
