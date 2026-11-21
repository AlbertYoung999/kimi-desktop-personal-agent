import type {
  AgentRecord,
  AppSettings,
  BallState,
  ChannelProjectRecord,
  ChannelTree,
  ChunkEvent,
  CursorPoint,
  GroupConfigPatch,
  GroupEvent,
  GroupMessage,
  GroupPlanResult,
  GroupRecord,
  LoadSessionResult,
  OpenSessionResult,
  PermissionRequest,
  PresetMode,
  PromptImage,
  RemoteDevice,
  RemoteInfo,
  SessionConfig,
  SessionConfigField,
  SessionMeta,
  ToolCallEvent,
  TurnDoneEvent,
  VaultEntry,
  WorktreeOpResult,
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
  /** v6.0 自主规划：task decomposition，600s 超时，返回全文（含 ```json 块） */
  planGenerate(prompt: string): Promise<string>;
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

/** window.kimi.ch — channel 模式桥 (v7.0, design/design-v7.md §7/§10) */
/** session 级权限模式覆盖(chat 面板头部开关);null = 清除覆盖回退全局 */
export type SessionPermMode = 'default' | 'auto' | 'yolo' | 'plan';
export interface ChApi {
  scan(): Promise<ChannelTree>;
  /** 统一会话入口:history(空闲 replay)/ live+ buffered(忙中)/ stale(令牌过期) */
  openSession(sessionId: string): Promise<OpenSessionResult>;
  /** 权限模式:即切即生效 + 落库;null 清除覆盖回退全局 */
  setSessionMode(sid: string, mode: SessionPermMode | null): Promise<void>;
  getSessionMode(sid: string): Promise<{ mode: string; source: 'session' | 'global' }>;
  /** 模型选择:即切即生效 + 落库;null 清除覆盖回退默认 */
  setSessionModel(sid: string, model: string | null): Promise<void>;
  getSessionModel(sid: string): Promise<{ model: string | null; source: 'session' | 'default' }>;
  /** 主进程缓存的 kimi 模型选项;空数组时面板隐藏模型按钮 */
  modelOptions(): Promise<{ value: string; name: string }[]>;
  /** 思考深度:即切即生效 + 落库;null 清除覆盖回退全局 */
  setSessionThinking(sid: string, thinking: 'low' | 'high' | 'max' | null): Promise<void>;
  getSessionThinking(sid: string): Promise<{ thinking: string; source: 'session' | 'global' }>;
  setPin(sessionId: string, pinned: boolean): Promise<void>;
  setProject(sessionId: string, projectId: string | null): Promise<void>;
  /** 更新 last_viewed_at(灭「有更新」圆点) */
  markViewed(sessionId: string): Promise<void>;
  projectCreate(name: string, path?: string): Promise<ChannelProjectRecord>;
  /** 原生目录选择器(新建项目用):返回 {name: 文件夹名, path} ,取消返回 null */
  pickFolder(): Promise<{ name: string; path: string } | null>;
  /** 历史归档:移入/恢复(channel_meta 显式标记,主→渲染 onChChanged 刷新) */
  archiveSession(sid: string, archived: boolean): Promise<void>;
  /** 在系统文件管理器中打开目录(shell.openPath,返回值同 Electron:空串=成功) */
  openPath(path: string): Promise<string>;
  /** per-session 权限模式:null=清除覆盖回退全局;立即生效(session 不在内存则落库待重放) */
  setSessionMode(sessionId: string, mode: 'default' | 'auto' | 'yolo' | 'plan' | null): Promise<void>;
  /** 无覆盖时返回全局值 + source='global' */
  getSessionMode(sessionId: string): Promise<{ mode: string; source: 'session' | 'global' }>;
  /** per-session 模型:null=清除覆盖跟随 kimi 默认;立即生效(session 不在内存则落库待重放) */
  setSessionModel(sessionId: string, model: string | null): Promise<void>;
  /** 无覆盖时返回 { model: null, source: 'default' } */
  getSessionModel(sessionId: string): Promise<{ model: string | null; source: 'session' | 'default' }>;
  /** 缓存的模型选项(kimi 2.0.1 实测 4 个);为空数组时渲染层自行兜底 */
  modelOptions(): Promise<{ value: string; name: string }[]>;
  // P2: 常驻 agent 库 + session 三配置 + 会话生命周期
  agentList(): Promise<AgentRecord[]>;
  agentCreate(name: string, description?: string): Promise<AgentRecord>;
  agentUpdate(id: string, patch: { description?: string; avatar?: string }): Promise<AgentRecord | null>;
  agentDelete(id: string): Promise<void>;
  /** 读 agent 的 AGENTS.md 全文 */
  agentRead(id: string): Promise<string>;
  agentWrite(id: string, content: string): Promise<void>;
  /** sid 解析不到 cwd(既不在运行时注册表也不在磁盘)时返回 null */
  sessionConfigRead(sessionId: string): Promise<SessionConfig | null>;
  sessionConfigWrite(sessionId: string, field: SessionConfigField, content: string): Promise<void>;
  /** channel 页建会话:指定 cwd,可绑定常驻 agent(首轮注入,等注入完成才返回) */
  newSession(opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }>;
  /** 阅后即焚清理:ACP 删除 + channel_meta + 三配置目录 */
  deleteSession(sessionId: string): Promise<void>;
  // P3a: group 协作 + 动态编排 + worktree + fork
  groupCreate(opts: { name: string; projectId?: string; cwd?: string; members: { sessionId: string; role?: string }[] }): Promise<GroupRecord>;
  groupList(projectId?: string): Promise<GroupRecord[]>;
  /** 立即返回;路由/回复/压缩经 onChGroupEvent 流式推送 */
  groupSend(groupId: string, text: string): Promise<void>;
  groupMessages(groupId: string): Promise<{ messages: GroupMessage[]; groupMd: string; group: GroupRecord } | null>;
  groupConfig(groupId: string, patch: GroupConfigPatch): Promise<GroupRecord | null>;
  groupAddMember(groupId: string, sessionId: string, role?: string): Promise<GroupRecord | null>;
  /** 描述创建成员:在 group cwd 下新建 session(注入角色 prompt),role=成员名 */
  groupCreateMember(groupId: string, opts: { name: string; description: string }): Promise<GroupRecord | null>;
  groupRemoveMember(groupId: string, sessionId: string): Promise<GroupRecord | null>;
  groupDelete(groupId: string): Promise<void>;
  /** 动态编排规划:JSON 成功 {ok:true, plan},失败 {ok:false, text} */
  groupPlan(opts: { taskDescription: string; memberSessionIds: string[] }): Promise<GroupPlanResult>;
  /** 「系统优先模式」文本(设置页可编辑,作为规划先验) */
  orchestrationPrefRead(): Promise<string>;
  orchestrationPrefWrite(text: string): Promise<void>;
  worktreeCreate(opts: { repoPath: string; taskSlug: string }): Promise<WorktreeOpResult>;
  worktreeList(repoPath: string): Promise<WorktreeOpResult>;
  worktreeDiff(repoPath: string, branch: string): Promise<WorktreeOpResult>;
  /** 合并进 repoPath 当前检出的分支;冲突时自动 abort 并返回 reason:'conflict' */
  worktreeMerge(opts: { repoPath: string; branch: string }): Promise<WorktreeOpResult>;
  worktreeDiscard(opts: { repoPath: string; path: string; branch: string }): Promise<WorktreeOpResult>;
  /** session/fork:分叉副本可加入 group */
  forkSession(sessionId: string): Promise<{ sessionId: string }>;
}

/** window.kimi.term — 终端三视图桥 (v7.0 P3b, design/design-v7.md §12) */
export interface TermApi {
  /** L3 内嵌终端:node-pty 跑 kimi --session;打开即 externallyHeld */
  open(sessionId: string): Promise<{ termId: string; cwd: string }>;
  input(termId: string, data: string): void;
  resize(termId: string, cols: number, rows: number): void;
  /** 视图关闭必须调用:kill pty + 释放 externallyHeld */
  close(termId: string): void;
  /** L1 观察视图:kimi vis;重复打开同 session 复用已有 */
  visOpen(sessionId: string): Promise<{ url: string; visId: string }>;
  visClose(visId: string): void;
  /** L2 外开终端:打开即 held;无法感知关闭,需用户点「交还」调 release */
  openExternal(sessionId: string): Promise<{ ok: boolean; app: 'iTerm' | 'Terminal' }>;
  release(sessionId: string): Promise<void>;
  isHeld(sessionId: string): Promise<boolean>;
}

/** window.kimi.rm — 移动远程控制管理面(prd/PRD-mobile-remote.md) */
export interface RmApi {
  /** RemoteBridge 状态 + 局域网地址 + 当前配对码(没有/过期会自动生成) */
  getInfo(): Promise<RemoteInfo>;
  /** 开关桥服务(写 settings.remoteEnabled;返回最新 info) */
  setEnabled(enabled: boolean): Promise<RemoteInfo>;
  /** 强制换配对码(旧码即废) */
  regenerateCode(): Promise<{ pairCode: string; ttl: number }>;
  listDevices(): Promise<RemoteDevice[]>;
  revokeDevice(id: string): Promise<void>;
}

/** window.kimi — exposed by preload. */
export interface KimiApi {
  getSettings(): Promise<AppSettings>;
  setSettings(s: Partial<AppSettings>): Promise<AppSettings>;
  pickWorkspaceDir(): Promise<string | null>;

  listSessions(): Promise<SessionMeta[]>;
  newSession(cwd?: string): Promise<SessionMeta>;
  loadSession(sessionId: string): Promise<LoadSessionResult>;
  prompt(sessionId: string, text: string, modeId: string | null, images: PromptImage[] | null): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string, optionId?: string): void;

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
  /** 权限模式回传(终端 TUI 改模式 / setSessionMode 回执),payload { sessionId, modeId } */
  onSessionMode(cb: (p: { sessionId: string; modeId: string }) => void): void;
  /** 模型回传(TUI 改模型 / setSessionModel 回执),payload { sessionId, model } */
  onSessionModel(cb: (p: { sessionId: string; model: string }) => void): void;
  setThinking(on: boolean): Promise<void>;
  wbEvolveLog(): Promise<{ at: number; tool: string; params: Record<string, unknown>; result: string }[]>;
  wb: WbApi;
  ch: ChApi;
  /** sessions 目录变化(debounce 2s),收到后重新 ch.scan() */
  onChChanged(cb: () => void): void;
  /** group 消息流:成员回复、轮次、压缩、错误(P3a) */
  onChGroupEvent(cb: (e: GroupEvent) => void): void;
  term: TermApi;
  onTermData(cb: (e: { termId: string; data: string }) => void): void;
  onTermExit(cb: (e: { termId: string; code: number }) => void): void;
  /** 移动远程控制管理面(prd/PRD-mobile-remote.md) */
  rm: RmApi;

  onCursor(cb: (p: CursorPoint) => void): void;
  onBallState(cb: (s: BallState) => void): void;
  onChunk(cb: (e: ChunkEvent) => void): void;
  onToolCall(cb: (e: ToolCallEvent) => void): void;
  onTurnDone(cb: (e: TurnDoneEvent) => void): void;
  onPermission(cb: (e: PermissionRequest) => void): void;
  /** 权限模式在别处(终端 TUI /yolo 等)切换时的同步事件;按 sessionId 过滤 */
  onSessionMode(cb: (p: { sessionId: string; modeId: SessionPermMode | null }) => void): void;
  /** 模型在别处切换时的同步事件;按 sessionId 过滤 */
  onSessionModel(cb: (e: { sessionId: string; model: string }) => void): void;
  /** 思考深度在别处切换时的同步事件;按 sessionId 过滤 */
  onSessionThinking(cb: (e: { sessionId: string; thinking: string }) => void): void;
  onOpenChat(cb: () => void): void;
  onImagePasted(cb: (img: PromptImage) => void): void;
}

declare global {
  interface Window {
    kimi: KimiApi;
  }
}
