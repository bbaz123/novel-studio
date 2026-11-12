# P0 能力探测报告 —— DSH 一键成书方案（plan-ad9f75c12fbb）

- 生成时间：2026-11-12T12:36+08:00
- 方案快照：revision 1，sha256 `eaae52722b26e2bfe43a09c2689969de85570a348254abf7f10c102165c6529e`
- 目标仓库：`C:\Users\a1941\Desktop\DeepSeek\novel-studio`，HEAD `fda67b0`，分支 `Experimental-Version-v1.0`
- 结论：**G0_preflight（P0 部分）= PASS**，进入 P1–P11；turn-chime 未挂载按 §8 记 DEGRADED，不改变判定。

---

## 1. 与上一次探测的差别

2026-10-25 的 P0 报告（plan-52d26b8b5f43）判定 G0 = FAIL：egress / schema validator / mutation gate 三项 MISSING，worktree 与 secrets 两项 PARTIAL。

此后仓库补齐了等价适配器：

| 当时缺的能力 | 现在的等价实现 | 落地提交 |
| --- | --- | --- |
| egress deny-by-default | `ai/one-click-book/egress.mjs` + `harness-plugins/novel-writing/egress-guard.mjs` + sandbox preload | 3b5ac4e、d07939c |
| contract schema validator | `ai/one-click-book/core.mjs` 的 `validateContract/validateSchema`（迷你 JSON Schema） | bb5890b、8f8907a |
| mutation gate | `scripts/one-click-book-mutation.mjs`（12 变异体，阈值 0.8） | 11a70ca |
| tamper-evident 证据链 | `ai/one-click-book/attest.mjs`（Ed25519 签名 + 锚点日志） | 3b5ac4e |
| secrets 读取阻断 | 来源禁止路径 + 凭据内容扫描 + 导出前 secret scan | 8f8907a |

方案 §3.2 允许“本项目实现的等价适配器”，因此这次按等价适配器取证，而不是继续记 MISSING。本报告只使用**本会话真实命令输出**，模型自报不作证据。

---

## 2. 七个必需插件：五层证据

| 插件 | L1 安装 | L2 bundle | L3 loader | L4 注册能力 | L5 只读冒烟 |
| --- | --- | --- | --- | --- | --- |
| dsh-plugin-auto-plan-executor 0.1.0 | PASS | PASS | `include:auto-plan-executor` active | 5 个 `auto_plan_*` 工具 | PASS（返回本方案） |
| dsh-plugin-verification 0.1.0 | PASS | PASS | `include:verification-gate` active | 3 个 `verification_*` 工具 | PASS（state=working） |
| dsh-plugin-confirmation-resolution 1.1.0 | PASS | PASS | `include:confirmation-resolution` active | V1+V2 两工具 | SKIPPED（无只读动作） |
| dsh-operation-security 0.1.0 | PASS | PASS | `include:operation-security-desktop` active | PARTIAL（钩子层，无工具） | NOT_OBSERVED（本会话无新审计行） |
| dsh-self-plugin-manager 0.1.0 | PASS | PASS | `include:self-plugin-manager` active | PARTIAL（客户端 surface） | SKIPPED（会改 profile） |
| dsh-openviking-autostart 0.1.0 | PASS | PASS | `include:openviking-autostart` active | `agent/created` 钩子 | PASS（本会话 resume joined） |
| @local/dsh-turn-chime 1.0.0 | PASS | PASS | **MISSING**（210 条 loader 清单无它） | NOT_RUN | NOT_RUN（日志末条 2026-10-25） |

turn-chime：依赖、`dsh.bundle` 字段、`cordis.patch.yml` 插入定义都在，但当前 desktop profile 的 loader 清单里没有它，本轮也没有新的播放日志。按方案 §8 记为 DEGRADED，**不参与 PASS/FAIL/DONE**。

---

## 3. 六项附加必需能力

| 能力 | 判定 | 关键证据（本会话实际执行） |
| --- | --- | --- |
| `isolation.worktree` | **PASS** | `git worktree add --detach .dsh/worktrees/p0-probe fda67b0` exit=0；worktree 内跑通 34/34 验收 |
| `contract.schema_validator` | **PASS** | 合法 task-contract → 0 错；非法 chapter-contract → 非空错误；PLAN_ACCEPTANCE=24 |
| `network.egress_deny_default` | **PASS** | `node scripts/test-ocb-egress.mjs` → 10/10；probe 非白名单抛 EGRESS_DENIED、回环放行 |
| `secrets.broker_or_read_block` | **PASS** | `.env` → FORBIDDEN_SOURCE_PATH；正文含 AKIA 形态凭据 → CREDENTIAL_IN_SOURCE；两者都不写 chapters |
| `evidence.tamper_evident` | **PASS** | Ed25519 签名验证 ok；篡改证据链后被 verifyAnchor 拒绝 |
| `quality.mutation_or_semantic_adversarial_gate` | **PASS** | `node scripts/one-click-book-mutation.mjs` → 12/12 killed，score=1 ≥ 0.8 |

### G0 判定

- `plugin_capability_probe_pass`：六插件 PASS，turn-chime 按 §8 降级 → 成立。
- `required_additional_capabilities_pass`：六项全部有真实运行证据 → 成立。
- `egress_and_secret_policy_active`：产品层守卫 + 来源/导出扫描均有拒绝证据 → 成立。
- `clean_baseline` / `worktree_created` / `input_snapshot`：在 P1–P2 冻结，见 `.dsh/baseline.json` 与 `.dsh/input-snapshot.json`。

---

## 4. 本次实际做了什么 / 没做什么

**做了（全部可复核）**

- 读取冻结 Markdown 与 945 行 YAML 全文，按 `additional_required_capabilities` 逐项取证。
- profile 依赖 + `dsh.bundle` 字段 + `cordis.yml` 行号 + `plugin_manager list_plugins` 真实 loader 清单。
- 在 `.dsh/worktrees/p0-probe`（detached HEAD fda67b0）里真实运行：验收套件 34/34、出口隔离 10/10、变异门禁 12/12。
- 写入 `.dsh/plugin-inventory.json`、`.dsh/capability-smoke.json`、本报告与 `.dsh/evidence/T-P0/**`。

**没做（有意）**

- 没有安装/升级/停用任何插件（DPIP 约束）。
- 没有把 turn-chime 的“依赖存在”写成“已启用”。
- 没有修改方案冻结的验收标准、阈值或 Oracle。

---

## 5. 证据索引

| 证据 | 位置 |
| --- | --- |
| 附加能力探测输出 | `.dsh/evidence/T-P0/probe.json` |
| 探测脚本 | `.dsh/evidence/T-P0/probe.mjs` |
| worktree 创建日志 | `.dsh/evidence/T-P0/worktree-add.log` |
| 出口隔离断言（10/10） | `.dsh/evidence/T-P0/egress-test.log` |
| 变异门禁（12/12） | `.dsh/evidence/T-P0/mutation.log` |
| 七插件五层清单 | `.dsh/plugin-inventory.json` |
| G0 判定 | `.dsh/capability-smoke.json` |
| loader 清单来源 | 本会话 `plugin_manager list_plugins`（total=210） |
| OpenViking 自启动日志 | `~/.dsh/openviking-autostart.log` 末 2 行 |
| 提示音日志（未更新） | `Desktop\DeepSeek\dsh-sound-notify\chime.log` 末 1 行 |
