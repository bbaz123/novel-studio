/**
 * tests/nsdsh/dsh-vendor-provenance.test.mjs —— S11：固定基线的来源可复核。
 *
 * 为什么测试要管"文档与脚本是否一致"：把上游源码当依赖时，最容易悄悄漂移的是**来源**——
 * 有人改了 tag、改了基线、或者在树上打了补丁，而所有功能测试仍然绿。
 * 所以这里钉住三件事：
 *   ① `vendor/dsh/verify-vendor.mjs` 的 `EXPECTED` 与 `PROVENANCE.md` **逐项一致**；
 *   ② 校验脚本**只读**（不 clone / 不 install / 不 build / 不写用户目录）；
 *   ③ 记录里必须写清许可、lockfile、平台边界与"未做什么"（诚实边界）。
 *
 * 本套件**不要求**基线目录必须存在：基线可能在别的机器上。存在时跑一次真实校验，
 * 不存在时只做静态一致性检查，并如实标出"未验证实际基线"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const V = await import('../../vendor/dsh/verify-vendor.mjs').catch(() => null);
const provPath = path.join(REPO, 'vendor/dsh/PROVENANCE.md');
const scriptPath = path.join(REPO, 'vendor/dsh/verify-vendor.mjs');

suite('nsdsh/dsh-vendor-provenance', [
  ['S11-V1 校验脚本与来源记录都存在，且脚本可加载（EXPECTED 可导出）', () => {
    assert.ok(fs.existsSync(scriptPath), '缺少 vendor/dsh/verify-vendor.mjs');
    assert.ok(fs.existsSync(provPath), '缺少 vendor/dsh/PROVENANCE.md');
    assert.ok(V && V.EXPECTED, 'verify-vendor.mjs 必须导出 EXPECTED（供测试与门禁对账）');
    for (const k of ['origin', 'upstream_tag', 'vendor_commit', 'package_version', 'license_file', 'lockfile']) {
      assert.ok(V.EXPECTED[k], `EXPECTED.${k} 不能为空`);
    }
  }],

  ['S11-V2 EXPECTED 与 PROVENANCE.md 逐项一致（改一边就会红）', () => {
    const md = fs.readFileSync(provPath, 'utf8');
    assert.ok(md.includes(V.EXPECTED.origin), `来源记录里必须出现 ${V.EXPECTED.origin}`);
    assert.ok(md.includes(V.EXPECTED.upstream_tag), `来源记录里必须出现上游 tag ${V.EXPECTED.upstream_tag}`);
    assert.ok(md.includes(V.EXPECTED.upstream_commit), `来源记录里必须出现上游 commit ${V.EXPECTED.upstream_commit}`);
    assert.ok(md.includes(V.EXPECTED.vendor_commit), `来源记录里必须出现 vendor commit ${V.EXPECTED.vendor_commit}`);
    assert.ok(md.includes(V.EXPECTED.package_version), `来源记录里必须出现包版本 ${V.EXPECTED.package_version}`);
    assert.ok(md.includes(V.EXPECTED.lockfile), `来源记录必须提到 lockfile ${V.EXPECTED.lockfile}`);
    assert.ok(md.includes(V.EXPECTED.license_file), `来源记录必须提到许可文件 ${V.EXPECTED.license_file}`);
  }],

  ['S11-V3 校验脚本是**只读**的：不得 clone / install / build / 写用户目录', () => {
    const src = fs.readFileSync(scriptPath, 'utf8');
    for (const forbidden of [/git\s+clone/i, /pnpm\s+install/, /npm\s+install/, /pnpm\s+run\s+build/, /sync\s+--delete/]) {
      assert.ok(!forbidden.test(src), `校验脚本不得执行：${forbidden}`);
    }
    // 不得触碰用户全局 DSH 目录（本阶段验收项之一）
    assert.ok(!/\.dsh[/\\]/.test(src), '校验脚本不得读写 ~/.dsh');
    assert.ok(!/homedir\(\)/.test(src), '校验脚本不得展开用户主目录');
    // 写操作只能是 stdout
    assert.ok(!/writeFileSync|appendFileSync|mkdirSync/.test(src), '校验脚本不应写文件');
  }],

  ['S11-V4 来源记录必须包含许可、lockfile、平台边界与"未做什么"', () => {
    const md = fs.readFileSync(provPath, 'utf8');
    assert.match(md, /许可证|LICENSE/, '必须记录许可');
    assert.match(md, /pnpm-lock\.yaml/, '必须记录 lockfile 保留');
    assert.match(md, /typecheck/, '必须记录 typecheck 实测');
    assert.match(md, /build/, '必须记录 build 实测');
    assert.match(md, /lint/, '必须记录 lint 实测');
    // 诚实边界：必须写明没做什么
    assert.match(md, /未覆盖|未做|明确不做/, '必须写明未覆盖项');
    assert.match(md, /平台/, '必须写明平台边界（不能只在开发机"能跑"）');
    // 路径偏差必须显式记录，而不是悄悄按方案原文建空壳
    assert.match(md, /偏差/, '与方案路径不同时必须显式记录偏差');
  }],

  ['S11-V5 记录里给出的三条构建命令与上游 package.json 的脚本名一致', () => {
    const md = fs.readFileSync(provPath, 'utf8');
    const expectedCmds = [...md.matchAll(/`pnpm run (typecheck|build|lint)`/g)].map((m) => m[1]);
    const uniq = [...new Set(expectedCmds)];
    assert.deepEqual(uniq.sort(), ['build', 'lint', 'typecheck'], `记录里的命令应是三条，实际 ${uniq.join(',')}`);
    // EXPECTED 里的 license/lockfile 是相对基线的真实文件名（不是描述性文字）
    assert.match(V.EXPECTED.license_file, /^[A-Za-z0-9._-]+$/);
    assert.match(V.EXPECTED.lockfile, /^[A-Za-z0-9._-]+\.yaml$/);
  }],

  ['S11-V6 基线存在时跑一次真实校验；不存在时如实记录未验证', () => {
    // 直接调用导出的 verify()，**不 spawn 子进程**：
    // 子进程会把 exitCode 泄漏到宿主套件（实测让 runner 把 PASS 6/0 的套件判成失败）。
    assert.equal(typeof V.verify, 'function', 'verify-vendor.mjs 必须导出 verify()');
    const r = V.verify();
    assert.ok(r.expected, '必须输出期望值');
    assert.ok(r.path, '必须记录检查的路径');
    if (fs.existsSync(r.path)) {
      assert.deepEqual(r.problems, [], `基线存在时必须校验通过：${JSON.stringify(r.problems)}`);
      assert.equal(r.actual.package_version, V.EXPECTED.package_version);
      assert.ok(r.actual.license_bytes > 0, '许可文件必须非空');
      assert.ok(r.actual.lockfile_sha256, '必须记录 lockfile 摘要');
      assert.deepEqual(r.actual.build_scripts.slice().sort(), ['build', 'lint', 'typecheck']);
    } else {
      // 基线不在本机：只允许"如实失败"，不允许伪造通过
      assert.ok(r.problems.some((p) => /不存在/.test(p)), '基线缺失时必须报出问题');
    }
  }],
]);
