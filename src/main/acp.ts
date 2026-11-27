import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { app } from 'electron';
import type { WebContents } from 'electron';
import { IPC } from '../shared/types.js';
import type { AppSettings, HistoryItem, OpenSessionResult, SessionMeta } from '../shared/types.js';
import { getSessionIndex, getSettings, removeSessionFromIndex, saveSettings, upsertSession } from './store.js';
import { allChannelMeta, deleteChannelMeta, setChannelAgent, setChannelLastMessage, setChannelMode, setChannelModel, setChannelThinking } from './db.js';
import { getAgent, readAgentMd } from './agent-library.js';
import { buildInjectionPrompt, ensureSessionConfigDir, readSessionConfig, sessionConfigDir, writeSessionConfig } from './session-config.js';
import { findSessionCwd } from './session-scanner.js';
import { CAPABILITIES } from './capabilities.js';
import { systemDigest } from './digest.js';
import { recentDigest } from './signals.js';
import { ensureMemoryFile, memoryPath, readMemory, writeManagedBlock } from './workbench.js';

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
  /** workbench MCP server url, mounted on the command-center session */
  private workbenchMcpUrl: string | null = null;
  /** initialize 返回的能力位(design/design-v7.md §3.1:channel 功能按能力降级) */
  private agentCapabilities: acp.AgentCapabilities | null = null;

  getCapabilities(): acp.AgentCapabilities | null {
    return this.agentCapabilities;
  }

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
    for (const cb of this.listeners) cb(channel, payload); // 进程内订阅(RemoteBridge SSE)
  }

  /** 进程内事件订阅(与 emit 广播同通道同 payload);返回注销函数 */
  addListener(cb: (channel: string, payload: unknown) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private listeners = new Set<(channel: string, payload: unknown) => void>();

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

    const initRes = await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'kimi-desktop', version: '0.1.0' },
    });
    this.agentCapabilities = initRes.agentCapabilities ?? null;
    try {
      await conn.authenticate({ methodId: 'login' });
    } catch (err) {
      // already authenticated or method missing — sessions will surface auth errors if any
      console.warn('[acp] authenticate skipped:', err);
    }
    this.conn = conn;
    console.log('[acp] connected, cwd =', settings.workspaceDir);
  }

  /** AGENTS.md 的 managed 区：静态约定 + 从能力清单动态生成的工具一览 */
  private buildManagedContent(): string {
    const disabled = new Set(getSettings().disabledTools ?? []);
    const toolLines = CAPABILITIES.filter((c) => !disabled.has(c.name)).map(
      (c) => `- \`${c.name}\`：${c.description}${c.usage ? `（${c.usage}）` : ''}`,
    );
    return [
      '# Kimi 桌面助手工作区约定',
      '',
      '用户通过桌面悬浮窗与你对话。除了回答问题时，你还承担「收藏夹 / 灵感记录」的职责：',
      '',
      '- 当用户说「收藏」「记下来」「记一下」「这个想法不错」等类似意图时，把内容整理成一条 markdown 记录，写入 `vault/` 目录。',
      '- 文件按类别分目录（如 `vault/ideas/`、`vault/to-read/`、`vault/notes/`），文件名用日期+简短 slug，例如 `vault/ideas/2026-08-05-desktop-pet.md`。',
      '- 文件内容用 markdown：一级标题即主题，正文简洁，保留用户给的原始链接。',
      '- 记录后简短回复：已收藏到哪个文件。若用户想修改某条记录，直接编辑对应文件。',
      '',
      '## 长期记忆（memory.md）',
      '',
      `你的长期记忆保存在 ${memoryPath()}（对话时会作为 [长期记忆] 注入你的上下文）。`,
      '',
      '- 当用户透露值得长期记住的信息（偏好、习惯、重要事实、明确要求「记住」的内容）时，把该文件追加一条简短条目（`- [YYYY-MM-DD] 内容`）。',
      '- 保持条目精炼；过时或用户要求遗忘的信息及时删除或更新。',
      '- 不要把临时对话细节写进去——只记长期有用的。',
      '',
      '## 呈现协议（Generative Presentation）',
      '',
      '你可以通过 workbench 的 MCP 工具把结果「做给用户看」，而不只是文字回复：',
      '',
      '- **什么时候呈现**：新闻/榜单/数据对比/调研结果/多条目信息——凡是有结构、值得看的内容，都应该 `present_artifact` 生成卡片，同时用一句话语音/文字总结。纯闲聊、单句回答不需要呈现。',
      '- **present_artifact 的 spec**：`kind`（news-digest=新闻列表 / data-card=数据卡 / gallery=图片网格 / list=通用列表 / custom=自由HTML）+ `title` + `items[{title, summary?, image?, url?, tag?}]` + 可选 `actions[{label, action}]`。规则：',
      '  - items 最多 7 条（少而精），title 一行、summary 两行以内；',
      '  - image 只用真实可访问的 http(s) URL，不要编造；',
      '  - 拿不准用哪个 kind 就用 list；模板满足不了再用 custom。',
      '- **present**：用户说「打开 xxx」时调用，在 Zen 挂出组件；没有该组件时先创建再打开。',
      '- **dismiss**：用户说「关掉 xxx / 关掉刚才那个」时调用，`target` 传名称或 `latest`。',
      '- 呈现后告诉用户卡片已在 Zen 打开；用户不满意时，你可以调整 spec 重新呈现。',
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
      '',
      '## 数据访问（Agent Loop）',
      '',
      '所有业务数据在 jarvis.db（SQLite）里，别猜结构、别碰 JSON 文件：',
      '',
      '1. 先看结构：`data_schema()`（表/列/行数）',
      '2. 再查数据：`data_query("SELECT …")`（只读，覆盖 tasks/radar_items/radars/library/projects/engines/signals）',
      '3. 改数据：纯字段修正（改标题/标已读/调优先级/删条目）→ `data_exec`（UPDATE/DELETE 必须带 WHERE）；带行为的操作（创建任务/完成重复任务/建雷达/呈现/改组件）→ 用对应的专用工具',
      '4. 你的每次修改都会记录并可撤销（evolve_undo），放心做、做错了也能回滚',
      '',
      '## 可用系统工具（当前启用）',
      '',
      '以下工具通过 workbench MCP 提供，回答「系统里有什么」先用 `system_query` 查实时数据，不要猜：',
      '',
      ...toolLines,
      '',
    ].join('\n');
  }

  /** Drop AGENTS.md + vault dir into the workspace so the agent knows the vault convention. */
  private ensureWorkspaceScaffold(workspaceDir: string): void {
    fs.mkdirSync(path.join(workspaceDir, 'vault'), { recursive: true });
    ensureMemoryFile();
    writeManagedBlock(workspaceDir, this.buildManagedContent());
  }

  private makeClient(): acp.Client {
    return {
      sessionUpdate: async (params: acp.SessionNotification) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case 'user_message_chunk': {
            const text = chunkText(update);
            if (this.replaying.has(params.sessionId)) {
              this.appendReplay(params.sessionId, 'user', chunkText(update));
            } else if (text) {
              // live user message from another surface (zen / command center) —
              // forward so every window sees the full conversation
              this.emit(IPC.evChunk, { sessionId: params.sessionId, kind: 'user', text });
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
              // live chunk:同时进 turn ring buffer(live 接管补放 + 最后一条消息落库)
              const buf = this.turnBuffers.get(params.sessionId) ?? [];
              buf.push(text);
              this.turnBuffers.set(params.sessionId, buf);
              this.appendRecentAgent(params.sessionId, text); // 滚动最近消息(跨轮次 live 接管)
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
          case 'current_mode_update': {
            // 模式回传:终端 TUI /yolo 等外部改动 → 持久化 + 广播,UI 同步。
            // 我们自己 setSessionConfigOption 的回执也走这里——与有效值(覆盖 ?? 全局)比对,
            // 相同则不落库(否则每次 applySessionConfig 都会制造一个假的 session 覆盖)
            const modeId = (update as acp.CurrentModeUpdate).currentModeId;
            if (modeId) {
              const effective = this.sessionModeOverride(params.sessionId) ?? getSettings().permissionMode;
              if (modeId !== effective) setChannelMode(params.sessionId, modeId);
              this.emit(IPC.evSessionMode, { sessionId: params.sessionId, modeId });
            }
            break;
          }
          case 'config_option_update': {
            // 模型/思考深度回传:TUI /model、/thinking 等外部改动 → 持久化 + 广播。
            // guard:仅当已有覆盖且与覆盖不同时才落库——无覆盖时 kimi 的初始推送
            // 只是汇报当前值,落库会把「跟随默认」冻结成假覆盖(session 的配置
            // 本就存在 kimi 服务端,不持久化也不丢)。事件始终广播。
            const cu = update as acp.ConfigOptionUpdate;
            const modelOpt = cu.configOptions?.find((o) => o.id === 'model');
            const current = modelOpt?.type === 'select' ? String(modelOpt.currentValue) : null;
            if (current) {
              if (getSettings().modelCurrent !== current) saveSettings({ modelCurrent: current });
              const effective = this.sessionModelOverride(params.sessionId);
              if (effective && current !== effective) setChannelModel(params.sessionId, current);
              this.emit(IPC.evSessionModel, { sessionId: params.sessionId, model: current });
            }
            const thinkingOpt = cu.configOptions?.find((o) => o.id === 'thinking');
            const thinking = thinkingOpt?.type === 'select' ? String(thinkingOpt.currentValue) : null;
            if (thinking) {
              const effective = this.sessionThinkingOverride(params.sessionId);
              if (effective && thinking !== effective) setChannelThinking(params.sessionId, thinking);
              this.emit(IPC.evSessionThinking, { sessionId: params.sessionId, thinking });
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
          // AskUserQuestion 的 questions/options JSON 在 rawInput 里,截太短会丢关键内容
          description: raw ? JSON.stringify(raw).slice(0, 1000) : '',
          // 多选项问题(AskUserQuestion)需要完整选项列表才能作答
          options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
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

  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string, optionId?: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    if (approved && remember && sessionId) this.sessionAllow.add(sessionId);
    // 显式 optionId(多选项问题,如 AskUserQuestion):直接以该选项作答,不再按 kind 推导
    if (optionId) {
      const options = this.permissionOptions.get(requestId) ?? [];
      this.permissionOptions.delete(requestId);
      const option = options.find((o) => o.optionId === optionId);
      pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
      return;
    }
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
    const kindOf = new Map(getSessionIndex().map((s) => [s.sessionId, s.kind] as const));
    const mainId = settings.mainSessionId;
    try {
      const res = await conn.listSessions({ cwd: settings.workspaceDir });
      return res.sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd ?? settings.workspaceDir,
        title: s.title ?? '未命名会话',
        createdAt: s.updatedAt ? Date.parse(s.updatedAt) : Date.now(),
        updatedAt: s.updatedAt ? Date.parse(s.updatedAt) : Date.now(),
        kind: kindOf.get(s.sessionId) ?? 'auto',
        main: s.sessionId === mainId || undefined,
      }));
    } catch (err) {
      console.warn('[acp] session/list failed, falling back to local index:', err);
      const { getSessionIndex } = await import('./store.js');
      return getSessionIndex();
    }
  }

  async newSession(kind: 'chat' | 'auto' = 'auto', cwd?: string): Promise<SessionMeta> {
    const conn = await this.ensureStarted();
    const settings = getSettings();
    // channel 页可在指定项目目录下建会话;默认仍是 workspaceDir(悬浮窗行为不变)
    const sessionCwd = cwd ?? settings.workspaceDir;
    // user-facing chat sessions get the workbench MCP too — any surface is a
    // system agent with the same capability plane (design-v4 §11)
    const mcpServers =
      kind === 'chat' && this.workbenchMcpUrl
        ? [{ type: 'http' as const, name: 'workbench', url: this.workbenchMcpUrl, headers: [] }]
        : [];
    const res = await conn.newSession({ cwd: sessionCwd, mcpServers });
    this.registerSessionCwd(res.sessionId, sessionCwd);
    if (mcpServers.length > 0) this.attachedWithMcp.add(res.sessionId); // 建时即带 MCP,无需 hook 补挂
    this.cacheModelOptions(res.configOptions);
    await this.applySessionConfig(res.sessionId);
    const meta: SessionMeta = {
      sessionId: res.sessionId,
      cwd: sessionCwd,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind,
    };
    upsertSession(meta);
    return meta;
  }

  /** per-session 权限模式覆盖(channel_meta.mode),NULL=跟随全局 */
  private sessionModeOverride(sessionId: string): string | null {
    return allChannelMeta().find((m) => m.session_id === sessionId)?.mode ?? null;
  }

  /** per-session 模型覆盖(channel_meta.model),NULL=跟随 kimi 默认 */
  private sessionModelOverride(sessionId: string): string | null {
    return allChannelMeta().find((m) => m.session_id === sessionId)?.model ?? null;
  }

  /** per-session 思考深度覆盖(channel_meta.thinking),NULL=跟随全局 thinking 设置 */
  private sessionThinkingOverride(sessionId: string): string | null {
    return allChannelMeta().find((m) => m.session_id === sessionId)?.thinking ?? null;
  }

  /** 模型选项缓存(内存 + settings.json 持久化),供渲染层随时拉取 */
  private modelOptions: { value: string; name: string }[] | null = null;

  /** newSession/fork 返回的 configOptions 里缓存 id='model' 的选项 */
  private cacheModelOptions(configOptions?: acp.SessionConfigOption[] | null): void {
    const opt = configOptions?.find((o) => o.id === 'model');
    if (!opt || opt.type !== 'select' || opt.options.length === 0) return;
    // options 可能是平铺项或分组项(SessionConfigSelectGroup),拍平成 {value,name}
    const options = opt.options.flatMap((o) =>
      'options' in o ? o.options.map((sub) => ({ value: sub.value, name: sub.name })) : [{ value: o.value, name: o.name }],
    );
    if (options.length === 0) return;
    this.modelOptions = options;
    const current = String(opt.currentValue ?? '');
    const patch: Partial<AppSettings> = {};
    if (JSON.stringify(getSettings().modelOptions) !== JSON.stringify(options)) patch.modelOptions = options;
    if (current && getSettings().modelCurrent !== current) patch.modelCurrent = current;
    if (Object.keys(patch).length > 0) saveSettings(patch);
  }

  private static readonly BUILTIN_MODEL_OPTIONS = [
    { value: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview' },
    { value: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Code Highspeed' },
    { value: 'kimi-code/k3', name: 'K3' },
    { value: 'kimi-code/k3-256k', name: 'K3-256k' },
    { value: 'kimi-code/k3.1-pro', name: 'K3.1 Pro' },
    { value: 'kimi-code/k3.1-pro-highspeed', name: 'K3.1 Pro Highspeed 2x Usage Cost' },
  ];

  getModelOptions(): { value: string; name: string }[] {
    // 缓存(内存→settings)与内置列表取并集:老缓存缺新模型时立即补齐, kimi 侧新增模型时也不丢
    const cached = this.modelOptions ?? getSettings().modelOptions ?? [];
    const seen = new Set(cached.map((o) => o.value));
    return [...cached, ...ACPManager.BUILTIN_MODEL_OPTIONS.filter((o) => !seen.has(o.value))];
  }

  private async applySessionConfig(sessionId: string): Promise<void> {
    if (!this.conn) return;
    // per-session 覆盖优先,无覆盖回退全局(实测 set_config_option 会话中途切换立即生效)
    const mode = this.sessionModeOverride(sessionId) ?? getSettings().permissionMode;
    try {
      await this.conn.setSessionConfigOption({ sessionId, configId: 'mode', value: mode });
    } catch (err) {
      console.warn('[acp] set_config_option(mode) failed:', err);
    }
    // per-session 模型覆盖:建 session/load 时一并推送(mode 逻辑不动)
    const model = this.sessionModelOverride(sessionId);
    if (model) {
      try {
        await this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: model });
      } catch (err) {
        console.warn('[acp] set_config_option(model) failed:', err);
      }
    }
    // per-session 思考深度覆盖优先,无覆盖回退全局(全局是 boolean,映射 high/low)
    const thinkingOverride = this.sessionThinkingOverride(sessionId);
    const globalThinking = getSettings().thinking;
    const thinking = thinkingOverride ?? (globalThinking !== undefined ? (globalThinking ? 'high' : 'low') : null);
    if (thinking !== null) {
      try {
        await this.conn.setSessionConfigOption({ sessionId, configId: 'thinking', value: thinking });
      } catch {
        /* older kimi without thinking config */
      }
    }
  }

  /** 切换主会话的 thinking 模式（即时生效 + 持久化） */
  async setThinking(on: boolean): Promise<void> {
    saveSettings({ thinking: on });
    if (this.mainSessionId && this.conn) {
      try {
        await this.conn.setSessionConfigOption({ sessionId: this.mainSessionId, configId: 'thinking', value: on ? 'high' : 'low' });
      } catch (err) {
        console.warn('[acp] set thinking failed:', err);
      }
    }
  }

  /**
   * per-session 权限模式(ch:set-session-mode):非 null 落库 + 立即生效;
   * null 清除覆盖并按全局重设一次。session 不在内存/已断开时容错——落库即可,
   * 下次 load/openSession 的 applySessionConfig 会重放覆盖。
   */
  async setSessionMode(sessionId: string, mode: 'default' | 'auto' | 'yolo' | 'plan' | null): Promise<void> {
    setChannelMode(sessionId, mode);
    if (!this.conn) return;
    const effective = mode ?? getSettings().permissionMode;
    try {
      await this.conn.setSessionConfigOption({ sessionId, configId: 'mode', value: effective });
    } catch (err) {
      console.warn('[acp] setSessionMode 即时生效失败(覆盖已落库,下次 openSession 重放):', err);
    }
  }

  /** ch:get-session-mode:无覆盖返回全局值 + source='global' */
  getSessionMode(sessionId: string): { mode: string; source: 'session' | 'global' } {
    const override = this.sessionModeOverride(sessionId);
    return override ? { mode: override, source: 'session' } : { mode: getSettings().permissionMode, source: 'global' };
  }

  /**
   * per-session 模型(ch:set-session-model,对标 setSessionMode):
   * 非 null 落库 + 立即生效;null 清除覆盖(不主动重设,kimi 侧保留当前值)。
   * 即时生效失败仅告警——覆盖已落库,下次 load 重放。
   */
  async setSessionModel(sessionId: string, model: string | null): Promise<void> {
    setChannelModel(sessionId, model);
    if (!this.conn || model === null) return;
    try {
      await this.conn.setSessionConfigOption({ sessionId, configId: 'model', value: model });
    } catch (err) {
      console.warn('[acp] setSessionModel 即时生效失败(覆盖已落库,下次 openSession 重放):', err);
    }
  }

  /** ch:get-session-model:无覆盖返回 null + source='default'(跟随 kimi 默认) */
  getSessionModel(sessionId: string): { model: string | null; source: 'session' | 'default' } {
    const override = this.sessionModelOverride(sessionId);
    if (override) return { model: override, source: 'session' };
    // 无覆盖:返回观测到的当前模型(configOptions 缓存/外部切换推送),都没有才 null
    return { model: getSettings().modelCurrent ?? null, source: 'default' };
  }

  /**
   * per-session 思考深度(ch:set-session-thinking,对标 mode/model):
   * 非 null 落库 + 立即生效(支持 'low'|'high'|'max';max 仅 per-session 可选,全局设置不动);
   * null 清除覆盖回退全局(全局 boolean → 'high'|'low')。
   */
  async setSessionThinking(sessionId: string, thinking: 'low' | 'high' | 'max' | null): Promise<void> {
    setChannelThinking(sessionId, thinking);
    if (!this.conn || thinking === null) return;
    try {
      await this.conn.setSessionConfigOption({ sessionId, configId: 'thinking', value: thinking });
    } catch (err) {
      console.warn('[acp] setSessionThinking 即时生效失败(覆盖已落库,下次 openSession 重放):', err);
    }
  }

  /** ch:get-session-thinking:无覆盖返回全局值(boolean → 'high'|'low')+ source='global' */
  getSessionThinking(sessionId: string): { thinking: string; source: 'session' | 'global' } {
    const override = this.sessionThinkingOverride(sessionId);
    if (override) return { thinking: override, source: 'session' };
    return { thinking: getSettings().thinking ? 'high' : 'low', source: 'global' };
  }

  async loadSession(sessionId: string): Promise<{ meta: SessionMeta; history: HistoryItem[]; live?: boolean }> {
    const conn = await this.ensureStarted();
    const settings = getSettings();
    const meta: SessionMeta = {
      sessionId,
      cwd: settings.workspaceDir,
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // A session with an in-flight turn must not be touched AT ALL — both
    // session/load and session/resume cancel the running turn (verified
    // against kimi 0.31.1). The chunks already flow to this connection;
    // just tell the renderer to watch live.
    if (this.busySessions.has(sessionId)) {
      return { meta, history: [], live: true };
    }
    this.replaying.set(sessionId, []);
    try {
      await conn.loadSession({ sessionId, cwd: settings.workspaceDir, mcpServers: [] });
    } finally {
      // small grace period for trailing replay notifications
      await new Promise((r) => setTimeout(r, 150));
    }
    const history = (this.replaying.get(sessionId) ?? [])
      .map((item) => ({
        ...item,
        // kimi injects system-reminders into continued turns; they're plumbing, not content
        text: item.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim(),
      }))
      .filter((item) => item.text.length > 0);
    this.replaying.delete(sessionId);
    await this.applySessionConfig(sessionId);
    return { meta, history };
  }

  /** sessions with an in-flight prompt turn (load would interrupt them) */
  private busySessions = new Set<string>();

  /**
   * 终端接管中的 session(design/design-v7.md §12,铁律:时分复用)。
   * L3 内嵌/L2 外开终端打开时标记,关闭(L3 自动)/「交还」按钮(L2 手动)时清除;
   * 并发双驱动会双写 wire.jsonl,所以 held 期间 ACP 侧禁止 prompt、禁止 load。
   */
  private heldSessions = new Set<string>();

  holdSession(sessionId: string): void {
    this.heldSessions.add(sessionId);
  }

  releaseSession(sessionId: string): void {
    this.heldSessions.delete(sessionId);
  }

  isHeld(sessionId: string): boolean {
    return this.heldSessions.has(sessionId);
  }

  /** 当前 turn 的 agent 文本 ring buffer(design/design-v7.md §2.3):live 接管补放 + 最后一条消息落库共用 */
  private turnBuffers = new Map<string, string[]>();
  /** openSession 令牌:快速连点切换时作废旧 load 的结果(design/design-v7.md §3.2) */
  private openTokens = new Map<string, number>();

  /**
   * 滚动最近消息缓冲(跨轮次,live 接管时给渲染层上下文):
   * prompt() 进 user 条目,live 的 agent chunk 累积进当前 turn 的 agent 条目;
   * 每 session 上限 20 条(超出 shift 淘汰),user 截 2000、agent 单条截 4000(保留前段)。
   * replay(loadSession 历史回放)不进这里——历史由 loadSession 的 history 路径覆盖。
   */
  private recentMessages = new Map<string, { role: 'user' | 'agent'; text: string; at: number }[]>();
  /** turn 进行中标记(agent chunk 据此决定就地追加还是开新条目) */
  private recentTurnOpen = new Set<string>();
  private static readonly RECENT_CAP = 20;

  isBusy(sessionId: string): boolean {
    return this.busySessions.has(sessionId);
  }

  private pushRecent(sessionId: string, entry: { role: 'user' | 'agent'; text: string; at: number }): void {
    const list = this.recentMessages.get(sessionId) ?? [];
    list.push(entry);
    while (list.length > ACPManager.RECENT_CAP) list.shift();
    this.recentMessages.set(sessionId, list);
  }

  /** live 的 agent chunk:turn 未结束且末尾是 agent 条目则就地追加,否则开新条目 */
  private appendRecentAgent(sessionId: string, text: string): void {
    const list = this.recentMessages.get(sessionId) ?? [];
    const last = list[list.length - 1];
    if (this.recentTurnOpen.has(sessionId) && last?.role === 'agent') {
      last.text = (last.text + text).slice(0, 4000);
      this.recentMessages.set(sessionId, list);
    } else {
      this.pushRecent(sessionId, { role: 'agent', text: text.slice(0, 4000), at: Date.now() });
    }
  }

  /** 决策#2:turn 结束把尾部最后一段 agent 文本(截断 500 字符)落 channel_meta */
  private flushTurnBuffer(sessionId: string): void {
    const buf = this.turnBuffers.get(sessionId);
    this.turnBuffers.delete(sessionId);
    if (!buf || buf.length === 0) return;
    const full = buf.join('').trim();
    if (!full) return;
    const last = full.split(/\n{2,}/).pop() ?? full;
    try {
      setChannelLastMessage(sessionId, last.slice(0, 500), Date.now());
    } catch (err) {
      console.warn('[acp] write channel_meta.last_message failed:', err);
    }
  }

  /**
   * 统一会话入口(design/design-v7.md §3.2,铁律:永不 load 忙中 session)。
   * channel 页选中 / 看板点击 / group 编排器都只准走这里;悬浮窗仍用 loadSession。
   */
  async openSession(sessionId: string): Promise<OpenSessionResult> {
    // 防抖令牌按 sessionId 隔离:只作废「同一 session 的过期加载」。
    // 全局单令牌会让多个消费方(远程 hub/工厂/moon 层)互相误杀,历史永远渲染不出来(实测)。
    const token = (this.openTokens.get(sessionId) ?? 0) + 1;
    this.openTokens.set(sessionId, token);
    if (this.busySessions.has(sessionId) || this.heldSessions.has(sessionId)) {
      // 忙中 / 终端接管中 → 补放缓冲、渲染层挂实时流(held 时 buffer 通常为空,由终端视图承担交互)
      // recent:滚动最近消息(旧→新,含当前 turn 进行中的 agent 条目,渲染层接流续写)
      return {
        mode: 'live',
        buffered: [...(this.turnBuffers.get(sessionId) ?? [])],
        recent: [...(this.recentMessages.get(sessionId) ?? [])],
      };
    }
    const { history } = await this.loadSession(sessionId);
    if (this.openTokens.get(sessionId) !== token) return { mode: 'stale' }; // 同 session 有更新的调用,丢弃
    return { mode: 'history', messages: history };
  }

  /** sessionId → cwd(仅本进程注册过的;IPC 层再回退 findSessionCwd 磁盘扫描) */
  getSessionCwd(sessionId: string): string | null {
    return this.sessionCwds.get(sessionId) ?? null;
  }

  /**
   * channel 页建会话(design/design-v7.md §10.2):指定 cwd,可绑定常驻 agent。
   * 绑定时立即建立三配置目录,并把 agent 定义 + 配置指引包在 <system-reminder>
   * 里作为首 prompt 注入(ACP 不支持 profile 绑定的绕行);等注入 turn 完成再返回,
   * busySessions 互斥保证渲染层随后的 prompt 不会与注入并发。
   */
  async newChannelSession(opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }> {
    const conn = await this.ensureStarted();
    const cwd = path.resolve(opts.cwd);
    const res = await conn.newSession({ cwd, mcpServers: [] });
    this.registerSessionCwd(res.sessionId, cwd);
    this.cacheModelOptions(res.configOptions);
    await this.applySessionConfig(res.sessionId);
    upsertSession({ sessionId: res.sessionId, cwd, title: '', createdAt: Date.now(), updatedAt: Date.now(), kind: 'chat' });

    let agentName = '';
    let agentDef = '';
    if (opts.agentId) {
      const agent = getAgent(opts.agentId);
      if (agent) {
        agentName = agent.name;
        agentDef = readAgentMd(agent.id);
        setChannelAgent(res.sessionId, agent.id);
        ensureSessionConfigDir(cwd, res.sessionId); // 常驻 agent:立即建立三配置目录
      }
    }
    const cfg = readSessionConfig(cwd, res.sessionId);
    const injection = buildInjectionPrompt({
      agentName,
      agentDef,
      sessionId: res.sessionId,
      hasAgentsMd: cfg.agentsMd.length > 0,
      hasCurrentProcess: cfg.currentProcessMd.length > 0,
      hasProduct: cfg.productMd.length > 0,
    });
    if (injection) {
      try {
        await this.prompt(res.sessionId, injection, null, null);
      } catch (err) {
        console.warn('[acp] channel session 首轮注入失败(session 仍可用):', err);
      }
      // 注入文本不该成为列表标题:agent 会话用 agent 名,其余留空(回退 lastPrompt)
      upsertSession({
        sessionId: res.sessionId,
        cwd,
        title: agentName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        kind: 'chat',
      });
    }
    return { sessionId: res.sessionId };
  }

  /** 阅后即焚 session 清理(design/design-v7.md §10.1):ACP 删除 + channel_meta + 三配置目录 */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.conn) {
      try {
        await this.conn.unstable_deleteSession({ sessionId });
      } catch (err) {
        // 能力位缺失 / 会话已不存在 → 本地清理照常进行
        console.warn('[acp] unstable_deleteSession failed(继续本地清理):', err);
      }
    }
    const cwd = this.sessionCwds.get(sessionId) ?? findSessionCwd(sessionId);
    if (cwd) fs.rmSync(sessionConfigDir(cwd, sessionId), { recursive: true, force: true });
    deleteChannelMeta(sessionId);
    removeSessionFromIndex(sessionId);
    this.turnBuffers.delete(sessionId);
    this.recentMessages.delete(sessionId);
    this.recentTurnOpen.delete(sessionId);
    this.sessionCwds.delete(sessionId);
  }

  /** prompt 并收集本轮 agent 全文回复(group 编排器用;复用 askOnce 的 collector 机制) */
  async promptAndCollect(sessionId: string, text: string): Promise<string> {
    const buf: string[] = [];
    this.collectors.set(sessionId, buf);
    try {
      await this.prompt(sessionId, text, null, null);
      return buf.join('').trim();
    } finally {
      this.collectors.delete(sessionId);
    }
  }

  /**
   * SA 专用建会话(design/design-super-agent.md):专属 cwd + additionalDirectories(项目只读)
   * + 带 sa_key 的 workbench MCP 挂载(特权工具的调用方鉴权)。
   */
  async newSuperSession(opts: { cwd: string; additionalDirectories: string[]; mcpUrl: string }): Promise<string> {
    const conn = await this.ensureStarted();
    const res = await conn.newSession({
      cwd: opts.cwd,
      additionalDirectories: opts.additionalDirectories,
      mcpServers: [{ type: 'http' as const, name: 'workbench', url: opts.mcpUrl, headers: [] }],
    });
    this.registerSessionCwd(res.sessionId, opts.cwd);
    this.attachedWithMcp.add(res.sessionId); // SA 建时即挂带 sa_key 的 MCP
    await this.applySessionConfig(res.sessionId);
    upsertSession({ sessionId: res.sessionId, cwd: opts.cwd, title: '', createdAt: Date.now(), updatedAt: Date.now(), kind: 'chat' });
    return res.sessionId;
  }

  /**
   * 带 MCP 挂载的 attach。
   * 选型实测(kimi 2.1.1,wire.jsonl llm.tools_snapshot 探针,2026-11-24):
   * resume 带 mcpServers 时工具快照与新建一致(46 工具/19 个 mcp__workbench__),
   * resume 转发 mcpServers **有效**;此前「恢复后 MCP 全丢」的实锤根因是 SA 老 session
   * 缺 sa_key 导致 resume 走错路径/无 MCP 挂载,而非 resume 丢挂载。
   * → 保持 resume(更轻,无 replay 开销)。busy 时调用方自守铁律(不 load/resume 忙中)。
   */
  private async attachWithMcp(sessionId: string, cwd: string, mcpServers: acp.McpServer[]): Promise<void> {
    const conn = await this.ensureStarted();
    await conn.resumeSession({ sessionId, cwd, mcpServers });
    this.registerSessionCwd(sessionId, cwd);
    this.attachedWithMcp.add(sessionId);
    await this.applySessionConfig(sessionId);
  }

  /** SA 会话跨复活:持久化的 sid 在 prompt 前必须 resume(否则 Unknown sessionId),并带 MCP 挂载(含 sa_key) */
  async resumeSessionWithMcp(sessionId: string, cwd: string, mcpUrl: string): Promise<void> {
    await this.attachWithMcp(sessionId, cwd, [{ type: 'http' as const, name: 'workbench', url: mcpUrl, headers: [] }]);
  }

  /**
   * prompt 前的 attach 保障(最后一英里):kimi auto-attach 不带 MCP,
   * 未挂过 MCP 的 session 若注册了 hook 就先挂(目前只有 SA 注册:补挂带 sa_key 的 workbench MCP)。
   * 本进程内 attach 过的(newSession/attachWithMcp 带 mcp 路径)直接跳过。
   */
  private attachedWithMcp = new Set<string>();
  private sessionAttachHook: ((sessionId: string) => Promise<void>) | null = null;

  setSessionAttachHook(hook: (sessionId: string) => Promise<void>): void {
    this.sessionAttachHook = hook;
  }

  /** session/fork(design/design-v7.md §9,SDK 0.23 unstable_*):分叉副本可加入 group 参与讨论 */
  async forkSession(sessionId: string): Promise<{ sessionId: string }> {
    const conn = await this.ensureStarted();
    const cwd = this.sessionCwds.get(sessionId) ?? findSessionCwd(sessionId) ?? getSettings().workspaceDir;
    const res = await conn.unstable_forkSession({ sessionId, cwd });
    const newId = res.sessionId;
    this.registerSessionCwd(newId, cwd);
    this.cacheModelOptions(res.configOptions);
    await this.applySessionConfig(newId);
    upsertSession({ sessionId: newId, cwd, title: '', createdAt: Date.now(), updatedAt: Date.now(), kind: 'chat' });
    return { sessionId: newId };
  }

  /** turn 结束后自动更新 current-process.md:只对启用了三配置的 session,同一 session 10s 节流 */
  private lastCpUpdate = new Map<string, number>();

  private maybeUpdateCurrentProcess(sessionId: string, userText: string, agentText: string): void {
    if (userText.startsWith('<system-reminder>')) return; // 首轮注入不触发
    if (agentText.length < 20) return; // 没什么可记的
    const cwd = this.sessionCwds.get(sessionId) ?? findSessionCwd(sessionId);
    if (!cwd) return;
    if (!fs.existsSync(sessionConfigDir(cwd, sessionId))) return; // 未启用三配置的 session 不动
    const now = Date.now();
    if (now - (this.lastCpUpdate.get(sessionId) ?? 0) < 10_000) return;
    this.lastCpUpdate.set(sessionId, now);
    const prev = readSessionConfig(cwd, sessionId).currentProcessMd;
    const promptText = [
      '你在维护一个 AI agent 的任务上下文文件 current-process.md(记录「在做什么 / 下一步」)。',
      '根据下面最新一轮对话增量更新它:保留仍有效的内容、刷新进展,一两句话即可,全文不超过 5 行。',
      '只输出文件的新内容本身,不要解释,不要 markdown 围栏。',
      '',
      `【原 current-process.md】\n${prev || '(空)'}`,
      '',
      `【用户最新输入】\n${userText.slice(0, 500)}`,
      '',
      `【agent 最新回复】\n${agentText.slice(0, 1500)}`,
    ].join('\n');
    void this.askOnce(promptText, 60_000, cwd)
      .then((reply) => {
        const cleaned = reply.trim().replace(/^```(?:markdown)?\s*|\s*```$/g, '').trim();
        if (cleaned) writeSessionConfig(cwd, sessionId, 'currentProcessMd', cleaned);
      })
      .catch((err) => console.warn('[acp] current-process 自动更新失败:', err));
  }

  /** 单条 prompt 的图片上限(实测多张 image block 协议无障碍;超了截断并告警) */
  private static readonly MAX_PROMPT_IMAGES = 10;

  async prompt(sessionId: string, text: string, modePrompt: string | null, images: { data: string; mimeType: string }[] | null): Promise<void> {
    // 铁律:永不 prompt 终端接管中的 session(并发双驱动会双写 wire.jsonl)
    if (this.heldSessions.has(sessionId)) {
      throw new Error('该 session 正被终端接管中,请先在终端里操作或点击「交还」');
    }
    // attach 保障:未挂 MCP 的 session 先经 hook 补挂(SA 才有 hook;其他 session no-op)。
    // fail-open:hook 失败不挡 prompt。busy 也会走到这里——resume 不杀 turn(只有 load 杀),安全。
    if (!this.attachedWithMcp.has(sessionId) && this.sessionAttachHook) {
      try {
        await this.sessionAttachHook(sessionId);
      } catch (err) {
        console.warn('[acp] session attach hook failed(继续 prompt):', err);
      }
    }
    // mark busy synchronously BEFORE any await — loadSession must never race
    // ahead of this flag and interrupt the turn with a history replay
    this.busySessions.add(sessionId);
    this.turnBuffers.delete(sessionId); // 新 turn 开始,清空上一轮的 ring buffer
    // 滚动最近消息:user 条目(注入轮不进);finalize 在 finally
    if (!text.startsWith('<system-reminder>')) {
      this.pushRecent(sessionId, { role: 'user', text: text.slice(0, 2000), at: Date.now() });
    }
    this.recentTurnOpen.add(sessionId);
    const conn = await this.ensureStarted();
    const finalText = modePrompt ? `${modePrompt}\n\n用户输入：\n${text}` : text;
    const blocks: acp.ContentBlock[] = [];
    const imgs = images ?? [];
    if (imgs.length > ACPManager.MAX_PROMPT_IMAGES) {
      console.warn(`[acp] prompt 图片 ${imgs.length} 张超上限,截断为 ${ACPManager.MAX_PROMPT_IMAGES} 张`);
    }
    for (const img of imgs.slice(0, ACPManager.MAX_PROMPT_IMAGES)) {
      blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    }
    if (finalText.trim()) blocks.push({ type: 'text', text: finalText });
    try {
      const res = await conn.prompt({ sessionId, prompt: blocks });
      upsertSession({
        sessionId,
        cwd: getSettings().workspaceDir,
        // system-reminder 包裹的都是注入 prompt(SA 引导/任务卡/唤醒/巡逻),不该当标题——保留现标题
        title: text.startsWith('<system-reminder>')
          ? (getSessionIndex().find((s) => s.sessionId === sessionId)?.title ?? '')
          : text.slice(0, 30),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      this.emit(IPC.evTurnDone, { sessionId, stopReason: res.stopReason });
      const agentText = (this.turnBuffers.get(sessionId) ?? []).join('').trim();
      this.flushTurnBuffer(sessionId);
      this.maybeUpdateCurrentProcess(sessionId, text, agentText);
    } finally {
      this.busySessions.delete(sessionId);
      this.recentTurnOpen.delete(sessionId); // turn 结束(成功或失败):finalize 当前 agent 条目
    }
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

  // ---- resident main session (design-v4 §10.1): voice + command center share
  // one long-lived session, serialized (kimi rejects concurrent prompts per session)

  private mainSessionId: string | null = getSettings().mainSessionId ?? null;
  private mainQueue: Promise<void> = Promise.resolve();

  /** workbench MCP server list for session attach (new / resume) */
  private workbenchMcpServers(): { type: 'http'; name: string; url: string; headers: [] }[] {
    return this.workbenchMcpUrl
      ? [{ type: 'http' as const, name: 'workbench', url: this.workbenchMcpUrl, headers: [] }]
      : [];
  }

  private async newMainSession(): Promise<string> {
    const conn = await this.ensureStarted();
    const res = await conn.newSession({ cwd: getSettings().workspaceDir, mcpServers: this.workbenchMcpServers() });
    this.cacheModelOptions(res.configOptions);
    this.registerSessionCwd(res.sessionId, getSettings().workspaceDir);
    if (this.workbenchMcpUrl) this.attachedWithMcp.add(res.sessionId); // 建时即带 MCP
    this.mainSessionId = res.sessionId;
    saveSettings({ mainSessionId: res.sessionId });
    this.emit(IPC.evMainSession, { sessionId: res.sessionId }); // 渲染层同步主会话 id（防缓存过期）
    await this.applySessionConfig(res.sessionId);
    this.mainAttached = true;
    return res.sessionId;
  }

  /** wrap user text with long-term memory + recent signals + live system state */
  private withMemory(text: string): string {
    const parts: string[] = [];
    const digest = systemDigest();
    parts.push(`[系统状态]\n${digest}`);
    const mem = readMemory();
    if (mem) parts.push(`[长期记忆 memory.md]\n${mem}`);
    const signals = recentDigest();
    if (signals) parts.push(`[近期系统信号]\n${signals}`);
    parts.push(`[用户输入]\n${text}`);
    return parts.join('\n\n');
  }

  private enqueueMain(sid: string, text: string, image?: { data: string; mimeType: string } | null): void {
    this.mainQueue = this.mainQueue
      .then(async () => {
        try {
          await this.prompt(sid, this.withMemory(text), null, image ? [image] : null);
        } catch (err) {
          const message = String(err);
          const corrupted = /storage append|does not exist|Internal error/i.test(message);
          if (corrupted) {
            console.warn(`[acp] main session ${sid} corrupted, recreating:`, message);
            const newSid = await this.newMainSession();
            await this.prompt(newSid, this.withMemory(text), null, image ? [image] : null);
          } else {
            this.emit(IPC.evChunk, { sessionId: sid, kind: 'text', text: `⚠ ${message}` });
            this.emit(IPC.evTurnDone, { sessionId: sid, stopReason: 'error' });
          }
        }
      })
      .catch(() => {});
  }

  /** Main session history for the shared log (seed on startup). */
  async getMainHistory(): Promise<{ role: 'user' | 'agent'; text: string; at: number }[]> {
    const sid = getSettings().mainSessionId;
    if (!sid) return [];
    try {
      const { history } = await this.loadSession(sid);
      this.mainAttached = true; // load 也算 attach 过
      return history.map((h) => ({ role: h.role, text: h.text, at: Date.now() }));
    } catch {
      return [];
    }
  }

  /** /new: rotate to a fresh main session. */
  async newMainSessionFresh(): Promise<string> {
    return this.newMainSession();
  }

  /** Command Center / voice 共用入口：route 到常驻主会话 */
  private mainAttached = false;

  private async mainAsk(text: string, image?: { data: string; mimeType: string } | null): Promise<string> {
    let sid = this.mainSessionId ?? (await this.newMainSession());
    if (!this.mainAttached) {
      // 持久化的主会话来自上一个 kimi 进程——prompt 前必须先 attach，
      // 否则报 Unknown sessionId。attach 失败（会话已被清理）就换新的。
      try {
        // resume 必须带上 MCP——否则恢复的主会话没有 workbench 工具(实测踩坑);
        // 反向实测(2.1.1 探针):resume 带 mcpServers 时工具快照与新建一致,转发有效
        const conn = await this.ensureStarted();
        await conn.resumeSession({
          sessionId: sid,
          cwd: getSettings().workspaceDir,
          mcpServers: this.workbenchMcpServers(),
        });
        this.registerSessionCwd(sid, getSettings().workspaceDir);
      } catch {
        console.warn('[acp] persisted main session gone, creating a new one');
        sid = await this.newMainSession();
      }
      this.mainAttached = true;
    }
    this.enqueueMain(sid, text, image);
    return sid;
  }

  /** Quick-ask from the workbench Command Center. */
  async workbenchAsk(text: string): Promise<string> {
    return this.mainAsk(text);
  }

  /** Home page ask: same resident session — one continuous mind. */
  async homeAsk(text: string): Promise<string> {
    return this.mainAsk(text);
  }

  /** Voice/vision ask with an image frame (phone video vision mode). */
  async homeAskImage(text: string, image: { data: string; mimeType: string }): Promise<string> {
    return this.mainAsk(text, image);
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
      this.cacheModelOptions(res.configOptions);
      this.registerSessionCwd(res.sessionId, effectiveCwd);
      await this.applySessionConfig(res.sessionId);
      // 标记阅后即焚:scanner 据此在项目树里加 ephemeral(channel 树收进「临时」区)
      upsertSession({ sessionId: res.sessionId, cwd: effectiveCwd, title: '', createdAt: Date.now(), updatedAt: Date.now(), kind: 'utility' });
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
      this.recentMessages.delete(sessionId); // 滚动缓冲随垃圾清理回收
      this.recentTurnOpen.delete(sessionId);
      // runtime sweep with a grace delay (kimi flushes session storage async);
      // the startup sweep is the backstop for anything still pending
      setTimeout(() => this.deleteSessionDir(sessionId), 5 * 60_000).unref();
    } catch {
      /* best-effort */
    }
  }

  private deleteSessionDir(sessionId: string): void {
    try {
      const root = path.join(os.homedir(), '.kimi-code', 'sessions');
      for (const wd of fs.readdirSync(root)) {
        const candidate = path.join(root, wd, sessionId);
        if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
      }
      // drop from the trash file once actually deleted
      const file = path.join(app.getPath('userData'), 'trash-sessions.json');
      if (fs.existsSync(file)) {
        const list = (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]).filter((id) => id !== sessionId);
        fs.writeFileSync(file, JSON.stringify(list));
      }
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
      for (const sessionId of list) this.deleteSessionDir(sessionId);
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
