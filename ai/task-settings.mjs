/**
 * task-settings.mjs —— 「每个任务一份独立 settings 文档」（决策 D8-#2）。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────────
 * dsh 的默认模型/思考强度只存在于 `~/.dsh/settings.yaml`（全局、进程级），
 * 而 dsh 的 headless CLI **没有**任务级模型参数（`.p0-recon/headless.help.txt` 实抓）。
 * 于是小说工坊此前的做法是：「改写全局文件 → 跑任务 → 还原」，并为这个全局副作用
 * 加了一把互斥锁串行化。结果是：服务端允许 2 个作业，**实际吞吐却只有 1**；
 * 而且任务若崩在中间，用户的默认模型会停留在被改写状态（有侧车备份兜底，但那是补救）。
 *
 * ── 为什么现在可以不改全局文件 ────────────────────────────────────────────────
 * dsh 支持 `--patch <file>`（叠加配置层），而 settings 插件的文档路径是**可配置**的
 * （`packages/settings/settings-file/src/index.ts:56`：`config.path ?? <harness home>/settings.yaml`）。
 * 把两者接起来，就能让**这一个子进程**读另一份 settings 文档。
 *
 * 这一点**不是读代码猜的**，是实测的（`.p1-baseline/exp-per-task-settings.mjs`）：
 * 黑洞端点收请求、dump 原始报文，哨兵模型名只在带 `--patch` 时出现，阴性对照里不出现；
 * 审计另从 dsh 会话转录里独立读出两个会话分别用了哨兵模型与真实模型，且都零计费。
 *
 * ── 于是 ──────────────────────────────────────────────────────────────────────
 * 没有共享可变状态 → 不需要互斥 → 吞吐回到 2。
 * 本模块只放**纯函数**（补丁文本、子进程参数顺序），文件 I/O 留在 harness.js，
 * 这样"参数顺序"和"补丁内容"这两处最容易写错的地方可以被离线断言钉住。
 */

/**
 * 生成"把 settings 文档指向指定文件"的补丁层。
 * dsh 的补丁层必须是**顶层 YAML 数组**，条目按 `id` 定位已组合的插件。
 *
 * @param {string} settingsFilePath 该任务专属的 settings 文档路径
 * @returns {string} YAML 文本
 */
export function buildSettingsRedirectPatch(settingsFilePath) {
  // YAML 单引号字符串：内部的单引号要写成两个；Windows 路径的反斜杠在此不构成转义，
  // 但统一转成正斜杠可以少一类"反斜杠被 YAML 吃掉"的意外。
  const p = String(settingsFilePath).replace(/\\/g, '/').replace(/'/g, "''");
  return [
    '# 由 novel-studio 生成（每任务一份）：把本进程的 settings 文档指向独立副本，',
    '# 这样就不必改写用户的全局 ~/.dsh/settings.yaml —— 也就没有全局副作用需要串行化。',
    '- id: settings',
    '  config:',
    `    path: '${p}'`,
    '',
  ].join('\n');
}

/**
 * 组装 dsh 子进程的参数。
 *
 * ⚠️ **顺序有语义**：dsh 的 CLI 用位置参数接任务文本，
 * 选项必须排在任务文本**之前**，否则任务文本会被当成选项的取值（或被当成未知选项）。
 *
 * @param {{ profile: string, prompt: string, patchPath?: string|null }} o
 * @returns {string[]}
 */
export function buildTaskArgs({ profile, prompt, patchPath = null }) {
  const args = ['--profile', String(profile)];
  if (patchPath) args.push('--patch', String(patchPath));
  args.push(String(prompt ?? '').trim());
  return args;
}

/** 每任务 settings 的临时目录前缀（便于识别与清理，也便于在日志里一眼看出）。 */
export const TASK_SETTINGS_PREFIX = 'novelstudio-task-settings-';
