#!/usr/bin/env node
/**
 * test-harness-env.mjs —— dsh 子进程环境契约的离线单测（零成本、不 spawn 任何进程）。
 *
 * 被验证的缺陷（2026-09-15 实测）：dsh 侧小说工具解析服务地址的顺序是
 *   `NOVELSTUDIO_BASE_URL` → 插件安装时写死的 `config.baseUrl`（3737）→ 默认 3737
 * 而 `compressStoryMemory` 与 `generateNovelFromHarness` 两处调用点**没有下发**它，
 * 于是隔离实例（非 3737 端口）上的这两条任务会把 novel_* 工具打到**生产实例**。
 * 修复方式是在唯一的 spawn 出口给默认值 —— 本测试就是钉住这个默认值。
 *
 * 用法: node .p1-baseline/test-harness-env.mjs
 */
import { harnessChildEnv, selfBaseUrl, DEFAULT_PORT, dedicatedHomePath, dedicatedHomeUsable, resolveTaskDshHome, taskHomeInfo, DEDICATED_HOME_ENV, DEFAULT_DEDICATED_HOME } from '../ai/harness-env.mjs';
// 设置文件路径的取得方式住在 harness.js（要跟着专用 home 走）；这里做语义断言而非源码形状断言。
import { dshSettingsPath } from '../harness.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. 隔离实例：默认地址必须是「本实例」，不是写死的 3737】');
{
  const e = harnessChildEnv({ port: 3741, peerId: 'p', baseEnv: {} });
  ok('port=3741 → http://127.0.0.1:3741', e.NOVELSTUDIO_BASE_URL === 'http://127.0.0.1:3741',
    `实际 ${e.NOVELSTUDIO_BASE_URL}`);
  ok('port=3741 时**不得**回落成 3737（这正是隔离缺口）',
    e.NOVELSTUDIO_BASE_URL !== 'http://127.0.0.1:3737', `实际 ${e.NOVELSTUDIO_BASE_URL}`);
}

console.log('\n【2. 生产实例：取值必须与历史行为逐字一致（零行为变更）】');
{
  const e = harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: {} });
  ok('port=3737 → http://127.0.0.1:3737（与插件 config.baseUrl 相同）',
    e.NOVELSTUDIO_BASE_URL === 'http://127.0.0.1:3737', `实际 ${e.NOVELSTUDIO_BASE_URL}`);
  const e2 = harnessChildEnv({ peerId: 'p', baseEnv: { PORT: '3737' } });
  ok('未传 port 时读 baseEnv.PORT', e2.NOVELSTUDIO_BASE_URL === 'http://127.0.0.1:3737');
  const e3 = harnessChildEnv({ peerId: 'p', baseEnv: {} });
  ok(`PORT 也未设置 → 退到默认 ${DEFAULT_PORT}`, e3.NOVELSTUDIO_BASE_URL === `http://127.0.0.1:${DEFAULT_PORT}`);
}

console.log('\n【3. 优先级：调用方显式给的值最高】');
{
  const e = harnessChildEnv({ port: 3741, peerId: 'p', baseEnv: {}, env: { NOVELSTUDIO_BASE_URL: 'http://127.0.0.1:9999' } });
  ok('调用方 env 覆盖默认值', e.NOVELSTUDIO_BASE_URL === 'http://127.0.0.1:9999', `实际 ${e.NOVELSTUDIO_BASE_URL}`);
  const e2 = harnessChildEnv({ port: 3741, peerId: 'p', baseEnv: { NOVELSTUDIO_BASE_URL: 'http://127.0.0.1:8888' } });
  ok('进程环境里已有该变量时优先于计算默认值',
    e2.NOVELSTUDIO_BASE_URL === 'http://127.0.0.1:8888', `实际 ${e2.NOVELSTUDIO_BASE_URL}`);
}

console.log('\n【4. 不得丢掉原有语义】');
{
  const e = harnessChildEnv({ port: 3741, peerId: 'peer-x', baseEnv: { PATH: '/usr/bin', NOVELSTUDIO_OV_DISABLED: '1' } });
  ok('OPENVIKING_PEER_ID 仍被下发', e.OPENVIKING_PEER_ID === 'peer-x');
  ok('基础环境的其它变量被继承（PATH）', e.PATH === '/usr/bin');
  ok('基础环境的其它变量被继承（NOVELSTUDIO_OV_DISABLED）', e.NOVELSTUDIO_OV_DISABLED === '1');
  ok('调用方 env 的其它键也能透传', harnessChildEnv({ port: 1, peerId: 'p', baseEnv: {}, env: { NOVELSTUDIO_WORK_ID: '7' } }).NOVELSTUDIO_WORK_ID === '7');
}

console.log('\n【5. selfBaseUrl 自身】');
{
  ok('selfBaseUrl(3741)', selfBaseUrl(3741) === 'http://127.0.0.1:3741');
  ok('selfBaseUrl 收到非法值 → 退默认', selfBaseUrl('abc') === `http://127.0.0.1:${DEFAULT_PORT}`);
}

console.log('\n【6. 决策 B：写作任务的专用 DSH_HOME】');
{
  // 用临时目录造一个"可用/不可用"的 home，避免依赖本机真实状态。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novelhome-test-'));
  const usable = path.join(tmp, 'usable');
  fs.mkdirSync(path.join(usable, 'profiles'), { recursive: true });
  const unusable = path.join(tmp, 'unusable');
  fs.mkdirSync(unusable, { recursive: true });

  ok('默认路径是 ~/.dsh-novel（与 ~/.dsh 平级）',
    dedicatedHomePath({}) === path.join(os.homedir(), DEFAULT_DEDICATED_HOME), dedicatedHomePath({}));
  ok('可用环境变量覆盖', dedicatedHomePath({ [DEDICATED_HOME_ENV]: 'D:/x' }) === 'D:/x');
  ok('空字符串不算覆盖（退默认）', dedicatedHomePath({ [DEDICATED_HOME_ENV]: '  ' }) === path.join(os.homedir(), DEFAULT_DEDICATED_HOME));

  ok('含 profiles/ 才算可用', dedicatedHomeUsable(usable) === true);
  ok('不含 profiles/ 判为不可用（否则 dsh 会找不到 profile 而起不来）', dedicatedHomeUsable(unusable) === false);
  ok('路径不存在也判为不可用（不抛异常）', dedicatedHomeUsable(path.join(tmp, 'nope')) === false);

  ok('可用时 resolveTaskDshHome 返回该路径', resolveTaskDshHome({ [DEDICATED_HOME_ENV]: usable }) === usable);
  ok('不可用时返回 null（= 沿用共享 home，即改动前行为）',
    resolveTaskDshHome({ [DEDICATED_HOME_ENV]: unusable }) === null);
  ok('路径不存在时也返回 null', resolveTaskDshHome({ [DEDICATED_HOME_ENV]: path.join(tmp, 'nope') }) === null);

  // 下发给子进程
  const eOk = harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: { [DEDICATED_HOME_ENV]: usable } });
  ok('可用时把 DSH_HOME 下发给子进程', eOk.DSH_HOME === usable, `实际 ${eOk.DSH_HOME}`);
  const eNo = harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: { [DEDICATED_HOME_ENV]: unusable } });
  ok('不可用时**不设** DSH_HOME（退回共用，不把任务打挂）', eNo.DSH_HOME === undefined, `实际 ${eNo.DSH_HOME}`);
  const eBase = harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: { DSH_HOME: 'C:/somewhere-else' } });
  // ⚠️ 这条断言的方向是**故意的**：实测 `DSH_HOME` 会随启动方式变——从 DSH 派生的终端
  // 启动工坊时环境里已经带着它，从桌面快捷方式启动时没有。若让"继承环境"说了算，
  // 同一份代码就会看启动方式决定行为。所以专用 home **覆盖**它，并把这件事显式报出来。
  ok('专用 home **有意覆盖**环境里已有的 DSH_HOME（不看启动方式决定行为）',
    eBase.DSH_HOME === path.join(os.homedir(), DEFAULT_DEDICATED_HOME), `实际 ${eBase.DSH_HOME}`);
  ok('覆盖这件事是可观测的（taskHomeInfo 会报 overridesAmbient）',
    taskHomeInfo({ DSH_HOME: 'C:/somewhere-else' }).overridesAmbient === true);
  ok('专用 home 不存在时不做覆盖（退回继承环境，= 改动前行为）',
    harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: { DSH_HOME: 'C:/keep-me', [DEDICATED_HOME_ENV]: unusable } }).DSH_HOME === 'C:/keep-me');
  const eCaller = harnessChildEnv({ port: 3737, peerId: 'p', baseEnv: { [DEDICATED_HOME_ENV]: usable }, env: { DSH_HOME: 'C:/caller-wins' } });
  ok('调用方显式给的 DSH_HOME 优先级最高（与本模块其它变量同一约定）',
    eCaller.DSH_HOME === 'C:/caller-wins', `实际 ${eCaller.DSH_HOME}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n【7. 接线：harness.js 的设置文件必须跟着专用 home 走】');
{
  // ⚠️ 2026-09-18 修正：这一段原本**按源码形状**匹配旧常量名 `DSH_SETTINGS`，于是在把它改成
  // 函数 `dshSettingsPath()`（每次现算）之后，断言就静默失效了——形状断言在无害重构后假失败
  // 会磨损红灯信任（本项目记过这条）。现在改成**语义断言**：真调那个函数，看它跟随哪一层。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-settings-'));
  const home = path.join(root, 'dsh-novel');
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true });
  const prevHome = process.env.NOVELSTUDIO_DSH_HOME;
  const prevSettings = process.env.DSH_SETTINGS;
  try {
    delete process.env.DSH_SETTINGS;
    process.env.NOVELSTUDIO_DSH_HOME = home;
    ok('专用 home 生效时，设置文件指向该 home（否则回退路径改的是 GUI 的 settings.yaml）',
      dshSettingsPath() === path.join(home, 'settings.yaml'), dshSettingsPath());
    process.env.DSH_SETTINGS = path.join(root, 'explicit.yaml');
    ok('显式设 DSH_SETTINGS 时仍最高优先', dshSettingsPath() === path.join(root, 'explicit.yaml'), dshSettingsPath());
  } finally {
    if (prevHome === undefined) delete process.env.NOVELSTUDIO_DSH_HOME; else process.env.NOVELSTUDIO_DSH_HOME = prevHome;
    if (prevSettings === undefined) delete process.env.DSH_SETTINGS; else process.env.DSH_SETTINGS = prevSettings;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n【8. 接线：审计工具必须能看见专用 home，否则总闸会变瞎】');
{
  const src = fs.readFileSync(new URL('./audit-llm-calls.mjs', import.meta.url), 'utf8');
  ok('导出了 harnessHomes()', /export function harnessHomes\(/.test(src));
  ok('扫描列表里含专用 home', /\.dsh-novel/.test(src));
  ok('每行标注来自哪个 home（"看不见"不能伪装成"没发生"）', /home: path\.basename/.test(src));
}

console.log(`\n══════════════════════════════`);
console.log(`harness 子进程环境测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
