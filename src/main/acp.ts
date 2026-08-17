import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { app } from 'electron';
import type { WebContents } from 'electron';
import { IPC } from '../shared/types.js';
import type { HistoryItem, SessionMeta } from '../shared/types.js';
import { getSettings, removeSessionFromIndex, upsertSession } from './store.js';
import { writeManagedBlock } from './workbench.js';

const PROTOCOL_VERSION = 1;

interface PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void;
}

/** Extract plain text from a chunk-ish payload, tolerating shape drift. */
function chunkText(update: unknown): string {
  const u = update as { content?: { type?: string; text?: string }; chunk?: { content?: { type?: string; text?: string } } };
  if (u.content?.type === 'text' && typeof u.content.text === 'string') return u.content.text;
  const nested = u.chunk?.content;
  if (nested?.type === 'text' && typeof nested.text === 'string') return nested.text;
  return '';
}

export class ACPManager {
  private child: ChildProcess | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private pendingPermissions = new Map<string, PendingPermission>();
  /** sessionIds currently replaying history via session/load */
  private replaying = new Map<string, { role: 'user' | 'agent'; text: string }[]>();
  /** permission decisions remembered per session */
  private sessionAllow = new Set<string>();
  /** toolCallId → last known title (updates often arrive without one) */
  private toolTitles = new Map<string, string>();
  /** dedicated session for workbench quick-ask (Command Center fallback) */
  private workbenchSessionId: string | null = null;
  /** dedicated session for the voice-first home page */
  private homeSessionId: string | null = null;
  /** workbench MCP server url, mounted on the command-center session */
  private workbenchMcpUrl: string | null = null;

  setWorkbenchMcpUrl(url: string): void {
    this.workbenchMcpUrl = url;
  }

  constructor(
    private getChatContents: () => WebContents | null,
    private getWorkbenchContents: () => WebContents | null = () => null,
    private getHomeContents: () => WebContents | null = () => null,
  ) {}

  private emit(channel: string, payload: unknown): void {
    for (const wc of [this.getChatContents(), this.getWorkbenchContents(), this.getHomeContents()]) {
      if (wc && !wc.isDestroyed()) wc.send(channel, payload);
    }
  }

  private async ensureStarted(): Promise<acp.ClientSideConnection> {
    if (this.conn) return this.conn;
    this.startPromise ??= this.start();
    await this.startPromise;
    if (!this.conn) throw new Error('kimi acp 启动失败');
    return this.conn;
  }

  private async start(): Promise<void> {
    const settings = getSettings();
    fs.mkdirSync(settings.workspaceDir, { recursive: true });
    this.sweepTrashedSessions(); // must run before kimi spawns
    this.ensureWorkspaceScaffold(settings.workspaceDir);

    this.child = spawn('kimi', ['acp'], {
      cwd: settings.workspaceDir,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env },
    });
    this.child.on('exit', (code) => {
      console.error(`[acp] kimi acp exited with code ${code}`);
      this.conn = null;
      this.child = null;
      this.startPromise = null;
    });
    this.child.on('error', (err) => {
      console.error('[acp] failed to spawn kimi:', err);
      this.conn = null;
      this.child = null;
      this.startPromise = null;
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );
    const conn = new acp.ClientSideConnection(() => this.makeClient(), stream);

    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'kimi-desktop', version: '0.1.0' },
    });
    try {
      await conn.authenticate({ methodId: 'login' });
    } catch (err) {
      // already authenticated or method missing — sessions will surface auth errors if any
      console.warn('[acp] authenticate skipped:', err);
    }
    this.conn = conn;
    console.log('[acp] connected, cwd =', settings.workspaceDir);
  }

  /** Drop AGENTS.md + vault dir into the workspace so the agent knows the vault convention. */
  private ensureWorkspaceScaffold(workspaceDir: string): void {
    fs.mkdirSync(path.join(workspaceDir, 'vault'), { recursive: true });
    writeManagedBlock(
      workspaceDir,
      [
        '# Kimi 桌面助手工作区约定',
        '',
        '用户通过桌面悬浮窗与你对话。除了回答问题时，你还承担「收藏夹 / 灵感记录」的职责：',
        '',
        '- 当用户说「收藏」「记下来」「记一下」「这个想法不错」等类似意图时，把内容整理成一条 markdown 记录，写入 `vault/` 目录。',
        '- 文件按类别分目录（如 `vault/ideas/`、`vault/to-read/`、`vault/notes/`），文件名用日期+简短 slug，例如 `vault/ideas/2026-08-05-desktop-pet.md`。',
        '- 文件内容用 markdown：一级标题即主题，正文简洁，保留用户给的原始链接。',
        '- 记录后简短回复：已收藏到哪个文件。若用户想修改某条记录，直接编辑对应文件。',
        '',
        '## Widget Forge 生成约定',
        '',
        '当用户通过 Widget Forge 请求生成 widget 时：',
        '',
        '- 输出单个自包含 HTML 片段（内联 <style>/<script>，无外部依赖），用 ```html 围栏包裹，首行 `<!-- title: 名称 -->`。',
        '- **不要把代码写入文件**，最终代码必须直接输出在回复正文里（围栏内）；可以用工具验证数据源的可用性，但不要落盘任何文件。',
        '- 它就是一个普通的独立 widget，**放手做**：宿主已放开跨域限制，可以用 fetch 调任何公开免费的数据源（股票、天气、汇率、API 等），优先真实数据。',
        '- **不要预设限制**——不要因为"可能跨域/可能需要 key"就拒绝尝试或只给静态演示；把加载态、错误态、重试按钮做进 widget 里，运行时出问题用户在界面上能看到。',
        '- 结构清晰，便于后续差量微调。',
      ].join('\n'),
    );
  }

  private makeClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case 'user_message_chunk': {
            if (this.replaying.has(params.sessionId)) {
              this.appendReplay(params.sessionId, 'user', chunkText(update));
            }
            break;
          }
          case 'agent_message_chunk': {
            const text = chunkText(update);
            if (!text) break;
            const collector = this.collectors.get(params.sessionId);
            if (collector) collector.push(text);
            if (this.replaying.has(params.sessionId)) {
              this.appendReplay(params.sessionId, 'agent', text);
            } else {
              this.emit(IPC.evChunk, { sessionId: params.sessionId, kind: 'text', text });
            }
            break;
          }
          case 'agent_thought_chunk': {
            const text = chunkText(update);
            if (text && !this.replaying.has(params.sessionId)) {
              this.emit(IPC.evChunk, { sessionId: params.sessionId, kind: 'thought', text });
            }
            break;
          }
          case 'tool_call': {
            if (this.replaying.has(params.sessionId)) break;
            const tc = update as acp.ToolCall;
            const title = tc.title ?? '';
            if (title) this.toolTitles.set(tc.toolCallId, title);
            this.emit(IPC.evToolCall, {
              sessionId: params.sessionId,
              toolCallId: tc.toolCallId,
              title: title || (this.toolTitles.get(tc.toolCallId) ?? ''),
              status: tc.status,
              detail: tc.rawInput ? JSON.stringify(tc.rawInput).slice(0, 160) : undefined,
            });
            break;
          }
          case 'tool_call_update': {
            if (this.replaying.has(params.sessionId)) break;
            const tc = update as acp.ToolCallUpdate;
            if (tc.title) this.toolTitles.set(tc.toolCallId, tc.title);
            const title = tc.title ?? this.toolTitles.get(tc.toolCallId) ?? '';
            this.emit(IPC.evToolCall, {
              sessionId: params.sessionId,
              toolCallId: tc.toolCallId,
              title,
              status: tc.status ?? '',
              detail: tc.rawInput ? JSON.stringify(tc.rawInput).slice(0, 160) : undefined,
            });
            break;
          }
          default:
            break;
        }
      },

      requestPermission: async (params: acp.RequestPermissionRequest) => {
        const settings = getSettings();
        const options = params.options;
        const pick = (kind: acp.PermissionOptionKind) =>
          options.find((o) => o.kind === kind) ?? options[0];

        // our own workbench MCP tools are safe by construction — never prompt for them
        // (the permission bar lives in the chat window, invisible while using the workbench)
        const toolTitle = params.toolCall.title ?? '';
        if (toolTitle.startsWith('mcp__workbench__')) {
          return { outcome: { outcome: 'selected', optionId: pick('allow_once').optionId } };
        }

        if (
          settings.permissionMode === 'yolo' ||
          this.sessionAllow.has(params.sessionId) ||
          this.autoApproveSessions.has(params.sessionId)
        ) {
          return { outcome: { outcome: 'selected', optionId: pick('allow_always').optionId } };
        }
        if (settings.permissionMode === 'auto') {
          return { outcome: { outcome: 'selected', optionId: pick('allow_once').optionId } };
        }

        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const title = params.toolCall.title ?? '工具调用';
        const raw = params.toolCall.rawInput;
        this.permissionOptions.set(requestId, options);
        this.emit(IPC.evPermission, {
          requestId,
          sessionId: params.sessionId,
          title,
          description: raw ? JSON.stringify(raw).slice(0, 300) : '',
        });
        return new Promise((resolve) => {
          this.pendingPermissions.set(requestId, { resolve });
        });
      },

      readTextFile: async (params: acp.ReadTextFileRequest) => {
        const p = this.resolveAllowedPath(params.path, params.sessionId);
        return { content: fs.readFileSync(p, 'utf8') };
      },

      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        const p = this.resolveAllowedPath(params.path, params.sessionId);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, params.content);
        return {};
      },
    };
  }

  /** sessionId → cwd (sessions may be bound to the repo for self-modification) */
  private sessionCwds = new Map<string, string>();

  private registerSessionCwd(sessionId: string, cwd: string): void {
    this.sessionCwds.set(sessionId, path.resolve(cwd));
  }

  /** fs reverse-RPC sandbox: paths must stay under the session's own cwd. */
  private resolveAllowedPath(p: string, sessionId?: string): string {
    const workspace = (sessionId && this.sessionCwds.get(sessionId)) ?? path.resolve(getSettings().workspaceDir);
    const resolved = path.resolve(workspace, p);
    if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
      throw new Error(`path outside workspace rejected: ${p}`);
    }
    return resolved;
  }

  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    if (approved && remember && sessionId) this.sessionAllow.add(sessionId);
    // We don't keep the original options here; re-derive from kind preference on the agent side
    // by answering with a synthesized outcome is not possible — so we stored options at request time.
    pending.resolve(this.buildOutcome(requestId, approved, remember));
  }

  private permissionOptions = new Map<string, acp.PermissionOption[]>();

  private buildOutcome(
    requestId: string,
    approved: boolean,
    remember: boolean,
  ): acp.RequestPermissionResponse {
    const options = this.permissionOptions.get(requestId) ?? [];
    this.permissionOptions.delete(requestId);
    const byKind = (kind: acp.PermissionOptionKind) => options.find((o) => o.kind === kind);
    const option =
      (approved ? byKind(remember ? 'allow_always' : 'allow_once') ?? byKind('allow_once') : byKind('reject_once')) ??
      options[0];
    if (!option) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }

  private appendReplay(sessionId: string, role: 'user' | 'agent', text: string): void {
    const buf = this.replaying.get(sessionId);
    if (!buf) return;
    const last = buf[buf.length - 1];
    if (last && last.role === role) last.text += text;
    else buf.push({ role, text });
  }

  async listSessions(): Promise<SessionMeta[]> {
    const conn = await this.ensureStarted();
    const settings = getSettings();
    try {
      const res = await conn.listSessions({ cwd: settings.workspaceDir });
      return res.sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd ?? settings.workspaceDir,
        title: s.title ?? '未命名会话',
        createdAt: s.updatedAt ? Date.parse(s.updatedAt) : Date.now(),
        updatedAt: s.updatedAt ? Date.parse(s.updatedAt) : Date.now(),
      }));
    } catch (err) {
      console.warn('[acp] session/list failed, falling back to local index:', err);
      const { getSessionIndex } = await import('./store.js');
      return getSessionIndex();
    }
  }

  async newSession(): Promise<SessionMeta> {
    const conn = await this.ensureStarted();
    const settings = getSettings();
    const res = await conn.newSession({ cwd: settings.workspaceDir, mcpServers: [] });
    this.registerSessionCwd(res.sessionId, settings.workspaceDir);
    await this.applySessionConfig(res.sessionId);
    const meta: SessionMeta = {
      sessionId: res.sessionId,
      cwd: settings.workspaceDir,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertSession(meta);
    return meta;
  }

  private async applySessionConfig(sessionId: string): Promise<void> {
    if (!this.conn) return;
    const mode = getSettings().permissionMode;
    try {
      await this.conn.setSessionConfigOption({ sessionId, configId: 'mode', value: mode });
    } catch (err) {
      console.warn('[acp] set_config_option(mode) failed:', err);
    }
  }

  async loadSession(sessionId: string): Promise<{ meta: SessionMeta; history: HistoryItem[] }> {
    const conn = await this.ensureStarted();
    const settings = getSettings();
    this.replaying.set(sessionId, []);
    try {
      await conn.loadSession({ sessionId, cwd: settings.workspaceDir, mcpServers: [] });
    } finally {
      // small grace period for trailing replay notifications
      await new Promise((r) => setTimeout(r, 150));
    }
    const history = this.replaying.get(sessionId) ?? [];
    this.replaying.delete(sessionId);
    await this.applySessionConfig(sessionId);
    const meta: SessionMeta = {
      sessionId,
      cwd: settings.workspaceDir,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return { meta, history };
  }

  async prompt(sessionId: string, text: string, modePrompt: string | null, image: { data: string; mimeType: string } | null): Promise<void> {
    const conn = await this.ensureStarted();
    const finalText = modePrompt ? `${modePrompt}\n\n用户输入：\n${text}` : text;
    const blocks: acp.ContentBlock[] = [];
    if (image) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    if (finalText.trim()) blocks.push({ type: 'text', text: finalText });
    const res = await conn.prompt({ sessionId, prompt: blocks });
    upsertSession({
      sessionId,
      cwd: getSettings().workspaceDir,
      title: text.slice(0, 30),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.emit(IPC.evTurnDone, { sessionId, stopReason: res.stopReason });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    await this.conn.cancel({ sessionId });
  }

  /** Mark a session as auto-approved for all permission requests. */
  setSessionAllow(sessionId: string, allowed: boolean): void {
    if (allowed) this.sessionAllow.add(sessionId);
    else this.sessionAllow.delete(sessionId);
  }

  /** Quick-ask from the workbench Command Center: reuses a dedicated session
   *  with the workbench MCP server mounted (native tool calling). */
  /** Prompt a managed session; if the session's on-disk state is corrupted
   *  (e.g. storage append failed), recreate the session and retry once. */
  private promptManaged(kind: 'workbench' | 'home', sid: string, text: string, retried: boolean): void {
    void this.prompt(sid, text, null, null).catch(async (err) => {
      const message = String(err);
      const corrupted = /storage append|does not exist|Internal error/i.test(message);
      if (corrupted && !retried) {
        console.warn(`[acp] ${kind} session ${sid} corrupted, recreating:`, message);
        if (kind === 'workbench') this.workbenchSessionId = null;
        else this.homeSessionId = null;
        try {
          const newSid = await (kind === 'workbench' ? this.newWorkbenchSession() : this.newHomeSession());
          this.promptManaged(kind, newSid, text, true);
          return;
        } catch (err2) {
          console.warn('[acp] session recreate failed:', err2);
        }
      }
      this.emit(IPC.evChunk, { sessionId: sid, kind: 'text', text: `⚠ ${message}` });
      this.emit(IPC.evTurnDone, { sessionId: sid, stopReason: 'error' });
    });
  }

  private async newWorkbenchSession(): Promise<string> {
    const conn = await this.ensureStarted();
    const mcpServers = this.workbenchMcpUrl
      ? [{ type: 'http' as const, name: 'workbench', url: this.workbenchMcpUrl, headers: [] }]
      : [];
    const res = await conn.newSession({ cwd: getSettings().workspaceDir, mcpServers });
    this.registerSessionCwd(res.sessionId, getSettings().workspaceDir);
    this.workbenchSessionId = res.sessionId;
    await this.applySessionConfig(res.sessionId);
    return res.sessionId;
  }

  private async newHomeSession(): Promise<string> {
    const conn = await this.ensureStarted();
    const res = await conn.newSession({ cwd: getSettings().workspaceDir, mcpServers: [] });
    this.registerSessionCwd(res.sessionId, getSettings().workspaceDir);
    this.homeSessionId = res.sessionId;
    await this.applySessionConfig(res.sessionId);
    return res.sessionId;
  }

  async workbenchAsk(text: string): Promise<string> {
    const sid = this.workbenchSessionId ?? (await this.newWorkbenchSession());
    this.promptManaged('workbench', sid, text, false);
    return sid;
  }

  /** Home page ask: dedicated session, same streaming pattern. */
  async homeAsk(text: string): Promise<string> {
    const sid = this.homeSessionId ?? (await this.newHomeSession());
    this.promptManaged('home', sid, text, false);
    return sid;
  }

  /** Create a fresh ACP session seeded with a task's JSON context (Task Flow → Session). */
  async startTaskSession(taskPayload: string): Promise<string> {
    const meta = await this.newSession();
    void this.prompt(meta.sessionId, taskPayload, null, null).catch(() => {});
    return meta.sessionId;
  }

  /** response collectors for askOnce (radar structuring etc.) */
  private collectors = new Map<string, string[]>();
  /** throwaway askOnce sessions: auto-approve their tool permissions (they only generate text) */
  private autoApproveSessions = new Set<string>();
  /**
   * Shared utility session for all askOnce calls (forge / radar / artifact_modify).
   * One session reused instead of a new session per call; serialized via a queue
   * (kimi rejects concurrent prompts on one session) and rotated every N uses to
   * bound context growth. Rotated/quit sessions go to the startup trash sweep.
   */
  private utilitySessions = new Map<string, { id: string; uses: number }>();
  private static readonly UTILITY_ROTATE_AFTER = 6;
  private askQueue: Promise<unknown> = Promise.resolve();

  /** Shared utility sessions, keyed by cwd ('' = workspace default). Reused
   *  across askOnce calls, rotated every N uses to bound context growth. */
  private async utilitySession(cwd?: string): Promise<string> {
    const key = cwd ?? '';
    const entry = this.utilitySessions.get(key);
    if (!entry || entry.uses >= ACPManager.UTILITY_ROTATE_AFTER) {
      if (entry) this.trashSession(entry.id);
      const conn = await this.ensureStarted();
      const effectiveCwd = cwd ?? getSettings().workspaceDir;
      const res = await conn.newSession({ cwd: effectiveCwd, mcpServers: [] });
      this.registerSessionCwd(res.sessionId, effectiveCwd);
      await this.applySessionConfig(res.sessionId);
      this.utilitySessions.set(key, { id: res.sessionId, uses: 0 });
    }
    const current = this.utilitySessions.get(key)!;
    current.uses++;
    return current.id;
  }

  /** One-shot question; resolves with the full reply text. Calls are serialized
   *  onto a shared utility session and the session recycles itself.
   *  `cwd` binds the session to another directory (e.g. the app repo for
   *  self-modification — kimi's fs tools are sandboxed to the session cwd). */
  async askOnce(text: string, timeoutMs = 180_000, cwd?: string): Promise<string> {
    const run = this.askQueue.then(() => this.askOnceInner(text, timeoutMs, cwd));
    this.askQueue = run.catch(() => {});
    return run;
  }

  private async askOnceInner(text: string, timeoutMs: number, cwd?: string): Promise<string> {
    const sid = await this.utilitySession(cwd);
    const buf: string[] = [];
    this.collectors.set(sid, buf);
    this.autoApproveSessions.add(sid);
    try {
      await Promise.race([
        this.prompt(sid, text, null, null),
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new Error(`生成超时（${Math.round(timeoutMs / 1000)}s），请重试`)), timeoutMs),
        ),
      ]);
      return buf.join('');
    } finally {
      this.collectors.delete(sid);
      this.autoApproveSessions.delete(sid);
      void this.cancel(sid).catch(() => {});
    }
  }

  /** Trash-bin for throwaway askOnce sessions: kimi flushes session storage
   *  asynchronously, so deleting right after prompt() returns races its writes
   *  and corrupts the agent's in-memory state. We record the id here and sweep
   *  the files at next app start (before spawning kimi) instead. */
  private trashSession(sessionId: string): void {
    try {
      const file = path.join(app.getPath('userData'), 'trash-sessions.json');
      const list: string[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      list.push(sessionId);
      fs.writeFileSync(file, JSON.stringify(list));
      removeSessionFromIndex(sessionId);
    } catch {
      /* best-effort */
    }
  }

  /** Delete trashed session dirs from disk. Must run before kimi is spawned. */
  private sweepTrashedSessions(): void {
    try {
      const file = path.join(app.getPath('userData'), 'trash-sessions.json');
      if (!fs.existsSync(file)) return;
      const list = JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
      const root = path.join(os.homedir(), '.kimi-code', 'sessions');
      for (const sessionId of list) {
        for (const wd of fs.readdirSync(root)) {
          const candidate = path.join(root, wd, sessionId);
          if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn('[acp] sweep trashed sessions failed:', err);
    }
  }

  async dispose(): Promise<void> {
    for (const entry of this.utilitySessions.values()) this.trashSession(entry.id);
    this.child?.kill();
    this.child = null;
    this.conn = null;
    this.startPromise = null;
  }
}
