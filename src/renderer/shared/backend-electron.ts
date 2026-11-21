/// <reference path="../api.d.ts" />
import type { ChatBackend, ChatHost } from './chat-backend';

/**
 * Electron 桌面端适配器:把 window.kimi(preload 桥)原样包装为
 * ChatBackend + ChatHost,行为与工厂直连 window.kimi 逐点一致。
 */

export function createElectronBackend(): ChatBackend {
  return {
    loadSession: (sid) => window.kimi.loadSession(sid),
    newSession: () => window.kimi.newSession(),
    prompt: (sid, text, modeId, images) => window.kimi.prompt(sid, text, modeId, images),
    cancel: (sid) => window.kimi.cancel(sid),
    respondPermission: (requestId, approved, remember, sessionId, optionId) =>
      window.kimi.respondPermission(requestId, approved, remember, sessionId, optionId),
    listModes: () => window.kimi.listModes(),
    getSessionMode: (sid) => window.kimi.ch.getSessionMode(sid),
    setSessionMode: (sid, mode) => window.kimi.ch.setSessionMode(sid, mode as 'default' | 'auto' | 'yolo' | 'plan' | null),
    getSessionModel: (sid) => window.kimi.ch.getSessionModel(sid),
    setSessionModel: (sid, model) => window.kimi.ch.setSessionModel(sid, model),
    getSessionThinking: (sid) => window.kimi.ch.getSessionThinking(sid),
    setSessionThinking: (sid, thinking) =>
      window.kimi.ch.setSessionThinking(sid, thinking as 'low' | 'high' | 'max' | null),
    modelOptions: () => window.kimi.ch.modelOptions(),
    onChunk: (cb) => window.kimi.onChunk(cb),
    onToolCall: (cb) => window.kimi.onToolCall(cb),
    onTurnDone: (cb) => window.kimi.onTurnDone(cb),
    onPermission: (cb) => window.kimi.onPermission(cb),
    onSessionMode: (cb) => window.kimi.onSessionMode(cb),
    onSessionModel: (cb) => window.kimi.onSessionModel(cb),
    onSessionThinking: (cb) => window.kimi.onSessionThinking(cb),
  };
}

export function createElectronHost(): ChatHost {
  return {
    captureRegion: () => window.kimi.captureRegion(),
    openExternal: (url) => window.kimi.openExternal(url),
    setBallState: (state) => window.kimi.setBallState(state as Parameters<typeof window.kimi.setBallState>[0]),
    ttsSpeak: (text, lang) => window.kimi.ttsSpeak(text, lang),
    ttsStop: () => window.kimi.ttsStop(),
    getSettings: () => window.kimi.getSettings(),
    onOpenChat: (cb) => window.kimi.onOpenChat(cb),
    onImagePasted: (cb) => window.kimi.onImagePasted(cb),
  };
}
