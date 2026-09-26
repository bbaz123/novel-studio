# novel-studio AI 内核（现状）

> 本文描述 **2026-09-15 P0–P6 重构之后**的 AI 内核。回答三个问题：现在长什么样、
> 数据怎么流、哪里还能改。
> 各阶段的验收证据见 `docs/p2..p5-*.md`；契约与不变量见 `docs/context-contract.md`。
>
> **引用约定**：本文只引用**模块与符号**，不引用行号——行号会随重构漂移，
> 而上一版文档就是因为写死行号在重构后集体失效的。

---

## 一、一张图

```
浏览器 SPA (public/app.js)
   │  提示词里插入的上下文文本，来自服务端装配器（不再由前端拼装）
   ▼
HTTP 服务 (server.js)
   │
   ├── ai/context/  ← 上下文装配内核（唯一实现）
   │     layers.mjs    层规格：14 层的 cap / kind / 收缩属性 / 查回路径
   │     assembler.mjs 装配器：预算内渲染、收敛收缩、裁剪清单、溢出标记
   │
   ├── ai/policy.mjs ← 模型与思考强度的唯一来源（档位 → 模型名）
   ├── ai/harness-env.mjs ← dsh 子进程环境契约（实例地址默认值 → 任务回连本实例）
   │
   ├── 两条 AI 通道
   │     直连（callAI / callAIStream，SSE）—— 秒级
   │     harness（harness.js → spawn dsh）—— 分钟级，带 novel_* 工具
   │
   └── 检索层（openviking*.js + server.js 的 search）
         OpenViking 语义召回 + 关键词检索（词条/章节/角色/剧情线/世界观/人物关系）
```

---

## 二、上下文装配内核

**为什么要独立成模块**：重构前「上下文」不是一个函数，而是**四条互不相同的装配路径**，
其中实际用来写正文的那条（前端 `aiContextBlock`）**完全没有预算**——
压力数据下同一章喂进模型约 7.4 万字，而受预算约束的路径只有 2.4 万字。

**现在**：服务端装配一次，两条路径共用同一段文本。

### 层规格（`ai/context/layers.mjs` 的 `LAYERS`）

14 层，分四类：

| 类别 | 含义 | 层 |
|---|---|---|
| `fixed` | 零损失层，**永不参与收敛收缩** | 作品、长期记忆、最近事件、未闭合伏笔、写作红线、（角色卡为 `entity`） |
| `flex` | 可被总预算压缩（按 `FLEX_ORDER` 顺序逐档） | 前文衔接、大纲、世界观 |
| `cond` | 条件层：数据缺失时整层不存在 | 语义召回、当前场景、本章蓝图、人物关系、相关设定词条 |
| `entity` | 正文边界由构建函数决定 | 出场角色卡（`buildCharacterCards` 的 5 级降级） |

**每个层都声明了「查回路径」**（`RETRIEVAL`）：被裁剪的内容用什么工具能取回原文。
这是「零损失」从口号变成断言的唯一方式——做不到查回的层，就不允许裁剪。

### 装配器（`ai/context/assembler.mjs`）

纯函数、零依赖、不碰数据库：数据由调用方按层给好，它只负责「预算内如何排布」。

产出（2026-09-24 起含身份/完整性/溯源三件，详见 `docs/context-contract.md` §八）：

- `text` —— 交给模型的分层文本
- `manifest` —— **逐层裁剪清单**：每层的原始长 / 采用长 / 渲染占用 / 被裁字数 / 溯源（`sourceIds` / `scores`）/ 查回路径
- `overflow` —— 压到下限仍超预算时的**显式标记**（不静默超限）
- `stats` —— 本次装配的规模摘要（含 `estimatedTokens`：**只用于横向比较，不参与预算/裁剪决策**）
- `contextId` —— 内容哈希（`sha256(text)` 前 12 位）：同一份上下文永远同一个 id
- `integrity` —— 清单与文字是否自洽的判定（C1–C8；PASS / WARNING / FAIL）。**WARNING 不等于通过**，
  它表示"现状可接受但有已知缺口"（如某个被裁的层暂时没有查回工具），必须一直看得见；
  FAIL 不拦截生成（拦截会改变真实用户行为），而是**响亮记录**：`error` 级日志 + 响应字段 + 验收断言
- `envelope` —— 本次装配的信封（身份 + 预算 + `selected` / `trimmed` / `excluded`），随两条端点下发

> 两条端点的响应字段：`context_id` / `context_request_id` / `context_integrity` / `context_envelope`。
> **不许重新引入无预算的兜底上下文**：提示词正文只有 `assembled` 一个来源；前端拿不到它会去
> 重新请求 `/api/novel/context`，而不是自己再拼一份（旧版那种拼法没有预算、也没有裁剪清单）。

### 预算

- 总预算 `TOTAL_BUDGET`：full/continuation/fragment = 26,000；settings = 19,000
- **可执行下限由 `computeFloor()` 自动核算**，不靠手写常量（历史失误：曾把 settings 预算设成
  12,000，而各层 cap 之和已超过它，收敛永远压不到）
- 当前下限：full **21,364** / settings **18,173**（2026-09-22：新增 `terms` 层后下限上涨，
  settings 预算随之上调到 19,000，详见 `docs/context-contract.md` §三）

---

## 三、模型与通道策略

`ai/policy.mjs` 是**唯一来源**：档位（`fast` / `quality`）→ 模型名、思考强度白名单、
工作台档位→强度表、以及归一化函数。

- 前端经 `GET /api/ai/policy` 取同一份策略（取不到时退回文件内的兜底常量，不阻塞启动）
- `harness.js` 的强度白名单也引用它（此前 `server.js` 与 `harness.js` **各有一份**）

`ai/harness-env.mjs` 是 dsh 子进程的**环境契约**，同样是单点：

- dsh 侧小说工具解析服务地址的顺序是 `NOVELSTUDIO_BASE_URL` → 插件安装时写死的
  `config.baseUrl`（3737）→ 默认 3737。所以任何**没有下发**该变量的调用点，在隔离实例上
  都会把 novel_* 工具打到**生产实例**。
- 修法不逐个调用点补丁，而是在唯一的 spawn 出口给一个等于**本实例**的默认值
  （调用方显式值仍优先）；生产端口 3737 下取值与历史逐字相同，属零行为变更。
- 离线单测见 `.p1-baseline/test-harness-env.mjs`（含变异测试目标）。

**有一条硬约束值得记下**：`agent-default-model`（含 `reasoningEffort`）**只存在于 dsh 的 settings 层、
且是进程级**；dsh 的 headless CLI 也没有任务级模型参数（`.p0-recon/headless.help.txt` 实抓）。

> **2026-09-16（D8-#2）更新**：以前只能靠改写全局 `~/.dsh/settings.yaml` 来切模型，
> 而那是全局副作用，所以 harness 任务必须**串行**——服务端允许 2 并发、**实际吞吐却只有 1**。
> 现在改走「**每任务一份补丁层** + `dsh --patch` 指过去」：不碰任何全局状态，
> 因此不需要互斥，吞吐回到 2。建立失败时**回退**到旧的全局改写 + 互斥路径，行为与历史一致。
> 证据：`.p1-baseline/exp-concurrent-models.mjs`（两个并发任务各自读到自己的模型、
> 全局 settings 逐字节未变、零计费）与 `.p1-baseline/test-task-settings.mjs`。
>
> **2026-09-24（DSH 0.1.7 适配）更新**：上报的那层从「重定向 settings 文档」换成「**直接覆盖
> `agent-default-model` 条目的 `config`**」——0.1.7 删掉了 `packages/settings/settings-file`，
> 旧写法静默失效（见 `ai/task-settings.mjs` 的 `buildModelOverridePatch`）。同一次升级里
> `settings.yaml` 变成**一次性导入**：启动时被改名成 `.imported`，各分节写进 profile 的
> `cordis.patch.yml`；但**启动带 `--patch` 且该补丁覆盖 `agent-default-model` 时这一节会导入
> 失败**（上游缺陷），而工坊几乎每个任务都带这种补丁。因此 `resolveDefaultSelection()` 按
> 「settings.yaml → profile 补丁 → `.imported` → 出厂默认」取值，并对"迁移还悬着"告警
> （`warnIfLegacyImportPending`）。
>
> **同一次升级的另一处硬变更（2026-09-25 才确认）**：`llm-deepseek` 的**线路协议换成了 Messages API**——
> `$DEEPSEEK_BASE_URL` 现在被当作 **Messages 兼容根**，适配器在其后追加 `/v1/messages`
> （官方根 `https://api.deepseek.com/anthropic`），不再是 OpenAI 形状的 `/chat/completions`。
> （依据：dsh 仓库 `packages/llm/llm-deepseek/README.md`「Endpoint and wire format」与
> `deepseek-official` 的默认根；实测把该变量指向本机假端点，请求行就是 `POST /v1/messages`。）影响：
> ① 生产不受影响——走的是 dsh 自带 provider，用户无需干预；② **自设**该变量的人必须指向
> Messages 兼容根，否则慢通道会 404；③ 本仓「零成本验证」的假端点必须同时实现两种形状，
> 否则慢通道的冷启动/工具循环测量会全部退化成「端点没收到请求」——`.p1-baseline/fake-llm.mjs` 已补上。

---

## 四、一次成文请求走过哪些环节

1. 前端取章节上下文：`GET /api/ai_context` → 服务端返回 `assembled`（预算内文本）+ 裁剪清单
2. 前端把 `assembled` 放进提示词（`aiContextBlock()` 直接采用；旧的前端拼装保留为兜底）
3. 走**直连流式**（`/api/ai/write_stream`）或**harness 慢通道**（`/api/harness/run` → 轮询）
4. 产出后：落草稿 → 红线扫描 → 结果弹窗 → 作者选择采纳/丢弃
5. 采纳/丢弃都会写一条**效果埋点**（`ai_eval_events`）

---

## 五、检索层

- **关键词检索**（`server.js` 的 `search`）：覆盖 设定词条 / 章节 / 角色 / 剧情线 /
  **世界观 / 人物关系**（后两者是 P3 新增的桶）
- **语义召回**（OpenViking）：top-8、阈值 0.3、每段截 300 字；结论进「相关记忆检索」层
- **模型侧查回入口**：`novel_lookup`（关键词）、`novel_memory_read`（长期记忆全文）、
  `novel_events`（事件账本）、`novel_foreshadows(status=all)`、`novel_style_contract`

## 六、运行宿主

后台任务跑在**专用 dsh profile `novel`** 上（不再是共享的 `headless`）。
插件 `harness-plugins/novel-writing/` 是一个**标准 dsh bundle**，profile 通过
`node_modules` 下的 junction 直接引用工坊仓库——**仓库即唯一来源，没有副本**。

用哪个 profile 由 `harness.js` 的 `NOVELSTUDIO_DSH_PROFILE` 决定；
切换步骤与回滚见 `docs/p6-cutover-runbook.md`。

慢通道与直连的真正差别不是延迟，而是**工具循环**（模型 → 工具 → 模型）：读回被裁层的原文、
写回记忆提案都要走它。零计费的实测证据在 `.p1-baseline/probe-harness-tool-loop.mjs`
（需 `NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`，自设假端点；断言含「工具结果里真的出现被请求的文件」，
所以"工具被策略拒绝、却照常回灌 tool_result"这种假通过过不了）。

---

## 七、怎么验证

```powershell
node .p1-baseline/verify-all.mjs        # 一键跑完全部验证并输出汇总表
```

它区分「未通过」与「跳过」（缺活实例/外部仓库的检查标 SKIP，不伪装成通过）。
单条工具见 `.p1-baseline/README.md`。

> ⚠️ **它会花钱的检查默认不跑**。harness / dsh 相关路径会触发**真实计费调用**：
> 2026-09-15 曾因假定「`DEEPSEEK_BASE_URL` 指向死端口 = 零成本」而产生了未经批准的
> 真实调用（含一次写进生产记忆库）。现在这些检查需要显式授权，且套件最后一条是
> **总闸**——检出真实调用即判未通过。详见 `.p1-baseline/README.md` §六。
>
> **总闸（2026-09-25 起）不只看「有没有模型文本」，还要求逐条归属**：零计费探针用本地假端点
> 充当模型时转录形态与真调用相同，必须由端点自证（回环地址 / 实收请求数 ≥ 转录请求数 /
> 转录正文等于罐头正文 / 时段重叠，四缺一即红灯）；**归属不了的文本会话仍然是红灯**。

**改这个内核时的两条纪律**：
1. 层规格只在 `layers.mjs`、模型名只在 `policy.mjs`——不要在业务代码里重新内联。
   工具会扫描源码把绕过策略的字面量报出来。
2. 改完**必须重抓基线并与旧基线对照**（`capture-baseline.mjs` → `compare-baseline.mjs`），
   任何差异都要能解释。

---

## 八、已知缺口（诚实清单）

| 缺口 | 影响 | 归属 |
|---|---|---|
| 长期记忆仍会随章节线性膨胀（`mergeMemoryDraft` 是文本拼接） | 中段内容进不了上下文（但可用 `novel_memory_read` 查回）；**压缩提示链路本身此前是断的**（F6：提示拼在层末尾、被自己截掉），已于 2026-09-15 修好；自动压缩开关默认关闭 | **护栏已就位**（D8-#3，2026-09-16）：按用户规格分**两侧**——① **出场过的**（主角+配角，含别名变体）一个都不许丢，违反即**拒绝落库**；② **从未出场的**若被提及，**默认放行但如实记日志**（用户明确要"根据剧情需要出现"可直接放行），需严格时设 `NOVELSTUDIO_COMPRESS_STRICT_NO_INVENTION=1`。实体集合由"章节正文里出现过没有"确定性推导（实测 #2：角色表 23 → 出场 6），提示词也**只喂出场角色**。**2026-09-20 用户规格：字数下限改为随作品规模自适应**——原先固定 100 字，长篇可以"名字全写上、事全丢光"照样过闸；现在下限 = `max(按篇幅分档[100→640], 按承载实体数[16字/个])`，封顶 **640**（刻意不超过下游提示词"不超过 800 字"的产出目标，两者是成对契约）。小作品仍是 100 字，不被长篇规则牵连。默认关闭；打开后章节落盘时超阈值自动建压缩作业。实测两次真实调用：模型为"≤800 字"任务实际产出 5.6k~22k 字（含推理，同样计费）。**D8-#3 续（2026-09-18）：模型自压缩那条路也接上了同一份判据**——此前只有服务端自动压缩受保护，而人设教的恰恰是「模型自行压缩后调 `novel_memory_update`」，那条路**没有护栏**；现在由纯判据 `needsAgentMemoryGuard` 决定是否设闸（作者手改 / `delta` 追加 / 提案路径都不设闸），被拒返回 **409 + 缺失名单 + delta 逃生口** |
| ~~语义召回层在不可用时整层消失~~ | ~~模型与作者都不知道「本该有一层召回但没来」~~ | **已解决**（D8-#5，2026-09-16）：期望有召回却没拿到时改发**显式占位层**，两个端点回传 `gap`/`gap_reason`，判据单点在 `layers.mjs` |
| ~~两条同步旁路（生成小说 / 记忆压缩）绕过作业设施~~ | ~~无进度、无取消、无落库、不计并发~~ | **已解决**（D8-#4，2026-09-16）：新增命名任务作业入口 `POST /harness/job`，两条路径与其它 AI 任务同构（进度/取消/落库/「可恢复任务」）；执行路径也从无进度的 `runHarnessTask` 改为带 `onChunk` 的版本。旧的同步端点保留供 API 兼容，**界面已不再使用** |
| ~~并发上限与串行现实不一致~~ | ~~服务端允许 2 个作业，界面路径实际吞吐 1~~ | **已解决**（D8-#2，2026-09-16）：改为每任务独立 settings（`dsh --patch`），不再有全局副作用 → 无需互斥 → 吞吐回到 2；建立失败时回退旧的全局改写 + 互斥。D4 的「等待模型槽位」显示保留为**回退路径**的安全网 |
| 缓存命中时的陈旧窗口 | ~~120s TTL，最多陈旧 2 分钟~~ | **已解决**（D8-#7，2026-09-16）：缓存版本纳入外部可观测状态，索引一完成**立刻**失效；TTL 退回纯兜底（10 分钟）。该信号是 **`app_settings` 里的键值对 `ov_indexed_at:<workId>`**（由 `openviking-sync.js` 的 `setAppSetting` 写入、`server.js` 的 `externalVersionOf` 读出）——**不是 `works` 表的列**（2026-09-20 核对真实库：`works` 无该列，`app_settings` 有 4 条该前缀记录；`.p1-baseline/probe-ov-indexed-at.mjs` 读的也是 `app_settings`） |
| ~~建作品/删作品的异步竞态留下孤儿记忆目录~~ | ~~生产记忆库 183 个孤儿目录~~ | **已解决**（D8-#6，2026-09-16）：`ai/sync-gate.mjs` 先举旗再排空、然后才删，并如实上报移除失败；**存量孤儿目录已按决策 D7 清理**（见下表） |
| ~~记忆库内容缺失~~ | ~~部分作品的语义召回层长期为空（`ov_indexed_at` 却声称已索引）~~ | **已解决**（决策 D3，2026-09-16）：两部作品全部重建，`work#2` ok/6、`work#9` ok/8，召回层真正进入 prompt。⚠️ 该信号（`app_settings` 的 `ov_indexed_at:<workId>`）**只表示"同步跑过"、不表示"记忆库真的有内容"**——P1 的 F7 正是这个坑（时间戳有值但目录不存在）；判"有没有内容"要看 `works.ov_uri` 指向的目录 |
| ~~记忆库里的**孤儿目录**~~ | ~~生产记忆库有 183 个目录（2,022 文件）在数据库里已无对应作品；占空间、干扰判读~~ | **已解决**（决策 D7，2026-09-16）：**先导出清单留档再删**——`.p1-baseline/d7-orphan-manifest-*.json`（删前）与 `d7-purge-result-*.json`（删后）；183/183 清完，剩 2 个活目录，**活目录逐文件 sha256 未变**（该留的一个字节没动） |
