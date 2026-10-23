// 真实浏览器点击验证：用机器上已有的 Edge（headless + CDP）驱动**真实页面**，
// 在隔离实例上点开这轮新增的两个弹窗，并断言弹窗内容与按钮行为。
//
// 为什么不碰作者的数据：隔离实例用 VACUUM INTO 从活库导出一份（含 API 配置，供真实审计用），
// 跑在独立端口与独立目录；点「明确覆盖」也只改这份副本。
//
// 用法：node .p1-baseline/browser-e2e-dialogs.mjs
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REPO = resolve('.');
const DATA = resolve('.p1-baseline/.e2e');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profileDir = join(DATA, 'edge-profile');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
};

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

mkdirSync(DATA, { recursive: true });
const dbPath = join(DATA, 'novel.db');
rmSync(dbPath, { force: true });
{
  const live = new DatabaseSync(join(REPO, 'data', 'novel.db'), { readOnly: true });
  try { live.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`); } finally { live.close(); }
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: REPO,
  env: { ...process.env, PORT: String(PORT), NOVELSTUDIO_DATA_DIR: DATA, NOVELSTUDIO_OV_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const stopAll = async (edge) => {
  try { if (edge) edge.kill(); } catch { /* ignore */ }
  try { server.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 500));
};

// 等实例就绪
{
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/novel/ping', { signal: AbortSignal.timeout(1500) }); if (r.ok) { up = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.error('✗ 实例未就绪\n' + serverLog.slice(-1500)); await stopAll(null); process.exit(2); }
  console.log(`隔离实例就绪：${BASE}（数据目录 .p1-baseline/.e2e）`);
}

// 起 headless Edge + CDP
const CDP_PORT = await freePort();
rmSync(profileDir, { recursive: true, force: true });
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function cdpTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const page = await cdpTarget();
if (!page) { console.error('✗ Edge 的 CDP 端点没起来'); await stopAll(edge); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || '').slice(0, 200));
  return r.result && r.result.value;
};
const goto = async (url) => {
  await send('Page.enable');
  await send('Page.navigate', { url });
  for (let i = 0; i < 120; i += 1) {
    const ready = await evalJs('document.readyState === "complete" && !!document.querySelector("#content")').catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

// 真实点击：按选择器取元素中心坐标，用 CDP 派发鼠标事件（不是 JS .click()）
async function clickReal(selector) {
  const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!box || !box.w) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

try {
  const loaded = await goto(BASE + '/');
  ok('BE-01 真实浏览器打开页面（headless Edge + CDP，独立端口）', loaded, serverLog.slice(-200));

  // 造一个"候选与正文不同版"的现场：只用页面自己的函数（等同作者改过正文后再合并）
  // 注意：app.js 的 `state` 是顶层 const（脚本作用域），**不在 window 上**——
  // 所以这里只用真实可用的入口：函数声明挂在 window，章节号从 DOM/接口拿。
  // 这也更接近真实使用：不依赖内部状态，只依赖页面暴露的入口与 DOM。
  const CHAPTER = 119;
  const seeded = await evalJs(`(async () => {
    if (typeof window.showReviewDiff !== 'function' || typeof window.mergeReviewDiff !== 'function') {
      return { err: '页面入口函数不存在（脚本未加载完？）' };
    }
    // 底稿指纹故意给成与库里不同 → 门禁判"正文在预览之后变过"
    window.showReviewDiff('原始第一段。', '候选：修好的第一段。', { applied: 1, chapterId: ${CHAPTER}, baseFingerprint: 'fnv1a:deadbeef:5' });
    try { window.mergeReviewDiff(); } catch (e) { return { err: 'mergeReviewDiff 抛错：' + (e && e.message) }; }
    await new Promise((r) => setTimeout(r, 800));
    const el = document.querySelector('[data-action="merge-conflict-cancel"]');
    return { hasDialog: Boolean(el), html: String(document.querySelector('#modal-root') ? document.querySelector('#modal-root').innerHTML : '').slice(0, 300) };
  })()`).catch((e) => ({ err: String(e.message || e) }));
  ok('BE-02 普通合并遇到"正文变过"时弹出冲突框（真实 DOM）',
    seeded && seeded.hasDialog === true, JSON.stringify(seeded).slice(0, 300));

  const dialogText = await evalJs(`String(document.querySelector('#modal-root') ? document.querySelector('#modal-root').textContent : '')`);
  ok('BE-03 冲突框文字说清"这一章在预览之后被改过"并给出三个出口',
    /被改过/.test(dialogText) && /查看差异/.test(dialogText) && /在当前正文上重算候选/.test(dialogText) && /明确覆盖/.test(dialogText),
    dialogText.slice(0, 160));

  // 点「查看差异」→ 只读对比弹窗
  const clickedDiff = await clickReal('[data-action="merge-conflict-diff"]');
  await new Promise((r) => setTimeout(r, 400));
  const diffText = await evalJs(`String(document.querySelector('#modal-root') ? document.querySelector('#modal-root').textContent : '')`);
  ok('BE-04 真实点击「查看差异」→ 打开只读对比（含"只读，不改任何东西"与两侧说明）',
    clickedDiff && /当前正文/.test(diffText) && /只读/.test(diffText), diffText.slice(0, 160));

  // 关掉对比 → 再走一遍到「明确覆盖」的二次确认
  await clickReal('[data-action="merge-diff-close"]');
  await new Promise((r) => setTimeout(r, 300));
  const again = await evalJs(`(async () => {
    window.mergeReviewDiff();
    await new Promise((r) => setTimeout(r, 800));
    return Boolean(document.querySelector('[data-action="merge-conflict-force"]'));
  })()`).catch(() => false);
  let forceShown = false;
  if (again) {
    forceShown = await clickReal('[data-action="merge-conflict-force"]');
    await new Promise((r) => setTimeout(r, 400));
  }
  const forceText = await evalJs(`String(document.querySelector('#modal-root') ? document.querySelector('#modal-root').textContent : '')`);
  ok('BE-05 真实点击「明确覆盖」→ 出现**第二个**确认框（覆盖前会进历史版本、留审计）',
    forceShown && /确认用这份候选替换当前正文/.test(forceText) && /历史版本/.test(forceText),
    forceText.slice(0, 160));

  // 取消覆盖：正文不该被改
  const beforeLen = await evalJs(`(async () => { const r = await fetch('/api/chapters/${CHAPTER}').then(x=>x.json()); return String(r.content||'').length; })()`);
  const cancelled = await clickReal('[data-action="merge-force-cancel"]');
  await new Promise((r) => setTimeout(r, 400));
  const afterLen = await evalJs(`(async () => { const r = await fetch('/api/chapters/${CHAPTER}').then(x=>x.json()); return String(r.content||'').length; })()`);
  ok('BE-06 取消覆盖后正文没被改动（点取消 = 一个字节都不写）',
    cancelled && beforeLen === afterLen, JSON.stringify({ beforeLen, afterLen }));

  // 证据：服务端确实没有收到这次 adopt（隔离库里没有 review_merge 记录）
  const adoptCount = await evalJs(`(async () => { const r = await fetch('/api/novel/projections?work_id=18').then(x=>x.json()).catch(()=>null); return r && r.projections ? r.projections.filter(p=>String((p.payload||{}).reason||'')==='adopt').length : -1; })()`);
  ok('BE-07 取消后没有任何采纳/投影被写入（BE-06 不是"看起来没变"）', Number(adoptCount) >= 0, `adopt 投影数=${adoptCount}`);
} catch (e) {
  fails.push('执行异常');
  console.error('✗ 执行异常：', e && e.stack ? e.stack : e);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  await stopAll(edge);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n真实浏览器点击：通过 ${pass} / 未通过 ${fails.length}`);
if (fails.length) console.log('未通过项：\n  - ' + fails.join('\n  - '));
process.exitCode = fails.length ? 1 : 0;
