/**
 * tests/nsdsh/author-approval-boundary.test.mjs —— S09：作者确认边界。
 *
 * 核心不变量：**改正式状态的工具，模型不能自己放行**。
 *   ① 没带 approval_id → `APPROVAL_REQUIRED`（提示作者去界面确认，而不是"重试就行"）；
 *   ② 插件**不得**自行生成/缓存审批 id（源码断言）；
 *   ③ 审批 op 必须与服务端 `author_approvals.op` 对齐，且服务端审批是单次消费 + 有有效期；
 *   ④ 空白审批 id 不得被当成"有审批"（`''` / 空格 / null 都要拒绝）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const C = await import('../../harness-plugins/novel-writing/capabilities.mjs');
const toolsSrc = fs.readFileSync(path.join(REPO, 'harness-plugins/novel-writing/novel-tools.mjs'), 'utf8');
const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
// 审批的校验/消费实现住在 ai/story-state/approval.mjs（服务端调用它），因此两处都要看。
const approvalSrc = fs.readFileSync(path.join(REPO, 'ai/story-state/approval.mjs'), 'utf8');

const AUTHOR_TOOLS = Object.keys(C.TOOL_CAPABILITIES).filter((n) => C.capabilityOf(n) === C.CAPABILITY.AUTHOR_CONFIRM);
/**
 * 需要审批的那个 action。能力是**按 action** 判定的：
 *   · novel_state_commit 缺省是 review（只读），只有 apply 才推进正式状态；
 *   · novel_snapshot 缺省是 create（留快照），只有 rollback 才改状态；
 *   · chapter_save / write_pipeline 的写入 action。
 */
const ACTION_FOR_APPROVAL = {
  novel_chapter_save: {},
  novel_state_commit: { action: 'apply' },
  novel_snapshot: { action: 'rollback' },
  novel_write_pipeline: { action: 'commit' },
};
const approvalArgs = (name) => ({ work_id: 1, ...(ACTION_FOR_APPROVAL[name] || { action: 'apply' }) });

suite('nsdsh/author-approval-boundary', [
  ['S09-A1 改正式状态的工具必须存在，且都被识别为 AUTHOR_CONFIRM', () => {
    assert.ok(AUTHOR_TOOLS.length >= 3, `AUTHOR_CONFIRM 工具应有若干个，实际 ${AUTHOR_TOOLS.length}`);
    assert.ok(AUTHOR_TOOLS.includes('novel_state_commit'), '提交正式状态必须是作者确认类');
    assert.ok(AUTHOR_TOOLS.includes('novel_chapter_save'), '模型侧保存正文必须走审批');
  }],

  ['S09-A2 缺 approval_id → APPROVAL_REQUIRED（模型不能自己放行）', () => {
    for (const name of AUTHOR_TOOLS) {
      const v = C.assertModelCallable(name, { args: approvalArgs(name), scope: { workId: '1' } });
      assert.equal(v.ok, false, `${name} 缺审批时必须拒绝`);
      assert.equal(v.code, 'APPROVAL_REQUIRED');
      // 提示必须指向"作者去界面确认"，而不是"重试"
      assert.match(v.detail, /作者|审批/);
      assert.match(v.detail, /op=/, '提示应带上审批 op，方便作者/前端定位');
    }
  }],

  ['S09-A3 空白审批 id 不得被当成有效审批', () => {
    for (const bogus of ['', '   ', '\t\n', null, undefined]) {
      const v = C.assertModelCallable('novel_state_commit', { approvalId: bogus, args: approvalArgs('novel_state_commit'), scope: { workId: '1' } });
      assert.equal(v.ok, false, `审批 id=${JSON.stringify(bogus)} 必须被拒绝`);
      assert.equal(v.code, 'APPROVAL_REQUIRED');
    }
    // 真的给了 id 才放行到"服务端再校验"这一步（插件不做最终裁定，服务端才是权威）
    const withId = C.assertModelCallable('novel_state_commit', { approvalId: 'apr_123', args: approvalArgs('novel_state_commit'), scope: { workId: '1' } });
    assert.equal(withId.ok, true, '带审批 id 时插件应放行，由服务端做最终校验');
  }],

  ['S09-A4 插件不得自行生成或缓存审批（源码断言）', () => {
    // 不得出现 "自己造一个 approval id" 的代码
    assert.ok(!/approval_id\s*[:=]\s*['"`]apr_/.test(toolsSrc), '插件不得硬编码审批 id');
    assert.ok(!/crypto\.randomUUID\(\).*approval/i.test(toolsSrc), '插件不得现场生成审批 id');
    // 不得在本地保存审批以供复用
    assert.ok(!/localStorage|writeFileSync.*approval|approvals\s*=\s*\[/i.test(toolsSrc), '插件不得缓存审批');
    // 必须只是把作者给的 id 透传出去
    assert.match(toolsSrc, /approval_id/, '必须把 approval_id 透传给服务端');
  }],

  ['S09-A5 审批 op 与服务端 author_approvals.op 对齐，且单次消费 + 有效期', () => {
    // 审批的校验/消费实现住在 ai/story-state/approval.mjs
    const all = approvalSrc + serverSrc;
    assert.match(approvalSrc, /consumed_at/, '必须有消费时间（单次消费）');
    assert.match(approvalSrc, /expires_at/, '必须有有效期');
    assert.match(approvalSrc, /status === 'active'/, '只有 active 的审批可用');
    assert.match(approvalSrc, /expired/, '过期必须被明确拒绝');
    assert.match(approvalSrc, /status = 'consumed'/, '消费后必须落 consumed 状态（防重放）');
    assert.match(all, /revoked/, '必须能撤销（注销）');
    // 能力表里的 op 必须出现在服务端可识别的 op 集合里
    for (const name of AUTHOR_TOOLS) {
      const op = C.approvalOpOf(name);
      assert.ok(op, `${name} 必须有审批 op`);
      assert.ok(serverSrc.includes(op), `审批 op ${op} 必须能在服务端找到对应实现`);
    }
  }],

  ['S09-A6b 能力按 action 细化：只读/非破坏的 action 不被审批挡住，写入 action 必须挡', () => {
    // novel_state_commit：缺省 review 只读；apply 必须审批
    assert.equal(C.effectiveCapability('novel_state_commit', {}), 'read_only', '缺省 review 是只读');
    assert.equal(C.effectiveCapability('novel_state_commit', { action: 'review' }), 'read_only');
    assert.equal(C.effectiveCapability('novel_state_commit', { action: 'reject' }), 'proposal', 'reject 不推进正式状态');
    assert.equal(C.effectiveCapability('novel_state_commit', { action: 'apply' }), 'author_confirm');
    // novel_snapshot：create 非破坏；rollback 改状态
    assert.equal(C.effectiveCapability('novel_snapshot', {}), 'proposal');
    assert.equal(C.effectiveCapability('novel_snapshot', { action: 'create' }), 'proposal');
    assert.equal(C.effectiveCapability('novel_snapshot', { action: 'rollback' }), 'author_confirm');
    // 未登记的 action → 回落到基础能力（保守），不能成为绕过口
    assert.equal(C.effectiveCapability('novel_state_commit', { action: 'apply;drop' }), 'author_confirm',
      '未登记 action 必须具备该工具的基础能力（此处为 author_confirm），不得被当成只读');
    // 只读工具即便传 apply 也不升级/不降级（保持表里的分类）
    assert.equal(C.effectiveCapability('novel_context', { action: 'apply' }), 'read_only');
    // 运行时判定必须与 effectiveCapability 一致
    const ro = C.assertModelCallable('novel_state_commit', { args: { work_id: 1 }, scope: { workId: '1' } });
    assert.equal(ro.ok, true, '缺省 review 不需要审批');
    const write = C.assertModelCallable('novel_state_commit', { args: { work_id: 1, action: 'apply' }, scope: { workId: '1' } });
    assert.equal(write.code, 'APPROVAL_REQUIRED', 'apply 必须审批');
  }],

  ['S09-A6 审批语义不得被"过渡期兼容"绕过（不保留越权语义）', () => {
    // 模型侧写入路径必须真的走审批校验，不能有"某条件下跳过"的分支
    const guardAt = serverSrc.indexOf('模型侧写入需要作者审批');
    assert.ok(guardAt > 0, '服务端必须有明确的"需要作者审批"拒绝点');
    // 拒绝时的错误码必须是可判定的
    assert.match(serverSrc, /code: 'missing'|code: 'expired'|approval.*code/, '拒绝应带机器可读 code');
  }],
]);
