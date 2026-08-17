/** Workbench-wide toast notifications (bottom-right), fed by main-process events. */

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container?.isConnected) return container;
  container = document.createElement('div');
  container.id = 'wb-toasts';
  document.body.appendChild(container);
  return container;
}

function injectStyle(): void {
  if (document.getElementById('wb-toast-style')) return;
  const style = document.createElement('style');
  style.id = 'wb-toast-style';
  style.textContent = `
    #wb-toasts { position: fixed; right: 14px; bottom: 58px; z-index: 400; display: flex; flex-direction: column; gap: 8px; }
    .wb-toast {
      font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.5px;
      background: var(--card); border: 1px solid var(--border-strong);
      border-radius: 10px; padding: 9px 14px; max-width: 320px;
      color: var(--fg); box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      animation: wbToastIn 200ms cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
    }
    .wb-toast.success { border-color: rgba(0, 255, 136, 0.5); color: var(--green); }
    .wb-toast.error { border-color: rgba(255, 68, 68, 0.5); color: var(--error); }
    .wb-toast.leaving { opacity: 0; transform: translateY(6px); transition: all 200ms; }
    @keyframes wbToastIn { from { transform: translateY(8px); opacity: 0; } }
  `;
  document.head.appendChild(style);
}

export function initToast(): void {
  injectStyle();
  window.kimi.onWbNotify(({ kind, message }) => {
    const box = ensureContainer();
    const toast = document.createElement('div');
    toast.className = `wb-toast ${kind}`;
    toast.textContent = message;
    const dismiss = () => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 220);
    };
    toast.onclick = dismiss;
    box.appendChild(toast);
    setTimeout(dismiss, kind === 'error' ? 8000 : 5000);
  });
}
