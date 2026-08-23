import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from './db.js';
import type { FocusRecord, Project, SearchEngine, Task, WorkbenchLayout } from '../shared/workbench-types.js';
import { DEFAULT_PROJECT_ID } from '../shared/workbench-types.js';

/** user layer root — the ONLY writable directory for workbench data (PRD §2.3) */
export function wbRoot(): string {
  const dir = path.join(os.homedir(), '.jarvis-workspace');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(rel: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(wbRoot(), rel), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** atomic write: tmp file + rename, so a crash mid-write never corrupts data */
function writeJson(rel: string, value: unknown): void {
  const p = path.join(wbRoot(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

// ---------- layout ----------

export function getLayout(): WorkbenchLayout {
  return readJson<WorkbenchLayout>('layout.json', { widgets: [] });
}

export function saveLayout(layout: WorkbenchLayout): void {
  writeJson('layout.json', layout);
}

// ---------- tasks ----------

// ---------- tasks (SQLite, design-data-plane §2) ----------

interface TaskRow {
  id: string; title: string; description: string; status: string; priority: string;
  start_date: string | null; due_date: string | null; completed_at: string | null;
  notes: string; tags: string; project_id: string | null; recurrence: string;
  session_id: string | null; created_at: number; updated_at: number;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id, title: r.title, description: r.description,
    status: r.status as Task['status'], priority: r.priority as Task['priority'],
    startDate: r.start_date ?? undefined, dueDate: r.due_date ?? undefined,
    completedAt: r.completed_at ?? undefined, notes: r.notes,
    tags: JSON.parse(r.tags || '[]') as string[], projectId: r.project_id ?? undefined,
    recurrence: r.recurrence as Task['recurrence'], sessionId: r.session_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function listTasks(): Task[] {
  const rows = getDb().prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
  return rows.map(rowToTask);
}

function nextOccurrence(from: Date, recurrence: 'daily' | 'weekly' | 'workdays'): Date {
  const next = new Date(from);
  if (recurrence === 'daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else {
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() === 0 || next.getDay() === 6);
  }
  return next;
}

export function saveTask(task: Task): Task[] {
  const d = getDb();
  const prev = d.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string } | undefined;
  task.updatedAt = Date.now();
  d.prepare(`INSERT OR REPLACE INTO tasks (id,title,description,status,priority,start_date,due_date,completed_at,notes,tags,project_id,recurrence,session_id,created_at,updated_at)
    VALUES (@id,@title,@description,@status,@priority,@startDate,@dueDate,@completedAt,@notes,@tags,@projectId,@recurrence,@sessionId,@createdAt,@updatedAt)`).run({
    id: task.id, title: task.title, description: task.description, status: task.status, priority: task.priority,
    startDate: task.startDate ?? null, dueDate: task.dueDate ?? null, completedAt: task.completedAt ?? null,
    notes: task.notes, tags: JSON.stringify(task.tags ?? []), projectId: task.projectId ?? null,
    recurrence: task.recurrence ?? 'none', sessionId: task.sessionId ?? null,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  });

  // recurring task completed → archive it and spawn the next occurrence
  const recurrence = task.recurrence ?? 'none';
  const justCompleted = task.status === 'done' && prev?.status !== 'done';
  if (justCompleted && recurrence !== 'none') {
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    const next: Task = {
      ...task,
      id: `task-${Date.now().toString(36)}`,
      status: 'todo',
      startDate: undefined,
      dueDate: nextOccurrence(base, recurrence).toISOString(),
      completedAt: undefined,
      sessionId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveTask(next);
  }
  return listTasks();
}

export function deleteTask(id: string): Task[] {
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return listTasks();
}

// ---------- projects (SQLite) ----------

export function listProjects(): Project[] {
  const d = getDb();
  const rows = d.prepare('SELECT * FROM projects ORDER BY created_at').all() as (Project & { color: string | null })[];
  if (!rows.some((p) => p.id === DEFAULT_PROJECT_ID)) {
    const now = Date.now();
    d.prepare('INSERT OR IGNORE INTO projects (id,name,color,created_at,updated_at) VALUES (?,?,?,?,?)').run(
      DEFAULT_PROJECT_ID, '默认', null, now, now,
    );
    return listProjects();
  }
  return rows.map((p) => ({ ...p, color: p.color ?? undefined }));
}

export function saveProject(project: Project): Project[] {
  project.updatedAt = Date.now();
  getDb().prepare('INSERT OR REPLACE INTO projects (id,name,color,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    project.id, project.name, project.color ?? null, project.createdAt, project.updatedAt,
  );
  return listProjects();
}

export function deleteProject(id: string): Project[] {
  if (id === DEFAULT_PROJECT_ID) return listProjects(); // 默认项目不可删除
  const d = getDb();
  d.prepare('DELETE FROM projects WHERE id = ?').run(id);
  // 该项目下的任务回落到默认项目
  d.prepare('UPDATE tasks SET project_id = ?, updated_at = ? WHERE project_id = ?').run(DEFAULT_PROJECT_ID, Date.now(), id);
  return listProjects();
}

// ---------- search engines ----------

const BUILTIN_ENGINES: SearchEngine[] = [
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s', group: '通用', enabled: true, builtin: true },
  { id: 'bing', name: 'Bing', template: 'https://cn.bing.com/search?q=%s', group: '通用', enabled: true, builtin: true },
  { id: 'sogou', name: '搜狗', template: 'https://www.sogou.com/web?query=%s', group: '通用', enabled: false, builtin: true },
  { id: 'github', name: 'GitHub', template: 'https://github.com/search?q=%s', group: '代码', enabled: true, builtin: true },
  { id: 'arxiv', name: 'arXiv', template: 'https://arxiv.org/search/?query=%s&searchtype=all', group: '学术', enabled: false, builtin: true },
  { id: 'pinterest', name: 'Pinterest', template: 'https://www.pinterest.com/search/pins/?q=%s', group: '图片', enabled: false, builtin: true },
];

// engines 全部入库（首次启动种子化内置引擎，之后统一读写 DB）

interface EngineRow {
  id: string; name: string; template: string; grp: string | null; enabled: number; builtin: number;
}

function rowToEngine(r: EngineRow): SearchEngine {
  return { id: r.id, name: r.name, template: r.template, group: r.grp ?? '', enabled: r.enabled === 1, builtin: r.builtin === 1 };
}

function seedEngines(): void {
  const d = getDb();
  const count = (d.prepare('SELECT COUNT(*) AS c FROM engines').get() as { c: number }).c;
  if (count > 0) return;
  const ins = d.prepare('INSERT OR IGNORE INTO engines (id,name,template,grp,enabled,builtin) VALUES (?,?,?,?,?,?)');
  for (const e of BUILTIN_ENGINES) ins.run(e.id, e.name, e.template, e.group, e.enabled ? 1 : 0, 1);
}

export function listEngines(): SearchEngine[] {
  seedEngines();
  const rows = getDb().prepare('SELECT * FROM engines').all() as EngineRow[];
  return rows.map(rowToEngine);
}

export function saveEngine(engine: SearchEngine): SearchEngine[] {
  getDb().prepare('INSERT OR REPLACE INTO engines (id,name,template,grp,enabled,builtin) VALUES (?,?,?,?,?,?)').run(
    engine.id, engine.name, engine.template, engine.group, engine.enabled ? 1 : 0, engine.builtin ? 1 : 0,
  );
  return listEngines();
}

export function deleteEngine(id: string): SearchEngine[] {
  getDb().prepare('DELETE FROM engines WHERE id = ?').run(id);
  return listEngines();
}

// ---------- focus history ----------

export function appendFocusRecord(rec: FocusRecord): void {
  const dir = path.join(wbRoot(), 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'focus.jsonl'), JSON.stringify(rec) + '\n');
}

export function listFocusRecords(): FocusRecord[] {
  try {
    const raw = fs.readFileSync(path.join(wbRoot(), 'history', 'focus.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FocusRecord)
      .reverse()
      .slice(0, 100);
  } catch {
    return [];
  }
}

// ---------- forged widget library ----------

export interface LibraryItem {
  id: string;
  title: string;
  html: string;
  createdAt: number;
}

// ---------- library (SQLite) ----------

export function listLibrary(): LibraryItem[] {
  const rows = getDb().prepare('SELECT * FROM library ORDER BY created_at DESC').all() as LibraryItem[];
  return rows;
}

export function addLibraryItem(item: LibraryItem): LibraryItem[] {
  getDb().prepare('INSERT OR REPLACE INTO library (id,title,html,created_at) VALUES (?,?,?,?)').run(
    item.id, item.title, item.html, item.createdAt,
  );
  return listLibrary();
}

export function deleteLibraryItem(id: string): LibraryItem[] {
  getDb().prepare('DELETE FROM library WHERE id = ?').run(id);
  return listLibrary();
}

export function updateLibraryItem(id: string, patch: Partial<LibraryItem>): LibraryItem | null {
  const d = getDb();
  const item = d.prepare('SELECT * FROM library WHERE id = ?').get(id) as LibraryItem | undefined;
  if (!item) return null;
  d.prepare('UPDATE library SET title = ?, html = ? WHERE id = ?').run(
    patch.title ?? item.title, patch.html ?? item.html, id,
  );
  return { ...item, ...patch };
}

// ---------- memory.md (agent 长期记忆，主会话注入) ----------

export function memoryPath(): string {
  return path.join(wbRoot(), 'memory.md');
}

export function ensureMemoryFile(): void {
  const p = memoryPath();
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '# 长期记忆\n\n（由 agent 维护：值得长期记住的用户偏好、事实、约定。条目化，带日期。）\n');
  }
}

/** memory.md content, tail-truncated for prompt injection */
export function readMemory(maxChars = 4000): string {
  ensureMemoryFile();
  const content = fs.readFileSync(memoryPath(), 'utf8').trim();
  return content.length > maxChars ? content.slice(content.length - maxChars) : content;
}

/** memory.md 整文覆盖写（Agents 页长期记忆编辑器用） */
export function writeMemory(content: string): void {
  ensureMemoryFile();
  fs.writeFileSync(memoryPath(), content, 'utf8');
}

// ---------- agents.md (workspace-level, managed markers) ----------

export const MANAGED_START = '<!-- kimi-float:managed:start -->';
export const MANAGED_END = '<!-- kimi-float:managed:end -->';

export function agentsPath(workspaceDir: string): string {
  return path.join(workspaceDir, 'AGENTS.md');
}

export function readAgents(workspaceDir: string): string {
  try {
    return fs.readFileSync(agentsPath(workspaceDir), 'utf8');
  } catch {
    return '';
  }
}

/** Write user content while preserving the managed block from the on-disk version. */
export function writeAgents(workspaceDir: string, userContent: string): void {
  const current = readAgents(workspaceDir);
  const managed = extractManaged(current);
  let next = userContent;
  if (managed !== null) {
    if (extractManaged(userContent) === null) {
      // user content lost the markers — re-wrap managed block at the top
      next = `${MANAGED_START}\n${managed}\n${MANAGED_END}\n\n${stripManaged(userContent).trim()}\n`;
    }
  }
  fs.writeFileSync(agentsPath(workspaceDir), next);
}

function extractManaged(content: string): string | null {
  const m = content.match(/<!-- kimi-float:managed:start -->([\s\S]*?)<!-- kimi-float:managed:end -->/);
  return m ? m[1].trim() : null;
}

function stripManaged(content: string): string {
  return content.replace(/<!-- kimi-float:managed:start -->[\s\S]*?<!-- kimi-float:managed:end -->/, '');
}

/** Replace the managed block in an existing file, or create the file with one. */
export function writeManagedBlock(workspaceDir: string, managedBody: string): void {
  const current = readAgents(workspaceDir);
  const block = `${MANAGED_START}\n${managedBody.trim()}\n${MANAGED_END}`;
  if (!current) {
    fs.writeFileSync(agentsPath(workspaceDir), `${block}\n\n<!-- 以下是你的个人区域，可在工作台 Agents 面板中自由编辑 -->\n`);
    return;
  }
  if (extractManaged(current) !== null) {
    fs.writeFileSync(agentsPath(workspaceDir), current.replace(/<!-- kimi-float:managed:start -->[\s\S]*?<!-- kimi-float:managed:end -->/, block));
    return;
  }
  // legacy file without markers: old content was entirely app-written (vault convention) — wrap it as managed
  fs.writeFileSync(agentsPath(workspaceDir), `${MANAGED_START}\n${current.trim()}\n${MANAGED_END}\n\n<!-- 以下是你的个人区域，可在工作台 Agents 面板中自由编辑 -->\n`);
}
