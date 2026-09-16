#!/usr/bin/env node
/**
 * P1 探查：复刻 getSemanticRecall 在 find 之后的两步（读取内容 → 噪声过滤），
 * 找出「find 明明返回 8 条命中，装配层却报 no-hits」的确切原因。
 *
 * 对应源码：openviking-sync.js:518-552（读取与过滤）、:486-496（isRecallNoise）
 */
const ENDPOINT = process.argv[2] || 'http://127.0.0.1:1933';
const TARGET = process.argv[3] || 'viking://user/default/resources/novel-studio/632ebd2e0985ade324d52f1dffc494cb';
const QUERY = process.argv[4] || '雾潮缝针灯巷钟信线影';

// 从 openviking-sync.js 抄录：以「.」开头的元数据文件与占位文件视为噪声
function isRecallNoise(rel, text) {
  const name = (rel || '').split('/').pop() || '';
  if (name.startsWith('.')) return true;
  const body = String(text || '').split('\n').slice(1).join('\n').trim();
  // 与源码保持一致：正文去掉首行标题后为空，或整体为占位文案
  if (!body) return true;
  if (/^[（(]暂无/.test(body)) return true;
  return false;
}

const res = await (await fetch(`${ENDPOINT}/api/v1/search/find`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: QUERY, target_uri: TARGET, limit: 8, score_threshold: 0.3 }),
  signal: AbortSignal.timeout(15000),
})).json();

const hits = res.result?.resources || [];
console.log(`find 返回 ${hits.length} 条\n`);
console.log('=== 第一条命中的完整字段 ===');
console.log(JSON.stringify(hits[0], null, 2).slice(0, 900));

console.log('\n=== 复刻 readContent（GET /api/v1/content/read?limit=30）===');
for (const h of hits.slice(0, 8)) {
  const url = `${ENDPOINT}/api/v1/content/read?uri=${encodeURIComponent(h.uri)}&offset=0&limit=30`;
  let ok = false;
  let text = '';
  let status = 0;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    status = r.status;
    const j = await r.json().catch(() => ({}));
    const result = j?.result ?? j;
    text = typeof result === 'string' ? result : (result?.content || result?.text || '');
    ok = r.ok;
  } catch (e) {
    text = `<${e.message}>`;
  }
  // 客户端逻辑：read.ok ? read.text : (h.abstract || '')
  const effective = ok ? text : (h.abstract || '');
  const rel = h.uri.replace(`${TARGET}/`, '');
  const noise = isRecallNoise(rel, effective);
  console.log(
    `  HTTP ${status}  read.ok=${ok}  textLen=${String(text.length).padStart(6)}  abstractLen=${String((h.abstract || '').length).padStart(6)}  → effectiveLen=${String(effective.length).padStart(6)}  rel=${rel}  noise=${noise}  ${noise ? '❌被过滤' : '✅保留'}`,
  );
}
