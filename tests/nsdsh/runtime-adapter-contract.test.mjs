/**
 * tests/nsdsh/runtime-adapter-contract.test.mjs —— S10：direct / legacy 遵守同一结果契约。
 *
 * S10 验收："direct / legacy 遵守同一结果契约"。因此本套件对**两个适配器跑同一批输入**，
 * 逐条断言：形状一致、自洽（ok 只能配 done）、**失败不抛异常**、
 * 且 `not_run`（没有模型）与 `failed`（模型坏了）必须分开。
 */
import assert from 'node:assert/strict';
import { suiteAsync } from '../temporal/harness.mjs';

const A = await import('../../ai/model-broker/adapters.mjs');
const E = await import('../../ai/model-broker/envelope.mjs');

function makeEnvelope(overrides = {}) {
  return E.createTaskEnvelope({
    workId: 1, purpose: 'analysis',
    route: {
      ok: true, purpose: 'analysis', needs_api_key: false,
      route: { source: overrides.source || 'work', purpose: 'analysis', api_config_id: 1 },
      config: { id: 1, name: 'fixture', base_url: 'http://127.0.0.1:9/v1', model: 'm-fixture', api_key: '' },
    },
    now: () => 1_000_000,
  });
}

await suiteAsync('nsdsh/runtime-adapter-contract', [
  ['S10-C1 成功路径：direct 与 legacy 产出**同一形状**', async () => {
    const env = makeEnvelope();
    const direct = A.createDirectAdapter({ callAI: async () => ({ text: '{"events":[]}', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) });
    const legacy = A.createLegacyAdapter({ runLegacy: async () => ({ ok: true, text: '{"events":[]}', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }) });
    const d = await direct.run(env, { messages: [{ role: 'user', content: 'x' }] });
    const l = await legacy.run(env, { prompt: 'x' });
    for (const r of [d, l]) {
      assert.deepEqual(A.assertResultContract(r), [], `契约问题：${A.assertResultContract(r).join(',')}`);
      assert.equal(r.ok, true);
      assert.equal(r.status, 'done');
      assert.equal(r.text, '{"events":[]}');
      assert.equal(r.usage.total_tokens, 7);
    }
    assert.equal(d.contract, l.contract, '两个适配器的契约版本必须一致');
    assert.equal(d.provider, 'direct');
    assert.equal(l.provider, 'legacy');
  }],

  ['S10-C2 失败不抛异常：两个适配器都返回 ok:false 的对象', async () => {
    const env = makeEnvelope();
    const direct = A.createDirectAdapter({ callAI: async () => { throw new Error('provider unavailable'); } });
    const legacy = A.createLegacyAdapter({ runLegacy: async () => { throw new Error('provider unavailable'); } });
    for (const [name, r] of [['direct', await direct.run(env, { messages: [] })], ['legacy', await legacy.run(env, { prompt: '' })]]) {
      assert.equal(r.ok, false, `${name} 失败时 ok 必须为 false`);
      assert.equal(r.status, 'failed', `${name} 失败时状态必须是 failed`);
      assert.match(r.error, /provider unavailable/, `${name} 必须保留错误信息`);
      assert.deepEqual(A.assertResultContract(r), [], `${name} 失败结果也必须满足契约`);
    }
  }],

  ['S10-C3 not_run（没有模型）与 failed（模型坏了）必须分开', async () => {
    const env = makeEnvelope();
    const legacyNotRun = A.createLegacyAdapter({ runLegacy: async () => ({ status: 'not_run', reason: '未配置模型' }) });
    const r = await legacyNotRun.run(env, { prompt: 'x' });
    assert.equal(r.status, 'not_run');
    assert.equal(r.ok, false);
    assert.match(r.error, /未配置模型/);

    const legacyFailed = A.createLegacyAdapter({ runLegacy: async () => ({ ok: false, error: '500 internal' }) });
    const f = await legacyFailed.run(env, { prompt: 'x' });
    assert.equal(f.status, 'failed');
    assert.notEqual(f.status, r.status, '两种失败必须可区分（否则无法决定"重试"还是"提示去配置"）');
  }],

  ['S10-C4 ok 与 status 必须自洽：ok:true 只允许配 done', () => {
    assert.equal(A.makeResult({ ok: true, status: 'done' }).ok, true);
    assert.equal(A.makeResult({ ok: true, status: 'failed' }).ok, false, 'ok:true + failed 必须被归一化为 ok:false');
    assert.equal(A.makeResult({ ok: false, status: 'done' }).status, 'done');
    assert.equal(A.makeResult({ ok: false, status: 'done' }).ok, false, 'done 但 ok:false 保持 ok:false');
    assert.equal(A.makeResult({ ok: true, status: 'nonsense' }).status, 'unknown', '未知状态归为 unknown');
  }],

  ['S10-C5 usage 归一化：缺 total 时用 prompt+completion 补齐；字符串输入也能被接受', async () => {
    const env = makeEnvelope();
    const direct = A.createDirectAdapter({ callAI: async () => 'plain-text-result' });
    const r = await direct.run(env, { messages: [] });
    assert.equal(r.text, 'plain-text-result', '字符串返回要被接受');
    assert.equal(r.ok, true);

    const withUsage = A.makeResult({ ok: true, status: 'done', usage: { prompt_tokens: 5, completion_tokens: 6 } });
    assert.equal(withUsage.usage.total_tokens, 11, '缺 total 时必须由 prompt+completion 补齐');
    const noUsage = A.makeResult({ ok: true, status: 'done' });
    assert.equal(noUsage.usage, null, '没有 usage 时必须是 null，而不是伪造 0');
  }],

  ['S10-C6 legacy 返回不可识别形状 → unknown（不得当成成功）', async () => {
    const env = makeEnvelope();
    const legacy = A.createLegacyAdapter({ runLegacy: async () => 42 });
    const r = await legacy.run(env, { prompt: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'unknown', `实际 ${r.status}`);
    assert.deepEqual(A.assertResultContract(r), []);
  }],

  ['S10-C7 pickAdapter 按路由来源选择，且不伪造来源', () => {
    const direct = { kind: 'direct' };
    const legacy = { kind: 'legacy' };
    const workEnv = makeEnvelope({ source: 'work' });
    assert.equal(A.pickAdapter({ direct, legacy }, workEnv), direct, 'work 来源默认走 direct');
    const legacyEnv = makeEnvelope({ source: 'legacy' });
    assert.equal(A.pickAdapter({ direct, legacy }, legacyEnv), legacy, 'legacy 来源必须走 legacy');
    assert.equal(A.pickAdapter({ legacy }, workEnv), legacy, '没有 direct 时回落 legacy');
    assert.equal(A.pickAdapter({}, workEnv), null, '都没有时返回 null，不造假适配器');
  }],
]);
