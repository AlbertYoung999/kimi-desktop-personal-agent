# 2026-09-28 · v7.0 开发记录

## 需求(prd.md v7.0)

channel 模式:参考 slack 按 channel 管理所有 kimi-code session——以文件夹(项目)做一级分类、置顶/最近排序、右侧内嵌对话面板直接续聊;支持常驻 agent(能力 1:N 复用)与阅后即焚 session;group 多 session 协作(@mention 路由 + 共享上下文 + 自动压缩);session 任务看板;终端双视图(chat UI / TUI)。

## 关键决策(完整版见 prd.md v7.0 决策区)

1. 对话面板复用走重构:`chat/index.ts`(820 行)→ `createChatPanel(container, opts)` 工厂,悬浮窗与 channel 页共用;
2. 消息持久化只做轻量:每 session 只落「最后一条消息」(看板/预览用),历史回放仍走 ACP session/load;
3. session 列表数据源:扫描 `~/.kimi-code/sessions/`(state.json + **session_index.jsonl**)为主,ACP session/list 为辅;
4. 编排不做固定模板:group 任务启动时 AI 动态规划,预设降级为设置页「编排优先模式」先验;
5. group 每 10 轮自动压缩进 group.md「历史摘要」;
6. 同项目并发写任务走 git worktree 隔离(kimi-code 无原生隔离,实测确认);
7. 100 天归档是**一次性迁移**(显式打标),非常驻规则——session 不会因年龄自动离组。

## 实测验证过的技术前提

- kimi 2.0.1 ACP session 能力 11/11(fork/delete/close 均可用,SDK 0.23 走 unstable_*);
- ACP `session/new` 不支持绑定 agent profile(configOptions 只有 model/thinking/mode)→ 常驻 agent 用 `<system-reminder>` 包裹的首轮注入模拟;
- 双进程并发驱动同一 session 会双写 wire.jsonl(两个 turn 交叠、消息重复回答)→ 「接管/交还」时分复用;
- node-pty 1.1.0 × Electron 37 可用(spawn-helper 需 +x,已加 postinstall);
- 本机 sessions 存在两代 schema(147 新 / 1170 旧),旧 schema 无 cwd,session_index.jsonl 100% 命中归因。

## P1 — Channel 骨架

- **工厂化**:`src/renderer/shared/chat-panel.ts` + `.kp-` 作用域样式;悬浮窗瘦身为壳(浮层/窗口控制留宿主);可选 `openSession` opts 钩子;
- **数据层**:sqlite `channel_projects`/`channel_meta`;`SessionScanner`(fs.watch debounce 2s);turn ring buffer 一身二用(live 接管补放 + last_message 落库);
- **统一会话入口 openSession**:busy 永不 load(铁律)、history/live/stale 三分支、防抖令牌;
- **channel 页**:状态条(运行中/待处理/置顶)、项目树(默认折叠、hot 自动展开、更新圆点、仅看有更新)、Cmd+K 页内跳转(捕获阶段拦截,Command Center 不受影响)、原生文件夹选择器建项目、`newSession(cwd)` 在项目下建会话;
- IPC 新开 `ch:` 前缀。

## P2 — 常驻 Agent 与配置

- **agent 库**:`wbRoot()/agents/<name>/`(AGENTS.md + skills/ 占位),sqlite 元数据、磁盘为准自愈;agents 页「常驻 Agent」管理区;
- **首轮注入**:agent 定义 + 项目上下文指引包 `<system-reminder>` 注入(replay 自动剥离);创建等注入完成,UI 有占位行;
- **三配置抽屉**:AGENTS.md(项目级)/ current-process.md / product.md(`.kimi-desktop/sessions/<sid>/`),防抖自动保存;
- **current-process.md 自动更新**:turn 结束 → askOnce 增量生成状态写回(配置门控 + 10s 节流 + 注入轮跳过);
- **阅后即焚**:utility session 收「临时」折叠区,ACP `session/delete` 清理。

## P3 — Group 协作 + 终端 + 看板

- **group-orchestrator**:@mention 路由(精确/前缀/role/coordinator 兜底)、per-group 串行队列、busy 30s 超时跳过、10 轮压缩(group.md 摘要 + group-logs 原文)、autonomous 自主讨论(maxRounds=20 硬护栏);
- **动态编排**:新建 group 向导「AI 规划编排」→ 结构化方案卡片;agents 页「编排优先模式」先验;
- **worktree-manager**:create/list/diff/merge(--no-ff,冲突自动 abort 复原)/discard;Orca 式 **diff 行内批注回喂** session;
- **fork**:session 行一键分叉,group 可「分叉加入」;
- **终端三视图**:L3 内嵌 xterm.js+node-pty(分段切换、接管/交还精确闭环、Cmd+C/V/K 路由)/ L1 `kimi vis` 浏览器观察 / L2 iTerm/Terminal 外开 + 交还按钮;held 期间主进程 prompt() 全链路 reject;
- **session 看板**:置顶/运行中/待处理/空闲四栏 + 统计条,点卡直达;
- **一次性归档迁移**:1129 条(>100 天)打标进「历史归档」(沉底折叠、窗口化渲染、无圆点、不进看板、Cmd+K 保留);行内 📥 归档 / ↩ 恢复;
- **归因修复**:session_index.jsonl 精确归因,未分组 32→0,项目组 13→53;findSessionCwd 同步回退(老 session 可用终端/三配置);
- **交互**:session 行操作收编「···」菜单;项目头右键(新建 session / 打开所在目录)。

## Bug 修复

- **新建 session 双路径失效**:agent 选择器(二级菜单)被 document 级「菜单外点击关闭」在同一 click 事件里瞬杀(一级菜单关闭 → target detach → contains 恒 false → 误判菜单外点击);三处菜单 item onclick 补 `stopPropagation`;`createSessionInProject` 补 catch + flashNotice;`setProject` 改 await 修归类时序;主进程 handler 加错误日志。
- **AskUserQuestion 卡死**:问题走 request_permission 通道,但权限条只有布尔允许/拒绝,多选题无法作答(响应按 kind 推导乱选)。修复:evPermission 载荷带 `options[]`(optionId/name/kind)、respondPermission 支持显式 optionId 应答(未知 optionId 回 cancelled 不瞎选)、rawInput 截断 300→1000;权限条对带 options 的请求渲染选项按钮,并补 sessionId 过滤(多 panel 只响应自己 session)。
- **右键菜单未同步**:消息右键(复制/引用提问)收进 chat-panel 工厂(#ctx-menu id → .kp-ctx-menu class,样式入 chat-panel.css),channel 页与悬浮窗共用;悬浮窗 session 列表右键同步收敛。
- **per-session 权限模式**:chat 面板 mode-bar 左侧「权限」菜单按钮(色点+当前模式名,点击展开四选项),即切即生效(实测 setSessionConfigOption 中途切换立即生效、yolo 服务端零权限请求);channel_meta.mode 落 per-session 覆盖,applySessionConfig 按 覆盖??全局 重放;current_mode_update 回传持久化(带 guard 防自己回执造假覆盖),终端 TUI /yolo 后 UI 自动同步;YOLO 红色警示 + 首次启用 confirm。全局 permissionMode 降级为新 session 默认值。
- **group 三修复**:① @ 失效 = 过滤字段窄(只看 title/agentName/role)+ 插入显示名不可路由,修为匹配集含 label、插入优先可路由字段、主进程 resolveMentions 兜底 label;② 新建 group 自动创建 coordinator session(真实 ACP session,role='coordinator',失败整体回滚),成员管理支持「描述创建新 session 成员」(`ch:group-create-member`);③ group.md「已保存但重开回旧值」= 抽屉读的是 showGroup 时的缓存,改为打开时实时重拉 + dirty 防打断。
- **chat UI 细节**:输入框焦点双层边框修复(宿主 focus-visible outline 压住工厂重置);权限开关收拢为菜单按钮(省空间)。
- **Info Radar 五周不更新(20260929)**:`radar_items.created_at` 为 NOT NULL 无默认值,而 insertItems 的 INSERT 未带该列 → 每条插入违反约束被 `INSERT OR IGNORE` 静默吞掉;叠加 fetch 失败 catch→[] 与 runRadar 大 try/catch 两层静默,调度器照常跑、lastRunAt 照常更新、零入库零报错五周。修复:insertItems 补 created_at;两处静默 catch 加 console.warn。修复后实测三个雷达即抓即存(academic 75→90、ai-industry 200→225,最新内容当日)。

## 遗留与已知限制

- group 消息重启丢未压缩段(设计接受);group 置顶/worktree 映射为本地态;
- held 遮罩挡整面(消息可读不可滚);L1 vis 切走即停服务;
- 旧 session 经 `ch.openSession` 的 replay 行为未实测(cwd 固定 workspaceDir 的遗留风险);
- 归档组千条级为窗口化渲染,未做完整虚拟滚动。
