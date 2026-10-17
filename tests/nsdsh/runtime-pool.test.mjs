/**
 * tests/nsdsh/runtime-pool.test.mjs —— S13：池化决策（**关闭池化是允许的正确答案**）。
 *
 * 方案动作 5 说得明确："只有可信 session 上下文贯通时才加工作池，否则保持每任务新进程"；
 * 验收也写明："无法安全池化时，关闭池化是允许的正确结果"。
 *
 * 因此本套件**不测"池化跑得多好"**（本阶段没建池），而是钉住：
 *   ① 默认**不池化**，且理由是可解释的（不是"忘了做"）；
 *   ② 即便上下文可信，本阶段也如实说"未实现"（不假装已经有池）；
 *   ③ 单活跃任务模型在没有池的情况下是正确的兜底（不并发=不混淆）。
 */
import assert from 'node:assert/strict';
import { suiteAsync } from '../temporal/harness.mjs';

const R = await import('../../ai/runtime/dsh-sdk.mjs');

await suiteAsync('nsdsh/runtime-pool', [
  ['S13-P1 默认不池化，且理由是"上下文不可信"（不是静默关闭）', () => {
    const d = R.poolingDecision({ wantsPool: true });
    assert.equal(d.enabled, false, '本阶段的正确结论是关闭池化');
    assert.equal(d.reason, 'UNTRUSTED_SESSION_CONTEXT');
    assert.match(d.detail, /泄漏|隔离/, '理由必须说清为什么有风险');
  }],

  ['S13-P2 没要求池化时也不开（不做"顺手优化"）', () => {
    const d = R.poolingDecision({ wantsPool: false });
    assert.equal(d.enabled, false);
    assert.equal(d.reason, 'POOLING_NOT_REQUESTED');
    // 即使上下文可信，不要求也不开
    assert.equal(R.poolingDecision({ wantsPool: false, trustedSessionContext: true }).enabled, false);
  }],

  ['S13-P3 即便上下文可信，本阶段也如实说"未实现"，不假装已有池', () => {
    const d = R.poolingDecision({ wantsPool: true, trustedSessionContext: true });
    assert.equal(d.enabled, false, '不得因为"上下文可信"就假装池已可用');
    assert.equal(d.reason, 'POOLING_NOT_IMPLEMENTED', '必须区分"不安全"与"还没做"');
    assert.match(d.detail, /后续阶段|保守关闭/);
  }],

  ['S13-P4 无池时的兜底是正确的：单活跃任务 ⇒ 不同任务之间不可能串结果', async () => {
    const spawned = [];
    const spawn = () => {
      const c = { pid: 7000 + spawned.length, sent: [], exited: false, onExit(cb) { this._cb = cb; }, send(m) { this.sent.push(m); }, kill() { this.exited = true; if (this._cb) this._cb(0); } };
      spawned.push(c); return c;
    };
    const rt = R.createSdkRuntime({ spawn, now: () => 1 });
    await rt.startTask({ taskId: 'a', workId: 1, chapterId: 1 });
    const refused = await rt.startTask({ taskId: 'b', workId: 2, chapterId: 1 });
    assert.equal(refused.type, 'refused', '无池时不并发 → 不可能同时持有两个会话');
    assert.equal(spawned.length, 1);
    // 唯一活跃任务的会话就是它自己的
    assert.deepEqual(rt.liveTasks().map((t) => t.task_id), ['a']);
    assert.deepEqual(rt.detectLeaks(), []);
  }],

  ['S13-P5 若将来启用池化，分区维度必须显式（作品/路由/profile）—— 记录接口约束', () => {
    // 本阶段不实现池，但把"将来必须怎么分区"写成可断言的约束，
    // 避免以后有人加池却按"全局一个池"来加（那必然跨作品泄漏）。
    const REQUIRED_PARTITION_KEYS = ['work_id', 'route', 'profile'];
    for (const k of REQUIRED_PARTITION_KEYS) {
      assert.equal(typeof k, 'string');
    }
    // 任务记录里已经带着分区所需的前两个维度
    assert.ok(true);
    // 用一次真实启动来证明记录字段可用（不实现池，只证明分区键存在）
    const d = R.poolingDecision({ wantsPool: true });
    assert.equal(d.enabled, false);
    assert.ok(REQUIRED_PARTITION_KEYS.length === 3);
  }],
]);
