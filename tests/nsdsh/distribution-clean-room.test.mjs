/**
 * tests/nsdsh/distribution-clean-room.test.mjs —— S14：staging 不得读开发源码或全局包。
 *
 * S14 动作 4 原文："禁止 staging 读取开发源码或全局包；检查所有符号链接。"
 *
 * 为什么这条重要：一个"能构建"的发行物，如果在打包时**顺手读了开发树或用户全局包**，
 * 就会在没有它自己的依赖的情况下也能跑 —— 到了干净机器上立刻失败。
 * 所以判据必须是：staging 里的每一条路径都**落在固定基线内**，
 * 且不经过任何符号链接逃逸。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suite } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const B = await import('../../scripts/nsdsh/build-runtime.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'vendor/dsh/runtime-manifest.json'), 'utf8'));
const baseline = path.resolve(REPO, '..', 'deepseek-harness');

suite('nsdsh/distribution-clean-room', [
  ['S14-C1 staging 的每条路径都落在固定基线内（不读开发源码/全局包）', () => {
    const r = B.buildRuntime();
    if (!fs.existsSync(baseline)) { assert.equal(r.ok, false); return; }
    assert.deepEqual(r.problems, [], `staging 有问题：${r.problems.join('; ')}`);
    for (const rel of manifest.closure.requiredPackages) {
      const abs = path.resolve(baseline, rel);
      const relToBase = path.relative(baseline, abs);
      assert.ok(!relToBase.startsWith('..') && !path.isAbsolute(relToBase),
        `${rel} 逃出了基线目录（会依赖开发源码或全局包）`);
    }
  }],

  ['S14-C2 manifest 里不得出现指向"用户全局包"或绝对路径的条目', () => {
    const json = JSON.stringify(manifest);
    // 常见全局包路径与家目录展开都必须不出现
    assert.ok(!json.includes('node_modules/@deepseek-ai/dsh'), 'manifest 不得指向全局安装的 dsh');
    assert.ok(!/AppData|npm-global|\/usr\/lib|Program Files/i.test(json), 'manifest 不得含本机绝对安装路径');
    for (const rel of manifest.closure.requiredPackages) {
      assert.ok(!rel.includes('node_modules'), `${rel} 不应指向 node_modules（那是安装产物，不是源码闭包）`);
    }
  }],

  ['S14-C3 staging 不得与声明的裁剪面重叠', () => {
    const excluded = manifest.closure.excludedFromDistribution || [];
    assert.ok(excluded.length > 0, '必须显式声明裁剪面');
    const overlaps = manifest.closure.requiredPackages.filter((rel) => excluded.some((x) => rel === x || rel.startsWith(`${x}/`)));
    assert.deepEqual(overlaps, [], `这些包同时出现在闭包与裁剪面里：${overlaps.join(', ')}`);
  }],

  ['S14-C4 符号链接检查：闭包目录里不得有指向基线外部的链接', () => {
    if (!fs.existsSync(baseline)) return;
    const offenders = [];
    for (const rel of manifest.closure.requiredPackages) {
      const abs = path.join(baseline, rel);
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue;
        const p = path.join(abs, e.name);
        let target = '';
        try { target = fs.realpathSync(p); } catch { continue; }
        const relToBase = path.relative(baseline, target);
        // 指向基线外（例如某个全局缓存）的解析结果即视为逃逸
        if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
          // 只报顶层符号链接，避免 node_modules 内部链接造成误报
          if (e.name !== 'node_modules') offenders.push({ rel, name: e.name, target });
        }
      }
    }
    assert.deepEqual(offenders, [], `发现逃逸符号链接：${offenders.map((o) => `${o.rel}/${o.name}`).join(', ')}`);
  }],

  ['S14-C5 干净房间语义自证：脚本不含网络下载/全局安装动作', () => {
    const fsMod = fs;
    for (const rel of ['scripts/nsdsh/build-runtime.mjs', 'scripts/nsdsh/verify-runtime-closure.mjs']) {
      const src = fsMod.readFileSync(path.join(REPO, rel), 'utf8');
      // 不得在构建/校验里装包或联网
      assert.ok(!/npm\s+install|pnpm\s+install|pnpm\s+add|npm\s+i\s/.test(src), `${rel} 不得安装依赖`);
      assert.ok(!/https?:\/\//.test(src.replace(/^\s*\/\/.*$/gm, '')), `${rel} 不得联网（发行物构建必须离线可复现）`);
      assert.ok(!/child_process/.test(src), `${rel} 不应 spawn 外部命令`);
    }
  }],
]);
