#!/usr/bin/env node
/**
 * tests/temporal/07-proposal-binding.test.mjs —— T2 收尾的生产接线证据（HTTP 级，零计费）。
 *
 * 覆盖：
 *   B1 提案绑定完整性：保存后 pending 绑定带「输入快照 / HEAD / 章序 / 契约 / payload hash」
 *   B2 确认后兼容投影：characters.status / character_relations 从**已确认状态**单向刷新
 *   B3 服务端复核：上游变化后旧提案判 stale（保留可查），重新分析后可正常确认
 *   B4 payload hash 篡改检测：绑定被改动 → needs_review，不进入正式状态（直改隔离库模拟）
 *   B5 一次性审批：服务端计算基线；错误 op / 跨作品 / 基线变化 → 拒绝且**不消费无关审批**；
 *      正确审批 → 确认成功并消费；重复确认幂等（AC-43/45）
 *   B6 原子组不可拆分：带 events/event_ids 子集的确认被拒绝，HEAD 与提案不受影响（AC-45）
 *
 * 用法：node tests/temporal/07-proposal-binding.test.mjs            # 自托管隔离实例
 *      node scripts/ci-isolated-run.mjs --port 3757 -- node tests/temporal/07-proposal-binding.test.mjs --base http://127.0.0.1:3757
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  argValue, createAssert, createClient, startFakeModel, startIsolatedServer, waitProposal,
  cell, kv, op,
} from './http-harness.mjs';

const assert = createAssert();
const ok = assert.ok;
let BASE = argValue('--base', '');
let server = null;

async function main() {
  if (!BASE) {
    server = await startIsolatedServer({ tag: 't2-binding' });
    BASE = server.base;
    console.log(`✓ 自托管隔离实例已就绪：${BASE}（数据目录 ${server.dataDir}）`);
  }
  const api = createClient(BASE);
  const fake = await startFakeModel();
  const works = [];
  try {
    const wA = await api.createWork('T2 提案绑定验收《青云纪》');
    if (wA.status >= 300) { console.error('建作品失败', wA.status, wA.text.slice(0, 200)); process.exit(2); }
    const workA = wA.json.id; works.push(workA);
    const cids = [];
    for (const t of ['第1章 接应', '第2章 独立任务', '第3章 回忆', '第4章 审批']) {
      const c = await api.createChapter(workA, t);
      cids.push(c.json.id);
    }
    const [c1, c2, c3, c4] = cids;
    const wB = await api.createWork('T2 跨作品审批对照');
    const workB = wB.json.id; works.push(workB);
    const cb = await api.createChapter(workB, 'B1');
    const b1 = cb.json.id;

    ok('B0a 作者开启时态引擎 + 自动分析',
      (await api.setTemporal(workA, { temporal_enabled: true, auto_analysis_enabled: true })).json?.config?.enabled === true);
    ok('B0b 模型侧不能开启（403）',
      (await api.setTemporal(workB, { temporal_enabled: true }, { 'x-novel-agent': '1' })).status === 403);
    ok('B0c 作者开启作品 B（跨作品审批对照）',
      (await api.setTemporal(workB, { temporal_enabled: true })).json?.config?.enabled === true);
    const cfg = await api.api('POST', '/api/api_configs', { name: 'T2 假模型（零计费）', base_url: `http://127.0.0.1:${fake.port}/v1`, api_key: 'sk-local-stub-not-billed', model: 'deepseek-chat' });
    ok('B0d 假模型配置建立（本机端口）', cfg.status === 201, `status=${cfg.status}`);
    const chWang = await api.api('POST', '/api/characters', { work_id: workA, name: '王师傅', status: '' });
    const chZhu = await api.api('POST', '/api/characters', { work_id: workA, name: '主角', status: '' });
    ok('B0e 建立角色卡（旧入口，供兼容投影断言）', chWang.status === 201 && chZhu.status === 201);
    const rel = await api.api('POST', '/api/relations', { work_id: workA, from_character_id: chZhu.json.id, to_character_id: chWang.json.id, relation: '', description: '' });
    ok('B0f 建立人物关系行（旧入口）', rel.status === 201, `status=${rel.status} ${rel.text.slice(0, 120)}`);

    // ── B1 提案绑定完整性 + 确认 + 兼容投影 ─────────────────────────────────────
    console.log('【B1 提案绑定完整性 / 确认 / 兼容投影】');
    const text1 = '王师傅在青云镇接应主角';
    fake.state.scripts.push({
      events: [{
        ops: [
          op(cell('character', '王师傅', 'alive'), true),
          op(cell('character', '王师傅', 'status'), '存活'),
          op(cell('character', '王师傅', 'location'), '青云镇'),
          op(cell('relation', '主角|王师傅', '师徒'), { from: '主角', to: '王师傅', label: '师徒' }),
        ],
        evidence: [{ quote: '王师傅在青云镇接应主角', narrative: 'present' }],
      }],
    });
    const save1 = await api.api('PUT', `/api/chapters/${c1}`, { content: `<p>${text1}</p>` });
    ok('B1a 保存成功（W1）', save1.status === 200);
    let g1 = await api.proposalGroups(workA, c1);
    let p1 = (g1.json.proposals || [])[0] || null;
    ok('B1b 保存后出现 pending 提案', !!p1);
    const ctx1 = p1 && p1.pending_context;
    ok('B1c 提案绑定输入快照（input_snapshot_id 非空）', !!ctx1 && !!ctx1.input_snapshot_id, JSON.stringify(ctx1 && { snap: ctx1.input_snapshot_id }));
    ok('B1d 提案绑定 HEAD / 章序 / 契约', !!ctx1 && !!ctx1.head_commit_id && !!ctx1.order_version_id && ctx1.contract?.version === '1', JSON.stringify(ctx1 && { head: ctx1.head_commit_id, order: ctx1.order_version_id, v: ctx1.contract?.version }));
    ok('B1e 提案绑定输入状态哈希与提交', !!ctx1 && !!ctx1.input_state_hash && ctx1.input_trusted === true);
    const w1 = await waitProposal(api, workA, c1, (p) => p.status === 'done');
    ok('B1f 自动分析完成', !!w1.proposal, `last=${w1.last}`);
    ok('B1g 分析结果记录 payload hash（16 位摘要）', /^[0-9a-f]{16}$/.test(String(w1.proposal?.analysis?.payload_hash || '')), String(w1.proposal?.analysis?.payload_hash));
    const headBeforeConfirm = (await api.overview(workA)).json?.head_commit_id || null;
    const confirm1 = await api.applyBinding(workA, c1, w1.proposal.binding_id);
    ok('B1h 作者一次确认成功（原子组）', confirm1.status === 200 && confirm1.json.ok === true && confirm1.json.decision === 'valid', `status=${confirm1.status} ${confirm1.text.slice(0, 160)}`);
    ok('B1i HEAD 由确认推进（提交级 CAS）', !!confirm1.json.commit_id && confirm1.json.commit_id !== headBeforeConfirm);
    ok('B1j 兼容投影刷新：characters_updated ≥ 1、剧情线如实跳过', confirm1.json.compat?.characters_updated >= 1 && confirm1.json.compat?.plotlines_skipped === 'no_safe_legacy_field', JSON.stringify(confirm1.json.compat));
    const wangAfter = await api.api('GET', `/api/characters/${chWang.json.id}`);
    ok('B1k characters.status 投影为已确认状态（存活）', String(wangAfter.json?.status || '') === '存活', String(wangAfter.json?.status));
    const relAfter = await api.api('GET', `/api/relations/${rel.json.id}`);
    ok('B1l character_relations.relation 投影为已确认关系（师徒）', String(relAfter.json?.relation || '') === '师徒', String(relAfter.json?.relation));
    const at1 = await api.stateAt(workA, c1);
    ok('B1m 历史查询（截至第 1 章）反映已确认状态', at1.json.validity === 'valid' && at1.json.state_json[kv('character', '王师傅', 'alive')] === true, `validity=${at1.json.validity}`);

    // ── B3 上游变化 → 旧提案 stale（保留）→ 重新分析 → 确认 ─────────────────────
    console.log('【B3 上游变化后的服务端复核】');
    const text2 = '主角独自执行侦察任务';
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('character', '主角', 'alive'), true), op(cell('character', '主角', 'status'), '存活')],
        evidence: [{ quote: '主角独自执行侦察任务', narrative: 'present' }],
      }],
    });
    const save2 = await api.api('PUT', `/api/chapters/${c2}`, { content: `<p>${text2}</p>` });
    ok('B3a 第 2 章保存（W1）', save2.status === 200);
    const w2 = await waitProposal(api, workA, c2, (p) => p.status === 'done');
    ok('B3b 第 2 章分析完成', !!w2.proposal, `last=${w2.last}`);
    ok('B3c 第 2 章提案绑定第 1 章确认后的输入提交', !!w2.proposal?.pending_context?.input_commit_id && w2.proposal.pending_context.input_commit_id === confirm1.json.commit_id,
      `ctx=${w2.proposal?.pending_context?.input_commit_id} commit=${confirm1.json.commit_id}`);
    const corr = await api.correct(workA, c1, [{ kind: 'character', entity_id: '王师傅', predicate: 'status', value: '受伤' }]);
    const head2before = (await api.overview(workA)).json?.head_commit_id || null;
    ok('B3d 作者更正第 1 章（旧入口命令化）成功', corr.status === 200 && corr.json.ok === true, `status=${corr.status} ${corr.text.slice(0, 140)}`);
    const staleApply = await api.applyBinding(workA, c2, w2.proposal.binding_id);
    ok('B3e 上游变化后旧提案判 stale（不套用到新正文）', staleApply.status === 200 && staleApply.json.decision === 'stale', `decision=${staleApply.json?.decision} ${staleApply.text.slice(0, 160)}`);
    ok('B3f stale 原因可核对（INPUT_STATE_CHANGED）', (staleApply.json.issues || []).some((i) => i.code === 'INPUT_STATE_CHANGED'), JSON.stringify(staleApply.json.issues));
    const headUnchanged = (await api.overview(workA)).json?.head_commit_id || null;
    ok('B3g 拒绝没有破坏 HEAD（旧提案保留可查）', headUnchanged === head2before, `head=${headUnchanged} before=${head2before}`);
    const stillPending = await api.proposalGroups(workA, c2);
    ok('B3h 过期提案原样保留（仍列出，等待重新分析）', (stillPending.json.proposals || []).length === 1);
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('character', '主角', 'alive'), true), op(cell('character', '主角', 'status'), '存活')],
        evidence: [{ quote: '主角独自执行侦察任务', narrative: 'present' }],
      }],
    });
    const re = await api.analyze(workA, c2);
    ok('B3i 作者显式重新分析成功', re.status === 200 && re.json.status === 'done', `status=${re.status} ${re.text.slice(0, 160)}`);
    const confirm2 = await api.applyBinding(workA, c2, w2.proposal.binding_id);
    ok('B3j 重新分析后确认成功（输入绑定已刷新）', confirm2.status === 200 && confirm2.json.ok === true && confirm2.json.decision === 'valid', `${confirm2.text.slice(0, 160)}`);

    // ── B4 payload hash 篡改检测（需要直连隔离库，仅自托管时执行）────────────────
    console.log('【B4 payload hash 篡改检测】');
    const text3 = '主角在黑风谷看到王师傅留下的嘱托';
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('disclosure', '王师傅的嘱托', 'disclosed'), true)],
        evidence: [{ quote: '看到王师傅留下的嘱托', narrative: 'present' }],
      }],
    });
    await api.api('PUT', `/api/chapters/${c3}`, { content: `<p>${text3}</p>` });
    const w3 = await waitProposal(api, workA, c3, (p) => p.status === 'done');
    ok('B4a 第 3 章提案分析完成', !!w3.proposal);
    if (!server) {
      console.log('  - SKIP：B4b/B4c 需要直连隔离库（--base 外部实例时跳过；SKIP ≠ PASS）');
    } else {
      const dbPath = path.join(server.dataDir, 'novel.db');
      const db = new DatabaseSync(dbPath);
      let originalValidation = '';
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const row = db.prepare('SELECT validation_json FROM story_chapter_bindings WHERE id = ?').get(String(w3.proposal.binding_id));
        originalValidation = String(row.validation_json || '{}');
        const validation = JSON.parse(originalValidation);
        validation.analysis = { ...(validation.analysis || {}), payload_hash: 'deadbeefdeadbeef' };
        db.prepare('UPDATE story_chapter_bindings SET validation_json = ? WHERE id = ?').run(JSON.stringify(validation), String(w3.proposal.binding_id));
      } finally { db.close(); }
      const tampered = await api.applyBinding(workA, c3, w3.proposal.binding_id);
      ok('B4b 载荷被篡改 → needs_review（不进入正式状态）', tampered.json?.decision === 'needs_review' && (tampered.json.issues || []).some((i) => i.code === 'PAYLOAD_HASH_MISMATCH'), `${tampered.text.slice(0, 180)}`);
      const at3 = await api.stateAt(workA, c3);
      ok('B4c 被篡改提案没有写入（第 3 章仍非 valid）', at3.json.validity !== 'valid', `validity=${at3.json.validity}`);
      const db2 = new DatabaseSync(dbPath);
      try {
        db2.exec('PRAGMA busy_timeout = 5000');
        db2.prepare('UPDATE story_chapter_bindings SET validation_json = ? WHERE id = ?').run(originalValidation, String(w3.proposal.binding_id));
      } finally { db2.close(); }
      const restored = await api.applyBinding(workA, c3, w3.proposal.binding_id);
      ok('B4d 恢复绑定后同一提案可正常确认（证明拒绝源自篡改本身）', restored.json?.ok === true && restored.json?.decision === 'valid', `${restored.text.slice(0, 160)}`);
    }

    // ── B5 一次性审批边界（AC-43/45）────────────────────────────────────────────
    console.log('【B5 一次性审批边界】');
    const text4 = '主角决定独自前往黑风谷';
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('character', '主角', 'location'), '黑风谷')],
        evidence: [{ quote: '独自前往黑风谷', narrative: 'present' }],
      }],
    });
    await api.api('PUT', `/api/chapters/${c4}`, { content: `<p>${text4}</p>` });
    const w4 = await waitProposal(api, workA, c4, (p) => p.status === 'done');
    ok('B5a 第 4 章提案分析完成（待授权确认）', !!w4.proposal, `last=${w4.last}`);
    const appr = await api.createApproval({ work_id: workA, op: 'temporal_apply', binding_id: w4.proposal.binding_id, note: '一次确认' });
    ok('B5b 作者创建一次性审批（服务端计算基线）', appr.status === 201 && appr.json.baseline_hash === w4.proposal.analysis.payload_hash, `status=${appr.status} baseline=${appr.json?.baseline_hash}`);
    const wrongOp = await api.createApproval({ work_id: workA, op: 'chapter_save', chapter_id: c4 });
    const misOp = await api.applyBinding(workA, c4, w4.proposal.binding_id, { approval_id: wrongOp.json.id });
    ok('B5c 错误 op 的审批不能顶替（拒绝）', misOp.json?.decision === 'rejected', `${misOp.text.slice(0, 140)}`);
    const wrongOpRow = await api.listApprovals(workA, 'active');
    ok('B5d 错误 op 的审批未被消费（仍 active）', (wrongOpRow.json.approvals || []).some((r) => r.id === wrongOp.json.id));
    const saveB = await api.api('PUT', `/api/chapters/${b1}`, { content: '<p>另一个作品的一章</p>' });
    ok('B5e 作品 B 保存建立自己的提案', saveB.status === 200);
    const gB = await api.proposalGroups(workB, b1);
    const pbB = (gB.json.proposals || [])[0] || null;
    const apprB = await api.createApproval({ work_id: workB, op: 'temporal_apply', binding_id: pbB && pbB.binding_id });
    const cross = await api.applyBinding(workA, c4, w4.proposal.binding_id, { approval_id: apprB.json.id });
    ok('B5f 跨作品审批无效（拒绝）', cross.json?.decision === 'rejected' && String(cross.json.reason || '').includes('另一部作品'), `${cross.text.slice(0, 160)}`);
    const apprBRow = await api.listApprovals(workB, 'active');
    ok('B5g 跨作品审批未被消费（仍 active）', (apprBRow.json.approvals || []).some((r) => r.id === apprB.json.id));
    const good = await api.applyBinding(workA, c4, w4.proposal.binding_id, { approval_id: appr.json.id });
    ok('B5h 正确审批：一次确认成功', good.status === 200 && good.json.ok === true && good.json.approval?.consumed === true, `${good.text.slice(0, 160)}`);
    const consumed = await api.listApprovals(workA, 'consumed');
    ok('B5i 审批单次消费（已 consumed，不再 active）', (consumed.json.approvals || []).some((r) => r.id === appr.json.id));
    const again = await api.applyBinding(workA, c4, w4.proposal.binding_id, { approval_id: appr.json.id });
    ok('B5j 重复确认幂等（返回同一提交回执，不再消费）', again.json?.ok === true && again.json?.reused === true, `${again.text.slice(0, 140)}`);

    // ── B6 原子组不可拆分（AC-45）───────────────────────────────────────────────
    console.log('【B6 原子组不可拆分 / 基线变化审批不适用】');
    const text4b = '主角在黑风谷发现线索';
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('world_fact', '黑风谷线索', 'state'), '已发现')],
        evidence: [{ quote: '在黑风谷发现线索', narrative: 'present' }],
      }],
    });
    await api.api('PUT', `/api/chapters/${c4}`, { content: `<p>${text4b}</p>` });
    const w4b = await waitProposal(api, workA, c4, (p) => p.status === 'done' && p.binding_id !== w4.proposal.binding_id);
    ok('B6a 二次保存产生新提案（旧提案被取代）', !!w4b.proposal, `last=${w4b.last}`);
    const headB6 = (await api.overview(workA)).json?.head_commit_id || null;
    const partial = await api.applyBinding(workA, c4, w4b.proposal.binding_id, { event_ids: [] });
    ok('B6b 带事件子集的确认被拒绝（400）', partial.status === 400, `status=${partial.status} ${partial.text.slice(0, 140)}`);
    const headB6b = (await api.overview(workA)).json?.head_commit_id || null;
    ok('B6c 拒绝没有改动 HEAD', headB6b === headB6);
    const appr4b = await api.createApproval({ work_id: workA, op: 'temporal_apply', binding_id: w4b.proposal.binding_id });
    const text4c = '主角在黑风谷遇到旧友';
    fake.state.scripts.push({
      events: [{
        ops: [op(cell('world_fact', '黑风谷旧友', 'state'), '已出现')],
        evidence: [{ quote: '在黑风谷遇到旧友', narrative: 'present' }],
      }],
    });
    await api.api('PUT', `/api/chapters/${c4}`, { content: `<p>${text4c}</p>` });
    const w4c = await waitProposal(api, workA, c4, (p) => p.status === 'done' && p.binding_id !== w4b.proposal.binding_id);
    ok('B6d 再次保存产生第三个提案', !!w4c.proposal, `last=${w4c.last}`);
    const staleApproval = await api.applyBinding(workA, c4, w4c.proposal.binding_id, { approval_id: appr4b.json.id });
    ok('B6e 基线变化后旧审批不适用（拒绝）', staleApproval.json?.decision === 'rejected', `${staleApproval.text.slice(0, 160)}`);
    const appr4bRow = await api.listApprovals(workA, 'active');
    ok('B6f 不适用审批未被消费（仍 active，AC-43）', (appr4bRow.json.approvals || []).some((r) => r.id === appr4b.json.id));
    const finalApply = await api.applyBinding(workA, c4, w4c.proposal.binding_id);
    ok('B6g 无审批的作者确认仍可用（作者会话动作）', finalApply.json?.ok === true && finalApply.json?.decision === 'valid', `${finalApply.text.slice(0, 140)}`);
  } finally {
    for (const id of works) { try { await api.deleteWork(id); } catch { /* 自清理失败不影响断言 */ } }
    try { fake.server.close(); } catch { /* noop */ }
    if (server) { try { server.stop(); } catch { /* noop */ } }
  }
  const failed = assert.summary('T2 提案绑定 / 服务端复核 / 审批边界 / 兼容投影');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  try { if (server) server.stop(); } catch { /* noop */ }
  process.exit(1);
});
