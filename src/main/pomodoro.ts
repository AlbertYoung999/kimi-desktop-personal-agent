import { BrowserWindow } from 'electron';
import { IPC } from '../shared/types.js';
import type { PomodoroState } from '../shared/workbench-types.js';
import { addPomodoro, listTasks } from './workbench.js';
import { getTodoPanelWindow, pushFocusStatus } from './windows.js';

/**
 * 番茄钟引擎（v5.0）：main 进程持有进行中的番茄钟状态，
 * 任何窗口（今日待办 tab / 桌面面板）都可以 start/stop，状态向所有窗口广播。
 * 结束（跑完或提前停止）时写入 pomodoro_sessions 表用于统计复盘。
 * 倒计时外显：今日待办灵动岛开着时由它展示；否则回落到 focus-pill 灵动岛。
 */

const DEFAULT_DURATION_MIN = 25;

let current: { taskId: string; taskTitle: string; startedAt: number; durationMin: number } | null = null;
let timer: NodeJS.Timeout | null = null;

export function getPomodoroState(): PomodoroState {
  if (!current) return { active: false };
  return { active: true, ...current };
}

function broadcast(): void {
  const state = getPomodoroState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.evPomodoroState, state);
  }
}

/** 今日待办灵动岛开着时倒计时由它展示，不再弹 focus-pill，避免双 pill */
function pushPillStatus(status: { active: boolean } & Record<string, unknown>): void {
  if (getTodoPanelWindow()) {
    if (!status.active) pushFocusStatus(status); // 关掉可能残留的 focus-pill
    return;
  }
  pushFocusStatus(status);
}

function finish(completed: boolean): void {
  if (!current) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const elapsedMin = Math.max(1, Math.round((Date.now() - current.startedAt) / 60000));
  addPomodoro({
    taskId: current.taskId,
    startedAt: current.startedAt,
    endedAt: Date.now(),
    minutes: completed ? current.durationMin : Math.min(elapsedMin, current.durationMin),
    completed,
  });
  current = null;
  broadcast();
  pushPillStatus({ active: false, mode: 'pomo', task: '', remainingMs: 0, paused: false });
}

export function startPomodoro(taskId: string, durationMin = DEFAULT_DURATION_MIN): PomodoroState {
  // 已有进行中的番茄钟：先按未完成落账，避免丢记录
  if (current) finish(false);
  const task = listTasks().find((t) => t.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  current = { taskId, taskTitle: task.title, startedAt: Date.now(), durationMin };
  timer = setTimeout(() => finish(true), durationMin * 60_000);
  broadcast();
  pushPillStatus({
    active: true,
    mode: 'pomo',
    task: task.title,
    remainingMs: durationMin * 60_000,
    paused: false,
    // focus-pill 据此本地每秒倒计时
    startedAt: current.startedAt,
    durationMin,
  });
  return getPomodoroState();
}

export function stopPomodoro(completed: boolean): PomodoroState {
  finish(completed);
  return getPomodoroState();
}
