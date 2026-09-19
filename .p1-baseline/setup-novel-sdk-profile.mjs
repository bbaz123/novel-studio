#!/usr/bin/env node
/**
 * setup-novel-sdk-profile.mjs —— 创建/更新 `novel-sdk` profile（常驻运行时用的那一个）。
 *
 * ── 为什么要有这个 profile ────────────────────────────────────────────────────
 * 写作任务现在跑在 `novel` profile 上，它的 bundles 里是 `@deepseek-ai/dsh-headless`
 * —— "答一个任务、打印结果、退出"的一次性驱动器。`novel-sdk` 把它换成
 * `@deepseek-ai/dsh-sdk-app`：一个 stdio JSON-RPC **常驻**运行时（同一个 agent 能力、
 * 同一个人设与工具集，只是换了个进程生命周期）。于是每任务 ≈17–18 秒的冷启动才有可能
 * 被"热备池"藏起来。
 *
 * ── 为什么是"照 novel 派生"而不是手写一份 ──────────────────────────────────────
 * 手写会立刻引入两份会漂移的清单：cordis.yml / cordis.patch.yml / pnpm-workspace.yaml /
 * dependencies 的版本。这里**一律从既有 `novel` profile 读出来再改一处**（bundles 里的
 * headless → sdk-app），改不动的东西就不抄。
 *
 * ── 两条不可妥协的纪律 ────────────────────────────────────────────────────────
 * 1. **绝不把 bundle 复制进 profile**：`novel-writing` 必须是**junction** 指回仓库
 *    （本项目的"仓库即唯一来源，没有副本"，见 NATIVE_PLUGIN_GUIDE.md）。只有
 *    `@openviking/dsh-memory-plugin` 是 npm 装的真实目录，才按目录复制。
 * 2. **home 解析失败就报错退出**，不静默退回 `~/.dsh`：本项目的 install-profile.mjs
 *    曾在"运行时用 A、安装器写 B"上栽过（还打印"接线完成"），这里不重犯。
 *
 * 用法：
 *   node .p1-baseline/setup-novel-sdk-profile.mjs --dry-run   # 只看要做什么
 *   node .p1-baseline/setup-novel-sdk-profile.mjs             # 真做（幂等，可重复跑）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const TEMPLATE_PROFILE = 'novel';
const TARGET_PROFILE = 'novel-sdk';
const HEADLESS_BUNDLE = '@deepseek-ai/dsh-headless';
const SDK_BUNDLE = '@deepseek-ai/dsh-sdk-app';
const BUNDLE_NAME = 'novel-writing';
const OV_PKG = path.join('@openviking', 'dsh-memory-plugin');

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
};
const dryRun = process.argv.includes('--dry-run');
const acts = [];
const act = (msg) => { acts.push(msg); console.log(`    ${dryRun ? '[DryRun] 将 ' : ''}${msg}`); };

/** 与 ai/harness-env.mjs 同语义：--home → $NOVELSTUDIO_DSH_HOME → ~/.dsh-novel（须含 profiles/）。 */
function resolveHome() {
  const explicit = arg('--home');
  if (explicit) return { home: explicit, why: '--home 指定' };
  const env = String(process.env.NOVELSTUDIO_DSH_HOME || '').trim();
  if (env && fs.existsSync(path.join(env, 'profiles'))) return { home: env, why: '环境变量 NOVELSTUDIO_DSH_HOME' };
  const dedicated = path.join(os.homedir(), '.dsh-novel');
  if (fs.existsSync(path.join(dedicated, 'profiles'))) return { home: dedicated, why: '专用 home（决策 B，写作任务实际使用）' };
  return { home: '', why: '未找到含 profiles/ 的 dsh home' };
}

function ensureJunction(linkPath, target) {
  let current = null;
  try {
    const st = fs.lstatSync(linkPath);
    current = st.isSymbolicLink() ? path.resolve(String(fs.readlinkSync(linkPath)).replace(/^\\\\\?\\/, '')) : '(real-dir)';
  } catch { /* 不存在 */ }
  if (current && current === path.resolve(target)) return;
  if (!dryRun) {
    if (current) fs.rmSync(linkPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(target, linkPath, 'junction');
  }
  act(`${current ? '重建' : '建立'} junction node_modules/${BUNDLE_NAME} -> ${target}`);
}

const main = () => {
  const { home, why } = resolveHome();
  if (!home) { console.error(`✗ ${why}。请用 --home 指定，或先跑一次 dsh 让它建出 home。`); process.exit(2); }
  const profilesDir = path.join(home, 'profiles');
  const templateDir = path.join(profilesDir, TEMPLATE_PROFILE);
  const targetDir = path.join(profilesDir, TARGET_PROFILE);

  console.log(`==> 创建 ${TARGET_PROFILE} profile（常驻 dsh 运行时）`);
  console.log(`    dsh home : ${home}（${why}）`);
  console.log(`    模板     : ${templateDir}`);

  const tplPkgPath = path.join(templateDir, 'package.json');
  if (!fs.existsSync(tplPkgPath)) { console.error(`✗ 模板 profile 不存在或缺 package.json：${tplPkgPath}`); process.exit(1); }
  const tplPkg = JSON.parse(fs.readFileSync(tplPkgPath, 'utf8'));
  const tplBundles = (tplPkg.dsh && tplPkg.dsh.profile && tplPkg.dsh.profile.bundles) || [];
  if (!tplBundles.includes(HEADLESS_BUNDLE)) {
    console.error(`✗ 模板 bundles 里没有 ${HEADLESS_BUNDLE}，无法派生（实际：${tplBundles.join(', ')}）`);
    process.exit(1);
  }
  if (!tplBundles.includes(BUNDLE_NAME)) { console.error(`✗ 模板 bundles 里没有 ${BUNDLE_NAME}`); process.exit(1); }

  if (!dryRun) fs.mkdirSync(targetDir, { recursive: true });

  // 1) 三个结构文件原样照搬（它们与 headless/sdk 无关，抄一份只会引入漂移）。
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const src = path.join(templateDir, f);
    if (!fs.existsSync(src)) continue;
    if (!dryRun) fs.copyFileSync(src, path.join(targetDir, f));
    act(`复制 ${f}（与 ${TEMPLATE_PROFILE} 逐字一致）`);
  }

  // 2) package.json：**只改 bundles 里的一行**，其余（dependencies 版本等）原样继承。
  const pkg = JSON.parse(JSON.stringify(tplPkg));
  pkg.name = `dsh-profile-${TARGET_PROFILE}`;
  pkg.dsh.profile.bundles = tplBundles.map((b) => (b === HEADLESS_BUNDLE ? SDK_BUNDLE : b));
  if (!dryRun) fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 4) + '\n', 'utf8');
  act(`写 package.json：bundles = [${pkg.dsh.profile.bundles.join(', ')}]`);

  // 3) node_modules/novel-writing 必须是 **junction 指回仓库**（绝不复制 —— 复制就等于造副本）。
  const tplLink = path.join(templateDir, 'node_modules', BUNDLE_NAME);
  let linkTarget = path.join(REPO, 'harness-plugins', BUNDLE_NAME);
  try {
    if (fs.lstatSync(tplLink).isSymbolicLink()) linkTarget = String(fs.readlinkSync(tplLink)).replace(/^\\\\\?\\/, '');
  } catch { /* 模板没有链接时用仓库默认路径 */ }
  ensureJunction(path.join(targetDir, 'node_modules', BUNDLE_NAME), linkTarget);

  // 4) @openviking/dsh-memory-plugin 是 npm 装的**真实目录**（不是链接），按目录复制。
  const ovSrc = path.join(templateDir, 'node_modules', OV_PKG);
  const ovDst = path.join(targetDir, 'node_modules', OV_PKG);
  if (fs.existsSync(ovSrc)) {
    let need = true;
    try { need = !fs.existsSync(path.join(ovDst, 'package.json')); } catch { need = true; }
    if (need) {
      if (!dryRun) { fs.mkdirSync(path.dirname(ovDst), { recursive: true }); fs.cpSync(ovSrc, ovDst, { recursive: true, dereference: true }); }
      act(`复制 ${OV_PKG}（npm 真实目录，非链接）`);
    } else {
      console.log(`    已存在，跳过：${OV_PKG}`);
    }
  } else {
    console.log(`    ⚠ 模板里没有 ${OV_PKG}，跳过（该 profile 将不含 OpenViking 记忆插件）`);
  }

  console.log(`\n==> ${dryRun ? 'DryRun 完成（未改动任何文件）' : `完成：${targetDir}`}（共 ${acts.length} 项动作）`);
  console.log('    自检：node .p1-baseline/verify-novel-sdk-profile.mjs');
};

main();
