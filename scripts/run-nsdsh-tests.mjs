#!/usr/bin/env node
/**
 * run-nsdsh-tests.mjs —— NSDSH 专项套件的总入口（S01，纪律与 `test-narrative-repair.mjs` 一致）。
 *
 * 为什么要有总入口、而不是让 CI 直接列三个文件：
 *   ① 显式清单 —— shell glob 在 Windows 与 POSIX 上展开结果不同，本项目要求两端同一结论；
 *   ② "清单为空 / `--only` 匹配不到"必须是**非零退出**（历史上"没找到测试"曾被当成绿）；
 *   ③ 每个子套件只信**退出码**，失败继续跑完，一次看清全部红灯。
 *
 * 受限沙箱的处置：文件沙箱会拒绝子进程**管道** stdio，但 `runCommand` 会退到文件重定向，
 * 因此正常情况下子进程路径仍然可用。真走到"连文件重定向都起不来"时，退到**同进程**执行
 * （与 `test-narrative-repair.mjs` 同一手法），并在输出里标明 transport —— 
 * 但**绝不**把"起不来"记成通过。
 *
 * 用法：node scripts/run-nsdsh-tests.mjs [--only <子串>]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTestCounts, runCommand } from './nsdsh/lib/gate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 显式清单：新增 nsdsh 专项套件必须登记在这里。 */
export const NSDSH_TESTS = [
  // 隔离夹具与网络拒绝（含"guard 不得拦合法回环"的阴性对照）
  'tests/nsdsh/isolation.test.mjs',
  // 阶段运行器的纯判据：空清单 / 缺文件 / 零测试 / 环境阻断 / 前置证据失效 / 未知阶段
  'tests/nsdsh/stage-runner.test.mjs',
  // 备份-恢复演练（VACUUM INTO 一致快照 + 篡改必须被检出）
  'tests/nsdsh/backup-restore.test.mjs',
  // S02：F01–F12 与 D1–D6 的**行为表征**（钉住现状，含缺陷；修的那一阶段必须显式改这些断言）
  'tests/nsdsh/regression-findings.test.mjs',
  // S02：保存→pending→分析→确认状态机与不变量（幂等 / 跨作品 / 保守失效 / 审批单次消费）
  'tests/nsdsh/baseline-contract.test.mjs',
  // S02：历史边界、lineage 与提交级信任不得混为一谈
  'tests/nsdsh/historical-trust.test.mjs',
  // S03：用例抽取的**平权证明**（把抽取前的判据重写成基线，穷举输入空间逐条对照）
  'tests/nsdsh/save-service-parity.test.mjs',
  // S03：模块边界 —— import 领域模块不启动服务、不打开数据库、不调用模型
  'tests/nsdsh/module-boundaries.test.mjs',
  // S04：持久化分析队列（F01 重启可恢复 / F02 trailing+cap / 租约代际 fencing / 已发送不自动重发）
  'tests/nsdsh/task-queue.test.mjs',
  // S04：R1–R4 实现缺陷（运行中任务被改写 / 失败伪装成完成 / 重排提前防抖 / 传输态跨轮次）
  'tests/nsdsh/task-fencing.test.mjs',
  // S05: stable entity identity (F09) -- rename keeps identity, duplicate names are ambiguous
  'tests/nsdsh/entity-identity.test.mjs',
  'tests/nsdsh/identity-migration.test.mjs',
  'tests/nsdsh/relation-direction.test.mjs',
  // S06: full extraction coverage / request+response digests / evidence anchors / schema-derived prompt
  'tests/nsdsh/extraction-coverage.test.mjs',
  'tests/nsdsh/request-digest.test.mjs',
  'tests/nsdsh/evidence-anchors.test.mjs',
  'tests/nsdsh/extraction-schema.test.mjs',
  // S07: unified boundary-aware state query / projection provenance / downstream invalidation / POV visibility
  'tests/nsdsh/state-query-boundary.test.mjs',
  'tests/nsdsh/projection-provenance.test.mjs',
  'tests/nsdsh/downstream-invalidation.test.mjs',
  'tests/nsdsh/pov-visibility.test.mjs',
  // S08: domain event stream (cursor/watermark/resync) + frontend revision guard + editor IME preservation
  'tests/nsdsh/domain-stream.test.mjs',
  'tests/nsdsh/frontend-revision-guard.test.mjs',
  'tests/nsdsh/editor-save-ime.test.mjs',
  // S09: tool capability table (F11) + author approval boundary + cross-work isolation
  'tests/nsdsh/tool-capabilities.test.mjs',
  'tests/nsdsh/author-approval-boundary.test.mjs',
  'tests/nsdsh/cross-work-isolation.test.mjs',
  // S10: model routing by work+purpose (F04) + runtime adapter contract + task budget
  'tests/nsdsh/model-routing.test.mjs',
  'tests/nsdsh/runtime-adapter-contract.test.mjs',
  'tests/nsdsh/task-budget.test.mjs',
  // S11: pinned DSH vendor baseline provenance (origin/tag/commit/license/lockfile)
  'tests/nsdsh/dsh-vendor-provenance.test.mjs',
  // S12: novel-only profile composition + effective tool set == approval-allowed set
  'tests/nsdsh/novel-profile.test.mjs',
  'tests/nsdsh/effective-tools.test.mjs',
  'tests/nsdsh/runtime-config-isolation.test.mjs',
  // S13: SDK subprocess lifecycle / cancel (no invented API) / session scoping / pooling decision
  'tests/nsdsh/sdk-lifecycle.test.mjs',
  'tests/nsdsh/sdk-cancel.test.mjs',
  'tests/nsdsh/session-scope.test.mjs',
  'tests/nsdsh/runtime-pool.test.mjs',
  // S14: runtime manifest + dependency closure (F10) / clean-room staging / B-C contract equivalence
  'tests/nsdsh/distribution-closure.test.mjs',
  'tests/nsdsh/distribution-clean-room.test.mjs',
  'tests/nsdsh/runtime-equivalence.test.mjs',
];

/**
 * 同进程执行一个套件：动态 import（带 cache-busting 查询串，避免第二次 import 拿到缓存），
 * 捕获 console、读 `process.exitCode`。与 `test-narrative-repair.mjs` 的实现保持一致，
 * 因为两者面对的是同一个沙箱边界。
 */
async function runInProcess(rel) {
  const orig = { log: console.log, error: console.error };
  const buf = [];
  const cap = (...a) => { buf.push(a.map((x) => String(x)).join(' ')); };
  console.log = cap;
  console.error = cap;
  const prevExit = process.exitCode;
  process.exitCode = 0;
  let threw = '';
  try {
    await import(`${pathToFileURL(path.join(REPO, rel)).href}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  } catch (e) {
    threw = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
    process.exitCode = 1;
  } finally {
    console.log = orig.log;
    console.error = orig.error;
  }
  const status = process.exitCode || 0;
  process.exitCode = prevExit || 0;
  return { stdout: buf.join('\n'), stderr: threw, status, transport: 'in-process' };
}

/** 一个套件文件可能打印**多行**汇总（同步段 + 异步段）：逐行累加，而不是只看最后一行。 */
function sumCounts(text) {
  const all = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/通过|PASS\s+\d+\s*\/\s*FAIL/i.test(line)) continue;
    const c = parseTestCounts(line);
    if (c && c.total !== null) all.push(c);
  }
  if (!all.length) return parseTestCounts(text);
  return {
    passed: all.reduce((n, c) => n + (c.passed || 0), 0),
    failed: all.reduce((n, c) => n + (c.failed || 0), 0),
    skipped: all.some((c) => c.skipped !== null) ? all.reduce((n, c) => n + (c.skipped || 0), 0) : null,
    total: all.reduce((n, c) => n + (c.total || 0), 0),
  };
}

const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
if (!NSDSH_TESTS.length) {
  console.error('✗ nsdsh 测试清单为空：拒绝把"没有测试"当作通过。');
  process.exit(2);
}
const list = only ? NSDSH_TESTS.filter((f) => f.includes(only)) : NSDSH_TESTS;
if (!list.length) {
  console.error(`✗ --only ${only} 没有匹配任何 nsdsh 套件（清单：${NSDSH_TESTS.join(', ')}）。`);
  process.exit(2);
}

const results = [];
let inProcessFallback = false;
for (const rel of list) {
  const t0 = Date.now();
  const argv = [process.execPath, rel];
  let r = runCommand(argv, { cwd: REPO });
  // 只有"完全没跑起来"才退到同进程：能跑起来的失败是**真失败**，不许改传输方式掩盖它。
  if (r.status === null && r.environmentBlocked && !String(r.stdout || '').trim()) {
    if (!inProcessFallback) {
      inProcessFallback = true;
      console.log('提示：当前环境不允许子进程 stdio（连文件重定向都起不来）→ 改用**同进程**逐套件执行（断言与退出码判定不变）。\n');
    }
    r = await runInProcess(rel);
  }
  const ms = Date.now() - t0;
  const out = String(r.stdout || '');
  const counts = sumCounts(out);
  const ok = r.status === 0;
  results.push({ rel, ok, ms, counts, transport: r.transport });
  const summary = counts.total === null ? '' : `通过 ${counts.passed} / 未通过 ${counts.failed}（${counts.total} 条）`;
  console.log(`${ok ? '✓' : '✗'} ${rel}（${ms}ms, ${r.transport}${only ? ', --only' : ''}）${summary ? ` ${summary}` : ''}`);
  if (!ok) {
    out.split(/\r?\n/).filter((l) => l.includes('FAIL')).slice(0, 8).forEach((l) => console.log(`    └ ${l.trim()}`));
    const err = String(r.stderr || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(' | ');
    if (err) console.log(`    └ stderr: ${err.slice(0, 400)}`);
  }
}

const bad = results.filter((r) => !r.ok);
const assertionsPassed = results.reduce((n, r) => n + (r.counts.passed || 0), 0);
const assertionsFailed = results.reduce((n, r) => n + (r.counts.failed || 0), 0);
const totalAssertions = results.reduce((n, r) => n + (r.counts.total || 0), 0);
// 断言总数为 0 —— 三个套件全都"跑过了但什么都没断言"——不能算通过：那和空清单是同一类问题。
const zeroAssertions = totalAssertions === 0;

// 汇总行刻意用**全角逗号**而不是 `通过 N / 未通过 M`：
//   ① runCommand 的 zeroTestGuard 读数走 parseTestCounts，两种写法都认，语义不变；
//   ② 标准写法在本文件里早就被**子套件自己**打印过（isolation.test.mjs 的 `通过 11 / 未通过 0`），
//      而解析取的是**第一处**匹配 —— 那样顶层报告里会出现"跑了 11 条"这种来自孙子进程的读数，
//      与"本命令的断言总数"是两码事。换成逗号写法后，这条汇总不再与子套件冲突。
console.log(`\n合计：套件通过 ${results.length - bad.length}，套件未通过 ${bad.length}（共 ${results.length} 个套件）`);
console.log(`合计：通过 ${assertionsPassed}，未通过 ${assertionsFailed}（断言总数 ${totalAssertions} 条，零计费）`);
// 机器标记：check-stage 的 zeroTestGuard 优先采信这一行（见其 readTestCounts）。
// 为什么需要它：本命令的输出里**还包含子套件自己**打印的 `通过 N / 未通过 M`，
// 而那个解析只会取第一处匹配 —— 于是顶层报告会写出子套件的读数而不是本命令的断言总数。
// 有了这一行，顶层数字就是"本命令真正跑了多少条断言"，不含歧义。
console.log(`NSDSH-SUMMARY: suites=${results.length} suitesFailed=${bad.length} passed=${assertionsPassed} failed=${assertionsFailed} total=${totalAssertions}`);
if (bad.length) console.log('未通过套件：' + bad.map((b) => b.rel).join('; '));
if (zeroAssertions) console.log('✗ 三个套件合计断言数为 0：无法证明测过任何东西，不判通过。');
process.exitCode = (bad.length || zeroAssertions) ? 1 : 0;
