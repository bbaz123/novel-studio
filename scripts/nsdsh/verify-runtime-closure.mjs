#!/usr/bin/env node
/**
 * scripts/nsdsh/verify-runtime-closure.mjs —— S14：运行时闭包与 manifest 校验（修 F10）。
 *
 * 病灶（F10）：`harness.js` 的 `isHarnessBuilt()` 只检查**两个生成文件**是否存在
 *   `packages/interaction/commands/lib/typert.host.js`
 *   `packages/goal/goal/lib/typert.host.js`
 * 于是"构建好了"= "这两个文件在"。它既不检查**入口**是否存在、也不检查**版本**对不对、
 * 更不检查依赖闭包是否完整 —— 一个半构建、版本错配、或依赖缺失的树照样被判"就绪"。
 *
 * 本脚本用**manifest + 明确入口 + 协议握手**替代那个判据：
 *   ① manifest 存在且与 `vendor/dsh/PROVENANCE.md` 记录的基线一致（tag / vendor commit）；
 *   ② **入口**真的存在（`apps/cli/lib/bin.js`，缺失时回落到 dev 入口并如实标注）；
 *   ③ **版本握手**：基线 `package.json` 的 version 必须等于 manifest 期望值；
 *   ④ **依赖闭包**：manifest 声明的每个包都真的在工作区里；
 *   ⑤ **许可**齐全；
 *   ⑥ **不越界**：manifest 里所有路径都必须落在基线目录内（禁止指向开发源码或全局包）。
 *
 * 用法：
 *   node scripts/nsdsh/verify-runtime-closure.mjs
 *   node scripts/nsdsh/verify-runtime-closure.mjs --json
 *   node scripts/nsdsh/verify-runtime-closure.mjs --baseline <dir>
 *
 * 退出码：0 = 全部成立；1 = 有失败（门禁应据此判红）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MANIFEST_REL = 'vendor/dsh/runtime-manifest.json';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

/** 纯校验函数（可被测试直接调用，不打印、不退出）。 */
export function verifyClosure({ baselineDir = null, manifestPath = null } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const mPath = manifestPath || path.join(REPO, MANIFEST_REL);

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    add('runtime manifest 存在且可解析', true, mPath);
  } catch (e) {
    add('runtime manifest 存在且可解析', false, `${mPath}：${(e && e.message) || e}`);
    return { ok: false, checks, manifest: null };
  }

  add('manifest 有版本号', typeof manifest.version === 'string' && manifest.version.length > 0, manifest.version || '');

  // ① 与 PROVENANCE 记录一致
  const baseline = path.resolve(baselineDir || path.join(REPO, '..', 'deepseek-harness'));
  const provPath = path.join(REPO, 'vendor/dsh/PROVENANCE.md');
  let prov = '';
  try { prov = fs.readFileSync(provPath, 'utf8'); } catch { prov = ''; }
  const tag = String((manifest.baseline && manifest.baseline.tag) || '');
  const commit = String((manifest.baseline && manifest.baseline.vendor_commit) || '');
  add('manifest 记录了基线与来源文件',
    !!tag && !!commit && String((manifest.baseline && manifest.baseline.provenance) || '').includes('PROVENANCE'),
    `tag=${tag} commit=${commit}`);
  add('manifest 的 tag/commit 与 PROVENANCE.md 一致',
    !!prov && prov.includes(tag) && prov.includes(commit),
    prov ? '一致' : 'PROVENANCE.md 不可读');

  if (!fs.existsSync(baseline)) {
    add('基线目录存在', false, baseline);
    return { ok: false, checks, manifest };
  }
  add('基线目录存在', true, baseline);

  // ② 入口存在（先 built，再 dev 回落）
  const entry = manifest.entry || {};
  const builtRel = String(entry.path || '');
  const devRel = String(entry.devEntry || '');
  const builtAbs = builtRel ? path.join(baseline, builtRel) : '';
  const devAbs = devRel ? path.join(baseline, devRel) : '';
  const hasBuilt = !!builtAbs && fs.existsSync(builtAbs);
  const hasDev = !!devAbs && fs.existsSync(devAbs);
  add('入口存在（构建产物优先，缺失时回落开发入口并如实标注）', hasBuilt || hasDev,
    hasBuilt ? `built: ${builtRel}` : (hasDev ? `dev(未构建): ${devRel}` : `两者都缺：${builtRel} / ${devRel}`));

  // ③ 版本握手
  let pkgVersion = '';
  try { pkgVersion = String(JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'), 'utf8')).version || ''); } catch { pkgVersion = ''; }
  const expectVersion = String((manifest.handshake && manifest.handshake.expectVersion) || '');
  add('版本握手：基线 package.json 版本与 manifest 期望一致',
    !!pkgVersion && !!expectVersion && pkgVersion === expectVersion,
    `基线=${pkgVersion} 期望=${expectVersion}`);

  // ④ 协议握手：manifest 声明的请求方法必须与上游真实协议面一致
  const declaredMethods = Array.isArray(manifest.handshake && manifest.handshake.methods) ? manifest.handshake.methods : [];
  const upperBound = ['initialize', 'session/prompt', 'shutdown'];
  const invented = declaredMethods.filter((m) => !upperBound.includes(String(m)));
  add('协议握手只声明上游真实存在的方法（不发明 API）',
    declaredMethods.length > 0 && invented.length === 0,
    invented.length ? `多出：${invented.join(',')}` : declaredMethods.join(' / '));

  // ⑤ 依赖闭包：声明的每个包都真的在工作区里
  const required = Array.isArray(manifest.closure && manifest.closure.requiredPackages) ? manifest.closure.requiredPackages : [];
  const missingPkgs = required.filter((rel) => !fs.existsSync(path.join(baseline, String(rel))));
  add('依赖闭包完整：manifest 声明的每个包都在基线里',
    required.length > 0 && missingPkgs.length === 0,
    missingPkgs.length ? `缺：${missingPkgs.join(', ')}` : `${required.length} 个包`);

  // ⑥ 许可
  const licRel = String((manifest.license && manifest.license.file) || 'LICENSE');
  const licAbs = path.join(baseline, licRel);
  const licOk = fs.existsSync(licAbs) && fs.statSync(licAbs).size > 100;
  add('许可文件齐全（非空）', licOk, licOk ? `${licRel} ${fs.statSync(licAbs).size} 字节` : `缺或为空：${licRel}`);

  // ⑦ 不越界：manifest 里的所有路径都必须在基线内（禁止指向开发源码目录或全局包）
  const outside = [];
  const checkInside = (rel, label) => {
    if (!rel) return;
    const abs = path.resolve(baseline, String(rel));
    const relToBase = path.relative(baseline, abs);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) outside.push({ label, rel });
  };
  checkInside(builtRel, 'entry.path');
  checkInside(devRel, 'entry.devEntry');
  checkInside(licRel, 'license.file');
  for (const rel of required) checkInside(rel, 'closure.requiredPackages');
  add('所有 manifest 路径都在基线目录内（不读开发源码/全局包）', outside.length === 0,
    outside.length ? `越界：${outside.map((x) => `${x.label}=${x.rel}`).join(', ')}` : '全部在基线内');

  return { ok: checks.every((c) => c.ok), checks, manifest, baseline, built: hasBuilt, devOnly: !hasBuilt && hasDev };
}

export function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  const r = verifyClosure({ baselineDir: val('--baseline', null) });
  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`运行时闭包校验（manifest: ${MANIFEST_REL}）`);
    for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (r.devOnly) console.log('  注：只有开发入口（未构建）—— 发行物必须用构建产物。');
  }
  process.exit(r.ok ? 0 : 1);
}
