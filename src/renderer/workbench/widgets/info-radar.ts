import { registerWidget } from '../core/registry';
import type { NewsItem, Radar, Task } from '../../../shared/workbench-types';

/* ------------------------------------------------------------------ */
/* styles (injected once, all classes prefixed wf-radar-)              */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'wf-radar-style';
const CSS = `
.wf-radar-root { position: relative; height: 100%; display: flex; min-width: 0; }
.wf-radar-side {
  width: 46px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;
  gap: 8px; padding: 8px 0; border-right: 1px solid var(--hairline); overflow-y: auto;
}
.wf-radar-iconbtn {
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--card); cursor: pointer; position: relative; font-size: 15px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: border-color 120ms var(--ease-in), box-shadow 120ms var(--ease-in);
  user-select: none; -webkit-user-select: none;
}
.wf-radar-iconbtn:hover { border-color: var(--border-strong); }
.wf-radar-iconbtn.active {
  border-color: var(--border-strong); box-shadow: 0 0 10px rgba(0,240,255,0.25);
  background: rgba(0,240,255,0.06);
}
.wf-radar-badge {
  position: absolute; top: -5px; right: -5px; min-width: 15px; height: 15px; padding: 0 3px;
  border-radius: 8px; background: var(--magenta); color: #fff; font-family: var(--mono);
  font-size: 9px; line-height: 15px; text-align: center; box-shadow: 0 0 6px rgba(255,0,128,0.6);
}
.wf-radar-main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.wf-radar-topbar {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid var(--hairline); flex-shrink: 0;
}
.wf-radar-name {
  font-family: var(--mono); font-size: 11px; letter-spacing: 1px; color: var(--neon);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wf-radar-seg { display: flex; flex-shrink: 0; }
.wf-radar-segbtn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer; margin-left: -1px;
}
.wf-radar-segbtn:first-child { border-radius: 5px 0 0 5px; margin-left: 0; }
.wf-radar-segbtn:last-child { border-radius: 0 5px 5px 0; }
.wf-radar-segbtn.active { color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.06); position: relative; z-index: 1; }
.wf-radar-refresh {
  border: 1px solid var(--border-strong); background: rgba(0,240,255,0.08); color: var(--neon);
  font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 5px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; transition: box-shadow 160ms var(--ease-in);
}
.wf-radar-refresh:hover:not(:disabled) { box-shadow: 0 0 10px rgba(0,240,255,0.25); }
.wf-radar-refresh:disabled { color: var(--disabled); border-color: var(--border); background: transparent; cursor: default; }
.wf-radar-autoplay {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 5px; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; transition: color 120ms var(--ease-in), border-color 120ms var(--ease-in);
}
.wf-radar-autoplay:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-radar-autoplay.active {
  color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.06);
  box-shadow: 0 0 8px rgba(0,240,255,0.2);
}
.wf-radar-gear {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; width: 24px; height: 24px; border-radius: 5px; cursor: pointer;
  flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  transition: color 120ms var(--ease-in), border-color 120ms var(--ease-in);
}
.wf-radar-gear:hover:not(:disabled) { color: var(--neon); border-color: var(--border-strong); }
.wf-radar-gear:disabled { color: var(--disabled); cursor: default; }
.wf-radar-content { flex: 1; overflow-y: auto; min-height: 0; padding: 10px; display: flex; flex-direction: column; gap: 8px; }

/* new-items pill (floats above the feed) */
.wf-radar-newpill {
  position: absolute; top: 6px; left: 50%; transform: translateX(-50%); z-index: 6;
  font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--neon);
  background: rgba(4,10,16,0.92); border: 1px solid var(--border-strong); border-radius: 10px;
  padding: 2px 12px; cursor: pointer; box-shadow: 0 0 10px rgba(0,240,255,0.25);
  transition: box-shadow 160ms var(--ease-in);
}
.wf-radar-newpill:hover { box-shadow: 0 0 16px rgba(0,240,255,0.4); }

/* settings overlay */
.wf-radar-overlay {
  position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center;
  background: rgba(3,8,12,0.82); backdrop-filter: blur(3px);
}
.wf-radar-panel {
  width: min(340px, 92%); max-height: 92%; overflow-y: auto;
  background: var(--card); border: 1px solid var(--border-strong); border-radius: 10px;
  padding: 14px 16px; box-shadow: 0 0 24px rgba(0,240,255,0.12);
}
.wf-radar-panel h3 {
  margin: 0 0 12px; font-family: var(--mono); font-size: 11px; font-weight: 400;
  letter-spacing: 2px; color: var(--neon);
}
.wf-radar-field { margin-bottom: 10px; }
.wf-radar-field > label {
  display: block; font-family: var(--mono); font-size: 9.5px; letter-spacing: 1px;
  color: var(--muted); margin-bottom: 4px;
}
.wf-radar-input {
  width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3);
  border: 1px solid var(--border); border-radius: 6px; color: var(--fg);
  font: inherit; font-size: 12px; padding: 6px 8px; outline: none;
  transition: border-color 120ms var(--ease-in);
}
.wf-radar-input:focus { border-color: var(--border-strong); }
textarea.wf-radar-input { font-family: var(--mono); font-size: 10.5px; line-height: 1.5; resize: vertical; }
.wf-radar-enabledrow {
  display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--fg);
  cursor: pointer; margin: 4px 0 2px;
}
.wf-radar-enabledrow input { accent-color: var(--neon); cursor: pointer; }
.wf-radar-panel-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.wf-radar-cancelbtn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11px; padding: 4px 14px; border-radius: 5px; cursor: pointer;
}
.wf-radar-cancelbtn:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-radar-savebtn {
  border: 1px solid var(--border-strong); background: rgba(0,240,255,0.08); color: var(--neon);
  font: inherit; font-size: 11px; padding: 4px 14px; border-radius: 5px; cursor: pointer;
  transition: box-shadow 160ms var(--ease-in);
}
.wf-radar-savebtn:hover { box-shadow: 0 0 10px rgba(0,240,255,0.25); }

/* sources list (settings panel) */
.wf-radar-srclist {
  display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 6px;
  background: rgba(0,0,0,0.2); margin-bottom: 6px;
}
.wf-radar-srclist:empty { display: none; }
.wf-radar-srcrow { display: flex; align-items: center; gap: 6px; }
.wf-radar-srcurl {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 10.5px; color: var(--fg);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wf-radar-srcdel {
  border: none; background: transparent; color: var(--muted); font-size: 12px;
  width: 20px; height: 20px; border-radius: 5px; cursor: pointer; flex-shrink: 0;
  transition: color 120ms var(--ease-in), background 120ms var(--ease-in);
}
.wf-radar-srcdel:hover { color: var(--error); background: rgba(255,68,68,0.1); }
.wf-radar-srcadd { display: flex; gap: 6px; }
.wf-radar-srcadd .wf-radar-input { flex: 1; min-width: 0; }
.wf-radar-srcadd button { flex-shrink: 0; }

/* feed cards */
.wf-radar-card {
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 11px; cursor: pointer; flex-shrink: 0;
  transition: border-color 120ms var(--ease-in), box-shadow 120ms var(--ease-in);
}
.wf-radar-card:hover { border-color: var(--border-strong); box-shadow: 0 0 12px rgba(0,240,255,0.1); }
.wf-radar-card.read { opacity: 0.55; }
.wf-radar-meta { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10px; color: var(--muted); }
.wf-radar-src { color: var(--neon); }
.wf-radar-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--neon); box-shadow: 0 0 6px var(--neon); flex-shrink: 0; }
.wf-radar-title { font-size: 12.5px; font-weight: 600; line-height: 1.45; margin: 5px 0 3px; word-break: break-word; }
.wf-radar-summary { font-size: 11.5px; color: var(--muted); line-height: 1.55; word-break: break-word; }
.wf-radar-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.wf-radar-tag {
  font-family: var(--mono); font-size: 9.5px; color: var(--neon);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; line-height: 15px;
}
.wf-radar-actions { display: flex; gap: 6px; margin-top: 8px; }
.wf-radar-act {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 10.5px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
  transition: color 120ms var(--ease-in), border-color 120ms var(--ease-in);
}
.wf-radar-act:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-radar-act.fav { color: var(--warn); border-color: rgba(255,170,0,0.4); }
.wf-radar-act.done { color: var(--green); border-color: rgba(0,255,136,0.4); }

/* thread view */
.wf-radar-back {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 5px; cursor: pointer; flex-shrink: 0;
}
.wf-radar-back:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-radar-thread { flex: 1; overflow-y: auto; min-height: 0; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.wf-radar-threadcard { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.wf-radar-threadtitle { font-size: 15px; font-weight: 700; line-height: 1.5; margin: 8px 0; word-break: break-word; }
.wf-radar-threadsummary { font-size: 12.5px; line-height: 1.7; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
.wf-radar-linkcard {
  display: block; margin-top: 12px; border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 12px; cursor: pointer; background: rgba(0,0,0,0.25);
  transition: border-color 120ms var(--ease-in);
}
.wf-radar-linkcard:hover { border-color: var(--border-strong); }
.wf-radar-linkcard .dom { font-family: var(--mono); font-size: 10px; color: var(--neon); }
.wf-radar-linkcard .url { font-size: 11px; color: var(--muted); word-break: break-all; margin-top: 2px; }
.wf-radar-related { border-top: 1px solid var(--hairline); padding-top: 10px; }
.wf-radar-related h4 { margin: 0 0 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--muted); font-weight: 400; }
.wf-radar-relitem {
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; margin-bottom: 6px;
  cursor: pointer; font-size: 11.5px; line-height: 1.4; background: var(--card);
}
.wf-radar-relitem:hover { border-color: var(--border-strong); }

/* empty / loading */
.wf-radar-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--disabled); font-size: 12px; text-align: center; padding: 20px;
}
.wf-radar-scan { font-family: var(--mono); font-size: 11px; letter-spacing: 2px; color: var(--neon); animation: wf-radar-pulse 1.2s ease-in-out infinite; }
@keyframes wf-radar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

function fullTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* widget                                                              */
/* ------------------------------------------------------------------ */

type Filter = 'all' | 'unread' | 'fav';

const SCROLL_PX_PER_SEC = 24; // marquee-style continuous scroll speed
const BOTTOM_PAUSE_MS = 2000; // dwell at the bottom before jumping back to top

registerWidget({
  def: {
    id: 'info-radar',
    name: 'Info Radar',
    icon: '≡',
    description: 'AI 驱动的个性化情报追踪',
    category: 'ai',
    defaultSize: { w: 12, h: 12 },
    minSize: { w: 9, h: 8 },
  },
  mount(body, ctx) {
    ensureStyle();

    let radars: Radar[] = [];
    let activeId = typeof ctx.config.activeRadarId === 'string' ? ctx.config.activeRadarId : '';
    let filter: Filter = 'all';
    let threadItemId: string | null = null;
    let refreshing = false;
    let loaded = false;
    let autoplay = ctx.config.autoplay === true;
    let hovering = false;
    let settingsOpen = false;
    let pendingNew = 0;

    body.innerHTML = `
      <div class="wf-radar-root">
        <div class="wf-radar-side"></div>
        <div class="wf-radar-main">
          <div class="wf-radar-topbar"></div>
          <div class="wf-radar-content"></div>
        </div>
      </div>`;
    const rootEl = body.querySelector<HTMLElement>('.wf-radar-root')!;
    const sideEl = body.querySelector<HTMLElement>('.wf-radar-side')!;
    const mainEl = body.querySelector<HTMLElement>('.wf-radar-main')!;
    const topbarEl = body.querySelector<HTMLElement>('.wf-radar-topbar')!;
    const contentEl = body.querySelector<HTMLElement>('.wf-radar-content')!;

    const activeRadar = (): Radar | undefined => radars.find((r) => r.id === activeId) ?? radars[0];
    const unreadCount = (r: Radar): number => r.items.filter((i) => !i.read).length;

    function persistActive(id: string): void {
      activeId = id;
      ctx.setConfig({ activeRadarId: id });
    }

    function saveAndRender(radar: Radar): void {
      void ctx.api.radarSave(radar);
      renderAll();
    }

    /* ---------- settings panel ---------- */

    function closeSettings(): void {
      settingsOpen = false;
      rootEl.querySelector('.wf-radar-overlay')?.remove();
    }

    function openSettings(radar: Radar): void {
      closeSettings();
      settingsOpen = true;
      const overlay = document.createElement('div');
      overlay.className = 'wf-radar-overlay';
      overlay.innerHTML = `
        <div class="wf-radar-panel">
          <h3>RADAR 设置</h3>
          <div class="wf-radar-field">
            <label>名称</label>
            <input class="wf-radar-input" data-f="name" type="text" value="${esc(radar.name)}">
          </div>
          <div class="wf-radar-field">
            <label>图标 (emoji)</label>
            <input class="wf-radar-input" data-f="icon" type="text" value="${esc(radar.icon)}">
          </div>
          <div class="wf-radar-field">
            <label>刷新频率（分钟）</label>
            <input class="wf-radar-input" data-f="freq" type="number" min="5" step="1" value="${radar.frequencyMinutes}">
          </div>
          <div class="wf-radar-field">
            <label>数据源（支持 GitHub / arXiv / HN / RSS / Atom）</label>
            <div class="wf-radar-srclist"></div>
            <div class="wf-radar-srcadd">
              <input class="wf-radar-input" data-f="newsrc" type="text" placeholder="新增源 URL，回车或点添加…" spellcheck="false">
              <button class="wf-radar-cancelbtn" data-act="addsrc" type="button">添加</button>
            </div>
          </div>
          <label class="wf-radar-enabledrow">
            <input data-f="enabled" type="checkbox" ${radar.enabled ? 'checked' : ''}> 启用定时抓取
          </label>
          <div class="wf-radar-panel-actions">
            <button class="wf-radar-cancelbtn" type="button">取消</button>
            <button class="wf-radar-savebtn" type="button">保存</button>
          </div>
        </div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettings();
      });
      overlay.querySelector('.wf-radar-cancelbtn')!.addEventListener('click', closeSettings);

      /* sources 列表:编辑副本随表单保存一起提交(表单是点保存才生效) */
      const editSources = [...radar.sources];
      const srcListEl = overlay.querySelector<HTMLElement>('.wf-radar-srclist')!;
      const newSrcInput = overlay.querySelector<HTMLInputElement>('[data-f="newsrc"]')!;
      const renderSrcList = (): void => {
        srcListEl.innerHTML = editSources
          .map(
            (s, i) => `
            <div class="wf-radar-srcrow">
              <span class="wf-radar-srcurl" title="${esc(s)}">${esc(s)}</span>
              <button class="wf-radar-srcdel" type="button" data-i="${i}" title="删除该源">×</button>
            </div>`,
          )
          .join('');
      };
      renderSrcList();
      srcListEl.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.wf-radar-srcdel');
        if (!btn) return;
        const url = editSources[Number(btn.dataset.i)];
        if (!window.confirm(`删除后将不再追踪该源，已抓取的历史条目保留。确定删除？\n${url}`)) return;
        editSources.splice(Number(btn.dataset.i), 1);
        renderSrcList();
      });
      const addSource = (): void => {
        const url = newSrcInput.value.trim();
        if (!url) return;
        if (!editSources.includes(url)) editSources.push(url);
        newSrcInput.value = '';
        renderSrcList();
        newSrcInput.focus();
      };
      overlay.querySelector('[data-act="addsrc"]')!.addEventListener('click', addSource);
      newSrcInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addSource();
        }
      });

      overlay.querySelector('.wf-radar-savebtn')!.addEventListener('click', () => {
        const val = (f: string): string =>
          (overlay.querySelector<HTMLInputElement>(`[data-f="${f}"]`)?.value ?? '').trim();
        const name = val('name') || radar.name;
        const icon = val('icon') || radar.icon;
        const freq = Math.max(5, Math.round(Number(val('freq')) || radar.frequencyMinutes));
        // 列表形态下清空是有意操作(逐行确认过),不再回退旧值
        const sources = editSources.filter(Boolean);
        const enabled = overlay.querySelector<HTMLInputElement>('[data-f="enabled"]')!.checked;
        const next: Radar = {
          ...radar,
          name,
          icon,
          frequencyMinutes: freq,
          sources,
          enabled,
        };
        void ctx.api
          .radarSave(next)
          .then((list) => {
            radars = list;
          })
          .catch(() => {})
          .finally(() => {
            closeSettings();
            renderAll();
          });
      });
      rootEl.appendChild(overlay);
    }

    /* ---------- sidebar ---------- */

    function renderSide(): void {
      sideEl.innerHTML = '';
      for (const r of radars) {
        const btn = document.createElement('button');
        btn.className = 'wf-radar-iconbtn' + (r.id === activeRadar()?.id ? ' active' : '');
        btn.textContent = r.icon;
        btn.title = `${r.name} — ${r.query}\n（长按或右键打开设置）`;
        const n = unreadCount(r);
        if (n > 0) {
          const badge = document.createElement('span');
          badge.className = 'wf-radar-badge';
          badge.textContent = n > 99 ? '99+' : String(n);
          btn.appendChild(badge);
        }
        // long-press or right-click opens the settings panel
        let pressTimer: number | undefined;
        let suppressClick = false;
        const cancelPress = (): void => {
          if (pressTimer !== undefined) {
            clearTimeout(pressTimer);
            pressTimer = undefined;
          }
        };
        btn.addEventListener('pointerdown', () => {
          cancelPress();
          pressTimer = window.setTimeout(() => {
            pressTimer = undefined;
            suppressClick = true;
            openSettings(r);
          }, 550);
        });
        btn.addEventListener('pointerup', cancelPress);
        btn.addEventListener('pointerleave', cancelPress);
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          cancelPress();
          openSettings(r);
        });
        btn.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          persistActive(r.id);
          threadItemId = null;
          pendingNew = 0;
          contentEl.scrollTop = 0;
          renderAll();
        });
        sideEl.appendChild(btn);
      }
    }

    /* ---------- topbar ---------- */

    function renderTopbar(): void {
      const radar = activeRadar();
      topbarEl.innerHTML = '';
      if (threadItemId) {
        const back = document.createElement('button');
        back.className = 'wf-radar-back';
        back.textContent = '← 返回 Feed';
        back.addEventListener('click', () => {
          threadItemId = null;
          renderAll();
        });
        topbarEl.appendChild(back);
        const name = document.createElement('span');
        name.className = 'wf-radar-name';
        name.textContent = radar ? `${radar.icon} ${radar.name}` : '';
        topbarEl.appendChild(name);
        return;
      }
      const name = document.createElement('span');
      name.className = 'wf-radar-name';
      name.textContent = radar ? `${radar.icon} ${radar.name.toUpperCase()}` : 'INFO RADAR';
      topbarEl.appendChild(name);

      const seg = document.createElement('div');
      seg.className = 'wf-radar-seg';
      const filters: Array<[Filter, string]> = [['all', '全部'], ['unread', '未读'], ['fav', '收藏']];
      for (const [key, label] of filters) {
        const b = document.createElement('button');
        b.className = 'wf-radar-segbtn' + (filter === key ? ' active' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          filter = key;
          pendingNew = 0;
          contentEl.scrollTop = 0;
          renderAll();
        });
        seg.appendChild(b);
      }
      topbarEl.appendChild(seg);

      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      topbarEl.appendChild(spacer);

      const auto = document.createElement('button');
      auto.className = 'wf-radar-autoplay' + (autoplay ? ' active' : '');
      auto.textContent = autoplay ? '⏸ 轮播' : '▶ 轮播';
      auto.title = '自动轮播 Feed（悬停暂停）';
      auto.addEventListener('click', () => {
        autoplay = !autoplay;
        ctx.setConfig({ autoplay });
        if (autoplay) contentEl.scrollTop = 0;
        renderTopbar();
      });
      topbarEl.appendChild(auto);

      const refresh = document.createElement('button');
      refresh.className = 'wf-radar-refresh';
      refresh.textContent = refreshing ? '更新中…' : '↻ 立即更新';
      refresh.disabled = refreshing || !radar;
      refresh.addEventListener('click', () => {
        if (!radar || refreshing) return;
        refreshing = true;
        renderTopbar();
        void ctx.api
          .radarRunNow(radar.id)
          .then((next) => {
            radars = next;
          })
          .catch(() => {})
          .finally(() => {
            refreshing = false;
            renderAll();
          });
      });
      topbarEl.appendChild(refresh);

      const gear = document.createElement('button');
      gear.className = 'wf-radar-gear';
      gear.textContent = '⚙';
      gear.title = 'Radar 设置';
      gear.disabled = !radar;
      gear.addEventListener('click', () => {
        if (radar) openSettings(radar);
      });
      topbarEl.appendChild(gear);
    }

    /* ---------- new-items pill ---------- */

    let newpillEl: HTMLButtonElement | null = null;

    function renderNewpill(): void {
      if (pendingNew > 0 && !threadItemId) {
        if (!newpillEl) {
          newpillEl = document.createElement('button');
          newpillEl.className = 'wf-radar-newpill';
          newpillEl.addEventListener('click', () => {
            pendingNew = 0;
            contentEl.scrollTo({ top: 0, behavior: 'smooth' });
            renderNewpill();
          });
          mainEl.appendChild(newpillEl);
        }
        newpillEl.textContent = `↑ 有 ${pendingNew} 条新动态`;
      } else if (newpillEl) {
        newpillEl.remove();
        newpillEl = null;
      }
    }

    /* ---------- feed ---------- */

    function filteredItems(radar: Radar): NewsItem[] {
      const items = [...radar.items].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      if (filter === 'unread') return items.filter((i) => !i.read);
      if (filter === 'fav') return items.filter((i) => i.favorite);
      return items;
    }

    function toggleRead(radar: Radar, item: NewsItem, read: boolean): void {
      item.read = read;
      saveAndRender(radar);
    }

    function toggleFav(radar: Radar, item: NewsItem): void {
      item.favorite = !item.favorite;
      saveAndRender(radar);
    }

    function toTask(item: NewsItem, btn: HTMLButtonElement): void {
      const now = Date.now();
      const task: Task = {
        id: `task-${now}`,
        title: item.title,
        description: `${item.summary}\n\n原文: ${item.url}`,
        status: 'todo',
        priority: 'medium',
        notes: '',
        tags: [...item.tags],
        createdAt: now,
        updatedAt: now,
      };
      btn.disabled = true;
      void ctx.api
        .saveTask(task)
        .then(() => {
          ctx.bus.emit('task:refresh');
          btn.textContent = '✓ 已转任务';
          btn.classList.add('done');
        })
        .catch(() => {
          btn.disabled = false;
        });
    }

    function itemCard(radar: Radar, item: NewsItem): HTMLElement {
      const card = document.createElement('div');
      card.className = 'wf-radar-card' + (item.read ? ' read' : '');
      card.innerHTML = `
        <div class="wf-radar-meta">
          ${item.read ? '' : '<span class="wf-radar-dot"></span>'}
          <span class="wf-radar-src">${esc(item.source)}</span>
          <span>·</span>
          <span>${esc(relTime(item.publishedAt))}</span>
        </div>
        <div class="wf-radar-title">${esc(item.title)}</div>
        <div class="wf-radar-summary">${esc(item.summary)}</div>
        ${item.tags.length ? `<div class="wf-radar-tags">${item.tags.map((t) => `<span class="wf-radar-tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="wf-radar-actions"></div>`;
      card.addEventListener('click', () => {
        threadItemId = item.id;
        if (!item.read) item.read = true;
        void ctx.api.radarSave(radar);
        renderAll();
      });
      const actions = card.querySelector<HTMLElement>('.wf-radar-actions')!;

      const fav = document.createElement('button');
      fav.className = 'wf-radar-act' + (item.favorite ? ' fav' : '');
      fav.textContent = item.favorite ? '★ 已收藏' : '☆ 收藏';
      fav.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFav(radar, item);
      });
      actions.appendChild(fav);

      const taskBtn = document.createElement('button');
      taskBtn.className = 'wf-radar-act';
      taskBtn.textContent = '→ 转任务';
      taskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toTask(item, taskBtn);
      });
      actions.appendChild(taskBtn);

      const readBtn = document.createElement('button');
      readBtn.className = 'wf-radar-act';
      readBtn.textContent = item.read ? '标为未读' : '标记已读';
      readBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRead(radar, item, !item.read);
      });
      actions.appendChild(readBtn);

      return card;
    }

    function renderFeed(): void {
      const radar = activeRadar();
      contentEl.innerHTML = '';
      if (!radar) {
        contentEl.innerHTML = '<div class="wf-radar-empty">暂无 Radar 配置</div>';
        return;
      }
      const items = filteredItems(radar);
      if (items.length === 0) {
        contentEl.innerHTML = `
          <div class="wf-radar-empty">
            <div class="wf-radar-scan">NO SIGNAL</div>
            <div>${filter === 'all' ? '暂无内容 — 点击右上角「立即更新」抓取' : '当前筛选下没有条目'}</div>
          </div>`;
        return;
      }
      for (const item of items) contentEl.appendChild(itemCard(radar, item));
    }

    /* ---------- thread ---------- */

    function renderThread(): void {
      const radar = activeRadar();
      const item = radar?.items.find((i) => i.id === threadItemId);
      contentEl.innerHTML = '';
      if (!radar || !item) {
        threadItemId = null;
        renderFeed();
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'wf-radar-thread';

      const card = document.createElement('div');
      card.className = 'wf-radar-threadcard';
      card.innerHTML = `
        <div class="wf-radar-meta">
          <span class="wf-radar-src">${esc(item.source)}</span>
          <span>·</span>
          <span>${esc(fullTime(item.publishedAt))}</span>
        </div>
        <div class="wf-radar-threadtitle">${esc(item.title)}</div>
        <div class="wf-radar-threadsummary">${esc(item.summary)}</div>
        ${item.tags.length ? `<div class="wf-radar-tags">${item.tags.map((t) => `<span class="wf-radar-tag">#${esc(t)}</span>`).join('')}</div>` : ''}`;
      const link = document.createElement('div');
      link.className = 'wf-radar-linkcard';
      link.innerHTML = `<div class="dom">🔗 ${esc(hostOf(item.url))}</div><div class="url">${esc(item.url)}</div>`;
      link.addEventListener('click', () => window.kimi.openExternal(item.url));
      card.appendChild(link);

      const actions = document.createElement('div');
      actions.className = 'wf-radar-actions';
      const fav = document.createElement('button');
      fav.className = 'wf-radar-act' + (item.favorite ? ' fav' : '');
      fav.textContent = item.favorite ? '★ 已收藏' : '♡ 收藏';
      fav.addEventListener('click', () => toggleFav(radar, item));
      actions.appendChild(fav);
      const taskBtn = document.createElement('button');
      taskBtn.className = 'wf-radar-act';
      taskBtn.textContent = '➜ 转为任务';
      taskBtn.addEventListener('click', () => toTask(item, taskBtn));
      actions.appendChild(taskBtn);
      card.appendChild(actions);
      wrap.appendChild(card);

      // related: same radar, shares ≥1 tag, most recent first
      if (item.tags.length) {
        const tags = new Set(item.tags);
        const related = radar.items
          .filter((i) => i.id !== item.id && i.tags.some((t) => tags.has(t)))
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
          .slice(0, 3);
        if (related.length) {
          const rel = document.createElement('div');
          rel.className = 'wf-radar-related';
          rel.innerHTML = '<h4>相关推荐</h4>';
          for (const r of related) {
            const el = document.createElement('div');
            el.className = 'wf-radar-relitem';
            el.textContent = r.title;
            el.addEventListener('click', () => {
              threadItemId = r.id;
              if (!r.read) {
                r.read = true;
                void ctx.api.radarSave(radar);
              }
              renderAll();
            });
            rel.appendChild(el);
          }
          wrap.appendChild(rel);
        }
      }
      contentEl.appendChild(wrap);
    }

    /* ---------- render + data ---------- */

    function renderAll(): void {
      renderSide();
      renderTopbar();
      if (threadItemId) renderThread();
      else renderFeed();
      renderNewpill();
    }

    function reload(): Promise<void> {
      return ctx.api
        .radarList()
        .then((next) => {
          radars = next;
          if (!radars.some((r) => r.id === activeId)) activeId = radars[0]?.id ?? '';
          loaded = true;
          renderAll();
        })
        .catch(() => {
          loaded = true;
          contentEl.innerHTML = '<div class="wf-radar-empty">Radar 数据加载失败</div>';
        });
    }

    contentEl.innerHTML = '<div class="wf-radar-empty"><div class="wf-radar-scan">SCANNING…</div></div>';
    void reload();

    /* ---------- autoplay ---------- */

    // pause while the pointer is over the feed
    contentEl.addEventListener('mouseenter', () => {
      hovering = true;
    });
    contentEl.addEventListener('mouseleave', () => {
      hovering = false;
    });

    // slow marquee-style continuous scroll (~24 px/s) instead of paging one
    // screen every few seconds; dwell at the bottom, then jump back to the top
    let lastFrameTs = 0;
    let bottomSince = 0;
    const autoplayFrame = (ts: number): void => {
      // self-cleanup when the widget is removed or sleeping in the dock
      if (!body.isConnected) return;
      requestAnimationFrame(autoplayFrame);
      const dt = lastFrameTs ? Math.min(ts - lastFrameTs, 100) : 16;
      lastFrameTs = ts;
      if (!autoplay || hovering || settingsOpen || threadItemId) {
        bottomSince = 0;
        return;
      }
      if (contentEl.scrollHeight <= contentEl.clientHeight + 4) return;
      const atBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2;
      if (atBottom) {
        if (bottomSince === 0) bottomSince = ts;
        else if (ts - bottomSince >= BOTTOM_PAUSE_MS) {
          bottomSince = 0;
          contentEl.scrollTop = 0;
        }
        return;
      }
      bottomSince = 0;
      contentEl.scrollTop += (SCROLL_PX_PER_SEC * dt) / 1000;
    };
    requestAnimationFrame(autoplayFrame);

    // main process pushes when a scheduled run found new items
    window.kimi.onRadarItems((p) => {
      if (!loaded) return;
      // keep the carousel's rhythm: preserve scroll position across the reload
      const scrollPos = autoplay && !threadItemId ? contentEl.scrollTop : null;
      void reload().then(() => {
        if (p.radarId === activeRadar()?.id) {
          pendingNew += p.newCount;
          if (scrollPos !== null) contentEl.scrollTop = scrollPos;
          renderNewpill();
        }
      });
    });

    // Command Center create_radar action → refresh the list immediately
    ctx.bus.on('radar:refresh', () => {
      if (loaded) void reload();
    });
  },
});
