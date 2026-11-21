import fs from 'node:fs';
import path from 'node:path';
import type {
  GroupConfigPatch,
  GroupEvent,
  GroupMemberRecord,
  GroupMessage,
  GroupPlanResult,
  GroupRecord,
} from '../shared/types.js';
import {
  addGroupMemberRow,
  allChannelMeta,
  deleteGroupRow,
  getGroupRow,
  insertGroupRow,
  listChannelProjects,
  listGroupMemberRows,
  listGroupRows,
  removeGroupMemberRow,
  updateGroupRow,
  type GroupRow,
} from './db.js';
import { getSessionIndex, getSettings, upsertSession } from './store.js';
import { getAgent } from './agent-library.js';
import { findSessionCwd } from './session-scanner.js';

/**
 * Group 编排器(design/design-v7.md §4, prd 决策 5/6):
 * - 用户在 group channel 发言 → @mention 路由(无 mention 发给 coordinator,没有则仅记录);
 * - prompt 装配 = group.md 全文(含历史摘要) + 摘要点之后最近 ~10 条原始消息 + 触发消息与发送者;
 * - 每 compact_threshold(默认 10)轮用 askOnce 压缩进 group.md「## 历史摘要」,原始段落落盘 group-logs/;
 * - 编排器消息不落 ACP,落内存缓冲 + group.md 压缩摘要(重启丢未压缩段,已接受);
 * - 互斥铁律:给 session 发 prompt 前查 busySessions,busy 则排队等 idle(30s 超时跳过)。
 */

/** 编排器依赖的 ACP 能力(结构化接口,冒烟时可用假实现) */
export interface OrchestratorAcp {
  isBusy(sessionId: string): boolean;
  promptAndCollect(sessionId: string, text: string): Promise<string>;
  askOnce(text: string, timeoutMs?: number, cwd?: string): Promise<string>;
  getSessionCwd(sessionId: string): string | null;
  /** 建 channel 会话(自带项目指引注入);group 的 coordinator/成员 session 用它创建 */
  newChannelSession(opts: { cwd: string; agentId?: string }): Promise<{ sessionId: string }>;
}

interface OrchestratorDeps {
  acp: OrchestratorAcp;
  /** ch:group-event 推送(index.ts 注入,仅发 workbench 窗口) */
  push: (payload: GroupEvent) => void;
  /** busy 等待超时(默认 30s;冒烟测试可注入小值) */
  busyWaitMs?: number;
}

export interface MemberInfo {
  sessionId: string;
  role: string;
  title: string;
  agentName: string;
  /** 显示名:agent 名 > title > sid 前缀 */
  label: string;
  cwd: string | null;
}

const BUSY_WAIT_MS = 30_000;
const RECENT_MSGS = 10;

/**
 * mention 解析:@token 精确(大小写不敏感)或前缀(≥2 字符)匹配成员的
 * label/title/agent 名/role。label 与渲染层 memberLabel 同规则(agentName || title ||
 * sessionId 前16位)——渲染层插入 @ 用的就是 label,必须可匹配(title 为空时是 sid 前缀)。
 * 返回去重后的命中成员(保持成员顺序)。
 */
export function resolveMentions(text: string, members: MemberInfo[]): MemberInfo[] {
  const tokens = [...text.matchAll(/@([^\s@,，。!.!?:：;；]+)/g)].map((m) => m[1].toLowerCase());
  if (tokens.length === 0) return [];
  const hit = new Set<string>();
  for (const t of tokens) {
    for (const m of members) {
      const names = [m.label, m.title, m.agentName, m.role].filter(Boolean).map((n) => n.toLowerCase());
      if (names.some((n) => n === t || (t.length >= 2 && n.startsWith(t)))) hit.add(m.sessionId);
    }
  }
  return members.filter((m) => hit.has(m.sessionId));
}

function groupsDir(cwd: string): string {
  return path.join(cwd, '.kimi-desktop', 'groups');
}

function groupMdPath(cwd: string, groupId: string): string {
  return path.join(groupsDir(cwd), `${groupId}.md`);
}

function initialGroupMd(name: string): string {
  return [
    `# ${name}`,
    '',
    '## 目标与愿景',
    '',
    '（在这里描述这个 group 的共同目标、愿景;所有成员发言时都会带上这段上下文）',
    '',
    '## 历史摘要',
    '',
    '（每 10 轮对话自动压缩追加到这里,原始详细记录在 group-logs/ 下）',
    '',
  ].join('\n');
}

export class GroupOrchestrator {
  /** 未压缩段的原始消息缓冲(内存,重启即丢——决策已接受) */
  private buffers = new Map<string, GroupMessage[]>();
  /** 每个 group 的消息路由串行化,避免并发发言交错 */
  private queues = new Map<string, Promise<void>>();

  constructor(private deps: OrchestratorDeps) {}

  // ---------- 成员信息 ----------

  private describeSession(sessionId: string, role = ''): MemberInfo {
    const idx = getSessionIndex().find((s) => s.sessionId === sessionId);
    const meta = allChannelMeta().find((m) => m.session_id === sessionId);
    const agentName = meta?.agent_id ? (getAgent(meta.agent_id)?.name ?? '') : '';
    const title = idx?.title ?? '';
    return {
      sessionId,
      role,
      title,
      agentName,
      label: agentName || title || sessionId.slice(0, 16),
      cwd: this.deps.acp.getSessionCwd(sessionId) ?? findSessionCwd(sessionId),
    };
  }

  private membersOf(groupId: string): MemberInfo[] {
    return listGroupMemberRows(groupId).map((r) => this.describeSession(r.session_id, r.role));
  }

  // ---------- group.md 读写 ----------

  private groupCwd(group: GroupRow): string {
    return group.cwd ?? getSettings().workspaceDir;
  }

  private readGroupMd(group: GroupRow): string {
    try {
      return fs.readFileSync(groupMdPath(this.groupCwd(group), group.id), 'utf8');
    } catch {
      return group.context_md ?? '';
    }
  }

  private writeGroupMd(group: GroupRow, content: string): void {
    const file = groupMdPath(this.groupCwd(group), group.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    updateGroupRow(group.id, { context_md: content }); // sqlite 只做缓存
  }

  // ---------- CRUD ----------

  private toRecord(row: GroupRow): GroupRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      cwd: row.cwd,
      name: row.name,
      contextMd: row.context_md,
      roundCount: row.round_count,
      compactThreshold: row.compact_threshold,
      autonomous: row.autonomous === 1,
      maxRounds: row.max_rounds,
      createdAt: row.created_at,
      members: this.membersOf(row.id).map(
        (m): GroupMemberRecord => ({ sessionId: m.sessionId, role: m.role, title: m.title, agentName: m.agentName }),
      ),
    };
  }

  /**
   * 建 group(设计变更:group 本身就是一个 session,作为协调者)。
   * 流程:建行+落盘 group.md → newChannelSession 创建真实 ACP session(role='coordinator')
   * → 发角色注入 prompt → 加其余成员。session 创建失败整体回滚(不留没有协调者的 group);
   * 注入失败仅告警(coordinator session 已建好,可用)。已有旧 group 不补 coordinator。
   */
  async createGroup(opts: {
    name: string;
    projectId?: string;
    cwd?: string;
    members: { sessionId: string; role?: string }[];
  }): Promise<GroupRecord> {
    const id = `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const projectCwd = opts.projectId
      ? (listChannelProjects().find((p) => p.id === opts.projectId)?.path ?? undefined)
      : undefined;
    const cwd =
      opts.cwd ??
      projectCwd ??
      (opts.members[0] ? (this.describeSession(opts.members[0].sessionId).cwd ?? undefined) : undefined) ??
      getSettings().workspaceDir;
    const row = insertGroupRow({
      id,
      project_id: opts.projectId ?? null,
      cwd,
      name: opts.name,
      context_md: '',
      round_count: 0,
      compact_threshold: 10,
      autonomous: 0,
      max_rounds: 20,
      created_at: Date.now(),
    });
    this.writeGroupMd(row, initialGroupMd(opts.name));
    try {
      const coordinator = await this.deps.acp.newChannelSession({ cwd });
      addGroupMemberRow(id, coordinator.sessionId, 'coordinator');
      try {
        await this.deps.acp.promptAndCollect(
          coordinator.sessionId,
          [
            '<system-reminder>',
            `你是 group『${opts.name}』的协调者(coordinator)。职责:接收没有被 @ 的消息、理解 group 目标后分派/转述给成员、汇总进展。`,
            `共享上下文文件:${groupMdPath(cwd, id)}(发言时会被自动注入,无需主动读)。成员列表会随消息上下文提供。`,
            '用一句话确认角色,然后待命。',
            '</system-reminder>',
          ].join('\n'),
        );
      } catch (err) {
        console.warn('[group] coordinator 注入失败(session 已建好,可用):', err);
      }
      // prompt() 会把注入文本写进 sessions.json 标题,注完后改回正式标题
      upsertSession({
        sessionId: coordinator.sessionId,
        cwd,
        title: `${opts.name} · 协调者`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        kind: 'chat',
      });
    } catch (err) {
      // session 创建失败 → 整体回滚,不留没有协调者的 group
      deleteGroupRow(id);
      fs.rmSync(groupMdPath(cwd, id), { force: true });
      throw err;
    }
    for (const m of opts.members) addGroupMemberRow(id, m.sessionId, m.role ?? '');
    return this.toRecord({ ...row, context_md: this.readGroupMd(row) });
  }

  /** ch:group-create-member:在 group cwd 下新建成员 session,注入角色后入组 */
  async createGroupMember(groupId: string, opts: { name: string; description: string }): Promise<GroupRecord | null> {
    const row = getGroupRow(groupId);
    if (!row) return null;
    const cwd = this.groupCwd(row);
    const res = await this.deps.acp.newChannelSession({ cwd });
    try {
      await this.deps.acp.promptAndCollect(
        res.sessionId,
        [
          '<system-reminder>',
          `你是 group『${row.name}』的成员「${opts.name}」。你的职责:${opts.description}。`,
          `共享上下文文件:${groupMdPath(cwd, groupId)}。用一句话确认角色,然后待命。`,
          '</system-reminder>',
        ].join('\n'),
      );
    } catch (err) {
      console.warn('[group] 成员注入失败(session 已建好,可用):', err);
    }
    upsertSession({
      sessionId: res.sessionId,
      cwd,
      title: opts.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind: 'chat',
    });
    addGroupMemberRow(groupId, res.sessionId, opts.name); // role = 成员名
    return this.getGroup(groupId);
  }

  listGroups(projectId?: string): GroupRecord[] {
    return listGroupRows(projectId).map((r) => this.toRecord(r));
  }

  getGroup(groupId: string): GroupRecord | null {
    const row = getGroupRow(groupId);
    return row ? this.toRecord(row) : null;
  }

  updateGroupConfig(groupId: string, patch: GroupConfigPatch): GroupRecord | null {
    const row = getGroupRow(groupId);
    if (!row) return null;
    if (patch.contextMd !== undefined) this.writeGroupMd(row, patch.contextMd);
    updateGroupRow(row.id, {
      name: patch.name,
      compact_threshold: patch.compactThreshold,
      autonomous: patch.autonomous === undefined ? undefined : patch.autonomous ? 1 : 0,
      max_rounds: patch.maxRounds,
    });
    return this.getGroup(groupId);
  }

  addMember(groupId: string, sessionId: string, role?: string): GroupRecord | null {
    addGroupMemberRow(groupId, sessionId, role ?? '');
    return this.getGroup(groupId);
  }

  removeMember(groupId: string, sessionId: string): GroupRecord | null {
    removeGroupMemberRow(groupId, sessionId);
    return this.getGroup(groupId);
  }

  deleteGroup(groupId: string): void {
    const row = getGroupRow(groupId);
    deleteGroupRow(groupId);
    this.buffers.delete(groupId);
    if (row) fs.rmSync(groupMdPath(this.groupCwd(row), groupId), { force: true }); // group-logs/ 保留
  }

  getMessages(groupId: string): { messages: GroupMessage[]; groupMd: string; group: GroupRecord } | null {
    const row = getGroupRow(groupId);
    if (!row) return null;
    return { messages: [...(this.buffers.get(groupId) ?? [])], groupMd: this.readGroupMd(row), group: this.toRecord(row) };
  }

  // ---------- 消息流 ----------

  private appendMessage(groupId: string, msg: GroupMessage): void {
    const buf = this.buffers.get(groupId) ?? [];
    buf.push(msg);
    this.buffers.set(groupId, buf);
    this.deps.push({ groupId, kind: 'message', message: msg });
  }

  /** 用户发言入口:立即返回,路由与回复经 ch:group-event 流式推送(同 group 串行) */
  sendToGroup(groupId: string, text: string): void {
    const q = (this.queues.get(groupId) ?? Promise.resolve())
      .then(() => this.routeUserMessage(groupId, text))
      .catch((err) => this.deps.push({ groupId, kind: 'error', error: String(err) }));
    this.queues.set(groupId, q);
  }

  private async routeUserMessage(groupId: string, text: string): Promise<void> {
    const group = getGroupRow(groupId);
    if (!group) throw new Error(`unknown group: ${groupId}`);
    const members = this.membersOf(groupId);
    this.appendMessage(groupId, { from: '用户', fromKind: 'user', text, at: Date.now() });

    let targets = resolveMentions(text, members);
    if (targets.length === 0) {
      // 无 mention → coordinator;没有 coordinator 则仅记录
      const coordinator = members.find((m) => m.role === 'coordinator');
      if (coordinator) targets = [coordinator];
    }
    if (targets.length === 0) {
      this.appendMessage(groupId, {
        from: '系统',
        fromKind: 'system',
        text: '(没有 @ 到任何成员,且未设 coordinator,消息仅记录未路由)',
        at: Date.now(),
      });
      return;
    }
    await this.dispatch(group, targets, text, '用户', members, { rounds: 0 });
  }

  /** busy 排队等 idle:超时仍忙则跳过本轮(铁律:永不打断在跑的 turn) */
  private async waitIdle(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.busyWaitMs ?? BUSY_WAIT_MS);
    while (this.deps.acp.isBusy(sessionId)) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    return true;
  }

  /** prompt 装配:group.md 全文(含历史摘要) + 最近 ~10 条原始消息 + 触发消息与发送者 */
  private assemblePrompt(group: GroupRow, target: MemberInfo, triggerText: string, fromLabel: string): string {
    const md = this.readGroupMd(group).trim();
    const recent = (this.buffers.get(group.id) ?? []).slice(-RECENT_MSGS);
    const recentText = recent.map((m) => `[${m.from}] ${m.text}`).join('\n\n');
    return [
      md,
      '',
      '## 最近对话',
      recentText || '(暂无)',
      '',
      '## 触发',
      `${fromLabel} 对你说:`,
      triggerText,
      '',
      `你是 group「${group.name}」的成员「${target.label}」${target.role ? `(角色:${target.role})` : ''}。请直接回复内容,无需客套。`,
    ].join('\n');
  }

  private async dispatch(
    group: GroupRow,
    targets: MemberInfo[],
    triggerText: string,
    fromLabel: string,
    members: MemberInfo[],
    guard: { rounds: number },
  ): Promise<void> {
    for (const target of targets) {
      if (guard.rounds >= group.max_rounds) {
        this.appendMessage(group.id, {
          from: '系统',
          fromKind: 'system',
          text: `已达单次发言的轮次上限(${group.max_rounds}),停止自动路由。`,
          at: Date.now(),
        });
        return;
      }
      if (!(await this.waitIdle(target.sessionId))) {
        this.appendMessage(group.id, {
          from: '系统',
          fromKind: 'system',
          text: `「${target.label}」正忙(等待 30s 超时),本轮跳过。`,
          at: Date.now(),
        });
        continue;
      }
      const prompt = this.assemblePrompt(group, target, triggerText, fromLabel);
      let reply = '';
      try {
        reply = await this.deps.acp.promptAndCollect(target.sessionId, prompt);
      } catch (err) {
        this.deps.push({ groupId: group.id, kind: 'error', error: `「${target.label}」回复失败: ${String(err)}` });
        continue;
      }
      guard.rounds++;
      this.appendMessage(group.id, {
        from: target.label,
        fromKind: 'agent',
        sessionId: target.sessionId,
        text: reply,
        at: Date.now(),
      });
      const roundCount = (getGroupRow(group.id)?.round_count ?? 0) + 1;
      updateGroupRow(group.id, { round_count: roundCount });
      this.deps.push({ groupId: group.id, kind: 'round', roundCount });
      if (roundCount % Math.max(1, group.compact_threshold) === 0) void this.compact(group.id);

      // 自主讨论:agent 回复里 @ 了其他成员(默认关,受 max_rounds 硬护栏约束)
      if (group.autonomous === 1 && reply) {
        const next = resolveMentions(reply, members).filter((m) => m.sessionId !== target.sessionId);
        if (next.length > 0) await this.dispatch(group, next, reply, target.label, members, guard);
      }
    }
  }

  // ---------- 压缩护栏(决策#6) ----------

  private async compact(groupId: string): Promise<void> {
    const msgs = this.buffers.get(groupId) ?? [];
    const group = getGroupRow(groupId);
    if (!group || msgs.length === 0) return;
    const transcript = msgs.map((m) => `[${m.from}] ${m.text}`).join('\n\n');
    let summary = '';
    try {
      summary = await this.deps.acp.askOnce(
        [
          '以下是一个多 agent 协作 group 的一段对话记录。压缩成简短摘要,保留:做了什么决定、谁负责什么、关键结论、待办事项。',
          '要点列表,不超过 10 行,只输出摘要本身。',
          '',
          transcript.slice(0, 8000),
        ].join('\n'),
        120_000,
        this.groupCwd(group),
      );
      summary = summary.trim();
    } catch (err) {
      this.deps.push({ groupId, kind: 'error', error: `压缩失败(下轮重试): ${String(err)}` });
      return;
    }
    if (!summary) return;

    // 追加进 group.md 的「## 历史摘要」区(追加到文件末尾;区不在末尾时仍在末尾,保持简单)
    const md = this.readGroupMd(group);
    const stamp = new Date().toISOString().slice(0, 10);
    const section = `### ${stamp} 第 ${group.round_count} 轮\n\n${summary}\n`;
    const next = md.includes('## 历史摘要') ? `${md.trimEnd()}\n\n${section}` : `${md.trimEnd()}\n\n## 历史摘要\n\n${section}`;
    this.writeGroupMd(group, next);

    // 原始详细记录落盘 group-logs/<date>.md
    const logsDir = path.join(groupsDir(this.groupCwd(group)), 'group-logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, `${stamp}.md`), `\n\n## group ${group.name} · 截至第 ${group.round_count} 轮\n\n${transcript}\n`);

    this.buffers.set(groupId, []);
    this.deps.push({ groupId, kind: 'compact', summary });
  }

  // ---------- 动态编排规划(决策#5) ----------

  async planOrchestration(opts: { taskDescription: string; memberSessionIds: string[] }): Promise<GroupPlanResult> {
    const members = opts.memberSessionIds.map((sid) => this.describeSession(sid));
    const pref = getSettings().orchestrationPref ?? '';
    const prompt = [
      '你要为一个多 agent 协作任务设计编排方案。',
      '',
      `【任务描述】\n${opts.taskDescription}`,
      '',
      '【可用成员 session】',
      ...members.map(
        (m, i) =>
          `${i + 1}. id=${m.sessionId} 名称=${m.label} 角色=${m.role || '(未分配)'} 项目=${m.cwd ?? '(未知)'}`,
      ),
      ...(pref ? ['', `【系统优先模式(参考先验)】\n${pref}`] : []),
      '',
      '只输出一个 JSON(可用 ```json 围栏),不要输出其他内容。结构:',
      '{',
      '  "roles": [{ "sessionId": "...", "role": "分配的角色名", "reason": "为什么" }],',
      '  "flow": ["步骤1: 谁做什么", "步骤2: ..."],',
      '  "estimatedRounds": 5,',
      '  "subtasks": [{ "description": "...", "sessionId": "...", "needsWorktree": true }]',
      '}',
      '规则:needsWorktree=true 仅当该子任务需要写文件、且可能与同项目其他子任务并发;纯讨论型全部为 false。',
    ].join('\n');
    const raw = await this.deps.acp.askOnce(prompt, 300_000, members[0]?.cwd ?? undefined);
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = (fenced ? fenced[1] : raw).trim();
    try {
      return { ok: true, plan: JSON.parse(candidate) as Record<string, unknown> };
    } catch {
      return { ok: false, text: raw }; // 解析失败回退纯文本,渲染层直接展示
    }
  }
}
