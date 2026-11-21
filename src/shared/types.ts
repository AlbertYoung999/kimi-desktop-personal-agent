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
  /** chat = 用户在对话窗主动创建；auto = 后台/工作台/任务会话（默认）；utility = 阅后即焚的 askOnce 会话 */
  kind?: 'chat' | 'auto' | 'utility';
  /** true = 常驻主会话（voice + Command Center 共用的 agent 意识体） */
  main?: boolean;
}

export interface AppSettings {
  /** the single workspace folder for V1 */
  workspaceDir: string;
  /** vault directory for favorites/ideas (markdown) */
  vaultDir: string;
  /** permission mode sent via session/set_config_option */
  permissionMode: 'default' | 'auto' | 'yolo';
  /** resident main agent session id (voice + command center 共用的主会话) */
  mainSessionId?: string;
  /** TTS 声音（英文 / 中文） */
  ttsVoiceEn?: string;
  ttsVoiceZh?: string;
  /** TTS 语速 slow/normal/fast */
  ttsRate?: string;
  /** TTS provider */
  ttsProvider?: 'piper' | 'say';
  /** 深度思考模式（thinking on/off） */
  thinking?: boolean;
  /** Piper 音色（英文 / 中文，模型 id） */
  ttsPiperVoiceEn?: string;
  ttsPiperVoiceZh?: string;
  /** TTS 总开关（默认开）；关闭则任何场景都不自动播报 */
  ttsEnabled?: boolean;
  /** TTS 分场景开关：zen 模式 / 悬浮窗对话（默认开，受总开关约束） */
  ttsEnabledZen?: boolean;
  ttsEnabledChat?: boolean;
  /** 禁用的 MCP 工具名 */
  disabledTools?: string[];
  /** 反应回路触发器开关 */
  triggers?: { focusSpeak?: boolean; radarCard?: boolean; overdueNotify?: boolean; caption?: boolean };
  /** group 编排规划的「系统优先模式」文本(v7.0 P3,作为规划 prompt 的先验注入) */
  orchestrationPref?: string;
  /** kimi 模型选项缓存(newSession 返回的 configOptions 里 id='model' 的项,渲染层随时可拉) */
  modelOptions?: { value: string; name: string }[];
  modelCurrent?: string;
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

// ---- channel 模式 (v7.0) ----

/** channel 项目树中的单个 session(SessionScanner 扫描结果 + channel_meta 合并) */
export interface ChannelSession {
  id: string;
  title: string;
  updatedAt: number;
  lastPrompt: string;
  /** 决策#2:turn 结束时落库的最后一段 agent 文本(截断 500 字符) */
  lastMessage: string;
  pinned: boolean;
  busy: boolean;
  /** updatedAt > last_viewed_at(未查看过视为有更新) */
  hasUpdate: boolean;
  /** 阅后即焚(utility/askOnce session),渲染层收进「临时」区 */
  ephemeral: boolean;
  /** 绑定的常驻 agent id(channel_meta.agent_id,头像/角色标用) */
  agentId?: string;
}

/** channel 项目树节点(默认按 cwd 分组;手动项目带 projectId/name) */
export interface ChannelProject {
  cwd: string;
  dirName: string;
  sessions: ChannelSession[];
  /** 手动创建的项目(channel_projects),path 为空时是纯逻辑分组 */
  projectId?: string;
  name?: string;
  /** 特殊分组:archive = 历史归档(显式标记,一次性迁移产物);unsorted = 未分组 */
  bucket?: 'archive' | 'unsorted';
}

export interface ChannelTree {
  projects: ChannelProject[];
}

/** channel_projects 表记录(ch:projectCreate 返回值) */
export interface ChannelProjectRecord {
  id: string;
  name: string;
  path: string | null;
  createdAt: number;
  sortOrder: number;
}

/** 统一会话入口 openSession 的返回(design/design-v7.md §3.2:永不 load 忙中 session) */
export type OpenSessionResult =
  | { mode: 'history'; messages: HistoryItem[] }
  | { mode: 'live'; buffered: string[] }
  | { mode: 'stale' };

/** 常驻 agent(design/design-v7.md §10.2):dir 为绝对路径;AGENTS.md 文件是唯一事实源 */
export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  dir: string;
  avatar: string; // emoji 字符
  createdAt: number;
  updatedAt: number;
}

/** session 三配置(v7.0 P2):项目级 AGENTS.md + per-session 的 current-process/product */
export interface SessionConfig {
  agentsMd: string;
  currentProcessMd: string;
  productMd: string;
  /** <cwd>/AGENTS.md 的绝对路径(渲染层展示用) */
  agentsMdPath: string;
  /** <cwd>/.kimi-desktop/sessions/<sid>/ 的绝对路径 */
  dirPath: string;
}

export type SessionConfigField = 'agentsMd' | 'currentProcessMd' | 'productMd';

// ---- group 协作 (v7.0 P3, design/design-v7.md §4) ----

export interface GroupMemberRecord {
  sessionId: string;
  role: string;
  /** IPC 层补充:显示名(sessions.json title / agent 名) */
  title?: string;
  agentName?: string;
}

export interface GroupRecord {
  id: string;
  projectId: string | null;
  cwd: string | null;
  name: string;
  contextMd: string; // group.md 落盘文件的缓存
  roundCount: number;
  compactThreshold: number;
  autonomous: boolean;
  maxRounds: number;
  createdAt: number;
  members: GroupMemberRecord[];
}

/** group 消息(内存缓冲;压缩后原始段落落盘 group-logs/) */
export interface GroupMessage {
  from: string;
  fromKind: 'user' | 'agent' | 'system';
  sessionId?: string;
  text: string;
  at: number;
}

/** ch:group-event 推送(主→渲染,仅 workbench 窗口) */
export interface GroupEvent {
  groupId: string;
  kind: 'message' | 'round' | 'compact' | 'error';
  message?: GroupMessage;
  roundCount?: number;
  summary?: string;
  error?: string;
}

/** 编排规划结果:JSON 解析成功给结构化方案,失败回退纯文本 */
export type GroupPlanResult = { ok: true; plan: Record<string, unknown> } | { ok: false; text: string };

export interface GroupConfigPatch {
  name?: string;
  contextMd?: string;
  compactThreshold?: number;
  autonomous?: boolean;
  maxRounds?: number;
}

// ---- worktree 隔离 (v7.0 P3, design/design-v7.md §5) ----

export interface WorktreeInfo {
  path: string;
  branch: string; // 空 = detached
  head: string;
}

/** worktree 操作统一返回:只有用户显式调用时才执行,错误结构化 */
export interface WorktreeOpResult {
  ok: boolean;
  reason?: 'not-git' | 'conflict' | 'git-error';
  error?: string;
  path?: string;
  branch?: string;
  diff?: string;
  worktrees?: WorktreeInfo[];
}


// ---- streaming events (main -> renderer) ----

export type ChunkKind = 'text' | 'thought' | 'user';

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
  /** 完整选项列表(多选项问题如 AskUserQuestion 需要;二选一确认也有) */
  options?: { optionId: string; name: string; kind: string }[];
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
  wbMemoryRead: 'wb:memory-read',
  wbMemoryWrite: 'wb:memory-write',
  wbAcpAsk: 'wb:acp-ask',
  wbRegisterWidgets: 'wb:register-widgets',
  evWbAction: 'wb:action',
  wbActionResult: 'wb:action-result',
  evWbRefresh: 'wb:refresh',
  setSessionAllow: 'acp:set-session-allow',
  setSessionKind: 'acp:set-session-kind',
  evArtifactUpdated: 'wb:artifact-updated',
  evPresentArtifact: 'present:artifact',
  evPresentOpen: 'present:open',
  evPresentDismiss: 'present:dismiss',
  evArtifactProgress: 'wb:artifact-progress',
  wbEvolveLog: 'wb:evolve-log',
  evWbNotify: 'wb:notify',
  evMainSession: 'acp:main-session',
  evSessionMode: 'acp:session-mode',
  evSessionModel: 'acp:session-model',
  evSessionThinking: 'acp:session-thinking',
  setThinking: 'acp:set-thinking',
  // home (voice-first entry)
  homeAsk: 'home:ask',
  homeAskImage: 'home:ask-image',
  homeMainHistory: 'home:main-history',
  homeMainNew: 'home:main-new',
  ttsVoices: 'tts:voices',
  ttsSetVoice: 'tts:set-voice',
  ttsSetProvider: 'tts:set-provider',
  ttsSetPiperVoice: 'tts:set-piper-voice',
  ttsPreview: 'tts:preview',
  wbToolsList: 'wb:tools-list',
  wbToolToggle: 'wb:tool-toggle',
  wbRunBackup: 'wb:run-backup',
  desktopSources: 'desktop:sources',
  evReactionCard: 'reaction:card',
  toggleHome: 'home:toggle',
  ttsSpeak: 'tts:speak',
  ttsStop: 'tts:stop',
  evSysStats: 'sys:stats',
  // focus pill (dynamic-island style status bar)
  focusStatus: 'focus:status',
  evFocusStatus: 'focus:status-push',
  // pomodoro by task + 今日待办桌面面板 (v5.0)
  wbPomodoroStart: 'wb:pomodoro-start',
  wbPomodoroStop: 'wb:pomodoro-stop',
  wbPomodoroState: 'wb:pomodoro-state',
  wbPomodoroList: 'wb:pomodoro-list',
  evPomodoroState: 'wb:pomodoro-state-push',
  toggleTodoPanel: 'window:toggle-todo-panel',
  resizeTodoPanel: 'window:resize-todo-panel',
  todoPanelMode: 'window:todo-panel-mode',
  evTasksChanged: 'wb:tasks-changed',
  // channel 模式 (v7.0 P1, design/design-v7.md §7)
  chScan: 'ch:scan',
  chOpenSession: 'ch:open-session',
  chSetPin: 'ch:set-pin',
  chSetProject: 'ch:set-project',
  chMarkViewed: 'ch:mark-viewed',
  chProjectCreate: 'ch:project-create',
  chPickFolder: 'ch:pick-folder',
  chArchiveSession: 'ch:archive-session',
  chOpenPath: 'ch:open-path',
  chSetSessionMode: 'ch:set-session-mode',
  chGetSessionMode: 'ch:get-session-mode',
  chSetSessionModel: 'ch:set-session-model',
  chGetSessionModel: 'ch:get-session-model',
  chModelOptions: 'ch:model-options',
  chSetSessionThinking: 'ch:set-session-thinking',
  chGetSessionThinking: 'ch:get-session-thinking',
  evChChanged: 'ch:changed',
  // channel P2: 常驻 agent 库 + session 三配置 + 会话生命周期 (design/design-v7.md §10)
  chAgentList: 'ch:agent-list',
  chAgentCreate: 'ch:agent-create',
  chAgentUpdate: 'ch:agent-update',
  chAgentDelete: 'ch:agent-delete',
  chAgentRead: 'ch:agent-read',
  chAgentWrite: 'ch:agent-write',
  chSessionConfigRead: 'ch:session-config-read',
  chSessionConfigWrite: 'ch:session-config-write',
  chNewSession: 'ch:new-session',
  chDeleteSession: 'ch:delete-session',
  // channel P3a: group 协作 + 动态编排 + worktree + fork (design/design-v7.md §4/§5)
  chGroupCreate: 'ch:group-create',
  chGroupList: 'ch:group-list',
  chGroupSend: 'ch:group-send',
  chGroupMessages: 'ch:group-messages',
  chGroupConfig: 'ch:group-config',
  chGroupAddMember: 'ch:group-add-member',
  chGroupRemoveMember: 'ch:group-remove-member',
  chGroupCreateMember: 'ch:group-create-member',
  chGroupDelete: 'ch:group-delete',
  chGroupPlan: 'ch:group-plan',
  evChGroupEvent: 'ch:group-event',
  chOrchestrationPrefRead: 'ch:orchestration-pref-read',
  chOrchestrationPrefWrite: 'ch:orchestration-pref-write',
  chWorktreeCreate: 'ch:worktree-create',
  chWorktreeList: 'ch:worktree-list',
  chWorktreeDiff: 'ch:worktree-diff',
  chWorktreeMerge: 'ch:worktree-merge',
  chWorktreeDiscard: 'ch:worktree-discard',
  chForkSession: 'ch:fork-session',
  // 终端三视图 (v7.0 P3b, design/design-v7.md §12)
  termOpen: 'term:open',
  termInput: 'term:input',
  termResize: 'term:resize',
  termClose: 'term:close',
  evTermData: 'term:data',
  evTermExit: 'term:exit',
  termVisOpen: 'term:vis-open',
  termVisClose: 'term:vis-close',
  termOpenExternal: 'term:open-external',
  termRelease: 'term:release',
  termIsHeld: 'term:is-held',
  // radar (P1)
  wbRadarList: 'wb:radar-list',
  wbRadarSave: 'wb:radar-save',
  wbRadarDelete: 'wb:radar-delete',
  wbRadarRunNow: 'wb:radar-run-now',
  evRadarItems: 'wb:radar-items',
  // forge (P1)
  wbForgeGenerate: 'wb:forge-generate',
  wbPlanGenerate: 'wb:plan-generate',
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
