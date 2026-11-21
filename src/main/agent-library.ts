import fs from 'node:fs';
import path from 'node:path';
import type { AgentRecord } from '../shared/types.js';
import {
  deleteAgentRow,
  getAgentRow,
  insertAgentRow,
  listAgentRows,
  updateAgentRow,
  type AgentRow,
} from './db.js';
import { wbRoot } from './workbench.js';

/**
 * 常驻 agent 库(design/design-v7.md §10.2):`wbRoot()/agents/<name>/`,每个 agent 一个目录,
 * 内含 AGENTS.md(身份/能力/边界,唯一事实源)+ 可选 skills/ 目录(本期只建空目录占位)。
 * sqlite agents 表只存元数据;list 时以磁盘目录为准合并(目录在而表缺 → 自愈补行)。
 */

function agentsRoot(): string {
  const dir = path.join(wbRoot(), 'agents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 目录名 slug:保留中英文与数字,其余折叠为 '-' */
function slugify(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'agent';
}

function rowToRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dir: path.join(agentsRoot(), row.dir),
    avatar: row.avatar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function initialAgentsMd(name: string, description: string): string {
  return [
    `# ${name}`,
    '',
    description ? `> ${description}` : '> （一句话描述这个 agent 的职责）',
    '',
    '## 身份',
    '',
    '（在这里定义这个 agent 的角色、语气、职责范围）',
    '',
    '## 能力',
    '',
    '- （擅长什么、可以使用哪些工具 / skills）',
    '',
    '## 边界',
    '',
    '- （不做什么、哪些操作需要先向用户确认）',
    '',
  ].join('\n');
}

export function listAgents(): AgentRecord[] {
  const root = agentsRoot();
  const rows = listAgentRows();
  const byDir = new Map(rows.map((r) => [r.dir, r] as const));
  const records: AgentRecord[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!fs.statSync(path.join(root, entry)).isDirectory()) continue;
    let row = byDir.get(entry);
    if (!row) {
      // 磁盘为准:目录在而表缺(手动拷入的 agent)→ 自愈补一行元数据
      row = {
        id: `agt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: entry,
        description: '',
        dir: entry,
        avatar: '',
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      insertAgentRow(row);
    }
    records.push(rowToRecord(row));
  }
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

export function getAgent(id: string): AgentRecord | null {
  const row = getAgentRow(id);
  if (!row) return null;
  if (!fs.existsSync(path.join(agentsRoot(), row.dir))) return null;
  return rowToRecord(row);
}

export function createAgent(name: string, description: string): AgentRecord {
  const root = agentsRoot();
  let dirName = slugify(name);
  if (fs.existsSync(path.join(root, dirName))) {
    dirName = `${dirName}-${Math.random().toString(36).slice(2, 6)}`; // 同名不覆盖旧 agent
  }
  const row: AgentRow = {
    id: `agt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    description,
    dir: dirName,
    avatar: '',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const dir = path.join(root, dirName);
  fs.mkdirSync(path.join(dir, 'skills'), { recursive: true }); // 本期只占位,不做复制/软链
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), initialAgentsMd(name, description));
  return rowToRecord(insertAgentRow(row));
}

export function updateAgent(id: string, patch: { description?: string; avatar?: string }): AgentRecord | null {
  updateAgentRow(id, patch);
  return getAgent(id);
}

export function deleteAgent(id: string): void {
  const row = getAgentRow(id);
  deleteAgentRow(id);
  if (row) fs.rmSync(path.join(agentsRoot(), row.dir), { recursive: true, force: true });
}

export function readAgentMd(id: string): string {
  const agent = getAgent(id);
  if (!agent) return '';
  try {
    return fs.readFileSync(path.join(agent.dir, 'AGENTS.md'), 'utf8');
  } catch {
    return '';
  }
}

export function writeAgentMd(id: string, content: string): void {
  const agent = getAgent(id);
  if (!agent) return;
  fs.writeFileSync(path.join(agent.dir, 'AGENTS.md'), content);
}
