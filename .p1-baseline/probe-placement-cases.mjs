// 正例/负例对照：证明 object-placement-conflict 判据真的会响（不是死规则），且不误报。
import { scanEditing } from '../ai/editing/scan.mjs';
const run = (label, text) => {
  const r = scanEditing(text, { abilities: ['scene-logic'], genre: 'urban', task: 'review' });
  const hit = r.findings.find((f) => f.rule_id === 'deterministic:object-placement-conflict');
  const recall = r.findings.find((f) => f.rule_id === 'deterministic:detail-recall');
  console.log(`${hit ? 'HIT ' : 'miss'} ${label}`);
  if (hit) console.log(`      → ${hit.message}`);
  if (recall && label.includes('对照')) console.log(`      recall → ${recall.message}`);
};
run('正例1：剑同时被写在书包一般层与更深层', [
  '剑在书包里，和卷子挤在一起。',
  '他把手往书包更深的地方探进去，摸到一个硬的东西。',
  '剑在书包夹层里。',
].join('\n'));
run('对照：同一编号被反复调出（这条是 detail-recall，不是方位判据）', [
  '方的纸，0731。',
  '短信上是0731检测中心。',
  '他又看了一遍0731那几个数字。',
  '纸条上的0731和短信前面那四个一样。',
  '0731是什么，他问。',
].join('\n'));
run('负例1：只有一处方位陈述（本章的真实形状）', [
  '侧袋里是水杯和伞。主袋里是卷子和错题本。',
  '再往里摸。指尖碰到一个硬的东西。',
  '书包搁在脚边，剑在主袋里，和卷子挤在一起。',
].join('\n'));
run('负例2：动作句里的"更深"不是方位陈述', [
  '他把笔搁在桌上，往抽屉更深的地方摸了摸。',
  '抽屉里是卷子。',
].join('\n'));
