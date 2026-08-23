/**
 * 主页（V4-A Shell 页面）：原 home 窗口内容迁入 workbench Shell。
 * 逻辑移植自 src/renderer/home/index.ts：发送对话（homeAsk + onChunk 流式 +
 * onTurnDone）、系统指标、时钟、orb 动画、vault 最近收藏。
 * TTS 播报已由 core/voice.ts 统一接管，本页只维护 orb 的 speaking 状态窗口。
 *
 * 状态共享：onChunk/onTurnDone/onSysStats 监听在本模块 init 时各绑一次，
 * 切页只是 .page 容器显隐（DOM 常驻），流式输出 / EVENT LOG / orb 状态天然延续。
 * 视觉：并入 workbench 霓虹青主题（原绿色终端风 → --neon 青色系）。
 */

import { createOrb, type OrbState } from './orb';
import { markLocalSend, rotateMainSession, subscribe } from '../core/main-log';
import { askWithVision } from '../core/vision-store';

export function initHomePage(): void {
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };

  // 高清屏适配（net sparkline 用；orb 的 dpr 在 pages/orb.ts 内部处理）
  const dpr = window.devicePixelRatio || 1;

  // ---------- orb（共享实现见 pages/orb.ts，主页与 Zen 页同一套三态动画） ----------
  const orb = createOrb($('orb-canvas') as unknown as HTMLCanvasElement, 420);
  const orbStatusEl = $('orb-status');
  const STATUS_TEXT: Record<OrbState, string> = {
    ready: 'READY…',
    thinking: 'THINKING…',
    speaking: 'SPEAKING…',
  };
  function setOrbState(s: OrbState): void {
    orb.setState(s);
    orbStatusEl.textContent = STATUS_TEXT[s];
  }

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
    drawLine(netInHist, '#00f0ff'); // 下行 霓虹青
    drawLine(netOutHist, '#00ff88'); // 上行 绿
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

  // ---------- 对话 / EVENT LOG ----------
  const logList = $('log-list');
  const input = $('input') as unknown as HTMLInputElement;
  const btnSend = $('btn-send');

  function scrollLog(): void {
    logList.scrollTop = logList.scrollHeight;
  }

  function renderLog(entries: { role: 'you' | 'kimi'; text: string; at: number }[]): void {
    logList.innerHTML = '';
    for (const item of entries) {
      const entry = document.createElement('div');
      entry.className = `log-entry ${item.role}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `[${new Date(item.at).toTimeString().slice(0, 8)}] ${item.role === 'you' ? 'YOU' : 'KIMI'} ›`;
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = item.text;
      entry.append(meta, body);
      logList.appendChild(entry);
    }
    scrollLog();
  }

  // 日志数据源：core/main-log.ts 全局共享（home 与 zen 渲染同一份记录）
  subscribe(renderLog);

  // ---------- orb 状态（与日志渲染解耦） ----------
  let activeSid: string | null = null;
  let lastReplyLen = 0;

  // 主会话过滤（跨界面转发的用户消息只收主会话的）
  let mainSid: string | null = null;
  void window.kimi
    .getSettings()
    .then((s) => {
      mainSid = s.mainSessionId ?? null;
    })
    .catch(() => undefined);
  window.kimi.onMainSession((p) => {
    mainSid = p.sessionId;
  });
  const isMain = (sid: string): boolean => mainSid == null || sid === mainSid;

  window.kimi.onChunk((e) => {
    if (!activeSid || e.sessionId !== activeSid || e.kind !== 'text') return;
    lastReplyLen += e.text.length;
    setOrbState('thinking');
  });

  window.kimi.onTurnDone((e) => {
    if (!activeSid || e.sessionId !== activeSid) return;
    activeSid = null;
    const replyLen = lastReplyLen;
    lastReplyLen = 0;
    if (!replyLen) {
      setOrbState('ready');
      return;
    }
    // TTS 由 core/voice.ts 统一播报；这里只按回复长度估算 orb 的
    // speaking 状态窗口（≈75ms/字，2s–30s），新 chunk 到来会切回 thinking
    setOrbState('speaking');
    const ms = Math.min(30000, Math.max(2000, replyLen * 75));
    setTimeout(() => {
      if (!activeSid) setOrbState('ready');
    }, ms);
  });

  // ---------- 发送 ----------
  let sending = false;
  async function send(): Promise<void> {
    const text = input.value.trim();
    if (!text || sending) return;
    // /new：开启新主会话
    if (text === '/new') {
      input.value = '';
      await rotateMainSession();
      return;
    }
    sending = true;
    input.value = '';
    window.kimi.ttsStop(); // 打断上一轮播报
    markLocalSend(text); // 本地消息立即上屏 + 主进程回投去重
    setOrbState('thinking');
    lastReplyLen = 0;
    try {
      activeSid = await askWithVision(text);
    } catch {
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
}
