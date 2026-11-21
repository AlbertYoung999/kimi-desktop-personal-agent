/**
 * 左侧导航轨（V4-A Shell + V4-B 组件钉导航）。
 * 默认五项静态写死 + 用户钉的组件（localStorage kimi-nav-pins）。
 * 页面切换 = #hud-body 下 .page 容器的显隐，页面常驻 DOM 不销毁。
 * 钉的组件打开为动态「钉组件页」（pages/pinned.ts 懒挂载），
 * 钉住的导航项 hover 显示 × 可取消钉。
 */

import { bus } from './bus';
import { getWidget } from './registry';
import { mountPinPage, pinPageId, removePinPage, type NavPin } from '../pages/pinned';

export type { NavPin };

export interface NavItem {
  id: string;
  label: string;
  icon: string;
  page: string; // #hud-body 内 .page 容器的 id
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '主页', icon: '⌂', page: 'page-home' },
  { id: 'channel', label: 'CHANNEL', icon: '#', page: 'page-channel' },
  { id: 'dashboard', label: 'DASHBOARD', icon: '▦', page: 'page-dashboard' },
  { id: 'zen', label: 'ZEN', icon: '◉', page: 'page-zen' },
  { id: 'plugins', label: 'PLUGINS', icon: '⬡', page: 'page-plugins' },
  { id: 'agents', label: 'AGENTS', icon: '✎', page: 'page-agents' },
];

export type PageChangeHandler = (item: NavItem) => void;

// ---------- 钉导航（localStorage kimi-nav-pins） ----------

const PINS_KEY = 'kimi-nav-pins';

function loadPins(): NavPin[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is NavPin =>
        !!p && typeof (p as NavPin).id === 'string' && typeof (p as NavPin).title === 'string',
    );
  } catch {
    return [];
  }
}

let pins: NavPin[] = loadPins();
let storedHandler: PageChangeHandler | undefined;

function savePins(): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

function emitPinsChanged(): void {
  bus.emit('nav:pins-changed');
}

export function getPins(): readonly NavPin[] {
  return pins;
}

export function isPinned(pinId: string): boolean {
  return pins.some((p) => p.id === pinId);
}

/** 钉 / 取消钉；返回操作后是否处于钉住状态。 */
export function togglePin(pin: NavPin): boolean {
  if (isPinned(pin.id)) {
    unpin(pin.id);
    return false;
  }
  pins.push(pin);
  savePins();
  renderRail();
  emitPinsChanged();
  return true;
}

export function unpin(pinId: string): void {
  if (!isPinned(pinId)) return;
  const pageId = pinPageId(pinId);
  const wasActive = document.getElementById(pageId)?.classList.contains('active') ?? false;
  pins = pins.filter((p) => p.id !== pinId);
  savePins();
  removePinPage(pinId);
  renderRail();
  emitPinsChanged();
  if (wasActive) activatePage('page-home');
}

/** 组件改名后同步钉项标题（plugins 页重命名时调用）。 */
export function renamePin(pinId: string, title: string): void {
  const pin = pins.find((p) => p.id === pinId);
  if (!pin) return;
  pin.title = title;
  savePins();
  renderRail();
  const pageTitle = document.querySelector(`#${pinPageId(pinId)} .widget-title`);
  if (pageTitle) pageTitle.textContent = `◈ ${title}`;
}

function pinNavItem(pin: NavPin): NavItem {
  const icon = pin.widgetId && pin.widgetId !== 'artifact' ? getWidget(pin.widgetId)?.def.icon ?? '◈' : '◈';
  return { id: `pin-${pin.id}`, label: pin.title, icon, page: pinPageId(pin.id) };
}

// ---------- 页面切换 ----------

/** 当前激活页 id（默认取 index.html 里预置 .active 的页）。 */
export function activePageId(): string {
  return document.querySelector('#hud-body > .page.active')?.id ?? '';
}

function ensurePinPage(pin: NavPin): void {
  if (document.getElementById(pinPageId(pin.id))) return;
  const page = mountPinPage(pin, { onClose: () => unpin(pin.id) });
  document.getElementById('hud-body')!.appendChild(page);
}

export function activatePage(pageId: string, onPageChange?: PageChangeHandler): void {
  let item = NAV_ITEMS.find((i) => i.page === pageId);
  if (!item) {
    const pin = pins.find((p) => pinPageId(p.id) === pageId);
    if (!pin) return;
    ensurePinPage(pin); // 钉组件页懒挂载
    item = pinNavItem(pin);
  }
  document
    .querySelectorAll<HTMLElement>('#nav-rail .nav-item')
    .forEach((el) => el.classList.toggle('active', el.dataset.page === item.page));
  document
    .querySelectorAll('#hud-body > .page')
    .forEach((el) => el.classList.toggle('active', el.id === item.page));
  (onPageChange ?? storedHandler)?.(item);
}

// ---------- 渲染 ----------

function makeNavButton(item: NavItem): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'nav-item';
  btn.dataset.page = item.page;
  btn.title = item.label;
  const icon = document.createElement('span');
  icon.className = 'nav-icon';
  icon.textContent = item.icon;
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = item.label;
  btn.append(icon, label);
  btn.onclick = () => activatePage(item.page);
  return btn;
}

function renderRail(): void {
  const rail = document.getElementById('nav-rail');
  if (!rail) return;
  rail.innerHTML = '';

  const items = document.createElement('div');
  items.className = 'nav-items';
  for (const item of NAV_ITEMS) items.appendChild(makeNavButton(item));

  if (pins.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'nav-sep';
    items.appendChild(sep);
    for (const pin of pins) {
      const item = pinNavItem(pin);
      const btn = makeNavButton(item);
      btn.classList.add('pin');
      const x = document.createElement('span');
      x.className = 'nav-unpin';
      x.textContent = '×';
      x.title = '取消钉';
      x.onclick = (ev) => {
        ev.stopPropagation();
        unpin(pin.id);
      };
      btn.appendChild(x);
      items.appendChild(btn);
    }
  }

  // 底部系统状态点
  const status = document.createElement('div');
  status.className = 'nav-status';
  status.title = 'SYS ONLINE';

  rail.append(items, status);

  // 重渲染后恢复当前激活高亮
  const current = activePageId();
  if (current) activatePage(current);
}

export function initNav(onPageChange?: PageChangeHandler): void {
  storedHandler = onPageChange;
  renderRail();
  // 初始高亮与 index.html 中预激活的页保持一致
  activatePage(activePageId() || NAV_ITEMS[0].page);
}
