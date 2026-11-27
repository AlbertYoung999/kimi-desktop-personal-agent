import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Notification } from 'electron';
import { IPC } from '../shared/types.js';
import type { ChannelTree, SaTaskItem } from '../shared/types.js';
import {
  deleteSaTask,
  getSaTask,
  getSaTaskBySession,
  insertSaTask,
  listSaTasks,
  updateSaTask,
  updateSaTaskStatus,
  allChannelMeta,
} from './db.js';
import { findSessionCwd } from './session-scanner.js';
import { readSessionConfig } from './session-config.js';
import { recordSignal } from './signals.js';
import { getSessionIndex, getSettings, saveSettings, upsertSession } from './store.js';
import { wbRoot } from './workbench.js';

/**
 * Super Agent / 分身 GM(design/design-super-agent.md,P1):
 * - 专属工作区 wbRoot()/super-agent/(agents.md/memory.md/tasks.md/learning.md + inbox/);
 * - SA session = 普通 session + SA 身份注入 + 特权 MCP 工具(经 sa_key URL 标记鉴权);
 * - worker 回传链:turn-done → digest 投 inbox/ → 状态 review → 唤醒 SA。
 */

/** SA 侧需要的主进程能力(index.ts 注入;冒烟可 stub) */
export interface SaDeps {
  acp: {
    prompt(sessionId: string, text: string, modePrompt: string | null, images: { data: string; mimeType: string }[] | null): Promise<void>;
    isBusy(sessionId: string): boolean;
    isHeld(sessionId: string): boolean;
    addListener(cb: (channel: string, payload: unknown) => void): () => void;
    newChannelSession(opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }>;
    newSuperSession(opts: { cwd: string; additionalDirectories: string[]; mcpUrl: string }): Promise<string>;
    resumeSessionWithMcp(sessionId: string, cwd: string, mcpUrl: string): Promise<void>;
    /** prompt 前 attach 保障钩子(acp.prompt 裸路径的兜底;见 design-super-agent v2 前置修复) */
    setSessionAttachHook(hook: (sessionId: string) => Promise<void>): void;
  };
  /** workbench MCP server url(可能尚未就绪) */
  mcpUrl: () => string | null;
  /** sa:event 推送(workbench 窗口) */
  push: (payload: { kind: 'inbox'; taskId: string } | { kind: 'patrol'; at: number } | { kind: 'decision'; taskId: string } | { kind: 'tasks' }) => void;
  /** channel 项目树全量(session_list 工具/sessionWatch 标题用;index.ts 注入 scanner.scan) */
  scan: () => ChannelTree;
}

let deps: SaDeps | null = null;
/** 本进程内已 attach 过的 SA session(跨重启 resume 只做一次) */
const saAttached = new Set<string>();

/** sa_tasks 变更的统一事件出口(sa:event {kind:'tasks'};所有写路径都必须经这里推一次) */
function notifyTasksChanged(): void {
  deps?.push({ kind: 'tasks' });
}

export function initSuperAgent(d: SaDeps): void {
  deps = d;
  // 回传链:worker turn-done → digest 投 inbox/ → review → 唤醒 SA(design §5)
  deps.acp.addListener((channel, payload) => {
    if (channel === IPC.evTurnDone) {
      const p = payload as { sessionId: string; stopReason: string };
      void onWorkerTurnDone(p.sessionId).catch((err) => console.warn('[sa] 回传链处理失败:', err));
    }
  });
  ensureSuperWorkspace();
  repairSaTitles();
  migrateSaToolSnapshot();
  migrateSaRebuildV3();
  // prompt 前 attach 保障(最后一英里):桥/SUPER tab 的裸 prompt 也会先补挂 SA 的 MCP 工具
  deps.acp.setSessionAttachHook(async (sid) => {
    if (!isSuperSession(sid)) return; // 非 SA no-op(普通 chat 路径零变化)
    await ensureSaAttached(sid);
  });
}

/**
 * 一次性迁移 v3(2026-11-24 探针三铁证):
 * kimi resume 的 mcpServers 只在 session 无存储配置时生效——老 SA 创建时存了**无 sa_key 的 URL**,
 * resume 恒用存储配置,特权工具永远不可见。唯一可靠路径:创建时就用带 sa_key 的 URL。
 * → 重建默认 SA(新 session 创建即挂带 key 的 MCP + 引导注入),老 session 保留在列表可查可查历史。
 * 仅当已有 SA 时才迁移(全新安装不提前建,留给 getOrCreateSuperSession 懒创建);失败不写标记,下次启动重试。
 */
function migrateSaRebuildV3(): void {
  const settings = getSettings();
  if (settings.saRebuiltV3) return;
  if (!settings.superSessionId) {
    saveSettings({ saRebuiltV3: true }); // 无 SA 可迁,直接标记
    return;
  }
  void (async () => {
    try {
      const oldSid = settings.superSessionId!;
      const newSid = await createSuperSessionInner('主分身'); // 创建即带 sa_key URL(newSuperSession 的 mcpServers)
      // 新 SA 用正式名(盖住 inner 的「· 主分身」);老的标「旧」保留可查
      upsertSession({ sessionId: newSid, cwd: saDir(), title: '✦ Super Agent', createdAt: Date.now(), updatedAt: Date.now(), kind: 'chat' });
      const cur = getSessionIndex().find((s) => s.sessionId === oldSid);
      if (cur) upsertSession({ ...cur, title: '✦ Super Agent · 旧', updatedAt: Date.now() });
      saveSettings({ superSessionId: newSid, saRebuiltV3: true }); // 老 sid 已在 superSessionIds,不动
      console.log(`[sa] v3 重建完成:旧 ${oldSid} → 新 ${newSid}(创建即挂带 sa_key 的 MCP;老 session 保留可查)`);
      recordSignal('sa', `v3 重建:新 SA ${newSid.slice(0, 20)}(旧 ${oldSid.slice(0, 20)} 保留)`);
    } catch (err) {
      console.warn('[sa] v3 重建失败(下次启动重试):', err);
    }
  })();
}

/**
 * 一次性迁移(v2 前置修复):老 SA session 看不到特权工具(MCP 工具列表在 session 创建时快照)。
 * 实测结论(wire.jsonl llm.tools_snapshot 探针,2026-11-23):kimi **每 turn 重拉**工具列表,
 * 快照反映当时挂载(同一 session 先后 45→27 个工具);resume 带 MCP URL 即恢复/更新工具。
 * → 不重建 session(保留历史,用户的老 SA「你能干啥」不动),只给没有 sa_key 的老 SA 回填 key:
 * 下次 resume(ensureSaAttached)挂带 sa_key 的 URL → 特权工具即可见。
 */
function migrateSaToolSnapshot(): void {
  const settings = getSettings();
  if (settings.saRebuiltV2) return;
  const keys = { ...(settings.superSessionKeys ?? {}) };
  const have = new Set(Object.values(keys));
  let added = 0;
  for (const sid of settings.superSessionIds ?? []) {
    if (!have.has(sid)) {
      keys[crypto.randomBytes(8).toString('hex')] = sid;
      added++;
    }
  }
  saveSettings({ superSessionKeys: keys, saRebuiltV2: true });
  console.log(`[sa] 工具快照修复:resume 会重拉 MCP 工具(实测),不重建 session;回填 sa_key ${added} 个,老 SA session 保留在历史`);
}

/** 幂等修正:历史 SA session 标题被注入文本污染(<system-reminder>…)的改回正式名 */
function repairSaTitles(): void {
  const settings = getSettings();
  const index = getSessionIndex();
  for (const sid of settings.superSessionIds ?? []) {
    const cur = index.find((s) => s.sessionId === sid);
    if (!cur?.title.startsWith('<system-reminder>')) continue;
    upsertSession({
      ...cur,
      title: sid === settings.superSessionId ? '✦ Super Agent' : '✦ Super Agent · 旧',
    });
  }
}

function saDir(): string {
  return path.join(wbRoot(), 'super-agent');
}

function inboxDir(): string {
  return path.join(saDir(), 'inbox');
}

// ---------- 1. 工作区引导 ----------

/** v2 闭环节(GM 职责 / Playbook / 消息落点矩阵 / 说人话规范 / 交付标记协议),模板与迁移共用 */
const V2_SECTION = `## GM 职责(成文)

- 澄清:拿不准先问老板,不猜;
- 规划:拆解任务、选通道(延续性任务→原 session 带【SA·任务卡】前缀;全新独立任务→新开 session)、写任务卡;
- QC:verify_task 机检 + visual_check 亲眼判断;
- 汇报叙事:交付汇报 = 结果 + 机检证据 + 视觉截图 + 产物链接;
- 学习老板标准:验收反馈沉淀进 learning.md。

## Playbook(一页)

收到任务 → dispatch_task 下发 → 等回执(看交付标记)→ verify_task 机检 → 过:汇报老板 + sa_tasks 验收通过;不过:follow_up 打回(≤3 轮)→ 仍不过 / 失联 / 拿不准 → 升级「待你决策」。

## 消息落点矩阵

| 事件 | SUPER(SA 会话) | 看板卡 | worker 会话 | 通知 Boss |
|---|---|---|---|---|
| 派发 | SA 简述「已派给 X,验收标准是…」 | 新卡·进行中 | 【SA·任务卡】 | — |
| worker 交付 | (只唤醒 SA) | →待验收 | [TASK_DONE]+摘要 | — |
| SA 验收通过 | 交付汇报(结果/机检证据/视觉截图/产物链接) | →已完成 | 「验收通过 ✓」 | — |
| SA 打回 | 不打扰(记时间线) | →进行中(第N轮) | 【SA】打回+意见 | — |
| 3轮不过/失联/拿不准 | SA 请示 | →待你决策 | — | 🔔 |

## 说人话规范

对老板说人话——汇报用大白话,禁止堆术语;先说结论,再给证据;一句话能说清的不写两句;技术细节折叠为证据附录。

## 交付标记协议

任务卡末尾强制:worker 结束时必须输出一行 \`[TASK_DONE]\`+交付摘要 或 \`[TASK_BLOCKED]\`+原因;无标记的回执按「疑似未完成」处理(不转待验收)。`;

const AGENTS_MD = `# Super Agent(分身 GM)

你是用户的分身 GM:管理 worker agent 团队,解放用户注意力。
北极星指标:**升级率(需要人决策的次数 / 总推进任务数)随时间下降**。

**铁律:回答任何关于任务 / session / 进展的问题前,必须先用工具查实时数据(sa_tasks / session_list / session_digest),禁止凭记忆或上下文旧数据回答。**

**铁律 2:下发与通信一律走工具(dispatch_task / follow_up / session_message),禁止用 Bash 跑 kimi 命令行绕道;派发顺序——① 同项目已有托管(watch)或活跃 session → 一律原 session 带【SA·任务卡】前缀下发;② 仅全新独立任务/怕上下文污染才 session_create 新开;③ 禁止 CLI 绕道。**

## 决策边界矩阵(从严初版)

- signal(老板任务/巡逻/回执) → SA 自动,记录
- plan(拆解) → SA 自动;新建 agent/项目 → 人批
- orchestration(派发) → 自动;超轮次/预算 → 升级人
- worker(执行) → 自动;权限模式按任务卡
- verify(验收) → 机检自动;连挂 3 轮 → 升级人
- 产出对外可见(发布/推送/删除/花钱) → 必须人批

## when-how 路由目录

- 身份 / 决策边界 / 长期方法 → 本文件(agents.md)
- 事实 / 用户偏好 / 关键判断 → memory.md
- 任务看板(进行中/待验收/待老板决策/已完成) → tasks.md
- 方法论 / 审美 / 案例索引(进化日志) → learning.md
- worker 回执 → inbox/ 目录(sa_inbox 工具读取)
- 认领观察已有 session(无需新建)→ session_watch 工具(取消用 session_unwatch)
- 列出全部 session(回答数量/清单类问题前必须先调它) → session_list 工具
- UI/页面任务的视觉验收(截图亲眼判断) → visual_check 工具

## Guardrails(硬规则)

- **不写项目目录**——写项目只能由 worker 在各自项目里做;
- **不擅建 agent / 项目**——必须人批;
- **无可机检 acceptance 不下发任务卡**(evidence gate);
- 产出对外可见的动作(发布/推送/删除/花钱)必须人批。
- **视觉验收**:凡涉及 UI/页面的任务,acceptance 必须包含视觉预期(布局/样式要点),verify 时用 visual_check 截图并亲眼看图判断,不允许只过代码机检。

${V2_SECTION}
`;

const MEMORY_MD = `# SA 长期记忆

(事实 / 用户偏好 / 关键判断,逐条追加:- [YYYY-MM-DD] 内容)
`;

const TASKS_MD = `# SA 任务看板

## 进行中

## 待验收

## 待老板决策

## 已完成
`;

const LEARNING_MD = `# SA 进化日志

(方法论 / 审美 / 案例索引;每日 dreaming 浓缩写入)
`;

export function ensureSuperWorkspace(): string {
  const dir = saDir();
  fs.mkdirSync(inboxDir(), { recursive: true });
  const files: [string, string][] = [
    ['agents.md', AGENTS_MD],
    ['memory.md', MEMORY_MD],
    ['tasks.md', TASKS_MD],
    ['learning.md', LEARNING_MD],
  ];
  for (const [name, content] of files) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content); // 不存在才写,不覆盖用户内容
  }
  migrateAgentsMd(dir); // 已有工作区的幂等补充
  return dir;
}

const WATCH_ROUTE_LINE = '- 认领观察已有 session(无需新建)→ session_watch 工具(取消用 session_unwatch)';
const LIST_ROUTE_LINE = '- 列出全部 session(回答数量/清单类问题前必须先调它) → session_list 工具';
const VISUAL_ROUTE_LINE = '- UI/页面任务的视觉验收(截图亲眼判断) → visual_check 工具';
const IRON_RULE = '**铁律:回答任何关于任务 / session / 进展的问题前,必须先用工具查实时数据(sa_tasks / session_list / session_digest),禁止凭记忆或上下文旧数据回答。**';
/** v2 下发顺序铁律(含 CLI 绕道禁令;hooks 无项目级配置,退回 prompt 级护栏) */
const IRON_RULE_2 =
  '**铁律 2:下发与通信一律走工具(dispatch_task / follow_up / session_message),禁止用 Bash 跑 kimi 命令行绕道;派发顺序——① 同项目已有托管(watch)或活跃 session → 一律原 session 带【SA·任务卡】前缀下发;② 仅全新独立任务/怕上下文污染才 session_create 新开;③ 禁止 CLI 绕道。**';
const VISUAL_GUARD =
  '- **视觉验收**:凡涉及 UI/页面的任务,acceptance 必须包含视觉预期(布局/样式要点),verify 时用 visual_check 截图并亲眼看图判断,不允许只过代码机检。';

function migrateAgentsMd(dir: string): void {
  const file = path.join(dir, 'agents.md');
  try {
    let content = fs.readFileSync(file, 'utf8');
    const inboxAnchor = '- worker 回执 → inbox/ 目录(sa_inbox 工具读取)';
    if (!content.includes('session_watch')) {
      // watch 路由行:优先插在 inbox 路由行后,否则补一节 when-how
      content = content.includes(inboxAnchor)
        ? content.replace(inboxAnchor, `${inboxAnchor}\n${WATCH_ROUTE_LINE}`)
        : `${content.trimEnd()}\n\n## when-how 路由目录\n\n${WATCH_ROUTE_LINE}\n`;
    }
    if (!content.includes('session_list')) {
      // session_list 路由行:跟在 watch 行后(已有),否则 inbox 行后,否则追加
      const anchor = content.includes(WATCH_ROUTE_LINE) ? WATCH_ROUTE_LINE : inboxAnchor;
      content = content.includes(anchor)
        ? content.replace(anchor, `${anchor}\n${LIST_ROUTE_LINE}`)
        : `${content.trimEnd()}\n${LIST_ROUTE_LINE}\n`;
    }
    if (!content.includes('→ visual_check 工具')) {
      // visual_check 路由行:跟在 session_list 行后,否则 watch/inbox 行后,否则追加
      const anchor = content.includes(LIST_ROUTE_LINE)
        ? LIST_ROUTE_LINE
        : content.includes(WATCH_ROUTE_LINE)
          ? WATCH_ROUTE_LINE
          : inboxAnchor;
      content = content.includes(anchor)
        ? content.replace(anchor, `${anchor}\n${VISUAL_ROUTE_LINE}`)
        : `${content.trimEnd()}\n${VISUAL_ROUTE_LINE}\n`;
    }
    if (!content.includes('不允许只过代码机检')) {
      // 视觉验收规则:插在 Guardrails 末节最后一条后,找不到节则追加文件尾
      const lastGuard = '- 产出对外可见的动作(发布/推送/删除/花钱)必须人批。';
      content = content.includes(lastGuard)
        ? content.replace(lastGuard, `${lastGuard}\n${VISUAL_GUARD}`)
        : `${content.trimEnd()}\n\n## Guardrails(硬规则)\n\n${VISUAL_GUARD}\n`;
    }
    if (!content.includes('禁止凭记忆')) {
      // 铁律:跟在北极星指标行后,找不到则追加到文件尾
      const lines = content.split('\n');
      const idx = lines.findIndex((l) => l.includes('北极星指标'));
      if (idx >= 0) lines.splice(idx + 1, 0, '', IRON_RULE);
      else lines.push('', IRON_RULE);
      content = lines.join('\n');
    }
    if (!content.includes('禁止 CLI 绕道')) {
      // 铁律 2(下发顺序 + CLI 禁令):跟在铁律 1 行后,找不到则追加
      const lines = content.split('\n');
      const idx = lines.findIndex((l) => l.includes('禁止凭记忆'));
      if (idx >= 0) lines.splice(idx + 1, 0, '', IRON_RULE_2);
      else lines.push('', IRON_RULE_2);
      content = lines.join('\n');
    }
    if (!content.includes('消息落点矩阵')) {
      // v2 闭环节(GM 职责/Playbook/落点矩阵/说人话/交付标记),整节追加到文件尾
      content = `${content.trimEnd()}\n\n${V2_SECTION.trim()}\n`;
    }
    fs.writeFileSync(file, content);
  } catch {
    /* best-effort */
  }
}

// ---------- 2. SA 会话 ----------

const SA_BOOTSTRAP_PROMPT = [
  '<system-reminder>',
  '你是 Super Agent(分身 GM)——用户的分身,管理 worker agent 团队。',
  '',
  '## 工作区文件(当前 cwd 即你的家)',
  '- agents.md:你的身份、决策边界矩阵、when-how 路由目录(先读);',
  '- memory.md / tasks.md / learning.md:长期记忆 / 任务看板 / 进化日志;',
  '- inbox/:worker 回执信箱(有新回执时你会收到唤醒提示)。',
  '',
  '## 特权工具(仅你可用的 workbench MCP 工具)',
  '- session_digest(sid):任意 session 的进展摘要(title/cwd/busy/lastMessage/currentProcessMd);',
  '- session_create({cwd, taskCard}):创建 worker session 并下发任务卡。任务卡格式:',
  '  task_id / goal(一句话目标) / context(路径或链接,不塞全文) / acceptance(必填,可机检:「跑 X 命令通过」「产出 Y 文件含 Z」「指标 ≥ N」) / constraints(权限模式/禁做/最大轮次) / report(结论摘要+产物路径)。',
  '  硬规则:无可机检 acceptance 不下发(evidence gate);',
  '- session_watch({sid, goal?, acceptance?}):认领观察已有 session(无需新建);空 acceptance=纯观察(每轮回执持续投递),有 acceptance=带验收;取消用 session_unwatch(sid);',
  '- session_list({includeArchived?}):列出全部 session(回答数量/清单类问题前必须先调它);',
  '- visual_check({url, expect?, fullPage?}):UI/页面任务的视觉验收——截图并亲眼看图判断,不允许只过代码机检(需 kimi-webbridge 运行中);',
  '- session_message(sid, text):与任意 session 对话(busy 自动排队,终端接管会拒绝);',
  '',
  '## GM 工具箱(任务闭环用这三个,别手搓)',
  '- dispatch_task({sid?, cwd?, taskCard:{goal, acceptance 或 checks, constraints?, report?, context?}}):选通道+发卡+登记;sid=原 session 续接(【SA·任务卡】前缀,用户可见),cwd=新开 session。acceptance 支持结构化 checks:[{type:command,run,expect?}|{type:file,path,contains?}|{type:visual,url,expect}|{type:judgment,note}];',
  '- follow_up({taskId, text}):按任务卡跟进/打回,【SA】前缀;',
  '- verify_task({taskId}):执行 acceptance 机检(command/file/visual/judgment),返回 {pass, evidence[]};不自动改状态——你判断后再用 sa_tasks 更新或向老板汇报。',
  '任务卡末尾必须带交付标记要求:worker 结束时输出一行 `[TASK_DONE]`+交付摘要 或 `[TASK_BLOCKED]`+原因。',
  '',
  '- sa_tasks(action: list|add|update, payload):维护 tasks.md 看板;',
  '- sa_inbox():读 worker 回执信箱。',
  '',
  '## 决策边界(从严)',
  'signal/plan/派发/执行/机检验收 → 自动;新建 agent/项目、超轮次预算、验收连挂 3 轮、任何对外可见动作(发布/推送/删除/花钱)→ 升级给人(写进 tasks.md「待老板决策」并告诉用户)。',
  '',
  '## 铁律',
  '回答任何关于任务 / session / 进展的问题前,必须先用工具查实时数据(sa_tasks / session_list / session_digest),禁止凭记忆或上下文旧数据回答。',
  '下发与通信一律走工具(dispatch_task / follow_up / session_message),禁止用 Bash 跑 kimi 命令行绕道;同项目已有托管或活跃 session 时一律原 session 带【SA·任务卡】前缀下发,仅全新独立任务才新开。',
  '',
  '先读 agents.md 与 tasks.md,用一句话确认角色,然后待命。',
  '</system-reminder>',
].join('\n');

/** 带 sa_key 的 MCP 挂载 URL(特权工具调用方鉴权) */
function taggedMcpUrl(saKey: string): string | null {
  const base = deps?.mcpUrl() ?? null;
  return base ? `${base}?sa_key=${saKey}` : null;
}

async function createSuperSessionInner(label?: string): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const dir = ensureSuperWorkspace();
  const mcpBase = deps.mcpUrl();
  if (!mcpBase) throw new Error('workbench MCP 未就绪,无法创建 SA session');
  const saKey = crypto.randomBytes(8).toString('hex');
  const mcpUrl = `${mcpBase}?sa_key=${saKey}`;
  const workspace = path.join(os.homedir(), 'Desktop', 'Workspace'); // additionalDirectories:项目只读

  // 时序竞态修复(2026-11-24 探针实锤):kimi 在 session/new 时即连 MCP 做 tools/list——
  // key 必须先注册(暂存 pending:<ts>),否则门控拒绝、特权工具不进创建快照
  saveSettings({ superSessionKeys: { ...(getSettings().superSessionKeys ?? {}), [saKey]: `pending:${Date.now()}` } });
  let sid: string;
  try {
    sid = await deps.acp.newSuperSession({ cwd: dir, additionalDirectories: [workspace], mcpUrl });
  } catch (err) {
    const keys = { ...(getSettings().superSessionKeys ?? {}) };
    delete keys[saKey]; // 失败移除 pending key,不留孤儿
    saveSettings({ superSessionKeys: keys });
    throw err;
  }

  // 登记:superSessionIds(白名单)+ sa_key 更新为真 sid
  const settings = getSettings();
  const ids = new Set(settings.superSessionIds ?? []);
  ids.add(sid);
  saveSettings({
    superSessionId: settings.superSessionId ?? sid, // 首个成为默认 SA
    superSessionIds: [...ids],
    superSessionKeys: { ...(settings.superSessionKeys ?? {}), [saKey]: sid },
  });

  // 注入 SA 引导 prompt(等注入 turn 完成,防与用户 prompt 并发)
  try {
    await deps.acp.prompt(sid, SA_BOOTSTRAP_PROMPT, null, null);
  } catch (err) {
    console.warn('[sa] SA 引导注入失败(session 仍可用):', err);
  }
  saAttached.add(sid);
  upsertSession({ sessionId: sid, cwd: dir, title: label ? `✦ Super Agent · ${label}` : '✦ Super Agent', createdAt: Date.now(), updatedAt: Date.now(), kind: 'chat' });
  recordSignal('sa', `SA session 创建:${label ?? '默认'} ${sid.slice(0, 20)}`);
  return sid;
}

/** sa:get-session:默认 SA(无则创建) */
export async function getOrCreateSuperSession(): Promise<string> {
  const existing = getSettings().superSessionId;
  if (existing) return existing; // attach 在唤醒/prompt 时懒做
  return createSuperSessionInner();
}

/** sa:create-session:多开(不同上下文场景隔离,防污染) */
export async function createSuperSession(label?: string): Promise<string> {
  return createSuperSessionInner(label);
}

export function listSuperSessions(): { sessionId: string; title: string; main: boolean }[] {
  const settings = getSettings();
  const titles = new Map(getSessionIndex().map((s) => [s.sessionId, s.title] as const));
  return (settings.superSessionIds ?? []).map((sid) => ({
    sessionId: sid,
    title: titles.get(sid) || sid.slice(0, 16),
    main: sid === settings.superSessionId,
  }));
}

/** MCP 调用方归属解析:sa_key → 映射值(真 sid 或创建窗口期的 `pending:<ts>`;仅用于日志/归属) */
export function resolveSuperSessionByKey(saKey: string): string | null {
  return getSettings().superSessionKeys?.[saKey] ?? null;
}

/**
 * 门控(2026-11-24 时序竞态修复):key 存在于 superSessionKeys 即授权——
 * key 是 64-bit 随机秘密,存在即有效;创建窗口期的 pending 值也放行(极短,可接受)。
 */
export function isAuthorizedSaKey(saKey: string | null | undefined): boolean {
  if (!saKey) return false;
  return saKey in (getSettings().superSessionKeys ?? {});
}

export function isSuperSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && (getSettings().superSessionIds ?? []).includes(sessionId);
}

/** SA prompt 前确保 attach(跨重启 resume 一次);失败则按「session 已消失」重建 */
const saAttachInflight = new Map<string, Promise<void>>(); // 防重入:同一 sid 并发 attach 共享一个 promise

async function ensureSaAttached(sid: string): Promise<void> {
  if (saAttached.has(sid)) return;
  const inflight = saAttachInflight.get(sid);
  if (inflight) return inflight;
  const p = (async () => {
    const settings = getSettings();
    const saKey = Object.entries(settings.superSessionKeys ?? {}).find(([, v]) => v === sid)?.[0];
    const mcpUrl = saKey ? taggedMcpUrl(saKey) : null;
    if (!mcpUrl) throw new Error('SA session 缺少 sa_key,无法 resume');
    await deps!.acp.resumeSessionWithMcp(sid, saDir(), mcpUrl);
    saAttached.add(sid);
  })();
  saAttachInflight.set(sid, p);
  try {
    await p;
  } finally {
    saAttachInflight.delete(sid);
  }
}

// ---------- 3. 特权工具实现(mcpserver 调用) ----------

export async function sessionDigest(sid: string): Promise<string> {
  const idx = getSessionIndex().find((s) => s.sessionId === sid);
  const meta = allChannelMeta().find((m) => m.session_id === sid);
  const cwd = deps?.acp ? findSessionCwd(sid) : null;
  const cfg = cwd ? readSessionConfig(cwd, sid) : null;
  return JSON.stringify(
    {
      sessionId: sid,
      title: idx?.title ?? '',
      cwd: cwd ?? null,
      busy: deps?.acp.isBusy(sid) ?? false,
      held: deps?.acp.isHeld(sid) ?? false,
      lastMessage: meta?.last_message ?? '',
      updatedAt: meta?.last_message_at ?? null,
      currentProcessMd: cfg?.currentProcessMd ?? '',
    },
    null,
    1,
  );
}

export interface SaCheck {
  type: 'command' | 'file' | 'visual' | 'judgment';
  run?: string; // command: 要执行的命令(项目目录内)
  expect?: string; // command: stdout 须包含;visual: 视觉预期
  path?: string; // file: 项目内路径
  contains?: string; // file: 内容须包含
  url?: string; // visual: 截图 URL
  note?: string; // judgment: SA 自己判的说明
}

export interface TaskCard {
  task_id?: string;
  goal?: string;
  context?: string;
  acceptance?: string;
  /** 结构化验收(design v2):与自由文本 acceptance 二选一/并存 */
  checks?: SaCheck[];
  constraints?: string;
  report?: string;
}

/** 任务卡正文(session_create/dispatch_task 共用;v2:末尾强制交付标记行) */
function buildTaskCardText(taskId: string, card: TaskCard): string {
  const acceptanceText =
    card.acceptance?.trim() ||
    (card.checks?.length ? JSON.stringify(card.checks) : '');
  return [
    `# 任务卡 ${taskId}`,
    `goal: ${card.goal!.trim()}`,
    card.context ? `context: ${card.context}` : null,
    `acceptance(可机检): ${acceptanceText}`,
    card.constraints ? `constraints: ${card.constraints}` : null,
    card.report ? `report: ${card.report}` : 'report: 完成后给出结论摘要 + 产物路径。',
    '结束时你必须输出一行 `[TASK_DONE]`+交付摘要 或 `[TASK_BLOCKED]`+原因。',
    '完成后你会被自动回执,无需汇报过程。',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function sessionCreateWorker(opts: { cwd: string; taskCard: TaskCard }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const card = opts.taskCard ?? {};
  // evidence gate(design §4):无可机检 acceptance 不下发(自由文本或结构化 checks 皆可)
  const hasAcceptance = !!card.acceptance?.trim() || !!card.checks?.length;
  if (!hasAcceptance)
    return '✗ 拒绝下发:任务卡缺少可机检的 acceptance(evidence gate)。正确做法:acceptance 给自由文本(如「npm run build 通过」)或 checks 数组(如 [{type:"command",run:"npm test"}])。';
  if (!card.goal?.trim()) return '✗ 拒绝下发:任务卡缺少 goal。补上 goal(一句话目标)后重试。';
  const taskId = card.task_id?.trim() || `sat-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const { sessionId } = await deps.acp.newChannelSession({ cwd: opts.cwd });
  insertSaTask({
    task_id: taskId,
    session_id: sessionId,
    goal: card.goal.trim().slice(0, 300),
    acceptance: (card.acceptance?.trim() || JSON.stringify(card.checks)).slice(0, 500),
    status: 'in_progress',
    created_at: Date.now(),
  });
  const prompt = ['<system-reminder>', buildTaskCardText(taskId, card), '</system-reminder>'].join('\n');
  void deps.acp.prompt(sessionId, prompt, null, null).catch((err) => console.warn('[sa] 任务卡注入失败:', err));
  recordSignal('sa', `任务卡 ${taskId} 下发 → ${sessionId.slice(0, 20)} (${opts.cwd})`);
  notifyTasksChanged();
  return JSON.stringify({ sessionId, taskId, note: '已登记,worker 完成后会自动回执到 inbox,你无需轮询。' });
}

export async function sessionMessage(sid: string, text: string): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  if (deps.acp.isHeld(sid)) return '✗ 该 session 正被终端接管(held),拒绝发送。等用户在终端点「交还」后再试,或用其他 session。';
  // busy 排队等 idle(30s 超时,同 orchestrator 思路;铁律:不打断在跑的 turn)
  const deadline = Date.now() + 30_000;
  while (deps.acp.isBusy(sid)) {
    if (Date.now() > deadline) return '✗ 目标 session 忙(等待 30s 超时),稍后再试;或在 tasks.md 记下等下轮巡逻再跟进。';
    await new Promise((r) => setTimeout(r, 500));
  }
  await deps.acp.prompt(sid, text, null, null);
  // 自愈:未登记的对话对象自动补登 watching(回传链永远不断链)
  if (!getSaTaskBySession(sid)) {
    const taskId = `watch-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    insertSaTask({ task_id: taskId, session_id: sid, goal: 'SA 主动对话', acceptance: '', status: 'watching', created_at: Date.now() });
    notifyTasksChanged();
    recordSignal('sa', `自动登记观察 ${sid.slice(0, 20)}(SA 主动对话)`);
    return `✓ 已发送(已自动登记观察 ${taskId},对方 turn 结束你会收到回执)`;
  }
  return '✓ 已发送';
}

/**
 * 认领观察已有 session(无需新建):
 * - acceptance 为空 → status='watching'(纯观察,每轮 turn-done 都投回执,不流转 review);
 * - 有 acceptance → status='in_progress'(与任务卡 worker 同语义,turn-done 流转 review 待验收)。
 */
export async function sessionWatch(opts: { sid: string; goal?: string; acceptance?: string }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const sid = opts.sid.trim();
  if (!findSessionCwd(sid)) return '✗ 找不到该 session(scanner 无记录)。先用 session_list 拿实时 sid 再认领。';
  const existing = getSaTaskBySession(sid);
  if (existing && existing.status !== 'done') return JSON.stringify({ taskId: existing.task_id, already: true, note: '已在观察中,回执会继续投递到 inbox。' });
  const taskId = `watch-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const goal = opts.goal?.trim() || '观察已有 session';
  const acceptance = opts.acceptance?.trim() ?? '';
  insertSaTask({
    task_id: taskId,
    session_id: sid,
    goal: goal.slice(0, 300),
    acceptance: acceptance.slice(0, 500),
    status: acceptance ? 'in_progress' : 'watching',
    created_at: Date.now(),
  });
  // 看板行:标题优先(scanner 数据),没有就 sid 前 12 位;sid 始终保留兜底
  let title = '';
  try {
    for (const p of deps.scan().projects) {
      const hit = p.sessions.find((s) => s.id === sid);
      if (hit) {
        title = hit.title;
        break;
      }
    }
  } catch {
    /* scanner 失败不挡认领 */
  }
  const label = title && title !== '未命名会话' ? title : sid.slice(0, 12);
  addTaskLine(`[${taskId}] ${goal} —— ${label}(${sid.slice(0, 12)})`, '进行中'); // 事件由本函数统一推,不走 saTasksTool(防双推)
  recordSignal('sa', `认领观察 ${sid.slice(0, 20)} → ${taskId}${acceptance ? '' : '(纯观察)'}`);
  notifyTasksChanged();
  return JSON.stringify({ taskId, note: '已登记观察,该 session 每轮 turn 结束都会自动投回执到 inbox,你无需轮询。' });
}

/** 取消认领:sa_tasks 该 sid 记录改 'done'(回传链不再跟进) */
export function sessionUnwatch(sid: string): string {
  const existing = getSaTaskBySession(sid);
  if (!existing || existing.status === 'done') return '✗ 该 session 未被认领';
  updateSaTaskStatus(existing.task_id, 'done');
  try {
    updateTaskLine(existing.task_id, 'done');
  } catch (err) {
    console.warn('[sa] 看板更新失败:', err);
  }
  recordSignal('sa', `取消观察 ${sid.slice(0, 20)}(${existing.task_id})`);
  notifyTasksChanged();
  return JSON.stringify({ ok: true, taskId: existing.task_id });
}

/** session_list:scanner 全量,updatedAt 倒序;默认排除 ephemeral 与归档组,includeArchived 时包含 */
export function sessionList(includeArchived = false): string {
  if (!deps) throw new Error('super-agent 未初始化');
  const out: { sid: string; title: string; cwd: string; busy: boolean; updatedAt: number; lastMessage: string }[] = [];
  for (const p of deps.scan().projects) {
    if (p.bucket === 'archive' && !includeArchived) continue;
    for (const s of p.sessions) {
      if (s.ephemeral && !includeArchived) continue;
      out.push({
        sid: s.id,
        title: s.title,
        cwd: p.cwd,
        busy: s.busy,
        updatedAt: s.updatedAt,
        lastMessage: (s.lastMessage || s.lastPrompt).slice(0, 100),
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return JSON.stringify(out.slice(0, 100), null, 1); // MCP 载荷上限保护
}

// ---------- visual_check(kimi-webbridge 截图验收) ----------
const WEBBRIDGE_CMD = 'http://127.0.0.1:10086/command';

async function wbCommand(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(WEBBRIDGE_CMD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: 'sa-visual-check' }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { success?: boolean; error?: string } & Record<string, unknown>;
  if (!res.ok || data.success === false) throw new Error(data.error ?? `webbridge HTTP ${res.status}`);
  return data;
}

/**
 * 视觉验收:webbridge 打开 url(新标签,组名「SA 视觉校验」)→ 等页面稳定 →
 * jpeg 截图存 wbRoot()/super-agent/shots/。daemon 不可达返回引导错误。
 * fullPage 仅入参保留(daemon screenshot 暂无该参数,不转发未知参数)。
 */
export async function visualCheck(opts: { url: string; expect?: string; fullPage?: boolean }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const dir = path.join(saDir(), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.jpeg`);
  try {
    await wbCommand('navigate', { url: opts.url, newTab: true, group_title: 'SA 视觉校验' });
    await new Promise((r) => setTimeout(r, opts.fullPage ? 5000 : 3000)); // 等页面稳定
    const shot = await wbCommand('screenshot', { format: 'jpeg', quality: 70, path: file });
    const outPath = typeof shot.path === 'string' ? shot.path : file;
    return JSON.stringify({
      path: outPath,
      expect: opts.expect ?? '',
      note: '用 ReadMediaFile 查看截图,对照 expect 检查(布局/样式要点)',
    });
  } catch (err) {
    return `✗ kimi-webbridge 不可达或截图失败,请先启动 kimi-webbridge(${String(err).slice(0, 200)})`;
  }
}

// ---------- GM 工具箱(design-super-agent v2:loop 固化) ----------

/** 以普通用户消息身份发话(【SA·任务卡】/【SA】前缀,用户可见,不走 system-reminder 隐身) */
async function sendAsUser(sid: string, text: string, fireAndForget = false): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  if (deps.acp.isHeld(sid)) return '✗ 该 session 正被终端接管(held),拒绝发送';
  const deadline = Date.now() + 30_000; // busy 排队等 idle(铁律:不打断在跑的 turn)
  while (deps.acp.isBusy(sid)) {
    if (Date.now() > deadline) return '✗ 目标 session 忙(等待 30s 超时),稍后再试';
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fireAndForget) {
    void deps.acp.prompt(sid, text, null, null).catch((err) => console.warn('[sa] 发送失败:', err));
  } else {
    await deps.acp.prompt(sid, text, null, null);
  }
  return '✓ 已发送';
}

/** dispatch_task:选通道 + 发卡 + 登记,一条命令。sid→原 session(可见任务卡);cwd→新建 worker */
export async function dispatchTask(opts: { sid?: string; cwd?: string; taskCard: TaskCard }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const card = opts.taskCard ?? {};
  const hasAcceptance = !!card.acceptance?.trim() || !!card.checks?.length;
  if (!hasAcceptance)
    return '✗ 拒绝下发:任务卡缺少可机检的 acceptance(evidence gate)。正确做法:acceptance 给自由文本(如「npm run build 通过」)或 checks 数组(如 [{type:"command",run:"npm test"}])。';
  if (!card.goal?.trim()) return '✗ 拒绝下发:任务卡缺少 goal。补上 goal(一句话目标)后重试。';
  if (!opts.sid && !opts.cwd) return '✗ dispatch_task 需要 sid(原 session 续接)或 cwd(新开)。同项目有活跃 session 就传 sid;全新任务传 cwd。';
  const taskId = `sat-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  const cardText = buildTaskCardText(taskId, card);

  let sid: string;
  if (opts.sid) {
    // 通道 A:原 session 续接(上下文连续;普通用户消息,带【SA·任务卡】前缀,用户可见)
    sid = opts.sid.trim();
    if (!findSessionCwd(sid)) return '✗ 找不到该 session(scanner 无记录)';
    const r = await sendAsUser(sid, `【SA·任务卡】\n${cardText}`, true);
    if (r.startsWith('✗')) return r;
  } else {
    // 通道 B:新开 session(干净上下文;system-reminder 注入,回放不可见)
    const r = await deps.acp.newChannelSession({ cwd: opts.cwd! });
    sid = r.sessionId;
    void deps.acp
      .prompt(sid, ['<system-reminder>', cardText, '</system-reminder>'].join('\n'), null, null)
      .catch((err) => console.warn('[sa] 任务卡注入失败:', err));
  }
  insertSaTask({
    task_id: taskId,
    session_id: sid,
    goal: card.goal.trim().slice(0, 300),
    acceptance: (card.acceptance?.trim() || JSON.stringify(card.checks)).slice(0, 500),
    status: 'in_progress',
    created_at: Date.now(),
  });
  recordSignal('sa', `派发 ${taskId} → ${sid.slice(0, 20)}(${opts.sid ? '原 session' : '新建'})`);
  notifyTasksChanged();
  return JSON.stringify({ sessionId: sid, taskId, note: '已登记,worker 完成后会自动回执到 inbox,你无需轮询。' });
}

/** follow_up:按 taskId 找 worker 跟进/打回,【SA】前缀;刷新 updatedAt */
export async function followUp(opts: { taskId: string; text: string }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const task = getSaTask(opts.taskId);
  if (!task) return `✗ 找不到任务 ${opts.taskId}。先用 sa_tasks({action:"list"}) 或 session_list 核对 taskId。`;
  if (!opts.text?.trim()) return '✗ follow_up 需要 text。给出跟进/打回内容后重试。';
  const r = await sessionMessage(task.session_id, `【SA】${opts.text.trim()}`);
  if (!r.startsWith('✗')) updateSaTask(task.task_id, {}); // 刷新 updatedAt
  return r;
}

/** verify_task:执行 acceptance 机检(command/file/visual/judgment),返回证据;不自动改状态 */
export async function verifyTask(opts: { taskId: string }): Promise<string> {
  if (!deps) throw new Error('super-agent 未初始化');
  const task = getSaTask(opts.taskId);
  if (!task) return `✗ 找不到任务 ${opts.taskId}`;
  // acceptance 可能是结构化 checks JSON,也可能是自由文本(自由文本 → judgment 让 SA 自己判)
  let checks: SaCheck[] = [];
  try {
    const parsed = JSON.parse(task.acceptance) as unknown;
    if (Array.isArray(parsed)) checks = parsed as SaCheck[];
  } catch {
    /* 自由文本 */
  }
  if (checks.length === 0) checks = [{ type: 'judgment', note: task.acceptance }];
  const projectCwd = findSessionCwd(task.session_id);

  const evidence: { type: string; ok: boolean; detail: string }[] = [];
  for (const c of checks) {
    if (c.type === 'command' && c.run) {
      if (!projectCwd) {
        evidence.push({ type: 'command', ok: false, detail: '项目目录不可知,无法执行命令' });
        continue;
      }
      recordSignal('sa', `verify command(${task.task_id}): ${c.run.slice(0, 80)} @ ${projectCwd}`);
      evidence.push(await runCommandCheck(c.run, projectCwd, c.expect));
    } else if (c.type === 'file' && c.path) {
      evidence.push(runFileCheck(c.path, c.contains, projectCwd));
    } else if (c.type === 'visual' && c.url) {
      const r = await visualCheck({ url: c.url, expect: c.expect });
      if (r.startsWith('✗')) {
        evidence.push({ type: 'visual', ok: false, detail: r });
      } else {
        const shot = JSON.parse(r) as { path: string };
        evidence.push({ type: 'visual', ok: true, detail: `截图 ${shot.path} → 用 ReadMediaFile 亲眼对照 expect 判断` });
      }
    } else if (c.type === 'judgment') {
      evidence.push({ type: 'judgment', ok: true, detail: c.note ?? '' });
    } else {
      evidence.push({ type: c.type ?? 'unknown', ok: false, detail: `未知 check 类型: ${JSON.stringify(c).slice(0, 120)}` });
    }
  }
  // judgment 条目不参与机检 pass 判定(SA 自己判断);其余全过才 pass
  const pass = evidence.length > 0 && evidence.filter((e) => e.type !== 'judgment').every((e) => e.ok);
  return JSON.stringify({ pass, evidence }, null, 1);
}

/** command 机检:项目目录内执行(60s 超时;有意为之的命令,落 signals 审计) */
function runCommandCheck(run: string, cwd: string, expect?: string): Promise<{ type: string; ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', run], { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? -1 : 0;
      const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : '')).trim();
      let ok = code === 0;
      let detail = `exit=${code}; stdout: ${out.slice(0, 500) || '(空)'}`;
      if (ok && expect) {
        ok = stdout.includes(expect);
        detail += `; expect「${expect}」${ok ? '命中' : '未命中'}`;
      }
      resolve({ type: 'command', ok, detail });
    });
  });
}

/** file 机检:读文件查 contains(路径沙箱:限制在项目目录内) */
function runFileCheck(p: string, contains: string | undefined, projectCwd: string | null): { type: string; ok: boolean; detail: string } {
  if (!projectCwd) return { type: 'file', ok: false, detail: '项目目录不可知,无法读文件' };
  const resolved = path.resolve(projectCwd, p);
  if (resolved !== projectCwd && !resolved.startsWith(projectCwd + path.sep)) {
    return { type: 'file', ok: false, detail: `路径越出项目目录,拒绝: ${p}` };
  }
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    if (!contains) return { type: 'file', ok: true, detail: `${p} 存在(${content.length} 字符)` };
    const ok = content.includes(contains);
    return { type: 'file', ok, detail: `${p} ${ok ? '包含' : '不包含'}「${contains.slice(0, 80)}」` };
  } catch (err) {
    return { type: 'file', ok: false, detail: `读取失败: ${String(err).slice(0, 120)}` };
  }
}

// ---------- SA 工作区文件白名单读写(sa:read-file / sa:write-file,设置区用) ----------

const SA_FILE_WHITELIST = new Set(['agents.md', 'memory.md', 'learning.md', 'tasks.md']);

export function readSaFile(name: string): string | null {
  if (!SA_FILE_WHITELIST.has(name) || path.basename(name) !== name) return null; // 白名单 + 防穿越
  try {
    return fs.readFileSync(path.join(saDir(), name), 'utf8');
  } catch {
    return '';
  }
}

export function writeSaFile(name: string, content: string): boolean {
  if (!SA_FILE_WHITELIST.has(name) || path.basename(name) !== name) return false;
  fs.writeFileSync(path.join(saDir(), name), content);
  return true;
}

export function readTasksMd(): string {
  try {
    return fs.readFileSync(path.join(saDir(), 'tasks.md'), 'utf8');
  } catch {
    return '';
  }
}

const SECTION_BY_STATUS: Record<string, string> = {
  in_progress: '进行中',
  review: '待验收',
  decision: '待老板决策',
  done: '已完成',
};

/** 把含 taskId 的行移到目标 section(不存在则追加一行) */
export function updateTaskLine(taskId: string, status: string): boolean {
  const section = SECTION_BY_STATUS[status];
  if (!section) return false;
  const file = path.join(saDir(), 'tasks.md');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : TASKS_MD;
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.includes(taskId));
  let line = '';
  if (idx >= 0) line = lines.splice(idx, 1)[0].trim();
  if (!line) {
    const dbRow = listSaTasks().find((t) => t.task_id === taskId);
    line = `- [${taskId}] ${dbRow?.goal ?? ''}`.trimEnd();
  }
  // 插到目标 section 标题之后
  const header = `## ${section}`;
  const hIdx = lines.findIndex((l) => l.trim() === header);
  if (hIdx >= 0) {
    let insertAt = hIdx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    // 插入到该 section 已有条目之后(下一个 ## 之前)
    let end = insertAt;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    lines.splice(end, 0, line);
  } else {
    lines.push('', header, line);
  }
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

/** tasks.md 追加一行到指定 section(不含事件;事件由外层写路径统一推,见 notifyTasksChanged) */
function addTaskLine(text: string, section: string): void {
  const file = path.join(saDir(), 'tasks.md');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : TASKS_MD;
  const lines = content.split('\n');
  const header = `## ${section}`;
  const hIdx = lines.findIndex((l) => l.trim() === header);
  const line = `- ${text}`;
  if (hIdx >= 0) {
    let end = hIdx + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    lines.splice(end, 0, line);
  } else {
    lines.push('', header, line);
  }
  fs.writeFileSync(file, lines.join('\n'));
}

export function saTasksTool(action: string, payload: { task_id?: string; status?: string; text?: string; section?: string }): string {
  switch (action) {
    case 'list':
      return readTasksMd() || '(tasks.md 为空)';
    case 'add': {
      if (!payload.text?.trim()) return '✗ add 需要 text';
      const section = payload.section && Object.values(SECTION_BY_STATUS).includes(payload.section) ? payload.section : '进行中';
      addTaskLine(payload.text.trim(), section);
      notifyTasksChanged(); // SA 自己改看板也要推
      return `✓ 已加入「${section}」`;
    }
    case 'update': {
      if (!payload.task_id || !payload.status) return '✗ update 需要 task_id 与 status';
      if (!SECTION_BY_STATUS[payload.status]) return `✗ 非法 status(可选:${Object.keys(SECTION_BY_STATUS).join('/')})`;
      updateSaTaskStatus(payload.task_id, payload.status); // db 同步(回传链以 db 为准)
      if (payload.status === 'decision') notifyDecision(payload.task_id); // SA 自己升级也要弹通知
      updateTaskLine(payload.task_id, payload.status);
      notifyTasksChanged();
      return `✓ ${payload.task_id} → ${SECTION_BY_STATUS[payload.status]}`;
    }
    default:
      return '✗ 未知 action(可选:list/add/update)';
  }
}

// ---------- inbox 回执信箱 ----------

export interface InboxEntry {
  file: string;
  taskId: string;
  at: number;
  preview: string;
}

export function listInbox(): InboxEntry[] {
  const dir = inboxDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      let preview = '';
      try {
        preview = fs.readFileSync(full, 'utf8').slice(0, 500);
      } catch {
        /* ignore */
      }
      return { file: f, taskId: f.replace(/-\d+\.md$/, ''), at: stat.mtimeMs, preview }; // 文件名 <taskId>-<ts>.md,taskId 本身含 '-'
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
}

export function readInboxFile(file: string): string | null {
  const safe = path.basename(file); // 防路径穿越
  const full = path.join(inboxDir(), safe);
  if (!full.startsWith(inboxDir()) || !fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

// ---------- 回传链(worker → SA) ----------

async function onWorkerTurnDone(sessionId: string): Promise<void> {
  if (!deps) return;
  const task = getSaTaskBySession(sessionId);
  // in_progress(任务卡/带验收的认领)与 watching(纯观察认领)都跟进;done 不再回执
  if (!task || (task.status !== 'in_progress' && task.status !== 'watching')) return;

  // 0. 交付标记解析(design v2:turn-done ≠ 任务完成)
  const lastMsg = allChannelMeta().find((m) => m.session_id === sessionId)?.last_message ?? '';
  const marker = lastMsg.includes('[TASK_BLOCKED]') ? 'blocked' : lastMsg.includes('[TASK_DONE]') ? 'done' : 'none';
  const markerText =
    marker === 'done' ? '[TASK_DONE] 交付' : marker === 'blocked' ? '[TASK_BLOCKED] 阻塞' : '无交付标记,疑似未完成';

  // 1. digest 投 inbox/
  const meta = allChannelMeta().find((m) => m.session_id === sessionId);
  const cwd = findSessionCwd(sessionId);
  const cfg = cwd ? readSessionConfig(cwd, sessionId) : null;
  const file = `${task.task_id}-${Date.now()}.md`;
  const digest = [
    `# 回执 ${task.task_id}`,
    '',
    `- task_id: ${task.task_id}`,
    `- worker: ${sessionId}`,
    `- 项目: ${cwd ?? '(未知)'}`,
    `- goal: ${task.goal}`,
    `- acceptance: ${task.acceptance || '(纯观察,不验收)'}`,
    `- 交付标记: ${markerText}`,
    `- 时间: ${new Date().toISOString()}`,
    '',
    '## 最后一条消息',
    '',
    meta?.last_message ?? '(无)',
    '',
    '## current-process.md',
    '',
    cfg?.currentProcessMd || '(空)',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(inboxDir(), file), digest);

  // 2. 状态流转(标记语义):done → review(待验收);blocked → decision(升级);
  //    无标记 → 回执照常但保持 in_progress(疑似未完成);watching 恒保持(纯观察,持续投递)
  if (task.status === 'in_progress') {
    if (marker === 'done') {
      updateSaTaskStatus(task.task_id, 'review');
      try {
        updateTaskLine(task.task_id, 'review');
      } catch (err) {
        console.warn('[sa] 看板更新失败:', err);
      }
      notifyTasksChanged();
    } else if (marker === 'blocked') {
      updateSaTaskStatus(task.task_id, 'decision');
      try {
        updateTaskLine(task.task_id, 'decision');
      } catch (err) {
        console.warn('[sa] 看板更新失败:', err);
      }
      notifyDecision(task.task_id);
      notifyTasksChanged();
    }
    // marker === 'none':不写状态不推 tasks 事件(回执已投,SA 唤醒时会看到标注)
  }
  deps.push({ kind: 'inbox', taskId: task.task_id });
  recordSignal('sa', `回执 ${task.task_id} → inbox/${file}(${markerText}${task.status === 'watching' ? ',观察中' : ''})`);

  // 3. 唤醒默认 SA(SA busy 则跳过,文件在不丢)
  const saSid = getSettings().superSessionId;
  if (!saSid) return;
  // attach ≠ prompt:先挂工具(即使本轮 SA 忙,挂载对后续生效)
  try {
    await ensureSaAttached(saSid);
  } catch (err) {
    console.warn('[sa] 唤醒 attach 失败(回执在 inbox 不丢):', err);
    return;
  }
  if (deps.acp.isBusy(saSid) || deps.acp.isHeld(saSid)) {
    console.log(`[sa] SA 忙/被持,唤醒跳过(回执在 inbox/${file};工具已挂)`);
    return;
  }
  try {
    await deps.acp.prompt(saSid, `<system-reminder>任务 ${task.task_id} 有新回执(inbox/${file}),请按验收标准验收,并更新 tasks.md 看板。</system-reminder>`, null, null);
  } catch (err) {
    console.warn('[sa] 唤醒 SA 失败(回执在 inbox 不丢):', err);
  }
}

/** 冒烟/调试用:注销任务登记 */
export function removeSaTask(taskId: string): void {
  deleteSaTask(taskId);
}

// ---------- cron 巡逻(design-super-agent §5:SA 循环 = cron 巡逻 + 事件唤醒 + 用户直聊) ----------

const PATROL_PROMPT = [
  '<system-reminder>',
  '巡逻时间到:请读 tasks.md 检查在途任务,对 watch 中的 session 用 session_digest 检查进展;',
  '发现停滞(卡住/超时无进展)的主动跟进或升级给用户;无事则安静结束,不需要输出。',
  '</system-reminder>',
].join('\n');

const DEFAULT_PATROL_INTERVAL_MIN = 120;
const FIRST_PATROL_DELAY_MS = 2 * 60_000; // 启动后 2 分钟先跑一轮(让工作区建立感知)

let patrolTimer: NodeJS.Timeout | null = null;
let patrolNextAt: number | null = null;
let patrolLastRunAt: number | null = null;

function patrolEnabled(): boolean {
  return getSettings().saPatrolEnabled !== false; // 默认开
}

function patrolIntervalMs(): number {
  return (getSettings().saPatrolIntervalMin ?? DEFAULT_PATROL_INTERVAL_MIN) * 60_000;
}

/** 启动调度(幂等;enabled=false 时只停不启)。firstDelayMs 可覆盖首轮延迟。 */
export function startPatrol(firstDelayMs?: number): void {
  stopPatrol();
  if (!patrolEnabled()) return;
  const interval = patrolIntervalMs();
  patrolNextAt = Date.now() + (firstDelayMs ?? interval);
  // 递归 setTimeout:nextRunAt 准确、不漂移;timer unref 不挡退出
  const tick = (): void => {
    void runPatrol().catch((err) => console.warn('[sa] 巡逻失败:', err));
    patrolNextAt = Date.now() + interval;
    patrolTimer = setTimeout(tick, interval);
    patrolTimer.unref();
  };
  patrolTimer = setTimeout(tick, firstDelayMs ?? interval);
  patrolTimer.unref();
  console.log(`[sa] 巡逻已排程(间隔 ${getSettings().saPatrolIntervalMin ?? DEFAULT_PATROL_INTERVAL_MIN}min)`);
}

export function stopPatrol(): void {
  if (patrolTimer) clearTimeout(patrolTimer);
  patrolTimer = null;
  patrolNextAt = null;
}

export function reschedulePatrol(): void {
  startPatrol();
}

export function getPatrolConfig(): { enabled: boolean; intervalMin: number; lastRunAt: number | null; nextRunAt: number | null } {
  return {
    enabled: patrolEnabled(),
    intervalMin: getSettings().saPatrolIntervalMin ?? DEFAULT_PATROL_INTERVAL_MIN,
    lastRunAt: patrolLastRunAt,
    nextRunAt: patrolEnabled() ? patrolNextAt : null,
  };
}

export function setPatrolConfig(patch: { enabled?: boolean; intervalMin?: number }): ReturnType<typeof getPatrolConfig> {
  if (patch.intervalMin !== undefined && (!Number.isInteger(patch.intervalMin) || patch.intervalMin < 5 || patch.intervalMin > 1440)) {
    throw new Error('intervalMin 合法范围 5~1440 分钟');
  }
  saveSettings({
    ...(patch.enabled !== undefined ? { saPatrolEnabled: patch.enabled } : {}),
    ...(patch.intervalMin !== undefined ? { saPatrolIntervalMin: patch.intervalMin } : {}),
  });
  startPatrol(); // 停/启/重排程即时生效
  return getPatrolConfig();
}

/** 执行一轮巡逻:SA busy/held 跳过(日志,不补);成功推 sa:event {kind:'patrol'} */
export async function runPatrol(): Promise<{ ok: boolean; reason?: string }> {
  if (!deps) return { ok: false, reason: 'not-initialized' };
  const saSid = getSettings().superSessionId;
  if (!saSid) return { ok: false, reason: 'no-sa-session' };
  // attach ≠ prompt:先挂工具再判断忙闲(此前 attach 在 busy 检查之后,SA 忙时永远没机会挂)
  try {
    await ensureSaAttached(saSid);
  } catch (err) {
    console.warn('[sa] 巡逻 attach 失败(本轮放弃):', err);
    return { ok: false, reason: 'attach-failed' };
  }
  if (deps.acp.isBusy(saSid) || deps.acp.isHeld(saSid)) {
    console.log('[sa] 巡逻跳过(SA 忙/被持,本轮不补;工具已挂)');
    return { ok: false, reason: 'busy' };
  }
  await deps.acp.prompt(saSid, PATROL_PROMPT, null, null);
  patrolLastRunAt = Date.now();
  deps.push({ kind: 'patrol', at: patrolLastRunAt });
  recordSignal('sa', '巡逻完成');
  return { ok: true };
}

/** app 启动时调用:enabled 则排程,首轮 2 分钟后 */
export function startPatrolOnBoot(): void {
  if (patrolEnabled()) startPatrol(FIRST_PATROL_DELAY_MS);
}

// ---------- 验收卡(design-super-agent §6:机检自动,连挂 3 轮升级人) ----------

const REJECT_ROUND_LIMIT = 3;

/** 「待你决策」通知:桌面 Notification + 点击 push sa:event {kind:'decision'} */
function notifyDecision(taskId: string): void {
  const goal = listSaTasks().find((t) => t.task_id === taskId)?.goal ?? taskId;
  recordSignal('sa', `待你决策:${taskId} ${goal.slice(0, 60)}`);
  try {
    const n = new Notification({ title: 'Super Agent 需要你拍板', body: goal.slice(0, 60) });
    n.on('click', () => deps?.push({ kind: 'decision', taskId }));
    n.show();
  } catch (err) {
    console.warn('[sa] 决策通知失败:', err);
  }
}

/**
 * 验收裁决:
 * - approve → done(last_verdict='approved');
 * - reject → rounds+1(≥3 锁死拒绝执行);打回后 status → in_progress、看板移回「进行中」、
 *   session_message 打回批注;message 失败(worker 已删)→ status → decision + {reason:'worker-gone'}。
 */
export async function reviewTask(
  taskId: string,
  action: 'approve' | 'reject',
  comment?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const task = getSaTask(taskId);
  if (!task) return { ok: false, reason: 'not-found' };

  if (action === 'approve') {
    updateSaTask(taskId, { status: 'done', lastVerdict: 'approved' });
    try {
      updateTaskLine(taskId, 'done');
    } catch (err) {
      console.warn('[sa] 看板更新失败:', err);
    }
    recordSignal('sa', `验收通过 ${taskId}`);
    notifyTasksChanged();
    return { ok: true };
  }

  // reject:先算轮次,≥3 直接拦截(不执行打回,该升级给人了;无写路径,不推事件)
  const rounds = (task.rounds ?? 0) + 1;
  if (rounds >= REJECT_ROUND_LIMIT) return { ok: false, reason: 'rounds-exceeded' };
  const verdict = (comment ?? '').trim().slice(0, 200);
  updateSaTask(taskId, { status: 'in_progress', rounds, lastVerdict: verdict });
  try {
    updateTaskLine(taskId, 'in_progress');
  } catch (err) {
    console.warn('[sa] 看板更新失败:', err);
  }
  const msg = await sessionMessage(
    task.session_id,
    `验收不通过(第 ${rounds} 轮):${verdict}\n请按验收标准修改,完成后你会被自动回执。`,
  );
  if (msg.startsWith('✗')) {
    // worker 已删/不可达 → 升级给人决策
    updateSaTask(taskId, { status: 'decision', lastVerdict: `worker 失联:${msg}` });
    try {
      updateTaskLine(taskId, 'decision');
    } catch (err) {
      console.warn('[sa] 看板更新失败:', err);
    }
    notifyDecision(taskId);
    notifyTasksChanged();
    return { ok: false, reason: 'worker-gone' };
  }
  recordSignal('sa', `验收打回 ${taskId}(第 ${rounds} 轮)`);
  notifyTasksChanged();
  return { ok: true };
}

/** 「待你决策」队列:review + decision,updatedAt 倒序,附最近一条回执预览(前 200 字) */
export function listDecisions(): {
  taskId: string;
  goal: string;
  acceptance: string;
  status: string;
  rounds: number;
  sid: string;
  updatedAt: number;
  inboxPreview: string;
}[] {
  const inbox = listInbox();
  return listSaTasks()
    .filter((t) => t.status === 'review' || t.status === 'decision')
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .map((t) => ({
      taskId: t.task_id,
      goal: t.goal,
      acceptance: t.acceptance,
      status: t.status,
      rounds: t.rounds ?? 0,
      sid: t.session_id,
      updatedAt: t.updated_at ?? t.created_at,
      inboxPreview: inbox.find((i) => i.taskId === t.task_id)?.preview.slice(0, 200) ?? '',
    }));
}

/** 任务详情:行数据 + 全部回执 + 合成时间线(创建/回执/最近裁决) */
export function taskDetail(taskId: string): {
  task: {
    taskId: string;
    goal: string;
    acceptance: string;
    status: string;
    rounds: number;
    sid: string;
    createdAt: number;
    updatedAt: number;
    lastVerdict: string | null;
  };
  receipts: { file: string; at: number; preview: string }[];
  timeline: { at: number; text: string }[];
} | null {
  const t = getSaTask(taskId);
  if (!t) return null;
  const receipts = listInbox().filter((i) => i.taskId === taskId).map((i) => ({ file: i.file, at: i.at, preview: i.preview }));
  const timeline: { at: number; text: string }[] = [{ at: t.created_at, text: '任务创建' }];
  for (const r of receipts.slice().sort((a, b) => a.at - b.at)) timeline.push({ at: r.at, text: `回执 ${r.file}` });
  if (t.last_verdict) timeline.push({ at: t.updated_at ?? t.created_at, text: `验收:${t.last_verdict}` });
  timeline.sort((a, b) => a.at - b.at);
  return {
    task: {
      taskId: t.task_id,
      goal: t.goal,
      acceptance: t.acceptance,
      status: t.status,
      rounds: t.rounds ?? 0,
      sid: t.session_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at ?? t.created_at,
      lastVerdict: t.last_verdict,
    },
    receipts,
    timeline,
  };
}

// ---------- sa:list-tasks(结构化看板数据) ----------

const TASK_STATUS_ORDER: Record<string, number> = { decision: 0, review: 1, in_progress: 2, watching: 3, done: 4 };

export function listTasksStructured(): SaTaskItem[] {
  // sid → 标题(scanner 树;ephemeral 组也在树里,不筛)
  const titles = new Map<string, string>();
  try {
    for (const p of deps?.scan().projects ?? []) {
      for (const s of p.sessions) titles.set(s.id, s.title);
    }
  } catch {
    /* scanner 失败时用 sid 兜底 */
  }
  const rows = listSaTasks();
  const active = rows
    .filter((t) => t.status !== 'done')
    .sort((a, b) => (TASK_STATUS_ORDER[a.status] ?? 9) - (TASK_STATUS_ORDER[b.status] ?? 9) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const done = rows
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, 20); // done 只保留最近 20 条
  return [...active, ...done].map((t) => {
    const title = titles.get(t.session_id);
    return {
      taskId: t.task_id,
      sid: t.session_id,
      goal: t.goal,
      acceptance: t.acceptance,
      status: t.status,
      rounds: t.rounds ?? 0,
      createdAt: t.created_at,
      updatedAt: t.updated_at ?? t.created_at,
      lastVerdict: t.last_verdict,
      title: title && title !== '未命名会话' ? title : t.session_id.slice(0, 12),
    };
  });
}
