import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChannelTree, ChunkEvent, OpenSessionResult, PermissionRequest, RemoteInfo, ToolCallEvent, TurnDoneEvent } from '../shared/types.js';
import { IPC } from '../shared/types.js';
import { getRemoteDeviceByHash, insertRemoteDevice, listRemoteDevices, revokeRemoteDevice, touchRemoteDevice, type RemoteDeviceRow } from './db.js';
import { ensureRemoteCerts, type RemoteCerts } from './remote-certs.js';
import { recordSignal } from './signals.js';
import { findMode, getSettings, listModes } from './store.js';
import { DEFAULT_VOICE_ZH, piperSynth } from './tts/piper.js';

/**
 * RemoteBridge(prd/PRD-mobile-remote.md §2):手机网页在局域网内访问/操作桌面 session。
 * 原生 node:http(对齐 mcpserver 先例,零新依赖),REST + SSE,绑定 0.0.0.0。
 * 鉴权:6 位配对码(内存态 5 分钟、一次性)→ 长期 token(db 只存 sha256);
 * 除 /api/pair 与静态资源外一律要 token,ACP 铁律不下桥(busy 409 / held 423)。
 * 桥层不暴露任何 fs 读写(§4.2 安全基线)。
 */

/** RemoteBridge 需要的 ACP 能力(结构化接口,冒烟可注入 stub) */
export interface RemoteAcp {
  openSession(sessionId: string): Promise<OpenSessionResult>;
  prompt(sessionId: string, text: string, modePrompt: string | null, images: { data: string; mimeType: string }[] | null): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  isBusy(sessionId: string): boolean;
  isHeld(sessionId: string): boolean;
  respondPermission(requestId: string, approved: boolean, remember: boolean, sessionId: string, optionId?: string): void;
  addListener(cb: (channel: string, payload: unknown) => void): () => void;
  getModelOptions(): { value: string; name: string }[];
  getSessionMode(sessionId: string): { mode: string; source: 'session' | 'global' };
  setSessionMode(sessionId: string, mode: 'default' | 'auto' | 'yolo' | 'plan' | null): Promise<void>;
  getSessionModel(sessionId: string): { model: string | null; source: 'session' | 'default' };
  setSessionModel(sessionId: string, model: string | null): Promise<void>;
  getSessionThinking(sessionId: string): { thinking: string; source: 'session' | 'global' };
  setSessionThinking(sessionId: string, thinking: 'low' | 'high' | 'max' | null): Promise<void>;
  newChannelSession(opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }>;
}

export interface RemoteBridgeDeps {
  acp: RemoteAcp;
  /** channel 项目树(同 ch:scan;归档组在这里滤掉) */
  scan: () => ChannelTree;
  /** 手机客户端静态目录(dist/renderer/remote,并行 agent 产物) */
  staticDir: string;
}

interface SseClient {
  res: http.ServerResponse;
  /** null = 全局通道(tree-changed + 全局 permission) */
  sid: string | null;
}

const PAIR_CODE_TTL_MS = 5 * 60_000;
const PAIR_RATE_LIMIT = 10; // 每 IP 每分钟配对尝试上限
const HEARTBEAT_MS = 25_000;
const MAX_BODY = 50 * 1024 * 1024; // JSON body 上限(多图 prompt 场景,base64 体积大)
const MAX_PROMPT_IMAGES = 10; // 与 acp.ts 上限一致,超限直接 400

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export class RemoteBridge {
  private server: http.Server | null = null;
  private httpsServer: https.Server | null = null;
  private certs: RemoteCerts | null = null;
  private actualPort = 0;
  private actualHttpsPort = 0;
  private pair: { code: string; expiresAt: number } | null = null;
  private pairAttempts = new Map<string, number[]>(); // ip → 尝试时间戳(配对限流)
  private sseClients = new Set<SseClient>();
  private unsubscribe: (() => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private deps: RemoteBridgeDeps) {}

  isEnabled(): boolean {
    return getSettings().remoteEnabled !== false; // 默认开
  }

  configuredPort(): number {
    return getSettings().remotePort ?? 8922;
  }

  /** HTTPS 基准端口(契约:= HTTP 端口 + 1) */
  configuredHttpsPort(): number {
    return this.configuredPort() + 1;
  }

  /** 幂等;enabled=false 时直接返回。端口冲突自动 +1(最多 +10) */
  async start(): Promise<void> {
    if (this.server || !this.isEnabled()) return;
    const base = this.configuredPort();
    for (let port = base; port < base + 10; port++) {
      const ok = await this.tryListen(port);
      if (ok) {
        this.actualPort = port;
        this.wireEvents();
        this.heartbeat = setInterval(() => {
          for (const c of this.sseClients) c.res.write(': ping\n\n');
        }, HEARTBEAT_MS);
        this.heartbeat.unref();
        console.log(`[remote] 移动访问地址 ${this.lanIps().map((ip) => `http://${ip}:${port}`).join('  ')}`);
        break;
      }
    }
    if (!this.server) {
      console.warn(`[remote] 端口 ${base}~${base + 9} 全部占用,RemoteBridge 未启动`);
      return;
    }
    // HTTPS 双栈(语音前置:iOS Web Speech 需 secure context);证书失败只关 HTTPS,HTTP 不受影响
    try {
      this.certs = await ensureRemoteCerts(this.lanIps());
      const baseHttps = this.configuredHttpsPort();
      for (let port = baseHttps; port < baseHttps + 10; port++) {
        if (await this.tryListenHttps(port)) {
          this.actualHttpsPort = port;
          console.log(
            `[remote] HTTPS ${this.lanIps().map((ip) => `https://${ip}:${port}`).join('  ')}\n[remote] CA 指纹 SHA256:${this.certs.caFingerprint}`,
          );
          break;
        }
      }
      if (!this.httpsServer) console.warn(`[remote] HTTPS 端口 ${baseHttps}~${baseHttps + 9} 全部占用(仅 HTTP 可用)`);
    } catch (err) {
      this.certs = null;
      console.warn('[remote] HTTPS 证书生成失败(仅 HTTP 可用):', err);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.sseClients) c.res.end();
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
    this.actualPort = 0;
    this.httpsServer?.close();
    this.httpsServer = null;
    this.actualHttpsPort = 0;
  }

  private tryListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) this.sendJson(res, 500, { error: String(err) });
          else res.end();
        });
      });
      server.once('error', () => resolve(false)); // EADDRINUSE 等 → 换下一个端口
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  private tryListenHttps(port: number): Promise<boolean> {
    if (!this.certs) return Promise.resolve(false);
    const { key, cert } = this.certs;
    return new Promise((resolve) => {
      const server = https.createServer({ key, cert }, (req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) this.sendJson(res, 500, { error: String(err) });
          else res.end();
        });
      });
      server.once('error', () => resolve(false));
      server.listen(port, '0.0.0.0', () => {
        this.httpsServer = server;
        resolve(true);
      });
    });
  }

  lanIps(): string[] {
    const ips: string[] = [];
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === 'IPv4' && !info.internal) ips.push(info.address);
      }
    }
    return ips;
  }

  // ---------- 配对码 ----------

  /** 当前有效码(没有/过期则新生成);供 rm:get-info 与 /api/pair 校验共用 */
  ensurePairCode(): { code: string; ttl: number } {
    if (!this.pair || this.pair.expiresAt <= Date.now()) {
      this.pair = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIR_CODE_TTL_MS };
    }
    return { code: this.pair.code, ttl: Math.max(0, Math.round((this.pair.expiresAt - Date.now()) / 1000)) };
  }

  /** rm:regenerate-code:强制换新(旧码即废) */
  regeneratePairCode(): { pairCode: string; ttl: number } {
    this.pair = null;
    const { code, ttl } = this.ensurePairCode();
    return { pairCode: code, ttl };
  }

  // ---------- 管理面(rm:* IPC 用) ----------

  getInfo(): RemoteInfo {
    const { code, ttl } = this.ensurePairCode();
    return {
      enabled: this.isEnabled(),
      port: this.actualPort || this.configuredPort(),
      httpsPort: this.actualHttpsPort,
      ips: this.lanIps(),
      pairCode: code,
      pairCodeTtl: ttl,
      caAvailable: this.certs !== null,
      caPath: this.certs?.caPath ?? '',
    };
  }

  listDevices(): { id: string; name: string; createdAt: number; lastSeen: number | null }[] {
    return listRemoteDevices().map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen }));
  }

  revokeDevice(id: string): void {
    revokeRemoteDevice(id);
    recordSignal('remote', `撤销配对设备 ${id}`);
  }

  /** scanner 变化时由 index.ts 调用(ch:changed 同款信号 → 全局 SSE 通道) */
  notifyTreeChanged(): void {
    this.broadcast(null, { type: 'tree-changed' });
  }

  // ---------- 鉴权 ----------

  private auth(req: http.IncomingMessage): RemoteDeviceRow | null {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let token = '';
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) token = header.slice(7).trim();
    if (!token) token = url.searchParams.get('token') ?? ''; // SSE 方便(EventSource 不能带 header)
    if (!token) return null;
    const device = getRemoteDeviceByHash(sha256(token));
    if (device) touchRemoteDevice(device.id);
    return device;
  }

  // ---------- 事件桥(ACP emit → SSE) ----------

  private wireEvents(): void {
    this.unsubscribe = this.deps.acp.addListener((channel, payload) => {
      switch (channel) {
        case IPC.evChunk: {
          const p = payload as ChunkEvent;
          this.broadcast(p.sessionId, {
            type: 'chunk',
            sessionId: p.sessionId,
            kind: p.kind === 'text' ? 'agent' : p.kind, // 契约:user | agent | thought
            text: p.text,
          });
          break;
        }
        case IPC.evToolCall: {
          const p = payload as ToolCallEvent;
          this.broadcast(p.sessionId, { type: 'tool', sessionId: p.sessionId, toolCallId: p.toolCallId, title: p.title, status: p.status });
          break;
        }
        case IPC.evTurnDone: {
          const p = payload as TurnDoneEvent;
          this.broadcast(p.sessionId, { type: 'turn-done', sessionId: p.sessionId, stopReason: p.stopReason });
          break;
        }
        case IPC.evPermission: {
          const p = payload as PermissionRequest;
          const event = {
            type: 'permission',
            sessionId: p.sessionId,
            requestId: p.requestId,
            title: p.title,
            description: p.description,
            options: p.options ?? [],
          };
          this.broadcast(p.sessionId, event); // 会话通道
          this.broadcast(null, event); // 全局通道(手机不在看某 session 时也要能批)
          break;
        }
        // 配置回传(TUI/桌面端改的,手机同步):只发全局通道(契约)
        case IPC.evSessionMode: {
          const p = payload as { sessionId: string; modeId: string };
          this.broadcast(null, { type: 'session-mode', sessionId: p.sessionId, modeId: p.modeId });
          break;
        }
        case IPC.evSessionModel: {
          const p = payload as { sessionId: string; model: string };
          this.broadcast(null, { type: 'session-model', sessionId: p.sessionId, model: p.model });
          break;
        }
        case IPC.evSessionThinking: {
          const p = payload as { sessionId: string; thinking: string };
          this.broadcast(null, { type: 'session-thinking', sessionId: p.sessionId, thinking: p.thinking });
          break;
        }
        default:
          break;
      }
    });
  }

  private broadcast(sid: string | null, event: unknown): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.sseClients) {
      if (c.sid === sid) c.res.write(data);
    }
  }

  // ---------- HTTP ----------

  /** GET/POST /api/session-config 的响应结构(契约) */
  private sessionConfigPayload(sid: string): {
    mode: { value: string; source: string };
    model: { value: string | null; source: string };
    thinking: { value: string; source: string };
    promptModes: { id: string; icon: string; name: string }[];
  } {
    const mode = this.deps.acp.getSessionMode(sid);
    const model = this.deps.acp.getSessionModel(sid);
    const thinking = this.deps.acp.getSessionThinking(sid);
    return {
      mode: { value: mode.mode, source: mode.source },
      model: { value: model.model, source: model.source },
      thinking: { value: thinking.thinking, source: thinking.source },
      // 提示词预设(悬浮窗 chips 同款,settings modes 模块)
      promptModes: listModes().map((m) => ({ id: m.id, icon: m.icon, name: m.name })),
    };
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {});
        } catch {
          reject(new Error('invalid json'));
        }
      });
      req.on('error', reject);
    });
  }

  /** 读原始二进制 body(/api/asr 音频用;上限 20MB) */
  private readRawBody(req: http.IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private clientIp(req: http.IncomingMessage): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** 配对码错误尝试限流:每 IP 每分钟 10 次,超了返回 false */
  private pairRateOk(ip: string): boolean {
    const now = Date.now();
    const list = (this.pairAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= PAIR_RATE_LIMIT) {
      this.pairAttempts.set(ip, list);
      return false;
    }
    list.push(now);
    this.pairAttempts.set(ip, list);
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    // ---- 配对(唯一免 token 的 API;错误尝试限流) ----
    if (url.pathname === '/api/pair' && method === 'POST') {
      if (!this.pairRateOk(this.clientIp(req))) return this.sendJson(res, 429, { error: 'rate_limited' });
      const body = await this.readBody(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!this.pair || code !== this.pair.code) return this.sendJson(res, 401, { error: 'invalid_code' });
      if (this.pair.expiresAt <= Date.now()) return this.sendJson(res, 410, { error: 'code_expired' });
      // 一次性:用掉即作废
      this.pair = null;
      const token = crypto.randomBytes(32).toString('hex');
      const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 60) : '未命名设备';
      insertRemoteDevice({
        id: `dev-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
        token_hash: sha256(token),
        name: deviceName,
        created_at: Date.now(),
      });
      recordSignal('remote', `新设备配对:${deviceName}`);
      return this.sendJson(res, 200, { token });
    }

    // ---- CA 证书下发(免 token:手机浏览器打开即下载安装,语音 HTTPS 前置) ----
    if (url.pathname === '/ca.pem' && method === 'GET') {
      if (!this.certs) return this.sendJson(res, 404, { error: 'ca_not_available' });
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="kimi-remote-ca.pem"',
        'Content-Length': this.certs.caPem.length,
      });
      res.end(this.certs.caPem);
      return;
    }

    // ---- 静态资源(手机客户端,免 token——页面本身不含数据,API 全要 token) ----
    if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);

    // ---- 以下全部要 token ----
    const device = this.auth(req);
    if (!device) return this.sendJson(res, 401, { error: 'unauthorized' });

    // 设备管理(管理端/已配对设备可用)
    if (url.pathname === '/api/devices' && method === 'GET') return this.sendJson(res, 200, this.listDevices());
    if (url.pathname === '/api/devices/revoke' && method === 'POST') {
      const body = await this.readBody(req);
      if (typeof body.id === 'string') this.revokeDevice(body.id);
      return this.sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/tree' && method === 'GET') {
      const tree = this.deps.scan();
      // 归档组不下发给手机(§P1 只看活跃)
      return this.sendJson(res, 200, { projects: tree.projects.filter((p) => p.bucket !== 'archive') });
    }

    if (url.pathname === '/api/open-session' && method === 'POST') {
      const body = await this.readBody(req);
      const sid = String(body.sid ?? '');
      if (!sid) return this.sendJson(res, 400, { error: 'missing sid' });
      return this.sendJson(res, 200, await this.deps.acp.openSession(sid)); // 铁律:永不 load 忙中 session
    }

    if (url.pathname === '/api/prompt' && method === 'POST') {
      const body = await this.readBody(req);
      const sid = String(body.sid ?? '');
      const text = String(body.text ?? '');
      if (!sid || !text.trim()) return this.sendJson(res, 400, { error: 'missing sid/text' });
      if (this.deps.acp.isHeld(sid)) return this.sendJson(res, 423, { error: 'held' }); // 铁律:终端接管中
      if (this.deps.acp.isBusy(sid)) return this.sendJson(res, 409, { error: 'busy' }); // kimi 同 session 不并发
      // modeId(提示词预设 chips):按 id 从 settings modes 取 prompt 文本注入(同悬浮窗路径)
      const modeId = typeof body.modeId === 'string' ? body.modeId : null;
      const modePrompt = modeId ? (findMode(modeId)?.prompt ?? null) : null;
      if (modeId && !modePrompt) return this.sendJson(res, 400, { error: `unknown modeId: ${modeId}` });
      // images(base64 多图):校验结构,上限 10(acp.ts 侧另有截断兜底)
      let images: { data: string; mimeType: string }[] | null = null;
      if (body.images !== undefined) {
        if (!Array.isArray(body.images) || body.images.length > MAX_PROMPT_IMAGES) {
          return this.sendJson(res, 400, { error: `images must be array(≤${MAX_PROMPT_IMAGES})` });
        }
        images = [];
        for (const img of body.images as { data?: unknown; mimeType?: unknown }[]) {
          if (typeof img?.data !== 'string' || typeof img?.mimeType !== 'string' || !img.data) {
            return this.sendJson(res, 400, { error: 'invalid image item(need {data,mimeType})' });
          }
          images.push({ data: img.data, mimeType: img.mimeType });
        }
      }
      void this.deps.acp.prompt(sid, text, modePrompt, images).catch((err) => {
        console.warn('[remote] prompt failed:', err);
        this.broadcast(sid, { type: 'error', sessionId: sid, error: String(err) });
      });
      recordSignal(
        'remote',
        `[${device.name}] prompt → ${sid.slice(0, 20)}${modeId ? ` (预设:${modeId})` : ''}${images?.length ? ` (图:${images.length})` : ''}: ${text.slice(0, 60)}`,
      );
      return this.sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/api/cancel' && method === 'POST') {
      const body = await this.readBody(req);
      const sid = String(body.sid ?? '');
      if (!sid) return this.sendJson(res, 400, { error: 'missing sid' });
      await this.deps.acp.cancel(sid);
      return this.sendJson(res, 200, { ok: true });
    }

    // 新建会话(手机与桌面平权:工厂 ensureSession 路径;cwd 必填,为当前项目目录)
    if (url.pathname === '/api/new-session' && method === 'POST') {
      const body = await this.readBody(req);
      const cwd = String(body.cwd ?? '');
      if (!cwd) return this.sendJson(res, 400, { error: 'missing cwd' });
      const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
      const r = await this.deps.acp.newChannelSession({ cwd, agentId });
      recordSignal('remote', `[${device.name}] 新会话 ${r.sessionId.slice(0, 20)} @ ${cwd}`);
      return this.sendJson(res, 200, r);
    }

    if (url.pathname === '/api/model-options' && method === 'GET') {
      return this.sendJson(res, 200, this.deps.acp.getModelOptions());
    }

    // 提示词预设完整清单(带 prompt 文本,渲染层只读;session-config 里的精简版保留兼容)
    if (url.pathname === '/api/prompt-modes' && method === 'GET') {
      return this.sendJson(res, 200, listModes().map((m) => ({ id: m.id, icon: m.icon, name: m.name, prompt: m.prompt })));
    }

    if (url.pathname === '/api/session-config' && method === 'GET') {
      const sid = url.searchParams.get('sid') ?? '';
      if (!sid) return this.sendJson(res, 400, { error: 'missing sid' });
      return this.sendJson(res, 200, this.sessionConfigPayload(sid));
    }

    if (url.pathname === '/api/session-config' && method === 'POST') {
      const body = await this.readBody(req);
      const sid = String(body.sid ?? '');
      if (!sid) return this.sendJson(res, 400, { error: 'missing sid' });
      // 20261121 决策变更:手机与桌面平权,不再拦截 yolo(仅审计日志标注)
      const changes: string[] = [];
      if (body.mode !== undefined) {
        const mode = body.mode === null ? null : String(body.mode);
        if (mode !== null && !['default', 'auto', 'yolo', 'plan'].includes(mode)) {
          return this.sendJson(res, 400, { error: `invalid mode: ${mode}` });
        }
        await this.deps.acp.setSessionMode(sid, mode as 'default' | 'auto' | 'yolo' | 'plan' | null);
        changes.push(mode === 'yolo' ? 'mode=yolo(remote-yolo)' : `mode=${mode ?? '(清除)'}`);
      }
      if (body.model !== undefined) {
        await this.deps.acp.setSessionModel(sid, body.model === null ? null : String(body.model));
        changes.push(`model=${body.model ?? '(清除)'}`);
      }
      if (body.thinking !== undefined) {
        const thinking = body.thinking === null ? null : String(body.thinking);
        if (thinking !== null && !['low', 'high', 'max'].includes(thinking)) {
          return this.sendJson(res, 400, { error: `invalid thinking: ${thinking}` });
        }
        await this.deps.acp.setSessionThinking(sid, thinking as 'low' | 'high' | 'max' | null);
        changes.push(`thinking=${thinking ?? '(清除)'}`);
      }
      if (changes.length > 0) recordSignal('remote', `[${device.name}] 配置 ${sid.slice(0, 20)}: ${changes.join(' ')}`);
      return this.sendJson(res, 200, this.sessionConfigPayload(sid));
    }

    if (url.pathname === '/api/permission-respond' && method === 'POST') {
      const body = await this.readBody(req);
      const requestId = String(body.requestId ?? '');
      const optionId = String(body.optionId ?? '');
      if (!requestId || !optionId) return this.sendJson(res, 400, { error: 'missing requestId/optionId' });
      this.deps.acp.respondPermission(requestId, true, false, '', optionId);
      recordSignal('remote', `[${device.name}] 权限批准 ${requestId} → ${optionId}`);
      return this.sendJson(res, 200, { ok: true });
    }

    // ---- TTS 语音回复(piper 本地合成;契约:audio/wav | 503) ----
    if (url.pathname === '/api/tts' && method === 'POST') {
      const body = await this.readBody(req);
      const text = String(body.text ?? '').slice(0, 2000); // 超长截断
      if (!text.trim()) return this.sendJson(res, 400, { error: 'missing text' });
      const voiceId =
        (typeof body.voiceId === 'string' && body.voiceId) || getSettings().ttsPiperVoiceZh || DEFAULT_VOICE_ZH;
      try {
        const wav = await piperSynth(text, voiceId);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
      } catch (err) {
        // 模型未下载 / venv 未就绪等
        return this.sendJson(res, 503, { error: String(err).slice(0, 300) });
      }
      return;
    }

    // ---- ASR 语音转写(P1 占位:whisper-api 需要 openai key,现有 settings 无该字段,一律 501) ----
    if (url.pathname === '/api/asr' && method === 'POST') {
      await this.readRawBody(req).catch(() => Buffer.alloc(0)); // 排空 body 防 socket 悬挂
      return this.sendJson(res, 501, { error: 'asr-not-configured' });
    }

    if (url.pathname === '/api/events' && method === 'GET') {
      const sid = url.searchParams.get('sid');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // 反代/隧道下禁缓冲
      });
      res.write(': connected\n\n');
      const client: SseClient = { res, sid: sid || null };
      this.sseClients.add(client);
      req.on('close', () => this.sseClients.delete(client)); // 断开注销
      return;
    }

    this.sendJson(res, 404, { error: 'not_found' });
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const root = this.deps.staticDir;
    if (!fs.existsSync(root)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>RemoteBridge</title>' +
          '<body style="font-family:monospace;background:#0b0e14;color:#9fb3c8;display:grid;place-items:center;height:100vh;margin:0">' +
          '<div style="text-align:center"><h2>RemoteBridge 运行中</h2><p>手机客户端尚未构建(dist/renderer/remote 不存在)。</p></div></body>',
      );
      return;
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    let file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end(); // 路径穿越
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA 兜底:无扩展名的路径回退 index.html
      if (!path.extname(file)) file = path.join(root, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(data);
  }
}
