# 小说工坊「上下文过长」完整优化方案（可行性复核 + 增删改版）

> 版本：v1.0（2026-09-13）
> 依据：聊天记录《小说工坊上下文过长优化》的分析结论 + 本次对当前环境/代码的逐项复核
> 需求确认：① 先出方案、确认后实施；② 所有生成路径都要覆盖；③ **只接受零损失优化**（不做有损摘要压缩）；④ 无硬性量化指标，明显改善即可；⑤ 作品规模：中规模（上百章、几百条设定/角色）；⑥ 按聊天记录痛点自行判断按需查询机制。

---

## 一、结论先行

聊天记录里的诊断**基本正确，至今有效**：当前一次「角色/配角生成」任务仍会携带约 24.5k 输入 tokens，其中约 68% 与写小说无关。三个方案的可行性判定：

| 聊天记录方案 | 判定 | 说明 |
|---|---|---|
| 第 1 步：DSH 侧瘦身（关掉无关工具/AGENTS.md/技能） | ✅ **可行，已逐项验证** | `disabled: true` 是 DSH 加载器官方支持的补丁语义；但**落点要改**（见 §4.1） |
| 第 2 步：工坊侧改按需召回 | ✅ **可行，需增删** | 硬伤仍在；另增加「提问轮轻量上下文」这一聊天记录没提的大头优化 |
| 第 3 步：修好 OpenViking 并接入生成路径 | ⚠️ **一半已过时** | 「接入生成路径」当前代码**已经完成**（语义召回层已在内核上下文里）；剩下的是修复服务本身 |
| 换本地模型读上下文、DSH 思考写作 | ❌ **删除** | 与「零损失」约束冲突；本地 embedding 检索（OpenViking）已是最优解，无需本地生成模型 |

**预期收益**：单轮输入 24.5k → 提问轮约 4–6k、成文轮约 8–12k（视设定库规模），多轮循环后续轮的大前缀命中 DeepSeek 自动缓存后费用再降约一个数量级。写作质量与记忆完整**零损失**——砍掉的都是无关内容，保留的核心层一字不动，被移出的背景资料全部可以通过 `novel_lookup` / 语义召回查回**原文**。

---

## 二、现状复核（本次实测，与聊天记录对比）

| 项目 | 聊天记录时的状态 | 现在的状态（2026-09-13 19:29 实测） |
|---|---|---|
| DSH 瘦身是否已做 | 未做 | **仍未做**：`~/.dsh/profiles/headless/cordis.patch.yml` 只有 persona + novel-tools，无任何 disable 项 |
| 工坊词条库全量 dump | 存在（60 条 × 400 字） | **仍存在**：`public/app.js:4884` 未变 |
| 语义召回接进生成路径 | 未接 | **已接好**：`server.js:1585-1592` 的 `buildNovelContext` 含「相关记忆检索」层（本次新增的升级） |
| OpenViking 服务 | 9/13 19:00 起挂掉 | **仍挂**：1933 端口无监听；根因是 `DeepSeek\data\.openviking.pid` 残留锁（PID 17584 已死） |
| 积压记忆 | 7 条 | **50+ 条**（`~/.openviking/pending/`，19:10 起持续积压，修复后需重放） |
| watchdog stop 脚本路径 bug | 存在 | **疑似已修复**：当前 `openviking-watchdog.ps1` 用 `$PSScriptRoot` 解析，仅需启动后验证日志 |
| API Key 泄露 | ov.conf 明文 | **仍未处理**：本次已定位 3 处明文 Key（见 §5.1），用户正在轮换 |
| headless profile 的 bundles | dsh-base + dsh-headless | 未变：`dsh-base` + `dsh-headless` + `@openviking/dsh-memory-plugin` |
| AGENTS.md 注入 | 16,070 字节 | 未变：`deepseek-harness\AGENTS.md` 仍为 16,070 字节，cwd 仍是 harness 仓库 |
| 当前数据规模 | — | 2 作品 / 6 章 / 27 角色 / 5 世界观 / 8 事件 / 3 剧情线（中规模预期下会持续膨胀） |

关键源码证据：
- `public/app.js:4876 genWorkContextBlock()`：`mode=full`（26,000 字分层上下文）+ 60 条 × 400 字词条库 + 全量人物关系 + 作者注——**每次调用原样重发**。
- `public/app.js:4931 runGenAskLoop()`：`turns=10` 多轮循环，`context` 在循环外只装配一次（好消息：轮间字符串一致，利于缓存命中），但**每一轮都全量携带**；首轮（提问轮）走 flash 直连**同样携带全量上下文**。
- `harness.js:88-104 resolveDshLaunch()`：headless 任务 cwd = deepseek-harness 仓库 → 触发其 AGENTS.md 注入。

---

## 三、聊天记录方案逐条可行性判定

### 3.1 第 1 步 DSH 瘦身 —— ✅ 可行（机制已验证，落点需改）

**验证结果**（本次实测）：
1. `@deepseek-ai/cordis-plugin-loader` 官方文档明确：`disabled` 条目 = "Stops the entry and prevents it from starting"。
2. dsh-base 组合文件头注释明确：**后写的层（含用户 profile 的 cordis.patch.yml）按 id 覆盖前面的 bundle 层，last write wins**。
3. 官方 `dsh-web-app` 已有成熟先例：用 patch 把 base 挂载的工具行 disabled。
4. 本次已从 dsh-base 的 `cordis.patch.yml` 逐一核对真实插件 id（清单见 §4.1，已修正聊天记录里的过时/错误 id）。

**需要修改的地方**：
- 聊天记录建议直接改 `~/.dsh/profiles/headless/cordis.patch.yml`——**该文件的创作区块由工坊 `install.ps1` 整段替换维护，升级即失效**。正确落点：改工坊仓库内的 `harness-plugins/novel-writing/headless-cordis.patch.yml`，再跑一次 `install.ps1`（或手动同步）。
- 聊天记录清单里的 `tool-str-replace-editor` 在当前 dsh-base 组合中**不存在**（当前版本文件编辑工具就是 read/write/edit，共 994 tokens）——从清单删除。
- 新增一条微优化：`session-title-llm`（每个 headless 任务会额外发一次标题生成小请求，对工坊毫无用处）——禁用。

### 3.2 第 2 步工坊按需召回 —— ✅ 可行，按下列方式增删

- **保留**：加 `mode=settings` 轻量装配；【设定词条库】改为按需 top-N；去重；提示模型可用 `novel_lookup` 查证。
- **新增（聊天记录没提、收益很大）**：`runGenAskLoop` 的**提问轮改用极简上下文**（只有作品标题/简介 + 用户请求）。澄清性问题根本不需要 26k 字设定，当前实现却每轮全量携带——这一项单独就能把每次对话的首次调用从 ~24.5k 降到 ~5k。
- **删除**：聊天记录里"改 `harness.js` 把 cwd 换掉"的备选方案——风险（dsh 启动/tsx 解析/插件相对路径）高于收益，直接禁用 `agent-instructions` 更干净。
- **修正**：聊天记录说"世界观词条在两层里重复"——需实施时用标题集合验证 terms/world_entries 的真实重叠再决定去重策略（不能盲删）。

### 3.3 第 3 步 OpenViking —— ⚠️ 拆成两半判定

- **修复服务** ✅：根因已精确定位 = 残留的 `.openviking.pid`（进程 17584 已死）。删除后按 `start-openviking.cmd` 启动即可；启动脚本本身已会清理残留 python 进程、固定数据目录，很健壮。修复后需重放 `~/.openviking/pending/` 的 50+ 条积压记忆。
- **接入生成路径** ✅ 已完成：当前代码的 `buildNovelContext` 已包含「相关记忆检索（语义召回）」层（预算 1400 字），`/api/ai_context` 也已携带 `semantic_recall.hits`。**只需把服务修好，召回自动生效**。
- watchdog 路径 bug：当前脚本已用 `$PSScriptRoot`，疑似已修复；降级为「启动后查 watchdog 日志验证」。
- 需要说清的一个认知：**OpenViking 本身不直接压缩提示词**。它的价值是让「按需召回原文」成为可能——正因为有它兜底，我们才敢把全量 dump 砍掉而不损失任何细节。

### 3.4 换本地模型读上下文 —— ❌ 删除

- 与「零损失」约束直接冲突：本地 LLM 把 26k 字摘要成 3k 必然有损（伏笔细节、口癖、红线词句恰是最先被压掉的），且每次生成都要跑一遍摘要（CPU 上数十秒级），还引入本地模型维护成本。
- **正确形态（且已经存在）**：本地只做 embedding 检索（OpenViking 内置 `bge-small-zh-v1.5`，512 维，零 API 费用、毫秒级），生成仍由云端 DSH 完成。这就是"本地读上下文 + DSH 思考写作"的无损实现——不需要再引入任何本地生成模型。

---

## 四、增删改后的最终方案（分 5 个阶段）

### P0 安全收尾（不涉及写作流程，建议立刻做）

1. **轮换 API Key**（用户进行中）：3 处明文 Key 全部换新——
   - `~/.openviking/ov.conf` → `vlm.api_key`（上次泄露的 `sk-8d56****c10f`）
   - `~/.dsh/.credentials.yaml` → `DEEPSEEK_API_KEY`（`sk-b33****3bce`）
   - `novel-studio/data/novel.db` 的 `api_configs` 表（`sk-a4a****b793`，可在工坊设置界面改）
   改完跑一次连通性测试确认三通道都恢复。
2. 顺手把 `ov.conf` 的 key 改为环境变量引用（若 OpenViking 配置支持；不支持则至少在文件头加注释提醒）。

### P1 DSH 侧瘦身（省 ~15k tokens/轮，零质量损失）

**改动文件**：`harness-plugins/novel-writing/headless-cordis.patch.yml`（工坊仓库内，随 install 持久化）

在现有 persona/novel-tools 区块后追加（id 已按当前 dsh-base 组合逐一核实）：

```yaml
# ── 小说写作 headless 专用瘦身：关闭与创作无关的通用能力（零写作质量损失）──
- { id: agent-instructions,      disabled: true }  # 不再注入 deepseek-harness 的 AGENTS.md（-4.1k）
- { id: tool-pwsh,               disabled: true }  # 最大的单个工具 schema（-1.1k）
- { id: tool-workflow,           disabled: true }
- { id: tool-subagent,           disabled: true }
- { id: tool-subagent-fork,      disabled: true }
- { id: tool-subagent-control,   disabled: true }
- { id: tool-subagent-list-agents, disabled: true }
- { id: tool-todo,               disabled: true }
- { id: tool-goal,               disabled: true }
- { id: tool-jobs,               disabled: true }
- { id: tool-ralph,              disabled: true }
- { id: plan-mode,               disabled: true }
- { id: tool-web,                disabled: true }
- { id: tool-skill,              disabled: true }
- { id: skill,                   disabled: true }
- { id: skill-filesystem,        disabled: true }
- { id: session-title-llm,       disabled: true }  # 省掉每次任务的多余标题小请求
```

**保留**：13 个 `novel_*` 工具（约 3.0k）+ `read/write/edit/glob/grep`（约 1.0k）+ persona + OpenViking 记忆插件。
**验证**：跑一次 headless 任务，确认工具集 = novel_* + 文件工具，任务提示里不再出现 AGENTS.md 内容，写作功能正常。
**回滚**：删除追加区块重跑 install.ps1 即恢复。
**风险评估**：headless profile 是工坊专用（install.ps1 维护），不影晌 DSH Web GUI 的编程会话（它们用其它 profile）。被关掉的都是写作任务用不到的能力。

### P2 工坊侧按需化（把"背景资料"从常驻改为按需查原文）

**改动文件**：`server.js` + `public/app.js`

1. **新增 `mode=settings` 轻量装配**（server.js `buildNovelContext`）：
   - 包含层：作品简介 / 长期记忆 / 最近事件 / 未闭合伏笔 / 出场角色卡（保底）/ 激活的世界观设定（关键词 top）/ 写作风格红线 / 相关记忆检索。
   - **排除层**：本章蓝图 / 前文衔接 / 当前场景（角色/设定生成不需要"当前这一章写到哪了"）。
   - 预算从 26,000 字收紧到 18,000 字（= 质量层全保底时的可执行下限：红线/角色卡/长期记忆/最近事件/伏笔等层不参与弹性收缩——novel_lookup 关键词检索覆盖不到长期记忆/事件账本，收缩即不可查回的真实损失；弹性收缩仍只作用于大纲/世界观）。
2. **`genWorkContextBlock()` 改三处**（public/app.js:4876）：
   - `mode=full` → `mode=settings`；
   - 【设定词条库】全量 60×400 → **关键词命中 top-12（400 字/条）+ 行末注记**："设定词条库共 N 条，已按关键词选取 M 条；其余可用 novel_lookup 查证原文"（零损失：查回的是原文，不是摘要）；
   - 与「激活的世界观设定」层做标题级去重（先实测 terms/world_entries 重叠率再定）。
   - 人物关系块加总长护栏（超出时截断 + novel_lookup 提示，当前数据量下不会触发）。
3. **提问轮轻量上下文**（public/app.js:4931 `runGenAskLoop`）：`forceQuestion` 首轮只带「作品标题/简介 + 用户最初请求 + 输出协议」，不带全量上下文；用户回答后的成文轮才带完整（瘦身后）上下文。
4. **persona 纪律微调**（headless-cordis.patch.yml 的 persona 第 1 条已有"缺少的设定用 novel_lookup 查证，查不到就明说，不编造"——保持不动，这正是按需查证的行为基础）。

**验证**：实际生成一个配角——① 输出格式/质量/一致性核对正常；② 日志确认输入 token 显著下降；③ 故意问一个冷门词条，确认模型会调用 `novel_lookup` 查到原文。
**回滚**：`git checkout` 两个文件即恢复。

### P3 修复 OpenViking 并确认召回生效

1. 确认无残留 openviking 进程 → 删除 `C:\Users\a1941\Desktop\DeepSeek\data\.openviking.pid`（残留锁，PID 17584 已死；**不要动** `vectordb\context\store\LOCK`——那是 LMDB 正常锁）。
2. 运行 `dsh-web-openviking\start-openviking.cmd /bind` → 轮询 1933 端口/健康接口至就绪。
3. 重放积压：`~/.openviking/pending/` 50+ 条（`drain-pending.py` 或等服务端自动重放）；观察 `data/openviking-pending.jsonl` 清空。
4. 验证：`GET /api/novel/semantic` → `healthy:true`；生成任务的任务提示里出现「相关记忆检索（语义召回）」层且 status=ok。
5. watchdog 验证：查 `~/.openviking/logs/watchdog.log` 无 "stop script not found"（如有再修）。

### P4 缓存命中与实测验收

1. **基线**：实施前跑一次角色生成，逐轮记录 `inputTokens / cacheReadTokens / outputTokens`（从工坊日志/会话 jsonl 提取）。
2. **实施后复测**：同样任务再跑一次，对比。
3. **缓存诊断**：多轮循环的轮间前缀（persona+工具+任务提示）应当逐字节一致。若 cacheRead 仍低：排查前缀不稳定源（session 标题请求、动态运行时上下文等）并固定之。DeepSeek 自动前缀缓存的 cache read 价格约为 input 的 1/10，命中后第 2~N 轮几乎只付新增部分。
4. **回归测试**：跑 `node harness-plugins/novel-writing/test/smoke.mjs`（23 项断言）+ 一次真实整章写作（红线扫描、一致性核对、提案入账全链路正常）。
5. **交付报告**：给出「优化前/后」的 token 与费用对照表。
6. （可选旋钮，不默认执行）`reasoningEffort: max → high` 可再省一部分思考 token，但可能影响写作质量——由用户后续自行决定。

---

## 五、对聊天记录中三个原始问题的直接回答

### 5.1 是不是 AI 调用额度变高了？
**是。** 输入 token 全量计费：24.5k/次只是"一次调用"；【提问】→【成文】多轮循环每轮重发（实际一轮对话 75k–100k 输入），缓存命中率仅 ~14%（新进程 + 前缀不稳定 + 模型切换）。输出 7,487 tokens 是生成内容本身，属正常开支。本方案 P1+P2 把固定开销砍掉约 2/3，P4 再把重复轮次的边际成本降到接近缓存价格。

### 5.2 OpenViking 有没有启用？
**没有。** 自 9/13 19:00 起因残留数据目录锁启动失败（锁已被定位，P3 修复）。另外要澄清：OpenViking 是**检索层**不是提示词压缩器——它不能直接缩短单次请求，但它让"按需查原文"成为可能，从而允许我们安全地砍掉全量 dump。当前代码的语义召回层已经接好，服务修好即生效。

### 5.3 换个本地模型读上下文、让 DSH 思考写作，可以吗？
**方向对，但实现方式不需要引入本地生成模型。** 本地 LLM 摘要 = 有损 + 每次生成都耗时 + 维护成本；而您的架构**已经内置**了无损版本：OpenViking 用本地 embedding（`bge-small-zh-v1.5`，零 API 费用）做检索，DSH 用云端模型写作。这正是"本地管记忆检索、云端管思考写作"的最优分工，把它修好即可，不需要再装任何本地大模型。

---

## 六、预期收益估算（按聊天记录实测 24,491 输入 tokens 为基线）

| 项目 | 优化前 | 优化后（估算） | 说明 |
|---|---|---|---|
| 通用工具 schema | ~9.9k | ~4.0k（仅 novel_* + 文件工具） | P1 |
| AGENTS.md 注入 | ~4.1k | 0 | P1 |
| dsh 技能目录 | ~1.3k | 0 | P1 |
| 提问轮任务提示 | ~10.4k（含词条库 8k） | ~0.5k（标题/简介+请求） | P2 |
| 成文轮任务提示 | ~10.4k | ~3–6k（settings 轻量层 + top-12 词条 + 召回） | P2 |
| **提问轮合计** | ~24.5k | **~5–6k** | |
| **成文轮合计** | ~24.5k | **~8–12k** | 第 2~N 轮大前缀再命中缓存，边际成本≈cache 价 |
| 写作质量/记忆 | — | **零损失**（核心层常驻不动；移出项可查回原文） | 约束保证 |

---

## 七、实施顺序与验收清单

实施顺序（确认后执行）：**P0（安全）→ P1（DSH 瘦身）→ P2（工坊按需化）→ P3（OpenViking 修复）→ P4（缓存验证与报告）**。每阶段独立可回滚，不必一次全上。

验收清单：
- [ ] 3 处 Key 已轮换，三通道连通
- [ ] headless 任务工具集 = novel_* + 文件工具，无 AGENTS.md 注入
- [ ] 生成配角/角色卡：输出质量、红线自检、一致性核对均正常
- [ ] 冷门设定可通过 novel_lookup 查回原文
- [ ] OpenViking healthy，语义召回层 status=ok，积压记忆已重放
- [ ] 冒烟测试 23 项通过 + 一次真实整章写作全链路正常
- [ ] 优化前后 token/费用对照报告（交付）

**需要说明的实施边界**：P1 需改写 `~/.dsh/profiles/headless/`（工作区外）与启动 OpenViking，届时会请求您的批准；P2 仅改动工坊仓库内两个文件。
