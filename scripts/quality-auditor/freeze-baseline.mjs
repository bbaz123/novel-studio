#!/usr/bin/env node
/**
 * freeze-baseline.mjs — 阶段 0：环境冻结与备份。
 *
 * 为什么要有这个脚本而不是临时敲几条 cp：方案要求「记录并锁定当前 commit」、
 * 「复制数据库与即将修改文件」、「生成 rollback manifest」。手工命令做不到
 * **可复现**（下一次执行时路径、时间戳、清单都会漂），也没法在最终报告里
 * 附一份机器可核对的证据。这里把四件事一次做完，并把结果写成 JSON：
 *
 *   1. 冻结环境事实（commit / 分支 / Node / DSH / profile / 工作树 diff hash）
 *   2. 把数据库和全部**目标文件**按原相对路径复制到 data/backup-quality-auditor-<ts>/
 *   3. 对每个备份文件记录 sha256，并在写入后回读校验（backup 可读的机器证据）
 *   4. 生成 rollback-manifest.json（回滚时逐条 restore 即可）
 *
 * 用法：
 *   node scripts/quality-auditor/freeze-baseline.mjs [--label phase0]
 *
 * 输出最后一行是 `BASELINE_JSON <path>`，方便上层解析。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.cwd();
const LABEL = (() => {
  const i = process.argv.indexOf('--label');
  return i >= 0 ? String(process.argv[i + 1] || 'phase0') : 'phase0';
})();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = path.join(ROOT, 'data', `backup-quality-auditor-${stamp}`);
const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

/** 本次实现会修改/新增的目标文件。新增文件不存在时只记录 planned=missing。 */
const TARGET_FILES = [
  'public/app.js',
  'server.js',
  'harness.js',
  'db.js',
  'ai/editing/narrative-review.mjs',
  'ai/editing/review-contract.mjs',
  'scripts/ci-offline-checks.mjs',
  'scripts/test-narrative-repair.mjs',
  'docs/CHANGELOG.md',
  'docs/phase-map.md',
  'public/review-workspace.js',
  'public/styles.css',
  'public/index.html',
  'package.json',
];

/** DSH profile 的目标文件（绝对路径，不在仓库内）。 */
const PROFILE_FILES = [
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh', 'profiles', 'novel', 'cordis.patch.yml'),
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh', 'profiles', 'novel', 'package.json'),
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh-novel', 'profiles', 'novel', 'cordis.patch.yml'),
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.dsh-novel', 'profiles', 'novel', 'package.json'),
];

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function copyOne(absPath, relDest, manifest) {
  if (!fs.existsSync(absPath)) {
    manifest.files.push({ source: absPath, dest: null, planned: 'missing', status: 'absent' });
    return;
  }
  const buf = fs.readFileSync(absPath);
  const dest = relDest ? path.join(BACKUP, relDest) : path.join(BACKUP, 'absolute', path.basename(absPath));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  // 回读校验：只写不读等于没有证据（备份损坏在回滚时才会暴露）。
  const back = fs.readFileSync(dest);
  const ok = sha256(back) === sha256(buf);
  manifest.files.push({
    source: absPath,
    dest,
    sha256: sha256(buf),
    bytes: buf.length,
    readback: ok ? 'ok' : 'MISMATCH',
    status: ok ? 'backed_up' : 'failed',
  });
  if (!ok) throw new Error(`备份回读校验失败：${dest}`);
}

function main() {
  fs.mkdirSync(BACKUP, { recursive: true });
  const manifest = {
    label: LABEL,
    createdAt: new Date().toISOString(),
    workspace: ROOT,
    backupDir: BACKUP,
    env: {},
    files: [],
  };

  manifest.env.commit = sh('git', ['rev-parse', 'HEAD']);
  manifest.env.branch = sh('git', ['branch', '--show-current']);
  manifest.env.node = process.version;
  // `dsh` 在 Windows 上是一个 sh 脚本（npm 的 shell shim），execFile 直接跑它会 ENOENT。
  // 版本以 npm-global 下真实包为准，跑不通再退回 `dsh.cmd --version`。
  manifest.env.dshVersion = (() => {
    const candidates = [
      path.join(process.env.APPDATA || '', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      path.join(process.env.HOME || process.env.USERPROFILE || '', 'AppData', 'Roaming', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ];
    for (const p of candidates) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version; } catch { /* 继续 */ }
    }
    return sh('dsh.cmd', ['--version']);
  })();
  manifest.env.profile = process.env.NOVELSTUDIO_DSH_PROFILE || 'novel';
  manifest.env.packageVersion = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; }
  })();
  // 复用 git 的 hash-object 对整棵工作树的 diff 取指纹：它把「已存在的未提交改动」
  // 变成一个可比较的值。后续任何一次 freeze 都能判断工作树是否还是同一状态。
  manifest.env.worktreeDiffHash = (() => {
    try {
      const diff = execFileSync('git', ['diff'], { cwd: ROOT, encoding: 'utf8' });
      return 'sha256:' + crypto.createHash('sha256').update(diff).digest('hex');
    } catch { return ''; }
  })();
  manifest.env.untrackedCount = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter((l) => l.startsWith('??')).length;
    } catch { return -1; }
  })();

  // 数据库：先 quick_check，再文件级复制（服务未运行，无写入者）。
  const dbPath = path.join(ROOT, 'data', 'novel.db');
  manifest.env.dbQuickCheck = 'unavailable';
  manifest.env.dbTables = -1;
  if (fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      manifest.env.dbQuickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown';
      manifest.env.dbTables = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c;
      db.close();
    } catch (err) {
      manifest.env.dbQuickCheck = 'error: ' + err.message;
    }
    copyOne(dbPath, 'data/novel.db', manifest);
  }

  for (const rel of TARGET_FILES) copyOne(path.join(ROOT, rel), rel, manifest);
  for (const abs of PROFILE_FILES) copyOne(abs, null, manifest);

  fs.writeFileSync(path.join(BACKUP, 'baseline-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // rollback manifest：只包含**确实存在**的备份，按 dest 逆序恢复。
  const rollback = {
    createdAt: manifest.createdAt,
    restoreRoot: ROOT,
    steps: manifest.files.filter((f) => f.status === 'backed_up').map((f) => ({
      from: f.dest,
      to: f.source,
      sha256: f.sha256,
    })),
    notes: [
      '按 steps 顺序逐条复制 from → to 即恢复改动前状态。',
      '数据库恢复前必须停止 novel-studio 服务（避免写入者把回滚覆盖）。',
      '新增模块目录不在 manifest 内：回滚时按报告列出的新增文件清单删除。',
    ],
  };
  fs.writeFileSync(path.join(BACKUP, 'rollback-manifest.json'), JSON.stringify(rollback, null, 2), 'utf8');

  const ok = manifest.files.filter((f) => f.status === 'failed').length === 0;
  console.log(JSON.stringify({
    ok,
    backupDir: BACKUP,
    commit: manifest.env.commit,
    branch: manifest.env.branch,
    node: manifest.env.node,
    dshVersion: manifest.env.dshVersion,
    dbQuickCheck: manifest.env.dbQuickCheck,
    dbTables: manifest.env.dbTables,
    worktreeDiffHash: manifest.env.worktreeDiffHash,
    backedUp: manifest.files.filter((f) => f.status === 'backed_up').length,
    absent: manifest.files.filter((f) => f.status === 'absent').length,
    rollbackSteps: rollback.steps.length,
  }, null, 2));
  console.log('BASELINE_JSON ' + path.join(BACKUP, 'baseline-manifest.json'));
  if (!ok) process.exit(1);
}

main();
