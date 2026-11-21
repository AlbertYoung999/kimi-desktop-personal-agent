import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelProject, ChannelSession, ChannelTree } from '../shared/types.js';
import { allChannelMeta, listChannelProjects, metaGet, metaSet, setChannelArchived } from './db.js';
import { getSessionIndex } from './store.js';

/**
 * SessionScanner(design/design-v7.md §2.1):channel 模式的主数据源。
 * 扫描 `$KIMI_CODE_HOME/sessions/wd_*\/session_*\/state.json`(默认 ~/.kimi-code),
 * 与 sqlite 的 channel_meta / channel_projects 按 sessionId 合并,输出按 cwd 分组的项目树。
 *
 * 官方警告:sessions/ 目录只读——本模块绝不向其中写任何文件(写会破坏 session 恢复)。
 */

interface ScannerDeps {
  /** busy 状态从 ACPManager 注入(避免循环依赖) */
  isBusy: (sessionId: string) => boolean;
  /** fs.watch 监听变化后(debounce 2s)回调,由 index.ts 转发 ch:changed */
  onChanged: () => void;
}

/** state.json 里我们关心的字段(其余忽略,容忍 schema 漂移) */
interface SessionState {
  id?: string;
  cwd?: string;
  /** 旧 schema 是 ISO 字符串,新 schema 是 epoch 毫秒 */
  createdAt?: number | string;
  updatedAt?: number | string;
  archived?: boolean;
  /** 旧 schema 有 title;新 schema 没有(走 lastPrompt 回退链) */
  title?: string;
  lastPrompt?: string;
}

/** 时间解析:epoch 毫秒直接用,ISO 字符串 Date.parse,失败返回 null(调用方跳过该条) */
function parseTime(v: number | string | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const DEBOUNCE_MS = 2000;

/** sessions 根目录(尊重 KIMI_CODE_HOME;只读,官方警告写会破坏 session 恢复) */
export function sessionsRoot(): string {
  const home = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'sessions');
}

/**
 * 官方维护的 sessionId → workDir 映射(~/.kimi-code/session_index.jsonl,每行一个 JSON)。
 * 旧 schema session 的 cwd 从这里精确拿。文件不存在/坏行容错为空;重复 id 后写覆盖
 * (JSONL append-only,后一条更新;实测 1326 行无重复)。
 */
export function loadSessionIndex(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(path.dirname(sessionsRoot()), 'session_index.jsonl'), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { sessionId?: unknown; workDir?: unknown };
        if (typeof rec.sessionId === 'string' && typeof rec.workDir === 'string' && rec.workDir.length > 0) {
          map.set(rec.sessionId, rec.workDir);
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 文件不存在则容错为空 */
  }
  return map;
}

/** sid → cwd:在 sessions 目录里找该 session 的 state.json(IPC 层只传 sid,不知道路径规则) */
export function findSessionCwd(sessionId: string): string | null {
  const root = sessionsRoot();
  try {
    for (const wd of fs.readdirSync(root)) {
      if (!wd.startsWith('wd_')) continue;
      const stateFile = path.join(root, wd, sessionId, 'state.json');
      if (!fs.existsSync(stateFile)) continue;
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SessionState;
      if (state.cwd) return state.cwd;
    }
    // 旧 schema 的 state.json 无 cwd,回退官方 session_index.jsonl 的 workDir 映射
    const indexed = loadSessionIndex().get(sessionId);
    if (indexed) return indexed;
  } catch {
    /* best-effort */
  }
  return null;
}

/** kimi 注入的 system-reminder 是管道不是内容,replay/预览都要剥离(与 acp.ts loadSession 同款规则) */
function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** wd_ 目录名 → slug 段(去掉 wd_ 前缀和尾部的 _<hash>) */
function wdSlugOf(wdDirName: string): string {
  return wdDirName.slice(3).replace(/_[0-9a-f]{8,}$/i, '');
}

/** 归因比较用规范化:小写、去非字母数字(保留 CJK) */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

export const ARCHIVE_AGE_MS = 100 * 24 * 3600_000;

/**
 * 一次性历史整理(用户拍板的语义):
 * 仅在首次运行时,把 updatedAt 早于(迁移时刻 - 100 天)的 session 显式打 archived 标记;
 * 之后归档是 channel_meta 里的状态,绝不再按时间计算。幂等:meta 表有标记直接跳过。
 */
export function runArchiveMigration(now = Date.now()): number {
  if (metaGet('channel_archive_migrated')) return 0;
  const cutoff = now - ARCHIVE_AGE_MS;
  let marked = 0;
  const root = sessionsRoot();
  if (fs.existsSync(root)) {
    for (const wd of fs.readdirSync(root)) {
      if (!wd.startsWith('wd_')) continue;
      const wdDir = path.join(root, wd);
      let sessionDirs: string[];
      try {
        if (!fs.statSync(wdDir).isDirectory()) continue;
        sessionDirs = fs.readdirSync(wdDir);
      } catch {
        continue;
      }
      for (const sd of sessionDirs) {
        if (!sd.startsWith('session_')) continue;
        let state: SessionState;
        try {
          state = JSON.parse(fs.readFileSync(path.join(wdDir, sd, 'state.json'), 'utf8')) as SessionState;
        } catch {
          continue;
        }
        if (state.archived) continue; // kimi 自己已归档的不需要打标
        const updatedAt = parseTime(state.updatedAt) ?? parseTime(state.createdAt);
        if (updatedAt === null || updatedAt >= cutoff) continue;
        setChannelArchived(state.id ?? sd, true);
        marked++;
      }
    }
  }
  metaSet('channel_archive_migrated', String(cutoff)); // 记录 cutoff,便于事后审计
  console.log(`[scanner] archive migration done: ${marked} sessions archived (cutoff=${new Date(cutoff).toISOString()})`);
  return marked;
}

export class SessionScanner {
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(private deps: ScannerDeps) {}

  start(): void {
    const root = sessionsRoot();
    if (!fs.existsSync(root)) return;
    try {
      this.watcher = fs.watch(root, { recursive: true }, () => this.schedule());
    } catch {
      // recursive 不支持的平台退回只监听根目录(新建 wd_ 仍能感知)
      try {
        this.watcher = fs.watch(root, () => this.schedule());
      } catch (err) {
        console.warn('[scanner] fs.watch failed:', err);
      }
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.deps.onChanged(), DEBOUNCE_MS);
    this.debounce.unref();
  }

  /** 全量扫描 + 合并,输出项目树(ch:scan 的返回) */
  scan(): ChannelTree {
    const metas = new Map(allChannelMeta().map((m) => [m.session_id, m] as const));
    const index = new Map(getSessionIndex().map((s) => [s.sessionId, s] as const));
    const manualProjects = listChannelProjects();
    const officialIndex = loadSessionIndex(); // 官方 sessionId → workDir 映射(旧 schema 精确 cwd)

    interface Scanned {
      session: ChannelSession;
      cwd: string; // '' = 不可恢复(走 slug 归因兜底)
      wdSlug: string; // wd_ 目录的 slug 段(归因用)
      archived: boolean; // channel_meta 显式标记
    }

    // 1. 扫描磁盘,读全部 session(新旧两代 schema)
    const scanned: Scanned[] = [];
    const root = sessionsRoot();
    if (fs.existsSync(root)) {
      for (const wd of fs.readdirSync(root)) {
        if (!wd.startsWith('wd_')) continue;
        const wdDir = path.join(root, wd);
        let sessionDirs: string[];
        try {
          if (!fs.statSync(wdDir).isDirectory()) continue;
          sessionDirs = fs.readdirSync(wdDir);
        } catch {
          continue;
        }
        for (const sd of sessionDirs) {
          if (!sd.startsWith('session_')) continue;
          let state: SessionState;
          try {
            state = JSON.parse(fs.readFileSync(path.join(wdDir, sd, 'state.json'), 'utf8')) as SessionState;
          } catch {
            continue; // 写入中的半截文件 / 非 session 目录,跳过
          }
          if (state.archived) continue;
          // 旧 schema 无 id 字段,用目录名(session_xxx)
          const sid = state.id ?? sd;
          const updatedAt = parseTime(state.updatedAt) ?? parseTime(state.createdAt);
          if (updatedAt === null) continue; // 时间解析失败跳过该条
          const meta = metas.get(sid);
          const idx = index.get(sid);
          const lastPrompt = stripReminders(state.lastPrompt ?? '');
          scanned.push({
            session: {
              id: sid,
              // 旧 schema 直接用 state.title;新 schema 走原回退链
              title: state.title || idx?.title || lastPrompt.slice(0, 30) || '未命名会话',
              updatedAt,
              lastPrompt,
              lastMessage: meta?.last_message ?? '',
              pinned: meta?.pinned === 1,
              busy: this.deps.isBusy(sid),
              hasUpdate: updatedAt > (meta?.last_viewed_at ?? 0),
              ephemeral: idx?.kind === 'utility',
              agentId: meta?.agent_id ?? undefined,
            },
            cwd: state.cwd ?? officialIndex.get(sid) ?? '', // 新 schema > 官方 index > slug 归因兜底
            wdSlug: wdSlugOf(wd),
            archived: meta?.archived === 1,
          });
        }
      }
    }

    // 2. 归因表:已知 cwd 的 basename 规范化 → cwd 集合(唯一匹配才可信)
    const byNorm = new Map<string, Set<string>>();
    for (const { cwd } of scanned) {
      if (!cwd) continue;
      const key = normalizeName(path.basename(cwd));
      const set = byNorm.get(key) ?? new Set<string>();
      set.add(cwd);
      byNorm.set(key, set);
    }

    // 3. 分组:归档(显式标记)→ project_id 覆盖 → cwd → 归因 → 未分组
    const groups = new Map<string, ChannelProject>(); // key: `cwd:<cwd>` / `proj:<projectId>` / `bucket:*`
    const cwdGroup = (cwd: string): ChannelProject => {
      const key = `cwd:${cwd}`;
      let g = groups.get(key);
      if (!g) {
        g = { cwd, dirName: path.basename(cwd) || cwd, sessions: [] };
        groups.set(key, g);
      }
      return g;
    };
    const bucketGroup = (bucket: 'archive' | 'unsorted'): ChannelProject => {
      const key = `bucket:${bucket}`;
      let g = groups.get(key);
      if (!g) {
        g = { cwd: '', dirName: bucket === 'archive' ? '历史归档' : '未分组', bucket, sessions: [] };
        groups.set(key, g);
      }
      return g;
    };
    for (const { session, cwd, wdSlug, archived } of scanned) {
      // 归档 = 显式标记,最优先(哪怕有 cwd / project_id)
      if (archived) {
        bucketGroup('archive').sessions.push(session);
        continue;
      }
      // project_id 覆盖默认 cwd 分组(用户手动归类);指向已删除项目时回退常规分组
      const proj = manualProjects.find((p) => p.id === metas.get(session.id)?.project_id);
      if (proj) {
        const key = `proj:${proj.id}`;
        let g = groups.get(key);
        if (!g) {
          g = { cwd: proj.path ?? '', dirName: proj.name, projectId: proj.id, name: proj.name, sessions: [] };
          groups.set(key, g);
        }
        g.sessions.push(session);
        continue;
      }
      if (cwd) {
        cwdGroup(cwd).sessions.push(session);
        continue;
      }
      // cwd 不可恢复(旧 schema):wd_ slug 与已知项目 basename 规范化比较,唯一匹配则归因
      const candidates = byNorm.get(normalizeName(wdSlug));
      if (candidates && candidates.size === 1) {
        cwdGroup([...candidates][0]).sessions.push(session);
      } else {
        bucketGroup('unsorted').sessions.push(session);
      }
    }

    // 4. 手动项目:path 命中已有 cwd 组的合并进去(带上 projectId/name),其余补为空项目组
    for (const p of manualProjects) {
      if (groups.has(`proj:${p.id}`)) continue; // 上面已建
      const byPath = p.path ? groups.get(`cwd:${p.path}`) : undefined;
      if (byPath) {
        byPath.projectId = p.id;
        byPath.name = p.name;
      } else {
        groups.set(`proj:${p.id}`, {
          cwd: p.path ?? '',
          dirName: p.name,
          projectId: p.id,
          name: p.name,
          sessions: [],
        });
      }
    }

    // 5. 排序:组内置顶优先、再按最近活跃;组间按最新 session 时间
    for (const g of groups.values()) {
      g.sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    }
    const projects = [...groups.values()].sort(
      (a, b) => Math.max(0, ...b.sessions.map((s) => s.updatedAt)) - Math.max(0, ...a.sessions.map((s) => s.updatedAt)),
    );
    return { projects };
  }
}
