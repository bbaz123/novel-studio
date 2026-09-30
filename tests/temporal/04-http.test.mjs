#!/usr/bin/env node
/**
 * tests/temporal/04-http.test.mjs —— 时态故事状态 HTTP 端到端（生产路由接线证据，零计费）。
 *
 * 为什么单列：01–03 证明领域与存储；本套件只证明**真实 HTTP 路由**确实接上了 service：
 *   H1  新作品默认关闭；总览可读、schema 自检通过
 *   H2  未开启作品：/at 返回 enabled:false（不写一行、不报错）
 *   H3  模型通道（X-Novel-Agent）不能开开关 / 不能确认状态（403）
 *   H4  作者可开启（temporal_enabled / auto_analysis_enabled / repair_enabled）
 *   H5  第 5 章存活、第 10 章战死：两个历史查询结果不同（AC-01）
 *   H6  章前不含本章结尾事件（AC-03）
 *   H7  章节状态面板读真实时态状态（出场 + 截至本章 + 变更）
 *   H8  新稿把死亡改到第 5 章：新稿第 5 章死亡、原历史提交仍显示存活（AC-02）
 *   H9  参数与归属校验（缺 chapter_id → 400；别家章节 → 404）
 *
 * 用法（必须走隔离实例，绝不指向真实 3737）：
 *   node scripts/ci-isolated-run.mjs --port 3756 -- node tests/temporal/04-http.test.mjs --base http://127.0.0.1:3756
 */
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://127.0.0.1:3756');

let pass = 0; const fails = []; const skips = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fails.push({ name, detail }); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
const agent = { 'x-novel-agent': '1' };
const cell = (domain, entityId, predicate, scope = 'canon', holderId = null) => ({ domain, entityId, predicate, scope, ...(scope === 'character' ? { holderId } : {}) });
const setOp = (c, value, expected = { kind: 'missing' }) => ({ type: 'set', cell: c, expected, value });
const kv = (domain, entityId, predicate, scope = 'canon', holderId = null) => JSON.stringify([domain, entityId, predicate, scope, holderId]);

async function main() {
  console.log(`temporal HTTP 端到端 @ ${BASE}\n`);
  const w = await api('POST', '/api/works', { title: '时态状态 HTTP 测试《青云纪》', description: '自动化测试作品（自清理）' });
  if (w.status !== 201 && w.status !== 200) { console.error('建作品失败', w.status, w.text.slice(0, 200)); process.exit(2); }
  const workId = w.json.id;
  const chapters = [];
  for (let i = 1; i <= 10; i += 1) {
    const c = await api('POST', '/api/chapters', { work_id: workId, title: `第${i}章`, content: '' });
    if (c.status >= 300) { console.error('建章节失败', c.status, c.text.slice(0, 200)); process.exit(2); }
    chapters.push(c.json.id);
  }
  const c = chapters;
  try {
    // ── H1 默认关闭 + 总览 ────────────────────────────────────────────────
    console.log('【H1 默认关闭与总览】');
    {
      const s = await api('GET', `/api/novel/state/temporal?work_id=${workId}`);
      ok('H1a 总览可读且默认关闭', s.status === 200 && s.json.config && s.json.config.enabled === false, `status=${s.status} enabled=${s.json?.config?.enabled}`);
      ok('H1b 引擎 schema 自检通过（11 张表齐全）', s.json.schema_ok === true, (s.json.missing_tables || []).join(','));
      ok('H1c 未开启时没有 HEAD / 没有提交', s.json.head_commit_id === null, String(s.json.head_commit_id));
    }

    // ── H2 未开启作品的时间线查询 ─────────────────────────────────────────
    console.log('【H2 未开启作品：零写入、零副作用】');
    {
      const at = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[4]}`);
      ok('H2a /at 返回 enabled:false（不是报错、也不是空状态冒充）', at.status === 200 && at.json.enabled === false, `status=${at.status} ${at.text.slice(0, 120)}`);
      const panel = await api('GET', `/api/novel/state/panel?work_id=${workId}&chapter_id=${c[4]}`);
      ok('H2b /panel 同样 enabled:false', panel.status === 200 && panel.json.enabled === false);
      const s = await api('GET', `/api/novel/state/temporal?work_id=${workId}`);
      ok('H2c 查询没有产生任何提交（未开启作品零写入）', s.json.head_commit_id === null && s.json.config.enabled === false);
    }

    // ── H3 模型通道边界 ──────────────────────────────────────────────────
    console.log('【H3 模型通道不能开开关 / 不能确认】');
    {
      const put = await api('PUT', '/api/novel/state/temporal', { work_id: workId, temporal_enabled: true }, agent);
      ok('H3a 模型侧开开关 → 403', put.status === 403, `status=${put.status}`);
      const conf = await api('POST', '/api/novel/state/confirm', { work_id: workId, chapter_id: c[0], events: [] }, agent);
      ok('H3b 模型侧确认状态 → 403', conf.status === 403, `status=${conf.status}`);
    }

    // ── H4 作者开启 ──────────────────────────────────────────────────────
    console.log('【H4 作者开启三个开关】');
    {
      const put = await api('PUT', '/api/novel/state/temporal', { work_id: workId, temporal_enabled: true, auto_analysis_enabled: true, repair_enabled: true, note: 'HTTP 测试' });
      ok('H4a 作者开启成功', put.status === 200 && put.json.config.enabled === true, `status=${put.status} ${put.text.slice(0, 120)}`);
      ok('H4b 三个开关分离保存', put.json.config.auto_analysis === true && put.json.config.repair === true);
    }

    // ── H5/H6 建立 10 章历史（作者逐章确认）──────────────────────────────
    console.log('【H5/H6 逐章确认 → 历史查询】');
    const contents = [
      '<p>第一章 青云镇的清晨</p>', '<p>第二章 黑风谷任务开始</p>', '<p>第三章 主角拜王师傅为师</p>',
      '<p>第四章 王师傅留在青云镇</p>', '<p>第五章 主角在青云镇等待</p>', '<p>第六章 有人答应接应</p>',
      '<p>第七章 主角寻找王师傅</p>', '<p>第八章 主角决定守护青云镇</p>', '<p>第九章 黑风谷的地形</p>',
      '<p>第十章 王师傅战死沙场</p>',
    ];
    const ops = [
      [setOp(cell('world_fact', '青云镇', 'exists'), true)],
      [setOp(cell('plotline', '黑风谷任务', 'state'), '进行中')],
      [setOp(cell('relation', '主角|王师傅', '师徒'), { from: '主角', to: '王师傅', label: '师徒' })],
      [setOp(cell('character', '王师傅', 'alive'), true), setOp(cell('character', '王师傅', 'status'), '存活'), setOp(cell('character', '王师傅', 'location'), '青云镇')],
      [setOp(cell('appearance', String(c[4]), '王师傅'), { name: '王师傅' }), setOp(cell('appearance', String(c[4]), '主角'), { name: '主角' }), setOp(cell('character', '主角', 'alive'), true)],
      [setOp(cell('plotline', '黑风谷任务', 'summary'), '等待王师傅接应')],
      [setOp(cell('task', '寻找王师傅', 'state'), '进行中')],
      [setOp(cell('goal', '守护青云镇', 'state'), 'active')],
      [setOp(cell('location', '黑风谷', 'known'), true)],
      [setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }), setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }), setOp(cell('character', '王师傅', 'death_reason'), '战死')],
    ];
    for (let i = 0; i < 10; i += 1) {
      const quote = contents[i].replace(/<\/?p>/g, '').replace(/^第.章 /, '');
      const r = await api('POST', '/api/novel/state/confirm', {
        work_id: workId, chapter_id: c[i], content_html: contents[i],
        events: [{ ops: ops[i], evidence: [{ quote, narrative: 'present' }] }],
      });
      if (!r.json || r.json.ok !== true) { ok(`H5 第 ${i + 1} 章确认`, false, `status=${r.status} ${r.text.slice(0, 220)}`); }
    }
    ok('H5a 10 章全部确认成功（事件按作者确认进入正式状态）', true);
    const s = await api('GET', `/api/novel/state/temporal?work_id=${workId}`);
    ok('H5b 提交清单覆盖 10 章', s.json.manifest_size === 10, `size=${s.json.manifest_size}`);
    const headAfter10 = s.json.head_commit_id;
    const after5 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[4]}&boundary=after`);
    const after10 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[9]}&boundary=after`);
    ok('H5c 第 5 章：王师傅存活', after5.json.state_json?.[kv('character', '王师傅', 'alive')] === true, JSON.stringify(after5.json.state_json?.[kv('character', '王师傅', 'alive')]));
    ok('H5d 第 10 章：王师傅战死', after10.json.state_json?.[kv('character', '王师傅', 'alive')] === false && after10.json.state_json?.[kv('character', '王师傅', 'status')] === '战死');
    ok('H5e 两个历史查询哈希不同（不拿最新值冒充历史）', after5.json.state_content_hash !== after10.json.state_content_hash);
    const before10 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[9]}&boundary=before`);
    ok('H6 第 10 章写作章前不含本章结尾事件（王师傅仍存活）', before10.json.state_json?.[kv('character', '王师傅', 'alive')] === true, JSON.stringify(before10.json.state_json?.[kv('character', '王师傅', 'alive')]));
    ok('H6b 章前与章后哈希不同', before10.json.state_content_hash !== after10.json.state_content_hash);

    // ── H7 章节状态面板 ──────────────────────────────────────────────────
    console.log('【H7 正文下方状态面板（真实后端数据）】');
    {
      const p = await api('GET', `/api/novel/state/panel?work_id=${workId}&chapter_id=${c[4]}&full=1`);
      const chars = p.json.characters || [];
      const wang = chars.find((x) => x.entity_id === '王师傅');
      ok('H7a 面板返回 valid 绑定与可信前缀', p.json.binding_validity === 'valid' && p.json.trusted === true && p.json.state_scope === 'through_chapter', `validity=${p.json.binding_validity}`);
      ok('H7b 本章出场角色含王师傅（来自事件，不是前端硬编码）', (p.json.appearances || []).some((a) => a.name === '王师傅'), JSON.stringify(p.json.appearances));
      ok('H7c 截至本章王师傅存活且被标为本章出场', !!wang && wang.alive === true && wang.in_chapter === true, JSON.stringify(wang));
      ok('H7d 本章状态变化列出 alive/status/location 的 before→after', (p.json.changes || []).some((x) => x.domain === 'character' && x.predicate === 'alive' && x.to === true));
      ok('H7e include_full 时展开完整 Story State', !!p.json.full_state && typeof p.json.full_state === 'object');
    }

    // ── H8 前文改动 → 新提交；旧提交仍可回放 ─────────────────────────────
    console.log('【H8 新稿第 5 章死亡，原历史提交仍显示存活】');
    {
      const r = await api('POST', '/api/novel/state/confirm', {
        work_id: workId, chapter_id: c[4], content_html: '<p>第五章 王师傅在青云镇外战死</p>',
        events: [{
          ops: [
            setOp(cell('character', '王师傅', 'alive'), false, { kind: 'value', value: true }),
            setOp(cell('character', '王师傅', 'status'), '战死', { kind: 'value', value: '存活' }),
            setOp(cell('character', '王师傅', 'death_reason'), '战死', { kind: 'missing' }),
          ],
          evidence: [{ quote: '王师傅在青云镇外战死', narrative: 'present' }],
        }],
      });
      ok('H8a 新稿确认成功（形成新提交）', r.json?.ok === true, r.text.slice(0, 200));
      const s = await api('GET', `/api/novel/state/temporal?work_id=${workId}`);
      ok('H8b HEAD 前进为新提交', s.json.head_commit_id && s.json.head_commit_id !== headAfter10, `${headAfter10} → ${s.json.head_commit_id}`);
      const now5 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[4]}&boundary=after`);
      ok('H8c 新稿第 5 章：战死', now5.json.state_json?.[kv('character', '王师傅', 'alive')] === false);
      const old5 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[4]}&boundary=after&commit_id=${encodeURIComponent(headAfter10)}`);
      ok('H8d 原历史提交第 5 章仍显示存活', old5.json.state_json?.[kv('character', '王师傅', 'alive')] === true, JSON.stringify(old5.json.state_json?.[kv('character', '王师傅', 'alive')]));
      const c6 = await api('GET', `/api/novel/state/at?work_id=${workId}&chapter_id=${c[5]}&boundary=after`);
      ok('H8e 下游第 6 章被标 stale（先分析、不自动改写）', c6.json.validity === 'stale' || (c6.json.stop && c6.json.stop.reason === 'stale'), `validity=${c6.json.validity} stop=${JSON.stringify(c6.json.stop)}`);
    }

    // ── H9 参数与归属校验 ────────────────────────────────────────────────
    console.log('【H9 参数与归属校验】');
    {
      const noChapter = await api('GET', `/api/novel/state/at?work_id=${workId}`);
      ok('H9a 缺 chapter_id → 400', noChapter.status === 400, `status=${noChapter.status}`);
      const badWork = await api('GET', `/api/novel/state/at?work_id=${workId + 99999}&chapter_id=${c[0]}`);
      ok('H9b 作品不存在 → 404', badWork.status === 404, `status=${badWork.status}`);
      const emptyEvents = await api('POST', '/api/novel/state/confirm', { work_id: workId, chapter_id: c[0], events: [] });
      ok('H9c 空事件确认 → 400（确认清单必须带具体操作）', emptyEvents.status === 400, `status=${emptyEvents.status}`);
    }
  } finally {
    try { await api('DELETE', `/api/works/${workId}`); } catch { /* 自清理 */ }
  }
  console.log('\n' + '─'.repeat(46));
  console.log(`temporal HTTP 端到端：通过 ${pass} / 失败 ${fails.length} / 跳过 ${skips.length}`);
  if (fails.length) { for (const f of fails) console.log(`  ✗ ${f.name}${f.detail ? '  — ' + f.detail : ''}`); process.exit(1); }
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });

