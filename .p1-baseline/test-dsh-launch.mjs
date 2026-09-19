#!/usr/bin/env node
/**
 * test-dsh-launch.mjs —— `resolveDshLaunch` 的**启动路径选择**（纯函数部分）离线断言。
 *
 * 背景（零计费实测）：`scripts.dsh` 的 `node --import tsx/esm apps/cli/src/bin.ts` 会让
 * **每个任务现场转译一遍 TypeScript**，冷启动 12.6 秒；同一仓库已构建的 `apps/cli/lib/bin.js`
 * 只要 1.9 秒。两条路径组合出的配置 `--dump-config` **逐字相同**（各 398 行、0 差异），
 * 所以改用产物是纯收益。但"用产物"有一个真实风险：**改了源码没重建** → 悄悄跑一份旧 dsh。
 * 这个文件钉的就是那条防陈旧判据（以及"推不出对应关系就别猜"）。
 *
 * 用法：node .p1-baseline/test-dsh-launch.mjs
 */
import path from 'node:path';
import { builtCounterpartOf, shouldUseBuiltEntry } from '../harness.js';

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};
// 断言助手自检（本项目 F7 的教训：助手写错会让条件根本不被求值，于是恒判通过）。
{
  const probe = [];
  const fakeCheck = (n, c) => { if (!c) probe.push(n); };
  fakeCheck('自检', false);
  if (probe.length !== 1) { console.log('FAIL  断言助手自检：假条件没有计入失败'); process.exit(1); }
}

// ---------- 1) 源码入口 → 预构建产物的推导 ----------
// ⚠️ 比较要用 path.normalize：推导内部走 path.join，它会按平台把分隔符归一
//    （首版断言写死了正斜杠，于是在 Windows 上假失败 —— 是测试的期望错了，不是实现错了）。
{
  const norm = (p) => (p === null ? null : path.normalize(p));
  check('1a apps/cli/src/bin.ts → apps/cli/lib/bin.js',
    norm(builtCounterpartOf('C:\\r\\apps\\cli\\src\\bin.ts')) === norm('C:\\r\\apps\\cli\\lib\\bin.js'),
    String(builtCounterpartOf('C:\\r\\apps\\cli\\src\\bin.ts')));
  check('1b POSIX 输入同样能推出对应产物（分隔符按平台归一）',
    norm(builtCounterpartOf('/r/apps/cli/src/bin.ts')) === norm('/r/apps/cli/lib/bin.js'),
    String(builtCounterpartOf('/r/apps/cli/src/bin.ts')));
  check('1c .tsx 也认',
    norm(builtCounterpartOf('/r/apps/cli/src/main.tsx')) === norm('/r/apps/cli/lib/main.js'),
    String(builtCounterpartOf('/r/apps/cli/src/main.tsx')));
  check('1d 推不出对应关系时返回 null（宁可不换，也不猜路径）',
    builtCounterpartOf('/r/apps/cli/bin.ts') === null && builtCounterpartOf('/r/apps/cli/src/sub/bin.ts') === null,
    JSON.stringify([builtCounterpartOf('/r/apps/cli/bin.ts'), builtCounterpartOf('/r/apps/cli/src/sub/bin.ts')]));
}

// ---------- 2) 该不该用产物的真值表 ----------
{
  const T = 1_700_000_000_000;
  check('2a 产物存在且不比源码旧 → 用产物',
    shouldUseBuiltEntry({ builtExists: true, builtMtime: T, srcNewestMtime: T - 1000 }).use === true);
  check('2b 产物不存在 → 走源码',
    shouldUseBuiltEntry({ builtExists: false, builtMtime: NaN, srcNewestMtime: T }).use === false);
  // ★ 这条是防陈旧的核心：改了源码没重建时必须回退，否则会悄悄跑一份旧 dsh。
  const stale = shouldUseBuiltEntry({ builtExists: true, builtMtime: T, srcNewestMtime: T + 1000 });
  check('2c 源码比产物新（改了没重建）→ 回退源码，并说明原因',
    stale.use === false && /没重建/.test(stale.why), stale.why);
  check('2d 时间戳拿不到时**不**换（宁可慢，也不换成不确定的）',
    shouldUseBuiltEntry({ builtExists: true, builtMtime: NaN, srcNewestMtime: T }).use === false
      && shouldUseBuiltEntry({ builtExists: true, builtMtime: T, srcNewestMtime: NaN }).use === false);
  check('2e 显式强制 source → 即使产物可用也走源码',
    shouldUseBuiltEntry({ builtExists: true, builtMtime: T, srcNewestMtime: T, forced: 'source' }).use === false);
  check('2f 显式强制 built → 产物在就用（给"我就想跑产物"留出口）',
    shouldUseBuiltEntry({ builtExists: true, builtMtime: T, srcNewestMtime: T + 9999, forced: 'built' }).use === true);
  check('2g 强制 built 但产物不存在 → 仍然回退（强制不能凭空造出产物）',
    shouldUseBuiltEntry({ builtExists: false, builtMtime: NaN, srcNewestMtime: T, forced: 'built' }).use === false);
}

console.log(`\n=== ${failures.length ? failures.length + ' FAILURES' : 'ALL PASS'} ===  （通过 ${passed} 条）`);
console.log(`
变异锚点（改坏实现应让对应断言变红）：
  · shouldUseBuiltEntry 去掉 "srcNewestMtime > builtMtime" 这条 → 2c 变红（陈旧构建会被静默使用）
  · builtCounterpartOf 把正则放宽成任意 .ts                          → 1d 变红（会去猜一个不存在的路径）`);
if (failures.length) process.exit(1);
