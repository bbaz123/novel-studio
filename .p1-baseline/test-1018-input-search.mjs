#!/usr/bin/env node
// v1.2.0 回归套件 · T09：P11 严格 ID/归属校验 + P15 检索 LIKE 转义与候选完整性。由 test-1018-hardening.mjs 串联执行。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePositiveInteger, parseOptionalPositiveInteger, escapeLike, likeContainsPattern } from '../ai/http/validation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
let pass = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); } };

console.log('【A. 严格解析（阴性对照）】');
{
  ok('A "5" → 5', parsePositiveInteger('5') === 5);
  ok('A 5 → 5', parsePositiveInteger(5) === 5);
  ok('A "12abc" → null', parsePositiveInteger('12abc') === null);
  ok('A 1.5 → null', parsePositiveInteger(1.5) === null);
  ok('A "1e3" → null', parsePositiveInteger('1e3') === null);
  ok('A -3 → null', parsePositiveInteger(-3) === null);
  ok('A Infinity → null', parsePositiveInteger(Number.POSITIVE_INFINITY) === null);
  ok('A 空串 → null', parsePositiveInteger('') === null);
  ok('A 可空字段：null → null（不是非法）', parseOptionalPositiveInteger(null) === null);
  ok('A 可空字段："" → null', parseOptionalPositiveInteger('') === null);
  ok('A LIKE 转义 %/_/\\', escapeLike('50%_x\\y') === '50\\%\\_x\\\\y', escapeLike('50%_x\\y'));
  ok('A LIKE 模式包裹', likeContainsPattern('100%') === '%100\\%%', likeContainsPattern('100%'));
}

const PORT = await new Promise((resolvePort) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolvePort(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'novel-1018-t09-'));
async function j(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data };
}
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA_DIR, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_OPENVIKING_PEER_ID: 'probe-1018-t09' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logText = '';
server.stdout.on('data', (c) => { logText += c; });
server.stderr.on('data', (c) => { logText += c; });
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try { const r = await j('/api/novel/ping'); if (r.status === 200) ready = true; } catch { /* 未就绪 */ }
  if (!ready) await new Promise((r) => setTimeout(r, 300));
}
if (!ready) { console.error('实例未就绪\n' + logText.slice(-2000)); process.exit(2); }

try {
  const workA = (await j('/api/works', { method: 'POST', body: { title: 'T09 A' } })).data.id;
  const workB = (await j('/api/works', { method: 'POST', body: { title: 'T09 B' } })).data.id;

  console.log('【B. 非法 work_id 不退化成全库检索】');
  for (const bad of ['abc', '1e3', '12abc', '-1', '1.5']) {
    const r = await j(`/api/search?q=风&work_id=${encodeURIComponent(bad)}`);
    ok(`B work_id=${bad} → 400`, r.status === 400, `实际 ${r.status}`);
  }
  const noWork = await j('/api/search?q=风');
  ok('B 不带 work_id 仍可全局检索 200', noWork.status === 200, `实际 ${noWork.status}`);

  console.log('【C. 500+ 候选：高相关结果不被前 200 条挤掉】');
  // 250 条"低相关"角色：identity 里含"风"（只是 contains），按 rowid 排在前面。
  for (let i = 0; i < 250; i += 1) {
    await j('/api/characters', { method: 'POST', body: { work_id: workA, name: `低频角色${i}`, identity: '风之过客' } });
  }
  // 高相关角色：名字恰好等于关键词，插入在最后（旧实现 LIMIT 200 永远看不到它）。
  const exact = await j('/api/characters', { method: 'POST', body: { work_id: workA, name: '风', identity: '风' } });
  ok('C 高相关角色已创建', exact.status === 201, `实际 ${exact.status}`);
  const searched = await j(`/api/search?q=%E9%A3%8E&work_id=${workA}`);
  const names = (searched.data.characters || []).map((c) => c.name);
  ok('C 检索成功', searched.status === 200, `实际 ${searched.status}`);
  ok('C 名字等于关键词的角色进入 Top20', names.includes('风'), JSON.stringify(names));
  ok('C 该角色排在首位（相关度排序）', names[0] === '风', JSON.stringify(names.slice(0, 3)));

  console.log('【D. LIKE 特殊字符按字面匹配】');
  await j('/api/characters', { method: 'POST', body: { work_id: workA, name: '100%纯', identity: '百分比角色' } });
  await j('/api/characters', { method: 'POST', body: { work_id: workA, name: '1000号', identity: '千号角色' } });
  const pct = await j(`/api/search?q=${encodeURIComponent('100%')}&work_id=${workA}`);
  const pctNames = (pct.data.characters || []).map((c) => c.name);
  ok('D "100%" 命中字面量角色', pctNames.includes('100%纯'), JSON.stringify(pctNames.slice(0, 5)));
  ok('D "100%" 不把 % 当通配符（不命中 1000号）', !pctNames.includes('1000号'), JSON.stringify(pctNames.slice(0, 5)));

  console.log('【E. 跨作品/非法外键归属校验】');
  const charA = (await j('/api/characters', { method: 'POST', body: { work_id: workA, name: 'A角' } })).data.id;
  const charB = (await j('/api/characters', { method: 'POST', body: { work_id: workB, name: 'B角' } })).data.id;
  const badRel = await j('/api/relations', { method: 'POST', body: { work_id: workA, from_character_id: charA, to_character_id: charB, relation: '朋友' } });
  ok('E 跨作品角色引用 → 400', badRel.status === 400, `实际 ${badRel.status} ${JSON.stringify(badRel.data).slice(0, 120)}`);
  const badId = await j('/api/relations', { method: 'POST', body: { work_id: workA, from_character_id: 'abc', to_character_id: charA } });
  ok('E 非法角色 id → 400', badId.status === 400, `实际 ${badId.status}`);
  const goodRel = await j('/api/relations', { method: 'POST', body: { work_id: workA, from_character_id: charA, to_character_id: charA, relation: '自省' } });
  ok('E 合法引用 → 201', goodRel.status === 201, `实际 ${goodRel.status}`);
  const badChapter = await j('/api/chapters', { method: 'POST', body: { work_id: workA, title: '坏卷章', volume_id: 'abc' } });
  ok('E 章节 volume_id 非法 → 400', badChapter.status === 400, `实际 ${badChapter.status}`);
  const crossVolume = await j('/api/volumes', { method: 'POST', body: { work_id: workB, title: 'B卷' } });
  const volB = crossVolume.data.id;
  const crossChapter = await j('/api/chapters', { method: 'POST', body: { work_id: workA, title: '跨卷章', volume_id: volB } });
  ok('E 章节引用别作品的卷 → 400', crossChapter.status === 400, `实际 ${crossChapter.status}`);
} catch (e) {
  fails.push('运行异常');
  console.error('运行异常：', e && e.stack ? e.stack : e);
} finally {
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 尽力清理 */ }
}
console.log(`\nT09 探针：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
