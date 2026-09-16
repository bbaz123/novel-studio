#!/usr/bin/env node
/**
 * install-novel-home.mjs —— 决策 B：为小说工坊的写作任务建立**专用 DSH_HOME**。
 *
 * ── 为什么 ────────────────────────────────────────────────────────────────────
 * dsh 在**每次启动 profile** 时都会重建 `$DSH_HOME/profiles/node_modules` 这一层
 * 宿主包镜像（`packages/boot/app-boot/src/profile.ts` 的 `healProfilesModuleFallback`，
 * 由 `apps/cli/src/profile-boot.ts:99` 调用），并且**安装搬家时会把链接改指过去**。
 * 于是：GUI 跑全局 0.1.5、写作任务跑本地仓库 0.1.1，两者共用 `~/.dsh` 这一层，
 * **谁后启动就把这一层改写成自己那一套**（实测 244 个 junction：197 指仓库 / 47 指全局）。
 *
 * 给写作任务一个独立的 `DSH_HOME`，它就只改写自己那一层 —— 碰撞从"无害化"变成"不可能"。
 * 依据：`resolveDshHome()` 的优先级是 显式配置 → `$DSH_HOME` → `~/.dsh`
 * （`packages/util/home-paths/src/index.ts:87`）。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────────────
 * · **只创建目标目录，从不修改 `~/.dsh`**（执行前后对源做哈希比对，作为证据）；
 * · **默认干跑**；真执行需 `--execute --confirm=<令牌>`，令牌由本次计划内容派生；
 * · 幂等：已存在的文件不会被覆盖（除非内容不同——那时会明确报出来，让你决定）；
 * · `profiles/node_modules` **刻意不迁移**：dsh 首次启动会自建那一层，迁过去反而会把旧指向带过去。
 *
 * 用法:
 *   node .p1-baseline/install-novel-home.mjs                     # 干跑
 *   node .p1-baseline/install-novel-home.mjs --execute --confirm=B-NOVELHOME-xxxxxxxx
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 取参数，同时接受 `--x v` 与 `--x=v`（D7 那次栽过的坑：打印的命令必须能被自己读回来）。 */
export function argFrom(argv, n, d) {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(`${n}=`));
  return pref ? pref.slice(n.length + 1) : d;
}
const arg = (n, d) => argFrom(process.argv, n, d);

const SRC = arg('--from', path.join(os.homedir(), '.dsh'));
const DST = arg('--to', path.join(os.homedir(), '.dsh-novel'));
const OUT_DIR = arg('--out', path.resolve('.p1-baseline'));
const EXECUTE = process.argv.includes('--execute');
const CONFIRM = arg('--confirm', '');

// ── 1. 计划 ─────────────────────────────────────────────────────────────────
const COPY_FILES = [
  ['settings.yaml', 'settings.yaml'],
  ['profiles/novel/package.json', 'profiles/novel/package.json'],
  ['profiles/novel/cordis.yml', 'profiles/novel/cordis.yml'],
  ['profiles/novel/cordis.patch.yml', 'profiles/novel/cordis.patch.yml'],
  ['profiles/novel/pnpm-workspace.yaml', 'profiles/novel/pnpm-workspace.yaml'],
  ['.credentials.yaml', '.credentials.yaml'],
];
// 目录整体复制（@openviking/dsh-memory-plugin 是实体目录，0.2MB）
const COPY_DIRS = [['profiles/novel/node_modules/@openviking']];
// 建 junction（保持与源一致的指向；复制会跟随链接把目标内容抄一份）
const LINKS = [['profiles/novel/node_modules/novel-writing']];

const plan = [];
for (const [rel] of [...COPY_FILES, ...COPY_DIRS]) {
  const s = path.join(SRC, rel);
  if (!fs.existsSync(s)) { plan.push({ rel, kind: 'missing-source' }); continue; }
  const stat = fs.statSync(s);
  plan.push({ rel, kind: stat.isDirectory() ? 'copy-dir' : 'copy-file', bytes: stat.isDirectory() ? dirSize(s) : stat.size });
}
for (const [rel] of LINKS) {
  const s = path.join(SRC, rel);
  const target = fs.existsSync(s) ? realTarget(s) : null;
  plan.push({ rel, kind: target ? 'link' : 'missing-source', target });
}
function dirSize(d) {
  let n = 0;
  const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const q = path.join(x, e.name); if (e.isDirectory()) walk(q); else { try { n += fs.statSync(q).size; } catch { /* 忽略 */ } } } };
  walk(d); return n;
}
function realTarget(p) {
  try { const it = fs.lstatSync(p); if (it.isSymbolicLink()) return fs.readlinkSync(p); } catch { /* 忽略 */ }
  return null;
}
/** 与 dsh 内部一致：junction 用 cmd 建，避免跟随链接复制。 */
function makeJunction(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
}
function hashTree(root) {
  const out = [];
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const q = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { out.push(`${r}\tLINK\t${fs.readlinkSync(q)}`); continue; }
      if (e.isDirectory()) walk(q, r);
      else { try { out.push(`${r}\t${crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex').slice(0, 16)}`); } catch { out.push(`${r}\tUNREADABLE`); } }
    }
  };
  walk(root);
  return out.join('\n');
}

const missing = plan.filter((p) => p.kind === 'missing-source');
const token = 'B-NOVELHOME-' + crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 8);

console.log('═══ 建立小说工坊的专用 DSH_HOME（决策 B）═══\n');
console.log(`  源（不动）: ${SRC}`);
console.log(`  目标      : ${DST}\n`);
for (const p of plan) {
  const what = p.kind === 'copy-dir' ? `复制目录 ${(p.bytes / 1024).toFixed(0)}KB`
    : p.kind === 'copy-file' ? `复制文件 ${p.bytes}B`
    : p.kind === 'link' ? `junction → ${p.target}`
    : '**源缺失，跳过**';
  console.log(`  ${p.kind === 'missing-source' ? '✗' : '·'} ${p.rel}  —  ${what}`);
}
console.log(`\n  刻意不做：profiles/node_modules —— dsh 首次启动会自建那一层（迁过去反而会把旧指向带过去）`);
if (missing.length) console.log(`  ⚠ 有 ${missing.length} 项源缺失，执行时会被跳过`);

if (!EXECUTE) {
  const printed = `--execute --confirm=${token}`;
  const back = argFrom(printed.split(' '), '--confirm', '');
  const spaceBack = argFrom(['--execute', '--confirm', token], '--confirm', '');
  console.log(`\n  自检：打印的等号形式可被自己解析 → ${back === token ? '✓' : `✗（得到 ${back}）`}`);
  console.log(`  自检：空格形式同样可解析 → ${spaceBack === token ? '✓' : `✗（得到 ${spaceBack}）`}`);
  console.log(`\n【干跑】什么都没动。确认后执行：`);
  console.log(`  node .p1-baseline/install-novel-home.mjs ${printed}`);
  process.exit(back === token && spaceBack === token ? 0 : 1);
}

if (CONFIRM !== token) {
  console.error(`\n✗ 确认令牌不匹配。本次令牌：${token}`);
  process.exit(2);
}

// ── 2. 执行 ─────────────────────────────────────────────────────────────────
const srcBefore = hashTree(SRC);
fs.mkdirSync(DST, { recursive: true });
const done = { copied: 0, linked: 0, existed: 0, skipped: [] };

for (const [from, to] of COPY_FILES) {
  const s = path.join(SRC, from), d = path.join(DST, to);
  if (!fs.existsSync(s)) { done.skipped.push(from); continue; }
  if (fs.existsSync(d)) {
    const same = crypto.createHash('sha256').update(fs.readFileSync(s)).digest('hex')
      === crypto.createHash('sha256').update(fs.readFileSync(d)).digest('hex');
    if (same) { done.existed++; continue; }
    // 内容不同：不覆盖，明确报出来（可能是用户后来改过）
    done.skipped.push(`${to}（已存在且内容不同，**未覆盖**）`);
    continue;
  }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  done.copied++;
}
for (const [rel] of COPY_DIRS) {
  const s = path.join(SRC, rel), d = path.join(DST, rel);
  if (!fs.existsSync(s)) { done.skipped.push(rel); continue; }
  if (fs.existsSync(d)) { done.existed++; continue; }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.cpSync(s, d, { recursive: true });
  done.copied++;
}
for (const [rel] of LINKS) {
  const s = path.join(SRC, rel), d = path.join(DST, rel);
  const target = fs.existsSync(s) ? realTarget(s) : null;
  if (!target) { done.skipped.push(rel); continue; }
  if (fs.existsSync(d)) { done.existed++; continue; }
  makeJunction(d, target);
  done.linked++;
}

// ── 3. 核对 ─────────────────────────────────────────────────────────────────
const srcAfter = hashTree(SRC);
const dstOk = fs.existsSync(path.join(DST, 'settings.yaml'))
  && fs.existsSync(path.join(DST, 'profiles/novel/package.json'))
  && fs.existsSync(path.join(DST, 'profiles/novel/node_modules/novel-writing/package.json'));
const linkOk = (() => { try { return Boolean(realTarget(path.join(DST, 'profiles/novel/node_modules/novel-writing'))); } catch { return false; } })();

console.log(`\n═══ 执行结果 ═══`);
console.log(`  复制 ${done.copied} 项 / 建链接 ${done.linked} 项 / 已存在跳过 ${done.existed} 项`);
if (done.skipped.length) { console.log('  跳过：'); done.skipped.forEach((s) => console.log(`    · ${s}`)); }
console.log(`  ${dstOk ? '✓' : '✗'} 目标结构完整（settings + profile + 插件可解析）`);
console.log(`  ${linkOk ? '✓' : '✗'} novel-writing 是可解析的 junction`);
console.log(`  ${srcBefore === srcAfter ? '✓' : '✗'} **源 ~/.dsh 逐文件哈希未变**（只创建、从未修改）`);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.writeFileSync(path.join(OUT_DIR, `b-novel-home-${stamp}.json`), JSON.stringify({
  at: new Date().toISOString(), src: SRC, dst: DST, plan, done, dstOk, linkOk, srcUnchanged: srcBefore === srcAfter,
}, null, 2), 'utf8');
console.log(`\n  执行记录：${path.join(OUT_DIR, `b-novel-home-${stamp}.json`)}`);
console.log('\n  下一步：设 NOVELSTUDIO_DSH_HOME 指向它（或让默认值生效），再跑隔离实例验收。');
process.exitCode = (dstOk && linkOk && srcBefore === srcAfter) ? 0 : 1;
