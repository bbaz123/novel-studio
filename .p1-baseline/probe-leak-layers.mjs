const u = 'http://127.0.0.1:3737/api/ai_context?chapter_id=119&library_recall_phase=defer&tools=0&omit_layers=blueprint';
const j = await (await fetch(u)).json();
const asm = String(j.assembled || '');
console.log('assembled 长度 =', asm.length);
const parts = asm.split(/(?=【[^】]{2,30}】)/);
const kw = ['江陵市第三检测中心', '李拓', '火焰法师', '王磊', '林清雪', '宿主符合绑定条件', '暗黄', '号码纸'];
for (const k of kw) {
  const hit = [];
  for (const p of parts) {
    if (!p.includes(k)) continue;
    const m = /^【[^】]*】/.exec(p);
    hit.push(m ? m[0] : '(无标题段)');
  }
  console.log(`${k.padEnd(12, ' ')} → ${[...new Set(hit)].join(' | ') || '（不出现）'}`);
}
console.log('--- 各层标题与字数 ---');
for (const p of parts) { const m = /^【[^】]*】/.exec(p); if (m) console.log(`  ${m[0]}  ${p.length} 字`); }
