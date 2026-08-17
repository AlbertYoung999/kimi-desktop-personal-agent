/// <reference path="../api.d.ts" />
import type { PresetMode, PromptImage, SessionMeta, VaultEntry } from '../../shared/types';

// ---------- tiny markdown renderer (escaped, code/bold/italic/lists) ----------
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdToHtml(md: string): string {
  const blocks: string[] = [];
  // extract fenced code blocks first, replaced by \x00N\x00 sentinels (escapeHtml leaves \x00 intact)
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00${blocks.length - 1}\x00`;
  });
  text = escapeHtml(text);
  // images first, then markdown links (negative lookbehind so ![...]( ) isn't eaten), then bare URLs
  text = text
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img class="md-img" src="$2" alt="$1" loading="lazy" />')
    .replace(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-link>$1</a>')
    .replace(/(?<!href=")(?<!src=")(https?:\/\/[^\s<)。，、；：！？」』]+)/g, (m) => {
      const trailing = m.match(/[.,;:!?]+$/)?.[0] ?? '';
      const url = m.slice(0, m.length - trailing.length);
      return `<a href="${url}" data-link>${url}</a>${trailing}`;
    });
  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  const lines = text.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const splitRow = (row: string): string[] =>
    row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // markdown table: header row + |---| separator row
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      closeList();
      const header = splitRow(trimmed);
      i += 2; // skip header + separator
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(splitRow(lines[i].trim()));
        i++;
      }
      out.push(
        '<div class="table-wrap"><table class="md-table"><thead><tr>' +
          header.map((c) => `<th>${c}</th>`).join('') +
          '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    i++;
    const sentinel = trimmed.match(/^\x00(\d+)\x00$/);
    if (sentinel) {
      closeList();
      out.push(blocks[Number(sentinel[1])]);
      continue;
    }
    const ul = trimmed.match(/^[-*•]\s+(.*)$/);
    const ol = trimmed.match(/^\d+[.、]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (/^#{1,4}\s+/.test(trimmed)) {
      closeList();
      out.push(`<p><strong>${trimmed.replace(/^#{1,4}\s+/, '')}</strong></p>`);
    } else if (trimmed === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${trimmed}</p>`);
    }
  }
  closeList();
  return out.join('');
}

// ---------- state ----------
let currentSession: SessionMeta | null = null;
let sessions: SessionMeta[] = [];
let modes: PresetMode[] = [];
let activeModeId: string | null = null;
let pendingImage: PromptImage | null = null;
let streaming = false;
let currentAgentEl: HTMLElement | null = null;
let currentAgentText = '';
let currentThoughtBox: HTMLElement | null = null;
let currentThoughtBody: HTMLElement | null = null;
let pendingPermissionId: string | null = null;
let loadingEl: HTMLElement | null = null;

// ---------- dom ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const messagesEl = $('messages');
const inputEl = $('input') as HTMLTextAreaElement;
const sendBtn = $('btn-send') as HTMLButtonElement;

// ---------- scroll: stick to bottom unless the user scrolled up ----------
let stickToBottom = true;
messagesEl.addEventListener('scroll', () => {
  stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
});

function scrollToBottom(force = false) {
  if (force || stickToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// links inside agent messages open in the system browser; images open a fullscreen preview
messagesEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a[data-link]');
  if (a) {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) window.kimi.openExternal(href);
    return;
  }
  const img = (e.target as HTMLElement).closest('img.md-img, img.msg-img') as HTMLImageElement | null;
  if (img?.src) {
    e.preventDefault();
    window.kimi.showImagePreview(img.src);
  }
});

// ---------- context menu: copy / quote ----------
let ctxMenu: HTMLElement | null = null;

function closeCtxMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

function messageText(el: Element): string {
  // thought box: quote/copy only the body, not the header
  const body = el.querySelector('.thought-body');
  const raw = ((body ?? el) as HTMLElement).innerText ?? '';
  return raw.trim();
}

messagesEl.addEventListener('contextmenu', (e) => {
  const target = (e.target as HTMLElement).closest('.msg, .thought-box');
  if (!target) return;
  // prefer the user's text selection inside this message; fall back to the whole message
  const sel = window.getSelection();
  let text = '';
  if (sel && !sel.isCollapsed && sel.anchorNode && target.contains(sel.anchorNode)) {
    text = sel.toString().trim();
  }
  if (!text) text = messageText(target);
  if (!text) return;
  e.preventDefault();
  closeCtxMenu();

  ctxMenu = document.createElement('div');
  ctxMenu.id = 'ctx-menu';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制';
  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(text);
    closeCtxMenu();
  };
  const quoteBtn = document.createElement('button');
  quoteBtn.textContent = '引用提问';
  quoteBtn.onclick = () => {
    setQuote(text);
    sel?.removeAllRanges();
    inputEl.focus();
    closeCtxMenu();
  };
  ctxMenu.append(copyBtn, quoteBtn);
  document.body.appendChild(ctxMenu);

  // keep the menu inside the window
  const mw = ctxMenu.offsetWidth;
  const mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
});

document.addEventListener('click', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu();
});

function addMessage(role: 'user' | 'agent', content: string, image?: PromptImage | null, quote?: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (quote) {
    const q = document.createElement('div');
    q.className = 'msg-quote';
    q.textContent = quote;
    el.appendChild(q);
  }
  if (image) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = `data:${image.mimeType};base64,${image.data}`;
    el.appendChild(img);
  }
  const body = document.createElement('div');
  body.innerHTML = role === 'agent' ? mdToHtml(content) : escapeHtml(content).replace(/\n/g, '<br>');
  el.appendChild(body);
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

// ---------- streaming ----------
function createThoughtBox() {
  const box = document.createElement('div');
  box.className = 'thought-box expanded';
  const header = document.createElement('div');
  header.className = 'thought-header';
  header.textContent = '💭 思考中…';
  header.onclick = () => box.classList.toggle('expanded');
  const body = document.createElement('div');
  body.className = 'thought-body';
  box.append(header, body);
  messagesEl.appendChild(box);
  currentThoughtBox = box;
  currentThoughtBody = body;
}

/** thinking finished (answer started or turn done): collapse the box */
function finishThoughtBox() {
  if (!currentThoughtBox) return;
  currentThoughtBox.classList.remove('expanded');
  const header = currentThoughtBox.querySelector('.thought-header');
  if (header) header.textContent = '💭 思考过程';
}

function showLoading() {
  removeLoading();
  loadingEl = document.createElement('div');
  loadingEl.className = 'msg agent loading';
  loadingEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  messagesEl.appendChild(loadingEl);
  scrollToBottom();
}

function removeLoading() {
  loadingEl?.remove();
  loadingEl = null;
}

window.kimi.onChunk((e) => {
  if (!currentSession || e.sessionId !== currentSession.sessionId) return;
  removeLoading();
  if (e.kind === 'thought') {
    if (!currentThoughtBody) createThoughtBox();
    currentThoughtBody!.textContent += e.text;
  } else {
    if (!currentAgentEl) {
      currentAgentText = '';
      currentAgentEl = addMessage('agent', '');
    }
    currentAgentText += e.text;
    currentAgentEl.innerHTML = mdToHtml(currentAgentText);
    currentAgentEl.classList.add('cursor-blink');
  }
  scrollToBottom();
});

// ---------- tool call status: one rolling line ----------
let toolLineEl: HTMLElement | null = null;
const toolStates = new Map<string, { title: string; status: string }>();

const STATUS_TEXT: Record<string, string> = {
  pending: '等待',
  in_progress: '进行中',
  completed: '完成',
  failed: '失败',
};

function renderToolLine() {
  if (!toolLineEl) {
    toolLineEl = document.createElement('div');
    toolLineEl.className = 'msg tool';
  }
  const all = [...toolStates.values()];
  const active = all.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const done = all.length - active.length;
  const latestTitled = [...toolStates.values()].reverse().find((t) => t.title);
  toolLineEl.textContent =
    active.length > 0
      ? `⚙ ${latestTitled?.title || '工具调用'} · ${active.length > 1 ? `${active.length} 项进行中` : (STATUS_TEXT[active[active.length - 1].status] ?? '进行中')}${done > 0 ? `（已完成 ${done} 项）` : ''}`
      : `⚙ 工具调用完成（${done} 项）`;
  messagesEl.appendChild(toolLineEl); // re-append keeps it at the bottom
  scrollToBottom();
}

window.kimi.onToolCall((e) => {
  if (!currentSession || e.sessionId !== currentSession.sessionId) return;
  removeLoading();
  const prev = toolStates.get(e.toolCallId) ?? { title: '', status: '' };
  if (e.title) prev.title = e.title;
  if (e.status) prev.status = e.status;
  toolStates.set(e.toolCallId, prev);
  renderToolLine();
});

window.kimi.onTurnDone((e) => {
  if (!currentSession || e.sessionId !== currentSession.sessionId) return;
  removeLoading();
  finishThoughtBox();
  streaming = false;
  currentAgentEl?.classList.remove('cursor-blink');
  currentAgentEl = null;
  currentThoughtBox = null;
  currentThoughtBody = null;
  window.kimi.setBallState('idle');
  updateSendBtn();
  // update session title from first user message
  const firstUser = messagesEl.querySelector('.msg.user div');
  if (currentSession && !currentSession.title && firstUser?.textContent) {
    currentSession.title = firstUser.textContent.slice(0, 30);
    $('session-title').textContent = currentSession.title;
  }
  // auto-send the next queued message (unless the turn was stopped manually)
  if (e.stopReason !== 'cancelled' && queue.length > 0) {
    const next = queue.shift()!;
    renderQueueBar();
    void doSend(next);
  }
});

// ---------- permission ----------
window.kimi.onPermission((e) => {
  pendingPermissionId = e.requestId;
  $('permission-text').textContent = `${e.title}${e.description ? '：' + e.description : ''}`;
  $('permission-bar').classList.remove('hidden');
});

function resolvePermission(approved: boolean, remember: boolean) {
  if (!pendingPermissionId) return;
  window.kimi.respondPermission(pendingPermissionId, approved, remember, currentSession?.sessionId ?? '');
  pendingPermissionId = null;
  $('permission-bar').classList.add('hidden');
}
$('perm-allow').onclick = () => resolvePermission(true, false);
$('perm-always').onclick = () => resolvePermission(true, true);
$('perm-deny').onclick = () => resolvePermission(false, false);

// ---------- send / stop / queue ----------
async function ensureSession(): Promise<SessionMeta> {
  if (currentSession) return currentSession;
  currentSession = await window.kimi.newSession();
  sessions = await window.kimi.listSessions();
  renderSessionList();
  return currentSession;
}

interface QueuedMessage {
  text: string;
  image: PromptImage | null;
  quote: string | null;
}
const queue: QueuedMessage[] = [];

const SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>';

function updateSendBtn() {
  sendBtn.innerHTML = streaming ? STOP_SVG : SEND_SVG;
  sendBtn.title = streaming ? '停止' : '发送';
  inputEl.placeholder = streaming ? '回复中… 输入后回车可排队' : '问点什么…';
}

function renderQueueBar() {
  const bar = $('queue-bar');
  bar.innerHTML = '';
  bar.classList.toggle('hidden', queue.length === 0);
  queue.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    const label = document.createElement('span');
    label.className = 'q-label';
    label.textContent = q.text || (q.image ? '[图片]' : '[引用]');
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = '移出队列';
    rm.onclick = () => {
      queue.splice(i, 1);
      renderQueueBar();
    };
    item.append(label, rm);
    bar.appendChild(item);
  });
}

async function doSend(msg: QueuedMessage) {
  const session = await ensureSession();
  addMessage('user', msg.text, msg.image, msg.quote);
  scrollToBottom(true); // user's own message always snaps to bottom
  streaming = true;
  updateSendBtn();
  currentAgentEl = null;
  finishThoughtBox();
  currentThoughtBox = null;
  currentThoughtBody = null;
  toolStates.clear();
  toolLineEl = null;
  window.kimi.setBallState('thinking');
  showLoading();
  const promptText = msg.quote ? `> ${msg.quote.split('\n').join('\n> ')}\n\n${msg.text}` : msg.text;
  try {
    await window.kimi.prompt(session.sessionId, promptText, activeModeId, msg.image);
  } catch (err) {
    removeLoading();
    addMessage('agent', `⚠ 出错了：${String(err)}`);
    streaming = false;
    updateSendBtn();
    window.kimi.setBallState('idle');
  }
}

function send() {
  const text = inputEl.value.trim();
  if (!text && !pendingImage) return;
  const msg: QueuedMessage = { text, image: pendingImage, quote: pendingQuote };
  inputEl.value = '';
  autoGrow();
  clearAttach();
  clearQuote();
  if (streaming) {
    queue.push(msg);
    renderQueueBar();
    return;
  }
  void doSend(msg);
}

function stopStreaming() {
  if (currentSession) void window.kimi.cancel(currentSession.sessionId);
}

sendBtn.onclick = () => (streaming ? stopStreaming() : send());
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!streaming) send();
    else if (inputEl.value.trim() || pendingImage) send();
  }
});

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
}
inputEl.addEventListener('input', autoGrow);

// ---------- capture / attach ----------
function setAttach(img: PromptImage) {
  pendingImage = img;
  ($('attach-img') as HTMLImageElement).src = `data:${img.mimeType};base64,${img.data}`;
  $('attach-preview').classList.remove('hidden');
}
function clearAttach() {
  pendingImage = null;
  $('attach-preview').classList.add('hidden');
}

// ---------- quote (hangs above the input like the attach card) ----------
let pendingQuote: string | null = null;
function setQuote(text: string) {
  pendingQuote = text;
  $('quote-text').textContent = text;
  $('quote-preview').classList.remove('hidden');
}
function clearQuote() {
  pendingQuote = null;
  $('quote-preview').classList.add('hidden');
}
$('quote-remove').onclick = clearQuote;
$('btn-capture').onclick = async () => {
  const img = await window.kimi.captureRegion();
  if (img) setAttach(img);
};
$('attach-remove').onclick = clearAttach;
window.kimi.onImagePasted((img) => {
  setAttach(img);
  inputEl.focus();
});

// paste images straight from the clipboard (e.g. screenshots from other apps)
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const comma = dataUrl.indexOf(',');
      const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
      setAttach({ data: dataUrl.slice(comma + 1), mimeType });
      inputEl.focus();
    };
    reader.readAsDataURL(file);
    return;
  }
});

// ---------- mode bar ----------
function renderModeBar() {
  const bar = $('mode-bar');
  bar.innerHTML = '';
  const chatChip = document.createElement('button');
  chatChip.className = 'mode-chip' + (activeModeId === null ? ' active' : '');
  chatChip.textContent = '💬 对话';
  chatChip.onclick = () => { activeModeId = null; renderModeBar(); inputEl.focus(); };
  bar.appendChild(chatChip);
  for (const m of modes) {
    const chip = document.createElement('button');
    chip.className = 'mode-chip' + (activeModeId === m.id ? ' active' : '');
    chip.textContent = `${m.icon} ${m.name}`;
    chip.onclick = () => { activeModeId = m.id; renderModeBar(); inputEl.focus(); };
    bar.appendChild(chip);
  }
}

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

function renderSessionList() {
  const list = $('session-list');
  list.innerHTML = '';
  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty-hint">还没有会话<br />直接在下方输入，开始第一段对话吧</div>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (currentSession?.sessionId === s.sessionId ? ' active' : '');
    item.innerHTML = `<div class="s-title"></div><div class="s-time">${new Date(s.updatedAt).toLocaleString()}</div>`;
    item.querySelector('.s-title')!.textContent = s.title || '未命名会话';
    item.onclick = () => void switchSession(s.sessionId);
    list.appendChild(item);
  }
}

async function switchSession(sessionId: string) {
  messagesEl.innerHTML = '';
  const { meta, history } = await window.kimi.loadSession(sessionId);
  currentSession = meta;
  for (const item of history) {
    addMessage(item.role, item.text);
  }
  scrollToBottom(true);
  $('session-title').textContent = currentSession.title || '会话';
  document.querySelector('.panel:not(.hidden)')?.classList.add('hidden');
  inputEl.focus();
}

$('btn-new').onclick = async () => {
  messagesEl.innerHTML = '';
  currentSession = await window.kimi.newSession();
  $('session-title').textContent = '新会话';
  sessions = await window.kimi.listSessions();
  inputEl.focus();
};

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
      renderModeBar();
    });
    card.querySelector('.m-del')?.addEventListener('click', async () => {
      modes = await window.kimi.deleteMode(m.id);
      if (activeModeId === m.id) activeModeId = null;
      renderModesEditor();
      renderModeBar();
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
  renderModeBar();
};

// ---------- window controls ----------
$('btn-close').onclick = () => window.kimi.hideChat();
$('btn-workbench').onclick = () => window.kimi.toggleHome();
window.kimi.onOpenChat(() => inputEl.focus());
window.kimi.onLoadSession((sessionId) => void switchSession(sessionId));

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
  renderModeBar();
  sessions = await window.kimi.listSessions();
  // resume most recent session if any
  if (sessions.length > 0) {
    await switchSession(sessions[0].sessionId);
  }
})();
