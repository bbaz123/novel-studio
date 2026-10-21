#!/usr/bin/env node
/**
 * install.mjs —— CLI 包装（实现在 ai/quality-auditor/provision.mjs，与工坊内"一键安装"共用）。
 *
 * 保留 CLI 的理由：CI/回滚/高级用户需要不启动服务也能装；但**不再有第二套逻辑**。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAuditPluginInstalled, auditPluginStatus, activeProfileName } from '../../../ai/quality-auditor/provision.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const profile = activeProfileName();

const before = auditPluginStatus({ profile });
console.log(`插件：${before.name}@${before.version || '?'}  profile=${profile}`);
console.log(`源码：${before.source_dir}${before.source_exists ? '' : '（缺失）'}`);
for (const i of before.installs) console.log(`  · ${i.home} → ready=${i.ready} dep=${i.dep || '(空)'} bundle=${i.bundle_listed} link=${i.link_ok}`);

const out = ensureAuditPluginInstalled({ profile, dryRun: DRY });
if (!out.ok) { console.error('✗ ' + out.error); process.exit(1); }
if (!out.changed.length) console.log('✓ 已安装（无变化）');
else for (const c of out.changed) console.log((DRY ? '  (dry-run) ' : '  ✓ ') + c);

const after = auditPluginStatus({ profile });
console.log(after.ready ? '✓ 状态：ready' : '✗ 状态：未就绪（检查上面的 dep/bundle/link）');
process.exit(after.ready ? 0 : 1);
