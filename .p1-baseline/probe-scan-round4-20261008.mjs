/**
 * 第四批扫描器探针（2026-10-08）——在**作者真实的审稿前后两版正文**上跑三条新判据。
 *
 * 为什么必须用真实语料（而不是自造正例）：前几批的教训是"判据在自己编的例子上都过、
 * 在作者的真实文本上静默"。这里两组语料都取自复核稿里作者贴出的正文片段，
 * 差别只在**复核稿改动了哪里**。
 *
 * ⚠️ 探针还负责把"判据该由谁负责"钉清楚，避免以后把同一件事塞进两个地方：
 *   · **改成什么**（1738→1736）由补丁门禁负责（改前/改后两份文本都在手上）——
 *     见 probe-fact-lock-20261008.mjs；
 *   · **这一版里有什么**（撞号、百分比合计、等级展示密度、年份质感、通用承诺）
 *     由本扫描器负责（它只看得见一份文本）。
 *   所以下面刻意不写"审稿前版本该报 1738/1720 冲突"这类断言——
 *   单独一份文本里 1738 与 1720 各只出现在一个语境里，报它反而是猜。
 *
 * 运行：node .p1-baseline/probe-scan-round4-20261008.mjs
 */
import { scanEditing } from '../ai/editing/scan.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
};

const CHARACTERS = [
  { id: 1, name: '岳宸炎' },
  { id: 2, name: '王磊' },
  { id: 3, name: '李拓' },
  { id: 4, name: '林清雪' },
];
const ABILITIES = ['number-lock', 'scene-bridge', 'promise-identity'];

/** 段落用**单换行**分隔：与界面录入的实际文本一致（复核稿正文是单换行）。 */
const P = (lines) => lines.join('\n');

// 作者审稿**前**版本（复核稿贴出的原文，未改动）
const BEFORE = P([
  '3751年，全民觉醒日。',
  '江陵市第三检测中心的排队大厅里挤着上千人。中央空调开到最大，送出来的风还是热的。岳宸炎站在队伍中间，蓝白校服的领口被汗浸出一圈深色，书包带子勒在肩膀上，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1738。',
  '大屏幕上滚动的信息分了三栏。广播每隔十几秒就念一次等级口径，从D念到S。',
  '“D级，出现概率百分之九十五，普通职业方向。C级，万分之一，基础战斗能力。B级，十万分之一……”',
  '“B级，中级战斗天赋。”',
  '“1736号，王磊——”',
  '王磊把右手掌贴在黑色石板上。三秒之后，检测石亮起青绿色。',
  '“C级，强化皮肤。基础战斗能力，可进入城市防卫体系。”',
  '“1721号，李拓——”',
  '检测石亮起的颜色不一样。金红色从石面往外烧。',
  '“A级，火焰法师。高级战斗天赋。”',
  '大屏幕中间那栏，本地实时排名刷新了。',
  '“A级，风暴掌控者。”',
  '那块石头亮起来的时候，整个画面都白了。',
  '画面开始抖，直播信号卡了一下。再切回来的时候，镜头已经拉到了场地外面。',
  '外面在下雪。',
  '雪花从灰白的天空里落下来，落在广场上，落在停着的车顶上。',
  '“更正。海澜市觉醒中心，林清雪，S级，寒月灵体。”',
  '“1720号，岳宸炎——”',
  '检测石亮了起来。',
  '“D级，无战斗能力。普通职业方向。”',
  '岳宸炎把手从石板上拿开。掌心还留着刚才贴上去的那点凉。台下很安静。',
  '他走下检测台的时候，前排一个不认识的学生拍了拍他的肩膀。',
  '一个没有起伏的、像在念一份文件的声音：',
  '“检测完成，宿主符合绑定条件。”',
]);

// 复核稿**审稿后**版本：只做了复核稿点名的那几处改动
const AFTER = P([
  '3751年，全民觉醒日。',
  '江陵市第三检测中心的排队大厅里挤着上千人。中央空调开到最大，送出来的风还是热的。岳宸炎站在队伍中间，蓝白校服的领口被汗浸出一圈深色，书包带子勒在肩膀上，手里攥着那张排号纸。纸已经被他捏出了毛边，右上角的数字是1736。',
  '大屏幕上滚动的信息分了三栏。广播每隔十几秒就念一次等级口径，从D念到S。',
  '“D级，出现概率百分之九十五，普通职业方向。C级，万分之一，基础战斗能力。B级，十万分之一……”',
  '“B级，中级战斗天赋。”',
  '“1736号，王磊——”',
  '王磊把右手掌贴在黑色石板上。三秒之后，检测石亮起青绿色。',
  '“C级，强化皮肤。基础战斗能力，可进入城市防卫体系。”',
  '“1721号，李拓——”',
  '检测石亮起的颜色不一样。金红色从石面往外烧。',
  '“A级，火焰法师。高级战斗天赋。”',
  '大屏幕中间那栏，本地实时排名刷新了。',
  '“A级，风暴掌控者。”',
  '那块石头亮起来的时候，整个画面都白了。',
  '雪花从灰白的天空里落下来，落在广场上，落在停着的车顶上。',
  '“更正。海澜市觉醒中心，林清雪，S级，寒月灵体。”',
  '“1720号，岳宸炎——”',
  '检测石亮了起来。',
  '“D级，无战斗能力。普通职业方向。”',
  '岳宸炎把手从石板上拿开。掌心还留着刚才贴上去的那点凉。台下很安静。',
  '岳宸炎把手从石板上拿开。掌心还留着刚才贴上去的那点凉。台下很安静。',
  '岳宸炎把手从石板上拿开。掌心还留着刚才贴上去的那点凉。台下很安静。',
  '他走下检测台的时候，前排一个不认识的学生拍了拍他的肩膀。',
  '一个没有起伏的、像在念一份文件的声音：',
  '“检测完成，宿主符合绑定条件。”',
]);

console.log('=== 1. 审稿后版本（复核稿）===');
const afterRun = scanEditing(AFTER, { abilities: ABILITIES, task: 'review', characters: CHARACTERS, genre: 'general' });
for (const f of afterRun.findings) console.log(`    · [${f.rule_id}] ${f.message}`);
const afterIds = afterRun.findings.map((f) => f.rule_id);
check('命中事实锁冲突（1736 同时挂在岳宸炎与王磊名下）', afterIds.includes('deterministic:number-conflict'));
check('命中整句重复（复核稿里那句被复制了三遍）', afterIds.includes('deterministic:duplicate-sentence'));
check('命中转场桥缺失（外景「下雪」失去观察来源）', afterIds.includes('deterministic:scene-bridge'));
check('命中百分比合计不为 100%', afterIds.includes('deterministic:percent-sum'));
check('命中章末通用承诺', afterIds.includes('deterministic:generic-hook-promise'));
check('命中体系展示密度（等级逐项正面展示）', afterIds.includes('deterministic:system-showcase-density'));
check('命中远未来年份质感（3751 年只有当代日常）', afterIds.includes('deterministic:era-texture'));
const hook = afterRun.findings.find((f) => f.rule_id === 'deterministic:generic-hook-promise') || {};
check('章末承诺判据真的指出"没有差异化"', /差异化/.test(String(hook.message) + String(hook.suggestion)), String(hook.message));

console.log('\n=== 2. 审稿前版本（同一章未被误改的原文）===');
const beforeRun = scanEditing(BEFORE, { abilities: ABILITIES, task: 'review', characters: CHARACTERS, genre: 'general' });
for (const f of beforeRun.findings) console.log(`    · [${f.rule_id}] ${f.message}`);
const beforeIds = beforeRun.findings.map((f) => f.rule_id);
check('负例：转场句还在时→不报转场桥（阳性只在真的删掉时出现）', !beforeIds.includes('deterministic:scene-bridge'));
check('负例：没有整句重复→不报重复句', !beforeIds.includes('deterministic:duplicate-sentence'));
check('负例：1736 只属于王磊一人→不报事实锁冲突', !beforeIds.includes('deterministic:number-conflict'));
check('正例：百分比合计不到 100%→照报（这是原文自身的问题）', beforeIds.includes('deterministic:percent-sum'));
check('正例：3751 年只有当代日常→报年份质感（原文自身的问题）', beforeIds.includes('deterministic:era-texture'));
check('正例：章末通用承诺→报（原文自身的问题）', beforeIds.includes('deterministic:generic-hook-promise'));

console.log('\n=== 3. 体系展示密度：不去重时会虚高 ===');
const showcases = scanEditing(AFTER, { abilities: ABILITIES, task: 'review', characters: CHARACTERS }).scanned.promise.system_showcase_count;
check(`展示计数落在合理区间（实测 ${showcases} 次：叫号 4 + 检测石 3 + 排名 1）`, showcases >= 6 && showcases <= 10, String(showcases));

console.log('\n=== 4. 开关与测量值 ===');
const off = scanEditing(AFTER, { abilities: [], task: 'review', characters: CHARACTERS });
const offIds = off.findings.map((f) => f.rule_id);
const skippedIds = off.skipped.map((s) => s.id);
check('三条能力默认关闭时不产出 finding（开关有真实输出差）',
  !offIds.includes('deterministic:number-conflict') && !offIds.includes('deterministic:scene-bridge')
  && !offIds.includes('deterministic:generic-hook-promise')
  && skippedIds.includes('number-lock') && skippedIds.includes('scene-bridge') && skippedIds.includes('promise-identity'));
check('整句重复与能力开关无关（任何档位都报）', offIds.includes('deterministic:duplicate-sentence'));
check('scanned.promise 给出测量值（与开关无关）',
  off.scanned.promise && off.scanned.promise.system_showcase_count > 0 && off.scanned.promise.year === 3751,
  JSON.stringify(off.scanned.promise));

console.log('\n=== 5. 阴性对照 ===');
const CLEAN = P([
  '上午第三节课的下课铃响过之后，走廊里的人渐渐多起来。',
  '岳宸炎把卷子折好塞进桌肚，起身去接水。',
  '王磊靠在窗边等他，手里转着一支笔。“老周说下午要讲上次月考的卷子。”',
  '“知道了。”岳宸炎拧上水杯盖。',
  '两个人并排往回走，谁也没再提上午的事。',
  '放在桌肚里的手机震了一下，屏幕上是陈牧野发来的消息。',
]);
const cleanRun = scanEditing(CLEAN, { abilities: ABILITIES, task: 'review', characters: CHARACTERS, genre: 'general' });
check('当代日常章节：三条新判据零命中', cleanRun.findings.length === 0, JSON.stringify(cleanRun.findings.map((f) => f.rule_id)));

// 年份质感：同一部作品的另一章，只要出现一项与远未来相配的细节就不报
const FUTURE_DETAIL = P([
  '3751年，全民觉醒日。',
  '大屏幕下方滚动着城防提示：北段防护墙今日封闭检修，请觉醒者家属避开三号高架。',
  '岳宸炎站在队伍中间，蓝白校服的领口被汗浸出一圈深色。',
  '广播念了一遍等级口径。',
]);
const futureRun = scanEditing(FUTURE_DETAIL, { abilities: ['promise-identity'], task: 'review', characters: CHARACTERS });
check('负例：有未来设定细节（防护墙 / 觉醒者）时不报年份质感',
  !futureRun.findings.some((f) => f.rule_id === 'deterministic:era-texture'),
  JSON.stringify(futureRun.findings.map((f) => f.rule_id)));

console.log(`\n=== ${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}（${pass} passed / ${fail} failed）===`);
process.exit(fail === 0 ? 0 : 1);
