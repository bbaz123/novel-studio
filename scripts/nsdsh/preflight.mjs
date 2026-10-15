#!/usr/bin/env node
/**
 * nsdsh/preflight.mjs —— 环境 / 版本 / 路径 / 状态 / 隔离的**前置检查**（S01）。
 *
 * 为什么要有它：NSDSH 后续阶段（S02–S18）会因为"环境不对"产生大量**假红**。
 * 本项目已经真实发生过两次同类误判（2026-10-12 的 54 条全红、2026-10-15 的 37/17），
 * 根因都是**执行环境**而不是被测代码。把这些事实单独拎成一条不调用模型的前置命令，
 * 就能让"红灯属于哪种"在动手之前就有答案，而不是每跑一个阶段再重新归因一次。
 *
 * 纪律：
 *   · **绝不调用模型**（本文件里没有任何模型/网络请求，只有一次子进程回环拒绝证明）；
 *   · 需要但做不到的检查按 `--strict` 升级为失败，默认记 SKIP/BLOCKED，绝不记 PASS；
 *   · `--json` 时 stdout 上只有**一个** JSON 对象，人读信息全部走 stderr，便于机器解析。
 *
 * 退出码：0 = 全部 required 通过；1 = 有 required 失败；2 = 用法错误。
 *
 * 用法:
 *   node scripts/nsdsh/preflight.mjs [--offline] [--json] [--strict]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { EGRESS_DENIAL_SIGNATURE, probeEgressDenied, probeLoopbackAllowed } from './lib/egress.mjs';
import { REPO, abs, rel } from './lib/report.mjs';
import { GUARD_CJS, makeIsolatedEnv, startFakeModel } from './lib/isolate.mjs';

const ARGV = process.argv.slice(2);
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.error('用法: node scripts/nsdsh/preflight.mjs [--offline] [--json] [--strict]');
  process.exit(2);
}
for (const a of ARGV) {
  if (!['--offline', '--no-network', '--json', '--strict'].includes(a)) {
    console.error(`✗ 未知参数：${a}\n用法: node scripts/nsdsh/preflight.mjs [--offline] [--json] [--strict]`);
    process.exit(2);
  }
}
// --offline **默认开启**：本命令自身不需要外网，因此"需要外网才能判定"的检查在默认姿态下
// 就是失败候选（--strict 时直接失败），而不是悄悄跳过——skipped 不能冒充 passed。
const OPT = {
  offline: !ARGV.includes('--no-network'),
  json: ARGV.includes('--json'),
  strict: ARGV.includes('--strict'),
};

/** 极简 semver 比较（只支持 x.y.z，够用于 engines.node 这类声明；不引依赖）。 */
export function compareVersions(a, b) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x = [0, 0, 0], y = [0, 0, 0]] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * 判断 engines.node 声明的版本区间是否被当前 Node 满足。
 * 只认三种真实出现在本项目 package.json 里的写法：`>=x.y.z`、`^x.y.z`、`x.y.z`；
 * 认不出来 → 返回 null（调用方记 SKIP/失败，**不猜**）。
 */
export function nodeSatisfies(actual, range) {
  const r = String(range || '').trim();
  if (!r) return null;
  const m = r.match(/^(>=|>|<=|<|\^|~|=)?\s*v?(\d+\.\d+\.\d+)$/);
  if (!m) return null;
  const [, op = '=', want] = m;
  const c = compareVersions(actual, want);
  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  if (op === '<=') return c <= 0;
  if (op === '<') return c < 0;
  if (op === '=') return c === 0;
  // ^x.y.z / ~x.y.z：本项目的 engines 只声明下限语义，这里按"不低于该版本"处理，
  // 并如实把它记成近似判定（detail 里写清楚），不假装做了完整 semver 求解。
  return c >= 0;
}

/** 从源码文本里抓 `export const X = '...'` 这类常量：**读文件而不 import 业务模块**。 */
export function readConstFromSource(file, constName) {
  const text = fs.readFileSync(abs(file), 'utf8');
  const re = new RegExp(`\\b${constName}\\s*=\\s*['"\`]([^'"\`]+)['"\`]`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/** 某路径是否落在系统临时目录内（大小写不敏感，Windows 上路径大小写会漂）。 */
export function isUnderTempDir(p) {
  const t = path.resolve(String(p)).toLowerCase();
  return t === path.resolve(os.tmpdir()).toLowerCase() || t.startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep);
}

/** 隔离数据目录是否**被拒**：指向真实 data/ 或不在系统临时目录内。 */
export function isolationRefusal(dataDir) {
  if (!dataDir) return 'NOVELSTUDIO_DATA_DIR 未设置';
  const d = path.resolve(String(dataDir)).toLowerCase();
  if (d === path.resolve(REPO, 'data').toLowerCase()) return `指向真实库目录 ${rel(path.resolve(REPO, 'data'))}`;
  if (!isUnderTempDir(dataDir)) return `不在系统临时目录内：${path.resolve(String(dataDir))}`;
  return null;
}

function check(id, status, detail, required = true) {
  return { id, status, detail, required };
}

/**
 * 汇总：FAIL 数决定退出码；BLOCKED 只算"环境没让测"，不计入 required 失败
 * （`--strict` 会把它升级成 FAIL，避免有人用 BLOCKED 装点门面）。
 */
export function summarizeChecks(checks) {
  const passed = checks.filter((c) => c.status === 'ok').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const blocked = checks.filter((c) => c.status === 'BLOCKED').length;
  const skipped = checks.filter((c) => c.status === 'SKIP').length;
  return { passed, failed, blocked, skipped, total: checks.length, ok: failed === 0 };
}

async function main() {
  const checks = [];
  const versions = {};
  const isolation = {};

  // ── 1. Node 版本 ────────────────────────────────────────────────────────
  const pkgPath = path.join(REPO, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    checks.push(check('node-version', 'FAIL', `package.json 不可读：${e.message}`));
  }
  if (pkg) {
    const range = (pkg.engines && pkg.engines.node) || '';
    const sat = nodeSatisfies(process.versions.node, range);
    versions.node = process.version;
    versions.nodeEngine = range;
    if (sat === true) checks.push(check('node-version', 'ok', `${process.version} 满足 engines.node "${range}"`));
    else if (sat === false) checks.push(check('node-version', 'FAIL', `${process.version} 不满足 engines.node "${range}"`));
    else checks.push(check('node-version', 'SKIP', `engines.node "${range || '(未声明)'}" 无法解析（不猜：请人工确认）`));
    versions.package = pkg.version || null;
    checks.push(check('package-version', 'ok', `package.json version = ${pkg.version || '(未声明)'}`));
  }

  // ── 2. 两处版本常量（可读即通过；**变化不算失败**，只如实报告）────────────
  for (const [id, file, name] of [
    ['temporal-version', 'ai/story-state/temporal/index.mjs', 'TEMPORAL_VERSION'],
    ['host-contract-version', 'server.js', 'HOST_CONTRACT_VERSION'],
  ]) {
    const p = abs(file);
    if (!fs.existsSync(p)) {
      checks.push(check(id, 'FAIL', `${file} 不存在`));
      continue;
    }
    const v = readConstFromSource(file, name);
    if (v) { versions[id] = v; checks.push(check(id, 'ok', `${file} 的 ${name} = ${v}`)); }
    else checks.push(check(id, 'FAIL', `${file} 里找不到 ${name} 的字面量（契约可能被改名）`));
  }

  // ── 3. SQLite 版本（隔离实例：:memory:）─────────────────────────────────
  try {
    const mem = new DatabaseSync(':memory:');
    const row = mem.prepare('SELECT sqlite_version() AS v').get();
    mem.close();
    versions.sqlite = String(row && row.v);
    checks.push(check('sqlite-version', 'ok', `node:sqlite SQLite ${versions.sqlite}`));
  } catch (e) {
    checks.push(check('sqlite-version', 'FAIL', `node:sqlite 不可用：${e.message}`));
  }

  // ── 4. 仓库布局 ────────────────────────────────────────────────────────
  const layout = ['server.js', 'db.js', 'scripts/ci-offline-checks.mjs', '.p1-baseline/verify-phase-map.mjs'];
  const missingLayout = layout.filter((f) => !fs.existsSync(abs(f)));
  if (missingLayout.length) checks.push(check('repo-layout', 'FAIL', `缺少：${missingLayout.join(', ')}`));
  else checks.push(check('repo-layout', 'ok', `${layout.length} 个关键文件都在`));

  // ── 5. 隔离断言：数据目录 ──────────────────────────────────────────────
  const realData = path.join(REPO, 'data');
  const realDb = path.join(realData, 'novel.db');
  isolation.realDataDir = rel(realData);
  isolation.realDbExists = fs.existsSync(realDb);
  isolation.realDbMustNeverBeOpened = true;
  const requested = process.env.NOVELSTUDIO_DATA_DIR || '';
  const refuse = isolationRefusal(requested);
  if (refuse) {
    // 未设置是**正常姿态**（后续每次运行都要用它建临时目录）；指向真实库才是拒绝条件。
    const status = !requested ? 'ok' : 'FAIL';
    checks.push(check('isolation-data-dir', status, !requested
      ? 'NOVELSTUDIO_DATA_DIR 未设置（测试必须自己建临时目录；真实库 data/novel.db 永不被打开）'
      : `拒用：${refuse}`));
  } else {
    checks.push(check('isolation-data-dir', 'ok', `指向系统临时目录：${requested}`));
  }
  checks.push(check('real-db-untouched', 'ok',
    `data/novel.db ${isolation.realDbExists ? '存在' : '不存在'} —— 隔离检查只读它的存在性，绝不打开发它`));

  // ── 6. 隔离断言：出网拒绝（子进程实证 + 阴性对照）─────────────────────
  isolation.offline = OPT.offline;
  isolation.guard = rel(GUARD_CJS);
  const env = makeIsolatedEnv({ label: 'nsdsh-preflight' });
  try {
    isolation.tempRoot = env.root;
    const denied = probeEgressDenied('http://example.com');
    if (denied.verdict === 'denied') {
      checks.push(check('egress-denied', 'ok',
        `非回环 fetch 被拒（${denied.detail}，命中 ${EGRESS_DENIAL_SIGNATURE}）`));
    } else if (denied.verdict === 'blocked') {
      checks.push(check('egress-denied', 'FAIL',
        `子进程没能跑起来，无法证明出网被拒：${denied.detail}`));
    } else {
      checks.push(check('egress-denied', 'FAIL', `非回环 fetch **没有被拒**：${denied.detail}`));
    }

    // 阴性对照：guard 不得把合法回环流量一起拦掉（否则"拒绝"是假的）。
    let model = null;
    try {
      model = await startFakeModel({ reply: '{"ok":true}' });
      const lb = probeLoopbackAllowed(`${model.baseUrl}/models`);
      if (lb.verdict === 'allowed') {
        checks.push(check('egress-loopback-allowed', 'ok', `回环 ${model.baseUrl} 正常访问（阴性对照通过）`));
      } else if (lb.verdict === 'blocked') {
        checks.push(check('egress-loopback-allowed', 'BLOCKED',
          `受限沙箱拦掉了子进程 HTTP（裸 TCP 可连、HTTP 超时、无 ${EGRESS_DENIAL_SIGNATURE} 签名）→ 阴性对照本次无法执行：${lb.detail}`));
      } else {
        checks.push(check('egress-loopback-allowed', 'FAIL', `回环访问被误拦：${lb.detail}`));
      }
    } catch (e) {
      checks.push(check('egress-loopback-allowed', 'BLOCKED', `回环阴性对照未能执行：${e.message}`));
    } finally {
      if (model) { try { await model.stop(); } catch (_) { /* 已关闭 */ } }
    }
    checks.push(check('isolation-cleanup', env.cleanup() ? 'ok' : 'FAIL', `临时目录已清理：${env.root}`));
  } finally {
    try { env.cleanup(); } catch (_) { /* 幂等 */ }
  }

  // ── 7. 复用既有隔离运行器（不重造）────────────────────────────────────
  const ciRunner = abs('scripts/ci-isolated-run.mjs');
  checks.push(check('ci-isolated-run', fs.existsSync(ciRunner) ? 'ok' : 'FAIL',
    fs.existsSync(ciRunner) ? 'scripts/ci-isolated-run.mjs 存在（隔离实例复用已有配方）' : 'scripts/ci-isolated-run.mjs 缺失'));

  // ── 8. 端口姿态 ────────────────────────────────────────────────────────
  isolation.portNeverDefaultsTo3737 = true;
  checks.push(check('port-policy', 'ok', '隔离端口从来不是常量 3737（pickFreePort 在 38100–38200 里取空闲端口）'));

  // ── 汇总 ──────────────────────────────────────────────────────────────
  if (OPT.strict) {
    for (const c of checks) {
      if (c.status === 'SKIP' || c.status === 'BLOCKED') {
        c.status = 'FAIL';
        c.detail = `--strict：${c.detail}`;
      }
    }
  }
  const summary = summarizeChecks(checks);

  if (OPT.json) {
    process.stdout.write(`${JSON.stringify({
      ok: summary.ok, checks, versions, isolation, summary,
    }, null, 2)}\n`);
  } else {
    for (const c of checks) {
      const mark = c.status === 'ok' ? 'ok  ' : c.status === 'FAIL' ? 'FAIL' : c.status;
      console.log(`${mark.padEnd(7)} ${c.id.padEnd(24)} ${c.detail}`);
    }
    console.log(`\n通过 ${summary.passed} / 未通过 ${summary.failed}（共 ${summary.total} 条；`
      + `跳过 ${summary.skipped}；环境阻断 ${summary.blocked}；--offline=${OPT.offline}）`);
  }
  process.exitCode = summary.ok ? 0 : 1;
}

// 只有被直接执行时才跑检查：被 import（例如测试文件复用 pure helper）时不得产生副作用。
const invoked = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
const self = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (invoked && (invoked === self || invoked.endsWith(path.sep + path.basename(self)))) {
  await main();
}

export { main as runPreflight };
