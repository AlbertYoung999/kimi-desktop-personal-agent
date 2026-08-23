/**
 * Plugins 市场页（V4-B，design-v4 §4）：
 * - 市场区：内置 widget（core/registry.allWidgets()，标注「内置」）+ 官方预设 artifact
 *   （pages/presets.ts，标注「预设」）+「与 AI 创建」入口（跳 Dashboard 挂 widget-forge）
 * - 我的组件区：wb.libraryList() 的用户组件（标注「我的」），支持重命名 / 删除
 * - 卡片操作：添加到 Dashboard（上画布）、钉到导航轨（core/nav.ts togglePin）
 */

import { allWidgets } from '../core/registry';
import { addWidget } from '../core/layout';
import { activatePage, isPinned, renamePin, togglePin, unpin, type NavPin } from '../core/nav';
import { bus } from '../core/bus';
import { PRESETS } from './presets';

export function initPluginsPage(): void {
  const page = document.getElementById('page-plugins')!;
  page.innerHTML = '';

  // ---------- 页头 ----------
  const head = document.createElement('div');
  head.className = 'pl-head';
  const title = document.createElement('div');
  title.className = 'pl-title';
  title.textContent = 'PLUGINS';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const forgeBtn = document.createElement('button');
  forgeBtn.className = 'pl-btn pl-forge';
  forgeBtn.textContent = '✦ 与 AI 创建';
  forgeBtn.title = '打开 Widget Forge，用对话生成新组件';
  forgeBtn.onclick = () => {
    activatePage('page-dashboard');
    addWidget('widget-forge');
  };
  head.append(title, spacer, forgeBtn);

  // ---------- 区块容器 ----------
  const marketGrid = document.createElement('div');
  marketGrid.className = 'pl-grid';
  const mineGrid = document.createElement('div');
  mineGrid.className = 'pl-grid';

  page.append(
    head,
    makeSection('// 市场', marketGrid),
    makeSection('// 我的组件', mineGrid),
  );

  function makeSection(label: string, grid: HTMLElement): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'pl-section';
    const st = document.createElement('div');
    st.className = 'section-title';
    st.textContent = label;
    sec.append(st, grid);
    return sec;
  }

  // ---------- 卡片 ----------

  interface CardSpec {
    icon: string;
    title: string;
    desc: string;
    badge: string;
    onAdd: () => void;
    pin: () => NavPin; // 惰性取（标题可能已改名）
  }

  function pinButton(getPin: () => NavPin): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'pl-btn pl-pin';
    b.dataset.pinId = getPin().id;
    b.title = '钉到左侧导航轨';
    b.onclick = () => {
      togglePin(getPin());
      syncPinButtons();
    };
    return b;
  }

  function syncPinButtons(): void {
    page.querySelectorAll<HTMLButtonElement>('.pl-pin').forEach((b) => {
      const pinned = isPinned(b.dataset.pinId ?? '');
      b.textContent = pinned ? '已钉 ✓' : '钉到导航';
      b.classList.toggle('on', pinned);
    });
  }

  function makeCard(spec: CardSpec, extraOps: HTMLElement[] = []): HTMLElement {
    const card = document.createElement('div');
    card.className = 'pl-card';

    const top = document.createElement('div');
    top.className = 'pl-card-top';
    const icon = document.createElement('span');
    icon.className = 'pl-card-icon';
    icon.textContent = spec.icon;
    const name = document.createElement('span');
    name.className = 'pl-card-title';
    name.textContent = spec.title;
    const badge = document.createElement('span');
    badge.className = 'pl-badge';
    badge.textContent = spec.badge;
    top.append(icon, name, badge);

    const desc = document.createElement('div');
    desc.className = 'pl-card-desc';
    desc.textContent = spec.desc;

    const ops = document.createElement('div');
    ops.className = 'pl-card-ops';
    const addBtn = document.createElement('button');
    addBtn.className = 'pl-btn';
    addBtn.textContent = '添加到 Dashboard';
    addBtn.onclick = () => {
      spec.onAdd();
      activatePage('page-dashboard');
    };
    ops.append(addBtn, pinButton(spec.pin), ...extraOps);

    card.append(top, desc, ops);
    return card;
  }

  // ---------- 市场区：内置 widget + 预设 artifact ----------

  for (const w of allWidgets()) {
    if (w.def.id === 'artifact') continue; // artifact 是宿主组件，由预设/我的组件承载
    marketGrid.appendChild(
      makeCard({
        icon: w.def.icon,
        title: w.def.name,
        desc: w.def.description,
        badge: '内置',
        onAdd: () => addWidget(w.def.id),
        pin: () => ({ id: `builtin-${w.def.id}`, title: w.def.name, widgetId: w.def.id }),
      }),
    );
  }

  for (const p of PRESETS) {
    marketGrid.appendChild(
      makeCard({
        icon: '◈',
        title: p.title,
        desc: p.description,
        badge: '预设',
        onAdd: () => addWidget('artifact', { title: p.title, html: p.html }),
        pin: () => ({ id: p.id, title: p.title, widgetId: 'artifact', html: p.html }),
      }),
    );
  }

  // ---------- 我的组件区 ----------

  async function refreshMine(): Promise<void> {
    let items: Awaited<ReturnType<typeof window.kimi.wb.libraryList>>;
    try {
      items = await window.kimi.wb.libraryList();
    } catch {
      items = [];
    }
    mineGrid.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pl-empty';
      empty.textContent = '暂无组件 · 用「与 AI 创建」生成第一个';
      mineGrid.appendChild(empty);
      return;
    }
    for (const item of items) {
      // 闭包内共享可变的当前标题（重命名后 pin/add 用新标题）
      const cur = { title: item.title };
      const pinId = `lib-${item.id}`;

      const renameBtn = document.createElement('button');
      renameBtn.className = 'pl-btn';
      renameBtn.textContent = '重命名';
      renameBtn.onclick = () => {
        const card = renameBtn.closest('.pl-card')!;
        const nameEl = card.querySelector<HTMLElement>('.pl-card-title')!;
        const input = document.createElement('input');
        input.className = 'pl-rename-input';
        input.value = cur.title;
        const commit = () => {
          const v = input.value.trim();
          if (v && v !== cur.title) {
            cur.title = v;
            nameEl.textContent = v;
            renamePin(pinId, v);
            // libraryAdd 按 id 覆盖写 = 重命名（无独立 rename API）
            void window.kimi.wb.libraryAdd({ ...item, title: v }).catch(() => undefined);
          } else {
            nameEl.textContent = cur.title;
          }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
          if (e.key === 'Escape') {
            input.value = cur.title;
            input.blur();
          }
        });
        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'pl-btn pl-danger';
      delBtn.textContent = '删除';
      delBtn.onclick = () => {
        if (!window.confirm(`删除组件「${cur.title}」？`)) return;
        if (isPinned(pinId)) unpin(pinId);
        void window.kimi.wb.libraryDelete(item.id).then(() => refreshMine());
      };

      mineGrid.appendChild(
        makeCard(
          {
            icon: '◈',
            title: cur.title,
            desc: `组件库 · ${new Date(item.createdAt).toLocaleDateString('zh-CN')}`,
            badge: '我的',
            onAdd: () =>
              addWidget('artifact', { libraryId: item.id, title: cur.title, html: item.html }),
            pin: () => ({ id: pinId, title: cur.title, libraryId: item.id }),
          },
          [renameBtn, delBtn],
        ),
      );
    }
    syncPinButtons();
  }

  void refreshMine();
  syncPinButtons();
  // 导航轨上取消钉时同步卡片按钮状态
  bus.on('nav:pins-changed', syncPinButtons);
}
