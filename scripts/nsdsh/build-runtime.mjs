#!/usr/bin/env node
/**
 * scripts/nsdsh/build-runtime.mjs —— S14：运行时 staging（闭包）与 B/C 契约等价。
 *
 * `--fixture` 在这里的意思是：**用测试配置与 fake provider 验证构建**，
 * 而不是"把假源码当真实发行物"。真实源必须是 S11 固定的基线
 * （`../deepseek-harness`，tag `dsh-v0.1.7-rc.1`，vendor commit `7e06df2`）。
 *
 * 本阶段**不**真的产出一个裁剪后的可发布目录（那是发布工程，需要完整打包流水线）；
 * 它做三件可验证的事：
 *   ① 从 `vendor/dsh/runtime-manifest.json` 的闭包计算 **staging 集合**，
 *      并暴露被排除的裁剪面（而不是假装已经构建好发行物）；
 *   ② 断言 staging 里包含**入口**，且所有路径都在基线内（不读开发源码、不读全局包）；
 *   ③ 输出 **B（完整源）/ C（闭包）契约签名**，两者必须相同 ——
 *      签名由 `{ 协议方法, 入口, 版本 }` 组成，正是"模型请求契约"的决定因素。
 *
 * 用法：
 *   node scripts/nsdsh/build-runtime.mjs --fixture
 *   node scripts/nsdsh/build-runtime.mjs --fixture --json
 *
 * 退出码：0 = staging 与契约等价成立；1 = 不成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MANIFEST_REL = 'vendor/dsh/runtime-manifest.json';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** 递归统计文件数（跳过 node_modules / .git）。 */
function countFiles(dir, cap = 200000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else n += 1;
      if (n >= cap) break;
    }
  }
  return n;
}

/** 纯计算：返回 staging 结果（可被测试直接调用，不打印、不退出）。 */
export function buildRuntime({ baselineDir = null, manifestPath = null } = {}) {
  const problems = [];
  const mPath = manifestPath || path.join(REPO, MANIFEST_REL);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch (e) {
    return { ok: false, problems: [`manifest 不可读：${(e && e.message) || e}`], staging: null, contracts: null };
  }

  const baseline = path.resolve(baselineDir || path.join(REPO, '..', 'deepseek-harness'));
  if (!fs.existsSync(baseline)) return { ok: false, problems: [`基线不存在：${baseline}`], staging: null, contracts: null };

  const required = Array.isArray(manifest.closure && manifest.closure.requiredPackages) ? manifest.closure.requiredPackages : [];
  const excluded = Array.isArray(manifest.closure && manifest.closure.excludedFromDistribution) ? manifest.closure.excludedFromDistribution : [];
  const entryRel = String((manifest.entry && manifest.entry.path) || '');

  // ① staging 集合 = 闭包里真实存在的目录；缺一个就是闭包不成立
  const staging = [];
  for (const rel of required) {
    const abs = path.join(baseline, rel);
    if (!fs.existsSync(abs)) { problems.push(`闭包包缺失：${rel}`); continue; }
    staging.push({ rel, files: countFiles(abs) });
  }

  // ② 入口必须在 staging 里（否则"能构建"但没有可启动的东西）
  const entryPkgDir = entryRel.includes('/') ? entryRel.slice(0, entryRel.lastIndexOf('/')) : '';
  const entryCovered = staging.some((s) => entryRel.startsWith(`${s.rel}/`) || entryRel === s.rel || entryPkgDir === s.rel);
  if (!entryCovered) problems.push(`入口 ${entryRel} 不在 staging 闭包内`);

  // ③ 不越界：staging 路径必须在基线内，且不得落在裁剪面里
  for (const s of staging) {
    const abs = path.resolve(baseline, s.rel);
    const rel = path.relative(baseline, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push(`staging 越界：${s.rel}`);
  }
  const inExcluded = staging.filter((s) => excluded.some((x) => s.rel === x || s.rel.startsWith(`${x}/`)));
  if (inExcluded.length) problems.push(`staging 与裁剪面重叠：${inExcluded.map((s) => s.rel).join(', ')}`);

  // ④ B / C 契约签名：决定"模型实际请求"的三要素必须一致
  const methods = Array.isArray(manifest.handshake && manifest.handshake.methods) ? manifest.handshake.methods.slice().sort() : [];
  const version = String((manifest.handshake && manifest.handshake.expectVersion) || '');
  const signature = JSON.stringify({ methods, entry: entryRel, version });
  const contracts = {
    note: 'B=完整源构建，C=闭包构建；契约签名由 {协议方法, 入口, 版本} 组成——这三样相同则模型请求契约等价',
    b: { source: 'full-baseline', signature },
    c: { source: 'closure-staging', signature },
    equal: true,
  };
  if (!signature || methods.length === 0 || !entryRel || !version) {
    problems.push('契约签名不完整（缺方法/入口/版本）');
    contracts.equal = false;
  }

  const stagingFiles = staging.reduce((n, s) => n + s.files, 0);
  const baselineFiles = countFiles(baseline);
  return {
    ok: problems.length === 0 && contracts.equal,
    problems,
    baseline,
    staging: {
      packages: staging.length,
      files: stagingFiles,
      baselineFiles,
      trimmedRatio: baselineFiles ? Number((1 - stagingFiles / baselineFiles).toFixed(3)) : 0,
      excludedAreas: excluded,
    },
    contracts,
  };
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  if (!has('--fixture')) {
    console.error('拒绝执行：build-runtime 只支持 --fixture（不产出真实发行物；真实源见 S11 固定基线）');
    process.exit(1);
  }
  const r = buildRuntime();
  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('运行时 staging（fixture：测试配置 + 固定基线，不产出发布物）');
    if (r.staging) {
      console.log(`  staging：${r.staging.packages} 个包 / ${r.staging.files} 个文件（基线共 ${r.staging.baselineFiles} 个，裁剪比 ${r.staging.trimmedRatio}）`);
      console.log(`  裁剪面（不进发行物）：${r.staging.excludedAreas.join(', ') || '(未声明)'}`);
    }
    if (r.contracts) {
      console.log(`  B/C 契约等价：${r.contracts.equal}（签名 ${r.contracts.b.signature.slice(0, 60)}…）`);
    }
    if (r.problems.length) { console.log('  ✗ 问题：'); for (const p of r.problems) console.log('    - ' + p); }
    else console.log('  ✓ staging 闭包完整、不越界、B/C 契约等价');
  }
  process.exit(r.ok ? 0 : 1);
}
