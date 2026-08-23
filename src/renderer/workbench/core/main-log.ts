/**
 * 主会话共享日志（design-v4 §11 会话一致性）：home 的 EVENT LOG 和 zen 的
 * 消息框渲染同一份记录。全局唯一订阅 onChunk/onTurnDone，各页面只管展示。
 */

export interface MainLogEntry {
  role: 'you' | 'kimi';
  text: string;
  at: number;
}

const MAX_ENTRIES = 200;
const entries: MainLogEntry[] = [];
const subscribers = new Set<(entries: MainLogEntry[]) => void>();
let mainSid: string | null = null;
let localSendMark: string | null = null;
let initialized = false;

function notify(): void {
  for (const cb of subscribers) cb(entries);
}

/** 本窗口刚发送的消息文本；主进程回投的 kind:'user' chunk 命中则去重 */
export function markLocalSend(text: string): void {
  localSendMark = text;
}

export function subscribe(cb: (entries: MainLogEntry[]) => void): void {
  subscribers.add(cb);
  cb(entries);
}

export function getEntries(): MainLogEntry[] {
  return entries;
}

/** 最近一条用户消息文本（用于 TTS 选声：整段回复跟随用户语言） */
export function lastUserText(): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === 'you') return entries[i].text;
  }
  return '';
}

/** /new：开启新主会话——日志加分隔线，更新 mainSid */
export async function rotateMainSession(): Promise<void> {
  const newSid = await window.kimi.mainNew();
  mainSid = newSid;
  entries.push({ role: 'kimi', text: '── 新会话已开始 ──', at: Date.now() });
  notify();
}

export function initMainLog(): void {
  if (initialized) return;
  initialized = true;
  void window.kimi
    .getSettings()
    .then((s) => {
      mainSid = s.mainSessionId ?? null;
    })
    .catch(() => undefined);
  // 主会话轮换（/new、损坏重建）时主进程推送新 id，缓存永不过期
  window.kimi.onMainSession((p) => {
    mainSid = p.sessionId;
  });
  const isMain = (sid: string): boolean => mainSid == null || sid === mainSid;

  // 启动时回放主会话历史，重启后也能看到之前的对话（可上滑查看）
  void window.kimi.mainHistory().then((history) => {
    for (const h of history) {
      entries.push({ role: h.role === 'user' ? 'you' : 'kimi', text: h.text, at: h.at });
    }
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    notify();
  });

  window.kimi.onChunk((e) => {
    if (!isMain(e.sessionId)) return;
    if (e.kind === 'user') {
      // 回投去重：文本相同、或以「[附：…] 前缀 + 原文」形式回投（vision 附图消息）
      if (localSendMark !== null && (e.text === localSendMark || e.text.endsWith(localSendMark))) {
        localSendMark = null;
        return;
      }
      entries.push({ role: 'you', text: e.text, at: Date.now() });
    } else if (e.kind === 'text') {
      const last = entries[entries.length - 1];
      if (last && last.role === 'kimi') last.text += e.text;
      else entries.push({ role: 'kimi', text: e.text, at: Date.now() });
    } else {
      return;
    }
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    notify();
  });

  window.kimi.onTurnDone(() => {
    notify(); // 让页面有机会去掉流式态
  });
}
