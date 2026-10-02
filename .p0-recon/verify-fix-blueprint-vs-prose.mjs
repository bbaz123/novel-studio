// 只读验证：用 public/app.js 里**真实**的解析/闸门函数，对 2026-10-01 事故的实际产物做复现与修复验证。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const src = readFileSync('public/app.js', 'utf8');
const extract = (name) => {
  const a = src.indexOf(`function ${name}(`);
  if (a < 0) throw new Error('not found: ' + name);
  const rest = src.slice(a + 10);
  const m = rest.match(/\n(?=(?:async )?function |const |let )/);
  if (!m) throw new Error('no boundary: ' + name);
  return src.slice(a, a + 10 + m.index).trim();
};
const snippet = [
  'const BLUEPRINT_FIELDS = ["references","scene_goal","conflicts","plot_points","character_changes","hook"];',
  extract('extractJSONFromText'),
  extract('salvageJSONString'),
  extract('parseBlueprintJSON'),
  extract('detectNonProseOutput'),
  extract('parseAIWritingOutput')
].join('\n\n');
const { parseBlueprintJSON, detectNonProseOutput, parseAIWritingOutput, extractJSONFromText } =
  new Function(snippet + '\nreturn { parseBlueprintJSON, detectNonProseOutput, parseAIWritingOutput, extractJSONFromText };')();

const db = new DatabaseSync('data/novel.db', { readOnly: true });
const row = db.prepare("SELECT content, kind, created_at FROM chapter_save_versions WHERE chapter_id=119 AND kind='draft' ORDER BY id LIMIT 1").get();
console.log('[样本来源] chapter_save_versions kind=' + row.kind + ' @ ' + row.created_at);
const raw = String(row.content || '')
  .replace(/<\/p>\s*<p>/g, '\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
console.log('样本长度:', raw.length, '｜以【蓝图】开头:', /^【蓝图】/.test(raw));

console.log('\n=== A. 修复后：蓝图轮会走到"确认蓝图"分支，而不是被当成正文 ===');
console.log('extractJSONFromText（严格，仍为 null 是预期的）:', extractJSONFromText(raw) === null ? 'null' : 'object');
const bp = parseBlueprintJSON(raw);
console.log('parseBlueprintJSON 结果:', bp.stage, '｜字段:', JSON.stringify(Object.keys(bp.blueprint || {})));
console.log('parseAIWritingOutput（兼容旧入口）:', JSON.stringify(Object.keys(parseAIWritingOutput(raw))));
console.log('闸门判定:', JSON.stringify(detectNonProseOutput(raw)));

console.log('\n=== B. 修复前的那条兜底（把蓝图当正文）现在会被闸门拦下 ===');
const viaFallback = parseAIWritingOutput(raw).finalText || '';
console.log('旧兜底文本长度:', viaFallback.length, '｜闸门:', JSON.stringify(detectNonProseOutput(viaFallback)));

console.log('\n=== C. 不能误拦真正文（含对话引号、含单个字段名、长正文） ===');
const realProse = [
  '岳宸炎把手按在石板上，三秒钟，黑色的石头亮起来，是暗黄色。',
  '广播里念：「D级·普通人，能力：无。」',
  '他听见身后有人说"可惜"，那声音不大，却比嘲笑更难受。',
  '他把单子折成四折塞进兜里，从侧门走出去。背上是一片不属于他的欢呼。',
  '系统第一次开口：【检测完成，宿主符合绑定条件。】',
  '他问："什么条件？"没有人回答他。'
].join('\n\n');
console.log('真正文闸门:', JSON.stringify(detectNonProseOutput(realProse)) || '(通过)');
const proseWithFieldWord = realProse + '\n\n他在笔记本上写下四个字：场景目标。';
console.log('正文里出现单个字段词:', JSON.stringify(detectNonProseOutput(proseWithFieldWord)) || '(通过)');
console.log('空输出:', JSON.stringify(detectNonProseOutput('')));
