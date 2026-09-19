// DeepSeek Harness 桥接层
// 通过 dsh profile 执行一次性 AI 创作任务，并支持临时切换默认模型。
// profile 名由 DSH_PROFILE 决定（环境变量 NOVELSTUDIO_DSH_PROFILE，默认 novel）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, readableErrorMessage } from './logger.js';
import { traceHarness, traceNow } from './debug-trace.js';
import { EFFORTS, LONG_AI_TIMEOUT_MS } from './ai/policy.mjs';
import { harnessChildEnv, resolveTaskDshHome, taskHomeInfo } from './ai/harness-env.mjs';
import { buildSettingsRedirectPatch, buildTaskArgs, TASK_SETTINGS_PREFIX } from './ai/task-settings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 🐞 运行追踪：慢通道节点（任务级）。未录制时 traceHarness 内部是空操作，零开销。
function recordHarnessTrace(name, data) {
  try {
    traceHarness(name, data);
  } catch (_) { /* 追踪失败绝不影响创作任务 */ }
}

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
//
// ⚠️ 为什么解析结果**每次现算**而不是启动时定死：作者可以在 AI 设置页里改这个路径，
// 改完的下一个任务就该用新路径。启动时快照会让「填了路径、下一个任务仍报未找到」
// 变成一种最难查的坑（与 D4 同族：数据要一路查到真正消费它的那一行，写进变量不算完）。
// 因此这里只导出**函数**，不导出目录常量。
let harnessRepoOverride = '';

/** 由 server.js 从 app_settings 注入（AI 设置页保存时再次调用）；空串=未设置。 */
export function setHarnessRepoOverride(dir) {
  harnessRepoOverride = String(dir || '').trim();
  return harnessRepoOverride;
}

/** 候选位置（含来源标签），供自检接口如实展示"到底看过哪几个地方"。 */
function harnessDirCandidates() {
  const sibling = path.join(__dirname, '..', 'deepseek-harness');
  // 仅保留环境变量、工坊内设置与同级目录探测，不硬编码本机绝对路径（避免用户名/路径泄露进源码）。
  return [
    { source: 'env', label: 'NOVELSTUDIO_DSH_REPO 环境变量', dir: String(process.env.NOVELSTUDIO_DSH_REPO || '').trim() },
    { source: 'workshop', label: '工坊内设置（AI 设置页）', dir: harnessRepoOverride },
    { source: 'dsh_home', label: 'DSH_HOME 环境变量', dir: String(process.env.DSH_HOME || '').trim() },
    { source: 'sibling', label: '工坊仓库同级的 deepseek-harness', dir: sibling }
  ].filter((c) => c.dir);
}

/** 解析结果：dir + 命中的来源 + 每个候选的命中情况（都不命中时保留首个候选，供报错指出实际检查的路径）。 */
function resolveHarnessDirInfo() {
  const checked = harnessDirCandidates().map((c) => ({
    ...c,
    ok: fs.existsSync(path.join(c.dir, 'package.json'))
  }));
  const hit = checked.find((c) => c.ok);
  return {
    dir: hit ? hit.dir : (checked[0]?.dir || path.join(__dirname, '..', 'deepseek-harness')),
    source: hit ? hit.source : (checked.length ? `${checked[0].source}:missing` : 'default'),
    found: Boolean(hit),
    checked
  };
}

function harnessDir() {
  return resolveHarnessDirInfo().dir;
}

function harnessPackagePath() {
  return path.join(harnessDir(), 'package.json');
}

/**
 * 这个目录**像不像** dsh 仓库。
 *
 * 与上面的"能不能解析出路径"是两个问题：解析只要求 package.json（既有行为，保持兼容），
 * 而作者在界面上**手填**路径时，只校验 package.json 会放进一堆误填——例如填成工坊自己的
 * 目录（它也有 package.json），结果之后每个任务都失败在"未找到 dsh 启动方式"，
 * 而界面显示"已保存"。所以手填这一步用更严的判据：package.json + 三个 dsh 布局特征之一。
 *
 * 三个特征都取自 dsh 的实际布局（`scripts.dsh`、`apps/cli`、`packages/`），
 * 任取其一即可，避免只认一种而误伤不同版本的仓库。
 */
export function looksLikeDshRepo(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    if (fs.existsSync(path.join(dir, 'apps', 'cli'))) return true;
    if (fs.existsSync(path.join(dir, 'packages'))) return true;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg && pkg.scripts && String(pkg.scripts.dsh || '').trim());
  } catch {
    return false;
  }
}

// dsh 全局设置文件，用于临时切换默认模型。
// 决策 B：若写作任务被关进专用 DSH_HOME，设置文件**必须跟着走**——否则回退路径改的是
// GUI 的 settings.yaml，而子进程读的是新 home 的，**改了等于没改**（且会静默用默认模型）。
// 显式设了 DSH_SETTINGS 时仍然最高优先。
// 导出是为了让 `.p1-baseline/test-harness-env.mjs` 做**语义断言**（真调它看跟随哪一层），
// 而不是去 grep 源码形状——形状断言在"常量改函数"这种无害重构后会静默失效（2026-09-18 实际发生过）。
//
// ⚠️ DSH_SETTINGS 在**调用时**读，不在模块加载时快照：快照会让"改了环境变量却没生效"变得无法解释，
// 也与本次把其它常量改成"每次现算"的做法不一致（同一个函数里两种时序语义最容易埋坑）。
export function dshSettingsPath() {
  const explicit = String(process.env.DSH_SETTINGS || '').trim();
  if (explicit) return explicit;
  const home = resolveTaskDshHome();
  return home ? path.join(home, 'settings.yaml') : path.join(os.homedir(), '.dsh', 'settings.yaml');
}

// 决策 B：**首次真正跑任务时**如实打印写作任务的 home 决策。
// 为什么必须打印：实测 `DSH_HOME` 会随启动方式而变（从 DSH 派生的终端启动工坊时环境里已经带着它，
// 从桌面快捷方式启动时没有）。不把决策写出来，"B 生没生效"就只能靠猜——
// 而"看起来在隔离、其实没隔离"正是 2026-09-15 那次事故的形态。
// ⚠️ 为什么**不能放在模块顶层**：第一版就是模块顶层 `log(...)`——任何 import harness.js 的
// 工具/测试都会触发它：往 stdout 喷一行 `[logger:harness] …`，而且若进程注册了退出刷盘，
// 会把日志写进**当前数据目录**（工具跑在真实目录下时就是真实库）。模块导入必须是零副作用——
// 这是被实测抓出来的（用 NOVELSTUDIO_DATA_DIR 指向空目录 import 一次，立刻能看到输出）。
let taskHomeDecisionLogged = false;
function logTaskHomeDecisionOnce() {
  if (taskHomeDecisionLogged) return;
  taskHomeDecisionLogged = true;
  try {
    const info = taskHomeInfo();
    log({
      level: 'info', layer: 'harness', kind: 'task_home_decision',
      message: info.home
        ? `写作任务使用专用 DSH_HOME：${info.home}`
          + (info.overridesAmbient ? `（覆盖了环境里继承来的 ${info.ambient}）` : '')
        : `写作任务沿用共享 DSH_HOME（专用 home 不可用：${info.path}）`,
      context: { home: info.home || '', path: info.path, ambient: info.ambient, overrides_ambient: info.overridesAmbient },
    });
  } catch { /* 日志失败不影响启动 */ }
}

// dsh profile：novel-studio 的创作任务跑在哪个 profile 上。
//
// 背景（P0 专用运行时）：原先硬编码 'headless'，使工坊的创作运行时与 GUI 及其它
// dsh 用途共用同一份 profile——该 profile 由 install.ps1 做区块合并维护，且所有
// 会话共用全局 settings.yaml。为此新增了专用 profile `novel`（headless 的功能
// 等价体：83 行组合树逐条等价、17 条 disable 全部真实生效，证据见 .p0-recon/）。
//
// 【P6 已切换】默认值 = novel（2026-09-15 一次性切换，证据见 docs/p6-cutover-runbook.md）。
// 回滚：把下面两处 'novel' 改回 'headless'，或跑
//   node .p6-cutover/cutover.mjs --rollback data/backup-p6-<stamp>
// 临时试运行其它 profile：设 NOVELSTUDIO_DSH_PROFILE=<名字>（不影响默认值）。
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const DSH_PROFILE = (() => {
  const raw = String(process.env.NOVELSTUDIO_DSH_PROFILE || '').trim();
  if (!raw) return 'novel';
  if (!PROFILE_NAME_RE.test(raw)) {
    log({
      level: 'warn', layer: 'harness', kind: 'invalid_profile',
      message: 'NOVELSTUDIO_DSH_PROFILE 非法（仅允许字母/数字/点/下划线/连字符），已回退 novel',
      context: { value: raw }
    });
    return 'novel';
  }
  return raw;
})();

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
    const settingsFile = dshSettingsPath();
    if (fs.readFileSync(settingsFile, 'utf8') === backup.patched) {
      fs.writeFileSync(settingsFile, backup.original);
      clearPatchBackup();
      log({ level: 'warn', layer: 'harness', kind: 'settings_restore_failed', message: '检测到崩溃残留的模型补丁，已还原 settings.yaml' });
    }
  } catch (_) { /* 还原失败不影响启动 */ }
}
restoreHarnessSettingsIfNeeded();

export function isHarnessAvailable() {
  return fs.existsSync(harnessPackagePath());
}

// 判断 dsh 是否已经构建出运行所需的 lib 产物。
export function isHarnessBuilt() {
  const dir = harnessDir();
  const markers = [
    path.join(dir, 'packages/interaction/commands/lib/typert.host.js'),
    path.join(dir, 'packages/goal/goal/lib/typert.host.js')
  ];
  return markers.every((file) => fs.existsSync(file));
}

/**
 * 供 AI 设置页「本地创作内核」卡使用：把"实际用了哪条路径、为什么、构建产物在不在"
 * 一次性如实报出来。界面与日志读的是同一份结果——安装器与运行时各说各话，
 * 是 2026-09-18 那轮记下的坑（`install-profile.mjs` 写死 `~/.dsh` 却打印"接线完成"）。
 */
export function harnessRuntimeInfo() {
  const info = resolveHarnessDirInfo();
  return {
    dir: info.dir,
    source: info.source,
    found: info.found,
    // "找到了 package.json" ≠ "这确实是 dsh 仓库"：界面要能区分这两件事，
    // 否则作者会看到"已找到"却永远跑不起 AI 写作。
    looks_like_dsh: info.found ? looksLikeDshRepo(info.dir) : false,
    built: info.found ? isHarnessBuilt() : false,
    checked: info.checked,
    override: harnessRepoOverride,
    profile: DSH_PROFILE,
    settings_file: dshSettingsPath(),
    task_home: taskHomeInfo()
  };
}

/**
 * 源码入口 → 预构建产物的路径推导（纯函数，便于离线断言）。
 * dsh 仓库用 tsdown：`apps/cli/src/bin.ts` 的产物就是 `apps/cli/lib/bin.js`。
 * 推不出对应关系时返回 null（宁可不换，也不猜一个路径）。
 */
export function builtCounterpartOf(entryPath) {
  const m = String(entryPath || '').match(/^(.*)[\\/]src[\\/]([^\\/]+)\.tsx?$/);
  if (!m) return null;
  return path.join(m[1], 'lib', `${m[2]}.js`);
}

/**
 * 是否该用预构建产物启动：产物存在，且**不比源码旧**（防"改了源码没重建"）。
 * 纯函数（时间与存在性都由调用方给），便于离线断言真值表。
 *
 * @param {{builtExists:boolean, builtMtime:number, srcNewestMtime:number, forced?:string}} o
 * @returns {{use:boolean, why:string}}
 */
export function shouldUseBuiltEntry({ builtExists, builtMtime, srcNewestMtime, forced = '' }) {
  if (forced === 'source') return { use: false, why: 'NOVELSTUDIO_DSH_LAUNCH=source 强制走源码' };
  if (forced === 'built' && builtExists) return { use: true, why: 'NOVELSTUDIO_DSH_LAUNCH=built 强制走产物' };
  if (!builtExists) return { use: false, why: '预构建产物不存在' };
  if (!Number.isFinite(builtMtime) || !Number.isFinite(srcNewestMtime)) return { use: false, why: '无法比较源码与产物的时间戳' };
  if (srcNewestMtime > builtMtime) return { use: false, why: '源码比产物新（改了没重建），回退源码路径' };
  return { use: true, why: '产物存在且不比源码旧' };
}

/** 递归取一棵目录树里最新的 mtime（取不到时返回 NaN，由判据拒绝）。 */
function newestMtimeUnder(dir, limit = 20000) {
  let newest = NaN;
  let seen = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (seen >= limit) return;
      if (it.name === 'node_modules' || it.name === '.git') continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) { walk(p); continue; }
      seen += 1;
      try {
        const mt = fs.statSync(p).mtimeMs;
        if (!Number.isFinite(newest) || mt > newest) newest = mt;
      } catch { /* 单个文件取不到不影响整体判断 */ }
    }
  };
  walk(dir);
  return newest;
}

// N-01：dsh 任务启动方式解析。优先按 dsh 仓库 package.json 的 scripts.dsh 定义
// 直接以 node spawn 启动（绕过 pnpm），因为 pnpm 在 Windows 上运行脚本会经 cmd.exe，
// 把中文 prompt 按 ANSI 代码页损坏成「?」（已实测复现：AI 收到满屏问号并拒绝写作）。
// 纯 node spawn 传中文参数实测完好。解析失败时回退到旧的 pnpm 方式。
//
// ⚠️ 2026-09-18 实测（零计费，假 LLM 端点）：scripts.dsh 的 `node --import tsx/esm apps/cli/src/bin.ts`
// 会让**每个任务现场转译一遍 TypeScript** —— 冷启动 12.6 秒；而同一仓库里已构建的
// `apps/cli/lib/bin.js` 冷启动只要 1.9 秒。两条路径用同一 profile 组合出的配置
// **逐字相同**（`--dump-config` 各 398 行、0 差异），所以这是纯开销，不是取舍。
// 因此：**能用产物就用产物**，源码路径保留为回退（产物不存在 / 源码更新了没重建 / 显式强制）。
function resolveDshLaunch() {
  try {
    const pkg = JSON.parse(fs.readFileSync(harnessPackagePath(), 'utf8'));
    const script = String((pkg.scripts && pkg.scripts.dsh) || '').trim();
    // 形如："node --import tsx/esm apps/cli/src/bin.ts"
    const m = script.match(/^node\s+([\s\S]+)$/);
    if (m) {
      const parts = m[1].trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return null;
      // 最后一个参数是入口脚本，相对路径按仓库根解析；其余（--import tsx/esm 等）原样传递。
      const entry = parts[parts.length - 1];
      const dir = harnessDir();
      const resolved = entry.startsWith('.') || !entry.includes(':') ? path.join(dir, entry) : entry;
      const sourceLaunch = { args: [...parts.slice(0, -1), resolved], cwd: dir };

      // 预构建产物：入口换成 lib 下同名 .js，并**去掉 tsx 加载器**（产物是 JS，不再需要现译）。
      const builtEntry = builtCounterpartOf(resolved);
      if (builtEntry) {
        let builtExists = false;
        let builtMtime = NaN;
        try { builtMtime = fs.statSync(builtEntry).mtimeMs; builtExists = true; } catch { /* 不存在 */ }
        const verdict = shouldUseBuiltEntry({
          builtExists,
          builtMtime,
          srcNewestMtime: builtExists ? newestMtimeUnder(path.dirname(resolved)) : NaN,
          forced: String(process.env.NOVELSTUDIO_DSH_LAUNCH || '').trim().toLowerCase(),
        });
        if (verdict.use) {
          // 去掉成对的 `--import <loader>`（只去掉紧邻的取值，不误伤其它选项）。
          const rest = [];
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (parts[i] === '--import' && i + 1 < parts.length - 1) { i += 1; continue; }
            rest.push(parts[i]);
          }
          logBuiltLaunchOnce(true, `预构建产物启动（省掉每任务现场转译，实测冷启动 12.6s → 1.9s）：${builtEntry}`);
          return { args: [...rest, builtEntry], cwd: dir };
        }
        logBuiltLaunchOnce(false, `走源码路径：${verdict.why}`);
      }
      return sourceLaunch;
    }
  } catch { /* 读取/解析失败走 pnpm 兜底 */ }
  return null;
}

// 只打印一次：这个决策每次任务都会算，但真跑起来每次刷屏会淹掉别的日志。
let builtLaunchLogged = '';
function logBuiltLaunchOnce(usedBuilt, detail) {
  const key = `${usedBuilt}|${detail}`;
  if (builtLaunchLogged === key) return;
  builtLaunchLogged = key;
  log({ level: 'info', layer: 'harness', kind: 'dsh_launch', message: detail });
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
      cwd: options.cwd || harnessDir(),
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
// 仅本文件使用（runHarnessTaskWithProgress 里调用）；2026-09-18 去掉 export：
// 仓库内除本文件外 0 引用，留着的导出会让人以为它是对外接口。
async function buildHarness() {
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
    return fs.readFileSync(dshSettingsPath(), 'utf8');
  } catch (_) {
    return null;
  }
}

function writeSettings(content) {
  // 原子写：先写临时文件再 rename，避免中断损坏用户的 ~/.dsh/settings.yaml。
  const settingsFile = dshSettingsPath();
  const tmp = `${settingsFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, settingsFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

// 思考强度取值白名单。**唯一来源是 ai/policy.mjs**（P4 起）——此前这里另有一份硬编码副本，
// 与 server.js 的白名单各改各的。传其它值 dsh 会在网络 I/O 前以
// UNSUPPORTED_REASONING_EFFORT 失败，因此在进入互斥前就拦下并给出明确报错。
export const REASONING_EFFORTS = EFFORTS;

// 归一化思考强度：空值表示“不指定”（沿用 settings.yaml 现值），非法值返回空串由调用方报错。
export function normalizeReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return '';
  const v = String(value).trim().toLowerCase();
  return REASONING_EFFORTS.includes(v) ? v : '';
}

/**
 * 在 settings.yaml 的 agent-default-model 分节内改写 model / reasoningEffort。
 * 只在该分节内增改，分节不存在时原样返回（由调用方决定如何告警），
 * 以免误伤用户在同一文件里的其它配置。
 * 导出以便单测直接覆盖（纯函数，无副作用）。
 */
function patchAgentDefault(yaml, { model, reasoningEffort } = {}) {
  const lines = yaml.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0) {
      if (/^agent-default-model:\s*$/.test(lines[i])) start = i;
      continue;
    }
    // 遇到下一个顶层键（行首非空白）即分节结束。
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return yaml;

  let indent = '';
  let modelIdx = -1;
  let effortIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^([ \t]+)\S/);
    if (!indent && m) indent = m[1];
    if (/^\s*model:/.test(lines[i])) modelIdx = i;
    else if (/^\s*reasoningEffort:/.test(lines[i])) effortIdx = i;
  }
  // 探测不到子键缩进时（分节内一个键都没有）沿用 dsh 写 settings.yaml 的 2 空格风格。
  if (!indent) indent = '  ';

  if (model && modelIdx >= 0) {
    lines[modelIdx] = lines[modelIdx].replace(/^(\s*model:).*$/, `$1 ${model}`);
  }
  if (reasoningEffort) {
    if (effortIdx >= 0) {
      lines[effortIdx] = lines[effortIdx].replace(/^(\s*reasoningEffort:).*$/, `$1 ${reasoningEffort}`);
    } else {
      // 分节内缺该键时补一行，缩进沿用同级键，保证 YAML 结构合法。
      lines.splice(modelIdx >= 0 ? modelIdx + 1 : start + 1, 0, `${indent}reasoningEffort: ${reasoningEffort}`);
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
 * @param {{ timeout?: number, model?: string, reasoningEffort?: string, env?: Record<string,string>, signal?: AbortSignal }} [options]
 * @param {(chunk: string) => void} [onChunk] 每次收到子进程输出时回调（用于前台进度展示）
 * @returns {Promise<string>} 任务输出
 */
let modelSwitchTail = Promise.resolve();
/** 可观测性（决策 D4）：模型切换互斥的当前负载，供作业设施显示「等待模型槽位」。 */
let modelSwitchBusy = false;
let modelSwitchWaiters = 0;

/** 模型切换互斥的负载快照。`busy`=有任务正持有槽位；`waiters`=还在排队的数量。 */
export function modelSwitchLoad() {
  return { busy: modelSwitchBusy, waiters: modelSwitchWaiters };
}

/**
 * 模型切换互斥：把「改 settings.yaml → 跑任务 → 还原」三段串起来，避免并发任务交错。
 *
 * ⚠️ 这个互斥体决定了**实际吞吐**：只有当调用方请求了模型/思考强度（见
 * `requiresModelSwitchGate`）才会走它；都请求了，服务端的 `HARNESS_CONCURRENCY=2`
 * 在实践中就退化成 1（第二个作业会先在队列里等）。
 * 导出它是为了能**离线单测**这条语义（见 .p1-baseline/test-model-switch-gate.mjs），
 * 而不是靠读代码下结论。
 *
 * 决策 D4（2026-09-16）：排队必须**可观测**——否则界面会把"在等槽位"显示成"运行中"，
 * 作者会以为任务卡住了。这里维护 busy/waiters 计数，配合 `options.onPhase` 上报。
 */
export function withModelSwitch(fn) {
  const queued = modelSwitchBusy || modelSwitchWaiters > 0;
  if (queued) modelSwitchWaiters++;
  const wrapped = async () => {
    if (queued) modelSwitchWaiters = Math.max(0, modelSwitchWaiters - 1);
    modelSwitchBusy = true;
    try { return await fn(); } finally { modelSwitchBusy = false; }
  };
  const run = modelSwitchTail.then(wrapped, wrapped);
  modelSwitchTail = run.then(() => {}, () => {});
  return run;
}

/**
 * 这次调用是否需要改写 settings.yaml（= 是否需要进入模型切换互斥）。
 *
 * 抽成纯函数是为了可离线单测：它决定了实际吞吐是 1 还是 2。
 * 语义必须与调用点严格一致——判定用的是**归一化之后**的强度。
 */
export function requiresModelSwitchGate(model, reasoningEffort) {
  return Boolean(model || reasoningEffort);
}

/**
 * 这次调用**是否会先排队**等模型槽位。
 *
 * 抽成纯函数是为了可离线单测（决策 D4 的可观测性依赖这条判断）：
 * 只有"需要改写 settings"的任务才进互斥，而互斥忙/有人排队时它才会等。
 * 不请求模型/强度的任务**不排队**——这一点必须能被断言，否则界面会对并行任务误报"等待中"。
 */
export function willWaitForModelSlot(takesSlot) {
  return Boolean(takesSlot) && (modelSwitchBusy || modelSwitchWaiters > 0);
}

/**
 * 决策 D8-#2：为本任务物化一份**独立**的 settings 文档 + 指向它的补丁层。
 *
 * 成功（返回对象）→ 该任务不需要改写全局 settings，因此**不需要互斥**，可以真并行。
 * 失败（返回 null）→ 调用方回退到旧的「全局改写 + 互斥」路径，行为与历史一致。
 * 之所以保留回退而不是"失败就让任务挂掉"：读不到 settings 时历史行为是
 * 告警后继续跑（settings_patch_skipped），不该因为这次优化把可用性变差。
 *
 * @returns {{dir:string, settingsPath:string, patchPath:string}|null}
 */
function materializeTaskSettings({ model, reasoningEffort }) {
  try {
    const original = readSettings();
    if (original == null) return null;
    const content = patchAgentDefault(original, { model, reasoningEffort });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), TASK_SETTINGS_PREFIX));
    const settingsPath = path.join(dir, 'settings.yaml');
    const patchPath = path.join(dir, 'redirect-settings.patch.yml');
    // 整份拷贝而不是只写 agent-default-model 分节：settings 里还可能有提供方/路由配置，
    // 少写一段就会让子进程的模型解析与全局不一致（那是很难查的"只在某台机器上复现"）。
    fs.writeFileSync(settingsPath, content, 'utf8');
    fs.writeFileSync(patchPath, buildSettingsRedirectPatch(settingsPath), 'utf8');
    return { dir, settingsPath, patchPath };
  } catch (e) {
    log({
      level: 'warn', layer: 'harness', kind: 'task_settings_failed',
      message: `每任务独立 settings 建立失败，回退到全局改写 + 互斥：${e.message}`
    });
    return null;
  }
}

/** 清掉每任务 settings 的临时目录（失败只记日志，不影响任务结果）。 */
function cleanupTaskSettings(taskSettings) {
  if (!taskSettings) return;
  try {
    fs.rmSync(taskSettings.dir, { recursive: true, force: true });
  } catch (e) {
    log({ level: 'warn', layer: 'harness', kind: 'task_settings_cleanup_failed', message: `每任务 settings 临时目录清理失败：${e.message}` });
  }
}

export async function runHarnessTaskWithProgress(prompt, options = {}, onChunk) {
  // 决策 B：首次真正执行任务时，把 home 决策打印**一次**（模块导入零副作用，见函数注释）。
  logTaskHomeDecisionOnce();

  if (!isHarnessAvailable()) {
    // 报错要指出**实际检查过哪些位置**：小白看到"未找到 deepseek-harness"时，
    // 唯一能自救的信息就是"它到底去哪里找过"。可在 AI 设置页「本地创作内核」卡里填路径。
    const info = resolveHarnessDirInfo();
    const tried = info.checked.map((c) => `${c.label}：${c.dir}`).join('；');
    throw new Error(`未找到 deepseek-harness（${info.dir}）。已检查：${tried}。可在「AI 设置 → 本地创作内核」里填写 dsh 仓库路径。`);
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

  // 模型名/思考强度校验放在进入全局互斥之前：非法参数立刻失败，
  // 不必先排队等别人跑完。模型名同时防特殊字符破坏 settings.yaml 结构（HA-07）。
  if (options.model && !/^[A-Za-z0-9._-]{1,64}$/.test(String(options.model))) {
    throw new Error('非法模型名：仅允许字母/数字/点/下划线/连字符');
  }
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  if (options.reasoningEffort && !reasoningEffort) {
    throw new Error(`非法思考强度：仅允许 ${REASONING_EFFORTS.join(' / ')}`);
  }
  // 两者任一需要改写 settings.yaml 才需要切换；都不需要则允许并行（HA-04）。
  const needsSettingsSwitch = requiresModelSwitchGate(options.model, reasoningEffort);

  // 决策 D8-#2：先物化「每任务独立 settings」。
  // ⚠️ 这一步必须在**上报"在排队"之前**做：若本任务其实不需要互斥（因为它不碰全局文件），
  // 却先报了 waiting-model，那正是 D4 要消灭的那种谎——只不过方向反了过来。
  const taskSettings = needsSettingsSwitch
    ? materializeTaskSettings({ model: options.model, reasoningEffort })
    : null;
  // 只有**回退路径**才真的会去抢全局槽位。
  const willSerialize = needsSettingsSwitch && !taskSettings;

  // 可观测性（决策 D4）：会抢全局槽位、且槽位已被占时，**先如实上报"在排队"**，
  // 而不是让调用方一直显示"运行中"。真正开跑时再报一次 'running'。
  if (typeof options.onPhase === 'function' && willWaitForModelSlot(willSerialize)) {
    try { options.onPhase('waiting-model', { waiters: modelSwitchWaiters + 1 }); } catch { /* 上报失败不影响任务 */ }
  }

  const runTask = async () => {
    // 真正开跑的时点（已拿到模型槽位，或确认根本不需要槽位）。
    // 用于把界面从"等待模型槽位"切回正常。
    if (typeof options.onPhase === 'function') {
      try { options.onPhase('running', {}); } catch { /* 上报失败不影响任务 */ }
    }
    // 回退路径才改写全局文件；走每任务 settings 时这两个变量保持原样。
    let originalSettings = null;
    let patched = false;
    let patchedContent = null;
    if (needsSettingsSwitch && !taskSettings) {
      originalSettings = readSettings();
    }
    if (needsSettingsSwitch && !taskSettings && originalSettings == null) {
      log({ level: 'warn', layer: 'harness', kind: 'settings_patch_skipped', message: '无法读取 settings.yaml，模型/强度切换被跳过（将以默认设置运行）' });
    }
    if (needsSettingsSwitch && !taskSettings && originalSettings != null) {
      try {
        patchedContent = patchAgentDefault(originalSettings, { model: options.model, reasoningEffort });
        if (patchedContent !== originalSettings) {
          writeSettings(patchedContent);
          writePatchBackup({ original: originalSettings, patched: patchedContent });
          patched = true;
        } else if (!/^agent-default-model:\s*$/m.test(originalSettings)) {
          // 分节缺失时改写会“静默无效”，显式告警避免误以为已切换成功。
          // 注意只在确实没有该分节时告警：若仅因目标值与现值一致而无需改写，属正常情况。
          log({
            level: 'warn', layer: 'harness', kind: 'settings_patch_noop',
            message: 'settings.yaml 中未找到 agent-default-model 分节，模型/强度切换未生效',
            context: { model: options.model || '', reasoning_effort: reasoningEffort }
          });
        }
      } catch (e) {
        log({ level: 'warn', layer: 'harness', kind: 'settings_patch_failed', message: `默认模型/强度切换失败：${e.message}` });
      }
    }

    // 默认超时与策略表同源（此前是 10 分钟的散落字面量；30 分钟见 ai/policy.mjs 的 LONG_AI_TIMEOUT_MS）
    const timeoutMs = options.timeout || LONG_AI_TIMEOUT_MS;
    const startedAt = Date.now();
    log({
      level: 'info', layer: 'harness', kind: 'task_start',
      message: 'Harness 任务开始',
      context: { timeout_ms: timeoutMs, model: options.model || '', reasoning_effort: reasoningEffort }
    });
    // 🐞 运行追踪：慢通道只记到进程边界（job id / 模型 / 耗时 / 成败）。
    // Token 不可得——dsh headless 驱动显式丢弃 usage 事件，stdout 只输出正文。
    // ⚠️ 基准必须取 traceNow()（追踪专用单调时钟），不能写 Date.now()：
    // 后者是 Unix 纪元毫秒，与追踪内部基准相减会得到 -1.787e12ms 的负数耗时。
    const traceT0 = traceNow();

    try {
      return await new Promise((resolve, reject) => {
        const launch = resolveDshLaunch();
        const pnpmJs = launch ? null : findPnpmJs();
        if (!launch && !pnpmJs) {
          reject(new Error('未找到 dsh 启动方式（无 scripts.dsh 且未找到 pnpm 的 corepack 入口），无法运行 dsh 任务'));
          return;
        }
        // 决策 D8-#2：走每任务独立 settings 时，用 `--patch` 把本子进程的 settings 文档
        // 指过去——全局文件一个字节都不动，因此多个任务可以真并行。
        // 参数顺序由 ai/task-settings.mjs 的纯函数保证（选项必须在任务文本之前）。
        const taskArgs = buildTaskArgs({
          profile: DSH_PROFILE,
          prompt,
          patchPath: taskSettings ? taskSettings.patchPath : null,
        });
        const spawnArgs = launch ? [...launch.args, ...taskArgs] : [pnpmJs, 'dsh', ...taskArgs];
        const spawnCwd = launch ? launch.cwd : harnessDir();
        const childEnv = harnessChildEnv({ peerId: OPENVIKING_PEER_ID, env: options.env });
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
          recordHarnessTrace('harness 任务（慢通道）', { t0: traceT0, model: options.model || '', status: 'timeout', error: err });
          log({
            level: 'error', layer: 'harness', kind: 'timeout',
            message: `Harness 任务超时（${Math.round(timeoutMs / 1000)}s），子进程已终止`,
            context: { timeout_ms: timeoutMs, model: options.model || '', reasoning_effort: reasoningEffort },
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
          const cancelErr = makeCancelled();
          recordHarnessTrace('harness 任务（慢通道）', { t0: traceT0, model: options.model || '', status: 'error', error: cancelErr });
          reject(cancelErr);
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
              context: { duration_ms: Date.now() - startedAt, model: options.model || '', reasoning_effort: reasoningEffort }
            });
            recordHarnessTrace('harness 任务（慢通道）', { t0: traceT0, model: options.model || '', status: 'ok', result: stdout.trim() });
            resolve(stdout.trim());
          } else {
            const err = new Error(readableErrorMessage(stderr, `Harness 退出码：${code}`));
            err.code = 'HARNESS_EXIT';
            err.stderr = stderr;
            log({
              level: 'error', layer: 'harness', kind: 'harness_exit',
              message: `Harness 任务失败（退出码 ${code}）：${err.message}`,
              error: err,
              context: { exit_code: code, duration_ms: Date.now() - startedAt, model: options.model || '', reasoning_effort: reasoningEffort }
            });
            recordHarnessTrace('harness 任务（慢通道）', { t0: traceT0, model: options.model || '', status: 'error', error: err });
            reject(err);
          }
        });
      });
    } finally {
      // 每任务 settings 的临时目录：无论成败都要清掉（里面是用户 settings 的副本）。
      cleanupTaskSettings(taskSettings);
      // CAS 还原（**仅回退路径**）：文件仍等于我们写入的内容时才恢复，避免覆盖并发/手改内容。
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
  // 决策 D8-#2：只有**回退路径**（没能建起每任务 settings）才需要串行化。
  // 走 `--patch` 的任务不碰任何全局状态，可以真并行——这正是吞吐从 1 回到 2 的原因。
  return willSerialize ? withModelSwitch(runTask) : runTask();
}

/**
 * 运行一次 dsh headless 任务。
 * @param {string} prompt 给 AI 的任务描述
 * @param {{ timeout?: number, model?: string, reasoningEffort?: string, env?: Record<string,string> }} [options]
 * @returns {Promise<string>} 任务输出
 */
export async function runHarnessTask(prompt, options = {}) {
  return runHarnessTaskWithProgress(prompt, options);
}
