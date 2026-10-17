/**
 * tests/nsdsh/tool-capabilities.test.mjs —— S09：工具能力表（修 F11）。
 *
 * 验收要求"隐藏工具名后仍无法直接调用执行器"，因此能力表必须满足三件事：
 *   ① 与**真实注册的工具**逐一对齐（多一个少一个都算漂移）；
 *   ② **失败关闭**：表里没有的名字一律拒绝，不默认放行；
 *   ③ 插件真的在每个工具执行前过这道判定（表不是装饰）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const C = await import('../../harness-plugins/novel-writing/capabilities.mjs');

const toolsSrc = fs.readFileSync(path.join(REPO, 'harness-plugins/novel-writing/novel-tools.mjs'), 'utf8');
const registered = [...toolsSrc.matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]);

suite('nsdsh/tool-capabilities', [
  ['S09-T1 能力表与真实注册的工具完全对齐（不多不少）', () => {
    const inTable = Object.keys(C.TOOL_CAPABILITIES);
    const missing = registered.filter((n) => !inTable.includes(n));
    const extra = inTable.filter((n) => !registered.includes(n));
    assert.deepEqual(missing, [], `能力表缺少已注册工具：${missing.join(', ')}`);
    assert.deepEqual(extra, [], `能力表里有不存在的工具：${extra.join(', ')}`);
    assert.ok(registered.length >= 26, `注册工具数 ${registered.length}`);
  }],

  ['S09-T2 自检：每个 AUTHOR_CONFIRM 工具都有审批 op，且不会被误标', () => {
    assert.deepEqual(C.selfCheckCapabilities(), [], '能力表自检必须无问题');
    // 三类都必须真实存在（不能全是 read_only 就"通过"）
    const byCap = {};
    for (const name of Object.keys(C.TOOL_CAPABILITIES)) {
      const cap = C.TOOL_CAPABILITIES[name];
      byCap[cap] = (byCap[cap] || 0) + 1;
    }
    for (const cap of C.CAPABILITY_VALUES) {
      assert.ok((byCap[cap] || 0) > 0, `能力 ${cap} 必须有真实工具，实际 ${byCap[cap] || 0} 个`);
    }
  }],

  ['S09-T3 失败关闭：未知工具名一律 UNKNOWN_TOOL（隐藏工具名也拿不到执行器）', () => {
    for (const bogus of ['novel_nonexistent', '', 'novel_state_commit_', 'NOVEL_STATE_COMMIT', 'toString', '__proto__']) {
      const v = C.assertModelCallable(bogus, {});
      assert.equal(v.ok, false, `未知工具 ${JSON.stringify(bogus)} 必须被拒绝`);
      assert.equal(v.code, 'UNKNOWN_TOOL');
    }
    assert.equal(C.capabilityOf('novel_nonexistent'), null);
    // 原型链上的名字不得被当成工具（不能用 hasOwnProperty 之外的方式查表）
    assert.equal(C.capabilityOf('hasOwnProperty'), null);
    assert.equal(C.isKnownTool('valueOf'), false);
  }],

  ['S09-T4 只读工具：无需审批、直接放行', () => {
    const v = C.assertModelCallable('novel_context', { args: { work_id: 1 }, scope: { workId: '1' } });
    assert.equal(v.ok, true);
    assert.equal(v.capability, 'read_only');
    assert.equal(C.requiresAuthorApproval('novel_context'), false);
  }],

  ['S09-T5 提案工具：无需审批（只产候选），但也不是"正式写入"', () => {
    const v = C.assertModelCallable('novel_event_add', { args: { work_id: 1 }, scope: { workId: '1' } });
    assert.equal(v.ok, true);
    assert.equal(v.capability, 'proposal');
    assert.equal(C.requiresAuthorApproval('novel_event_add'), false);
  }],

  ['S09-T6 插件真的在每个工具执行前过判定（表不是装饰）', () => {
    // register() 内部必须调用 assertModelCallable，且在 execute 之前
    const regIdx = toolsSrc.indexOf('function register(name');
    assert.ok(regIdx > 0, '必须仍有 register 工厂');
    const regBody = toolsSrc.slice(regIdx, toolsSrc.indexOf('register(\'novel_works\'', regIdx));
    assert.match(regBody, /assertModelCallable\(name,/, 'register 必须调用统一判定');
    assert.match(regBody, /if \(!verdict\.ok\)/, '判定失败必须抛错（不能继续执行）');
    const checkAt = regBody.indexOf('assertModelCallable(');
    const execAt = regBody.indexOf('await execute(args)');
    assert.ok(checkAt > 0 && execAt > checkAt, '判定必须发生在真正执行之前');
    // 拒绝必须是"预期内结果"，不能被当成插件故障刷错误日志
    assert.match(regBody, /nsReported = true/, '能力拒绝不应被当作插件异常上报');
  }],

  ['S09-T7 只读分类与源码动词一致（防止把写操作误标成只读）', () => {
    // 从源码里提取每个工具的 HTTP 动词，写操作必须不是 read_only
    const starts = [...toolsSrc.matchAll(/register\('([a-z_]+)'/g)].map((m) => ({ at: m.index, name: m[1] }));
    const mutating = [];
    for (let i = 0; i < starts.length; i += 1) {
      const s = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1].at : toolsSrc.length;
      const block = toolsSrc.slice(s.at, e);
      const verbs = new Set([...block.matchAll(/method:\s*'(POST|PUT|DELETE)'/g)].map((m) => m[1]));
      if (verbs.size) mutating.push(s.name);
    }
    assert.ok(mutating.length > 0, '应当存在会发写请求的工具');
    const wronglyReadOnly = mutating.filter((n) => C.capabilityOf(n) === C.CAPABILITY.READ_ONLY
      // 允许的例外：POST 只用于传复杂查询参数、服务端不落正式状态的分析类工具
      && !['novel_consistency', 'novel_scan', 'novel_preflight', 'novel_validate', 'novel_review'].includes(n));
    assert.deepEqual(wronglyReadOnly, [], `这些工具会发写请求却被标成 read_only：${wronglyReadOnly.join(', ')}`);
  }],
]);
