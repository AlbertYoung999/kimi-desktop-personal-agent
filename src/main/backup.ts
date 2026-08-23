import fs from 'node:fs';
import path from 'node:path';
import { wbRoot } from './workbench.js';

/** Daily rolling backup of the user layer (~/.jarvis-workspace → backups/). */

const KEEP_DAYS = 7;
const INCLUDE = ['tasks.json', 'layout.json', 'library.json', 'engines.json', 'projects.json', 'agents.md', 'memory.md', 'config.json', 'jarvis.db'];

function backupDir(): string {
  const dir = path.join(wbRoot(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function runBackup(): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dest = path.join(backupDir(), day);
    if (fs.existsSync(dest)) return; // one snapshot per day
    fs.mkdirSync(dest, { recursive: true });
    for (const rel of INCLUDE) {
      const src = path.join(wbRoot(), rel);
      if (!fs.existsSync(src)) continue;
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(src, target, { recursive: true });
    }
    // prune old snapshots
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const name of fs.readdirSync(backupDir())) {
      const dir = path.join(backupDir(), name);
      if (fs.statSync(dir).isDirectory() && fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    console.log('[backup] snapshot saved:', day);
  } catch (err) {
    console.warn('[backup] failed:', err);
  }
}

export function startBackupSchedule(): void {
  runBackup();
  setInterval(runBackup, 6 * 3600_000).unref(); // check every 6h, snapshot once per day
}
