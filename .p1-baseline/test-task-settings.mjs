#!/usr/bin/env node
/**
 * test-task-settings.mjs —— 决策 D8-#2 的离线单测（零成本、不 spawn dsh）。
 *
 * 被验证的行为：**每个任务一份独立的默认模型覆盖层**，从而不必改写任何全局配置、
 * 也就没有全局副作用需要串行化（吞吐从 1 回到 2）。
 *
 * ⚠️ 2026-09-24（dsh 0.1.1-rc.2 → 0.1.7-rc.1）机制换过，读这份测试前先看这段：
 * 旧做法是 `- id: settings` + `config.path: <每任务 settings 文档>`，依据是 0.1.1 的
 * `packages/settings/settings-file/src/index.ts:56`（`config.path ?? <home>/settings.yaml`）。
 * 0.1.7 把该包整包删除，`settings.yaml` 只在**首次启动时被导入 profile 一次**、
 * 文档路径**不可再重定向**（实测取证：`.dsh-upgrade-recon/c8-probe.mjs`——带 `config.path`
 * 的补丁层对请求体里的模型毫无影响）。现在改为直接覆盖真正决定默认模型的那条 entry：
 * `- id: agent-default-model` + `config: { provider, model, reasoningEffort }`。
 *
 * 这里钉三处最容易写错、且错了很难查的地方：
 *   1. **补丁内容**：定位的 id 必须是 `agent-default-model`，且 **`provider` 必须跟着给**——
 *      0.1.7 的补丁层对 `config` 是**整体替换**（`vendor/include/src/index.ts` 的
 *      applyEntryPatches），而 `provider` 是 schema 必填；少给一个不是"沿用旧值"，
 *      而是启动直接失败。所以这条要能被断言，不能靠"我记得带上"；
 *   2. **YAML 转义**：模型名/提供方里的单引号要写成两个，否则 YAML 直接坏掉；
 *   3. **参数顺序**：`--profile` / `--patch` 必须在任务文本**之前**——
 *      dsh 用位置参数接任务，顺序错了任务文本会被当成选项取值。
 *   4. **超长任务文本的通道**（§3b）：Windows 命令行上限 32767 个 UTF-16 码元，超了 spawn
 *      直接抛 ENAMETOOLONG；判据必须按**转义之后**的长度算（含固定参数占用），且两条通道
 *      用的必须是同一份文本。
 *
 * 另含两组阴性对照：
 *   - 没有模型名时 `buildModelOverridePatch` 必须返回 null（调用方据此走回退路径），
 *     以免"补丁里模型名为空"这种坏补丁被当成好补丁送进 dsh；
 *   - 一个"少了 provider 的补丁"必须被契约判据判为不合格——证明第 1 节测的是内容，
 *     不是"有没有返回值"。
 *
 * 用法: node .p1-baseline/test-task-settings.mjs
 */
import fs from 'node:fs';
import {
  DEFAULT_PROVIDER, TASK_SETTINGS_PREFIX,
  buildModelOverridePatch, buildTaskArgs,
  promptFitsArgv, normalizeTaskPrompt, estimateArgvUnits,
  parseAgentDefaultFromPatch, parseAgentDefaultFromSettings, resolveDefaultSelection,
} from '../ai/task-settings.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('【1. 补丁内容：必须覆盖 agent-default-model 条目，且 provider 一起给】');
{
  const yml = buildModelOverridePatch({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
  // YAML 允许先写注释，所以判"顶层数组"要看**第一个非注释行**，不是第一行。
  const firstReal = yml.split('\n').find((l) => l.trim() && !l.trimStart().startsWith('#'));
  ok('第一个非注释行就是数组条目（dsh 的硬要求：顶层 YAML 数组）',
    firstReal === '- id: agent-default-model', JSON.stringify(firstReal));
  // 缩进是 `- ` → id/config 在 2 列，config 的子键在 4 列。
  ok('provider 是必填字段，且缩进正确',
    /^ {4}provider: 'deepseek-official'$/m.test(yml),
    JSON.stringify(yml.split('\n').find((l) => l.includes('provider:'))));
  ok('model 缩进正确', /^ {4}model: 'deepseek-flash'$/m.test(yml),
    JSON.stringify(yml.split('\n').find((l) => l.includes('model:'))));
  ok('reasoningEffort 缩进正确', /^ {4}reasoningEffort: 'max'$/m.test(yml),
    JSON.stringify(yml.split('\n').find((l) => l.includes('reasoningEffort:'))));
  ok('只出现一个条目（多写一个会把别人的配置也覆盖掉）',
    yml.split('\n').filter((l) => /^- /.test(l)).length === 1);

  const noEffort = buildModelOverridePatch({ provider: 'deepseek-official', model: 'x' });
  ok('不指定强度时不写 reasoningEffort（空值会让 schema 收到空串）',
    !/reasoningEffort/.test(noEffort), JSON.stringify(noEffort));
  const noProvider = buildModelOverridePatch({ model: 'x' });
  ok('调用方漏给 provider 时兜到出厂默认（否则 schema 必填校验会直接失败）',
    new RegExp(`^ {4}provider: '${DEFAULT_PROVIDER}'$`, 'm').test(noProvider), JSON.stringify(noProvider));
}

console.log('\n【2. 引号要被转义（否则 YAML 直接坏掉）】');
{
  const yml = buildModelOverridePatch({ provider: "o'brien", model: "deep/sse-'v2'", reasoningEffort: 'high' });
  for (const key of ['provider', 'model']) {
    const line = yml.split('\n').find((l) => l.includes(`${key}:`));
    ok(`${key} 里的单引号被写成两个（YAML 单引号串的转义规则）`, /''/.test(line), line);
    ok(`${key} 不会"引号提前闭合"（闭合引号后面只剩空白）`, /^ {4}\w+: '.*?'\s*$/.test(line), line);
  }
}

console.log('\n【3. 参数顺序：选项必须在任务文本之前】');
{
  const withPatch = buildTaskArgs({ profile: 'novel', prompt: '写一段', patchPath: '/tmp/p.yml' });
  ok('含 --profile', withPatch[0] === '--profile' && withPatch[1] === 'novel');
  ok('含 --patch 且带值', withPatch[2] === '--patch' && withPatch[3] === '/tmp/p.yml');
  ok('任务文本是**最后一个**参数', withPatch[withPatch.length - 1] === '写一段', JSON.stringify(withPatch));

  const noPatch = buildTaskArgs({ profile: 'novel', prompt: '写一段' });
  ok('没有补丁时不出现 --patch', !noPatch.includes('--patch'), JSON.stringify(noPatch));
  ok('没有补丁时任务文本仍是最后一个', noPatch[noPatch.length - 1] === '写一段');

  ok('任务文本被 trim（避免把空白的参数传给 dsh）',
    buildTaskArgs({ profile: 'novel', prompt: '  写一段  ' }).at(-1) === '写一段');
  ok('prompt 为空也不崩（传空串而不是 undefined）',
    buildTaskArgs({ profile: 'novel', prompt: null }).at(-1) === '');
}

console.log('\n【3b. 超长任务文本改走 stdin（Windows argv 上限 32767 个 UTF-16 码元）】');
{
  // 为什么要钉：Windows 上 spawn 把 exe 与全部参数拼成一条命令行，超限时 Node **同步抛**
  // spawn ENAMETOOLONG。工坊把整个 prompt 塞在 argv 里，长章 + 完整上下文很容易撞到
  // （实测 40000/120000 字必失败，见 .dsh-rc-compat/rt15-argv-limit.mjs）。
  const long = '甲'.repeat(40000);
  const argvMode = buildTaskArgs({ profile: 'novel', prompt: long });
  ok('没有 stdin 开关时，任务文本仍进 argv（默认路径不变）', argvMode.at(-1) === long);

  const stdinMode = buildTaskArgs({ profile: 'novel', prompt: long, stdin: true });
  ok('stdin 通道下任务文本**不进** argv（否则 40k 字必失败）',
    stdinMode.at(-1) === '-' && !stdinMode.some((a) => a.length > 64), JSON.stringify(stdinMode));
  ok('stdin 通道下选项顺序不变（--profile 仍在前、任务位仍是最后一个）',
    stdinMode[0] === '--profile' && stdinMode[1] === 'novel');
  const withPatch = buildTaskArgs({ profile: 'novel', prompt: long, patchPath: '/tmp/p.yml', stdin: true });
  ok('stdin 通道与 --patch 可以共存（顺序：--profile / --patch / -）',
    withPatch[0] === '--profile' && withPatch[2] === '--patch' && withPatch[3] === '/tmp/p.yml' && withPatch.at(-1) === '-',
    JSON.stringify(withPatch));

  ok('短文本继续走 argv（<= 阈值的默认路径一字不改）', promptFitsArgv('写一段') === true);
  ok('29000 码元仍走 argv（阈值以内不换通道）', promptFitsArgv('甲'.repeat(29000)) === true);
  ok('31000 码元换 stdin（越过安全余量）', promptFitsArgv('甲'.repeat(31000)) === false);
  ok('固定参数（exe + 入口 + 选项）的占用一起算：同一文本 + 大预留 → 换通道',
    promptFitsArgv('甲'.repeat(29000)) === true && promptFitsArgv('甲'.repeat(29000), 3000) === false);
  // 引号转义：libuv 会把参数里的 " 写成 \"（一个码元变两个），只按裸长度判会漏。
  const quotes = '"'.repeat(12500) + '甲'.repeat(12500);
  ok('引号密集文本按"转义后"长度判（裸长 25000 看着没超，实际约 37500 → 换通道）',
    quotes.length === 25000 && estimateArgvUnits(quotes) > 32767 - 2048 && promptFitsArgv(quotes) === false,
    'estimate=' + estimateArgvUnits(quotes));
  ok('预留参数非法时不放大也不缩小余量（NaN/负数按 0 处理）',
    promptFitsArgv('写一段', NaN) === true && promptFitsArgv('写一段', -1) === true);
  ok('两条通道用的是同一份文本（trim 规则一致，换通道不会悄悄改内容）',
    buildTaskArgs({ profile: 'novel', prompt: '  写一段  ' }).at(-1) === normalizeTaskPrompt('  写一段  ')
    && stdinMode.at(-1) === '-');
}
console.log('\n【4. 三级取值：settings 文档 → profile 补丁 → 出厂默认】');
{
  // 0.1.7 之后 settings.yaml 会被导入一次并改名，所以"只认 settings"会静默取不到值。
  const settingsYaml = ['agent-default-model:', '  model: deepseek-flash', '  provider: deepseek-official', '  reasoningEffort: max', ''].join('\n');
  const fromSettings = resolveDefaultSelection({ settingsYaml });
  ok('settings 文档里的 model/provider/强度都读到了',
    fromSettings.model === 'deepseek-flash' && fromSettings.provider === 'deepseek-official' && fromSettings.reasoningEffort === 'max',
    JSON.stringify(fromSettings));
  ok('并如实标注取值来源是 settings', fromSettings.providerSource === 'settings', fromSettings.providerSource);

  // profile 补丁里是**导入后的真实形状**（含 name 行；model 值来自本次升级取证 c8-probe）。
  const importedPatch = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-official',
    '    model: dsh-c8-probe-legacy',
    '    reasoningEffort: max',
    '',
  ].join('\n');
  const fromPatch = resolveDefaultSelection({ profilePatchYaml: importedPatch });
  ok('settings 文档缺失（导入后已改名）时能从 profile 补丁读到 model',
    fromPatch.model === 'dsh-c8-probe-legacy', JSON.stringify(fromPatch));
  ok('profile 补丁里的 provider 也读到了（这是覆盖层的必填字段）',
    fromPatch.provider === 'deepseek-official', fromPatch.provider);
  ok('取值来源如实标注为 profile-patch', fromPatch.providerSource === 'profile-patch', fromPatch.providerSource);
  ok('解析的是 config 子节：name 行不会被误当成 provider/model',
    parseAgentDefaultFromPatch(importedPatch).name === undefined, JSON.stringify(parseAgentDefaultFromPatch(importedPatch)));
  ok('settings 文档的解析只看 agent-default-model 分节（其它顶层分节的 model 不算）',
    parseAgentDefaultFromSettings(['ui-conversation:', '  model: 不该被读到', ''].join('\n')).model === undefined);

  const nothing = resolveDefaultSelection({});
  ok('两处都没有时：provider 退到出厂默认、model 为空（由调用方走回退）',
    nothing.provider === DEFAULT_PROVIDER && nothing.model === '' && nothing.providerSource === 'default',
    JSON.stringify(nothing));
}

console.log('\n【5. 阴性对照：坏补丁必须被判为不满足契约】');
{
  ok('没有模型名时返回 null（而不是生成一个模型名为空的补丁）',
    buildModelOverridePatch({ provider: 'deepseek-official' }) === null
    && buildModelOverridePatch({}) === null
    && buildModelOverridePatch({ model: '   ' }) === null);

  // 变异体：只给了 model，没有 provider —— 这正是"补丁层整体替换 config"会踩的坑，
  // dsh 侧表现为 schema 必填校验失败（启动失败），而不是"沿用旧 provider"。
  const mutant = () => ['- id: agent-default-model', '  config:', "    model: 'x'", ''].join('\n');
  const hasProvider = (yml) => /^\s*provider:/m.test(yml);
  ok('变异体确实缺少 provider（这正是要抓的失败模式）', !hasProvider(mutant()));
  ok('契约断言能区分真补丁与变异体（否则第 1 节测的是空气）',
    hasProvider(mutant()) !== hasProvider(buildModelOverridePatch({ model: 'x' })));
}

console.log('\n【6. 临时目录前缀可识别（便于清理与在日志里一眼认出）】');
{
  ok('前缀非常见词，且是字符串', typeof TASK_SETTINGS_PREFIX === 'string' && TASK_SETTINGS_PREFIX.length > 8,
    TASK_SETTINGS_PREFIX);
}

console.log('\n【7. 接线：harness.js 真的用了它，且不写全局文件】');
{
  const src = fs.readFileSync('harness.js', 'utf8');
  ok('导入了本模块', /from '\.\/ai\/task-settings\.mjs'/.test(src));
  ok('spawn 参数走纯函数组装（不在调用点手拼顺序）', /buildTaskArgs\(\{/.test(src));
  ok('只有回退路径才改写全局配置文件',
    (src.match(/needsSettingsSwitch && !taskSettings/g) || []).length >= 3,
    `出现 ${(src.match(/needsSettingsSwitch && !taskSettings/g) || []).length} 次`);
  ok('临时目录在 finally 里清理', /cleanupTaskSettings\(taskSettings\);/.test(src));
  ok('每任务补丁走的是覆盖 agent-default-model 的补丁层',
    /override-default-model\.patch\.yml/.test(src));
  ok('不再生成"重定向 settings 文档"的补丁（0.1.7 起该机制已失效，别改回去）',
    !/redirect-settings\.patch\.yml/.test(src) && !/buildSettingsRedirectPatch/.test(src));
  ok('每任务补丁的 provider 取自"settings 文档 → profile 补丁"三级取值',
    /resolveDefaultSelection\(/.test(src) && /profilePatchYaml/.test(src));
  // 超长 prompt 的通道：判据 + 显式 stdio + 写入前挂 error 处理，三样缺一都会在超长章节上炸。
  ok('超长 prompt 改走 stdin 的接线完整（判据 / stdio / EPIPE 处理）',
    /promptFitsArgv\(prompt, reservedUnits\)/.test(src) && /stdin: useStdinPrompt/.test(src)
      && /stdio: \['pipe', 'pipe', 'pipe'\]/.test(src) && /child\.stdin\.end\(normalizeTaskPrompt/.test(src));
}

console.log(`\n══════════════════════════════`);
console.log(`每任务默认模型覆盖层离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
