# Changelog

All notable changes to Kimi Desktop Personal Agent will be documented in this file.

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-08-29

版本主题：**Task Flow 进化为完整的时间管理系统**——子任务、今日待办、日程排期、番茄钟复盘，外加声音分场景开关。

### Added

- **子任务**（一层）：主任务编辑面板里直接增删子任务、勾选完成；看板和今日列表里子任务都缩进挂在主任务条目下（左侧竖线 + 进度 n/m），关联关系一眼可见；子任务启动 Session 时自动把主任务的标题/描述/备注/截止时间注入上下文，agent 知道自己在为谁打工
- **今日待办视图**：Task Flow 新增「今日」tab——聚合今天该做的事（今天截止/今天排期/进行中，含子任务），按优先级排序；行内直接勾完成（完成的任务划线淡化置底、不移除、可取消）；hover 出现 ⏰ 番茄钟 / ▶ 启动 Session 双按钮，番茄钟进行中行内显示倒计时；底部「今日统计」按任务聚合番茄数和专注分钟
- **今日待办桌面面板**：「钉到桌面」把今日清单变成一个置顶小窗（可拖动、右下角手柄缩放、全工作区可见）——勾完成、⏰/▶ 双操作、列表/当天日程时间轴双视图（带现在时刻红线）、今日统计；任务任何增删改全窗口实时同步，不用打开工作台也能推进今天
- **日程视图**：Task Flow 新增「日程」tab——飞书风周时间网格（06:00–24:00 × 周一~周日，今天高亮，可切周）；任务色块按优先级着色，点击开详情；**拖拽排期**：未排期任务从侧栏拖入网格即定时间（对齐 30 分钟），网格内拖动改时间、拖底边改时长；编辑面板也可直接选「计划开始/结束」
- **番茄钟引擎**：main 进程统一持有计时状态，今日 tab / 桌面面板任意入口 start/stop，状态全窗口广播；**倒计时同时外显到桌面灵动岛**（复用 deep-focus 的 pill 通道）；结束（跑完或提前停）自动落账 `pomodoro_sessions` 表——每个任务花了多少番茄、多少分钟，可复盘
- **声音分场景开关**：Agents 页声音区新增「自动播报」三开关——总开关 / Zen 模式 / 悬浮窗对话，可单独关掉某个场景的自动 TTS；悬浮窗普通会话现在也支持自动播报（主会话仍由 voice 引擎统一播报，不会双重发声）

### Technical

- `tasks` 表列级迁移（`parent_id` / `scheduled_start` / `scheduled_end`，PRAGMA 探测 + ALTER TABLE）；删除主任务级联删子任务；重复任务的下次 occurrence 不继承排期
- `pomodoro_sessions` 表（task_id / started_at / minutes / completed）+ 番茄钟引擎 `pomodoro.ts`（切换任务时先把进行中的按未完成落账，不丢记录）
- 任务变更全窗口广播 `evTasksChanged`（tab / 面板实时同步）；TTS 门控矩阵：总开关 × 场景开关，主会话统一走 voice.ts 避免悬浮窗/workbench 双重播报

## [0.4.0] - 2026-08-23

大版本：**Jarvis Shell + System as an Agent + 数据平面**。从「桌面助手」进化为「可自我感知、可进化、可呈现的个人 agent 系统」。

### Added

- **Jarvis Shell**：单窗口 + 左侧导航轨（主页 / Dashboard / Zen / Plugins / Agents），主页与工作台合一；玻璃拟态 HUD 视觉统一
- **Zen 模式**：沉浸语音交互页——Apple Intelligence 风渐变光球 + 四周呼吸光影、TTS 节奏字幕条、可挂载浮层组件（可拖可缩放）、停止按钮、权限卡片、消息框默认折叠
- **主会话常驻模型**：voice / Command Center / Zen 共用一个长期主会话（⭐ 置顶于会话列表）；`memory.md` 长期记忆由 agent 自维护并注入上下文
- **System as an Agent**：
  - 工作台内嵌 MCP Server（16 个工具统一能力清单 `capabilities.ts`，AGENTS.md 工具清单自动生成）
  - `system_query` 通用查询（tasks/radars/library/layout/signals/widgets/capabilities）
  - **数据平面**：jarvis.db（SQLite WAL）为唯一事实源；`data_schema` / `data_query`（只读 SQL 全覆盖）/ `data_exec`（护栏写：禁 DDL、强制 WHERE、白名单、快照可撤销）
  - **呈现层**：`present` / `present_artifact`（模板化图文卡片：news-digest / data-card / gallery）/ `dismiss`，语音给摘要、卡片给细节
  - Signals 信号总线 + 确定性反应回路（番茄钟播报 / 雷达新动态卡片 / 逾期提醒）
- **Plugins 市场**：内置组件 + 官方预设 + 组件库，可添加到 Dashboard 或钉到导航轨
- **Voice 体系**：Piper 本地神经 TTS（venv 集成，中英模型目录 14 个）+ macOS say 双引擎可切换；流式语音（句子级切分，首音 1-3s）；声音跟随回复主语言
- **Agents 页**：Agent 设定 / 长期记忆 / 声音 / 工具开关 / 权限模式 / 反应回路 / 数据备份
- **Thinking 模式**：💭 开关（high/low 即时切换）+ 思考过程流式可视化（输出开始自动消失）
- **Phone Video**：QuickTime 窗口捕获看 iPhone 画面，Vision 模式画面随用户消息附带（不主动骚扰）

### Fixed

- 重启后主会话 resume 未挂 MCP（agent 无工具退化为 Bash 硬试）
- IPC invoke/send 回执不匹配导致工具超时
- 主会话 id 缓存过期（Zen / TTS / main-log 三处静默）→ `evMainSession` 事件同步
- 执行中会话打开即中断（load/resume 都会取消在跑回合 → 零调用纯实况）
- 官方 Piper macOS 包损坏（x86_64 + 缺 espeak-ng）→ pip 版 piper-tts
- TTS 逐句切声导致中英夹杂 → 整段统一、跟随回复主语言
- Zen hidden 语义被 CSS 覆盖、悬浮球变形、widget_modify 快照时序等

### Technical

- `better-sqlite3`（Electron 原生加载验证通过）；启动时 JSON → DB 一次性幂等迁移
- MCP Server 无状态 per-request transport（127.0.0.1 随机端口）
- 语音链路：renderer 句子切分 + 串行队列 → main `ttsSpeak` provider 路由（piper/say fallback）

## [0.3.0] - 2026-08-22

### Added

- **重复任务**：任务可以设「每天/工作日/每周」重复——比如「每天站会记录」完成后自动归档，看板里明天那张卡已经帮你建好了；卡片上有 `↻` 标记
- **项目归属**：任务可以挂到项目下（项目带颜色标识），看板顶部按项目筛选/分组，适合「工作项目」和「个人杂事」分开看
- **一键启动任务**：看板卡片右下角 ▶ 按钮（或详情里「启动 Session」），点一下 kimi 就开工——会话框弹出来能实时看着它思考、调工具、输出；任务自动变成进行中，备注也会带过去
- **任务详情自动保存**：改完字段不用点保存（800ms 自动落盘），想手动也有保存按钮和 ⌘S
- **看板排序**：重要的事自然浮上来——按优先级排，同级按最近修改排
- **macOS 菜单栏 Tray**：菜单栏多了个蓝色小球，随时打开主页/工作台、隐藏悬浮球、退出应用（以前只能杀进程退出）
- **会话分类**：会话列表分「全部 / Chat / Auto」——你自己聊的归 Chat，任务和后台自动建的归 Auto，右键可以改分类，列表不再被系统会话刷屏

### Fixed

- **任务启动就中断、等不到结果**：点了 ▶ 之后 kimi 从没真正跑起来过——打开会话框时我们调了 `session/load`，而 kimi 的 load/resume 都会把正在执行的回合掐掉。现在执行中的会话打开时完全只读（实况 chunk 本来就在同一条连接上流），切换会话进进出出都不会断
- **修改任务项目保存不了、按钮消失**：详情面板一处变量声明顺序错误（TDZ）导致整个面板初始化中断，按钮没渲染、自动保存没注册——已修复
- **会话残骸刷屏**：常驻运行时，后台工具会话轮换下来的旧会话一直留在列表里；现在延迟 5 分钟运行时就清理，启动时再兜底
- 回放历史里 kimi 注入的 `<system-reminder>` 管道文本会显示在气泡里——已剥离

### Technical

- ACP `session/resume` 经探针实测同样会取消在跑的回合（kimi 0.31.1），结论：对进行中会话**零调用**，纯靠共享连接的 `session/update` 推送
- 执行中状态由主进程 `busySessions` 跟踪，`prompt()` 入口同步置位，杜绝「先 load 后标记」竞态
- 重复任务实例生成在主进程 `saveTask` 完成（完成判定 = status 首次变为 done），下次实例 due 按周期推算（工作日跳过周末）
- Task.recurrence / Task.projectId / Project.color 数据模型扩展；projects.json 持久化

## [0.2.0] - 2026-08-17

大版本：**Jarvis 工作台** + **Voice-first 主页** + **自进化引擎**。详细设计逻辑见 `changelog-0816.md`（开发记录）。

### Added

- **Jarvis 工作台**：独立可全屏窗口（`⌘⇧J` / 对话窗 ▦ 入口），HUD 布局 + widget 运行时（拖拽/缩放/双击放大/Dock 休眠/布局持久化/舞台滚动）；P0 模块：Deep Focus 番茄钟、Task Flow 任务看板（看板+月历+任务转 AI Session）、Command Center 命令面板、One-for-All Search 多引擎应用内 tab 查看、Agents.md 编辑器；P1 模块：Widget Forge（对话式生成组件 + 组件库）、Info Radar（定时抓取 + AI 结构化 + Feed/Thread + 设置面板 + 轮播）
- **Voice-first 主页**：启动入口（终端绿 HUD）：中央语音 orb 三态动画、左栏系统指标（CPU/RAM/DISK/网络/电池/Wi-Fi/GPU/Top 进程，⚙ 开关浮层）、右栏流式对话日志、底部输入；回复自动 TTS 语音播报（macOS `say`，英文 Daniel 英音/中文自动切换）
- **自进化引擎（E1→E3）**：工作台内嵌 MCP Server，kimi 原生 tool calling 操控工作台（schema 校验 + 结果回传）；11+ 工具覆盖任务/雷达/布局/组件/源码五层；`artifact_modify` 对话改自定义组件（自动重挂载）；`widget_modify` 对话改内置 widget 源码（自动重建热重载）；演化日志 + 快照撤销 + error boundary + 构建回滚四道防线
- **灵动岛**：番茄钟置顶倒计时 pill，可拖拽，双击唤起工作台
- 消息队列自动续发、右键选中引用提问、图片粘贴、月之暗面主题等对话窗持续改进

### Fixed

- Forge 权限卡死（askOnce 会话自动批准）、生成物 ID 冲突（Proxy document 作用域隔离）、一次性会话污染（垃圾桶启动清扫 + 会话回收轮换）、kimi 存储竞态（会话自愈重建）、MCP 60s 超时（后台执行 + 完成推送）、HN 旧数据（search_by_date）、快照时序 bug（撤销空转）

## [0.1.1] - 2026-08-11

### Added

- **图片全屏预览**：点击对话中的图片（markdown 远程图、发送的截图）弹出覆盖整块屏幕的独立预览窗，点击任意处或按 Esc 关闭，跟随对话窗所在显示器
- **markdown 图片渲染**：`![描述](url)` 语法现在会渲染成真正的图片（圆角边框、宽度自适应）

### Fixed

- 图片语法 `![...](...)` 之前会被链接规则误吞，消息里只剩一个 `!`
- 流式输出时上滑查看历史消息不再被强制拉回底部——只有用户本来就在底部时才跟随滚动；自己发消息、切换会话时仍会定位到最新

## [0.1.0] - 2026-08-09

首个公开发布版本。

### Added

- **悬浮球**：常驻屏幕边缘，眼睛跟随鼠标、眨眼/转头空闲动画、思考/输出动效，可拖动、点击开关对话窗
- **对话窗**：流式渲染、markdown（表格/代码块/超链接）、思考过程折叠框、工具调用单行滚动状态、发送 loading 占位
- **ACP 接入**：单 `kimi acp` 子进程多会话，stdio JSON-RPC；权限确认条（允许/本会话允许/拒绝）；fs 反向 RPC 路径沙箱
- **截图问答**：`⌘⇧K` 全局唤起 + 区域截图；`⌘V` 直接粘贴剪贴板图片
- **预设模式**：翻译/解释代码/润色/总结内置，设置页可增删改（system prompt 模板 + 用户输入）
- **收藏夹 vault**：kimi 按工作区 `AGENTS.md` 约定写入 markdown，面板内查看/编辑
- **会话管理**：新建、历史列表、恢复（`session/list` + `session/load` 历史回放）
- **消息队列与停止**：回复中可输入排队、回合结束自动续发；流式期间发送键变停止键（`session/cancel`）
- **消息交互**：右键复制/选中引用提问，引用卡片挂在输入框上方可删除
- **窗口与主题**：置顶 pin（默认开）、暗色主题（月之暗面）、圆角浮窗、SVG 图标系统
