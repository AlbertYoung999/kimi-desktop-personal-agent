import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IPC } from '../shared/types.js';
import type { AppSettings, PromptImage, VaultEntry } from '../shared/types.js';
import { ACPManager } from './acp.js';
import { runBackup, startBackupSchedule } from './backup.js';
import { readEvolveLog } from './evolve.js';
import { setWidgetRegistry } from './widget-registry.js';
import { recordSignal } from './signals.js';
import { startWorkbenchMcp, TOOL_META } from './mcpserver.js';
import { getDb, migrateFromJson } from './db.js';
import { createTray } from './tray.js';
import { sampleSysStats } from './sysstats.js';
import { speak, stopSpeaking, listTtsVoices, setTtsVoice, previewVoice, setTtsProvider, setTtsPiperVoice } from './tts.js';
import { deleteRadar, listRadars, runRadarNow, saveRadar, startRadarSchedulers, stopRadarSchedulers } from './radar.js';
import { deleteMode, findMode, getSettings, listModes, saveMode, saveSettings, setSessionKind } from './store.js';
import {
  appendFocusRecord,
  deleteEngine,
  deleteProject,
  deleteTask,
  addLibraryItem,
  deleteLibraryItem,
  getLayout,
  listEngines,
  listFocusRecords,
  listLibrary,
  listProjects,
  listTasks,
  readAgents,
  readMemory,
  saveEngine,
  saveLayout,
  saveProject,
  saveTask,
  writeAgents,
  writeMemory,
} from './workbench.js';
import {
  closeImagePreview,
  createBallWindow,
  createChatWindow,
  createHomeWindow,
  createWorkbenchWindow,
  disposeWindows,
  getBallWindow,
  getChatPinned,
  getChatWindow,
  getHomeWindow,
  getPreviewImage,
  getWorkbenchWindow,
  hideChat,
  moveBallTo,
  movePillTo,
  pushFocusStatus,
  setBallState,
  setChatPinned,
  showChat,
  showImagePreview,
  toggleChat,
  toggleHome,
  toggleTodoPanel,
  resizeTodoPanel,
  toggleWorkbench,
} from './windows.js';
import { getPomodoroState, startPomodoro, stopPomodoro } from './pomodoro.js';
import { listPomodoros } from './workbench.js';

const execFileAsync = promisify(execFile);

const acpManager = new ACPManager(
  () => getChatWindow()?.webContents ?? null,
  () => getWorkbenchWindow()?.webContents ?? null,
  () => getHomeWindow()?.webContents ?? null,
);

// ---------- sys stats polling (home page left rail) ----------

let statsTimer: NodeJS.Timeout | null = null;

function startStatsLoop(): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => {
    const targets = [getHomeWindow()?.webContents, getWorkbenchWindow()?.webContents];
    void sampleSysStats().then((stats) => {
      for (const wc of targets) {
        if (wc && !wc.isDestroyed()) wc.send(IPC.evSysStats, stats);
      }
    });
  }, 2000);
}

// ---------- workbench MCP action relay ----------

const pendingWbActions = new Map<string, (message: string) => void>();

function forwardToRenderer(action: string, params: Record<string, unknown>): Promise<string> {
  const wc = getWorkbenchWindow()?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve('✗ 工作台窗口不可用');
  const requestId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    pendingWbActions.set(requestId, resolve);
    wc.send(IPC.evWbAction, { requestId, action, params });
    setTimeout(() => {
      if (pendingWbActions.delete(requestId)) resolve('✗ 工作台执行超时');
    }, 8000);
  });
}

function notifyWbRefresh(kind: 'tasks' | 'radars'): void {
  const wc = getWorkbenchWindow()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(IPC.evWbRefresh, { kind });
}

// ---------- reactive triggers (design-v4 §10.4) ----------

function notifyWb(kind: 'success' | 'error' | 'info', message: string): void {
  const wc = getWorkbenchWindow()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(IPC.evWbNotify, { kind, message });
}

function sendReactionCard(card: Record<string, unknown>): void {
  const wc = getWorkbenchWindow()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(IPC.evReactionCard, card);
}

/** overdue task check: once per day after 9am, toast a reminder */
let lastOverdueCheck = '';
function checkOverdueTasks(): void {
  const now = new Date();
  if (now.getHours() < 9) return;
  const today = now.toISOString().slice(0, 10);
  if (lastOverdueCheck === today) return;
  lastOverdueCheck = today;
  const overdue = listTasks().filter(
    (t) => t.dueDate && t.dueDate.slice(0, 10) < today && t.status !== 'done' && t.status !== 'canceled',
  );
  if (overdue.length > 0) {
    recordSignal('task', `${overdue.length} 个任务逾期`);
    if (getSettings().triggers?.overdueNotify !== false) notifyWb('info', `⚠ ${overdue.length} 个任务已逾期：${overdue[0].title}${overdue.length > 1 ? ' 等' : ''}`);
  }
}

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
  ipcMain.handle(IPC.newSession, () => acpManager.newSession('chat'));
  ipcMain.handle(IPC.loadSession, (_e, sessionId: string) => acpManager.loadSession(sessionId));
  ipcMain.handle(IPC.setSessionKind, (_e, p: { sessionId: string; kind: 'chat' | 'auto' }) => {
    setSessionKind(p.sessionId, p.kind);
    return acpManager.listSessions();
  });
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

  // ---- workbench ----
  ipcMain.on(IPC.toggleWorkbench, () => toggleWorkbench());
  ipcMain.handle(IPC.wbGetLayout, () => getLayout());
  ipcMain.handle(IPC.wbSaveLayout, (_e, layout) => saveLayout(layout));
  // 任务变更后向所有窗口广播（今日待办 tab / 桌面面板实时同步）
  const broadcastTasksChanged = (): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.evTasksChanged);
    }
  };
  ipcMain.handle(IPC.wbTasksList, () => listTasks());
  ipcMain.handle(IPC.wbTaskSave, (_e, task) => {
    const r = saveTask(task);
    broadcastTasksChanged();
    return r;
  });
  ipcMain.handle(IPC.wbTaskDelete, (_e, id: string) => {
    const r = deleteTask(id);
    broadcastTasksChanged();
    return r;
  });
  // ---- pomodoro by task + 今日待办桌面面板 (v5.0) ----
  ipcMain.handle(IPC.wbPomodoroStart, (_e, taskId: string, durationMin?: number) => startPomodoro(taskId, durationMin));
  ipcMain.handle(IPC.wbPomodoroStop, (_e, completed: boolean) => stopPomodoro(completed));
  ipcMain.handle(IPC.wbPomodoroState, () => getPomodoroState());
  ipcMain.handle(IPC.wbPomodoroList, (_e, taskId?: string) => listPomodoros(taskId));
  ipcMain.on(IPC.toggleTodoPanel, () => toggleTodoPanel());
  ipcMain.on(IPC.resizeTodoPanel, (_e, w: number, h: number) => resizeTodoPanel(w, h));
  ipcMain.handle(IPC.wbProjectsList, () => listProjects());
  ipcMain.handle(IPC.wbProjectSave, (_e, project) => saveProject(project));
  ipcMain.handle(IPC.wbProjectDelete, (_e, id: string) => deleteProject(id));
  ipcMain.handle(IPC.wbTaskStartSession, async (_e, payload: string) => acpManager.startTaskSession(payload));
  ipcMain.handle(IPC.wbOpenSessionInChat, (_e, sessionId: string) => {
    showChat();
    getChatWindow()?.webContents.send(IPC.loadSessionInChat, sessionId);
  });
  ipcMain.handle(IPC.wbGetEngines, () => listEngines());
  ipcMain.handle(IPC.wbSaveEngine, (_e, engine) => saveEngine(engine));
  ipcMain.handle(IPC.wbDeleteEngine, (_e, id: string) => deleteEngine(id));
  ipcMain.handle(IPC.wbSearchLaunch, (_e, urls: string[]) => {
    for (const url of urls.slice(0, 8)) {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  ipcMain.handle(IPC.wbFocusLog, (_e, rec) => {
    appendFocusRecord(rec);
    recordSignal('focus', `专注完成：${rec.task || '未命名'} ${rec.minutes}min`);
    // reaction: speak + toast (design-v4 §10.4 确定性触发器)
    if (getSettings().triggers?.focusSpeak !== false) void speak(`专注结束。${rec.task ? `${rec.task}，` : ''}${rec.minutes} 分钟，休息一下。`);
    notifyWb('success', `◉ 专注完成 ${rec.minutes}min${rec.task ? ` · ${rec.task}` : ''}`);
    return undefined;
  });
  ipcMain.handle(IPC.wbFocusHistory, () => listFocusRecords());
  ipcMain.handle(IPC.wbAgentsRead, () => readAgents(getSettings().workspaceDir));
  ipcMain.handle(IPC.wbAgentsWrite, (_e, content: string) => writeAgents(getSettings().workspaceDir, content));
  ipcMain.handle(IPC.wbMemoryRead, () => readMemory(1_000_000));
  ipcMain.handle(IPC.wbMemoryWrite, (_e, content: string) => writeMemory(content));
  ipcMain.handle(IPC.wbAcpAsk, (_e, text: string) => acpManager.workbenchAsk(text));

  // workbench MCP action relay: main -> renderer -> result back
  ipcMain.on(IPC.wbActionResult, (_e, payload: { requestId: string; message: string }) => {
    pendingWbActions.get(payload.requestId)?.(payload.message);
    pendingWbActions.delete(payload.requestId);
  });
  ipcMain.on(IPC.wbRegisterWidgets, (_e, defs: { id: string; name: string; description: string }[]) => {
    setWidgetRegistry(defs);
  });
  ipcMain.handle(IPC.wbForgeGenerate, (_e, prompt: string) => acpManager.askOnce(prompt, 300_000));
  ipcMain.handle(IPC.wbLibraryList, () => listLibrary());
  ipcMain.handle(IPC.wbLibraryAdd, (_e, item) => addLibraryItem(item));
  ipcMain.handle(IPC.wbLibraryDelete, (_e, id: string) => deleteLibraryItem(id));

  // ---- home (voice-first entry) ----
  ipcMain.handle(IPC.homeAsk, (_e, text: string) => acpManager.homeAsk(text));
  ipcMain.handle(IPC.homeAskImage, (_e, text: string, image: { data: string; mimeType: string }) =>
    acpManager.homeAskImage(text, image),
  );
  ipcMain.handle(IPC.homeMainHistory, () => acpManager.getMainHistory());
  ipcMain.handle(IPC.homeMainNew, () => acpManager.newMainSessionFresh());
  ipcMain.handle(IPC.setThinking, (_e, on: boolean) => acpManager.setThinking(on));
  ipcMain.handle(IPC.ttsVoices, () => listTtsVoices());
  ipcMain.on(IPC.ttsSetVoice, (_e, p: { en: string; zh: string; rate: string }) => setTtsVoice(p.en, p.zh, p.rate));
  ipcMain.on(IPC.ttsSetProvider, (_e, p: { provider: 'piper' | 'say' }) => setTtsProvider(p.provider));
  ipcMain.on(IPC.ttsSetPiperVoice, (_e, p: { en: string; zh: string }) => setTtsPiperVoice(p.en, p.zh));
  ipcMain.handle(IPC.ttsPreview, (_e, p: { voice: string; cjk: boolean }) =>
    previewVoice(p.voice, p.cjk ? '你好，我是你的桌面助手。' : 'Hello, I am your desktop agent.'),
  );
  ipcMain.handle(IPC.wbToolsList, () =>
    TOOL_META.map((t) => ({ ...t, enabled: !(getSettings().disabledTools ?? []).includes(t.name) })),
  );
  ipcMain.on(IPC.wbToolToggle, (_e, p: { name: string; enabled: boolean }) => {
    const current = new Set(getSettings().disabledTools ?? []);
    if (p.enabled) current.delete(p.name);
    else current.add(p.name);
    saveSettings({ disabledTools: [...current] });
  });
  ipcMain.handle(IPC.wbRunBackup, () => runBackup());
  ipcMain.handle(IPC.desktopSources, async () => {
    const { desktopCapturer } = await import('electron');
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.on(IPC.toggleHome, () => toggleWorkbench()); // toggleHome 通道保留，指向 Shell
  ipcMain.handle(IPC.ttsSpeak, (_e, text: string, lang?: 'zh' | 'en') => speak(text, lang));
  ipcMain.on(IPC.ttsStop, () => stopSpeaking());
  ipcMain.handle(IPC.wbEvolveLog, () => readEvolveLog(50));
  ipcMain.on(IPC.focusStatus, (_e, status) => pushFocusStatus(status));
  ipcMain.on(IPC.pillMove, (_e, pos: { x: number; y: number }) => movePillTo(pos.x, pos.y));
  ipcMain.on(IPC.setSessionAllow, (_e, p: { sessionId: string; allowed: boolean }) =>
    acpManager.setSessionAllow(p.sessionId, p.allowed),
  );

  // ---- info radar ----
  ipcMain.handle(IPC.wbRadarList, () => listRadars());
  ipcMain.handle(IPC.wbRadarSave, (_e, radar) => saveRadar(radar));
  ipcMain.handle(IPC.wbRadarDelete, (_e, id: string) => deleteRadar(id));
  ipcMain.handle(IPC.wbRadarRunNow, (_e, id: string) => runRadarNow(id));
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
  app.whenReady().then(async () => {
    app.dock?.hide(); // menu-bar-style accessory app: no dock icon
    registerIpc();
    createBallWindow();
    createChatWindow();
    const shellWin = createWorkbenchWindow();
    shellWin.once('ready-to-show', () => shellWin.show()); // Shell 为启动入口（V4-A）
    startStatsLoop();
    createTray();
    getDb(); // 打开 jarvis.db
    migrateFromJson(); // 一次性从 JSON 迁移（幂等）
    startBackupSchedule();
    getDb(); // 打开 jarvis.db
    migrateFromJson(); // 一次性从 JSON 迁移（幂等）
    setInterval(checkOverdueTasks, 3600_000).unref();
    setTimeout(checkOverdueTasks, 60_000);

    // workbench MCP server (self-evolution plane, design-evolve.md E1)
    const mcpUrl = await startWorkbenchMcp({
      forwardToRenderer,
      openExternal: (url) => void shell.openExternal(url),
      notifyRefresh: notifyWbRefresh,
      askOnce: (prompt, timeoutMs) => acpManager.askOnce(prompt, timeoutMs),
      notifyArtifactUpdated: (item) => {
        const wc = getWorkbenchWindow()?.webContents;
        if (wc && !wc.isDestroyed()) wc.send(IPC.evArtifactUpdated, item);
      },
      notifyUser: (kind, message) => {
        const wc = getWorkbenchWindow()?.webContents;
        if (wc && !wc.isDestroyed()) wc.send(IPC.evWbNotify, { kind, message });
      },
      notifyArtifactProgress: (p) => {
        const wc = getWorkbenchWindow()?.webContents;
        if (wc && !wc.isDestroyed()) wc.send(IPC.evArtifactProgress, p);
      },
      askOnceRepo: (prompt, timeoutMs) => acpManager.askOnce(prompt, timeoutMs ?? 300_000, app.getAppPath()),
      forwardPresent: (p) => {
        const wc = getWorkbenchWindow()?.webContents;
        if (wc && !wc.isDestroyed()) wc.send(IPC.evPresentArtifact, p.payload);
      },
      repoRoot: () => app.getAppPath(),
      rebuildWorkbench: async () => {
        await execFileAsync(
          path.join(app.getAppPath(), 'node_modules', '.bin', 'esbuild'),
          ['src/renderer/workbench/index.ts', '--bundle', '--outfile=dist/renderer/workbench/index.js', '--format=iife'],
          { cwd: app.getAppPath(), timeout: 60_000 },
        );
        getWorkbenchWindow()?.webContents.reload();
      },
    });
    acpManager.setWorkbenchMcpUrl(mcpUrl);

    // info radar: scheduled fetch + AI structuring, pushes evRadarItems to the workbench
    startRadarSchedulers({
      askOnce: (text) => acpManager.askOnce(text),
      push: (radarId, newCount) => {
        getWorkbenchWindow()?.webContents.send(IPC.evRadarItems, { radarId, newCount });
        recordSignal('radar', `雷达 ${radarId} 抓到 ${newCount} 条新内容`);
        // reaction: card with deep-link when there are several new items
        if (newCount >= 3 && getSettings().triggers?.radarCard !== false) {
          sendReactionCard({
            id: `radar-${radarId}-${Date.now()}`,
            kind: 'info',
            title: `📡 ${radarId} 有 ${newCount} 条新动态`,
            body: '点击查看信息流',
            actions: [
              { label: '打开雷达', action: 'open-widget:info-radar' },
              { label: '知道了', action: 'dismiss' },
            ],
          });
        }
      },
    });

    globalShortcut.register('CommandOrControl+Shift+K', async () => {
      showChat();
      const img = await captureRegion();
      if (img) getChatWindow()?.webContents.send(IPC.evImagePasted, img);
    });

    globalShortcut.register('CommandOrControl+Shift+J', () => toggleWorkbench());

    app.on('activate', () => {
      if (!getBallWindow()) createBallWindow();
      if (!getChatWindow()) createChatWindow();
      if (!getWorkbenchWindow()) createWorkbenchWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopRadarSchedulers();
    disposeWindows();
    void acpManager.dispose();
  });

  // keep running even when all windows are "closed" (ball is always-on)
  app.on('window-all-closed', () => {
    /* no-op */
  });
}
