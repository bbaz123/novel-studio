#!/usr/bin/env node
/**
 * test-1031-writing-quality.mjs —— 截断与质检闭环的离线回归（零计费）。
 * 方案 §3/§5：finish_reason 贯通、跳过原因不再误报、短稿不得在未质检时判"完整"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks } from '../tests/narrative-repair/harness.mjs';

const { check, finish } = createChecks();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(new URL('../public/writing-quality.js', import.meta.url).href);
const WQ = globalThis.NovelWritingQuality;
const row = (id, final_status) => ({ issue_id: id, final_status });

check('WQ-01 finish_reason=length → OUTPUT_LIMIT_REACHED（不再把 done 当完整）',
  WQ.generationStatusOf({ text: '半章', finishReason: 'length' }) === 'OUTPUT_LIMIT_REACHED');
check('WQ-02 明确 stop → PROVIDER_STOP；缺字段 → UNKNOWN（绝不猜 stop）',
  WQ.generationStatusOf({ text: '完', finishReason: 'stop' }) === 'PROVIDER_STOP'
  && WQ.generationStatusOf({ text: '完' }) === 'UNKNOWN_TERMINATION'
  && WQ.generationStatusOf({ text: '' }) === 'EMPTY_OUTPUT');
check('WQ-03 用户取消优先于其他状态',
  WQ.generationStatusOf({ text: '半章', cancelled: true }) === 'USER_CANCELLED');

check('WQ-04 质检 unparsed 的真实文案不再是"长正文分段模块不可用"',
  /格式无效/.test(WQ.qualitySkipText('unparsed')) && !/长正文分段模块/.test(WQ.qualitySkipText('unparsed'))
  && /超过单请求/.test(WQ.qualitySkipText('over_single_request_limit'))
  && /weird_code/.test(WQ.qualitySkipText('weird_code')));

check('WQ-05 输出上限触发的短稿 → truncated（即使字数已够也不得判 ok）',
  WQ.classifyLength({ chars: 5000, target: 4000, generation: { status: 'OUTPUT_LIMIT_REACHED' } }).status === 'truncated');
check('WQ-06 质检跳过/unknown → unverified，不能判"短但完整"',
  WQ.classifyLength({ chars: 1759, target: 4000, verdict: { skipped: true, reason: 'unparsed' } }).status === 'unverified'
  && WQ.classifyLength({ chars: 1759, target: 4000, verdict: { verdict: 'unknown' } }).status === 'unverified');
check('WQ-07 字数够且质检完成 → ok；短且明确遗漏 → missing_content',
  WQ.classifyLength({ chars: 4200, target: 4000, verdict: { verdict: 'pass' } }).status === 'ok'
  && WQ.classifyLength({ chars: 1759, target: 4000, verdict: { verdict: 'issues', issues: ['章内必需的D级结果未出现'] } }).status === 'missing_content');

const serverSrc = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
check('WQ-08 服务端贯通 finish_reason / requested_max_tokens / generation_status',
  /finish_reason/.test(serverSrc) && /finish_reason_observed/.test(serverSrc)
  && /generation_status/.test(serverSrc) && /requested_max_tokens/.test(serverSrc)
  && /stream_terminated_normally/.test(serverSrc));
check('WQ-09 前端保留 generation 元数据并交给篇幅诊断',
  /generation:\s*\{[\s\S]{0,400}finish_reason/.test(appSrc)
  && /classifyChapterLength\(article, target, verdict, \(proseData && proseData\.generation\)/.test(appSrc)
  && /qualitySkipText\(verdict\.reason\)/.test(appSrc));
check('WQ-10 页面真的加载 writing-quality.js（防止只在测试里存在）',
  /src="\/writing-quality\.js"/.test(indexSrc));

check('WQ-11 蓝图门禁与篇幅分开：truncated/质检失败 → 不可正常交付',
  WQ.blueprintStatusOf({ length: { status: 'truncated' }, verdict: { verdict: 'pass' } }).ready_for_normal_delivery === false
  && WQ.blueprintStatusOf({ length: { status: 'short_but_complete' }, verdict: { skipped: true } }).status === 'UNVERIFIED'
  && WQ.blueprintStatusOf({ length: { status: 'unverified' }, verdict: { verdict: 'unknown' } }).status === 'UNVERIFIED');
check('WQ-12 质检 issues → MISSING_REQUIRED_BEATS 且 unresolved 可追踪；pass → VERIFIED',
  WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'issues', issues: ['D级结果未出现'] } }).status === 'MISSING_REQUIRED_BEATS'
  && WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'issues', issues: ['D级结果未出现'] } }).unresolved.length === 1
  && WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'pass' } }).ready_for_normal_delivery === true);
check('WQ-13 前端记录蓝图门禁结果（不只记录字数）',
  /ai_write_blueprint_status/.test(appSrc) && /blueprintStatusOf/.test(appSrc));

const beats = WQ.requiredBeatsFromBlueprint({ required_beats: [{ id: 'B01', description: 'D级结果发生' }, { id: 'B02', description: '章末系统钩子' }] });
check('WQ-14 只从作者蓝图显式 required_beats 提取；全部 met 才 VERIFIED，缺一条即 MISSING',
  beats.length === 2
  && WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'pass', beats: [{ id: 'B01', status: 'met' }, { id: 'B02', status: 'met' }] }, requiredBeats: beats }).status === 'VERIFIED'
  && WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'pass', beats: [{ id: 'B01', status: 'missing' }, { id: 'B02', status: 'met' }] }, requiredBeats: beats }).status === 'MISSING_REQUIRED_BEATS'
  && WQ.requiredBeatsFromBlueprint({}).length === 0);
check('WQ-15 缺逐条 beats 证据时不得仅凭 verdict=pass 判蓝图完成',
  WQ.blueprintStatusOf({ length: { status: 'ok' }, verdict: { verdict: 'pass' }, requiredBeats: beats }).status === 'UNVERIFIED');
check('WQ-16 定向续写：无作者授权/已完成/取消一律拒绝；截断且有授权才允许',  WQ.continuationDecision({ generation: { status: 'OUTPUT_LIMIT_REACHED' }, authorAuthorized: false }).allow === false
  && WQ.continuationDecision({ readyForDelivery: true, authorAuthorized: true, missingBeatIds: ['B01'] }).allow === false
  && WQ.continuationDecision({ cancelled: true, authorAuthorized: true, missingBeatIds: ['B01'] }).allow === false
  && WQ.continuationDecision({ generation: { status: 'OUTPUT_LIMIT_REACHED' }, authorAuthorized: true }).allow === true);

check('WQ-17 冻结绑定蓝图 revision + beats 内容哈希；同内容稳定、变内容必变',
  (() => {
    const bp = { revision: 'r1', required_beats: [{ id: 'B01', description: 'D级结果' }] };
    const a = WQ.freezeRequiredBeats(bp);
    const b = WQ.freezeRequiredBeats(bp);
    const c = WQ.freezeRequiredBeats({ ...bp, required_beats: [{ id: 'B01', description: '改过的情节' }] });
    return a.blueprint_revision === 'r1' && a.required_beats_hash === b.required_beats_hash
      && a.required_beats_hash !== c.required_beats_hash && /^fnv1a:[0-9a-f]+$/.test(a.required_beats_hash);
  })());
check('WQ-18 前端记录蓝图冻结（revision+hash），而不是只算不记',
  /ai_write_blueprint_freeze/.test(appSrc) && /required_beats_hash/.test(appSrc));

check('WQ-19 结果弹窗在 truncated/unverified 时提供定向续写按钮',
  /data-action="ai-continue-missing"/.test(appSrc)
  && appSrc.indexOf("status === 'truncated'") < appSrc.indexOf('data-action="ai-continue-missing"'));
check('WQ-20 续写按钮走授权判定 + 预算确认 + 只追加不覆盖',
  /continuationDecision\(\{/.test(appSrc)
  && /输出上限 \$\{budget\} tokens/.test(appSrc)
  && /window\.confirm/.test(appSrc)
  && /const merged = `\$\{String\(ctx\.article \|\| ''\)\.trim\(\)\}\\n\\n\$\{cont\}`/.test(appSrc));
check('WQ-21 续写未返回正文时抛错且不静默写入',
  /续写没有返回正文（未写入任何内容）/.test(appSrc));

finish('test-1031 写作截断与质检闭环');
