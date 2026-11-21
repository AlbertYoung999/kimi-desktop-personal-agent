/**
 * KIMI Remote — talking-to-the-moon 视觉移植版(P1)。
 * 视觉/交互骨架照搬 moon(#background/#stars/#moon-glow/#moon-container/顶栏/底栏/
 * result-card/toast/确认弹窗/历史浮层),后端换成我们的 REST + SSE(契约不变):
 * /api/pair /api/tree /api/open-session /api/prompt /api/cancel
 * /api/permission-respond /api/tts,SSE /api/events?sid= + /api/events。
 * 新增(moon 没有、我们必须):配对屏、底部抽屉式 session 切换器、权限审批卡、
 * busy(409)/held(423)提示、「重说」按钮、HTTPS 指引。
 * 断线策略:SSE 指数退避 1s→2s→5s→15s,visibility/online 立即重连并重同步。
 */

import { escapeHtml, mdToHtml } from '../shared/md';
import { createChatPanel, type ChatPanelHandle } from '../shared/chat-panel';
import type { ChatHost } from '../shared/chat-backend';
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

// ---------- token / api ----------

const TOKEN_KEY = 'kimi-remote-token';
const DEVICE_KEY = 'kimi-remote-device';
const TTS_KEY = 'kimi-remote-tts';
const SESSION_KEY = 'kimi-remote-session';
let token = localStorage.getItem(TOKEN_KEY) ?? '';

function clearToken(): void {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    clearToken();
    showPair();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearToken();
    showPair();
    throw new Error('unauthorized');
  }
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
const micBtn = $('mic-btn');
const textBtn = $('text-btn');
const transcriptModal = $('transcript-modal');
const transcriptTitle = $('transcript-title');
const transcriptInput = $('transcript-input') as unknown as HTMLTextAreaElement;
const transcriptRetry = $('transcript-retry') as HTMLButtonElement;
const permCard = $('perm-card');
const sessionBtn = $('session-btn');
const sessionDrawer = $('session-drawer');
const drawerTree = $('drawer-tree');
const pairOverlay = $('pair-overlay');
const guideModal = $('guide-modal');
const toolLine = $('tool-line');
const chatView = $('chat-view');
const cvPanel = $('cv-panel');
const menuDrawer = $('menu-drawer');

const TEXT_BTN_HTML = textBtn.innerHTML;

// ---------- 双界面模式(月之暗面 / 经典对话,共用全部后端状态) ----------

const VIEW_KEY = 'kimi-remote-view-mode';
type ViewMode = 'moon' | 'chat';
let viewMode: ViewMode = (localStorage.getItem(VIEW_KEY) as ViewMode) === 'chat' ? 'chat' : 'moon';

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  localStorage.setItem(VIEW_KEY, mode);
  chatView.classList.toggle('on', mode === 'chat');
  syncMenuRadios();
  if (mode === 'chat') {
    $('cv-title').textContent = currentSession ? sessLabel(currentSession) : '会话';
    syncVoiceMode(); // 恢复语音/文本形态(工厂输入区 ⇄ 按住说话)
    syncPermCard();
  } else {
    syncPermCard();
  }
}

function syncMenuRadios(): void {
  menuDrawer.querySelectorAll('.menu-radio').forEach((el) => {
    const on = (el as HTMLElement).dataset.mode === viewMode;
    el.classList.toggle('on', on);
    const input = el.querySelector('input')!;
    input.checked = on;
  });
}

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
}

let toastTimer = 0;
function showToast(message: string, ms = 4000): void {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
}

function setConnectionStatus(text: string): void {
  connectionStatus.textContent = text;
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
  sessionBtn.textContent = `${sessLabel(s)} ▾`;
  $('cv-title').textContent = sessLabel(s);
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
  liveMessages = l.history;
  if (l.live) {
    setStreaming(true);
    setConnectionStatus('思考中...');
    showToast('正在执行中，输出将实时显示…', 2500);
  } else {
    setStreaming(false);
  }
}

function setStreaming(on: boolean): void {
  streaming = on;
  // 流式中 text-btn 变停止键(moon 没有停止,这是契约里的 /api/cancel)
  if (on) {
    textBtn.textContent = '⏹';
    textBtn.title = '停止';
  } else {
    textBtn.innerHTML = TEXT_BTN_HTML;
    textBtn.title = '文字输入';
  }
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
  if (viewMode === 'moon') showResultCard('<span style="opacity:.5">思考中…</span>');
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

let transcriptFromVoice = false;

function showTranscriptModal(opts: { title: string; text: string; fromVoice: boolean }): void {
  transcriptTitle.textContent = opts.title;
  transcriptInput.value = opts.text;
  transcriptFromVoice = opts.fromVoice;
  transcriptRetry.style.display = opts.fromVoice ? '' : 'none';
  transcriptModal.classList.add('show');
  transcriptInput.focus();
}
function hideTranscriptModal(): void {
  transcriptModal.classList.remove('show');
  transcriptInput.value = '';
}
$('transcript-send').addEventListener('click', () => {
  const t = transcriptInput.value.trim();
  hideTranscriptModal();
  if (!t) return;
  if (viewMode === 'chat') {
    // 经典模式:灌进工厂输入框并发送(语音确认 → setInputText + sendNow)
    panel.setInputText(t);
    panel.sendNow();
  } else {
    void sendText(t);
  }
});
$('transcript-cancel').addEventListener('click', hideTranscriptModal);
transcriptRetry.addEventListener('click', () => {
  hideTranscriptModal();
  void startRecording();
});
transcriptModal.addEventListener('click', (e) => {
  if (e.target === transcriptModal) hideTranscriptModal();
});
textBtn.addEventListener('click', () => {
  if (streaming) {
    if (currentSession) {
      setConnectionStatus('已连接');
      void post('/api/cancel', { sid: currentSession.id }).catch(() => undefined);
      showToast('已停止', 2000);
    }
    return;
  }
  showTranscriptModal({ title: '文字输入', text: '', fromVoice: false });
});

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
$('history-btn').addEventListener('click', () => {
  renderHistory();
  historyModal.classList.add('show');
});
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
  if (!pendingPerm || viewMode === 'chat') return;
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

$('menu-btn').addEventListener('click', () => {
  syncMenuRadios();
  ($('menu-guide') as HTMLButtonElement).hidden = window.isSecureContext;
  menuDrawer.classList.add('show');
});
$('cv-menu').addEventListener('click', () => {
  syncMenuRadios();
  ($('menu-guide') as HTMLButtonElement).hidden = window.isSecureContext;
  menuDrawer.classList.add('show');
});
$('menu-close').addEventListener('click', () => menuDrawer.classList.remove('show'));
menuDrawer.addEventListener('click', (e) => {
  if (e.target === menuDrawer) menuDrawer.classList.remove('show');
});
menuDrawer.querySelectorAll('.menu-radio').forEach((el) => {
  el.addEventListener('click', () => {
    setViewMode((el as HTMLElement).dataset.mode as ViewMode);
    menuDrawer.classList.remove('show');
  });
});
$('menu-guide').addEventListener('click', () => {
  menuDrawer.classList.remove('show');
  openHttpsGuide();
});

// ---------- 微信式语音(语音模式 ⇄ 工厂输入区;「按住 说话」长条保留) ----------

const cvVoiceBar = $('cv-voice-bar');
const cvKbd = $('cv-kbd') as HTMLButtonElement;
const cvHold = $('cv-hold') as HTMLButtonElement;
const cvInterim = $('cv-interim');
const CV_INPUT_MODE_KEY = 'kimi-remote-cv-inputmode';
let cvInputMode: 'text' | 'voice' =
  localStorage.getItem(CV_INPUT_MODE_KEY) === 'voice' ? 'voice' : 'text';

/** 形态同步:voice → 隐藏工厂输入区(CSS .voice-mode)+ 显示长条;text → 恢复工厂输入区 */
function syncVoiceMode(): void {
  const voice = cvInputMode === 'voice';
  chatView.classList.toggle('voice-mode', voice);
  cvVoiceBar.hidden = !voice;
}

function setCvInputMode(mode: 'text' | 'voice'): void {
  cvInputMode = mode;
  localStorage.setItem(CV_INPUT_MODE_KEY, mode);
  syncVoiceMode();
  if (mode === 'voice' && !window.isSecureContext) {
    openHttpsGuide(); // 按住说话需要 secure context
  }
}

$('cv-back').addEventListener('click', () => setViewMode('moon'));
$('cv-voice-toggle').addEventListener('click', () =>
  setCvInputMode(cvInputMode === 'voice' ? 'text' : 'voice'),
);
cvKbd.addEventListener('click', () => setCvInputMode('text'));

/* ---- 按住说话(press-and-hold + 上滑取消,微信交互) ---- */
let holding = false;
let holdCancel = false;
let holdStartY = 0;
let suppressVoiceResult = false;

cvHold.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (holding) return;
  holding = true;
  holdCancel = false;
  holdStartY = e.clientY;
  try {
    cvHold.setPointerCapture(e.pointerId);
  } catch {
    /* 不支持 capture 也能工作 */
  }
  cvHold.classList.add('holding');
  suppressVoiceResult = false;
  void startRecording();
});
cvHold.addEventListener('pointermove', (e) => {
  if (!holding) return;
  const cancel = e.clientY - holdStartY < -60; // 上滑 60px 取消(微信同款)
  if (cancel !== holdCancel) {
    holdCancel = cancel;
    cvHold.classList.toggle('cancel', cancel);
    cvHold.textContent = cancel ? '松开取消' : '🎙 按住 说话';
  }
});
function endHold(): void {
  if (!holding) return;
  holding = false;
  cvHold.classList.remove('holding', 'cancel');
  cvHold.textContent = '🎙 按住 说话';
  if (holdCancel) {
    holdCancel = false;
    cancelVoice(); // 丢弃本次录音,不进确认弹窗
  } else {
    stopRecording(); // 正常结束 → 可编辑确认弹窗
  }
}
cvHold.addEventListener('pointerup', endHold);
cvHold.addEventListener('pointercancel', endHold);

/** 上滑取消:静默丢弃(abort + 抑制结果回调) */
function cancelVoice(): void {
  suppressVoiceResult = true;
  recognizer.abort();
  stopRecording();
}

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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (res.status === 503) {
      ttsUnavailable = true; // 静默降级为仅文字
      ttsPlaying = false;
      ttsQueue = [];
      return;
    }
    if (res.status === 401) {
      clearToken();
      showPair();
      ttsPlaying = false;
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
  token: () => token,
  getCwd: currentProjectCwd,
  onUnauthorized: () => {
    clearToken();
    showPair();
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

const panel: ChatPanelHandle = createChatPanel(cvPanel, {
  getSessionId: () => currentSession?.id ?? '',
  backend: hub.backend,
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
    $('cv-title').textContent = title;
  },
});

// ---------- 语音(speech.js 流程 + MediaRecorder 兜底) ----------

let isRecording = false;
let useRecorder = false;

async function startRecording(): Promise<void> {
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
  useRecorder = !recognizer.available && AudioRecorder.isSupported();
  micBtn.classList.add('recording');
  // 按住说话(语音模式):实时稿浮层显示在长条上方
  if (cvInputMode === 'voice') {
    cvInterim.textContent = '正在聆听…';
    cvInterim.hidden = false;
  }
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
  micBtn.classList.remove('recording');
  cvInterim.hidden = true;
  clearAudioVisuals();
  if (useRecorder) recorder.stop();
  else recognizer.stop();
}

micBtn.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else void startRecording();
});

recognizer.onResult = (text) => {
  cvInterim.hidden = true;
  if (suppressVoiceResult) {
    suppressVoiceResult = false; // 上滑取消:丢弃,不进确认弹窗
    return;
  }
  showTranscriptModal({ title: '识别结果', text, fromVoice: true });
};
recognizer.onError = (err) => {
  cvInterim.hidden = true;
  if (suppressVoiceResult && err === 'no-match') {
    suppressVoiceResult = false;
    return;
  }
  if (err === 'no-match') showToast('没听清，请重试');
  else if (err !== 'aborted') showToast(`语音错误: ${err}`);
};
recognizer.onInterim = (finalText, interim) => {
  // 按住说话:实时稿(定稿 + 灰色中间稿)显示在长条上方浮层
  if (cvInterim.hidden) return;
  cvInterim.innerHTML = '';
  cvInterim.append(document.createTextNode(finalText));
  if (interim) {
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = interim;
    cvInterim.appendChild(span);
  }
};
recorder.onResult = (base64, format) => {
  // 兜底上传 ASR(契约:/api/asr 本期 501 占位)
  void post('/api/asr', { audio: base64, format })
    .then(() => showToast('识别完成'))
    .catch(() => {
      showToast('语音兜底识别未就绪，请重说或打字');
      showTranscriptModal({ title: '识别结果(手动编辑)', text: '', fromVoice: true });
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
        sessionBtn.textContent = `${sessLabel(restored)} ▾`;
        hub.attachSession(restored.id);
        void panelSetSessionWithRetry(restored.id);
      } else {
        sessionBtn.textContent = '选择会话 ▾';
      }
    }
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
sessionBtn.addEventListener('click', openDrawer);
$('sessions-btn').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
sessionDrawer.addEventListener('click', (e) => {
  if (e.target === sessionDrawer) closeDrawer();
});
$('drawer-unpair').addEventListener('click', () => {
  if (!window.confirm('取消配对？再次使用需要重新输入配对码。')) return;
  clearToken();
  hub.attachSession(null); // 关会话通道(全局通道 401 后由配对流程重建)
  closeDrawer();
  showPair();
});

// ---------- 配对屏 ----------

const pairCode = $('pair-code') as unknown as HTMLInputElement;
const pairDevice = $('pair-device') as unknown as HTMLInputElement;
const pairErr = $('pair-err');
pairDevice.value = localStorage.getItem(DEVICE_KEY) ?? '';

function showPair(): void {
  pairOverlay.classList.remove('hide');
  pairCode.focus();
}

pairCode.addEventListener('input', () => {
  pairCode.value = pairCode.value.replace(/\D/g, '').slice(0, 6);
  if (pairCode.value.length === 6) void doPair();
});
pairCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void doPair();
});
$('pair-submit').addEventListener('click', () => void doPair());

async function doPair(): Promise<void> {
  const code = pairCode.value.trim();
  if (code.length !== 6) {
    pairErr.textContent = '请输入 6 位配对码';
    return;
  }
  pairErr.textContent = '';
  ($('pair-submit') as HTMLButtonElement).disabled = true;
  try {
    const deviceName = pairDevice.value.trim() || '我的手机';
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    });
    if (res.status === 401) {
      pairErr.textContent = '配对码无效或已过期';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { token: t } = (await res.json()) as { token: string };
    token = t;
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(DEVICE_KEY, deviceName);
    pairOverlay.classList.add('hide');
    hub.reconnect(); // 用新 token 重建两条 SSE 通道
    void loadTree();
    showToast('已连接');
  } catch (err) {
    pairErr.textContent = `配对失败：${String(err)}`;
  } finally {
    ($('pair-submit') as HTMLButtonElement).disabled = false;
  }
}

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
    if (viewMode === 'moon') showResultCard(mdToHtml(currentAgentText));
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
  if (!token || resyncTimer) return; // visibility/online/SSE 多处同时触发时 500ms 内合并
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
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resync();
});
window.addEventListener('online', () => resync());

// ---------- 背景/底栏 ----------

$('bg-prev').addEventListener('click', () => bgSwitcher.prev());
$('bg-next').addEventListener('click', () => bgSwitcher.next());

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

setViewMode(viewMode); // 恢复上次的界面样式(localStorage kimi-remote-view-mode)
syncVoiceMode(); // 恢复语音/文本形态(localStorage kimi-remote-cv-inputmode)

(async () => {
  try {
    await moon.init();
    updateDateAndPhase();
  } catch (err) {
    console.error('Moon init failed:', err);
    showToast('月球资源加载失败');
  }
  if (token) {
    pairOverlay.classList.add('hide');
    hub.reconnect(); // hub 创建时已有 token,确保通道活跃
    void loadTree();
  } else {
    showPair();
  }
  maybeShowPwaHint();
})();
