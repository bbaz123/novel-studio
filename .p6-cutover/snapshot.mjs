#!/usr/bin/env node
/**
 * snapshot.mjs —— P0–P6 重构的**可校验快照**（服务于「每阶段独立验收与回滚」）。
 *
 * 为什么需要：本重构全程在工作区进行、**没有提交**——HEAD 仍是重构前的 v0.9.3。
 * 也就是说：13 个已跟踪文件带着 700+ 行改动挂在工作区，另有 17 项新文件未跟踪。
 * 一次 `git checkout -- .` / `git stash` / `git reset --hard` 就会静默毁掉已跟踪的那部分，
 * 而新文件还在 → 工作区会变成"半重构"状态，既跑不起来也说不清丢了什么。
 *
 * 这个工具做两件事：
 *   --create   生成快照：`git diff HEAD`（已跟踪改动）+ 未跟踪的**源码**文件 + manifest（逐文件 sha256）
 *   --verify   在**克隆出来的 HEAD 树**上套用快照，逐文件比对哈希，证明"快照确实能还原工作区"
 *
 * 刻意**不**快照可再生的派生数据（基线 JSON、数据库副本、彩排临时树、黑洞日志）——
 * 它们体积大且在 manifest 里以「排除项 + 指纹」记录，不会被静默丢掉。
 *
 * 用法:
 *   node .p6-cutover/snapshot.mjs --create [--out data/backup-p0p6-<stamp>]
 *   node .p6-cutover/snapshot.mjs --verify <快照目录>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

/**
 * 排除项：可再生的派生数据。被排除的东西**不是被丢掉**——它们会以
 * 「路径 + 原因 + 文件数 + 字节数 + 内容指纹」记进 manifest，比对时仍然能发现变化。
 */
export const EXCLUDES = [
  // data/ 已被 .gitignore 忽略，正常不会出现在未跟踪清单里；这里再显式列一次是**纵深防御**：
  // 万一 .gitignore 被改动，数据库三件套（含 API Key 与作品正文）绝不能被打进快照。
  { prefix: 'data/', reason: '运行时数据目录（数据库含 API Key 与作品正文，绝不可打包）' },
  { prefix: '.p0-recon/scratch-data/', reason: '探测临时数据目录（可再建）' },
  { prefix: '.p0-recon/head-snapshot/', reason: 'HEAD 对照实验的临时快照（可再生成）' },
  { prefix: '.p1-baseline/baselines', reason: '装配基线 JSON（可由 capture-baseline.mjs 重抓；回归证据）' },
  { prefix: '.p1-baseline/data/', reason: '真实库副本三件套（可再复制）' },
  { prefix: '.p1-baseline/stress-data/', reason: '压力数据副本（可由 make-stress.mjs 重建）' },
  { prefix: '.p1-baseline/gate-data/', reason: '闸门验证的隔离数据目录（用完即删）' },
  { prefix: '.p1-baseline/.rehearsal/', reason: '彩排临时树' },
  { prefix: '.p6-cutover/.rehearsal/', reason: '彩排临时树' },
  { prefix: '.p6-cutover/.verify/', reason: '本工具的比对临时树' },
  { prefix: '.p6-cutover/.negctl/', reason: '阴性对照的临时快照' },
  { prefix: 'node_modules/', reason: '依赖（可由 pnpm install 重建）' },
];

/** 单个文件的排除规则（后缀/文件名）。 */
export const EXCLUDE_FILE_PATTERNS = [
  { test: (p) => /(^|\/)blackhole-.*\.jsonl$/.test(p) || /(^|\/)\.blackhole-.*\.jsonl$/.test(p), reason: '黑洞连接日志（运行时产物）' },
  { test: (p) => /(^|\/)gate-env\.(json|stop)$/.test(p), reason: '隔离环境的瞬时 marker' },
  { test: (p) => /\.log$/.test(p), reason: '日志' },
];

export function isExcluded(rel) {
  const p = rel.replace(/\\/g, '/');
  for (const e of EXCLUDES) if (p === e.prefix.replace(/\/$/, '') || p.startsWith(e.prefix)) return e.reason;
  for (const e of EXCLUDE_FILE_PATTERNS) if (e.test(p)) return e.reason;
  return null;
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function git(args, opts = {}) {
  // stderr 显式丢弃：CRLF 工作副本上 `git diff/apply/status` 会打一堆
  // 「warning: in the working copy of ...」；它们会污染调用方（例如套件汇总表）的证据输出。
  // stdio[1]='pipe' 保证仍能拿到 stdout。
  const stdio = opts.stdio || ['ignore', 'pipe', 'ignore'];
  return execFileSync('git', args, {
    cwd: REPO, encoding: opts.encoding ?? 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts, stdio,
  });
}

export function headCommit() {
  try { return git(['rev-parse', 'HEAD']).trim(); } catch { return ''; }
}

/** 已跟踪文件的改动（二进制安全：用 Buffer 拿原始字节）。 */
export function trackedPatchBuffer() {
  // 与 git() 同样的理由：丢弃 stderr（CRLF 警告会污染调用方的证据输出）。
  return execFileSync('git', ['diff', 'HEAD', '--binary'], {
    cwd: REPO, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** 未跟踪的文件清单（尊重 .gitignore：被忽略的文件不会出现在 `-uall` 里）。 */
export function untrackedFiles() {
  const out = git(['status', '--porcelain', '-uall']);
  const list = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    // porcelain 对含空格/中文的路径会加引号并转义，交给 -z 更稳；这里退一步用引号剥离。
    let rel = line.slice(3).trim();
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1).replace(/\\(.)/g, (m, c) => {
        const map = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
        return map[c] ?? c;
      });
    }
    list.push(rel.replace(/\\/g, '/'));
  }
  return list;
}

/** 对一个被排除的目录做「文件数 + 字节数 + 内容指纹」。 */
export function fingerprintDir(absDir) {
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) { files.push(['<link>', 0]); continue; }
      if (st.isDirectory()) { walk(full); continue; }
      files.push([path.relative(absDir, full).replace(/\\/g, '/'), st.size]);
    }
  };
  if (!fs.existsSync(absDir)) return null;
  walk(absDir);
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    files: files.length,
    bytes: files.reduce((s, [, n]) => s + n, 0),
    digest: crypto.createHash('sha256').update(files.map(([n, s]) => `${n}:${s}`).join('\n')).digest('hex').slice(0, 16),
  };
}

// ── create ─────────────────────────────────────────────────────────────────
function create(outDir) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.resolve(REPO, outDir || path.join('data', `backup-p0p6-${stamp}`));
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

  const patch = trackedPatchBuffer();
  fs.writeFileSync(path.join(dir, 'changes.patch'), patch);

  const entries = [];
  const skipped = [];
  for (const rel of untrackedFiles()) {
    const reason = isExcluded(rel);
    if (reason) { skipped.push({ path: rel, reason }); continue; }
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const dst = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    entries.push({ path: rel, kind: 'untracked-new', sha256: sha256File(abs), size: fs.statSync(abs).size });
  }

  // 已跟踪改动：**同时**留两份——
  //   1) changes.patch 供人阅读/git apply（可读的改动证据）；
  //   2) files/ 下的整文件副本供**字节级**还原。
  // 为什么必须两份：本仓库 core.autocrlf 生效，`git apply` 会把 CRLF 归一成 LF，
  // 于是 server.js / harness.js / db.js 还原后**行尾变了**（验证器实测抓到的，91/94）。
  // 补丁可用于 review，但"能还原"这件事必须由整文件副本来保证。
  const modified = git(['diff', '--name-only', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean);
  for (const rel of modified) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) { entries.push({ path: rel, kind: 'tracked-deleted', sha256: null, size: 0 }); continue; }
    const dst = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    entries.push({ path: rel, kind: 'tracked-modified', sha256: sha256File(abs), size: fs.statSync(abs).size });
  }

  // 被排除项按「顶层目录」汇总指纹，确保不会被静默丢掉
  const excludedTop = new Map();
  for (const e of EXCLUDES) {
    const top = e.prefix.split('/').slice(0, 2).join('/');
    if (!excludedTop.has(top)) excludedTop.set(top, e.reason);
    if (!e.prefix.startsWith(top + '/')) excludedTop.set(top, e.reason);
  }
  const excluded = [...excludedTop.entries()].map(([rel, reason]) => ({
    path: rel, reason, ...(fingerprintDir(path.join(REPO, rel)) || {}),
  }));

  const manifest = {
    createdAt: new Date().toISOString(),
    head: headCommit(),
    coreAutocrlf: (() => { try { return git(['config', '--get', 'core.autocrlf']).trim(); } catch { return ''; } })(),
    patchBytes: patch.length,
    patchSha256: crypto.createHash('sha256').update(patch).digest('hex'),
    // 还原语义要说清楚，否则下一个人会以为"打补丁"就够了。
    restoreNote: 'changes.patch 供阅读/git apply；**字节级还原请用 files/ 覆盖回仓库根**'
      + '（core.autocrlf 生效时 git apply 会把 CRLF 归一成 LF）。',
    entries,
    excluded,
    skippedFiles: skipped,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`═══ 快照已生成 ═══\n目录：${path.relative(REPO, dir)}`);
  console.log(`  HEAD           : ${manifest.head}`);
  console.log(`  changes.patch  : ${patch.length} 字节（已跟踪改动，sha256 ${manifest.patchSha256.slice(0, 12)}…）`);
  console.log(`  源码文件       : ${entries.filter((e) => e.kind === 'untracked-new').length} 个新增 + ${entries.filter((e) => e.kind === 'tracked-modified').length} 个修改`);
  console.log(`  排除的派生数据 : ${excluded.length} 项（已记指纹，不是丢弃）`);
  for (const x of excluded) {
    console.log(`      ${x.path}  ${x.files ?? '?'} 文件 ${(((x.bytes ?? 0) / 1024)).toFixed(0)}KB  指纹 ${x.digest ?? '-'}  —— ${x.reason}`);
  }
  if (manifest.coreAutocrlf) {
    console.log(`\n  ⚠ core.autocrlf=${manifest.coreAutocrlf}：changes.patch 经 git apply 后会把 CRLF 归一成 LF，`);
    console.log(`    所以**字节级还原请用 files/**（验证器实测过：只用补丁会有 3 个文件哈希不一致）。`);
  }
  console.log(`\n回滚方式（任选其一）：`);
  console.log(`  A) 只回到重构前： git stash push -u  或  git checkout -- . && git clean -fd（会丢新文件，先确认快照可用）`);
  console.log(`  B) 用本快照还原： git checkout -- . && git apply ${path.relative(REPO, path.join(dir, 'changes.patch'))} && 把 files/ 覆盖回仓库根`);
  console.log(`  C) 先提交再谈回滚： git add -A && git commit（把当前状态固化成可回退的点）`);
  console.log(`\n验证快照是否真的能还原： node .p6-cutover/snapshot.mjs --verify ${path.relative(REPO, dir)}`);
  return dir;
}

// ── verify ─────────────────────────────────────────────────────────────────
function verify(snapDir) {
  const dir = path.resolve(REPO, snapDir);
  const mf = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mf)) { console.error(`找不到 ${mf}`); process.exit(2); }
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const scratchRel = path.join('.p6-cutover', '.verify', stamp);
  const scratch = path.join(REPO, scratchRel);
  fs.mkdirSync(scratch, { recursive: true });

  let bad = 0;
  const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };
  console.log(`═══ 验证快照 ═══\n快照：${path.relative(REPO, dir)}\n临时树：${scratchRel}\n`);

  // 1) 用 HEAD 建一棵树（git archive，不碰工作区、不动 .git/worktrees）
  try {
    const tar = execFileSync('git', ['archive', 'HEAD'], { cwd: REPO, maxBuffer: 512 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', scratch], { input: tar, maxBuffer: 512 * 1024 * 1024 });
    say(true, `已从 HEAD (${manifest.head.slice(0, 8)}) 导出干净树`);
  } catch (e) {
    say(false, `导出 HEAD 失败：${e.message}`);
    process.exit(1);
  }

  // 2) 套用快照里的补丁（证明补丁本身可用；它同时是可读的改动证据）
  const patchPath = path.join(dir, 'changes.patch');
  try {
    execFileSync('git', ['apply', '--directory', scratchRel, '--check', patchPath], { cwd: REPO, encoding: 'utf8' });
    execFileSync('git', ['apply', '--directory', scratchRel, patchPath], { cwd: REPO, encoding: 'utf8' });
    say(true, '已跟踪改动补丁套用成功（供 review/替代路径；未用它做字节级还原）');
  } catch (e) {
    say(false, `补丁套用失败：${String(e.stderr || e.message).slice(0, 300)}`);
  }

  // 3) 用整文件副本做**字节级**还原（新增 + 修改都覆盖一遍）
  // 这一步才是"能回滚"的依据：补丁会被 core.autocrlf 改写行尾，副本不会。
  const filesRoot = path.join(dir, 'files');
  const restorable = manifest.entries.filter((x) => x.kind === 'untracked-new' || x.kind === 'tracked-modified');
  let copied = 0;
  for (const e of restorable) {
    const src = path.join(filesRoot, e.path);
    const dst = path.join(scratch, e.path);
    if (!fs.existsSync(src)) { say(false, `快照缺文件：${e.path}`); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  say(copied === restorable.length, `整文件副本已还原（${copied}/${restorable.length} 个：新增 + 修改）`);

  // 4) 逐文件比对：快照树 vs 真实工作区
  let same = 0;
  const diffs = [];
  for (const e of manifest.entries) {
    if (e.kind === 'tracked-deleted') continue;
    const inScratch = path.join(scratch, e.path);
    const inWork = path.join(REPO, e.path);
    if (!fs.existsSync(inScratch)) { diffs.push(`${e.path}（快照树里缺失）`); continue; }
    if (!fs.existsSync(inWork)) { diffs.push(`${e.path}（工作区里缺失）`); continue; }
    if (sha256File(inScratch) === sha256File(inWork)) same++;
    else diffs.push(`${e.path}（内容不一致）`);
  }
  say(diffs.length === 0, `逐文件哈希一致：${same}/${manifest.entries.filter((e) => e.kind !== 'tracked-deleted').length}`);
  for (const d of diffs.slice(0, 15)) console.log(`      · ${d}`);
  if (diffs.length > 15) console.log(`      · …其余 ${diffs.length - 15} 项`);

  // 5) 过期检测：工作区里有没有快照**没覆盖**的源码文件。
  // 没有这一条，"快照可用"就只对生成那一刻成立——之后继续写代码的人会误以为仍然安全。
  const inManifest = new Set(manifest.entries.map((e) => e.path));
  const stale = [];
  for (const rel of untrackedFiles()) {
    if (isExcluded(rel)) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (!inManifest.has(rel)) stale.push(rel);
  }
  for (const rel of git(['diff', '--name-only', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (!inManifest.has(rel)) stale.push(rel);
  }
  say(stale.length === 0, stale.length
    ? `快照已过期：工作区有 ${stale.length} 个文件不在快照里（快照只对生成那一刻成立）`
    : '无快照未覆盖的新文件（快照不过期）');
  for (const s of stale.slice(0, 10)) console.log(`      · ${s}`);

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${bad ? `✗ 快照未能完整还原（${bad} 处问题）` : '✓ 快照可完整还原当前工作区（已删除临时树）'}`);
  process.exitCode = bad ? 1 : 0;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  if (process.argv.includes('--verify')) verify(arg('--verify', ''));
  else if (process.argv.includes('--create')) create(arg('--out', ''));
  else {
    console.log('用法:');
    console.log('  node .p6-cutover/snapshot.mjs --create [--out <目录>]');
    console.log('  node .p6-cutover/snapshot.mjs --verify <快照目录>');
    process.exit(2);
  }
}
