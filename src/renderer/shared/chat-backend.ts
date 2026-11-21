/**
 * ChatBackend —— createChatPanel 的可插拔后端接口。
 * 桌面端实现见 backend-electron.ts(window.kimi / Electron preload);
 * 远程端(手机网页)由远程适配器按此契约实现(HTTP/SSE)。
 * 契约面向远程适配器冻结,改动需两端同步。
 */

export interface ChatBackendImage {
  data: string;
  mimeType: string;
}

export interface ChatBackend {
  loadSession(sid: string): Promise<{
    meta: any;
    history: { role: 'user' | 'agent'; text: string }[];
    live?: boolean;
  }>;
  newSession(): Promise<any>;
  prompt(sid: string, text: string, modeId: string | null, images: ChatBackendImage[] | null): Promise<void>;
  cancel(sid: string): Promise<void>;
  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string, optionId?: string): void;
  listModes(): Promise<{ id: string; icon: string; name: string; prompt?: string }[]>;
  getSessionMode(sid: string): Promise<{ mode: string; source: 'session' | 'global' }>;
  setSessionMode(sid: string, mode: string | null): Promise<void>;
  getSessionModel(sid: string): Promise<{ model: string | null; source: 'session' | 'default' }>;
  setSessionModel(sid: string, model: string | null): Promise<void>;
  getSessionThinking(sid: string): Promise<{ thinking: string; source: 'session' | 'global' }>;
  setSessionThinking(sid: string, thinking: string | null): Promise<void>;
  modelOptions(): Promise<{ value: string; name: string }[]>;
  onChunk(cb: (e: { sessionId: string; kind: string; text: string }) => void): void;
  onToolCall(cb: (e: { sessionId: string; toolCallId: string; title: string; status: string }) => void): void;
  onTurnDone(cb: (e: { sessionId: string; stopReason?: string }) => void): void;
  onPermission(cb: (e: {
    requestId: string;
    sessionId: string;
    title: string;
    description: string;
    options?: { optionId: string; name: string; kind: string }[];
  }) => void): void;
  onSessionMode(cb: (e: { sessionId: string; modeId: string | null }) => void): void;
  onSessionModel(cb: (e: { sessionId: string; model: string }) => void): void;
  onSessionThinking(cb: (e: { sessionId: string; thinking: string }) => void): void;
}

/**
 * 宿主专属能力(与对话后端无关,由运行环境提供)。
 * 全部可选:缺省时工厂对应 UI 隐藏(截图按钮)或 no-op(球状态/TTS)。
 */
export interface ChatHost {
  /** 区域截图(桌面);无则隐藏截图按钮 */
  captureRegion?(): Promise<ChatBackendImage | null>;
  /** 系统浏览器打开链接;缺省回退 window.open */
  openExternal?(url: string): void;
  /** 桌面悬浮球状态(桌面专属);缺省 no-op */
  setBallState?(state: string): void;
  /** TTS 播报(桌面);缺省跳过播报 */
  ttsSpeak?(text: string, lang?: 'zh' | 'en'): Promise<void>;
  ttsStop?(): void;
  /** TTS 门控设置;缺省跳过播报 */
  getSettings?(): Promise<{ ttsEnabled?: boolean; ttsEnabledChat?: boolean; mainSessionId?: string }>;
  /** 悬浮窗打开事件(桌面);缺省不订阅 */
  onOpenChat?(cb: () => void): void;
  /** 系统级截图粘贴事件(桌面);缺省不订阅(网页 paste 事件工厂自带) */
  onImagePasted?(cb: (img: ChatBackendImage) => void): void;
}
