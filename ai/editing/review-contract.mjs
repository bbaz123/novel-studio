/**
 * ai/editing/review-contract.mjs — 审稿契约 v3 的 ESM 入口。
 *
 * 为什么这里是"转发"而不是实现：
 *   本仓库前端**没有构建步骤**（`public/*.js` 以经典脚本直接加载），而服务端与 Node 测试是 ESM。
 *   把归一化/绑定/校验写成两份，历史上已经出现过"同一判据两份文本漂移"。所以实现只保留一份
 *   —— `public/review-contract.js`（UMD 纯函数模块），浏览器 `<script>` 直接执行它，
 *   服务端与测试用本文件转出命名导出。两边跑的是**同一段代码**。
 *
 * 如果你需要改契约：改 `public/review-contract.js`，然后确认本文件的导出面仍覆盖 UMD 的 API。
 * `scripts/quality-auditor/verify-id-chain.mjs` 里有一条断言专门比对导出面，防止漏转。
 */

await import(new URL('../../public/review-contract.js', import.meta.url).href);

const C = globalThis.NovelReviewContract;
if (!C || typeof C.normalizeReviewReport !== 'function') {
  throw new Error('review-contract 未注册：public/review-contract.js 没有执行（UMD 全局 NovelReviewContract 缺失）');
}

export const VERSION = C.VERSION;
export const SCHEMA_VERSION = C.SCHEMA_VERSION;
export const LEGACY_SCHEMA_VERSION = C.LEGACY_SCHEMA_VERSION;
export const NORMALIZATION_VERSION = C.NORMALIZATION_VERSION;
export const LINK_MODES = C.LINK_MODES;
export const CODES = C.CODES;
export const EVIDENCE_ROLES = C.EVIDENCE_ROLES;
export const FINDING_TYPES = C.FINDING_TYPES;
export const SEVERITIES = C.SEVERITIES;

export const sha256 = C.sha256;
export const sha256Hex = C.sha256Hex;
export const stableStringify = C.stableStringify;
export const normalizeEvidence = C.normalizeEvidence;
export const normalizeAcceptance = C.normalizeAcceptance;
export const normalizeFinding = C.normalizeFinding;
export const normalizeFindings = C.normalizeFindings;
export const reviewIssueId = C.reviewIssueId;
export const reviewIssueText = C.reviewIssueText;
export const linkIssuesToFindings = C.linkIssuesToFindings;
export const validateReviewIntegrity = C.validateReviewIntegrity;
export const normalizeReviewReport = C.normalizeReviewReport;
export const migrateLegacyReviewReport = C.migrateLegacyReviewReport;
export const findingById = C.findingById;
export const issueById = C.issueById;
export const assertSelectionMappable = C.assertSelectionMappable;
export const selectionRecord = C.selectionRecord;
export const hashReport = C.hashReport;
export const issueLineText = C.issueLineText;
export const normalizeStoredReviewReport = C.normalizeStoredReviewReport;

export default C;
