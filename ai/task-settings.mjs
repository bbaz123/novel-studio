/**
 * task-settings.mjs —— 「每个任务一份独立默认模型」（决策 D8-#2；2026-09-24 迁移到 dsh 0.1.7）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * dsh 的默认模型/思考强度是**进程级**的（`agent-default-model` 条目的配置），
 * 而 dsh 的 headless CLI **没有**任务级模型参数（`.p0-recon/headless.help.txt` 实抓；0.1.7 复核仍在）。
 * 于是小说工坊此前的做法是：「改写全局 settings 文件 → 跑任务 → 还原」，并为这个全局副作用
 * 加了一把互斥锁串行化。结果是：服务端允许 2 个作业，**实际吞吐却只有 1**；
 * 而且任务若崩在中间，用户的默认模型会停留在被改写状态（有侧车备份兜底，但那是补救）。
 *
 * ── 为什么现在可以不改全局文件 ────────────────────────────────────────────────
 * dsh 支持 `--patch <file>`（叠加配置层）。0.1.1 时代靠 settings 插件的
 * `config.path` 把**文档路径**换掉；0.1.7 起 `packages/settings/settings-file` 整包删除、
 * `settings.yaml` 只在首次启动时被导入 profile 一次，文档路径**不可再重定向**
 * （2026-09-24 实测：带 `- id: settings` / `config.path` 的补丁层对请求里的模型毫无影响，
 * 取证见 `.dsh-upgrade-recon/c8-probe.mjs` 与同目录 `00-SUMMARY.md` 的 C8）。现在改为直接覆盖
 * 真正决定默认模型的那条 entry：
 *
 *   - id: agent-default-model
 *     config: { provider, model, reasoningEffort }
 *
 * 覆盖的仍只是**这一个子进程**的配置层（`--patch` 只在本次启动生效），所以依旧
 * 没有共享可变状态 → 不需要互斥 → 吞吐回到 2。
 *
 * ⚠️ 两处**必须注意**的语义（写错会静默不生效或启动失败）：
 *   1. 0.1.7 的补丁层对 `config` 是**整体替换**（`vendor/include/src/index.ts` 的
 *      applyEntryPatches：`target[key] = value`），不是深合并；
 *   2. `provider` 是 `agent-default-model` schema 的**必填**字段。
 * 所以补丁里必须同时给出 provider——取值顺序：settings 文档 → profile 补丁 → dsh 出厂默认。
 *
 * 本模块只放**纯函数**（补丁文本、分节解析、子进程参数顺序），文件 I/O 留在 harness.js，
 * 这样"参数顺序"和"补丁内容"这两处最容易写错的地方可以被离线断言钉住。
 */

/** dsh base bundle 出厂时的 provider（0.1.7 `packages/bundle/base/cordis.patch.yml` 的 settings 条目）。 */
export const DEFAULT_PROVIDER = 'deepseek-official';

/** YAML 单引号字符串：内部的单引号要写成两个。 */
function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 去掉 YAML 标量两侧的引号与行尾注释。 */
function yamlScalar(raw) {
  return String(raw ?? '').replace(/\s+#.*$/, '').trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^"(.*)"$/, '$1');
}

/**
 * 行式读一个顶层分节里的 `键: 值`（不引入 YAML 依赖：本仓库是零依赖项目，
 * 与 `harness.js` 里 `patchAgentDefault` 同一种解析风格）。
 * @param {string|null|undefined} yaml 文档文本
 * @param {string} section 顶层键名
 * @returns {Record<string,string>}
 */
function readSection(yaml, section) {
  const out = {};
  let inside = false;
  for (const line of String(yaml ?? '').split(/\r?\n/)) {
    if (/^[A-Za-z0-9_-]+:\s*(#.*)?$/.test(line)) {
      inside = yamlScalar(line) === `${section}:`;
      continue;
    }
    if (!inside) continue;
    const m = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (m) out[m[1]] = yamlScalar(m[2]);
  }
  return out;
}

/**
 * 从 settings 文档文本读 `agent-default-model` 分节。
 * ⚠️ 0.1.7 起该文档只在首次启动时被导入 profile 一次，之后会被改名为 `settings.yaml.imported`，
 * 所以它只是**取值来源之一**，不是唯一依据（见 resolveDefaultSelection）。
 */
export function parseAgentDefaultFromSettings(yaml) {
  return readSection(yaml, 'agent-default-model');
}

/** 从 profile 的 `cordis.patch.yml` 文本读 `- id: agent-default-model` 条目的 config（0.1.7 的持久化位置）。 */
export function parseAgentDefaultFromPatch(yaml) {
  const lines = String(yaml ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*agent-default-model\s*$/.test(l));
  if (start < 0) return {};
  const baseIndent = lines[start].match(/^\s*/)[0].length;
  const out = {};
  let inConfig = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;                       // 下一个条目 / 回到顶层
    if (/^\s*config:\s*(#.*)?$/.test(line)) { inConfig = true; continue; }
    if (!inConfig) continue;
    const m = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (m) out[m[1]] = yamlScalar(m[2]);
  }
  return out;
}

/**
 * 取默认选择：settings 文档 → profile 补丁 → 已导入快照（.imported） → dsh 出厂默认 provider。
 *
 * ⚠️ 第三来源 `<home>/settings.yaml.imported` 不是"保险起见多读一份"，而是实测缺陷的兜底：
 * 0.1.7 的一次性导入有个**可复现**的失败模式——启动时若带着覆盖 `agent-default-model` 的补丁层
 * （正是本模块生成的每任务补丁），该分节的导入会静默失败：文件照样被改名成 `.imported`，
 * 值却没进 profile 补丁。此时**唯一**还留着用户原值的文件就是 `.imported`
 * （取证：`.dsh-upgrade-recon/import-single-patch.mjs` 单进程带补丁 0/3 落地；对照组
 * `import-race4.mjs` 空补丁层 3/3 落地、`import-log.mjs` 无补丁落地）。
 * 不读它，用户就会遇到"文件还在、值已丢"——而这是最难查的一类降级。
 *
 * @param {{settingsYaml?:string|null, profilePatchYaml?:string|null, importedYaml?:string|null}} [input]
 * @returns {{provider:string, model:string, reasoningEffort:string, providerSource:'settings'|'profile-patch'|'imported'|'default'}}
 */
export function resolveDefaultSelection({ settingsYaml, profilePatchYaml, importedYaml } = {}) {
  const fromSettings = parseAgentDefaultFromSettings(settingsYaml);
  const fromPatch = parseAgentDefaultFromPatch(profilePatchYaml);
  const fromImported = parseAgentDefaultFromSettings(importedYaml);
  const pick = (key) => fromSettings[key] || fromPatch[key] || fromImported[key] || '';
  return {
    provider: pick('provider') || DEFAULT_PROVIDER,
    model: pick('model'),
    reasoningEffort: pick('reasoningEffort'),
    providerSource: fromSettings.provider ? 'settings'
      : fromPatch.provider ? 'profile-patch'
        : fromImported.provider ? 'imported' : 'default',
  };
}

/**
 * 生成"把本任务的默认模型覆盖成指定值"的补丁层。
 * dsh 的补丁层必须是**顶层 YAML 数组**，条目按 `id` 定位已组合的插件。
 *
 * @param {{provider?:string, model?:string, reasoningEffort?:string}} [selection]
 * @returns {string|null} YAML 文本；没有模型名时返回 null（调用方据此回退）
 */
export function buildModelOverridePatch({ provider, model, reasoningEffort } = {}) {
  const name = String(model ?? '').trim();
  if (!name) return null;
  const lines = [
    '# 由 novel-studio 生成（每任务一份）：用 --patch 覆盖本进程的默认模型条目。',
    '# 0.1.7 起 settings 文档路径不可再重定向（settings-file 插件已删除；settings.yaml',
    '# 只在首次启动时导入 profile 一次），所以直接改真正决定默认模型的那条 entry。',
    '# ⚠️ 补丁层对 config 是整体替换、provider 必填，因此两处都要一起给。',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${yamlString(provider || DEFAULT_PROVIDER)}`,
    `    model: ${yamlString(name)}`,
  ];
  const effort = String(reasoningEffort ?? '').trim();
  if (effort) lines.push(`    reasoningEffort: ${yamlString(effort)}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 组装 dsh 子进程的参数。
 *
 * ⚠️ **顺序有语义**：dsh 的 CLI 用位置参数接任务文本，
 * 选项必须排在任务文本**之前**，否则任务文本会被当成选项的取值（或被当成未知选项）。
 *
 * `stdin: true` 时任务文本位置只放 `-`：dsh 的 headless 运行器把位置参数 `-` 解释成
 * "任务文本从 stdin 读"。这条通道用于超出 Windows argv 上限的超长任务文本，
 * 判据见下面 `promptFitsArgv`。
 *
 * @param {{ profile: string, prompt: string, patchPath?: string|null, stdin?: boolean }} o
 * @returns {string[]}
 */
export function buildTaskArgs({ profile, prompt, patchPath = null, stdin = false }) {
  const args = ['--profile', String(profile)];
  if (patchPath) args.push('--patch', String(patchPath));
  args.push(stdin ? STDIN_TASK_ARG : normalizeTaskPrompt(prompt));
  return args;
}

/**
 * 任务文本的规范化。
 *
 * argv 与 stdin 两条通道**必须**用同一份文本：否则"换通道"会悄悄改掉模型收到的东西，
 * 而那种差异在回归里几乎看不出来（少一个换行，模型照样能写）。
 *
 * @param {string|null|undefined} prompt
 * @returns {string}
 */
export function normalizeTaskPrompt(prompt) {
  return String(prompt ?? '').trim();
}

/** dsh 的位置参数 `-`：任务文本从 stdin 读（`dsh --profile novel -`）。 */
export const STDIN_TASK_ARG = '-';

// ── Windows argv 上限：超长任务文本改走 stdin ────────────────────────────────
//
// 为什么要这一段：Windows 上 spawn 经 libuv → CreateProcessW，把 exe 与**全部参数**
// 拼成一条命令行，上限 32767 个 UTF-16 码元；超了 CreateProcessW 直接失败，
// Node **同步抛** `spawn ENAMETOOLONG`（不是 error 事件）。2026-09-25 实测
// （复现与验证脚本 .dsh-rc-compat/rt15-argv-limit.mjs）：
//   · 裸 `node fixture.mjs <任务文本>`：32650 码元成功、32700 码元失败；
//   · 走工坊真实路径：40000 字与 120000 字的中文任务文本 4ms 内硬失败、零输出。
// 长章 + 完整上下文的提示词很容易到这个量级，所以这不是理论边界。
//
// dsh 侧的通道：位置参数 `-` = 任务文本从 stdin 读
// （headless 运行器 `config.task === '-' ? readStdin() : task`）。
// 已实测 130000 字中文经 stdin 完整送达、无乱码（.dsh-rc-compat/evidence/rt8-run.txt），
// RC.1 与 RC.2 都支持。
//
// 计量单位用 **UTF-16 码元**（JS 的 String#length），不是 UTF-8 字节：被计量的就是那条
// UTF-16 命令行本身。一个中文字 1 码元 / 3 字节，按字节判会在 1/3 的规模上就误换通道。

/** Windows 命令行硬上限（CreateProcessW 的 lpCommandLine，含终止 NUL）。 */
export const WIN_ARGV_LIMIT_UNITS = 32767;

/** 留给"exe 路径 + 选项 + 环境 + 转义误差"的余量：超过它才换 stdin 通道。 */
export const ARGV_UNITS_MARGIN = 2048;

/**
 * 任务文本塞进 argv 时，命令行上的**码元占用上界**。
 *
 * 为什么要把引号/反斜杠算进去：libuv 在 Windows 上会给含空格或引号的参数加引号包裹，
 * 参数里的 `"` 会写成 `\"`（一个码元变两个）。只按裸长度判，引号密集的文本
 * （逐字稿、JSON 片段、带英文引号的对话）会在"看着没超"的时候超限。
 * 反斜杠只在紧邻引号或结尾时才需要转义，这里一律计入——这是上界，宁早换通道。
 *
 * @param {string} prompt
 * @returns {number}
 */
export function estimateArgvUnits(prompt) {
  const text = normalizeTaskPrompt(prompt);
  let units = text.length + 2; // 两端包裹引号
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 34 || code === 92) units += 1; // " 与 \ 各多占一个码元
  }
  return units;
}

/**
 * 任务文本能否安全地走 argv。
 *
 * @param {string} prompt 任务文本
 * @param {number} [reservedUnits] 固定参数的占用上界（exe 路径 + 入口 + 选项）
 * @returns {boolean} true = 继续走 argv（默认路径）；false = 换 stdin 通道
 */
export function promptFitsArgv(prompt, reservedUnits = 0) {
  const reserved = Number(reservedUnits);
  const extra = Number.isFinite(reserved) && reserved > 0 ? reserved : 0;
  return estimateArgvUnits(prompt) + extra <= WIN_ARGV_LIMIT_UNITS - ARGV_UNITS_MARGIN;
}

/** 每任务补丁的临时目录前缀（便于识别与清理，也便于在日志里一眼看出）。 */
export const TASK_SETTINGS_PREFIX = 'novelstudio-task-settings-';
