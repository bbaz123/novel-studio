# 接线修复：把"实现了但没启用"的能力接上（2026-10-08）

> 依据：本轮全仓审计（口径：**文件存在 → 定义处 → 调用点 → 关键分支可达**，四级缺一即判未启用）。
> 两批：`ce07b21`（第一批：死开关写入口 + 层带护栏）与紧随其后的第二批（正文级知识边界 + 注入遥测 + 台账订正）。
>
> **一条纪律先行**：「能启用」不等于「值得启用」。本文件先给**有用性判定**，再给接线；
> 对被判定为"不接线"的项，理由与反证一并写在这里，免得下一轮审计再把它们当成新缺陷报一遍。

---

## 一、本轮把失效类型分成了四类（这是这份清单的主要价值）

| 类型 | 判据 | 本轮实例 |
|---|---|---|
| **死代码** | 有定义、全仓无生产调用点 | `wrapAsData` / `verifyProtectedBlocks` / `annotateLayers` / `summarizeInjection` / `detectKnowledgeViolations` / `detectAuthorScopeLeaks` / `verifyBandCoverage` / `semanticItem` / `orderSemanticItems` / `renderPreflight` / `snapshotState` / `state-machine` 的迁移逻辑 |
| **死开关** | 有读取与消费、**没有任何写入路径** | `continuity_thresholds:<workId>`（唯一一例） |
| **半死开关** | 有写路径、**界面无入口**（作者在 GUI 里够不到） | `ov_recall_dedup` / `novel_index_enabled` / `library_index_enabled` / `memory_auto_compress` |
| **承诺缺口** | 文档已向作者承诺、产品不提供该能力 | `continuity_thresholds` 的"改数据即可、**不需要改代码**"（`docs/continuity-guard.md`、`docs/pending-decisions.md`、`docs/confirmation-resolution-2026-09-22.md`） |

> 第四类最危险：前三类是"写了没人用"，第四类是**让人按错误的前提做决定**。

### 排除项（避免误判为死开关）

`readWorkScopedSetting`（server.js）看似有成对的写入器，实际**只有读**；全仓 `setAppSettingDb` / `setAppSetting`
的每一处写入都是**硬编码键名**，不存在"写任意工作区设置"的通用端点。不对称证据：
`setContinuityExemptions` 存在，而 `setContinuityThresholds` 全仓不存在——所以 `continuity_thresholds`
确实是"只读开关"，不是"少搜了一个符号"。

---

## 二、判定表（有用性）

| 项目 | 判定 | 依据 |
|---|---|---|
| `continuity_thresholds:<workId>` | **有用｜必做** | 阈值本是作者口径（长短章合理值不同），代码默认值只是兜底；文档承诺可改而产品无入口 |
| `verifyBandCoverage` | **有用｜高** | 它存在的理由就是"带序表与层表脱节必须立刻可见"。接上后立刻报出 `LAYER_BAND` 停在 14 层而规格已到 18 层 |
| `detectKnowledgeViolations` / `detectAuthorScopeLeaks` | **有用｜高** | 预检 ⑦ 只看**契约**（动笔前），"成文里真写出了不该知道的事"只能**写后**判；此前无人判 → golden-novel 记为「漏报型空档」 |
| `annotateLayers` / `summarizeInjection` | **有用｜低风险** | 只挂元数据、**不改请求字节**；能把注入检测从"只扫 `story_state` 一层"扩到全层。模块头本来就写着这两个产物是"供日志与预检报告引用" |
| `wrapAsData` / `verifyProtectedBlocks` | **不接线** | 围栏会改写**每一个请求**的字节 → 属"改冻结装配"，需 A/B 与基线重冻；且 `verifyProtectedBlocks` 依赖一个**不存在的块模型**（`SYSTEM_RULES` / `WRITING_CONTRACT` 不是上下文层）。OBS-06 已按能力边界记载 |
| `renderPreflight` | **不接线** | 旧台账"插件另写一份渲染且删掉免责语"**已过期**：`novel-tools.mjs` 的预检渲染明确保留了"（预测而非事实：以上是风险提示，不是已经发生的事。）"。两处渲染各自可用，接线收益低 |
| `semanticItem` / `orderSemanticItems` | **不接线** | 服务于尚未落地的"语义检索层"；现在接上会造出第二套排序，违反"同一口径只准一份实现" |
| `annotateSemantic` | **暂不接线** | 会给 manifest 增 `semantic` 字段（契约扩张），收益仅"作者可读的带序说明" |
| `state-machine` 迁移逻辑 | **不接线** | 要接就得改编排层；收益（非法迁移可上报）与风险不匹配。注释漂移已订正 |
| `snapshotState` | **不接线** | 纯性能优化（归约重放）；仓库已注明"规模测试后再切"，改归约路径风险高 |
| `markProposalsStale` | **不接线（改标注）** | 更正：它**不是**被 `temporal/impact.mjs` 的 `markDownstreamStale` 取代——两者管的事不同（前者管**提案自身状态**，后者管**下游章节失效**）。它的目标场景目前由各应用路径**内联 UPDATE** 完成，所以它是"写了没接"的辅助函数 |
| 4 个半死开关的界面入口 | **有用｜下一批** | UI 改动面（前端 + frontend-test 断言）与前几项不同类，单独一批做 |

---

## 三、已接线（逐项）

### 第一批（`ce07b21`）

- **`continuity_thresholds` 写入口**：`server.js` 新增 `setContinuityThresholds()` + `POST /api/novel/continuity_thresholds`。
  只白名单判据真正消费的两个键（`plotlineStallChapters` / `systemMentionMax`），只接受 >0 整数——
  与 `ai/continuity-guard.mjs` 的"`Number(x) > 0` 才算覆盖，否则回默认"**同一口径**；
  作者通道专用，模型通道 403（`isAgentRequest` 是逐端点判断，不是全局护栏）；
  回传**清洗后**的实际落库值，而不是一个假的 ok。
- **`verifyBandCoverage` 接线**：接进 `.p1-baseline/verify-layer-constants.mjs` 的 **E 组**（正反两向：
  每层都要有归属、带表不得残留规格中已不存在的层）；同时补上 `LAYER_BAND` 缺的 3 层归属。

### 第二批（本批）

- **正文级知识边界接进写后校验**：`ai/story-state/index.mjs` 的 `validateOf()` 在既有
  `conflicts`（时间线泄漏 / 顺序倒置 / 别名冲突）之后追加 `detectKnowledgeViolations` 与
  `detectAuthorScopeLeaks`，经 `classifyConflict` 归一化。**只报告不阻断**。
  它随 `/api/novel/state/validate` 与 `novel_validate` 工具自动生效（插件的"一致性问题"段）。
- **注入遥测接进装配**：`server.js` 的 `buildNovelContext` 在装配前对**全部层**跑
  `summarizeInjection(annotateLayers(...))`，命中时记一条 `prompt_injection_scan` 日志
  （高危 warn / 其余 info）。**用副本计算**，组装结果与请求字节零变化；围栏仍按 OBS-06 待定。

---

## 四、验证

| 验证 | 结果 |
|---|---|
| `node --check`（server.js / index.mjs / semantic-context.mjs / state-machine.mjs / verify-layer-constants.mjs / api-test-suite.mjs） | 全部 exit 0 |
| `.p1-baseline/verify-layer-constants.mjs` | **12 / 0**（原 10 / 0；E 组两条） |
| 护栏**正例**（证明判据是活的） | `verifyBandCoverage([... , '不在带表里的层'])` → `ok:false, LAYER_WITHOUT_BAND` |
| 旧表陈旧的**反证** | `git show <ce07b21^>:ai/story-state/semantic-context.mjs` 中 `library:` / `edit_rules:` / `author_intent:` 一条都没有 |
| `api-test-suite.mjs`（隔离实例） | **196/200 通过、0 失败、4 跳过**（跳过项为会写到隔离目录之外的 M26–M29）；新增 F18–F21 全部 PASS |
| `.p1-baseline/test-story-state-api.mjs`（隔离实例 3739） | **77 / 0 / 0**；新增 `S14f`（正例）与 `S14f-`（阴性对照）均通过 |
| `scripts/ci-offline-checks.mjs` | **53 / 0**（单跑） |

> ⚠️ **假红经验（值得留档）**：把活实例测试与离线批次**背靠背**跑，会出现 52/53 —— 两次红灯还
> **不是同一条**（一次「方向驱动检索集成」、一次「闸门断言离线阴性对照」）。单跑即全绿。
> 这与 `docs/post-implementation-issues.md` 的 OBS-01 同源：同一时刻只允许一个活实例检查在跑。

---

## 五、仍留在清单上的接线项（诚实标注）

- 4 个半死开关的**界面入口**（`ov_recall_dedup` 优先：语义召回卡已有勾选框位置，省上下文预算；
  `memory_auto_compress` 会花钱，需费用提示；两个索引开关还需 rebuild 按钮）。
- `annotateSemantic` 的 manifest 字段（要动契约，需随 host-contract 一起改）。
- `wrapAsData` 的接线（要动所有请求字节，必须 A/B + 基线重冻，单独评估）。
- `NOVELSTUDIO_PROPOSE_MODE` 的清理（事件/记忆两条路径已被 `agentChannel` 强制提案取代）。

---

## 六、台账订正（旧报告里已过期的结论）

| 旧结论 | 现状 |
|---|---|
| `earliestOrderDifference` "零生产调用"（P1-12） | **已接线**：`server.js` 的章序版本切换处有真实调用 |
| `longTextCancelRun` "孤儿函数、无 data-action"（P1-08） | **已复活**：`public/app.js` 已有调用点，注释自陈"此前全仓无调用点" |
| `renderPreflight` "插件另写一份渲染且删掉免责语" | **已过期**：`novel-tools.mjs` 保留了"预测而非事实"那句 |
| `LAYER_BAND` "缺 3 层却称单测会报"（P3-07） | **本批闭环**：补 3 层 + 接上 E 组护栏（此前判据零调用点，所以"会报"是假的） |
| `markProposalsStale` 属"未接线原语"（P2-08） | **结论细化**：零调用点属实，但**不是**被 `markDownstreamStale` 取代（两者管的事不同），目标场景由内联 UPDATE 完成；已在源码注释里标注 |
| `state-machine` 注释提到 `nextPhase`（P3-07） | **本批订正**：该符号从来不存在，显式推进入口是 `advance` |

---

## 七、本批踩到并修掉的自身缺陷（留痕）

| # | 缺陷 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | 注入遥测写成**裸函数名**（`summarizeInjection(annotateLayers(...))`），而 `server.js` 只有 `import * as StoryState`、没有这两个顶层绑定 → `ReferenceError` 发生在**装配路径**上，后果是**整个 `/api/novel/context` 不再返回 `assembled`** | `.p1-baseline/test-story-state-api.mjs` 的 S1c/S2b/S2d 变红，且测试在 `ctx.json.assembled.includes(...)` 处 TypeError 崩溃 | 改为走门面 `StoryState.*`，并在源码注释里写明"必须走门面、裸名会 ReferenceError" |

**第 1 条暴露的真正问题不是拼写**：我"确认不抛"的那次验证打在了**模块门面**上
（`import('./ai/story-state/index.mjs')` 后直接调），而不是 server.js 里**真实的调用面**——
所以函数本身确实能用，接线处却必然崩。规则记在这里：

> 把某个函数接进**新文件**时，验证必须打在**真实调用面**上（跑活实例端点），
> 不能只验证"这个函数自己能跑"。"函数能用"与"它在这个文件里能跑"是两件事。
