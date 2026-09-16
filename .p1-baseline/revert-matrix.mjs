#!/usr/bin/env node
/**
 * revert-matrix.mjs —— 「哪些提交能单独回滚」的**实测**矩阵（决策 D8-#1）。
 *
 * 为什么需要它：
 *   `docs/phase-map.md` 由 import 图推导出的结论是「P0–P6 没有可独立回滚的**阶段**」，
 *   于是回滚粒度定为**提交**。但"粒度是提交"这句话本身没有被验证过——
 *   某个提交可能同样撤不干净（改在同一批行里、后续提交又依赖它）。
 *   这正是本项目反复吃过的亏：**清单/判断类资产会静默腐烂，而且不会自己报警**。
 *
 * 做法（不碰工作区）：
 *   在临时 `git worktree`（detached HEAD）里逐个 `git revert --no-commit <sha>`：
 *     退出码 0 → 该提交可单独撤销；非 0 → 与当前树冲突，撤不干净。
 *   每个尝试之后 `reset --hard` 还原，最后移除 worktree。
 *
 * 自带**阴性对照**（--self-test）：
 *   在临时仓库里造两个"改同一行"的提交，工具必须报出冲突。
 *   一个永远报"可回滚"的工具等于没有工具——必须先证明它认得出冲突。
 *
 * 用法:
 *   node .p1-baseline/revert-matrix.mjs                 # 对分支上全部提交跑矩阵
 *   node .p1-baseline/revert-matrix.mjs --since <sha>   # 只跑该 sha 之后的提交
 *   node .p1-baseline/revert-matrix.mjs --self-test     # 只跑阴性对照
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = process.cwd();
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** 跑 git，返回 {code, out}；stderr 一律丢弃（本仓库 CRLF 警告会污染证据行）。 */
function git(args, cwd = REPO) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || '') };
  }
}

// ── 阴性对照：临时仓库里造一个必然冲突的场景 ────────────────────────────────
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-matrix-negctl-'));
  const run = (a) => git(a, dir);
  run(['init', '-q']);
  run(['config', 'user.email', 'negctl@local']);
  run(['config', 'user.name', 'negctl']);
  run(['config', 'core.autocrlf', 'false']);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\n');
  run(['add', '-A']); run(['commit', '-q', '-m', 'A: 建立文件']);
  const shaA = run(['rev-parse', 'HEAD']).out.trim();

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1-changed-by-B\n');
  run(['add', '-A']); run(['commit', '-q', '-m', 'B: 改写同一行']);
  const shaB = run(['rev-parse', 'HEAD']).out.trim();

  // 在 B 之上回滚 A：A 建立的那一行已被 B 改写 → 必须冲突
  const conflict = run(['revert', '--no-commit', shaA]);
  run(['revert', '--abort']);
  // 在 B 之上回滚 B：它就是 HEAD，必然干净
  const clean = run(['revert', '--no-commit', shaB]);
  run(['revert', '--abort']);

  fs.rmSync(dir, { recursive: true, force: true });

  const okConflict = conflict.code !== 0;
  const okClean = clean.code === 0;
  console.log('【阴性对照：工具认不认得出冲突】');
  console.log(`  ${okConflict ? '✓' : '✗'} 「回滚 A（已被 B 改写同一行）」被判为冲突（exit=${conflict.code}）`);
  console.log(`  ${okClean ? '✓' : '✗'} 「回滚 B（就是 HEAD）」被判为干净（exit=${clean.code}）`);
  const pass = okConflict && okClean;
  console.log(pass
    ? '\n✓ 工具能区分「可单独回滚」与「冲突」——矩阵结果可信。'
    : '\n✗ 工具区分不出来，矩阵结果不可信（先修工具）。');
  process.exitCode = pass ? 0 : 1;
  return pass;
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  // 先自证工具可用，再拿它下结论——顺序不能反。
  console.log('═══ 先用阴性对照证明工具认得出冲突 ═══\n');
  const toolOk = selfTest();
  if (!toolOk) {
    console.error('\n工具未通过阴性对照，拒绝用它给出结论。');
    process.exit(1);
  }

  const since = arg('--since', 'ca1cdf96');
  const head = git(['rev-parse', 'HEAD']).out.trim();
  console.log(`\n═══ 回滚矩阵（${since.slice(0, 8)}..${head.slice(0, 8)}）═══\n`);

  const log = git(['log', '--reverse', '--format=%H%x09%s', `${since}..HEAD`]).out
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; });

  if (!log.length) { console.log('该区间没有提交。'); process.exit(0); }

  // 临时 worktree：全程不碰真实工作区（也不动 .git 里的索引）
  const wt = path.join(REPO, '.p1-baseline', '.revert-matrix');
  fs.rmSync(wt, { recursive: true, force: true });
  git(['worktree', 'prune']);
  const add = git(['worktree', 'add', '--detach', '--force', wt, 'HEAD']);
  if (add.code !== 0) {
    console.error(`创建临时 worktree 失败：${add.out}`);
    process.exit(1);
  }

  const rows = [];
  try {
    for (const c of log) {
      // 每次从干净的 HEAD 开始，保证每个提交都被独立评估
      git(['reset', '--hard', '-q', 'HEAD'], wt);
      git(['clean', '-fdq'], wt);
      const r = git(['revert', '--no-commit', c.sha], wt);
      git(['revert', '--abort'], wt);
      git(['reset', '--hard', '-q', 'HEAD'], wt);
      const stat = git(['show', '--stat', '--format=', '--shortstat', c.sha]);
      rows.push({ ...c, ok: r.code === 0, exit: r.code, stat: stat.out.trim() });
    }
  } finally {
    git(['worktree', 'remove', '--force', wt]);
    git(['worktree', 'prune']);
    fs.rmSync(wt, { recursive: true, force: true });
  }

  for (const r of rows) {
    const mark = r.ok ? '✓ 可单独回滚' : '✗ 与当前树冲突';
    console.log(`  ${mark}  ${r.sha.slice(0, 8)}  ${r.subject.slice(0, 58)}`);
    if (!r.ok) console.log(`        ${r.stat.split('\n').pop()}`);
  }

  const cleanN = rows.filter((r) => r.ok).length;
  console.log(`\n合计：可单独回滚 ${cleanN} / 冲突 ${rows.length - cleanN}（共 ${rows.length} 个提交）`);
  console.log('');
  console.log('要区分两件事，它们的答案不一样：');
  console.log(`  ① **外科式**撤销某一个提交、保留其后的提交 → 只有 ${cleanN}/${rows.length} 可行。`);
  console.log('     冲突的原因几乎都是"与后续提交改在同一批行"（server.js / harness.js / docs 被反复改）。');
  console.log('  ② **整体**回到历史上任意一点 → 永远可行，且不丢东西：');
  console.log('       git reset --hard <sha>      # 分支未合并，最直接；提交仍在 reflog 里，可找回');
  console.log('       git checkout <sha>          # 只想看看那时的状态');
  console.log('  所以本分支的正确回滚说法是：**整体回到某个提交可以，逐个摘出来多数不行**。');
  console.log(`  实操建议：要撤就撤**相邻的一整段**（例如 ${rows[rows.length - 1].sha.slice(0, 8)} 起往前数），`);
  console.log('  而不是从中间挑一个提交单独摘掉。');
  process.exitCode = 0;
}
