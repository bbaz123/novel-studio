/**
 * ai/http/respond.mjs —— R05（F12-A）：HTTP 响应与请求体读取。
 *
 * ── 为什么抽这一域 ─────────────────────────────────────────────────────────
 * `server.js` 一万多行，一次性拆完风险极高。按方案 §7 的原则，一轮只处理**一个低耦合域**，
 * 先锁契约、再挪代码、最后证明行为等价。
 *
 * 这一域（响应封装 + 请求体读取）满足三个条件：
 *   ① **只依赖 `node:` 内建**，不碰数据库、不碰创作内核；
 *   ② 调用面很宽（`sendJSON` 218 处、`readBody` 93 处）—— 正因为宽，才更该有单一所有者；
 *   ③ 语义完全由 HTTP 规范与本项目既有约定决定，抽取时**不需要改一行业务逻辑**。
 *
 * ── 契约（抽取前后逐字一致，这是"行为等价"的判据）──────────────────────────
 *   · `sendJSON(res, status, data)`：`application/json; charset=utf-8` + `no-store`，
 *     **不带** `Access-Control-Allow-Origin` —— 本地工坊存着 API Key 与作品数据，
 *     任何跨源页面都不该能读到。
 *   · `sendError(res, status, message, extra)`：除人话之外必须回**机器可判的 code**
 *     （如 `EMPTY_OVERWRITE_BLOCKED`），客户端据此显示"怎么补救"，而不是正则匹配中文。
 *   · `readBody(req)`：按**字节**累计（不是逐块拼字符串），超限抛 `PAYLOAD_TOO_LARGE`，
 *     JSON 畸形抛 `INVALID_JSON`；先把剩余请求体丢弃干净再拒，保证 413 能回到客户端。
 *   · `readBodyOrError(req, res)`：把**真实原因**回给调用方（413 / 400 分得清），
 *     返回 `{ ok:false }` 表示"已回响应，调用方直接 return"。
 *
 * 本模块**不持有任何状态**：没有缓存、没有全局句柄，因此可以安全地被多处 import。
 */

/** 请求体上限：36MB。容纳 24MiB 归档 base64 后的请求体；写请求另有本机 Origin 校验兜底。 */
export const MAX_BODY_BYTES = 36_000_000;

/** 丢弃请求体的字节上限：对方只声明不发时，不能无限读下去。 */
export const MAX_DRAIN_BYTES = 96_000_000; // 超限请求最多再丢弃 96MB，避免被超大请求拖住连接

/** 丢弃请求体的时间上限：对端只声明不发时，最多等这么久。 */
export const DRAIN_DEADLINE_MS = 5000;

/**
 * 回一个 JSON 响应。
 *
 * 刻意**不加** `Access-Control-Allow-Origin: *`：这是本地工坊，响应里可能有作品正文与
 * 配置信息，任何浏览器页面跨源读取都该被浏览器 CORS 拦下。同源 UI 与服务端工具不受影响。
 */
export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 回一个错误响应。
 * @param extra 附加的机器可判字段（如 `{ code: 'EMPTY_OVERWRITE_BLOCKED' }`）；纯附加，老调用方不受影响
 */
export function sendError(res, status, message, extra = null) {
  sendJSON(res, status, {
    error: message || 'Internal error',
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}

/**
 * 把请求体读干净后丢弃（用于"体积超限"时必须先读完再拒，否则 413 发不回去）。
 * 双上限：字节数 + 时间。
 */
export function drainRequestBody(req, budget = MAX_DRAIN_BYTES) {
  return new Promise((resolve) => {
    let drained = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', finish);
      req.off('error', finish);
      clearTimeout(timer);
      resolve();
    };
    const onData = (chunk) => {
      drained += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (drained >= budget) finish();
    };
    const timer = setTimeout(finish, DRAIN_DEADLINE_MS);
    req.on('data', onData);
    req.on('end', finish);
    req.on('error', finish);
    req.resume();
  });
}

/**
 * 读并解析 JSON 请求体。
 *
 * 两个刻意的实现细节（都是踩过坑才有的）：
 *   · **按字节累计**而不是逐块拼字符串 —— 既让上限严格按字节生效，也避免跨 TCP 分块边界的
 *     多字节 UTF-8 字符被逐块解码成乱码；
 *   · 超限时**先丢弃剩余请求体**再 reject，否则连接里的未读数据会让 413 响应发不出去。
 *
 * @throws `Error` with `code = 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON'`
 */
export async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) {
    await drainRequestBody(req);
    const err = new Error(`请求体过大（声明 ${declared} 字节 > 上限 ${maxBytes} 字节）`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        settled = true;
        drainRequestBody(req).then(() => {
          const err = new Error(`请求体过大（已接收 ${received} 字节 > 上限 ${maxBytes} 字节）`);
          err.code = 'PAYLOAD_TOO_LARGE';
          reject(err);
        });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const data = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        resolve(data ? JSON.parse(data) : {});
      } catch {
        const e = new Error('Invalid JSON');
        e.code = 'INVALID_JSON';
        reject(e);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * `readBody` 的安全包装：失败时把**真实原因**回给调用方。
 *
 * 为什么必须有它：曾经有路由写成 `readBody(req).catch(() => ({}))`，于是
 * "JSON 畸形"（INVALID_JSON）被报成"缺少 dir 字段"、"体积超限"（413）被降级成 400 ——
 * 报错与真实原因无关，排查方向整个跑偏。
 *
 * @returns `{ ok:true, body }` 或 `{ ok:false }`（后者表示已回响应，调用方直接 return）
 */
export async function readBodyOrError(req, res, { maxBytes = MAX_BODY_BYTES } = {}) {
  try {
    return { ok: true, body: await readBody(req, { maxBytes }) };
  } catch (e) {
    const tooLarge = e && e.code === 'PAYLOAD_TOO_LARGE';
    if (tooLarge) res.setHeader('Connection', 'close'); // 请求体没读完：明确关闭，不复用这条连接
    sendError(res, tooLarge ? 413 : 400, e && e.code === 'INVALID_JSON'
      ? '请求体不是合法 JSON'
      : ((e && e.message) || '请求体读取失败'));
    return { ok: false };
  }
}
