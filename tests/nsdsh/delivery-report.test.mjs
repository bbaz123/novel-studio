/**
 * tests/nsdsh/delivery-report.test.mjs —— S18：交付报告的完整性。
 *
 * 交付报告最容易出的问题不是"少写了几行"，而是**把没验证的东西写成已验证**。
 * 本套件因此不测"报告写得好不好"，而测三件事：
 *   ① 交付验收的每项检查都能跑、且当前全部成立；
 *   ② 报告必须显式列出**未验证平台**与**剩余限制**（有而是空 = 不诚实）；
 *   ③ 支持矩阵里每一格都必须给出"实测 / 未做"的明确归属，不能留空泛描述。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const V = await import('../../scripts/nsdsh/verify-delivery.mjs');

suite('nsdsh/delivery-report', [
  ['S18-D1 交付验收全部成立（12 项，exit 0）', () => {
    const r = V.verifyDelivery();
    const failed = r.checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], `未通过项：${failed.map((c) => c.name + ' — ' + c.detail).join('; ')}`);
    assert.equal(r.ok, true);
    assert.ok(r.checks.length >= 10, `检查项应有 10 项以上，实际 ${r.checks.length}`);
  }],

  ['S18-D2 支持矩阵每格都有明确归属（不许留空泛描述）', () => {
    const r = V.verifyDelivery();
    const m = r.delivery.support_matrix;
    assert.ok(m && typeof m === 'object');
    const keys = Object.keys(m);
    assert.ok(keys.length >= 5, `支持矩阵至少 5 项，实际 ${keys.length}`);
    for (const k of keys) {
      const v = String(m[k] || '');
      assert.ok(v.length > 4, `${k} 必须有实质描述`);
      // 每格必须能看出"测过/没测"
      assert.match(v, /实测|已验证|未做|未接|未产出|未验证/, `${k} 必须标明是否实测：${v}`);
    }
    // 至少要有"未做"的格子（诚实性）
    assert.ok(keys.some((k) => /未做|未接|未产出|未验证/.test(String(m[k]))), '矩阵里必须存在"未做"的项');
  }],

  ['S18-D3 未验证平台与剩余限制必须显式列出（空数组 = 不诚实）', () => {
    const r = V.verifyDelivery();
    const d = r.delivery;
    assert.ok(Array.isArray(d.platforms_tested) && d.platforms_tested.length >= 1, '必须记录已测平台');
    assert.ok(Array.isArray(d.platforms_unverified) && d.platforms_unverified.length >= 1, '必须记录未验证平台');
    assert.ok(Array.isArray(d.remaining_limits) && d.remaining_limits.length >= 3, '必须列出剩余限制');
    // 未验证平台里必须包含当前平台之外的系统
    assert.ok(d.platforms_unverified.some((p) => /macOS|Linux/.test(p)), '未验证平台应含 macOS/Linux');
    // 剩余限制里必须提到台账 open 项
    assert.ok(d.remaining_limits.some((l) => /台账 open/.test(l)), '剩余限制必须如实带上台账 open 项');
  }],

  ['S18-D4 台账 open 项与报告口径一致（不隐藏未修缺陷）', () => {
    const issues = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/nsdsh/known-issues.json'), 'utf8'));
    const open = (issues.issues || []).filter((i) => i.status === 'open').map((i) => i.id).sort();
    const r = V.verifyDelivery();
    const listed = r.delivery.remaining_limits.filter((l) => /台账 open 项：/.test(l)).map((l) => l.split('：')[1]).sort();
    assert.deepEqual(listed, open, `报告里的 open 项必须与台账完全一致（台账 ${open.join(',')}）`);
    // 每条 open 都必须有处置说明
    for (const i of (issues.issues || []).filter((x) => x.status === 'open')) {
      assert.ok(String(i.evidenceNote || '').length > 20, `${i.id} 必须有处置说明`);
    }
  }],

  ['S18-D5 STATUS.md 与机器可读台账不矛盾', () => {
    const status = fs.readFileSync(path.join(REPO, 'docs/nsdsh/STATUS.md'), 'utf8');
    const stages = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/nsdsh/stages.json'), 'utf8')).stages || [];
    const notDone = stages.filter((s) => s.id && s.status !== 'done').map((s) => s.id);
    assert.deepEqual(notDone, [], `stages.json 里仍有未完成阶段：${notDone.join(',')}`);
    // STATUS.md 必须把 18 个阶段都列出来
    for (const id of ['S00', 'S04', 'S10', 'S14', 'S18']) {
      assert.ok(status.includes(id), `STATUS.md 必须提到 ${id}`);
    }
    // 必须写明未验证限制，不得只写好消息
    assert.match(status, /未验证|剩余限制/, 'STATUS.md 必须写明未验证项');
    assert.ok(!/全部完成，无任何限制/.test(status), '不得声称零限制');
  }],
]);
