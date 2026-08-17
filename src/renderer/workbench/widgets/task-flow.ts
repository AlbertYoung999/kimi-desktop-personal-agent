import { registerWidget } from '../core/registry';
import type { Project, Task, TaskPriority, TaskStatus } from '../../../shared/workbench-types';
import { DEFAULT_PROJECT_ID } from '../../../shared/workbench-types';

/* ------------------------------------------------------------------ */
/* styles (injected once, all classes prefixed wf-task-flow-)          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'wf-task-flow-style';
const CSS = `
.wf-task-flow-root { position: relative; height: 100%; display: flex; flex-direction: column; gap: 10px; }
.wf-task-flow-topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.wf-task-flow-viewbtn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11.5px; padding: 4px 10px; cursor: pointer;
}
.wf-task-flow-viewbtn:first-of-type { border-radius: 6px 0 0 6px; }
.wf-task-flow-viewbtn:nth-of-type(2) { border-radius: 0 6px 6px 0; margin-left: -8px; border-left: none; }
.wf-task-flow-viewbtn.active { color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.06); z-index: 1; position: relative; }
.wf-task-flow-search {
  flex: 1; min-width: 60px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 12px;
  padding: 4px 10px; outline: none;
}
.wf-task-flow-search:focus { border-color: var(--border-strong); }
.wf-task-flow-newbtn {
  border: 1px solid var(--border-strong); background: rgba(0,240,255,0.08); color: var(--neon);
  font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  transition: box-shadow 160ms var(--ease-in); white-space: nowrap;
}
.wf-task-flow-newbtn:hover { box-shadow: 0 0 12px rgba(0,240,255,0.25); }
.wf-task-flow-content { flex: 1; overflow: auto; min-height: 0; }

/* board */
.wf-task-flow-board { display: flex; gap: 10px; height: 100%; min-width: min-content; }
.wf-task-flow-col {
  flex: 1 1 0; min-width: 200px; display: flex; flex-direction: column;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  border-radius: 10px; overflow: hidden;
}
.wf-task-flow-col.dragover { border-color: var(--border-strong); background: rgba(0,240,255,0.04); }
.wf-task-flow-colhead {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 1px; color: var(--muted);
  border-bottom: 1px solid rgba(255,255,255,0.05); flex-shrink: 0;
}
.wf-task-flow-colcount {
  margin-left: auto; color: var(--neon); border: 1px solid var(--border);
  border-radius: 8px; padding: 0 7px; font-size: 10px; line-height: 16px;
}
.wf-task-flow-cards { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.wf-task-flow-card {
  display: flex; gap: 8px; align-items: flex-start; background: var(--card);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  cursor: grab; transition: border-color 120ms var(--ease-in);
}
.wf-task-flow-card:hover { border-color: var(--border-strong); }
.wf-task-flow-card.dragging { opacity: 0.4; }
.wf-task-flow-dot {
  width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0;
  cursor: pointer; box-shadow: 0 0 6px currentColor;
}
.wf-task-flow-cardmain { flex: 1; min-width: 0; }
.wf-task-flow-cardtitle { font-size: 12.5px; line-height: 1.4; cursor: text; word-break: break-word; }
.wf-task-flow-card.done .wf-task-flow-cardtitle { color: var(--disabled); text-decoration: line-through; }
.wf-task-flow-carddue { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 4px; }
.wf-task-flow-carddue.overdue { color: var(--error); }
.wf-task-flow-carddue.today { color: var(--neon); text-shadow: 0 0 8px rgba(0,240,255,0.45); }
.wf-task-flow-titleedit {
  width: 100%; border: 1px solid var(--border-strong); border-radius: 4px;
  background: rgba(0,0,0,0.3); color: var(--fg); font: inherit; font-size: 12.5px;
  padding: 2px 6px; outline: none;
}
.wf-task-flow-quick {
  border: none; border-top: 1px solid rgba(255,255,255,0.05); background: transparent;
  color: var(--disabled); font: inherit; font-size: 12px; padding: 8px 10px; outline: none;
  flex-shrink: 0;
}
.wf-task-flow-quick:focus { color: var(--fg); }
.wf-task-flow-quick::placeholder { color: var(--disabled); }

/* calendar */
.wf-task-flow-cal { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wf-task-flow-calhead { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.wf-task-flow-calnav {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.wf-task-flow-calnav:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-task-flow-caltitle { font-family: var(--mono); font-size: 12px; color: var(--neon); letter-spacing: 1px; }
.wf-task-flow-calgrid {
  flex: 1; display: grid; grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: 1fr; gap: 4px; min-height: 0;
}
.wf-task-flow-calgrid.weekdays { flex: none; grid-auto-rows: none; }
.wf-task-flow-calwd { font-family: var(--mono); font-size: 10px; color: var(--disabled); text-align: center; padding: 2px 0; }
.wf-task-flow-cell {
  border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 4px 5px;
  overflow: hidden; display: flex; flex-direction: column; gap: 2px; min-height: 56px;
}
.wf-task-flow-cell.out { opacity: 0.3; }
.wf-task-flow-cell.today { border-color: var(--border-strong); box-shadow: inset 0 0 10px rgba(0,240,255,0.08); }
.wf-task-flow-daynum { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.wf-task-flow-cell.today .wf-task-flow-daynum { color: var(--neon); }
.wf-task-flow-chip {
  font-size: 10.5px; line-height: 1.3; padding: 1px 5px; border-radius: 4px;
  background: rgba(0,240,255,0.08); border-left: 2px solid var(--neon);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.wf-task-flow-chip.done { opacity: 0.45; text-decoration: line-through; }
.wf-task-flow-chip.overdue { background: rgba(255,68,68,0.1); border-left-color: var(--error); color: var(--error); }

/* project selector */
.wf-task-flow-projsel {
  max-width: 132px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 11.5px;
  padding: 4px 6px; outline: none; flex-shrink: 0; cursor: pointer;
}
.wf-task-flow-projsel:focus { border-color: var(--border-strong); }
.wf-task-flow-projsel option { background: var(--card); }
.wf-task-flow-projinput {
  width: 132px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 11.5px;
  padding: 4px 6px; outline: none; flex-shrink: 0;
}
.wf-task-flow-projinput::placeholder { color: var(--disabled); }
.wf-task-flow-cardproj {
  display: inline-block; margin-top: 4px; padding: 0 7px; border-radius: 8px;
  border: 1px solid; font-family: var(--mono); font-size: 10px; line-height: 16px;
}

/* empty state */
.wf-task-flow-empty {
  height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--disabled); font-size: 12.5px;
}
.wf-task-flow-empty kbd {
  font-family: var(--mono); border: 1px solid var(--border-strong); border-radius: 4px;
  color: var(--neon); padding: 1px 6px; font-size: 11px;
}

/* detail panel */
.wf-task-flow-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 88%);
  background: var(--card); border-left: 1px solid var(--border-strong);
  box-shadow: -12px 0 32px rgba(0,0,0,0.5); z-index: 10;
  display: flex; flex-direction: column; animation: wf-task-flow-slidein 180ms var(--ease-in);
}
@keyframes wf-task-flow-slidein { from { transform: translateX(24px); opacity: 0; } }
.wf-task-flow-panelhead {
  display: flex; align-items: center; padding: 10px 12px; gap: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;
}
.wf-task-flow-panelhead span { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: 1px; }
.wf-task-flow-panelclose {
  margin-left: auto; border: none; background: none; color: var(--disabled);
  font-size: 15px; cursor: pointer; width: 24px; height: 24px; border-radius: 5px;
}
.wf-task-flow-panelclose:hover { color: var(--fg); background: rgba(255,255,255,0.08); }
.wf-task-flow-panelbody { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.wf-task-flow-ptitle {
  border: none; background: transparent; color: var(--fg); font: inherit;
  font-size: 16px; font-weight: 600; padding: 4px 0; outline: none;
  border-bottom: 1px solid transparent;
}
.wf-task-flow-ptitle:focus { border-bottom-color: var(--border-strong); }
.wf-task-flow-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.wf-task-flow-field label { width: 56px; flex-shrink: 0; color: var(--disabled); font-size: 11px; }
.wf-task-flow-input, .wf-task-flow-select, .wf-task-flow-textarea {
  flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 12px;
  padding: 5px 8px; outline: none;
}
.wf-task-flow-input:focus, .wf-task-flow-select:focus, .wf-task-flow-textarea:focus { border-color: var(--border-strong); }
.wf-task-flow-input[type="datetime-local"] { color-scheme: dark; font-family: var(--mono); font-size: 11.5px; }
.wf-task-flow-input[type="datetime-local"]::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }
.wf-task-flow-input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover { opacity: 1; }
.wf-task-flow-select option { background: var(--card); }
.wf-task-flow-textarea { resize: vertical; min-height: 110px; font-family: var(--mono); line-height: 1.5; }
.wf-task-flow-panelfoot {
  display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0; flex-wrap: wrap;
}
.wf-task-flow-btn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
}
.wf-task-flow-btn:hover { color: var(--fg); border-color: var(--border-strong); }
.wf-task-flow-btn.primary { color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.08); }
.wf-task-flow-btn.primary:hover { box-shadow: 0 0 12px rgba(0,240,255,0.25); }
.wf-task-flow-btn.danger:hover { color: var(--error); border-color: var(--error); }
.wf-task-flow-btn.session { color: var(--green); border-color: rgba(0,255,136,0.35); background: rgba(0,255,136,0.06); }
.wf-task-flow-btn:disabled { opacity: 0.5; cursor: default; }
`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'BACKLOG' },
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
];

const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const PRIORITY_COLOR: Record<TaskPriority, string> = {
  urgent: 'var(--error)',
  high: 'var(--warn)',
  medium: 'var(--neon)',
  low: 'var(--disabled)',
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 项目标签色板：按项目名 hash 取色 */
const PROJECT_PALETTE = ['#00f0ff', '#00ff88', '#ffb020', '#ff7ab8', '#9d7bff', '#ff8844'];

function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PROJECT_PALETTE[Math.abs(h) % PROJECT_PALETTE.length];
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function newId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 旧的纯日期格式 YYYY-MM-DD（datetime 改造前的存量数据） */
function isLegacyDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 本地日期 key YYYY-MM-DD，用于日历归格 / 与今天比较（兼容旧纯日期格式） */
function dateKey(s: string): string {
  if (isLegacyDate(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 是否携带具体时间（旧纯日期格式视为无时间） */
function hasClock(s: string): boolean {
  return !isLegacyDate(s) && s.includes('T');
}

/** ISO string → datetime-local 输入框需要的本地格式 YYYY-MM-DDTHH:mm */
function toLocalInput(s?: string): string {
  if (!s) return '';
  if (isLegacyDate(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return `${dateKey(s)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 卡片/chip 显示：M/d，带时间时 M/d HH:mm */
function fmtWhen(s: string): string {
  if (isLegacyDate(s)) {
    const parts = s.split('-');
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const base = `${d.getMonth() + 1}/${d.getDate()}`;
  return hasClock(s) ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
}

/** HH:mm（仅日历 chip 用，调用前需 hasClock 判断） */
function clockOf(s: string): string {
  const d = new Date(s);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isOverdue(t: Task): boolean {
  if (!t.dueDate || t.status === 'done' || t.status === 'canceled') return false;
  // 带时间的按时刻比较；旧纯日期格式按天比较（当天不算逾期）
  if (isLegacyDate(t.dueDate)) return t.dueDate < todayStr();
  const ts = new Date(t.dueDate).getTime();
  return !isNaN(ts) && ts < Date.now();
}

function isDueToday(t: Task): boolean {
  return (
    !!t.dueDate &&
    t.status !== 'done' &&
    t.status !== 'canceled' &&
    !isOverdue(t) &&
    dateKey(t.dueDate) === todayStr()
  );
}

function matchesQuery(t: Task, q: string): boolean {
  if (!q) return true;
  const hay = `${t.title}\n${t.description}\n${t.tags.join(' ')}`.toLowerCase();
  return hay.includes(q);
}

function blankTask(status: TaskStatus): Task {
  const now = Date.now();
  return {
    id: newId(),
    title: '',
    description: '',
    status,
    priority: 'medium',
    notes: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* widget                                                              */
/* ------------------------------------------------------------------ */

registerWidget({
  def: {
    id: 'task-flow',
    name: 'Task Flow',
    icon: '▦',
    description: '任务看板：看板/日历视图，任务可转 AI Session',
    category: 'productivity',
    defaultSize: { w: 16, h: 12 },
    minSize: { w: 10, h: 8 },
  },
  mount(body, ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    const now = new Date();
    const state = {
      tasks: [] as Task[],
      projects: [] as Project[],
      /** 'all' = 全部项目，否则为项目 id */
      projectId: (typeof ctx.config.projectId === 'string' ? ctx.config.projectId : DEFAULT_PROJECT_ID) as string,
      view: (ctx.config.view === 'calendar' ? 'calendar' : 'board') as 'board' | 'calendar',
      query: '',
      calYear: now.getFullYear(),
      calMonth: now.getMonth(),
    };

    const root = el('div', 'wf-task-flow-root');
    const topbar = el('div', 'wf-task-flow-topbar');
    const content = el('div', 'wf-task-flow-content');
    root.append(topbar, content);
    body.innerHTML = '';
    body.appendChild(root);

    let panelEl: HTMLElement | null = null;

    /* ---------- data ---------- */

    async function reload(): Promise<void> {
      try {
        [state.tasks, state.projects] = await Promise.all([ctx.api.listTasks(), ctx.api.listProjects()]);
      } catch {
        state.tasks = [];
        state.projects = [];
      }
      if (state.projectId !== 'all' && !state.projects.some((p) => p.id === state.projectId)) {
        state.projectId = DEFAULT_PROJECT_ID;
      }
      renderProjectOptions();
      renderContent();
    }

    async function persist(task: Task): Promise<void> {
      task.updatedAt = Date.now();
      state.tasks = await ctx.api.saveTask(task);
      renderContent();
    }

    async function removeTask(id: string): Promise<void> {
      state.tasks = await ctx.api.deleteTask(id);
      renderContent();
    }

    /** 任务归属项目：未显式挂载的存量任务视为默认项目 */
    function taskProject(t: Task): string {
      return t.projectId ?? DEFAULT_PROJECT_ID;
    }

    function projectName(id: string): string {
      return state.projects.find((p) => p.id === id)?.name ?? '默认';
    }

    function filtered(): Task[] {
      return state.tasks.filter(
        (t) => (state.projectId === 'all' || taskProject(t) === state.projectId) && matchesQuery(t, state.query),
      );
    }

    /** 新建任务时的默认归属项目 */
    function activeProjectId(): string {
      return state.projectId === 'all' ? DEFAULT_PROJECT_ID : state.projectId;
    }

    /* ---------- topbar ---------- */

    const btnBoard = el('button', 'wf-task-flow-viewbtn', '看板');
    const btnCal = el('button', 'wf-task-flow-viewbtn', '日历');
    const projSel = el('select', 'wf-task-flow-projsel') as HTMLSelectElement;
    projSel.title = '切换项目';
    const search = el('input', 'wf-task-flow-search') as HTMLInputElement;
    search.placeholder = '搜索任务…';
    const btnNew = el('button', 'wf-task-flow-newbtn', '＋ 新建');
    topbar.append(btnBoard, btnCal, projSel, search, btnNew);

    const NEW_PROJECT_VALUE = '__new__';

    function renderProjectOptions(): void {
      projSel.innerHTML = '';
      const add = (value: string, label: string): void => {
        const o = el('option', '', label) as HTMLOptionElement;
        o.value = value;
        projSel.appendChild(o);
      };
      add('all', '全部项目');
      for (const p of state.projects) add(p.id, p.name);
      add(NEW_PROJECT_VALUE, '＋ 新建项目…');
      projSel.value = state.projectId;
    }

    projSel.addEventListener('change', () => {
      const v = projSel.value;
      if (v === NEW_PROJECT_VALUE) {
        startProjectCreate();
        return;
      }
      state.projectId = v;
      ctx.setConfig({ projectId: v });
      renderContent();
    });

    /** 把项目下拉换成内联输入框：回车创建新项目，Esc/blur 还原 */
    function startProjectCreate(): void {
      const input = el('input', 'wf-task-flow-projinput') as HTMLInputElement;
      input.placeholder = '新项目名称，回车创建';
      projSel.replaceWith(input);
      input.focus();
      let done = false;
      const restore = (): void => {
        if (done) return;
        done = true;
        input.replaceWith(projSel);
        renderProjectOptions();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          restore();
          return;
        }
        if (e.key !== 'Enter') return;
        const name = input.value.trim();
        if (!name) {
          restore();
          return;
        }
        done = true;
        const nowTs = Date.now();
        const p: Project = {
          id: `p${nowTs.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name,
          createdAt: nowTs,
          updatedAt: nowTs,
        };
        void ctx.api.saveProject(p).then((projects) => {
          state.projects = projects;
          state.projectId = p.id;
          ctx.setConfig({ projectId: p.id });
          input.replaceWith(projSel);
          renderProjectOptions();
          renderContent();
        });
      });
      input.addEventListener('blur', restore);
    }

    function syncViewButtons(): void {
      btnBoard.classList.toggle('active', state.view === 'board');
      btnCal.classList.toggle('active', state.view === 'calendar');
    }

    function setView(v: 'board' | 'calendar'): void {
      state.view = v;
      ctx.setConfig({ view: v });
      syncViewButtons();
      renderContent();
    }

    btnBoard.addEventListener('click', () => setView('board'));
    btnCal.addEventListener('click', () => setView('calendar'));
    search.addEventListener('input', () => {
      state.query = search.value.trim().toLowerCase();
      renderContent();
    });
    btnNew.addEventListener('click', () => openDetail(null));
    syncViewButtons();

    /* ---------- board ---------- */

    function renderBoard(container: HTMLElement): void {
      const board = el('div', 'wf-task-flow-board');
      const tasks = filtered();

      for (const col of COLUMNS) {
        const colTasks = tasks.filter((t) => t.status === col.id);
        const colEl = el('div', 'wf-task-flow-col');
        colEl.dataset.status = col.id;

        const head = el('div', 'wf-task-flow-colhead');
        head.append(el('span', '', col.label), el('span', 'wf-task-flow-colcount', String(colTasks.length)));
        colEl.appendChild(head);

        const cards = el('div', 'wf-task-flow-cards');
        for (const t of colTasks) cards.appendChild(renderCard(t));
        colEl.appendChild(cards);

        const quick = el('input', 'wf-task-flow-quick') as HTMLInputElement;
        quick.placeholder = '＋ 输入标题，回车创建';
        quick.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const title = quick.value.trim();
          if (!title) return;
          quick.value = '';
          const t = blankTask(col.id);
          t.title = title;
          t.projectId = activeProjectId();
          void persist(t);
        });
        colEl.appendChild(quick);

        // drop target
        colEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          colEl.classList.add('dragover');
        });
        colEl.addEventListener('dragleave', () => colEl.classList.remove('dragover'));
        colEl.addEventListener('drop', (e) => {
          e.preventDefault();
          colEl.classList.remove('dragover');
          const id = e.dataTransfer?.getData('text/plain');
          const t = state.tasks.find((x) => x.id === id);
          if (t && t.status !== col.id) {
            t.status = col.id;
            if (col.id === 'done') t.completedAt = new Date().toISOString();
            void persist(t);
          }
        });

        board.appendChild(colEl);
      }
      container.appendChild(board);
    }

    function renderCard(t: Task): HTMLElement {
      const card = el('div', `wf-task-flow-card${t.status === 'done' ? ' done' : ''}`);
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', t.id);
        e.dataTransfer?.setDragImage(card, 20, 20);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      const dot = el('span', 'wf-task-flow-dot');
      dot.style.background = PRIORITY_COLOR[t.priority];
      dot.style.color = PRIORITY_COLOR[t.priority];
      dot.title = `优先级：${PRIORITY_LABEL[t.priority]}（点击切换）`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = PRIORITY_ORDER.indexOf(t.priority);
        t.priority = PRIORITY_ORDER[(i + 1) % PRIORITY_ORDER.length];
        void persist(t);
      });

      const main = el('div', 'wf-task-flow-cardmain');
      const title = el('div', 'wf-task-flow-cardtitle', t.title);
      title.title = '点击编辑标题';
      title.addEventListener('click', (e) => {
        e.stopPropagation();
        startTitleEdit(t, title);
      });
      main.appendChild(title);

      if (t.startDate) {
        main.appendChild(el('div', 'wf-task-flow-carddue', `▶ ${fmtWhen(t.startDate)}`));
      }
      if (t.dueDate) {
        const cls = isOverdue(t) ? ' overdue' : isDueToday(t) ? ' today' : '';
        const due = el('div', `wf-task-flow-carddue${cls}`, `⏳ ${fmtWhen(t.dueDate)}`);
        main.appendChild(due);
      }
      if (t.sessionId) {
        main.appendChild(el('div', 'wf-task-flow-carddue', '⚡ 已关联 Session'));
      }
      const projName = projectName(taskProject(t));
      const projColor = projectColor(projName);
      const projTag = el('span', 'wf-task-flow-cardproj', `▸ ${projName}`);
      projTag.style.color = projColor;
      projTag.style.borderColor = hexToRgba(projColor, 0.4);
      projTag.style.background = hexToRgba(projColor, 0.08);
      main.appendChild(projTag);

      card.append(dot, main);
      card.addEventListener('click', () => openDetail(t.id));
      return card;
    }

    function startTitleEdit(t: Task, titleEl: HTMLElement): void {
      const input = el('input', 'wf-task-flow-titleedit') as HTMLInputElement;
      input.value = t.title;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (): void => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v && v !== t.title) {
          t.title = v;
          void persist(t);
        } else {
          renderContent();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          done = true;
          renderContent();
        }
        e.stopPropagation();
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (e) => e.stopPropagation());
    }

    /* ---------- calendar ---------- */

    function renderCalendar(container: HTMLElement): void {
      const cal = el('div', 'wf-task-flow-cal');

      const head = el('div', 'wf-task-flow-calhead');
      const prev = el('button', 'wf-task-flow-calnav', '‹');
      const next = el('button', 'wf-task-flow-calnav', '›');
      const title = el('span', 'wf-task-flow-caltitle', `${state.calYear} 年 ${state.calMonth + 1} 月`);
      const todayBtn = el('button', 'wf-task-flow-btn', '今天');
      head.append(prev, title, next, todayBtn);
      cal.appendChild(head);

      prev.addEventListener('click', () => shiftMonth(-1));
      next.addEventListener('click', () => shiftMonth(1));
      todayBtn.addEventListener('click', () => {
        const d = new Date();
        state.calYear = d.getFullYear();
        state.calMonth = d.getMonth();
        renderContent();
      });

      const wd = el('div', 'wf-task-flow-calgrid weekdays');
      for (const w of WEEKDAYS) wd.appendChild(el('div', 'wf-task-flow-calwd', w));
      cal.appendChild(wd);

      const grid = el('div', 'wf-task-flow-calgrid');
      const { calYear: y, calMonth: m } = state;
      const first = new Date(y, m, 1);
      const offset = (first.getDay() + 6) % 7; // Monday-first
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const daysInPrev = new Date(y, m, 0).getDate();
      const tstr = todayStr();

      const byDate = new Map<string, Task[]>();
      for (const t of filtered()) {
        if (!t.dueDate) continue;
        const key = dateKey(t.dueDate);
        const list = byDate.get(key) ?? [];
        list.push(t);
        byDate.set(key, list);
      }

      const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;
      for (let i = 0; i < totalCells; i++) {
        const dayNum = i - offset + 1;
        let cellDate: Date;
        let out = false;
        if (dayNum < 1) {
          cellDate = new Date(y, m - 1, daysInPrev + dayNum);
          out = true;
        } else if (dayNum > daysInMonth) {
          cellDate = new Date(y, m + 1, dayNum - daysInMonth);
          out = true;
        } else {
          cellDate = new Date(y, m, dayNum);
        }
        const ds = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(cellDate.getDate()).padStart(2, '0')}`;
        const cell = el('div', `wf-task-flow-cell${out ? ' out' : ''}${ds === tstr ? ' today' : ''}`);
        cell.appendChild(el('div', 'wf-task-flow-daynum', String(cellDate.getDate())));
        for (const t of byDate.get(ds) ?? []) {
          const label = t.dueDate && hasClock(t.dueDate) ? `${clockOf(t.dueDate)} ${t.title}` : t.title;
          const chip = el(
            'div',
            `wf-task-flow-chip${t.status === 'done' ? ' done' : ''}${isOverdue(t) ? ' overdue' : ''}`,
            label,
          );
          chip.title = label;
          chip.addEventListener('click', () => openDetail(t.id));
          cell.appendChild(chip);
        }
        grid.appendChild(cell);
      }
      cal.appendChild(grid);
      container.appendChild(cal);
    }

    function shiftMonth(delta: number): void {
      const d = new Date(state.calYear, state.calMonth + delta, 1);
      state.calYear = d.getFullYear();
      state.calMonth = d.getMonth();
      renderContent();
    }

    /* ---------- detail panel ---------- */

    function closeDetail(): void {
      panelEl?.remove();
      panelEl = null;
    }

    /** taskId === null → 新建草稿（保存时才真正创建） */
    function openDetail(taskId: string | null): void {
      closeDetail();
      const existing = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;
      if (taskId && !existing) return;
      const draft: Task = existing ? { ...existing, tags: [...existing.tags] } : blankTask('backlog');
      if (!existing) draft.projectId = activeProjectId();
      const isNew = !existing;

      const panel = el('div', 'wf-task-flow-panel');
      panelEl = panel;
      panel.addEventListener('click', (e) => e.stopPropagation());

      const head = el('div', 'wf-task-flow-panelhead');
      head.append(el('span', '', isNew ? '新建任务' : '任务详情'));
      const close = el('button', 'wf-task-flow-panelclose', '✕');
      close.addEventListener('click', closeDetail);
      head.appendChild(close);
      panel.appendChild(head);

      const pbody = el('div', 'wf-task-flow-panelbody');

      const titleInput = el('input', 'wf-task-flow-ptitle') as HTMLInputElement;
      titleInput.value = draft.title;
      titleInput.placeholder = '任务标题';
      pbody.appendChild(titleInput);

      // status
      const statusSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const c of COLUMNS) {
        const o = el('option', '', c.label) as HTMLOptionElement;
        o.value = c.id;
        statusSel.appendChild(o);
      }
      statusSel.value = draft.status;
      pbody.appendChild(fieldRow('状态', statusSel));

      // priority
      const prioSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const p of PRIORITY_ORDER) {
        const o = el('option', '', PRIORITY_LABEL[p]) as HTMLOptionElement;
        o.value = p;
        prioSel.appendChild(o);
      }
      prioSel.value = draft.priority;
      pbody.appendChild(fieldRow('优先级', prioSel));

      // project
      const projFieldSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const p of state.projects) {
        const o = el('option', '', p.name) as HTMLOptionElement;
        o.value = p.id;
        projFieldSel.appendChild(o);
      }
      projFieldSel.value = draft.projectId ?? DEFAULT_PROJECT_ID;
      pbody.appendChild(fieldRow('项目', projFieldSel));

      // start time
      const startInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      startInput.type = 'datetime-local';
      startInput.value = toLocalInput(draft.startDate);
      pbody.appendChild(fieldRow('开始', startInput));

      // due time
      const dueInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      dueInput.type = 'datetime-local';
      dueInput.value = toLocalInput(draft.dueDate);
      pbody.appendChild(fieldRow('截止', dueInput));

      // tags
      const tagsInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      tagsInput.value = draft.tags.join(', ');
      tagsInput.placeholder = '逗号分隔';
      pbody.appendChild(fieldRow('标签', tagsInput));

      // description
      const desc = el('textarea', 'wf-task-flow-textarea') as HTMLTextAreaElement;
      desc.value = draft.description;
      desc.placeholder = '描述（Markdown 原文）…';
      pbody.appendChild(desc);

      panel.appendChild(pbody);

      const foot = el('div', 'wf-task-flow-panelfoot');
      const saveBtn = el('button', 'wf-task-flow-btn primary', '保存');
      saveBtn.addEventListener('click', () => {
        void saveFromPanel();
      });
      foot.appendChild(saveBtn);

      if (isNew) {
        const cancel = el('button', 'wf-task-flow-btn', '取消');
        cancel.addEventListener('click', closeDetail);
        foot.appendChild(cancel);
      } else {
        const del = el('button', 'wf-task-flow-btn danger', '删除');
        del.addEventListener('click', () => {
          closeDetail();
          void removeTask(draft.id);
        });
        foot.appendChild(del);

        if (draft.sessionId) {
          const open = el('button', 'wf-task-flow-btn session', '⚡ 打开 Session');
          open.addEventListener('click', () => {
            void ctx.api.openSessionInChat(draft.sessionId!);
          });
          foot.appendChild(open);
        } else {
          const start = el('button', 'wf-task-flow-btn session', '⚡ 启动 Session');
          start.addEventListener('click', () => {
            void startSession(start);
          });
          foot.appendChild(start);
        }
      }
      panel.appendChild(foot);
      root.appendChild(panel);
      titleInput.focus();

      function fieldRow(label: string, control: HTMLElement): HTMLElement {
        const row = el('div', 'wf-task-flow-field');
        row.append(el('label', '', label), control);
        return row;
      }

      function collect(): Task {
        draft.title = titleInput.value.trim() || draft.title || '未命名任务';
        draft.status = statusSel.value as TaskStatus;
        draft.priority = prioSel.value as TaskPriority;
        draft.projectId = projFieldSel.value;
        // datetime-local 值是本地时间 YYYY-MM-DDTHH:mm，存 ISO（UTC）
        draft.startDate = startInput.value ? new Date(startInput.value).toISOString() : undefined;
        draft.dueDate = dueInput.value ? new Date(dueInput.value).toISOString() : undefined;
        draft.tags = tagsInput.value
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        draft.description = desc.value;
        return draft;
      }

      async function saveFromPanel(): Promise<void> {
        collect();
        saveBtn.disabled = true;
        try {
          await persist(draft);
          saveBtn.textContent = '已保存 ✓';
          setTimeout(() => {
            saveBtn.textContent = '保存';
            saveBtn.disabled = false;
          }, 900);
        } catch {
          saveBtn.textContent = '保存失败，重试';
          saveBtn.disabled = false;
        }
      }

      async function startSession(btn: HTMLButtonElement): Promise<void> {
        collect();
        btn.disabled = true;
        btn.textContent = '启动中…';
        try {
          const payload = JSON.stringify({
            task: {
              id: draft.id,
              title: draft.title,
              description: draft.description,
              status: draft.status,
              priority: draft.priority,
              startDate: draft.startDate,
              dueDate: draft.dueDate,
              tags: draft.tags,
            },
            context: '你需要帮我完成这个任务，请基于描述给出执行建议或直接开始。',
          });
          const sessionId = await ctx.api.startTaskSession(payload);
          draft.sessionId = sessionId;
          await persist(draft);
          closeDetail();
          openDetail(draft.id);
        } catch {
          btn.textContent = '启动失败，重试';
          btn.disabled = false;
        }
      }
    }

    /* ---------- render dispatch ---------- */

    function renderContent(): void {
      content.innerHTML = '';
      if (state.tasks.length === 0) {
        const empty = el('div', 'wf-task-flow-empty');
        const msg = el('div');
        msg.append('还没有任务，按 ');
        msg.appendChild(el('kbd', '', 'C'));
        msg.append(' 或点 ＋ 创建');
        empty.appendChild(msg);
        content.appendChild(empty);
        return;
      }
      if (state.view === 'board') renderBoard(content);
      else renderCalendar(content);
    }

    /* ---------- keyboard: C 新建 ---------- */

    const onKey = (e: KeyboardEvent): void => {
      if (!body.isConnected) {
        document.removeEventListener('keydown', onKey);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'c') return;
      if (state.view !== 'board') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (!(target === document.body || body.contains(target))) return;
      e.preventDefault();
      openDetail(null);
    };
    document.addEventListener('keydown', onKey);

    // 其他 widget（如 command-center）可广播刷新
    ctx.bus.on('task:refresh', () => {
      if (body.isConnected) void reload();
    });

    void reload();
  },
});
