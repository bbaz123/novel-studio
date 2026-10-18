/**
 * 词条版本化（P1-1，v1.2.2）——世界观词条不可变版本 + 当前指针 + 回滚。
 *
 * 为什么需要它（《v1.2.1 审稿闭环方案》§9.1(2)）：
 *   审稿与修稿都要判断"这个术语/等级口径与词条是否一致"。如果词条只有一行当前值，
 *   修稿时引用的版本和作者后来改过的版本无法区分——"按旧词条判定冲突"会被误当成真冲突，
 *   而"按新词条改正文"又没有人能证明改的是哪一版。
 *
 * 纪律：
 *   · **追加式**：每次保存产生一条不可变版本；回滚也是新增一版（不删除、不覆盖历史）；
 *   · **当前指针**：`world_entries.version` 指向最新版本号，`world_entry_versions` 是完整历史；
 *   · **幂等**：同一版本号已经写过就不再写（重复保存同内容不会刷出垃圾历史）；
 *   · 本模块只读写这两张表，不碰正文、不碰 story_facts。
 */

export const ENTRY_VERSIONING_VERSION = 1;

const num = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

export function createEntryVersioning({ db, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('entry-versioning 需要 sqlite 连接');

  const currentRow = (entryId) => db.prepare('SELECT * FROM world_entries WHERE id = ?').get(Number(entryId)) || null;

  function writeVersion(row, version, { note = '', source = 'save' } = {}) {
    db.prepare(`INSERT INTO world_entry_versions
      (entry_id, work_id, version, title, content, keywords, priority, is_pinned, note, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        Number(row.id), Number(row.work_id), Number(version),
        String(row.title || ''), String(row.content || ''), String(row.keywords || ''),
        num(row.priority, 50), Number(row.is_pinned) ? 1 : 0,
        String(note || '').slice(0, 200), String(source || 'save').slice(0, 40), now(),
      );
  }

  /**
   * 为"当前内容"落一版。若该版本号已存在则不重复写（幂等）。
   * @returns {{entry_id:number, version:number, inserted:boolean}|null}
   */
  function snapshot(entryId, opts = {}) {
    const row = currentRow(entryId);
    if (!row) return null;
    const version = Math.max(1, num(row.version, 1));
    const existing = db.prepare('SELECT id FROM world_entry_versions WHERE entry_id = ? AND version = ?')
      .get(row.id, version);
    if (existing) return { entry_id: Number(row.id), version, inserted: false };
    writeVersion(row, version, opts);
    return { entry_id: Number(row.id), version, inserted: true };
  }

  /** 保存后调用：版本号 +1 再落历史（版本号只增不减）。 */
  function bumpAndSnapshot(entryId, opts = {}) {
    const row = currentRow(entryId);
    if (!row) return null;
    const next = Math.max(1, num(row.version, 1)) + 1;
    db.prepare('UPDATE world_entries SET version = ? WHERE id = ?').run(next, Number(entryId));
    return snapshot(entryId, opts);
  }

  function list(entryId) {
    const row = currentRow(entryId);
    if (!row) return null;
    return {
      entry_id: Number(row.id),
      work_id: Number(row.work_id),
      current_version: Math.max(1, num(row.version, 1)),
      versions: db.prepare('SELECT version, title, note, source, created_at FROM world_entry_versions WHERE entry_id = ? ORDER BY version DESC')
        .all(Number(entryId))
        .map((v) => ({ ...v, version: Number(v.version) })),
    };
  }

  function getVersion(entryId, version) {
    return db.prepare('SELECT * FROM world_entry_versions WHERE entry_id = ? AND version = ?')
      .get(Number(entryId), Number(version)) || null;
  }

  /** 两个版本之间变化的字段（只做展示，不参与判据）。 */
  function diff(entryId, fromVersion, toVersion) {
    const a = getVersion(entryId, fromVersion);
    const b = getVersion(entryId, toVersion);
    if (!a || !b) return null;
    const fields = ['title', 'content', 'keywords', 'priority', 'is_pinned'];
    return fields.filter((f) => String(a[f]) !== String(b[f])).map((f) => ({
      field: f, from: a[f], to: b[f],
    }));
  }

  /**
   * 回滚到某一版：把该版内容写回当前行，并**新增**一版（不回删历史）。
   * @returns {{ok:true, version:number, restored_from:number}|{ok:false, code:string}}
   */
  function rollback(entryId, version, { note = '' } = {}) {
    const row = currentRow(entryId);
    if (!row) return { ok: false, code: 'ENTRY_NOT_FOUND' };
    const target = getVersion(entryId, version);
    if (!target) return { ok: false, code: 'VERSION_NOT_FOUND' };
    const next = Math.max(1, num(row.version, 1)) + 1;
    db.prepare(`UPDATE world_entries SET title = ?, content = ?, keywords = ?, priority = ?, is_pinned = ?, version = ?, updated_at = ?
      WHERE id = ?`).run(
      String(target.title || ''), String(target.content || ''), String(target.keywords || ''),
      num(target.priority, 50), Number(target.is_pinned) ? 1 : 0, next, now(), Number(entryId),
    );
    writeVersion(currentRow(entryId), next, { note: note || `rollback to v${version}`, source: 'rollback' });
    return { ok: true, version: next, restored_from: Number(version) };
  }

  return { snapshot, bumpAndSnapshot, list, getVersion, diff, rollback, currentRow };
}

/**
 * 修稿验收用：引用版本与当前版本是否一致（纯函数）。
 * 不一致时不能说"按词条判定冲突"——那可能是按旧词条得出的结论。
 */
export function entryVersionVerdict({ referencedVersion, currentVersion } = {}) {
  const ref = Number(referencedVersion);
  const cur = Number(currentVersion);
  if (!Number.isInteger(ref) || !Number.isInteger(cur)) {
    return { ok: false, code: 'ENTRY_VERSION_UNKNOWN', reason: '缺少可核对的词条版本号' };
  }
  if (ref !== cur) {
    return { ok: false, code: 'ENTRY_VERSION_STALE', reason: `引用的词条 v${ref} 已不是当前版 v${cur}：不能按旧口径判定冲突` };
  }
  return { ok: true, code: 'ENTRY_VERSION_MATCH', reason: `词条版本一致（v${cur}）` };
}
