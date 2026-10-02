import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 模型名从策略表单点取用：这里此前写死了 'deepseek-flash' 字面量，而 verify-ai-branches 的
// 扫描清单只有三个文件（不含 db.js）——于是"改分工"时建库默认值与迁移 SQL 会静默留在旧名上。
import { MODELS, LEGACY_MODEL_NAMES } from './ai/policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// NOVELSTUDIO_DATA_DIR：冒烟测试/多实例部署时重定向数据库目录（默认 data/）。
const dataDir = process.env.NOVELSTUDIO_DATA_DIR
  ? resolve(isAbsolute(process.env.NOVELSTUDIO_DATA_DIR) ? process.env.NOVELSTUDIO_DATA_DIR : join(process.cwd(), process.env.NOVELSTUDIO_DATA_DIR))
  : join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'novel.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
// 启动自检：损坏库不得带病进入可写服务；调用方应先从备份恢复。
try {
  const check = db.prepare('PRAGMA quick_check').get();
  const verdict = String(check?.quick_check || check?.integrity_check || '').toLowerCase();
  if (verdict !== 'ok') throw new Error(`SQLite quick_check 未通过：${verdict || 'unknown'}`);
} catch (e) {
  throw new Error(`数据库完整性自检失败，已拒绝启动写入：${e.message}`);
}

// ── 深度感知事务原语（2026-09-27，R03）──────────────────────────────────────
// 为什么放在 db.js：宿主（server.js）与故事状态内核（ai/story-state/store.mjs）都要开事务，
// 而 R03 的「原子采纳」必须把它们**嵌进同一个事务**。SQLite 不允许嵌套 BEGIN——内层必须用
// SAVEPOINT。把深度裁决放在唯一共享的模块里，才不会出现"每个调用方各写一份 tx 参数"：
// 2026-09-27 实测缺陷——旧提案采纳路径（settleProposals → addStoryEvent/saveStoryMemory）
// 因为内层再次 BEGIN，整条作者「采纳」通道 100% 报 "cannot start a transaction within a transaction"。
let txDepth = 0;
// 也认 SQLite 自身的自动提交状态：宿主里仍有若干历史路径直接用 db.exec('BEGIN')，
// 不是 withTransaction 开的。若不认它们，内层再 BEGIN 会报 "cannot start a transaction
// within a transaction"（2026-09-30 T2 保存接线实测）。isTransaction 在旧 Node 上不存在，
// 因此用 === true 判定，属性缺失时语义与从前完全一致。
const rawTransactionOpen = () => db.isTransaction === true;
export function inTransaction() { return txDepth > 0 || rawTransactionOpen(); }
export function withTransaction(fn) {
  const outer = txDepth === 0 && !rawTransactionOpen();
  const savepoint = `sp_${txDepth}`;
  db.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (e) {
    txDepth -= 1;
    try {
      if (outer) db.exec('ROLLBACK');
      else { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    } catch (_) { /* 事务可能已回滚 / 保存点已释放 */ }
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author_note TEXT NOT NULL DEFAULT '',
  default_chapter_words INTEGER NOT NULL DEFAULT 2000,
  total_chapters INTEGER NOT NULL DEFAULT 0,
  story_structure TEXT NOT NULL DEFAULT '',
  narrative_pov TEXT NOT NULL DEFAULT '',
  style_positive TEXT NOT NULL DEFAULT '',
  ov_uri TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS plotlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  volume_id INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
  plotline_id INTEGER REFERENCES plotlines(id) ON DELETE SET NULL,
  parent_id INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  author_note TEXT NOT NULL DEFAULT '',
  blueprint_json TEXT NOT NULL DEFAULT '',
  target_words INTEGER NOT NULL DEFAULT 0,
  context_character_ids TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  identity TEXT NOT NULL DEFAULT '',
  appearance TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL DEFAULT '#8b5cf6',
  mes_example TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS character_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  from_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  to_character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS world_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS creation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER REFERENCES works(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  stages_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS story_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL UNIQUE REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 分段长期记忆：旧 story_memories.summary 保留兼容；段记录提供可追溯的章节窗口。
CREATE TABLE IF NOT EXISTS story_memory_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  from_chapter INTEGER NOT NULL,
  to_chapter INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  source_chapter_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(work_id, from_chapter, to_chapter)
);

CREATE TABLE IF NOT EXISTS plotline_characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  plotline_id INTEGER NOT NULL REFERENCES plotlines(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE(plotline_id, character_id)
);

CREATE TABLE IF NOT EXISTS api_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '${MODELS.fast}',
  temperature REAL NOT NULL DEFAULT 0.8,
  max_tokens INTEGER NOT NULL DEFAULT 4096,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 历史 AI 错误表：已废弃，仅供 logger.js 的一次性迁移（migrateAiErrorLogs）读取，
-- 勿在此表写入新数据；AI 错误现已统一记入 app_logs（kind='ai_error'）。
CREATE TABLE IF NOT EXISTS ai_error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS chapter_save_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- AI 长任务（harness 子进程）落库记录：内存里的 harnessJobs 一重启就没了，
-- 而一次成文/审稿要跑几分钟。这里持久化 id/状态/产出/归属章节，
-- 让「刷新页面」甚至「重启服务」之后仍能取回结果或知道任务是否还在跑。
CREATE TABLE IF NOT EXISTS harness_jobs (
  id TEXT PRIMARY KEY,
  work_id INTEGER,
  chapter_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'harness',
  stage TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  output TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_harness_jobs_chapter ON harness_jobs(chapter_id, updated_at DESC);

-- 故事事件账本：支撑增量记忆、伏笔/状态追踪与回滚依据。
-- foreshadow_status：伏笔状态（''=open / resolved / dropped）；resolves_event_id：回收本伏笔的事件。
CREATE TABLE IF NOT EXISTS story_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'event',
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  foreshadow_status TEXT NOT NULL DEFAULT '',
  resolves_event_id INTEGER,
  dedup_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 长期记忆版本历史：每次自动/手动更新都留快照，可回滚（git 式记忆）。
CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 反 AI 腔红线清单（写作风格契约）：kind = word | phrase | regex。
CREATE TABLE IF NOT EXISTS writing_redlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'phrase',
  pattern TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  exceptions TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 事件入账提案：headless 生成任务里 AI 记的事件先落提案，作者在工坊界面确认后入账。
CREATE TABLE IF NOT EXISTS story_event_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'event',
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  foreshadow_status TEXT NOT NULL DEFAULT '',
  resolves_event_id INTEGER,
  dedup_key TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 记忆更新提案：headless 生成任务里 AI 提交的长期记忆先落提案，作者确认后写入并留版本快照。
-- guard：**来源标记**（AI 自压缩为 'agent'，其余为空）。提案表原先只保存内容，
-- 来源在落库时被丢掉，于是作者点「采纳」时无法区分「模型自压缩的完整摘要」与
-- 「普通/历史提案」——前者必须过零损失护栏，后者必须保持原有采纳语义。
-- 空串默认值让旧记录与旧行为完全不变（按普通提案处理）。
CREATE TABLE IF NOT EXISTS story_memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  delta TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  guard TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 章节审稿：AI 审稿报告 + 作者确认清单（逐条 confirmed/ignored），修稿以确认清单为准。
CREATE TABLE IF NOT EXISTS chapter_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL DEFAULT '{}',
  checklist_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ══════════════════════════════════════════════════════════════════════════════
-- 确定性故事状态内核（novel-writing 插件阶段 · 全部为**附加式**新增，1.1.0）
--
-- 为什么是附加式：这些表支撑「正典事实 / 时间线 / 知识边界 / 章节契约 / 提案 /
-- 快照 / 校验记录」，全部由作品级开关 story_state_config.enabled 控制是否接入生成
-- 链路。**开关默认 0**：未开启的作品，上下文装配、预算、生成路径与开启前逐字节一致。
--
-- 与既有表的关系：不替代 story_events / story_event_proposals / story_memory_proposals /
-- chapter_reviews —— 那些表的语义与 API 一律不变；这里存的是**确定性的结构状态**，
-- 由内核读写，供上下文层与提案事务使用。
-- ══════════════════════════════════════════════════════════════════════════════

-- 作品级开关：是否把确定性故事状态接入上下文与校验链路（默认关，避免"机制生效即强制接入"）。
CREATE TABLE IF NOT EXISTS story_state_config (
  work_id INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- 时态故事状态引擎（2026-09-30）：默认全关；关闭时上下文/端点/默认生成路径与接入前一致。
  -- temporal_enabled    版本化状态底座（修订/事件/提交/历史查询）
  -- auto_analysis_enabled 保存后自动提取（需要已配置模型；无模型标 not_run）
  -- repair_enabled      作者按钮驱动的逐章候选重建
  temporal_enabled INTEGER NOT NULL DEFAULT 0,
  auto_analysis_enabled INTEGER NOT NULL DEFAULT 0,
  repair_enabled INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 时间线：故事时间 / chapter_index / scene_index / relative_time / 生效窗口 / 前后事件约束。
-- effective_from(chapter_index，含) 与 effective_to(不含) 是**阻止未来数据泄漏**的机械依据：
-- 装配第 N 章时必须滤掉 effective_from > N 的条目。
CREATE TABLE IF NOT EXISTS story_timeline_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  event_id INTEGER,
  chapter_index INTEGER NOT NULL DEFAULT 0,
  scene_index INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  story_time TEXT NOT NULL DEFAULT '',
  relative_time TEXT NOT NULL DEFAULT '',
  day_offset REAL,
  effective_from INTEGER NOT NULL DEFAULT 0,
  effective_to INTEGER,
  before_event_id INTEGER,
  after_event_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'event',
  label TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 正典事实：subject/predicate/value + 知识域（AUTHOR/CANON/CHARACTER）+ 状态机
-- （established | planned | retracted | superseded）+ 生效窗口。
-- 「把 planned 当 established 用」是长篇最隐蔽的崩法之一，所以状态是一等字段。
CREATE TABLE IF NOT EXISTS story_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  entity_id INTEGER,
  subject TEXT NOT NULL DEFAULT '',
  predicate TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'CANON_KNOWLEDGE',
  state TEXT NOT NULL DEFAULT 'known',
  status TEXT NOT NULL DEFAULT 'established',
  superseded_by INTEGER,
  holder_id INTEGER,
  effective_from INTEGER NOT NULL DEFAULT 0,
  effective_to INTEGER,
  story_time TEXT NOT NULL DEFAULT '',
  source_event_id INTEGER,
  confidence REAL NOT NULL DEFAULT 1,
  dedup_key TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 角色知识边界：谁知道 / 不知道 / 怀疑 / 误信，以及是第几章第几场知道的。
-- state ∈ known | unknown | suspected | false_belief（与 story_facts.state 同词表）。
CREATE TABLE IF NOT EXISTS character_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL,
  fact_id INTEGER,
  fact_key TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'known',
  learned_chapter_id INTEGER,
  learned_chapter_index INTEGER NOT NULL DEFAULT 0,
  learned_scene_index INTEGER NOT NULL DEFAULT 0,
  story_time TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 实体登记：稳定 id + 别名/历史名 + merge/split/rename 可追踪。
-- ref_table/ref_id 指向宿主既有行（characters / world_entries / terms…），
-- 内核不复制宿主数据，只管理「身份」。
CREATE TABLE IF NOT EXISTS story_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'character',
  canonical_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into INTEGER,
  split_from INTEGER,
  renamed_to INTEGER,
  ref_table TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 别名与历史名：valid_from/valid_to 为 chapter_index 区间（NULL = 无界）。
-- 改名后旧名仍能解析到同一实体 —— 这是「别名实体冲突」检测的基础。
CREATE TABLE IF NOT EXISTS story_entity_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES story_entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL DEFAULT '',
  normalized TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'alias',
  valid_from INTEGER,
  valid_to INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 章节契约：**同一份契约贯穿 preflight → context → generation → validation →
-- repair → proposal → acceptance**。按 (chapter_id, version) 追加式保存，
-- version 最大的一条是当前生效契约（历史版本保留，便于回答"当时按什么写的"）。
CREATE TABLE IF NOT EXISTS chapter_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  contract_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  contract_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 统一状态变更提案：canon / 角色状态 / 事件 / 伏笔 / 实体 / 记忆 / 章节状态 一律先落提案，
-- 复核后带 base_state_hash 做**陈旧检查**，再在快照保护下原子应用。
-- state ∈ pending | applied | rejected | stale | superseded
CREATE TABLE IF NOT EXISTS story_state_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'state_change',
  payload_json TEXT NOT NULL DEFAULT '{}',
  base_state_hash TEXT NOT NULL DEFAULT '',
  context_hash TEXT NOT NULL DEFAULT '',
  contract_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  conflict_level TEXT NOT NULL DEFAULT 'info',
  auto_fixable INTEGER NOT NULL DEFAULT 0,
  requires_author INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  dedup_key TEXT NOT NULL DEFAULT '',
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 状态快照：应用提案前落盘，是 rollback 的唯一依据（未落快照不许改状态）。
CREATE TABLE IF NOT EXISTS story_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  state_hash TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 校验记录：preflight（写前预测）与 post（写后验证）共用一张表，用 phase 区分。
-- 存**规则化结论 + 证据**，不存模型的自然语言评价（那是审稿报告的职责）。
CREATE TABLE IF NOT EXISTS story_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  phase TEXT NOT NULL DEFAULT 'post',
  contract_hash TEXT NOT NULL DEFAULT '',
  state_hash TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  high_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 作者审批记录（2026-09-27，R02.2）：把"作者同意"从工具描述里的口头纪律变成**服务端可校验
-- ══════════════════════════════════════════════════════════════════════════════
-- 时态故事状态引擎（temporal，2026-09-30，全部**附加式**；Host Contract 1.13.0）
--
-- 为什么是附加式：这些表支撑「不可变正文修订 / 类型化事件 / 提交谱系 / 世界线 /
-- 章章节边界快照 / 依赖 / 分析·修复运行」。**作品默认不启用**（story_state_config.
-- temporal_enabled=0）：未启用作品的上下文、端点与默认生成路径与接入前一致。
--
-- 与既有表的关系：不改 story_snapshots（它是**操作回滚**快照，不是章节历史）、
-- 不改 story_facts / story_state_proposals / author_approvals / projection_outbox 的语义；
-- 时态引擎启用后，角色卡当前值等旧字段降级为**兼容投影**，不再直写。
-- ══════════════════════════════════════════════════════════════════════════════

-- 不可变章序版本：稳定章节 ID 的叙事顺序（卷→根章节→场景由服务层计算，此表只固化结果）。
CREATE TABLE IF NOT EXISTS story_chapter_order_versions (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  order_json TEXT NOT NULL CHECK(json_valid(order_json)),
  order_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_order_work ON story_chapter_order_versions(work_id, created_at DESC);

-- 世界线：main（正式线）与 repair（重建工作线）；候选只存在于 repair 线。
CREATE TABLE IF NOT EXISTS story_worldlines (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('main','repair','sandbox')),
  base_commit_id TEXT,
  head_commit_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  status TEXT NOT NULL CHECK(status IN ('open','merged','archived')),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_temporal_one_main ON story_worldlines(work_id) WHERE kind='main' AND status='open';

-- 不可变提交：manifest 为「稳定章节 ID → binding ID」的选中清单；历史查询沿清单解析。
CREATE TABLE IF NOT EXISTS story_commits (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  worldline_id TEXT NOT NULL,
  parent_commit_id TEXT,
  order_version_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_commit_work ON story_commits(work_id, created_at DESC);

-- 不可变正文修订：机器需要的版本（用户可见版本历史仍在 chapter_save_versions）。
CREATE TABLE IF NOT EXISTS story_chapter_revisions (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  content_html TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  origin_json TEXT NOT NULL CHECK(json_valid(origin_json)),
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_revision_chapter ON story_chapter_revisions(work_id, chapter_id, created_at DESC);

-- 类型化状态事件：ops 只能走白名单域与前置条件；证据锚点带段落/字符区间与叙述类型。
CREATE TABLE IF NOT EXISTS story_state_events (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
  story_time_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(story_time_json)),
  ops_json TEXT NOT NULL CHECK(json_valid(ops_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  schema_version TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_events_revision ON story_state_events(work_id, revision_id);

-- 章节边界快照：章前/章后 cursor 的可重建状态镜像（含两种哈希）。
CREATE TABLE IF NOT EXISTS chapter_state_snapshots (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  order_version_id TEXT NOT NULL,
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  state_content_hash TEXT NOT NULL,
  lineage_hash TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_snapshot_work ON chapter_state_snapshots(work_id, created_at DESC);

-- 正文修订 ↔ 事件集 ↔ 状态的绑定：pending = 待作者确认的本章提案组；valid = 已认可。
CREATE TABLE IF NOT EXISTS story_chapter_bindings (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  event_ids_json TEXT NOT NULL CHECK(json_valid(event_ids_json)),
  input_snapshot_id TEXT,
  output_snapshot_id TEXT,
  contract_ref_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(contract_ref_json)),
  appearances_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(appearances_json)),
  validation_json TEXT NOT NULL CHECK(json_valid(validation_json)),
  validity TEXT NOT NULL CHECK(validity IN ('pending','valid','stale','conflict','needs_review','blocked','waived','rejected','superseded')),
  story_time_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(story_time_json)),
  created_at TEXT NOT NULL,
  UNIQUE(work_id, id),
  CHECK(validity <> 'valid' OR output_snapshot_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_temporal_binding_chapter ON story_chapter_bindings(work_id, chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_temporal_binding_validity ON story_chapter_bindings(work_id, validity);

-- 提交级信任覆盖：binding.validity 描述"这一行"的状态（pending=待确认，superseded=已被替代），
-- 但同一 binding 在**旧提交**里可能仍然可信。上游变化后，新提交用覆盖行声明「该章节在本提交中
-- 尚未重新验证」，而不是把全局 binding 翻成 stale——否则旧提交回放会被破坏（AC-02 要求原历史
-- 仍显示存活）。查历史时：有效结论 = 覆盖行（若有）∪ binding.validity。
CREATE TABLE IF NOT EXISTS story_binding_trust (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  validity TEXT NOT NULL CHECK(validity IN ('pending','valid','stale','conflict','needs_review','blocked','waived','rejected','superseded')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE(commit_id, binding_id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_trust_commit ON story_binding_trust(commit_id, binding_id);

-- 依赖索引：显式出场/因果前提/衔接/摘要/契约等；用于解释与排序，**不得**用于排除隐性影响。
CREATE TABLE IF NOT EXISTS story_chapter_dependencies (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  binding_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','chapter','goal','causal','context','summary','contract','unknown','event','relation','plotline','knowledge','disclosure')),
  resource_key TEXT NOT NULL,
  expected_hash TEXT,
  dependency_json TEXT NOT NULL CHECK(json_valid(dependency_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temporal_dependency_resource ON story_chapter_dependencies(work_id, resource_key);
CREATE INDEX IF NOT EXISTS idx_temporal_dependency_binding ON story_chapter_dependencies(binding_id);

-- 分析 / 修复运行：mode=analyze 只分析（不生成修订稿）；mode=repair 是作者按钮授权的逐章重建。
CREATE TABLE IF NOT EXISTS story_repair_runs (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('analyze','repair')),
  root_chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  base_commit_id TEXT NOT NULL,
  working_worldline_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','paused','stale','ready','applied','failed','cancelled','needs_review','reverted')),
  baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  authorization_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(authorization_json)),
  coverage_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(coverage_json)),
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  idempotency_key TEXT NOT NULL DEFAULT '',
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(work_id, id)
);
CREATE INDEX IF NOT EXISTS idx_temporal_repair_work ON story_repair_runs(work_id, created_at DESC);

-- 逐章断点：分析为 stale 标记；修复为每章验证/修订/保留/阻塞的持久状态机。
CREATE TABLE IF NOT EXISTS story_repair_steps (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt > 0),
  status TEXT NOT NULL CHECK(status IN ('queued','validating','kept','repairing','repaired','blocked','needs_review','failed','cancelled','stale','valid','conflict')),
  candidate_revision_id TEXT,
  candidate_binding_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temporal_step_run ON story_repair_steps(run_id, chapter_id);

-- 作者审批记录（2026-09-27，R02.2）：把"作者同意"从工具描述里的口头纪律变成**服务端可校验
-- 的执行边界**。模型侧写入（带 X-Novel-Agent 标记的请求）必须引用一条仍有效、未消费、
-- 且绑定完全匹配的审批；审批只能由作者界面（不带该标记）创建，默认单次消费、带有效期。
--   op            chapter_save / state_proposal_apply / proposal_apply / state_rollback
--   baseline_hash 操作对象的基线（章节正文哈希 / 状态哈希 / 提案集合哈希）
--   binding_json  结构化绑定（提案 id+版本哈希、快照 id、章节 id 等）
CREATE TABLE IF NOT EXISTS author_approvals (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL,
  chapter_id INTEGER,
  op TEXT NOT NULL,
  baseline_hash TEXT NOT NULL DEFAULT '',
  binding_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_author_approvals_scope ON author_approvals(work_id, op, status);
-- 幂等账本（2026-09-27，R03）：整次采纳（正文 + 选中提案）的 operation 记录。
-- 同一 idempotency_key + 同一 payload 重放 → 返回原结果；同一 key + 不同 payload → 冲突。
CREATE TABLE IF NOT EXISTS adoption_operations (
  idempotency_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL DEFAULT '',
  work_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 投影 outbox（2026-09-27，R03）：正文/状态提交与「事务外副作用」（OpenViking 同步、Embedding）
-- 之间的**持久化边界**。记录必须与正文写在同一事务里，提交后再由 worker 执行外部调用；
-- 进程在 commit 与投影之间崩溃时，重启只凭这张表就能恢复（不依赖"提交后再 enqueue 一次"）。
--   kind        投影类型（目前：ov_work_sync）
--   status      pending / running / done / failed（failed 可经 retry 复位为 pending）
--   dedup_key   幂等键（同一 operation 重放不重复投影；空串不参与唯一约束）
CREATE TABLE IF NOT EXISTS projection_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  chapter_id INTEGER,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_projection_outbox_status ON projection_outbox(status, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_outbox_dedup ON projection_outbox(dedup_key) WHERE dedup_key != '';
-- OpenViking 投影审计（2026-09-27，R04）：delete / rebuild 这类**破坏性外部操作**的待删除集合
-- 与范围证明必须可审计（任务书 §7.4）。只记条目摘要与计数，不记记忆正文。
CREATE TABLE IF NOT EXISTS ov_projection_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  op TEXT NOT NULL,
  scope_uri TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  expected_count INTEGER NOT NULL DEFAULT 0,
  actual_count INTEGER NOT NULL DEFAULT 0,
  deletable_json TEXT NOT NULL DEFAULT '[]',
  foreign_json TEXT NOT NULL DEFAULT '[]',
  unexpected_json TEXT NOT NULL DEFAULT '[]',
  detail TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'author',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ov_projection_audit_work ON ov_projection_audit(work_id, id);
-- 作者样文（2026-09-27，R09）：作者自己的（或有权使用的）文本，作为**文风证据**。
-- 关键边界：样文是数据，不是本书事实——它只用于文风分析与按预算的风格证据注入，
-- 绝不写进 story_facts / story_events / character_knowledge（负向测试见 test-author-style.mjs）。
CREATE TABLE IF NOT EXISTS author_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  chars INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'author',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_author_samples_work ON author_samples(work_id, id);
-- 结构化文风档案（R09）：确定性计数 + 口径（how/unit），语义推断未跑时为 null 且状态 not_run。
--   sample_set_hash 是"档案基于哪一批样文"的指纹：样文增删改后旧档案自动判 stale。
CREATE TABLE IF NOT EXISTS style_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  profile_hash TEXT NOT NULL DEFAULT '',
  analysis_version TEXT NOT NULL DEFAULT '',
  sample_set_hash TEXT NOT NULL DEFAULT '',
  semantic_json TEXT NOT NULL DEFAULT '',
  semantic_status TEXT NOT NULL DEFAULT 'not_run',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_style_profiles_work ON style_profiles(work_id, id DESC);
-- 三级作者意图（R09）：长期方向 / 当前阶段重点 / 本章意图。
-- chapter_id = 0 表示作品级（长期/阶段），>0 表示章节级；UNIQUE 让同一层级只有一条（幂等更新）。
CREATE TABLE IF NOT EXISTS author_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  hard INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(work_id, chapter_id, tier)
);
CREATE INDEX IF NOT EXISTS idx_author_intents_work ON author_intents(work_id, chapter_id, tier);
-- 剧情分支沙盘（2026-09-27，R11）：宿主保存候选 + 依赖基线（状态 / 正文 / 契约 / 作者意图 / 披露指纹）。
-- 关键边界：候选**不是**本书事实——它只描述"可以往哪写"；采纳只形成章节蓝图与契约建议，
-- 正文 / 正典事实 / 角色状态一律不动（负向测试见 test-branch-sandbox.mjs）。
CREATE TABLE IF NOT EXISTS branch_sandboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  chapter_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  requested INTEGER NOT NULL DEFAULT 3,
  deps_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_branch_sandboxes_work ON branch_sandboxes(work_id, chapter_id, id DESC);
CREATE TABLE IF NOT EXISTS branch_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL,
  sandbox_id INTEGER,
  chapter_id INTEGER,
  ordinal INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  core_action TEXT NOT NULL DEFAULT '',
  conflict TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  deps_json TEXT NOT NULL DEFAULT '{}',
  deps_hash TEXT NOT NULL DEFAULT '',
  distinct_json TEXT NOT NULL DEFAULT '{}',
  stale INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  adopted_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT 'author',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_branch_candidates_work ON branch_candidates(work_id, chapter_id, status, id);
CREATE INDEX IF NOT EXISTS idx_branch_candidates_sandbox ON branch_candidates(sandbox_id, ordinal);
-- 导入后分析重建（2026-09-27，R12）：一次「分析并重建创作状态」= 一个 run + 若干批次。
-- 关键边界：批次只保存**抽取结果候选**与基线指纹（source/配置/结果 hash）；确认前不写任何正式状态。
-- 表名与判据单点在 ai/import/rebuild.mjs（纯逻辑）与 ai/import/rebuild-store.mjs（读写）里。
CREATE TABLE IF NOT EXISTS import_rebuild_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'planned',
  extractor_version TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL DEFAULT '',
  route_json TEXT NOT NULL DEFAULT '{}',
  categories_json TEXT NOT NULL DEFAULT '[]',
  batch_size INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_import_rebuild_runs_work ON import_rebuild_runs(work_id, id DESC);
CREATE TABLE IF NOT EXISTS import_rebuild_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES import_rebuild_runs(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL,
  batch_index INTEGER NOT NULL DEFAULT 0,
  chapter_ids_json TEXT NOT NULL DEFAULT '[]',
  chapter_indexes_json TEXT NOT NULL DEFAULT '[]',
  chapter_hashes_json TEXT NOT NULL DEFAULT '[]',
  chars INTEGER NOT NULL DEFAULT 0,
  baseline_json TEXT NOT NULL DEFAULT '{}',
  baseline_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL DEFAULT '',
  result_hash TEXT NOT NULL DEFAULT '',
  proposals_json TEXT NOT NULL DEFAULT '[]',
  proposal_ids_json TEXT NOT NULL DEFAULT '[]',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_import_rebuild_batches_run ON import_rebuild_batches(run_id, batch_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_rebuild_batches_uq ON import_rebuild_batches(run_id, batch_index);
-- 共享资料库登记表（2026-09-28，library）：作者显式导入的参考资料（跨作品共享）。
-- 边界：这里是**登记表**，不是事实表——资料永不进入正典事实/事件/角色知识；
-- uri 唯一（重导即按 uri 更新）；删除策略默认只改 status='marked_missing'（作者确认后才删行）。
-- 读写在 ai/library/store.mjs（单点），导入链在 ai/library/library-ingest.mjs。
CREATE TABLE IF NOT EXISTS library_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'shared',
  work_id INTEGER,
  uri TEXT NOT NULL,
  rel TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  chars INTEGER NOT NULL DEFAULT 0,
  est_chunks INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  indexed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_docs_uri ON library_docs(uri);
CREATE INDEX IF NOT EXISTS idx_library_docs_status ON library_docs(status, category);
-- 知识库专用候选索引（D 模块，2026-09-29）：每篇一条**轻量**记录，不复制全文。
-- 它只用于「先廉价缩小候选 → 再语义排名 → 再确定性放行」，候选/关键词/summary 默认
-- 不进入模型上下文；词法检索用 FTS5（library_index_fts，见下方单独建表）。
-- sha256 与 library_docs 同源：未变即不更新（D3 增量维护）。
CREATE TABLE IF NOT EXISTS library_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  head_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  index_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(doc_id)
);
CREATE INDEX IF NOT EXISTS idx_library_index_category ON library_index(category);
-- ── Novel Index Layer（E 模块，2026-09-29）：把「会持续增长、每章只用一小部分」的资产
-- 从全量扫描改为先定位再读取。结构化/精确查询走这些表；语义检索仍只走 OpenViking。
-- 全部为按作品的派生索引（信息来自既有正典表，绝不反向写入正典）；可幂等重建。
CREATE TABLE IF NOT EXISTS novel_index_characters (
  work_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  current_location TEXT NOT NULL DEFAULT '',
  factions TEXT NOT NULL DEFAULT '',
  relationships_json TEXT NOT NULL DEFAULT '[]',
  last_active_chapter INTEGER,
  knowledge_topics TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, character_id)
);
CREATE TABLE IF NOT EXISTS novel_index_events (
  work_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  chapter_id INTEGER,
  chapter_position INTEGER,
  time_text TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  causal_parent INTEGER,
  consequences TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, event_id)
);
CREATE TABLE IF NOT EXISTS novel_index_foreshadows (
  work_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  planted_chapter INTEGER,
  related_entities TEXT NOT NULL DEFAULT '',
  trigger_topics TEXT NOT NULL DEFAULT '',
  expected_window TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, event_id)
);
CREATE TABLE IF NOT EXISTS novel_index_world (
  work_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  entities TEXT NOT NULL DEFAULT '',
  applies_to TEXT NOT NULL DEFAULT '',
  exceptions TEXT NOT NULL DEFAULT '',
  hard_or_soft TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 50,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, entry_id)
);
CREATE TABLE IF NOT EXISTS novel_index_relations (
  work_id INTEGER NOT NULL,
  relation_id INTEGER NOT NULL,
  from_character_id INTEGER NOT NULL,
  to_character_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL DEFAULT '',
  trust REAL,
  conflict REAL,
  debt REAL,
  last_changed_chapter INTEGER,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, relation_id)
);
CREATE TABLE IF NOT EXISTS novel_index_locations (
  work_id INTEGER NOT NULL,
  location_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  parent TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  connected_to TEXT NOT NULL DEFAULT '',
  travel_time TEXT NOT NULL DEFAULT '',
  occupants TEXT NOT NULL DEFAULT '',
  factions TEXT NOT NULL DEFAULT '',
  scene_tags TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, location_id)
);
CREATE TABLE IF NOT EXISTS novel_index_threads (
  work_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '',
  opened_chapter INTEGER,
  last_progress INTEGER,
  next_expected TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, thread_id)
);
-- 第三梯队：本次只建结构与预留接口，不接入上下文装配（E3）。
CREATE TABLE IF NOT EXISTS novel_index_items (
  work_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  quantity TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  acquired_chapter INTEGER,
  consumed_chapter INTEGER,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, item_id)
);
CREATE TABLE IF NOT EXISTS novel_index_chapters (
  work_id INTEGER NOT NULL,
  chapter_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '',
  locations TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '',
  emotional_state TEXT NOT NULL DEFAULT '',
  unresolved_threads TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, chapter_id)
);
CREATE TABLE IF NOT EXISTS novel_index_style (
  work_id INTEGER NOT NULL,
  sample_id INTEGER NOT NULL,
  pov TEXT NOT NULL DEFAULT '',
  scene_type TEXT NOT NULL DEFAULT '',
  emotion TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, sample_id)
);
CREATE TABLE IF NOT EXISTS novel_index_knowledge (
  work_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  knowledge_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  acquired_chapter INTEGER,
  confidence REAL,
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, character_id, knowledge_id)
);
-- 每作品索引版本与指纹：缓存失效判据（取版本不得全量扫描知识库——这里只读一行）。
CREATE TABLE IF NOT EXISTS novel_index_meta (
  work_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (work_id, key)
);
-- AI 效果埋点（P5）：记录「生成 → 采纳/丢弃」的行为信号，用于回答
-- 「上下文质量到底有没有变好」——这是契约里唯一无法靠结构化断言回答的问题。
--   action      generate（产出草稿）| adopt（写回正文）| discard（丢弃）
--   channel     direct / stream / harness / pipeline
--   model       实际使用的模型名
--   chars_in    送进模型的上下文字数（来自装配器 manifest 的合计）
--   chars_out   产出正文字数
--   ms          耗时
--   edit_distance  采纳时草稿与最终正文的编辑距离（越小说明一次成文越准）
--   draft_key   把同一次的 generate 与 adopt/discard 串起来的键
CREATE TABLE IF NOT EXISTS ai_eval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER,
  chapter_id INTEGER,
  action TEXT NOT NULL DEFAULT 'generate',
  channel TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  chars_in INTEGER NOT NULL DEFAULT 0,
  chars_out INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  edit_distance INTEGER,
  draft_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 应用级键值设置（如 OpenViking 语义召回开关、各作品索引时间戳）。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 统一应用日志（logger.js 双写 SQLite + data/logs/*.log）。
-- layer=技术栈层级；level=debug/info/warn/slow/error；kind=事件类型；
-- code_file/code_line/code_func=发生位置的文件地址与代码位置；context=JSON 上下文。
CREATE TABLE IF NOT EXISTS app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'server',
  level TEXT NOT NULL DEFAULT 'info',
  kind TEXT NOT NULL DEFAULT 'event',
  message TEXT NOT NULL DEFAULT '',
  code_file TEXT NOT NULL DEFAULT '',
  code_line INTEGER,
  code_func TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT NOT NULL DEFAULT ''
);
`);

// 知识库索引的词法检索表（D2）。FTS5 单独建、且失败只降级：
//   · node:sqlite 的官方构建自带 FTS5（2026-09-29 实测 SQLite 3.53.3 可建可查），
//     但这是运行时能力而不是源码保证——若某个环境缺 FTS5，**不能把整个服务启动打断**，
//     只让 library_index 的「词法候选」不可用（queryLibraryIndex 返回 index_unavailable，
//     调用方降级为纯 OpenViking 路径）。
//   · content 不挂外部表：doc_id/tokens 由 library-index.mjs 在每次 upsert/delete 时同步维护，
//     避免 external-content 触发器在重建顺序上制造隐式状态。
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS library_index_fts USING fts5(tokens, doc_id UNINDEXED, tokenize='unicode61');`);
} catch (e) {
  console.warn(`[db] FTS5 不可用：library_index 词法检索将按 index_unavailable 降级（${e.message}）`);
}

// 兼容旧数据库：给已存在的表补充新增列；「列已存在」是预期情况静默跳过，其余错误告警（不再全吞）。
const MIGRATIONS = [
  `ALTER TABLE works ADD COLUMN author_note TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE chapters ADD COLUMN author_note TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE characters ADD COLUMN mes_example TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE characters ADD COLUMN tags TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE characters ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE world_entries ADD COLUMN priority INTEGER NOT NULL DEFAULT 50`,
  `ALTER TABLE story_events ADD COLUMN foreshadow_status TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE story_events ADD COLUMN resolves_event_id INTEGER`,
  `ALTER TABLE story_events ADD COLUMN dedup_key TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE works ADD COLUMN default_chapter_words INTEGER NOT NULL DEFAULT 2000`,
  `ALTER TABLE works ADD COLUMN total_chapters INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE works ADD COLUMN story_structure TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE works ADD COLUMN narrative_pov TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE chapters ADD COLUMN blueprint_json TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE chapters ADD COLUMN target_words INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chapters ADD COLUMN context_character_ids TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE works ADD COLUMN style_positive TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE writing_redlines ADD COLUMN exceptions TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE characters ADD COLUMN aliases TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE works ADD COLUMN ov_uri TEXT NOT NULL DEFAULT ''`,
  // 生成稿草稿：AI 成文结果在结果弹窗出现的那一刻就落成草稿（kind='draft'），
  // 用户关掉弹窗（含「先审稿再应用」）不再等于稿件静默消失。
  // 默认 'manual' 让既有历史版本行为与语义完全不变。
  `ALTER TABLE chapter_save_versions ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'`,
  // 提案来源标记（AI 自压缩 = 'agent'）：让「来源」能跨落库/读取存活到作者采纳那一刻。
  // 默认空串 → 存量提案仍按普通提案处理，采纳语义不变。
  `ALTER TABLE story_memory_proposals ADD COLUMN guard TEXT NOT NULL DEFAULT ''`,
  // 沙盘来源（author / agent）：与候选的 created_by 同义，便于区分「谁开的那一轮沙盘」。
  // 默认空串 → 之前开的沙盘按未知来源处理，语义不变。
  `ALTER TABLE branch_sandboxes ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,
  // 时态故事状态引擎（2026-09-30）：三个开关列附加式补进旧库；默认 0 → 旧作品行为不变。
  `ALTER TABLE story_state_config ADD COLUMN temporal_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE story_state_config ADD COLUMN auto_analysis_enabled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE story_state_config ADD COLUMN repair_enabled INTEGER NOT NULL DEFAULT 0`,
];
for (const sql of MIGRATIONS) {
  try { db.exec(sql); } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || ''))) {
      console.warn(`[db] 迁移失败：${sql} → ${e.message}`);
    }
  }
}

// N-03：新作品插入时自动分配 OpenViking 共享记忆库的作品级目录标识（32 位随机 hex）。
// 旧作品的空 ov_uri 由同步层在首次同步时回填为「<id>」，保持既有记忆库布局不变。
try {
  db.exec(`
CREATE TRIGGER IF NOT EXISTS works_assign_ov_uri
AFTER INSERT ON works
WHEN NEW.ov_uri = ''
BEGIN
  UPDATE works SET ov_uri = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
`);
} catch (e) {
  console.warn(`[db] ov_uri 触发器创建失败：${e.message}`);
}

// 时间戳格式归一化：旧库 DEFAULT datetime('now') 产生「YYYY-MM-DD HH:MM:SS」空格格式，
// 与新写入的 ISO 8601（含 T）混排会导致字符串排序错乱；此处一次性把存量空格格式转为 ISO。
// 空格格式为 UTC 墙钟（无时区标识），补 'T' 并追加 'Z' 即为正确 ISO。
const TS_COLUMNS = [
  ['works', ['created_at', 'updated_at']], ['volumes', ['created_at', 'updated_at']],
  ['plotlines', ['created_at', 'updated_at']], ['chapters', ['created_at', 'updated_at']],
  ['categories', ['created_at']], ['terms', ['created_at', 'updated_at']],
  ['characters', ['created_at', 'updated_at']], ['world_entries', ['created_at', 'updated_at']],
  ['creation_tasks', ['created_at', 'updated_at']], ['story_memories', ['updated_at']],
  ['api_configs', ['created_at', 'updated_at']], ['ai_error_logs', ['created_at']],
  ['chapter_save_versions', ['created_at']], ['story_events', ['created_at']],
  ['memory_versions', ['created_at']], ['writing_redlines', ['created_at']],
  ['story_event_proposals', ['created_at']], ['story_memory_proposals', ['created_at']],
  ['chapter_reviews', ['created_at']],
];
for (const [table, cols] of TS_COLUMNS) {
  for (const col of cols) {
    try {
      db.exec(`UPDATE ${table} SET ${col} = replace(${col}, ' ', 'T') || 'Z' WHERE ${col} GLOB '????-??-?? ??:??:??'`);
    } catch (_) { /* 列不存在时忽略 */ }
  }
}

// 存量模型名一次性改写（清单来自 ai/policy.mjs 的 LEGACY_MODEL_NAMES——单一出处）：
//   ① deepseek-chat / deepseek-reasoner 官方已于 2026-07-24 停止服务，任何调用都会被直接拒绝；
//   ② deepseek-v4-pro —— 2026-09-18 用户决定：质量档统一为 V4.1 Flash（见 ai/policy.mjs 文件头），
//      存量配置若仍指向上一代 Pro，就会与界面/文档里"推荐 V4.1 Flash"的说法不一致。
// 统一改写为**策略表里的当前默认模型**（不再是写死的名字）。
try {
  const fixed = db.prepare(`
    UPDATE api_configs SET model = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE lower(model) IN (${LEGACY_MODEL_NAMES.map(() => '?').join(', ')})
  `).run(MODELS.fast, ...LEGACY_MODEL_NAMES);
  if (fixed.changes) {
    console.warn(`[db] 已将 ${fixed.changes} 条 API 配置里已下线/已收敛的模型名改写为 ${MODELS.fast}`);
  }
} catch (_) { /* 表不存在或字段缺失时忽略 */ }

// 移除冗余索引：与 UNIQUE(plotline_id, character_id) 的最左前缀重复。
try { db.exec('DROP INDEX IF EXISTS idx_plotline_characters_plotline'); } catch (_) { /* 忽略 */ }

db.exec(`
CREATE INDEX IF NOT EXISTS idx_volumes_work ON volumes(work_id);
CREATE INDEX IF NOT EXISTS idx_plotlines_work ON plotlines(work_id);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id);
CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id);
CREATE INDEX IF NOT EXISTS idx_chapters_plotline ON chapters(plotline_id);
CREATE INDEX IF NOT EXISTS idx_chapters_parent ON chapters(parent_id);
CREATE INDEX IF NOT EXISTS idx_terms_work ON terms(work_id);
CREATE INDEX IF NOT EXISTS idx_characters_work ON characters(work_id);
CREATE INDEX IF NOT EXISTS idx_relations_work ON character_relations(work_id);
CREATE INDEX IF NOT EXISTS idx_plotline_characters_character ON plotline_characters(character_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON character_relations(from_character_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON character_relations(to_character_id);
CREATE INDEX IF NOT EXISTS idx_ai_error_logs_created ON ai_error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapter_save_versions_chapter ON chapter_save_versions(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_entries_work ON world_entries(work_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_creation_tasks_work ON creation_tasks(work_id);
CREATE INDEX IF NOT EXISTS idx_story_events_work ON story_events(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_events_chapter ON story_events(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_events_dedup ON story_events(work_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_memory_versions_work ON memory_versions(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_memory_segments_work ON story_memory_segments(work_id, from_chapter, to_chapter);
CREATE INDEX IF NOT EXISTS idx_writing_redlines_work ON writing_redlines(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_proposals_work ON story_event_proposals(work_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_work ON story_memory_proposals(work_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapter_reviews_chapter ON chapter_reviews(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_id ON app_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_layer_level ON app_logs(layer, level);
CREATE INDEX IF NOT EXISTS idx_app_logs_kind ON app_logs(kind);
CREATE INDEX IF NOT EXISTS idx_ai_eval_work ON ai_eval_events(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_eval_chapter ON ai_eval_events(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_eval_draft ON ai_eval_events(draft_key);
-- 确定性故事状态内核（1.1.0 附加式）：按 (work_id, 章节序) 取数的路径必须走索引，
-- 否则长篇（数百章）里装配一次上下文会退化成全表扫描。
CREATE INDEX IF NOT EXISTS idx_story_timeline_work ON story_timeline_entries(work_id, chapter_index, scene_index, seq);
CREATE INDEX IF NOT EXISTS idx_story_timeline_chapter ON story_timeline_entries(chapter_id);
CREATE INDEX IF NOT EXISTS idx_story_facts_work ON story_facts(work_id, effective_from, status);
CREATE INDEX IF NOT EXISTS idx_char_knowledge_work ON character_knowledge(work_id, character_id);
CREATE INDEX IF NOT EXISTS idx_char_knowledge_fact ON character_knowledge(work_id, fact_key);
CREATE INDEX IF NOT EXISTS idx_story_entities_work ON story_entities(work_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_story_entity_aliases ON story_entity_aliases(work_id, normalized);
CREATE INDEX IF NOT EXISTS idx_story_entity_aliases_entity ON story_entity_aliases(entity_id);
CREATE INDEX IF NOT EXISTS idx_chapter_contracts_chapter ON chapter_contracts(chapter_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_state_proposals_work ON story_state_proposals(work_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_state_proposals_chapter ON story_state_proposals(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_snapshots_work ON story_snapshots(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_validations_chapter ON story_validations(chapter_id, phase, created_at DESC);
`);

// 幂等去重唯一约束兜底（addStoryEvent 的 SELECT 查重与写入分离存在并发竞态）。
// 存量库可能已有重复 dedup_key，创建失败时仅告警，不阻断启动（SELECT 查重仍兜底）。
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_events_dedup_uq ON story_events(work_id, dedup_key) WHERE dedup_key != ''`);
} catch (e) {
  console.warn(`[db] 唯一去重索引创建失败（存量库存在重复 dedup_key）：${e.message}`);
}

// 确定性故事状态内核（1.1.0）：三处「同一事物只应有一条」的约束靠**条件唯一索引**兜底，
// 与 story_events 的 dedup 兜底同一种做法（SELECT 查重与写入之间存在并发竞态）。
// 存量库若已有重复，创建失败只告警、不阻断启动（内核写入路径仍会先 SELECT 查重）。
const STORY_STATE_UNIQUE = [
  [`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_facts_dedup_uq ON story_facts(work_id, dedup_key) WHERE dedup_key != ''`, 'story_facts 去重唯一索引'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS idx_char_knowledge_key_uq ON character_knowledge(work_id, character_id, fact_key) WHERE fact_key != ''`, 'character_knowledge 唯一索引'],
  [`CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_contracts_version_uq ON chapter_contracts(chapter_id, version)`, 'chapter_contracts 版本唯一索引'],
];
for (const [sql, label] of STORY_STATE_UNIQUE) {
  try { db.exec(sql); } catch (e) { console.warn(`[db] ${label}创建失败：${e.message}`); }
}
