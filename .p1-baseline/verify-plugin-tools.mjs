#!/usr/bin/env node
/**
 * 插件工具面验证（P3）：用 mock ctx 真正加载 novel-tools.mjs，列出它注册的模型工具。
 *
 * 为什么需要：`dsh --dump-config` 只组合配置、**不加载模块**（P0 已实测：
 * 注入不存在的插件也能启动成功）。所以「工具到底注册了哪些」必须靠真正调用 apply 来验。
 *
 * 同时对照 plugin.json 的 tools 清单——两处漂移是真实发生过的缺陷（失误 4 的同类）。
 *
 * 用法: node verify-plugin-tools.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = path.resolve('.p1-baseline/../harness-plugins/novel-writing');
// Windows 上动态 import() 的绝对路径必须是 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(path.join(pluginDir, 'novel-tools.mjs')).href);

const registered = [];
const ctx = {
  tools: {
    register(tool) {
      registered.push({ name: tool.name, description: String(tool.description || ''), hasSchema: !!tool.parameters });
    },
  },
};

mod.apply(ctx, { baseUrl: 'http://127.0.0.1:1' });

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
const declared = (manifest.tools || []).map((t) => t.name);

console.log(`插件版本: ${mod.PLUGIN_VERSION} / plugin.json: ${manifest.version} / package.json: ${JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version}`);
console.log(`模块导出: name=${mod.name} inject=${JSON.stringify(mod.inject)}`);
console.log(`\n实际注册的模型工具（${registered.length} 个）：`);
for (const t of registered) console.log(`  - ${t.name.padEnd(24)} schema=${t.hasSchema ? '有' : '无'}`);

console.log(`\nplugin.json 声明的工具（${declared.length} 个）：`);
console.log('  ' + declared.join(', '));

const actual = registered.map((t) => t.name);
const onlyActual = actual.filter((n) => !declared.includes(n));
const onlyDeclared = declared.filter((n) => !actual.includes(n));
// 版本是**三处**而不是两处：漏掉 package.json（bundle 包）会让人以为"升级了"其实没有。
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version;
const versions = { PLUGIN_VERSION: mod.PLUGIN_VERSION, 'plugin.json': manifest.version, 'package.json': pkgVersion };
const versionOk = new Set(Object.values(versions)).size === 1;

// 端点对账：**只查「代码调用了但清单没声明」这一个方向**（那才是真漂移）。
// 反方向（声明了但工具没调用）是正常的——engineEndpoints 也收录前端等其它调用方用的引擎端点。
const src = fs.readFileSync(path.join(pluginDir, 'novel-tools.mjs'), 'utf8');
const usedPaths = new Set([...src.matchAll(/jfetch\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1].split('?')[0]));
const declaredPaths = (manifest.engineEndpoints || [])
  .map((e) => e.replace(/^[A-Z/]+ /, '').split('?')[0].replace(/\|.*$/, ''));
const undeclaredCalls = [...usedPaths].filter((u) => !declaredPaths.some((d) => u.startsWith(d)));

console.log(`\n端点对账：代码调用 ${usedPaths.size} 个，清单声明 ${manifest.engineEndpoints.length} 条`);
console.log('');
if (onlyActual.length) console.log(`✗ 实际注册但未在 plugin.json 声明：${onlyActual.join(', ')}`);
if (onlyDeclared.length) console.log(`✗ plugin.json 声明但未注册：${onlyDeclared.join(', ')}`);
if (!versionOk) console.log(`✗ 版本不一致：${JSON.stringify(versions)}`);
if (undeclaredCalls.length) console.log(`✗ 代码调用了但 engineEndpoints 未声明：${undeclaredCalls.join(', ')}`);

const ok = !onlyActual.length && !onlyDeclared.length && versionOk && !undeclaredCalls.length && registered.length > 0;
console.log(ok ? `✓ 工具面／版本／端点声明三者一致（${registered.length} 个工具）` : '✗ 存在漂移');
process.exitCode = ok ? 0 : 1;
