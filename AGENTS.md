# AGENTS.md · Novel Studio 项目级规则

> 本文件只保存**本项目特有**的信息，不重复 `~/.dsh/AGENTS.md` 中的通用规则。
> 通用规则（验证、复盘、错误经验沉淀）仍然有效；两者冲突时以用户当前明确指令为准。
> 面向人类贡献者的版本见 [CONTRIBUTING.md](CONTRIBUTING.md)，本文件面向 Agent。

## 一、项目目标

Novel Studio 是一个**本地优先**的 AI 小说写作工作台：作者自己的机器上跑，数据不出本机、不花订阅费。
它不承诺写得更漂亮，它承诺的是**不让设定漂移、死人复活、伏笔失踪悄悄过去**。

当前开发线是实验分支 `Experimental-Version-v1.0`（也就是仓库默认分支）。
`refactor/p0-p6` 保留上一版（v0.9.6），`main` 保留重构前旧版（v0.9.3）——**不要往这两条分支提交本轮工作**。

近期版本主题：

| 版本 | 主题 |
| --- | --- |
| v1.1.5 | 一致性判据（事实锁 / 跨段重复 / 转场桥）+ 保护规则接线 + 允许人味 |
| v1.1.6 | 叙事结构机械感（生成端 P0 场景要求自相矛盾） |
| v1.1.7 | 审稿—局部修稿闭环硬化（授权 fail-closed + 报告自洽不再滥报） |
| v1.1.8 | 补丁协议 v2 加 `reason`/`allowed_ops` 与 op 授权校验 + 零宽 `insert` + 修后核验 `issue_coverage` |
| v1.1.9 | 未批准制度/时间机制候选（`new_workflow_rule`、`temporal_causal_bridge`）+ 审稿引文归属（`quote_not_found`）+ 修后结论闸（`coverageVerdict`）+ 界面接线 |

## 二、技术栈

- **Node.js ≥ 22.13**（实测 v24.19.0），纯 ESM（`.mjs` + `"type": "module"`），**不用 CommonJS `require`**。
- **零 npm 依赖**：`package.json` 没有 `dependencies`，运行时不引入任何第三方包。
  加依赖的 PR 一般不会被合并——需要小工具函数时手写。
- 后端 `node:http` + **SQLite**；前端 `public/` **无构建步骤**（直接改 JS，刷新即生效）。
- AI 内核在 `ai/`；DSH 插件在 `harness-plugins/novel-writing/`。

## 三、项目结构约定

| 路径 | 职责 |
| --- | --- |
| `server.js` | HTTP 端点 + 创作内核接口 |
| `db.js` | schema 与迁移 |
| `ai/` | 内核：上下文装配、故事状态、连续性护栏 |
| `ai/editing/` | 编辑规则（`rules.mjs`）、扫描器（`scan.mjs`）、叙事诊断与审稿 |
| `ai/writing/` | 写作策略源（`policy.mjs`） |
| `public/` | 前端 SPA（`app.js` 是大文件，按函数名定位，不要按行号） |
| `harness-plugins/novel-writing/` | DSH 插件 |
| `.p1-baseline/` | 离线测试与门禁脚本（**不是**构建产物） |
| `tests/narrative-repair/` | 叙事修稿闭环的分套件断言 |
| `docs/` | 契约、实现说明、历史报告（**中文**） |
| `data/` | 作者私有库与 API key —— **永不提交**（已在 `.gitignore`，不要 force-add） |

## 四、修改原则

- **本地代码优先**：改动针对当前本地工作树，先核实 `package.json` 版本与 HEAD，再动手。
  版本不符时先核对工作区，**不得擅自 checkout / rebase / 升级 / 降级**。
- **最小必要修改**：本项目历史包袱重（大量历史报告与基线目录），不做用户没要求的大范围重构。
- **判据改动必须配断言**：阈值、优先级、预算都住在 `.p1-baseline/` 与 `tests/` 的离线测试里。
  只改判据不加断言 → 它会悄悄漂回去。
- **注释解释"为什么"**：中文注释写的是"为什么不做另一种写法""为什么这个顺序不能动"，不是复述代码。
- **文档随行为同步**：改了行为就改文档。`docs/context-contract.md` 里的数字必须等于
  `ai/context/layers.mjs` 的真值。
- **`docs/phase-map.md` 是生成文件**：用 `node .p1-baseline/verify-phase-map.mjs --write` 重新生成，
  **不要手改**。新增文件必须被某个阶段认领（见下）。

## 五、构建 / 运行命令

```bash
node -v                    # 需要 22.13 或更高
npm start                  # 起服务，http://localhost:3737
npm run dev                # 带 --watch 的开发模式
```

前端**没有构建步骤**：改完 `public/` 直接刷新浏览器。

## 六、测试与验证命令

```bash
# A. 离线清单——CI 每次推送都跑，不需要活实例、不需要 API key、零计费。先跑这个。
node scripts/ci-offline-checks.mjs
npm test                   # 等价于上面这条

# B. 叙事修稿闭环的分套件断言（11 套件 / 240 条）
node scripts/test-narrative-repair.mjs

# C. 前端执行验证
node frontend-test.mjs

# D. 仓库门禁（改完文件都要跑）
node .p1-baseline/verify-phase-map.mjs   # 每个改动都要被某个阶段认领
node .p1-baseline/check-utf8.mjs         # 文本文件必须是合法 UTF-8

# E. 完整验收扫描——需要活实例与外部 dsh checkout，够不到的报 SKIPPED
node .p1-baseline/verify-all.mjs
```

**纪律**：

- 套件分别报告 **passed / failed / skipped**。**skipped 不等于 passed**，
  新失败不得藏在 skip 后面。
- 只信退出码，不信输出文案。
- **零计费优先**：会真正调用 LLM 的检查默认关闭，只在显式 opt-in
  （`NOVELSTUDIO_GATE_CONFIRMED_ISOLATED=1`、`NOVELSTUDIO_ALLOW_HARNESS_SPAWN=1`）时运行；
  验收扫描最后一项是**费用闸门**。

## 七、需要谨慎修改的区域

- **`public/app.js`**：单文件很大，行号会漂。**按函数名定位**，不要按行号改。
- **`ai/editing/rules.mjs` 与 `ai/writing/policy.mjs`**：这两份是判据源，改一处要同步
  检查另一处是否有同义文本——历史上出现过"同一判据两份文本漂移"。
- **`.p1-baseline/` 里的基线数据**：`baselines*` 目录是历史证据，不要为了跑绿而重写。
- **禁止为了让检查通过而删改、跳过、重命名或弱化测试与快照**。
- 历史报告（`docs/` 下带日期的文档）描述的是**当时的代码**，行号已失效——按符号名找代码，
  不要相信其中的行号。

## 八、与 DSH 的边界

- 本仓库是 **Novel Studio 产品**，不是 DeepSeek Harness 自身源码。修 bug 不要跑去改 DSH 内核。
- `harness-plugins/novel-writing/` 是 Novel Studio 提供给 DSH 的插件，属于本仓库。
