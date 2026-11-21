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
    -- channel 模式(v7.0):手动创建的空项目(与 task-flow 的 projects 是不同概念)
    CREATE TABLE IF NOT EXISTS channel_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT,
      created_at INTEGER,
      sort_order INTEGER DEFAULT 0
    );
    -- channel 模式(v7.0):session 的 channel 元数据(置顶/归属覆盖/最后一条消息)
    CREATE TABLE IF NOT EXISTS channel_meta (
      session_id TEXT PRIMARY KEY,
      pinned INTEGER DEFAULT 0,
      project_id TEXT,
      last_message TEXT,
      last_message_at INTEGER,
      last_viewed_at INTEGER
    );
    -- 常驻 agent 库(v7.0 P2, design/design-v7.md §10.2):文件是唯一事实源,表只存元数据
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      dir TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      created_at INTEGER,
      updated_at INTEGER
    );
    -- group 协作(v7.0 P3, design/design-v7.md §4):context_md 只是 group.md 落盘文件的缓存
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      cwd TEXT,
      name TEXT NOT NULL,
      context_md TEXT DEFAULT '',
      round_count INTEGER DEFAULT 0,
      compact_threshold INTEGER DEFAULT 10,
      autonomous INTEGER DEFAULT 0,
      max_rounds INTEGER DEFAULT 20,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT, session_id TEXT, role TEXT DEFAULT '',
      PRIMARY KEY (group_id, session_id)
    );
  `);
  // 列级迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列
  const taskCols = (d.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['parent_id TEXT', 'scheduled_start TEXT', 'scheduled_end TEXT']) {
    const name = col.split(' ')[0];
    if (!taskCols.includes(name)) d.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
  }
  // channel_meta 后加列:session 绑定的常驻 agent(design/design-v7.md §10.2,头像/角色标用)
  const cmCols = (d.prepare('PRAGMA table_info(channel_meta)').all() as { name: string }[]).map((c) => c.name);
  if (!cmCols.includes('agent_id')) d.exec('ALTER TABLE channel_meta ADD COLUMN agent_id TEXT');
  // channel_meta 后加列:显式归档标记(一次性 100 天迁移写入,之后不再按时间计算)
  if (!cmCols.includes('archived')) d.exec('ALTER TABLE channel_meta ADD COLUMN archived INTEGER DEFAULT 0');
  // channel_meta 后加列:per-session 权限模式覆盖(NULL=跟随全局 settings.permissionMode)
  if (!cmCols.includes('mode')) d.exec('ALTER TABLE channel_meta ADD COLUMN mode TEXT');
  // channel_meta 后加列:per-session 模型覆盖(NULL=跟随 kimi 默认)
  if (!cmCols.includes('model')) d.exec('ALTER TABLE channel_meta ADD COLUMN model TEXT');
  // channel_meta 后加列:per-session 思考深度覆盖('low'|'high'|'max',NULL=跟随全局)
  if (!cmCols.includes('thinking')) d.exec('ALTER TABLE channel_meta ADD COLUMN thinking TEXT');
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

// ---------- channel 模式 (v7.0 P1, design/design-v7.md §2.2) ----------

export interface ChannelProjectRow {
  id: string;
  name: string;
  path: string | null;
  created_at: number;
  sort_order: number;
}

export interface ChannelMetaRow {
  session_id: string;
  pinned: number;
  project_id: string | null;
  last_message: string | null;
  last_message_at: number | null;
  last_viewed_at: number | null;
  agent_id: string | null;
  /** 显式归档标记(一次性 100 天迁移写入;之后不因年龄自动变化) */
  archived: number;
  /** per-session 权限模式覆盖('default'|'auto'|'yolo'|'plan',NULL=跟随全局) */
  mode: string | null;
  /** per-session 模型覆盖(NULL=跟随 kimi 默认) */
  model: string | null;
  /** per-session 思考深度覆盖('low'|'high'|'max',NULL=跟随全局 thinking 设置) */
  thinking: string | null;
}

export function listChannelProjects(): ChannelProjectRow[] {
  return getDb()
    .prepare('SELECT * FROM channel_projects ORDER BY sort_order, created_at')
    .all() as ChannelProjectRow[];
}

export function createChannelProject(name: string, p: string | null): ChannelProjectRow {
  const row: ChannelProjectRow = {
    id: `chp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    path: p,
    created_at: Date.now(),
    sort_order: 0,
  };
  getDb()
    .prepare('INSERT INTO channel_projects (id,name,path,created_at,sort_order) VALUES (@id,@name,@path,@created_at,@sort_order)')
    .run(row);
  return row;
}

export function allChannelMeta(): ChannelMetaRow[] {
  return getDb().prepare('SELECT * FROM channel_meta').all() as ChannelMetaRow[];
}

/** channel_meta 按 session_id upsert,只动指定列,其余保留 */
function upsertChannelMeta(sessionId: string, sets: string, params: Record<string, unknown>): void {
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO channel_meta (session_id) VALUES (?)').run(sessionId);
  d.prepare(`UPDATE channel_meta SET ${sets} WHERE session_id = @sessionId`).run({ sessionId, ...params });
}

export function setChannelPinned(sessionId: string, pinned: boolean): void {
  upsertChannelMeta(sessionId, 'pinned = @pinned', { pinned: pinned ? 1 : 0 });
}

export function setChannelProject(sessionId: string, projectId: string | null): void {
  upsertChannelMeta(sessionId, 'project_id = @projectId', { projectId });
}

export function markChannelViewed(sessionId: string): void {
  upsertChannelMeta(sessionId, 'last_viewed_at = @at', { at: Date.now() });
}

/** 决策#2:只存最后一条消息(turn 结束时由 ACPManager 写入) */
export function setChannelLastMessage(sessionId: string, text: string, at: number): void {
  upsertChannelMeta(sessionId, 'last_message = @text, last_message_at = @at', { text, at });
}

/** 绑定 session 的常驻 agent(newChannelSession 时写入) */
export function setChannelAgent(sessionId: string, agentId: string | null): void {
  upsertChannelMeta(sessionId, 'agent_id = @agentId', { agentId });
}

/** 删除 session 的 channel 元数据(deleteSession 清理用) */
export function deleteChannelMeta(sessionId: string): void {
  getDb().prepare('DELETE FROM channel_meta WHERE session_id = ?').run(sessionId);
}

/** 显式归档/恢复(ch:archive-session;一次性 100 天迁移也用同一入口) */
export function setChannelArchived(sessionId: string, archived: boolean): void {
  upsertChannelMeta(sessionId, 'archived = @archived', { archived: archived ? 1 : 0 });
}

/** per-session 权限模式覆盖(ch:set-session-mode;null=清除覆盖回退全局) */
export function setChannelMode(sessionId: string, mode: string | null): void {
  upsertChannelMeta(sessionId, 'mode = @mode', { mode });
}

/** per-session 模型覆盖(ch:set-session-model;null=清除覆盖跟随 kimi 默认) */
export function setChannelModel(sessionId: string, model: string | null): void {
  upsertChannelMeta(sessionId, 'model = @model', { model });
}

/** per-session 思考深度覆盖(ch:set-session-thinking;null=清除覆盖回退全局) */
export function setChannelThinking(sessionId: string, thinking: string | null): void {
  upsertChannelMeta(sessionId, 'thinking = @thinking', { thinking });
}

// ---------- 常驻 agent 库 (v7.0 P2, design/design-v7.md §10.2) ----------

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  dir: string; // agents/ 下的目录名(相对,防 wbRoot 迁移)
  avatar: string;
  created_at: number;
  updated_at: number;
}

export function listAgentRows(): AgentRow[] {
  return getDb().prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[];
}

export function getAgentRow(id: string): AgentRow | null {
  return (getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined) ?? null;
}

export function insertAgentRow(row: AgentRow): AgentRow {
  getDb()
    .prepare('INSERT INTO agents (id,name,description,dir,avatar,created_at,updated_at) VALUES (@id,@name,@description,@dir,@avatar,@created_at,@updated_at)')
    .run(row);
  return row;
}

export function updateAgentRow(id: string, patch: { description?: string; avatar?: string }): void {
  getDb()
    .prepare('UPDATE agents SET description = COALESCE(@description, description), avatar = COALESCE(@avatar, avatar), updated_at = @at WHERE id = @id')
    .run({ id, description: patch.description ?? null, avatar: patch.avatar ?? null, at: Date.now() });
}

export function deleteAgentRow(id: string): void {
  getDb().prepare('DELETE FROM agents WHERE id = ?').run(id);
}

// ---------- group 协作 (v7.0 P3, design/design-v7.md §4) ----------

export interface GroupRow {
  id: string;
  project_id: string | null;
  cwd: string | null;
  name: string;
  context_md: string;
  round_count: number;
  compact_threshold: number;
  autonomous: number;
  max_rounds: number;
  created_at: number;
}

export interface GroupMemberRow {
  group_id: string;
  session_id: string;
  role: string;
}

export function listGroupRows(projectId?: string): GroupRow[] {
  const d = getDb();
  return (
    projectId
      ? d.prepare('SELECT * FROM groups WHERE project_id = ? ORDER BY created_at').all(projectId)
      : d.prepare('SELECT * FROM groups ORDER BY created_at').all()
  ) as GroupRow[];
}

export function getGroupRow(id: string): GroupRow | null {
  return (getDb().prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined) ?? null;
}

export function insertGroupRow(row: GroupRow): GroupRow {
  getDb()
    .prepare(
      `INSERT INTO groups (id,project_id,cwd,name,context_md,round_count,compact_threshold,autonomous,max_rounds,created_at)
       VALUES (@id,@project_id,@cwd,@name,@context_md,@round_count,@compact_threshold,@autonomous,@max_rounds,@created_at)`,
    )
    .run(row);
  return row;
}

export function updateGroupRow(
  id: string,
  patch: Partial<Pick<GroupRow, 'name' | 'context_md' | 'round_count' | 'compact_threshold' | 'autonomous' | 'max_rounds' | 'project_id' | 'cwd'>>,
): void {
  const d = getDb();
  const cur = getGroupRow(id);
  if (!cur) return;
  // undefined 键不参与更新(调用方可以透传可选 patch)
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  d.prepare(
    `UPDATE groups SET name=@name, context_md=@context_md, round_count=@round_count,
     compact_threshold=@compact_threshold, autonomous=@autonomous, max_rounds=@max_rounds,
     project_id=@project_id, cwd=@cwd WHERE id=@id`,
  ).run({ ...cur, ...clean, id });
}

export function deleteGroupRow(id: string): void {
  const d = getDb();
  d.prepare('DELETE FROM groups WHERE id = ?').run(id);
  d.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
}

export function listGroupMemberRows(groupId: string): GroupMemberRow[] {
  return getDb().prepare('SELECT * FROM group_members WHERE group_id = ?').all(groupId) as GroupMemberRow[];
}

export function addGroupMemberRow(groupId: string, sessionId: string, role: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO group_members (group_id,session_id,role) VALUES (?,?,?)')
    .run(groupId, sessionId, role);
}

export function removeGroupMemberRow(groupId: string, sessionId: string): void {
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND session_id = ?').run(groupId, sessionId);
}
