/**
 * harness-plugins/novel-writing/profile.mjs —— S12：小说专用 profile 的**有效能力清单**。
 *
 * 为什么需要这一层：profile 是「组合」出来的——上游 base 组合 + 本插件的 patch 层
 * + 用户 home 的 patch 层，逐层叠加。问题在于**叠加是隐式的**：
 *   · 我们写 `disabled: true` 关掉的工具，可能被后面某一层悄悄 `disabled: false` 打开；
 *   · 某个 home patch 可以加一个我们没审计过的插件或工具，而"模型能调什么"随之变大；
 *   · 而所有功能测试仍然全绿（它们测的是行为，不是"能力面"）。
 *
 * 因此本模块把「模型实际能看到的工具集合」变成**可计算、可断言**的东西，并规定：
 *   ① 小说工具集合必须与 `capabilities.mjs` 的能力表**完全一致**（S09 ↔ S12 的接缝）；
 *   ② 任何覆盖层都不得扩大能力面 —— 违反即**失败关闭**（`DENY`），而不是"警告后继续"。
 *
 * 纪律：纯解析 + 纯判定，不启动进程、不发请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_CAPABILITIES, CAPABILITY } from './capabilities.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROFILE_VERSION = 'novel-profile-v1';

/** 保留的通用文件工具（只读/编辑类，与小说工具同属"作者显式允许"的能力面）。 */
export const GENERIC_TOOLS = Object.freeze(['read', 'write', 'edit', 'glob', 'grep']);

/** 允许的通用工具白名单（超出这个集合即视为扩权）。 */
const ALLOWED_GENERIC = new Set(GENERIC_TOOLS);

/**
 * 解析 cordis.patch.yml 里 `disabled: true` 的组件 id —— **单一来源**。
 * 不手抄一份清单（手抄必然与 yml 漂移）。
 */
export function disabledComponents(patchPath = path.join(HERE, 'cordis.patch.yml')) {
  const src = fs.readFileSync(patchPath, 'utf8');
  const out = [];
  // 形如：- { id: tool-pwsh,  disabled: true }
  for (const m of src.matchAll(/-\s*\{\s*id:\s*([A-Za-z0-9._-]+)\s*,\s*disabled:\s*true\s*\}/g)) {
    out.push(m[1]);
  }
  return out;
}

/** 小说工具集合（来自能力表，即"作者允许的集合"）。 */
export function novelTools() {
  return Object.keys(TOOL_CAPABILITIES).sort();
}

/**
 * 模型**实际**能看到的工具集合 = 小说工具 + 保留的通用工具。
 * 这个集合是 profile 的输出，也是"能力面"的定义。
 */
export function effectiveTools() {
  return [...new Set([...novelTools(), ...GENERIC_TOOLS])].sort();
}

/**
 * S12 核心不变量：**模型拿到的工具集合与审批允许集合一致**。
 * 即：所有 novel_* 工具都必须出现在能力表里，且能力表里不能有未注册的工具。
 */
export function assertToolsMatchCapabilityTable(registeredNovelTools) {
  const registered = [...new Set(registeredNovelTools || [])].sort();
  const allowed = novelTools();
  const notCovered = registered.filter((n) => !allowed.includes(n));
  const notRegistered = allowed.filter((n) => !registered.includes(n));
  return {
    ok: notCovered.length === 0 && notRegistered.length === 0,
    allowed_count: allowed.length,
    registered_count: registered.length,
    not_covered_by_capabilities: notCovered,
    in_capabilities_but_not_registered: notRegistered,
  };
}

/** 展开为"按能力分级"的清单（面板/诊断用）。 */
export function capabilityManifest() {
  const by = { [CAPABILITY.READ_ONLY]: [], [CAPABILITY.PROPOSAL]: [], [CAPABILITY.AUTHOR_CONFIRM]: [] };
  for (const name of novelTools()) by[TOOL_CAPABILITIES[name]].push(name);
  for (const k of Object.keys(by)) by[k].sort();
  return {
    version: PROFILE_VERSION,
    capabilities: by,
    generic_tools: [...GENERIC_TOOLS],
    effective_tools: effectiveTools(),
    disabled_components: disabledComponents(),
  };
}

/**
 * 审计配置覆盖层：**禁止外部 home patch 扩权**（S12 动作 5）。
 *
 * 每一层声明它想做的事；本函数检查"这一层有没有把能力面变大"。
 * 判据是白名单 + 失败关闭：任何未在白名单里的工具、任何对我们已禁用组件的重新启用，
 * 一律 DENY（不是警告）。"扩权"永远不允许，缩权允许。
 *
 * @param layers [{ name, disable?:[], enable?:[], addTools?:[] }]
 */
export function auditPatchLayers(layers, { ourDisabled = disabledComponents() } = {}) {
  const ourDisabledSet = new Set(ourDisabled);
  const verdicts = [];
  for (const layer of layers || []) {
    const name = String((layer && layer.name) || '(unnamed)');
    const problems = [];
    for (const comp of (layer && layer.enable) || []) {
      if (ourDisabledSet.has(String(comp))) {
        problems.push({ code: 'REENABLES_DISABLED_COMPONENT', component: String(comp) });
      }
    }
    for (const t of (layer && layer.addTools) || []) {
      const tool = String(t);
      if (!ALLOWED_GENERIC.has(tool) && !Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, tool)) {
        problems.push({ code: 'UNKNOWN_TOOL_EXPANSION', tool });
      }
      // AUTHOR_CONFIRM 类工具即使本来就在表里，也不许被"外部层"启用
      // （它们必须走作者审批通道，而不是靠配置打开）
      if (Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, tool) && TOOL_CAPABILITIES[tool] === CAPABILITY.AUTHOR_CONFIRM) {
        problems.push({ code: 'EXTERNAL_ENABLE_OF_AUTHOR_CONFIRM_TOOL', tool });
      }
    }
    verdicts.push({ layer: name, ok: problems.length === 0, problems });
  }
  const failed = verdicts.filter((v) => !v.ok);
  return {
    ok: failed.length === 0,
    decision: failed.length ? 'DENY' : 'ALLOW',
    layers: verdicts,
    failed_layers: failed.map((v) => v.layer),
  };
}
