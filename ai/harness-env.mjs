// dsh 子进程环境契约：把「本实例」的身份下发给 harness 任务。
//
// 为什么要有这个模块：dsh 侧的小说工具（`novel-tools.mjs`）解析服务地址的顺序是
//   `NOVELSTUDIO_BASE_URL` → 插件安装时写入的 `config.baseUrl`（写死 3737）→ 默认 3737
// 所以只要某个调用点忘记下发 `NOVELSTUDIO_BASE_URL`，任务里的 novel_* 工具就会
// **回落到 3737** —— 在隔离实例上跑验证时，这会直接写进生产库。
// 2026-09-15 的实测缺口：`compressStoryMemory` 与 `generateNovelFromHarness`
// 两处都没下发（只有 `/harness/run` 那条路下发了）。
//
// 修在根上：不逐个调用点补，而是在**唯一的 spawn 出口**给一个等于本实例地址的默认值。
// 这样现有与将来的调用点都自动正确；调用方显式给的值仍然优先。
//
// 纯模块、零依赖、无副作用：不 import logger/db，所以可以离线单测
// （import `harness.js` 会经 logger.js 解析数据目录并落盘，是已知陷阱）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认端口与 `server.js` 保持一致（那里是 `Number(process.env.PORT) || 3737`）。 */
export const DEFAULT_PORT = 3737;

/** 本实例的自我地址。 */
export function selfBaseUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
}

// ── 决策 B：写作任务的专用 DSH_HOME ─────────────────────────────────────────
//
// 为什么需要：dsh 在**每次启动 profile** 时都会重建 `$DSH_HOME/profiles/node_modules`
// 这一层宿主包镜像（`packages/boot/app-boot/src/profile.ts` 的 `healProfilesModuleFallback`，
// 由 `apps/cli/src/profile-boot.ts:99` 调用），且"安装搬家时会把链接改指过去"。
// GUI 跑全局 0.1.5、写作任务跑本地仓库 0.1.1，共用 `~/.dsh` 时**谁后启动就改写这一层**
// （实测 244 个 junction：197 指仓库 / 47 指全局）。
// 给写作任务独立的 `DSH_HOME`，它就只改写自己那一层——碰撞从"无害化"变成"不可能"。
// 依据：`resolveDshHome()` 优先级 = 显式配置 → `$DSH_HOME` → `~/.dsh`。

/** 覆盖专用 home 路径的环境变量。 */
export const DEDICATED_HOME_ENV = 'NOVELSTUDIO_DSH_HOME';
/** 默认专用 home 名（与 `~/.dsh` 平级，一眼看得出是一对）。 */
export const DEFAULT_DEDICATED_HOME = '.dsh-novel';

/** 专用 home 的路径（只算路径，不判断可用性）。 */
export function dedicatedHomePath(baseEnv = process.env) {
  const explicit = String(baseEnv[DEDICATED_HOME_ENV] || '').trim();
  return explicit || path.join(os.homedir(), DEFAULT_DEDICATED_HOME);
}

/**
 * 专用 home 是否**可用**：必须含 `profiles/`。
 *
 * 为什么要有这个判断而不是无脑设 `DSH_HOME`：设成一个不存在的 home，
 * dsh 会找不到 profile 而启动失败——那比"继续共用"更糟。
 * 所以不可用时**退回共享 home**（即改动前的行为），并把这件事交给调用方去告警。
 */
export function dedicatedHomeUsable(p = dedicatedHomePath()) {
  try { return fs.existsSync(path.join(p, 'profiles')); } catch { return false; }
}

/** 本任务应当使用的 `DSH_HOME`；返回 `null` 表示"沿用共享 home"。 */
export function resolveTaskDshHome(baseEnv = process.env) {
  const p = dedicatedHomePath(baseEnv);
  return dedicatedHomeUsable(p) ? p : null;
}

/**
 * 专用 home 的决策细节，供启动时**如实打印**。
 *
 * 为什么要把"覆盖了环境里已有的 DSH_HOME"这件事显式暴露出来：
 * 实测发现 `DSH_HOME` 是**会随启动方式变的**——从 DSH 派生的终端启动工坊时，
 * 环境里已经带着 `DSH_HOME=~/.dsh`；而从桌面快捷方式启动时没有。
 * 如果让"继承环境"说了算，同一份代码就会**看启动方式决定行为**（一种最难查的坑）。
 * 所以这里的规则是：专用 home 由工坊自己决定；环境里的 `DSH_HOME` 是**启动器自己的** home，
 * 不代表写作任务该用它——被覆盖时要说出来。
 *
 * @returns {{home: string|null, path: string, overridesAmbient: boolean, ambient: string}}
 */
export function taskHomeInfo(baseEnv = process.env) {
  const path = dedicatedHomePath(baseEnv);
  const home = resolveTaskDshHome(baseEnv);
  const ambient = String(baseEnv.DSH_HOME || '');
  return { home, path, ambient, overridesAmbient: Boolean(home && ambient && ambient !== home) };
}

/**
 * 组装 dsh 子进程的环境。
 *
 * @param {object} o
 * @param {number|string} [o.port]  本实例端口（默认取 `process.env.PORT`，再退到 3737）
 * @param {string} o.peerId         OpenViking peer（与 GUI 会话共享记忆库用）
 * @param {object} [o.env]          调用方显式下发的环境变量，**优先级最高**
 * @param {object} [o.baseEnv]      基础环境（默认 `process.env`；测试可注入）
 */
export function harnessChildEnv({ port, peerId, env, baseEnv } = {}) {
  const base = baseEnv || process.env;
  const p = Number(port ?? base.PORT) || DEFAULT_PORT;
  const home = resolveTaskDshHome(base);
  return {
    ...base,
    OPENVIKING_PEER_ID: peerId,
    // 顺序要紧：先给默认值，再让调用方覆盖。
    NOVELSTUDIO_BASE_URL: base.NOVELSTUDIO_BASE_URL || selfBaseUrl(p),
    // 决策 B：把写作任务关进它自己的 home。
    // ⚠️ 这里**有意覆盖**环境里可能已存在的 `DSH_HOME`：那个值是**启动器**的 home
    // （从 DSH 派生的终端启动工坊时它一定存在，从桌面快捷方式启动时不存在），
    // 不代表写作任务该用它。若让它说了算，"B 生不生效"就会取决于你怎么启动工坊——
    // 一种最难查的坑。要换专用 home 请设 `NOVELSTUDIO_DSH_HOME`；要回到共用就删掉专用 home。
    ...(home ? { DSH_HOME: home } : {}),
    ...(env || {}),
  };
}
