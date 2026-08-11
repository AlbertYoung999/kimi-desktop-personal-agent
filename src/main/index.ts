import { app, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IPC } from '../shared/types.js';
import type { AppSettings, PromptImage, VaultEntry } from '../shared/types.js';
import { ACPManager } from './acp.js';
import { deleteMode, findMode, getSettings, listModes, saveMode, saveSettings } from './store.js';
import {
  closeImagePreview,
  createBallWindow,
  createChatWindow,
  disposeWindows,
  getBallWindow,
  getChatPinned,
  getChatWindow,
  getPreviewImage,
  hideChat,
  moveBallTo,
  setBallState,
  setChatPinned,
  showChat,
  showImagePreview,
  toggleChat,
} from './windows.js';

const execFileAsync = promisify(execFile);

const acpManager = new ACPManager(() => getChatWindow()?.webContents ?? null);

// ---------- capture (macOS native region screenshot) ----------

async function captureRegion(): Promise<PromptImage | null> {
  const tmp = path.join(os.tmpdir(), `kimi-capture-${Date.now()}.png`);
  try {
    // -i interactive region select, -x no shutter sound
    await execFileAsync('screencapture', ['-ix', tmp], { timeout: 120_000 });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) return null;
    const data = fs.readFileSync(tmp).toString('base64');
    return { data, mimeType: 'image/png' };
  } catch {
    return null; // user pressed Esc
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

// ---------- vault ----------

function resolveVaultPath(relPath: string): string {
  const vaultDir = path.resolve(getSettings().vaultDir);
  const resolved = path.resolve(vaultDir, relPath);
  if (resolved !== vaultDir && !resolved.startsWith(vaultDir + path.sep)) {
    throw new Error(`invalid vault path: ${relPath}`);
  }
  return resolved;
}

function listVault(): VaultEntry[] {
  const vaultDir = getSettings().vaultDir;
  const entries: VaultEntry[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.md')) {
        const rel = path.relative(vaultDir, full);
        let title = name.replace(/\.md$/, '');
        try {
          const head = fs.readFileSync(full, 'utf8').slice(0, 2000);
          const h1 = head.match(/^#\s+(.+)$/m);
          if (h1) title = h1[1].trim();
        } catch {
          /* keep filename title */
        }
        entries.push({ relPath: rel, title, updatedAt: stat.mtimeMs });
      }
    }
  };
  walk(vaultDir);
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => getSettings());
  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => saveSettings(patch));
  ipcMain.handle(IPC.pickWorkspaceDir, async () => {
    const win = getChatWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    saveSettings({ workspaceDir: dir });
    return dir;
  });

  ipcMain.handle(IPC.listSessions, () => acpManager.listSessions());
  ipcMain.handle(IPC.newSession, () => acpManager.newSession());
  ipcMain.handle(IPC.loadSession, (_e, sessionId: string) => acpManager.loadSession(sessionId));
  ipcMain.handle(IPC.prompt, async (_e, sessionId: string, text: string, modeId: string | null, image: PromptImage | null) => {
    const mode = findMode(modeId);
    await acpManager.prompt(sessionId, text, mode?.prompt ?? null, image);
  });
  ipcMain.handle(IPC.cancel, (_e, sessionId: string) => acpManager.cancel(sessionId));
  ipcMain.on(IPC.permissionResponse, (_e, payload: { requestId: string; approved: boolean; remember: boolean; sessionId: string }) => {
    acpManager.respondPermission(payload.requestId, payload.approved, payload.remember, payload.sessionId ?? '');
  });

  ipcMain.handle(IPC.listModes, () => listModes());
  ipcMain.handle(IPC.saveMode, (_e, mode) => saveMode(mode));
  ipcMain.handle(IPC.deleteMode, (_e, id: string) => deleteMode(id));

  ipcMain.handle(IPC.vaultList, () => listVault());
  ipcMain.handle(IPC.vaultRead, (_e, relPath: string) => fs.readFileSync(resolveVaultPath(relPath), 'utf8'));
  ipcMain.handle(IPC.vaultWrite, (_e, relPath: string, content: string) => {
    const p = resolveVaultPath(relPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  });

  ipcMain.handle(IPC.captureRegion, () => captureRegion());
  ipcMain.on(IPC.toggleChat, () => toggleChat());
  ipcMain.on(IPC.hideChat, () => hideChat());
  ipcMain.on(IPC.setBallState, (_e, state) => setBallState(state));
  ipcMain.on(IPC.ballMove, (_e, pos: { x: number; y: number }) => moveBallTo(pos.x, pos.y));
  ipcMain.on(IPC.setChatPinned, (_e, pinned: boolean) => setChatPinned(pinned));
  ipcMain.handle(IPC.getChatPinned, () => getChatPinned());
  ipcMain.on(IPC.openExternal, (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.on(IPC.showImagePreview, (_e, src: string) => {
    if (typeof src === 'string' && (src.startsWith('data:image/') || /^https?:\/\//i.test(src))) {
      showImagePreview(src);
    }
  });
  ipcMain.handle(IPC.getPreviewImage, () => getPreviewImage());
  ipcMain.on(IPC.closePreview, () => closeImagePreview());
}

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    app.dock?.hide(); // menu-bar-style accessory app: no dock icon
    registerIpc();
    createBallWindow();
    createChatWindow();

    globalShortcut.register('CommandOrControl+Shift+K', async () => {
      showChat();
      const img = await captureRegion();
      if (img) getChatWindow()?.webContents.send(IPC.evImagePasted, img);
    });

    app.on('activate', () => {
      if (!getBallWindow()) createBallWindow();
      if (!getChatWindow()) createChatWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    disposeWindows();
    void acpManager.dispose();
  });

  // keep running even when all windows are "closed" (ball is always-on)
  app.on('window-all-closed', () => {
    /* no-op */
  });
}
