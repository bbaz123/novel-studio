/**
 * ai/model-broker/routing.mjs —— S10：按「作品 + 用途」解析模型（修 F04）。
 *
 * 病灶（F04）：`temporalAnalysisConfig()` 是
 *   `SELECT * FROM api_configs WHERE api_key <> '' ORDER BY id ASC LIMIT 1`
 * —— **第一个有 key 的配置就是答案**。后果：
 *   · 作者配了多个模型时，用哪个取决于插入顺序，与作品/任务无关；
 *   · 想给某本书单独指定分析模型做不到（只能改全局顺序）；
 *   · "为什么这次用的是这个模型"无法回答，因为它根本没有被选择过。
 *
 * 本模块把选择变成**显式路由**：
 *   ① `work_id + purpose` 的绑定（最高优先）；
 *   ② 全局 `work_id = 0 + purpose` 的默认；
 *   ③ **都没有 → NO_ROUTE**（不再隐式挑第一条）。
 * 第 ③ 条是关键：没有路由 ≠ 挑一个最像的。上层会把 NO_ROUTE 如实记成"未运行/未配置"，
 * 而保存路径完全不依赖模型（"无模型仍可保存"）。
 *
 * 纪律：纯查询 + 纯判定，不调用模型、不发网络请求。
 */

export const ROUTING_VERSION = 'route-v1';

/** 允许的用途。新增用途必须同时给出测试，避免"随手写个字符串就当路由键"。 */
export const PURPOSES = Object.freeze([
  'analysis',   // 章节语义分析（抽取候选事件）
  'writing',    // 正文生成
  'review',     // 审稿
  'repair',     // 局部修稿
  'compress',   // 记忆压缩
  'research',   // 检索/资料
]);

export function normalizePurpose(raw) {
  const p = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!p) throw new TypeError('MISSING_PURPOSE');
  if (!PURPOSES.includes(p)) throw new TypeError(`UNKNOWN_PURPOSE:${p}`);
  return p;
}

/** 允许的"无 key"本地 provider：显式白名单，不在白名单里就必须有 key。 */
export function isLocalProvider(baseUrl) {
  const u = String(baseUrl == null ? '' : baseUrl).trim().toLowerCase();
  if (!u) return false;
  // 只认回环地址：本机假模型/本地推理服务不需要 key，但也不能把外网地址误判成本地
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);
}

/** 列出"可用"配置：有 api_key，或指向本地回环地址（免 key）。 */
export function listUsableConfigs(db) {
  const rows = db.prepare('SELECT * FROM api_configs ORDER BY id ASC').all();
  return rows.filter((r) => String(r.api_key || '').trim() !== '' || isLocalProvider(r.base_url)).map((r) => ({ ...r }));
}

/**
 * 解析路由。
 *
 * @returns {{
 *   ok:boolean, version:string, purpose:string, work_id:number,
 *   route:{ source:'work'|'global', purpose:string, api_config_id:number }|null,
 *   config:object|null, reason?:string, detail?:string,
 *   needs_api_key:boolean, has_api_key:boolean
 * }}
 *
 * `ok:false` 的几种原因都要能被上层区分（而不是统一当成"没模型"）：
 *   NO_ROUTE / CONFIG_MISSING / CONFIG_NO_KEY
 */
export function resolveRoute(db, { workId = 0, purpose } = {}) {
  let p;
  try {
    p = normalizePurpose(purpose);
  } catch (e) {
    return failed(String(e && e.message || 'MISSING_PURPOSE'), { purpose: String(purpose || ''), workId });
  }
  const w = Number(workId) || 0;

  // ① 作品级 → ② 全局级；`work_id = 0` 表示全局默认。
  const pick = (wid) => db.prepare(
    'SELECT work_id, purpose, api_config_id FROM model_routes WHERE work_id = ? AND purpose = ? LIMIT 1',
  ).get(wid, p);

  let row = w ? pick(w) : null;
  let source = 'work';
  if (!row) {
    row = pick(0);
    source = 'global';
  }
  if (!row) {
    // ③ 没有任何路由。这里要区分两种**完全不同**的情况：
    //    · 全库只有**一个**可用配置 → 不存在"选择"，直接用它是**无歧义**的
    //      （F04 的病灶是"在多个候选里按插入顺序挑一个"，只有一个候选时谈不上挑）；
    //    · 有**多个**可用配置 → 必须显式路由，否则就是隐式选择 → AMBIGUOUS_NO_ROUTE。
    //      这一条是 S10 的核心：不隐式挑。
    const usable = listUsableConfigs(db);
    if (usable.length === 1) {
      const only = usable[0];
      return {
        ok: true,
        version: ROUTING_VERSION,
        purpose: p,
        work_id: w,
        route: { source: 'sole-config', purpose: p, api_config_id: Number(only.id) },
        config: only,
        needs_api_key: !isLocalProvider(only.base_url),
        has_api_key: String(only.api_key || '').trim() !== '',
        detail: '全库只有这一个可用配置：不存在可选项，因此直接用（不是"按 id 取第一条"）',
      };
    }
    if (usable.length === 0) {
      return failed('NO_ROUTE', { purpose: p, workId: w, detail: `没有任何可用配置（需要 api_key，或本地回环地址）；不隐式挑选` });
    }
    return failed('AMBIGUOUS_NO_ROUTE', {
      purpose: p, workId: w,
      detail: `有 ${usable.length} 个可用配置但没有为 purpose=${p} 配置路由，拒绝按插入顺序隐式挑选（请显式 setRoute）`,
    });
  }

  const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(Number(row.api_config_id));
  if (!config) {
    return failed('CONFIG_MISSING', { purpose: p, workId: w, route: row, detail: `路由指向的 api_configs#${row.api_config_id} 不存在` });
  }

  const needsKey = !isLocalProvider(config.base_url);
  const hasKey = String(config.api_key || '').trim() !== '';
  if (needsKey && !hasKey) {
    return failed('CONFIG_NO_KEY', {
      purpose: p, workId: w, route: row, config,
      detail: `api_configs#${config.id} 指向外部地址 ${config.base_url}，但没有 api_key`,
    });
  }

  return {
    ok: true,
    version: ROUTING_VERSION,
    purpose: p,
    work_id: w,
    route: { source: w && row.work_id === w ? 'work' : 'global', purpose: p, api_config_id: Number(row.api_config_id) },
    config,
    needs_api_key: needsKey,
    has_api_key: hasKey,
  };
}

function failed(reason, extra = {}) {
  return {
    ok: false,
    version: ROUTING_VERSION,
    purpose: extra.purpose || '',
    work_id: Number(extra.workId) || 0,
    route: extra.route ? { source: 'unknown', purpose: extra.purpose, api_config_id: Number(extra.route.api_config_id) } : null,
    config: extra.config || null,
    needs_api_key: extra.config ? !isLocalProvider(extra.config.base_url) : true,
    has_api_key: false,
    reason,
    detail: extra.detail || '',
  };
}

/** 写/改路由（作者通道；模型侧不得调用）。 */
export function setRoute(db, { workId = 0, purpose, apiConfigId, note = '' } = {}) {
  const p = normalizePurpose(purpose);
  const w = Number(workId) || 0;
  const cid = Number(apiConfigId) || 0;
  if (!cid) throw new TypeError('MISSING_API_CONFIG_ID');
  const exists = db.prepare('SELECT id FROM api_configs WHERE id = ?').get(cid);
  if (!exists) throw new TypeError(`API_CONFIG_NOT_FOUND:${cid}`);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO model_routes (work_id, purpose, api_config_id, note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_id, purpose) DO UPDATE SET api_config_id = excluded.api_config_id, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(w, p, cid, String(note || ''), now);
  return { ok: true, work_id: w, purpose: p, api_config_id: cid };
}

/** 列出全部路由（面板/诊断用）。 */
export function listRoutes(db) {
  return db.prepare('SELECT work_id, purpose, api_config_id, note, updated_at FROM model_routes ORDER BY work_id ASC, purpose ASC').all();
}
