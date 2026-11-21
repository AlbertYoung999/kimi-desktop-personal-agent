import { execFile } from 'node:child_process';
import type { WorktreeInfo, WorktreeOpResult } from '../shared/types.js';

/**
 * Worktree 隔离(design/design-v7.md §5,决策#7):同项目并发写任务走 git worktree。
 * 全部经 execFile 异步执行(15s 超时),错误结构化返回;
 * 只在用户显式调用 IPC 时执行,无任何定时/自动触发。
 */

const TIMEOUT = 15_000;

type GitOk = { ok: true; stdout: string };
type GitErr = { ok: false; error: string };

function git(args: string[], cwd: string): Promise<GitOk | GitErr> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || String(err)).trim().slice(0, 500) });
      else resolve({ ok: true, stdout });
    });
  });
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], repoPath);
  return r.ok && r.stdout.trim() === 'true';
}

const NOT_GIT: WorktreeOpResult = { ok: false, reason: 'not-git', error: '目标目录不是 git 仓库' };

function slugify(taskSlug: string): string {
  return taskSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** `git worktree add <repo>-wt-<slug> -b agent/<slug>` */
export async function createWorktree(opts: { repoPath: string; taskSlug: string }): Promise<WorktreeOpResult> {
  const { repoPath } = opts;
  if (!(await isGitRepo(repoPath))) return NOT_GIT;
  const slug = slugify(opts.taskSlug) || `task-${Date.now().toString(36)}`;
  const wtPath = `${repoPath.replace(/\/+$/, '')}-wt-${slug}`;
  const branch = `agent/${slug}`;
  const r = await git(['worktree', 'add', wtPath, '-b', branch], repoPath);
  if (!r.ok) return { ok: false, reason: 'git-error', error: r.error };
  return { ok: true, path: wtPath, branch };
}

/** `git worktree list --porcelain` 解析 */
export async function listWorktrees(repoPath: string): Promise<WorktreeOpResult> {
  if (!(await isGitRepo(repoPath))) return NOT_GIT;
  const r = await git(['worktree', 'list', '--porcelain'], repoPath);
  if (!r.ok) return { ok: false, reason: 'git-error', error: r.error };
  const worktrees: WorktreeInfo[] = [];
  for (const block of r.stdout.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const info: WorktreeInfo = { path: '', branch: '', head: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) info.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) info.head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) info.branch = line.slice('branch refs/heads/'.length);
    }
    if (info.path) worktrees.push(info);
  }
  return { ok: true, worktrees };
}

/** 主分支名自适应:origin/HEAD → main → master → 当前分支 */
async function defaultBase(repoPath: string): Promise<string> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoPath);
  if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    const r = await git(['rev-parse', '--verify', '--quiet', b], repoPath);
    if (r.ok) return b;
  }
  const cur = await git(['branch', '--show-current'], repoPath);
  return cur.ok && cur.stdout.trim() ? cur.stdout.trim() : 'HEAD';
}

/** `git diff <base>...<branch>` */
export async function getDiff(repoPath: string, branch: string): Promise<WorktreeOpResult> {
  if (!(await isGitRepo(repoPath))) return NOT_GIT;
  const base = await defaultBase(repoPath);
  const r = await git(['diff', `${base}...${branch}`], repoPath);
  if (!r.ok) return { ok: false, reason: 'git-error', error: r.error };
  return { ok: true, diff: r.stdout };
}

/**
 * `git merge --no-ff <branch>` —— 合并进 repoPath 当前检出的分支(调用方需确保检出的是目标主分支)。
 * 冲突时 `git merge --abort` 恢复原状,不留在半合并状态。
 */
export async function mergeWorktree(opts: { repoPath: string; branch: string }): Promise<WorktreeOpResult> {
  const { repoPath, branch } = opts;
  if (!(await isGitRepo(repoPath))) return NOT_GIT;
  const r = await git(['merge', '--no-ff', branch], repoPath);
  if (!r.ok) {
    const conflicted = /CONFLICT|Automatic merge failed/i.test(r.error);
    if (conflicted) await git(['merge', '--abort'], repoPath);
    return { ok: false, reason: conflicted ? 'conflict' : 'git-error', error: r.error };
  }
  return { ok: true, branch };
}

/** `git worktree remove --force` + 删分支(分支删除 best-effort) */
export async function discardWorktree(opts: { repoPath: string; path: string; branch: string }): Promise<WorktreeOpResult> {
  const { repoPath, path: wtPath, branch } = opts;
  if (!(await isGitRepo(repoPath))) return NOT_GIT;
  const r = await git(['worktree', 'remove', '--force', wtPath], repoPath);
  if (!r.ok) return { ok: false, reason: 'git-error', error: r.error };
  if (branch) await git(['branch', '-D', branch], repoPath);
  return { ok: true };
}
