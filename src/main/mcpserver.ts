import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { journaled, logEvolve, pushUndoFrame, undoLast } from './evolve.js';
import { CAPABILITIES } from './capabilities.js';
import { getDb } from './db.js';
import { systemDigest } from './digest.js';
import { listRadars, saveRadar } from './radar.js';
import { recentDigest } from './signals.js';
import { getSettings } from './store.js';
import { getWidgetRegistry } from './widget-registry.js';
import { listEngines, getLayout, listLibrary, listProjects, listTasks as listTasksSnapshot, readMemory, saveTask, updateLibraryItem, wbRoot } from './workbench.js';

/**
 * Workbench MCP server — the self-evolution plane (design/design-evolve.md).
 * E1: six core tools. E2: per-domain mutation tools + artifact_modify + undo.
 */

export interface McpHandlers {
  /** forward an action to the workbench renderer; resolves with its result message */
  forwardToRenderer(action: string, params: Record<string, unknown>): Promise<string>;
  /** open URLs in the system browser */
  openExternal(url: string): void;
  /** ask the renderer to refresh a data view */
  notifyRefresh(kind: 'tasks' | 'radars'): void;
  /** one-shot kimi call (artifact_modify diff pipeline) */
  askOnce(prompt: string, timeoutMs?: number): Promise<string>;
  /** push an artifact update so mounted widgets re-render */
  notifyArtifactUpdated(item: { id: string; title: string; html: string }): void;
  /** toast notification in the workbench window (e.g. background task finished) */
  notifyUser(kind: 'success' | 'error' | 'info', message: string): void;
  /** artifact_modify progress: palette animation + stage pop-out */
  notifyArtifactProgress(p: {
    state: 'started' | 'done' | 'failed';
    title: string;
    message?: string;
    item?: { id: string; title: string; html: string };
  }): void;
  /** one-shot kimi call bound to the app repo cwd (for self-modification) */
  askOnceRepo(prompt: string, timeoutMs?: number): Promise<string>;
  /** forward a presentation payload to the renderer (fire-and-forget) */
  forwardPresent(p: { channel: 'artifact'; payload: unknown }): void;
  /** absolute path of the app repo (dev checkout containing src/) */
  repoRoot(): string;
  /** rebuild the workbench bundle and hot-reload the window; throws on build failure */
  rebuildWorkbench(): Promise<void>;
}

let serverUrl: string | null = null;

export function getWorkbenchMcpUrl(): string | null {
  return serverUrl;
}

/** Agents 页工具清单（名称 + 说明 + 当前启用状态）——唯一事实源在 capabilities.ts */
export const TOOL_META = CAPABILITIES;

const tasksFile = () => path.join(wbRoot(), 'tasks.json');
const layoutFile = () => path.join(wbRoot(), 'layout.json');
const libraryFile = () => path.join(wbRoot(), 'library.json');
const radarFile = (id: string) => path.join(wbRoot(), 'radars', `${id}.json`);

function extractHtml(text: string): string | null {
  const fence = text.match(/```html\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const loose = text.match(/<(div|section|style)[\s\S]*$/);
  return loose ? loose[0].trim() : null;
}

function fuzzy<T>(items: T[], query: string, pick: (item: T) => string): T | undefined {
  const q = query.toLowerCase();
  return items.find((i) => pick(i).toLowerCase() === q) ?? items.find((i) => pick(i).toLowerCase().includes(q) || q.includes(pick(i).toLowerCase()));
}

function buildServer(handlers: McpHandlers): McpServer {
  const server = new McpServer({ name: 'kimi-float-workbench', version: '0.2.0' });
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  // 工具开关：禁用的工具不注册（design: Agents 页可配置）
  const disabled = new Set(getSettings().disabledTools ?? []);
  const origRegister = server.registerTool.bind(server);
  (server as unknown as { registerTool: (name: string, def: unknown, handler: unknown) => void }).registerTool = (
    name: string,
    def: unknown,
    handler: unknown,
  ) => {
    if (!disabled.has(name)) origRegister(name, def as never, handler as never);
  };

  server.registerTool(
    'task_create',
    {
      description: '在任务看板（Task Flow）里创建任务',
      inputSchema: {
        title: z.string().describe('任务标题'),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).optional().describe('优先级，默认 medium'),
        due: z.string().optional().describe('截止时间，ISO 日期如 2026-08-17，可省略'),
      },
    },
    async ({ title, priority, due }) =>
      ok(
        await journaled('task_create', { title, priority, due }, [tasksFile()], () => {
          saveTask({
            id: `task-${Date.now().toString(36)}`,
            title,
            description: '',
            status: 'todo',
            priority: priority ?? 'medium',
            dueDate: due,
            notes: '',
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          handlers.notifyRefresh('tasks');
          return `已创建任务「${title}」（todo / ${priority ?? 'medium'}）`;
        }),
      ),
  );

  server.registerTool(
    'task_complete',
    {
      description: '把任务标记为完成',
      inputSchema: { title: z.string().describe('任务标题（支持模糊匹配）') },
    },
    async ({ title }) =>
      ok(
        await journaled('task_complete', { title }, [tasksFile()], () => {
          const task = fuzzy(
            listTasksSnapshot(),
            title,
            (t) => t.title,
          );
          if (!task) return `✗ 没找到任务「${title}」`;
          task.status = 'done';
          task.completedAt = new Date().toISOString();
          saveTask(task);
          handlers.notifyRefresh('tasks');
          return `已完成任务「${task.title}」`;
        }),
      ),
  );

  server.registerTool(
    'task_update',
    {
      description: '更新任务的状态/优先级/截止时间',
      inputSchema: {
        title: z.string().describe('任务标题（支持模糊匹配）'),
        status: z.enum(['backlog', 'todo', 'in_progress', 'done', 'canceled']).optional(),
        priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
        due: z.string().optional().describe('新的截止时间，ISO 日期'),
      },
    },
    async ({ title, status, priority, due }) =>
      ok(
        await journaled('task_update', { title, status, priority, due }, [tasksFile()], () => {
          const task = fuzzy(listTasksSnapshot(), title, (t) => t.title);
          if (!task) return `✗ 没找到任务「${title}」`;
          if (status) task.status = status;
          if (priority) task.priority = priority;
          if (due) task.dueDate = due;
          saveTask(task);
          handlers.notifyRefresh('tasks');
          return `已更新任务「${task.title}」`;
        }),
      ),
  );

  server.registerTool(
    'widget_open',
    {
      description: '在工作台舞台上打开（添加）一个 widget',
      inputSchema: { widget: z.string().describe('widget 名称或 id，如 task-flow / deep-focus / search / agents / widget-forge / info-radar') },
    },
    async ({ widget }) =>
      ok(
        await journaled('widget_open', { widget }, [layoutFile()], () =>
          handlers.forwardToRenderer('widget_open', { widget }),
        ),
      ),
  );

  server.registerTool(
    'widget_close',
    {
      description: '关闭（休眠到 Dock）舞台上的某个 widget',
      inputSchema: { widget: z.string().describe('widget 名称或 id') },
    },
    async ({ widget }) =>
      ok(
        await journaled('widget_close', { widget }, [layoutFile()], () =>
          handlers.forwardToRenderer('widget_close', { widget }),
        ),
      ),
  );

  server.registerTool(
    'search_launch',
    {
      description: '用所有已启用的搜索引擎并行搜索（在系统浏览器打开）',
      inputSchema: { query: z.string().describe('搜索词') },
    },
    async ({ query }) =>
      ok(
        await journaled('search_launch', { query }, [], () => {
          const engines = listEngines().filter((e) => e.enabled);
          if (engines.length === 0) return '没有已启用的搜索引擎';
          for (const e of engines.slice(0, 8)) {
            handlers.openExternal(e.template.replace('%s', encodeURIComponent(query)));
          }
          return `已将「${query}」发射到 ${engines.length} 个搜索引擎`;
        }),
      ),
  );

  server.registerTool(
    'focus_start',
    {
      description: '打开番茄钟（Deep Focus）并预填任务',
      inputSchema: {
        task: z.string().describe('专注的事'),
        mode: z.enum(['sprint', 'deep', 'breath']).optional().describe('sprint=25min / deep=45min / breath=5min'),
      },
    },
    async ({ task, mode }) =>
      ok(
        await journaled('focus_start', { task, mode }, [], () =>
          handlers.forwardToRenderer('focus_start', { task, mode: mode ?? 'sprint' }),
        ),
      ),
  );

  server.registerTool(
    'radar_create',
    {
      description: '创建一个信息雷达（Info Radar），追踪指定主题的信息源',
      inputSchema: {
        name: z.string().describe('雷达名称'),
        sources: z.array(z.string()).describe('可直接抓取的源 URL 列表（API / RSS / Atom），如 https://export.arxiv.org/api/query?search_query=...&sortBy=submittedDate&sortOrder=descending'),
        icon: z.string().optional().describe('单个 emoji，默认 📡'),
        frequencyMinutes: z.number().optional().describe('更新频率（分钟），默认 1440（日更），每小时填 60'),
        query: z.string().optional().describe('用户的原始需求描述'),
      },
    },
    async ({ name, sources, icon, frequencyMinutes, query }) => {
      const validSources = sources.filter((s) => /^https?:\/\//i.test(s));
      if (validSources.length === 0) return ok('✗ 没有可用的源 URL（必须以 http(s):// 开头），未创建');
      const id = `radar-${Date.now().toString(36)}`;
      return ok(
        await journaled('radar_create', { name, sources: validSources }, [radarFile(id)], () => {
          saveRadar({
            id,
            name,
            icon: icon ?? '📡',
            query: query ?? name,
            sources: validSources,
            frequencyMinutes: Math.max(5, frequencyMinutes ?? 1440),
            items: [],
            enabled: true,
            lastRunAt: null,
          });
          handlers.notifyRefresh('radars');
          const freq = frequencyMinutes && frequencyMinutes < 60 ? `每 ${frequencyMinutes} 分钟` : frequencyMinutes === 60 ? '每小时' : '每天';
          return `已创建 Radar「${name}」（${validSources.length} 个源，${freq}更新），首次抓取将在数秒后自动开始`;
        }),
      );
    },
  );

  server.registerTool(
    'radar_update',
    {
      description: '更新雷达的更新频率/源列表/启用状态',
      inputSchema: {
        name: z.string().describe('雷达名称（模糊匹配）'),
        frequencyMinutes: z.number().optional(),
        sources: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      },
    },
    async ({ name, frequencyMinutes, sources, enabled }) => {
      const radar = fuzzy(listRadars(), name, (r) => r.name);
      if (!radar) return ok(`✗ 没找到雷达「${name}」`);
      return ok(
        await journaled('radar_update', { name, frequencyMinutes, sources, enabled }, [radarFile(radar.id)], () => {
          if (frequencyMinutes) radar.frequencyMinutes = Math.max(5, frequencyMinutes);
          if (sources?.length) radar.sources = sources.filter((s) => /^https?:\/\//i.test(s));
          if (enabled !== undefined) radar.enabled = enabled;
          saveRadar(radar);
          handlers.notifyRefresh('radars');
          return `已更新雷达「${radar.name}」`;
        }),
      );
    },
  );

  server.registerTool(
    'artifact_modify',
    {
      description: '用自然语言修改一个已存在的自定义组件（Forge 生成物），差量更新其 HTML',
      inputSchema: {
        name: z.string().describe('组件名称（组件库里的标题，模糊匹配）'),
        instruction: z.string().describe('修改要求，如「背景改成深色」「加一个刷新按钮」'),
      },
    },
    async ({ name, instruction }) => {
      const item = fuzzy(listLibrary(), name, (i) => i.title);
      if (!item) return ok(`✗ 组件库里没有「${name}」`);
      // generation can take 60-90s — longer than the MCP client's default request
      // timeout, so run it in the background and push the result to the stage when done
      const prompt = [
        '这是工作台里一个自包含 HTML 组件的当前代码：',
        '```html',
        item.html,
        '```',
        `用户的修改要求：${instruction}`,
        '请输出修改后的完整组件代码：单个自包含 HTML 片段（内联 <style>/<script>，无外部依赖），用 ```html 围栏包裹，首行 `<!-- title: 名称 -->`。不要写文件，代码直接放在回复里。',
      ].join('\n');
      handlers.notifyArtifactProgress({ state: 'started', title: item.title });
      void (async () => {
        try {
          const reply = await handlers.askOnce(prompt, 300_000); // full-component diffs are slow
          const html = extractHtml(reply);
          if (!html) {
            logEvolve({ at: Date.now(), tool: 'artifact_modify', params: { name, instruction }, result: `失败：回复中没有可识别的组件代码` });
            handlers.notifyUser('error', `✗ 组件「${item.title}」修改失败：回复中没有可识别的代码`);
            handlers.notifyArtifactProgress({ state: 'failed', title: item.title, message: '生成结果中没有可识别的组件代码，换个说法再试一次' });
            return;
          }
          const result = await journaled('artifact_modify', { name, instruction }, [libraryFile()], () => {
            updateLibraryItem(item.id, { html });
            handlers.notifyArtifactUpdated({ id: item.id, title: item.title, html });
            return `已更新组件「${item.title}」（${instruction}）`;
          });
          handlers.notifyUser('success', `✓ ${result}`);
          handlers.notifyArtifactProgress({ state: 'done', title: item.title, message: result, item: { id: item.id, title: item.title, html } });
        } catch (err) {
          logEvolve({ at: Date.now(), tool: 'artifact_modify', params: { name, instruction }, result: `失败：${String(err)}` });
          handlers.notifyUser('error', `✗ 组件「${item.title}」修改失败：${String(err)}`);
          handlers.notifyArtifactProgress({ state: 'failed', title: item.title, message: String(err) });
        }
      })();
      return ok(`已开始修改组件「${item.title}」（${instruction}）——生成需要一两分钟，完成后舞台上的组件会自动刷新`);
    },
  );

  server.registerTool(
    'data_schema',
    {
      description: '查看数据库结构（表/列/行数）。查数据前先调用，别猜字段名。',
      inputSchema: {},
    },
    async () => {
      const d = getDb();
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
      const out = tables.map((t) => {
        const cols = (d.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string }[]).map((c) => `${c.name}:${c.type}`);
        const count = (d.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
        return { table: t, columns: cols, rows: count };
      });
      return ok(JSON.stringify(out, null, 1).slice(0, 4000));
    },
  );

  server.registerTool(
    'data_query',
    {
      description: '用 SQL 查询系统数据（只读 SELECT）。覆盖所有业务数据：tasks/radar_items/radars/library/projects/engines/signals。返回 JSON 行。',
      inputSchema: {
        sql: z.string().describe('一条 SELECT 语句，如 SELECT title,status,due_date FROM tasks WHERE project_id=\'x\' LIMIT 20'),
      },
    },
    async ({ sql }) => {
      const trimmed = sql.trim();
      if (!/^select\b/i.test(trimmed) || /\b(pragma|attach|insert|update|delete|drop|create|alter|replace|vacuum)\b/i.test(trimmed)) {
        return ok('✗ 只允许只读 SELECT 查询');
      }
      try {
        const d = getDb();
        const rows = d.prepare(trimmed).all();
        const capped = rows.slice(0, 100);
        const suffix = rows.length > 100 ? `\n（共 ${rows.length} 行，已截断到 100 行，请加 LIMIT 精确查询）` : '';
        return ok(JSON.stringify(capped, null, 1).slice(0, 6000) + suffix);
      } catch (err) {
        return ok(`✗ SQL 错误：${String(err)}`);
      }
    },
  );

  const EXEC_TABLES = new Set(['tasks', 'radar_items', 'library', 'projects', 'engines', 'signals']);

  server.registerTool(
    'data_exec',
    {
      description:
        '通用数据修改（UPDATE/INSERT/DELETE）。仅限纯字段修正（改标题/标已读/调优先级/改频率/删条目）；带行为的操作（创建任务/完成重复任务/建雷达/呈现）必须用对应的专用工具。修改前会自动快照，可用 evolve_undo 回滚。',
      inputSchema: {
        sql: z.string().describe('一条 UPDATE/INSERT/DELETE 语句，UPDATE/DELETE 必须带 WHERE'),
      },
    },
    async ({ sql }) => {
      const trimmed = sql.trim();
      const m = trimmed.match(/^(update|insert|delete)\b/i);
      if (!m) return ok('✗ 只允许 UPDATE / INSERT / DELETE');
      const verb = m[1].toLowerCase();
      if (/\b(pragma|attach|drop|create|alter|vacuum|trigger)\b/i.test(trimmed)) return ok('✗ 禁止 DDL 和 PRAGMA');
      const tableMatch = trimmed.match(/^(?:update\s+(\w+)|insert\s+into\s+(\w+)|delete\s+from\s+(\w+))/i);
      const table = (tableMatch?.[1] ?? tableMatch?.[2] ?? tableMatch?.[3] ?? '').toLowerCase();
      if (!EXEC_TABLES.has(table)) return ok(`✗ 表 ${table || '?'} 不在白名单（${[...EXEC_TABLES].join('/')}）`);
      if ((verb === 'update' || verb === 'delete') && !/\bwhere\b/i.test(trimmed)) return ok('✗ UPDATE/DELETE 必须带 WHERE');
      try {
        const d = getDb();
        // 执行前快照受影响行，供 evolve_undo 回滚
        let snapshot = '';
        if (verb !== 'insert') {
          try {
            const where = trimmed.slice(trimmed.toLowerCase().indexOf('where') + 5);
            snapshot = JSON.stringify(d.prepare(`SELECT * FROM ${table} WHERE ${where}`).all()).slice(0, 8000);
          } catch { /* best-effort */ }
        }
        const res = d.prepare(trimmed).run();
        logEvolve({ at: Date.now(), tool: 'data_exec', params: { sql: trimmed }, result: `${verb} ${table}，影响 ${res.changes} 行${snapshot ? '（已快照）' : ''}` });
        if (snapshot) pushUndoFrame('data_exec', [{ file: `db://${table}`, content: snapshot }]);
        return ok(`✓ ${verb} ${table}：影响 ${res.changes} 行${snapshot ? '（已自动快照，可撤销）' : ''}`);
      } catch (err) {
        return ok(`✗ SQL 错误：${String(err)}`);
      }
    },
  );

  server.registerTool(
    'system_query',
    {
      description:
        '查询工作台系统的当前状态和数据（只读，无需权限）。回答「系统里有什么」类问题前先调用：tasks=任务（可按状态/项目/关键词/逾期过滤）、radars=雷达及内容、library=组件库、layout=舞台布局、signals=近期系统事件、memory=长期记忆、sessions=会话列表、digest=系统状态摘要。',
      inputSchema: {
        domain: z.enum(['tasks', 'radars', 'library', 'layout', 'signals', 'memory', 'sessions', 'digest', 'widgets', 'capabilities']),
        status: z.string().optional().describe('tasks 域：按状态过滤，如 todo / in_progress / done'),
        project: z.string().optional().describe('tasks 域：按项目名过滤（模糊匹配）'),
        keyword: z.string().optional().describe('tasks/radars 域：按标题关键词过滤（模糊匹配）'),
        overdue: z.boolean().optional().describe('tasks 域：true = 只看逾期'),
        limit: z.number().optional().describe('返回条数上限，默认 20'),
      },
    },
    async ({ domain, status, project, keyword, overdue, limit }) => {
      const cap = Math.min(50, limit ?? 20);
      const json = (v: unknown) => ok(typeof v === 'string' ? v : JSON.stringify(v, null, 1).slice(0, 4000));
      switch (domain) {
        case 'digest':
          return json(systemDigest());
        case 'tasks': {
          let tasks = listTasksSnapshot();
          if (status) tasks = tasks.filter((t) => t.status === status);
          if (project) {
            const projects = listProjects();
            const p = projects.find((p) => p.name.toLowerCase().includes(project.toLowerCase()));
            tasks = p ? tasks.filter((t) => t.projectId === p.id) : tasks.filter((t) => !t.projectId);
          }
          if (keyword) tasks = tasks.filter((t) => t.title.toLowerCase().includes(keyword.toLowerCase()));
          if (overdue) {
            const today = new Date().toISOString().slice(0, 10);
            tasks = tasks.filter((t) => t.dueDate && t.dueDate.slice(0, 10) < today && t.status !== 'done' && t.status !== 'canceled');
          }
          return json(
            tasks.slice(0, cap).map((t) => ({
              title: t.title,
              status: t.status,
              priority: t.priority,
              dueDate: t.dueDate,
              projectId: t.projectId,
              recurrence: t.recurrence,
              updatedAt: new Date(t.updatedAt).toISOString(),
            })),
          );
        }
        case 'radars':
          return json(
            listRadars().map((r) => ({
              name: r.name,
              enabled: r.enabled,
              frequencyMinutes: r.frequencyMinutes,
              unread: r.items.filter((i) => !i.read).length,
              latest: r.items.slice(0, 3).map((i) => i.title),
            })),
          );
        case 'library':
          return json(listLibrary().slice(0, cap).map((i) => ({ title: i.title, createdAt: new Date(i.createdAt).toISOString() })));
        case 'layout':
          return json(getLayout().widgets.map((w) => ({ widgetId: w.widgetId, minimized: w.minimized })));
        case 'signals':
          return json(recentDigest(30));
        case 'memory':
          return json(readMemory());
        case 'sessions':
          return json(getSettings().mainSessionId ? { mainSessionId: getSettings().mainSessionId } : {});
        case 'widgets':
          return json(getWidgetRegistry());
        case 'capabilities': {
          const disabled = new Set(getSettings().disabledTools ?? []);
          return json(
            CAPABILITIES.filter((c) => !disabled.has(c.name)).map((c) => ({
              tool: c.name,
              description: c.description,
              usage: c.usage,
            })),
          );
        }
        default:
          return json(`✗ 未知 domain: ${domain}`);
      }
    },
  );

  server.registerTool(
    'widget_modify',
    {
      description:
        '修改工作台内置 widget（Task Flow / Deep Focus / Search / Info Radar / Agents / Forge 等）的源码并热重载。kimi 会直接编辑该 widget 的 TS 源文件，随后自动重新打包；改动失败会自动回滚。用于「给 task-flow 加项目功能」这类对内置组件的修改。',
      inputSchema: {
        widget: z.string().describe('内置 widget id，如 task-flow / deep-focus / search / info-radar / agents / widget-forge'),
        instruction: z.string().describe('修改需求，尽量具体'),
      },
    },
    async ({ widget, instruction }) => {
      const id = widget.trim();
      const src = path.join(handlers.repoRoot(), 'src', 'renderer', 'workbench', 'widgets', `${id}.ts`);
      if (!fs.existsSync(src)) {
        return ok(`✗ 内置 widget「${id}」的源文件不存在（src/renderer/workbench/widgets/${id}.ts）。可修改的内置 widget：task-flow / deep-focus / search / info-radar / agents / widget-forge / evolution / command-center`);
      }
      handlers.notifyArtifactProgress({ state: 'started', title: `widget:${id}` });
      void (async () => {
        const before = fs.readFileSync(src, 'utf8'); // snapshot BEFORE the agent touches the file
        try {
          const prompt = [
            `修改文件 ${src}（这是 Electron 工作台的一个内置 widget，TypeScript）。`,
            `需求：${instruction}`,
            '硬性约束：1) registerWidget({def, mount(body, ctx)}) 契约不变；2) 不要新增 npm 依赖；3) 只改这一个文件；4) 保持现有代码风格（样式注入 <style>、类名加前缀、用 style.css 的 CSS 变量）；5) 改完用 `npx esbuild src/renderer/workbench/index.ts --bundle --outfile=/tmp/wb-check.js --format=iife` 自验证语法（cwd 就是仓库根目录），失败就自己修好。',
            '直接编辑文件实现，不要在回复里贴代码。',
          ].join('\n');
          await handlers.askOnceRepo(prompt, 300_000);
          // build decides: failure → restore source, rebuild old bundle, report
          try {
            await handlers.rebuildWorkbench();
          } catch (buildErr) {
            fs.writeFileSync(src, before);
            await handlers.rebuildWorkbench().catch(() => {});
            throw new Error(`构建失败已回滚：${String(buildErr).slice(0, 200)}`);
          }
          const result = `已修改内置 widget「${id}」源码并热重载（${instruction}）`;
          logEvolve({ at: Date.now(), tool: 'widget_modify', params: { widget: id, instruction }, result });
          pushUndoFrame('widget_modify', [{ file: src, content: before }]);
          handlers.notifyUser('success', `✓ ${result}`);
          handlers.notifyArtifactProgress({ state: 'done', title: `widget:${id}`, message: result });
        } catch (err) {
          logEvolve({ at: Date.now(), tool: 'widget_modify', params: { widget: id, instruction }, result: `失败：${String(err)}` });
          handlers.notifyUser('error', `✗ 修改「${id}」失败：${String(err).slice(0, 150)}`);
          handlers.notifyArtifactProgress({ state: 'failed', title: `widget:${id}`, message: String(err).slice(0, 200) });
        }
      })();
      return ok(`已开始修改内置 widget「${id}」（${instruction}）——kimi 正在编辑源码，完成后工作台会自动重载`);
    },
  );

  server.registerTool(
    'present_artifact',
    {
      description:
        '把调研/计算结果以图文信息卡呈现到 Zen 浮层（Generative Presentation）。当你已经拿到结果、需要「做给用户看」时调用，不要只回文字。kind: news-digest=新闻列表 / data-card=数据卡 / gallery=图片网格 / list=通用列表 / custom=自由HTML。items 字段除 title 外都可省略。',
      inputSchema: {
        kind: z.enum(['news-digest', 'data-card', 'gallery', 'list', 'custom']),
        title: z.string().describe('卡片标题'),
        items: z
          .array(
            z.object({
              title: z.string(),
              summary: z.string().optional(),
              image: z.string().optional().describe('http(s) 图片 URL'),
              url: z.string().optional(),
              tag: z.string().optional(),
            }),
          )
          .max(20)
          .optional(),
        html: z.string().optional().describe('kind=custom 时的自包含 HTML'),
        actions: z.array(z.object({ label: z.string(), action: z.string() })).optional(),
      },
    },
    async (spec) => {
      if (spec.kind === 'custom' && !spec.html) return ok('✗ kind=custom 必须提供 html');
      if (spec.kind !== 'custom' && (!spec.items || spec.items.length === 0)) return ok('✗ 需要至少一条 item');
      handlers.forwardPresent({ channel: 'artifact', payload: spec });
      logEvolve({ at: Date.now(), tool: 'present_artifact', params: { kind: spec.kind, title: spec.title }, result: `呈现了「${spec.title}」（${spec.kind}）` });
      return ok(`已在 Zen 呈现「${spec.title}」（${spec.kind}，${spec.items?.length ?? 0} 条）`);
    },
  );

  server.registerTool(
    'present',
    {
      description: '在 Zen 里打开一个组件（语音说「打开 xxx」时调用）。目标可以是内置 widget id 或组件库里的组件名。',
      inputSchema: { target: z.string().describe('组件 id 或名称（模糊匹配）') },
    },
    async ({ target }) => {
      const result = await handlers.forwardToRenderer('present_open', { target });
      return ok(result);
    },
  );

  server.registerTool(
    'dismiss',
    {
      description: '关闭 Zen 里的浮层组件或信息卡（语音说「关掉 xxx」「关掉刚才那个」时调用）。',
      inputSchema: { target: z.string().describe('组件/卡片名称（模糊匹配）；传 "latest" 关闭最近打开的那个') },
    },
    async ({ target }) => {
      const result = await handlers.forwardToRenderer('present_dismiss', { target });
      return ok(result);
    },
  );

  server.registerTool(
    'evolve_undo',
    {
      description: '撤销最近一次对工作台的修改（任务/雷达/布局/组件库/widget 源码变更）',
      inputSchema: {},
    },
    async () => {
      const { message, restoredFiles } = undoLast();
      handlers.notifyRefresh('tasks');
      handlers.notifyRefresh('radars');
      // restored widget sources need a rebuild + reload to take effect
      if (restoredFiles.some((f) => f.includes(path.join('workbench', 'widgets')) && f.endsWith('.ts'))) {
        try {
          await handlers.rebuildWorkbench();
          return ok(`${message}（widget 源码已回滚并重载）`);
        } catch (err) {
          return ok(`${message}，但重建失败：${String(err).slice(0, 150)}`);
        }
      }
      return ok(message);
    },
  );

  return server;
}

export async function startWorkbenchMcp(handlers: McpHandlers): Promise<string> {
  if (serverUrl) return serverUrl;
  const httpServer = http.createServer((req, res) => {
    void (async () => {
      // stateless: fresh server + transport per request
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer(handlers);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('MCP server failed to bind');
  serverUrl = `http://127.0.0.1:${address.port}/mcp`;
  console.log('[mcp] workbench server at', serverUrl);
  return serverUrl;
}
