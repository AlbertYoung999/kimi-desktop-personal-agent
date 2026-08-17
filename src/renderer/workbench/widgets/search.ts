import { registerWidget } from '../core/registry';
import type { SearchEngine } from '../../../shared/workbench-types';
import type { WidgetContext } from '../core/registry';

const GROUP_LABELS: Record<string, string> = {
  general: '通用',
  code: '代码',
  academic: '学术',
  image: '图片',
  通用: '通用',
  代码: '代码',
  学术: '学术',
  图片: '图片',
};
const GROUP_ORDER = ['通用', '代码', '学术', '图片'];
const HISTORY_MAX = 10;

function groupLabel(group: string): string {
  return GROUP_LABELS[group] || group || '其他';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
.wf-search { display: flex; flex-direction: column; gap: 10px; min-height: 100%; }
.wf-search-input-wrap { position: relative; flex-shrink: 0; }
.wf-search-input {
  width: 100%;
  border: 1px solid var(--border-strong);
  background: rgba(0, 240, 255, 0.04);
  color: var(--fg);
  font: inherit;
  font-size: 17px;
  padding: 12px 16px 12px 40px;
  border-radius: 12px;
  outline: none;
  transition: box-shadow 200ms var(--ease-in), border-color 200ms var(--ease-in);
}
.wf-search-input:focus { border-color: var(--neon); box-shadow: 0 0 18px rgba(0, 240, 255, 0.18); }
.wf-search-input::placeholder { color: var(--disabled); }
.wf-search-icon {
  position: absolute; left: 13px; top: 50%; transform: translateY(-50%);
  color: var(--neon); font-size: 15px; pointer-events: none;
  text-shadow: 0 0 8px rgba(0, 240, 255, 0.6);
}
.wf-search-chips {
  flex-shrink: 0;
  display: flex; flex-wrap: nowrap; gap: 6px;
  overflow-x: auto; white-space: nowrap;
  padding-bottom: 2px;
  scrollbar-width: none;
}
.wf-search-chips::-webkit-scrollbar { display: none; }
.wf-search-chip {
  flex-shrink: 0;
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--disabled);
  font: inherit; font-size: 12px;
  padding: 4px 11px; border-radius: 999px;
  cursor: pointer;
  transition: all 160ms var(--ease-in);
}
.wf-search-chip-grp {
  font-family: var(--mono); font-size: 8px; letter-spacing: 1px;
  color: var(--disabled); line-height: 1; text-transform: uppercase;
}
.wf-search-chip:hover { color: var(--fg); border-color: var(--border-strong); }
.wf-search-chip.on {
  color: var(--neon);
  border-color: var(--border-strong);
  background: rgba(0, 240, 255, 0.08);
  text-shadow: 0 0 8px rgba(0, 240, 255, 0.5);
}
.wf-search-chip.on .wf-search-chip-grp { color: rgba(0, 240, 255, 0.55); }
.wf-search-launch {
  flex-shrink: 0;
  font-family: var(--mono); font-size: 11px; color: var(--green);
  min-height: 16px; text-align: center;
  opacity: 0; transition: opacity 200ms;
}
.wf-search-launch.show { opacity: 1; animation: wfSearchPulse 500ms var(--ease-in); }
@keyframes wfSearchPulse { 0% { transform: scale(0.92); text-shadow: 0 0 16px rgba(0, 255, 136, 0.8); } 100% { transform: scale(1); } }
.wf-search-history { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wf-search-history-label { font-size: 11px; color: var(--disabled); margin-right: 2px; }
.wf-search-hist {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent; color: var(--muted);
  font: inherit; font-size: 11.5px;
  padding: 3px 10px; border-radius: 999px; cursor: pointer;
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: all 160ms var(--ease-in);
}
.wf-search-hist:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-search-manage { flex-shrink: 0; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 8px; margin-top: auto; }
.wf-search-manage-toggle {
  border: none; background: none; color: var(--muted);
  font: inherit; font-size: 11.5px; cursor: pointer; padding: 2px 0;
}
.wf-search-manage-toggle:hover { color: var(--neon); }
.wf-search-engine {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 6px; border-radius: 6px; font-size: 12px;
}
.wf-search-engine:hover { background: var(--card-hover); }
.wf-search-engine-name { color: var(--fg); }
.wf-search-engine-group { font-family: var(--mono); font-size: 10px; color: var(--disabled); }
.wf-search-engine-off .wf-search-engine-name { color: var(--disabled); text-decoration: line-through; }
.wf-search-engine-op {
  border: none; background: none; color: var(--disabled);
  font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
}
.wf-search-engine-op:hover { color: var(--neon); background: rgba(255, 255, 255, 0.08); }
.wf-search-engine-op.danger:hover { color: var(--error); }
.wf-search-form {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px; margin-top: 6px;
}
.wf-search-form input {
  border: 1px solid var(--border); background: transparent; color: var(--fg);
  font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; outline: none;
}
.wf-search-form input:focus { border-color: var(--border-strong); }
.wf-search-form-row { display: flex; gap: 6px; }
.wf-search-form-row input { flex: 1; min-width: 0; }
.wf-search-form-btns { display: flex; gap: 6px; justify-content: flex-end; }
.wf-search-btn {
  border: 1px solid var(--border-strong); background: rgba(0, 240, 255, 0.08);
  color: var(--neon); font: inherit; font-size: 11.5px;
  padding: 4px 12px; border-radius: 6px; cursor: pointer;
}
.wf-search-btn.ghost { border-color: var(--border); background: transparent; color: var(--muted); }
.wf-search-btn:hover { box-shadow: 0 0 10px rgba(0, 240, 255, 0.2); }
.wf-search-add {
  border: 1px dashed var(--border-strong); background: transparent; color: var(--neon);
  font: inherit; font-size: 11.5px; padding: 4px 12px; border-radius: 6px;
  cursor: pointer; margin-top: 6px; width: 100%;
}
.wf-search-add:hover { box-shadow: 0 0 10px rgba(0, 240, 255, 0.2); }

/* ---- results mode ---- */
.wf-search-results { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.wf-search-tabs {
  flex-shrink: 0;
  display: flex; align-items: flex-end; gap: 2px;
  overflow-x: auto; white-space: nowrap;
  border-bottom: 1px solid var(--border);
  scrollbar-width: none;
}
.wf-search-tabs::-webkit-scrollbar { display: none; }
.wf-search-tab {
  border: none; background: none;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.5px;
  color: var(--muted);
  padding: 5px 10px 6px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 160ms var(--ease-in), border-color 160ms var(--ease-in);
}
.wf-search-tab:hover { color: var(--fg); }
.wf-search-tab.on {
  color: var(--neon);
  border-bottom-color: var(--neon);
  text-shadow: 0 0 8px rgba(0, 240, 255, 0.6);
}
.wf-search-tab-grp { font-size: 8px; color: var(--disabled); margin-left: 4px; }
.wf-search-tab.on .wf-search-tab-grp { color: rgba(0, 240, 255, 0.55); }
.wf-search-tab-ops { flex-shrink: 0; display: flex; gap: 4px; align-items: center; margin-left: auto; padding: 0 2px 3px; }
.wf-search-tab-op {
  border: 1px solid var(--border); background: transparent;
  color: var(--muted); font-family: var(--mono); font-size: 10px;
  padding: 2px 8px; border-radius: 5px; cursor: pointer;
  transition: all 160ms var(--ease-in);
}
.wf-search-tab-op:hover { color: var(--neon); border-color: var(--border-strong); box-shadow: 0 0 8px rgba(0, 240, 255, 0.15); }
.wf-search-progress {
  flex-shrink: 0; height: 2px; border-radius: 1px;
  background: rgba(0, 240, 255, 0.08);
  overflow: hidden; opacity: 0; transition: opacity 200ms;
}
.wf-search-progress.loading { opacity: 1; }
.wf-search-progress::after {
  content: ''; display: block; height: 100%; width: 35%;
  background: var(--neon); border-radius: 1px;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.8);
  animation: wfSearchSlide 1.1s var(--ease-in) infinite;
}
@keyframes wfSearchSlide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}
.wf-search-frame {
  flex: 1; min-height: 0; width: 100%;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--card);
}
`;

interface ResultTab {
  engine: SearchEngine;
  url: string;
}

registerWidget({
  def: {
    id: 'search',
    name: '全域搜索',
    icon: '◎',
    description: '一个 query 并行发射到多个搜索引擎',
    category: 'tools',
    defaultSize: { w: 10, h: 8 },
    minSize: { w: 8, h: 6 },
  },
  mount(body, ctx: WidgetContext) {
    const style = document.createElement('style');
    style.textContent = CSS;
    body.appendChild(style);

    const root = document.createElement('div');
    root.className = 'wf-search';
    body.appendChild(root);

    let engines: SearchEngine[] = [];
    let manageOpen = false;
    let editingId: string | null = null;
    let launchTimer: ReturnType<typeof setTimeout> | null = null;
    let mode: 'query' | 'results' = 'query';
    let tabs: ResultTab[] = [];
    let activeTabId: string | null = null;

    function getHistory(): string[] {
      const h = ctx.config.history;
      return Array.isArray(h) ? (h as string[]).filter((s) => typeof s === 'string') : [];
    }

    function pushHistory(q: string): void {
      const h = [q, ...getHistory().filter((s) => s !== q)].slice(0, HISTORY_MAX);
      ctx.setConfig({ history: h });
    }

    // ---- input ----
    const inputWrap = document.createElement('div');
    inputWrap.className = 'wf-search-input-wrap';
    inputWrap.innerHTML = `
      <span class="wf-search-icon">◎</span>
      <input class="wf-search-input" type="text" placeholder="搜索任何东西，回车并行发射…" spellcheck="false" />
    `;
    root.appendChild(inputWrap);
    const input = inputWrap.querySelector<HTMLInputElement>('.wf-search-input')!;

    const chipsBox = document.createElement('div');
    chipsBox.className = 'wf-search-chips';
    root.appendChild(chipsBox);

    const launchEl = document.createElement('div');
    launchEl.className = 'wf-search-launch';
    root.appendChild(launchEl);

    const historyBox = document.createElement('div');
    historyBox.className = 'wf-search-history';
    root.appendChild(historyBox);

    const manageBox = document.createElement('div');
    manageBox.className = 'wf-search-manage';
    root.appendChild(manageBox);

    // ---- results mode ----
    const resultsBox = document.createElement('div');
    resultsBox.className = 'wf-search-results';
    resultsBox.style.display = 'none';

    const tabsBar = document.createElement('div');
    tabsBar.className = 'wf-search-tabs';
    resultsBox.appendChild(tabsBar);

    const progress = document.createElement('div');
    progress.className = 'wf-search-progress';
    resultsBox.appendChild(progress);

    const frame = document.createElement('iframe');
    frame.className = 'wf-search-frame';
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.addEventListener('load', () => progress.classList.remove('loading'));
    resultsBox.appendChild(frame);
    body.appendChild(resultsBox);

    function currentTab(): ResultTab | null {
      return tabs.find((t) => t.engine.id === activeTabId) || tabs[0] || null;
    }

    function loadFrame(tab: ResultTab): void {
      progress.classList.add('loading');
      frame.src = tab.url;
    }

    function renderTabs(): void {
      tabsBar.innerHTML = '';
      const cur = currentTab();
      for (const t of tabs) {
        const b = document.createElement('button');
        b.className = 'wf-search-tab' + (cur && t.engine.id === cur.engine.id ? ' on' : '');
        const name = document.createElement('span');
        name.textContent = t.engine.name;
        const grp = document.createElement('span');
        grp.className = 'wf-search-tab-grp';
        grp.textContent = groupLabel(t.engine.group);
        b.append(name, grp);
        b.title = t.url;
        b.addEventListener('click', () => {
          if (activeTabId === t.engine.id) return;
          activeTabId = t.engine.id;
          renderTabs();
          loadFrame(t);
        });
        tabsBar.appendChild(b);
      }
      const ops = document.createElement('div');
      ops.className = 'wf-search-tab-ops';
      const openAll = document.createElement('button');
      openAll.className = 'wf-search-tab-op';
      openAll.textContent = '全部外开 ↗';
      openAll.title = '在系统浏览器中打开全部引擎';
      openAll.addEventListener('click', () => {
        void ctx.api.searchLaunch(tabs.map((t) => t.url));
      });
      const back = document.createElement('button');
      back.className = 'wf-search-tab-op';
      back.textContent = '← 返回';
      back.title = '返回查询模式';
      back.addEventListener('click', () => setMode('query'));
      ops.append(openAll, back);
      tabsBar.appendChild(ops);
    }

    function setMode(next: 'query' | 'results'): void {
      mode = next;
      const results = mode === 'results';
      root.style.display = results ? 'none' : '';
      resultsBox.style.display = results ? '' : 'none';
      body.style.display = results ? 'flex' : '';
      body.style.flexDirection = results ? 'column' : '';
      if (results) {
        renderTabs();
        const cur = currentTab();
        if (cur) loadFrame(cur);
      } else {
        progress.classList.remove('loading');
        frame.src = 'about:blank';
        input.focus();
      }
    }

    function showLaunch(n: number): void {
      launchEl.textContent = `◈ 已发射到 ${n} 个引擎`;
      launchEl.classList.remove('show');
      void launchEl.offsetWidth; // restart animation
      launchEl.classList.add('show');
      if (launchTimer) clearTimeout(launchTimer);
      launchTimer = setTimeout(() => launchEl.classList.remove('show'), 2200);
    }

    function fire(query: string): void {
      const q = query.trim();
      if (!q) return;
      const active = engines.filter((e) => e.enabled);
      if (active.length === 0) {
        launchEl.textContent = '没有启用的引擎';
        launchEl.classList.add('show');
        if (launchTimer) clearTimeout(launchTimer);
        launchTimer = setTimeout(() => launchEl.classList.remove('show'), 2200);
        return;
      }
      tabs = active.map((e) => ({ engine: e, url: e.template.replace(/%s/g, encodeURIComponent(q)) }));
      if (!tabs.some((t) => t.engine.id === activeTabId)) activeTabId = tabs[0].engine.id;
      pushHistory(q);
      renderHistory();
      showLaunch(active.length);
      setMode('results');
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fire(input.value);
    });

    // ---- engine chips, single scrollable row ----
    function renderChips(): void {
      chipsBox.innerHTML = '';
      const sorted = [...engines].sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(groupLabel(a.group));
        const ib = GROUP_ORDER.indexOf(groupLabel(b.group));
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      for (const e of sorted) {
        const chip = document.createElement('button');
        chip.className = 'wf-search-chip' + (e.enabled ? ' on' : '');
        const name = document.createElement('span');
        name.textContent = e.name;
        const grp = document.createElement('span');
        grp.className = 'wf-search-chip-grp';
        grp.textContent = groupLabel(e.group);
        chip.append(name, grp);
        chip.title = `${groupLabel(e.group)} · ${e.template}`;
        chip.addEventListener('click', () => {
          e.enabled = !e.enabled;
          void ctx.api.saveEngine({ ...e });
          renderChips();
          renderManage();
        });
        chipsBox.appendChild(chip);
      }
    }

    // ---- history ----
    function renderHistory(): void {
      historyBox.innerHTML = '';
      const h = getHistory();
      if (h.length === 0) {
        historyBox.style.display = 'none';
        return;
      }
      historyBox.style.display = '';
      const label = document.createElement('span');
      label.className = 'wf-search-history-label';
      label.textContent = '最近';
      historyBox.appendChild(label);
      for (const q of h) {
        const b = document.createElement('button');
        b.className = 'wf-search-hist';
        b.textContent = q;
        b.title = q;
        b.addEventListener('click', () => {
          input.value = q;
          input.focus();
        });
        historyBox.appendChild(b);
      }
    }

    // ---- engine management ----
    function renderManage(): void {
      manageBox.innerHTML = '';
      const toggle = document.createElement('button');
      toggle.className = 'wf-search-manage-toggle';
      toggle.textContent = manageOpen ? '▾ 引擎管理' : '▸ 引擎管理';
      toggle.addEventListener('click', () => {
        manageOpen = !manageOpen;
        renderManage();
      });
      manageBox.appendChild(toggle);
      if (!manageOpen) return;

      for (const e of engines) {
        if (editingId === e.id) {
          manageBox.appendChild(buildForm(e));
          continue;
        }
        const row = document.createElement('div');
        row.className = 'wf-search-engine' + (e.enabled ? '' : ' wf-search-engine-off');
        const name = document.createElement('span');
        name.className = 'wf-search-engine-name';
        name.textContent = e.name;
        const grp = document.createElement('span');
        grp.className = 'wf-search-engine-group';
        grp.textContent = groupLabel(e.group);
        const spacer = document.createElement('span');
        spacer.className = 'spacer';
        const edit = document.createElement('button');
        edit.className = 'wf-search-engine-op';
        edit.textContent = '编辑';
        edit.addEventListener('click', () => {
          editingId = e.id;
          renderManage();
        });
        row.append(name, grp, spacer, edit);
        if (!e.builtin) {
          const del = document.createElement('button');
          del.className = 'wf-search-engine-op danger';
          del.textContent = '删除';
          del.addEventListener('click', () => {
            void ctx.api.deleteEngine(e.id).then((list) => {
              engines = list;
              renderChips();
              renderManage();
            });
          });
          row.appendChild(del);
        }
        manageBox.appendChild(row);
      }

      if (editingId === 'new') {
        manageBox.appendChild(buildForm(null));
      } else {
        const add = document.createElement('button');
        add.className = 'wf-search-add';
        add.textContent = '+ 添加引擎';
        add.addEventListener('click', () => {
          editingId = 'new';
          renderManage();
        });
        manageBox.appendChild(add);
      }
    }

    function buildForm(engine: SearchEngine | null): HTMLElement {
      const form = document.createElement('div');
      form.className = 'wf-search-form';
      form.innerHTML = `
        <input class="f-name" type="text" placeholder="名称（如 Google）" value="${engine ? esc(engine.name) : ''}" />
        <input class="f-template" type="text" placeholder="URL 模板，%s 为搜索词" value="${engine ? esc(engine.template) : ''}" />
        <div class="wf-search-form-row">
          <input class="f-group" type="text" placeholder="分组（通用/代码/学术/图片）" value="${engine ? esc(engine.group) : ''}" />
        </div>
        <div class="wf-search-form-btns">
          <button class="wf-search-btn ghost f-cancel">取消</button>
          <button class="wf-search-btn f-save">保存</button>
        </div>
      `;
      form.querySelector('.f-cancel')!.addEventListener('click', () => {
        editingId = null;
        renderManage();
      });
      form.querySelector('.f-save')!.addEventListener('click', () => {
        const name = (form.querySelector<HTMLInputElement>('.f-name')!.value || '').trim();
        const template = (form.querySelector<HTMLInputElement>('.f-template')!.value || '').trim();
        const group = (form.querySelector<HTMLInputElement>('.f-group')!.value || '').trim();
        if (!name || !template) return;
        const next: SearchEngine = engine
          ? { ...engine, name, template, group }
          : {
              id: `custom-${Date.now().toString(36)}`,
              name,
              template,
              group,
              enabled: true,
              builtin: false,
            };
        void ctx.api.saveEngine(next).then((list) => {
          engines = list;
          editingId = null;
          renderChips();
          renderManage();
        });
      });
      return form;
    }

    // ---- init ----
    renderHistory();
    renderManage();
    void ctx.api.getEngines().then((list) => {
      engines = list;
      renderChips();
      renderManage();
    });
    input.focus();
  },
});
