const u = 'http://127.0.0.1:3737/api/ai_context?chapter_id=119&library_recall_phase=defer&tools=0&omit_layers=blueprint';
const j = await (await fetch(u)).json();
const asm = String(j.assembled || '');
const parts = asm.split(/(?=【[^】]{2,30}】)/);
const want = ['【第1节 第一章', '【长期记忆（已发生的故事摘要）】', '【长期记忆（故事摘要）】', '【原天赋：S级·暗夜猎手（已交易）】', '【当前场景】', '【相关记忆检索（语义召回）】'];
for (const p of parts) {
  const m = /^【[^】]*】/.exec(p);
  if (!m || !want.some((w) => p.startsWith(w))) continue;
  console.log('===== ' + p.slice(0, 420).replace(/\n+/g, ' ⏎ ') + '\n');
}
