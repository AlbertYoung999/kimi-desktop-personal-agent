import { execFile, type ChildProcess } from 'node:child_process';
import { getSettings, saveSettings } from './store.js';
import { DEFAULT_VOICE_EN, DEFAULT_VOICE_ZH, PIPER_CATALOG, piperSpeak, piperStop } from './tts/piper.js';

/** macOS `say`-based TTS. 按回复主语言选声（整段一个声音），声音/语速可配置。 */

let voices: string[] | null = null;
let current: ChildProcess | null = null;

const RATE_MAP: Record<string, number> = { slow: 140, normal: 175, fast: 210 };

function probeVoices(): Promise<string[]> {
  if (voices) return Promise.resolve(voices);
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], (err, stdout) => {
      voices = err ? [] : stdout.split('\n').map((l) => l.split(/\s{2,}/)[0]?.trim()).filter(Boolean);
      resolve(voices);
    });
  });
}

export async function listTtsVoices(): Promise<{
  voices: string[];
  selectedEn: string;
  selectedZh: string;
  rate: string;
  provider: string;
  piperVoices: { id: string; label: string; cjk: boolean }[];
  piperEn: string;
  piperZh: string;
}> {
  const available = await probeVoices();
  const settings = getSettings();
  return {
    voices: available,
    selectedEn: settings.ttsVoiceEn ?? 'Daniel',
    selectedZh: settings.ttsVoiceZh ?? 'Ting-Ting',
    rate: settings.ttsRate ?? 'normal',
    provider: settings.ttsProvider ?? 'piper',
    piperVoices: PIPER_CATALOG.map((d) => ({ id: d.id, label: d.label, cjk: d.cjk })),
    piperEn: settings.ttsPiperVoiceEn ?? DEFAULT_VOICE_EN,
    piperZh: settings.ttsPiperVoiceZh ?? DEFAULT_VOICE_ZH,
  };
}

export function setTtsVoice(en: string, zh: string, rate: string): void {
  saveSettings({ ttsVoiceEn: en, ttsVoiceZh: zh, ttsRate: rate });
}

export function setTtsProvider(provider: 'piper' | 'say'): void {
  saveSettings({ ttsProvider: provider });
}

export function setTtsPiperVoice(en: string, zh: string): void {
  saveSettings({ ttsPiperVoiceEn: en, ttsPiperVoiceZh: zh });
}

function resolveVoice(want: string | undefined, fallbacks: string[], available: string[]): string | null {
  if (want) {
    const hit = available.find((a) => a === want || a.startsWith(want));
    if (hit) return hit;
  }
  for (const v of fallbacks) {
    const hit = available.find((a) => a === v || a.startsWith(v));
    if (hit) return hit;
  }
  return null;
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

/** 整段按主语言选声：CJK 占比超 30% 用中文声，否则英文声（不做句中切换） */
function isMostlyCjk(text: string): boolean {
  const letters = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!letters) return false;
  const cjk = (letters.match(/[一-鿿]/g) ?? []).length;
  return cjk / letters.length > 0.3;
}

export async function speak(text: string, lang?: 'zh' | 'en'): Promise<void> {
  stopSpeaking();
  const plain = toSpeechText(text);
  if (!plain) return;
  const provider = getSettings().ttsProvider ?? 'piper';
  const cjk = lang ? lang === 'zh' : isMostlyCjk(plain);
  console.log(`[tts] provider=${provider} lang=${lang ?? 'auto'} cjk=${cjk}`);
  if (provider === 'piper') {
    try {
      const voice = cjk
        ? (getSettings().ttsPiperVoiceZh ?? DEFAULT_VOICE_ZH)
        : (getSettings().ttsPiperVoiceEn ?? DEFAULT_VOICE_EN);
      await piperSpeak(plain, voice);
      return;
    } catch (err) {
      console.warn('[tts] piper failed, falling back to say:', err);
    }
  }
  const available = await probeVoices();
  const settings = getSettings();
  const voice = cjk
    ? resolveVoice(settings.ttsVoiceZh, ['Ting-Ting', 'Eddy (中文（中国大陆）)', 'Flo (中文（中国大陆）)'], available)
    : resolveVoice(settings.ttsVoiceEn, ['Daniel', 'Eddy (英语（英国）)', 'Alex'], available);
  await speakRaw(plain, voice, RATE_MAP[settings.ttsRate ?? 'normal'] ?? 175);
}

function speakRaw(text: string, voice: string | null, rate?: number): Promise<void> {
  const args = voice ? ['-v', voice] : [];
  if (rate) args.push('-r', String(rate));
  args.push(text);
  return new Promise<void>((resolve) => {
    current = execFile('say', args, () => {
      current = null;
      resolve();
    });
  });
}

/** 试听某个声音（不改动配置） */
export async function previewVoice(voice: string, sample: string): Promise<void> {
  stopSpeaking();
  await speakRaw(sample, voice, RATE_MAP.normal);
}

export function stopSpeaking(): void {
  piperStop();
  if (current) {
    current.kill();
    current = null;
  }
}
