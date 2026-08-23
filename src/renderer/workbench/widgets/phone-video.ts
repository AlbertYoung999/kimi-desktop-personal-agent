/**
 * Phone Video（V4-C）：iPhone 连 Mac 后用户用 QuickTime「新建录影」看手机画面。
 * 这是屏幕源（QuickTime Player 窗口里播放手机画面），getUserMedia 枚举不到摄像头设备，
 * 因此走窗口捕获：desktopCapturer 列窗口（window.kimi.desktopSources），默认取 name 含
 * 'quicktime' 的第一个窗口，控制条「来源」下拉可切换其他窗口源；
 * getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })
 * （Electron 专有约束）拉流铺满组件体。
 * 没有 QuickTime 窗口时显示占位引导 + 重试按钮（重试会重新枚举窗口）。
 * Vision 模式：按选定帧率 canvas 截帧（最长边 768px，JPEG 0.7）→ homeAskImage 入队，
 * 不等回复；组件移除/休眠（body.isConnected 丢失）时停止截帧并 stop tracks。
 */

import { registerWidget } from '../core/registry';
import { clearVisionFrame, setVisionFrame } from '../core/vision-store';
const FPS_OPTIONS = [0.2, 0.5, 1];
const MAX_EDGE = 768;
const JPEG_QUALITY = 0.7;

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.wf-phone-video-root { display: flex; flex-direction: column; height: 100%; gap: 8px; }
.wf-phone-video-bar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.wf-phone-video-toggle {
  font-family: var(--mono); font-size: 10px; letter-spacing: 1px;
  padding: 3px 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--disabled);
  transition: all 160ms var(--ease-in);
}
.wf-phone-video-toggle:hover { color: var(--muted); border-color: var(--border-strong); }
.wf-phone-video-toggle.on {
  color: var(--neon); border-color: rgba(0,240,255,0.5);
  background: rgba(0,240,255,0.07);
  box-shadow: 0 0 10px rgba(0,240,255,0.18), inset 0 0 8px rgba(0,240,255,0.05);
}
.wf-phone-video-fps {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.5px;
  padding: 3px 6px; border-radius: 6px; cursor: pointer; outline: none;
  border: 1px solid var(--border); background: rgba(255,255,255,0.03); color: var(--muted);
  max-width: 150px; text-overflow: ellipsis;
}
.wf-phone-video-fps:focus { border-color: var(--border-strong); }
.wf-phone-video-fps option { background: #10141e; color: var(--fg); }
.wf-phone-video-status {
  margin-left: auto; font-family: var(--mono); font-size: 10px; letter-spacing: 1px;
  color: var(--disabled); white-space: nowrap;
}
.wf-phone-video-status.live { color: var(--green); text-shadow: 0 0 8px rgba(0,255,136,0.5); }
.wf-phone-video-status.sent { color: var(--neon); text-shadow: 0 0 10px rgba(0,240,255,0.7); }
.wf-phone-video-stage {
  flex: 1; min-height: 0; position: relative; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border); background: rgba(0,0,0,0.35);
}
.wf-phone-video-stage video {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
}
.wf-phone-video-placeholder {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 16px; text-align: center;
}
.wf-phone-video-placeholder-icon { font-size: 26px; opacity: 0.6; }
.wf-phone-video-placeholder-text { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.wf-phone-video-placeholder-diag {
  font-family: var(--mono); font-size: 9.5px; color: var(--disabled);
  line-height: 1.7; word-break: break-all; max-width: 100%;
}
.wf-phone-video-retry {
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 1px;
  padding: 5px 16px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
  transition: all 160ms var(--ease-in);
}
.wf-phone-video-retry:hover { color: var(--neon); border-color: var(--border-strong); box-shadow: 0 0 12px rgba(0,240,255,0.15); }
`;
  document.head.appendChild(style);
}

interface WindowSource {
  id: string;
  name: string;
  thumbnail: string;
}

/** 枚举当前可捕获的窗口源（desktopCapturer）。失败时按空列表处理，由占位态兜底。 */
async function listWindowSources(): Promise<WindowSource[]> {
  try {
    return await window.kimi.desktopSources();
  } catch {
    return [];
  }
}

registerWidget({
  def: {
    id: 'phone-video',
    name: 'Phone Video',
    icon: '📱',
    description: 'QuickTime 录影窗口捕获 + Vision 截帧',
    category: 'media',
    defaultSize: { w: 8, h: 9 },
    minSize: { w: 6, h: 6 },
  },
  mount(body) {
    injectStyle();

    const root = document.createElement('div');
    root.className = 'wf-phone-video-root';

    // ---- 控制条 ----
    const bar = document.createElement('div');
    bar.className = 'wf-phone-video-bar';
    const toggle = document.createElement('button');
    toggle.className = 'wf-phone-video-toggle';
    toggle.textContent = 'VISION';
    const fpsSel = document.createElement('select');
    fpsSel.className = 'wf-phone-video-fps';
    for (const f of FPS_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(f);
      opt.textContent = `${f} fps`;
      if (f === 0.5) opt.selected = true;
      fpsSel.appendChild(opt);
    }
    const srcSel = document.createElement('select');
    srcSel.className = 'wf-phone-video-fps';
    srcSel.title = '来源窗口';
    const status = document.createElement('span');
    status.className = 'wf-phone-video-status';
    status.textContent = '—';
    bar.append(toggle, fpsSel, srcSel, status);

    // ---- 画面区 ----
    const stage = document.createElement('div');
    stage.className = 'wf-phone-video-stage';
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    root.append(bar, stage);
    body.appendChild(root);

    // ---- 状态 ----
    let stream: MediaStream | null = null;
    let visionOn = false;
    let visionTimer: number | null = null;
    let flashTimer: number | null = null;

    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d');

    const setStatus = (text: string, live = false) => {
      status.textContent = text;
      status.classList.toggle('live', live);
    };

    const stopVisionTimer = () => {
      if (visionTimer !== null) {
        window.clearInterval(visionTimer);
        visionTimer = null;
      }
    };

    const stopStream = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    };

    const showPlaceholder = (text: string, sources?: WindowSource[]) => {
      stage.innerHTML = '';
      const ph = document.createElement('div');
      ph.className = 'wf-phone-video-placeholder';
      const icon = document.createElement('div');
      icon.className = 'wf-phone-video-placeholder-icon';
      icon.textContent = '📱';
      const msg = document.createElement('div');
      msg.className = 'wf-phone-video-placeholder-text';
      msg.textContent = text;
      ph.append(icon, msg);
      // 诊断行：列出当前枚举到的窗口，方便排查（可能用户开的是别的录影窗口）
      if (sources) {
        const diag = document.createElement('div');
        diag.className = 'wf-phone-video-placeholder-diag';
        diag.textContent = sources.length
          ? sources.map((s) => `WIN: ${s.name}`).join('\n')
          : 'WIN: (未枚举到任何窗口)';
        diag.style.whiteSpace = 'pre-line';
        ph.appendChild(diag);
      }
      const retry = document.createElement('button');
      retry.className = 'wf-phone-video-retry';
      retry.textContent = '重试';
      retry.onclick = () => void connect();
      ph.appendChild(retry);
      stage.appendChild(ph);
    };

    // ---- Vision 截帧 ----
    const captureAndSend = () => {
      if (!visionOn || !stream || !video.videoWidth || !ctx2d) return;
      const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      // 只刷新最新画面缓存，由用户发消息时附带——不主动给 AI 发消息
      setVisionFrame({ data: base64, mimeType: 'image/jpeg', at: Date.now() });
      // 状态字闪烁一次 ● FRAME
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      status.textContent = '● FRAME';
      status.classList.add('sent');
      flashTimer = window.setTimeout(() => {
        status.classList.remove('sent');
        setStatus('● LIVE', true);
        flashTimer = null;
      }, 600);
    };

    const startVisionTimer = () => {
      stopVisionTimer();
      const fps = Number(fpsSel.value) || 0.5;
      visionTimer = window.setInterval(() => {
        if (!body.isConnected) return; // 由 watcher 统一清理
        captureAndSend();
      }, 1000 / fps);
    };

    const setVision = (on: boolean) => {
      visionOn = on;
      toggle.classList.toggle('on', on);
      if (on && stream) startVisionTimer();
      else {
        stopVisionTimer();
        clearVisionFrame(); // 关闭后不再截帧，陈旧画面也不再随消息附带
        setStatus('● LIVE', true);
      }
    };

    toggle.onclick = () => setVision(!visionOn);
    fpsSel.onchange = () => {
      if (visionOn) startVisionTimer();
    };

    // ---- 连接 ----
    /** 用指定窗口源拉流（Electron 专有 chromeMediaSource 约束）。 */
    const attachSource = async (source: WindowSource): Promise<boolean> => {
      stopStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // Electron 专有约束：desktopCapturer 源 id 直接取流
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: source.id,
            },
          } as unknown as MediaTrackConstraints,
        });
      } catch {
        stream = null;
        return false;
      }
      stage.innerHTML = '';
      stage.appendChild(video);
      video.srcObject = stream;
      // 窗口关闭/源失效 → 回占位态
      stream.getVideoTracks().forEach((t) =>
        t.addEventListener('ended', () => {
          stopVisionTimer();
          stopStream();
          showPlaceholder('来源窗口已关闭，请重新选择后重试');
          setStatus('DISCONNECTED');
        }),
      );
      setStatus('● LIVE', true);
      if (visionOn) startVisionTimer();
      return true;
    };

    /**
     * sourceId 为空时重新枚举窗口：默认取 name 含 'quicktime' 的第一个窗口，
     * 并保留用户在下拉里的既有选择（仍存在的话）；有 sourceId 则直接用该源。
     */
    const connect = async (sourceId?: string): Promise<void> => {
      stopStream();
      setStatus('SCANNING…');
      let target: WindowSource | undefined;
      if (sourceId) {
        target = { id: sourceId, name: '', thumbnail: '' };
      } else {
        const sources = await listWindowSources();
        const prev = srcSel.value;
        srcSel.innerHTML = '';
        for (const s of sources) {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name;
          srcSel.appendChild(opt);
        }
        target =
          sources.find((s) => s.id === prev) ?? sources.find((s) => /quicktime/i.test(s.name));
        if (!target) {
          showPlaceholder(
            '请先打开 QuickTime Player → 新建录影 → 选择你的 iPhone',
            sources,
          );
          setStatus('NO SOURCE');
          return;
        }
        srcSel.value = target.id;
      }
      if (!(await attachSource(target))) {
        showPlaceholder('无法捕获来源窗口，请重试或在「来源」下拉切换其他窗口');
        setStatus('ERROR');
      }
    };

    srcSel.onchange = () => {
      if (srcSel.value) void connect(srcSel.value);
    };

    // ---- 移除/休眠清理：body 脱离 DOM 即停截帧 + stop tracks ----
    const watcher = window.setInterval(() => {
      if (body.isConnected) return;
      window.clearInterval(watcher);
      stopVisionTimer();
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      stopStream();
    }, 1000);

    void connect();
  },
});
