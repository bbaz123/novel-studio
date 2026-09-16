#!/usr/bin/env node
/**
 * P1 探查（决定性）：直接调用生产代码 openviking-sync.js 的 getSemanticRecall，
 * 而不是复刻它。这是判断「装配层为何 no-hits」的最终依据。
 *
 * 用法: node probe-recall-direct.mjs <dataDir> <workId> <chapterId>
 *   dataDir 通过 NOVELSTUDIO_DATA_DIR 传给 db.js，必须在 import 之前设置。
 */
const [dataDir, workIdArg, chapterIdArg] = process.argv.slice(2);
process.env.NOVELSTUDIO_DATA_DIR = dataDir;

const { db } = await import('../db.js');
const { getSemanticRecall, workDir } = await import('../openviking-sync.js');
const prepare = (sql) => db.prepare(sql);

const workId = Number(workIdArg);
const chapterId = Number(chapterIdArg);

const work = prepare('SELECT id, title, ov_uri FROM works WHERE id = ?').get(workId);
const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);

console.log(`dataDir = ${dataDir}`);
console.log(`作品    = #${work.id} ${work.title}  ov_uri=${JSON.stringify(work.ov_uri)}`);
console.log(`workDir = ${workDir(workId)}`);
console.log(`章节    = #${chapter?.id} position=${chapter?.position}`);

const r = await getSemanticRecall(workId, chapter);
console.log(`\ngetSemanticRecall 返回：`);
console.log(`  enabled = ${r.enabled}`);
console.log(`  status  = ${r.status}`);
console.log(`  hits    = ${r.hits?.length ?? 0}`);
if (r.query) console.log(`  query   = ${r.query.slice(0, 200)}...`);
if (r.hits?.length) {
  console.log('  命中：');
  for (const h of r.hits) console.log(`    ${h.score}%  [${h.kind}] ${h.label}  (${h.uri})`);
}
process.exit(0);
