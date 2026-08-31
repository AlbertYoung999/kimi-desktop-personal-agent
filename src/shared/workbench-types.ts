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

export type TaskRecurrence = 'none' | 'daily' | 'weekly' | 'workdays';

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
  recurrence?: TaskRecurrence; // 重复任务频率（默认 none）
  parentId?: string; // 子任务：挂载的主任务 id（只支持一层）
  scheduledStart?: string; // 日程：计划执行开始时间 ISO
  scheduledEnd?: string; // 日程：计划执行结束时间 ISO
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  color?: string; // hex，看板上的项目标识色
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

// ---- pomodoro (by 任务的番茄钟，v5.0) ----

/** 一条已结束的番茄钟记录（pomodoro_sessions 表） */
export interface PomodoroSession {
  id: number;
  taskId: string;
  startedAt: number;
  endedAt?: number;
  minutes: number; // 实际专注分钟数
  completed: boolean; // true = 完整跑完；false = 提前停止
}

/** 进行中的番茄钟状态（main 进程持有，向各窗口广播） */
export interface PomodoroState {
  active: boolean;
  taskId?: string;
  taskTitle?: string;
  startedAt?: number;
  durationMin?: number; // 目标时长（默认 25）
}
