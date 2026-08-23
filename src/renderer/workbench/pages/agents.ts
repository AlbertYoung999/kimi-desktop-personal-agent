/**
 * Agents 页（V4-C，替换 pages/placeholder.ts 占位）：
 * - Agent 设定：workspace AGENTS.md 编辑器（保存后新会话生效）
 * - 长期记忆：memory.md 查看 / 编辑（wb.memoryRead / memoryWrite）
 * - 声音：中 / 英 TTS 声音 + 语速 + 试听（ttsVoices / ttsSetVoice / ttsPreview）
 * - 工具：workbench MCP 工具开关（wb.toolsList / toolToggle）
 * - 权限模式：default / auto / yolo（setSettings）
 * - 反应回路：focusSpeak / radarCard / overdueNotify（settings.triggers，缺省视为开）
 * - 数据：立即备份（wb.runBackup）
 * 左侧分栏锚点导航 + 右侧滚动分区，样式注入 <style>，类名 wf-agents- 前缀。
 */

import type { AppSettings } from '../../../shared/types';

const P = 'wf-agents'; // class prefix

function injectStyle(): void {
  if (document.getElementById(`${P}-style`)) return;
  const style = document.createElement('style');
  style.id = `${P}-style`;
  style.textContent = `
    .${P} { display: flex; flex: 1; min-height: 0; min-width: 0; }

    /* 左侧分栏导航 */
    .${P}-nav {
      width: 148px; flex-shrink: 0; padding: 22px 12px; display: flex; flex-direction: column; gap: 4px;
      border-right: 1px solid var(--glass-border); overflow-y: auto;
    }
    .${P}-nav-item {
      font-family: var(--mono); font-size: 11px; letter-spacing: 1px; text-align: left;
      color: var(--muted); background: none; border: 1px solid transparent;
      border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: all 150ms;
    }
    .${P}-nav-item:hover { color: var(--neon); }
    .${P}-nav-item.on {
      color: var(--neon); border-color: var(--glass-border);
      background: var(--glass-bg); text-shadow: 0 0 8px rgba(0, 240, 255, 0.5);
    }

    /* 右侧滚动分区 */
    .${P}-body { flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px 60px; scroll-behavior: smooth; }
    .${P}-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
    .${P}-title { font-family: var(--mono); font-size: 18px; letter-spacing: 4px; color: var(--fg); text-shadow: 0 0 14px rgba(0, 240, 255, 0.35); }
    .${P}-sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: 1px; color: var(--muted); }

    .${P}-section { margin-bottom: 26px; scroll-margin-top: 12px; }
    .${P}-section > .section-title { font-family: var(--mono); font-size: 11px; letter-spacing: 2px; color: var(--neon); opacity: 0.8; margin-bottom: 8px; }
    .${P}-panel {
      background: var(--glass-bg); backdrop-filter: var(--glass-blur);
      border: 1px solid var(--glass-border); border-radius: 12px; padding: 14px 16px;
    }
    .${P}-hint { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-top: 8px; letter-spacing: 0.5px; }

    .${P}-editor {
      width: 100%; min-height: 180px; resize: vertical; box-sizing: border-box;
      font-family: var(--mono); font-size: 12px; line-height: 1.6;
      color: var(--fg); background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--glass-border); border-radius: 8px; padding: 10px 12px; outline: none;
    }
    .${P}-editor:focus { border-color: var(--border-strong); }

    .${P}-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .${P}-row + .${P}-row { margin-top: 10px; }
    .${P}-label { font-family: var(--mono); font-size: 11px; letter-spacing: 1px; color: var(--muted); width: 64px; flex-shrink: 0; }

    .${P}-btn {
      font-family: var(--mono); font-size: 11px; letter-spacing: 1px; cursor: pointer;
      color: var(--muted); background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--glass-border); border-radius: 8px; padding: 6px 14px; transition: all 150ms;
    }
    .${P}-btn:hover { color: var(--neon); border-color: var(--border-strong); }
    .${P}-btn.primary { color: var(--neon); border-color: var(--border-strong); }
    .${P}-btn:disabled { opacity: 0.45; cursor: default; }

    .${P}-seg { display: inline-flex; border: 1px solid var(--glass-border); border-radius: 8px; overflow: hidden; }
    .${P}-seg button {
      font-family: var(--mono); font-size: 11px; letter-spacing: 1px; cursor: pointer;
      color: var(--muted); background: rgba(0, 0, 0, 0.25);
      border: none; padding: 6px 16px; transition: all 150ms;
    }
    .${P}-seg button + button { border-left: 1px solid var(--glass-border); }
    .${P}-seg button.on { color: #04141a; background: var(--neon); text-shadow: none; }

    .${P}-select {
      flex: 1; min-width: 160px; font-family: var(--mono); font-size: 11.5px;
      color: var(--fg); background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--glass-border); border-radius: 8px; padding: 6px 10px; outline: none;
    }
    .${P}-select option { background: #0b141b; }

    /* 开关 */
    .${P}-switch { position: relative; width: 34px; height: 18px; flex-shrink: 0; cursor: pointer; }
    .${P}-switch input { display: none; }
    .${P}-switch i {
      position: absolute; inset: 0; border-radius: 9px;
      background: rgba(0, 0, 0, 0.4); border: 1px solid var(--glass-border); transition: all 150ms;
    }
    .${P}-switch i::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
      background: var(--muted); transition: all 150ms;
    }
    .${P}-switch input:checked + i { background: rgba(0, 240, 255, 0.18); border-color: var(--neon); }
    .${P}-switch input:checked + i::after { left: 18px; background: var(--neon); box-shadow: 0 0 8px rgba(0, 240, 255, 0.7); }

    .${P}-tool { display: flex; align-items: center; gap: 12px; padding: 8px 2px; }
    .${P}-tool + .${P}-tool { border-top: 1px solid rgba(0, 240, 255, 0.07); }
    .${P}-tool-name { font-family: var(--mono); font-size: 11.5px; color: var(--fg); width: 168px; flex-shrink: 0; }
    .${P}-tool-desc { font-family: var(--mono); font-size: 10.5px; color: var(--muted); flex: 1; min-width: 0; }

    .${P}-status { font-family: var(--mono); font-size: 10.5px; letter-spacing: 1px; color: var(--green); min-height: 14px; }
  `;
  document.head.appendChild(style);
}

export function initAgentsPage(): void {
  injectStyle();
  const page = document.getElementById('page-agents')!;
  page.innerHTML = '';

  const root = document.createElement('div');
  root.className = P;

  // ---------- 左侧分栏导航 ----------
  const nav = document.createElement('div');
  nav.className = `${P}-nav`;
  const NAV: { id: string; label: string }[] = [
    { id: 'agent', label: 'AGENT 设定' },
    { id: 'memory', label: '长期记忆' },
    { id: 'voice', label: '声音' },
    { id: 'tools', label: '工具' },
    { id: 'permission', label: '权限模式' },
    { id: 'triggers', label: '反应回路' },
    { id: 'data', label: '数据' },
  ];

  const body = document.createElement('div');
  body.className = `${P}-body`;

  const head = document.createElement('div');
  head.className = `${P}-head`;
  head.innerHTML = `<div class="${P}-title">AGENTS</div><div class="${P}-sub">// 主会话 agent 的人格 · 记忆 · 声音 · 能力</div>`;
  body.appendChild(head);

  function section(id: string, label: string): HTMLElement {
    const sec = document.createElement('div');
    sec.className = `${P}-section`;
    sec.id = `${P}-sec-${id}`;
    const st = document.createElement('div');
    st.className = 'section-title';
    st.textContent = `// ${label}`;
    const panel = document.createElement('div');
    panel.className = `${P}-panel`;
    sec.append(st, panel);
    body.appendChild(sec);
    return panel;
  }

  for (const n of NAV) {
    const b = document.createElement('button');
    b.className = `${P}-nav-item`;
    b.textContent = n.label;
    b.dataset.sec = n.id;
    b.onclick = () => {
      nav.querySelectorAll(`.${P}-nav-item`).forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.getElementById(`${P}-sec-${n.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    nav.appendChild(b);
  }
  (nav.firstChild as HTMLElement | null)?.classList.add('on');

  // ---------- 1. Agent 设定（AGENTS.md） ----------
  const agentPanel = section('agent', 'AGENT 设定');
  const agentEditor = document.createElement('textarea');
  agentEditor.className = `${P}-editor`;
  agentEditor.spellcheck = false;
  agentEditor.placeholder = '# AGENTS.md\n\n主会话 agent 的人格与行为约定…';
  const agentRow = document.createElement('div');
  agentRow.className = `${P}-row`;
  agentRow.style.marginTop = '10px';
  const agentSave = document.createElement('button');
  agentSave.className = `${P}-btn primary`;
  agentSave.textContent = '保存';
  const agentStatus = document.createElement('span');
  agentStatus.className = `${P}-status`;
  agentRow.append(agentSave, agentStatus);
  const agentHint = document.createElement('div');
  agentHint.className = `${P}-hint`;
  agentHint.textContent = '修改在「新会话」生效（进行中的会话已注入旧设定）。';
  agentPanel.append(agentEditor, agentRow, agentHint);
  void window.kimi.wb.agentsRead().then((c) => {
    agentEditor.value = c;
  }).catch(() => undefined);
  agentSave.onclick = () => {
    agentSave.disabled = true;
    void window.kimi.wb.agentsWrite(agentEditor.value)
      .then(() => {
        agentStatus.textContent = '已保存 ✓（新会话生效）';
        setTimeout(() => (agentStatus.textContent = ''), 2500);
      })
      .catch(() => (agentStatus.textContent = '保存失败'))
      .finally(() => (agentSave.disabled = false));
  };

  // ---------- 2. 长期记忆（memory.md） ----------
  const memPanel = section('memory', '长期记忆');
  const memEditor = document.createElement('textarea');
  memEditor.className = `${P}-editor`;
  memEditor.spellcheck = false;
  memEditor.placeholder = '# 长期记忆\n\n（agent 维护的长期事实与偏好，可直接编辑修正）';
  const memRow = document.createElement('div');
  memRow.className = `${P}-row`;
  memRow.style.marginTop = '10px';
  const memSave = document.createElement('button');
  memSave.className = `${P}-btn primary`;
  memSave.textContent = '保存';
  const memStatus = document.createElement('span');
  memStatus.className = `${P}-status`;
  memRow.append(memSave, memStatus);
  const memHint = document.createElement('div');
  memHint.className = `${P}-hint`;
  memHint.textContent = 'memory.md 会在每轮对话作为 [长期记忆] 注入上下文。';
  memPanel.append(memEditor, memRow, memHint);
  void window.kimi.wb.memoryRead().then((c) => {
    memEditor.value = c;
  }).catch(() => undefined);
  memSave.onclick = () => {
    memSave.disabled = true;
    void window.kimi.wb.memoryWrite(memEditor.value)
      .then(() => {
        memStatus.textContent = '已保存 ✓';
        setTimeout(() => (memStatus.textContent = ''), 2500);
      })
      .catch(() => (memStatus.textContent = '保存失败'))
      .finally(() => (memSave.disabled = false));
  };

  // ---------- 3. 声音 ----------
  const voicePanel = section('voice', '声音 VOICE');
  type TtsInfo = Awaited<ReturnType<typeof window.kimi.ttsVoices>>;
  let tts: TtsInfo | null = null;

  // provider 选项卡：Piper（本地神经网络）/ macOS say
  const providerRow = document.createElement('div');
  providerRow.className = `${P}-row`;
  const providerLab = document.createElement('span');
  providerLab.className = `${P}-label`;
  providerLab.textContent = '引擎';
  const providerSeg = document.createElement('div');
  providerSeg.className = `${P}-seg`;
  const PROVIDERS: { id: 'piper' | 'say'; label: string; title: string }[] = [
    { id: 'piper', label: 'PIPER', title: '本地神经网络 TTS，音色更自然' },
    { id: 'say', label: 'MACOS SAY', title: '系统自带 say 命令' },
  ];
  for (const p of PROVIDERS) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.title = p.title;
    b.dataset.provider = p.id;
    b.onclick = () => {
      if (!tts || tts.provider === p.id) return;
      tts.provider = p.id;
      window.kimi.ttsSetProvider(p.id);
      renderVoiceBody();
    };
    providerSeg.appendChild(b);
  }
  providerRow.append(providerLab, providerSeg);

  const voiceBody = document.createElement('div');

  // 试听按钮：piper 模式首次预览会下载模型，loading 态防连点
  function previewButton(getVoice: () => string, cjk: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `${P}-btn`;
    btn.textContent = '试听';
    btn.onclick = () => {
      const voice = getVoice();
      if (!voice || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '加载中…';
      void window.kimi
        .ttsPreview(voice, cjk)
        .catch(() => undefined)
        .finally(() => {
          btn.disabled = false;
          btn.textContent = '试听';
        });
    };
    return btn;
  }

  function selectRow(
    label: string,
    options: { value: string; label: string }[],
    current: string,
    cjk: boolean,
    onPick: (v: string) => void,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = `${P}-row`;
    const lab = document.createElement('span');
    lab.className = `${P}-label`;
    lab.textContent = label;
    const sel = document.createElement('select');
    sel.className = `${P}-select`;
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = current;
    // 当前值不在列表里（平台差异）时兜底选中第一项并立即生效
    if (sel.value !== current && options.length > 0) {
      sel.value = options[0].value;
      onPick(sel.value);
    }
    sel.onchange = () => onPick(sel.value);
    row.append(lab, sel, previewButton(() => sel.value, cjk));
    return row;
  }

  function renderVoiceBody(): void {
    if (!tts) return;
    const info = tts;
    providerSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.provider === info.provider);
    });
    voiceBody.innerHTML = '';

    if (info.provider === 'piper') {
      const opts = (cjk: boolean) =>
        info.piperVoices.filter((v) => v.cjk === cjk).map((v) => ({ value: v.id, label: v.label }));
      voiceBody.append(
        selectRow('英文', opts(false), info.piperEn, false, (v) => {
          info.piperEn = v;
          if (info.piperEn && info.piperZh) window.kimi.ttsSetPiperVoice(info.piperEn, info.piperZh);
        }),
        selectRow('中文', opts(true), info.piperZh, true, (v) => {
          info.piperZh = v;
          if (info.piperEn && info.piperZh) window.kimi.ttsSetPiperVoice(info.piperEn, info.piperZh);
        }),
      );
      const hint = document.createElement('div');
      hint.className = `${P}-hint`;
      hint.textContent = '首次试听 / 使用某音色会自动下载对应模型（几十 MB），请稍候。';
      voiceBody.appendChild(hint);
      return;
    }

    // say 模式：系统全量 voices + 语速
    const saveSay = () => {
      if (info.selectedEn && info.selectedZh) window.kimi.ttsSetVoice(info.selectedEn, info.selectedZh, info.rate);
    };
    const sayOpts = info.voices.map((v) => ({ value: v, label: v }));
    voiceBody.append(
      selectRow('英文', sayOpts, info.selectedEn, false, (v) => {
        info.selectedEn = v;
        saveSay();
      }),
      selectRow('中文', sayOpts, info.selectedZh, true, (v) => {
        info.selectedZh = v;
        saveSay();
      }),
    );

    const rateRow = document.createElement('div');
    rateRow.className = `${P}-row`;
    const rateLab = document.createElement('span');
    rateLab.className = `${P}-label`;
    rateLab.textContent = '语速';
    const rateSeg = document.createElement('div');
    rateSeg.className = `${P}-seg`;
    for (const r of [
      { id: 'slow', label: '慢' },
      { id: 'normal', label: '标准' },
      { id: 'fast', label: '快' },
    ]) {
      const b = document.createElement('button');
      b.textContent = r.label;
      b.dataset.rate = r.id;
      b.classList.toggle('on', r.id === (info.rate || 'normal'));
      b.onclick = () => {
        info.rate = r.id;
        rateSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        saveSay();
      };
      rateSeg.appendChild(b);
    }
    rateRow.append(rateLab, rateSeg);
    voiceBody.appendChild(rateRow);
  }

  voicePanel.append(providerRow, voiceBody);
  void window.kimi.ttsVoices().then((v) => {
    tts = v;
    renderVoiceBody();
  }).catch(() => undefined);

  // ---------- 4. 工具 ----------
  const toolsPanel = section('tools', '工具 TOOLS');
  void window.kimi.wb.toolsList().then((tools) => {
    for (const t of tools) {
      const row = document.createElement('div');
      row.className = `${P}-tool`;
      const name = document.createElement('span');
      name.className = `${P}-tool-name`;
      name.textContent = t.name;
      const desc = document.createElement('span');
      desc.className = `${P}-tool-desc`;
      desc.textContent = t.description;
      const sw = document.createElement('label');
      sw.className = `${P}-switch`;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = t.enabled;
      input.onchange = () => window.kimi.wb.toolToggle(t.name, input.checked);
      sw.append(input, document.createElement('i'));
      row.append(name, desc, sw);
      toolsPanel.appendChild(row);
    }
  }).catch(() => undefined);

  // ---------- 5. 权限模式 ----------
  const permPanel = section('permission', '权限模式');
  const permSeg = document.createElement('div');
  permSeg.className = `${P}-seg`;
  const MODES: { id: AppSettings['permissionMode']; label: string; title: string }[] = [
    { id: 'default', label: 'DEFAULT', title: '每次敏感操作都询问' },
    { id: 'auto', label: 'AUTO', title: '自动批准常规操作' },
    { id: 'yolo', label: 'YOLO', title: '全部自动批准（谨慎）' },
  ];
  for (const m of MODES) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.title = m.title;
    b.dataset.mode = m.id;
    b.onclick = () => {
      permSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      void window.kimi.setSettings({ permissionMode: m.id }).catch(() => undefined);
    };
    permSeg.appendChild(b);
  }
  const permHint = document.createElement('div');
  permHint.className = `${P}-hint`;
  permHint.textContent = '控制 agent 执行敏感操作（写文件 / 跑命令）前的确认粒度。';
  permPanel.append(permSeg, permHint);

  // ---------- 6. 反应回路 ----------
  const trigPanel = section('triggers', '反应回路');
  const TRIGGERS: { key: 'focusSpeak' | 'radarCard' | 'overdueNotify'; label: string; desc: string }[] = [
    { key: 'focusSpeak', label: 'focusSpeak', desc: '专注结束时语音播报' },
    { key: 'radarCard', label: 'radarCard', desc: '雷达发现新情报时弹反应卡' },
    { key: 'overdueNotify', label: 'overdueNotify', desc: '任务逾期时通知提醒' },
  ];
  const trigInputs: Partial<Record<string, HTMLInputElement>> = {};
  for (const t of TRIGGERS) {
    const row = document.createElement('div');
    row.className = `${P}-tool`;
    const name = document.createElement('span');
    name.className = `${P}-tool-name`;
    name.textContent = t.label;
    const desc = document.createElement('span');
    desc.className = `${P}-tool-desc`;
    desc.textContent = t.desc;
    const sw = document.createElement('label');
    sw.className = `${P}-switch`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true; // 缺省视为开
    input.onchange = () => {
      const triggers = {
        focusSpeak: trigInputs.focusSpeak?.checked ?? true,
        radarCard: trigInputs.radarCard?.checked ?? true,
        overdueNotify: trigInputs.overdueNotify?.checked ?? true,
      };
      void window.kimi.setSettings({ triggers }).catch(() => undefined);
    };
    trigInputs[t.key] = input;
    sw.append(input, document.createElement('i'));
    row.append(name, desc, sw);
    trigPanel.appendChild(row);
  }

  // settings 一次读取，回填权限模式 + 反应回路
  void window.kimi.getSettings().then((s) => {
    permSeg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === (s.permissionMode ?? 'default'));
    });
    for (const t of TRIGGERS) {
      const input = trigInputs[t.key];
      if (input) input.checked = s.triggers?.[t.key] !== false;
    }
  }).catch(() => undefined);

  // ---------- 7. 数据 ----------
  const dataPanel = section('data', '数据');
  const dataRow = document.createElement('div');
  dataRow.className = `${P}-row`;
  const backupBtn = document.createElement('button');
  backupBtn.className = `${P}-btn primary`;
  backupBtn.textContent = '立即备份';
  const backupStatus = document.createElement('span');
  backupStatus.className = `${P}-status`;
  dataRow.append(backupBtn, backupStatus);
  const dataHint = document.createElement('div');
  dataHint.className = `${P}-hint`;
  dataHint.textContent = '把任务 / 雷达 / 记忆等工作台数据快照到本地备份目录（每天一份）。';
  dataPanel.append(dataRow, dataHint);
  backupBtn.onclick = () => {
    backupBtn.disabled = true;
    void window.kimi.wb.runBackup()
      .then(() => {
        backupStatus.textContent = '已备份 ✓';
        setTimeout(() => (backupStatus.textContent = ''), 3000);
      })
      .catch(() => (backupStatus.textContent = '备份失败'))
      .finally(() => (backupBtn.disabled = false));
  };

  root.append(nav, body);
  page.appendChild(root);
}
