/**
 * 时态故事状态 · 进程内预处理语句缓存。
 *
 * 为什么需要：node:sqlite 的 db.prepare 每次调用都有解析/编译成本；
 * 时态读取路径（历史归约、绑定/事件/修订读取、失效写入）在长篇小说上
 * 会重复执行同样的 SQL 成千上万次。语句对象在 node:sqlite 里可安全复用
 * （每次执行自动重置绑定），SQL 文本在本模块的使用方中全部是静态字面量，
 * 因此以 SQL 文本为键缓存语句即可，缓存规模有界。
 *
 * 纪律：只缓存成功编译的语句；首次失败（例如表缺失）不写入缓存，
 * 迁移门禁等场景仍会在下一次调用时如实报错。
 */
import { db } from '../../../db.js';

const cache = new Map();

export function prep(sql) {
  const key = String(sql);
  let stmt = cache.get(key);
  if (!stmt) {
    stmt = db.prepare(key);
    cache.set(key, stmt);
  }
  return stmt;
}
