/**
 * scripts/rollback-v118.mjs —— 本轮（v118/0317）**逐文件回滚**配方与核验（正式交付工具）。
 *
 * 为什么是"配方 + 核验"而不是自动改写：
 *   用户明确禁止 reset / clean / stash / commit / push，而本沙箱又禁止子进程管道
 *   （`node` 内 spawnSync `git` = EPERM），因此**我这一侧无法执行字节级精确回滚**。
 *   与其写一个"看起来能回滚、其实会改坏文件"的脚本，不如给出一份**可核验**的配方：
 *     · `--verify`：确认本批的每个标记在文件里**恰好出现一次**（说明本批可被逐字识别），
 *       打印 after-sha256 与逐文件的回滚命令；任一标记出现 0 次或多次 → 非零退出。
 *     · `--revert`：**需要 git**（由用户在自己终端执行）；沙箱内会响亮失败，不会改动任何文件。
 *
 * 回滚单位（与 docs/review-closure-118/rollback.md 一致）：
 *   ① 新增物（可独立撤回）：tests/narrative-repair/17-review-closure-0317.test.mjs、docs/review-closure-118/
 *   ② 共用文件的改动（必须按用户选择的粒度整体回滚）：
 *      public/patch-safety.js、public/revision-patch.js、
 *      ai/editing/narrative-review.mjs、ai/editing/narrative-scan.mjs、
 *      scripts/test-narrative-repair.mjs、.p1-baseline/verify-phase-map.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(REPO, p);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 本批在共用文件里留下的、**只可能来自本批**的标记（逐字来源：本批的编辑记录）。 */
const MARKERS = {
  'public/patch-safety.js': [
    '2026-03-17（第五批 · v118 0317 专项',
    'const WORKFLOW_PATTERNS = [',
    'function workflowRuleCandidates(anchor, revised, opts = {}) {',
    'function assessTemporalBridge(before, after, opts = {}) {',
    'function propStateCandidates(text, opts = {}) {',
    'function anchorStatus({ text, anchor, label = \'\' } = {}) {',
    'workflowRuleCandidates,\n    assessTemporalBridge,\n    propStateCandidates,\n    anchorStatus,',
  ],
  'public/revision-patch.js': [
    'v118 0317 专项 §4/§6 · V118-11',
    'function selectionOf(issueId, item, selectedIssues) {',
    'coverageVerdict({ semantic, stillPresent = 0, covered = false } = {})',
    '    coverageVerdict,\n  };',
  ],
  'ai/editing/narrative-review.mjs': [
    'v118 0317 专项 §3）：审稿报告不能虚构"原话"',
    'export function auditReviewQuotes(lines, text) {',
    'v118 0317 专项 §5 · V118-09',
    'strength_qualifications: qualifications,',
    'quote_audit: quoteAudit,',
  ],
  'ai/editing/narrative-scan.mjs': [
    'v118 0317 专项 · V118-15',
    'const COMMON_RARITY = new Set(',
    'function reactionCausalityCandidates(text, opts = {}) {',
    'reactionCausalityCandidates(raw, opts)',
  ],
  'scripts/test-narrative-repair.mjs': [
    '17-review-closure-0317.test.mjs',
  ],
  '.p1-baseline/verify-phase-map.mjs': [
    "id: 'SE8',",
    "'docs/review-closure-118/',",
  ],
};

const NEW_PATHS = [
  'tests/narrative-repair/17-review-closure-0317.test.mjs',
  'docs/review-closure-118/',
];

const mode = process.argv[2] || '--verify';

if (mode === '--verify') {
  let bad = 0;
  const markerCount = Object.values(MARKERS).reduce((n, arr) => n + arr.length, 0);
  console.log(`═══ v118 回滚核验（${markerCount} 个批次标记的唯一性 + after-sha256）═══\n`);
  for (const [file, marks] of Object.entries(MARKERS)) {
    const abs = rel(file);
    if (!fs.existsSync(abs)) { console.log(`✗ ${file}：文件不存在`); bad += 1; continue; }
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of marks) {
      const n = text.split(m).length - 1;
      const ok = n === 1;
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${file} ← 「${m.slice(0, 34).replace(/\n/g, '⏎')}…」出现 ${n} 次`);
    }
    console.log(`     after_sha256 = ${sha(abs)}`);
  }
  console.log('\n本批新增物（不属于任何既有文件，可直接删除）：');
  for (const p of NEW_PATHS) console.log(`  ${fs.existsSync(rel(p)) ? '✓' : '✗'} ${p}`);
  console.log('\n逐文件回滚命令（**由用户在自己的终端执行**；本 Agent 未执行、也不会执行）：');
  console.log('  git restore -- ' + Object.keys(MARKERS).join(' '));
  for (const p of NEW_PATHS) console.log(`  ${p.endsWith('/') ? `rm -rf ${p}` : `rm ${p}`}`);
  console.log(`\n${bad ? `✗ 核验未通过（${bad} 处）` : '✓ 全部标记唯一命中：本批可被逐字识别，回滚配方可用'}`);
  process.exitCode = bad ? 1 : 0;
} else if (mode === '--revert') {
  console.log('需要 git（工作树回滚）。本沙箱内子进程被禁，git 会 EPERM —— 不会改动任何文件。');
  try {
    execFileSync('git', ['restore', '--', ...Object.keys(MARKERS)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('✓ 已由 git 恢复共用文件。请再手动删除本批新增物：');
    for (const p of NEW_PATHS) console.log(`   ${p}`);
  } catch (e) {
    console.error('✗ git 不可用或失败：' + (e && e.message ? e.message : e));
    console.error('  → 未改动任何文件。请在本机终端按上面 --verify 打印的命令逐条执行。');
    process.exitCode = 1;
  }
} else {
  console.error('未知模式：', mode);
  process.exitCode = 2;
}
