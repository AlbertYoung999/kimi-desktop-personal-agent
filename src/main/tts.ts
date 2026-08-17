import { execFile, type ChildProcess } from 'node:child_process';

/** macOS `say`-based TTS. Jarvis default: Daniel (en_GB); CJK text uses a Chinese voice. */

let voices: string[] | null = null;
let current: ChildProcess | null = null;

function probeVoices(): Promise<string[]> {
  if (voices) return Promise.resolve(voices);
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], (err, stdout) => {
      voices = err ? [] : stdout.split('\n').map((l) => l.split(/\s{2,}/)[0]?.trim()).filter(Boolean);
      resolve(voices);
    });
  });
}

function pickVoice(text: string, available: string[]): string | null {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const isCjk = cjk > text.length * 0.15;
  const preferred = isCjk
    ? ['Ting-Ting', 'Eddy (中文（中国大陆）)', 'Flo (中文（中国大陆）)']
    : ['Daniel', 'Eddy (英语（英国）)', 'Alex'];
  for (const v of preferred) {
    if (available.some((a) => a === v || a.startsWith(v))) return v;
  }
  return null; // system default voice
}

/** Strip markdown so the voice reads plain prose. */
export function toSpeechText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\n{2,}/g, '。')
    .replace(/\n/g, '，')
    .trim()
    .slice(0, 1200);
}

export async function speak(text: string): Promise<void> {
  stopSpeaking();
  const plain = toSpeechText(text);
  if (!plain) return;
  const available = await probeVoices();
  const voice = pickVoice(plain, available);
  const args = voice ? ['-v', voice, plain] : [plain];
  await new Promise<void>((resolve) => {
    current = execFile('say', args, () => {
      current = null;
      resolve();
    });
  });
}

export function stopSpeaking(): void {
  if (current) {
    current.kill();
    current = null;
  }
}
