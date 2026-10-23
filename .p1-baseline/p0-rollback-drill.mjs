// P0 的**回退演练**（只读，不动活库）。
//
// 方案 §7 阶段 5 要求"一次历史回退演练"。在作者的真实章节上做真正的回写是有风险的，
// 所以这里演练的是**回退能力本身**，而不是"真的回退一次"：
//   ① 冻结快照里的正文与活库当前正文是否一致（快照是不是那一刻的真值）；
//   ② 该章是否存在可回退的历史版本（采纳事务写进去的那一条）；
//   ③ 把快照**复制到临时目录**再打开，确认能读回同一份正文（证明"能用"，不只是"存在"）。
// 任一条不成立 → 非零退出：那意味着"可回退"只是文档上的说法。
//
// 用法：node .p1-baseline/p0-rollback-drill.mjs [--snapshot=<dir>] [--chapter=119]
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const i = a.indexOf('=');
  return i === -1 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
}));
const chapterId = Number(args.chapter) || 119;
const dirArg = String(args.snapshot || '');
const snapshotDir = dirArg
  ? resolve(dirArg)
  : resolve('data', (readdirSync('data').filter((n) => n.startsWith('backup-p0-merge-guard-')).sort().pop()) || '');
if (!snapshotDir || !existsSync(snapshotDir)) {
  console.error(`✗ 找不到冻结快照目录（--snapshot=<dir>）：${snapshotDir || '(空)'}`);
  process.exit(2);
}
const snapDb = join(snapshotDir, 'novel.db.snapshot');
if (!existsSync(snapDb)) {
  console.error(`✗ 快照里没有 novel.db.snapshot：${snapDb}`);
  process.exit(2);
}

const SHA = (s) => createHash('sha256').update(String(s == null ? '' : s)).digest('hex').slice(0, 16);
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

const open = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    row: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    close: () => db.close(),
  };
};

console.log(`P0 回退演练（只读）：章节 #${chapterId}，快照 ${snapshotDir}`);

const live = open(join('data', 'novel.db'));
const snap = open(snapDb);

// ① 快照与活库的正文一致性
{
  const a = live.row('SELECT id, content, updated_at FROM chapters WHERE id = ?', chapterId);
  const b = snap.row('SELECT id, content, updated_at FROM chapters WHERE id = ?', chapterId);
  ok('RD-01 冻结快照里确有这一章（不是空目录）', Boolean(b && b.id === chapterId));
  if (a && b) {
    const same = hashOf(a.content) === hashOf(b.content);
    ok('RD-02 快照正文与活库当前正文一致（快照就是那一刻的真值）', same, `live=${hashOf(a.content)} snap=${hashOf(b.content)}`);
    ok('RD-03 快照记录的字数与活库一致（不是被截断的副本）', String(a.content || '').length === String(b.content || '').length,
      `${String(a.content || '').length} vs ${String(b.content || '').length}`);
  } else {
    ok('RD-02 快照正文与活库当前正文一致', false, '有一边缺这一章');
  }
}

// ② 可回退的历史版本
{
  const versions = snap.all('SELECT id, length(content) AS len, kind, created_at FROM chapter_save_versions WHERE chapter_id = ? ORDER BY id DESC', chapterId);
  ok('RD-04 快照里存在可回退的历史版本（采纳事务会把旧稿写进历史版本）', versions.length > 0, `versions=${versions.length}`);
  const newest = versions[0] || null;
  ok('RD-05 最新历史版本非空（"可回退"不是指向一条空记录）', Boolean(newest && Number(newest.len) > 0),
    JSON.stringify(newest));
}

// ③ 把快照复制到临时目录再打开：证明"能用"，而不只是"存在"
{
  const tmp = mkdtempSync(join(tmpdir(), 'p0-drill-'));
  try {
    const copy = join(tmp, 'novel.db');
    copyFileSync(snapDb, copy);
    const restored = open(copy);
    const r = restored.row('SELECT id, content, title FROM chapters WHERE id = ?', chapterId);
    const s0 = snap.row('SELECT content FROM chapters WHERE id = ?', chapterId);
    ok('RD-06 复制出来的快照能打开并读回同一份正文（回退可用，不只是文件存在）',
      Boolean(r && s0 && hashOf(r.content) === hashOf(s0.content))
        && statSync(copy).size === statSync(snapDb).size,
      JSON.stringify({ bytes: statSync(copy).size, title: r && r.title }));
    restored.close();
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

function hashOf(text) {
  return SHA(text);
}

live.close();
snap.close();

console.log(`\n回退演练：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
