/**
 * tests/nsdsh/http-respond.test.mjs —— R05（F12-A）：HTTP 响应/请求体读取的抽取等价性。
 *
 * 抽取类重构最容易的自欺是"新建了文件，但路由仍执行老逻辑"。
 * 所以本套件不只测新模块的功能，还测**旧定义真的消失了、调用方真的改了**：
 *   ① 全仓只有**一个** `sendJSON` 定义（重复所有者 = 重构没做完）；
 *   ② `server.js` 里不再有这些函数定义，且确实从新模块 import；
 *   ③ 新模块只依赖 `node:` 内建（不碰数据库、不碰创作内核、不起服务）。
 *
 * 行为等价用**假 res/req** 直接断言，不依赖活实例（离线可跑、零端口）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { suiteAsync } from '../temporal/harness.mjs';
import { REPO } from '../../scripts/nsdsh/lib/isolate.mjs';

const H = await import('../../ai/http/respond.mjs');

/** 假 ServerResponse：只记录 writeHead / end / setHeader。 */
function fakeRes() {
  return {
    status: null, headers: null, body: '', extraHeaders: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    setHeader(k, v) { this.extraHeaders[k] = v; },
    end(body) { this.body = body === undefined ? '' : String(body); },
  };
}

/** 假 IncomingMessage：可注入分块与事件。 */
function fakeReq({ chunks = [], declared = null } = {}) {
  const stream = new PassThrough();
  stream.headers = declared === null ? {} : { 'content-length': String(declared) };

  setImmediate(() => {
    for (const c of chunks) stream.write(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
    stream.end();
  });
  return stream;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // 跳过 node_modules/数据目录/以及**所有隐藏目录**：项目里有 .p6-cutover/.verify 这类
    // 历史快照（同一份 server.js 的多份备份），它们是证据而不是活代码 —— 算进"重复所有者"会误判。
    if (e.isDirectory() && (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'data')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name.endsWith('.mjs') || e.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

await suiteAsync('nsdsh/http-respond', [
  ['R05-H1 抽取后全仓只有**一个** sendJSON/sendError/readBody 定义（没有重复所有者）', async () => {
    const files = walk(REPO).filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
    const defs = { sendJSON: [], sendError: [], readBody: [], readBodyOrError: [], drainRequestBody: [] };
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const name of Object.keys(defs)) {
        const re = new RegExp(`(^|\\n)\\s*(export\\s+)?(async\\s+)?function\\s+${name}\\s*\\(`);
        if (re.test(src)) defs[name].push(path.relative(REPO, f));
      }
    }
    for (const [name, where] of Object.entries(defs)) {
      assert.equal(where.length, 1, `${name} 必须只有一个定义，实际 ${where.length}：${where.join(', ')}`);
      assert.match(where[0], /ai[\\/]http[\\/]respond\.mjs$/, `${name} 应只在 ai/http/respond.mjs 里`);
    }
  }],

  ['R05-H2 server.js 不再定义这些函数，且确实从新模块 import（生产调用方真的迁移了）', async () => {
    const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    for (const name of ['sendJSON', 'sendError', 'readBody', 'readBodyOrError', 'drainRequestBody']) {
      const re = new RegExp(`(^|\\n)\\s*(async\\s+)?function\\s+${name}\\s*\\(`);
      assert.ok(!re.test(server), `server.js 不应再定义 ${name}`);
    }
    assert.match(server, /import \{ sendJSON, sendError, readBody, readBodyOrError, MAX_BODY_BYTES \} from '\.\/ai\/http\/respond\.mjs'/,
      '必须真实 import（否则等于新建了文件但老逻辑还在跑）');
    // 调用面仍在（证明是"迁移"而不是"删掉"）
    const calls = (server.match(/sendJSON\(/g) || []).length + (server.match(/sendError\(/g) || []).length;
    assert.ok(calls > 100, `调用点应仍在（实际 ${calls}）`);
  }],

  ['R05-H3 新模块只依赖 node: 内建（不碰数据库/创作内核/不启服务）', async () => {
    const src = fs.readFileSync(path.join(REPO, 'ai/http/respond.mjs'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(imports, [], `不允许任何 import（只用全局 Buffer/setTimeout）；实际：${imports.join(',')}`);
    // 只检查**代码**：注释里提 "server.js 一万多行" 是在解释为什么抽这一域，
    // 把它当违规会让断言恒假（本会话第 5 次踩自指/注释陷阱）。
    const NL = String.fromCharCode(10);
    const code = src.split(NL).filter((l) => {
      const t = l.trim();
      return !(t.startsWith('*') || t.startsWith('/*') || t.startsWith('//'));
    }).join(NL);
    for (const bad of ['db.js', 'server.js', 'node:http', 'createServer', 'DatabaseSync', 'callAI']) {
      assert.ok(!code.includes(bad), `respond.mjs 的代码不应包含 ${bad}`);
    }
  }],

  ['R05-H4 sendJSON 契约不变：UTF-8 JSON + no-store，且**不带** CORS 通配', async () => {
    const res = fakeRes();
    H.sendJSON(res, 201, { a: 1, 中文: '值' });
    assert.equal(res.status, 201);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined, '不得放开跨源读取');
    assert.deepEqual(JSON.parse(res.body), { a: 1, 中文: '值' });
  }],

  ['R05-H5 sendError：人话 + 机器可判 code 合并（附加字段不覆盖 error）', async () => {
    const res = fakeRes();
    H.sendError(res, 409, '该章已被改动', { code: 'EMPTY_OVERWRITE_BLOCKED', current: 7 });
    assert.equal(res.status, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.error, '该章已被改动');
    assert.equal(body.code, 'EMPTY_OVERWRITE_BLOCKED');
    assert.equal(body.current, 7);
    // 没有 extra 时也要有 error
    const res2 = fakeRes();
    H.sendError(res2, 500);
    assert.equal(JSON.parse(res2.body).error, 'Internal error');
  }],

  ['R05-H6 readBody：正常 JSON / 空体 / 分块跨多字节字符都不坏', async () => {
    assert.deepEqual(await H.readBody(fakeReq({ chunks: ['{"a":1}'] })), { a: 1 });
    assert.deepEqual(await H.readBody(fakeReq({ chunks: [] })), {}, '空体解析成 {}');
    // 故意把「中文」拆到两个 chunk 的边界上
    const raw = Buffer.from(JSON.stringify({ t: '中文内容' }), 'utf8');
    const cut = raw.indexOf(Buffer.from('中', 'utf8')) + 1;
    const parts = [raw.subarray(0, cut), raw.subarray(cut)];
    assert.deepEqual(await H.readBody(fakeReq({ chunks: parts })), { t: '中文内容' });
  }],

  ['R05-H7 readBody：JSON 畸形 → INVALID_JSON；超限 → PAYLOAD_TOO_LARGE（两者必须可分）', async () => {
    await assert.rejects(H.readBody(fakeReq({ chunks: ['{不是 json'] })), (e) => e.code === 'INVALID_JSON');
    await assert.rejects(
      H.readBody(fakeReq({ chunks: ['x'.repeat(50)] }), { maxBytes: 10 }),
      (e) => e.code === 'PAYLOAD_TOO_LARGE',
    );
    // 声明超限（content-length）也必须先拒
    await assert.rejects(
      H.readBody(fakeReq({ declared: 999, chunks: [] }), { maxBytes: 10 }),
      (e) => e.code === 'PAYLOAD_TOO_LARGE',
    );
  }],

  ['R05-H8 readBodyOrError：413 与 400 分得清，并只对 413 关闭连接', async () => {
    const res1 = fakeRes();
    const r1 = await H.readBodyOrError(fakeReq({ chunks: ['y'.repeat(50)] }), res1, { maxBytes: 10 });
    assert.equal(r1.ok, false);
    assert.equal(res1.status, 413);
    assert.equal(res1.extraHeaders.Connection, 'close');

    const res2 = fakeRes();
    const r2 = await H.readBodyOrError(fakeReq({ chunks: ['{坏'] }), res2);
    assert.equal(r2.ok, false);
    assert.equal(res2.status, 400);
    assert.equal(JSON.parse(res2.body).error, '请求体不是合法 JSON');
    assert.equal(res2.extraHeaders.Connection, undefined, '400 不需要关连接');
  }],

  ['R05-H9 常量仍是生产值（抽取不得顺手改阈值）', async () => {
    assert.equal(H.MAX_BODY_BYTES, 36_000_000);
    assert.equal(H.MAX_DRAIN_BYTES, 96_000_000);
    assert.equal(H.DRAIN_DEADLINE_MS, 5000);
  }],
]);
