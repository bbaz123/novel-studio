# DSH 版本对齐方案（质量审计 × 小说工坊）

> 性质：**待决策方案**，尚未执行任何破坏性动作（未删除、未替换仓库）。
> 核查时间：2026-10-21 23:0x

## 1. 核查事实（全部零计费或小额真实调用，均有输出）

| 项 | 结果 |
| --- | --- |
| 同级 `Desktop/DeepSeek/deepseek-harness` | `dsh-v0.1.7-rc.1`，built entry `apps/cli/lib/bin.js` 存在，`tsx` 已装，origin 指向上游 |
| 工坊 `dsh_repo` 设置 | 空 → `harness.js` 回落到同级 0.1.7 仓库 |
| 0.1.7 组合（`--dump-config`） | profile 里**已含** `novel-quality-auditor` 条目（bundle 补丁被接受） |
| 0.1.7 真实工具调用 | 模型成功调用 `novel_quality_status`，返回 `NOT_APPLICABLE`（证明四工具已注册） |
| 0.1.7 端到端审计 | `status=COMPLETED`，事件链含 blind_submitted→compare_started→result_received，合并出 review_id=2（3 issues/3 findings，integrity OK） |
| 0.2.0-rc.2（npm bin）端到端 | 同样 `COMPLETED`（上一轮已验证） |
| 上游 GitHub tag | `dsh-v0.2.0-rc.2` 存在（`git ls-remote` 实测） |
| 工坊服务 | **当前未运行**（3737 无监听） |

## 2. 结论

**不需要删除同级仓库、也不需要重新下载。** 审计插件在当前默认环境（0.1.7）与固定版本（0.2.0-rc.2）
下都能加载并跑通；两个插件（novel-writing / dsh-novel-quality-auditor）在 0.1.7 下共存正常
（novel-writing 的工具与审计工具同时在场，工具名无冲突）。

现在唯一缺的是：**启动工坊 + 刷新页面**。

## 3. 可选方案

### 方案 A（推荐，零风险）：保持现状
- 启动工坊（`npm start`），刷新页面；
- 审计子进程走同级 0.1.7 仓库；
- 代价：与"DSH 固定 0.2.0-rc.2"的名义要求不一致（但实测行为一致：两次端到端均 COMPLETED）。

### 方案 B（原计划，风险中等）：把同级仓库升级到 0.2.0-rc.2
1. **备份而非删除**：`deepseek-harness` 重命名为 `deepseek-harness-0.1.7-rc.1-<时间戳>`；
2. `git clone --depth 1 --branch dsh-v0.2.0-rc.2 <upstream>` 到原路径；
3. `pnpm install` + `pnpm run build`（repo 2.1G node_modules 需重建；需要网络与时间）；
4. `--dump-config` 验证两个插件仍被组合；
5. 分别实跑：novel-writing 冒烟（`harness-plugins/novel-writing/test/smoke.mjs`）、审计 `real-host`；
6. 如需适配：`novel-writing` 的 `system-prompt` 键（`personaPrefix`/`persona`）、工具 `output` schema；
   审计插件的事件名（`agent/turn-stopping`）与 `/status` 路由；
7. 全量回归（`ci-offline-checks` 73 项）+ 安装/卸载/回滚演练。
- 风险：写作任务行为可能变化（影响日常连载）；磁盘与构建时间；回滚需恢复归档目录与 profile 备份。

### 方案 C（混合）：写作走 0.1.7，审计显式走 0.2.0-rc.2
- 启动命令加 `NOVELSTUDIO_DSH_BIN=<npm-global>/@deepseek-ai/dsh/lib/bin.js`；
- 两个版本并存，互不替换；
- 代价：同一工坊两套 DSH，排查问题时需先确认"这次是哪个版本"。

## 4. 建议

先走 **A**（今天就可用），若你要求名义与运行时都统一到 0.2.0-rc.2，再按 **B** 单独排期执行；
**C** 只适合"写作必须留在 0.1.7、审计必须用 0.2.0"的过渡期。
