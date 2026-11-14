import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Stage only the project-owned modules, with the same relative imports as in the WebView.
const root = await mkdtemp(join(tmpdir(), 'prokbot-android-coordinator-'));
test.after(() => rm(root, { recursive: true, force: true }));
for (const file of ['gateway.js', 'native.js'])
  await cp(new URL(`../client/${file}`, import.meta.url), join(root, file));
await cp(new URL('../../mac/clients/desktop/i18n.mjs', import.meta.url), join(root, 'desktop', 'i18n.mjs'));
const { createGateway } = await import(pathToFileURL(join(root, 'gateway.js')));

const hello = { kind: 'lifecycle', phase: 'hello', protocolVersion: 3 };
const ready = { kind: 'lifecycle', phase: 'ready', protocolVersion: 3 };
const shutdown = { kind: 'lifecycle', phase: 'shutdown', reason: 'requested', detail: null };
const down = generation => ({ generation, reason: 'stream-error', cause: null });

class Port extends EventTarget {
  frames = [];
  closed = false;
  start() {}
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  postMessage(frame) { this.frames.push(frame); }
  send(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  request(requestId) { this.send({ kind: 'request', requestId, method: 'listAgents', args: {} }); }
  payloads(family) { return this.frames.filter(f => f.kind === 'event' && f.family === family).map(f => f.payload); }
}

function fixture(t, options) {
  const gateway = createGateway(options), calls = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    calls.push({ url, ...init, resolve, reject });
    return promise; // A response can already be queued when a port aborts its request.
  });
  t.after(() => { gateway.close(); for (const call of calls) call.reject(new Error('fixture closed')); });
  return { gateway, calls, attach() { const port = new Port(); gateway.attach(port); return port; } };
}

function openStream(call) {
  let writer;
  const body = new ReadableStream({ start(controller) { writer = controller; } });
  call.signal.addEventListener('abort', () => writer.error(call.signal.reason), { once: true });
  call.resolve(new Response(body, { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } }));
  return writer;
}

test('a legacy hello and repeated v3 hellos get one ready and one stream on a live port', async t => {
  const { calls, attach } = fixture(t), port = attach();
  port.send({ kind: 'lifecycle', phase: 'hello' });
  port.send(hello);
  assert.deepEqual(port.frames, [ready]);
  assert.deepEqual(calls.map(c => c.url), ['/events']);
  openStream(calls[0]); await turn();
  const before = [...port.frames];
  port.send(hello);
  assert.deepEqual(port.frames, before);
  assert.equal(calls.length, 1);
});

test('renderer state and raw transport events follow SSE open, loss and recovery', async t => {
  const states = [];
  const { gateway, calls, attach } = fixture(t, { onStateChanged: state => states.push(state) });
  const port = attach();
  port.send(hello);
  assert.deepEqual(port.frames, [ready]);
  assert.equal(gateway.getState(), 'connecting');
  const stream = openStream(calls[0]); await turn();
  assert.deepEqual(port.payloads('coordinator-transport-state'), [{ state: 'connected' }]);
  assert.deepEqual(port.payloads('transport-connected'), [{ generation: 1 }]);
  stream.enqueue(new TextEncoder().encode('id: demo-1\ndata: {"channel":"fixture","payload":{"n":1}}\n\n'));
  stream.close(); await turn();
  assert.deepEqual(port.payloads('fixture'), [{ n: 1 }]);
  assert.deepEqual(port.payloads('coordinator-transport-state'), [{ state: 'connected' }, { state: 'down' }]);
  assert.deepEqual(port.payloads('transport-down'), [down(1)]);
  t.mock.timers.tick(500); await turn();
  assert.deepEqual(calls.map(c => c.url), ['/events', '/events']);
  assert.equal(calls[1].headers['Last-Event-ID'], 'demo-1');
  openStream(calls[1]); await turn();
  assert.deepEqual(port.payloads('coordinator-transport-state'), [{ state: 'connected' }, { state: 'down' }, { state: 'connected' }]);
  assert.deepEqual(port.payloads('transport-connected'), [{ generation: 1 }, { generation: 2 }]);
  assert.deepEqual(states, ['online', 'reconnecting', 'online']);
  assert.deepEqual(port.frames.filter(f => f.kind === 'lifecycle'), [ready]);
});

test('an error page, missing or lookalike SSE type, or partial response never goes online', async t => {
  let connected = 0;
  const { calls, attach } = fixture(t, { onConnected: () => connected++ });
  for (const [status, type] of [[200, 'text/html'], [200, ''], [200, 'text/event-stream-extra'], [206, 'text/event-stream']]) {
    const port = attach(), label = `${status} ${type || '(no type)'}`;
    port.send(hello);
    const bytes = new TextEncoder().encode('data: {"channel":"fixture","payload":1}\n\n');
    calls.at(-1).resolve(new Response(bytes, { status, headers: type ? { 'Content-Type': type } : {} }));
    await turn();
    assert.equal(connected, 0, label);
    assert.deepEqual(port.payloads('fixture'), [], label);
    assert.deepEqual(port.payloads('transport-connected'), [], label);
    assert.deepEqual(port.payloads('transport-down'), [down(0)], label);
    assert.deepEqual(port.payloads('coordinator-transport-state'), [{ state: 'down' }], label);
    port.send(shutdown);
  }
});

test('an explicit incompatible hello closes its port without a ready or a Host request', t => {
  const { calls, attach } = fixture(t);
  for (const protocolVersion of [4, '3', null, undefined]) {
    const port = attach();
    port.send({ ...hello, protocolVersion });
    assert.equal(port.closed, true);
    port.send(hello); port.request('after-close');
    assert.deepEqual(port.frames, []);
  }
  assert.equal(calls.length, 0);
  const live = attach();
  live.send(hello); live.send({ ...hello, protocolVersion: 4 });
  assert.equal(live.closed, true, 'a duplicate hello cannot hide a version mismatch');
  assert.deepEqual(live.frames, [ready]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
});

test('renderer shutdown aborts only its stream and pending calls, and discards late replies', async t => {
  let unauthorized = 0;
  const { gateway, calls, attach } = fixture(t, { onUnauthorized: () => unauthorized++ });
  const first = attach(), other = attach();
  first.send(hello); other.send(hello);
  openStream(calls[0]); openStream(calls[1]); await turn();
  first.request('same'); first.request('second'); other.request('same');
  const before = [...first.frames];
  first.send(shutdown); first.request('after-close'); first.send(hello);
  assert.equal(first.closed, true);
  assert.equal(other.closed, false);
  assert.deepEqual(calls.map(c => c.signal.aborted), [true, false, true, true, false]);
  calls[2].resolve(Response.json(['late']));
  calls[3].resolve(new Response(null, { status: 401 }));
  calls[4].resolve(Response.json(['live'])); await turn();
  assert.deepEqual(first.frames, before);
  assert.deepEqual(other.frames.at(-1), { kind: 'reply', requestId: 'same', outcome: { status: 'ok', value: ['live'] } });
  assert.equal(gateway.getState(), 'online');
  assert.equal(unauthorized, 0, 'a late 401 from the closed port must not disconnect the sibling');
  other.request('live-401'); calls.at(-1).resolve(new Response(null, { status: 401 })); await turn();
  assert.equal(unauthorized, 1, 'a live 401 still reaches the Android shell');
  assert.equal(other.frames.at(-1).outcome.failure.httpStatus, 401);
});
