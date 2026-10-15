# NSDSH · S00 基线冻结

> 本文件是《Novel Studio × DSH 架构优化实施计划》（NSDSH，S00–S18）的第一份交付物。
> 目的：让后续每一批改造针对**真实工作区**，而不是任何调研快照。
> 本文件的每一条都可在本仓库或本机复核；**未取得的 SHA / 未跑起来的检查一律如实标空或 BLOCKED，不编造**。

- 记录时间：2026-10-15
- 记录方式：只读（读源码 + `grep` + 既有文档 + 版本命令），未改动任何业务代码

---

## 1. 版本与来源清单

### 1.1 本仓库（Novel Studio）

| 项 | 值 | 复核命令 |
|---|---|---|
| HEAD | `b7919f75624c4e788fd3ffe916f2339ec8f04913` | `git rev-parse HEAD` |
| 分支 | `Experimental-Version-v1.0` | `git branch --show-current` |
| 根包版本 | `1.1.9` | `package.json` |
| 运行时依赖 | 无（零 `dependencies`） | `package.json` |
| Node 要求 | `>=22.13.0` | `package.json` `engines` |
| 时态内核版本 | `TEMPORAL_VERSION = 1.2.0` | `ai/story-state/temporal/index.mjs` |
| 宿主契约版本 | `HOST_CONTRACT_VERSION = 1.22.0` | `server.js` |
| 小说插件版本 | `0.17.0` | `harness-plugins/novel-writing/package.json` |
| 时态契约文档 | v2（2026-09-30，含 T7） | `docs/temporal-state-contract.md` |

### 1.2 本机工具链

| 项 | 值 |
|---|---|
| Node | `v24.19.0` |
| npm | `11.17.0` |
| SQLite（`node:sqlite`） | `3.53.3` |

> SQLite 版本必须实查、不按 Node 大版本猜：`node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; …SELECT sqlite_version()…"`。
> 3.53.3 高于 SQLite 官方 WAL-reset 修复线（3.51.3 / 3.44.6 / 3.50.7 回移），但**这是版本号事实，不是本机压测结论**。

### 1.3 上游 DeepSeek Harness（两个来源，**不要混为一谈**）

| 来源 | 位置 | 版本 | 提交 |
|---|---|---|---|
| **源码 checkout**（工坊 AI 写作实际使用的那份） | `..\deepseek-harness`（与工坊同级） | 根包 `@deepseek-ai/dsh-root@0.1.7-rc.1`，`packageManager: pnpm@11.7.0`，`engines.node: ^22.19.0 \|\| >=24.0.0` | `7e06df28146c8f9b14e6185d1cdb325f6b05951b`（`master`） |
| **全局 npm 安装**（DSH Web GUI 自己用的那份） | `C:\Users\a1941\AppData\Roaming\npm-global\node_modules\@deepseek-ai\dsh` | `@deepseek-ai/dsh@0.2.0-rc.2` | 不适用 |

**这处差异必须记住**：
- 方案稿（2026-10-14）记录上游 master 根包为 `0.2.1-alpha.2`、`pnpm@11.28.5`。**本机源码 checkout 是 `0.1.7-rc.1`**，与方案稿看到的不是同一个上游状态。
- `ai/task-settings.mjs` 的文件头明确写着"2026-09-24 迁移到 dsh 0.1.7"，即本仓库的 DSH 集成是**针对 0.1.7 写的**。
- `harness.js` 的目录解析顺序是 `NOVELSTUDIO_DSH_REPO` → 工坊内设置 → `DSH_HOME`（且必须含 `package.json`）→ 同级 `../deepseek-harness`。本机唯一命中的是同级的 `0.1.7-rc.1` checkout。
- 结论：**S11 vendor 的固定提交应取 `7e06df2`（0.1.7-rc.1）这一条与现有集成兼容的线**；把上游 master 当作"稳定升级目标"是错的。若将来要升级到 0.2.x，那是**独立的一次升级试验**，不能与状态可靠性改造互相绑架。

### 1.4 仓库内是否存在已 vendor 的 DSH

| 位置 | 状态 |
|---|---|
| `third_party/` | **不存在** |
| `runtime/` | **不存在** |
| `vendor/` | 只有 `README.md` + `models/bge-small-zh-v1.5-f16.gguf`（47.9 MB 向量模型），**与 DSH 无关** |
| `node_modules/` | 事实上为空：只有 3 个 pnpm 元数据文件，**没有 `@deepseek-ai` 作用域** |
| `.dsh-rc-compat/` | git 忽略的**侦察语料**（约 298 个 `@deepseek-ai/dsh-*@0.1.7-rc.2` 的 `.tgz` 与解包副本），**不是应用会启动的运行时** |

---

## 2. 改动前工作区状态

### 2.1 未提交改动（**全程保留，不撤销**）

```
M  README.zh-CN.md
```

`git status --porcelain=v1` 另有 20 个未跟踪 `.md`。其中 20 个已由阶段条目 `SE9` 认领，
**`novel-studio-dsh-optimization-plan.md` 未被任何阶段认领** —— 这会让
`.p1-baseline/verify-phase-map.mjs` 的【完整性】一项报红。本批 `NS0` 补齐该归属。

完整清单与 diff 见 `data/backup-nsdsh-s00-20261015183148/`。

### 2.2 备份边界

改动前备份已建立：`data/backup-nsdsh-s00-20261015183148/`
（含 `files/` 改动前副本、`uncommitted.diff`、`git-status.txt`、`HEAD.txt`、恢复说明 README）。
**刻意不含 `data/novel.db`** —— 该库含作者 API Key 与全部正文，复制它等于制造第二份敏感副本。

---

## 3. 方案稿 F01–F12 逐条核对（在本工作区仍是否成立）

核对方法：只读源码定位。结论分三类：**成立** / **成立但措辞需订正** / **不成立**。

| 编号 | 方案稿判断 | 本地证据（符号名，非行号） | 结论 |
|---|---|---|---|
| F01 | 时态调度使用进程内 Map / `setTimeout`，不具备数据库级恢复能力 | `server.js` `temporalAnalysisQueue = new Map()` + `scheduleTemporalAnalysis()` 的 `setTimeout`；`db.js` 中**没有任何**队列表 | **成立** |
| F02 | 队列已有同章节 key 时直接返回旧 timer，不是真正的 trailing debounce | `scheduleTemporalAnalysis()` 开头 `if (temporalAnalysisQueue.has(key)) return temporalAnalysisQueue.get(key)` | **成立** |
| F03 | 保存流程直接调用调度函数，事务内产生定时副作用 | 保存事务内 → `afterTemporalContentSave()` → `scheduleTemporalAnalysis()` | **成立** |
| F04 | 分析选择首个有 API key 的配置 | `temporalAnalysisConfig()`：`SELECT * FROM api_configs WHERE api_key IS NOT NULL AND api_key <> '' ORDER BY id ASC LIMIT 1` | **成立** |
| F05 | 提示词正文 ≤12,000 字符、状态 ≤400 项、名称 ≤200 个 | `extraction.mjs`：`EXTRACTION_LIMITS.max_chars = 12000`、`keys.slice(0, 400)`、`knownNamesFrom().slice(0, 200)` | **成立** |
| F06 | 提示词示例中的 scope 与实际允许集合不一致 | `extraction.mjs` 示例写 `"canon\|character\|reader\|world"`；`schema.mjs` 的 `SCOPES = canon, reader, character, author_plan` → `world` 非法、`author_plan` 漏。同一段提示词又单独列出了正确清单，等于给模型两份互相矛盾的指令 | **成立** |
| F07 | `input_hash` 是序列化载荷，已知实体输入未实际纳入 | `buildExtractionPrompt()` 返回的 `input_hash = canonicalJson({ text, state, known: knownLine('', []) })` —— 第三项恒为空串 | **成立（真缺陷）** |
| F08 | `resultHash` 基于输出前 2,000 字符 | `analysis.mjs`：`const resultHash = sha16(sanitizeText(output, 2000))` | **成立** |
| F09 | 兼容角色/关系投影按名称关联 | `compat.mjs` `refreshCompatProjection()`：角色 `UPDATE characters … WHERE work_id = ? AND name = ?`；关系用 `characters.name` 三表连接。temporal 侧 `cellKey = [domain, entityId, predicate, scope, holderId]` 里的 `entityId` 对角色就是**模型给的名字**、对关系是 `"A\|B"` 字符串 | **成立** |
| F10 | 就绪检测涉及特定包生成文件 | `harness.js` `isHarnessBuilt()` 只看两个文件：`packages/interaction/commands/lib/typert.host.js` 与 `packages/goal/goal/lib/typert.host.js` | **成立** |
| F11 | 小说插件仍保留部分通用文件工具 | 插件自身只注册 26 个 `novel_*`（无 shell/web/subagent）；但 **bundle 补丁** `cordis.patch.yml` 保留通用 `read/write/edit/glob/grep`（同时禁用 pwsh/web/subagent 等），**GUI preset** `agent.cordis.yml` 另加 `tool-fs` + `tool-fs-search` | **成立，但需订正归属**：通用文件工具来自 bundle/preset 组合，不是插件代码 |
| F12 | 浏览器与服务入口承担多种职责 | `server.js` 601,554 字节 / 10,155 行（S00 记录时 9,770 行，已增长），路由**不是**单条 `if` 链：`if (resource === …)` **117** 条，其中 `handleAPI` 只占 15 条，其余落在同文件另外 3 个顶层 handler 函数里（`router.` / `const routes =` 均为 0）；`public/app.js` 1,032,889 字节 / 18,223 行、一个扁平全局作用域、无构建步骤、约 64 个横幅注释分区 | **成立**（归属已订正，见 §3.1） |

---

### 3.1 逐条核对后的归属订正（2026-10-15，S02 用机器读数取得）

S00 的核对结论方向都成立，但有两处**措辞与实际结构不符**，S02 写行为表征时用机器读数发现并已就地改上表：

| 项 | S00 的写法 | 机器读数 | 订正后的口径 |
|---|---|---|---|
| F12 | 「路由是单条 `if` 链 `handleAPI()`」 | `if (resource === …)` 共 **117** 条；`handleAPI` 区间 42,773 字符、内含 **15** 条；另有 3 个顶层 handler 函数；`router.` / `const routes =` 各 **0**；`if (pathname ===` **1** | 路由是**单文件多 handler**，不是单链；「入口承担多种职责」这个结论不变，但"单链"会让人以为只需抽 `handleAPI` |
| D3 | 把 `HEAD_CAS_MISMATCH` 的语境写得像在 `service.mjs` | 该字面量只在 `ai/story-state/temporal/worldline-store.mjs`；`server.js` 零匹配 | 缺的是 **HTTP 处理点**；错误码由 worldline-store 抛出 |

**为什么订正顺序是"先订正 baseline 再重新生成 S00 报告"**：`baseline.md` 在 `stages.json` 里被列为 S00 的 `frozenArtifacts`。
本次订正让它与 S00 报告记录的摘指纹不符，`verifyPrerequisite('S00')` 会因此（正确地）报"冻结交付物被改动"。
处置不是把 freeze 去掉，而是**如实记录这次修订并重新生成 S00 报告**：
重新判定 S00 的三条验收项，写入新的摘指纹。这样"冻结"这条纪律仍然有效——它抓到了改动，而改动被审计留痕。

> ⚠️ 纪律：`frozenArtifacts` 不是"永不可改"，而是"**任何改动都必须显式记录并重新出报告**"。
> 直接手改文件而不重新生成报告，会让后续阶段的"前置证据"静默失真。

---

## 4. 方案稿未覆盖、本轮新增确认的缺陷（D1–D6）

> 这些是**读码证据**，其中 D1 为推断（已标注），必须在对应阶段先写复现用例再修。

| 编号 | 严重度 | 位置（符号名） | 现象 | 会怎样出问题 |
|---|---|---|---|---|
| D1 | 高 | `worldline-store.mjs` `commitManifest()` + `service.mjs` `finalizeValidGroup()` | HEAD 比较是"先读 HEAD → JS 比较 → **无条件** `UPDATE story_worldlines SET head_commit_id = ? WHERE id = ?`"；且 `parentCommitId` 为 `null` 时整段校验被跳过。**未用 `BEGIN IMMEDIATE`，属读后写竞态，本轮未并发复现** | 并发确认时后写者可能覆盖 HEAD；首个提交的 CAS 形同不存在 |
| D2 | 高 | `service.mjs` `applyChapterEvents()` | 事件先 `insertEvents()`，随后 `validateEventSet()` 失败时**返回对象而不抛异常** | 事务照常提交 → 孤儿事件行入库且无 binding 绑定，历史回放也看不到它 |
| D3 | 中 | `server.js`（`HEAD_CAS_MISMATCH` 零处匹配）；该字面量的**唯一定义处**是 `ai/story-state/temporal/worldline-store.mjs`（`service.mjs` 里没有它） | 该错误没有 HTTP 处理点 | 冲突以 500 而不是 409 返回，界面无法区分"输入已过时"与"服务端炸了" |
| D4 | 中 | `db.js` `MIGRATIONS` 数组 | 逐条执行、不包事务、只吞 `/duplicate column/i`；无 `user_version`、无迁移账本 | 中途失败留下"部分应用"的 schema，且没有任何记录可查 |
| D5 | 中 | `service.mjs` `confirmBinding()` | 重放路径（`binding.validity === 'valid'` → `{ reused: true }`）在任何输入/信任复核**之前**返回 | 上游已变时，重放请求仍拿到"复用"回执 |
| D6 | 低 | `docs/host-contract.v1.json` | 声明了 `NOVELSTUDIO_HARNESS_POOL`，但**代码从不读它**；`ai/harness-pool.mjs` 无任何生产接线（`verify-phase-map.mjs` 的注释也自陈"热备池未接线、无环境变量开关"） | 契约与实现漂移；文档承诺了一个不存在的开关 |

### 4.1 方案稿未发现、但现在就缺的能力

1. **保存回执不足以区分四种版本**：`POST /api/novel/chapter_save` 只返回 `{ ok, chapter_id, version_id, scan }`。
   不可变修订与 pending 提案确实在**同一事务**里写好了，但**不返回** revision id、pending 状态与事件水位 ——
   方案稿 §5.1 要求的"草稿 / 已保存修订 / 已完成分析的候选 / 已确认的正式状态"今天无法传达给前端。
2. **没有可恢复的领域事件流**：不存在 `/api/events`。现存的 SSE 只有两条 ——
   `GET /api/debug/stream`（调试追踪）与 `POST /api/ai/write_stream`（生成流），**都没有** `Last-Event-ID`、事件 uid/cursor 或补放能力。
3. **`projection_outbox` 不服务时态**：它只用于 OpenViking 投影（`enqueueProjectionInTx` 写入、启动时一次性 `drainProjectionOutbox`）；
   `ai/story-state/temporal/` 全目录对 `projection_outbox` **零引用**。
4. **启动时没有 pending 分析的 reconciliation**：`scheduleTemporalAnalysis()` 只在保存路径被调用；
   重启后 pending 提案仍留在 SQLite、可被接口看到，但**永远不会自动恢复分析**，只能靠作者手动发起。
5. **确认缺少调用方断言**：`confirmBinding()` 没有 `expected_revision_id` / `expected_binding_id` 参数，
   `input_snapshot_id` 也不与快照行核对（只比 `input_state_hash`）；审批是**可选**的。

---

## 5. 既有能力清单（不要重复建设）

| 能力 | 位置 | 说明 |
|---|---|---|
| 时态故事状态内核 T0–T8 | `ai/story-state/temporal/`（15 模块） | 不可变修订 / 类型化事件（强制 expected + 证据）/ 提交清单 / 章序版本 / main 世界线 / 保守全下游失效 |
| 时态测试 16 套 + 总入口 | `tests/temporal/01–16`、`scripts/test-temporal-refactor.mjs` | 含 T4 的 lease + fencing token、T5 时点边界与 POV、T7 存量迁移、T8 日志卫生 |
| 一次性作者审批 | `db.js` `author_approvals` + `ai/story-state/approval.mjs` | 单次消费由 `UPDATE … WHERE status='active'` 的行数裁决；TTL 30 分钟；按 op 绑定 baseline |
| 模型/作者双通道 | `server.js` `isAgentRequest` / `guardAgentWrite` / `requireAuthorChannel` | `x-novel-agent-token` = 进程内随机 32 字节；约 40 处模型侧 403 |
| 隔离配方 | `tests/temporal/harness.mjs`、`scripts/ci-isolated-run.mjs` | 临时数据目录 / 隔离端口 / 停用 OpenViking / 临时 peer |
| 门禁体系 | `scripts/ci-offline-checks.mjs`（唯一清单）、`.p1-baseline/verify-all.mjs`、`verify-phase-map.mjs`、`check-utf8.mjs`、`test-migration-idempotent.mjs`、`test-host-contract.mjs` | 阶段台账逐文件认领；契约四处互锁 |
| 前端既有防护 | `public/app.js` | `chapterPanelSeq` 切章竞态防护、`PANEL_VALIDITY_LABEL`/`PANEL_PROPOSAL_LABEL` 状态分离、IME composition 守卫、未保存草稿不被远端刷新覆盖、`_if_updated_at` 乐观锁 + 409 |
| 热备池（已写未接线） | `ai/harness-pool.mjs` + `ai/harness-sdk-worker.mjs` + `.p1-baseline/test-harness-pool.mjs` | 路由键 `provider\|model\|effort`、`maxWarm=2`、10 分钟空闲 TTL、一 worker 一任务；**无生产 importer** |

---

## 6. 方案稿 S00–S18 在本工作区的真实状态

| 阶段 | 真实状态 | 归属批次 |
|---|---|---|
| S00 冻结基线 | **本次完成** | NS-A |
| S01 隔离测试 / 阶段运行器 / 备份演练 | 未做（隔离夹具与门禁已存在，复用不重造） | NS-A |
| S02 复现风险并固定契约 | 未做（F01–F12 未系统化；D1–D6 为本轮新增） | NS-A |
| S03 渐进拆分入口 | 部分（`ai/repair`、`ai/story-state` 已模块化；`server.js` 仍单链） | NS-C |
| S04 持久任务 / 租约 / outbox / 恢复 | 未做 | **NS-B** |
| S05 稳定身份解析 + 迁移 dry-run | 部分（`ai/story-state/entities.mjs` 已有稳定 id / 别名 / 冲突分级 / merge·split 提案；temporal 从不用） | NS-C |
| S06 完整抽取 / 覆盖 / schema / 摘要 | 未做 | **NS-B** |
| S07 统一时点读取与投影 | **已做**（T5：统一 cursor + POV + 工具过滤 + 缓存失效） | NS-C 只补溯源与证据 |
| S08 领域事件流与前端闭环 | 部分（前端状态与竞态防护已有；缺可恢复事件流） | NS-C |
| S09 工具能力与作者权限 | 部分（审批 + 通道 403 + 边界测试已有；通用 fs 仍在） | NS-C |
| S10 统一 broker 与运行时接口 | 部分（`ai/policy.mjs` 单点 + `ai/task-settings.mjs`；时态分析绕过二者） | **NS-B** |
| S11 固定并内置上游基线 | 未做（已选定 vendor 路线，固定提交 = `7e06df2` / 0.1.7-rc.1） | NS-D |
| S12 小说专用 bundle / profile | 部分（`novel-writing` bundle + `install-profile.mjs` + `.p1-baseline/setup-novel-sdk-profile.mjs` 可派生 `novel-sdk`） | NS-D |
| S13 SDK 适配 / 会话隔离 / 取消 | 部分（热备池与 SDK worker 已写、已离线测试、**未接线**） | NS-D |
| S14 发行物裁剪与依赖闭包 | 未做 | NS-D |
| S15 全矩阵 / 跨平台 / 性能 | 部分（`perf-temporal-baseline.mjs`、`bench-context-build.mjs`、`bench-library-index.mjs`、`verify-all.mjs`） | NS-E |
| S16 迁移演练与灰度 | 未做 | NS-E |
| S17 清理旧桥接与上游维护纪律 | 部分 | NS-E |
| S18 最终验收与交付 | 未做 | NS-E |

---

## 7. 改动前门禁基线（实测 **54/54 全绿**）

> 纪律：**跑不动的检查标 BLOCKED，不标 PASS**；`SKIPPED ≠ PASS`。
> 本节数字来自**两次实跑**：第一次在受限文件沙箱内，第二次在管道 stdio 可用的环境下。差异已归因并复核。

| 命令 | 实测结果 | 判定 |
|---|---|---|
| `node scripts/ci-offline-checks.mjs` | **通过 54 / 未通过 0**（共 54 条，零计费） | **PASS** |
| `node .p1-baseline/verify-phase-map.mjs`（`--write` 后无参复跑） | 真实改动集 **607** 个文件、未归属 **0**；38 个阶段的存在性全在；可回滚性推导与声明全部一致；文档对账一致（78,545 字符 / 111,246 字节） | **PASS** |
| `node .p1-baseline/check-utf8.mjs` | 扫描 6525 个文本文件：非法 UTF-8 **0** 个，缺 BOM 的 `.ps1` **0** 个 | **PASS** |
| `node scripts/test-narrative-repair.mjs` | 通过 **17 / 17** 个套件（零计费） | **PASS** |
| `node frontend-test.mjs` | 在离线清单里作为「前端执行验证（vm + DOM 桩）」通过（8,082ms） | **PASS** |

### 7.1 第一次实跑为什么只有 37/54（已用第二次实跑证实归因）

第一次运行时本会话处于**受限文件沙箱**，该沙箱**禁止子进程使用管道 stdio**。
结果 37 通过 / **17 未通过**，17 条全部是"需要起子进程"的检查
（隔离实例、迁移幂等、时态总入口、回滚矩阵、快照 `--verify`、闸门断言阴性对照），
报错签名统一为 `Error: spawn EPERM … errno: -4048` / `exit=-1`。

当时用四条独立证据判定"是环境、不是回归"：

1. **报错签名统一**：例 `.p1-baseline/test-approval-boundary.mjs:69` 直接 spawn 服务进程即抛 EPERM。
2. **失败面与"是否需要子进程"完全重合**：需要 spawn 的全红，不需要的全绿。
3. **拿掉中间层即通过**：总入口 `scripts/test-temporal-refactor.mjs` 用 `spawnSync` 逐个跑子套件而失败；
   把其中 `tests/temporal/01-pure.test.mjs` **单独直跑** → `PASS 8 / FAIL 0`（退出码 0）。
4. **对照组通过**：完全不需要子进程的 `.p1-baseline/test-assembler.mjs` → 通过 32 / 失败 0。

另有 2 条不带 EPERM 字样、但同源：
`回滚矩阵工具自检`（阴性对照里 `git` 子进程被拒 → `exit=-1` → 工具报"区分不出来"）与
`全量快照工具离线测试`（2 条失败都在 `§6 --verify` 分支，该分支用 `execFileSync(process.execPath, …)` 起子进程）。

**该判定随后被实测证实**：在管道 stdio 可用的环境下重跑同一清单 →
**通过 54 / 未通过 0**；`verify-phase-map.mjs` 也从 `spawnSync git EPERM` 变为正常通过。

> **结论**：改动前的真实门禁基线是 **54/54 全绿**。第一次的 17 条红灯是执行环境限制，
> 现在有两次实跑 + 逐条归因作证据，**不再是"未验证项"**。
> 仍然成立的纪律是：受限环境下跑不动的检查要标 BLOCKED，**不得**标 PASS，也不得把 BLOCKED 说成全绿。

---

## 8. 执行环境事实（会直接影响验证可信度，必须记住）

1. **受限文件沙箱会禁止子进程使用管道 stdio**（现象依赖当前会话的文件策略，不是一个恒定事实）。
   在受限策略下，任何 `child_process.spawn/exec` 走默认 `stdio:'pipe'` 都会以
   `EPERM`（errno `-4048`）失败；`stdio:'inherit'` / `'ignore'` 与文件重定向可用。
   实测：受限时 `verify-phase-map.mjs` 直接抛 `spawnSync git EPERM`；
   **同一命令在 `danger-full-access` 下正常通过**（本文件 §7 的第二次实跑就是它）。
   - 受影响的门禁：`verify-phase-map.mjs`（内部要起 `git` 子进程）、以及所有"隔离实例"类检查。
   - 已有自保的脚本：`scripts/ci-offline-checks.mjs` 检测到 `status===null && error.code==='EPERM'` 时
     自动改用文件重定向重跑（见其 `runCheck` 注释）——但它只能救**顶层**那一层 spawn，
     救不了子检查自己再 spawn 出来的进程。
   - 处置：**先确认当前文件策略**。受限时，阶段台账类门禁与隔离实例检查必须在**普通终端**执行；
     跑不了就标 BLOCKED，**不得**标 PASS，也不得把 BLOCKED 当回归。
2. **不要把工坊服务跑在 Agent 的沙箱会话里**（2026-10-02 的 `spawn EPERM` 事故根因）：
   服务会继承会话的执行边界，导致 `harness.js` 启动 `dsh` 子进程失败。服务应在独立控制台窗口启动。
3. **真实数据目录是 `data/`**，含 API Key 与全部正文。所有测试必须走临时 `NOVELSTUDIO_DATA_DIR`
   或 `scripts/ci-isolated-run.mjs`；**任何情况下都不直接操作 `data/novel.db`**。
