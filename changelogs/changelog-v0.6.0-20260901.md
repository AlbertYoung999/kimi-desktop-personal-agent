# 2026-09-01 · v6.0 开发记录

## 需求（prd.md v6.0）

Task Flow 自主规划模式：「新增」下拉出「新建规划」——输入主任务描述 + 项目 + 模式（快速学习 1d / 完整学习 2-5d）+ 补充 → ACP 联网调研并分解路径 → 用户编辑调整 → 确认后批量创建带排期的子任务。

## 开工前确认的决策

- 起始日：从今天开始排（day=1 即今天）
- 时间块：agent 自由排（1-3h/块、每天 2-4 块、不排 23:00 后），用户结果页可逐行改
- 过程呈现：后台 askOnce + loading，不开可见 session

## 关键设计

- **通道**：复用 acp.askOnce（utility session 自动批准工具权限/联网/串行队列），新增 `wb:plan-generate` IPC，timeout 600s（forge 是 300s）
- **输出契约**：首行 ≤100 字调研摘要 + 唯一 ```json 代码块（subtasks: title/description/day/start/end）；解析三级回退：json 代码块 → 最大 {} 包裹 → 裸 [] 数组
- **弹窗状态机**：form → loading（扫描线动画）→ result（逐行可编辑：day 步进/time/标题/删除/加行）→ error（原始回复折叠 + 重试保留输入）；与任务详情弹层互斥
- **落库**：主任务 dueDate=最后一天 23:59；子任务 parentId 挂主任务、priority medium、scheduledStart/End 本地 naive `YYYY-MM-DDTHH:mm`（日程视图 new Date() 本地解析，与拖拽排的 UTC ISO 殊途同归）
- 创建完成自动切到「日程」视图，立刻看到排好的路径
