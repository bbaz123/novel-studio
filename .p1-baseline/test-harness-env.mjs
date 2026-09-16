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
import { harnessChildEnv, selfBaseUrl, DEFAULT_PORT } from '../ai/harness-env.mjs';

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

console.log(`\n══════════════════════════════`);
console.log(`harness 子进程环境测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
