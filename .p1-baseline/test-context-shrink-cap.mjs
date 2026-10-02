import assert from 'node:assert/strict';
import { assemble } from '../ai/context/assembler.mjs';
const long = 'x'.repeat(5000);
const out = assemble([
  { id: 'story_tail', label: '尾巴', kind: 'flex', cap: 1600, text: long },
  { id: 'outline', label: '大纲', kind: 'flex', cap: 2800, text: long },
], { totalBudget: 100, flexCaps: [2400, 1600, 800, 400] });
assert.ok(out.shrinkLog.length > 0);
for (const step of out.shrinkLog) assert.ok(step.appliedCap <= step.declaredCap, JSON.stringify(step));
console.log(`Context shrink cap：通过 ${out.shrinkLog.length} 步，所有 appliedCap <= declaredCap`);
