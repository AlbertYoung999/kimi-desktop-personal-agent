/**
 * 统一 TTS 播报（流式版）：订阅主会话的流式输出，句子级切分 + 串行播报队列。
 * 首音延迟 ≈ 第一句完成时间（通常 1-3s），不再等全文。
 *
 * 规则：
 * - 只说完整句（句末标点 。！？!?…\n 且长度 ≥ 4 才出句），turnDone 时 flush 残余
 * - ``` 代码围栏内内容不入语音（围栏可跨 chunk）；thinking（thought chunk）不入语音
 * - 新一轮回合 → 清队列、打断当前播报、从头开始
 * - 播报语言跟随回复内容的主语言（首句判定时锁定，整段统一不切换）
 */

let mainSid: string | null = null;
let buffer = '';
let inFence = false;
let queue: string[] = [];
let playing = false;
let turnActive = false;
/** 本轮回复的播报语言：跟随回复内容的主语言（首句判定时锁定，整段统一） */
let turnLang: 'zh' | 'en' | null = null;

const SENTENCE_END = /[。！？!?…\n]/;

function detectLang(text: string): 'zh' | 'en' {
  const letters = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!letters) return 'zh';
  const cjk = (letters.match(/[一-鿿]/g) ?? []).length;
  return cjk / letters.length > 0.15 ? 'zh' : 'en';
}

/** 从 buffer 提取完整句入队 */
function drainSentences(minLen = 4): void {
  let out = '';
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (buffer.startsWith('```', i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence) continue;
    out += ch;
    if (SENTENCE_END.test(ch) && out.trim().length >= minLen) {
      // 首句出句时锁定本轮声音：按回复内容的主语言判定（不再跟随用户输入）
      if (turnLang === null) turnLang = detectLang(out);
      queue.push(out.trim());
      out = '';
    }
  }
  buffer = out;
}

async function pump(): Promise<void> {
  if (playing) return;
  playing = true;
  try {
    while (queue.length > 0) {
      const sentence = queue.shift()!;
      await window.kimi.ttsSpeak(sentence, turnLang ?? undefined).catch(() => undefined);
    }
  } finally {
    playing = false;
  }
}

function resetTurn(): void {
  buffer = '';
  inFence = false;
  queue = [];
  window.kimi.ttsStop();
}

export function initVoice(): void {
  void window.kimi
    .getSettings()
    .then((s) => {
      mainSid = s.mainSessionId ?? null;
    })
    .catch(() => undefined);
  // 主会话轮换时同步新 id（否则过滤失效，TTS 静默）
  window.kimi.onMainSession((p) => {
    mainSid = p.sessionId;
  });
  const isMain = (sid: string): boolean => mainSid == null || sid === mainSid;

  window.kimi.onChunk((e) => {
    if (!isMain(e.sessionId) || e.kind !== 'text') return;
    if (!turnActive) {
      // 新一轮回合开始（声音在本轮首句出句时按内容判定）
      resetTurn();
      turnActive = true;
      turnLang = null;
    }
    buffer += e.text;
    drainSentences();
    if (queue.length > 0) void pump();
  });

  window.kimi.onTurnDone((e) => {
    if (!isMain(e.sessionId)) return;
    turnActive = false;
    // flush 残余缓冲作为最后一句
    const tail = buffer.trim();
    buffer = '';
    inFence = false;
    if (tail.length >= 2) queue.push(tail);
    void pump();
  });
}
