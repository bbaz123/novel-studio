#!/usr/bin/env node
/**
 * test-model-switch-gate.mjs —— 模型切换互斥的离线单测（零成本、不 spawn dsh、不发请求）。
 *
 * 为什么要有它：P4 遗留问题「服务端允许 2 并发，但实际吞吐是不是 1」一直只是**论断**。
 * 机制在 harness.js 的两处：
 *   - `requiresModelSwitchGate(model, effort)`：决定这次调用要不要改写 settings.yaml；
 *   - `withModelSwitch(fn)`：需要改写时进入的 promise 链互斥。
 * 两者都能离线跑——**不需要真的调起 dsh**，所以这条结论可以有证据而不是靠读代码。
 *
 * ⚠️ 环境陷阱：import harness.js 会经 logger.js 按 NOVELSTUDIO_DATA_DIR 解析数据目录，
 * 未设置时默认写进项目的 `data/`。所以必须在 import **之前**把它指向临时目录。
 *
 * 用法: node .p1-baseline/test-model-switch-gate.mjs
 */
process.env.NOVELSTUDIO_DATA_DIR = process.env.NOVELSTUDIO_DATA_DIR || '.p0-recon/scratch-data';

const { requiresModelSwitchGate, withModelSwitch, DSH_PROFILE } = await import('../harness.js');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. 闸门判断的真值表（决定吞吐是 1 还是 2）】');
{
  ok('不传 model、不传强度 → 不进互斥（可并行）', requiresModelSwitchGate(undefined, null) === false);
  ok('传 model → 进互斥（串行）', requiresModelSwitchGate('deepseek-flash', null) === true);
  ok('只传强度 → 进互斥（串行）', requiresModelSwitchGate(undefined, 'high') === true);
  ok("强度 'off' 也是真值 → 进互斥（仍要写 settings.yaml）",
    requiresModelSwitchGate(undefined, 'off') === true);
  ok('空字符串 model 视为未传', requiresModelSwitchGate('', null) === false);
  ok('非法强度归一后为 null → 不进互斥（路由已在更早处 400）',
    requiresModelSwitchGate(undefined, null) === false);
}

console.log('\n【2. 互斥体：并发调用必须**不重叠**】');
{
  // 记录每个任务的进入/退出顺序：若发生交错，顺序会变成 1进 2进 1出 2出
  const events = [];
  const mk = (id, ms) => () => new Promise((resolve) => {
    events.push(`${id}进`);
    setTimeout(() => { events.push(`${id}出`); resolve(id); }, ms);
  });
  const results = await Promise.all([
    withModelSwitch(mk('a', 60)),
    withModelSwitch(mk('b', 10)),
    withModelSwitch(mk('c', 5)),
  ]);
  const joined = events.join(' ');
  ok('三个任务全部完成', results.join(',') === 'a,b,c', results.join(','));
  ok('没有交错（严格 a进 a出 b进 b出 c进 c出）',
    joined === 'a进 a出 b进 b出 c进 c出', joined);
  ok('先到先跑（不是按耗时抢跑）', joined.startsWith('a进 a出'), joined);
}

console.log('\n【3. 失败不得卡死队列】');
{
  const events = [];
  const boom = () => { events.push('boom进'); return Promise.reject(new Error('故意失败')); };
  const fine = () => { events.push('fine进'); return Promise.resolve('ok'); };
  const p1 = withModelSwitch(boom).catch((e) => `caught:${e.message}`);
  const p2 = withModelSwitch(fine);
  const r1 = await p1;
  const r2 = await p2;
  ok('失败被调用方捕获', r1 === 'caught:故意失败', String(r1));
  ok('失败之后的调用照常执行（尾部链已恢复）', r2 === 'ok' && events.includes('fine进'), events.join(','));
}

console.log('\n【4. 返回值与错误都要原样透传】');
{
  const v = await withModelSwitch(async () => ({ n: 7 }));
  ok('成功值原样返回', v && v.n === 7);
  let caught = null;
  await withModelSwitch(async () => { throw new Error('原样'); }).catch((e) => { caught = e; });
  ok('异常原样抛出', caught instanceof Error && caught.message === '原样');
}

console.log('\n【5. 与调用点的一致性（静态）】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../harness.js', import.meta.url), 'utf8');
  ok('调用点用的是这个纯函数（不是另写一份判断）',
    /const needsSettingsSwitch = requiresModelSwitchGate\(options\.model, reasoningEffort\);/.test(src));
  ok('不需要切换时**不**进互斥（否则吞吐会无条件退化成 1）',
    /return needsSettingsSwitch \? withModelSwitch\(runTask\) : runTask\(\);/.test(src));
  ok('当前默认 profile 可读（顺带确认 import 成功）', typeof DSH_PROFILE === 'string' && DSH_PROFILE.length > 0,
    String(DSH_PROFILE));
}

console.log(`\n══════════════════════════════`);
console.log(`模型切换互斥离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
