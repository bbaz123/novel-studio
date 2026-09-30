/**
 * 时态故事状态 · 保存后自动分析（提案生成）的唯一调度入口。
 *
 * 纪律：
 *   · 模型适配器由调用方注入（server 用项目既有 callAI；测试注入确定性 fake），
 *     本模块不 import 任何具体模型通道 —— 保证测试永远不会误触真实计费模型。
 *   · 只处理「pending 且等于最新修订」的保存提案；过期 / 已作废 / 已完成的提案一律不重复跑。
 *   · 分析结果只挂到 pending 提案上（analysis.status='done' + 候选事件），**绝不**直接推进
 *     正式状态；正式状态只能由作者确认（confirmBinding）或作者更正（correctAuthorState）产生。
 *   · 无模型可用时如实记录 not_run，保存本身不受影响。
 */
import { db } from '../../../db.js';
import { sha16 } from './schema.mjs';
import { buildExtractionPrompt, parseExtractionResponse, sanitizeText } from './extraction.mjs';
import { getTemporalConfig } from './config.mjs';
import { revisionPlainText } from './revision-store.mjs';
import { analysisContext, beginAnalysis, completeAnalysis, finishAnalysis, pendingInputCheck } from './service.mjs';

export const TEMPORAL_ANALYSIS_VERSION = '1.0.0';

function chapterTitleOf(chapterId) {
  try {
    const row = db.prepare('SELECT title FROM chapters WHERE id = ?').get(Number(chapterId) || 0);
    return row ? String(row.title || '') : '';
  } catch {
    return '';
  }
}

/** 兼容 string / {text} / {content} / {message:{content}} 四种模型返回形态。 */
export function textOfModelOutput(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.content === 'string') return raw.content;
    if (raw.message && typeof raw.message.content === 'string') return raw.message.content;
  }
  return String(raw);
}

/**
 * 对本章最新修订发起一次抽取分析（幂等：同一提案已完成/在进行中不会重复调用模型）。
 * @param {object} args
 * @param {number} args.workId
 * @param {number} args.chapterId
 * @param {Function|null} args.generate 注入的模型适配器；缺省 = 无模型，记为 not_run
 * @returns {Promise<object>} JSON 安全回执（ran=false 表示本次没有消耗模型调用）
 */
export async function analyzeChapter({ workId, chapterId, generate = null, provider = 'model', model = '', targetWords = 2000, force = false } = {}) {
  const ctx = analysisContext({ workId, chapterId });
  if (!ctx.enabled) return { ok: false, enabled: false, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'disabled', ran: false, reason: ctx.reason };
  if (ctx.status === 'no_content') return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'no_content', ran: false, reason: '该章节还没有正文修订：先保存正文' };
  if (ctx.status === 'up_to_date') return { ok: true, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'up_to_date', ran: false, reason: '没有待确认的保存提案' };
  if (ctx.status === 'stale') return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'stale', ran: false, reason: '提案已被更新的正文替代：等保存流程重新建立提案' };
  if (ctx.status === 'running') return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'running', ran: false, binding_id: ctx.binding && ctx.binding.id, reason: '已有分析在进行中' };
  if (ctx.status === 'done') {
    // 幂等：输入未变时绝不重复调用模型；但**输入已变**（上游有新确认 / 章序变化）时允许重新分析，
    // 否则该提案永远无法通过确认复核（T2 §6.1 的输入绑定复核）。
    const current = pendingInputCheck({ workId, chapterId, binding: ctx.binding });
    if (current.ok) {
      return { ok: true, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'done', ran: false, binding_id: ctx.binding.id, proposal: (ctx.binding.contract_ref || {}).proposal || null };
    }
  }
  if (!ctx.ok) return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: ctx.status, ran: false, reason: ctx.reason || '' };
  // 关闭自动分析：保存后的自动调度如实记 not_run；作者在界面上显式发起（force）仍然执行。
  if (!force && !getTemporalConfig(ctx.work_id).auto_analysis) {
    finishAnalysis({ workId, chapterId, bindingId: ctx.binding.id, status: 'not_run', error: '自动分析未开启（可在章节面板显式发起）', provider });
    return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'not_run', ran: false, binding_id: ctx.binding.id, reason: '自动分析未开启：本次保存未运行语义分析（可在章节面板显式发起）' };
  }
  if (typeof generate !== 'function') {
    finishAnalysis({ workId, chapterId, bindingId: ctx.binding.id, status: 'not_run', error: '没有可用的模型适配器', provider });
    return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'not_run', ran: false, binding_id: ctx.binding.id, reason: '没有可用的模型适配器：分析未运行（保存不受影响）' };
  }
  const begun = beginAnalysis({ workId, chapterId, expectedBindingId: ctx.binding.id });
  if (!begun.ok) return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: begun.status || 'running', ran: false, binding_id: ctx.binding && ctx.binding.id, reason: begun.reason || '' };
  const revision = ctx.revision;
  const plainText = revisionPlainText(revision);
  const prompt = buildExtractionPrompt({
    chapterId: ctx.chapter_id, chapterTitle: chapterTitleOf(ctx.chapter_id), revision, plainText,
    stateBeforeJson: ctx.state_json || {}, known: ctx.known || {}, targetWords,
  });
  let output = '';
  try {
    output = textOfModelOutput(await generate({
      system: prompt.system, user: prompt.user, model,
      work_id: ctx.work_id, chapter_id: ctx.chapter_id,
      binding_id: begun.binding_id, revision_id: revision.id,
    }));
  } catch (e) {
    const error = sanitizeText(String((e && e.message) || e), 300);
    finishAnalysis({ workId, chapterId, bindingId: begun.binding_id, status: 'failed', error, provider });
    return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'failed', ran: true, binding_id: begun.binding_id, reason: error };
  }
  const parsed = parseExtractionResponse(output, { workId, chapterId, revisionId: revision.id, plainText });
  const resultHash = sha16(sanitizeText(output, 2000));
  const done = completeAnalysis({
    workId, chapterId, bindingId: begun.binding_id, events: parsed.events, assumptions: parsed.assumptions,
    provider, model, inputHash: prompt.input_hash, resultHash, issues: parsed.issues,
  });
  if (!done.ok) {
    finishAnalysis({ workId, chapterId, bindingId: begun.binding_id, status: done.decision === 'stale' ? 'stale' : 'failed', error: done.reason || '', provider });
    return { ok: false, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: done.decision || 'failed', ran: true, binding_id: begun.binding_id, reason: done.reason || '', issues: done.issues || [] };
  }
  return { ok: true, enabled: true, work_id: ctx.work_id, chapter_id: ctx.chapter_id, status: 'done', ran: true, binding_id: done.binding_id, proposal: done.proposal, dependencies: done.dependencies, issues: done.issues || [] };
}