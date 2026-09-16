#!/usr/bin/env node
/**
 * test-sync-gate.mjs —— 决策 D8-#6 的离线单测（零成本、不连 OpenViking）。
 *
 * 被验证的行为：**「建完立刻删」不得留下孤儿记忆目录**。
 * 修复前：同步在逐文件写，删除把目录删掉，同步随后接着写 → 目录复活且数据库里已无对应作品。
 * 修复后：删除前先举旗（令同步停手）、再等在途同步真正结束，然后才删；
 *         同步的每一次写之前都要询问是否该停手。
 *
 * 关键：这里跑的是**真实时序**（假的任务 + 真实的 await 调度），不是"读代码下结论"。
 * 并且带**阴性对照**——把闸门摘掉，同一场景必须**真的**留下孤儿写入，否则说明这个测试
 * 根本演不出那个竞态，通过也没有意义。
 *
 * 用法: node .p1-baseline/test-sync-gate.mjs
 */
import { createSyncGate } from '../ai/sync-gate.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/**
 * 假同步：逐条写 N 个文件，每条前先问闸门"该不该停手"。
 * @returns {{writes: string[], promise: Promise<void>}}
 */
function fakeSync(gate, workId, files, { useGate = true } = {}) {
  const writes = [];
  const promise = (async () => {
    for (const f of files) {
      if (useGate && gate.shouldStop(workId)) return;   // 协作式取消
      await sleep(5);                                    // 模拟一次 HTTP 写
      writes.push(f);
    }
  })();
  return { writes, promise };
}

console.log('【1. 修复后的时序：删除前先举旗 + 等收手】');
{
  const gate = createSyncGate();
  const files = ['meta.md', 'long-memory.md', 'events.md', 'outline.md', 'settings/1.md', 'characters/2.md'];
  const sync = fakeSync(gate, 7, files);
  gate.register(7, sync.promise);

  await sleep(12);                      // 让它写掉头几个文件
  const writtenBefore = sync.writes.length;
  const { drained } = await gate.cancelAndDrain(7);   // ← 删除前的动作
  const writesAtRemove = sync.writes.length;          // 删除发生时已经写完的数量
  await sleep(60);                                    // 给"失控的同步"充足时间继续写

  ok('闸门报告在途任务已收手', drained === true, `drained=${drained}`);
  ok('举旗之后**没有**再写入任何文件',
    sync.writes.length === writesAtRemove,
    `删除时 ${writesAtRemove} 个，之后涨到 ${sync.writes.length} 个`);
  ok('确实写了东西（不是"什么都没跑"造成的假通过）', writtenBefore > 0, `删除前写了 ${writtenBefore} 个`);
  ok('在途登记不泄漏（任务结束后计数归零）', gate.inFlightCount() === 0, `inFlight=${gate.inFlightCount()}`);
}

console.log('\n【2. 阴性对照：摘掉闸门，同一场景必须真的留下孤儿写入】');
{
  const gate = createSyncGate();
  const files = ['meta.md', 'long-memory.md', 'events.md', 'outline.md', 'settings/1.md', 'characters/2.md'];
  const sync = fakeSync(gate, 8, files, { useGate: false });   // ← 不询问闸门 = 修复前的行为
  // 注意：这里**不** register、**不** cancelAndDrain —— 完整复现修复前"fire-and-forget 两条路"
  await sleep(12);
  const writesAtRemove = sync.writes.length;
  await gate.cancelAndDrain(8);        // 即使举了旗，不用闸门的任务也看不到
  await sync.promise;
  await sleep(10);

  ok('对照：删除之后同步**仍在继续写**（孤儿目录就是这么来的）',
    sync.writes.length > writesAtRemove,
    `删除时 ${writesAtRemove} 个 → 最终 ${sync.writes.length} 个`);
  ok('对照：最终写满全部文件（目录被"复活"）',
    sync.writes.length === files.length, `${sync.writes.length}/${files.length}`);
}

console.log('\n【3. 边界：重复登记 / 抛错的任务 / 旗子回收】');
{
  const gate = createSyncGate();
  // 任务抛错：不能把在途登记卡死，否则后来的删除会被一个死任务永远挡住。
  const boom = (async () => { await sleep(5); throw new Error('模拟同步失败'); })();
  gate.register(9, boom);
  const r1 = await gate.cancelAndDrain(9);
  ok('抛错的任务也能被排空（不会卡死后续删除）', r1.drained === true, JSON.stringify(r1));
  await sleep(10);
  ok('抛错后登记已清理', gate.inFlightCount() === 0, `inFlight=${gate.inFlightCount()}`);

  // 重复登记：后登记的任务覆盖前者，前者的注销不能误删后者的登记。
  const a = (async () => { await sleep(30); })();
  const b = (async () => { await sleep(30); })();
  gate.register(10, a);
  gate.register(10, b);
  await sleep(5);
  ok('重复登记时仍在途（后一个还没结束）', gate.inFlightCount() === 1, `inFlight=${gate.inFlightCount()}`);
  await gate.cancelAndDrain(10);

  // 旗子回收：同一 workId 被复用（删掉又建）时，新任务不该被旧旗子误伤。
  gate.release(10);
  ok('release 之后旗子已撤（新任务不会被旧旗子误伤）', gate.shouldStop(10) === false);
  ok('cancelAndDrain 之后旗子是举着的（删除流程内必须保持）', (() => {
    const g2 = createSyncGate();
    g2.cancelAndDrain(11);
    return g2.shouldStop(11) === true;
  })());
}

console.log('\n【4. 接线：openviking-sync.js 真的用了这个闸门】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('openviking-sync.js', 'utf8');
  ok('导入了闸门', /from '\.\/ai\/sync-gate\.mjs'/.test(src));
  ok('syncWorkFull 里登记在途任务', /gate\.register\(/.test(src));
  ok('同步循环每次写之前询问是否该停手', /gate\.shouldStop\(/.test(src));
  ok('removeWorkFromMemory 删除前先 cancelAndDrain', /await gate\.cancelAndDrain\(/.test(src));
  const drainIdx = src.indexOf('await gate.cancelAndDrain(');
  const removeIdx = src.indexOf('await safeRemove(', drainIdx);
  ok('顺序正确：先排空、后删除', drainIdx > 0 && removeIdx > drainIdx,
    `drain@${drainIdx} remove@${removeIdx}`);
}

console.log(`\n══════════════════════════════`);
console.log(`同步闸门离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
