# dsh-novel-quality-auditor

Novel Studio 的**独立质量审计** DSH 插件。它不写小说，也不改正文；它做三件 Novel Studio 自己做不到的事：

1. **独立盲审**：先只看正文/蓝图/资料，提交并冻结盲审结果；
2. **初审对照**：冻结之后才允许读初审，逐条判定 covered / disputed / 需要上下文 / 证据无效；
3. **修稿逐项终验**：对作者勾选的每一条问题给出 PASS / PARTIAL / FAIL / NEED_CONTEXT / BLOCKED_SCOPE。

## 工具

| 工具 | 作用 |
| --- | --- |
| `novel_quality_open` | 打开本次审计，返回资源清单（不含正文） |
| `novel_quality_read` | 分页读取 article / blueprint / context / initial_review / candidate / selected_findings / patch_trace |
| `novel_quality_submit` | `blind_draft` 或 `final` 结构化提交（唯一完成凭证） |
| `novel_quality_status` | 只读：状态、缺失要求、上次错误 |

## 边界

- **不修改正文**，不写 `dsh-confirmation-resolution` 的 C 编号账本，不自动批准任何事；
- 没有 `NOVELSTUDIO_MODE=quality_audit` 环境时四个工具都返回 `NOT_APPLICABLE`，普通写作任务不受影响；
- `turn-stopping` 只做一次兜底提醒，第二次仍未提交就让任务失败（`AUDIT_NOT_SUBMITTED`）。

## 安装

```bash
node scripts/install.mjs --dry-run           # 只报告将修改的 profile/文件
node scripts/install.mjs                     # 写入 profile 并建立 link
node scripts/verify-wiring.mjs               # 离线：断言 4 个工具真的注册、profile 真的引用本包
node scripts/verify-host.mjs                 # 需要活实例：open/status 冒烟（需要审计环境）
node scripts/uninstall.mjs                   # 卸载并恢复 profile 备份
```

安装目标 profile 由 `NOVELSTUDIO_DSH_PROFILE` 决定，默认 `novel`；同时覆盖 `~/.dsh`
与专用 home `~/.dsh-novel`（存在时）。

## 与 novel-writing / dsh-confirmation-resolution 共存

- 工具名前缀唯一（`novel_quality_*`）；
- 不注册全局 `tools/post-execute`；
- 不改 `system-prompt` 的 `personaPrefix`（novel-writing 已拥有该键，两个 bundle 同写会互相覆盖）；
- 审计纪律由任务启动 prompt 注入（`ai/quality-auditor/prompts.mjs`），在读取任何被审文本之前生效。

## 测试

```bash
node test/contracts.test.mjs
node test/tools.test.mjs
node test/auth.test.mjs
node test/turn-guard.test.mjs
node test/coexistence.test.mjs
```
