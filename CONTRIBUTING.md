# 参与贡献

感谢你有兴趣改进 Novel Studio。这个项目目前由作者一个人维护，**Issue 和 PR 都欢迎**——先读完这一页，能省双方很多来回。

## 先开 issue，再写大 PR

- **Bug**：用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml) 提交，请带上 Node 版本、操作系统、复现步骤，以及服务窗口里的报错原文
- **新功能 / 大改动**：先开 issue 说清「要解决什么问题」，方向对齐之后再动手。几十行改动做完才发现方向不对，对双方都是浪费
- **小修复**（错别字、文档、明显的边界 bug）：可以直接开 PR

## 运行与自检

```bash
node -v                  # 需要 22.13 或更高
npm start                # 启动服务，默认 http://localhost:3737

# 离线验证套件：不需要活实例、不需要 API Key、不产生费用
node .p1-baseline/verify-all.mjs

# 仓库自带的两道门禁，改过文件就要跑
node .p1-baseline/verify-phase-map.mjs   # 每个改动都必须在阶段映射里有归属
node .p1-baseline/check-utf8.mjs         # 文本文件必须是合法 UTF-8
```

> ⚠️ `verify-all.mjs` 的汇总会区分**通过 / 未通过 / 跳过**：需要活实例或外部仓库的检查会标成「跳过」，
> **跳过不等于通过**；新增的「未通过」也不要用「跳过」去掩盖。

## 项目约定

- **零 npm 依赖**：`package.json` 里没有 `dependencies`，运行时不引入任何第三方包。加依赖的 PR 基本不会被合
- **纯 ESM**：`.mjs` 与 `"type": "module"`，不使用 CommonJS 的 `require`
- **中文注释解释「为什么」**：不写「这里给变量赋值」，而是写「为什么不用另一种写法」「这个顺序为什么不能换」
- **改判据就要补断言**：阈值、优先级、预算这类判定散落在 `.p1-baseline/` 的离线测试里。改了判据却没补断言，下次会被无意改回去而没人发现
- **不要提交 `data/`**：里面是你的作品与 API Key（已在 `.gitignore` 内，请不要用 `-f` 强推）

## 文档

- `README.md`：面向使用者。第一屏讲清「它解决什么问题」，后半部分才讲实现细节
- `docs/`：契约、实现说明与历史报告。**历史报告描述的是当时的代码**，行号可能已过时——找代码请按符号名
- 改了行为就同步改文档；`docs/context-contract.md` 里的数字必须与 `ai/context/layers.mjs` 的实际取值一致
- `docs/phase-map.md` 由 `node .p1-baseline/verify-phase-map.mjs --write` 生成，不要手改

## 提交 PR 之前

- [ ] `node .p1-baseline/verify-all.mjs` 没有新增「未通过」项
- [ ] `node .p1-baseline/verify-phase-map.mjs` 通过（新文件已在阶段映射里认领）
- [ ] `node .p1-baseline/check-utf8.mjs` 通过
- [ ] 没有把 `data/`、`node_modules/` 或临时探针脚本混进提交

## 许可证

⚠️ 本仓库**目前尚未声明开源许可证**（默认保留所有权利）。在补上 LICENSE 之前提交 PR，请知悉：作者尚未就衍生作品的分发条款作出授权。
