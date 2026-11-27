import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import * as pty from 'node-pty';
import { findSessionCwd } from './session-scanner.js';

/**
 * 终端三视图后端(design/design-v7.md §12, prd 决策 10):
 * - L3 内嵌终端:node-pty 跑 `kimi --session <sid>`(每视图一个 pty,视图关闭即 kill);
 * - L1 观察视图:`kimi vis <sid> --no-open` 起本地 web 服务,解析 stdout 拿 URL;
 * - L2 外开终端:osascript 在 iTerm / Terminal.app 起 `kimi --session <sid>`。
 *
 * 铁律:打开任一终端视图即 externallyHeld(时分复用,并发双驱动会双写 wire.jsonl);
 * L3/L1 退出时自动释放,L2 无法感知关闭,靠渲染层「交还」按钮调 term:release。
 */

interface TerminalDeps {
  /** pty 输出(term:data)与退出(term:exit)转发,index.ts 注入发 workbench 窗口 */
  onData: (termId: string, data: string) => void;
  onExit: (termId: string, code: number) => void;
  /** externallyHeld 标记(ACPManager) */
  hold: (sessionId: string) => void;
  release: (sessionId: string) => void;
}

interface TermEntry {
  pty: pty.IPty;
  sessionId: string;
}

interface VisEntry {
  child: ChildProcess;
  sessionId: string;
  url: string;
}

/** 从 kimi vis 的 stdout 里提取本地 URL(独立导出便于测试) */
export function extractVisUrl(text: string): string | null {
  const m = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+[^\s]*/);
  return m ? m[0] : null;
}

/** AppleScript 字符串字面量转义(反斜杠 + 双引号) */
function escApple(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 外开终端的 AppleScript(独立导出便于测试;quoted form of 负责 shell 层转义) */
export function buildTerminalScript(app: 'iTerm' | 'Terminal', cwd: string, sessionId: string): string {
  const cmd = `"cd " & quoted form of "${escApple(cwd)}" & " && kimi --session " & quoted form of "${escApple(sessionId)}"`;
  if (app === 'iTerm') {
    return `tell application "iTerm"\n  create window with default profile command (${cmd})\n  activate\nend tell`;
  }
  return `tell application "Terminal"\n  do script (${cmd})\n  activate\nend tell`;
}

export class TerminalManager {
  private terms = new Map<string, TermEntry>();
  private vis = new Map<string, VisEntry>(); // key: visId
  private visBySid = new Map<string, string>(); // sessionId → visId(重复打开复用)

  constructor(private deps: TerminalDeps) {}

  // ---------- L3 内嵌终端 ----------

  openTerminal(sessionId: string): { termId: string; cwd: string } {
    const cwd = findSessionCwd(sessionId);
    if (!cwd) throw new Error(`无法解析 session 的 cwd: ${sessionId}`);
    const termId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // 事务化:任何一步失败都必须释放 held——否则 session 会被「终端接管中」永久锁死(2026-11-26 实锤)
    let proc: ReturnType<typeof pty.spawn> | null = null;
    try {
      proc = pty.spawn('kimi', ['--session', sessionId], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
      });
      this.terms.set(termId, { pty: proc!, sessionId });
      this.deps.hold(sessionId); // 接管:ACP 侧禁止 prompt
      proc!.onData((data) => this.deps.onData(termId, data));
      proc!.onExit(({ exitCode }) => {
        this.terms.delete(termId);
        this.deps.release(sessionId); // 交还:终端关闭即释放
        this.deps.onExit(termId, exitCode);
      });
    } catch (err) {
      this.terms.delete(termId);
      this.deps.release(sessionId); // 兜底:hold 已发生则必释放
      try {
        (proc as unknown as { kill?: () => void })?.kill?.();
      } catch {
        /* ignore */
      }
      throw err;
    }
    return { termId, cwd };
  }

  input(termId: string, data: string): void {
    this.terms.get(termId)?.pty.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    const entry = this.terms.get(termId);
    if (!entry || cols <= 0 || rows <= 0) return;
    entry.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  close(termId: string): void {
    const entry = this.terms.get(termId);
    if (!entry) return;
    this.terms.delete(termId);
    this.deps.release(entry.sessionId);
    try {
      entry.pty.kill();
    } catch {
      /* 已退出 */
    }
  }

  // ---------- L1 观察视图(kimi vis) ----------

  openVis(sessionId: string): Promise<{ url: string; visId: string }> {
    const existingId = this.visBySid.get(sessionId);
    const existing = existingId ? this.vis.get(existingId) : undefined;
    if (existing && existingId) return Promise.resolve({ url: existing.url, visId: existingId }); // 复用

    const cwd = findSessionCwd(sessionId) ?? undefined;
    const child = spawn('kimi', ['vis', sessionId, '--no-open'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const visId = `vis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('kimi vis 启动超时(10s 未输出 URL)'));
      }, 10_000);

      const onChunk = (chunk: Buffer): void => {
        if (settled) return;
        buf += chunk.toString();
        const url = extractVisUrl(buf);
        if (url) {
          settled = true;
          clearTimeout(timer);
          this.vis.set(visId, { child, sessionId, url });
          this.visBySid.set(sessionId, visId);
          child.on('exit', () => {
            this.vis.delete(visId);
            if (this.visBySid.get(sessionId) === visId) this.visBySid.delete(sessionId);
          });
          resolve({ url, visId });
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk); // 有的版本打在 stderr
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`kimi vis 提前退出(code=${code}): ${buf.slice(0, 200)}`));
      });
    });
  }

  closeVis(visId: string): void {
    const entry = this.vis.get(visId);
    if (!entry) return;
    this.vis.delete(visId);
    if (this.visBySid.get(entry.sessionId) === visId) this.visBySid.delete(entry.sessionId);
    entry.child.kill();
  }

  // ---------- L2 外开终端 ----------

  async openExternalTerminal(sessionId: string): Promise<{ ok: boolean; app: 'iTerm' | 'Terminal' }> {
    const cwd = findSessionCwd(sessionId);
    if (!cwd) throw new Error(`无法解析 session 的 cwd: ${sessionId}`);
    const app: 'iTerm' | 'Terminal' = fs.existsSync('/Applications/iTerm.app') ? 'iTerm' : 'Terminal';
    const script = buildTerminalScript(app, cwd, sessionId);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
      child.on('error', reject);
    });
    this.deps.hold(sessionId); // 外开无法感知关闭:释放靠渲染层「交还」按钮(term:release)
    return { ok: true, app };
  }

  /** will-quit 清理:全部 kill */
  dispose(): void {
    for (const [id] of this.terms) this.close(id);
    for (const [id] of this.vis) this.closeVis(id);
  }
}
