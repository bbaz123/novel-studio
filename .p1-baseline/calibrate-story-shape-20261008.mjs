/**
 * 第五批（叙事结构机械感）判据**校准探针**（2026-10-08）。
 *
 * 用途与 probe-*-round4 不同：这一份**不断言**，只把新判据在作者两版真实正文上的原始测量值打出来，
 * 用来给阈值找依据（阈值必须来自实测，不能凭空写一个然后声称"参考线"）。
 * 校准完成后的固定断言在 probe-story-shape-20261008.mjs。
 *
 * 语料：.p1-baseline/fixtures/ch1-juexingri-v{1,2}.txt
 *   v1 = 审稿前（作者贴出的原文）
 *   v2 = 审稿后（作者改过的那一版：删了群众反应重复段、加了"快到五点"、删了耳机重复动作）
 *
 * 运行：node .p1-baseline/calibrate-story-shape-20261008.mjs
 */
import { readFileSync } from 'node:fs';
import { scanEditing, __internals } from '../ai/editing/scan.mjs';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const load = (f) => readFileSync(`${HERE}fixtures/${f}`, 'utf8').replace(/\r\n/g, '\n').trim();
const V1 = load('ch1-juexingri-v1.txt');
const V2 = load('ch1-juexingri-v2.txt');

const CHARACTERS = [
  { id: 1, name: '岳宸炎' },
  { id: 2, name: '王磊' },
  { id: 3, name: '李拓' },
  { id: 4, name: '林清雪' },
];
const ABILITIES = ['story-shape'];
const OPTS = { abilities: ABILITIES, genre: 'urban', task: 'review', characters: CHARACTERS };

const dump = (label, text) => {
  const r = scanEditing(text, OPTS);
  const ss = r.scanned.style_shape;
  console.log(`\n${'='.repeat(72)}\n${label}  段落=${r.scanned.paragraphs}  字数=${r.scanned.chars}\n${'='.repeat(72)}`);
  console.log('\n[时间锚点]  total=%d  时段型=%d  落点段数=%d/%d (ratio=%s)  过密gap=%d',
    ss.timeline.count, ss.timeline.period_count, ss.timeline.paragraphs, r.scanned.paragraphs,
    ss.timeline.ratio, ss.timeline.tight_gaps);
  ss.timeline.anchors.forEach((a) => console.log(`   p${String(a.paragraph).padStart(3)}  ${a.kind.padEnd(8)} ${a.value}`));
  console.log('\n[同形流程簇] (%d 簇)', ss.process_shapes.length);
  ss.process_shapes.forEach((c) => console.log(`   ${String(c.count).padStart(2)} 段  ${c.shape.padEnd(28)} 段号 ${c.paragraphs.join(',')}`));
  console.log('\n[匿名群众反应段] %s', JSON.stringify(ss.crowd_reactions));
  console.log('[镜头语言]  总命中段=%d  其中非转播上下文=%s', ss.camera.total, JSON.stringify(ss.camera.outside_media));
  ss.camera.paragraphs.forEach((c) => console.log(`   p${String(c.paragraph).padStart(3)}  inContext=${c.inContext ? 'Y' : 'N'}  ${c.text.slice(0, 42)}`));
  console.log('\n[主视角]  看/听段=%d  主动动作段=%d  比值=%s  物件提及=%d',
    ss.pov.perceive_paragraphs.length, ss.pov.active_paragraphs.length, ss.pov.active_ratio, ss.pov.object_mentions);
  console.log('[switch-independent 测量值] %s', JSON.stringify({
    timeline_anchor_count: ss.timeline.count,
    process_shape_clusters: ss.process_shapes.map((c) => ({ s: c.shape, n: c.paragraphs.length })),
    camera_word_count: ss.camera.total,
  }));
  console.log('\n[findings]');
  r.findings.forEach((f) => console.log(`   ${f.rule_id}  p${f.paragraph}\n      ${f.message}\n      摘录: ${f.excerpt}`));
  if (!r.findings.length) console.log('   （无）');
};

dump('v1 审稿前', V1);
dump('v2 审稿后', V2);

// 能力关闭时：不应有 story-shape 相关 finding，但测量值必须仍在
const OFF = scanEditing(V1, { ...OPTS, abilities: [] });
const offRuleIds = OFF.findings.map((f) => f.rule_id).filter((id) => /timeline|crowd|camera|pov|process/.test(id));
console.log('\n[能力关闭] story-shape 相关 finding = %s（应为空）', JSON.stringify(offRuleIds));
console.log('[能力关闭] 测量值仍在 = %s', JSON.stringify({
  anchors: OFF.scanned.style_shape.timeline.count,
  clusters: OFF.scanned.style_shape.process_shapes.length,
}));

// 内部口径自检
const { processShapeOf, timelineAnchorsOf } = __internals;
console.log('\n[口径自检]');
console.log('   processShapeOf("喇叭响一声，门口就有人往大厅里走一步。") =', processShapeOf('喇叭响一声，门口就有人往大厅里走一步。'));
console.log('   processShapeOf("王磊摸了摸后脑勺，没再说话。") =', processShapeOf('王磊摸了摸后脑勺，没再说话。'));
console.log('   processShapeOf("客厅里的灯很旧。") =', processShapeOf('客厅里的灯很旧。'));
console.log('   timelineAnchorsOf 段数 =', timelineAnchorsOf([{ index: 0, text: '早上六点就有人来占位置。' }]).length);
