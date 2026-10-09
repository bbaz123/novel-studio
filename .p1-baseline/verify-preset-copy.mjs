#!/usr/bin/env node
/**
 * 部署拷贝核对（E02，只读）——「不可只改源文件而不管部署拷贝」的机器核对。
 *
 * 背景（《叙事性专项修复》E02）：
 *   插件的规则文本/工具实现有两处可能被"复制"到仓库之外：profile 的 node_modules 与
 *   旧的 `~/.dsh/.agent-presets/novel-writing`。只改仓库源不等于生效——
 *   实测本机曾存在 2026-09-18 的拷贝式安装，与仓库相差一个月。
 *
 * 本工具**只读**：不写 profile、不写 .agent-presets、不删用户目录（按规则 4/8：不替用户全盘覆盖配置）。
 * 结论与安装步骤打印出来，由用户决定是否执行。
 *
 * 判据：
 *   · **活跃接线**：profile 的 `dsh.profile.bundles` 是否含 novel-writing，以及
 *     `<profile>/node_modules/novel-writing` 是否是指向本仓库的链接（junction/symlink）。
 *     链接 = 仓库即唯一来源（无副本，改源码立刻生效）→ 通过。
 *   · **遗留拷贝**：`~/.dsh/.agent-presets/novel-writing` 里与仓库同名但内容不同的文件
 *     → 报告为"遗留（未被加载）"，并给出清理建议；不影响通过与否。
 *   · 只有当某个**活跃** profile 用的是**拷贝**且与仓库不一致时，才判失败（exit 3）。
 *
 * 用法: node .p1-baseline/verify-preset-copy.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const REPO_PLUGIN = path.join(REPO_ROOT, 'harness-plugins', 'novel-writing');
const DSH_HOME = path.join(os.homedir(), '.dsh');
const PROFILES_DIR = path.join(DSH_HOME, 'profiles');
const LEGACY_PRESET = path.join(DSH_HOME, '.agent-presets', 'novel-writing');
const asJson = process.argv.includes('--json');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

/** 逐文件比较两个目录（只看两边都有的文件；单侧存在也记出来）。 */
function diffDirs(a, b) {
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const names = [...new Set([...list(a), ...list(b)])].sort();
  const rows = [];
  for (const n of names) {
    const pa = path.join(a, n);
    const pb = path.join(b, n);
    const ea = fs.existsSync(pa);
    const eb = fs.existsSync(pb);
    if (fs.statSync(ea ? pa : pb).isDirectory()) { rows.push({ name: n, status: 'dir' }); continue; }
    if (!ea) { rows.push({ name: n, status: 'only_target', target: fs.statSync(pb).size }); continue; }
    if (!eb) { rows.push({ name: n, status: 'only_repo', source: fs.statSync(pa).size }); continue; }
    const same = sha(pa) === sha(pb);
    rows.push({ name: n, status: same ? 'same' : 'different', source: fs.statSync(pa).size, target: fs.statSync(pb).size });
  }
  return rows;
}

const result = { repo_plugin: REPO_PLUGIN, profiles: [], legacy: null, verdict: 'unknown', notes: [] };

if (!fs.existsSync(PROFILES_DIR)) {
  result.verdict = 'no_profiles';
  result.notes.push(`没有 ${PROFILES_DIR}：本机未接线任何 dsh profile（不需要核对）`);
} else {
  for (const name of fs.readdirSync(PROFILES_DIR)) {
    const dir = path.join(PROFILES_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const pkg = readJson(path.join(dir, 'package.json'));
    const bundles = (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    const declared = bundles.includes('novel-writing');
    const link = path.join(dir, 'node_modules', 'novel-writing');
    const exists = fs.existsSync(link);
    let kind = 'missing';
    let pointsHere = false;
    let target = '';
    if (exists) {
      const st = fs.lstatSync(link);
      kind = st.isSymbolicLink() ? 'link' : (st.isDirectory() ? 'copy' : 'other');
      try {
        target = fs.realpathSync(link);
        pointsHere = target.toLowerCase() === REPO_PLUGIN.toLowerCase();
      } catch (_) { /* 读不到按未接线 */ }
      if (kind === 'copy') {
        const rows = diffDirs(REPO_PLUGIN, link).filter((r) => r.status !== 'same');
        result.profiles.push({ name, declared, kind, points_here: false, path: link, different: rows.filter((r) => r.status === 'different' || r.status === 'only_repo' || r.status === 'only_target').map((r) => r.name) });
        continue;
      }
    }
    result.profiles.push({ name, declared, kind, points_here: pointsHere, path: link, target });
  }
}

if (fs.existsSync(LEGACY_PRESET)) {
  const rows = diffDirs(REPO_PLUGIN, LEGACY_PRESET);
  const different = rows.filter((r) => r.status === 'different');
  result.legacy = {
    path: LEGACY_PRESET,
    files: rows.length,
    different: different.map((r) => ({ name: r.name, repo_bytes: r.source, installed_bytes: r.target })),
    loaded: false,
    note: '遗留的拷贝式安装（2026-09-18 起）：当前没有任何活跃通道加载它（活跃通道走 profile junction）。',
  };
}

const activeCopies = result.profiles.filter((p) => p.declared && p.kind === 'copy');
const activeLinks = result.profiles.filter((p) => p.declared && p.points_here);
if (activeCopies.length) {
  const drifted = activeCopies.filter((p) => p.different && p.different.length);
  result.verdict = drifted.length ? 'drifted_copy' : 'copy_in_sync';
} else if (activeLinks.length) {
  result.verdict = 'junction_ok';
} else if (result.profiles.some((p) => p.declared)) {
  result.verdict = 'declared_but_not_linked';
} else {
  result.verdict = 'not_wired';
}

if (asJson) {
  // ⚠️ `--json` 必须是**纯 JSON**：此前它在 JSON 之后又打印了一行人话，
  // 下游 JSON.parse 直接失败（实测）。要给人看就别加 --json。
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`仓库插件源: ${REPO_PLUGIN}`);
  console.log('\n【活跃接线（profile）】');
  if (!result.profiles.length) console.log('  （无 profile）');
  for (const p of result.profiles) {
    const state = !p.declared ? '未声明 novel-writing'
      : p.points_here ? `链接 → 本仓库（仓库即唯一来源，改源码立刻生效）`
        : p.kind === 'copy' ? `**拷贝**（与仓库不同的文件 ${p.different.length} 个${p.different.length ? '：' + p.different.slice(0, 6).join('、') : ''}）`
          : `已声明但未接线（${p.kind}）`;
    console.log(`  - profile ${p.name}: ${state}`);
  }
  console.log('\n【遗留拷贝】');
  if (!result.legacy) console.log('  （没有 ~/.dsh/.agent-presets/novel-writing）');
  else {
    console.log(`  - ${result.legacy.path}`);
    console.log(`    与仓库不同的文件 ${result.legacy.different.length} / 共 ${result.legacy.files} 个`);
    for (const d of result.legacy.different.slice(0, 8)) console.log(`      · ${d.name}: 仓库 ${d.repo_bytes}B / 已装 ${d.installed_bytes}B`);
    console.log(`    ${result.legacy.note}`);
    console.log('    清理建议（本工具不替你执行）：确认没有旧脚本依赖后，手工删除或改名该目录即可；');
    console.log('    正确接线方式是 `node harness-plugins/novel-writing/install-profile.mjs --profile <名> --dry-run` 先预演。');
  }
  console.log(`\n结论: ${result.verdict}`);
}

if (result.verdict === 'drifted_copy') {
  console.error('\n✗ 活跃通道正在用一个与仓库不一致的**拷贝**：改源码不会生效，必须重新接线或同步拷贝。');
  console.error('  预演命令: node harness-plugins/novel-writing/install-profile.mjs --profile <名> --dry-run');
  process.exit(3);
}
if (!asJson) {
  console.log(result.verdict === 'junction_ok'
    ? '✓ 活跃通道走链接指向本仓库：源文件即部署文件，无副本漂移风险。'
    : '（无需改动：没有"活跃通道用陈旧拷贝"的情况）');
}
