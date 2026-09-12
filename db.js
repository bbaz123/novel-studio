import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  model TEXT NOT NULL DEFAULT 'deepseek-chat',
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
CREATE TABLE IF NOT EXISTS story_memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  delta TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
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
`);

// 幂等去重唯一约束兜底（addStoryEvent 的 SELECT 查重与写入分离存在并发竞态）。
// 存量库可能已有重复 dedup_key，创建失败时仅告警，不阻断启动（SELECT 查重仍兜底）。
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_events_dedup_uq ON story_events(work_id, dedup_key) WHERE dedup_key != ''`);
} catch (e) {
  console.warn(`[db] 唯一去重索引创建失败（存量库存在重复 dedup_key）：${e.message}`);
}
