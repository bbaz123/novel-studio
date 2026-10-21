/**
 * scripts/quality-auditor/harness.mjs —— 审计套件的公共装置（隔离实例 + 真实 HTTP + 临时数据目录）。
 *
 * 纪律（与 scripts/ci-isolated-run.mjs、tests/narrative-repair/harness.mjs 一致）：
 *   · 每个用例都打**真实 HTTP**、查**真实 SQLite**，不接受"读源码看有没有写"；
 *   · 零计费：所有审计都用 start:false（外部 runner 模式），不拉起模型；
 *   · 退出码是唯一判据；零用例 = 失败。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function tempDir(prefix = 'novel-qa-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发占用：忽略 */ }
}

export function freePort() {
  return new Promise((res) => {
    const probe = net.createServer();
    probe.once('error', () => res(5600 + (process.pid % 400)));
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => res(p));
    });
  });
}

export function startServer({ port, dataDir, env = {} } = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      NOVELSTUDIO_DATA_DIR: dataDir,
      NOVELSTUDIO_OV_DISABLED: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { text: '' };
  child.stdout.on('data', (c) => { log.text += c; });
  child.stderr.on('data', (c) => { log.text += c; });
  return { child, log, port, dataDir, base: `http://127.0.0.1:${port}` };
}

export async function waitReady(base, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) {
        const ready = await fetch(`${base}/api/readiness`, { signal: AbortSignal.timeout(1500) });
        if (ready.status === 200) return true;
      }
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function stopServer(handle) {
  if (!handle || !handle.child) return;
  try { handle.child.kill(); } catch (_) { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 200));
}

/** JSON 请求。 */
export async function jfetch(base, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

/**
 * 固定样本：正文、蓝图、带逐字引用的初审报告。
 * 引用必须真的出现在正文里 —— 这不是"测试数据随便写"，而是契约本身（quote 必须逐字存在）。
 */
export const ARTICLE = [
  '第一章 雨夜',
  '',
  '陈默推开门，雨声一下子涌进来。他把伞靠在门边，屋里只有一盏灯。',
  '',
  '“你迟到了。”林清雪说。她没有抬头，指尖停在纸页上。',
  '',
  '陈默在桌边坐下。雨点砸在窗上，像有人在数数。他第三次想起那封信，',
  '信上说三天后见，可今天已经是第四天。',
  '',
  '“线索断了。”他说。',
  '',
  '林清雪终于抬眼。她把纸推过来，纸角被水洇开一片。',
].join('\n');

export const BLUEPRINT = '本章应完成：陈默与林清雪碰头、确认线索断裂、引出三天之约的疑点。';

export const INITIAL_REPORT = {
  schema_version: 'review.v3',
  summary: '本章完成度中等：氛围足，但时间线与重复解释有明显问题。',
  strengths: ['雨夜氛围具体'],
  deferred: [],
  issues: [
    { id: 'R-0001', text: '时间线自相矛盾（三天后见 / 已经是第四天）', source: 'initial_review', link_mode: 'explicit', finding_id: 'R-0001' },
    { id: 'R-0002', text: '“数数”的比喻后文没有承接，像模板句', source: 'initial_review', link_mode: 'explicit', finding_id: 'R-0002' },
  ],
  findings: [
    {
      id: 'R-0001', title: '时间线自相矛盾', type: 'temporal', severity: 'high', confidence: 0.9,
      explanation: '三天后见与第四天冲突',
      evidence: [{ quote: '信上说三天后见，可今天已经是第四天。', role: 'candidate_edit' }],
      acceptance: { rule: '时间线必须自洽（要么改成三天内，要么说明已经过了三天）', preserve: ['林清雪'] },
    },
    {
      id: 'R-0002', title: '模板化比喻', type: 'style', severity: 'medium', confidence: 0.8,
      explanation: '雨点像有人在数数，没有承接',
      evidence: [{ quote: '像有人在数数', role: 'candidate_edit' }],
      acceptance: { rule: '不得再用“像有人在数数”这类模板比喻', preserve: [] },
    },
  ],
};

/** 写一份可复核的初审（走真实 PUT /novel/review）。 */
export async function seedReview(base, chapterId) {
  return jfetch(base, '/api/novel/review', {
    method: 'PUT',
    body: {
      chapter_id: chapterId,
      base_text: ARTICLE,
      base_hash: 'sha256:fixture-base',
      report: INITIAL_REPORT,
    },
  });
}
