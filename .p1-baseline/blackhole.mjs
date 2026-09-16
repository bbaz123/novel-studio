#!/usr/bin/env node
/**
 * blackhole.mjs —— 「黑洞」LLM 端点：接受 TCP 连接、记录连接、**永不响应**。
 *
 * 为什么需要：`verify-harness-gate.mjs` 必须创建真实 harness 任务才能验证并发闸门。
 * 2026-09-15 事故的根因之一就是「以为死端口 = 零成本」——死端口会立刻 ECONNREFUSED，
 * 任务秒退，既占不住槽位（验证不了闸门），也无法证明流量真的走了隔离端点。
 *
 * 黑洞端口解决两件事：
 *   1. **占得住槽**：连接建立后永不响应，dsh 子进程会一直等到自己的超时，
 *      作业长时间处于 running —— 这正是闸门验证需要的前置条件；
 *   2. **可证明**：每条到达的连接都落进 JSONL 日志。闸门检查要求日志里有本次窗口的连接，
 *      否则**判失败**（无法证明隔离成立）。这样「通过」必须以「流量真的打到我的监听器」为前提。
 *
 * 用法:
 *   node .p1-baseline/blackhole.mjs --port 19999 [--log .p1-baseline/blackhole-19999.jsonl]
 *   node .p1-baseline/blackhole.mjs --status --log <日志>
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/**
 * 起一个永不响应的监听器；每条连接的元信息追加进 JSONL。
 * @param {{port?:number, logPath?:string, dumpPath?:string, dumpBytes?:number}} [opts]
 *   dumpPath/dumpBytes：把每条连接收到的**原始字节**追加进该文件（默认每连接最多 512KB）。
 *   用途：要看 dsh 子进程真正发出去的是什么（例如请求体里有没有挂上 novel_* 工具与人设），
 *   必须让对端**接受连接但不响应**——死端口连不上，请求体根本发不出来。
 * @returns {Promise<{port:number, logPath:string, dumpPath:string, logged:Array, close:()=>Promise<void>}>}
 */
export async function startBlackhole({ port = 0, logPath, dumpPath, dumpBytes = 512 * 1024 } = {}) {
  const logged = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    // 只读**不写**：记录一小段首字节用于取证（HTTP 请求行），需要原始报文时另存 dump。
    let peeked = false;
    let dumped = 0;
    const rec = {
      ts: new Date().toISOString(),
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
    };
    socket.on('data', (d) => {
      if (dumpPath && dumped < dumpBytes) {
        const take = d.subarray(0, Math.min(d.length, dumpBytes - dumped));
        dumped += take.length;
        try { fs.appendFileSync(dumpPath, take); } catch { /* dump 失败不影响监听 */ }
      }
      if (peeked) return;
      peeked = true;
      rec.firstBytes = d.subarray(0, 200).toString('utf8').replace(/\r?\n/g, ' ⏎ ');
      if (logPath) {
        try { fs.appendFileSync(logPath, JSON.stringify(rec) + '\n'); } catch { /* 日志失败不影响监听 */ }
      }
      logged.push(rec);
    });
    socket.on('error', () => { /* 对端超时断开是正常的 */ });
    socket.on('close', () => { sockets.delete(socket); });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    logPath,
    dumpPath,
    logged,
    /** 已 dump 的字节数（轮询用：请求体到了没有）。 */
    dumpedBytes: () => (dumpPath && fs.existsSync(dumpPath) ? fs.statSync(dumpPath).size : 0),
    close: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* 忽略 */ } }
      server.close(() => resolve());
    }),
  };
}

/** 读取黑洞日志里某时刻之后的连接记录。 */
export function readBlackholeLog(logPath, sinceMs = 0) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (new Date(o.ts).getTime() >= sinceMs) out.push(o);
    } catch { /* 半行忽略 */ }
  }
  return out;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const LOG = arg('--log', '');
  if (process.argv.includes('--status')) {
    const rows = readBlackholeLog(LOG, 0);
    console.log(`黑洞日志: ${LOG || '（未指定 --log）'}`);
    console.log(`连接记录: ${rows.length} 条`);
    for (const r of rows) console.log(`  ${r.ts}  ${r.remote}  ${r.firstBytes ? '「' + r.firstBytes.slice(0, 70) + '」' : '(无数据)'}`);
    process.exit(0);
  }
  const PORT = Number(arg('--port', '0'));
  const logPath = LOG || path.join('.p1-baseline', `blackhole-${PORT || 'auto'}.jsonl`);
  const bh = await startBlackhole({ port: PORT, logPath });
  console.log(`黑洞监听中：127.0.0.1:${bh.port}（永不响应）`);
  console.log(`连接日志：${logPath}`);
  console.log('把实例的 LLM 端点指到它，例如 $env:DEEPSEEK_BASE_URL=\'http://127.0.0.1:' + bh.port + '\'');
  process.on('SIGINT', async () => { await bh.close(); process.exit(0); });
}
