/**
 * 共享 voice orb（V4-B 提取）：主页与 Zen 页共用同一套三态动画。
 * - style 'ring'：霓虹径向柱环（主页默认，逻辑原样保留自 V4-A）；
 * - style 'blob'：Apple Intelligence 风多彩柔光球（Zen 页）——粉/蓝/紫/青四色
 *   径向渐变大色块在低分辨率离屏 canvas 上叠加（'lighter'），放大回主 canvas
 *   等效大 blur；色块缓慢漂移旋转（周期 9–16s），READY 呼吸 ±3%，THINKING
 *   旋转加速且色相向青蓝偏移，SPEAKING 整体脉动 ±8%（1.5s 周期）。纯渐变无硬边。
 * 尺寸按 cssSize 相对主页基准 420px 等比缩放。
 */

export type OrbState = 'ready' | 'thinking' | 'speaking';
export type OrbStyle = 'ring' | 'blob';

export interface OrbHandle {
  setState(s: OrbState): void;
  getState(): OrbState;
}

// orb 配色（霓虹青，原 home 绿色 rgba(0,229,160,*) 的对应色）
const NEON = '0, 240, 255';
const NEON_DEEP = '0, 170, 220';

const BASE_SIZE = 420; // 主页基准尺寸，其他尺寸等比缩放

export function createOrb(canvas: HTMLCanvasElement, cssSize: number, style: OrbStyle = 'ring'): OrbHandle {
  return style === 'blob' ? createBlobOrb(canvas, cssSize) : createRingOrb(canvas, cssSize);
}

/** 页面隐藏时暂停 rAF 省 CPU（页面切换不暂停，状态共享） */
function runLoop(draw: (t: number) => void): void {
  let rafId = 0;
  const loop = (t: number): void => {
    draw(t);
    rafId = requestAnimationFrame(loop);
  };
  const start = (): void => {
    if (!rafId) rafId = requestAnimationFrame(loop);
  };
  const stop = (): void => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  start();
}

// ---------------------------------------------------------------- ring（主页）

function createRingOrb(canvas: HTMLCanvasElement, cssSize: number): OrbHandle {
  const scale = cssSize / BASE_SIZE;
  const ctx = canvas.getContext('2d');
  const BAR_COUNT = 48;
  // 高清屏适配
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  ctx?.scale(dpr, dpr);

  let orbState: OrbState = 'ready';

  interface OrbParams {
    amp: number;    // 柱长波动幅度
    speed: number;  // 波动速度
    glow: number;   // 发光强度
  }
  const ORB_PARAMS: Record<OrbState, OrbParams> = {
    ready: { amp: 6, speed: 1.2, glow: 0.35 },      // idle 缓慢呼吸
    thinking: { amp: 14, speed: 3.2, glow: 0.6 },   // 加速波动
    speaking: { amp: 26, speed: 6.0, glow: 1.0 },   // 幅度最大且更快
  };
  // 当前平滑插值后的参数
  const cur: OrbParams = { ...ORB_PARAMS.ready };

  let lastT = 0;

  function drawOrb(t: number): void {
    if (!ctx) return;
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    const target = ORB_PARAMS[orbState];
    // 参数平滑过渡，避免状态切换时跳变
    const k = 1 - Math.pow(0.001, dt);
    cur.amp += (target.amp - cur.amp) * k;
    cur.speed += (target.speed - cur.speed) * k;
    cur.glow += (target.glow - cur.glow) * k;

    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const baseR = 110 * scale;
    ctx.clearRect(0, 0, cssSize, cssSize);

    // 内圈光晕
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR);
    grad.addColorStop(0, `rgba(${NEON}, ${0.10 + cur.glow * 0.10})`);
    grad.addColorStop(1, `rgba(${NEON}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.fill();

    // 径向柱环
    ctx.lineCap = 'round';
    const time = t / 1000;
    for (let i = 0; i < BAR_COUNT; i++) {
      const angle = (i / BAR_COUNT) * Math.PI * 2 - Math.PI / 2;
      // 多频正弦叠加，让波形更有机
      const wave =
        Math.sin(time * cur.speed + i * 0.55) * 0.6 +
        Math.sin(time * cur.speed * 0.5 + i * 1.3) * 0.4;
      const len = (14 + cur.amp * (0.5 + 0.5 * wave)) * scale;
      const r0 = baseR;
      const r1 = baseR + len;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const alpha = 0.45 + 0.55 * (0.5 + 0.5 * wave);
      ctx.strokeStyle = `rgba(${NEON}, ${alpha * (0.5 + cur.glow * 0.5)})`;
      ctx.lineWidth = 3 * scale;
      ctx.shadowColor = `rgba(${NEON}, 0.8)`;
      ctx.shadowBlur = 8 * cur.glow;
      ctx.beginPath();
      ctx.moveTo(cx + cos * r0, cy + sin * r0);
      ctx.lineTo(cx + cos * r1, cy + sin * r1);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // 中心内核圆
    const corePulse = 1 + Math.sin(time * cur.speed * 0.6) * 0.04 * (cur.amp / 10);
    const coreR = 52 * scale * corePulse;
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreGrad.addColorStop(0, `rgba(${NEON}, ${0.35 + cur.glow * 0.25})`);
    coreGrad.addColorStop(0.7, `rgba(${NEON_DEEP}, ${0.18 + cur.glow * 0.12})`);
    coreGrad.addColorStop(1, `rgba(${NEON}, 0.02)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
  }

  runLoop(drawOrb);

  return {
    setState(s: OrbState): void {
      orbState = s;
    },
    getState(): OrbState {
      return orbState;
    },
  };
}

// ---------------------------------------------------------------- blob（Zen 页）

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hex(h: string): Rgb {
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function mixRgb(a: Rgb, b: Rgb, t: number): string {
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `${r}, ${g}, ${bl}`;
}

// 四个色块：常态色 → THINKING 偏移色（整体向青/蓝靠拢）
const BLOBS: Array<{ from: Rgb; to: Rgb; phase: number; dir: 1 | -1; period: number; orbit: number; radius: number }> = [
  { from: hex('#ff5e8a'), to: hex('#5a8bff'), phase: 0.4, dir: 1, period: 11, orbit: 0.20, radius: 0.46 }, // 粉
  { from: hex('#4d9bff'), to: hex('#00e5ff'), phase: 2.1, dir: -1, period: 14, orbit: 0.22, radius: 0.48 }, // 蓝
  { from: hex('#a06bff'), to: hex('#4d9bff'), phase: 3.8, dir: 1, period: 9, orbit: 0.18, radius: 0.44 },  // 紫
  { from: hex('#00e5ff'), to: hex('#00e5ff'), phase: 5.3, dir: -1, period: 16, orbit: 0.15, radius: 0.40 }, // 青
];

function createBlobOrb(canvas: HTMLCanvasElement, cssSize: number): OrbHandle {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  ctx?.scale(dpr, dpr);
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  // 低分辨率离屏：小画布上画径向渐变再放大，等效大半径 blur
  const LOW = 132;
  const off = document.createElement('canvas');
  off.width = LOW;
  off.height = LOW;
  const octx = off.getContext('2d');

  let orbState: OrbState = 'ready';

  interface BlobParams {
    speed: number;       // 漂移速度倍率
    think: number;       // 0→1 色相向青蓝偏移
    scaleAmp: number;    // 呼吸/脉动幅度
    scalePeriod: number; // 呼吸/脉动周期（秒）
    alpha: number;       // 整体强度
  }
  const BLOB_PARAMS: Record<OrbState, BlobParams> = {
    ready: { speed: 1.0, think: 0, scaleAmp: 0.015, scalePeriod: 6.0, alpha: 0.85 },
    thinking: { speed: 1.1, think: 1, scaleAmp: 0.02, scalePeriod: 5.0, alpha: 1.0 },
    speaking: { speed: 1.0, think: 0.25, scaleAmp: 0.025, scalePeriod: 2.6, alpha: 1.0 },
  };
  const cur: BlobParams = { ...BLOB_PARAMS.ready };

  let lastT = 0;

  function drawBlob(t: number): void {
    if (!ctx || !octx) return;
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;
    const target = BLOB_PARAMS[orbState];
    const k = 1 - Math.pow(0.001, dt);
    cur.speed += (target.speed - cur.speed) * k;
    cur.think += (target.think - cur.think) * k;
    cur.scaleAmp += (target.scaleAmp - cur.scaleAmp) * k;
    cur.scalePeriod += (target.scalePeriod - cur.scalePeriod) * k;
    cur.alpha += (target.alpha - cur.alpha) * k;

    const time = t / 1000;
    const lc = LOW / 2;

    octx.clearRect(0, 0, LOW, LOW);
    octx.globalCompositeOperation = 'lighter';

    // 色块不做绕圈轨道（会晕）——各自在象限内缓慢漂移呼吸
    for (const b of BLOBS) {
      const wobble = 1 + Math.sin(time * 0.6 + b.phase * 2) * 0.1;
      const px = lc + Math.cos(b.phase) * LOW * 0.16 + Math.sin((time * b.dir * Math.PI * 2) / (b.period * 2) + b.phase) * LOW * 0.05 * cur.speed;
      const py = lc + Math.sin(b.phase) * LOW * 0.16 + Math.cos((time * Math.PI * 2) / (b.period * 2.6) + b.phase * 1.7) * LOW * 0.05 * cur.speed;
      const pr = LOW * b.radius * wobble;
      const rgb = mixRgb(b.from, b.to, cur.think);
      const grad = octx.createRadialGradient(px, py, 0, px, py, pr);
      grad.addColorStop(0, `rgba(${rgb}, ${0.62 * cur.alpha})`);
      grad.addColorStop(0.55, `rgba(${rgb}, ${0.28 * cur.alpha})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      octx.fillStyle = grad;
      octx.beginPath();
      octx.arc(px, py, pr, 0, Math.PI * 2);
      octx.fill();
    }

    // 中心亮核（叠加一点白，让球体有"活物"的明度）
    const coreGrad = octx.createRadialGradient(lc, lc, 0, lc, lc, LOW * 0.26);
    coreGrad.addColorStop(0, `rgba(255, 255, 255, ${0.16 * cur.alpha})`);
    coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    octx.fillStyle = coreGrad;
    octx.beginPath();
    octx.arc(lc, lc, LOW * 0.26, 0, Math.PI * 2);
    octx.fill();
    octx.globalCompositeOperation = 'source-over';

    // 圆形 + 羽化边缘：中心清晰、边缘柔光散开（比硬裁切更耐看）
    const s = 1 + Math.sin((time * Math.PI * 2) / cur.scalePeriod) * cur.scaleAmp;
    const size = cssSize * 0.8 * s;
    ctx.clearRect(0, 0, cssSize, cssSize);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cssSize / 2, cssSize / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(off, (cssSize - size) / 2, (cssSize - size) / 2, size, size);
    // 羽化：边缘一圈径向渐变遮罩向内擦除
    ctx.globalCompositeOperation = 'destination-out';
    const fade = ctx.createRadialGradient(cssSize / 2, cssSize / 2, size * 0.3, cssSize / 2, cssSize / 2, size * 0.52);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, cssSize, cssSize);
    ctx.restore();
  }

  runLoop(drawBlob);

  return {
    setState(s: OrbState): void {
      orbState = s;
    },
    getState(): OrbState {
      return orbState;
    },
  };
}
