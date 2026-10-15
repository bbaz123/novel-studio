/**
 * tests/nsdsh/backup-restore.test.mjs —— 备份/恢复演练的**端到端断言面**（S01，零依赖、零计费）。
 *
 * 这里刻意**把 `backup-restore-check.mjs` 当子进程跑**（而不是 import 它的函数）：
 * 要验证的正是"这个脚本作为一条命令能不能用"——参数、退出码、`--json` 输出契约，
 * 以及它**拒绝在作者真实库上运行**的那道闸。import 进来只能证明内部函数对，证明不了这些。
 *
 * 退出码与 JSON 一起断言：只有退出码会漏掉"JSON 字段悄悄改名"，只有 JSON 会漏掉
 * "进程其实失败了但打印了一份漂亮报告"。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../scripts/nsdsh/lib/gate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/nsdsh/backup-restore-check.mjs';

function suite(name, cases) {
  let pass = 0;
  const failed = [];
  for (const [label, fn] of cases) {
    try {
      fn();
      pass += 1;
      console.log(`  ok   ${label}`);
    } catch (e) {
      failed.push([label, e]);
      console.log(`  FAIL ${label}: ${(e && e.message) || e}`);
    }
  }
  console.log(`[${name}] PASS ${pass} / FAIL ${failed.length}`);
  for (const [label, e] of failed) console.log(`---- ${label}\n${(e && e.stack) || e}`);
  if (failed.length) process.exitCode = 1;
  return { pass, failed: failed.length };
}

// 只跑一次，两组断言共用同一份真实输出（该脚本要建库、播种、VACUUM、三次比对，跑两遍纯属浪费）。
const r = runCommand([process.execPath, SCRIPT, '--fixture', '--json'], { cwd: REPO, timeoutMs: 10 * 60 * 1000 });
const raw = `${r.stdout || ''}`;
let parsed = null;
let parseError = '';
try { parsed = JSON.parse(raw); } catch (e) { parseError = e.message; }

// 拒绝闸：把数据目录显式指到作者真实库，必须立刻拒绝（退出码 2），且不产生任何 report。
const refuse = runCommand([process.execPath, SCRIPT, '--fixture'], {
  cwd: REPO,
  env: { NOVELSTUDIO_DATA_DIR: path.join(REPO, 'data') },
  timeoutMs: 60 * 1000,
});

await suite('nsdsh/backup-restore', [
  ['backup-restore-check.mjs --fixture --json 必须退出码 0', () => {
    assert.ok(!r.environmentBlocked || r.status === 0, `没跑起来：${r.error || 'status=null'}`);
    assert.equal(r.status, 0, `expected exit 0, actual ${r.status}; stderr=${String(r.stderr || '').slice(0, 400)}`);
  }],

  ['--json 输出是合法 JSON 且 ok=true', () => {
    assert.equal(parseError, '', `stdout 不是合法 JSON：${parseError}\n${raw.slice(0, 400)}`);
    assert.equal(parsed.ok, true);
    assert.ok(Number.isInteger(parsed.passed) && Number.isInteger(parsed.failed));
    assert.ok(parsed.passed >= 6, `断言项太少：${parsed.passed}`);
    assert.equal(parsed.failed, 0);
  }],

  ['每一项检查都 passed（逐条，而不是只看总判定）', () => {
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length >= 6);
    const bad = parsed.checks.filter((c) => !c.passed);
    assert.equal(bad.length, 0, `未通过项：${bad.map((c) => `${c.name}(${c.detail})`).join('; ')}`);
    // 抽查三项语义：种子、一致快照、阴性对照都在清单里。
    const names = parsed.checks.map((c) => c.name).join('|');
    assert.match(names, /种下 >=3 章/);
    assert.match(names, /VACUUM INTO/);
    assert.match(names, /阴性对照/);
  }],

  ['恢复副本的清单与原始清单一模一样（逐表行数 + 内容摘指纹）', () => {
    const { original, restore } = parsed.manifests;
    assert.deepEqual(restore.rowCounts, original.rowCounts, '行数必须完全一致');
    assert.deepEqual(Object.keys(restore.content).sort(), Object.keys(original.content).sort());
    for (const t of Object.keys(original.content)) {
      assert.equal(restore.content[t].digest, original.content[t].digest, `${t} 的内容摘指纹必须一致`);
      assert.equal(restore.content[t].rows, original.content[t].rows, `${t} 的行数必须一致`);
    }
    // 阴性对照本身也要有证据：篡改副本与原始清单**必须**不同。
    assert.notEqual(parsed.manifests.tamper.content.chapters.digest, original.content.chapters.digest,
      '阴性对照没有产生差异 → 比对器无检测能力');
  }],

  ['播种内容真的落库（>=3 章、正文各不相同、有修订行）', () => {
    const { original } = parsed.manifests;
    assert.ok(original.rowCounts.works >= 1, `works 行数：${original.rowCounts.works}`);
    assert.ok(original.rowCounts.chapters >= 3, `chapters 行数：${original.rowCounts.chapters}`);
    assert.ok(original.rowCounts.story_chapter_revisions >= 1, `story_chapter_revisions 行数：${original.rowCounts.story_chapter_revisions}`);
    // 内容摘指纹存在且是 64 位十六进制（证明真的算过，不是占位串）。
    assert.match(original.content.chapters.digest, /^[0-9a-f]{64}$/);
  }],

  ['数据目录指向真实 data/ 时拒绝运行（退出码 2，且不打印 JSON）', () => {
    assert.equal(refuse.status, 2, `expected exit 2, actual ${refuse.status}`);
    assert.equal(String(refuse.stdout || '').trim(), '', '拒绝时不得在 stdout 打印任何结果');
    assert.match(String(refuse.stderr || ''), /拒绝在作者真实库上运行/);
  }],
]);
