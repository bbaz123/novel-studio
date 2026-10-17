/**
 * tests/nsdsh/distribution-closure.test.mjs —— S14：依赖闭包与 manifest（修 F10）。
 *
 * F10：`isHarnessBuilt()` 只看两个生成文件在不在。S14 把"就绪"换成
 * **manifest + 明确入口 + 版本/协议握手**。本套件钉住 manifest 本身的完整性：
 *   · 与 `PROVENANCE.md` 记录的基线一致；
 *   · 闭包里的每个包都真的在基线里（不是手抄的想象清单）；
 *   · 协议方法只用上游真实存在的（不发明 API）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const V = await import('../../scripts/nsdsh/verify-runtime-closure.mjs');
const manifestPath = path.join(REPO, 'vendor/dsh/runtime-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

suite('nsdsh/distribution-closure', [
  ['S14-D1 manifest 记录了基线，且与 PROVENANCE.md 逐项一致', () => {
    const prov = fs.readFileSync(path.join(REPO, 'vendor/dsh/PROVENANCE.md'), 'utf8');
    assert.ok(manifest.baseline, 'manifest 必须有 baseline');
    for (const k of ['tag', 'vendor_commit']) {
      const v = String(manifest.baseline[k] || '');
      assert.ok(v, `baseline.${k} 不能为空`);
      assert.ok(prov.includes(v), `PROVENANCE.md 必须记录 ${k}=${v}`);
    }
    assert.match(String(manifest.baseline.provenance || ''), /PROVENANCE/, 'manifest 必须指回来源记录');
  }],

  ['S14-D2 闭包不是手抄：每个 requiredPackage 都真的存在于基线', () => {
    const baseline = path.resolve(REPO, '..', 'deepseek-harness');
    const required = manifest.closure.requiredPackages;
    assert.ok(Array.isArray(required) && required.length >= 50, `闭包应有足够多的包，实际 ${required?.length}`);
    const missing = required.filter((rel) => !fs.existsSync(path.join(baseline, rel)));
    assert.deepEqual(missing, [], `闭包里这些包不存在：${missing.join(', ')}`);
    // 每个条目必须是相对路径，且指向一个含 package.json 的目录
    for (const rel of required) {
      assert.ok(!path.isAbsolute(rel), `${rel} 不能是绝对路径`);
      const pj = path.join(baseline, rel, 'package.json');
      assert.ok(fs.existsSync(pj), `${rel} 下必须有 package.json`);
    }
  }],

  ['S14-D3 协议握手只声明上游真实方法（与 SDK 真实协议面一致）', () => {
    const methods = [...(manifest.handshake.methods || [])].sort();
    // 上游 HarnessSdkRequestMap 的全部请求方法（S13 已核对过的真实协议面）
    assert.deepEqual(methods, ['initialize', 'session/prompt', 'shutdown'],
      `协议方法必须与上游一致，实际 ${methods.join(',')}`);
    assert.equal(manifest.handshake.expectVersion, manifest.baseline.tag.replace(/^dsh-v/, ''),
      '期望版本必须由 tag 派生（dsh-v0.1.7-rc.1 → 0.1.7-rc.1）');
  }],

  ['S14-D4 入口优先构建产物；manifest 明确写了"只有 dev 入口不算已构建"', () => {
    assert.equal(manifest.entry.path, 'apps/cli/lib/bin.js', '发行物入口必须是构建产物');
    assert.ok(manifest.entry.devEntry, '必须同时记录 dev 入口，便于区分"未构建"');
    assert.match(String(manifest.entry.note || ''), /未构建|发行物/, '必须写明"只有 dev 入口说明尚未构建"');
  }],

  ['S14-D5 真实校验函数 11 项全绿（基线存在时）', () => {
    const baseline = path.resolve(REPO, '..', 'deepseek-harness');
    const r = V.verifyClosure();
    if (!fs.existsSync(baseline)) {
      assert.equal(r.ok, false, '基线缺失时必须如实失败');
      return;
    }
    assert.deepEqual(r.checks.filter((c) => !c.ok), [], `未通过项：${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
    assert.equal(r.ok, true);
    assert.ok(r.checks.length >= 10, `校验项应有 10 项以上，实际 ${r.checks.length}`);
    // 许可必须被检查到
    assert.ok(r.checks.some((c) => /许可/.test(c.name) && c.ok));
    // 越界检查必须存在且通过
    assert.ok(r.checks.some((c) => /基线目录内/.test(c.name) && c.ok));
  }],
]);
