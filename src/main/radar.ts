// Info Radar — scheduled fetch + AI structuring for personalized intel feeds (PRD §3.5).
// Data lives in ~/.jarvis-workspace/radars/<id>.json, one file per radar.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NewsItem, Radar } from '../shared/workbench-types.js';
import { wbRoot } from './workbench.js';

const MAX_ITEMS = 200;
const MAX_NEW_PER_RUN = 30; // cap AI-structuring cost per run
const SUMMARY_BATCH = 10;

// ---------- storage ----------

function radarsDir(): string {
  const dir = path.join(wbRoot(), 'radars');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function radarPath(id: string): string {
  return path.join(radarsDir(), `${id}.json`);
}

function readRadarFile(id: string): Radar | null {
  try {
    return JSON.parse(fs.readFileSync(radarPath(id), 'utf8')) as Radar;
  } catch {
    return null;
  }
}

function writeRadarFile(radar: Radar): void {
  fs.writeFileSync(radarPath(radar.id), JSON.stringify(radar, null, 2));
}

function defaultRadars(): Radar[] {
  return [
    {
      id: 'radar-open-source',
      name: 'Open Source Radar',
      icon: '🚀',
      query: '追踪 GitHub 上过去一周最热门的新开源项目，每日更新',
      sources: ['https://api.github.com/search/repositories?q=created:%3E{WEEK_AGO}&sort=stars&order=desc&per_page=15'],
      frequencyMinutes: 24 * 60,
      items: [],
      enabled: true,
      lastRunAt: null,
    },
    {
      id: 'radar-academic',
      name: 'Academic Radar',
      icon: '📚',
      query: '追踪 arXiv cs.AI 分类最新论文，每日更新',
      sources: ['https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=15'],
      frequencyMinutes: 24 * 60,
      items: [],
      enabled: true,
      lastRunAt: null,
    },
    {
      id: 'radar-ai-industry',
      name: 'AI Industry Radar',
      icon: '🤖',
      query: '追踪 HackerNews 首页 AI 相关动态，每小时更新',
      // search_by_date (not plain search) — the relevance-sorted endpoint returns all-time top stories
      sources: ['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=25'],
      frequencyMinutes: 60,
      items: [],
      enabled: true,
      lastRunAt: null,
    },
  ];
}

export function listRadars(): Radar[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(radarsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    // first run: seed the built-in radars
    const seeds = defaultRadars();
    for (const r of seeds) writeRadarFile(r);
    return seeds;
  }
  const radars: Radar[] = [];
  for (const f of files) {
    const r = readRadarFile(f.replace(/\.json$/, ''));
    if (r) radars.push(r);
  }
  return radars;
}

export function saveRadar(radar: Radar): Radar[] {
  if (radar.items.length > MAX_ITEMS) radar.items = radar.items.slice(0, MAX_ITEMS);
  writeRadarFile(radar);
  reschedule(radar);
  return listRadars();
}

export function deleteRadar(id: string): Radar[] {
  clearTimer(id);
  fs.rmSync(radarPath(id), { force: true });
  return listRadars();
}

export async function runRadarNow(id: string): Promise<Radar[]> {
  await runRadar(id);
  return listRadars();
}

// ---------- fetching ----------

interface RawItem {
  title: string;
  url: string;
  publishedAt: string;
  source: string;
  blurb: string;
}

function resolveSourceUrl(url: string): string {
  // {WEEK_AGO} → YYYY-MM-DD seven days back (keeps rolling queries fresh)
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return url.replaceAll('{WEEK_AGO}', weekAgo);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(resolveSourceUrl(url), {
    headers: { 'User-Agent': 'kimi-float-radar/1.0', Accept: 'application/json, application/atom+xml, text/xml, */*' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1]) : '';
}

function parseGithub(json: string): RawItem[] {
  const data = JSON.parse(json) as { items?: Array<Record<string, unknown>> };
  return (data.items ?? []).map((r) => ({
    title: String(r.full_name ?? r.name ?? ''),
    url: String(r.html_url ?? ''),
    publishedAt: String(r.created_at ?? new Date().toISOString()),
    source: 'GitHub',
    blurb: `${String(r.description ?? '')} (★${String(r.stargazers_count ?? 0)}, ${String(r.language ?? 'n/a')})`,
  }));
}

function parseArxiv(xml: string): RawItem[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.map((e) => ({
    title: tag(e, 'title').replace(/\s+/g, ' '),
    url: tag(e, 'id'),
    publishedAt: tag(e, 'published') || new Date().toISOString(),
    source: 'arXiv',
    blurb: tag(e, 'summary').replace(/\s+/g, ' ').slice(0, 400),
  }));
}

function parseHn(json: string): RawItem[] {
  const data = JSON.parse(json) as { hits?: Array<Record<string, unknown>> };
  return (data.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: String(h.title),
      url: String(h.url ?? `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`),
      publishedAt: String(h.created_at ?? new Date().toISOString()),
      source: 'HackerNews',
      blurb: `${String(h.points ?? 0)} points · ${String(h.num_comments ?? 0)} comments`,
    }));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** generic RSS 2.0 fallback for user-added sources (settings panel allows any URL) */
function parseRss(xml: string, source: string): RawItem[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items
    .map((e) => ({
      title: stripHtml(tag(e, 'title')),
      url: tag(e, 'link').trim(),
      publishedAt: tag(e, 'pubDate') || tag(e, 'date') || new Date().toISOString(),
      source,
      blurb: stripHtml(tag(e, 'description')).slice(0, 400),
    }))
    .filter((i) => i.title && i.url);
}

async function fetchSource(url: string): Promise<RawItem[]> {
  const body = await fetchText(url);
  if (url.includes('api.github.com')) return parseGithub(body);
  if (url.includes('arxiv.org')) return parseArxiv(body);
  if (url.includes('hn.algolia.com')) return parseHn(body);
  // user-added feeds: sniff generic RSS / Atom so custom sources actually work
  if (body.includes('<item>')) return parseRss(body, hostOf(url));
  if (body.includes('<entry>')) return parseArxiv(body); // Atom shares the entry/title/id/published shape
  return [];
}

// ---------- AI structuring ----------

interface SummaryDeps {
  askOnce: (text: string) => Promise<string>;
  push: (radarId: string, newCount: number) => void;
}

let deps: SummaryDeps | null = null;

interface StructuredEntry {
  title?: string;
  summary?: string;
  tags?: string[];
  relevance?: number;
}

/** Ask the agent to structure a batch of raw items; tolerant JSON extraction ([ … ]). */
async function summarizeBatch(raw: RawItem[]): Promise<StructuredEntry[]> {
  if (!deps) throw new Error('radar deps not initialized');
  const prompt = [
    '你是情报结构化助手。下面是从信息源抓取的原始条目（JSON 数组）。',
    '请为每条生成结构化结果，只返回一个 JSON 数组，不要输出任何其他文字。',
    '每个元素格式：{"title": "润色后的标题", "summary": "100字以内的中文摘要", "tags": ["1到3个标签"], "relevance": 0到1的相关度}',
    '原始条目：',
    JSON.stringify(raw.map((r) => ({ title: r.title, url: r.url, time: r.publishedAt, hint: r.blurb }))),
  ].join('\n');
  const reply = await deps.askOnce(prompt);
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in reply');
  const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('reply is not an array');
  return parsed as StructuredEntry[];
}

function fallbackItem(raw: RawItem): NewsItem {
  return {
    id: randomUUID(),
    title: raw.title,
    summary: raw.blurb || raw.title,
    source: raw.source,
    url: raw.url,
    publishedAt: raw.publishedAt,
    tags: [],
    read: false,
    favorite: false,
  };
}

async function structureItems(raw: RawItem[]): Promise<NewsItem[]> {
  const capped = raw.slice(0, MAX_NEW_PER_RUN);
  const rest = raw.slice(MAX_NEW_PER_RUN).map(fallbackItem);
  const out: NewsItem[] = [];
  for (let i = 0; i < capped.length; i += SUMMARY_BATCH) {
    const batch = capped.slice(i, i + SUMMARY_BATCH);
    try {
      const structured = await summarizeBatch(batch);
      batch.forEach((r, j) => {
        const s = structured[j] ?? {};
        out.push({
          ...fallbackItem(r),
          title: typeof s.title === 'string' && s.title ? s.title : r.title,
          summary: typeof s.summary === 'string' && s.summary ? s.summary : r.blurb || r.title,
          tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string').slice(0, 4) : [],
        });
      });
    } catch {
      // AI unavailable / unparseable — keep raw items so the feed still updates
      out.push(...batch.map(fallbackItem));
    }
  }
  return [...out, ...rest];
}

// ---------- run + scheduling ----------

const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
}

async function runRadar(id: string): Promise<number> {
  const radar = readRadarFile(id);
  if (!radar) return 0;
  let newCount = 0;
  try {
    const rawLists = await Promise.all(radar.sources.map((s) => fetchSource(s).catch(() => [] as RawItem[])));
    const known = new Set(radar.items.map((i) => i.url));
    const fresh = rawLists.flat().filter((r) => r.url && !known.has(r.url));
    if (fresh.length > 0) {
      const structured = await structureItems(fresh);
      structured.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      radar.items = [...structured, ...radar.items].slice(0, MAX_ITEMS);
      newCount = structured.length;
    }
  } catch {
    /* keep old items; still record the attempt below */
  }
  radar.lastRunAt = Date.now();
  writeRadarFile(radar);
  if (newCount > 0) deps?.push(radar.id, newCount);
  return newCount;
}

function schedule(radar: Radar, staggerMs = 0): void {
  clearTimer(radar.id);
  if (!radar.enabled) return;
  const ms = Math.max(5, radar.frequencyMinutes) * 60_000;
  const timer = setInterval(() => void runRadar(radar.id), ms);
  timer.unref?.();
  timers.set(radar.id, timer);
  // never-run radar: do an initial fetch shortly after startup (staggered)
  if (!radar.lastRunAt && radar.items.length === 0) {
    const first = setTimeout(() => void runRadar(radar.id), 8_000 + staggerMs);
    first.unref?.();
  }
}

function reschedule(radar: Radar): void {
  if (deps) schedule(radar);
}

export function startRadarSchedulers(d: SummaryDeps): void {
  deps = d;
  listRadars().forEach((radar, i) => schedule(radar, i * 5_000));
}

export function stopRadarSchedulers(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  deps = null;
}
