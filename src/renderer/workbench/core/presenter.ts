import type { PresentSpec } from '../../api';
import { addWidget } from './layout';
import { mountZenFloat, type ZenFloatHandle } from '../pages/zen';
import { mountArtifact } from '../widgets/artifact';

/**
 * Generative Presentation 渲染层（design-v4 §12）。
 * 收到 PresentSpec 先落等待态占位（虚线玻璃框 + 框内霓虹扫描线 + COMPOSING…），
 * 下一帧原地替换为正式内容；渲染失败占位变红显示原因，8s 后自动关闭不残留。
 * 模板是 header / media / list / body / actions 五原语的组合，kind 只是预设；
 * 未知 kind 降级为 list 模板。item 字段除 title 外全部 optional，缺失优雅降级。
 */

type PresentItem = NonNullable<PresentSpec['items']>[number];

const MAX_VISIBLE = 7; // 一屏最多 7 条（米勒定律），超出折叠「还有 N 条」
const GALLERY_MAX = 6; // 图片网格一屏 3 列 × 2 行，溢出降级进列表区

const KIND_LABEL: Record<string, string> = {
  'news-digest': 'NEWS DIGEST',
  'data-card': 'DATA CARD',
  gallery: 'GALLERY',
  list: 'LIST',
};

export function initPresenter(): void {
  window.kimi.onPresentArtifact((spec) => presentArtifact(spec));
}

function presentArtifact(spec: PresentSpec): void {
  let handle: ZenFloatHandle | null = null;
  handle = mountZenFloat('生成中', (body) => {
    showPending(body);
    // 占位先绘一帧，再原地替换为正式内容（custom 路径同样先走等待态）
    requestAnimationFrame(() => {
      try {
        body.innerHTML = '';
        if (spec.kind === 'custom') {
          if (!spec.html) throw new Error('kind=custom 缺少 html');
          mountArtifact(body, spec.html);
        } else {
          body.appendChild(renderSpec(spec, () => handle?.close()));
        }
        handle?.setTitle(spec.title || '呈现');
      } catch (err) {
        showError(body, err, () => handle?.close());
      }
    });
  });
}

// ---------- 等待态 / 失败态 ----------

function showPending(body: HTMLElement): void {
  const box = h('div', 'pv-pending');
  box.append(h('div', 'pv-pending-scan'), h('div', 'pv-pending-status', 'COMPOSING…'));
  body.appendChild(box);
}

function showError(body: HTMLElement, err: unknown, close: () => void): void {
  body.innerHTML = '';
  const box = h('div', 'pv-pending pv-error');
  box.append(h('div', 'pv-pending-status', `✗ 渲染失败：${String(err).slice(0, 120)}`));
  body.appendChild(box);
  setTimeout(close, 8000);
}

// ---------- 模板组合（原语：header / media / list / body / actions） ----------

function renderSpec(spec: PresentSpec, close: () => void): HTMLElement {
  const items = spec.items ?? [];
  const root = h('div', 'pv-root');
  root.appendChild(pvHeader(spec.kind, items.length));
  switch (spec.kind) {
    case 'news-digest':
      root.appendChild(pvList(items, true));
      break;
    case 'data-card': {
      // 有 summary 的进指标网格（title=指标名 / summary=数值 / tag=副标），其余降级列表
      const metrics = items.filter((i) => i.summary);
      const rest = items.filter((i) => !i.summary);
      if (metrics.length) root.appendChild(pvMetrics(metrics));
      if (rest.length) root.appendChild(pvList(rest, false));
      break;
    }
    case 'gallery': {
      // image 必填才进网格；无图条目 + 网格溢出降级进列表区
      const withImg = items.filter((i) => i.image);
      const rest = [...withImg.slice(GALLERY_MAX), ...items.filter((i) => !i.image)];
      if (withImg.length) root.appendChild(pvGallery(withImg.slice(0, GALLERY_MAX)));
      if (rest.length) root.appendChild(pvList(rest, false));
      break;
    }
    default:
      // list + 未知 kind 降级
      root.appendChild(pvList(items, false));
  }
  const actions = pvActions(spec.actions, close);
  if (actions) root.appendChild(actions);
  return root;
}

function pvHeader(kind: string, count: number): HTMLElement {
  const head = h('div', 'pv-head');
  head.append(h('span', 'pv-kind', KIND_LABEL[kind] ?? 'LIST'), h('span', 'pv-count', `${count} 条`));
  return head;
}

function pvList(items: PresentItem[], thumbs: boolean): HTMLElement {
  const list = h('div', 'pv-list');
  if (items.length === 0) {
    list.appendChild(h('div', 'pv-empty', '暂无条目'));
    return list;
  }
  for (const item of items.slice(0, MAX_VISIBLE)) list.appendChild(pvItem(item, thumbs));
  const rest = items.slice(MAX_VISIBLE);
  if (rest.length) {
    const more = h('button', 'pv-more', `还有 ${rest.length} 条 ›`);
    more.addEventListener('click', () => {
      for (const item of rest) list.appendChild(pvItem(item, thumbs));
      more.remove();
    });
    list.appendChild(more);
  }
  return list;
}

function pvItem(item: PresentItem, thumb: boolean): HTMLElement {
  const row = h('div', 'pv-item');
  const main = h('div', 'pv-item-main');
  main.appendChild(h('div', 'pv-item-title', item.title));
  if (item.summary) main.appendChild(h('div', 'pv-item-summary', item.summary));
  const meta = h('div', 'pv-item-meta');
  if (item.tag) meta.appendChild(h('span', 'pv-tag', item.tag));
  if (item.url) {
    const url = item.url;
    const link = h('span', 'pv-url', hostOf(url));
    link.title = url; // hover 显示完整 URL（含域名）
    link.addEventListener('click', () => window.kimi.openExternal(url));
    meta.appendChild(link);
  }
  if (meta.childElementCount) main.appendChild(meta);
  row.appendChild(main);
  if (thumb && item.image) {
    const img = document.createElement('img');
    img.className = 'pv-thumb';
    img.src = item.image;
    img.addEventListener('error', () => img.remove()); // 加载失败隐藏
    row.appendChild(img);
  }
  return row;
}

function pvMetrics(items: PresentItem[]): HTMLElement {
  const grid = h('div', 'pv-metrics');
  for (const item of items) {
    const card = h('div', 'pv-metric');
    card.append(h('div', 'pv-metric-value', item.summary ?? '—'), h('div', 'pv-metric-name', item.title));
    if (item.tag) card.appendChild(h('div', 'pv-metric-tag', item.tag));
    grid.appendChild(card);
  }
  return grid;
}

function pvGallery(items: PresentItem[]): HTMLElement {
  const grid = h('div', 'pv-grid');
  for (const item of items) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = item.image ?? '';
    img.alt = item.title;
    img.addEventListener('error', () => {
      // 占位色块（不发灰图）
      img.replaceWith(h('div', 'pv-img-fallback', item.title.slice(0, 1) || '·'));
    });
    const cap = document.createElement('figcaption');
    cap.textContent = item.title;
    fig.append(img, cap);
    grid.appendChild(fig);
  }
  return grid;
}

function pvActions(actions: PresentSpec['actions'], close: () => void): HTMLElement | null {
  if (!actions?.length) return null;
  const row = h('div', 'pv-actions');
  for (const a of actions) {
    const act = a.action;
    let onClick: (() => void) | null = null;
    if (act === 'dismiss') {
      onClick = close;
    } else if (act.startsWith('open-widget:')) {
      const id = act.slice('open-widget:'.length);
      onClick = () => addWidget(id);
    } else if (act.startsWith('openExternal:')) {
      const url = act.slice('openExternal:'.length);
      onClick = () => window.kimi.openExternal(url);
    } else if (/^https?:\/\//.test(act)) {
      onClick = () => window.kimi.openExternal(act);
    }
    if (!onClick) continue; // 其他文本动作忽略
    const btn = h('button', '', a.label);
    btn.addEventListener('click', onClick);
    row.appendChild(btn);
  }
  return row.childElementCount ? row : null;
}

// ---------- 小工具 ----------

function h(tag: string, cls: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
