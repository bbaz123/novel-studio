import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'novel.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  author_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS volumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plotlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  summary TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER REFERENCES works(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  stages_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS story_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL UNIQUE REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  stack TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chapter_save_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 故事事件账本：支撑增量记忆、伏笔/状态追踪与回滚依据。
CREATE TABLE IF NOT EXISTS story_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'event',
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 长期记忆版本历史：每次自动/手动更新都留快照，可回滚（git 式记忆）。
CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 反 AI 腔红线清单（写作风格契约）：kind = word | phrase | regex。
CREATE TABLE IF NOT EXISTS writing_redlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'phrase',
  pattern TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 兼容旧数据库：给已存在的表补充新增列
try { db.exec(`ALTER TABLE works ADD COLUMN author_note TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE chapters ADD COLUMN author_note TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE characters ADD COLUMN mes_example TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE characters ADD COLUMN tags TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE characters ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE world_entries ADD COLUMN priority INTEGER NOT NULL DEFAULT 50`); } catch (_) {}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_volumes_work ON volumes(work_id);
CREATE INDEX IF NOT EXISTS idx_plotlines_work ON plotlines(work_id);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id);
CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id);
CREATE INDEX IF NOT EXISTS idx_chapters_plotline ON chapters(plotline_id);
CREATE INDEX IF NOT EXISTS idx_terms_work ON terms(work_id);
CREATE INDEX IF NOT EXISTS idx_characters_work ON characters(work_id);
CREATE INDEX IF NOT EXISTS idx_relations_work ON character_relations(work_id);
CREATE INDEX IF NOT EXISTS idx_plotline_characters_plotline ON plotline_characters(plotline_id);
CREATE INDEX IF NOT EXISTS idx_ai_error_logs_created ON ai_error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapter_save_versions_chapter ON chapter_save_versions(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_world_entries_work ON world_entries(work_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_creation_tasks_work ON creation_tasks(work_id);
CREATE INDEX IF NOT EXISTS idx_story_events_work ON story_events(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_story_events_chapter ON story_events(chapter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_versions_work ON memory_versions(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_writing_redlines_work ON writing_redlines(work_id, created_at DESC);
`);
