import { execFile } from 'node:child_process';
import os from 'node:os';

/** System samplers for the home page left rail. Heavy probes are cached. */

export interface TopProc {
  name: string;
  cpu: number;
}

export interface SysStatsFull {
  cpuPct: number;
  memPct: number;
  memUsedGB: string;
  memTotalGB: string;
  diskPct: number;
  uptimeMin: number;
  loadAvg: string;
  netInKBs: number;
  netOutKBs: number;
  batteryPct: number; // -1 = no battery (desktop)
  batteryCharging: boolean;
  wifiSsid: string;
  gpuModel: string;
  topProcs: TopProc[];
}

// ---- cpu (delta between samples) ----
let lastCpu = readCpuTimes();
function readCpuTimes() {
  return os.cpus().reduce(
    (acc, c) => ({ idle: acc.idle + c.times.idle, total: acc.total + Object.values(c.times).reduce((a, b) => a + b, 0) }),
    { idle: 0, total: 0 },
  );
}
function sampleCpuPct(): number {
  const now = readCpuTimes();
  const pct = Math.min(100, Math.max(0, Math.round((1 - (now.idle - lastCpu.idle) / Math.max(1, now.total - lastCpu.total)) * 100)));
  lastCpu = now;
  return pct;
}

// ---- cached shell probes ----
const cache = new Map<string, { at: number; value: string }>();
function cachedExec(key: string, ttlMs: number, cmd: string, args: string[]): Promise<string> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      const value = err ? (cache.get(key)?.value ?? '') : stdout;
      cache.set(key, { at: Date.now(), value });
      resolve(value);
    });
  });
}

async function sampleDiskPct(): Promise<number> {
  const out = await cachedExec('df', 60_000, 'df', ['-k', '/']);
  const m = out.trim().split('\n')[1]?.match(/(\d+)%/);
  return m ? Number(m[1]) : 0;
}

async function sampleBattery(): Promise<{ pct: number; charging: boolean }> {
  const out = await cachedExec('batt', 15_000, 'pmset', ['-g', 'batt']);
  const m = out.match(/(\d+)%/);
  if (!m) return { pct: -1, charging: false };
  return { pct: Number(m[1]), charging: /AC Power|charging/i.test(out) && !/discharging/i.test(out) };
}

async function sampleWifi(): Promise<string> {
  const out = await cachedExec('wifi', 60_000, 'system_profiler', ['SPAirPortDataType']);
  const m = out.match(/Current Network Information:[\s\S]*?^\s+(.+?):\s*$/m);
  return m?.[1]?.trim() ?? '';
}

async function sampleGpu(): Promise<string> {
  const out = await cachedExec('gpu', 24 * 3600_000, 'system_profiler', ['SPDisplaysDataType']);
  const m = out.match(/Chipset Model:\s*(.+)/);
  return m?.[1]?.trim() ?? '';
}

// ---- network throughput (netstat deltas) ----
let lastNet: { t: number; ibytes: number; obytes: number } | null = null;
async function sampleNet(): Promise<{ inKBs: number; outKBs: number }> {
  const out = await cachedExec('netstat', 0, 'netstat', ['-ibn']);
  let ibytes = 0;
  let obytes = 0;
  for (const line of out.split('\n')) {
    // en0 only, AF_LINK rows have 10+ columns with Name/Network/Address
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'en0' || cols.length < 10 || cols[3]?.includes('.')) continue;
    ibytes += Number(cols[6]) || 0;
    obytes += Number(cols[9]) || 0;
  }
  const now = { t: Date.now(), ibytes, obytes };
  const prev = lastNet;
  lastNet = now;
  if (!prev) return { inKBs: 0, outKBs: 0 };
  const dt = Math.max(1, (now.t - prev.t) / 1000);
  return {
    inKBs: Math.max(0, Math.round((now.ibytes - prev.ibytes) / dt / 1024)),
    outKBs: Math.max(0, Math.round((now.obytes - prev.obytes) / dt / 1024)),
  };
}

async function sampleTopProcs(): Promise<TopProc[]> {
  const out = await cachedExec('ps', 5_000, 'ps', ['-Ao', 'pcpu,comm', '-r']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().match(/^([\d.]+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .slice(0, 5)
    .map((m) => ({ name: m[2].split('/').pop() ?? m[2], cpu: Number(m[1]) }));
}

export async function sampleSysStats(): Promise<SysStatsFull> {
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const [diskPct, battery, wifiSsid, gpuModel, net, topProcs] = await Promise.all([
    sampleDiskPct(),
    sampleBattery(),
    sampleWifi(),
    sampleGpu(),
    sampleNet(),
    sampleTopProcs(),
  ]);
  return {
    cpuPct: sampleCpuPct(),
    memPct: Math.round((usedMem / totalMem) * 100),
    memUsedGB: (usedMem / 1e9).toFixed(1),
    memTotalGB: (totalMem / 1e9).toFixed(0),
    diskPct,
    uptimeMin: Math.round(os.uptime() / 60),
    loadAvg: os.loadavg()[0].toFixed(2),
    netInKBs: net.inKBs,
    netOutKBs: net.outKBs,
    batteryPct: battery.pct,
    batteryCharging: battery.charging,
    wifiSsid,
    gpuModel,
    topProcs,
  };
}
