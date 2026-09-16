#!/usr/bin/env node
/**
 * verify-auto-compress.mjs —— 决策 D8-#3 自动压缩开关的验收。
 *
 * 两条必须同时成立的性质：
 *   · **不打开就不花钱**（阴性对照）：开关关闭时，保存章节**不得**产生任何压缩作业。
 *     这是本功能最容易出的错——"默认关闭"只写在注释里、代码却忘了判断。
 *   · **打开真的会触发**：开关打开且长期记忆超阈值时，保存章节应建出一个压缩作业，
 *     且它走作业设施（有 kind/stage、可取消），而不是在请求里同步跑完。
 *
 * ⚠️ 需要一个**隔离实例**（黑洞 LLM 端点 → 即使触发也零计费），且会**写入该实例的库**
 *    （保存一次章节正文），所以只能跑在副本数据上。
 *
 * 用法:
 *   node .p1-baseline/gate-env.mjs --data-dir .p1-baseline/stress-data --port 3738
 *   $env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'
 *   node .p1-baseline/verify-auto-compress.mjs http://127.0.0.1:3738
 */
import fs from 'node:fs';

const BASE = process.argv[2] || '';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};

console.log('═══ 记忆自动压缩开关（D8-#3）═══\n');

console.log('【静态：默认必须关闭，且触发点真的判断了开关】');
{
  const src = fs.readFileSync('server.js', 'utf8');
  check('开关键存在且默认值是 0（关闭）',
    /MEMORY_AUTO_COMPRESS_KEY = 'memory_auto_compress'/.test(src)
    && /getAppSettingDb\(MEMORY_AUTO_COMPRESS_KEY, '0'\)/.test(src));
  const fn = src.slice(src.indexOf('function maybeAutoCompressMemory('), src.indexOf('\n}\n', src.indexOf('function maybeAutoCompressMemory(')));
  check('触发函数第一句就检查开关（不是先干活再判断）',
    /if \(!memoryAutoCompressEnabled\(\)\) return null;/.test(fn));
  check('有"同一作品已有压缩在跑就不再建"的去重（否则每保存一章叠一个作业）',
    /j\.kind === 'compress' && Number\(j\.workId\) === wid/.test(fn));
  check('自动压缩失败不影响章节保存（只记日志）', /memory_auto_compress_failed/.test(fn));
  check('阈值复用既有的 MEMORY_COMPRESS_HINT（不另写一个数）', /summary\.length <= MEMORY_COMPRESS_HINT/.test(fn));
  check('读写端点齐备（GET 状态 / PUT 开关）',
    /segments\[2\] === 'memory_auto_compress' && method === 'GET'/.test(src)
    && /segments\[2\] === 'memory_auto_compress' && method === 'PUT'/.test(src));
}

if (!BASE) {
  console.log('\n（未给实例地址 → 跳过活体段）');
} else if (process.env.NOVELSTUDIO_GATE_CONFIRMED_ISOLATED !== '1') {
  console.log('\n✗ 拒绝跑活体段：它会**写入该实例的库**（保存一次章节正文）。');
  console.log("  请跑在隔离实例上并授权：$env:NOVELSTUDIO_GATE_CONFIRMED_ISOLATED='1'");
  fail++;
} else {
  const api = async (method, p, body) => {
    const r = await fetch(BASE + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  };
  const compressJobs = async () => {
    const r = await api('GET', '/api/harness/recoverable');
    const jobs = Array.isArray(r.json?.jobs) ? r.json.jobs : [];
    return jobs.filter((j) => j.kind === 'compress');
  };

  console.log(`\n【活体：${BASE}】`);
  const st0 = await api('GET', '/api/novel/memory_auto_compress');
  check('默认是关闭的', st0.json?.enabled === false, JSON.stringify(st0.json?.enabled));
  check('接口回报阈值（便于界面说明"多少字才会触发"）', typeof st0.json?.threshold === 'number', `threshold=${st0.json?.threshold}`);

  // 找一个"长期记忆超阈值"的作品——否则触发条件根本不成立，测了也是空转。
  const works = await api('GET', '/api/works');
  let target = null, targetMemLen = 0;
  for (const w of (Array.isArray(works.json) ? works.json : [])) {
    const m = await api('GET', `/api/story_memory?work_id=${w.id}`);
    const len = String(m.json?.summary || '').length;
    if (len > (st0.json?.threshold || 1200)) { target = w; targetMemLen = len; break; }
  }
  check('找到一个长期记忆超阈值的作品（触发条件成立，否则这场测试是空转）',
    Boolean(target), target ? `work=#${target.id} 记忆 ${targetMemLen} 字` : '库里没有超阈值的作品');

  if (target) {
    const chs = await api('GET', `/api/chapters?work_id=${target.id}`);
    const ch = Array.isArray(chs.json) && chs.json.length ? chs.json[0] : null;
    check('该作品有章节可供保存（触发点挂在章节保存上）', Boolean(ch), ch ? `chapter=#${ch.id}` : '无章节');

    if (ch) {
      const before = (await compressJobs()).length;
      // ⚠️ 阴性对照：开关关着，保存章节**不得**产生压缩作业。
      const save = await api('PUT', `/api/chapters/${ch.id}`, { content: (ch.content || '') + '\n（D8-#3 验收：开关关闭时的一次保存）' });
      check('章节保存成功', save.status === 200, `HTTP ${save.status}`);
      await new Promise((s) => setTimeout(s, 3000));
      const afterOff = await compressJobs();
      check('**开关关闭时没有产生任何压缩作业**（"不打开不花钱"这条真的成立）',
        afterOff.length === before, `作业数 ${before} → ${afterOff.length}`);

      // 打开开关 → 再保存一次 → 应当建出压缩作业
      const on = await api('PUT', '/api/novel/memory_auto_compress', { enabled: true });
      check('能把开关打开', on.json?.enabled === true, JSON.stringify(on.json?.enabled));
      const save2 = await api('PUT', `/api/chapters/${ch.id}`, { content: (ch.content || '') + '\n（D8-#3 验收：开关打开时的一次保存）' });
      check('再次保存成功', save2.status === 200, `HTTP ${save2.status}`);

      let created = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const list = await compressJobs();
        created = list.find((j) => !afterOff.some((o) => o.id === j.id));
        if (created) break;
        await new Promise((s) => setTimeout(s, 1500));
      }
      check('开关打开后真的建出了压缩作业', Boolean(created), created ? `job=${created.id} status=${created.status}` : '20 秒内没出现');
      if (created) {
        check('它是走作业设施的（有 kind/stage，可被取消）',
          created.kind === 'compress', `kind=${created.kind} stage=${created.stage}`);
        await api('POST', '/api/harness/cancel', { job_id: created.id });
        await new Promise((s) => setTimeout(s, 2500));
        const after = await api('GET', `/api/harness/job?id=${encodeURIComponent(created.id)}`);
        check('能取消（不会一直占着槽位与费用）', after.json?.status === 'cancelled', `status=${after.json?.status}`);
      }

      // 收尾：把开关关回去，避免给后续测试留下"会自动花钱"的状态
      const off = await api('PUT', '/api/novel/memory_auto_compress', { enabled: false });
      check('测试结束把开关关回去（不留"会自动花钱"的状态）', off.json?.enabled === false);
    }
  }
}

console.log(`\n══════════════════════════════`);
console.log(`自动压缩开关验收：通过 ${pass} / 失败 ${fail}`);
console.log('复核零计费：node .p1-baseline/audit-llm-calls.mjs --since <本命令开始时刻>');
process.exitCode = fail ? 1 : 0;
