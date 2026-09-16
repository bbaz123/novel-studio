#!/usr/bin/env node
/**
 * test-cutover.mjs —— P6 切换器的离线单测（零成本、不动任何真实产物）。
 *
 * 为什么要有它：切换器最危险的失败方式是**静默无效**——锚点没命中却"成功"了，
 * 或者彩排偷偷改了真实文件。这两类都必须在没有真实切换的前提下就能测出来。
 *
 * 覆盖的坑（都是实际踩过或差点踩到的）：
 *   1. **CRLF**：本仓库源码是 CRLF，锚点若用 `\n` 拼接就匹配不上（第一次预检就栽在这）；
 *   2. **锚点漂移**：源码一变，替换数不等于 1，必须**失败而不是静默跳过**；
 *   3. **幂等**：对已完成态再跑必须被拒绝；
 *   4. **安全网**：真实产物哈希在流程前后必须一致；
 *   5. **令牌**：由改动内容派生，改内容就换令牌（不看清单拿不到令牌）。
 *
 * 用法: node .p6-cutover/test-cutover.mjs
 */
import fs from 'node:fs';
import {
  EDITS, HARNESS_JS, applyEdits, adaptEol, detectState, confirmToken, backupPlan, sha256File,
} from './cutover.mjs';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

console.log('【1. 与真实源码同步：按当前状态分别断言】');
// ⚠️ 这一节必须在**两种状态下都成立**：
//   pre-cutover ：锚点全部命中（切换器与源码同步，随时可切）
//   post-cutover：锚点**本就不该命中**（已经切过了），此时要断言的是"切换已完成"这件事
// 2026-09-16 执行 P6 之后，本文件原先只断言前者，于是切换完成反而把测试搞红了——
// 测试的前提必须跟着被验证对象的状态走，不能写死一种。
const real = fs.readFileSync(HARNESS_JS, 'utf8');
{
  const st = detectState(real);
  ok('真实文件处于可切换状态（pre/post，而非 mixed/unknown）',
    st === 'pre-cutover' || st === 'post-cutover', `实际 ${st}`);
  if (st === 'pre-cutover') {
    const r = applyEdits(real);
    ok(`pre-cutover：${EDITS.length} 处锚点各命中 1 次（随时可切）`, r.ok === true,
      r.ok ? '' : `「${r.failed?.name}」命中 ${r.failed?.found} 次 —— 源码漂移了，先修切换器`);
  } else {
    const r = applyEdits(real);
    ok('post-cutover：锚点已不匹配（这正是"已切换"的证据）', r.ok === false);
    ok('post-cutover：默认返回值是 novel', /if \(!raw\) return 'novel';/.test(real));
    ok('post-cutover：非法值的兜底也回 novel', /已回退 novel/.test(real) && !/已回退 headless/.test(real));
  }
}

console.log('\n【2. 行尾：CRLF 与 LF 都要能匹配（第一次预检就栽在 CRLF）】');
{
  const lf = "a\n  if (!raw) return 'headless';\nb\n";
  const crlf = lf.replace(/\n/g, '\r\n');
  ok('adaptEol 把 LF 锚点转成 CRLF', adaptEol('x\ny', '\r\n') === 'x\r\ny');
  ok('adaptEol 对 LF 目标不改动', adaptEol('x\ny', '\n') === 'x\ny');
  const one = [EDITS[0]];
  const rLf = applyEdits(lf, one);
  const rCrlf = applyEdits(crlf, one);
  ok('LF 源可匹配并替换', rLf.ok === true && rLf.text.includes("return 'novel';"));
  ok('CRLF 源可匹配并替换（若这条失败，真实源码必然匹配不上）',
    rCrlf.ok === true && rCrlf.text.includes("return 'novel';"), rCrlf.ok ? '' : '未命中');
  ok('CRLF 替换后仍保持 CRLF 行尾（不能把整文件行尾改掉）',
    rCrlf.ok && !rCrlf.text.includes('\n\n') && rCrlf.text.includes('\r\n'));
}

console.log('\n【3. 锚点漂移必须失败，不能静默无效】');
{
  const one = [EDITS[0]];
  const r = applyEdits('nothing to match here\n', one);
  ok('无命中 → ok:false', r.ok === false);
  ok('报出命中次数 0', r.failed?.found === 0, `found=${r.failed?.found}`);
  const dup = "  if (!raw) return 'headless';\n  if (!raw) return 'headless';\n";
  const r2 = applyEdits(dup, one);
  ok('命中 2 次也拒绝（不猜哪个才对）', r2.ok === false && r2.failed?.found === 2, `found=${r2.failed?.found}`);
}

console.log('\n【4. 幂等：已完成态再跑必须被拒绝】');
{
  // 幂等这条性质与"真实文件当前处于哪一态"无关，所以两种态都要能验。
  const applied = applyEdits(real);
  if (applied.ok) {
    const again = applyEdits(applied.text);
    ok('对 post-cutover 文本再跑 → ok:false', again.ok === false, again.ok ? '竟又成功了一次' : '');
    ok('detectState 识别 post-cutover', detectState(applied.text) === 'post-cutover');
  } else {
    // 已经切过了：用一段**合成**的 pre-cutover 文本验证同一条性质
    const one = [EDITS[0]];
    const first = applyEdits("  if (!raw) return 'headless';\n", one);
    const second = applyEdits(first.text, one);
    ok('已切换：用合成样本验证幂等（对 post-cutover 文本再跑 → ok:false）',
      first.ok === true && second.ok === false, `first=${first.ok} second=${second.ok}`);
    ok('已切换：detectState 对合成结果识别为 post-cutover', detectState(first.text) === 'post-cutover');
    ok('真实文件本身已不是 pre-cutover（与第 1 节呼应）', detectState(real) === 'post-cutover');
  }
}

console.log('\n【5. detectState 的四种状态】');
{
  ok('pre-cutover', detectState("if (!raw) return 'headless';") === 'pre-cutover');
  ok('post-cutover', detectState("if (!raw) return 'novel';") === 'post-cutover');
  ok('mixed（两处都在 → 半切换，必须能识别）',
    detectState("if (!raw) return 'headless';\nif (!raw) return 'novel';") === 'mixed');
  ok('unknown', detectState('const x = 1;') === 'unknown');
}

console.log('\n【6. 确认令牌由改动内容派生】');
{
  const a = confirmToken();
  ok('同一改动集令牌稳定', a === confirmToken());
  ok('令牌格式 P6-CUTOVER-xxxxxxxx', /^P6-CUTOVER-[0-9a-f]{8}$/.test(a), a);
  const tweaked = EDITS.map((e, i) => (i === 0 ? { ...e, to: e.to + ' // x' } : e));
  ok('改动内容变则令牌变（不看清单拿不到令牌）', confirmToken(tweaked) !== a);
}

console.log('\n【7. 备份清单覆盖关键产物】');
{
  const plan = backupPlan('novel');
  const rels = plan.map((i) => i.rel);
  ok('含主库 novel.db（required）', plan.some((i) => i.rel === 'data/novel.db' && i.required));
  ok('含 WAL（只复制 novel.db 会丢数据）', rels.includes('data/novel.db-wal'));
  ok('含 harness.js', rels.includes('harness.js'));
  ok('含 dsh settings.yaml', rels.includes('dsh/settings.yaml'));
  ok('含 novel profile 的 patch', rels.some((r) => r.includes('profiles/novel/')));
  ok('含 headless 的 patch（回滚参照）', rels.some((r) => r.includes('profiles/headless/')));
  ok('**不**复制 profile 的 node_modules（含 junction，递归复制有跟随风险）',
    !rels.some((r) => r.includes('node_modules')));
}

console.log('\n【8. 切换器本体未被实验污染】');
{
  const src = fs.readFileSync(new URL('./cutover.mjs', import.meta.url), 'utf8');
  ok('无遗留的阴性对照/变异标记', !/阴性对照临时改动|变异测试临时改动/.test(src));
  // ⚠️ 断言必须限定在 rehearse() 函数体内：`fs.writeFileSync(HARNESS_JS, plan.text)`
  // 在 execute() 里是**合法**的真实写入。第一版按整文件扫描 → 假报。
  const body = src.slice(src.indexOf('function rehearse()'), src.indexOf('function execute('));
  ok('取到了 rehearse 函数体（否则下面的断言会退化成空转）',
    body.length > 200 && body.includes('function rehearse()'), `body=${body.length}B`);
  ok('彩排写的是副本而不是真实文件',
    /fs\.writeFileSync\(copyPath, plan\.text\)/.test(body)
    && !/fs\.writeFileSync\(HARNESS_JS, plan\.text\)/.test(body));
  ok('安全网在 finally 里（异常路径也要核对真实产物）',
    /finally\s*\{[\s\S]*真实产物未被彩排改动/.test(body));
  ok('execute 仍然会真实写入（这是它的职责）',
    /fs\.writeFileSync\(HARNESS_JS, plan\.text\)/.test(src.slice(src.indexOf('function execute('))));
  ok('真实产物哈希可读（sha256File 可用）', /^[0-9a-f]{64}$/.test(sha256File(HARNESS_JS)));
}

console.log(`\n══════════════════════════════`);
console.log(`P6 切换器离线测试：通过 ${pass} / 失败 ${fails.length}`);
for (const f of fails) console.log(`  · ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
process.exitCode = fails.length ? 1 : 0;
