import { registerWidget } from '../core/registry';

/**
 * Generic artifact widget: renders a Forge-generated HTML artifact on the stage.
 * config: { title: string, html: string }
 */

/**
 * Scoped `document` for generated scripts. getElementById only searches inside
 * the artifact host: the same artifact can be mounted several times at once
 * (Forge preview card + stage widget, or multiple stage widgets), and duplicate
 * ids would otherwise make every script bind to the first match in the document.
 * DOMContentLoaded listeners run immediately — that event fired long before
 * injection time, so a real listener would never run.
 */
function scopedDocument(host: HTMLElement): Document {
  return new Proxy(document, {
    get(target, prop) {
      if (prop === 'getElementById') {
        return (id: string) => host.querySelector(`#${CSS.escape(id)}`);
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

/** innerHTML doesn't execute <script> — recreate them, with document scoped to the host */
export function mountArtifact(host: HTMLElement, html: string): void {
  host.innerHTML = html;
  const w = window as unknown as Record<string, unknown>;
  w.__artifactDoc = scopedDocument(host);
  for (const old of Array.from(host.querySelectorAll('script'))) {
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
registerWidget({
  def: {
    id: 'artifact',
    name: '自定义组件',
    icon: '◈',
    description: 'Forge 生成的组件实例',
    category: 'ai',
    defaultSize: { w: 9, h: 8 },
    minSize: { w: 6, h: 5 },
  },
  mount(body, ctx) {
    const title = typeof ctx.config.title === 'string' ? ctx.config.title : 'artifact';
    const html = typeof ctx.config.html === 'string' ? ctx.config.html : '';
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:1px;color:var(--muted);padding-bottom:8px;text-transform:uppercase;';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;';
    label.textContent = title;
    label.title = '双击改名';
    // double-click to rename (persists to config, reflected in the widget frame title)
    label.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.value = String(ctx.config.title ?? '');
      input.style.cssText =
        'font:inherit;background:var(--bg);color:var(--neon);border:1px solid var(--border-strong);border-radius:4px;padding:1px 6px;width:70%;outline:none;';
      const commit = () => {
        const v = input.value.trim();
        if (v) {
          ctx.setConfig({ title: v });
          label.textContent = v;
          ctx.bus.emit('widget:renamed', { instanceId: ctx.instanceId, title: v });
        } else {
          label.textContent = String(ctx.config.title ?? 'artifact');
        }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          input.value = '';
          input.blur();
        }
      });
      label.textContent = '';
      label.appendChild(input);
      input.focus();
      input.select();
    });
    const host = document.createElement('div');
    host.style.cssText = 'flex:1;min-height:0;overflow:auto;';
    // manual refresh fallback: pull the latest html from the library by matching config
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '⟳';
    refreshBtn.title = '从组件库刷新';
    refreshBtn.style.cssText =
      'background:none;border:1px solid var(--border);border-radius:4px;color:var(--muted);font:inherit;cursor:pointer;padding:0 5px;line-height:1.4;';
    refreshBtn.addEventListener('mouseenter', () => {
      refreshBtn.style.color = 'var(--neon)';
      refreshBtn.style.borderColor = 'var(--border-strong)';
    });
    refreshBtn.addEventListener('mouseleave', () => {
      refreshBtn.style.color = 'var(--muted)';
      refreshBtn.style.borderColor = 'var(--border)';
    });
    const remount = (newHtml: string) => {
      host.innerHTML = '';
      mountArtifact(host, newHtml);
    };
    // a pushed library item belongs to this instance when config.libraryId matches
    // its id, otherwise fall back to matching the current title
    const matches = (item: { id: string; title: string }) =>
      typeof ctx.config.libraryId === 'string'
        ? ctx.config.libraryId === item.id
        : item.title === String(ctx.config.title ?? '');
    refreshBtn.addEventListener('click', () => {
      void (async () => {
        refreshBtn.disabled = true;
        try {
          const items = await window.kimi.wb.libraryList();
          const found = items.find(matches);
          if (found) {
            ctx.setConfig({ html: found.html });
            remount(found.html);
          }
        } catch {
          /* keep showing the stale copy */
        } finally {
          refreshBtn.disabled = false;
        }
      })();
    });
    header.append(label, refreshBtn);
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.append(header, host);
    mountArtifact(host, html);
    // auto-refresh when artifact_modify updates this artifact in the library
    window.kimi.onArtifactUpdated((item) => {
      if (!matches(item)) return;
      ctx.setConfig({ html: item.html });
      remount(item.html);
    });
  },
});
