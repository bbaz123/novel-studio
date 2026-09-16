#!/usr/bin/env node
/**
 * P1 探查：移植 buildRecallQuery（openviking-sync.js:443-470），用它实际构造的查询词
 * 去打 OpenViking，判断「装配层 no-hits」到底是阈值/查询构造问题，还是别的原因。
 *
 * 用法: node probe-recall-query.mjs <db> <workId> <chapterId>
 */
import { DatabaseSync } from 'node:sqlite';

const [dbPath, workIdArg, chapterIdArg] = process.argv.slice(2);
const workId = Number(workIdArg);
const chapterId = Number(chapterIdArg);

const db = new DatabaseSync(dbPath, { readOnly: true });
const capText = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const htmlToPlain = (h) => String(h || '').replace(/<[^>]*>/g, '');

/** 逐行移植 openviking-sync.js:443-470 */
function buildRecallQuery(workId, chapter) {
  const parts = [];
  const work = db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (work?.title) parts.push(`作品：${work.title}`);
  if (work?.description) parts.push(`简介：${capText(work.description, 160)}`);
  if (work?.author_note) parts.push(`作品作者注：${capText(work.author_note, 200)}`);
  if (chapter) {
    parts.push(`当前章节：第${chapter.position + 1}节 ${chapter.title}`);
    if (chapter.summary) parts.push(`章节摘要：${capText(chapter.summary, 300)}`);
    if (chapter.blueprint_json) {
      try {
        const bp = JSON.parse(chapter.blueprint_json);
        const bpText = ['scene_goal', 'plot_points', 'conflicts', 'character_changes', 'hook']
          .map((k) => String(bp[k] || '')).filter(Boolean).join('；');
        if (bpText) parts.push(`本章蓝图：${capText(bpText, 400)}`);
      } catch { /* ignore */ }
    }
    if (chapter.author_note) parts.push(`章节作者注：${capText(chapter.author_note, 200)}`);
    const head = htmlToPlain(chapter.content || '').slice(0, 800);
    if (head) parts.push(`本章开头正文：${head}`);
  }
  const events = db.prepare('SELECT summary FROM story_events WHERE work_id = ? ORDER BY id DESC LIMIT 12').all(workId);
  if (events.length) parts.push(`最近事件：${events.map((e) => capText(e.summary, 120)).join('；')}`);
  return parts.filter(Boolean).join('\n').slice(0, 1600);
}

const work = db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
const chapter = chapterId ? db.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
const query = buildRecallQuery(workId, chapter);

console.log(`作品 #${workId} ${work.title}`);
console.log(`ov_uri = ${JSON.stringify(work.ov_uri)}`);
console.log(`章节 #${chapterId} position=${chapter?.position}`);
console.log(`\n构造出的查询词（${query.length} 字）：`);
console.log('─'.repeat(70));
console.log(query.slice(0, 700));
console.log('─'.repeat(70));

const targetUri = `viking://user/default/resources/novel-studio/${work.ov_uri}`;
console.log(`\ntarget_uri = ${targetUri}`);

for (const threshold of [0.3, 0.0]) {
  const body = { query, target_uri: targetUri, limit: 8 };
  if (threshold !== undefined) body.score_threshold = threshold;
  const r = await fetch('http://127.0.0.1:1933/api/v1/search/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  const hits = j?.result?.resources || [];
  console.log(`\nscore_threshold=${threshold} → HTTP ${r.status}, 命中 ${hits.length} 条`);
  for (const h of hits.slice(0, 5)) {
    console.log(`   ${Number(h.score).toFixed(4)}  ${h.uri.replace(targetUri + '/', '')}`);
  }
}

// ── top-k 扫描：元数据文件（. 开头）挤占了多少名额？放大 limit 能否捞出真正的内容文件？──
console.log('\n═══ top-k 扫描（元数据文件 vs 真实内容文件）═══');
console.log('  limit   命中   元数据(.开头)   内容文件   最高分内容文件');
for (const limit of [8, 12, 16, 24, 32, 48]) {
  const r = await fetch('http://127.0.0.1:1933/api/v1/search/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, target_uri: targetUri, limit, score_threshold: 0.3 }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  const hits = j?.result?.resources || [];
  const rels = hits.map((h) => ({ rel: String(h.uri).replace(targetUri + '/', ''), score: Number(h.score) }));
  const meta = rels.filter((x) => x.rel.split('/').pop().startsWith('.'));
  const content = rels.filter((x) => !x.rel.split('/').pop().startsWith('.'));
  const topContent = content.length ? `${content[0].rel} (${content[0].score.toFixed(3)})` : '—';
  console.log(`  ${String(limit).padStart(5)} ${String(hits.length).padStart(6)} ${String(meta.length).padStart(14)} ${String(content.length).padStart(11)}   ${topContent}`);
}
db.close();
