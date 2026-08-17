import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { journaled, logEvolve, pushUndoFrame, undoLast } from './evolve.js';
import { listRadars, saveRadar } from './radar.js';
import { listEngines, listLibrary, listTasks as listTasksSnapshot, saveTask, updateLibraryItem, wbRoot } from './workbench.js';

/**
 * Workbench MCP server — the self-evolution plane (design-evolve.md).
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
  /** absolute path of the app repo (dev checkout containing src/) */
  repoRoot(): string;
  /** rebuild the workbench bundle and hot-reload the window; throws on build failure */
  rebuildWorkbench(): Promise<void>;
}

let serverUrl: string | null = null;

export function getWorkbenchMcpUrl(): string | null {
  return serverUrl;
}

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
