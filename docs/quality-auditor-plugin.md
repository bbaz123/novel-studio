# dsh-novel-quality-auditor 插件（阶段 3/4/6）

插件源码：`harness-plugins/dsh-novel-quality-auditor/`。安装后作为 bundle 进入 `novel` profile。

## 四工具

| 工具 | 行为 |
| --- | --- |
| `novel_quality_open` | GET manifest；只返回资源清单（不返回正文） |
| `novel_quality_read` | 分页读取；blind 阶段读 `initial_review` 被服务端拒绝 |
| `novel_quality_submit` | `blind_draft` / `final`；相同摘要本地幂等，不同摘要服务端冲突 |
| `novel_quality_status` | 只读状态 + 缺失要求 + 上次错误 |

## 环境契约

```
NOVELSTUDIO_MODE=quality_audit
NOVELSTUDIO_AUDIT_ID / NOVELSTUDIO_AUDIT_TOKEN / NOVELSTUDIO_AUDIT_KIND
NOVELSTUDIO_WORK_ID / NOVELSTUDIO_CHAPTER_ID / NOVELSTUDIO_BASE_URL
```

没有这些变量时四个工具返回 `NOT_APPLICABLE`（PL-02），普通写作任务不受影响。

## 安装/卸载

```bash
cd harness-plugins/dsh-novel-quality-auditor
node scripts/install.mjs --dry-run
node scripts/install.mjs
node scripts/verify-wiring.mjs      # 真实 apply → 断言 4 工具注册 + profile 引用
node scripts/uninstall.mjs          # 从备份恢复 package.json 并删除链接
```

## 前端

- 写作台：`public/quality-audit-panel.js` 的 `summaryLine()` 只产出一行（不压缩正文列宽）；
- 审稿报告：新增「🔍 独立复核（盲审→对照）」入口，由 `startReviewQualityAudit()` 发起并轮询；
- `allDone()` 是"全部完成"的唯一判据：run=COMPLETED 且所有已选项 PASS。
- **正文来源与前置**（2026-10-22）：独立复核的 `article` **只**取自 `chapters.content`（`routes.mjs` 的
  `buildReviewResources`），不读编辑器里未保存的内容，也不读审稿报告的 `base_text`。所以库内本章正文为空时
  入口直接禁用并写明出路（先保存本章 / 从「有未应用的生成稿」取回），不再"点了才失败"；
  服务端仍兜底返回 422 `AUDIT_CONTRACT_INVALID`（文案点明"库内本章正文为空"）。

## 回执里的引文底本

`PUT /novel/review` 回执的 `quote_base` 有两个**互不替代**的字段：

| 字段 | 含义 |
| --- | --- |
| `differs_from_chapter` | 被审正文与库内正文都在，且内容不同 |
| `chapter_empty` | 库内本章正文为空（此时没有"是否不同"可比，`differs_from_chapter` 只能是 false） |

`chapter_empty=true` 表示这份报告是对**未落库的正文**（编辑器未保存 / 未应用的生成稿）做的：
界面会单独提示"库内本章正文为空"，而不是把它显示成"与正文一致"。老回执没有该字段，
展示时按库内正文补一次口径（只影响显示，不改库）。

## 测试

| 套件 | 断言 |
| --- | --- |
| `test/contracts.test.mjs` | operation/resource/limit 白名单 |
| `test/auth.test.mjs` | NOT_APPLICABLE、错配 kind |
| `test/turn-guard.test.mjs` | 只提醒一次、第二次失败 |
| `test/tools.test.mjs` | 对本地 HTTP stub 的真实执行（含 blind 禁读、幂等、冲突） |
| `test/coexistence.test.mjs` | 工具名/事件/补丁层与 novel-writing、confirmation-resolution 无冲突 |

## 真实子进程联调

```bash
NOVELSTUDIO_REAL_AUDIT=1 \
NOVELSTUDIO_DSH_BIN="<npm-global>/@deepseek-ai/dsh/lib/bin.js" \
node scripts/quality-auditor/real-host.mjs
```

- `NOVELSTUDIO_DSH_BIN` 是新增的启动通道：同级 `deepseek-harness` 源码仓库是 0.1.7-rc.1，
  用它启动会违反「DSH 固定 0.2.0-rc.2」，所以允许直接指向 npm 安装的 `lib/bin.js`。
- 成功判据不是子进程退出码，而是账本进入 `COMPLETED` 且合并出新的审稿记录。
- 失败时 `error_detail` 会携带子进程 stderr 尾部（例如 `MALFORMED_RESPONSE`），
  才能区分"插件没被加载"与"模型侧 JSON 损坏"。

## 一次契约修复重试

`coordinator.startAudit` 只对**模型侧 JSON/流损坏**（`MALFORMED_RESPONSE` / `invalid JSON`）
且**账本尚无任何提交**时自动重试一次，并在 prompt 末尾追加"格式修复"提示
（拆小 finding、quote ≤200 字、正确转义）。其它失败（鉴权/超时/预算）不重试 —— 重试只会再烧一次钱。


## 内置化（工坊内一键安装）

- 实现在 `ai/quality-auditor/provision.mjs`：`auditPluginStatus()`（只读）与
  `ensureAuditPluginInstalled()`（幂等：备份 profile `package.json` → 写 dependency/bundle → 建 junction）。
  CLI `scripts/install.mjs` 只是它的包装，不再有第二套逻辑。
- `GET /api/env/tools` 返回 `dsh.plugins.qualityAuditor` 与 `dsh.version / launcher`，
  以及 `dsh.missing_dependencies`（前端"缺依赖"弹窗直接消费，前后端同一份判断）。
- `POST /api/env/plugins/install {name:'quality-auditor', dry_run?}`：作者通道；只在点按钮时写 profile。
- 服务启动时**只检测不写**；审计创建时若插件未装 → 409 `AUDIT_PLUGIN_NOT_INSTALLED`，界面弹窗给一键安装。
