import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { IPC } from '../shared/types.js';
import type { AppSettings, GroupConfigPatch, PromptImage, SessionConfigField, VaultEntry } from '../shared/types.js';
import { ACPManager } from './acp.js';
import { runBackup, startBackupSchedule } from './backup.js';
import { readEvolveLog } from './evolve.js';
import { setWidgetRegistry } from './widget-registry.js';
import { recordSignal } from './signals.js';
import { startWorkbenchMcp, TOOL_META } from './mcpserver.js';
import { getDb, migrateFromJson, createChannelProject, markChannelViewed, setChannelArchived, setChannelPinned, setChannelProject } from './db.js';
import { SessionScanner, findSessionCwd, runArchiveMigration } from './session-scanner.js';
import { createAgent, deleteAgent, listAgents, readAgentMd, updateAgent, writeAgentMd } from './agent-library.js';
import { readSessionConfig, writeSessionConfig } from './session-config.js';
import { GroupOrchestrator } from './group-orchestrator.js';
import { createWorktree, discardWorktree, getDiff, listWorktrees, mergeWorktree } from './worktree-manager.js';
import { TerminalManager } from './terminal-manager.js';
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
  setTodoPanelMode,
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

// channel 模式 (v7.0 P1):sessions 目录扫描器,变化经 ch:changed 推到 workbench 窗口
const sessionScanner = new SessionScanner({
  isBusy: (sid) => acpManager.isBusy(sid),
  onChanged: () => {
    const wc = getWorkbenchWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.evChChanged);
  },
});

// group 编排器 (v7.0 P3a):消息流与事件经 ch:group-event 推到 workbench 窗口
const groupOrchestrator = new GroupOrchestrator({
  acp: acpManager,
  push: (payload) => {
    const wc = getWorkbenchWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.evChGroupEvent, payload);
  },
});

// 终端三视图 (v7.0 P3b):pty 数据/退出事件仅发 workbench 窗口
const terminalManager = new TerminalManager({
  onData: (termId, data) => {
    const wc = getWorkbenchWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.evTermData, { termId, data });
  },
  onExit: (termId, code) => {
    const wc = getWorkbenchWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.evTermExit, { termId, code });
  },
  hold: (sid) => acpManager.holdSession(sid),
  release: (sid) => acpManager.releaseSession(sid),
});

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
  ipcMain.handle(IPC.newSession, (_e, cwd?: string) => acpManager.newSession('chat', cwd));
  ipcMain.handle(IPC.loadSession, (_e, sessionId: string) => acpManager.loadSession(sessionId));
  ipcMain.handle(IPC.setSessionKind, (_e, p: { sessionId: string; kind: 'chat' | 'auto' }) => {
    setSessionKind(p.sessionId, p.kind);
    return acpManager.listSessions();
  });
  ipcMain.handle(IPC.prompt, async (_e, sessionId: string, text: string, modeId: string | null, images: PromptImage[] | null) => {
    const mode = findMode(modeId);
    await acpManager.prompt(sessionId, text, mode?.prompt ?? null, images);
  });
  ipcMain.handle(IPC.cancel, (_e, sessionId: string) => acpManager.cancel(sessionId));
  ipcMain.on(IPC.permissionResponse, (_e, payload: { requestId: string; approved: boolean; remember: boolean; sessionId: string; optionId?: string }) => {
    acpManager.respondPermission(payload.requestId, payload.approved, payload.remember, payload.sessionId ?? '', payload.optionId);
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
  ipcMain.on(IPC.todoPanelMode, (_e, collapsed: boolean) => setTodoPanelMode(collapsed));
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
  // v6.0 自主规划：task decomposition（联网调研 + 路径分解），耗时更长
  ipcMain.handle(IPC.wbPlanGenerate, (_e, prompt: string) => acpManager.askOnce(prompt, 600_000));
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

  // ---- channel 模式 (v7.0 P1, design/design-v7.md §7) ----
  ipcMain.handle(IPC.chScan, () => sessionScanner.scan());
  ipcMain.handle(IPC.chOpenSession, (_e, sessionId: string) => acpManager.openSession(sessionId));
  ipcMain.handle(IPC.chSetPin, (_e, sessionId: string, pinned: boolean) => setChannelPinned(sessionId, pinned));
  ipcMain.handle(IPC.chSetProject, (_e, sessionId: string, projectId: string | null) =>
    setChannelProject(sessionId, projectId),
  );
  ipcMain.handle(IPC.chMarkViewed, (_e, sessionId: string) => markChannelViewed(sessionId));
  // 显式归档/恢复(写 channel_meta.archived,触发 ch:changed 让渲染层重扫)
  ipcMain.handle(IPC.chArchiveSession, (_e, sessionId: string, archived: boolean) => {
    setChannelArchived(sessionId, archived);
    const wc = getWorkbenchWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.evChChanged);
  });
  // 在 Finder 中打开目录(只读操作;返回值对齐 Electron:空串=成功,否则错误串)
  ipcMain.handle(IPC.chOpenPath, (_e, p: string) =>
    typeof p === 'string' && p.length > 0 ? shell.openPath(p) : Promise.resolve('invalid path'),
  );
  // per-session 权限模式(default/auto/yolo/plan;null=清除覆盖回退全局)
  ipcMain.handle(IPC.chSetSessionMode, (_e, sid: string, mode: 'default' | 'auto' | 'yolo' | 'plan' | null) =>
    acpManager.setSessionMode(sid, mode),
  );
  ipcMain.handle(IPC.chGetSessionMode, (_e, sid: string) => acpManager.getSessionMode(sid));
  // per-session 模型(null=清除覆盖跟随 kimi 默认);model-options 为缓存的选项清单
  ipcMain.handle(IPC.chSetSessionModel, (_e, sid: string, model: string | null) =>
    acpManager.setSessionModel(sid, model),
  );
  ipcMain.handle(IPC.chGetSessionModel, (_e, sid: string) => acpManager.getSessionModel(sid));
  ipcMain.handle(IPC.chModelOptions, () => acpManager.getModelOptions());
  // per-session 思考深度('low'|'high'|'max'|null;null=清除覆盖回退全局)
  ipcMain.handle(IPC.chSetSessionThinking, (_e, sid: string, thinking: 'low' | 'high' | 'max' | null) =>
    acpManager.setSessionThinking(sid, thinking),
  );
  ipcMain.handle(IPC.chGetSessionThinking, (_e, sid: string) => acpManager.getSessionThinking(sid));
  ipcMain.handle(IPC.chProjectCreate, (_e, name: string, p?: string) => createChannelProject(name, p ?? null));
  // 原生目录选择器(新建项目用;不带 pickWorkspaceDir 写 settings 的副作用),取消返回 null
  ipcMain.handle(IPC.chPickFolder, async () => {
    const win = getWorkbenchWindow() ?? getChatWindow();
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    return { name: path.basename(dir), path: dir };
  });

  // ---- channel P2: 常驻 agent 库 + session 三配置 + 会话生命周期 (design/design-v7.md §10) ----
  ipcMain.handle(IPC.chAgentList, () => listAgents());
  ipcMain.handle(IPC.chAgentCreate, (_e, name: string, description?: string) => createAgent(name, description ?? ''));
  ipcMain.handle(IPC.chAgentUpdate, (_e, id: string, patch: { description?: string; avatar?: string }) =>
    updateAgent(id, patch ?? {}),
  );
  ipcMain.handle(IPC.chAgentDelete, (_e, id: string) => deleteAgent(id));
  ipcMain.handle(IPC.chAgentRead, (_e, id: string) => readAgentMd(id));
  ipcMain.handle(IPC.chAgentWrite, (_e, id: string, content: string) => writeAgentMd(id, content));
  // 三配置:渲染层只传 sid,cwd 由主进程解析(运行时注册表 → 磁盘 state.json 扫描)
  const resolveCwd = (sid: string): string | null => acpManager.getSessionCwd(sid) ?? findSessionCwd(sid);
  ipcMain.handle(IPC.chSessionConfigRead, (_e, sid: string) => {
    const cwd = resolveCwd(sid);
    return cwd ? readSessionConfig(cwd, sid) : null;
  });
  ipcMain.handle(IPC.chSessionConfigWrite, (_e, sid: string, field: SessionConfigField, content: string) => {
    const cwd = resolveCwd(sid);
    if (!cwd) throw new Error(`unknown session cwd: ${sid}`);
    writeSessionConfig(cwd, sid, field, content);
  });
  ipcMain.handle(IPC.chNewSession, async (_e, opts: { cwd: string; agentId?: string }) => {
    // 包一层日志:渲染层只报 IPC error,具体栈要能在主进程日志里查到
    try {
      return await acpManager.newChannelSession(opts);
    } catch (err) {
      console.error('[ch:new-session] failed:', err);
      throw err;
    }
  });
  ipcMain.handle(IPC.chDeleteSession, (_e, sid: string) => acpManager.deleteSession(sid));

  // ---- channel P3a: group 协作 + 动态编排 + worktree + fork (design/design-v7.md §4/§5) ----
  ipcMain.handle(IPC.chGroupCreate, (_e, opts: { name: string; projectId?: string; cwd?: string; members: { sessionId: string; role?: string }[] }) =>
    groupOrchestrator.createGroup(opts),
  );
  ipcMain.handle(IPC.chGroupList, (_e, projectId?: string) => groupOrchestrator.listGroups(projectId));
  ipcMain.handle(IPC.chGroupSend, (_e, groupId: string, text: string) => groupOrchestrator.sendToGroup(groupId, text));
  ipcMain.handle(IPC.chGroupMessages, (_e, groupId: string) => groupOrchestrator.getMessages(groupId));
  ipcMain.handle(IPC.chGroupConfig, (_e, groupId: string, patch: GroupConfigPatch) =>
    groupOrchestrator.updateGroupConfig(groupId, patch),
  );
  ipcMain.handle(IPC.chGroupAddMember, (_e, groupId: string, sessionId: string, role?: string) =>
    groupOrchestrator.addMember(groupId, sessionId, role),
  );
  ipcMain.handle(IPC.chGroupCreateMember, (_e, groupId: string, opts: { name: string; description: string }) =>
    groupOrchestrator.createGroupMember(groupId, opts),
  );
  ipcMain.handle(IPC.chGroupRemoveMember, (_e, groupId: string, sessionId: string) =>
    groupOrchestrator.removeMember(groupId, sessionId),
  );
  ipcMain.handle(IPC.chGroupDelete, (_e, groupId: string) => groupOrchestrator.deleteGroup(groupId));
  ipcMain.handle(IPC.chGroupPlan, (_e, opts: { taskDescription: string; memberSessionIds: string[] }) =>
    groupOrchestrator.planOrchestration(opts),
  );
  ipcMain.handle(IPC.chOrchestrationPrefRead, () => getSettings().orchestrationPref ?? '');
  ipcMain.handle(IPC.chOrchestrationPrefWrite, (_e, text: string) => {
    saveSettings({ orchestrationPref: typeof text === 'string' ? text : '' });
  });
  ipcMain.handle(IPC.chWorktreeCreate, (_e, opts: { repoPath: string; taskSlug: string }) => createWorktree(opts));
  ipcMain.handle(IPC.chWorktreeList, (_e, repoPath: string) => listWorktrees(repoPath));
  ipcMain.handle(IPC.chWorktreeDiff, (_e, repoPath: string, branch: string) => getDiff(repoPath, branch));
  ipcMain.handle(IPC.chWorktreeMerge, (_e, opts: { repoPath: string; branch: string }) => mergeWorktree(opts));
  ipcMain.handle(IPC.chWorktreeDiscard, (_e, opts: { repoPath: string; path: string; branch: string }) =>
    discardWorktree(opts),
  );
  ipcMain.handle(IPC.chForkSession, (_e, sid: string) => acpManager.forkSession(sid));

  // ---- 终端三视图 (v7.0 P3b, design/design-v7.md §12) ----
  ipcMain.handle(IPC.termOpen, (_e, sid: string) => terminalManager.openTerminal(sid));
  ipcMain.on(IPC.termInput, (_e, termId: string, data: string) => terminalManager.input(termId, data));
  ipcMain.on(IPC.termResize, (_e, termId: string, cols: number, rows: number) =>
    terminalManager.resize(termId, cols, rows),
  );
  ipcMain.on(IPC.termClose, (_e, termId: string) => terminalManager.close(termId));
  ipcMain.handle(IPC.termVisOpen, (_e, sid: string) => terminalManager.openVis(sid));
  ipcMain.on(IPC.termVisClose, (_e, visId: string) => terminalManager.closeVis(visId));
  ipcMain.handle(IPC.termOpenExternal, (_e, sid: string) => terminalManager.openExternalTerminal(sid));
  ipcMain.handle(IPC.termRelease, (_e, sid: string) => acpManager.releaseSession(sid));
  ipcMain.handle(IPC.termIsHeld, (_e, sid: string) => acpManager.isHeld(sid));
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
    // channel: 一次性 100 天历史整理(显式打标,幂等;之后归档不再按时间计算)
    if (runArchiveMigration() > 0) {
      const wc = getWorkbenchWindow()?.webContents;
      if (wc && !wc.isDestroyed()) wc.send(IPC.evChChanged);
    }
    sessionScanner.start(); // channel: fs.watch ~/.kimi-code/sessions(debounce 2s → ch:changed)
    startBackupSchedule();
    getDb(); // 打开 jarvis.db
    migrateFromJson(); // 一次性从 JSON 迁移（幂等）
    setInterval(checkOverdueTasks, 3600_000).unref();
    setTimeout(checkOverdueTasks, 60_000);

    // workbench MCP server (self-evolution plane, design/design-evolve.md E1)
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
    sessionScanner.stop();
    terminalManager.dispose(); // 杀掉所有 pty / kimi vis 子进程
    disposeWindows();
    void acpManager.dispose();
  });

  // keep running even when all windows are "closed" (ball is always-on)
  app.on('window-all-closed', () => {
    /* no-op */
  });
}
