import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { recordSignal } from './signals.js';
import { wbRoot } from './workbench.js';

/**
 * Evolution journal (design-evolve.md §E2): every MCP tool execution is logged
 * append-only; undoable tools snapshot their domain file(s) before mutation.
 */

interface EvolveEntry {
  at: number;
  tool: string;
  params: Record<string, unknown>;
  result: string;
}

interface UndoFrame {
  tool: string;
  at: number;
  /** absolute file path → content before mutation (null = file didn't exist) */
  snapshots: { file: string; content: string | null }[];
}

const UNDO_CAP = 50;

function logDir(): string {
  const dir = path.join(wbRoot(), 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logEvolve(entry: EvolveEntry): void {
  fs.appendFileSync(path.join(logDir(), 'evolve.jsonl'), JSON.stringify(entry) + '\n');
  recordSignal('evolve', `${entry.tool}: ${entry.result.slice(0, 80)}`);
}

export function readEvolveLog(limit = 50): EvolveEntry[] {
  try {
    const raw = fs.readFileSync(path.join(logDir(), 'evolve.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EvolveEntry)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

// ---- undo stack ----

function undoPath(): string {
  return path.join(logDir(), 'evolve-undo.json');
}

function readUndoStack(): UndoFrame[] {
  try {
    return JSON.parse(fs.readFileSync(undoPath(), 'utf8')) as UndoFrame[];
  } catch {
    return [];
  }
}

function writeUndoStack(stack: UndoFrame[]): void {
  fs.writeFileSync(undoPath(), JSON.stringify(stack.slice(-UNDO_CAP)));
}

/** Snapshot the given files, execute fn, journal it, and push an undo frame. */
export async function journaled(
  tool: string,
  params: Record<string, unknown>,
  domainFiles: string[],
  fn: () => Promise<string> | string,
): Promise<string> {
  const snapshots = domainFiles.map((file) => ({
    file,
    content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
  }));
  const result = await fn();
  logEvolve({ at: Date.now(), tool, params, result });
  if (snapshots.length > 0) {
    const stack = readUndoStack();
    stack.push({ tool, at: Date.now(), snapshots });
    writeUndoStack(stack);
  }
  return result;
}

/** Push an undo frame with pre-captured snapshots (for mutations that happen
 *  outside journaled(), e.g. agent-edited source files). */
export function pushUndoFrame(tool: string, snapshots: { file: string; content: string | null }[]): void {
  const stack = readUndoStack();
  stack.push({ tool, at: Date.now(), snapshots });
  writeUndoStack(stack);
}

/** Restore the most recent undo frame; returns a human summary + restored files. */
export function undoLast(): { message: string; restoredFiles: string[] } {
  const stack = readUndoStack();
  const frame = stack.pop();
  if (!frame) return { message: '没有可撤销的操作', restoredFiles: [] };
  for (const snap of frame.snapshots) {
    if (snap.file.startsWith('db://')) {
      // data_exec 的行级快照：回插到对应表
      try {
        const table = snap.file.slice(5);
        const rows = JSON.parse(snap.content ?? '[]') as Record<string, unknown>[];
        const db = getDb();
        for (const row of rows) {
          const cols = Object.keys(row);
          db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
            ...cols.map((c) => row[c]),
          );
        }
      } catch {
        /* best-effort restore */
      }
      continue;
    }
    if (snap.content === null) fs.rmSync(snap.file, { force: true });
    else {
      fs.mkdirSync(path.dirname(snap.file), { recursive: true });
      fs.writeFileSync(snap.file, snap.content);
    }
  }
  writeUndoStack(stack);
  logEvolve({ at: Date.now(), tool: 'evolve_undo', params: {}, result: `撤销了 ${frame.tool}` });
  return {
    message: `已撤销最近一次操作（${frame.tool}，${new Date(frame.at).toLocaleTimeString('zh-CN')}）`,
    restoredFiles: frame.snapshots.map((s) => s.file),
  };
}
