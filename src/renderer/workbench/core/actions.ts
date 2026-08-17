import type { WbActionCall } from '../../api';
import { bus } from './bus';
import { addWidget, minimizeWidget, popArtifact, restoreWidget } from './layout';
import { allWidgets } from './registry';

/**
 * Executes tool calls forwarded from the workbench MCP server (design-evolve.md E1).
 * Data-mutating tools (task_create / radar_create / search_launch) run in the main
 * process; this module handles the ones that need live renderer state.
 */

const ALIASES: Record<string, string[]> = {
  'deep-focus': ['番茄钟', '专注', 'focus', 'deepfocus'],
  'task-flow': ['任务', '看板', 'task', 'taskflow', 'kanban'],
  search: ['搜索', 'search'],
  agents: ['agents', 'agent'],
  'widget-forge': ['forge', '工坊', 'widgetforge'],
  'info-radar': ['radar', '雷达', 'inforadar', 'info-radar'],
};

function resolveWidgetId(name: string): string | null {
  const q = name.trim().toLowerCase();
  for (const w of allWidgets()) {
    if (w.def.id.toLowerCase() === q || w.def.name.toLowerCase() === q) return w.def.id;
  }
  for (const [id, aliases] of Object.entries(ALIASES)) {
    if (aliases.some((a) => q.includes(a))) return id;
  }
  for (const w of allWidgets()) {
    if (q.includes(w.def.id.toLowerCase()) || q.includes(w.def.name.toLowerCase())) return w.def.id;
  }
  return null;
}

async function execute(call: WbActionCall): Promise<string> {
  const { action, params } = call;
  if (action === 'widget_open') {
    const id = resolveWidgetId(String(params.widget ?? ''));
    if (!id) return `✗ 找不到 widget「${params.widget}」`;
    addWidget(id);
    bus.emit('widget:add', { widgetId: id });
    return `已打开 widget「${id}」`;
  }
  if (action === 'widget_close') {
    const id = resolveWidgetId(String(params.widget ?? ''));
    const layout = await window.kimi.wb.getLayout();
    const inst = layout.widgets.find((i) => !i.minimized && (i.widgetId === id || i.instanceId === params.widget));
    if (!inst) return `✗ 舞台上没有正在显示的「${params.widget}」`;
    minimizeWidget(inst.instanceId);
    return `已休眠 widget「${inst.widgetId}」到 Dock`;
  }
  if (action === 'focus_start') {
    addWidget('deep-focus', { lastTask: String(params.task ?? ''), lastMode: String(params.mode ?? 'sprint') });
    return `已打开番茄钟并预填「${params.task}」（${params.mode ?? 'sprint'}），点击开始即计时`;
  }
  return `✗ 未知 action: ${action}`;
}

export function initActions(): void {
  window.kimi.onWbAction((call) => {
    void execute(call).then((message) => {
      void window.kimi.wbActionResult({ requestId: call.requestId, message });
    });
  });
  window.kimi.onWbRefresh(({ kind }) => {
    bus.emit(kind === 'tasks' ? 'task:refresh' : 'radar:refresh');
  });
  // artifact_modify runs 1-2 min in main; on completion pop the updated
  // artifact onto the stage (reuse the mounted instance, maximized).
  window.kimi.onArtifactProgress((p) => {
    if (p.state === 'done' && p.item) popArtifact(p.item);
  });
}

export { restoreWidget };
