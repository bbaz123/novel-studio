#!/usr/bin/env node
/**
 * 一次性只读查询：确认 D8-#7 依赖的外部信号 `ov_indexed_at:<workId>` 在真实库里确实有值。
 * 只读打开（readOnly: true），不写任何东西。
 */
import { DatabaseSync } from 'node:sqlite';

for (const p of ['.p1-baseline/stress-data/novel.db', 'data/novel.db']) {
  console.log(`\n== ${p} ==`);
  let db;
  try {
    db = new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    console.log(`  打不开：${e.message}`);
    continue;
  }
  try {
    const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'ov_indexed_at:%'").all();
    console.log(`  ov_indexed_at 条目：${rows.length} 条`);
    for (const r of rows) {
      const v = String(r.value ?? '');
      console.log(`    ${r.key} = ${v ? v.slice(0, 32) : '（空 = 未索引/已清除）'}`);
    }
    const works = db.prepare('SELECT id, ov_uri FROM works ORDER BY id').all();
    console.log(`  作品：${works.map((w) => `#${w.id}(uri=${w.ov_uri})`).join(' ') || '（无）'}`);
  } catch (e) {
    console.log(`  查询失败：${e.message}`);
  } finally {
    db.close();
  }
}
