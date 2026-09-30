/**
 * 时态故事状态 · 依赖索引（记录"这一章建立在前面的什么之上"）。
 *
 * 依赖来源 = 事件 ops 的 `expected` 前置条件：一个 op 说「把 X 从旧值改成新值」，
 * 就意味着该章依赖 X 的旧值成立（包括"当时不存在"= missing）。这是**确定性**提取，
 * 不需要模型；召回/摘要等语义依赖由 T3 的分析运行补充为 kind='summary'/'causal'。
 *
 * 纪律：依赖索引用于解释与排序，**不得**用于排除隐性影响（T3 必须仍把所有下游
 * 章节送入重新验证）；本模块不做失效判定（见 impact.mjs）。
 */
import { db, inTransaction, withTransaction } from '../../../db.js';
import { prep } from './stmt.mjs';
import { canonicalJson, hashJson, parseCellKey, sha16 } from './schema.mjs';
const now = () => new Date().toISOString();
const DOMAIN_KIND = {
  character: 'character', relation: 'relation', plotline: 'plotline', foreshadow: 'plotline',
  knowledge: 'knowledge', disclosure: 'disclosure', event: 'event', appearance: 'chapter',
  goal: 'goal', promise: 'goal', task: 'goal', world_fact: 'fact', location: 'fact',
  faction: 'fact', item: 'fact', premise: 'context',
};
export function kindOfDomain(domain) {
  return DOMAIN_KIND[domain] || 'unknown';
}
export function resourceKeyOfCell(cellKey) {
  return `cell:${cellKey}`;
}
/**
 * 提取一批事件的全部依赖行（纯函数，不写库）。
 * @returns {Array<object>} 依赖行（待落库）
 */
export function dependenciesFromEvents(events, { workId = 0, bindingId = '' } = {}) {
  const out = [];
  for (const event of events || []) {
    for (const op of event.ops || []) {
      if (!op || !op.cell) continue;
      let key = op._key;
      if (!key) {
        try { key = canonicalJson([op.cell.domain, op.cell.entityId, op.cell.predicate, op.cell.scope || 'canon', op.cell.scope === 'character' ? op.cell.holderId : null]); } catch { continue; }
      }
      const expected = op.expected || { kind: 'missing' };
      const expectedHash = expected.kind === 'missing' ? 'missing' : hashJson(expected.value ?? null);
      const cell = parseCellKey(key);
      const resourceKey = resourceKeyOfCell(key);
      const material = `${workId}|${bindingId}|${resourceKey}|${expectedHash}|${event.id || ''}`;
      out.push({
        id: 'dep_' + sha16(material),
        work_id: Number(workId) || 0,
        binding_id: String(bindingId || ''),
        kind: kindOfDomain(cell.domain),
        resource_key: resourceKey,
        expected_hash: expectedHash,
        dependency_json: {
          cell,
          cell_key: key,
          op_type: op.type,
          expected_kind: expected.kind,
          expected_hash: expectedHash,
          chapter_id: Number(event.chapter_id) || 0,
          revision_id: String(event.revision_id || ''),
          event_id: String(event.id || ''),
          narrative: Array.isArray(event.evidence) && event.evidence[0] ? String(event.evidence[0].narrative || 'unknown') : 'unknown',
        },
      });
    }
  }
  return out;
}
/** 落库依赖行（幂等：同 binding + 同资源 + 同 expected 只保留一条）。 */
export function recordDependencies({ workId, bindingId, events }) {
  const rows = dependenciesFromEvents(events, { workId, bindingId });
  const write = () => {
    const ts = now();
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params = [];
      for (const row of chunk) {
        params.push(row.id, row.work_id, row.binding_id, row.kind, row.resource_key, row.expected_hash, JSON.stringify(row.dependency_json), ts);
      }
      db.prepare(`INSERT OR IGNORE INTO story_chapter_dependencies
        (id, work_id, binding_id, kind, resource_key, expected_hash, dependency_json, created_at)
        VALUES ${values}`).run(...params);
    }
  };
  if (inTransaction()) write(); else withTransaction(write);
  return rows;
}
function publicRow(row) {
  let dependency = {};
  try { dependency = JSON.parse(row.dependency_json); } catch { dependency = {}; }
  return {
    id: String(row.id), work_id: Number(row.work_id), binding_id: String(row.binding_id),
    kind: String(row.kind), resource_key: String(row.resource_key), expected_hash: String(row.expected_hash || ''),
    dependency,
  };
}
export function dependenciesOfBinding(bindingId) {
  return prep('SELECT * FROM story_chapter_dependencies WHERE binding_id = ? ORDER BY id ASC')
    .all(String(bindingId || '')).map(publicRow);
}
export function dependenciesOfChapter(workId, chapterId) {
  return prep(`SELECT d.* FROM story_chapter_dependencies d
    JOIN story_chapter_bindings b ON b.id = d.binding_id
    WHERE d.work_id = ? AND b.chapter_id = ? ORDER BY d.id ASC`)
    .all(Number(workId) || 0, Number(chapterId) || 0).map(publicRow);
}
/** 资源集合 → 依赖它的 binding（T3 语义分析的候选种子）。 */
export function bindingsDependingOn(workId, resourceKeys = []) {
  const keys = [...new Set((resourceKeys || []).map(String))];
  if (!keys.length) return [];
  // 分块（SQLite 变量上限）：资源很多时一次性拼接会直接超限。
  const out = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    out.push(...db.prepare(`SELECT * FROM story_chapter_dependencies WHERE work_id = ? AND resource_key IN (${placeholders})`)
      .all(Number(workId) || 0, ...chunk).map(publicRow));
  }
  return out;
}
/** 某一章（按 binding）主动声明的依赖摘要。 */
export function summarizeDependencies(rows) {
  const byKind = {};
  const resources = new Set();
  for (const row of rows || []) {
    byKind[row.kind] = (byKind[row.kind] || 0) + 1;
    resources.add(row.resource_key);
  }
  return { total: (rows || []).length, resources: [...resources], by_kind: byKind };
}
