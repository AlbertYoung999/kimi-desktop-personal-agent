import fs from 'node:fs';
import path from 'node:path';
import type { SessionConfig, SessionConfigField } from '../shared/types.js';

/**
 * session 三配置(v7.0 P2, prd 决策 5):
 * - AGENTS.md 放项目根目录(kimi 自动加载,项目级共享);
 * - current-process.md(在做什么/下一步)与 product.md(关键规划)放
 *   `<cwd>/.kimi-desktop/sessions/<sid>/` 下(per-session)。
 * 路径拼接规则只在本文件,渲染层 IPC 只传 sid。
 */

export function sessionConfigDir(cwd: string, sessionId: string): string {
  return path.join(cwd, '.kimi-desktop', 'sessions', sessionId);
}

/** 绑定常驻 agent 时调用:建目录并播种空配置文件(也是 current-process 自动更新的启用标记) */
export function ensureSessionConfigDir(cwd: string, sessionId: string): string {
  const dir = sessionConfigDir(cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['current-process.md', 'product.md']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
  return dir;
}

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function readSessionConfig(cwd: string, sessionId: string): SessionConfig {
  const dir = sessionConfigDir(cwd, sessionId);
  return {
    agentsMd: readIfExists(path.join(cwd, 'AGENTS.md')),
    currentProcessMd: readIfExists(path.join(dir, 'current-process.md')),
    productMd: readIfExists(path.join(dir, 'product.md')),
    agentsMdPath: path.join(cwd, 'AGENTS.md'),
    dirPath: dir,
  };
}

export function writeSessionConfig(cwd: string, sessionId: string, field: SessionConfigField, content: string): void {
  if (field === 'agentsMd') {
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), content);
    return;
  }
  const dir = sessionConfigDir(cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, field === 'currentProcessMd' ? 'current-process.md' : 'product.md'), content);
}

/**
 * 首轮注入 prompt 组装(design/design-v7.md §10.2,ACP 不支持 agent profile 绑定的绕行)。
 * 整段包在 <system-reminder> 里:loadSession 的 replay 清洗会剥离它,历史回放不可见。
 * 返回 null = 无 agent 绑定且项目无任何配置,不需要注入。
 */
export function buildInjectionPrompt(opts: {
  agentName?: string;
  agentDef?: string;
  sessionId: string;
  hasAgentsMd: boolean;
  hasCurrentProcess: boolean;
  hasProduct: boolean;
}): string | null {
  const { agentName, agentDef, sessionId, hasAgentsMd, hasCurrentProcess, hasProduct } = opts;
  if (!agentDef && !hasAgentsMd) return null;

  const relDir = `.kimi-desktop/sessions/${sessionId}`;
  const guidance: string[] = [];
  if (hasAgentsMd) guidance.push('- 先阅读项目根目录的 AGENTS.md,了解项目约定与上下文。');
  if (agentDef || hasCurrentProcess) {
    guidance.push(
      `- 你的任务上下文维护在 ${relDir}/current-process.md(在做什么/下一步)${hasCurrentProcess ? ',先读取它恢复进度' : ''};之后每推进一个阶段就更新它,保持一两句话。`,
    );
  }
  if (agentDef || hasProduct) {
    guidance.push(
      `- 你的关键规划维护在 ${relDir}/product.md${hasProduct ? ',先读取它' : ''};有重大规划/变更时更新。`,
    );
  }
  if (agentDef) guidance.push('- 上述两个 md 文件是你的持久记忆——会话重开、上下文压缩后靠它们恢复状态。');
  guidance.push('- 用一两句话确认你已理解角色与上下文,然后等待用户指令。');

  const parts: string[] = [];
  if (agentDef) {
    parts.push(`[常驻 agent 角色绑定] 你在此会话中以「${agentName}」的身份工作,以下是你的定义全文:`, '', '---', agentDef.trim(), '---', '');
  } else {
    parts.push('[项目上下文指引]', '');
  }
  parts.push('工作指引:', ...guidance);
  return `<system-reminder>\n${parts.join('\n')}\n</system-reminder>`;
}
