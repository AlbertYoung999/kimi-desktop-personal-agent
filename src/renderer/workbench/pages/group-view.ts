/**
 * Group 协作 UI（v7.0 P3a，design/design-v7.md §4/§5 + prd 决策 5/6）：
 * - createGroupView:group channel 视图(消息流 / @ 补全 / 轮次计数 / autonomous /
 *   成员管理 / group.md 抽屉 / worktrees 入口),与 channel 页 createChatPanel 互斥切换
 * - openGroupWizard:新建 group 向导(选项目 → 名称 → 多选成员 → 可选 AI 规划编排卡片)
 * - openWorktreePanel:worktree 列表 + Orca 式 diff 评审(行内批注回喂 session)
 * session→worktree 分支映射存 localStorage(kimi-chan-worktrees),本期够用。
 */

import type {
  AgentRecord,
  ChannelProject,
  ChannelSession,
  GroupEvent,
  GroupMessage,
  GroupRecord,
  WorktreeOpResult,
} from '../../../shared/types';

const G = 'grp'; // class prefix

export interface GroupUiDeps {
  page: HTMLElement; // #page-channel(overlay 挂载点,position:relative)
  getProjects(): ChannelProject[];
  getAgentById(id: string): AgentRecord | undefined;
  projectLabel(p: ChannelProject): string;
  sessionLabel(s: ChannelSession): string;
  /** group 增删/成员变化/fork 后刷新 channel 树 */
  refresh(): Promise<void>;
  /** 向导创建完成后选中该 group */
  onGroupSelected(gid: string): void;
}

// ---------- session→worktree 映射(localStorage) ----------

const WT_KEY = 'kimi-chan-worktrees';
interface WtEntry {
  branch: string;
  path: string;
  repoPath: string;
}

function wtLoadAll(): Record<string, WtEntry> {
  try {
    const raw = localStorage.getItem(WT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, WtEntry>) : {};
  } catch {
    return {};
  }
}

function wtSet(sessionId: string, entry: WtEntry): void {
  const all = wtLoadAll();
  all[sessionId] = entry;
  try {
    localStorage.setItem(WT_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function wtFindByBranch(branch: string): { sessionId: string; entry: WtEntry } | null {
  for (const [sessionId, entry] of Object.entries(wtLoadAll())) {
    if (entry.branch === branch) return { sessionId, entry };
  }
  return null;
}

/** worktree 结构化失败 → 用户文案(主进程行为要点对齐) */
function wtErrorText(r: WorktreeOpResult): string {
  if (r.reason === 'not-git') return '该项目非 git 仓库，多写 session 需串行';
  if (r.reason === 'conflict') return '合并冲突，已恢复原状，请手动处理';
  return r.error || '操作失败';
}

// ---------- 通用 overlay ----------

function makeOverlay(page: HTMLElement): { overlay: HTMLElement; box: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = `${G}-overlay`;
  const box = document.createElement('div');
  box.className = `${G}-box`;
  overlay.appendChild(box);
  const close = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  page.appendChild(overlay);
  return { overlay, box, close };
}

function memberLabel(deps: GroupUiDeps, m: { sessionId: string; role: string; title?: string; agentName?: string }): string {
  return m.agentName ?? m.title ?? m.sessionId.slice(0, 12);
}

/** 插入文本的 @ 名:优先主进程 resolveMentions 可匹配的字段(title/agentName/role),
 *  否则回退显示名——三者全空的成员插入 sid 段也路由不到,提示靠弹窗 label */
function mentionName(deps: GroupUiDeps, m: GroupRecord['members'][number]): string {
  return m.title || m.agentName || m.role || memberLabel(deps, m);
}

/** mention 弹窗过滤字段:title/agentName/role(主进程路由字段) + 显示名本身 */
function mentionMatchNames(deps: GroupUiDeps, m: GroupRecord['members'][number]): string[] {
  return [m.title, m.agentName, m.role, memberLabel(deps, m)].filter(Boolean).map((n) => n!.toLowerCase());
}

// ============================================================
// group channel 视图
// ============================================================

export interface GroupViewHandle {
  showGroup(gid: string): Promise<void>;
  hide(): void;
  currentGid(): string | null;
}

export function createGroupView(container: HTMLElement, deps: GroupUiDeps): GroupViewHandle {
  container.innerHTML = `
    <div class="${G}-root">
      <div class="${G}-topbar">
        <span class="${G}-name"></span>
        <span class="${G}-rounds"></span>
        <span class="${G}-auto-badge hidden">自主讨论中</span>
        <span class="spacer"></span>
        <label class="${G}-auto-toggle" title="开启后成员可互相 @ 自主讨论">
          <input type="checkbox" class="${G}-auto-cb" /> 自主讨论
        </label>
        <button class="${G}-tb-btn" data-act="members" title="成员管理">👥</button>
        <button class="${G}-tb-btn" data-act="groupmd" title="编辑 group.md(共享上下文)">⚙</button>
        <button class="${G}-tb-btn" data-act="worktrees" title="worktrees">⎇</button>
        <button class="${G}-tb-btn danger" data-act="delete" title="删除 group">🗑</button>
      </div>
      <div class="${G}-messages"></div>
      <div class="${G}-input-area">
        <textarea class="${G}-input" rows="1" placeholder="发言,@ 提及成员…"></textarea>
        <button class="${G}-send" title="发送">➤</button>
      </div>
    </div>`;

  const root = container.querySelector(`.${G}-root`) as HTMLElement;
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const nameEl = $('.grp-name');
  const roundsEl = $('.grp-rounds');
  const autoBadge = $('.grp-auto-badge');
  const autoCb = $('.grp-auto-cb') as unknown as HTMLInputElement;
  const messagesEl = $('.grp-messages');
  const inputEl = $('.grp-input') as unknown as HTMLTextAreaElement;
  const sendBtn = $('.grp-send') as unknown as HTMLButtonElement;

  let group: GroupRecord | null = null;
  let groupMd = '';
  let destroyed = false;

  // ---------- 消息渲染 ----------
  let stickToBottom = true;
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });
  const scrollToBottom = (force = false) => {
    if (force || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  function appendMessage(m: GroupMessage): void {
    if (m.fromKind === 'system') {
      const el = document.createElement('div');
      el.className = `${G}-msg system`;
      el.textContent = m.text;
      messagesEl.appendChild(el);
      scrollToBottom();
      return;
    }
    const el = document.createElement('div');
    el.className = `${G}-msg ${m.fromKind}`;
    const head = document.createElement('div');
    head.className = `${G}-msg-head`;
    const who = document.createElement('span');
    who.className = `${G}-msg-who`;
    const member = m.sessionId ? group?.members.find((x) => x.sessionId === m.sessionId) : undefined;
    who.textContent = m.fromKind === 'user' ? m.from : `${member?.agentName ? '🤖 ' : ''}${m.from}`;
    head.appendChild(who);
    if (member?.role) {
      const role = document.createElement('span');
      role.className = `${G}-msg-role`;
      role.textContent = member.role;
      head.appendChild(role);
    }
    const time = document.createElement('span');
    time.className = `${G}-msg-time`;
    time.textContent = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false });
    head.appendChild(time);
    const body = document.createElement('div');
    body.className = `${G}-msg-body`;
    body.textContent = m.text;
    el.append(head, body);
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /** compact 事件 → 折叠摘要卡片 */
  function appendCompactCard(roundCount: number | undefined, summary: string): void {
    const card = document.createElement('div');
    card.className = `${G}-compact`;
    const head = document.createElement('button');
    head.className = `${G}-compact-head`;
    head.textContent = `▼ 已压缩${roundCount != null ? ` ${roundCount} 轮` : ''} → 摘要`;
    const body = document.createElement('div');
    body.className = `${G}-compact-body`;
    body.textContent = summary;
    head.onclick = () => {
      const open = body.classList.toggle('open');
      head.textContent = `${open ? '▲' : '▼'} 已压缩${roundCount != null ? ` ${roundCount} 轮` : ''} → 摘要`;
    };
    card.append(head, body);
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  function syncTopbar(): void {
    if (!group) return;
    nameEl.textContent = `👥 ${group.name}`;
    roundsEl.textContent = `轮次 ${group.roundCount}/${group.compactThreshold}` + (group.autonomous ? ` · 上限 ${group.maxRounds}` : '');
    autoBadge.classList.toggle('hidden', !group.autonomous);
    if (document.activeElement !== autoCb) autoCb.checked = group.autonomous;
  }

  // ---------- 事件增量 ----------
  window.kimi.onChGroupEvent((e: GroupEvent) => {
    if (destroyed || !group || e.groupId !== group.id) return;
    if (e.kind === 'message' && e.message) {
      appendMessage(e.message);
    } else if (e.kind === 'round') {
      if (e.roundCount != null) group.roundCount = e.roundCount;
      syncTopbar();
    } else if (e.kind === 'compact') {
      if (e.roundCount != null) group.roundCount = e.roundCount;
      appendCompactCard(e.roundCount, e.summary ?? '');
      syncTopbar();
    } else if (e.kind === 'error') {
      appendMessage({ from: '系统', fromKind: 'system', text: `⚠ ${e.error ?? '编排错误'}`, at: Date.now() });
    }
  });

  // ---------- 发送 + @ 补全 ----------
  let mentionEl: HTMLElement | null = null;
  let mentionIdx = 0;
  let mentionMatches: GroupRecord['members'] = [];

  function closeMention(): void {
    mentionEl?.remove();
    mentionEl = null;
  }

  /** 光标前正在输入的 @ 词(无空格),返回词文本(不含 @)或 null */
  function mentionWord(): string | null {
    const pos = inputEl.selectionStart ?? 0;
    const before = inputEl.value.slice(0, pos);
    const m = before.match(/@([^\s@]*)$/);
    return m ? m[1] : null;
  }

  function renderMention(): void {
    const word = mentionWord();
    if (word === null || !group || group.members.length === 0) {
      closeMention();
      return;
    }
    const w = word.toLowerCase();
    mentionMatches = group.members.filter((m) => {
      const names = mentionMatchNames(deps, m);
      return !w || names.some((n) => n.includes(w));
    });
    if (mentionMatches.length === 0) {
      closeMention();
      return;
    }
    mentionIdx = Math.min(mentionIdx, mentionMatches.length - 1);
    if (!mentionEl) {
      mentionEl = document.createElement('div');
      mentionEl.className = `${G}-mention`;
      root.querySelector(`.${G}-input-area`)!.appendChild(mentionEl);
    }
    mentionEl.innerHTML = '';
    mentionMatches.forEach((m, i) => {
      const item = document.createElement('div');
      item.className = `${G}-mention-item` + (i === mentionIdx ? ' selected' : '');
      item.textContent = `${m.agentName ? '🤖 ' : ''}${memberLabel(deps, m)}${m.role ? ` · ${m.role}` : ''}`;
      item.onmousedown = (e) => {
        e.preventDefault(); // 保住 input 焦点
        pickMention(m);
      };
      mentionEl!.appendChild(item);
    });
  }

  function pickMention(m: GroupRecord['members'][number]): void {
    const pos = inputEl.selectionStart ?? inputEl.value.length;
    const before = inputEl.value.slice(0, pos).replace(/@[^\s@]*$/, '');
    const after = inputEl.value.slice(pos);
    const name = mentionName(deps, m); // 插入 resolveMentions 可匹配的名字,保证主进程路由得到
    inputEl.value = `${before}@${name} ${after}`;
    inputEl.focus();
    inputEl.selectionStart = inputEl.selectionEnd = before.length + name.length + 2;
    closeMention();
  }

  function send(): void {
    const text = inputEl.value.trim();
    if (!text || !group) return;
    inputEl.value = '';
    closeMention();
    // 乐观渲染用户消息;成员回复/系统消息靠 onChGroupEvent 增量
    appendMessage({ from: '我', fromKind: 'user', text, at: Date.now() });
    scrollToBottom(true);
    void window.kimi.ch.groupSend(group.id, text);
  }

  inputEl.addEventListener('input', () => {
    mentionIdx = 0;
    renderMention();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (mentionEl) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionIdx = Math.min(mentionIdx + 1, mentionMatches.length - 1);
        renderMention();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionIdx = Math.max(mentionIdx - 1, 0);
        renderMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionMatches[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.onclick = send;

  // ---------- 顶栏动作 ----------
  autoCb.onchange = () => {
    if (!group) return;
    const gid = group.id;
    const on = autoCb.checked;
    if (
      on &&
      !window.confirm(
        '开启自主讨论后，成员可互相 @ 继续对话。\n本期没有中断 API，停止手段只有轮次上限（maxRounds）硬护栏。确定开启？',
      )
    ) {
      autoCb.checked = false;
      return;
    }
    void window.kimi.ch.groupConfig(gid, { autonomous: on }).then((g) => {
      if (g && group?.id === gid) {
        group = g;
        syncTopbar();
      }
    });
  };

  (root.querySelector('[data-act="groupmd"]') as HTMLButtonElement).onclick = () => {
    if (group) openGroupMdDrawer();
  };
  (root.querySelector('[data-act="members"]') as HTMLButtonElement).onclick = () => {
    if (group) openMembersPanel();
  };
  (root.querySelector('[data-act="worktrees"]') as HTMLButtonElement).onclick = () => {
    if (!group) return;
    if (!group.cwd) {
      window.alert('该 group 未关联项目目录，无法使用 worktree。');
      return;
    }
    void openWorktreePanel(deps, group.cwd);
  };
  (root.querySelector('[data-act="delete"]') as HTMLButtonElement).onclick = () => {
    if (!group) return;
    if (!window.confirm(`删除 group「${group.name}」？\ngroup.md 与未压缩消息将一并删除，不可恢复。`)) return;
    const gid = group.id;
    void window.kimi.ch.groupDelete(gid).then(() => deps.refresh());
  };

  // ---------- group.md 抽屉(复用 P2 配置抽屉模式:单文件 + 防抖自动保存) ----------
  function openGroupMdDrawer(): void {
    if (!group) return;
    const gid = group.id;
    const el = document.createElement('div');
    el.className = `${G}-drawer`;
    const head = document.createElement('div');
    head.className = `${G}-drawer-head`;
    const title = document.createElement('span');
    title.className = `${G}-drawer-title`;
    title.textContent = 'group.md · 共享上下文';
    const status = document.createElement('span');
    status.className = `${G}-drawer-status`;
    const closeBtn = document.createElement('button');
    closeBtn.className = `${G}-tb-btn`;
    closeBtn.textContent = '×';
    head.append(title, status, closeBtn);
    const editor = document.createElement('textarea');
    editor.className = `${G}-drawer-editor`;
    editor.spellcheck = false;
    editor.value = groupMd; // 先填缓存,下面立刻重拉最新覆盖
    const hint = document.createElement('div');
    hint.className = `${G}-drawer-hint`;
    hint.textContent = 'group 的共享上下文（目标/愿景/历史摘要），自动注入每个成员的发言 prompt；压缩摘要也写入此文件。';
    el.append(head, editor, hint);
    root.appendChild(el);

    let dirty = false;
    // 重开抽屉必须重拉:groupMd 是 showGroup 时的快照,同会话内早已过期;
    // 用户已在打字(dirty)则不打断
    void window.kimi.ch.groupMessages(gid).then((data) => {
      if (!data || group?.id !== gid) return;
      group = data.group;
      groupMd = data.groupMd;
      if (!dirty && document.activeElement !== editor) editor.value = groupMd;
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      status.textContent = '保存中…';
      void window.kimi.ch.groupConfig(gid, { contextMd: editor.value }).then((g) => {
        if (g && group?.id === gid) group = g;
        groupMd = editor.value; // 同步缓存,同会话内重开不再读到旧值
        dirty = false;
        status.textContent = '已保存 ✓';
        setTimeout(() => (status.textContent = ''), 2000);
      });
    };
    editor.addEventListener('input', () => {
      dirty = true;
      status.textContent = '…';
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 1000);
    });
    editor.addEventListener('blur', flush);
    const close = () => {
      flush();
      el.remove();
    };
    closeBtn.onclick = close;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
  }

  // ---------- 成员管理 ----------
  function openMembersPanel(): void {
    if (!group) return;
    const gid = group.id;
    const { box, close } = makeOverlay(deps.page);

    /** 成员变更写回:返回 null 时显式重拉兜底,保证 group.members(mention 数据源)新鲜 */
    const applyUpdate = (ng: GroupRecord | null, after?: () => void) => {
      if (ng) {
        render(ng);
        return;
      }
      void window.kimi.ch.groupMessages(gid).then((data) => {
        if (data && group?.id === gid) render(data.group);
        after?.();
      });
    };

    const render = (g: GroupRecord) => {
      group = g;
      syncTopbar();
      box.innerHTML = '';
      const head = document.createElement('div');
      head.className = `${G}-box-head`;
      head.textContent = `成员管理 · ${g.name}`;
      box.appendChild(head);

      // 现有成员
      for (const m of g.members) {
        const row = document.createElement('div');
        row.className = `${G}-member`;
        const who = document.createElement('span');
        who.className = `${G}-member-name`;
        who.textContent = `${m.agentName ? '🤖 ' : ''}${memberLabel(deps, m)}`;
        who.title = m.sessionId;
        const roleInput = document.createElement('input');
        roleInput.className = `${G}-role-input`;
        roleInput.value = m.role;
        roleInput.placeholder = '角色(如 coordinator)';
        roleInput.onchange = () => {
          if (roleInput.value.trim() === m.role) return;
          void window.kimi.ch.groupAddMember(gid, m.sessionId, roleInput.value.trim()).then(applyUpdate);
        };
        row.append(who, roleInput);

        // worktree:已有映射显示分支标,否则提供「建 worktree」
        const wt = wtLoadAll()[m.sessionId];
        if (wt) {
          const badge = document.createElement('span');
          badge.className = `${G}-wt-badge`;
          badge.textContent = `⎇ ${wt.branch}`;
          badge.title = wt.path;
          row.appendChild(badge);
        } else if (g.cwd) {
          const wtBtn = document.createElement('button');
          wtBtn.className = `${G}-mini-btn`;
          wtBtn.textContent = '建 worktree';
          wtBtn.title = '为该成员创建独立工作区(写文件并发隔离)';
          wtBtn.onclick = () => {
            // 内联输入 task-slug(默认角色名)
            wtBtn.remove();
            const slugInput = document.createElement('input');
            slugInput.className = `${G}-role-input`;
            slugInput.value = (m.role || 'task').toLowerCase().replace(/[^\w-]+/g, '-');
            const ok = document.createElement('button');
            ok.className = `${G}-mini-btn`;
            ok.textContent = '创建';
            const err = document.createElement('span');
            err.className = `${G}-mini-status`;
            ok.onclick = () => {
              const slug = slugInput.value.trim();
              if (!slug) return;
              ok.disabled = true;
              void window.kimi.ch.worktreeCreate({ repoPath: g.cwd!, taskSlug: slug }).then((r) => {
                if (r.ok && r.branch && r.path) {
                  wtSet(m.sessionId, { branch: r.branch, path: r.path, repoPath: g.cwd! });
                  render(g);
                } else {
                  err.textContent = wtErrorText(r);
                  ok.disabled = false;
                }
              });
            };
            row.append(slugInput, ok, err);
            slugInput.focus();
          };
          row.appendChild(wtBtn);
        }

        const rm = document.createElement('button');
        rm.className = `${G}-mini-btn danger`;
        rm.textContent = '×';
        rm.title = '移出 group';
        rm.onclick = () => {
          void window.kimi.ch.groupRemoveMember(gid, m.sessionId).then(applyUpdate);
        };
        row.appendChild(rm);
        box.appendChild(row);
      }
      if (g.members.length === 0) {
        const empty = document.createElement('div');
        empty.className = `${G}-box-hint`;
        empty.textContent = '还没有成员，从下方添加。';
        box.appendChild(empty);
      }

      // 添加成员(该项目树里尚未入群的 session)
      const proj = findGroupProject(deps, g);
      const candidates = (proj?.sessions ?? []).filter(
        (s) => !s.ephemeral && !g.members.some((m) => m.sessionId === s.id),
      );
      const addRow = document.createElement('div');
      addRow.className = `${G}-member-add`;
      if (!proj) {
        addRow.textContent = '该 group 未关联项目，无法从项目添加成员。';
      } else if (candidates.length === 0) {
        addRow.textContent = '该项目没有更多可添加的 session。';
      } else {
        const sel = document.createElement('select');
        sel.className = `${G}-select`;
        for (const s of candidates) {
          const opt = document.createElement('option');
          opt.value = s.id;
          const agent = s.agentId ? deps.getAgentById(s.agentId) : undefined;
          opt.textContent = `${agent ? agent.avatar + ' ' : ''}${deps.sessionLabel(s)}`;
          sel.appendChild(opt);
        }
        const addBtn = document.createElement('button');
        addBtn.className = `${G}-mini-btn`;
        addBtn.textContent = '添加';
        addBtn.onclick = () => {
          void window.kimi.ch.groupAddMember(gid, sel.value).then(applyUpdate);
        };
        // 次级选项:从某 session 分叉一个副本加入(design/design-v7.md 决策#7 意外收获)
        const forkBtn = document.createElement('button');
        forkBtn.className = `${G}-mini-btn`;
        forkBtn.textContent = '分叉加入';
        forkBtn.title = '复制该 session 的完整上下文后加入 group';
        forkBtn.onclick = () => {
          if (!window.confirm('将复制该 session 的完整上下文（成本较高），以副本加入 group。继续？')) return;
          forkBtn.disabled = true;
          void window.kimi.ch
            .forkSession(sel.value)
            .then(({ sessionId }) => window.kimi.ch.groupAddMember(gid, sessionId))
            .then(async (ng) => {
              await deps.refresh(); // 分叉副本要进项目树
              applyUpdate(ng);
            })
            .finally(() => {
              forkBtn.disabled = false;
            });
        };
        addRow.append(sel, addBtn, forkBtn);
      }
      box.appendChild(addRow);

      // + 新建成员:用名称 + 职责描述创建一个全新 session 入群(首轮注入,可能几十秒)
      const newRow = document.createElement('div');
      newRow.className = `${G}-member-add`;
      const nmInput = document.createElement('input');
      nmInput.className = `${G}-role-input`;
      nmInput.style.width = '130px';
      nmInput.placeholder = '成员名称';
      const dsInput = document.createElement('input');
      dsInput.className = `${G}-role-input`;
      dsInput.style.flex = '1';
      dsInput.placeholder = '职责描述(注入为首轮上下文)';
      const createBtn = document.createElement('button');
      createBtn.className = `${G}-mini-btn primary`;
      createBtn.textContent = '+ 新建成员';
      const newStatus = document.createElement('span');
      newStatus.className = `${G}-mini-status`;
      createBtn.onclick = () => {
        const name = nmInput.value.trim();
        const description = dsInput.value.trim();
        if (!name || !description) {
          newStatus.textContent = '名称与职责描述都要填';
          return;
        }
        createBtn.disabled = true;
        createBtn.textContent = '创建中…';
        newStatus.textContent = '正在创建并注入角色上下文（可能需几十秒）…';
        void window.kimi.ch
          .groupCreateMember(gid, { name, description })
          .then(async (ng) => {
            await deps.refresh(); // 新 session 要进项目树
            applyUpdate(ng);
          })
          .catch((err) => {
            newStatus.textContent = `创建失败:${String(err)}`;
          })
          .finally(() => {
            createBtn.disabled = false;
            createBtn.textContent = '+ 新建成员';
          });
      };
      newRow.append(nmInput, dsInput, createBtn, newStatus);
      box.appendChild(newRow);

      const closeRow = document.createElement('div');
      closeRow.className = `${G}-box-actions`;
      const closeBtn = document.createElement('button');
      closeBtn.className = `${G}-mini-btn`;
      closeBtn.textContent = '关闭';
      closeBtn.onclick = close;
      closeRow.appendChild(closeBtn);
      box.appendChild(closeRow);
    };

    render(group);
  }

  // ---------- public ----------
  return {
    async showGroup(gid: string): Promise<void> {
      const data = await window.kimi.ch.groupMessages(gid);
      if (destroyed) return;
      messagesEl.innerHTML = '';
      if (!data) {
        group = null;
        nameEl.textContent = '👥 (group 不存在)';
        roundsEl.textContent = '';
        appendMessage({ from: '系统', fromKind: 'system', text: '该 group 不存在或已被删除。', at: Date.now() });
        return;
      }
      group = data.group;
      groupMd = data.groupMd;
      for (const m of data.messages) appendMessage(m);
      syncTopbar();
      scrollToBottom(true);
      inputEl.focus();
    },
    hide(): void {
      group = null;
      messagesEl.innerHTML = '';
      closeMention();
    },
    currentGid: () => group?.id ?? null,
  };
}

/** group 归属的项目(projectId 优先,cwd 兜底) */
function findGroupProject(deps: GroupUiDeps, g: GroupRecord): ChannelProject | null {
  const projects = deps.getProjects();
  if (g.projectId) {
    const hit = projects.find((p) => p.projectId === g.projectId);
    if (hit) return hit;
  }
  if (g.cwd) return projects.find((p) => p.cwd === g.cwd) ?? null;
  return null;
}

// ============================================================
// 新建 group 向导
// ============================================================

export function openGroupWizard(deps: GroupUiDeps, defaultProjectKey: string | null): void {
  const { box, close } = makeOverlay(deps.page);
  const projects = deps.getProjects();
  const keyOf = (p: ChannelProject) => p.projectId ?? p.cwd;
  let proj: ChannelProject | null = projects.find((p) => keyOf(p) === defaultProjectKey) ?? projects[0] ?? null;

  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = `${G}-box-head`;
  head.textContent = '新建 group';
  box.appendChild(head);

  // 项目选择
  const projRow = document.createElement('div');
  projRow.className = `${G}-form-row`;
  const projLabel = document.createElement('span');
  projLabel.className = `${G}-form-label`;
  projLabel.textContent = '项目';
  const projSel = document.createElement('select');
  projSel.className = `${G}-select`;
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = keyOf(p);
    opt.textContent = deps.projectLabel(p);
    projSel.appendChild(opt);
  }
  if (proj) projSel.value = keyOf(proj);
  projRow.append(projLabel, projSel);
  box.appendChild(projRow);

  // 名称
  const nameRow = document.createElement('div');
  nameRow.className = `${G}-form-row`;
  const nameLabel = document.createElement('span');
  nameLabel.className = `${G}-form-label`;
  nameLabel.textContent = '名称';
  const nameInput = document.createElement('input');
  nameInput.className = `${G}-input-line`;
  nameInput.placeholder = 'group 名称';
  nameRow.append(nameLabel, nameInput);
  box.appendChild(nameRow);

  // 成员多选
  const memberLabelEl = document.createElement('div');
  memberLabelEl.className = `${G}-form-label ${G}-form-label-top`;
  memberLabelEl.textContent = '成员（协调者会自动创建，这里选的是其他成员，可留空）';
  const memberList = document.createElement('div');
  memberList.className = `${G}-wiz-members`;
  box.append(memberLabelEl, memberList);

  const renderMembers = () => {
    memberList.innerHTML = '';
    const sessions = (proj?.sessions ?? []).filter((s) => !s.ephemeral);
    if (sessions.length === 0) {
      memberList.textContent = '该项目下还没有 session。';
      return;
    }
    for (const s of sessions) {
      const row = document.createElement('label');
      row.className = `${G}-wiz-member`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      const agent = s.agentId ? deps.getAgentById(s.agentId) : undefined;
      const name = document.createElement('span');
      name.textContent = `${agent ? agent.avatar + ' ' : ''}${deps.sessionLabel(s)}`;
      row.append(cb, name);
      memberList.appendChild(row);
    }
  };
  renderMembers();
  projSel.onchange = () => {
    proj = projects.find((p) => keyOf(p) === projSel.value) ?? null;
    renderMembers();
    planArea.innerHTML = '';
  };

  // 任务描述 + AI 规划
  const taskLabel = document.createElement('div');
  taskLabel.className = `${G}-form-label ${G}-form-label-top`;
  taskLabel.textContent = '任务描述（可选，用于 AI 规划编排）';
  const taskInput = document.createElement('textarea');
  taskInput.className = `${G}-wiz-task`;
  taskInput.placeholder = '描述这个 group 要完成的任务…';
  taskInput.rows = 3;
  const planBtn = document.createElement('button');
  planBtn.className = `${G}-mini-btn`;
  planBtn.textContent = '✦ AI 规划编排';
  const planArea = document.createElement('div');
  planArea.className = `${G}-plan-area`;
  box.append(taskLabel, taskInput, planBtn, planArea);

  const checkedSids = () =>
    [...memberList.querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);

  planBtn.onclick = () => {
    const taskDescription = taskInput.value.trim();
    if (!taskDescription) {
      taskInput.focus();
      return;
    }
    planBtn.disabled = true;
    planArea.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = `${G}-box-hint`;
    loading.textContent = '规划中（utility session，可能需几十秒）…';
    planArea.appendChild(loading);
    void window.kimi.ch
      .groupPlan({ taskDescription, memberSessionIds: checkedSids() })
      .then((r) => {
        planArea.innerHTML = '';
        planArea.appendChild(renderPlanCard(r));
      })
      .finally(() => {
        planBtn.disabled = false;
      });
  };

  // 动作
  const actions = document.createElement('div');
  actions.className = `${G}-box-actions`;
  const createBtn = document.createElement('button');
  createBtn.className = `${G}-mini-btn primary`;
  createBtn.textContent = '创建';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = `${G}-mini-btn`;
  cancelBtn.textContent = '取消';
  cancelBtn.onclick = close;
  actions.append(cancelBtn, createBtn);
  box.appendChild(actions);

  createBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    // groupCreate 现在会自动建 coordinator session 并等首轮注入完成,可能几十秒
    createBtn.disabled = true;
    cancelBtn.disabled = true;
    createBtn.textContent = '创建中（正在启动协调者）…';
    void window.kimi.ch
      .groupCreate({
        name,
        projectId: proj?.projectId,
        cwd: proj?.cwd || undefined,
        members: checkedSids().map((sessionId) => ({ sessionId })),
      })
      .then(async (g) => {
        close();
        await deps.refresh();
        deps.onGroupSelected(g.id);
      })
      .catch((err) => {
        createBtn.disabled = false;
        cancelBtn.disabled = false;
        createBtn.textContent = '创建';
        window.alert(`创建 group 失败：${String(err)}`);
      });
  };

  nameInput.focus();
}

/** groupPlan 结果卡片:ok → 结构化递归渲染;ok:false → 纯文本(可据文案改任务描述重规划) */
function renderPlanCard(r: { ok: true; plan: Record<string, unknown> } | { ok: false; text: string }): HTMLElement {
  const card = document.createElement('div');
  card.className = `${G}-plan-card`;
  const head = document.createElement('div');
  head.className = `${G}-plan-head`;
  head.textContent = '✦ 编排方案（参考，本期不可编辑）';
  card.appendChild(head);
  if (!r.ok) {
    const pre = document.createElement('pre');
    pre.className = `${G}-plan-text`;
    pre.textContent = r.text;
    card.appendChild(pre);
    return card;
  }
  card.appendChild(planNode(r.plan, 0));
  return card;
}

function planNode(v: unknown, depth: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `${G}-plan-node`;
  if (depth > 0) wrap.style.paddingLeft = `${Math.min(depth * 12, 36)}px`;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item !== null && typeof item === 'object') {
        wrap.appendChild(planNode(item, depth + 1));
      } else {
        const li = document.createElement('div');
        li.className = `${G}-plan-leaf`;
        li.textContent = `· ${String(item)}`;
        wrap.appendChild(li);
      }
    }
    return wrap;
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== null && typeof val === 'object') {
        const key = document.createElement('div');
        key.className = `${G}-plan-key`;
        key.textContent = k;
        wrap.appendChild(key);
        wrap.appendChild(planNode(val, depth + 1));
      } else {
        const leaf = document.createElement('div');
        leaf.className = `${G}-plan-leaf`;
        leaf.textContent = `${k}: ${String(val)}`;
        wrap.appendChild(leaf);
      }
    }
    return wrap;
  }
  const leaf = document.createElement('div');
  leaf.className = `${G}-plan-leaf`;
  leaf.textContent = String(v);
  wrap.appendChild(leaf);
  return wrap;
}

// ============================================================
// worktree 面板 + Orca 式 diff 评审
// ============================================================

export async function openWorktreePanel(deps: GroupUiDeps, repoPath: string): Promise<void> {
  const { box, close } = makeOverlay(deps.page);
  const head = document.createElement('div');
  head.className = `${G}-box-head`;
  head.textContent = `worktrees · ${repoPath.split('/').pop() ?? repoPath}`;
  box.appendChild(head);
  const listEl = document.createElement('div');
  listEl.className = `${G}-wt-list`;
  listEl.textContent = '加载中…';
  box.appendChild(listEl);

  const closeRow = document.createElement('div');
  closeRow.className = `${G}-box-actions`;
  const closeBtn = document.createElement('button');
  closeBtn.className = `${G}-mini-btn`;
  closeBtn.textContent = '关闭';
  closeBtn.onclick = close;
  closeRow.appendChild(closeBtn);
  box.appendChild(closeRow);

  const r = await window.kimi.ch.worktreeList(repoPath);
  listEl.innerHTML = '';
  if (!r.ok) {
    listEl.textContent = wtErrorText(r);
    listEl.classList.add(`${G}-box-hint`);
    return;
  }
  const items = (r.worktrees ?? []).filter((w) => w.branch); // detached 无操作意义
  if (items.length === 0) {
    listEl.textContent = '没有 worktree。';
    listEl.classList.add(`${G}-box-hint`);
    return;
  }
  for (const w of items) {
    const row = document.createElement('div');
    row.className = `${G}-wt-row`;
    const info = document.createElement('div');
    info.className = `${G}-wt-info`;
    const branch = document.createElement('div');
    branch.className = `${G}-wt-branch`;
    branch.textContent = `⎇ ${w.branch}`;
    const path = document.createElement('div');
    path.className = `${G}-wt-path`;
    path.textContent = w.path;
    info.append(branch, path);
    const ops = document.createElement('div');
    ops.className = `${G}-wt-ops`;

    const diffBtn = document.createElement('button');
    diffBtn.className = `${G}-mini-btn`;
    diffBtn.textContent = '查看 diff';
    diffBtn.onclick = () => void openDiffView(deps, repoPath, w.branch);

    const mergeBtn = document.createElement('button');
    mergeBtn.className = `${G}-mini-btn`;
    mergeBtn.textContent = '合并';
    mergeBtn.onclick = () => {
      if (!window.confirm(`将分支 ${w.branch} 合并进仓库当前检出的分支，继续？`)) return;
      mergeBtn.disabled = true;
      void window.kimi.ch.worktreeMerge({ repoPath, branch: w.branch }).then((res) => {
        if (res.ok) row.remove();
        else window.alert(wtErrorText(res));
        mergeBtn.disabled = false;
      });
    };

    const discardBtn = document.createElement('button');
    discardBtn.className = `${G}-mini-btn danger`;
    discardBtn.textContent = '丢弃';
    discardBtn.onclick = () => {
      if (!window.confirm(`丢弃 worktree ${w.branch}？\n其中的改动将丢失，不可恢复。`)) return;
      void window.kimi.ch.worktreeDiscard({ repoPath, path: w.path, branch: w.branch }).then((res) => {
        if (res.ok) row.remove();
        else window.alert(wtErrorText(res));
      });
    };

    ops.append(diffBtn, mergeBtn, discardBtn);
    row.append(info, ops);
    listEl.appendChild(row);
  }
}

// ---------- diff 评审 ----------

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
}
interface DiffFile {
  path: string;
  lines: DiffLine[];
  adds: number;
  dels: number;
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const raw = chunk.split('\n');
    const m = raw[0].match(/a\/(\S+) b\/(\S+)/);
    const file: DiffFile = { path: m ? m[2] : '(unknown)', lines: [], adds: 0, dels: 0 };
    for (const l of raw.slice(1)) {
      if (/^(index |---|\+\+\+|new file|deleted file|old mode|new mode|similarity|rename)/.test(l)) continue;
      if (l.startsWith('@@')) file.lines.push({ kind: 'hunk', text: l });
      else if (l.startsWith('+')) {
        file.lines.push({ kind: 'add', text: l.slice(1) });
        file.adds++;
      } else if (l.startsWith('-')) {
        file.lines.push({ kind: 'del', text: l.slice(1) });
        file.dels++;
      } else if (l.startsWith('\\')) {
        /* "\ No newline" 标记,跳过 */
      } else file.lines.push({ kind: 'ctx', text: l.startsWith(' ') ? l.slice(1) : l });
    }
    files.push(file);
  }
  return files;
}

async function openDiffView(deps: GroupUiDeps, repoPath: string, branch: string): Promise<void> {
  const { box, close } = makeOverlay(deps.page);
  box.classList.add(`${G}-box-wide`);
  const head = document.createElement('div');
  head.className = `${G}-box-head`;
  head.textContent = `diff 评审 · ${branch}`;
  box.appendChild(head);

  const body = document.createElement('div');
  body.className = `${G}-diff-body`;
  body.textContent = '加载中…';
  box.appendChild(body);

  // 底部:合并 / 丢弃 / 关闭(评审后可直接处置)
  const actions = document.createElement('div');
  actions.className = `${G}-box-actions`;
  const mergeBtn = document.createElement('button');
  mergeBtn.className = `${G}-mini-btn primary`;
  mergeBtn.textContent = '合并';
  mergeBtn.onclick = () => {
    if (!window.confirm(`将分支 ${branch} 合并进仓库当前检出的分支，继续？`)) return;
    void window.kimi.ch.worktreeMerge({ repoPath, branch }).then((r) => {
      if (r.ok) close();
      else window.alert(wtErrorText(r));
    });
  };
  const discardBtn = document.createElement('button');
  discardBtn.className = `${G}-mini-btn danger`;
  discardBtn.textContent = '丢弃';
  discardBtn.onclick = () => {
    if (!window.confirm(`丢弃 worktree ${branch}？\n其中的改动将丢失，不可恢复。`)) return;
    void window.kimi.ch.worktreeDiscard({ repoPath, path: wt?.entry.path ?? '', branch }).then((r) => {
      if (r.ok) close();
      else window.alert(wtErrorText(r));
    });
  };
  const closeBtn = document.createElement('button');
  closeBtn.className = `${G}-mini-btn`;
  closeBtn.textContent = '关闭';
  closeBtn.onclick = close;
  actions.append(mergeBtn, discardBtn, closeBtn);
  box.appendChild(actions);

  // session↔branch 映射:行内批注的回喂目标 + 丢弃时的 path
  const wt = wtFindByBranch(branch);

  const r = await window.kimi.ch.worktreeDiff(repoPath, branch);
  body.innerHTML = '';
  if (!r.ok) {
    body.textContent = wtErrorText(r);
    return;
  }
  const files = parseDiff(r.diff ?? '');
  if (files.length === 0) {
    body.textContent = '（无 diff，该 worktree 与基线一致）';
    return;
  }
  if (!wt) {
    const hint = document.createElement('div');
    hint.className = `${G}-box-hint`;
    hint.textContent = '未记录该分支对应的 session（localStorage 无映射），行内批注不可用。';
    body.appendChild(hint);
  }
  for (const f of files) body.appendChild(renderDiffFile(f, wt?.sessionId ?? null));
}

function renderDiffFile(f: DiffFile, commentSid: string | null): HTMLElement {
  const COLLAPSE_LINES = 60;
  const block = document.createElement('div');
  block.className = `${G}-diff-file`;
  const head = document.createElement('button');
  head.className = `${G}-diff-file-head`;
  head.textContent = `${f.path}  +${f.adds} -${f.dels}`;
  const linesEl = document.createElement('div');
  linesEl.className = `${G}-diff-lines`;
  // 长文件默认折叠
  if (f.lines.length > COLLAPSE_LINES) linesEl.classList.add('collapsed');
  head.onclick = () => linesEl.classList.toggle('collapsed');
  block.append(head, linesEl);

  for (const line of f.lines) {
    const row = document.createElement('div');
    row.className = `${G}-diff-line ${line.kind}`;
    const text = document.createElement('code');
    text.textContent = (line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : line.kind === 'hunk' ? '' : '  ') + line.text;
    row.appendChild(text);

    // 行内批注入口(hunk 行不挂)
    if (line.kind !== 'hunk' && commentSid) {
      const cBtn = document.createElement('button');
      cBtn.className = `${G}-diff-comment-btn`;
      cBtn.textContent = '💬';
      cBtn.title = '对该行写批注,发给该 worktree 的 session';
      cBtn.onclick = () => openCommentEditor(row, f.path, line, commentSid);
      row.appendChild(cBtn);
    }
    linesEl.appendChild(row);
  }
  return block;
}

function openCommentEditor(row: HTMLElement, filePath: string, line: DiffLine, sid: string): void {
  // 同一行只开一个
  if (row.nextElementSibling?.classList.contains(`${G}-diff-comment`)) return;
  const editor = document.createElement('div');
  editor.className = `${G}-diff-comment`;
  const input = document.createElement('input');
  input.className = `${G}-input-line`;
  input.placeholder = '批注（将作为 prompt 发给该 worktree 的 session）…';
  const send = document.createElement('button');
  send.className = `${G}-mini-btn primary`;
  send.textContent = '发送';
  const cancel = document.createElement('button');
  cancel.className = `${G}-mini-btn`;
  cancel.textContent = '取消';
  const status = document.createElement('span');
  status.className = `${G}-mini-status`;
  editor.append(input, send, cancel, status);
  row.after(editor);
  input.focus();

  cancel.onclick = () => editor.remove();
  const submit = () => {
    const comment = input.value.trim();
    if (!comment) return;
    send.disabled = true;
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const prompt =
      `[diff 行批注] 文件 ${filePath}，行内容：\`${sign}${line.text}\`\n` +
      `批注：${comment}\n` +
      `这是代码评审中对上述 diff 行的批注，请据此修改。`;
    void window.kimi
      .prompt(sid, prompt, null, null)
      .then(() => {
        status.textContent = '已发送 ✓';
        setTimeout(() => editor.remove(), 1200);
      })
      .catch((err) => {
        status.textContent = `发送失败:${String(err)}`;
        send.disabled = false;
      });
  };
  send.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') {
      e.stopPropagation();
      editor.remove();
    }
  };
}
