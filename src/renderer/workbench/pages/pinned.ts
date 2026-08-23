/**
 * 钉组件页（V4-B）：导航轨钉住的组件打开为整页容器。
 * 内置 widget 直接 mount；artifact（组件库 / 预设）用与 widgets/artifact.ts
 * 相同的 scoped-document 注入逻辑渲染（复制实现，不 import widget 文件，
 * 避免拉入其 registerWidget 副作用之外的耦合）。
 * 页面隐藏只是 .page 显隐，DOM 常驻——artifact 的 setInterval 等由生成物自己管。
 */

import { bus } from '../core/bus';
import { getWidget, type WidgetContext } from '../core/registry';

export interface NavPin {
  id: string;
  title: string;
  /** 组件库条目 id（用户 artifact） */
  libraryId?: string;
  /** 内置 widget id；'artifact' + html 表示预设 artifact */
  widgetId?: string;
  /** 预设 artifact 的自包含 HTML（不入组件库） */
  html?: string;
}

export function pinPageId(pinId: string): string {
  return `page-pin-${pinId}`;
}

export function removePinPage(pinId: string): void {
  document.getElementById(pinPageId(pinId))?.remove();
}

// ---------- artifact 注入（同 widgets/artifact.ts 的 scopedDocument/mountArtifact） ----------

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
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mountArtifact(host: HTMLElement, html: string): void {
  host.innerHTML = html;
  const w = window as unknown as Record<string, unknown>;
  w.__artifactDoc = scopedDocument(host);
  for (const old of Array.from(host.querySelectorAll('script'))) {
    const s = document.createElement('script');
    for (const attr of Array.from(old.attributes)) s.setAttribute(attr.name, attr.value);
    s.textContent = `;(function (document) {\n${old.textContent ?? ''}\n})(window.__artifactDoc);`;
    old.replaceWith(s);
  }
  setTimeout(() => {
    delete w.__artifactDoc;
  }, 0);
}

// ---------- 页面挂载 ----------

function showNotice(body: HTMLElement, text: string): void {
  body.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'pin-notice';
  div.textContent = text;
  body.appendChild(div);
}

/** 创建钉组件页 DOM（调用方负责 append 到 #hud-body）。 */
export function mountPinPage(pin: NavPin, opts: { onClose(): void }): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page pin-page';
  page.id = pinPageId(pin.id);

  const frame = document.createElement('section');
  frame.className = 'widget pin-frame';

  const header = document.createElement('div');
  header.className = 'widget-header';
  const title = document.createElement('span');
  title.className = 'widget-title';
  const icon = pin.widgetId && pin.widgetId !== 'artifact' ? getWidget(pin.widgetId)?.def.icon ?? '◈' : '◈';
  title.textContent = `${icon} ${pin.title}`;
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-op';
  closeBtn.textContent = '×';
  closeBtn.title = '取消钉';
  closeBtn.onclick = opts.onClose;
  header.append(title, spacer, closeBtn);

  const body = document.createElement('div');
  body.className = 'widget-body';

  frame.append(header, body);
  page.appendChild(frame);

  if (pin.widgetId && pin.widgetId !== 'artifact') {
    // 内置 widget 直接 mount
    const w = getWidget(pin.widgetId);
    if (!w) {
      showNotice(body, `内置组件「${pin.widgetId}」不存在`);
    } else {
      const ctx: WidgetContext = {
        instanceId: `pin-${pin.id}`,
        config: {},
        setConfig: () => undefined, // 钉页不持久化 overlay 配置
        bus,
        api: window.kimi.wb,
        requestMinimize: () => undefined,
        requestClose: opts.onClose,
      };
      try {
        w.mount(body, ctx);
      } catch (err) {
        showNotice(body, `⚠ 组件挂载失败：${String(err).slice(0, 120)}`);
        console.error(`[workbench] pinned widget ${pin.widgetId} mount failed:`, err);
      }
    }
  } else if (pin.libraryId) {
    // 组件库 artifact：激活时取最新 html（rename/修改后内容保持新鲜）
    body.textContent = '载入中…';
    void window.kimi.wb
      .libraryList()
      .then((items) => {
        const found = items.find((i) => i.id === pin.libraryId);
        if (found) mountArtifact(body, found.html);
        else showNotice(body, '组件已从组件库删除');
      })
      .catch(() => showNotice(body, '组件库读取失败'));
  } else if (typeof pin.html === 'string') {
    mountArtifact(body, pin.html);
  } else {
    showNotice(body, '组件内容缺失');
  }

  return page;
}
