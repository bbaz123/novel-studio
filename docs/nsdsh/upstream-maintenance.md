# 上游 DSH 维护纪律（S17）

> 本文件回答一个问题：**下一次上游发版，我们按什么顺序升级，才不会把已有能力弄坏、也不会丢失"哪些是我们改的"。**

## 1. 现状：我们改了什么，改在哪

| 类别 | 位置 | 说明 |
|---|---|---|
| 上游源码 | `<repo>/../deepseek-harness` | **一个字符都不改**。工作树必须保持干净（`vendor/dsh/verify-vendor.mjs` 会断言）。 |
| 本项目补丁 | `harness-plugins/novel-writing/`（`cordis.patch.yml` / `agent.cordis.yml`） | 以 **profile patch 层**的形式注入，不打在源码树上。 |
| 能力边界 | `harness-plugins/novel-writing/capabilities.mjs` | 26 个工具的 read/propose/author-confirm 分级（S09）。 |
| 组合与禁用 | `harness-plugins/novel-writing/profile.mjs` | 禁用项从 `cordis.patch.yml` 单一来源解析（S12）。 |
| 运行时契约 | `vendor/dsh/runtime-manifest.json` | 入口 / 协议握手 / 闭包 / 许可（S14）。 |
| 来源记录 | `vendor/dsh/PROVENANCE.md` | tag / commit / 许可 / 构建实测。 |

**结论：补丁面为零（零源码补丁）。** 因此"重放补丁"这一步目前是空操作 ——
但只要将来必须改上游，就必须落到下面第 4 节的规则上。

## 2. 升级流程（拉取候选 → 重放 → 构建 → 回归 → 发布）

```text
① 拉取候选
   在**独立工作树**里 fetch 目标 tag（不要动正在用的基线）
   git -C ../deepseek-harness worktree add ../dsh-candidate <tag>

② 重放补丁
   当前为空（零源码补丁）。若将来有：
   vendor/dsh/patches/NNNN-<slug>.patch 按文件名顺序 apply，全部必须干净应用；
   任何一处 fuzz/冲突 → 停止升级，先人工判断，不得"大致能用就继续"。

③ 构建完整基线（不做删目录优化）
   pnpm install --frozen-lockfile && pnpm run build && pnpm run typecheck && pnpm run lint
   四条都要 exit 0。

④ 回归（按顺序，前一步红就停）
   node vendor/dsh/verify-vendor.mjs          # 来源与许可
   node scripts/nsdsh/verify-runtime-closure.mjs   # manifest / 入口 / 版本握手 / 闭包
   node scripts/nsdsh/check-stage.mjs S12 --offline # profile 与有效能力清单
   node scripts/nsdsh/check-stage.mjs S13 --offline # SDK 协议面必须仍是三方法
   node scripts/ci-offline-checks.mjs              # 全量离线清单

⑤ 发布
   更新 vendor/dsh/PROVENANCE.md（新 tag/commit/构建实测）与 runtime-manifest.json
   （`baseline.tag` / `handshake.expectVersion` / `closure.requiredPackages`）
   → 重新生成阶段报告链（S01→Sn）→ 提交。
```

**为什么顺序不能换**：`verify-vendor` 先确认"基线真是那个提交"，否则后面所有回归跑的是
一个来源不明的树；`verify-runtime-closure` 再确认"入口与版本握得上"，否则 SDK 阶段会用一个
不匹配的协议面去跑（S13 的失败会以"协议方法不存在"的形式出现，很难回溯到这里）。

## 3. 上游升级时必须重新核对的三个事实

1. **SDK 协议面**（`packages/sdk/protocol/src/types.ts` 的 `HarnessSdkRequestMap`）：
   目前是 `initialize` / `session/prompt` / `shutdown`，**没有 `session/cancel`**。
   若上游新增了取消方法，`SDK_PROTOCOL` 白名单、S13 的取消实现与套件都要改；
   若上游**删改**了方法，`assertProtocolMethod` 会立刻抛 `SDK_PROTOCOL_VIOLATION`（这是设计意图）。
2. **CLI 入口与构建产物**（`apps/cli/lib/bin.js`）：`runtime-manifest.entry.path` 必须仍然存在。
3. **workspace 布局**（`packages/*/*`、`apps/*`）：`closure.requiredPackages` 是由
   `apps/cli` 的 dependencies 解析得出的，布局变了要重算。

## 4. 万一将来必须改上游源码

规则（违反即视为"来源不可信"）：

- 补丁放 `vendor/dsh/patches/`，文件名 `NNNN-<slug>.patch`，**顺序即文件名序**；
- 每份补丁必须有一段"为什么必须改上游而不是留给自己"的说明；
- `verify-vendor.mjs` 记录每份补丁的 sha256；
- 基线工作树**允许脏**，但只允许"恰好等于补丁集"的脏 —— 任何额外差异都要判红；
- 升级时先 `git checkout -- .` 回到干净基线，再按序重放。

## 5. 明确不做

- **不为"代码更少"删除已承诺支持的 external adapter**（S17 动作 3）。
- **不删除 `.p1-baseline` 或历史测试记录**来掩盖回归（S17 动作 7）。
- 不在本仓库修改 DSH 内核（项目级 `AGENTS.md` §八）。
