# Kimi Desktop Personal Agent

常驻 macOS 桌面的 Kimi 个人智能体：voice-first 主页 + 自进化工作台 + 悬浮小球的 all-in-one 桌面助手。后端通过 **ACP（Agent Client Protocol）** 接入你本地的 `kimi` CLI，模型能力和工具调用全部由 kimi-code 提供。

![一图说明](docs/overview.png)

## 设计目标

- **Always-on**：不打断当前工作流，全局快捷键随叫随到
- **轻入口重后端**：UI 只做交互，对话、工具、会话持久化全部交给 `kimi acp`，本地不重复实现 agent 逻辑
- **灵感有处可去**：对 Kimi 说一句「收藏这个」，内容自动沉淀为本地 markdown，可修改、可追溯

<!-- 截图占位：悬浮球 / 对话窗 / 暗色模式 -->
![alt text](docs/image-1.png)
![alt text](docs/image-2.png)
![会话管理](docs/image-3.png)
![meta prompt](docs/image-4.png)

## 用它做了什么？
1. 私人美术馆
> 后续也会计划开源
![alt text](docs/image-5.png)
![alt text](docs/image-6.png)
![alt text](docs/image-7.png)
2. 异步分析开源项目代码
![alt text](docs/image-8.png)
3. 随身助手：解释原理、问个单词...
![alt text](docs/image-9.png)
4. Voice-first 主页：文字输入 + TTS 语音播报，左侧实时系统指标
![voice-first 主页](docs/voice-agent-homepage.jpg)
5. 个人工作台：可对话自进化的 widget 系统
![Personal Dashboard](docs/Personal%20Dashboard%20v1.0.jpg)
More..

## 个人工作区：Self-Evolving Workbench

> 工作台不是一组写死的功能，而是一个**可以通过对话持续生长**的系统。

**关键理念**

- **工具即能力**：工作台内嵌 MCP Server，widget 能做什么就暴露什么工具。kimi 通过原生 tool calling 操作工作台——参数由 schema 强制校验，执行结果回传给模型，它能自我修正、多步编排。加能力 = 注册工具，prompt 一个字不用改
- **应用层都可改**：自定义组件走 `artifact_modify`（差量改 HTML）；内置 widget 走 `widget_modify`——kimi 直接编辑自己的 TS 源码，esbuild 重建后热重载。边界明确：主进程、运行时骨架不可动，数据层/组件/内置 widget 的应用层全部可动
- **可进化但不可改崩**：schema 校验（MCP 层）、构建失败自动回滚、快照撤销（undo 后自动重建）、error boundary（单组件崩溃不波及舞台）四道防线；每次操作记入 `evolve.jsonl`，逐帧可撤销

![Self-Evolving Workbench](docs/self-evolving-workbench.svg)

**实现逻辑**：用户在 Command Center 说「给 task-flow 加个项目功能」→ kimi 调 `widget_modify` → 专用会话（cwd 绑定仓库，fs 沙箱按会话隔离）编辑 `task-flow.ts` → 重建 → 工作台热重载 → 面板里的 FORGING 动效收尾，组件放大展示。修改自定义组件（如股票看板）则走 `artifact_modify`：生成新 HTML → 更新组件库 → 舞台自动重挂载。一次性生成调用共用一个「工具会话」（队列串行 + 计数轮换 + 启动时清扫），不会撑爆会话列表。

## Voice Agent：voice-first 主页

> 应用的启动入口不是一个聊天框，而是一个**活着的操作系统面板**。

**设计理念**：voice-first 意味着语音是一等公民的交互通道，界面为「听 + 说」而不是「读 + 写」优化——中央的语音 orb 是状态的唯一主角（READY / THINKING / SPEAKING 三态呼吸动画），左右两侧只是上下文：左边是机器的状态（CPU / RAM / DISK / 网络 / 电池 / GPU / Top 进程，2 秒轮询，可开关），右边是对话的记录（EVENT LOG 流式滚动）。DASHBOARD 一键进入工作台。

![Voice Agent](docs/voice-agent.svg)

**实现逻辑**：底部输入文字 → 独立 ACP 会话流式返回 → 右栏 EVENT LOG 实时追加；回合结束后全文经 markdown 剥离交给 macOS `say` 播报（英文 Daniel 英音、中文自动切中文 voice），播报期间 orb 切到 SPEAKING 态，说新话自动打断。TTS 走系统能力零依赖零延迟；语音输入（STT）预留 whisper.cpp 本地方案（AudioWorklet 采 16kHz PCM → 主进程写 WAV → `whisper-cli` 转写），MIC 位已预留。

## 架构

![架构图](docs/architecture.svg)

单进程多会话：一个 `kimi acp` 子进程通过 stdio 收发 JSON-RPC，所有会话挂在它上面；对话历史由 kimi 自己持久化，客户端只存索引。

## 功能

| 功能 | 说明 |
| --- | --- |
| 悬浮球 | 眼睛跟随鼠标、眨眼/转头空闲动画、思考/输出动效，可拖动 |
| 对话窗 | 流式渲染、markdown（表格/代码/链接）、思考过程折叠框、工具状态单行滚动 |
| 截图问答 | `⌘⇧K` 全局唤起 + 区域截图；也支持直接 `⌘V` 粘贴图片 |
| 预设模式(meta prompt) | 翻译 / 解释代码 / 润色 / 总结，本质是「system prompt 模板 + 用户输入」，设置里可增删改 |
| 收藏夹 | Kimi 按约定把内容写进 `工作文件夹/vault/` 的 markdown，面板内查看、编辑 |
| 会话管理 | 新建 / 恢复历史会话（`session/list` + `session/load`） |
| 消息队列 | 回复中可继续输入，消息排队挂在输入框上方，回合结束自动续发 |
| 停止 | 流式期间发送键变停止键，走 `session/cancel` |
| 交互细节 | 消息右键复制 / 选中引用提问、链接系统浏览器打开、置顶 pin、暗色主题（月之暗面） |

## 原理要点

- **ACP 接入**：`initialize` → `authenticate(login)` → `session/new`；prompt 以 content block 发送（文本 + base64 图片），回复经 `session/update` 流式推送（正文 chunk / 思考 chunk / 工具调用）
- **权限**：kimi 的每次工具调用通过 `session/request_permission` 反向 RPC 询问客户端，悬浮窗弹确认条（允许 / 本会话允许 / 拒绝），也可在设置里切自动模式
- **文件安全**：`fs/read_text_file` / `fs/write_text_file` 反向 RPC 在主进程做了路径沙箱，只允许工作文件夹之内
- **收藏夹约定**：首次启动在工作文件夹写入 `AGENTS.md`，声明 vault 目录的记录规范，kimi 启动时自动读取遵守

## 快速开始

```bash
# 前提：macOS，已安装并登录 kimi CLI（kimi acp，>= 0.31）
npm install
npm start        # 构建并启动
npm run watch    # 开发模式
```

首次使用在设置里选择工作文件夹（默认 `~/KimiWorkspace`）；首次截图需授予 macOS「屏幕录制」权限。

## 配置

运行期配置都存放在系统用户目录（`~/Library/Application Support/Kimi Desktop Personal Agent/`），不进入仓库：

- `settings.json` — 工作文件夹、vault 目录、权限模式
- `modes.json` — 预设模式的自定义与删除记录

## TODO
- 跨session管理
- multi-agent项目管理
- 与手机关联，直接在移动设备操控本地电脑
- 加上搜索引擎
- 个人工作台看板
- 全双工实时语音对话
..more

## License

MIT
