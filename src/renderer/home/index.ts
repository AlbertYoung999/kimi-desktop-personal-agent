/**
 * home 页渲染层：voice-first 主页（HUD 风格）。
 * 逻辑：发送对话（homeAsk + onChunk 流式 + onTurnDone）、TTS 播报、
 * 系统指标、时钟、orb 动画、vault 最近收藏。
 */

type OrbState = 'ready' | 'thinking' | 'speaking';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

// ---------- orb 状态 ----------
let orbState: OrbState = 'ready';
const orbStatusEl = $('orb-status');
const STATUS_TEXT: Record<OrbState, string> = {
  ready: 'READY…',
  thinking: 'THINKING…',
  speaking: 'SPEAKING…',
};
function setOrbState(s: OrbState): void {
  orbState = s;
  orbStatusEl.textContent = STATUS_TEXT[s];
}

// ---------- orb 动画（48 根径向柱） ----------
const canvas = $('orb-canvas') as unknown as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
const BAR_COUNT = 48;
// 高清屏适配
const dpr = window.devicePixelRatio || 1;
const CSS_SIZE = 420;
canvas.width = CSS_SIZE * dpr;
canvas.height = CSS_SIZE * dpr;
canvas.style.width = `${CSS_SIZE}px`;
canvas.style.height = `${CSS_SIZE}px`;
ctx?.scale(dpr, dpr);

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

let rafId = 0;
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

  const cx = CSS_SIZE / 2;
  const cy = CSS_SIZE / 2;
  const baseR = 110;
  ctx.clearRect(0, 0, CSS_SIZE, CSS_SIZE);

  // 内圈光晕
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR);
  grad.addColorStop(0, `rgba(0, 229, 160, ${0.10 + cur.glow * 0.10})`);
  grad.addColorStop(1, 'rgba(0, 229, 160, 0)');
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
    const len = 14 + cur.amp * (0.5 + 0.5 * wave);
    const r0 = baseR;
    const r1 = baseR + len;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const alpha = 0.45 + 0.55 * (0.5 + 0.5 * wave);
    ctx.strokeStyle = `rgba(0, 229, 160, ${alpha * (0.5 + cur.glow * 0.5)})`;
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(0, 229, 160, 0.8)';
    ctx.shadowBlur = 8 * cur.glow;
    ctx.beginPath();
    ctx.moveTo(cx + cos * r0, cy + sin * r0);
    ctx.lineTo(cx + cos * r1, cy + sin * r1);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // 中心内核圆
  const corePulse = 1 + Math.sin(time * cur.speed * 0.6) * 0.04 * (cur.amp / 10);
  const coreR = 52 * corePulse;
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreGrad.addColorStop(0, `rgba(0, 229, 160, ${0.35 + cur.glow * 0.25})`);
  coreGrad.addColorStop(0.7, `rgba(0, 180, 130, ${0.18 + cur.glow * 0.12})`);
  coreGrad.addColorStop(1, 'rgba(0, 229, 160, 0.02)');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();
}

function loop(t: number): void {
  drawOrb(t);
  rafId = requestAnimationFrame(loop);
}
function startLoop(): void {
  if (!rafId) rafId = requestAnimationFrame(loop);
}
function stopLoop(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}
// 页面隐藏时暂停动画省 CPU
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLoop();
  else startLoop();
});
startLoop();

// ---------- 时钟 ----------
const clockTime = $('clock-time');
const clockDate = $('clock-date');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function tickClock(): void {
  const now = new Date();
  let h = now.getHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  clockTime.innerHTML = '';
  clockTime.append(
    document.createTextNode(`${pad2(h)}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`),
  );
  const span = document.createElement('span');
  span.className = 'ampm';
  span.textContent = ampm;
  clockTime.appendChild(span);
  clockDate.textContent = `${now.getFullYear()}年${pad2(now.getMonth() + 1)}月${pad2(now.getDate())}日 星期${WEEKDAYS[now.getDay()]}`;
}
tickClock();
setInterval(tickClock, 1000);

// ---------- 系统指标 ----------
const cpuFill = $('cpu-fill');
const memFill = $('mem-fill');
const cpuVal = $('cpu-val');
const memVal = $('mem-val');
const memGb = $('mem-gb');
const diskArc = $('disk-arc');
const diskVal = $('disk-val');
const netInEl = $('net-in');
const netOutEl = $('net-out');
const spark = $('net-spark') as unknown as HTMLCanvasElement;
const battFill = $('batt-fill');
const battPct = $('batt-pct');
const battBolt = $('batt-bolt');
const batteryBlock = $('m-battery');
const wifiBlock = $('m-wifi');
const wifiSsid = $('wifi-ssid');
const topList = $('top-list');
const gpuModelEl = $('gpu-model');
const statLoad = $('stat-load');
const statUptime = $('stat-uptime');

// donut 圆周（r=30）
const DONUT_C = 2 * Math.PI * 30;

function humanizeUptime(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = Math.floor(min % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// 网络 sparkline：保留最近 60 个采样
const NET_SAMPLES = 60;
const SPARK_W = 212;
const SPARK_H = 36;
spark.width = SPARK_W * dpr;
spark.height = SPARK_H * dpr;
const sparkCtx = spark.getContext('2d');
sparkCtx?.scale(dpr, dpr);
const netInHist: number[] = [];
const netOutHist: number[] = [];

function drawSpark(): void {
  if (!sparkCtx) return;
  sparkCtx.clearRect(0, 0, SPARK_W, SPARK_H);
  const max = Math.max(8, ...netInHist, ...netOutHist);
  const drawLine = (hist: number[], color: string): void => {
    if (hist.length < 2 || !sparkCtx) return;
    sparkCtx.strokeStyle = color;
    sparkCtx.lineWidth = 1.2;
    sparkCtx.shadowColor = color;
    sparkCtx.shadowBlur = 4;
    sparkCtx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (NET_SAMPLES - 1)) * (SPARK_W - 2) + 1;
      const y = SPARK_H - 2 - (v / max) * (SPARK_H - 6);
      if (i === 0) sparkCtx.moveTo(x, y);
      else sparkCtx.lineTo(x, y);
    });
    sparkCtx.stroke();
    sparkCtx.shadowBlur = 0;
  };
  drawLine(netInHist, '#00e5a0'); // 下行 绿
  drawLine(netOutHist, '#00d5e5'); // 上行 青
}

window.kimi.onSysStats((stats) => {
  // CPU / RAM
  const cpu = Math.round(stats.cpuPct);
  const mem = Math.round(stats.memPct);
  cpuFill.style.width = `${cpu}%`;
  cpuVal.textContent = `${cpu}%`;
  memFill.style.width = `${mem}%`;
  memVal.textContent = `${mem}%`;
  memGb.textContent = `${stats.memUsedGB}/${stats.memTotalGB} GB`;

  // DISK donut
  const disk = Math.max(0, Math.min(100, Math.round(stats.diskPct)));
  diskArc.style.strokeDashoffset = `${DONUT_C * (1 - disk / 100)}`;
  diskVal.textContent = `${disk}%`;

  // 网络
  netInHist.push(stats.netInKBs);
  netOutHist.push(stats.netOutKBs);
  if (netInHist.length > NET_SAMPLES) netInHist.shift();
  if (netOutHist.length > NET_SAMPLES) netOutHist.shift();
  drawSpark();
  netInEl.textContent = `↓ ${Math.round(stats.netInKBs)} KB/s`;
  netOutEl.textContent = `↑ ${Math.round(stats.netOutKBs)} KB/s`;

  // 电池（-1 = 无电池，整个区块隐藏）
  if (stats.batteryPct < 0) {
    batteryBlock.style.display = 'none';
  } else {
    batteryBlock.style.display = '';
    battFill.style.width = `${stats.batteryPct}%`;
    battPct.textContent = `${Math.round(stats.batteryPct)}%`;
    battBolt.hidden = !stats.batteryCharging;
  }

  // Wi-Fi（无 SSID 隐藏）
  if (stats.wifiSsid) {
    wifiBlock.style.display = '';
    wifiSsid.textContent = stats.wifiSsid;
  } else {
    wifiBlock.style.display = 'none';
  }

  // TOP 进程（前 5）
  topList.innerHTML = '';
  for (const p of stats.topProcs.slice(0, 5)) {
    const row = document.createElement('div');
    row.className = 'top-row';
    const c = document.createElement('span');
    c.className = 'tp-cpu';
    c.textContent = `${p.cpu.toFixed(1)}%`;
    const n = document.createElement('span');
    n.className = 'tp-name';
    n.textContent = p.name;
    row.append(c, n);
    topList.appendChild(row);
  }

  // GPU（// MODULES 行）
  gpuModelEl.textContent = stats.gpuModel ? stats.gpuModel.toUpperCase() : '--';

  // 统计小卡
  statLoad.textContent = stats.loadAvg;
  statUptime.textContent = humanizeUptime(stats.uptimeMin);
});

// ---------- 指标开关（localStorage: kimi-home-metrics） ----------
const METRIC_KEYS = ['cpu', 'ram', 'disk', 'net', 'battery', 'wifi', 'top'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
const METRIC_BLOCKS: Record<MetricKey, string> = {
  cpu: 'm-cpu',
  ram: 'm-ram',
  disk: 'm-disk',
  net: 'm-net',
  battery: 'm-battery',
  wifi: 'm-wifi',
  top: 'm-top',
};
const METRICS_LS_KEY = 'kimi-home-metrics';

function loadMetricPrefs(): Record<MetricKey, boolean> {
  const prefs = {} as Record<MetricKey, boolean>;
  for (const k of METRIC_KEYS) prefs[k] = true; // 默认全开
  try {
    const raw = localStorage.getItem(METRICS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<MetricKey, boolean>>;
      for (const k of METRIC_KEYS) {
        if (typeof parsed[k] === 'boolean') prefs[k] = parsed[k];
      }
    }
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  return prefs;
}

const metricPrefs = loadMetricPrefs();
function applyMetricPrefs(): void {
  for (const k of METRIC_KEYS) {
    $(METRIC_BLOCKS[k]).classList.toggle('metric-off', !metricPrefs[k]);
  }
  try {
    localStorage.setItem(METRICS_LS_KEY, JSON.stringify(metricPrefs));
  } catch {
    /* ignore */
  }
}

const metricsOverlay = $('metrics-overlay');
const gearBtn = $('btn-metrics-gear');
metricsOverlay.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
  const key = cb.dataset.metric as MetricKey;
  cb.checked = metricPrefs[key];
  cb.addEventListener('change', () => {
    metricPrefs[key] = cb.checked;
    applyMetricPrefs();
  });
});
// 点 ⚙ 切换；点浮层外部关闭
gearBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  metricsOverlay.hidden = !metricsOverlay.hidden;
});
metricsOverlay.addEventListener('click', (ev) => ev.stopPropagation());
document.addEventListener('click', () => {
  metricsOverlay.hidden = true;
});
applyMetricPrefs();

// ---------- WORKSHOP（vault 最近 3 条收藏） ----------
const workshopList = $('workshop-list');
void (async () => {
  try {
    const entries = await window.kimi.vaultList();
    workshopList.innerHTML = '';
    const top = entries.slice(0, 3);
    if (top.length === 0) {
      const div = document.createElement('div');
      div.className = 'ws-item empty';
      div.textContent = '暂无收藏 · awaiting input';
      workshopList.appendChild(div);
      return;
    }
    for (const e of top) {
      const div = document.createElement('div');
      div.className = 'ws-item';
      const span = document.createElement('span');
      span.className = 'ws-title';
      span.textContent = e.title;
      div.append(document.createTextNode('» '), span);
      workshopList.appendChild(div);
    }
  } catch {
    workshopList.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'ws-item empty';
    div.textContent = 'vault 读取失败';
    workshopList.appendChild(div);
  }
})();

// ---------- 底部 ticker（纯装饰） ----------
const ticker = $('ticker');
const TICKER_TEXT =
  'acp:linked audio:ready orb:stable stt:pending whisper:queued voice:daniel-gb brain:kimi-acp ' +
  'vault:synced mem:ok load:watching grid:online uptime:counting kimi:listening ';
ticker.textContent = TICKER_TEXT + TICKER_TEXT; // 两份拼接实现无缝循环

// ---------- DASHBOARD ----------
$('btn-dashboard').addEventListener('click', () => {
  window.kimi.toggleWorkbench();
});

// ---------- 对话 / EVENT LOG ----------
const logList = $('log-list');
const input = $('input') as unknown as HTMLInputElement;
const btnSend = $('btn-send');

function nowStamp(): string {
  const n = new Date();
  return `${pad2(n.getHours())}:${pad2(n.getMinutes())}:${pad2(n.getSeconds())}`;
}

function scrollLog(): void {
  logList.scrollTop = logList.scrollHeight;
}

function addLogEntry(role: 'you' | 'kimi', text: string): HTMLElement {
  const entry = document.createElement('div');
  entry.className = `log-entry ${role}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `[${nowStamp()}] ${role === 'you' ? 'YOU' : 'KIMI'} ›`;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  entry.append(meta, body);
  logList.appendChild(entry);
  scrollLog();
  return body;
}

// ---------- 流式接收 ----------
let activeSid: string | null = null;
let activeBody: HTMLElement | null = null;
let fullText = '';

window.kimi.onChunk((e) => {
  if (!activeSid || e.sessionId !== activeSid || e.kind !== 'text') return;
  if (!activeBody) {
    activeBody = addLogEntry('kimi', '');
    activeBody.parentElement?.classList.add('streaming');
    setOrbState('thinking');
  }
  fullText += e.text;
  activeBody.textContent = fullText;
  scrollLog();
});

window.kimi.onTurnDone((e) => {
  if (!activeSid || e.sessionId !== activeSid) return;
  activeSid = null;
  const body = activeBody;
  activeBody = null;
  body?.parentElement?.classList.remove('streaming');
  const reply = fullText.trim();
  fullText = '';
  if (!reply) {
    setOrbState('ready');
    return;
  }
  // TTS 播报：speaking 状态，结束后回 ready
  setOrbState('speaking');
  window.kimi
    .ttsSpeak(reply)
    .catch(() => undefined)
    .finally(() => {
      // 若期间已开始新一轮对话，不覆盖其状态
      if (!activeSid) setOrbState('ready');
    });
});

// ---------- 发送 ----------
let sending = false;
async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || sending) return;
  sending = true;
  input.value = '';
  window.kimi.ttsStop(); // 打断上一轮播报
  addLogEntry('you', text);
  setOrbState('thinking');
  fullText = '';
  activeBody = null;
  try {
    activeSid = await window.kimi.homeAsk(text);
  } catch {
    addLogEntry('kimi', '// 发送失败：主进程无响应');
    activeSid = null;
    setOrbState('ready');
  } finally {
    sending = false;
    input.focus();
  }
}

btnSend.addEventListener('click', () => void send());
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.isComposing) void send();
});
input.focus();
