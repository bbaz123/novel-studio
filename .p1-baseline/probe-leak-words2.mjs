const u = 'http://127.0.0.1:3737/api/ai_context?chapter_id=119&library_recall_phase=defer&tools=0&omit_layers=blueprint';
const j = await (await fetch(u)).json();
const asm = String(j.assembled || '');
const parts = asm.split(/(?=【[^】]{2,30}】)/);
const loader = (k) => {
  const hit = [];
  for (const p of parts) if (p.includes(k)) { const m = /^【[^】]*】/.exec(p); hit.push((m ? m[0] : '(无标题)') + ' :: ' + p.replace(/\s+/g, ' ').slice(0, 150)); }
  return hit;
};
for (const k of ['集体带过去', '18岁', '十八岁', '统一觉醒', '检测石进校园', '境界']) {
  console.log(`\n### ${k}`);
  for (const h of loader(k)) console.log('  ' + h);
}
console.log('\n=== 是否存在 blueprint 层标题 ===', asm.includes('本章蓝图（写作必须遵守）'));
