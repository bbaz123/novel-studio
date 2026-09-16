# ai/context —— 上下文装配内核

本目录是 novel-studio **AI 内核的上下文装配层**，P2 阶段从 `server.js` 里抽出来，
目的是让「上下文」成为一个可被断言、可被对照、可被复现的东西，而不是散落在
各处的一段段字符串拼接。

## 文件

| 文件 | 作用 |
|---|---|
| `layers.mjs` | **层规格的唯一来源**：13 层的 id / 标题 / 正文 cap / kind（fixed·flex·cond·entity）/ 收缩属性 / 模式差异；并导出可执行下限核算 `computeFloor()` |
| `assembler.mjs` | **唯一装配器**：按预算渲染各层、执行收敛收缩、产出裁剪清单与溢出标记。纯函数、零依赖、不碰数据库 |

## 为什么要有它

在 P2 之前，同一份上下文存在**四条互不相同的装配路径**，其中实际用来写正文的那条
（前端 `aiContextBlock`）**完全没有预算**——压力数据下同一章它喂进模型约 7.4 万字，
而受预算约束的路径只有 2.4 万字。两条路径渲染同一份数据却差 3 倍，
这是上下文质量最大的结构性缺口。

现在：**服务端装配一次，两条路径共用同一段文本**。前端只负责把它放进提示词。

## 契约

不变量（I1–I7）与逐层规格见 `docs/context-contract.md`；
P2 的验收证据见 `docs/p2-assembler-verification.md`；
可复现的对照工具在 `.p1-baseline/`（`compare-baseline.mjs` / `verify-invariants.mjs` /
`verify-p3-unified.mjs`）。

## 改动须知

- **不要**在 `server.js` 里重新内联 cap：层规格只在 `layers.mjs` 一处维护。
  `buildNovelContext` 里若出现未知的层 id，装配器会**直接抛错**（宁可响亮失败，
  也不要静默丢层）。
- 新增一层 → 在 `layers.mjs` 里加规格，然后跑
  `node .p1-baseline/verify-invariants.mjs <基线目录>` 确认不变量仍成立。
- 改动层规格或收敛顺序 → **必须**重抓基线并与旧基线对照：
  `capture-baseline.mjs` → `compare-baseline.mjs`。任何差异都要能解释。
- `cap` 是**正文**上限，不含层标题与截断提示语；层的真实占用由
  `headerOf(label) + cap + truncationNotice()` 给出，可用 `renderedCapOf()` 取。
