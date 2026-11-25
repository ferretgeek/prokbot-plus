// Disposable Host for the web client's browser tests: the real Host server (host/server) on loopback
// with a temporary data directory, in front of a fixture Host core that answers with demo data.
//
//   node web/tests/fixture-host.mjs <GrokBotLocal-web-*.zip>
//
// Prints one JSON line {origin, web, control, password} and runs until stdin closes: `origin` is the
// main listener (admin page and apps), `web` the web client's own listener and origin. The control
// address creates pairing codes, publishes notifications, reports what the core received and
// replaces the demo Bots and conversation (/scene) for documentation screenshots.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { createSelfHostServer } from '../../host/server/index.mjs';
import { RateLimit } from '../../host/server/security.mjs';

const AGENT = { id: 'demo', name: 'Demo Bot', title: '', description: '', role: 'assistant',
  harness: 'temporal', avatarShape: 'circle', avatarColor: 'blue', status: 'idle' };
const PASSWORD = 'demo-admin-password';

/** A solid 160×100 PNG: the conversation shows one image, as a Bot's screenshot reply does. */
function png(width = 160, height = 100) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, ...Array(width).fill([46, 125, 214]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const IMAGE = `data:image/png;base64,${png().toString('base64')}`;
const ENTRIES = [
  { kind: 'send-message', id: 'demo-1', seq: 1, timestampMs: 1767225600000, message: { type: 'text', content: 'Here is the screenshot.',
    images: [{ url: 'file:///data/runtime/host-data/agents/demo/attachments/demo.png', alt: 'Demo screenshot', width: 160, height: 100 }] } },
];

const bundle = process.argv[2];
if (!bundle) throw new Error('Usage: node web/tests/fixture-host.mjs <GrokBotLocal-web-*.zip>');
const dataDir = await mkdtemp(join(tmpdir(), 'grokbot-web-fixture-'));
const received = { sends: [], uploads: [], methods: [] };
const streams = new Set();
let entries = ENTRIES, agents = [AGENT];

const body = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk)).on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch (error) { reject(error); }
  }).on('error', reject);
});
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value ?? null));
};

function api(method, input) {
  received.methods.push(method);
  if (method === 'uploadAttachmentChunk') {
    received.uploads.push([input.filename, Buffer.from(input.bytesBase64, 'base64').toString()]);
    return { committedPath: '/demo/' + input.filename };
  }
  if (method === 'listAgents') return agents;
  if (['getAgentTranscriptTail', 'openAgentTail'].includes(method)) return { entries, nextBeforeSeq: null, cloudAgentPeerIds: [] };
  if (method === 'getMcpState') return { servers: [] };
  if (method === 'readAttachmentImage') return { dataUrl: IMAGE };
  if (['skillsCatalog', 'getMcpCatalog', 'getTrays', 'getEffectiveMcpPlugins', 'getAsyncTasks', 'getSubagents',
    'getAgentWorkflows'].includes(method) || method.startsWith('list')) return [];
  if (method === 'sendPrompt') { received.sends.push(input); return { accepted: true }; }
  if (method === 'promptAcceptanceStatus') return { outcome: 'not_found' };
  return method.startsWith('get') ? {} : null;
}

let host;
const core = http.createServer(async (request, response) => {
  try {
    const path = request.url.split('?')[0];
    if (request.method === 'GET' && path === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('id: fixture-1\ndata: {}\n\n');
      streams.add(response);
      return response.on('close', () => streams.delete(response));
    }
    if (request.method === 'POST' && path.startsWith('/api/')) return json(response, api(path.slice(5), await body(request)));
    if (path === '/__control/pairing') return json(response, await host.auth.createPairing());
    if (path === '/__control/received') return json(response, { ...received, devices: host.auth.devices() });
    // Demo scenes for documentation screenshots: Bots, one conversation and the profile name.
    if (path === '/__control/scene') {
      const scene = await body(request);
      if (scene.agents) agents = scene.agents;
      if (scene.entries) entries = scene.entries;
      if (scene.displayName) await host.profile.save({ displayName: scene.displayName, avatarDataUrl: null });
      return json(response, { ok: true });
    }
    if (path === '/__control/notify') return json(response, await host.notifications.publish(await body(request)));
    if (path === '/__control/web-client') {
      const { enabled } = await body(request);
      return json(response, await host.webClient.setEnabled(enabled));
    }
    json(response, { error: 'Unknown fixture route' }, 404);
  } catch (error) {
    json(response, { error: String(error.message ?? error) }, error.status ?? 500);
  }
});
await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
const coreUrl = `http://127.0.0.1:${core.address().port}`;

// Every test browser signs in from 127.0.0.1, more often than the Host allows one address per minute.
class TestRateLimit extends RateLimit {
  check(key, limit = 10, windowMs) { return super.check(key, limit * 20, windowMs); }
}
host = await createSelfHostServer({
  dataDir, hostUrl: coreUrl, internalToken: randomBytes(24).toString('base64url'),
  vncUrl: coreUrl, forkVncUrl: coreUrl, rateLimit: new TestRateLimit(),
});
await host.auth.setup(host.auth.setupKey, PASSWORD);
await host.webClient.install(await readFile(bundle));
const address = await host.start(0, '127.0.0.1');
process.stdout.write(`${JSON.stringify({ origin: `http://127.0.0.1:${address.port}`,
  web: `http://127.0.0.1:${host.webServer.address().port}`, control: `${coreUrl}/__control`, password: PASSWORD })}\n`);

async function stop() {
  for (const stream of streams) stream.destroy();
  await host.close();
  await new Promise(resolve => core.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
