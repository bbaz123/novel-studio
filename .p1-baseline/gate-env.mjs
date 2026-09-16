#!/usr/bin/env node
/**
 * gate-env.mjs —— 一条命令搭好「可证明的隔离环境」，供并发闸门端到端验证使用。
 *
 * 为什么需要：2026-09-15 事故的根因之一是「测试指向了不受控的实例」——
 * 套件 `--base` 指向的 3739 实例由另一个后台作业启动，命令行里根本没有隔离变量，
 * 于是产生了未经批准的真实调用。手工分步搭建（先起实例、再设变量、再跑测试）
 * 天然容易错配。这里把「起黑洞端点 + 起隔离实例 + 登记环境」合成一条命令，
 * 并落一个 marker 文件让测试可以核对。
 *
 * 隔离配方（每条都对应一类污染）:
 *   NOVELSTUDIO_DATA_DIR=<临时目录>     数据库隔离（logger/db 都按它解析）
 *   PORT=<空闲端口>                     实例隔离；harness 子进程会据此回连本实例
 *   NOVELSTUDIO_OV_DISABLED=1           停用服务端 OpenViking 集成（不写 ov_uri 目录）
 *   NOVELSTUDIO_OPENVIKING_PEER_ID=...  把 harness 任务的记忆写入限到测试 peer，
 *                                       不落进生产 workspace peer
 *   DEEPSEEK_BASE_URL=http://127.0.0.1:<黑洞端口>
 *                                       LLM 流量进黑洞：作业长时间占槽且不出网
 *   DEEPSEEK_API_KEY=<哨兵无效值>        兜底：万一 baseURL 未生效，请求应 401 而非计费
 *                                       （依据 dsh-base 注释「继承环境优先于凭据存储」，
 *                                        **未实测**；权威保护是黑洞连接证明 + 跑后审计）
 *
 * 用法:
 *   node .p1-baseline/gate-env.mjs                 # 前台运行，Ctrl+C 收工
 *   node .p1-baseline/gate-env.mjs --stop          # 按 marker 结束遗留实例
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startBlackhole } from './blackhole.mjs';

export const MARKER = path.join('.p1-baseline', 'gate-env.json');
/** --stop 留下的「自愿收工」标记：前台进程据此不再把子进程退出当成异常。 */
export const STOP_FLAG = path.join('.p1-baseline', 'gate-env.stop');
const SENTINEL_KEY = 'sk-isolation-sentinel-not-a-real-key';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/** 取一个当前空闲的本地端口（拿完即释放，存在极小的竞争窗口，够用）。 */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function reachable(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status < 500;
  } catch { return false; }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  if (process.argv.includes('--stop')) {
    if (!fs.existsSync(MARKER)) { console.log('没有 marker 文件，无需清理'); process.exit(0); }
    const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    // 先留标记再杀：前台门禁进程据此把这次退出当成自愿收工，而不是「实例崩了」。
    fs.writeFileSync(STOP_FLAG, new Date().toISOString());
    for (const [what, pid] of [['实例', m.serverPid]]) {
      if (!pid) continue;
      try { process.kill(pid); console.log(`已结束${what} PID=${pid}`); }
      catch (e) { console.log(`结束${what} PID=${pid} 失败/已退出：${e.message}`); }
    }
    fs.rmSync(MARKER, { force: true });
    console.log('marker 已删除');
    console.log('（若前台 gate-env 进程仍在运行，它会在几秒内自行退出；stop 标记会被它清掉）');
    process.exit(0);
  }

  const dataDir = arg('--data-dir', path.join('.p1-baseline', 'gate-data'));
  // 允许钉住端口：项目原生套件（api-test-suite.mjs）硬编码 3738，
  // 要复现它就必须能让隔离实例正好落在那个端口上。
  const wantPort = Number(arg('--port', '0')) || 0;
  const bhLog = path.join('.p1-baseline', 'blackhole-gate.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(bhLog, { force: true });   // 每次从零开始，避免旧连接被当成本次证明

  const bhPort = await freePort();
  const bh = await startBlackhole({ port: bhPort, logPath: bhLog });
  const port = wantPort || await freePort();
  if (wantPort) {
    const taken = await reachable(`http://127.0.0.1:${wantPort}/api/works`, 500);
    if (taken) {
      console.log(`✗ 端口 ${wantPort} 已被占用，拒绝启动（否则测试会打到别人的实例上——事故根因之一）。`);
      await bh.close();
      process.exit(1);
    }
  }

  const env = {
    ...process.env,
    NOVELSTUDIO_DATA_DIR: dataDir,
    PORT: String(port),
    NOVELSTUDIO_OV_DISABLED: '1',
    NOVELSTUDIO_OPENVIKING_PEER_ID: 'novelstudio-isolation-test',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${bh.port}`,
    DEEPSEEK_API_KEY: SENTINEL_KEY,
  };

  console.log('═══ 隔离环境 ═══');
  console.log(`  实例端口      : ${port}`);
  console.log(`  数据目录      : ${dataDir}`);
  console.log(`  黑洞 LLM 端点 : 127.0.0.1:${bh.port}（永不响应）`);
  console.log(`  黑洞连接日志  : ${bhLog}`);
  console.log(`  OpenViking    : 服务端停用 + 任务侧 peer=novelstudio-isolation-test`);
  console.log(`  API Key 兜底  : 已置哨兵值（未实测，仅为二次保险）`);

  const child = spawn(process.execPath, ['server.js'], {
    env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let serverLog = '';
  let shuttingDown = false;   // 主动收工（Ctrl+C / --stop）时不该报「实例异常退出」
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });
  child.on('exit', (code) => {
    // 三种情况都算「自愿」：本进程正在收工、外部用 --stop 收了工、marker 已被清掉。
    if (shuttingDown || fs.existsSync(STOP_FLAG) || !fs.existsSync(MARKER)) {
      shuttingDown = true;
      try { fs.rmSync(STOP_FLAG, { force: true }); } catch { /* 忽略 */ }
      // ⚠️ 必须**真正退出进程**（并关掉黑洞监听）。早先这里只是 return，
      // 于是实例虽然停了、黑洞仍在监听、gate-env 进程一直活着 →
      // 后台作业一轮漏一个，直到撞上作业数量上限才发现（2026-09-15 晚）。
      Promise.resolve(bh.close()).catch(() => {}).finally(() => process.exit(0));
      return;
    }
    console.log(`\n⚠ 实例退出（code=${code}）。最后输出：`);
    console.log(serverLog.split(/\r?\n/).slice(-12).join('\n'));
    Promise.resolve(bh.close()).catch(() => {}).finally(() => process.exit(1));
  });

  const deadline = Date.now() + 60000;
  let up = false;
  while (Date.now() < deadline) {
    if (await reachable(`http://127.0.0.1:${port}/api/works`)) { up = true; break; }
    await new Promise((s) => setTimeout(s, 1000));
  }
  if (!up) {
    console.log('\n✗ 实例未在 60s 内就绪。输出：');
    console.log(serverLog.split(/\r?\n/).slice(-20).join('\n'));
    child.kill(); await bh.close(); process.exit(1);
  }

  const marker = {
    port, dataDir, blackholePort: bh.port, blackholeLog: bhLog,
    serverPid: child.pid, startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(MARKER, JSON.stringify(marker, null, 2));

  console.log('\n✓ 环境就绪。授权并运行端到端闸门验证：\n');
  console.log(`  $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'`);
  console.log(`  node .p1-baseline/verify-harness-gate.mjs http://127.0.0.1:${port} --require-blackhole ${bh.port}`);
  console.log('\n（Ctrl+C 结束实例与黑洞；若已被强杀，用 --stop 清理）');

  const shutdown = async () => {
    shuttingDown = true;
    try { child.kill(); } catch { /* 已退出 */ }
    await bh.close();
    fs.rmSync(MARKER, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
