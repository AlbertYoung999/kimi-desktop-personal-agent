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
  /** chat = 用户在对话窗主动创建；auto = 后台/工作台/任务会话（默认） */
  kind?: 'chat' | 'auto';
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
  /** true = session 正在执行中，走 resume 不打断，输出实时流式显示 */
  live?: boolean;
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
  detail?: string; // short params preview
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
  pillMove: 'pill:move',
  setChatPinned: 'window:set-chat-pinned',
  getChatPinned: 'window:get-chat-pinned',
  openExternal: 'shell:open-external',
  showImagePreview: 'preview:show',
  getPreviewImage: 'preview:get',
  closePreview: 'preview:close',
  loadSessionInChat: 'ui:load-session',
  // workbench
  toggleWorkbench: 'wb:toggle',
  wbGetLayout: 'wb:get-layout',
  wbSaveLayout: 'wb:save-layout',
  wbTasksList: 'wb:tasks-list',
  wbTaskSave: 'wb:task-save',
  wbTaskDelete: 'wb:task-delete',
  wbProjectsList: 'wb:projects-list',
  wbProjectSave: 'wb:project-save',
  wbProjectDelete: 'wb:project-delete',
  wbTaskStartSession: 'wb:task-start-session',
  wbOpenSessionInChat: 'wb:open-session-in-chat',
  wbGetEngines: 'wb:get-engines',
  wbSaveEngine: 'wb:save-engine',
  wbDeleteEngine: 'wb:delete-engine',
  wbSearchLaunch: 'wb:search-launch',
  wbFocusLog: 'wb:focus-log',
  wbFocusHistory: 'wb:focus-history',
  wbAgentsRead: 'wb:agents-read',
  wbAgentsWrite: 'wb:agents-write',
  wbAcpAsk: 'wb:acp-ask',
  evWbAction: 'wb:action',
  wbActionResult: 'wb:action-result',
  evWbRefresh: 'wb:refresh',
  setSessionAllow: 'acp:set-session-allow',
  setSessionKind: 'acp:set-session-kind',
  evArtifactUpdated: 'wb:artifact-updated',
  evArtifactProgress: 'wb:artifact-progress',
  wbEvolveLog: 'wb:evolve-log',
  evWbNotify: 'wb:notify',
  // home (voice-first entry)
  homeAsk: 'home:ask',
  toggleHome: 'home:toggle',
  ttsSpeak: 'tts:speak',
  ttsStop: 'tts:stop',
  evSysStats: 'sys:stats',
  // focus pill (dynamic-island style status bar)
  focusStatus: 'focus:status',
  evFocusStatus: 'focus:status-push',
  // radar (P1)
  wbRadarList: 'wb:radar-list',
  wbRadarSave: 'wb:radar-save',
  wbRadarDelete: 'wb:radar-delete',
  wbRadarRunNow: 'wb:radar-run-now',
  evRadarItems: 'wb:radar-items',
  // forge (P1)
  wbForgeGenerate: 'wb:forge-generate',
  wbLibraryList: 'wb:library-list',
  wbLibraryAdd: 'wb:library-add',
  wbLibraryDelete: 'wb:library-delete',
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
