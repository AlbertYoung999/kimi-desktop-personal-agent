// 今日待办 —— 桌面悬浮小面板（todo-panel window）
// 数据走 window.kimi.wb.listTasks / saveTask，番茄钟走 window.kimi.pomodoro*。

import type { PomodoroState, Task, TaskPriority } from '../../shared/workbench-types';

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 日程时间轴：06:00–24:00，每小时 40px
const DAY_START_MIN = 6 * 60;
const DAY_END_MIN = 24 * 60;
const HOUR_PX = 40;

type PanelView = 'list' | 'schedule';

let tasks: Task[] = [];
let pomo: PomodoroState = { active: false };
let view: PanelView = localStorage.getItem('todoPanelView') === 'schedule' ? 'schedule' : 'list';
let overdueOpen = localStorage.getItem('todoPanelOverdueOpen') === '1';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && sameDay(d, new Date());
}

function isTodayTs(ms?: number): boolean {
  return typeof ms === 'number' && sameDay(new Date(ms), new Date());
}

// 日期是否早于今天（按本地年月日比较）
function isBeforeToday(iso?: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const n = new Date();
  const a = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const b = n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
  return a < b;
}

function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtHM(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtMD(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function minOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

// 单个任务自身是否满足「今日」条件（未完成 且 到期/排期/进行中/开始于今天）
function meetsToday(t: Task): boolean {
  return (
    t.status !== 'done' &&
    t.status !== 'canceled' &&
    (isToday(t.dueDate) || isToday(t.scheduledStart) || t.status === 'in_progress' || isToday(t.startDate))
  );
}

const byPriorityThenUpdated = (a: Task, b: Task): number =>
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt - a.updatedAt;

// 可见任务：活跃项（自身满足今日条件，或父任务满足）+ 今日已完成项（划线保留）
function visibleTasks(): { active: Task[]; done: Task[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = tasks
    .filter((t) => {
      if (t.status === 'done' || t.status === 'canceled') return false;
      if (meetsToday(t)) return true;
      const parent = t.parentId ? byId.get(t.parentId) : undefined;
      return !!parent && meetsToday(parent);
    })
    .sort(byPriorityThenUpdated);
  const done = tasks
    .filter((t) => t.status === 'done' && isToday(t.completedAt))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return { active, done };
}

// 过期任务：未完成，dueDate 或 scheduledStart 早于今天，且不在今日列表里（避免重复）
function overdueTasks(excludeIds: Set<string>): Task[] {
  return tasks
    .filter((t) => {
      if (t.status === 'done' || t.status === 'canceled') return false;
      if (excludeIds.has(t.id)) return false;
      return isBeforeToday(t.dueDate) || isBeforeToday(t.scheduledStart);
    })
    .sort(byPriorityThenUpdated);
}

function renderHeader(): void {
  // 每次 render 都用 new Date() 重算，跨天由 30s 轮询触发 reload
  const now = new Date();
  $('date').textContent = `${now.getMonth() + 1}/${now.getDate()} ${WEEKDAYS[now.getDay()]}`;
  $('segList').classList.toggle('on', view === 'list');
  $('segSched').classList.toggle('on', view === 'schedule');
}

function fmtCountdown(): string {
  if (!pomo.active || !pomo.startedAt) return '--:--';
  const end = pomo.startedAt + (pomo.durationMin ?? 25) * 60_000;
  const total = Math.max(0, Math.round((end - Date.now()) / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

function renderPomoBar(): void {
  const bar = $('pomoBar');
  bar.classList.toggle('active', pomo.active);
  if (!pomo.active) return;
  $('pomoTask').textContent = `正在专注 ${pomo.taskTitle ?? ''}`;
  $('pomoTime').textContent = fmtCountdown();
}

// ▶ 启动 Session：参照 task-flow.ts 的 launchTaskSession
async function launchTaskSession(t: Task): Promise<void> {
  if (t.sessionId) {
    await window.kimi.wb.openSessionInChat(t.sessionId);
    return;
  }
  // PRD：assign 给 Agent 后任务进入进行中，否则 Agent 不会执行
  const next: Task = { ...t, status: 'in_progress', completedAt: undefined, updatedAt: Date.now() };
  // 子任务：把主任务上下文一并带给 agent
  const parent = t.parentId ? tasks.find((x) => x.id === t.parentId) : undefined;
  const payload = JSON.stringify({
    task: {
      id: next.id,
      title: next.title,
      description: next.description,
      notes: next.notes,
      status: next.status,
      priority: next.priority,
      startDate: next.startDate,
      dueDate: next.dueDate,
      tags: next.tags,
    },
    ...(parent
      ? {
          parent: {
            id: parent.id,
            title: parent.title,
            description: parent.description,
            notes: parent.notes,
            dueDate: parent.dueDate,
          },
        }
      : {}),
    context: '你需要帮我完成这个任务，请基于描述给出执行建议或直接开始。',
  });
  const sessionId = await window.kimi.wb.startTaskSession(payload);
  tasks = await window.kimi.wb.saveTask({ ...next, sessionId });
  render();
}

// orphanParent：父任务存在但不在同组里时传入，用于 ↳ 父任务名 灰字标注
// overdueTag：过期区条目传入（如 "8/29"），标题前加暗橙色过期日期小字
function buildRow(t: Task, sub: boolean, orphanParent?: Task, overdueTag?: string): HTMLElement {
  const done = t.status === 'done';
  const timing = pomo.active && pomo.taskId === t.id;
  const row = document.createElement('div');
  row.className = `task${sub ? ' sub' : ''}${done ? ' done' : ''}${timing ? ' timing' : ''}`;

  const check = document.createElement('button');
  check.className = 'check';
  check.textContent = '✓';
  check.title = done ? '取消完成' : '完成';
  check.addEventListener('click', async () => {
    // 注意：基于 listTasks 拿到的完整对象改字段，避免 saveTask 时丢字段
    const next: Task = done
      ? { ...t, status: 'todo', completedAt: undefined, updatedAt: Date.now() }
      : { ...t, status: 'done', completedAt: new Date().toISOString(), updatedAt: Date.now() };
    tasks = await window.kimi.wb.saveTask(next);
    render();
  });

  const dot = document.createElement('span');
  dot.className = `dot ${t.priority}`;
  dot.title = t.priority;

  const main = document.createElement('div');
  main.className = 'taskMain';
  const title = document.createElement('span');
  title.className = 'taskTitle';
  if (overdueTag) {
    const od = document.createElement('span');
    od.className = 'odDate';
    od.textContent = `${overdueTag} · `;
    title.appendChild(od);
  }
  if (orphanParent) {
    const tag = document.createElement('span');
    tag.className = 'sub';
    tag.textContent = `↳ ${orphanParent.title} · `;
    title.appendChild(tag);
  }
  title.appendChild(document.createTextNode(t.title));
  title.title = orphanParent ? `${orphanParent.title} / ${t.title}` : t.title;
  main.appendChild(title);
  if (t.scheduledStart) {
    const sched = document.createElement('span');
    sched.className = 'taskSched';
    sched.textContent = t.scheduledEnd
      ? `${fmtHM(t.scheduledStart)}–${fmtHM(t.scheduledEnd)}`
      : fmtHM(t.scheduledStart);
    main.appendChild(sched);
  }

  row.append(check, dot, main);
  if (!done) {
    const btns = document.createElement('div');
    btns.className = 'rowBtns';

    const pomoBtn = document.createElement('button');
    pomoBtn.className = 'rowBtn pomo';
    pomoBtn.textContent = '⏰';
    pomoBtn.title = '开始番茄钟';
    pomoBtn.addEventListener('click', () => {
      // 已有其他番茄钟在跑也没关系，主进程会自动落账切换
      void window.kimi.pomodoroStart(t.id);
    });

    const sessionBtn = document.createElement('button');
    sessionBtn.className = 'rowBtn session';
    sessionBtn.textContent = '▶';
    sessionBtn.title = t.sessionId ? '打开 Session' : '启动 Session';
    sessionBtn.addEventListener('click', () => {
      sessionBtn.disabled = true;
      launchTaskSession(t)
        .catch(() => {
          sessionBtn.disabled = false;
        })
        .finally(() => {
          // 成功后行会重渲染；这里兜底恢复
          sessionBtn.disabled = false;
        });
    });

    btns.append(pomoBtn, sessionBtn);
    row.appendChild(btns);
  }
  return row;
}

function renderList(): void {
  const list = $('list');
  const empty = $('empty');
  const { active, done } = visibleTasks();
  const visibleAll = [...active, ...done];
  const visibleIds = new Set(visibleAll.map((t) => t.id));
  const overdue = overdueTasks(visibleIds);
  list.innerHTML = '';

  if (visibleAll.length === 0 && overdue.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  list.style.display = '';
  empty.style.display = 'none';

  const byId = new Map(tasks.map((t) => [t.id, t]));
  // 父任务在列表里 → 子任务嵌套在其下；否则子任务作为顶层行（带 ↳ 父任务名 标注）
  const childrenOf = (pid: string): Task[] => visibleAll.filter((t) => t.parentId === pid).sort(byPriorityThenUpdated);
  const appendWithChildren = (t: Task): void => {
    list.appendChild(buildRow(t, false));
    for (const c of childrenOf(t.id)) list.appendChild(buildRow(c, true));
  };

  // 活跃组在前，今日已完成组划线置底；子任务跟随父任务所在组。
  // 父任务存在但不在列表里的子任务 → 顶层行 + ↳ 父任务名 标注。
  for (const t of active) {
    if (t.parentId && visibleIds.has(t.parentId)) continue; // 作为子行嵌套
    const orphanParent = t.parentId ? byId.get(t.parentId) : undefined;
    if (orphanParent) {
      list.appendChild(buildRow(t, false, orphanParent));
    } else {
      appendWithChildren(t);
    }
  }
  for (const t of done) {
    if (t.parentId && visibleIds.has(t.parentId)) continue;
    const orphanParent = t.parentId ? byId.get(t.parentId) : undefined;
    if (orphanParent) {
      list.appendChild(buildRow(t, false, orphanParent));
    } else {
      appendWithChildren(t);
    }
  }

  // ---- 已过期折叠区 ----
  if (overdue.length > 0) {
    const sec = document.createElement('div');
    sec.className = `odSec${overdueOpen ? ' open' : ''}`;

    const head = document.createElement('button');
    head.className = 'odHead';
    const arrow = document.createElement('span');
    arrow.textContent = overdueOpen ? '▾' : '▸';
    head.appendChild(arrow);
    head.appendChild(document.createTextNode(' 已过期 · '));
    const count = document.createElement('span');
    count.className = 'odCount';
    count.textContent = String(overdue.length);
    head.appendChild(count);

    const body = document.createElement('div');
    body.className = 'odBody';

    const odIds = new Set(overdue.map((t) => t.id));
    const odChildrenOf = (pid: string): Task[] =>
      overdue.filter((t) => t.parentId === pid).sort(byPriorityThenUpdated);
    const odTag = (t: Task): string | undefined => {
      const iso = isBeforeToday(t.dueDate) ? t.dueDate : t.scheduledStart;
      return iso ? fmtMD(iso) : undefined;
    };
    const appendOd = (t: Task): void => {
      body.appendChild(buildRow(t, false, undefined, odTag(t)));
      for (const c of odChildrenOf(t.id)) body.appendChild(buildRow(c, true, undefined, odTag(c)));
    };
    for (const t of overdue) {
      if (t.parentId && odIds.has(t.parentId)) continue; // 父任务也在过期区 → 缩进嵌套
      const orphanParent = t.parentId ? byId.get(t.parentId) : undefined;
      if (orphanParent) {
        body.appendChild(buildRow(t, false, orphanParent, odTag(t)));
      } else {
        appendOd(t);
      }
    }

    head.addEventListener('click', () => {
      overdueOpen = !overdueOpen;
      localStorage.setItem('todoPanelOverdueOpen', overdueOpen ? '1' : '0');
      sec.classList.toggle('open', overdueOpen);
      arrow.textContent = overdueOpen ? '▾' : '▸';
    });

    sec.append(head, body);
    list.appendChild(sec);
  }
}

function topOfMin(min: number): number {
  return ((min - DAY_START_MIN) / 60) * HOUR_PX;
}

function nowTop(): number {
  const n = new Date();
  return topOfMin(n.getHours() * 60 + n.getMinutes());
}

function renderTimeline(): void {
  const tl = $('timeline');
  tl.innerHTML = '';
  const inner = document.createElement('div');
  inner.id = 'tlInner';
  inner.style.height = `${((DAY_END_MIN - DAY_START_MIN) / 60) * HOUR_PX}px`;

  for (let h = DAY_START_MIN / 60; h <= DAY_END_MIN / 60; h++) {
    const line = document.createElement('div');
    line.className = 'tlHour';
    line.style.top = `${(h - DAY_START_MIN / 60) * HOUR_PX}px`;
    const label = document.createElement('span');
    label.className = 'tlHourLabel';
    label.textContent = `${pad2(h)}:00`;
    line.appendChild(label);
    inner.appendChild(line);
  }

  const scheduled = tasks
    .filter((t) => t.status !== 'canceled' && isToday(t.scheduledStart))
    .sort((a, b) => minOfDay(a.scheduledStart!) - minOfDay(b.scheduledStart!));

  for (const t of scheduled) {
    const start = Math.max(DAY_START_MIN, Math.min(DAY_END_MIN - 1, minOfDay(t.scheduledStart!)));
    // 无 scheduledEnd 默认 1 小时
    let end = t.scheduledEnd ? minOfDay(t.scheduledEnd) : start + 60;
    if (end <= start) end = start + 60;
    end = Math.min(DAY_END_MIN, end);

    const block = document.createElement('div');
    block.className = `tlBlock ${t.priority}${t.status === 'done' ? ' done' : ''}`;
    block.style.top = `${topOfMin(start) + 1}px`;
    block.style.height = `${Math.max(16, ((end - start) / 60) * HOUR_PX - 3)}px`;
    block.title = t.title;

    const time = document.createElement('span');
    time.className = 'tlTime';
    time.textContent = t.scheduledEnd ? `${fmtHM(t.scheduledStart!)}–${fmtHM(t.scheduledEnd)}` : fmtHM(t.scheduledStart!);
    const name = document.createElement('span');
    name.className = 'tlTitle';
    name.textContent = t.title;
    block.append(time, name);
    inner.appendChild(block);
  }

  const n = new Date();
  const nowMin = n.getHours() * 60 + n.getMinutes();
  if (nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN) {
    const nowLine = document.createElement('div');
    nowLine.id = 'nowLine';
    nowLine.style.top = `${nowTop()}px`;
    inner.appendChild(nowLine);
  }

  tl.appendChild(inner);
}

function scrollTimelineToNow(): void {
  const tl = $('timeline');
  tl.scrollTop = Math.max(0, nowTop() - 120);
}

async function renderStats(): Promise<void> {
  const doneToday = tasks.filter((t) => isToday(t.completedAt)).length;
  let pomoCount = 0;
  let pomoMinutes = 0;
  try {
    const sessions = await window.kimi.pomodoroList();
    for (const s of sessions) {
      if (isTodayTs(s.startedAt)) {
        pomoCount += 1;
        pomoMinutes += s.minutes;
      }
    }
  } catch {
    // 统计失败不阻塞面板
  }
  $('stats').innerHTML =
    `今日完成 <span class="accent">${doneToday}</span> 项 · ` +
    `番茄 <span class="accent">${pomoCount}</span> 个 / <span class="accent">${pomoMinutes}</span> 分钟`;
}

function render(): void {
  renderHeader();
  renderPomoBar();
  const inList = view === 'list';
  $('timeline').style.display = inList ? 'none' : 'block';
  if (inList) {
    renderList();
  } else {
    $('list').style.display = 'none';
    $('empty').style.display = 'none';
    renderTimeline();
  }
  void renderStats();
}

function setView(v: PanelView): void {
  view = v;
  localStorage.setItem('todoPanelView', v);
  render();
  if (v === 'schedule') scrollTimelineToNow();
}

let lastDayKey = dayKey();

async function reload(): Promise<void> {
  lastDayKey = dayKey();
  tasks = await window.kimi.wb.listTasks();
  render();
}

$('closeBtn').addEventListener('click', () => window.close());
$('pomoStop').addEventListener('click', () => void window.kimi.pomodoroStop(false));
$('pomoDone').addEventListener('click', () => void window.kimi.pomodoroStop(true));
$('segList').addEventListener('click', () => setView('list'));
$('segSched').addEventListener('click', () => setView('schedule'));

// 右下角缩放手柄：frameless 窗口无原生缩放边，走 resizeTodoPanel
{
  const grip = $('grip');
  let rs: { sx: number; sy: number; w: number; h: number } | null = null;
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    rs = { sx: e.screenX, sy: e.screenY, w: window.outerWidth, h: window.outerHeight };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!rs) return;
    // 每次都用「起始尺寸 + 总位移」，不读当前 outerWidth 累加（会漂移）
    window.kimi.resizeTodoPanel(rs.w + (e.screenX - rs.sx), rs.h + (e.screenY - rs.sy));
  });
  window.addEventListener('mouseup', () => {
    rs = null;
  });
}

window.kimi.onTasksChanged(() => void reload());
window.kimi.onPomodoroState((state) => {
  pomo = state;
  render();
});

// 每秒推进番茄倒计时与日程「现在」横线（本地 tick）
setInterval(() => {
  if (pomo.active) $('pomoTime').textContent = fmtCountdown();
  const nowLine = document.getElementById('nowLine');
  if (nowLine) nowLine.style.top = `${nowTop()}px`;
}, 1000);

// 每 30s 检查是否跨天：日期 key 变了就整体 reload（列表/统计/日程全部重算）
setInterval(() => {
  if (dayKey() !== lastDayKey) void reload();
}, 30_000);

void (async () => {
  pomo = await window.kimi.pomodoroState();
  await reload();
  if (view === 'schedule') scrollTimelineToNow();
})();
