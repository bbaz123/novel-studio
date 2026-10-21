/**
 * tools.test.mjs —— 四个工具的**真实执行**（对本地 HTTP stub，不走模型、零计费）。
 *
 * stub 忠实实现服务端契约的关键分支：blind 读初审要 409、blind 提交后阶段变 compare、
 * final 重复相同摘要幂等、不同摘要冲突。这样可以断言工具**真的**发请求、真的按错误码行事。
 */
import http from 'node:http';
import { createChecks } from '../../../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();

const ARTICLE = '陈默推开门，雨声一下子涌进来。他把伞靠在门边。';
const calls = [];
const state = { phase: 'blind', blind: null, final: null, manifestChars: ARTICLE.length };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const auth = req.headers['x-audit-token'];
  if (auth !== 'tok-1') return send(401, { ok: false, code: 'AUDIT_TOKEN_INVALID', error: 'token 不匹配' });
  const parts = url.pathname.split('/').filter(Boolean);
  calls.push(req.method + ' ' + url.pathname);
  if (url.pathname.endsWith('/input-manifest')) {
    return send(200, { ok: true, audit_id: 'qa_1', kind: 'review', phase: state.phase, contract_version: 'novel-quality-audit.v1', resources: [{ name: 'article', chars: state.manifestChars, sha256: 'sha256:x', pages: 1 }], required_outputs: ['coverage', 'findings', 'verdict'] });
  }
  if (url.pathname.includes('/resources/')) {
    const name = parts[parts.length - 1];
    if (state.phase === 'blind' && name === 'initial_review') return send(409, { ok: false, code: 'AUDIT_PHASE_INVALID', error: 'blind 阶段不允许读取 initial_review' });
    const cursor = Number(url.searchParams.get('cursor') || 0);
    const limit = Number(url.searchParams.get('limit') || 16000);
    const text = name === 'article' ? ARTICLE.slice(cursor, cursor + limit) : 'RES:' + name;
    const end = Math.min(name === 'article' ? ARTICLE.length : text.length, cursor + limit);
    return send(200, { ok: true, name, cursor, limit, next_cursor: end < (name === 'article' ? ARTICLE.length : 1e9) ? end : null, total_chars: name === 'article' ? ARTICLE.length : text.length, chars: text.length, sha256: 'sha256:y', complete: cursor === 0 && end >= (name === 'article' ? ARTICLE.length : 1e9), text });
  }
  if (url.pathname.endsWith('/status')) {
    return send(200, { ok: true, audit_id: 'qa_1', kind: 'review', status: state.final ? 'RESULT_RECEIVED' : state.blind ? 'COMPARE_RUNNING' : 'INPUT_FROZEN', status_label: 'x', phase: state.phase, missing_requirements: [], last_error: null, counts: {}, terminal: false });
  }
  if (url.pathname.endsWith('/submissions') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {}; try { json = JSON.parse(body); } catch { json = {}; }
      if (json.operation === 'blind_draft') {
        state.blind = json.payload; state.phase = 'compare';
        return send(200, { ok: true, audit_id: 'qa_1', status: 'COMPARE_RUNNING', idempotent: false });
      }
      if (json.operation === 'final') {
        if (state.final) {
          if (JSON.stringify(state.final) === JSON.stringify(json.payload)) return send(200, { ok: true, audit_id: 'qa_1', status: 'RESULT_RECEIVED', idempotent: true });
          return send(409, { ok: false, code: 'AUDIT_RESULT_CONFLICT', error: 'final 结果已收到且摘要不同' });
        }
        state.final = json.payload;
        return send(200, { ok: true, audit_id: 'qa_1', status: 'RESULT_RECEIVED', idempotent: false });
      }
      return send(422, { ok: false, code: 'AUDIT_CONTRACT_INVALID', error: 'operation 非法' });
    });
    return;
  }
  return send(404, { ok: false, code: 'AUDIT_NOT_FOUND', error: 'not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function registerAll(envPatch) {
  const saved = {};
  for (const k of Object.keys(envPatch)) { saved[k] = process.env[k]; if (envPatch[k] == null) delete process.env[k]; else process.env[k] = envPatch[k]; }
  return saved;
}
const FULL = {
  NOVELSTUDIO_MODE: 'quality_audit', NOVELSTUDIO_AUDIT_ID: 'qa_1', NOVELSTUDIO_AUDIT_TOKEN: 'tok-1',
  NOVELSTUDIO_AUDIT_KIND: 'review', NOVELSTUDIO_BASE_URL: `http://127.0.0.1:${port}`,
};
const saved = registerAll(FULL);
const mod = await import('../lib/index.js');
const tools = {};
const events = [];
mod.apply({ tools: { register(d) { tools[d.name] = d; } }, on(e, f) { events.push(e); } }, {});
const call = async (name, args = {}) => JSON.parse((await tools[name].execute(args)).text);

check('P1', 'apply 注册四个工具且只注册 turn-stopping 一个事件', Object.keys(tools).length === 4 && events.join(',') === 'agent/turn-stopping');

const opened = await call('novel_quality_open', {});
check('P2', 'open 返回清单但不返回正文', opened.ok === true && opened.kind === 'review' && opened.resources.length === 1 && !JSON.stringify(opened).includes('雨声'));
check('P3', 'open 拒绝打开别的审计（scope mismatch）', (await call('novel_quality_open', { audit_id: 'qa_other' })).code === 'AUDIT_SCOPE_MISMATCH');

const page1 = await call('novel_quality_read', { resource: 'article', cursor: 0, limit: 10 });
check('P4', 'read 分页返回 text/next_cursor/total_chars', page1.ok && page1.chars === 10 && page1.next_cursor === 10 && page1.total_chars === ARTICLE.length);
const blindRead = await call('novel_quality_read', { resource: 'initial_review' });
check('P5', 'blind 阶段读初审：工具如实转述服务端 409（不吞成成功）', blindRead.ok === false && blindRead.code === 'AUDIT_PHASE_INVALID');

const badOp = await call('novel_quality_submit', { operation: 'nope', payload: {} });
check('P6', '非法 operation 在本地就被拒绝（不发请求）', badOp.code === 'AUDIT_CONTRACT_INVALID');

const before = calls.length;
const blindPayload = { scanned_ranges: [[0, ARTICLE.length]], findings: [] };
const blind = await call('novel_quality_submit', { operation: 'blind_draft', payload: blindPayload });
const afterBlind = calls.length;
check('P7', 'blind_draft 真的发了一次 POST，返回进入 compare', blind.ok && blind.status === 'COMPARE_RUNNING' && afterBlind === before + 1);
const allowRead = await call('novel_quality_read', { resource: 'initial_review' });
check('P8', 'blind 之后可以读初审（阶段真的推进了）', allowRead.ok === true);

const finalPayload = { schema_version: 'review-audit.v1', verdict: 'NEED_CONTEXT' };
const fin1 = await call('novel_quality_submit', { operation: 'final', payload: finalPayload });
check('P9', 'final 成功，工具记录 finalSubmitted（turn 兜底据此不再提醒）', fin1.ok && fin1.status === 'RESULT_RECEIVED');
const nBefore = calls.length;
const fin2 = await call('novel_quality_submit', { operation: 'final', payload: finalPayload });
check('P10', '相同摘要重复提交：本地幂等，不再发第二次请求', fin2.ok && fin2.idempotent === true && calls.length === nBefore);
const fin3 = await call('novel_quality_submit', { operation: 'final', payload: { schema_version: 'review-audit.v1', verdict: 'COMPLETE_WITH_EVIDENCE' } });
check('P11', '不同摘要：被服务端拒绝（AUDIT_RESULT_CONFLICT），不覆盖旧结果', fin3.ok === false && fin3.code === 'AUDIT_RESULT_CONFLICT');

const st = await call('novel_quality_status', {});
check('P12', 'status 只读返回状态与本地提交记录', st.ok && st.status === 'RESULT_RECEIVED' && st.local_state.final_submitted === true);

// 普通写作任务：同一套工具返回 NOT_APPLICABLE
registerAll({ NOVELSTUDIO_MODE: 'novel', NOVELSTUDIO_AUDIT_ID: null, NOVELSTUDIO_AUDIT_TOKEN: null, NOVELSTUDIO_AUDIT_KIND: null });
const mod2 = await import('../lib/index.js?fresh=1');
const tools2 = {};
mod2.apply({ tools: { register(d) { tools2[d.name] = d; } }, on() {} }, {});
const na = JSON.parse((await tools2.novel_quality_open.execute({})).text);
check('P13', '普通写作任务：四个工具都返回 NOT_APPLICABLE，不发任何请求', na.code === 'NOT_APPLICABLE' && na.applicable === false);

// 还原环境
for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
server.close();
finish('插件工具');
