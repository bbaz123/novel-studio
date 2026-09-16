#!/usr/bin/env node
/**
 * test-snapshot.mjs —— 快照工具的离线单测（零成本、不碰真实产物）。
 *
 * 为什么要有它：备份工具最危险的失败模式是**排除过宽**——静默漏掉源码，
 * 而"快照成功"依然报绿；等到真要回滚时才发现少了东西。
 * 所以这里两条都钉：该排除的必须排除（尤其数据库与密钥），该包含的必须包含。
 *
 * 用法: node .p6-cutover/test-snapshot.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isExcluded, fingerprintDir, sha256File, EXCLUDES, REPO, headCommit } from './snapshot.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. 该排除的必须排除（数据库与密钥绝不可进快照）】');
{
  const mustExclude = [
    'data/novel.db',
    'data/novel.db-wal',
    'data/logs/app-2026-09-15.log',
    '.p1-baseline/data/novel.db',
    '.p1-baseline/stress-data/novel.db',
    '.p1-baseline/baselines-p5-real/w2-c107.json',
    '.p1-baseline/gate-data/novel.db',
    '.p1-baseline/.rehearsal/20260915140737/harness.js.copy',
    '.p6-cutover/.rehearsal/20260915140737/harness.js.copy',
    '.p6-cutover/.verify/20260915141829/server.js',
    '.p1-baseline/blackhole-gate.jsonl',
    '.p1-baseline/gate-env.json',
    'node_modules/foo/index.js',
  ];
  for (const p of mustExclude) {
    ok(`排除 ${p}`, typeof isExcluded(p) === 'string', String(isExcluded(p)));
  }
  ok('data/ 的排除理由里点明了密钥/正文风险',
    /Key|正文/.test(isExcluded('data/novel.db') || ''), isExcluded('data/novel.db'));
}

console.log('\n【2. 该包含的必须包含（排除过宽 = 静默漏源码）】');
{
  const mustInclude = [
    'server.js', 'harness.js', 'db.js', 'public/app.js',
    'ai/policy.mjs', 'ai/context/layers.mjs', 'ai/context/assembler.mjs',
    'ai/harness-env.mjs', 'ai/edit-distance.mjs',
    'docs/ai-core.md', 'docs/context-contract.md', 'docs/p4-policy-verification.md',
    '.p1-baseline/verify-all.mjs', '.p1-baseline/README.md',
    '.p6-cutover/cutover.mjs', '.p6-cutover/snapshot.mjs', '.p6-cutover/README.md',
    'harness-plugins/novel-writing/package.json',
    'harness-plugins/novel-writing/cordis.patch.yml',
    'harness-plugins/novel-writing/install-profile.mjs',
    '.p0-recon/verify-harness-profile.mjs', '.p0-recon/README.md',
  ];
  for (const p of mustInclude) {
    ok(`包含 ${p}`, isExcluded(p) === null, `被排除了：${isExcluded(p)}`);
  }
}

console.log('\n【3. 排除规则本身要有理由（不能有"裸排除"）】');
{
  const noReason = EXCLUDES.filter((e) => !e.reason || e.reason.length < 4);
  ok('每条排除规则都写了原因', noReason.length === 0, JSON.stringify(noReason.map((e) => e.prefix)));
  ok('没有排除整个仓库根（否则快照会变成空壳）', !EXCLUDES.some((e) => e.prefix === '/' || e.prefix === ''));
}

console.log('\n【4. 目录指纹：文件数/字节数/内容指纹】');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'aaa');
  fs.writeFileSync(path.join(tmp, 'sub', 'b.txt'), 'bbbb');
  const f1 = fingerprintDir(tmp);
  ok('文件数正确', f1.files === 2, JSON.stringify(f1));
  ok('字节数正确', f1.bytes === 7, JSON.stringify(f1));
  ok('指纹是 16 位十六进制', /^[0-9a-f]{16}$/.test(f1.digest), f1.digest);
  const again = fingerprintDir(tmp);
  ok('同一目录指纹稳定', again.digest === f1.digest);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'aaaa');
  const f2 = fingerprintDir(tmp);
  ok('文件大小变化 → 指纹变化', f2.digest !== f1.digest, `${f1.digest} → ${f2.digest}`);
  ok('不存在的目录 → null', fingerprintDir(path.join(tmp, 'nope')) === null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n【5. 已有快照的 manifest 自洽（没有就跳过）】');
{
  const dataDir = path.join(process.cwd(), 'data');
  const snaps = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((n) => n.startsWith('backup-p0p6-')).map((n) => path.join(dataDir, n))
    : [];
  if (!snaps.length) {
    console.log('  – 还没有快照，跳过（跑 --create 后本条才会生效）');
  } else {
    const latest = snaps.sort().at(-1);
    const mf = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8'));
    ok('manifest 有 entries', Array.isArray(mf.entries) && mf.entries.length > 0, `entries=${mf.entries?.length}`);
    ok('记录了 HEAD', /^[0-9a-f]{40}$/.test(mf.head || ''), mf.head);
    const badHash = mf.entries.filter((e) => e.kind !== 'tracked-deleted' && !/^[0-9a-f]{64}$/.test(e.sha256 || ''));
    ok('每条都有合法 sha256', badHash.length === 0, badHash.slice(0, 3).map((e) => e.path).join(','));
    ok('声明了还原方式，并指明用 files/ 做字节级还原',
      /files\//.test(mf.restoreNote || '') && /autocrlf|CRLF/i.test(mf.restoreNote || ''), mf.restoreNote);
    ok('被排除项都记了原因', (mf.excluded || []).every((x) => x.reason));
    // 快照里的整文件副本必须与 manifest 里的哈希自洽
    const sample = mf.entries.find((e) => e.kind === 'untracked-new');
    if (sample) {
      const p = path.join(latest, 'files', sample.path);
      ok('抽样：副本的哈希与 manifest 相符',
        fs.existsSync(p) && sha256File(p) === sample.sha256, sample.path);
    }
  }
}

console.log('\n【6. --verify 的两级判定与阴性对照（每个新判定都要能证明它会失败）】');
{
  // 判定 A = 快照自洽（副本 vs manifest 哈希），与工作区无关，决定退出码；
  // 判定 B = 是否仍与当前工作区一致，只告警。
  // 这里造一份**合成快照**，分别制造"只 B 不成立"和"A 不成立"两种局面。
  const { execFileSync } = await import('node:child_process');
  const head = headCommit();
  const target = 'docs/README.md';
  const workContent = fs.readFileSync(path.join(REPO, target));
  const runVerify = (snapDir) => {
    try {
      const out = execFileSync(process.execPath, ['snapshot.mjs', '--verify', snapDir],
        { cwd: path.join(REPO, '.p6-cutover'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  };
  const makeSnap = (dir, copyBuf, declaredSha) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'files', path.dirname(target)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', target), copyBuf);
    fs.writeFileSync(path.join(dir, 'changes.patch'), '');   // 空补丁：本组只测哈希判定
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      createdAt: new Date().toISOString(), head, coreAutocrlf: '', patchBytes: 0, patchSha256: '',
      restoreNote: 'x', entries: [{ path: target, kind: 'tracked-modified', sha256: declaredSha, size: copyBuf.length }],
      excluded: [], skippedFiles: [],
    }, null, 2));
  };

  const tmpRoot = path.join(REPO, '.p6-cutover', '.verify', 'negctl');
  const snapStale = path.join(tmpRoot, 'stale');
  const snapBroken = path.join(tmpRoot, 'broken');

  // 对照 1：副本与 manifest 自洽（A ✓），但与工作区不同（B ✗）→ 必须 exit 0
  const { createHash } = await import('node:crypto');
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  const altered = Buffer.concat([workContent, Buffer.from('\n// negctl\n')]);
  makeSnap(snapStale, altered, sha(altered));
  const r1 = runVerify('.p6-cutover/.verify/negctl/stale');
  ok('对照1：仅"与工作区不同"时判为过期、退出码 0（不把完好的历史快照判成损坏）',
    r1.code === 0 && /与当前工作区不同/.test(r1.out) && /快照自洽/.test(r1.out),
    `exit=${r1.code}`);

  // 对照 2：副本与 manifest **不符**（A ✗）→ 必须 exit 1
  makeSnap(snapBroken, altered, 'f'.repeat(64));
  const r2 = runVerify('.p6-cutover/.verify/negctl/broken');
  ok('对照2：副本哈希不符时判为损坏、退出码 1（真损坏不会被"工作区恰好没改"掩盖）',
    r2.code === 1 && /快照损坏/.test(r2.out) && /副本与记录哈希不符/.test(r2.out),
    `exit=${r2.code} out=${r2.out.slice(-120)}`);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n══════════════════════════════`);
console.log(`快照工具离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
