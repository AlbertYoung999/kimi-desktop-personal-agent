// ---- workbench shared types (main <-> workbench renderer) ----

export interface WidgetSize {
  w: number; // grid units
  h: number;
}

export interface WidgetDefinition {
  id: string;
  name: string;
  icon: string; // emoji shown in dock / palette
  description: string;
  category: string;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
}

/** A placed widget instance on the stage (persisted in layout.json). */
export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  x: number; // px on stage
  y: number;
  w: number; // px
  h: number;
  minimized: boolean;
  config: Record<string, unknown>; // user overlay
}

export interface WorkbenchLayout {
  widgets: WidgetInstance[];
}

// ---- task flow ----

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'canceled';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  startDate?: string;
  dueDate?: string;
  completedAt?: string;
  notes: string;
  tags: string[];
  sessionId?: string; // ACP session created from this task
  projectId?: string; // 挂载的项目；空 = 默认项目
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** 默认项目 id：任务未显式挂载时归属该项目，不可删除 */
export const DEFAULT_PROJECT_ID = 'default';

// ---- search engines ----

export interface SearchEngine {
  id: string;
  name: string;
  template: string; // %s = query
  group: string;
  enabled: boolean;
  builtin: boolean;
}

// ---- info radar ----

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string; // ISO date string
  tags: string[];
  read: boolean;
  favorite: boolean;
}

export interface Radar {
  id: string;
  name: string;
  icon: string; // emoji
  query: string; // natural-language config the user typed
  sources: string[]; // fetchable URLs (GitHub API / arXiv API / HN Algolia API)
  frequencyMinutes: number;
  items: NewsItem[];
  enabled: boolean;
  lastRunAt: number | null;
}

/** payload of evRadarItems push (main -> workbench) */
export interface RadarItemsPush {
  radarId: string;
  newCount: number;
}

// ---- deep focus ----

export interface FocusRecord {
  mode: 'sprint' | 'deep' | 'breath';
  task: string;
  minutes: number;
  completedAt: number;
  note: string;
}
