/**
 * Command Center — rule engine + ACP fallback, drives the palette overlay.
 * Registers handlers into core/palette on import.
 *
 * Rules (↑/↓ choose, Enter runs the selected item; first item selected by default):
 *   番茄钟 / 番茄钟 25 / 专注 …        → addWidget('deep-focus')
 *   任务 / 看板 …                     → addWidget('task-flow')
 *   agents                            → addWidget('agents')
 *   搜索 xxx / search xxx             → searchLaunch(enabled engines)
 *   添加 widget X / 打开 X            → fuzzy match registry → addWidget
 *   关闭 X / 隐藏 X                   → minimizeWidget(instance)
 *   删除 X / 移除 X                   → removeWidget(instance)
 *   AI · 让 Kimi 处理「query」         → 问 Kimi（常驻末位；操作类句式时置顶）
 *
 * ACP fallback is a native workbench control channel: the Command Center ACP
 * session has the embedded MCP server mounted (task_create / widget_open /
 * widget_close / search_launch / focus_start / radar_create), so Kimi drives
 * the workbench via real tool calls — schema validation and result handling
 * live in the MCP layer (src/main/mcpserver.ts). The panel just streams Kimi's
 * text reply and shows a small "⚙ 调用工具" line above it for each tool call.
 */
import { closePalette, isPaletteOpen, setExecuteHandler, setQueryHandler } from '../core/palette';
import { addWidget, minimizeWidget, removeWidget } from '../core/layout';
import { allWidgets, getWidget, type BuiltinWidget } from '../core/registry';
import { bus } from '../core/bus';
import type { PermissionRequest, ToolCallEvent } from '../../../shared/types';

// ---------- command model ----------

interface PaletteCommand {
  kind: string; // tag shown in .p-kind
  title: string;
  desc: string;
  score: number;
  run(resultsEl: HTMLElement): void | Promise<void>;
}

/** Chinese/English alias keywords per known widget id (names may be EN while users type CN). */
const ALIASES: Record<string, string[]> = {
  'deep-focus': ['番茄钟', '番茄', '专注', '深度工作', 'pomodoro', 'focus', 'sprint', 'deep'],
  'task-flow': ['任务', '看板', '待办', 'task', 'kanban', 'todo', 'flow'],
  agents: ['agents', 'agent', '规则', 'md'],
  search: ['搜索', '搜索引擎', 'search', 'engine'],
  'widget-forge': ['forge', '锻造', '生成器', '画板'],
  'info-radar': ['雷达', 'radar', '资讯', '情报', '订阅'],
};

const RE_SEARCH = /^(?:搜索|搜|search|s)\s+(.+)$/i;
const RE_HIDE = /^(?:关闭|隐藏|hide|close|minimize)\s*(.+)$/i;
const RE_DEL = /^(?:删除|移除|remove|delete|rm)\s*(.+)$/i;
const RE_ADD = /^(?:添加|打开|开|新增|add|open|new)\s*(.*)$/i;
/**
 * Verb + content phrasing (新建一个任务 X / 记录 Y / 提醒我 Z …) signals an
 * operation intent the local rules can't fulfil — the AI entry goes first.
 * Verbs already owned by local rules (添加/打开/搜索/关闭/删除) stay excluded.
 */
const RE_INTENT = /(?:新建|创建|记录|提醒|帮我|安排|计划|记下|追踪|跟踪|建立|盯|create|remind|track)\s*\S/i;

const MAX_ITEMS = 8;

// ---------- matching ----------

/** Score how well `target` matches a widget (0 = no match). */
function matchWidget(target: string, w: BuiltinWidget): number {
  const t = target.trim().toLowerCase().replace(/[\s\d]+$/, '');
  if (!t) return 0;
  const fields = [w.def.id, w.def.name, ...(ALIASES[w.def.id] ?? [])].map((s) => s.toLowerCase());
  let best = 0;
  for (const f of fields) {
    if (f === t) best = Math.max(best, 100);
    else if (f.startsWith(t)) best = Math.max(best, 80);
    else if (f.includes(t)) best = Math.max(best, 60);
    else if (f.length >= 2 && t.includes(f)) best = Math.max(best, 50);
  }
  return best;
}

function addCommand(w: BuiltinWidget, score: number): PaletteCommand {
  return {
    kind: 'WIDGET',
    title: `添加 ${w.def.icon} ${w.def.name}`,
    desc: w.def.description,
    score,
    run() {
      addWidget(w.def.id);
      bus.emit('widget:add', { widgetId: w.def.id });
      closePalette();
    },
  };
}

// ---------- rule builders ----------

async function buildCommands(raw: string): Promise<PaletteCommand[]> {
  const q = raw.trim();
  const widgets = allWidgets();

  // empty query → suggest all widgets
  if (!q) return widgets.map((w) => addCommand(w, 10));

  const cmds: PaletteCommand[] = [];

  // 1) web search: 搜索 xxx
  const sm = q.match(RE_SEARCH);
  if (sm) {
    const term = sm[1].trim();
    if (term) {
      cmds.push({
        kind: '搜索',
        title: `搜索 “${term}”`,
        desc: '发射到所有已启用引擎',
        score: 95,
        async run() {
          const engines = await window.kimi.wb.getEngines();
          const urls = engines
            .filter((e) => e.enabled)
            .map((e) => e.template.replace('%s', encodeURIComponent(term)));
          if (urls.length) await window.kimi.wb.searchLaunch(urls);
          closePalette();
        },
      });
    }
  }

  // 2) hide / remove instances: 关闭 X / 隐藏 X / 删除 X
  const hideM = q.match(RE_HIDE);
  const delM = q.match(RE_DEL);
  if (hideM || delM) {
    const target = (hideM ?? delM)![1];
    const layout = await window.kimi.wb.getLayout();
    for (const inst of layout.widgets) {
      const w = getWidget(inst.widgetId);
      if (!w) continue;
      const s = matchWidget(target, w);
      if (!s) continue;
      if (hideM && !inst.minimized) {
        cmds.push({
          kind: 'HIDE',
          title: `隐藏 ${w.def.icon} ${w.def.name}`,
          desc: '休眠到 Dock',
          score: 85 + s / 100,
          run() {
            minimizeWidget(inst.instanceId);
            closePalette();
          },
        });
      } else if (delM) {
        cmds.push({
          kind: 'DEL',
          title: `删除 ${w.def.icon} ${w.def.name}`,
          desc: '从舞台移除',
          score: 85 + s / 100,
          run() {
            removeWidget(inst.instanceId);
            closePalette();
          },
        });
      }
    }
  }

  // 3) add / open widget: 添加 widget X / 打开 X，或裸关键词（番茄钟 / 任务 / 看板 / agents）
  const addM = q.match(RE_ADD);
  const seen = new Set<string>();
  const pushWidget = (target: string, bonus: number) => {
    for (const w of widgets) {
      if (seen.has(w.def.id)) continue;
      const s = matchWidget(target, w);
      if (!s) continue;
      seen.add(w.def.id);
      cmds.push(addCommand(w, bonus + s / 100));
    }
  };
  if (addM && addM[1].trim()) pushWidget(addM[1], 20); // explicit verb outranks bare keyword
  if (!hideM && !delM) pushWidget(q, 0);

  // 4) AI entry: always present for non-empty queries. Operation-intent
  //    phrasing (RE_INTENT) puts it first; otherwise it trails the local hits.
  //    搜索 xxx stays local-first even if the term itself contains a verb.
  const aiCmd: PaletteCommand = {
    kind: 'AI',
    title: `让 Kimi 处理「${q}」`,
    desc: 'ACP 流式回答，可直接操作工作台',
    score: 0,
    run: (resultsEl) => askKimi(q, resultsEl),
  };
  const sorted = cmds.sort((a, b) => b.score - a.score);
  const intentFirst = RE_INTENT.test(q) && !sm;
  return intentFirst
    ? [aiCmd, ...sorted].slice(0, MAX_ITEMS)
    : [...sorted.slice(0, MAX_ITEMS - 1), aiCmd];
}

// ---------- ACP streaming fallback ----------

const AUTO_KEY = 'wf-cc-auto';

/** injected once: tool lines / permission card / control bar styles (wf-cc- prefix) */
const CC_CSS = `
.wf-cc-bar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wf-cc-btn { font: inherit; font-size: 11px; padding: 2px 8px; border: 1px solid #3a3f4a; border-radius: 3px; background: transparent; color: #8a8f98; cursor: pointer; }
.wf-cc-btn:hover { color: #e6e6e6; border-color: #565c68; }
.wf-cc-stop { color: #ff7b72; border-color: #6e3431; }
.wf-cc-auto.on { color: #7ee787; border-color: #2ea043; }
.wf-cc-tools { margin-bottom: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.7; }
.wf-cc-tool { color: #8a8f98; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-cc-tool-detail { opacity: 0.75; }
.wf-cc-mark { display: inline-block; margin-left: 6px; }
.wf-cc-mark.run { color: #d29922; animation: wf-cc-rot 1s linear infinite; }
.wf-cc-mark.ok { color: #7ee787; }
.wf-cc-mark.err { color: #ff7b72; }
@keyframes wf-cc-rot { to { transform: rotate(360deg); } }
.wf-cc-perm { border: 1px solid #d29922; background: rgba(210, 153, 34, 0.08); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wf-cc-perm-title { color: #e3b341; font-size: 12px; margin-bottom: 2px; }
.wf-cc-perm-desc { color: #8a8f98; font-size: 11px; margin-bottom: 8px; white-space: pre-wrap; }
.wf-cc-perm-btns { display: flex; gap: 8px; }
.wf-cc-perm-btns button { font: inherit; font-size: 11px; padding: 2px 10px; border: 1px solid #3a3f4a; border-radius: 3px; background: transparent; color: #c9d1d9; cursor: pointer; }
.wf-cc-perm-btns .wf-cc-perm-allow { border-color: #2ea043; color: #7ee787; }
.wf-cc-perm-btns .wf-cc-perm-deny { border-color: #6e3431; color: #ff7b72; }
.wf-cc-forge { border: 1px solid #3a3f4a; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wf-cc-forge-bar { height: 3px; border-radius: 2px; background: #21262d; overflow: hidden; margin-bottom: 6px; }
.wf-cc-forge-scan { width: 40%; height: 100%; border-radius: 2px; background: linear-gradient(90deg, transparent, #39d0d8 50%, transparent); box-shadow: 0 0 6px #39d0d8; animation: wf-cc-scan 1.2s linear infinite; }
@keyframes wf-cc-scan { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.wf-cc-forge-label { font-size: 11px; color: #8a8f98; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-cc-forge.done .wf-cc-forge-label { color: #7ee787; }
.wf-cc-forge.err .wf-cc-forge-label { color: #ff7b72; }
`;

let cssInjected = false;
function injectCss(): void {
  if (cssInjected) return;
  cssInjected = true;
  const el = document.createElement('style');
  el.textContent = CC_CSS;
  document.head.appendChild(el);
}

let activeSid: string | null = null;
let answerEl: HTMLElement | null = null;
let toolsEl: HTMLElement | null = null;
let permBox: HTMLElement | null = null;
let stopBtn: HTMLButtonElement | null = null;
let autoBtn: HTMLButtonElement | null = null;
let streamBound = false;
let autoAllow = localStorage.getItem(AUTO_KEY) === '1';
/** toolCallId → its status line, so status updates edit in place */
const toolLines = new Map<string, HTMLElement>();
/** artifact title → its forge progress card (artifact_modify 进行中/结果) */
const forgeCards = new Map<string, HTMLElement>();
let forgeHostEl: HTMLElement | null = null;

/** One card per in-flight artifact_modify; swapped to ✓/✗ when main reports done/failed. */
function renderForgeCard(p: { state: 'started' | 'done' | 'failed'; title: string; message?: string }): void {
  if (!forgeHostEl || !forgeHostEl.isConnected) return;
  let card = forgeCards.get(p.title);
  if (card && !card.isConnected) {
    // resultsEl was cleared (new query / palette re-render) — drop the stale ref
    forgeCards.delete(p.title);
    card = undefined;
  }
  if (p.state === 'started') {
    if (card) return; // already forging
    card = document.createElement('div');
    card.className = 'wf-cc-forge';
    const bar = document.createElement('div');
    bar.className = 'wf-cc-forge-bar';
    const scan = document.createElement('div');
    scan.className = 'wf-cc-forge-scan';
    bar.appendChild(scan);
    const label = document.createElement('div');
    label.className = 'wf-cc-forge-label';
    label.textContent = `FORGING 「${p.title}」…`;
    card.append(bar, label);
    forgeHostEl.appendChild(card);
    forgeCards.set(p.title, card);
    return;
  }
  if (!card) return; // done/failed for a card we no longer show
  card.className = `wf-cc-forge ${p.state === 'done' ? 'done' : 'err'}`;
  card.textContent = '';
  const label = document.createElement('div');
  label.className = 'wf-cc-forge-label';
  label.textContent =
    p.state === 'done' ? `✓ 「${p.title}」已更新，已在舞台放大展示` : `✗ 修改失败：${p.message ?? '未知错误'}`;
  card.appendChild(label);
}

function setBusy(busy: boolean): void {
  if (stopBtn) stopBtn.style.display = busy ? '' : 'none';
}

function syncAutoBtn(): void {
  if (!autoBtn) return;
  autoBtn.classList.toggle('on', autoAllow);
  autoBtn.textContent = `AUTO ${autoAllow ? 'ON' : 'OFF'}`;
  autoBtn.title = autoAllow ? '自动批准本会话所有权限请求（yolo）' : '权限请求需手动确认';
}

/** `{"title":"x","priority":"medium"}` → `title: x · priority: medium`（≤60 字）。 */
function summarizeDetail(detail: string): string {
  let text = '';
  try {
    const obj = JSON.parse(detail) as Record<string, unknown>;
    text = Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' · ');
  } catch {
    // main 端把 detail 截断到 160 字，JSON 可能不完整——按 "key":"value" 尽力提取
    text = [...detail.matchAll(/"(\w+)":\s*"([^"]*)"/g)].map((m) => `${m[1]}: ${m[2]}`).join(' · ');
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** `⚙ task_create  title: xxx  ✓/✗/转圈`；update 事件 title/detail 为空时保留已有内容。 */
function renderToolLine(line: HTMLElement, e: ToolCallEvent): void {
  const title = e.title || line.dataset.title || '';
  const detail = e.detail || line.dataset.detail || '';
  line.dataset.title = title;
  line.dataset.detail = detail;
  const status = e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'err' : 'run';
  line.textContent = '';
  const head = document.createElement('span');
  head.textContent = `⚙ ${title}`;
  line.appendChild(head);
  const summary = summarizeDetail(detail);
  if (summary) {
    const d = document.createElement('span');
    d.className = 'wf-cc-tool-detail';
    d.textContent = `  ${summary}`;
    line.appendChild(d);
  }
  const mark = document.createElement('span');
  mark.className = `wf-cc-mark ${status}`;
  mark.textContent = status === 'ok' ? '✓' : status === 'err' ? '✗' : '◌';
  line.appendChild(mark);
}

/** Amber terminal-warning card; respondPermission fires exactly once, then hides. */
function showPermissionCard(req: PermissionRequest): void {
  if (!permBox) return;
  permBox.innerHTML = ''; // one card at a time
  const card = document.createElement('div');
  card.className = 'wf-cc-perm';
  const title = document.createElement('div');
  title.className = 'wf-cc-perm-title';
  title.textContent = `⚠ 权限请求：${req.title}`;
  const desc = document.createElement('div');
  desc.className = 'wf-cc-perm-desc';
  desc.textContent = req.description;
  const btns = document.createElement('div');
  btns.className = 'wf-cc-perm-btns';
  const respond = (approved: boolean, remember: boolean) => {
    window.kimi.respondPermission(req.requestId, approved, remember, req.sessionId);
    card.remove();
  };
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  btns.append(
    mk('允许', 'wf-cc-perm-allow', () => respond(true, false)),
    mk('本会话允许', '', () => respond(true, true)),
    mk('拒绝', 'wf-cc-perm-deny', () => respond(false, false)),
  );
  card.append(title, desc, btns);
  permBox.appendChild(card);
}

function bindStream(): void {
  if (streamBound) return;
  streamBound = true;
  injectCss();
  window.kimi.onChunk((e) => {
    if (e.sessionId === activeSid && answerEl && e.kind === 'text') {
      answerEl.textContent += e.text;
    }
  });
  // Kimi drives the workbench via embedded-MCP tool calls; surface each call
  // as a small status line above the reply so the operation is visible.
  window.kimi.onToolCall((e) => {
    if (e.sessionId !== activeSid || !toolsEl) return;
    let line = toolLines.get(e.toolCallId);
    if (!line) {
      line = document.createElement('div');
      line.className = 'wf-cc-tool';
      toolsEl.appendChild(line);
      toolLines.set(e.toolCallId, line);
    }
    renderToolLine(line, e);
  });
  // evPermission 广播到所有窗口；chat 窗有自己的权限条，只在 palette 打开时接管
  window.kimi.onPermission((req) => {
    if (req.sessionId !== activeSid || !permBox || !isPaletteOpen()) return;
    showPermissionCard(req);
  });
  window.kimi.onTurnDone((e) => {
    if (e.sessionId !== activeSid || !answerEl) return;
    answerEl.classList.remove('streaming');
    setBusy(false);
  });
  // artifact_modify 后台跑 1-2 分钟；palette 打开时在回复区上方显示 Forge 进度卡
  window.kimi.onArtifactProgress((p) => {
    if (isPaletteOpen()) renderForgeCard(p);
  });
}

async function askKimi(query: string, resultsEl: HTMLElement): Promise<void> {
  bindStream();
  resultsEl.innerHTML = '';
  toolLines.clear();
  forgeCards.clear(); // old cards die with the cleared DOM; don't keep refs
  forgeHostEl = null;

  // control bar: ⏹ 停止（仅流式/工具执行期间显示）+ AUTO 常驻开关
  const bar = document.createElement('div');
  bar.className = 'wf-cc-bar';
  const stop = document.createElement('button');
  stop.className = 'wf-cc-btn wf-cc-stop';
  stop.textContent = '⏹ 停止';
  stop.onclick = () => {
    const sid = activeSid;
    if (sid) void window.kimi.cancel(sid);
    setBusy(false);
  };
  stopBtn = stop;
  const auto = document.createElement('button');
  auto.className = 'wf-cc-btn wf-cc-auto';
  autoBtn = auto;
  syncAutoBtn();
  auto.onclick = () => {
    autoAllow = !autoAllow;
    localStorage.setItem(AUTO_KEY, autoAllow ? '1' : '0');
    syncAutoBtn();
    if (activeSid) window.kimi.setSessionAllow(activeSid, autoAllow);
  };
  bar.append(stop, auto);
  resultsEl.appendChild(bar);

  const perm = document.createElement('div');
  resultsEl.appendChild(perm);
  permBox = perm;

  const tools = document.createElement('div');
  tools.className = 'wf-cc-tools';
  resultsEl.appendChild(tools);
  toolsEl = tools;

  // forge progress cards sit between the tool lines and the streamed reply
  const forge = document.createElement('div');
  resultsEl.appendChild(forge);
  forgeHostEl = forge;

  const ans = document.createElement('div');
  ans.className = 'palette-answer streaming';
  resultsEl.appendChild(ans);
  answerEl = ans;

  activeSid = null;
  setBusy(true);
  try {
    activeSid = await window.kimi.wb.acpAsk(query); // Kimi 自行决定调 MCP 工具还是直接回答
    window.kimi.setSessionAllow(activeSid, autoAllow); // AUTO 状态持久化，新 session 自动应用
  } catch {
    ans.classList.remove('streaming');
    ans.textContent = '（Kimi 调用失败）';
    setBusy(false);
  }
  // palette stays open so the user can read the answer; Esc closes it
}

// ---------- rendering ----------

function render(resultsEl: HTMLElement, cmds: PaletteCommand[]): void {
  resultsEl.innerHTML = '';
  cmds.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = 'palette-item' + (i === 0 ? ' selected' : '');
    const kind = document.createElement('span');
    kind.className = 'p-kind';
    kind.textContent = cmd.kind;
    const title = document.createElement('span');
    title.textContent = cmd.title;
    const desc = document.createElement('span');
    desc.className = 'p-desc';
    desc.textContent = cmd.desc;
    item.append(kind, title, desc);
    item.onclick = () => void cmd.run(resultsEl);
    item.onmouseenter = () => {
      resultsEl.querySelectorAll('.palette-item.selected').forEach((el) => el.classList.remove('selected'));
      item.classList.add('selected');
    };
    resultsEl.appendChild(item);
  });
}

// ---------- registration ----------

export function initCommandCenter(): void {
  let seq = 0;

  setQueryHandler((query, resultsEl) => {
    const my = ++seq;
    void buildCommands(query).then((cmds) => {
      if (my !== seq) return; // stale keystroke
      render(resultsEl, cmds);
    });
  });

  setExecuteHandler((query, resultsEl) => {
    const my = ++seq;
    // run the highlighted item, not blindly the first; the rebuild below is
    // deterministic, so the DOM index maps onto the rebuilt command list
    const items = Array.from(resultsEl.querySelectorAll('.palette-item'));
    const sel = items.findIndex((el) => el.classList.contains('selected'));
    void buildCommands(query).then(async (cmds) => {
      if (my !== seq || !cmds.length) return;
      const idx = sel >= 0 && sel < cmds.length ? sel : 0;
      await cmds[idx].run(resultsEl);
    });
  });

  // Esc closes the palette (e.g. after reading a streamed answer).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPaletteOpen()) closePalette();
  });
}

initCommandCenter();
