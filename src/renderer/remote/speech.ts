/**
 * Web Speech 识别封装(talking-to-the-moon 原版移植):
 * zh-CN / continuous / interimResults;end 时拼定稿回调 onResult。
 * 仅为 TS 化,逻辑不变。
 */

export interface SpeechRecognitionResultItem {
  isFinal: boolean;
  0: { transcript: string };
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultItem[];
}
interface RecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onnomatch: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export class SpeechRecognizer {
  available: boolean;
  onResult: ((text: string) => void) | null = null;
  onError: ((err: string) => void) | null = null;
  onStart: (() => void) | null = null;
  onEnd: (() => void) | null = null;
  /** 实时中间稿(我们确认弹窗要显示识别过程,原版只 console) */
  onInterim: ((finalText: string, interim: string) => void) | null = null;

  private SpeechRecognitionImpl: (new () => RecognitionInstance) | null = null;
  private recognition: RecognitionInstance | null = null;
  private errored = false;
  private finalTranscripts: string[] = [];

  constructor() {
    const Impl =
      (window as unknown as { SpeechRecognition?: new () => RecognitionInstance }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => RecognitionInstance })
        .webkitSpeechRecognition;
    if (!Impl) {
      this.available = false;
      return;
    }
    this.available = true;
    this.SpeechRecognitionImpl = Impl;
  }

  start(): void {
    if (!this.available || !this.SpeechRecognitionImpl) {
      this.onError?.('not_supported');
      return;
    }
    this.abort();

    const recognition = new this.SpeechRecognitionImpl();
    this.recognition = recognition;
    this.errored = false;
    this.finalTranscripts = [];

    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => this.onStart?.();

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) this.finalTranscripts.push(transcript);
        else interim += transcript;
      }
      this.onInterim?.(this.finalTranscripts.join(''), interim);
    };

    recognition.onnomatch = () => this.onError?.('no-match');

    recognition.onerror = (event) => {
      this.errored = true;
      this.onError?.(event.error);
    };

    recognition.onend = () => {
      if (!this.errored) {
        const joined = this.finalTranscripts.join('');
        if (joined) this.onResult?.(joined);
        else this.onError?.('no-match');
      }
      if (this.recognition === recognition) this.recognition = null;
      this.onEnd?.();
    };

    try {
      recognition.start();
    } catch (err) {
      this.onError?.(String(err));
    }
  }

  stop(): void {
    if (!this.available || !this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      /* ignore */
    }
  }

  abort(): void {
    if (!this.available || !this.recognition) return;
    try {
      this.recognition.abort();
    } catch {
      /* ignore */
    }
    this.recognition = null;
  }
}
