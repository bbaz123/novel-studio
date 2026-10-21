#!/usr/bin/env node
/**
 * uninstall.mjs —— 卸载本插件：从 profile 的 dependencies/bundles 中移除，
 * 删除链接；若存在安装时备份，则用备份**原样恢复** package.json（回滚演练用）。
 */
import fs from 'node:fs';
import path from 'node:path';

const PKG_NAME = 'dsh-novel-quality-auditor';
const PROFILE = String(process.env.NOVELSTUDIO_DSH_PROFILE || 'novel').trim() || 'novel';
const DRY = process.argv.includes('--dry-run');
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const HOMES = [path.join(HOME, '.dsh'), path.join(HOME, '.dsh-novel')].filter((h) => fs.existsSync(path.join(h, 'profiles')));

let failed = 0;
for (const home of HOMES) {
  const dir = path.join(home, 'profiles', PROFILE);
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const link = path.join(home, 'profiles', 'node_modules', PKG_NAME);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('.quality-auditor-backup-')).sort();
  const latest = backups.length ? path.join(dir, backups[backups.length - 1]) : '';
  console.log(`\n[${home}] profile=${PROFILE}`);
  if (DRY) { console.log('  · 将移除 dependency/bundle/链接' + (latest ? `，并从备份恢复 ${path.basename(latest)}` : '')); continue; }
  if (latest) {
    fs.copyFileSync(latest, pkgPath);
    console.log(`  ✓ 已从备份恢复：${path.basename(latest)}`);
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.dependencies) delete pkg.dependencies[PKG_NAME];
    if (Array.isArray(pkg.dsh?.profile?.bundles)) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8');
    console.log('  ✓ 已移除 dependency/bundle');
  }
  try { if (fs.existsSync(link)) { fs.rmSync(link, { recursive: true, force: true }); console.log('  ✓ 已删除链接'); } } catch (e) {
    console.error(`  ✗ 删除链接失败：${e.message}`); failed += 1;
  }
}
if (failed) process.exit(1);
console.log('\n卸载完成。');
