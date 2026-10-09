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
const executors = new Map();
const ctx = {
  tools: {
    register(tool) {
      registered.push({ name: tool.name, description: String(tool.description || ''), hasSchema: !!tool.parameters });
      if (typeof tool.execute === 'function') executors.set(tool.name, tool.execute);
    },
  },
};

mod.apply(ctx, { baseUrl: 'http://127.0.0.1:1' });

// ── E02（2026-10-09）：**通道等价的路由输入证据** ─────────────────────────────
// 为什么在这里验：Harness 通道拿到的规则集合由插件发起的装配请求决定；只读源码"看起来传了 stage"
// 不算证据（参数名拼错、被白名单过滤掉都同样"看起来对"）。这里把插件的 HTTP 层换成本地桩，
// 真正调用工具并断言它发出的 URL。直连通道的对应断言在 .p1-baseline/test-editing-rules.mjs。
async function probeContextUrls() {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origBase = process.env.NOVELSTUDIO_BASE_URL;
  const origMode = process.env.NOVELSTUDIO_MODE;
  process.env.NOVELSTUDIO_BASE_URL = 'http://127.0.0.1:9';
  process.env.NOVELSTUDIO_MODE = 'full';
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: String(opts.method || 'GET').toUpperCase(), body: opts.body });
    const body = JSON.stringify({ ok: true, work: { id: 1, title: 'x' }, chapter: null, mode: 'full', assembled: '（桩）' });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
  try {
    const pipeline = executors.get('novel_write_pipeline');
    const contextTool = executors.get('novel_context');
    if (pipeline) { try { await pipeline({ work_id: '1', chapter_id: '2' }); } catch (_) { /* 桩只保证请求发出 */ } }
    if (contextTool) {
      try { await contextTool({ work_id: '1', chapter_id: '2', mode: 'full' }); } catch (_) { /* 同上 */ }
      try { await contextTool({ work_id: '1', chapter_id: '2', mode: 'full', stage: 'verify_style' }); } catch (_) { /* 同上 */ }
      try { await contextTool({ work_id: '1', chapter_id: '2', mode: 'full', stage: 'not_a_stage' }); } catch (_) { /* 同上 */ }
    }
  } finally {
    globalThis.fetch = origFetch;
    if (origBase === undefined) delete process.env.NOVELSTUDIO_BASE_URL; else process.env.NOVELSTUDIO_BASE_URL = origBase;
    if (origMode === undefined) delete process.env.NOVELSTUDIO_MODE; else process.env.NOVELSTUDIO_MODE = origMode;
  }
  return calls.map((c) => c.url).filter((u) => u.includes('/api/novel/context'));
}

const contextUrls = await probeContextUrls();
const routeChecks = [
  ['novel_write_pipeline 的装配带 stage=draft（与直连成文轮同阶段）', contextUrls.some((u) => u.includes('stage=draft'))],
  ['novel_context 不传 stage 时 URL 里没有 stage 参数（旧行为不变）', contextUrls.some((u) => !u.includes('stage='))],
  ['novel_context 传 stage=verify_style 时如实透传（诊断期取完整判据）', contextUrls.some((u) => u.includes('stage=verify_style'))],
  ['novel_context 传非法 stage 时**不透传**（与宿主白名单同口径）', !contextUrls.some((u) => u.includes('not_a_stage'))],
];
const routeBad = routeChecks.filter(([, ok]) => !ok);
console.log('\n通道等价（路由输入级）:');
for (const [name, ok] of routeChecks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);

// E02：Harness 预设（agent.cordis.yml）必须仍写明**明确事实限制**。
// 为什么在这一层验：那句话真正落地在预设/提示词里，而不是服务端装配的上下文里；
// 只验装配层会让"预设被改丢了事实限制"这一点完全不可见。
const presetSrc = fs.readFileSync(path.join(pluginDir, 'agent.cordis.yml'), 'utf8');
const factLimitOk = /不要编造与既有设定冲突的内容/.test(presetSrc);
const skipWriteOk = /允许略写|存在一个事件不等于必须写成完整场景/.test(presetSrc);
const noDiagnosticOk = !/逐项评分|诊断阈值/.test(presetSrc);
const presetChecks = [
  ['Harness 预设仍写明"不要编造与既有设定冲突的内容"（明确事实限制）', factLimitOk],
  ['Harness 预设仍写明"允许略写/不把篇幅平均分配"（生成期许可）', skipWriteOk],
  ['Harness 预设不含逐项评分/诊断阈值（生成阶段不做自评）', noDiagnosticOk],
];
for (const [name, ok] of presetChecks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
if (routeBad.length || presetChecks.some(([, ok]) => !ok)) {
  console.error(`\n✗ 插件侧契约不成立（阶段参数 ${routeBad.length} 项 / 预设 ${presetChecks.filter(([, ok]) => !ok).length} 项）—— Harness 与直连会注入不同规则集合，或事实限制丢失。`);
  console.error(`  实测 context 请求：${contextUrls.join(' | ') || '（一次都没发出）'}`);
  process.exit(1);
}

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

// ── 去 AI 味 P0（2026-10-06）：人设与工具描述不得再把"字数/场面/系统出场"写成配额，
//    也不得再承诺"自动续写补足"——那正是把文本推向工整填充（AI 味）的结构性来源。
const agentYml = fs.readFileSync(path.join(pluginDir, 'agent.cordis.yml'), 'utf8');
const patchYml = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
const noQuotaText = [src, agentYml, patchYml].join('\n');
const quotaPatterns = [
  /3～5\s*个场景/,
  /系统出现\s*5～15/,
  /有效场景不足/,
  /不要输出千字以下的残章/,
  /不要交出\s*1000\s*字以下的残章/,
  /自动续写补足/,
  /字数补足/,
];
const quotaHits = quotaPatterns.filter((re) => re.test(noQuotaText)).map((re) => String(re));
if (quotaHits.length) console.log(`✗ 插件人设/工具仍残留配额或机械补字措辞：${quotaHits.join('、')}`);
// 两处人设都必须声明"目标字数不是配额"，并保留"允许略写/跳过"的取舍余地。
const advisoryOk = (t) => /范围参考/.test(t) && /不是/.test(t) && /配额/.test(t) && /允许略写/.test(t);
if (!advisoryOk(agentYml) || !advisoryOk(patchYml)) console.log('✗ 人设未同时声明"目标字数不是配额"与"允许略写/跳过"（两文件都要）');

const ok = !onlyActual.length && !onlyDeclared.length && versionOk && !undeclaredCalls.length
  && registered.length > 0 && !quotaHits.length && advisoryOk(agentYml) && advisoryOk(patchYml);
console.log(ok ? `✓ 工具面／版本／端点声明三者一致（${registered.length} 个工具）` : '✗ 存在漂移');
process.exitCode = ok ? 0 : 1;
