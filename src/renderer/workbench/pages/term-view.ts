/**
 * L3 内嵌终端控制器（v7.0 P3b，design/design-v7.md §12）：
 * xterm.js + FitAddon 包一层生命周期——open 建 pty(term.open,打开即 held),
 * close/切走必须 term.close(kill pty + 释放 held,否则泄漏);
 * onTermExit 时 held 已由主进程自动释放,本地只销毁 xterm 并回调宿主做切回。
 * 快捷键:Cmd+C 有选区复制/无选区发 SIGINT,Cmd+V 粘贴,Cmd+C/V/K 均不传给 xterm;
 * Cmd+K 的冒泡拦截由宿主(channel 页捕获监听里判断焦点在终端内)负责。
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TermViewHandle {
  /** 打开 pty 并挂载 xterm;重复调用会先关闭旧的。失败(如 session 被外开 held)抛错 */
  open(sid: string): Promise<void>;
  /** 关闭 pty + 销毁 xterm(幂等;视图切换/选中其他 session 前必须调) */
  close(): Promise<void>;
  isOpen(): boolean;
  sessionId(): string | null;
  focus(): void;
}

export function createTermView(host: HTMLElement, opts: { onExit: (sid: string) => void }): TermViewHandle {
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let termId: string | null = null;
  let sid: string | null = null;
  let ro: ResizeObserver | null = null;

  // 事件监听常驻,按当前 termId 过滤
  window.kimi.onTermData((e) => {
    if (term && e.termId === termId) term.write(e.data);
  });
  window.kimi.onTermExit((e) => {
    if (e.termId !== termId) return;
    const exitedSid = sid!;
    disposeLocal(); // pty 已退出、held 已自动释放,不需要再 term.close
    opts.onExit(exitedSid);
  });

  function disposeLocal(): void {
    ro?.disconnect();
    ro = null;
    term?.dispose();
    term = null;
    fit = null;
    termId = null;
    sid = null;
    host.innerHTML = '';
  }

  async function close(): Promise<void> {
    if (termId) window.kimi.term.close(termId); // kill pty + 释放 externallyHeld
    disposeLocal();
  }

  return {
    async open(sessionId: string): Promise<void> {
      await close(); // 先清掉旧实例(换 session/重开)
      const r = await window.kimi.term.open(sessionId); // 打开即 held
      termId = r.termId;
      sid = sessionId;
      host.innerHTML = '';
      term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
        theme: {
          background: '#0a0d12',
          foreground: '#dde3ea',
          cursor: '#00f0ff',
          cursorAccent: '#04222a',
          selectionBackground: 'rgba(0, 240, 255, 0.28)',
          black: '#0a0d12',
          red: '#ff4444',
          green: '#00ff88',
          yellow: '#ffaa00',
          blue: '#4d9bff',
          magenta: '#ff0080',
          cyan: '#00f0ff',
          white: '#dde3ea',
          brightBlack: '#4a5058',
          brightRed: '#ff6b6b',
          brightGreen: '#5cffaa',
          brightYellow: '#ffcc55',
          brightBlue: '#7db4ff',
          brightMagenta: '#ff4da6',
          brightCyan: '#66f6ff',
          brightWhite: '#ffffff',
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      window.kimi.term.resize(termId, term.cols, term.rows);

      term.onData((d) => {
        if (termId) window.kimi.term.input(termId, d);
      });
      // 快捷键:返回 false = 不让 xterm 处理(也不进 pty)
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const meta = e.metaKey || e.ctrlKey;
        if (!meta) return true;
        const key = e.key.toLowerCase();
        if (key === 'c') {
          if (term!.hasSelection()) void navigator.clipboard.writeText(term!.getSelection());
          else if (termId) window.kimi.term.input(termId, '\x03'); // 无选区 → SIGINT
          return false;
        }
        if (key === 'v') {
          void navigator.clipboard.readText().then((t) => {
            if (t && termId) window.kimi.term.input(termId, t);
          });
          return false;
        }
        if (key === 'k') return false; // 不触发 command center / 页面跳转
        return true;
      });

      ro = new ResizeObserver(() => {
        if (!fit || !term || !termId) return;
        fit.fit();
        window.kimi.term.resize(termId, term.cols, term.rows);
      });
      ro.observe(host);
      term.focus();
    },
    close,
    isOpen: () => termId !== null,
    sessionId: () => sid,
    focus: () => term?.focus(),
  };
}
