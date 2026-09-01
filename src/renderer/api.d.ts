import type {
  AppSettings,
  BallState,
  ChunkEvent,
  CursorPoint,
  LoadSessionResult,
  PermissionRequest,
  PresetMode,
  PromptImage,
  SessionMeta,
  ToolCallEvent,
  TurnDoneEvent,
  VaultEntry,
} from '../shared/types';
import type { FocusRecord, PomodoroSession, PomodoroState, Project, Radar, RadarItemsPush, SearchEngine, Task, WorkbenchLayout } from '../shared/workbench-types';

/** deep-focus live status, pushed workbench → main → focus pill */
export interface FocusStatus {
  active: boolean;
  mode: 'sprint' | 'deep' | 'breath';
  task: string;
  remainingMs: number;
  paused: boolean;
}

/** system stats pushed to the home page left rail */
export interface SysStats {
  cpuPct: number;
  memPct: number;
  memUsedGB: string;
  memTotalGB: string;
  uptimeMin: number;
  loadAvg: string;
  diskPct: number;
  netInKBs: number;
  netOutKBs: number;
  batteryPct: number; // -1 = no battery
  batteryCharging: boolean;
  wifiSsid: string;
  gpuModel: string;
  topProcs: { name: string; cpu: number }[];
}

/** window.kimi.wb — workbench bridge (typed loosely at call sites via these defs). */
export interface WbApi {
  getLayout(): Promise<WorkbenchLayout>;
  saveLayout(layout: WorkbenchLayout): Promise<void>;
  listTasks(): Promise<Task[]>;
  saveTask(task: Task): Promise<Task[]>;
  deleteTask(id: string): Promise<Task[]>;
  listProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<Project[]>;
  deleteProject(id: string): Promise<Project[]>;
  startTaskSession(payload: string): Promise<string>;
  openSessionInChat(sessionId: string): Promise<void>;
  getEngines(): Promise<SearchEngine[]>;
  saveEngine(engine: SearchEngine): Promise<SearchEngine[]>;
  deleteEngine(id: string): Promise<SearchEngine[]>;
  searchLaunch(urls: string[]): Promise<void>;
  focusLog(rec: FocusRecord): Promise<void>;
  focusHistory(): Promise<FocusRecord[]>;
  agentsRead(): Promise<string>;
  agentsWrite(content: string): Promise<void>;
  memoryRead(): Promise<string>;
  memoryWrite(content: string): Promise<void>;
  toolsList(): Promise<{ name: string; description: string; enabled: boolean }[]>;
  toolToggle(name: string, enabled: boolean): void;
  runBackup(): Promise<void>;
  acpAsk(text: string): Promise<string>;
  forgeGenerate(prompt: string): Promise<string>;
  radarList(): Promise<Radar[]>;
  radarSave(radar: Radar): Promise<Radar[]>;
  radarDelete(id: string): Promise<Radar[]>;
  radarRunNow(id: string): Promise<Radar[]>;
  libraryList(): Promise<LibraryItem[]>;
  libraryAdd(item: LibraryItem): Promise<LibraryItem[]>;
  libraryDelete(id: string): Promise<LibraryItem[]>;
}

export interface LibraryItem {
  id: string;
  title: string;
  html: string;
  createdAt: number;
}

/** progress of a background artifact_modify (main → workbench renderer) */
export interface ArtifactProgress {
  state: 'started' | 'done' | 'failed';
  title: string;
  message?: string;
  /** present on done: for stage pop-out */
  item?: { id: string; title: string; html: string };
}

/** reactive trigger output card (design-v4 §10.4: unified Reaction UI) */
export interface ReactionCard {
  id: string;
  kind: 'info' | 'success' | 'warn';
  title: string;
  body?: string;
  actions?: { label: string; action: string }[]; // action: 'open-widget:<id>' | 'dismiss'
}

/** generative presentation spec（design-v4 §12） */
export interface PresentSpec {
  kind: 'news-digest' | 'data-card' | 'gallery' | 'list' | 'custom';
  title: string;
  items?: { title: string; summary?: string; image?: string; url?: string; tag?: string }[];
  html?: string;
  actions?: { label: string; action: string }[];
}

/** tool call forwarded from the workbench MCP server to the renderer */
export interface WbActionCall {
  requestId: string;
  action: 'widget_open' | 'widget_close' | 'focus_start' | 'present_open' | 'present_dismiss';
  params: Record<string, unknown>;
}

/** window.kimi — exposed by preload. */
export interface KimiApi {
  getSettings(): Promise<AppSettings>;
  setSettings(s: Partial<AppSettings>): Promise<AppSettings>;
  pickWorkspaceDir(): Promise<string | null>;

  listSessions(): Promise<SessionMeta[]>;
  newSession(): Promise<SessionMeta>;
  loadSession(sessionId: string): Promise<LoadSessionResult>;
  prompt(sessionId: string, text: string, modeId: string | null, image: PromptImage | null): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string): void;

  listModes(): Promise<PresetMode[]>;
  saveMode(mode: PresetMode): Promise<PresetMode[]>;
  deleteMode(id: string): Promise<PresetMode[]>;

  vaultList(): Promise<VaultEntry[]>;
  vaultRead(relPath: string): Promise<string>;
  vaultWrite(relPath: string, content: string): Promise<void>;

  captureRegion(): Promise<PromptImage | null>;
  toggleChat(): void;
  hideChat(): void;
  setBallState(state: BallState): void;
  moveBall(x: number, y: number): void;
  movePill(x: number, y: number): void;
  setChatPinned(pinned: boolean): void;
  getChatPinned(): Promise<boolean>;
  openExternal(url: string): void;
  showImagePreview(src: string): void;
  getPreviewImage(): Promise<string | null>;
  closePreview(): void;
  toggleWorkbench(): void;
  onLoadSession(cb: (sessionId: string) => void): void;
  reportFocusStatus(status: FocusStatus): void;
  onFocusStatus(cb: (status: FocusStatus) => void): void;
  pomodoroStart(taskId: string, durationMin?: number): Promise<PomodoroState>;
  pomodoroStop(completed: boolean): Promise<PomodoroState>;
  pomodoroState(): Promise<PomodoroState>;
  pomodoroList(taskId?: string): Promise<PomodoroSession[]>;
  onPomodoroState(cb: (state: PomodoroState) => void): void;
  toggleTodoPanel(): void;
  resizeTodoPanel(width: number, height: number): void;
  /** 灵动岛收展：true 收成 pill，false 展开为面板 */
  todoPanelSetMode(collapsed: boolean): void;
  onTasksChanged(cb: () => void): void;
  onRadarItems(cb: (p: RadarItemsPush) => void): void;
  homeAsk(text: string): Promise<string>;
  homeAskImage(text: string, image: PromptImage): Promise<string>;
  mainHistory(): Promise<{ role: string; text: string; at: number }[]>;
  mainNew(): Promise<string>;
  ttsVoices(): Promise<{
    voices: string[];
    selectedEn: string;
    selectedZh: string;
    rate: string;
    provider: string;
    piperVoices: { id: string; label: string; cjk: boolean }[];
    piperEn: string;
    piperZh: string;
  }>;
  ttsSetVoice(en: string, zh: string, rate: string): void;
  ttsSetProvider(provider: 'piper' | 'say'): void;
  ttsSetPiperVoice(en: string, zh: string): void;
  ttsPreview(voice: string, cjk: boolean): Promise<void>;
  desktopSources(): Promise<{ id: string; name: string; thumbnail: string }[]>;
  onReactionCard(cb: (card: ReactionCard) => void): void;
  toggleHome(): void;
  ttsSpeak(text: string, lang?: 'zh' | 'en'): Promise<void>;
  ttsStop(): void;
  onSysStats(cb: (stats: SysStats) => void): void;
  onWbAction(cb: (call: WbActionCall) => void): void;
  wbRegisterWidgets(defs: { id: string; name: string; description: string }[]): void;
  wbActionResult(payload: { requestId: string; message: string }): void;
  onWbRefresh(cb: (p: { kind: 'tasks' | 'radars' }) => void): void;
  setSessionAllow(sessionId: string, allowed: boolean): void;
  setSessionKind(sessionId: string, kind: 'chat' | 'auto'): Promise<SessionMeta[]>;
  onArtifactUpdated(cb: (item: { id: string; title: string; html: string }) => void): void;
  onPresentArtifact(cb: (spec: PresentSpec) => void): void;
  onPresentOpen(cb: (target: { target: string }) => void): void;
  onPresentDismiss(cb: (target: { target: string }) => void): void;
  onArtifactProgress(cb: (p: ArtifactProgress) => void): void;
  onWbNotify(cb: (n: { kind: 'success' | 'error' | 'info'; message: string }) => void): void;
  onMainSession(cb: (p: { sessionId: string }) => void): void;
  setThinking(on: boolean): Promise<void>;
  wbEvolveLog(): Promise<{ at: number; tool: string; params: Record<string, unknown>; result: string }[]>;
  wb: WbApi;

  onCursor(cb: (p: CursorPoint) => void): void;
  onBallState(cb: (s: BallState) => void): void;
  onChunk(cb: (e: ChunkEvent) => void): void;
  onToolCall(cb: (e: ToolCallEvent) => void): void;
  onTurnDone(cb: (e: TurnDoneEvent) => void): void;
  onPermission(cb: (e: PermissionRequest) => void): void;
  onOpenChat(cb: () => void): void;
  onImagePasted(cb: (img: PromptImage) => void): void;
}

declare global {
  interface Window {
    kimi: KimiApi;
  }
}
