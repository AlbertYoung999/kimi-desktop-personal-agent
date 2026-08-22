import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const cwd = process.env.HOME + '/KimiWorkspace';
const child = spawn('kimi', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
let chunks = 0;
const client = {
  sessionUpdate: async (p) => {
    if (p.update.sessionUpdate === 'agent_message_chunk') chunks++;
  },
  requestPermission: async (params) => ({ outcome: { outcome: 'selected', optionId: (params.options.find((o) => o.kind === 'allow_once') ?? params.options[0]).optionId } }),
};
const conn = new acp.ClientSideConnection(() => client, stream);
await conn.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'probe', version: '1' } });
await conn.authenticate({ methodId: 'login' }).catch(() => {});
const s = await conn.newSession({ cwd, mcpServers: [] });
console.log('[session]', s.sessionId);

// start a long turn in the background (same as startTaskSession)
const turn = conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: '从1数到200，每个数字单独一行，中间不要省略' }] });
await new Promise((r) => setTimeout(r, 2000));
console.log('[chunks before resume]', chunks);

// mid-turn resume (the fix path)
try {
  await conn.resumeSession({ sessionId: s.sessionId, cwd, mcpServers: [] });
  console.log('[resume ok]');
} catch (e) {
  console.log('[resume FAILED]', e.message);
}

const res = await turn; // wait for the turn to finish
console.log('[turn finished]', res.stopReason, '| total chunks:', chunks);
child.kill();
process.exit(0);
