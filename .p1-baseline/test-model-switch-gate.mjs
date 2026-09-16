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

const { requiresModelSwitchGate, withModelSwitch, willWaitForModelSlot, modelSwitchLoad, DSH_PROFILE } = await import('../harness.js');

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

console.log('\n【5. 排队必须可观测（决策 D4：界面不能把"在等槽位"显示成"运行中"）】');
{
  ok('空闲时 load = busy:false / waiters:0',
    modelSwitchLoad().busy === false && modelSwitchLoad().waiters === 0, JSON.stringify(modelSwitchLoad()));
  ok('空闲时不会误报"要排队"', willWaitForModelSlot(true) === false);
  ok('不请求模型/强度的任务永不排队（否则并行任务会被误报等待中）',
    willWaitForModelSlot(false) === false);

  let release = null;
  const held = withModelSwitch(() => new Promise((r) => { release = r; }));
  await new Promise((s) => setTimeout(s, 30));
  ok('有任务持有槽位时 busy=true', modelSwitchLoad().busy === true, JSON.stringify(modelSwitchLoad()));
  ok('此时"要排队"判断为真', willWaitForModelSlot(true) === true);
  ok('但并行（不切模型）任务仍不排队', willWaitForModelSlot(false) === false);

  const queued = withModelSwitch(async () => 'second');
  await new Promise((s) => setTimeout(s, 30));
  ok('第二个任务进入排队 → waiters=1', modelSwitchLoad().waiters === 1, JSON.stringify(modelSwitchLoad()));

  release('first');
  const [r1, r2] = await Promise.all([held, queued]);
  ok('两个任务都正常完成', r1 === 'first' && r2 === 'second', `${r1} / ${r2}`);
  await new Promise((s) => setTimeout(s, 20));
  ok('全部结束后负载归零（计数不泄漏）',
    modelSwitchLoad().busy === false && modelSwitchLoad().waiters === 0, JSON.stringify(modelSwitchLoad()));
}

console.log('\n【6. 与调用点的一致性（静态）】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../harness.js', import.meta.url), 'utf8');
  const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok('调用点用的是这个纯函数（不是另写一份判断）',
    /const needsSettingsSwitch = requiresModelSwitchGate\(options\.model, reasoningEffort\);/.test(src));
  // 决策 D8-#2 改写了这里的契约：进不进互斥不再等于"要不要切模型"，
  // 而是"**有没有成功建起每任务独立 settings**"。走 --patch 的任务不碰全局状态，
  // 所以可以真并行；只有回退路径才需要串行化。
  ok('进互斥的条件是 willSerialize，而不是 needsSettingsSwitch（否则吞吐仍被无条件压成 1）',
    /return willSerialize \? withModelSwitch\(runTask\) : runTask\(\);/.test(src));
  ok('willSerialize 只对"回退路径"为真（needsSettingsSwitch 且没建起每任务 settings）',
    /const willSerialize = needsSettingsSwitch && !taskSettings;/.test(src));
  ok('决策发生在**上报排队之前**（否则会对不需要排队的任务谎报"在排队"）',
    src.indexOf('const willSerialize =') > 0
    && src.indexOf('const willSerialize =') < src.indexOf("onPhase('waiting-model'"));
  ok('排队判断走的是可单测的纯函数（不是内联条件）',
    /willWaitForModelSlot\(willSerialize\)/.test(src));
  ok('每任务 settings 建立失败时回退到全局改写（可用性不因这次优化变差）',
    /materializeTaskSettings\(\{ model: options\.model, reasoningEffort \}\)/.test(src)
    && /needsSettingsSwitch && !taskSettings && originalSettings != null/.test(src));
  ok('临时目录一定会被清理（里面是用户 settings 的副本）',
    /cleanupTaskSettings\(taskSettings\)/.test(src));
  ok('开跑时会再上报一次 running（界面据此切回正常）',
    /options\.onPhase\('running'/.test(src));
  ok('作业设施接上了 onPhase 并把等待写进 stage',
    /onPhase: \(phase, info\) => \{/.test(srv) && /等待模型槽位/.test(srv));
  ok('作业设施把模型槽位状态挂在作业上', /model_slot = 'waiting'/.test(srv) && /model_slot = 'running'/.test(srv));
  ok('/harness/status 暴露了 model_load', /model_load: modelSwitchLoad\(\)/.test(srv));
  ok('当前默认 profile 可读（顺带确认 import 成功）', typeof DSH_PROFILE === 'string' && DSH_PROFILE.length > 0,
    String(DSH_PROFILE));
}

console.log(`\n══════════════════════════════`);
console.log(`模型切换互斥离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
