#!/usr/bin/env node
/**
 * mutation gate（方案 §5.4 / AC-15 的等价实现）。
 *
 * 为什么必须真的跑：覆盖率只能证明行被执行过，不能证明断言抓得住错误。
 * 这里对变更域逻辑做 5 处定点变异，每处配一条针对性探针；
 * 探针在变异后必须**失败**（killed），否则该变异体存活 → 分数下降 → 门禁不通过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = process.cwd()
const CORE = path.join(REPO, 'ai/one-click-book/core.mjs')
const OUT = path.join(REPO, 'reports/quality-gates-mutation.json')
const THRESHOLD = 0.8

const MUTANTS = [
  {
    id: 'M1-placeholder-severity',
    find: "if (PLACEHOLDER_RE.test(text)) findings.push({ code: 'PLACEHOLDER', severity: 'critical'",
    replace: "if (PLACEHOLDER_RE.test(text)) findings.push({ code: 'PLACEHOLDER', severity: 'low'",
    probe: `import(${JSON.stringify(path.join(REPO, 'ai/one-click-book/core.mjs'))}).then((core) => {
      const qa = core.qaChapter({ chapter: { id: '001', title: 'T', must_include: [], word_range: [0, 999] }, text: '# T\\n\\n这里有 {{占位}}。', bible: {} });
      if (qa.ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M2-quality-gate-invert',
    find: 'return { ok: failures.length === 0, failures }',
    replace: 'return { ok: failures.length !== 0, failures }',
    probe: `import(${JSON.stringify(path.join(REPO, 'ai/one-click-book/core.mjs'))}).then((core) => {
      const v = core.evaluateQualityGates({ mutationRan: false, testsPassed: true, securityPassed: true, evidenceChainOk: true });
      if (v.ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M3-word-short-check-removed',
    find: "if (count < chapter.word_range[0]) findings.push({ code: 'WORD_TOO_SHORT'",
    replace: "if (false) findings.push({ code: 'WORD_TOO_SHORT'",
    probe: `import(${JSON.stringify(path.join(REPO, 'ai/one-click-book/core.mjs'))}).then((core) => {
      const qa = core.qaChapter({ chapter: { id: '001', title: 'T', must_include: [], word_range: [100, 200] }, text: '# T\\n\\n短。', bible: {} });
      if (qa.ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M4-export-approval-removed',
    find: 'if (!approvals?.export) {',
    replace: 'if (false) {',
    probe: `import(${JSON.stringify(path.join(REPO, 'ai/one-click-book/core.mjs'))}).then((core) => {
      let threw = false;
      try { core.exportBook({ bookDir: process.cwd(), title: 'T', chapters: [], approvals: {} }); } catch { threw = true; }
      if (!threw) process.exit(3);
    })`,
  },
  {
    id: 'M5-chain-prev-check-removed',
    find: 'if (entry.prev !== prev) return { ok: false, index: i, reason: \'prev-mismatch\' }',
    replace: 'if (false) return { ok: false, index: i, reason: \'prev-mismatch\' }',
    probe: `import(${JSON.stringify(path.join(REPO, 'ai/one-click-book/core.mjs'))}).then((core) => {
      let chain = core.appendEvidence([], { stage: 'A' });
      chain = [{ ...chain[0], prev: 'bogus' }];
      if (core.verifyEvidenceChain(chain).ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M6-egress-check-disabled',
    file: 'ai/one-click-book/egress.mjs',
    find: 'if (!ok) throw new EgressDeniedError(host)',
    replace: 'if (false) throw new EgressDeniedError(host)',
    probe: `import(__MODULE__).then((mod) => {
      const guard = mod.createEgressGuard({});
      let threw = false;
      try { guard.check('https://example.com'); } catch { threw = true; }
      if (!threw) process.exit(3);
    })`,
  },
  {
    id: 'M7-attest-signature-always-true',
    file: 'ai/one-click-book/attest.mjs',
    find: 'checks.signature = verify(null,',
    replace: 'checks.signature = true || verify(null,',
    probe: `Promise.all([import(__MODULE__), import('node:os'), import(__CORE__)]).then(([attest, os, core]) => {
      const keyDir = os.tmpdir() + '/ocb-mut-keys-' + Date.now();
      let chain = core.appendEvidence([], { stage: 'A' });
      const anchor = attest.signChain({ chain, keyDir, meta: {} });
      const bad = { ...anchor, signature: Buffer.from('nope').toString('base64') };
      const v = attest.verifyAnchor({ anchor: bad, chain });
      if (v.checks.signature !== false || v.ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M8-ingest-credential-scan-disabled',
    file: 'ai/one-click-book/core.mjs',
    find: 'if (hits.length > 0) {',
    replace: 'if (false) {',
    probe: `Promise.all([import(__CORE__), import('node:fs'), import('node:os'), import('node:path')]).then(([core, fs, os, path]) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-mut-ingest-'));
      const file = path.join(dir, 'source.md');
      fs.writeFileSync(file, '# x\\n\\n配置 ' + ['AK', 'IA'].join('') + 'ABCDEFGHIJKLMNOP\\n');
      const out = core.ingestSources([file]);
      fs.rmSync(dir, { recursive: true, force: true });
      if (!out.errors.some((e) => e.code === 'CREDENTIAL_IN_SOURCE')) process.exit(3);
    })`,
  },
  {
    id: 'M9-forbidden-dotfile-disabled',
    file: 'ai/one-click-book/core.mjs',
    find: "if (base.startsWith('.')) return 'dotfile'",
    replace: "if (false) return 'dotfile'",
    probe: `import(__CORE__).then((core) => {
      if (core.forbiddenSourceReason('/tmp/ws/.env') !== 'dotfile') process.exit(3);
    })`,
  },
  {
    id: 'M10-completion-evidence-check-disabled',
    file: 'ai/one-click-book/core.mjs',
    find: "if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) missing.push('no-observed-evidence')",
    replace: 'if (false) missing.push(\'no-observed-evidence\')',
    probe: `import(__CORE__).then((core) => {
      const v = core.completionVerdict({ evidenceRefs: [], gates: [{ ok: true }], chain: [] });
      if (v.ok !== false || !v.missing.includes('no-observed-evidence')) process.exit(3);
    })`,
  },
  {
    id: 'M11-book-id-validation-disabled',
    file: 'ai/one-click-book/books.mjs',
    find: 'if (!isValidBookId(id)) {',
    replace: 'if (false) {',
    probe: `import(__MODULE__).then((books) => {
      let threw = false;
      try { books.bookRootOf('/tmp/books', '../escape'); } catch { threw = true; }
      if (!threw) process.exit(3);
    })`,
  },
  {
    id: 'M12-publish-hash-check-disabled',
    file: 'ai/one-click-book/job.mjs',
    find: "if (!deliverable || expected !== approvalHash) {",
    replace: 'if (!deliverable) {',
    probe: `Promise.all([import(__MODULE__), import('node:fs'), import('node:os'), import('node:path')]).then(([job, fs, os, path]) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-mut-pub-'));
      fs.mkdirSync(path.join(dir, '.job'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.job/state.json'), JSON.stringify({ job_id: 'j', status: 'COMPLETED', idempotency_key: 'k', brief: {}, approvals: {}, stage_history: [], evidence: [] }));
      fs.mkdirSync(path.join(dir, 'manifest'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest/deliverable-manifest.json'), JSON.stringify({ schema_version: '1.0.0', artifacts: [{ path: 'export/book.md', sha256: 'abc' }] }));
      let code = null;
      try { job.publishJob({ root: dir, approvals: { publish: true, publish_hash: 'wrong' } }); } catch (e) { code = e.code; }
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 'PUBLISH_HASH_MISMATCH') process.exit(3);
    })`,
  },
]

const source = fs.readFileSync(CORE, 'utf8')
const results = []
for (const mutant of MUTANTS) {
  // 每个变异体可以指定自己的目标文件；默认 core.mjs。
  const moduleFile = mutant.file ? path.join(REPO, mutant.file) : CORE
  const moduleSource = fs.readFileSync(moduleFile, 'utf8')
  if (!moduleSource.includes(mutant.find)) {
    results.push({ id: mutant.id, verdict: 'INVALID_MUTANT', reason: '变异点未找到（源码已变，需同步更新 mutation 定义）' })
    continue
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-mut-'))
  const target = path.join(dir, path.basename(moduleFile))
  fs.writeFileSync(target, moduleSource.replace(mutant.find, mutant.replace))
  const probe = mutant.probe
    .replaceAll('__CORE__', JSON.stringify(CORE))
    .replaceAll(JSON.stringify(CORE), JSON.stringify(target))
    .replaceAll(JSON.stringify(moduleFile), JSON.stringify(target))
    .replaceAll('__MODULE__', JSON.stringify(target))
  let killed = false
  let detail = ''
  try {
    execFileSync(process.execPath, ['-e', probe], { stdio: 'pipe', timeout: 30_000 })
  } catch (e) {
    killed = e.status !== 0
    detail = String(e.stderr ?? e.message).slice(0, 200)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  results.push({ id: mutant.id, verdict: killed ? 'KILLED' : 'SURVIVED', detail })
}

const killed = results.filter((item) => item.verdict === 'KILLED').length
const invalid = results.filter((item) => item.verdict === 'INVALID_MUTANT').length
const score = results.length === 0 ? 0 : killed / results.length
const report = {
  schema_version: '1.0.0',
  generated_at: new Date().toISOString(),
  target: 'ai/one-click-book/core.mjs',
  threshold: THRESHOLD,
  mutation_ran: true,
  mutants: results.length,
  killed,
  invalid,
  score: Number(score.toFixed(3)),
  pass: invalid === 0 && score >= THRESHOLD,
  results,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ok: report.pass, score: report.score, killed, mutants: results.length, invalid }) + '\n')
process.exit(report.pass ? 0 : 1)
