/**
 * tests/nsdsh/cross-work-isolation.test.mjs —— S09：跨作品隔离。
 *
 * 验收要求"伪造工作 ID / session 全部被拒绝"。判据是确定性的：
 *   ① 任务启动器把会话绑定到某个作品（`NOVELSTUDIO_WORK_ID`），
 *      工具请求里的 `work_id` 与它不一致 → `WORK_SCOPE_MISMATCH`；
 *   ② 没绑定（空）时不制造"跨作品"假象：允许调用，但仍受能力表约束；
 *   ③ 绑定值不得被参数里的大小写/空白/类型差异绕过（'5' 与 5 是同一个作品，
 *      但 '5 ' 这种不能悄悄变成"不同作品"从而绕过检查）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const C = await import('../../harness-plugins/novel-writing/capabilities.mjs');
const toolsSrc = fs.readFileSync(path.join(REPO, 'harness-plugins/novel-writing/novel-tools.mjs'), 'utf8');

suite('nsdsh/cross-work-isolation', [
  ['S09-X1 伪造工作 ID：与绑定 scope 不一致一律拒绝（三类工具都拦）', () => {
    const cases = [
      ['novel_context', 'read_only'],
      ['novel_event_add', 'proposal'],
      ['novel_state_commit', 'author_confirm'],
    ];
    for (const [toolName, cap] of cases) {
      const v = C.assertModelCallable(toolName, {
        approvalId: cap === 'author_confirm' ? 'apr_x' : '',
        args: { work_id: 999, ...(toolName === 'novel_state_commit' ? { action: 'apply' } : {}) },
        scope: { workId: '1' },
      });
      assert.equal(v.ok, false, `${toolName} 跨作品必须被拒绝`);
      assert.equal(v.code, 'WORK_SCOPE_MISMATCH', `实际 ${v.code}`);
      assert.match(v.detail, /999/);
      assert.match(v.detail, /1/);
    }
  }],

  ['S09-X2 绑定作品内正常调用不受影响（不误伤）', () => {
    for (const workId of ['1', 1]) {
      const v = C.assertModelCallable('novel_context', { args: { work_id: workId }, scope: { workId: 1 } });
      assert.equal(v.ok, true, `work_id=${JSON.stringify(workId)} 与绑定 1 相同，应放行`);
    }
  }],

  ['S09-X3 未绑定时不制造跨作品假象，但仍受能力表约束', () => {
    // 没有绑定：不因 work_id 拒绝（没有"被绑定到另一个作品"这回事）
    const loose = C.assertModelCallable('novel_context', { args: { work_id: 7 }, scope: {} });
    assert.equal(loose.ok, true);
    // 但未知工具仍然失败关闭
    const unknown = C.assertModelCallable('novel_hidden_tool', { args: { work_id: 7 }, scope: {} });
    assert.equal(unknown.code, 'UNKNOWN_TOOL');
    // 作者确认类仍然要审批
    // 作者确认类仍然要审批（注意：缺省 action 是只读 review，必须用真正写入的 action 才触发审批）
    const needApproval = C.assertModelCallable('novel_state_commit', { args: { work_id: 7, action: 'apply' }, scope: {} });
    assert.equal(needApproval.code, 'APPROVAL_REQUIRED');
  }],

  ['S09-X4 参数里没给 work_id 时不误判（绑定仍生效于服务端）', () => {
    // 工具可以省略 work_id（服务端用环境身份）—— 此时不该被"跨作品"拦住
    const v = C.assertModelCallable('novel_context', { args: {}, scope: { workId: '1' } });
    assert.equal(v.ok, true, '省略 work_id 不应被当成伪造');
  }],

  ['S09-X5 插件的绑定来源是任务启动器注入的环境身份，而不是模型参数', () => {
    // 绑定必须来自 process.env.NOVELSTUDIO_WORK_ID，而不是 args.work_id
    assert.match(toolsSrc, /process\.env\.NOVELSTUDIO_WORK_ID/, '绑定 scope 必须来自环境身份');
    const regIdx = toolsSrc.indexOf('function register(name');
    const regBody = toolsSrc.slice(regIdx, toolsSrc.indexOf("register('novel_works'", regIdx));
    assert.match(regBody, /scope: \{ workId: boundWorkId \|\| null \}/, '判定时必须传绑定 scope');
    // 不得把 args.work_id 当作绑定来源
    assert.ok(!/scope:\s*\{\s*workId:\s*args\.work_id/.test(toolsSrc), '不得让模型自选绑定作品');
  }],

  ['S09-X6 跨作品检索：向量/库检索入口必须带 work_id 过滤（不接受"全局检索"）', () => {
    // 工具源码里凡是检索/上下文入口，都必须能带 work_id
    const lookupAt = toolsSrc.indexOf("register('novel_lookup'");
    assert.ok(lookupAt > 0, '必须有 novel_lookup');
    const block = toolsSrc.slice(lookupAt, lookupAt + 1200);
    assert.match(block, /work_id/, '检索必须支持按作品限定');
    assert.match(block, /envId\(args, 'work_id'\)|work_id:/, '检索必须真的把 work_id 传下去');
  }],
]);
