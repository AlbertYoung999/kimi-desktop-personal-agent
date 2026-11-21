# 更新记录 2026-08-23（V4-A：Shell 化 + 一个脑子）

> 本地更新记录（gitignored，不进仓库）。本轮主题：**Jarvis 系统的骨架成型**——单 Shell、导航轨、主会话常驻、记忆与数据加固。

## 功能更新（大白话）

### 应用变成「一个系统」了

- **启动即 Shell**：以前主页、工作台是两个独立窗口，现在合成一个主窗口，左侧一条导航轨：主页 / Dashboard / Zen / Plugins / Agents。Zen、Plugins、Agents 是下一期的占位页
- **主页搬家**：系统指标、语音 orb、对话记录、输入框全部搬进 Shell 主页，视觉从绿色终端风统一到整套 HUD 玻璃拟态（半透明面板 + 青色描边），页面切换有淡入上浮动效
- **切页不断线**：在主页提问后切去 Dashboard，回答照常在流；语音播报也不会因为切页重复响
- 入口全部归一：启动、`⌘⇧J`、菜单栏 Tray「打开主页」、悬浮窗 ▦ 按钮，都开 Shell

### Agent 开始有「一个脑子」了

- **主会话常驻**：主页语音和 Command Center 现在共用同一个长期会话——你在这边聊的内容，换个入口它还记得
- **它会记事了**：新增 `memory.md` 长期记忆文件。你说「记住我周五有周报」，kimi 会自己写进去，以后每次对话都带着这些记忆。记忆文件在用户层，随时可看可改
- **悬浮窗会话列表置顶显示「⭐ 主会话」**，随时可以进去跟这个「本体」接着聊，你自己的临时会话照旧分开

### 数据不再裸奔

- 所有用户数据（任务/组件/布局/雷达配置）写入改**原子写**——写一半断电也不会留半截坏文件
- **每日自动备份**：`~/.jarvis-workspace/backups/` 按日期滚动快照，保留 7 天，任务和组件库丢不了

### 上一轮的修补（随本轮一起）

- **任务启动不再被掐断**：点 ▶ 启动任务后，会话框打开看实况，切换进出都不会中断执行（根因：kimi 的 load/resume 会取消在跑的回合，现在执行中会话完全只读）
- 任务详情按钮回归 + 卡片 ▶ 播放键；改项目保存失效的 TDZ bug 修复
- 会话分类：全部 / Chat / Auto，右键可改；后台会话残骸运行时自动清扫

## 技术更新

### Shell 架构

- workbench 窗口升级为 Shell：`#hud-shell`（导航轨 + 页面容器），页面常驻 DOM 只切显隐（`core/nav.ts` 的 `activatePage`）；Dashboard 页从 `display:none` 恢复时 `refreshStage()` 重算画布
- 主页渲染逻辑从 `src/renderer/home/` 移植为 `src/renderer/workbench/pages/home.ts`，监听全局只绑一次，页面只是容器
- 玻璃拟态 token：`--glass-bg / --glass-blur / --glass-border`，只用于容器面板，canvas 动画区不加 blur（性能）
- 旧 home 窗口退役（不再创建，消除 TTS 双播报）；⌘⇧J / Tray / chat ▦ 全部改指 workbench

### 主会话常驻模型（design-v4 §10.1）

- `ACPManager.mainSessionId`（持久化到 settings.json）：`homeAsk` 与 `workbenchAsk` 统一走 `mainAsk`，`mainQueue` 串行（kimi 单会话不并发）
- memory 注入：`readMemory()` 尾部截断 4KB，以 `[长期记忆]` 前缀拼进主会话 prompt；`~/.jarvis-workspace/memory.md` 首次自动初始化
- AGENTS.md managed 区新增 memory 维护约定（条目带日期、过时删除）
- 会话列表：`SessionMeta.main` 标记，渲染层置顶 + ⭐ 徽章

### 数据完整性

- `writeJson` 全部改 tmp+rename 原子写（store.ts / workbench.ts）
- `src/main/backup.ts`：每日快照（tasks/layout/library/engines/projects/agents.md/memory.md/radars）→ `backups/<date>/`，6h 检查一次，超 7 天自动清理

### 会话修复（续上轮）

- 执行中会话：`busySessions` 跟踪，`prompt()` 入口同步置位；`loadSession` 遇 busy 会话**零 ACP 调用**（探针实测 kimi 0.31.1 的 load 和 resume 都会 cancel 在跑回合），靠共享连接的 session/update 看实况
- 回放历史剥离 `<system-reminder>` 管道文本

## 已知遗留

- Zen 页（彩色边缘光影）、Plugins 市场、Signals 总线、Phone Video → V4-B/C
- widget_modify 仍只在 dev 环境可用（打包后无 src/），产品化单独立项
- 主会话轮换（context 将满时交接摘要 + 新会话接续）未做，当前是单会话持续累积
- memory.md 的定期自整理（去重/合并）依赖 AGENTS.md 约定由 kimi 自觉执行，无强制机制

---

# V4-B/C（2026-08-23 补）：Zen、Plugins、Signals、Vision

## 功能更新（大白话）

### Zen 模式

- 导航轨进 Zen：整页只有中央大 orb（主页 1.5 倍），纯黑微网格——这是「跟 Jarvis 独处」的模式
- **彩色边缘光影**：kimi 输出或播报时，屏幕四周边缘泛起青→蓝→紫的流动呼吸光晕，说完收敛回微弱底光
- 右下角菜单键：显示消息框（默认隐藏，玻璃面板看对话记录）/ 添加组件 / 麦克风（占位）/ 退出 Zen

### Plugins 组件市场

- 市场区 = 内置组件 + 3 个官方预设（世界时钟 / 待办清单 / 天气），「我的组件」区 = 组件库
- 每张卡片可以：**添加到 Dashboard** 上画布、**钉到导航轨**（左侧导航多一项，点开整页使用该组件，hover 可取消钉）、重命名、删除
- 「与 AI 创建」一键跳 Forge 工坊

### System as an Agent 落地

- **Signals 信号总线**：系统事件（组件改动、雷达抓取、专注完成、任务逾期）汇入统一事件流，主会话每次对话都会带上「近期系统信号」摘要——它真的知道系统刚刚发生了什么
- **会主动说话了（受控）**：番茄钟完成 → 语音播报「专注结束，休息一下」+ toast；雷达抓到 ≥3 条新内容 → 右下角弹出信息卡，点「打开雷达」直达信息流；每天 9 点后检查任务逾期并提醒
- **Phone Video 组件**：数据线连 iPhone 开录影模式，组件里直接看到手机画面；打开 Vision 模式后按 0.2/0.5/1 fps 截帧发给主会话——你可以直接问「我手机上这是什么」

## 技术更新

- `pages/orb.ts` 共享 orb（home 420px / zen 630px 等比缩放）；Zen 光影 = CSS 双层（hue-rotate 流动 + 边缘渐变呼吸），streaming 按 mainSessionId 过滤、speaking 按字数估算窗口
- 钉导航：`kimi-nav-pins`（localStorage），pin 页懒挂载，库 artifact 激活时取最新 html（scoped document 注入）
- `src/main/signals.ts` ring buffer（500 条）+ `recentDigest()` 注入主会话 prompt（`[近期系统信号]` 块，与 memory.md 并列）
- 反应回路：`core/reaction.ts` 统一卡片（kind 配色 / open-widget 直达 / dismiss），主进程确定性触发器（focus 完成 speak+notify、radar ≥3 发卡片、逾期日检 notify）
- Phone Video：`getUserMedia` 匹配 iPhone/Continuity 设备 → video 播放；Vision = canvas 768px JPEG 截帧 → `homeAskImage`（主会话支持 image content block）；组件移除自动停帧停流

## 已知遗留（V4 收尾）

- macOS 相机权限首次需授权；未授权时 enumerateDevices 返回空 label（组件显示未检测到）
- Vision 截帧按固定帧率发送，不做场景变化检测（后续可加关键帧判断）
- speaking 光晕按字数估算（主进程暂无 TTS 开始/结束事件）
- widget_modify 仍限 dev 环境；主会话轮换未做

---

# V4 迭代（2026-08-23 下午）：Agents 板块 + Zen 视觉 + 呈现层

## 功能更新（大白话）

### Agents 板块（导航 ✎ 落地）

七个分区：**Agent 设定**（agents.md 编辑）、**长期记忆**（memory.md 编辑）、**声音 Voice**（英文/中文声音下拉 + 试听 + 语速三档）、**工具 Tools**（13 个 MCP 工具逐个开关）、**权限模式**（default/auto/yolo）、**反应回路**（番茄钟播报/雷达卡片/逾期提醒开关）、**数据**（立即备份）

### TTS 声音体系

- 每个回复按主语言整段选声（CJK >30% 用中文声）——**否决了句中分段换声**（更机械更碎）
- macOS `say` 全量声音可选 + 试听 + 语速（slow/normal/fast）

### Zen 视觉重做（三轮调优）

- orb：机械环 → Apple Intelligence 风多彩光球（粉/蓝/紫/青渐变，低清放大实现大模糊）→ 按反馈继续收敛：去绕圈轨道（防晕）、正圆居中、边缘羽化、动效幅度减半（发送/回复只「轻轻动一下」）、尺寸 630→460
- 边缘光影：扫描线式流动 → Siri 式四周柔和渐变光带缓慢呼吸
- 字幕条：thinking 三点 → 按 TTS 节奏逐句点亮上滚 → 播完**停留 15s** 再淡出（没听完也能看完）
- 消息框默认不展开（只动效反馈）；Zen 可添加组件（浮层可拖可缩放）；Zen 停止按钮 ⏹；Zen 权限卡片（琥珀玻璃卡，三按钮）

### 呈现层（Generative Presentation，design-v4 §12）

- **三原语**：`present`（语音开组件到 Zen，没有则提示先 Forge 创建）、`present_artifact`（结构化 spec → 图文信息卡）、`dismiss`（按名/最近关闭）
- **两层呈现**：快路径模板库（news-digest / data-card / gallery，原语组合 header/media/list/body/actions）+ 慢路径自由 HTML；未知 kind 降级 list，item 字段缺失逐级降级
- **等待态外显**：占位浮层（玻璃虚线框 + 扫描线 + `COMPOSING…` → 原地替换；失败红框不残留
- **AGENTS.md 写入呈现协议**：什么时候该呈现、spec 规则（items ≤7、image 只要真实 http URL）、present/dismiss 语义——工具用法是系统教给 agent 的，不靠猜
- e2e 实测：查 AI Industry 雷达 → 自动组织 news-digest → Zen 出卡片

## 技术更新

- `present_artifact/present/dismiss` 三 MCP 工具（zod 校验 spec）；`core/presenter.ts` 渲染器；`mountZenFloat` 模块级导出 + 浮层登记册统一管理
- **TTS 收拢** `core/voice.ts`：主会话任何入口的回合结束统一播报
- **共享日志** `core/main-log.ts`：主页/Zen 渲染同一份主会话记录；启动时 `session/load` 回放历史；`/new` 轮换主会话
- **vision 语义修正**：截帧只更新 `vision-store` 缓存（30s 新鲜度），用户发消息时自动附带最新帧——不再定时骚扰 AI；关 Vision 清空缓存

## 关键 bug 与教训（设计思考）

1. **resume 不挂 MCP**：重启后主会话 `resumeSession({mcpServers: []})` 恢复得「没有工具」，agent 退化成 Bash true 硬试。教训：**协议文档（AGENTS.md）和工具挂载必须同时在线**，缺一个都是哑炮
2. **invoke/on 不匹配**：renderer 用 invoke 回传工具回执、主进程用 on 收，回执永远丢 → agent 看到超时（其实执行成功了）。IPC 通道类型必须成对检查
3. **mainSessionId 缓存过期**：Zen/main-log 初始化缓存一次主会话 id，会话轮换后 `isMain` 过滤全丢 → Zen 永远「正在思考」。修复：主进程轮换时推送 `evMainSession`，三处实时同步。教训：**任何缓存的会话 id 都要有失效/更新通道**
4. **动态查询 > 静态注入**：组件清单从「prompt 里的旧摘要」改为渲染层启动时同步注册表 + `system_query widgets` 域现查现读
5. **hidden 语义被 CSS 覆盖**：`display:flex` 盖掉 `[hidden]` 属性导致 Zen 菜单/消息框失灵——author 样式必须配 `[hidden]{display:none!important}` 守卫

## 已知遗留

- widget_modify 仍限 dev 环境（打包无 src/）
- 主会话轮换策略（context 满时交接摘要）未做，目前 /new 手动轮换
- Phone Video 窗口捕获需「屏幕录制」权限；QuickTime 关窗后需手动重试

---

# TTS 调研与流式语音（2026-08-23）

## 调研结论（本地部署、快、中英混合）

| 方案 | 体积/速度 | 中英质量 | 集成 | 结论 |
| --- | --- | --- | --- | --- |
| **Piper** | ~100MB，CPU 实时 | 中文可接受、英文自然 | 单二进制 spawn | **v1 采用** |
| Kokoro (MLX) | 82M，Apple Silicon 快 | 多语言，质量更好 | MLX/Python | v2 升级路径 |
| CosyVoice 3 | 0.5B+ | 中文顶级 | Python 环境 | 质量优先时选 |
| macOS say | 零依赖 | 机械 | 现状 | 保留为 fallback |
| edge-tts | 神经网络级 | 好 | 需联网，不符合本地 | 排除 |

- Piper 二进制：`rhasspy/piper` release `piper_macos_aarch64.tar.gz`（Apple Silicon）
- 语音模型：HuggingFace `rhasspy/piper-voices`（onnx + onnx.json），默认 `en_US-amy-medium` / `zh_CN-huayan-medium`

## 流式 TTS 设计（解决「等全文才开口」）

**问题**：turnDone 才播报 → 长回复首音延迟十几秒。

**方案：句子级流式播报管线**

```
chunk 流 → 句子切分器（。！？!?\n 且长度≥4 才出句）→ 播报队列（串行）→ Piper/say
```

规则（保体验、防 bug）：

1. **只说完整句**：chunk 累积到句末标点才出句；turnDone 时 flush 剩余缓冲
2. **跳过代码**：跟踪 ``` 围栏状态，围栏内内容不入语音（围栏跨 chunk 也正确）
3. **单队列串行**：一次只播一句，不打断自己；新一轮回合开始 → 清空队列 + ttsStop + 从新句开始
4. **首音延迟** ≈ 第一句完成时间（通常 1-3s），与回复长度解耦
5. 每句独立判断中英（CJK>30% 中文声），provider 可插拔（say / piper）

---

# 能力清单合一 + Piper 音色体系（2026-08-23 晚）

## 单一能力清单（capabilities.ts）

**问题**：能力声明散在代码各处（TOOL_META 手写、新增工具没进列表、AGENTS.md 手写散文），agent 无法自我感知，Agents 页工具面板过时。

**方案**：`src/main/capabilities.ts` 作为唯一事实源（16 个能力，含 usage 提示），四处全部从它生成：

1. MCP 工具注册（含禁用过滤）
2. Agents 页工具面板（wbToolsList 同源，present_artifact/present/dismiss/system_query 全部在列）
3. `system_query` 新增 `capabilities` 域——agent 可随时查「我有哪些工具、怎么用」
4. AGENTS.md「可用系统工具」一节**每次启动自动生成**（含启用状态）

闭环：能力清单 → 工具注册 → agent 可查（capabilities）→ 可读规则（AGENTS.md 自动生成）→ 执行 → 记录（signals/evolve）。加能力 = 清单加一行 + handler 实现，全部自动同步。

## Piper 音色体系

- 音色目录：中文 huayan 2 档 + 英文 12 个精选，模型按需自动下载
- 官方 macOS 包是坏包（x86_64 + 缺 espeak-ng 库）→ pip 版 piper-tts（venv 在应用数据目录）
- Agents 页声音区：引擎选项卡（Piper / macOS say）+ 分模式音色下拉 + 试听
- 流式语音（句子级切分、首音 1-3s、代码围栏跳过）

## 关键 bug 链（同日）

- resumeSession 不挂 MCP → agent 无工具退化为 Bash 硬试（教训：协议文档与工具挂载必须同时在线）
- invoke/on 回执不匹配 → 工具执行成功但 agent 看到超时
- mainSessionId 缓存过期（Zen/voice/main-log 三处）→ evMainSession 事件推送

---

# 数据平面（Data Plane）落地（2026-08-23 深夜）

对应 `design-data-plane.md`。核心：读收敛到一个 SQL 工具，写分层（通用写 + 行为工具），SQLite 为唯一事实源。

## 实现

- **jarvis.db**（SQLite WAL）：tasks / projects / radars / radar_items / library / engines / signals 七张表；启动时从 JSON 一次性幂等迁移（22 任务、6 雷达、445 条目、3 组件、5 项目、5 引擎，实测一致）；JSON 降级为导出/备份
- **存储层切换**：workbench.ts 全部 CRUD 改 DB（签名不变，调用方零改动）；radar.ts 条目入 radar_items 表（fetch/去重/插入走 SQL）
- **三个新 MCP 工具**：
  - `data_schema()`：表/列/行数自发现
  - `data_query(sql)`：只读 SELECT（非 SELECT 拒绝 + 100 行截断 + 5s 超时 + 错误回传自我修正）
  - `data_exec(sql)`：UPDATE/INSERT/DELETE 护栏（禁 DDL、必须 WHERE、表白名单、执行前行级快照 → evolve_undo 可回滚）
- **AGENTS.md Agent Loop**（managed 区）：看结构 → 查数据 → 纯修正走 data_exec、行为操作用专用工具； capabilities 清单同步加三项
- **undo 扩展**：evolve.ts 支持 db:// 行级快照恢复

## e2e 验证

- 「data_schema 看结构 + data_query 查 Academic Radar 最新 3 篇」→ agent 自主完成并答对（此前它瞎编 info_list/info_overview 拿不到）
- 护栏实测：`UPDATE tasks SET priority='urgent'` 无 WHERE → 拒绝；带 WHERE 查询正常

## 设计要点（为什么这是通用解）

新数据域 = 加一张表，自动可查——不加工具、不改 AGENTS.md。SQL 是模型母语，不再有幻觉工具名。读无限、写有限的分层是鲁棒性的来源。

---

# Thinking 模式开关 + 思考可视化（2026-08-23）

## 功能

- **💭 Thinking 开关**（Zen 输入框右侧）：on = 深度思考（high），off = 轻量思考（low），即时生效并持久化。关灯后回复速度明显提升
- **思考过程可视化**：thinking 开启时，Zen 输入框上方浮出虚线卡片，**实时流式显示模型的思考过程**（mono 斜体）；正文开始输出自动消失，回合结束清理

## 实现与坑

- kimi 的 thinking 配置**只有 high/low 两档，没有 off**——开关映射为 high/low（最初按直觉发 off 被 `Unknown thinking value` 拒绝）
- 配置通道：ACP `session/set_config_option {configId:'thinking', value:'high'|'low'}`，即时生效 + settings.json 持久化
- 状态持久化在 `settings.thinking`，新会话创建时随 applySessionConfig 应用
- **UI 坑：emoji 不受 CSS color 控制**——💭 开关看着「永远点亮」，实际功能正常（日志证明）。改透明度表示状态（on=100% 霓虹青 / off=35%）
- 副产物发现：configOptions 响应含 **model 选择器**（kimi-code/k3）——快慢模型分层有现成通道，留待后续
