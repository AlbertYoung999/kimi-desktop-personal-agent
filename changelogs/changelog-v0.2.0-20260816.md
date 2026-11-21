# 更新记录 2026-08-16（工作台版）

> 本轮主题：**Jarvis 工作台**（`prd/PRD-Jarvis-工作台.md`）+ **Voice-first 主页**。尚未合并进 CHANGELOG.md，验收后再发版。

## Voice-first 主页（新增，应用启动入口）

- 启动即进入主页（1120×720，参考 E.V. CORE 终端绿 HUD 风）
- 顶栏：品牌 + 呼吸状态点、中央大时钟、**DASHBOARD 按钮 → 工作台**
- 左栏 // SYSTEM：CPU/RAM/DISK 实时进度条（主进程 2s 轮询推送）+ 内存/负载/运行时长；// MODULES：STT WHISPER（待接入）/ BRAIN KIMI-ACP / VOICE DANIEL-GB；// WORKSHOP：vault 最近 3 条收藏
- 中央 canvas 语音 orb（48 径向柱，READY/THINKING/SPEAKING 三态动画，页面隐藏时暂停省 CPU）
- 右栏 // EVENT LOG：`[时间] YOU › / KIMI ›` 流式对话记录（独立 ACP 会话）
- 底部输入行 + MIC 占位（whisper 下期）；回复自动 **TTS 语音播报**（macOS `say`，英文 Daniel 英音 / 中文自动切中文 voice；剥离 markdown；新发消息打断上一轮）
- 底部装饰 ticker

## 工作台骨架

- 独立可全屏窗口（1280×800，`⌘⇧J` 全局唤起，对话窗顶栏 ▦ 入口）
- HUD 布局：顶栏（品牌/时钟/`SYS ONLINE` 状态读数）+ 中央舞台 + 底部 Dock（`WIDGETS: N` 计数）
- Widget 运行时：注册表、拖拽（8px 网格吸附）、右下角拉伸、**双击标题栏放大/还原**、休眠到 Dock、移除；布局持久化到 `~/.jarvis-workspace/layout.json`
- 舞台可上下左右滚动（内容层动态撑大），霓虹细滚动条；微弱点阵背景；L 形 tech 角标卡片；CRT 扫描线
- 视觉基调：深蓝黑 + 发丝边框 + 霓虹青点缀（对齐参考图的克制 HUD 风）

## P0 模块

- **Deep Focus**：Sprint 25 / Deep 45 / Breath 5 三模式，霓虹环形倒计时，暂停/放弃，结束记录「完成了什么」+ 历史列表；计时状态可恢复
- **Task Flow**：看板四列（拖拽换列、列底快速创建、inline 编辑、优先级循环、`C` 快捷键）+ 月历视图（今天高亮、逾期标红）；详情面板含 **datetime-local 开始/截止时间选择器**；「启动 Session」把任务 JSON 发给 kimi 建 ACP 会话，可从任务跳回对话窗
- **Command Center**（`⌘K`）：本地规则引擎（开番茄钟/添加/关闭/删除 widget/搜索）+ **对话式操控**——命中不了规则时走 kimi 会话，kimi 返回结构化 action 直接执行：新建任务进看板、开关 widget、搜索发射等；纯问答则流式展示回复
- **One-for-All Search**：引擎 chips 单行横滑；回车后**应用内 tab 查看**各引擎结果（工作台独立 session 剥离 X-Frame-Options/CSP，iframe 可嵌 Google 等）；「全部外开」走系统浏览器；引擎可增删改；历史复用
- **Agents.md 编辑器**：左右分栏编辑+实时预览，managed 标记区高亮保护，⌘S 保存

## P1 模块

- **Widget Forge**：对话式生成（每轮显示 kimi 的完整说明，过程可见可迭代）；五阶段 Forge Mode 动效；「✓ 确认入库」进组件库（`library.json`），组件库可「添加到舞台」为独立 artifact 组件（**双击标题可改名**，框架标题同步）；生成物脚本作用域隔离（Proxy document，同组件多处挂载互不劫持）；高危调用扫描警告条
- **Info Radar**：三个默认雷达（GitHub 开源日更 / arXiv 日更 / HN AI 每小时——已改 `search_by_date` 端点保证时效）；定时抓取 → 去重 → kimi 批量结构化摘要（失败降级原始条目）；图标侧栏未读角标 + Feed 卡片流 + Thread 详情 + 相关推荐；「转任务」进 Task Flow；**设置面板**（名称/频率/源列表 RSS·Atom 嗅探/启用开关）；**跑马灯式匀速轮播**（24px/s，hover 暂停）

## 灵动岛（Deep Focus 联动）

- 番茄钟进行中，屏幕顶部出现置顶 pill：`● 23:41 DEEP · 任务名`，每秒刷新，暂停变橙
- **左键拖拽移动位置，双击唤起工作台**；无计时即销毁，零常驻开销

## 底层与约定

- `AGENTS.md` managed 标记分区：app 管约定（vault、Forge 数据源规范——**放手用公开数据源，不预设限制**），用户区自由编辑，互不覆盖
- 一次性 AI 调用（Forge 生成、Radar 摘要）用后**自动删除 session**，不再污染会话管理
- 工作台窗口 `webSecurity` 关闭：生成组件可直接 fetch 公开 API（本地应用取舍，记录在案）
- 用户层全部在 `~/.jarvis-workspace/`（layout/tasks/engines/radars/library/history），不进版本库

## 已知遗留

- focus 语音/甘特图/搜索分栏按 PRD 不做；Forge 组件「查看源码/导出」未做
- iframe 内嵌个别带 frame-busting 的站点会顶出（预期）
- 生成组件可访问完整渲染环境（无沙箱，已决策，有警告条缓解）

## 0816 后续修订

- **Forge 可用性修复**：askOnce 一次性会话自动批准权限（此前权限确认条弹在对话窗导致生成卡死）；180s 超时 + 自动取消；AGENTS.md 约定重写为「放手用公开数据源、代码只输出在回复正文、不落盘」；失败原因显示在 Forge 对话流里
- **生成物作用域隔离**：Proxy document 限定 ID 查找，同一组件多处挂载互不劫持；修 DOMContentLoaded 不触发、script 属性丢失
- **一次性会话清理**：Forge 生成 / Radar 摘要的 session 用完即删，不再污染会话管理
- **artifact 组件**：双击标题改名（框架标题同步）；滚动条全局统一为霓虹细条（压过生成物默认样式）
- **Command Center**：AI 条目常驻结果列表；↑/↓ 选择 + Enter 执行；动作+内容句式（新建/创建/记录…）AI 优先排序；对话式 action 白名单（create_task / open_widget / close_widget / search / focus）
- **Radar**：HN 源改 `search_by_date`（修旧数据）；轮播改跑马灯式匀速滚动；设置面板（名称/频率/源列表/开关）
- **灵动岛**：1s 上报（倒计时逐秒刷新）；左键拖拽移动、双击唤起工作台
- **入口调整**：启动进 voice-first 主页；对话窗 ▦ 按钮与 `⌘⇧J` 改为打开主页；主页 DASHBOARD → 工作台
- **系统指标扩展**：新增电池、网络吞吐 sparkline、Wi-Fi SSID、GPU 型号、Top 进程；// SYSTEM 加 ⚙ 指标开关浮层（localStorage 持久化）；可视化多样化（donut/sparkline/电池图标）

## 自进化 E1：工作台 = MCP Server（2026-08-16）

> 设计：`design-evolve.md`。废弃「prompt 写死 action + 第一行 JSON」自制协议，改用原生 tool calling。

- **内嵌 MCP server**（`src/main/mcpserver.ts`，127.0.0.1 StreamableHTTP）：6 个 tool——`task_create` / `widget_open` / `widget_close` / `search_launch` / `focus_start` / `radar_create`，zod schema 全量校验
- **Command Center 会话原生 tool calling**：ACP `session/new` 挂载 mcpServers；CONTROL_PREFIX 整段删除（渲染层净减 195 行）；本地快捷规则保留为即时路径
- **可靠性质变**：协议由 MCP 层强制（模型无法脱轨返回 HTML）、参数校验非法即拒、工具结果回传 kimi 可自我修正；端到端验证通过（无头会话真实调用 task_create 落盘）
- **权限与执行 UX**：
  - `mcp__workbench__*` 自有工具自动批准（权限条在对话窗，工作台不可见会卡死）
  - 权限请求确认**搬进 Command Center 面板**（琥珀卡片：允许/本会话允许/拒绝）
  - 面板控制条：**⏹ 停止按钮**（session/cancel 中断执行）+ **AUTO 开关**（当前会话权限全自动，yolo 语义，localStorage 持久化）
  - 工具调用行完整化：`⚙ 工具名 参数摘要 状态`（主进程 title 合并 + 参数 detail 传递，渲染端防覆盖缓存）

## 自进化 E2：能力扩展 + 演化闭环（2026-08-16）

- **新工具**：`task_complete` / `task_update` / `radar_update`（频率/源/启停）/ `artifact_modify`（对话指名修改已有组件）/ `evolve_undo`（撤销）
- **artifact_modify**：kimi 走 Forge 差量管道生成新 HTML → 更新组件库 → **推送舞台自动重挂载**（修掉了「改完没刷新」）；生成耗时长于 MCP 60s 超时，改为后台执行 + 完成推送；artifact 组件另有 ⟳ 手动刷新兜底
- **演化日志**：每次工具执行追加 `history/evolve.jsonl`；撤销用快照式（执行前存文件内容，undo 逐帧回滚，cap 50）；新增「演化日志」widget 可视化最近 50 条
- **e2e 验证**：对话修改股票组件（下划线出现）→ 连续撤销逐步回滚（下划线消失）

## 会话回收 + 后台任务通知（2026-08-17）

- **会话回收机制**：askOnce 不再每次新建会话——所有一次性调用（Forge 生成 / Radar 摘要 / artifact_modify）共用一个「工具会话」，promise 队列串行（kimi 单会话不并发），每 12 次使用轮换一次，轮换和退出时的旧会话进垃圾桶（`trash-sessions.json`），下次启动 spawn kimi 之前统一清扫。会话管理里最多只看到 1 个工具会话
- **启动时清扫**：修复了「即删即崩」竞态（kimi 异步落盘，删目录导致 storage append failed 传染整轮对话）；managed 会话遇到存储错误自动重建重试一次
- **完成通知**：后台修改完成后工作台右下角弹 toast（成功绿/失败红，点击或几秒后消失），不再悄无声息

## 自进化 E3：内置 widget 可对话修改（2026-08-17）

> 这一步让「应用层都可修改」真正落地。设计逻辑记录如下。

### 设计逻辑

**为什么改内置 widget 走「源码编辑」而不是「生成 HTML 变体」？**

- 内置 widget（Task Flow、Info Radar 等）是几百行精调过的 TS 代码（拖拽、快捷键、状态机），让模型重新生成一份 HTML 变体，质量和交互必然全面退化，且从此和内置版分叉
- kimi 本来就是编码 agent——**编辑源码才是它的主场**。工作台源码就在本机仓库里，没有比「让 agent 改自己的代码」更直接的自进化
- 改的是 git 跟踪的源码：演化天然有版本控制，`git checkout` 是最终兜底

**链路**：`widget_modify(widget, instruction)` → 专用 kimi 会话（cwd 绑定**仓库根目录**，fs 沙箱按会话 cwd 隔离，agent 只能动仓库）→ agent 编辑 widget TS 源码 → esbuild 重建工作台 bundle → 热重载工作台窗口 → 组件带着新功能出现在舞台上。

**不改 crash 的四道防线**（边界模型 Ring 2 的执行面）：

1. **构建闸门**：agent 改完后必须过 esbuild 重建，失败 → 自动回滚源码 + 重建旧包，用户无感
2. **快照时序**：回滚快照在 agent 动手**之前**捕获（曾踩过「快照拍在修改后、撤销空转」的时序 bug）
3. **error boundary**：运行时某 widget 挂载崩溃 → 隔离成错误卡片（可重试），不波及舞台其他部分
4. **undo 联动**：`evolve_undo` 回滚源码后**自动重建热重载**，撤销链完整闭环

**反馈闭环按用户路径设计**：用户说完修改要求会停在面板等待——进行中面板内播 Forge 式 FORGING 扫描动效；完成时组件弹到舞台**放大展示**变化本身 + toast + 对话确认；失败则回写对话说明原因。

### 变更点

- `widget_modify` 工具（MCP server）+ 仓库 cwd 专用会话（复用会话回收机制，按 cwd 分槽轮换）
- fs 反向 RPC 沙箱：从「固定工作区」改为**按会话 cwd 隔离**（此前 agent 读仓库文件被自己的沙箱拦截）
- widget 挂载 error boundary（core/layout.ts）
- `evolve_undo` 返回恢复文件列表，widget 源码变更自动触发重建
- e2e：对话改 evolution widget → 源码变更 + 重建 + 热重载 → undo 回滚 + 再重建，全链路验证通过
