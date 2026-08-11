import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types.js';
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
} from '../shared/types.js';

const on = <T>(channel: string) => (cb: (payload: T) => void) => {
  ipcRenderer.on(channel, (_e, payload: T) => cb(payload));
};

contextBridge.exposeInMainWorld('kimi', {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (s: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.setSettings, s),
  pickWorkspaceDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickWorkspaceDir),

  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke(IPC.listSessions),
  newSession: (): Promise<SessionMeta> => ipcRenderer.invoke(IPC.newSession),
  loadSession: (sessionId: string): Promise<LoadSessionResult> => ipcRenderer.invoke(IPC.loadSession, sessionId),
  prompt: (sessionId: string, text: string, modeId: string | null, image: PromptImage | null): Promise<void> =>
    ipcRenderer.invoke(IPC.prompt, sessionId, text, modeId, image),
  cancel: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.cancel, sessionId),
  respondPermission: (requestId: string, approved: boolean, remember: boolean, sessionId: string): void => {
    ipcRenderer.send(IPC.permissionResponse, { requestId, approved, remember, sessionId });
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
  setChatPinned: (pinned: boolean): void => void ipcRenderer.send(IPC.setChatPinned, pinned),
  getChatPinned: (): Promise<boolean> => ipcRenderer.invoke(IPC.getChatPinned),
  openExternal: (url: string): void => void ipcRenderer.send(IPC.openExternal, url),
  showImagePreview: (src: string): void => void ipcRenderer.send(IPC.showImagePreview, src),
  getPreviewImage: (): Promise<string | null> => ipcRenderer.invoke(IPC.getPreviewImage),
  closePreview: (): void => void ipcRenderer.send(IPC.closePreview),

  onCursor: on<CursorPoint>(IPC.evCursor),
  onBallState: on<BallState>(IPC.evBallState),
  onChunk: on<ChunkEvent>(IPC.evChunk),
  onToolCall: on<ToolCallEvent>(IPC.evToolCall),
  onTurnDone: on<TurnDoneEvent>(IPC.evTurnDone),
  onPermission: on<PermissionRequest>(IPC.evPermission),
  onOpenChat: on<void>(IPC.evOpenChat),
  onImagePasted: on<PromptImage>(IPC.evImagePasted),
});
