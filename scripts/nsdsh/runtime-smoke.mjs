#!/usr/bin/env node
/**
 * scripts/nsdsh/runtime-smoke.mjs —— S12：小说专用 profile 的运行时冒烟（fixture 模式）。
 *
 * 为什么需要它：profile 是**叠出来的**，而"模型最终能看到什么工具"是叠加的产物。
 * 功能测试跑绿不代表能力面正确 —— 可能多了一个工具、少了一个工具，或被某一层悄悄打开。
 * 本脚本把三件事变成可执行断言：
 *   ① **有效工具集合 == 审批允许集合**（S12 验收项，也是 S09 与 S12 的接缝）；
 *   ② **配置扩权失败关闭**：任何覆盖层试图扩大能力面 → `DENY`；
 *   ③ **stdout 干净 + 无残留进程**：不 spawn 任何子进程，因此"无残留"可被直接断言。
 *
 * 用法：
 *   node scripts/nsdsh/runtime-smoke.mjs --fixture        # 冒烟（CI 用）
 *   node scripts/nsdsh/runtime-smoke.mjs --fixture --json # 机器可读
 *
 * 退出码：0 = 全部成立；1 = 有断言失败。
 *
 * 注意：默认**只做静态 + 纯函数校验**，不启动真实 DSH（方案要求 `--fixture`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PLUGIN = path.join(REPO, 'harness-plugins/novel-writing');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/** 冒烟主体：纯计算，返回结构化结果（供测试直接调用，避免 spawn）。 */
export async function smoke() {
  const P = await import(new URL(`file:///${path.join(PLUGIN, 'profile.mjs').replace(/\\/g, '/')}`).href);
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // ① profile 组合：patch 层必须真的声明了禁用项（不能是空壳）
  const disabled = P.disabledComponents();
  add('profile 声明了要禁用的通用能力', disabled.length >= 10, `禁用 ${disabled.length} 项：${disabled.slice(0, 4).join(',')}…`);
  for (const must of ['tool-pwsh', 'tool-subagent', 'tool-workflow', 'tool-web']) {
    add(`与创作无关的能力已禁用：${must}`, disabled.includes(must), '');
  }
  // 编码人格必须被移除（S12 动作 3：不保留模型可见的编码人格）
  add('禁用了上游 agent-instructions（不注入编码人格）', disabled.includes('agent-instructions'), '');

  // ② 模型可见工具集合 == 审批允许集合
  const toolsSrc = fs.readFileSync(path.join(PLUGIN, 'novel-tools.mjs'), 'utf8');
  const registered = [...toolsSrc.matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]);
  const cmp = P.assertToolsMatchCapabilityTable(registered);
  add('模型可见的小说工具集合与审批允许集合一致', cmp.ok,
    cmp.ok ? `${cmp.allowed_count} 个工具一致` : `未覆盖=${cmp.not_covered_by_capabilities.join(',')} 未注册=${cmp.in_capabilities_but_not_registered.join(',')}`);
  add('有效工具集合 = 小说工具 + 保留的通用工具', P.effectiveTools().length === cmp.allowed_count + P.GENERIC_TOOLS.length,
    `effective=${P.effectiveTools().length} novel=${cmp.allowed_count} generic=${P.GENERIC_TOOLS.length}`);

  // ③ 配置扩权：失败关闭
  const deny = P.auditPatchLayers([{ name: 'fixture-rogue', enable: ['tool-pwsh'], addTools: ['novel_state_commit', 'totally_new_tool'] }]);
  add('扩权层被判 DENY（失败关闭）', deny.decision === 'DENY' && !deny.ok, `failed=${deny.failed_layers.join(',')}`);
  const allow = P.auditPatchLayers([{ name: 'fixture-clean', disable: ['tool-todo'], addTools: ['read', 'novel_context'] }]);
  add('不扩权的层被判 ALLOW（不误伤缩权）', allow.decision === 'ALLOW' && allow.ok, '');

  // ④ 预算/上下文约束存在（S12 动作 6 的一部分：核对预算约束）
  const envSrc = fs.readFileSync(path.join(REPO, 'ai/model-broker/envelope.mjs'), 'utf8');
  add('预算约束存在（总请求/总token/期限）', /maxRequests/.test(envSrc) && /maxTotalTokens/.test(envSrc) && /deadlineMs/.test(envSrc), '');

  // ⑤ 无残留进程：本脚本不 spawn 任何子进程 —— 用源码自证 + 运行时句柄数自证
  // 用"有没有引入进程执行模块"来证明，而不是在源码里搜 spawn 字样 ——
  // 后者会把这条断言自己的正则字面量也匹配进去（自指），导致恒假。
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // 用拼接避免"断言的字面量本身"被搜到（否则恒假，属于自指缺陷）。
  const procModule = 'child' + '_' + 'process';
  add('冒烟过程不 spawn 子进程（不引入进程执行模块）', !selfSrc.includes(procModule), '');
  const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
    .map((h) => h && h.constructor && h.constructor.name)
    .filter((n) => n && /Server|Socket|ChildProcess/.test(n));
  add('无残留网络/子进程句柄', handles.length === 0, handles.join(',') || '无');

  return {
    version: 'runtime-smoke-v1',
    mode: 'fixture',
    checks,
    ok: checks.every((c) => c.ok),
    effective_tools_count: P.effectiveTools().length,
    disabled_count: disabled.length,
    manifest: P.capabilityManifest(),
  };
}

/** 只在直接运行时打印并退出（被 import 时不打扰宿主）。 */
function isDirectRun() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectRun()) {
  if (!has('--fixture')) {
    console.error('拒绝执行：runtime-smoke 只支持 --fixture（不启动真实 DSH）');
    process.exit(1);
  }
  const r = await smoke();
  if (has('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('小说专用 profile 冒烟（fixture，不启动真实 DSH）');
    console.log(`  禁用通用能力 ${r.disabled_count} 项；有效工具 ${r.effective_tools_count} 个`);
    for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  }
  process.exit(r.ok ? 0 : 1);
}
