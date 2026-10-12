/**
 * 离线取真实提示词（零计费）：复用 frontend-test.mjs 的 vm + DOM 桩装载方式，
 * 把 app.js 里的 buildAIReviewPrompt 暴露出来，在**真实调用前**量出提示词字符数，
 * 用来在 2 元预算内先算上界。
 *
 * 为什么不用 server 端点：服务端没有"只拼提示词不调用"的口子；而拼装是 app.js 的纯函数。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = process.cwd();
const src = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// 最小 DOM/localStorage 桩（照 frontend-test 的用法，只取拼装提示词所需的最小面）
const elStub = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  dataset: {}, innerHTML: '', textContent: '', value: '', hidden: false, checked: false,
  children: [], appendChild() {}, removeChild() {}, remove() {}, addEventListener() {},
  setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; },
  querySelectorAll() { return []; }, focus() {}, blur() {}, click() {},
});
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  Promise, JSON, Math, Date, Number, String, Array, Object, RegExp, Error, Map, Set, Symbol,
  Intl, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, isNaN, isFinite, parseFloat, parseInt,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  location: { href: 'http://127.0.0.1:3738/', origin: 'http://127.0.0.1:3738', search: '', hash: '' },
  navigator: { userAgent: 'node-paid-eval', clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
  alert: () => {}, confirm: () => true, prompt: () => null,
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: () => {},
  performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
  AbortController, TextEncoder, TextDecoder, URL, URLSearchParams, FormData, Blob,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
sandbox.dispatchEvent = () => true;
sandbox.document = {
  querySelector: (sel) => elStub(), querySelectorAll: () => [], getElementById: () => elStub(),
  createElement: () => elStub(), createDocumentFragment: () => elStub(),
  addEventListener: () => {}, removeEventListener: () => {}, body: elStub(), head: elStub(),
  documentElement: elStub(), readyState: 'complete', cookie: '',
};
sandbox.EventSource = function () { this.addEventListener = () => {}; this.close = () => {}; };
sandbox.XMLHttpRequest = function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; this.addEventListener = () => {}; };

const ctx = vm.createContext(sandbox);
const files = ['patch-safety.js', 'revision-patch.js', 'revision-plan.js', 'long-text.js'];
for (const f of files) {
  new vm.Script(fs.readFileSync(path.join(repoRoot, 'public', f), 'utf8'), { filename: f }).runInContext(ctx, { timeout: 10000 });
}
const probe = `
;globalThis.__probe = { buildAIReviewPrompt, buildRedlineScanText, buildAIWritingProsePrompt };
`;
try {
  new vm.Script(src + probe, { filename: 'app.js' }).runInContext(ctx, { timeout: 20000 });
} catch (e) {
  console.log('LOAD ERROR:', e.message);
  process.exit(1);
}
const P = sandbox.__probe;
if (!P || typeof P.buildAIReviewPrompt !== 'function') { console.log('probe missing'); process.exit(1); }

// 两类输入：合法语境（应允许 not_applicable）与真实冗余（应报 confirmed）
const GOOD = '她微微侧过身，让出了一条路。他点了点头，继续往前走。';
const BAD = '他不认识画面里那个女生。这道光柱和他没关系，这场雪和他也没关系。他站在那里，一动不动，也没有任何表情，就像刚才只是完成了一个程序。';
const scanText = '命中 2 处：微微×1、没有任何×1';

const pGood = P.buildAIReviewPrompt(GOOD, scanText, '', 4000);
const pBad = P.buildAIReviewPrompt(BAD, scanText, '', 4000);
console.log(JSON.stringify({
  prompt_good_chars: pGood.length,
  prompt_bad_chars: pBad.length,
  scan_block_present: pGood.includes('候选信号'),
  not_applicable_present: pGood.includes('not_applicable'),
}, null, 2));
fs.writeFileSync(path.resolve('.narrative-repair-116/paid-eval-prompts.json'), JSON.stringify({ pGood, pBad }, null, 2));
console.log('prompts written for the paid step (not printed in full).');
// ⚠️ app.js 顶层初始化会留下定时器/未决 Promise，进程不会自然退出；
//    显式退出（与 frontend-test 的收尾方式一致），否则脚本会一直挂着。
process.exit(0);
