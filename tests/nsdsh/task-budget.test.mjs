/**
 * tests/nsdsh/task-budget.test.mjs —— S10：任务预算（总请求数 / 总 token / 期限）与信封不可变。
 *
 * S10 动作 7 点名的坑：**只限制每次输出 token，却允许无限次 agent 请求**。
 * 每次都合规、总量失控，是最难发现的一种超支。所以预算必须同时管三件事：
 *   ① 总请求数；② 总 token；③ 硬期限 —— 且**越界抛异常**，不是静默返回 false
 *   （静默 false 会让调用方继续跑，最后变成"超了但没人知道"）。
 * 另外钉住信封**不可变**：任务发出后不得被中途改模型/改作品/放宽预算。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const E = await import('../../ai/model-broker/envelope.mjs');

function makeRoute() {
  return {
    ok: true, purpose: 'analysis', needs_api_key: false, has_api_key: false,
    route: { source: 'work', purpose: 'analysis', api_config_id: 1 },
    config: { id: 1, name: 'fixture', base_url: 'http://127.0.0.1:9/v1', model: 'm', api_key: 'sk-must-not-leak' },
  };
}

suite('nsdsh/task-budget', [
  ['S10-B1 信封不可变：任务发出后不得改模型/作品/预算', () => {
    const env = E.createTaskEnvelope({ workId: 7, purpose: 'analysis', route: makeRoute(), now: () => 1000 });
    assert.ok(Object.isFrozen(env), '信封必须被冻结');
    assert.ok(Object.isFrozen(env.model), 'model 子对象也必须冻结');
    assert.ok(Object.isFrozen(env.budget), 'budget 子对象也必须冻结');
    assert.equal(env.work_id, 7);
    // 严格模式下写入被冻结对象会抛 TypeError（ESM 模块默认严格模式）
    assert.throws(() => { 'use strict'; env.work_id = 999; }, '不得允许中途改作品');
    assert.throws(() => { 'use strict'; env.model.model = 'other'; }, '不得允许中途换模型');
    assert.throws(() => { 'use strict'; env.budget.max_requests = 999; }, '不得允许中途放宽预算');
  }],

  ['S10-B2 信封不得携带 api_key（它会被日志/事件携带）', () => {
    const env = E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), now: () => 0 });
    const serialized = JSON.stringify(env);
    assert.ok(!serialized.includes('sk-must-not-leak'), '信封里绝不能出现密钥明文');
    assert.ok(!serialized.includes('"api_key"'), '信封里不应有 api_key 字段');
    assert.equal(env.model.needs_api_key, false, '只保留"是否需要 key"这一位，不保留 key 本身');
  }],

  ['S10-B3 总请求数封顶：每次都合规但次数无限，必须被拦住', () => {
    const env = E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { maxRequests: 3 }, now: () => 0 });
    const led = E.createBudgetLedger(env, { now: () => 0 });
    assert.equal(led.takeRequest(), 1);
    assert.equal(led.takeRequest(), 2);
    assert.equal(led.takeRequest(), 3);
    let err = null;
    try { led.takeRequest(); } catch (e) { err = e; }
    assert.ok(err, '第 4 次必须被拒');
    assert.equal(err.code, 'MAX_REQUESTS_EXCEEDED');
    assert.equal(err.name, 'BudgetExceeded', '必须是可捕获的类型化异常');
    assert.equal(led.snapshot().requests, 3, '被拒的那一次不得计入');
  }],

  ['S10-B4 总 token 封顶：单次合规、累计超限必须立即抛', () => {
    const env = E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { maxTotalTokens: 100 }, now: () => 0 });
    const led = E.createBudgetLedger(env, { now: () => 0 });
    led.recordUsage({ total_tokens: 60 });
    assert.equal(led.snapshot().total_tokens, 60);
    let err = null;
    try { led.recordUsage({ total_tokens: 60 }); } catch (e) { err = e; }
    assert.ok(err, '累计 120 > 100 必须抛');
    assert.equal(err.code, 'MAX_TOTAL_TOKENS_EXCEEDED');
    // 缺 total 时用 prompt+completion 相加，不能当成 0（否则等于不记账）
    const led2 = E.createBudgetLedger(E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { maxTotalTokens: 10 }, now: () => 0 }), { now: () => 0 });
    assert.throws(() => led2.recordUsage({ prompt_tokens: 8, completion_tokens: 8 }), /MAX_TOTAL_TOKENS_EXCEEDED/,
      '必须能从 prompt+completion 推出总量');
  }],

  ['S10-B5 期限：超时必须抛 DEADLINE_EXCEEDED（连请求都不该发出去）', () => {
    let t = 0;
    const env = E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { deadlineMs: 1000 }, now: () => t });
    const led = E.createBudgetLedger(env, { now: () => t });
    t = 500;
    assert.equal(led.takeRequest(), 1, '期限内可以发');
    t = 1500; // 超过 1000ms 期限
    let err = null;
    try { led.takeRequest(); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'DEADLINE_EXCEEDED');
    assert.equal(led.snapshot().requests, 1, '超期后不得再占名额');
  }],

  ['S10-B6 创建时就拒绝不成立的输入（不静默用默认值兜底）', () => {
    // 没有路由（NO_ROUTE）不能造信封 —— 否则等于"没模型也假装能跑"
    assert.throws(() => E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: { ok: false, reason: 'NO_ROUTE' } }), /UNROUTABLE:NO_ROUTE/);
    assert.throws(() => E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: null }), /MISSING_ROUTE/);
    // 非法的预算值不得被"宽容"成默认值
    assert.throws(() => E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { maxRequests: 0 } }), /INVALID_MAX_REQUESTS/);
    assert.throws(() => E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { maxRequests: -1 } }), /INVALID_MAX_REQUESTS/);
    assert.throws(() => E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), budget: { deadlineMs: 1.5 } }), /INVALID_DEADLINE_MS/);
  }],

  ['S10-B7 默认预算存在且是有限值（没有"无限"这一档）', () => {
    assert.ok(Number.isSafeInteger(E.DEFAULT_BUDGET.maxRequests) && E.DEFAULT_BUDGET.maxRequests > 0);
    assert.ok(Number.isSafeInteger(E.DEFAULT_BUDGET.maxTotalTokens) && E.DEFAULT_BUDGET.maxTotalTokens > 0);
    assert.ok(Number.isSafeInteger(E.DEFAULT_BUDGET.deadlineMs) && E.DEFAULT_BUDGET.deadlineMs > 0);
    const env = E.createTaskEnvelope({ workId: 1, purpose: 'analysis', route: makeRoute(), now: () => 0 });
    assert.equal(env.budget.max_requests, E.DEFAULT_BUDGET.maxRequests);
    assert.ok(env.budget.max_requests <= 100, '默认请求数必须是"可解释的小数字"，不能等于无限');
  }],
]);
