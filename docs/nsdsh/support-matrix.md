# NSDSH 支持矩阵（R03）

> **状态口径**：本文只写**有观测证据**的格子。没跑过的一律 `UNVERIFIED`，
> 绝不用 Windows 的结果代替其它平台。
> **更新规则**：一格从 `UNVERIFIED` 变成 `VERIFIED` 的唯一依据是
> "同一 Git SHA + 绿色 CI run URL + 原始测试摘要 + 真实制品哈希"。

---

## 1. 为什么单列一份矩阵

产品主程序（离线可用、无 AI）与**可选的内置 DSH 运行时**是两个不同的承诺：

- 主程序只需要 Node 与 `node:sqlite`；
- 内置运行时还额外需要**锁定上游的完整构建**、平台原生绑定，以及 profile 组装。

把两者混成一句"支持 Node ≥ 22"会掩盖真实的兼容边界。方案 §5.1 要求分别出矩阵 —— 本文照做。

## 2. Node 最低版本（两个数不一样，这是重点）

| 场景 | 最低 Node | 依据 |
|---|---|---|
| **无 AI 模式**（写作/保存/检索，不启用内置运行时） | **≥ 22.13.0** | 产品 `package.json` 的 `engines.node` |
| **内置 AI 运行时**（`NOVELSTUDIO_SDK_ROUTE` 打开） | **`^22.19.0 \|\| >=24.0.0`** | 锁定上游 `deepseek-harness@0.1.7-rc.1` 的 `engines.node`；与产品约束取**交集** |

> 本机实测 Node `v24.19.0`，落在两个区间里。**没有**在 22.x 上验证过 —— 这一格也是 `UNVERIFIED`。

## 3. 平台 × 能力矩阵

图例：`VERIFIED` = 本机真跑过并留下退出码/计数；`UNVERIFIED` = 没跑过；`NOT_APPLICABLE` = 该平台不存在此问题。

| 能力 | Windows 11 x64 | Ubuntu x64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| 离线清单 55 项 | **VERIFIED**（55/55，exit 0，145s） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| NSDSH 套件 49 套件 / 364 断言 | **VERIFIED**（0 失败，exit 0） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 阶段门禁 S00–S18 | **VERIFIED**（S00 PASS / S01 PARTIAL / S02–S18 PASS） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 真实 SDK 子进程（12 场景） | **VERIFIED**（12/12，exit 0；真 PID / 真终态 / 真取消） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 裁剪发行物产出 | **VERIFIED**（503 包 / 22,530 条目 / 69.5MB / sha256 `7bfc4f19…`） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 发行物冷环境运行（含中文+空格路径） | **VERIFIED**（8/8，`terminal=done`，exit 0） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| B/C 动态等价（两个独立进程） | **VERIFIED**（7/7，消息摘要一致） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 迁移演练（旧库 → 新 schema） | **VERIFIED**（S16 套件 9/0） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 前端执行验证（vm + DOM 桩） | **VERIFIED**（离线清单内 8114ms） | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Node 22.x（任一平台） | UNVERIFIED（只测了 24.19.0） | UNVERIFIED | UNVERIFIED | UNVERIFIED |

**已测平台原始记录**：`win32 10.0.26200 x64` / node `v24.19.0` / AMD Ryzen 7 5700X / 32690MB。

## 4. 跨平台 CI 怎么验（`.github/workflows/nsdsh-runtime-matrix.yml`）

**⚠️ 这个 workflow 从未在 GitHub Actions 上跑过**（本机无 CI 凭据、仓库未 push）。
所以上表里除 Windows 外全是 `UNVERIFIED` —— 写了 workflow ≠ 证明某平台可用。

它分三层，刻意不把重前置塞进常规 CI：

| job | 需要锁定上游 | 内容 |
|---|---|---|
| `offline` | 否 | 三平台矩阵：打印平台事实（platform / arch / OS release / node / SQLite）、离线清单、NSDSH 套件、S18 门禁、阶段台账、UTF-8、交付验收 |
| `runtime-build` | **是** | 取同 SHA 的上游到兄弟目录 → `pnpm install --frozen-lockfile` → typecheck/build/lint → `verify-vendor` → `verify-sdk-real`（12 场景） |
| `distribution` | **是**（默认不跑） | 打包 → 冷环境验收 → B/C 等价 → 上传带 SHA-256 清单的 artifact |

纪律：不写 `continue-on-error` 把失败变绿；拿不到锁定上游时 job **失败并打印原因**，不静默 skip。

## 5. 平台差异清单（写进 CI 之前必须先想清楚的东西）

| 差异点 | Windows | POSIX | 本项目状态 |
|---|---|---|---|
| 进程树清理 | `taskkill /PID <pid> /T /F` | 先 SIGTERM，超时 SIGKILL | 两边都实现（`terminateProcessTree`），只验证过 Windows |
| 路径分隔符 / 空格 / 中文 | 反斜杠 + 盘符 | 正斜杠 | **发行物已在中文+空格路径下验证**（Windows） |
| 原生绑定 | `-win32-x64-msvc` | `-linux-*-gnu` / `-darwin-*` | 只打包过 Windows 绑定 |
| `HOME` / `USERPROFILE` | `USERPROFILE` | `HOME` | 环境白名单同时接受两者 |
| shell 工具 | `pwsh` | `bash` | `sdk-minimal` 真实工具面随平台不同，脚本已按 `process.platform` 断言 |
| SQLite | `node:sqlite` 内置 | 同 | 只验证过 Windows |

## 6. 未验证就必须这么说

- **不在 macOS/Linux 上承诺"内置 AI 运行时可用"** —— 一格证据都没有。
- 发行物**只对 `win32-x64` 有效**（含平台原生绑定），其它平台必须重新打包。
- Node 22.x 未验证（虽然落在 engines 区间内）。

## 7. 把某个格子变成 VERIFIED 的清单（照做即可）

1. 在该 runner 上 checkout **同一 Git SHA**；
2. 按 §4 的 `runtime-build` 步骤准备锁定上游（同 tag / 同 SHA），`verify-vendor` 必须 exit 0；
3. 跑 `node scripts/ci-offline-checks.mjs`、`node scripts/run-nsdsh-tests.mjs`、
   `node scripts/nsdsh/check-stage.mjs S18 --offline`、`node scripts/nsdsh/verify-sdk-real.mjs`；
4. 需要发行物时跑 `package-runtime.mjs` + `verify-distribution.mjs` + `compare-runtime-bc.mjs`；
5. 记录：run URL、commit SHA、每步退出码与计数、artifact SHA-256、runner 的 OS release；
6. 只有 1–5 全部齐备，才把该格改成 `VERIFIED`。
