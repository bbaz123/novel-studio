#!/usr/bin/env node
/**
 * test-gate-assert.mjs —— 闸门检查的**离线**阴性对照测试（零成本、不建任何任务）。
 *
 * 为什么需要：2026-09-15 事故的教训是「检查本身不可信」——
 *   1. 429 只断言状态码 → 上游 provider 限流也会被路由映射成 429，
 *      「被限流」被误判成「被闸门拦住」；
 *   2. 「槽位已满」是有寿命的前置条件 → 作业结束后放行是合法的，却被判成失败。
 * 这两条都是**断言逻辑**的问题，可以在完全不碰网络的前提下用假输入测出来。
 * 所以这里给每条断言都喂「应该失败」的输入：过不了这一步的检查等于没有。
 *
 * 用法: node .p1-baseline/test-gate-assert.mjs
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { startBlackhole, readBlackholeLog } from './blackhole.mjs';
import {
  classifyBlockedProbe, classifyIdleProbe, classifyEnvMatch, classifyBlackholeProof,
  isGateRejection, portOfBase, GATE_LIMIT,
} from './verify-harness-gate.mjs';
import { countRealCallsSince } from './audit-llm-calls.mjs';

const GATE_BODY = JSON.stringify({ ok: false, error: `已有任务运行中，请稍后再试（并发上限 ${GATE_LIMIT}）` });
const PROVIDER_429 = JSON.stringify({ error: 'Rate limit reached for deepseek-flash in organization org-x' });

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. isGateRejection：必须区分「闸门 429」与「上游 429」】');
ok('闸门 429 + 闸门文案 → true', isGateRejection(429, GATE_BODY) === true);
ok('上游限流 429（无闸门文案）→ false', isGateRejection(429, PROVIDER_429) === false,
  '若为 true，就会把 provider 限流误判成闸门拦住');
ok('429 但并发上限数字不符 → false', isGateRejection(429, GATE_BODY, 3) === false);
ok('202 接受 → false', isGateRejection(202, JSON.stringify({ ok: true, job_id: 'x' })) === false);
ok('404 → false', isGateRejection(404, JSON.stringify({ error: '作品不存在' })) === false);
ok('空响应体 → false', isGateRejection(429, '') === false);

console.log('\n【2. classifyBlockedProbe：闸门裁决】');
{
  const d = classifyBlockedProbe({ status: 429, body: GATE_BODY, loadBefore: GATE_LIMIT });
  ok('槽位满 + 闸门 429 → pass', d.verdict === 'pass', d.reason);
}
{
  const d = classifyBlockedProbe({ status: 0, body: '', loadBefore: GATE_LIMIT, hung: true });
  ok('请求挂起（真的开始跑了）→ fail', d.verdict === 'fail', d.reason);
}
{
  const d = classifyBlockedProbe({ status: 202, body: '{"ok":true}', loadBefore: GATE_LIMIT });
  ok('槽位满却放行（202）→ fail', d.verdict === 'fail', d.reason);
}
{
  const d = classifyBlockedProbe({ status: 202, body: '{"ok":true}', loadBefore: GATE_LIMIT - 1 });
  ok('调用前槽位就没满 → retry（放行是合法的，不可判失败）', d.verdict === 'retry', d.reason);
}
{
  const d = classifyBlockedProbe({ status: 429, body: PROVIDER_429, loadBefore: GATE_LIMIT });
  ok('槽位满但 429 不是闸门文案 → retry（不可判过）', d.verdict === 'retry', d.reason);
}
{
  const d = classifyBlockedProbe({ status: 429, body: GATE_BODY, loadBefore: 0 });
  ok('负载为 0 时收到闸门文案 → retry（前置不成立，不轻信）', d.verdict === 'retry', d.reason);
}

console.log('\n【3. classifyIdleProbe：空载不应被拦】');
{
  const d = classifyIdleProbe({ status: 404, body: JSON.stringify({ error: '作品不存在' }) });
  ok('空载 404 → pass', d.verdict === 'pass', d.reason);
}
{
  const d = classifyIdleProbe({ status: 429, body: GATE_BODY });
  ok('空载收到闸门 429 → fail（计数泄漏/上限算错）', d.verdict === 'fail', d.reason);
}

console.log('\n【3b. 环境吻合闸：打错实例必须被抓出来】');
{
  const marker = { port: 3741, dataDir: '.p1-baseline/gate-data' };
  ok('端口一致 → pass', classifyEnvMatch(marker, 'http://127.0.0.1:3741').verdict === 'pass');
  const d = classifyEnvMatch(marker, 'http://127.0.0.1:3739');
  ok('测试指向 3739 但登记实例在 3741 → fail（事故根因）', d.verdict === 'fail', d.reason);
  ok('缺 marker → fail', classifyEnvMatch(null, 'http://127.0.0.1:3741').verdict === 'fail');
  ok('portOfBase 解析端口', portOfBase('http://127.0.0.1:3741') === 3741);
  ok('portOfBase 容忍脏输入（不抛异常）', Number.isNaN(portOfBase('not-a-url')));
}

console.log('\n【3c. 证明闸：没有黑洞流量就不许判过】');
{
  const d = classifyBlackholeProof([]);
  ok('零连接 → fail（失败关闭）', d.verdict === 'fail', d.reason);
  const d2 = classifyBlackholeProof([{ ts: 'x', firstBytes: 'POST /chat/completions' }]);
  ok('有连接 → pass', d2.verdict === 'pass', d2.reason);
  ok('非数组 → fail', classifyBlackholeProof(null).verdict === 'fail');
}

console.log('\n【4. 真实调用探测器：两个方向都要能测出来】');
{
  // 阳性对照：已知有真实调用的历史窗口（2026-09-15T13:12:40Z 起共 5 条）
  const past = countRealCallsSince(new Date('2026-09-15T13:12:40Z').getTime());
  ok(`历史窗口能检出真实调用（检出 ${past.real} 条）`, past.real > 0,
    '若为 0，说明探测器是坏的，跑后闸形同虚设');
  // 阴性对照：未来的窗口必然为空
  const future = countRealCallsSince(Date.now() + 3600 * 1000);
  ok('未来窗口检出 0 条（无调用时不会误报）', future.real === 0, `real=${future.real}`);
}

console.log('\n【5. 前置闸：未授权时必须拒绝运行（子进程实测）】');
{
  const env = { ...process.env };
  delete env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED;
  const r = spawnSync(process.execPath, ['.p1-baseline/verify-harness-gate.mjs', 'http://127.0.0.1:1'],
    { encoding: 'utf8', env, timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('未授权 → exit 2', r.status === 2, `实际 exit=${r.status}`);
  ok('未授权 → 打印拒绝说明', out.includes('拒绝运行'), out.slice(0, 120));
  ok('未授权 → 未创建任何作业（无 job_id 输出）', !out.includes('job_id'), '');
}
{
  const r = spawnSync(process.execPath, ['.p1-baseline/verify-harness-gate.mjs'],
    { encoding: 'utf8', timeout: 60000 });
  ok('缺 base 参数 → exit 2 并给用法', r.status === 2 && `${r.stdout}${r.stderr}`.includes('用法'),
    `exit=${r.status}`);
}
{
  // 预检路径必须能跑完（不需要授权、不建作业）。指向一个必然连不上的端口：
  // 期望它**报出问题并退出 1**，而不是抛 ReferenceError 崩掉。
  // （第一版预检就漏了 `net` 导入，靠这一条才抓得到——纯语法检查看不见运行时引用错误。）
  const r = spawnSync(process.execPath,
    ['.p1-baseline/verify-harness-gate.mjs', 'http://127.0.0.1:1', '--preflight'],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env,
      NOVELSTUDIO_GATE_CONFIRMED_ISOLATED: '1' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  ok('预检在不可达实例上不崩溃（无 ReferenceError）', !out.includes('ReferenceError'),
    out.split(/\r?\n/).slice(0, 3).join(' | '));
  ok('预检报出问题并 exit 1', r.status === 1, `exit=${r.status}`);
  ok('预检无需授权即可运行（不被前置闸拦）', !out.includes('拒绝运行'), '');
  // 第一版预检忘记 exit，跑完**穿透**进正式流程并绕过了授权闸。
  // 「闸门上限：」只在正式流程里打印，用它作为「有没有穿透」的判据。
  ok('预检**不得**穿透进正式流程（即便已授权）', !out.includes('闸门上限'),
    '检测到正式流程的输出，说明预检没有结束进程');
}

console.log('\n【6. 黑洞端点：真接受连接、真不响应、真留证】');
{
  const tmpLog = path.join('.p1-baseline', '.blackhole-selftest.jsonl');
  fs.rmSync(tmpLog, { force: true });
  const bh = await startBlackhole({ port: 0, logPath: tmpLog });
  const t0 = Date.now();
  const sock = net.connect(bh.port, '127.0.0.1');
  const connected = await new Promise((resolve) => {
    sock.once('connect', () => resolve(true));
    sock.once('error', () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  ok('黑洞端点接受连接', connected === true, `port=${bh.port}`);

  let received = 0;
  sock.on('data', (d) => { received += d.length; });
  sock.write('POST /chat/completions HTTP/1.1\r\nHost: blackhole\r\nContent-Length: 2\r\n\r\n{}');
  await new Promise((s) => setTimeout(s, 1500));
  ok('黑洞端点**从不**回写任何字节（否则就成了真端点）', received === 0, `收到 ${received} 字节`);

  const conns = readBlackholeLog(tmpLog, t0);
  ok('连接被记录进日志', conns.length >= 1, `记录 ${conns.length} 条`);
  ok('记录里带首字节取证（可看出是真 LLM 请求）',
    /POST \/chat\/completions/.test(conns[0]?.firstBytes || ''), `firstBytes=${conns[0]?.firstBytes || '(空)'}`);
  ok('阴性对照：未来窗口读到 0 条', readBlackholeLog(tmpLog, Date.now() + 3600 * 1000).length === 0);

  sock.destroy();
  await bh.close();
  fs.rmSync(tmpLog, { force: true });
}

console.log(`\n══════════════════════════════`);
console.log(`闸门断言离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
