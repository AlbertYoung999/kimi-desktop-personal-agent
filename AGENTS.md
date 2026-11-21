# AGENTS.md

Kimi Desktop Personal Agent —— macOS 桌面常驻 AI 助手。Electron 应用,通过 ACP(Agent Client Protocol)接入本地 kimi-code CLI,核心形态:桌面悬浮球 + 悬浮对话窗 + Jarvis Workbench(单窗口多页:主页/Dashboard/Channel/Zen/Plugins/Agents)。

## 技术栈与结构

- **无前端框架**:渲染层全部手写 DOM,esbuild 打 IIFE bundle;主进程 TypeScript → tsc
- **原生依赖**:better-sqlite3(jarvis.db)、node-pty(内嵌终端,postinstall 会 chmod spawn-helper)
- 目录:
  - `src/main/` — 主进程:acp.ts(ACP 单连接多 session)、index.ts(IPC 注册)、db.ts(sqlite)、session-scanner.ts、group-orchestrator.ts、worktree-manager.ts、terminal-manager.ts、agent-library.ts、session-config.ts、radar.ts、mcpserver.ts(workbench MCP)等
  - `src/preload/` — contextBridge 桥(window.kimi)
  - `src/renderer/` — 各窗口:ball(悬浮球)、chat(悬浮窗)、workbench(主窗口)、home、todo-panel、preview、focus-pill、`shared/chat-panel.ts`(对话面板工厂)
  - `src/shared/types.ts` — IPC 通道常量与共享类型
  - `design/` — 内部设计文档(gitignored)
  - `changelogs/` — 各版本开发记录(进仓库)
  - `prd.md`(gitignored)— 需求与已确认决策的唯一事实源

## 常用命令

```bash
npm start          # 构建并启动(开发主流程)
npm run build      # build:main(tsc)+ build:renderer(esbuild + copy)
npm run typecheck  # main + renderer 双 tsconfig
```

改完代码**必须**跑 `npm run typecheck && npm run build` 通过后再交付。不新增 npm 依赖(确有需要先与用户确认)。不做任何 git 操作,除非用户明确要求。

## 架构约定(改动前必读)

1. **IPC 三段式**:通道常量在 `src/shared/types.ts` 的 IPC 对象 → `src/preload/index.ts` 暴露 → `src/main/index.ts` 注册 handler → `src/renderer/api.d.ts` 类型镜像。四处必须同步。命名空间:`acp:`/`wb:`/`ch:`(channel)/`term:`(终端)/事件 `ev*`。
2. **对话面板工厂**:`src/renderer/shared/chat-panel.ts` 的 `createChatPanel(container, opts)`,悬浮窗与 channel 页共用。改对话 UI 一律改工厂,不在宿主里另造。样式在 `chat-panel.css`(`.kp-` 前缀,几何值写死以跨宿主一致)。
3. **ACP 铁律**(实测得出,违反会丢数据):
   - 永不 load 忙中的 session(session/load 会杀进行中的 turn)——一切入口走 `ACPManager.openSession`(history/live/stale 三分支 + busy 守卫 + 防抖令牌);
   - 永不 prompt 被终端持有的 session(双进程会双写 wire.jsonl)——`externallyHeld` 接管/交还握手;
   - 同 session 不并发 prompt(用 busySessions 互斥/队列)。
4. **session 数据源**:扫描 `~/.kimi-code/sessions/`(state.json + session_index.jsonl,**只读不写**)为主,ACP session/list 为辅;本地元数据置顶/归档/mode/model/thinking/最后一条消息在 sqlite `channel_meta`。
5. **per-session 设置**(mode/model/thinking):channel_meta 列存覆盖,`applySessionConfig` 按「覆盖 ?? 全局/默认」重放;外部改动(TUI)经 `config_option_update`/`current_mode_update` 回传,带防假覆盖 guard。
6. **kimi 能力**:ACP session 11/11(fork/delete/close 经 SDK unstable_*);`session/new` 不支持绑定 agent profile——常驻 agent 用 `<system-reminder>` 包裹的首轮注入模拟;模型/思考/模式经 `set_config_option` 即切即生效。

## Changelog 规范(每次迭代必做)

- **`CHANGELOG.md`**:全版本总记录(Keep a Changelog + SemVer),每个版本一段摘要,指向详细记录文件;
- **`changelogs/changelog-v{semver}-{YYYYMMDD}.md`**:每个子版本一份详细开发记录,日期 = **新版本开始的日期**(不是完成日期),内容含需求/决策/关键设计/bug 根因/遗留;
- **时机**:迭代完成即更新这两处;**推 GitHub 时**确认 changelog 与版本号(package.json `version`)一致;
- 当前版本:**0.7.0**(channel 模式,`changelogs/changelog-v0.7.0-20260920.md`)。

## 文档约定

- `prd.md`:需求池 + 已确认决策(用户拍板后记录,含日期);
- `design/`:大功能开工前先写设计文档(参照 design-v7.md 的结构:决策速览/架构/数据/机制/IPC 清单/分期/风险);
- 代码注释引用设计文档用相对路径(如 `design/design-v7.md §3.2`)。

## 测试与验证

- 无单测体系;验证 = typecheck + build + 关键路径手测/冒烟脚本(临时脚本用完即删);
- 涉及 ACP 行为的改动,优先写一次性探针脚本实测(spawn `kimi acp` + SDK),不留猜测;
- 冒烟真实数据(如 ~/.kimi-code/sessions)时**只读**;临时库用隔离 HOME。
