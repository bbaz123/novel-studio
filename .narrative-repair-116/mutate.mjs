import fs from 'node:fs';
const p = 'public/revision-patch.js';
const src = fs.readFileSync(p, 'utf8');
const needle = '\n      if (opts.authorization) {\n';
const n = src.split(needle).length - 1;
if (n !== 1) { console.error('NEEDLE_MATCHES=' + n + '（必须唯一，否则变异不可信）'); process.exit(3); }
fs.writeFileSync('.narrative-repair-116/revision-patch.js.mutation-backup', src, 'utf8');
fs.writeFileSync(p, src.replace(needle, '\n      if (false && opts.authorization) {\n'), 'utf8');
console.log('MUTATED (post-check disabled)');
