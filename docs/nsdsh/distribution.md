# R02：真实可发布裁剪发行物与 B/C 动态等价

> **阶段**：R02（《S18 后收尾方案》§4，**P0 发布缺口**）
> **状态**：`PASS`（Windows x64，本机实测；Linux/macOS 见 R03）
> **基线锚点**：DSH `dsh-v0.1.7-rc.1` / vendor `7e06df2` / upstream `46a7f68b`
> **零计费**：全程本机假模型端点（127.0.0.1 SSE），无真实 key、无真实请求
> **产物不入库**：`.nsdsh/dist/` 已被 `.gitignore` 覆盖；可审计的是**命令 + SHA-256**，不是二进制

---

## 0. 一句话结论

S14 的 `build-runtime.mjs --fixture` **不写任何目录**，B/C 的 `equal: true` 是把同一个签名
赋给两边**构造**出来的。R02 改成了真的：

| | 之前（S14） | 现在（R02） |
|---|---|---|
| 产物 | 只有统计数字 | **真 ZIP**（22,530 条目 / 69.5MB）+ 真目录 + 真 SHA-256 |
| 冷环境 | 未做 | 从档案解压到**全新临时目录**再启动 |
| B/C 等价 | 同一签名 ⇒ `equal:true` | **两个独立进程**跑同一 prompt，比较工具/消息/终态 |
| 包外依赖 | 未验证 | 503 个 `package.json` 全部在档案内自足；无 symlink |

## 1. 复现命令（三条，全部 exit 0）

```bash
node scripts/nsdsh/package-runtime.mjs --output .nsdsh/dist/runtime --archive .nsdsh/dist/runtime.zip
node scripts/nsdsh/verify-distribution.mjs --artifact .nsdsh/dist/runtime.zip
node scripts/nsdsh/compare-runtime-bc.mjs --artifact .nsdsh/dist/runtime.zip
```

本轮实测结果：

```
包：503 个；条目：22,530 个；净体积：235.8MB（解压后）
归档：69.5MB  sha256=7bfc4f19c1c7b267ac8760d539792fc55f29dc87869b048071aed70f4cd7b5b2
```

## 2. 打包器做了什么（以及为什么这么做）

`scripts/nsdsh/package-runtime.mjs`：

1. 从 `vendor/dsh/runtime-manifest.json` 的 `closure.requiredPackages` 出发 ——
   注意这些是**目录路径**（`apps/cli`、`packages/bundle/sdk-app`），不是包名。
2. 入口包 `@deepseek-ai/dsh` **保留原目录**（于是档案里就是 `apps/cli/lib/bin.js`，
   与 manifest 的 `entry.path` 逐字一致）；其余包**扁平化**到 `node_modules/<name>`。
   Node 从 `apps/cli/lib/bin.js` 往上有四层，第 4 层正好是 `<root>/node_modules`，
   **所以不需要任何 symlink/junction** —— 这是"解压即用"的前提。
3. 依赖展开规则：`dependencies` 必带；`peerDependencies` 只带**非 optional**；
   `optionalDependencies` 只带**装着原生绑定（`.node`）或平台专用**的。
4. 载荷规则：第一方包按 `lib/`（+ `assets/`/`resources/`/`bin/`/根 `*.yml`）裁剪；
   **第三方包保留完整产物**，只剪 `node_modules`、测试、sourcemap。
5. 写出 `runtime-manifest.json`（上游 SHA、平台、Node 要求、入口、逐文件摘要、许可位置、**排除清单**）。

### 2.1 明确排除的东西（可审计，不是"为比例删包"）

| 排除项 | 实测体积 | 为什么 | 缺了会怎样 |
|---|---|---|---|
| `@deepseek-ai/libreoffice-kit-win32-x64` | **325.2MB** | Office 技能的可选原生套件；本发行物按 `sdk`/`sdk-minimal` profile 裁剪 | docx/pptx/xlsx 技能不可用；需要时用完整构建 B |

它进入 `runtime-manifest.json` 的 `excluded` 字段，带着 `reason` 与 `capabilityImpact`。

## 3. 冷环境验收（`verify-distribution.mjs`，8/8）

| # | 检查 | 观测 |
|---|---|---|
| D1 | 档案可解析（ZIP，条目名过穿越检查） | 22,530 条目 / 69.5MB |
| D2 | 解压后带发行清单 | `packages=503 files=22529` |
| D3 | 清单声明的入口真实存在 | `apps/cli/lib/bin.js` |
| D4 | 档案不含 symlink | 22,530 个文件落盘，无外链 |
| D5 | 每个包的 `dependencies` 都能在档案内解析 | 503 个 `package.json` 全自足 |
| D6 | **从解压目录真实启动并跑完一轮协议** | `pid=8488`、`server=deepseek-harness-sdk-runtime`、`terminal=done`、`exit=0`、17 事件 |
| D7 | 假 provider 真收到请求 | 1 次请求 / 24 个工具 |
| D8 | **中文 + 空格路径**同样可运行 | `terminal=done`、`exit=0` |

## 4. B/C 动态等价（`compare-runtime-bc.mjs`，7/7）

B = `../deepseek-harness`（完整构建）；C = 从 ZIP 解压出来的裁剪版。**各起一个独立进程**，
同一 prompt、同一本机假 provider，然后比较：

| # | 比较项 | 观测 |
|---|---|---|
| BC1 | 两边都到终态且 exit 0 | B `pid=19896 done/0`；C `pid=2476 done/0` |
| BC2 | 工具清单逐项一致（含顺序） | 24 = 24 |
| BC3 | 发往模型的消息序列归一化后一致 | 双方摘要同为 `ed29fe10738388f2…` |
| BC4 | 消息角色序列一致 | `[user]` = `[user]` |
| BC5 | 终态事件集合一致 | `[assistant/message, turn/end]` |
| BC6 | 只收到本会话事件 | foreign = 0 / 0 |
| BC7 | C 确实来自裁剪档案 | 503 包 / 22,529 文件 |

### 4.1 归一化只去掉"语义无关"的东西（写清楚，免得变成"调到绿为止"）

- **去掉**：临时根路径（工作目录 / `DSH_HOME` / 其父目录）、UUID、时间戳类键
  （`time`/`ts`/`createdAt`/`updatedAt`/`timestamp`）、`metadata` 等。
- **保留**：工具名与顺序、消息角色序列、消息正文字节、终态事件类型。

### 4.2 一个必须记住的对照前提

B 与 C 跑在**同一个中立工作目录**上。第一版让它们各自以自己的运行时根为 cwd，
于是 B 的 cwd 里有 `AGENTS.md`、C 的没有 —— 注入给模型的 `<system-reminder>` 本来就该不同，
比较随即失去意义（BC3 假红）。**比较两种环境时，先让"环境差异"只剩你要比较的那一个变量。**

## 5. 踩过的坑（都留在代码注释里）

| 现象 | 根因 | 修法 |
|---|---|---|
| `CLOSURE_INCOMPLETE`，78 个包一个都找不到 | `requiredPackages` 是**目录路径**不是包名 | 建 `byDir` + `byName` 双索引 |
| 依赖越补越多，还漏掉 `shebang-command` | 把 pnpm `.pnpm/<id>/node_modules` 全扫进索引，候选涨到 **7 万**并触发上限提前 break | 改为**按需解析**（Node 查找规则走上层），不预扫全仓 |
| 解压后启动即 `ERR_MODULE_NOT_FOUND: js-yaml/dist/…` | 第三方包不遵守 `lib/` 约定；且 `thirdParty` 用**符号链接路径**判定，`apps/cli/node_modules/js-yaml` 以 `apps/` 开头被误判成第一方 | 用 **realpath** 判定；第三方保留完整产物 |
| 启动即 `No usable native binding found` | `optionalDependencies` 里的平台原生包没被遍历 | 遍历 optional，但只带含 `.node` 或平台专用的 |
| 档案 480MB 顶穿上限 | 全量带 optional ⇒ 拖进 325MB 的 LibreOffice 套件 | 显式排除清单（带理由与能力影响），写进 manifest |
| BC3 反复假红 | 临时路径 / UUID / `time` 未归一化；且两边 cwd 不同 | 扩展归一化 + 两个运行时共用中立 cwd |

## 6. 本阶段**没有**证明什么

- **没有**在 Linux / macOS 上打包或运行（产物是 `win32-x64` 专用，含平台原生绑定）→ R03。
- **没有**验证 Office 技能（已显式排除，见 §2.1）。
- **没有**做真实模型调用（零计费纪律）。
- **没有**把这个发行物接进产品安装流程（打包是脚本，不是安装器）。
- 体积对比**不宣称"裁剪 89.1%"**：那是 S14 的**闭包估计**。本阶段给出的是实测：
  完整 monorepo 基线 `355MB`（不含 node_modules）对比发行档案 `69.5MB`（压缩）/`235.8MB`（解压），
  数字口径不同，不构成"删包比例"。

## 7. 回退

- 发行物不合格 → 不分发 C，改用**完整构建 B**（`../deepseek-harness` 原样）；
  一调度所有者不变，故事库与时态 schema 不受影响。
- 打包脚本失败 → 删 `.nsdsh/dist/` 即可，仓库内无残留（产物不入库）。
