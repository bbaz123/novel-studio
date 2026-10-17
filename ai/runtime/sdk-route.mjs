/**
 * ai/runtime/sdk-route.mjs —— R01：把 SDK 运行时接到**真实生产通道**上（默认关闭）。
 *
 * 为什么需要这一层而不是让 `server.js` 直接 new 一个适配器：
 *   · 接线要判五件事（开关 / 用途 / 路由 / 预算 / 能力），这些判据必须可单测；
 *   · 失败时"能不能回退到直连"是个**计费**问题 —— 已经在子进程里发过请求再回退，
 *     等于同一段正文被计费两次。这条规则必须写在一个地方，不能散落在调用点。
 *
 * 三条硬规则：
 *   ① **默认关闭**：不设 `NOVELSTUDIO_SDK_ROUTE` 就走原路径，行为与改造前逐字一致；
 *   ② **只在"一次模型调用都没发出"时才回退**：`not_run` 可回退，`failed/unknown` 不回退
 *      （结果不明时重发就是二次计费，方案明确禁止）；
 *   ③ **子进程环境显式白名单**：只用 `config` 里那一组 base_url / api_key / DSH_HOME，
 *      绝不整体展开 `process.env`。
 */

import path from 'node:path';

import { createSdkRuntimeAdapter } from './sdk-adapter.mjs';
import { resolveDshLaunch } from './sdk-process.mjs';
import { sessionIdFor } from './dsh-sdk.mjs';

export const SDK_ROUTE_VERSION = 'sdk-route-v1';

/** DSH 侧 provider 名（锁定基线里 `deepseek-official` 是唯一内置 Messages 路由）。 */
export const SDK_DSH_PROVIDER = 'deepseek-official';

/** 只解析一次的入口缓存：解析是纯读文件，但每章都读没意义。 */
const launchCache = new Map();

function cachedLaunch({ manifestPath, repoRoot, profile = 'sdk' }) {
  const key = `${manifestPath}::${repoRoot}::${profile}`;
  if (!launchCache.has(key)) {
    launchCache.set(key, resolveDshLaunch({ manifestPath, repoRoot, profile }));
  }
  return launchCache.get(key);
}

/** 测试用：清空入口缓存（生产不需要）。 */
export function clearSdkLaunchCache() { launchCache.clear(); }

/**
 * 尝试用真实 SDK 运行时跑一次分析。
 *
 * @returns `{ used:boolean, text:string, reason:string, attempted:boolean, status:string }`
 *   · `used:false` + `attempted:false` → 调用方**可以**回退到直连（一次模型调用都没发生）
 *   · `used:true`  + `attempted:true` → 调用方**不得**回退（可能已计费）
 */
export async function runSdkAnalysis({
  flag = process.env.NOVELSTUDIO_SDK_ROUTE,
  decision,
  config = null,
  workId = 0,
  chapterId = 0,
  taskId = '',
  system = '',
  user = '',
  model = '',
  dshHome = '',
  repoRoot = process.cwd(),
  manifestPath = null,
  budget = null,
  capability = 'proposal',
  makeAdapter = createSdkRuntimeAdapter,
  launchResolver = cachedLaunch,
} = {}) {
  const skip = (reason) => ({ used: false, attempted: false, status: 'not_run', text: '', reason });

  if (!decision || decision.ok !== true) {
    return skip((decision && decision.reason) || 'SDK_ROUTE_DISABLED');
  }
  if (!config || !String(config.base_url || '').trim()) return skip('CONFIG_MISSING_BASE_URL');
  if (!dshHome) return skip('MISSING_DSH_HOME');

  const manifest = manifestPath || path.join(repoRoot, 'vendor', 'dsh', 'runtime-manifest.json');
  const launch = launchResolver({ manifestPath: manifest, repoRoot, profile: 'sdk' });
  if (!launch || launch.ok !== true) {
    return skip(`SDK_LAUNCH_REFUSED:${(launch && launch.reason) || 'UNKNOWN'}`);
  }

  const adapter = makeAdapter({ launch });
  const sessionId = sessionIdFor({ workId: Number(workId) || 0, chapterId: Number(chapterId) || 0, taskId: taskId || 'analysis' });
  const prompt = [String(system || '').trim(), String(user || '').trim()].filter(Boolean).join('\n\n');

  const result = await adapter.runTask({
    taskId: taskId || `analysis-${sessionId}`,
    sessionId,
    prompt,
    provider: SDK_DSH_PROVIDER,
    model: String(model || config.model || ''),
    cwd: dshHome,
    envAllow: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED'],
    envExtra: {
      DEEPSEEK_BASE_URL: String(config.base_url || ''),
      DEEPSEEK_API_KEY: String(config.api_key || ''),
      DSH_HOME: String(dshHome),
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
  });

  if (result.terminal === 'done') {
    return { used: true, attempted: true, status: 'done', text: String(result.text || ''), reason: '', pid: result.pid, sessionId };
  }
  // 走到这里 = 已经真的发过请求（或起过进程）：**不回退**，避免二次计费
  return {
    used: true,
    attempted: result.terminal !== 'not_run',
    status: String(result.terminal || 'unknown'),
    text: '',
    reason: String(result.error || 'SDK_TASK_NOT_DONE'),
    pid: result.pid,
    sessionId,
  };
}

/** 组装时用的小工具：把已解析的 api_config 包成路由判定需要的形状。 */
export function routeShapeFor(config, { source = 'sole-config' } = {}) {
  return { ok: true, config, route: { source } };
}
