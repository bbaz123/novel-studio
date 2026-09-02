// DeepSeek Harness 桥接层
// 通过 dsh headless profile 执行一次性 AI 创作任务，并支持临时切换默认模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dsh 仓库路径，可通过环境变量 DSH_HOME 覆盖
export const HARNESS_DIR = process.env.DSH_HOME || 'C:\\Users\\a1941\\Desktop\\deepseek-harness';
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

/**
 * 运行一次 dsh headless 任务。
 * @param {string} prompt 给 AI 的任务描述
 * @param {{ timeout?: number, model?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<string>} 任务输出
 */
export async function runHarnessTask(prompt, options = {}) {
  if (!isHarnessAvailable()) {
    throw new Error(`未找到 deepseek-harness：${HARNESS_DIR}`);
  }

  // 如果 dsh 缺少构建产物，先自动构建，避免 typert.host.js 等文件缺失。
  if (!isHarnessBuilt()) {
    await buildHarness();
  }

  const originalSettings = readSettings();
  let patched = false;
  if (options.model && originalSettings != null) {
    try {
      writeSettings(patchDefaultModel(originalSettings, options.model));
      patched = true;
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
        reject(new Error(`Harness 任务超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
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
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `Harness 退出码：${code}`));
        }
      });
    });
  } finally {
    if (patched && originalSettings != null) {
      try {
        writeSettings(originalSettings);
      } catch (_) { /* 恢复失败不阻塞 */ }
    }
  }
}
