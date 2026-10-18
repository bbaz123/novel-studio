#!/usr/bin/env node
/**
 * .p1-baseline/test-1019-revision-closure.mjs —— v1.2.1 审稿质量闭环的回归总入口。
 *
 * 方案 §12 给出 R-01…R-30 共 30 条必须通过的用例。本入口做两件事：
 *   ① 跑分套件（finding.v2 / 多热点计划 / 语义验收 / 闭环状态 / 回执与插件工具）；
 *   ② 把 R-01…R-30 **逐条**对到"由哪个套件的哪条断言覆盖"，无法在本仓库离线覆盖的
 *      显式标 SKIP 并写明理由 —— 不允许出现"没有归属的 R 项"被默默漏掉。
 *
 * 纪律（与 test-1018-hardening.mjs 一致）：
 *   · 只信退出码，不信文案；
 *   · 失败打印子套件输出尾部；
 *   · 受限沙箱里管道被拒（EPERM）→ 退到文件重定向，断言与判定不改；
 *   · skipped 不算 passed，但"显式 SKIP + 理由"必须可见。
 *
 * 用法:
 *   node .p1-baseline/test-1019-revision-closure.mjs
 *   node .p1-baseline/test-1019-revision-closure.mjs --only 语义
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: 'P0-1/P0-2 finding.v2 契约（R-01/02/03）', file: 'test-1019-findings.mjs' },
  { name: 'P0-3/P0-4/P0-5 多证据多热点计划与授权（R-02/04/14/15）', file: 'test-1019-plan-multi.mjs' },
  { name: 'P0-6 逐条确定性/语义验收（R-05..R-13/R-16/R-17/R-22）', file: 'test-1019-semantic.mjs' },
  { name: 'P0-7 状态机/指标/预算/报告（R-19..R-21/R-23/R-28/R-29）', file: 'test-1019-closure.mjs' },
  { name: 'P0-7/P0-9 回执 + 只读状态 + 插件工具（服务端边界）', file: 'test-1019-receipt-http.mjs' },
];

/**
 * R 项归属表。`where` 必须能在对应套件里找到，`skip` 则必须写明"为什么这个仓库无法离线验证"。
 * 新增/修改覆盖关系时改这里 —— 它是"30 条有没有被漏掉"的唯一判据。
 */
const MATRIX = [
  { id: 'R-01', where: 'test-1019-findings R-01a..e（旧 issues 适配 + EVIDENCE_MISSING）' },
  { id: 'R-02', where: 'test-1019-findings R-02a..e；test-1019-plan-multi M-01..M-03' },
  { id: 'R-03', where: 'test-1019-findings R-03a..c' },
  { id: 'R-04', where: 'test-1019-plan-multi R-04' },
  { id: 'R-05', where: 'test-1019-semantic R-05a/b' },
  { id: 'R-06', where: 'test-1019-semantic R-06a..c' },
  { id: 'R-07', where: 'test-1019-semantic R-07a/b' },
  { id: 'R-08', where: 'test-1019-semantic R-07a/b（词条/栏位错配由语义层判失败；词条版本化本身未实现）' },
  { id: 'R-09', where: 'test-1019-semantic R-05b（4 次重复仍存在 → 语义 fail，而非只看旧引文）' },
  { id: 'R-10', where: 'test-1019-semantic R-10（CANON_CONFLICT 优先于语义通过）' },
  { id: 'R-11', where: 'test-1019-semantic R-05b/R-07b（改掉两处仍需语义核验，不冒充全部通过）' },
  { id: 'R-12', where: 'test-1019-semantic R-05b（只删一处仍判未解决/部分处理）' },
  { id: 'R-13', where: 'test-1019-semantic R-13a/b' },
  { id: 'R-14', where: 'test-1019-plan-multi R-14' },
  { id: 'R-15', where: 'test-1019-plan-multi M-13' },
  { id: 'R-16', where: 'test-1019-semantic R-16a..c' },
  { id: 'R-17', where: 'test-1019-semantic R-17 + R-05a（无 diff 不算已改）' },
  { id: 'R-18', where: 'test-1019-closure K-01..K-05（门禁拦下的条目独立保留，其他组继续）' },
  { id: 'R-19', where: 'test-1019-closure R-19' },
  { id: 'R-20', where: 'test-1019-closure R-20a..e（整数分、单笔/累计、未知费用）' },
  { id: 'R-21', where: 'test-1019-closure R-21' },
  { id: 'R-22', where: 'test-1019-semantic R-22a/b' },
  { id: 'R-23', where: 'test-1019-closure R-23a..c' },
  {
    id: 'R-24',
    skip: 'DSH 自动方案触发隔离属于 dsh-auto-plan-executor 插件侧行为：本仓库没有该插件的触发管线，离线无法验证；由 auto-plan-executor 自己的 test/trigger.test.mjs 覆盖。',
  },
  {
    id: 'R-25',
    skip: '双插件同时加载需要真实宿主 profile（DSH 进程 + 两插件）。本仓库只能验证 Studio 侧不回写 C 账本；加载顺序/事件来源需人工联调，不能在本套件里伪造成通过。',
  },
  {
    id: 'R-26',
    skip: '正式 C1 未经用户回复不得 decide：属于 dsh-confirmation-resolution 账本行为，本仓库没有该账本代码（也不得导入其私有模块）。',
  },
  { id: 'R-27', where: 'test-1019-plan-multi M-13（通用保护区机制；0731 伏笔清单需作者登记，不做自动推导）' },
  { id: 'R-28', where: 'test-1019-closure R-28/R-28b（写回 + 版本一致才 PERSISTED_VERIFIED）' },
  { id: 'R-29', where: 'test-1019-closure R-29a/b' },
  {
    id: 'R-30',
    skip: '分段（长文本）修稿仍走 v1 单热点计划：本轮 v2 多热点只接在整章单请求路径（避免按片编译时把别片问题误判 needs_scope）；整章侧由 R-04/M-18 覆盖，按片一致性需后续专门实现。',
  },
];

function runSuite(file) {
  const rel = path.join('.p1-baseline', file);
  const piped = spawnSync(process.execPath, [rel], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (!(piped.status === null && piped.error && piped.error.code === 'EPERM')) {
    return { status: piped.status, stdout: piped.stdout || '', stderr: piped.stderr || '' };
  }
  const dir = fs.mkdtempSync(path.join(REPO, '.ci-out-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  try {
    const out = fs.openSync(outPath, 'w');
    const err = fs.openSync(errPath, 'w');
    const r = spawnSync(process.execPath, [rel], { cwd: REPO, stdio: ['ignore', out, err], encoding: 'utf8' });
    fs.closeSync(out);
    fs.closeSync(err);
    const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    return { status: r.status, stdout: readOr(outPath), stderr: readOr(errPath) || (r.error ? `spawn ${r.error.code || r.error.message}` : '') };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖结果 */ }
  }
}

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const list = only ? SUITES.filter((s) => s.name.includes(only)) : SUITES;
if (!list.length) {
  console.error(`没有匹配 --only ${only} 的套件`);
  process.exit(1);
}

// 先验矩阵本身：R-01…R-30 必须齐全，且每项要么有 where，要么有 skip 理由。
const expected = Array.from({ length: 30 }, (_, i) => `R-${String(i + 1).padStart(2, '0')}`);
const missing = expected.filter((id) => !MATRIX.some((m) => m.id === id));
const ambiguous = MATRIX.filter((m) => (m.where ? 0 : 1) + (m.skip ? 0 : 1) !== 1);
const skipped = MATRIX.filter((m) => m.skip);
console.log(`回归矩阵：${MATRIX.length} 项（有断言归属 ${MATRIX.length - skipped.length}；显式 SKIP ${skipped.length}）`);
for (const m of MATRIX) {
  if (m.skip) console.log(`  – ${m.id} SKIP：${m.skip}`);
}
if (missing.length || ambiguous.length) {
  console.error(`✗ 矩阵不完整：缺少 ${missing.join(',') || '无'}；where/skip 二选一不符 ${ambiguous.map((m) => m.id).join(',') || '无'}`);
  process.exit(2);
}
console.log('');

const results = [];
for (const s of list) {
  const t0 = Date.now();
  const r = runSuite(s.file);
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ ...s, ok, ms });
  console.log(`${ok ? '✓' : '✗'} ${s.name}（${ms}ms）`);
  if (!ok) {
    const tail = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-8).join('\n    ');
    console.log(`    ${tail}`);
    const err = (r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ');
    if (err) console.log(`    stderr: ${err.slice(0, 400)}`);
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\nv1.2.1 质量闭环回归：通过 ${results.length - bad.length} / 未通过 ${bad.length}（共 ${results.length} 个套件，零计费）`);
if (bad.length) console.log('未通过：' + bad.map((b) => b.name).join('; '));
process.exitCode = bad.length ? 1 : 0;
