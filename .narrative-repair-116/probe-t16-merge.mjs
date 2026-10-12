import { createChecks, loadPublicModules } from '../tests/narrative-repair/harness.mjs';
const { RP } = await loadPublicModules();
await import('../public/revision-plan.js');
const PL = globalThis.NovelRevisionPlan;

const body = '第一段：这里是开头。\n\n第二段：中间还有别的东西。\n\n第三段：结尾也是这样。';
const snap = RP.snapshotOf(body, { chapter_id: 71 });
const plan = PL.buildRevisionPlan({
  snapshot: snap,
  findings: [
    { id: 'A', text: '把「第一段：这里是开头。」改掉' },
    { id: 'B', text: '把「第三段：结尾也是这样。」改掉' },
  ],
});
console.log('hotspots =', JSON.stringify(plan.hotspots.map((h) => ({
  id: h.issue_id, span: h.span.span_id, start: h.span.start, end: h.span.end, original: h.original,
})), null, 1));
console.log('coverage =', JSON.stringify(plan.coverage.map((c) => `${c.issue_id}:${c.status}`)));
const midIncluded = plan.hotspots.some((h) => String(h.original).includes('中间还有别的东西'));
console.log('any hotspot swallowed the middle paragraph? ', midIncluded);
console.log('hotspot count =', plan.hotspots.length);
