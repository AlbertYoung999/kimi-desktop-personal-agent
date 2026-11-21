# 更新记录 2026-08-22（V3：任务系统 + 自进化收尾）

> 本地更新记录（gitignored，不进仓库）。本轮主题：**Task Flow 完整化**、**Tray**、**自进化 E2/E3 落地**。

## 功能更新（大白话）

### Task Flow v3.0

- **重复任务**：任务可设「每天/工作日/每周」重复——完成后自动归档，看板里自动长出下一次的卡片（工作日自动跳过周末）；卡片有 ↻ 标记
- **项目归属**：任务挂到带颜色的项目下，看板顶部按项目筛选/分组（项目功能最初由 kimi 通过 widget_modify 自建，本轮补齐颜色体系）
- **一键启动任务**：卡片右下角 ▶ 或详情「启动 Session」，kimi 直接开工——payload 带备注、任务自动转 in_progress，会话框实时看执行
- **详情自动保存**：字段改动 800ms 防抖落盘 + ⌘S 立即保存，保存/删除/取消按钮常驻
- **看板排序**：优先级（urgent→low）+ 修改时间倒序

### 桌面任务栏（Tray）

- macOS 菜单栏蓝色小球图标：打开主页 / 打开工作台 / 悬浮球显隐 / **退出**（此前只能杀进程）

### 自进化 E2/E3

- **E2**：task_complete/task_update/radar_update/artifact_modify/evolve_undo 五个新工具；演化日志（evolve.jsonl）+ 快照式撤销；「演化日志」widget
- **E3**：`widget_modify`——对话直接改内置 widget 的 TS 源码（kimi 是编码 agent）→ 自动 esbuild 重建 → 热重载；构建失败自动回滚；快照在 agent 动手前捕获；undo 联动重建；widget 挂载 error boundary
- **权限与 UX**：自有 MCP 工具自动批准（此前卡死在看不见的权限条）；权限卡片搬进 Command Center；⏹ 停止按钮 + AUTO 开关（yolo 语义）；工具调用行显示工具名+参数摘要

### 会话回收与修复

- **会话回收**：askOnce 共用「工具会话」（队列串行 + 计数轮换），残骸延迟 5 分钟运行时清扫 + 启动兜底——会话列表不再被后台会话刷屏
- **执行中会话零调用**：实测 kimi 的 load/resume 都会掐断在跑的回合——打开执行中会话不发任何 ACP 调用，纯靠共享连接看实况（修了「启动任务就中断、等不到结果」的主 bug）
- 回放历史剥离 system-reminder 管道文本

## 技术更新

- `Task.recurrence` / `Task.projectId` / `Project.color` 数据模型；重复实例在主进程 saveTask 生成
- 菜单栏 Tray：`src/main/tray.ts` + 手绘托盘图标（PIL）
- E3 关键决策：内置 widget 可动 = 源码编辑（非 HTML 变体）；fs 沙箱改为按会话 cwd 隔离；widget_modify 专用会话绑定仓库 cwd
- 执行中状态 `busySessions` 跟踪，prompt() 入口同步置位防竞态

## 已知问题（已在 0823 轮修复）

- TDZ 回归（详情面板按钮消失 + 自动保存失效）→ 0823 修复
- 主会话重启后 Unknown sessionId → 0823 修复（attach-once）
