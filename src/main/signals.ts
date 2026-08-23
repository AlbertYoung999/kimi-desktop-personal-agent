/** Signals bus (design-v4 §5.2): the system's senses. Ring buffer of typed
 *  events; the main session prompt injects a digest of recent signals. */

export interface Signal {
  type: string; // 'evolve' | 'radar' | 'focus' | 'task' | 'widget' | 'system'
  at: number;
  text: string; // one-line human/agent-readable summary
}

const CAP = 500;
const buffer: Signal[] = [];

export function recordSignal(type: string, text: string): void {
  buffer.push({ type, at: Date.now(), text });
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

/** recent signals as a compact digest for prompt injection */
export function recentDigest(limit = 20, maxChars = 1500): string {
  const recent = buffer.slice(-limit);
  if (recent.length === 0) return '';
  const lines = recent.map((s) => {
    const t = new Date(s.at);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    return `- [${hh}:${mm}] ${s.text}`;
  });
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

export function allSignals(): Signal[] {
  return [...buffer];
}
