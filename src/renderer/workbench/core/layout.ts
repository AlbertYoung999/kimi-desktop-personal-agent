import type { WidgetInstance, WorkbenchLayout } from '../../../shared/workbench-types';
import { bus } from './bus';
import { allWidgets, getWidget, type WidgetContext } from './registry';

const SNAP = 8;
let layout: WorkbenchLayout = { widgets: [] };
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const stage = () => document.getElementById('stage')!;
const canvas = () => document.getElementById('stage-canvas')!;
const dockItems = () => document.getElementById('dock-items')!;

// extra breathing room beyond the furthest widget edge
const CANVAS_MARGIN = 100;

// grow the scrollable content layer to fit all visible widgets
function updateCanvasSize(): void {
  let maxX = 0;
  let maxY = 0;
  for (const inst of layout.widgets) {
    if (inst.minimized) continue;
    maxX = Math.max(maxX, inst.x + inst.w);
    maxY = Math.max(maxY, inst.y + inst.h);
  }
  const c = canvas();
  c.style.minWidth = `${Math.max(stage().clientWidth, maxX + CANVAS_MARGIN)}px`;
  c.style.minHeight = `${Math.max(stage().clientHeight, maxY + CANVAS_MARGIN)}px`;
}

// maximized widgets pin to the viewport; lock stage scrolling while one is up
function syncStageScroll(): void {
  stage().classList.toggle('no-scroll', !!stage().querySelector('.widget.maximized'));
}

function updateDockStatus(): void {
  const el = document.getElementById('dock-status');
  if (el) el.textContent = `WIDGETS: ${layout.widgets.length}`;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void window.kimi.wb.saveLayout(layout), 400);
}

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

export async function initLayout(): Promise<void> {
  layout = await window.kimi.wb.getLayout();
  for (const inst of layout.widgets) {
    if (inst.minimized) renderDockItem(inst);
    else renderWidget(inst);
  }
  document.getElementById('dock-add')!.onclick = openAddMenu;
  updateCanvasSize();
  updateDockStatus();
  // artifact renames propagate to the widget frame title
  bus.on('widget:renamed', (payload) => {
    const { instanceId, title } = payload as { instanceId: string; title: string };
    const el = stage().querySelector(`[data-instance-id="${instanceId}"] .widget-title`);
    if (el) {
      const inst = layout.widgets.find((i) => i.instanceId === instanceId);
      const w = inst ? getWidget(inst.widgetId) : undefined;
      el.textContent = `${w?.def.icon ?? ''} ${title}`;
    }
  });
}

// ---------- render ----------

function renderWidget(inst: WidgetInstance): void {
  const w = getWidget(inst.widgetId);
  if (!w) return;
  const el = document.createElement('section');
  el.className = 'widget';
  el.dataset.instanceId = inst.instanceId;
  el.style.left = `${inst.x}px`;
  el.style.top = `${inst.y}px`;
  el.style.width = `${inst.w}px`;
  el.style.height = `${inst.h}px`;

  const header = document.createElement('div');
  header.className = 'widget-header';
  const title = document.createElement('span');
  title.className = 'widget-title';
  const customTitle = typeof inst.config.title === 'string' ? inst.config.title : null;
  title.textContent = customTitle ? `${w.def.icon} ${customTitle}` : `${w.def.icon} ${w.def.name}`;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const minBtn = document.createElement('button');
  minBtn.className = 'widget-op';
  minBtn.textContent = '–';
  minBtn.title = '休眠到 Dock';
  minBtn.onclick = () => minimizeWidget(inst.instanceId);
  const maxBtn = document.createElement('button');
  maxBtn.className = 'widget-op';
  maxBtn.textContent = '⤢';
  maxBtn.title = '放大 / 还原（双击标题栏同效）';
  maxBtn.onclick = () => toggleMaximize(el, inst);
  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-op';
  closeBtn.textContent = '×';
  closeBtn.title = '移除';
  closeBtn.onclick = () => removeWidget(inst.instanceId);
  header.append(title, spacer, minBtn, maxBtn, closeBtn);

  header.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.widget-op')) return;
    toggleMaximize(el, inst);
  });

  const body = document.createElement('div');
  body.className = 'widget-body';

  const resize = document.createElement('div');
  resize.className = 'widget-resize';

  // L-shaped tech corner brackets
  const corners = document.createElement('span');
  corners.innerHTML = '<i class="wc tl"></i><i class="wc tr"></i><i class="wc bl"></i><i class="wc br"></i>';

  el.append(header, body, resize, corners);
  canvas().appendChild(el);

  const ctx: WidgetContext = {
    instanceId: inst.instanceId,
    config: inst.config,
    setConfig(patch) {
      Object.assign(inst.config, patch);
      scheduleSave();
    },
    bus,
    api: window.kimi.wb,
    requestMinimize: () => minimizeWidget(inst.instanceId),
    requestClose: () => removeWidget(inst.instanceId),
  };
  try {
    w.mount(body, ctx);
  } catch (err) {
    // error boundary: a crashing (e.g. agent-modified) widget must not take the stage down
    body.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText =
      'font-family:var(--mono);font-size:11px;color:var(--error);padding:12px;border:1px dashed var(--error);border-radius:8px;';
    box.textContent = `⚠ 组件挂载失败：${String(err).slice(0, 120)}`;
    const retry = document.createElement('button');
    retry.textContent = '重试挂载';
    retry.style.cssText =
      'margin-top:8px;display:block;font-family:var(--mono);font-size:11px;background:none;border:1px solid var(--border-strong);color:var(--neon);border-radius:6px;padding:4px 10px;cursor:pointer;';
    retry.onclick = () => {
      body.innerHTML = '';
      try {
        w.mount(body, ctx);
      } catch {
        /* stays on error card */
      }
    };
    box.appendChild(retry);
    body.appendChild(box);
    console.error(`[workbench] widget ${inst.widgetId} mount failed:`, err);
  }

  enableDrag(el, header, inst);
  enableResize(el, resize, inst, w.def.minSize);
}

function renderDockItem(inst: WidgetInstance): void {
  const w = getWidget(inst.widgetId);
  if (!w) return;
  const item = document.createElement('button');
  item.className = 'dock-item';
  item.dataset.instanceId = inst.instanceId;
  item.textContent = `${w.def.icon} ${w.def.name}`;
  item.title = '点击恢复';
  item.onclick = () => restoreWidget(inst.instanceId);
  dockItems().appendChild(item);
}

// ---------- drag / resize ----------

function enableDrag(el: HTMLElement, handle: HTMLElement, inst: WidgetInstance): void {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.widget-op')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    // pointer position in canvas coordinates (viewport coords + stage scroll offset)
    const rect0 = stage().getBoundingClientRect();
    const grabX = e.clientX - rect0.left + stage().scrollLeft - inst.x;
    const grabY = e.clientY - rect0.top + stage().scrollTop - inst.y;
    const onMove = (ev: PointerEvent) => {
      const rect = stage().getBoundingClientRect();
      const maxX = canvas().clientWidth - 80;
      const maxY = canvas().clientHeight - 40;
      inst.x = Math.max(0, Math.min(snap(ev.clientX - rect.left + stage().scrollLeft - grabX), maxX));
      inst.y = Math.max(0, Math.min(snap(ev.clientY - rect.top + stage().scrollTop - grabY), maxY));
      el.style.left = `${inst.x}px`;
      el.style.top = `${inst.y}px`;
      updateCanvasSize();
    };
    const onUp = () => {
      el.classList.remove('dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      updateCanvasSize();
      scheduleSave();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function enableResize(el: HTMLElement, handle: HTMLElement, inst: WidgetInstance, min: { w: number; h: number }): void {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = inst.w;
    const startH = inst.h;
    const onMove = (ev: PointerEvent) => {
      inst.w = Math.max(min.w * 40, snap(startW + ev.clientX - startX));
      inst.h = Math.max(min.h * 40, snap(startH + ev.clientY - startY));
      el.style.width = `${inst.w}px`;
      el.style.height = `${inst.h}px`;
      updateCanvasSize();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      updateCanvasSize();
      scheduleSave();
      bus.emit('widget:resized', { instanceId: inst.instanceId });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ---------- lifecycle ----------

function toggleMaximize(el: HTMLElement, inst: WidgetInstance): void {
  const maximized = el.classList.toggle('maximized');
  if (!maximized) {
    // restore persisted geometry
    el.style.left = `${inst.x}px`;
    el.style.top = `${inst.y}px`;
    el.style.width = `${inst.w}px`;
    el.style.height = `${inst.h}px`;
  }
  syncStageScroll();
  bus.emit('widget:resized', { instanceId: inst.instanceId });
}

/** Maximize a mounted widget (no-op if already maximized or minimized). */
export function maximizeWidgetById(instanceId: string): void {
  const inst = layout.widgets.find((i) => i.instanceId === instanceId);
  const el = stage().querySelector<HTMLElement>(`.widget[data-instance-id="${instanceId}"]`);
  if (inst && el && !el.classList.contains('maximized')) toggleMaximize(el, inst);
}

/** Pop an artifact onto the stage and enlarge it so the user sees the change.
 *  Reuses the mounted instance when present (restore + maximize). */
export function popArtifact(item: { id: string; title: string; html: string }): void {
  const inst = layout.widgets.find(
    (i) => i.widgetId === 'artifact' && (i.config.libraryId === item.id || i.config.title === item.title),
  );
  if (inst) {
    if (inst.minimized) restoreWidget(inst.instanceId);
    maximizeWidgetById(inst.instanceId);
    return;
  }
  addWidget('artifact', { libraryId: item.id, title: item.title, html: item.html });
  const created = layout.widgets[layout.widgets.length - 1];
  if (created?.widgetId === 'artifact') maximizeWidgetById(created.instanceId);
}

export function addWidget(widgetId: string, initConfig?: Record<string, unknown>): void {
  const w = getWidget(widgetId);
  if (!w) return;
  const count = layout.widgets.length;
  const inst: WidgetInstance = {
    instanceId: `${widgetId}-${Date.now().toString(36)}`,
    widgetId,
    x: snap(24 + (count % 5) * 32),
    y: snap(24 + (count % 5) * 32),
    w: w.def.defaultSize.w * 40,
    h: w.def.defaultSize.h * 40,
    minimized: false,
    config: initConfig ?? {},
  };
  layout.widgets.push(inst);
  renderWidget(inst);
  updateCanvasSize();
  updateDockStatus();
  scheduleSave();
}

export function minimizeWidget(instanceId: string): void {
  const inst = layout.widgets.find((i) => i.instanceId === instanceId);
  if (!inst) return;
  inst.minimized = true;
  stage().querySelector(`[data-instance-id="${instanceId}"]`)?.remove();
  renderDockItem(inst);
  updateCanvasSize();
  syncStageScroll();
  scheduleSave();
}

export function restoreWidget(instanceId: string): void {
  const inst = layout.widgets.find((i) => i.instanceId === instanceId);
  if (!inst) return;
  inst.minimized = false;
  dockItems().querySelector(`[data-instance-id="${instanceId}"]`)?.remove();
  renderWidget(inst);
  updateCanvasSize();
  scheduleSave();
}

export function removeWidget(instanceId: string): void {
  layout.widgets = layout.widgets.filter((i) => i.instanceId !== instanceId);
  stage().querySelector(`[data-instance-id="${instanceId}"]`)?.remove();
  dockItems().querySelector(`[data-instance-id="${instanceId}"]`)?.remove();
  updateCanvasSize();
  syncStageScroll();
  updateDockStatus();
  scheduleSave();
}

// ---------- add menu ----------

let addMenu: HTMLElement | null = null;

function openAddMenu(): void {
  closeAddMenu();
  addMenu = document.createElement('div');
  addMenu.id = 'add-menu';
  for (const w of allWidgets()) {
    const btn = document.createElement('button');
    btn.innerHTML = `<div>${w.def.icon} ${w.def.name}</div><div class="menu-desc"></div>`;
    (btn.querySelector('.menu-desc') as HTMLElement).textContent = w.def.description;
    btn.onclick = () => {
      addWidget(w.def.id);
      closeAddMenu();
    };
    addMenu.appendChild(btn);
  }
  document.body.appendChild(addMenu);
  const anchor = document.getElementById('dock-add')!.getBoundingClientRect();
  addMenu.style.left = `${anchor.left}px`;
  addMenu.style.bottom = `${window.innerHeight - anchor.top + 8}px`;
}

function closeAddMenu(): void {
  addMenu?.remove();
  addMenu = null;
}

document.addEventListener('click', (e) => {
  if (addMenu && !addMenu.contains(e.target as Node) && (e.target as HTMLElement).id !== 'dock-add') {
    closeAddMenu();
  }
});
