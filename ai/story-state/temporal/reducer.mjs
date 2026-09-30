/**
 * 时态故事状态 · 纯 reducer（不碰数据库；批内原子）。
 *
 * 纪律：
 *   · 前置条件不满足就抛 PRECONDITION_FAILED —— 不自动补写、不偷改 expected；
 *   · before 状态从不被污染（副本归约）；同批重复事件被拒绝；
 *   · state_content_hash 只算规范化业务状态（时间戳/随机 id 不进入）；
 *   · lineage_hash 算来源（提交/修订/事件集/顺序/算法版本），与业务哈希严格分开。
 */
import { canonicalJson, hashJson, parseCellKey } from './schema.mjs';

const MAX_DEPTH = 32;

function assertJson(value, label) {
  try {
    canonicalJson(value, 0);
  } catch (e) {
    throw new TypeError(`${label}: ${e.message}`);
  }
}

/** 把存储里的 state_json 解析成 Map（键 = cellKey）。 */
export function stateFromJson(stateJson) {
  const raw = typeof stateJson === 'string' ? JSON.parse(stateJson || '{}') : (stateJson || {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('STATE_MUST_BE_OBJECT');
  const map = new Map();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) throw new TypeError('STATE_KEY_MUST_BE_STRING');
    parseCellKey(k);            // 键必须是合法 cell 键（防任意属性路径）
    assertJson(v, 'STATE_VALUE');
    map.set(k, v);
  }
  return map;
}

export function stateToJson(state) {
  if (!(state instanceof Map)) throw new TypeError('STATE_MUST_BE_MAP');
  const out = {};
  for (const [k, v] of state.entries()) out[k] = v;
  return out;
}

export function stateContentHash(state) {
  if (!(state instanceof Map)) throw new TypeError('STATE_MUST_BE_MAP');
  const pairs = [...state.entries()];
  if (pairs.some(([k]) => typeof k !== 'string')) throw new TypeError('STATE_KEY_MUST_BE_STRING');
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hashJson(pairs);
}

/**
 * 批内原子归约：前置条件不满足就抛错，before 从不被污染。
 * events 在调用前必须完成类型、证据、领域规则及权限校验（storage 层落库前的 normalizeEvent）。
 * 全局幂等由提交/事件集约束保证；此处额外拒绝批内重复事件 id。
 */
export function reduceBatch(before, events) {
  if (!(before instanceof Map)) throw new TypeError('STATE_MUST_BE_MAP');
  const next = new Map([...before.entries()].map(([k, v]) => [k, structuredClone(v)]));
  return reduceBatchInPlace(next, events);
}

/**
 * 就地归约（性能路径；调用方必须独占 state）。
 * 语义与 reduceBatch 完全一致：批内原子（失败时用撤销日志回退本批全部写入后再抛）、
 * 不污染批次之前的状态。差别只有两点：
 *   ① 不做整表深拷贝——省掉每批 O(状态规模) 的 structuredClone；
 *   ② 不做整表 canonicalJson 预检——值的 JSON 合法性由 stateFromJson / 落值时的 assertJson
 *      保证，仅在真正读到某个值时按需判定（对合法输入，结论与旧实现一致）。
 */
export function reduceBatchInPlace(state, events) {
  if (!(state instanceof Map)) throw new TypeError('STATE_MUST_BE_MAP');
  if (!Array.isArray(events)) throw new TypeError('EVENTS_MUST_BE_ARRAY');
  const undo = [];
  const seen = new Set();
  try {
    for (const event of events) {
      if (!event || typeof event.id !== 'string' || !event.id || seen.has(event.id) || !Array.isArray(event.ops)) {
        throw new TypeError('INVALID_OR_DUPLICATE_EVENT');
      }
      seen.add(event.id);
      for (const op of event.ops) {
        if (!op || !['set', 'unset'].includes(op.type)) throw new TypeError('INVALID_OPERATION');
        const key = typeof op._key === 'string' ? op._key : cellKeyOf(op.cell);
        const expected = op.expected;
        if (!expected || !['missing', 'value'].includes(expected.kind)) throw new TypeError('EXPECTED_VALUE_REQUIRED');
        const matches = expected.kind === 'missing'
          ? !state.has(key)
          : state.has(key) && canonicalJson(state.get(key)) === canonicalJson(expected.value);
        if (!matches) {
          const error = new Error(`PRECONDITION_FAILED:${event.id}`);
          error.code = 'PRECONDITION_FAILED';
          error.eventId = event.id;
          error.cell = key;
          throw error;
        }
        if (op.type === 'unset') {
          undo.push([key, state.has(key), state.get(key)]);
          state.delete(key);
        } else {
          assertJson(op.value, 'OP_VALUE');
          undo.push([key, state.has(key), state.get(key)]);
          state.set(key, structuredClone(op.value));
        }
      }
    }
  } catch (e) {
    for (let i = undo.length - 1; i >= 0; i -= 1) {
      const [key, had, value] = undo[i];
      if (had) state.set(key, value); else state.delete(key);
    }
    throw e;
  }
  return state;
}

function cellKeyOf(cell) {
  // 惰性引用，避免顶层循环依赖：normalizeOp 已把 _key 挂在 op 上；直接调用场景很少。
  return JSON.stringify([cell.domain, cell.entityId, cell.predicate, cell.scope || 'canon', cell.scope === 'character' ? cell.holderId : null]);
}

/**
 * 验证结论：任何"没检查完/上游不可信/有未决项"都不得当作 valid。
 * conflicts / unresolved 必须由服务端真实义务计算，不能照抄模型自报布尔值。
 */
export function validationDecision({ upstreamTrusted, coverageComplete, conflicts = [], unresolved = [] }) {
  if (!Array.isArray(conflicts) || !Array.isArray(unresolved)) throw new TypeError('INVALID_VALIDATION_REPORT');
  if (upstreamTrusted !== true) return 'blocked';
  if (conflicts.length) return 'conflict';
  if (coverageComplete !== true || unresolved.length) return 'needs_review';
  return 'valid';
}

/** lineage 哈希：来源版本（提交/修订/事件集/顺序/算法）——与 stateContentHash 严格分开。 */
export function lineageHash({ commitId = '', revisionIds = [], eventHashes = [], orderVersionId = '', algorithmVersion = '' } = {}) {
  return hashJson({
    commit_id: String(commitId || ''),
    revision_ids: (revisionIds || []).map(String),
    event_hashes: (eventHashes || []).map(String),
    order_version_id: String(orderVersionId || ''),
    algorithm_version: String(algorithmVersion || ''),
  });
}
