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
  setChatPinned(pinned: boolean): void;
  getChatPinned(): Promise<boolean>;
  openExternal(url: string): void;
  showImagePreview(src: string): void;
  getPreviewImage(): Promise<string | null>;
  closePreview(): void;

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
