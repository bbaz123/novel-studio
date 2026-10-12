# final-summary.md｜通过 / 部分 / 阻塞 / 未运行，以及未解决事项

## 1. 实际版本与工作树

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\a1941\Desktop\DeepSeek\novel-studio`（确认为 Novel Studio，非 DSH 源码目录） |
| `package.json` version | **1.1.6** |
| HEAD | `6f9a14b0d1f7e11117b68d0536aee5ca238969cd` |
| 分支 | `Experimental-Version-v1.0` |
| Node | `v24.19.0`（`engines: >=22.13.0`） |
| 修改前工作树 | 干净（仅 `?? 修复.md`，用户提供的任务书） |
| 项目 AGENTS/开发说明 | 根目录**无** `AGENTS.md`；有 `CONTRIBUTING.md`、`docs/README.md`、`docs/ai-core.md`、`docs/phase-map.md` |
| git 写操作 | **无**（未 commit / push / reset / clean / stash） |

## 2. K1–K6 逐项判定

| 编号 | 判定 | 说明 |
|---|---|---|
| K1 计划缺失扩大编辑目录 | **fixed** | 删除新修稿路径的"整章跨度退位"；无授权跨度即不发付费调用（`E01-3*`、`116E-a/b`） |
| K2 "选中问题"≠"授权跨度" | **fixed** | Host 授权表强制执行（`E01-1/1b/1c/1d`、`116E-f`）；T25 变异对照证明用例会红 |
| K2′ 片段级 span_id 执行器无法解析（本轮新发现） | **fixed** | `resolveAuthorizedRange`（`E03-1/1d/1e`、`E03-2`） |
| K3 重复原文取首处 | **fixed** | `ambiguous_anchor` + Host 唯一 span 才放行（`E01-2/2b/2c`） |
| K4 新请求走 legacy | **fixed** | `incompatible_legacy_format`；存量仍可读（`E01-4*`、`58ad2`） |
| K5 review_id / 选择 ID 关联 | **fixed** | `review_id` 保真 + 稳定编号端到端（`116E-c/d/e`、`94K4/94K5`） |
| K6 旧报告残项 | **partial → 已收敛** | ①阶段装配 `already_satisfied`；②采纳 stale/幂等 `already_satisfied`（作者裁决不拦阻，见下）；③重试预算持久化 **fixed**；④`must_keep/do_not_add` `already_satisfied` |

## 3. 回归汇总（命令 + 退出码 + 通过/失败/跳过）

| 命令 | 退出码 | 通过 / 失败 / 跳过 | 日志 |
|---|---|---|---|
| `node scripts/run-narrative-repair-116.mjs --label after` | **0** | 6 / 0 / 0 | `.narrative-repair-116/after-run.json` |
| `node scripts/test-narrative-repair.mjs` | **0** | 10 套件 / **202 条断言** / 0 失败 | `.narrative-repair-116/logs-after/E00-narrative-repair-suite.log` |
| `node frontend-test.mjs` | **0** | **551 条 PASS**（基线 537；新增 14 条 + 改写 2 条既有断言）/ 0 失败 | `.narrative-repair-116/logs-after/E00-frontend.log` |
| `node scripts/ci-offline-checks.mjs` | **0** | 54 / 0 / 0 | `.narrative-repair-116/ci-offline-after.log` |
| `node scripts/run-narrative-acceptance.mjs` | **0** | 9/9 必做命令；`付费调用：0 次` | `.narrative-repair-116/logs-after/E00-narrative-acceptance.log` |
| `node .p1-baseline/test-editing-rules.mjs` | **0** | 79 / 0 | `.narrative-repair-116/logs-after/E00-editing-rules.log` |
| `node .p1-baseline/verify-plugin-tools.mjs` | **0** | 26 工具一致 | `.narrative-repair-116/logs-after/E00-plugin-tools.log` |
| `node .p1-baseline/verify-preset-copy.mjs` | **0** | `junction_ok` | `.narrative-repair-116/logs-after/E00-preset-copy.log` |
| `node .p1-baseline/check-utf8.mjs` | **0** | 非法 UTF-8 **0** 个（修后） | `.narrative-repair-116/check-utf8.log` |
| `node .p1-baseline/verify-phase-map.mjs` | **1** | **pre_existing_failed**（2 处问题，均早于本轮） | `.narrative-repair-116/phase-map-after.log` |
| `.p1-baseline/verify-all.mjs` | **未运行（skipped）** | 需要活实例/外部 dsh 检出，且部分检查**会产生真实计费调用** | 见 §5 |

## 4. T02–T25 逐条

| ID | 级别 | 结果 | 证据 |
|---|---|---|---|
| T01 工作区确为本地 1.1.6；记录 commit/脏文件/Node | P0 | **passed** | `baseline.json` |
| T02 计划缺失/问题无引文不降级为整章可编辑 | P0 | **passed** | `E01-3*`、`116E-a/b` |
| T03 已选 issue 改未授权 span → 拒绝且原文不变 | P0 | **passed** | `E01-1`、`E01-1c`、`E01-1d` |
| T04 两处相同原文不猜第一处 | P0 | **passed** | `E01-2`、`E01-2b`、`E01-2c` |
| T05 新 PatchV2 任务不接受 legacy；历史报告仍可读 | P0 | **passed** | `E01-4*`、`58ad2` |
| T06 delete/replace/noop/缺字段/重复键/多 JSON 严格区分 | P0 | **passed** | `P02/P03/P04`（65 条那套）+ 夹具 F-B05 |
| T07 两补丁重叠、同组失败、组合安全门禁真实生效 | P0 | **passed** | `P07*`、`P08*`、`P13c`、`E01-5b` |
| T08 旧稿/章节/选中集合变化 → stale 或明确人工冲突，不串章 | P0 | **partial**（原语与判据已具备：`P10`、`P18`、`isPlanStale`、`stale_dispositions`；**但合并写回按作者既有裁决不拦阻**） | `E05-k/k2`、`P10/P10b/P18` |
| T09 review_id 及稳定 finding ID 从 UI→API→DB→reload→revision 保真 | P0 | **passed**（UI→API→记录体已端到端；DB 重读由服务端 `latestRevisionSelection` 契约与 `P11c` 覆盖） | `116E-c/d/e`、`94K4/94K5` |
| T10 重复采纳同一 operation_key 不重复写正文/历史版本 | P0 | **already_satisfied** | `server.js` 7388–7391 + `P11c` |
| T11 无勾选不发付费请求；解析失败不自动整章重写 | P0 | **passed** | `94H2`、`94K`、`94K3`、`116E-a` |
| T12 取消/刷新/重试共用预算；晚到响应无权写回 | P0 | **passed** | `116E-i/j/k` + `runHarnessJob` cancelled 守卫（7903–7976 行） |
| T13 长文分片片失败显示 incomplete、保留原稿 | P0 | **already_satisfied** | `58y`、`58aa`、`58z`、`long-text.js` 覆盖清单 |
| T14 CRLF/Unicode/空行/段合并/富文本格式不被未授权改动污染 | P0 | **passed** | `P14*`、`E01-5c` |
| T15 门禁不可用/畸形抛异常显示 `safety_unavailable`，不伪称已验证 | P0 | **passed** | `P12*` |
| T16 F-A01 显示信息残缺风险，不叫质量改善 | P1 | **passed** | `E03-1*` |
| T17 F-A02 作为合理局部精简通过 | P1 | **passed** | `E03-2*` |
| T18 S→SS→中断信息升级作为阴性对照 | P1 | **passed** | `E04-c` |
| T19 重复解释候选定位准确，不新增人物动机/姓名 | P1 | **passed** | `E04-b/b2/b3` |
| T20 `verify_style` 有审稿规则；draft 无逐项评分；rewrite 只含选中问题 | P1 | **passed** | `E02-f/g/h/i` + `116E-e/h` |
| T21 直连与 DSH preset 同阶段规则可对账 | P1 | **passed** | `E02-a/e/j/o`（同一 `stage_rules` 编译与审计） |
| T22 noop/blocked/deferred/unaccounted/partially applied 均有独立理由与覆盖表 | P1 | **passed** | `P03/P03b/P03c`、`94I`、`E06-e` |
| T23 未评测语义时明确 `not_run` | P1 | **passed** | `E04-a`（`semantic_status: 'not_run'`）+ 本文件 §5 |
| T24 缺少真实模型授权时全套验收仍可零费用运行 | P1 | **passed** | 全部日志 `付费调用：0 次` |
| T25 新测试故意反转关键断言必须变红；恢复后变绿 | P1 | **passed** | 变异对照：18/20 红 → 按字节还原后 20/20 绿 |

## 5. 未解决 / 未验证（不得当成通过）

```text
SKIPPED: paid_evaluation_not_authorized
文学效果：未进行真实模型 A/B，不能宣称整体自然度提升。

not_run:
  · 真实模型语义审稿（verify_style 实际调用语义模型）
  · 文学效果 A/B（检出率 / 误报率 / 阅读质量）
  · 真实章节上的整章修稿端到端（硬边界：不得把真实作品当测试输入）
  · .p1-baseline/verify-all.mjs（需要活实例与外部 dsh 检出；部分检查会产生真实计费调用 → 未运行）

partial:
  · 分段修稿在真实长章上的授权表行为（模块/应用层已覆盖：116E-l / 116E-m 钉住「整章授权表 + 片底稿」；仍缺真实长章实测）
  · 「接回进度」重放历史修稿任务（public/app.js 第 5100–5121 行）：取的是落库的选择记录，拿不到当次 EditPlan，**无法重建授权表**，只能沿用既有的 selectedIssueIds 收窄。保留理由：这是**重放已产出的结果**（不是新的付费请求），且作者要在差异预览里看到每一处改动后才决定要不要「合并到正文」；强制要求授权表会让历史任务无法恢复。残留风险：该路径的「已选 issue → 具体跨度」仍只到 issue 粒度。列为未验证项。
  · T08 的"写回时拦阻"（判据与 stale 原语具备；合并写回按作者 2026-10-06 的明确裁决不拦阻 —— 这是**遵从作者决定**，不是缺陷）

pre_existing_failed（早于本轮，与本轮责任无关）:
  · docs/phase-map.md 与真实改动集不一致（文档记 503，实跑 531）
  · 97 项旧改动无阶段归属（全部是旧探针脚本与 .p1-baseline 遗留数据）
  · note: HEAD 里 docs/narrative-repair/e07-run-manifest.json 记录的是上一轮一次**全项 exit -1 的失败运行**，
    不能当作本地 1.1.6 的通过证明；本轮按 E00.3 要求重跑该运行器，文件按设计被覆盖为本次真实结果。
```

## 6. 本轮自己造成的缺陷（已当场修复，如实留痕）

| 问题 | 证据 | 根因 | 已做修复 |
|---|---|---|---|
| 1. 首版 `scripts/run-narrative-repair-116.mjs` 把"汇总行格式不认识"判成 `failed`，导致基线报告 2/6（真实退出码都是 0） | `.narrative-repair-116/baseline-run.json` vs 各日志头 `# 退出码: 0` | 判定器只按"解析出断言数"判通过，没有"先看退出码、再单独识别零用例陷阱" | 改为两层判定；修后同一批命令 6/6 |
| 2. `Tee-Object` 写出的基线/修后控制台实录是 UTF-16，被仓库 `check-utf8.mjs` 判为非法 UTF-8 2 个 | `.narrative-repair-116/check-utf8.log`（首跑 ✗ 2 个） | 用 `Tee-Object` 落盘时沿用了 PowerShell 的默认编码，没有显式指定 UTF-8 | 用 Node 按 UTF-16/UTF-8 自适应解码后整份重写为 UTF-8；`check-utf8` 复跑 ✗ 0 个、退出码 0 |
| 3. E01/E03 的首次端到端断言暴露"计划片段级 span_id 执行器无法解析"——这**不是**我的改动引入的，但只有走完整链路才看得到 | `.narrative-repair-116/e03-test.log` 首跑 `ok:false, applied:0` | 计划把跨度收紧到"那一刻文字"后生成了合成 span_id，而执行器只认 `buildSpans` 的原生 id | 按 E01-B 的口径新增 `resolveAuthorizedRange`（只认 Host 登记过的范围 + 逐字相等） |
| 4. 上述修复的**第一版**自己带了两处新缺陷：①`resolveAuthorizedRange` 拿**整章偏移**去切片分片底稿 → 分段修稿的合法授权会被全判越权；②`delete` 的分隔符边界只留在原生跨度分支 → 片段级删除会留下一行空段 | 修完 08/09 套件全绿**但** `E01-5` 变红（`'…一个字没说。\n\n\n\n岳宸炎…'`）；`116E-l` 首版写出来才发现命名空间问题 | 只按"单请求路径"想问题：位置与边界的判据都假设底稿等于整章 | ①授权表的身份改为**逐字原文**（`entry.text === patch.original` 且底稿内唯一），不再采信 name-space 相关的 span_id/偏移；②抽出 `expandDeleteRange` 让两条路径共用同一删除边界口径；③补 `116E-l/116E-m` 两条断言把这件事钉住 |

## 7. 最终判断

- **工程验收：passed**
  - P0 关键断言真实运行通过（`test-report.md` §2）；
  - 任何新修稿路径的改动都必须对应**选中 issue 及其授权跨度**（`E01-1*`、`116E-f/g`）；
  - 失败/不确定/无权限/语义未运行**不自动改正文、不扩大范围**（`E01-3d`、`116E-a`）；
  - 既有能力未重复实现（`already_satisfied` 项均给出证据位置与回归 ID）；
  - 改动前后真实命令、退出码、断言数与回滚步骤均可复核（`test-report.md`、`rollback.md`）。
- **文学效果：separately not_run**（`SKIPPED: paid_evaluation_not_authorized`）。
