# supplement-round-20261011.md —— 补充轮：S04-1 硬化 / S06-1 复核 / 陈旧注释清理

> 触发：作者在上一轮交付后说「开始执行」，授权动手实施我在 `final-summary.md` §9 与
> `execution-state.json` 的 `followup_recommendations` 里列出的剩余硬化项。
> 纪律照旧：**先写失败测试 → 最小修改 → 跑回归 → 留证**；不新增第二套实现；不动真实作品与数据。

## 0. 本轮做了什么（结论先给）

| 项 | 判定 | 结果 |
|---|---|---|
| **S04-1** 未传 plan 时默认也下发整章跨度目录 | **已硬化** | 默认严格；旧语义需显式 `allowCatalogueWithoutPlan: true` |
| **S06-1** 唯一性只看字面片段出现次数 | **复核后判定：不改** | 穷举未找到可复现缺口；尝试改动的实测代价是 **5 条既有断言变红**，已回退并写成反向确认断言 |
| **S04-2 / S08** 三处与行为相反的陈旧注释 | **已清理** | 改为与真实行为一致，并标注历史语境 |

回归：**11 套件 / 233 条断言全绿**，`frontend-test.mjs` **ALL PASS**（新增 4 条）；`data/` 与 HEAD 未变。

## 1. S04-1｜"未传 plan"不再是整章可编辑的默认

### 1.1 复现（改前真实行为）

`public/app.js` 的修剪提示词装配里，旧判据是：

```js
const strictPlan = opts.plan !== undefined || opts.requirePlan === true;
```

于是"**忘了传 plan**"被翻译成"宽松语义"→ 若没有可定位热点，就下发**整章跨度目录**
（`（本次没能从问题描述里定位到具体原句，因此给整章跨度；引用仍必须逐字相等）`）。
失败方向朝着放行，属 fail-open 形状。

**取证边界（不把结论说大）**：实测显示，只要**传了** plan，本函数历史上一律按热点收窄
（`onlyParagraphs` 生效，给出"已按本次选中问题收窄到相关段落"）；
而今天的两个调用点（`probe` 与 `prompt`）**都传 plan**。因此现场**没有**发生越权——
真正的风险是"**将来新增调用点漏传**"。

证据（临时探针，位于 `frontend-test.mjs` 内，已移除）：

```text
[PROBE94A] v2Article= "第一句写了很多东西…\n\n第二段：他站着没动。"
[PROBE94A] planHotspots= 0 coverage= ["1:needs_scope"]
[PROBE94A] prompt has 授权跨度 = false        # 传了 plan（无热点）→ 旧行为确实被 catalogueAllowed=false 挡住
[PROBE]    catalogue head: "【授权跨度…】（已按本次选中问题收窄到相关段落）…p2｜…"   # 传 plan 且有热点 → 收窄
```

### 1.2 失败测试（先红）

`frontend-test.mjs` 新增：

- **S04-1a**：不传 plan → **不得**出现"因此给整章跨度"。
- **S04-1b**：不传计划且无任何可定位热点 → 必须出现 `【本次没有任何被授权的可编辑跨度】`（不沉默、不整章放行）。
- **S04-1c**（阴性对照）：显式 `allowCatalogueWithoutPlan: true` 时才恢复旧语义。
- **94A2**：把"未传 plan → 整章目录"钉成**非默认**（防止以后被悄悄改回去）。

改前 S04-1a/S04-1b 为红（`{"marker":false,"header":true}` 证明整章目录确实被下发）。

### 1.3 修改（最小）

```js
// S04-1：默认从"未传 plan 即宽松"改为**默认严格**（失败方向不再朝放行）。
// 确实需要旧语义的调用方必须**显式**写 allowCatalogueWithoutPlan: true。
const strictPlan = opts.allowCatalogueWithoutPlan !== true;
const catalogueAllowed = !strictPlan || planHotspots.length > 0;
```

### 1.4 一处**必要的既有测试更新**（并说明为什么这不算弱化测试）

既有断言 `94A 修稿提示词下发授权跨度目录（span_id｜逐字原文）` **原先不传 plan**，
依赖的正是"未传 plan → 整章目录"这条宽松默认。硬化后它必然变红。

处置：**没有**删除或放松它的断言内容，而是把调用改为**显式 opt-in**
（`allowCatalogueWithoutPlan: true`），使"目录必须下发、且 `p1｜`/`p1s1｜` 成对出现"这一
**原意图逐字保留**；同时新增 `94A2` 独立钉住"默认严格"。即：
**旧契约改为显式表达，新默认由新断言守住**，两侧都有覆盖。

### 1.5 结果

| 用例 | 结果 |
|---|---|
| S04-1a / S04-1b / S04-1c / 94A2 | 通过 |
| 既有 116E-a…116E-m、94A 等 | **未回归** |

## 2. S06-1｜复核结论：不改（并留下反向确认）

### 2.1 上一轮的说法与我本轮的修正

上一轮 `recon-S04-S08.md` 的把关结论是：
> "独立成句 1 次 + 被别处长句包含"时仍会走 `list.find` 静默命中首处，属**窄残余**。

本轮**先穷举构造**（探针 `.narrative-repair-116/probe-s06-plural.mjs`），结论与那个说法**不同**：

| 输入 | 字面出现次数 | 精确整句跨度数 | `locateFragment` 结果 |
|---|---|---|---|
| `他低下头。` + `过了一阵，他低下头。` | 2 | 1 | `ambiguous:true, count:2`（**已被旧判据拦住**） |
| `他低下头。` + `他低下头，把手里的东西放下了。` | 1 | 1 | 精确命中 `p1s1`（正确） |
| `他低下头。` + `他低下头。他低下头。` | 3 | 2 | `ambiguous:true, count:3`（已被拦住） |

即：**"同一句真的出现在两处"的所有输入都已经被 ② 的字面出现次数核验拦下**；
而"片段是某句真前缀"的输入**本来就该精确命中那句**（shift 必为 0），不该判歧义。

### 2.2 实测：我按建议改了，代价是 5 条既有断言变红

我按 `recon-S04-S08.md` 的建议把判据扩展到"能装下该片段的候选跨度数"，实现为：

```js
const containingHits = [];           // 按 shift 扫描 sentence/paragraph 跨度
…  if (containingHits.length > 1) return { ambiguous: true, … };
```

实测代价（**回归**）：

```text
RED 05-revision-plan.test.mjs
   FAIL E05-f（通过条件）附录四个示范补丁都能进入计划候选…
RED 08-authorization.test.mjs
   FAIL E01-6   散文里的「」提及（不含句号）→ 授权跨度是**所在整句**…
   FAIL E01-6b  模型按整句写补丁 → 通过（这正是现场被误判 out_of_scope 的那一类补丁）— out_of_scope
   FAIL E01-6d  结构化 quote 保持片段精度…
   FAIL E01-6e  段落与句子长度相同时优先授权**句子**…
（断言从 227 → 221，5 条红）
```

**根因**：该形状里"`p1` 段**也**装得下这句话"会被计成第 2 个候选，而 `p1s1` 是**精确整句**、
应当 shift=0 命中——我的守卫把这条正常路径误判成歧义。

### 2.3 处置：回退，并把结论固化成断言

- 代码**回退**到原判据，并在原位写明：该扩展**没有可复现的真实缺口**，属以回归为代价的过度收紧。
- 新增两条断言把这个结论钉住，防止以后有人"顺手收紧"：
  - **T51-a2（表征）**：多候选跨度形状 → 判歧义，且注明**实际由旧的字面出现次数核验拦下**（count=3）。
  - **T51-d（反向确认）**：片段=某句**逐字整句**时 → 必须精确命中 `p1s1`，**不得**因"段落也装得下"被判歧义。
    这正是上面 5 条变红的形状，被单独固化为一条断言。

> **这一节是本轮最重要的记录**：一个"看起来更严格 = 更安全"的改动，实测会破坏已有的、
> 已验证的精确路径。**更严格不等于更好**；改动前必须看它是否会让既有正确行为变红。

## 3. S04-2 / S08｜三处陈旧注释

| 位置 | 原文（与行为相反） | 改为 |
|---|---|---|
| `public/app.js:11583` | "…且解析失败时**回退整章重写**（见 refineByChecklist）" | "…且解析失败时**不**回退整章重写：正文原样保留，把重试/整章重写作为**作者选择**给出" |
| `public/app.js:12279` | "先按补丁解析，成功就返回改好的正文；否则返回 null（**调用方回退整章重写**）" | "…否则返回 null 或失败对象。⚠️ 调用方**不再**据此回退整章重写" |
| `public/revision-patch.js:12` | "④ **失败扩大为整章重写**：解析失败/全部未命中都会回退整章重写" | 明确标注这是**当时**的缺陷清单，并写明"**该行为已在本模块落地时移除**，失败一律终态拒绝" |

第一处与第三处尤其重要：它们把读者重新引向"这是自动回退"的错误结论，而真实行为早已相反。

## 4. 回归与证据

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node scripts/test-narrative-repair.mjs` | 0 | **11/11 套件**（同进程回退） |
| 逐套件 `node tests/narrative-repair/<n>.test.mjs` | 0 | **233/233 断言通过**（227 + 6 新增） |
| `node frontend-test.mjs` | 0 | **ALL PASS**（新增 S04-1a/S04-1b/S04-1c/94A2） |
| `node .narrative-repair-116/probe-s06-plural.mjs` | 0 | S06-1 穷举取证（§2.1 表） |

日志：`.narrative-repair-116/closure-supplement-suites.log`

**本轮引入的回归**：1 次（S06-1 尝试改动 → 5 条既有断言变红）→ **已回退**，并用 T51-d 固化为反向确认。
**未修复的新失败**：0。

## 5. 未验证（沿用上一轮边界）

1. 真实模型文学效果 A/B → `SKIPPED: paid_evaluation_not_authorized`
2. `node scripts/ci-offline-checks.mjs`（54 项）→ `not_run(env_blocked)`：沙箱禁子进程管道 stdio（`EPERM`）
3. `api-test-suite.mjs` 的 HTTP 往返 → 同因 `env_blocked`
4. 6357/4000/5000 的本地口径复算 → 缺完整正文

## 6. 回滚

本轮只动 4 个文件（`public/app.js`、`public/revision-patch.js`、`frontend-test.mjs`、
`tests/narrative-repair/11-review-closure.test.mjs`），按 `rollback.md` 的同一套逐文件撤销即可；
`revision-plan.js` 本轮**净改动为 0**（改动已回退，仅留注释说明复核结论）。
