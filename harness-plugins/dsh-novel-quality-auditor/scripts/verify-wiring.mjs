#!/usr/bin/env node
/**
 * verify-wiring.mjs —— 离线证明"插件真的会注册四个工具，且 profile 真的引用它"。
 *
 * 为什么能离线证明：`apply(ctx, config)` 是**真实的注册代码**；给它一个假的 ctx
 * 就能拿到真实注册表（工具名/描述/参数 schema），不需要模型、不需要启动宿主。
 * 这不是"读源码 grep"：apply 执行时会跑 readEnv / 建 client / 注册 tool / 注册 turn guard。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, TOOL_NAMES } from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PROFILE = String(process.env.NOVELSTUDIO_DSH_PROFILE || 'novel').trim() || 'novel';
const HOME = process.env.HOME || process.env.USERPROFILE || '';
const HOMES = [path.join(HOME, '.dsh'), path.join(HOME, '.dsh-novel')].filter((h) => fs.existsSync(path.join(h, 'profiles')));

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures += 1;
};

// 1) 真实 apply → 真实注册表
const registered = [];
const events = [];
const ctx = {
  tools: { register(def) { registered.push(def); } },
  on(evt, fn) { events.push({ evt, fn }); },
};
const result = apply(ctx, { baseUrl: 'http://127.0.0.1:65535' });
check('真实 apply 注册恰好四个工具', registered.length === 4, registered.map((d) => d.name).join(','));
check('工具名与声明的 TOOL_NAMES 完全一致',
  JSON.stringify(registered.map((d) => d.name).sort()) === JSON.stringify([...TOOL_NAMES].sort()));
check('每个工具都有非空描述与 object 参数 schema',
  registered.every((d) => d.description && d.parameters && d.parameters.type === 'object' && d.output && typeof d.execute === 'function'));
check('没有注册全局 tools/post-execute',
  !events.some((e) => String(e.evt).includes('post-execute')) && !JSON.stringify(result).includes('post-execute'));
check('返回的 policy section 唯一且带前缀', result.policy_section === 'novel-quality-auditor:policy');
check('没有审计环境时 active_audit=false（普通任务不受影响）', result.active_audit === false);

// 2) bundle patch 不碰 system-prompt / post-execute（只看生效条目，注释里解释"为什么不写"是允许的）
const patch = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
const patchLines = patch.split('\n').map((l) => l.trim());
const hasSystemPromptEntry = patchLines.some((l) => l === '- id: system-prompt' || l.startsWith('- { id: system-prompt') || l.startsWith('system-prompt:'));
const hasPostExecuteEntry = patchLines.some((l) => l.startsWith('post-execute:') || l === '- id: post-execute' || l.startsWith('- { id: post-execute'));
check('cordis.patch.yml 没有生效的 system-prompt 条目（避免覆盖创作人设）', !hasSystemPromptEntry);
check('cordis.patch.yml 没有生效的 post-execute 条目', !hasPostExecuteEntry);

// 3) profile 真的引用本包 + 链接可解析
for (const home of HOMES) {
  const pkgPath = path.join(home, 'profiles', PROFILE, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const dep = pkg.dependencies && pkg.dependencies['dsh-novel-quality-auditor'];
  const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
  const depNorm = String(dep || '').split(String.fromCharCode(92)).join('/').toLowerCase();
  const dirNorm = String('link:' + PLUGIN_DIR).split(String.fromCharCode(92)).join('/').toLowerCase();
  check(`[${path.basename(home)}] profile 依赖指向本目录`, depNorm === dirNorm, String(dep || ''));
  check(`[${path.basename(home)}] bundles 含 dsh-novel-quality-auditor`, Array.isArray(bundles) && bundles.includes('dsh-novel-quality-auditor'));
  const link = path.join(home, 'profiles', 'node_modules', 'dsh-novel-quality-auditor');
  let resolves = false;
  try { resolves = fs.realpathSync(link).toLowerCase() === fs.realpathSync(PLUGIN_DIR).toLowerCase(); } catch { resolves = false; }
  check(`[${path.basename(home)}] node_modules 链接可解析到本目录`, resolves);
}

// 4) 没有别的插件占用这四个名字（静态对账）
const repo = path.resolve(PLUGIN_DIR, '..', '..');
const novelTools = path.join(repo, 'harness-plugins', 'novel-writing', 'novel-tools.mjs');
let dupe = [];
if (fs.existsSync(novelTools)) {
  const src = fs.readFileSync(novelTools, 'utf8');
  // 用字符串包含而不是正则：正则里的引号/反斜杠在跨 shell 写入时极易被吃掉（已踩过一次）。
  dupe = TOOL_NAMES.filter((n) => src.includes(`register('${n}'`) || src.includes(`name: '${n}'`) || src.includes(`name: "${n}"`));
}
check('工具名与 novel-writing 无覆盖/重复', dupe.length === 0, dupe.join(','));

if (failures) { console.error(`\n✗ 接线核对未通过（${failures} 项）`); process.exit(1); }
console.log('\n✓ 接线核对通过（4 个工具已真实注册；profile 引用与链接均正确）');
