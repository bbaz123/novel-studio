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

