const BASE = 'http://127.0.0.1:3737/api/ai_context?chapter_id=119&library_recall_phase=defer&tools=0';
const FULL = 'blueprint,scene,memory,events,foreshadows,recall';
const j = async (u) => (await (await fetch(u)).json());
const layersOf = (x) => (x.context_manifest || []).map((m) => m.id);
const a = await j(BASE);
const b = await j(`${BASE}&omit_layers=${FULL}`);
const c = await j(`${BASE}&omit_layers=${FULL},characters,unknown_layer`);
const has = (x, id) => layersOf(x).includes(id);
console.log('默认装配        层数=' + layersOf(a).length + ' 长度=' + a.assembled.length);
console.log('  含 blueprint/scene/memory/events/foreshadows/recall =',
  ['blueprint', 'scene', 'memory', 'events', 'foreshadows', 'recall'].map((x) => has(a, x)).join(','));
console.log('重写本章装配    层数=' + layersOf(b).length + ' 长度=' + b.assembled.length);
console.log('  含 blueprint/scene/memory/events/foreshadows/recall =',
  ['blueprint', 'scene', 'memory', 'events', 'foreshadows', 'recall'].map((x) => has(b, x)).join(','));
console.log('  保留（书级设定）=', ['work', 'outline', 'characters', 'world', 'terms', 'redlines'].map((x) => `${x}:${has(b, x)}`).join(' '));
console.log('  装配文本里是否还有「本章蓝图」/「长期记忆」/「事件账本」/「前文衔接」 =',
  ['本章蓝图', '长期记忆', '事件账本', '未闭合伏笔'].map((k) => `${k}:${b.assembled.includes(k)}`).join(' '));
console.log('白名单：characters/unknown_layer 被忽略（它们仍在）= characters:' + has(c, 'characters') + ' 且六项仍被排除=' +
  ['blueprint', 'scene', 'memory', 'events', 'foreshadows', 'recall'].every((x) => !has(c, x)));
console.log('缓存不串线：再取一次默认 → 含 blueprint =', has(await j(BASE), 'blueprint'));
