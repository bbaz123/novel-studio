# 去 AI 味第二轮：诊断层（2026-10-06）

> 依据《Novel-Studio_第二轮生成质量验收与优化方案.md》。第一轮（v1.1.2）解决的是**流程模板**——
> 按字数机械补字、按配额数场景、质检静默放行。第二轮不再扩大"反 AI 提示词"，而是补**诊断层**：
> 让审稿回答"为什么这一句值得出现在这里"，而不是"这一句像不像 AI 写的"。

## 1. 三条新诊断（只提示疑点）

| id | 阶段 | 提示什么 | 明确**不**做什么 |
|---|---|---|---|
| `diag_information_saturation` | verify_style | 某项信息已被强证据建立后，仍在用功能相同的细节继续证明 | 不规定"同一信息最多证明几次" |
| `diag_functional_redundancy` | verify_style | 句子不同、但承担完全相同的叙事功能 | 不只查重复句式；不设禁词 |
| `diag_negative_explanation` | verify_style | "没说 / 没问 / 没解释 / 没有别的"式短句连续替读者解释人物心理 | 不设禁词；只在明显重复时提示 |

另有 `diag_detail_function_density`（这个细节有没有第二作用）与 `diag_false_foreshadow`（是伏笔还是假神秘）。

## 2. deferred：待后续核验通道

疑似伏笔、未知等级、暂未解释的异常，**不判 pass 也不判 issue**，而是进 deferred：

- `verifyAIDraft` 与审稿报告的 JSON 契约都新增 `deferred`（`{text, type, recheck_within_chapters}`）；
- deferred **不计入 verdict**（它有内容时 verdict 仍可以是 `pass`），也不进入 issues / 修稿清单；
- UI 有独立分区展示（"待后续核验（不算问题，不会进入修稿清单）"），分段审稿合并时逐片带片号；
- 目的：不再出现"审稿器把疑似伏笔当问题删掉"，也不再用 pass/issue 强行表态。

## 3. 叙述资源与保护内容

- `scene_detail_budget`（偏好，蓝图 / 成文）：动笔前先定场景的主要功能，次要项可略写或跳过；**不设细节数量、字数比例或固定配比**。
- `protect_high_identity`（偏好，修稿）：修稿只做最小改动——删 / 合并低价值重复、去掉多余总结句；
  高辨识度段落（母亲从安慰自然转到"饭吃了没有"、父亲转账附言"吃饭"、王磊与岳宸炎的应答、系统落回早自习）
  保持原样，不改写成更完整、更煽情或更工整的版本。

## 4. 明确不做

- 不新增大批禁词（新问题是功能重复，不是词）；
- 不规定生活细节数量、不规定同一信息最多证明 N 次（有意累积会被误伤）；
- 不把 deferred 当问题立即修掉；不为了打破"冷静男主"强行让人物情绪爆发；
- 不全文重写：修稿优先 patch 式删除 / 合并 / 局部替换。

## 5. 落点

- `ai/writing/policy.mjs`（策略真源，版本 `2026-10-06.2`）/ `scopes.mjs` / `compile.mjs`；
- `public/app.js`：质检与审稿提示词、`verifyAIDraft` 三态 + deferred、`parseReviewText`、`showReviewReport`、修稿提示词的最小改动纪律；
- `public/long-text.js`：分段审稿合并 deferred；
- `harness-plugins/novel-writing/`：`novel_consistency` 自检三问 + deferred；两处人设；插件 0.17.0；
- 静态护栏：`.p1-baseline/verify-plugin-tools.mjs` 的去配额断言继续生效（新增文本不得引入配额或"自动续写补足"措辞）。
