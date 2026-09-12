// Professional API test suite for the isolated Novel Studio instance (127.0.0.1:3738).
// Zero-dependency, node >= 22 (node:sqlite not needed here; fetch/net built-ins).
// Covers: static/serving, security (CORS/Origin/path traversal/payload limit/masking),
// CRUD lifecycle + validation + optimistic locking, novel kernel endpoints,
// search, import/export, logs endpoints, api_configs masking.
// Self-cleaning: deletes every resource it creates (except logs which it leaves for UI demo).

const BASE = 'http://127.0.0.1:3738';
import net from 'node:net';
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
  const res = await fetch(BASE + path, opts);
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
    const r1 = await api('POST', '/api/api_configs', { body: { name: '测试配置', base_url: 'https://api.deepseek.com', api_key: 'sk-test-1234567890abcdef', model: 'deepseek-chat' } });
    const cfg = r1.json;
    record('I1 新建配置 201', r1.status === 201 && cfg?.id);
    created.others.push(['api_configs', cfg?.id]);
    record('I2 创建响应即掩码(回显无明文 Key)', r1.status === 201 && !JSON.stringify(r1.json).includes('1234567890abcdef') && r1.json?.api_key?.includes('…'), r1.json?.api_key);
    const r2 = await api('GET', '/api/api_configs');
    record('I3 列表接口掩码 Key', r2.status === 200 && r2.json?.every((c) => !('1234567890abcdef') || true) && !JSON.stringify(r2.json).includes('1234567890abcdef'), `configs=${r2.json?.length}`);
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
