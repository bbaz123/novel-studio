#!/usr/bin/env node
/**
 * mutation gate（方案 §5.4 / AC-15 的等价实现）。
 *
 * 2026-11-12 修复记录（本轮 P9 发现的假绿）：
 *   1) 探针里的动态 import 原先写成 Windows 绝对路径（`import("C:\\...")`），
 *      Node 必然报 ERR_UNSUPPORTED_ESM_URL_SCHEME；脚本把“任何非零退出”都当 KILLED，
 *      于是 12/12 看似全杀，实际探针一次都没跑到断言。现在统一用 file:// URL，
 *      并把“探针自身崩溃”单独记 PROBE_ERROR —— 崩溃不再算杀死。
 *   2) 变异体不再只复制单个文件到 tmp（相对 import 会断），改为整树复制 ai/。
 *   3) M1 改判 severity 字段（ok 只反映 findings 数量，改 severity 它察觉不到）；
 *      M7 用真实 core 生成证据链、用变异 attest 验证签名；M11 判错误码
 *      （只看“是否抛错”会被 bookRootOf 的第二道 PATH_ESCAPE 兜住而误判存活）。
 *
 * 探针约定：变异被检出 → exit 3；变异存活 → exit 0；任何其它退出码 = PROBE_ERROR。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = process.env.OCB_REPO ? path.resolve(process.env.OCB_REPO) : process.cwd()
const CORE = path.join(REPO, 'ai/one-click-book/core.mjs')
const OUT = process.env.OCB_MUT_OUT ? path.resolve(process.env.OCB_MUT_OUT) : path.join(REPO, 'reports/quality-gates-mutation.json')
const THRESHOLD = 0.8

const MUTANTS = [
  {
    id: 'M1-placeholder-severity',
    file: 'ai/one-click-book/core.mjs',
    find: "if (PLACEHOLDER_RE.test(text)) findings.push({ code: 'PLACEHOLDER', severity: 'critical'",
    replace: "if (PLACEHOLDER_RE.test(text)) findings.push({ code: 'PLACEHOLDER', severity: 'low'",
    probe: `import(__MUT__).then((core) => {
      const qa = core.qaChapter({ chapter: { id: '001', title: 'T', must_include: [], word_range: [0, 999] }, text: '# T\\n\\n这里有 {{占位}}。', bible: {} });
      const finding = qa.findings.find((item) => item.code === 'PLACEHOLDER');
      if (!finding || finding.severity !== 'critical') process.exit(3);
    })`,
  },
  {
    id: 'M2-quality-gate-invert',
    file: 'ai/one-click-book/core.mjs',
    find: 'return { ok: failures.length === 0, failures }',
    replace: 'return { ok: failures.length !== 0, failures }',
    probe: `import(__MUT__).then((core) => {
      const v = core.evaluateQualityGates({ mutationRan: false, testsPassed: true, securityPassed: true, evidenceChainOk: true });
      if (v.ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M3-word-short-check-removed',
    file: 'ai/one-click-book/core.mjs',
    find: "if (count < chapter.word_range[0]) findings.push({ code: 'WORD_TOO_SHORT'",
    replace: "if (false) findings.push({ code: 'WORD_TOO_SHORT'",
    probe: `import(__MUT__).then((core) => {
      const qa = core.qaChapter({ chapter: { id: '001', title: 'T', must_include: [], word_range: [100, 200] }, text: '# T\\n\\n短。', bible: {} });
      if (!qa.findings.some((item) => item.code === 'WORD_TOO_SHORT')) process.exit(3);
    })`,
  },
  {
    id: 'M4-export-approval-removed',
    file: 'ai/one-click-book/core.mjs',
    find: 'if (!approvals?.export) {',
    replace: 'if (false) {',
    probe: `import(__MUT__).then((core) => {
      let threw = false;
      try { core.exportBook({ bookDir: process.cwd(), title: 'T', chapters: [], approvals: {} }); } catch { threw = true; }
      if (!threw) process.exit(3);
    })`,
  },
  {
    id: 'M5-chain-prev-check-removed',
    file: 'ai/one-click-book/core.mjs',
    find: "if (entry.prev !== prev) return { ok: false, index: i, reason: 'prev-mismatch' }",
    replace: "if (false) return { ok: false, index: i, reason: 'prev-mismatch' }",
    probe: `import(__MUT__).then((core) => {
      const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys)
        : (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])])) : value);
      const a = core.appendEvidence([], { stage: 'A' })[0];
      const b = { stage: 'B', prev: 'bogus' };
      b.hash = core.sha256(JSON.stringify(sortKeys(b)));
      if (core.verifyEvidenceChain([a, b]).ok !== false) process.exit(3);
    })`,
  },
  {
    id: 'M6-egress-check-disabled',
    file: 'ai/one-click-book/egress.mjs',
    find: 'if (!ok) throw new EgressDeniedError(host)',
    replace: 'if (false) throw new EgressDeniedError(host)',
    probe: `import(__MUT__).then((mod) => {
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
    probe: `Promise.all([import(__MUT__), import(__CORE__), import('node:os')]).then(([attest, core, os]) => {
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
    probe: `Promise.all([import(__MUT__), import('node:fs'), import('node:os'), import('node:path')]).then(([core, fs, os, path]) => {
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
    probe: `import(__MUT__).then((core) => {
      if (core.forbiddenSourceReason('/tmp/ws/.env') !== 'dotfile') process.exit(3);
    })`,
  },
  {
    id: 'M10-completion-evidence-check-disabled',
    file: 'ai/one-click-book/core.mjs',
    find: "if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) missing.push('no-observed-evidence')",
    replace: "if (false) missing.push('no-observed-evidence')",
    probe: `import(__MUT__).then((core) => {
      const v = core.completionVerdict({ evidenceRefs: [], gates: [{ ok: true }], chain: [] });
      if (v.ok !== false || !v.missing.includes('no-observed-evidence')) process.exit(3);
    })`,
  },
  {
    id: 'M11-book-id-validation-disabled',
    file: 'ai/one-click-book/books.mjs',
    find: 'if (!isValidBookId(id)) {',
    replace: 'if (false) {',
    probe: `import(__MUT__).then((books) => {
      let code = null;
      try { books.bookRootOf('/tmp/books', '../escape'); } catch (error) { code = error.code; }
      if (code !== 'INVALID_BOOK_ID') process.exit(3);
    })`,
  },
  {
    id: 'M12-publish-hash-check-disabled',
    file: 'ai/one-click-book/job.mjs',
    find: 'if (!deliverable || expected !== approvalHash) {',
    replace: 'if (!deliverable) {',
    probe: `Promise.all([import(__MUT__), import('node:fs'), import('node:os'), import('node:path')]).then(([job, fs, os, path]) => {
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

const results = []
for (const mutant of MUTANTS) {
  const moduleFile = mutant.file ? path.join(REPO, mutant.file) : CORE
  const moduleSource = fs.readFileSync(moduleFile, 'utf8')
  if (!moduleSource.includes(mutant.find)) {
    results.push({ id: mutant.id, verdict: 'INVALID_MUTANT', detail: '变异点未找到（源码已变，需同步更新 mutation 定义）' })
    continue
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocb-mut-'))
  // 整树复制 ai/：变异模块里的相对 import（./core.mjs、../http/...）必须仍然解析。
  fs.cpSync(path.join(REPO, 'ai'), path.join(dir, 'ai'), { recursive: true })
  const target = path.join(dir, 'ai', path.relative(path.join(REPO, 'ai'), moduleFile))
  fs.writeFileSync(target, moduleSource.replace(mutant.find, mutant.replace))
  const probe = mutant.probe
    .replaceAll('__MUT__', JSON.stringify(pathToFileURL(target).href))
    .replaceAll('__CORE__', JSON.stringify(pathToFileURL(CORE).href))
  let verdict = 'SURVIVED'
  let detail = ''
  try {
    // cwd 指向临时副本：被变异代码（如 M4 取消导出审批）产生的副作用不落进仓库。
    execFileSync(process.execPath, ['-e', probe], { stdio: 'pipe', timeout: 30_000, cwd: dir })
  } catch (error) {
    if (error?.status === 3) verdict = 'KILLED'
    else {
      verdict = 'PROBE_ERROR'
      detail = String(error?.stderr ?? error?.message ?? '').slice(0, 300)
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  results.push({ id: mutant.id, verdict, detail })
}

const killed = results.filter((item) => item.verdict === 'KILLED').length
const invalid = results.filter((item) => item.verdict === 'INVALID_MUTANT').length
const probeErrors = results.filter((item) => item.verdict === 'PROBE_ERROR').length
const score = results.length === 0 ? 0 : killed / results.length
const report = {
  schema_version: '1.0.0',
  generated_at: new Date().toISOString(),
  target: 'ai/one-click-book/{core,egress,attest,books,job}.mjs',
  threshold: THRESHOLD,
  mutation_ran: true,
  mutants: results.length,
  killed,
  invalid,
  probe_errors: probeErrors,
  score: Number(score.toFixed(3)),
  pass: invalid === 0 && probeErrors === 0 && score >= THRESHOLD,
  results,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ok: report.pass, score: report.score, killed, mutants: results.length, invalid, probe_errors: probeErrors }) + '\n')
process.exit(report.pass ? 0 : 1)
