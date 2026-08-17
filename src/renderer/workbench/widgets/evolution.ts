import { registerWidget } from '../core/registry';

/**
 * Evolution log widget: shows the app's recent self-modification history
 * (tool calls pushed by the main process via wbEvolveLog, newest first).
 */

interface EvolveEntry {
  at: number;
  tool: string;
  params: Record<string, unknown>;
  result: string;
}

const STYLE_ID = 'wf-evolution-style';
const CSS = `
.wf-evolution { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.wf-evolution-bar { display: flex; align-items: center; gap: 6px; padding-bottom: 8px; }
.wf-evolution-title { flex: 1; font-family: var(--mono); font-size: 10px; letter-spacing: 1px; color: var(--muted); text-transform: uppercase; }
.wf-evolution-refresh { background: none; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); font-family: var(--mono); font-size: 11px; cursor: pointer; padding: 0 5px; line-height: 1.4; }
.wf-evolution-refresh:hover { color: var(--neon); border-color: var(--border-strong); }
.wf-evolution-refresh:disabled { color: var(--disabled); cursor: default; }
.wf-evolution-list { flex: 1; min-height: 0; overflow-y: auto; font-family: var(--mono); font-size: 11px; line-height: 1.7; }
.wf-evolution-row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-evolution-time { color: var(--muted); margin-right: 6px; }
.wf-evolution-tool { color: var(--neon); margin-right: 6px; }
.wf-evolution-params { color: var(--fg); opacity: 0.7; margin-right: 6px; }
.wf-evolution-arrow { color: var(--muted); margin-right: 6px; }
.wf-evolution-result { color: var(--green); }
.wf-evolution-result.is-error { color: var(--error); }
.wf-evolution-empty { color: var(--muted); font-family: var(--mono); font-size: 11px; padding: 12px 0; text-align: center; letter-spacing: 1px; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function summarizeParams(params: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(params) ?? '';
  } catch {
    s = '';
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

registerWidget({
  def: {
    id: 'evolution',
    name: '演化日志',
    icon: '⍜',
    description: '最近的自我演化操作记录',
    category: 'system',
    defaultSize: { w: 11, h: 9 },
    minSize: { w: 8, h: 6 },
  },
  mount(body) {
    ensureStyle();
    body.classList.add('wf-evolution');
    const bar = document.createElement('div');
    bar.className = 'wf-evolution-bar';
    const title = document.createElement('span');
    title.className = 'wf-evolution-title';
    title.textContent = 'EVOLVE LOG';
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'wf-evolution-refresh';
    refreshBtn.textContent = '⟳';
    refreshBtn.title = '刷新';
    const list = document.createElement('div');
    list.className = 'wf-evolution-list';
    bar.append(title, refreshBtn);
    body.append(bar, list);

    const load = async (): Promise<void> => {
      refreshBtn.disabled = true;
      let entries: EvolveEntry[] = [];
      try {
        entries = await window.kimi.wbEvolveLog();
      } catch {
        entries = [];
      }
      refreshBtn.disabled = false;
      list.innerHTML = '';
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wf-evolution-empty';
        empty.textContent = '还没有演化记录';
        list.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'wf-evolution-row';
        const time = document.createElement('span');
        time.className = 'wf-evolution-time';
        time.textContent = `[${fmtTime(entry.at)}]`;
        const tool = document.createElement('span');
        tool.className = 'wf-evolution-tool';
        tool.textContent = entry.tool;
        const params = document.createElement('span');
        params.className = 'wf-evolution-params';
        params.textContent = summarizeParams(entry.params);
        const arrow = document.createElement('span');
        arrow.className = 'wf-evolution-arrow';
        arrow.textContent = '→';
        const result = document.createElement('span');
        const failed = entry.result.startsWith('✗');
        result.className = failed ? 'wf-evolution-result is-error' : 'wf-evolution-result';
        result.textContent = entry.result;
        row.title = `${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })} ${entry.tool}\n${entry.result}`;
        row.append(time, tool, params, arrow, result);
        list.appendChild(row);
      }
    };
    refreshBtn.addEventListener('click', () => void load());
    void load();
  },
});
