import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/novel.db', { readOnly: true });
const r = db.prepare("SELECT id, status, stage, substr(COALESCE(error,''),1,80) AS err FROM harness_jobs WHERE id = '22cc2e4d-1b75-435d-b654-6786ddaa253b'").get();
console.log(r ? `job ${r.id} status=${r.status} stage=${r.stage} error=${r.err}` : '（作业未落库）');
db.close();
