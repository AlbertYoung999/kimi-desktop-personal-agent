/**
 * RemoteBackend —— createChatPanel 的 HTTP/SSE 后端适配器(ChatBackend 契约)。
 * 会话通道 SSE(/api/events?sid=)分发 chunk/tool/turn-done/permission;
 * 全局通道 SSE(/api/events)分发 permission + session-mode/model/thinking;
 * 连接管理复用断线退避封装(1s→2s→5s→15s,reconnect() 立即重连)。
 * lastLoad 缓存最近一次 open-session 结果,宿主(moon 模式)免二次调用直接同步。
 */

import type { ChatBackend, ChatBackendImage } from '../shared/chat-backend';

// ---------- SSE 事件联合(契约 + 20261122 配置回传三类) ----------

export type RemoteSseEvent =
  | { type: 'chunk'; sessionId: string; kind: 'user' | 'agent' | 'thought'; text: string }
  | { type: 'tool'; sessionId: string; toolCallId?: string; title: string; status: string }
  | { type: 'turn-done'; sessionId: string; stopReason?: string }
  | {
      type: 'permission';
      sessionId?: string;
      requestId: string;
      title: string;
      description?: string;
      options?: { optionId: string; name: string; kind: string }[];
    }
  | { type: 'tree-changed' }
  | { type: 'session-mode'; sessionId: string; modeId: string | null }
  | { type: 'session-model'; sessionId: string; model: string }
  | { type: 'session-thinking'; sessionId: string; thinking: string }
  | { type: 'error'; sessionId?: string; error: string };

// ---------- SSE 封装(断线退避;与宿主原实现同款) ----------

interface SseHandle {
  close(): void;
  reconnect(): void;
}
const SSE_DELAYS = [1000, 2000, 5000, 15000];

function connectSSE(urlFn: () => string, onEvent: (e: RemoteSseEvent) => void, onOpen?: () => void): SseHandle {
  let es: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let timer = 0;
  function open(): void {
    if (closed) return;
    es = new EventSource(urlFn()); // 每次(重)连都重新取 URL(token 配对后会变)
    es.onopen = () => {
      attempt = 0;
      onOpen?.();
    };
    es.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data as string) as RemoteSseEvent);
      } catch {
        /* 坏帧跳过 */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      const delay = SSE_DELAYS[Math.min(attempt, SSE_DELAYS.length - 1)];
      attempt++;
      timer = window.setTimeout(open, delay);
    };
  }
  open();
  return {
    close() {
      closed = true;
      window.clearTimeout(timer);
      es?.close();
    },
    reconnect() {
      window.clearTimeout(timer);
      es?.close();
      es = null;
      attempt = 0;
      open();
    },
  };
}

// ---------- hub ----------

export interface RemoteHub {
  backend: ChatBackend;
  /** 切 session:换会话 SSE 通道(全局通道常驻) */
  attachSession(sid: string | null): void;
  /** 宿主(moon 模式/状态条)订阅 fan-out;工厂经 backend.on* 走同一事件流 */
  onSessionEvent(cb: (e: RemoteSseEvent) => void): void;
  onGlobalEvent(cb: (e: RemoteSseEvent) => void): void;
  /** visibility/online/配对成功后立即重连两条通道 */
  reconnect(): void;
  /** 最近一次 loadSession 适配结果(宿主免二次 open-session 直接同步) */
  lastLoad: { sid: string; history: { role: 'user' | 'agent'; text: string }[]; live: boolean } | null;
}

export function createRemoteBackend(opts: {
  token: () => string;
  /** newSession 的 cwd:当前选中 session 的项目目录(无选中时返回 '') */
  getCwd: () => string;
  onUnauthorized: () => void;
}): RemoteHub {
  const sessionCbs: ((e: RemoteSseEvent) => void)[] = [];
  const globalCbs: ((e: RemoteSseEvent) => void)[] = [];
  const chunkCbs: Parameters<ChatBackend['onChunk']>[0][] = [];
  const toolCbs: Parameters<ChatBackend['onToolCall']>[0][] = [];
  const turnDoneCbs: Parameters<ChatBackend['onTurnDone']>[0][] = [];
  const permCbs: Parameters<ChatBackend['onPermission']>[0][] = [];
  const sessionModeCbs: Parameters<ChatBackend['onSessionMode']>[0][] = [];
  const sessionModelCbs: Parameters<ChatBackend['onSessionModel']>[0][] = [];
  const sessionThinkingCbs: Parameters<ChatBackend['onSessionThinking']>[0][] = [];
  const seenPermIds = new Set<string>(); // 会话/全局双通道的 permission 去重

  let sessionSse: SseHandle | null = null;
  let sessionSid: string | null = null;

  function dispatchSession(e: RemoteSseEvent): void {
    for (const cb of sessionCbs) cb(e);
    if (e.type === 'chunk') for (const cb of chunkCbs) cb(e);
    else if (e.type === 'tool') {
      for (const cb of toolCbs) cb({ sessionId: e.sessionId, toolCallId: e.toolCallId ?? '', title: e.title, status: e.status });
    } else if (e.type === 'turn-done') for (const cb of turnDoneCbs) cb(e);
    else if (e.type === 'permission') dispatchPerm(e);
  }

  function dispatchGlobal(e: RemoteSseEvent): void {
    for (const cb of globalCbs) cb(e);
    if (e.type === 'permission') dispatchPerm(e);
    else if (e.type === 'session-mode') for (const cb of sessionModeCbs) cb(e);
    else if (e.type === 'session-model') for (const cb of sessionModelCbs) cb(e);
    else if (e.type === 'session-thinking') for (const cb of sessionThinkingCbs) cb(e);
  }

  function dispatchPerm(e: Extract<RemoteSseEvent, { type: 'permission' }>): void {
    if (seenPermIds.has(e.requestId)) return;
    seenPermIds.add(e.requestId);
    for (const cb of permCbs) {
      cb({
        requestId: e.requestId,
        sessionId: e.sessionId ?? '',
        title: e.title,
        description: e.description ?? '',
        options: e.options,
      });
    }
  }

  const globalSse = connectSSE(
    () => `/api/events?token=${encodeURIComponent(opts.token())}`,
    dispatchGlobal,
  );

  function attachSession(sid: string | null): void {
    if (sid === sessionSid) return;
    sessionSid = sid;
    sessionSse?.close();
    sessionSse = null;
    if (sid) {
      sessionSse = connectSSE(
        () => `/api/events?token=${encodeURIComponent(opts.token())}&sid=${encodeURIComponent(sid)}`,
        dispatchSession,
      );
    }
  }

  // ---------- REST ----------

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${opts.token()}` } });
    if (res.status === 401) {
      opts.onUnauthorized();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token()}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      opts.onUnauthorized();
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

  interface SessionConfigResp {
    mode?: { value: string; source?: string };
    model?: { value: string | null; source?: string };
    thinking?: { value: string | null; source?: string };
  }

  const hub: RemoteHub = {
    lastLoad: null,
    attachSession,
    onSessionEvent: (cb) => sessionCbs.push(cb),
    onGlobalEvent: (cb) => globalCbs.push(cb),
    reconnect() {
      globalSse.reconnect();
      sessionSse?.reconnect();
    },
    backend: {
      async loadSession(sid) {
        const r = await post<
          | { mode: 'history'; messages: { role: 'user' | 'agent'; text: string }[] }
          | { mode: 'live'; buffered: string[] }
          | { mode: 'stale' }
        >('/api/open-session', { sid });
        const meta = { sessionId: sid, title: '', cwd: '', createdAt: 0, updatedAt: 0 };
        if (r.mode === 'stale') throw new Error('stale'); // 调用方(channel 宿主)负责退避重试
        if (r.mode === 'live') {
          hub.lastLoad = { sid, history: [], live: true };
          return { meta, history: [], live: true };
        }
        hub.lastLoad = { sid, history: r.messages, live: false };
        return { meta, history: r.messages };
      },
      async newSession() {
        const cwd = opts.getCwd();
        if (!cwd) throw new Error('请先选择一个会话（无法确定项目目录）');
        const r = await post<{ sessionId: string }>('/api/new-session', { cwd });
        return { sessionId: r.sessionId, cwd, title: '', createdAt: Date.now(), updatedAt: Date.now() };
      },
      prompt: (sid, text, modeId, images) =>
        post('/api/prompt', { sid, text, ...(modeId ? { modeId } : {}), ...(images?.length ? { images } : {}) }).then(() => undefined),
      cancel: (sid) => post('/api/cancel', { sid }).then(() => undefined),
      respondPermission(requestId, approved, _remember, _sessionId, optionId) {
        // 主进程按 optionId 直选;布尔 approved/remember 语义忽略(契约)
        void post('/api/permission-respond', {
          requestId,
          optionId: optionId ?? (approved ? 'allow' : 'reject'),
        }).catch(() => undefined);
      },
      listModes: () => getJson('/api/prompt-modes'),
      async getSessionMode(sid) {
        const r = await getJson<SessionConfigResp>(`/api/session-config?sid=${encodeURIComponent(sid)}`);
        return {
          mode: r.mode?.value ?? 'default',
          source: r.mode?.source === 'session' ? ('session' as const) : ('global' as const),
        };
      },
      setSessionMode: (sid, mode) =>
        post('/api/session-config', { sid, mode }).then(() => undefined),
      async getSessionModel(sid) {
        const r = await getJson<SessionConfigResp>(`/api/session-config?sid=${encodeURIComponent(sid)}`);
        return {
          model: r.model?.value ?? null,
          source: r.model?.source === 'session' ? ('session' as const) : ('default' as const),
        };
      },
      setSessionModel: (sid, model) =>
        post('/api/session-config', { sid, model }).then(() => undefined),
      async getSessionThinking(sid) {
        const r = await getJson<SessionConfigResp>(`/api/session-config?sid=${encodeURIComponent(sid)}`);
        return {
          thinking: r.thinking?.value ?? '',
          source: r.thinking?.source === 'session' ? ('session' as const) : ('global' as const),
        };
      },
      setSessionThinking: (sid, thinking) =>
        post('/api/session-config', { sid, thinking }).then(() => undefined),
      modelOptions: () => getJson('/api/model-options'),
      onChunk: (cb) => {
        chunkCbs.push(cb);
      },
      onToolCall: (cb) => {
        toolCbs.push(cb);
      },
      onTurnDone: (cb) => {
        turnDoneCbs.push(cb);
      },
      onPermission: (cb) => {
        permCbs.push(cb);
      },
      onSessionMode: (cb) => {
        sessionModeCbs.push(cb);
      },
      onSessionModel: (cb) => {
        sessionModelCbs.push(cb);
      },
      onSessionThinking: (cb) => {
        sessionThinkingCbs.push(cb);
      },
    },
  };

  return hub;
}

export type { ChatBackendImage };
