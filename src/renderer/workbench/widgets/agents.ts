import { registerWidget } from '../core/registry';

/* ============================================================
   agents widget — AGENTS.md 编辑器（左编辑 / 右实时预览）
   - 内容: ctx.api.agentsRead() / agentsWrite(content)
   - managed 标记区高亮 + 提示
   ============================================================ */

const CSS = `
.wf-agents-root { display: flex; flex-direction: column; height: 100%; gap: 8px; }
.wf-agents-toolbar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.wf-agents-save {
  border: 1px solid var(--border-strong); background: rgba(0, 240, 255, 0.08);
  color: var(--neon); font-family: var(--mono); font-size: 11px;
  padding: 5px 14px; border-radius: 6px; cursor: pointer;
  transition: all 160ms var(--ease-in);
}
.wf-agents-save:hover { box-shadow: 0 0 12px rgba(0, 240, 255, 0.25); background: rgba(0, 240, 255, 0.15); }
.wf-agents-save:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
.wf-agents-hint { font-size: 11px; color: var(--disabled); }
.wf-agents-status { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.wf-agents-status.ok { color: var(--green); text-shadow: 0 0 8px rgba(0, 255, 136, 0.4); }
.wf-agents-status.err { color: var(--error); }
.wf-agents-status.dirty { color: var(--warn); }
.wf-agents-managed-note {
  flex-shrink: 0; font-size: 11px; color: var(--warn);
  border: 1px solid rgba(255, 170, 0, 0.3); background: rgba(255, 170, 0, 0.06);
  border-radius: 6px; padding: 4px 10px;
  font-family: var(--mono);
}
.wf-agents-main { flex: 1; display: flex; gap: 8px; min-height: 0; }
.wf-agents-root.wf-agents-narrow .wf-agents-main { flex-direction: column; }
.wf-agents-pane {
  flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
  background: rgba(255, 255, 255, 0.02);
}
.wf-agents-pane-title {
  flex-shrink: 0; padding: 5px 12px; font-family: var(--mono); font-size: 10px;
  letter-spacing: 1.5px; color: var(--muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.wf-agents-editor-wrap { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.wf-agents-highlight, .wf-agents-editor {
  position: absolute; inset: 0; margin: 0; border: none;
  padding: 10px 12px;
  font-family: var(--mono); font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: break-word; tab-size: 2;
}
.wf-agents-highlight { overflow: hidden; pointer-events: none; color: var(--fg); }
.wf-agents-hl { background: rgba(255, 170, 0, 0.10); outline: 1px solid rgba(255, 170, 0, 0.12); }
.wf-agents-editor {
  overflow: auto; resize: none; outline: none;
  background: transparent; color: transparent; caret-color: var(--neon);
}
.wf-agents-editor::selection { background: rgba(0, 240, 255, 0.25); color: transparent; }
.wf-agents-editor::-webkit-scrollbar { width: 6px; }
.wf-agents-editor::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.wf-agents-preview { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px; font-size: 12.5px; line-height: 1.65; color: var(--fg); }
.wf-agents-preview::-webkit-scrollbar { width: 6px; }
.wf-agents-preview::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
.wf-agents-preview h1, .wf-agents-preview h2, .wf-agents-preview h3,
.wf-agents-preview h4, .wf-agents-preview h5, .wf-agents-preview h6 {
  margin: 0.7em 0 0.35em; color: var(--neon); font-weight: 600; line-height: 1.3;
}
.wf-agents-preview h1 { font-size: 18px; } .wf-agents-preview h2 { font-size: 15px; }
.wf-agents-preview h3 { font-size: 13.5px; } .wf-agents-preview h4,
.wf-agents-preview h5, .wf-agents-preview h6 { font-size: 12.5px; color: var(--fg); }
.wf-agents-preview p { margin: 0.4em 0; }
.wf-agents-preview pre {
  margin: 0.5em 0; padding: 8px 10px; overflow-x: auto;
  background: rgba(0, 0, 0, 0.35); border: 1px solid var(--border); border-radius: 6px;
  font-family: var(--mono); font-size: 11.5px;
}
.wf-agents-preview code { font-family: var(--mono); font-size: 0.92em; background: rgba(0, 240, 255, 0.08); border-radius: 4px; padding: 1px 5px; }
.wf-agents-preview pre code { background: none; padding: 0; }
.wf-agents-preview a { color: var(--neon); text-decoration: none; border-bottom: 1px dotted var(--border-strong); }
.wf-agents-preview ul, .wf-agents-preview ol { margin: 0.35em 0; padding-left: 22px; }
.wf-agents-preview li { margin: 2px 0; }
.wf-agents-preview blockquote {
  margin: 0.5em 0; padding: 2px 12px; color: var(--muted);
  border-left: 2px solid var(--border-strong);
}
.wf-agents-preview hr { border: none; border-top: 1px solid var(--border); margin: 0.8em 0; }
.wf-agents-preview strong { color: #fff; }
.wf-agents-managed {
  margin: 4px 0; padding: 4px 10px;
  background: rgba(255, 170, 0, 0.06);
  border-left: 2px solid var(--warn); border-radius: 0 6px 6px 0;
}
`;

let styleInjected = false;
function ensureStyle(): void {
  if (styleInjected) return;
  const el = document.createElement('style');
  el.textContent = CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---- 简洁 md → html（转义安全：先提取代码块，再整体 escape，再做行内替换） ---- */

function inlineMd(escaped: string): string {
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\x00C${codes.length - 1}\x00`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-wf-link>$1</a>');
  return s.replace(/\x00C(\d+)\x00/g, (_m, i: string) => codes[+i]);
}

/** 按 managed 标记行切分，返回分段（标记行本身不进预览） */
function splitManaged(text: string): { managed: boolean; text: string }[] {
  const parts: { managed: boolean; text: string }[] = [];
  let cur: string[] = [];
  let managed = false;
  const push = () => {
    if (cur.length) parts.push({ managed, text: cur.join('\n') });
    cur = [];
  };
  for (const line of text.split('\n')) {
    if (/<!--\s*kimi-float:managed:start\s*-->/.test(line)) { push(); managed = true; continue; }
    if (/<!--\s*kimi-float:managed:end\s*-->/.test(line)) { push(); managed = false; continue; }
    cur.push(line);
  }
  push();
  return parts;
}

/** 渲染单段 markdown（不含代码块，代码块已替换为 \x00BN\x00 哨兵） */
function renderBlocks(src: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let listItems: string[] = [];
  let listTag = '';
  let quote: string[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (listItems.length) { out.push(`<${listTag}>${listItems.join('')}</${listTag}>`); listItems = []; listTag = ''; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of escapeHtml(src).split('\n')) {
    const trimmed = line.trim();
    if (/^\x00B\d+\x00$/.test(trimmed)) { flushAll(); out.push(trimmed); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); const n = h[1].length; out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); flushQuote(); if (listTag !== 'ul') { flushList(); listTag = 'ul'; } listItems.push(`<li>${inlineMd(ul[1])}</li>`); continue; }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) { flushPara(); flushQuote(); if (listTag !== 'ol') { flushList(); listTag = 'ol'; } listItems.push(`<li>${inlineMd(ol[1])}</li>`); continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(inlineMd(q[1])); continue; }
    if (trimmed === '') { flushAll(); continue; }
    flushList(); flushQuote();
    para.push(inlineMd(line));
  }
  flushAll();
  return out.join('');
}

function mdToHtml(md: string): string {
  const blocks: string[] = [];
  const text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00B${blocks.length - 1}\x00`;
  });
  const html = splitManaged(text)
    .map((p) => (p.managed ? `<div class="wf-agents-managed">${renderBlocks(p.text)}</div>` : renderBlocks(p.text)))
    .join('');
  return html.replace(/\x00B(\d+)\x00/g, (_m, i: string) => blocks[+i]);
}

/** 每行是否处于 managed 区（含标记行本身），用于编辑器高亮 */
function managedLineFlags(src: string): boolean[] {
  let inside = false;
  return src.split('\n').map((line) => {
    if (/kimi-float:managed:start/.test(line)) { inside = true; return true; }
    if (/kimi-float:managed:end/.test(line)) { inside = false; return true; }
    return inside;
  });
}

registerWidget({
  def: {
    id: 'agents',
    name: 'Agents.md',
    icon: '✎',
    description: '编辑工作区 AGENTS.md（个人区域），新会话生效',
    category: 'system',
    defaultSize: { w: 12, h: 10 },
    minSize: { w: 8, h: 6 },
  },
  mount(body, ctx) {
    ensureStyle();
    body.innerHTML = `
      <div class="wf-agents-root">
        <div class="wf-agents-toolbar">
          <button class="wf-agents-save" type="button">保存</button>
          <span class="wf-agents-hint">新会话生效 · ⌘S</span>
          <span class="wf-agents-status">加载中…</span>
        </div>
        <div class="wf-agents-managed-note hidden">⚠ 高亮区由应用管理（kimi-float:managed），手动修改可能被覆盖</div>
        <div class="wf-agents-main">
          <div class="wf-agents-pane">
            <div class="wf-agents-pane-title">EDIT</div>
            <div class="wf-agents-editor-wrap">
              <div class="wf-agents-highlight" aria-hidden="true"></div>
              <textarea class="wf-agents-editor" spellcheck="false" wrap="soft"></textarea>
            </div>
          </div>
          <div class="wf-agents-pane">
            <div class="wf-agents-pane-title">PREVIEW</div>
            <div class="wf-agents-preview"></div>
          </div>
        </div>
      </div>`;

    const root = body.querySelector<HTMLElement>('.wf-agents-root')!;
    const saveBtn = body.querySelector<HTMLButtonElement>('.wf-agents-save')!;
    const statusEl = body.querySelector<HTMLElement>('.wf-agents-status')!;
    const noteEl = body.querySelector<HTMLElement>('.wf-agents-managed-note')!;
    const ta = body.querySelector<HTMLTextAreaElement>('.wf-agents-editor')!;
    const hl = body.querySelector<HTMLElement>('.wf-agents-highlight')!;
    const preview = body.querySelector<HTMLElement>('.wf-agents-preview')!;

    let dirty = false;
    let saving = false;
    let previewTimer = 0;

    const setStatus = (text: string, cls = '') => {
      statusEl.textContent = text;
      statusEl.className = `wf-agents-status${cls ? ` ${cls}` : ''}`;
    };

    const renderHighlight = () => {
      const src = ta.value;
      const flags = managedLineFlags(src);
      const html = src
        .split('\n')
        .map((line, i) => {
          const esc = escapeHtml(line);
          return flags[i] ? `<span class="wf-agents-hl">${esc || ' '}</span>` : esc;
        })
        .join('\n');
      hl.innerHTML = html + (src.endsWith('\n') ? ' ' : '');
      noteEl.classList.toggle('hidden', !flags.some(Boolean));
    };

    const renderPreview = () => {
      preview.innerHTML = mdToHtml(ta.value);
    };

    const refresh = () => {
      renderHighlight();
      window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(renderPreview, 200);
    };

    const save = async () => {
      if (saving) return;
      saving = true;
      saveBtn.disabled = true;
      setStatus('保存中…');
      try {
        await ctx.api.agentsWrite(ta.value);
        dirty = false;
        setStatus('已保存 ✓ 新会话生效', 'ok');
      } catch (e) {
        setStatus(`保存失败: ${e instanceof Error ? e.message : String(e)}`, 'err');
      } finally {
        saving = false;
        saveBtn.disabled = false;
      }
    };

    ta.addEventListener('input', () => {
      dirty = true;
      setStatus('未保存更改', 'dirty');
      refresh();
    });
    ta.addEventListener('scroll', () => {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    });
    saveBtn.addEventListener('click', () => void save());

    // 预览里的链接交给系统浏览器打开
    preview.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-wf-link]');
      if (!a) return;
      e.preventDefault();
      window.kimi.openExternal(a.href);
    });

    // 窄宽度时上下堆叠编辑/预览
    const ro = new ResizeObserver((entries) => {
      if (!body.isConnected) { ro.disconnect(); return; }
      const w = entries[0]?.contentRect.width ?? body.clientWidth;
      root.classList.toggle('wf-agents-narrow', w < 520);
    });
    ro.observe(body);

    // 初始加载
    ctx.api
      .agentsRead()
      .then((content) => {
        ta.value = content;
        dirty = false;
        setStatus('已加载');
        renderHighlight();
        renderPreview();
      })
      .catch((e) => {
        setStatus(`加载失败: ${e instanceof Error ? e.message : String(e)}`, 'err');
      });
  },
});
