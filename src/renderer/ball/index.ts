/// <reference path="../api.d.ts" />

const ball = document.getElementById('ball')!;
const face = document.getElementById('face')!;
const eyes = Array.from(document.querySelectorAll<HTMLElement>('.eye'));

const MAX_EYE_OFFSET = 3; // px

// --- eyes follow the cursor (whole eye moves; there are no pupils) ---
window.kimi.onCursor(({ x, y }) => {
  const cx = window.screenX + window.innerWidth / 2;
  const cy = window.screenY + window.innerHeight / 2;
  const dx = x - cx;
  const dy = y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (dx / len) * MAX_EYE_OFFSET;
  const oy = (dy / len) * MAX_EYE_OFFSET;
  for (const e of eyes) {
    e.style.transform = `translate(${ox}px, ${oy}px)`;
  }
});

// --- blink every 3-6s ---
function scheduleBlink() {
  setTimeout(() => {
    face.classList.add('blinking');
    setTimeout(() => face.classList.remove('blinking'), 140);
    scheduleBlink();
  }, 3000 + Math.random() * 3000);
}
scheduleBlink();

// --- occasional idle head tilt ---
function scheduleTilt() {
  setTimeout(() => {
    const cls = Math.random() < 0.5 ? 'tilt-left' : 'tilt-right';
    face.classList.add(cls);
    setTimeout(() => face.classList.remove(cls), 900 + Math.random() * 800);
    scheduleTilt();
  }, 7000 + Math.random() * 8000);
}
scheduleTilt();

// --- state from main ---
window.kimi.onBallState((state) => {
  ball.className = `state-${state}`;
});

// --- manual drag + click (app-region drag swallows clicks, so we do it ourselves) ---
let dragStart: { sx: number; sy: number; wx: number; wy: number } | null = null;
let dragged = false;

ball.addEventListener('mousedown', (e) => {
  dragStart = { sx: e.screenX, sy: e.screenY, wx: window.screenX, wy: window.screenY };
  dragged = false;
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const dx = e.screenX - dragStart.sx;
  const dy = e.screenY - dragStart.sy;
  if (!dragged && Math.hypot(dx, dy) > 4) dragged = true;
  if (dragged) {
    window.kimi.moveBall(dragStart.wx + dx, dragStart.wy + dy);
  }
});

window.addEventListener('mouseup', () => {
  if (dragStart && !dragged) window.kimi.toggleChat();
  dragStart = null;
});
