import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, withTransaction, inTransaction } from './db.js';
import { isHarnessAvailable, isHarnessBuilt, runHarnessTaskWithProgress, modelSwitchLoad, harnessRuntimeInfo, setHarnessRepoOverride, looksLikeDshRepo } from './harness.js';
import { readZip } from './zip-reader.mjs';
import * as ImportGuard from './ai/import/guard.mjs';
import { htmlToPlain, plainText, plainTextHead, plainTextTail } from './text-utils.js';
import { notifyChange, getSemanticRecall, getLibraryRecall, libraryEnabled, semanticSearchMerge, semanticEnabled, ovEffectiveEnabled, setAppSetting, getAppSetting, syncWorkFull, removeWorkFromMemory, autoIndexExistingWorks, workDir, flushDebouncedSync, rebuildWorkMemory, replayWorkProjection, listProjectionAudit } from './openviking-sync.js';
import { revalidateRecallPayload } from './ai/openviking/recall-meta.mjs';
import { SHARED_LIBRARY_ROOT, checkLibraryShape } from './ai/library/library-roots.mjs';
import { LIBRARY_RECALL } from './ai/library/library-recall.mjs';
import { LIBRARY_INGEST } from './ai/library/library-doc.mjs';
import { scanLibraryDir, planLibraryImport, LIBRARY_INGEST_VERSION, LIBRARY_IGNORE_DIRS } from './ai/library/library-ingest.mjs';
import * as LibraryStore from './ai/library/store.mjs';
// A/C/D/E 方向驱动检索 + 索引层化（2026-09-29）：
//   · direction.mjs       —— 方向规范化/哈希/缓存键/外部版本串（四条路径的唯一口径）
//   · retrieval-stats.mjs —— 「资料召回次数」与「索引查询次数」分开记账（集成点③）
//   · library-index.mjs   —— D：知识库专用候选索引（词法候选只做发现，不放行）
//   · novel-index/*       —— E：资产索引 + 确定性检索计划（先汇总、后装配，集成点②）
import { normalizeDirection, directionHashOf, normalizeLibraryRecallPhase, normalizeDirectionSource, normalizeRequestId, directionAuditOf, contextCacheKeyOf, contextExternalVersionStringOf } from './ai/direction.mjs';
import { createRetrievalAccumulator, mergeLibraryStats, mergePlanStats, finalizeRetrievalStats } from './ai/retrieval-stats.mjs';
import * as LibraryIndex from './ai/library/library-index.mjs';
import * as NovelIndexStore from './ai/novel-index/store.mjs';
import { planAndExecute as runRetrievalPlan } from './ai/novel-index/plan.mjs';
import { layerContribution, recallHitContribution, omittedRecallContribution, dshContribution, dshBundleRuleEntries, buildContributionRecord, recordContributions, latestContributions, listContributions, findDuplicateLayer } from './ai/context/contributions.mjs';
import { editingRuleCatalog, resolveEditingSelection, editingSelectionToSettings, buildEditingRuleBlock } from './ai/editing/rules.mjs';
import { scanEditing } from './ai/editing/scan.mjs';
// R09：作者样文 → 结构化文风档案 → 三级作者意图。样文是**数据不是事实**：
// 本模块只写作者样文/档案/意图三张表，绝不写 story_facts / story_events / character_knowledge。
import * as AuthorStyle from './ai/style/store.mjs';
import * as BranchSandbox from './ai/branch/sandbox.mjs';
import * as BranchStore from './ai/branch/store.mjs';
import { STYLE_PROFILE_VERSION, METRIC_NOTES, SAMPLE_LIMITS, INTENT_TIERS, INTENT_PRIORITY, mergeIntents, buildIntentBlock, buildStyleEvidence, buildAuthorIntentLayer, isProfileStale, sampleSetHash } from './ai/style/author-profile.mjs';
import { ovClient, pendingQueueLength, reloadOpenVikingClient, setOpenVikingWorkshopConfig, getOpenVikingWorkshopConfig, openVikingConfigInfo, writeGlobalOpenVikingConfig, resolveOpenVikingConfig, DATA_DIR } from './openviking.js';
import { assemble as assembleContext } from './ai/context/assembler.mjs';
import { LAYERS as CONTEXT_LAYER_SPEC, capOf as contextCapOf, capOfId, entityCapOfId, recallGapReason } from './ai/context/layers.mjs';
// 确定性故事状态内核（novel-writing 插件阶段 · PHASE 1–14）。
// ⚠ 全部为**门控**接入：作品开关（story_state_config.enabled）关闭时，下面用到的
// 每一个函数都不会被调用——未开启的作品在上下文装配、预算与生成路径上与接入前完全一致。
import * as StoryState from './ai/story-state/index.mjs';
// 作者审批记录（2026-09-27，R02.2）：把"作者同意"变成服务端可校验的执行边界。
import * as Approvals from './ai/story-state/approval.mjs';
import * as ImportRebuild from './ai/import/rebuild.mjs';
import * as RebuildStore from './ai/import/rebuild-store.mjs';
import { createContextCache } from './ai/context/cache.mjs';
import { sha16, stableStringify } from './ai/story-state/hash.mjs';
import { checkCompression, checkNoInvention, inventionVerdict, mustKeepEntities, partitionByAppearance, agentMemoryUpdateVerdict, needsAgentMemoryGuard, AGENT_GUARD_MARKER } from './ai/memory-compress-guard.mjs';
import { buildCompressionPrompt } from './ai/memory-compress-prompt.mjs';
import { editDistance } from './ai/edit-distance.mjs';
// 2026-09-22 报告 · 第 1 步：审稿前的**零 token 确定性连续性预检**。
// 检查项与阈值立场写在 ai/continuity-guard.mjs 的文件头；这里只做接线与存储。
import { findingKey } from './ai/continuity-guard.mjs';
import { computeContinuityGuard, CONTINUITY_EXEMPTIONS_PREFIX, CONTINUITY_THRESHOLDS_PREFIX } from './ai/continuity-guard-source.mjs';
import { MODELS, EFFORTS, resolveModel, normalizeModel, normalizeEffort, effortForTier, LONG_AI_TIMEOUT_MS, policySnapshot } from './ai/policy.mjs';
import { log, initLogger, timed, timedAsync, queryLogs, clearLogs, flushLogs, readableErrorMessage, SLOW_REQUEST_MS, REMOTE_LAYERS } from './logger.js';
import {
  traceRequest, traceFn, traceEvent, traceAI, bumpTool, prepareTraced,
  startTracing, stopTracing, pingTracing, checkStaleTracing, traceState, traceNow, traceClockDomain,
  beginOperation, finishOperation, attachClientNodes, sweepIdleOperations,
  listOperations, getOperation, listToolCalls, sessionSummary,
  subscribeStream, listSessions, readSession, purgeSessions,
  flushTraceFile, traceConfigInfo, DEBUG_DIR
} from './debug-trace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
// 端口归一：与 ai/harness-env.mjs 的 `Number(port ?? base.PORT) || DEFAULT_PORT` 保持同一套语义——
// 此前这里是 `process.env.PORT || 3737`（不转数字），于是 PORT='abc' 时服务会拿字符串去 listen，
// 而下发给 dsh 子进程的 NOVELSTUDIO_BASE_URL 却是 3737：两边指向不同实例，且报错信息很难懂。
const PORT = Number(process.env.PORT) || 3737;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
    // 不再返回 Access-Control-Allow-Origin: *：本地工坊存有 API Key 与作品数据，
    // 任何浏览器页面跨源读取都会被浏览器 CORS 拦截；同源 UI 与 dsh 工具（服务端 fetch）不受影响。
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message || 'Internal error' });
}

// ── 模型侧写入的审批边界（2026-09-27，R02.2）──────────────────────────────────
// 通道区分不使用任何客户端自报的"我已获授权"布尔（那没有效力），而是看**请求来源通道**：
//   · 作者界面（浏览器同源）→ 不带 X-Novel-Agent 标记 → 按既有语义放行（作者本人就是授权）；
//   · dsh 插件工具（模型侧）→ 带 `X-Novel-Agent: 1` → 写入必须引用一条作者创建的、仍有效的审批。
// 审批的创建端点反过来**拒绝**带该标记的请求，模型无法给自己发审批。
const AGENT_HEADER = 'x-novel-agent';
function isAgentRequest(req) {
  return String(req.headers[AGENT_HEADER] || '').trim() === '1';
}

/**
 * 模型侧写入的统一前置：要求 approval_id 且校验/消费必须发生在调用方的事务里。
 * @returns {{ok:true, approval:object}|{ok:false, status:number, message:string}}
 */
function guardAgentWrite(req, { op, workId, chapterId = null, baselineHash = '', binding = {}, approvalId = '', consume = true }) {
  if (!isAgentRequest(req)) return { ok: true, approval: null, author: true };
  const id = String(approvalId || '').trim();
  if (!id) {
    return {
      ok: false, status: 403,
      message: `模型侧写入需要作者审批：请作者在工坊界面确认后生成一次性审批（op=${op}），再带 approval_id 重试。模型不能自行创建审批。`,
    };
  }
  const verdict = consume
    ? Approvals.consumeApproval(id, { op, workId, chapterId, baselineHash, binding, by: 'agent' })
    : (() => {
        const row = Approvals.getApproval(id);
        if (!row) return { ok: false, code: 'not_found', reason: '审批记录不存在' };
        if (row.status === 'active' && String(row.expires_at) <= new Date().toISOString()) {
          // 过期标记必须**提交**：这里在调用方事务之外（guard 先于 withTx/applyProposal 执行），
          // 否则"消费失败 → 事务回滚"会把 expired 状态字一起回滚，作者界面永远看到 active。
          Approvals.expireStaleApprovals();
          return { ok: false, code: 'expired', reason: `审批已于 ${row.expires_at} 过期，请作者重新确认` };
        }
        if (row.status !== 'active') return { ok: false, code: row.status, reason: `审批状态为 ${row.status}` };
        if (Number(row.work_id) !== Number(workId)) return { ok: false, code: 'work_mismatch', reason: '审批属于另一部作品' };
        if (String(row.op) !== String(op)) return { ok: false, code: 'op_mismatch', reason: `审批用于 ${row.op}` };
        // 绑定预检：换章 / 越界提案 / 换快照在**开工之前**就拒绝（原来只查 status/work/op，
        // 绑定不符要等事务内消费时才炸，接口按"逐项结果"返回 200，调用方容易误读成成功）。
        let want = {};
        try { want = JSON.parse(row.binding_json || '{}'); } catch { want = {}; }
        const problem = Approvals.checkBinding(String(row.op), want, binding || {});
        if (problem) return { ok: false, code: 'binding_mismatch', reason: problem };
        return { ok: true, approval: row };
      })();
  if (!verdict.ok) return { ok: false, status: 403, message: `审批校验未通过（${verdict.code}）：${verdict.reason}` };
  return { ok: true, approval: verdict.approval };
}

// 宿主侧事务包装（R03 的原子采纳与 R02.2 的"消费与写入同生共死"共用）。
// 实现放在 db.js：故事状态内核（store.mjs）也要用同一个深度裁决，嵌套用 SAVEPOINT。
function withTx(fn) {
  return withTransaction(fn);
}

// ---------- 投影 outbox（R03）────────────────────────────────────────────
// 「正文/状态提交」与「事务外副作用（OpenViking 同步 / Embedding）」之间的持久化边界：
// 记录与正文写在**同一个 SQLite 事务**里；提交后才由 worker 执行外部调用。进程若在
// commit 与投影之间崩溃，重启只凭 projection_outbox 就能恢复——而不是"提交后再 enqueue 一次"。
function enqueueProjectionInTx(workId, { chapterId = null, kind = 'ov_work_sync', payload = {}, dedupKey = '' } = {}) {
  const info = prepare(`INSERT OR IGNORE INTO projection_outbox (work_id, chapter_id, kind, dedup_key, payload_json) VALUES (?, ?, ?, ?, ?)`)
    .run(Number(workId) || 0, chapterId ? Number(chapterId) : null, String(kind || ''), String(dedupKey || ''), JSON.stringify(payload || {}));
  let id = Number(info.lastInsertRowid) || 0;
  if (Number(info.changes) !== 1 && dedupKey) {
    id = Number(prepare('SELECT id FROM projection_outbox WHERE dedup_key = ?').get(String(dedupKey))?.id) || 0;
  }
  return { id, created: Number(info.changes) === 1 };
}

function projectionRowPublic(r) {
  if (!r) return null;
  let payload = {};
  try { payload = JSON.parse(r.payload_json || '{}'); } catch (_) { payload = {}; }
  return {
    id: r.id, work_id: r.work_id, chapter_id: r.chapter_id, kind: r.kind,
    status: r.status, attempts: r.attempts, last_error: r.last_error,
    payload, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function listProjections({ workId = 0, status = '', limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (workId) { where.push('work_id = ?'); args.push(Number(workId)); }
  if (status) { where.push('status = ?'); args.push(String(status)); }
  const rows = prepare(`SELECT * FROM projection_outbox ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(200, Math.max(1, Number(limit) || 50)));
  return rows.map(projectionRowPublic);
}

function projectionSummary(workId = 0) {
  const rows = workId
    ? prepare('SELECT status, COUNT(*) AS n FROM projection_outbox WHERE work_id = ? GROUP BY status').all(Number(workId))
    : prepare('SELECT status, COUNT(*) AS n FROM projection_outbox GROUP BY status').all();
  const by = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) by[r.status] = Number(r.n) || 0;
  return by;
}

let projectionDrainRunning = false;
/** 事务外的 worker：只根据持久化状态推进，失败保留 failed + last_error（可见、可 retry）。 */
async function drainProjectionOutbox({ limit = 5 } = {}) {
  if (projectionDrainRunning) return { skipped: true, drained: 0 };
  projectionDrainRunning = true;
  const results = [];
  try {
    for (let i = 0; i < Math.max(1, Number(limit) || 5); i += 1) {
      const row = prepare(`SELECT * FROM projection_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT 1`).get();
      if (!row) break;
      prepare(`UPDATE projection_outbox SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(now(), row.id);
      try {
        let outcome = null;
        if (row.kind === 'ov_work_sync') outcome = await syncWorkFull(Number(row.work_id));
        else throw new Error(`未知投影类型：${row.kind}`);
        // syncWorkFull 用 ok:false 表达"没同步成功"（如集成被禁用 / 服务端不可达），不抛异常——
        // 这里必须把它当失败：把 skipped 记成 done 就是"假成功"，正是本任务书禁止的。
        if (outcome && outcome.ok === false) throw new Error(outcome.reason || '投影未完成');
        prepare(`UPDATE projection_outbox SET status = 'done', last_error = '', updated_at = ? WHERE id = ?`).run(now(), row.id);
        results.push({ id: row.id, ok: true });
      } catch (e) {
        const message = readableErrorMessage(e).slice(0, 500);
        prepare(`UPDATE projection_outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(message, now(), row.id);
        results.push({ id: row.id, ok: false, error: message });
        break; // 外部服务不可用时连续重试没有意义，保留 failed 等 retry / 下个周期
      }
    }
  } finally {
    projectionDrainRunning = false;
  }
  return { drained: results.length, results, pending: projectionSummary().pending, failed: projectionSummary().failed };
}

/** 把 failed 复位为 pending（作者界面的「恢复投影」入口 / 重启后的恢复路径）。 */
function retryFailedProjections({ workId = 0, id = 0 } = {}) {
  if (id) {
    const info = prepare(`UPDATE projection_outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'failed'`).run(now(), Number(id));
    return { reset: Number(info.changes) || 0 };
  }
  const info = workId
    ? prepare(`UPDATE projection_outbox SET status = 'pending', updated_at = ? WHERE status = 'failed' AND work_id = ?`).run(now(), Number(workId))
    : prepare(`UPDATE projection_outbox SET status = 'pending', updated_at = ? WHERE status = 'failed'`).run(now());
  return { reset: Number(info.changes) || 0 };
}

// 写请求的跨源防护：浏览器页面发起的 POST/PUT/DELETE 必须来自本机工坊页面
// （Origin 为 localhost/127.0.0.1）；不带 Origin 的非浏览器客户端（curl/dsh 工具）放行。
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
function isLocalRequest(req) {
  if (!MUTATING_METHODS.has(req.method || '')) return true;
  const origin = String(req.headers.origin || '');
  if (origin) {
    try {
      return isLocalHost(new URL(origin).hostname);
    } catch (_) {
      return false;
    }
  }
  // 无 Origin 的非浏览器客户端（curl/dsh 工具）：校验 Host 主机名，
  // 拒绝经非本机主机名到达的写请求（如 DNS rebinding 场景）。
  const hostHeader = String(req.headers.host || '');
  if (hostHeader) {
    const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return isLocalHost(host);
  }
  return true;
}

// 请求体上限：必须**大于**导入文件上限（24MiB）base64 后的体积（≈32MiB）+ JSON 包装，
// 否则「按文档允许的最大文件」永远发不进来——在读请求体阶段就被拒，根本走不到导入校验。
const MAX_BODY_BYTES = 36_000_000; // 36MB：容纳 24MiB 归档 base64 后的请求体；写请求有本机 Origin 校验兜底。
const MAX_DRAIN_BYTES = 96_000_000; // 超限请求最多再丢弃 96MB，避免被超大请求拖住连接
const DRAIN_DEADLINE_MS = 5000; // 丢弃请求体的时间上限：对端只声明不发时，最多等这么久

/**
 * 丢弃（不缓存）剩余请求体，直到读完 / 超过丢弃上限 / 超时。
 * 为什么要有它：请求体超限时若直接调用 req.destroy()，客户端只会看到 socket 被重置
 * （fetch failed / ECONNRESET），「请求体过大」这个**真实原因**根本回不去，排查方向会跑偏。
 * 先把请求体读完（有上限、有时限），再回 413，客户端才能拿到明确错误。
 */
function drainRequestBody(req, budget = MAX_DRAIN_BYTES) {
  return new Promise((resolve) => {
    let drained = 0;
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      resolve();
    };
    const onData = (chunk) => {
      if (done) return;
      drained += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (drained > budget) finish();
    };
    const onEnd = () => finish();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', finish);
    req.resume();
    timer = setTimeout(finish, DRAIN_DEADLINE_MS);
  });
}

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) {
    await drainRequestBody(req);
    const err = new Error(`请求体过大（声明 ${declared} 字节 > 上限 ${MAX_BODY_BYTES} 字节）`);
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  return new Promise((resolve, reject) => {
    // 按字节累计而非逐块拼接字符串：既让上限严格按字节生效，
    // 也避免跨 TCP 分块边界拆分的多字节 UTF-8 字符被逐块解码成乱码。
    const chunks = [];
    let received = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_BODY_BYTES) {
        settled = true;
        // 同 declared 分支：先把剩余请求体丢弃干净（有上限/时限）再拒，保证 413 能回到客户端。
        drainRequestBody(req).then(() => {
          const err = new Error(`请求体过大（已接收 ${received} 字节 > 上限 ${MAX_BODY_BYTES} 字节）`);
          err.code = 'PAYLOAD_TOO_LARGE';
          reject(err);
        });
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const data = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        const e = new Error('Invalid JSON');
        e.code = 'INVALID_JSON';
        reject(e);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// 读请求体失败时，把**真实原因**回给调用方。
// 为什么要有它：新加的环境类路由此前写的是 `readBody(req).catch(() => ({}))`，
// 于是"JSON 畸形"（INVALID_JSON）被报成"缺少 dir 字段"、"体积超限"（413）被降级成 400 ——
// 报错与真实原因无关，排查方向整个跑偏（本项目已经吃过一次这种亏）。
// 返回 { ok:false } 表示已回响应，调用方直接 return 即可。
async function readBodyOrError(req, res) {
  try {
    return { ok: true, body: await readBody(req) };
  } catch (e) {
    const tooLarge = e && e.code === 'PAYLOAD_TOO_LARGE';
    if (tooLarge) res.setHeader('Connection', 'close'); // 请求体没读完：明确关闭，不复用这条连接
    sendError(res, tooLarge ? 413 : 400, e && e.code === 'INVALID_JSON'
      ? '请求体不是合法 JSON'
      : ((e && e.message) || '请求体读取失败'));
    return { ok: false };
  }
}

function getPath(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return {
    pathname: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries())
  };
}

function parseId(str) {
  const id = Number(str);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function now() {
  return new Date().toISOString();
}

// 预编译语句缓存：相同 SQL 只 prepare 一次，减少重复解析开销，提升请求速度。
// debug-trace 的 prepareTraced 只包住「语句方法的调用」并记录 SQL 操作类型/表名/行数/耗时，
// 不记录绑定值（B 选项：不记正文）。未录制时包装层直接走原语句，零额外开销。
const stmtCache = new Map();
const STMT_CACHE_MAX = 500; // 动态 IN 列表会按占位符数量生成不同 SQL，需上限防止无限增长
const prepare = prepareTraced(function prepareStatement(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    // 🐞 运行追踪的分层机制：语句「准备」属于高频、低信息量的动作（缓存命中时几乎零耗时，
    // 一次操作可能发生上百次），逐条记节点只会淹没业务链路。因此这里只累计次数与总耗时
    // （bumpTool），配合真正逐条记录的 SQL 执行节点（prepareTraced），得到
    // 「主干逐条 + 高频聚合」的分层视图。未录制时 bumpTool 第一行即返回。
    const t0 = performance.now();
    if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.clear();
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
    bumpTool(`prepare 语句（缓存未命中）`, performance.now() - t0);
  } else {
    bumpTool('prepare 语句（缓存命中）', 0);
  }
  return stmt;
});

// ---------- 上下文装配缓存（v0.8.0 性能优化） ----------
// 所有写操作都会经 touchWork() 递增版本号，使缓存整体失效（单用户本地应用，全局失效足够）；
// 缓存只作用于 buildNovelContext 的（work, chapter, mode）结果，命中时跳过全部 SQL 装配。
//
// ⚠️ P2 曾补上 120 秒时间上界：版本号**只在写操作时前进**，而装配结果里有一层的可用性
// 与「写」无关——语义召回层。建索引完成、OpenViking 重新上线，都不会触发写操作，
// 于是「索引还没建完时算出的 no-hits」会被无限期缓存。
// 实证（P1 发现 F4）：同一个请求在重启实例前后分别返回 23,275 / 24,738 字，
// 召回层从「不存在」变成「存在」。
//
// 决策 D8-#7：那个 TTL 是**靠猜**（任意改动后最多陈旧 2 分钟）。而"索引完成"其实有明确的
// 可观测信号——`syncWorkFull` 成功后会写 `ov_indexed_at:<workId>`。现在把它纳入缓存版本：
// 索引一完成，相关缓存**立刻**失效；TTL 退回纯兜底（默认 10 分钟），只防"没人通知我们"。
// 实现见 ai/context/cache.mjs（独立模块，可离线单测，含阴性对照）。
const CONTEXT_CACHE_TTL_MS = Number(process.env.NOVELSTUDIO_CONTEXT_CACHE_TTL_MS) > 0
  ? Number(process.env.NOVELSTUDIO_CONTEXT_CACHE_TTL_MS)
  : 600000;

const contextCache = createContextCache({
  ttlMs: CONTEXT_CACHE_TTL_MS,
  // 外部可观测状态：影响装配结果、但不在进程内 dataVersion 里的外部状态。
  //   集成点①（2026-09-29）：除记忆库索引时间戳外，**资料索引与小说资产索引的版本号和
  //   schema 版本**也必须进入这里——否则「索引重建 / schema 升级后仍命中旧缓存」。
  //   版本读取都是单行主键查询（不重扫知识库）；新开关默认关闭时版本恒为常量，行为与基线一致。
  // 读不到（表缺失/异常）时退化为空串——即纯进程内版本，不会把功能整体打挂。
  externalVersionOf: (workId) => {
    try {
      const li = LibraryIndex.libraryIndexVersionInfo();
      return contextExternalVersionStringOf({
        ovIndexedAt: getAppSettingDb(`ov_indexed_at:${workId}`, ''),
        libraryIndexVersion: li.version,
        libraryIndexSchema: li.schema,
        novelIndexVersion: NovelIndexStore.novelIndexVersion(Number(workId) || 0),
        novelIndexSchema: NovelIndexStore.NOVEL_INDEX_SCHEMA_VERSION,
      });
    } catch { return ''; }
  },
});

const cacheGetContext = (key, workId) => contextCache.get(key, workId);
const cacheSetContext = (key, ctx, workId) => contextCache.set(key, ctx, workId);

function touchWork(workId) {
  // D8-#7：进程内数据变更 → 整体作废缓存（外部状态那部分由 cache.mjs 自行比对）。
  contextCache.invalidateAll();
  try {
    prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now(), workId);
  } catch (e) {
    log({ level: 'warn', layer: 'db', kind: 'db_error', message: `更新作品 updated_at 失败（work ${workId}）：${e.message}` });
  }
}

function getAppSettingDb(key, fallback = '') {
  const row = prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? String(row.value) : fallback;
}

function setAppSettingDb(key, value) {
  prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------- 工坊内工具设置（AI 设置页填写的三样东西） ----------
// 存 app_settings（本机 SQLite），启动时与每次保存时注入到对应模块：
//   ov_endpoint / ov_api_key → openviking.js 的凭证链第 2 层
//   dsh_repo                 → harness.js 的 dsh 仓库解析链第 2 层
// 为什么要"注入"而不是让那些模块自己读库：openviking.js / harness.js 都刻意不 import db
// （保持可离线单测、导入零副作用）。这里就是唯一的接线点——两处都在同一处集中，
// 避免"改了一处、另一处忘了读"。
const SETTING_OV_ENDPOINT = 'ov_endpoint';
const SETTING_OV_API_KEY = 'ov_api_key';
const SETTING_DSH_REPO = 'dsh_repo';

function applyWorkshopToolSettings() {
  const ov = setOpenVikingWorkshopConfig({
    endpoint: getAppSetting(SETTING_OV_ENDPOINT, ''),
    apiKey: getAppSetting(SETTING_OV_API_KEY, '')
  });
  const dshRepo = setHarnessRepoOverride(getAppSetting(SETTING_DSH_REPO, ''));
  // 凭证变了就必须重建客户端：否则界面显示"已保存"，真实请求还打旧地址/用旧 Key。
  const cfg = reloadOpenVikingClient();
  return { ov, dshRepo, endpoint: cfg.endpoint, endpoint_source: cfg.endpointSource };
}

// 插件安装位置检测：**从磁盘派生**，不写死路径假设。
// 实测布局：<dsh home>/profiles/<profile>/node_modules/novel-writing（junction → 本仓库）。
// 同时看专用 home（决策 B：~/.dsh-novel）与共享 home（~/.dsh，GUI 用）。
//
// ⚠️ home / profile 一律取自传入的 harnessRuntimeInfo()，不在这里另算一套、也不 import
// DSH_PROFILE/taskHomeInfo：两处各算一次必然分叉（而且第一版就踩了「用了没导入的符号」——
// node --check 只查语法，这类运行时引用错误只有真跑才会暴露）。
function detectPluginInstall(runtime = {}) {
  const pluginDir = path.join(__dirname, 'harness-plugins', 'novel-writing');
  const profile = runtime.profile || 'novel';
  let sourceReal = '';
  try { sourceReal = fs.realpathSync(pluginDir); } catch { /* 缺源码时下面 exists=false */ }
  const homes = [];
  const taskHome = (runtime.task_home && runtime.task_home.path) || '';
  for (const h of [taskHome, path.join(os.homedir(), '.dsh')]) {
    if (h && !homes.includes(h)) homes.push(h);
  }
  const installs = homes.map((home) => {
    const link = path.join(home, 'profiles', profile, 'node_modules', 'novel-writing');
    let exists = false;
    let pointsHere = false;
    let isLink = false;
    try {
      if (fs.existsSync(link)) {
        exists = true;
        const st = fs.lstatSync(link);
        // ⚠️ 只认**真正的链接**（Windows 上 junction 也走 isSymbolicLink 之外的分支，
        // 由下面的 points_here 用 realpath 比较来判"指向本仓库"）。
        // 曾经的写法是 `st.isSymbolicLink() || Boolean(st.isDirectory())` ——
        // 任何目录都为真，字段恒 true、语义失效（2026-09-18 第四轮重审抓到）。
        isLink = st.isSymbolicLink();
        pointsHere = Boolean(sourceReal) && fs.realpathSync(link).toLowerCase() === sourceReal.toLowerCase();
      }
    } catch { /* 读不到按未安装处理 */ }
    return { home, profile, path: link, exists, points_here: pointsHere, is_link: isLink };
  });
  const guiPreset = path.join(os.homedir(), '.dsh', '.agent-presets', 'novel-writing');
  return {
    dir: pluginDir,
    exists: fs.existsSync(path.join(pluginDir, 'package.json')),
    installs,
    installed: installs.some((i) => i.exists && i.points_here),
    gui_preset: { path: guiPreset, exists: fs.existsSync(guiPreset) }
  };
}

// 本机目录白名单：前端只能按**枚举键**请求打开，不能传路径——
// 传路径就等于给页面一个"打开任意位置"的接口，没必要也不该有。
function openFolderTargets() {
  return {
    dsh_repo: { label: 'dsh 仓库', dir: harnessRuntimeInfo().dir },
    plugin: { label: '创作插件源码', dir: path.join(__dirname, 'harness-plugins', 'novel-writing') },
    data: { label: '数据目录', dir: DATA_DIR },
    logs: { label: '日志目录', dir: path.join(DATA_DIR, 'logs') }
  };
}

// 在系统文件管理器里打开一个本机目录（Windows: explorer / macOS: open / Linux: xdg-open）。
// 等子进程的 'spawn' 事件再回报成功：否则"调用了 spawn"会被当成"真的打开了"——
// 而 spawn 失败（EPERM / 找不到命令 / 路径不存在）是异步报错，直接 return ok 就是一句谎。
async function openFolderInFileManager(dir) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (e) => done({ ok: false, cmd, error: e.message }));
      child.once('spawn', () => { child.unref(); done({ ok: true, cmd }); });
      setTimeout(() => done({ ok: false, cmd, error: '启动文件管理器超时（没有收到确认）' }), 3000);
    } catch (e) {
      done({ ok: false, cmd, error: e.message });
    }
  });
}

// OpenViking 地址归一化与校验。
// 小白最可能填的是「127.0.0.1:1933」这种没有协议的写法——直接存下来会变成一条
// 用不了的地址，而卡片只会显示"服务未响应"，看不出是自己少写了 http://。
// 所以：缺协议就补 http://，补完仍不是合法 URL 就明确拒绝（不写入）。
function normalizeOvEndpoint(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: true, value: '' }; // 空 = 清除，回到下层
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `地址格式不正确：${text}（示例：http://127.0.0.1:1933）` };
  }
  if (!url.hostname) return { ok: false, error: `地址缺少主机名：${text}` };
  return { ok: true, value: withScheme.replace(/\/+$/, '') };
}

// OpenViking 状态（AI 设置页「OpenViking 记忆库」卡的数据源）。
// 与 GET /api/novel/semantic 同源同口径：healthy / pending / 开关都取自同一批函数。
// 注：这里**总是探测一次**（ovClient.health()，4s 上限）。此前留了个 `probe=false` 参数，
// 但仓库里两个调用点都用默认值 —— 死参数会让下一个人以为存在"不探测的轻量查询"这条路
// （2026-09-18 第四轮重审删掉）。
async function openVikingStatusPayload() {
  const info = openVikingConfigInfo();
  const workshop = getOpenVikingWorkshopConfig();
  const healthy = await ovClient.health();
  return {
    ok: true,
    endpoint: info.endpoint,
    endpoint_source: info.endpoint_source,
    endpoint_source_label: info.endpoint_source_label,
    api_key_source: info.api_key_source,
    api_key_source_label: info.api_key_source_label,
    has_api_key: info.has_api_key,
    config_paths: info.config_paths,
    // 工坊内已保存的值：地址明文（本就是作者自己填的），Key 只回掩码。
    workshop: { endpoint: workshop.endpoint, api_key_mask: maskApiKey(workshop.apiKey), has_api_key: Boolean(workshop.apiKey) },
    semantic: { setting_enabled: semanticEnabled(), effective_enabled: ovEffectiveEnabled() },
    healthy,
    pending: pendingQueueLength(),
    work_root: workDir(0).replace(/\/0$/, '')
  };
}

// ---------- 通用 CRUD ----------
// 集中管理各资源的表名、字段、排序和默认值，避免多个地方重复定义。
const RESOURCE_CONFIG = {
  works: { table: 'works', order: 'id DESC', fields: ['title', 'description', 'author_note', 'default_chapter_words', 'total_chapters', 'story_structure', 'narrative_pov', 'style_positive'], defaults: { description: '', author_note: '', default_chapter_words: 2000, total_chapters: 0, story_structure: '', narrative_pov: '', style_positive: '' } },
  volumes: { table: 'volumes', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  plotlines: { table: 'plotlines', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'kind', 'summary', 'position'], defaults: { summary: '', position: 0 } },
  chapters: { table: 'chapters', order: 'position ASC, id ASC', fields: ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'title', 'summary', 'content', 'author_note', 'blueprint_json', 'target_words', 'context_character_ids', 'position'], defaults: { summary: '', content: '', author_note: '', blueprint_json: '', target_words: 0, context_character_ids: '', position: 0 } },
  categories: { table: 'categories', order: 'position ASC, id ASC', fields: ['work_id', 'name', 'color', 'position'], defaults: { color: '#6366f1', position: 0 } },
  terms: { table: 'terms', order: 'updated_at DESC, id DESC', fields: ['work_id', 'category_id', 'title', 'content', 'tags'], defaults: { content: '', tags: '' } },
  characters: { table: 'characters', order: 'name ASC', fields: ['work_id', 'name', 'identity', 'appearance', 'personality', 'background', 'status', 'avatar_color', 'mes_example', 'tags', 'system_prompt', 'aliases'], defaults: { identity: '', appearance: '', personality: '', background: '', status: '', avatar_color: '#8b5cf6', mes_example: '', tags: '', system_prompt: '', aliases: '' } },
  relations: { table: 'character_relations', order: 'id ASC', fields: ['work_id', 'from_character_id', 'to_character_id', 'relation', 'description'], defaults: { relation: '', description: '' } },
  plotline_characters: { table: 'plotline_characters', order: 'id ASC', fields: ['work_id', 'plotline_id', 'character_id', 'status', 'notes'], defaults: { status: '', notes: '' } },
  world_entries: { table: 'world_entries', order: 'position ASC, id ASC', fields: ['work_id', 'title', 'content', 'keywords', 'is_pinned', 'priority', 'position'], defaults: { content: '', keywords: '', is_pinned: 0, priority: 50, position: 0 } },
  creation_tasks: { table: 'creation_tasks', order: 'id DESC', fields: ['work_id', 'prompt', 'status', 'stages_json', 'result_json', 'error'], defaults: { prompt: '', status: 'running', stages_json: '{}', result_json: '{}', error: '' } },
  api_configs: { table: 'api_configs', order: 'id ASC', fields: ['name', 'base_url', 'api_key', 'model', 'temperature', 'max_tokens'], defaults: { base_url: 'https://api.deepseek.com', api_key: '', model: MODELS.fast, temperature: 0.8, max_tokens: 4096 } }
};

const NUMERIC_FIELDS = new Set([
  'work_id', 'volume_id', 'plotline_id', 'parent_id', 'category_id',
  'from_character_id', 'to_character_id', 'character_id', 'position',
  'is_pinned', 'priority', 'temperature', 'max_tokens',
  'default_chapter_words', 'total_chapters', 'target_words'
]);

function getList(resource, where) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  const keys = Object.keys(where);
  const sql = keys.length
    ? `SELECT * FROM ${cfg.table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')} ORDER BY ${cfg.order}`
    : `SELECT * FROM ${cfg.table} ORDER BY ${cfg.order}`;
  return prepare(sql).all(...keys.map((k) => where[k]));
}

// 表实际列名（PRAGMA 一次，按表缓存）。用途：把「这个过滤参数在这一张表里根本不存在」变成干净的 400，
// 而不是让 SQLite 的 `no such column: xxx` 原样回给客户端（作者看不懂，而且泄露库结构）。
// ⚠ 只做「列存在性」判断，不改变任何现有可用过滤的语义。
const TABLE_COLUMNS = new Map();
function tableHasColumn(resource, field) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return false;
  let cols = TABLE_COLUMNS.get(cfg.table);
  if (!cols) {
    cols = new Set(prepare(`PRAGMA table_info(${cfg.table})`).all().map((c) => String(c.name)));
    TABLE_COLUMNS.set(cfg.table, cols);
  }
  return cols.has(field);
}

function coerceValue(resource, field, value) {
  if (value !== undefined && value !== null) return value;
  const defaults = RESOURCE_CONFIG[resource]?.defaults || {};
  return field in defaults ? defaults[field] : null;
}

function normalizeValue(resource, field, value) {
  let v = coerceValue(resource, field, value);
  if (resource === 'api_configs' && field === 'model') {
    v = normalizeModel(v);
  }
  if (NUMERIC_FIELDS.has(field)) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

// 跨作品引用一致性校验：引用 id 必须存在且与目标 work_id 同作品，防止把 A 作品的数据写进 B 作品。
function validateOwnership(resource, data) {
  const wid = Number(data.work_id) || null;
  const check = (table, id, label) => {
    if (id === undefined || id === null || id === '') return;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return;
    const row = prepare(`SELECT work_id FROM ${table} WHERE id = ?`).get(nid);
    if (!row) throw new Error(`${label}不存在`);
    if (wid !== null && Number(row.work_id) !== wid) throw new Error(`${label}不属于该作品`);
  };
  if (resource === 'chapters') {
    check('volumes', data.volume_id, '卷');
    check('plotlines', data.plotline_id, '剧情线');
    check('chapters', data.parent_id, '父章节');
  } else if (resource === 'plotline_characters') {
    check('plotlines', data.plotline_id, '剧情线');
    check('characters', data.character_id, '角色');
  } else if (resource === 'relations') {
    check('characters', data.from_character_id, '角色A');
    check('characters', data.to_character_id, '角色B');
  } else if (resource === 'terms') {
    check('categories', data.category_id, '分类');
  }
}

// API Key 掩码：本地单用户应用虽受 CORS 保护，仍只向界面回显首尾片段，避免明文全量暴露。
function maskApiKey(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length <= 8 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function insertRow(resource, data) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  // D4：作品名称必填（后端兜底，前端同样拦截）
  if (resource === 'works' && !String(data.title ?? '').trim()) {
    throw new Error('作品名称不能为空');
  }
  validateOwnership(resource, data);
  const values = cfg.fields.map((f) => normalizeValue(resource, f, data[f]));
  const sql = `INSERT INTO ${cfg.table} (${cfg.fields.join(',')}) VALUES (${cfg.fields.map(() => '?').join(',')})`;
  const info = prepare(sql).run(...values);
  return Number(info.lastInsertRowid);
}

function updateRow(resource, id, data) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return null;
  // D4：编辑作品时也不允许把标题清空
  if (resource === 'works' && data.title !== undefined && !String(data.title ?? '').trim()) {
    throw new Error('作品名称不能为空');
  }
  const present = cfg.fields.filter((f) => data[f] !== undefined);
  // api_configs 的 api_key 传 null 表示「不修改」（掩码回显场景：用户未改动 key 时前端传 null）。
  if (resource === 'api_configs' && data.api_key === null) {
    const idx = present.indexOf('api_key');
    if (idx >= 0) present.splice(idx, 1);
  }
  if (present.length === 0) return 0;
  const isWorkless = resource === 'works' || resource === 'api_configs';
  const existing = isWorkless
    ? prepare(`SELECT id FROM ${cfg.table} WHERE id = ?`).get(id)
    : prepare(`SELECT work_id FROM ${cfg.table} WHERE id = ?`).get(id);
  if (!existing) return 0;
  const baseWorkId = data.work_id !== undefined
    ? Number(data.work_id) || null
    : (isWorkless ? null : Number(existing.work_id) || null);
  validateOwnership(resource, { ...data, work_id: baseWorkId });
  // P1-01：章节通用 PUT 同时推进 updated_at，使前端 _if_updated_at 乐观锁的锁值随每次保存前进；
  // 否则锁基准值永远相等，双窗口并发保存会静默覆盖（后写覆盖先写）而不是触发 409。
  const touchUpdatedAt = resource === 'chapters';
  const sql = `UPDATE ${cfg.table} SET ${present.map((f) => `${f} = ?`).join(', ')}${touchUpdatedAt ? ', updated_at = ?' : ''} WHERE id = ?`;
  const info = prepare(sql).run(
    ...present.map((f) => normalizeValue(resource, f, data[f])),
    ...(touchUpdatedAt ? [now()] : []),
    id
  );
  return Number(info.changes);
}

function deleteRow(resource, id) {
  const cfg = RESOURCE_CONFIG[resource];
  if (!cfg) return false;
  const info = prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).run(id);
  return Number(info.changes) > 0;
}

// ---------- search ----------
// 多关键词检索：全部关键词 AND 匹配；标题/名称命中权重最高（×3），标签/身份次之（×2），
// 内容命中兜底；按得分排序取前 20，片段围绕最早命中的关键词截取。
function search(q, workId) {
  const empty = { terms: [], chapters: [], characters: [], plotlines: [], world_entries: [], relations: [] };
  if (!q) return empty;
  const keywords = String(q).toLowerCase().split(/\s+/).map((k) => k.trim()).filter(Boolean).slice(0, 5);
  if (!keywords.length) return empty;

  const queryRows = (table, fields, extra = '') => {
    const conds = keywords.map((k) => `(${fields.map((f) => `${f} LIKE ?`).join(' OR ')})`).join(' AND ');
    const params = keywords.flatMap((k) => fields.map(() => `%${k}%`));
    if (workId) params.push(workId);
    const sql = `SELECT * FROM ${table} WHERE ${conds}${workId ? ` AND work_id = ?` : ''}${extra} LIMIT 200`;
    return prepare(sql).all(...params);
  };

  // 字段权重：名称/标题 ×3，标签/身份 ×2，其它 ×1；全词相等 > 前缀 > 包含。
  const scoreRow = (row, fields) => {
    let score = 0;
    for (const k of keywords) {
      for (const f of fields) {
        const v = String(row[f] || '').toLowerCase();
        if (!v) continue;
        if (v === k) score += 100 * (f === fields[0] ? 3 : 1);
        else if (v.startsWith(k)) score += 50 * (f === fields[0] ? 3 : 1);
        else if (v.includes(k)) score += 10 * (f === fields[0] ? 3 : 1);
      }
    }
    return score;
  };

  // 在纯文本里找所有关键词中最早出现的位置，围绕它截片段（多关键词时能定位到最相关的词）。
  const snippetAny = (text, fallback = '') => {
    const plain = plainText(text);
    if (!plain) return fallback ? plainText(fallback).slice(0, 60) : '';
    let best = -1; let bestLen = 0;
    for (const k of keywords) {
      const idx = plain.toLowerCase().indexOf(k);
      if (idx >= 0 && (best < 0 || idx < best)) { best = idx; bestLen = k.length; }
    }
    if (best < 0) return plain.slice(0, 60);
    const start = Math.max(0, best - 30);
    const len = Math.min(80, Math.max(30, bestLen + 40));
    return (start > 0 ? '…' : '') + plain.slice(start, start + len) + (start + len < plain.length ? '…' : '');
  };

  const rank = (rows, fields, sortKey) => rows
    .map((r) => ({ row: r, score: scoreRow(r, fields) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.row[sortKey] || '').localeCompare(String(b.row[sortKey] || ''), 'zh'))
    .slice(0, 20)
    .map((x) => x.row);

  const terms = rank(
    queryRows('terms', ['title', 'tags', 'substr(content,1,2000)']).map((t) => ({ ...t, type: 'term' })),
    ['title', 'tags', 'content'], 'title'
  ).map((t) => ({ ...t, snippet: snippetAny(t.content) }));

  const chapters = rank(
    queryRows('chapters', ['title', 'summary', 'substr(content,1,4000)', 'substr(blueprint_json,1,3000)']).map((c) => ({ ...c, type: 'chapter' })),
    ['title', 'summary', 'content', 'blueprint_json'], 'title'
  ).map((c) => ({ ...c, snippet: snippetAny(c.content, c.summary) }));

  const characters = rank(
    queryRows('characters', ['name', 'identity', 'personality', 'background', 'status']).map((c) => ({ ...c, type: 'character' })),
    ['name', 'identity', 'personality', 'background', 'status'], 'name'
  );

  const plotlines = rank(
    queryRows('plotlines', ['title', 'summary']).map((p) => ({ ...p, type: 'plotline' })),
    ['title', 'summary'], 'title'
  ).map((p) => ({ ...p, snippet: snippetAny(p.summary) }));

  // P3：人物关系此前不在检索范围内——而「人物关系」层会把描述截到 160 字，裁掉却查不回。
  // 关系行只存角色 id，这里补上双方姓名，检索结果才对模型可读。
  const charNames = new Map();
  if (workId) {
    for (const c of prepare('SELECT id, name FROM characters WHERE work_id = ?').all(workId)) charNames.set(c.id, c.name);
  }
  const relations = rank(
    queryRows('character_relations', ['relation', 'substr(description,1,2000)']).map((r) => ({
      ...r, type: 'relation',
      from_name: charNames.get(r.from_character_id) || `#${r.from_character_id}`,
      to_name: charNames.get(r.to_character_id) || `#${r.to_character_id}`
    })),
    ['relation', 'description'], 'relation'
  ).map((r) => ({ ...r, snippet: snippetAny(r.description) }));

  // P3：世界观词条此前**不在检索范围内**——而「激活的世界观设定」层是单次被裁最多的层
  // （压力数据实测单次裁掉 15,359 字）。裁剪掉却查不回，直接违反契约 I4。
  const worldEntries = rank(
    queryRows('world_entries', ['title', 'keywords', 'substr(content,1,2000)']).map((w) => ({ ...w, type: 'world_entry' })),
    ['title', 'keywords', 'content'], 'title'
  ).map((w) => ({ ...w, snippet: snippetAny(w.content) }));

  return { terms, chapters, characters, plotlines, world_entries: worldEntries, relations };
}

// 🐞 运行追踪：给关键词检索加函数级节点（耗时归因到具体函数，而不是只看 SQL 层）。
search = traceFn('search（关键词检索）', search, { kind: 'db', slowMs: 200 });

// ---------- AI ----------
function chatCompletionsUrl(baseUrl) {
  let base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  // 归一化：剥离可能存在的 /v1 与 /chat/completions 尾缀，再统一加回，保证拼接幂等，
  // 避免「base 以 /chat/completions 结尾时回退得到 .../chat/completions/v1/chat/completions」这类畸形地址。
  base = base.replace(/(\/v1)?\/chat\/completions$/i, '').replace(/\/v1$/i, '');
  return `${base}/chat/completions`;
}

// 模型名、已知模型表、思考强度白名单与归一化函数**全部来自 ai/policy.mjs**（P4 单点策略表）。
// 本文件不再自行定义这些取值——历史上它们在前端/后端/harness.js 各有一份，且注释与实现已经漂移。
// 这里保留同名局部绑定只是为了不动既有调用点；要改分工，改 policy.mjs。
const QUALITY_AI_MODEL = resolveModel('quality');
const DEEPSEEK_REASONING_EFFORTS = new Set(EFFORTS);
const normalizeReasoningEffort = normalizeEffort;

// 思考控制字段只有 DeepSeek 官方端点认。第三方 OpenAI 兼容服务可能因未知字段直接 400，
// 因此对自定义 base_url 不下发（模型名仍照常转发），避免把用户的第三方配置打挂。
function isDeepSeekEndpoint(baseUrl) {
  try {
    const host = new URL(String(baseUrl || 'https://api.deepseek.com')).hostname.toLowerCase();
    return host === 'deepseek.com' || host.endsWith('.deepseek.com');
  } catch (_) {
    return false;
  }
}

// 把归一化后的强度翻译成 OpenAI 格式请求体。注意设置层与线上格式取值不同：
// 强度用 reasoning_effort（low/high/max），关闭思考用 thinking.type=disabled
// —— `off` 并不是合法的 reasoning_effort 值（依据：DeepSeek API 文档《思考模式》）。
// 思考模式默认开启且 effort 默认 high，因此不传即为默认强度。
function applyReasoningEffort(body, effort) {
  if (effort === 'off') body.thinking = { type: 'disabled' };
  else if (effort) body.reasoning_effort = effort;
  return body;
}

// DeepSeek V4 API 当前允许的最大输出 token 数；用于把“无上限”映射到接口实际上限。
const MAX_OUTPUT_TOKENS = 393216;
// 直连单次请求的超时（思考模式 + 大 max_tokens 可能耗时较长，放宽避免中途 abort）。
// ⚠️ 它必须与 ai/policy.mjs 的 LONG_AI_TIMEOUT_MS **同源**：前端的直连长生成就是按
// longAiTimeout() 在等的（public/app.js 的 directAIWrite / runPipelineStage）。
// 若这里写死 30 分钟而策略表被调大，直连路径会在旧上限处静默 abort，
// 报错形态（AbortError）看起来像网络故障 —— 2026-09-18 第四轮重审把这条也收回单点。
const AI_REQUEST_TIMEOUT_MS = LONG_AI_TIMEOUT_MS;

// Host Contract 版本：插件阶段的稳定宿主契约（见 docs/host-contract.md 与 docs/host-contract.v1.json）。
// 为什么要有它：插件要能**在运行时**判断自己面对的是哪一版宿主契约，而不是靠"应该没变"的假设。
// 版本变化必须走主体变更流程（质量门 + 行为门 + 兼容门），不是随手加个字段；
// 三处（本常量 / fixture / 文档）由 .p1-baseline/test-host-contract.mjs 互锁，漂移会报红。
// 1.0.0 → 1.1.0：附加式扩展（门控层 story_state + 10 张新表 + 17 条状态端点 + 8 个插件工具）。
// 旧字段语义、预算常量、层顺序与默认生成路径**均未改变**——逐字节基线 50/50 复验过。
const HOST_CONTRACT_VERSION = '1.12.0';

// 调用 OpenAI 兼容的 Chat Completions 接口，带超时与 URL 自动回退。
async function callAI(config, messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('AI 请求缺少 messages 数组');
  }
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      throw new Error('messages 格式错误：每个消息必须包含 role 和 content');
    }
  }
  const base = String(config.base_url || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const rawMaxTokens = options.max_tokens ?? config.max_tokens ?? 4096;
  const maxTokens = Number.isFinite(Number(rawMaxTokens))
    ? Math.min(Math.max(1, Math.floor(Number(rawMaxTokens))), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  const body = {
    model: normalizeModel(config.model || MODELS.fast),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.8,
    max_tokens: maxTokens,
    stream: false
  };
  // 按需下发思考强度；未指定时沿 DeepSeek 默认（开启，effort=high）。
  const effort = normalizeReasoningEffort(options.reasoning_effort);
  if (effort && isDeepSeekEndpoint(config.base_url)) applyReasoningEffort(body, effort);

  const doPost = async (url) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!resp.ok) {
        const detail = data?.error?.message || data?.message || `AI request failed (${resp.status})`;
        const err = new Error(`${detail}（接口：${url}）`);
        err.status = resp.status;
        err.detail = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  };

  const primary = chatCompletionsUrl(base);
  let okModel = body.model;
  const doPostTraced = async (url) => {
    // ⚠️ t0 必须用 traceNow()（追踪专用单调时钟）。曾经这里写 Date.now()，
    // 与 debug-trace 的 hrtime 基准相减得到 -1.787e12ms 的负数耗时。
    const t0 = traceNow();
    try {
      const data = await doPost(url);
      // Token 采集：之前只取 content，provider 返回的 usage 被整个丢弃；
      // 这里把它挂到运行追踪的 AI 节点上（直连通道是唯一能拿到 usage 的通道）。
      okModel = data?.model || okModel;
      traceAI('callAI', {
        t0, usage: data?.usage || null, model: okModel, endpoint: url, stream: false,
        messageStats: messages.map((m) => ({ role: m.role, chars: typeof m.content === 'string' ? m.content.length : 0 })),
        result: data?.choices?.[0]?.message?.content ?? data
      });
      return data;
    } catch (e) {
      traceAI('callAI', { t0, usage: null, model: okModel, endpoint: url, stream: false, status: 'error', error: e });
      throw e;
    }
  };
  try {
    return await doPostTraced(primary);
  } catch (e) {
    // 归一化出另一种路径形态：/v1/chat/completions ↔ /chat/completions
    const alt = /\/v1\/chat\/completions$/i.test(primary)
      ? primary.replace(/\/v1\/chat\/completions$/i, '/chat/completions')
      : primary.replace(/\/chat\/completions$/i, '/v1/chat/completions');
    if (alt === primary) throw e;
    const looksLikeUrlIssue = e.status === 404 || e.status === 405 || /missing required messages|missing.*messages|缺少\s*messages|not found|invalid url/i.test(e.message || '');
    if (!looksLikeUrlIssue) throw e;
    traceEvent('note', 'callAI URL 回退重试', { code: { file: 'server.js', line: null, func: 'callAI' } });
    return doPostTraced(alt);
  }
}

// 流式调用 OpenAI 兼容 Chat Completions（SSE）：边生成边回调 onDelta(delta, fullText)。
// 返回完整拼接文本；与 callAI 共用 URL 形态回退；客户端断开由调用方通过 options.signal 中止。
async function callAIStream(config, messages, options = {}, onDelta) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('AI 请求缺少 messages 数组');
  }
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') {
      throw new Error('messages 格式错误：每个消息必须包含 role 和 content');
    }
  }
  const base = String(config.base_url || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  const rawMaxTokens = options.max_tokens ?? config.max_tokens ?? 4096;
  const maxTokens = Number.isFinite(Number(rawMaxTokens))
    ? Math.min(Math.max(1, Math.floor(Number(rawMaxTokens))), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  const body = {
    model: normalizeModel(config.model || MODELS.fast),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.8,
    max_tokens: maxTokens,
    stream: true,
    // Token 采集：OpenAI 兼容的流式接口默认不回 usage，需要显式索取（最后一个 chunk 带 usage、choices 为空）。
    // 只对官方 DeepSeek 端点下发，避免第三方兼容网关因未知字段拒绝整个写作请求。
    ...(isDeepSeekEndpoint(config.base_url) ? { stream_options: { include_usage: true } } : {})
  };
  // 流式成文是质量最敏感的路径，同样按需下发思考强度。
  const effort = normalizeReasoningEffort(options.reasoning_effort);
  if (effort && isDeepSeekEndpoint(config.base_url)) applyReasoningEffort(body, effort);

  let streamUsage = null; // 流式最后一个 chunk 带回的 usage（Token 采集用）
  const streamModel = body.model;

  const doStream = async (url) => {
    const controller = new AbortController();
    // 🧠 "模型正在思考"每个流只报一次：DeepSeek 的思考是以 `delta.reasoning_content` 分片下发的，
    // 此前这些帧被整个忽略 —— 于是长时间思考期间客户端一帧都收不到，界面上看起来就是卡死。
    // 只上报"进入思考"这一个相位，**不转发思考内容本身**（不外泄推理过程，也不增加传输量）。
    let thinkingNotified = false;
    const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (options.signal) options.signal.addEventListener('abort', onAbort);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.api_key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        const detail = data?.error?.message || data?.message || `AI request failed (${resp.status})`;
        const err = new Error(`${detail}（接口：${url}）`);
        err.status = resp.status;
        err.detail = data;
        throw err;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            // Token 采集：流式的 usage 出现在最后一个 chunk（choices 为空），此前被整个丢弃。
            if (evt?.usage) streamUsage = evt.usage;
            // 思考相位：这一帧带 reasoning_content 且还没报过就报一次（内容本身不转发）。
            const reasoning = evt?.choices?.[0]?.delta?.reasoning_content;
            if (!thinkingNotified && typeof reasoning === 'string' && reasoning) {
              thinkingNotified = true;
              if (typeof options.onThinking === 'function') options.onThinking();
            }
            const delta = evt?.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              full += delta;
              if (typeof onDelta === 'function') onDelta(delta, full);
            }
          } catch { /* 忽略心跳/非 JSON 行 */ }
        }
      }
      // 用量回传：调用方（成文流式端点）要把 usage 随 done 一起下发。
      // 其中 prompt_cache_hit_tokens 是"前缀缓存到底命不命中"的**唯一**实测来源，
      // reasoning_tokens 直接回答"思考吃掉了多少输出预算"——两者都不回传就永远测不了。
      if (streamUsage && typeof options.onUsage === 'function') options.onUsage(streamUsage);
      return full;
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  };

  const primary = chatCompletionsUrl(base);
  const doStreamTraced = async (url) => {
    // 同 doPostTraced：追踪耗时基准只能取 traceNow()。
    const t0 = traceNow();
    try {
      const full = await doStream(url);
      traceAI('callAIStream', {
        t0, usage: streamUsage, model: streamModel, endpoint: url, stream: true,
        messageStats: messages.map((m) => ({ role: m.role, chars: typeof m.content === 'string' ? m.content.length : 0 })),
        result: full,
        usage_unavailable_reason: streamUsage ? null : 'provider 未回 usage（非官方 DeepSeek 端点或流式未带 usage chunk）'
      });
      return full;
    } catch (e) {
      traceAI('callAIStream', { t0, usage: null, model: streamModel, endpoint: url, stream: true, status: 'error', error: e });
      throw e;
    }
  };
  try {
    return await doStreamTraced(primary);
  } catch (e) {
    if (options.signal?.aborted) throw e; // 客户端主动断开：不做 URL 回退重试
    const alt = /\/v1\/chat\/completions$/i.test(primary)
      ? primary.replace(/\/v1\/chat\/completions$/i, '/chat/completions')
      : primary.replace(/\/chat\/completions$/i, '/v1/chat/completions');
    if (alt === primary) throw e;
    const looksLikeUrlIssue = e.status === 404 || e.status === 405 || /missing required messages|missing.*messages|缺少\s*messages|not found|invalid url/i.test(e.message || '');
    if (!looksLikeUrlIssue) throw e;
    return doStreamTraced(alt);
  }
}

// POST /api/ai/write_stream：SSE 流式直连成文（质量优先模式）。
// 边生成边下发 delta 事件，结束下发 done 事件（含全文 + 确定性红线扫描报告，与 harness 通道同源）。
// 客户端断开自动中止上游请求。
async function handleAIWriteStream(req, res, body, config) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return sendError(res, 400, '缺少 messages');
  if (body.model) config.model = normalizeModel(body.model);
  const workId = Number(body.work_id) || null;
  const upstream = new AbortController();
  const onClose = () => upstream.abort();
  res.on('close', onClose);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ }
  };
  try {
    let full = '';
    // 用量（含缓存命中与思考 token）：随 done 一起下发，让客户端能把"这一轮把预算花在哪了"
    // 记进成文耗时账本。**纯附加字段**，老客户端忽略即可。
    let usage = null;
    const text = await callAIStream(config, messages, {
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      reasoning_effort: body.reasoning_effort,
      signal: upstream.signal,
      onUsage: (u) => { usage = u; },
      // 思考相位随流下发：客户端据此把"已 0 字"换成"模型正在思考…"。
      // 纯附加信号（老客户端忽略即可），不改任何生成参数。
      onThinking: () => send({ phase: 'thinking' })
    }, (delta, acc) => {
      full = acc;
      send({ delta });
    });
    let scan = null;
    if (body.scan !== false && workId) {
      const redlineRows = listRedlines(workId);
      const hits = scanAgainstRedlines(redlineRows, text);
      scan = { enabled: redlineRows.length > 0, total: hits.reduce((s, h) => s + h.count, 0), hits: hits.slice(0, 50) };
    }
    send({ done: true, text, scan, usage });
  } catch (e) {
    if (upstream.signal.aborted) {
      log({ level: 'warn', layer: 'ai', kind: 'ai_stream_aborted', message: '流式直连已被客户端中止' });
    } else {
      logAIError('write_stream', e, '/api/ai/write_stream');
      send({ error: readableErrorMessage(e) });
    }
  } finally {
    res.off('close', onClose);
    try { res.end(); } catch { /* 忽略 */ }
  }
}

function getConfigFromBody(body) {
  if (body.config_id !== undefined && body.config_id !== null && body.config_id !== '') {
    const id = Number(body.config_id);
    if (!Number.isInteger(id) || id <= 0) {
      const err = new Error('API 配置不存在或非法');
      err.status = 400;
      throw err;
    }
    const row = prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
    if (!row) {
      const err = new Error('API 配置不存在');
      err.status = 400;
      throw err;
    }
    return row;
  }
  return {
    base_url: body.base_url || 'https://api.deepseek.com',
    api_key: body.api_key || '',
    model: body.model || MODELS.fast,
    temperature: body.temperature ?? 0.8,
    max_tokens: body.max_tokens ?? 4096
  };
}

// ---------- AI error history ----------
// D3/D16：message 只保留一行可读错误（readableErrorMessage 见 logger.js，与 harness.js 共用）；
// 与统一日志库（app_logs）合并，30 分钟窗口内同 action + 同 message 去重。

function logAIError(action, error, endpoint = '') {
  log({
    level: 'error', layer: 'ai', kind: 'ai_error',
    message: readableErrorMessage(error),
    error,
    context: {
      action: action || 'unknown',
      endpoint: endpoint || '',
      error_code: String(error?.status || error?.detail?.error?.code || error?.code || '').slice(0, 200)
    },
    dedupMs: 30 * 60 * 1000
  });
}

function listAIErrors() {
  return prepare(`
    SELECT id, ts, message, stack, context
    FROM app_logs
    WHERE kind = 'ai_error'
    ORDER BY ts DESC, id DESC
    LIMIT 5
  `).all().map((row) => {
    let ctx = {};
    try { ctx = JSON.parse(row.context || '{}'); } catch (_) { /* 上下文损坏按空处理 */ }
    return {
      id: row.id,
      action: ctx.action || '',
      message: row.message,
      error_code: ctx.error_code || '',
      stack: row.stack,
      endpoint: ctx.endpoint || '',
      created_at: row.ts
    };
  });
}

// ---------- chapter manual save versions ----------
/**
 * @param {'manual'|'draft'} [kind] manual=手动保存/覆盖前备份的历史版本；draft=AI 生成稿草稿。
 *   草稿与历史版本同表但分区，列表与清理都按 kind 隔离，互不挤占。
 */
function saveChapterVersion(chapterId, title, summary, content, kind = 'manual') {
  const info = prepare(`
    INSERT INTO chapter_save_versions (chapter_id, title, summary, content, created_at, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chapterId, asString(title), asString(summary), asString(content), now(), kind === 'draft' ? 'draft' : 'manual');
  pruneChapterVersions(chapterId);
  return prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(Number(info.lastInsertRowid));
}

function listChapterVersions(chapterId) {
  return prepare(`
    SELECT id, chapter_id, title, summary, content, created_at
    FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'manual'
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all(chapterId);
}

/** 最近一份 AI 生成稿草稿（关闭结果弹窗后仍可取回）。 */
function getLatestDraft(chapterId) {
  const row = prepare(`
    SELECT id, chapter_id, title, content, created_at
    FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'draft'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(chapterId);
  if (!row) return null;
  return { ...row, chars: plainText(row.content).length };
}

function pruneChapterVersions(chapterId) {
  // 两个分区各自保留 10 份：草稿不能把历史版本挤掉，反之亦然。
  prepare(`
    DELETE FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'manual'
      AND id NOT IN (
        SELECT id FROM chapter_save_versions
        WHERE chapter_id = ? AND kind = 'manual'
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `).run(chapterId, chapterId);
  prepare(`
    DELETE FROM chapter_save_versions
    WHERE chapter_id = ? AND kind = 'draft'
      AND id NOT IN (
        SELECT id FROM chapter_save_versions
        WHERE chapter_id = ? AND kind = 'draft'
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      )
  `).run(chapterId, chapterId);
}

// ---------- AI 上下文（角色卡 / 世界观 / 作者注） ----------
// 简单去掉 HTML 标签，用于关键词匹配。
// ---------- AI 效果埋点（P5） ----------
// 契约里的结构化不变量只能回答「预算有没有超、内容能不能查回」，
// 回答不了「**上下文质量到底有没有变好**」。后者只能靠作者的真实行为信号：
// 一次成文用不用得上（采纳率）、采纳前改了多少（编辑距离）、送进去多少字（上下文成本）。
// 这张表刻意只记行为与规模，不记正文内容——避免把作品文本复制进一张分析表。
function recordAIEval({ workId, chapterId, action, channel, model, charsIn, charsOut, ms, editDistance, draftKey } = {}) {
  try {
    prepare(`
      INSERT INTO ai_eval_events (work_id, chapter_id, action, channel, model, chars_in, chars_out, ms, edit_distance, draft_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(workId) || null,
      Number(chapterId) || null,
      asString(action, 'generate') || 'generate',
      asString(channel, ''),
      asString(model, ''),
      Math.max(0, Math.round(Number(charsIn) || 0)),
      Math.max(0, Math.round(Number(charsOut) || 0)),
      Math.max(0, Math.round(Number(ms) || 0)),
      Number.isFinite(Number(editDistance)) && editDistance !== null && editDistance !== '' ? Math.max(0, Math.round(Number(editDistance))) : null,
      asString(draftKey, ''),
      now()
    );
    return true;
  } catch (e) {
    // 埋点失败绝不能影响创作：只记一条日志。
    log({ level: 'warn', layer: 'ai', kind: 'eval_record_failed', message: `AI 埋点写入失败：${e.message}`, error: e, dedupMs: 60000 });
    return false;
  }
}

/**
 * 编辑距离的测量点：**作者改动章节后保存**时（PUT /api/chapters/:id）。
 *
 * 为什么不在采纳那一刻量：结果弹窗里的正文是只读预览（`ai-apply-preview`），
 * 采纳写回正文必然等于草稿 → 恒为 0、没有信息量。真正有信息量的是"作者接着改了多少"。
 *
 * 草稿文本不从埋点表取——埋点表刻意**不记正文内容**。草稿本来就在
 * `chapter_save_versions(kind='draft')` 里（生成时就落了库），这里直接读它。
 *
 * 配对规则（都是刻意的、可解释的近似）：
 *   - 取该章节**最近一条尚未测量**的 `adopt` 行；
 *   - 只与**不晚于该采纳**的最近一份草稿配对（避免配到下一次生成的草稿）；
 *   - 测一次就写回 `edit_distance`，之后再次保存不会重复测量。
 *
 * 失败一律静默（与埋点同一条纪律：分析指标绝不能影响创作）。
 *
 * @returns {{distance:number, method:string}|null}
 */
function measureAdoptEditDistance(chapterId, finalContent) {
  try {
    const cid = Number(chapterId);
    if (!cid) return null;
    const finalText = plainText(finalContent);
    if (!finalText) return null;

    const pending = prepare(`
      SELECT id, created_at FROM ai_eval_events
      WHERE chapter_id = ? AND action = 'adopt' AND edit_distance IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(cid);
    if (!pending) return null;

    const draft = prepare(`
      SELECT content, created_at FROM chapter_save_versions
      WHERE chapter_id = ? AND kind = 'draft' AND created_at <= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(cid, pending.created_at);
    if (!draft || !String(draft.content || '').trim()) return null;

    const draftText = plainText(draft.content);
    if (!draftText) return null;

    const { distance, method } = editDistance(draftText, finalText);
    prepare('UPDATE ai_eval_events SET edit_distance = ? WHERE id = ?').run(distance, pending.id);
    log({
      level: 'info', layer: 'ai', kind: 'edit_distance_measured',
      message: `编辑距离已测量：${distance} 字（${method}）`,
      context: { chapter_id: cid, eval_id: pending.id, draft_chars: draftText.length, final_chars: finalText.length, method }
    });
    return { distance, method };
  } catch (e) {
    log({ level: 'warn', layer: 'ai', kind: 'edit_distance_failed', message: `编辑距离测量失败：${e.message}`, error: e, dedupMs: 60000 });
    return null;
  }
}

/**
 * 删作品时连带清理它的 AI 埋点（决策 D6·C-①）。
 *
 * 为什么需要显式删：`ai_eval_events` 建表时 `work_id` / `chapter_id` 写的是裸 INTEGER，
 * 没有外键、也就没有级联——而库里其它二十余张作品域表全都是 `REFERENCES works(id) ON DELETE CASCADE`。
 * 于是删作品后埋点行会留下：任何作品视角都够不到，而**全局聚合**（`/api/ai/eval` 不带 work_id）
 * 会把它们算进采纳率与平均编辑距离 → 指标被已不存在的作品带偏，且表无界增长。
 *
 * SQLite 不支持给已有表补外键（`ALTER TABLE` 做不到），所以这里用显式 DELETE，
 * 与"重建表迁移"相比无需动 schema、可回滚。
 *
 * ⚠️ 调用时机：必须在 `deleteRow('works', id)` **之前**——章节随作品级联删除后，
 * `chapter_id IN (SELECT ... FROM chapters ...)` 就查不到任何东西了。
 *
 * @returns {number} 实际删掉的行数（失败静默返回 0：埋点清理绝不能挡住删作品）
 */
function purgeEvalEventsOfWork(workId) {
  try {
    const r = prepare(`
      DELETE FROM ai_eval_events
      WHERE work_id = ?
         OR chapter_id IN (SELECT id FROM chapters WHERE work_id = ?)
    `).run(workId, workId);
    const n = Number(r.changes) || 0;
    if (n) log({ level: 'info', layer: 'ai', kind: 'eval_purged', message: `删除作品时连带清理 AI 埋点 ${n} 行`, context: { work_id: workId } });
    return n;
  } catch (e) {
    log({ level: 'warn', layer: 'ai', kind: 'eval_purge_failed', message: `AI 埋点清理失败（已忽略，不影响删除）：${e.message}`, error: e, dedupMs: 60000 });
    return 0;
  }
}

function summarizeAIEval(workId) {
  const where = workId ? 'WHERE work_id = ?' : '';
  const args = workId ? [workId] : [];
  const agg = prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN action = 'generate' THEN 1 ELSE 0 END) AS generations,
      SUM(CASE WHEN action = 'adopt'    THEN 1 ELSE 0 END) AS adopts,
      SUM(CASE WHEN action = 'discard'  THEN 1 ELSE 0 END) AS discards,
      AVG(CASE WHEN action = 'generate' THEN chars_in  END) AS avg_chars_in,
      AVG(CASE WHEN action = 'generate' THEN chars_out END) AS avg_chars_out,
      AVG(CASE WHEN action = 'generate' THEN ms        END) AS avg_ms,
      AVG(CASE WHEN action = 'adopt'    THEN edit_distance END) AS avg_edit_distance
    FROM ai_eval_events ${where}
  `).get(...args);
  const generations = Number(agg.generations) || 0;
  const adopts = Number(agg.adopts) || 0;
  const round = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    work_id: workId || null,
    total: Number(agg.total) || 0,
    generations,
    adopts,
    discards: Number(agg.discards) || 0,
    // 采纳率 = 采纳次数 / 生成次数。null 表示样本不足，不要用 0 假装有结论。
    adoption_rate: generations ? Number((adopts / generations).toFixed(3)) : null,
    avg_chars_in: round(agg.avg_chars_in),
    avg_chars_out: round(agg.avg_chars_out),
    avg_ms: round(agg.avg_ms),
    avg_edit_distance: round(agg.avg_edit_distance),
    note: '采纳率与编辑距离用于横向比较上下文质量的改动；样本少时不要下结论。'
  };
}

// HTML → 单行纯文本（搜索片段、字数口径用）。
// D5（2026-09-18）：实现**收敛到 text-utils.js 的 htmlToPlain**，这里只在它之上压平空白。
// 2026-09-24：plainText / plainTextHead / plainTextTail 三个函数的**本体**也搬进了 text-utils.js
// ——记忆压缩提示词的组装需要同一份实现（ai/memory-compress-prompt.mjs），而在本文件里
// 再抄一份正是上面那句注释一直在防的漂移。这里改为从 text-utils.js 导入，调用点一个没动。

// 获取作品的长期记忆摘要。
// 记忆行（含 id，供上下文溯源用）。分两层是为了**不新增查询**：`getStoryMemory` 返回文本，
// 需要溯源时用 `getStoryMemoryRow` 拿整行——两者共用同一条语句，不额外打库。
function getStoryMemoryRow(workId) {
  return prepare('SELECT id, summary FROM story_memories WHERE work_id = ?').get(workId) || null;
}
function getStoryMemory(workId) {
  return getStoryMemoryRow(workId)?.summary || '';
}

// 长期记忆超过该字数时标记 needs_compression，提示创作上下文里让 AI 优先压缩。
const MEMORY_COMPRESS_HINT = 1200;
// D8-#3：自动压缩的开关键（app_settings）。**默认关闭**——打开会真的产生 API 费用：
// 实测单次压缩模型产出 5.6k~22k 字（含推理，同样计费）。约束是"付费调用需先取得许可"。
const MEMORY_AUTO_COMPRESS_KEY = 'memory_auto_compress';
// 每个作品最多保留的历史版本数：超出自动剪除最旧的，防止 memory_versions 无限膨胀。
const MEMORY_VERSION_KEEP = 200;

// 保存作品的长期记忆摘要（git 式：每次变更自动写入 memory_versions 快照，可回滚）。
// 兼容旧调用 saveStoryMemory(workId, summary)；新调用可传 { source, note }。
function saveStoryMemory(workId, summary, opts = {}) {
  summary = asString(summary);
  const prev = getStoryMemory(workId);
  if (prev === summary && summary !== '') {
    return { unchanged: true, work_id: workId, summary };
  }
  const source = asString(opts.source, 'manual') || 'manual';
  const note = asString(opts.note, '');
  const tx = opts.tx === true;
  // 事务体：写当前摘要 + 版本快照 + 版本保留策略。深度感知事务（可嵌在宿主事务里）。
  const run = () => {
    prepare(`
      INSERT INTO story_memories (work_id, summary, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
    `).run(workId, summary, now());
    const info = prepare(`
      INSERT INTO memory_versions (work_id, summary, source, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workId, summary, source, note, now());
    // 版本保留策略：只留最近 MEMORY_VERSION_KEEP 个，最旧的多余版本剪除。
    prepare(`
      DELETE FROM memory_versions
      WHERE work_id = ? AND id NOT IN (
        SELECT id FROM memory_versions WHERE work_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(workId, workId, MEMORY_VERSION_KEEP);
    return {
      ok: true, work_id: workId, summary, version_id: Number(info.lastInsertRowid), source,
      needs_compression: summary.length > MEMORY_COMPRESS_HINT
    };
  };
  if (tx) return run();
  const result = withTransaction(run);
  touchWork(workId);
  return result;
}



// 实体清单压缩（`compactEntityLinesWithinBudget`）与逐行压缩（`compactLinesWithinBudget`）
// 已随记忆压缩提示词一起搬进 ai/memory-compress-prompt.mjs——它们只有那一个调用方，
// 而那一整段提示词的组装现在由该模块负责（见下方 compressStoryMemory）。


// 自动压缩作品内容为长期记忆摘要。
async function compressStoryMemory(workId, onChunk, signal) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) throw new Error('作品不存在');

  // 章节正文**完整**读取：出场判定必须覆盖全文，只看头尾会漏掉长章节中段首次出现的实体，
  // 从而把它排除在零损失护栏之外。该读取仅发生在显式记忆压缩/护栏路径，不进常规生成上下文。
  const chapters = prepare(`SELECT title, summary, content
    FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC`).all(workId);
  const characters = prepare('SELECT name, identity, personality, status FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const worlds = prepare('SELECT title, content FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);

  // 作品规模（正文总字数）：护栏的字数下限按它分档（2026-09-20 用户规格）。
  // 从已读入的行求和，不额外查库。
  const chapterChars = chapters.reduce((n, c) => n + String(c.content || '').length, 0);

  const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainText(c.content || '')}`).join('\n');

  // 决策 D8-#3（用户 2026-09-16 规格）：按"**在章节里出现过没有**"把角色分成两侧。
  // 实测作品 #2：角色表 23 个，章节里真正出现过的只有 5 个。
  // 旧做法拿整张表当"必须保留"，等于一边把 18 个没出场的人喂给模型、一边罚它写出来——
  // 既造成假阳性，又与"没出现的一个都不许出现"冲突。
  // 现在：**只把出场过的喂进提示词**，未出场的一律不提；护栏两侧各自核对。
  const cast = partitionByAppearance({ characters, worldEntries: worlds, chapterText });
  const appearedNames = new Set(cast.appearedChars.map((c) => c.name));
  const appearedWorldTitles = new Set(cast.appearedWorlds.map((w) => w.title));
  const characterText = characters.filter((c) => appearedNames.has(c.name))
    .map((c) => `【${c.name}】${c.identity || ''} ${c.personality || ''} ${c.status || ''}`).join('\n');
  const worldText = worlds.filter((w) => appearedWorldTitles.has(w.title))
    .map((w) => `【${w.title}】${w.content}`).join('\n');

  // ⚠️ 2026-09-24 修掉的真实缺陷（质量回归，不是重构）：下面这段原先引用
  // `c.content_head` / `c.content_tail` 两个**已经不存在的查询别名**——2026-09-21 把
  // 出场判定改成读整章正文时删掉了那两个 `substr(...) AS ...`，而提示词里的引用留在原地。
  // 后果是静默的：`undefined` 让「最近章节尾部」那一段**永远是空的**（只剩三个标题），
  // 缺摘要的章节在"全部章节摘要"里也只剩标题。而提示词开头写着"后为最近章节尾部"。
  // 压缩器于是只能靠摘要工作，可摘要对**正在写的新章**往往还是空的——最新剧情最可能被漏掉，
  // 且摘要读起来照样通顺、不会报错。
  // 现在整段组装搬进 ai/memory-compress-prompt.mjs：纯函数、离线可断言，
  // `.p1-baseline/test-memory-compress-prompt.mjs` 直接检查"最近几章的正文确实进了提示词"。
  const prompt = buildCompressionPrompt({ work, chapters, characterText, worldText });

  // 记忆压缩是「读得多、写得少」的摘要任务。
  // 质量优先：产出的长期记忆会喂给之后**每一章**的上下文，质量影响是累积的。
  // 2026-09-18 起"质量优先"由**思考强度**表达（模型与快档同为 V4.1 Flash，见 ai/policy.mjs 文件头）；
  // 此前这里刻意不指定强度、沿用 ~/.dsh/settings.yaml 全局设置——那在换模型之后就不再成立，
  // 因为"更贵的模型"这个质量信号已经没有了。
  // D8-#4：带进度上报（此前用无 onChunk 的入口，进了作业设施 tail 也是空的）；
  // 并透传 abort signal，否则作业的"取消"到不了子进程（会一直 running）。
  const output = await runHarnessTaskWithProgress(
    prompt,
    {
      timeout: LONG_AI_TIMEOUT_MS,
      model: QUALITY_AI_MODEL,
      reasoningEffort: effortForTier('quality') || undefined,
      signal
    },
    typeof onChunk === 'function' ? onChunk : undefined);

  // D8-#3：零损失护栏（**两侧**）。压缩是**有损**操作，而长期记忆会喂给之后每一章——
  // 丢一个角色或一条世界观，摘要读起来照样通顺，**不会报错**，是最难发现的一类损失。
  //   完整性：出场过的（主角+配角）一个都不许丢；且**字数下限随作品规模自适应**
  //           （2026-09-20 用户规格：长篇不能因为"名字都还在"就判为零损失——
  //            100 字摘要能把名字写全却丢光剧情线程/伏笔/角色状态）；
  //   无中生有：从未出场的**一个都不许冒出来**（用户 2026-09-16 规格）。
  const guard = checkCompression({
    compressed: output,
    mustKeep: mustKeepEntities({ characters: cast.appearedChars, worldEntries: cast.appearedWorlds }),
    // 规模从**已读入内存的章节行**求和，不额外查库（正文总字数决定下限档位）。
    storyChars: chapterChars,
  });
  const invention = checkNoInvention({
    compressed: output,
    mustNotMention: cast.absentChars.map((c) => c.name),
  });
  // 决策（用户 2026-09-16）：完整性**硬失败**（出场的一个都不许丢）；
  // "无中生有"**默认放行**——用户给的规格里"根据剧情需要出现"是允许，
  // 而"剧情需不需要"机器判不了。放行不等于不管：如实记日志（供事后核对），
  // 需要严格时用 NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1 改回拒绝。
  const inventionAction = inventionVerdict(invention.invented);
  if (!guard.ok || inventionAction === 'reject') {
    const reasons = [...guard.reasons, ...(inventionAction === 'reject' ? invention.reasons : [])];
    log({
      level: 'warn', layer: 'ai', kind: 'memory_compress_rejected',
      message: `记忆压缩被零损失护栏拒绝，**未落库**：${reasons.join('；')}`,
      context: {
        work_id: workId, length: guard.length,
        missing: guard.missing.slice(0, 20), invented: invention.invented.slice(0, 20),
        checked: guard.checked, absent_checked: invention.checked,
      }
    });
    const err = new Error(`压缩结果未通过零损失护栏（${reasons.join('；')}），已放弃本次压缩以免污染长期记忆。可重试。`);
    err.code = 'MEMORY_COMPRESS_GUARD';
    throw err;
  }
  if (inventionAction === 'allow') {
    // 放行但要留痕：这一类越界会被喂给之后每一章，看不见就等于没法事后发现。
    log({
      level: 'warn', layer: 'ai', kind: 'memory_compress_invented_allowed',
      message: `压缩结果提到了 ${invention.invented.length} 个未出场角色，按既定策略**放行**（未拦落库）`,
      context: { work_id: workId, invented: invention.invented.slice(0, 20), absent_checked: invention.checked }
    });
  }
  log({
    level: 'info', layer: 'ai', kind: 'memory_compress_ok',
    message: `记忆压缩通过零损失护栏（${guard.length} 字；出场实体 ${guard.checked} 个全保留，未出场 ${invention.checked} 个中 ${invention.invented.length} 个被提及但按策略放行）`,
    context: { work_id: workId, length: guard.length, checked: guard.checked, absent_checked: invention.checked, invented_count: invention.invented.length }
  });
  saveStoryMemory(workId, output, { source: 'compress' });
  return output;
}

// 🐞 运行追踪：长期记忆压缩是长任务（内含 AI 调用），单独成节点便于归因耗时。
compressStoryMemory = traceFn('compressStoryMemory（压缩长期记忆）', compressStoryMemory, { kind: 'fn', slowMs: 3000 });

// ---------- 模型自压缩的零损失护栏（D8-#3 续 · 2026-09-18）----------
// 上面那条护栏只保护**服务端自动压缩**。而插件人设教的恰恰是「模型自行把旧摘要+进展
// 压缩成 ≤800 字，再调 novel_memory_update 交上来」——**那条路此前没有护栏**：
// 模型丢掉一个角色照样静默落库，而这段记忆会喂给之后每一章，且摘要读起来照样通顺。
// 现在两条路共用同一份判据（`agentMemoryUpdateVerdict` 在 ai/memory-compress-guard.mjs），
// 靠工具显式标记来源（`guard:'agent'`）区分——**作者在界面手改不带标记，不受影响**。
// 判据读取章节正文做确定性出场扫描：只发生在模型自压缩写回时，不进 AI 计费路径。
function agentMemoryGuardOf(workId, summary) {
  const chapters = prepare(`SELECT title, summary, content
    FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC`).all(workId);
  const characters = prepare('SELECT name FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const worldEntries = prepare('SELECT title FROM world_entries WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const chapterText = chapters.map((c) => `【${c.title}】${c.summary || ''} ${plainText(c.content || '')}`).join('\n');
  // 作品规模一并传入：字数下限按它自适应（2026-09-20）。
  // 正文已在内存里，这里只是求和，不额外查库（实测 120 章规模下整条路径 ~8.7ms）。
  const storyChars = chapters.reduce((n, c) => n + String(c.content || '').length, 0);
  return agentMemoryUpdateVerdict({ characters, worldEntries, chapterText, summary, storyChars });
}

// ---------- 出场角色选择（评分制 · v0.8.0） ----------
// 解决旧实现的三个遗漏源：①兜底只取“按名字前 8”与剧情无关；②名字子串误命中、漏别名；
// ③新章节正文为空时只能靠标题/摘要碰运气。评分维度：剧情线关联 > 正文/摘要命中次数 >
// 蓝图·作者注·最近事件提及 > 最近章节摘要出场 > 人物关系网；兜底改为“最近出场优先”。
const SCENE_CHAR_CAP = 16;        // 出场角色卡数量上限
const SCENE_FALLBACK_COUNT = 8;   // 无命中信号时的兜底数量（最近出场优先，其次名字序）

// 名称出现次数统计：多字名称直接计数；单字 CJK 名称要求左右邻居不是 CJK 字符，
// 避免“云”命中“云彩/李云”这类子串误命中。别名与正式名同样处理。
function countNameHits(name, corpus) {
  const n = String(name || '');
  if (!n) return 0;
  const lower = n.toLowerCase();
  let count = 0;
  let idx = corpus.indexOf(lower);
  if (n.length >= 2) {
    while (idx !== -1) { count += 1; idx = corpus.indexOf(lower, idx + lower.length); }
    return count;
  }
  const isCJK = (ch) => /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch);
  while (idx !== -1) {
    const before = idx > 0 ? corpus[idx - 1] : '';
    const after = idx + 1 < corpus.length ? corpus[idx + 1] : '';
    if (!(isCJK(before) || isCJK(after))) count += 1;
    idx = corpus.indexOf(lower, idx + 1);
  }
  return count;
}

function namesOfCharacter(c) {
  return [c.name, ...String(c.aliases || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)];
}

// 评分制选择出场角色：返回 { sceneCharacters（按得分降序，含兜底）, scores: Map }。
// opts：{ plotlineId, corpus, extraTexts, recentSummaries }
function selectSceneCharacters(workId, opts = {}) {
  const all = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const scores = new Map();
  const add = (id, pts) => scores.set(id, (scores.get(id) || 0) + pts);
  const hitsOf = (c, text) => namesOfCharacter(c).reduce((sum, nm) => sum + countNameHits(nm, text), 0);

  // 1) 剧情线关联（最强信号）
  if (opts.plotlineId) {
    const rows = prepare('SELECT character_id FROM plotline_characters WHERE plotline_id = ? ORDER BY id ASC').all(opts.plotlineId);
    rows.forEach((r) => add(Number(r.character_id), 100));
  }
  // 1b) 作者在「上下文预览」面板手动强制带入的角色（章节级覆盖，最高优先）
  for (const id of opts.forceIds || []) add(Number(id), 1000);

  const corpus = String(opts.corpus || '').toLowerCase();
  const extraCorpus = String((opts.extraTexts || []).join(' ')).toLowerCase();
  const recentCorpus = String((opts.recentSummaries || []).join(' ')).toLowerCase();

  for (const c of all) {
    // 2) 正文/摘要命中：每命中 +12，封顶 60
    const mainHits = hitsOf(c, corpus);
    if (mainHits > 0) add(c.id, Math.min(mainHits * 12, 60));
    // 3) 蓝图/作者注/最近事件提及：每命中 +10，封顶 40
    const extraHits = hitsOf(c, extraCorpus);
    if (extraHits > 0) add(c.id, Math.min(extraHits * 10, 40));
    // 4) 最近章节摘要出场：每章 +8，封顶 24
    const recentHits = hitsOf(c, recentCorpus);
    if (recentHits > 0) add(c.id, Math.min(recentHits * 8, 24));
  }

  // 5) 关系网：与已有信号角色（剧情线/正文命中/蓝图提及，≥10 分）有直接关系的角色 +5/条，封顶 20
  const signaled = new Set([...scores.keys()].filter((id) => (scores.get(id) || 0) >= 10));
  if (signaled.size) {
    const relations = prepare('SELECT from_character_id, to_character_id FROM character_relations WHERE work_id = ?').all(workId);
    const linkCount = new Map();
    for (const r of relations) {
      if (signaled.has(r.from_character_id) && !signaled.has(r.to_character_id)) {
        linkCount.set(r.to_character_id, (linkCount.get(r.to_character_id) || 0) + 1);
      }
      if (signaled.has(r.to_character_id) && !signaled.has(r.from_character_id)) {
        linkCount.set(r.from_character_id, (linkCount.get(r.from_character_id) || 0) + 1);
      }
    }
    for (const [id, n] of linkCount) add(id, Math.min(n * 5, 20));
  }

  const ranked = all
    .map((c) => ({ c, s: scores.get(c.id) || 0 }))
    .sort((a, b) => b.s - a.s || String(a.c.name).localeCompare(String(b.c.name), 'zh'));

  const chosen = ranked.filter((r) => r.s > 0);
  if (chosen.length < SCENE_FALLBACK_COUNT) {
    const rest = ranked.filter((r) => r.s <= 0);
    chosen.push(...rest.slice(0, SCENE_FALLBACK_COUNT - chosen.length));
  }
  return { sceneCharacters: chosen.slice(0, SCENE_CHAR_CAP).map((r) => r.c), scores };
}

// 出场角色卡构建：逐卡截断、核心字段保底，避免“整层头部盲截”把靠后的角色整卡切掉。
// 长字段（背景/对话示例/系统提示/外貌/标签）分级压缩；即使预算耗尽，每张卡的名字/
// 身份/性格/当前状态核心信息必保。
// ⚠️ `cap` 刻意**不给默认值**：它的单点在 `layers.mjs` 的 `entityCap`，
// 调用方一律用 `entityCapOfId('characters')` 取值。早先这里写着 `cap = 4000`，
// 与调用处的 `4000`、规格里的 `entityCap: 4000` 构成三份拷贝。
function buildCharacterCards(chars, cap) {
  if (!Number.isFinite(cap)) throw new Error('buildCharacterCards 需要显式的实体上限（见 layers.mjs 的 entityCapOfId）');
  const FIELD_LABELS = [
    ['background', '背景', [500, 300, 150, 80, 0]],
    ['mes_example', '对话示例（学习其口吻）', [400, 200, 100, 0]],
    ['system_prompt', '角色系统提示', [400, 200, 100, 0]],
    ['appearance', '外貌', [400, 200, 100, 0]],
    ['tags', '标签', [200, 100, 0]]
  ];
  const coreOf = (c) => [
    `【${c.name}】`,
    c.identity ? `身份：${c.identity}` : '',
    c.personality ? `性格：${c.personality}` : '',
    c.status ? `当前状态：${c.status}` : ''
  ].filter(Boolean).join('\n');
  const cardOf = (c, level) => {
    const parts = [coreOf(c)];
    for (const [field, label, limits] of FIELD_LABELS) {
      const lim = limits[Math.min(level, limits.length - 1)];
      const v = String(c[field] || '').trim();
      if (lim > 0 && v) parts.push(`${label}：${v.slice(0, lim)}`);
    }
    return parts.join('\n');
  };
  const maxLevel = Math.max(...FIELD_LABELS.map(([, , limits]) => limits.length)) - 1;
  let level = 0;
  let text = chars.map((c) => cardOf(c, 0)).join('\n\n');
  while (text.length > cap && level < maxLevel) {
    level += 1;
    text = chars.map((c) => cardOf(c, level)).join('\n\n');
  }
  // 极端兜底：所有长字段已丢弃仍超限时，逐卡按均分预算截断（核心信息尽量保留）。
  if (text.length > cap && chars.length) {
    // 最后一级只移除可选长字段，绝不对整张卡做 slice，避免把靠后的角色核心信息切掉。
    const coreText = chars.map((c) => coreOf(c)).join('\n\n');
    if (coreText.length <= cap) {
      const optionalBudget = cap - coreText.length;
      const perOptional = Math.floor(optionalBudget / chars.length);
      let extra = optionalBudget - perOptional * chars.length;
      text = chars.map((c) => {
        const optional = FIELD_LABELS.map(([field, label]) => {
          const v = String(c[field] || '').trim();
          return v ? `${label}：${v}` : '';
        }).filter(Boolean).join('\n');
        const take = perOptional + (extra-- > 0 ? 1 : 0);
        return `${coreOf(c)}${take > 0 && optional ? `\n${optional.slice(0, take)}` : ''}`;
      }).join('\n\n');
    } else {
      // 核心字段本身已超实体预算：保留完整核心信息，让装配器通过 overflow 显式报告，
      // 不把人物身份/性格/状态静默截断成不可用的半句话。
      text = coreText;
    }
  }
  return level > 0 ? `${text}\n…（角色卡层超预算：长字段已分级压缩，每张卡核心信息完整）` : text;
}

// 世界观词条统一筛选：固定(pinned)优先 + 关键词命中，按 priority 降序限量 30。
// buildAIContext（UI 预览）与 buildNovelContext（创作内核）共用，避免两套规则分叉。
function pickWorldEntries(workId, corpus) {
  const rows = prepare('SELECT * FROM world_entries WHERE work_id = ? ORDER BY is_pinned DESC, priority DESC, position ASC, id ASC').all(workId);
  const out = [];
  for (const entry of rows) {
    if (out.length >= 30) break;
    const pinned = Number(entry.is_pinned) === 1;
    let matched = pinned;
    if (!matched) {
      const keywords = String(entry.keywords || '').split(/[,，、\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      matched = keywords.some((k) => corpus.includes(k));
    }
    if (matched) out.push(entry);
  }
  return out;
}

// 设定词条筛选：与世界观词条同源思路，但 terms 表没有 pinned/priority，
// 因此用「关键词命中权重 + 最近更新优先」作为稳定排序，保证最近归档的
// 稀缺度/属性/素材库等写作约束在相关章节装配时优先可见。
function pickTerms(workId, corpus) {
  const rows = prepare('SELECT * FROM terms WHERE work_id = ? ORDER BY updated_at DESC, id DESC').all(workId);
  const corpusLower = String(corpus || '').toLowerCase();
  const tokens = corpusLower
    .split(/[\s,，、。；;！？?：“”"'‘’（）()/\\]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2)
    .slice(0, 60);
  const scored = rows.map((t, idx) => {
    const title = String(t.title || '').toLowerCase();
    const tags = String(t.tags || '').toLowerCase();
    const content = String(t.content || '').slice(0, 800).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      if (tags.includes(token)) score += 2;
      if (content.includes(token)) score += 1;
    }
    // 标题含「体系/素材库」的词条是跨章写作约束（稀缺度、属性分类、收力素材），
    // 视为 pinned 等价物置顶，避免被关键词命中权重挤到 cap 之外。
    if (/体系|素材库|写作标准/.test(title)) score += 8;
    if (idx < 6) score += 1; // 最近更新的词条视为当前写作约束的候选，避免全量不可见
    return { t, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.id - b.t.id)
    .slice(0, 12)
    .map((x) => x.t);
}

// 根据章节自动组装 AI 上下文：相关角色卡、激活的世界观词条、作者注。
function buildAIContext(chapterId) {
  const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!chapter) return null;
  const work = prepare('SELECT * FROM works WHERE id = ?').get(chapter.work_id);
  if (!work) return null;

  const allChap = prepare('SELECT id, title, summary, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(work.id);
  const pos = allChap.findIndex((c) => c.id === chapter.id);
  const prevChapRow = pos > 0 ? allChap[pos - 1] : null;

  // 固定词条始终激活；关键词词条在标题/摘要/正文中匹配到关键词时激活。
  const corpus = [chapter.title, chapter.summary, plainTextHead(chapter.content, 3000), work.description].join(' ').toLowerCase();

  // 出场角色：评分制选择（剧情线关联 > 正文/摘要命中 > 蓝图/作者注/最近事件 > 最近章节摘要 > 关系网），
  // 兜底为“最近出场优先”，不再“按名字前 8”；新章节正文为空时蓝图/作者注里的角色也能命中。
  let blueprint = null;
  try { blueprint = JSON.parse(chapter.blueprint_json || '{}'); } catch (_) { blueprint = null; }
  const recentEvents = listStoryEvents(work.id, 12);
  // 未闭合伏笔：与创作内核（buildNovelContext）同源——kind=foreshadow 且未 resolved/dropped；
  // 直连成文不再有 novel_consistency 工具兜底，必须内联进 AI 上下文（质量优先模式）。
  const openForeshadows = listStoryEvents(work.id, 200)
    .filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped')
    .slice(0, 20);
  const forcedIds = String(chapter.context_character_ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const { sceneCharacters: characters } = selectSceneCharacters(work.id, {
    plotlineId: chapter.plotline_id,
    corpus,
    forceIds: forcedIds,
    extraTexts: [chapter.author_note, work.author_note, JSON.stringify(blueprint || {}), recentEvents.map((e) => e.summary).join(' ')],
    recentSummaries: [...allChap.slice(Math.max(0, pos - 3), pos).map((c) => c.summary || ''), chapter.summary || '']
  });

  const worldEntries = pickWorldEntries(work.id, corpus);
  const termEntries = pickTerms(work.id, corpus);

  const charNames = characters.map((c) => c.name).join('、');
  const replaceVars = (text = '') => String(text)
    .replace(/\{title\}/g, chapter.title || '')
    .replace(/\{work\}/g, work.title || '')
    .replace(/\{characters\}/g, charNames)
    .replace(/\{summary\}/g, chapter.summary || '');

  // 创作内核增强：前文衔接尾巴、最近事件、写作红线（供提示词注入/界面预览）
  let storyTail = '';
  if (prevChapRow) {
    const pc = prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapRow.id);
    if (pc) storyTail = plainTextTail(pc.content || '', 1200);
  }
  if (!storyTail) storyTail = plainTextTail(chapter.content || '', 1200);
  const redlineRows = listRedlines(work.id);
  const targetWords = (Number(chapter.target_words) > 0 ? Number(chapter.target_words) : 0)
    || Number(work.default_chapter_words) || 2000;

  return {
    _chapter: chapter, // 内部字段：供 /api/ai_context 复用原始章节行做语义召回，返回前删除
    work: {
      id: work.id, title: work.title,
      default_chapter_words: Number(work.default_chapter_words) || 2000,
      total_chapters: Number(work.total_chapters) || 0,
      story_structure: work.story_structure || '',
      narrative_pov: work.narrative_pov || '',
      style_positive: work.style_positive || ''
    },
    chapter: { id: chapter.id, title: chapter.title, summary: chapter.summary, blueprint, target_words: targetWords },
    prev_chapter: prevChapRow ? { id: prevChapRow.id, title: prevChapRow.title } : null,
    characters,
    world_entries: worldEntries,
    terms: termEntries,
    story_memory: getStoryMemory(work.id),
    story_tail: storyTail,
    recent_events: recentEvents.map((e) => ({ kind: e.kind, summary: e.summary, chapter_id: e.chapter_id, created_at: e.created_at })),
    open_foreshadows: openForeshadows.map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id, resolves_event_id: e.resolves_event_id })),
    redlines: redlineRows.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note, exceptions: Array.isArray(r.exceptions) ? r.exceptions : [] })),
    style_contract: renderStyleContract(redlineRows, work.style_positive || ''),
    work_author_note: replaceVars(work.author_note || ''),
    chapter_author_note: replaceVars(chapter.author_note || '')
  };
}

// 🐞 运行追踪：出场角色选择与 UI 预览版上下文装配的函数级节点。
// 这两处是「AI 到底带了什么进上下文」的关键路径，耗时与规模都值得单独看。
selectSceneCharacters = traceFn('selectSceneCharacters（选出场角色）', selectSceneCharacters, { kind: 'fn', slowMs: 200 });
buildAIContext = traceFn('buildAIContext（UI 预览上下文）', buildAIContext, { kind: 'fn', slowMs: 300 });

// ---------- 创作内核：写作红线 / 事件账本 / 记忆版本 / 场景上下文 ----------
// 供 dsh 创作插件与后续 UI 调用；生成前取上下文、生成后扫描红线、落事件与记忆快照。

const DEFAULT_REDLINES = [
  { kind: 'word', pattern: '微微', note: 'AI 高频微动作词，尤其“微微一愣/微微一笑”连击，慎用' },
  { kind: 'word', pattern: '缓缓', note: '慢动作万能前缀，易显拖沓' },
  { kind: 'word', pattern: '不禁', note: '典型 AI 腔触发词，慎用' },
  { kind: 'word', pattern: '仿佛', note: '比喻万能引子，一个段落内至多一次' },
  { kind: 'word', pattern: '眸', note: '眸/眼眸/眼底堆砌是 AI 腔重灾区' },
  { kind: 'word', pattern: '嘴角', note: '嘴角微表情模板（勾起/上扬/弧度）' },
  { kind: 'word', pattern: '一抹', note: '“一抹 X”万能量词（神色/笑意/弧度）' },
  { kind: 'word', pattern: '不由得', note: 'AI 腔触发词，慎用' },
  { kind: 'word', pattern: '心中一动', note: '情绪套话' },
  { kind: 'word', pattern: '心念电转', note: '情绪套话' },
  { kind: 'word', pattern: '波澜不惊', note: '装逼套话' },
  { kind: 'word', pattern: '深不可测', note: '装逼套话' },
  { kind: 'word', pattern: '不怒自威', note: '装逼套话' },
  { kind: 'word', pattern: '眼神一凝', note: '反应套话' },
  { kind: 'word', pattern: '沉声道', note: '对话标签套话，改用动作/语气代替' },
  { kind: 'word', pattern: '冷冷道', note: '对话标签套话' },
  { kind: 'word', pattern: '冷哼一声', note: '高频反应模板' },
  { kind: 'word', pattern: '空气仿佛凝固', note: '场景停顿模板句' },
  { kind: 'word', pattern: '时间仿佛静止', note: '场景停顿模板句' },
  { kind: 'phrase', pattern: '眼中闪过', note: '“眼中闪过+神色”万能反应句' },
  { kind: 'phrase', pattern: '眼底掠过', note: '同上' },
  { kind: 'phrase', pattern: '脸上浮现', note: '表情万能句' },
  { kind: 'phrase', pattern: '嘴角勾起一抹', note: '笑容模板句' },
  { kind: 'phrase', pattern: '在这一刻', note: '时间放大模板，慎用' },
  { kind: 'phrase', pattern: '一股强大的气势', note: '气势万能句' },
  { kind: 'phrase', pattern: '一股恐怖的', note: '威压模板' },
  { kind: 'regex', pattern: '(?:眼中|眼底|眸中).{0,8}(?:闪过|掠过|闪过一丝)', note: '“眼中闪过 X”家族' },
  { kind: 'regex', pattern: '浑身一震', note: '“X 浑身一震”型反应模板' }
];

const VALID_REDLINE_KINDS = new Set(['word', 'phrase', 'regex']);

// 首次启动时写入默认红线（work_id 为空 = 全局默认）。
function seedRedlinesIfEmpty() {
  // 用 app_settings 标志判断是否已初始化，而非「全局红线计数为 0」：
  // 用户清空默认红线是合法操作，不应在下次启动被重新灌入。
  if (getAppSettingDb('redlines_seeded', '') === '1') return;
  const row = prepare('SELECT COUNT(*) AS c FROM writing_redlines WHERE work_id IS NULL').get();
  if (Number(row.c) > 0) { setAppSettingDb('redlines_seeded', '1'); return; }
  db.exec('BEGIN');
  try {
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note) VALUES (NULL, ?, ?, ?)');
    for (const r of DEFAULT_REDLINES) stmt.run(r.kind, r.pattern, r.note || '');
    db.exec('COMMIT');
    setAppSettingDb('redlines_seeded', '1');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 读取红线：全局默认 + 作品级覆盖（作品级存在时优先于同名全局项）。
// 解析红线条目的豁免词清单（JSON 数组字符串 → 字符串数组）。
function parseRedlineExceptions(row) {
  try {
    const arr = JSON.parse(String(row.exceptions || '[]'));
    return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : [];
  } catch (_) { return []; }
}

function listRedlines(workId) {
  const globalRows = prepare('SELECT * FROM writing_redlines WHERE work_id IS NULL ORDER BY id ASC').all();
  const workRows = workId ? prepare('SELECT * FROM writing_redlines WHERE work_id = ? ORDER BY id ASC').all(workId) : [];
  const byKey = new Map(globalRows.filter((r) => Number(r.enabled)).map((r) => [`${r.kind}:${r.pattern}`, r]));
  for (const r of workRows) {
    const key = `${r.kind}:${r.pattern}`;
    if (Number(r.enabled)) byKey.set(key, r);
    else byKey.delete(key);
  }
  return [...byKey.values()].map((r) => ({ ...r, exceptions: parseRedlineExceptions(r) }));
}

// 全量替换某一 scope 的红线（workId 为空则替换全局默认）。
// 校验：类型白名单、模式非空、长度上限（防病态正则）、regex 可编译。
function replaceRedlines(workId, entries) {
  if (!Array.isArray(entries)) throw new Error('entries 必须是数组');
  const MAX_PATTERN = 500;
  for (const e of entries) {
    const kind = asString(e.kind, 'phrase');
    if (!VALID_REDLINE_KINDS.has(kind)) throw new Error(`未知红线类型：${kind}`);
    const pattern = asString(e.pattern, '');
    if (!pattern.trim()) throw new Error('红线模式不能为空');
    if (pattern.length > MAX_PATTERN) throw new Error(`红线模式过长（上限 ${MAX_PATTERN} 字符）`);
    if (kind === 'regex') {
      try { new RegExp(pattern); } catch (_) { throw new Error(`非法正则：${pattern.slice(0, 80)}`); }
      // 病态正则启发式拦截：嵌套量词（如 (a+)+、(\w+)* 再叠量词）易造成灾难性回溯。
      if (/\([^)]*[+*{][^)]*\)\s*[+*{]/.test(pattern)) {
        throw new Error('正则包含嵌套量词，存在灾难性回溯风险，请简化');
      }
    }
    const exceptions = Array.isArray(e.exceptions)
      ? e.exceptions.map((s) => asString(s, '').trim()).filter(Boolean).slice(0, 20)
      : [];
    if (exceptions.some((s) => s.length > 100)) throw new Error('豁免词过长（单个上限 100 字符）');
  }
  db.exec('BEGIN');
  try {
    prepare('DELETE FROM writing_redlines WHERE work_id IS ?').run(workId ?? null);
    const stmt = prepare('INSERT INTO writing_redlines (work_id, kind, pattern, note, exceptions, enabled) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of entries) {
      const exceptions = Array.isArray(e.exceptions)
        ? e.exceptions.map((s) => asString(s, '').trim()).filter(Boolean).slice(0, 20)
        : [];
      stmt.run(workId ?? null, asString(e.kind, 'phrase'), asString(e.pattern, ''), asString(e.note, ''), JSON.stringify(exceptions), e.enabled === false ? 0 : 1);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listRedlines(workId);
}

// 把红线渲染成给模型看的“写作风格契约”文本；stylePositive 为作品级正向风格要求。
function renderStyleContract(rows, stylePositive = '') {
  const enabled = rows.filter((r) => Number(r.enabled));
  const lines = enabled.map((r) => {
    const kindName = r.kind === 'regex' ? '句式模式' : (r.kind === 'word' ? '慎用词' : '慎用句式');
    const exceptions = Array.isArray(r.exceptions) && r.exceptions.length ? `（豁免：${r.exceptions.join('、')}）` : '';
    return `- [${kindName}] ${r.pattern}${exceptions}${r.note ? `（${r.note}）` : ''}`;
  });
  const parts = [];
  if (lines.length) {
    parts.push([
      '【写作风格红线 · 反 AI 腔】请在写作时主动避免以下词句；若确需使用，每次出现前先问自己是否有更具体、更有画面感的写法：',
      ...lines
    ].join('\n'));
  }
  const positive = String(stylePositive || '').trim();
  if (positive) {
    parts.push(`【正向风格要求】本作品的风格追求（请主动体现，而非仅仅避免红线）：\n${positive}`);
  }
  return parts.length ? parts.join('\n\n') : '（未启用任何红线规则）';
}

// 在文本中确定性扫描红线命中（用于生成后自查）。
// opts.skip_dialogue=true 时先剥掉引号内对话再扫：角色台词的口语词不应按叙述标准误杀。
function scanAgainstRedlines(rows, text, opts = {}) {
  const hits = [];
  // 扫描文本长度上限：防病态正则叠加超长输入导致的灾难性回溯阻塞事件循环。
  const source = String(text || '').slice(0, 1000000);
  if (!source) return hits;
  const clean = opts.skip_dialogue === true
    ? source.replace(/“[^”]*”|「[^」]*」|‘[^’]*’|『[^』]*』/g, '')
    : source;
  if (!clean) return hits;
  for (const r of rows) {
    if (!Number(r.enabled)) continue;
    const pattern = String(r.pattern || '');
    if (!pattern || pattern.length > 500) continue; // 超长/异常模式跳过（防病态正则）
    const exceptions = Array.isArray(r.exceptions) ? r.exceptions.filter((s) => String(s || '').length <= 100) : [];
    let count = 0;
    let sample = '';
    try {
      if (r.kind === 'regex') {
        const re = new RegExp(pattern, 'g');
        const found = (clean.match(re) || []).filter((m) => !exceptions.some((e) => m.includes(e)));
        count = found.length;
        sample = found[0] || '';
      } else {
        let idx = -1;
        while ((idx = clean.indexOf(pattern, idx + 1)) !== -1) {
          // 豁免：命中位置与某个豁免词重叠时跳过（“眸 → 眼眸/回眸/眸色”这类整词豁免）。
          const exempt = exceptions.some((e) => {
            const start = Math.max(0, idx - e.length + 1);
            const end = Math.min(clean.length, idx + pattern.length + e.length - 1);
            return clean.slice(start, end).includes(e);
          });
          if (exempt) continue;
          count += 1;
          if (!sample) sample = clean.slice(Math.max(0, idx - 14), idx + pattern.length + 14);
        }
      }
    } catch (_) { /* 非法正则跳过 */ }
    if (count > 0) hits.push({ kind: r.kind, pattern, note: r.note || '', count, sample: sample || '' });
  }
  return hits.sort((a, b) => b.count - a.count);
}

// 🐞 运行追踪：红线扫描可能跑大量正则（正文越长越慢），单独成节点便于识别卡顿来源。
scanAgainstRedlines = traceFn('scanAgainstRedlines（写作红线扫描）', scanAgainstRedlines, { kind: 'fn', slowMs: 150 });

// ---------- 确定性连续性预检：豁免与阈值的存储（2026-09-22 报告 · 第 1 步）----------
// 两样都落 `app_settings`（key-value，零迁移、零 schema 改动）：
//   continuity_exemptions:<workId> → {"character:67": {"reason": "…", "at": "…"}}
//   continuity_thresholds:<workId> → {"plotlineStallChapters": 4, "systemMentionMax": 15}
// ⚠️ 存成对象而不是数组：豁免要能带上"为什么"，将来界面/导出要看得到判定的依据。
// ⚠️ 解析失败一律退回空对象：**坏配置不该让预检整个不可用**（宁可少一条豁免，也不要报错挡住写作）。
function readWorkScopedSetting(prefix, workId) {
  try {
    const raw = JSON.parse(getAppSettingDb(`${prefix}${Number(workId)}`, '{}'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (e) {
    log({ level: 'warn', layer: 'app', kind: 'continuity_setting_parse_failed', message: `解析 ${prefix}${workId} 失败：${e.message}` });
    return {};
  }
}
function getContinuityExemptions(workId) { return readWorkScopedSetting(CONTINUITY_EXEMPTIONS_PREFIX, workId); }
function setContinuityExemptions(workId, map) {
  setAppSettingDb(`${CONTINUITY_EXEMPTIONS_PREFIX}${Number(workId)}`, JSON.stringify(map && typeof map === 'object' ? map : {}));
}
function getContinuityThresholds(workId) { return readWorkScopedSetting(CONTINUITY_THRESHOLDS_PREFIX, workId); }

// 预检模块要的是"两个查询函数"（不 import db，保持可离线单测）；这里就是唯一接线点。
// 签名与 node:sqlite 的 prepare().all/get 一致，于是脚本侧能直接塞只读连接的同名函数。
const CONTINUITY_GUARD_DEPS = {
  all: (sql, ...params) => prepare(sql).all(...params),
  get: (sql, ...params) => prepare(sql).get(...params),
};

// ---------- 故事事件账本 ----------
// 入账一条事件；支持伏笔状态与回收关联、按 dedup_key 幂等去重。
function addStoryEvent(workId, {
  chapterId,
  kind = 'event',
  summary = '',
  payload = {},
  foreshadowStatus = '',
  resolvesEventId = null,
  dedupKey = '',
  tx = false
}) {
  const summaryText = asString(summary, '');
  const key = asString(dedupKey, '');
  // 事务体：查重 → 写入 → 伏笔回收。事务原语用 db.js 的深度感知版本（嵌套走 SAVEPOINT），
  // 因此本函数可以在宿主事务里被 settleProposalsInTx 直接调用。
  const run = () => {
    // 查重移入事务内，配合 (work_id, dedup_key) 唯一索引兜底并发竞态。
    if (key) {
      const dup = prepare('SELECT id FROM story_events WHERE work_id = ? AND dedup_key = ? LIMIT 1').get(workId, key);
      if (dup) return { id: Number(dup.id), duplicate: true };
    }
    if (resolvesEventId) {
      const target = prepare('SELECT id, kind FROM story_events WHERE id = ? AND work_id = ?').get(Number(resolvesEventId), workId);
      if (!target) throw new Error('回收目标事件不存在或不属于该作品');
      if (target.kind !== 'foreshadow') throw new Error('回收目标不是伏笔事件');
    }
    const info = prepare(`
      INSERT INTO story_events (work_id, chapter_id, kind, summary, payload, foreshadow_status, resolves_event_id, dedup_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workId, chapterId || null, asString(kind, 'event'), summaryText, JSON.stringify(payload || {}),
      asString(foreshadowStatus, kind === 'foreshadow' ? 'open' : ''),
      resolvesEventId ? Number(resolvesEventId) : null, key, now());
    if (resolvesEventId && kind === 'event') {
      // 回收伏笔：把被回收的伏笔标记为 resolved，并回链到本事件。
      prepare('UPDATE story_events SET foreshadow_status = ? WHERE id = ? AND work_id = ?')
        .run('resolved', Number(resolvesEventId), workId);
    }
    return { id: Number(info.lastInsertRowid), duplicate: false };
  };
  if (tx) return run();
  let result;
  try {
    result = withTransaction(run);
  } catch (e) {
    if (key && /UNIQUE constraint failed/i.test(String(e?.message || ''))) {
      const dup = prepare('SELECT id FROM story_events WHERE work_id = ? AND dedup_key = ? LIMIT 1').get(workId, key);
      if (dup) return { id: Number(dup.id), duplicate: true };
    }
    throw e;
  }
  if (!result.duplicate) touchWork(workId);
  return result;
}

function listStoryEvents(workId, limit = 40) {
  return prepare(`
    SELECT * FROM story_events WHERE work_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(workId, limit).map((e) => {
    let payload = {};
    try { payload = JSON.parse(e.payload || '{}'); } catch (_) {}
    return {
      id: e.id, chapter_id: e.chapter_id, kind: e.kind, summary: e.summary, payload,
      foreshadow_status: e.foreshadow_status || (e.kind === 'foreshadow' ? 'open' : ''),
      resolves_event_id: e.resolves_event_id,
      created_at: e.created_at
    };
  });
}

// ---------- 入账提案（headless 生成任务先提案、作者确认后入账） ----------
function listProposals(workId) {
  const events = prepare('SELECT * FROM story_event_proposals WHERE work_id = ? AND status = ? ORDER BY id ASC')
    .all(workId, 'pending').map((p) => ({ type: 'event', ...p, payload: safeParseJSON(p.payload) }));
  const memories = prepare('SELECT * FROM story_memory_proposals WHERE work_id = ? AND status = ? ORDER BY id ASC')
    .all(workId, 'pending').map((p) => ({ type: 'memory', ...p }));
  return [...events, ...memories];
}

function addEventProposal(workId, fields) {
  const info = prepare(`
    INSERT INTO story_event_proposals (work_id, chapter_id, kind, summary, payload, foreshadow_status, resolves_event_id, dedup_key, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(workId, fields.chapterId || null, asString(fields.kind, 'event'), asString(fields.summary, ''),
    JSON.stringify(fields.payload || {}), asString(fields.foreshadowStatus, fields.kind === 'foreshadow' ? 'open' : ''),
    fields.resolvesEventId ? Number(fields.resolvesEventId) : null, asString(fields.dedupKey, ''), asString(fields.note, ''));
  return { proposed: true, proposal_id: Number(info.lastInsertRowid) };
}

function addMemoryProposal(workId, { summary, delta, note, guard }) {
  const info = prepare(`
    INSERT INTO story_memory_proposals (work_id, summary, delta, note, guard, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(workId, asString(summary, ''), asString(delta, ''), asString(note, ''), asString(guard, ''));
  return { proposed: true, proposal_id: Number(info.lastInsertRowid) };
}

// 采纳/拒绝提案：ids 为空 + all=true 时处理该作品全部 pending 提案。
function settleProposals(workId, { ids, all, action, onConsumeApproval = null }) {
  return withTx(() => settleProposalsInTx(workId, { ids, all, action, onConsumeApproval }));
}

function settleProposalsInTx(workId, { ids, all, action, onConsumeApproval = null }) {
  const mark = (table, id) => prepare(`UPDATE ${table} SET status = ? WHERE id = ? AND work_id = ? AND status = 'pending'`).run(action, id, workId);
  const applied = { events: 0, memories: 0 };
  const rejected = { events: 0, memories: 0 };
  const guardFailed = [];
  let eventRows = [];
  let memoryRows = [];
  if (all) {
    eventRows = prepare(`SELECT * FROM story_event_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id ASC`).all(workId);
    memoryRows = prepare(`SELECT * FROM story_memory_proposals WHERE work_id = ? AND status = 'pending' ORDER BY id ASC`).all(workId);
  } else {
    const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (list.length) {
      eventRows = prepare(`SELECT * FROM story_event_proposals WHERE work_id = ? AND id IN (${list.map(() => '?').join(',')})`).all(workId, ...list);
      memoryRows = prepare(`SELECT * FROM story_memory_proposals WHERE work_id = ? AND id IN (${list.map(() => '?').join(',')})`).all(workId, ...list);
    }
  }
  // R02.2 修复：审批消费必须发生在**任何写入之前**。审批基线是提案行的内容指纹
  // （legacyProposalHash 含 status 字段），而下面的 mark() 会把 status 从 pending 改成 apply/reject；
  // 若先写后消费，读回的指纹必然与审批时不同 → 任何带审批的旧提案采纳都会被判 baseline_mismatch
  // （隔离 HTTP 边界测试 H10 实测）。消费与写入仍在同一事务：写入失败整次回滚，审批退回未消费可重试。
  if (typeof onConsumeApproval === 'function') onConsumeApproval({ workId, action });
  for (const p of eventRows) {
    if (action === 'apply') {
      addStoryEvent(workId, {
        chapterId: p.chapter_id, kind: p.kind, summary: p.summary,
        payload: safeParseJSON(p.payload), foreshadowStatus: p.foreshadow_status,
        resolvesEventId: p.resolves_event_id, dedupKey: p.dedup_key, tx: true
      });
      applied.events += 1;
    } else {
      rejected.events += 1;
    }
    mark('story_event_proposals', p.id);
  }
  for (const p of memoryRows) {
    if (action === 'apply') {
      let summary = asString(p.summary, '');
      if (!summary && p.delta) summary = mergeMemoryDraft(getStoryMemory(workId), p.delta);
      if (summary.trim()) {
        // AI 自压缩提案在作者点「采纳」时仍需过同一零损失护栏——提案先落库只是延迟作者确认，
        // 不应成为绕过实体完整性检查的路径。
        // ⚠️ 判据必须是**提案自己带的来源标记**（`guard`，创建时落库、读取时取回），
        // 而不是"凡是带 summary 的提案"：普通/历史提案没有这个标记，它们的采纳语义
        // 由作者自己负责，机器判据不得替作者改判（否则短提案会被护栏当成"记忆过短"直接拒掉）。
        if (p.guard === AGENT_GUARD_MARKER && String(p.summary || '').trim()) {
          const verdict = agentMemoryGuardOf(workId, summary);
          if (!verdict.ok) {
            guardFailed.push({
              proposal_id: p.id,
              reasons: verdict.reasons,
              missing: verdict.guard.missing.slice(0, 20),
              invented: verdict.invention.invented.slice(0, 20),
            });
            continue; // 保留 pending，作者可修正后再次采纳
          }
        }
        saveStoryMemory(workId, summary, { source: 'proposal', note: p.note || '作者确认的 AI 提案', tx: true });
        applied.memories += 1;
      } else {
        rejected.memories += 1; // 空提案按拒绝处理，避免把长期记忆覆盖为空串
      }
    } else {
      rejected.memories += 1;
    }
    mark('story_memory_proposals', p.id);
  }
  return { ok: true, work_id: workId, action, applied, rejected, guard_failed: guardFailed, pending: listProposals(workId).length };
}

function safeParseJSON(text) {
  try { return JSON.parse(text || '{}'); } catch (_) { return {}; }
}

// ---------- 记忆版本 ----------
function listMemoryVersions(workId) {
  return prepare('SELECT id, work_id, summary, source, note, created_at FROM memory_versions WHERE work_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(workId);
}

// 回滚到指定版本：把该版本写回当前生效摘要，并记一条 rollback 快照。
function rollbackMemory(versionId) {
  const version = prepare('SELECT * FROM memory_versions WHERE id = ?').get(versionId);
  if (!version) throw new Error('记忆版本不存在');
  const result = saveStoryMemory(version.work_id, version.summary, { source: 'rollback', note: `回滚到版本 #${version.id}` });
  const version_id = result.version_id
    ?? (prepare('SELECT MAX(id) AS id FROM memory_versions WHERE work_id = ?').get(version.work_id)?.id ?? null);
  return { ok: true, work_id: version.work_id, summary: result.summary, version_id };
}

// ---------- 场景化创作上下文（ST 式装配） ----------
// mode: full（默认，整章代写/分析）| continuation（接龙，重视前文尾巴）| fragment（片段补写）
// 注：语义召回的缺口判据 `recallGapReason` 住在 ai/context/layers.mjs（内核单点，
// 可离线单测），这里只消费它——三处使用点（装配 + 两个响应端点）必须同源。

/**
 * R04：宿主侧的召回**再校验**（不信任生产方过滤结果）。
 * 与 openviking-sync.js 共用 ai/openviking/recall-meta.mjs 的同一实现：
 *   · 不在作品命名空间 / 形状不明 / 候选内容 / 未来章节 → 拒绝进入 assembled；
 *   · 章节 id 解析不到 position（索引残留）→ 同样拒绝（fail-closed）。
 * 被拦下的条目写 warning 日志（含 code/uri），让"为什么这轮没召回到"可归因。
 */
function revalidateRecallForHost(recall, workId, chapter) {
  if (!recall || recall.status !== 'ok' || !Array.isArray(recall.hits) || !recall.hits.length) return recall;
  let chapterOrderById = new Map();
  let currentChapterOrder = null;
  try {
    // 位次口径 = position ASC, id ASC 的排名（position 全为 0 的旧数据也能给出正确先后）。
    chapterOrderById = new Map(
      prepare('SELECT id FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId)
        .map((r, i) => [String(r.id), i])
    );
    if (chapter) {
      const v = chapterOrderById.get(String(chapter.id));
      currentChapterOrder = v === undefined ? null : v;
    }
  } catch { /* 读不到章节表：只影响 chapters/ 命中的放行，按 fail-closed 处理 */ }
  const rev = revalidateRecallPayload(recall, {
    workUri: workDir(workId),
    currentChapterOrder,
    chapterOrderById,
  });
  if (rev.dropped.length) {
    log({
      level: 'warn', layer: 'ai', kind: 'recall_host_revalidate_blocked',
      message: `宿主再校验拦下 ${rev.dropped.length} 条召回（未进入请求）`,
      context: { work_id: workId, chapter_id: chapter ? chapter.id : null, dropped: rev.dropped.slice(0, 10) }
    });
  }
  return rev.payload;
}

/**
 * 共享资料库（library）层的宿主再校验：与 recall 再校验同一实现，ctx.allowLibrary=true
 * 只放行资料根内的条目（canon 记 'reference'，永不 canon）；被拦下的写 warning 日志。
 */
function revalidateLibraryForHost(library, workId) {
  if (!library || library.status !== 'ok' || !Array.isArray(library.hits) || !library.hits.length) return library;
  const rev = revalidateRecallPayload(library, { allowLibrary: true, libraryWorkId: String(workId) });
  if (rev.dropped.length) {
    log({
      level: 'warn', layer: 'ai', kind: 'library_host_revalidate_blocked',
      message: `宿主再校验拦下 ${rev.dropped.length} 条资料条目（未进入请求）`,
      context: { work_id: workId, dropped: rev.dropped.slice(0, 10) }
    });
  }
  return rev.payload;
}

/**
 * 本次上下文**装配**的标识（request_id）。
 *
 * 与 context_id 的分工要说清楚，否则两者都会被误读：
 *   context_id  = **内容**的稳定哈希：同一份上下文永远得到同一个 id（可复现、可对照、可回归）
 *   request_id  = **这一次装配**的身份：同一份内容被装配两次会得到两个 id
 *
 * ⚠️ 已知语义边界：装配结果有缓存（`ai/context/cache.mjs`），**缓存命中时 request_id 会被沿用**
 * —— 内容确实来自那一次装配，所以这不是错误，但它意味着 request_id **不能**当作 HTTP 请求 id 用。
 * 按 HTTP 请求关联请用追踪层的 opId（`X-Trace-Op`，见 debug-trace.js）。
 */
let contextRequestSeq = 0;
function newContextRequestId() {
  contextRequestSeq = (contextRequestSeq + 1) % 1e6;
  return `ctx-${Date.now().toString(36)}-${contextRequestSeq.toString(36)}`;
}

/** 词典字段拆名（别名/关键词）：与 StoryState 的拆分口径一致，按常见中英分隔符切分、有界。 */
function splitIndexNames(v) {
  const s = String(v || '');
  return s ? s.split(/[、,，;；\/|\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 12) : [];
}

/**
 * E4：检索计划用的实体词典（确定性；只用既有正典名称/别名/关键词/剧情线标题，不调用模型）。
 * 每个来源都有上限，避免大作品把词典撑成新的全量扫描面；抽取端另有 maxEntitiesPerKind 上限。
 */
function buildNovelIndexDictionary(workId, allCharacters) {
  const dict = [];
  for (const c of (allCharacters || []).slice(0, 200)) {
    dict.push({ kind: 'character', name: c.name, aliases: splitIndexNames(c.aliases) });
  }
  try {
    const locs = prepare("SELECT id, canonical_name FROM story_entities WHERE work_id = ? AND kind = 'location' AND status = 'active' LIMIT 200").all(workId);
    const aliasById = new Map();
    if (locs.length) {
      const rows = prepare(`SELECT entity_id, alias FROM story_entity_aliases WHERE entity_id IN (${locs.map(() => '?').join(',')})`).all(...locs.map((l) => l.id));
      for (const a of rows) {
        if (!a.alias) continue;
        const list = aliasById.get(a.entity_id) || [];
        list.push(String(a.alias));
        aliasById.set(a.entity_id, list);
      }
    }
    for (const l of locs) if (l.canonical_name) dict.push({ kind: 'location', name: l.canonical_name, aliases: aliasById.get(l.id) || [] });
  } catch (_) { /* 实体表缺失时降级为只用角色/主题词典 */ }
  try {
    const topics = [];
    for (const w of prepare('SELECT title, keywords FROM world_entries WHERE work_id = ? LIMIT 200').all(workId)) {
      if (w.title) topics.push(String(w.title));
      topics.push(...splitIndexNames(w.keywords));
    }
    for (const p of prepare('SELECT title FROM plotlines WHERE work_id = ? LIMIT 200').all(workId)) if (p.title) topics.push(String(p.title));
    for (const t of [...new Set(topics)].slice(0, 300)) dict.push({ kind: 'topic', name: t, aliases: [] });
  } catch (_) { /* 同上 */ }
  return dict;
}

async function buildNovelContext(workId, chapterId, mode = 'full', contextOpts = {}) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) return null;

  // A/C/D/E：方向与召回阶段只在这里规范化一次（口径见 ai/direction.mjs，前端有镜像实现）。
  // direction 是**检索数据**：只影响资料召回与 D/E 索引候选发现，不改变正典查询。
  const direction = normalizeDirection(contextOpts.direction);
  const libraryRecallPhase = normalizeLibraryRecallPhase(contextOpts.libraryRecallPhase);
  const directionSource = normalizeDirectionSource(contextOpts.directionSource);
  // 集成点③：本次装配的检索账本——「资料召回次数」与「索引查询次数」分开累加，收口为 additive 字段。
  const retrievalAcc = createRetrievalAccumulator({
    phase: libraryRecallPhase,
    direction: directionAuditOf(direction, directionSource),
    requestId: normalizeRequestId(contextOpts.requestId),
  });

  const allChapters = prepare('SELECT id, work_id, volume_id, plotline_id, parent_id, title, summary, author_note, blueprint_json, target_words, context_character_ids, position, created_at, updated_at FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const plotlines = prepare('SELECT * FROM plotlines WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const allCharacters = prepare('SELECT * FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
  const nameById = new Map(allCharacters.map((c) => [c.id, c.name]));

  let chapter = null;
  let chapterIndex = -1;
  if (chapterId) {
    chapterIndex = allChapters.findIndex((c) => c.id === Number(chapterId));
    chapter = chapterIndex >= 0 ? allChapters[chapterIndex] : prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) || null;
    // 防串作品：chapterId 属于其它作品时视为未指定章节。
    if (chapter && chapter.work_id !== workId) { chapter = null; chapterIndex = -1; }
  }
  const prevChapter = chapterIndex > 0 ? allChapters[chapterIndex - 1] : null;
  const nextChapter = chapterIndex >= 0 && chapterIndex < allChapters.length - 1 ? allChapters[chapterIndex + 1] : null;
  if (chapter && !chapter.content) {
    const full = prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id);
    chapter = { ...chapter, content: full?.content || '' };
  }

  const corpus = [
    work.title, work.description,
    chapter?.title || '', chapter?.summary || '', plainTextHead(chapter?.content || '', 3000),
    prevChapter?.title || '', prevChapter?.summary || ''
  ].join(' ').toLowerCase();

  // 出场角色：评分制选择（剧情线关联 > 正文/摘要命中 > 蓝图/作者注/最近事件 > 最近章节摘要 > 关系网）；
  // 兜底改为“最近出场优先”而非“按名字前 8”；角色卡逐卡构建、核心字段保底（见 buildCharacterCards）。
  let blueprint = null;
  try { blueprint = JSON.parse(chapter?.blueprint_json || '{}'); } catch (_) { blueprint = null; }
  const allEvents = listStoryEvents(workId, 200);
  const recentSummaries = [
    ...allChapters.slice(Math.max(0, chapterIndex - 3), chapterIndex).map((c) => c.summary || ''),
    chapter?.summary || ''
  ];
  const forcedIds = String(chapter?.context_character_ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const { sceneCharacters } = selectSceneCharacters(workId, {
    plotlineId: chapter?.plotline_id || null,
    corpus,
    forceIds: forcedIds,
    extraTexts: [
      chapter?.author_note || '', work.author_note || '',
      JSON.stringify(blueprint || {}),
      allEvents.slice(0, 30).map((e) => e.summary).join(' ')
    ],
    recentSummaries
  });
  const charCardsText = buildCharacterCards(sceneCharacters, entityCapOfId('characters'));

  // 人物关系（仅出场角色之间）
  const sceneIdList = sceneCharacters.map((c) => c.id);
  const relations = sceneIdList.length > 1
    ? prepare(`
        SELECT * FROM character_relations WHERE work_id = ? AND
        from_character_id IN (${sceneIdList.map(() => '?').join(',')}) AND to_character_id IN (${sceneIdList.map(() => '?').join(',')})
      `).all(workId, ...sceneIdList, ...sceneIdList)
    : [];
  const relationsText = relations.length
    ? relations.map((r) => `${nameById.get(r.from_character_id) || '?'} —${r.relation || '关系'}→ ${nameById.get(r.to_character_id) || '?'}${r.description ? `（${r.description.slice(0, 160)}）` : ''}`).join('\n')
    : '';

  // 世界观词条：固定(pinned)优先 + 关键词命中，按 priority 降序限量截断（与 UI 预览共用 pickWorldEntries）。
  const worldEntries = pickWorldEntries(workId, corpus);
  const worldEntriesText = worldEntries.map((w) => `【${w.title}】${String(w.content || '').slice(0, 600)}`).join('\n');

  // 设定词条：与世界观同源的分层约束。terms 没有 pinned/priority，按「命中权重 + 最近更新」排序；
  // 每条截 300 字，层 cap 由 layers.mjs 的 terms 层统一核算。
  const termEntries = pickTerms(workId, corpus);
  const termEntriesText = termEntries.map((t) => `【${t.title}】${String(t.content || '').slice(0, 300)}`).join('\n');

  // 大纲层：卷 + 剧情线 + 章节标题/摘要（长作品只给前 30 + 最近 40，中间省略计数）
  const outlineLines = [];
  for (const v of volumes) outlineLines.push(`【卷】${v.title}${v.summary ? `：${v.summary.slice(0, 200)}` : ''}`);
  for (const p of plotlines) outlineLines.push(`【${p.kind === 'side' ? '支线' : '主线'}】${p.title}${p.summary ? `：${p.summary.slice(0, 200)}` : ''}`);
  const total = allChapters.length;
  const skip = total > 70 ? total - 40 : -1;
  const shown = allChapters.filter((c, i) => skip < 0 || i < 30 || i >= skip || c.id === chapter?.id);
  if (skip >= 0) outlineLines.push(`（中间 ${total - 70} 章已省略，仅列最近进展）`);
  // 说明句放在章节列表**之前**：层是按 cap 从头部截断的（见长期记忆层的同源教训），
  // 挂在末尾必然先被 2800 字预算切掉，模型永远看不见这条规则。
  if (chapterIndex >= 0) outlineLines.push('（大纲中标注【未来章·禁止写入】的条目仅用于避免矛盾，不得提前写入正文）');
  for (const c of shown) {
    const marker = c.id === chapter?.id ? '★' : '';
    const future = chapterIndex >= 0 && allChapters.indexOf(c) > chapterIndex;
    const prefix = future ? '【未来章·禁止写入】' : '';
    outlineLines.push(`${prefix}第${c.position + 1}节${marker} ${c.title}${c.summary ? `：${c.summary.slice(0, 120)}` : ''}`);
  }
  const outlineText = outlineLines.join('\n');
  // 溯源：大纲层实际列出了哪些章（>70 章时中间会被省略，清单要如实反映"列了哪些"，
  // 否则"这层缺了第 40 章"会被误读成数据丢失，而不是既定的省略策略）。
  const shownChapterIds = shown.map((c) => c.id);

  const memoryRow = getStoryMemoryRow(workId);
  const storyMemory = memoryRow?.summary || '';
  const memoryRowId = memoryRow ? memoryRow.id : null;
  const events = allEvents.slice(0, 30);
  const eventsText = events.length
    ? events.map((e, i) => `${events.length - i}. [${e.kind}] ${e.summary.slice(0, 200)}`).join('\n')
    : '（暂无事件账本记录）';
  // 未闭合伏笔：写作时必须照顾的“欠账”，也是 novel_consistency 的核对依据。
  const openForeshadows = allEvents.filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped').slice(0, 20);
  const foreshadowText = openForeshadows.length
    ? openForeshadows.map((e) => `#${e.id} ${e.summary.slice(0, 160)}${e.resolves_event_id ? `（已被 #${e.resolves_event_id} 回收）` : ''}`).join('\n')
    : '';

  // 前文尾巴：接龙模式取当前章节尾部；新章节/片段取上一章尾部。
  // 4000 = `story_tail` 在 continuation 模式下的 cap（capContinuation），从规格取而不是另写一份。
  const currentTail = chapter ? plainTextTail(chapter.content || '', capOfId('story_tail', 'continuation')) : '';
  const prevFullRow = prevChapter ? prepare('SELECT content FROM chapters WHERE id = ?').get(prevChapter.id) : null;
  const prevTailText = prevFullRow ? plainTextTail(prevFullRow.content || '', 1500) : '';
  let storyTail = '';
  // `storyTailSource` 只记录"这段衔接来自哪一章的正文"，取值与下面的文本逻辑**同一处**决定，
  // 不另写一份判断（两份判断必然漂移）。文本本身一字未改。
  let storyTailSource = null;
  if (mode === 'continuation') {
    storyTail = currentTail;
    if (currentTail && chapter) storyTailSource = { id: chapter.id, which: '本章已写部分' };
  } else if (mode === 'fragment') {
    storyTail = currentTail || prevTailText;
    if (currentTail && chapter) storyTailSource = { id: chapter.id, which: '本章已写部分' };
    else if (prevTailText && prevChapter) storyTailSource = { id: prevChapter.id, which: '上一章尾部' };
  } else {
    storyTail = prevTailText || (currentTail ? currentTail.slice(-1500) : '');
    if (prevTailText && prevChapter) storyTailSource = { id: prevChapter.id, which: '上一章尾部' };
    else if (currentTail && chapter) storyTailSource = { id: chapter.id, which: '本章已写部分' };
  }
  if (!storyTail) {
    storyTail = prevTailText || (chapter ? plainTextTail(chapter.content || '', 800) : '');
    if (prevTailText && prevChapter) storyTailSource = { id: prevChapter.id, which: '上一章尾部（兜底）' };
    else if (storyTail && chapter) storyTailSource = { id: chapter.id, which: '本章已写部分（兜底）' };
  }

  const redlines = listRedlines(workId);
  const styleContract = renderStyleContract(redlines, work.style_positive || '');

  // 分层预算：渲染 / 每层 cap / 总预算收敛 / 裁剪清单统一由 ai/context/assembler.mjs 负责。
  // 本函数只负责「取数」——把每一层的正文准备好，层的 cap 与 kind 一律从 layers.mjs 读。
  const needsCompression = storyMemory.length > MEMORY_COMPRESS_HINT;

  const memoryBody = storyMemory
    // ⚠️ 压缩提示必须放在**正文开头**：层是按 cap 从**头部**截断的，而长期记忆会随章节无界增长
    //（`mergeMemoryDraft` 新事件置顶、只拼接不压缩）。提示若挂在末尾，记忆越长越会被自己截掉——
    // 恰恰在最该提示压缩的时候提示消失。实测：work#16 记忆 9063 字、cap 2200 → 末尾提示被切掉，
    // 层内只剩截断提示（见 docs/p5-memory-eval-verification.md §四·3）。
    ? `${needsCompression ? `（⚠ 记忆已 ${storyMemory.length} 字，超过 ${MEMORY_COMPRESS_HINT} 字压缩提示线，收尾时请优先用 novel_memory_update 压缩合并）\n` : ''}${storyMemory}`
    : '（无，可建议压缩一次）';

  const sceneBody = chapter
    ? `第${chapter.position + 1}节 ${chapter.title}${chapter.summary ? `\n大纲摘要：${chapter.summary}` : ''}${chapter.author_note ? `\n作者注：${chapter.author_note}` : ''}`
    : '（未指定具体章节）';

  // 本章蓝图（章节写作的常驻锚点）与目标字数：蓝图落库后随上下文带入，生成与核对都以其为准。
  const BLUEPRINT_LABELS = [
    ['scene_goal', '场景目标'], ['plot_points', '情节点'], ['conflicts', '冲突与转折'],
    ['character_changes', '出场角色状态变化'], ['hook', '下一章钩子'], ['references', '参考设定']
  ];
  const blueprintText = blueprint && Object.keys(blueprint).length
    ? BLUEPRINT_LABELS
        .map(([key, label]) => [label, String(blueprint[key] || '')])
        .filter(([, v]) => v.trim())
        .map(([label, v]) => `${label}：${v.slice(0, 600)}`).join('\n')
    : '';
  const targetWords = (Number(chapter?.target_words) > 0 ? Number(chapter.target_words) : 0)
    || Number(work.default_chapter_words) || 2000;

  // 作品级写作配置：总章数/故事结构/叙事视角（有配置时进入上下文，约束大纲与蓝图生成）。
  const workConfigText = [
    Number(work.total_chapters) > 0 ? `总章数：${Number(work.total_chapters)}` : '',
    work.story_structure ? `故事结构：${work.story_structure}` : '',
    work.narrative_pov ? `叙事视角：${work.narrative_pov}` : '',
    `每章目标字数：${targetWords} 字`
  ].filter(Boolean).join('｜');

  // OpenViking 语义召回层：以当前写作场景（章节/蓝图/最近事件）为查询，从共享记忆库的
  // 作品子树召回相关片段（旧章正文、设定词条、角色卡、事件等），弥补固定分层漏掉的信息；
  // OpenViking 不可用时静默跳过，不阻塞写作。
  let semanticRecall = null;
  try {
    semanticRecall = await getSemanticRecall(workId, chapter || null);
  } catch (_) {
    semanticRecall = { enabled: true, status: 'error', query: '', hits: [] };
  }
  // R04：宿主对召回结果**再校验**一次（不信任生产方已过滤——服务端过滤不是唯一防线）。
  // 跨书 / 未来章节 / 候选内容 / 布局不明的条目在这里同样进不来；被拦下的写 warning 日志。
  semanticRecall = revalidateRecallForHost(semanticRecall, workId, chapter || null);
  // ── 门控层：共享资料库（library）─────────────────────────────────────────
  // 作品显式打开 library_enabled:<workId> 才构造（与 story_state/edit_rules 同口径：
  // 未开启的作品连调用都不会发生 → assembled/manifest 逐字节不变）。
  // 资料条目由同一套来源闸门校验（canon 记 'reference'，永不 canon）；期望有却没拿到时
  // **不插缺口占位层**——状态与原因在响应字段 library_recall 与日志里可见（有意区别于 recall）。
  let libraryRecall = null;
  if (libraryEnabled(workId)) {
    try {
      // C2/C4：direction 只用于资料召回（及 D 索引候选发现）；defer 阶段不查库、不写缓存。
      libraryRecall = await getLibraryRecall(workId, chapter || null, { direction, libraryRecallPhase });
    } catch (_) {
      libraryRecall = { enabled: true, status: 'error', query: '', hits: [] };
    }
    libraryRecall = revalidateLibraryForHost(libraryRecall, workId);
    // 集成点③：资料召回统计单独合并（stats.searches 由 getLibraryRecall 记录）。
    mergeLibraryStats(retrievalAcc, libraryRecall.stats);
  }

  // ── E4：确定性检索计划（无模型参与；默认关闭）─────────────────────────────
  // 纪律（集成点②）：计划的所有索引查询**全部 await 汇总完成之后**，结果才被交给装配使用；
  // 它只用于「取哪些资产 id」与审计，**不作为一个新层直接塞进上下文**，也不与装配并行。
  // 默认关闭（novel_index_enabled=0）或没有方向时这一段完全不执行 → 与基线一致。
  let retrievalPlanMeta = null;
  if (direction && libraryRecallPhase !== 'defer' && NovelIndexStore.novelIndexEnabled()) {
    try {
      NovelIndexStore.ensureWorkIndex(workId);
      const dictionary = buildNovelIndexDictionary(workId, allCharacters);
      const chapterSignals = [chapter?.title || '', chapter?.summary || '', blueprintText].filter(Boolean).join('\n');
      const exec = await runRetrievalPlan({
        workId,
        chapterId: chapter?.id || null,
        direction,
        chapterSignals,
        dictionary,
        index: NovelIndexStore,
        versions: { schema: NovelIndexStore.NOVEL_INDEX_SCHEMA_VERSION, version: NovelIndexStore.novelIndexVersion(workId) },
      });
      mergePlanStats(retrievalAcc, exec.stats);
      const a = exec.assets || {};
      retrievalPlanMeta = {
        plan_id: exec.plan?.plan_id || exec.stats?.plan_id || '',
        status: exec.status || 'unknown',
        partial: Boolean(exec.partial),
        queries: Array.isArray(exec.plan?.queries) ? exec.plan.queries.length : 0,
        by_index: exec.stats?.by_index || {},
        matched: a.matched || null,
        assets_count: {
          character_ids: (a.character_ids || []).length,
          event_ids: (a.event_ids || []).length,
          foreshadow_ids: (a.foreshadow_ids || []).length,
          world_ids: (a.world_ids || []).length,
          relation_ids: (a.relation_ids || []).length,
          location_ids: (a.location_ids || []).length,
          thread_ids: (a.thread_ids || []).length,
        },
        timings_ms: Number(exec.stats?.timings_ms) || 0,
        cached: Number(exec.stats?.cached) || 0,
        note: '计划结果只用于候选定位与审计；本版不改变既有层内容（E5：assembled 不增）',
      };
    } catch (e) {
      // 计划失败不阻断写作：索引查询结果本来就不是装配的唯一来源，回退既有读取方式。
      log({ level: 'warn', layer: 'ai', kind: 'retrieval_plan_failed', message: `检索计划执行失败（work ${workId}）：${e.message}` });
      retrievalPlanMeta = { plan_id: '', status: 'error', partial: true, queries: 0, by_index: {}, matched: null, assets_count: null, timings_ms: 0, cached: 0, note: '计划失败：已回退既有读取方式' };
    }
  }
  // 决策 D8-#5：召回层不可用时**不得静默消失**。
  // 旧行为：status !== 'ok' 时 recallLayer = null，该层直接不存在 —— 模型不知道自己本该
  // 有一层召回，作者也看不出来（只有 API 响应里的 semantic_recall.status 留了痕）。
  // 现在：**期望有召回却没拿到**时发一层**显式占位**，把"缺了什么、为什么缺、怎么自己取回"
  // 写进上下文。这与 I4「凡裁剪必可查回」是同一条纪律：不允许静默丢信息。
  // 判据与两个响应端点同源（recallGapReason，模块级）。
  const recallGap = recallGapReason(semanticRecall);
  const recallGapText = recallGap
    ? `（本次未能取到「相关记忆检索」结果：${recallGap}。`
      + '需要旧章正文、设定词条或角色卡的原文时，请用 novel_lookup（其余）或 novel_memory_read（长期记忆）'
      + '主动查回；不要因为上面的分层里没写，就当作该设定不存在。）'
    : '';
  const recallLayer = semanticRecall && semanticRecall.status === 'ok' && semanticRecall.text
    ? { label: '相关记忆检索（语义召回）', text: semanticRecall.text, cap: 1400 }
    : null;

  // mode=settings：设定类生成（角色/世界观/词条/剧情线等）专用轻量装配——
  // 这类任务不需要「当前这一章写到哪了」，跳过当前场景/本章蓝图/前文衔接三层。
  // 注意：旧注释写的「三层合计最多省 ~6,700 字/轮」是三层 **cap 之和**，不是实际节省；
  // 实际节省取决于这三层当时的真实长度，可能远小于上限。
  const isSettingsMode = mode === 'settings';
  const specById = new Map(CONTEXT_LAYER_SPEC.map((l) => [l.id, l]));
  // 按 spec 的 id 组装一层：cap 与 kind 一律取自 layers.mjs（单一来源），
  // 这里只负责把该层的正文准备好。
  // `meta` 是**与数据相关的那一半溯源**（这次到底用了哪几行 / 检索命中的分数分布）。
  // 静态的那一半（来源表、时间视角、为什么需要它）在 layers.mjs 的 PROVENANCE 里，
  // 由装配器按 id 合并进清单——两半都不手写进清单，避免清单与实际取数漂移。
  const L = (id, text, meta = {}) => {
    const spec = specById.get(id);
    if (!spec) throw new Error(`未知的上下文层 id：${id}（layers.mjs 与 buildNovelContext 不同步）`);
    return {
      id, label: spec.label, kind: spec.kind, text, cap: contextCapOf(spec, mode),
      sourceIds: Array.isArray(meta.sourceIds) ? meta.sourceIds : null,
      scores: meta.scores || null,
      note: meta.note || '',
    };
  };
  const recallScores = (semanticRecall && Array.isArray(semanticRecall.hits) && semanticRecall.hits.length)
    ? {
        hits: semanticRecall.hits.length,
        min: Math.min(...semanticRecall.hits.map((h) => Number(h.score) || 0)),
        max: Math.max(...semanticRecall.hits.map((h) => Number(h.score) || 0)),
      }
    : null;
  const libraryScores = (libraryRecall && Array.isArray(libraryRecall.hits) && libraryRecall.hits.length)
    ? {
        hits: libraryRecall.hits.length,
        min: Math.min(...libraryRecall.hits.map((h) => Number(h.score) || 0)),
        max: Math.max(...libraryRecall.hits.map((h) => Number(h.score) || 0)),
      }
    : null;
  // ── 门控层：确定性故事状态 ────────────────────────────────────────────────
  // 只有作品显式打开开关时才构造。关闭时 storyStateLayer 为 null，下面一层都不会多——
  // 这是「机制生效≠强制接入」在代码里的落点，也是逐字节基线能保持 50/50 的原因。
  // ── 门控层：编辑规则（R07）────────────────────────────────────────────────
  // 与 story_state 同款：默认关闭（edit_rules_enabled 默认 '0'），关闭时这一层**根本不存在**，
  // 旧作品的 assembled / manifest 与它出现之前逐字节一致；打开后规则块进入请求，并在
  // R05 贡献记录里以 layer:edit_rules + 内容 hash 留痕（"真的进了请求"可核对）。
  let editRulesLayer = null;
  let editRulesMeta = null;
  try {
    const selection = resolveEditingSelection({
      edit_rules_enabled: getAppSetting('edit_rules_enabled', '0'),
      edit_tier: getAppSetting('edit_tier', 'light'),
      edit_abilities: getAppSetting('edit_abilities', ''),
      edit_genre: getAppSetting('edit_genre', 'general'),
    });
    if (selection.enabled) {
      const block = buildEditingRuleBlock(selection, { task: 'write' });
      if (block.text) {
        editRulesLayer = L('edit_rules', block.text, {
          sourceIds: block.sources.map((s) => s.id),
          note: `规则块 v${block.version}｜hash ${block.hash.slice(0, 12)}｜档位 ${block.tier}｜题材 ${block.genre}｜能力 ${block.sources.filter((s) => s.kind === 'ability').length} 项`,
        });
      }
      editRulesMeta = { version: block.version, hash: block.hash, tier: block.tier, genre: block.genre, decisions: block.decisions, sources: block.sources };
    }
  } catch (e) {
    // 规则层构建失败不能把生成路径打挂：记 warning，按"这一层没有数据"继续。
    log({ level: 'warn', layer: 'ai', kind: 'edit_rules_error', message: `编辑规则层构建失败（work ${workId}）：${e.message}`, context: { work_id: workId } });
  }
  let storyStateLayer = null;
  let storyStateMeta = null;
  if (chapter) {
    try {
      const comp = StoryState.compositionOf(workId, chapter.id);
      if (comp) {
        const built = StoryState.storyStateLayerOf(comp);
        if (built && built.text) {
          storyStateLayer = L('story_state', built.text, {
            sourceIds: comp.timelineView.visible.slice(0, 20).map((t) => t.id).filter((x) => x !== null),
            note: `正典 ${built.meta.canon_count} 条｜时间线可见 ${built.meta.timeline_visible} 条｜伏笔 ${JSON.stringify(built.meta.foreshadows)}`,
          });
        }
        storyStateMeta = { ...built.meta, blocks: built.blocks, injection: built.injection, truncated: built.truncated };
      }
    } catch (e) {
      // 状态读不出来**不能**把整条生成路径打挂：记一条 warning，按「这一层没有数据」继续。
      log({ level: 'warn', layer: 'ai', kind: 'story_state_error', message: `故事状态层构建失败（work ${workId} chapter ${chapter.id}）：${e.message}`, context: { work_id: workId, chapter_id: chapter.id } });
    }
  }

  // R09 门控层：作者意图 + 文风证据。默认关闭——作品里没有作者意图、也没有启用样文时这一层是 null，
  // 被下面的 filter(Boolean) 直接滤掉：层数/顺序/预算与接入前逐字节一致。
  let authorIntentLayer = null;
  let authorIntentMeta = null;
  try {
    const intents = AuthorStyle.listIntents(workId, chapter ? chapter.id : 0);
    const samples = AuthorStyle.listSamples(workId).filter((s) => s.enabled);
    const hasData = intents.some((x) => String(x.text || '').trim()) || samples.length > 0;
    if (hasData) {
      const current = AuthorStyle.getProfile(workId);
      const built = buildAuthorIntentLayer({
        intents, samples, profile: current ? current.profile : null,
        intentChars: 1600, evidenceChars: 1400,
      });
      if (built.text) {
        authorIntentLayer = L('author_intent', built.text, {
          sourceIds: built.source_ids,
          note: `意图 ${built.counts.intents} 条｜启用样文 ${built.counts.samples} 篇｜档案 ${current && !built.stale ? `hash ${String(current.profile_hash || '').slice(0, 12)}` : (built.stale ? '已过期（不采用旧数字）' : '未分析')}｜优先级：故事约束/编辑保真 > 本章契约 > 作者意图 > 通用编辑规则`,
        });
      }
      authorIntentMeta = {
        intents: built.counts.intents, samples: built.counts.samples,
        profile_hash: current && !built.stale ? current.profile_hash : null,
        profile_stale: built.stale, profile_available: !!current,
        conflicts: built.conflicts.map((c) => ({ long_term_id: c.long_term_id, other_tier: c.other_tier, other_id: c.other_id, reason: c.reason })),
        truncated: built.truncated,
        layer_chars: built.text.length,
      };
    }
  } catch (e) {
    // 意图层构建失败不能把生成路径打挂：记 warning，按「这一层没有数据」继续。
    log({ level: 'warn', layer: 'ai', kind: 'author_intent_error', message: `作者意图层构建失败（work ${workId}）：${e.message}`, context: { work_id: workId } });
  }

  const layers = [
    L('work', `${work.title}${work.description ? `\n${work.description.slice(0, 600)}` : ''}\n${workConfigText}`, { sourceIds: [work.id] }),
    L('outline', outlineText, { sourceIds: shownChapterIds }),
    L('memory', memoryBody, { sourceIds: memoryRowId ? [memoryRowId] : null, note: storyMemory ? `${storyMemory.length} 字` : '无记忆' }),
    recallLayer
      ? L('recall', recallLayer.text, {
          sourceIds: (semanticRecall.hits || []).map((h) => h.uri).filter(Boolean),
          scores: recallScores,
          note: 'score 口径 = 相关度百分比（0-100）',
        })
      : (recallGapText ? L('recall', recallGapText, { note: `缺口占位：${recallGap}` }) : null),
    (libraryRecall && libraryRecall.status === 'ok' && libraryRecall.text)
      ? L('library', libraryRecall.text, {
          sourceIds: (libraryRecall.hits || []).map((h) => h.uri).filter(Boolean),
          scores: libraryScores,
          note: '资料非本书事实；score 口径 = 相关度百分比（0-100）',
        })
      : null,
    L('events', eventsText, { sourceIds: events.map((e) => e.id) }),
    L('foreshadows', foreshadowText, { sourceIds: openForeshadows.map((e) => e.id) }),
    ...(isSettingsMode ? [] : [
      L('scene', sceneBody, { sourceIds: chapter ? [chapter.id] : null }),
      L('blueprint', blueprintText || '（暂无蓝图，可在工坊里用「AI 写作」自动生成，或直接成文）', { sourceIds: chapter && blueprintText ? [chapter.id] : null }),
      L('story_tail', storyTail, { sourceIds: storyTailSource ? [storyTailSource.id] : null, note: storyTailSource ? `${storyTailSource.which}（${storyTail.length} 字）` : '' }),
    ]),
    L('characters', charCardsText, { sourceIds: sceneIdList }),
    relationsText ? L('relations', relationsText, { sourceIds: relations.map((r) => r.id) }) : null,
    L('world', worldEntriesText, { sourceIds: worldEntries.map((w) => w.id) }),
    termEntriesText ? L('terms', termEntriesText, { sourceIds: termEntries.map((t) => t.id) }) : null,
    // 门控层：未开启的作品这里是 null，被 filter(Boolean) 直接滤掉——层数、顺序、预算都不变。
    storyStateLayer,
    // R07 门控层：编辑规则（默认关闭，见上方 editRulesLayer 的构建）
    editRulesLayer,
    // R09 门控层：作者意图与文风证据（默认关闭，见上方 authorIntentLayer 的构建）
    authorIntentLayer,
    L('redlines', styleContract, { sourceIds: redlines.map((r) => r.id) }),
  ].filter(Boolean);

  // R05：来源感知去重（默认**关闭**——旧作品既有生成行为不变）。
  // 打开 ov_recall_dedup 后，与宿主层逐字重复的召回条目从上下文里去掉；关闭时只在贡献记录里标注。
  let recallDedup = { applied: false, duplicates: [] };
  // 去重前的命中原件：打开去重后从 hits 里被移除的条目，仍要在贡献记录里留档（省下了什么、为什么省）。
  let recallHitsBeforeDedup = [];
  {
    const recallLayerRef = layers.find((l) => l && l.id === 'recall');
    if (recallLayerRef && semanticRecall && semanticRecall.status === 'ok' && Array.isArray(semanticRecall.hits) && semanticRecall.hits.length) {
      const hostLayers = layers.filter((l) => l && l.id !== 'recall' && l.text);
      const keptHits = [];
      const dupHits = [];
      recallHitsBeforeDedup = semanticRecall.hits.slice();
      for (const h of semanticRecall.hits) {
        const hostLayerId = findDuplicateLayer(h.text, hostLayers);
        if (hostLayerId) {
          dupHits.push({ uri: h.uri, rel: (h.source_meta && h.source_meta.rel) || '', code: 'duplicate_of_host_layer', reason: `与宿主层「${hostLayerId}」逐字重复（来源感知去重）`, host_layer: hostLayerId });
          continue;
        }
        keptHits.push(h);
      }
      if (dupHits.length) {
        const dedupOn = getAppSetting('ov_recall_dedup', '0') === '1';
        recallDedup = { applied: dedupOn && keptHits.length !== semanticRecall.hits.length, duplicates: dupHits };
        if (dedupOn) {
          semanticRecall = {
            ...semanticRecall,
            hits: keptHits,
            text: keptHits.map((i) => `【${i.label}】（相关度 ${i.score}%）\n${i.text}`).join('\n\n'),
            omitted: [...(Array.isArray(semanticRecall.omitted) ? semanticRecall.omitted : []), ...dupHits],
          };
          if (!keptHits.length) semanticRecall.status = 'filtered';
          recallLayerRef.text = keptHits.length
            ? semanticRecall.text
            : `（本次未能取到可用的「相关记忆检索」结果：${recallGapReason(semanticRecall) || '召回内容与宿主层重复，已按来源感知去重省略'}。）`;
        }
      }
    }
  }

  // 装配：渲染 + 每层 cap + 总预算收敛（弹性层按 FLEX_ORDER 逐档压缩，零损失层绝不参与），
  // 并产出裁剪清单。总预算的「可执行下限」由 layers.mjs 的 computeFloor() 自动核算，
  // 不再靠注释里的手算数字（历史失误 1：预算常量不核算可执行下限）。
  const {
    text: assembled,
    manifest: contextManifest,
    overflow: contextOverflow,
    stats: contextStats,
    integrity: contextIntegrity,
    envelope: contextEnvelope,
  } = assembleContext(layers, {
    mode,
    workId,
    chapterId: chapter ? chapter.id : null,
    requestId: contextOpts.requestId || newContextRequestId(),
  });

  // 完整性不合格**必须响亮**：否则"有清单"会变成一种装饰。
  // 刻意**不**在这里拦截生成——拦截会改变真实用户可观察行为，属产品决策，不由本轮自行决定；
  // 这里做的是"留下可归因的记录"，并由响应字段把结论交给界面与验收工具。
  if (contextIntegrity.status !== 'PASS') {
    const level = contextIntegrity.status === 'FAIL' ? 'error' : 'warn';
    log({
      level, layer: 'ai', kind: 'context_integrity',
      message: `上下文完整性 ${contextIntegrity.status}（第 ${contextIntegrity.failed.length} 项失败 / 第 ${contextIntegrity.warned.length} 项告警）：`
        + contextIntegrity.checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.detail}`).join('；'),
      context: {
        work_id: workId,
        chapter_id: chapter ? chapter.id : null,
        mode,
        context_id: contextEnvelope.contextId,
        request_id: contextEnvelope.requestId,
        failed: contextIntegrity.failed,
        warned: contextIntegrity.warned,
      }
    });
  }

  // ── R05：运行时上下文贡献记录（附加式观测）──────────────────────────────
  // 只记**结构**：来源 / 规则版本或层 id / 内容 hash / 长度（char）/ 去重标识 / 使用或省略原因。
  // 不记正文、不记 Prompt、不记密钥；不改 assembled、不改预算、不改层顺序。
  const contributionChapterId = chapter ? chapter.id : null;
  {
    const entries = [
      ...contextManifest.map((m) => {
        const layerRef = layers.find((l) => l && l.id === m.id);
        return layerContribution(m, { workId, chapterId: contributionChapterId, mode, text: layerRef ? layerRef.text : '' });
      }),
      ...((semanticRecall && Array.isArray(semanticRecall.hits)) ? semanticRecall.hits : []).map((h) => recallHitContribution(h, {
        workId, chapterId: contributionChapterId, dedupAction: recallDedup.applied ? 'dropped' : 'off',
      })),
      ...((semanticRecall && Array.isArray(semanticRecall.omitted)) ? semanticRecall.omitted : []).map((o) => omittedRecallContribution(o, { workId, chapterId: contributionChapterId })),
      // 被来源感知去重**实际省略**的召回（仅在作者打开去重开关时发生）：记 used=false + 重复来源 + 原因，
      // 让"省下了多少字、为什么省"可核对，而不是从记录里无声消失。
      ...(recallDedup.applied ? recallHitsBeforeDedup
        .filter((h) => recallDedup.duplicates.some((d) => d.uri === h.uri))
        .map((h) => {
          const dup = recallDedup.duplicates.find((d) => d.uri === h.uri) || {};
          const e = recallHitContribution(h, { workId, chapterId: contributionChapterId, dedupAction: 'dropped' });
          e.used = false;
          e.duplicate_of = `layer:${dup.host_layer || ''}`;
          e.omitted_reason = dup.reason || '与宿主层同源内容重复（来源感知去重）';
          return e;
        }) : []),
    ];
    // 与宿主层重复的召回：标注 duplicate_of（默认只标注不删除；打开去重时它已被排除在 hits 之外）。
    for (const dup of recallDedup.duplicates) {
      const e = entries.find((x) => x.dedup_id === `ov:${dup.uri}`);
      if (e) {
        e.duplicate_of = `layer:${dup.host_layer}`;
        if (!e.omitted_reason) e.omitted_reason = dup.reason;
        e.dedup_action = recallDedup.applied ? 'dropped' : 'marked';
      }
    }
    const contributionRecord = recordContributions(buildContributionRecord({
      workId, chapterId: contributionChapterId, mode,
      requestId: contextEnvelope.requestId, contextId: contextEnvelope.contextId,
      manifest: contextManifest, stats: contextStats, entries, overflow: contextOverflow,
    }));
    if (contributionRecord) {
      log({
        level: 'info', layer: 'ai', kind: 'context_contributions',
        message: `上下文贡献记录：${contributionRecord.layer_count} 层 / ${contributionRecord.length} 字（预算 ${contributionRecord.budget}）`
          + `；来源 ${contributionRecord.entries.length} 条，其中未使用 ${contributionRecord.entries.filter((e) => !e.used).length} 条`,
        context: {
          work_id: workId, chapter_id: contributionChapterId, mode,
          context_id: contextEnvelope.contextId, request_id: contextEnvelope.requestId,
          // 只记结构（来源 id / hash / 长度 / 使用与省略原因），不记正文与 Prompt。
          sources: contributionRecord.entries.map((e) => ({
            source: e.source, id: e.rule_id, hash: e.content_hash ? e.content_hash.slice(0, 12) : '',
            chars: e.chars, used: e.used,
            reason: e.omitted_reason || undefined, dup_of: e.duplicate_of || undefined,
          })),
          over_budget: contributionRecord.over_budget,
        }
      });
    }
  }

  return {
    ok: true,
    mode,
    work: { id: work.id, title: work.title, default_chapter_words: Number(work.default_chapter_words) || 2000, total_chapters: Number(work.total_chapters) || 0, story_structure: work.story_structure, narrative_pov: work.narrative_pov, style_positive: work.style_positive || '' },
    chapter: chapter ? { id: chapter.id, title: chapter.title, summary: chapter.summary, position: chapter.position, volume_id: chapter.volume_id, plotline_id: chapter.plotline_id, blueprint, target_words: targetWords } : null,
    prev_chapter: prevChapter ? { id: prevChapter.id, title: prevChapter.title } : null,
    next_chapter: nextChapter ? { id: nextChapter.id, title: nextChapter.title } : null,
    story_memory: storyMemory,
    needs_compression: needsCompression,
    events,
    open_foreshadows: openForeshadows.map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id, resolves_event_id: e.resolves_event_id })),
    scene_characters: sceneCharacters.map((c) => ({ id: c.id, name: c.name, identity: c.identity, status: c.status, aliases: c.aliases || '', forced: forcedIds.includes(c.id) })),
    scene_character_ids: sceneIdList,
    world_entries: worldEntries.map((w) => ({ id: w.id, title: w.title, pinned: Number(w.is_pinned) === 1, priority: Number(w.priority ?? 50), keywords: w.keywords, content_preview: String(w.content || '').slice(0, 600) })),
    terms: termEntries.map((t) => ({ id: t.id, title: t.title, category_id: t.category_id, tags: t.tags, content_preview: String(t.content || '').slice(0, 300) })),
    relations: relations.map((r) => ({ from: nameById.get(r.from_character_id) || null, to: nameById.get(r.to_character_id) || null, relation: r.relation, description: r.description })),
    redlines: redlines.map((r) => ({ kind: r.kind, pattern: r.pattern, note: r.note })),
    style_contract: styleContract,
    semantic_recall: semanticRecall ? {
      enabled: semanticRecall.enabled,
      status: semanticRecall.status,
      // D8-#5：本轮是否构成"期望有召回却没拿到"，以及上下文里插了什么占位说明。
      // 界面可以据此如实提示作者，而不是让缺口只存在于 API 的一个 status 字段里。
      gap: Boolean(recallGap),
      gap_reason: recallGap,
      hits: semanticRecall.hits || [],
      // R04：被来源校验拦下的条目（code + uri + reason）——"为什么这轮没召回它"必须可归因。
      omitted: semanticRecall.omitted || []
    } : { enabled: false, status: 'unknown', gap: false, gap_reason: '', hits: [] },
    library_recall: libraryRecall ? {
      enabled: libraryRecall.enabled,
      status: libraryRecall.status,
      // 被来源校验拦下的条目（code + uri + reason）：为什么这轮没召回资料必须可归因。
      hits: libraryRecall.hits || [],
      omitted: libraryRecall.omitted || [],
      // D4（additive）：资料索引辅助的审计摘要（候选数/扩展词数/耗时/状态）。
      // 候选清单、keywords、summary 一律不在这里返回，更不会进入模型输入。
      index_assist: libraryRecall.index_assist || null
    } : { enabled: false, status: 'unknown', hits: [] },
    assembled,
    // P2 新增（additive，旧消费方不受影响）：
    //   context_manifest  逐层裁剪清单——零损失审计的依据（每层原始长 / 采用长 / 占用 / 被裁字数）
    //   context_overflow  压到下限仍超预算时的显式标记（契约 I1：不静默超限）
    //   context_stats     装配统计（预算 / 实际长度 / 截断层数 / 被裁总字数 / 收缩步数）
    context_manifest: contextManifest,
    context_overflow: contextOverflow,
    context_stats: contextStats,
    // 2026-09-24 新增（additive）：
    //   context_id        内容哈希（同一份上下文永远同一个 id → 可复现、可对照）
    //   context_request_id 这一次调用的身份（"界面上这份上下文是哪次调用发出去的"）
    //   context_integrity PASS / WARNING / FAIL —— 清单与真正发出去的文字是否自洽
    //   context_envelope  身份 + 预算 + selected / trimmed / excluded（清单的信封）
    context_id: contextEnvelope.contextId,
    context_request_id: contextEnvelope.requestId,
    context_integrity: contextIntegrity,
    context_envelope: contextEnvelope,
    // 门控字段（additive）：作品未打开「确定性故事状态」开关时恒为 null，
    // 既有消费方读到的 JSON 与接入前一致（多一个 null 字段，语义无变化）。
    story_state: storyStateMeta,
    // R07：编辑规则层元信息（关闭时为 null，与 story_state 同口径）。R05 贡献记录里另有 layer:edit_rules 条目。
    edit_rules: editRulesMeta,
    // R09：作者意图层元信息（没有数据时为 null，与 story_state/edit_rules 同口径）。
    // conflicts 非空 = 本章/阶段意图可能抵消长期硬约束，界面必须提示作者裁决，而不是自动取舍。
    author_intent: authorIntentMeta,
    // A/C/D/E（additive）：本次装配的检索审计。
    // ⚠️ 两个计数在结构上就是两组字段（集成点③），任何消费方不得把它们合并成一个「调用次数」：
    //   retrieval_stats.library_recall.searches = 真实资料召回次数
    //   retrieval_stats.index_queries.total    = 索引查询次数（含资料索引与资产索引）
    // retrieval_plan 只记录计划摘要与匹配统计；它不是新的上下文层，不参与 assembled。
    retrieval_stats: finalizeRetrievalStats(retrievalAcc),
    retrieval_plan: retrievalPlanMeta
  };
}

// 🐞 运行追踪：创作内核的上下文装配是最重的一段（分层预算 + 语义召回 + 缓存），单列节点。
buildNovelContext = traceFn('buildNovelContext（创作上下文装配）', buildNovelContext, { kind: 'fn', slowMs: 500 });

// 记忆增量更新辅助：在“已有摘要”基础上合并一段“本批次进展”，返回新的摘要文本。
// 只负责文本拼接约定，真正的语义压缩由模型完成；本函数供插件生成可写入的 summary。
function mergeMemoryDraft(prevSummary, deltaEventsText) {
  const base = (prevSummary || '').trim();
  const delta = (deltaEventsText || '').trim();
  if (!delta) return base;
  if (!base) return delta;
  // 新事件置顶、旧摘要压缩保留——模型侧负责进一步精简，这里只做安全合并。
  return `${delta}\n\n【此前进度】${base}`;
}

// ---------- 章节审稿（审稿→确认清单→修稿→差异合并） ----------
/**
 * @param {object} report 结构化审稿报告
 * @param {{ rawText?: string, status?: string }} [extra]
 *   rawText：AI 返回的无法解析的原文。宁可存原文也不丢 —— 一轮审稿要等好几分钟，
 *   因为 JSON 里多一个引号就整份丢弃，是 2026-09-14 真实事故的根因。
 */
function saveReview(workId, chapterId, report, extra = {}) {
  const payload = report && typeof report === 'object' ? { ...report } : {};
  const rawText = asString(extra.rawText, '').slice(0, 200000);
  if (rawText && !asString(payload.raw_text, '')) payload.raw_text = rawText;
  const status = ['parsed', 'raw'].includes(extra.status) ? extra.status : (rawText ? 'raw' : 'parsed');
  const json = JSON.stringify(payload);
  const info = prepare(`
    INSERT INTO chapter_reviews (work_id, chapter_id, report_json, checklist_json, status)
    VALUES (?, ?, ?, '{}', ?)
  `).run(workId, chapterId, json, status);
  // 每个章节只保留最近 10 份审稿
  prepare(`
    DELETE FROM chapter_reviews WHERE chapter_id = ? AND id NOT IN (
      SELECT id FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 10
    )
  `).run(chapterId, chapterId);
  return Number(info.lastInsertRowid);
}

// 审稿报告解析（服务端侧）：严格 JSON 失败时逐字段抢救。
// 必须与前端 extractReviewFromText 同源同义：一轮审稿要跑几分钟，模型返回的 JSON
// 里只要多一个引号，严格解析就会失败、整份报告作废（2026-09-14 真实事故）。
function salvageJSONString(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return '';
  let i = src.indexOf(':', at) + 1;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] !== '"') return '';
  i += 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      i += 2;
      continue;
    }
    if (c === '"') {
      const rest = src.slice(i + 1).replace(/^[\s,]+/, '');
      if (rest.startsWith('}') || rest.startsWith(']') || /^"[A-Za-z_]+"\s*:/.test(rest)) break;
      if (src[i + 1] === '"') { i += 1; continue; }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out.trim().replace(/["']+$/, '');
}

function salvageJSONList(src, key) {
  const at = String(src).indexOf(`"${key}"`);
  if (at < 0) return [];
  const open = src.indexOf('[', at);
  if (open < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end < 0 ? src.length : end);
  const out = [];
  let cursor = 0;
  for (;;) {
    const t = body.indexOf('"text"', cursor);
    if (t < 0) break;
    const val = salvageJSONString(body.slice(Math.max(0, t - 1)), 'text');
    if (val && !out.includes(val)) out.push(val);
    cursor = t + 6;
  }
  return out;
}

/** 把 AI 的审稿输出变成 { summary, issues, strengths }；救不回来时返回 null。 */
function parseReviewText(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1);
    let obj = null;
    try { obj = JSON.parse(slice); } catch (_) {
      try { obj = JSON.parse(slice.replace(/"\s*,\s*"/g, '","').replace(/"\s*,\s*([}\]])/g, '"$1')); } catch (_) { obj = null; }
    }
    if (obj && (asString(obj.summary, '').trim() || Array.isArray(obj.issues))) {
      return {
        summary: asString(obj.summary, ''),
        issues: asArray(obj.issues).map((x) => asString(typeof x === 'string' ? x : x?.text, '')).filter(Boolean),
        strengths: asArray(obj.strengths).map((x) => asString(typeof x === 'string' ? x : x?.text, '')).filter(Boolean)
      };
    }
  }
  const body = start >= 0 ? s.slice(start) : s;
  const salvaged = { summary: salvageJSONString(body, 'summary'), issues: salvageJSONList(body, 'issues'), strengths: salvageJSONList(body, 'strengths') };
  return (salvaged.summary || salvaged.issues.length) ? salvaged : null;
}

function getLatestReview(chapterId) {  const row = prepare('SELECT * FROM chapter_reviews WHERE chapter_id = ? ORDER BY id DESC LIMIT 1').get(chapterId);
  if (!row) return null;
  let report = {}; let checklist = {};
  try { report = JSON.parse(row.report_json || '{}'); } catch (_) {}
  try { checklist = JSON.parse(row.checklist_json || '{}'); } catch (_) {}
  return { id: row.id, chapter_id: row.chapter_id, report, checklist, status: row.status, created_at: row.created_at };
}

function setReviewChecklist(reviewId, checklist) {
  const row = prepare('SELECT * FROM chapter_reviews WHERE id = ?').get(reviewId);
  if (!row) return null;
  const json = JSON.stringify(checklist && typeof checklist === 'object' ? checklist : {});
  prepare('UPDATE chapter_reviews SET checklist_json = ?, status = ? WHERE id = ?').run(json, 'confirmed', reviewId);
  return Number(reviewId);
}

// ---------- 导入：TXT/Markdown/EPUB → 新建作品自动拆章 ----------
const CHAPTER_HEAD_RE = /^\s*(?:第\s*[0-9一二三四五六七八九十百千零两]+\s*[章回节卷部集]|(?:Chapter|CHAPTER)\s+\d+|序章|楔子|尾声|终章|番外)(?:[：:、\s]+.*)?$/;

function splitTextIntoCapters(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let current = null;
  let preamble = [];
  const flush = () => { if (current) chapters.push(current); };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= 60 && CHAPTER_HEAD_RE.test(trimmed)) {
      flush();
      current = { title: trimmed, content: '' };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    } else {
      preamble.push(line);
    }
  }
  flush();
  const pre = preamble.join('\n').trim();
  if (pre) {
    if (chapters.length) chapters[0].content = pre + '\n' + chapters[0].content;
    else chapters.push({ title: '第一章', content: pre });
  }
  return chapters.map((c) => ({ title: c.title, content: c.content.trim() })).filter((c) => c.content || c.title);
}

// 🐞 运行追踪：导入拆章（大文件、正则密集）单独成节点。
splitTextIntoCapters = traceFn('splitTextIntoCapters（导入拆章）', splitTextIntoCapters, { kind: 'fn', slowMs: 300 });

// 纯文本 → 编辑器 HTML（段落 <p>）。
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// EPUB → { title, chapters: [{title, content}] }（零依赖 zip 读取）。
function xmlDecode(s = '') {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function parseEpub(buffer) {
  const entries = readZip(buffer);
  const rawContainer = entries.get('META-INF/container.xml');
  if (!rawContainer) throw new Error('EPUB 缺少 META-INF/container.xml');
  // R12：EPUB 内部按严格 UTF-8 解码（非法编码安全失败，不猜编码）；路径一律解析后再判越界。
  const containerText = ImportGuard.decodeTextStrict(rawContainer, { label: 'EPUB container.xml', maxChars: 64 * 1024 });
  const rootPath = ImportGuard.resolveArchivePath('', xmlDecode(containerText.match(/full-path=["']([^"']+)["']/)?.[1] || '').trim(), { label: 'EPUB opf 路径' });
  if (!rootPath) throw new Error('EPUB 无法定位 opf 文件');
  const rawOpf = entries.get(rootPath);
  if (!rawOpf) throw new Error('EPUB 缺少 opf 文件');
  const opf = ImportGuard.decodeTextStrict(rawOpf, { label: 'EPUB opf', maxChars: ImportGuard.IMPORT_LIMITS.max_document_chars });
  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || '')
    .replace(/<[^>]*>/g, '').trim() || '导入的 EPUB';
  // 兼容命名空间（<opf:item>）与属性任意顺序：分别捕获 id/href/idref 再组装。
  const attrOf = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
  const manifest = {};
  for (const m of opf.matchAll(/<[\w:]*item\b[^>]*\/?>/g)) {
    const id = attrOf(m[0], 'id');
    const href = attrOf(m[0], 'href');
    if (id && href) manifest[id] = xmlDecode(href);
  }
  const spine = [];
  for (const m of opf.matchAll(/<[\w:]*itemref\b[^>]*\/?>/g)) {
    const idref = attrOf(m[0], 'idref');
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }
  if (!spine.length) throw new Error('EPUB spine 为空');
  const opfDir = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
  const chapters = [];
  for (const href of spine) {
    let rel = href;
    try { rel = decodeURIComponent(rel); } catch (_) { /* 保留原样 */ }
    const full = ImportGuard.resolveArchivePath(opfDir, rel, { label: 'EPUB 正文路径' });
    const rawHtml = entries.get(full);
    if (!rawHtml) continue;
    const html = ImportGuard.decodeTextStrict(rawHtml, { label: `EPUB 正文（${full}）`, maxChars: ImportGuard.IMPORT_LIMITS.max_document_chars });
    const text = htmlToPlain(html);
    if (!text) continue;
    const head = (html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/)?.[1] || '').replace(/<[^>]*>/g, '').trim();
    chapters.push({ title: head || `第 ${chapters.length + 1} 节`, content: text });
  }
  if (!chapters.length) throw new Error('EPUB 未解析出任何章节内容');
  return { title, chapters };
}

function importWorkFromChapters(title, chapters, description = '') {
  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title: title.trim() || '导入的作品', description });
    chapters.forEach((ch, i) => {
      insertRow('chapters', {
        work_id: workId,
        title: String(ch.title || `第 ${i + 1} 章`).slice(0, 80),
        summary: '',
        content: textToHtml(ch.content),
        position: i
      });
    });
    db.exec('COMMIT');
    return workId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 导出：整书 TXT / 整书 Markdown / 单章 TXT ----------
function buildWorkExport(workId, fmt) {
  const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) return null;
  const volumes = prepare('SELECT * FROM volumes WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const chapters = prepare('SELECT * FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
  const volName = (id) => volumes.find((v) => v.id === id)?.title || '';
  const lines = [];
  if (fmt === 'md') {
    lines.push(`# ${work.title}`, '');
    if (work.description) lines.push(`> ${work.description}`, '');
    let lastVol = null;
    for (const c of chapters) {
      const v = volName(c.volume_id);
      if (v && v !== lastVol) { lines.push('', `## ${v}`, ''); lastVol = v; }
      lines.push(`### ${c.title}`, '');
      if (c.summary) lines.push(`> ${c.summary}`, '');
      const plain = htmlToPlain(c.content || '');
      if (plain) lines.push(plain, '');
    }
  } else {
    lines.push(`${work.title}`, work.description ? `简介：${work.description}` : '', '');
    let lastVol = null;
    for (const c of chapters) {
      const v = volName(c.volume_id);
      if (v && v !== lastVol) { lines.push('', `【卷】${v}`, ''); lastVol = v; }
      lines.push(`【${c.title}】`, '');
      if (c.summary) lines.push(`（摘要：${c.summary}）`, '');
      const plain = htmlToPlain(c.content || '');
      if (plain) lines.push(plain, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function buildChapterExport(chapterId) {
  const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
  if (!chapter) return null;
  const work = prepare('SELECT title FROM works WHERE id = ?').get(chapter.work_id);
  const lines = [`${work?.title || ''} · ${chapter.title}`, ''];
  if (chapter.summary) lines.push(`（摘要：${chapter.summary}）`, '');
  lines.push(htmlToPlain(chapter.content || ''));
  return lines.join('\n').trim() + '\n';
}

// ---------- 示例小说一键导入（演示数据 demo-data.json） ----------
// 与脚本版 demo/seed-demo.js 等价，走数据库直写；UI 入口在“我的作品”页。
const DEMO_TITLE = '雾都缝匠';
let _demoData = null;

function demoDataJson() {
  if (_demoData === null) {
    try {
      _demoData = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-data.json'), 'utf8'));
    } catch (e) {
      _demoData = { err: `${e && e.code ? e.code + ': ' : ''}${(e && e.message) || e}` }; // 文件缺失/损坏时给出可读错误
    }
  }
  return _demoData;
}

function demoFindWork(title) {
  return prepare('SELECT id FROM works WHERE title = ?').get(title) || null;
}

function deleteDemoWork(title) {
  const row = demoFindWork(title);
  if (!row) return false;
  deleteRow('works', row.id);
  return true;
}

// 导入示例作品；force=true 时先删除同名作品再重建。
function installDemo(force) {
  const data = demoDataJson();
  if (!data) throw new Error('缺少演示数据文件 demo-data.json（请与 server.js 放在同一目录）');
  if (data.err) throw new Error(`演示数据读取失败：${data.err}`);
  const title = asString(data.work.title, DEMO_TITLE);
  if (demoFindWork(title)) {
    if (!force) throw new Error(`示例《${title}》已存在；如需覆盖请用重新导入`);
    deleteDemoWork(title);
  }

  const idMap = { volume: new Map(), plotline: new Map(), category: new Map(), character: new Map(), chapter: new Map() };

  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title, description: asString(data.work.description), author_note: asString(data.work.author_note) });

    (data.volumes || []).forEach((v, i) => {
      idMap.volume.set(v.title, insertRow('volumes', { work_id: workId, title: asString(v.title, `卷${i + 1}`), summary: asString(v.summary), position: i }));
    });
    (data.plotlines || []).forEach((p, i) => {
      const rawTitle = asString(p.title, `线${i + 1}`);
      const title = stripPlotlinePrefix(rawTitle);
      const id = insertRow('plotlines', { work_id: workId, title, kind: p.kind === 'side' ? 'side' : 'main', summary: asString(p.summary), position: i });
      idMap.plotline.set(rawTitle, id);
      idMap.plotline.set(title, id);
    });
    (data.categories || []).forEach((c, i) => {
      idMap.category.set(c.name, insertRow('categories', { work_id: workId, name: asString(c.name, `分类${i + 1}`), color: asString(c.color, '#6366f1'), position: i }));
    });
    (data.terms || []).forEach((t) => {
      insertRow('terms', { work_id: workId, category_id: idMap.category.get(t.category) ?? null, title: asString(t.title, '词条'), content: asString(t.content), tags: asString(t.tags) });
    });
    (data.characters || []).forEach((c) => {
      idMap.character.set(c.name, insertRow('characters', {
        work_id: workId, name: asString(c.name, '角色'),
        identity: asString(c.identity), appearance: asString(c.appearance), personality: asString(c.personality),
        background: asString(c.background), status: asString(c.status), avatar_color: asString(c.avatar_color, '#8b5cf6'),
        mes_example: asString(c.mes_example), tags: asString(c.tags), system_prompt: asString(c.system_prompt), aliases: asString(c.aliases)
      }));
    });
    (data.relations || []).forEach((r) => {
      const fromId = idMap.character.get(r.from);
      const toId = idMap.character.get(r.to);
      if (!fromId || !toId) return;
      insertRow('relations', { work_id: workId, from_character_id: fromId, to_character_id: toId, relation: asString(r.relation), description: asString(r.description) });
    });
    (data.worldEntries || []).forEach((w, i) => {
      insertRow('world_entries', { work_id: workId, title: asString(w.title, `设定${i + 1}`), content: asString(w.content), keywords: asString(w.keywords), is_pinned: Number(w.is_pinned) ? 1 : 0, priority: Number(w.priority) || 50, position: i });
    });
    (data.plotlineCharacters || []).forEach((pc) => {
      const cId = idMap.character.get(pc.character);
      const pId = idMap.plotline.get(pc.plotline);
      if (!cId || !pId) return;
      insertRow('plotline_characters', { work_id: workId, plotline_id: pId, character_id: cId, status: asString(pc.status), notes: asString(pc.notes) });
    });
    (data.chapters || []).forEach((ch, i) => {
      const id = insertRow('chapters', {
        work_id: workId,
        volume_id: idMap.volume.get(ch.volume) ?? null,
        plotline_id: idMap.plotline.get(ch.plotline) ?? null,
        parent_id: null,
        title: asString(ch.title, `第${i + 1}节`),
        summary: asString(ch.summary),
        content: textToHtml(ch.content),
        position: i
      });
      idMap.chapter.set(ch.title, id);
    });
    // 长期记忆与事件账本一并纳入同一事务（tx:true），任一步失败整体回滚，
    // 避免「作品已建但无记忆/事件」的半成品状态。
    let eventCount = 0;
    if (data.memory && asString(data.memory.summary)) {
      saveStoryMemory(workId, asString(data.memory.summary), { source: asString(data.memory.source, 'manual') || 'manual', note: asString(data.memory.note, '示例导入'), tx: true });
    }
    (data.events || []).forEach((e) => {
      addStoryEvent(workId, { chapterId: idMap.chapter.get(e.chapter) ?? null, kind: asString(e.kind, 'event'), summary: asString(e.summary), payload: e.payload || {}, tx: true });
      eventCount += 1;
    });

    db.exec('COMMIT');
    touchWork(workId);

    return {
      work_id: workId, title,
      counts: {
        volumes: (data.volumes || []).length,
        plotlines: (data.plotlines || []).length,
        categories: (data.categories || []).length,
        terms: (data.terms || []).length,
        characters: (data.characters || []).length,
        world_entries: (data.worldEntries || []).length,
        chapters: (data.chapters || []).length,
        events: eventCount
      }
    };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 事务可能未开始 */ }
    throw e;
  }
}

// 🐞 运行追踪：示例导入会一次性写数百行数据，单列节点便于看清初始化耗时。
installDemo = traceFn('installDemo（导入示例小说）', installDemo, { kind: 'fn', slowMs: 500 });

// ---------- AI auto-create novel ----------
function extractJSON(text) {
  if (!text) throw new Error('AI 没有返回内容');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text.trim());
}

function asString(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v).trim();
}

// D5：剧情线标题前缀剥离（“主线：/支线：”由界面按 kind 显示，存储时不带前缀，避免“主线：主线：…”）
function stripPlotlinePrefix(title) {
  return String(title || '').replace(/^(?:主线|支线)\s*[:：]\s*/, '').trim();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function resolveRef(ref, names, idMap) {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'number') {
    const name = names[ref];
    return name ? (idMap.get(name) ?? null) : null;
  }
  return idMap.get(String(ref).trim()) ?? null;
}

const NOVEL_GENERATION_SYSTEM_PROMPT = `你是一位资深小说设定生成器。用户会给你一段关于小说的描述，你需要帮他把这段描述完善成一本轻量小说的完整设定，并自动填充各栏目。

要求：
- 轻量快速规模：角色 3-6 个，设定词条 5-10 条，章节 3-8 个，剧情线 1-3 条。
- 如果用户提供的信息不足，可以合理补全，但不要和用户明显冲突；确实没有的内容可以省略或留空。
- 正文草稿：只在第一个章节的 content 字段里写一段 500-800 字左右的正文种子草稿；其他章节 content 留空字符串。（正式整章 2000 字以上请使用工坊内的「AI 写作」生成。）
- 只输出一个 JSON 对象，不要输出任何解释、不要 Markdown 代码块。

JSON 结构：
{
  "title": "作品名",
  "description": "作品简介",
  "volumes": [{ "title": "卷名", "summary": "卷简介" }],
  "plotlines": [{ "title": "剧情线名", "kind": "main 或 side", "summary": "简介" }],
  "categories": [{ "name": "分类名", "color": "#16进制颜色" }],
  "terms": [{ "title": "词条名", "category": "分类名或空", "content": "详细介绍", "tags": "逗号分隔标签" }],
  "characters": [{ "name": "姓名", "identity": "身份", "appearance": "外貌", "personality": "性格", "background": "背景", "status": "当前状态" }],
  "relations": [{ "from": "角色名A", "to": "角色名B", "relation": "关系", "description": "描述" }],
  "chapters": [{ "title": "章节名", "summary": "大纲摘要", "volume": "卷名或空", "plotline": "剧情线名或空", "content": "正文草稿" }],
  "plotline_characters": [{ "character": "角色名", "plotline": "剧情线名", "status": "在该剧情线中的状态", "notes": "备注" }]
}`;

// AI 自动创建小说主流程：调用模型 → 解析 JSON → 事务写入数据库。
async function generateNovelFromPrompt(prompt, config) {
  if (!prompt || !prompt.trim()) throw new Error('请输入一段小说描述');
  const messages = [
    { role: 'system', content: NOVEL_GENERATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt.trim() }
  ];

  let data;
  try {
    const ai = await callAI(config, messages, { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS });
    data = extractJSON(ai?.choices?.[0]?.message?.content || '');
  } catch (e) {
    // 仅对网络/超时/解析类错误重试一次；认证（401）等确定性错误直接抛出，避免浪费一次付费调用。
    const retryable = !e.status || e.status >= 500 || /timeout|abort|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|JSON|没有返回内容/i.test(String(e?.message || ''));
    if (!retryable) throw e;
    const retryMessages = [
      { role: 'system', content: NOVEL_GENERATION_SYSTEM_PROMPT + '\n\n请严格只输出 JSON，不要包含 ```json 标记，不要输出任何其他文字。' },
      { role: 'user', content: `请根据以下描述生成小说设定 JSON：\n\n${prompt.trim()}` }
    ];
    const ai = await callAI(config, retryMessages, { temperature: 0.3, max_tokens: MAX_OUTPUT_TOKENS });
    data = extractJSON(ai?.choices?.[0]?.message?.content || '');
  }

  return createNovelFromData(data);
}

// 把 AI 产出的简介整理成适合卡片展示的短摘要（D4：避免整篇 Markdown 存入 description）。
function shortDescription(text = '') {
  const plain = String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const first = plain.find((p) => p.length > 0) || '';
  return first.length > 160 ? first.slice(0, 160) + '…' : first;
}

// 把 AI 返回的小说设定 JSON 写入数据库。
function createNovelFromData(data) {
  const title = asString(data.title, '未命名作品');
  const description = shortDescription(asString(data.description, ''));

  db.exec('BEGIN');
  try {
    const workId = insertRow('works', { title, description });

    // 分类
    const categories = asArray(data.categories);
    const categoryIdByName = new Map();
    const categoryNames = [];
    categories.forEach((c, i) => {
      const name = asString(c.name, `分类${i + 1}`);
      const id = insertRow('categories', { work_id: workId, name, color: asString(c.color, '#6366f1'), position: i });
      categoryIdByName.set(name, id);
      categoryNames.push(name);
    });

    // 卷
    const volumes = asArray(data.volumes);
    const volumeIdByName = new Map();
    const volumeNames = [];
    volumes.forEach((v, i) => {
      const name = asString(v.title, `第${i + 1}卷`);
      const id = insertRow('volumes', { work_id: workId, title: name, summary: asString(v.summary), position: i });
      volumeIdByName.set(name, id);
      volumeNames.push(name);
    });

    // 剧情线
    const plotlines = asArray(data.plotlines);
    const plotlineIdByName = new Map();
    const plotlineNames = [];
    plotlines.forEach((p, i) => {
      const name = asString(p.title, `剧情线${i + 1}`);
      const kind = asString(p.kind) === 'side' ? 'side' : 'main';
      const id = insertRow('plotlines', { work_id: workId, title: stripPlotlinePrefix(name), kind, summary: asString(p.summary), position: i });
      plotlineIdByName.set(name, id);
      plotlineNames.push(name);
    });

    // 角色
    const characters = asArray(data.characters);
    const charIdByName = new Map();
    const charNames = [];
    characters.forEach((c, i) => {
      const name = asString(c.name, `角色${i + 1}`);
      const id = insertRow('characters', {
        work_id: workId,
        name,
        identity: asString(c.identity),
        appearance: asString(c.appearance),
        personality: asString(c.personality),
        background: asString(c.background),
        status: asString(c.status),
        avatar_color: '#8b5cf6',
        aliases: asString(c.aliases)
      });
      charIdByName.set(name, id);
      charNames.push(name);
    });

    // 设定词条
    const terms = asArray(data.terms);
    terms.forEach((t, i) => {
      const titleText = asString(t.title, `词条${i + 1}`);
      const catRef = resolveRef(t.category, categoryNames, categoryIdByName);
      insertRow('terms', {
        work_id: workId,
        category_id: catRef,
        title: titleText,
        content: asString(t.content),
        tags: asString(t.tags)
      });
    });

    // 章节/场景
    const chapters = asArray(data.chapters);
    chapters.forEach((ch, i) => {
      const titleText = asString(ch.title, `第${i + 1}章`);
      const volRef = resolveRef(ch.volume, volumeNames, volumeIdByName);
      const plRef = resolveRef(ch.plotline, plotlineNames, plotlineIdByName);
      insertRow('chapters', {
        work_id: workId,
        volume_id: volRef,
        plotline_id: plRef,
        parent_id: null,
        title: titleText,
        summary: asString(ch.summary),
        content: asString(ch.content),
        position: i
      });
    });

    // 人物关系
    const relations = asArray(data.relations);
    relations.forEach((r) => {
      const fromId = resolveRef(r.from, charNames, charIdByName);
      const toId = resolveRef(r.to, charNames, charIdByName);
      if (!fromId || !toId) return;
      insertRow('relations', {
        work_id: workId,
        from_character_id: fromId,
        to_character_id: toId,
        relation: asString(r.relation),
        description: asString(r.description)
      });
    });

    // 剧情线级角色状态
    const plotlineCharacters = asArray(data.plotline_characters);
    plotlineCharacters.forEach((pc) => {
      const charId = resolveRef(pc.character, charNames, charIdByName);
      const plId = resolveRef(pc.plotline, plotlineNames, plotlineIdByName);
      if (!charId || !plId) return;
      insertRow('plotline_characters', {
        work_id: workId,
        plotline_id: plId,
        character_id: charId,
        status: asString(pc.status),
        notes: asString(pc.notes)
      });
    });

    db.exec('COMMIT');
    return { work_id: workId, title };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 通过 DeepSeek Harness 生成完整小说并写入数据库。
// reasoningEffort：调用方（/harness/job 的命名任务）按档位下发；**必须继续往下透传**，
// 否则模型档位合并后质量档就失去了唯一的补偿信号（2026-09-18 重审抓到的缺陷）。
async function generateNovelFromHarness(prompt, model, onChunk, signal, reasoningEffort) {
  if (!prompt || !prompt.trim()) throw new Error('请输入一段小说描述');
  const task = `${NOVEL_GENERATION_SYSTEM_PROMPT}\n\n请根据以下描述生成小说设定 JSON：\n\n${prompt.trim()}`;
  // D8-#4：改用**带进度**的入口并把 chunk 转给调用方。
  // 此前用的是 runHarnessTask（无 onChunk）——即便任务进了作业设施，tail 也永远是空的，
  // 界面同样看不到进展。任务能被观测的前提是执行路径真的把过程吐出来。
  // ⚠️ 还要把 abort `signal` 透下去：作业设施的取消是"abort → 子进程被杀 → 抛
  // HARNESS_CANCELLED"，不透传的话取消按钮点了也没用（作业会一直 running）。
  const output = await runHarnessTaskWithProgress(
    task,
    { timeout: LONG_AI_TIMEOUT_MS, model: model || undefined, reasoningEffort: reasoningEffort || undefined, signal },
    typeof onChunk === 'function' ? onChunk : undefined);
  const data = extractJSON(output);
  return createNovelFromData(data);
}

// ---------- Harness 任务队列（D1：AI 任务进度） ----------
// POST /harness/run 立即入队返回 job_id，任务在后台执行；
// 前端轮询 GET /harness/job?id= 获取状态、耗时与最近输出。
// D7：任务支持取消（POST /harness/cancel），杀掉 dsh 子进程树后状态置为 cancelled。
const harnessJobs = new Map(); // jobId -> { id, status, started_at, finished_at, output, scan, proposals, error, tail }

// ---------- harness 并发闸门（唯一入口）----------
// 闸门的意图是「防止刷出大量 dsh 子进程拖垮机器」。但此前只有 /harness/run 走作业设施、
// 被计数；另有两条路由**不建 job、直接**跑 harness（经 withHarnessSlot 占位），此前完全绕过闸门：
//   · POST /harness/generate_novel
//   · POST /story_memory/compress
// 现在它们也要占一个槽位（directHarnessRuns 计数）；闸门值抽成常量，不再在两处各写一个 2。
const HARNESS_CONCURRENCY = 2;
let directHarnessRuns = 0; // 不走作业设施、直接跑 harness 的在途请求数

/** 当前 harness 负载 = 排队/运行中的作业数 + 直接跑的在途数。 */
function harnessLoad() {
  const jobCount = [...harnessJobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  return jobCount + directHarnessRuns;
}

/**
 * 占用一个并发槽位执行 fn；无空位时抛 429。
 * 检查与自增之间没有 await，单线程下即为原子操作。
 */
async function withHarnessSlot(fn) {
  if (harnessLoad() >= HARNESS_CONCURRENCY) {
    const err = new Error(`已有任务运行中，请稍后再试（并发上限 ${HARNESS_CONCURRENCY}）`);
    err.status = 429;
    throw err;
  }
  directHarnessRuns += 1;
  try {
    return await fn();
  } finally {
    directHarnessRuns -= 1;
  }
}

// ---------- 长任务落库（「刷新/重启后续接」的地基） ----------
// 内存里的 harnessJobs 一重启就没了，而一次成文/审稿要跑几分钟。
// 这里把 id/归属/状态/产出持久化，使「刷新页面」甚至「重启服务」后
// 仍能看见任务是否在跑、并把已完成的结果取回来应用。
function persistHarnessJob(job) {
  try {
    prepare(`
      INSERT INTO harness_jobs (id, work_id, chapter_id, kind, stage, status, output, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        output = excluded.output,
        error = excluded.error,
        stage = excluded.stage,
        updated_at = excluded.updated_at
    `).run(
      job.id,
      job.workId || null,
      job.chapterId || null,
      job.kind || 'harness',
      job.stage || '',
      job.status || 'queued',
      // 只在完成时存产出：中途不存半截正文，避免"半个章节"被当成结果应用
      job.status === 'done' ? String(job.output || '') : (job.status === 'failed' || job.status === 'timeout' ? String(job.output || '') : ''),
      job.error ? String(job.error).slice(0, 4000) : '',
      job.created_at || now(),
      now()
    );
    // 行数上限：每条 done 任务都带着整章正文（可达数万字符），表会无限增长。
    // 只保留最近 100 条；更早的任务即使被清掉，产出早已通过草稿/审稿表归档。
    prepare(`
      DELETE FROM harness_jobs WHERE id NOT IN (
        SELECT id FROM harness_jobs ORDER BY updated_at DESC LIMIT 100
      )
    `).run();
  } catch (e) {
    log({ level: 'warn', layer: 'server', kind: 'harness_job_persist_failed', message: `长任务落库失败：${e.message}` });
  }
}

/** 标记任务产出已被应用：恢复条不再把它当「结果待应用」展示。 */
function markHarnessJobApplied(jobId) {
  try {
    prepare(`
      UPDATE harness_jobs SET kind = kind || ':applied', updated_at = ?
      WHERE id = ? AND kind NOT LIKE '%:applied'
    `).run(now(), String(jobId));
  } catch (_) { /* 标记失败只影响恢复条显示 */ }
}

/** 可续接的长任务：运行中的 + 最近完成但还没被应用的。 */
function listRecoverableJobs(workId) {
  const rows = prepare(`
    SELECT id, work_id, chapter_id, kind, stage, status, error, updated_at,
           CASE WHEN status = 'done' THEN 1 ELSE 0 END AS has_output,
           length(output) AS output_chars
    FROM harness_jobs
    WHERE (? IS NULL OR work_id = ?)
      AND kind NOT LIKE '%:applied'
      AND (status IN ('queued', 'running') OR (status = 'done' AND length(output) > 0)
           OR status IN ('failed', 'timeout', 'cancelled'))
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(workId ?? null, workId ?? null);
  // 服务重启后内存里没有的任务标成 interrupted：进程已经没了，任务不可能还在跑。
  return rows.map((r) => {
    const live = harnessJobs.get(r.id);
    const status = live ? live.status : ((r.status === 'queued' || r.status === 'running') ? 'interrupted' : r.status);
    return {
      id: r.id,
      work_id: r.work_id,
      chapter_id: r.chapter_id,
      kind: r.kind,
      stage: r.stage,
      status,
      // ⚠️ 只有真正还在排队/运行中的任务才能「接回进度」。
      // 旧实现 `resumable: !!live` 把任何仍在内存里的任务（包括已完成/已失败的）
      // 都标成可续接，前端会对 done 任务显示「接回进度」按钮。
      resumable: !!live && (live.status === 'queued' || live.status === 'running'),
      has_output: r.has_output === 1,
      output_chars: r.output_chars || 0,
      error: r.error || '',
      updated_at: r.updated_at
    };
  });
}

/** 取回一条长任务：内存里有就优先用内存（进度最新），否则回落到库里的产出。 */
function getRecoverableJob(jobId) {
  const live = harnessJobs.get(String(jobId));
  if (live) {
    return {
      id: live.id, status: live.status, kind: live.kind || 'harness', stage: live.stage || '',
      chapter_id: live.chapterId || null, work_id: live.workId || null,
      elapsed_ms: live.started_at ? (live.finished_at || Date.now()) - live.started_at : 0,
      tail: live.tail.slice(-600),
      output: live.status === 'done' ? (live.output || '') : '',
      error: live.error || '', resumable: live.status === 'queued' || live.status === 'running',
      restart_lost: false
    };
  }
  const row = prepare('SELECT * FROM harness_jobs WHERE id = ?').get(String(jobId));
  if (!row) return null;
  return {
    id: row.id,
    // 服务重启后库里仍是 running 的任务：进程已不在，如实报告为 interrupted
    status: (row.status === 'queued' || row.status === 'running') ? 'interrupted' : row.status,
    kind: row.kind || 'harness',
    stage: row.stage || '',
    chapter_id: row.chapter_id,
    work_id: row.work_id,
    elapsed_ms: 0,
    tail: '',
    output: row.status === 'done' ? (row.output || '') : '',
    error: row.error || '',
    resumable: false,
    restart_lost: row.status === 'queued' || row.status === 'running'
  };
}

// ── R05：DSH 侧规则贡献（最终请求证据的插件部分）─────────────────────────────
// 记录「这次 harness 请求会加载哪一版小说规则」：persona / patch / 工具面清单的 hash 与长度。
// 只读 bundle 的声明文件；不读会话内容、不记正文、不记密钥。规则文件改动后 hash 自然变化，
// 于是"实际发出去的请求用了哪一版规则"可对照（而不是只检查 dump-config）。
let dshBundleCache = { at: 0, entries: [] };
function dshRuleSources() {
  const now = Date.now();
  if (now - dshBundleCache.at < 5000 && dshBundleCache.entries.length) return dshBundleCache.entries;
  const base = path.join(__dirname, 'harness-plugins', 'novel-writing');
  const entries = dshBundleRuleEntries(base); // 单点：与记录模块共用同一读取实现
  dshBundleCache = { at: now, entries };
  return entries;
}

/** 记录一次 DSH 请求的规则贡献（结构化日志 + 环形缓冲；不记录会话正文）。 */
function recordDshRequestContributions({ workId = null, chapterId = null, session = '', kind = 'harness' } = {}) {
  const entries = dshRuleSources().map((e) => dshContribution({ ...e, workId: Number(workId) || 0, chapterId: Number(chapterId) || null, session, kind: 'rules' }));
  const record = recordContributions(buildContributionRecord({
    workId: Number(workId) || 0, chapterId: Number(chapterId) || null, mode: 'harness_request',
    session, manifest: [], stats: {}, entries,
  }));
  log({
    level: 'info', layer: 'ai', kind: 'dsh_rules_contributions',
    message: `DSH 请求规则贡献：${entries.length} 个规则来源（${kind}）`,
    context: {
      work_id: Number(workId) || 0, chapter_id: Number(chapterId) || null, session,
      rules: entries.map((e) => ({ id: e.rule_id, version: e.rule_version, hash: e.content_hash.slice(0, 12), chars: e.chars })),
    }
  });
  return record;
}

function createHarnessJob(prompt, options) {
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: 'queued',
    started_at: null,
    finished_at: null,
    output: null,
    // D8-#4：**结构化**产出（生成小说 / 记忆压缩这类服务端命名任务的结果对象）。
    // 自由提示词任务（/harness/run）的产出是正文，走 output；两者刻意分开，
    // 免得把 JSON 当正文喂给红线扫描、或把正文塞进 result 让前端多一层判断。
    result: null,
    scan: null,
    proposals: null,
    error: null,
    tail: '',
    // 归属与语义：供「后台继续 / 刷新后续接」认出这是哪一章的哪一步任务
    workId: options?.workId || null,
    chapterId: Number(options?.chapterId) || null,
    kind: options?.kind || 'harness',
    stage: String(options?.stage || '').slice(0, 120),
    // 决策 D4：模型槽位状态（'' | 'waiting' | 'running'）。界面据此显示"等待模型槽位"，
    // 而不是把"在队列里等"显示成"运行中"。
    model_slot: '',
    model_waiters: 0,
    created_at: now(),
    abort: new AbortController(),
    cancelRequested: false
  };
  harnessJobs.set(jobId, job);
  persistHarnessJob(job);
  // 清理：只保留最近 30 个任务，防止长时间运行内存增长。
  // 优先淘汰终态任务；若无终态任务，先 abort 最旧的运行中任务再淘汰，避免其「消失」却继续运行。
  if (harnessJobs.size > 30) {
    let evicted = null;
    for (const j of harnessJobs.values()) {
      if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) { evicted = j; break; }
    }
    if (!evicted) {
      evicted = harnessJobs.values().next().value;
      try { evicted?.abort?.abort(); } catch (_) { /* 忽略 */ }
    }
    if (evicted) harnessJobs.delete(evicted.id);
  }
  (async () => {
    job.status = 'running';
    job.started_at = Date.now();
    persistHarnessJob(job);
    // 决策 D4：把「等待模型槽位」如实反映到作业上。
    // ⚠️ 这里原先写着「前端本来就用 job.stage 显示进度，无需改前端」——**那句是错的**：
    // 实时轮询路径（public/app.js 的 pollHarnessJob）只喂 job.tail，从不读 job.stage，
    // 所以排队期间界面一片静止。现在双写：
    //   stage      —— 给人看的文案（也会存进可恢复任务列表）；
    //   model_slot —— 给前端做结构化判断（'' | 'waiting' | 'running'），别去正则匹配中文。
    const onPhase = (phase, info) => {
      if (phase === 'waiting-model') {
        job.model_slot = 'waiting';
        job.model_waiters = Number(info?.waiters) || 1;
        if (!job.stage) {
          const ahead = Math.max(0, job.model_waiters - 1);
          job.stage = ahead > 0 ? `等待模型槽位（前面还有 ${ahead} 个任务）` : '等待模型槽位';
        }
      } else if (phase === 'running') {
        job.model_slot = 'running';
        job.model_waiters = 0;
        if (job.stage.startsWith('等待模型槽位')) job.stage = '';
      }
      persistHarnessJob(job);
    };
    const onChunk = (chunk) => {
      job.tail = (job.tail + chunk).slice(-2000);
    };
    try {
      let output;
      if (typeof options.runner === 'function') {
        // D8-#4：**自带运行体**的作业（生成小说 / 记忆压缩）。
        // 它们此前在 HTTP 请求里同步跑完，只有并发槽位、没有作业记录——
        // 于是界面没有进度、不能取消、刷新就丢、也不进「可恢复任务」列表。
        // 运行体自行负责进度上报（onChunk），产出放进 job.result。
        job.result = await options.runner({ signal: job.abort.signal, onPhase, onChunk, job });
        output = typeof job.result === 'string' ? job.result : '';
      } else {
        output = await runHarnessTaskWithProgress(prompt, {
          ...options,
          signal: job.abort.signal,
          onPhase,
        }, onChunk);
      }
      job.status = 'done';
      job.output = output;
      if (typeof options.runner === 'function') {
        // 命名任务的产出是结构化对象，不是正文：跳过红线扫描与提案收集
        // （拿 JSON 去扫反 AI 腔只会产生噪声命中；提案归属由运行体自己决定）。
      } else {
        // 生成后确定性红线扫描（反 AI 腔自检），随结果一起返回，不阻塞正文。
        const redlineRows = listRedlines(Number(options.workId) || null);
        const scanHits = scanAgainstRedlines(redlineRows, output);
        job.scan = { enabled: redlineRows.length > 0, total: scanHits.reduce((s, h) => s + h.count, 0), hits: scanHits.slice(0, 50) };
        // 提案模式收尾：把 AI 在本次任务里提交的事件/记忆提案一并带回，供作者确认。
        if (options.workId) job.proposals = listProposals(Number(options.workId));
      }
    } catch (e) {
      job.status = e.code === 'HARNESS_TIMEOUT' ? 'timeout'
        : (e.code === 'HARNESS_CANCELLED' || job.cancelRequested) ? 'cancelled'
        : 'failed';
      job.error = job.status === 'cancelled' ? '任务已取消' : readableErrorMessage(e);
      job.tail = (job.tail + (e.stdoutTail || '')).slice(-2000);
      if (job.status !== 'cancelled') logAIError(options.action || 'harness', e, '/api/harness/run');
    } finally {
      job.finished_at = Date.now();
      // 终态落库：刷新页面/重启服务后仍能取回产出或得知任务已失败。
      persistHarnessJob(job);
    }
  })().catch(() => { /* 后台任务异常不影响 HTTP 层 */ });
  return job;
}

/**
 * D8-#3：记忆自动压缩（**默认关闭**）。
 *
 * 为什么默认关闭：它会真的产生 API 费用——2026-09-16 两次真实调用实测，
 * 任务是"生成不超过 800 字的摘要"，模型实际产出 5.6k~22k 字（差额是推理输出，**同样计费**）。
 * 用户的既有约束是「付费调用需先取得许可」，所以这里默认 '0'：不打开就一个字节都不花。
 *
 * 打开之后的行为：章节正文落盘时检查长期记忆长度，超过阈值就**建一个压缩作业**
 * （走作业设施：有进度、可取消、失败可见、进「可恢复任务」），而不是在请求里同步跑完。
 * 压缩结果仍要过零损失护栏，不通过就拒绝落库。
 *
 * @returns {object|null} 建出来的作业；未触发时返回 null
 */
function memoryAutoCompressEnabled() {
  try { return getAppSettingDb(MEMORY_AUTO_COMPRESS_KEY, '0') === '1'; } catch { return false; }
}

function maybeAutoCompressMemory(workId) {
  if (!memoryAutoCompressEnabled()) return null;
  const wid = Number(workId);
  if (!wid) return null;
  try {
    const row = prepare('SELECT summary FROM story_memories WHERE work_id = ? ORDER BY id DESC LIMIT 1').get(wid);
    const summary = String(row?.summary || '');
    if (summary.length <= MEMORY_COMPRESS_HINT) return null;
    // 同一作品已有压缩在跑就不再建：否则每保存一章都会叠一个作业上去。
    for (const j of harnessJobs.values()) {
      if (j.kind === 'compress' && Number(j.workId) === wid && (j.status === 'queued' || j.status === 'running')) {
        return null;
      }
    }
    const job = createHarnessJob('', {
      action: 'compress', kind: 'compress', stage: '自动压缩长期记忆',
      workId: wid, timeout: LONG_AI_TIMEOUT_MS,
      runner: ({ onChunk, signal }) => compressStoryMemory(wid, onChunk, signal).then((s) => ({ summary: s })),
    });
    log({
      level: 'info', layer: 'ai', kind: 'memory_auto_compress_started',
      message: `长期记忆 ${summary.length} 字超过阈值 ${MEMORY_COMPRESS_HINT}，已自动建压缩作业`,
      context: { work_id: wid, job_id: job.id, summary_chars: summary.length }
    });
    return job;
  } catch (e) {
    // 自动压缩失败绝不能影响章节保存本身——它只是锦上添花。
    log({ level: 'warn', layer: 'ai', kind: 'memory_auto_compress_failed', message: `自动压缩未能启动：${e.message}` });
    return null;
  }
}

// ---------- 路由入口 ----------// 统一处理 /api 下的请求：搜索、统计、AI、历史版本、关闭服务、通用 CRUD。
async function handleAPI(req, res, pathname, query) {
  const method = req.method;
  const segments = pathname.split('/').filter(Boolean);
  const resource = segments[1];
  const id = segments[2] ? parseId(segments[2]) : null;

  // 跨源写请求一律拒绝（浏览器页面防护；同源 UI 与无 Origin 的工具调用不受影响）
  if (!isLocalRequest(req)) {
    return sendError(res, 403, '跨源请求被拒绝：写操作仅允许本机工坊页面发起');
  }

  // ---------- 🐞 运行追踪（调试录制） ----------
  // 本组接口自身不参与追踪（debug-trace 的 isExcludedPath 排除 /api/debug），
  // 否则「查看追踪」这个动作会不断产生新的追踪数据。
  if (resource === 'debug') {
    const action = segments[2];
    if (method === 'GET' && action === 'state') {
      return sendJSON(res, 200, { ok: true, state: traceState(), config: traceConfigInfo() });
    }
    if (method === 'POST' && action === 'start') {
      const body = await readBody(req).catch(() => ({}));
      const out = startTracing({ from: body?.from || 'ui', work_id: body?.work_id ?? null });
      log({ level: 'info', layer: 'server', kind: 'trace_start', message: `运行追踪已开启（会话 ${out.session_id}）`, context: { session_id: out.session_id } });
      return sendJSON(res, 200, out);
    }
    if (method === 'POST' && action === 'stop') {
      const out = stopTracing('user');
      log({ level: 'info', layer: 'server', kind: 'trace_stop', message: `运行追踪已停止（会话 ${out.session_id || ''}）`, context: { summary: out.summary || null } });
      return sendJSON(res, 200, out);
    }
    if (method === 'POST' && action === 'ping') {
      pingTracing();
      return sendJSON(res, 200, { ok: true, ...traceState() });
    }
    if (method === 'POST' && action === 'op') {
      // 前端上报一次操作的客户端节点、渲染结果与 toast（第 9 题：调用时间 + 代码 + 代码响应）。
      const body = await readBody(req).catch(() => ({}));
      const opId = String(body.op_id || '');
      if (!opId) return sendError(res, 400, '缺少 op_id');
      const before = getOperation(opId, { withNodes: false });
      // force：录制刚停止时前端仍可能上报收尾数据，允许补建记录，避免丢掉前端调用链。
      beginOperation(opId, body.title || '前端操作', { source: 'client', force: true });
      const attached = body.nodes ? attachClientNodes(opId, body.nodes) : null;
      // 幂等保护：同一次操作重复上报（例如停录瞬间在途请求的收尾）不得重复收尾，
      // 否则会把已经结束的操作重新标成 running/done 并多写一条 op-end。
      const alreadySettled = before && before.summary && before.summary.status !== 'running';
      const summary = alreadySettled
        ? before.summary
        : finishOperation(opId, { status: body.status, render: body.render, toast: body.toast });
      return sendJSON(res, 200, { ok: true, attached, summary, deduped: !!alreadySettled });
    }
    if (method === 'GET' && action === 'ops') {
      return sendJSON(res, 200, { ok: true, ops: listOperations(), tools: listToolCalls(), summary: sessionSummary() });
    }
    if (method === 'GET' && action === 'op') {
      const opId = String(query.op_id || '');
      const live = opId ? getOperation(opId) : null;
      if (live) return sendJSON(res, 200, { ok: true, source: 'live', ...live });
      // 不在内存中（已停止录制或已被淘汰）→ 回退到会话文件
      const file = String(query.file || '');
      const session = file ? readSession(file) : null;
      const found = session ? session.ops.find((o) => o.opId === opId) : null;
      if (!found) return sendError(res, 404, '未找到该操作记录');
      return sendJSON(res, 200, { ok: true, source: 'file', file: session.file, summary: found.summary, nodes: found.nodes });
    }
    if (method === 'GET' && action === 'sessions') {
      return sendJSON(res, 200, { ok: true, sessions: listSessions(), dir: DEBUG_DIR });
    }
    if (method === 'GET' && action === 'session') {
      const session = readSession(String(query.file || ''), { nodeLimit: Number(query.node_limit) || 0 });
      if (!session) return sendError(res, 404, '未找到该录制文件');
      return sendJSON(res, 200, { ok: true, ...session });
    }
    if (method === 'DELETE' && action === 'purge') {
      const out = purgeSessions();
      return sendJSON(res, 200, { ok: out.ok !== false, ...out });
    }
    if (method === 'GET' && action === 'stream') {
      // SSE 实时推送录制中的节点流（未录制时也保持连接，便于前端一次连接用到底）。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = (batch) => {
        if (res.destroyed) return;
        for (const item of batch) {
          try {
            res.write(`data: ${JSON.stringify(item)}\n\n`);
          } catch (_) { /* 客户端已断开 */ }
        }
      };
      const unsubscribe = subscribeStream(send);
      res.write(`data: ${JSON.stringify({ type: 'hello', state: traceState() })}\n\n`);
      const beat = setInterval(() => {
        if (res.destroyed) return;
        try {
          res.write(': ping\n\n');
        } catch (_) { /* 忽略 */ }
      }, 20000);
      if (typeof beat.unref === 'function') beat.unref();
      const cleanup = () => {
        clearInterval(beat);
        unsubscribe();
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }
    return sendError(res, 404, `未知的调试接口：${action || ''}`);
  }

  if (resource === 'search' && method === 'GET') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const base = timed('server', '关键词检索（search）', () => search(query.q || '', workId), SLOW_REQUEST_MS);
    // 关键词检索 + OpenViking 语义检索合并返回（novel_lookup 与全局搜索共用）。
    const semantic = await timedAsync('sync', 'OpenViking 语义检索（semanticSearchMerge）', () => semanticSearchMerge(query.q || '', workId), 1000);
    return sendJSON(res, 200, { ...base, semantic });
  }

  if (resource === 'stats' && method === 'GET') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const stats = {};
    for (const [key, table] of Object.entries({
      chapters: 'chapters', terms: 'terms', characters: 'characters',
      plotlines: 'plotlines', volumes: 'volumes'
    })) {
      const row = workId
        ? prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE work_id = ?`).get(workId)
        : prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      stats[key] = row.c;
    }
    return sendJSON(res, 200, stats);
  }

  // 示例小说演示数据：一键导入/删除（UI 在“我的作品”页）
  if (resource === 'demo' && method === 'GET' && segments[2] === 'status') {
    const row = demoFindWork(DEMO_TITLE);
    return sendJSON(res, 200, { ok: true, exists: !!row, title: DEMO_TITLE, work_id: row ? row.id : null });
  }
  if (resource === 'demo' && method === 'POST' && segments[2] === 'install') {
    const body = await readBody(req);
    try {
      const result = installDemo(body.force === true);
      const demo = demoFindWork(DEMO_TITLE);
      if (demo) syncWorkFull(demo.id).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `示例作品同步失败：${e.message}` }));
      return sendJSON(res, 201, { ok: true, ...result });
    } catch (e) {
      const status = /已存在|重新导入/.test(e.message) ? 409 : 500;
      return sendError(res, status, e.message);
    }
  }
  if (resource === 'demo' && method === 'POST' && segments[2] === 'remove') {
    const demo = demoFindWork(DEMO_TITLE);
    const removed = deleteDemoWork(DEMO_TITLE);
    if (removed && demo) removeWorkFromMemory(demo.id).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `示例作品目录移除失败：${e.message}` }));
    return sendJSON(res, 200, { ok: true, removed });
  }

  // R12：导入后「分析并重建创作状态」（可选流程；抽取由调用方按批执行，宿主不做模型调用）。
  // 必须放在 /api/import 的 POST 之前：否则 rebuild 子路径会被「导入文件」处理器抢走。
  if (resource === 'import' && segments[2] === 'rebuild') {
    const handled = await handleImportRebuildRoute({ segments, method, query, req, res });
    if (handled !== false) return handled;
    return sendError(res, 404, '未知的重建接口（可用：plan / status / record / confirm / cancel）');
  }

  // 导入：TXT/Markdown 文本 或 EPUB（base64），新建作品并自动拆章。
  // R12：导入文件是**不可信输入**——先过 ai/import/guard.mjs 的安全校验（大小/编码/路径/压缩比/symlink），
  // 再解析（不联网、不执行脚本、不解压到磁盘），最后在**单个事务**里写入（失败不产生半导入状态）。
  if (resource === 'import' && method === 'POST' && !segments[2]) { // 子路径（rebuild/…）上面已处理
    const body = await readBody(req);
    let title = asString(body.title, '');
    let chapters = [];
    const audit = { guard_version: ImportGuard.IMPORT_GUARD_VERSION };
    try {
      if (body.base64) {
        const b64 = String(body.base64);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
          return sendError(res, 400, '文件不是有效的 base64/EPUB');
        }
        const bin = Buffer.from(b64, 'base64');
        if (bin.length > ImportGuard.IMPORT_LIMITS.max_file_bytes) {
          return sendError(res, 413, `EPUB 文件过大（上限 ${Math.round(ImportGuard.IMPORT_LIMITS.max_file_bytes / 1024 / 1024)}MB）`);
        }
        const epub = parseEpub(bin);
        title = title || epub.title;
        chapters = epub.chapters;
        audit.format = 'epub';
        audit.bytes = bin.length;
      } else if (body.text !== undefined) {
        const text = ImportGuard.assertImportText(String(body.text));
        chapters = splitTextIntoCapters(text);
        audit.format = 'text';
        audit.chars = text.length;
      } else {
        return sendError(res, 400, '缺少 text 或 base64');
      }
      const stats = ImportGuard.assertChapters(chapters);
      audit.chapters = stats.chapters;
      audit.chars = stats.chars;
    } catch (e) {
      return sendError(res, 400, `解析失败：${e.message}`);
    }
    const safeTitle = title.slice(0, ImportGuard.IMPORT_LIMITS.max_title_chars);
    try {
      const workId = importWorkFromChapters(safeTitle, chapters, '由导入文件创建');
      syncWorkFull(workId).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `导入作品同步失败（work ${workId}）：${e.message}` }));
      return sendJSON(res, 201, { ok: true, work_id: workId, title: safeTitle || '导入的作品', chapters: chapters.length, guard: audit });
    } catch (e) {
      const status = /作品名称不能为空/.test(e.message) ? 400 : 500;
      return sendError(res, status, `写入失败：${e.message}`);
    }
  }

  // R12：导入安全判据（只读）——把「拦什么、按什么口径拦」暴露成可审计的口径表。
  if (resource === 'import' && method === 'GET' && segments[2] === 'guard') {
    return sendJSON(res, 200, { ok: true, version: ImportGuard.IMPORT_GUARD_VERSION, limits: ImportGuard.IMPORT_LIMITS, rules: ImportGuard.IMPORT_RULES });
  }

  // 导出：整书 TXT / 整书 Markdown / 单章 TXT（浏览器直接下载）。
  if (resource === 'export' && method === 'GET') {
    const fmt = segments[2];
    const workId = Number(query.work_id) || null;
    const chapterId = Number(query.chapter_id) || null;
    let text = null;
    let fileName = 'novel.txt';
    if (fmt === 'txt' && workId) {
      text = timed('server', '整书 TXT 导出（buildWorkExport）', () => buildWorkExport(workId, 'txt'), SLOW_REQUEST_MS);
      const work = prepare('SELECT title FROM works WHERE id = ?').get(workId);
      if (work) fileName = `${work.title || 'novel'}.txt`;
    } else if (fmt === 'md' && workId) {
      text = timed('server', '整书 Markdown 导出（buildWorkExport）', () => buildWorkExport(workId, 'md'), SLOW_REQUEST_MS);
      const work = prepare('SELECT title FROM works WHERE id = ?').get(workId);
      if (work) fileName = `${work.title || 'novel'}.md`;
    } else if (fmt === 'txt' && chapterId) {
      text = timed('server', '单章 TXT 导出（buildChapterExport）', () => buildChapterExport(chapterId), SLOW_REQUEST_MS);
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (chapter) fileName = `${chapter.title || 'chapter'}.txt`;
    }
    if (text === null) return sendError(res, 404, '导出对象不存在或格式不支持');
    const encoded = encodeURIComponent(fileName).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16));
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Cache-Control': 'no-store'
    });
    res.end(text);
    return;
  }

  // AI 上下文：角色卡 / 世界观 / 作者注（+ OpenViking 语义召回层）
  //
  // P2 起，**提示词里实际使用的那段文本**不再由前端拼装，而是走与 /api/novel/context
  // 完全相同的唯一装配器（ai/context/assembler.mjs，经 buildNovelContext）。
  // 原因（契约 I5/I6）：前端 aiContextBlock 的拼装没有任何预算——压力数据下同一章
  // 它喂进去约 7.4 万字，而受预算约束的路径只有 2.4 万字；两条路径渲染同一份数据
  // 却差 3 倍，是上下文质量最大的结构性缺口。
  //
  // buildAIContext 的结构化字段继续返回：界面的「上下文预览」面板仍在用它（需要更细的字段）。
  if (resource === 'ai_context' && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const ctx = timed('server', 'AI 上下文装配（buildAIContext）', () => buildAIContext(chapterId), SLOW_REQUEST_MS);
    if (!ctx) return sendError(res, 404, '章节不存在');
    // 语义召回随 AI 上下文一起注入正文写作提示词；复用 buildAIContext 已加载的章节行，避免二次查询。
    // 先调用一次把召回微缓存焐热，随后的 buildNovelContext 会命中同一个键。
    let recall = { enabled: false, status: 'disabled', hits: [] };
    try {
      recall = await getSemanticRecall(ctx.work.id, ctx._chapter || null);
    } catch (_) { /* 召回失败不阻塞 */ }
    recall = revalidateRecallForHost(recall, ctx.work.id, ctx._chapter || null);
    const workId = ctx.work.id;
    delete ctx._chapter; // 内部字段不外泄给前端

    // C4：方向参数进入两条装配端点（GET 用 URLSearchParams 编码；direction 上限 400 码点）。
    // 方向只影响资料召回与索引候选发现，不改变正典查询。
    const direction = normalizeDirection(query.direction);
    const libraryRecallPhase = normalizeLibraryRecallPhase(query.library_recall_phase);
    const directionSource = normalizeDirectionSource(query.direction_source);
    const requestId = normalizeRequestId(query.request_id);

    // 预算内的分层装配：与 /api/novel/context 共用同一份缓存与实现（契约 I5/I6）。
    // 缓存键含 phase + direction 哈希（无方向且 default 时与旧键逐字节相同）——
    // 两条端点因此共享同一份缓存，不会各召回一次（C3 约束）。
    const cacheKey = contextCacheKeyOf({ workId, chapterId, mode: 'full', phase: libraryRecallPhase, directionHash: directionHashOf(direction) });
    let budgeted = cacheGetContext(cacheKey, workId);
    if (budgeted === undefined) {
      budgeted = await buildNovelContext(workId, chapterId, 'full', { direction, directionSource, libraryRecallPhase, requestId });
      if (budgeted) cacheSetContext(cacheKey, budgeted, workId);
    }

    return sendJSON(res, 200, {
      ...ctx,
      semantic_recall: {
        enabled: recall.enabled,
        status: recall.status,
        // D8-#5：与 buildNovelContext 同源（recallGapReason）——界面看到的缺口判定必须与
        // 实际插进提示词的占位一致，否则会出现"界面说正常、模型却收到了缺口说明"。
        gap: Boolean(recallGapReason(recall)),
        gap_reason: recallGapReason(recall),
        hits: recall.hits || [],
        omitted: recall.omitted || []
      },
      // 与 /api/novel/context 同源（buildNovelContext 的 additive 字段原样转发）。
      library_recall: budgeted ? budgeted.library_recall : { enabled: false, status: 'unknown', hits: [] },
      // A/C/D/E（additive）：检索审计与计划摘要（旧消费方可忽略；计数口径见 buildNovelContext）。
      retrieval_stats: budgeted ? budgeted.retrieval_stats : null,
      retrieval_plan: budgeted ? budgeted.retrieval_plan : null,
      // 提示词使用的分层文本（前端 aiContextBlock 直接采用它），以及配套的裁剪清单
      assembled: budgeted ? budgeted.assembled : '',
      context_manifest: budgeted ? budgeted.context_manifest : [],
      context_overflow: budgeted ? budgeted.context_overflow : null,
      context_stats: budgeted ? budgeted.context_stats : null,
      // 与 /api/novel/context 同源（同一次装配）：主成文路径也要能回答
      // "这份上下文是哪一次调用、完整性如何"。
      context_id: budgeted ? budgeted.context_id : '',
      context_request_id: budgeted ? budgeted.context_request_id : '',
      context_integrity: budgeted ? budgeted.context_integrity : null,
      context_envelope: budgeted ? budgeted.context_envelope : null
    });
  }

  // 长期记忆 / 故事摘要
  if (resource === 'story_memory' && method === 'POST' && segments[2] === 'compress') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    try {
      const summary = await withHarnessSlot(() => compressStoryMemory(workId));
      notifyChange('story_memory', { workId, id: workId });
      return sendJSON(res, 200, { ok: true, summary });
    } catch (e) {
      const status = e.status === 429 ? 429 : (/作品不存在/.test(e.message) ? 404 : 502);
      return sendError(res, status, e.message);
    }
  }
  if (resource === 'story_memory' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (segments[2] === 'versions') {
      return sendJSON(res, 200, { work_id: workId, versions: listMemoryVersions(workId) });
    }
    return sendJSON(res, 200, { work_id: workId, summary: getStoryMemory(workId) });
  }
  if (resource === 'story_memory' && method === 'POST' && segments[2] === 'rollback') {
    const body = await readBody(req);
    const versionId = Number(body.version_id);
    if (!versionId) return sendError(res, 400, '缺少 version_id');
    try {
      const result = rollbackMemory(versionId);
      const vrow = prepare('SELECT work_id FROM memory_versions WHERE id = ?').get(versionId);
      if (vrow?.work_id) notifyChange('story_memory', { workId: vrow.work_id, id: vrow.work_id });
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendError(res, 404, e.message);
    }
  }
  if (resource === 'story_memory' && method === 'PUT') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    // headless 生成任务先落提案（作者确认后写入并留版本快照）。
    if (body.proposed === true) {
      const result = addMemoryProposal(workId, {
        summary: asString(body.summary, ''),
        delta: asString(body.delta, ''),
        note: asString(body.note, 'dsh 创作插件提案'),
        // 来源标记必须随提案落库：作者点「采纳」时再判闸，靠的就是这个字段。
        // 不带标记的调用方（作者/历史路径）落空串，采纳时按普通提案处理。
        guard: asString(body.guard, '')
      });
      return sendJSON(res, 200, { ok: true, ...result, work_id: workId });
    }
    // summary 直接提交；或 delta 增量：与当前摘要做安全拼接（语义压缩由调用方模型完成）。
    let summary = asString(body.summary, '');
    if (!summary && body.delta) {
      summary = mergeMemoryDraft(getStoryMemory(workId), asString(body.delta, ''));
    }
    // D8-#3 续：**模型自压缩**也走同一零损失护栏。判据是纯函数（needsAgentMemoryGuard），
    // 语义为「工具显式标记来源 + 传了 summary」；作者手改、delta 追加不在本防区。
    // 提案路径（`proposed:true`）在此**不设闸**——提案先落库、不碰正式账本，闸设在
    // `settleProposals` 的作者采纳那一刻，且只对带 `guard` 标记的提案生效。
    if (needsAgentMemoryGuard(body)) {
      const verdict = agentMemoryGuardOf(workId, summary);
      if (!verdict.ok) {
        log({
          level: 'warn', layer: 'ai', kind: 'memory_update_guard_rejected',
          message: `模型提交的长期记忆未通过零损失护栏，**未落库**：${verdict.reasons.join('；')}`,
          context: {
            work_id: workId, length: verdict.guard.length,
            missing: verdict.guard.missing.slice(0, 20),
            invented: verdict.invention.invented.slice(0, 20),
            checked: verdict.guard.checked
          }
        });
        // 409 而不是 400：这不是请求格式错，而是内容没过**可修正**的质量闸——
        // 错误文本必须带上缺失名单与逃生口，模型才能在一轮内改好（多花一轮就是成本）。
        return sendError(res, 409,
          `长期记忆未通过零损失护栏（未落库）：${verdict.reasons.join('；')}。`
          + '请把上述出场角色/世界观词条补回摘要后重交一次；若确实装不下，改传 delta（安全追加，不会丢人）。');
      }
      if (verdict.inventionAction === 'allow') {
        log({
          level: 'warn', layer: 'ai', kind: 'memory_update_invented_allowed',
          message: `模型提交的长期记忆提到了 ${verdict.invention.invented.length} 个未出场角色，按既定策略**放行**（未拦落库）`,
          context: { work_id: workId, invented: verdict.invention.invented.slice(0, 20) }
        });
      }
    }
    const result = saveStoryMemory(workId, summary, {
      source: body.source || 'manual',
      note: body.note || ''
    });
    notifyChange('story_memory', { workId, id: workId });
    return sendJSON(res, 200, { ...result, work_id: workId });
  }


/**
 * 确定性故事状态内核的路由处理器（PHASE 1–14 的宿主侧接口）。
 *
 * 为什么单独抽成函数：主路由已经很长，把 17 条端点塞进去会让「哪里是宿主、哪里是插件面」
 * 不可读。这里集中处理 `/api/novel/story_state`（开关与总览）与 `/api/novel/state/*`
 * （状态读写、预检、校验、契约、提案、快照、回滚、质量）。
 *
 * 三条纪律（与插件侧一致）：
 *   ① 所有写入都返回**明确结论**（applied / stale / rejected / error），不用异常表达业务结果；
 *   ② 提案应用是**单事务**（陈旧检查 → 快照 → ops → 标记），失败整体回滚；
 *   ③ 开关关闭时读接口返回 `enabled:false` 与空状态，`enabled:true` 由作者显式打开——
 *      不因为"机制实现了"就把任何作品接进来。
 */
/**
 * R12：导入后「分析并重建创作状态」的路由处理器（可选流程；不强制付费分析）。
 *
 * 分工（这是本流程的关键设计）：
 *   - 宿主负责：批次规划与基线指纹、进度与状态、结果记录（schema/证据校验 → 候选草稿）、
 *     作者确认（逐批短事务写入既有提案设施）、取消与恢复。
 *   - **模型抽取由调用方按批执行**（作者界面 / 工具 / 脚本），本处理器不做任何模型调用——
 *     因此「规划 / 进度 / 记录 / 确认 / 取消」全链路可离线跑通，默认零计费。
 * 五条端点：plan / status / record / confirm / cancel（均在 /api/import/rebuild/* 下）。
 */
async function handleImportRebuildRoute({ segments, method, query, req, res }) {
  const leaf = segments[3] || '';
  const workIdOf = (v) => Number(v) || 0;
  const plainChapters = (workId) => RebuildStore.chaptersOfWork(workId)
    .map((c) => ({ ...c, content: htmlToPlain(c.content) }));

  // 当前批次与库里基线的比对（GET 只算不改；plan/record/confirm 才写库）。
  const computeStates = (run, batches, plan) => {
    const prev = batches.map((b) => ({ batch_index: b.batch_index, baseline_hash: b.baseline_hash, chapter_hashes: b.chapter_hashes, status: b.status }));
    const states = ImportRebuild.compareBatches(prev, plan);
    const byIndex = new Map(batches.map((b) => [Number(b.batch_index), b]));
    const out = plan.map((p) => {
      const b = byIndex.get(Number(p.index)) || null;
      const st = states.get(p.index) || { state: 'pending', reason: '' };
      const dbStatus = b ? b.status : 'missing';
      // 库里已是 confirmed 但基线不匹配 → 依然报 stale（正文/配置变了，确认过的结果也不再可信）。
      const state = (dbStatus === 'confirmed' && st.state === 'reuse') ? 'reuse' : st.state;
      return {
        batch_index: p.index, chapter_ids: p.chapter_ids, chapter_indexes: p.chapter_indexes,
        chars: p.chars, baseline_hash: p.baseline_hash,
        db_status: dbStatus, state,
        reason: st.reason,
        result_hash: b ? b.result_hash : '', attempts: b ? b.attempts : 0,
        proposals: b ? b.proposals.length : 0, proposal_ids: b ? b.proposal_ids : [],
        error: b ? b.error : '',
      };
    });
    const counts = { reuse: 0, stale: 0, pending: 0 };
    for (const x of out) counts[x.state] = (counts[x.state] || 0) + 1;
    return { batches: out, counts };
  };

  // ── 状态（只读，可审计）────────────────────────────────────────────────
  if (method === 'GET' && leaf === 'status') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const run = query.run_id ? RebuildStore.getRun(Number(query.run_id)) : RebuildStore.latestRunFor(workId);
    if (!run) return sendJSON(res, 200, { ok: true, work_id: workId, run: null, batches: [], progress: null, rules: ImportRebuild.REBUILD_RULES, limits: ImportRebuild.REBUILD_LIMITS });
    if (Number(run.work_id) !== Number(workId)) return sendError(res, 400, 'run 不属于该作品');
    const chapters = plainChapters(workId);
    const plan = ImportRebuild.planBatches(chapters, { batchSize: run.batch_size, route: run.route, extractorVersion: run.extractor_version, schemaVersion: run.schema_version, categories: run.categories });
    const states = computeStates(run, RebuildStore.listBatches(run.id), plan);
    return sendJSON(res, 200, {
      ok: true, work_id: workId, run,
      batches: states.batches, counts: states.counts,
      progress: RebuildStore.progressOf(run.id),
      categories: ImportRebuild.REBUILD_CATEGORIES,
      rules: ImportRebuild.REBUILD_RULES, limits: ImportRebuild.REBUILD_LIMITS,
      extractor_version: ImportRebuild.REBUILD_EXTRACTOR_VERSION, schema_version: ImportRebuild.REBUILD_SCHEMA_VERSION,
    });
  }

  // ── 规划 / 恢复 ─────────────────────────────────────────────────────────
  if (method === 'POST' && leaf === 'plan') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (!RebuildStore.workExists(workId)) return sendError(res, 404, '作品不存在');
    const chapters = plainChapters(workId);
    if (!chapters.length) return sendError(res, 400, '作品里没有章节，无可重建内容');
    const resumeRun = body.run_id ? RebuildStore.getRun(Number(body.run_id)) : null;
    if (body.run_id && !resumeRun) return sendError(res, 404, '重建运行不存在');
    if (resumeRun && Number(resumeRun.work_id) !== Number(workId)) return sendError(res, 400, 'run 不属于该作品');

    const route = resumeRun ? resumeRun.route : ImportRebuild.normalizeRoute({ model: asString(body.model, ''), reasoning_effort: asString(body.reasoning_effort, '') });
    const categories = resumeRun ? resumeRun.categories : (Array.isArray(body.categories) && body.categories.length ? body.categories : ImportRebuild.REBUILD_CATEGORY_KEYS);
    const batchSize = resumeRun ? resumeRun.batch_size : (Number(body.batch_size) || ImportRebuild.REBUILD_LIMITS.max_chapters_per_batch);
    const plan = ImportRebuild.planBatches(chapters, { batchSize, route, categories });

    let run = resumeRun;
    if (!run) {
      run = RebuildStore.createRun({
        workId, status: 'planned', route,
        extractorVersion: ImportRebuild.REBUILD_EXTRACTOR_VERSION, schemaVersion: ImportRebuild.REBUILD_SCHEMA_VERSION,
        categories, batchSize: Math.min(Number(batchSize) || ImportRebuild.REBUILD_LIMITS.max_chapters_per_batch, ImportRebuild.REBUILD_LIMITS.max_chapters_per_batch),
        note: asString(body.note, ''), createdBy: 'author',
      });
      for (const b of plan) {
        RebuildStore.createBatch({ runId: run.id, workId, index: b.index, chapterIds: b.chapter_ids, chapterIndexes: b.chapter_indexes, chapterHashes: b.chapter_hashes, chars: b.chars, baseline: b.baseline, baselineHash: b.baseline_hash });
      }
    } else {
      // 恢复：新出现的批次补建；已存在但基线不匹配的标 stale（旧结果保留，可阅读、不可复用）。
      const existing = RebuildStore.listBatches(run.id);
      const byIndex = new Map(existing.map((b) => [Number(b.batch_index), b]));
      for (const b of plan) {
        const row = byIndex.get(Number(b.index));
        if (!row) {
          RebuildStore.createBatch({ runId: run.id, workId, index: b.index, chapterIds: b.chapter_ids, chapterIndexes: b.chapter_indexes, chapterHashes: b.chapter_hashes, chars: b.chars, baseline: b.baseline, baselineHash: b.baseline_hash });
          continue;
        }
        const sameSources = row.chapter_hashes.length === b.chapter_hashes.length && row.chapter_hashes.every((h, i) => h === b.chapter_hashes[i]);
        if (row.baseline_hash !== b.baseline_hash || !sameSources) {
          if (row.status !== 'pending' || row.result_json) RebuildStore.setBatchStatus(row.id, 'stale', { error: '基线变化：正文或抽取配置已改变，旧结果须重跑' });
        }
      }
      if (run.status === 'cancelled') run = RebuildStore.setRunStatus(run.id, 'planned', '由作者恢复');
    }

    const states = computeStates(run, RebuildStore.listBatches(run.id), plan);
    const orphan = RebuildStore.listBatches(run.id).filter((b) => b.batch_index >= plan.length).length;
    log({ level: 'info', layer: 'server', kind: 'import_rebuild_plan', message: `导入重建已规划：run ${run.id}，批次 ${plan.length}（复用 ${states.counts.reuse} / 过期 ${states.counts.stale} / 待跑 ${states.counts.pending}）`, context: { work_id: workId, run_id: run.id, batches: plan.length, counts: states.counts } });
    return sendJSON(res, 201, {
      ok: true, work_id: workId, run, batches: states.batches, counts: states.counts,
      orphan_batches: orphan,
      progress: RebuildStore.progressOf(run.id),
      categories: ImportRebuild.REBUILD_CATEGORIES,
      limits: ImportRebuild.REBUILD_LIMITS, rules: ImportRebuild.REBUILD_RULES,
      note: '抽取由调用方按批执行：挑 state=pending/stale 的批次逐批跑，再用 record 记录结果；不要整本一次请求。',
    });
  }

  // ── 记录一批抽取结果（校验 + 候选草稿；无模型调用）────────────────────
  if (method === 'POST' && leaf === 'record') {
    const body = await readBody(req);
    const runId = Number(body.run_id) || 0;
    const batchIndex = Number(body.batch_index);
    if (!runId || !Number.isFinite(batchIndex)) return sendError(res, 400, '缺少 run_id 或 batch_index');
    const run = RebuildStore.getRun(runId);
    if (!run) return sendError(res, 404, '重建运行不存在');
    const batch = RebuildStore.getBatchByIndex(runId, batchIndex);
    if (!batch) return sendError(res, 404, `批次 ${batchIndex} 不存在`);
    if (run.status === 'cancelled' || run.status === 'confirmed') return sendError(res, 409, `运行已 ${run.status}：不能再记录结果`);

    // 记录前必须复核基线：正文/配置变了就拒绝把结果记进旧批次（否则会留下"看起来已完成"的脏批次）。
    const chapters = plainChapters(run.work_id);
    const plan = ImportRebuild.planBatches(chapters, { batchSize: run.batch_size, route: run.route, extractorVersion: run.extractor_version, schemaVersion: run.schema_version, categories: run.categories });
    const current = plan[batchIndex];
    const sameSources = current && batch.chapter_hashes.length === current.chapter_hashes.length && batch.chapter_hashes.every((h, i) => h === current.chapter_hashes[i]);
    if (!current || !sameSources || batch.baseline_hash !== current.baseline_hash) {
      RebuildStore.setBatchStatus(batch.id, 'stale', { error: '基线变化：本次结果按当前正文/配置重算，不能记入旧批次' });
      return sendError(res, 409, `批次 ${batchIndex} 的基线已变化（正文或抽取配置改变）：请重新 plan 后再抽取`);
    }

    const chapterTexts = {};
    for (const cid of batch.chapter_ids) {
      const row = RebuildStore.chapterById(run.work_id, cid);
      chapterTexts[cid] = row ? htmlToPlain(row.content) : '';
    }
    const validated = ImportRebuild.validateExtraction(body.result !== undefined ? body.result : body.raw, { chapterTexts, chapterIds: batch.chapter_ids });
    const attempts = batch.attempts + 1;
    if (!validated.ok) {
      const summary = validated.errors.slice(0, 3).map((e) => `${e.code}@${e.index}: ${e.message}`).join('；');
      const failed = attempts >= ImportRebuild.REBUILD_LIMITS.max_attempts;
      RebuildStore.setBatchStatus(batch.id, failed ? 'failed' : 'pending', { error: summary, attempts });
      return sendError(res, 400, `抽取结果未通过校验（第 ${attempts}/${ImportRebuild.REBUILD_LIMITS.max_attempts} 次）${failed ? '，已达上限标记失败' : ''}：${summary}`);
    }
    const mapped = ImportRebuild.extractionToProposals(validated, { workId: run.work_id, batch: current });
    const resultHash = ImportRebuild.resultHashOf({ items: validated.items, upstream: body.result_hash || '' });
    const saved = RebuildStore.recordBatch(batch.id, { result: { items: validated.items, stats: validated.stats, upstream_hash: asString(body.result_hash, '') }, resultHash, proposals: mapped.proposals, status: 'extracted', attempts });
    if (run.status === 'planned') RebuildStore.setRunStatus(run.id, 'running');
    return sendJSON(res, 201, {
      ok: true, run_id: run.id, batch_index: batchIndex,
      status: saved.status, result_hash: resultHash,
      stats: validated.stats, proposals: mapped.proposals.length, skipped: mapped.skipped,
      note: `候选已记录（未写入任何正式状态）：${mapped.proposals.length} 条提案草稿待作者确认。`,
    });
  }

  // ── 作者确认（逐批短事务写提案；抽取/合并不在事务里）──────────────────
  if (method === 'POST' && leaf === 'confirm') {
    if (isAgentRequest(req)) return sendError(res, 403, '重建结果的确认只能由作者发起（模型侧不能确认自己的抽取）');
    const body = await readBody(req);
    const runId = Number(body.run_id) || 0;
    const run = RebuildStore.getRun(runId);
    if (!run) return sendError(res, 404, '重建运行不存在');
    if (run.status === 'cancelled') return sendError(res, 409, '运行已取消：先 plan（带 run_id）恢复再确认');
    const want = Array.isArray(body.batch_indexes) && body.batch_indexes.length ? new Set(body.batch_indexes.map(Number)) : null;
    const chapters = plainChapters(run.work_id);
    const plan = ImportRebuild.planBatches(chapters, { batchSize: run.batch_size, route: run.route, extractorVersion: run.extractor_version, schemaVersion: run.schema_version, categories: run.categories });
    const byIndex = new Map(plan.map((p) => [Number(p.index), p]));
    const results = [];
    let applied = 0, stale = 0, skipped = 0, proposalsCreated = 0;
    for (const batch of RebuildStore.listBatches(run.id)) {
      if (want && !want.has(Number(batch.batch_index))) continue;
      if (batch.status === 'confirmed') { results.push({ batch_index: batch.batch_index, verdict: 'already_confirmed', proposal_ids: batch.proposal_ids }); skipped += 1; continue; }
      if (batch.status !== 'extracted') { results.push({ batch_index: batch.batch_index, verdict: 'not_recorded', status: batch.status }); skipped += 1; continue; }
      const current = byIndex.get(Number(batch.batch_index));
      const sameSources = current && batch.chapter_hashes.length === current.chapter_hashes.length && batch.chapter_hashes.every((h, i) => h === current.chapter_hashes[i]);
      if (!current || !sameSources || batch.baseline_hash !== current.baseline_hash) {
        RebuildStore.setBatchStatus(batch.id, 'stale', { error: '确认时复核发现基线变化：结果作废须重跑' });
        results.push({ batch_index: batch.batch_index, verdict: 'stale', reason: '基线变化（正文或抽取配置改变）' });
        stale += 1; continue;
      }
      // 逐批短事务 = 一个「确认单元」：登记提案 + **批量原子应用**（全批只做一次基线核对）。
      // 为什么不是逐条 apply：同批候选来自同一基线快照，逐条应用会让后一条被判 stale；
      // 为什么整批回滚：拒绝/失败不得留下半套正式状态（提案也不会残留）。
      if (!batch.proposals.length) {
        RebuildStore.setBatchStatus(batch.id, 'confirmed');
        results.push({ batch_index: batch.batch_index, verdict: 'confirmed', proposal_ids: [], note: '本批没有候选（空批：只登记完成，不写任何状态）' });
        applied += 1;
        continue;
      }
      let verdict = null;
      try {
        verdict = StoryState.transaction(() => {
          const state = StoryState.readState(run.work_id, { chapterId: batch.chapter_ids[0] ?? null });
          const created = batch.proposals.map((draft) => StoryState.createProposal(StoryState.buildProposal({
            workId: run.work_id, chapterId: draft.chapter_id, kind: draft.kind, payload: draft.payload,
            state, contextHash: draft.dedup_key, note: draft.note, dedupKey: draft.dedup_key,
          })).id);
          const batchApply = StoryState.applyProposalsBatch(created);
          if (!batchApply.ok) {
            const err = new Error(batchApply.reason || '批量应用失败');
            err.verdict = batchApply;
            throw err; // 整批回滚：状态不动、提案不留（不留半套）
          }
          RebuildStore.setBatchProposalIds(batch.id, created);
          RebuildStore.setBatchStatus(batch.id, 'confirmed');
          return { ids: created, apply: batchApply };
        });
      } catch (e) {
        const why = e && e.verdict ? e.verdict.decision : 'error';
        log({ level: 'error', layer: 'server', kind: 'import_rebuild_confirm', message: `批次 ${batch.batch_index} 确认失败（${why}）：${e.message}`, error: e });
        if (why === 'stale') stale += 1;
        results.push({ batch_index: batch.batch_index, verdict: why === 'stale' ? 'stale' : 'error', reason: e.message });
        continue;
      }
      proposalsCreated += verdict.ids.length;
      results.push({ batch_index: batch.batch_index, verdict: 'confirmed', proposal_ids: verdict.ids, applied_ops: verdict.apply.ops, snapshot_id: verdict.apply.snapshot_id });
      applied += 1;
    }
    const batches = RebuildStore.listBatches(run.id);
    const allConfirmed = batches.length > 0 && batches.every((b) => b.status === 'confirmed');
    if (allConfirmed) RebuildStore.setRunStatus(run.id, 'confirmed');
    // 成功后走既有同步器；装配器是否注入重建成果取决于作品是否开启了确定性故事状态——
    // 未开启时不得宣称「已完整重建上下文」。
    let synced = false;
    try { const out = await syncWorkFull(run.work_id); synced = !!(out && out.ok !== false); } catch (e) { log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `重建后同步失败（work ${run.work_id}）：${e.message}` }); }
    const enabled = StoryState.isEnabled(run.work_id);
    touchWork(run.work_id);
    return sendJSON(res, 200, {
      ok: true, run: RebuildStore.getRun(run.id),
      results, applied, stale, skipped, proposals_created: proposalsCreated,
      progress: RebuildStore.progressOf(run.id),
      rebuild_complete: allConfirmed,
      assembled: {
        story_state_enabled: enabled,
        context_ready: allConfirmed && enabled,
        synced,
        note: allConfirmed
          ? (enabled ? '全部批次已确认；故事状态层已随装配写入可续写上下文。' : '全部批次已确认，但该作品未开启确定性故事状态：提案已登记，装配器暂不注入（打开开关后即生效）。')
          : '仍有未确认/过期的批次：不得宣称已完整重建（状态端点可查看剩余批次）。',
      },
    });
  }

  // ── 取消（保留已记录结果；恢复用 plan + run_id）────────────────────────
  if (method === 'POST' && leaf === 'cancel') {
    const body = await readBody(req);
    const runId = Number(body.run_id) || 0;
    const run = RebuildStore.getRun(runId);
    if (!run) return sendError(res, 404, '重建运行不存在');
    const saved = RebuildStore.setRunStatus(run.id, 'cancelled', asString(body.note, '') || null);
    return sendJSON(res, 200, { ok: true, run: saved, progress: RebuildStore.progressOf(run.id), note: '已取消：已记录的批次结果保留，恢复时用 plan 带 run_id 继续（基线不一致的批次会标 stale）。' });
  }

  return false;
}
async function handleStoryStateRoute({ segments, method, query, req, res }) {
  const sub = segments[2];
  const leaf = segments[3] || '';
  const leaf2 = segments[4] || '';
  const workIdOf = (v) => Number(v) || 0;

  // ── 开关与总览 ────────────────────────────────────────────────────────────
  if (sub === 'story_state' && method === 'GET') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const work = prepare('SELECT id FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    return sendJSON(res, 200, {
      ok: true,
      ...StoryState.summaryOf(workId),
      phases: StoryState.PHASES,
      foreshadow_states: StoryState.FORESHADOW_STATES,
      conflict_levels: StoryState.CONFLICT_LEVELS,
      priority_bands: StoryState.PRIORITY_BANDS,
      kernel_version: StoryState.STORY_STATE_VERSION,
    });
  }
  if (sub === 'story_state' && method === 'PUT') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const work = prepare('SELECT id FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    const enabled = body.enabled === true || body.enabled === 1 || body.enabled === '1';
    const saved = StoryState.setEnabled(workId, enabled, asString(body.note, ''));
    // 开关一变，装配结果必须失效——否则界面会继续用旧上下文（含/不含 story_state 层）。
    touchWork(workId);
    notifyChange('novel_context', { workId, id: workId });
    return sendJSON(res, 200, { ok: true, ...saved, summary: StoryState.summaryOf(workId) });
  }

  if (sub !== 'state') return false;

  // ── 只读：状态明细 ────────────────────────────────────────────────────────
  if (method === 'GET' && leaf === 'timeline') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const entries = StoryState.readTimeline(workId);
    const cursor = StoryState.cursorOf({ chapterIndex: query.chapter_id ? StoryState.chapterIndexOf(Number(query.chapter_id)) : 0 });
    const view = StoryState.buildTimelineView(entries, cursor);
    return sendJSON(res, 200, { ok: true, work_id: workId, cursor, entries, visible: view.visible.map((e) => e.id), conflicts: view.conflicts });
  }
  // 只读事实清单：supersede / merge / split 这类操作**必须**按 id 指认既有事实，
  // 而此前没有任何端点能把 fact id 交出来——插件只能凭猜。第五步联合回归发现并补上。
  if (method === 'GET' && leaf === 'facts') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const facts = StoryState.readFacts(workId);
    const chapterId = Number(query.chapter_id) || null;
    const cursor = StoryState.cursorOf({ chapterIndex: chapterId ? StoryState.chapterIndexOf(chapterId) : 0, chapter_id: chapterId });
    const projection = StoryState.projectCanon(facts, cursor);
    return sendJSON(res, 200, {
      ok: true, work_id: workId, chapter_id: chapterId, cursor,
      facts,
      visible_ids: projection.canon.map((f) => f.id),
      planned_ids: projection.planned.map((f) => f.id),
      future_ids: projection.future.map((f) => f.id),
      note: 'effective_from/to 与 chapter_index 都是 0 基下标（0 = 第一章）；展示给作者/模型时必须 +1。',
    });
  }
  if (method === 'GET' && leaf === 'entities') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const entities = StoryState.readEntities(workId);
    const aliases = entities.flatMap((e) => (e.aliases || []).map((a) => ({ ...a, entity_id: e.id })));
    const built = StoryState.buildAliasIndex(entities, aliases);
    return sendJSON(res, 200, { ok: true, work_id: workId, entities, conflicts: StoryState.detectEntityConflicts(entities, aliases) });
  }
  if (method === 'GET' && leaf === 'knowledge') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const rows = StoryState.readKnowledge(workId);
    const chapterId = Number(query.chapter_id) || null;
    const cursor = StoryState.cursorOf({ chapterIndex: chapterId ? StoryState.chapterIndexOf(chapterId) : 0 });
    const filtered = query.character_id ? rows.filter((k) => String(k.character_id) === String(query.character_id)) : rows;
    return sendJSON(res, 200, {
      ok: true, work_id: workId, cursor, knowledge: filtered,
      scopes: StoryState.KNOWLEDGE_SCOPES, states: StoryState.KNOWLEDGE_STATES,
      by_character: query.character_id ? StoryState.knowledgeOf(rows, Number(query.character_id), cursor) : null,
    });
  }
  // ── R10：作者真相 / 读者已披露 / 各角色掌握（**只读派生**，不新增表、不写行、不缓存）──
  // 复用既有 story_facts / character_knowledge / chapters；章节重排/回滚/retcon/删除后必然重算，
  // 响应里的 fingerprint 可核对"这一份是不是按当前数据重算出来的"。
  if (method === 'GET' && leaf === 'disclosure') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const chapterId = Number(query.chapter_id) || 0;
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id（披露判断必须以具体章节为时点，不能笼统说"读者知道"）');
    const row = prepare('SELECT id, work_id, title, content FROM chapters WHERE id = ?').get(chapterId);
    if (!row || Number(row.work_id) !== workId) return sendError(res, 404, '章节不存在或不属于该作品');
    const { ordered } = StoryState.chapterIndexMap(workId);
    const chapterRows = prepare('SELECT id, title, content, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
    const chapters = chapterRows.map((c) => ({
      id: c.id, title: c.title, index: ordered.indexOf(Number(c.id)),
      written: !!htmlToPlain(c.content || '').trim(),
    }));
    const at = chapters.findIndex((c) => Number(c.id) === chapterId);
    const cursor = StoryState.cursorOf({
      chapterIndex: at >= 0 ? at : 0,
      sceneIndex: query.scene !== undefined && query.scene !== '' ? Number(query.scene) : null,
      chapterId,
    });
    const view = StoryState.deriveDisclosure({
      facts: StoryState.readFacts(workId),
      knowledge: StoryState.readKnowledge(workId),
      chapters,
      characters: prepare('SELECT id, name FROM characters WHERE work_id = ? ORDER BY id ASC').all(workId),
      cursor,
      character_id: query.character_id ? Number(query.character_id) : null,
    });
    return sendJSON(res, 200, {
      ok: true, work_id: workId, chapter_id: chapterId,
      chapter_title: row.title, state_enabled: StoryState.isEnabled(workId), ...view,
    });
  }
  if (method === 'GET' && leaf === 'foreshadows') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const chapterId = Number(query.chapter_id) || null;
    const cursor = StoryState.cursorOf({ chapterIndex: chapterId ? StoryState.chapterIndexOf(chapterId) : 0 });
    const { items, eventsById } = StoryState.readForeshadows(workId);
    const derived = StoryState.deriveForeshadows(items, { cursor, eventsById });
    return sendJSON(res, 200, {
      ok: true, work_id: workId, cursor, states: StoryState.FORESHADOW_STATES,
      by_state: derived.byState, items: derived.items,
      problems: StoryState.foreshadowProblems(derived),
      note: '派生视图：宿主的 foreshadow_status（open/resolved/dropped）语义与端点未变，这里只是叠加推进度与逾期判定。',
    });
  }
  if (method === 'GET' && leaf === 'snapshots') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, { ok: true, work_id: workId, snapshots: StoryState.listSnapshots(workId, Number(query.limit) || 20) });
  }
  if (method === 'GET' && leaf === 'validations') {
    const chapterId = Number(query.chapter_id) || 0;
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    return sendJSON(res, 200, { ok: true, chapter_id: chapterId, validations: StoryState.listValidations(chapterId, query.phase || null) });
  }
  if (method === 'GET' && leaf === 'contract') {
    const chapterId = Number(query.chapter_id) || 0;
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const contract = StoryState.readContract(chapterId);
    return sendJSON(res, 200, {
      ok: true, chapter_id: chapterId, contract,
      versions: StoryState.listContractVersions(chapterId),
      fields: StoryState.CONTRACT_FIELDS,
    });
  }

  // ── 契约写入 ──────────────────────────────────────────────────────────────
  if (method === 'PUT' && leaf === 'contract') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id) || 0;
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const ch = prepare('SELECT id, work_id FROM chapters WHERE id = ?').get(chapterId);
    if (!ch) return sendError(res, 404, '章节不存在');
    const workId = workIdOf(body.work_id) || Number(ch.work_id);
    const saved = StoryState.saveContract(workId, chapterId, body.contract || body, { note: asString(body.note, '') });
    touchWork(workId);
    return sendJSON(res, 200, { ok: true, ...saved });
  }

  // ── 写前预检（只读；persist=true 才落记录）────────────────────────────────
  if (method === 'POST' && leaf === 'preflight') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    const chapterId = Number(body.chapter_id) || null;
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (!StoryState.isEnabled(workId)) {
      return sendJSON(res, 200, {
        ok: true, enabled: false, work_id: workId, chapter_id: chapterId,
        risks: [], blocking: false, summary: { counts: {}, total: 0 },
        note: '该作品未开启确定性故事状态，预检未运行（开关关闭时不产生任何额外计算）。',
      });
    }
    const comp = StoryState.compositionOf(workId, chapterId);
    const result = StoryState.preflightOf(comp);
    let validationId = null;
    if (body.persist === true && comp) {
      validationId = StoryState.saveValidation({
        workId, chapterId, phase: 'preflight',
        contractHash: comp.contract ? comp.contract.contract_hash : '',
        stateHashValue: StoryState.stateHash(workId, { chapterId }),
        result,
      }).id;
    }
    return sendJSON(res, 200, { ok: true, enabled: true, work_id: workId, chapter_id: chapterId, validation_id: validationId, ...result });
  }

  // ── 写后校验（只读；persist=true 才落记录）───────────────────────────────
  if (method === 'POST' && leaf === 'validate') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    const chapterId = Number(body.chapter_id) || null;
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const draft = typeof body.draft === 'string' ? body.draft : '';
    if (!StoryState.isEnabled(workId)) {
      return sendJSON(res, 200, {
        ok: true, enabled: false, work_id: workId, chapter_id: chapterId,
        passed: null, checks: [], summary: { total: 0, pass: 0, fail: 0, unknown: 0 },
        note: '该作品未开启确定性故事状态，写后校验未运行。',
      });
    }
    const comp = StoryState.compositionOf(workId, chapterId);
    const result = StoryState.validateOf(comp, draft, {
      stateChanges: Array.isArray(body.state_changes) ? body.state_changes : [],
      styleHits: Array.isArray(body.style_hits) ? body.style_hits : [],
    });
    let validationId = null;
    if (body.persist === true && comp) {
      validationId = StoryState.saveValidation({
        workId, chapterId, phase: 'post',
        contractHash: comp.contract ? comp.contract.contract_hash : '',
        stateHashValue: StoryState.stateHash(workId, { chapterId }),
        result: { passed: result.passed, counts: result.counts, summary: result.summary, checks: result.checks, conflicts: result.conflicts },
      }).id;
    }
    return sendJSON(res, 200, { ok: true, enabled: true, work_id: workId, chapter_id: chapterId, validation_id: validationId, ...result });
  }

  // ── 质量指标（描述性，不驱动任何改写）───────────────────────────────────
  if (method === 'POST' && leaf === 'quality') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    const chapterId = Number(body.chapter_id) || null;
    const draft = typeof body.draft === 'string' ? body.draft : '';
    if (!workId) return sendError(res, 400, '缺少 work_id');
    let dna = null;
    if (body.with_dna !== false) {
      const samples = prepare('SELECT content FROM chapters WHERE work_id = ? AND length(content) > 200 ORDER BY position DESC LIMIT 20')
        .all(workId).map((r) => r.content);
      dna = StoryState.buildStyleDna(samples).dna;
    }
    const measurement = StoryState.measureStyle(draft);
    const point = StoryState.qualityPoint({
      measurement, dna, hits: Array.isArray(body.style_hits) ? body.style_hits : [],
      chapterId, at: new Date().toISOString(),
      tokens: { in: Number(body.tokens_in) || 0, out: Number(body.tokens_out) || 0 },
      latencyMs: Number(body.latency_ms) || 0,
    });
    return sendJSON(res, 200, { ok: true, work_id: workId, measurement, style_dna: dna, point });
  }

  // ── 提案 ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && leaf === 'proposals') {
    const workId = workIdOf(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, {
      ok: true, work_id: workId,
      proposals: StoryState.listProposals(workId, { state: query.state || null, limit: Number(query.limit) || 50 }),
      states: StoryState.PROPOSAL_STATES,
      kinds: Object.entries(StoryState.PROPOSAL_KINDS).map(([k, v]) => ({ kind: k, table: v.table, label: v.label, destructive: !!v.destructive })),
    });
  }
  if (method === 'POST' && leaf === 'proposals' && !leaf2) {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    const chapterId = Number(body.chapter_id) || null;
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (!StoryState.isEnabled(workId)) return sendError(res, 400, '该作品未开启确定性故事状态（先在 /api/novel/story_state 打开开关）');
    const kind = asString(body.kind, '');
    if (!StoryState.isKnownKind(kind)) {
      return sendError(res, 400, `kind 必须是以下之一：${Object.keys(StoryState.PROPOSAL_KINDS).join('/')}`);
    }
    const state = StoryState.readState(workId, { chapterId });
    const proposal = StoryState.buildProposal({
      workId, chapterId, kind, payload: body.payload || {},
      state,
      contextHash: asString(body.context_hash, ''),
      contractHash: (StoryState.readContract(chapterId) || {}).contract_hash || '',
      note: asString(body.note, ''), dedupKey: asString(body.dedup_key, ''),
    });
    const { id } = StoryState.createProposal(proposal);
    return sendJSON(res, 201, {
      ok: true, id, work_id: workId, chapter_id: chapterId, kind,
      base_state_hash: proposal.base_state_hash,
      requires_author: proposal.requires_author === 1,
      note: '提案已登记（未写入任何状态）。复核后用 /api/novel/state/proposals/apply 应用。',
    });
  }
  if (method === 'POST' && leaf === 'proposals' && (leaf2 === 'review' || leaf2 === 'apply' || leaf2 === 'reject')) {
    const body = await readBody(req);
    if (leaf2 === 'reject') {
      const verdict = StoryState.rejectProposal(Number(body.id) || 0, asString(body.note, ''));
      if (!verdict.ok) return sendError(res, 404, verdict.reason);
      return sendJSON(res, 200, { ok: true, ...verdict });
    }
    if (leaf2 === 'review') {
      const verdict = StoryState.review(Number(body.id) || 0, { chapterId: Number(body.chapter_id) || null });
      if (verdict.decision === 'not_found') return sendError(res, 404, verdict.reason);
      return sendJSON(res, 200, { ok: !!verdict.ok, ...verdict, plan_ops: verdict.plan ? verdict.plan.ops.length : 0 });
    }
    // apply：支持单条 / 多条 / 全部待定
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => n > 0)
      : (Number(body.id) > 0 ? [Number(body.id)] : []);
    let targets = ids;
    const workId = workIdOf(body.work_id);
    if (body.all === true) {
      if (!workId) return sendError(res, 400, 'all=true 时需要 work_id');
      targets = StoryState.listProposals(workId, { state: 'pending', limit: 200 }).map((p) => p.id);
    }
    if (!targets.length) return sendError(res, 400, '需要 id / ids / all 之一');
    // R02.2：模型侧（X-Novel-Agent）一次只允许应用**一条**提案，且必须引用作者为该提案
    // （精确到 id 与内容版本哈希）创建的审批；审批消费在 applyProposal 的同一事务内完成。
    let agentApprovalId = '';
    if (isAgentRequest(req)) {
      if (targets.length !== 1) {
        return sendError(res, 403, '模型侧一次只能应用一条状态提案（请作者逐条授权；批量应用请由作者在界面完成）');
      }
      const p = StoryState.getProposal(targets[0]);
      if (!p) return sendError(res, 404, `提案 #${targets[0]} 不存在`);
      const guard = guardAgentWrite(req, {
        op: 'state_proposal_apply', workId: Number(p.work_id) || Number(workId) || 0, chapterId: p.chapter_id ?? null,
        baselineHash: Approvals.proposalsBaselineHash([p]),
        binding: { proposals: [targets[0]], hashes: { [String(targets[0])]: Approvals.proposalHash(p) } },
        approvalId: body.approval_id, consume: false,
      });
      if (!guard.ok) return sendError(res, guard.status, guard.message);
      agentApprovalId = guard.approval.id;
    }
    const results = targets.map((id) => {
      if (!agentApprovalId) return StoryState.applyProposal(id);
      const p = StoryState.getProposal(id);
      return StoryState.applyProposal(id, {
        onBeforeCommit: () => {
          const verdict = Approvals.consumeApproval(agentApprovalId, {
            op: 'state_proposal_apply', workId: Number(p.work_id) || Number(workId) || 0, chapterId: p.chapter_id ?? null,
            baselineHash: Approvals.proposalsBaselineHash([p]),
            binding: { proposals: [id], hashes: { [String(id)]: Approvals.proposalHash(p) } },
            by: 'agent',
          });
          if (!verdict.ok) throw new Error(`审批消费失败（${verdict.code}）：${verdict.reason}`);
        },
      });
    });
    const applied = results.filter((r) => r.ok).length;
    const stale = results.filter((r) => r.decision === 'stale').length;
    // ⚠ 状态一改，上下文缓存必须失效：缓存键是 (work, chapter, mode)，它**不含状态哈希**，
    // 于是"应用提案之后界面仍显示旧上下文"是真实会发生的事（本轮的端到端测试抓到过一次：
    // 回滚后新增事实仍出现在上下文里）。所以按提案归属的作品逐个作废，不靠调用方传 work_id。
    const touched = new Set();
    for (const r of results) {
      const wid = Number(r.work_id) || Number(workId) || 0;
      if (wid > 0 && !touched.has(wid)) { touched.add(wid); touchWork(wid); }
    }
    if (applied) notifyChange('events', { workId: Number(workId) || 0, id: Number(workId) || 0 });
    return sendJSON(res, 200, { ok: results.every((r) => r.ok), applied, stale, results });
  }

  // ── 快照 / 回滚 ───────────────────────────────────────────────────────────
  if (method === 'POST' && leaf === 'snapshot') {
    const body = await readBody(req);
    const workId = workIdOf(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const snap = StoryState.createSnapshot(workId, {
      reason: asString(body.reason, '手动快照'), label: asString(body.label, ''),
      chapterId: Number(body.chapter_id) || null,
    });
    return sendJSON(res, 201, { ok: true, work_id: workId, ...snap });
  }
  if (method === 'POST' && leaf === 'rollback') {
    const body = await readBody(req);
    const snapshotId = Number(body.snapshot_id) || 0;
    if (!snapshotId) return sendError(res, 400, '缺少 snapshot_id');
    // R02.2：回滚是破坏性状态操作，模型侧必须引用作者为**这个快照**创建的一次性审批；
    // 消费与回滚在同一事务（onBeforeCommit）里完成。
    let agentApprovalId = '';
    if (isAgentRequest(req)) {
      const snap = StoryState.getSnapshot(snapshotId);
      if (!snap) return sendError(res, 404, `快照 #${snapshotId} 不存在`);
      const guard = guardAgentWrite(req, {
        op: 'state_rollback', workId: Number(snap.work_id) || 0, chapterId: snap.chapter_id ?? null,
        baselineHash: String(snap.state_hash || ''), binding: { snapshot_id: snapshotId },
        approvalId: body.approval_id, consume: false,
      });
      if (!guard.ok) return sendError(res, guard.status, guard.message);
      agentApprovalId = guard.approval.id;
    }
    const verdict = agentApprovalId
      ? StoryState.rollbackToSnapshot(snapshotId, {
          onBeforeCommit: ({ workId }) => {
            const snap = StoryState.getSnapshot(snapshotId);
            const consume = Approvals.consumeApproval(agentApprovalId, {
              op: 'state_rollback', workId, chapterId: snap ? snap.chapter_id ?? null : null,
              baselineHash: String(snap && snap.state_hash || ''), binding: { snapshot_id: snapshotId }, by: 'agent',
            });
            if (!consume.ok) throw new Error(`审批消费失败（${consume.code}）：${consume.reason}`);
          },
        })
      : StoryState.rollbackToSnapshot(snapshotId);
    if (!verdict.ok) return sendError(res, verdict.reason.includes('不存在') ? 404 : 400, verdict.reason);
    // 同上：回滚改的是状态，缓存必须跟着失效，否则作者会看到"回滚了但没变"。
    if (Number(verdict.work_id) > 0) { touchWork(Number(verdict.work_id)); notifyChange('events', { workId: Number(verdict.work_id) }); }
    return sendJSON(res, 200, { ok: true, ...verdict });
  }

  return false;
}

  // ---------- Novel Studio 创作内核（供 dsh 插件 / 后台自动化调用） ----------
  if (resource === 'novel' && segments[2] === 'ping' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, service: 'novel-studio', engine: 'novel-core', port: PORT, host_contract: HOST_CONTRACT_VERSION });
  }
  // 确定性故事状态（门控）：开关与总览在 /api/novel/story_state，状态读写在 /api/novel/state/*。
  if (resource === 'novel' && (segments[2] === 'story_state' || segments[2] === 'state')) {
    const handled = await handleStoryStateRoute({ segments, method, query, req, res });
    if (handled !== false) return handled;
  }
  // ---------- 作者审批（R02.2）：模型侧写入的执行边界 ----------
  // 创建/撤销**拒绝模型通道**（X-Novel-Agent），只有作者界面能产生审批；查询两种通道都可读。
  if (resource === 'novel' && segments[2] === 'approvals') {
    if (method === 'GET') {
      const workId = Number(query.work_id);
      if (!workId) return sendError(res, 400, '缺少 work_id');
      return sendJSON(res, 200, {
        ok: true,
        ops: Approvals.APPROVAL_OPS,
        approvals: Approvals.listApprovals(workId, { status: asString(query.status, 'active') || 'active', limit: Number(query.limit) || 50 }),
      });
    }
    if (method === 'POST' && (segments[3] === undefined || segments[3] === '')) {
      if (isAgentRequest(req)) return sendError(res, 403, '审批不能由模型侧创建：请作者在工坊界面确认（该请求带 X-Novel-Agent 标记）');
      const body = await readBody(req);
      const workId = Number(body.work_id);
      if (!workId) return sendError(res, 400, '缺少 work_id');
      if (!prepare('SELECT id FROM works WHERE id = ?').get(workId)) return sendError(res, 404, '作品不存在');
      const op = asString(body.op, '');
      if (!Approvals.APPROVAL_OPS.includes(op)) return sendError(res, 400, `op 必须是 ${Approvals.APPROVAL_OPS.join(' / ')}`);
      const chapterId = Number(body.chapter_id) || null;
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => n > 0) : [];
      if ((op === 'chapter_save' || op === 'state_proposal_apply' || op === 'proposal_apply') && !chapterId && op === 'chapter_save') {
        return sendError(res, 400, 'chapter_save 审批需要 chapter_id');
      }
      // 基线与绑定一律由**服务端**计算，不接受客户端自报（客户端说谎没有意义）。
      let baselineHash = '';
      const binding = {};
      if (op === 'chapter_save') {
        const chapter = prepare('SELECT id, work_id, content FROM chapters WHERE id = ?').get(chapterId);
        if (!chapter) return sendError(res, 404, '章节不存在');
        if (Number(chapter.work_id) !== workId) return sendError(res, 400, '章节不属于该作品');
        baselineHash = Approvals.chapterBaselineHash(chapter.content);
        binding.chapter_id = chapterId;
      }
      if (op === 'state_proposal_apply' || op === 'proposal_apply') {
        if (!ids.length) return sendError(res, 400, '该操作的审批需要 ids（要授权的提案集合）');
        const rows = [];
        if (op === 'state_proposal_apply') {
          if (!StoryState.isEnabled(workId)) return sendError(res, 400, '该作品未开启确定性故事状态');
          for (const id of ids) {
            const r = StoryState.getProposal(id);
            if (!r) return sendError(res, 404, `提案 #${id} 不存在`);
            if (Number(r.work_id) !== workId) return sendError(res, 400, `提案 #${id} 不属于该作品`);
            rows.push(r);
          }
          baselineHash = Approvals.proposalsBaselineHash(rows);
        } else {
          for (const id of ids) {
            const r = prepare('SELECT *, \'event\' AS source_table FROM story_event_proposals WHERE id = ? AND work_id = ?').get(id, workId)
              || prepare('SELECT *, \'memory\' AS source_table FROM story_memory_proposals WHERE id = ? AND work_id = ?').get(id, workId);
            if (!r) return sendError(res, 404, `提案 #${id} 不存在或不属于该作品`);
            rows.push(r);
          }
          baselineHash = Approvals.legacyProposalsBaselineHash(rows);
        }
        binding.proposals = ids;
        binding.hashes = Object.fromEntries(rows.map((r) => [String(r.id), op === 'state_proposal_apply' ? Approvals.proposalHash(r) : Approvals.legacyProposalHash(r)]));
      }
      if (op === 'state_rollback') {
        const snapshotId = Number(body.snapshot_id) || 0;
        if (!snapshotId) return sendError(res, 400, 'state_rollback 审批需要 snapshot_id');
        const snap = StoryState.getSnapshot(snapshotId);
        if (!snap) return sendError(res, 404, '快照不存在');
        if (Number(snap.work_id) !== workId) return sendError(res, 400, '快照不属于该作品');
        baselineHash = String(snap.state_hash || '');
        binding.snapshot_id = snapshotId;
      }
      const row = Approvals.createApproval({
        workId, chapterId, op, baselineHash, binding,
        note: asString(body.note, ''), ttlMs: Number(body.ttl_ms) || undefined,
      });
      return sendJSON(res, 201, {
        ok: true, ...row,
        note: '一次性审批已创建。模型侧（X-Novel-Agent）引用 approval id 才能执行该写入；消费即失效。',
      });
    }
    if (method === 'POST' && segments[3] === 'revoke') {
      if (isAgentRequest(req)) return sendError(res, 403, '审批撤销只能由作者界面发起');
      const body = await readBody(req);
      const verdict = Approvals.revokeApproval(asString(body.id, ''), { by: 'author' });
      if (!verdict.ok) return sendError(res, 404, '审批不存在或已被消费/撤销');
      return sendJSON(res, 200, { ok: true, id: verdict.id, status: 'revoked' });
    }
  }
  // ---------- 整次采纳：正文 + 选中提案，一个事务（R03） ----------
  // 历史缺陷形状：前端先 chapter_save、再另发一次 proposals/apply —— 两次 fetch 之间没有任何
  // 原子性保证（旧实现还有"未 await / 先关弹窗再读勾选集合"）。这里把"一次采纳"做成宿主边界：
  // 同一 SQLite 事务里校验基线 → 应用状态提案 → 旧提案入账 → 写正文与历史版本 → 落投影 outbox。
  if (resource === 'novel' && segments[2] === 'adopt' && method === 'POST') {
    if (isAgentRequest(req)) {
      return sendError(res, 403, '采纳是作者界面动作：模型侧请走 chapter_save / state 提案的单条审批通道（整次采纳不接受 X-Novel-Agent）');
    }
    const body = await readBody(req);
    const workId = Number(body.work_id) || 0;
    if (!workId) return sendError(res, 400, '缺少 work_id');
    if (!prepare('SELECT id FROM works WHERE id = ?').get(workId)) return sendError(res, 404, '作品不存在');
    const chapterId = Number(body.chapter_id) || null;
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (chapterId && !chapter) return sendError(res, 404, '章节不存在');
    if (chapter && Number(chapter.work_id) !== workId) return sendError(res, 400, '章节不属于该作品');
    const contentProvided = typeof body.content === 'string' && body.content.trim() !== '';
    if (!contentProvided && !chapterId) return sendError(res, 400, 'adopt 需要 content（新正文）或 chapter_id 之一');
    const dedupe = (list) => [...new Set(list)];
    const stateSel = dedupe((Array.isArray(body.state_proposal_ids) ? body.state_proposal_ids : []).map(Number).filter((n) => n > 0));
    const legacySel = dedupe((Array.isArray(body.legacy_proposal_ids) ? body.legacy_proposal_ids : []).map(Number).filter((n) => n > 0));
    const expected = body.expected && typeof body.expected === 'object' ? body.expected : {};
    const opKey = asString(body.operation_key, '').trim();
    if (opKey.length < 8) return sendError(res, 400, '缺少 operation_key（整次采纳的幂等键，至少 8 个字符）');
    const norm = {
      work_id: workId,
      chapter_id: chapterId,
      content_hash: contentProvided ? sha16(String(body.content)) : '',
      title: contentProvided && body.title !== undefined ? asString(body.title, '') : '',
      summary: contentProvided && body.summary !== undefined ? asString(body.summary, '') : '',
      state_proposal_ids: stateSel,
      legacy_proposal_ids: legacySel,
      expected: {
        content_hash: asString(expected.content_hash, ''),
        state_hashes: expected.state_hashes && typeof expected.state_hashes === 'object' ? expected.state_hashes : {},
        legacy_hashes: expected.legacy_hashes && typeof expected.legacy_hashes === 'object' ? expected.legacy_hashes : {},
      },
    };
    const payloadHash = sha16(stableStringify(norm));
    const prior = prepare('SELECT * FROM adoption_operations WHERE idempotency_key = ?').get(opKey);
    if (prior) {
      if (String(prior.payload_hash) !== payloadHash) {
        return sendError(res, 409, '同一 operation_key 提交了不同内容（幂等键冲突）：原样重放返回原结果；要改内容请换新的 operation_key');
      }
      let saved = {};
      try { saved = JSON.parse(prior.result_json || '{}'); } catch (_) { saved = {}; }
      return sendJSON(res, 200, { ok: true, replayed: true, ...saved });
    }
    // 事务外预检（快速失败；真正的裁决在事务内重做一遍）
    const stateHashes = {};
    for (const id of stateSel) {
      const p = StoryState.getProposal(id);
      if (!p) return sendError(res, 404, `状态提案 #${id} 不存在`);
      if (Number(p.work_id) !== workId) return sendError(res, 400, `状态提案 #${id} 不属于该作品`);
      if (String(p.state) !== 'pending') return sendError(res, 409, `状态提案 #${id} 当前状态为 ${p.state}，不能应用（请刷新后重新选择）`);
      stateHashes[String(id)] = Approvals.proposalHash(p);
    }
    const legacyHashes = {};
    for (const id of legacySel) {
      const r = prepare(`SELECT *, 'event' AS source_table FROM story_event_proposals WHERE id = ? AND work_id = ?`).get(id, workId)
        || prepare(`SELECT *, 'memory' AS source_table FROM story_memory_proposals WHERE id = ? AND work_id = ?`).get(id, workId);
      if (!r) return sendError(res, 404, `提案 #${id} 不存在或不属于该作品`);
      if (String(r.status) !== 'pending') return sendError(res, 409, `提案 #${id} 已处理过（状态 ${r.status}）`);
      legacyHashes[String(id)] = Approvals.legacyProposalHash(r);
    }
    if (stateSel.length && !StoryState.isEnabled(workId)) return sendError(res, 400, '该作品未开启确定性故事状态，不能采纳状态提案');
    for (const [id, wantHash] of Object.entries(expected.state_hashes || {})) {
      if (wantHash && stateHashes[String(id)] && wantHash !== stateHashes[String(id)]) {
        return sendError(res, 409, `状态提案 #${id} 的内容在界面确认后发生了变化，请重新审阅后再采纳`);
      }
    }
    for (const [id, wantHash] of Object.entries(expected.legacy_hashes || {})) {
      if (wantHash && legacyHashes[String(id)] && wantHash !== legacyHashes[String(id)]) {
        return sendError(res, 409, `提案 #${id} 的内容在界面确认后发生了变化，请重新审阅后再采纳`);
      }
    }
    let result;
    try {
      result = withTx(() => {
        const freshChapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
        if (chapterId && !freshChapter) throw new Error('章节在采纳过程中被删除');
        const contentHashBefore = freshChapter ? Approvals.chapterBaselineHash(freshChapter.content) : '';
        if (contentProvided && chapterId && expected.content_hash && expected.content_hash !== contentHashBefore) {
          throw new Error('本章正文在确认之后被修改过（基线 hash 不一致），为避免覆盖新内容已拒绝采纳；请重新审阅');
        }
        // 1) 状态提案：内核自带的陈旧检查会拒绝 stale 项（这里直接让整次采纳回滚）
        const stateApplied = [];
        for (const id of stateSel) {
          const fresh = StoryState.getProposal(id);
          if (!fresh) throw new Error(`状态提案 #${id} 不存在`);
          if (Number(fresh.work_id) !== workId) throw new Error(`状态提案 #${id} 不属于该作品`);
          if (String(fresh.state) !== 'pending') throw new Error(`状态提案 #${id} 状态为 ${fresh.state}，不能应用`);
          if (stateHashes[String(id)] && Approvals.proposalHash(fresh) !== stateHashes[String(id)]) {
            throw new Error(`状态提案 #${id} 在采纳过程中被修改，请重新审阅`);
          }
          const r = StoryState.applyProposal(id);
          if (!r || r.ok !== true) throw new Error(`状态提案 #${id} 未应用：${(r && (r.reason || r.decision)) || '未知原因'}`);
          stateApplied.push({ proposal_id: id, snapshot_id: r.snapshot_id, state_hash_after: r.state_hash_after });
        }
        // 2) 旧提案（事件/长期记忆）：全有或全无——有任一被护栏拦下/状态不符就整次回滚
        let legacyApplied = { events: 0, memories: 0 };
        if (legacySel.length) {
          const settled = settleProposalsInTx(workId, { ids: legacySel, action: 'apply' });
          const failed = (settled.guard_failed || []).map((g) => g.proposal_id);
          const appliedCount = Number(settled.applied && settled.applied.events || 0) + Number(settled.applied && settled.applied.memories || 0);
          if (failed.length || appliedCount !== legacySel.length) {
            throw new Error(`旧提案未全部入账（达标 ${appliedCount}/${legacySel.length}${failed.length ? `，护栏拦下 #${failed.join('、#')}` : ''}）——已整次回滚`);
          }
          legacyApplied = { events: Number(settled.applied.events || 0), memories: Number(settled.applied.memories || 0) };
        }
        // 3) 正文（旧稿进历史版本）
        let contentVersionId = null;
        let contentHashAfter = contentHashBefore;
        if (contentProvided && freshChapter) {
          const content = String(body.content);
          const title = body.title !== undefined ? asString(body.title, freshChapter.title) : freshChapter.title;
          const summary = body.summary !== undefined ? asString(body.summary, freshChapter.summary) : freshChapter.summary;
          const v = saveChapterVersion(chapterId, freshChapter.title, freshChapter.summary, freshChapter.content);
          prepare('UPDATE chapters SET title = ?, summary = ?, content = ?, updated_at = ? WHERE id = ?')
            .run(title, summary, content, now(), chapterId);
          contentVersionId = Number(v.id);
          contentHashAfter = Approvals.chapterBaselineHash(content);
        }
        // 4) 投影 outbox（与正文同一事务；外部调用在提交后由 worker 执行）
        const projections = [];
        if (contentProvided || stateApplied.length || legacySel.length) {
          const proj = enqueueProjectionInTx(workId, {
            chapterId, kind: 'ov_work_sync', dedupKey: `adopt:${opKey}`,
            payload: { reason: 'adopt', operation_key: opKey, chapter_id: chapterId, adopt_kind: asString(body.adopt_kind, '') },
          });
          if (proj.id) projections.push(proj.id);
        }
        const out = {
          ok: true,
          adopt: {
            operation_key: opKey, work_id: workId, chapter_id: chapterId,
            adopt_kind: asString(body.adopt_kind, ''),
            content_version_id: contentVersionId,
            content_hash_before: contentHashBefore, content_hash_after: contentHashAfter,
            state_proposals: stateApplied, legacy: legacyApplied,
            projection_ids: projections, replayed: false,
          },
        };
        prepare(`INSERT INTO adoption_operations (idempotency_key, payload_hash, work_id, chapter_id, result_json)
                 VALUES (?, ?, ?, ?, ?)`).run(opKey, payloadHash, workId, chapterId || 0, stableStringify(out));
        return out;
      });
    } catch (e) {
      return sendError(res, 409, `采纳失败（已整体回滚，未写入任何内容）：${e.message}`);
    }
    touchWork(workId);
    notifyChange('chapters', { workId, id: chapterId || 0 });
    if (legacySel.length) notifyChange('events', { workId, id: workId });
    maybeAutoCompressMemory(workId);
    drainProjectionOutbox().catch(() => { /* 失败保留 failed，界面可见可重试 */ });
    return sendJSON(res, 200, result);
  }
  // 投影状态 / 恢复入口（R03/R04）：不是第二个调度器，只是 outbox 的查看与 retry。
  if (resource === 'novel' && segments[2] === 'projections') {
    if (method === 'GET') {
      const workId = Number(query.work_id) || 0;
      // R04：破坏性投影操作的审计（待删除集合 / 范围证明 / 结果）。
      if (segments[3] === 'audit') {
        if (!workId) return sendError(res, 400, '缺少 work_id');
        return sendJSON(res, 200, { ok: true, work_id: workId, audit: listProjectionAudit(workId, Number(query.limit) || 50) });
      }
      return sendJSON(res, 200, {
        ok: true, summary: projectionSummary(workId),
        projections: listProjections({ workId, status: asString(query.status, ''), limit: Number(query.limit) || 50 }),
      });
    }
    if (method === 'POST' && segments[3] === 'retry') {
      const body = await readBody(req);
      const reset = retryFailedProjections({ workId: Number(body.work_id) || 0, id: Number(body.id) || 0 });
      const drained = await drainProjectionOutbox();
      return sendJSON(res, 200, { ok: true, reset: reset.reset, ...drained });
    }
    // R04 replay：按**当前正式版本**重新投递投影（不删既有记忆；服务不可用时留在 pending）。
    if (method === 'POST' && segments[3] === 'replay') {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      const out = replayWorkProjection(workId, { reason: asString(body.reason, 'manual_replay') });
      if (!out.ok) return sendError(res, out.code === 'not_found' ? 404 : 409, out.reason || '重放未执行');
      drainProjectionOutbox().catch(() => { /* 失败留在 outbox，界面可见可重试 */ });
      return sendJSON(res, 200, out);
    }
    // R04 rebuild：范围证明（dry-run 默认）→ 作者显式确认后才执行删除+重建。
    // 目标资源归属由 planRebuild 逐条证明（命名空间内 + 形状符合已知同步布局）；
    // 证明不了就拒绝执行，绝不"先删再重建"。
    if (method === 'POST' && segments[3] === 'rebuild') {
      if (isAgentRequest(req)) return sendError(res, 403, '重建/删除派生资源是作者界面动作（不接受 X-Novel-Agent），防止模型自批破坏性操作');
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      const dryRun = body.dry_run === true || body.confirm !== true;
      const out = await rebuildWorkMemory(workId, { dryRun });
      if (!out.ok) return sendError(res, out.code === 'not_found' ? 404 : 409, out.reason || out.code || '重建未执行');
      return sendJSON(res, 200, out);
    }
  }
  // R05：运行时上下文贡献记录（只读；默认日志只记结构，不记正文/密钥）。
  // R07：编辑规则（三档编辑 / 七项能力 / 题材档）。
  // 读取开放（目录 + 当前选择 + 规则块）；**写入只接受作者界面**（拒绝 X-Novel-Agent）——
  // "哪些规则进入请求"是作者意图，模型无权自行开关规则。
  {
    const editingSettings = () => ({
      edit_rules_enabled: getAppSetting('edit_rules_enabled', '0'),
      edit_tier: getAppSetting('edit_tier', 'light'),
      edit_abilities: getAppSetting('edit_abilities', ''),
      edit_genre: getAppSetting('edit_genre', 'general'),
    });
    const editRulesState = (task = 'write') => {
      const selection = resolveEditingSelection(editingSettings());
      return { selection, block: buildEditingRuleBlock(selection, { task }) };
    };
    if (resource === 'novel' && segments[2] === 'editing' && segments[3] === 'rules' && method === 'GET') {
      const { selection, block } = editRulesState(asString(query.task, 'write'));
      return sendJSON(res, 200, { ok: true, selection, block });
    }
    if (resource === 'novel' && segments[2] === 'editing' && segments[3] === 'scan' && method === 'POST') {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      const chapterId = Number(body.chapter_id) || 0;
      const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
      if (chapterId && (!chapter || Number(chapter.work_id) !== workId)) return sendError(res, 404, '章节不存在或不属于该作品');
      const { selection } = editRulesState('review');
      // 只扫描**作者已启用**的能力；显式传 abilities 也不能越权打开未启用的能力（白名单求交）。
      const requested = Array.isArray(body.abilities) ? body.abilities.map((x) => String(x)) : selection.abilities;
      const abilities = requested.filter((id) => selection.abilities.includes(id));
      const text = typeof body.text === 'string' && body.text.trim() ? body.text : htmlToPlain((chapter && chapter.content) || '');
      const characters = prepare('SELECT id, name, personality, mes_example FROM characters WHERE work_id = ? ORDER BY name ASC').all(workId);
      const foreshadows = prepare("SELECT id, summary, foreshadow_status FROM story_events WHERE work_id = ? AND kind = 'foreshadow' ORDER BY id ASC").all(workId)
        .map((f) => ({ ...f, status: f.foreshadow_status }));
      const out = scanEditing(text, { abilities, genre: selection.genre, task: 'review', characters, foreshadows });
      return sendJSON(res, 200, {
        ok: true,
        work_id: workId, chapter_id: chapterId || null,
        selection: { ...selection, abilities },
        ...out,
      });
    }
    if (resource === 'novel' && segments[2] === 'editing' && method === 'GET') {
      const { selection, block } = editRulesState(asString(query.task, 'write'));
      return sendJSON(res, 200, { ok: true, catalog: editingRuleCatalog(), selection, block });
    }
    if (resource === 'novel' && segments[2] === 'editing' && method === 'PUT') {
      if (isAgentRequest(req)) return sendError(res, 403, '编辑规则开关是作者意图：不接受 X-Novel-Agent（模型不能自行开启/关闭规则）');
      const body = await readBody(req);
      const stored = editingSelectionToSettings(body);
      setAppSetting('edit_rules_enabled', stored.edit_rules_enabled);
      setAppSetting('edit_tier', stored.edit_tier);
      setAppSetting('edit_abilities', stored.edit_abilities);
      setAppSetting('edit_genre', stored.edit_genre);
      // 设置改动影响所有作品的装配结果：整体作废进程内缓存（与 touchWork 同口径，但不改 updated_at）。
      contextCache.invalidateAll();
      const { selection, block } = editRulesState(asString(body.task, 'write'));
      return sendJSON(res, 200, { ok: true, saved: stored, selection, block });
    }
  }
  // ── 共享资料库（library）─────────────────────────────────────────────
  // 资料是作者**显式导入**的参考材料（跨作品共享），不是本书事实：登记表与记忆库都不构成正典。
  // 读操作（status/search/doc）对模型开放（novel_library 工具用它查回被预算截断的原文）；
  // 写操作（导入/删除/开关）与 rebuild 同口径：拒绝 X-Novel-Agent——模型不能读本机任意目录、
  // 不能自行把资料层打开、也不能从共享资料库里删东西。Origin/Host 校验沿用全局 write 校验。
  if (resource === 'novel' && segments[2] === 'library') {
    const agent = isAgentRequest(req);
    const action = segments[3] || 'status';

    if (method === 'GET' && action === 'status') {
      const workId = Number(query.work_id) || 0;
      const docs = LibraryStore.listDocs({ status: 'active' });
      return sendJSON(res, 200, {
        ok: true,
        root: SHARED_LIBRARY_ROOT,
        work_id: workId || null,
        enabled: workId ? libraryEnabled(workId) : null,
        ov: {
          disabled: process.env.NOVELSTUDIO_OV_DISABLED === '1',
          semantic_enabled: semanticEnabled(),
          connected: Boolean(ovClient.connected),
          pending_ops: pendingQueueLength(),
        },
        index: { key: 'ov_indexed_at:library', last_indexed_at: getAppSetting('ov_indexed_at:library', '') },
        summary: LibraryStore.summary(),
        docs: docs.map((d) => ({ id: d.id, category: d.category, slug: d.slug, title: d.title, chars: d.chars, bytes: d.bytes, est_chunks: d.est_chunks, status: d.status, indexed_at: d.indexed_at, source_path: d.source_path })),
        ingest: {
          version: LIBRARY_INGEST_VERSION,
          exts: [...LIBRARY_INGEST.exts],
          max_file_bytes: LIBRARY_INGEST.maxFileBytes,
          max_files: LIBRARY_INGEST.maxFiles,
          ignore_dirs: [...LIBRARY_IGNORE_DIRS],
          symlink: '不跟随（文件与目录都跳过）',
        },
      });
    }

    if (method === 'GET' && action === 'search') {
      const q = String(query.q || '').trim();
      const category = String(query.category || '').trim();
      const limit = Math.min(Math.max(Number(query.limit) || 6, 1), 20);
      const docs = LibraryStore.listDocs({ status: 'active', category });
      if (!q) {
        return sendJSON(res, 200, {
          ok: true, q: '', category, mode: 'list', total: docs.length,
          hits: docs.slice(0, limit).map((d) => ({ id: d.id, category: d.category, slug: d.slug, title: d.title || d.slug, chars: d.chars, uri: d.uri })),
        });
      }
      let hits = [];
      let mode = 'keyword';
      if (ovEffectiveEnabled()) {
        const raw = await ovClient.find(q, { targetUri: SHARED_LIBRARY_ROOT, limit: limit + 4, scoreThreshold: 0.25, timeoutMs: 6000 }).catch(() => []);
        if (raw.length) {
          mode = 'semantic';
          const byUri = new Map(docs.map((d) => [d.uri, d]));
          for (const h of raw) {
            if (hits.length >= limit) break;
            const d = byUri.get(h.uri);
            // 查回只认登记表 + 形状闸门：未登记的条目（含 OV 伴随文件）与形状不合者一律不返回。
            if (!d || !checkLibraryShape(d.rel).ok) continue;
            hits.push({ id: d.id, category: d.category, slug: d.slug, title: d.title || d.slug, score: Math.round((Number(h.score) || 0) * 100), abstract: String(h.abstract || '').slice(0, 200), uri: d.uri });
          }
        }
      }
      if (!hits.length) {
        mode = 'keyword';
        const needle = q.toLowerCase();
        hits = docs.filter((d) => `${d.title} ${d.slug} ${d.category} ${d.source_path}`.toLowerCase().includes(needle))
          .slice(0, limit).map((d) => ({ id: d.id, category: d.category, slug: d.slug, title: d.title || d.slug, uri: d.uri }));
      }
      return sendJSON(res, 200, { ok: true, q, category, mode, total: docs.length, hits });
    }

    if (method === 'GET' && action === 'doc') {
      const docId = Number(query.id) || 0;
      const doc = docId ? LibraryStore.getDoc(docId) : null;
      if (!doc || doc.status !== 'active') return sendError(res, 404, '资料不存在或已被移除');
      const shape = checkLibraryShape(doc.rel);
      if (!shape.ok) return sendError(res, 409, `资料形状不合（${shape.reason}），拒绝读回`);
      const offset = Math.max(Number(query.offset) || 0, 0);
      const limit = Math.min(Math.max(Number(query.limit) || LIBRARY_RECALL.readLines, 1), 200);
      let text = '';
      if (ovEffectiveEnabled()) {
        const r = await ovClient.readContent(doc.uri, { offset, limit, timeoutMs: 8000 }).catch(() => ({ ok: false, text: '' }));
        text = r.ok ? r.text : '';
      }
      return sendJSON(res, 200, {
        ok: true,
        doc: { id: doc.id, uri: doc.uri, rel: doc.rel, category: doc.category, slug: doc.slug, title: doc.title, total_chars: doc.chars, total_bytes: doc.bytes, status: doc.status, indexed_at: doc.indexed_at },
        text,
      });
    }

    if (method === 'PUT' && action === 'enabled') {
      if (agent) return sendError(res, 403, '资料库开关是作者意图：不接受 X-Novel-Agent（模型不能自行把资料层打开/关闭）');
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      if (!prepare('SELECT id FROM works WHERE id = ?').get(workId)) return sendError(res, 404, '作品不存在');
      const enabled = body.enabled === true || String(body.enabled) === '1';
      setAppSetting(`library_enabled:${workId}`, enabled ? '1' : '0');
      // 开关改变该作品的装配结果：整体作废进程内缓存（与编辑规则同口径）。
      contextCache.invalidateAll();
      return sendJSON(res, 200, { ok: true, work_id: workId, enabled });
    }

    const runImportPlan = (dir) => {
      const scan = scanLibraryDir(dir);
      if (!scan.ok) return { ok: false, error: scan.error };
      return { ok: true, scan, plan: planLibraryImport(scan, LibraryStore.docByUriMap()) };
    };

    if (method === 'POST' && action === 'import' && segments[4] !== 'confirm') {
      if (agent) return sendError(res, 403, '资料导入会读取本机目录：不接受 X-Novel-Agent（模型不能读本机任意目录）');
      const body = await readBody(req);
      const dir = String(body.dir || '').trim();
      if (!dir) return sendError(res, 400, '缺少 dir（要扫描的资料目录）');
      const out = runImportPlan(dir);
      if (!out.ok) return sendError(res, 400, out.error);
      // 默认 dry-run：这个端点**从不写入**；执行走 POST /api/novel/library/import/confirm。
      return sendJSON(res, 200, { ok: true, dry_run: true, dir: out.plan.dir, items: out.plan.items, skipped: out.plan.skipped, truncated: out.plan.truncated, summary: out.plan.summary, rules: out.plan.rules });
    }

    if (method === 'POST' && action === 'import' && segments[4] === 'confirm') {
      if (agent) return sendError(res, 403, '资料导入会读取本机目录：不接受 X-Novel-Agent（模型不能读本机任意目录）');
      const body = await readBody(req);
      const dir = String(body.dir || '').trim();
      if (!dir) return sendError(res, 400, '缺少 dir（要扫描的资料目录）');
      const out = runImportPlan(dir);
      if (!out.ok) return sendError(res, 400, out.error);
      const { scan, plan } = out;
      if (!ovEffectiveEnabled()) return sendError(res, 409, '记忆库不可用（离线或总闸关闭）：未写入任何资料');
      const texts = new Map(scan.entries.map((e) => [e.rel_path, e.text]));
      const written = []; const failed = [];
      const indexedAt = new Date().toISOString();
      for (const it of plan.items) {
        if (it.action !== 'add' && it.action !== 'update') continue;
        const text = texts.get(it.rel_path);
        if (!text) { failed.push({ rel: it.rel, uri: it.uri, error: '扫描结果缺少正文（目录在计划后变化？请重新 dry-run）' }); continue; }
        const r = await ovClient.write(it.uri, text, { wait: false, timeoutMs: 30000 }).catch((e) => ({ ok: false, error: { message: e.message } }));
        if (!r.ok) { failed.push({ rel: it.rel, uri: it.uri, error: (r.error && r.error.message) || '写入失败' }); continue; }
        const saved = LibraryStore.upsertDoc({
          uri: it.uri, rel: it.rel, category: it.category, slug: it.slug, title: it.title,
          sha256: it.sha256, bytes: it.bytes, chars: it.chars, est_chunks: it.est_chunks,
          source_path: it.source_path, status: 'active', indexed_at: indexedAt,
        });
        // D3：确认导入时同步维护专用索引（只有 sha256 变化的条目才会走到这里）。
        // 索引是**派生数据**：写入失败只记日志，不得导致资料导入整体失败（允许后续 rebuild 修复）。
        try {
          if (saved && saved.ok && saved.doc) {
            const up = LibraryIndex.upsertEntry({
              docId: saved.doc.id, uri: it.uri, sha256: it.sha256,
              title: it.title, category: it.category, text,
            });
            if (!up || up.ok === false) {
              log({ level: 'warn', layer: 'ai', kind: 'library_index_write_failed', message: `资料索引写入失败（${it.rel}）：${(up && (up.status || up.error)) || 'unknown'}` });
            }
          }
        } catch (e) {
          log({ level: 'warn', layer: 'ai', kind: 'library_index_write_failed', message: `资料索引写入异常（${it.rel}）：${e.message}` });
        }
        written.push({ rel: it.rel, uri: it.uri, action: it.action, chars: it.chars });
      }
      if (written.length) setAppSetting('ov_indexed_at:library', indexedAt);
      contextCache.invalidateAll();
      return sendJSON(res, 200, {
        ok: failed.length === 0, executed: true, dir: plan.dir,
        written, failed, skipped: plan.skipped,
        summary: { ...plan.summary, written: written.length, failed: failed.length },
        index: { key: 'ov_indexed_at:library', at: written.length ? indexedAt : getAppSetting('ov_indexed_at:library', ''), wait: false, note: '异步索引：写后约 30 秒内可被召回（P0 实测 wait:true 阻塞 28.9s）' },
      });
    }

    if (method === 'DELETE' && action === 'doc' && segments[4]) {
      if (agent) return sendError(res, 403, '资料删除是作者动作：不接受 X-Novel-Agent（模型不能从共享资料库里删东西）');
      const docId = Number(segments[4]) || 0;
      const doc = docId ? LibraryStore.getDoc(docId) : null;
      if (!doc) return sendError(res, 404, '资料不存在');
      const confirm = query.confirm === '1' || query.confirm === 'true';
      if (!confirm) {
        LibraryStore.setStatus(doc.id, 'marked_missing');
        contextCache.invalidateAll();
        return sendJSON(res, 200, { ok: true, marked_missing: true, doc: { id: doc.id, status: 'marked_missing' }, hint: '默认只标记缺失；确认删除请带 confirm=1（会同时从记忆库删除该文件并删登记行）' });
      }
      const shape = checkLibraryShape(doc.rel);
      if (!shape.ok) return sendError(res, 409, `资料形状不合（${shape.reason}），拒绝执行删除（请手工处理该文件）`);
      if (!ovEffectiveEnabled()) return sendError(res, 409, '记忆库不可用（离线或总闸关闭）：删除未执行（登记行保留）');
      const rm = await ovClient.remove(doc.uri, { timeoutMs: 20000 }).catch((e) => ({ ok: false, error: { message: e.message } }));
      if (!rm.ok) return sendError(res, 409, `记忆库删除失败，登记行保留：${(rm.error && rm.error.message) || ''}`);
      LibraryStore.deleteDoc(doc.id);
      // D3：资料删除同步删除索引记录（失败不阻断删除本身；重建会再次兜底清理）。
      try { LibraryIndex.removeEntry(doc.id); } catch (e) { log({ level: 'warn', layer: 'ai', kind: 'library_index_write_failed', message: `资料索引删除失败（doc ${doc.id}）：${e.message}` }); }
      contextCache.invalidateAll();
      return sendJSON(res, 200, { ok: true, removed: doc.uri, id: doc.id });
    }

    // D5：资料索引的显式开关与重建（默认关闭；开关/重建是作者动作，模型侧 403）。
    // 词法候选只用于「候选发现与查询扩展」；语义阈值 0.40 / top-4 / 300 字 / 1200 字一律不放宽。
    if (action === 'index') {
      if (method === 'GET') {
        return sendJSON(res, 200, {
          ok: true,
          enabled: LibraryIndex.libraryIndexEnabled(),
          version: LibraryIndex.libraryIndexVersionInfo(),
          stats: LibraryIndex.indexStats(),
          note: '词法索引仅用于候选发现与查询扩展；候选/关键词/摘要不会进入模型上下文。',
        });
      }
      if (agent) return sendError(res, 403, '索引开关/重建是作者动作：不接受 X-Novel-Agent');
      if (method === 'PUT' && segments[4] === 'enabled') {
        const body = await readBody(req);
        const enabled = body.enabled === true || String(body.enabled) === '1';
        LibraryIndex.setLibraryIndexEnabled(enabled);
        contextCache.invalidateAll();
        return sendJSON(res, 200, { ok: true, enabled: LibraryIndex.libraryIndexEnabled(), version: LibraryIndex.libraryIndexVersionInfo() });
      }
      if (method === 'POST' && segments[4] === 'rebuild') {
        const docs = LibraryStore.listDocs({ status: 'active' });
        const out = LibraryIndex.rebuildFromRegistry(docs, { readText: (d) => LibraryIndex.readSourceText(d.source_path) });
        contextCache.invalidateAll();
        return sendJSON(res, 200, { ok: out.ok, ...out, version: LibraryIndex.libraryIndexVersionInfo() });
      }
      return sendError(res, 404, '未知的索引操作（可用 GET 状态 / PUT enabled / POST rebuild）');
    }

    return sendError(res, 404, '未知的资料库操作');
  }
  // ── E：小说资产索引（Novel Index Layer）的显式开关与重建 ────────────────────
  // 与资料索引同口径：默认关闭（novel_index_enabled=0）；开关/重建是作者动作，模型侧一律 403。
  // 索引是派生数据（单向来自正典表）、重建幂等；关闭时装配路径与基线一致。
  if (resource === 'novel' && segments[2] === 'novel_index') {
    const agent = isAgentRequest(req);
    if (method === 'GET') {
      const workId = Number(query.work_id) || 0;
      return sendJSON(res, 200, {
        ok: true,
        enabled: NovelIndexStore.novelIndexEnabled(),
        work_id: workId || null,
        version: workId ? NovelIndexStore.novelIndexVersion(workId) : null,
        version_key: workId ? NovelIndexStore.novelIndexVersionKey(workId) : null,
        schema: NovelIndexStore.NOVEL_INDEX_SCHEMA_VERSION,
        stats: NovelIndexStore.indexQueryStats(),
        tiers: {
          wired: ['character', 'event', 'foreshadow'],
          structure_only: ['world', 'relation', 'location', 'thread'],
          reserved: ['item', 'chapter', 'style', 'knowledge'],
        },
        note: '所有 E 类索引默认关闭；开启后仅执行「先定位后读取」的候选定位与审计，索引结果不作为新层注入。',
      });
    }
    if (agent) return sendError(res, 403, '索引开关/重建是作者动作：不接受 X-Novel-Agent');
    if (method === 'PUT') {
      const body = await readBody(req);
      const enabled = body.enabled === true || String(body.enabled) === '1';
      NovelIndexStore.setNovelIndexEnabled(enabled);
      contextCache.invalidateAll();
      return sendJSON(res, 200, { ok: true, enabled: NovelIndexStore.novelIndexEnabled() });
    }
    if (method === 'POST' && segments[3] === 'rebuild') {
      const workId = Number(query.work_id) || Number(segments[4]) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      const out = NovelIndexStore.rebuildWorkIndex(workId);
      contextCache.invalidateAll();
      return sendJSON(res, 200, { ok: out.ok, ...out, version_key: NovelIndexStore.novelIndexVersionKey(workId) });
    }
    return sendError(res, 404, '未知的小说索引操作（GET 状态 / PUT 开关 / POST rebuild）');
  }
  // ── R09：作者样文 / 文风档案 / 三级作者意图（作者侧写、模型侧读）────────────────
  // 边界：样文与档案是**风格证据**，不是本书事实；模型侧（X-Novel-Agent）不能写样文/档案/意图，
  // 只能读（避免"模型给自己注入风格证据"这条后门）。
  if (resource === 'novel' && segments[2] === 'style' && segments[3] === 'samples') {
    const agent = isAgentRequest(req);
    if (method === 'GET') {
      const workId = Number(query.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      return sendJSON(res, 200, { ok: true, work_id: workId, ...AuthorStyle.samplesSummary(workId) });
    }
    if (agent) return sendError(res, 403, '作者样文是作者侧数据：不接受 X-Novel-Agent（模型不能给自己注入风格证据）');
    if (method === 'POST' || method === 'PUT') {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const out = method === 'POST'
        ? AuthorStyle.createSample(workId, body, asString(body.source, 'author'))
        : AuthorStyle.updateSample(workId, Number(body.id), body);
      if (!out.ok) return sendError(res, method === 'PUT' ? 404 : 400, out.errors.join('；'));
      // 样文变更会改变 author_intent 门控层的存在与内容：必须让上下文缓存失效（与 touchWork 同口径）。
      touchWork(workId);
      return sendJSON(res, 200, { ok: true, work_id: workId, sample: out.sample, ...AuthorStyle.samplesSummary(workId) });
    }
    if (method === 'DELETE') {
      const workId = Number(query.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const out = AuthorStyle.deleteSample(workId, Number(query.id));
      if (!out.ok) return sendError(res, 404, '样文不存在或不属于该作品');
      touchWork(workId);
      return sendJSON(res, 200, { ok: true, work_id: workId, ...AuthorStyle.samplesSummary(workId) });
    }
  }
  if (resource === 'novel' && segments[2] === 'style' && segments[3] === 'profile') {
    if (method === 'GET') {
      const workId = Number(query.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const current = AuthorStyle.getProfile(workId);
      // stale 只按**启用**样文判定：停用的样文不参与档案的集合 hash（否则一停用就误报过期）。
      const enabledSamples = AuthorStyle.listSamples(workId).filter((s) => s.enabled);
      return sendJSON(res, 200, {
        ok: true, work_id: workId,
        profile: current ? current.profile : null,
        profile_hash: current ? current.profile_hash : null,
        sample_set_hash: current ? current.sample_set_hash : sampleSetHash(enabledSamples),
        analysis_version: current ? current.analysis_version : STYLE_PROFILE_VERSION,
        semantic_status: current ? current.semantic_status : 'not_run',
        // 样文增删改 / 档案版本变化 → 旧档案必须标 stale（不沿用失效数字）。
        stale: current ? isProfileStale(current.profile, enabledSamples) : true,
        notes: METRIC_NOTES, limits: SAMPLE_LIMITS,
      });
    }
    if (method === 'POST') {
      if (isAgentRequest(req)) return sendError(res, 403, '文风分析是作者侧操作：模型不能写作者档案');
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const out = AuthorStyle.analyzeAndSave(workId, { keep: body.keep, avoid: body.avoid });
      if (!out.ok) return sendError(res, 400, out.errors.join('；'));
      // 档案变化会让上一份装配结果里的文风证据过期：作废缓存，下一次装配重算。
      touchWork(workId);
      return sendJSON(res, 200, {
        ok: true, work_id: workId, profile: out.profile, profile_hash: out.profile_hash,
        sample_set_hash: out.sample_set_hash, semantic_status: out.semantic_status,
        replaced_previous: out.replaced_previous, notes: METRIC_NOTES,
      });
    }
  }
  if (resource === 'novel' && segments[2] === 'author_intent') {
    if (method === 'GET') {
      const workId = Number(query.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const chapterId = Number(query.chapter_id) || 0;
      const intents = AuthorStyle.listIntents(workId, chapterId);
      // 查回路径（契约 I4）：意图与样文证据在装配时会被预算裁剪，这里给出**未裁剪**的原文与统计。
      const samples = AuthorStyle.listSamples(workId).filter((s) => s.enabled);
      const current = AuthorStyle.getProfile(workId);
      const stale = current ? isProfileStale(current.profile, samples) : false;
      const evidence = buildStyleEvidence({ samples, profile: stale ? null : (current ? current.profile : null), maxChars: 6000 });
      return sendJSON(res, 200, {
        ok: true, work_id: workId, chapter_id: chapterId, intents,
        merged: mergeIntents(intents), tiers: INTENT_TIERS, priority: INTENT_PRIORITY,
        block: buildIntentBlock(intents),
        samples: samples.map((s) => ({ id: s.id, title: s.title, chars: s.chars, content_hash: s.content_hash })),
        profile: current ? current.profile : null,
        profile_hash: current ? current.profile_hash : null,
        profile_stale: stale,
        evidence: { text: evidence.text, chars: evidence.chars, truncated: evidence.truncated, sample_ids: evidence.sample_ids },
        limits: SAMPLE_LIMITS,
      });
    }
    if (method === 'PUT') {
      if (isAgentRequest(req)) return sendError(res, 403, '作者意图是作者侧数据：不接受 X-Novel-Agent');
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const tier = asString(body.tier, '');
      if (!INTENT_TIERS.some((t) => t.id === tier)) return sendError(res, 400, `未知意图层级：${tier}（允许：${INTENT_TIERS.map((t) => t.id).join('/')}）`);
      const text = asString(body.text, '');
      if (text.length > 2000) return sendError(res, 400, '单条意图超过 2000 字上限；请在长期方向/阶段重点/本章意图里各自说清，不要粘贴长文');
      const chapterId = Number(body.chapter_id) || 0;
      if (chapterId && !AuthorStyle.chapterOfWork(workId, chapterId)) return sendError(res, 404, '章节不存在或不属于该作品');
      const saved = AuthorStyle.putIntent(workId, chapterId, tier, text, body.hard === true);
      const intents = AuthorStyle.listIntents(workId, chapterId);
      touchWork(workId);
      return sendJSON(res, 200, { ok: true, work_id: workId, chapter_id: chapterId, saved, intents, merged: mergeIntents(intents) });
    }
    if (method === 'DELETE') {
      if (isAgentRequest(req)) return sendError(res, 403, '作者意图是作者侧数据：不接受 X-Novel-Agent');
      const workId = Number(query.work_id) || 0;
      const chapterId = Number(query.chapter_id) || 0;
      if (!workId || !AuthorStyle.workExists(workId)) return sendError(res, 404, '作品不存在');
      const out = AuthorStyle.deleteIntent(workId, chapterId, asString(query.tier, ''));
      if (!out.ok) return sendError(res, 404, '该层级的意图不存在');
      touchWork(workId);
      return sendJSON(res, 200, { ok: true, work_id: workId, chapter_id: chapterId });
    }
  }
  // ── R11：剧情分支沙盘（候选不是本书事实；采纳只形成蓝图与契约建议）────────────────
  // 边界：
  //   · 候选保存在 branch_* 两张新表里：不进上下文层、不进 story_facts / 事件 / 角色知识，
  //     也不触发 OV 同步（"候选进了 DSH 会话历史" ≠ 获准成为书籍记忆事实）。
  //   · 角色行动理由必须受该角色当前可行动知识约束（复用 R10 披露派生视图，无缓存重算）；
  //     作者真相允许用来评估全局后果，但不得变成角色依据；未来计划不得冒充已发生。
  //   · 采纳/丢弃/取消/恢复是作者决定（模型侧 403）：采纳只写章节蓝图 + 契约建议；正文/事实/角色状态不动。
  if (resource === 'novel' && segments[2] === 'branch') {
    const leaf = segments[3];
    // 与 GET /api/novel/state/disclosure 同源：按当前章时点重算披露视图（无缓存）。
    const branchDisclosure = (workId, chapterId, scene) => {
      const row = prepare('SELECT id, work_id, title FROM chapters WHERE id = ?').get(Number(chapterId));
      if (!row || Number(row.work_id) !== Number(workId)) return null;
      const { ordered } = StoryState.chapterIndexMap(workId);
      const chapterRows = prepare('SELECT id, title, content, position FROM chapters WHERE work_id = ? ORDER BY position ASC, id ASC').all(workId);
      const chapters = chapterRows.map((c) => ({
        id: c.id, title: c.title, index: ordered.indexOf(Number(c.id)),
        written: !!htmlToPlain(c.content || '').trim(),
      }));
      const at = chapters.findIndex((c) => Number(c.id) === Number(chapterId));
      const cursor = StoryState.cursorOf({
        chapterIndex: at >= 0 ? at : 0,
        sceneIndex: scene === undefined || scene === null || scene === '' ? null : Number(scene),
        chapterId: Number(chapterId),
      });
      const view = StoryState.deriveDisclosure({
        facts: StoryState.readFacts(workId),
        knowledge: StoryState.readKnowledge(workId),
        chapters,
        characters: prepare('SELECT id, name FROM characters WHERE work_id = ? ORDER BY id ASC').all(workId),
        cursor,
      });
      return { chapter: row, cursor, view };
    };
    const branchDeps = (workId, chapterId, ctx) => {
      const contentRow = prepare('SELECT content FROM chapters WHERE id = ?').get(Number(chapterId));
      const contract = StoryState.readContract(chapterId);
      const intents = AuthorStyle.listIntents(workId, chapterId)
        .map((x) => ({ tier: x.tier, chapter_id: x.chapter_id, text: x.text, hard: x.hard }));
      return BranchSandbox.buildSandboxDeps({
        work_id: workId, chapter_id: chapterId, chapter_index: ctx.cursor.chapter_index,
        state_hash: StoryState.stateHash(workId),
        content_hash: sha16(htmlToPlain((contentRow && contentRow.content) || '')),
        contract_hash: (contract && contract.contract_hash) || '',
        intent_hash: sha16(stableStringify(intents)),
        disclosure_fingerprint: ctx.view.fingerprint,
      });
    };
    const branchWithCurrentStale = (candidate, deps) => {
      const stale = BranchSandbox.isSandboxStale(candidate.deps, deps);
      return { ...BranchSandbox.summarizeCandidate(candidate), stale_now: stale.stale, stale_changed: stale.changed };
    };

    if (leaf === 'sandboxes' && method === 'GET') {
      const workId = Number(query.work_id) || 0;
      if (!workId || !BranchStore.workExists(workId)) return sendError(res, 404, '作品不存在');
      const chapterId = Number(query.chapter_id) || null;
      const sandboxes = BranchStore.listSandboxes(workId, chapterId).map((sb) => ({ ...sb, progress: BranchStore.sandboxProgress(sb) }));
      return sendJSON(res, 200, {
        ok: true, work_id: workId, chapter_id: chapterId, sandboxes,
        limits: BranchSandbox.SANDBOX_LIMITS,
        note: '沙盘运行可取消/恢复：取消后已产出的候选仍可阅读；恢复只继续未完成槽位，不重跑已完成候选。',
      });
    }
    if (leaf === 'sandboxes' && method === 'POST' && !segments[4]) {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId || !BranchStore.workExists(workId)) return sendError(res, 404, '作品不存在');
      const chapterId = Number(body.chapter_id) || 0;
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id（沙盘必须以具体章节为时间点）');
      if (!BranchStore.chapterOfWork(workId, chapterId)) return sendError(res, 404, '章节不存在或不属于该作品');
      const requested = Number(body.requested) || 3;
      if (requested < BranchSandbox.SANDBOX_LIMITS.min_candidates || requested > BranchSandbox.SANDBOX_LIMITS.max_candidates) {
        return sendError(res, 400, `requested 必须在 ${BranchSandbox.SANDBOX_LIMITS.min_candidates}—${BranchSandbox.SANDBOX_LIMITS.max_candidates} 之间（不同候选数）`);
      }
      const ctx = branchDisclosure(workId, chapterId, body.scene);
      const deps = branchDeps(workId, chapterId, ctx);
      const createdBy = isAgentRequest(req) ? 'agent' : 'author';
      const sandbox = BranchStore.createSandbox({ workId, chapterId, requested, deps, note: asString(body.note, ''), createdBy });
      return sendJSON(res, 201, {
        ok: true, sandbox: { ...sandbox, created_by: createdBy }, progress: BranchStore.sandboxProgress(sandbox),
        deps, cursor: ctx.view.cursor,
        boundary: {
          candidates_are_facts: false,
          note: '沙盘候选不进上下文层、不进正典事实/事件/角色知识，也不触发记忆同步；采纳只形成蓝图与契约建议。',
        },
      });
    }
    if (leaf === 'sandboxes' && segments[4] && method === 'POST' && ['cancel', 'reopen'].includes(segments[5])) {
      if (isAgentRequest(req)) return sendError(res, 403, '取消/恢复沙盘是作者决定（不接受 X-Novel-Agent）');
      const sandbox = BranchStore.getSandbox(Number(segments[4]));
      if (!sandbox) return sendError(res, 404, '沙盘不存在');
      if (segments[5] === 'cancel') {
        const updated = sandbox.status === 'cancelled' ? sandbox : BranchStore.setSandboxStatus(sandbox.id, 'cancelled');
        return sendJSON(res, 200, { ok: true, sandbox: { ...updated, progress: BranchStore.sandboxProgress(updated) } });
      }
      // reopen：重启恢复——只继续未完成槽位；已产出的候选原样保留（不重跑）。
      const updated = BranchStore.setSandboxStatus(sandbox.id, 'open');
      return sendJSON(res, 200, { ok: true, sandbox: { ...updated, progress: BranchStore.sandboxProgress(updated) }, resume: true });
    }
    if (leaf === 'sandboxes' && segments[4] && method === 'GET') {
      const sandbox = BranchStore.getSandbox(Number(segments[4]));
      if (!sandbox) return sendError(res, 404, '沙盘不存在');
      const candidates = BranchStore.listCandidates({ workId: sandbox.work_id, sandboxId: sandbox.id, limit: 50 });
      return sendJSON(res, 200, { ok: true, sandbox, progress: BranchStore.sandboxProgress(sandbox), candidates: candidates.map(BranchSandbox.summarizeCandidate) });
    }

    if (leaf === 'candidates' && method === 'GET' && !segments[4]) {
      const workId = Number(query.work_id) || 0;
      if (!workId || !BranchStore.workExists(workId)) return sendError(res, 404, '作品不存在');
      const chapterId = Number(query.chapter_id) || null;
      const status = ['candidate', 'adopted', 'discarded'].includes(asString(query.status, '')) ? asString(query.status, '') : null;
      const candidates = BranchStore.listCandidates({ workId, chapterId, status, sandboxId: Number(query.sandbox_id) || null, limit: Number(query.limit) || 100 });
      let current = null;
      if (chapterId) {
        const ctx = branchDisclosure(workId, chapterId, query.scene);
        if (ctx) current = branchDeps(workId, chapterId, ctx);
      }
      return sendJSON(res, 200, {
        ok: true, work_id: workId, chapter_id: chapterId, status,
        candidates: candidates.map((c) => (current ? branchWithCurrentStale(c, current) : BranchSandbox.summarizeCandidate(c))),
        current_deps: current,
        limits: BranchSandbox.SANDBOX_LIMITS,
        note: 'stale_now 表示保存候选时的依赖基线（状态/正文/契约/作者意图/披露指纹）与现在不一致：旧候选仍可阅读，重新采纳必须先复核或重新生成。',
      });
    }
    if (leaf === 'candidates' && method === 'POST' && !segments[4]) {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId || !BranchStore.workExists(workId)) return sendError(res, 404, '作品不存在');
      const chapterId = Number(body.chapter_id) || 0;
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id（沙盘必须以具体章节为时间点）');
      if (!BranchStore.chapterOfWork(workId, chapterId)) return sendError(res, 404, '章节不存在或不属于该作品');
      const incoming = Array.isArray(body.candidates) ? body.candidates : [];
      if (!incoming.length) return sendError(res, 400, '缺少 candidates（一次提交 2—5 个不同方向）');
      if (incoming.length > BranchSandbox.SANDBOX_LIMITS.max_candidates) {
        return sendError(res, 400, `一次最多提交 ${BranchSandbox.SANDBOX_LIMITS.max_candidates} 个候选，收到 ${incoming.length} 个`);
      }
      const shapes = incoming.map((c, i) => BranchSandbox.validateCandidateShape(c, { index: i }));
      const shapeErrors = [];
      shapes.forEach((s, i) => { for (const e of s.errors) shapeErrors.push(`候选 ${i + 1}：${e}`); });
      if (shapeErrors.length) return sendError(res, 400, shapeErrors.join('；'));
      const normalized = shapes.map((s) => s.candidate);
      const ctx = branchDisclosure(workId, chapterId, body.scene);
      const knowledge = normalized.map((c) => BranchSandbox.validateKnowledgeConstraints(c, ctx.view));
      const kviolations = [];
      knowledge.forEach((k, i) => { for (const v of k.violations) kviolations.push(`候选 ${i + 1}：${v.reason}`); });
      if (kviolations.length) return sendError(res, 422, kviolations.join('；'));
      const currentDeps = branchDeps(workId, chapterId, ctx);
      let sandbox = null;
      if (body.sandbox_id) {
        sandbox = BranchStore.getSandbox(Number(body.sandbox_id));
        if (!sandbox || Number(sandbox.work_id) !== workId) return sendError(res, 404, '沙盘不存在或不属于该作品');
        if (sandbox.chapter_id && Number(sandbox.chapter_id) !== chapterId) return sendError(res, 409, '沙盘属于另一章：不能把候选写进其它章节的沙盘');
        if (sandbox.status === 'cancelled') return sendError(res, 409, '沙盘已取消：不能再往里加候选（可新建一个沙盘）');
        if (sandbox.deps && sandbox.deps.hash && sandbox.deps.hash !== currentDeps.hash) {
          const stale = BranchSandbox.isSandboxStale(sandbox.deps, currentDeps);
          return sendError(res, 409, `沙盘的依赖基线已变化（${stale.changed.join('、')}）：不把新候选混进旧基线；请新建沙盘（旧候选仍可阅读）`);
        }
      }
      // 恢复追加：沙盘里已经有候选时，允许一次只补最后 1 个槽位（否则一次提交 2—5 个不同方向）。
      const existing = sandbox
        ? BranchStore.listCandidates({ workId, sandboxId: sandbox.id, limit: 200 }).filter((c) => c.status !== 'discarded')
        : [];
      const minNeeded = existing.length >= 1 ? 1 : BranchSandbox.SANDBOX_LIMITS.min_candidates;
      if (normalized.length < minNeeded) return sendError(res, 400, `候选数量不足：至少 ${minNeeded} 个（沙盘里已有候选时可只补最后一个槽位）`);
      const distinct = normalized.length >= 2
        ? BranchSandbox.checkDistinctness(normalized)
        : { ok: true, errors: [], report: [], threshold: BranchSandbox.SANDBOX_LIMITS.max_similarity_to_count_as_distinct };
      if (!distinct.ok) return sendError(res, 400, distinct.errors.join('；'));
      if (normalized.length === 1 && existing.length) {
        const against = BranchSandbox.checkDistinctAgainst(normalized[0], existing);
        if (!against.ok) return sendError(res, 400, against.errors.join('；'));
      }
      const createdBy = isAgentRequest(req) ? 'agent' : 'author';
      if (!sandbox) {
        sandbox = BranchStore.createSandbox({ workId, chapterId, requested: incoming.length, deps: currentDeps, note: asString(body.note, ''), createdBy });
      }
      const deps = sandbox.deps && sandbox.deps.hash ? sandbox.deps : currentDeps;
      // 先整批查重（与沙盘已有候选 + 本批互相之间）：不留"写了一半"的候选。
      const universe = [...existing];
      const planned = [];
      for (let i = 0; i < normalized.length; i++) {
        const dup = universe.find((c) => (c.core_key || BranchSandbox.normalizeActionKey(c.core_action)) === normalized[i].core_key);
        if (dup) return sendError(res, 409, `候选 ${i + 1} 与已有候选 #${dup.id} 的核心行动规范化后相同：没有实质差异，仅改写措辞不算多个候选（整批未写入）`);
        planned.push({ ...normalized[i], cursor: ctx.view.cursor, knowledge_status: knowledge[i].status, knowledge_warnings: knowledge[i].warnings });
        universe.push({ id: null, title: normalized[i].title, core_action: normalized[i].core_action, conflict: normalized[i].conflict, core_key: normalized[i].core_key, conflict_key: normalized[i].conflict_key });
      }
      const created = [];
      for (let i = 0; i < planned.length; i++) {
        const pairs = distinct.report.filter((r) => r.a === i || r.b === i);
        created.push(BranchStore.createCandidate({
          workId, sandboxId: sandbox.id, chapterId, ordinal: i + 1,
          candidate: planned[i],
          deps, distinct: { pairs, threshold: distinct.threshold }, createdBy,
        }));
      }
      let progress = BranchStore.sandboxProgress(sandbox);
      if (progress.complete && sandbox.status === 'open') {
        BranchStore.setSandboxStatus(sandbox.id, 'complete');
        progress = BranchStore.sandboxProgress(BranchStore.getSandbox(sandbox.id));
      }
      return sendJSON(res, 201, {
        ok: true, work_id: workId, chapter_id: chapterId,
        sandbox: { ...BranchStore.getSandbox(sandbox.id), progress },
        progress,
        candidates: created.map(BranchSandbox.summarizeCandidate),
        distinctness: distinct.report,
        knowledge: knowledge.map((k, i) => ({ index: i, status: k.status, warnings: k.warnings })),
        deps,
        boundary: { candidates_are_facts: false, wrote_context_layer: false, wrote_story_facts: false, triggered_memory_sync: false },
      });
    }
    if (leaf === 'candidates' && segments[4] && method === 'GET') {
      const candidate = BranchStore.getCandidate(Number(segments[4]));
      if (!candidate) return sendError(res, 404, '候选不存在');
      const ctx = branchDisclosure(candidate.work_id, candidate.chapter_id, query.scene);
      const current = ctx ? branchDeps(candidate.work_id, candidate.chapter_id, ctx) : null;
      const stale = current ? BranchSandbox.isSandboxStale(candidate.deps, current) : { stale: false, changed: [] };
      return sendJSON(res, 200, {
        ok: true, candidate: { ...candidate, stale_now: stale.stale, stale_changed: stale.changed },
        current_deps: current,
        adoption_plan: BranchSandbox.buildAdoptionPlan(candidate, { chapterTitle: (ctx && ctx.chapter.title) || '' }),
        boundary: {
          candidates_are_facts: false,
          note: '候选与采纳计划都不进上下文层与正典；采纳由作者执行，只写章节蓝图与契约建议。',
        },
      });
    }
    if (leaf === 'candidates' && segments[4] && method === 'POST' && segments[5] === 'adopt') {
      if (isAgentRequest(req)) return sendError(res, 403, '采纳剧情候选是作者决定（不接受 X-Novel-Agent）：模型可以提出候选，但不能替作者采纳');
      const candidate = BranchStore.getCandidate(Number(segments[4]));
      if (!candidate) return sendError(res, 404, '候选不存在');
      if (candidate.status === 'discarded') return sendError(res, 409, '候选已被丢弃：不能采纳（可重新生成）');
      const chapter = BranchStore.chapterOfWork(candidate.work_id, candidate.chapter_id);
      if (!chapter) return sendError(res, 404, '候选对应的章节不存在');
      const body = await readBody(req);
      if (candidate.status === 'adopted') return sendJSON(res, 200, { ok: true, candidate_id: candidate.id, already_adopted: true, adopted: candidate.adopted });
      const ctx = branchDisclosure(candidate.work_id, candidate.chapter_id, body.scene);
      const current = branchDeps(candidate.work_id, candidate.chapter_id, ctx);
      const stale = BranchSandbox.isSandboxStale(candidate.deps, current);
      if (stale.stale && body.recheck !== true) {
        return sendError(res, 409, `依赖基线已变化（${stale.changed.join('、')}）：旧候选仍可阅读，但重新采纳必须先复核或重新生成（确认已按新基线复核请传 recheck:true）`);
      }
      const plan = BranchSandbox.buildAdoptionPlan(candidate, { chapterTitle: chapter.title });
      let blueprintWritten = false;
      if (body.blueprint !== false) {
        prepare('UPDATE chapters SET blueprint_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan.blueprint), now(), candidate.chapter_id);
        blueprintWritten = true;
      }
      let contract = null;
      if (body.apply_contract === true) {
        contract = StoryState.saveContract(candidate.work_id, candidate.chapter_id, plan.contract_suggestion, { note: `采纳剧情候选 #${candidate.id}（沙盘）` });
      }
      const adopted = {
        adopted_at: now(), stale_at_adopt: stale.stale, rechecked: body.recheck === true,
        blueprint_written: blueprintWritten,
        contract_written: !!contract,
        contract_suggestion: plan.contract_suggestion,
        never_touched: plan.never_touched,
        disclaimer: plan.disclaimer,
      };
      const updated = BranchStore.updateCandidate(candidate.id, { status: 'adopted', adopted, stale: false });
      touchWork(candidate.work_id);
      return sendJSON(res, 200, {
        ok: true, candidate_id: candidate.id,
        blueprint: plan.blueprint, blueprint_written: blueprintWritten,
        contract: contract ? { version: contract.version, contract_hash: contract.contract_hash } : null,
        contract_suggestion: plan.contract_suggestion,
        disclaimer: plan.disclaimer, never_touched: plan.never_touched,
        stale_check: { ...stale, rechecked: body.recheck === true },
        candidate: updated,
      });
    }
    if (leaf === 'candidates' && segments[4] && method === 'POST' && segments[5] === 'discard') {
      if (isAgentRequest(req)) return sendError(res, 403, '丢弃剧情候选是作者决定（不接受 X-Novel-Agent）');
      const candidate = BranchStore.getCandidate(Number(segments[4]));
      if (!candidate) return sendError(res, 404, '候选不存在');
      const updated = BranchStore.updateCandidate(candidate.id, { status: 'discarded' });
      return sendJSON(res, 200, { ok: true, candidate_id: candidate.id, candidate: BranchSandbox.summarizeCandidate(updated) });
    }
    if (leaf === 'compare' && method === 'POST') {
      const body = await readBody(req);
      const workId = Number(body.work_id) || 0;
      if (!workId) return sendError(res, 400, '缺少 work_id');
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
      if (ids.length < 2) return sendError(res, 400, '比较至少需要 2 个候选 id');
      const rows = ids.map((id) => BranchStore.getCandidate(id));
      if (rows.some((r) => !r) || rows.some((r) => Number(r.work_id) !== workId)) return sendError(res, 404, '候选不存在或不属于该作品');
      const comparisons = [];
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) comparisons.push(BranchSandbox.compareCandidates(rows[i], rows[j]));
      return sendJSON(res, 200, {
        ok: true, work_id: workId,
        candidates: rows.map(BranchSandbox.summarizeCandidate),
        comparisons,
        note: '只并列差异，不替作者打分或排序；未采纳的候选不是本书事实。',
      });
    }
    return sendError(res, 404, '未知的沙盘操作');
  }
  if (resource === 'novel' && segments[2] === 'context' && segments[3] === 'contributions' && method === 'GET') {
    if (asString(query.all, '') === '1') {
      return sendJSON(res, 200, { ok: true, unit: 'char', records: listContributions(Number(query.limit) || 20) });
    }
    const workId = Number(query.work_id) || 0;
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const record = latestContributions({ workId, chapterId: Number(query.chapter_id) || null });
    if (!record) return sendError(res, 404, '还没有这个作品/章节的上下文贡献记录（先装配一次上下文）');
    return sendJSON(res, 200, { ok: true, unit: 'char', record });
  }
  if (resource === 'novel' && segments[2] === 'context' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const chapterId = Number(query.chapter_id) || null;
    const mode = asString(query.mode, 'full');
    // C4：方向参数（可选）。direction 只影响资料召回与索引候选发现；phase 见 ai/direction.mjs。
    const direction = normalizeDirection(query.direction);
    const libraryRecallPhase = normalizeLibraryRecallPhase(query.library_recall_phase);
    const directionSource = normalizeDirectionSource(query.direction_source);
    const requestId = normalizeRequestId(query.request_id);
    // 装配结果缓存：进程内写操作（touchWork）整体作废；记忆库/索引完成由外部版本触发失效。
    // 缓存键含 phase + direction 哈希；无方向且 default 时与旧键逐字节相同（审计兼容）。
    const cacheKey = contextCacheKeyOf({ workId, chapterId, mode, phase: libraryRecallPhase, directionHash: directionHashOf(direction) });
    let ctx = cacheGetContext(cacheKey, workId);
    if (ctx === undefined) {
      ctx = await buildNovelContext(workId, chapterId, mode, { direction, directionSource, libraryRecallPhase, requestId });
      if (ctx) cacheSetContext(cacheKey, ctx, workId);
    }
    if (!ctx) return sendError(res, 404, '作品不存在');
    return sendJSON(res, 200, ctx);
  }
  if (resource === 'novel' && segments[2] === 'semantic' && method === 'GET') {
    const healthy = await ovClient.health();
    return sendJSON(res, 200, {
      ok: true,
      enabled: ovEffectiveEnabled(),
      setting_enabled: semanticEnabled(),
      healthy,
      base: workDir(0).replace(/\/0$/, ''),
      pending: pendingQueueLength(),
      dedup_recall: getAppSetting('ov_recall_dedup', '0') === '1'
    });
  }
  if (resource === 'novel' && segments[2] === 'semantic' && method === 'PUT') {
    const body = await readBody(req);
    const enabled = body.enabled !== false;
    setAppSetting('ov_semantic_enabled', enabled ? '1' : '0');
    // R05：来源感知去重默认关闭（保持旧作品既有行为不变）；只有作者显式打开才影响请求内容。
    if (body.dedup_recall !== undefined) {
      setAppSetting('ov_recall_dedup', body.dedup_recall === true || String(body.dedup_recall) === '1' ? '1' : '0');
    }
    return sendJSON(res, 200, { ok: true, enabled, dedup_recall: getAppSetting('ov_recall_dedup', '0') === '1' });
  }
  // D8-#3：记忆自动压缩开关。默认关闭；打开后章节落盘时超过阈值即自动建压缩作业。
  // 与 novel/semantic 同构（GET 读状态、PUT 改状态），界面可直接接这两个端点。
  if (resource === 'novel' && segments[2] === 'memory_auto_compress' && method === 'GET') {
    let lastJob = null;
    for (const j of harnessJobs.values()) {
      if (j.kind === 'compress' && (!lastJob || (j.created_at || '') > (lastJob.created_at || ''))) lastJob = j;
    }
    return sendJSON(res, 200, {
      ok: true,
      enabled: memoryAutoCompressEnabled(),
      threshold: MEMORY_COMPRESS_HINT,
      // 上次压缩作业的状态：让作者能判断"自动压缩到底跑没跑、成没成"，
      // 而不是只能从日志里翻（护栏拒绝时尤其需要可见）。
      last_job: lastJob ? { id: lastJob.id, status: lastJob.status, error: lastJob.error || null, created_at: lastJob.created_at } : null,
    });
  }
  if (resource === 'novel' && segments[2] === 'memory_auto_compress' && method === 'PUT') {
    const body = await readBody(req);
    const enabled = body.enabled === true || body.enabled === '1';
    setAppSetting(MEMORY_AUTO_COMPRESS_KEY, enabled ? '1' : '0');
    return sendJSON(res, 200, { ok: true, enabled, threshold: MEMORY_COMPRESS_HINT });
  }
  if (resource === 'novel' && segments[2] === 'semantic_index' && method === 'POST') {
    const body = await readBody(req);
    if (!ovEffectiveEnabled()) return sendError(res, 400, '语义集成未启用（请先在上下文页签打开开关）');
    const workId = Number(body.work_id) || null;
    const healthy = await ovClient.health();
    if (!healthy) return sendError(res, 503, 'OpenViking 服务器不可用，无法建索引');
    const targets = workId
      ? [workId]
      : prepare('SELECT id FROM works ORDER BY id ASC').all().map((w) => w.id);
    for (const wid of targets) {
      syncWorkFull(wid).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `重建索引失败（work ${wid}）：${e.message}` }));
    }
    return sendJSON(res, 202, { ok: true, scheduled: targets.length, message: '索引任务已排队（异步向量化，需要一些时间）' });
  }
  // ---------- 🧠 OpenViking 记忆库：界面里填、填完即生效 ----------
  // 与上面的 novel/semantic 同属记忆库集成，读写同一批 app_settings。
  // 纪律：凭证的优先级阶梯**只在 openviking.js 定义一次**，这里的"来源"标签直接取
  // 该链的输出，不另算一套（两套口径必然分叉，然后界面开始说谎）。
  if (resource === 'novel' && segments[2] === 'openviking' && segments[3] === undefined) {
    if (method === 'GET') {
      return sendJSON(res, 200, await openVikingStatusPayload());
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const applied = [];
      // endpoint：字段出现即视为作者的明确意图（空串=清除，回到配置文件/默认值）。
      if (typeof body.endpoint === 'string') {
        const norm = normalizeOvEndpoint(body.endpoint);
        if (!norm.ok) return sendError(res, 400, norm.error);
        setAppSetting(SETTING_OV_ENDPOINT, norm.value);
        applied.push('endpoint');
      }
      // api_key：**空串不等于清除**——表单里留空更可能是"不改动"。
      // 清除必须显式带 clear_api_key:true（界面上是一个独立按钮）。
      // 这类"空值语义"含混过一次就会静默清掉作者的 Key，所以把契约写死在这里与界面两边。
      if (typeof body.api_key === 'string' && body.api_key.trim()) {
        setAppSetting(SETTING_OV_API_KEY, body.api_key.trim());
        applied.push('api_key');
      } else if (body.clear_api_key === true) {
        setAppSetting(SETTING_OV_API_KEY, '');
        applied.push('clear_api_key');
      }
      const appliedNow = applyWorkshopToolSettings();
      log({
        level: 'info', layer: 'openviking', kind: 'ov_config_saved',
        message: `OpenViking 设置已更新（${applied.join('、') || '无字段变更'}）`,
        context: { applied, endpoint_source: appliedNow.endpoint_source }
      });
      const payload = await openVikingStatusPayload();
      return sendJSON(res, 200, { ...payload, applied });
    }
    return sendError(res, 405, 'Method not allowed');
  }
  // 一键把当前生效凭证写进 ~/.openviking/ovcli.conf，让 dsh 侧（GUI 会话 / 写作任务）共用同一套。
  if (resource === 'novel' && segments[2] === 'openviking' && segments[3] === 'global_config' && method === 'POST') {
    const cfg = resolveOpenVikingConfig();
    if (!cfg.endpoint && !cfg.apiKey) return sendError(res, 400, '当前没有可写入的 OpenViking 地址或 Key');
    const out = writeGlobalOpenVikingConfig({ endpoint: cfg.endpoint, apiKey: cfg.apiKey });
    if (!out.ok) return sendError(res, 500, out.error || '写入全局配置失败');
    log({
      level: out.changed.length ? 'info' : 'warn', layer: 'openviking', kind: 'ov_global_config',
      message: `全局 ovcli.conf ${out.changed.length ? '已更新：' + out.changed.join('、') : '无需改动'}`,
      context: { path: out.path, backup: out.backup }
    });
    return sendJSON(res, 200, {
      ...out,
      // 如实说明这一步影响谁：工坊自己的连接顺序里"工坊内设置"优先于该文件，
      // 所以写它不会改变工坊当前状态，改的是 dsh 侧读到的凭证。
      note: '工坊自己的连接不受影响（工坊内设置优先于该文件）；这一步是给 dsh 侧（GUI 会话 / 写作任务）用的。'
    });
  }

  // ---------- 🛠 环境自检：AI 设置页「工具与环境清单」卡的数据源 ----------
  // 每一项都必须**真去磁盘/网络看**，不能凭"文档里写了"就当装好了。
  if (resource === 'env' && segments[2] === 'tools' && method === 'GET') {
    const dsh = harnessRuntimeInfo();
    const ov = openVikingConfigInfo();
    const plugin = detectPluginInstall(dsh);
    return sendJSON(res, 200, {
      ok: true,
      node: {
        version: process.version,
        // 能力探测优于版本比较：服务此刻能跑起来，本身就证明 node:sqlite 可用。
        sqlite_ok: true,
        note: '服务已成功启动 ⇒ 当前 Node 的 node:sqlite 可用（本项目实际门槛 22.13+）'
      },
      server: { port: Number(PORT), pid: process.pid, data_dir: DATA_DIR, log_dir: path.join(DATA_DIR, 'logs') },
      dsh: {
        dir: dsh.dir, source: dsh.source, found: dsh.found, built: dsh.built,
        // "找到了 package.json" 与 "这确实是 dsh 仓库" 分开报：界面据此提示作者别填错目录。
        looks_like_dsh: dsh.looks_like_dsh,
        checked: dsh.checked, override: dsh.override,
        profile: dsh.profile, settings_file: dsh.settings_file, task_home: dsh.task_home,
        plugin
      },
      openviking: {
        endpoint: ov.endpoint, endpoint_source: ov.endpoint_source, endpoint_source_label: ov.endpoint_source_label,
        api_key_source: ov.api_key_source, api_key_source_label: ov.api_key_source_label, has_api_key: ov.has_api_key,
        config_paths: ov.config_paths,
        setting_enabled: semanticEnabled(), effective_enabled: ovEffectiveEnabled(),
        pending: pendingQueueLength()
      }
    });
  }
  // 打开本机目录（参数是枚举键，不是路径）。dry_run=true 只回显将要打开的目录，不真的打开——
  // 自动化测试用它覆盖成功路径，而不必在验证时弹出资源管理器窗口。
  if (resource === 'env' && segments[2] === 'open_folder' && method === 'POST') {
    const parsed = await readBodyOrError(req, res);
    if (!parsed.ok) return;
    const body = parsed.body;
    const key = String(body.target || '');
    const targets = openFolderTargets();
    if (!Object.prototype.hasOwnProperty.call(targets, key)) {
      return sendError(res, 400, `未知的目录标识：${key || '(空)'}（可选：${Object.keys(targets).join(' / ')}）`);
    }
    const item = targets[key];
    if (!item.dir || !fs.existsSync(item.dir)) return sendError(res, 404, `目录不存在：${item.dir}`);
    if (body.dry_run === true) return sendJSON(res, 200, { ok: true, target: key, label: item.label, dir: item.dir, opened: false, dry_run: true });
    const out = await openFolderInFileManager(item.dir);
    if (!out.ok) return sendError(res, 500, `调用 ${out.cmd} 失败：${out.error || '未知错误'}`);
    return sendJSON(res, 200, { ok: true, target: key, label: item.label, dir: item.dir, opened: true });
  }
  // 填 dsh 仓库路径（AI 设置页「本地创作内核」卡）。与 OpenViking 卡同构：存设置 → 立即注入 → 复检。
  if (resource === 'env' && segments[2] === 'dsh_repo' && method === 'PUT') {
    const parsed = await readBodyOrError(req, res);
    if (!parsed.ok) return;
    const body = parsed.body;
    if (typeof body.dir !== 'string') return sendError(res, 400, '缺少 dir 字段');
    const dir = body.dir.trim();
    // 填了就必须真的像个 dsh 仓库：只校验 package.json 会把误填（例如填成工坊自己）放进去，
    // 之后每个任务都失败在"未找到 dsh 启动方式"，而界面显示"已保存"。
    if (dir && !looksLikeDshRepo(dir)) {
      return sendError(res, 400, `这个目录不像 dsh 仓库：${dir}（需要 package.json，并且有 apps/cli 或 packages/ 或 package.json 的 scripts.dsh）`);
    }
    setAppSetting(SETTING_DSH_REPO, dir);
    setHarnessRepoOverride(dir);
    const info = harnessRuntimeInfo();
    log({
      level: 'info', layer: 'harness', kind: 'dsh_repo_saved',
      message: `dsh 仓库路径已更新：${dir || '(清空，回到自动探测)'}`,
      context: { dir, source: info.source, found: info.found, looks_like_dsh: info.looks_like_dsh }
    });
    return sendJSON(res, 200, { ok: true, applied: dir, dsh: { dir: info.dir, source: info.source, found: info.found, looks_like_dsh: info.looks_like_dsh, built: info.built, checked: info.checked } });
  }
  if (resource === 'novel' && segments[2] === 'redlines' && method === 'GET') {
    const workId = Number(query.work_id) || null;
    // 正向风格契约（style_positive）与红线同属“写作风格红线”这一层：装配侧本来就是
    // `renderStyleContract(redlines, work.style_positive)`（见 buildAIContext 的 style_contract）。
    // 但本端点此前只回红线，于是 novel_style_contract 工具查回的契约比上下文里那份少一半
    // （节奏比例/系统出场次数/爽点控制都在 style_positive 里），ai/context/layers.mjs 因此
    // 记了一条风格层缺口。这里补齐：查回路径与装配路径同源。
    const stylePositive = workId
      ? asString(prepare('SELECT style_positive FROM works WHERE id = ?').get(workId)?.style_positive, '')
      : '';
    return sendJSON(res, 200, { work_id: workId, redlines: listRedlines(workId), style_positive: stylePositive });
  }
  if (resource === 'novel' && segments[2] === 'redlines' && method === 'PUT') {
    const body = await readBody(req);
    const workId = Number(body.work_id) || null;
    try {
      const redlines = replaceRedlines(workId, body.entries || []);
      touchWork(workId); // 全局红线（workId 为空）同样影响所有作品的上下文缓存，需整体失效
      return sendJSON(res, 200, { ok: true, work_id: workId, redlines });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }
  if (resource === 'novel' && segments[2] === 'scan' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id) || null;
    const hits = scanAgainstRedlines(listRedlines(workId), asString(body.text, ''), { skip_dialogue: body.skip_dialogue === true });
    return sendJSON(res, 200, { ok: true, work_id: workId, total: hits.reduce((s, h) => s + h.count, 0), hits });
  }
  // ── 确定性连续性预检（2026-09-22 报告 · 第 1 步）────────────────────────────
  // 零 token、只读：把角色卡时点 / 系统出场频率 / 篇幅口径 / 剧情线推进这四件事直接算出来。
  // 为什么放在审稿旁边：审稿是**付费且慢**的一步，机器能判定的先判掉，
  // 剩下的判断再交给 AI（findings 会作为审稿的起始上下文，见 public/app.js 的 buildContinuityGuardText）。
  if (resource === 'novel' && segments[2] === 'continuity_guard' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const chapterId = Number(body.chapter_id) || null;
    // text 省略/为空 → 用库里这一章的正文（成文弹窗传草稿，审稿传待审正文）
    const text = body.text === undefined || body.text === null ? null : String(body.text);
    const exemptions = getContinuityExemptions(workId);
    const computed = computeContinuityGuard(CONTINUITY_GUARD_DEPS, {
      workId, chapterId, text,
      thresholds: getContinuityThresholds(workId),
      exemptions: Object.keys(exemptions),
    });
    if (!computed.ok) return sendError(res, 404, computed.reason || '无法装配预检输入');
    // key 由服务端算好随 finding 下发：键的定义只在 ai/continuity-guard.mjs 一处，
    // 前端不重复实现（本仓库的老教训：同一判据两处实现必然漂移）。
    return sendJSON(res, 200, {
      ok: true, work_id: workId, chapter_id: chapterId,
      findings: computed.result.findings.map((f) => ({ ...f, key: findingKey(f) })),
      exempted: computed.result.exempted.map((f) => ({ ...f, key: findingKey(f) })),
      summary: computed.result.summary,
      checked: computed.result.checked,
    });
  }
  // 豁免：把某条 finding 记成「这是故意的」，以后不再报。
  // ⚠️ 键 = category:entity_id，**不含措辞、不含章节**（照 Novel-OS 的 Finding.key）：
  //    检查改进措辞、或同一矛盾换个章节再出现时，作者做过的判定不会悄悄复活。
  if (resource === 'novel' && segments[2] === 'continuity_exemption' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const key = asString(body.key, '').slice(0, 120).trim();
    if (!key) return sendError(res, 400, '缺少 key');
    const map = getContinuityExemptions(workId);
    if (body.action === 'restore') delete map[key];
    else map[key] = { reason: asString(body.reason, '').slice(0, 200), at: now() };
    setContinuityExemptions(workId, map);
    return sendJSON(res, 200, { ok: true, work_id: workId, action: body.action === 'restore' ? 'restore' : 'exempt', key, keys: Object.keys(map) });
  }
  if (resource === 'novel' && segments[2] === 'events' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, { work_id: workId, events: listStoryEvents(workId, Number(query.limit) || 40) });
  }
  if (resource === 'novel' && segments[2] === 'events' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    // 写事件前校验作品存在，避免外键违约冒泡为 500（非法输入应返回 4xx）。
    const work = prepare('SELECT id FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    const fields = {
      chapterId: Number(body.chapter_id) || null,
      kind: asString(body.kind, 'event'),
      summary: asString(body.summary, ''),
      payload: body.payload || {},
      foreshadowStatus: asString(body.foreshadow_status, ''),
      resolvesEventId: Number(body.resolves_event_id) || null,
      dedupKey: asString(body.dedup_key, '')
    };
    if (!fields.summary.trim()) return sendError(res, 400, '缺少 summary');
    if (fields.chapterId) {
      const ch = prepare('SELECT id, work_id FROM chapters WHERE id = ?').get(fields.chapterId);
      if (!ch) return sendError(res, 400, '章节不存在');
      if (Number(ch.work_id) !== workId) return sendError(res, 400, '章节不属于该作品');
    }
    // headless 生成任务（NOVELSTUDIO_PROPOSE_MODE=1）先落提案，作者在工坊界面确认后入账。
    if (body.proposed === true) {
      const result = addEventProposal(workId, { ...fields, note: asString(body.note, 'dsh 创作插件提案') });
      return sendJSON(res, 201, { ok: true, ...result, work_id: workId });
    }
    const result = addStoryEvent(workId, fields);
    notifyChange('events', { workId, id: workId });
    return sendJSON(res, 201, { ok: true, id: result.id, duplicate: result.duplicate, work_id: workId });
  }
  if (resource === 'novel' && segments[2] === 'foreshadows' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const status = asString(query.status, 'open');
    const all = listStoryEvents(workId, 500).filter((e) => e.kind === 'foreshadow');
    const rows = status === 'all' ? all : all.filter((e) => e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped');
    return sendJSON(res, 200, { ok: true, work_id: workId, status, foreshadows: rows });
  }
  if (resource === 'novel' && segments[2] === 'foreshadows' && segments[3] && segments[4] === 'status' && method === 'POST') {
    const body = await readBody(req);
    const id = Number(segments[3]);
    const status = asString(body.status, '');
    if (!['open', 'resolved', 'dropped'].includes(status)) return sendError(res, 400, 'status 必须是 open/resolved/dropped');
    const row = prepare('SELECT * FROM story_events WHERE id = ? AND kind = ?').get(id, 'foreshadow');
    if (!row) return sendError(res, 404, '伏笔不存在');
    prepare('UPDATE story_events SET foreshadow_status = ? WHERE id = ?').run(status, id);
    if (status === 'resolved' && body.resolves_event_id) {
      const rid = Number(body.resolves_event_id);
      const target = prepare('SELECT id FROM story_events WHERE id = ? AND work_id = ?').get(rid, row.work_id);
      if (!target) return sendError(res, 404, '回收事件不存在或不属于该作品');
      prepare('UPDATE story_events SET resolves_event_id = ? WHERE id = ?').run(rid, id);
    }
    touchWork(row.work_id);
    notifyChange('events', { workId: row.work_id, id: row.work_id });
    return sendJSON(res, 200, { ok: true, id, foreshadow_status: status });
  }
  if (resource === 'novel' && segments[2] === 'proposals' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    return sendJSON(res, 200, { ok: true, work_id: workId, proposals: listProposals(workId) });
  }
  if (resource === 'novel' && segments[2] === 'proposals' && method === 'POST' && (segments[3] === 'apply' || segments[3] === 'reject')) {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    // R02.2：模型侧应用旧提案（事件/长期记忆）同样需要作者的一次性审批，且一次一条。
    let agentConsume = null;
    if (isAgentRequest(req) && segments[3] === 'apply') {
      if (body.all === true) return sendError(res, 403, '模型侧不允许 all=true 批量应用（请作者在界面确认）');
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => n > 0) : (Number(body.id) > 0 ? [Number(body.id)] : []);
      if (ids.length !== 1) return sendError(res, 403, '模型侧一次只能应用一条提案（请作者逐条授权）');
      const row = prepare(`SELECT *, 'event' AS source_table FROM story_event_proposals WHERE id = ? AND work_id = ?`).get(ids[0], workId)
        || prepare(`SELECT *, 'memory' AS source_table FROM story_memory_proposals WHERE id = ? AND work_id = ?`).get(ids[0], workId);
      if (!row) return sendError(res, 404, `提案 #${ids[0]} 不存在或不属于该作品`);
      const guard = guardAgentWrite(req, {
        op: 'proposal_apply', workId, chapterId: row.chapter_id || null,
        baselineHash: Approvals.legacyProposalsBaselineHash([row]),
        binding: { proposals: [ids[0]], hashes: { [String(ids[0])]: Approvals.legacyProposalHash(row) } },
        approvalId: body.approval_id, consume: false,
      });
      if (!guard.ok) return sendError(res, guard.status, guard.message);
      agentConsume = () => {
        const fresh = prepare(`SELECT *, 'event' AS source_table FROM story_event_proposals WHERE id = ? AND work_id = ?`).get(ids[0], workId)
          || prepare(`SELECT *, 'memory' AS source_table FROM story_memory_proposals WHERE id = ? AND work_id = ?`).get(ids[0], workId);
        const verdict = Approvals.consumeApproval(guard.approval.id, {
          op: 'proposal_apply', workId, chapterId: row.chapter_id || null,
          baselineHash: Approvals.legacyProposalsBaselineHash([fresh || row]),
          binding: { proposals: [ids[0]], hashes: { [String(ids[0])]: Approvals.legacyProposalHash(fresh || row) } },
          by: 'agent',
        });
        if (!verdict.ok) throw new Error(`审批消费失败（${verdict.code}）：${verdict.reason}`);
      };
    }
    let result;
    try {
      // 单条 id 与 ids 都接受：旧路由只读 body.ids，于是带 `id` 的调用被静默当成"没有要处理的提案"，
      // 返回 200 + applied:0 —— 属于任务书禁止的"悄悄跳过还提示成功"（本轮隔离探针实测）。
      result = settleProposals(workId, {
        ids: Array.isArray(body.ids) ? body.ids : (Number(body.id) > 0 ? [Number(body.id)] : undefined),
        all: body.all === true, action: segments[3], onConsumeApproval: agentConsume,
      });
    } catch (e) {
      return sendError(res, 403, `批量应用已回滚：${e.message}`);
    }
    if (segments[3] === 'apply' && result?.applied && (result.applied.events > 0 || result.applied.memories > 0)) {
      notifyChange('events', { workId, id: workId });
      notifyChange('story_memory', { workId, id: workId });
    }
    return sendJSON(res, 200, result);
  }
  if (resource === 'novel' && segments[2] === 'consistency' && method === 'POST') {
    const body = await readBody(req);
    const workId = Number(body.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const work = prepare('SELECT * FROM works WHERE id = ?').get(workId);
    if (!work) return sendError(res, 404, '作品不存在');
    const text = asString(body.text, '');
    // 确定性装配核对清单：AI 逐项对照 text 判断，报告冲突即可。
    const allEvents = listStoryEvents(workId, 500);
    const openForeshadows = allEvents
      .filter((e) => e.kind === 'foreshadow' && e.foreshadow_status !== 'resolved' && e.foreshadow_status !== 'dropped')
      .map((e) => ({ id: e.id, summary: e.summary, chapter_id: e.chapter_id }));
    const recentEvents = allEvents.slice(0, 30).map((e) => ({ id: e.id, kind: e.kind, summary: e.summary, foreshadow_status: e.foreshadow_status }));
    // 出场角色按名字/别名整词命中；每个角色附上与它相关的最近事件，
    // 供 AI 判断“角色卡当前状态是否已被最近事件改变”（状态过时检测的依据）。
    const allCharRows = prepare('SELECT * FROM characters WHERE work_id = ?').all(workId);
    const presentCharacters = allCharRows
      .filter((c) => c.name && namesOfCharacter(c).some((nm) => countNameHits(nm, text) > 0))
      .map((c) => ({
        id: c.id, name: c.name, identity: c.identity, status: c.status,
        related_events: recentEvents.filter((e) => namesOfCharacter(c).some((nm) => countNameHits(nm, e.summary) > 0)).slice(0, 5)
      }));
    const scan = scanAgainstRedlines(listRedlines(workId), text);
    const memory = getStoryMemory(workId);
    // 2026-09-21：新增两项，供 novel_consistency 做“本章边界 / 系统人格 / 未登记命名实体”自检。
    // registered_names 让模型能自己发现“我造了个设定库里没有的名字”，比事后靠人去抓早一步——
    // 第 5 章实测：工坊 AI 新造了郑涛（C级·铁骨）、裂背獴、裂缝事件统计，设定库里一个都没有。
    const registeredNames = {
      characters: prepare('SELECT name FROM characters WHERE work_id = ?').all(workId).map((c) => c.name).filter(Boolean),
      world_entries: prepare('SELECT title FROM world_entries WHERE work_id = ?').all(workId).map((w) => w.title).filter(Boolean),
      terms: prepare('SELECT title FROM terms WHERE work_id = ?').all(workId).map((t) => t.title).filter(Boolean),
    };
    return sendJSON(res, 200, {
      ok: true, work_id: workId,
      checklist: {
        open_foreshadows: openForeshadows,
        present_characters: presentCharacters,
        recent_events: recentEvents,
        story_memory: memory,
        style_positive: asString(work?.style_positive, ''),
        registered_names: registeredNames,
        style_scan: { total: scan.reduce((s, h) => s + h.count, 0), hits: scan.slice(0, 20) }
      }
    });
  }
  // 章节蓝图保存（写作前规划 → 落库 → 随上下文带入 → 一致性核对锚点）。
  if (resource === 'novel' && segments[2] === 'chapter_blueprint' && method === 'PUT') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const raw = body.blueprint && typeof body.blueprint === 'object' ? body.blueprint : {};
    const BLUEPRINT_KEYS = ['scene_goal', 'plot_points', 'conflicts', 'character_changes', 'hook', 'references'];
    const blueprint = {};
    for (const key of BLUEPRINT_KEYS) {
      blueprint[key] = asString(raw[key], '').slice(0, 2000);
    }
    if (!Object.values(blueprint).some((v) => v)) return sendError(res, 400, '蓝图内容不能为空');
    const targetWords = Number(body.target_words) || 0;
    prepare('UPDATE chapters SET blueprint_json = ?, target_words = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(blueprint), targetWords > 0 ? Math.min(Math.max(1, Math.floor(targetWords)), 20000) : 0, now(), chapterId);
    touchWork(chapter.work_id);
    const work = prepare('SELECT default_chapter_words FROM works WHERE id = ?').get(chapter.work_id);
    const effective = targetWords > 0 ? targetWords : (Number(work?.default_chapter_words) || 2000);
    return sendJSON(res, 200, { ok: true, chapter_id: chapterId, blueprint, target_words: effective });
  }
  // 章节审稿：保存报告 / 读取最新 / 提交确认清单
  if (resource === 'novel' && segments[2] === 'review' && method === 'PUT' && !segments[3]) {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const report = body.report && typeof body.report === 'object' ? body.report : {};
    const rawText = asString(body.raw_text, '');
    // 有原文兜底时不再拒绝：报告解析失败也必须留下可回看的证据。
    if (!asString(report.summary, '').trim() && !asArray(report.issues).length && !rawText.trim()) {
      return sendError(res, 400, '审稿报告不能为空');
    }
    const reviewId = saveReview(chapter.work_id, chapterId, report, {
      rawText,
      status: body.status === 'raw' || (!asString(report.summary, '').trim() && !asArray(report.issues).length) ? 'raw' : 'parsed'
    });
    return sendJSON(res, 201, { ok: true, review_id: reviewId, status: rawText && !asString(report.summary, '').trim() ? 'raw' : 'parsed' });
  }
  if (resource === 'novel' && segments[2] === 'review' && method === 'GET') {    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    const review = getLatestReview(chapterId);
    if (!review) return sendJSON(res, 200, { ok: true, review: null });
    const report = review.report || {};
    // 让界面不必自己判断可信度：解析成功与否、能否直接走「按清单修稿」。
    return sendJSON(res, 200, {
      ok: true,
      review: {
        ...review,
        parsed: !!(asString(report.summary, '').trim() || asArray(report.issues).length),
        issue_count: asArray(report.issues).length,
        strength_count: asArray(report.strengths).length,
        // 原文可能高达 200KB，回看列表不需要全量——只带预览，完整原文仍在库里可查。
        raw_text: asString(report.raw_text, '').slice(0, 20000),
      }
    });
  }

  // 长任务产出回填：刷新页面或重启服务后，前端拿回输出再交给这里解析落地，
  // 保证「任务跑完了」和「结果存下来了」不依赖页面是否还开着。
  if (resource === 'novel' && segments[2] === 'finalize' && method === 'POST') {
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const chapterId = Number(body.chapter_id) || null;
    const output = asString(body.output, '');
    const jobId = String(body.job_id || '');
    if (!kind) return sendError(res, 400, '缺少 kind');
    if (!output.trim()) return sendError(res, 400, '缺少 output');
    if (kind === 'review') {
      if (!chapterId) return sendError(res, 400, '审稿回填缺少 chapter_id');
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (!chapter) return sendError(res, 404, '章节不存在');
      const parsed = parseReviewText(output);
      const report = parsed || { summary: '', issues: [], strengths: [] };
      const reviewId = saveReview(chapter.work_id, chapterId, report, {
        rawText: parsed ? '' : output.slice(0, 200000),
        status: parsed ? 'parsed' : 'raw'
      });
      if (jobId) markHarnessJobApplied(jobId);
      return sendJSON(res, 201, { ok: true, review_id: reviewId, parsed: !!parsed, issue_count: parsed ? parsed.issues.length : 0 });
    }
    // 成文类产出：落成章节草稿，由界面「取回生成稿」应用，绝不自动覆盖正文。
    if (!chapterId) return sendError(res, 400, '成文回填缺少 chapter_id');
    const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    if (!chapter) return sendError(res, 404, '章节不存在');
    const version = saveChapterVersion(chapterId, chapter.title, '', output, 'draft');
    if (jobId) markHarnessJobApplied(jobId);
    return sendJSON(res, 201, { ok: true, kind, draft_id: Number(version.id), chars: plainText(output).length });
  }

  // 生成稿草稿：AI 成文结果在结果弹窗出现时即落库，关闭弹窗不再等于丢失。
  if (resource === 'novel' && segments[2] === 'draft' && method === 'POST') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const content = asString(body.content, '');
    if (!plainText(content).trim()) return sendError(res, 400, '草稿内容为空');
    const version = saveChapterVersion(chapterId, chapter.title, '', content, 'draft');
    return sendJSON(res, 201, { ok: true, draft_id: Number(version.id), chars: plainText(content).length });
  }
  if (resource === 'novel' && segments[2] === 'draft' && method === 'GET') {
    const chapterId = Number(query.chapter_id);
    if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
    return sendJSON(res, 200, { ok: true, draft: getLatestDraft(chapterId) });
  }
  if (resource === 'novel' && segments[2] === 'review' && segments[3] === 'checklist' && method === 'PUT') {
    const body = await readBody(req);
    const reviewId = Number(body.review_id);
    if (!reviewId) return sendError(res, 400, '缺少 review_id');
    const id = setReviewChecklist(reviewId, body.checklist || {});
    if (id === null) return sendError(res, 404, '审稿不存在');
    return sendJSON(res, 200, { ok: true, review_id: id });
  }
  // 批量生成辅助：列出尚无正文的顶层章节（按顺序）
  if (resource === 'novel' && segments[2] === 'empty_chapters' && method === 'GET') {
    const workId = Number(query.work_id);
    if (!workId) return sendError(res, 400, '缺少 work_id');
    const rows = prepare(`
      SELECT id, title, summary, position FROM chapters
      WHERE work_id = ? AND (content IS NULL OR content = '') AND parent_id IS NULL
      ORDER BY position ASC, id ASC
    `).all(workId);
    return sendJSON(res, 200, { ok: true, work_id: workId, chapters: rows });
  }
  if (resource === 'novel' && segments[2] === 'chapter_save' && method === 'POST') {
    const body = await readBody(req);
    const chapterId = Number(body.chapter_id);
    const chapter = chapterId ? prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId) : null;
    if (!chapter) return sendError(res, 404, '章节不存在');
    if (Number(body.work_id) && Number(body.work_id) !== chapter.work_id) return sendError(res, 400, '章节不属于该作品');
    const content = asString(body.content, '');
    if (!content.trim()) return sendError(res, 400, '缺少 content');
    // R02.2：模型侧写入（X-Novel-Agent）必须引用作者创建的、绑定到**该章当前正文基线**的
    // 一次性审批；作者界面（同源浏览器）不带该标记，语义与之前完全一致。
    const guard = guardAgentWrite(req, {
      op: 'chapter_save', workId: chapter.work_id, chapterId,
      baselineHash: Approvals.chapterBaselineHash(chapter.content),
      binding: { chapter_id: chapterId }, approvalId: body.approval_id,
      consume: false, // 真正的消费放进写入事务（见下）
    });
    if (!guard.ok) return sendError(res, guard.status, guard.message);
    const title = body.title !== undefined ? asString(body.title, chapter.title) : chapter.title;
    const summary = body.summary !== undefined ? asString(body.summary, chapter.summary) : chapter.summary;
    // 旧稿先入历史版本（可恢复），再覆盖正文；消费审批与两次写入同一事务、失败整体回滚。
    let version;
    try {
      version = withTx(() => {
        if (guard.approval) {
          const verdict = Approvals.consumeApproval(guard.approval.id, {
            op: 'chapter_save', workId: chapter.work_id, chapterId,
            baselineHash: Approvals.chapterBaselineHash(chapter.content),
            binding: { chapter_id: chapterId }, by: 'agent',
          });
          if (!verdict.ok) throw new Error(`审批消费失败（${verdict.code}）：${verdict.reason}`);
        }
        const v = saveChapterVersion(chapterId, chapter.title, chapter.summary, chapter.content);
        prepare('UPDATE chapters SET title = ?, summary = ?, content = ?, updated_at = ? WHERE id = ?')
          .run(title, summary, content, now(), chapterId);
        return v;
      });
    } catch (e) {
      return sendError(res, 403, `写入已回滚：${e.message}`);
    }
    touchWork(chapter.work_id);
    notifyChange('chapters', { workId: chapter.work_id, id: chapterId });
    // D8（2026-09-18 收口）：这条路（审稿合并 / 批量生成写回 / 草稿取回）同样在写正文，
    // 此前**不触发**记忆自动压缩，只有 PUT /api/chapters/:id 触发 —— 与 3194 附近注释
    // 「章节正文落盘时检查长期记忆长度」的口径不符。压缩本身默认关闭，这里是空操作。
    maybeAutoCompressMemory(chapter.work_id);
    const hits = scanAgainstRedlines(listRedlines(chapter.work_id), plainText(content));
    return sendJSON(res, 200, {
      ok: true, chapter_id: chapterId, version_id: Number(version.id),
      scan: { total: hits.reduce((s, h) => s + h.count, 0), hits: hits.slice(0, 20) }
    });
  }

  // DeepSeek Harness 桥接
  if (resource === 'harness' && method === 'GET' && segments[2] === 'status') {
    return sendJSON(res, 200, {
      ok: true,
      available: isHarnessAvailable(),
      built: isHarnessBuilt(),
      // 决策 D4：模型切换互斥的当前负载。服务端允许 2 个作业，但请求了模型/强度的任务会串行，
      // 这里把真实排队情况暴露出来，而不是让调用方从"运行中"猜。
      model_load: modelSwitchLoad(),
      concurrency: HARNESS_CONCURRENCY
    });
  }

  // D1：AI 任务进度。POST /harness/run 立即返回 job_id，任务在后台执行；
  // 前端通过 GET /harness/job?id= 轮询状态（阶段/耗时/最近输出），解决「界面静止 10 分钟」的问题。

  // D8-#4：**服务端命名任务**的作业入口（把两条"同步旁路"并进作业设施）。
  //
  // 与 /harness/run 的分工：run 跑的是**自由提示词**（产出是正文，走 job.output）；
  // 这里跑的是**服务端已命名的任务**（生成小说 / 记忆压缩），产出是结构化对象，走 job.result。
  //
  // 此前这两条在 HTTP 请求里同步跑完（只占并发槽位）：没有作业记录 → 界面没有进度、
  // 不能取消、刷新页面就丢、也不进「可恢复任务」列表。现在它们与其它任务同构。
  if (resource === 'harness' && method === 'POST' && segments[2] === 'job') {
    const body = await readBody(req);
    const kind = String(body.kind || '').trim();
    if (harnessLoad() >= HARNESS_CONCURRENCY) return sendError(res, 429, `已有任务运行中，请稍后再试（并发上限 ${HARNESS_CONCURRENCY}）`);
    const timeout = Math.min(Math.max(1000, Math.floor(Number(body.timeout) || LONG_AI_TIMEOUT_MS)), 60 * 60 * 1000);
    // 思考强度：与 /harness/run 同一套校验与透传。
    // ⚠️ 2026-09-18 重审抓到的缺陷：本入口**没有读 body.reasoning_effort**，而前端
    //    「AI 自动创建小说」是按质量档发 `reasoning_effort:'high'` 的（policyEffortForTier('quality')）——
    //    字段到了这里被静默丢掉，于是"质量优先"退化成"和快档一模一样"。
    //    模型档位合并成同一个名字之后，强度就是质量档**唯一**的补偿信号，丢它等于没有质量档。
    const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort);
    if (body.reasoning_effort && !reasoningEffort) {
      return sendError(res, 400, `非法思考强度：仅允许 ${[...DEEPSEEK_REASONING_EFFORTS].join(' / ')}`);
    }

    // 每种命名任务只声明"怎么跑"和"跑完长什么样"，作业设施本身不动。
    const NAMED_TASKS = {
      'generate_novel': {
        label: 'AI 自动创建小说',
        workId: null,
        runner: ({ onChunk, signal }) => generateNovelFromHarness(String(body.prompt || '').trim(), body.model || undefined, onChunk, signal, reasoningEffort || undefined),
      },
      'compress': {
        label: '压缩长期记忆',
        workId: Number(body.work_id) || null,
        runner: ({ onChunk, signal }) => compressStoryMemory(Number(body.work_id), onChunk, signal).then((summary) => ({ summary })),
      },
    };
    const spec = NAMED_TASKS[kind];
    if (!spec) return sendError(res, 400, `未知的命名任务：${kind || '(空)'}（可选：${Object.keys(NAMED_TASKS).join(' / ')}）`);
    if (kind === 'generate_novel' && !String(body.prompt || '').trim()) return sendError(res, 400, '缺少 prompt');
    if (kind === 'compress' && !spec.workId) return sendError(res, 400, '缺少 work_id');

    const job = createHarnessJob('', {
      timeout,
      model: body.model || undefined,
      reasoningEffort: reasoningEffort || undefined,
      action: kind,
      kind,
      stage: spec.label,
      workId: spec.workId,
      runner: spec.runner,
    });
    return sendJSON(res, 202, { ok: true, job_id: job.id, status: job.status, kind: job.kind, stage: job.stage });
  }

  if (resource === 'harness' && method === 'POST' && segments[2] === 'run') {
    const body = await readBody(req);
    if (!body.prompt || !String(body.prompt).trim()) return sendError(res, 400, '缺少 prompt');
    const env = {
      NOVELSTUDIO_BASE_URL: `http://127.0.0.1:${PORT}`,
      // 提案模式：headless 生成任务里 AI 的事件/记忆入账先落提案，
      // 由作者在工坊界面确认后写入，避免 AI 自作主张污染真实账本。
      NOVELSTUDIO_PROPOSE_MODE: '1'
    };
    if (body.work_id) env.NOVELSTUDIO_WORK_ID = String(body.work_id);
    if (body.chapter_id) env.NOVELSTUDIO_CHAPTER_ID = String(body.chapter_id);
    if (body.mode) env.NOVELSTUDIO_MODE = String(body.mode);
    // 并发上限：同时最多 HARNESS_CONCURRENCY 个运行中/排队任务，防止刷出大量 dsh 子进程拖垮机器。
    // 负载 = 作业设施里的排队/运行中 + 直接跑 harness 的在途请求（两条旁路也算）。
    if (harnessLoad() >= HARNESS_CONCURRENCY) return sendError(res, 429, `已有任务运行中，请稍后再试（并发上限 ${HARNESS_CONCURRENCY}）`);
    // 超时钳制：1s ~ 60min，拒绝近乎无限的后台任务。
    const timeout = Math.min(Math.max(1000, Math.floor(Number(body.timeout) || LONG_AI_TIMEOUT_MS)), 60 * 60 * 1000);
    // 思考强度：非法值在入队前就 400，避免任务排到队才在 dsh 子进程里失败。
    const reasoningEffort = normalizeReasoningEffort(body.reasoning_effort);
    if (body.reasoning_effort && !reasoningEffort) {
      return sendError(res, 400, `非法思考强度：仅允许 ${[...DEEPSEEK_REASONING_EFFORTS].join(' / ')}`);
    }
    const job = createHarnessJob(String(body.prompt).trim(), {
      timeout,
      model: body.model || undefined,
      reasoningEffort: reasoningEffort || undefined,
      env,
      action: body.action || 'harness',
      workId: Number(body.work_id) || null,
      // 归属与语义：让「刷新/重启后续接」知道这是哪一章的哪一步任务。
      chapterId: Number(body.chapter_id) || null,
      kind: String(body.kind || body.action || 'harness').slice(0, 40),
      stage: String(body.stage || '').slice(0, 120)
    });
    // R05：把「这次请求会加载哪一版小说规则」记进运行时贡献记录（hash 可对照）。
    recordDshRequestContributions({
      workId: Number(body.work_id) || null, chapterId: Number(body.chapter_id) || null,
      session: String(body.session || ''), kind: String(body.kind || body.action || 'harness'),
    });
    return sendJSON(res, 202, { ok: true, job_id: job.id, status: job.status, kind: job.kind, stage: job.stage });
  }

  // 「后台继续 / 刷新后续接」：列出本作品还没收尾（或已完成但可能没用上）的长任务。
  if (resource === 'harness' && method === 'GET' && segments[2] === 'recoverable') {
    const workId = query.work_id ? Number(query.work_id) : null;
    const chapterId = query.chapter_id ? Number(query.chapter_id) : null;
    let jobs = listRecoverableJobs(workId);
    if (chapterId) jobs = jobs.filter((j) => Number(j.chapter_id) === chapterId || j.chapter_id === null);
    return sendJSON(res, 200, { ok: true, jobs });
  }

  // 取回一条长任务（含产出）。刷新页面或重启服务后仍可用。
  if (resource === 'harness' && method === 'GET' && segments[2] === 'recovered') {
    const job = getRecoverableJob(String(query.id || ''));
    if (!job) return sendError(res, 404, '任务记录不存在');
    return sendJSON(res, 200, { ok: true, job });
  }

  // 标记任务产出已被应用（成文弹窗打开 / 审稿报告展示 / 修稿差异预览之后调用）。
  // 作用：恢复条不再把这条任务当「已完成，结果待应用」重复提示。
  if (resource === 'harness' && method === 'POST' && segments[2] === 'mark_applied') {
    const body = await readBody(req).catch(() => ({}));
    const jobId = String(body.job_id || '');
    if (!jobId) return sendError(res, 400, '缺少 job_id');
    markHarnessJobApplied(jobId);
    return sendJSON(res, 200, { ok: true });
  }

  if (resource === 'harness' && method === 'GET' && segments[2] === 'job') {
    const jobId = query.id || segments[3];
    const job = harnessJobs.get(String(jobId));
    if (!job) return sendError(res, 404, '任务不存在或已过期（服务重启后旧任务会丢失）');
    return sendJSON(res, 200, {
      ok: true,
      id: job.id,
      status: job.status,
      kind: job.kind || 'harness',
      stage: job.stage || '',
      // 决策 D4：排队状态必须能被前端**结构化**读到。此前只回 stage 文案，
      // 而实时轮询根本不显示 stage，于是"在等槽位"与"运行中"在界面上无法区分。
      model_slot: job.model_slot || '',
      model_waiters: Number(job.model_waiters) || 0,
      chapter_id: job.chapterId || null,
      work_id: job.workId || null,
      elapsed_ms: job.started_at ? (job.finished_at || Date.now()) - job.started_at : 0,
      tail: job.tail.slice(-600),
      output: job.status === 'done' ? job.output : null,
      // D8-#4：命名任务的结构化产出（生成小说 → {title, work_id, …}；压缩 → {summary}）。
      // 与 output 分开：前端不必猜"这次任务的产出是正文还是对象"。
      result: job.status === 'done' ? (job.result ?? null) : null,
      scan: job.status === 'done' ? job.scan : null,
      proposals: job.status === 'done' ? job.proposals : null,
      error: job.error
    });
  }

  // D7：取消正在运行的 harness 任务（杀掉 dsh 子进程树，状态置为 cancelled）
  if (resource === 'harness' && method === 'POST' && segments[2] === 'cancel') {
    const body = await readBody(req);
    const job = harnessJobs.get(String(body.job_id || ''));
    if (!job) return sendError(res, 404, '任务不存在或已结束');
    if (job.status === 'queued' || job.status === 'running') {
      job.cancelRequested = true;
      persistHarnessJob(job);
      try { job.abort?.abort(); } catch (_) { /* 忽略 */ }
      return sendJSON(res, 200, { ok: true, id: job.id, status: 'cancelling' });
    }
    return sendJSON(res, 200, { ok: true, id: job.id, status: job.status });
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'generate_novel') {
    const body = await readBody(req);
    try {
      // 同步跑 harness 的路由也要占并发槽位（此前完全绕过闸门）。
      // 与 /harness/job 同口径：思考强度按档位透传（本路由是旧同步入口，界面已不走它，
      // 但"同一个功能两个入口给出不同的质量档"本身就是缺陷 —— 统一在这里补齐）。
      const effort = normalizeReasoningEffort(body.reasoning_effort) || undefined;
      const result = await withHarnessSlot(() => generateNovelFromHarness(body.prompt, body.model, undefined, undefined, effort));
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      // 429 是闸门拒绝，不是 AI 调用失败——不该混进 AI 错误日志。
      if (e.status === 429) return sendError(res, 429, e.message);
      logAIError('generate_novel', e, '/api/harness/generate_novel');
      return sendError(res, 502, e.message);
    }
  }
  if (resource === 'harness' && method === 'POST' && segments[2] === 'stop') {
    // headless 模式每次任务独立进程，无常驻进程可停止；明确返回未实现，避免「成功」假象。
    return sendError(res, 501, 'Harness 常驻停止接口未实现');
  }

  // AI error history
  if (resource === 'ai_errors' && method === 'GET') {
    return sendJSON(res, 200, listAIErrors());
  }

  // ---------- 统一日志系统 ----------
  // GET  查询（可按 level/layer/kind/q 筛选，before_id 翻页）；返回 entries + 统计。
  // POST 远端上报（浏览器前端 / dsh 插件进程）；DELETE 清空。
  if (resource === 'logs' && method === 'GET') {
    const result = queryLogs({
      level: query.level || '',
      layer: query.layer || '',
      kind: query.kind || '',
      q: query.q || '',
      limit: query.limit ? Number(query.limit) : 100,
      beforeId: query.before_id ? Number(query.before_id) : null
    });
    return sendJSON(res, 200, result);
  }
  if (resource === 'logs' && method === 'POST') {
    const body = await readBody(req);
    const layer = String(body.layer || '');
    if (!REMOTE_LAYERS.includes(layer)) {
      return sendError(res, 400, '远端上报仅允许 frontend / plugin 层级');
    }
    const message = String(body.message || '').trim();
    if (!message) return sendError(res, 400, '缺少 message');
    log({
      remote: true,
      level: ['error', 'warn', 'slow', 'info'].includes(body.level) ? body.level : 'error',
      layer,
      kind: String(body.kind || 'remote_error').slice(0, 40),
      message: message.slice(0, 4000),
      code_file: String(body.code_file || '').slice(0, 2000),
      code_line: Number.isInteger(Number(body.code_line)) ? Number(body.code_line) : undefined,
      code_func: String(body.code_func || '').slice(0, 200),
      stack: String(body.stack || '').slice(0, 16000),
      context: (() => {
        let ctx = (body.context && typeof body.context === 'object') ? body.context : {};
        try {
          const s = JSON.stringify(ctx);
          if (s.length > 8000) ctx = { truncated: true, preview: s.slice(0, 4000) };
        } catch (_) { ctx = {}; }
        return ctx;
      })()
    });
    flushLogs(); // 上报后立即落盘，保证冒烟测试/崩溃排查能立刻读到
    return sendJSON(res, 201, { ok: true });
  }
  if (resource === 'logs' && method === 'DELETE') {
    clearLogs();
    return sendJSON(res, 200, { ok: true });
  }

  // Chapter manual save versions
  if (resource === 'chapter_versions') {
    if (method === 'GET' && !id) {
      const chapterId = Number(query.chapter_id);
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
      return sendJSON(res, 200, listChapterVersions(chapterId));
    }
    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const chapterId = Number(body.chapter_id);
      if (!chapterId) return sendError(res, 400, '缺少 chapter_id');
      if (!prepare('SELECT id FROM chapters WHERE id = ?').get(chapterId)) return sendError(res, 404, '章节不存在');
      const row = saveChapterVersion(chapterId, body.title, body.summary, body.content);
      return sendJSON(res, 201, row);
    }
    if (method === 'POST' && id && segments[2] && segments[3] === 'restore') {
      const body = await readBody(req);
      const version = prepare('SELECT * FROM chapter_save_versions WHERE id = ?').get(id);
      if (!version) return sendError(res, 404, '历史版本不存在');
      const chapter = prepare('SELECT * FROM chapters WHERE id = ?').get(version.chapter_id);
      if (!chapter) return sendError(res, 404, '章节不存在');
      db.exec('BEGIN');
      try {
        if (body.backup_current !== false) {
          saveChapterVersion(chapter.id, chapter.title, chapter.summary, chapter.content);
        }
        prepare('UPDATE chapters SET title = ?, summary = ?, content = ? WHERE id = ?').run(
          version.title || chapter.title,
          version.summary || '',
          version.content || '',
          chapter.id
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const updated = prepare('SELECT * FROM chapters WHERE id = ?').get(chapter.id);
      touchWork(chapter.work_id);
      notifyChange('chapters', { workId: chapter.work_id, id: chapter.id });
      return sendJSON(res, 200, { ok: true, chapter: updated });
    }
    return sendError(res, 405, 'Method not allowed');
  }

  // Graceful shutdown: release port and stop the Node process
  if (resource === 'shutdown' && method === 'POST') {
    sendJSON(res, 200, { ok: true, message: '服务正在关闭' });
    setTimeout(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    }, 80);
    return;
  }

  // AI endpoints
  // AI 效果埋点（P5）：POST 记一条行为信号；GET 取聚合（采纳率 / 编辑距离 / 上下文成本）。
  if (resource === 'ai' && segments[2] === 'eval') {
    if (method === 'POST') {
      const body = await readBody(req);
      const ok = recordAIEval({
        workId: body.work_id, chapterId: body.chapter_id, action: body.action,
        channel: body.channel, model: body.model, charsIn: body.chars_in, charsOut: body.chars_out,
        ms: body.ms, editDistance: body.edit_distance, draftKey: body.draft_key
      });
      return sendJSON(res, 200, { ok });
    }
    if (method === 'GET') {
      return sendJSON(res, 200, { ok: true, ...summarizeAIEval(Number(query.work_id) || null) });
    }
    return sendError(res, 405, 'Method not allowed');
  }
  // AI 策略快照（P4）：前端据此把散落的模型字面量换成档位查询，取得与后端同一份策略。
  // 必须放在下面 /api/ai/* 的 POST 分支之前——它是 GET。
  if (resource === 'ai' && segments[2] === 'policy' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, ...policySnapshot() });
  }
  if (resource === 'ai' && segments[2]) {
    const action = segments[2];
    if (method !== 'POST') return sendError(res, 405, 'Method not allowed');
    let body;
    try { body = await readBody(req); } catch (e) { return sendError(res, 400, e.message); }
    try {
      const config = getConfigFromBody(body);
      if (!config.api_key) return sendError(res, 400, '请先填写 API Key');
      // 允许请求级覆盖模型（工作台阶段等需要按策略选择 flash/pro）
      if (body.model) config.model = normalizeModel(body.model);
      if (action === 'generate_novel') {
        const result = await generateNovelFromPrompt(body.prompt, config);
        return sendJSON(res, 200, { ok: true, ...result });
      }
      if (action === 'test') {
        const data = await callAI(config, [{ role: 'user', content: '请只回复：连接成功' }], {
          temperature: 0.1,
          max_tokens: 16
        });
        return sendJSON(res, 200, { ok: true, reply: data?.choices?.[0]?.message?.content || '连接成功', raw: data });
      }
      // 流式直连成文：SSE 边生成边下发，结束后带确定性红线扫描报告（质量优先模式）。
      if (action === 'write_stream') {
        return handleAIWriteStream(req, res, body, config);
      }
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) return sendError(res, 400, '缺少 messages');
      if (action === 'write' || action === 'personality' || action === 'outline' || action === 'chat' || action === 'polish' || action === 'expand' || action === 'pipeline') {
        const data = await callAI(config, messages, { temperature: body.temperature, max_tokens: body.max_tokens, reasoning_effort: body.reasoning_effort });
        return sendJSON(res, 200, { ok: true, reply: data?.choices?.[0]?.message?.content || '', raw: data });
      }
      return sendError(res, 404, 'Unknown AI action');
    } catch (e) {
      logAIError(action, e, `/api/ai/${action}`);
      return sendError(res, e.status || 502, e.message || 'AI request failed');
    }
  }

  // Generic CRUD for listed resources
  const crudResources = new Set([
    'works', 'volumes', 'plotlines', 'chapters', 'categories', 'terms',
    'characters', 'relations', 'plotline_characters', 'world_entries', 'creation_tasks', 'api_configs'
  ]);
  if (crudResources.has(resource)) {
    // 存在 id 段但解析失败（如 /api/works/12abc）→ 404，而不是落入列表分支返回全量数据。
    if (segments[2] !== undefined && id === null) return sendError(res, 404, 'Not found');
    const maskRow = (row) => (resource === 'api_configs' && row ? { ...row, api_key: maskApiKey(row.api_key) } : row);
    try {
      if (method === 'GET' && !id) {
        const where = {};
        const unsupported = [];
        for (const key of ['work_id', 'volume_id', 'plotline_id', 'parent_id', 'category_id', 'character_id', 'from_character_id', 'to_character_id']) {
          if (query[key] === undefined) continue;
          // 不是这一张表的列就不能当过滤条件（第五步联合回归实测：/api/works?work_id=5
          // 曾把 `no such column: work_id` 原样回给客户端）。
          if (!tableHasColumn(resource, key)) { unsupported.push(key); continue; }
          where[key] = Number(query[key]);
        }
        if (unsupported.length) return sendError(res, 400, `不支持的过滤参数：${unsupported.join(', ')}`);
        const rows = getList(resource, where) || [];
        return sendJSON(res, 200, resource === 'api_configs' ? rows.map(maskRow) : rows);
      }
      if (method === 'GET' && id) {
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        return row ? sendJSON(res, 200, maskRow(row)) : sendError(res, 404, 'Not found');
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const newId = insertRow(resource, body);
        if (body.work_id) touchWork(body.work_id);
        if (resource === 'works') touchWork(newId);
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(newId);
        // OpenViking 增量同步：新建作品触发全量建索引，其余资源防抖后重写对应文件。
        if (resource === 'works') {
          syncWorkFull(newId).then(() => {}).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `新作品同步失败（work ${newId}）：${e.message}` }));
        } else if (resource !== 'plotline_characters') {
          const wid = (row?.work_id ?? Number(body.work_id)) || null;
          if (wid) notifyChange(resource, { workId: wid, id: newId });
        } else if (row?.work_id) {
          // plotline_characters 影响出场角色选择，需失效上下文缓存（无对应记忆库渲染器，故不 notifyChange）。
          touchWork(row.work_id);
        }
        return sendJSON(res, 201, maskRow(row));
      }
      if (method === 'PUT' && id) {
        const body = await readBody(req);
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        // 乐观锁：编辑保存携带读取时的 updated_at，冲突返回 409（前端提示刷新）。
        if (resource === 'chapters' && body._if_updated_at !== undefined) {
          if (old && String(old.updated_at) !== String(body._if_updated_at)) {
            return sendError(res, 409, '内容已在其他窗口被修改，请刷新后重试');
          }
        }
        const changes = updateRow(resource, id, body);
        if (changes === 0) return sendError(res, 404, 'Not found');
        // P5 埋点：章节正文落盘是「AI 草稿 → 作者最终正文」的测量点（见函数注释）。
        // 只在正文真的被写时尝试；没有待测量的采纳行时它是空操作。
        if (resource === 'chapters' && typeof body.content === 'string' && body.content.trim()) {
          measureAdoptEditDistance(id, body.content);
          // D8-#3：记忆自动压缩的触发点（**默认关闭**，见 maybeAutoCompressMemory）。
          // 放在正文落盘之后：此时长期记忆的输入（本章正文）才是最新的。
          if (old?.work_id) maybeAutoCompressMemory(old.work_id);
        }
        if (old?.work_id) touchWork(old.work_id);
        if (body.work_id) touchWork(body.work_id);
        if (resource === 'works') touchWork(Number(id));
        const row = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        const wid = resource === 'works'
          ? Number(id)
          : ((old?.work_id ?? row?.work_id ?? Number(body.work_id)) || null);
        if (wid && resource !== 'plotline_characters') {
          notifyChange(resource, { workId: wid, id: resource === 'works' ? Number(id) : id });
        } else if (wid) {
          touchWork(wid);
        }
        return sendJSON(res, 200, maskRow(row));
      }
      if (method === 'DELETE' && id) {
        const old = prepare(`SELECT * FROM ${resource === 'relations' ? 'character_relations' : resource} WHERE id = ?`).get(id);
        // P5 埋点的连带清理（决策 D6·C-①）：`ai_eval_events` 的 work_id/chapter_id 是**裸列**，
        // 没有像其它二十余张作品域表那样写 `ON DELETE CASCADE`。不显式删就会留下孤儿行：
        // 谁也够不到它们，而 `GET /api/ai/eval`（不带 work_id）会把它们算进全局聚合，把指标带偏。
        // ⚠️ 必须在 deleteRow **之前**删：章节随作品级联消失后，就再也解析不出 chapter_id 了。
        if (resource === 'works') purgeEvalEventsOfWork(Number(id));
        const removed = deleteRow(resource, id);
        if (!removed) return sendError(res, 404, 'Not found');
        if (old?.work_id) touchWork(old.work_id);
        if (resource === 'works') touchWork(Number(id));
        // OpenViking 增量同步：删除作品 → 整目录移除；其余资源 → 删除对应文件。
        if (resource === 'works') {
          removeWorkFromMemory(Number(id)).catch((e) => log({ level: 'warn', layer: 'sync', kind: 'sync_error', message: `作品目录移除失败（work ${id}）：${e.message}` }));
        } else if (old?.work_id && resource !== 'plotline_characters') {
          notifyChange(resource, { workId: old.work_id, id, deleted: true });
        } else if (old?.work_id) {
          touchWork(old.work_id);
        }
        return sendJSON(res, 200, { ok: true });
      }
      return sendError(res, 405, 'Method not allowed');
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  return sendError(res, 404, 'API not found');
}

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = path.join(publicDir, 'index.html');
  } else {
    filePath = path.join(publicDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  }
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { try { res.destroy(); } catch (_) { /* 忽略 */ } });
      res.on('error', () => { stream.destroy(); });
      stream.pipe(res);
    } else {
      // SPA fallback: send index.html for non-file paths
      fs.readFile(path.join(publicDir, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      });
    }
  });
}

// 首次启动写入默认红线清单（幂等）
seedRedlinesIfEmpty();

// 把作者在 AI 设置页填过的工具配置注入到对应模块（OpenViking 凭证 / dsh 仓库路径）。
// 必须在服务开始接请求之前执行：否则重启后第一次 AI 任务会用到旧路径或旧凭证，
// 而界面显示的是已保存的新值——"看起来生效、实际没生效"正是要避免的形态。
{
  const applied = applyWorkshopToolSettings();
  const ovFrom = applied.ov.endpoint || applied.ov.apiKey ? '工坊内设置' : '配置文件/环境变量';
  log({
    level: 'info', layer: 'server', kind: 'workshop_tool_settings',
    message: `工具配置已加载（OpenViking 凭证来源：${ovFrom}；dsh 仓库覆盖：${applied.dshRepo || '未设置'}）`,
    context: { ov_endpoint_source: applied.endpoint_source, dsh_repo: applied.dshRepo }
  });
}

// 日志系统初始化：注入 SQLite、迁移旧 AI 错误、安装进程兜底与卡顿监测、启动保留策略。
initLogger(db, { onExit: () => { flushDebouncedSync(); flushTraceFile(); } });

// 追踪时钟自检：确认「单调时钟」与「Unix 纪元时钟」确实是两个域。
// 若某天两者差值落到 0 附近，说明 nowMs() 的实现被换成了 Date.now()，
// 此时所有以 hrtime 为基准的历史注释与判据都要重新审一遍 —— 提前吵一声，别等数据失真后才发现。
{
  const clock = traceClockDomain();
  if (Math.abs(clock.drift_ms) < 1000) {
    log({
      level: 'error', layer: 'server', kind: 'trace_clock_suspect',
      message: '追踪时钟自检异常：单调时钟与 Unix 纪元时钟几乎重合，nowMs() 可能已被改成 Date.now()',
      context: clock
    });
  } else {
    log({
      level: 'info', layer: 'server', kind: 'trace_clock_ok',
      message: `追踪时钟自检通过（单调与纪元相差 ${Math.round(Math.abs(clock.drift_ms) / 86400000)} 天）`,
      context: clock
    });
  }
}

// 调试录制期间定期检查前端心跳：页面被关闭后自动停止录制，避免「忘关」长期开着。
// 超时 90s（前端 10s ping 的 9 倍）：浏览器把后台标签页定时器节流到约 1 次/分钟，
// 余量太小会把「切到别的标签页」误判成「页面已关闭」。
setInterval(() => {
  try {
    checkStaleTracing(90000);
  } catch (_) { /* 自检失败不影响服务 */ }
}, 15000).unref();

// 空闲收尾：把响应已回完、但前端从未显式结束的服务端操作关掉。
// 没有这一步，这类操作会一直挂在 running，耗时被算到「停录那一刻」（30ms 的检索记成 546469ms）。
// 间隔取 200ms：收尾精度 ≈ 宽限期(1200ms) + 一个 tick，比 15s 心跳高两个数量级，
// 又远低于真实业务操作（秒级～分钟级）的时长，不会把长任务误判成已结束。
// 循环本身极轻：录制未开启时函数第一行即返回。
setInterval(() => {
  try {
    sweepIdleOperations();
  } catch (_) { /* 收尾失败不影响服务 */ }
}, 200).unref();

const server = http.createServer(async (req, res) => {
  const startedAt = performance.now();
  let pathname = '';
  let query = {};
  try {
    ({ pathname, query } = getPath(req));
  } catch (e) {
    log({
      level: 'warn', layer: 'server', kind: 'http_bad_url',
      message: `URL 解析失败：${String(e?.message || e)}`,
      error: e,
      context: { method: req.method, url: String(req.url || '').slice(0, 500) }
    });
    if (!res.destroyed && !res.headersSent) sendError(res, 400, '请求地址不合法');
    return;
  }
  try {
    if (pathname.startsWith('/api/')) {
      // traceRequest：录制中为本次请求建立追踪上下文，让整条 await 链归属同一个用户操作；
      // 未录制或被排除的路径（/api/debug、/api/logs 等）直接执行，走原路径零开销。
      await traceRequest(req, res, () => handleAPI(req, res, pathname, query));
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    // 统一错误日志：记录发生时间/层级/代码位置/文件地址（logger 自动解析调用栈）。
    log({
      level: 'error', layer: 'server', kind: 'http_error',
      message: `接口异常：${String(e?.message || e)}`,
      error: e,
      context: { method: req.method, path: pathname, query: String(req.url || '').slice(0, 500) }
    });
    if (!res.destroyed && !res.headersSent) {
      const status = e?.code === 'PAYLOAD_TOO_LARGE' ? 413
        : e?.code === 'INVALID_JSON' ? 400
        : 500;
      if (status === 413) res.setHeader('Connection', 'close'); // 请求体未读完：明确关闭连接，不复用
      sendError(res, status, e?.message);
    }
  } finally {
    // 慢请求监测：API 耗时超标记 slow 日志（“不流畅”的可归因记录）。
    // N-07：AI 通道（直连 /ai/ 与慢通道 /harness）天然秒级起步，用更高阈值避免「慢请求」刷屏。
    const aiLike = pathname.startsWith('/api/ai/') || pathname.startsWith('/api/harness');
    const slowMs = aiLike ? 10000 : SLOW_REQUEST_MS;
    const ms = performance.now() - startedAt;
    if (pathname.startsWith('/api/') && pathname !== '/api/logs' && ms > slowMs) {
      log({
        level: 'slow', layer: 'server', kind: 'slow_request',
        message: `${req.method} ${pathname} 耗时 ${Math.round(ms)}ms（阈值 ${slowMs}ms）`,
        context: { method: req.method, path: pathname, duration_ms: Math.round(ms) },
        dedupMs: 60 * 1000
      });
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Novel Studio is running at http://localhost:${PORT}`);
  // 启动后异步把尚未索引的作品导入 OpenViking 共享记忆库（语义召回开启时）。
  autoIndexExistingWorks();
  // R03：重启恢复——上次进程在"采纳已提交、投影还没执行"之间退出时，记录仍在 outbox 里
  // （pending/failed），这里只凭持久化状态续跑，不依赖任何内存队列。
  if (projectionSummary().pending > 0) {
    drainProjectionOutbox().then((r) => {
      if (r.drained) log({ level: 'info', layer: 'sync', kind: 'projection_recovered', message: `启动恢复投影 ${r.drained} 条（pending ${r.pending} / failed ${r.failed}）` });
    }).catch(() => { /* 保持 failed，界面可见可重试 */ });
  }
});
