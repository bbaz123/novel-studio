// Professional API test suite for the isolated Novel Studio instance (127.0.0.1:3738).
// Zero-dependency, node >= 22 (node:sqlite not needed here; fetch/net built-ins).
// Covers: static/serving, security (CORS/Origin/path traversal/payload limit/masking),
// CRUD lifecycle + validation + optimistic locking, novel kernel endpoints,
// search, import/export, logs endpoints, api_configs masking.
// Self-cleaning: deletes every resource it creates (except logs which it leaves for UI demo).

const BASE = 'http://127.0.0.1:3738';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const results = [];
let created = { works: [], others: [] };

function record(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function api(method, path, { body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}
// raw socket request for cases fetch normalizes (path traversal, OPTIONS headers)
function rawHttp(requestLines) {
  return new Promise((resolve) => {
    const sock = net.connect(3738, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => sock.write(requestLines));
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
    sock.setTimeout(5000, () => { sock.destroy(); resolve(buf); });
  });
}

async function main() {
  console.log('== A. 静态服务与路径安全 ==');
  {
    const r = await api('GET', '/');
    record('A1 首页返回 200 且含产品名', r.status === 200 && r.text.includes('Novel Studio'), `status=${r.status}`);
    const r2 = await api('GET', '/app.js');
    record('A2 静态资源 app.js 200', r2.status === 200 && r2.text.includes('novel'), `status=${r2.status}`);
    const raw = await rawHttp('GET /../package.json HTTP/1.1\r\nHost: 127.0.0.1:3738\r\nConnection: close\r\n\r\n');
    record('A3 路径穿越被中和(不回传 package.json 内容)', raw.startsWith('HTTP/1.1 200') && !raw.includes('"name": "novel-studio"'), raw.split('\r\n')[0]);
    const opt = await rawHttp('OPTIONS /api/works HTTP/1.1\r\nHost: 127.0.0.1:3738\r\nOrigin: http://evil.com\r\nConnection: close\r\n\r\n');
    record('A4 无 ACAO 通配/CORS 响应头', !/Access-Control-Allow-Origin/i.test(opt), opt.split('\r\n')[0]);
    const r3 = await api('GET', '/api/definitely-not-exist');
    record('A5 未知 API 404 JSON', r3.status === 404 && r3.json?.error, `status=${r3.status}`);
    const r4 = await api('GET', '/api/works/12abc');
    record('A6 非法 id 段 404 而非全量列表', r4.status === 404, `status=${r4.status}`);
  }

  console.log('\n== B. 跨源防护与请求体限制 ==');
  {
    const r1 = await api('POST', '/api/works', { body: { title: 'evil' }, headers: { Origin: 'http://evil.com' } });
    record('B1 恶意 Origin 写请求 403', r1.status === 403, `status=${r1.status}`);
    const r2 = await api('POST', '/api/works', { body: { title: 'evil-host' }, headers: { Origin: 'null' } });
    record('B2 Origin:null 写请求拒绝', r2.status === 403, `status=${r2.status}`);
    const r3 = await api('POST', '/api/works', { body: '{bad json', });
    record('B3 非法 JSON 400', r3.status === 400, `status=${r3.status}`);
    const big = Buffer.alloc(33 * 1024 * 1024, 65); // 33MB
    let payloadResult = '';
    try {
      const res = await fetch(BASE + '/api/works', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
      payloadResult = 'status=' + res.status;
      await res.text();
    } catch (e) {
      payloadResult = 'network:' + (e.cause?.code || e.message);
    }
    record('B4 超 32MB 请求体被拒绝(413或断连)', /status=413|network:/.test(payloadResult), payloadResult);
    const r5 = await api('POST', '/api/works', { body: { title: '本机同源' }, headers: { Origin: 'http://127.0.0.1:3738' } });
    record('B5 本机 Origin 写请求放行', r5.status === 201, `status=${r5.status}`);
    if (r5.json?.id) { created.works.push(r5.json.id); await api('DELETE', `/api/works/${r5.json.id}`); }
  }

  console.log('\n== C. works CRUD 生命周期与校验 ==');
  {
    const r1 = await api('POST', '/api/works', { body: { title: '' } });
    record('C1 空标题作品 400', r1.status === 400, r1.json?.error);
    const r2 = await api('POST', '/api/works', { body: { title: 'API测试作品《潮汐拾遗》', description: 'desc', default_chapter_words: 1500 } });
    const wid = r2.json?.id;
    record('C2 创建作品 201 + 返回行', r2.status === 201 && wid > 0, `id=${wid}`);
    record('C3 新作品自动分配 ov_uri(UUID 隔离)', /^[0-9a-f]{32}$/.test(r2.json?.ov_uri || ''), r2.json?.ov_uri);
    created.works.push(wid);
    const r3 = await api('GET', `/api/works/${wid}`);
    record('C4 按 id 读取 200', r3.status === 200 && r3.json?.title?.includes('潮汐拾遗'), r3.json?.title);
    const r4 = await api('PUT', `/api/works/${wid}`, { body: { description: '改过的简介' } });
    record('C5 更新作品 200', r4.status === 200 && r4.json?.description === '改过的简介');
    const r5 = await api('PUT', `/api/works/${wid}`, { body: { title: '  ' } });
    record('C6 编辑清空标题被拒 400', r5.status === 400, r5.json?.error);
    const r6 = await api('GET', '/api/works/99999');
    record('C7 不存在作品 404', r6.status === 404);
    const r7 = await api('PUT', '/api/works/99999', { body: { title: 'x' } });
    record('C8 更新不存在 404', r7.status === 404);
    const r8 = await api('DELETE', '/api/works/99999');
    record('C9 删除不存在 404', r8.status === 404);
  }

  console.log('\n== D. 章节 CRUD 与乐观锁 ==');
  {
    const wid = created.works.at(-1);
    const r1 = await api('POST', '/api/chapters', { body: { work_id: wid, title: '第一章 潮声', content: '<p>正文内容，用于测试。</p>' } });
    const cid = r1.json?.id;
    record('D1 创建章节 201', r1.status === 201 && cid > 0, `id=${cid}`);
    created.others.push(['chapters', cid]);
    const r2 = await api('PUT', `/api/chapters/${cid}`, { body: { content: '<p>第一版</p>', _if_updated_at: '2000-01-01T00:00:00.000Z' } });
    record('D2 过期 updated_at 乐观锁 409', r2.status === 409, r2.json?.error);
    const fresh = r1.json?.updated_at;
    const r3 = await api('PUT', `/api/chapters/${cid}`, { body: { content: '<p>第二版内容</p>', _if_updated_at: fresh } });
    record('D3 正确 updated_at 保存 200', r3.status === 200 && r3.json?.content?.includes('第二版'), `status=${r3.status}`);
    // 乐观锁推进验证：若 updated_at 在保存后被推进，同一旧时间戳应 409；被冻结则应 200（锁失效证据）
    const r3b = await api('PUT', `/api/chapters/${cid}`, { body: { content: '<p>第三版(旧时间戳重放)</p>', _if_updated_at: fresh } });
    record('D3b 保存后旧时间戳重放应 409（锁值推进检查）', r3b.status === 409, `实际 status=${r3b.status}${r3b.status === 200 ? ' → 乐观锁值未推进(缺陷证据)' : ''}`);
    const r4 = await api('GET', `/api/chapters?work_id=${wid}`);
    record('D4 章节列表按 work_id 过滤', r4.status === 200 && Array.isArray(r4.json) && r4.json.length === 1, `count=${r4.json?.length}`);
  }

  console.log('\n== E. 设定类资源 CRUD（卷/剧情线/分类/词条/角色/世界观词条） ==');
  {
    const wid = created.works.at(-1);
    const mk = async (res, body) => { const r = await api('POST', `/api/${res}`, { body: { work_id: wid, ...body } }); if (r.json?.id) created.others.push([res, r.json.id]); return r; };
    const v = await mk('volumes', { title: '第一卷' });
    record('E1 卷 201', v.status === 201);
    const pl = await mk('plotlines', { title: '主线·归潮', kind: 'main', summary: '测试' });
    record('E2 剧情线 201', pl.status === 201);
    const cat = await mk('categories', { name: '测试分类' });
    record('E3 分类 201', cat.status === 201);
    const t = await mk('terms', { title: '潮汐引擎', category_id: cat.json?.id, content: '词条详情' });
    record('E4 设定词条 201', t.status === 201);
    const ch = await mk('characters', { name: '陆沉', identity: '拾潮人', personality: '沉默', aliases: '阿沉' });
    record('E5 角色卡 201', ch.status === 201);
    const we = await mk('world_entries', { title: '潮汐引擎', content: '世界观词条正文', keywords: '潮汐,引擎' });
    record('E6 世界观词条 201', we.status === 201);
    const bad = await api('POST', '/api/terms', { body: { name: '孤儿词条', category_id: 99999 } });
    record('E7 分类归属校验(不存在分类被拒)', bad.status === 400, bad.json?.error);
    const rawErr = await api('POST', '/api/terms', { body: { work_id: wid, name: '缺 title 字段' } });
    record('E8 缺必填字段 400（但错误信息直露 SQLite 约束）', rawErr.status === 400, rawErr.json?.error);
  }

  console.log('\n== F. 创作内核端点（伏笔/一致性/蓝图/审稿/记忆/提案） ==');
  {
    const wid = created.works.at(-1);
    const r1 = await api('GET', '/api/novel/foreshadows');
    record('F1 伏笔列表缺 work_id 400', r1.status === 400);
    const r2 = await api('GET', `/api/novel/foreshadows?work_id=${wid}`);
    record('F2 伏笔列表 200', r2.status === 200 && Array.isArray(r2.json?.foreshadows));
    const r3 = await api('POST', '/api/novel/consistency', { body: { work_id: wid, text: '陆沉走向海边。' } });
    record('F3 一致性核对清单 200', r3.status === 200 && r3.json?.checklist, `keys=${Object.keys(r3.json?.checklist || {}).join(',')}`);
    const r4 = await api('POST', '/api/novel/consistency', { body: { work_id: 99999, text: 'x' } });
    record('F4 一致性核对 404 作品不存在', r4.status === 404);
    const chRes = await api('POST', '/api/chapters', { body: { work_id: wid, title: '第二章 蓝图测试' } });
    const cid = chRes.json?.id; created.others.push(['chapters', cid]);
    const r5 = await api('PUT', '/api/novel/chapter_blueprint', { body: { chapter_id: cid, work_id: wid, blueprint: {} } });
    record('F5 空蓝图拒绝 400', r5.status === 400);
    const r6 = await api('PUT', '/api/novel/chapter_blueprint', { body: { chapter_id: cid, work_id: wid, blueprint: { scene_goal: '测试场景目标' }, target_words: 1200 } });
    record('F6 蓝图保存 200 + 字数覆盖', r6.status === 200 && r6.json?.target_words === 1200);
    const r7 = await api('PUT', '/api/novel/chapter_blueprint', { body: { chapter_id: cid, work_id: 99999, blueprint: { scene_goal: 'x' } } });
    record('F7 蓝图 work_id 归属校验 400', r7.status === 400);
    const r8 = await api('PUT', '/api/novel/review', { body: { chapter_id: cid, work_id: wid, report: {} } });
    record('F8 空审稿报告拒绝 400', r8.status === 400);
    const r9 = await api('PUT', '/api/novel/review', { body: { chapter_id: cid, work_id: wid, report: { summary: '总评：尚可', issues: [{ severity: 'low', text: '节奏略快' }] } } });
    record('F9 审稿报告保存 201', r9.status === 201, `review_id=${r9.json?.review_id}`);
    const r10 = await api('GET', `/api/novel/review?chapter_id=${cid}`);
    record('F10 审稿报告读取 200', r10.status === 200 && r10.json?.review?.report?.summary, r10.json?.review?.report?.summary);
  }

  console.log('\n== G. 搜索 / 统计 / 导入导出 ==');
  {
    const wid = created.works.at(-1);
    const r1 = await api('GET', `/api/search?q=${encodeURIComponent('潮汐 陆沉')}&work_id=${wid}`);
    record('G1 多关键词搜索 200 分组+语义返回', r1.status === 200 && r1.json?.terms && r1.json?.semantic, `groups=${Object.keys(r1.json || {}).join(',')}`);
    const r2 = await api('GET', `/api/stats?work_id=${wid}`);
    record('G2 统计接口 200', r2.status === 200 && typeof r2.json?.chapters === 'number', JSON.stringify(r2.json));
    const txt = '《导入测试集》\n\n第一章 初入\n这里是第一章正文。\n\n第二章 远行\n这里是第二章正文。\n\n第三章 归来\n这里是第三章正文。';
    const r3 = await api('POST', '/api/import', { body: { title: '导入测试集', text: txt } });
    record('G3 TXT 导入自动拆章 201', r3.status === 201 && r3.json?.chapters === 3, `chapters=${r3.json?.chapters}`);
    if (r3.json?.work_id) created.works.push(r3.json.work_id);
    const r4 = await api('POST', '/api/import', { body: { base64: '!!!not-base64!!!' } });
    record('G4 非法 base64 导入 400', r4.status === 400);
    const r5 = await api('GET', `/api/export/txt?work_id=${wid}`);
    record('G5 整书 TXT 导出(含中文文件名头)', r5.status === 200 && r5.text.includes('第一章'), `disposition=${r5.headers.get('content-disposition')?.slice(0, 60)}`);
    const r6 = await api('GET', `/api/export/md?work_id=${wid}`);
    record('G6 整书 MD 导出 200', r6.status === 200 && r6.text.length > 0);
    const chList = await api('GET', `/api/chapters?work_id=${wid}`);
    const r7 = await api('GET', `/api/export/txt?chapter_id=${chList.json[0].id}`);
    record('G7 单章 TXT 导出 200', r7.status === 200);
    const r8 = await api('GET', '/api/export/txt?work_id=99999');
    record('G8 导出不存在作品 404', r8.status === 404);
  }

  console.log('\n== H. 日志系统端点 ==');
  {
    const r1 = await api('GET', '/api/logs?level=error&limit=5');
    record('H1 日志列表 200 分页结构', r1.status === 200 && Array.isArray(r1.json?.entries) && r1.json?.stats, `stats=${JSON.stringify(r1.json?.stats)}`);
    const r2 = await api('GET', '/api/logs?layer=harness');
    record('H2 层级筛选 200', r2.status === 200 && r2.json?.entries?.every((x) => x.layer === 'harness'));
    const r3 = await api('POST', '/api/logs', { body: { layer: 'evil', level: 'error', message: 'x' } });
    record('H3 非法上报层拒绝 400', r3.status === 400, r3.json?.error);
    const r4 = await api('POST', '/api/logs', { body: { layer: 'frontend', level: 'error', message: 'API测试远端上报', context: { a: 1 } } });
    record('H4 frontend 层远端上报 201', r4.status === 201 && r4.json?.ok === true, `status=${r4.status}`);
    const r5 = await api('POST', '/api/logs', { body: { layer: 'plugin', level: 'info', message: 'plugin 层上报' } });
    record('H5 plugin 层远端上报 201', r5.status === 201, `status=${r5.status}`);
    const r6 = await api('GET', '/api/logs?q=' + encodeURIComponent('API测试远端上报'));
    record('H6 关键词检索日志 200', r6.status === 200 && r6.json?.entries?.length >= 1, `hits=${r6.json?.entries?.length}`);
  }

  console.log('\n== I. api_configs 掩码 ==');
  {
    const r1 = await api('POST', '/api/api_configs', { body: { name: '测试配置', base_url: 'https://api.deepseek.com', api_key: 'sk-test-1234567890abcdef', model: 'deepseek-flash' } });
    const cfg = r1.json;
    record('I1 新建配置 201', r1.status === 201 && cfg?.id);
    created.others.push(['api_configs', cfg?.id]);
    record('I2 创建响应即掩码(回显无明文 Key)', r1.status === 201 && !JSON.stringify(r1.json).includes('1234567890abcdef') && r1.json?.api_key?.includes('…'), r1.json?.api_key);
    const r2 = await api('GET', '/api/api_configs');
    record('I3 列表接口掩码 Key', r2.status === 200 && r2.json?.every((c) => !('1234567890abcdef') || true) && !JSON.stringify(r2.json).includes('1234567890abcdef'), `configs=${r2.json?.length}`);
  }

  console.log('\n== I2. harness 思考强度校验 ==');
  {
    // 只测非法值：合法值会真的入队一个 dsh 子进程任务（要拉起 node + harness 子进程），
    // 代价高且非本套件职责，故不在此覆盖。
    const r1 = await api('POST', '/api/harness/run', { body: { prompt: '校验用', reasoning_effort: 'ultra' } });
    record('I2a 非法思考强度被拒 400', r1.status === 400 && /思考强度/.test(r1.json?.error || ''), `status=${r1.status} err=${r1.json?.error}`);
  }

  console.log('\n== I3. 🐞 运行追踪（调试录制） ==');
  {
    // 录制开关 + 归组 + 不记正文 + 排除自身接口 + 会话文件回看
    const s0 = await api('GET', '/api/debug/state');
    record('I3a 初始状态可读且未录制', s0.status === 200 && s0.json?.state?.recording === false, `status=${s0.status}`);
    record('I3b 状态暴露上限配置', s0.json?.config?.max_nodes_per_op > 0 && s0.json?.state?.limits?.max_nodes_per_op > 0);

    const start = await api('POST', '/api/debug/start', { body: { from: 'test-suite' } });
    record('I3c 开启录制', start.status === 200 && start.json?.recording === true, `session=${start.json?.session_id}`);
    const again = await api('POST', '/api/debug/start', { body: {} });
    record('I3d 重复开启幂等', again.status === 200 && again.json?.already === true);

    const OP = 'suite-trace-op';
    const w = await api('POST', '/api/works', { body: { title: '追踪套件作品' }, headers: { 'X-Trace-Op': OP, 'X-Trace-Title': encodeURIComponent('新建作品') } });
    const wId = w.json?.id;
    created.works.push(wId);
    const c = await api('POST', '/api/chapters', { body: { work_id: wId, title: '追踪章', content: '<p>正文内容</p>' }, headers: { 'X-Trace-Op': OP } });
    const cId = c.json?.id;
    created.others.push(['chapters', cId]);

    await new Promise((r) => setTimeout(r, 300));
    const ops = await api('GET', '/api/debug/ops');
    const opList = ops.json?.ops || [];
    const mine = opList.filter((o) => o.opId === OP);
    record('I3e 同一 opId 的多个请求归并为一条操作', mine.length === 1, `matched=${mine.length} total=${opList.length}`);
    record('I3f 操作标题取自前端头', mine[0]?.title === '新建作品', `title=${mine[0]?.title}`);
    record('I3g 操作记录到 HTTP 状态码与节点数', (mine[0]?.http_status === 200 || mine[0]?.http_status === 201) && mine[0]?.nodes > 0, `status=${mine[0]?.http_status} nodes=${mine[0]?.nodes}`);

    const detail = await api('GET', `/api/debug/op?op_id=${OP}`);
    const nodes = detail.json?.nodes || [];
    const kinds = [...new Set(nodes.map((n) => n.kind))];
    record('I3h 明细含 SQL 节点（表名/行数/形状）', kinds.includes('db') && nodes.some((n) => n.db?.table === 'chapters' && n.db?.rows !== null), `kinds=${kinds.join(',')}`);
    const withCode = nodes.filter((n) => n.code?.file && n.code?.line);
    record('I3i 节点带 文件:行号（非 node 内部帧）', withCode.length > 0 && withCode.every((n) => !/node:internal/.test(n.code.file)), withCode[0] ? `${withCode[0].code.file}:${withCode[0].code.line}` : '');

    const secret = 'SUITE_SECRET_MUST_NOT_BE_TRACED';
    const c2 = await api('POST', '/api/chapters', { body: { work_id: wId, title: '密钥章', content: `<p>${secret}</p>` }, headers: { 'X-Trace-Op': 'suite-trace-op-2' } });
    created.others.push(['chapters', c2.json?.id]);
    const d2 = await api('GET', '/api/debug/op?op_id=suite-trace-op-2');
    const dump2 = JSON.stringify(d2.json);
    record('I3j 追踪数据不含正文（不记正文约束）', !dump2.includes(secret));
    record('I3k 但记录正文长度形状', /"len":\d+/.test(dump2) || /"chars":\d+/.test(dump2));

    const n1 = ((await api('GET', '/api/debug/ops')).json?.ops || []).length;
    await api('POST', '/api/logs', { body: { layer: 'frontend', level: 'error', message: '追踪排除验证' } });
    await api('GET', '/api/stats');
    const n2 = ((await api('GET', '/api/debug/ops')).json?.ops || []).length;
    record('I3l 自身/轮询接口不参与追踪', n1 === n2, `before=${n1} after=${n2}`);

    const idsBefore = ((await api('GET', '/api/debug/ops')).json?.ops || []).map((o) => o.opId);
    const stop = await api('POST', '/api/debug/stop');
    record('I3m 停止录制并返回会话摘要', stop.status === 200 && stop.json?.recording === false && (stop.json?.summary?.ops || 0) >= 2, `ops=${stop.json?.summary?.ops} nodes=${stop.json?.summary?.nodes}`);

    const w2 = await api('POST', '/api/works', { body: { title: '停止后作品' }, headers: { 'X-Trace-Op': 'suite-after-stop' } });
    created.works.push(w2.json?.id);
    const idsAfter = ((await api('GET', '/api/debug/ops')).json?.ops || []).map((o) => o.opId);
    record('I3n 停止后不再新增操作', idsAfter.filter((id) => !idsBefore.includes(id)).length === 0 && !idsAfter.includes('suite-after-stop'));

    await new Promise((r) => setTimeout(r, 400));
    const sessions = await api('GET', '/api/debug/sessions');
    const files = sessions.json?.sessions || [];
    record('I3o 录制明细落 JSONL', files.length >= 1 && files.some((f) => /^trace-.*\.jsonl$/.test(f.file)), `files=${files.length}`);
    const target = files[0]?.file;
    const sess = target ? await api('GET', `/api/debug/session?file=${encodeURIComponent(target)}`) : { json: null };
    const sessNodes = (sess.json?.ops || []).reduce((s, o) => s + (o.nodes?.length || 0), 0);
    record('I3p 会话文件可回看（含操作与节点明细）', (sess.json?.ops?.length || 0) >= 1 && sessNodes > 0, `ops=${sess.json?.ops?.length} nodes=${sessNodes}`);
    record('I3q 会话文件同样不含正文', !JSON.stringify(sess.json).includes(secret));
    const bad = await api('GET', '/api/debug/session?file=../../package.json');
    record('I3r 会话文件名做了路径穿越防护', bad.status === 404 || (bad.json && !JSON.stringify(bad.json).includes('novel-studio')), `status=${bad.status}`);

    const push = await api('POST', '/api/debug/op', {
      body: {
        op_id: 'suite-client-op', title: '保存本章', status: 'done',
        render: { view: 'writing', chapter_id: cId }, toast: ['已保存'],
        nodes: [
          { kind: 'fn', name: 'saveChapter()', file: 'public/app.js', line: 1542, func: 'saveChapter', cost_ms: 12, status: 'ok', result: { ok: true, id: cId } },
          { kind: 'ui', name: '视图重绘', file: 'public/app.js', line: 1224, func: 'render', cost_ms: 40, status: 'ok' }
        ]
      }
    });
    record('I3s 停录后前端收尾数据仍能补建并被接受', push.status === 200 && push.json?.attached?.accepted === 2, `accepted=${push.json?.attached?.accepted}`);
    const cli = await api('GET', '/api/debug/op?op_id=suite-client-op');
    const cliNodes = cli.json?.nodes || [];
    record('I3t 前端节点带代码位置并合流到同一操作', cliNodes.length === 2 && cliNodes.every((n) => n.side === 'frontend') && cliNodes[0]?.code?.line === 1542, `n=${cliNodes.length}`);
    const repeat = await api('POST', '/api/debug/op', {
      body: { op_id: 'suite-client-op', title: '保存本章', status: 'done', nodes: [{ kind: 'fn', name: '重复上报', file: 'public/app.js', line: 1, cost_ms: 1, status: 'ok' }] }
    });
    record('I3t2 重复上报不重复收尾（幂等）', repeat.json?.deduped === true, `deduped=${repeat.json?.deduped}`);
    const noOp = await api('POST', '/api/debug/op', { body: { title: '缺少 op_id' } });
    record('I3u 缺少 op_id 被拒 400', noOp.status === 400);
    const unknown = await api('GET', '/api/debug/nope');
    record('I3v 未知调试接口 404', unknown.status === 404);

    // 业务主干函数级埋点：上下文装配与关键词检索必须各自成节点（否则「哪一步慢」无法归因）。
    await api('POST', '/api/debug/start', { body: { from: 'trunk-test' } });
    const tw = await api('POST', '/api/works', { body: { title: '主干埋点验证' } });
    const twId = tw.json?.id;
    created.works.push(twId);
    const tc = await api('POST', '/api/chapters', { body: { work_id: twId, title: '主干章', content: '<p>主干正文</p>' } });
    const tcId = tc.json?.id;
    created.others.push(['chapters', tcId]);
    await api('GET', `/api/novel/context?work_id=${twId}&chapter_id=${tcId}&mode=full`, { headers: { 'X-Trace-Op': 'suite-trunk-op' } });
    await api('GET', `/api/search?q=主干正文&work_id=${twId}`, { headers: { 'X-Trace-Op': 'suite-trunk-op' } });
    await new Promise((r) => setTimeout(r, 400));
    const trunk = await api('GET', '/api/debug/op?op_id=suite-trunk-op');
    const trunkNames = [...new Set((trunk.json?.nodes || []).map((n) => n.name))];
    record('I3w 上下文装配成为独立函数级节点', trunkNames.some((n) => /buildNovelContext/.test(n)), `nodes=${trunkNames.length}`);
    record('I3x 关键词检索成为独立函数级节点', trunkNames.some((n) => /^search/.test(n)));
    // 分层追踪的下半截：高频动作只累计次数与总耗时（不逐条展开），必须真的被聚合出来。
    const opsWithTools = await api('GET', '/api/debug/ops');
    const tools = opsWithTools.json?.tools || [];
    record('I3y 高频函数累计表非空（bumpTool 已接线）', tools.length > 0, `kinds=${tools.length} ${tools[0] ? tools[0].name + ' ×' + tools[0].count : ''}`);
    record('I3z 累计表带次数与合计耗时', tools.some((t) => t.count > 0 && Number.isFinite(t.cost_ms)), JSON.stringify(tools[0] || {}));

    // 第三轮回归：可信度标记必须随摘要下发。
    // auto_closed：操作由追踪器空闲收尾（不是业务显式结束），耗时不可当业务耗时用。
    // cost_untrusted：操作内存在跨时钟域算出的垃圾耗时（|cost| > 1 天）。
    // 没有这两个字段，界面上「546469ms 的 30ms 检索」和「-1.787e12ms 的 AI 调用」都无法被识别。
    const opsMarks = await api('GET', '/api/debug/ops');
    const firstOp = (opsMarks.json?.ops || [])[0];
    record('I3af 摘要带 auto_closed 可信度标记', !!firstOp && Object.prototype.hasOwnProperty.call(firstOp, 'auto_closed'), firstOp ? `auto_closed=${firstOp.auto_closed}` : 'no op');
    record('I3ag 摘要带 cost_untrusted 可信度标记', !!firstOp && Object.prototype.hasOwnProperty.call(firstOp, 'cost_untrusted'), firstOp ? `cost_untrusted=${firstOp.cost_untrusted}` : 'no op');

    await api('POST', '/api/debug/stop');

    // 迟到收尾的封卷保护：停录后补发的前端节点必须进内存（界面可见），
    // 但绝不写进已封卷的 JSONL 文件（session-end 之后出现 node/op-end 行 = 文件结构被污染）。
    const startedLate = await api('POST', '/api/debug/start', { body: { from: 'late-test' } });
    // ⚠️ 必须锁死「本次会话」的文件名：同一秒内可能起多个会话（上次停录 + 本次开录），
    // 靠 mtime 取最新文件会读到刚开的新会话，把它的 session-start/node 行误判成
    // 「封卷后写入」。（这正是本断言先前误报 after=7 的原因。）
    const lateSessionFile = `trace-${startedLate.json?.session_id}.jsonl`;
    const lw = await api('POST', '/api/works', { body: { title: '迟到写入验证' }, headers: { 'X-Trace-Op': 'suite-late-op' } });
    if (lw.json?.id) created.works.push(lw.json.id);
    await new Promise((r) => setTimeout(r, 300));
    await api('POST', '/api/debug/stop');
    const late = await api('POST', '/api/debug/op', {
      body: {
        op_id: 'suite-late-op', title: '新建作品', status: 'done', render: { view: 'works' },
        nodes: [{ kind: 'ui', name: '迟到的渲染节点', file: 'public/app.js', line: 999, func: 'lateNode', cost_ms: 5, status: 'ok' }]
      }
    });
    record('I3aa 停录后迟到收尾被接受', late.status === 200 && late.json?.attached?.accepted === 1, `status=${late.status}`);
    await new Promise((r) => setTimeout(r, 400));
    const liveLate = await api('GET', '/api/debug/op?op_id=suite-late-op');
    record('I3ab 迟到节点进内存（界面可看）', (liveLate.json?.nodes || []).some((n) => n.side === 'frontend' && /迟到/.test(n.name)), `nodes=${liveLate.json?.nodes?.length}`);
    try {
      // 测试实例按约定使用 .test-data-trace 数据目录（与文档/README 中的隔离测试说明一致），
      // 若环境变量显式给了其它目录则以它为准（供自定义环境使用）。
      const dataDir = process.env.NOVELSTUDIO_DATA_DIR
        ? path.resolve(process.env.NOVELSTUDIO_DATA_DIR)
        : path.resolve(process.cwd(), '.test-data-trace');
      const debugDir = path.join(dataDir, 'debug');
      // 直接读「本次会话」的文件，不再按 mtime 猜（同秒多会话时 mtime 判据不可靠）。
      const lines = fs.readFileSync(path.join(debugDir, lateSessionFile), 'utf8').split('\n').filter(Boolean);
      const endIdx = lines.findIndex((l) => l.includes('"session-end"'));
      const after = endIdx >= 0 ? lines.slice(endIdx + 1) : [];
      record('I3ac JSONL 已封卷（含 session-end）', endIdx >= 0, `file=${lateSessionFile}`);
      record('I3ad 封卷后无 node 行', !after.some((l) => l.includes('"type":"node"')), `after=${after.length}`);
      record('I3ae 封卷后无 op-end 行', !after.some((l) => l.includes('"op-end"')));
    } catch (e) {
      record('I3ac JSONL 封卷检查', false, e.message);
      record('I3ad 封卷后无 node 行', false);
      record('I3ae 封卷后无 op-end 行', false);
    }
  }

  console.log('\n== I4. 🐞 直连通道 Token 采集（本地假 AI 服务） ==');
  {
    // 用本地假 AI 服务返回带 usage 的响应，验证 Token 采集链路真的生效（无需真实 API Key）。
    const fakePort = 3999;
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let model = 'deepseek-flash';
        try { model = JSON.parse(body).model || model; } catch (_) { /* 忽略 */ }
        const payload = JSON.stringify({
          id: 'chatcmpl-fake', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: '测'.repeat(300) }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801,
            prompt_cache_hit_tokens: 800, completion_tokens_details: { reasoning_tokens: 120 }
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      });
    });
    await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

    try {
      const cfg = await api('POST', '/api/api_configs', { body: { name: '假AI（Token采集验证）', base_url: `http://127.0.0.1:${fakePort}`, api_key: 'sk-fake-for-test', model: 'deepseek-flash' } });
      const cfgId = cfg.json?.id;
      created.others.push(['api_configs', cfgId]);
      record('I4a 建立指向假服务的配置', (cfg.status === 200 || cfg.status === 201) && cfgId > 0, `status=${cfg.status}`);

      await api('POST', '/api/debug/start', { body: { from: 'token-test' } });
      const call = await api('POST', '/api/ai/test', { body: { config_id: cfgId, model: 'deepseek-flash' }, headers: { 'X-Trace-Op': 'suite-token-op', 'X-Trace-Title': encodeURIComponent('测试模型连接') } });
      record('I4b 假 AI 调用成功', call.status === 200, `status=${call.status}`);

      await new Promise((r) => setTimeout(r, 300));
      const d = await api('GET', '/api/debug/op?op_id=suite-token-op');
      const ai = (d.json?.nodes || []).filter((n) => n.kind === 'ai');
      record('I4c 捕获 AI 节点', ai.length >= 1, `aiNodes=${ai.length}`);
      const u = ai[0]?.usage;
      record('I4d 输入/输出 Token 被采集', u?.prompt_tokens === 1234 && u?.completion_tokens === 567, JSON.stringify(u));
      record('I4e 缓存命中与思考 Token 被采集', u?.prompt_cache_hit_tokens === 800 && u?.reasoning_tokens === 120);
      record('I4f 记录模型与端点', ai[0]?.model === 'deepseek-flash' && String(ai[0]?.endpoint).includes(`:${fakePort}`), `model=${ai[0]?.model}`);
      const dump = JSON.stringify(d.json);
      const opRow = ((await api('GET', '/api/debug/ops')).json?.ops || []).find((o) => o.opId === 'suite-token-op');
      record('I4g 操作级 Token 汇总', opRow?.prompt_tokens === 1234 && opRow?.completion_tokens === 567 && opRow?.ai_calls >= 1, `↑${opRow?.prompt_tokens} ↓${opRow?.completion_tokens}`);
      record('I4h AI 返回正文被折叠为长度而非原文', !dump.includes('测'.repeat(200)) && dump.includes('"omitted":true'));
      await api('POST', '/api/debug/stop');
    } finally {
      fake.close();
    }
  }

  console.log('\n== K. 长任务结果不丢失（生成稿草稿 / 审稿报告落库） ==');
  {
    // 背景（2026-09-14 真实事故）：AI 成文结果只活在结果弹窗的 state 里，用户点
    // 「先审稿再应用」关掉弹窗，这版稿子就静默消失；审稿报告因模型返回的 JSON 多一个
    // 引号解析失败，几分钟的等待整份作废。下面把两条兜底路径都钉住。
    const w = await api('POST', '/api/works', { body: { title: '长任务产物兜底验证' } });
    const wid = w.json?.id;
    if (wid) created.works.push(wid);
    const ch = await api('POST', '/api/chapters', { body: { work_id: wid, title: '草稿章' } });
    const cid = ch.json?.id;
    record('K1 建立验证用作品与章节', wid > 0 && cid > 0, `work=${wid} chapter=${cid}`);

    // 1) 生成稿草稿：弹窗出现时即落库，关闭弹窗后仍可取回
    const draftBody = '<p>这是 AI 生成但用户尚未应用的一版正文。</p>';
    const dpost = await api('POST', '/api/novel/draft', { body: { chapter_id: cid, content: draftBody } });
    record('K2 生成稿草稿落库', dpost.status === 201 && dpost.json?.draft_id > 0, `status=${dpost.status} chars=${dpost.json?.chars}`);
    const dget = await api('GET', `/api/novel/draft?chapter_id=${cid}`);
    record('K3 关闭弹窗后草稿仍可取回', dget.json?.draft?.content === draftBody, `got=${String(dget.json?.draft?.content || '').slice(0, 20)}`);
    // GET /chapter_versions 直接返回数组（不是 {versions}）
    const vres = await api('GET', `/api/chapter_versions?chapter_id=${cid}`);
    const vlist = Array.isArray(vres.json) ? vres.json : (vres.json?.versions || []);
    record('K4 草稿不计入手动历史版本', vlist.length === 0, `versions=${vlist.length}`);
    const dempty = await api('POST', '/api/novel/draft', { body: { chapter_id: cid, content: '   ' } });
    record('K5 空草稿被拒绝', dempty.status === 400, `status=${dempty.status}`);

    // 2) 审稿报告：能解析则存结构化；不能解析也必须存原文（状态 raw）
    const report = { summary: '总评：结构完整。', issues: [{ text: '问题一' }, { text: '问题二' }], strengths: [{ text: '优点一' }] };
    const rput = await api('PUT', '/api/novel/review', { body: { chapter_id: cid, report, status: 'parsed' } });
    record('K6 结构化审稿报告落库', rput.status === 201 && rput.json?.review_id > 0, `status=${rput.status}`);
    const rget = await api('GET', `/api/novel/review?chapter_id=${cid}`);
    record('K7 审稿报告可回看且标记为已解析', rget.json?.review?.parsed === true && rget.json?.review?.issue_count === 2 && rget.json?.review?.strength_count === 1, `parsed=${rget.json?.review?.parsed} issues=${rget.json?.review?.issue_count}`);

    // 解析失败路径：只给原文，服务端也必须收下（旧行为是 400 拒绝，于是什么都没留下）
    const rawText = '{"summary":"畸形报告","issues":[{"text":"带多余引号的问题。","},{"text":"第二条"}]}';
    const rraw = await api('PUT', '/api/novel/review', { body: { chapter_id: cid, report: {}, raw_text: rawText, status: 'raw' } });
    record('K8 无法解析的审稿报告存原文而非拒绝', rraw.status === 201 && rraw.json?.status === 'raw', `status=${rraw.status} state=${rraw.json?.status}`);
    const rrawGet = await api('GET', `/api/novel/review?chapter_id=${cid}`);
    record('K9 原文可回看且标记为未解析', rrawGet.json?.review?.parsed === false && String(rrawGet.json?.review?.raw_text || '').includes('畸形报告'), `parsed=${rrawGet.json?.review?.parsed} rawLen=${String(rrawGet.json?.review?.raw_text || '').length}`);
    record('K10 完全空的审稿仍被拒绝', (await api('PUT', '/api/novel/review', { body: { chapter_id: cid, report: {} } })).status === 400);
  }

  console.log('\n== L. 长任务：后台继续 / 刷新后续接 ==');
  {
    // 背景：一次成文/审稿要跑几分钟，job_id 只活在页面内存里 —— 刷新页面就再也拿不回结果。
    // 现在任务状态与产出落库，这里把「列得出 / 取得到 / 能回填」三条钉住。
    const w = await api('POST', '/api/works', { body: { title: '长任务续接验证' } });
    const wid = w.json?.id;
    if (wid) created.works.push(wid);
    const ch = await api('POST', '/api/chapters', { body: { work_id: wid, title: '续接章' } });
    const cid = ch.json?.id;
    record('L1 建立验证用作品与章节', wid > 0 && cid > 0, `work=${wid} chapter=${cid}`);

    const list = await api('GET', `/api/harness/recoverable?work_id=${wid}`);
    record('L2 可续接任务列表可查询', list.status === 200 && Array.isArray(list.json?.jobs), `status=${list.status}`);

    const missing = await api('GET', '/api/harness/recovered?id=不存在的任务');
    record('L3 未知任务返回 404（而不是假装成功）', missing.status === 404, `status=${missing.status}`);

    // 审稿产出回填：把「跑完但页面已关」的产出交给服务端落库
    const rawReview = '{"summary":"回填审稿总评","issues":[{"text":"回填问题一"},{"text":"回填问题二"}],"strengths":[{"text":"回填优点"}]}';
    const fin = await api('POST', '/api/novel/finalize', { body: { kind: 'review', chapter_id: cid, output: rawReview } });
    record('L4 审稿产出可回填落库', fin.status === 201 && fin.json?.issue_count === 2, `status=${fin.status} issues=${fin.json?.issue_count}`);
    const back = await api('GET', `/api/novel/review?chapter_id=${cid}`);
    record('L5 回填的审稿可回看', back.json?.review?.parsed === true && back.json?.review?.issue_count === 2, `parsed=${back.json?.review?.parsed}`);

    // 畸形产出回填：解析失败也必须留原文
    const finRaw = await api('POST', '/api/novel/finalize', { body: { kind: 'review', chapter_id: cid, output: '完全不是 JSON 的审稿原文' } });
    record('L6 畸形产出回填存原文而非报错', finRaw.status === 201 && finRaw.json?.parsed === false, `status=${finRaw.status} parsed=${finRaw.json?.parsed}`);

    // 成文产出回填：落成草稿，绝不自动覆盖正文
    const prose = '<p>回填的成文正文</p>';
    const finProse = await api('POST', '/api/novel/finalize', { body: { kind: 'prose', chapter_id: cid, output: prose } });
    record('L7 成文产出回填落成草稿', finProse.status === 201 && finProse.json?.draft_id > 0, `status=${finProse.status}`);
    const draft = await api('GET', `/api/novel/draft?chapter_id=${cid}`);
    record('L8 回填的成文可取回且未覆盖正文', draft.json?.draft?.content === prose, `got=${String(draft.json?.draft?.content || '').slice(0, 16)}`);
    const chapterNow = await api('GET', `/api/chapters/${cid}`);
    record('L9 回填不自动改写章节正文', !String(chapterNow.json?.content || '').includes('回填的成文正文'), `content=${String(chapterNow.json?.content || '').slice(0, 20)}`);

    record('L10 回填缺少 kind 被拒绝', (await api('POST', '/api/novel/finalize', { body: { chapter_id: cid, output: 'x' } })).status === 400);
    record('L11 回填空产出被拒绝', (await api('POST', '/api/novel/finalize', { body: { kind: 'review', chapter_id: cid, output: '  ' } })).status === 400);

    // 重审修复的回归：resumable 只对排队/运行中为真；mark_applied 让任务从恢复条消失。
    const probeRun = await api('POST', '/api/harness/run', { body: { prompt: '回归任务', kind: 'prose', stage: '回归任务', timeout: 600000 } });
    const probeId = probeRun.json?.job_id;
    record('L12 回归任务已入队', probeRun.status === 202 && !!probeId, `status=${probeRun.status}`);
    // ⚠️ L13 曾经隐含假设"作业会在 1.2 秒内失败"——那个假设只在**沙箱拦下子进程**（spawn EPERM）时成立。
    // 2026-09-18 换成 danger-full-access 后子进程真的起来了，作业合法地停在 running，断言随即假失败
    // （本项目记过同类教训：等错条件 = 假失败）。改成断言**不变量本身**：
    //   可续接 <=> 作业仍处于排队/运行中；一旦终态，就不能再显示"可续接"。
    // 两种情形都记录实际分支，避免"条件不成立就静默通过"。
    let probeJob = null;
    let observed = '';
    for (let i = 0; i < 6 && !observed; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const list = await api('GET', '/api/harness/recoverable');
      probeJob = (list.json?.jobs || []).find((j) => j.id === probeId) || probeJob;
      if (probeJob && probeJob.status !== 'running' && probeJob.status !== 'queued') observed = 'terminal';
      else if (i === 5) observed = 'still-running';
    }
    const resumableOk = observed === 'terminal'
      ? probeJob?.resumable === false
      : probeJob?.resumable === true;
    record('L13 「可续接」只在排队/运行中为真（终态必须为假）',
      !!probeJob && resumableOk,
      `分支=${observed} ${JSON.stringify(probeJob && { status: probeJob.status, resumable: probeJob.resumable })}`);
    const mark = await api('POST', '/api/harness/mark_applied', { body: { job_id: probeId } });
    record('L14 mark_applied 接口可用', mark.status === 200, `status=${mark.status}`);
    const listAfter = await api('GET', '/api/harness/recoverable');
    record('L15 已应用的任务从恢复条消失', !(listAfter.json?.jobs || []).some((j) => j.id === probeId), `remaining=${(listAfter.json?.jobs || []).length}`);
    record('L16 mark_applied 缺少 job_id 被拒绝', (await api('POST', '/api/harness/mark_applied', { body: {} })).status === 400);
  }

  console.log('\n== M. 工具配置与环境自检（AI 设置页的数据源） ==');
  {
    // ⚠️ 本段的安全约束：这套件可能被人对着**非隔离实例**跑（甚至 3737 主实例）。
    //   - 只写「能被读回来、因而能被还原」的字段（ov_endpoint / dsh_repo），测完整项还原；
    //   - **一律不写 api_key**（GET 只回掩码，写进去就还不回来了）；
    //   - 「清除 Key」只在当前确实没有已保存 Key 时才跑（无 Key 可毁）。
    const before = await api('GET', '/api/novel/openviking');
    const envBefore = await api('GET', '/api/env/tools');
    const origEndpoint = before.json?.workshop?.endpoint ?? '';
    const origDshRepo = envBefore.json?.dsh?.override ?? '';
    const hadSavedKey = before.json?.workshop?.has_api_key === true;

    // M1–M3 契约完整性：**先断言字段存在，再断言取值**。
    // 字段缺失时，任何"不该等于 X"的反向断言都会假通过（记在 2026-09-16 的 D4 复盘里）。
    const ov = before.json || {};
    const ovFields = ['endpoint', 'endpoint_source', 'endpoint_source_label', 'api_key_source', 'api_key_source_label', 'has_api_key', 'workshop', 'semantic', 'healthy', 'pending'];
    record('M1 GET /novel/openviking 字段齐全', before.status === 200 && ovFields.every((k) => k in ov), `status=${before.status} missing=${ovFields.filter((k) => !(k in ov)).join(',')}`);
    record('M2 来源标签来自解析链（有值且有中文标签）', typeof ov.endpoint_source === 'string' && ov.endpoint_source.length > 0 && typeof ov.endpoint_source_label === 'string' && ov.endpoint_source_label.length > 0, `${ov.endpoint_source} / ${ov.endpoint_source_label}`);

    const env = envBefore.json || {};
    record('M3 GET /env/tools 返回四段检测结果', envBefore.status === 200 && Boolean(env.node && env.server && env.dsh && env.openviking), `status=${envBefore.status}`);
    record('M4 dsh 检测如实列出候选位置与命中情况', Array.isArray(env.dsh?.checked) && env.dsh.checked.length >= 1 && env.dsh.checked.every((c) => typeof c.ok === 'boolean' && !!c.dir) && typeof env.dsh.found === 'boolean', `checked=${env.dsh?.checked?.length} found=${env.dsh?.found}`);
    record('M5 插件安装判定是布尔（不是 undefined 冒充）', typeof env.dsh?.plugin?.installed === 'boolean' && typeof env.dsh?.plugin?.exists === 'boolean' && Array.isArray(env.dsh?.plugin?.installs), JSON.stringify({ installed: env.dsh?.plugin?.installed, installs: env.dsh?.plugin?.installs?.length }));
    record('M6 环境自检里没有明文密钥', !/"api_key"\s*:\s*"[^"]/.test(envBefore.text) && !/"root_api_key"\s*:\s*"[^"]/.test(envBefore.text), envBefore.text.slice(0, 80));
    record('M7 OpenViking 状态与状态卡同源（两个接口给出同一个地址）', env.openviking?.endpoint === ov.endpoint && env.openviking?.endpoint_source === ov.endpoint_source, `env=${env.openviking?.endpoint} card=${ov.endpoint}`);

    // M8 — 手填 dsh 路径的三条判据：空=清空、假仓库=拒绝、dsh 形状=接受
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-fake-repo-'));
    fs.writeFileSync(path.join(fakeRepo, 'package.json'), JSON.stringify({ name: 'not-dsh', version: '1.0.0' }));
    const badRepo = await api('PUT', '/api/env/dsh_repo', { body: { dir: fakeRepo } });
    record('M8 只有 package.json、没有 dsh 布局的目录被拒绝', badRepo.status === 400, `status=${badRepo.status} ${String(badRepo.json?.error || '').slice(0, 60)}`);
    record('M9 缺少 dir 字段被拒绝', (await api('PUT', '/api/env/dsh_repo', { body: {} })).status === 400);

    const dshLike = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-dsh-like-'));
    fs.mkdirSync(path.join(dshLike, 'apps', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dshLike, 'package.json'), JSON.stringify({ name: 'deepseek-harness-lookalike', scripts: {} }));
    const okRepo = await api('PUT', '/api/env/dsh_repo', { body: { dir: dshLike } });
    record('M10 dsh 形状的目录被接受并立即生效', okRepo.status === 200 && okRepo.json?.dsh?.source === 'workshop' && okRepo.json?.dsh?.dir === dshLike, `status=${okRepo.status} source=${okRepo.json?.dsh?.source}`);
    const envAfterRepo = await api('GET', '/api/env/tools');
    record('M11 保存的 dsh 路径被后续检测读到（不是只写内存）', envAfterRepo.json?.dsh?.override === dshLike && envAfterRepo.json?.dsh?.source === 'workshop', `override=${envAfterRepo.json?.dsh?.override}`);
    // 还原：作者原本填过就写回原值，没填过就清空（两条都是可读回来、可验证的）
    const restoreRepo = await api('PUT', '/api/env/dsh_repo', { body: { dir: origDshRepo } });
    const envRestored = await api('GET', '/api/env/tools');
    record('M12 dsh 路径已还原到测试前状态', restoreRepo.status === 200 && envRestored.json?.dsh?.override === origDshRepo, `now=${envRestored.json?.dsh?.override}`);

    // M13–M16 OpenViking 设置写入：只动 endpoint（可读回、可还原），不碰 Key
    const saved = await api('PUT', '/api/novel/openviking', { body: { endpoint: 'http://127.0.0.1:1933' } });
    record('M13 保存地址后立即生效（来源变为工坊内设置）', saved.status === 200 && saved.json?.endpoint_source === 'workshop' && saved.json?.endpoint === 'http://127.0.0.1:1933', `status=${saved.status} source=${saved.json?.endpoint_source}`);
    record('M14 保存响应如实回报 applied 字段', Array.isArray(saved.json?.applied) && saved.json.applied.includes('endpoint'), JSON.stringify(saved.json?.applied));
    const reread = await api('GET', '/api/novel/openviking');
    record('M15 重新读取仍是工坊内设置（真的落了库）', reread.json?.workshop?.endpoint === 'http://127.0.0.1:1933' && reread.json?.endpoint_source === 'workshop', `workshop=${reread.json?.workshop?.endpoint}`);

    // M16 空 Key = 不改动（契约）：表单里留空不能被当成"清除"
    const blankKey = await api('PUT', '/api/novel/openviking', { body: { api_key: '   ' } });
    record('M16 空白 api_key 不被当成清除', blankKey.status === 200 && !(blankKey.json?.applied || []).includes('api_key') && blankKey.json?.workshop?.has_api_key === hadSavedKey, `applied=${JSON.stringify(blankKey.json?.applied)}`);

    // M17 显式清除：仅在当前没有已保存 Key 时执行，避免毁掉作者的凭证
    if (!hadSavedKey) {
      const cleared = await api('PUT', '/api/novel/openviking', { body: { clear_api_key: true } });
      record('M17 显式 clear_api_key 生效且被回报', cleared.status === 200 && (cleared.json?.applied || []).includes('clear_api_key') && cleared.json?.workshop?.has_api_key === false, `applied=${JSON.stringify(cleared.json?.applied)}`);
    } else {
      record('M17 跳过：该实例已保存 OpenViking Key（清除不可还原，故不测）', true, 'had_saved_key=true');
    }

    // 还原 endpoint 到测试前状态
    const restoreEp = await api('PUT', '/api/novel/openviking', { body: { endpoint: origEndpoint } });
    const finalState = await api('GET', '/api/novel/openviking');
    record('M18 OpenViking 地址已还原到测试前状态', restoreEp.status === 200 && finalState.json?.workshop?.endpoint === origEndpoint, `now="${finalState.json?.workshop?.endpoint}" was="${origEndpoint}"`);

    // M19–M22 打开目录：参数是枚举键，不是路径
    const badTarget = await api('POST', '/api/env/open_folder', { body: { target: 'C:\\Windows' } });
    record('M19 路径形式的 target 被拒绝（白名单只认枚举键）', badTarget.status === 400, `status=${badTarget.status}`);
    record('M20 空 target 被拒绝', (await api('POST', '/api/env/open_folder', { body: {} })).status === 400);
    const dry = await api('POST', '/api/env/open_folder', { body: { target: 'data', dry_run: true } });
    record('M21 dry_run 回显目录但不真的打开', dry.status === 200 && dry.json?.opened === false && dry.json?.dir === env.server?.data_dir, `dir=${dry.json?.dir}`);
    const dryPlugin = await api('POST', '/api/env/open_folder', { body: { target: 'plugin', dry_run: true } });
    record('M22 插件源码目录存在且可被枚举', dryPlugin.status === 200 && String(dryPlugin.json?.dir || '').includes('novel-writing'), `dir=${dryPlugin.json?.dir}`);

    // M23–M25 地址归一化与校验：小白最可能填「127.0.0.1:1933」（没有协议头）
    const noScheme = await api('PUT', '/api/novel/openviking', { body: { endpoint: '127.0.0.1:1933' } });
    record('M23 缺协议的地址被自动补成 http://', noScheme.status === 200 && noScheme.json?.endpoint === 'http://127.0.0.1:1933', `endpoint=${noScheme.json?.endpoint}`);
    const badEndpoint = await api('PUT', '/api/novel/openviking', { body: { endpoint: 'http://' } });
    record('M24 非法地址被拒绝', badEndpoint.status === 400, `status=${badEndpoint.status} ${String(badEndpoint.json?.error || '').slice(0, 50)}`);
    const afterBad = await api('GET', '/api/novel/openviking');
    record('M25 被拒绝的地址没有污染已保存的值', afterBad.json?.workshop?.endpoint === 'http://127.0.0.1:1933', `now=${afterBad.json?.workshop?.endpoint}`);

    // M26–M30 「写入全局配置」：只在**目标文件位于隔离数据目录内**时才跑。
    // 真实实例上这个端点的目标是作者主目录的 ~/.openviking/ovcli.conf —— 那是不可还原的改动，
    // 套件绝不能在那种环境里碰它（隔离实例通过 OPENVIKING_CLI_CONFIG_FILE 把目标挪进数据目录）。
    const cliPath = String(env.openviking?.config_paths?.cli || '');
    const dataDir = String(env.server?.data_dir || '');
    const isolatedTarget = cliPath && dataDir
      && path.resolve(cliPath).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase());
    if (isolatedTarget) {
      const w1 = await api('POST', '/api/novel/openviking/global_config', { body: {} });
      const text1 = fs.readFileSync(cliPath, 'utf8');
      record('M26 全局配置写入成功且改动如实回报', w1.status === 200 && w1.json?.ok === true && (w1.json?.changed || []).includes('url'), `status=${w1.status} changed=${JSON.stringify(w1.json?.changed)}`);
      record('M27 写入后目标文件真的被更新', (() => { try { return JSON.parse(text1).url === 'http://127.0.0.1:1933'; } catch { return false; } })());
      // 换一个地址再写一次：此时文件**已存在**，必须生成备份（这才是「可还原」的证据）
      await api('PUT', '/api/novel/openviking', { body: { endpoint: 'http://127.0.0.1:1944' } });
      const w2 = await api('POST', '/api/novel/openviking/global_config', { body: {} });
      record('M28 二次写入生成备份且内容等于上一版', Boolean(w2.json?.backup) && fs.existsSync(w2.json.backup) && fs.readFileSync(w2.json.backup, 'utf8') === text1, `backup=${w2.json?.backup}`);
      record('M29 还原说明里带出备份路径', String(w2.json?.restore_hint || '').includes(String(w2.json?.backup || '\u0000')), String(w2.json?.restore_hint || '').slice(0, 80));
    } else {
      record('M26 跳过：全局配置目标不在隔离数据目录内（不可还原，故不测）', true, `cli=${cliPath}`);
      record('M27 同上（跳过）', true);
      record('M28 同上（跳过）', true);
      record('M29 同上（跳过）', true);
    }

    // M30 收尾还原：本段对 ov_endpoint 的所有写入都必须回到测试前的值
    await api('PUT', '/api/novel/openviking', { body: { endpoint: origEndpoint } });
    const endState = await api('GET', '/api/novel/openviking');
    record('M30 OpenViking 地址已还原（本段改过的值不会留在实例上）', endState.json?.workshop?.endpoint === origEndpoint, `now="${endState.json?.workshop?.endpoint}" was="${origEndpoint}"`);

    // M31 策略快照必须把"质量档的补偿参数"下发给前端：两档同模型之后，
    // 前端拿不到 effort_by_tier 就等于质量档退化成快档（2026-09-18 决策，见 ai/policy.mjs）。
    const pol = await api('GET', '/api/ai/policy');
    record('M31 策略快照含档位→强度与长任务超时',
      pol.status === 200
      && pol.json?.models?.fast === 'deepseek-flash'
      && pol.json?.models?.quality === 'deepseek-flash'
      && pol.json?.effort_by_tier?.quality === 'high'
      && pol.json?.effort_by_tier?.fast === ''
      && Number(pol.json?.long_ai_timeout_ms) >= 30 * 60 * 1000,
      `models=${JSON.stringify(pol.json?.models)} effort=${JSON.stringify(pol.json?.effort_by_tier)} timeout=${pol.json?.long_ai_timeout_ms}`);

    try { fs.rmSync(fakeRepo, { recursive: true, force: true }); fs.rmSync(dshLike, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }

  console.log('\n== J. 清理测试数据 ==');
  {
    // delete settings resources first (FK), then works
    for (const [res, id] of [...created.others].reverse()) {
      await api('DELETE', `/api/${res}/${id}`);
    }
    for (const wid of [...created.works].reverse()) {
      const r = await api('DELETE', `/api/works/${wid}`);
      record(`J 删除作品 ${wid}`, r.status === 200 || r.status === 404, `status=${r.status}`);
      const r2 = await api('GET', `/api/works/${wid}`);
      record(`J 作品 ${wid} 已不存在(404)`, r2.status === 404);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== 汇总: ${results.length - failed.length}/${results.length} 通过, ${failed.length} 失败 ====`);
  if (failed.length) console.log('失败项:', failed.map((f) => f.name).join('; '));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('套件异常:', e); process.exit(2); });
