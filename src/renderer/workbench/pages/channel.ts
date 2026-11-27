/**
 * Channel 页（v7.0 P1+P2，design/design-v7.md §6.2/§10 + prd「分组信息密度方案」）：
 * - 左栏：状态条（运行中 / 待处理 / 置顶 + 仅看有更新开关）+ 项目树（默认折叠，
 *   只展开含 busy/pinned/hasUpdate session 的项目；14 天无活跃归入底部「不活跃」;
 *   阅后即焚 session 收进「临时」区,可删除）
 * - 右栏：createChatPanel 实例，选中 session 后经 ch.openSession 统一入口加载
 *   （history 回放 / live 补放缓冲区挂实时流 / stale 丢弃，忙中绝不触发 ACP load）
 * - 新建 session 可绑定常驻 agent(首轮注入,创建中有占位态);session 行 ⚙ 打开
 *   三配置抽屉(AGENTS.md 项目级 / current-process.md / product.md,自动保存);
 *   绑了 agent 的行显示 avatar + 名称小标
 * - Cmd+K 快速跳转：channel 页激活时接管 workbench 全局 Cmd+K（捕获阶段拦截），
 *   模糊匹配项目名 / session 标题 / lastMessage
 * - 数据刷新：onChChanged → 重新 scan；onTurnDone → 节流刷新（lastMessage 变了）
 */

import type {
  AgentRecord,
  ChannelProject,
  ChannelSession,
  ChannelTree,
  SessionConfig,
  SessionConfigField,
} from '../../../shared/types';
import { createChatPanel, type ChatPanelHandle } from '../../shared/chat-panel';
import { activatePage, activePageId } from '../core/nav';
import {
  createGroupView,
  openGroupWizard,
  openWorktreePanel,
  type GroupUiDeps,
} from './group-view';
import { createTermView } from './term-view';
import type { GroupRecord } from '../../../shared/types';

const P = 'chan'; // class prefix
const INACTIVE_MS = 14 * 24 * 3600 * 1000; // 14 天无活跃归入「不活跃」

export function initChannelPage(): void {
  const page = document.getElementById('page-channel')!;
  page.innerHTML = `
    <div class="${P}-tabs">
      <button class="${P}-tab on" data-tab="list">列表</button>
      <button class="${P}-tab" data-tab="board">看板</button>
    </div>
    <div class="${P}-root">
      <aside class="${P}-side">
        <div class="${P}-status"></div>
        <div class="${P}-tree"></div>
        <div class="${P}-newproj"></div>
      </aside>
      <main class="${P}-main">
        <div class="${P}-head">
          <span class="${P}-head-title">未选择会话</span>
          <span class="${P}-head-sub"></span>
          <span class="spacer"></span>
          <div class="${P}-viewseg hidden">
            <button data-view="chat" class="on" title="chat 视图">💬 chat</button>
            <button data-view="term" title="内嵌终端(时分复用,打开即接管)">⌨️ 终端</button>
          </div>
          <button class="${P}-head-btn hidden" data-act="vis" title="观察视图(只读,在浏览器打开)">👁</button>
          <button class="${P}-head-btn hidden" data-act="ext" title="在外部终端打开(iTerm/Terminal)">↗</button>
        </div>
        <div class="${P}-panel-host"></div>
        <div class="${P}-group-host hidden"></div>
        <div class="${P}-term-host hidden"></div>
        <div class="${P}-held-mask hidden">
          <div class="${P}-held-card">
            <div class="${P}-held-text">该 session 正被终端接管，chat 已锁定</div>
            <button class="${P}-held-release">交还</button>
          </div>
        </div>
        <div class="${P}-empty">
          <div class="${P}-empty-icon">#</div>
          <div>从左侧选择一个会话，或按 ⌘K 快速跳转</div>
        </div>
      </main>
    </div>
    <div class="${P}-board hidden"></div>`;

  const statusEl = page.querySelector(`.${P}-status`) as HTMLElement;
  const treeEl = page.querySelector(`.${P}-tree`) as HTMLElement;
  const newProjEl = page.querySelector(`.${P}-newproj`) as HTMLElement;
  const headTitle = page.querySelector(`.${P}-head-title`) as HTMLElement;
  const headSub = page.querySelector(`.${P}-head-sub`) as HTMLElement;
  const headWrap = page.querySelector(`.${P}-head`) as HTMLElement;
  const panelHostEl = page.querySelector(`.${P}-panel-host`) as HTMLElement;
  const groupHostEl = page.querySelector(`.${P}-group-host`) as HTMLElement;
  const termHostEl = page.querySelector(`.${P}-term-host`) as HTMLElement;
  const heldMaskEl = page.querySelector(`.${P}-held-mask`) as HTMLElement;
  const viewSegEl = page.querySelector(`.${P}-viewseg`) as HTMLElement;
  const segChatBtn = viewSegEl.querySelector('[data-view="chat"]') as HTMLButtonElement;
  const segTermBtn = viewSegEl.querySelector('[data-view="term"]') as HTMLButtonElement;
  const visBtn = page.querySelector('[data-act="vis"]') as HTMLButtonElement;
  const extBtn = page.querySelector('[data-act="ext"]') as HTMLButtonElement;
  const rootEl = page.querySelector(`.${P}-root`) as HTMLElement;
  const boardEl = page.querySelector(`.${P}-board`) as HTMLElement;
  const emptyEl = page.querySelector(`.${P}-empty`) as HTMLElement;

  // ---------- state ----------
  let tree: ChannelTree | null = null;
  let selectedSessionId: string | null = null;
  // 当前选中项目(点项目头或选中其下 session 时更新;「新建 session」挂在它下面)
  let selectedProjectKey: string | null = null;
  let onlyUpdates = false;
  // 展开状态：手动操作优先；未手动操作的按自动规则（含 hot session 才展开）
  const manualExpand = new Set<string>();
  const manualCollapse = new Set<string>();
  let inactiveOpen = false;
  let tempOpen = false; // 「临时」区(阅后即焚 session)折叠态
  // SA 托管标识:tasks.md 里 watch- 前缀 task_id 行含 sid 前 12 位(10s 缓存,解析不到不阻塞)
  let watchingSids = new Set<string>();
  let watchingLoadedAt = 0;
  // 「历史归档」组:折叠态 + 窗口化(首 50 条,「显示更多」每次 +100)
  let archiveOpen = false;
  let archiveShown = 50;
  // 待处理权限：requestId → sessionId（turn-done 后清除，响应后主进程会继续/结束 turn）
  const pendingPerms = new Map<string, string>();
  // 常驻 agent 缓存(页面加载拉一次;行内 avatar/名称小标 + 新建 session 选择用)
  let agentList: AgentRecord[] = [];
  const agentById = new Map<string, AgentRecord>();
  // 「创建中(注入角色上下文)」占位行所在项目 + 是否带 agent 注入
  let creatingInKey: string | null = null;
  let creatingWithAgent = false;
  // P3a: group 列表(随 refresh 与 scan 一起拉) + 当前选中的 group(与 session 选中互斥)
  let groups: GroupRecord[] = [];
  let selectedGroupId: string | null = null;
  // group 置顶(group 不是 session,ch.setPin 不适用,本地存)
  const GP_KEY = 'kimi-chan-group-pins';
  const groupPins: Set<string> = (() => {
    try {
      const raw = localStorage.getItem(GP_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  })();
  const saveGroupPins = () => {
    try {
      localStorage.setItem(GP_KEY, JSON.stringify([...groupPins]));
    } catch {
      /* ignore */
    }
  };

  // ---------- chat panel ----------
  const panel: ChatPanelHandle = createChatPanel(panelHostEl, {
    getSessionId: () => selectedSessionId ?? '',
    openSession: (sid) => window.kimi.ch.openSession(sid),
    onSwitchSession: (sid) => {
      // 面板内新建会话等场景：同步选中态
      selectedSessionId = sid;
      emptyEl.classList.add('gone');
      syncHead();
      renderTree();
    },
  });

  // ---------- group 视图(与 chat 面板互斥切换;两者都常驻 DOM,只切显隐) ----------
  // 注意:chat 工厂的 onChunk/onTurnDone 等监听无反注册,destroy 即失效,故永不销毁只隐藏
  const groupDeps: GroupUiDeps = {
    page,
    getProjects: () => tree?.projects ?? [],
    getAgentById: (id) => agentById.get(id),
    projectLabel: (p) => p.name ?? p.dirName,
    sessionLabel: (s) => s.title || s.lastPrompt?.slice(0, 30) || s.id.slice(0, 12),
    refresh: () => refresh(),
    onGroupSelected: (gid) => selectGroup(gid),
  };
  const groupView = createGroupView(groupHostEl, groupDeps);

  function selectGroup(gid: string): void {
    selectedGroupId = gid;
    const g = groups.find((x) => x.id === gid);
    if (g) {
      const proj = (tree?.projects ?? []).find(
        (p) => (g.projectId && p.projectId === g.projectId) || (g.cwd && p.cwd === g.cwd),
      );
      if (proj) selectedProjectKey = projectKey(proj);
    }
    // 终端/观察为 session 上下文,切 group 时让位(关 pty 释放 held、visClose)
    closeVis();
    void leaveTerm();
    heldMaskEl.classList.add('hidden');
    emptyEl.classList.add('gone');
    panelHostEl.classList.add('hidden');
    headWrap.classList.add('hidden'); // group 视图自带顶栏
    groupHostEl.classList.remove('hidden');
    renderAll();
    void groupView.showGroup(gid);
  }

  /** group → chat 的切回:隐藏 group 视图,恢复面板与头部 */
  function showChatView(): void {
    if (!selectedGroupId) return;
    selectedGroupId = null;
    groupView.hide();
    groupHostEl.classList.add('hidden');
    panelHostEl.classList.remove('hidden');
    headWrap.classList.remove('hidden');
  }

  // ---------- 终端三视图(P3b, design/design-v7.md §12:L1 观察 / L2 外开 / L3 内嵌) ----------
  let segView: 'chat' | 'term' = 'chat';
  // L1:vis 观察(浏览器打开,不 held);切 session/group 或再次点击时 visClose
  let vis: { visId: string; sid: string } | null = null;

  /** 轻量提示(channel 页底部浮出,自动消失) */
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function flashNotice(text: string): void {
    page.querySelector(`.${P}-notice`)?.remove();
    if (noticeTimer) clearTimeout(noticeTimer);
    const el = document.createElement('div');
    el.className = `${P}-notice`;
    el.textContent = text;
    page.appendChild(el);
    noticeTimer = setTimeout(() => el.remove(), 2800);
  }

  const termView = createTermView(termHostEl, {
    // pty 自行退出:held 已自动释放,切回 chat 并拉回历史
    onExit: (sid) => {
      segView = 'chat';
      syncSeg();
      termHostEl.classList.add('hidden');
      if (selectedSessionId === sid && !selectedGroupId) {
        panelHostEl.classList.remove('hidden');
        flashNotice('终端已退出，正在拉回历史…');
        void panel.setSession(sid);
      } else {
        flashNotice('终端已退出');
      }
    },
  });

  function syncSeg(): void {
    segChatBtn.classList.toggle('on', segView === 'chat');
    segTermBtn.classList.toggle('on', segView === 'term');
  }

  /** chat/终端分段切换(交还握手:切走必须 term.close,然后 openSession 拉回终端期间历史) */
  async function setSegView(view: 'chat' | 'term'): Promise<void> {
    const sid = selectedSessionId;
    if (!sid || selectedGroupId || segView === view) return;
    if (view === 'term') {
      try {
        await termView.open(sid); // 打开即 held
      } catch (err) {
        // 兜底交还:任何阶段失败都不许把 session 锁在「终端接管中」
        void window.kimi.term.release(sid).catch(() => undefined);
        flashNotice(`终端打开失败：${String(err)}`);
        return;
      }
      segView = 'term';
      panelHostEl.classList.add('hidden');
      heldMaskEl.classList.add('hidden'); // 终端视图自带交互,不需要锁 mask
      termHostEl.classList.remove('hidden');
      termView.focus();
    } else {
      await termView.close(); // kill pty + 释放 held
      segView = 'chat';
      termHostEl.classList.add('hidden');
      panelHostEl.classList.remove('hidden');
      flashNotice('终端已关闭，正在拉回历史…');
      await panel.setSession(sid); // openSession → history/live
    }
    syncSeg();
  }
  segChatBtn.onclick = () => void setSegView('chat');
  segTermBtn.onclick = () => void setSegView('term');

  /** 离开 session 上下文前的终端清理(只关 pty + 收终端视图;chat 面板显隐由调用方决定) */
  async function leaveTerm(): Promise<void> {
    if (!termView.isOpen()) return;
    await termView.close();
    segView = 'chat';
    syncSeg();
    termHostEl.classList.add('hidden');
  }

  // L1 观察:workbench webPreferences 未开 webviewTag → 系统浏览器打开(只读,不 held)
  function syncVisBtn(): void {
    visBtn.classList.toggle('on', !!vis);
  }
  function closeVis(): void {
    if (!vis) return;
    window.kimi.term.visClose(vis.visId);
    vis = null;
    syncVisBtn();
  }
  visBtn.onclick = () => {
    const sid = selectedSessionId;
    if (!sid) return;
    if (vis) {
      closeVis();
      flashNotice('已关闭观察视图');
      return;
    }
    void window.kimi.term.visOpen(sid).then((r) => {
      vis = { visId: r.visId, sid };
      window.kimi.openExternal(r.url); // preload 暴露的 shell.openExternal
      flashNotice('观察视图已在浏览器打开');
      syncVisBtn();
    });
  };

  // L2 外开:打开即 held(主进程无法感知关闭),chat 锁定 + 「交还」按钮闭环
  extBtn.onclick = () => {
    const sid = selectedSessionId;
    if (!sid) return;
    void window.kimi.term.openExternal(sid).then((r) => {
      if (!r.ok) {
        flashNotice('外部终端打开失败');
        return;
      }
      flashNotice(`已在 ${r.app} 打开`);
      showHeldMask();
    });
  };

  function showHeldMask(): void {
    heldMaskEl.classList.remove('hidden');
    segTermBtn.disabled = true; // held 期间不允许再开 L3
  }
  function hideHeldMask(): void {
    heldMaskEl.classList.add('hidden');
    segTermBtn.disabled = false;
  }
  (heldMaskEl.querySelector(`.${P}-held-release`) as HTMLButtonElement).onclick = () => {
    const sid = selectedSessionId;
    if (!sid) return;
    void window.kimi.term.release(sid).then(async () => {
      hideHeldMask();
      flashNotice('已交还，正在拉回历史…');
      await panel.setSession(sid); // 终端期间的历史拉回 chat 视图
    });
  };

  // ---------- 列表 / 看板 tab ----------
  let activeTab: 'list' | 'board' = 'list';
  function setTab(tab: 'list' | 'board'): void {
    activeTab = tab;
    page.querySelectorAll(`.${P}-tab`).forEach((b) =>
      b.classList.toggle('on', (b as HTMLElement).dataset.tab === tab),
    );
    rootEl.classList.toggle('hidden', tab === 'board');
    boardEl.classList.toggle('hidden', tab !== 'board');
    if (tab === 'board') renderBoard();
  }
  page.querySelectorAll(`.${P}-tab`).forEach((b) => {
    (b as HTMLButtonElement).onclick = () => setTab((b as HTMLElement).dataset.tab as 'list' | 'board');
  });

  /** session 看板(design/design-v7.md §6.2:列表/看板 tab;数据源 = scan 拍平,复用 pendingPerms) */
  function renderBoard(): void {
    boardEl.innerHTML = '';
    if (!tree) return;
    // 归档 session 排除出看板(历史整理产物,不是 fleet 状态)
    const all = tree.projects
      .filter((p) => p.bucket !== 'archive')
      .flatMap((p) => p.sessions.map((s) => ({ p, s })));

    const stats = document.createElement('div');
    stats.className = `${P}-board-stats`;
    stats.textContent = `共 ${all.length} 个 session · 运行中 ${all.filter((x) => x.s.busy).length} · 待处理 ${all.filter((x) => hasPendingPerm(x.s.id)).length}`;
    boardEl.appendChild(stats);

    const COLS: { label: string; match: (x: { p: ChannelProject; s: ChannelSession }) => boolean }[] = [
      { label: '✦ 置顶', match: (x) => x.s.pinned },
      { label: '▶ 运行中', match: (x) => !x.s.pinned && x.s.busy },
      { label: '⚠ 待处理', match: (x) => !x.s.pinned && !x.s.busy && hasPendingPerm(x.s.id) },
      { label: '○ 空闲', match: (x) => !x.s.pinned && !x.s.busy && !hasPendingPerm(x.s.id) },
    ];
    const colsEl = document.createElement('div');
    colsEl.className = `${P}-board-cols`;
    for (const col of COLS) {
      const items = all.filter(col.match).sort((a, b) => b.s.updatedAt - a.s.updatedAt);
      const colEl = document.createElement('div');
      colEl.className = `${P}-board-col`;
      const head = document.createElement('div');
      head.className = `${P}-board-col-head`;
      head.textContent = col.label;
      const count = document.createElement('span');
      count.className = `${P}-board-count`;
      count.textContent = String(items.length);
      head.appendChild(count);
      colEl.appendChild(head);
      for (const { p, s } of items) colEl.appendChild(makeBoardCard(p, s));
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = `${P}-board-empty`;
        empty.textContent = '—';
        colEl.appendChild(empty);
      }
      colsEl.appendChild(colEl);
    }
    boardEl.appendChild(colsEl);
  }

  function makeBoardCard(p: ChannelProject, s: ChannelSession): HTMLElement {
    const card = document.createElement('div');
    card.className = `${P}-board-card` + (s.busy ? ' busy' : '');

    const top = document.createElement('div');
    top.className = `${P}-board-card-top`;
    const light = document.createElement('span');
    light.className = `${P}-sess-dot` + (s.busy ? ' run' : '');
    light.textContent = s.busy ? '●' : '○';
    top.appendChild(light);
    if (s.agentId) {
      const agent = agentById.get(s.agentId);
      const badge = document.createElement('span');
      badge.className = `${P}-sess-agent`;
      badge.textContent = agent ? `${agent.avatar} ${agent.name}` : '🤖';
      top.appendChild(badge);
    }
    const title = document.createElement('span');
    title.className = `${P}-board-card-title`;
    title.textContent = sessionLabel(s);
    top.appendChild(title);
    card.appendChild(top);

    const excerpt = document.createElement('div');
    excerpt.className = `${P}-board-card-excerpt`;
    excerpt.textContent = (s.lastMessage || s.lastPrompt || '(无消息)').slice(0, 80);
    card.appendChild(excerpt);

    const meta = document.createElement('div');
    meta.className = `${P}-board-card-meta`;
    meta.textContent = `${projectLabel(p)} · ${relTime(s.updatedAt)}`;
    card.appendChild(meta);

    card.onclick = () => {
      manualExpand.add(projectKey(p));
      manualCollapse.delete(projectKey(p));
      setTab('list');
      selectSession(s.id);
    };
    return card;
  }

  // ---------- helpers ----------
  const projectKey = (p: ChannelProject) => p.projectId ?? p.cwd;
  const projectLabel = (p: ChannelProject) => p.name ?? p.dirName;
  const projLastActive = (p: ChannelProject) =>
    p.sessions.reduce((max, s) => Math.max(max, s.updatedAt), 0);

  function isInactive(p: ChannelProject): boolean {
    if (p.sessions.length === 0) return false; // 手动新建的空项目留在主树
    return Date.now() - projLastActive(p) > INACTIVE_MS;
  }

  function isHot(p: ChannelProject): boolean {
    return p.sessions.some(
      (s) => !s.ephemeral && (s.busy || s.pinned || s.hasUpdate || hasPendingPerm(s.id)),
    );
  }

  function isExpanded(p: ChannelProject): boolean {
    const key = projectKey(p);
    if (manualExpand.has(key)) return true;
    if (manualCollapse.has(key)) return false;
    return isHot(p);
  }

  function hasPendingPerm(sid: string): boolean {
    for (const s of pendingPerms.values()) if (s === sid) return true;
    return false;
  }

  function findSession(sid: string): { p: ChannelProject; s: ChannelSession } | null {
    if (!tree) return null;
    for (const p of tree.projects) {
      const s = p.sessions.find((x) => x.id === sid);
      if (s) return { p, s };
    }
    return null;
  }

  function selectedProject(): ChannelProject | null {
    if (!tree || !selectedProjectKey) return null;
    return tree.projects.find((p) => projectKey(p) === selectedProjectKey) ?? null;
  }

  function relTime(ts: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
    return `${Math.floor(diff / 86400_000)}天前`;
  }

  function sessionLabel(s: ChannelSession): string {
    return s.title || s.lastPrompt?.slice(0, 30) || s.id.slice(0, 12);
  }

  // ---------- 选中 ----------
  function selectSession(sid: string): void {
    showChatView(); // group 选中态切回 chat(无 group 选中时为空操作)
    closeVis(); // 观察视图跟着 session 走
    // 终端是另一个 session 的 → 关掉释放 held;同一个 session 重选则保留终端视图
    if (termView.isOpen() && termView.sessionId() !== sid) void leaveTerm();
    if (!termView.isOpen()) panelHostEl.classList.remove('hidden'); // 终端保留时不切 panel
    selectedSessionId = sid;
    void window.kimi.ch.markViewed(sid);
    const hit = findSession(sid);
    if (hit) {
      hit.s.hasUpdate = false; // 本地灭点,等下次 scan 校准
      selectedProjectKey = projectKey(hit.p);
    }
    emptyEl.classList.add('gone');
    syncHead();
    renderAll();
    // held 恢复(L2 外开过/刷新后状态不丢);L3 开着时终端视图即 held 表达,不叠 mask
    if (!(termView.isOpen() && termView.sessionId() === sid)) {
      void window.kimi.term.isHeld(sid).then((held) => {
        if (selectedSessionId !== sid || selectedGroupId) return;
        if (held) showHeldMask();
        else hideHeldMask();
      });
    }
    void panel.setSession(sid);
  }

  /** 清空选中态回空态页(归档当前选中 session 等场景):收终端/观察/held 遮罩 */
  function clearSelection(): void {
    closeVis();
    if (termView.isOpen()) void leaveTerm();
    hideHeldMask();
    selectedSessionId = null;
    panelHostEl.classList.remove('hidden');
    emptyEl.classList.remove('gone');
    syncHead();
    renderAll();
  }

  function syncHead(): void {
    const hit = selectedSessionId ? findSession(selectedSessionId) : null;
    headTitle.textContent = hit ? sessionLabel(hit.s) : selectedSessionId ? '会话' : '未选择会话';
    headSub.textContent = hit ? projectLabel(hit.p) : '';
    // chat/终端分段开关 + L1/L2 按钮只在选中 session(非 group)时出现
    const showTerm = !!selectedSessionId && !selectedGroupId;
    viewSegEl.classList.toggle('hidden', !showTerm);
    visBtn.classList.toggle('hidden', !showTerm);
    extBtn.classList.toggle('hidden', !showTerm);
  }

  // ---------- 状态条 ----------
  function renderStatus(): void {
    statusEl.innerHTML = '';
    if (!tree) return;
    const all = tree.projects
      .filter((p) => p.bucket !== 'archive') // 归档 session 不进状态条
      .flatMap((p) => p.sessions.map((s) => ({ p, s })));
    const busy = all.filter((x) => x.s.busy);
    const waiting = all.filter((x) => hasPendingPerm(x.s.id));
    const pinned = all.filter((x) => x.s.pinned);

    const sec = (label: string, items: { p: ChannelProject; s: ChannelSession }[], flat: boolean) => {
      if (items.length === 0) return;
      const box = document.createElement('div');
      box.className = `${P}-st-sec`;
      const head = document.createElement('div');
      head.className = `${P}-st-label`;
      head.textContent = `${label} (${items.length})`;
      box.appendChild(head);
      for (const { p, s } of items) {
        const row = document.createElement('button');
        row.className = `${P}-st-item` + (s.id === selectedSessionId ? ' on' : '');
        row.title = `${projectLabel(p)} / ${sessionLabel(s)}`;
        const name = document.createElement('span');
        name.className = `${P}-st-name`;
        name.textContent = sessionLabel(s);
        row.appendChild(name);
        if (!flat) {
          const proj = document.createElement('span');
          proj.className = `${P}-st-proj`;
          proj.textContent = projectLabel(p);
          row.appendChild(proj);
        }
        row.onclick = () => {
          manualExpand.add(projectKey(p));
          selectSession(s.id);
        };
        box.appendChild(row);
      }
      statusEl.appendChild(box);
    };

    sec('▶ 运行中', busy, false);
    sec('⚠ 待处理', waiting, false);
    sec('✦ 置顶', pinned, true); // 飞书式:置顶只显名称

    const toggle = document.createElement('label');
    toggle.className = `${P}-st-toggle`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = onlyUpdates;
    cb.onchange = () => {
      onlyUpdates = cb.checked;
      renderTree();
    };
    const txt = document.createElement('span');
    txt.textContent = '仅看有更新';
    toggle.append(cb, txt);
    statusEl.appendChild(toggle);
  }

  // ---------- 项目树 ----------
  function visibleSessions(p: ChannelProject): ChannelSession[] {
    // 阅后即焚 session 不进正常项目树,收进底部「临时」区
    return p.sessions.filter((s) => !s.ephemeral && (!onlyUpdates || s.hasUpdate));
  }

  function makeSessionRow(p: ChannelProject, s: ChannelSession, temp = false): HTMLElement {
    const row = document.createElement('div');
    row.className =
      `${P}-sess` +
      (s.id === selectedSessionId && !selectedGroupId ? ' on' : '') +
      (s.busy ? ' busy' : '');
    row.dataset.sid = s.id;

    const dot = document.createElement('span');
    dot.className = `${P}-sess-dot` + (s.busy ? ' run' : '');
    dot.textContent = s.busy ? '●' : '○';

    row.appendChild(dot);

    // 常驻 agent 标识:avatar emoji + 名称小标
    if (s.agentId) {
      const agent = agentById.get(s.agentId);
      const badge = document.createElement('span');
      badge.className = `${P}-sess-agent`;
      badge.textContent = agent ? `${agent.avatar} ${agent.name}` : '🤖';
      badge.title = agent ? `常驻 Agent:${agent.name}${agent.description ? ' — ' + agent.description : ''}` : '常驻 Agent';
      row.appendChild(badge);
    }

    // SA 托管标识:outline ✦ 角标(与置顶实心 ✦ 区分)
    if (watchingSids.has(s.id)) {
      const saBadge = document.createElement('span');
      saBadge.className = `${P}-sess-sa`;
      saBadge.textContent = '✦';
      saBadge.title = 'SA 托管中';
      row.appendChild(saBadge);
    }

    const name = document.createElement('span');
    name.className = `${P}-sess-name`;
    name.textContent = sessionLabel(s);
    name.title = s.lastMessage || s.lastPrompt || s.id;
    row.appendChild(name);

    if (s.hasUpdate) {
      const upd = document.createElement('span');
      upd.className = `${P}-sess-upd`;
      upd.title = '有更新';
      row.appendChild(upd);
    }
    if (hasPendingPerm(s.id)) {
      const warn = document.createElement('span');
      warn.className = `${P}-sess-warn`;
      warn.textContent = '⚠';
      warn.title = '等待权限确认';
      row.appendChild(warn);
    }

    const time = document.createElement('span');
    time.className = `${P}-sess-time`;
    time.textContent = relTime(s.updatedAt);
    row.appendChild(time);

    // 全部操作收进 hover-reveal 的 ··· 菜单(行上只留状态点/圆点/agent 标/标题)
    const moreBtn = document.createElement('button');
    moreBtn.className = `${P}-sess-more`;
    moreBtn.textContent = '···';
    moreBtn.title = '操作';
    moreBtn.onclick = (ev) => {
      ev.stopPropagation();
      openCtxMenu(ev.clientX, ev.clientY, sessionMenuItems(s, temp));
    };
    row.appendChild(moreBtn);

    row.onclick = () => selectSession(s.id);
    return row;
  }

  /** session 行的操作菜单项(按行类型出对应项:普通=置顶/配置/分叉/归档,临时=配置/归档/删除) */
  function sessionMenuItems(s: ChannelSession, temp: boolean): CtxMenuItem[] {
    const items: CtxMenuItem[] = [];
    if (!temp) {
      items.push({
        label: s.pinned ? '取消置顶' : '✦ 置顶',
        onClick: () => void window.kimi.ch.setPin(s.id, !s.pinned).then(refresh),
      });
    }
    items.push({ label: '⚙ 会话配置', onClick: () => void openConfigDrawer(s.id) });
    // SA 托管:已托管 → 取消;未托管 → 弹 goal 输入后 watchSession
    items.push({
      label: watchingSids.has(s.id) ? '✦ 取消托管' : '✦ 托管给 SA',
      onClick: () => {
        if (watchingSids.has(s.id)) {
          void window.kimi.sa.unwatchSession(s.id).then(() =>
            loadWatching(true).then(() => {
              flashNotice('已取消托管');
              return refresh();
            }),
          );
        } else {
          openWatchGoalModal(s);
        }
      },
    });
    if (!temp) {
      items.push({
        label: '⑂ 分叉(复制完整上下文)',
        onClick: () => {
          if (!window.confirm('将复制该 session 的完整上下文（成本较高）。继续？')) return;
          void window.kimi.ch.forkSession(s.id).then(({ sessionId }) =>
            refresh().then(() => selectSession(sessionId)),
          );
        },
      });
    }
    items.push({
      label: '📥 移入历史归档',
      onClick: () => {
        if (!window.confirm('移入历史归档？（可随时恢复）')) return;
        void window.kimi.ch.archiveSession(s.id, true).then(() => {
          if (s.id === selectedSessionId) clearSelection(); // 归档当前选中 → 回空态页
          return refresh();
        });
      },
    });
    if (temp) {
      items.push({
        label: '🗑 删除(不可恢复)',
        danger: true,
        onClick: () => {
          if (!window.confirm(`删除临时 session「${sessionLabel(s)}」？\n删除后不可恢复。`)) return;
          void window.kimi.ch.deleteSession(s.id).then(refresh);
        },
      });
    }
    return items;
  }

  /** 「托管给 SA」的 goal 输入小弹层(可留空) */
  function openWatchGoalModal(s: ChannelSession): void {
    const overlay = document.createElement('div');
    overlay.className = `${P}-goal-overlay`;
    const card = document.createElement('div');
    card.className = `${P}-goal-card`;
    const title = document.createElement('div');
    title.className = `${P}-goal-title`;
    title.textContent = `托管「${sessionLabel(s)}」给 SA`;
    const input = document.createElement('input');
    input.className = `${P}-goal-input`;
    input.placeholder = '让 SA 跟进什么？（可留空）';
    const actions = document.createElement('div');
    actions.className = `${P}-goal-actions`;
    const cancel = document.createElement('button');
    cancel.className = `${P}-btn`;
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = `${P}-btn primary`;
    ok.textContent = '托管';
    actions.append(cancel, ok);
    card.append(title, input, actions);
    overlay.appendChild(card);
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    cancel.onclick = () => overlay.remove();
    const submit = () => {
      const goal = input.value.trim();
      overlay.remove();
      void window.kimi.sa
        .watchSession(s.id, goal ? { goal } : {})
        .then(() => {
          flashNotice('已托管，SA 将跟进该 session 的进展');
          return loadWatching(true).then(refresh);
        })
        .catch((err) => flashNotice(`托管失败：${String(err)}`));
    };
    ok.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') overlay.remove();
    };
    page.appendChild(overlay);
    input.focus();
  }

  /** SA 工作区组识别:cwd 末段是 .jarvis-workspace/super-agent(稳;dirName/标题会被用户改) */
  const SA_DIR_SUFFIX = '.jarvis-workspace/super-agent';
  function isSaProject(p: ChannelProject): boolean {
    return !!p.cwd && p.cwd.replace(/\\/g, '/').replace(/\/+$/, '').endsWith(SA_DIR_SUFFIX);
  }

  /** 「✦ Super Agent」特殊入口行:树最上方,点击切 SUPER tab(不开对话视图) */
  function makeSaEntry(count: number): HTMLElement {
    const row = document.createElement('button');
    row.className = `${P}-sa-entry`;
    const icon = document.createElement('span');
    icon.className = `${P}-sa-entry-icon`;
    icon.textContent = '✦';
    const label = document.createElement('span');
    label.className = `${P}-sa-entry-name`;
    label.textContent = 'Super Agent';
    const badge = document.createElement('span');
    badge.className = `${P}-sa-entry-count`;
    badge.textContent = String(count);
    badge.title = `${count} 个 SA session`;
    row.append(icon, label, badge);
    row.title = '打开 SUPER tab(直聊 / 看板 / 回执)';
    row.onclick = () => activatePage('page-super');
    return row;
  }

  /** group 树节点:👥 前缀,可置顶(本地存)/选中,排在项目列表最前 */
  function makeGroupRow(g: GroupRecord): HTMLElement {    const row = document.createElement('div');
    row.className = `${P}-sess ${P}-group` + (g.id === selectedGroupId ? ' on' : '');
    row.dataset.gid = g.id;

    const icon = document.createElement('span');
    icon.className = `${P}-sess-dot`;
    icon.textContent = '👥';
    const name = document.createElement('span');
    name.className = `${P}-sess-name`;
    name.textContent = g.name;
    name.title = `${g.name} · ${g.members.length} 成员`;
    const meta = document.createElement('span');
    meta.className = `${P}-sess-time`;
    meta.textContent = `${g.members.length}人`;

    const pin = document.createElement('button');
    pin.className = `${P}-sess-pin` + (groupPins.has(g.id) ? ' on' : '');
    pin.textContent = '✦';
    pin.title = groupPins.has(g.id) ? '取消置顶' : '置顶';
    pin.onclick = (ev) => {
      ev.stopPropagation();
      if (groupPins.has(g.id)) groupPins.delete(g.id);
      else groupPins.add(g.id);
      saveGroupPins();
      renderTree();
    };

    row.append(icon, name, meta, pin);
    row.onclick = () => selectGroup(g.id);
    return row;
  }

  /** 项目下的 group(projectId 优先,cwd 兜底),置顶在前 */
  function projectGroups(p: ChannelProject): GroupRecord[] {
    return groups
      .filter((g) => (g.projectId && g.projectId === p.projectId) || (!g.projectId && g.cwd && g.cwd === p.cwd))
      .sort((a, b) => Number(groupPins.has(b.id)) - Number(groupPins.has(a.id)) || a.createdAt - b.createdAt);
  }

  function makeProjectNode(p: ChannelProject): HTMLElement {
    const key = projectKey(p);
    const sessions = visibleSessions(p);
    const expanded = isExpanded(p);
    const node = document.createElement('div');
    node.className = `${P}-proj`;

    const head = document.createElement('button');
    head.className = `${P}-proj-head` + (key === selectedProjectKey ? ' on' : '');
    const arrow = document.createElement('span');
    arrow.className = `${P}-proj-arrow`;
    arrow.textContent = expanded ? '▼' : '▶';
    const label = document.createElement('span');
    label.className = `${P}-proj-name`;
    label.textContent = projectLabel(p);
    const meta = document.createElement('span');
    meta.className = `${P}-proj-meta`;
    const lastActive = projLastActive(p);
    meta.textContent = expanded || !lastActive
      ? `(${sessions.length})`
      : `(${sessions.length}) · ${relTime(lastActive)}`;
    head.append(arrow, label, meta);
    // worktrees 入口(hover-reveal;head 是 button,用 span 避免嵌套按钮)
    if (p.cwd) {
      const wtBtn = document.createElement('span');
      wtBtn.className = `${P}-proj-wt`;
      wtBtn.textContent = '⎇';
      wtBtn.title = 'worktrees';
      wtBtn.onclick = (ev) => {
        ev.stopPropagation();
        void openWorktreePanel(groupDeps, p.cwd);
      };
      head.appendChild(wtBtn);
    }
    head.onclick = () => {
      selectedProjectKey = key; // 点项目头即选中项目(「新建 session」的挂靠目标)
      if (expanded) {
        manualExpand.delete(key);
        manualCollapse.add(key);
      } else {
        manualCollapse.delete(key);
        manualExpand.add(key);
      }
      renderTree();
    };
    // 右键菜单:普通/手动项目才有(「未分组」「历史归档」「临时」虚拟组不出);
    // 与 session 行 ··· 菜单共用同一套组件
    if (!p.bucket) {
      head.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openCtxMenu(ev.clientX, ev.clientY, [
          {
            label: '新建 session',
            disabled: !p.cwd,
            title: p.cwd ? `在 ${projectLabel(p)} 下新建会话` : '该项目没有路径',
            onClick: () => {
              selectedProjectKey = key; // 等同先选中该项目
              renderTree();
              // 复用「新建 session」现有流程(带 agent 选择)
              if (agentList.length === 0) void createSessionInProject(p);
              else openAgentPicker(p);
            },
          },
          {
            label: '打开所在目录',
            disabled: !p.cwd,
            title: p.cwd ? p.cwd : '该项目没有路径',
            onClick: () => void window.kimi.ch.openPath(p.cwd),
          },
        ]);
      };
    }
    node.appendChild(head);

    if (expanded) {
      const list = document.createElement('div');
      list.className = `${P}-proj-list`;
      // 「创建中(注入角色上下文)」占位行
      if (creatingInKey === key) {
        const ph = document.createElement('div');
        ph.className = `${P}-sess creating`;
        const phDot = document.createElement('span');
        phDot.className = `${P}-sess-dot run`;
        phDot.textContent = '●';
        const phName = document.createElement('span');
        phName.className = `${P}-sess-name`;
        phName.textContent = creatingWithAgent ? '创建中（注入角色上下文）…' : '创建中…';
        ph.append(phDot, phName);
        list.appendChild(ph);
      }
      for (const g of projectGroups(p)) list.appendChild(makeGroupRow(g));
      for (const s of sessions) list.appendChild(makeSessionRow(p, s));
      if (sessions.length === 0 && projectGroups(p).length === 0 && creatingInKey !== key) {
        const empty = document.createElement('div');
        empty.className = `${P}-proj-empty`;
        empty.textContent = '暂无会话';
        list.appendChild(empty);
      }
      node.appendChild(list);
    }
    return node;
  }

  function renderTree(): void {
    treeEl.innerHTML = '';
    if (!tree) return;
    const active: ChannelProject[] = [];
    const unsorted: ChannelProject[] = []; // bucket='unsorted':当普通项目组,排正常项目之后
    const inactive: ChannelProject[] = [];
    const archiveProjects: ChannelProject[] = []; // bucket='archive':永远树底,专属渲染
    let saCount = 0; // super-agent 项目组的 session 数(汇成特殊入口行)
    for (const p of tree.projects) {
      // SA 工作区组:不展开为普通 session 列表,汇成「✦ Super Agent」入口行
      if (isSaProject(p)) {
        saCount += p.sessions.length;
        continue;
      }
      if (p.bucket === 'archive') {
        archiveProjects.push(p);
        continue;
      }
      // 仅看有更新:无匹配 session 的项目隐藏(正常模式空项目仍显示,便于新建会话入口)
      if (onlyUpdates && visibleSessions(p).length === 0) continue;
      if (p.bucket === 'unsorted') {
        unsorted.push(p);
        continue;
      }
      (isInactive(p) ? inactive : active).push(p);
    }
    if (saCount > 0) treeEl.appendChild(makeSaEntry(saCount));
    for (const p of active) treeEl.appendChild(makeProjectNode(p));
    for (const p of unsorted) treeEl.appendChild(makeProjectNode(p));

    // 「临时」区:阅后即焚 session(视觉权重高于「不活跃」,可能是正在跑的 utility 任务)
    const tempItems = tree.projects
      .filter((p) => p.bucket !== 'archive')
      .flatMap((p) =>
        p.sessions
          .filter((s) => s.ephemeral && (!onlyUpdates || s.hasUpdate))
          .map((s) => ({ p, s })),
      );
    if (tempItems.length > 0) {
      const box = document.createElement('div');
      box.className = `${P}-inactive ${P}-temp`;
      const head = document.createElement('button');
      head.className = `${P}-proj-head`;
      const arrow = document.createElement('span');
      arrow.className = `${P}-proj-arrow`;
      arrow.textContent = tempOpen ? '▼' : '▸';
      const label = document.createElement('span');
      label.className = `${P}-proj-name`;
      label.textContent = '临时';
      const meta = document.createElement('span');
      meta.className = `${P}-proj-meta`;
      meta.textContent = `(${tempItems.length})`;
      head.append(arrow, label, meta);
      head.onclick = () => {
        tempOpen = !tempOpen;
        renderTree();
      };
      box.appendChild(head);
      if (tempOpen) {
        const list = document.createElement('div');
        list.className = `${P}-proj-list`;
        for (const { p, s } of tempItems) list.appendChild(makeSessionRow(p, s, true));
        box.appendChild(list);
      }
      treeEl.appendChild(box);
    }

    if (inactive.length > 0) {
      const box = document.createElement('div');
      box.className = `${P}-inactive`;
      const head = document.createElement('button');
      head.className = `${P}-proj-head`;
      const arrow = document.createElement('span');
      arrow.className = `${P}-proj-arrow`;
      arrow.textContent = inactiveOpen ? '▼' : '▸';
      const label = document.createElement('span');
      label.className = `${P}-proj-name`;
      label.textContent = '不活跃';
      const meta = document.createElement('span');
      meta.className = `${P}-proj-meta`;
      meta.textContent = `(${inactive.length})`;
      head.append(arrow, label, meta);
      head.onclick = () => {
        inactiveOpen = !inactiveOpen;
        renderTree();
      };
      box.appendChild(head);
      if (inactiveOpen) {
        for (const p of inactive) box.appendChild(makeProjectNode(p));
      }
      treeEl.appendChild(box);
    }

    // 「历史归档」组(bucket='archive'):永远树底、默认折叠、不参与 hot 展开与圆点/
    // 仅看更新过滤;可能上千条,窗口化渲染(首 50 条 + 「显示更多」每次追加 100)
    if (archiveProjects.length > 0) {
      const archiveSessions = archiveProjects.flatMap((p) => p.sessions.map((s) => ({ p, s })));
      const box = document.createElement('div');
      box.className = `${P}-inactive ${P}-archive`;
      const head = document.createElement('button');
      head.className = `${P}-proj-head`;
      const arrow = document.createElement('span');
      arrow.className = `${P}-proj-arrow`;
      arrow.textContent = archiveOpen ? '▼' : '▸';
      const label = document.createElement('span');
      label.className = `${P}-proj-name`;
      label.textContent = '历史归档';
      const meta = document.createElement('span');
      meta.className = `${P}-proj-meta`;
      meta.textContent = `(${archiveSessions.length})`;
      head.append(arrow, label, meta);
      head.onclick = () => {
        archiveOpen = !archiveOpen;
        renderTree();
      };
      box.appendChild(head);
      if (archiveOpen) {
        const list = document.createElement('div');
        list.className = `${P}-proj-list`;
        for (const { p, s } of archiveSessions.slice(0, archiveShown)) {
          list.appendChild(makeArchiveRow(p, s));
        }
        const remaining = archiveSessions.length - archiveShown;
        if (remaining > 0) {
          const more = document.createElement('button');
          more.className = `${P}-archive-more`;
          more.textContent = `显示更多（还有 ${remaining} 条）`;
          more.onclick = () => {
            archiveShown += 100;
            renderTree();
          };
          list.appendChild(more);
        }
        box.appendChild(list);
      }
      treeEl.appendChild(box);
    }
  }

  /** 归档行:无圆点/置顶,操作收 ··· 菜单(恢复);点击查看历史允许 */
  function makeArchiveRow(p: ChannelProject, s: ChannelSession): HTMLElement {
    const row = document.createElement('div');
    row.className = `${P}-sess` + (s.id === selectedSessionId && !selectedGroupId ? ' on' : '');
    row.dataset.sid = s.id;

    const dot = document.createElement('span');
    dot.className = `${P}-sess-dot`;
    dot.textContent = '○';
    const name = document.createElement('span');
    name.className = `${P}-sess-name`;
    name.textContent = sessionLabel(s);
    name.title = s.lastMessage || s.lastPrompt || s.id;
    const time = document.createElement('span');
    time.className = `${P}-sess-time`;
    time.textContent = relTime(s.updatedAt);

    const moreBtn = document.createElement('button');
    moreBtn.className = `${P}-sess-more`;
    moreBtn.textContent = '···';
    moreBtn.title = '操作';
    moreBtn.onclick = (ev) => {
      ev.stopPropagation();
      openCtxMenu(ev.clientX, ev.clientY, [
        {
          label: '↩ 恢复到原项目/未分组',
          onClick: () => void window.kimi.ch.archiveSession(s.id, false).then(refresh),
        },
      ]);
    };

    row.append(dot, name, time, moreBtn);
    row.onclick = () => selectSession(s.id);
    return row;
  }

  // ---------- 新建(项目 / session) ----------
  let newMenuEl: HTMLElement | null = null;

  function closeNewMenu(): void {
    newMenuEl?.remove();
    newMenuEl = null;
  }

  /**
   * 在选中项目(需有 path)下创建会话并立即选中,输入框聚焦由 panel.setSession 完成。
   * 绑 agent 时 ch.newSession 会等首轮注入 turn 完成(几秒~几十秒),期间树内显示占位行。
   */
  async function createSessionInProject(p: ChannelProject, agentId?: string): Promise<void> {
    creatingInKey = projectKey(p);
    creatingWithAgent = !!agentId;
    manualCollapse.delete(creatingInKey);
    manualExpand.add(creatingInKey); // 占位行要看得见
    renderTree();
    try {
      const { sessionId } = await window.kimi.ch.newSession({ cwd: p.cwd, agentId });
      // 手动项目(带 projectId):按 cwd 分组未必能归进去,显式归类;
      // await 掉再 refresh,避免 scan 抢在 setProject 落库前跑(归组丢失)
      if (p.projectId) await window.kimi.ch.setProject(sessionId, p.projectId);
      await refresh();
      selectSession(sessionId);
    } catch (err) {
      // 主进程 handler 抛错时不能静默——用户看到「什么都没发生」
      flashNotice(`新建 session 失败：${String(err)}`);
    } finally {
      creatingInKey = null;
      creatingWithAgent = false;
      renderTree();
    }
  }

  function openNewMenu(): void {
    closeNewMenu();
    const menu = document.createElement('div');
    menu.className = `${P}-new-menu`;

    const mkItem = (label: string, disabled: boolean, title: string, onClick: () => void) => {
      const item = document.createElement('button');
      item.className = `${P}-new-item` + (disabled ? ' disabled' : '');
      item.textContent = label;
      item.title = title;
      item.disabled = disabled;
      item.onclick = (ev) => {
        // stopPropagation:item 可能被摘除(openAgentPicker 等二级菜单),
        // 冒泡到 document 会被「菜单外点击关闭」误杀刚打开的二级菜单
        ev.stopPropagation();
        closeNewMenu();
        onClick();
      };
      menu.appendChild(item);
    };

    // 新建项目:原生目录选择器,选完用文件夹名做项目名;取消则什么都不做
    mkItem('新建项目', false, '选择文件夹,以其为名新建项目', () => {
      void window.kimi.ch.pickFolder().then(async (picked) => {
        if (!picked) return;
        await window.kimi.ch.projectCreate(picked.name, picked.path);
        await refresh();
      });
    });

    // 新建 session:挂在选中项目下;未选中项目或项目无 path(空项目)时禁用
    const proj = selectedProject();
    const canCreate = !!proj && !!proj.cwd;
    mkItem(
      '新建 session',
      !canCreate,
      canCreate ? `在 ${projectLabel(proj!)} 下新建会话` : '先选中一个有路径的项目',
      () => {
        // agent 库为空直接建;非空则出 agent 选择菜单
        if (agentList.length === 0) void createSessionInProject(proj!);
        else openAgentPicker(proj!);
      },
    );

    // 新建 group:多 session 协作(向导:选项目/名称/成员/可选 AI 规划)
    const hasProjects = (tree?.projects.length ?? 0) > 0;
    mkItem('新建 group', !hasProjects, hasProjects ? '创建多 session 协作 group' : '还没有项目', () => {
      openGroupWizard(groupDeps, selectedProjectKey);
    });

    newProjEl.appendChild(menu);
    newMenuEl = menu;
  }

  /** agent 选择菜单(新建 session 第二步):无 agent / 各常驻 agent */
  function openAgentPicker(proj: ChannelProject): void {
    closeNewMenu();
    const menu = document.createElement('div');
    menu.className = `${P}-new-menu`;
    const head = document.createElement('div');
    head.className = `${P}-new-menu-head`;
    head.textContent = `新建 session · ${projectLabel(proj)}`;
    menu.appendChild(head);

    const mk = (label: string, desc: string, onClick: () => void) => {
      const item = document.createElement('button');
      item.className = `${P}-new-item`;
      const name = document.createElement('span');
      name.textContent = label;
      item.appendChild(name);
      if (desc) {
        const sub = document.createElement('span');
        sub.className = `${P}-new-item-sub`;
        sub.textContent = desc;
        item.appendChild(sub);
      }
      item.onclick = (ev) => {
        ev.stopPropagation(); // 同 mkItem:防止 document 监听误杀本菜单
        closeNewMenu();
        onClick();
      };
      menu.appendChild(item);
    };

    mk('普通 session', '不绑定常驻 agent', () => void createSessionInProject(proj));
    for (const a of agentList) {
      mk(`${a.avatar} ${a.name}`, a.description, () => void createSessionInProject(proj, a.id));
    }

    newProjEl.appendChild(menu);
    newMenuEl = menu;
  }

  function renderNewProj(): void {
    newProjEl.innerHTML = '';
    newMenuEl = null;
    const btn = document.createElement('button');
    btn.className = `${P}-newproj-btn`;
    btn.textContent = '+ 新建';
    btn.onclick = (ev) => {
      ev.stopPropagation(); // 避免被下面的 document 点击关闭逻辑立即吃掉
      if (newMenuEl) closeNewMenu();
      else openNewMenu();
    };
    newProjEl.appendChild(btn);
  }

  // ---------- 通用小菜单(session 行 ··· 菜单 + 项目头右键菜单共用) ----------
  interface CtxMenuItem {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    title?: string;
    onClick(): void;
  }
  let ctxMenuEl: HTMLElement | null = null;

  function closeCtxMenu(): void {
    ctxMenuEl?.remove();
    ctxMenuEl = null;
  }

  /**
   * 在 (clientX, clientY) 处弹小菜单:挂 page(树刷新不销毁它),
   * 自动上下避让 + 左右夹紧;菜单外点击 / Esc / 点项后关闭。
   */
  function openCtxMenu(clientX: number, clientY: number, items: CtxMenuItem[]): void {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = `${P}-ctx-menu`;
    for (const it of items) {
      const btn = document.createElement('button');
      btn.className = `${P}-ctx-item` + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      btn.textContent = it.label;
      if (it.title) btn.title = it.title;
      btn.disabled = !!it.disabled;
      btn.onclick = (ev) => {
        // stopPropagation:右键菜单项可能打开二级菜单(agent picker),
        // 冒泡到 document 会被「菜单外点击关闭」误杀
        ev.stopPropagation();
        closeCtxMenu();
        it.onClick();
      };
      menu.appendChild(btn);
    }
    page.appendChild(menu);
    ctxMenuEl = menu;
    const pageRect = page.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = clientX - pageRect.left;
    let y = clientY - pageRect.top;
    if (x + mw > pageRect.width - 8) x = pageRect.width - mw - 8;
    if (y + mh > pageRect.height - 8) y = Math.max(8, y - mh - 4); // 向上翻
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${y}px`;
  }

  // 菜单外点击 / Esc 关闭
  document.addEventListener('click', (e) => {
    if (newMenuEl && !newProjEl.contains(e.target as Node)) closeNewMenu();
    if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeNewMenu();
      closeCtxMenu();
      closeConfigDrawer();
    }
  });

  // ---------- session 配置抽屉(AGENTS.md / current-process.md / product.md) ----------
  const CONFIG_TABS: { field: SessionConfigField; label: string; projectLevel: boolean }[] = [
    { field: 'agentsMd', label: 'AGENTS.md', projectLevel: true },
    { field: 'currentProcessMd', label: 'current-process.md', projectLevel: false },
    { field: 'productMd', label: 'product.md', projectLevel: false },
  ];

  let drawerEl: HTMLElement | null = null;
  let drawerState: { sid: string; cfg: SessionConfig; field: SessionConfigField; dirty: boolean } | null = null;
  let drawerTextarea: HTMLTextAreaElement | null = null;
  let drawerStatusEl: HTMLElement | null = null;
  let drawerSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function setDrawerStatus(text: string): void {
    if (drawerStatusEl) drawerStatusEl.textContent = text;
  }

  /** 立即落盘当前 tab 的未存内容(防抖到期/失焦/切 tab/关抽屉都会走这里) */
  async function flushConfigSave(): Promise<void> {
    if (drawerSaveTimer) {
      clearTimeout(drawerSaveTimer);
      drawerSaveTimer = null;
    }
    if (!drawerState?.dirty || !drawerTextarea) return;
    const { sid, field } = drawerState;
    const content = drawerTextarea.value;
    drawerState.dirty = false;
    setDrawerStatus('保存中…');
    try {
      await window.kimi.ch.sessionConfigWrite(sid, field, content);
      drawerState.cfg[field] = content;
      setDrawerStatus('已保存 ✓');
    } catch {
      drawerState.dirty = true; // 失败恢复脏标,下次继续尝试
      setDrawerStatus('保存失败');
    }
  }

  function scheduleConfigSave(): void {
    if (!drawerState) return;
    drawerState.dirty = true;
    setDrawerStatus('…');
    if (drawerSaveTimer) clearTimeout(drawerSaveTimer);
    drawerSaveTimer = setTimeout(() => void flushConfigSave(), 1000);
  }

  function closeConfigDrawer(): void {
    if (!drawerEl) return;
    void flushConfigSave();
    drawerEl.remove();
    drawerEl = null;
    drawerState = null;
    drawerTextarea = null;
    drawerStatusEl = null;
  }

  async function openConfigDrawer(sid: string): Promise<void> {
    closeConfigDrawer();
    const cfg = await window.kimi.ch.sessionConfigRead(sid);

    const el = document.createElement('div');
    el.className = `${P}-drawer`;

    const head = document.createElement('div');
    head.className = `${P}-drw-head`;
    const title = document.createElement('span');
    title.className = `${P}-drw-title`;
    const hit = findSession(sid);
    title.textContent = hit ? sessionLabel(hit.s) : sid.slice(0, 12);
    const refreshBtn = document.createElement('button');
    refreshBtn.className = `${P}-drw-btn`;
    refreshBtn.textContent = '↻';
    refreshBtn.title = '重新读取(current-process.md 在 turn 结束后几秒才刷新)';
    const closeBtn = document.createElement('button');
    closeBtn.className = `${P}-drw-btn`;
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    closeBtn.onclick = closeConfigDrawer;
    head.append(title, refreshBtn, closeBtn);
    el.appendChild(head);

    if (!cfg) {
      const err = document.createElement('div');
      err.className = `${P}-drw-error`;
      err.textContent = '该 session 目录无法解析';
      el.appendChild(err);
      refreshBtn.remove();
    } else {
      drawerState = { sid, cfg, field: 'agentsMd', dirty: false };

      const tabs = document.createElement('div');
      tabs.className = `${P}-drw-tabs`;
      const editor = document.createElement('textarea');
      editor.className = `${P}-drw-editor`;
      editor.spellcheck = false;
      const hint = document.createElement('div');
      hint.className = `${P}-drw-hint`;
      const status = document.createElement('div');
      status.className = `${P}-drw-status`;
      drawerTextarea = editor;
      drawerStatusEl = status;

      const syncTabView = () => {
        if (!drawerState) return;
        tabs.querySelectorAll('button').forEach((b) =>
          b.classList.toggle('on', (b as HTMLElement).dataset.field === drawerState!.field),
        );
        editor.value = drawerState.cfg[drawerState.field];
        const tab = CONFIG_TABS.find((t) => t.field === drawerState!.field)!;
        hint.textContent = tab.projectLevel
          ? `项目级配置，影响该项目所有 session · ${drawerState.cfg.agentsMdPath}`
          : `本 session 专属 · ${drawerState.cfg.dirPath}`;
        setDrawerStatus('');
      };

      for (const t of CONFIG_TABS) {
        const b = document.createElement('button');
        b.dataset.field = t.field;
        b.textContent = t.label;
        b.onclick = () => {
          if (!drawerState || drawerState.field === t.field) return;
          void flushConfigSave().then(() => {
            if (!drawerState) return;
            drawerState.field = t.field;
            syncTabView();
          });
        };
        tabs.appendChild(b);
      }

      editor.addEventListener('input', scheduleConfigSave);
      editor.addEventListener('blur', () => void flushConfigSave());

      refreshBtn.onclick = () => {
        void flushConfigSave().then(async () => {
          if (!drawerState) return;
          const fresh = await window.kimi.ch.sessionConfigRead(drawerState.sid);
          if (fresh && drawerState) {
            drawerState.cfg = fresh;
            syncTabView();
            setDrawerStatus('已刷新 ✓');
          }
        });
      };

      el.append(tabs, editor, hint, status);
      syncTabView();
    }

    page.appendChild(el);
    drawerEl = el;
  }

  function renderAll(): void {
    renderStatus();
    renderTree();
    // 新建菜单打开时不重渲染该区块,避免刷新把菜单收掉
    if (!newMenuEl) renderNewProj();
    // 看板 tab 激活时随数据刷新重渲染(onChChanged / onTurnDone 节流已在上游)
    if (activeTab === 'board') renderBoard();
  }

  // ---------- 数据刷新 ----------

  /** 解析 tasks.md 的 watch- 前缀 task_id 行,匹配含 sid 前 12 位的 session(角标数据源) */
  async function loadWatching(force = false): Promise<void> {
    if (!force && Date.now() - watchingLoadedAt < 10_000) return;
    watchingLoadedAt = Date.now();
    try {
      const { content } = await window.kimi.sa.readTasks();
      const watchLines = content.split('\n').filter((l) => /watch-[\w-]*/i.test(l));
      const next = new Set<string>();
      if (tree) {
        for (const p of tree.projects) {
          for (const s of p.sessions) {
            const prefix = s.id.slice(0, 12);
            if (watchLines.some((l) => l.includes(prefix))) next.add(s.id);
          }
        }
      }
      watchingSids = next;
    } catch {
      /* SA 未就绪则静默,不显示角标(不阻塞 channel 页) */
    }
  }

  let refreshing = false;
  let refreshQueued = false;
  async function refresh(): Promise<void> {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    try {
      // scan + groupList 并行;group 树节点(👥)随树一起重渲染
      [tree, groups] = await Promise.all([window.kimi.ch.scan(), window.kimi.ch.groupList()]);
      await loadWatching(); // 10s 缓存,常规刷新零成本
      renderAll();
      syncHead();
    } finally {
      refreshing = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refresh();
      }
    }
  }

  window.kimi.onChChanged(() => void refresh());

  // turn-done:清待处理标记 + 节流刷新(lastMessage/ busy 变了)
  let turnDoneTimer: ReturnType<typeof setTimeout> | null = null;
  window.kimi.onTurnDone((e) => {
    for (const [rid, sid] of pendingPerms) if (sid === e.sessionId) pendingPerms.delete(rid);
    if (turnDoneTimer) clearTimeout(turnDoneTimer);
    turnDoneTimer = setTimeout(() => {
      turnDoneTimer = null;
      void refresh();
    }, 1500);
  });

  // 待处理权限:记录 sessionId(响应后 turn 继续/结束 → turn-done 清除)
  window.kimi.onPermission((e) => {
    pendingPerms.set(e.requestId, e.sessionId);
    renderAll();
  });

  // ---------- Cmd+K 快速跳转 ----------
  // workbench index.ts 在 window 冒泡阶段绑了全局 Cmd+K → Command Center;
  // 这里在捕获阶段拦截:仅当 channel 页激活时接管,其余页面行为不变。
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && activePageId() === 'page-channel') {
        // 焦点在内嵌终端里时不接管(xterm 自行拦默认行为,事件也不应打开跳转浮层)
        if ((e.target as HTMLElement | null)?.closest?.(`.${P}-term-host`)) return;
        e.preventDefault();
        e.stopPropagation();
        openSwitcher();
      }
    },
    true,
  );

  interface Candidate {
    p: ChannelProject;
    s: ChannelSession;
    text: string; // 匹配源:项目名 + 标题 + lastMessage
  }

  let switcherEl: HTMLElement | null = null;

  function closeSwitcher(): void {
    switcherEl?.remove();
    switcherEl = null;
  }

  function openSwitcher(): void {
    if (switcherEl || !tree) return;
    const overlay = document.createElement('div');
    overlay.className = `${P}-switcher`;
    const box = document.createElement('div');
    box.className = `${P}-sw-box`;
    const input = document.createElement('input');
    input.className = `${P}-sw-input`;
    input.placeholder = '跳转:项目名 / 会话标题 / 消息内容… (Esc 关闭)';
    const list = document.createElement('div');
    list.className = `${P}-sw-list`;
    box.append(input, list);
    overlay.appendChild(box);
    page.appendChild(overlay);
    switcherEl = overlay;

    const candidates: Candidate[] = tree.projects.flatMap((p) =>
      p.sessions.map((s) => ({
        p,
        s,
        text: `${projectLabel(p)} ${s.title} ${s.lastPrompt} ${s.lastMessage}`.toLowerCase(),
      })),
    );

    let matches: Candidate[] = [];
    let selIdx = 0;

    const score = (c: Candidate, q: string): number => {
      // 简易模糊:所有词都出现即命中,项目名/标题前缀命中加分,越新越靠前
      const terms = q.split(/\s+/).filter(Boolean);
      if (!terms.every((t) => c.text.includes(t))) return -1;
      let sc = 0;
      const label = projectLabel(c.p).toLowerCase();
      const title = (c.s.title || '').toLowerCase();
      for (const t of terms) {
        if (label.startsWith(t)) sc += 30;
        else if (title.startsWith(t)) sc += 20;
        else if (label.includes(t) || title.includes(t)) sc += 10;
        else sc += 2;
      }
      return sc;
    };

    function renderList(): void {
      list.innerHTML = '';
      if (matches.length === 0) {
        const none = document.createElement('div');
        none.className = `${P}-sw-empty`;
        none.textContent = input.value.trim() ? '无匹配会话' : '输入以搜索…';
        list.appendChild(none);
        return;
      }
      matches.slice(0, 30).forEach((c, i) => {
        const item = document.createElement('div');
        item.className = `${P}-sw-item` + (i === selIdx ? ' selected' : '');
        const kind = document.createElement('span');
        kind.className = `${P}-sw-kind`;
        kind.textContent = projectLabel(c.p);
        const name = document.createElement('span');
        name.className = `${P}-sw-name`;
        name.textContent = sessionLabel(c.s);
        const desc = document.createElement('span');
        desc.className = `${P}-sw-desc`;
        desc.textContent = (c.s.lastMessage || c.s.lastPrompt || '').slice(0, 60);
        item.append(kind, name, desc);
        item.onclick = () => jump(c);
        list.appendChild(item);
      });
    }

    function applyFilter(): void {
      const q = input.value.trim().toLowerCase();
      matches = !q
        ? [...candidates].sort((a, b) => b.s.updatedAt - a.s.updatedAt)
        : candidates
            .map((c) => ({ c, sc: score(c, q) }))
            .filter((x) => x.sc >= 0)
            .sort((a, b) => b.sc - a.sc || b.c.s.updatedAt - a.c.s.updatedAt)
            .map((x) => x.c);
      selIdx = 0;
      renderList();
    }

    function jump(c: Candidate): void {
      manualCollapse.delete(projectKey(c.p));
      manualExpand.add(projectKey(c.p));
      closeSwitcher();
      selectSession(c.s.id);
      // 等重渲染后滚动到该行
      requestAnimationFrame(() => {
        treeEl.querySelector(`[data-sid="${c.s.id}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    }

    input.oninput = applyFilter;
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSwitcher();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        selIdx = Math.min(selIdx + 1, Math.min(matches.length, 30) - 1);
        renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selIdx = Math.max(selIdx - 1, 0);
        renderList();
      } else if (e.key === 'Enter' && matches[selIdx]) {
        jump(matches[selIdx]);
      }
    };
    overlay.onclick = (e) => {
      if (e.target === overlay) closeSwitcher();
    };

    applyFilter();
    input.focus();
  }

  // ---------- init ----------
  renderNewProj();
  // SUPER tab 任务详情「在 channel 中打开」:切到本页并选中该 session
  window.addEventListener('kimi:open-session-in-channel', (e) => {
    const sid = (e as CustomEvent<string>).detail;
    if (typeof sid === 'string' && sid) selectSession(sid);
  });
  // 常驻 agent 缓存:行内标识与「新建 session」选择器用,onChChanged 刷新复用
  void window.kimi.ch.agentList().then((list) => {
    agentList = list;
    agentById.clear();
    for (const a of list) agentById.set(a.id, a);
    renderTree();
  });
  void refresh();
}
