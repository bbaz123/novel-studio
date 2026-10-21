/**
 * ai/quality-auditor/provision.mjs —— 审计插件的**自检与内置安装**（唯一实现）。
 *
 * 为什么要有这一层：插件要靠 profile 的 `dependencies` + `dsh.profile.bundles` + 一个
 * node_modules 链接才生效。这套动作原来只存在于 `harness-plugins/.../scripts/install.mjs`，
 * 作者必须开终端敲命令；而工坊的"依赖清单"又看不到它 —— 于是"装了但没有、没装也没提示"。
 *
 * 纪律：
 *   · 检测是**只读**的（读 package.json / 链接 / 源码），服务启动时只检测不写；
 *   · 安装必须**幂等**，写之前备份 profile 的 package.json；
 *   · 只改这一份 profile 的两个字段 + 一个链接，不碰 bundle 顺序之外的任何配置；
 *   · 与 install.mjs 共用本模块，避免两套安装逻辑漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'dsh-novel-quality-auditor';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SOURCE_DIR = path.resolve(HERE, '..', '..', 'harness-plugins', PLUGIN_NAME);

export function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_SOURCE_DIR, 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

function home() { return process.env.HOME || process.env.USERPROFILE || ''; }

export function dshHomes() {
  return [path.join(home(), '.dsh'), path.join(home(), '.dsh-novel')]
    .filter((h) => { try { return fs.existsSync(path.join(h, 'profiles')); } catch { return false; } });
}

export function activeProfileName() {
  const p = String(process.env.NOVELSTUDIO_DSH_PROFILE || 'novel').trim();
  return /^[A-Za-z0-9._-]+$/.test(p) ? p : 'novel';
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/**
 * 只读状态：源码 / 每个 home 的依赖、bundle、链接是否都指向本仓库。
 * @returns {{name, version, source_dir, source_exists, profile, installs:Array, ready:boolean, installed_anywhere:boolean}}
 */
export function auditPluginStatus({ profile = activeProfileName() } = {}) {
  const sourceExists = fs.existsSync(path.join(PLUGIN_SOURCE_DIR, 'package.json'));
  const installs = dshHomes().map((h) => {
    const dir = path.join(h, 'profiles', profile);
    const pkgPath = path.join(dir, 'package.json');
    const pkg = readJson(pkgPath);
    const dep = pkg && pkg.dependencies ? String(pkg.dependencies[PLUGIN_NAME] || '') : '';
    const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    const link = path.join(h, 'profiles', 'node_modules', PLUGIN_NAME);
    let linkOk = false;
    try { linkOk = fs.realpathSync(link).toLowerCase() === fs.realpathSync(PLUGIN_SOURCE_DIR).toLowerCase(); } catch { linkOk = false; }
    const pointsHere = String(dep).toLowerCase().endsWith(path.join('harness-plugins', PLUGIN_NAME).toLowerCase());
    return {
      home: h,
      profile,
      pkg_path: pkgPath,
      exists: Boolean(pkg),
      dep,
      dep_points_here: pointsHere,
      bundle_listed: bundles.includes(PLUGIN_NAME),
      link_path: link,
      link_ok: linkOk,
      // 三个条件必须同时成立才算"这个 home 里可用"：依赖指向本仓库、bundle 已列入、链接可解析。
      ready: Boolean(pkg) && pointsHere && bundles.includes(PLUGIN_NAME) && linkOk,
    };
  });
  const ready = sourceExists && installs.some((i) => i.ready);
  return {
    name: PLUGIN_NAME,
    version: pluginVersion(),
    source_dir: PLUGIN_SOURCE_DIR,
    source_exists: sourceExists,
    profile,
    installs,
    installed_anywhere: installs.some((i) => i.ready),
    ready,
  };
}

/**
 * 幂等安装（只写 profile 的 package.json 与一个链接）。
 * @returns {{ok:true, changed:string[], installs:Array, dry_run:boolean}|{ok:false, error:string}}
 */
export function ensureAuditPluginInstalled({ profile = activeProfileName(), dryRun = false } = {}) {
  if (!fs.existsSync(path.join(PLUGIN_SOURCE_DIR, 'package.json'))) {
    return { ok: false, error: `插件源码缺失：${PLUGIN_SOURCE_DIR}` };
  }
  const changed = [];
  for (const h of dshHomes()) {
    const dir = path.join(h, 'profiles', profile);
    const pkgPath = path.join(dir, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) continue;
    const deps = { ...(pkg.dependencies || {}) };
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.slice() : [];
    const wantDep = `link:${PLUGIN_SOURCE_DIR}`;
    const needDep = deps[PLUGIN_NAME] !== wantDep;
    const needBundle = !bundles.includes(PLUGIN_NAME);
    if (needDep) deps[PLUGIN_NAME] = wantDep;
    if (needBundle) bundles.push(PLUGIN_NAME);
    if (!needDep && !needBundle) continue;
    changed.push(`${h}: ${[needDep ? 'dependency' : '', needBundle ? 'bundle' : ''].filter(Boolean).join('+')}`);
    if (dryRun) continue;
    // 备份：任何一次写入都能回到安装前（uninstall.mjs 用最新备份恢复）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(pkgPath, path.join(dir, `.quality-auditor-backup-${stamp}.json`));
    fs.writeFileSync(pkgPath, JSON.stringify({
      ...pkg,
      dependencies: deps,
      dsh: { ...(pkg.dsh || {}), profile: { ...(pkg.dsh?.profile || {}), bundles } },
    }, null, 4) + '\n', 'utf8');
  }
  // 链接（放在 profiles/node_modules 下，与 DSH 自己重建的那一层同址）
  if (!dryRun) {
    for (const h of dshHomes()) {
      const nodes = path.join(h, 'profiles', 'node_modules');
      const link = path.join(nodes, PLUGIN_NAME);
      if (fs.existsSync(link)) continue;
      try {
        fs.mkdirSync(nodes, { recursive: true });
        fs.symlinkSync(PLUGIN_SOURCE_DIR, link, 'junction');
        changed.push(`${h}: link`);
      } catch (e) {
        return { ok: false, error: `建立链接失败：${e.message}` };
      }
    }
  }
  const status = auditPluginStatus({ profile });
  return { ok: true, changed, installs: status.installs, dry_run: Boolean(dryRun), status };
}

/**
 * "缺什么"的纯函数：给前端弹窗与后端错误码共用，避免两处各写一份判断。
 * @returns {Array<{code:string,name:string,why:string,cmd:string,url:string,kind:string}>}
 */
export function missingAuditDependencies({ pluginStatus, dshReady = true } = {}) {
  const items = [];
  if (!dshReady) {
    items.push({
      code: 'DSH_NOT_READY', kind: 'dsh', name: 'DeepSeek Harness（dsh）',
      why: '独立复核需要 dsh 才能启动子进程审计。',
      cmd: 'git clone https://github.com/deepseek-ai/deepseek-harness.git',
      url: 'https://github.com/deepseek-ai/deepseek-harness',
    });
  }
  if (!pluginStatus || pluginStatus.source_exists !== true) {
    items.push({
      code: 'AUDIT_PLUGIN_SOURCE_MISSING', kind: 'plugin', name: '审计插件源码',
      why: '本仓库缺少 harness-plugins/dsh-novel-quality-auditor。',
      cmd: 'git status --short harness-plugins/dsh-novel-quality-auditor',
      url: 'harness-plugins/dsh-novel-quality-auditor/',
    });
  } else if (pluginStatus.installed_anywhere !== true) {
    items.push({
      code: 'AUDIT_PLUGIN_NOT_INSTALLED', kind: 'plugin', name: '审计插件 dsh-novel-quality-auditor',
      why: '插件还没装进 dsh 的 novel profile，独立复核无法调用。',
      cmd: 'node harness-plugins/dsh-novel-quality-auditor/scripts/install.mjs',
      url: 'harness-plugins/dsh-novel-quality-auditor/',
      action: 'install_audit_plugin',
    });
  }
  return items;
}
