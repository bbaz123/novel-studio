/**
 * 时态故事状态引擎 · 唯一对外入口。
 *
 * 消费方（server.js / 测试 / 插件探测）只从这里 import，避免出现
 * 「改了某模块导出名、某个调用方还在用旧路径」的运行时漂移。
 * 组合入口在 service.mjs：recordContentSave / applyChapterEvents / chapterPanel。
 */
export * from './schema.mjs';
export * from './reducer.mjs';
export * from './order.mjs';
export * from './config.mjs';
export * from './revision-store.mjs';
export * from './snapshot.mjs';
export * from './event-store.mjs';
export * from './extraction.mjs';
export * from './analysis.mjs';
export * from './worldline-store.mjs';
export * from './history.mjs';
export * from './validation.mjs';
export * from './projection.mjs';
export * from './dependencies.mjs';
export * from './impact.mjs';
export * from './service.mjs';
export * from './context-provider.mjs';
export * from './compat.mjs';
export * from './migration.mjs';
export const TEMPORAL_VERSION = '1.2.0';
