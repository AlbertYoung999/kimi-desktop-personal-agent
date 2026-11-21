import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { app } from 'electron';

/** Piper 本地 TTS provider：单二进制 + onnx 语音模型，首次使用自动下载。 */

export interface PiperVoiceDef {
  id: string;
  label: string;
  cjk: boolean;
  url: string;
}

const BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';
const v = (id: string, label: string, cjk: boolean, path: string): PiperVoiceDef => ({
  id,
  label,
  cjk,
  url: `${BASE}/${path}`,
});

/** Piper 音色目录（zh 目前只有 huayan 两档；en 精选 12 个） */
export const PIPER_CATALOG: PiperVoiceDef[] = [
  v('zh_CN-huayan-medium', '华研（中）', true, 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx'),
  v('zh_CN-huayan-x_low', '华研 低沉（中）', true, 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx'),
  v('en_US-amy-medium', 'Amy（英）', false, 'en/en_US/amy/medium/en_US-amy-medium.onnx'),
  v('en_US-arctic-medium', 'Arctic（英）', false, 'en/en_US/arctic/medium/en_US-arctic-medium.onnx'),
  v('en_US-bryce-medium', 'Bryce（英）', false, 'en/en_US/bryce/medium/en_US-bryce-medium.onnx'),
  v('en_US-hfc_female-medium', 'HFC 女声（英）', false, 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx'),
  v('en_US-hfc_male-medium', 'HFC 男声（英）', false, 'en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx'),
  v('en_US-joe-medium', 'Joe（英）', false, 'en/en_US/joe/medium/en_US-joe-medium.onnx'),
  v('en_US-john-medium', 'John（英）', false, 'en/en_US/john/medium/en_US-john-medium.onnx'),
  v('en_US-kathleen-low', 'Kathleen（英）', false, 'en/en_US/kathleen/low/en_US-kathleen-low.onnx'),
  v('en_US-kristin-medium', 'Kristin（英）', false, 'en/en_US/kristin/medium/en_US-kristin-medium.onnx'),
  v('en_US-lessac-medium', 'Lessac（英）', false, 'en/en_US/lessac/medium/en_US-lessac-medium.onnx'),
  v('en_US-lessac-high', 'Lessac 高音（英）', false, 'en/en_US/lessac/high/en_US-lessac-high.onnx'),
  v('en_US-libritts-high', 'LibriTTS 高音（英）', false, 'en/en_US/libritts/high/en_US-libritts-high.onnx'),
];

const VOICES = new Map(PIPER_CATALOG.map((d) => [d.id, d]));

export const DEFAULT_VOICE_EN = 'en_US-amy-medium';
export const DEFAULT_VOICE_ZH = 'zh_CN-huayan-medium';

function ttsDir(): string {
  const dir = path.join(app.getPath('userData'), 'tts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function venvPython(): string {
  return path.join(ttsDir(), 'venv', 'bin', 'python');
}

/** 快速探测本机常见 HTTP 代理端口，仅在可达时注入（可达性优先，避免无代理环境下 pip 直连失败） */
function probePort(port: number, timeout = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(timeout);
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(false));
  });
}

async function proxyEnv(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };
  if (env.HTTPS_PROXY || env.https_proxy) return env;
  for (const port of [7897, 7890, 1087, 8080]) {
    if (await probePort(port)) {
      env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
      env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      break;
    }
  }
  return env;
}

async function ensureVenv(): Promise<void> {
  if (fs.existsSync(venvPython())) return;
  console.log('[tts] creating python venv + installing piper-tts…');
  await new Promise<void>((resolve, reject) => {
    execFile('python3', ['-m', 'venv', path.join(ttsDir(), 'venv')], (err) => (err ? reject(err) : resolve()));
  });
  const env = await proxyEnv();
  await new Promise<void>((resolve, reject) => {
    execFile(venvPython(), ['-m', 'pip', 'install', '-q', 'piper-tts'], { env, timeout: 600_000 }, (err) =>
      err ? reject(new Error(`pip install piper-tts failed: ${String(err).slice(0, 200)}`)) : resolve(),
    );
  });
  console.log('[tts] piper-tts ready');
}

function modelPath(voiceId: string): string {
  return path.join(ttsDir(), 'models', `${voiceId}.onnx`);
}

function curl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-fSL', '--retry', '2', '-o', dest, url], { timeout: 600_000 }, (err) => {
      if (err) reject(new Error(`download failed: ${url}`));
      else resolve();
    });
  });
}

async function ensureBinary(): Promise<void> {
  // 官方 macOS 包是 x86_64 且缺 espeak-ng 动态库（坏包），改用 pip 版 piper-tts
  await ensureVenv();
}

async function ensureVoice(voiceId: string): Promise<string> {
  const def = VOICES.get(voiceId);
  if (!def) throw new Error(`unknown piper voice: ${voiceId}`);
  const model = modelPath(voiceId);
  if (!fs.existsSync(model)) {
    console.log('[tts] downloading voice', voiceId);
    fs.mkdirSync(path.dirname(model), { recursive: true });
    await curl(def.url, model);
    await curl(`${def.url}.json`, `${model}.json`);
  }
  return model;
}

/** 预检：piper 可用性（不下载，仅报告）。 */
export function piperStatus(): { binary: boolean; voices: string[] } {
  return {
    binary: fs.existsSync(venvPython()),
    voices: PIPER_CATALOG.map((d) => d.id).filter((v) => fs.existsSync(modelPath(v))),
  };
}

let current: ChildProcess | null = null;

/** 合成到 wav 文件(ensureBinary/ensureVoice 已完成);piperSpeak/piperSynth 共用 */
function synthToFile(text: string, model: string, wav: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    current = execFile(venvPython(), ['-m', 'piper', '--model', model, '--output-file', wav, '--', text], (err) => {
      current = null;
      if (err) reject(new Error(`piper failed: ${String(err).slice(0, 200)}`));
      else resolve();
    });
  });
}

export async function piperSpeak(text: string, voiceId: string): Promise<void> {
  await ensureBinary();
  const model = await ensureVoice(voiceId);
  const wav = path.join(ttsDir(), `out-${Date.now()}.wav`);
  try {
    await synthToFile(text, model, wav);
    await new Promise<void>((resolve) => {
      current = execFile('afplay', [wav], () => {
        current = null;
        resolve();
      });
    });
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}

/** 合成 wav 返回 Buffer(不播放;RemoteBridge /api/tts 用),临时文件用完即删 */
export async function piperSynth(text: string, voiceId: string): Promise<Buffer> {
  await ensureBinary();
  const model = await ensureVoice(voiceId);
  const wav = path.join(ttsDir(), `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    await synthToFile(text, model, wav);
    return fs.readFileSync(wav);
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
}

export function piperStop(): void {
  if (current) {
    current.kill();
    current = null;
  }
}

export function piperVoices(): { id: string; cjk: boolean }[] {
  return [
    { id: DEFAULT_VOICE_EN, cjk: false },
    { id: DEFAULT_VOICE_ZH, cjk: true },
  ];
}
