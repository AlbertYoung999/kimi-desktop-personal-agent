import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { WebContents } from 'electron';
import { IPC } from '../shared/types.js';
import type { HistoryItem, SessionMeta } from '../shared/types.js';
import { getSettings, upsertSession } from './store.js';

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

  constructor(private getChatContents: () => WebContents | null) {}

  private emit(channel: string, payload: unknown): void {
    const wc = this.getChatContents();
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
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
    const agentsMd = path.join(workspaceDir, 'AGENTS.md');
    if (!fs.existsSync(agentsMd)) {
      fs.writeFileSync(
        agentsMd,
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
        ].join('\n'),
      );
    }
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
            this.emit(IPC.evToolCall, {
              sessionId: params.sessionId,
              toolCallId: tc.toolCallId,
              title: tc.title,
              status: tc.status,
            });
            break;
          }
          case 'tool_call_update': {
            if (this.replaying.has(params.sessionId)) break;
            const tc = update as acp.ToolCallUpdate;
            if (tc.status) {
              this.emit(IPC.evToolCall, {
                sessionId: params.sessionId,
                toolCallId: tc.toolCallId,
                title: tc.title ?? '',
                status: tc.status,
              });
            }
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

        if (settings.permissionMode === 'yolo' || this.sessionAllow.has(params.sessionId)) {
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
        const p = this.resolveAllowedPath(params.path);
        return { content: fs.readFileSync(p, 'utf8') };
      },

      writeTextFile: async (params: acp.WriteTextFileRequest) => {
        const p = this.resolveAllowedPath(params.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, params.content);
        return {};
      },
    };
  }

  /** fs reverse-RPC sandbox: only paths under workspaceDir (vault included). */
  private resolveAllowedPath(p: string): string {
    const workspace = path.resolve(getSettings().workspaceDir);
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

  async dispose(): Promise<void> {
    this.child?.kill();
    this.child = null;
    this.conn = null;
    this.startPromise = null;
  }
}
