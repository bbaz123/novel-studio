/**
 * tests/nsdsh/effective-tools.test.mjs —— S12 核心验收：
 * **模型实际拿到的工具集合与审批允许集合一致**。
 *
 * 这条不变量把 S09（能力表 = 作者允许什么）与 S12（profile = 模型实际看到什么）缝在一起：
 * 任何一边多一个或少一个工具，都会在这里红。这也是最容易悄悄出错的地方 ——
 * 功能测试全绿，但模型多了一个能改正式状态的工具。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const P = await import('../../harness-plugins/novel-writing/profile.mjs');
const C = await import('../../harness-plugins/novel-writing/capabilities.mjs');

const toolsSrc = fs.readFileSync(path.join(REPO, 'harness-plugins/novel-writing/novel-tools.mjs'), 'utf8');
const registered = [...new Set([...toolsSrc.matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]))].sort();

suite('nsdsh/effective-tools', [
  ['S12-E1 有效工具集合 = 小说工具（能力表）+ 保留的通用工具（无第三个来源）', () => {
    const eff = P.effectiveTools();
    const expected = [...new Set([...Object.keys(C.TOOL_CAPABILITIES), ...P.GENERIC_TOOLS])].sort();
    assert.deepEqual(eff, expected, '有效集合不得有来源之外的工具');
    assert.equal(eff.length, Object.keys(C.TOOL_CAPABILITIES).length + P.GENERIC_TOOLS.length);
    // 去重：不得出现重复项
    assert.equal(new Set(eff).size, eff.length);
  }],

  ['S12-E2 注册的小说工具与能力表**逐项一致**（多一个少一个都红）', () => {
    const cmp = P.assertToolsMatchCapabilityTable(registered);
    assert.deepEqual(cmp.not_covered_by_capabilities, [], `这些工具没有进能力表：${cmp.not_covered_by_capabilities.join(',')}`);
    assert.deepEqual(cmp.in_capabilities_but_not_registered, [], `能力表里有但没注册：${cmp.in_capabilities_but_not_registered.join(',')}`);
    assert.equal(cmp.allowed_count, cmp.registered_count);
    assert.equal(cmp.ok, true);
  }],

  ['S12-E3 模型可见集合里不得出现"可改正式状态"却未被标记的工具', () => {
    // 每个 novel_* 工具都必须能在能力表里查到能力
    for (const t of P.novelTools()) {
      const cap = C.capabilityOf(t);
      assert.ok(cap, `${t} 必须有能力分级`);
      assert.ok(C.CAPABILITY_VALUES.includes(cap), `${t} 的能力值必须合法`);
    }
    // 通用文件工具不属于小说能力表（它们是别的东西），必须**不在**表里
    for (const t of P.GENERIC_TOOLS) {
      assert.equal(C.capabilityOf(t), null, `${t} 不应被当成 novel 工具进能力表`);
    }
  }],

  ['S12-E4 作者确认类工具必须仍要求审批（不能被 profile"顺便"放行）', () => {
    const authorTools = P.novelTools().filter((t) => C.requiresAuthorApproval(t));
    assert.ok(authorTools.length >= 3, `应有若干个作者确认类工具，实际 ${authorTools.length}`);
    for (const t of authorTools) {
      // 缺审批必须被拒（能力表层面的真实判定，不是读文本）
      const v = C.assertModelCallable(t, { args: { work_id: 1, action: 'apply' }, scope: { workId: '1' } });
      assert.equal(v.ok, false, `${t} 缺审批时必须拒绝`);
      assert.equal(v.code, 'APPROVAL_REQUIRED');
    }
  }],

  ['S12-E5 通用工具白名单是封闭的：加工具必须改白名单（不放任外扩）', () => {
    assert.equal(Object.isFrozen(P.GENERIC_TOOLS), true, 'GENERIC_TOOLS 应当冻结');
    // 有效集合里，除小说工具外的每一条都必须在通用白名单里
    const extras = P.effectiveTools().filter((t) => !Object.prototype.hasOwnProperty.call(C.TOOL_CAPABILITIES, t));
    for (const t of extras) {
      assert.ok(P.GENERIC_TOOLS.includes(t), `${t} 不在通用白名单里，却出现在有效集合中`);
    }
  }],
]);
