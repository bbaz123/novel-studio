/**
 * cache.mjs —— 上下文装配结果缓存（决策 D8-#7）。
 *
 * ── 它存在的理由 ──────────────────────────────────────────────────────────────
 * 装配一次上下文要读十几张表并渲染，同一章在一次写作流程里会被反复取用，
 * 所以要有缓存。但缓存必须能回答一个问题：**「这份结果还算数吗？」**
 *
 * ── 为什么不能只看时间 ────────────────────────────────────────────────────────
 * 上下文的内容有一部分来自**进程之外**：记忆库（OpenViking）的语义索引由后台异步建。
 * 进程内的数据版本号（`invalidateAll`）看不到它。P1 的 F4 就是这么来的：
 * 索引还没建完时算出的「召回为空」被无限期缓存，同一个请求在实例重启前后分别返回
 * 23,275 / 24,738 字。当时的修法是加一个 120 秒 TTL —— **能兜住，但靠的是猜**：
 * 任意改动后最多陈旧 2 分钟，而"索引完成"这件事其实有明确的信号可看。
 *
 * ── 现在的判据 ────────────────────────────────────────────────────────────────
 *   缓存有效 ⇔ 版本一致 **且** 未超过 TTL
 *   版本 = 进程内数据版本 + `externalVersionOf(scope)` 提供的外部状态
 * 于是「记忆库索引完成」会**立刻**让相关缓存失效，而 TTL 退回纯兜底（默认 10 分钟），
 * 只用来防"没人通知我们"的极端情况。
 *
 * 抽成独立模块是为了能**离线**验证这条语义（含阴性对照），而不是只靠读代码下结论。
 */

/**
 * @param {object} opts
 * @param {number} opts.ttlMs   兜底有效期（毫秒）
 * @param {number} [opts.max]   最多缓存多少条（LRU）
 * @param {(scope: string) => string} [opts.externalVersionOf]
 *        读取"这个 scope（通常是 workId）对应的进程外状态"；
 *        返回串变化即视为**输入已变**，缓存立刻失效。抛错视为无法判断（返回空串）。
 */
export function createContextCache({ ttlMs, max = 64, externalVersionOf = () => '' } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('createContextCache 需要正整数 ttlMs');
  const store = new Map();
  let dataVersion = 0;
  let hits = 0;
  let misses = 0;

  const safeExternal = (scope) => {
    try { return String(externalVersionOf(scope) ?? ''); } catch { return ''; }
  };
  const versionOf = (scope) => `${dataVersion}|${safeExternal(scope)}`;

  return {
    /** 取缓存。`scope` 决定看哪一份外部状态（省略时按空处理）。 */
    get(key, scope = '') {
      const hit = store.get(key);
      if (hit && hit.version === versionOf(scope) && Date.now() - hit.at < ttlMs) {
        store.delete(key);
        store.set(key, hit);   // LRU：命中移到队尾
        hits += 1;
        return hit.ctx;
      }
      if (hit) store.delete(key);
      misses += 1;
      return undefined;
    },

    set(key, ctx, scope = '') {
      store.set(key, { version: versionOf(scope), at: Date.now(), ctx });
      while (store.size > max) store.delete(store.keys().next().value);
    },

    /** 进程内数据变了（作品/章节/设定被改）：整体作废。 */
    invalidateAll() { dataVersion += 1; },

    size: () => store.size,
    stats: () => ({ hits, misses, size: store.size, dataVersion }),

    /** 仅供单测：看清当前版本串由什么组成。 */
    _versionOf: versionOf,
  };
}
