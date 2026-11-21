/// <reference path="../api.d.ts" />
import type { PresetMode, SessionMeta, VaultEntry } from '../../shared/types';
import { createChatPanel } from '../shared/chat-panel';

// ---------- dom ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- host state (topbar + 浮层 panel 的镜像;对话状态在 panel 内) ----------
let currentSession: SessionMeta | null = null;
let sessions: SessionMeta[] = [];
let modes: PresetMode[] = [];

// ---------- context menu (session 列表的「移到 Chat/Auto」;与消息右键共用 .kp-ctx-menu) ----------
let ctxMenu: HTMLElement | null = null;

function closeCtxMenu() {
  document.querySelector('.kp-ctx-menu')?.remove();
  ctxMenu = null;
}

document.addEventListener('click', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu();
});

// ---------- chat panel ----------
const panel = createChatPanel($('chat-panel'), {
  getSessionId: () => currentSession?.sessionId ?? '',
  onSwitchSession: (sid) => {
    // 面板绑定会话后:刷新会话列表/高亮,并收起打开的浮层
    void (async () => {
      sessions = await window.kimi.listSessions();
      currentSession = sessions.find((s) => s.sessionId === sid) ?? currentSession;
      renderSessionList();
    })();
    document.querySelector('.panel:not(.hidden)')?.classList.add('hidden');
  },
  onTitleChange: (title) => {
    $('session-title').textContent = title;
  },
  windowControls: true,
});

window.kimi.onLoadSession((sessionId) => void panel.setSession(sessionId));

// ---------- panels ----------
function openPanel(id: string) {
  for (const p of document.querySelectorAll('.panel')) p.classList.add('hidden');
  $(id).classList.remove('hidden');
}
for (const btn of document.querySelectorAll('.panel-close')) {
  (btn as HTMLElement).onclick = () => (btn.closest('.panel') as HTMLElement).classList.add('hidden');
}

// sessions
$('btn-sessions').onclick = async () => {
  sessions = await window.kimi.listSessions();
  renderSessionList();
  openPanel('panel-sessions');
};

let sessionFilter: 'all' | 'chat' | 'auto' = 'all';

for (const tab of document.querySelectorAll<HTMLButtonElement>('#session-tabs button')) {
  tab.onclick = () => {
    sessionFilter = tab.dataset.kind as typeof sessionFilter;
    for (const t of document.querySelectorAll('#session-tabs button')) t.classList.remove('active');
    tab.classList.add('active');
    renderSessionList();
  };
}

function renderSessionList() {
  const list = $('session-list');
  list.innerHTML = '';
  const visible = sessions
    .filter((s) => sessionFilter === 'all' || (s.kind ?? 'auto') === sessionFilter)
    .sort((a, b) => Number(b.main ?? false) - Number(a.main ?? false)); // 主会话置顶
  if (visible.length === 0) {
    list.innerHTML = '<div class="empty-hint">还没有会话<br />直接在下方输入，开始第一段对话吧</div>';
    return;
  }
  for (const s of visible) {
    const item = document.createElement('div');
    item.className = 'session-item' + (currentSession?.sessionId === s.sessionId ? ' active' : '');
    const kind = s.kind ?? 'auto';
    item.innerHTML = `<div class="s-title"></div><div class="s-time">${new Date(s.updatedAt).toLocaleString()}<span class="s-kind">${s.main ? '⭐ 主会话' : kind}</span></div>`;
    item.querySelector('.s-title')!.textContent = s.main ? `主会话 · ${s.title || 'JARVIS'}` : s.title || '未命名会话';
    item.onclick = () => void panel.setSession(s.sessionId);
    item.oncontextmenu = (e) => {
      e.preventDefault();
      closeCtxMenu();
      ctxMenu = document.createElement('div');
      ctxMenu.className = 'kp-ctx-menu';
      const target = kind === 'chat' ? 'auto' : 'chat';
      const move = document.createElement('button');
      move.textContent = target === 'chat' ? '移到 Chat' : '移到 Auto';
      move.onclick = async () => {
        sessions = await window.kimi.setSessionKind(s.sessionId, target);
        renderSessionList();
        closeCtxMenu();
      };
      ctxMenu.appendChild(move);
      document.body.appendChild(ctxMenu);
      ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - ctxMenu.offsetWidth - 8) + 'px';
      ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 8) + 'px';
    };
    list.appendChild(item);
  }
}

$('btn-new').onclick = () => void panel.newSession();

// vault
$('btn-vault').onclick = async () => {
  openPanel('panel-vault');
  $('vault-list').classList.remove('hidden');
  $('vault-editor').classList.add('hidden');
  const entries = await window.kimi.vaultList();
  renderVaultList(entries);
};

function renderVaultList(entries: VaultEntry[]) {
  const list = $('vault-list');
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-hint">收藏夹还是空的<br />试着对 Kimi 说「收藏这个想法」</div>';
    return;
  }
  for (const v of entries) {
    const item = document.createElement('div');
    item.className = 'vault-item';
    item.innerHTML = `<div class="s-title"></div><div class="s-time">${new Date(v.updatedAt).toLocaleString()}</div>`;
    item.querySelector('.s-title')!.textContent = v.title;
    item.onclick = () => void openVaultEntry(v.relPath);
    list.appendChild(item);
  }
}

let currentVaultPath: string | null = null;
async function openVaultEntry(relPath: string) {
  currentVaultPath = relPath;
  const content = await window.kimi.vaultRead(relPath);
  $('vault-editor-title').textContent = relPath;
  ($('vault-content') as HTMLTextAreaElement).value = content;
  $('vault-list').classList.add('hidden');
  $('vault-editor').classList.remove('hidden');
}
$('vault-save').onclick = async () => {
  if (!currentVaultPath) return;
  await window.kimi.vaultWrite(currentVaultPath, ($('vault-content') as HTMLTextAreaElement).value);
  $('vault-save').textContent = '已保存 ✓';
  setTimeout(() => ($('vault-save').textContent = '保存'), 1200);
};
$('vault-back').onclick = () => void ($('btn-vault') as HTMLElement).click();

// settings
$('btn-settings').onclick = async () => {
  openPanel('panel-settings');
  const s = await window.kimi.getSettings();
  $('settings-workspace').textContent = s.workspaceDir || '未设置';
  ($('settings-perm-mode') as HTMLSelectElement).value = s.permissionMode;
  renderModesEditor();
};
$('btn-pick-workspace').onclick = async () => {
  const dir = await window.kimi.pickWorkspaceDir();
  if (dir) $('settings-workspace').textContent = dir;
};
($('settings-perm-mode') as HTMLSelectElement).onchange = async (e) => {
  await window.kimi.setSettings({ permissionMode: (e.target as HTMLSelectElement).value as 'default' | 'auto' | 'yolo' });
};

function renderModesEditor() {
  const box = $('modes-editor');
  box.innerHTML = '';
  for (const m of modes) {
    const card = document.createElement('div');
    card.className = 'mode-edit';
    card.innerHTML = `
      <input class="m-name" placeholder="名称" />
      <input class="m-icon" placeholder="图标 emoji" style="width:80px" />
      <textarea class="m-prompt" placeholder="system prompt 模板"></textarea>
      <div class="mode-edit-actions">
        <button class="m-del">删除</button>
        <button class="m-save">保存</button>
      </div>`;
    (card.querySelector('.m-name') as HTMLInputElement).value = m.name;
    (card.querySelector('.m-icon') as HTMLInputElement).value = m.icon;
    (card.querySelector('.m-prompt') as HTMLTextAreaElement).value = m.prompt;
    card.querySelector('.m-save')!.addEventListener('click', async () => {
      m.name = (card.querySelector('.m-name') as HTMLInputElement).value.trim() || m.name;
      m.icon = (card.querySelector('.m-icon') as HTMLInputElement).value.trim() || m.icon;
      m.prompt = (card.querySelector('.m-prompt') as HTMLTextAreaElement).value;
      modes = await window.kimi.saveMode(m);
      renderModesEditor();
      void panel.reloadModes();
    });
    card.querySelector('.m-del')?.addEventListener('click', async () => {
      modes = await window.kimi.deleteMode(m.id);
      renderModesEditor();
      void panel.reloadModes();
    });
    box.appendChild(card);
  }
}
$('btn-add-mode').onclick = async () => {
  modes = await window.kimi.saveMode({
    id: `mode-${Date.now()}`,
    name: '新模式',
    icon: '✨',
    prompt: '',
    builtin: false,
  });
  renderModesEditor();
  void panel.reloadModes();
};

// ---------- window controls ----------
$('btn-close').onclick = () => window.kimi.hideChat();
$('btn-workbench').onclick = () => window.kimi.toggleHome();

// ---------- pin (always-on-top) ----------
let pinned = true;
function updatePinBtn() {
  $('btn-pin').classList.toggle('pinned', pinned);
  ($('btn-pin') as HTMLElement).title = pinned ? '取消置顶' : '置顶';
}
$('btn-pin').onclick = () => {
  pinned = !pinned;
  window.kimi.setChatPinned(pinned);
  updatePinBtn();
};

// ---------- theme (月之暗面) ----------
const THEME_KEY = 'kimi-float-theme';
function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  ($('btn-theme') as HTMLElement).title = theme === 'dark' ? '切换到浅色' : '月之暗面';
  localStorage.setItem(THEME_KEY, theme);
}
$('btn-theme').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};

// ---------- init ----------
(async () => {
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
  pinned = await window.kimi.getChatPinned();
  updatePinBtn();
  modes = await window.kimi.listModes();
  sessions = await window.kimi.listSessions();
  // resume most recent session if any
  if (sessions.length > 0) {
    currentSession = sessions[0];
    await panel.setSession(sessions[0].sessionId);
  }
})();
