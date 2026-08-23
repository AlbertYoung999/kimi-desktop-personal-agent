import { getSettings } from './store.js';
import { getLayout, listLibrary, listProjects, listTasks } from './workbench.js';
import { listRadars } from './radar.js';

/** Compact live system-state digest injected into the main session prompt
 *  (design-v4 §11 被动感知). ~400 tokens, regenerated per prompt. */
export function systemDigest(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const today = now.toISOString().slice(0, 10);
  const lines: string[] = [`[系统状态 ${hh}:${mm}]`];

  // tasks
  const tasks = listTasks();
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const statusText = ['backlog', 'todo', 'in_progress', 'done', 'canceled']
    .filter((s) => counts.get(s))
    .map((s) => `${s} ${counts.get(s)}`)
    .join(' · ');
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate.slice(0, 10) < today && t.status !== 'done' && t.status !== 'canceled');
  const upcoming = tasks
    .filter((t) => t.dueDate && t.status !== 'done' && t.status !== 'canceled')
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))
    .slice(0, 3)
    .map((t) => `「${t.title}」${t.dueDate!.slice(0, 10)}`)
    .join('、');
  if (tasks.length > 0) {
    lines.push(`任务: ${statusText}${overdue.length ? `（逾期 ${overdue.length}：「${overdue[0].title}」）` : ''}`);
    if (upcoming) lines.push(`最近到期: ${upcoming}`);
  }

  // projects
  const projects = listProjects();
  if (projects.length > 0) {
    const dist = projects
      .map((p) => `${p.name}(${tasks.filter((t) => t.projectId === p.id).length})`)
      .join(' · ');
    lines.push(`项目: ${dist}`);
  }

  // radars
  const radars = listRadars();
  if (radars.length > 0) {
    const r = radars
      .map((r) => `${r.name}(未读 ${r.items.filter((i) => !i.read).length}${r.enabled ? '' : '·已暂停'})`)
      .join(' · ');
    lines.push(`雷达: ${r}`);
  }

  // stage + library
  const layout = getLayout();
  const mounted = layout.widgets.filter((w) => !w.minimized).map((w) => w.widgetId);
  if (mounted.length > 0) lines.push(`舞台组件: ${mounted.join(' · ')}`);
  const library = listLibrary();
  if (library.length > 0) {
    lines.push(`组件库: ${library.length} 个（${library.slice(0, 5).map((i) => i.title).join(' / ')}${library.length > 5 ? ' …' : ''}）`);
  }

  lines.push(`主会话: ${getSettings().mainSessionId ?? '未创建'}`);
  return lines.join('\n');
}
