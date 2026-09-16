#!/usr/bin/env node
/**
 * probe-live.mjs —— 只读探测活实例：它是哪个数据目录、那次作业到底干了什么。
 *
 * 为什么需要：本轮发生在「以为打隔离实例、实际打到另一个数据目录的旧实例」之后，
 * 必须能一次性判定：(a) 活实例的数据目录；(b) 被接受的 harness 作业最终是否真的
 * 调用了真实 LLM（= 是否产生费用）。
 *
 * 只读：只发 GET，不创建/删除任何东西。
 * 用法: node .p1-baseline/probe-live.mjs [base]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3739';
const JOB = process.argv[3] || '';

const get = async (p) => {
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: `请求失败: ${e.message}` };
  }
};

console.log(`目标实例：${BASE}\n`);

console.log('═══ 1. 作品清单（判定数据目录）═══');
const works = await get('/api/works');
const list = works.json?.works || works.json?.items || works.json || [];
if (Array.isArray(list)) {
  console.log(`  共 ${list.length} 部作品`);
  for (const w of list.slice(0, 30)) {
    console.log(`    #${w.id ?? w.work_id}  ${String(w.title || '').slice(0, 40)}  chapters=${w.chapter_count ?? '?'}`);
  }
  const ids = new Set(list.map((w) => String(w.id ?? w.work_id)));
  console.log(`  → 含 work#16（压力作品，仅存在于 stress-data）: ${ids.has('16') ? '是 ⇒ 数据目录 = stress-data' : '否'}`);
  console.log(`  → 含 work#2 / work#9（真实库）：${ids.has('2') ? '有2 ' : ''}${ids.has('9') ? '有9' : ''}`);
} else {
  console.log('  非预期返回:', works.status, works.text.slice(0, 200));
}

console.log('\n═══ 2. AI 策略快照（模型路由）═══');
const pol = await get('/api/ai/policy');
console.log('  ', pol.status, JSON.stringify(pol.json).slice(0, 400));

console.log('\n═══ 3. 并发闸门当前负载 ═══');
const hb = await get('/api/harness/jobs');
console.log('   /api/harness/jobs →', hb.status, JSON.stringify(hb.json).slice(0, 300));

if (JOB) {
  console.log(`\n═══ 4. 作业 ${JOB} 的最终状态与输出 ═══`);
  const j = await get(`/api/harness/job?id=${encodeURIComponent(JOB)}`);
  console.log('   status=', j.status);
  const obj = j.json?.job || j.json;
  console.log('   job.status =', obj?.status);
  console.log('   job.model  =', obj?.model);
  console.log('   job.error  =', String(obj?.error || '').slice(0, 400));
  const out = String(obj?.output || obj?.result || obj?.text || '');
  console.log(`   output 长度=${out.length}`);
  console.log('   output 前 600 字:', out.slice(0, 600));
  console.log('\n   ⇒ 判定：', out.trim() && !obj?.error
    ? '作业产出了文本内容 ⇒ 真实 LLM 很可能被调用（需按费用对待）'
    : '作业无文本产出 ⇒ 更像在调用前/调用中失败');
}
