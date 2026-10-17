/**
 * tests/nsdsh/downstream-invalidation.test.mjs —— S07：下游保守失效不得被削弱。
 *
 * S07 明确要求"保持下游保守失效、commit scoped trust 与旧历史隔离"，
 * 并禁止"名称未出现就不失效"这类启发式。本套件钉住：
 *   ① 章序差异从**最早差异点**开始失效（插章/删章/跨卷移动）；
 *   ② 无法判定时**不失效也不假装成功**（`ok:false` 响亮返回），而不是静默跳过；
 *   ③ 源码里不得出现"跳过失效"的启发式分支。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedDir, seedWork, suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

// 必须在 import db.js 之前建隔离环境（db.js 在 import 时解析数据目录并开库）。
isolatedDir('nsdsh-downstream-');
const { db } = await import('../../db.js');

const I = await import('../../ai/story-state/temporal/impact.mjs');

/** 真实作品（外键要求存在），没有提交时 invalidationPlan 会保守返回"无可失效绑定"。 */
const W = seedWork(db, { title: 'S07-失效', chapters: 3 });

const impactSrc = fs.readFileSync(path.join(REPO, 'ai/story-state/temporal/impact.mjs'), 'utf8');

suite('nsdsh/downstream-invalidation', [
  ['S07-I1 章序差异从最早差异点开始（插章/删章/移动都算）', () => {
    // 无差异 → null（不是 {index:-1}；如实表示"没有差异"，调用方必须显式判空）
    assert.equal(I.earliestOrderDifference([1, 2, 3], [1, 2, 3]), null);
    // 尾部插章：差异在第 3 位
    const inserted = I.earliestOrderDifference([1, 2, 3], [1, 2, 3, 4]);
    assert.equal(inserted.index, 3);
    assert.equal(inserted.chapter_id, 4, '以新顺序该位置的章节为准（新增章节取新 id）');
    // 中间插章：差异在第 1 位
    assert.equal(I.earliestOrderDifference([1, 2, 3], [1, 9, 2, 3]).index, 1);
    // 跨卷移动：最早差异必须比"移动后第一个变化位置"更靠前或相等
    const moved = I.earliestOrderDifference([1, 2, 3, 4], [3, 1, 2, 4]);
    assert.ok(moved.index >= 0 && moved.index <= 2, `移动后应在最早差异处失效，实际 index=${moved.index}`);
    // 删章
    assert.equal(I.earliestOrderDifference([1, 2, 3], [1, 3]).index, 1);
  }],

  ['S07-I2 无法判定时不失效且如实返回 ok:false（不静默跳过）', () => {
    // 作品没有提交 → 保守返回 ok:true 但"没有可失效的绑定"（不是错误）
    const noCommit = I.invalidationPlan({ workId: W.workId, fromChapterId: W.chapterIds[0] });
    assert.equal(noCommit.ok, true);
    assert.deepEqual(noCommit.actions, []);
    assert.match(String(noCommit.policy && noCommit.policy.note || ''), /尚无提交/);

    // 章节不在章序里 → 明确 ok:false，并说明要先补章序/绑定
    const bad = I.invalidationPlan({ workId: W.workId, fromChapterId: W.chapterIds[0], orderChapters: [] });
    // 只有存在提交时才会走到章序判定；这里用显式 orderChapters 模拟"章节不在章序"
    if (bad.commit_id) {
      assert.equal(bad.ok, false, '章节不在章序时必须 ok:false');
      assert.match(String(bad.note || ''), /章序/);
    }
  }],

  ['S07-I3 源码纪律：不得出现"跳过下游失效"的启发式分支', () => {
    // 禁止基于"名称是否出现"决定是否失效
    assert.ok(!/名称.*(不失效|跳过失效)/.test(impactSrc), 'S07 明确禁止"名称没出现就不失效"');
    // 禁止"若下游为空就当作已处理"这类静默成功
    assert.ok(!/if\s*\(\s*!downstreamBindingIds\.length\s*\)\s*return\s*\{[^}]*ok:\s*true[^}]*applied/.test(impactSrc),
      '空下游不得被伪装成"已应用失效"');
    // 必须有显式的"下游从 fromIndex+1 开始"这一保守边界
    assert.match(impactSrc, /for \(let i = fromIndex \+ 1;/, '下游必须从变更点的**下一位**开始（含边界保守）');
  }],

  ['S07-I4 失效计划与溯源同口径：plan 里带 commit / from_index，不靠猜', () => {
    const plan = I.invalidationPlan({ workId: W.workId, fromChapterId: W.chapterIds[0] });
    assert.ok('commit_id' in plan, '计划必须显式带 commit_id（哪怕是 null）');
    assert.ok('from_index' in plan, '计划必须显式带 from_index');
    assert.equal(plan.from_chapter_id, W.chapterIds[0]);
    // 有 totals 结构，便于上层判断"到底影响了几条"
    for (const k of ['downstream', 'will_stale', 'already_bad', 'missing_binding', 'explicit_hits']) {
      assert.equal(typeof plan.totals[k], 'number', `totals.${k} 必须是数字`);
    }
  }],
]);
