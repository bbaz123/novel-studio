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

/** 默认端口与 `server.js` 保持一致（那里是 `Number(process.env.PORT) || 3737`）。 */
export const DEFAULT_PORT = 3737;

/** 本实例的自我地址。 */
export function selfBaseUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}`;
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
  return {
    ...base,
    OPENVIKING_PEER_ID: peerId,
    // 顺序要紧：先给默认值，再让调用方覆盖。
    NOVELSTUDIO_BASE_URL: base.NOVELSTUDIO_BASE_URL || selfBaseUrl(p),
    ...(env || {}),
  };
}
