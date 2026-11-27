# v0.9.0 开发记录(开始于 2026-11-22)

> 版本主题:**Super Agent(分身 GM)**——解放注意力,顶级智力分身管理 agent 团队(design/design-super-agent.md)。

## 需求与决策(20261122 锁定)

- SA = 常驻 session + 特权工具 + 专属工作区 `wbRoot()/super-agent/`;项目目录经 ACP additionalDirectories 挂载,**写项目只能由 worker 做**(guardrail 第一条);
- 默认一个 SA session,用户可多开(场景隔离防上下文污染);
- 文件基建精/少 4 件:agents.md(身份+决策边界+when-how 路由)/ memory.md / tasks.md / learning.md;
- 任务卡协议:goal/context/**acceptance(必填且可机检,evidence gate)**/constraints/report;
- 通信:SA→worker 任务卡注入;worker→SA 事件化 inbox 回执(turn-done → digest 文件 → 唤醒 SA);
- 决策边界从严:plan 阶段新建 agent/项目要人批;verify 机检自动、连挂 3 轮升级人;产出对外必须人批;矩阵写进 agents.md;
- 北极星指标:升级率(需人决策次数/推进任务数)随时间下降;
- 参考:supervisor/HITL 模式、oh-my-kimi(DAG 调度/evidence gate/live quality gates)、dsh-mobile 配对与通道经验;
- dreaming(每日进化,cron 总结进 learning.md + agents.md when-how 索引)列 P3。

## P1 实现

- **主进程**(super-agent.ts):工作区引导(4 模板文件不覆盖用户内容);SA 会话生命周期(get-or-create + 引导注入 + 跨重启 resume);**特权工具五件套**(session_digest/session_create/session_message/sa_tasks/sa_inbox,MCP `sa_key` URL 秘密门控,非 SA 不可见);回传链(worker turn-done → inbox/<taskId>.md → 状态 review + 看板移行 → sa:event → 唤醒 SA);sa_tasks 表;
- **SUPER tab**:左栏 SA 直聊(createChatPanel 全能力,SA session 切换器+多开);右栏任务看板(四 section 解析,待你决策警示置顶,退化 mdToHtml)+ 回执流(弹层全文,事件驱动刷新)。

## 待办

- P2:看板完整版(待你决策批准/驳回验收卡)、SA↔worker 对话汇总视图、session-agents/ worker 文件夹基建;
- P3:dreaming 每日进化、指标面板、决策边界迭代放宽。

## P1.5 SA 认领观察机制(2026-11-23)

- 问题:回传链只覆盖 SA 自建的 worker,已有 session 干完活 SA 收不到回执,只能轮询——「管不了已有 session」;
- 新增 `session_watch` / `session_unwatch` 工具(MCP):已有任意 session 可认领,空 acceptance → status='watching'(纯观察,每轮 turn-done 持续投回执不变状态),带 acceptance → 'in_progress'(走验收流转);
- channel 页 session ··· 菜单加「✦ 托管给 SA / 取消托管」+ goal 输入弹层;被托管 session 行显示空心 ✦ 角标(tasks.md 解析,10s 缓存);
- agents.md 模板幂等迁移:老工作区自动补 when-how 里的 session_watch 路由行。

## P2-3 SA cron 巡逻 + 设置区(2026-11-23)

- 调度器:递归 setTimeout 链(不漂移),默认开、默认 120min,SA busy/held 跳过不补;启动 2 分钟首轮建立感知;
- IPC:get/set patrol-config(enabled/intervalMin 5~1440,改动即时生效)+ run-patrol-now(busy 返回原因)+ sa:event {kind:'patrol'};
- SUPER tab 右栏第三 tab「⚙ 设置」:巡逻卡片(toggle/分段胶囊 30m~4h + 自定义分钟/上次·下次相对时间/立即巡逻一次),零乐观渲染,非法输入红边拦截。

## P2 验收卡 + 桌面通知 + 任务详情(2026-11-23)

- **验收卡**(看板「待你决策」栏):goal/验收标准/状态标(SA 验收中 vs 需要你拍板)/已打回轮次/回执预览;✓ 通过 → 归档;✗ 打回 → 内联意见框自动发回 worker 返工;**3 轮硬上限**(第 3 次拒绝执行,升级给人);worker 失联 → 自动转「待你决策」并通知;
- **桌面通知**:sa_tasks 状态变 decision(任何来源)时 Electron Notification「Super Agent 需要你拍板」,点击推 sa:event 直达;注意力纪律:只有决策点才通知;
- **任务详情弹层**:goal/验收标准/lastVerdict 引用/时间线(创建→回执→裁决)/回执全文/「在 channel 中打开」跳转 worker session(channel 页监听 kimi:open-session-in-channel);
- sa_tasks 表迁移:rounds/updated_at/last_verdict 三列。

## P1.5b 工具与看板修正(2026-11-23,真实使用反馈)

- SA 缺「列出全部 session」能力(只有查单个的 session_digest)→ 新增 `session_list`(排除 ephemeral/归档,updatedAt 倒序,上限 100);agents.md 立铁律:回答任务/session/进展类问题前必须先用工具查实时数据,禁止凭记忆(老工作区幂等迁移自动补);
- watch 看板行带 session 真实标题(`[taskId] goal —— 标题(sid12)`),看板卡首行显示实时标题(scan 映射 > 行内标题 > sid12);
- 修的正是截图里的矛盾:看板有内容而 SA 说「空的」——它当时没工具可查,只能凭旧上下文答。

## P2-4 看板实时化 + 双视图(2026-11-23)

- 任务变更实时事件 `sa:event {kind:'tasks'}`:覆盖全部写路径(create/watch/unwatch/SA 自改看板/验收流转),每条恰好一次;顺手修了 watch 双推;
- 新 IPC `sa:list-tasks`:结构化任务数据(含 session 标题映射、状态优先级排序、done 截最近 20);
- 看板双视图:「按状态」(四栏,默认)⇄「按 session」(按 session 分组聚合,hot 组置顶、done 折叠、channel 直达),分段切换器本地记忆;
- 实时刷新不打断:用户开着详情弹层/打回表单时延后补刷;
- 数据源以 listTasks 为主,tasks.md 解析退为兜底。

## P2-5 视觉校验 + SA 入口统一 + 路径归一(2026-11-23,真实使用反馈)

- **视觉校验补进验收闭环**:新工具 `visual_check`(MCP,SA 白名单)——经 kimi-webbridge daemon 导航+截图落 super-agent/shots/,SA 用 ReadMediaFile 亲眼判图;agents.md 立规:UI 任务 acceptance 必须含视觉预期,verify 必须亲验,不许只过代码机检(起因:eng-talk 收藏页标题被按钮压住,机检 4/4 全过但视觉翻车);
- **SA 入口统一**:根因=SUPER 面板绑定是一次性的,SA 重建/多开换 sid 后面板绑旧 sid,事件全被过滤(channel 有回复 SUPER 没有);修为 tab 激活时 syncBinding 重绑(变化才重绑,首绑失败补绑);channel 树 super-agent 组不再展开,改为树顶「✦ Super Agent」特殊入口直达 SUPER tab;
- **标题污染修复**:acp.prompt 的标题守卫(system-reminder 开头的注入不覆盖现标题)+ SA 标题正式名「✦ Super Agent」+ 存量幂等修复;
- **channel 树路径归一**:realpath+尾斜杠归一(同一项目不再裂成两组,如两个「[1101] eng-talk」)。

## P2-6 闭环定稿落地(2026-11-23)

- **工具快照修复(重要结论)**:实测 kimi resume/load 时会重拉 MCP 工具列表,**不需要重建 SA session**;迁移改为给老 SA 回填 sa_key(下次 resume 即拿到特权工具,历史全保留);
- **交付标记协议**:任务卡强制「结束输出 [TASK_DONE]+摘要 / [TASK_BLOCKED]+原因」;回传链按标记三态流转(交付→待验收/阻塞→升级你/无标记→保持进行中并标注疑似未完成);
- **GM 工具箱三件套**:`dispatch_task`(原 session 带【SA·任务卡】前缀普通消息 或 新开 session,二选一自动;acceptance 支持结构化 checks:command/file/visual/judgment)、`follow_up`(【SA】前缀打回/催办)、`verify_task`(执行机检+视觉,返回 pass+证据,不自动改状态——判断权留给 SA);
- **agents.md v2**:GM 职责、playbook 一页、消息落点矩阵、**说人话规范**(大白话/先结论后证据/技术细节折叠附录)、交付标记协议;老工作区幂等迁移;
- **SUPER 设置区「分身文件」**:agents.md/memory.md/learning.md/tasks.md 四个关键文件可视化查看与编辑(防抖自动保存,tasks.md 保存后看板联动刷新);文件白名单读写 IPC(防穿越)。

## P2-7 工具纪律本质修复(2026-11-23,调研 Anthropic 工具设计 + hooks 哲学)

- 根因链:SA 看不到工具 → CLI 绕道 → 新开 session 爆炸 + 未登记 → 回传链断链;
- **工具描述即文档**(Anthropic 范式):12 个 SA 特权工具全部重写——是什么/何时用/何时别用/最小示例;错误消息 actionable(教会正确路径);成功输出带下一步引导(「已登记,worker 完成自动回执,无需轮询」);
- **确定性护栏调研**:kimi hooks 支持 PreToolUse+Bash 拦截,但只支持用户级 config 不支持项目级——改全局配置影响面大,退回 prompt 级铁律:「禁止 CLI 绕道,一切下发走工具;派发顺序:同项目已托管/活跃 session 优先,全新任务才新开」;
- **回传链自愈**:session_message/follow_up 对未登记 sid 自动补登 watching——从此绕哪条路径都不断链;
- **scanner 合并 bug**:手动项目组与同路径 cwd 组劈成两组(实测两个「[1101] eng-talk」),修为归一后合并。

## P2-8 链路全断的总根因与定案(2026-11-24)

- 用户实测:SA 新开 session 下发、无回执、无通知。实据:SA wire.jsonl 最新工具快照 27 个、mcp__workbench__ 全零;sa_tasks 无登记 → 手工发卡 → 回传链断;
- 排查定案:**不是 resume 丢 MCP**——SDK 0.23 的 ResumeSessionRequest 接受 mcpServers 且 kimi 2.1.1 转发有效;真根因是老 SA session 缺 sa_key → ensureSaAttached 拿不到带 key 的 URL → resume 时无 MCP 可挂(上一轮 sa_key 回填迁移已修);
- 探针实证(newSession / resume+mcpServers / load+mcpServers 三条路径):workbench 工具 31 个全在、SA 特权 12/12 全命中;
- acp.ts 只加实测结论注释,行为不变(resume+mcpServers 已是正确路径);验收方式:重启后问 SA「列出你的特权工具」。

## P2-9 手机端 SUPER 入口(2026-11-25)

- 桥补 SA 端点八件套(sa/session、tasks、decisions、review、inbox、inbox-file、patrol get/set)+ SSE 全局通道 sa 事件转发(与 workbench IPC 同一 push 链路);
- 手机端:moon 首页与会话抽屉加「✦ Super Agent」发光入口(带待决策徽标);SA 屏三分段「对话(工厂全能力)|看板(状态分节+决策卡 ✓通过/✗打回内联意见)|回执(全文弹层)」;decision 事件震动+toast;
- 期间被 429 额度打断过一次,次日续跑完成。

## P2-10 移动端设计审查修复(2026-11-25,带截图验收)

教训:交付前必须自己用移动视口截图亲验(本轮起流程化)。
- 双月亮:剔除 7 张与 3D 月球冲突的背景图(含月亮照片/大文字),加深色渐变遮罩,月球恒为主角;
- 顶栏碰撞:session chip 截断 + SA 入口移至净空区,三层不重叠;
- 「未连接」假报:状态文案改由 SSE hub 真实状态驱动;
- 底栏失衡:按钮尺寸体系统一(40px),mic 用颜色做层级;
- 徽标「0」:hidden 被 display:inline-flex 覆盖的 CSS 坑,补显式规则;
- SA 屏:消息区顶部净空 + 少消息贴底(flex spacer)+ 徽标不压字。

## P2-12 移动端设计规范轮(2026-11-26)

- Design Tokens 落地(间距 6 档/字号 6 档/圆角 5 档/层级 4 层/语义色),新组件全部 token 化;
- **SA 灵动岛**:顶部居中三态(待命/工作/待你决策 N 琥珀脉冲),SSE+轮询驱动,点开进 SA 屏——SA 从"页面"变"常驻";
- IA 修正:chat 与月之暗面平行(删返回按钮,两屏左上角统一会话切换器);抽屉净化(取消配对沉菜单底);
- 对话气泡 P0 规范(78%/✦ 图标/大色块)在真实长文本下撑爆布局,**用户验收回退**,恢复玻璃卡样式;真正溢出根因(长 token 不断行)以 `overflow-wrap: anywhere` 根治;
- 流程升级:移动端交付双保险(agent 自验 + 主 agent 独立截图复验),本轮起执行。

## P2-13 移动端配对移除 + TabBar + 终端锁死修复(2026-11-26)

- **配对体系整体移除**(用户拍板):桥改 LAN 免鉴权(lan-guest 放行,老 token 兼容);客户端配对页/token/取消配对全删;根因实锤为半成品 TabBar 里 `$('history-btn')` 空指针中止整个启动脚本(页面渲染在、事件全灭);
- TabBar 落地:Chat/Moon🌓/SA/Kiki 四空间玻璃栏、chat 左右悬浮玻璃按钮、>5min 居中时间戳、Kiki 四组;
- **终端接管锁死修复**:打开终端失败时 held 永不释放(主进程 hold 后任何环节抛错,渲染层 segView 停在 chat 永不触发交还);三处事务化:openTerminal try/catch 兜底 release、term-view.open 失败强制 release、setSegView catch 强制 release;另修配对码过期只改文案不换码(设置页自动换新)+ 静态资源 no-cache;
- 顺带发现 kimi 已自动升级到 2.7.2(原 2.1.1),ACP 行为需持续观察。

## P2-14 移动端 UX 打磨轮(2026-11-27~28)

- **配对体系整体移除**:LAN 免鉴权打开即用(真凶是半成品 TabBar 的 `$('history-btn')` 空指针冻结启动);TabBar 落地 Chat/Moon🌓/SA/Kiki,合体玻璃胶囊(dock:输入+tab,moon 图标随真实照亮度/SA ★/Kiki 小球头像);顶栏三屏统一(左列表/中眨眼小球+会话名/右设置);
- **小球管家**:小球右上角琥珀徽标,点击展开「待检查 N 项」面板(turn 完成未读),点条目跳转+已读;修复小球 pointer-events:none 被顶栏容器吞点击的问题;
- **队列补发闭环**:turn-done 一次性事件锁屏必错过 → catchup 发现 turn 已结束时顺手 flushQueue;streaming 标志过期导致直发绕开队列的根因也一并说明;停止钮与发送键统一为 30px 成对圆钮;
- **语音输入重做(一套全端统一)**:空输入发送键=麦克风,有输入=发送箭头;识别中红色脉动、interim 实时流进输入框(非灰条)、final 落定可编辑;停止时剩余实时稿转正保留(修「停止删内容」);确认弹窗与按住说话长条两套旧交互下线;
- 终端接管锁死修复(openTerminal 事务化/失败强制 release);
- 经验教训持续沉淀:移动端交付双截图验收;「删除用户内容」一律改为「保留并转正」;全局元素选择器(button/input)是移植第三方页面的高危污染点。
