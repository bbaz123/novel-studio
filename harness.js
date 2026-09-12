// DeepSeek Harness 桥接层
// 通过 dsh headless profile 执行一次性 AI 创作任务，并支持临时切换默认模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, readableErrorMessage } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// OpenViking 共享记忆库归属：headless 写作任务的 cwd 是 dsh 仓库，插件默认会按
// cwd 派生 workspace peer，导致小说任务记忆落在 deepseek-harness 的 peer 里。
// 这里把 peer 固定为工坊仓库派生的 peer（与 GUI 会话在同一 workspace 时一致），
// 让写作任务的记忆采集/召回与 GUI 会话共用同一记忆库。可用环境变量覆盖。
export const OPENVIKING_PEER_ID =
  process.env.OPENVIKING_PEER_ID ||
  process.env.NOVELSTUDIO_OPENVIKING_PEER_ID ||
  String(__dirname).replace(/[^A-Za-z0-9]/g, '-');

// dsh 仓库路径解析。注意 DSH_HOME 的官方语义是 harness home 根目录
// （settings.yaml、profiles、credentials 都在其下），并不是 dsh 源码仓库路径；
// 本应用需要的是仓库路径，因此优先使用专属变量 NOVELSTUDIO_DSH_REPO；
// DSH_HOME 只有在确实包含 package.json（即恰好指向仓库）时才采用；
// 其次探测工坊仓库同级的 deepseek-harness 目录（移动仓库后无需改配置）。
function resolveHarnessDir() {
  const sibling = path.join(__dirname, '..', 'deepseek-harness');
  // 仅保留环境变量与同级目录探测，不硬编码本机绝对路径（避免用户名/路径泄露进源码）。
  const candidates = [
    process.env.NOVELSTUDIO_DSH_REPO,
    process.env.DSH_HOME,
    sibling
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  // 都不存在时保留第一个候选，便于报错信息指出实际检查的路径。
  return candidates[0] || sibling;
}
export const HARNESS_DIR = resolveHarnessDir();
export const HARNESS_PACKAGE = path.join(HARNESS_DIR, 'package.json');

// dsh 全局设置文件，用于临时切换默认模型
export const DSH_SETTINGS = process.env.DSH_SETTINGS || path.join(os.homedir(), '.dsh', 'settings.yaml');

// 模型补丁侧车备份：进程崩溃时 finally 的 CAS 还原不会执行，settings.yaml 可能停留在补丁状态；
// 启动时检测到残留补丁则还原原文，避免用户默认模型被静默篡改。
const PATCH_BACKUP = path.join(os.tmpdir(), 'novel-studio-harness-settings-backup.json');
function readPatchBackup() {
  try { return JSON.parse(fs.readFileSync(PATCH_BACKUP, 'utf8')); } catch (_) { return null; }
}
function writePatchBackup(obj) {
  try { fs.writeFileSync(PATCH_BACKUP, JSON.stringify(obj)); } catch (_) { /* 忽略 */ }
}
function clearPatchBackup() {
  try { fs.unlinkSync(PATCH_BACKUP); } catch (_) { /* 忽略 */ }
}
function restoreHarnessSettingsIfNeeded() {
  const backup = readPatchBackup();
  if (!backup || !backup.patched || !backup.original) return;
  try {
    if (fs.readFileSync(DSH_SETTINGS, 'utf8') === backup.patched) {
      fs.writeFileSync(DSH_SETTINGS, backup.original);
      clearPatchBackup();
      log({ level: 'warn', layer: 'harness', kind: 'settings_restore_failed', message: '检测到崩溃残留的模型补丁，已还原 settings.yaml' });
    }
  } catch (_) { /* 还原失败不影响启动 */ }
}
restoreHarnessSettingsIfNeeded();

export function isHarnessAvailable() {
  return fs.existsSync(HARNESS_PACKAGE);
}

// 判断 dsh 是否已经构建出运行所需的 lib 产物。
export function isHarnessBuilt() {
  const markers = [
    path.join(HARNESS_DIR, 'packages/interaction/commands/lib/typert.host.js'),
    path.join(HARNESS_DIR, 'packages/goal/goal/lib/typert.host.js')
  ];
  return markers.every((file) => fs.existsSync(file));
}

// N-01：dsh 任务启动方式解析。优先按 dsh 仓库 package.json 的 scripts.dsh 定义
// 直接以 node spawn 启动（绕过 pnpm），因为 pnpm 在 Windows 上运行脚本会经 cmd.exe，
// 把中文 prompt 按 ANSI 代码页损坏成「?」（已实测复现：AI 收到满屏问号并拒绝写作）。
// 纯 node spawn 传中文参数实测完好。解析失败时回退到旧的 pnpm 方式。
function resolveDshLaunch() {
  try {
    const pkg = JSON.parse(fs.readFileSync(HARNESS_PACKAGE, 'utf8'));
    const script = String((pkg.scripts && pkg.scripts.dsh) || '').trim();
    // 形如："node --import tsx/esm apps/cli/src/bin.ts"
    const m = script.match(/^node\s+([\s\S]+)$/);
    if (m) {
      const parts = m[1].trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return null;
      // 最后一个参数是入口脚本，相对路径按仓库根解析；其余（--import tsx/esm 等）原样传递。
      const entry = parts[parts.length - 1];
      const resolved = entry.startsWith('.') || !entry.includes(':') ? path.join(HARNESS_DIR, entry) : entry;
      return { args: [...parts.slice(0, -1), resolved], cwd: HARNESS_DIR };
    }
  } catch { /* 读取/解析失败走 pnpm 兜底 */ }
  return null;
}

// 找到 pnpm 的 corepack JS 入口，避免使用 shell: true 启动子进程。
function findPnpmJs() {
  const candidates = [];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm'] : ['pnpm'];
  for (const dir of pathDirs) {
    for (const name of names) {
      const bin = path.join(dir, name);
      if (!fs.existsSync(bin)) continue;
      const js = path.join(path.dirname(bin), 'node_modules', 'corepack', 'dist', 'pnpm.js');
      if (fs.existsSync(js)) candidates.push(js);
    }
  }
  return candidates[0] || null;
}

// 用 node + corepack pnpm.js 执行 pnpm 命令，避免 shell 转义问题。
function runPnpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const pnpmJs = findPnpmJs();
    if (!pnpmJs) {
      reject(new Error('未找到 pnpm 的 corepack 入口'));
      return;
    }
    const timeoutMs = options.timeout || 20 * 60 * 1000;
    const child = spawn(process.execPath, [pnpmJs, ...args], {
      cwd: options.cwd || HARNESS_DIR,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChildTree(child);
      reject(new Error(`pnpm 命令超时：${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `pnpm 退出码：${code}`));
      }
    });
  });
}

// 自动构建 deepseek-harness，解决 lib 产物缺失导致的插件加载失败。
// 进程内互斥：并发请求只会触发一次构建；构建后复查产物标记，失败即抛明确错误。
let buildPromise = null;
export async function buildHarness() {
  if (isHarnessBuilt()) return true;
  if (!buildPromise) {
    buildPromise = (async () => {
      await runPnpm(['run', 'build'], { timeout: 20 * 60 * 1000 });
      if (!isHarnessBuilt()) throw new Error('dsh 构建完成但产物标记仍缺失，请检查 pnpm run build 输出');
    })()
      .catch((e) => {
        log({ level: 'error', layer: 'harness', kind: 'build_failed', message: `dsh 自动构建失败：${e.message}`, error: e });
        throw e;
      })
      .finally(() => { buildPromise = null; });
  }
  await buildPromise;
  return isHarnessBuilt();
}

function readSettings() {
  try {
    return fs.readFileSync(DSH_SETTINGS, 'utf8');
  } catch (_) {
    return null;
  }
}

function writeSettings(content) {
  // 原子写：先写临时文件再 rename，避免中断损坏用户的 ~/.dsh/settings.yaml。
  const tmp = `${DSH_SETTINGS}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, DSH_SETTINGS);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

// 在 settings.yaml 中把 agent-default-model.model 替换为目标模型。
function patchDefaultModel(yaml, model) {
  const lines = yaml.split('\n');
  let inAgentDefault = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^agent-default-model:\s*$/.test(line)) {
      inAgentDefault = true;
      continue;
    }
    if (inAgentDefault) {
      if (/^\S/.test(line)) {
        inAgentDefault = false;
      } else if (/^\s*model:/.test(line)) {
        lines[i] = line.replace(/:\s*.*$/, `: ${model}`);
        break;
      }
    }
  }
  return lines.join('\n');
}

// 强杀进程树：Windows 下用 taskkill /T 确保 pnpm → dsh 子进程一并结束（D7 取消任务）。
function killChildTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (_) { /* taskkill 失败时退回 child.kill */ }
  }
  try { child.kill(); } catch (_) { /* 进程可能已退出 */ }
}

/**
 * 运行一次 dsh headless 任务（带进度回调版本）。
 *
 * 模型切换说明：dsh 的默认模型存在全局 settings.yaml 里，本函数过去直接改写该文件，
 * 并发任务会互相覆盖（竞态），并可能覆盖用户手改的配置。现在改为：
 *   1) 进程内互斥串行化「改 → 跑 → 还原」三段，避免并发任务交错；
 *   2) CAS 还原：只有文件仍等于我们写入的内容时才恢复原文，不覆盖期间发生的其它修改。
 *
 * @param {string} prompt 给 AI 的任务描述
 * @param {{ timeout?: number, model?: string, env?: Record<string,string>, signal?: AbortSignal }} [options]
 * @param {(chunk: string) => void} [onChunk] 每次收到子进程输出时回调（用于前台进度展示）
 * @returns {Promise<string>} 任务输出
 */
let modelSwitchTail = Promise.resolve();
function withModelSwitch(fn) {
  const run = modelSwitchTail.then(fn, fn);
  modelSwitchTail = run.then(() => {}, () => {});
  return run;
}

export async function runHarnessTaskWithProgress(prompt, options = {}, onChunk) {
  if (!isHarnessAvailable()) {
    throw new Error(`未找到 deepseek-harness：${HARNESS_DIR}`);
  }

  // 如果 dsh 缺少构建产物，先自动构建，避免 typert.host.js 等文件缺失。
  if (!isHarnessBuilt()) {
    await buildHarness();
  }

  const signal = options.signal;
  const makeCancelled = () => {
    const err = new Error('Harness 任务已取消');
    err.code = 'HARNESS_CANCELLED';
    return err;
  };
  if (signal?.aborted) throw makeCancelled();

  const runTask = async () => {
    // 模型名合法性校验：防止特殊字符破坏 settings.yaml 结构（HA-07）。
    if (options.model && !/^[A-Za-z0-9._-]{1,64}$/.test(String(options.model))) {
      throw new Error('非法模型名：仅允许字母/数字/点/下划线/连字符');
    }
    const originalSettings = readSettings();
    let patched = false;
    let patchedContent = null;
    if (options.model && originalSettings == null) {
      log({ level: 'warn', layer: 'harness', kind: 'settings_patch_skipped', message: '无法读取 settings.yaml，模型切换被跳过（将以默认模型运行）' });
    }
    if (options.model && originalSettings != null) {
      try {
        patchedContent = patchDefaultModel(originalSettings, options.model);
        if (patchedContent !== originalSettings) {
          writeSettings(patchedContent);
          writePatchBackup({ original: originalSettings, patched: patchedContent });
          patched = true;
        }
      } catch (e) {
        log({ level: 'warn', layer: 'harness', kind: 'settings_patch_failed', message: `默认模型切换失败：${e.message}` });
      }
    }

    const timeoutMs = options.timeout || 10 * 60 * 1000;
    const startedAt = Date.now();
    log({
      level: 'info', layer: 'harness', kind: 'task_start',
      message: 'Harness 任务开始',
      context: { timeout_ms: timeoutMs, model: options.model || '' }
    });

    try {
      return await new Promise((resolve, reject) => {
        const launch = resolveDshLaunch();
        const pnpmJs = launch ? null : findPnpmJs();
        if (!launch && !pnpmJs) {
          reject(new Error('未找到 dsh 启动方式（无 scripts.dsh 且未找到 pnpm 的 corepack 入口），无法运行 dsh 任务'));
          return;
        }
        const taskArgs = ['--profile', 'headless', String(prompt || '').trim()];
        const spawnArgs = launch ? [...launch.args, ...taskArgs] : [pnpmJs, 'dsh', ...taskArgs];
        const spawnCwd = launch ? launch.cwd : HARNESS_DIR;
        const childEnv = {
          ...process.env,
          OPENVIKING_PEER_ID: OPENVIKING_PEER_ID,
          ...(options.env || {})
        };
        // 仅无 shell 启动：避免 shell:true 把 prompt 拼进 cmd 命令行的注入面（HA-06）；
        // 同时避免 pnpm→cmd.exe 链路把中文参数按 ANSI 损坏（N-01）。
        const child = spawn(process.execPath, spawnArgs, {
          cwd: spawnCwd,
          shell: false,
          windowsHide: true,
          env: childEnv
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupSignal();
          killChildTree(child);
          const err = new Error(`Harness 任务超时（${Math.round(timeoutMs / 1000)} 秒）后被取消，已生成的中间内容未能落盘。建议将本章拆成两段分别生成（先生成前半、再续写后半），或使用「跳过提问」后重试。`);
          err.code = 'HARNESS_TIMEOUT';
          err.stdoutTail = stdout.slice(-600);
          err.stderr = stderr;
          log({
            level: 'error', layer: 'harness', kind: 'timeout',
            message: `Harness 任务超时（${Math.round(timeoutMs / 1000)}s），子进程已终止`,
            context: { timeout_ms: timeoutMs, model: options.model || '' },
            dedupMs: 60 * 1000
          });
          reject(err);
        }, timeoutMs);

        // D7：外部取消 → 杀掉进程树并以 HARNESS_CANCELLED 结束任务
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          killChildTree(child);
          log({
            level: 'info', layer: 'harness', kind: 'cancelled',
            message: 'Harness 任务被取消，子进程树已终止'
          });
          reject(makeCancelled());
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const cleanupSignal = () => signal?.removeEventListener('abort', onAbort);

        child.stdout.on('data', (chunk) => {
          stdout = (stdout + chunk).slice(-65536); // 环形缓冲：只保留尾部 64KB，防长任务内存无限累积
          if (typeof onChunk === 'function') {
            try { onChunk(String(chunk)); } catch (_) { /* 进度回调失败不影响任务 */ }
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + chunk).slice(-65536);
          if (typeof onChunk === 'function') {
            try { onChunk(String(chunk)); } catch (_) { /* 同上 */ }
          }
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanupSignal();
          log({
            level: 'error', layer: 'harness', kind: 'spawn_failed',
            message: `dsh 子进程启动失败：${err.message}`,
            error: err
          });
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanupSignal();
          if (code === 0) {
            log({
              level: 'info', layer: 'harness', kind: 'task_done',
              message: 'Harness 任务完成',
              context: { duration_ms: Date.now() - startedAt, model: options.model || '' }
            });
            resolve(stdout.trim());
          } else {
            const err = new Error(readableErrorMessage(stderr, `Harness 退出码：${code}`));
            err.code = 'HARNESS_EXIT';
            err.stderr = stderr;
            log({
              level: 'error', layer: 'harness', kind: 'harness_exit',
              message: `Harness 任务失败（退出码 ${code}）：${err.message}`,
              error: err,
              context: { exit_code: code, duration_ms: Date.now() - startedAt, model: options.model || '' }
            });
            reject(err);
          }
        });
      });
    } finally {
      // CAS 还原：文件仍等于我们写入的内容时才恢复，避免覆盖并发/手改内容。
      if (patched && patchedContent != null) {
        try {
          if (readSettings() === patchedContent) {
            writeSettings(originalSettings);
          }
        } catch (e) {
          log({ level: 'warn', layer: 'harness', kind: 'settings_restore_failed', message: `默认模型设置还原失败：${e.message}`, error: e });
        } finally {
          clearPatchBackup();
        }
      }
    }
  };
  // 仅模型切换需串行化（改 settings.yaml 是全局副作用）；不切模型的任务并行执行（HA-04）。
  return options.model ? withModelSwitch(runTask) : runTask();
}

/**
 * 运行一次 dsh headless 任务。
 * @param {string} prompt 给 AI 的任务描述
 * @param {{ timeout?: number, model?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<string>} 任务输出
 */
export async function runHarnessTask(prompt, options = {}) {
  return runHarnessTaskWithProgress(prompt, options);
}
