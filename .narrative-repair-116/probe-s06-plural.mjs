import { createChecks, loadPublicModules } from '../tests/narrative-repair/harness.mjs';
const { RP } = await loadPublicModules();
await import('../public/revision-plan.js');
const PL = globalThis.NovelRevisionPlan;

const cases = {
  A: '他低下头。\n\n过了一阵，他低下头。',
  B: '他低下头。\n\n他低下头，把手里的东西放下了。',
  C: '他低下头，把手里的东西放下了。\n\n他低下头。',
};
for (const [k, body] of Object.entries(cases)) {
  const spans = RP.buildSpans(body, { sentences: true });
  const occ = [];
  for (let i = body.indexOf('他低下头。'); i >= 0; i = body.indexOf('他低下头。', i + 1)) occ.push(i);
  const eq = spans.filter((s) => s.kind === 'sentence' && s.text === '他低下头。');
  const loc = PL.locateFragment(body, '他低下头。', spans);
  console.log(k, JSON.stringify({
    body,
    rawOccurrences: occ.length, occ,
    sentenceSpansEqual: eq.map((s) => [s.span_id, s.start, s.text]),
    locate: loc,
  }));
}
