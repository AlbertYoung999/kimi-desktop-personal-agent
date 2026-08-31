import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { wbRoot } from './workbench.js';

/** 数据平面：jarvis.db（SQLite WAL，唯一事实源，design-data-plane.md §2） */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = path.join(wbRoot(), 'jarvis.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  return db;
}

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      start_date TEXT, due_date TEXT, completed_at TEXT,
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      project_id TEXT,
      recurrence TEXT DEFAULT 'none',
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS radars (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT,
      query TEXT, sources TEXT DEFAULT '[]',
      frequency_minutes INTEGER DEFAULT 1440,
      enabled INTEGER DEFAULT 1,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS radar_items (
      id TEXT PRIMARY KEY,
      radar_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      source TEXT, url TEXT,
      published_at TEXT,
      tags TEXT DEFAULT '[]',
      read INTEGER DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_radar_items_radar ON radar_items(radar_id, published_at);
    CREATE TABLE IF NOT EXISTS library (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, html TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS engines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL,
      grp TEXT, enabled INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      minutes INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pomodoro_task ON pomodoro_sessions(task_id, started_at);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // 列级迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
  const taskCols = (d.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['parent_id TEXT', 'scheduled_start TEXT', 'scheduled_end TEXT']) {
    const name = col.split(' ')[0];
    if (!taskCols.includes(name)) d.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
  }
}

export function metaGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function metaSet(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/** 一次性从 JSON 迁移（meta.migrated 标记），原 JSON 保留不动。 */
export function migrateFromJson(): void {
  if (metaGet('migrated') === '1') return;
  const d = getDb();
  const readJson = (rel: string, fallback: unknown) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(wbRoot(), rel), 'utf8'));
    } catch {
      return fallback;
    }
  };

  const tx = d.transaction(() => {
    // tasks
    const insTask = d.prepare(`INSERT OR IGNORE INTO tasks (id,title,description,status,priority,start_date,due_date,completed_at,notes,tags,project_id,recurrence,session_id,created_at,updated_at)
      VALUES (@id,@title,@description,@status,@priority,@startDate,@dueDate,@completedAt,@notes,@tags,@projectId,@recurrence,@sessionId,@createdAt,@updatedAt)`);
    for (const t of readJson('tasks.json', []) as Record<string, unknown>[]) {
      insTask.run({
        id: t.id, title: t.title, description: t.description ?? '', status: t.status, priority: t.priority,
        startDate: t.startDate ?? null, dueDate: t.dueDate ?? null, completedAt: t.completedAt ?? null,
        notes: t.notes ?? '', tags: JSON.stringify(t.tags ?? []), projectId: t.projectId ?? null,
        recurrence: t.recurrence ?? 'none', sessionId: t.sessionId ?? null,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      });
    }
    // projects
    const insProj = d.prepare('INSERT OR IGNORE INTO projects (id,name,color,created_at,updated_at) VALUES (?,?,?,?,?)');
    for (const p of readJson('projects.json', []) as Record<string, unknown>[]) {
      insProj.run(p.id, p.name, p.color ?? null, p.createdAt, p.updatedAt);
    }
    // radars + items
    const insRadar = d.prepare('INSERT OR IGNORE INTO radars (id,name,icon,query,sources,frequency_minutes,enabled,last_run_at) VALUES (?,?,?,?,?,?,?,?)');
    const insItem = d.prepare(`INSERT OR IGNORE INTO radar_items (id,radar_id,title,summary,source,url,published_at,tags,read,favorite,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const radarsDir = path.join(wbRoot(), 'radars');
    if (fs.existsSync(radarsDir)) {
      for (const f of fs.readdirSync(radarsDir)) {
        if (!f.endsWith('.json')) continue;
        const r = readJson(`radars/${f}`, null) as Record<string, unknown> | null;
        if (!r) continue;
        insRadar.run(r.id, r.name, r.icon, r.query, JSON.stringify(r.sources ?? []), r.frequencyMinutes, r.enabled ? 1 : 0, r.lastRunAt ?? null);
        for (const i of (r.items ?? []) as Record<string, unknown>[]) {
          insItem.run(i.id, r.id, i.title, i.summary ?? '', i.source ?? '', i.url ?? '', i.publishedAt ?? null,
            JSON.stringify(i.tags ?? []), i.read ? 1 : 0, i.favorite ? 1 : 0, Date.parse(String(i.publishedAt)) || Date.now());
        }
      }
    }
    // library
    const insLib = d.prepare('INSERT OR IGNORE INTO library (id,title,html,created_at) VALUES (?,?,?,?)');
    for (const i of readJson('library.json', []) as Record<string, unknown>[]) {
      insLib.run(i.id, i.title, i.html, i.createdAt);
    }
    // engines
    const insEng = d.prepare('INSERT OR IGNORE INTO engines (id,name,template,grp,enabled,builtin) VALUES (?,?,?,?,?,?)');
    const enginesFile = readJson('engines.json', { overrides: {} }) as { overrides?: Record<string, Record<string, unknown>> };
    for (const e of Object.values(enginesFile.overrides ?? {})) {
      insEng.run(e.id, e.name, e.template, e.group ?? '', e.enabled ? 1 : 0, e.builtin ? 1 : 0);
    }
  });
  tx();
  metaSet('migrated', '1');
  console.log('[db] migration from JSON complete');
}

/** DB 快照备份（含 WAL checkpoint） */
export function backupDb(destDir: string): void {
  const d = getDb();
  d.pragma('wal_checkpoint(TRUNCATE)');
  fs.mkdirSync(destDir, { recursive: true });
  d.backup(path.join(destDir, 'jarvis.db'));
}
