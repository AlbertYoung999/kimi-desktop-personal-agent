import { registerWidget } from '../core/registry';
import type { WidgetContext } from '../core/registry';
import { addWidget } from '../core/layout';
import type { LibraryItem } from '../../api';

/* ------------------------------------------------------------------ */
/* styles (injected once, all classes prefixed wf-forge-)              */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'wf-forge-style';
const CSS = `
.wf-forge-root { position: relative; height: 100%; display: flex; flex-direction: column; gap: 10px; }

/* tabs */
.wf-forge-tabs { display: flex; gap: 6px; flex-shrink: 0; }
.wf-forge-tab {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 1.5px;
  padding: 4px 12px; border-radius: 6px; cursor: pointer;
  transition: color 160ms var(--ease-in), border-color 160ms var(--ease-in);
}
.wf-forge-tab:hover { color: var(--fg); }
.wf-forge-tab.on {
  color: var(--neon); border-color: var(--border-strong);
  background: rgba(0,240,255,0.07); text-shadow: 0 0 8px rgba(0,240,255,0.5);
}

.wf-forge-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.wf-forge-pane[hidden] { display: none; }

/* chat flow */
.wf-forge-list { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding-right: 2px; }
.wf-forge-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; color: var(--disabled); font-size: 12.5px; text-align: center; line-height: 1.7;
}
.wf-forge-empty kbd {
  font-family: var(--mono); border: 1px solid var(--border-strong); border-radius: 4px;
  color: var(--neon); padding: 1px 6px; font-size: 11px;
}
.wf-forge-turn { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.wf-forge-msg { max-width: 92%; padding: 6px 10px; border-radius: 8px; font-size: 12px; line-height: 1.65; }
.wf-forge-msgrole {
  display: block; font-family: var(--mono); font-size: 9px; letter-spacing: 2px;
  color: var(--disabled); margin-bottom: 3px;
}
.wf-forge-msg.user {
  align-self: flex-end; background: rgba(0,240,255,0.07);
  border: 1px solid var(--border-strong); color: var(--fg);
}
.wf-forge-msg.user .wf-forge-msgrole { color: var(--neon); }
.wf-forge-msg.agent {
  align-self: flex-start; background: var(--card);
  border: 1px solid var(--border); color: var(--muted); white-space: pre-wrap; word-break: break-word;
}
.wf-forge-msg.agent.pending { font-family: var(--mono); letter-spacing: 2px; color: var(--neon); }
.wf-forge-msg.agent.pending::after { content: '▊'; animation: wf-forge-blink 700ms steps(1) infinite; }

/* composer */
.wf-forge-composer { display: flex; gap: 6px; flex-shrink: 0; }
.wf-forge-input {
  flex: 1; min-width: 60px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(0,0,0,0.25); color: var(--fg); font: inherit; font-size: 12px;
  padding: 5px 10px; outline: none;
}
.wf-forge-input:focus { border-color: var(--border-strong); }
.wf-forge-genbtn {
  border: 1px solid var(--border-strong); background: rgba(0,240,255,0.08); color: var(--neon);
  font: inherit; font-size: 12px; padding: 5px 14px; border-radius: 6px; cursor: pointer;
  transition: box-shadow 160ms var(--ease-in); white-space: nowrap;
}
.wf-forge-genbtn:hover:not(:disabled) { box-shadow: 0 0 12px rgba(0,240,255,0.25); }
.wf-forge-genbtn:disabled { opacity: 0.5; cursor: default; }

/* artifact card */
.wf-forge-card {
  align-self: stretch; background: var(--card); border: 1px solid var(--border); border-radius: 10px;
  overflow: hidden; flex-shrink: 0; position: relative;
}
.wf-forge-card.land { animation: wf-forge-land 480ms var(--ease-in); }
@keyframes wf-forge-land {
  0% { box-shadow: 0 0 0 0 rgba(0,240,255,0.5); }
  100% { box-shadow: 0 0 0 18px rgba(0,240,255,0); }
}
.wf-forge-cardhead {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  border-bottom: 1px solid var(--hairline); flex-shrink: 0;
}
.wf-forge-cardtitle { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-forge-badge {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 1px; color: var(--neon);
  border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 7px; line-height: 16px;
  flex-shrink: 0;
}
.wf-forge-del {
  margin-left: auto; border: none; background: none; color: var(--disabled);
  font-size: 14px; cursor: pointer; width: 22px; height: 22px; border-radius: 5px; flex-shrink: 0;
}
.wf-forge-del:hover { color: var(--error); background: rgba(255,68,68,0.1); }
.wf-forge-warn {
  display: flex; align-items: center; gap: 6px; padding: 5px 10px;
  background: rgba(255,170,0,0.08); border-bottom: 1px solid rgba(255,170,0,0.3);
  color: var(--warn); font-family: var(--mono); font-size: 10.5px; line-height: 1.5;
}
.wf-forge-preview { position: relative; padding: 10px; overflow: auto; max-height: 320px; }
.wf-forge-cardfoot { display: flex; gap: 6px; padding: 7px 10px; border-top: 1px solid var(--hairline); }
.wf-forge-btn {
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  font: inherit; font-size: 11.5px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  white-space: nowrap;
}
.wf-forge-btn:hover:not(:disabled) { color: var(--neon); border-color: var(--border-strong); }
.wf-forge-btn:disabled { opacity: 0.55; cursor: default; }
.wf-forge-btn.saved {
  color: var(--green); border-color: rgba(0,255,136,0.35);
  text-shadow: 0 0 8px rgba(0,255,136,0.4);
}

/* library pane */
.wf-forge-liblist { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
.wf-forge-librow {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex-shrink: 0;
  background: var(--card); border: 1px solid var(--border); border-radius: 8px;
}
.wf-forge-libmeta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wf-forge-libtitle { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-forge-libtime { font-family: var(--mono); font-size: 10px; color: var(--disabled); }

/* ---- Forge Mode overlay (PRD §3.8.2) ---- */
.wf-forge-overlay {
  position: absolute; inset: 0; z-index: 20; border-radius: inherit; overflow: hidden;
  background: rgba(8,10,15,0.96); display: flex; flex-direction: column;
  animation: wf-forge-fadein 240ms var(--ease-in);
}
@keyframes wf-forge-fadein { from { opacity: 0; } }
.wf-forge-grid {
  position: absolute; inset: 0; pointer-events: none; opacity: 0.5;
  background-image:
    linear-gradient(rgba(0,240,255,0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,240,255,0.05) 1px, transparent 1px);
  background-size: 26px 26px;
}
.wf-forge-stage { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
.wf-forge-echo {
  position: absolute; top: 14px; left: 16px; right: 16px; font-family: var(--mono);
  font-size: 12px; color: var(--fg); line-height: 1.6; word-break: break-word;
}
.wf-forge-echo::after {
  content: '▊'; color: var(--neon); margin-left: 2px;
  animation: wf-forge-blink 700ms steps(1) infinite;
}
@keyframes wf-forge-blink { 50% { opacity: 0; } }
.wf-forge-frame {
  position: relative; width: min(300px, 72%); height: min(180px, 52%);
  border: 1px dashed var(--border-strong); border-radius: 8px;
  opacity: 0; transition: opacity 300ms var(--ease-in); overflow: hidden;
}
.wf-forge-frame.on { opacity: 1; }
.wf-forge-frame.hot { box-shadow: 0 0 18px rgba(0,240,255,0.25), inset 0 0 18px rgba(0,240,255,0.08); }
.wf-forge-edge { position: absolute; background: var(--neon); box-shadow: 0 0 10px var(--neon), 0 0 20px rgba(0,240,255,0.5); }
.wf-forge-edge.t { top: -1px; left: 0; height: 2px; width: 0; transition: width 300ms linear; }
.wf-forge-edge.r { top: 0; right: -1px; width: 2px; height: 0; transition: height 300ms linear; }
.wf-forge-edge.b { bottom: -1px; right: 0; height: 2px; width: 0; transition: width 300ms linear; }
.wf-forge-edge.l { bottom: 0; left: -1px; width: 2px; height: 0; transition: height 300ms linear; }
.wf-forge-edge.t.lit { width: 100%; }
.wf-forge-edge.r.lit { height: 100%; }
.wf-forge-edge.b.lit { width: 100%; }
.wf-forge-edge.l.lit { height: 100%; }
.wf-forge-pseudo {
  position: absolute; inset: 8px; overflow: hidden; font-family: var(--mono);
  font-size: 10px; line-height: 1.7; color: rgba(0,240,255,0.55);
  display: flex; flex-direction: column; justify-content: flex-end;
}
.wf-forge-scanline {
  position: absolute; left: 0; right: 0; height: 40%; display: none;
  background: linear-gradient(180deg, transparent, rgba(0,240,255,0.15), rgba(0,240,255,0.5));
  animation: wf-forge-scanline 1100ms linear infinite;
}
.wf-forge-frame.scanning .wf-forge-scanline { display: block; }
@keyframes wf-forge-scanline { from { top: -40%; } to { top: 100%; } }
.wf-forge-flash {
  position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none;
}
.wf-forge-frame.pulse .wf-forge-flash { animation: wf-forge-flash 420ms var(--ease-in); }
.wf-forge-frame.pulse { border-style: solid; border-color: #fff; box-shadow: 0 0 30px rgba(255,255,255,0.5); }
@keyframes wf-forge-flash { 0% { opacity: 0; } 30% { opacity: 0.85; } 100% { opacity: 0; } }
.wf-forge-status {
  position: relative; flex-shrink: 0; padding: 9px 14px; border-top: 1px solid var(--hairline);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 2px; color: var(--neon);
  text-shadow: 0 0 10px rgba(0,240,255,0.5);
}
.wf-forge-status::after { content: '_'; animation: wf-forge-blink 700ms steps(1) infinite; }
.wf-forge-status.ok { color: var(--green); text-shadow: 0 0 10px rgba(0,255,136,0.6); }
.wf-forge-status.err { color: var(--error); text-shadow: 0 0 10px rgba(255,68,68,0.6); }
`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface ChatArtifact {
  id: string;
  title: string;
  html: string;
  saved: boolean;
}

interface ChatTurn {
  id: string;
  user: string;
  agentText: string;
  pending?: boolean;
  artifact?: ChatArtifact;
}

/** 旧版 config.forged（无对话记录），迁移为单轮对话 */
interface LegacyForged {
  id: string;
  title: string;
  html: string;
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

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function newId(): string {
  return `fg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 从 kimi 全文中提取 ```html 围栏内容；无围栏时退化为第一个 < 之后的内容 */
function extractHtml(text: string): string | null {
  const fence = /```(?:html)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  let code: string | null = fence ? fence[1] : null;
  if (!code) {
    const start = text.indexOf('<');
    if (start >= 0) code = text.slice(start);
  }
  if (!code || !code.includes('<')) return null;
  return code.trim();
}

/** 剥离围栏代码后的说明文字（对话流中展示给用户） */
function extractAgentText(text: string): string {
  if (/```/.test(text)) return text.replace(/```(?:html)?[\s\S]*?```/gi, '').trim();
  const start = text.indexOf('<');
  if (start >= 0) return text.slice(0, start).trim();
  return text.trim();
}

/** 生成物第一行约定注释 <!-- title: xxx -->，否则用需求原文兜底 */
function extractTitle(html: string, fallback: string): string {
  const m = /<!--\s*title:\s*(.+?)\s*-->/i.exec(html);
  if (m && m[1]) return m[1].slice(0, 24);
  return fallback.replace(/\s+/g, ' ').slice(0, 16) || '未命名 Widget';
}

/* 设计稿 §3.4 缓解：静态扫描高危调用（fetch 明确放行） */
const DANGER_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\brequire\s*\(/, label: 'require()' },
  { re: /\bprocess\s*\./, label: 'process.*' },
  { re: /window\s*\.\s*kimi\b/, label: 'window.kimi' },
  { re: /ipcRenderer/, label: 'ipcRenderer' },
  { re: /\beval\s*\(/, label: 'eval()' },
  { re: /new\s+Function\s*\(/, label: 'new Function()' },
  { re: /<iframe[\s>]/i, label: '<iframe>' },
];

function scanDanger(html: string): string[] {
  return DANGER_PATTERNS.filter((p) => p.re.test(html)).map((p) => p.label);
}

/**
 * Scoped `document` for generated scripts: getElementById only searches inside
 * the card's preview container. The same artifact can be mounted in a preview
 * card and on the stage at the same time, and duplicate ids would otherwise
 * bind every script to the first match in the document. DOMContentLoaded
 * listeners run immediately — that event fired long before injection time.
 * (Kept in sync with widgets/artifact.ts.)
 */
function scopedDocument(host: HTMLElement): Document {
  return new Proxy(document, {
    get(target, prop) {
      if (prop === 'getElementById') {
        // NB: the local const CSS (style text) shadows the global — reach via globalThis
        return (id: string) => host.querySelector(`#${globalThis.CSS.escape(id)}`);
      }
      if (prop === 'addEventListener') {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (listener == null) return;
          if (type === 'DOMContentLoaded') {
            const ev = new Event('DOMContentLoaded');
            if (typeof listener === 'function') listener.call(target, ev);
            else listener.handleEvent(ev);
            return;
          }
          target.addEventListener(type, listener, options);
        };
      }
      // keep getters/methods bound to the real document (WebIDL brand checks)
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** innerHTML 不执行 <script>，遍历重建 script 元素使其生效（document 作用域限定在容器内） */
function mountArtifact(container: HTMLElement, html: string): void {
  container.innerHTML = html;
  const w = window as unknown as Record<string, unknown>;
  w.__artifactDoc = scopedDocument(container);
  for (const old of Array.from(container.querySelectorAll('script'))) {
    const s = document.createElement('script');
    for (const attr of Array.from(old.attributes)) s.setAttribute(attr.name, attr.value);
    s.textContent = `;(function (document) {\n${old.textContent ?? ''}\n})(window.__artifactDoc);`;
    old.replaceWith(s);
  }
  // classic scripts ran synchronously above; defer cleanup so deferred
  // (type="module") scripts can still read the scoped document first
  setTimeout(() => {
    delete w.__artifactDoc;
  }, 0);
}

function buildGenPrompt(requirement: string): string {
  return [
    '你是一个桌面 widget 制造器。根据下面的需求生成【单个自包含 HTML 片段】。',
    '硬性要求：',
    '- 只输出一个用 ```html 围栏包裹的代码块',
    '- 围栏外可以用一两句中文说明设计取舍、数据来源或遇到的问题；无法完成时也在围栏外说明原因',
    '- 片段第一行是注释 <!-- title: 组件中文标题（8 字以内） -->',
    '- 全部 CSS 放在内联 <style> 中，全部 JS 放在内联 <script> 中，不引用任何外部资源（无 CDN、无外链图片）',
    '- 视觉风格：霓虹暗色 HUD——深色背景 #10141c、青色霓虹 #00f0ff 主色、等宽字体显示数字、细发光边框',
    '- 根元素宽度自适应容器（100%），不要写死大宽度',
    '- 禁止调用 require、process、window.kimi、ipcRenderer 等 Node/Electron 能力；需要数据时可用 fetch 调公网 API',
    '',
    `需求：${requirement}`,
  ].join('\n');
}

function buildTweakPrompt(currentHtml: string, instruction: string): string {
  return [
    '以下是一个桌面 widget 的完整自包含 HTML。请根据修改要求输出更新后的完整 HTML。',
    '要求与最初一致：单个 ```html 围栏代码块、首行 <!-- title: ... --> 注释（如标题变化请更新）、',
    '全部内联 <style>/<script>、无外部资源、霓虹暗色 HUD 风格、禁止 require/process/window.kimi/ipcRenderer。',
    '围栏外可以用一两句中文说明本次改了什么；若无法修改，在围栏外说明原因。',
    '',
    '当前 HTML：',
    '```html',
    currentHtml,
    '```',
    '',
    `修改要求：${instruction}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* widget                                                              */
/* ------------------------------------------------------------------ */

registerWidget({
  def: {
    id: 'widget-forge',
    name: 'Widget Forge',
    icon: '⚒',
    description: '自然语言生成 widget，对话式迭代，确认入库',
    category: 'ai',
    defaultSize: { w: 14, h: 11 },
    minSize: { w: 10, h: 8 },
  },
  mount(body, ctx) {
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    const state = { turns: readTurns(ctx), generating: false };

    /* ---------- DOM skeleton ---------- */

    const root = el('div', 'wf-forge-root');

    const tabs = el('div', 'wf-forge-tabs');
    const tabForge = el('button', 'wf-forge-tab on', '工坊');
    const tabLib = el('button', 'wf-forge-tab', '组件库');
    tabs.append(tabForge, tabLib);

    // 工坊 pane：消息流 + 常驻输入框
    const paneForge = el('div', 'wf-forge-pane');
    const list = el('div', 'wf-forge-list');
    const composer = el('div', 'wf-forge-composer');
    const input = el('input', 'wf-forge-input') as HTMLInputElement;
    input.placeholder = '描述需求，或对最新组件说一句修改，如「数字加大」';
    const genBtn = el('button', 'wf-forge-genbtn', '⚒ 生成');
    composer.append(input, genBtn);
    paneForge.append(list, composer);

    // 组件库 pane
    const paneLib = el('div', 'wf-forge-pane');
    paneLib.hidden = true;
    const libList = el('div', 'wf-forge-liblist');
    paneLib.appendChild(libList);

    root.append(tabs, paneForge, paneLib);
    body.innerHTML = '';
    body.appendChild(root);

    /* ---------- persistence ---------- */

    function readTurns(c: WidgetContext): ChatTurn[] {
      const raw = c.config.turns;
      if (Array.isArray(raw)) {
        const out: ChatTurn[] = [];
        for (const it of raw) {
          if (!it || typeof it !== 'object') continue;
          const o = it as Record<string, unknown>;
          if (typeof o.id !== 'string' || typeof o.user !== 'string') continue;
          const turn: ChatTurn = {
            id: o.id,
            user: o.user,
            agentText: typeof o.agentText === 'string' ? o.agentText : '',
          };
          const a = o.artifact as Record<string, unknown> | undefined;
          if (a && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.html === 'string') {
            turn.artifact = { id: a.id, title: a.title, html: a.html, saved: a.saved === true };
          }
          out.push(turn);
        }
        return out;
      }
      // 旧版 forged 数据迁移：每个生成物变成一轮对话
      const legacy = readLegacyForged(c);
      return legacy.map((f) => ({
        id: newId(),
        user: f.title,
        agentText: '',
        artifact: { id: f.id, title: f.title, html: f.html, saved: false },
      }));
    }

    function readLegacyForged(c: WidgetContext): LegacyForged[] {
      const raw = c.config.forged;
      if (!Array.isArray(raw)) return [];
      const out: LegacyForged[] = [];
      for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        if (typeof o.id === 'string' && typeof o.title === 'string' && typeof o.html === 'string') {
          out.push({ id: o.id, title: o.title, html: o.html });
        }
      }
      return out;
    }

    function persist(): void {
      ctx.setConfig({ turns: state.turns.map(({ pending: _p, ...t }) => t) });
    }

    function latestArtifact(): ChatArtifact | null {
      for (let i = state.turns.length - 1; i >= 0; i--) {
        const a = state.turns[i].artifact;
        if (a) return a;
      }
      return null;
    }

    function scrollBottom(): void {
      list.scrollTop = list.scrollHeight;
    }

    /* ---------- chat rendering ---------- */

    function renderTurns(): void {
      list.innerHTML = '';
      if (state.turns.length === 0) {
        const empty = el('div', 'wf-forge-empty');
        const msg = el('div');
        msg.append('在下方描述需求，按 ');
        msg.appendChild(el('kbd', '', 'Enter'));
        msg.append(' 让 Kimi 现场制造一个 widget');
        empty.appendChild(msg);
        list.appendChild(empty);
        return;
      }
      for (const turn of state.turns) list.appendChild(renderTurn(turn));
    }

    function renderTurn(turn: ChatTurn): HTMLElement {
      const wrap = el('div', 'wf-forge-turn');
      wrap.dataset.turnId = turn.id;

      const userMsg = el('div', 'wf-forge-msg user');
      userMsg.appendChild(el('span', 'wf-forge-msgrole', 'YOU'));
      userMsg.append(document.createTextNode(turn.user));
      wrap.appendChild(userMsg);

      if (turn.pending) {
        wrap.appendChild(el('div', 'wf-forge-msg agent pending', 'FORGING '));
      } else if (turn.agentText) {
        const agentMsg = el('div', 'wf-forge-msg agent');
        agentMsg.appendChild(el('span', 'wf-forge-msgrole', 'KIMI'));
        agentMsg.append(document.createTextNode(turn.agentText));
        wrap.appendChild(agentMsg);
      }

      if (turn.artifact) wrap.appendChild(renderCard(turn, turn.artifact));
      return wrap;
    }

    function rerenderTurn(turn: ChatTurn, oldEl: HTMLElement): void {
      oldEl.replaceWith(renderTurn(turn));
      scrollBottom();
    }

    function renderCard(turn: ChatTurn, item: ChatArtifact): HTMLElement {
      const card = el('div', 'wf-forge-card');
      card.dataset.forgeId = item.id;

      const head = el('div', 'wf-forge-cardhead');
      head.append(el('span', 'wf-forge-cardtitle', item.title), el('span', 'wf-forge-badge', 'PREVIEW'));
      const del = el('button', 'wf-forge-del', '✕');
      del.title = '删除此组件';
      del.addEventListener('click', () => {
        delete turn.artifact;
        persist();
        const turnEl = list.querySelector(`[data-turn-id="${turn.id}"]`);
        if (turnEl) rerenderTurn(turn, turnEl as HTMLElement);
      });
      head.appendChild(del);
      card.appendChild(head);

      const danger = scanDanger(item.html);
      if (danger.length > 0) {
        card.appendChild(el('div', 'wf-forge-warn', `⚠ 检测到高危调用：${danger.join('、')}（已放行运行，请留意来源）`));
      }

      const preview = el('div', 'wf-forge-preview');
      mountArtifact(preview, item.html);
      card.appendChild(preview);

      const foot = el('div', 'wf-forge-cardfoot');
      const saveBtn = el('button', 'wf-forge-btn', item.saved ? '已入库' : '✓ 确认入库');
      if (item.saved) {
        saveBtn.classList.add('saved');
        saveBtn.disabled = true;
      }
      saveBtn.addEventListener('click', () => {
        void (async () => {
          saveBtn.disabled = true;
          try {
            await ctx.api.libraryAdd({ id: item.id, title: item.title, html: item.html, createdAt: Date.now() });
            item.saved = true;
            persist();
            saveBtn.textContent = '已入库';
            saveBtn.classList.add('saved');
          } catch {
            saveBtn.disabled = false;
          }
        })();
      });
      foot.appendChild(saveBtn);
      card.appendChild(foot);

      return card;
    }

    /* ---------- library pane ---------- */

    function fmtTime(ts: number): string {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    async function renderLibrary(): Promise<void> {
      libList.innerHTML = '';
      libList.appendChild(el('div', 'wf-forge-empty', 'LOADING …'));
      let items: LibraryItem[] = [];
      try {
        items = await ctx.api.libraryList();
      } catch {
        items = [];
      }
      libList.innerHTML = '';
      if (items.length === 0) {
        libList.appendChild(el('div', 'wf-forge-empty', '组件库为空——在工坊生成组件后点「✓ 确认入库」'));
        return;
      }
      for (const item of items) {
        const row = el('div', 'wf-forge-librow');
        const meta = el('div', 'wf-forge-libmeta');
        meta.append(el('span', 'wf-forge-libtitle', item.title), el('span', 'wf-forge-libtime', fmtTime(item.createdAt)));
        const stageBtn = el('button', 'wf-forge-btn', '添加到舞台');
        stageBtn.addEventListener('click', () => {
          addWidget('artifact', { libraryId: item.id, title: item.title, html: item.html });
        });
        const delBtn = el('button', 'wf-forge-btn', '删除');
        delBtn.addEventListener('click', () => {
          void (async () => {
            delBtn.disabled = true;
            try {
              await ctx.api.libraryDelete(item.id);
            } catch {
              /* 忽略，本地仍会刷新 */
            }
            await renderLibrary();
          })();
        });
        row.append(meta, stageBtn, delBtn);
        libList.appendChild(row);
      }
    }

    /* ---------- tabs ---------- */

    tabForge.addEventListener('click', () => {
      tabForge.classList.add('on');
      tabLib.classList.remove('on');
      paneForge.hidden = false;
      paneLib.hidden = true;
    });
    tabLib.addEventListener('click', () => {
      tabLib.classList.add('on');
      tabForge.classList.remove('on');
      paneLib.hidden = false;
      paneForge.hidden = true;
      void renderLibrary();
    });

    /* ---------- Forge Mode overlay (PRD §3.8.2) ---------- */

    const PSEUDO_LINES = [
      '▸ resolve layout: stage grid',
      '▸ bind theme → neon-dark-hud',
      '▸ compile component tree',
      '▸ link event handlers',
      '▸ inject reactive state',
      '▸ mount(root) … ok',
    ];

    function setStatus(overlay: HTMLElement, text: string, kind: '' | 'ok' | 'err' = ''): void {
      const s = overlay.querySelector('.wf-forge-status');
      if (!s) return;
      s.textContent = text;
      s.className = `wf-forge-status${kind ? ` ${kind}` : ''}`;
    }

    /** 阶段 1：打字机回显需求 */
    async function phaseTypewriter(echo: HTMLElement, text: string): Promise<void> {
      const perChar = Math.max(18, Math.min(45, Math.floor(1400 / Math.max(text.length, 1))));
      for (let i = 1; i <= text.length; i++) {
        echo.textContent = `> ${text.slice(0, i)}`;
        await wait(perChar);
      }
      await wait(300);
    }

    /** 阶段 2：虚线框四边逐边亮起 + 伪代码滚动 */
    async function phaseEdges(frame: HTMLElement): Promise<void> {
      frame.classList.add('on');
      const pseudo = frame.querySelector('.wf-forge-pseudo');
      let li = 0;
      const timer = setInterval(() => {
        if (!pseudo) return;
        pseudo.appendChild(el('div', '', PSEUDO_LINES[li % PSEUDO_LINES.length]));
        li++;
        while (pseudo.childElementCount > 5) pseudo.firstElementChild?.remove();
      }, 160);
      for (const edge of ['t', 'r', 'b', 'l']) {
        frame.querySelector(`.wf-forge-edge.${edge}`)?.classList.add('lit');
        await wait(320);
      }
      clearInterval(timer);
      pseudo?.replaceChildren();
    }

    /** 阶段 3：扫描线填充（持续到生成返回，至少 1.2s） */
    function startScan(frame: HTMLElement): void {
      frame.classList.add('scanning', 'hot');
    }
    function stopScan(frame: HTMLElement): void {
      frame.classList.remove('scanning', 'hot');
    }

    /** 阶段 5：卡片弹射落位——frame 飞向消息流中的占位槽 */
    async function phaseEject(overlay: HTMLElement, frame: HTMLElement, slot: HTMLElement): Promise<void> {
      const fr = frame.getBoundingClientRect();
      const tr = slot.getBoundingClientRect();
      const dx = tr.left + tr.width / 2 - (fr.left + fr.width / 2);
      const dy = tr.top + tr.height / 2 - (fr.top + fr.height / 2);
      const sx = tr.width / Math.max(fr.width, 1);
      const sy = tr.height / Math.max(fr.height, 1);
      const anim = frame.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.35 - 26}px) scale(${(sx + 1) / 2}, ${(sy + 1) / 2})`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.25 },
        ],
        { duration: 560, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' },
      );
      await anim.finished.catch(() => undefined);
    }

    function buildOverlay(): { overlay: HTMLElement; echo: HTMLElement; frame: HTMLElement } {
      const overlay = el('div', 'wf-forge-overlay');
      overlay.appendChild(el('div', 'wf-forge-grid'));
      const stage = el('div', 'wf-forge-stage');
      const echo = el('div', 'wf-forge-echo');
      const frame = el('div', 'wf-forge-frame');
      frame.append(
        el('div', 'wf-forge-pseudo'),
        el('div', 'wf-forge-scanline'),
        el('div', 'wf-forge-flash'),
        el('div', 'wf-forge-edge t'),
        el('div', 'wf-forge-edge r'),
        el('div', 'wf-forge-edge b'),
        el('div', 'wf-forge-edge l'),
      );
      stage.append(echo, frame);
      overlay.append(stage, el('div', 'wf-forge-status', 'ANALYZING'));
      root.appendChild(overlay);
      return { overlay, echo, frame };
    }

    /* ---------- generation flow ---------- */

    async function generate(): Promise<void> {
      const requirement = input.value.trim();
      if (!requirement || state.generating) return;
      state.generating = true;
      genBtn.disabled = true;
      input.value = '';

      // 追加一轮对话：用户消息立即上屏，agent 消息挂 pending
      const latest = latestArtifact();
      const turn: ChatTurn = { id: newId(), user: requirement, agentText: '', pending: true };
      state.turns.push(turn);
      const empty = list.querySelector('.wf-forge-empty');
      if (empty) empty.remove();
      const turnEl = renderTurn(turn);
      list.appendChild(turnEl);
      scrollBottom();

      const { overlay, echo, frame } = buildOverlay();
      try {
        const genPromise = ctx.api.forgeGenerate(
          latest ? buildTweakPrompt(latest.html, requirement) : buildGenPrompt(requirement),
        );

        setStatus(overlay, 'ANALYZING');
        await phaseTypewriter(echo, requirement);
        echo.textContent = `> ${requirement}`;

        setStatus(overlay, latest ? 'ITERATING' : 'GENERATING');
        await phaseEdges(frame);

        setStatus(overlay, 'COMPILING');
        startScan(frame);
        const minScan = wait(1200);
        const text = await genPromise;
        await minScan;
        stopScan(frame);

        turn.pending = false;
        turn.agentText = extractAgentText(text);
        const html = extractHtml(text);
        if (!html) {
          // 无代码产出：说明文字就是答复（可能是拒绝/报错原因），直接展示
          if (!turn.agentText) turn.agentText = 'Kimi 未返回可用 HTML，请换个描述重试。';
          persist();
          setStatus(overlay, 'NO BUILD — 见回复', 'err');
          await wait(1000);
          overlay.remove();
          rerenderTurn(turn, turnEl);
          return;
        }
        if (!turn.agentText) turn.agentText = '组件已生成，见下方预览。';

        // 阶段 4：白色脉冲 + BUILD SUCCESSFUL
        frame.classList.add('pulse');
        setStatus(overlay, 'BUILD SUCCESSFUL', 'ok');
        await wait(650);

        turn.artifact = { id: newId(), title: extractTitle(html, requirement), html, saved: false };
        persist();

        // 阶段 5：弹射落位到该轮消息下方的占位槽
        const slot = el('div', 'wf-forge-card');
        slot.style.minHeight = '120px';
        turnEl.appendChild(slot);
        scrollBottom();
        await phaseEject(overlay, frame, slot);
        overlay.remove();
        const card = renderCard(turn, turn.artifact);
        card.classList.add('land');
        slot.replaceWith(card);
        scrollBottom();
      } catch (err) {
        turn.pending = false;
        if (!turn.agentText) turn.agentText = `⚠ 生成失败：${err instanceof Error ? err.message : String(err)}`;
        persist();
        setStatus(overlay, 'BUILD FAILED — 请重试', 'err');
        await wait(1600);
        overlay.remove();
        if (turnEl.isConnected) rerenderTurn(turn, turnEl);
      } finally {
        state.generating = false;
        genBtn.disabled = false;
      }
    }

    genBtn.addEventListener('click', () => void generate());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void generate();
      e.stopPropagation();
    });

    renderTurns();
    scrollBottom();
  },
});
