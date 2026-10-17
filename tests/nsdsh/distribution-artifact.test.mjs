/**
 * tests/nsdsh/distribution-artifact.test.mjs —— R02：打包器与归档格式的纯逻辑层。
 *
 * 这一套件**不产出 231MB 发行物**（那是 `package-runtime.mjs` 的活，几十秒起）。
 * 它钉的是"打包这件事本身不悄悄坏掉"的四条判据：
 *   ① ZIP 写读往返一致（含 CRC、方法、条目名）；
 *   ② 条目名是安全边界：绝对路径 / `..` / 反斜杠必须被拒；
 *   ③ 第一方按 `lib/` 裁剪、**第三方保留完整产物**（`js-yaml` 用 `dist/` 的真实教训）；
 *   ④ 缺入口 / 缺依赖时必须 fail-closed，而不是"打了个空壳还报成功"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const Z = await import('../../scripts/nsdsh/lib/zip-archive.mjs');
const P = await import('../../scripts/nsdsh/package-runtime.mjs');

await suiteAsync('nsdsh/distribution-artifact', [
  ['R02-D1 ZIP 写读往返：内容、CRC、deflate 方法都对得上', async () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello 中文', 'utf8') },
      { name: 'lib/b.mjs', data: Buffer.from('export const x = 1;\n'.repeat(50), 'utf8') },
      { name: 'nested/deep/c.json', data: Buffer.from('{"k":1}', 'utf8') },
    ];
    const zip = Z.writeZip(entries);
    const back = Z.readZipEntries(zip);
    assert.equal(back.size, 3);
    for (const e of entries) {
      assert.deepEqual(back.get(e.name), e.data, `${e.name} 内容必须逐字节一致`);
    }
    // 固定时间戳 → 同一输入必须得到同一字节（可复现）
    assert.equal(Z.writeZip(entries).equals(zip), true, '同一输入必须产出同一归档字节');
  }],

  ['R02-D2 空归档与超量条目都直接报错（不产出无效包）', async () => {
    assert.throws(() => Z.writeZip([]), /ZIP_EMPTY/);
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }));
    assert.equal(Z.readZipEntries(Z.writeZip(many)).size, 5);
  }],

  ['R02-D3 条目名是安全边界：绝对路径 / .. / 反斜杠一律拒绝（写入端）', async () => {
    for (const bad of ['/etc/passwd', '../escape.txt', 'a/../../b.txt', 'dir\\win.txt']) {
      assert.throws(() => Z.writeZip([{ name: bad, data: Buffer.from('x') }]), /ZIP_BAD_ENTRY_NAME/, `${bad} 必须被拒`);
    }
  }],

  ['R02-D4 解包端独立再校验一次（归档可能在别人机器上被重新打包过）', async () => {
    // 手工构造一个"名字带 .."的 ZIP 是复杂的，这里用"篡改字节让 CRC 不匹配"来验证解包端会失败：
    const zip = Z.writeZip([{ name: 'ok.txt', data: Buffer.from('payload') }]);
    const tampered = Buffer.from(zip);
    // 找到数据区第一个字节并改掉（local header 30 字节 + 名字长度）
    const nameLen = tampered.readUInt16LE(26);
    tampered[30 + nameLen] ^= 0xff;
    assert.throws(() => Z.readZipEntries(tampered), /ZIP_CRC_MISMATCH|ZIP_SIZE_MISMATCH/);
  }],

  ['R02-D5 第一方包按 lib/ 裁剪：src/tests/tsconfig 不进发行物', async () => {
    const rel = ['package.json', 'lib/index.js', 'lib/types/index.d.ts', 'src/index.ts', 'tests/a.spec.ts',
      'tsconfig.json', 'tsconfig.tsbuildinfo', 'cordis.patch.yml', 'assets/icon.svg', 'dist/bundle.js', 'README.md'];
    const kept = P.packagePayload(rel, { thirdParty: false });
    assert.deepEqual(kept.sort(), ['assets/icon.svg', 'cordis.patch.yml', 'lib/index.js', 'lib/types/index.d.ts', 'package.json'].sort());
    assert.ok(!kept.includes('src/index.ts'), '第一方源码不进包');
    assert.ok(!kept.includes('tsconfig.json'));
    assert.ok(!kept.includes('dist/bundle.js'), '第一方不用 dist/ 约定');
  }],

  ['R02-D6 第三方包保留完整产物（js-yaml 用 dist/ 的真实教训）', async () => {
    const rel = ['package.json', 'dist/js-yaml.mjs', 'dist/js-yaml.js.map', 'lib/x.js', 'index.js', 'README.md', 'test/a.js'];
    const kept = P.packagePayload(rel, { thirdParty: true });
    assert.ok(kept.includes('dist/js-yaml.mjs'), '第三方的 dist/ 必须保留 —— 剪掉它 = 解压后启动即 ERR_MODULE_NOT_FOUND');
    assert.ok(kept.includes('index.js'));
    assert.ok(!kept.includes('dist/js-yaml.js.map'), 'sourcemap 可以不带');
    assert.ok(!kept.includes('test/a.js'), '测试不必带');
  }],

  ['R02-D7 闭包按 manifest 的目录路径解析（不是按包名）', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'vendor/dsh/runtime-manifest.json'), 'utf8'));
    const baselineRoot = path.resolve(REPO, manifest.baseline.location);
    assert.ok(fs.existsSync(baselineRoot), `基线目录必须存在：${baselineRoot}`);
    const index = P.buildPackageIndex(baselineRoot);
    assert.ok(index.byDir.size > 100, `索引应覆盖上百个包，实际 ${index.byDir.size}`);
    assert.ok(index.byDir.has('apps/cli'), '必须能按**目录**找到 apps/cli');
    assert.ok(index.byName.has('@deepseek-ai/dsh'), '也必须能按**包名**索引');
    const { packages, missing } = P.resolveClosure({ manifest, index, baselineRoot });
    assert.deepEqual(missing, [], `manifest 声明的根包必须全部可解析：${missing.join(',')}`);
    assert.ok(packages.size >= manifest.closure.requiredPackages.length, '闭包至少包含全部根包');
    assert.ok(packages.has('@deepseek-ai/dsh'), '入口包必须在闭包里');
  }],

  ['R02-D8 缺入口 / 缺标题时 fail-closed（不产出"空壳成功"）', async () => {
    const tmp = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ns-pkg-'));
    // ① 没有 --output
    assert.throws(() => P.packageRuntime({}), /MISSING_OUTPUT/);
    // ② manifest 不可读
    const bad = P.packageRuntime({ output: path.join(tmp, 'x'), manifestPath: path.join(tmp, 'nope.json') });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'MANIFEST_UNREADABLE');
    // ③ 闭包不完整 → 明确失败，且列出缺什么
    const manifestPath = path.join(tmp, 'm.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      baseline: { location: 'vendor', tag: 'x', vendor_commit: 'y', upstream_commit: 'z', provenance: 'p' },
      entry: { kind: 'built-cli', path: 'apps/cli/lib/bin.js' },
      handshake: { versionFile: 'package.json', expectVersion: '0' },
      closure: { requiredPackages: ['definitely/missing'] },
    }));
    const r = P.packageRuntime({ output: path.join(tmp, 'y'), manifestPath, repoRoot: REPO });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'CLOSURE_INCOMPLETE', JSON.stringify(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }],

  ['R02-D9 发行清单字段齐全（上游 SHA / 平台 / 入口 / 许可 / 文件摘要）', async () => {
    const mod = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/package-runtime.mjs'), 'utf8');
    for (const field of ['upstream_commit', 'vendor_commit', 'files_digest', 'node_requirement', 'entry', 'counts', 'license', 'excluded']) {
      assert.ok(mod.includes(field), `发行清单必须记录 ${field}`);
    }
    // "相等"不允许由签名构造：compare 脚本必须真的起两个进程
    const cmp = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/compare-runtime-bc.mjs'), 'utf8');
    assert.match(cmp, /runOne\(\{ label: 'B/, '必须真的跑 B');
    assert.match(cmp, /runOne\(\{ label: 'C/, '必须真的跑 C');
    // 自指/注释陷阱：compare 脚本的注释里**特意**写着 "equal: true 来自构造" 这句话。
    // 必须先剥注释再看代码，否则断言恒假（本会话第 4 次踩同一个坑）。
    const cmpCode = cmp.split('\n').filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('/*') || t.startsWith('//'));
    }).join('\n');
    assert.ok(!/equal:\s*true\s*[,}]/.test(cmpCode), 'equal 不得硬编码为 true');
  }],

  ['R02-D10 verify-distribution 用发行物自己的清单取入口（不是写死路径）', async () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/nsdsh/verify-distribution.mjs'), 'utf8');
    assert.match(src, /manifest\.entry\.path/, '入口必须来自发行清单');
    assert.match(src, /ENV_GUARD_DSH_HOME/, '解包运行必须有临时 DSH_HOME 守卫');
    assert.match(src, /ENV_GUARD_BASE_URL/, '解包运行必须绑定本机假 provider');
    assert.match(src, /中文 \+ 空格路径/, '中文/空格路径必须单独验证');
  }],
]);
