import fs from 'node:fs';
const src = fs.readFileSync('public/app.js', 'utf8');
// 提取 longTextLimits / longTextPlanFor 相关片段，确认单请求判据依赖什么
for (const name of ['function longTextLimits', 'function longTextPlanFor']) {
  const i = src.indexOf(name);
  console.log(`\n=== ${name} @${i} ===`);
  console.log(src.slice(i, i + 900));
}
