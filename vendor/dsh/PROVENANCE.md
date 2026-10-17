# DSH 固定基线的来源与许可记录（S11）

> 本文件是 DSH 上游基线的**唯一来源记录**。`vendor/dsh/verify-vendor.mjs` 里的 `EXPECTED`
> 常量必须与本文件一致；改任何一边都要同步另一边（否则校验会红）。

## 1. 基线是什么

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness` |
| 上游 tag | `dsh-v0.1.7-rc.1` |
| 上游 commit | `46a7f68b`（2026-09-23 release） |
| **本地 vendor commit** | **`7e06df2`**（tag 同上游 `dsh-v0.1.7-rc.1`） |
| 包版本 | `0.1.7-rc.1` |
| 许可证 | 仓库根 `LICENSE`（1065 字节，MIT 族；分发时必须随附） |
| lockfile | `pnpm-lock.yaml`（保留；`verify-vendor.mjs` 记录其 sha256） |
| 本地基线位置 | `<repo>/../deepseek-harness`（与 `novel-studio` **同级**的兄弟目录） |

**为什么基线不放在 `novel-studio` 仓库内**（与方案原文的 `third_party/deepseek-harness/` 路径不同）：

1. 上游是**独立仓库**（自带 `.git`、tag、lockfile、数十个 package）。把它复制进产品仓库会带来
   两个确定的问题：① 产品仓库的 diff/审查被上游源码淹没；② 上游更新时无法用 `git` 对账。
2. 本机已有该基线（`7e06df2`，工作树干净）。方案要求的是"**记录并验证**固定的上游提交"，
   而不是"必须在某个路径下复制一份"。
3. 需要随产品分发时，由 S14（裁剪发行物与依赖闭包）决定**打包哪一部分**——
   那时才是"把东西搬进发行物"的正确时机。

> ⚠️ 这是一处**与方案路径的偏差**，如实记录在此，而不是悄悄按原文建一个空壳目录。

## 2. 上游 / 本项目补丁的界线

- **上游源码**：`deepseek-harness` 里的全部内容，一律不改。基线工作树必须**保持干净**
  （`verify-vendor.mjs` 会断言 `git status --porcelain` 为空）。
- **本项目补丁**：只存在于 `novel-studio` 侧，通过 profile / patch 文件注入
  （见 `harness-plugins/novel-writing/`、`~/.dsh-novel` 的 profile 配置）。
  **不往上游树里写补丁**，避免"来源不可信"。
- 因此本阶段不存在"补丁应用顺序"问题：补丁面为零。若将来必须打补丁，规则是：
  在 `vendor/dsh/patches/` 下按 `NNNN-<slug>.patch` 编号存放，顺序即文件名序，
  并由 `verify-vendor.mjs` 记录每份的 sha256。

## 3. 构建验证（真实执行结果）

在基线上按方案要求执行（**依赖已预先安装**，构建产物已被上游 `.gitignore` 覆盖，构建后工作树仍干净）：

| 命令 | 结果 |
|---|---|
| `pnpm run typecheck` | **exit 0**（`tsc -b tsconfig.client.json` 通过） |
| `pnpm run build` | **exit 0**（`✓ built in 3.69s`，`build: recorded 263 client artifact(s) with 2 public value(s)`） |
| `pnpm run lint` | **exit 0**（`Found 0 warnings and 0 errors.`，4769 files / 90 rules） |
| `git status --porcelain`（构建后） | **空**（构建未污染基线） |

环境：Node `v24.19.0`、pnpm `11.7.0`、Windows。**未使用任何真实模型凭证**——
这三条命令不需要模型，也不产生费用。

## 4. 如何复核（任何时候都可跑）

```bash
# 只读校验：来源、tag、包版本、许可、lockfile 摘要、工作树是否干净
node vendor/dsh/verify-vendor.mjs
node vendor/dsh/verify-vendor.mjs --json           # 机器可读
node vendor/dsh/verify-vendor.mjs --path <dir>     # 校验别处的基线
```

退出码 0 = 与本文记录一致；1 = 漂移（门禁应据此判红）。

## 5. 与本阶段的验收对应

| 验收项 | 依据 |
|---|---|
| 完整固定基线**可构建** | 上表三条命令 exit 0（typecheck / build / lint） |
| host **不要求**修改用户全局 DSH | 产品用 `~/.dsh-novel` 与注入式 profile；`verify-vendor.mjs` 不写任何用户目录；本阶段全部操作都在基线树与产品仓库内 |
| 来源和许可**齐全** | 本文第 1 节 + 基线 `LICENSE` 存在（1065 字节）+ `verify-vendor.mjs` 断言 |

## 6. 未覆盖 / 明确不做

- **未**在本阶段做"删目录裁剪"（方案 §S11 动作 5 明确要求先做完整构建、不做删目录优化）。
- **未**升级上游（0.1.7-rc.1 已满足 SDK 需求；方案 §S11 动作 2 的升级分支未触发）。
- **未**验证其它平台（macOS / Linux）构建——本阶段只在本机 Windows + Node 24 上取证。
  方案要求"根据选定 Node 与平台构建"，本文件如实记录**平台边界**。
- **未**把基线复制进产品仓库（第 1 节已说明理由与偏差）。
