#!/usr/bin/env node
/**
 * P6 前置验证：`NOVELSTUDIO_DSH_PROFILE` 是否真的作用在**实际 spawn 路径**上。
 *
 * 为什么必须单独验：P6 的全部动作就是把 `harness.js` 的默认 profile 从 headless 翻到 novel。
 * 如果这个环境变量在真实调用链上不起作用，切换就是静默无效——而 dump-config 证明不了它，
 * 它只组合配置、不启动任务。
 *
 * 判据（不产生任何 API 费用：把 LLM 端点指向本机死端口）：
 *   - 不存在的 profile  → 任务必须**失败**，且错误指向 profile 解析
 *   - 存在的 profile    → 任务必须**走到 LLM 调用**（报 TRANSPORT），说明 profile 已解析成功
 *
 * 用法: node verify-harness-profile.mjs [要验证的 profile 名...]
 */
// ⚠️ 必须在 import harness.js **之前**把数据目录指向临时目录。
// 原因（本工具踩过）：harness.js → logger.js 会按 NOVELSTUDIO_DATA_DIR 解析数据目录，
// 未设置时默认就是项目里的 `data/`——于是导入 harness.js 就会往**真实数据目录**写
// data/logs/app-YYYY-MM-DD.log。这不是"只读探测"该有的副作用。
process.env.NOVELSTUDIO_DATA_DIR = process.env.NOVELSTUDIO_DATA_DIR || '.p0-recon/scratch-data';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'; // 死端口：不出网、不花钱

const profiles = process.argv.slice(2).length ? process.argv.slice(2) : ['no-such-profile-xyz', 'novel'];

/** 按错误内容判定这次失败发生在哪一环。 */
function classify(message) {
  const m = String(message || '');
  if (/cannot resolve profile bundle|does not exist|Unknown profile|profile .* not found/i.test(m)) return 'profile';
  if (/TRANSPORT/i.test(m)) return 'llm';
  return 'other';
}

const results = [];
for (const profile of profiles) {
  process.env.NOVELSTUDIO_DSH_PROFILE = profile;
  // 每次都要重新加载 harness.js：DSH_PROFILE 在模块加载时解析一次
  const mod = await import(`../harness.js?profile=${encodeURIComponent(profile)}`);
  const started = Date.now();
  let outcome;
  try {
    const out = await mod.runHarnessTask('Reply with the single word: ok', { timeout: 120000 });
    outcome = { ok: true, message: String(out).slice(0, 160), stderr: '' };
  } catch (e) {
    // readableErrorMessage 只取 stderr 的第一行（可能是 "file.ts:379" 这种栈位置），
    // 真正的原因在后面——分类必须同时看 message 与完整 stderr，否则会误判为 other。
    outcome = { ok: false, message: e.message, stderr: String(e.stderr || '') };
  }
  const stage = outcome.ok ? 'success' : classify(`${outcome.message}\n${outcome.stderr}`);
  results.push({
    profile, resolved: mod.DSH_PROFILE, stage, ms: Date.now() - started,
    message: outcome.message.slice(0, 120),
    reason: (outcome.stderr.split(/\r?\n/).find((l) => /Error:|must be|not found|TRANSPORT/.test(l)) || '').trim().slice(0, 160)
  });
}

console.log('环境：DEEPSEEK_BASE_URL=http://127.0.0.1:1（死端口，零成本）\n');
let bad = 0;
for (const r of results) {
  const expected = r.profile === 'novel' ? 'llm' : 'profile';
  const pass = r.stage === expected;
  if (!pass) bad++;
  console.log(`  ${pass ? '✓' : '✗'} NOVELSTUDIO_DSH_PROFILE=${r.profile}`);
  console.log(`      harness 解析出的 profile = ${r.resolved}`);
  console.log(`      失败发生在：${r.stage}（期望 ${expected}）  耗时 ${r.ms}ms`);
  console.log(`      错误：${r.message}`);
  if (r.reason) console.log(`      原因：${r.reason}`);
  console.log('');
}
console.log(bad === 0
  ? '结论: ✓ profile 参数在真实 spawn 路径上生效（不存在的 profile 失败、存在的 profile 走到 LLM 调用）'
  : `结论: ✗ ${bad} 个用例不符合预期`);
process.exitCode = bad ? 1 : 0;
