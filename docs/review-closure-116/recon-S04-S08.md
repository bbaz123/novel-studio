# recon-S04–S08｜局部修稿闭环风险项现状核查（只读取证）

> 任务：在真实代码里判定 S04–S08 的**当前**状态（LOCAL_VERIFIED / already_satisfied / PARTIAL / MISSING）。
> 方式：只读 grep/read + 直接运行测试套件（绕开被沙箱 EPERM 阻塞的 `scripts/test-narrative-repair.mjs` 包装脚本）。
> 产出：本文件是本次任务唯一写入的文件；未改动任何业务代码、数据或密钥。
> 取证环境：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`（`public/app.js` 17942 行，`public/revision-patch.js` 1501 行，`public/revision-plan.js` 551 行）。

## 0. 本次实际运行的证据（直接跑套件，不经包装脚本）

| 命令 | 结果 |
|---|---|
| `node tests/narrative-repair/08-authorization.test.mjs` | 通过 **26 / 未通过 0** |
| `node tests/narrative-repair/05-revision-plan.test.mjs` | 通过 **19 / 未通过 0** |
| `node tests/narrative-repair/01-patch-protocol.test.mjs` | 通过 **65 / 未通过 0** |
| `node frontend-test.mjs` | 运行完成，含 `94K/94K2/94K3`、`116E-a…116E-m` 全部 PASS（见各条证据） |

结论：**没有"代码已修但测试没跑"的悬空项**；下述每条判定都能同时给出 file:line 与一个真实跑过的用例 ID。

---

## S04｜失败/空计划不得放宽成整章可编辑权限；`context_only` 与 `authorized_spans` 必须分离

**判定：LOCAL_VERIFIED（实现+测试+运行时证据齐备）；仅剩两处"潜在退化面"，本轮未改动**

### 已满足的行为（证据）

1. **编译失败不再"退回整章"，而是如实返回 null**，并由调用方在**付费之前**停下：
   - `public/app.js:11810-11814`：`catch (_) { /* 编译失败不得再退回整章目录 */ return null; }`
   - `public/app.js:11289-11300`：`if (!revisionPlan || authorization.authorized_span_count === 0) { … showRevisionUnresolved(…) ; return; }` —— **0 次付费调用**。
   - `public/app.js:11285`：`const authorization = revisionAuthorizationFor(revisionPlan);`
2. **空计划 → 空授权**（不存在"没有计划 = 整章可改"）：
   - `public/app.js:11826-11828`：无编译器时返回 `{ authorized: {}, authorized_span_count: 0, protected: [], context_only: [], scope_complete: false }`。
   - `public/revision-plan.js:384-400`：`scope_complete: hotspots.length > 0 && !incomplete`，无热点即 `false`。
3. **定位不到 → `needs_scope`；重复引用 → `ambiguous_anchor`**（如实举手，不自动放宽）：
   - `public/revision-plan.js:223`（`needs_scope`）、`public/revision-plan.js:213-220`（`ambiguous_anchor`）
   - `public/revision-plan.js:312-313`（`scopeIncomplete`）、`public/revision-plan.js:386`（授权表把两者都算成 incomplete）
4. **`context_only` 与 `authorized_spans` 确实是两套字段、两条渲染路径**：
   - 授权跨度（可改）登记在 `public/revision-plan.js:369-383`（`authorized[key].push(entry)`，`ops: ['replace','delete']`，带 `text`/`start`/`end`）。
   - 只读背景**明确不进授权表**：`public/revision-plan.js:394-397`
     `protected: []` / `context_only: []`，注释写明"sandbox 留空而不是把 protected_spans 误当上下文（那会把'不得改'读成'可读'）"。
   - 提示词里两者分开渲染：`public/revision-plan.js:420`（`【本次授权范围（只有下面这些跨度允许改，其余一个字都不许动）】`）vs `public/revision-plan.js:427-428`（`只读上文/下文（不要改、不要出现在输出里）`）。
   - 有条件时 Host 另发**不含 span_id** 的只读上下文块：`public/app.js:11588-11594`（`【相关段落（只读上下文，不是可改范围）】`），正文块由 `public/app.js:11712-11722` `revisionSpanContext()` 生成；执行器侧另有 `contextOnlySpanIds` 拒绝写入 `public/revision-patch.js:860-863`。
5. **"计划在手但 0 热点"绝不回退整章目录**：
   - `public/app.js:11576`：`const strictPlan = opts.plan !== undefined || opts.requirePlan === true;`
   - `public/app.js:11577`：`const catalogueAllowed = !strictPlan || planHotspots.length > 0;`
   - `public/app.js:11585-11587` + `11634-11636`：严格计划下 catalogue 为空，改为输出"本次没有任何被授权的可编辑跨度 … 不要输出任何 patch"。

### 覆盖测试

| 用例 | 断言点 |
|---|---|
| `tests/narrative-repair/08-authorization.test.mjs` **E01-3** | 定位不到 → `needs_scope` 且热点 0（不自动放宽到整章） |
| 同上 **E01-3b** | 该计划产出的授权表为空且 `scope_complete=false` |
| 同上 **E01-3c** | 计划缺失（`null`）同样只能是空授权 |
| 同上 **E01-3d** | 空授权时任何补丁都不通过（`out_of_scope`，正文逐字不变） |
| 同上 **E01-3e** | 部分可定位：授权表只含已定位 issue |
| `frontend-test.mjs` **116E-a** | 无唯一定位引用 → harness 请求数 **0**，且请求体不含 `【授权跨度（span_id` |
| `frontend-test.mjs` **116E-b** | 拒绝时如实说明，`整章重写` 只作为出口出现（不是自动行为） |
| `frontend-test.mjs` **116E-f / 116E-g / 116E-m** | 授权表按稳定编号给出；只读上下文只含热点所在段落；提示词里只有一套 `span_id` |
| `frontend-test.mjs` **94K3** | 失败后给作者的是显式选择，不是自动改写 |
| `tests/narrative-repair/05-revision-plan.test.mjs` **E05-a / E05-c / E05-d / E05-m** | 授权跨度=那一刻文字；`needs_scope`；无静默丢弃；无热点时提示词如实说明"不要改动任何文字" |

### 剩余缺口（需要代码改动才更稳）

- **Gap S04-1（低，潜在退化面）**：`buildAIRevisionPatchPrompt` 仍保留"未传计划 → 发整章目录"的旧分支。`public/app.js:11630-11632` 在 `catalogue` 非空时会输出
  `【授权跨度（span_id｜逐字原文，只能在这些跨度里改动）】…（本次没能从问题描述里定位到具体原句，因此给整章跨度；引用仍必须逐字相等）`。
  今天可达性只有"**没有**传 `opts.plan`"（`public/app.js:9540-9542` 的 probe 探测调用），而 probe 结果只用于体积估算、不下发也不执行；
  但代码里**没有任何强制**要求调用方传 `plan`。任何未来新增调用点只要漏传 `plan`，整章目录就会重新出现。
  建议：把 `strictPlan` 的默认从"未传即宽松"改成"未显式声明 `allowCatalogueWithoutPlan` 即严格"，或直接把该目录分支删掉只留 probe 用的极简估算路径。
- **Gap S04-2（低，注释残留）**：`public/app.js:11623-11626` 的注释仍在解释"没有可定位热点时保持整章目录（并如实说明）"，与 `strictPlan` 下的真实行为正好相反；`public/app.js:11689-11690` 的 `revisionSpanCatalogue` 注释同病。属 S08 同类"陈旧注释"，不改变运行行为。

---

## S05｜`runRevisionPipeline` 是否验证"issue 真被选中" ∧ "跨度/操作在该 issue 的 Host 授权内"；模型自报 `span:{start,end}` 不算许可

**判定：LOCAL_VERIFIED（双重授权已实现且已接线；模型自报 span 判死）；一处"授权表缺失时静默降级"的硬化缺口**

### 已满足的行为（证据）

1. **参数被接受并逐层透传，最终强制生效**：
   - `public/revision-patch.js:1391`：`function runRevisionPipeline({ snapshot, raw, selectedIssueIds, contextOnlySpanIds, chapterId, engine, gateOpts, authorization, expectedSchemaVersion, allowLegacy } = {})`
   - `public/revision-patch.js:1405`：`planPatchApplication(snapshot, decoded, { selectedIssueIds, contextOnlySpanIds, chapter_id: chapterId, authorization })` —— **不是透传后遗忘，而是真的传进校验器**。
   - 调用侧：`public/app.js:12295-12301`（`authorization: ctx.authorization || null`）、`public/app.js:9553-9560`（分段路径 `authorization: authFor()`）、`public/app.js:11405-11408` / `11409`（单请求路径）。
2. **第①重授权：`issue_ids` 必须真的在本次已选集合里**（缺失也拒绝，不放过）：
   - `public/revision-patch.js:876-882`：`const outside = p.issue_ids.filter((id) => !selected.has(id)); if (outside.length) failGroup(… OUT_OF_SCOPE …)`
   - `public/revision-patch.js:883-886`：`if (selected && !p.issue_ids.length) failGroup(… SELECTION_MISMATCH …)`
3. **第②重授权：该 issue 是否授权了这个确切跨度/原文/操作（"选中"≠"授权"）**：
   - `public/revision-patch.js:890-901`：`const missing = p.issue_ids.filter((id) => !(Array.isArray(table[id]) ? table[id] : []).some((e) => authorizationEntryMatches(e, resolved))); if (missing.length) failGroup(… OUT_OF_SCOPE …)`
   - `public/revision-patch.js:650-665`：`authorizationEntryMatches` —— `entry.ops` 限定操作类型；**有 HOST 登记原文时以 `entry.text === resolved.original` 为唯一身份依据**（刻意不让 `span_id` 单独放行，避免分片命名空间把 A 句授权用到 B 句上）。
   - `public/revision-patch.js:902-907`：授权表 `protected` 按区间相交拒绝。
4. **位置一律由 Host 授权表决定，模型自报 `span:{start,end}` 不构成许可**：
   - `public/revision-patch.js:803-816`：补丁带 `span:{start,end}` 且与声明的 `span_id` 偏移**互相矛盾** → 直接 `OUT_OF_SCOPE` 拒绝（注释明写"两者必须一致，否则无法证明改动落在授权范围内"）。
   - `public/revision-patch.js:817-827`：有授权表时 `resolveAuthorizedRange()` 只认**授权表登记过的同名条目 + 逐字相等 + 底稿内唯一**（`720-740`），其它一律 `OUT_OF_SCOPE`；`span` 字段的偏移**不被采信**。
   - `public/revision-patch.js:871-874`：`p.original !== body && p.original !== actual` → `ANCHOR_MISMATCH`，"不做包含式退让"。
   - `public/revision-patch.js:864-866`：跨度章号与本次授权章号不一致 → `OUT_OF_SCOPE`。
5. **依赖组原子化 + 单条/组合双门禁**：`public/revision-patch.js:912-915`（同组一条失败整组不进候选）、`1411-1413`（先门禁再写回）、`1464-1472`（组合核验，`verified` 只在单条与组合都干净且门禁可用时为真）。

### 覆盖测试

| 用例 | 断言点 |
|---|---|
| `tests/narrative-repair/08-authorization.test.mjs` **E01-0** | 授权体系是 Host 侧产物（`planAuthorization` 导出） |
| 同上 **E01-1** | 选中问题 A、补丁改未授权句 B → `out_of_scope` 且原文逐字不变 |
| 同上 **E01-1b** | 同一 issue 落在授权跨度上 → 正常应用（没有把正常路径一起拦掉） |
| 同上 **E01-1c** | **模型自造 `span:{start,end}` 不算许可**（Host 未登记一律拒绝） |
| 同上 **E01-1d** | 授权表 `protected` 范围不可被同一条 issue 越过 |
| 同上 **E01-3d** | 空授权表 → 任何补丁都不通过 |
| 同上 **E01-5 / E01-5c** | 授权跨度上的显式 `delete` 精确生效、边界外（含 CRLF/emoji）零字符变动 |
| 同上 **E01-5b** | 授权通过 ≠ 组合安全（组合门禁仍能抓到删光先行语，且不称"已验证"） |
| `frontend-test.mjs` **116E-f / 116E-l / 116E-m** | 授权表按稳定编号给出；整章编译的授权表在**片**底稿上仍精确生效；分片同名 `span_id` 指向另一句仍被拒 |
| `tests/narrative-repair/01-patch-protocol.test.mjs` **P11c** | 换勾选集合即新任务（幂等键含选择集） |

### 剩余缺口（需要代码改动）

- **Gap S05-1（中，fail-open 形状）**：`authorization` 缺省时**不报错，而是静默降级**成弱校验。
  - `public/revision-patch.js:817`：`} else if (opts.authorization) {` —— 传 `undefined`/`null` 时，位置改为采信模型自己的 `p.span_id`（经 `buildSpans` 解析）或 `p.span:{start,end}`（`843-859`），第②重授权（`890-908`）整块被跳过；此时只剩"issue 在已选集合里"这第①重。
  - 现实中确实存在这样的调用点：`public/app.js:5117-5121`（刷新后"接回进度"）构造 `ctx` 时**没有 `authorization`** → `public/app.js:12299` 传 `null`。该路径恰好靠 `public/app.js:12287-12291`（`expectV2 && mode!=='v2'` → 返回 null）兜住 v2 载荷，所以今天没有可利用的越权；但"协议模块本身允许无授权执行"这件事与 §6.3 的"双重授权"契约不一致。
  - 建议（最小改动）：`runRevisionPipeline` / `planPatchApplication` 在"期望 v2"的语义下对 `authorization == null` 直接 `fail-closed`（返回 `out_of_scope`/`authorization_required`），而不是继续用弱校验跑完。
- **Gap S05-2（低，错误码质量）**：`planPatchApplication` 在同组内多条失败时把 `errors[0].code` 当作整单 `error_code`（`public/revision-patch.js:916-918`），调用方看到的是"第一个错误码"，不做逐条归类。不影响安全结论（正文不变），只影响归因准确度。

---

## S06｜`locateFragment` 对重复原句必须报歧义，不得 `.find()` 静默取第一处；包含式匹配同样要判

**判定：LOCAL_VERIFIED（原缺陷已消除，逐字重复 100% 判歧义）；包含式分支尚有一条窄的"静默择优"残余**

### 已满足的行为（证据）

1. **先做全文出现次数核验，>1 直接判歧义——不再 `.find()` 取第一处**：
   - `public/revision-plan.js:108-113`：
     `// ② 唯一性核验：同一片段在正文里出现多次 → 定位歧义（绝不取第一处）` +
     `if (occurrences.length > 1) return { ambiguous: true, count: …, starts: … , fragment: frag };`
   - `public/revision-plan.js:70-74` 的头部注释明确记录旧实现是 `spans.find(...)` 取首处，并说明现在改为返回 `ambiguous`。
2. **只有 Host 显式给出唯一标识才认那一处**：`public/revision-plan.js:98-107`（`opts.span_id` 命中 `list.find(...)`，`host_given: true`）。
3. **精确句命中也需要"该片段全文唯一"才走得到**：`public/revision-plan.js:115-116` —— 到达这一行意味着 `occurrences.length === 1`，因此**逐字重复的句子不可能被 `.find()` 静默选中**。
4. **包含式匹配的取舍是显式的、且默认收紧**：
   - `public/revision-plan.js:117-124`：`containing` 只从 `sentence`/`paragraph` 里选，**最短优先、同长度优先句子**（注释说明"整段就是一句话时若让段落抢先，同一处文字会同时存在两个身份"）。
   - `public/revision-plan.js:125-137`：只有 `opts.widen === true` **且**命中 `sentence` 才放宽到整句；**跨句提及不放宽**。
   - `public/revision-plan.js:138-145`：否则**收紧到片段本身**（`start+rel … +frag.length`），`span_id = ${containing.span_id}~${rel}`。
5. **歧义如实上抛，不猜**：`public/revision-plan.js:207-221`（候选里任一歧义都会被记住，且"只有所有候选都歧义时才报 `ambiguous_anchor`"，即"换一个更长/更短但仍唯一的引文"仍可定位）。

### 覆盖测试

| 用例 | 断言点 |
|---|---|
| `tests/narrative-repair/08-authorization.test.mjs` **E01-2** | 同一句出现两次 → `locateFragment` 报 `ambiguous:true`（不是返回第一个） |
| 同上 **E01-2b** | 歧义进 `ambiguous_anchor`：不产生热点、不猜第一处 |
| 同上 **E01-2c** | Host 给出唯一 span/上下文标识时才允许改（且只授权那一处） |
| 同上 **E01-6 / E01-6d / E01-6e / E01-6f** | 散文「」提及放宽到所在整句；结构化 `quote` 保持片段精度；段/句等长优先句子（同一处不得有两个身份）；跨句提及不放宽到整段 |
| `tests/narrative-repair/05-revision-plan.test.mjs` **E05-a / E05-n** | 授权跨度=那一刻文字；跨句提及保持片段精度 |
| `frontend-test.mjs` **116E-f** | 计划登记为授权跨度、授权表按稳定编号给出 |

### 剩余缺口（需要代码改动）

- **Gap S06-1（低）**：`occurrences` 只统计**字面片段**的全文出现次数（`public/revision-plan.js:110`）。
  当片段以"独立成句"出现 **1 次**、同时又被**另一处长句包含**（例如正文 A 处 `他低下头。` 独立成句、B 处 `他低下头。然后…`），
  `occurrences.length === 1` 会走到 `public/revision-plan.js:115-116` 的 `list.find((sp) => sp.kind === 'sentence' && sp.text === frag)`，
  命中 A 处（首处）并**静默返回**。此时 B 处虽然"包含该片段"，却不会被当作竞争者。
  真正有歧义的"同一句话在两处"（B 处也独立成句）仍会被 `occurrences.length > 1` 拦住，因此这是被大幅收窄后的残余，而不是原缺陷复现。
  建议：把唯一性判据从"字面片段出现次数"升级为"**能作为独立句逐字相等**的跨度数 > 1 即歧义"（即先算 `list.filter(sp => sp.kind==='sentence' && sp.text===frag)`，长度 >1 直接 `ambiguous_anchor`），与此并列再统计包含候选数。
- **Gap S06-2（极低）**：`public/revision-plan.js:121-123` 的"最短优先"仍是确定性择优而非歧义上报；不过它只在**目标原文相同、候选跨度不同**时生效，且注释已说明该择优是为了消灭"段落/句子双身份"，属有意设计。

---

## S07｜重试预算必须**共享**并跨刷新/恢复存活（不能在 F5 后重置）

**判定：LOCAL_VERIFIED（已持久化、已回读、已由真实前端测试证明）**

### 已满足的行为（证据）

1. **不再每次进函数新建额度**：`public/app.js:11745-11756` 明确记载旧实现是 `createRetryBudget({ max: 1 })` 每次新建，并给出现在的落盘方案；`REVISION_RETRY_MAX = 1`、`REVISION_RETRY_KEY = 'ns_revision_retry_budget'`。
2. **键绑定"章号｜快照｜勾选集合"**（换章/换稿/换勾选=新任务才领新额度）：`public/app.js:11758-11764`。
3. **恢复时把已用次数读回来并传给预算**：`public/app.js:11765-11774`
   `const raw = localStorage.getItem(REVISION_RETRY_KEY); … if (obj && String(obj.key) === String(key)) used = Math.max(0, Number(obj.used) || 0);`
   → `const inner = E.createRetryBudget({ max: REVISION_RETRY_MAX, used });`
4. **取用时写回**：`public/app.js:11775-11784`（`take() { const r = inner.take(); if (r.ok) persist(); return r; }`，`persist()` 落 `{ key, used }`）。
5. **调用点确实在"格式重试之前"取额度**：`public/app.js:11412-11413`
   `const budget = revisionRetryBudgetFor(revisionRetryBudgetKey(revisionSnapshot, selectedIssueIds)); if (!patched && budget && budget.take().ok) { … }`
6. **协议侧支持"带已用次数恢复"**：`public/revision-patch.js:1281-1295`（`createRetryBudget({ max = 2, used = 0 })`，`spent = Math.max(0, Number(used) || 0)`，`toJSON()` 回吐 `{max, used, remaining}`）。

### 覆盖测试

| 用例 | 断言点 |
|---|---|
| `frontend-test.mjs` **116E-i** | 预算键绑定 `章号\|快照\|勾选集合`：同一个键只领一份额度（实测键 `302\|302@fnv1a:d40bbb51:34\|3,7`） |
| `frontend-test.mjs` **116E-j** | **刷新后重建预算读到已用次数**（`{first:true, used:1, remaining:0}`，再取即拒）——这是对 S07 最直接的证据 |
| `frontend-test.mjs` **116E-k** | 换勾选集合就是新任务：应当领新额度（`used_before_take === 0`） |
| `tests/narrative-repair/01-patch-protocol.test.mjs` **P11** | 预算共享且有界（2 次后 `budget_exhausted`，`used === 2`） |
| 同上 **P11b** | 跨刷新恢复沿用同一预算（`createRetryBudget({max:2, used:2})` 再取即拒） |
| `frontend-test.mjs` **94K2** | 运行时不变量：格式失败只做**一次**仅格式重试（同一授权范围，不叠成无限调用） |

### 剩余缺口（需要代码改动）

- **Gap S07-1（低，非本轮要求）**：这是**格式重试**额度。协议层还定义了 `ERROR_CODES.BUDGET_EXHAUSTED`（`public/revision-patch.js:51`）与调用方的 `budget.take().ok` 判定（`public/app.js:11413`），但 `refineByChecklist` 里没有对 `budget` 的 `limit/used/remaining` 做任何 UI 呈现，作者无法从界面看到"额度已用完"。不影响"跨刷新不重置"这一要求成立。
- **Gap S07-2（低）**：`localStorage` 写失败时只影响跨刷新共享（当次仍有界），注释已如实说明（`public/app.js:11754`）；未做"自检并告知作者"。

---

## S08｜是否还允许"失败 → 整章重写"自动回退；是否残留"失败回退整章重写"的陈旧注释；显式作者入口必须保留

**判定：LOCAL_VERIFIED（自动回退已彻底移除，作者显式入口保留）；注释层面 PARTIAL（3 处陈旧表述仍与代码相反）**

### 已满足的行为（证据）

1. **失败不再落到整章重写，而是停下并给作者显式选择**：
   - `public/app.js:11471-11477`：`// 修稿没有产出可用补丁：正文一个字都不动，也不自动扩大成整章重写。` → `showRevisionUnresolved(info, review, failReason, confirmed, selectedIssueIds);`
   - `public/app.js:11492-11511`：`showRevisionUnresolved` 的两个出口**都是作者动作**——`state.pendingLongTextRetry = () => { … return refineByChecklist(); }`（重试补丁）与 `state.pendingLongTextAltRetry = () => refineByFullRewrite({ info, confirmed: picked });`（整章重写按钮 `data-action="long-text-retry-alt"`）。
   - 其它失败/空产出的分支同样显式拒绝回退：`public/app.js:11429-11430`（空补丁=合法无修改，不回退）、`11442-11443`（全部被门禁拦下，不回退）、`11347-11352`（分段路径 applied=0 时停在原文）。
   - 入口处也拒绝把"没有可定位热点"当成整章编辑许可：`public/app.js:11289-11299`。
2. **作者主动发起的整章重写入口**（合法，必须保留）：
   - `public/app.js:11513-11517`：`* 整章重写修稿：**只能由作者的明确动作触发**（见 §6.6：它不是一个失败处理分支）。` + `async function refineByFullRewrite(payload)`
   - 唯一入口是模态按钮事件：`public/app.js:15953-15959` → `case 'long-text-retry-alt': … if (alt) await alt();`（`alt` 由 `public/app.js:11509` 装配）。
   - 分段路径的备选整片重写同理：`public/app.js:14280-14282`（`分段修稿的备选路径：整片重写。只在作者显式选择时走——**不自动回退**`）+ 装配点 `public/app.js:11331-11336`（`handler: () => refineLongTextFull(info, review, confirmed)`）。
   - 全文检索确认 `longTextRunTask('revision_full')` 只有 `public/app.js:14287` 一个调用点，且只在上述作者动作后才可达。
3. **协议层终态码不产生整章行为**：`public/revision-patch.js:38`（`失败码（§6.6）。任何一个都属于"不扩大范围、不自动整章重写"的终态`）、`public/revision-patch.js:1456-1458`（全被门禁拦下时 `status_note` 明写"未回退整章重写"）。

### 覆盖测试

| 用例 | 断言点 |
|---|---|
| `frontend-test.mjs` **94K** | **运行时证据**（不是源码正则）：修稿失败后请求数 2，`fullRewriteAsked === false` |
| `frontend-test.mjs` **94K3** | 失败后给作者的是显式选择（`pendingLongTextRetry` + `pendingLongTextAltRetry` 都在，文案含"正文未被改动"） |
| `frontend-test.mjs` **116E-b** | 拒绝时说实话并保留作者出口（`整章重写` 仅作为显式动作出现） |
| `tests/narrative-repair/01-patch-protocol.test.mjs` **E01-4c** 一族的相邻断言 | 新作业收到 legacy 时原文一个字符不动（不再走"包含式整段替换"） |

### 剩余缺口（陈旧注释——需代码改动，仅为可读性/可审计性）

以下注释**与当前代码行为相反**，会把后续审查者重新引向"这是自动回退"的错误结论：

| 位置 | 陈旧表述 | 实际行为 |
|---|---|---|
| `public/app.js:11556` | `且解析失败时回退整章重写（见 refineByChecklist）。` | `refineByChecklist` 在 `public/app.js:11471-11477` 改为停下并给显式选择 |
| `public/app.js:12246-12248` | `先按补丁解析，成功就返回改好的正文；否则返回 null（调用方回退整章重写）。` | 调用方不再回退；`12262-12264` 已就地纠正为"不再据此回退整章"，但同一段首行仍反向表述 |
| `public/revision-patch.js:12` | `④ **失败扩大为整章重写**：解析失败/全部未命中都会回退整章重写（…）。` | 该行是**历史缺陷清单**（模块动机），但读起来像当前行为；`public/revision-patch.js:38` 已是相反口径 |

> 说明：`public/app.js:10998-11009` 的 `buildAIRevisionPrompt` 仍是整章重写提示词，但只由作者显式入口可达，**不是**失败回退分支，属保留项。

---

## 汇总表

| 项 | 判定 | 关键证据（file:line） | 主要剩余缺口 | 主要测试 |
|---|---|---|---|---|
| **S04** 失败/空计划不放宽 + `context_only`/`authorized_spans` 分离 | **LOCAL_VERIFIED** | `public/app.js:11810-11814`、`11289-11300`、`11576-11587`、`11634-11636`；`public/revision-plan.js:223`、`213-220`、`394-397`、`420`、`427-428` | Gap S04-1：`public/app.js:11630-11632` 仍保留"未传 plan → 整章目录"分支（今天仅 probe 可达）；Gap S04-2：`public/app.js:11623-11626`、`11689-11690` 陈旧注释 | E01-3 / E01-3b / E01-3c / E01-3d / E01-3e；116E-a / 116E-b / 116E-f / 116E-g / 116E-m；94K3；E05-a / E05-c / E05-d / E05-m |
| **S05** 双重授权（issue ∧ span/op）+ 自报 span 无效 | **LOCAL_VERIFIED**（含 1 处硬化缺口） | `public/revision-patch.js:1391`、`1405`、`876-886`、`890-908`、`650-665`、`803-827`、`871-874`、`864-866`；`public/app.js:12295-12301`、`9553-9560`、`11405-11409` | Gap S05-1：`public/revision-patch.js:817` 在 `authorization` 缺省时静默降级为弱校验（`public/app.js:5117-5121` 正是一个无授权的调用点，靠 `12287-12291` 兜住）；Gap S05-2：`916-918` 只回传 `errors[0].code` | E01-0 / E01-1 / E01-1b / E01-1c / E01-1d / E01-3d / E01-5 / E01-5b / E01-5c；116E-f / 116E-l / 116E-m；P11c |
| **S06** 重复原句判歧义，不取首处 | **LOCAL_VERIFIED**（含 1 处窄残余） | `public/revision-plan.js:108-113`、`98-107`、`115-116`、`117-137`、`138-145`、`207-221` | Gap S06-1：唯一性只看**字面片段出现次数**（`110`），"独立成句 1 次 + 被别处长句包含"仍会静默命中首处（`115-116`）；Gap S06-2（有意设计）：`121-123` 最短优先 | E01-2 / E01-2b / E01-2c / E01-6 / E01-6d / E01-6e / E01-6f；E05-a / E05-n |
| **S07** 预算共享且跨刷新存活 | **LOCAL_VERIFIED** | `public/app.js:11745-11756`、`11758-11764`、`11765-11774`、`11775-11784`、`11412-11413`；`public/revision-patch.js:1281-1295` | Gap S07-1：额度用尽无 UI 呈现；Gap S07-2：落盘失败无自检告知 | 116E-i / 116E-j / 116E-k / 94K2；P11 / P11b |
| **S08** 无"失败→整章重写"自动回退；显式入口保留 | **LOCAL_VERIFIED**（注释层 **PARTIAL**） | 自动回退移除：`public/app.js:11471-11477`、`11429-11430`、`11442-11443`、`11347-11352`；显式入口：`public/app.js:11513-11517`、`11509`、`15953-15959`、`14280-14287`、`11331-11336`；协议层：`public/revision-patch.js:38`、`1456-1458` | 陈旧注释 3 处：`public/app.js:11556`、`public/app.js:12246-12248`、`public/revision-patch.js:12` | 94K / 94K3 / 116E-b；E01-4c 一族 |

**总体**：S04–S08 的**五项要求均已由当前实现在真实代码中满足**（没有 MISSING，没有需要重做的 PARTIAL），
只剩 5 个**可选硬化项**（S04-1 潜在退化面、S04-2/S08 陈旧注释、S05-1 缺省授权 fail-open 形状、S06-1 窄残余）与 3 个**非要求项**（S05-2、S07-1、S07-2）。
本次为纯只读核查，未改动任何业务代码；如要落硬化项，建议按 S05-1 → S04-1 → S06-1 → 注释（S04-2/S08）的优先级单独开改动任务。
