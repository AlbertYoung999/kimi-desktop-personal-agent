import { registerWidget } from '../core/registry';
import type { FocusRecord } from '../../../shared/workbench-types';

type FocusMode = FocusRecord['mode'];

interface ActiveSession {
  mode: FocusMode;
  task: string;
  minutes: number;
  startedAt: number; // epoch ms of (re)start; remaining = minutes*60000 - (now - startedAt)
  paused: boolean;
  remainingMs: number; // snapshot used while paused
}

interface DoneSession {
  mode: FocusMode;
  task: string;
  minutes: number;
  completedAt: number;
}

const MODES: { id: FocusMode; label: string; minutes: number; desc: string }[] = [
  { id: 'sprint', label: 'Sprint', minutes: 25, desc: '25 min 快速冲刺' },
  { id: 'deep', label: 'Deep', minutes: 45, desc: '45 min 深度工作' },
  { id: 'breath', label: 'Breath', minutes: 5, desc: '5 min 呼吸休息' },
];

const RING_R = 80;
const RING_C = 2 * Math.PI * RING_R;

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.wf-deep-focus-root { display: flex; flex-direction: column; height: 100%; gap: 10px; }
.wf-deep-focus-main { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 0; }

/* ---- idle ---- */
.wf-deep-focus-task-input {
  width: 100%; max-width: 320px;
  border: 1px solid var(--border); border-radius: 8px;
  background: rgba(255,255,255,0.03); color: var(--fg);
  font: inherit; font-size: 13px; padding: 9px 12px; outline: none;
  text-align: center; transition: border-color 160ms var(--ease-in), box-shadow 160ms var(--ease-in);
}
.wf-deep-focus-task-input:focus { border-color: var(--border-strong); box-shadow: 0 0 12px rgba(0,240,255,0.12); }
.wf-deep-focus-task-input::placeholder { color: var(--disabled); }
.wf-deep-focus-modes { display: flex; gap: 8px; width: 100%; max-width: 380px; }
.wf-deep-focus-mode {
  flex: 1; padding: 10px 6px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--border); background: rgba(255,255,255,0.02);
  color: var(--muted); text-align: center;
  transition: all 160ms var(--ease-in);
}
.wf-deep-focus-mode:hover { border-color: var(--border-strong); color: var(--fg); }
.wf-deep-focus-mode.selected {
  border-color: var(--neon); color: var(--neon);
  background: rgba(0,240,255,0.06);
  box-shadow: 0 0 16px rgba(0,240,255,0.15), inset 0 0 12px rgba(0,240,255,0.05);
}
.wf-deep-focus-mode-name { font-family: var(--mono); font-size: 12px; letter-spacing: 1px; text-transform: uppercase; }
.wf-deep-focus-mode-min { font-family: var(--mono); font-size: 18px; font-weight: 700; margin: 4px 0 2px; }
.wf-deep-focus-mode-desc { font-size: 10.5px; color: var(--disabled); }
.wf-deep-focus-mode.selected .wf-deep-focus-mode-desc { color: var(--muted); }

/* ---- running ---- */
.wf-deep-focus-ring-wrap { position: relative; flex: 1; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center; }
.wf-deep-focus-ring { height: 100%; max-height: 260px; aspect-ratio: 1; max-width: 100%; }
.wf-deep-focus-ring-track { fill: none; stroke: rgba(255,255,255,0.06); stroke-width: 6; }
.wf-deep-focus-ring-prog {
  fill: none; stroke: url(#wf-deep-focus-grad); stroke-width: 6; stroke-linecap: round;
  filter: drop-shadow(0 0 6px rgba(0,240,255,0.55));
  transition: stroke-dashoffset 300ms linear;
}
.wf-deep-focus-center {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4px; pointer-events: none;
}
.wf-deep-focus-time {
  font-family: var(--mono); font-variant-numeric: tabular-nums;
  font-size: clamp(26px, 9cqmin, 44px); font-weight: 700; color: var(--fg);
  text-shadow: 0 0 18px rgba(0,240,255,0.35);
}
.wf-deep-focus-ring-wrap { container-type: size; }
.wf-deep-focus-task {
  font-size: 12px; color: var(--muted); max-width: 80%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wf-deep-focus-paused-tag { font-family: var(--mono); font-size: 10px; letter-spacing: 2px; color: var(--warn); }
.wf-deep-focus-controls { display: flex; gap: 10px; }

.wf-deep-focus-btn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 12px; padding: 7px 18px; border-radius: 8px; cursor: pointer;
  transition: all 160ms var(--ease-in);
}
.wf-deep-focus-btn:hover { color: var(--neon); border-color: var(--border-strong); box-shadow: 0 0 12px rgba(0,240,255,0.15); }
.wf-deep-focus-btn.primary {
  color: #0a0a0f; background: linear-gradient(135deg, #00f0ff, #0077ff);
  border: none; font-weight: 600; padding: 9px 28px;
  box-shadow: 0 0 18px rgba(0,240,255,0.3);
}
.wf-deep-focus-btn.primary:hover { box-shadow: 0 0 26px rgba(0,240,255,0.5); color: #0a0a0f; }
.wf-deep-focus-btn.danger:hover { color: var(--error); border-color: rgba(255,68,68,0.4); box-shadow: 0 0 12px rgba(255,68,68,0.15); }
.wf-deep-focus-btn:disabled { opacity: 0.4; cursor: default; pointer-events: none; }

/* ---- done ---- */
.wf-deep-focus-done { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; }
.wf-deep-focus-done-icon {
  font-size: 34px; color: var(--green);
  text-shadow: 0 0 20px rgba(0,255,136,0.6);
  animation: wfDeepFocusPulse 1.2s var(--ease-in) infinite;
}
@keyframes wfDeepFocusPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.75; }
}
.wf-deep-focus-done-title { font-size: 14px; font-weight: 600; }
.wf-deep-focus-done-q { font-size: 12px; color: var(--muted); }
.wf-deep-focus-note-input {
  width: 100%; max-width: 320px;
  border: 1px solid var(--border); border-radius: 8px;
  background: rgba(255,255,255,0.03); color: var(--fg);
  font: inherit; font-size: 12.5px; padding: 9px 12px; outline: none;
  transition: border-color 160ms var(--ease-in);
}
.wf-deep-focus-note-input:focus { border-color: var(--border-strong); }

/* ---- history ---- */
.wf-deep-focus-history { flex-shrink: 0; border-top: 1px solid var(--border); padding-top: 6px; }
.wf-deep-focus-history-head {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
  color: var(--muted); font-size: 11.5px; user-select: none; padding: 2px 0;
}
.wf-deep-focus-history-head:hover { color: var(--fg); }
.wf-deep-focus-history-caret { font-size: 9px; transition: transform 160ms var(--ease-in); }
.wf-deep-focus-history.open .wf-deep-focus-history-caret { transform: rotate(90deg); }
.wf-deep-focus-history-list { display: none; margin-top: 6px; max-height: 140px; overflow-y: auto; }
.wf-deep-focus-history.open .wf-deep-focus-history-list { display: block; }
.wf-deep-focus-hitem {
  display: flex; align-items: baseline; gap: 8px;
  padding: 5px 6px; border-radius: 6px; font-size: 11.5px;
}
.wf-deep-focus-hitem:hover { background: var(--card-hover); }
.wf-deep-focus-hitem .h-mode {
  font-family: var(--mono); font-size: 9.5px; color: var(--neon);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; flex-shrink: 0;
}
.wf-deep-focus-hitem .h-task { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-deep-focus-hitem .h-meta { margin-left: auto; color: var(--disabled); font-family: var(--mono); font-size: 10px; flex-shrink: 0; }
.wf-deep-focus-hitem .h-note { color: var(--muted); font-size: 10.5px; width: 100%; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-deep-focus-hempty { color: var(--disabled); font-size: 11px; padding: 6px; }
`;
  document.head.appendChild(style);
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1)}/${String(d.getDate())} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

registerWidget({
  def: {
    id: 'deep-focus',
    name: 'Deep Focus',
    icon: '◉',
    description: '番茄钟 + 全屏深度工作模式',
    category: 'focus',
    defaultSize: { w: 8, h: 9 },
    minSize: { w: 6, h: 6 },
  },
  mount(body, ctx) {
    injectStyle();

    const root = document.createElement('div');
    root.className = 'wf-deep-focus-root';
    body.appendChild(root);

    const main = document.createElement('div');
    main.className = 'wf-deep-focus-main';
    root.appendChild(main);

    let timer: number | null = null;
    const stopTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const getActive = (): ActiveSession | null => {
      const a = ctx.config.active as ActiveSession | undefined;
      return a && typeof a.startedAt === 'number' ? a : null;
    };
    const getDone = (): DoneSession | null => {
      const d = ctx.config.done as DoneSession | undefined;
      return d && typeof d.completedAt === 'number' ? d : null;
    };

    const remainingOf = (a: ActiveSession): number =>
      a.paused ? a.remainingMs : a.minutes * 60000 - (Date.now() - a.startedAt);

    // ---------------- focus pill status reporting ----------------
    // 上报状态给主进程「灵动岛」pill；状态一律从 ctx.config.active 读取，保证与 UI 一致。
    let lastReportAt = 0;
    const reportStatus = () => {
      lastReportAt = Date.now();
      try {
        const a = getActive();
        if (a) {
          window.kimi.reportFocusStatus({
            active: true,
            mode: a.mode,
            task: a.task,
            remainingMs: Math.max(0, remainingOf(a)),
            paused: a.paused,
          });
        } else {
          window.kimi.reportFocusStatus({
            active: false,
            mode: 'sprint',
            task: '',
            remainingMs: 0,
            paused: false,
          });
        }
      } catch {
        /* main 端不可用时静默失败，不阻塞 UI */
      }
    };

    // ---------------- idle view ----------------
    function renderIdle(): void {
      stopTimer();
      main.innerHTML = '';

      const input = document.createElement('input');
      input.className = 'wf-deep-focus-task-input';
      input.placeholder = '这次专注做什么？';
      input.value = (ctx.config.lastTask as string) || '';

      const modes = document.createElement('div');
      modes.className = 'wf-deep-focus-modes';
      let selected: FocusMode = (ctx.config.lastMode as FocusMode) || 'sprint';
      const modeEls = new Map<FocusMode, HTMLElement>();
      for (const m of MODES) {
        const el = document.createElement('div');
        el.className = 'wf-deep-focus-mode';
        el.innerHTML = `<div class="wf-deep-focus-mode-name">${m.label}</div>
          <div class="wf-deep-focus-mode-min">${m.minutes}</div>
          <div class="wf-deep-focus-mode-desc">${m.desc}</div>`;
        el.addEventListener('click', () => {
          selected = m.id;
          modeEls.forEach((e, id) => e.classList.toggle('selected', id === selected));
          startBtn.disabled = false;
        });
        modeEls.set(m.id, el);
        modes.appendChild(el);
      }
      modeEls.forEach((e, id) => e.classList.toggle('selected', id === selected));

      const startBtn = document.createElement('button');
      startBtn.className = 'wf-deep-focus-btn primary';
      startBtn.textContent = '开始专注';
      const start = () => {
        const m = MODES.find((x) => x.id === selected)!;
        const task = input.value.trim() || m.desc;
        ctx.setConfig({
          lastTask: input.value.trim(),
          lastMode: selected,
          done: null,
          active: {
            mode: selected,
            task,
            minutes: m.minutes,
            startedAt: Date.now(),
            paused: false,
            remainingMs: m.minutes * 60000,
          } satisfies ActiveSession,
        });
        reportStatus();
        renderRunning();
      };
      startBtn.addEventListener('click', start);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') start();
      });

      main.append(input, modes, startBtn);
      input.focus();
    }

    // ---------------- running view ----------------
    function renderRunning(): void {
      stopTimer();
      const a = getActive();
      if (!a) {
        renderIdle();
        return;
      }
      main.innerHTML = '';

      const wrap = document.createElement('div');
      wrap.className = 'wf-deep-focus-ring-wrap';
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'wf-deep-focus-ring');
      svg.setAttribute('viewBox', '0 0 200 200');
      svg.innerHTML = `
        <defs>
          <linearGradient id="wf-deep-focus-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#00f0ff"/>
            <stop offset="100%" stop-color="#0077ff"/>
          </linearGradient>
        </defs>
        <circle class="wf-deep-focus-ring-track" cx="100" cy="100" r="${RING_R}"/>
        <circle class="wf-deep-focus-ring-prog" cx="100" cy="100" r="${RING_R}"
          stroke-dasharray="${RING_C}" stroke-dashoffset="0"
          transform="rotate(-90 100 100)"/>`;
      const prog = svg.querySelector('.wf-deep-focus-ring-prog') as SVGCircleElement;

      const center = document.createElement('div');
      center.className = 'wf-deep-focus-center';
      const timeEl = document.createElement('div');
      timeEl.className = 'wf-deep-focus-time';
      const taskEl = document.createElement('div');
      taskEl.className = 'wf-deep-focus-task';
      taskEl.textContent = a.task;
      const pausedTag = document.createElement('div');
      pausedTag.className = 'wf-deep-focus-paused-tag';
      pausedTag.textContent = 'PAUSED';
      center.append(timeEl, taskEl, pausedTag);
      wrap.append(svg, center);

      const controls = document.createElement('div');
      controls.className = 'wf-deep-focus-controls';
      const pauseBtn = document.createElement('button');
      pauseBtn.className = 'wf-deep-focus-btn';
      const giveUpBtn = document.createElement('button');
      giveUpBtn.className = 'wf-deep-focus-btn danger';
      giveUpBtn.textContent = '放弃';
      controls.append(pauseBtn, giveUpBtn);

      const tick = () => {
        const cur = getActive();
        if (!cur) return;
        const rem = remainingOf(cur);
        timeEl.textContent = fmt(rem);
        prog.style.strokeDashoffset = String(RING_C * (1 - rem / (cur.minutes * 60000)));
        pausedTag.style.display = cur.paused ? '' : 'none';
        pauseBtn.textContent = cur.paused ? '继续' : '暂停';
        // 计时进行中每 5s 节流上报一次（tick 本身 250ms）
        if (Date.now() - lastReportAt >= 1000) reportStatus();
        if (rem <= 0 && !cur.paused) finish(cur);
      };

      pauseBtn.addEventListener('click', () => {
        const cur = getActive();
        if (!cur) return;
        if (cur.paused) {
          ctx.setConfig({
            active: {
              ...cur,
              paused: false,
              startedAt: Date.now() - (cur.minutes * 60000 - cur.remainingMs),
            } satisfies ActiveSession,
          });
        } else {
          ctx.setConfig({
            active: { ...cur, paused: true, remainingMs: remainingOf(cur) } satisfies ActiveSession,
          });
        }
        reportStatus();
        tick();
      });

      giveUpBtn.addEventListener('click', () => {
        ctx.setConfig({ active: null });
        reportStatus();
        renderIdle();
      });

      main.append(wrap, controls);
      tick();
      timer = window.setInterval(tick, 250);
    }

    // ---------------- done view ----------------
    function finish(a: ActiveSession): void {
      stopTimer();
      ctx.setConfig({
        active: null,
        done: {
          mode: a.mode,
          task: a.task,
          minutes: a.minutes,
          completedAt: Date.now(),
        } satisfies DoneSession,
      });
      reportStatus();
      renderDone();
    }

    function renderDone(): void {
      stopTimer();
      const d = getDone();
      if (!d) {
        renderIdle();
        return;
      }
      main.innerHTML = '';

      const box = document.createElement('div');
      box.className = 'wf-deep-focus-done';
      const icon = document.createElement('div');
      icon.className = 'wf-deep-focus-done-icon';
      icon.textContent = '◉';
      const title = document.createElement('div');
      title.className = 'wf-deep-focus-done-title';
      title.textContent = `${d.minutes} 分钟专注完成`;
      const q = document.createElement('div');
      q.className = 'wf-deep-focus-done-q';
      q.textContent = '这段时间完成了什么？';
      const note = document.createElement('input');
      note.className = 'wf-deep-focus-note-input';
      note.placeholder = '记录一下成果…（可留空）';

      const btns = document.createElement('div');
      btns.className = 'wf-deep-focus-controls';
      const okBtn = document.createElement('button');
      okBtn.className = 'wf-deep-focus-btn primary';
      okBtn.textContent = '记录';
      btns.append(okBtn);

      const save = async () => {
        okBtn.disabled = true;
        const rec: FocusRecord = {
          mode: d.mode,
          task: d.task,
          minutes: d.minutes,
          completedAt: d.completedAt,
          note: note.value.trim(),
        };
        try {
          await ctx.api.focusLog(rec);
        } catch {
          /* main 端不可用时静默失败，不阻塞 UI */
        }
        ctx.setConfig({ done: null });
        reportStatus(); // 回到 idle，通知 pill 隐藏
        void loadHistory();
        renderIdle();
      };
      okBtn.addEventListener('click', () => void save());
      note.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void save();
      });

      box.append(icon, title, q, note, btns);
      main.append(box);
      note.focus();
    }

    // ---------------- history (collapsible) ----------------
    const history = document.createElement('div');
    history.className = 'wf-deep-focus-history';
    const hHead = document.createElement('div');
    hHead.className = 'wf-deep-focus-history-head';
    hHead.innerHTML = `<span class="wf-deep-focus-history-caret">▶</span><span>最近记录</span><span class="spacer"></span><span class="wf-deep-focus-hcount"></span>`;
    const hList = document.createElement('div');
    hList.className = 'wf-deep-focus-history-list';
    history.append(hHead, hList);
    root.appendChild(history);

    if (ctx.config.historyOpen) history.classList.add('open');
    hHead.addEventListener('click', () => {
      history.classList.toggle('open');
      ctx.setConfig({ historyOpen: history.classList.contains('open') });
    });

    async function loadHistory(): Promise<void> {
      let recs: FocusRecord[] = [];
      try {
        recs = await ctx.api.focusHistory();
      } catch {
        recs = [];
      }
      const count = history.querySelector('.wf-deep-focus-hcount');
      if (count) count.textContent = recs.length ? `${recs.length} 条` : '';
      hList.innerHTML = '';
      if (!recs.length) {
        const empty = document.createElement('div');
        empty.className = 'wf-deep-focus-hempty';
        empty.textContent = '还没有专注记录';
        hList.appendChild(empty);
        return;
      }
      for (const r of recs.slice(0, 20)) {
        const item = document.createElement('div');
        item.className = 'wf-deep-focus-hitem';
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'baseline';
        row.style.gap = '8px';
        row.style.width = '100%';
        const mode = document.createElement('span');
        mode.className = 'h-mode';
        mode.textContent = r.mode;
        const task = document.createElement('span');
        task.className = 'h-task';
        task.textContent = r.task;
        const meta = document.createElement('span');
        meta.className = 'h-meta';
        meta.textContent = `${r.minutes}m · ${fmtTime(r.completedAt)}`;
        row.append(mode, task, meta);
        item.appendChild(row);
        if (r.note) {
          const noteEl = document.createElement('div');
          noteEl.className = 'h-note';
          noteEl.textContent = r.note;
          item.appendChild(noteEl);
        }
        hList.appendChild(item);
      }
    }

    // ---------------- boot: restore state ----------------
    const active = getActive();
    if (active && remainingOf(active) <= 0 && !active.paused) {
      finish(active); // remount 时计时已到期 → 直接进入完成确认
    } else if (active) {
      reportStatus(); // 恢复进行中的计时，立即同步 pill
      renderRunning();
    } else if (getDone()) {
      renderDone();
    } else {
      renderIdle();
    }
    void loadHistory();
  },
});
