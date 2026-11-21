# 2026-08-28/29 · v0.5.0 开发记录

## 需求（prd.md v5.0）

1. Task Flow 子任务：挂载主任务下，子任务启动 session 注入主任务上下文
2. 今日待办 tab + 可 pin 到桌面的实时快照组件（查看/完成/同步/番茄钟/统计复盘）
3. 日程管理 tab：周时间网格规划任务执行时间（参考飞书日历），拖拽排期
4. 声音分模式开关：全部 / zen / 悬浮窗，关闭则不自动 TTS

## 开工前与用户确认的决策

- 子任务只支持一层（不嵌套）
- 桌面组件做可拖动小面板（不用灵动岛窄条，放不下列表和按钮）
- 日程视图一步到位做拖拽排期（不做「只能选时间」的 MVP）
- 声音开关粒度：总开关 + zen + 悬浮窗三个

## 关键设计

### 数据面
- `tasks` 加三列：`parent_id` / `scheduled_start` / `scheduled_end`。CREATE TABLE IF NOT EXISTS 不会给旧表加列 → PRAGMA table_info 探测 + ALTER TABLE 列级迁移
- 新表 `pomodoro_sessions`（task_id / started_at / ended_at / minutes / completed）
- 删除主任务级联删子任务（`DELETE WHERE id=? OR parent_id=?`，一层无需递归）
- 重复任务 spawn 下次 occurrence 时清掉 scheduledStart/End（排期不继承）

### 番茄钟引擎（main 进程，pomodoro.ts）
- 为什么不挂在 deep-focus widget 里：面板关掉计时器就死了。main 持有状态 + setTimeout，任何窗口（今日 tab / 桌面面板）都能 start/stop，状态 `evPomodoroState` 全窗口广播
- 切换任务时先把进行中的番茄按「未完成」落账，不丢记录
- 提前停止按实际 elapsed 分钟记账（最短 1 分钟）

### 实时同步
- 任务 save/delete 后 main 广播 `evTasksChanged` → 今日 tab 和桌面面板重新 listTasks
- 桌面面板：320×440 frameless 透明窗，alwaysOnTop screen-saver 级 + 全工作区可见（复用 focus-pill 的窗口模式），标题栏 `-webkit-app-region: drag` 拖动

### TTS 门控矩阵（避免双重播报的关键）
| 场景 | 开关 |
|---|---|
| workbench 主会话（Zen + 会话面板） | 总 + zen（voice.ts） |
| voice-first 主页 | 总 + zen |
| 悬浮窗普通会话 | 总 + chat（chat/index.ts 新增播报） |
| 悬浮窗里的主会话 | 不在 chat 播报，统一走 voice.ts |

门控都在渲染层读 settings；undefined 一律视为开。voice.ts 每回合开始刷一次缓存，不逐句 invoke。

### 日程视图交互
- 周网格 06:00–24:00，色块按 scheduledStart~End 定位（无 end 默认 1h）
- HTML5 DnD：未排期侧栏拖入网格定时间，网格内拖动改时间、底边把手 resize 改时长，全部对齐 30 分钟
- dragover 读不到 dataTransfer 内容 → 用模块变量 schedDragId 记录被拖任务

## 实施方式

地基（类型/DB/引擎/窗口/IPC/preload）我亲自打，三个并行子代理施工：
- A：task-flow.ts 三功能（1225→1750 行）
- B：todo-panel 渲染层 + 构建接线
- C：声音开关 + 三处门控

typecheck + build 通过，重启后 DB 迁移验证（三列 + pomodoro_sessions 表就位），无报错。

## 迭代 1（用户实测反馈）

1. **今日列表完整性**：子任务自身命中或父任务命中今日条件都纳入（面板 + tab 同一规则）；今天完成的任务不移除，划线淡化置底，可取消勾选回 todo
2. **图标语义**：番茄钟 ▶→⏰（▶ 专属「启动 Session」）；排期时间用 🕐 文本避免撞图标
3. **打勾不同步根因**：task-flow widget 只在 mount 时 reload → 加 `evTasksChanged` 监听（`body.isConnected` 兜底，与现有生命周期模式一致）；面板侧 saveTask 确认传完整 task 对象
4. **灵动岛复用**：番茄钟 start/finish 走 `pushFocusStatus`（deep-focus 同一通道），focus-pill 新增按 `startedAt+durationMin` 本地每秒倒计时（原模式靠 deep-focus 每秒推 remainingMs）
5. **面板日程视图**：列表/日程分段切换（localStorage 记忆），当天 06–24 时间轴 + 优先级色块 + 现在时刻红线；只读，重叠色块不错开（已知简化）

## 迭代 2（用户实测反馈）

1. **今日列表子任务嵌套**：不再平铺独立行——父任务在列表时子任务缩进渲染在其下（左侧竖线 + 小一号），父任务不在才顶层带 ↳ 标注；排序按组（done 置底时子任务随父任务一起下）；tab 与面板同一套分组逻辑
2. **hover 双按钮**：今日行（tab + 面板）hover 显示 ⏰ 番茄钟 + ▶ 启动 Session（▶ 对齐看板行为：已有关联 session 直接打开，否则 status→in_progress + payload 注入父任务上下文 + 回写 sessionId）；done 行无按钮；计时中行按钮常显
3. **面板可缩放**：frameless 无原生缩放边 → 右下角 grip 手柄 + `resizeTodoPanel` IPC（起始尺寸+总位移，不累加防漂移；最小 280×320；运行内记住尺寸）；卡片从固定 320×440 改 100% 流式

## 迭代 3（用户实测反馈，8/31 周一发现）

1. **跨天不刷新**：「今天」只在 mount 时算一次 → 30s 轮询日期 key（面板独立 interval；tab 复用 1s pomoTick），跨天自动 reload，标题栏日期每次渲染重算。已知：系统休眠唤醒后最长 30s 内仍是昨日数据，下一个 tick 自愈
2. **过期任务折叠区**：今日列表底部「▸ 已过期 · N」（dueDate/scheduledStart 早于今天的未完成项；与今日列表去重——in_progress 且昨天截止的只出现在今日区）。默认折叠、展开状态持久化（tab 用 ctx.config / 面板用 localStorage）。行复用今日行全部交互（勾完成/⏰/▶），标题前暗橙过期日期；子任务嵌套规则与今日区同一套（groupSubs 共享函数）。过期区勾选完成 → completedAt 变今天 → 自动挪进 done 组

## 迭代 4（灵动岛形态）

1. **今日待办面板 → 灵动岛**：默认收起为 240×48 pill（focus-pill 同款样式，整条可拖动），悬浮展开、离开 200ms 后收起（interacting 计数器保护：拖标题栏/缩放手柄期间不收起；先切 DOM 再 setMode 防闪烁）
2. **pill 双态内容**：番茄钟中 → 脉冲点 + 任务名 + 倒计时；否则 → 「今日 X/Y」+ 完成比例进度条；无任务 → 「今日无待办」
3. **倒计时外显去重**：今日岛开着时番茄钟不再弹 focus-pill（pomodoro.ts 按 getTodoPanelWindow 判断），不开才回落
4. 主进程：`setTodoPanelMode`（锚定右边缘缩放）+ 窗口初始即 pill 尺寸 + 展开尺寸记忆

## 迭代 5（收展交互 + 快速创建）

1. **收展改手动**：pill 悬浮/双击展开；移除 mouseleave 自动收起（200ms 定时器/interacting 保护全删）；展开态标题栏加「—」收起按钮，只有点它才收回。注：pill 是 app-region drag 区，dblclick 可能被拖动手势吞，但 mouseenter 悬浮展开事实上覆盖了双击场景
2. **底部快速创建**：统计条上方加输入行（回车/＋），构造完整 Task（priority medium、startDate=今天必命中今日过滤）saveTask 落库，evTasksChanged 广播联动 task-flow 刷新；先清输入再 await，连续添加不卡手
