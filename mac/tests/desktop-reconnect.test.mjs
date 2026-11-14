import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway } from '../clients/desktop/gateway.mjs';
import { subscribe } from '../clients/desktop/streams.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const config = { server: 'https://fixture.invalid', token: 'fixture-device-token' };
const frame = n => `id: ${n}\r\ndata: {"channel":"fixture","payload":${n}}\r\n\r\n`;
const eventStream = { headers: { 'Content-Type': 'text/event-stream' } };

test('512 immediately ended SSE connections back off, keep their cursor, and recover quickly after a stable session', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  syncBuiltinESMExports();
  t.mock.method(performance, 'now', () => Date.now());
  const attempts = [], received = [], controller = new AbortController();
  let held;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const n = attempts.push({ time: Date.now(), cursor: options.headers['Last-Event-ID'] });
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(Buffer.from(frame(n)));
      if (n === 513) held = stream;
      else stream.close();
    } }), eventStream);
  });
  const run = subscribe(config, '/events', ({ data }) => received.push(data.payload), controller.signal);
  t.after(async () => { controller.abort(); held?.close(); await run; t.mock.timers.reset(); syncBuiltinESMExports(); });
  await turn();
  for (let i = 0; i < 512; i++) {
    const backoff = Math.min(500 * 2 ** Math.min(i, 5), 10000);
    t.mock.timers.tick(backoff - 1); await turn();
    assert.equal(attempts.length, i + 1, `retried early after stream ${i + 1}`);
    t.mock.timers.tick(1); await turn();
    assert.equal(attempts.length, i + 2, `missing reconnect after stream ${i + 1}`);
    assert.equal(attempts[i + 1].cursor, String(i + 1));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1, 'only the live attempt or retry should listen');
  }
  assert.ok(Date.now() > 3600_000, 'more than one virtual hour of disconnects');
  t.mock.timers.tick(60000);
  held.close(); held = null; await turn();
  t.mock.timers.tick(499); await turn(); assert.equal(attempts.length, 513);
  t.mock.timers.tick(1); await turn(); assert.equal(attempts.length, 514);
  controller.abort(); await run;
  t.mock.timers.tick(120000); await turn();
  assert.deepEqual(received, Array.from({ length: 514 }, (_, i) => i + 1));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('session teardown stops delivery of already buffered frames and ignores a late unauthorized response', async t => {
  const controller = new AbortController(), received = [];
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(frame(1) + frame(2), eventStream));
  await subscribe(config, '/events', ({ data }) => { received.push(data.payload); controller.abort(); }, controller.signal);
  assert.deepEqual(received, [1]);
  const late = Promise.withResolvers(), stopped = new AbortController();
  let unauthorized = 0;
  mock.mock.mockImplementation(() => late.promise);
  const run = subscribe(config, '/events', () => {}, stopped.signal, { onUnauthorized: () => unauthorized++ });
  stopped.abort(); late.resolve(new Response(null, { status: 401 })); await run;
  assert.equal(unauthorized, 0);
});

test('gateway reconnects real loopback SSE, ignores incomplete frames, resets an empty event ID and stops on 401', { timeout: 7000 }, async t => {
  const cursors = [], messages = [], states = [];
  const revoked = Promise.withResolvers();
  const server = createServer((req, res) => {
    if (req.url !== '/events') {
      if (req.url === '/api/empty') res.writeHead(204).end();
      else if (req.url === '/api/malformed') res.writeHead(200).end('not json');
      else res.writeHead(503, { 'Content-Type': 'text/plain' }).end('fixture interruption');
      return;
    }
    const attempt = cursors.push(req.headers['last-event-id']);
    if (attempt > 2) { res.writeHead(401).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (attempt === 1) {
      res.write(frame(1)); res.end('id: unfinished\ndata: {');
    } else res.end(': heartbeat\n\nid:\ndata: {"channel":"fixture","payload":2}\n\n');
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const gateway = createGateway({ ...config, server: `http://127.0.0.1:${server.address().port}` }, revoked.resolve, undefined, state => states.push(state));
  let portClosures = 0;
  const port = Object.assign(new EventEmitter(), { start() {}, close() { portClosures++; }, postMessage(value) { messages.push(value); } });
  const detach = gateway.attach(port);
  t.after(async () => { gateway.close(); detach(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(gateway.command('uploadAttachmentChunk'), { httpStatus: 503, message: 'HTTP 503' });
  assert.equal(await gateway.command('empty'), null);
  await assert.rejects(gateway.command('malformed'), SyntaxError);
  for (let i = 0; i < 2; i++) port.emit('message', { data: { kind: 'lifecycle', phase: 'hello' } });
  await revoked.promise;
  assert.deepEqual(cursors, [undefined, '1', undefined]);
  assert.deepEqual(messages.filter(m => m.family === 'fixture').map(m => m.payload), [1, 2]);
  assert.deepEqual(messages.filter(m => m.family === 'transport-connected').map(m => m.payload.generation), [1, 2]);
  assert.deepEqual(messages.filter(m => m.family === 'coordinator-transport-state').map(m => m.payload.state),
    ['connected', 'down', 'connected', 'down'], 'the renderer sees connection loss and recovery');
  assert.equal(messages.filter(m => m.kind === 'lifecycle' && m.phase === 'ready').length, 1);
  assert.deepEqual(states.slice(0, 4), ['online', 'reconnecting', 'online', 'reconnecting']);
  assert.equal(gateway.getState(), 'disconnected', 'a revoked subscription will not retry');
  assert.equal(portClosures, 1, 'the renderer must not keep a dead port with pending calls');
  await assert.rejects(gateway.command('empty'), /Disconnected|已退出/);
  gateway.close(); detach();
  assert.equal(portClosures, 1);
  assert.equal(gateway.getState(), 'disconnected');
  assert.equal(port.listenerCount('message'), 0);
});

// Opt-in real-time run; the deterministic 512-connection test stays in ordinary CI.
if (process.env.PROKBOT_DESKTOP_SOAK_SECONDS) {
  const seconds = Number(process.env.PROKBOT_DESKTOP_SOAK_SECONDS);
  assert.ok(Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 86400);
  test('wall-clock loopback session soak with short streams, stable streams and concurrent commands', { timeout: (seconds + 15) * 1000 }, async t => {
    let connections = 0, delivered = 0, requests = 0, gaps = 0, badCursors = 0, openStreams = 0, peakStreams = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/api/echo') {
        const parts = [];
        for await (const part of req) parts.push(part);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(Buffer.concat(parts)); return;
      }
      if (req.url !== '/events') { res.writeHead(404).end(); return; }
      let cursor = Number(req.headers['last-event-id'] ?? 0);
      if (cursor !== delivered) badCursors++;
      const attempt = ++connections;
      peakStreams = Math.max(peakStreams, ++openStreams);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = () => res.write(frame(++cursor));
      send();
      const interval = setInterval(send, 100);
      const end = setTimeout(() => res.end('id: partial\ndata: {'), attempt % 8 === 4 ? 35000 : 40);
      res.once('close', () => { clearInterval(interval); clearTimeout(end); openStreams--; });
    });
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const gateway = createGateway({ ...config, server: `http://127.0.0.1:${server.address().port}` });
    const port = Object.assign(new EventEmitter(), { start() {}, close() {}, postMessage(message) {
      if (message.family !== 'fixture') return;
      if (message.payload !== delivered + 1) gaps++;
      delivered = message.payload;
    } });
    const detach = gateway.attach(port);
    t.after(async () => { gateway.close(); detach(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const start = performance.now(), until = start + seconds * 1000;
    port.emit('message', { data: { kind: 'lifecycle', phase: 'hello' } });
    while (performance.now() < until) {
      const args = { request: ++requests };
      assert.deepEqual(await gateway.command('echo', args, AbortSignal.timeout(5000)), args);
      await delay(Math.min(1000, Math.max(0, until - performance.now())));
    }
    detach(); gateway.close();
    const stoppedAt = delivered;
    await delay(550);
    assert.equal(delivered, stoppedAt);
    assert.equal(gateway.getState(), 'disconnected');
    assert.equal(openStreams, 0); assert.equal(peakStreams, 1);
    assert.equal(gaps, 0); assert.equal(badCursors, 0);
    assert.ok(connections >= 6 && delivered >= 100 && requests >= seconds / 2);
    t.diagnostic(JSON.stringify({ wallSeconds: (performance.now() - start) / 1000, connections, delivered, requests, gaps, badCursors, peakStreams, openStreams }));
  });
}
