// IPC contract shared between main / preload / renderer.

/** A preset mode = system prompt template + user input (modes.json). */
export interface PresetMode {
  id: string;
  name: string;
  icon: string; // emoji
  prompt: string;
  builtin: boolean;
}

/** Local index entry for a kimi session (sessions.json). */
export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  /** the single workspace folder for V1 */
  workspaceDir: string;
  /** vault directory for favorites/ideas (markdown) */
  vaultDir: string;
  /** permission mode sent via session/set_config_option */
  permissionMode: 'default' | 'auto' | 'yolo';
}

export interface PromptImage {
  data: string; // base64
  mimeType: string;
}

export interface HistoryItem {
  role: 'user' | 'agent';
  text: string;
}

export interface LoadSessionResult {
  meta: SessionMeta;
  history: HistoryItem[];
}

// ---- streaming events (main -> renderer) ----

export type ChunkKind = 'text' | 'thought';

export interface ChunkEvent {
  sessionId: string;
  kind: ChunkKind;
  text: string;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  title: string;
  status: string;
}

export interface TurnDoneEvent {
  sessionId: string;
  stopReason: string;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  title: string;
  description: string;
}

export interface VaultEntry {
  /** path relative to vaultDir */
  relPath: string;
  title: string;
  updatedAt: number;
}

// ---- channel names ----

export const IPC = {
  // invoke (renderer -> main, request/response)
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  pickWorkspaceDir: 'settings:pick-workspace',
  listSessions: 'acp:list-sessions',
  newSession: 'acp:new-session',
  loadSession: 'acp:load-session',
  prompt: 'acp:prompt',
  cancel: 'acp:cancel',
  permissionResponse: 'acp:permission-response',
  listModes: 'modes:list',
  saveMode: 'modes:save',
  deleteMode: 'modes:delete',
  vaultList: 'vault:list',
  vaultRead: 'vault:read',
  vaultWrite: 'vault:write',
  captureRegion: 'capture:region',
  toggleChat: 'window:toggle-chat',
  hideChat: 'window:hide-chat',
  setBallState: 'ball:set-state',
  ballMove: 'ball:move',
  setChatPinned: 'window:set-chat-pinned',
  getChatPinned: 'window:get-chat-pinned',
  openExternal: 'shell:open-external',
  // events (main -> renderer)
  evChunk: 'acp:chunk',
  evToolCall: 'acp:tool-call',
  evTurnDone: 'acp:turn-done',
  evPermission: 'acp:permission',
  evOpenChat: 'ui:open-chat',
  evImagePasted: 'ui:image-pasted',
  evCursor: 'ui:cursor',
  evBallState: 'ball:state',
} as const;

/** Ball avatar state, pushed from main (drives idle/thinking animations). */
export type BallState = 'idle' | 'thinking' | 'streaming';

export interface CursorPoint {
  x: number;
  y: number;
}
