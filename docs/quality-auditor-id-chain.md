# 审稿身份链 review.v3（dsh-novel-quality-auditor 阶段 1）

> 适用代码：本文件描述**当前**实现（2026-10-21）。函数名稳定，行号会漂。

## 1. 修的是什么缺陷

旧链路（可构造、可断言，不是文学判断差异）：

```text
buildAIReviewPrompt()  要求模型输出稳定 finding id（R-0001…），issues 与 findings 同序
parseReviewText()      把 issues 拍平成字符串数组，findings 另存
showReviewReport()     按数组下标生成复选框（data-review-issue="0"）
issueStableId()        对字符串问题返回 "1"、"2"
revisionFindingsFor()  按选中 ID 查 findings → 永远查不到 → 静默退回 legacy 空证据
```

后果不是"编号不好看"，而是：**多位置授权、逐字引用、验收条件全部丢失**。作者勾选"1"，
结构化 finding 是 `R-0001`，映射失败后退回空证据 —— 修稿可能只改一处、改错位置，事后也无法证明修好。

## 2. 唯一稳定身份

```text
finding.id
  = review.issues[].id
  = checkbox data-review-issue-id
  = revision_selection.selected_issue_ids[]
  = revision_plan.finding_id
  = patch.issue_id
  = semantic_verification.issue_id
  = quality_audit_item.issue_id
  = UI 最终状态行 issue_id
```

`data-review-issue="<index>"` 仍然保留，但它只表示**显示位置**，不参与任何业务判定。

## 3. 实现位置（单一来源）

| 文件 | 作用 |
| --- | --- |
| `public/review-contract.js` | **唯一实现**（UMD 纯函数）。浏览器经典脚本直接加载；Node 侧 `await import()` 同一文件 |
| `ai/editing/review-contract.mjs` | ESM 入口，把同一份实现按命名导出转出（服务端与测试用）。不复制判据 |
| `server.js` | `parseReviewText` / `saveReview` / `getLatestReview` / `PUT /novel/revision/selection` 全部走契约 |
| `public/app.js` | `parseReviewText` / `showReviewReport` / `refineByChecklist` / `revisionFindingsFor` / `revisionIssueQuotes` / `issueStableId` 全部按稳定 id |

为什么不是两份代码：本仓库前端**没有构建步骤**（`public/*.js` 以 `<script>` 直接加载），服务端与测试是 ESM。
把归一化写成两份，历史上已经出现过"同一判据两份文本漂移"。所以实现只有一份 UMD 文件，
`ai/editing/review-contract.mjs` 只是转发。

浏览器取用方式：`GET /review-contract.js` 由 `serveStatic` 的 `REVIEW_CONTRACT_ALIAS` 映射到
`ai/editing/review-contract.mjs`。页面里它先于 `app.js` 加载，`app.js` 在调用时惰性取
`globalThis.NovelReviewContract`（缺失时返回 `REVIEW_CONTRACT_UNAVAILABLE` 并禁用修稿，不静默降级）。

## 4. 绑定顺序（固定，不猜）

1. issue 自带 `id` → 按显式 ID 绑定（`link_mode=explicit`），并核验该 id 在 findings 里存在。
2. issue 无 ID、findings 同序同量 → 按提示词契约绑定同位置 finding ID（`link_mode=position_contract`）；
   若逐条文本"明显不对应"（2-gram 全无交集）→ 判 `REVIEW_ID_MAPPING_BROKEN`，不猜。
3. 数量不一致 / ID 重复 / 映射缺失 → `REVIEW_ID_MAPPING_BROKEN` 或 `REVIEW_DUPLICATE_ID`。
4. 存量报告 → `LEGACY-<review_id>-<n>`，`evidence_status=legacy_missing`，只允许查看与人工选择；
   结论上限 `NEED_CONTEXT`，不得宣称"精确修复已完成"。

混合清单是正常形态：结构化 finding 有 id，模型额外写的 issues 行没有 id/证据 → 后者保留为未链接项
（`id:''`，界面显示"缺少结构化证据"）。

**2026-10-23 修正（现场：`REVIEW_SELECTION_MISSING_FINDING`）**：旧实现有两个叠加缺陷，导致
9 条真问题 + 9 条同义重复的清单在默认全勾选时直接 fail-closed，整章反而无法精确修稿。

1. `structureReviewReport()` 的"额外 issues 行"去重只比较"派生行是否包含这一行的前 20 字"。
   模型同一条问题会写两遍（issues 散文 + findings 结构化），两处措辞几乎从不逐字相同，
   于是**每条被接受的 finding 都多留一条未链接项**，清单条数翻倍。现改为逐字前缀
   **或 2-gram 覆盖率 ≥ 0.25** 任一命中即视为重复（同义改写实测 0.33–0.57，不同问题 ≤0.13；
   <11 个 2-gram 的短行不做覆盖率判定，宁可保留也不吞掉真问题）。
2. 清单把未链接项也默认勾选。现规则：**结构化报告（有 findings）里的未链接项置灰、不勾选**，
   但仍显示在清单里并说明原因（重新审稿生成逐字证据，或手动修改）；没有 findings 的存量报告
   不置灰，继续走"可人工选择 + 结论上限 NEED_CONTEXT"的兼容路径。
   选择记录里若仍出现无证据项（旧选择、重试路径、DOM 篡改），映射闸门照旧 fail-closed。

因此"不会让整份报告不可用"现在由**界面默认值**保证，而不是由闸门放宽来保证。

## 5. fail-closed 的两道闸

| 位置 | 行为 |
| --- | --- |
| `refineByChecklist()`（付费调用之前） | `assertSelectionMappable()` 不通过 → 关闭弹窗、0 次付费请求、`toast` 报错误码与缺失 ID |
| `revisionFindingsFor()`（计划编译之前） | v3 报告映射不通过 → 抛 `REVIEW_ID_MAPPING_BROKEN`（调用方捕获并如实告知），不再静默退回 legacy |
| `PUT /novel/revision/selection`（服务端） | 选择与报告身份链不一致 → 409 + `code`；`review_hash` 不一致 → 409 `REVIEW_HASH_MISMATCH` |

## 6. 持久化与迁移（惰性、不覆盖原始 payload）

`chapter_reviews` 新增列（`db.js` 的 MIGRATIONS，幂等）：

```text
normalized_report_json     归一化视图（review.v3 / review.legacy）
normalization_version      归一化器版本
normalization_warnings_json 迁移告警
schema_version             review.v3 / review.legacy
review_hash                sha256(稳定序列化的 issues+findings)
```

`revision_selections` 新增 `review_hash` / `evidence_status`：把"这次勾选对应哪份报告"固化下来。
报告被改写后旧选择不能只凭"ID 还存在"通过。

原始 `report_json` **永不被覆盖**。读取时（`getLatestReview`）若没有归一化视图，就地迁移并回写视图列。

## 7. 断言

| 套件 | 覆盖 |
| --- | --- |
| `scripts/quality-auditor/verify-id-chain.mjs` | ID-01…ID-13（契约层：显式/同序/断链/重复/legacy/选择映射/重排/迁移纯函数） |
| `frontend-test.mjs`（34e–34h2） | ID-08/09/12/13 的 DOM 形态：复选框带 `data-review-issue-id`、显示 `issue.text`、结构不完整时按钮禁用、结构化报告里无证据项置灰且不默认勾选、存量报告仍可勾选 |
| `tests/narrative-repair/07-review-structure.test.mjs`（E03-g/E03-g2） | 同义改写的 issues 行不算额外未链接项；真正额外的问题仍如实保留 |

两者都在 `scripts/ci-offline-checks.mjs` 里，零计费。
