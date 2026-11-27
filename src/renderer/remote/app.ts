/**
 * KIMI Remote — talking-to-the-moon 视觉移植版(P1)。
 * 视觉/交互骨架照搬 moon(#background/#stars/#moon-glow/#moon-container/顶栏/底栏/
 * result-card/toast/确认弹窗/历史浮层),后端换成我们的 REST + SSE(契约不变):
 * /api/tree /api/open-session /api/prompt /api/cancel
 * /api/permission-respond /api/tts,SSE /api/events?sid= + /api/events。
 * 新增(moon 没有、我们必须):底部抽屉式 session 切换器、权限审批卡、
 * busy(409)/held(423)提示、「重说」按钮、HTTPS 指引。
 * 2026-11-26:配对体系退役(LAN 内打开即用);导航改为底部 TabBar 四空间
 * (Chat/Moon/SA/Kiki),SA 灵动岛并入 tab 徽标。
 * 断线策略:SSE 指数退避 1s→2s→5s→15s,visibility/online 立即重连并重同步。
 */

import { escapeHtml, mdToHtml } from '../shared/md';
import { createChatPanel, type ChatPanelHandle } from '../shared/chat-panel';
import type { ChatHost } from '../shared/chat-backend';
import type { OpenSessionResult } from '../../shared/types';
import { createRemoteBackend, type RemoteSseEvent } from './backend-remote';
import { MoonRenderer, formatDate } from './moon';
import { BackgroundSwitcher } from './backgrounds';
import { SpeechRecognizer } from './speech';
import { AudioRecorder } from './recorder';

// ---------- 契约类型 ----------

interface RemoteSession {
  id: string;
  title: string;
  updatedAt: number;
  lastMessage: string;
  lastPrompt: string;
  pinned: boolean;
  busy: boolean;
  hasUpdate: boolean;
  agentId?: string;
}
interface RemoteProject {
  cwd: string;
  dirName: string;
  name?: string;
  sessions: RemoteSession[];
}
interface TreeData {
  projects: RemoteProject[];
}
interface PermOption {
  optionId: string;
  name: string;
  kind: string;
}

// ---------- api / 本地键 ----------

const DEVICE_KEY = 'kimi-remote-device';
const TTS_KEY = 'kimi-remote-tts';
const SESSION_KEY = 'kimi-remote-session';
// 配对体系已退役(2026-11-26 拍板):LAN 内打开即用,桥 auth() 对无 token 请求放行(lan-guest)

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch {
      /* keep */
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// ---------- dom ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectionStatus = $('connection-status');
const dateDisplay = $('date-display');
const phaseName = $('phase-name');
const phaseDetail = $('phase-detail');
const toast = $('toast');
const background = $('background');
const moonGlow = $('moon-glow');
const resultCard = $('result-card');
const resultScroll = $('result-scroll');
const resultText = $('result-text');
const resultExpand = $('result-expand');
const permCard = $('perm-card');
const tbLabel = $('tb-label');
/** 顶栏会话名:SA 屏固定「Super Agent」,其余屏随当前会话 */
function syncTbLabel(): void {
  tbLabel.textContent = space === 'sa' ? 'Super Agent' : currentSession ? sessLabel(currentSession) : '选择会话';
}
const sessionDrawer = $('session-drawer');
const drawerTree = $('drawer-tree');
const guideModal = $('guide-modal');
const toolLine = $('tool-line');
const chatView = $('chat-view');
const cvPanel = $('cv-panel');
const menuDrawer = $('menu-drawer');

// ---------- TabBar 平行空间(Chat / Moon / SA / Kiki;切换只显隐,状态保留) ----------

const SPACE_KEY = 'kimi-remote-space';
type Space = 'moon' | 'chat' | 'sa' | 'kiki';
let space: Space = (() => {
  const saved = localStorage.getItem(SPACE_KEY) ?? localStorage.getItem('kimi-remote-view-mode');
  return saved === 'chat' || saved === 'sa' || saved === 'kiki' ? saved : 'moon';
})();

function setSpace(next: Space): void {
  space = next;
  localStorage.setItem(SPACE_KEY, next);
  chatView.classList.toggle('on', next === 'chat');
  saView.classList.toggle('on', next === 'sa');
  $('kiki-view').classList.toggle('on', next === 'kiki');
  document.querySelectorAll('.tab-item').forEach((el) =>
    el.classList.toggle('on', (el as HTMLElement).dataset.space === next),
  );
  // 主输入只浮在 moon 上;chat 有工厂输入区,SA 有自己的面板
  $('main-input').hidden = next !== 'moon';
  $('topbar').hidden = next === 'kiki'; // 统一顶栏只服务 chat/moon/SA
  syncTbLabel(); // SA 屏固定「Super Agent」,其余屏随会话
  applyMoonInfo(); // moon 信息显隐只对 moon 空间生效
  if (next === 'chat') {
    syncPermCard();
    // display:none 时加载历史的 scrollToBottom 白滚;可见后强制滚底
    requestAnimationFrame(() => panel.notifyVisible());
  } else if (next === 'sa') {
    applySaSeg();
    void ensureSaSession();
    void refreshSaBoard();
  } else if (next === 'kiki') {
    void renderKiki();
  }
  if (next !== 'chat') syncPermCard(); // perm 卡片只在 moon 空间渲染(chat 走工厂权限条)
}

document.querySelectorAll('.tab-item').forEach((el) =>
  el.addEventListener('click', () => setSpace((el as HTMLElement).dataset.space as Space)),
);

// ---------- moon 主视觉 ----------

const moon = new MoonRenderer('moon-container');
const bgSwitcher = new BackgroundSwitcher(background);
const recognizer = new SpeechRecognizer();
const recorder = new AudioRecorder();

function updateDateAndPhase(): void {
  const today = formatDate(new Date());
  dateDisplay.textContent = today;
  const phase = moon.updateForDate(today);
  phaseName.textContent = phase.name;
  phaseDetail.textContent = `月龄 ${phase.age.toFixed(1)} 天 · 照亮 ${(phase.illumination * 100).toFixed(1)}%`;
  // Tab 月相图标:亮区比例 ≈ 照亮度(新月→满月亮区在右,满月→新月在左)
  const hidePct = ((1 - phase.illumination) * 100).toFixed(1);
  ($('tab-moon-lit') as HTMLElement).style.clipPath =
    phase.age < 14.7653 ? `inset(0 0 0 ${hidePct}%)` : `inset(0 ${hidePct}% 0 0)`;
}

let toastTimer = 0;
function showToast(message: string, ms = 4000): void {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
}

// 连接状态 = 顶栏小圆点(绿=已连接/琥珀脉冲=重连中),文字进 title;真断开才短暂 toast
let connWasConnected = false;
function setConnectionStatus(text: string): void {
  connectionStatus.textContent = '';
  connectionStatus.title = text;
  const ok = text === '已连接' || text === '思考中...'; // 思考中也是连着
  connectionStatus.classList.toggle('ok', ok);
  connectionStatus.classList.toggle('warn', !ok);
  if (!ok && connWasConnected) showToast('连接已断开，重连中…', 3000);
  connWasConnected = ok;
}

// ---------- result-card(moon 回复卡 + karaoke 滚动) ----------

let resultTimeout: ReturnType<typeof setTimeout> | null = null;
let expandedResult = false;
let scrollRaf = 0;

function setResultExpanded(expanded: boolean): void {
  expandedResult = expanded;
  resultCard.classList.toggle('expanded', expanded);
  resultScroll.classList.toggle('expanded', expanded);
  resultExpand.classList.toggle('expanded', expanded);
  resultExpand.setAttribute('aria-label', expanded ? '收起' : '展开');
}
resultExpand.addEventListener('click', (e) => {
  e.stopPropagation();
  setResultExpanded(!expandedResult);
});

function stopScrollAnimation(): void {
  cancelAnimationFrame(scrollRaf);
  resultText.style.transform = '';
}

/** TTS karaoke:随播放进度把文本向上滚动(原版同款,不追求逐字对齐) */
function startScrollAnimation(duration: number, getCurrentTime: () => number): void {
  stopScrollAnimation();
  if (duration <= 0) return;
  const maxOffset = Math.max(0, resultText.scrollHeight - resultScroll.clientHeight);
  if (maxOffset <= 0) return;
  const frame = (): void => {
    const t = Math.min(1, Math.max(0, getCurrentTime() / duration));
    resultText.style.transform = `translateY(-${t * maxOffset}px)`;
    if (t < 1) scrollRaf = requestAnimationFrame(frame);
  };
  scrollRaf = requestAnimationFrame(frame);
}

function showResultCard(html: string): void {
  if (resultTimeout) clearTimeout(resultTimeout);
  resultText.innerHTML = html;
  setResultExpanded(false);
  resultCard.classList.add('show');
}

function scheduleResultHide(): void {
  if (resultTimeout) clearTimeout(resultTimeout);
  resultTimeout = setTimeout(() => resultCard.classList.remove('show'), 30_000);
}

function clearAudioVisuals(): void {
  moon.setSpeaking(false);
  moonGlow.classList.remove('active');
  background.classList.remove('speaking');
  stopScrollAnimation();
}

// ---------- 会话状态 ----------

let currentSession: RemoteSession | null = null;
/** 共享消息数据(两个模式共用;open-session 灌入,send/chunk/turn-done 增量) */
let liveMessages: { role: 'user' | 'agent'; text: string }[] = [];
let streaming = false;
let lastSentText: string | null = null;
let currentAgentText = '';
let treeData: TreeData | null = null;

function sessLabel(s: RemoteSession): string {
  return s.title || s.lastPrompt?.slice(0, 30) || s.id.slice(0, 12);
}

function setSession(s: RemoteSession): void {
  currentSession = s;
  localStorage.setItem(SESSION_KEY, s.id);
  markSeen(s.id); // 选中即已读:清 pendingReview 对应项 + lastSeen 置 now
  syncTbLabel();
  hub.attachSession(s.id); // 换会话 SSE 通道(工厂与 moon 共享同一事件流)
  void panelSetSessionWithRetry(s.id);
  resultCard.classList.remove('show');
  clearToolLine();
  showToast(`已切换到「${sessLabel(s)}」`, 2500);
}

/** 工厂 setSession(open-session 三分支在 backend 适配);stale 退避重试,封顶 3 次 */
async function panelSetSessionWithRetry(sid: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let delay = 800;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await panel.setSession(sid);
      syncFromHubLoad(sid);
      panel.flushQueue(); // turn 在离开期间结束时(history 分支),补发本地队列
      return;
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        showToast('会话正忙，稍后再试');
        return;
      }
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2; // 800 → 1600 → 3200,防任何残余循环
    }
  }
}

/** 工厂加载完成后,用 hub.lastLoad 同步 moon 侧(历史浮层/流式状态),免二次 open-session */
function syncFromHubLoad(sid: string): void {
  const l = hub.lastLoad;
  if (!l || l.sid !== sid || !currentSession || currentSession.id !== sid) return;
  // live 时用 recent(滚动最近消息)重建 moon 历史,切回忙中 session 也看得到上下文
  liveMessages = l.live ? (l.recent ?? []) : l.history;
  if (l.live) {
    currentAgentText = (l.buffered ?? []).join(''); // 断档续流:当前 turn 从缓冲整段接,后续 chunk 增量追加
    if (space === 'moon' && currentAgentText) showResultCard(mdToHtml(currentAgentText));
    setStreaming(true);
    setConnectionStatus('思考中...');
    showToast('正在执行中，输出将实时显示…', 2500);
  } else {
    setStreaming(false);
  }
}

function setStreaming(on: boolean): void {
  streaming = on;
  syncMainInput(); // 流式中主输入发送键变停止(⏹)
}

// ---------- 工具调用状态行(moon:result-card 上方小字;chat 模式工厂自带工具行) ----------

let toolDoneCount = 0;

function setToolLine(title: string, status: string): void {
  const STATUS_TEXT: Record<string, string> = {
    pending: '等待',
    in_progress: '进行中',
    completed: '完成',
    failed: '失败',
  };
  if (status === 'completed') toolDoneCount++;
  const text =
    status === 'completed' && toolDoneCount > 1
      ? `⚙ 工具调用完成（${toolDoneCount} 项）`
      : `⚙ ${title || '工具调用'} · ${STATUS_TEXT[status] ?? status}${toolDoneCount > 0 ? `（已完成 ${toolDoneCount} 项）` : ''}`;
  toolLine.textContent = text;
  toolLine.classList.add('show');
}

function clearToolLine(): void {
  toolLine.classList.remove('show');
  toolDoneCount = 0;
}

// ---------- 发送 ----------

async function sendText(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  if (!currentSession) {
    showToast('请先选择一个会话');
    openDrawer();
    return;
  }
  stopTts();
  lastSentText = t;
  liveMessages.push({ role: 'user', text: t });
  setStreaming(true);
  setConnectionStatus('思考中...');
  currentAgentText = '';
  clearToolLine();
  if (space === 'moon') showResultCard('<span style="opacity:.5">思考中…</span>');
  try {
    await post('/api/prompt', { sid: currentSession.id, text: t });
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 409) showToast('对方正在回复中，稍后再发');
    else if (status === 423) showToast('该 session 正被终端接管，请先在桌面端交还', 5000);
    else showToast(`发送失败:${String(err)}`);
    lastSentText = null;
    setStreaming(false);
    setConnectionStatus('已连接');
    resultCard.classList.remove('show');
  }
}

// ---------- 确认弹窗(识别结果/文字输入;含「重说」) ----------

// ---------- 历史浮层(open-session 真实历史) ----------

const historyModal = $('history-modal');
const historyList = $('history-list');
function renderHistory(): void {
  $('history-title').textContent = currentSession ? `对话记录 · ${sessLabel(currentSession)}` : '对话记录';
  historyList.innerHTML = '';
  if (!currentSession || liveMessages.length === 0) {
    historyList.innerHTML = '<div class="history-empty">暂无对话记录</div>';
    return;
  }
  for (const m of liveMessages) {
    const item = document.createElement('div');
    item.className = 'history-entry';
    const role = document.createElement('div');
    role.className = `history-role ${m.role === 'user' ? 'user' : 'assistant'}`;
    role.textContent = m.role === 'user' ? '我' : 'Kimi';
    const text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = m.text;
    item.append(role, text);
    historyList.appendChild(item);
  }
  historyList.scrollTop = historyList.scrollHeight;
}
// 历史入口已并入 ··· 菜单(menu-history);原 bottom-bar 的 history-btn 已随底栏退役
$('history-close').addEventListener('click', () => historyModal.classList.remove('show'));
historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) historyModal.classList.remove('show');
});

// ---------- 权限审批卡片(moon 没有的新件;chat 模式工厂自带权限条,moon 模式用卡片) ----------

const seenPermIds = new Set<string>();
let pendingPerm: { requestId: string; title: string; options: PermOption[] } | null = null;

function showPermCard(requestId: string, title: string, options: PermOption[]): void {
  if (seenPermIds.has(requestId)) return;
  seenPermIds.add(requestId);
  pendingPerm = { requestId, title, options };
  syncPermCard();
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
}

/** chat 模式下权限走工厂自带的权限条;moon 模式渲染进 result-card 上方卡片 */
function syncPermCard(): void {
  permCard.classList.remove('show');
  $('perm-actions').innerHTML = '';
  if (!pendingPerm || space === 'chat') return;
  const { requestId, title, options } = pendingPerm;
  const onRespond = (optionId: string): void => {
    void post('/api/permission-respond', { requestId, optionId }).catch(() => undefined);
    pendingPerm = null;
    syncPermCard();
  };
  $('perm-title').textContent = title;
  const actions = $('perm-actions');
  for (const opt of options) {
    const btn = document.createElement('button');
    if (/reject|deny|拒绝/i.test(opt.kind + opt.name)) btn.className = 'danger';
    btn.textContent = opt.name;
    btn.addEventListener('click', () => onRespond(opt.optionId));
    actions.appendChild(btn);
  }
  permCard.classList.add('show');
}

// ---------- TTS(队列播放 + 月晕 + karaoke;开关在「···」菜单里) ----------

let ttsEnabled = localStorage.getItem(TTS_KEY) !== '0';
let ttsUnavailable = false;
const menuTts = $('menu-tts') as HTMLButtonElement;
let ttsQueue: string[] = [];
let ttsPlaying = false;
let audio: HTMLAudioElement | null = null;

function syncTtsToggle(): void {
  menuTts.textContent = ttsEnabled ? '🔊 语音播报：开' : '🔇 语音播报：关';
}
syncTtsToggle();
menuTts.addEventListener('click', () => {
  ttsEnabled = !ttsEnabled;
  localStorage.setItem(TTS_KEY, ttsEnabled ? '1' : '0');
  if (!ttsEnabled) stopTts();
  syncTtsToggle();
});

// ---------- 「···」菜单抽屉 ----------

const openMenuDrawer = () => {
  ($('menu-guide') as HTMLButtonElement).hidden = window.isSecureContext;
  menuDrawer.classList.add('show');
};
$('tb-menu').addEventListener('click', openMenuDrawer);
$('menu-close').addEventListener('click', () => menuDrawer.classList.remove('show'));
menuDrawer.addEventListener('click', (e) => {
  if (e.target === menuDrawer) menuDrawer.classList.remove('show');
});
$('menu-guide').addEventListener('click', () => {
  menuDrawer.classList.remove('show');
  openHttpsGuide();
});
$('menu-history').addEventListener('click', () => {
  menuDrawer.classList.remove('show');
  renderHistory();
  historyModal.classList.add('show');
});
function stopTts(): void {
  ttsQueue = [];
  if (audio) {
    audio.pause();
    audio = null;
  }
  ttsPlaying = false;
  clearAudioVisuals();
}

function enqueueTts(text: string): void {
  if (!ttsEnabled || ttsUnavailable || !text.trim()) return;
  ttsQueue.push(text.slice(0, 500));
  void playNextTts();
}

async function playNextTts(): Promise<void> {
  if (ttsPlaying) return;
  const text = ttsQueue.shift();
  if (text === undefined) return;
  ttsPlaying = true;
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status === 503) {
      ttsUnavailable = true; // 静默降级为仅文字
      ttsPlaying = false;
      ttsQueue = [];
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    audio = new Audio(url);
    audio.setAttribute('playsinline', '');
    moon.setSpeaking(true);
    moonGlow.classList.add('active');
    background.classList.add('speaking');
    audio.ontimeupdate = () => {
      if (audio && audio.duration > 0) startScrollAnimation(audio.duration, () => audio!.currentTime);
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      audio = null;
      ttsPlaying = false;
      clearAudioVisuals();
      void playNextTts();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      audio = null;
      ttsPlaying = false;
      clearAudioVisuals();
      void playNextTts();
    };
    await audio.play();
  } catch {
    audio = null;
    ttsPlaying = false;
    clearAudioVisuals();
    void playNextTts(); // 失败不阻塞队列
  }
}

// ---------- createChatPanel 工厂挂载(经典对话 = 桌面同款实现,远程后端适配) ----------

/** newSession 的 cwd:当前选中 session 所属项目(树里查),无选中返回 '' */
function currentProjectCwd(): string {
  if (!currentSession || !treeData) return '';
  for (const p of treeData.projects) {
    if (p.sessions.some((s) => s.id === currentSession!.id)) return p.cwd;
  }
  return '';
}

const hub = createRemoteBackend({
  token: () => '', // 免配对:桥对空 token 放行(lan-guest);适配器契约保留
  getCwd: currentProjectCwd,
  onUnauthorized: () => {
    setConnectionStatus('重连中…'); // 桥已不再 401;兜底只更新状态,不再踢回配对屏
  },
  // 状态文案由 hub 真实连接状态驱动(SSE onopen/onerror),别在调用点手动设
  onStatus: (s) => {
    if (s === 'reconnecting') sseDropped = true; // 补拉触发条件之一:SSE 实际断开过重连
    setConnectionStatus(s === 'connected' ? '已连接' : '重连中…');
  },
});

/** 宿主能力:TTS 走现有队列(开关经 getSettings 门控工厂播报),外链走系统浏览器 */
const remoteHost: ChatHost = {
  openExternal: (url) => window.open(url, '_blank'),
  ttsSpeak: (text) => {
    enqueueTts(text); // 队列化串行播放,turn-done 由工厂触发
    return Promise.resolve();
  },
  ttsStop: () => stopTts(),
  getSettings: () => Promise.resolve({ ttsEnabled, ttsEnabledChat: ttsEnabled }),
  // captureRegion/setBallState/onOpenChat/onImagePasted:不提供(截图按钮自动隐藏,其余 no-op)
};

/** 📎 相册图片选择(≤10,FileReader → base64;工厂显示 📎 按钮并处理 addAttach) */
function pickImages(): Promise<{ data: string; mimeType: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])].slice(0, 10);
      const out: { data: string; mimeType: string }[] = [];
      for (const f of files) {
        const dataUrl = await new Promise<string>((res) => {
          const reader = new FileReader();
          reader.onload = () => res(String(reader.result));
          reader.onerror = () => res('');
          reader.readAsDataURL(f);
        });
        const comma = dataUrl.indexOf(',');
        if (comma > 0) out.push({ data: dataUrl.slice(comma + 1), mimeType: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png' });
      }
      resolve(out);
    };
    input.click();
  });
}

/**
 * 工厂 openSession 统一入口(design/design-v7.md §3.2,channel 同款):
 * live → recent 回放 + buffered 去重续流;history → 整段回放;stale 抛给调用方退避。
 * 经 hub.backend.loadSession 走一遍,顺带刷新 hub.lastLoad(moon 的 syncFromHubLoad 同源)。
 */
async function openSessionForPanel(sid: string): Promise<OpenSessionResult> {
  const r = (await hub.backend.loadSession(sid)) as {
    history: { role: 'user' | 'agent'; text: string }[];
    live?: boolean;
    recent?: { role: 'user' | 'agent'; text: string }[];
    buffered?: string[];
  };
  if (r.live) return { mode: 'live', buffered: r.buffered ?? [], recent: r.recent ?? [] };
  return { mode: 'history', messages: r.history };
}

const panel: ChatPanelHandle = createChatPanel(cvPanel, {
  getSessionId: () => currentSession?.id ?? '',
  backend: hub.backend,
  openSession: openSessionForPanel,
  host: remoteHost,
  imagePicker: pickImages,
  onSwitchSession: (sid) => {
    // 回显守卫:工厂加载完成会回告 onSwitchSession,若就是当前 session 直接忽略——
    // 否则会形成 setSession → panel.setSession → onSwitchSession → setSession 无限回环(实测每秒上千请求)
    if (currentSession?.id === sid) return;
    // 工厂内新建会话(ensureSession)后回告:挂到树上该 session
    const found = treeData?.projects.flatMap((p) => p.sessions).find((s) => s.id === sid);
    if (found) setSession(found);
  },
  onTitleChange: (title) => {
    if (space !== 'sa') tbLabel.textContent = title || '选择会话';
  },
});


/**
 * P0 气泡规范的 JS 部分(host 侧挂载,不改工厂 DOM 结构与桌面端):
 * - 时间分隔条:MutationObserver 记录消息到达间隔,>5 分钟插入居中时间戳
 *   (同日 HH:mm、跨天 M月D日 HH:mm;历史回放整批追加间隔≈0 自然合并);
 * - 顶部 24px 渐隐:上滚时给消息容器加 .scrolled,CSS mask 实现;
 * - 回底锚点:上滚超一屏时右下浮「↓」圆钮,点击 notifyVisible。
 */
function attachChatA11y(hostEl: HTMLElement, panel: ChatPanelHandle): void {
  const msgs = hostEl.querySelector('.kp-messages') as HTMLElement | null;
  if (!msgs) return;

  const anchor = document.createElement('button');
  anchor.className = 'chat-anchor';
  anchor.textContent = '↓';
  anchor.title = '回到底部';
  anchor.addEventListener('click', () => panel.notifyVisible());
  hostEl.appendChild(anchor);

  const SEP_MS = 5 * 60_000; // 微信策略:相邻消息间隔 >5 分钟插居中时间戳
  let lastMsgAt = 0;
  const makeSep = (at: number): HTMLElement => {
    const d = new Date(at);
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    const hm = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const sep = document.createElement('div');
    sep.className = 'chat-timesep';
    sep.textContent = sameDay ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    return sep;
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.removedNodes.length > 0) lastMsgAt = 0; // setSession 清场,重置基线
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const cls = node.classList;
        const isMsg = cls.contains('msg') || cls.contains('thought-box');
        if (!isMsg) continue;
        const now = Date.now();
        if (lastMsgAt > 0 && now - lastMsgAt > SEP_MS) node.before(makeSep(now));
        lastMsgAt = now;
      }
    }
  });
  mo.observe(msgs, { childList: true });

  const onScroll = () => {
    msgs.classList.toggle('scrolled', msgs.scrollTop > 4);
    anchor.classList.toggle('show', msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight > msgs.clientHeight);
  };
  msgs.addEventListener('scroll', onScroll);
  onScroll();
}
attachChatA11y(cvPanel, panel);

// ---------- Super Agent 屏(对话/看板/回执;对话 = 工厂复用远程后端) ----------

interface SaTaskItem {
  taskId: string;
  sid: string;
  title: string;
  goal: string;
  acceptance: string;
  status: 'in_progress' | 'review' | 'decision' | 'watching' | 'done';
  rounds: number;
  createdAt: number;
  updatedAt: number;
  lastVerdict?: string | null;
}
interface SaDecision {
  taskId: string;
  goal: string;
  acceptance: string;
  status: string;
  rounds: number;
  sid: string;
  updatedAt: number;
  inboxPreview: string;
}

const saView = $('sa-view');
let saSid = '';
let saPanel: ChatPanelHandle | null = null;
let saReady = false;
/** 默认看板;localStorage 记忆是默认值的覆盖 */
const SA_SEG_KEY = 'kimi-sa-seg';
let saSeg: 'board' | 'chat' = localStorage.getItem(SA_SEG_KEY) === 'chat' ? 'chat' : 'board';

/** 首次创建会等引导注入(几十秒),面板区显示「分身初始化中」 */
async function ensureSaSession(): Promise<void> {
  if (saReady) return;
  const host = $('sa-panel');
  host.innerHTML = '<div class="sa-loading">✦ 分身初始化中…<br /><span>首次创建需几十秒，请稍候</span></div>';
  try {
    const { sessionId } = await getJson<{ sessionId: string }>('/api/sa/session');
    saSid = sessionId;
    if (!saPanel) {
      host.innerHTML = '';
      saPanel = createChatPanel(host, {
        getSessionId: () => saSid,
        backend: hub.backend,
        openSession: openSessionForPanel,
        host: remoteHost,
        imagePicker: pickImages,
        onTitleChange: () => undefined,
      });
      attachChatA11y(host, saPanel);
    }
    saReady = true;
    // SA 对话复用现有 open-session/prompt/SSE 链路(注意:SA 有自己的 sid 过滤,不与当前 chat session 抢流)
    await saPanel.setSession(sessionId);
    // 面板可能在隐藏态完成加载(scrollHeight=0 白滚),可见后强制滚底
    requestAnimationFrame(() => saPanel?.notifyVisible());
  } catch (err) {
    host.innerHTML = `<div class="sa-loading">✦ 初始化失败<br /><span>${String(err)}</span></div>`;
  }
}

/** 分段切换(只剩 [看板 | 对话];回执并入看板) */
function applySaSeg(): void {
  localStorage.setItem(SA_SEG_KEY, saSeg);
  saView.querySelectorAll('.sa-seg button').forEach((x) =>
    x.classList.toggle('on', (x as HTMLElement).dataset.seg === saSeg),
  );
  $('sa-chat').hidden = saSeg !== 'chat';
  $('sa-board').hidden = saSeg !== 'board';
  if (saSeg === 'board') void refreshSaBoard();
  if (saSeg === 'chat') requestAnimationFrame(() => saPanel?.notifyVisible()); // 防隐藏态白滚停顶
}
saView.querySelectorAll('.sa-seg button').forEach((el) => {
  (el as HTMLButtonElement).addEventListener('click', () => {
    saSeg = (el as HTMLElement).dataset.seg as typeof saSeg;
    applySaSeg();
  });
});

/* 待你决策数徽标(看板 seg;TabBar 状态点由 refreshSaStatus 单独驱动) */
async function refreshSaBadge(): Promise<void> {
  try {
    const decisions = await getJson<SaDecision[]>('/api/sa/decisions');
    const n = decisions.length;
    for (const id of ['sa-seg-badge']) {
      const b = $(id);
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : String(n);
    }
  } catch {
    /* SA 未就绪静默 */
  }
}

/* ---------- SA Tab 状态点(#tab-sa-dot / #tab-sa-count,三态) ---------- */

type SaStatus = 'standby' | 'working' | 'decision';
let saStatusBusy = false;

function setSaStatus(state: SaStatus, n = 0): void {
  const dot = $('tab-sa-dot');
  const count = $('tab-sa-count');
  dot.classList.remove('work', 'decide');
  if (state === 'working') dot.classList.add('work');
  else if (state === 'decision') dot.classList.add('decide');
  dot.hidden = state === 'standby';
  count.hidden = state !== 'decision';
  if (state === 'decision') count.textContent = n > 99 ? '99+' : String(n);
}

/** 数据源:decisions(N>0 → 待你决策)> tasks(有在途 → 工作中)> 待命;sa 事件/60s/boot 驱动 */
async function refreshSaStatus(): Promise<void> {
  if (saStatusBusy) return;
  saStatusBusy = true;
  try {
    const [decisions, tasks] = await Promise.all([
      getJson<SaDecision[]>('/api/sa/decisions').catch(() => [] as SaDecision[]),
      getJson<SaTaskItem[]>('/api/sa/tasks').catch(() => [] as SaTaskItem[]),
    ]);
    if (decisions.length > 0) setSaStatus('decision', decisions.length);
    else if (tasks.some((t) => t.status === 'in_progress' || t.status === 'review')) setSaStatus('working');
    else setSaStatus('standby');
  } finally {
    saStatusBusy = false;
  }
}

let saStatusTick: ReturnType<typeof setInterval> | null = null;
function startSaStatusTick(): void {
  if (saStatusTick) return;
  void refreshSaStatus();
  saStatusTick = setInterval(() => void refreshSaStatus(), 60_000);
}

/* 看板:按状态分组(待你决策警示置顶/进行中/待验收/观察中/已完成折叠) */
const SA_SECTIONS: { status: SaTaskItem['status'] | 'done'; label: string }[] = [
  { status: 'decision', label: '待你决策' },
  { status: 'in_progress', label: '进行中' },
  { status: 'review', label: '待验收' },
  { status: 'watching', label: '观察中' },
  { status: 'done', label: '已完成' },
];
let saDoneOpen = false;

async function refreshSaBoard(): Promise<void> {
  const board = $('sa-board');
  let tasks: SaTaskItem[];
  try {
    tasks = await getJson<SaTaskItem[]>('/api/sa/tasks');
  } catch {
    if (saSeg === 'board') board.innerHTML = '<div class="sa-hint">任务加载失败</div>';
    return;
  }
  if (saSeg !== 'board') return;
  board.innerHTML = '';
  if (tasks.length === 0) {
    board.innerHTML = '<div class="sa-hint">还没有任务，去「对话」里跟 SA 说点什么。</div>';
    return;
  }
  for (const sec of SA_SECTIONS) {
    const list = tasks.filter((t) => t.status === sec.status);
    const isDone = sec.status === 'done';
    if (isDone && !saDoneOpen) {
      if (list.length > 0) {
        const toggle = document.createElement('button');
        toggle.className = 'sa-done-toggle';
        toggle.textContent = `▸ 已完成 ${list.length}`;
        toggle.addEventListener('click', () => {
          saDoneOpen = true;
          void refreshSaBoard();
        });
        board.appendChild(toggle);
      }
      continue;
    }
    const head = document.createElement('div');
    head.className = 'sa-sec-head' + (sec.status === 'decision' ? ' amber' : '');
    // 节头:12px muted 小标题 + 计数徽标
    const labelEl = document.createElement('span');
    labelEl.textContent = isDone ? `▾ 已完成` : sec.label;
    const countEl = document.createElement('span');
    countEl.className = 'sa-sec-count';
    countEl.textContent = String(list.length);
    head.append(labelEl, countEl);
    if (isDone) {
      head.classList.add('sa-done-head');
      head.addEventListener('click', () => {
        saDoneOpen = false;
        void refreshSaBoard();
      });
    }
    board.appendChild(head);
    for (const t of list) board.appendChild(makeSaCard(t));
  }

  // 回执区并入看板(状态分节下方)
  const inboxHead = document.createElement('div');
  inboxHead.className = 'sa-sec-head';
  inboxHead.textContent = '回执';
  const inboxList = document.createElement('div');
  inboxList.id = 'sa-inbox-list';
  inboxList.innerHTML = '<div class="sa-hint">加载中…</div>';
  board.append(inboxHead, inboxList);
  void refreshSaInbox();
}

/** 任务卡:decision/review 带 ✓通过 ✗打回(内联意见框);点卡片展开详情 */
function makeSaCard(t: SaTaskItem): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sa-card' + (t.status === 'decision' ? ' amber' : '');

  const goal = document.createElement('div');
  goal.className = 'sa-card-goal';
  goal.textContent = t.goal || t.title || t.taskId;
  const meta = document.createElement('div');
  meta.className = 'sa-card-meta';
  const id = document.createElement('span');
  id.className = 'sa-card-id';
  id.textContent = t.taskId;
  meta.appendChild(id);
  const st = document.createElement('span');
  st.className = 'sa-card-status' + (t.status === 'decision' ? ' amber' : '');
  st.textContent = t.status === 'decision' ? '需要你拍板' : t.status === 'review' ? 'SA 验收中' : '';
  if (st.textContent) meta.appendChild(st);
  if (t.rounds > 0) {
    const rounds = document.createElement('span');
    rounds.className = 'sa-card-rounds';
    rounds.textContent = `已打回 ${t.rounds} 轮`;
    meta.appendChild(rounds);
  }
  el.append(goal, meta);
  // 3 轮:卡片顶部琥珀警告条
  if (t.rounds >= 3) {
    const warn = document.createElement('div');
    warn.className = 'sa-rounds-bar';
    warn.textContent = '已打回 3 轮，建议直接介入';
    el.appendChild(warn);
  }

  // 详情手风琴(点击非按钮区展开)
  const detail = document.createElement('div');
  detail.className = 'sa-card-detail';
  detail.hidden = true;
  const acc = document.createElement('div');
  acc.className = 'sa-card-acc';
  acc.textContent = t.acceptance || '(未填验收标准)';
  detail.appendChild(acc);
  if (t.lastVerdict) {
    const verdict = document.createElement('blockquote');
    verdict.className = 'sa-card-verdict';
    verdict.textContent = t.lastVerdict;
    detail.appendChild(verdict);
  }
  const time = document.createElement('div');
  time.className = 'sa-card-time';
  time.textContent = `更新 ${relTime(t.updatedAt)}`;
  detail.appendChild(time);
  el.appendChild(detail);

  if (t.status === 'decision' || t.status === 'review') {
    // footer:文字按钮(通过=accent 文字 / 打回=danger 文字),不再是色块按钮
    const actions = document.createElement('div');
    actions.className = 'sa-card-actions';
    const approve = document.createElement('button');
    approve.className = 'sa-act txt-ok';
    approve.textContent = '通过';
    const reject = document.createElement('button');
    reject.className = 'sa-act txt-no';
    reject.textContent = '打回';
    actions.append(approve, reject);
    el.appendChild(actions);

    const setBusy = (busy: boolean) => {
      approve.disabled = busy;
      reject.disabled = busy;
    };
    approve.addEventListener('click', (e) => {
      e.stopPropagation();
      setBusy(true);
      void post<{ ok: boolean; reason?: string }>('/api/sa/review', { taskId: t.taskId, action: 'approve' })
        .then((r) => {
          if (r.ok) {
            showToast('已通过，任务落入已完成');
            el.classList.add('leaving');
            setTimeout(() => void refreshSaBoard().then(refreshSaBadge), 240);
          } else if (r.reason === 'worker-gone') showToast('worker session 已不存在');
          else showToast(`通过失败:${r.reason ?? '未知原因'}`);
        })
        .catch((err) => showToast(`通过失败:${String(err)}`))
        .finally(() => setBusy(false));
    });
    reject.addEventListener('click', (e) => {
      e.stopPropagation();
      actions.remove();
      const form = document.createElement('div');
      form.className = 'sa-reject-form';
      const textarea = document.createElement('textarea');
      textarea.placeholder = '告诉 worker 哪里不对、怎么改';
      textarea.rows = 3;
      const row = document.createElement('div');
      row.className = 'sa-card-actions';
      const submit = document.createElement('button');
      submit.className = 'sa-act no';
      submit.textContent = '提交打回';
      const cancel = document.createElement('button');
      cancel.className = 'sa-act';
      cancel.textContent = '取消';
      row.append(submit, cancel);
      form.append(textarea, row);
      el.appendChild(form);
      textarea.focus();
      cancel.addEventListener('click', (ev) => {
        ev.stopPropagation();
        form.remove();
        el.appendChild(actions);
      });
      const doSubmit = () => {
        setBusy(true);
        submit.disabled = true;
        void post<{ ok: boolean; reason?: string }>('/api/sa/review', {
          taskId: t.taskId,
          action: 'reject',
          comment: textarea.value.trim() || undefined,
        })
          .then((r) => {
            if (r.ok) {
              showToast('已打回，worker 将收到修改意见');
              el.classList.add('leaving');
              setTimeout(() => void refreshSaBoard().then(refreshSaBadge), 240);
            } else if (r.reason === 'rounds-exceeded') showToast('已打回 3 轮，建议直接介入处理');
            else if (r.reason === 'worker-gone') showToast('worker session 已不存在');
            else showToast(`打回失败:${r.reason ?? '未知原因'}`);
          })
          .catch((err) => showToast(`打回失败:${String(err)}`))
          .finally(() => {
            setBusy(false);
            submit.disabled = false;
          });
      };
      submit.addEventListener('click', (ev) => {
        ev.stopPropagation();
        doSubmit();
      });
      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          doSubmit();
        }
      });
    });
  }

  el.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
  });
  return el;
}

/* 回执流(并入看板 tab,状态分节下方) */
async function refreshSaInbox(): Promise<void> {
  const box = document.getElementById('sa-inbox-list');
  if (!box) return;
  let items: { file: string; taskId: string; at: number; preview: string }[];
  try {
    items = await getJson('/api/sa/inbox');
  } catch {
    box.innerHTML = '<div class="sa-hint">回执加载失败</div>';
    return;
  }
  box.innerHTML = '';
  if (items.length === 0) {
    box.innerHTML = '<div class="sa-hint">还没有回执。worker 完成任务后会投到 inbox/。</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('button');
    row.className = 'sa-inbox-row';
    const head = document.createElement('span');
    head.className = 'sa-inbox-head';
    const id = document.createElement('span');
    id.className = 'sa-card-id';
    id.textContent = it.taskId || '(无 taskId)';
    const time = document.createElement('span');
    time.className = 'sa-inbox-time';
    time.textContent = relTime(it.at);
    head.append(id, time);
    const preview = document.createElement('span');
    preview.className = 'sa-inbox-preview';
    preview.textContent = it.preview;
    row.append(head, preview);
    row.addEventListener('click', () => void openSaInboxModal(it.file, it.taskId));
    box.appendChild(row);
  }
}

async function openSaInboxModal(file: string, taskId: string): Promise<void> {
  const modal = $('sa-modal');
  $('sa-modal-title').textContent = `回执 · ${taskId || file}`;
  const body = $('sa-modal-body');
  body.textContent = '加载中…';
  modal.classList.add('show');
  try {
    const { content } = await getJson<{ content: string }>(`/api/sa/inbox-file?file=${encodeURIComponent(file)}`);
    body.textContent = content ?? '(回执文件已被清理)';
  } catch (err) {
    body.textContent = `读取失败:${String(err)}`;
  }
}
$('sa-modal-close').addEventListener('click', () => $('sa-modal').classList.remove('show'));
$('sa-modal').addEventListener('click', (e) => {
  if (e.target === $('sa-modal')) $('sa-modal').classList.remove('show');
});

void refreshSaBadge();

// ---------- 语音(识别结果实时渲染进输入框;recognizer 优先,MediaRecorder 兜底) ----------

/** 语音渲染目标(moon 主输入 / chat·SA 工厂输入区共用一套实时渲染) */
interface VoiceTarget {
  /** interim:最终累计稿 + 中间稿实时入框(listening 灰字态由实现决定) */
  render(finalText: string, interim: string): void;
  /** final 落定:写入正式文本(恢复正常色) */
  commit(finalText: string): void;
  /** 结束清理(onend/onerror 收尾,去 listening 态) */
  done(): void;
  /** 录音起止的视觉开关(如语音钮变红) */
  setActive?(on: boolean): void;
}
let isRecording = false;
let useRecorder = false;
let voiceTarget: VoiceTarget | null = null;

async function startRecording(target: VoiceTarget): Promise<void> {
  if (isRecording) return;
  if (!window.isSecureContext) {
    openHttpsGuide();
    return;
  }
  if (!recognizer.available && !AudioRecorder.isSupported()) {
    showToast('当前浏览器不支持语音识别');
    return;
  }
  stopTts();
  isRecording = true;
  voiceTarget = target;
  target.setActive?.(true);
  useRecorder = !recognizer.available && AudioRecorder.isSupported();
  moon.setSpeaking(true);
  moonGlow.classList.add('active');
  background.classList.add('speaking');
  if (useRecorder) {
    showToast('使用录音兜底');
    void recorder.start();
  } else {
    recognizer.start();
  }
}

function stopRecording(): void {
  if (!isRecording) return;
  isRecording = false;
  voiceTarget?.setActive?.(false);
  clearAudioVisuals();
  if (useRecorder) recorder.stop();
  else recognizer.stop(); // onend → onResult(commit)→ onEnd(done)
}

recognizer.onResult = (text) => {
  voiceTarget?.commit(text); // final 直接落输入框,不再有确认弹窗
};
recognizer.onError = (err) => {
  isRecording = false;
  clearAudioVisuals();
  voiceTarget?.done();
  voiceTarget = null;
  if (err === 'no-match') showToast('没听清，请重试');
  else if (err !== 'aborted') showToast(`语音错误: ${err}`);
};
recognizer.onInterim = (finalText, interim) => {
  voiceTarget?.render(finalText, interim); // 实时稿入框
};
recognizer.onEnd = () => {
  isRecording = false; // 自然结束也要复位,否则后续 startRecording 全被挡
  clearAudioVisuals();
  voiceTarget?.done();
  voiceTarget = null;
};
recorder.onResult = (base64, format) => {
  // 兜底上传 ASR(契约:/api/asr 本期 501 占位)
  void post('/api/asr', { audio: base64, format })
    .then(() => showToast('识别完成'))
    .catch(() => showToast('语音兜底识别未就绪，请重说或打字'))
    .finally(() => {
      isRecording = false;
      clearAudioVisuals();
      voiceTarget?.done();
      voiceTarget = null;
    });
};
recorder.onError = (err) => {
  const messages: Record<string, string> = {
    not_supported: '浏览器不支持录音',
    mic_denied: '麦克风权限被拒绝',
    empty_recording: '录音为空',
  };
  showToast(messages[err] ?? `录音错误: ${err}`);
};

/* HTTPS 指引(非 secure context) */
function openHttpsGuide(): void {
  const httpsUrl = `https://${location.hostname}:8923${location.pathname}`;
  const steps = [
    '手机和电脑连同一局域网；桌面端已开启 HTTPS（默认端口 8923）。',
    `手机 Safari 打开 <code>${httpsUrl}ca.pem</code> 下载 CA 证书（也可在电脑上下载后隔空投送）。`,
    'iOS：设置 → 通用 → VPN与设备管理 → 安装该描述文件。',
    '设置 → 通用 → 关于本机 → 证书信任设置 → 对该证书启用完全信任。',
    `用 <code>${httpsUrl}</code> 重新打开本页，即可使用语音。`,
  ];
  $('guide-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  ($('guide-open') as HTMLAnchorElement).href = httpsUrl;
  guideModal.classList.add('show');
}
$('guide-close').addEventListener('click', () => guideModal.classList.remove('show'));
guideModal.addEventListener('click', (e) => {
  if (e.target === guideModal) guideModal.classList.remove('show');
});

// ---------- session 抽屉(底部抽屉式项目树) ----------

const collapsedGroups = new Set<string>();

function relTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}

async function loadTree(): Promise<void> {
  try {
    treeData = await getJson<TreeData>('/api/tree');
    // 首次:恢复上次选中;没有则选最近活跃
    if (!currentSession && treeData) {
      const all = treeData.projects.flatMap((p) => p.sessions);
      const lastId = localStorage.getItem(SESSION_KEY);
      const restored = all.find((s) => s.id === lastId) ?? all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (restored) {
        currentSession = restored;
        markSeen(restored.id); // 恢复选中视为已读
        syncTbLabel();
        hub.attachSession(restored.id);
        void panelSetSessionWithRetry(restored.id);
      } else {
        syncTbLabel();
      }
    }
    detectReview(); // 树刷新驱动「待检查」检测(tree-changed 每次 ~2s)
  } catch (err) {
    if (String(err) !== 'Error: unauthorized') showToast(`加载失败:${String(err)}`);
  }
}

function renderDrawer(): void {
  drawerTree.innerHTML = '';
  if (!treeData || treeData.projects.length === 0) {
    drawerTree.innerHTML = '<div class="drawer-empty">还没有会话，在桌面端创建后刷新</div>';
    return;
  }
  for (const p of treeData.projects) {
    const key = p.cwd || p.dirName;
    const hot = p.sessions.some((s) => s.busy || s.hasUpdate);
    const expanded = collapsedGroups.has(key) ? false : hot || !collapsedGroups.has(`!${key}`);
    const head = document.createElement('button');
    head.className = 'drawer-proj-head';
    const arrow = document.createElement('span');
    arrow.className = 'drawer-proj-arrow';
    arrow.textContent = expanded ? '▼' : '▶';
    const name = document.createElement('span');
    name.className = 'drawer-proj-name';
    name.textContent = p.name ?? p.dirName;
    const meta = document.createElement('span');
    meta.className = 'drawer-proj-meta';
    meta.textContent = `(${p.sessions.length})`;
    head.append(arrow, name, meta);
    drawerTree.appendChild(head);

    const listEl = document.createElement('div');
    listEl.style.display = expanded ? '' : 'none';
    for (const s of p.sessions) listEl.appendChild(makeDrawerRow(s));
    drawerTree.appendChild(listEl);

    head.addEventListener('click', () => {
      const nowExpanded = listEl.style.display !== 'none';
      listEl.style.display = nowExpanded ? 'none' : '';
      arrow.textContent = nowExpanded ? '▶' : '▼';
      if (nowExpanded) collapsedGroups.add(key);
      else collapsedGroups.delete(key);
    });
  }
}

function makeDrawerRow(s: RemoteSession): HTMLElement {
  const row = document.createElement('div');
  row.className = 'drawer-sess' + (currentSession?.id === s.id ? ' current' : '');
  const dot = document.createElement('span');
  dot.className = 'drawer-dot' + (s.busy ? ' run' : '');
  row.appendChild(dot);
  if (s.hasUpdate) {
    const upd = document.createElement('span');
    upd.className = 'drawer-upd';
    row.appendChild(upd);
  }
  const main = document.createElement('div');
  main.className = 'drawer-sess-main';
  const title = document.createElement('div');
  title.className = 'drawer-sess-title';
  title.textContent = sessLabel(s);
  const excerpt = document.createElement('div');
  excerpt.className = 'drawer-sess-excerpt';
  excerpt.textContent = (s.lastMessage || s.lastPrompt || '').slice(0, 60);
  main.append(title, excerpt);
  const time = document.createElement('span');
  time.className = 'drawer-sess-time';
  time.textContent = relTime(s.updatedAt);
  row.append(main, time);
  row.addEventListener('click', () => {
    closeDrawer();
    setSession(s);
  });
  return row;
}

function openDrawer(): void {
  void loadTree().then(renderDrawer);
  sessionDrawer.classList.add('show');
}
function closeDrawer(): void {
  sessionDrawer.classList.remove('show');
}
$('tb-list').addEventListener('click', openDrawer); // 统一顶栏左钮 = 共享会话抽屉(chat 同款修复:原 cv-float-left 从未接线)

// ---------- moon 空白点按:日期/月相信息 隐藏⇄显示(localStorage 记忆) ----------
const MOON_INFO_KEY = 'kimi-remote-moon-info';
function applyMoonInfo(): void {
  const hidden = space === 'moon' && localStorage.getItem(MOON_INFO_KEY) === '0';
  $('top-bar').classList.toggle('faded', hidden);
}
document.addEventListener('click', (e) => {
  if (space !== 'moon') return;
  const t = e.target as HTMLElement;
  // 控件/卡片/抽屉/输入区不触发(点它们保留原行为)
  if (t.closest('button, a, input, textarea, select, #dock, #topbar, #tb-panel, #result-card, #perm-card, #session-drawer, #menu-drawer, .modal-card')) return;
  localStorage.setItem(MOON_INFO_KEY, localStorage.getItem(MOON_INFO_KEY) === '0' ? '1' : '0');
  applyMoonInfo();
});

// 顶栏小球:复刻桌面悬浮球神韵(src/renderer/ball)——整眼跟随/眨眼 140ms/转头 ±10°/呼吸(CSS)
const tbBall = $('tb-ball');
const tbFace = $('tb-face');
const tbEyes = Array.from(tbFace.querySelectorAll<HTMLElement>('.tb-eye'));
const TB_MAX_EYE = 2.5; // px(50px 球,桌面 58px 球用 3px 等比)

/** 整眼朝向某个视口坐标(桌面:跟随鼠标;手机:跟随手指,无触摸时随机游移) */
function tbLookAt(clientX: number, clientY: number): void {
  const r = tbBall.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy) || 1;
  const ox = (dx / len) * TB_MAX_EYE;
  const oy = (dy / len) * TB_MAX_EYE;
  for (const e of tbEyes) e.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px)`;
}
window.addEventListener('pointermove', (e) => tbLookAt(e.clientX, e.clientY), { passive: true });
(function tbDriftLoop(): void {
  window.setTimeout(() => {
    const r = tbBall.getBoundingClientRect();
    const a = Math.random() * Math.PI * 2;
    tbLookAt(r.left + r.width / 2 + Math.cos(a) * 500, r.top + r.height / 2 + Math.sin(a) * 500);
    tbDriftLoop();
  }, 2400 + Math.random() * 1600);
})();
(function tbBlinkLoop(): void {
  window.setTimeout(() => {
    tbFace.classList.add('blink'); // CSS: 双眼 scaleY(0.1)
    window.setTimeout(() => tbFace.classList.remove('blink'), 140);
    tbBlinkLoop();
  }, 3000 + Math.random() * 3000);
})();
(function tbTiltLoop(): void {
  window.setTimeout(() => {
    const cls = Math.random() < 0.5 ? 'tilt-left' : 'tilt-right';
    tbFace.classList.add(cls);
    window.setTimeout(() => tbFace.classList.remove(cls), 900 + Math.random() * 800);
    tbTiltLoop();
  }, 8000 + Math.random() * 7000);
})();

// ---------- 小球管家(「待检查」汇总:turn 已完成且未再打开的 session) ----------
// 检测通道:桥的 chunk/turn-done 只发对应 sid 的会话通道,手机只 attach 当前 session;
// 非当前 session 的活动只能经全局通道 tree-changed(树含 busy/updatedAt/lastMessage)。
// 故语义落地为:!busy(turn 已完成)且 updatedAt > lastSeen(此后未打开)→ 记一条。
const REVIEW_KEY = 'kimi-remote-review';
const SEEN_KEY = 'kimi-remote-lastseen';
interface ReviewEntry {
  title: string;
  preview: string;
  doneAt: number;
}
const lastSeen = new Map<string, number>(
  JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as [string, number][],
);
const pendingReview = new Map<string, ReviewEntry>(
  JSON.parse(localStorage.getItem(REVIEW_KEY) ?? '[]') as [string, ReviewEntry][],
);
function persistSeen(): void {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...lastSeen]));
}
function persistReview(): void {
  localStorage.setItem(REVIEW_KEY, JSON.stringify([...pendingReview]));
}

const tbBadge = $('tb-ball-badge');
const tbPanel = $('tb-panel');

function syncReviewBadge(): void {
  const n = pendingReview.size;
  tbBadge.hidden = n === 0;
  tbBadge.textContent = n > 9 ? '9+' : String(n);
}

/** 选中即已读:任何入口(抽屉/面板/横幅/恢复)打开 session 都经这里 */
function markSeen(sid: string): void {
  lastSeen.set(sid, Date.now());
  persistSeen();
  if (pendingReview.delete(sid)) persistReview();
  syncReviewBadge();
  if (!tbPanel.hidden) renderReviewPanel();
}

/** 树刷新驱动检测:!busy 且 updatedAt > lastSeen → 记/覆盖一条;首遇 session 建基线(已有状态视为已读) */
function detectReview(): void {
  if (!treeData) return;
  let changed = false;
  let bootstrapped = false;
  for (const p of treeData.projects) {
    for (const s of p.sessions) {
      if (s.id === currentSession?.id) continue; // 正在看的不计
      const seen = lastSeen.get(s.id);
      if (seen === undefined) {
        lastSeen.set(s.id, s.updatedAt); // 基线:只追此后新活动,防首次打开全员待检查
        bootstrapped = true;
        continue;
      }
      if (s.busy || s.updatedAt <= seen) continue; // 进行中不算「已完成」;无新活动跳过
      const entry: ReviewEntry = {
        title: sessLabel(s),
        preview: (s.lastMessage ?? '').slice(0, 60),
        doneAt: s.updatedAt,
      };
      const prev = pendingReview.get(s.id);
      if (!prev || prev.doneAt !== entry.doneAt || prev.preview !== entry.preview || prev.title !== entry.title) {
        pendingReview.set(s.id, entry); // 同 sid 覆盖,一次 turn 只留一条
        changed = true;
      }
    }
  }
  if (bootstrapped) persistSeen();
  if (changed) persistReview();
  if (changed || bootstrapped) syncReviewBadge();
}

function renderReviewPanel(): void {
  const list = $('tb-panel-list');
  list.innerHTML = '';
  const sorted = [...pendingReview].sort((a, b) => b[1].doneAt - a[1].doneAt); // doneAt 倒序
  $('tb-panel-title').textContent = `待检查 ${sorted.length} 项`;
  for (const [sid, e] of sorted) {
    const item = document.createElement('div');
    item.className = 'tb-review-item';
    const main = document.createElement('div');
    main.className = 'tb-review-main';
    const title = document.createElement('div');
    title.className = 'tb-review-title';
    title.textContent = e.title;
    const prev = document.createElement('div');
    prev.className = 'tb-review-preview';
    prev.textContent = e.preview || '(无文本输出)';
    const time = document.createElement('div');
    time.className = 'tb-review-time';
    time.textContent = relTime(e.doneAt);
    main.append(title, prev);
    item.append(main, time);
    item.addEventListener('click', () => {
      const found = treeData?.projects.flatMap((p) => p.sessions).find((s) => s.id === sid);
      closeReviewPanel();
      if (found) {
        setSession(found); // setSession 内 markSeen:清该条 + lastSeen 置 now
        setSpace('chat');
      }
    });
    list.appendChild(item);
  }
}

function openReviewPanel(): void {
  renderReviewPanel();
  tbPanel.hidden = false;
}
function closeReviewPanel(): void {
  tbPanel.hidden = true;
}
tbBall.addEventListener('click', (e) => {
  e.stopPropagation(); // 防 document 关闭监听即开即合
  if (tbPanel.hidden) openReviewPanel();
  else closeReviewPanel();
});
$('tb-panel-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  pendingReview.clear();
  persistReview();
  syncReviewBadge();
  closeReviewPanel();
});
document.addEventListener('click', (e) => {
  if (tbPanel.hidden) return;
  const t = e.target as HTMLElement;
  if (!t.closest('#tb-panel') && !t.closest('#tb-ball')) closeReviewPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeReviewPanel();
});
syncReviewBadge(); // boot:恢复 localStorage 里的待检查
$('drawer-close').addEventListener('click', closeDrawer);
sessionDrawer.addEventListener('click', (e) => {
  if (e.target === sessionDrawer) closeDrawer();
});

// ---------- SSE 接线(hub 双通道 fan-out:工厂经 backend.on*,moon 侧经这里) ----------

hub.onSessionEvent((e: RemoteSseEvent) => {
  if (!currentSession || !('sessionId' in e) || e.sessionId !== currentSession.id) return;
  if (e.type === 'chunk') {
    if (e.kind === 'user') {
      if (lastSentText !== null && e.text === lastSentText) {
        lastSentText = null; // moon 侧自己刚发的,已乐观渲染
      } else {
        // 其他界面(桌面/工厂)发出的用户消息:进 moon 历史
        liveMessages.push({ role: 'user', text: e.text });
      }
      return;
    }
    if (e.kind === 'thought') return; // moon 美学:思考过程不展示
    // agent:累积进 result-card(chat 模式的流式渲染由工厂自理)
    currentAgentText += e.text;
    if (space === 'moon') showResultCard(mdToHtml(currentAgentText));
  } else if (e.type === 'tool') {
    setToolLine(e.title, e.status);
  } else if (e.type === 'turn-done') {
    const replyText = currentAgentText.trim();
    liveMessages.push({ role: 'agent', text: replyText });
    currentAgentText = '';
    setStreaming(false);
    setConnectionStatus('已连接');
    clearToolLine(); // turn 结束自动隐藏工具行
    scheduleResultHide();
    // TTS 单入口:工厂 host.ttsSpeak(turn-done 经 backend.onTurnDone 触发),此处不再 enqueue
  } else if (e.type === 'permission') {
    showPermCard(e.requestId, e.title, e.options ?? []);
  }
});

let treeRefreshTimer = 0;
hub.onGlobalEvent((e: RemoteSseEvent) => {
  if (e.type === 'tree-changed') {
    // 只刷树,绝不触发 open-session / session-config(scanner 在流式期间每 2s 推,
    // 任何联动加载都会形成重同步风暴)
    window.clearTimeout(treeRefreshTimer);
    treeRefreshTimer = window.setTimeout(() => void loadTree(), 1500);
  } else if (e.type === 'permission') {
    showPermCard(e.requestId, e.title, e.options ?? []);
  } else if (e.type === 'sa') {
    void refreshSaBadge();
    void refreshSaStatus(); // Tab SA 状态点实时跟随
    if (e.saKind === 'decision') {
      if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
      showToast('🔔 SA 需要你拍板');
    }
    // SA 屏开着时刷新对应区(tasks/decision/inbox → 看板,回执已并入)
    if (saView.classList.contains('on')) {
      if (e.saKind === 'tasks' || e.saKind === 'decision' || e.saKind === 'inbox') void refreshSaBoard();
    }
  }
});

// ---------- 断线重连:visibility / online 立即重连 + 重同步(入口收敛) ----------

/** 当前 session 是否在流式中(live/busy):流由 SSE 覆盖,此间禁止 open-session */
function isSessionLive(): boolean {
  if (!currentSession) return false;
  if (streaming) return true; // moon 侧在飞
  if (currentSession.busy) return true; // 桌面端在干活(树数据,2s 级新鲜度)
  if (hub.lastLoad?.sid === currentSession.id && hub.lastLoad.live) return true; // 上次加载就是 live
  return false;
}

let resyncTimer = 0;
function resync(): void {
  if (resyncTimer) return; // visibility/online/SSE 多处同时触发时 500ms 内合并
  resyncTimer = window.setTimeout(() => {
    resyncTimer = 0;
    doResync();
  }, 500);
}

function doResync(): void {
  setConnectionStatus('重连中...');
  hub.reconnect();
  void loadTree();
  // 补拉只在「SSE 重连后 + 非流式」做,且只走 history 路径(busy 时 openSession 永不 load)
  if (currentSession && !isSessionLive()) void panelSetSessionWithRetry(currentSession.id);
  void catchUpLive(); // 流式中的断档补齐(锁屏回连场景)
}

// ---------- 锁屏回连补拉(live 会话的断档补齐;防风暴:真缺席才触发) ----------
let hiddenAt = 0; // 页面切后台的时刻(>3s 才算真缺席)
let sseDropped = false; // 全局 SSE 掉过线(hub onStatus 标记,补拉后消费)
const catchupAt = new Map<string, number>(); // sid → 上次补拉时刻(同 session 5s 节流)

/**
 * 回连补拉:当前 session 流式中 + 真缺席(锁屏 >3s / SSE 实断)→ open-session 整段重放。
 * 工厂 openSession 路径天然无双份(live=recent+buffered 前缀去重续流;期间 turn 结束=history 整段替换);
 * tree-changed 等周期性事件不进 resync,不会触发补拉(保持风暴修复)。
 */
function catchUpLive(): void {
  const s = currentSession;
  if (!s) return;
  const absent = (hiddenAt > 0 && Date.now() - hiddenAt > 3000) || sseDropped;
  if (!absent) return;
  hiddenAt = 0;
  if (!isSessionLive()) {
    sseDropped = false; // history 路径上面已补
    return;
  }
  const last = catchupAt.get(s.id) ?? 0;
  if (Date.now() - last < 5000) return;
  catchupAt.set(s.id, Date.now());
  sseDropped = false;
  void panelSetSessionWithRetry(s.id);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now(); // 锁屏/切后台记时,回前台 resync 时评缺席
  else resync();
});
window.addEventListener('online', () => resync());

// ---------- 主输入统一(微信式:空输入显语音钮/有字显发送钮;浮于 TabBar 之上) ----------

const miText = $('mi-text') as unknown as HTMLTextAreaElement;
const miVoice = $('mi-voice') as HTMLButtonElement;
const miSend = $('mi-send') as HTMLButtonElement;

function syncMainInput(): void {
  const hasText = miText.value.trim().length > 0;
  miVoice.hidden = hasText || streaming; // 空输入显语音钮;有字/流式显发送(流式中为停止)
  miSend.hidden = !hasText && !streaming;
  miSend.textContent = streaming ? '⏹' : '➤';
}
miText.addEventListener('input', () => {
  miText.style.height = 'auto';
  miText.style.height = Math.min(miText.scrollHeight, 110) + 'px';
  syncMainInput();
});
miText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    miSend.click();
  }
});
miSend.addEventListener('click', () => {
  if (streaming) {
    if (currentSession) {
      setConnectionStatus('已连接');
      void post('/api/cancel', { sid: currentSession.id }).catch(() => undefined);
      showToast('已停止', 2000);
    }
    return;
  }
  const t = miText.value.trim();
  if (!t) return;
  miText.value = '';
  miText.style.height = 'auto';
  syncMainInput();
  void sendText(t);
});
// moon 主输入语音目标:interim 实时渲染进输入框(listening 灰字),final 落定正式文本
let moonVoiceBase = '';
function autosizeMiText(): void {
  miText.style.height = 'auto';
  miText.style.height = Math.min(miText.scrollHeight, 110) + 'px';
}
const moonVoiceTarget: VoiceTarget = {
  render(finalText, interim) {
    miText.value = moonVoiceBase + finalText + interim;
    miText.classList.add('listening'); // 灰字「识别中…」
    autosizeMiText();
    syncMainInput();
  },
  commit(finalText) {
    miText.value = moonVoiceBase + finalText;
    miText.classList.remove('listening');
    autosizeMiText();
    syncMainInput();
  },
  done() {
    miText.classList.remove('listening');
    miVoice.classList.remove('recording');
  },
  setActive(on) {
    miVoice.classList.toggle('recording', on);
  },
};
miVoice.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
    return;
  }
  moonVoiceBase = miText.value; // 识别期间保留已输入文本,语音追加其后
  void startRecording(moonVoiceTarget); // 空态语音键:识别→实时入框(无确认弹窗)
});

/**
 * chat/SA 工厂输入区的「空态语音键」(宿主侧 shim,统一与 moon 一套交互):
 * 输入为空时显示 🎙(有字时隐藏,发送交给工厂发送键);点击开录,interim 实时入框。
 * 工厂(chat-panel)原生语音键落地后,删除此 shim 即可(不在工厂 DOM 里重复造键)。
 */


$('menu-bg-prev').addEventListener('click', () => bgSwitcher.prev());
$('menu-bg-next').addEventListener('click', () => bgSwitcher.next());

// ---------- Kiki(语义分组第四空间;不露文件名) ----------

interface KikiAgent {
  id: string;
  name: string;
  description: string;
  avatar: string;
}

const kikiView = $('kiki-view');
const KI_FILES = [
  { key: 'agents.md', label: '身份与边界' },
  { key: 'memory.md', label: '长期记忆' },
  { key: 'learning.md', label: '进化日志' },
  { key: 'tasks.md', label: '任务看板' },
] as const;

function kikiGroup(title: string): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.className = 'kiki-group';
  const head = document.createElement('div');
  head.className = 'kiki-group-title';
  head.textContent = title;
  const body = document.createElement('div');
  body.className = 'kiki-card';
  wrap.append(head, body);
  return { wrap, body };
}

/** 文本行编辑(tasks.md 同款防抖 1s + 失焦自动保存) */
function makeKikiEditor(getContent: () => Promise<string>, save: (content: string) => Promise<void>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'kiki-editor-wrap';
  const editor = document.createElement('textarea');
  editor.className = 'kiki-editor';
  editor.spellcheck = false;
  const status = document.createElement('div');
  status.className = 'kiki-editor-status';
  status.textContent = '加载中…';
  wrap.append(editor, status);
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    status.textContent = '保存中…';
    void save(editor.value)
      .then(() => {
        status.textContent = '已保存 ✓';
        setTimeout(() => (status.textContent = ''), 2000);
      })
      .catch((err) => {
        dirty = true;
        status.textContent = `保存失败:${String(err)}`;
      });
  };
  editor.addEventListener('input', () => {
    dirty = true;
    status.textContent = '…';
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  });
  editor.addEventListener('blur', flush);
  void getContent()
    .then((c) => {
      editor.value = c;
      status.textContent = '';
    })
    .catch(() => {
      status.textContent = '读取失败';
      editor.disabled = true;
    });
  return wrap;
}

async function renderKiki(): Promise<void> {
  const scroll = $('kiki-scroll');
  scroll.innerHTML = '<div class="kiki-loading">加载中…</div>';
  const [agents, memory, settings] = await Promise.all([
    getJson<KikiAgent[]>('/api/agents').catch(() => null),
    getJson<{ content: string }>('/api/memory').catch(() => null),
    getJson<{ permissionMode: string; thinking: boolean; modelCurrent: string | null; modelOptions: { value: string; name: string }[] }>('/api/settings').catch(() => null),
  ]);
  scroll.innerHTML = '';

  // ---- 组 1:记忆(列表化 + 长按删除 + 添加) ----
  {
    const { wrap, body } = kikiGroup('记忆');
    const items = (memory?.content ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- ') || l.startsWith('* '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
    if (!memory) body.innerHTML = '<div class="kiki-empty">读取失败</div>';
    else if (items.length === 0) body.innerHTML = '<div class="kiki-empty">还没有记忆,点下面添加一条</div>';
    for (const [i, text] of items.entries()) {
      const row = document.createElement('div');
      row.className = 'kiki-memo';
      row.textContent = text;
      let pressTimer: ReturnType<typeof setTimeout> | null = null;
      const arm = () => {
        pressTimer = setTimeout(() => {
          if (!window.confirm(`删除这条记忆？\n${text}`)) return;
          const next = items.filter((_, j) => j !== i);
          void post('/api/memory', { content: next.map((t) => `- ${t}`).join('\n') + '\n' }).then(renderKiki);
        }, 550);
      };
      const disarm = () => {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
      };
      row.addEventListener('pointerdown', arm);
      row.addEventListener('pointerup', disarm);
      row.addEventListener('pointercancel', disarm);
      row.addEventListener('pointerleave', disarm);
      body.appendChild(row);
    }
    const add = document.createElement('button');
    add.className = 'kiki-add';
    add.textContent = '+ 添加一条';
    add.addEventListener('click', () => {
      const input = document.createElement('textarea');
      input.className = 'kiki-editor';
      input.rows = 2;
      input.placeholder = '值得长期记住的偏好、事实、约定…';
      const ok = document.createElement('button');
      ok.className = 'kiki-add primary';
      ok.textContent = '保存';
      body.append(input, ok);
      input.focus();
      ok.addEventListener('click', () => {
        const t = input.value.trim();
        if (!t) return;
        const next = [...items, t];
        void post('/api/memory', { content: next.map((x) => `- ${x}`).join('\n') + '\n' }).then(renderKiki);
      });
    });
    body.appendChild(add);
    scroll.appendChild(wrap);
  }

  // ---- 组 2:我的分身与团队(agent 列表 + SA 核心文件四行) ----
  {
    const { wrap, body } = kikiGroup('我的分身与团队');
    if (agents === null) {
      body.innerHTML = '<div class="kiki-empty">agent 列表加载失败</div>';
    } else {
      if (agents.length === 0) body.innerHTML = '<div class="kiki-empty">还没有常驻分身，桌面端可创建</div>';
      for (const a of agents) {
        const row = document.createElement('button');
        row.className = 'kiki-agent';
        row.innerHTML = `<span class="kiki-agent-ava">${a.avatar || '🤖'}</span><span class="kiki-agent-main"><b>${a.name}</b><i>${a.description || ''}</i></span><span class="kiki-chev">›</span>`;
        row.addEventListener('click', () => {
          body.innerHTML = '';
          const back = document.createElement('button');
          back.className = 'kiki-add';
          back.textContent = '‹ 返回列表';
          back.addEventListener('click', () => void renderKiki());
          const nameEl = document.createElement('div');
          nameEl.className = 'kiki-agent-edit-name';
          nameEl.textContent = `${a.avatar || '🤖'} ${a.name}`;
          const label = document.createElement('div');
          label.className = 'kiki-group-title';
          label.textContent = '能力定义';
          const editor = makeKikiEditor(
            () => getJson<{ content: string }>(`/api/agent-md?id=${encodeURIComponent(a.id)}`).then((r) => r.content),
            (content) => post('/api/agent-md', { id: a.id, content }).then(() => undefined),
          );
          body.append(back, nameEl, label, editor);
        });
        body.appendChild(row);
      }
    }
    const saFiles = document.createElement('div');
    saFiles.className = 'kiki-sa-files';
    const filesHead = document.createElement('div');
    filesHead.className = 'kiki-group-title';
    filesHead.textContent = 'Super Agent 的核心文件';
    saFiles.appendChild(filesHead);
    for (const f of KI_FILES) {
      const row = document.createElement('button');
      row.className = 'kiki-file';
      row.innerHTML = `<span>${f.label}</span><span class="kiki-chev">›</span>`;
      row.addEventListener('click', () => {
        body.innerHTML = '';
        const back = document.createElement('button');
        back.className = 'kiki-add';
        back.textContent = '‹ 返回';
        back.addEventListener('click', () => void renderKiki());
        const label = document.createElement('div');
        label.className = 'kiki-group-title';
        label.textContent = f.label;
        const editor = makeKikiEditor(
          () => getJson<{ content: string }>(`/api/sa/file?name=${encodeURIComponent(f.key)}`).then((r) => r.content),
          (content) => post('/api/sa/file', { name: f.key, content }).then(() => undefined),
        );
        body.append(back, label, editor);
      });
      saFiles.appendChild(row);
    }
    body.appendChild(saFiles);
    scroll.appendChild(wrap);
  }

  // ---- 组 3:偏好与配置 ----
  {
    const { wrap, body } = kikiGroup('偏好与配置');
    if (!settings) {
      body.innerHTML = '<div class="kiki-empty">配置加载失败</div>';
    } else {
      // 默认权限模式(常规/Auto/YOLO 三选)
      const modeRow = document.createElement('div');
      modeRow.className = 'kiki-pref-row';
      const modeLabel = document.createElement('span');
      modeLabel.textContent = '默认权限模式';
      const modeSeg = document.createElement('div');
      modeSeg.className = 'kiki-seg';
      for (const m of [
        { v: 'default', label: '常规' },
        { v: 'auto', label: 'Auto' },
        { v: 'yolo', label: 'YOLO' },
      ]) {
        const b = document.createElement('button');
        b.className = 'kiki-seg-item' + (settings.permissionMode === m.v ? ' on' : '');
        b.textContent = m.label;
        b.addEventListener('click', () => {
          void post('/api/settings', { permissionMode: m.v }).then(() => {
            settings.permissionMode = m.v;
            modeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          });
        });
        modeSeg.appendChild(b);
      }
      modeRow.append(modeLabel, modeSeg);
      body.appendChild(modeRow);
      // 默认模型
      const modelRow = document.createElement('div');
      modelRow.className = 'kiki-pref-row';
      const modelLabel = document.createElement('span');
      modelLabel.textContent = '默认模型';
      const modelSel = document.createElement('select');
      modelSel.className = 'kiki-select';
      const nullOpt = document.createElement('option');
      nullOpt.value = '';
      nullOpt.textContent = '跟随 kimi 默认';
      modelSel.appendChild(nullOpt);
      for (const o of settings.modelOptions) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.name;
        modelSel.appendChild(opt);
      }
      modelSel.value = settings.modelCurrent ?? '';
      modelSel.addEventListener('change', () => {
        void post('/api/settings', { modelCurrent: modelSel.value || null }).then(() => showToast('已保存', 2000));
      });
      modelRow.append(modelLabel, modelSel);
      body.appendChild(modelRow);
      // 默认思考深度(全局开关 on/off;级别由会话配置补)
      const thinkRow = document.createElement('div');
      thinkRow.className = 'kiki-pref-row';
      const thinkLabel = document.createElement('span');
      thinkLabel.textContent = '深度思考';
      const thinkCb = document.createElement('input');
      thinkCb.type = 'checkbox';
      thinkCb.checked = settings.thinking;
      thinkCb.addEventListener('change', () => {
        void post('/api/settings', { thinking: thinkCb.checked }).then(() => showToast('已保存', 2000));
      });
      thinkRow.append(thinkLabel, thinkCb);
      body.appendChild(thinkRow);
      // 语音播报开关(本地 kimi-remote-tts,与全局菜单同源)
      const ttsRow = document.createElement('div');
      ttsRow.className = 'kiki-pref-row';
      const ttsLabel = document.createElement('span');
      ttsLabel.textContent = '语音播报';
      const ttsCb = document.createElement('input');
      ttsCb.type = 'checkbox';
      ttsCb.checked = ttsEnabled;
      ttsCb.addEventListener('change', () => {
        ttsEnabled = ttsCb.checked;
        localStorage.setItem(TTS_KEY, ttsEnabled ? '1' : '0');
        if (!ttsEnabled) stopTts();
        syncTtsToggle();
      });
      ttsRow.append(ttsLabel, ttsCb);
      body.appendChild(ttsRow);
    }
    scroll.appendChild(wrap);
  }

  // ---- 组 4:设备与连接(免配对:设备名 / 局域网地址 / HTTPS 指引) ----
  {
    const { wrap, body } = kikiGroup('设备与连接');
    // 设备名(localStorage,可改;标识本机用)
    const nameRow = document.createElement('div');
    nameRow.className = 'kiki-pref-row';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '设备名';
    const nameInput = document.createElement('input');
    nameInput.className = 'kiki-text-input';
    nameInput.value = localStorage.getItem(DEVICE_KEY) ?? '我的手机';
    nameInput.addEventListener('change', () => {
      localStorage.setItem(DEVICE_KEY, nameInput.value.trim() || '我的手机');
      showToast('已保存', 2000);
    });
    nameRow.append(nameLabel, nameInput);
    body.appendChild(nameRow);
    // 局域网地址(当前连接地址;同一 Wi-Fi 下其他设备浏览器打开即用)
    const addrRow = document.createElement('div');
    addrRow.className = 'kiki-pref-row';
    const addrLabel = document.createElement('span');
    addrLabel.textContent = '局域网地址';
    const addrVal = document.createElement('span');
    addrVal.className = 'kiki-device-time';
    addrVal.textContent = location.origin;
    addrRow.append(addrLabel, addrVal);
    body.appendChild(addrRow);
    // HTTPS 指引(语音需要 secure context)
    const actions = document.createElement('div');
    actions.className = 'kiki-device-actions';
    const https = document.createElement('button');
    https.className = 'kiki-add';
    https.textContent = 'HTTPS 指引';
    https.addEventListener('click', openHttpsGuide);
    actions.append(https);
    body.appendChild(actions);
    scroll.appendChild(wrap);
  }
}

// ---------- PWA 提示(用 moon toast) ----------

function maybeShowPwaHint(): void {
  if (localStorage.getItem('kimi-remote-pwa-hint')) return;
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (standalone) return;
  localStorage.setItem('kimi-remote-pwa-hint', '1');
  setTimeout(() => showToast('提示：Safari 底部分享 →「添加到主屏幕」体验更好', 6000), 3000);
}

// ---------- boot ----------

setSpace(space); // 恢复上次的空间(localStorage kimi-remote-space;旧 view-mode 键已迁移)

(async () => {
  try {
    await moon.init();
    updateDateAndPhase();
  } catch (err) {
    console.error('Moon init failed:', err);
    showToast('月球资源加载失败');
  }
  window.setInterval(updateDateAndPhase, 30 * 60_000); // 跨天自检:日期/月相文案 + tab 月相图标
  // 免配对:直接连(LAN 内打开即用)
  hub.reconnect();
  void loadTree();
  startSaStatusTick();
  maybeShowPwaHint();
})();
