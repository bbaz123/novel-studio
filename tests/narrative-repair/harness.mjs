/**
 * tests/narrative-repair/harness.mjs —— 叙事性专项离线套件的公共断言与加载器（零依赖、零计费）。
 *
 * 纪律（与 tests/temporal/harness.mjs、frontend-test.mjs 一致）：
 *   · 只信断言结果，不信"跑完了"；零用例 → 非零退出（不把"没有测试"当通过）；
 *   · 每个用例有稳定编号（P01…/R01…），便于 implementation-report 的"问题→补丁→用例"覆盖表；
 *   · 公共模块用 UMD 动态 import 挂到 globalThis（本仓库 package.json 是 type:module，
 *     直接 require 会把 .js 当 ESM，拿不到 UMD 导出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 断言收集器。
 *
 * ⚠️ 签名刻意**同时接受两种写法**（2026-10-09：同一类误用在三个套件里复发，改装置而不是改纪律）：
 *   · `check(id, desc, cond, detail)`      —— 本目录原本的写法；
 *   · `check('id 描述', cond, detail)`      —— 仓库 frontend-test 的写法（描述写进第一个参数）。
 * 两者都正确判定 `cond`：误用的形态（描述进 id 位）会让 cond 落成 detail 字符串而**恒真**，
 * 那是最危险的假绿；把装置改成形状自适应，就不会再产生"看起来有断言、其实没在测"的调用。
 */
export function createChecks() {
  let total = 0;
  let failures = 0;
  const rows = [];
  const check = (...args) => {
    let id = '';
    let desc = '';
    let cond;
    let detail = '';
    if (typeof args[1] === 'string') {
      [id, desc, cond, detail = ''] = args;
    } else {
      [id, cond, detail = ''] = args;
    }
    total += 1;
    const ok = !!cond;
    if (!ok) failures += 1;
    rows.push({ id, desc, passed: ok, detail: String(detail == null ? '' : detail) });
    const label = desc ? `${id}  ${desc}` : String(id);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  };
  const finish = (label) => {
    console.log(`\n[${label}] 通过 ${total - failures} / 未通过 ${failures}（共 ${total} 条，零计费）`);
    if (!total) {
      console.error(`✗ ${label}：零用例 —— 拒绝把"没有测试"当作通过。`);
      process.exit(2);
    }
    if (failures) process.exitCode = 1;
    return { total, failures, rows };
  };
  return { check, finish };
}

/** 加载 public/ 下的 UMD 模块（浏览器与 Node 测试共用同一实现）。 */
export async function loadPublicModules() {
  const asUrl = (rel) => 'file://' + path.join(REPO_ROOT, rel).replace(/\\/g, '/');
  await import(asUrl('public/revision-patch.js'));
  await import(asUrl('public/patch-safety.js'));
  return { RP: globalThis.NovelRevisionPatch, K: globalThis.NovelPatchSafety };
}

/** 冻结样本（附录 A/B）的读取：只读，不修改基线。 */
export function loadFixtures() {
  const dir = path.join(REPO_ROOT, 'tests', 'narrative-repair', 'fixtures');
  return {
    dir,
    before: fs.readFileSync(path.join(dir, 'before.txt'), 'utf8'),
    after: fs.readFileSync(path.join(dir, 'after.txt'), 'utf8'),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
  };
}
