import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { wbRoot } from './workbench.js';

/**
 * RemoteBridge HTTPS 的本地证书(prd/PRD-mobile-remote.md §3:iOS Web Speech 需 secure context)。
 * macOS 自带 openssl 生成:自签 CA(10 年)+ 用 CA 签 server 证书(SAN 含 localhost 与局域网 IP),
 * 存 wbRoot()/remote-certs/,已存在则复用。CA 证书经 /ca.pem 下发给手机安装信任。
 */

export interface RemoteCerts {
  key: Buffer;
  cert: Buffer;
  caPem: Buffer;
  /** CA 的 SHA256 指纹(打印日志,用户核对用) */
  caFingerprint: string;
  caPath: string;
}

function certsDir(): string {
  const dir = path.join(wbRoot(), 'remote-certs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openssl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { timeout: 60_000 }, (err, _stdout, stderr) =>
      err ? reject(new Error(`openssl ${args[0]} failed: ${(stderr || String(err)).trim().slice(0, 300)}`)) : resolve(),
    );
  });
}

function fingerprintSha256(pem: Buffer): string {
  const der = Buffer.from(pem.toString('utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return crypto
    .createHash('sha256')
    .update(der)
    .digest('hex')
    .match(/../g)!
    .join(':')
    .toUpperCase();
}

function load(caPemPath: string, serverKeyPath: string, serverPemPath: string): RemoteCerts {
  const caPem = fs.readFileSync(caPemPath);
  return {
    key: fs.readFileSync(serverKeyPath),
    cert: fs.readFileSync(serverPemPath),
    caPem,
    caFingerprint: fingerprintSha256(caPem),
    caPath: caPemPath,
  };
}

/** 证书已存在则复用(LAN IP 变化不会重签——换网络环境如需重签,删掉 remote-certs/ 重启即可) */
export async function ensureRemoteCerts(lanIps: string[]): Promise<RemoteCerts> {
  const dir = certsDir();
  const caKey = path.join(dir, 'ca.key');
  const caPem = path.join(dir, 'ca.pem');
  const serverKey = path.join(dir, 'server.key');
  const serverPem = path.join(dir, 'server.pem');
  if (fs.existsSync(caKey) && fs.existsSync(caPem) && fs.existsSync(serverKey) && fs.existsSync(serverPem)) {
    return load(caPem, serverKey, serverPem);
  }

  // 1. 自签 CA(10 年)
  await openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', caKey, '-out', caPem,
    '-days', '3650', '-nodes', '-subj', '/CN=Kimi Desktop Remote CA',
  ]);
  // 2. server 私钥 + CSR
  const csr = path.join(dir, 'server.csr');
  await openssl(['req', '-newkey', 'rsa:2048', '-keyout', serverKey, '-out', csr, '-nodes', '-subj', '/CN=kimi-desktop-remote']);
  // 3. CA 签 server 证书,SAN 含 localhost 与当前局域网 IP
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps.map((ip) => `IP:${ip}`)].join(',');
  const extFile = path.join(dir, 'server-san.cnf');
  fs.writeFileSync(extFile, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
  await openssl([
    'x509', '-req', '-in', csr, '-CA', caPem, '-CAkey', caKey, '-CAcreateserial',
    '-out', serverPem, '-days', '3650', '-extfile', extFile,
  ]);
  fs.rmSync(csr, { force: true });
  fs.rmSync(extFile, { force: true });
  fs.chmodSync(caKey, 0o600);
  fs.chmodSync(serverKey, 0o600);
  console.log('[remote-certs] 本地 CA + 服务证书已生成:', dir);
  return load(caPem, serverKey, serverPem);
}
