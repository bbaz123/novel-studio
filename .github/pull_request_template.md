## 这个 PR 解决什么问题

<!-- 一句话说清动机。如果是修 bug，请关联 issue：Fixes #123 -->

## 改了什么

<!-- 逐条列出改动；涉及判据（阈值/优先级/预算）请说明为什么 -->

## 怎么验证的

请贴出实际执行过的命令与结果，而不是「应该没问题」：

```bash
node .p1-baseline/verify-all.mjs
node .p1-baseline/verify-phase-map.mjs
node .p1-baseline/check-utf8.mjs
```

## 提交前确认

- [ ] 没有引入 npm 依赖（本项目刻意保持零依赖）
- [ ] 新增文件已在阶段映射里认领（`verify-phase-map.mjs` 通过）
- [ ] 没有提交 `data/`、`node_modules/` 或临时探针脚本
- [ ] 行为有变化时，对应文档已同步（含 `docs/context-contract.md` 的数字）
