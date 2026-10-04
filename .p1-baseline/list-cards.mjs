import fs from 'node:fs';
const src = fs.readFileSync('public/app.js', 'utf8').split('\n');
src.forEach((l, i) => { if (l.includes('showAITaskProgress(') && !l.includes('function showAITaskProgress')) console.log(`L${i + 1}: ${l.trim().slice(0, 100)}`); });
