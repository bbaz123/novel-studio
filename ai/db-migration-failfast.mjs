/**
 * ai/db-migration-failfast.mjs —— 迁移失败的 fail-fast 判据（P13，2026-10-18）。
 *
 * 为什么单独成模块：判据必须在**没有数据库句柄**的情况下也能被离线断言。
 * db.js 在模块顶层就会打开数据库；把"哪些失败必须阻止启动"写成一个纯函数，
 * 测试才能用假失败列表证明"真实失败 → 抛错 / 空列表 → 放行"，
 * 而不是只能靠"起一个坏库"来间接观察。
 *
 * 纪律：
 *   · `duplicate column` 属于幂等跳过（旧库手工加过列），调用方已把它记账、不进本列表；
 *   · 其它任何迁移失败都必须让进程**非零退出**，服务不得进入可写 ready。
 */

/**
 * 由迁移失败列表构造错误对象（不抛，便于调用方决定退出方式）。
 * @param {{id:string,message:string}[]} failures
 * @returns {Error}
 */
export function migrationFailureError(failures) {
  const list = Array.isArray(failures) ? failures.filter(Boolean) : [];
  const detail = list.map((f) => `${f.id}（${f.message}）`).join('；');
  const err = new Error(`数据库迁移失败 ${list.length} 条，服务不会进入可写状态：${detail}`);
  err.code = 'DB_MIGRATION_FAILED';
  err.migrations = list.map((f) => String(f.id));
  err.detail = detail;
  return err;
}

/**
 * 断言所有迁移都已成功应用；有失败则抛 `DB_MIGRATION_FAILED`。
 * @param {{id:string,message:string}[]} failures
 * @returns {{ok:true}}
 */
export function assertMigrationsApplied(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return { ok: true };
  throw migrationFailureError(failures);
}
