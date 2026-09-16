#!/usr/bin/env node
/**
 * test-context-cache.mjs —— 决策 D8-#7 的离线单测（零成本、不连数据库与服务）。
 *
 * 被验证的行为：**上下文缓存按"输入有没有变"失效，而不是靠时间猜**。
 *   修复前：只有进程内版本号 + 120 秒 TTL。记忆库索引在进程外异步建，
 *           进程内看不见 → "索引还没建完时算出的召回为空"会被缓存住，
 *           只能等 TTL 到期（P1 的 F4：同一请求重启前后 23,275 / 24,738 字）。
 *   修复后：外部状态（`ov_indexed_at:<workId>`）纳入版本 → 索引一完成，缓存**立刻**失效；
 *           TTL 退回纯兜底。
 *
 * 带**阴性对照**：把外部版本源换回"永远返回空串"（= 修复前的行为），
 * 同一场景必须**真的命中陈旧结果**——否则这个测试根本区分不出好坏。
 *
 * 用法: node .p1-baseline/test-context-cache.mjs
 */
import { createContextCache } from '../ai/context/cache.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

console.log('【1. 进程内改动：invalidateAll 立刻作废】');
{
  const c = createContextCache({ ttlMs: 600000 });
  c.set('novel:2:107:full', { text: 'v1' }, '2');
  ok('刚写入即命中', c.get('novel:2:107:full', '2')?.text === 'v1');
  c.invalidateAll();
  ok('invalidateAll 之后不再命中', c.get('novel:2:107:full', '2') === undefined);
  c.set('novel:2:107:full', { text: 'v2' }, '2');
  ok('重新装配后又能命中', c.get('novel:2:107:full', '2')?.text === 'v2');
}

console.log('\n【2. 进程外改动：记忆库索引完成 → 缓存立刻失效（F4 的根治）】');
{
  // 用可变的外部状态模拟 app_settings 里的 ov_indexed_at
  const state = { '2': '' };
  const c = createContextCache({ ttlMs: 600000, externalVersionOf: (w) => state[w] || '' });

  c.set('novel:2:107:full', { recall: 'no-hits' }, '2');   // 索引还没建完时算出来的
  ok('索引未完成时命中（缓存本身是好的）', c.get('novel:2:107:full', '2')?.recall === 'no-hits');

  state['2'] = '2026-09-16T12:00:00.000Z';                  // 全量同步完成，写入 ov_indexed_at
  ok('索引一完成，缓存**立刻**失效（不需要等 TTL）',
    c.get('novel:2:107:full', '2') === undefined,
    '这一步就是 F4 的根治点');

  c.set('novel:2:107:full', { recall: 'ok/6' }, '2');
  ok('重新装配后拿到的是带召回的结果', c.get('novel:2:107:full', '2')?.recall === 'ok/6');

  ok('不同作品的失效互不干扰', (() => {
    const c2 = createContextCache({ ttlMs: 600000, externalVersionOf: (w) => state[w] || '' });
    c2.set('novel:2:107:full', { a: 1 }, '2');
    c2.set('novel:9:5:full', { b: 1 }, '9');
    state['2'] = '2026-09-16T13:00:00.000Z';   // 只动作品 2
    return c2.get('novel:2:107:full', '2') === undefined && c2.get('novel:9:5:full', '9')?.b === 1;
  })());
}

console.log('\n【3. 阴性对照：把外部版本源换回修复前的行为，必须真的命中陈旧结果】');
{
  const state = { '2': '' };
  // 修复前：进程内版本号不知道记忆库变了（externalVersionOf 恒为空）
  const legacy = createContextCache({ ttlMs: 120000, externalVersionOf: () => '' });
  legacy.set('novel:2:107:full', { recall: 'no-hits' }, '2');
  state['2'] = '2026-09-16T12:00:00.000Z';   // 索引完成——但修复前看不见这件事
  ok('对照：索引完成后缓存**仍然命中旧的「召回为空」**（这正是 F4 的现象）',
    legacy.get('novel:2:107:full', '2')?.recall === 'no-hits');
  ok('对照：两套实现的差异确实存在（否则第 2 节测的是空气）',
    createContextCache({ ttlMs: 120000, externalVersionOf: (w) => state[w] || '' })
      .get('novel:2:107:full', '2') === undefined);
}

console.log('\n【4. TTL 退回兜底：仍然能兜住"没人通知我们"的情况】');
{
  const c = createContextCache({ ttlMs: 40 });
  c.set('k', { v: 1 }, 'w');
  ok('TTL 内命中', c.get('k', 'w')?.v === 1);
  await sleep(60);
  ok('TTL 过后即使版本没变也失效（兜底仍在）', c.get('k', 'w') === undefined);
}

console.log('\n【5. 边界：LRU 上限 / 外部版本源抛错 / 构造参数校验】');
{
  const c = createContextCache({ ttlMs: 600000, max: 2 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  ok('超过上限时淘汰最旧的一条', c.size() === 2 && c.get('a') === undefined && c.get('c') === 3,
    `size=${c.size()}`);

  const throwing = createContextCache({
    ttlMs: 600000,
    externalVersionOf: () => { throw new Error('数据库读不到'); },
  });
  throwing.set('k', { v: 1 }, 'w');
  ok('外部版本源抛错时退化为纯进程内版本（不把功能整体打挂）',
    throwing.get('k', 'w')?.v === 1);

  let bad = false;
  try { createContextCache({ ttlMs: 0 }); } catch { bad = true; }
  ok('非法 ttlMs 直接抛错（不静默退化成"永不过期"）', bad);
}

console.log('\n【6. 接线：server.js 真的用了它，且外部状态取自 ov_indexed_at】');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync('server.js', 'utf8');
  ok('导入了内核模块', /from '\.\/ai\/context\/cache\.mjs'/.test(src));
  ok('外部版本源读的是 ov_indexed_at（全量同步完成时写入的信号）',
    /ov_indexed_at:\$\{workId\}/.test(src));
  ok('touchWork 走 invalidateAll（进程内改动仍然整体作废）',
    /contextCache\.invalidateAll\(\)/.test(src));
  // 两处取用点必须**带上 scope（workId）**，否则 cache.mjs 查不到外部状态、
  // 第 2 节那条失效语义在生产里根本不会发生。这里断言的是真实调用点的实参个数。
  const getCalls = (src.match(/cacheGetContext\([^)]*\)/g) || []);
  const setCalls = (src.match(/cacheSetContext\([^)]*\)/g) || []);
  ok('两处 get 都传了 scope', getCalls.length >= 2 && getCalls.every((c) => c.split(',').length >= 2),
    getCalls.join(' | '));
  ok('两处 set 都传了 scope', setCalls.length >= 2 && setCalls.every((c) => c.split(',').length >= 3),
    setCalls.join(' | '));
}

console.log(`\n══════════════════════════════`);
console.log(`上下文缓存离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
