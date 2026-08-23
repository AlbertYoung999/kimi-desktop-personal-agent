import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { IPC } from '../shared/types.js';
import type { BallState } from '../shared/types.js';

const BALL_SIZE = 64;
const CHAT_WIDTH = 400;
const CHAT_HEIGHT = 620;

let ballWin: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let cursorTimer: NodeJS.Timeout | null = null;
let chatPinned = true; // default: pinned on top

function rendererDir(): string {
  // dist/main -> dist/renderer
  return path.join(__dirname, '..', 'renderer');
}

export function getBallWindow(): BrowserWindow | null {
  return ballWin;
}

export function getChatWindow(): BrowserWindow | null {
  return chatWin;
}

export function createBallWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  ballWin = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: x + width - BALL_SIZE - 24,
    y: y + Math.round(height / 2) - BALL_SIZE / 2,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWin.setAspectRatio(1); // 保持正圆，跨显示器移动时不被拉伸
  ballWin.loadFile(path.join(rendererDir(), 'ball', 'index.html'));
  ballWin.on('closed', () => (ballWin = null));
  // 显示器参数变化（拔插/换屏）时强制回正尺寸
  screen.on('display-metrics-changed', () => {
    if (ballWin && !ballWin.isDestroyed()) ballWin.setSize(BALL_SIZE, BALL_SIZE);
  });

  // poll global cursor position for the eye-tracking animation
  cursorTimer = setInterval(() => {
    if (ballWin && !ballWin.isDestroyed()) {
      ballWin.webContents.send(IPC.evCursor, screen.getCursorScreenPoint());
    }
  }, 60);

  return ballWin;
}

export function createChatWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;

  chatWin = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    x: x + width - CHAT_WIDTH - 24,
    y: y + height - CHAT_HEIGHT - 24,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 320,
    minHeight: 400,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  chatWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  chatWin.setAlwaysOnTop(chatPinned, 'floating');
  chatWin.loadFile(path.join(rendererDir(), 'chat', 'index.html'));
  chatWin.on('closed', () => (chatWin = null));
  chatWin.on('blur', () => {
    // auto-hide when focus leaves (popover style) — unless pinned
    if (!chatPinned && chatWin && chatWin.isVisible()) chatWin.hide();
  });
  return chatWin;
}

export function setChatPinned(pinned: boolean): void {
  chatPinned = pinned;
  chatWin?.setAlwaysOnTop(pinned, 'floating');
}

export function getChatPinned(): boolean {
  return chatPinned;
}

export function showChat(): void {
  if (!chatWin) return;
  // anchor near the ball if it has been dragged elsewhere
  if (ballWin && !ballWin.isDestroyed()) {
    const [bx, by] = ballWin.getPosition();
    const display = screen.getDisplayNearestPoint({ x: bx, y: by });
    const wa = display.workArea;
    const cx = Math.min(Math.max(bx + BALL_SIZE / 2 - CHAT_WIDTH / 2, wa.x + 8), wa.x + wa.width - CHAT_WIDTH - 8);
    const cy = Math.min(Math.max(by - CHAT_HEIGHT - 12, wa.y + 8), wa.y + wa.height - CHAT_HEIGHT - 8);
    chatWin.setPosition(Math.round(cx), Math.round(cy));
  }
  chatWin.show();
  chatWin.focus();
  chatWin.webContents.send(IPC.evOpenChat);
}

export function hideChat(): void {
  chatWin?.hide();
}

export function toggleChat(): void {
  if (!chatWin) return;
  if (chatWin.isVisible() && chatWin.isFocused()) hideChat();
  else showChat();
}

export function setBallState(state: BallState): void {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.webContents.send(IPC.evBallState, state);
  }
}

export function moveBallTo(x: number, y: number): void {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.setPosition(Math.round(x), Math.round(y));
  }
}

// ---------- home window (voice-first entry) ----------

let homeWin: BrowserWindow | null = null;

export function getHomeWindow(): BrowserWindow | null {
  return homeWin;
}

export function createHomeWindow(): BrowserWindow {
  homeWin = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#04080a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  homeWin.loadFile(path.join(rendererDir(), 'home', 'index.html'));
  homeWin.on('closed', () => (homeWin = null));
  homeWin.on('ready-to-show', () => homeWin?.show());
  homeWin.on('close', (e) => {
    // keep alive; close = hide (it's the app's entry hub)
    e.preventDefault();
    homeWin?.hide();
  });
  return homeWin;
}

export function toggleHome(): void {
  if (!homeWin) return;
  if (homeWin.isVisible() && homeWin.isFocused()) homeWin.hide();
  else {
    homeWin.show();
    homeWin.focus();
  }
}

// ---------- workbench window ----------

let workbenchWin: BrowserWindow | null = null;

export function getWorkbenchWindow(): BrowserWindow | null {
  return workbenchWin;
}

export function createWorkbenchWindow(): BrowserWindow {
  workbenchWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0d12',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
      partition: 'persist:workbench',
      // local-first app: allow forged widgets to call public data APIs (CORS would
      // otherwise block fetch from the file:// origin)
      webSecurity: false,
    },
  });
  // strip anti-framing headers so the search widget can iframe engine results
  const ses = workbenchWin.webContents.session;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const k = key.toLowerCase();
      if (k === 'x-frame-options' || k === 'frame-options' || k.startsWith('content-security-policy')) {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });
  workbenchWin.loadFile(path.join(rendererDir(), 'workbench', 'index.html'));
  workbenchWin.on('closed', () => (workbenchWin = null));
  workbenchWin.on('close', (e) => {
    // keep the instance alive; close = hide
    e.preventDefault();
    workbenchWin?.hide();
  });
  return workbenchWin;
}

export function toggleWorkbench(): void {
  if (!workbenchWin) return;
  if (workbenchWin.isVisible() && workbenchWin.isFocused()) workbenchWin.hide();
  else {
    workbenchWin.show();
    workbenchWin.focus();
  }
}

// ---------- focus pill (dynamic-island style) ----------

let pillWin: BrowserWindow | null = null;

export function ensureFocusPill(): BrowserWindow {
  if (pillWin && !pillWin.isDestroyed()) return pillWin;
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  pillWin = new BrowserWindow({
    width: 260,
    height: 40,
    x: x + Math.round(width / 2) - 130,
    y: y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  pillWin.setAlwaysOnTop(true, 'screen-saver');
  pillWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pillWin.loadFile(path.join(rendererDir(), 'focus-pill', 'index.html'));
  pillWin.on('closed', () => (pillWin = null));
  return pillWin;
}

export function pushFocusStatus(status: { active: boolean } & Record<string, unknown>): void {
  if (status.active) {
    const win = ensureFocusPill();
    const show = () => {
      if (!win.isVisible()) win.show();
      win.webContents.send(IPC.evFocusStatus, status);
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show);
    else show();
  } else if (pillWin && !pillWin.isDestroyed()) {
    pillWin.close();
    pillWin = null;
  }
}

export function movePillTo(x: number, y: number): void {
  if (pillWin && !pillWin.isDestroyed()) {
    pillWin.setPosition(Math.round(x), Math.round(y));
  }
}

// ---------- fullscreen image preview ----------

let previewWin: BrowserWindow | null = null;
let pendingPreviewSrc: string | null = null;

export function showImagePreview(src: string): void {
  if (previewWin && !previewWin.isDestroyed()) {
    previewWin.close();
  }
  pendingPreviewSrc = src;
  const anchor = chatWin && !chatWin.isDestroyed() ? chatWin.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  const display = screen.getDisplayNearestPoint({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 });
  previewWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  previewWin.setAlwaysOnTop(true, 'screen-saver');
  previewWin.loadFile(path.join(rendererDir(), 'preview', 'index.html'));
  previewWin.on('closed', () => {
    previewWin = null;
    pendingPreviewSrc = null;
  });
}

export function getPreviewImage(): string | null {
  return pendingPreviewSrc;
}

export function closeImagePreview(): void {
  previewWin?.close();
}

export function disposeWindows(): void {
  if (cursorTimer) clearInterval(cursorTimer);
}
