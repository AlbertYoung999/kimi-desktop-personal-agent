import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, PresetMode, SessionMeta } from '../shared/types.js';

function dataDir(): string {
  return app.getPath('userData');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** atomic write: tmp file + rename, so a crash mid-write never corrupts data */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const p = path.join(dataDir(), file);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

// ---------- settings ----------

export function defaultSettings(): AppSettings {
  const workspaceDir = path.join(os.homedir(), 'KimiWorkspace');
  return {
    workspaceDir,
    vaultDir: path.join(workspaceDir, 'vault'),
    permissionMode: 'default',
  };
}

export function getSettings(): AppSettings {
  return { ...defaultSettings(), ...readJson<Partial<AppSettings>>('settings.json', {}) };
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  if (patch.workspaceDir && !patch.vaultDir) {
    next.vaultDir = path.join(patch.workspaceDir, 'vault');
  }
  writeJson('settings.json', next);
  return next;
}

// ---------- sessions index (fallback / local cache) ----------

export function getSessionIndex(): SessionMeta[] {
  return readJson<SessionMeta[]>('sessions.json', []);
}

export function upsertSession(meta: SessionMeta): void {
  const prev = getSessionIndex().find((s) => s.sessionId === meta.sessionId);
  if (prev?.kind && !meta.kind) meta.kind = prev.kind; // preserve category across title updates
  const list = getSessionIndex().filter((s) => s.sessionId !== meta.sessionId);
  list.unshift(meta);
  writeJson('sessions.json', list.slice(0, 200));
}

export function removeSessionFromIndex(sessionId: string): void {
  writeJson('sessions.json', getSessionIndex().filter((s) => s.sessionId !== sessionId));
}

export function setSessionKind(sessionId: string, kind: 'chat' | 'auto'): void {
  const list = getSessionIndex();
  const entry = list.find((s) => s.sessionId === sessionId);
  if (entry) {
    entry.kind = kind;
    writeJson('sessions.json', list);
  } else {
    // session not in index yet (e.g. created by another client) — remember the override
    list.unshift({ sessionId, cwd: '', title: '', createdAt: Date.now(), updatedAt: Date.now(), kind });
    writeJson('sessions.json', list);
  }
}

// ---------- preset modes ----------

interface ModesFile {
  overrides: Record<string, PresetMode>;
  deletedBuiltinIds: string[];
}

function readModesFile(): ModesFile {
  const raw = readJson<unknown>('modes.json', null);
  if (raw && typeof raw === 'object') {
    if ('overrides' in raw || 'deletedBuiltinIds' in raw) {
      const f = raw as Partial<ModesFile>;
      return { overrides: f.overrides ?? {}, deletedBuiltinIds: f.deletedBuiltinIds ?? [] };
    }
    // legacy format: plain Record<id, PresetMode>
    return { overrides: raw as Record<string, PresetMode>, deletedBuiltinIds: [] };
  }
  return { overrides: {}, deletedBuiltinIds: [] };
}

function writeModesFile(file: ModesFile): void {
  writeJson('modes.json', file);
}

const BUILTIN_MODES: PresetMode[] = [
  {
    id: 'translate',
    name: '翻译',
    icon: '🌐',
    prompt:
      '你是一个翻译助手。规则：自动识别中英互译；先给译文，再给 2 个地道例句（附翻译），最后列出 3 个近义词并简辨析。输出用 markdown 分节，简洁。',
    builtin: true,
  },
  {
    id: 'explain',
    name: '解释代码',
    icon: '💡',
    prompt:
      '你是一个代码讲解助手。用通俗的中文解释用户给出的代码：先一句话概括作用，再分点讲关键逻辑，最后指出潜在问题或可优化点。',
    builtin: true,
  },
  {
    id: 'polish',
    name: '润色',
    icon: '✍️',
    prompt:
      '你是一个文字润色助手。在不改变原意的前提下润色用户给出的文字，使其更通顺、专业。先给润色后的全文，再简要说明主要改动。',
    builtin: true,
  },
  {
    id: 'summarize',
    name: '总结',
    icon: '📝',
    prompt:
      '你是一个总结助手。把用户给出的内容浓缩成要点列表（不超过 5 条），每条一句话，最后给出一句话结论。',
    builtin: true,
  },
];

export function listModes(): PresetMode[] {
  const file = readModesFile();
  const merged = BUILTIN_MODES.filter((m) => !file.deletedBuiltinIds.includes(m.id)).map(
    (m) => file.overrides[m.id] ?? m,
  );
  for (const [id, m] of Object.entries(file.overrides)) {
    if (!BUILTIN_MODES.some((b) => b.id === id)) merged.push(m);
  }
  return merged;
}

export function saveMode(mode: PresetMode): PresetMode[] {
  const file = readModesFile();
  file.overrides[mode.id] = mode;
  file.deletedBuiltinIds = file.deletedBuiltinIds.filter((id) => id !== mode.id);
  writeModesFile(file);
  return listModes();
}

export function deleteMode(id: string): PresetMode[] {
  const file = readModesFile();
  delete file.overrides[id];
  if (BUILTIN_MODES.some((b) => b.id === id) && !file.deletedBuiltinIds.includes(id)) {
    file.deletedBuiltinIds.push(id);
  }
  writeModesFile(file);
  return listModes();
}

export function findMode(id: string | null): PresetMode | null {
  if (!id) return null;
  return listModes().find((m) => m.id === id) ?? null;
}
