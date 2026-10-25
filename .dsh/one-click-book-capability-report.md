# P0 能力探测报告 —— DSH 一键成书方案（plan-52d26b8b5f43）

- 生成时间：2026-10-25（+08:00）
- 方案快照：revision 1，sha256 `71f2e038d66a691a06b3381d9075308b6d06c2fcfd03d5e36b02efde7297e57d`
- 目标仓库（本会话工作区）：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`，HEAD `9a145db`，分支 `Experimental-Version-v1.0`
- 结论：**G0_preflight = FAIL → 按方案 P0 的 `on_failure: BLOCK_AND_REPORT` 停止自动执行**

---

## 1. 七个必需插件：五层证据

证据分层严格按方案要求区分（能安装 ≠ 已挂载 ≠ 已装载 ≠ 已注册能力 ≠ 冒烟通过）。

| 插件 | L1 可安装 | L2 挂载 | L3 装载树 | L4 能力注册 | L5 冒烟 |
| --- | --- | --- | --- | --- | --- |
| dsh-plugin-auto-plan-executor 0.1.0 | PASS | PASS | PASS | PASS（5 个 `auto_plan_*` 工具） | PASS（`auto_plan_status` 返回本次方案） |
| dsh-plugin-verification 0.1.0 | PASS | PASS | PASS | PASS（3 个 `verification_*` 工具） | PASS（`verification_status` state=working） |
| dsh-plugin-confirmation-resolution 1.1.0 | PASS | PASS | PASS | PASS（V1+V2 两工具） | SKIPPED（无只读动作） |
| dsh-operation-security 0.1.0 | PASS | PASS | PASS | PARTIAL（钩子层，无对外工具） | PASS（`audit.jsonl` 逐调用追加） |
| dsh-self-plugin-manager 0.1.0 | PASS | PASS | PASS | PARTIAL（客户端设置页 surface） | SKIPPED（会改 profile，非只读） |
| dsh-openviking-autostart 0.1.0 | PASS | PASS | PASS | PASS（`agent/created` 钩子） | PASS（日志 started/joined） |
| @local/dsh-turn-chime 1.0.0 | PASS | PASS | PASS | PASS（回合结束钩子） | PASS（`chime.log` 本会话真实播放） |

**判读**：七个插件的“能装、挂了、在装载树里”全部成立；两项 L4 因能力位于钩子或客户端 surface 而只能记 PARTIAL；两项 L5 因只读约束跳过，**未记为 PASS**。这一层不构成阻塞。

---

## 2. 六项附加必需能力：这是阻塞所在

| 能力 | 要求 | 判定 | 关键证据 |
| --- | --- | --- | --- |
| `isolation.worktree` | required: true / on_missing: BLOCK | **PARTIAL** | 工作区内 `git worktree add --detach` 成功（HEAD 9a145db）；写到工作区外 `Desktop\DeepSeek\.ocb-wt-probe` 时 `fatal: could not create leading directories ... Permission denied`（DSH 文件沙箱 workspace-write 边界） |
| `contract.schema_validator` | required: true / BLOCK | **MISSING** | 未安装 dsh-acceptance / dsh-agent-contract / dsh-harness-core；DSH 打包源码无对应包；schemastery 只校验插件配置 |
| `network.egress_deny_default` | required: true / BLOCK | **MISSING** | `packages/sandbox/sandbox/README.md:167`「File effects are the whole policy vocabulary … no network」；`sandbox-policy/README.md:148` 同；无 egress 插件，`web_fetch`/`web_search` 默认可用 |
| `secrets.broker_or_read_block` | required: true / BLOCK | **PARTIAL** | operation-security 只在 EXPORT/PUBLISH 做文件名规则扫描；credentials-local 是文件凭据存储，不是 broker |
| `evidence.tamper_evident` | DEGRADED_AND_BLOCK_EXPORT_UNLESS_APPROVED | **MISSING** | verification 记录证据索引与指纹，但无哈希链/签名；未装 dsh-attest-chain |
| `quality.mutation_or_semantic_adversarial_gate` | required_for: implementation and validators / BLOCK | **MISSING** | DSH 源码只有 `proposed/testing/2026-06-11-mutation-testing.md`（提案，未实现）；插件目录检索无 mutation gate |

### G0 判定

- `required_additional_capabilities_pass` **不成立**：3 项 `required: true` 能力 MISSING（egress / schema validator / mutation gate），2 项 PARTIAL（worktree / secrets）。
- 方案对该步骤明确规定 `on_failure: BLOCK_AND_REPORT`，且 §8 规定“必需能力未激活：停止自动执行，输出 capability report；不能假装执行”。
- 因此：**不进入 P1–P11**，不创建 worktree，不写任何产品代码。

---

## 3. 第二处阻塞：契约与目标仓库不匹配（G1 层面的预判）

方案 `agent_contract.allowed_paths` 只允许：

```
src/**  app/**  packages/**  tests/**  fixtures/**
docs/one-click-book/**  .dsh/**  book-project/**  reports/**  evidence/**
```

而本仓库实际结构是 `server.js`、`db.js`、`ai/**`、`public/**`（`public/app.js` 是 SPA 主体）、`scripts/**`、`.p1-baseline/**`。其中 `src/`、`app/`、`packages/`、`fixtures/` 不存在。

后果：

1. 要实现“一键成书”入口与 Job API，必然要改 `public/app.js` 与 `server.js` —— **不在白名单内**；按 AC-02，这类写入必须被拒绝并回滚，功能根本无法落地。
2. 如果在仓库里新建 `src/`、`app/` 做一套并行产品，则与本仓库项目级规则冲突（`AGENTS.md`：本仓库是 Novel Studio 产品；新文件必须被 `.p1-baseline` 阶段认领）。
3. 冻结契约、验收标准、门禁阈值**不得由执行 Agent 改写**，所以我不能自行把 `public/**` 补进白名单。

这一条与第 2 节互相独立：即使能力补齐，契约仍会卡住实现。

---

## 4. 方案自身的三处结构问题（如实记录，未改动）

1. **步骤重复**：80 条 REQUIRED 步骤里，PS-01–PS-45 与 PS-46–PS-80 成对重复（同一句话由 Markdown 与 YAML 各抽取一次，如 PS-01≡PS-46、PS-05≡PS-49、PS-17≡PS-61）。实际唯一意图约 40 条。
2. **未覆盖段落**：`1. 运行前必须先确认的事实` 被标记为待 `declare` 或 `dismiss_uncovered`。
3. **门禁顺序与实际写入冲突**：P0/P1 要求先写 `.dsh/plugin-inventory.json`、`.dsh/input-snapshot.json`，但隔离 worktree 要到 P2 才创建 —— 这两步只能写进主工作区。本次按 `.dsh/**` 白名单落在主工作区 `.dsh/`，并在此明示。

---

## 5. 本次实际做了什么 / 没做什么

**做了（全部可复核）**

- 读取冻结的 Markdown 与 YAML 全文（945 行 YAML 为执行契约）。
- 七插件五层探测：profile `package.json`、各包 `package.json` 的 `dsh.bundle`、`cordis.patch.yml`、组合树 `cordis.yml` 行号、运行时工具/钩子、只读冒烟。
- 六项附加能力的 provider 检索与文档取证（含沙箱真实越界实验）。
- 写入 `.dsh/plugin-inventory.json`、`.dsh/capability-smoke.json`、本报告。
- 探测用 worktree（`.dsh/probe/wt`）已 `git worktree remove` 清理，主工作树文件零改动。

**没做（有意）**

- 未创建正式 worktree（`worktree_created` 这一 G0 要求本身就没法在“主工作区只读”前提下满足）。
- 未写任何产品代码、未改 `public/`、`server.js`、未新增 `src/`。
- 未安装任何插件（DPIP 约束）。
- 未调用 `auto_plan_finish`（完整度不可能通过，调用只会被拒）。

---

## 6. 解除阻塞需要你做的选择

### 选项 A：补齐能力层（最忠实于原方案，工作量最大）

自建等价适配器并重新探测：

- `worktree` 适配器：把 worktree 固定在工作区 `.dsh/worktrees/**`，并让“主工作区只读”以“产品文件未改”判定；
- schema 校验器：零依赖手写 JSON Schema 子集校验（对象/必填/枚举/唯一 ID）；
- egress 守卫：`tools/pre-execute` 拦截 `web_fetch/web_search/ops_bash` 的出站，默认拒绝 + allowlist；
- mutation gate：对变更域逻辑做变异重跑，未运行即失败；
- 证据链：sha256 哈希链 + 审批 hash 绑定（可先满足 DEGRADED 之外的导出要求）。

代价：这是新一轮插件的实现与装配验证，不是本轮能顺带完成的。

### 选项 B：按 §8 降级执行（工作量中等，但必须你明确批准并留档）

承认 egress / secrets / attest 三项缺失，把方案降为“本地草稿级”：

- 只做 P3 契约、P4 来源与目录、P5–P7 内容侧、P10 草稿导出（Markdown）；
- EXPORT/PUBLISH 一律 BLOCKED；
- 所有报告如实写 DEGRADED 与缺能力清单。

注意：方案写的是“除非人类明确批准并记录理由”。若选此项，我需要你一句明确授权，我会把它记录为批准事件与理由。

### 选项 C：先修契约与目标（最小改动，推荐先做）

1. 明确**目标仓库与产品面**：是继续在 `novel-studio` 里做（那就必须把 `public/**`、`server.js`、`ai/**` 写进 `allowed_paths`，并说明“主工作区只读”指的是隔离 worktree 语义），还是另起一个 `src/`+`app/` 的独立仓库；
2. 修正 80 条步骤的重复对，让完整度闸门按约 40 条唯一意图判定；
3. 决定 egress/secrets/mutation 三项：补齐、还是按选项 B 显式降级。

完成后重新提交方案（会生成新快照），我按新契约从 P0 重跑。

---

## 7. 证据索引

| 证据 | 位置 |
| --- | --- |
| 插件五层探测 | `.dsh/plugin-inventory.json` |
| 附加能力判定与 G0 | `.dsh/capability-smoke.json` |
| 组合树挂载位置 | `~/.dsh/profiles/desktop/cordis.yml`（1226–1390 行区间） |
| OpenViking 自启动日志 | `~/.dsh/openviking-autostart.log` 末行 |
| 回合提示音日志 | `Desktop\DeepSeek\dsh-sound-notify\chime.log` 末 3 行 |
| 操作安全审计 | `~/.dsh/operation-security/audit.jsonl` 末 2 行 |
| 沙箱网络策略 | DSH 源码 `packages/sandbox/sandbox/README.md:167`、`sandbox-policy/README.md:148` |
| mutation 仅提案 | DSH 源码 `.agents/notes/proposed/testing/2026-06-11-mutation-testing.md` |
