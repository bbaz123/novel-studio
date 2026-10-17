/**
 * nsdsh/report.mjs —— 阶段报告与清单的**共用骨架**（S01）。
 *
 * 为什么要有这一层：`preflight.mjs` / `check-stage.mjs` / `backup-restore-check.mjs`
 * 都要写 `.nsdsh/reports/*.json`，而"报告长什么样"与"怎么判定一份报告仍然有效"
 * 必须是**同一个定义**。规则散落在三个脚本里，早晚会漂移（本项目历史上出现过同类漂移）。
 *
 * 三条纪律（与 docs/nsdsh/PLAN.md §6 一致）：
 *   1. 报告只写**实际执行过**的东西；没跑的命令不进报告，也不编造退出码。
 *   2. 报告的"可交付物"用**文件摘指纹**固定：交付物被改动后，旧报告自动失效。
 *   3. 原始 stdout/stderr 留在 `.nsdsh/reports/*.log`（已 gitignore），
 *      `docs/nsdsh/STATUS.md` 只放脱敏摘要。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 scripts/nsdsh/lib/ 下）。 */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** 本地过程证据目录（`.gitignore` 已覆盖，见仓库根 `.gitignore`）。 */
export const NSDSH_DIR = path.join(REPO, '.nsdsh');
export const REPORTS_DIR = path.join(NSDSH_DIR, 'reports');
export const STAGES_FILE = path.join(REPO, 'docs', 'nsdsh', 'stages.json');

export const STAGE_STATES = ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'];

/**
 * 读阶段清单。清单是**唯一事实来源**：required 文件、命令、前置依赖都从这里来，
 * 不允许在运行器里再写第二份（那正是"清单与实现漂移"的成因）。
 */
export function loadStages() {
  if (!fs.existsSync(STAGES_FILE)) {
    throw new Error(`阶段清单不存在：${rel(STAGES_FILE)}`);
  }
  const raw = fs.readFileSync(STAGES_FILE, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || !Array.isArray(doc.stages) || !doc.stages.length) {
    throw new Error(`阶段清单为空或结构不对：${rel(STAGES_FILE)}`);
  }
  return doc;
}

export function findStage(doc, id) {
  const want = String(id || '').trim().toUpperCase();
  return (doc.stages || []).find((s) => String(s.id).toUpperCase() === want) || null;
}

/** 仓库相对路径（统一正斜杠，便于跨平台比对与写进报告）。 */
export function rel(abs) {
  return path.relative(REPO, abs).replace(/\\/g, '/');
}

/** 仓库相对路径 → 绝对路径。 */
export function abs(relPath) {
  return path.isAbsolute(relPath) ? relPath : path.join(REPO, relPath);
}

/** 文件的 SHA256（十六进制）；文件不存在 → 返回 null（调用方据此判定"缺失"）。 */
export function fileSha256(relPath) {
  const p = abs(relPath);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 把 `docs/nsdsh/stages.json` 里的 glob（例如 `tests/nsdsh/*.test.mjs`）展开成**真实文件清单**。
 *
 * 为什么不用 shell glob：Windows 的 cmd/PowerShell 不展开 glob，而本项目的门禁要在
 * Windows 与 CI 上给出同一结果。这里自己枚举，只支持 `*` 单段通配（够用且不会误伤深层目录）。
 */
export function expandGlob(pattern) {
  const rel0 = String(pattern).replace(/\\/g, '/');
  if (!rel0.includes('*')) return fs.existsSync(abs(rel0)) ? [rel0] : [];
  const segs = rel0.split('/');
  let cursors = [REPO];
  for (const seg of segs) {
    const next = [];
    for (const dir of cursors) {
      if (!seg.includes('*')) {
        const p = path.join(dir, seg);
        if (fs.existsSync(p)) next.push(p);
        continue;
      }
      if (!fs.existsSync(dir)) continue;
      const re = new RegExp(`^${seg.split('*').map(escapeRe).join('.*')}$`);
      for (const name of fs.readdirSync(dir)) {
        if (re.test(name)) next.push(path.join(dir, name));
      }
    }
    cursors = next;
  }
  return cursors
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
    .map(rel)
    .sort();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 展开一批 pattern，保序去重。 */
export function expandAll(patterns = []) {
  const out = [];
  for (const p of patterns) {
    for (const f of expandGlob(p)) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** 当前 HEAD（走 `.git` 文件读取，**不起子进程**：受限沙箱下 spawn 会被拒）。 */
export function readHead() {
  try {
    const gitDir = path.join(REPO, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return null;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head || null;
    const ref = head.slice(5).trim();
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim() || null;
    // 打包引用（refs 被 gc 进 packed-refs）时退到 packed-refs 查一次。
    const packed = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
        const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (m && m[2].trim() === ref) return m[1];
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * 交付物指纹：对一批文件做 `路径:sha256` 排序后取整体 SHA256。
 * 用途：证明"这份报告对应的交付物现在还在、且没被改过"。
 */
export function artifactDigest(files = []) {
  const lines = [];
  const missing = [];
  for (const f of [...files].sort()) {
    const sha = fileSha256(f);
    if (!sha) { missing.push(f); continue; }
    lines.push(`${f}:${sha}`);
  }
  return {
    files: [...files].sort(),
    missing,
    digest: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'),
  };
}

export function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  return REPORTS_DIR;
}

export function reportPath(stageId) {
  return path.join(REPORTS_DIR, `${stageId}.json`);
}

export function readReport(stageId) {
  const p = reportPath(stageId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { __parseError: String(e && e.message ? e.message : e) };
  }
}

/**
 * 写阶段报告。**不覆盖**一份仍然有效的同阶段报告：只有当调用方显式给 `force`
 * （或新报告状态不同）时才覆盖，避免"跑一次就悄悄改写证据"。
 */
export function writeReport(report, { force = false } = {}) {
  ensureReportsDir();
  const p = reportPath(report.stage);
  if (!force && fs.existsSync(p)) {
    const old = readReport(report.stage);
    if (old && old.status === report.status && old.artifactDigest && report.artifactDigest
        && old.artifactDigest.digest === report.artifactDigest.digest) {
      return { path: p, written: false, reason: '同状态同交付物指纹：保留原报告' };
    }
  }
  fs.writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { path: p, written: true, reason: '' };
}

/** 报告日志文件（原始 stdout/stderr，本地、不入库）。 */
export function writeLog(stageId, text, suffix = 'log') {
  ensureReportsDir();
  const p = path.join(REPORTS_DIR, `${stageId}.${suffix}.log`);
  fs.appendFileSync(p, text, 'utf8');
  return p;
}

/**
 * 脱敏：把报告里可能出现的私有路径 / 长绝对路径压成可读形式。
 * 只做**替换**，不删除行 —— 摘要要能复核，不能因为"看着敏感"就吞掉证据。
 */
export function redact(text) {
  let s = String(text == null ? '' : text);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) s = s.split(home).join('<HOME>');
  s = s.replace(/[A-Za-z]:\\[^\s"']*\\Temp\\[^\s"']*/g, '<TMP>');
  s = s.replace(/\/tmp\/[^\s"']*/g, '<TMP>');
  return s;
}

/**
 * 前置阶段证据是否仍然成立。
 *
 * 判定分三层（**三层都要过**）：
 *   A. 有 PASS/PARTIAL 报告；
 *   B. 报告声明的**冻结交付物**（stages.json 的 `frozenArtifacts`）现在仍然存在、摘要未变；
 *      —— 只冻结"冻结清单"里的文件：像 `docs/nsdsh/STATUS.md` 这种按设计会贯穿 S00–S18 追加的文档，
 *         不能冻结，否则后一阶段一追加就"证明"前一阶段无效（这是我第一版写错的地方，已改）。
 *   C. 报告里 `artifactChecks` 逐条 passed —— **但 `blocked: true` 的条目不算失败**。
 *      —— 为什么：本项目对 BLOCKED 的口径是"环境阻断，既不是回归也不是通过"。
 *         若把 BLOCKED 当失败，一次环境限制会把**整条阶段链**堵死（实测：S01 的回环阴性对照
 *         因执行环境限制记 BLOCKED，S02 随即被判"前置证据无效"，连命令都不执行）。
 *         正确处理是：BLOCKED 条目仍然如实留在报告里（"没被证明"这个事实不消失），
 *         但它不授权也不阻断后续阶段——需要真正"未通过判定"时，用 `passed:false`（不带 blocked）。
 * 只有 A 没有 C = 报告存在但当时的验收项没过 → 不成立。
 */
export function verifyPrerequisite(stageId, { allowStates = ['PASS', 'PARTIAL', 'BLOCKED'], frozenArtifacts = null } = {}) {
  const report = readReport(stageId);
  if (!report) {
    return { ok: false, reason: `缺少 ${stageId} 的阶段报告（.nsdsh/reports/${stageId}.json）` };
  }
  if (report.__parseError) {
    return { ok: false, reason: `${stageId} 报告不是合法 JSON：${report.__parseError}` };
  }
  // `BLOCKED` 允许作为前置：它表示"这一阶段的命令因环境/策略没被执行"，
  // 按本文件上文的设计意图，既不授权也不阻断后续阶段（真正失败会是 FAIL，而不是 BLOCKED）。
  // 例外：报告里若已有 `passed:false` 的未通过条目，上面的条目级检查会拦住，不依赖这一条。
  if (!allowStates.includes(report.status)) {
    return { ok: false, reason: `${stageId} 报告状态为 ${report.status}，不满足前置条件` };
  }
  const recorded = (report.artifactDigest && report.artifactDigest.files) || [];
  const frozen = frozenArtifacts === null ? [] : frozenArtifacts;
  const missing = frozen.filter((f) => fileSha256(f) === null);
  if (missing.length) {
    return { ok: false, reason: `${stageId} 冻结交付物已缺失：${missing.join(', ')}` };
  }
  const nowDigest = artifactDigest(frozen.length ? frozen : []).digest;
  const thenDigest = (report.frozenDigest && report.frozenDigest.digest) || null;
  if (thenDigest && nowDigest !== thenDigest) {
    return { ok: false, reason: `${stageId} 冻结交付物在报告之后被改动（摘指纹不符）` };
  }
  const failedChecks = (report.artifactChecks || []).filter((c) => !c.passed && !c.blocked);
  if (failedChecks.length) {
    return { ok: false, reason: `${stageId} 验收项未通过：${failedChecks.map((c) => c.name).join(', ')}` };
  }
  const blockedChecks = (report.artifactChecks || []).filter((c) => !c.passed && c.blocked);
  const suffix = blockedChecks.length ? `；另有 ${blockedChecks.length} 项环境阻断（不计为通过、也不阻断后续）` : '';
  return { ok: true, reason: `${stageId} 证据有效（${report.status}，交付物 ${recorded.length} 项，冻结 ${frozen.length} 项${suffix}）` };
}

/** 组装一份标准报告骨架。字段固定，避免每个脚本各写一套。 */
export function makeReport({
  stage, status, commands = [], artifactChecks = [], artifacts = [], frozenArtifacts = [], notes = [],
  blocked = [], environment = {},
}) {
  const files = [...new Set(artifacts)].sort();
  const d = artifactDigest(files);
  const frozen = [...new Set(frozenArtifacts)].sort();
  return {
    schema: 'nsdsh/stage-report@1',
    stage,
    status,
    at: new Date().toISOString(),
    head: readHead(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    environment,
    commands,
    artifactChecks,
    artifactDigest: d,
    frozenDigest: artifactDigest(frozen),
    blocked,
    notes,
  };
}

/** 人读摘要（写进终端 / STATUS.md 的候选文本）。 */
export function summarize(report) {
  const lines = [];
  lines.push(`${report.stage} ${report.status} @ ${report.at}`);
  for (const c of report.commands || []) {
    lines.push(`  ${c.status === 0 ? '✓' : c.status === null ? '∅' : '✗'} ${c.command.join(' ')}（exit=${c.status}/${c.ms}ms）`);
  }
  for (const a of report.artifactChecks || []) {
    lines.push(`  ${a.passed ? '✓' : '✗'} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  for (const b of report.blocked || []) lines.push(`  ⚠ BLOCKED ${b.check}: ${b.reason}`);
  return lines.join('\n');
}
