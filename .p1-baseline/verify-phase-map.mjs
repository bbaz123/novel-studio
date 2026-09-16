#!/usr/bin/env node
/**
 * verify-phase-map.mjs —— 「哪个阶段改了哪些文件、怎么独立回滚」的**可核对映射**。
 *
 * 为什么需要：目标里写着「每阶段独立验收与回滚」，但此前只有一个整体快照——
 * 没人能回答「我只想撤回 P3，要动哪里」。而手写的阶段清单**必然腐烂**（源码一改就对不上）。
 * 所以这里让映射与检查**同源**：
 *   - 阶段数据写在本文件里（唯一来源）；
 *   - `docs/phase-map.md` 由它**生成**，不手写；
 *   - 每次运行都拿真实改动集对账，出现「没归属的改动」即失败。
 *
 * 三条判据：
 *   1. **完整性**：真实改动集里每个文件都必须被某个阶段认领（否则没人知道怎么回滚它）；
 *   2. **存在性**：映射里提到的路径/证据必须真的存在（防止清单指向空气）；
 *   3. **可回滚性**：每个阶段都要标注回滚方式，并说明是否**可独立回滚**。
 *
 * 用法:
 *   node .p1-baseline/verify-phase-map.mjs            # 只校验（含与 docs/phase-map.md 对账）
 *   node .p1-baseline/verify-phase-map.mjs --write     # 重新生成文档
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isExcluded } from '../.p6-cutover/snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const DOC = path.join(REPO, 'docs', 'phase-map.md');

/**
 * 阶段 → 改动面。`files` 支持：精确路径、`目录/` 前缀、以及末段 `*` 通配。
 * `rollback` 只有两种取值，因为这是事实而非愿望：
 *   - 'independent'：回滚只涉及新增模块与少量挂钩点，可以单独撤回；
 *   - 'shared'：与其它阶段共用同一文件（改在同一批函数里），只能整体回滚。
 */
export const PHASES = [
  {
    id: 'P0',
    title: '专用 dsh profile（novel）与插件 bundle 化',
    files: [
      'harness-plugins/novel-writing/',
      '.p0-recon/',
      'harness.js',
    ],
    evidence: [
      '.p0-recon/README.md', '.p0-recon/verify-harness-profile.mjs',
      '.p0-recon/compare-composed.mjs', '.p0-recon/novel.p3.txt',
      '.p0-recon/capture-dsh-request.mjs',
    ],
    rollback: 'shared',
    note: 'harness.js 同时被 P4/P6 改过；profile 本身的回滚是卸掉 novel profile 与 bundle 接线（install-profile.mjs 反向操作）。',
  },
  {
    id: 'P1',
    title: '冻结上下文契约 + 基线 + 压力数据',
    files: [
      'ai/context/layers.mjs',
      'docs/context-contract.md',
      '.p1-baseline/context-floor.mjs',
      '.p1-baseline/capture-baseline.mjs',
      '.p1-baseline/compare-baseline.mjs',
      '.p1-baseline/make-stress.mjs',
      '.p1-baseline/survey.mjs',
      '.p1-baseline/schema-dump.mjs',
      // 精确到具体探测脚本，不再用 `probe-*.mjs` 整片通配——
      // 那会把 probe-live.mjs 也吞进来，与 X 的认领重叠，污染回滚判定（推导器立刻报出来了）。
      '.p1-baseline/probe-recall.mjs',
      '.p1-baseline/probe-recall-direct.mjs',
      '.p1-baseline/probe-recall-query.mjs',
      '.p1-baseline/probe-ov-find.mjs',
      '.p1-baseline/probe-ov-recall-chain.mjs',
      '.p1-baseline/probe-retrieval.mjs',
    ],
    evidence: [
      'docs/context-contract.md', '.p1-baseline/README.md',
      '.p1-baseline/context-floor.mjs', '.p1-baseline/make-stress.mjs',
    ],
    note: '层规格是新增模块；但**不能单独撤回**——装配器（P2）与 server.js 都 import 它，撤掉会当场打断它们。',
  },
  {
    id: 'P2',
    title: '唯一上下文装配器（预算自动核算 + 裁剪清单）',
    files: [
      'ai/context/assembler.mjs',
      'server.js',
      '.p1-baseline/verify-invariants.mjs',
      '.p1-baseline/verify-p3-unified.mjs',
      '.p1-baseline/test-assembler.mjs',
      'docs/p2-assembler-verification.md',
      'docs/ai-core.md',
    ],
    evidence: [
      'docs/p2-assembler-verification.md', 'docs/ai-core.md',
      '.p1-baseline/verify-invariants.mjs', '.p1-baseline/test-assembler.mjs',
    ],
    rollback: 'shared',
    note: '改动集中在 server.js 的 buildNovelContext 与路由；与 P3/P4/P5 同处一个大文件，**无法只撤 P2**。',
  },
  {
    id: 'P3',
    title: '检索覆盖面 + 凡裁剪必可查回（I4）',
    files: [
      '.p1-baseline/verify-retrieval.mjs',
      '.p1-baseline/verify-plugin-tools.mjs',
      'docs/p3-retrieval-verification.md',
      'public/app.js',
      // P3 的检索桶加在 server.js 的 search() 里——早先漏记，会让"改动面"失真。
      'server.js',
    ],
    evidence: [
      'docs/p3-retrieval-verification.md',
      '.p1-baseline/verify-retrieval.mjs', '.p1-baseline/verify-plugin-tools.mjs',
    ],
    rollback: 'shared',
    note: '检索桶加在 server.js 的 search()、查回路径在 layers.mjs 的 RETRIEVAL；分别与 P2/P5 共享文件。',
  },
  {
    id: 'P4',
    title: '通道收敛 + 单点策略表',
    files: [
      'ai/policy.mjs',
      '.p1-baseline/verify-ai-branches.mjs',
      '.p1-baseline/test-model-switch-gate.mjs',
      'docs/p4-policy-verification.md',
      // ⚠️ 早先漏了这两个：P4 同时改了前端（策略取值）与 server.js（策略端点 + 并发闸门）。
      // 漏记会让"改动面"清单失真，也会让回滚判定偏乐观（推导器一跑就露）。
      'public/app.js',
      'server.js',
    ],
    evidence: [
      'docs/p4-policy-verification.md', 'ai/policy.mjs',
      '.p1-baseline/verify-ai-branches.mjs', '.p1-baseline/test-model-switch-gate.mjs',
    ],
    note: '策略单点化本身可撤（恢复各处字面量），但 ai/policy.mjs 被 harness.js 与 server.js import，'
      + '前端与 server.js 又被 P3/P5 共同修改 → 无法只撤 P4。',
  },
  {
    id: 'P5',
    title: '记忆语义压缩 + 效果埋点',
    files: [
      'ai/edit-distance.mjs',
      'db.js',
      '.p1-baseline/test-edit-distance.mjs',
      '.p1-baseline/verify-eval-metric.mjs',
      'docs/p5-memory-eval-verification.md',
      // ⚠️ 同 P4：P5 的埋点挂钩也在前端与 server.js 里（漏记过）。
      'public/app.js',
      'server.js',
    ],
    evidence: [
      'docs/p5-memory-eval-verification.md', 'ai/edit-distance.mjs',
      '.p1-baseline/test-edit-distance.mjs', '.p1-baseline/verify-eval-metric.mjs',
    ],
    note: '建表是增量迁移（向后兼容），但埋点挂钩落在 server.js 与 public/app.js（与 P3/P4 共享），'
      + 'ai/edit-distance.mjs 还被 server.js import → 无法只撤 P5。',
  },
  {
    id: 'P6',
    title: '一次性切换（工具就绪，**未执行**）',
    files: [
      '.p6-cutover/',
      'docs/p6-cutover-runbook.md',
      'docs/self-review-p0-p6.md',
      'ai/harness-env.mjs',
    ],
    evidence: [
      '.p6-cutover/cutover.mjs', '.p6-cutover/snapshot.mjs', '.p6-cutover/smoke.mjs',
      '.p6-cutover/README.md', 'docs/p6-cutover-runbook.md',
    ],
    note: '切换器与快照工具本身是自足的、可单独移除；但 P6 还含 ai/harness-env.mjs，'
      + '而它被 harness.js 与 .p1-baseline/test-harness-env.mjs import → 整段仍无法单独撤回。'
      + ' harness.js 的默认 profile 仍是 headless（未切换）。',
  },
  {
    id: 'D8',
    title: '不足清单修复（D8-#1…#8）',
    files: [
      // 这一条是 D8 独有的生产文件：`openviking-sync.js` 此前不属于任何阶段。
      'openviking-sync.js',
      'ai/sync-gate.mjs',
      'ai/context/cache.mjs',
      '.p1-baseline/exp-per-task-settings.mjs',
      '.p1-baseline/test-recall-gap.mjs',
      '.p1-baseline/test-sync-gate.mjs',
      '.p1-baseline/test-context-cache.mjs',
      // D8-#1：回滚矩阵（实测哪些提交能单独 revert；自带阴性对照）
      '.p1-baseline/revert-matrix.mjs',
      // D8-#7 的补证探针：确认外部信号 ov_indexed_at 在真实库里确实有值
      '.p1-baseline/probe-ov-indexed-at.mjs',
      // D8-#2：每任务独立 settings 的内核模块与两条证据（离线单测 + 并发端到端实验）
      'ai/task-settings.mjs',
      '.p1-baseline/test-task-settings.mjs',
      '.p1-baseline/exp-concurrent-models.mjs',
      // D8-#8：质量信号哨兵（客观指标；只调端点不自己写 SQL）
      '.p1-baseline/quality-sentinel.mjs',
      // D8-#4：命名任务并入作业设施的验收（静态接线 + 活体三段：进度/取消/落库）
      '.p1-baseline/verify-named-jobs.mjs',
      // D8-#3：记忆压缩的零损失护栏（实体变体 + 覆盖率下限）与其探针
      'ai/memory-compress-guard.mjs',
      '.p1-baseline/test-memory-compress-guard.mjs',
      '.p1-baseline/probe-entity-variants.mjs',
      // D8-#3：自动压缩开关的验收（含"不打开不花钱"的阴性对照）
      '.p1-baseline/verify-auto-compress.mjs',
      // D8-#8 后半：关键改动的人工盲测工具（花钱需显式确认）
      '.p1-baseline/blind-ab.mjs',
    ],
    evidence: [
      '.p1-baseline/test-recall-gap.mjs', '.p1-baseline/test-sync-gate.mjs',
      '.p1-baseline/test-context-cache.mjs', '.p1-baseline/exp-per-task-settings.mjs',
      '.p1-baseline/revert-matrix.mjs',
    ],
    note: 'D8 是对"不足清单"的逐条修复，与 P0–P6 同处一批文件：server.js 已被 P2–P5 认领，'
      + 'ai/context/layers.mjs 属 P1，所以 D8 的代码同样**不能单独撤回**。'
      + ' 它独有认领的只有 openviking-sync.js（此前无人认领）与两个新内核模块。',
  },
  {
    id: 'X',
    title: '跨阶段：总纲与工具入口',
    files: [
      'README.md',
      'docs/README.md',
      'docs/phase-map.md',
      'docs/pending-decisions.md',
      'docs/final-acceptance-p0-p6.md',
      '.p1-baseline/README.md',
      '.p1-baseline/.gitignore',
      '.p1-baseline/verify-phase-map.mjs',
      'ai/README.md',
      'ai/context/README.md',
      '.p1-baseline/diff-real-db.mjs',
      '.p1-baseline/diff-log-noise.mjs',
      '.p1-baseline/incident-evidence-app-log-2026-09-15.md',
      '.p1-baseline/incident-evidence-app-log-2026-09-15.raw.txt',
      '.p1-baseline/census.mjs',
      '.p1-baseline/probe-live.mjs',
      '.p1-baseline/read-dsh-session.mjs',
      '.p1-baseline/audit-llm-calls.mjs',
      '.p1-baseline/blackhole.mjs',
      '.p1-baseline/gate-env.mjs',
      '.p1-baseline/verify-harness-gate.mjs',
      '.p1-baseline/test-gate-assert.mjs',
      '.p1-baseline/test-harness-env.mjs',
      '.p1-baseline/verify-memory-hint.mjs',
      '.p1-baseline/compare-memory-hint.mjs',
      '.p1-baseline/verify-retrieval-map.mjs',
      '.p1-baseline/verify-layer-constants.mjs',
      '.p1-baseline/verify-all.mjs',
      // 决策 D4（模型槽位可观测性）的验收工具。D4 的**代码**改动都落在
      // 已被 P0/P2–P5 认领的共享文件里（harness.js / server.js / public/app.js），
      // 所以这里只需认领新增的工具本身——与 D5 把事故证据归入 X 同一处理。
      '.p1-baseline/verify-model-slot.mjs',
      // 主实例重启后的对照检查（只读、零计费）：证明"代码提交了"≠"实例生效了"。
      '.p1-baseline/verify-main-instance.mjs',
    ],
    evidence: ['.p1-baseline/verify-all.mjs', '.p1-baseline/README.md', 'docs/README.md'],
    note: '验收工具与总纲；单独撤回只会让验收能力变弱，不影响线上行为——'
      + '但注意 X 内部彼此 import（verify-all ↔ 各工具），且被 .p0-recon 的线路层工具引用。',
  },
];

/** 末段 `*` 通配 + 目录前缀 + 精确路径。 */
export function matchesPattern(rel, pattern) {
  const p = rel.replace(/\\/g, '/');
  if (pattern.endsWith('/')) return p.startsWith(pattern);
  if (pattern.includes('*')) {
    const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(p);
  }
  return p === pattern;
}

/**
 * 扫出「谁 import 了谁」（仓库内相对路径）。
 *
 * 为什么要它：`rollback` 那一列原先是我**手写的判断**，而它从未被检验过——
 * 实测就写错了：`ai/context/layers.mjs` 是 P1 的文件，却被装配器（P2）与 `server.js` import，
 * 单独撤掉 P1 会当场打断 P2。所以这一列必须**从真实依赖推导**，而不是靠印象。
 */
export function scanImports(files) {
  /** @type {Map<string, Set<string>>} 目标文件 → 引用它的文件 */
  const importers = new Map();
  const add = (target, from) => {
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(from);
  };
  for (const rel of files) {
    if (!/\.(mjs|cjs|js)$/.test(rel)) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const dir = path.posix.dirname(rel);
    for (const m of src.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g)) {
      let target = path.posix.normalize(path.posix.join(dir, m[1]));
      // 逐个候选补后缀/补 index，命中真实文件才算
      const cands = [target, `${target}.mjs`, `${target}.cjs`, `${target}.js`, `${target}/index.mjs`, `${target}/index.js`];
      const hit = cands.find((c) => fs.existsSync(path.join(REPO, c)));
      if (hit) add(hit, rel);
    }
  }
  return importers;
}

/**
 * 推导某阶段能否**独立回滚**。三种结果：
 *
 *   independent  没有共享文件，也没有被任何东西 import → 撤掉不影响别人
 *   tool-only    只被**验收工具**（.p0-recon / .p1-baseline / .p6-cutover）import
 *                → 可单独撤，代价是若干工具会失效（**会响亮地报错**，需同步修）
 *   shared       与别的阶段改在同一文件里，或**被生产代码**（server/harness/db/public/ai/插件）import
 *                → 撤掉会静默打断线上路径，只能整体回滚
 *
 * 为什么要分生产/工具：两者严重性不同。被 `server.js` import 撤了就断线上；
 * 被 `test-*.mjs` import 撤了只是测试跑不起来——后者是"响亮失败"，前者可能静默。
 */
export function computeRollback(phase, phases, importers) {
  const reasons = [];
  let hasProdBlocker = false;
  let hasToolBlocker = false;
  const isTool = (f) => /^\.(p0-recon|p1-baseline|p6-cutover)\//.test(f);

  for (const f of phase.ownedFiles) {
    const owners = phases.filter((p) => p.files.some((pat) => matchesPattern(f, pat))).map((p) => p.id);
    if (owners.length > 1) {
      hasProdBlocker = true;   // 同一文件被多阶段改 = 改动交织，撤不干净
      reasons.push(`文件 ${f} 同时属于 ${owners.join('/')}——改动改在同一批代码里，撤不干净`);
    }
    for (const imp of (importers.get(f) || [])) {
      const impOwners = phases.filter((p) => p !== phase && p.files.some((pat) => matchesPattern(imp, pat)));
      if (!impOwners.length) continue;
      if (isTool(imp)) {
        hasToolBlocker = true;
        reasons.push(`${f} 被 ${imp}（验收工具，${impOwners.map((p) => p.id).join('/')}）import——撤掉会让该工具失效`);
      } else {
        hasProdBlocker = true;
        reasons.push(`${f} 被**生产代码** ${imp}（${impOwners.map((p) => p.id).join('/')}）import——撤掉会打断线上路径`);
      }
    }
  }
  const rollback = hasProdBlocker ? 'shared' : (hasToolBlocker ? 'tool-only' : 'independent');
  return { rollback, reasons: [...new Set(reasons)].slice(0, 6) };
}

function git(args) {
  // stderr 显式丢弃：`git diff/status` 在 CRLF 工作副本上会打一堆
  // 「warning: in the working copy of 'server.js', CRLF will be replaced...」。
  // 这些警告会**污染套件汇总表里的证据行**（它取的是最后一行）——实测过，非常误导。
  // stdio[1]='pipe' 保证仍能拿到 stdout。
  return execFileSync('git', args, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** 真实改动集：相对某个**基线提交**的改动 + 未跟踪源码（沿用快照工具的排除规则）。 */
export function changedFiles(base) {
  const set = new Set();
  const args = base ? ['diff', '--name-only', base] : ['diff', '--name-only', 'HEAD'];
  for (const rel of git(args).split('\n').map((s) => s.trim()).filter(Boolean)) {
    const p = rel.replace(/\\/g, '/');
    // ⚠️ 排除规则必须作用于**两支**来源。早先只过滤"未跟踪"那一支，
    // 于是 D1 把 `baselines*/summary.json` 提交进来之后，它们突然成了 21 个"无归属改动"——
    // 实测撞到过。派生数据无论是否已提交，都不该算进"阶段的改动面"。
    if (isExcluded(p)) continue;
    set.add(p);
  }
  const out = git(['status', '--porcelain', '-uall']);
  for (const line of out.split('\n')) {
    if (!line.startsWith('?? ')) continue;
    let rel = line.slice(3).trim();
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    rel = rel.replace(/\\/g, '/');
    if (isExcluded(rel)) continue;
    set.add(rel);
  }
  return [...set].sort();
}

/**
 * 默认基线：**当前分支与主线的分叉点**（`git merge-base HEAD <main>`）。
 *
 * 为什么不能用 HEAD：D1 把整个重构提交之后，`git diff HEAD` 只剩当天的新改动，
 * 于是 P0/P1 的文件"消失"在改动集之外，推导就把它们误判成 `independent`——
 * 实测撞到过（提交前 P0=shared，提交后突然=independent）。
 * 用分叉点则天然表达"这次重构改了哪些东西"，且**不写死提交号**（不会腐烂）。
 * 主线分支名可用 `--main <name>` 覆盖；拿不到时退回 HEAD 并在输出里说明。
 */
export function defaultBase(mainBranch = 'main') {
  try {
    return git(['merge-base', 'HEAD', mainBranch]).trim();
  } catch {
    return '';
  }
}

/** 生成文档正文（文档由数据派生，避免手写漂移）。 */
export function renderDoc(phases, changed, verdicts) {
  const lines = [];
  lines.push('# 阶段 → 改动面 → 回滚（自动生成，请勿手改）');
  lines.push('');
  lines.push('> 由 `.p1-baseline/verify-phase-map.mjs` 生成：`node .p1-baseline/verify-phase-map.mjs --write`。');
  lines.push('> 每次运行都会拿**真实改动集**对账——出现「没归属的改动」即失败，');
  lines.push('> 这样"我只想撤回某个阶段，要动哪里"永远有答案，清单也不会腐烂。');
  lines.push('>');
  lines.push('> 注：本文档自身也在改动集里（归在 X），所以**首次生成**后计数会 +1，此后稳定。');
  lines.push('');
  lines.push('## 一、可独立回滚性总览');
  lines.push('');
  lines.push('> 「回滚」这一列**不是手写的判断，而是从真实依赖推导的**，三档：');
  lines.push('> - ✅ **independent**：无共享文件、也没被任何东西 import → 撤掉不影响别人；');
  lines.push('> - 🟡 **tool-only**：只被**验收工具** import → 可单独撤，代价是工具会响亮地失效（需同步修）；');
  lines.push('> - ⚠️ **shared**：与别的阶段改在同一文件里，或**被生产代码**（server/harness/db/public/ai/插件）import');
  lines.push('>   → 撤掉会打断线上路径，只能整体回滚。');
  lines.push('>');
  lines.push('> 判据来自真实 `import` 图与真实改动集；推导结果与数据里声明的值必须一致，否则核对失败。');
  lines.push('');
  lines.push('| 阶段 | 主题 | 回滚 |');
  lines.push('|---|---|---|');
  for (const p of phases) {
    const v = verdicts.get(p.id);
    const label = v.rollback === 'independent' ? '✅ 可独立回滚'
      : (v.rollback === 'tool-only' ? '🟡 可单独撤，但会让若干验收工具失效（需同步修）'
        : '⚠️ 与其它阶段共享文件或被生产代码 import，只能整体回滚');
    lines.push(`| **${p.id}** | ${p.title} | ${label} |`);
  }
  const indep = phases.filter((p) => verdicts.get(p.id).rollback === 'independent');
  const toolOnly = phases.filter((p) => verdicts.get(p.id).rollback === 'tool-only');
  lines.push('');
  lines.push(`**可独立回滚的阶段：${indep.length ? indep.map((p) => p.id).join('、') : '（无）'}。**`
    + (toolOnly.length ? `仅会让验收工具失效的：${toolOnly.map((p) => p.id).join('、')}。` : '')
    + '其余阶段要么与别的阶段改在同一批代码里，要么被生产代码 import——**要回滚就一起回滚**，'
    + '或用 `.p6-cutover/snapshot.mjs` 的整体快照。');
  lines.push('');
  lines.push('## 二、逐阶段明细');
  for (const p of phases) {
    const v = verdicts.get(p.id);
    lines.push('');
    lines.push(`### ${p.id} · ${p.title}`);
    lines.push('');
    lines.push(`- **回滚方式**：${v.rollback === 'independent' ? '可独立回滚'
      : (v.rollback === 'tool-only' ? '可单独撤，但会让若干验收工具失效（需同步修）' : '只能整体回滚')}`);
    if (v.reasons.length) {
      lines.push('- **阻断原因（推导得出）**：');
      for (const r of v.reasons) lines.push(`  - ${r}`);
    }
    lines.push(`- **说明**：${p.note}`);
    lines.push(`- **验收证据**：${p.evidence.map((e) => `\`${e}\``).join('、')}`);
    const owned = changed.filter((f) => p.files.some((pat) => matchesPattern(f, pat)));
    lines.push(`- **本阶段认领的文件**（${owned.length} 个）：`);
    for (const f of owned) lines.push(`  - \`${f}\``);
  }
  const orphans = changed.filter((f) => !phases.some((p) => p.files.some((pat) => matchesPattern(f, pat))));
  lines.push('');
  lines.push('## 三、归属核对');
  lines.push('');
  lines.push(`- 真实改动集：**${changed.length}** 个文件`);
  lines.push(`- 未被任何阶段认领：**${orphans.length}** 个`);
  if (orphans.length) {
    lines.push('');
    lines.push('⚠️ 以下改动没有归属——没人能说清怎么回滚它们：');
    for (const o of orphans) lines.push(`  - \`${o}\``);
  } else {
    lines.push('');
    lines.push('✓ 全部改动都有归属。');
  }
  lines.push('');
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argOf = (n, d = '') => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const MAIN_BRANCH = argOf('--main', 'main');
  const BASE = argOf('--since', '') || defaultBase(MAIN_BRANCH);
  const changed = changedFiles(BASE);
  let bad = 0;
  const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${text}`); };

  console.log('═══ 阶段映射核对 ═══\n');
  console.log(`基线：${BASE ? `${BASE.slice(0, 8)}（与 ${MAIN_BRANCH} 的分叉点${argOf('--since') ? '，由 --since 指定' : ''}）` : 'HEAD（拿不到分叉点，退回 HEAD）'}`);
  console.log(`真实改动集：${changed.length} 个文件\n`);
  if (changed.length === 0) {
    console.log('（与基线相比没有改动——没有可归属的东西。若你刚把分支合进主线，这是正常的。）');
  }

  // 1) 完整性：每个改动都要有归属
  const orphans = changed.filter((f) => !PHASES.some((p) => p.files.some((pat) => matchesPattern(f, pat))));
  console.log('【1. 完整性：改动是否都有归属】');
  say(orphans.length === 0, orphans.length
    ? `${orphans.length} 个改动没有归属（没人能说清怎么回滚）：`
    : `全部 ${changed.length} 个改动都有归属`);
  for (const o of orphans.slice(0, 15)) console.log(`      · ${o}`);
  if (orphans.length > 15) console.log(`      · …其余 ${orphans.length - 15} 项`);

  // 2) 存在性：映射里提到的证据路径必须真的存在
  console.log('\n【2. 存在性：映射指向的文件是否真的在】');
  for (const p of PHASES) {
    const missing = p.evidence.filter((e) => !fs.existsSync(path.join(REPO, e)));
    say(missing.length === 0, `${p.id} 的 ${p.evidence.length} 项证据都在`
      + (missing.length ? `（缺：${missing.join('、')}）` : ''));
  }

  // 3) 可回滚性：**由真实依赖推导**，并要求数据里的声明与推导一致
  console.log('\n【3. 可回滚性：从真实依赖推导（不是手写判断）】');
  for (const p of PHASES) p.ownedFiles = changed.filter((f) => p.files.some((pat) => matchesPattern(f, pat)));
  const importers = scanImports(changed);
  const verdicts = new Map();
  for (const p of PHASES) {
    const v = computeRollback(p, PHASES, importers);
    verdicts.set(p.id, v);
    const declared = p.rollback;
    const agree = declared === undefined || declared === v.rollback;
    say(agree, `${p.id} 推导=${v.rollback}`
      + (declared === undefined ? '（数据未声明，以推导为准）' : `　声明=${declared}`));
    for (const r of v.reasons.slice(0, 2)) console.log(`      · ${r}`);
    if (!agree) console.log(`      ← 声明与推导不一致：要么改数据，要么改归属（清单漏记会让判定偏乐观）`);
  }
  const indep = PHASES.filter((p) => verdicts.get(p.id).rollback === 'independent').map((p) => p.id);
  console.log(`\n  可独立回滚的阶段：${indep.length ? indep.join('、') : '（无）'}`
    + `${indep.length ? '' : ' —— 要回滚只能整体回滚，或用 snapshot.mjs 的整体快照'}`);

  // 4) 文档对账（或生成）
  const rendered = renderDoc(PHASES, changed, verdicts);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(DOC), { recursive: true });
    fs.writeFileSync(DOC, rendered);
    console.log(`\n✓ 已生成 ${path.relative(REPO, DOC)}`);
  } else {
    console.log('\n【4. 文档与数据是否一致】');
    const onDisk = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
    if (onDisk === rendered) {
      say(true, `docs/phase-map.md 与阶段数据一致（${rendered.length} 字节）`);
    } else if (!onDisk) {
      say(false, 'docs/phase-map.md 不存在 —— 跑 --write 生成');
    } else {
      const a = onDisk.split('\n');
      const b = rendered.split('\n');
      const firstDiff = a.findIndex((l, i) => l !== b[i]);
      say(false, `docs/phase-map.md 已过期（首个差异在第 ${firstDiff + 1} 行）—— 跑 --write 重新生成`);
      console.log(`      磁盘: ${String(a[firstDiff] ?? '(缺行)').slice(0, 100)}`);
      console.log(`      应然: ${String(b[firstDiff] ?? '(缺行)').slice(0, 100)}`);
    }
  }

  console.log(`\n${bad ? `✗ 阶段映射核对未通过（${bad} 处问题）` : '✓ 阶段映射核对通过'}`);
  process.exitCode = bad ? 1 : 0;
}
