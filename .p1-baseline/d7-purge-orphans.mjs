#!/usr/bin/env node
/**
 * d7-purge-orphans.mjs —— 决策 D7：清理生产记忆库里的**孤儿作品目录**（先留档，再删除）。
 *
 * 背景：生产记忆库有 185 个作品目录，而数据库里只有 2 部作品（`ov_uri` = 2 与 9）。
 * 其余 183 个是孤儿：数据库里已无对应作品，谁也够不到它们（`ov_uri` 精确寻址），
 * 但占空间、让目录难以判读，也会干扰将来"遍历式"的操作。
 *
 * 安全设计（破坏性操作，按本项目既有纪律）：
 *   1. **默认只干跑**（dry-run）：只生成清单，一个字节都不动；
 *   2. 真正删除需要 `--execute --confirm=<令牌>`，令牌由**本次清单内容**派生
 *      ——不看清清单就拿不到令牌（与 P6 切换器同一套做法）；
 *   3. 删除前后对**活目录**逐文件哈希比对，证明"该留的一个字节没动"；
 *   4. 只删**不在数据库 ov_uri 集合里**的目录，且只删目录、不递归跟随链接。
 *
 * 用法:
 *   node .p1-baseline/d7-purge-orphans.mjs                    # 干跑：生成清单
 *   node .p1-baseline/d7-purge-orphans.mjs --execute --confirm=D7-PURGE-xxxxxxxx
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 取命令行参数，**同时接受 `--x v` 与 `--x=v` 两种写法**。
 *
 * ⚠️ 这条是被自己坑出来的：本工具打印的是 `--confirm=<令牌>`（等号形式），
 * 第一版解析器只认空格形式 → 照着它自己打印的命令跑必然"令牌不匹配"。
 * 同一个坑在 `cutover.mjs` 上已经栽过一次（教训里写着"工具打印的命令必须能被
 * 它自己的解析器读回来"），这次在新工具里又犯了一遍。现在两种都收，并加自检。
 */
export function argFrom(argv, n, d) {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`${n}=`));
  return pref ? pref.slice(n.length + 1) : d;
}
const arg = (n, d) => argFrom(process.argv, n, d);
const EXECUTE = process.argv.includes('--execute');
const CONFIRM = arg('--confirm', '');
const DB = arg('--db', 'data/novel.db');
const STORE = arg('--store', path.resolve('..', 'data', 'viking', 'default', 'user', 'default', 'resources', 'novel-studio'));
const OUT_DIR = arg('--out', path.resolve('.p1-baseline'));

// ── 1. 读数据库：谁是活的作品 ───────────────────────────────────────────────
const db = new DatabaseSync(DB, { readOnly: true });
const works = db.prepare('SELECT id, title, ov_uri FROM works ORDER BY id').all();
db.close();
const liveNames = new Set(works.map((w) => String(w.ov_uri || w.id)));

// ── 2. 枚举目录并分类 ──────────────────────────────────────────────────────
if (!fs.existsSync(STORE)) { console.error(`✗ 记忆库目录不存在：${STORE}`); process.exit(2); }
const entries = fs.readdirSync(STORE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function statDir(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(q).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return { files, bytes };
}

const alive = [], orphan = [];
for (const name of entries) {
  const abs = path.join(STORE, name);
  const st = fs.statSync(abs);
  const rec = { name, ...statDir(abs), mtime: st.mtime.toISOString() };
  (liveNames.has(name) ? alive : orphan).push(rec);
}

// ── 3. 清单落档（先留档） ──────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = {
  createdAt: new Date().toISOString(),
  store: STORE,
  db: DB,
  liveWorks: works.map((w) => ({ id: w.id, title: w.title, ov_uri: w.ov_uri })),
  totals: { dirs: entries.length, alive: alive.length, orphan: orphan.length,
    orphanFiles: orphan.reduce((s, o) => s + o.files, 0),
    orphanBytes: orphan.reduce((s, o) => s + o.bytes, 0) },
  alive, orphan,
};
const manifestPath = path.join(OUT_DIR, `d7-orphan-manifest-${stamp}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

// 令牌由清单内容派生：不看清清单就拿不到。
const token = 'D7-PURGE-' + crypto.createHash('sha256')
  .update(JSON.stringify(manifest.totals) + manifest.orphan.map((o) => o.name).join(',')).digest('hex').slice(0, 8);

console.log('═══ D7 孤儿目录清理（先留档，再删除）═══\n');
console.log(`  记忆库 : ${STORE}`);
console.log(`  数据库 : ${DB}`);
console.log(`  活作品 : ${works.map((w) => `#${w.id}(uri=${w.ov_uri} ${w.title})`).join('　')}\n`);
console.log(`  目录总数 ${manifest.totals.dirs}：**活 ${alive.length}** / **孤儿 ${orphan.length}**`);
console.log(`  孤儿合计 ${manifest.totals.orphanFiles} 个文件、${(manifest.totals.orphanBytes / 1048576).toFixed(1)} MB`);
console.log(`  活目录：${alive.map((a) => `${a.name}(${a.files} 文件)`).join('　')}`);
console.log(`\n  ✓ 清单已留档：${manifestPath}`);

if (!EXECUTE) {
  // 自检：把**将要打印的那条命令**喂回自己的解析器，确认拿得到同一个令牌。
  // 没有这一步，"打印的命令跑不通"会一直藏到使用者照抄它的时候才炸。
  const printed = `--execute --confirm=${token}`;
  const back = argFrom(printed.split(' '), '--confirm', '');
  const spaceBack = argFrom(['--execute', '--confirm', token], '--confirm', '');
  console.log(`\n  自检：打印的等号形式可被自己解析 → ${back === token ? '✓' : `✗（得到 ${back}）`}`);
  console.log(`  自检：空格形式同样可解析 → ${spaceBack === token ? '✓' : `✗（得到 ${spaceBack}）`}`);
  console.log(`\n【干跑】一个字节都没动。确认清单后执行：`);
  console.log(`  node .p1-baseline/d7-purge-orphans.mjs ${printed}`);
  process.exit(back === token && spaceBack === token ? 0 : 1);
}

if (CONFIRM !== token) {
  console.error(`\n✗ 确认令牌不匹配。`);
  console.error(`  本次清单的令牌是：${token}`);
  console.error(`  （令牌由"清单统计 + 孤儿目录名集合"派生——清单一变，令牌就变。）`);
  process.exit(2);
}

// ── 4. 删除前：活目录逐文件哈希 ─────────────────────────────────────────────
function hashTree(dir) {
  const out = {};
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const q = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(q, r);
      else if (e.isFile()) {
        try { out[r] = crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex'); } catch { out[r] = 'unreadable'; }
      }
    }
  };
  walk(dir);
  return out;
}
const before = {};
for (const a of alive) before[a.name] = hashTree(path.join(STORE, a.name));

// ── 5. 删除孤儿 ────────────────────────────────────────────────────────────
let removed = 0, failed = [];
for (const o of orphan) {
  const abs = path.join(STORE, o.name);
  // 双保险：真要删之前再确认它既不是活目录、也仍在孤儿清单里。
  if (liveNames.has(o.name)) { failed.push(`${o.name}（竟然在活名单里，跳过）`); continue; }
  try { fs.rmSync(abs, { recursive: true, force: true }); removed++; }
  catch (e) { failed.push(`${o.name}：${e.message}`); }
}

// ── 6. 删除后：核对 ────────────────────────────────────────────────────────
const after = fs.readdirSync(STORE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const aliveIntact = alive.every((a) => {
  if (!after.includes(a.name)) return false;
  const now = hashTree(path.join(STORE, a.name));
  const beforeKeys = Object.keys(before[a.name]);
  return beforeKeys.length === Object.keys(now).length && beforeKeys.every((k) => before[a.name][k] === now[k]);
});
const leftover = after.filter((n) => !liveNames.has(n));

console.log(`\n═══ 执行结果 ═══`);
console.log(`  已删除 ${removed} / ${orphan.length} 个孤儿目录`);
if (failed.length) { console.log(`  失败 ${failed.length} 个：`); failed.slice(0, 10).forEach((f) => console.log(`    · ${f}`)); }
console.log(`  剩余目录 ${after.length} 个（应为 ${alive.length}）`);
console.log(`  ${aliveIntact ? '✓' : '✗'} 活目录逐文件哈希**未变**（该留的一个字节没动）`);
console.log(`  ${leftover.length === 0 ? '✓' : '✗'} 没有孤儿残留${leftover.length ? `：${leftover.slice(0, 5).join('、')}` : ''}`);

fs.writeFileSync(path.join(OUT_DIR, `d7-purge-result-${stamp}.json`), JSON.stringify({
  at: new Date().toISOString(), removed, failed, remaining: after, aliveIntact, leftover, manifest: manifestPath,
}, null, 2), 'utf8');
console.log(`\n  执行记录：${path.join(OUT_DIR, `d7-purge-result-${stamp}.json`)}`);
process.exitCode = (failed.length || !aliveIntact || leftover.length) ? 1 : 0;
