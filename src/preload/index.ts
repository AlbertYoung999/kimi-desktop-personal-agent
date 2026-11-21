import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types.js';
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
  SessionConfig,
  SessionConfigField,
  SessionMeta,
  ToolCallEvent,
  TurnDoneEvent,
  VaultEntry,
  WorktreeOpResult,
} from '../shared/types.js';

const on = <T>(channel: string) => (cb: (payload: T) => void) => {
  ipcRenderer.on(channel, (_e, payload: T) => cb(payload));
};

contextBridge.exposeInMainWorld('kimi', {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (s: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.setSettings, s),
  pickWorkspaceDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickWorkspaceDir),

  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(IPC.listSessions),
  newSession: (cwd?: string): Promise<SessionMeta> => ipcRenderer.invoke(IPC.newSession, cwd),
  loadSession: (sessionId: string): Promise<LoadSessionResult> => ipcRenderer.invoke(IPC.loadSession, sessionId),
  prompt: (sessionId: string, text: string, modeId: string | null, images: PromptImage[] | null): Promise<void> =>
    ipcRenderer.invoke(IPC.prompt, sessionId, text, modeId, images),
  cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.cancel, sessionId),
  respondPermission: (requestId: string, approved: boolean, remember: boolean, sessionId: string, optionId?: string): void => {
    ipcRenderer.send(IPC.permissionResponse, { requestId, approved, remember, sessionId, optionId });
  },

  listModes: (): Promise<PresetMode[]> => ipcRenderer.invoke(IPC.listModes),
  saveMode: (mode: PresetMode): Promise<PresetMode[]> => ipcRenderer.invoke(IPC.saveMode, mode),
  deleteMode: (id: string): Promise<PresetMode[]> => ipcRenderer.invoke(IPC.deleteMode, id),

  vaultList: (): Promise<VaultEntry[]> => ipcRenderer.invoke(IPC.vaultList),
  vaultRead: (relPath: string): Promise<string> => ipcRenderer.invoke(IPC.vaultRead, relPath),
  vaultWrite: (relPath: string, content: string): Promise<void> => ipcRenderer.invoke(IPC.vaultWrite, relPath, content),

  captureRegion: (): Promise<PromptImage | null> => ipcRenderer.invoke(IPC.captureRegion),
  toggleChat: (): void => void ipcRenderer.send(IPC.toggleChat),
  hideChat: (): void => void ipcRenderer.send(IPC.hideChat),
  setBallState: (state: BallState): void => void ipcRenderer.send(IPC.setBallState, state),
  moveBall: (x: number, y: number): void => void ipcRenderer.send(IPC.ballMove, { x, y }),
  movePill: (x: number, y: number): void => void ipcRenderer.send(IPC.pillMove, { x, y }),
  setChatPinned: (pinned: boolean): void => void ipcRenderer.send(IPC.setChatPinned, pinned),
  getChatPinned: (): Promise<boolean> => ipcRenderer.invoke(IPC.getChatPinned),
  openExternal: (url: string): void => void ipcRenderer.send(IPC.openExternal, url),
  showImagePreview: (src: string): void => void ipcRenderer.send(IPC.showImagePreview, src),
  getPreviewImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.getPreviewImage),
  closePreview: (): void => void ipcRenderer.send(IPC.closePreview),

  // workbench
  toggleWorkbench: (): void => void ipcRenderer.send(IPC.toggleWorkbench),
  onLoadSession: on<string>(IPC.loadSessionInChat),
  reportFocusStatus: (status: unknown): void => void ipcRenderer.send(IPC.focusStatus, status),
  onFocusStatus: on<unknown>(IPC.evFocusStatus),
  // pomodoro by task + 今日待办桌面面板 (v5.0)
  pomodoroStart: (taskId: string, durationMin?: number): Promise<unknown> =>
    ipcRenderer.invoke(IPC.wbPomodoroStart, taskId, durationMin),
  pomodoroStop: (completed: boolean): Promise<unknown> => ipcRenderer.invoke(IPC.wbPomodoroStop, completed),
  pomodoroState: (): Promise<unknown> => ipcRenderer.invoke(IPC.wbPomodoroState),
  pomodoroList: (taskId?: string): Promise<unknown> => ipcRenderer.invoke(IPC.wbPomodoroList, taskId),
  onPomodoroState: on<unknown>(IPC.evPomodoroState),
  toggleTodoPanel: (): void => void ipcRenderer.send(IPC.toggleTodoPanel),
  resizeTodoPanel: (w: number, h: number): void => void ipcRenderer.send(IPC.resizeTodoPanel, w, h),
  todoPanelSetMode: (collapsed: boolean): void => void ipcRenderer.send(IPC.todoPanelMode, collapsed),
  onTasksChanged: on<void>(IPC.evTasksChanged),
  homeAsk: (text: string): Promise<string> => ipcRenderer.invoke(IPC.homeAsk, text),
  homeAskImage: (text: string, image: unknown): Promise<string> => ipcRenderer.invoke(IPC.homeAskImage, text, image),
  mainHistory: (): Promise<{ role: string; text: string; at: number }[]> => ipcRenderer.invoke(IPC.homeMainHistory),
  mainNew: (): Promise<string> => ipcRenderer.invoke(IPC.homeMainNew),
  ttsVoices: (): Promise<{ en: string[]; zh: string[]; selectedEn: string; selectedZh: string }> =>
    ipcRenderer.invoke(IPC.ttsVoices),
  ttsSetVoice: (en: string, zh: string, rate: string): void => void ipcRenderer.send(IPC.ttsSetVoice, { en, zh, rate }),
  ttsSetProvider: (provider: 'piper' | 'say'): void => void ipcRenderer.send(IPC.ttsSetProvider, { provider }),
  ttsSetPiperVoice: (en: string, zh: string): void => void ipcRenderer.send(IPC.ttsSetPiperVoice, { en, zh }),
  ttsPreview: (voice: string, cjk: boolean): Promise<void> => ipcRenderer.invoke(IPC.ttsPreview, { voice, cjk }),
  desktopSources: (): Promise<{ id: string; name: string; thumbnail: string }[]> => ipcRenderer.invoke(IPC.desktopSources),
  onReactionCard: on<unknown>(IPC.evReactionCard),
  toggleHome: (): void => void ipcRenderer.send(IPC.toggleHome),
  ttsSpeak: (text: string, lang?: 'zh' | 'en'): Promise<void> => ipcRenderer.invoke(IPC.ttsSpeak, text, lang),
  ttsStop: (): void => void ipcRenderer.send(IPC.ttsStop),
  onSysStats: on<unknown>(IPC.evSysStats),
  onWbAction: on<unknown>(IPC.evWbAction),
  wbRegisterWidgets: (defs: unknown): void => void ipcRenderer.send(IPC.wbRegisterWidgets, defs),
  wbActionResult: (payload: unknown): void => void ipcRenderer.send(IPC.wbActionResult, payload),
  onWbRefresh: on<unknown>(IPC.evWbRefresh),
  setSessionAllow: (sessionId: string, allowed: boolean): void =>
    void ipcRenderer.send(IPC.setSessionAllow, { sessionId, allowed }),
  setSessionKind: (sessionId: string, kind: 'chat' | 'auto'): Promise<unknown> =>
    ipcRenderer.invoke(IPC.setSessionKind, { sessionId, kind }),
  onArtifactUpdated: on<unknown>(IPC.evArtifactUpdated),
  onPresentArtifact: on<unknown>(IPC.evPresentArtifact),
  onPresentOpen: on<unknown>(IPC.evPresentOpen),
  onPresentDismiss: on<unknown>(IPC.evPresentDismiss),
  onArtifactProgress: on<unknown>(IPC.evArtifactProgress),
  onWbNotify: on<unknown>(IPC.evWbNotify),
  onMainSession: on<unknown>(IPC.evMainSession),
  onSessionMode: on<{ sessionId: string; modeId: string }>(IPC.evSessionMode),
  onSessionModel: on<{ sessionId: string; model: string }>(IPC.evSessionModel),
  onSessionThinking: on<{ sessionId: string; thinking: string }>(IPC.evSessionThinking),
  setThinking: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.setThinking, on),
  wbEvolveLog: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.wbEvolveLog),
  wb: {
    getLayout: () => ipcRenderer.invoke(IPC.wbGetLayout),
    saveLayout: (layout: unknown) => ipcRenderer.invoke(IPC.wbSaveLayout, layout),
    listTasks: () => ipcRenderer.invoke(IPC.wbTasksList),
    saveTask: (task: unknown) => ipcRenderer.invoke(IPC.wbTaskSave, task),
    deleteTask: (id: string) => ipcRenderer.invoke(IPC.wbTaskDelete, id),
    listProjects: () => ipcRenderer.invoke(IPC.wbProjectsList),
    saveProject: (project: unknown) => ipcRenderer.invoke(IPC.wbProjectSave, project),
    deleteProject: (id: string) => ipcRenderer.invoke(IPC.wbProjectDelete, id),
    startTaskSession: (payload: string): Promise<string> => ipcRenderer.invoke(IPC.wbTaskStartSession, payload),
    openSessionInChat: (sessionId: string) => ipcRenderer.invoke(IPC.wbOpenSessionInChat, sessionId),
    getEngines: () => ipcRenderer.invoke(IPC.wbGetEngines),
    saveEngine: (engine: unknown) => ipcRenderer.invoke(IPC.wbSaveEngine, engine),
    deleteEngine: (id: string) => ipcRenderer.invoke(IPC.wbDeleteEngine, id),
    searchLaunch: (urls: string[]) => ipcRenderer.invoke(IPC.wbSearchLaunch, urls),
    focusLog: (rec: unknown) => ipcRenderer.invoke(IPC.wbFocusLog, rec),
    focusHistory: () => ipcRenderer.invoke(IPC.wbFocusHistory),
    agentsRead: (): Promise<string> => ipcRenderer.invoke(IPC.wbAgentsRead),
    agentsWrite: (content: string) => ipcRenderer.invoke(IPC.wbAgentsWrite, content),
    memoryRead: (): Promise<string> => ipcRenderer.invoke(IPC.wbMemoryRead),
    memoryWrite: (content: string) => ipcRenderer.invoke(IPC.wbMemoryWrite, content),
    toolsList: () => ipcRenderer.invoke(IPC.wbToolsList),
    toolToggle: (name: string, enabled: boolean) => void ipcRenderer.send(IPC.wbToolToggle, { name, enabled }),
    runBackup: () => ipcRenderer.invoke(IPC.wbRunBackup),
    acpAsk: (text: string): Promise<string> => ipcRenderer.invoke(IPC.wbAcpAsk, text),
    forgeGenerate: (prompt: string): Promise<string> => ipcRenderer.invoke(IPC.wbForgeGenerate, prompt),
    planGenerate: (prompt: string): Promise<string> => ipcRenderer.invoke(IPC.wbPlanGenerate, prompt),
    libraryList: () => ipcRenderer.invoke(IPC.wbLibraryList),
    libraryAdd: (item: unknown) => ipcRenderer.invoke(IPC.wbLibraryAdd, item),
    libraryDelete: (id: string) => ipcRenderer.invoke(IPC.wbLibraryDelete, id),
    radarList: () => ipcRenderer.invoke(IPC.wbRadarList),
    radarSave: (radar: unknown) => ipcRenderer.invoke(IPC.wbRadarSave, radar),
    radarDelete: (id: string) => ipcRenderer.invoke(IPC.wbRadarDelete, id),
    radarRunNow: (id: string) => ipcRenderer.invoke(IPC.wbRadarRunNow, id),
  },

  onRadarItems: on<unknown>(IPC.evRadarItems),

  // channel 模式 (v7.0 P1)
  ch: {
    scan: (): Promise<ChannelTree> => ipcRenderer.invoke(IPC.chScan),
    openSession: (sessionId: string): Promise<OpenSessionResult> => ipcRenderer.invoke(IPC.chOpenSession, sessionId),
    setPin: (sessionId: string, pinned: boolean): Promise<void> => ipcRenderer.invoke(IPC.chSetPin, sessionId, pinned),
    setProject: (sessionId: string, projectId: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.chSetProject, sessionId, projectId),
    markViewed: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.chMarkViewed, sessionId),
    archiveSession: (sessionId: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.chArchiveSession, sessionId, archived),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke(IPC.chOpenPath, path),
    setSessionMode: (sessionId: string, mode: 'default' | 'auto' | 'yolo' | 'plan' | null): Promise<void> =>
      ipcRenderer.invoke(IPC.chSetSessionMode, sessionId, mode),
    getSessionMode: (sessionId: string): Promise<{ mode: string; source: 'session' | 'global' }> =>
      ipcRenderer.invoke(IPC.chGetSessionMode, sessionId),
    setSessionModel: (sessionId: string, model: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.chSetSessionModel, sessionId, model),
    getSessionModel: (sessionId: string): Promise<{ model: string | null; source: 'session' | 'default' }> =>
      ipcRenderer.invoke(IPC.chGetSessionModel, sessionId),
    modelOptions: (): Promise<{ value: string; name: string }[]> => ipcRenderer.invoke(IPC.chModelOptions),
    setSessionThinking: (sessionId: string, thinking: 'low' | 'high' | 'max' | null): Promise<void> =>
      ipcRenderer.invoke(IPC.chSetSessionThinking, sessionId, thinking),
    getSessionThinking: (sessionId: string): Promise<{ thinking: string; source: 'session' | 'global' }> =>
      ipcRenderer.invoke(IPC.chGetSessionThinking, sessionId),
    projectCreate: (name: string, path?: string): Promise<ChannelProjectRecord> =>
      ipcRenderer.invoke(IPC.chProjectCreate, name, path),
    pickFolder: (): Promise<{ name: string; path: string } | null> => ipcRenderer.invoke(IPC.chPickFolder),
    // P2: 常驻 agent 库 + session 三配置 + 会话生命周期
    agentList: (): Promise<AgentRecord[]> => ipcRenderer.invoke(IPC.chAgentList),
    agentCreate: (name: string, description?: string): Promise<AgentRecord> =>
      ipcRenderer.invoke(IPC.chAgentCreate, name, description),
    agentUpdate: (id: string, patch: { description?: string; avatar?: string }): Promise<AgentRecord | null> =>
      ipcRenderer.invoke(IPC.chAgentUpdate, id, patch),
    agentDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.chAgentDelete, id),
    agentRead: (id: string): Promise<string> => ipcRenderer.invoke(IPC.chAgentRead, id),
    agentWrite: (id: string, content: string): Promise<void> => ipcRenderer.invoke(IPC.chAgentWrite, id, content),
    sessionConfigRead: (sessionId: string): Promise<SessionConfig | null> =>
      ipcRenderer.invoke(IPC.chSessionConfigRead, sessionId),
    sessionConfigWrite: (sessionId: string, field: SessionConfigField, content: string): Promise<void> =>
      ipcRenderer.invoke(IPC.chSessionConfigWrite, sessionId, field, content),
    newSession: (opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke(IPC.chNewSession, opts),
    deleteSession: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.chDeleteSession, sessionId),
    // P3a: group 协作 + 动态编排 + worktree + fork
    groupCreate: (opts: { name: string; projectId?: string; cwd?: string; members: { sessionId: string; role?: string }[] }): Promise<GroupRecord> =>
      ipcRenderer.invoke(IPC.chGroupCreate, opts),
    groupList: (projectId?: string): Promise<GroupRecord[]> => ipcRenderer.invoke(IPC.chGroupList, projectId),
    groupSend: (groupId: string, text: string): Promise<void> => ipcRenderer.invoke(IPC.chGroupSend, groupId, text),
    groupMessages: (groupId: string): Promise<{ messages: GroupMessage[]; groupMd: string; group: GroupRecord } | null> =>
      ipcRenderer.invoke(IPC.chGroupMessages, groupId),
    groupConfig: (groupId: string, patch: GroupConfigPatch): Promise<GroupRecord | null> =>
      ipcRenderer.invoke(IPC.chGroupConfig, groupId, patch),
    groupAddMember: (groupId: string, sessionId: string, role?: string): Promise<GroupRecord | null> =>
      ipcRenderer.invoke(IPC.chGroupAddMember, groupId, sessionId, role),
    groupCreateMember: (groupId: string, opts: { name: string; description: string }): Promise<GroupRecord | null> =>
      ipcRenderer.invoke(IPC.chGroupCreateMember, groupId, opts),
    groupRemoveMember: (groupId: string, sessionId: string): Promise<GroupRecord | null> =>
      ipcRenderer.invoke(IPC.chGroupRemoveMember, groupId, sessionId),
    groupDelete: (groupId: string): Promise<void> => ipcRenderer.invoke(IPC.chGroupDelete, groupId),
    groupPlan: (opts: { taskDescription: string; memberSessionIds: string[] }): Promise<GroupPlanResult> =>
      ipcRenderer.invoke(IPC.chGroupPlan, opts),
    orchestrationPrefRead: (): Promise<string> => ipcRenderer.invoke(IPC.chOrchestrationPrefRead),
    orchestrationPrefWrite: (text: string): Promise<void> => ipcRenderer.invoke(IPC.chOrchestrationPrefWrite, text),
    worktreeCreate: (opts: { repoPath: string; taskSlug: string }): Promise<WorktreeOpResult> =>
      ipcRenderer.invoke(IPC.chWorktreeCreate, opts),
    worktreeList: (repoPath: string): Promise<WorktreeOpResult> => ipcRenderer.invoke(IPC.chWorktreeList, repoPath),
    worktreeDiff: (repoPath: string, branch: string): Promise<WorktreeOpResult> =>
      ipcRenderer.invoke(IPC.chWorktreeDiff, repoPath, branch),
    worktreeMerge: (opts: { repoPath: string; branch: string }): Promise<WorktreeOpResult> =>
      ipcRenderer.invoke(IPC.chWorktreeMerge, opts),
    worktreeDiscard: (opts: { repoPath: string; path: string; branch: string }): Promise<WorktreeOpResult> =>
      ipcRenderer.invoke(IPC.chWorktreeDiscard, opts),
    forkSession: (sessionId: string): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC.chForkSession, sessionId),
  },
  onChChanged: on<void>(IPC.evChChanged),
  onChGroupEvent: on<GroupEvent>(IPC.evChGroupEvent),

  // 终端三视图 (v7.0 P3b)
  term: {
    open: (sessionId: string): Promise<{ termId: string; cwd: string }> => ipcRenderer.invoke(IPC.termOpen, sessionId),
    input: (termId: string, data: string): void => void ipcRenderer.send(IPC.termInput, termId, data),
    resize: (termId: string, cols: number, rows: number): void =>
      void ipcRenderer.send(IPC.termResize, termId, cols, rows),
    close: (termId: string): void => void ipcRenderer.send(IPC.termClose, termId),
    visOpen: (sessionId: string): Promise<{ url: string; visId: string }> =>
      ipcRenderer.invoke(IPC.termVisOpen, sessionId),
    visClose: (visId: string): void => void ipcRenderer.send(IPC.termVisClose, visId),
    openExternal: (sessionId: string): Promise<{ ok: boolean; app: 'iTerm' | 'Terminal' }> =>
      ipcRenderer.invoke(IPC.termOpenExternal, sessionId),
    /** L2 外开终端的「交还」按钮:手动释放 externallyHeld */
    release: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.termRelease, sessionId),
    isHeld: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IPC.termIsHeld, sessionId),
  },
  onTermData: on<{ termId: string; data: string }>(IPC.evTermData),
  onTermExit: on<{ termId: string; code: number }>(IPC.evTermExit),

  onCursor: on<CursorPoint>(IPC.evCursor),
  onBallState: on<BallState>(IPC.evBallState),
  onChunk: on<ChunkEvent>(IPC.evChunk),
  onToolCall: on<ToolCallEvent>(IPC.evToolCall),
  onTurnDone: on<TurnDoneEvent>(IPC.evTurnDone),
  onPermission: on<PermissionRequest>(IPC.evPermission),
  onOpenChat: on<void>(IPC.evOpenChat),
  onImagePasted: on<PromptImage>(IPC.evImagePasted),
});
