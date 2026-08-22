import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const cwd = process.env.HOME + '/KimiWorkspace';
const child = spawn('kimi', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
let chunks = 0;
let texts = [];
const client = {
  sessionUpdate: async (p) => {
    if (p.update.sessionUpdate === 'agent_message_chunk') { chunks++; texts.push(p.update.content?.text ?? ''); }
  },
  requestPermission: async (params) => ({ outcome: { outcome: 'selected', optionId: (params.options.find((o) => o.kind === 'allow_once') ?? params.options[0]).optionId } }),
};
const conn = new acp.ClientSideConnection(() => client, stream);
await conn.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '1' } });
await conn.authenticate({ methodId: 'login' }).catch(() => {});
const s = await conn.newSession({ cwd, mcpServers: [] });

const turn = conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: '从1数到100，每个数字单独一行' }] });
await new Promise((r) => setTimeout(r, 4000));
console.log('[chunks at 4s, no resume]', chunks);
// simulate user "opening" the session: NO acp call at all, just keep listening
const res = await turn;
console.log('[turn finished]', res.stopReason, '| chunks:', chunks, '| sample:', texts.slice(0,3).join('').slice(0,50));
child.kill();
process.exit(0);
