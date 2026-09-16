#!/usr/bin/env node
/**
 * P1 探查：为什么上下文装配里的「语义召回层」始终 no-hits，而同一 target URI
 * 用 MCP find 却能返回命中。直接复刻客户端的请求，逐步定位。
 *
 * 客户端调用：POST {endpoint}/api/v1/search/find
 *   body = { query, target_uri, limit, score_threshold }
 */
const ENDPOINT = process.argv[2] || 'http://127.0.0.1:1933';
const TARGET = process.argv[3] || 'viking://user/default/resources/novel-studio/632ebd2e0985ade324d52f1dffc494cb';
const QUERY = process.argv[4] || '雾潮缝针灯巷钟信线影';

const post = async (body, label) => {
  try {
    const r = await fetch(`${ENDPOINT}/api/v1/search/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    const counts = j?.result
      ? Object.fromEntries(Object.entries(j.result).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v]))
      : null;
    console.log(`\n[${label}] HTTP ${r.status}`);
    console.log(`  body: ${JSON.stringify(body)}`);
    console.log(`  result 计数: ${JSON.stringify(counts)}`);
    const first = j?.result?.resources?.[0];
    if (first) console.log(`  首条: uri=${first.uri} score=${first.score}`);
    if (!j) console.log(`  原始响应(前 300): ${text.slice(0, 300)}`);
    return j;
  } catch (e) {
    console.log(`\n[${label}] 失败: ${e.message}`);
    return null;
  }
};

console.log(`endpoint = ${ENDPOINT}`);
console.log(`target   = ${TARGET}`);
console.log(`query    = ${QUERY}`);

// 1) 复刻客户端：score_threshold = 0.3（openviking-sync.js:434 RECALL_SCORE_THRESHOLD）
await post({ query: QUERY, target_uri: TARGET, limit: 8, score_threshold: 0.3 }, '复刻客户端 score_threshold=0.3');

// 2) 不带阈值
await post({ query: QUERY, target_uri: TARGET, limit: 8 }, '不带阈值');

// 3) 阈值换成 0（排除阈值语义问题）
await post({ query: QUERY, target_uri: TARGET, limit: 8, score_threshold: 0 }, '阈值=0');

// 4) 换 min_score 字段名（MCP find 用的名字）
await post({ query: QUERY, target_uri: TARGET, limit: 8, min_score: 0.3 }, '字段名 min_score=0.3');

// 5) 不带 target_uri（排除子树限定问题）
await post({ query: QUERY, limit: 8, score_threshold: 0.3 }, '不带 target_uri');
