# E07 验收报告（《叙事性专项修复》§7 E07 + §8 + §10）

- **任务**：`narrative-repair-e07`｜**base_commit**：`10f964664e`（本轮**未提交、未推送**）
- **运行器**：`node scripts/run-narrative-acceptance.mjs`（按**退出码**判定，不看输出里有没有"通过"）
- **机器可读清单**：`docs/narrative-repair/e07-run-manifest.json`（含每条命令的 cwd / 开始时间 / 耗时 / 退出码 / 通过失败数 / 日志路径）
- **付费调用**：**0 次**｜`SKIPPED: paid_evaluation_not_authorized`｜`SKIPPED: missing_frozen_blueprint`

## 一、必做命令（9 条，全部按退出码通过）

| id | 命令 | 退出码 | 通过/失败 | 日志 |
|---|---|---|---|---|
| ci-offline | `node scripts/ci-offline-checks.mjs` | 0 | 54 / 0 | `.narrative-repair/e07-ci-offline.log` |
| narrative-suites | `node scripts/test-narrative-repair.mjs` | 0 | 7 套件全绿（159 条断言） | `.narrative-repair/e07-narrative-suites.log` |
| frontend | `node frontend-test.mjs` | 0 | 全绿 | `.narrative-repair/e07-frontend.log` |
| instance-editing | `node .p1-baseline/test-editing-rules.mjs` | 0 | 79 / 0 | `.narrative-repair/e07-instance-editing.log` |
| instance-migration | `node .p1-baseline/test-migration-idempotent.mjs` | 0 | 13 / 0 | `.narrative-repair/e07-instance-migration.log` |
| host-contract | `node .p1-baseline/test-host-contract.mjs` | 0 | 28 / 0 | `.narrative-repair/e07-host-contract.log` |
| plugin-tools | `node .p1-baseline/verify-plugin-tools.mjs` | 0 | 7 项通道检查 + 三重对账 | `.narrative-repair/e07-plugin-tools.log` |
| preset-copy | `node .p1-baseline/verify-preset-copy.mjs` | 0 | 结论 `junction_ok` | `.narrative-repair/e07-preset-copy.log` |
| fixture-regen | `node scripts/materialize-narrative-fixtures.mjs "叙事性专项修复.md"` | 0 | 与冻结 hash 一致 | `.narrative-repair/e07-fixture-regen.log` |

非阻断（informational）：`node .p1-baseline/verify-phase-map.mjs` → **退出码 1**，原因见第四节（提交前门禁，非测试失败）。

## 二、§10.2 最终验收清单逐项对照

| 维度 | 必须达到 | 证据 | 结论 |
|---|---|---|---|
| 原文忠实 | 附录 A/B 完整保存；原始内容哈希可复算；候选改写不冒充后稿 | `02-fixtures` R01（`before_sha256=ffeae905…`、`after_sha256=932510ef…`、六组替换完整重建后稿、正文不夹入评论）；`fixture-regen` 退出码 0 | ✅ |
| 建议审查 | 不沿用"前稿 3751 年 10 月""S 级已明显压缩"等无证据判断 | 交付文档逐处区分 `SOURCE/VERIFIED/ANALYSIS/PROPOSAL`；`implementation-report.md` §1b 对 N/L 类明确写"机制已实现、文学效果待评测"；`04` E04-f 只报告"直播上下文里的镜头词**不**判错"这类有证据的结论 | ✅ |
| 编辑范围 | 精确 replace 与显式 delete 可运行；未授权范围不变；错误不自动扩大 | `01-patch-protocol`（P01/P02/P05/P06/P16—P21，65 条）；`05` E05-a/j（片段级授权、预算举手不放宽）；`frontend-test` 94t/94K（失败不整章重写） | ✅ |
| 叙事覆盖 | 能定位重复解释/重复流程，也能保护有效短句、直播来源和结尾 | `04` E04-b（解释冗余候选）、E04-c（落点重复且默认保留地点）、E04-d（流程复现）、E04-e（短句/否定不误报）、E04-f（直播上下文不判错）、E04-o（保护分区 + 保留理由随报告交付） | ✅（候选层） |
| 事实保护 | 不补新人物背景、科技解释、少女姓名、系统功能或未来章节信息 | `07` E03（引用核验：定位不到即拒收）；`05` E05-b（`must_keep`/`do_not_add` 进计划与提示词）；`04` E04-g（阴性对照不硬判）；`frontend-test` 96c（事实限制句仍在） | ✅ |
| 请求分层 | 真实成文 prompt 与允许略写一致；诊断规则不被另一入口重新灌回 write | `test-editing-rules` E19—E19e（同参数两条端点同一份 assembled + 同一规则块 hash；draft 无诊断判据；verify_style 有完整判据；不传阶段 = 旧行为）；`verify-plugin-tools`（Harness 侧路由输入级 + 变异测试）；`frontend-test` 96d | ✅ |
| 问题追踪 | 每个已选问题都有处置；保存/恢复不丢字段；相对改善有实际 diff 证据 | `05` E05-d（planned/needs_scope/refused 全覆盖）；`06` E06-e（覆盖表）；`test-editing-rules` E15/E16/E16b（结构化落库 + 选择记录往返）；`frontend-test` 94K4/94K5/94R2/94R3（选择记录真的被写；相对结论必须读 diff） | ✅ |
| 兼容 | 旧能力 ID、旧报告、旧作品可用；不擅自修改作者既定操作与存量风格 | `host-contract` 28/0（含"契约冻结的全部表在旧库里都存在（旧作品仍可打开）"）；`01` 的 legacy 载荷仍被接受（`salvageLegacyRevisionPatches`，94d/94e）；`test-editing-rules` B9（关闭总开关时作者的显式选择被如实保存）、B10（关闭后 assembled 与默认基线逐字节一致） | ✅ |
| 验证诚实 | 测试有退出码；零用例不算通过；真实 LLM 未跑与已跑明确区分 | 运行器按退出码判定并记录退出码；`scripts/test-narrative-repair.mjs --only zzz` 零匹配 → **退出码 2**；本报告与交付文档四处标注 `SKIPPED: paid_evaluation_not_authorized` | ✅ |

## 三、§8 测试矩阵的 I 类（全链路与兼容）对照

| 用例 | 证据 | 结论 |
|---|---|---|
| I01 阶段隔离 | `03-stage-rules`（17）；`test-editing-rules` E19b—E19d（draft / verify_style / 不传阶段三者产物不同且各自正确） | ✅ |
| I02 两通道一致 | `test-editing-rules` E19（同参数两条端点同一份 assembled + 同一 hash）；`verify-plugin-tools`（`novel_write_pipeline` 带 `stage=draft`；`novel_context` 白名单透传；变异测试） | ✅ |
| I03 保存往返 | `test-editing-rules` E15b/E16/E16b（PUT→存储→GET 字段逐项一致）；`frontend-test` 94K4（修稿前写记录）；取回路径读记录收窄（代码 + 94K） | ✅（离线/隔离实例） |
| I04 旧数据 | `host-contract`（旧库兼容 + 旧作品可打开）；`instance-migration` A/B/C/D（空库 74 表、重复启动不漂移、旧库只读指纹、损坏库响亮失败不篡改）；`01` 的 legacy 载荷与"无效旧补丁不获自动执行权限" | ✅ |
| I05 特性开关 | `test-editing-rules` B9/B10（关掉不改变生成行为且选择被保留）；`04` E04-a（未请求则不产出候选）；`06` E06-c/d（开关默认关：condense 一律 refused、不额外登记保护项）；`test-editing-rules` E17（空勾选 400，不产生付费依据） | ✅ |
| I06 真实保存入口 | `ci-offline` 内的"时态故事状态重构总入口（自托管隔离实例 + 本机假模型）"与"编辑规则隔离实例"两条：走真实 HTTP 与真实采纳路径 | ✅ |
| I07 零计费 | `ci-offline` 54/0 全部离线；`e07-run-manifest.json` 记 `paid_calls: 0`；隔离实例指向本机假模型/桩（不读生产密钥） | ✅ |
| I08 可恢复 | `frontend-test` 94K（接回进度：按任务那一章建快照并带章号；读选择记录收窄）；`instance-migration` B 组（重复启动不重复迁移） | ✅ |

## 四、阶段映射（提交前门禁，非测试失败）

- **本轮文件归属已完成**：新增阶段 `SE6`（`.p1-baseline/verify-phase-map.mjs`），门禁报告
  "**✓ SE6 的 6 项证据都在**"、"本阶段认领的文件（42 个）"，且**本轮改动无未归属文件**（逐项核对：0）。
- **文档已重新生成并同步**：`node .p1-baseline/verify-phase-map.mjs --write`（再跑一次门禁：文档过期问题已消失）。
- **仍然未通过的部分（不是本轮引入）**：门禁从 2 处问题降到 **1 处** —— 仓库尚有 **96 个历史遗留文件**没有归属
  （`git status` 里更早几轮的草稿/探针，例如 `.p1-baseline/_split-own-diff-20261006.mjs`、`ch121-*.txt`、`cleanup-my-draft67.mjs` 等）。
  它们不是本轮的改动，我**没有代替作者认领**（认领别人的文件会让回滚说明变成假的）。
  提交前需要由对应轮次补登记，或从工作区清理。
- 结论：**E07 自身的交付物齐备并已登记**；`git commit` 目前仍会被该门禁拦住，原因是历史遗留归属，不是本轮缺陷。

## 五、明确未验证 / 未执行（不得当作已通过）

1. **真实模型文学评测**（§8.4）：`SKIPPED: paid_evaluation_not_authorized`。本轮的 2 元授权**未使用**（0 次付费调用）。
   - 审稿覆盖实验 / 局部修稿实验：未做（需要独立授权 + 固定模型路由 + 人工对照）。
   - 生成实验：`SKIPPED: missing_frozen_blueprint`（附件没有当时的完整蓝图与故事状态）。
2. **模型侧是否稳定产出合规 findings / v2 补丁**：离线只验"给了就核验"（`07` E03-a…f、`01` P16—P21），未用真实模型验证产出率。
3. **diff → 合并 → 保存 → 空覆盖护栏**的端到端链路：`EMPTY_OVERWRITE_BLOCKED`（409）在服务端存在并有前端桩覆盖，但**未在真实浏览器 + 真实数据库上走一遍**。
4. **E06 的两个开关**只做了离线/桩级验证（未在真实会话里手动点过一遍界面）。
5. **C08**（文风分析的样本来源与按阶段使用）：未实现（不属 P0/P1 闭环必需），见 `implementation-report.md` §1b。

## 六、回滚

见 `docs/narrative-repair/rollback.md`（§10.3 的四条已逐条验证：特性开关可单独回滚、正确性修复不依赖风格开关、
新增字段是可忽略的版本化扩展、DB 迁移有重复启动与旧库升级测试）。改动前备份：
`data/backup-narrative-repair-20261009181433/`（含 `files/`、`uncommitted.diff`、`git-status.txt`、`README.md`）。
