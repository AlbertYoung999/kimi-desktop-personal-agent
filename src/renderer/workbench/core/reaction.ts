/**
 * Reaction Card（V4-C 统一反应组件）。
 * 主进程通过 window.kimi.onReactionCard 推送卡片，右下角（toast 上方）浮出玻璃拟态卡片，
 * kind 决定边框霓虹色；动作分发：'open-widget:<id>' → addWidget + 切到 Dashboard 页，
 * 'dismiss' → 关闭卡片。10s 自动关闭，最多堆叠 3 张，超出丢最旧。
 */

import type { ReactionCard } from '../../api';
import { addWidget } from './layout';
import { activatePage } from './nav';

const MAX_CARDS = 3;
const AUTO_CLOSE_MS = 10_000;

const KIND_COLOR: Record<ReactionCard['kind'], string> = {
  info: 'var(--neon)',
  success: 'var(--green)',
  warn: 'var(--warn)',
};

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container?.isConnected) return container;
  container = document.createElement('div');
  container.id = 'wb-reactions';
  document.body.appendChild(container);
  return container;
}

function injectStyle(): void {
  if (document.getElementById('wb-reaction-style')) return;
  const style = document.createElement('style');
  style.id = 'wb-reaction-style';
  style.textContent = `
    #wb-reactions {
      position: fixed; right: 14px; bottom: 112px; z-index: 390;
      display: flex; flex-direction: column; gap: 10px; width: 300px;
      pointer-events: none;
    }
    .wb-reaction {
      pointer-events: auto; position: relative;
      background: rgba(16, 20, 30, 0.72);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--border-strong); border-left: 3px solid var(--neon);
      border-radius: 10px; padding: 11px 13px 10px;
      color: var(--fg); box-shadow: 0 10px 32px rgba(0,0,0,0.55);
      animation: wbReactionIn 240ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .wb-reaction-title {
      font-family: var(--mono); font-size: 11.5px; font-weight: 700;
      letter-spacing: 1px; text-transform: uppercase; padding-right: 20px;
    }
    .wb-reaction-body { font-size: 11.5px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
    .wb-reaction-actions { display: flex; gap: 8px; margin-top: 9px; }
    .wb-reaction-btn {
      font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.5px;
      padding: 4px 12px; border-radius: 6px; cursor: pointer;
      border: 1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--muted);
      transition: all 160ms var(--ease-in);
    }
    .wb-reaction-btn:hover { color: var(--neon); border-color: var(--border-strong); box-shadow: 0 0 10px rgba(0,240,255,0.15); }
    .wb-reaction-close {
      position: absolute; top: 7px; right: 9px;
      border: none; background: none; color: var(--disabled);
      font-size: 13px; cursor: pointer; padding: 0 2px; line-height: 1;
      transition: color 160ms var(--ease-in);
    }
    .wb-reaction-close:hover { color: var(--fg); }
    .wb-reaction.leaving { opacity: 0; transform: translateX(14px); transition: all 220ms; }
    @keyframes wbReactionIn { from { transform: translateX(24px); opacity: 0; } }
  `;
  document.head.appendChild(style);
}

/** 动作分发：open-widget 打开组件并切到 Dashboard；dismiss / 未知动作只关卡片。 */
function dispatchAction(action: string): void {
  if (action.startsWith('open-widget:')) {
    const widgetId = action.slice('open-widget:'.length);
    if (widgetId) {
      addWidget(widgetId);
      activatePage('page-dashboard');
    }
  }
  // 'dismiss' 及其他未知动作：无需额外处理，卡片由调用方关闭
}

function showCard(card: ReactionCard): void {
  const box = ensureContainer();
  // 最多堆叠 3 张，超出丢最旧
  while (box.children.length >= MAX_CARDS) box.firstElementChild?.remove();

  const el = document.createElement('div');
  el.className = 'wb-reaction';
  el.style.borderLeftColor = KIND_COLOR[card.kind] ?? KIND_COLOR.info;
  el.dataset.reactionId = card.id;

  let closed = false;
  let timer = 0;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  };

  const close = document.createElement('button');
  close.className = 'wb-reaction-close';
  close.textContent = '×';
  close.title = '关闭';
  close.onclick = dismiss;

  const title = document.createElement('div');
  title.className = 'wb-reaction-title';
  title.style.color = KIND_COLOR[card.kind] ?? KIND_COLOR.info;
  title.textContent = card.title;

  el.append(close, title);

  if (card.body) {
    const body = document.createElement('div');
    body.className = 'wb-reaction-body';
    body.textContent = card.body;
    el.appendChild(body);
  }

  if (card.actions?.length) {
    const actions = document.createElement('div');
    actions.className = 'wb-reaction-actions';
    for (const a of card.actions) {
      const btn = document.createElement('button');
      btn.className = 'wb-reaction-btn';
      btn.textContent = a.label;
      btn.onclick = () => {
        dispatchAction(a.action);
        dismiss();
      };
      actions.appendChild(btn);
    }
    el.appendChild(actions);
  }

  box.appendChild(el);
  timer = window.setTimeout(dismiss, AUTO_CLOSE_MS);
}

export function initReaction(): void {
  injectStyle();
  window.kimi.onReactionCard(showCard);
}
