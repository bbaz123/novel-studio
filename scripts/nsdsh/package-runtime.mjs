#!/usr/bin/env node
/**
 * scripts/nsdsh/package-runtime.mjs —— R02：真正产出**可解压、可运行**的裁剪发行物。
 *
 * 与 `build-runtime.mjs --fixture` 的根本区别（方案 §1.1 点名的缺口）：
 *   · fixture 版**不写任何目录**，只从 manifest 统计包数与"裁剪比例"；
 *   · 本脚本**真的把文件复制出来**、真的生成 ZIP、真的算 SHA-256、真的写出文件清单。
 *
 * 打包策略（"闭包"具体指什么，写清楚免得变成口号）：
 *   ① 从 `vendor/dsh/runtime-manifest.json` 的 `closure.requiredPackages` 出发；
 *   ② 每个包只带**运行时需要的东西**：`package.json`、`lib/**`、包根 `*.yml`、
 *      `assets/`/`resources/`/`bin/`（存在才带）；`src/`、`tests/`、`node_modules/`、
 *      `tsconfig*`、`*.tsbuildinfo` 一律不带；
 *   ③ 依赖按 `dependencies` + `peerDependencies` 递归展开，**扁平化**放到发行根
 *      `node_modules/<name>`，于是不需要任何 symlink/junction —— 这是"可解压即用"的前提；
 *   ④ 每个包都记文件数与字节数；最后的 manifest 记上游 SHA、平台、Node 范围、入口、
 *      逐文件 sha256 摘要与许可位置。
 *
 * 明确不做：不删源码包（那是方案禁止的"为比例删包"）、不改上游树、不联网。
 *
 * 用法：
 *   node scripts/nsdsh/package-runtime.mjs --output <dir> [--archive <zip>] [--json]
 * 退出码：0 = 产出成功；1 = 失败（缺入口/缺依赖/超上限）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { writeZip } from './lib/zip-archive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/** 总字节上限：防止"顺手把整个仓库打进去"这类事故。超出即失败，不静默截断。 */
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/**
 * 明确排除的可选原生套件。
 *
 * 这不是"为了凑比例删包"（方案禁止）：每一条都写明**为什么不需要**与**缺了会怎样**，
 * 并进入发行物清单的 `excluded` 字段，可审计。
 * 目前只有一条：Office 技能的可选 LibreOffice 原生套件实测 325MB，
 * 而 sdk / sdk-minimal profile 根本不挂载 skill-office。
 */
export const EXCLUDED_OPTIONAL_BUNDLES = Object.freeze([
  {
    pattern: /^@deepseek-ai[/]libreoffice-kit-/,
    reason: 'Office 技能的可选原生套件（实测 325MB）；sdk/sdk-minimal profile 不挂载 skill-office。需要 Office 能力时使用完整构建 B。',
    capabilityImpact: 'docx/pptx/xlsx 技能在此发行物中不可用',
  },
]);

/** 包内只带这些（其余一律不带）。`**` 表示整棵子树。 */
const PACKAGE_INCLUDE = ['package.json', 'lib/**', 'assets/**', 'resources/**', 'bin/**'];
const PACKAGE_INCLUDE_ROOT_FILE = /\.(ya?ml|json)$/;

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

/**
 * 统一成正斜杠。
 * 刻意用 `String.fromCharCode(92)` 而不是反斜杠字面量：这个文件经过多层字符串转义
 * （shell / heredoc / 编辑器），反斜杠字面量被吃掉过一次，直接把源码变成语法错误。
 * 用码点表达可以绕开所有转义层。
 */
const BACKSLASH = String.fromCharCode(92);
function toPosix(p) { return String(p).split(BACKSLASH).join('/'); }

function walkFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(abs, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * 判断某个路径是不是目录 —— **必须跟随 symlink**。
 * pnpm 的 node_modules 里包全是 symlink，用 Dirent.isDirectory() 会返回 false，
 * 于是"依赖明明装着却一个都找不到"（第一版就是这样漏掉 commander/js-yaml 的）。
 */
function isDir(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

/** 该包目录里是否有原生绑定（`.node`）。用于判定可选依赖是否必须随发行物走。 */
function hasNativePayload(dir, depth = 0) {
  if (depth > 3) return false;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of items) {
    if (e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.name.endsWith('.node') && fs.existsSync(abs)) return true;
    if (isDir(abs) && hasNativePayload(abs, depth + 1)) return true;
  }
  return false;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 建立索引（**只扫"候选产物来源"**，不扫 pnpm 虚拟存储）。
 *
 * ⚠️ 两个真实踩过的坑，别退回去：
 *   ① `closure.requiredPackages` 里存的是**目录路径**（`apps/cli`、`packages/bundle/sdk-app`），
 *      不是 `package.json` 的 name。按 name 建索引会"78 个包一个都找不到"。
 *   ② 曾经试图把每个包的 `node_modules`（以及 pnpm 的 `.pnpm/<id>/node_modules`）全扫进索引，
 *      结果候选数从几百涨到 **7 万**，还因为防御上限提前 break 而漏掉 `shebang-command` 这类真依赖。
 *      正确做法是**按需解析**：谁要依赖 X，就按 Node 的查找规则从那个包出发往上找 X。
 *      （见 `resolveDepEntry`。）
 */
export function buildPackageIndex(baselineRoot) {
  const byDir = new Map();
  const byName = new Map();
  const candidates = [];

  const addDir = (dir) => {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg || typeof pkg.name !== 'string' || !pkg.name) return null;
    const rel = toPosix(path.relative(baselineRoot, dir));
    const entry = { name: pkg.name, dir, pkg, rel };
    candidates.push(entry);
    if (!byDir.has(rel)) byDir.set(rel, entry);
    if (!byName.has(pkg.name)) byName.set(pkg.name, entry);
    return entry;
  };

  // ① packages/**（一层分组 + 两层分组都覆盖）
  const pkgsRoot = path.join(baselineRoot, 'packages');
  if (fs.existsSync(pkgsRoot)) {
    for (const group of fs.readdirSync(pkgsRoot, { withFileTypes: true })) {
      const gdir = path.join(pkgsRoot, group.name);
      if (!isDir(gdir)) continue;
      if (fs.existsSync(path.join(gdir, 'package.json'))) addDir(gdir);
      for (const sub of fs.readdirSync(gdir, { withFileTypes: true })) {
        const sdir = path.join(gdir, sub.name);
        if (isDir(sdir)) addDir(sdir);
      }
    }
  }
  // ② apps/*
  const appsRoot = path.join(baselineRoot, 'apps');
  if (fs.existsSync(appsRoot)) {
    for (const a of fs.readdirSync(appsRoot, { withFileTypes: true })) {
      const adir = path.join(appsRoot, a.name);
      if (isDir(adir)) addDir(adir);
    }
  }
  // ③ vendor/*（@deepseek-ai/cordis、schemastery 等就在这里）
  const vendorRoot = path.join(baselineRoot, 'vendor');
  if (fs.existsSync(vendorRoot)) {
    for (const v of fs.readdirSync(vendorRoot, { withFileTypes: true })) {
      const vdir = path.join(vendorRoot, v.name);
      if (isDir(vdir)) addDir(vdir);
    }
  }

  return { byDir, byName, entries: candidates, addDir };
}

/**
 * 按 Node 的模块查找规则，从某个包出发解析依赖 `name`。
 *
 * 顺序与 Node 一致：`<from>/node_modules/<name>`，然后逐级往上每层的 `node_modules/<name>`。
 * 起点用 **realpath**：pnpm 的符号链接路径下没有兄弟依赖，真实路径往上才找得到。
 *
 * @returns `{ name, dir, pkg, rel } | null`
 */
export function resolveDepEntry(baselineRoot, fromDir, name) {
  let realFrom = fromDir;
  try { realFrom = fs.realpathSync(fromDir); } catch { /* 用原路径 */ }
  let cursor = realFrom;
  for (let up = 0; up < 12; up += 1) {
    const candidate = path.join(cursor, 'node_modules', name);
    const pkgPath = path.join(candidate, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg && pkg.name) {
        return { name: pkg.name, dir: candidate, pkg, rel: toPosix(path.relative(baselineRoot, candidate)) };
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * 计算闭包（含传递依赖）。
 *
 * 规则（写清楚，否则"闭包"会变成口号）：
 *   · `dependencies` —— **必带**；
 *   · `peerDependencies` —— 只带**非 optional** 的（`peerDependenciesMeta[x].optional === true` 跳过）。
 *     cordis 插件生态里可选 peer 大量存在（ajv 的 regexpp、编辑器工具…），
 *     全量展开会把发行物变成"整个 monorepo"，而它们在运行路径上并不被 require。
 *
 * @returns `{ packages, missing, missingDeps, skippedOptionalPeers }`
 */
export function resolveClosure({ manifest, index, baselineRoot }) {
  const rootPaths = (manifest.closure && manifest.closure.requiredPackages) || [];
  const packages = new Map();
  const missing = [];
  const missingDeps = [];
  const skippedOptionalPeers = [];
  const skippedOptionalDeps = [];
  const excludedBundles = [];
  const queue = [];

  for (const rel of rootPaths) {
    const key = toPosix(String(rel));
    const hit = index.byDir.get(key);
    if (!hit) { missing.push(rel); continue; }
    queue.push(hit);
  }

  const claim = (entry) => {
    if (!entry || packages.has(entry.name)) return null;
    packages.set(entry.name, entry);
    return entry;
  };

  // 先按索引解析（根包、vendor、packages 都在索引里），解析不到再按 Node 规则现场找
  const depOf = (hit, dep) => index.byName.get(dep) || resolveDepEntry(baselineRoot, hit.dir, dep);

  while (queue.length) {
    const hit = queue.shift();
    if (packages.has(hit.name)) continue;
    packages.set(hit.name, hit);

    for (const dep of Object.keys(hit.pkg.dependencies || {})) {
      if (packages.has(dep)) continue;
      const target = depOf(hit, dep);
      if (!target) { missingDeps.push(`${hit.name}→${dep}`); continue; }
      queue.push(target);
    }
    // optionalDependencies：**只带本机装得上的**（pnpm 只安装平台匹配的那几个）。
    // 方案 §4.2 要求"必要平台原生资源"必须随发行物走——本项目实测踩到：
    // node-addon-require-builtin 的原生绑定在 node-addon-native-custom-loader-win32-x64-msvc 里，
    // 不遍历 optionalDependencies 就会在别的机器上启动即 "No usable native binding found"。
    for (const dep of Object.keys(hit.pkg.optionalDependencies || {})) {
      if (packages.has(dep)) continue;
      const target = depOf(hit, dep);
      if (!target) continue; // 本机没装（平台不匹配）——正常，跳过
      // 只带"装着原生绑定"或"平台专用"的可选包。全部可选依赖都带会把发行物撑到 480MB
      // （实测：一旦全量遍历，某个打包器的可选依赖树立刻把档案顶穿上限）。
      const excluded = EXCLUDED_OPTIONAL_BUNDLES.find((x) => x.pattern.test(dep));
      if (excluded) { excludedBundles.push({ name: dep, reason: excluded.reason, capabilityImpact: excluded.capabilityImpact }); continue; }
      if (hasNativePayload(target.dir) || /-(win32|darwin|linux|freebsd|android)-/.test(dep)) {
        queue.push(target);
      } else {
        skippedOptionalDeps.push(dep);
      }
    }
    const meta = hit.pkg.peerDependenciesMeta || {};
    for (const dep of Object.keys(hit.pkg.peerDependencies || {})) {
      if (packages.has(dep)) continue;
      if (meta[dep] && meta[dep].optional === true) { skippedOptionalPeers.push(`${hit.name}→${dep}`); continue; }
      const target = depOf(hit, dep);
      if (!target) { missingDeps.push(`${hit.name}→peer:${dep}`); continue; }
      queue.push(target);
    }
  }

  return { packages, missing, missingDeps, skippedOptionalPeers, skippedOptionalDeps, excludedBundles };
}

/**
 * 一个包要带哪些相对路径（相对包根）。
 *
 * ⚠️ 一等的坑：第三方包**不遵守**我们自己的 `lib/` 约定。
 * 第一版对所有包都用"只带 lib/"的规则，于是 `js-yaml` 的 `dist/js-yaml.mjs` 没被带上，
 * 从档案启动时直接 ERR_MODULE_NOT_FOUND —— 而"结构与依赖自足"检查（D5）当时全绿，
 * 因为它只查 package.json 声明的依赖有没有目录，查不出"目录在但产物文件被剪掉"。
 * 所以：**第一方按 lib/ 规则裁剪，第三方保留完整产物**（只剪 node_modules / 测试 / sourcemap）。
 *
 * @param relFiles 包内相对路径
 * @param thirdParty 该包是否来自第三方（不在 packages/ apps/ vendor/ 下）
 */
export function packagePayload(relFiles, { thirdParty = false } = {}) {
  const keep = [];
  for (const rel of relFiles) {
    if (rel.startsWith('node_modules/')) continue;
    if (thirdParty) {
      if (rel.endsWith('.map')) continue;
      if (rel.startsWith('tests/') || rel.startsWith('test/') || rel.startsWith('.github/')) continue;
      if (rel.endsWith('.tsbuildinfo')) continue;
      keep.push(rel);
      continue;
    }
    if (rel.startsWith('src/') || rel.startsWith('tests/') || rel.startsWith('test/')) continue;
    // .d.ts 是类型声明（对外契约的一部分），不能被 '.ts' 一刀切掉 —— 第一版就是这么丢的。
    if (rel.endsWith('.tsbuildinfo')) continue;
    if (rel.endsWith('.ts') && !rel.endsWith('.d.ts')) continue;
    if (/^tsconfig.*[.]json$/.test(rel)) continue;
    if (rel.startsWith('lib/')) { keep.push(rel); continue; }
    if (rel.startsWith('assets/') || rel.startsWith('resources/') || rel.startsWith('bin/')) { keep.push(rel); continue; }
    if (!rel.includes('/') && PACKAGE_INCLUDE_ROOT_FILE.test(rel)) { keep.push(rel); continue; }
  }
  return keep;
}

/**
 * 打包。
 * @returns `{ ok, output, archive, archiveSha256, bytes, fileCount, packages, missing, manifest }`
 */
export function packageRuntime({
  output,
  archive = null,
  manifestPath = path.join(REPO, 'vendor/dsh/runtime-manifest.json'),
  repoRoot = REPO,
  profile = 'sdk',
  now = () => new Date().toISOString(),
  writeZipImpl = writeZip,
} = {}) {
  if (!output) throw new TypeError('MISSING_OUTPUT');
  const manifest = readJson(manifestPath);
  if (!manifest) return { ok: false, reason: 'MANIFEST_UNREADABLE', detail: manifestPath };

  const baselineRoot = path.resolve(repoRoot, manifest.baseline.location);
  const index = buildPackageIndex(baselineRoot);
  const { packages, missing, missingDeps, skippedOptionalPeers, skippedOptionalDeps, excludedBundles } = resolveClosure({ manifest, index, baselineRoot });
  if (missing.length || missingDeps.length) {
    return {
      ok: false, reason: 'CLOSURE_INCOMPLETE',
      detail: `缺 ${missing.length} 个根包（${missing.slice(0, 6).join(', ')}）；缺 ${missingDeps.length} 个依赖（${missingDeps.slice(0, 6).join(', ')}）`,
      missing, missingDeps,
    };
  }

  const stagingAbs = path.resolve(output);
  fs.rmSync(stagingAbs, { recursive: true, force: true });
  fs.mkdirSync(stagingAbs, { recursive: true });

  const zipEntries = [];
  const perPackage = [];
  let totalBytes = 0;

  // 入口包（apps/cli）按原路径放；其余包扁平化到 node_modules/
  const entryRel = String(manifest.entry.path || '');
  // 入口包 = `apps/cli`（manifest 的 entry.path 就指向它）；它保留原目录布局，
  // 其余包扁平化到 node_modules/ —— 于是 `<root>/apps/cli/lib/bin.js` 与 entry.path 逐字一致。
  const entryHit = index.byDir.get('apps/cli');
  const entryPkgName = entryHit ? entryHit.name : null;

  // 入口包**保留原目录**（于是 archive 里就是 apps/cli/lib/bin.js，与 manifest.entry.path 逐字一致）；
  // 其余包扁平化到 node_modules/<name>。Node 从 apps/cli/lib/bin.js 往上找，
  // 第 4 层正好是 <root>/node_modules，所以不需要任何 symlink/junction。
  const placeOf = (name) => (name === entryPkgName ? toPosix(entryHit.rel) : `node_modules/${name}`);

  for (const [name, hit] of packages) {
    const relFiles = walkFiles(hit.dir);
    // 第三方包不遵守 lib/ 约定（js-yaml 用 dist/），必须保留完整产物。
    //
    // ⚠️ 判定必须基于 **realpath**：`apps/cli/node_modules/js-yaml` 这个**符号链接路径**
    // 以 apps/ 开头，按路径判会得出"这是第一方包"，于是它的 dist/ 被剪掉 —— 这正是
    // 第一版档案启动即 ERR_MODULE_NOT_FOUND 的原因。用 realpath（落到 node_modules/.pnpm/…）才判得对。
    let realRel = hit.rel;
    try { realRel = toPosix(path.relative(baselineRoot, fs.realpathSync(hit.dir))); } catch { /* 用原 rel */ }
    const firstParty = realRel.startsWith('packages/') || realRel.startsWith('apps/') || realRel.startsWith('vendor/');
    const thirdParty = !firstParty;
    const payload = packagePayload(relFiles, { thirdParty });
    if (payload.length === 0) { perPackage.push({ name, files: 0, bytes: 0, note: 'NO_PAYLOAD' }); continue; }
    const destRel = placeOf(name);
    let bytes = 0;
    for (const rel of payload) {
      const abs = path.join(hit.dir, rel);
      const data = fs.readFileSync(abs);
      bytes += data.length;
      const zipName = destRel ? `${destRel}/${rel}` : rel;
      zipEntries.push({ name: zipName, data });
      const diskAbs = path.join(stagingAbs, zipName);
      fs.mkdirSync(path.dirname(diskAbs), { recursive: true });
      fs.writeFileSync(diskAbs, data);
    }
    totalBytes += bytes;
    perPackage.push({ name, files: payload.length, bytes, from: path.relative(baselineRoot, hit.dir) || '.' });
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      const top = [...perPackage].sort((x, y) => y.bytes - x.bytes).slice(0, 10)
        .map((x) => `${x.name}=${(x.bytes / 1048576).toFixed(1)}MB`).join(', ');
      return { ok: false, reason: 'ARTIFACT_TOO_LARGE', detail: `${totalBytes} > ${MAX_ARTIFACT_BYTES}；最大的：${top}`, top };
    }
  }

  // 入口必须真的在（否则"打包成功"毫无意义）
  const entryAbs = path.join(stagingAbs, entryRel);
  if (!fs.existsSync(entryAbs)) {
    return { ok: false, reason: 'ENTRY_NOT_PACKAGED', detail: `打包后找不到入口 ${entryRel}` };
  }

  // 许可与声明（分发合规）
  const licenseFrom = path.join(baselineRoot, 'LICENSE');
  if (fs.existsSync(licenseFrom)) {
    const data = fs.readFileSync(licenseFrom);
    zipEntries.push({ name: 'LICENSE', data });
    fs.writeFileSync(path.join(stagingAbs, 'LICENSE'), data);
  }
  const noticesFrom = path.join(baselineRoot, 'THIRD_PARTY_NOTICES.md');
  if (fs.existsSync(noticesFrom)) {
    const data = fs.readFileSync(noticesFrom);
    zipEntries.push({ name: 'THIRD_PARTY_NOTICES.md', data });
    fs.writeFileSync(path.join(stagingAbs, 'THIRD_PARTY_NOTICES.md'), data);
  }

  // 发行物自己的 manifest：把"它是从哪来的"钉死
  const fileHashes = zipEntries
    .map((e) => `${sha256(e.data)}  ${e.name}`)
    .sort()
    .join('\n');
  const artifactManifest = {
    version: 'runtime-distribution-v1',
    generated_at: now(),
    upstream: {
      tag: manifest.baseline.tag,
      upstream_commit: manifest.baseline.upstream_commit,
      vendor_commit: manifest.baseline.vendor_commit,
      provenance: manifest.baseline.provenance,
    },
    target: { platform: process.platform, arch: process.arch, node: process.version },
    node_requirement: { runtime: '>=22.13.0', built_with: process.version },
    entry: { path: entryRel, launcher: 'node', profile },
    counts: { packages: packages.size, files: zipEntries.length + 1, bytes: totalBytes },
    files_digest: sha256(Buffer.from(fileHashes, 'utf8')),
    license: fs.existsSync(path.join(stagingAbs, 'LICENSE')) ? 'LICENSE' : null,
    third_party_notices: fs.existsSync(path.join(stagingAbs, 'THIRD_PARTY_NOTICES.md')) ? 'THIRD_PARTY_NOTICES.md' : null,
    excluded: excludedBundles,
    packages: perPackage.sort((a, b) => a.name.localeCompare(b.name)),
  };
  const manifestData = Buffer.from(`${JSON.stringify(artifactManifest, null, 2)}\n`, 'utf8');
  zipEntries.push({ name: 'runtime-manifest.json', data: manifestData });
  fs.writeFileSync(path.join(stagingAbs, 'runtime-manifest.json'), manifestData);

  // 发行根 package.json：声明 ESM，保证 `<entry>` 以 module 语义加载
  const rootPkg = { name: 'novel-studio-dsh-runtime', private: true, type: 'module', version: manifest.baseline.tag || '0.0.0' };
  const rootPkgData = Buffer.from(`${JSON.stringify(rootPkg, null, 2)}\n`, 'utf8');
  if (!zipEntries.some((e) => e.name === 'package.json')) {
    zipEntries.push({ name: 'package.json', data: rootPkgData });
    fs.writeFileSync(path.join(stagingAbs, 'package.json'), rootPkgData);
  }

  let archiveAbs = null;
  let archiveSha256 = null;
  let archiveBytes = null;
  if (archive) {
    archiveAbs = path.resolve(archive);
    fs.mkdirSync(path.dirname(archiveAbs), { recursive: true });
    const zipBuf = writeZipImpl(zipEntries);
    fs.writeFileSync(archiveAbs, zipBuf);
    archiveSha256 = sha256(zipBuf);
    archiveBytes = zipBuf.length;
  }

  return {
    ok: true,
    output: stagingAbs,
    archive: archiveAbs,
    archiveSha256,
    archiveBytes,
    bytes: totalBytes,
    fileCount: zipEntries.length,
    packages: perPackage.length,
    missing: [],
    manifest: artifactManifest,
    skippedOptionalPeers,
    skippedOptionalDeps,
    excludedBundles,
    warnings: packages.size && entryPkgName === null ? ['ENTRY_PACKAGE_NAME_UNKNOWN'] : [],
  };
}

function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (isDirectRun()) {
  const output = arg('--output');
  const archive = arg('--archive');
  if (!output) {
    console.error('用法：node scripts/nsdsh/package-runtime.mjs --output <dir> [--archive <zip>] [--json]');
    process.exit(1);
  }
  const r = packageRuntime({ output, archive });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else if (!r.ok) {
    console.error(`✗ 打包失败：${r.reason} — ${r.detail}`);
  } else {
    const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
    console.log('DSH 裁剪发行物（真实产出，不是估算）');
    console.log(`  上游：${r.manifest.upstream.tag} / ${r.manifest.upstream.vendor_commit}`);
    console.log(`  目标：${r.manifest.target.platform}-${r.manifest.target.arch} / node ${r.manifest.target.node}`);
    console.log(`  入口：${r.manifest.entry.path}（profile ${r.manifest.entry.profile}）`);
    console.log(`  包：${r.packages} 个；文件：${r.fileCount} 个；净体积：${mb(r.bytes)}`);
    if (r.archive) console.log(`  归档：${r.archive}（${mb(r.archiveBytes)}）sha256=${r.archiveSha256}`);
    console.log(`  目录：${r.output}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  }
  process.exit(r.ok ? 0 : 1);
}
