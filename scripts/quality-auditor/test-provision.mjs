#!/usr/bin/env node
/**
 * test-provision.mjs —— 插件内置化的离线断言（零计费、不写 profile）。
 *
 * 覆盖：只读状态形状 / 幂等 dry-run 不落盘 / "缺什么"的纯函数三分支。
 * 真正的安装动作由工坊的「一键安装」触发（CT 里用 dry_run 断言端点形状）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createChecks, REPO_ROOT } from '../../tests/narrative-repair/harness.mjs';
import { auditPluginStatus, ensureAuditPluginInstalled, missingAuditDependencies, PLUGIN_NAME, PLUGIN_SOURCE_DIR } from '../../ai/quality-auditor/provision.mjs';

const { check, finish } = createChecks();
const before = auditPluginStatus();

check('PV-01', '只读状态包含源码/版本/每个 home 的 dep+bundle+link 事实',
  before.name === PLUGIN_NAME && typeof before.version === 'string'
    && before.source_dir === PLUGIN_SOURCE_DIR && before.source_exists === true
    && Array.isArray(before.installs) && before.installs.every((i) => 'dep_points_here' in i && 'bundle_listed' in i && 'link_ok' in i && 'ready' in i),
  JSON.stringify({ name: before.name, v: before.version, installs: before.installs.length }));

check('PV-02', 'status 与"源码是否存在"一致（缺失时 ready 必为 false）',
  before.source_exists === true ? true : before.ready === false);

const backupsBefore = (() => {
  let n = 0;
  for (const i of before.installs) {
    try { n += fs.readdirSync(path.dirname(i.pkg_path)).filter((f) => f.startsWith('.quality-auditor-backup-')).length; } catch (_) { /* 无 */ }
  }
  return n;
})();
const dry = ensureAuditPluginInstalled({ dryRun: true });
const backupsAfter = (() => {
  let n = 0;
  for (const i of before.installs) {
    try { n += fs.readdirSync(path.dirname(i.pkg_path)).filter((f) => f.startsWith('.quality-auditor-backup-')).length; } catch (_) { /* 无 */ }
  }
  return n;
})();
check('PV-03', 'dry-run 不写盘：不新增备份、状态不变',
  dry.ok === true && dry.dry_run === true && backupsAfter === backupsBefore && auditPluginStatus().ready === before.ready,
  JSON.stringify({ changed: dry.changed, backupsBefore, backupsAfter }));

check('PV-04', '"缺什么"：dsh 未就绪 / 插件源码缺失 / 未安装 三分支各自给出可执行提示',
  (() => {
    const a = missingAuditDependencies({ pluginStatus: before, dshReady: false });
    const b = missingAuditDependencies({ pluginStatus: { source_exists: false, installed_anywhere: false }, dshReady: true });
    const c = missingAuditDependencies({ pluginStatus: { source_exists: true, installed_anywhere: false }, dshReady: true });
    const d = missingAuditDependencies({ pluginStatus: before, dshReady: true });
    return a.some((i) => i.code === 'DSH_NOT_READY' && i.url)
      && b.some((i) => i.code === 'AUDIT_PLUGIN_SOURCE_MISSING')
      && c.some((i) => i.code === 'AUDIT_PLUGIN_NOT_INSTALLED' && i.action === 'install_audit_plugin' && i.cmd.includes('install.mjs'))
      && d.length === 0;
  })());

check('PV-05', '仓库内的插件源码与 package 元数据齐全（内置化的前提）',
  fs.existsSync(path.join(REPO_ROOT, 'harness-plugins', PLUGIN_NAME, 'package.json'))
    && fs.existsSync(path.join(REPO_ROOT, 'harness-plugins', PLUGIN_NAME, 'lib', 'index.js'))
    && fs.existsSync(path.join(REPO_ROOT, 'harness-plugins', PLUGIN_NAME, 'scripts', 'install.mjs')));

finish('审计插件内置化');
