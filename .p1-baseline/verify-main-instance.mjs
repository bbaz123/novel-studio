#!/usr/bin/env node
/**
 * verify-main-instance.mjs —— 主实例重启后的零成本对照检查（只读，不建任何 AI 任务）。
 *
 * 为什么留成文件：服务端字段是否真的上线、前端是否真的读它，都必须**对着活实例**核，
 * 而不是只读源码。这些检查全部是只读 GET，不触发 harness，不产生任何 API 费用。
 *
 * 用法: node .p1-baseline/verify-main-instance.mjs [base]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3737';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? '　' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '　' + detail : ''}`); }
};

const getJson = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

console.log(`═══ 主实例对照检查（只读，零计费）═══\n目标：${BASE}\n`);

const st = await getJson('/api/harness/status');
console.log('【D4 服务端字段】');
check('暴露 model_load', st.model_load !== undefined, JSON.stringify(st.model_load));
check('空闲时 busy=false / waiters=0',
  st.model_load?.busy === false && st.model_load?.waiters === 0, JSON.stringify(st.model_load));
check('暴露 concurrency', st.concurrency === 2, `concurrency=${st.concurrency}`);

console.log('\n【前端静态资源】');
const appSrc = await (await fetch(BASE + '/app.js', { signal: AbortSignal.timeout(15000) })).text();
check('已下发含排队提示的前端', appSrc.includes('等待模型槽位'));
check('轮询读机读字段 model_slot（不靠匹配中文）', /job\.model_slot === 'waiting'/.test(appSrc));

console.log('\n【真实库未被这次重启改变】');
const works = await getJson('/api/works');
check('作品清单可读', Array.isArray(works) && works.length > 0, `${works.length} 部`);
for (const w of works) console.log(`      · #${w.id} ${w.title}（ov_uri=${w.ov_uri}）`);

console.log(`\n══════════════════════════════`);
console.log(`主实例对照检查：通过 ${pass} / 失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
