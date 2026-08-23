/**
 * 单一能力清单（单一事实源）：MCP 工具注册、Agents 页工具面板、
 * system_query(capabilities)、AGENTS.md 工具清单全部从这里生成。
 * 新增工具 = 在这里加一行 + mcpserver 里实现 handler，其他全部自动同步。
 */

export interface Capability {
  name: string;
  description: string;
  /** 面向 agent 的使用提示（写进 AGENTS.md） */
  usage?: string;
}

export const CAPABILITIES: Capability[] = [
  { name: 'task_create', description: '创建任务到看板', usage: '「新建任务 xxx」' },
  { name: 'task_complete', description: '把任务标记为完成' },
  { name: 'task_update', description: '更新任务状态/优先级/截止时间' },
  { name: 'system_query', description: '查询系统状态和数据（只读）', usage: '回答任何「系统里有什么」前先查' },
  { name: 'data_schema', description: '查看数据库结构（表/列/行数）', usage: '查数据前先看结构' },
  { name: 'data_query', description: 'SQL 只读查询所有业务数据', usage: 'SELECT 查任何数据' },
  { name: 'data_exec', description: '通用数据修改（带快照可撤销）', usage: '纯字段修正：改标题/标已读/删条目' },
  { name: 'present', description: '在 Zen 打开组件', usage: '「打开 xxx」' },
  { name: 'present_artifact', description: '生成图文信息卡到 Zen', usage: '新闻/榜单/调研等多条目结果' },
  { name: 'dismiss', description: '关闭 Zen 浮层/信息卡', usage: '「关掉 xxx / 关掉刚才那个」' },
  { name: 'widget_open', description: '在 Dashboard 舞台打开组件' },
  { name: 'widget_close', description: '休眠舞台组件到 Dock' },
  { name: 'search_launch', description: '多引擎并行搜索' },
  { name: 'focus_start', description: '打开番茄钟并预填任务' },
  { name: 'radar_create', description: '创建信息雷达', usage: '「追踪 xxx 的动态」' },
  { name: 'radar_update', description: '更新雷达频率/源/启停' },
  { name: 'artifact_modify', description: '对话修改自定义组件' },
  { name: 'widget_modify', description: '对话修改内置组件源码' },
  { name: 'evolve_undo', description: '撤销最近一次修改' },
];
