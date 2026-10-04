import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const r = db.prepare("SELECT status, elapsed_ms FROM harness_jobs WHERE id = '22cc2e4d-1b75-435d-b654-6786ddaa253b'").get();
console.log(`验证作业：status=${r && r.status} elapsed=${r && r.elapsed_ms}ms`);
db.close();
