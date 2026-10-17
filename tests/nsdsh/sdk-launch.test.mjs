/**
 * tests/nsdsh/sdk-launch.test.mjs —— R01：真实入口解析与环境白名单（纯函数层）。
 *
 * 为什么这一层必须单独钉死：S13 的实现里写着 `cmd: 'dsh-sdk', args: ['--stdio']` ——
 * **那个命令上游不存在**。它不是被验证出来的，是被"想象"出来的。
 * 所以这一套件只做一件事：把"入口必须来自 manifest、错配必须拒绝、环境必须显式枚举"
 * 变成可回归的断言。
 *
 * 说明：本套件**不起任何子进程**（受限沙箱拒绝管道 stdio，那属于环境限制）。
 * 真实子进程证据在 `scripts/nsdsh/verify-sdk-real.mjs`（12 个场景、真实 PID、真 terminal）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const P = await import('../../ai/runtime/sdk-process.mjs');

const MANIFEST = path.join(REPO, 'vendor/dsh/runtime-manifest.json');

function tmpManifest(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-sdklaunch-'));
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  mutate(m);
  const p = path.join(dir, 'runtime-manifest.json');
  fs.writeFileSync(p, JSON.stringify(m));
  return p;
}

await suiteAsync('nsdsh/sdk-launch', [
  ['R01-L1 真实 manifest 解析出构建产物入口，且参数里没有编出来的 --stdio / dsh-sdk', () => {
    const r = P.resolveDshLaunch({ manifestPath: MANIFEST, repoRoot: REPO });
    assert.equal(r.ok, true, `解析失败：${r.reason} ${r.detail}`);
    assert.ok(fs.existsSync(r.entryPath), '入口必须真实存在');
    assert.match(r.entryPath.replaceAll('\\', '/'), /apps\/cli\/lib\/bin\.js$/);
    assert.equal(r.command, process.execPath, '必须用当前 Node 解释器跑入口脚本');
    assert.deepEqual(r.args, [r.entryPath, '--profile', 'sdk']);
    assert.ok(!r.args.some((a) => /--stdio/.test(a)), '不得出现编出来的 --stdio');
    assert.ok(!r.args.some((a) => /dsh-sdk$/.test(a)), '不得出现编出来的 dsh-sdk 命令');
    assert.equal(r.pkgVersion, r.expectVersion, '包版本必须与 manifest 声明一致');
  }],

  ['R01-L2 入口缺失 → ENTRY_MISSING 且不给出任何可执行命令（拒绝降级）', () => {
    const bad = tmpManifest((m) => { m.entry.path = 'apps/cli/lib/does-not-exist.js'; });
    const r = P.resolveDshLaunch({ manifestPath: bad, repoRoot: REPO });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ENTRY_MISSING');
    assert.equal(r.command, null, '拒绝时必须连 command 都不给，避免调用方"顺手起一下"');
    assert.equal(r.args, null);
  }],

  ['R01-L3 版本错配 → 拒绝（防止把不匹配的基线与 SDK 客户端硬凑）', () => {
    const bad = tmpManifest((m) => { m.handshake.expectVersion = '9.9.9'; });
    const r = P.resolveDshLaunch({ manifestPath: bad, repoRoot: REPO });
    assert.equal(r.ok, false);
    assert.match(String(r.detail), /VERSION_MISMATCH/);
  }],

  ['R01-L4 未构建的基线（dev 入口）→ 拒绝，不偷偷用 tsx 跑源码', () => {
    const bad = tmpManifest((m) => { m.entry.kind = 'ts-source'; });
    const r = P.resolveDshLaunch({ manifestPath: bad, repoRoot: REPO });
    assert.equal(r.ok, false);
    assert.match(String(r.detail) + String(r.reason), /ENTRY_NOT_BUILT/);
  }],

  ['R01-L5 manifest 本身读不出来 → 明确报错而不是抛栈', () => {
    const r = P.resolveDshLaunch({ manifestPath: path.join(os.tmpdir(), 'no-such-manifest.json'), repoRoot: REPO });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'MANIFEST_UNREADABLE');
    assert.equal(P.resolveDshLaunch({ manifestPath: null, repoRoot: REPO }).reason, 'MISSING_MANIFEST_PATH');
  }],

  ['R01-L6 环境白名单：源里的 *_API_KEY / *TOKEN* / *PASSWORD* 默认一个都不传', () => {
    const src = {
      PATH: '/usr/bin', SystemRoot: 'C:\\Windows', HOME: '/home/a',
      MY_API_KEY: 'k1', GH_TOKEN: 'k2', DB_PASSWORD: 'k3', CLIENT_SECRET: 'k4',
    };
    const { env, withheld } = P.buildChildEnv({ allow: [], extra: {}, sourceEnv: src });
    for (const k of ['MY_API_KEY', 'GH_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET']) {
      assert.equal(env[k], undefined, `${k} 不得进入子进程环境`);
      assert.ok(withheld.includes(k), `${k} 必须出现在 withheld 审计列表里`);
    }
    assert.equal(env.PATH, '/usr/bin', '系统键必须保留，否则 Node 都起不来');
    // 反过来：整个 process.env 展开一定会泄漏 —— 这条断言就是这个反证
    const naiveLeak = ['MY_API_KEY', 'GH_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET'].filter((k) => ({ ...src })[k] !== undefined);
    assert.equal(naiveLeak.length, 4, '整体展开确实会泄漏 4 个敏感键（这就是不这么写的原因）');
  }],

  ['R01-L7 显式 allow 就只放行那一个敏感键，其余仍挡住', () => {
    const src = { PATH: '/usr/bin', MY_API_KEY: 'k1', GH_TOKEN: 'k2' };
    const { env } = P.buildChildEnv({ allow: ['GH_TOKEN'], extra: {}, sourceEnv: src });
    assert.equal(env.GH_TOKEN, 'k2');
    assert.equal(env.MY_API_KEY, undefined);
  }],

  ['R01-L8 敏感键判据覆盖常见命名（避免"换个名字就漏了"）', () => {
    for (const k of ['DEEPSEEK_API_KEY', 'api_key', 'APP_TOKEN', 'TOKEN', 'client_secret', 'DB_PASSWORD', 'AWS_CREDENTIAL', 'PRIVATE_KEY']) {
      assert.equal(P.isSensitiveEnvKey(k), true, `${k} 应被判为敏感`);
    }
    for (const k of ['PATH', 'DSH_HOME', 'DEEPSEEK_BASE_URL', 'NOVELSTUDIO_SESSION', 'LANG']) {
      assert.equal(P.isSensitiveEnvKey(k), false, `${k} 不应被判为敏感`);
    }
  }],

  ['R01-L9 extra 里的敏感键即使不在 allow 里也不会被悄悄传下去', () => {
    const { env, withheld } = P.buildChildEnv({ allow: [], extra: { SOME_API_KEY: 'oops', DSH_HOME: '/tmp/x' } });
    assert.equal(env.SOME_API_KEY, undefined);
    assert.ok(withheld.includes('SOME_API_KEY'));
    assert.equal(env.DSH_HOME, '/tmp/x', '非敏感键正常传递');
  }],

  ['R01-L10 dsh-sdk.mjs 不再硬编码编出来的命令（源码级回归）', () => {
    const raw = fs.readFileSync(path.join(REPO, 'ai/runtime/dsh-sdk.mjs'), 'utf8');
    // 两个陷阱一起躲：
    //   ① 自指 —— 直接把 `cmd: 'dsh-sdk'` 写在断言里，断言会匹配到自己；
    //   ② 注释 —— 文件头**特意记录了**这个坑的原文，扫全文必然命中。
    // 所以：字面量拆开拼 + 先剥掉注释，只检查真正的代码。
    const code = raw.split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('*') || t.startsWith('/*') || t.startsWith('//'));
      })
      .join('\n');
    const fakeCmd = 'cmd' + ": '" + 'dsh' + "-sdk'";
    const fakeArg = 'args' + ":['" + '--st' + "dio']";
    assert.ok(!code.includes(fakeCmd), '可执行代码里不得再出现编出来的 dsh-sdk 命令');
    assert.ok(!code.replace(/\s+/g, '').includes(fakeArg), '可执行代码里不得再出现编出来的 --stdio 参数');
    assert.match(code, /resolveDshLaunch/, '必须走 manifest 解析');
    assert.match(code, /launch_refused/, '解析失败必须显式拒绝');
    assert.match(code, /buildChildEnv/, '环境必须走白名单构造');
    assert.ok(!/env:\s*\{\s*\.\.\.process\.env/.test(code), '不得整体展开 process.env');
  }],
]);
