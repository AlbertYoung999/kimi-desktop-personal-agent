/**
 * SUPER 页(design/design-super-agent.md §8):Super Agent 分身的老板 UI。
 * 左栏 = 与 SA 直聊(createChatPanel 绑定 SA session,支持多开场景切换);
 * 右栏 = 任务看板(tasks.md 解析:待老板决策/进行中/待验收/已完成)+ 回执流(inbox/)。
 * 「待老板决策」栏是注意力契约核心入口,警示色高亮置顶。
 * 风格对齐 channel 页 holo 体系(.sa- 前缀;token 复用 #page-super 映射)。
 */

import { createChatPanel, type ChatPanelHandle } from '../../shared/chat-panel';
import { mdToHtml } from '../../shared/md';
import { activatePage } from '../core/nav';

const P = 'sa';

/** SUPER tab 激活时的绑定校准钩子(initSuperPage 装配;index.ts 的 nav 回调里调) */
export let syncSuperBinding: () => void = () => {};

interface SaSess {
  sessionId: string;
  title: string;
  main: boolean;
}

export function initSuperPage(): void {
  const page = document.getElementById('page-super')!;
  page.innerHTML = `
    <div class="${P}-root">
      <section class="${P}-chat">
        <div class="${P}-chat-head">
          <button class="${P}-sess-btn" id="${P}-sess-btn">Super Agent ▾</button>
        </div>
        <div class="${P}-panel-host" id="${P}-panel-host"></div>
      </section>
      <aside class="${P}-side">
        <div class="${P}-tabs">
          <button class="${P}-tab on" data-tab="board">任务看板</button>
          <button class="${P}-tab" data-tab="inbox">回执</button>
          <button class="${P}-tab" data-tab="settings">⚙ 设置</button>
        </div>
        <div class="${P}-body" id="${P}-board"></div>
        <div class="${P}-body hidden" id="${P}-inbox"></div>
        <div class="${P}-body hidden" id="${P}-settings"></div>
      </aside>
    </div>
    <div class="${P}-toast" id="${P}-toast"></div>`;

  const $ = <T extends HTMLElement>(sel: string) => page.querySelector(sel) as T;
  const sessBtn = $(`#${P}-sess-btn`) as HTMLButtonElement;
  const boardEl = $(`#${P}-board`);
  const inboxEl = $(`#${P}-inbox`);
  const settingsEl = $(`#${P}-settings`);
  const toastEl = $(`#${P}-toast`);

  let saSid = '';
  let panelBound = false; // 面板是否成功绑定过(首绑失败/SA 重建后需补绑)
  let activeTab: 'board' | 'inbox' | 'settings' = 'board';

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  // ---------- chat 面板(backend 缺省 Electron) ----------
  const panel: ChatPanelHandle = createChatPanel($(`#${P}-panel-host`), {
    getSessionId: () => saSid,
    onTitleChange: (title) => {
      sessBtn.textContent = `${title || 'Super Agent'} ▾`;
    },
  });

  // ---------- SA session 切换器 ----------
  let sessMenu: HTMLElement | null = null;

  function closeSessMenu(): void {
    sessMenu?.remove();
    sessMenu = null;
  }

  async function switchSaSession(sid: string): Promise<void> {
    saSid = sid;
    closeSessMenu();
    try {
      await panel.setSession(sid);
      panelBound = true;
    } catch {
      panelBound = false;
    }
  }

  async function openSessMenu(): Promise<void> {
    if (sessMenu) {
      closeSessMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = `${P}-sess-menu`;
    sessMenu = menu;
    const list = await window.kimi.sa.listSessions().catch(() => [] as SaSess[]);
    const mk = (label: string, on: boolean, onClick: () => void) => {
      const item = document.createElement('button');
      item.className = `${P}-menu-item` + (on ? ' on' : '');
      item.textContent = label;
      item.onclick = (ev) => {
        ev.stopPropagation();
        onClick();
      };
      menu.appendChild(item);
    };
    for (const s of list) {
      mk(s.title || s.sessionId.slice(0, 16), s.sessionId === saSid, () => void switchSaSession(s.sessionId));
    }
    const sep = document.createElement('div');
    sep.className = `${P}-menu-sep`;
    menu.appendChild(sep);
    mk('＋ 新分身场景', false, () => {
      closeSessMenu();
      void window.kimi.sa.createSession().then(async ({ sessionId }) => {
        toast('新分身场景已创建');
        await switchSaSession(sessionId);
      });
    });
    page.appendChild(menu);
  }

  sessBtn.onclick = (ev) => {
    ev.stopPropagation();
    void openSessMenu();
  };
  document.addEventListener('click', (e) => {
    if (sessMenu && !sessMenu.contains(e.target as Node)) closeSessMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSessMenu();
  });

  // ---------- 右栏 tabs ----------
  page.querySelectorAll(`.${P}-tab`).forEach((el) => {
    (el as HTMLButtonElement).onclick = () => {
      const tab = (el as HTMLElement).dataset.tab as 'board' | 'inbox' | 'settings';
      activeTab = tab;
      page.querySelectorAll(`.${P}-tab`).forEach((x) => x.classList.toggle('on', x === el));
      boardEl.classList.toggle('hidden', tab !== 'board');
      inboxEl.classList.toggle('hidden', tab !== 'inbox');
      settingsEl.classList.toggle('hidden', tab !== 'settings');
      if (tab === 'board') void renderBoard();
      else if (tab === 'inbox') void renderInbox();
      else void renderSettings();
      if (tab !== 'settings') stopPatrolTick(); // 相对时间重算只在设置 tab 跑
    };
  });

  // ---------- 任务看板(tasks.md 解析) ----------

  interface TaskCard {
    id: string;
    title: string;
    lines: string[];
  }
  interface BoardSection {
    key: 'decision' | 'doing' | 'review' | 'done';
    cards: TaskCard[];
  }

  const SECTION_ORDER: { key: BoardSection['key']; label: string; match: RegExp }[] = [
    { key: 'decision', label: '待老板决策', match: /待(老板|你)决策|决策/ },
    { key: 'doing', label: '进行中', match: /进行中/ },
    { key: 'review', label: '待验收', match: /待验收|验收/ },
    { key: 'done', label: '已完成', match: /已完成|完成/ },
  ];

  /**
   * 解析 tasks.md:## 分节 → 卡片(### 或 - 列表项);解析不出分节返回 null(退化全文渲染)。
   * 卡片首行格式兼容两种:`[taskId] goal —— <标题>(<sid12>)`(新)与 `[taskId] goal(sid12)`(旧);
   * 标题显示优先级:scan 映射的实时标题 > 行内标题 > sid12,goal 降级为副行保留。
   */
  function parseTasks(md: string, sidTitle: Map<string, string>): BoardSection[] | null {
    const sections: BoardSection[] = SECTION_ORDER.map((s) => ({ key: s.key, cards: [] }));
    const parts = md.split(/^##\s+/m).slice(1);
    if (parts.length === 0) return null;
    let matched = 0;
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const name = (nl > 0 ? part.slice(0, nl) : part).trim();
      const body = nl > 0 ? part.slice(nl + 1) : '';
      const order = SECTION_ORDER.find((s) => s.match.test(name));
      if (!order) continue;
      const sec = sections.find((s) => s.key === order.key)!;
      matched++;
      // 卡片:优先 ### 小节切分,其次 - 列表项,都没有则整节一张卡
      const sub = body.split(/^###\s+/m).slice(1);
      const rawCards: string[] =
        sub.length > 0
          ? sub
          : body
              .split(/^(?=-\s)/m)
              .map((x) => x.trim())
              .filter((x) => x.startsWith('- '));
      for (const raw of rawCards) {
        const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        const first = lines[0].replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1');
        const idMatch = first.match(/^\[([^\]]+)\]/) ?? raw.match(/task[_-]?id[:：]?\s*([A-Za-z0-9][\w-]*)/i);
        // 行尾括号里的 sid 前 12 位(两种格式共用)
        const sidMatch = first.match(/\(([\w-]{6,})\)\s*$/);
        const sid12 = sidMatch?.[1] ?? '';
        // 去掉 [taskId] 与行尾 (sid12) 后剩 goal;新格式按「——」再拆出行内标题
        let goal = first.replace(/^\[[^\]]+\]\s*/, '').replace(/\([\w-]{6,}\)\s*$/, '').trim();
        let inlineTitle = '';
        const dashIdx = goal.lastIndexOf('——');
        if (dashIdx >= 0) {
          inlineTitle = goal.slice(dashIdx + 2).trim();
          goal = goal.slice(0, dashIdx).trim();
        }
        const resolved = (sid12 && sidTitle.get(sid12)) || inlineTitle;
        const title = (resolved || goal || sid12).slice(0, 60);
        // 标题被解析成 session 名时,goal 降为副行首条;否则维持旧行为
        const cardLines = resolved && goal ? [goal, ...lines.slice(1)] : lines.slice(1);
        sec.cards.push({ id: idMatch?.[1] ?? '', title, lines: cardLines });
      }
    }
    return matched > 0 ? sections : null;
  }

  // ---------- 「待你决策」验收卡(P2,数据源 sa.listDecisions) ----------

  interface DecisionItem {
    taskId: string;
    goal: string;
    acceptance: string;
    status: string;
    rounds: number;
    sid: string;
    updatedAt: number;
    inboxPreview: string;
  }

  /** decision 栏(置顶,栏头数量徽标;空态友好) */
  function makeDecisionColumn(decisions: DecisionItem[]): HTMLElement {
    const col = document.createElement('div');
    col.className = `${P}-board-sec decision`;
    const head = document.createElement('div');
    head.className = `${P}-board-sec-head`;
    head.textContent = '待你决策 ';
    const badge = document.createElement('span');
    badge.className = `${P}-count`;
    badge.textContent = String(decisions.length);
    head.appendChild(badge);
    col.appendChild(head);
    if (decisions.length === 0) {
      const ok = document.createElement('div');
      ok.className = `${P}-board-ok`;
      ok.textContent = '✓ 没有等你拍板的事';
      col.appendChild(ok);
      return col;
    }
    for (const d of decisions) col.appendChild(makeDecisionCard(d));
    return col;
  }

  function statusBadge(status: string): HTMLElement {
    const b = document.createElement('span');
    const isDecision = status === 'decision';
    b.className = `${P}-status-badge` + (isDecision ? ' warn' : '');
    b.textContent = isDecision ? '需要你拍板' : 'SA 验收中';
    return b;
  }

  /** 验收卡:goal / task_id / status 标 / 打回轮次 / inboxPreview / ✓通过 ✗打回 */
  function makeDecisionCard(d: DecisionItem): HTMLElement {
    const el = document.createElement('div');
    el.className = `${P}-card ${P}-decision-card`;
    el.dataset.taskId = d.taskId;

    const goal = document.createElement('div');
    goal.className = `${P}-card-title ${P}-clamp2`;
    goal.textContent = d.goal;
    const meta = document.createElement('div');
    meta.className = `${P}-card-meta`;
    const id = document.createElement('span');
    id.className = `${P}-card-id`;
    id.textContent = d.taskId;
    meta.append(id, statusBadge(d.status));
    if (d.rounds > 0) {
      const rounds = document.createElement('span');
      rounds.className = `${P}-rounds`;
      rounds.textContent = `已打回 ${d.rounds} 轮`;
      meta.appendChild(rounds);
    }
    el.append(goal, meta);
    if (d.inboxPreview) {
      const preview = document.createElement('div');
      preview.className = `${P}-card-preview ${P}-clamp2`;
      preview.textContent = d.inboxPreview;
      el.appendChild(preview);
    }

    // 操作区
    const actions = document.createElement('div');
    actions.className = `${P}-card-actions`;
    const approve = document.createElement('button');
    approve.className = `${P}-act primary`;
    approve.textContent = '✓ 通过';
    const reject = document.createElement('button');
    reject.className = `${P}-act danger`;
    reject.textContent = '✗ 打回';
    actions.append(approve, reject);
    el.appendChild(actions);

    const setBusy = (busy: boolean) => {
      approve.disabled = busy;
      reject.disabled = busy;
    };
    /** 结果移出:折叠动画后刷新看板 */
    const dismiss = (msg: string) => {
      el.style.maxHeight = `${el.scrollHeight}px`;
      requestAnimationFrame(() => {
        el.classList.add('leaving');
        el.style.maxHeight = '0px';
      });
      toast(msg);
      setTimeout(() => void renderBoard(), 260);
    };

    approve.onclick = (ev) => {
      ev.stopPropagation();
      setBusy(true);
      void window.kimi.sa
        .reviewTask(d.taskId, 'approve')
        .then((r) => {
          if (r.ok) dismiss('已通过，任务落入已完成');
          else if (r.reason === 'worker-gone') toast('worker session 已不存在');
          else toast(`通过失败:${r.reason ?? '未知原因'}`);
        })
        .catch((err) => toast(`通过失败:${String(err)}`))
        .finally(() => setBusy(false));
    };
    reject.onclick = (ev) => {
      ev.stopPropagation();
      openRejectForm(el, d, actions, setBusy, dismiss);
    };
    // 点卡片(非按钮区)→ 任务详情
    el.onclick = () => void openTaskDetail(d.taskId);
    return el;
  }

  /** 打回内联意见框(Enter 提交;rounds-exceeded 时变「直接介入」提示) */
  function openRejectForm(
    card: HTMLElement,
    d: DecisionItem,
    actions: HTMLElement,
    setBusy: (busy: boolean) => void,
    dismiss: (msg: string) => void,
  ): void {
    actions.remove();
    const form = document.createElement('div');
    form.className = `${P}-reject-form`;
    const textarea = document.createElement('textarea');
    textarea.className = `${P}-reject-input`;
    textarea.placeholder = '告诉 worker 哪里不对、怎么改';
    textarea.rows = 3;
    const row = document.createElement('div');
    row.className = `${P}-card-actions`;
    const submit = document.createElement('button');
    submit.className = `${P}-act danger`;
    submit.textContent = '提交打回';
    const cancel = document.createElement('button');
    cancel.className = `${P}-act ghost`;
    cancel.textContent = '取消';
    row.append(submit, cancel);
    form.append(textarea, row);
    card.appendChild(form);
    textarea.focus();

    const close = () => {
      form.remove();
      card.appendChild(actions);
      maybeRefreshBoard(); // 打回表单关闭后补刷延后的看板
    };
    cancel.onclick = (ev) => {
      ev.stopPropagation();
      close();
    };
    const doSubmit = () => {
      const comment = textarea.value.trim();
      setBusy(true);
      submit.disabled = true;
      void window.kimi.sa
        .reviewTask(d.taskId, 'reject', comment || undefined)
        .then((r) => {
          if (r.ok) dismiss('已打回，worker 将收到修改意见');
          else if (r.reason === 'rounds-exceeded') {
            toast('已打回 3 轮，建议直接介入处理');
            form.innerHTML = '';
            const hint = document.createElement('div');
            hint.className = `${P}-reject-hint`;
            hint.textContent = '⚠ 该任务已多轮未过，建议直接在左侧与 SA 对话介入，或在 channel 中接管 worker。';
            form.appendChild(hint);
          } else if (r.reason === 'worker-gone') toast('worker session 已不存在');
          else toast(`打回失败:${r.reason ?? '未知原因'}`);
        })
        .catch((err) => toast(`打回失败:${String(err)}`))
        .finally(() => {
          setBusy(false);
          submit.disabled = false;
        });
    };
    submit.onclick = (ev) => {
      ev.stopPropagation();
      doSubmit();
    };
    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        doSubmit();
      }
      if (e.key === 'Escape') close();
    };
  }

  // ---------- 任务详情弹层(P2) ----------

  async function openTaskDetail(taskId: string): Promise<void> {
    const overlay = document.createElement('div');
    overlay.className = `${P}-modal`;
    const card = document.createElement('div');
    card.className = `${P}-modal-card ${P}-detail-card`;
    const head = document.createElement('div');
    head.className = `${P}-modal-head`;
    head.textContent = '加载中…';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.textContent = '×';
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      maybeRefreshBoard(); // 详情弹层关闭后补刷延后的看板
    };
    closeBtn.onclick = close;
    head.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = `${P}-modal-body`;
    card.append(head, body);
    overlay.appendChild(card);
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    page.appendChild(overlay);

    let data;
    try {
      data = await window.kimi.sa.taskDetail(taskId);
    } catch (err) {
      head.textContent = '任务详情';
      body.textContent = `读取失败:${String(err)}`;
      return;
    }
    if (!data) {
      head.textContent = '任务详情';
      body.innerHTML = '<div class="sa-hint">任务不存在或已完结。</div>';
      return;
    }
    const t = data.task;

    // 头部:goal + status 标 + task_id
    head.innerHTML = '';
    const goal = document.createElement('span');
    goal.className = `${P}-detail-goal`;
    goal.textContent = t.goal;
    head.append(goal, statusBadge(t.status), closeBtn);

    // 信息行
    const meta = document.createElement('div');
    meta.className = `${P}-detail-meta`;
    const chip = (text: string, cls = '') => {
      const c = document.createElement('span');
      c.className = `${P}-card-id ${cls}`;
      c.textContent = text;
      meta.appendChild(c);
    };
    chip(t.taskId);
    chip(`rounds ${t.rounds}`);
    chip(`创建 ${relTime(t.createdAt)}`);
    chip(`更新 ${relTime(t.updatedAt)}`);
    body.appendChild(meta);

    const blockLabel = (text: string) => {
      const l = document.createElement('div');
      l.className = `${P}-detail-label`;
      l.textContent = text;
      body.appendChild(l);
    };
    blockLabel('验收标准');
    const acc = document.createElement('div');
    acc.className = `${P}-detail-acc`;
    acc.textContent = t.acceptance || '(未填写)';
    body.appendChild(acc);
    if (t.lastVerdict) {
      blockLabel('最近验收意见');
      const verdict = document.createElement('blockquote');
      verdict.className = `${P}-detail-verdict`;
      verdict.textContent = t.lastVerdict;
      body.appendChild(verdict);
    }

    // 时间线(最新在上,竖线 + 圆点 + 相对时间)
    if (data.timeline.length > 0) {
      blockLabel('时间线');
      const tl = document.createElement('div');
      tl.className = `${P}-timeline`;
      const sorted = [...data.timeline].sort((a, b) => b.at - a.at);
      for (const item of sorted) {
        const row = document.createElement('div');
        row.className = `${P}-tl-row`;
        const dot = document.createElement('span');
        dot.className = `${P}-tl-dot`;
        const time = document.createElement('span');
        time.className = `${P}-tl-time`;
        time.textContent = relTime(item.at);
        const text = document.createElement('span');
        text.className = `${P}-tl-text`;
        text.textContent = item.text;
        row.append(dot, time, text);
        tl.appendChild(row);
      }
      body.appendChild(tl);
    }

    // 回执列表(点开全文)
    if (data.receipts.length > 0) {
      blockLabel('回执');
      for (const r of data.receipts) {
        const row = document.createElement('div');
        row.className = `${P}-inbox-row`;
        const rHead = document.createElement('div');
        rHead.className = `${P}-inbox-head`;
        const time = document.createElement('span');
        time.className = `${P}-inbox-time`;
        time.textContent = relTime(r.at);
        rHead.appendChild(time);
        const preview = document.createElement('div');
        preview.className = `${P}-inbox-preview`;
        preview.textContent = r.preview;
        row.append(rHead, preview);
        row.onclick = (ev) => {
          ev.stopPropagation();
          void openInboxModal(r.file, taskId);
        };
        body.appendChild(row);
      }
    }

    // 底部:worker sid + 「在 channel 中打开」
    const footer = document.createElement('div');
    footer.className = `${P}-detail-footer`;
    const sid = document.createElement('span');
    sid.className = `${P}-detail-sid`;
    sid.textContent = t.sid ? `worker: ${t.sid.slice(0, 20)}…` : 'worker 未关联 session';
    const openBtn = document.createElement('button');
    openBtn.className = `${P}-act primary`;
    openBtn.textContent = '在 channel 中打开 →';
    openBtn.disabled = !t.sid;
    openBtn.title = t.sid ? '' : '该任务没有关联的 worker session';
    openBtn.onclick = () => {
      close();
      activatePage('page-channel');
      window.dispatchEvent(new CustomEvent('kimi:open-session-in-channel', { detail: t.sid }));
    };
    footer.append(sid, openBtn);
    body.appendChild(footer);
  }

  // ---------- 看板视图切换(按状态 / 按 session,localStorage 记忆) ----------

  interface SaTask {
    taskId: string;
    sid: string;
    title: string; // session 标题
    goal: string;
    acceptance: string;
    status: 'in_progress' | 'review' | 'decision' | 'watching' | 'done';
    rounds: number;
    createdAt: number;
    updatedAt: number;
    lastVerdict?: string | null;
  }

  const BOARD_VIEW_KEY = 'kimi-sa-board-view';
  let boardView: 'status' | 'session' =
    localStorage.getItem(BOARD_VIEW_KEY) === 'session' ? 'session' : 'status';
  const doneOpen = new Set<string>(); // 按 session 视图:每组「已完成 N」展开态(内存级)
  let deferredBoardRefresh = false; // 详情弹层/打回表单开着时不打断,关闭后补刷

  /** 有弹层或打回表单在编辑 → 看板刷新延后 */
  function boardBusy(): boolean {
    return !!page.querySelector(`.${P}-modal, .${P}-reject-form`);
  }
  function maybeRefreshBoard(): void {
    if (!deferredBoardRefresh || boardBusy()) return;
    deferredBoardRefresh = false;
    if (activeTab === 'board') void renderBoard();
  }

  /** 任务 status 标(按 session 视图与「观察中」区分用) */
  function taskStatusBadge(status: SaTask['status']): HTMLElement {
    const MAP: Record<string, [string, string]> = {
      in_progress: ['进行中', 'run'],
      review: ['SA 验收中', ''],
      decision: ['需要你拍板', 'warn'],
      watching: ['观察中', 'muted'],
      done: ['已完成', 'muted'],
    };
    const [label, cls] = MAP[status] ?? [status, 'muted'];
    const b = document.createElement('span');
    b.className = `${P}-status-badge ${cls}`.trim();
    b.textContent = label;
    return b;
  }

  /** 结构化任务卡(session 视图用;decision/review 态复用验收卡的操作区) */
  function makeTaskCard(t: SaTask): HTMLElement {
    if (t.status === 'decision' || t.status === 'review') {
      // 验收操作两个视图都可用:构造 DecisionItem 复用验收卡(inboxPreview 没有则空)
      return makeDecisionCard({
        taskId: t.taskId,
        goal: t.goal,
        acceptance: t.acceptance,
        status: t.status,
        rounds: t.rounds,
        sid: t.sid,
        updatedAt: t.updatedAt,
        inboxPreview: '',
      });
    }
    const el = document.createElement('div');
    el.className = `${P}-card ${P}-card-link`;
    const title = document.createElement('div');
    title.className = `${P}-card-title ${P}-clamp2`;
    title.textContent = t.title || t.goal || t.taskId;
    const id = document.createElement('span');
    id.className = `${P}-card-id`;
    id.textContent = t.taskId;
    title.appendChild(id);
    const meta = document.createElement('div');
    meta.className = `${P}-card-meta`;
    meta.appendChild(taskStatusBadge(t.status));
    if (t.rounds > 0) {
      const rounds = document.createElement('span');
      rounds.className = `${P}-rounds`;
      rounds.textContent = `已打回 ${t.rounds} 轮`;
      meta.appendChild(rounds);
    }
    el.append(title, meta);
    if (t.goal && t.goal !== t.title) {
      const line = document.createElement('div');
      line.className = `${P}-card-line`;
      line.textContent = t.goal;
      el.appendChild(line);
    }
    el.onclick = () => void openTaskDetail(t.taskId);
    return el;
  }

  /** 按 session 分组视图:hot(含 decision/review)组在前,其余按最近更新;done 收底部折叠 */
  function renderSessionView(tasks: SaTask[]): void {
    const groups = new Map<string, SaTask[]>();
    for (const t of tasks) {
      const key = t.sid || `(无 session)·${t.taskId}`;
      const list = groups.get(key) ?? [];
      list.push(t);
      groups.set(key, list);
    }
    const ordered = [...groups.values()]
      .map((list) => ({
        list,
        latest: Math.max(...list.map((t) => t.updatedAt)),
        hot: list.some((t) => t.status === 'decision' || t.status === 'review'),
      }))
      .sort((a, b) => Number(b.hot) - Number(a.hot) || b.latest - a.latest);

    if (ordered.length === 0) {
      boardEl.innerHTML = '<div class="sa-hint">还没有任务,去左侧跟 SA 说点什么。</div>';
      return;
    }
    for (const g of ordered) {
      const first = g.list[0];
      const sec = document.createElement('div');
      sec.className = `${P}-board-sec` + (g.hot ? ' decision' : '');
      const head = document.createElement('div');
      head.className = `${P}-sess-head`;
      const name = document.createElement('span');
      name.className = `${P}-sess-name`;
      name.textContent = first.title || first.sid.slice(0, 12) || '(无 session)';
      head.appendChild(name);
      if (first.sid) {
        const sid = document.createElement('span');
        sid.className = `${P}-card-id`;
        sid.textContent = first.sid.slice(0, 12);
        head.appendChild(sid);
      }
      const count = document.createElement('span');
      count.className = `${P}-count`;
      count.textContent = String(g.list.length);
      head.appendChild(count);
      if (first.sid) {
        const open = document.createElement('button');
        open.className = `${P}-sess-open`;
        open.textContent = '在 channel 打开 ↗';
        open.onclick = () => {
          activatePage('page-channel');
          window.dispatchEvent(new CustomEvent('kimi:open-session-in-channel', { detail: first.sid }));
        };
        head.appendChild(open);
      }
      sec.appendChild(head);

      const active = g.list.filter((t) => t.status !== 'done');
      const done = g.list.filter((t) => t.status === 'done');
      for (const t of active) sec.appendChild(makeTaskCard(t));
      if (done.length > 0) {
        const key = first.sid || first.taskId;
        const toggle = document.createElement('button');
        toggle.className = `${P}-done-toggle`;
        const open = doneOpen.has(key);
        toggle.textContent = `${open ? '▼' : '▸'} 已完成 ${done.length}`;
        const doneBox = document.createElement('div');
        doneBox.style.display = open ? '' : 'none';
        for (const t of done) doneBox.appendChild(makeTaskCard(t));
        toggle.onclick = () => {
          if (doneOpen.has(key)) doneOpen.delete(key);
          else doneOpen.add(key);
          toggle.textContent = `${doneOpen.has(key) ? '▼' : '▸'} 已完成 ${done.length}`;
          doneBox.style.display = doneOpen.has(key) ? '' : 'none';
        };
        sec.append(toggle, doneBox);
      }
      boardEl.appendChild(sec);
    }
  }

  /** 按状态视图(listTasks 数据源):decision 置顶警示,watching 归入进行中带「观察」标 */
  function renderStatusView(tasks: SaTask[], decisions: DecisionItem[] | null): void {
    const decisionItems =
      decisions ??
      tasks
        .filter((t) => t.status === 'decision' || t.status === 'review')
        .map((t) => ({
          taskId: t.taskId,
          goal: t.goal,
          acceptance: t.acceptance,
          status: t.status,
          rounds: t.rounds,
          sid: t.sid,
          updatedAt: t.updatedAt,
          inboxPreview: '',
        }));
    const decisionIds = new Set(decisionItems.map((d) => d.taskId));
    boardEl.appendChild(makeDecisionColumn(decisionItems));

    const cols: { key: string; label: string; list: SaTask[] }[] = [
      {
        key: 'doing',
        label: '进行中',
        list: tasks.filter((t) => (t.status === 'in_progress' || t.status === 'watching') && !decisionIds.has(t.taskId)),
      },
      { key: 'review', label: '待验收', list: tasks.filter((t) => t.status === 'review' && !decisionIds.has(t.taskId)) },
      { key: 'done', label: '已完成', list: tasks.filter((t) => t.status === 'done' && !decisionIds.has(t.taskId)) },
    ];
    for (const c of cols) {
      const col = document.createElement('div');
      col.className = `${P}-board-sec`;
      const head = document.createElement('div');
      head.className = `${P}-board-sec-head`;
      head.textContent = `${c.label} (${c.list.length})`;
      col.appendChild(head);
      for (const t of c.list) col.appendChild(makeTaskCard(t));
      boardEl.appendChild(col);
    }
  }

  /** 视图分段切换器(看板顶部,localStorage 记忆) */
  function renderViewSeg(): HTMLElement {
    const seg = document.createElement('div');
    seg.className = `${P}-board-seg`;
    for (const { v, label } of [
      { v: 'status', label: '按状态' },
      { v: 'session', label: '按 session' },
    ] as const) {
      const b = document.createElement('button');
      b.className = `${P}-seg-btn` + (boardView === v ? ' on' : '');
      b.textContent = label;
      b.onclick = () => {
        if (boardView === v) return;
        boardView = v;
        localStorage.setItem(BOARD_VIEW_KEY, v);
        void renderBoard();
      };
      seg.appendChild(b);
    }
    return seg;
  }

  async function renderBoard(): Promise<void> {
    boardEl.innerHTML = '<div class="sa-hint">加载中…</div>';
    // 并行:listTasks(结构化主数据源)+ listDecisions(待你决策栏,带 inboxPreview)+
    // readTasks + ch.scan(均服务 tasks.md 兜底路径)
    const [tasks, decisions, tasksRes, scan] = await Promise.all([
      window.kimi.sa.listTasks().catch(() => null as SaTask[] | null),
      window.kimi.sa.listDecisions().catch(() => null as DecisionItem[] | null),
      window.kimi.sa.readTasks().catch(() => null as { content: string } | null),
      window.kimi.ch.scan().catch(() => null), // scan 失败不影响看板(退回行内标题/sid12)
    ]);
    // sid 前 12 位 → 实时标题(title → lastPrompt 回退;空串不收录,自然落到行内标题/sid12)
    const sidTitle = new Map<string, string>();
    if (scan) {
      for (const p of scan.projects) {
        for (const s of p.sessions) {
          const k = s.id.slice(0, 12);
          const t = s.title || s.lastPrompt?.slice(0, 30) || '';
          if (t && !sidTitle.has(k)) sidTitle.set(k, t);
        }
      }
    }
    boardEl.innerHTML = '';
    boardEl.appendChild(renderViewSeg());

    // 主路径:listTasks 结构化数据
    if (tasks !== null) {
      if (boardView === 'session') renderSessionView(tasks);
      else renderStatusView(tasks, decisions);
      return;
    }

    // 兜底:tasks.md 解析(listTasks 失败时)
    const content = tasksRes?.content ?? '';
    const sections = content.trim() ? parseTasks(content, sidTitle) : null;

    // tasks.md 空 + 无决策项 → 引导空态
    if (!sections && (!decisions || decisions.length === 0)) {
      if (!content.trim() && tasksRes) {
        boardEl.innerHTML = '';
        boardEl.appendChild(renderViewSeg());
        boardEl.insertAdjacentHTML('beforeend', '<div class="sa-hint">tasks.md 还没有任务,去左侧跟 SA 说点什么。</div>');
        return;
      }
      if (!sections) {
        const all = document.createElement('div');
        all.className = `${P}-board-md`;
        all.innerHTML = mdToHtml(content);
        boardEl.appendChild(all);
        return;
      }
    }

    for (const sec of sections ?? []) {
      // decision 栏:API 数据源优先(listDecisions 失败回退 tasks.md 解析)
      if (sec.key === 'decision' && decisions !== null) {
        boardEl.appendChild(makeDecisionColumn(decisions));
        continue;
      }
      const label = SECTION_ORDER.find((s) => s.key === sec.key)!.label;
      const col = document.createElement('div');
      col.className = `${P}-board-sec` + (sec.key === 'decision' ? ' decision' : '');
      const head = document.createElement('div');
      head.className = `${P}-board-sec-head`;
      head.textContent = `${label} (${sec.cards.length})`;
      col.appendChild(head);
      if (sec.cards.length === 0 && sec.key === 'decision') {
        const ok = document.createElement('div');
        ok.className = `${P}-board-ok`;
        ok.textContent = '✓ 没有等你拍板的事';
        col.appendChild(ok);
      }
      for (const card of sec.cards) {
        col.appendChild(makeBoardCard(card));
      }
      boardEl.appendChild(col);
    }
  }

  /** 普通看板卡(tasks.md 解析;有 task_id 可点开详情) */
  function makeBoardCard(card: TaskCard): HTMLElement {
    const el = document.createElement('div');
    el.className = `${P}-card` + (card.id ? ` ${P}-card-link` : '');
    const title = document.createElement('div');
    title.className = `${P}-card-title`;
    title.textContent = card.title;
    el.appendChild(title);
    if (card.id) {
      const id = document.createElement('span');
      id.className = `${P}-card-id`;
      id.textContent = card.id;
      title.appendChild(id);
    }
    for (const line of card.lines.slice(0, 4)) {
      const li = document.createElement('div');
      li.className = `${P}-card-line`;
      li.textContent = line;
      el.appendChild(li);
    }
    if (card.id) el.onclick = () => void openTaskDetail(card.id);
    return el;
  }

  // ---------- 回执流 ----------

  function relTime(ts: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
    return `${Math.floor(diff / 86400_000)}天前`;
  }

  async function renderInbox(): Promise<void> {
    inboxEl.innerHTML = '<div class="sa-hint">加载中…</div>';
    let items: { file: string; taskId: string; at: number; preview: string }[] = [];
    try {
      items = await window.kimi.sa.listInbox();
    } catch (err) {
      inboxEl.innerHTML = `<div class="sa-hint">回执读取失败:${String(err)}</div>`;
      return;
    }
    inboxEl.innerHTML = '';
    if (items.length === 0) {
      inboxEl.innerHTML = '<div class="sa-hint">还没有回执。worker 完成任务后会投到 inbox/。</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = `${P}-inbox-row`;
      const head = document.createElement('div');
      head.className = `${P}-inbox-head`;
      const id = document.createElement('span');
      id.className = `${P}-inbox-id`;
      id.textContent = it.taskId || '(无 taskId)';
      const time = document.createElement('span');
      time.className = `${P}-inbox-time`;
      time.textContent = relTime(it.at);
      head.append(id, time);
      const preview = document.createElement('div');
      preview.className = `${P}-inbox-preview`;
      preview.textContent = it.preview;
      row.append(head, preview);
      row.onclick = () => {
        // 有 taskId 进任务详情(P2),否则直接看回执全文
        if (it.taskId) void openTaskDetail(it.taskId);
        else void openInboxModal(it.file, it.taskId);
      };
      inboxEl.appendChild(row);
    }
  }

  async function openInboxModal(file: string, taskId: string): Promise<void> {
    const overlay = document.createElement('div');
    overlay.className = `${P}-modal`;
    const card = document.createElement('div');
    card.className = `${P}-modal-card`;
    const head = document.createElement('div');
    head.className = `${P}-modal-head`;
    head.textContent = `回执 · ${taskId || file}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'icon-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => {
      overlay.remove();
      maybeRefreshBoard();
    };
    head.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = `${P}-modal-body`;
    body.textContent = '加载中…';
    card.append(head, body);
    overlay.appendChild(card);
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        overlay.remove();
        maybeRefreshBoard();
      }
    };
    page.appendChild(overlay);
    try {
      const { content } = await window.kimi.sa.readInbox(file);
      body.innerHTML = mdToHtml(content ?? '(回执文件已被清理)');
    } catch (err) {
      body.textContent = `读取失败:${String(err)}`;
    }
  }

  // ---------- 设置(巡逻配置) ----------

  interface PatrolConfig {
    enabled: boolean;
    intervalMin: number;
    lastRunAt: number | null;
    nextRunAt: number | null;
  }
  let patrol: PatrolConfig | null = null;
  let patrolTick: ReturnType<typeof setInterval> | null = null; // 相对时间重算(仅设置 tab 激活时跑)
  let customInterval = false; // 「自定义」项展开态
  let patrolRunning = false;

  const INTERVAL_CHOICES = [30, 60, 120, 240]; // 30分钟/1小时/2小时/4小时

  function fmtInterval(min: number): string {
    return min % 60 === 0 ? `${min / 60}小时` : `${min}分钟`;
  }
  /** 过去 → x前;未来 → x后;null → fallback */
  function relWhen(ts: number | null, fallback: string): string {
    if (!ts) return fallback;
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const unit =
      abs < 3600_000 ? `${Math.max(1, Math.round(abs / 60_000))}分钟` : abs < 86400_000 ? `${Math.floor(abs / 3600_000)}小时` : `${Math.floor(abs / 86400_000)}天`;
    return diff >= 0 ? `${unit}后` : `${unit}前`;
  }

  function stopPatrolTick(): void {
    if (patrolTick) clearInterval(patrolTick);
    patrolTick = null;
  }

  async function renderSettings(): Promise<void> {
    // 「分身文件」编辑视图(页内切换,不开新窗)
    if (editingFile) {
      renderFileEditor(editingFile);
      return;
    }
    settingsEl.innerHTML = `
      <div class="${P}-set-card">
        <div class="${P}-set-row">
          <div class="${P}-set-titlebox">
            <div class="${P}-set-title">定时巡逻</div>
            <div class="${P}-set-sub">SA 定期醒来检查在途任务与托管 session</div>
          </div>
          <label class="${P}-switch" title="开/关巡逻">
            <input type="checkbox" id="${P}-patrol-enabled" />
            <i></i>
          </label>
        </div>
        <div class="${P}-set-label">巡逻间隔</div>
        <div class="${P}-capsules" id="${P}-capsules"></div>
        <div class="${P}-set-status" id="${P}-patrol-status">…</div>
        <button class="${P}-run-btn" id="${P}-run-now">立即巡逻一次</button>
      </div>
      <div class="${P}-set-card" style="margin-top:12px">
        <div class="${P}-set-title" style="margin-bottom:8px">分身文件</div>
        <div id="${P}-files"></div>
      </div>`;
    renderFileRows();

    // toggle:即时生效,不乐观(以返回为准)
    const enabledCb = $(`#${P}-patrol-enabled`) as unknown as HTMLInputElement;
    enabledCb.onchange = () => {
      void window.kimi.sa
        .setPatrolConfig({ enabled: enabledCb.checked })
        .then((cfg) => {
          patrol = cfg;
          syncSettings();
        })
        .catch((err) => {
          enabledCb.checked = !enabledCb.checked; // 失败回滚显示
          toast(`设置失败:${String(err)}`);
        });
    };

    // 立即巡逻
    const runBtn = $(`#${P}-run-now`) as HTMLButtonElement;
    runBtn.onclick = () => {
      if (patrolRunning) return;
      patrolRunning = true;
      runBtn.disabled = true;
      runBtn.textContent = '巡逻中…';
      void window.kimi.sa
        .runPatrolNow()
        .then((r) => {
          if (r.ok) toast('已触发');
          else toast('SA 正在忙，稍后再试');
          return window.kimi.sa.getPatrolConfig();
        })
        .then((cfg) => {
          patrol = cfg;
          syncSettings();
        })
        .catch((err) => toast(`触发失败:${String(err)}`))
        .finally(() => {
          patrolRunning = false;
          runBtn.disabled = false;
          runBtn.textContent = '立即巡逻一次';
        });
    };

    try {
      patrol = await window.kimi.sa.getPatrolConfig();
    } catch (err) {
      settingsEl.innerHTML = `<div class="sa-hint">巡逻配置读取失败:${String(err)}</div>`;
      return;
    }
    syncSettings();
    // 相对时间每分钟重算(仅本 tab 激活期间)
    stopPatrolTick();
    patrolTick = setInterval(() => {
      if (activeTab === 'settings' && !editingFile) syncStatusLine();
    }, 60_000);
  }

  // ---------- 分身文件(agents.md / memory.md / learning.md / tasks.md) ----------

  const SA_FILES = [
    { name: 'agents.md', icon: '🪪', purpose: 'SA 的身份、能力与边界' },
    { name: 'memory.md', icon: '🧠', purpose: '长期记忆' },
    { name: 'learning.md', icon: '📈', purpose: '进化学习记录' },
    { name: 'tasks.md', icon: '📋', purpose: '任务看板数据源' },
  ] as const;
  let editingFile: string | null = null;
  /** 契约无 mtime:只显示本会话内我们自己保存的时间,否则「—」 */
  const fileSavedAt = new Map<string, number>();

  function renderFileRows(): void {
    const box = $(`#${P}-files`);
    box.innerHTML = '';
    for (const f of SA_FILES) {
      const row = document.createElement('button');
      row.className = `${P}-file-row`;
      const icon = document.createElement('span');
      icon.className = `${P}-file-icon`;
      icon.textContent = f.icon;
      const main = document.createElement('span');
      main.className = `${P}-file-main`;
      const name = document.createElement('span');
      name.className = `${P}-file-name`;
      name.textContent = f.name;
      const purpose = document.createElement('span');
      purpose.className = `${P}-file-purpose`;
      purpose.textContent = f.purpose;
      main.append(name, purpose);
      const mtime = document.createElement('span');
      mtime.className = `${P}-file-mtime`;
      const saved = fileSavedAt.get(f.name);
      mtime.textContent = saved ? relTime(saved) : '—';
      mtime.title = saved ? '本会话内最近保存' : '';
      row.append(icon, main, mtime);
      row.onclick = () => {
        editingFile = f.name;
        renderSettings();
      };
      box.appendChild(row);
      // 探测存在性:读取失败 → 「未创建」置灰不可点
      void window.kimi.sa
        .readFile(f.name)
        .then(() => undefined)
        .catch(() => {
          row.classList.add('missing');
          row.disabled = true;
          row.onclick = null;
          mtime.textContent = '未创建';
          mtime.title = '';
        });
    }
  }

  const FILE_HINTS: Record<string, string> = {
    'tasks.md': '看板数据源之一，SA 也在用，注意格式',
    'agents.md': '改的是 SA 的身份与边界，即时生效于其后续对话',
  };

  /** 文件编辑视图(页内):大 textarea + 防抖 1s 自动保存 + 失焦保存 */
  function renderFileEditor(name: string): void {
    const meta = SA_FILES.find((f) => f.name === name)!;
    settingsEl.innerHTML = `
      <div class="${P}-editor-wrap">
        <div class="${P}-editor-head">
          <button class="${P}-file-back" id="${P}-file-back">‹ 返回</button>
          <span class="${P}-editor-name">${meta.icon} ${name}</span>
          <span class="${P}-editor-status" id="${P}-file-status">加载中…</span>
        </div>
        <textarea class="${P}-editor" id="${P}-file-editor" spellcheck="false"></textarea>
        ${FILE_HINTS[name] ? `<div class="${P}-editor-hint">${FILE_HINTS[name]}</div>` : ''}
      </div>`;

    const editor = $(`#${P}-file-editor`) as unknown as HTMLTextAreaElement;
    const status = $(`#${P}-file-status`);
    let dirty = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      status.textContent = '保存中…';
      void window.kimi.sa
        .writeFile(name, editor.value)
        .then(() => {
          fileSavedAt.set(name, Date.now());
          status.textContent = `已保存 ✓ ${new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
          if (name === 'tasks.md') void renderBoard(); // 看板数据源被改,看板跟上
        })
        .catch((err) => {
          dirty = true; // 失败恢复脏标,下次继续尝试
          status.textContent = `保存失败:${String(err)}`;
        });
    };
    editor.addEventListener('input', () => {
      dirty = true;
      status.textContent = '…';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 1000);
    });
    editor.addEventListener('blur', flush);

    ($(`#${P}-file-back`) as HTMLButtonElement).onclick = () => {
      flush();
      editingFile = null;
      void renderSettings();
    };

    void window.kimi.sa
      .readFile(name)
      .then(({ content }) => {
        editor.value = content;
        status.textContent = '';
        editor.focus();
      })
      .catch((err) => {
        status.textContent = `读取失败:${String(err)}`;
        editor.disabled = true;
      });
  }

  /** 全量同步(初始/每次 setPatrolConfig 返回后;不乐观,全部以返回为准) */
  function syncSettings(): void {
    if (!patrol) return;
    const enabledCb = $(`#${P}-patrol-enabled`) as unknown as HTMLInputElement;
    enabledCb.checked = patrol.enabled;
    enabledCb.parentElement!.classList.toggle('on', patrol.enabled);
    renderCapsules();
    syncStatusLine();
  }

  function syncStatusLine(): void {
    if (!patrol) return;
    const statusEl = $(`#${P}-patrol-status`);
    const last = `上次巡逻 · ${relWhen(patrol.lastRunAt, '从未')}`;
    const next = patrol.enabled ? `下次巡逻 · ${relWhen(patrol.nextRunAt, '待调度')}` : '下次巡逻 · 已暂停';
    statusEl.textContent = `${last}　·　${next}`;
  }

  function renderCapsules(): void {
    if (!patrol) return;
    const box = $(`#${P}-capsules`);
    box.innerHTML = '';
    const isPreset = INTERVAL_CHOICES.includes(patrol.intervalMin);
    if (isPreset) customInterval = false;
    for (const min of INTERVAL_CHOICES) {
      const cap = document.createElement('button');
      cap.className = `${P}-capsule` + (patrol.intervalMin === min ? ' on' : '');
      cap.textContent = fmtInterval(min);
      cap.onclick = () => {
        if (patrol!.intervalMin === min) return;
        void window.kimi.sa.setPatrolConfig({ intervalMin: min }).then((cfg) => {
          patrol = cfg;
          syncSettings();
        });
      };
      box.appendChild(cap);
    }
    // 自定义:展开内联数字输入(分钟,5~1440;失焦/回车提交,非法红边不提交)
    const custom = document.createElement('button');
    custom.className = `${P}-capsule` + (!isPreset || customInterval ? ' on' : '');
    custom.textContent = isPreset ? '自定义' : `自定义 · ${patrol.intervalMin}分钟`;
    custom.onclick = () => {
      customInterval = true;
      renderCapsules();
    };
    box.appendChild(custom);
    if (customInterval || !isPreset) {
      const input = document.createElement('input');
      input.className = `${P}-capsule-input`;
      input.type = 'number';
      input.min = '5';
      input.max = '1440';
      input.placeholder = '分钟';
      input.value = String(patrol.intervalMin);
      const submit = () => {
        const v = Math.round(Number(input.value));
        if (!Number.isFinite(v) || v < 5 || v > 1440) {
          input.classList.add('invalid'); // 非法值红边提示,不提交
          return;
        }
        input.classList.remove('invalid');
        if (v === patrol!.intervalMin) return;
        void window.kimi.sa.setPatrolConfig({ intervalMin: v }).then((cfg) => {
          patrol = cfg;
          customInterval = false;
          syncSettings();
          toast(`巡逻间隔已设为 ${fmtInterval(v)}`);
        });
      };
      input.onblur = submit;
      input.onkeydown = (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') {
          customInterval = false;
          renderCapsules();
        }
      };
      box.appendChild(input);
      if (customInterval && isPreset) input.focus();
    }
  }

  // ---------- 事件 ----------

  window.kimi.onSaEvent((e) => {
    if (e.kind === 'inbox') {
      toast(`📨 新回执:${e.taskId}`);
      if (activeTab === 'inbox') void renderInbox();
      else void renderBoard(); // 回执通常伴随验收状态变化
    } else if (e.kind === 'patrol') {
      // 巡逻执行后刷新 last/next(顺带看板,巡逻可能改状态)
      void window.kimi.sa.getPatrolConfig().then((cfg) => {
        patrol = cfg;
        if (activeTab === 'settings') syncSettings();
      });
      if (activeTab === 'board') void renderBoard();
    } else if (e.kind === 'decision') {
      toast('🔔 SA 需要你拍板');
      if (activeTab === 'board') void renderBoard();
    } else if (e.kind === 'tasks') {
      // 任何任务变更都刷新看板;详情弹层/打回表单开着时不打断,关闭后补刷
      if (boardBusy()) deferredBoardRefresh = true;
      else if (activeTab === 'board') void renderBoard();
    }
  });

  // ---------- init ----------

  /**
   * 绑定校准(SUPER tab 激活时由 nav 回调触发,见 index.ts):
   * SA session 可能被重建(跨重启 resume 失败)或多开切换——settings.superSessionId 变了,
   * 而面板绑定是启动时一次性的,不重绑就会被工厂的 onChunk sid 过滤丢光事件
   * (channel 有回复、SUPER 没有的根因)。首绑失败也在这里补绑。
   */
  async function syncBinding(): Promise<void> {
    try {
      const { sessionId } = await window.kimi.sa.getSession();
      if (sessionId !== saSid) {
        saSid = sessionId;
        await panel.setSession(sessionId);
        panelBound = true;
        toast('SA 已重建/切换，面板已重绑');
      } else if (!panelBound) {
        await panel.setSession(sessionId); // 首绑失败后的补绑
        panelBound = true;
      }
    } catch {
      panelBound = false; // SA 未就绪,下次激活再试
    }
  }
  syncSuperBinding = syncBinding;

  void window.kimi.sa
    .getSession()
    .then(({ sessionId }) => {
      saSid = sessionId;
      return panel.setSession(sessionId);
    })
    .then(() => {
      panelBound = true;
    })
    .catch(() => {
      panelBound = false; // 静默,激活时 syncBinding 补绑
    });
  void renderBoard();
}
