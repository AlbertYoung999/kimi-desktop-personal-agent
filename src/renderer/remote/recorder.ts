/**
 * MediaRecorder 兜底录音(talking-to-the-moon 原版移植):
 * Web Speech 不可用时录音 → base64 交上层上传 ASR(我们的 /api/asr 本期 501 占位)。
 * 仅为 TS 化,逻辑不变。
 */

export class AudioRecorder {
  onResult: ((base64: string, format: string) => void) | null = null;
  onError: ((err: string) => void) | null = null;

  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private mimeType: string | null = null;

  static isSupported(): boolean {
    return !!(
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder === 'function'
    );
  }

  async start(): Promise<void> {
    if (!AudioRecorder.isSupported()) {
      this.onError?.('not_supported');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.chunks = [];
      const preferred = ['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
      this.mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
      this.mediaRecorder = new MediaRecorder(
        this.stream,
        this.mimeType ? { mimeType: this.mimeType } : undefined,
      );
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => this.finalize();
      this.mediaRecorder.onerror = () => this.onError?.('recorder_error');
      this.mediaRecorder.start(100);
    } catch (err) {
      const e = err as DOMException;
      this.onError?.(e.name === 'NotAllowedError' ? 'mic_denied' : String(err));
    }
  }

  stop(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stopStream();
  }

  private stopStream(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  private finalize(): void {
    const blobType = this.mimeType ?? this.chunks[0]?.type ?? 'audio/webm';
    const blob = new Blob(this.chunks, { type: blobType });
    this.chunks = [];
    if (blob.size === 0) {
      this.onError?.('empty_recording');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = String(reader.result).split(',')[1];
      this.onResult?.(base64, blobType);
    };
    reader.onerror = () => this.onError?.('read_error');
    reader.readAsDataURL(blob);
  }
}
