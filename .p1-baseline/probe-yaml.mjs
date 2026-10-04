import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('C:/Users/a1941/Desktop/DeepSeek/deepseek-harness/node_modules/noop.js');
const yaml = require('js-yaml');
for (const f of ['harness-plugins/novel-writing/agent.cordis.yml', 'harness-plugins/novel-writing/cordis.patch.yml']) {
  try {
    const d = yaml.load(fs.readFileSync(f, 'utf8'));
    const txt = JSON.stringify(d);
    console.log(`${f} → ${Array.isArray(d) ? 'array/' + d.length : typeof d} OK；含「叙述者也不越界」=${txt.includes('叙述者也不越界') || txt.includes('叙述者不要越界')}`);
  } catch (e) { console.log(`${f} → FAIL ${e.message}`); }
}
