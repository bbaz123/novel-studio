// DeepSeek Harness 桥接层
// 通过 dsh headless profile 执行一次性 AI 创作任务，并支持临时切换默认模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dsh 仓库路径解析。注意 DSH_HOME 的官方语义是 harness home 根目录
// （settings.yaml、profiles、credentials 都在其下），并不是 dsh 源码仓库路径；
// 本应用需要的是仓库路径，因此优先使用专属变量 NOVELSTUDIO_DSH_REPO；
// DSH_HOME 只有在确实包含 package.json（即恰好指向仓库）时才采用；
// 其次探测工坊仓库同级的 deepseek-harness 目录（移动仓库后无需改配置）。
function resolveHarnessDir() {
  const sibling = path.join(__dirname, '..', 'deepseek-harness');
  const candidates = [
    process.env.NOVELSTUDIO_DSH_REPO,
    process.env.DSH_HOME,
    sibling,
    'C:\\Users\\a1941\\Desktop\\DeepSeek\\deepseek-harness',
    'C:\\Users\\a1941\\Desktop\\deepseek-harness'
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
      child.kill();
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
export async function buildHarness() {
  if (isHarnessBuilt()) return true;
  await runPnpm(['run', 'build'], { timeout: 20 * 60 * 1000 });
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
  fs.writeFileSync(DSH_SETTINGS, content);
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

// 把一段 stderr/堆栈整理成「一行可读错误」：取第一行非空文本，截断到合理长度。
// 完整内容由调用方（如 logAIError）单独记录，避免把整段堆栈塞进 toast/列表。
function readableError(raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback || '未知错误';
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^\s*at\s+/.test(l)) || text.split(/\r?\n/)[0].trim();
  const short = firstLine.length > 400 ? firstLine.slice(0, 400) + '…' : firstLine;
  return short || fallback || '未知错误';
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

  return withModelSwitch(async () => {
    const originalSettings = readSettings();
    let patched = false;
    let patchedContent = null;
    if (options.model && originalSettings != null) {
      try {
        patchedContent = patchDefaultModel(originalSettings, options.model);
        if (patchedContent !== originalSettings) {
          writeSettings(patchedContent);
          patched = true;
        }
      } catch (_) { /* 设置切换失败不阻塞任务 */ }
    }

    const timeoutMs = options.timeout || 10 * 60 * 1000;

    try {
      return await new Promise((resolve, reject) => {
        const pnpmJs = findPnpmJs();
        const taskArgs = ['dsh', '--profile', 'headless', String(prompt || '').trim()];
        const childEnv = { ...process.env, ...(options.env || {}) };
        const child = pnpmJs
          ? spawn(process.execPath, [pnpmJs, ...taskArgs], {
              cwd: HARNESS_DIR,
              shell: false,
              windowsHide: true,
              env: childEnv
            })
          : spawn('pnpm', taskArgs, {
              cwd: HARNESS_DIR,
              shell: true,
              windowsHide: true,
              env: childEnv
            });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill();
          const err = new Error(`Harness 任务超时（${Math.round(timeoutMs / 1000)} 秒）后被取消，已生成的中间内容未能落盘。建议将本章拆成两段分别生成（先生成前半、再续写后半），或使用「跳过提问」后重试。`);
          err.code = 'HARNESS_TIMEOUT';
          err.stdoutTail = stdout.slice(-600);
          err.stderr = stderr;
          reject(err);
        }, timeoutMs);

        // D7：外部取消 → 杀掉进程树并以 HARNESS_CANCELLED 结束任务
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          killChildTree(child);
          reject(makeCancelled());
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        const cleanupSignal = () => signal?.removeEventListener('abort', onAbort);

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (typeof onChunk === 'function') {
            try { onChunk(String(chunk)); } catch (_) { /* 进度回调失败不影响任务 */ }
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
          if (typeof onChunk === 'function') {
            try { onChunk(String(chunk)); } catch (_) { /* 同上 */ }
          }
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanupSignal();
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanupSignal();
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            const err = new Error(readableError(stderr, `Harness 退出码：${code}`));
            err.code = 'HARNESS_EXIT';
            err.stderr = stderr;
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
        } catch (_) { /* 恢复失败不阻塞 */ }
      }
    }
  });
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
