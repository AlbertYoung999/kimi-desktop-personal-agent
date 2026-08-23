/**
 * Vision frame store (design: phone-video vision mode).
 * 截帧只刷新这里的最新画面；用户发消息时由发送方附带，不主动给 AI 发消息。
 */

export interface VisionFrame {
  data: string; // base64 jpeg
  mimeType: string;
  at: number;
}

let latest: VisionFrame | null = null;

export function setVisionFrame(frame: VisionFrame): void {
  latest = frame;
}

/** 取最新帧；超过 maxAgeMs（默认 30s）视为失效 */
export function getVisionFrame(maxAgeMs = 30_000): VisionFrame | null {
  if (!latest || Date.now() - latest.at > maxAgeMs) return null;
  return latest;
}

export function clearVisionFrame(): void {
  latest = null;
}

/** 发送用户消息：有新鲜 vision 帧时自动附上（图片走 image block） */
export function askWithVision(text: string): Promise<string> {
  const frame = getVisionFrame();
  if (frame) {
    return window.kimi.homeAskImage(`[附：用户当前手机屏幕画面]\n${text}`, {
      data: frame.data,
      mimeType: frame.mimeType,
    });
  }
  return window.kimi.homeAsk(text);
}
