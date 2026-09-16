/**
 * sync-gate.mjs —— 「同一作品的在途同步」与「移除该作品」之间的顺序闸（决策 D8-#6）。
 *
 * 背景（不是推断，是观测到的事实）：
 *   `POST /api/works` 会 fire-and-forget 地 `syncWorkFull(id)`，
 *   `DELETE /api/works` 会 fire-and-forget 地 `removeWorkFromMemory(id)`。
 *   `syncWorkFull` 要逐文件串行写几十个请求（生产上约 30 秒），于是「建完立刻删」时：
 *   移除先把目录删掉，同步随后继续把剩下的文件写进去 → 留下一个**数据库里已无对应作品的
 *   孤儿目录**。D3 在生产记忆库里发现 183 个孤儿目录，当天新增的那 1 个正是此竞态。
 *
 * 为什么把这段抽成独立模块，而不是直接写在 openviking-sync.js 里：
 *   那样只能靠真连 OpenViking 才能验证，而"竞态有没有被消掉"恰恰是最该被钉住的事。
 *   抽出来之后它**没有依赖**，可以用假时钟离线跑出真实时序，并配阴性对照。
 *
 * 语义：
 *   - `register(workId, promise)` 登记在途任务；
 *   - `shouldStop(workId)` 供任务在**每次写之前**询问是否该停手（协作式取消）；
 *   - `cancelAndDrain(workId)` 先举旗、再等在途任务真正结束——返回后才允许删目录。
 *
 * ⚠️ 为什么必须是"先举旗、再等"而不是"直接等"：
 *   只等不收手的话，一个要跑 30 秒的同步仍然会把 30 秒的文件全部写完，删除照样在它
 *   后面发生 —— 顺序对了，但中间白白写了 30 秒，且期间任何一次失败重试又会留下孤儿。
 */

/**
 * @returns {{
 *   register: (workId: string|number, promise: Promise<any>) => Promise<any>,
 *   shouldStop: (workId: string|number) => boolean,
 *   cancelAndDrain: (workId: string|number) => Promise<{drained: boolean, cancelled: boolean}>,
 *   inFlightCount: () => number,
 * }}
 */
export function createSyncGate() {
  /** @type {Map<string, Promise<any>>} 作品 → 在途同步任务 */
  const inFlight = new Map();
  /** @type {Set<string>} 已被请求移除的作品（令在途任务尽快停手） */
  const cancelRequested = new Set();

  const key = (workId) => String(workId);

  return {
    /** 登记一个在途任务；返回同一个 promise，任务结束后自动注销（不泄漏）。 */
    register(workId, promise) {
      const k = key(workId);
      inFlight.set(k, promise);
      const done = () => {
        // 只有当"当前登记的仍是自己"时才注销：避免晚到的旧任务注销掉新任务的登记。
        if (inFlight.get(k) === promise) inFlight.delete(k);
      };
      promise.then(done, done);
      return promise;
    },

    /** 任务在每次产生副作用之前调用：true = 本作品已被请求移除，应当立刻停手。 */
    shouldStop(workId) {
      return cancelRequested.has(key(workId));
    },

    /**
     * 举旗 + 等在途任务收手。**返回之后才允许删目录**。
     * 即使任务抛错也要把在途登记清干净（用 finally），否则后来的删除会被一个死任务挡住。
     */
    async cancelAndDrain(workId) {
      const k = key(workId);
      cancelRequested.add(k);
      const pending = inFlight.get(k);
      if (pending) {
        try { await pending; } catch { /* 任务失败不影响移除流程 */ }
      }
      // 等完之后再确认一次：任务可能在 await 期间又登记了新的一轮。
      const again = inFlight.get(k);
      if (again) { try { await again; } catch { /* 同上 */ } }
      return { drained: !inFlight.has(k), cancelled: true };
    },

    /** 移除流程收尾：撤掉旗子，让后续同名作品（id 可能被复用）不被误伤。 */
    release(workId) {
      cancelRequested.delete(key(workId));
    },

    inFlightCount() {
      return inFlight.size;
    },
  };
}
