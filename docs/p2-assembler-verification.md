# P2 验收报告：唯一上下文装配器

> 阶段：P2（重建唯一上下文装配器 · 预算自动核算 + 裁剪清单）
> 日期：2026-09-15　状态：**完成**（I4「凡裁剪必可查回」的项目留给 P3）

---

## 一、做了什么

| # | 改动 | 文件 |
|---|---|---|
| 1 | 层规格抽为**唯一来源**（13 层的 cap / kind / 收缩属性 / 模式差异） | `ai/context/layers.mjs`（新） |
| 2 | **唯一装配器**：渲染、每层 cap、总预算收敛、裁剪清单、溢出标记 | `ai/context/assembler.mjs`（新） |
| 3 | `buildNovelContext` 改为「只取数 + 调用装配器」，cap 不再内联 | `server.js` |
| 4 | **主成文路径收敛**：`/api/ai_context` 也返回装配器产出的分层文本 | `server.js` |
| 5 | 前端提示词改用服务端文本（保留旧拼装作兜底） | `public/app.js` |
| 6 | 上下文缓存补**时间上界**（修 P1 发现 F4） | `server.js` |
| 7 | 装配器产出 `context_manifest` / `context_overflow` / `context_stats` | `server.js` |

---

## 二、验收证据（四条，全部可复现）

### 1. 抽取是行为等价的 —— 55/55 逐字节一致

同一批用例，新旧实现的 `assembled` **逐字节相同**：

```
真实数据  20/20 逐字节一致
压力数据  35/35 逐字节一致
```

覆盖了 `continuation` 的 4000 档、角色卡的 `Infinity`（层不做二次截断），
以及压力数据下真实触发的**收敛循环**。→ 抽取阶段没有引入任何行为变化。

### 2. 主成文路径已收敛到同一装配器 —— 两条路径逐字节相同

对同一章，`/api/ai_context` 的 `assembled` 与 `/api/novel/context?mode=full` 的
`assembled` **逐字节相同**（`verify-p3-unified.mjs`，3/3 通过）。

收敛效果（这是对「上下文质量」最直接的改善）：

| 用例 | 改造前 P3 输入规模（无预算） | 改造后 | 收敛 |
|---|---|---|---|
| 压力章 #227 | 91,560 字 | 24,738 字 | **−73%** |
| 压力章 #108 | 73,416 字 | 22,158 字 | **−70%** |
| 真实章 #107 | 6,667 字 | 6,710 字 | 无截断（本来就远低于预算） |

### 3. 契约不变量已可机器校验

新增 `verify-invariants.mjs`，逐用例校验：

```
✓ I1 预算上界 / I2 cap 硬上界 / I3 零损失层未被收缩 / I7 清单自洽：全部成立
```

- **I1**：装配结果 ≤ 总预算；超限必须有 `context_overflow` 标记（当前数据下不可达，
  属防御性断言——诚实标注：**未被真实用例触发过**）
- **I2**：正文采用量 ≤ cap；渲染占用 ≤ 标题 + cap + 提示语的核算上界
- **I3**：零损失层（fixed）的 cap 必须始终等于规格值，不参与收敛链
- **I7**：各层占用之和 + 层间分隔 == `assembled` 长度（清单与文本自洽）

### 4. 无回归

排除 `ai_context`（其新增 `assembled` 是预期变更）后：

```
真实  novel/context 用例: 16/16 逐字节一致
压力  novel/context 用例: 28/28 逐字节一致
```

### 附：F4 修复的决定性验证

绕过后端**直接改数据库**（不触发 `touchWork`，缓存版本号不变），观察是否读到新数据：

| 缓存 TTL | 结果 |
|---|---|
| 1 ms | ✓ 读到新数据（缓存已过期） |
| 600,000 ms（对照） | ✓ 仍返回旧数据（缓存确实拦住了它） |

对照成立 ⇒ 短 TTL 那次的"读到新数据"确实是 TTL 起的作用，而非其它因素。

---

## 三、P2 对契约的修正（两处口径澄清）

1. **`cap` 的定义明确为「正文上限」**（不含层标题与截断提示语）。
   层的真实占用 = 标题 + cap + 提示语，可核算。这不减少任何正文——
   是把原本含糊的"上限"变成精确、可断言的口径。
2. **I3 的口径拆分**：「零损失层不参与**收敛收缩**」与「零损失层仍受**自身 cap 截断**」
   是两件事。校验器最初把两者混为一谈，误报 48 处，已修正。

---

## 四、留给 P3 的工作清单（I4：凡裁剪必可查回）

校验器输出的实测损失（压力数据，15 个用例累计）：

| 层 | 类型 | 单次最多裁掉 | 累计 | 说明 |
|---|---|---|---|---|
| `world` 世界观 | flex | 17,559 | 232,585 | 未激活词条无检索路径 |
| `outline` 大纲 | flex | 11,309 | 139,435 | 中间章节被省略 |
| **`memory` 长期记忆** | **fixed** | **6,863** | **102,945** | 超出 2200 字的尾部**检索查不回** |
| **`events` 事件账本** | **fixed** | **4,620** | **69,300** | 无对应工具 |
| **`foreshadows` 伏笔** | **fixed** | **2,117** | **31,755** | 超出 20 条的部分不可见 |
| **`redlines` 写作红线** | **fixed** | **1,394** | **20,910** | 超出 4000 字的部分不可见 |
| `recall` 语义召回 | cond | 1,261 | 18,895 | 单段截 300 字 |
| `relations` 人物关系 | cond | 1,974 | 14,810 | 描述截 160 字 |
| `story_tail` 前文衔接 | flex | 2,400 | 12,000 | 可接受（正文本身在库里） |
| `blueprint` 本章蓝图 | cond | 2,140 | 8,560 | 字段各截 600 字 |

**其中 4 个是零损失层**（`memory` / `events` / `foreshadows` / `redlines`）——
它们被自身 cap 截断，而契约 I4 要求这些内容必须能通过工具查回。**P3 的直接输入。**

---

## 五、复现

```powershell
# 隔离实例（主实例 3737 与真实库全程未动）
$env:NOVELSTUDIO_DATA_DIR='.p1-baseline/data';        $env:PORT='3738'; node server.js
$env:NOVELSTUDIO_DATA_DIR='.p1-baseline/stress-data'; $env:PORT='3739'; node server.js

# 1) 抽取等价性（抓取后与 P1 基线对照）
node .p1-baseline/capture-baseline.mjs --base http://127.0.0.1:3739 --db .p1-baseline/stress-data/novel.db --out .p1-baseline/baselines-p2final-stress
node .p1-baseline/compare-baseline.mjs .p1-baseline/baselines-stress .p1-baseline/baselines-p2final-stress

# 2) 主成文路径统一
node .p1-baseline/verify-p3-unified.mjs http://127.0.0.1:3739 .p1-baseline/stress-data/novel.db 108 227

# 3) 契约不变量 + I4 工作清单
node .p1-baseline/verify-invariants.mjs .p1-baseline/baselines-p2final-stress

# 4) F4 缓存 TTL（用极短/极长 TTL 做对照）
$env:NOVELSTUDIO_CONTEXT_CACHE_TTL_MS='1'; node server.js
```
