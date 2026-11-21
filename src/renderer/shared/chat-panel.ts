/// <reference path="../api.d.ts" />
import type { OpenSessionResult, PresetMode, PromptImage, SessionMeta } from '../../shared/types';

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

// ---------- public interface ----------

export interface ChatPanelOpts {
  getSessionId(): string;              // 当前绑定 session
  onSwitchSession?: (sid: string) => void;  // 允许切会话(悬浮窗用)
  /** panel 需要宿主同步会话标题时回调(悬浮窗 topbar);channel 页可不传 */
  onTitleChange?: (title: string) => void;
  windowControls?: boolean;            // pin/close/theme 按钮,悬浮窗=true(当前由宿主 topbar 渲染,保留字段)
  /**
   * 统一会话入口(channel 页用,design/design-v7.md §3.2):提供时 setSession 改走它,
   * history 渲染回放 / live 补放缓冲区后挂实时流 / stale 丢弃;
   * 不提供时保持 loadSession 默认路径(悬浮窗行为不变)。
   */
  openSession?: (sid: string) => Promise<OpenSessionResult>;
}

export interface ChatPanelHandle {
  setSession(sid: string): Promise<void>;
  /** 新建空会话并绑定(悬浮窗「新建会话」按钮:立即创建,不做 loadSession 回放) */
  newSession(): Promise<void>;
  /** 宿主编辑预设模式后调用,重新拉取并刷新模式 chips */
  reloadModes(): Promise<void>;
  destroy(): void;
}

/**
 * 可复用对话面板:消息列表、输入区、模式 chips、权限条、流式渲染、截图/粘贴。
 * 浮层 panel(sessions/vault/settings)与窗口控制由宿主负责;
 * 宿主通过 setSession/newSession 驱动会话切换,工厂经 onSwitchSession/onTitleChange 回告。
 */
export function createChatPanel(container: HTMLElement, opts: ChatPanelOpts): ChatPanelHandle {
  let destroyed = false;

  // ---------- dom ----------
  container.innerHTML = `
    <div class="kp-root">
      <div class="kp-messages"></div>
      <div class="kp-mode-bar">
        <div class="kp-perm-mode">
          <button class="kp-menu-btn kp-perm-mode-btn" data-mode="default">
            <span class="kp-perm-dot"></span><span class="kp-perm-mode-name">常规</span>
          </button>
        </div>
        <div class="kp-preset-mode">
          <button class="kp-menu-btn kp-preset-btn">💬 对话</button>
        </div>
        <div class="kp-model-mode">
          <button class="kp-menu-btn kp-model-btn">模型</button>
        </div>
        <div class="kp-mode-spacer"></div>
      </div>
      <div class="kp-attach-preview hidden">
        <div class="kp-attach-list"></div>
      </div>
      <div class="kp-queue-bar hidden"></div>
      <div class="kp-quote-preview hidden">
        <div class="kp-quote-text"></div>
        <button class="kp-quote-remove">×</button>
      </div>
      <div class="kp-input-area">
        <div class="kp-input-shell">
          <button class="kp-btn-capture icon-btn" title="截图">
            <svg viewBox="0 0 24 24"><path d="M7 3v12a2 2 0 0 0 2 2h12"/><path d="M3 7h12a2 2 0 0 1 2 2v12"/></svg>
          </button>
          <textarea class="kp-input" rows="1" placeholder="问点什么…"></textarea>
          <button class="kp-btn-send" title="发送">
            <svg viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>
          </button>
        </div>
      </div>
      <div class="kp-permission-bar hidden">
        <div class="kp-permission-text"></div>
        <div class="kp-perm-actions"></div>
      </div>
    </div>`;

  const root = container.querySelector('.kp-root') as HTMLElement;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const messagesEl = $('.kp-messages');
  const inputEl = $('.kp-input') as unknown as HTMLTextAreaElement;
  const sendBtn = $('.kp-btn-send') as unknown as HTMLButtonElement;

  // ---------- state ----------
  let currentSession: SessionMeta | null = null;
  let modes: PresetMode[] = [];
  let activeModeId: string | null = null;
  let pendingImages: PromptImage[] = []; // 待发送附件(上限 MAX_IMAGES)
  const MAX_IMAGES = 10;
  // 输入草稿按 session 绑定:切 session 时存旧的、恢复新的,防止带草稿误发到别的 session
  const drafts = new Map<string, { text: string; images: PromptImage[]; quote: string | null }>();
  let streaming = false;
  let currentAgentEl: HTMLElement | null = null;
  let currentAgentText = '';
  let currentThoughtBox: HTMLElement | null = null;
  let currentThoughtBody: HTMLElement | null = null;
  let pendingPermissionId: string | null = null;
  let loadingEl: HTMLElement | null = null;
  // 本面板刚发出的用户消息文本：主进程会把它以 kind:'user' 的 chunk 回投，
  // 匹配则跳过并清除标记，避免自己发的消息显示两遍
  let lastSentText: string | null = null;

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

  // links inside agent messages open in the system browser; images open the lightbox
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
      openLightbox(img.src);
    }
  });

  // ---------- lightbox(消息图片/附件缩略图共用;遮罩点击/Esc 关闭) ----------
  let lightboxEl: HTMLElement | null = null;

  function openLightbox(src: string) {
    closeLightbox();
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'kp-lightbox';
    const img = document.createElement('img');
    img.src = src;
    const close = document.createElement('button');
    close.className = 'kp-lightbox-close';
    close.textContent = '×';
    close.title = '关闭';
    close.onclick = (e) => {
      e.stopPropagation();
      closeLightbox();
    };
    lightboxEl.append(img, close);
    lightboxEl.onclick = (e) => {
      if (e.target === lightboxEl) closeLightbox(); // 点遮罩关闭,点图片不关
    };
    document.body.appendChild(lightboxEl);
  }

  function closeLightbox() {
    lightboxEl?.remove();
    lightboxEl = null;
  }

  // ---------- context menu: copy / quote ----------
  let ctxMenu: HTMLElement | null = null;

  function closeCtxMenu() {
    // remove any stale menu (the host may have opened one too — only one lives at a time)
    document.querySelector('.kp-ctx-menu')?.remove();
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
    ctxMenu.className = 'kp-ctx-menu';
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

  const onDocClick = (e: MouseEvent) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
    // 弹出菜单(权限/预设/模型):点击菜单/触发按钮以外的地方关闭
    const t = e.target as Node;
    if (popupMenuEl && !popupMenuEl.contains(t) && !(t instanceof HTMLElement && popupAnchor?.contains(t))) {
      closePopupMenu();
    }
  };
  const onDocKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeCtxMenu();
      closePopupMenu();
      closeLightbox();
    }
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);

  function addMessage(role: 'user' | 'agent', content: string, images?: PromptImage[], quote?: string | null): HTMLElement {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (quote) {
      const q = document.createElement('div');
      q.className = 'msg-quote';
      q.textContent = quote;
      el.appendChild(q);
    }
    for (const image of images ?? []) {
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
    if (destroyed || !currentSession || e.sessionId !== currentSession.sessionId) return;
    removeLoading();
    if (e.kind === 'user') {
      // 其他界面发出的用户消息 → 渲染为用户气泡（本面板刚发的去重跳过）
      if (lastSentText !== null && e.text === lastSentText) {
        lastSentText = null;
        return;
      }
      addMessage('user', e.text);
      scrollToBottom();
      return;
    }
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
    if (destroyed || !currentSession || e.sessionId !== currentSession.sessionId) return;
    removeLoading();
    const prev = toolStates.get(e.toolCallId) ?? { title: '', status: '' };
    if (e.title) prev.title = e.title;
    if (e.status) prev.status = e.status;
    toolStates.set(e.toolCallId, prev);
    renderToolLine();
  });

  // ---------- TTS 播报（悬浮窗普通会话；主会话由 workbench voice.ts 统一播报） ----------
  async function speakReply(sessionId: string, text: string): Promise<void> {
    if (!text) return;
    try {
      const s = await window.kimi.getSettings();
      if (s.ttsEnabled === false || s.ttsEnabledChat === false) return;
      // 主会话不在这里播报，避免和 voice.ts 双重播报
      if (s.mainSessionId && sessionId === s.mainSessionId) return;
      const lang = /[一-鿿]/.test(text) ? 'zh' : 'en';
      await window.kimi.ttsSpeak(text, lang).catch(() => undefined);
    } catch {
      // 设置读取失败则不播报
    }
  }

  window.kimi.onTurnDone((e) => {
    if (destroyed || !currentSession || e.sessionId !== currentSession.sessionId) return;
    if (directSendCancelPending) {
      directSendCancelPending = false;
      if (e.stopReason === 'cancelled') return; // 「直接发送」的 cancel:状态已被新一轮 doSend 接管,整条忽略
      // cancel 没产生 turn-done(turn 刚好自己结束):这是新一轮的正常结束,fall through 照常处理
    }
    removeLoading();
    finishThoughtBox();
    streaming = false;
    currentAgentEl?.classList.remove('cursor-blink');
    currentAgentEl = null;
    currentThoughtBox = null;
    currentThoughtBody = null;
    window.kimi.setBallState('idle');
    updateSendBtn();
    // TTS 播报本轮回复全文（门控：总开关 + 悬浮窗开关；主会话跳过）
    const replyText = currentAgentText.trim();
    currentAgentText = '';
    void speakReply(e.sessionId, replyText);
    // update session title from first user message
    const firstUser = messagesEl.querySelector('.msg.user div');
    if (currentSession && !currentSession.title && firstUser?.textContent) {
      currentSession.title = firstUser.textContent.slice(0, 30);
      opts.onTitleChange?.(currentSession.title);
    }
    // auto-send the next queued message (unless the turn was stopped manually)
    const queue = currentQueue();
    if (e.stopReason !== 'cancelled' && queue.length > 0) {
      const next = queue.shift()!;
      renderQueueBar();
      void doSend(next);
    }
  });

  // ---------- permission ----------
  // 只响应当前 session 的权限请求(channel 页多 panel 并存时互不串扰;悬浮窗单 panel 不受影响)
  window.kimi.onPermission((e) => {
    if (destroyed) return;
    const sid = currentSession?.sessionId ?? opts.getSessionId();
    if (e.sessionId && sid && e.sessionId !== sid) return;
    pendingPermissionId = e.requestId;
    const actions = $('.kp-perm-actions');
    actions.innerHTML = '';
    const mkBtn = (text: string, cls: string, onclick: () => void) => {
      const btn = document.createElement('button');
      btn.className = cls;
      btn.textContent = text;
      btn.onclick = onclick;
      return btn;
    };
    if (e.options && e.options.length > 0) {
      // 多选项问题(AskUserQuestion):description 是 JSON 放不下,截断展示,选项渲染为按钮
      const desc = e.description.length > 200 ? e.description.slice(0, 200) + '…' : e.description;
      $('.kp-permission-text').textContent = `${e.title}${desc ? '：' + desc : ''}`;
      for (const opt of e.options) {
        const cls = opt.kind.toLowerCase().includes('reject') ? 'btn-danger' : 'btn-ghost';
        actions.appendChild(mkBtn(opt.name, cls, () => resolvePermission(true, false, opt.optionId)));
      }
    } else {
      // 标准工具权限:允许 / 本会话允许 / 拒绝(原有路径零变化)
      $('.kp-permission-text').textContent = `${e.title}${e.description ? '：' + e.description : ''}`;
      actions.append(
        mkBtn('允许', 'btn-primary', () => resolvePermission(true, false)),
        mkBtn('本会话允许', 'btn-ghost', () => resolvePermission(true, true)),
        mkBtn('拒绝', 'btn-danger', () => resolvePermission(false, false)),
      );
    }
    $('.kp-permission-bar').classList.remove('hidden');
  });

  function resolvePermission(approved: boolean, remember: boolean, optionId?: string) {
    if (!pendingPermissionId) return;
    window.kimi.respondPermission(pendingPermissionId, approved, remember, currentSession?.sessionId ?? '', optionId);
    pendingPermissionId = null;
    $('.kp-permission-bar').classList.add('hidden');
  }

  // ---------- send / stop / queue ----------
  async function ensureSession(): Promise<SessionMeta> {
    if (currentSession) return currentSession;
    // 宿主已绑定会话(如 channel 页选中后)但本面板尚未加载 → 先加载
    const bound = opts.getSessionId();
    if (bound) {
      await setSession(bound);
      if (currentSession) return currentSession;
    }
    currentSession = await window.kimi.newSession();
    opts.onSwitchSession?.(currentSession.sessionId);
    void refreshPermMode();
    void refreshModel();
    void refreshThinking();
    return currentSession;
  }

  interface QueuedMessage {
    text: string;
    images: PromptImage[];
    quote: string | null;
  }
  // 按 sessionId 分队列:切 session 不串台,队列条只显示当前 session 的队列
  const queues = new Map<string, QueuedMessage[]>();
  function currentQueue(): QueuedMessage[] {
    const sid = boundSid();
    if (!sid) return [];
    let q = queues.get(sid);
    if (!q) {
      q = [];
      queues.set(sid, q);
    }
    return q;
  }
  // 「直接发送」置位:它触发的 cancel 会产生 turn-done(cancelled),
  // 该事件到来时状态已被新一轮 doSend 接管,整条忽略(不重置 streaming/不续发)
  let directSendCancelPending = false;

  const SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>';

  function updateSendBtn() {
    sendBtn.innerHTML = streaming ? STOP_SVG : SEND_SVG;
    sendBtn.title = streaming ? '停止' : '发送';
    inputEl.placeholder = streaming ? '回复中… 输入后回车可排队' : '问点什么…';
  }

  function renderQueueBar() {
    const bar = $('.kp-queue-bar');
    const queue = currentQueue();
    bar.innerHTML = '';
    bar.classList.toggle('hidden', queue.length === 0);
    queue.forEach((q, i) => {
      const item = document.createElement('div');
      item.className = 'queue-item';
      const label = document.createElement('span');
      label.className = 'q-label';
      label.textContent = q.text || (q.images.length > 0 ? (q.images.length > 1 ? `[图片×${q.images.length}]` : '[图片]') : '[引用]');
      const actions = document.createElement('span');
      actions.className = 'q-actions';
      const edit = document.createElement('button');
      edit.textContent = '✎';
      edit.title = '编辑(填回输入框)';
      edit.onclick = () => {
        queue.splice(i, 1);
        inputEl.value = q.text;
        autoGrow();
        if (q.images.length > 0) {
          pendingImages = [...q.images]; // 恢复整个附件数组
          renderAttach();
        }
        if (q.quote) setQuote(q.quote);
        renderQueueBar();
        inputEl.focus();
      };
      const sendNow = document.createElement('button');
      sendNow.textContent = '▶';
      sendNow.title = '直接发送(停止当前回复)';
      sendNow.onclick = () => {
        queue.splice(i, 1);
        renderQueueBar();
        void sendNowDirect(q);
      };
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = '移出队列';
      rm.onclick = () => {
        queue.splice(i, 1);
        renderQueueBar();
      };
      actions.append(edit, sendNow, rm);
      item.append(label, actions);
      bar.appendChild(item);
    });
  }

  /** 直接发送:停掉当前 turn(其 turn-done(cancelled) 由 directSendCancelPending 吞掉)并立即发该条 */
  async function sendNowDirect(msg: QueuedMessage): Promise<void> {
    if (streaming && currentSession) {
      directSendCancelPending = true; // 先置位再 cancel,防 turn-done 抢先到达
      try {
        await window.kimi.cancel(currentSession.sessionId);
      } catch {
        // 取消失效(turn 可能刚好结束)也继续发;flag 由下一个 turn-done 清掉
      }
    }
    await doSend(msg);
  }

  async function doSend(msg: QueuedMessage) {
    const session = await ensureSession();
    window.kimi.ttsStop(); // 发送新消息打断上一轮播报
    addMessage('user', msg.text, msg.images, msg.quote);
    lastSentText = msg.text; // 主进程回投的 kind:'user' chunk 据此去重
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
      await window.kimi.prompt(session.sessionId, promptText, activeModeId, msg.images.length > 0 ? msg.images : null);
    } catch (err) {
      removeLoading();
      lastSentText = null; // 发送失败没有回投，清掉去重标记
      addMessage('agent', `⚠ 出错了：${String(err)}`);
      streaming = false;
      updateSendBtn();
      window.kimi.setBallState('idle');
    }
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text && pendingImages.length === 0) return;
    const msg: QueuedMessage = { text, images: [...pendingImages], quote: pendingQuote };
    inputEl.value = '';
    autoGrow();
    clearAttach();
    clearQuote();
    if (streaming) {
      currentQueue().push(msg);
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
      else if (inputEl.value.trim() || pendingImages.length > 0) send();
    }
  });

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  }
  inputEl.addEventListener('input', autoGrow);

  // ---------- capture / attach (多图,上限 MAX_IMAGES) ----------
  function renderAttach() {
    const list = $('.kp-attach-list');
    list.innerHTML = '';
    $('.kp-attach-preview').classList.toggle('hidden', pendingImages.length === 0);
    pendingImages.forEach((img, i) => {
      const item = document.createElement('div');
      item.className = 'kp-attach-item';
      const el = document.createElement('img');
      el.src = `data:${img.mimeType};base64,${img.data}`;
      el.alt = 'screenshot';
      el.onclick = () => openLightbox(el.src); // 缩略图点击看大图(× 按钮是独立元素,不触发)
      const rm = document.createElement('button');
      rm.className = 'kp-attach-remove';
      rm.textContent = '×';
      rm.title = '移除';
      rm.onclick = () => {
        pendingImages.splice(i, 1);
        renderAttach();
      };
      item.append(el, rm);
      list.appendChild(item);
    });
  }

  /** 追加一张附件;到上限轻提示并忽略 */
  function addAttach(img: PromptImage) {
    if (pendingImages.length >= MAX_IMAGES) {
      flashNotice(`最多添加 ${MAX_IMAGES} 张图片`);
      return;
    }
    pendingImages.push(img);
    renderAttach();
  }

  function clearAttach() {
    pendingImages = [];
    renderAttach();
  }

  /** 轻提示(附件超限等):输入区上方短暂浮出,自动消失 */
  let flashEl: HTMLElement | null = null;
  let flashTimer: number | undefined;
  function flashNotice(text: string) {
    flashEl?.remove();
    flashEl = document.createElement('div');
    flashEl.className = 'kp-flash';
    flashEl.textContent = text;
    root.appendChild(flashEl);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashEl?.remove();
      flashEl = null;
    }, 1600);
  }

  // ---------- quote (hangs above the input like the attach card) ----------
  let pendingQuote: string | null = null;
  function setQuote(text: string) {
    pendingQuote = text;
    $('.kp-quote-text').textContent = text;
    $('.kp-quote-preview').classList.remove('hidden');
  }
  function clearQuote() {
    pendingQuote = null;
    $('.kp-quote-preview').classList.add('hidden');
  }
  ($('.kp-quote-remove') as unknown as HTMLButtonElement).onclick = clearQuote;
  ($('.kp-btn-capture') as unknown as HTMLButtonElement).onclick = async () => {
    const img = await window.kimi.captureRegion();
    if (img) addAttach(img);
  };
  window.kimi.onImagePasted((img) => {
    if (destroyed) return;
    addAttach(img); // 截图工具路径:追加,不替换
    inputEl.focus();
  });

  // paste images straight from the clipboard (e.g. screenshots from other apps)
  // 一次粘贴事件里的多个 image item 全部加入(到上限为止)
  const onDocPaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const comma = dataUrl.indexOf(',');
        const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';
        addAttach({ data: dataUrl.slice(comma + 1), mimeType });
        inputEl.focus();
      };
      reader.readAsDataURL(file);
    }
  };
  document.addEventListener('paste', onDocPaste);

  // ---------- 通用弹出菜单(向上展开;菜单外点击/Esc 关闭;同时只开一个) ----------
  interface PopupItem {
    id: string;
    label: string;
    dot?: boolean; // 色点(权限模式用,颜色按 data-mode 走 CSS)
    title?: string;
    header?: boolean; // 分组标题(不可点;含 header/sep 时菜单竖排)
    sep?: boolean; // 分隔线(不可点)
    active?: boolean; // 当前项高亮
    onPick?: (id: string) => void; // 覆盖菜单级 onPick(分段菜单各段独立处理)
  }
  let popupMenuEl: HTMLElement | null = null;
  let popupAnchor: HTMLElement | null = null;

  function closePopupMenu() {
    popupMenuEl?.remove();
    popupMenuEl = null;
    popupAnchor = null;
  }

  function togglePopupMenu(
    anchorWrap: HTMLElement,
    anchorBtn: HTMLElement,
    items: PopupItem[],
    onPick?: (id: string) => void,
  ) {
    if (popupMenuEl) {
      const same = popupAnchor === anchorBtn;
      closePopupMenu();
      if (same) return; // 点同一按钮 = 收起
    }
    popupMenuEl = document.createElement('div');
    popupMenuEl.className = 'kp-popup-menu';
    if (items.some((i) => i.header || i.sep)) popupMenuEl.classList.add('col'); // 分段菜单竖排
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'kp-popup-sep';
        popupMenuEl.appendChild(sep);
        continue;
      }
      if (item.header) {
        const h = document.createElement('div');
        h.className = 'kp-popup-header';
        h.textContent = item.label;
        popupMenuEl.appendChild(h);
        continue;
      }
      const el = document.createElement('button');
      el.className = 'kp-popup-item' + (item.active ? ' active' : '');
      el.dataset.mode = item.id;
      if (item.title) el.title = item.title;
      if (item.dot) {
        const d = document.createElement('span');
        d.className = 'kp-perm-dot';
        el.appendChild(d);
      }
      const name = document.createElement('span');
      name.textContent = item.label;
      el.appendChild(name);
      el.onclick = () => {
        closePopupMenu();
        (item.onPick ?? onPick)?.(item.id);
      };
      popupMenuEl.appendChild(el);
    }
    anchorWrap.appendChild(popupMenuEl);
    popupAnchor = anchorBtn;
    // 方向:默认向上展开;锚点上方空间不足(视口边缘检测)时改为向下
    const above = anchorWrap.getBoundingClientRect().top;
    popupMenuEl.classList.toggle('below', above < popupMenuEl.offsetHeight + 8);
  }

  /** 菜单开着且属于该按钮时同步高亮(activeIds = 各分段当前项 id 集合) */
  function syncPopupMenu(anchorBtn: HTMLElement, activeIds: (string | null)[]) {
    if (!popupMenuEl || popupAnchor !== anchorBtn) return;
    for (const item of popupMenuEl.querySelectorAll<HTMLElement>('.kp-popup-item')) {
      item.classList.toggle('active', activeIds.includes(item.dataset.mode ?? null));
    }
  }

  // ---------- 提示词预设(收拢为菜单按钮;激活行为与旧 chips 一致) ----------
  const presetWrap = $('.kp-preset-mode');
  const presetBtn = $('.kp-preset-btn') as unknown as HTMLButtonElement;

  function activePresetLabel(): string {
    if (activeModeId === null) return '💬 对话';
    const m = modes.find((m) => m.id === activeModeId);
    return m ? `${m.icon} ${m.name}` : '💬 对话';
  }

  function renderPresetBtn() {
    presetBtn.textContent = activePresetLabel();
    presetBtn.title = '提示词预设';
    syncPopupMenu(presetBtn, [activeModeId ?? '']);
  }

  presetBtn.onclick = () => {
    void (async () => {
      try {
        await reloadModes(); // 打开前拉最新列表(别用 init 快照;悬浮窗设置页/channel 外的改动也要能体现)
      } catch {
        /* 拉取失败则用现有快照 */
      }
      const items: PopupItem[] = [
        { id: '', label: '💬 对话', active: activeModeId === null },
        ...modes.map((m) => ({ id: m.id, label: `${m.icon} ${m.name}`, active: activeModeId === m.id })),
      ];
      togglePopupMenu(presetWrap, presetBtn, items, (id) => {
        activeModeId = id || null;
        renderPresetBtn();
        inputEl.focus();
      });
    })();
  };

  async function reloadModes(): Promise<void> {
    try {
      modes = await window.kimi.listModes();
    } catch {
      // 拉取失败保留现有快照(菜单打开前的实时刷新也走这里)
    }
    // 被删掉的激活模式回退到「对话」
    if (activeModeId && !modes.some((m) => m.id === activeModeId)) activeModeId = null;
    renderPresetBtn();
  }

  // ---------- permission mode switch(常规/Auto/YOLO/Plan,与提示词预设是两个概念) ----------
  type PermModeId = 'default' | 'auto' | 'yolo' | 'plan';
  const PERM_MODES: { id: PermModeId; label: string }[] = [
    { id: 'default', label: '常规' },
    { id: 'auto', label: 'Auto' },
    { id: 'yolo', label: 'YOLO' },
    { id: 'plan', label: 'Plan' },
  ];
  let permMode: PermModeId = 'default';
  let permModeSource: 'session' | 'global' = 'global';

  function boundSid(): string {
    return currentSession?.sessionId ?? opts.getSessionId();
  }
  function normalizePermMode(mode: string | null): PermModeId {
    return PERM_MODES.some((m) => m.id === mode) ? (mode as PermModeId) : 'default';
  }

  const permWrap = $('.kp-perm-mode');
  const permBtn = $('.kp-perm-mode-btn') as unknown as HTMLButtonElement;

  function renderPermMode() {
    const sid = boundSid();
    permBtn.classList.toggle('disabled', !sid); // 空态(无 session)置灰
    permBtn.dataset.mode = permMode;
    permBtn.title = !sid
      ? '先开始一段对话'
      : permModeSource === 'global'
        ? '权限模式:跟随全局设置(点击改为本会话覆盖)'
        : '权限模式:本会话覆盖';
    ($('.kp-perm-mode-name') as HTMLElement).textContent =
      PERM_MODES.find((m) => m.id === permMode)!.label;
    syncPopupMenu(permBtn, [permMode]);
  }

  permBtn.onclick = () => {
    if (!boundSid()) return; // 空态不弹
    void (async () => {
      await refreshPermMode(); // 打开前拉最新(权限模式可能在终端/别的窗口改过)
      togglePopupMenu(
        permWrap,
        permBtn,
        PERM_MODES.map((m) => ({ id: m.id, label: m.label, dot: true, active: permMode === m.id })),
        (id) => void setPermMode(id as PermModeId),
      );
    })();
  };

  async function setPermMode(mode: PermModeId): Promise<void> {
    const sid = boundSid();
    if (!sid) return;
    // 从非 yolo 切到 yolo 时确认一句:不再询问任何权限
    if (mode === 'yolo' && permMode !== 'yolo') {
      if (!window.confirm('该会话将不再询问任何权限，agent 可自动执行所有操作')) return;
    }
    await window.kimi.ch.setSessionMode(sid, mode);
    permMode = mode;
    permModeSource = 'session';
    renderPermMode();
  }

  /** setSession/newSession 后初始化;source==='global' 也照常显示对应模式 */
  async function refreshPermMode(): Promise<void> {
    const sid = boundSid();
    if (!sid) {
      renderPermMode();
      return;
    }
    try {
      const r = await window.kimi.ch.getSessionMode(sid);
      if (boundSid() !== sid || destroyed) return; // 等待期间已切走
      permMode = normalizePermMode(r.mode);
      permModeSource = r.source;
    } catch {
      permMode = 'default';
      permModeSource = 'global';
    }
    renderPermMode();
  }

  // 终端 TUI /yolo 等外部切换的同步事件(按 sessionId 过滤)
  window.kimi.onSessionMode((p) => {
    if (destroyed) return;
    const sid = boundSid();
    if (!sid || p.sessionId !== sid) return;
    if (p.modeId === null) {
      void refreshPermMode(); // 覆盖被清除,回退跟随全局
      return;
    }
    permMode = normalizePermMode(p.modeId);
    permModeSource = 'session';
    renderPermMode();
  });

  // ---------- 模型选择(菜单按钮;数据源为主进程缓存的 kimi 选项) ----------
  const modelWrap = $('.kp-model-mode');
  const modelBtn = $('.kp-model-btn') as unknown as HTMLButtonElement;
  let modelOptions: { value: string; name: string }[] = [];
  let sessionModel: string | null = null;
  let modelSource: 'session' | 'default' = 'default';

  function modelLabel(): string {
    if (!sessionModel) return '模型';
    return modelOptions.find((o) => o.value === sessionModel)?.name ?? sessionModel;
  }

  function renderModelBtn() {
    const sid = boundSid();
    modelBtn.classList.toggle('disabled', !sid); // 空态(无 session)置灰
    modelBtn.textContent = modelLabel();
    modelBtn.title = !sid
      ? '先开始一段对话'
      : modelSource === 'default'
        ? `模型:跟随默认(${modelLabel()})`
        : `模型:本会话指定(${modelLabel()})`;
    syncPopupMenu(modelBtn, combinedActiveIds());
  }

  /** 合并菜单两段各自的当前项 id(模型段 + 思考深度段) */
  function combinedActiveIds(): string[] {
    return [
      modelSource === 'session' ? (sessionModel ?? '') : '',
      thinkingSource === 'session' ? `t:${sessionThinking}` : 't:',
    ];
  }

  /** 合并菜单(参照 kimi TUI /model 面板):上段「模型」+ 分隔线 + 下段「思考深度」 */
  function modelMenuItems(): PopupItem[] {
    const thinkingActiveId = thinkingSource === 'session' ? `t:${sessionThinking}` : 't:';
    return [
      { id: '__h1', label: '模型', header: true },
      { id: '', label: '跟随默认', active: modelSource === 'default', onPick: () => void setModel('') },
      ...modelOptions.map((o) => ({
        id: o.value,
        label: o.name,
        active: modelSource === 'session' && sessionModel === o.value,
        onPick: (id: string) => void setModel(id),
      })),
      { id: '__sep', label: '', sep: true },
      { id: '__h2', label: '思考深度', header: true },
      { id: 't:', label: '跟随全局', active: thinkingSource === 'global', onPick: () => void setThinking('') },
      ...THINKING_LEVELS.map((t) => ({
        id: `t:${t.id}`,
        label: t.label,
        active: thinkingActiveId === `t:${t.id}`,
        onPick: () => void setThinking(t.id),
      })),
    ];
  }

  modelBtn.onclick = () => {
    if (!boundSid() || modelOptions.length === 0) return;
    void (async () => {
      await Promise.all([refreshModel(), refreshThinking()]); // 打开前两段都拉最新
      if (!boundSid()) return;
      togglePopupMenu(modelWrap, modelBtn, modelMenuItems());
    })();
  };

  async function setModel(value: string): Promise<void> {
    const sid = boundSid();
    if (!sid) return;
    await window.kimi.ch.setSessionModel(sid, value || null);
    await refreshModel(); // 回读生效值(跟随默认时拿到默认模型名)
  }

  async function refreshModel(): Promise<void> {
    if (modelOptions.length === 0) await refreshModelOptions(); // 选项缓存可能晚于面板初始化才就绪
    const sid = boundSid();
    if (!sid) {
      renderModelBtn();
      return;
    }
    try {
      const r = await window.kimi.ch.getSessionModel(sid);
      if (boundSid() !== sid || destroyed) return; // 等待期间已切走
      sessionModel = r.model;
      modelSource = r.source;
    } catch {
      sessionModel = null;
      modelSource = 'default';
    }
    renderModelBtn();
  }

  async function refreshModelOptions(): Promise<void> {
    try {
      modelOptions = await window.kimi.ch.modelOptions();
    } catch {
      modelOptions = [];
    }
    if (!destroyed) renderModelBtn();
  }

  // 外部(终端 TUI 等)切换模型的同步事件(按 sessionId 过滤)
  window.kimi.onSessionModel((p) => {
    if (destroyed) return;
    const sid = boundSid();
    if (!sid || p.sessionId !== sid) return;
    sessionModel = p.model;
    modelSource = 'session';
    renderModelBtn();
  });

  // ---------- 思考深度状态(合并进模型菜单下段;setThinking/refreshThinking/同步逻辑不变) ----------
  const THINKING_LEVELS = [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
  ];
  let sessionThinking: string | null = null;
  let thinkingSource: 'session' | 'global' = 'global';

  async function setThinking(value: string): Promise<void> {
    const sid = boundSid();
    if (!sid) return;
    await window.kimi.ch.setSessionThinking(sid, (value || null) as 'low' | 'high' | 'max' | null);
    await refreshThinking(); // 回读生效值(跟随全局时拿到全局值)
  }

  async function refreshThinking(): Promise<void> {
    const sid = boundSid();
    if (!sid) {
      renderModelBtn(); // 无独立按钮,只刷新合并菜单高亮
      return;
    }
    try {
      const r = await window.kimi.ch.getSessionThinking(sid);
      if (boundSid() !== sid || destroyed) return; // 等待期间已切走
      sessionThinking = r.thinking;
      thinkingSource = r.source;
    } catch {
      sessionThinking = null;
      thinkingSource = 'global';
    }
    renderModelBtn();
  }

  // 外部切换思考深度的同步事件(按 sessionId 过滤)
  window.kimi.onSessionThinking((p) => {
    if (destroyed) return;
    const sid = boundSid();
    if (!sid || p.sessionId !== sid) return;
    sessionThinking = p.thinking;
    thinkingSource = 'session';
    renderModelBtn();
  });

  // ---------- 输入草稿 per-session(切换时现读输入区再存,发送/清附件无需同步) ----------
  function saveDraft() {
    const sid = currentSession?.sessionId;
    if (!sid) return;
    drafts.set(sid, { text: inputEl.value, images: [...pendingImages], quote: pendingQuote });
  }

  function restoreDraft(sid: string) {
    const d = drafts.get(sid);
    inputEl.value = d?.text ?? '';
    autoGrow();
    pendingImages = d ? [...d.images] : [];
    renderAttach();
    if (d?.quote) setQuote(d.quote);
    else clearQuote();
  }

  // ---------- session switching ----------
  async function setSession(sessionId: string): Promise<void> {
    window.kimi.ttsStop(); // 切换会话打断播报
    saveDraft(); // 先把当前输入区存入旧 session 的草稿
    messagesEl.innerHTML = '';
    if (opts.openSession) {
      await setSessionViaOpenSession(sessionId);
      return;
    }
    const { meta, history, live } = await window.kimi.loadSession(sessionId);
    if (destroyed) return;
    currentSession = meta;
    directSendCancelPending = false;
    restoreDraft(sessionId); // 恢复新 session 的草稿(无则清空)
    for (const item of history) {
      addMessage(item.role, item.text);
    }
    if (live) {
      // session is mid-turn (e.g. a task session just launched) — don't replay,
      // stream what's coming; a hint marks the seam
      const hint = document.createElement('div');
      hint.className = 'msg tool';
      hint.textContent = '⏵ 任务正在执行中，输出将实时显示…';
      messagesEl.appendChild(hint);
      window.kimi.setBallState('thinking');
    }
    // streaming 跟随被切到 session 的忙闲(per-session 队列的前提:切到空闲 session 必须可直发)
    streaming = !!live;
    updateSendBtn();
    renderQueueBar(); // 队列条切换为当前 session 的队列
    scrollToBottom(true);
    opts.onTitleChange?.(currentSession.title || '会话');
    opts.onSwitchSession?.(sessionId);
    void refreshPermMode();
    void refreshModel();
    void refreshThinking();
    inputEl.focus();
  }

  /**
   * channel 页统一入口路径(design/design-v7.md §3.2,永不 load 忙中 session):
   * history → 回放;live → 补放主进程 turn 缓冲区后挂实时流;stale → 令牌过期,丢弃。
   * openSession 不返回 meta,这里构造最小 SessionMeta(标题由宿主头部展示,
   * 首轮结束后仍会从首条用户消息推导标题并经 onTitleChange 回告)。
   */
  async function setSessionViaOpenSession(sessionId: string): Promise<void> {
    const result = await opts.openSession!(sessionId);
    if (destroyed || result.mode === 'stale') return;
    currentSession = { sessionId, cwd: '', title: '', createdAt: 0, updatedAt: 0 };
    directSendCancelPending = false;
    restoreDraft(sessionId); // 恢复新 session 的草稿(无则清空)
    if (result.mode === 'history') {
      for (const item of result.messages) {
        addMessage(item.role, item.text);
      }
    } else {
      // live: 补放缓冲区已发内容,后续 chunk 经 onChunk 续流到同一气泡
      const hint = document.createElement('div');
      hint.className = 'msg tool';
      hint.textContent = '⏵ 任务正在执行中，输出将实时显示…';
      messagesEl.appendChild(hint);
      const bufferedText = result.buffered.join('');
      if (bufferedText) {
        currentAgentText = bufferedText;
        currentAgentEl = addMessage('agent', bufferedText);
        currentAgentEl.classList.add('cursor-blink');
      }
      window.kimi.setBallState('thinking');
    }
    streaming = result.mode === 'live';
    updateSendBtn();
    renderQueueBar(); // 队列条切换为当前 session 的队列
    scrollToBottom(true);
    opts.onSwitchSession?.(sessionId);
    void refreshPermMode();
    void refreshModel();
    void refreshThinking();
    inputEl.focus();
  }

  async function newSession(): Promise<void> {
    window.kimi.ttsStop(); // 新会话打断播报
    saveDraft(); // 旧 session 草稿先存
    messagesEl.innerHTML = '';
    currentSession = await window.kimi.newSession();
    directSendCancelPending = false;
    restoreDraft(currentSession.sessionId); // 新会话无草稿 → 清空输入区
    streaming = false;
    updateSendBtn();
    renderQueueBar();
    opts.onTitleChange?.('新会话');
    opts.onSwitchSession?.(currentSession.sessionId);
    void refreshPermMode();
    void refreshModel();
    void refreshThinking();
    inputEl.focus();
  }

  // 悬浮窗打开时聚焦输入框(仅悬浮窗会收到该事件;channel 页无害)
  window.kimi.onOpenChat(() => {
    if (!destroyed) inputEl.focus();
  });

  // ---------- init ----------
  void reloadModes();
  void refreshPermMode(); // 空态置灰;宿主已预绑定 session(channel 页)则直接初始化
  void refreshModelOptions();
  void refreshModel();
  void refreshThinking();

  return {
    setSession,
    newSession,
    reloadModes,
    destroy() {
      destroyed = true;
      window.clearTimeout(flashTimer);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKeydown);
      document.removeEventListener('paste', onDocPaste);
      closeCtxMenu();
      closePopupMenu();
      closeLightbox();
      root.remove();
    },
  };
}
