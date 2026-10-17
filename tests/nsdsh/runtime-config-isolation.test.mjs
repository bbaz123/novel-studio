/**
 * tests/nsdsh/runtime-config-isolation.test.mjs —— S12：**配置扩权必须失败关闭**。
 *
 * S12 动作 5：审计全部配置覆盖层，禁止外部 home patch 意外扩权。
 * 这是"叠加式配置"最危险的失效模式：我们写了一堆 `disabled: true`，
 * 然后某个 home patch 把它们逐个打开，或者加一个没审计过的工具 ——
 * 而所有功能测试仍然绿（它们测行为，不测能力面）。
 *
 * 因此判据必须是**失败关闭**：只要有一层在扩权，整体就是 `DENY`，不是"警告后继续"。
 */
import assert from 'node:assert/strict';
import { suite } from '../temporal/harness.mjs';

const P = await import('../../harness-plugins/novel-writing/profile.mjs');

suite('nsdsh/runtime-config-isolation', [
  ['S12-I1 重新启用我们已禁用的组件 → DENY（不是警告）', () => {
    const r = P.auditPatchLayers([
      { name: 'base', disable: ['tool-pwsh'] },
      { name: 'sneaky-home', enable: ['tool-pwsh'] },
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.decision, 'DENY');
    assert.deepEqual(r.failed_layers, ['sneaky-home']);
    const problem = r.layers.find((l) => l.layer === 'sneaky-home').problems[0];
    assert.equal(problem.code, 'REENABLES_DISABLED_COMPONENT');
    assert.equal(problem.component, 'tool-pwsh');
  }],

  ['S12-I2 加入未知工具 → DENY；加入已知只读/提案工具 → 允许', () => {
    const rogue = P.auditPatchLayers([{ name: 'rogue', addTools: ['totally_new_tool'] }]);
    assert.equal(rogue.decision, 'DENY');
    assert.equal(rogue.layers[0].problems[0].code, 'UNKNOWN_TOOL_EXPANSION');

    const ok = P.auditPatchLayers([{ name: 'fine', addTools: ['read', 'novel_context', 'novel_event_add'] }]);
    assert.equal(ok.decision, 'ALLOW', '只读/提案类工具被外部层启用是允许的');
  }],

  ['S12-I3 外部层不得"启用"作者确认类工具（必须走审批通道，而不是配置开关）', () => {
    const r = P.auditPatchLayers([{ name: 'home', addTools: ['novel_state_commit'] }]);
    assert.equal(r.decision, 'DENY');
    assert.equal(r.layers[0].problems[0].code, 'EXTERNAL_ENABLE_OF_AUTHOR_CONFIRM_TOOL');
    // novel_chapter_save 同理
    const r2 = P.auditPatchLayers([{ name: 'home2', addTools: ['novel_chapter_save'] }]);
    assert.equal(r2.decision, 'DENY');
  }],

  ['S12-I4 缩权（仅 disable）永远允许，不被误判为扩权', () => {
    const r = P.auditPatchLayers([
      { name: 'a', disable: ['tool-todo'] },
      { name: 'b', disable: ['tool-goal', 'tool-jobs'] },
      { name: 'c' }, // 空层
    ]);
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.ok, true);
    assert.deepEqual(r.failed_layers, []);
    for (const l of r.layers) assert.equal(l.ok, true);
  }],

  ['S12-I5 多层混合：只要有一层扩权，整体 DENY（fail-closed 的传播）', () => {
    const r = P.auditPatchLayers([
      { name: 'clean-1', disable: ['tool-web'] },
      { name: 'bad', enable: ['tool-subagent'], addTools: ['unknown_x', 'novel_state_commit'] },
      { name: 'clean-2', disable: ['tool-todo'] },
    ]);
    assert.equal(r.decision, 'DENY');
    assert.deepEqual(r.failed_layers, ['bad']);
    // 同一层里的**每一类**问题都要报出来（不能只报一个就停）：
    //   tool-subagent 重新启用 / unknown_x 未知工具 / novel_state_commit 作者确认类被外部启用
    const codes = r.layers.find((l) => l.layer === 'bad').problems.map((p) => p.code).sort();
    assert.deepEqual(codes, [
      'EXTERNAL_ENABLE_OF_AUTHOR_CONFIRM_TOOL',
      'REENABLES_DISABLED_COMPONENT',
      'UNKNOWN_TOOL_EXPANSION',
    ], `实际报出的问题：${codes.join(',')}`);
    // 干净层各自仍然是 ok
    assert.equal(r.layers.find((l) => l.layer === 'clean-1').ok, true);
  }],

  ['S12-I6 我们自己的 patch 层本身必须通过审计（不得自相矛盾）', () => {
    const disabled = P.disabledComponents();
    // 我们的 patch 只是 disable，不 enable、不加工具 → 必须 ALLOW
    const ours = P.auditPatchLayers([{ name: 'our-patch', disable: disabled }]);
    assert.equal(ours.decision, 'ALLOW', '我们自己的 patch 不构成扩权');
    // 而"把我们的禁用项原样打开"必须 DENY
    const undo = P.auditPatchLayers([{ name: 'undo', enable: disabled.slice(0, 3) }]);
    assert.equal(undo.decision, 'DENY');
  }],
]);
