/**
 * 真实付费评测 · 隔离装置（零副作用）
 *
 * 安全边界（逐条对应任务书与全局规则）：
 *   · 不碰真实作品库：`NOVELSTUDIO_DATA_DIR` 指向临时目录；真实 `data/novel.db` **只读**打开，
 *     只把 `api_configs` 那**一行**复制进临时库（凭据不经手、不打印、不落明文日志）。
 *   · 不打印密钥：全程只输出 key 的 sha256 前 8 位，用于核对"复制的是同一把"。
 *   · 不直接调付费大模型：调用走**应用自己的** `/api/ai/*`（服务端 `callAI`），
 *     文档里那句"不能直接调用付费大模型"因此成立。
 *   · 端口用 3738（作者实例在 3737，绝不打扰）。
 */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REAL_DB = path.resolve('data/novel.db');
export const PORT = 3738;
export const BASE = `http://127.0.0.1:${PORT}`;

const sha8 = (s) => (s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8) : '(none)');

/** 建临时数据目录：真实库只读 → 复制 api_configs 一行 → 返回 { dir, configId, keySha8 }。 */
export function makeIsolatedDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-paid-eval-'));
  const real = new DatabaseSync(REAL_DB, { readOnly: true });
  const rows = real.prepare('SELECT id, name, base_url, api_key, model, temperature, max_tokens FROM api_configs ORDER BY id').all();
  real.close();
  if (!rows.length) throw new Error('真实库里没有任何 api_configs 行：无法进行付费评测');
  const withKey = rows.filter((r) => String(r.api_key || '').trim());
  if (!withKey.length) throw new Error('真实库里没有带 api_key 的配置行：无法进行付费评测（如实记 not_run）');

  const dst = new DatabaseSync(path.join(dir, 'novel.db'));
  dst.exec(`CREATE TABLE api_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'deepseek-chat',
    temperature REAL NOT NULL DEFAULT 0.8,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const ins = dst.prepare('INSERT INTO api_configs (id,name,base_url,api_key,model,temperature,max_tokens) VALUES (?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.id, r.name, r.base_url, r.api_key, r.model, r.temperature, r.max_tokens);
  const check = dst.prepare('SELECT id, api_key FROM api_configs WHERE id = ?').get(withKey[0].id);
  dst.close();
  const copiedSha = sha8(check && check.api_key);
  if (copiedSha !== sha8(withKey[0].api_key)) throw new Error('凭据复制校验失败（哈希不一致）：中止，不发起任何请求');
  return { dir, configId: withKey[0].id, keySha8: copiedSha, model: withKey[0].model, baseUrl: withKey[0].base_url };
}

/** 启动隔离子进程实例；返回 { child, stop }。 */
export async function startIsolatedServer(dir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NOVELSTUDIO_DATA_DIR: dir, PORT: String(PORT), NOVELSTUDIO_OV_DISABLED: '1' },
    // ⚠️ 用 inherit 而不是 pipe：本机沙箱禁止管道 stdio（spawnSync/pipe → EPERM），
    //    子进程日志直接进本进程 stderr 即可（其中不含密钥）。
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const stop = () => { try { child.kill(); } catch (_) {} };
  // 等端口可用（最多 20s）。用真实的只读接口探活（无 /api/health 路由）。
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 20000) { stop(); throw new Error('隔离实例 20s 内未就绪（可能是端口占用或启动失败）'); }
    try {
      const r = await fetch(`${BASE}/api/ai/policy`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch (_) { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { child, stop };
}
