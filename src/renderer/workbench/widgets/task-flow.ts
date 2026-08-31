import { registerWidget } from '../core/registry';
import type {
  PomodoroSession,
  PomodoroState,
  Project,
  Task,
  TaskPriority,
  TaskRecurrence,
  TaskStatus,
} from '../../../shared/workbench-types';
import { DEFAULT_PROJECT_ID } from '../../../shared/workbench-types';

/* ------------------------------------------------------------------ */
/* styles (injected once, all classes prefixed wf-task-flow-)          */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'wf-task-flow-style';
const CSS = `
.wf-task-flow-root { position: relative; height: 100%; display: flex; flex-direction: column; gap: 10px; }
.wf-task-flow-topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.wf-task-flow-viewbtn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11.5px; padding: 4px 10px; cursor: pointer;
}
.wf-task-flow-viewgroup { display: flex; flex-shrink: 0; }
.wf-task-flow-viewbtn:first-child { border-radius: 6px 0 0 6px; }
.wf-task-flow-viewbtn:not(:first-child) { border-left: none; }
.wf-task-flow-viewbtn:last-child { border-radius: 0 6px 6px 0; }
.wf-task-flow-viewbtn.active { color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.06); z-index: 1; position: relative; }
.wf-task-flow-search {
  flex: 1; min-width: 60px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 12px;
  padding: 4px 10px; outline: none;
}
.wf-task-flow-search:focus { border-color: var(--border-strong); }
.wf-task-flow-newbtn {
  border: 1px solid var(--border-strong); background: rgba(0,240,255,0.08); color: var(--neon);
  font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  transition: box-shadow 160ms var(--ease-in); white-space: nowrap;
}
.wf-task-flow-newbtn:hover { box-shadow: 0 0 12px rgba(0,240,255,0.25); }
.wf-task-flow-content { flex: 1; overflow: auto; min-height: 0; }

/* board */
.wf-task-flow-board { display: flex; gap: 10px; height: 100%; min-width: min-content; }
.wf-task-flow-col {
  flex: 1 1 0; min-width: 200px; display: flex; flex-direction: column;
  background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05);
  border-radius: 10px; overflow: hidden;
}
.wf-task-flow-col.dragover { border-color: var(--border-strong); background: rgba(0,240,255,0.04); }
.wf-task-flow-colhead {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 1px; color: var(--muted);
  border-bottom: 1px solid rgba(255,255,255,0.05); flex-shrink: 0;
}
.wf-task-flow-colcount {
  margin-left: auto; color: var(--neon); border: 1px solid var(--border);
  border-radius: 8px; padding: 0 7px; font-size: 10px; line-height: 16px;
}
.wf-task-flow-cards { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
.wf-task-flow-card {
  position: relative;
  display: flex; gap: 8px; align-items: flex-start; background: var(--card);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  cursor: grab; transition: border-color 120ms var(--ease-in);
}
.wf-task-flow-card:hover { border-color: var(--border-strong); }
.wf-task-flow-card.dragging { opacity: 0.4; }
.wf-task-flow-dot {
  width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex-shrink: 0;
  cursor: pointer; box-shadow: 0 0 6px currentColor;
}
.wf-task-flow-cardmain { flex: 1; min-width: 0; }
.wf-task-flow-cardtitlerow { display: flex; align-items: baseline; gap: 5px; }
.wf-task-flow-cardtitle { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.4; cursor: text; word-break: break-word; }
.wf-task-flow-recur { font-size: 11px; color: var(--muted); flex-shrink: 0; cursor: default; }
.wf-task-flow-card.done .wf-task-flow-cardtitle { color: var(--disabled); text-decoration: line-through; }
.wf-task-flow-carddue { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 4px; }
.wf-task-flow-carddue.overdue { color: var(--error); }
.wf-task-flow-carddue.today { color: var(--neon); text-shadow: 0 0 8px rgba(0,240,255,0.45); }
.wf-task-flow-titleedit {
  width: 100%; border: 1px solid var(--border-strong); border-radius: 4px;
  background: rgba(0,0,0,0.3); color: var(--fg); font: inherit; font-size: 12.5px;
  padding: 2px 6px; outline: none;
}
.wf-task-flow-quick {
  border: none; border-top: 1px solid rgba(255,255,255,0.05); background: transparent;
  color: var(--disabled); font: inherit; font-size: 12px; padding: 8px 10px; outline: none;
  flex-shrink: 0;
}
.wf-task-flow-quick:focus { color: var(--fg); }
.wf-task-flow-quick::placeholder { color: var(--disabled); }

/* calendar */
.wf-task-flow-cal { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wf-task-flow-calhead { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.wf-task-flow-calnav {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.wf-task-flow-calnav:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-task-flow-caltitle { font-family: var(--mono); font-size: 12px; color: var(--neon); letter-spacing: 1px; }
.wf-task-flow-calgrid {
  flex: 1; display: grid; grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: 1fr; gap: 4px; min-height: 0;
}
.wf-task-flow-calgrid.weekdays { flex: none; grid-auto-rows: none; }
.wf-task-flow-calwd { font-family: var(--mono); font-size: 10px; color: var(--disabled); text-align: center; padding: 2px 0; }
.wf-task-flow-cell {
  border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 4px 5px;
  overflow: hidden; display: flex; flex-direction: column; gap: 2px; min-height: 56px;
}
.wf-task-flow-cell.out { opacity: 0.3; }
.wf-task-flow-cell.today { border-color: var(--border-strong); box-shadow: inset 0 0 10px rgba(0,240,255,0.08); }
.wf-task-flow-daynum { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.wf-task-flow-cell.today .wf-task-flow-daynum { color: var(--neon); }
.wf-task-flow-chip {
  font-size: 10.5px; line-height: 1.3; padding: 1px 5px; border-radius: 4px;
  background: rgba(0,240,255,0.08); border-left: 2px solid var(--neon);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.wf-task-flow-chip.done { opacity: 0.45; text-decoration: line-through; }
.wf-task-flow-chip.overdue { background: rgba(255,68,68,0.1); border-left-color: var(--error); color: var(--error); }

/* project selector */
.wf-task-flow-projsel {
  max-width: 132px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 11.5px;
  padding: 4px 6px; outline: none; flex-shrink: 0; cursor: pointer;
}
.wf-task-flow-projsel:focus { border-color: var(--border-strong); }
.wf-task-flow-projsel option { background: var(--card); }
.wf-task-flow-projinput {
  width: 132px; border: 1px solid var(--border-strong); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 11.5px;
  padding: 4px 6px; outline: none; flex-shrink: 0;
}
.wf-task-flow-projinput::placeholder { color: var(--disabled); }
.wf-task-flow-cardproj {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; margin-right: 26px;
  font-family: var(--mono); font-size: 10px; color: var(--muted); line-height: 16px;
}
.wf-task-flow-cardproj-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
.wf-task-flow-play {
  position: absolute; right: 8px; bottom: 8px; width: 22px; height: 22px; padding: 0;
  border: 1px solid rgba(0,240,255,0.35); border-radius: 50%;
  background: rgba(0,240,255,0.08); color: var(--neon); font-size: 9px; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 120ms var(--ease-in), box-shadow 120ms var(--ease-in);
}
.wf-task-flow-play:hover { transform: scale(1.18); box-shadow: 0 0 10px rgba(0,240,255,0.35); }
.wf-task-flow-play:disabled { opacity: 0.5; cursor: default; transform: none; }
.wf-task-flow-projedit { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.wf-task-flow-colordots { display: flex; align-items: center; gap: 5px; }
.wf-task-flow-colordot {
  width: 12px; height: 12px; border-radius: 50%; border: 1px solid transparent;
  cursor: pointer; padding: 0; flex-shrink: 0;
}
.wf-task-flow-colordot.active { border-color: #fff; box-shadow: 0 0 6px currentColor; }
.wf-task-flow-projeditbtn {
  border: 1px solid var(--border); background: transparent; color: var(--disabled);
  font: inherit; font-size: 11px; width: 24px; height: 24px; border-radius: 6px;
  cursor: pointer; flex-shrink: 0;
}
.wf-task-flow-projeditbtn:hover { color: var(--neon); border-color: var(--border-strong); }

/* empty state */
.wf-task-flow-empty {
  height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--disabled); font-size: 12.5px;
}
.wf-task-flow-empty kbd {
  font-family: var(--mono); border: 1px solid var(--border-strong); border-radius: 4px;
  color: var(--neon); padding: 1px 6px; font-size: 11px;
}

/* detail panel */
.wf-task-flow-panel {
  position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 88%);
  background: var(--card); border-left: 1px solid var(--border-strong);
  box-shadow: -12px 0 32px rgba(0,0,0,0.5); z-index: 10;
  display: flex; flex-direction: column; animation: wf-task-flow-slidein 180ms var(--ease-in);
}
@keyframes wf-task-flow-slidein { from { transform: translateX(24px); opacity: 0; } }
.wf-task-flow-panelhead {
  display: flex; align-items: center; padding: 10px 12px; gap: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;
}
.wf-task-flow-panelhead span { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: 1px; }
.wf-task-flow-saved { font-size: 10px !important; color: var(--disabled) !important; letter-spacing: 0 !important; margin-left: 6px; }
.wf-task-flow-panelclose {
  margin-left: auto; border: none; background: none; color: var(--disabled);
  font-size: 15px; cursor: pointer; width: 24px; height: 24px; border-radius: 5px;
}
.wf-task-flow-panelclose:hover { color: var(--fg); background: rgba(255,255,255,0.08); }
.wf-task-flow-panelbody { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.wf-task-flow-ptitle {
  border: none; background: transparent; color: var(--fg); font: inherit;
  font-size: 16px; font-weight: 600; padding: 4px 0; outline: none;
  border-bottom: 1px solid transparent;
}
.wf-task-flow-ptitle:focus { border-bottom-color: var(--border-strong); }
.wf-task-flow-field { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.wf-task-flow-field label { width: 56px; flex-shrink: 0; color: var(--disabled); font-size: 11px; }
.wf-task-flow-input, .wf-task-flow-select, .wf-task-flow-textarea {
  flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 12px;
  padding: 5px 8px; outline: none;
}
.wf-task-flow-input:focus, .wf-task-flow-select:focus, .wf-task-flow-textarea:focus { border-color: var(--border-strong); }
.wf-task-flow-input[type="datetime-local"] { color-scheme: dark; font-family: var(--mono); font-size: 11.5px; }
.wf-task-flow-input[type="datetime-local"]::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.55; }
.wf-task-flow-input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover { opacity: 1; }
.wf-task-flow-select option { background: var(--card); }
.wf-task-flow-textarea { resize: vertical; min-height: 110px; font-family: var(--mono); line-height: 1.5; }
.wf-task-flow-panelfoot {
  display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0; flex-wrap: wrap;
}
.wf-task-flow-btn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
}
.wf-task-flow-btn:hover { color: var(--fg); border-color: var(--border-strong); }
.wf-task-flow-btn.primary { color: var(--neon); border-color: var(--border-strong); background: rgba(0,240,255,0.08); }
.wf-task-flow-btn.primary:hover { box-shadow: 0 0 12px rgba(0,240,255,0.25); }
.wf-task-flow-btn.danger:hover { color: var(--error); border-color: var(--error); }
.wf-task-flow-btn.session { color: var(--green); border-color: rgba(0,255,136,0.35); background: rgba(0,255,136,0.06); }
.wf-task-flow-btn:disabled { opacity: 0.5; cursor: default; }

/* subtasks */
.wf-task-flow-subprog { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 4px; }
.wf-task-flow-sublist { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.wf-task-flow-sub {
  display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted);
  padding: 1px 0 1px 8px; border-left: 2px solid var(--border); cursor: pointer;
}
.wf-task-flow-sub:hover { color: var(--fg); }
.wf-task-flow-subdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 5px currentColor; }
.wf-task-flow-subtitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-task-flow-sub.done .wf-task-flow-subtitle { color: var(--disabled); text-decoration: line-through; }
.wf-task-flow-subsec { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; }
.wf-task-flow-subsec-title { font-family: var(--mono); font-size: 11px; letter-spacing: 1px; color: var(--muted); }
.wf-task-flow-subrow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.wf-task-flow-subrow input[type="checkbox"] { accent-color: var(--neon); margin: 0; flex-shrink: 0; cursor: pointer; }
.wf-task-flow-subrow-title { flex: 1; min-width: 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-task-flow-subrow-title:hover { color: var(--neon); }
.wf-task-flow-subrow-title.done { color: var(--disabled); text-decoration: line-through; }
.wf-task-flow-subdel {
  border: none; background: none; color: var(--disabled); cursor: pointer;
  font-size: 12px; width: 20px; height: 20px; border-radius: 4px; flex-shrink: 0; padding: 0;
}
.wf-task-flow-subdel:hover { color: var(--error); background: rgba(255,68,68,0.1); }
.wf-task-flow-subadd { display: flex; gap: 6px; }

/* today view */
.wf-task-flow-today { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wf-task-flow-todayhead { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.wf-task-flow-todaytitle { font-family: var(--mono); font-size: 12px; color: var(--neon); letter-spacing: 1px; }
.wf-task-flow-pinbtn { margin-left: auto; }
.wf-task-flow-focusbar {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0;
  border: 1px solid var(--border-strong); border-radius: 8px;
  background: rgba(0,240,255,0.06); color: var(--neon);
  padding: 6px 10px; font-size: 12px;
}
.wf-task-flow-pomoreman { font-family: var(--mono); font-size: 10.5px; color: var(--neon); flex-shrink: 0; }
.wf-task-flow-focusbar .wf-task-flow-pomoreman { margin-left: auto; font-size: 12px; }
.wf-task-flow-todaylist { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.wf-task-flow-todaynone { color: var(--disabled); font-size: 12px; padding: 16px; text-align: center; }
.wf-task-flow-todayrow {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--card); border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px;
}
.wf-task-flow-todayrow:hover { border-color: var(--border-strong); }
.wf-task-flow-todayrow.done { opacity: 0.45; }
.wf-task-flow-todayrow.done .wf-task-flow-todotitle { text-decoration: line-through; }
/* 子任务行：缩进一级 + 左侧细竖线，整体小一号 */
.wf-task-flow-todayrow.sub {
  margin-left: 24px; padding: 4px 10px; font-size: 11.5px;
  border-left: 2px solid var(--border); border-radius: 0 8px 8px 0;
  background: rgba(255,255,255,0.015);
}
.wf-task-flow-todayrow.sub .wf-task-flow-todot { width: 6px; height: 6px; }
/* 行 hover 操作按钮：默认隐藏，hover 显示；计时中的 ⏹ 常显 */
.wf-task-flow-todoacts { display: none; align-items: center; gap: 4px; flex-shrink: 0; }
.wf-task-flow-todayrow:hover .wf-task-flow-todoacts, .wf-task-flow-todoacts.timing { display: flex; }
.wf-task-flow-sessionbtn { color: var(--green); border-color: rgba(0,255,136,0.35); background: rgba(0,255,136,0.06); }
.wf-task-flow-sessionbtn:hover { box-shadow: 0 0 10px rgba(0,255,136,0.35); }
/* 已过期折叠区 */
.wf-task-flow-overdue {
  flex-shrink: 0; display: flex; flex-direction: column; gap: 4px;
  border-top: 1px solid rgba(255,255,255,0.06); padding-top: 6px;
}
.wf-task-flow-overduehead {
  border: none; background: none; color: var(--muted); font: inherit;
  font-family: var(--mono); font-size: 11px; letter-spacing: 1px;
  text-align: left; padding: 2px 0; cursor: pointer;
}
.wf-task-flow-overduehead:hover { color: var(--warn); }
.wf-task-flow-overduelist { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.wf-task-flow-todayrow.overdue .wf-task-flow-todotitle { color: var(--muted); }
.wf-task-flow-overduedate { font-family: var(--mono); font-size: 10px; color: var(--warn); flex-shrink: 0; }
.wf-task-flow-todayrow input[type="checkbox"] { accent-color: var(--neon); margin: 0; flex-shrink: 0; cursor: pointer; }
.wf-task-flow-todot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
.wf-task-flow-todotitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.wf-task-flow-todotitle:hover { color: var(--neon); }
.wf-task-flow-todoparent { font-size: 10.5px; color: var(--disabled); flex-shrink: 0; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-task-flow-todotime { font-family: var(--mono); font-size: 10px; color: var(--muted); flex-shrink: 0; }
.wf-task-flow-todotime.overdue { color: var(--error); }
.wf-task-flow-pomo {
  width: 22px; height: 22px; padding: 0; border: 1px solid rgba(0,240,255,0.35); border-radius: 50%;
  background: rgba(0,240,255,0.08); color: var(--neon); font-size: 9px; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: box-shadow 120ms var(--ease-in);
}
.wf-task-flow-pomo:hover { box-shadow: 0 0 10px rgba(0,240,255,0.35); }
.wf-task-flow-pomo.timing { color: var(--error); border-color: rgba(255,68,68,0.4); background: rgba(255,68,68,0.08); }
.wf-task-flow-pomo:disabled { opacity: 0.5; cursor: default; }
.wf-task-flow-todaystats {
  flex-shrink: 0; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 8px;
  display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted);
}
.wf-task-flow-todaystats .total { color: var(--neon); font-family: var(--mono); }

/* schedule view (week grid) */
.wf-task-flow-sched { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.wf-task-flow-schedbody { flex: 1; display: flex; gap: 8px; min-height: 0; }
.wf-task-flow-schedside {
  width: 148px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px;
  overflow-y: auto; border: 1px solid rgba(255,255,255,0.05); border-radius: 8px;
  padding: 6px; background: rgba(255,255,255,0.02);
}
.wf-task-flow-schedside-title { font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--disabled); padding: 2px 2px 4px; }
.wf-task-flow-unsched {
  font-size: 11px; line-height: 1.3; padding: 3px 6px; border-radius: 4px;
  background: var(--card); border: 1px solid var(--border); border-left: 2px solid var(--neon);
  cursor: grab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;
}
.wf-task-flow-unsched:hover { border-color: var(--border-strong); }
.wf-task-flow-schedscroll { flex: 1; overflow: auto; min-width: 0; border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; }
.wf-task-flow-schedgrid { display: grid; grid-template-columns: 44px repeat(7, minmax(88px, 1fr)); width: 100%; min-width: min-content; }
.wf-task-flow-schedday {
  font-family: var(--mono); font-size: 10px; color: var(--muted); text-align: center;
  padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
}
.wf-task-flow-schedday.today { color: var(--neon); text-shadow: 0 0 8px rgba(0,240,255,0.45); }
.wf-task-flow-schedtimes { position: relative; border-right: 1px solid rgba(255,255,255,0.06); }
.wf-task-flow-schedtime {
  position: absolute; right: 4px; transform: translateY(-50%);
  font-family: var(--mono); font-size: 9px; color: var(--disabled);
}
.wf-task-flow-schedcol {
  position: relative; border-right: 1px solid rgba(255,255,255,0.05);
  background-image: repeating-linear-gradient(to bottom, rgba(255,255,255,0.04) 0 1px, transparent 1px 36px);
}
.wf-task-flow-schedcol.today { background-color: rgba(0,240,255,0.03); }
.wf-task-flow-schedcol.dragover { background-color: rgba(0,240,255,0.06); }
.wf-task-flow-schedblock {
  position: absolute; left: 2px; right: 2px; border-radius: 4px;
  background: rgba(0,240,255,0.08); border-left: 2px solid var(--neon);
  font-size: 10px; line-height: 1.3; padding: 2px 4px; overflow: hidden; cursor: grab; z-index: 1;
}
.wf-task-flow-schedblock:hover { background: rgba(0,240,255,0.14); }
.wf-task-flow-schedblock .t { font-family: var(--mono); font-size: 9px; color: var(--muted); }
.wf-task-flow-schedblock.done { opacity: 0.45; text-decoration: line-through; }
.wf-task-flow-schedblock.dragging { opacity: 0.4; }
.wf-task-flow-schedresize { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
.wf-task-flow-schedghost {
  position: absolute; left: 2px; right: 2px; border-radius: 4px;
  border: 1px dashed var(--neon); background: rgba(0,240,255,0.1); pointer-events: none; z-index: 2;
}
`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'BACKLOG' },
  { id: 'todo', label: 'TODO' },
  { id: 'in_progress', label: 'IN PROGRESS' },
  { id: 'done', label: 'DONE' },
];

const PRIORITY_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
const PRIORITY_COLOR: Record<TaskPriority, string> = {
  urgent: 'var(--error)',
  high: 'var(--warn)',
  medium: 'var(--neon)',
  low: 'var(--disabled)',
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 视图模式：看板 / 月历 / 今日 / 日程（周视图） */
type ViewMode = 'board' | 'calendar' | 'today' | 'schedule';
const VIEW_MODES: ViewMode[] = ['board', 'calendar', 'today', 'schedule'];

/* 日程视图常量：纵轴 06:00–24:00，每小时 36px */
const SCHED_START_HOUR = 6;
const SCHED_HOURS = 18;
const SCHED_HOUR_H = 36;

const RECURRENCE_ORDER: TaskRecurrence[] = ['none', 'daily', 'workdays', 'weekly'];
const RECURRENCE_LABEL: Record<TaskRecurrence, string> = {
  none: '不重复',
  daily: '每天',
  workdays: '工作日',
  weekly: '每周',
};

/** 项目标签色板：按项目名 hash 取色 */
const PROJECT_PALETTE = ['#00f0ff', '#00ff88', '#ffb020', '#ff7ab8', '#9d7bff', '#ff8844'];

function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PROJECT_PALETTE[Math.abs(h) % PROJECT_PALETTE.length];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function newId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 旧的纯日期格式 YYYY-MM-DD（datetime 改造前的存量数据） */
function isLegacyDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 本地日期 key YYYY-MM-DD，用于日历归格 / 与今天比较（兼容旧纯日期格式） */
function dateKey(s: string): string {
  if (isLegacyDate(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Date → 本地日期 key YYYY-MM-DD（日程视图按列归格用） */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 是否携带具体时间（旧纯日期格式视为无时间） */
function hasClock(s: string): boolean {
  return !isLegacyDate(s) && s.includes('T');
}

/** ISO string → datetime-local 输入框需要的本地格式 YYYY-MM-DDTHH:mm */
function toLocalInput(s?: string): string {
  if (!s) return '';
  if (isLegacyDate(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return `${dateKey(s)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 卡片/chip 显示：M/d，带时间时 M/d HH:mm */
function fmtWhen(s: string): string {
  if (isLegacyDate(s)) {
    const parts = s.split('-');
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const base = `${d.getMonth() + 1}/${d.getDate()}`;
  return hasClock(s) ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
}

/** HH:mm（仅日历 chip 用，调用前需 hasClock 判断） */
function clockOf(s: string): string {
  const d = new Date(s);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** HH:MM:SS，详情面板「已保存」微提示用 */
function clockHMS(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function isOverdue(t: Task): boolean {
  if (!t.dueDate || t.status === 'done' || t.status === 'canceled') return false;
  // 带时间的按时刻比较；旧纯日期格式按天比较（当天不算逾期）
  if (isLegacyDate(t.dueDate)) return t.dueDate < todayStr();
  const ts = new Date(t.dueDate).getTime();
  return !isNaN(ts) && ts < Date.now();
}

function isDueToday(t: Task): boolean {
  return (
    !!t.dueDate &&
    t.status !== 'done' &&
    t.status !== 'canceled' &&
    !isOverdue(t) &&
    dateKey(t.dueDate) === todayStr()
  );
}

function matchesQuery(t: Task, q: string): boolean {
  if (!q) return true;
  const hay = `${t.title}\n${t.description}\n${t.tags.join(' ')}`.toLowerCase();
  return hay.includes(q);
}

function blankTask(status: TaskStatus): Task {
  const now = Date.now();
  return {
    id: newId(),
    title: '',
    description: '',
    status,
    priority: 'medium',
    notes: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* widget                                                              */
/* ------------------------------------------------------------------ */

registerWidget({
  def: {
    id: 'task-flow',
    name: 'Task Flow',
    icon: '▦',
    description: '任务看板：看板/日历视图，任务可转 AI Session',
    category: 'productivity',
    defaultSize: { w: 16, h: 12 },
    minSize: { w: 10, h: 8 },
  },
  mount(body, ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    const now = new Date();
    const savedView = typeof ctx.config.view === 'string' ? ctx.config.view : '';
    const state = {
      tasks: [] as Task[],
      projects: [] as Project[],
      /** 'all' = 全部项目，否则为项目 id */
      projectId: (typeof ctx.config.projectId === 'string' ? ctx.config.projectId : DEFAULT_PROJECT_ID) as string,
      view: (VIEW_MODES.includes(savedView as ViewMode) ? savedView : 'board') as ViewMode,
      query: '',
      calYear: now.getFullYear(),
      calMonth: now.getMonth(),
      /** 日程视图：相对当前周的偏移（不持久化） */
      weekOffset: 0,
      /** 进行中的番茄钟（main 进程推送 + mount 时拉取） */
      pomo: { active: false } as PomodoroState,
    };

    const root = el('div', 'wf-task-flow-root');
    const topbar = el('div', 'wf-task-flow-topbar');
    const content = el('div', 'wf-task-flow-content');
    root.append(topbar, content);
    body.innerHTML = '';
    body.appendChild(root);

    let panelEl: HTMLElement | null = null;

    /* ---------- data ---------- */

    async function reload(): Promise<void> {
      try {
        [state.tasks, state.projects] = await Promise.all([ctx.api.listTasks(), ctx.api.listProjects()]);
      } catch {
        state.tasks = [];
        state.projects = [];
      }
      if (state.projectId !== 'all' && !state.projects.some((p) => p.id === state.projectId)) {
        state.projectId = DEFAULT_PROJECT_ID;
      }
      renderProjectOptions();
      renderContent();
    }

    async function persist(task: Task): Promise<void> {
      task.updatedAt = Date.now();
      state.tasks = await ctx.api.saveTask(task);
      renderContent();
    }

    async function removeTask(id: string): Promise<void> {
      state.tasks = await ctx.api.deleteTask(id);
      renderContent();
    }

    /** 启动任务 Session：status→in_progress，payload 带 notes，startTaskSession 后落盘 */
    async function launchTaskSession(t: Task): Promise<void> {
      // PRD：assign 给 Agent 后任务进入进行中，否则 Agent 不会执行
      t.status = 'in_progress';
      t.completedAt = undefined;
      // 子任务：把主任务上下文一并带给 agent
      const parent = t.parentId ? state.tasks.find((x) => x.id === t.parentId) : undefined;
      const payload = JSON.stringify({
        task: {
          id: t.id,
          title: t.title,
          description: t.description,
          notes: t.notes,
          status: t.status,
          priority: t.priority,
          startDate: t.startDate,
          dueDate: t.dueDate,
          tags: t.tags,
        },
        ...(parent
          ? {
              parent: {
                id: parent.id,
                title: parent.title,
                description: parent.description,
                notes: parent.notes,
                dueDate: parent.dueDate,
              },
            }
          : {}),
        context: '你需要帮我完成这个任务，请基于描述给出执行建议或直接开始。',
      });
      const sessionId = await ctx.api.startTaskSession(payload);
      t.sessionId = sessionId;
      await persist(t);
    }

    /** 任务归属项目：未显式挂载的存量任务视为默认项目 */
    function taskProject(t: Task): string {
      return t.projectId ?? DEFAULT_PROJECT_ID;
    }

    function projectName(id: string): string {
      return state.projects.find((p) => p.id === id)?.name ?? '默认';
    }

    /** 项目标识色：优先项目自带 color，存量项目回退到按名 hash */
    function projectColorOf(id: string): string {
      const p = state.projects.find((x) => x.id === id);
      return p?.color ?? projectColor(p?.name ?? '默认');
    }

    function filtered(): Task[] {
      return state.tasks.filter(
        (t) => (state.projectId === 'all' || taskProject(t) === state.projectId) && matchesQuery(t, state.query),
      );
    }

    /** 新建任务时的默认归属项目 */
    function activeProjectId(): string {
      return state.projectId === 'all' ? DEFAULT_PROJECT_ID : state.projectId;
    }

    /* ---------- topbar ---------- */

    const btnBoard = el('button', 'wf-task-flow-viewbtn', '看板');
    const btnCal = el('button', 'wf-task-flow-viewbtn', '日历');
    const btnToday = el('button', 'wf-task-flow-viewbtn', '今日');
    const btnSched = el('button', 'wf-task-flow-viewbtn', '日程');
    const viewGroup = el('div', 'wf-task-flow-viewgroup');
    viewGroup.append(btnBoard, btnCal, btnToday, btnSched);
    const projSel = el('select', 'wf-task-flow-projsel') as HTMLSelectElement;
    projSel.title = '切换项目';
    const projEditBtn = el('button', 'wf-task-flow-projeditbtn', '✎');
    projEditBtn.title = '编辑项目（名称/颜色）';
    const search = el('input', 'wf-task-flow-search') as HTMLInputElement;
    search.placeholder = '搜索任务…';
    const btnNew = el('button', 'wf-task-flow-newbtn', '＋ 新建');
    topbar.append(viewGroup, projSel, projEditBtn, search, btnNew);

    const NEW_PROJECT_VALUE = '__new__';

    function renderProjectOptions(): void {
      projSel.innerHTML = '';
      const add = (value: string, label: string): void => {
        const o = el('option', '', label) as HTMLOptionElement;
        o.value = value;
        projSel.appendChild(o);
      };
      add('all', '全部项目');
      for (const p of state.projects) add(p.id, p.name);
      add(NEW_PROJECT_VALUE, '＋ 新建项目…');
      projSel.value = state.projectId;
      projEditBtn.style.display = state.projects.some((p) => p.id === state.projectId) ? '' : 'none';
    }

    projSel.addEventListener('change', () => {
      const v = projSel.value;
      if (v === NEW_PROJECT_VALUE) {
        startProjectEdit();
        return;
      }
      state.projectId = v;
      ctx.setConfig({ projectId: v });
      renderProjectOptions();
      renderContent();
    });

    projEditBtn.addEventListener('click', () => {
      const p = state.projects.find((x) => x.id === state.projectId);
      if (p) startProjectEdit(p);
    });

    /** 把项目下拉换成内联编辑器：名称 + 颜色点，回车保存，Esc/blur 还原 */
    function startProjectEdit(existing?: Project): void {
      const wrap = el('div', 'wf-task-flow-projedit');
      const input = el('input', 'wf-task-flow-projinput') as HTMLInputElement;
      input.placeholder = existing ? '项目名称，回车保存' : '新项目名称，回车创建';
      input.value = existing?.name ?? '';
      let color = existing?.color ?? PROJECT_PALETTE[state.projects.length % PROJECT_PALETTE.length];
      const dots = el('div', 'wf-task-flow-colordots');
      const dotEls: HTMLButtonElement[] = [];
      for (const c of PROJECT_PALETTE) {
        const d = el('button', 'wf-task-flow-colordot') as HTMLButtonElement;
        d.style.background = c;
        d.style.color = c;
        d.title = c;
        if (c === color) d.classList.add('active');
        // mousedown 阻止默认行为，避免点色点时 input 失焦触发 blur 还原
        d.addEventListener('mousedown', (e) => e.preventDefault());
        d.addEventListener('click', () => {
          color = c;
          for (const x of dotEls) x.classList.toggle('active', x === d);
        });
        dotEls.push(d);
        dots.appendChild(d);
      }
      wrap.append(input, dots);
      projSel.replaceWith(wrap);
      projEditBtn.style.display = 'none';
      input.focus();
      input.select();
      let done = false;
      const restore = (): void => {
        if (done) return;
        done = true;
        wrap.replaceWith(projSel);
        renderProjectOptions();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          restore();
          return;
        }
        if (e.key !== 'Enter') return;
        const name = input.value.trim();
        if (!name) {
          restore();
          return;
        }
        done = true;
        const nowTs = Date.now();
        const p: Project = existing
          ? { ...existing, name, color, updatedAt: nowTs }
          : {
              id: `p${nowTs.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name,
              color,
              createdAt: nowTs,
              updatedAt: nowTs,
            };
        void ctx.api.saveProject(p).then((projects) => {
          state.projects = projects;
          state.projectId = p.id;
          ctx.setConfig({ projectId: p.id });
          wrap.replaceWith(projSel);
          renderProjectOptions();
          renderContent();
        });
      });
      input.addEventListener('blur', restore);
    }

    function syncViewButtons(): void {
      btnBoard.classList.toggle('active', state.view === 'board');
      btnCal.classList.toggle('active', state.view === 'calendar');
      btnToday.classList.toggle('active', state.view === 'today');
      btnSched.classList.toggle('active', state.view === 'schedule');
    }

    function setView(v: ViewMode): void {
      state.view = v;
      ctx.setConfig({ view: v });
      syncViewButtons();
      renderContent();
    }

    btnBoard.addEventListener('click', () => setView('board'));
    btnCal.addEventListener('click', () => setView('calendar'));
    btnToday.addEventListener('click', () => setView('today'));
    btnSched.addEventListener('click', () => setView('schedule'));
    search.addEventListener('input', () => {
      state.query = search.value.trim().toLowerCase();
      renderContent();
    });
    btnNew.addEventListener('click', () => openDetail(null));
    syncViewButtons();

    /* ---------- board ---------- */

    function renderBoard(container: HTMLElement): void {
      const board = el('div', 'wf-task-flow-board');
      const tasks = filtered();

      for (const col of COLUMNS) {
        // 列内排序：优先级 urgent→low，同优先级按 updatedAt 越近越靠前
        // 子任务不占独立卡片，挂在主任务卡片下方，不参与列排序
        const colTasks = tasks
          .filter((t) => t.status === col.id && !t.parentId)
          .sort(
            (a, b) =>
              PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.updatedAt - a.updatedAt,
          );
        const colEl = el('div', 'wf-task-flow-col');
        colEl.dataset.status = col.id;

        const head = el('div', 'wf-task-flow-colhead');
        head.append(el('span', '', col.label), el('span', 'wf-task-flow-colcount', String(colTasks.length)));
        colEl.appendChild(head);

        const cards = el('div', 'wf-task-flow-cards');
        for (const t of colTasks) cards.appendChild(renderCard(t));
        colEl.appendChild(cards);

        const quick = el('input', 'wf-task-flow-quick') as HTMLInputElement;
        quick.placeholder = '＋ 输入标题，回车创建';
        quick.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const title = quick.value.trim();
          if (!title) return;
          quick.value = '';
          const t = blankTask(col.id);
          t.title = title;
          t.projectId = activeProjectId();
          void persist(t);
        });
        colEl.appendChild(quick);

        // drop target
        colEl.addEventListener('dragover', (e) => {
          e.preventDefault();
          colEl.classList.add('dragover');
        });
        colEl.addEventListener('dragleave', () => colEl.classList.remove('dragover'));
        colEl.addEventListener('drop', (e) => {
          e.preventDefault();
          colEl.classList.remove('dragover');
          const id = e.dataTransfer?.getData('text/plain');
          const t = state.tasks.find((x) => x.id === id);
          if (t && t.status !== col.id) {
            t.status = col.id;
            if (col.id === 'done') t.completedAt = new Date().toISOString();
            void persist(t);
          }
        });

        board.appendChild(colEl);
      }
      container.appendChild(board);
    }

    function renderCard(t: Task): HTMLElement {
      const card = el('div', `wf-task-flow-card${t.status === 'done' ? ' done' : ''}`);
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', t.id);
        e.dataTransfer?.setDragImage(card, 20, 20);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));

      const dot = el('span', 'wf-task-flow-dot');
      dot.style.background = PRIORITY_COLOR[t.priority];
      dot.style.color = PRIORITY_COLOR[t.priority];
      dot.title = `优先级：${PRIORITY_LABEL[t.priority]}（点击切换）`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = PRIORITY_ORDER.indexOf(t.priority);
        t.priority = PRIORITY_ORDER[(i + 1) % PRIORITY_ORDER.length];
        void persist(t);
      });

      const main = el('div', 'wf-task-flow-cardmain');
      const titleRow = el('div', 'wf-task-flow-cardtitlerow');
      const title = el('div', 'wf-task-flow-cardtitle', t.title);
      title.title = '点击编辑标题';
      title.addEventListener('click', (e) => {
        e.stopPropagation();
        startTitleEdit(t, title);
      });
      titleRow.appendChild(title);
      if (t.recurrence && t.recurrence !== 'none') {
        const rec = el('span', 'wf-task-flow-recur', '↻');
        rec.title = `重复：${RECURRENCE_LABEL[t.recurrence]}`;
        titleRow.appendChild(rec);
      }
      main.appendChild(titleRow);

      if (t.startDate) {
        main.appendChild(el('div', 'wf-task-flow-carddue', `▶ ${fmtWhen(t.startDate)}`));
      }
      if (t.dueDate) {
        const cls = isOverdue(t) ? ' overdue' : isDueToday(t) ? ' today' : '';
        const due = el('div', `wf-task-flow-carddue${cls}`, `⏳ ${fmtWhen(t.dueDate)}`);
        main.appendChild(due);
      }
      if (t.sessionId) {
        main.appendChild(el('div', 'wf-task-flow-carddue', '⚡ 已关联 Session'));
      }
      const pid = taskProject(t);
      const projColor = projectColorOf(pid);
      const projTag = el('span', 'wf-task-flow-cardproj');
      const projDot = el('span', 'wf-task-flow-cardproj-dot');
      projDot.style.background = projColor;
      projDot.style.color = projColor;
      projTag.append(projDot, document.createTextNode(projectName(pid)));
      main.appendChild(projTag);

      // 子任务：进度 + 缩进列表（仅主任务；子任务点击打开自己的编辑面板）
      if (!t.parentId) {
        const subs = state.tasks.filter((x) => x.parentId === t.id);
        if (subs.length > 0) {
          const doneN = subs.filter((x) => x.status === 'done' || x.status === 'canceled').length;
          main.appendChild(el('div', 'wf-task-flow-subprog', `↳ 子任务 ${doneN}/${subs.length}`));
          const subList = el('div', 'wf-task-flow-sublist');
          for (const s of subs) {
            const row = el('div', `wf-task-flow-sub${s.status === 'done' ? ' done' : ''}`);
            const sdot = el('span', 'wf-task-flow-subdot');
            sdot.style.background = s.status === 'done' ? 'var(--green)' : PRIORITY_COLOR[s.priority];
            sdot.style.color = sdot.style.background;
            row.append(sdot, el('span', 'wf-task-flow-subtitle', s.title));
            row.addEventListener('click', (e) => {
              e.stopPropagation();
              openDetail(s.id);
            });
            subList.appendChild(row);
          }
          main.appendChild(subList);
        }
      }

      card.append(dot, main);

      // 右下角播放按钮：直接启动 Session（已关联则打开）
      const play = el('button', 'wf-task-flow-play', '▶') as HTMLButtonElement;
      play.title = t.sessionId ? '打开 Session' : '启动 Session';
      play.draggable = false;
      // 不触发卡片拖拽/点击打开详情
      play.addEventListener('mousedown', (e) => e.stopPropagation());
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (t.sessionId) {
          void ctx.api.openSessionInChat(t.sessionId);
          return;
        }
        play.disabled = true;
        launchTaskSession(t).catch(() => {
          play.disabled = false;
        });
      });
      card.appendChild(play);

      card.addEventListener('click', () => openDetail(t.id));
      return card;
    }

    function startTitleEdit(t: Task, titleEl: HTMLElement): void {
      const input = el('input', 'wf-task-flow-titleedit') as HTMLInputElement;
      input.value = t.title;
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const commit = (): void => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v && v !== t.title) {
          t.title = v;
          void persist(t);
        } else {
          renderContent();
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          done = true;
          renderContent();
        }
        e.stopPropagation();
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (e) => e.stopPropagation());
    }

    /* ---------- calendar ---------- */

    function renderCalendar(container: HTMLElement): void {
      const cal = el('div', 'wf-task-flow-cal');

      const head = el('div', 'wf-task-flow-calhead');
      const prev = el('button', 'wf-task-flow-calnav', '‹');
      const next = el('button', 'wf-task-flow-calnav', '›');
      const title = el('span', 'wf-task-flow-caltitle', `${state.calYear} 年 ${state.calMonth + 1} 月`);
      const todayBtn = el('button', 'wf-task-flow-btn', '今天');
      head.append(prev, title, next, todayBtn);
      cal.appendChild(head);

      prev.addEventListener('click', () => shiftMonth(-1));
      next.addEventListener('click', () => shiftMonth(1));
      todayBtn.addEventListener('click', () => {
        const d = new Date();
        state.calYear = d.getFullYear();
        state.calMonth = d.getMonth();
        renderContent();
      });

      const wd = el('div', 'wf-task-flow-calgrid weekdays');
      for (const w of WEEKDAYS) wd.appendChild(el('div', 'wf-task-flow-calwd', w));
      cal.appendChild(wd);

      const grid = el('div', 'wf-task-flow-calgrid');
      const { calYear: y, calMonth: m } = state;
      const first = new Date(y, m, 1);
      const offset = (first.getDay() + 6) % 7; // Monday-first
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const daysInPrev = new Date(y, m, 0).getDate();
      const tstr = todayStr();

      const byDate = new Map<string, Task[]>();
      for (const t of filtered()) {
        if (!t.dueDate) continue;
        const key = dateKey(t.dueDate);
        const list = byDate.get(key) ?? [];
        list.push(t);
        byDate.set(key, list);
      }

      const totalCells = Math.ceil((offset + daysInMonth) / 7) * 7;
      for (let i = 0; i < totalCells; i++) {
        const dayNum = i - offset + 1;
        let cellDate: Date;
        let out = false;
        if (dayNum < 1) {
          cellDate = new Date(y, m - 1, daysInPrev + dayNum);
          out = true;
        } else if (dayNum > daysInMonth) {
          cellDate = new Date(y, m + 1, dayNum - daysInMonth);
          out = true;
        } else {
          cellDate = new Date(y, m, dayNum);
        }
        const ds = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(cellDate.getDate()).padStart(2, '0')}`;
        const cell = el('div', `wf-task-flow-cell${out ? ' out' : ''}${ds === tstr ? ' today' : ''}`);
        cell.appendChild(el('div', 'wf-task-flow-daynum', String(cellDate.getDate())));
        for (const t of byDate.get(ds) ?? []) {
          const label = t.dueDate && hasClock(t.dueDate) ? `${clockOf(t.dueDate)} ${t.title}` : t.title;
          const chip = el(
            'div',
            `wf-task-flow-chip${t.status === 'done' ? ' done' : ''}${isOverdue(t) ? ' overdue' : ''}`,
            label,
          );
          chip.title = label;
          chip.addEventListener('click', () => openDetail(t.id));
          cell.appendChild(chip);
        }
        grid.appendChild(cell);
      }
      cal.appendChild(grid);
      container.appendChild(cal);
    }

    function shiftMonth(delta: number): void {
      const d = new Date(state.calYear, state.calMonth + delta, 1);
      state.calYear = d.getFullYear();
      state.calMonth = d.getMonth();
      renderContent();
    }

    /* ---------- pomodoro ---------- */

    /** 番茄钟记录缓存（30 秒），今日统计用 */
    let pomoCache: { at: number; sessions: PomodoroSession[] } | null = null;

    async function pomoSessions(): Promise<PomodoroSession[]> {
      if (pomoCache && Date.now() - pomoCache.at < 30_000) return pomoCache.sessions;
      try {
        const sessions = await window.kimi.pomodoroList();
        pomoCache = { at: Date.now(), sessions };
        return sessions;
      } catch {
        return pomoCache?.sessions ?? [];
      }
    }

    /** 进行中番茄钟的剩余时间 mm:ss（本地按 startedAt + durationMin 推算） */
    function pomoRemain(): string {
      const p = state.pomo;
      if (!p.active || !p.startedAt || !p.durationMin) return '';
      const ms = p.startedAt + p.durationMin * 60_000 - Date.now();
      const s = Math.max(0, Math.round(ms / 1000));
      return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
    }

    // 每秒刷新今日视图里的倒计时（元素带 data-wf-pomo-remain 标记）；顺带检测跨天
    let renderedDayKey = dateKeyOf(new Date());
    const pomoTick = window.setInterval(() => {
      if (!body.isConnected) {
        window.clearInterval(pomoTick);
        return;
      }
      // 过午夜后重拉数据：今日/日程视图按当前日期归格
      const dk = dateKeyOf(new Date());
      if (dk !== renderedDayKey) {
        renderedDayKey = dk;
        void reload();
        return;
      }
      if (!state.pomo.active) return;
      const text = pomoRemain();
      content.querySelectorAll('[data-wf-pomo-remain]').forEach((n) => {
        n.textContent = text;
      });
    }, 1000);

    window.kimi.onPomodoroState((p) => {
      state.pomo = p;
      pomoCache = null; // 开始/停止后立即让今日统计重拉
      if (body.isConnected && state.view === 'today') renderContent();
    });
    void window.kimi.pomodoroState().then((p) => {
      state.pomo = p;
      if (body.isConnected && state.view === 'today') renderContent();
    });

    /* ---------- today ---------- */

    /** 任务自身是否命中今日条件：今天截止 / 今天排期 / 进行中 / 今天开始 */
    function meetsToday(t: Task): boolean {
      const tk = todayStr();
      return (
        (!!t.dueDate && dateKey(t.dueDate) === tk) ||
        (!!t.scheduledStart && dateKey(t.scheduledStart) === tk) ||
        t.status === 'in_progress' ||
        (!!t.startDate && dateKey(t.startDate) === tk)
      );
    }

    /** 今日/过期列表的分层结构：顶层项 + 其子任务 */
    interface TodayGroup {
      task: Task;
      subs: Task[];
    }

    /**
     * 今日待办（分层）：命中今日条件的任务 + 其父任务命中今日条件的子任务。
     * 今天完成的（completedAt 是今天）保留展示；排序规则见 groupSubs
     */
    function todayGroups(): TodayGroup[] {
      const tk = todayStr();
      const all = filtered();
      const parentMeets = new Set<string>();
      for (const t of all) {
        // 父任务命中今日条件即纳入（done 的父任务 in_progress 为 false，但日期条件仍可能命中）
        if (!t.parentId && meetsToday(t)) parentMeets.add(t.id);
      }
      const listed = all.filter((t) => {
        if (t.status === 'canceled') return false;
        const relevant = meetsToday(t) || (!!t.parentId && parentMeets.has(t.parentId));
        if (!relevant) return false;
        // 已完成的只在今天完成的才保留展示
        if (t.status === 'done') return !!t.completedAt && dateKey(t.completedAt) === tk;
        return true;
      });
      return groupSubs(listed);
    }

    /**
     * 分层分组：父任务在 listed 里的子任务挂进父的 subs，否则作顶层项（孤儿子任务）。
     * 排序按组：未完成在前 done 置底、优先级、updatedAt；组内子任务按优先级排
     */
    function groupSubs(listed: Task[]): TodayGroup[] {
      const listedIds = new Set(listed.map((t) => t.id));
      const byPrio = (a: Task, b: Task): number =>
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.updatedAt - a.updatedAt;

      const groups: TodayGroup[] = [];
      const groupOf = new Map<string, TodayGroup>();
      for (const t of listed) {
        if (t.parentId && listedIds.has(t.parentId)) continue; // 父在列表 → 作为子项
        const g: TodayGroup = { task: t, subs: [] };
        groups.push(g);
        groupOf.set(t.id, g);
      }
      for (const t of listed) {
        if (t.parentId && listedIds.has(t.parentId)) groupOf.get(t.parentId)!.subs.push(t);
      }
      for (const g of groups) g.subs.sort(byPrio);
      return groups.sort(
        (a, b) => Number(a.task.status === 'done') - Number(b.task.status === 'done') || byPrio(a.task, b.task),
      );
    }

    /**
     * 已过期（分层）：未完成 且（截止/排期在今天之前），且不在今日活跃列表里。
     * 子任务跟随父任务嵌套；子任务自身过期而父不过期时作顶层孤儿行
     */
    function overdueGroups(): TodayGroup[] {
      const tk = todayStr();
      const inToday = new Set<string>();
      for (const g of todayGroups()) {
        inToday.add(g.task.id);
        for (const s of g.subs) inToday.add(s.id);
      }
      const isOverdueItem = (t: Task): boolean =>
        (!!t.dueDate && dateKey(t.dueDate) < tk) || (!!t.scheduledStart && dateKey(t.scheduledStart) < tk);
      const all = filtered();
      const parentOverdue = new Set<string>();
      for (const t of all) {
        if (!t.parentId && t.status !== 'done' && t.status !== 'canceled' && isOverdueItem(t)) parentOverdue.add(t.id);
      }
      const listed = all.filter((t) => {
        if (t.status === 'done' || t.status === 'canceled') return false;
        if (inToday.has(t.id)) return false; // 避免与今日列表重复
        return isOverdueItem(t) || (!!t.parentId && parentOverdue.has(t.parentId));
      });
      return groupSubs(listed);
    }

    function renderToday(container: HTMLElement): void {
      const wrap = el('div', 'wf-task-flow-today');

      const groups = todayGroups();
      const total = groups.reduce((n, g) => n + 1 + g.subs.length, 0);
      const head = el('div', 'wf-task-flow-todayhead');
      head.appendChild(el('span', 'wf-task-flow-todaytitle', `今日 · ${total}`));
      const pin = el('button', 'wf-task-flow-btn wf-task-flow-pinbtn', '📌 钉到桌面');
      pin.title = '在桌面显示今日待办面板';
      pin.addEventListener('click', () => window.kimi.toggleTodoPanel());
      head.appendChild(pin);
      wrap.appendChild(head);

      // 番茄钟进行中：顶部专注条（关联任务不在列表里也显示）
      if (state.pomo.active) {
        const bar = el('div', 'wf-task-flow-focusbar');
        bar.appendChild(el('span', '', `正在专注：${state.pomo.taskTitle ?? ''}`));
        const remain = el('span', 'wf-task-flow-pomoreman', pomoRemain());
        remain.setAttribute('data-wf-pomo-remain', '');
        bar.appendChild(remain);
        wrap.appendChild(bar);
      }

      const list = el('div', 'wf-task-flow-todaylist');
      if (groups.length === 0) {
        list.appendChild(el('div', 'wf-task-flow-todaynone', '今天没有待办任务'));
      }
      for (const g of groups) {
        list.appendChild(renderTodayRow(g.task));
        for (const s of g.subs) list.appendChild(renderTodayRow(s, true));
      }
      wrap.appendChild(list);

      // 已过期折叠区：默认收起，展开状态持久化到 ctx.config.overdueOpen
      const overdue = overdueGroups();
      if (overdue.length > 0) {
        const overdueTotal = overdue.reduce((n, g) => n + 1 + g.subs.length, 0);
        const open = ctx.config.overdueOpen === true;
        const sec = el('div', 'wf-task-flow-overdue');
        const ohead = el('button', 'wf-task-flow-overduehead', `${open ? '▾' : '▸'} 已过期 · ${overdueTotal}`);
        ohead.addEventListener('click', () => {
          ctx.setConfig({ overdueOpen: !open });
          renderContent();
        });
        sec.appendChild(ohead);
        if (open) {
          const olist = el('div', 'wf-task-flow-overduelist');
          for (const g of overdue) {
            olist.appendChild(renderOverdueRow(g.task));
            for (const s of g.subs) olist.appendChild(renderOverdueRow(s, true));
          }
          sec.appendChild(olist);
        }
        wrap.appendChild(sec);
      }

      // 今日统计：按任务聚合今天的番茄钟记录
      const stats = el('div', 'wf-task-flow-todaystats');
      stats.appendChild(el('div', 'wf-task-flow-subsec-title', '今日统计'));
      wrap.appendChild(stats);
      void renderTodayStats(stats);

      container.appendChild(wrap);
    }

    /** isSub = 作为父任务行下方的缩进子项渲染（孤儿子任务作顶层项时 isSub=false，保留 ↳ 父任务名标注） */
    function renderTodayRow(t: Task, isSub = false): HTMLElement {
      const isDone = t.status === 'done';
      const row = el('div', `wf-task-flow-todayrow${isDone ? ' done' : ''}${isSub ? ' sub' : ''}`);

      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = isDone;
      cb.title = isDone ? '取消完成' : '完成';
      cb.addEventListener('change', () => {
        t.status = cb.checked ? 'done' : 'todo';
        t.completedAt = cb.checked ? new Date().toISOString() : undefined;
        void persist(t);
      });
      row.appendChild(cb);

      const dot = el('span', 'wf-task-flow-todot');
      dot.style.background = PRIORITY_COLOR[t.priority];
      dot.style.color = PRIORITY_COLOR[t.priority];
      dot.title = `优先级：${PRIORITY_LABEL[t.priority]}`;
      row.appendChild(dot);

      const title = el('span', 'wf-task-flow-todotitle', t.title);
      title.title = t.title;
      title.addEventListener('click', () => openDetail(t.id));
      row.appendChild(title);

      if (t.parentId && !isSub) {
        const parent = state.tasks.find((x) => x.id === t.parentId);
        if (parent) row.appendChild(el('span', 'wf-task-flow-todoparent', `↳ ${parent.title}`));
      }

      const isTiming = state.pomo.active && state.pomo.taskId === t.id;
      if (isTiming) {
        const remain = el('span', 'wf-task-flow-pomoreman', pomoRemain());
        remain.setAttribute('data-wf-pomo-remain', '');
        row.appendChild(remain);
      } else {
        // 排期时间显示时间段（10:00–11:00）；🕐 与番茄钟按钮的 ⏰ 区分
        const when = t.scheduledStart
          ? `🕐 ${clockOf(t.scheduledStart)}${t.scheduledEnd ? `–${clockOf(t.scheduledEnd)}` : ''}`
          : t.dueDate
            ? `⏳ ${fmtWhen(t.dueDate)}`
            : '';
        if (when) {
          row.appendChild(el('span', `wf-task-flow-todotime${t.dueDate && isOverdue(t) ? ' overdue' : ''}`, when));
        }
      }

      // hover 操作按钮：⏰ 番茄钟 + ▶ 启动 Session（done 的行不显示；计时中的 ⏹ 常显）
      if (!isDone) {
        const acts = el('div', `wf-task-flow-todoacts${isTiming ? ' timing' : ''}`);
        const pb = el(
          'button',
          `wf-task-flow-pomo${isTiming ? ' timing' : ''}`,
          isTiming ? '⏹' : '⏰',
        ) as HTMLButtonElement;
        pb.title = isTiming ? '停止番茄钟' : '开始番茄钟';
        pb.addEventListener('click', (e) => {
          e.stopPropagation();
          pb.disabled = true;
          const reenable = (): void => {
            pb.disabled = false;
          };
          // 状态经 onPomodoroState 推送回来后 renderContent，这里只管启动/停止
          if (isTiming) void window.kimi.pomodoroStop(false).catch(reenable);
          else void window.kimi.pomodoroStart(t.id).catch(reenable);
        });
        acts.appendChild(pb);

        // ▶ 启动 Session：与看板卡片一致——已关联则打开，否则 launchTaskSession（子任务会注入父任务上下文）
        const sb = el('button', 'wf-task-flow-pomo wf-task-flow-sessionbtn', '▶') as HTMLButtonElement;
        sb.title = t.sessionId ? '打开 Session' : '启动 Session';
        sb.addEventListener('click', (e) => {
          e.stopPropagation();
          if (t.sessionId) {
            void ctx.api.openSessionInChat(t.sessionId);
            return;
          }
          sb.disabled = true;
          launchTaskSession(t).catch(() => {
            sb.disabled = false;
          });
        });
        acts.appendChild(sb);
        row.appendChild(acts);
      }
      return row;
    }

    async function renderTodayStats(box: HTMLElement): Promise<void> {
      const sessions = await pomoSessions();
      if (!box.isConnected) return;
      const tk = todayStr();
      const byTask = new Map<string, { n: number; min: number }>();
      for (const s of sessions) {
        if (dateKey(new Date(s.startedAt).toISOString()) !== tk) continue;
        const agg = byTask.get(s.taskId) ?? { n: 0, min: 0 };
        agg.n += 1;
        agg.min += s.minutes;
        byTask.set(s.taskId, agg);
      }
      let totalN = 0;
      let totalMin = 0;
      for (const [taskId, agg] of byTask) {
        const name = state.tasks.find((t) => t.id === taskId)?.title ?? '（已删除任务）';
        box.appendChild(el('div', '', `${name}：${agg.n} 个番茄 · ${agg.min} 分钟`));
        totalN += agg.n;
        totalMin += agg.min;
      }
      box.appendChild(el('div', 'total', `总计：${totalN} 个番茄 · ${totalMin} 分钟`));
    }

    /** 过期行：复用今日行的全部交互，加 overdue 类 + 标题前的过期日期小字 */
    function renderOverdueRow(t: Task, isSub = false): HTMLElement {
      const row = renderTodayRow(t, isSub);
      row.classList.add('overdue');
      const when = t.dueDate ?? t.scheduledStart;
      if (when) {
        const tag = el('span', 'wf-task-flow-overduedate', `${fmtWhen(when)} ·`);
        row.querySelector('.wf-task-flow-todotitle')?.before(tag);
      }
      return row;
    }

    /* ---------- schedule (week grid) ---------- */

    /** 当前周（含 weekOffset 偏移）的周一 00:00 */
    function weekMonday(): Date {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + state.weekOffset * 7);
      return d;
    }

    /** 分钟数对齐 30 分钟，并夹在网格范围内 */
    function snap30(mins: number): number {
      const snapped = Math.round(mins / 30) * 30;
      return Math.min(Math.max(0, snapped), SCHED_HOURS * 60 - 30);
    }

    /** 拖拽中的任务 id（dragover 里拿不到 dataTransfer 数据，用模块变量传递） */
    let schedDragId: string | null = null;

    function renderSchedule(container: HTMLElement): void {
      const wrap = el('div', 'wf-task-flow-sched');

      const monday = weekMonday();
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);

      const head = el('div', 'wf-task-flow-calhead');
      const prev = el('button', 'wf-task-flow-calnav', '‹');
      const next = el('button', 'wf-task-flow-calnav', '›');
      const title = el(
        'span',
        'wf-task-flow-caltitle',
        `${monday.getMonth() + 1}/${monday.getDate()} – ${sunday.getMonth() + 1}/${sunday.getDate()}`,
      );
      const weekBtn = el('button', 'wf-task-flow-btn', '本周');
      head.append(prev, title, next, weekBtn);
      wrap.appendChild(head);
      prev.addEventListener('click', () => {
        state.weekOffset -= 1;
        renderContent();
      });
      next.addEventListener('click', () => {
        state.weekOffset += 1;
        renderContent();
      });
      weekBtn.addEventListener('click', () => {
        state.weekOffset = 0;
        renderContent();
      });

      const bodyRow = el('div', 'wf-task-flow-schedbody');

      // 未排期区：当前项目下未完成且无 scheduledStart 的主任务，可拖入网格
      const side = el('div', 'wf-task-flow-schedside');
      side.appendChild(el('div', 'wf-task-flow-schedside-title', '未排期（拖入网格）'));
      const unsched = filtered()
        .filter((t) => !t.parentId && !t.scheduledStart && t.status !== 'done' && t.status !== 'canceled')
        .sort(
          (a, b) =>
            PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || b.updatedAt - a.updatedAt,
        );
      if (unsched.length === 0) side.appendChild(el('div', 'wf-task-flow-todaynone', '都排好了'));
      for (const t of unsched) {
        const chip = el('div', 'wf-task-flow-unsched', t.title);
        chip.draggable = true;
        chip.title = t.title;
        chip.style.borderLeftColor = PRIORITY_COLOR[t.priority];
        chip.addEventListener('dragstart', (e) => {
          schedDragId = t.id;
          e.dataTransfer?.setData('text/plain', t.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => {
          schedDragId = null;
        });
        chip.addEventListener('click', () => openDetail(t.id));
        side.appendChild(chip);
      }
      bodyRow.appendChild(side);

      // 周网格：表头（周一~周日）+ 时间刻度列 + 7 个日期列
      const scroll = el('div', 'wf-task-flow-schedscroll');
      const grid = el('div', 'wf-task-flow-schedgrid');
      const tstr = todayStr();

      grid.appendChild(el('div', 'wf-task-flow-schedday', ''));
      const days: Date[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(d.getDate() + i);
        days.push(d);
        const ds = dateKeyOf(d);
        grid.appendChild(
          el('div', `wf-task-flow-schedday${ds === tstr ? ' today' : ''}`, `周${WEEKDAYS[i]} ${d.getMonth() + 1}/${d.getDate()}`),
        );
      }

      const times = el('div', 'wf-task-flow-schedtimes');
      times.style.height = `${SCHED_HOURS * SCHED_HOUR_H}px`;
      for (let h = 0; h <= SCHED_HOURS; h++) {
        const lab = el('div', 'wf-task-flow-schedtime', `${pad2(SCHED_START_HOUR + h)}:00`);
        lab.style.top = `${h * SCHED_HOUR_H}px`;
        times.appendChild(lab);
      }
      grid.appendChild(times);

      const scheduled = filtered().filter((t) => !!t.scheduledStart);
      for (let i = 0; i < 7; i++) {
        const ds = dateKeyOf(days[i]);
        const col = el('div', `wf-task-flow-schedcol${ds === tstr ? ' today' : ''}`);
        col.style.height = `${SCHED_HOURS * SCHED_HOUR_H}px`;
        for (const t of scheduled) {
          if (dateKey(t.scheduledStart!) !== ds) continue;
          col.appendChild(renderSchedBlock(t));
        }
        setupSchedDrop(col, days[i]);
        grid.appendChild(col);
      }

      scroll.appendChild(grid);
      bodyRow.appendChild(scroll);
      wrap.appendChild(bodyRow);
      container.appendChild(wrap);
    }

    function renderSchedBlock(t: Task): HTMLElement {
      const start = new Date(t.scheduledStart!);
      const end = t.scheduledEnd ? new Date(t.scheduledEnd) : new Date(start.getTime() + 3_600_000);
      const startMin = (start.getHours() - SCHED_START_HOUR) * 60 + start.getMinutes();
      const durMin = Math.max(30, Math.round((end.getTime() - start.getTime()) / 60_000));

      const block = el('div', `wf-task-flow-schedblock${t.status === 'done' ? ' done' : ''}`);
      block.style.top = `${(startMin / 60) * SCHED_HOUR_H}px`;
      block.style.height = `${(durMin / 60) * SCHED_HOUR_H - 2}px`;
      block.style.borderLeftColor = PRIORITY_COLOR[t.priority];
      block.draggable = true;
      block.title = t.title;
      block.appendChild(
        el('div', 't', `${pad2(start.getHours())}:${pad2(start.getMinutes())}–${pad2(end.getHours())}:${pad2(end.getMinutes())}`),
      );
      block.appendChild(el('div', '', t.title));

      block.addEventListener('dragstart', (e) => {
        schedDragId = t.id;
        e.dataTransfer?.setData('text/plain', t.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        block.classList.add('dragging');
      });
      block.addEventListener('dragend', () => {
        schedDragId = null;
        block.classList.remove('dragging');
      });
      block.addEventListener('click', () => openDetail(t.id));

      // 底部 resize 把手：拖动改时长（对齐 30 分钟，最短 30 分钟）
      const rz = el('div', 'wf-task-flow-schedresize');
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 阻止触发色块拖拽
        e.stopPropagation();
        startSchedResize(t, block);
      });
      rz.addEventListener('click', (e) => e.stopPropagation());
      block.appendChild(rz);
      return block;
    }

    /** 日期列的 drop target：放下即按 30 分钟对齐排期，幽灵块预览落点 */
    function setupSchedDrop(col: HTMLElement, day: Date): void {
      let ghost: HTMLElement | null = null;
      const clearGhost = (): void => {
        ghost?.remove();
        ghost = null;
        col.classList.remove('dragover');
      };
      /** 被拖任务的时长（未排期的默认 1 小时） */
      const dragDurMin = (): number => {
        const t = schedDragId ? state.tasks.find((x) => x.id === schedDragId) : undefined;
        if (!t?.scheduledStart) return 60;
        const s0 = new Date(t.scheduledStart).getTime();
        const e0 = t.scheduledEnd ? new Date(t.scheduledEnd).getTime() : s0 + 3_600_000;
        return Math.max(30, Math.round((e0 - s0) / 60_000));
      };
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        col.classList.add('dragover');
        const y = e.clientY - col.getBoundingClientRect().top;
        const mins = snap30((y / SCHED_HOUR_H) * 60);
        if (!ghost) {
          ghost = el('div', 'wf-task-flow-schedghost');
          col.appendChild(ghost);
        }
        ghost.style.top = `${(mins / 60) * SCHED_HOUR_H}px`;
        ghost.style.height = `${(dragDurMin() / 60) * SCHED_HOUR_H - 2}px`;
      });
      col.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && col.contains(e.relatedTarget as Node)) return;
        clearGhost();
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        const y = e.clientY - col.getBoundingClientRect().top;
        const mins = snap30((y / SCHED_HOUR_H) * 60);
        clearGhost();
        const id = e.dataTransfer?.getData('text/plain');
        const t = state.tasks.find((x) => x.id === id);
        if (!t) return;
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        start.setMinutes(SCHED_START_HOUR * 60 + mins);
        t.scheduledStart = start.toISOString();
        t.scheduledEnd = new Date(start.getTime() + dragDurMin() * 60_000).toISOString();
        void persist(t);
      });
    }

    /** resize 把手拖动：实时预览高度，松手按 30 分钟对齐落盘 */
    function startSchedResize(t: Task, block: HTMLElement): void {
      const start = new Date(t.scheduledStart!);
      const startMin = (start.getHours() - SCHED_START_HOUR) * 60 + start.getMinutes();
      const col = block.parentElement;
      if (!col) return;
      const durAt = (clientY: number): number => {
        const y = clientY - col.getBoundingClientRect().top;
        return Math.max(30, snap30((y / SCHED_HOUR_H) * 60) - startMin);
      };
      const onMove = (ev: MouseEvent): void => {
        block.style.height = `${(durAt(ev.clientY) / 60) * SCHED_HOUR_H - 2}px`;
      };
      const onUp = (ev: MouseEvent): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        t.scheduledEnd = new Date(start.getTime() + durAt(ev.clientY) * 60_000).toISOString();
        void persist(t);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    /* ---------- detail panel ---------- */

    /** 面板关闭前 flush 未落盘的自动保存（由 openDetail 挂载） */
    let flushPanelSave: (() => void) | null = null;

    function closeDetail(): void {
      const flush = flushPanelSave;
      flushPanelSave = null;
      flush?.();
      panelEl?.remove();
      panelEl = null;
    }

    /** taskId === null → 新建草稿（首次有标题的自动保存才真正创建） */
    function openDetail(taskId: string | null): void {
      closeDetail();
      const existing = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;
      if (taskId && !existing) return;
      const draft: Task = existing ? { ...existing, tags: [...existing.tags] } : blankTask('backlog');
      if (!existing) draft.projectId = activeProjectId();
      const isNew = !existing;

      const panel = el('div', 'wf-task-flow-panel');
      panelEl = panel;
      panel.addEventListener('click', (e) => e.stopPropagation());

      const head = el('div', 'wf-task-flow-panelhead');
      const headLabel = el('span', '', isNew ? '新建任务' : '任务详情');
      const savedHint = el('span', 'wf-task-flow-saved');
      if (!isNew) savedHint.textContent = `已保存 ${clockHMS(draft.updatedAt)}`;
      head.append(headLabel, savedHint);
      const close = el('button', 'wf-task-flow-panelclose', '✕');
      close.addEventListener('click', closeDetail);
      head.appendChild(close);
      panel.appendChild(head);

      const pbody = el('div', 'wf-task-flow-panelbody');

      const titleInput = el('input', 'wf-task-flow-ptitle') as HTMLInputElement;
      titleInput.value = draft.title;
      titleInput.placeholder = '任务标题';
      pbody.appendChild(titleInput);

      // status
      const statusSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const c of COLUMNS) {
        const o = el('option', '', c.label) as HTMLOptionElement;
        o.value = c.id;
        statusSel.appendChild(o);
      }
      statusSel.value = draft.status;
      pbody.appendChild(fieldRow('状态', statusSel));

      // priority
      const prioSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const p of PRIORITY_ORDER) {
        const o = el('option', '', PRIORITY_LABEL[p]) as HTMLOptionElement;
        o.value = p;
        prioSel.appendChild(o);
      }
      prioSel.value = draft.priority;
      pbody.appendChild(fieldRow('优先级', prioSel));

      // project
      const projFieldSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      // 默认项目可能不在 listProjects 返回里，补占位选项避免 value 落空串
      if (!state.projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
        const o = el('option', '', '默认') as HTMLOptionElement;
        o.value = DEFAULT_PROJECT_ID;
        projFieldSel.appendChild(o);
      }
      for (const p of state.projects) {
        const o = el('option', '', p.name) as HTMLOptionElement;
        o.value = p.id;
        projFieldSel.appendChild(o);
      }
      projFieldSel.value = draft.projectId ?? DEFAULT_PROJECT_ID;
      pbody.appendChild(fieldRow('项目', projFieldSel));

      // start time
      const startInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      startInput.type = 'datetime-local';
      startInput.value = toLocalInput(draft.startDate);
      pbody.appendChild(fieldRow('开始', startInput));

      // due time
      const dueInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      dueInput.type = 'datetime-local';
      dueInput.value = toLocalInput(draft.dueDate);
      pbody.appendChild(fieldRow('截止', dueInput));

      // scheduled time（计划执行；清空则回到未排期）
      const schStartInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      schStartInput.type = 'datetime-local';
      schStartInput.value = toLocalInput(draft.scheduledStart);
      pbody.appendChild(fieldRow('计划开始', schStartInput));

      const schEndInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      schEndInput.type = 'datetime-local';
      schEndInput.value = toLocalInput(draft.scheduledEnd);
      pbody.appendChild(fieldRow('计划结束', schEndInput));

      // recurrence
      const recurSel = el('select', 'wf-task-flow-select') as HTMLSelectElement;
      for (const r of RECURRENCE_ORDER) {
        const o = el('option', '', RECURRENCE_LABEL[r]) as HTMLOptionElement;
        o.value = r;
        recurSel.appendChild(o);
      }
      recurSel.value = draft.recurrence ?? 'none';
      pbody.appendChild(fieldRow('重复', recurSel));

      // tags
      const tagsInput = el('input', 'wf-task-flow-input') as HTMLInputElement;
      tagsInput.value = draft.tags.join(', ');
      tagsInput.placeholder = '逗号分隔';
      pbody.appendChild(fieldRow('标签', tagsInput));

      // description
      const desc = el('textarea', 'wf-task-flow-textarea') as HTMLTextAreaElement;
      desc.value = draft.description;
      desc.placeholder = '描述（Markdown 原文）…';
      pbody.appendChild(desc);

      panel.appendChild(pbody);

      const foot = el('div', 'wf-task-flow-panelfoot');
      panel.appendChild(foot);
      root.appendChild(panel);

      /* ----- 保存：自动（debounce 800ms）+ 显式按钮/⌘S ----- */
      /* 注意：这几个 let 必须先于 renderFoot() 调用声明，否则 TDZ 报错 */

      let saveTimer = 0;
      let dirty = false;
      let savedOnce = !isNew;

      renderFoot();
      titleInput.focus();

      // 子任务区块：仅已落库的主任务显示（子任务不可再嵌套）
      if (!isNew && !draft.parentId) {
        const subSec = el('div', 'wf-task-flow-subsec');
        pbody.appendChild(subSec);
        renderSubSec();
      }

      /** 子任务列表 + 新建输入；增删改后基于最新 state.tasks 重绘 */
      function renderSubSec(): void {
        const subSec = pbody.querySelector('.wf-task-flow-subsec');
        if (!subSec) return;
        subSec.innerHTML = '';
        subSec.appendChild(el('div', 'wf-task-flow-subsec-title', '子任务'));

        const subs = state.tasks.filter((x) => x.parentId === draft.id);
        for (const s of subs) {
          const row = el('div', 'wf-task-flow-subrow');
          const cb = el('input') as HTMLInputElement;
          cb.type = 'checkbox';
          cb.checked = s.status === 'done';
          cb.title = '完成';
          cb.addEventListener('change', () => {
            s.status = cb.checked ? 'done' : 'todo';
            s.completedAt = cb.checked ? new Date().toISOString() : undefined;
            void persist(s).then(renderSubSec);
          });
          const name = el('span', `wf-task-flow-subrow-title${s.status === 'done' ? ' done' : ''}`, s.title);
          name.title = s.title;
          name.addEventListener('click', () => openDetail(s.id));
          const del = el('button', 'wf-task-flow-subdel', '✕');
          del.title = '删除子任务';
          del.addEventListener('click', () => {
            void removeTask(s.id).then(renderSubSec);
          });
          row.append(cb, name, del);
          subSec.appendChild(row);
        }

        const addRow = el('div', 'wf-task-flow-subadd');
        const inp = el('input', 'wf-task-flow-input') as HTMLInputElement;
        inp.placeholder = '添加子任务，回车创建';
        const addBtn = el('button', 'wf-task-flow-btn', '添加');
        const create = (): void => {
          const title = inp.value.trim();
          if (!title) return;
          inp.value = '';
          const sub = blankTask('todo');
          sub.title = title;
          sub.parentId = draft.id;
          // 优先级/项目继承父任务（取面板当前值）
          sub.priority = prioSel.value as TaskPriority;
          sub.projectId = projFieldSel.value || DEFAULT_PROJECT_ID;
          void persist(sub).then(renderSubSec);
        };
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') create();
        });
        addBtn.addEventListener('click', create);
        addRow.append(inp, addBtn);
        subSec.appendChild(addRow);
      }

      // 所有字段改动后 debounce 800ms 自动保存
      titleInput.addEventListener('input', scheduleSave);
      desc.addEventListener('input', scheduleSave);
      tagsInput.addEventListener('input', scheduleSave);
      startInput.addEventListener('change', scheduleSave);
      dueInput.addEventListener('change', scheduleSave);
      schStartInput.addEventListener('change', scheduleSave);
      schEndInput.addEventListener('change', scheduleSave);
      statusSel.addEventListener('change', scheduleSave);
      prioSel.addEventListener('change', scheduleSave);
      recurSel.addEventListener('change', scheduleSave);
      projFieldSel.addEventListener('change', scheduleSave);

      // ⌘S / Ctrl+S 立即保存（事件从输入控件冒泡到面板）
      panel.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          void saveNow(true);
        }
      });

      function fieldRow(label: string, control: HTMLElement): HTMLElement {
        const row = el('div', 'wf-task-flow-field');
        row.append(el('label', '', label), control);
        return row;
      }

      function collect(): Task {
        draft.title = titleInput.value.trim() || draft.title || '未命名任务';
        draft.status = statusSel.value as TaskStatus;
        draft.priority = prioSel.value as TaskPriority;
        // 项目下拉无匹配选项时 value 会落空串，兜底回默认项目
        draft.projectId = projFieldSel.value || DEFAULT_PROJECT_ID;
        // datetime-local 值是本地时间 YYYY-MM-DDTHH:mm，存 ISO（UTC）
        draft.startDate = startInput.value ? new Date(startInput.value).toISOString() : undefined;
        draft.dueDate = dueInput.value ? new Date(dueInput.value).toISOString() : undefined;
        draft.scheduledStart = schStartInput.value ? new Date(schStartInput.value).toISOString() : undefined;
        draft.scheduledEnd = schEndInput.value ? new Date(schEndInput.value).toISOString() : undefined;
        draft.tags = tagsInput.value
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean);
        draft.description = desc.value;
        draft.recurrence = recurSel.value as TaskRecurrence;
        // 面板里标记完成时补 completedAt（与拖拽到 DONE 列的行为一致）
        if (draft.status === 'done' && !draft.completedAt) draft.completedAt = new Date().toISOString();
        return draft;
      }

      function scheduleSave(): void {
        dirty = true;
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          void saveNow();
        }, 800);
      }

      /**
       * 落盘当前草稿。force = 显式保存（按钮/⌘S）：跳过 dirty 检查，
       * 新任务无标题也按「未命名任务」入库
       */
      async function saveNow(force = false): Promise<void> {
        if (saveTimer) {
          window.clearTimeout(saveTimer);
          saveTimer = 0;
        }
        if (!force && !dirty) return;
        dirty = false;
        collect();
        // 自动保存时，新任务没有标题不入库
        if (!force && !savedOnce && !titleInput.value.trim()) return;
        savedHint.textContent = '保存中…';
        try {
          await persist(draft);
          savedHint.textContent = `已保存 ${clockHMS(Date.now())}`;
          if (!savedOnce) {
            savedOnce = true;
            headLabel.textContent = '任务详情';
            renderFoot();
          }
        } catch {
          savedHint.textContent = '保存失败';
        }
      }

      /** 关闭面板时立即落盘未保存的改动 */
      flushPanelSave = () => {
        flushPanelSave = null;
        if (saveTimer || dirty) void saveNow();
      };

      function renderFoot(): void {
        foot.innerHTML = '';
        const save = el('button', 'wf-task-flow-btn primary', '保存');
        save.title = '立即保存（⌘S）';
        save.addEventListener('click', () => {
          void saveNow(true);
        });
        foot.appendChild(save);

        const del = el('button', 'wf-task-flow-btn danger', '删除');
        del.addEventListener('click', () => {
          // 删除前不再 flush
          flushPanelSave = null;
          if (saveTimer) window.clearTimeout(saveTimer);
          closeDetail();
          if (savedOnce) void removeTask(draft.id);
        });
        foot.appendChild(del);

        const cancel = el('button', 'wf-task-flow-btn', '取消');
        cancel.title = '关闭面板（未保存改动会先落盘）';
        cancel.addEventListener('click', closeDetail);
        foot.appendChild(cancel);

        // 已落库的任务（含全新草稿首次保存后）才允许启动 Session
        if (!savedOnce) return;
        if (draft.sessionId) {
          const open = el('button', 'wf-task-flow-btn session', '⚡ 打开 Session');
          open.addEventListener('click', () => {
            void ctx.api.openSessionInChat(draft.sessionId!);
          });
          foot.appendChild(open);
        } else {
          const start = el('button', 'wf-task-flow-btn session', '⚡ 启动 Session');
          start.addEventListener('click', () => {
            void startSession(start);
          });
          foot.appendChild(start);
        }
      }

      async function startSession(btn: HTMLButtonElement): Promise<void> {
        collect();
        btn.disabled = true;
        btn.textContent = '启动中…';
        // launchTaskSession 内部已落盘，关闭时不用再 flush
        flushPanelSave = null;
        if (saveTimer) window.clearTimeout(saveTimer);
        try {
          await launchTaskSession(draft);
          closeDetail();
          openDetail(draft.id);
        } catch {
          flushPanelSave = () => {
            flushPanelSave = null;
            if (saveTimer || dirty) void saveNow();
          };
          btn.textContent = '启动失败，重试';
          btn.disabled = false;
        }
      }
    }

    /* ---------- render dispatch ---------- */

    function renderContent(): void {
      content.innerHTML = '';
      if (state.tasks.length === 0) {
        const empty = el('div', 'wf-task-flow-empty');
        const msg = el('div');
        msg.append('还没有任务，按 ');
        msg.appendChild(el('kbd', '', 'C'));
        msg.append(' 或点 ＋ 创建');
        empty.appendChild(msg);
        content.appendChild(empty);
        return;
      }
      if (state.view === 'board') renderBoard(content);
      else if (state.view === 'calendar') renderCalendar(content);
      else if (state.view === 'today') renderToday(content);
      else renderSchedule(content);
    }

    /* ---------- keyboard: C 新建 ---------- */

    const onKey = (e: KeyboardEvent): void => {
      if (!body.isConnected) {
        document.removeEventListener('keydown', onKey);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'c') return;
      if (state.view !== 'board') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (!(target === document.body || body.contains(target))) return;
      e.preventDefault();
      openDetail(null);
    };
    document.addEventListener('keydown', onKey);

    // 其他 widget（如 command-center）可广播刷新
    ctx.bus.on('task:refresh', () => {
      if (body.isConnected) void reload();
    });

    // 桌面今日待办面板等其他窗口改动任务后实时刷新（reload 幂等；
    // 与 pomoTick/onKey 一样用 body.isConnected 兜底，widget 无 unmount 钩子，保持现有模式）
    window.kimi.onTasksChanged(() => {
      if (body.isConnected) void reload();
    });

    void reload();
  },
});
