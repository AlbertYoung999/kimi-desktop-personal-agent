/** Command palette overlay (Command Center host). */

export type QueryHandler = (query: string, resultsEl: HTMLElement) => void;
export type ExecuteHandler = (query: string, resultsEl: HTMLElement) => void;

let queryHandler: QueryHandler | null = null;
let executeHandler: ExecuteHandler | null = null;

export function setQueryHandler(fn: QueryHandler): void {
  queryHandler = fn;
}

export function setExecuteHandler(fn: ExecuteHandler): void {
  executeHandler = fn;
}

const overlay = () => document.getElementById('palette')!;
const input = () => document.getElementById('palette-input') as HTMLInputElement;
const results = () => document.getElementById('palette-results')!;

export function isPaletteOpen(): boolean {
  return !overlay().classList.contains('hidden');
}

export function openPalette(): void {
  overlay().classList.remove('hidden');
  input().value = '';
  results().innerHTML = '';
  input().focus();
}

export function closePalette(): void {
  overlay().classList.add('hidden');
}

export function initPalette(): void {
  overlay().addEventListener('click', (e) => {
    if (e.target === overlay()) closePalette();
  });
  input().addEventListener('input', () => queryHandler?.(input().value, results()));
  input().addEventListener('keydown', (e) => {
    // ↑/↓ move .selected across result items (wrap-around); Enter runs the
    // selected item; Esc closing stays handled by the document listener.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(results().querySelectorAll<HTMLElement>('.palette-item'));
      if (!items.length) return;
      const cur = items.findIndex((el) => el.classList.contains('selected'));
      const next =
        e.key === 'ArrowDown'
          ? (cur + 1) % items.length
          : cur <= 0
            ? items.length - 1
            : cur - 1;
      items.forEach((el, i) => el.classList.toggle('selected', i === next));
      items[next].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      executeHandler?.(input().value, results());
    }
  });
}
