import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function writeJson(rel: string, value: unknown): void {
  const p = path.join(wbRoot(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

// ---------- layout ----------

export function getLayout(): WorkbenchLayout {
  return readJson<WorkbenchLayout>('layout.json', { widgets: [] });
}

export function saveLayout(layout: WorkbenchLayout): void {
  writeJson('layout.json', layout);
}

// ---------- tasks ----------

export function listTasks(): Task[] {
  return readJson<Task[]>('tasks.json', []);
}

function nextOccurrence(from: Date, recurrence: 'daily' | 'weekly' | 'workdays'): Date {
  const next = new Date(from);
  if (recurrence === 'daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else {
    // workdays: skip to the next Mon-Fri
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getDay() === 0 || next.getDay() === 6);
  }
  return next;
}

export function saveTask(task: Task): Task[] {
  const all = listTasks();
  const prev = all.find((t) => t.id === task.id);
  const tasks = all.filter((t) => t.id !== task.id);
  task.updatedAt = Date.now();
  tasks.unshift(task);

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
    tasks.unshift(next);
  }

  writeJson('tasks.json', tasks);
  return tasks;
}

export function deleteTask(id: string): Task[] {
  const tasks = listTasks().filter((t) => t.id !== id);
  writeJson('tasks.json', tasks);
  return tasks;
}

// ---------- projects ----------

export function listProjects(): Project[] {
  const projects = readJson<Project[]>('projects.json', []);
  if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
    const now = Date.now();
    projects.unshift({ id: DEFAULT_PROJECT_ID, name: '默认', createdAt: now, updatedAt: now });
    writeJson('projects.json', projects);
  }
  return projects;
}

export function saveProject(project: Project): Project[] {
  const projects = listProjects().filter((p) => p.id !== project.id);
  project.updatedAt = Date.now();
  projects.push(project);
  writeJson('projects.json', projects);
  return projects;
}

export function deleteProject(id: string): Project[] {
  if (id === DEFAULT_PROJECT_ID) return listProjects(); // 默认项目不可删除
  const projects = listProjects().filter((p) => p.id !== id);
  writeJson('projects.json', projects);
  // 该项目下的任务回落到默认项目
  const tasks = listTasks().map((t) =>
    t.projectId === id ? { ...t, projectId: DEFAULT_PROJECT_ID, updatedAt: Date.now() } : t,
  );
  writeJson('tasks.json', tasks);
  return projects;
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

interface EnginesFile {
  overrides: Record<string, SearchEngine>;
  deletedBuiltinIds: string[];
}

function readEnginesFile(): EnginesFile {
  const raw = readJson<Partial<EnginesFile>>('engines.json', {});
  return { overrides: raw.overrides ?? {}, deletedBuiltinIds: raw.deletedBuiltinIds ?? [] };
}

export function listEngines(): SearchEngine[] {
  const file = readEnginesFile();
  const merged = BUILTIN_ENGINES.filter((e) => !file.deletedBuiltinIds.includes(e.id)).map(
    (e) => file.overrides[e.id] ?? e,
  );
  for (const [id, e] of Object.entries(file.overrides)) {
    if (!BUILTIN_ENGINES.some((b) => b.id === id)) merged.push(e);
  }
  return merged;
}

export function saveEngine(engine: SearchEngine): SearchEngine[] {
  const file = readEnginesFile();
  file.overrides[engine.id] = engine;
  file.deletedBuiltinIds = file.deletedBuiltinIds.filter((id) => id !== engine.id);
  writeJson('engines.json', file);
  return listEngines();
}

export function deleteEngine(id: string): SearchEngine[] {
  const file = readEnginesFile();
  delete file.overrides[id];
  if (BUILTIN_ENGINES.some((b) => b.id === id) && !file.deletedBuiltinIds.includes(id)) {
    file.deletedBuiltinIds.push(id);
  }
  writeJson('engines.json', file);
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

export function listLibrary(): LibraryItem[] {
  return readJson<LibraryItem[]>('library.json', []);
}

export function addLibraryItem(item: LibraryItem): LibraryItem[] {
  const list = listLibrary().filter((i) => i.id !== item.id);
  list.unshift(item);
  writeJson('library.json', list);
  return list;
}

export function deleteLibraryItem(id: string): LibraryItem[] {
  const list = listLibrary().filter((i) => i.id !== id);
  writeJson('library.json', list);
  return list;
}

export function updateLibraryItem(id: string, patch: Partial<LibraryItem>): LibraryItem | null {
  const list = listLibrary();
  const item = list.find((i) => i.id === id);
  if (!item) return null;
  Object.assign(item, patch);
  writeJson('library.json', list);
  return item;
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
