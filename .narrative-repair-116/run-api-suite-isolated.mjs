/**
 * N3：在隔离实例上跑 api-test-suite.mjs（修正版）。
 *
 * 上一版失败原因（已留痕）：`import('../api-test-suite.mjs')` 只是**启动**了它的 `main()`，
 * 而我紧接着 `process.exit()` → 套件被自己掐断（只输出了 "== A. 静态服务与路径安全 =="）。
 * 修正：用 `spawnSync(..., {stdio:['ignore','inherit','inherit']})` —— **inherit 在本沙箱可用**（pipe 不可用），
 * 因此子进程能自然跑完，父进程同步等它结束并拿到真实退出码。
 */
import { makeIsolatedDataDir, startIsolatedServer } from './paid-eval-harness.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const cfg = makeIsolatedDataDir();
console.log(JSON.stringify({ setup: 'ok', temp_dir: cfg.dir, config_id: cfg.configId, key_sha8: cfg.keySha8 }, null, 2));

process.env.NOVELSTUDIO_DATA_DIR = cfg.dir;
const { stop } = await startIsolatedServer(cfg.dir);

const t0 = Date.now();
// inherit：子进程输出直接进当前控制台（沙箱允许）；不用 pipe（会 EPERM）
const r = spawnSync(process.execPath, ['api-test-suite.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, NOVELSTUDIO_DATA_DIR: cfg.dir },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const ms = Date.now() - t0;
stop();
console.log(JSON.stringify({
  done: true,
  exit_code: r.status,
  spawn_error: (r.error && r.error.code) || null,
  ms,
}, null, 2));
try { fs.rmSync(cfg.dir, { recursive: true, force: true }); console.log('temp dir removed'); } catch (_) {}
process.exit(Number(r.status) || 0);
