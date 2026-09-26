# DSH 0.1.7-rc.1 → 0.1.7-rc.2 兼容性矩阵

格式：`功能 × RC.1 × RC.2 × 状态 × 证据 × 风险`
状态词：**PASS / DEGRADED / BREAKING / UNKNOWN / NOT_APPLICABLE**。
所有"实测"行都是在隔离实例 + 假 LLM 下跑出来的（零计费），证据文件在 `novel-studio/.dsh-rc-compat/evidence/`。
RC.1 = `~/.dsh-novel` 的 0.1.7-rc.1 启动器；RC.2 = 全局 `@deepseek-ai/dsh@0.1.7-rc.2`。

| # | 功能 | RC.1 | RC.2 | 状态 | 证据 | 风险 |
|---|---|---|---|---|---|---|
| 1 | 小说工坊隔离实例启动 | PASS | PASS | **PASS** | `rt6/rt10/rt11/rt12/rt13/rt14` 全部 `✓ 隔离实例已就绪` | 无 |
| 2 | dsh 启动器 `--help`（插件真 apply） | exit 0 | exit 0 | **PASS** | `lib-diff-bin.txt`（`--help` 逐字相同）；`rt2-boot.txt` | 无 |
| 3 | 冷启动耗时 | 中位 3097ms | 中位 5866ms | **DEGRADED** | `rt4-timing.txt`（3 次：5730/5866/6060） | +≈2.8s/次；慢通道任务可感知，不改变内容 |
| 4 | 冷启动开销归因 | — | 关 opsec/account 仍 4795ms | **PASS（归因）** | `rt5-cause.txt` | 开销来自 RC.2 依赖树本身，不是新增插件 |
| 5 | profile 组合装配（`--dump-config`） | 97 条 | 99 条，**零 ID 删除** | **PASS** | `bundle-id-diff.txt`、`dumpconfig.diff` | 新增 `llm-deepseek-account`；`llm-deepseek`→`llm-deepseek-api-key` |
| 6 | 模型可见工具集合 | 32 个 | 32 个（**逐字相同**） | **PASS** | `rt3-toolnames-rc1/rc2.txt`（哈希一致） | 无 |
| 7 | `novel_*` 工具注册+调用 | 23 个，真调用成功 | 同 | **PASS** | `rt3-toolloop.txt`（结果含作品标题） | 无 |
| 8 | MCP 桥注册（openviking） | 第 2 轮出现 15 个 `mcp__openviking__*` | 同样 15 个，名字相同 | **PASS** | `rt3` 原始 dump | 首轮不可见（既有异步行为），两版一致 |
| 9 | MCP 工具"能被模型看到"的时机 | 静默出现（messages=3） | 多一条 `tool_addition` 通告（messages=4） | **PASS（增强）** | `rt3` dump 逐字段比对 | RC.2 多一条 system 消息（约 1KB 以内） |
| 10 | MCP 工具真实回调 | 未测 | 未测 | **UNKNOWN** | — | 需真实模型或脚本化多轮工具调用才能证明 |
| 11 | Memory 写入（session/event → OV） | `message_count=2` | `message_count=2` | **PASS** | `rt10/rt11` 的 OV session 查询 | 无 |
| 12 | Memory commit/抽取 | `commit_count=0` | `commit_count=0` | **两版一致，绝对能力 UNKNOWN** | `rt11-memory-commit.json`（阈值降到 1000、提示词 4102 字仍为 0） | 既有特性，非版本差异；长篇记忆要靠工坊侧链路 |
| 13 | Memory 跨 session 召回（`<openviking-context source="recall">`） | 未出现 | 未出现 | **两版一致（UNKNOWN 绝对能力）** | `rt10/rt11` dump | 与 12 同源：没有 commit 就没有可召回记忆 |
| 14 | Memory 插件版本约束 | 0.5.3 peer 范围含 rc.1 | 同范围含 rc.2 | **PASS** | `package.json` peerDependencies | 无版本闸门，不会自锁 |
| 15 | 长文本输入（argv 28k） | exit 0，无乱码 | exit 0，无乱码 | **PASS** | `rt8-run.txt` | 工坊把 prompt 放 argv，Windows ~32k 上限是**工坊缺陷** |
| 16 | 长文本输入（stdin 130k） | exit 0，139,186B | exit 0，139,203B | **PASS** | `rt8-run.txt` | 无 |
| 17 | 长文本输出（24k 字回复） | exit 0，落盘 81,395 字符，尾部完整 | exit 0，落盘 79,184 字符，尾部完整 | **PASS** | `rt13-longout.txt` | 体积差≈2.7%，与系统提示词 −685 一致 |
| 18 | 长文本输出（120k 字回复） | 100s 内不退出 | 100s 内不退出（关 Memory 亦同） | **UNKNOWN（两版一致）** | `rt14-longout120.txt`（正文已完整落盘 328,283 字符，尾部标记在） | 与 Memory 无关；疑似超大 SSE 帧/回合收尾；超出工坊正常范围 |
| 19 | 会话创建/落盘 | `session.v4.jsonl.zstd` | 同格式 | **PASS** | `rt10/rt13` 逐帧解压 | 无 |
| 20 | 会话恢复 `--session-id` | exit 0，消息数=3，带回上轮正文 | 完全相同 | **PASS** | `rt9-run.txt` | 无 |
| 21 | 未知会话 ID 报错 | exit 1 + 固定文案 | 逐字相同 | **PASS** | `rt8-run.txt` | 无 |
| 22 | 并发两进程同 home | 都 exit 0 | 都 exit 0 | **PASS** | `rt12-parallel-longout.json` | 高并发未压测 → 上限 UNKNOWN |
| 23 | 系统提示词体量 | 2715 字符 | 2030 字符（−685） | **DEGRADED（轻微）** | `rt7-sysdiff.txt` | 减少的是 fs 工具指导语，非小说设定 |
| 24 | 文件工具面 | 6 个（read/write/edit/glob/grep/read_image） | 6 个 | **PASS** | `rt3-toolnames-*.txt` | 未做真实读写断言 → 间接证据 |
| 25 | Shell 工具 | novel profile 未挂 | 同 | **NOT_APPLICABLE** | `rt3-toolnames-*.txt` | 小说链路不经 shell |
| 26 | 子进程（MCP proxy） | 起得来、握手成功 | 同 | **PASS** | `rt3`、`rt12`（子进程观察） | 环境变量继承差异未单测 |
| 27 | 权限字段 | `sandbox_permissions`/`justification` | 字段在，文案收紧 | **PASS** | `rt3` tools JSON 字段级 diff；`pkg-diffs/dsh-tools.diff` | 真实审批拦截行为未测 → 子项 UNKNOWN |
| 28 | 插件 API 表面 | `ctx.on/provide/effect/plugin/tools/logger/skills` | 全在（cordis 4.0.4） | **PASS** | `hook-surface.txt`、`pkg-diffs` | 钩子**顺序**未 A/B → 子项 UNKNOWN |
| 29 | 公开导出 `generateConfigSchema` | `(binName, profile, …)` | `(profile, …)` | **DEGRADED（P3 破坏）** | `lib-diff-dump-config-schema-DhhNOaro.txt` | 小说工坊不用该 API；第三方工具需改 |
| 30 | provider 注册包名 | `dsh-llm-deepseek` | `dsh-llm-deepseek-api-key`（老包仍在但不注册 provider） | **DEGRADED（P3 隐性）** | `llm-provider-ids.txt`、`llm-deepseek-focus.txt` | 手写补丁引用老包名会"能加载但不注册 provider" |
| 31 | 模型/effort 枚举 | `deepseek-flash`/`deepseek-v4-pro`；`off`/`low`/`high`/`max` | 同 | **PASS** | `effort-check.txt` | 无 |
| 32 | 工坊自测（插件冒烟 39 组） | 全通过 | 全通过（与 dsh 版本无关，HTTP 直测） | **PASS** | `docs` 记录：`✔` 39 组 | 无 |
| 33 | 工坊自测（api-test-suite） | — | 186/190 通过、0 失败、4 主动跳过 | **PASS** | 实测输出 | 跳过 4 项为安全设计（不写全局配置） |
| 34 | 逐包产物比对 | — | 293 包：179 逐字节相同，113 有语义变化 | **PASS（信息）** | `classify2.json`、`pkg-diffs/*.diff` | 需按语义读，别把哈希重命名当变化 |
| 35 | 本机非 stock 增补 | 无 | `dsh-base` 挂 `dsh-operation-security`（私有包，npm 404） | **NOT_APPLICABLE（需单列）** | `dsh-base-installed-vs-published.diff` | 不是 stock RC.2；GUI/Web 生效，写作 profile 无关 |