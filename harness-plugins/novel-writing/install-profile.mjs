#!/usr/bin/env node
/**
 * novel-writing bundle 的 profile 接线器（零依赖，仅用 node 内置模块）。
 *
 * 背景：P0 专用运行时。过去 novel-writing 靠 install.ps1 把一段补丁**合并进**
 * profile 的 cordis.patch.yml，并把 novel-tools.mjs **复制**到 profile 目录；
 * 这两件事各自带来问题：区块合并要按标记行裁剪（旧版裁剪会吞掉用户后加的条目），
 * 复制副本会与仓库源发生版本漂移（实测 novel-tools.mjs 的 PLUGIN_VERSION 与
 * plugin.json 的 version 已经不一致）。
 *
 * 现在改为标准 dsh bundle：本目录就是一个包（package.json 的
 * dsh.bundle.patch -> ./cordis.patch.yml），profile 只做三件事——
 *   1) 在 dsh.profile.bundles 里列出 novel-writing；
 *   2) 在 node_modules 下放一个指向本目录的 junction（仓库即唯一来源，无副本）；
 *   3) 自己什么都不用写进 cordis.patch.yml（保持干净的用户层）。
 *
 * 用法：
 *   node install-profile.mjs --profile novel               # 接线
 *   node install-profile.mjs --profile novel --dry-run     # 预演，不写任何文件
 *   node install-profile.mjs --profile novel --uninstall   # 撤销接线
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_NAME = 'novel-writing';
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// 旧版安装留下的区块标记（与 install.ps1 保持一致）
const BLOCK_START = '# ═══ Novel Studio 创作内核注入（headless）═══════════════════════════════════';
const BLOCK_END = '# ═══ 区块结束 ═══';
const LEGACY_MARKER = 'Novel Studio 创作内核注入';

const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

const PATCH_YML = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# novel-writing 的创作人设、novel_* 工具与瘦身条目已下沉到 bundle 层
# （dsh.profile.bundles 里的 novel-writing -> 本包的 cordis.patch.yml），
# 因此本文件保持为空，留给作者/本机自定义条目。
[]
`;

const PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

function parseArgs(argv) {
  const out = { profile: '', dryRun: false, uninstall: false, bundleDir: '', home: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i] ?? '';
    else if (a === '--bundle-dir') out.bundleDir = argv[++i] ?? '';
    else if (a === '--home') out.home = argv[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ── 目标 dsh home 的解析（2026-09-18 新增）──────────────────────────────────
// ⚠️ 必须与 `ai/harness-env.mjs` 的语义一致：决策 B 之后，**写作任务的 DSH_HOME 是
// `~/.dsh-novel`**（`resolveTaskDshHome()` 在它含 `profiles/` 时返回它）。
// 本脚本此前把 home 写死成 `~/.dsh`，于是 `install.ps1 -Profile novel` 会去接线一个
// **应用已经不再使用**的位置，还照样打印「✔ 接线完成」——失败得很像成功。
//
// 为什么不去 import `../../ai/harness-env.mjs`：本目录会被镜像成独立发布仓库
// （README 里那个 novel-writing-plugin），那份副本旁边没有 `ai/`，相对导入会把安装器打挂。
// 所以这里保留一份**极小的**解析，并由 `.p1-baseline/test-agent-memory-guard.mjs`
// 断言两侧的常量一致（跨模块字面量契约，同 `AGENT_GUARD_MARKER` 的处理）。
const DEDICATED_HOME_ENV = 'NOVELSTUDIO_DSH_HOME';
const DEFAULT_DEDICATED_HOME = '.dsh-novel';
const SHARED_HOME = '.dsh';

/**
 * 解析本次要接线到哪个 dsh home。优先级与 `resolveTaskDshHome()` 一致：
 * `--home` → `$NOVELSTUDIO_DSH_HOME` → `~/.dsh-novel`（须含 `profiles/`）→ `~/.dsh`。
 * 「须含 profiles/」这一条与运行时**刻意相同**：既是判据，也避免把插件接到一个空目录上。
 */
export function resolveTargetHome(cliHome = '', env = process.env, homedir = os.homedir()) {
  const explicit = String(cliHome || '').trim();
  if (explicit) return { home: explicit, why: '--home 指定' };
  const fromEnv = String(env[DEDICATED_HOME_ENV] || '').trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'profiles'))) {
    return { home: fromEnv, why: `环境变量 ${DEDICATED_HOME_ENV}` };
  }
  const dedicated = path.join(homedir, DEFAULT_DEDICATED_HOME);
  if (fs.existsSync(path.join(dedicated, 'profiles'))) {
    return { home: dedicated, why: '专用 home（决策 B，写作任务实际使用）' };
  }
  return { home: path.join(homedir, SHARED_HOME), why: '共享 home（专用 home 不存在，已退回）' };
}

const log = (msg) => console.log(msg);
const act = (dry, msg) => log(`    ${dry ? '[DryRun] 将 ' : ''}${msg}`);

function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 原子写：UTF-8 无 BOM，先写同目录 .tmp 再改名覆盖。 */
function writeText(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function backupFile(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const bak = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, bak);
  log(`    已备份 -> ${path.basename(bak)}`);
}

/** 在 cordis.patch.yml 中定位旧版 Novel Studio 区块（0 基行区间），无则返回 null。 */
function findLegacyBlock(lines) {
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === BLOCK_START.trim()) start = i;
    if (start >= 0 && lines[i].trim() === BLOCK_END.trim()) { end = i; break; }
  }
  if (start >= 0 && end >= 0) return [start, end];

  // 无标记的 v0.x 区块：从旧注释标记到其后首个 baseUrl 行。
  let legacy = -1;
  let firstBase = -1;
  for (let i = 0; i < lines.length; i++) {
    if (legacy < 0 && lines[i].includes(LEGACY_MARKER)) legacy = i;
    if (legacy >= 0 && firstBase < 0 && /^\s*baseUrl:/.test(lines[i])) { firstBase = i; break; }
  }
  if (legacy < 0) return null;
  if (firstBase >= legacy) {
    log('    ⚠ 检测到旧版无标记区块，按首个 baseUrl 行裁剪，请人工核对未删内容');
    return [legacy, firstBase];
  }
  return [legacy, lines.length - 1];
}

function stripLegacyBlock(patchPath, dryRun) {
  if (!fs.existsSync(patchPath)) return false;
  const lines = readText(patchPath).split(/\r?\n/);
  const range = findLegacyBlock(lines);
  if (!range) return false;
  const [start, end] = range;
  let kept = [...lines.slice(0, start), ...lines.slice(end + 1)];

  // ⚠️ 关键：旧区块常常是文件里**唯一**的 patch 条目（headless profile 就是这种情况）。
  // 只把行删掉、留下注释，文件就不再是合法的顶层 YAML 数组，dsh 启动会直接报
  //   overlay .../cordis.patch.yml must be a top-level YAML array of loader patch entries
  // 这个坑是 P6 彩排在克隆 profile 上实测出来的——当时旧 headless 就会迁移失败。
  const hasEntry = kept.some((l) => /^\s*-\s/.test(l));
  const hasEmptyArray = kept.some((l) => /^\s*\[\s*\]\s*$/.test(l));
  let text = kept.join('\r\n').replace(/(\r\n)+$/, '\r\n');
  if (!text.trim()) {
    text = '[]\n';
  } else if (!hasEntry && !hasEmptyArray) {
    text = `${text.replace(/\r\n$/, '')}\r\n\r\n[]\r\n`;
  }

  if (!dryRun) {
    backupFile(patchPath);
    writeText(patchPath, text);
    // 自检：写回后必须仍是「顶层 YAML 数组」，否则这次迁移会把 profile 弄坏。
    const after = readText(patchPath);
    if (!after.split(/\r?\n/).some((l) => /^\s*-\s/.test(l) || /^\s*\[\s*\]\s*$/.test(l))) {
      throw new Error(`迁移后 ${path.basename(patchPath)} 不是合法的顶层 YAML 数组（缺少 [] 或条目）——已中止，请检查备份`);
    }
  }
  act(dryRun, `从 ${path.basename(patchPath)} 移除旧版 Novel Studio 区块（第 ${start + 1}..${end + 1} 行）`);
  return true;
}

/** 读取 profile 的 package.json，缺字段则补齐；返回 [对象, 是否有改动]。 */
function ensureProfileManifest(manifestPath, profile, dryRun) {
  let obj;
  if (fs.existsSync(manifestPath)) {
    obj = JSON.parse(readText(manifestPath));
  } else {
    obj = { name: `dsh-profile-${profile}`, private: true };
  }
  const before = JSON.stringify(obj);

  if (!obj.name) obj.name = `dsh-profile-${profile}`;
  if (obj.private === undefined) obj.private = true;

  obj.dependencies = obj.dependencies && typeof obj.dependencies === 'object' ? obj.dependencies : {};
  obj.dependencies[BUNDLE_NAME] = `link:${bundleDir}`;

  obj.dsh = obj.dsh && typeof obj.dsh === 'object' ? obj.dsh : {};
  obj.dsh.profile = obj.dsh.profile && typeof obj.dsh.profile === 'object' ? obj.dsh.profile : {};
  const bundles = Array.isArray(obj.dsh.profile.bundles) ? obj.dsh.profile.bundles : [];
  if (!bundles.includes(BUNDLE_NAME)) bundles.push(BUNDLE_NAME);
  obj.dsh.profile.bundles = bundles;
  if (!obj.dsh.profile.patchReload) obj.dsh.profile.patchReload = 'startup';

  const changed = JSON.stringify(obj) !== before;
  if (changed && !dryRun) writeText(manifestPath, JSON.stringify(obj, null, 2) + '\n');
  return [obj, changed];
}

function ensureJunction(linkPath, target, dryRun) {
  let current = null;
  try {
    const st = fs.lstatSync(linkPath);
    current = st.isSymbolicLink() ? fs.readlinkSync(linkPath) : '(real-dir)';
  } catch { /* 不存在 */ }
  if (current && path.resolve(String(current).replace(/^\\\\\?\\/, '')) === path.resolve(target)) return false;
  if (!dryRun) {
    if (current) fs.rmSync(linkPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'junction');
  }
  act(dryRun, `${current ? '重建' : '建立'} junction node_modules/${BUNDLE_NAME} -> ${target}`);
  return true;
}

let bundleDir = '';
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.profile) {
    console.log('用法: node install-profile.mjs --profile <name> [--bundle-dir <path>] [--dry-run] [--uninstall]');
    process.exit(args.help ? 0 : 2);
  }
  if (!PROFILE_NAME_RE.test(args.profile)) {
    console.error(`非法 profile 名：${args.profile}（仅允许字母/数字/点/下划线/连字符，1-64 字符）`);
    process.exit(2);
  }
  bundleDir = args.bundleDir ? path.resolve(args.bundleDir) : path.dirname(fileURLToPath(import.meta.url));
  const dryRun = args.dryRun;

  if (!fs.existsSync(path.join(bundleDir, 'package.json'))) {
    console.error(`bundle 目录缺少 package.json：${bundleDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(bundleDir, 'cordis.patch.yml'))) {
    console.error(`bundle 目录缺少 cordis.patch.yml：${bundleDir}`);
    process.exit(1);
  }

  const { home: dshHome, why: homeWhy } = resolveTargetHome(args.home);
  const profileDir = path.join(dshHome, 'profiles', args.profile);
  const manifestPath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const linkPath = path.join(profileDir, 'node_modules', BUNDLE_NAME);
  const copiedTools = path.join(profileDir, 'novel-tools.mjs');

  log(`==> ${BUNDLE_NAME} bundle ${args.uninstall ? '撤销接线' : '接线'}：profile=${args.profile}`);
  log(`    dsh home : ${dshHome}（${homeWhy}）`);
  log(`    profile 目录: ${profileDir}`);
  log(`    bundle  目录: ${bundleDir}`);

  if (args.uninstall) {
    let touched = 0;
    if (fs.existsSync(linkPath)) {
      if (!dryRun) fs.rmSync(linkPath, { recursive: true, force: true });
      act(dryRun, '删除 junction'); touched++;
    }
    if (fs.existsSync(manifestPath)) {
      const obj = JSON.parse(readText(manifestPath));
      if (obj.dependencies) delete obj.dependencies[BUNDLE_NAME];
      if (obj.dsh?.profile?.bundles) {
        obj.dsh.profile.bundles = obj.dsh.profile.bundles.filter((b) => b !== BUNDLE_NAME);
      }
      if (!dryRun) { backupFile(manifestPath); writeText(manifestPath, JSON.stringify(obj, null, 2) + '\n'); }
      act(dryRun, '从 package.json 移除 novel-writing'); touched++;
    }
    if (stripLegacyBlock(patchPath, dryRun)) touched++;
    if (fs.existsSync(copiedTools)) {
      if (!dryRun) { backupFile(copiedTools); fs.rmSync(copiedTools, { force: true }); }
      act(dryRun, '删除复制的 novel-tools.mjs'); touched++;
    }
    log(touched === 0 ? '✔ 无需撤销（未发现接线痕迹）' : '✔ 撤销完成');
    return;
  }

  if (!dryRun) fs.mkdirSync(profileDir, { recursive: true });

  for (const [file, content, label] of [
    [path.join(profileDir, 'cordis.yml'), CORDIS_YML, 'cordis.yml（生成的空根）'],
    [patchPath, PATCH_YML, 'cordis.patch.yml（干净用户层）'],
    [path.join(profileDir, 'pnpm-workspace.yaml'), PNPM_WORKSPACE, 'pnpm-workspace.yaml'],
  ]) {
    if (fs.existsSync(file)) continue;
    if (!dryRun) writeText(file, content);
    act(dryRun, `创建 ${label}`);
  }

  const [, changed] = ensureProfileManifest(manifestPath, args.profile, dryRun);
  if (changed) act(dryRun, 'package.json 写入 novel-writing（bundles + dependencies）');
  else log('    package.json 已就绪');

  if (stripLegacyBlock(patchPath, dryRun)) {
    log('    （旧版区块已移除：本插件现在完全由 bundle 层提供，profile 层不再承载它）');
  }

  if (fs.existsSync(copiedTools)) {
    if (!dryRun) { backupFile(copiedTools); fs.rmSync(copiedTools, { force: true }); }
    act(dryRun, '删除复制的 novel-tools.mjs（bundle 直接引用仓库源，不需要副本）');
  }

  ensureJunction(linkPath, bundleDir, dryRun);

  const ov = path.join(profileDir, 'node_modules', '@openviking', 'dsh-memory-plugin');
  if (!fs.existsSync(ov)) {
    log(`    ⚠ 该 profile 尚未安装记忆插件。请执行：`);
    log(`      dsh plugin --profile ${args.profile} add @openviking/dsh-memory-plugin`);
  }

  log('✔ 接线完成。验证：');
  log(`    dsh --profile ${args.profile} --dump-config      # 组合树应包含 novel-tools`);
}

// 入口守卫（2026-09-18 新增）：只有**直接运行**本文件时才执行 main()。
// 此前是无条件 `main()`——意味着任何 `import` 都会**真的去改 profile 接线**。
// 于是 `resolveTargetHome()` 这类纯函数没法离线单测（import 一次就装一次）。
// 判据用 realpath 比较，避免 Windows 上大小写/短路径/符号链接造成的误判。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => { try { return fs.realpathSync(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  return norm(entry) === norm(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) main();
