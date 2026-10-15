/**
 * nsdsh/lib/egress.mjs —— 出网拒绝证据的**共用探针**（S01）。
 *
 * 为什么单独一层、而不是各脚本自己写一遍 fetch：
 *   `preflight.mjs`（环境前置检查）与 `check-stage.mjs`（S01 验收项 a）都要回答同一个问题
 *   ——"非回环出网真的被拒了吗"。两份实现早晚漂移，而漂移的代价是**假绿**：
 *   一处放宽了判定，另一处还在报"已拒绝"，报告与事实就不一致了。
 *
 * 这里有一条本机实测出来的关键区分（2026-10-15，两次不同环境都复现）：
 *   同一个子进程里，`net.connect` 到 127.0.0.1 **成功**（打印 TCP_OK），
 *   而 `fetch('http://127.0.0.1:.../')` 与 `http.get(...)` **零响应直到超时**。
 *
 *   ⚠️ 归属已订正：这**不是**"guard 误拦合法流量"，也**不只是**受限沙箱的现象。
 *   对照实验（2026-10-15，本会话已切到 danger-full-access、无文件沙箱）：
 *   把 guard 完全去掉、让子进程 fetch **父进程**持有的回环 HTTP 服务，**同样超时**
 *   （父进程侧 `netstat` 能看到已建立/等待的连接，`HTTP_OK` 一次都没出现）。
 *   因此准确的表述是：**在本 DSH 执行环境里，子进程向父进程托管的回环 HTTP 服务取响应取不到。**
 *   推论（对后续阶段很重要）：S06/S10 要"捕获假模型实际收到的请求"时，
 *   被测服务与假模型必须落在**同一个进程树里的同一侧**，不能靠"父进程起假模型、子进程去连"。
 *
 *   若不把这条区分写进探针，"回环被允许"这条阴性对照会把**执行环境限制**报成
 *   "guard 误拦了合法流量"（代码缺陷）——那是错误归因，比不检查更坏。
 *
 * 纪律：探针只负责取证与分类，**不负责下结论**；调用方决定 FAIL 还是 BLOCKED。
 */
import { runCommand } from './gate.mjs';
import { REPO, rel } from './report.mjs';
import { GUARD_CJS } from './isolate.mjs';

/** 子进程输出里出现这个签名 = 确认出网被拒。 */
export const EGRESS_DENIAL_SIGNATURE = 'NSDSH_EGRESS_DENIED';

/**
 * 起一条子进程，同时取三组证据：
 *   TCP_OK        —— `node:net` 能否连到该回环地址（guard 覆盖不到这一层）
 *   HTTP_OK:<n>   —— `fetch` 能否完成（经过 guard）
 *   DENIED / 拒网签名
 *
 * 子进程脚本必须在打印结论后**显式 process.exit()**：undici 的 keep-alive 连接会让事件循环
 * 一直活着，`spawnSync` 于是等到超时（实测 `status=null` / `spawn ETIMEDOUT`）。
 * "进程没退出"与"网络被拒"必须分开，否则阴性对照会误报。
 */
export function probeChild(url, { guard = true, timeoutMs = 60000 } = {}) {
  const code = `
const net = require('node:net');
const target = process.argv[1];
const u = new URL(target);
const out = [];
const tcp = new Promise((resolve) => {
  const s = net.connect(Number(u.port), u.hostname, () => { out.push('TCP_OK'); s.destroy(); resolve(true); });
  s.on('error', (e) => { out.push('TCP_ERR:' + e.code); resolve(false); });
  setTimeout(() => { try { s.destroy(); } catch (_) {} out.push('TCP_TIMEOUT'); resolve(false); }, 3000);
});
const http = new Promise((resolve) => {
  const timer = setTimeout(() => { out.push('HTTP_TIMEOUT'); resolve(false); }, 3000);
  fetch(target)
    .then((r) => { clearTimeout(timer); out.push('HTTP_OK:' + r.status); resolve(true); })
    .catch((e) => { clearTimeout(timer); out.push('HTTP_ERR:' + (e && e.code) + ':' + (e && e.message)); resolve(false); });
});
Promise.all([tcp, http]).then(() => { console.log(out.join('|')); process.exit(0); });
`;
  const r = runCommand([process.execPath, '-e', code, url], {
    cwd: REPO,
    env: guard ? { NODE_OPTIONS: `--require=${GUARD_CJS}` } : {},
    timeoutMs,
  });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const tokens = String(r.stdout || '').trim().split('|').map((t) => t.trim()).filter(Boolean);
  return {
    status: r.status,
    transport: r.transport,
    error: r.error,
    ms: r.ms,
    environmentBlocked: r.environmentBlocked,
    text,
    tokens,
    denialSignature: text.includes(EGRESS_DENIAL_SIGNATURE),
    tcpOk: tokens.includes('TCP_OK'),
    httpOk: tokens.some((t) => t.startsWith('HTTP_OK')),
    httpTimeout: tokens.includes('HTTP_TIMEOUT'),
    // 进程级超时（被杀）或 HTTP 级超时 —— 统一叫"没测出来"。
    hung: r.error === 'ETIMEDOUT' || tokens.includes('HTTP_TIMEOUT'),
  };
}

/**
 * 证明"非回环 fetch 被拒"。返回一个**已分类**的结论：
 *   verdict: 'denied' | 'not-denied' | 'blocked'
 * `blocked` 表示子进程根本没跑起来（沙箱拒绝），此时既不能判 PASS 也不能判回归。
 */
export function probeEgressDenied(url = 'http://example.com') {
  const r = probeChild(url);
  const detail = `exit=${r.status} transport=${r.transport} tokens=[${r.tokens.join(' ')}]`
    + (r.error ? ` err=${r.error}` : '');
  if (r.denialSignature && r.status !== 0) return { ...r, verdict: 'denied', detail };
  if (r.status === null || r.environmentBlocked) return { ...r, verdict: 'blocked', detail };
  return { ...r, verdict: 'not-denied', detail };
}

/**
 * 阴性对照：guard **不得**拦掉合法回环流量。
 *
 * 判定分三种，且必须分开（这是本模块存在的理由）：
 *   allowed —— HTTP 走通 → guard 允许回环（正确）
 *   blocked —— 裸 TCP 通、HTTP 超时、且**没有**拒网签名 → 沙箱限制了子进程 HTTP，
 *             本次无法证明阴性对照，只能记 BLOCKED
 *   denied  —— 出现拒网签名或 HTTP 明确报错而非超时 → guard 真的误拦了合法回环
 */
export function probeLoopbackAllowed(url) {
  const r = probeChild(url);
  const detail = `exit=${r.status} tokens=[${r.tokens.join(' ')}]` + (r.error ? ` err=${r.error}` : '');
  if (r.httpOk) return { ...r, verdict: 'allowed', detail };
  if (r.denialSignature || r.tokens.some((t) => t.startsWith('HTTP_ERR:'))) {
    return { ...r, verdict: 'denied', detail };
  }
  if (r.tcpOk || r.hung) return { ...r, verdict: 'blocked', detail };
  return { ...r, verdict: 'denied', detail: `${detail}（既不通也不是超时）` };
}

/** 供报告引用的 guard 相对路径（避免每个脚本各写一遍 rel()）。 */
export const GUARD_REL = rel(GUARD_CJS);
