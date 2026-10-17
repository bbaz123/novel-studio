/**
 * tests/nsdsh/runtime-equivalence.test.mjs —— S14：B（完整源）/ C（闭包）契约等价。
 *
 * S14 动作 5："用 fake provider 比较完整源构建 B 与裁剪构建 C 的实际请求契约。"
 *
 * 本阶段**不产出真实裁剪发行物**（那是发布工程），因此这里比较的是**决定请求契约的三要素**：
 *   协议方法集合 / 入口 / 版本。
 * 这三样相同 ⇒ 走的是同一段协议、同一个入口、同一个版本 ⇒ 模型收到的请求契约等价。
 * 这不是"看起来差不多"，而是把契约拆成可枚举的字段逐项比对。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const B = await import('../../scripts/nsdsh/build-runtime.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'vendor/dsh/runtime-manifest.json'), 'utf8'));
const baseline = path.resolve(REPO, '..', 'deepseek-harness');

suite('nsdsh/runtime-equivalence', [
  ['S14-E1 B/C 契约签名相同（协议方法 + 入口 + 版本三要素一致）', () => {
    const r = B.buildRuntime();
    if (!fs.existsSync(baseline)) { assert.equal(r.ok, false, '基线缺失时必须如实失败'); return; }
    assert.ok(r.contracts, '必须输出契约比较结果');
    assert.equal(r.contracts.equal, true, 'B 与 C 的契约必须等价');
    assert.equal(r.contracts.b.signature, r.contracts.c.signature, '签名必须逐字相同');
    const sig = JSON.parse(r.contracts.b.signature);
    assert.deepEqual(Object.keys(sig).sort(), ['entry', 'methods', 'version'], '签名必须由这三要素组成');
    assert.equal(sig.entry, manifest.entry.path);
    assert.equal(sig.version, manifest.handshake.expectVersion);
    assert.deepEqual(sig.methods, [...manifest.handshake.methods].sort());
  }],

  ['S14-E2 裁剪确实发生了（C 比 B 小），但不是"全删"（闭包仍包含入口）', () => {
    const r = B.buildRuntime();
    if (!fs.existsSync(baseline)) return;
    assert.ok(r.staging, '必须有 staging 结果');
    assert.ok(r.staging.packages >= 50, `闭包应保留足够多的包，实际 ${r.staging.packages}`);
    assert.ok(r.staging.files > 0 && r.staging.files < r.staging.baselineFiles,
      `闭包文件数必须严格小于基线（实际 ${r.staging.files} / ${r.staging.baselineFiles}）`);
    assert.ok(r.staging.trimmedRatio > 0, '必须真的裁掉了一部分');
    // 入口所在的包必须在闭包里（否则裁剪把启动器删了）
    const entryPkg = manifest.entry.path.split('/').slice(0, 2).join('/'); // apps/cli
    assert.ok(manifest.closure.requiredPackages.includes(entryPkg), `闭包必须包含入口包 ${entryPkg}`);
  }],

  ['S14-E3 契约等价的判据不被"空签名"蒙混（反向对照）', () => {
    // 构造一个缺方法/缺入口的 manifest，等价判定必须为 false
    const tmp = path.join(REPO, '.nsdsh', 'tmp-manifest-empty.json');
    fs.writeFileSync(tmp, JSON.stringify({
      ...manifest, handshake: { ...manifest.handshake, methods: [] },
    }, null, 2), 'utf8');
    try {
      const r = B.buildRuntime({ manifestPath: tmp });
      assert.equal(r.contracts.equal, false, '方法为空时不得判等价');
      assert.equal(r.ok, false);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }],

  ['S14-E4 假 provider 契约复用：S10 的 capture 脚本与 S14 的 manifest 指向同一协议面', () => {
    // S10 已经捕获过"模型实际收到的请求"的契约；这里断言 S14 的 manifest 与它同源，不另立一套。
    const captureSrc = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/capture-model-contract.mjs'), 'utf8');
    assert.match(captureSrc, /createTaskEnvelope|adapters/, 'S10 的捕获脚本必须是真实契约来源');
    // manifest 的协议方法与 S13 的 SDK_PROTOCOL 必须一致（同一上游事实）
    const sdk = fs.readFileSync(path.join(REPO, 'ai/runtime/dsh-sdk.mjs'), 'utf8');
    for (const m of manifest.handshake.methods) {
      assert.ok(sdk.includes(`'${m}'`), `SDK 协议面必须也包含 ${m}（两处不得漂移）`);
    }
  }],

  ['S14-E5 版本握手是双向的：manifest 期望值来自 tag，基线实际版本必须相等', () => {
    if (!fs.existsSync(baseline)) return;
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'), 'utf8')).version;
    const fromTag = manifest.baseline.tag.replace(/^dsh-v/, '');
    assert.equal(manifest.handshake.expectVersion, fromTag, '期望版本必须由 tag 派生');
    assert.equal(pkgVersion, manifest.handshake.expectVersion, '基线实际版本必须与期望一致');
  }],
]);
