/**
 * Zen 模式页（V4-B 视觉重做，Apple Intelligence 参考）：纯黑底 + 中央多彩柔光
 * orb（pages/orb.ts blob 样式：粉/蓝/紫/青渐变漂移，无硬边）+ mono 状态字。
 * 屏幕四周一圈模糊渐变光带（粉顶部→蓝紫两侧，缓慢呼吸；streaming/TTS 时增强，
 * 见 style.css .zen-glow）。
 *
 * 与主页是同一个 agent 会话：监听 onChunk/onTurnDone（过滤 getSettings().mainSessionId，
 * 为 null 时不滤），监听只在本模块 init 时绑一次——消息框隐藏时聊天流不中断，
 * 条目照常入列，打开即见完整记录。输入发送不再自动展开消息框，只由菜单手动开关。
 *
 * TTS 说明：播报由 core/voice.ts 统一接管（主会话 turnDone 时 ttsSpeak 全文）；
 * speaking 光晕窗口按回复长度估算（≈75ms/字，2s–30s），新 chunk 到来即提前结束。
 * 节奏字幕条：thinking 期间底部「正在思考」跳点；speaking 期间回复按句拆分、
 * 按同一 75ms/字 节奏逐句点亮上滚，结束后 800ms 淡出（#zen-caption）。
 */

import { createOrb, type OrbState } from './orb';
import { activatePage } from '../core/nav';
import { getWidget } from '../core/registry';
import { markLocalSend, rotateMainSession, subscribe, type MainLogEntry } from '../core/main-log';
import { askWithVision } from '../core/vision-store';

const ZEN_ORB_SIZE = 460;

// ---------- Zen 浮层（模块级统一管理：手动添加的组件与 presenter 渲染的卡片都在此登记，dismiss 可统一匹配） ----------
interface ZenFloatEntry {
  title: string;
  el: HTMLElement;
  at: number;
}
const zenFloats: ZenFloatEntry[] = [];

export interface ZenFloatHandle {
  el: HTMLElement;
  /** 更新标题（如等待态「生成中」→ 正式标题），同步 dismiss 匹配用的登记 */
  setTitle(title: string): void;
  close(): void;
}

function floatCtx(widgetId: string) {
  return {
    instanceId: `zen-${widgetId}-${Date.now().toString(36)}`,
    config: {},
    setConfig: () => undefined,
    bus: { on: () => () => undefined, emit: () => undefined } as never,
    api: window.kimi.wb,
    requestMinimize: () => undefined,
    requestClose: () => undefined,
  };
}

export function mountZenFloat(title: string, mount: (body: HTMLElement) => void): ZenFloatHandle {
  const page = document.getElementById('page-zen');
  if (!page) throw new Error('missing element #page-zen');
  const el = document.createElement('div');
  el.className = 'zen-float';
  const head = document.createElement('div');
  head.className = 'zen-float-head';
  const label = document.createElement('span');
  label.textContent = title;
  const entry: ZenFloatEntry = { title, el, at: Date.now() };
  zenFloats.push(entry);
  const close = () => {
    el.remove();
    const i = zenFloats.indexOf(entry);
    if (i >= 0) zenFloats.splice(i, 1);
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.onclick = close;
  head.append(label, closeBtn);
  const body = document.createElement('div');
  body.className = 'zen-float-body';
  el.append(head, body);
  // 拖拽移动（相对 zen 页）
  let drag: { dx: number; dy: number } | null = null;
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    head.setPointerCapture(e.pointerId);
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    el.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
    el.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });
  head.addEventListener('pointerup', () => (drag = null));
  // 右下角拖拽调整尺寸
  const resize = document.createElement('div');
  resize.className = 'zen-float-resize';
  el.appendChild(resize);
  let rs: { x: number; y: number; w: number; h: number } | null = null;
  resize.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resize.setPointerCapture(e.pointerId);
    rs = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
  });
  resize.addEventListener('pointermove', (e) => {
    if (!rs) return;
    el.style.width = `${Math.max(220, rs.w + e.clientX - rs.x)}px`;
    el.style.height = `${Math.max(160, rs.h + e.clientY - rs.y)}px`;
    el.style.maxHeight = 'none';
  });
  resize.addEventListener('pointerup', () => (rs = null));
  page.appendChild(el);
  mount(body);
  return {
    el,
    setTitle: (t) => {
      label.textContent = t;
      entry.title = t;
    },
    close,
  };
}

/** 内置 widget 挂 Zen 浮层；id 不存在返回 false */
export function mountZenWidget(widgetId: string): boolean {
  const w = getWidget(widgetId);
  if (!w) return false;
  mountZenFloat(w.def.name, (body) => w.mount(body, floatCtx(widgetId)));
  return true;
}

/** 按标题模糊匹配关闭浮层（'latest' 关最近挂载的）；返回被关标题，没找到返回 null */
export function dismissZenFloat(target: string): string | null {
  // 清掉已从 DOM 移除的登记
  for (let i = zenFloats.length - 1; i >= 0; i--) {
    if (!zenFloats[i].el.isConnected) zenFloats.splice(i, 1);
  }
  if (zenFloats.length === 0) return null;
  const q = target.trim().toLowerCase();
  let entry: ZenFloatEntry | undefined;
  if (q === '' || q === 'latest') {
    entry = zenFloats[zenFloats.length - 1];
  } else {
    // 反向查找：同名时优先关最近挂载的
    entry = [...zenFloats].reverse().find((f) => f.title.toLowerCase().includes(q));
  }
  if (!entry) return null;
  const closedTitle = entry.title;
  entry.el.remove();
  zenFloats.splice(zenFloats.indexOf(entry), 1);
  return closedTitle;
}

export function initZenPage(): void {
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  const page = $('page-zen');
  const stopBtn = $('zen-stop') as unknown as HTMLButtonElement;
  const orb = createOrb($('zen-orb') as unknown as HTMLCanvasElement, ZEN_ORB_SIZE, 'blob');
  const statusEl = $('zen-status');
  const STATUS_TEXT: Record<OrbState, string> = {
    ready: 'READY…',
    thinking: 'THINKING…',
    speaking: 'SPEAKING…',
  };

  // ---------- 主会话状态（streaming / speaking → 边缘光晕 + orb 三态） ----------
  let mainSid: string | null = null;
  void window.kimi
    .getSettings()
    .then((s) => {
      mainSid = s.mainSessionId ?? null;
    })
    .catch(() => undefined);
  // 主会话轮换时主进程推送新 id（防缓存过期导致消息被过滤）
  window.kimi.onMainSession((p) => {
    mainSid = p.sessionId;
  });
  const isMain = (sid: string): boolean => mainSid == null || sid === mainSid;

  let streaming = false;
  let lastChunkLen = 0;
  let speakingUntil = 0;
  let speakTimer: ReturnType<typeof setTimeout> | null = null;

  function refresh(): void {
    const speaking = Date.now() < speakingUntil;
    page.classList.toggle('zen-active', streaming || speaking);
    const st: OrbState = speaking ? 'speaking' : streaming ? 'thinking' : 'ready';
    orb.setState(st);
    statusEl.textContent = STATUS_TEXT[st];
    stopBtn.hidden = !streaming;
  }

  // ---------- 消息框（数据源：core/main-log.ts 共享记录，与主页同一份） ----------
  const chatPanel = $('zen-chat');
  const chatList = $('zen-chat-list');

  function pad2(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
  }

  function scrollChat(): void {
    chatList.scrollTop = chatList.scrollHeight;
  }

  function renderLog(logEntries: MainLogEntry[]): void {
    chatList.innerHTML = '';
    for (const item of logEntries) {
      const entry = document.createElement('div');
      entry.className = 'zen-chat-entry';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const n = new Date(item.at);
      meta.textContent = `[${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}] ${item.role === 'you' ? 'YOU' : 'KIMI'} ›`;
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = item.text;
      entry.append(meta, body);
      chatList.appendChild(entry);
    }
    scrollChat();
  }

  subscribe(renderLog);

  // ---------- TTS 节奏字幕条（#zen-caption，动态挂载，index.html 不动） ----------
  const caption = document.createElement('div');
  caption.id = 'zen-caption';
  caption.hidden = true;
  page.appendChild(caption);

  let replyBuf = '';
  let captionTimers: Array<ReturnType<typeof setTimeout>> = [];

  function clearCaptionTimers(): void {
    for (const t of captionTimers) clearTimeout(t);
    captionTimers = [];
  }

  function hideCaption(): void {
    caption.hidden = true;
    caption.classList.remove('zen-caption-out');
    caption.innerHTML = '';
  }

  function showThinkingCaption(): void {
    clearCaptionTimers();
    caption.classList.remove('zen-caption-out');
    caption.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'zen-thinking';
    const label = document.createElement('span');
    label.textContent = '正在思考';
    box.appendChild(label);
    for (let i = 0; i < 3; i++) box.appendChild(document.createElement('i'));
    caption.appendChild(box);
    caption.hidden = false;
  }

  function splitSentences(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    for (const ch of text) {
      cur += ch;
      if ('。！？!?…\n'.includes(ch)) {
        const s = cur.trim();
        if (s) out.push(s);
        cur = '';
      }
    }
    const tail = cur.trim();
    if (tail) out.push(tail);
    return out;
  }

  // speaking 期间：按 75ms/字 估算节奏逐句点亮上滚；
  // 结束后停留展示（不自动消失），直到下一条消息/手动关闭/60s 超时
  function showSpeakCaption(text: string, totalMs: number): void {
    clearCaptionTimers();
    caption.classList.remove('zen-caption-out');
    caption.hidden = false;
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      hideCaption();
      return;
    }
    let charsBefore = 0;
    sentences.forEach((s, i) => {
      const at = Math.min(Math.max(0, totalMs - 600), charsBefore * 75);
      charsBefore += s.length;
      captionTimers.push(
        setTimeout(() => {
          caption.innerHTML = '';
          if (i > 0) {
            const prev = document.createElement('div');
            prev.className = 'prev';
            prev.textContent = sentences[i - 1];
            caption.appendChild(prev);
          }
          const curEl = document.createElement('div');
          curEl.className = 'cur';
          curEl.textContent = s;
          caption.appendChild(curEl);
        }, at),
      );
    });
    // 播完后停留 15s 再缓缓淡出（用户没听完也能看完）
    captionTimers.push(setTimeout(() => caption.classList.add('zen-caption-out'), totalMs + 15_000));
    captionTimers.push(setTimeout(hideCaption, totalMs + 15_000 + 1200));
  }

  window.kimi.onChunk((e) => {
    if (!isMain(e.sessionId)) return;
    if (e.kind === 'thought') {
      // 思考过程卡片：thinking 期间可见，回答开始即消失
      thoughtText += e.text;
      thoughtCard.textContent = thoughtText;
      thoughtCard.hidden = false;
      return;
    }
    if (e.kind !== 'text') return;
    thoughtText = '';
    thoughtCard.hidden = true;
    streaming = true;
    lastChunkLen += e.text.length;
    replyBuf += e.text;
    speakingUntil = 0;
    if (speakTimer) {
      clearTimeout(speakTimer);
      speakTimer = null;
    }
    // 新 chunk 打断上一轮字幕，回到 thinking 跳点（已是跳点则不重建）
    if (caption.hidden || !caption.querySelector('.zen-thinking')) showThinkingCaption();
    refresh();
  });

  window.kimi.onTurnDone((e) => {
    if (!isMain(e.sessionId)) return;
    thoughtText = '';
    thoughtCard.hidden = true;
    streaming = false;
    // TTS 播报窗口按本轮回复规模估算（见文件头说明）
    const ms = Math.min(30000, Math.max(2000, lastChunkLen * 75));
    const reply = replyBuf;
    replyBuf = '';
    lastChunkLen = 0;
    if (ms > 2000) {
      speakingUntil = Date.now() + ms;
      speakTimer = setTimeout(refresh, ms);
      showSpeakCaption(reply, ms);
    } else {
      hideCaption();
      clearCaptionTimers();
    }
    refresh();
  });

  // ---------- 右下角菜单 ----------
  const menuBtn = $('zen-menu-btn');
  const menu = $('zen-menu');
  const miChat = $('zen-mi-chat');

  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  menu.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', () => {
    menu.hidden = true;
  });

  miChat.addEventListener('click', () => {
    chatPanel.hidden = !chatPanel.hidden;
    miChat.textContent = chatPanel.hidden ? '显示消息框' : '隐藏消息框';
    if (!chatPanel.hidden) scrollChat();
    menu.hidden = true;
  });

  // ---------- thinking 开关（输入框右侧） ----------
  const thinkingToggle = $('zen-thinking-toggle') as unknown as HTMLButtonElement;
  let thinkingOn = true;
  void window.kimi.getSettings().then((s) => {
    thinkingOn = s.thinking !== false;
    thinkingToggle.classList.toggle('on', thinkingOn);
  });
  thinkingToggle.addEventListener('click', () => {
    thinkingOn = !thinkingOn;
    thinkingToggle.classList.toggle('on', thinkingOn);
    console.log('[zen] thinking toggle →', thinkingOn);
    void window.kimi.setThinking(thinkingOn);
  });

  // ---------- 思考过程卡片（thinking 期间可见，回答开始即消失） ----------
  const thoughtCard = $('zen-thought');
  let thoughtText = '';

  // ---------- 输入框（文字对话入口；mic 接入前的 voice 通道） ----------
  const input = $('zen-input') as unknown as HTMLInputElement;

  stopBtn.addEventListener('click', () => {
    if (mainSid) void window.kimi.cancel(mainSid);
    streaming = false;
    refresh();
  });

  // ---------- 权限请求卡片（agent 调工具需要确认时，也在 Zen 展示） ----------
  const permCard = document.createElement('div');
  permCard.id = 'zen-perm';
  permCard.hidden = true;
  page.appendChild(permCard);
  let pendingPermId: string | null = null;

  function resolvePerm(approved: boolean, remember: boolean): void {
    if (!pendingPermId) return;
    window.kimi.respondPermission(pendingPermId, approved, remember, mainSid ?? '');
    pendingPermId = null;
    permCard.hidden = true;
  }

  window.kimi.onPermission((req) => {
    pendingPermId = req.requestId;
    permCard.innerHTML = '';
    const text = document.createElement('div');
    text.className = 'zen-perm-text';
    text.textContent = `⚠ ${req.title}${req.description ? `：${req.description}` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'zen-perm-actions';
    const allow = document.createElement('button');
    allow.className = 'zen-perm-allow';
    allow.textContent = '允许';
    allow.onclick = () => resolvePerm(true, false);
    const always = document.createElement('button');
    always.textContent = '本会话允许';
    always.onclick = () => resolvePerm(true, true);
    const deny = document.createElement('button');
    deny.className = 'zen-perm-deny';
    deny.textContent = '拒绝';
    deny.onclick = () => resolvePerm(false, false);
    actions.append(allow, always, deny);
    permCard.append(text, actions);
    permCard.hidden = false;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // /new：开启新主会话
    if (text === '/new') {
      void rotateMainSession();
      return;
    }
    // 发送即进入 thinking 态（不自动展开消息框，由菜单手动开关）
    streaming = true;
    lastChunkLen = 0;
    replyBuf = '';
    showThinkingCaption();
    refresh();
    markLocalSend(text); // 本地消息立即上屏 + 主进程回投去重
    void askWithVision(text);
  });
  // ---------- 添加组件到 Zen（浮层小组件） ----------
  const picker = document.createElement('div');
  picker.id = 'zen-picker';
  picker.hidden = true;
  page.appendChild(picker);

  let pickerLoaded = false;
  async function renderPicker(): Promise<void> {
    picker.innerHTML = '<div class="zen-picker-title">添加组件到 Zen</div>';
    const { allWidgets } = await import('../core/registry');
    for (const w of allWidgets()) {
      if (w.def.id === 'artifact') continue;
      const btn = document.createElement('button');
      btn.textContent = `${w.def.icon} ${w.def.name}`;
      btn.onclick = () => {
        mountZenFloat(w.def.name, (body) => w.mount(body, floatCtx(w.def.id)));
        picker.hidden = true;
      };
      picker.appendChild(btn);
    }
    const lib = await window.kimi.wb.libraryList();
    for (const item of lib) {
      const btn = document.createElement('button');
      btn.textContent = `◈ ${item.title}`;
      btn.onclick = () => {
        mountZenFloat(item.title, (body) => {
          void import('../widgets/artifact').then((m) => m.mountArtifact(body, item.html));
        });
        picker.hidden = true;
      };
      picker.appendChild(btn);
    }
  }

  $('zen-mi-add').addEventListener('click', () => {
    menu.hidden = true;
    picker.hidden = !picker.hidden;
    if (!picker.hidden && !pickerLoaded) {
      pickerLoaded = true;
      void renderPicker();
    }
  });
  $('zen-mi-exit').addEventListener('click', () => {
    menu.hidden = true;
    activatePage('page-home');
  });
}
