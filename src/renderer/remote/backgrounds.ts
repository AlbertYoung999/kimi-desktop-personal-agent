/**
 * 背景切换(talking-to-the-moon 原版移植):
 * 12 张参考图渐变轮播,localStorage 记位置;仅路径改 ./assets/reference/。
 */

const BACKGROUNDS = Array.from({ length: 12 }, (_, i) => `./assets/reference/${i}.jpg`);
const STORAGE_KEY = 'moon-background-index';
const TRANSITION_MS = 300;

function clampIndex(index: number): number {
  const n = Number(index);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(BACKGROUNDS.length - 1, Math.floor(n)));
}

function loadIndex(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    return clampIndex(parseInt(raw, 10));
  } catch {
    return 0;
  }
}

function saveIndex(index: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(index));
  } catch {
    /* ignore */
  }
}

export class BackgroundSwitcher {
  private container: HTMLElement;
  private transitionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private index: number;

  constructor(container: HTMLElement) {
    this.container = container;
    this.index = loadIndex();
    this.container.style.transition = `opacity ${TRANSITION_MS}ms ease`;
    this.container.style.backgroundImage = `url(${BACKGROUNDS[this.index]})`;
    this.preload();
  }

  preload(): void {
    BACKGROUNDS.forEach((url) => {
      const img = new Image();
      img.src = url;
    });
  }

  next(): void {
    this.index = clampIndex((this.index + 1) % BACKGROUNDS.length);
    this.apply();
  }

  prev(): void {
    this.index = clampIndex((this.index - 1 + BACKGROUNDS.length) % BACKGROUNDS.length);
    this.apply();
  }

  private apply(): void {
    clearTimeout(this.transitionTimeoutId ?? undefined);
    this.container.style.opacity = '0';
    this.transitionTimeoutId = setTimeout(() => {
      this.transitionTimeoutId = null;
      this.container.style.backgroundImage = `url(${BACKGROUNDS[this.index]})`;
      this.container.style.opacity = '1';
    }, TRANSITION_MS);
    saveIndex(this.index);
  }
}
