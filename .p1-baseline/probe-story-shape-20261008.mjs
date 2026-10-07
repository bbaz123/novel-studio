/**
 * 第五批（叙事结构机械感）固定断言探针（2026-10-08）。
 *
 * 语料：`.p1-baseline/fixtures/ch1-juexingri-v{1,2}.txt`（作者真实的审稿前 / 审稿后两版正文）。
 * 阈值与口径见 `.p1-baseline/calibrate-story-shape-20261008.mjs` 的实测输出 —— 本文件里每个
 * 期望数字都来自那次校准，不是凭空写的。
 *
 * 三类断言，缺一不可（前三批的教训：只写正例等于没验证）：
 *   ① **正例**：真的有同形流程 / 真的在非转播上下文用分镜词 → 必须命中；
 *   ② **负例**：合法写法（假设/梦境、转播片段里的镜头词、有具名主体的群众反应）→ **必须不命中**；
 *   ③ **静默姿态**：本章的时间轴与主视角都够不到参考线 → 必须不报（零误报纪律的直接检验）。
 *
 * 运行：node .p1-baseline/probe-story-shape-20261008.mjs
 */
import { readFileSync } from 'node:fs';
import { scanEditing, __internals } from '../ai/editing/scan.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

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
const OPTS = { abilities: ['story-shape'], genre: 'urban', task: 'review', characters: CHARACTERS };
const scan = (text, opts = OPTS) => scanEditing(text, opts);
const ids = (r) => r.findings.map((f) => f.rule_id);
const { processShapeOf, timelineAnchorsOf, STORY_SHAPE } = __internals;

console.log('\n【① 作者真实正文 · 审稿前 v1】');
{
  const r = scan(V1);
  const ss = r.scanned.style_shape;
  // 时间锚点：人工点过一遍的 5 个（早上六点 / 上午那批 / 下午三点多 / 傍晚六点多 / 天完全黑下来）
  check('时间锚点恰好 5 个（与人工计数一致）', ss.timeline.count === 5, `实测 ${ss.timeline.count}`);
  check('时间锚点值 = 早上/上午/下午/傍晚/天完全黑',
    ss.timeline.anchors.map((a) => a.value).join(',') === '早上,上午,下午,傍晚,天完全黑',
    ss.timeline.anchors.map((a) => a.value).join(','));
  check('"你从早上念到现在"里的"早上"不算锚点（该段无钟点/相对日）',
    ss.timeline.anchors.filter((a) => a.paragraph === 13).length === 0);
  check('"一上午过去"不算锚点（时段词自带数量＝时长）',
    ss.timeline.anchors.filter((a) => a.value === '一上午').length === 0);
  check('过密 gap = 0（同段两个时间词不算过密）', ss.timeline.tight_gaps === 0, `实测 ${ss.timeline.tight_gaps}`);

  // 静默姿态：锚点 5 个 < 参考线，且落点占比 4.1% 远低于 20%
  check('时间轴不报 finding（未到参考线，零误报姿态）',
    !ids(r).includes('deterministic:timeline-density'), ids(r).join(','));

  // 同形流程：两组真实再现（检测石演示 / 叫号念号）
  const shapeFindings = r.findings.filter((f) => f.rule_id === 'deterministic:process-shape-repeat');
  check('命中 2 组同形流程再现（上限 2 条，不刷屏）', shapeFindings.length === 2, `实测 ${shapeFindings.length}`);
  check('其中一组含第 20、84 段（暗黄规则说明 / C级播报）',
    shapeFindings.some((f) => /第 20、84 段/.test(f.message)), shapeFindings.map((f) => f.message).join(' | '));
  check('没有把"我梦见我按上去…A级"算成流程再现（假设／梦境必须排除）',
    shapeFindings.every((f) => !/梦见/.test(f.excerpt)), shapeFindings.map((f) => f.excerpt).join(' | '));

  // 群众反应
  check('匿名群众反应段只剩 1 段（"队伍里安静了两分钟"这类叙述过渡被排除）',
    ss.crowd_reactions.length === 1, JSON.stringify(ss.crowd_reactions));
  check('群众反应不报 finding（只有 1 段，未到参考线 2）',
    !ids(r).includes('deterministic:crowd-function-repeat'));

  // 镜头语言：本章 6 处镜头词全部处于全国直播/大屏转播上下文 → 必须全部静默
  check('镜头词命中 6 段', ss.camera.total === 6, `实测 ${ss.camera.total}`);
  check('非转播上下文里的镜头词 = 0（"镜头里她的脸"背后就是直播与字幕）',
    ss.camera.outside_media.length === 0, JSON.stringify(ss.camera.outside_media));
  check('镜头语言不报 finding', !ids(r).includes('deterministic:camera-outside-media'));

  // 主视角：本章主角并不摄像机化（主动动作 12 段 > 看/听 5 段）
  check('主视角比值 ≥ 参考线（本章主角有主动动作，不报摄像机化）',
    ss.pov.active_ratio >= STORY_SHAPE.povActiveRatioLine, `实测 ${ss.pov.active_ratio}`);
  check('主视角不报 finding', !ids(r).includes('deterministic:pov-observer'));
}

console.log('\n【① 作者真实正文 · 审稿后 v2（作者删了重复段／改了时间锚点）】');
{
  const r = scan(V2);
  const ss = r.scanned.style_shape;
  check('v2 时间锚点 4 个（"下午三点多"被改成"快到五点" → 锚点减少）',
    ss.timeline.count === 4, `实测 ${ss.timeline.count}`);
  check('v2 仍不报时间轴 finding', !ids(r).includes('deterministic:timeline-density'));
  check('v2 同形流程仍报 2 组（删掉的那几段不是同形流程）',
    r.findings.filter((f) => f.rule_id === 'deterministic:process-shape-repeat').length === 2);
  check('v2 镜头语言仍全部处于转播上下文',
    ss.camera.outside_media.length === 0);
}

console.log('\n【② 正例：非转播上下文里的镜头语言必须命中】');
{
  // ⚠️ 这一组正/负例被**两次反向确认**逼着改了两次，两次都错在"我按语义想象了输出"：
  //   ① 最初的正例是"镜头拉远…，画面里只剩下一个背影"——它同时含 `画面里`，
  //      而 `画面里` 曾被写进上下文词表（缺陷 6 的"判据自我实现"）。于是把该词加回去后
  //      **正例照样通过**（它自证上下文）→ 断言对"自我实现"方向零防御。
  //   ② 第二版正例写成"摄影棚的门在身后合上…"——那是**拍摄上下文**，
  //      判据正确地静默了，于是正例红、而变异后也红（不随变异变化，暴露是装置问题）。
  // 教训：**先跑测量值、再写断言**（校准纪律），不要按语义想象输出。
  // 现在正例是一个既没有设备词、也没有拍摄词的普通走廊场景。
  const text = [
    '门在身后合上，走廊里没有灯。',
    '镜头拉远，他站在走廊尽头。',
    '他往前走了两步，脚下的地砖很凉。',
  ].join('\n');
  const r = scan(text);
  check('正例：普通走廊 + 镜头词，且前后两段都没有设备/拍摄词 → 命中',
    ids(r).includes('deterministic:camera-outside-media'), ids(r).join(','));
  check('且报出的是那一段（不是空报）',
    (r.findings.find((f) => f.rule_id === 'deterministic:camera-outside-media') || {}).paragraph === 1,
    JSON.stringify((r.findings.find((f) => f.rule_id === 'deterministic:camera-outside-media') || {}).paragraph));
  // 同段设备词路径：段落自己有"屏幕/主持人" → 镜头词合法（同段成立，不依赖相邻段）
  const samePara = [
    '屏幕里正在转播检测台，主持人念到下一个名字，镜头拉远。',
    '他往前走了两步。',
  ].join('\n');
  check('负例（同段设备词路径）：段内同时有屏幕/主持人 → 静默',
    !ids(scan(samePara)).includes('deterministic:camera-outside-media'), ids(scan(samePara)).join(','));
  // 相邻段路径：靠**前一或后一段**的"直播/主持人"判定合法（窗口 2）
  const neighbor = [
    '屏幕里正在转播检测台，主持人念到下一个名字。',
    '他往前走了两步。',
    '镜头拉远，他站在走廊尽头。',
  ].join('\n');
  check('负例（相邻段路径）：后一段是转播段 → 静默（窗口 2 生效）',
    !ids(scan(neighbor)).includes('deterministic:camera-outside-media'), ids(scan(neighbor)).join(','));
  // 窗口边界：转播段与自己隔了 3 段 → 出窗口 → 必须命中（证明窗口不是无限大）
  const outOfWindow = [
    '屏幕里正在转播检测台，主持人念到下一个名字。',
    '第一段。',
    '第二段。',
    '第三段。',
    '镜头拉远，他站在走廊尽头。',
  ].join('\n');
  check('边界：转播段隔了 3 段（出窗口）→ 必须命中（窗口不是无限大）',
    ids(scan(outOfWindow)).includes('deterministic:camera-outside-media'), ids(scan(outOfWindow)).join(','));
}
{
  const text = [
    '屏幕里正在转播检测台，主持人念到下一个名字。',
    '镜头拉远，画面里只剩下一个背影。',
  ].join('\n');
  const r = scan(text);
  check('负例：同样两句放进转播上下文 → 不命中',
    !ids(r).includes('deterministic:camera-outside-media'), ids(r).join(','));
}

console.log('\n【② 正例：同形流程第三段必须命中】');
{
  const text = [
    '第一个上场的是他，把手掌按上去，屏幕上打出C级。',
    '第二个上场的是她，把手掌按上去，屏幕上打出D级。',
    '第三个上场的是我，把手掌按上去，屏幕上打出B级。',
  ].join('\n');
  const r = scan(text);
  check('三段同形流程 → 命中 process-shape-repeat', ids(r).includes('deterministic:process-shape-repeat'), ids(r).join(','));
  const f = r.findings.find((x) => x.rule_id === 'deterministic:process-shape-repeat');
  check('报出具体段号（第 1、2、3 段）', /第 1、2、3 段/.test(f.message), f.message);
}
{
  const text = [
    '王磊把手掌按上去，屏幕上打出C级。',
    '林清雪抬起头，说了一句无关的话。',
    '岳宸炎把书包从肩上放下来，搁在椅子边。',
  ].join('\n');
  const r = scan(text);
  check('负例：三段各做各的 → 不命中', !ids(r).includes('deterministic:process-shape-repeat'), ids(r).join(','));
}

console.log('\n【② 负例：有具名主体的群众反应不算匿名布景】');
{
  const text = [
    '王磊站起来欢呼，喊了两嗓子。',
    '岳宸炎站起来鼓掌，没有说话。',
  ].join('\n');
  const r = scan(text);
  check('两段都带具名主体 → 不判群众反应', r.scanned.style_shape.crowd_reactions.length === 0,
    JSON.stringify(r.scanned.style_shape.crowd_reactions));
  check('不命中 crowd-function-repeat', !ids(r).includes('deterministic:crowd-function-repeat'));
}
{
  const text = [
    '全场站了起来，有人吹口哨。',
    '全场又站了起来，有人鼓掌。',
  ].join('\n');
  const r = scan(text);
  check('正例：两段纯匿名群众反应 → 命中 crowd-function-repeat',
    ids(r).includes('deterministic:crowd-function-repeat'), ids(r).join(','));
}

console.log('\n【③ 能力开关：关闭时不报 finding，但测量值必须仍在】');
{
  const off = scan(V1, { ...OPTS, abilities: [] });
  check('关闭 story-shape → 无任何结构层 finding',
    !off.findings.some((f) => /timeline|process-shape|crowd-function|camera-outside|pov-observer/.test(f.rule_id)),
    ids(off).join(','));
  check('关闭后 style_shape 测量值仍在（与能力无关）',
    off.scanned.style_shape && off.scanned.style_shape.timeline.count === 5,
    JSON.stringify(off.scanned.style_shape && off.scanned.style_shape.timeline.count));
  check('关闭后 skipped 里如实记录 disabled',
    off.skipped.some((s) => s.id === 'story-shape' && s.reason === 'disabled'));
}

console.log('\n【③ 极短文本 / 无时间词文本：必须一条都不报】');
{
  const r = scan('他把书包放下。\n灯还亮着。');
  check('两段短文 → 无 finding', r.findings.length === 0, ids(r).join(','));
  check('锚点数 0', r.scanned.style_shape.timeline.count === 0);
}

console.log('\n【口径单测（内部件）】');
check('processShapeOf：纯叙述过渡 → 空',
  processShapeOf('王磊摸了摸后脑勺，没再说话。').length === 0);
check('processShapeOf：机制动作 + 结果 → 至少两组',
  processShapeOf('他走上台，把手掌按上去，屏幕上打出D级。').length >= 2);
check('processShapeOf：叫号式推进 → 至少两组',
  processShapeOf('喇叭响一声，门口就有人往大厅里走一步。“0654，进场。”').length >= 2);
check('timelineAnchorsOf：钟点绑定才算推进',
  timelineAnchorsOf([{ index: 0, text: '早上六点就有人来占位置。' }]).length === 1);
check('timelineAnchorsOf：纯参照不计',
  timelineAnchorsOf([{ index: 0, text: 'A级，你从早上念到现在，第四遍。' }]).length === 0);
check('timelineAnchorsOf：状态变化计（天完全黑下来）',
  timelineAnchorsOf([{ index: 0, text: '天完全黑下来的时候，大厅里的人少了一半。' }]).length === 1);
check('timelineAnchorsOf：时长不计（两分钟）',
  timelineAnchorsOf([{ index: 0, text: '队伍里安静了两分钟，又有人开口。' }]).length === 0);

console.log(`\n${'='.repeat(60)}\n通过 ${pass} / 失败 ${fail}\n${'='.repeat(60)}`);
process.exit(fail ? 1 : 0);
