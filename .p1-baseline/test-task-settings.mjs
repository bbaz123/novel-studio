#!/usr/bin/env node
/**
 * test-task-settings.mjs —— 决策 D8-#2 的离线单测（零成本、不 spawn dsh）。
 *
 * 被验证的行为：**每个任务一份独立 settings 文档**，从而不必改写全局
 * `~/.dsh/settings.yaml`、也就没有全局副作用需要串行化（吞吐从 1 回到 2）。
 *
 * 这里钉两处最容易写错、且错了很难查的地方：
 *   1. **补丁内容**：必须是指向目标文件的 `id: settings` → `config.path`；
 *      路径含反斜杠/单引号时仍要是合法 YAML（否则 dsh 解析失败或指向错文件）；
 *   2. **参数顺序**：`--profile` / `--patch` 必须在任务文本**之前**——
 *      dsh 用位置参数接任务，顺序错了任务文本会被当成选项取值。
 *
 * 另含阴性对照：把补丁改成"不指向任何路径"（等于没打补丁），
 * 断言它**不**满足契约——证明这里的断言确实在检查内容，而不是检查"有没有返回值"。
 *
 * 用法: node .p1-baseline/test-task-settings.mjs
 */
import fs from 'node:fs';
import { buildSettingsRedirectPatch, buildTaskArgs, TASK_SETTINGS_PREFIX } from '../ai/task-settings.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('【1. 补丁内容：必须把 settings 插件指向目标文件】');
{
  const yml = buildSettingsRedirectPatch('C:\\Users\\x\\Temp\\novelstudio-task-settings-ab\\settings.yaml');
  // YAML 允许先写注释，所以判"顶层数组"要看**第一个非注释行**，不是第一行。
  const firstReal = yml.split('\n').find((l) => l.trim() && !l.trimStart().startsWith('#'));
  ok('第一个非注释行就是数组条目（dsh 的硬要求：顶层 YAML 数组）',
    firstReal === '- id: settings', JSON.stringify(firstReal));
  ok('定位的插件 id 是 settings', /^- id: settings$/m.test(yml));
  // 缩进是 `- ` → id/config 在 2 列，config 的子键 path 在 4 列。
  ok('config.path 缩进正确并指向目标文件',
    /^ {4}path: 'C:\/Users\/x\/Temp\/novelstudio-task-settings-ab\/settings\.yaml'$/m.test(yml),
    JSON.stringify(yml.split('\n').find((l) => l.includes('path:'))));
  ok('反斜杠已转成正斜杠（少一类"被 YAML 吃掉"的意外）', !/path: '[^']*\\/.test(yml));
}

console.log('\n【2. 路径里的单引号要被转义（否则 YAML 直接坏掉）】');
{
  const weird = "/tmp/o'brien/settings.yaml";
  const yml = buildSettingsRedirectPatch(weird);
  const line = yml.split('\n').find((l) => l.includes('path:'));
  ok('单引号被写成两个（YAML 单引号串的转义规则）', /''/.test(line), line);
  ok('不会出现"引号提前闭合"（闭合引号后面只剩空白）', /^ {4}path: '.*?'\s*$/.test(line), line);
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

console.log('\n【4. 阴性对照：一个"没真正指向文件"的补丁必须不满足契约】');
{
  // 变异体：只写了 id，没有 config.path —— 等于没打补丁（dsh 仍会读全局 settings）。
  const mutant = (p) => ['- id: settings', '  config: {}', ''].join('\n');
  const yml = mutant('/tmp/x/settings.yaml');
  const hasPath = /path:/.test(yml);
  ok('变异体确实缺少 path（这正是要抓的失败模式）', !hasPath, JSON.stringify(yml));
  ok('契约断言能区分真补丁与变异体（否则第 1 节测的是空气）',
    hasPath !== /path:/.test(buildSettingsRedirectPatch('/tmp/x/settings.yaml')));
}

console.log('\n【5. 临时目录前缀可识别（便于清理与在日志里一眼认出）】');
{
  ok('前缀非常见词，且是字符串', typeof TASK_SETTINGS_PREFIX === 'string' && TASK_SETTINGS_PREFIX.length > 8,
    TASK_SETTINGS_PREFIX);
}

console.log('\n【6. 接线：harness.js 真的用了它，且不写全局文件】');
{
  const src = fs.readFileSync('harness.js', 'utf8');
  ok('导入了本模块', /from '\.\/ai\/task-settings\.mjs'/.test(src));
  ok('spawn 参数走纯函数组装（不在调用点手拼顺序）', /buildTaskArgs\(\{/.test(src));
  ok('只有回退路径才改写全局 settings',
    (src.match(/needsSettingsSwitch && !taskSettings/g) || []).length >= 3,
    `出现 ${(src.match(/needsSettingsSwitch && !taskSettings/g) || []).length} 次`);
  ok('临时目录在 finally 里清理', /cleanupTaskSettings\(taskSettings\);/.test(src));
  ok('每任务 settings 用的是整份拷贝（不只手写 agent-default-model 分节）',
    /fs\.writeFileSync\(settingsPath, content, 'utf8'\)/.test(src));
}

console.log(`\n══════════════════════════════`);
console.log(`每任务 settings 离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
