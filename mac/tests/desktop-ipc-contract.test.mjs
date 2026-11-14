import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGateway } from '../clients/desktop/gateway.mjs';
import { createLocalServices, probeLocalMethod } from '../clients/desktop/local-services.mjs';
import { subscribe } from '../clients/desktop/streams.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const config = { server: 'https://fixture.invalid', token: 'unused-fixture' };

function attach(gateway) {
  const replies = [];
  const port = Object.assign(new EventEmitter(), {
    start() {}, close() { this.emit('close'); }, postMessage(frame) { replies.push(frame); },
  });
  const dispose = gateway.attach(port);
  const send = data => port.emit('message', { data });
  return { port, replies, dispose, send,
    request: requestId => send({ kind: 'request', requestId, method: 'listAgents', args: {} }),
    cancel: requestId => send({ kind: 'cancel', requestId }) };
}

function delayedFetch(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    const { resolve, promise } = Promise.withResolvers();
    calls.push({ signal, finish: (value, status = 200) => resolve(Response.json(value, { status })) });
    return promise; // Deliberately let a response arrive after cancellation.
  });
  return calls;
}

test('desktop IPC probes require a trusted window, a declaration and an installed own handler', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'desktop-ipc-fixture-'));
  t.after(() => rmdir(profile));
  t.mock.method(console, 'error', () => {});
  let invoked = 0;
  const call = await createLocalServices(profile, {}, { settings: { fixtureView: () => ++invoked } });
  const declared = new Set(['fixtureView', 'unusedDeclaration', 'resolveAttachmentMedia', 'reportFixture', 'toString']);
  const probe = method => probeLocalMethod(true, declared, call, method);
  assert.deepEqual(probeLocalMethod(false, declared, call, 'fixtureView'), { ok: false, value: false });
  assert.deepEqual(probeLocalMethod(true, declared, null, 'fixtureView'), { ok: true, value: false });
  assert.deepEqual(probe('fixtureView'), { ok: true, value: true });
  for (const method of ['unusedDeclaration', 'getTimeZone', 'resolveAttachmentMedia', 'reportFixture', 'toString']) {
    assert.deepEqual(probe(method), { ok: true, value: false }, method);
  }
  assert.equal(invoked, 0, 'probing is side-effect free');
  assert.equal(await call('fixtureView'), 1);
  await assert.rejects(call('toString'), /does not implement/);
});

test('desktop coordinator deduplicates in-flight IDs per port and cancellation wins over a late success', async t => {
  const calls = delayedFetch(t);
  const gateway = createGateway(config);
  t.after(() => gateway.close());
  const first = attach(gateway), second = attach(gateway);
  first.request('same'); first.request('same'); second.request('same');
  assert.equal(calls.length, 2, 'one Host command per active ID on each port');
  first.cancel('absent');
  assert.deepEqual(calls.map(call => call.signal.aborted), [false, false]);
  first.cancel('same'); first.cancel('same');
  assert.deepEqual(calls.map(call => call.signal.aborted), [true, false]);
  calls[1].finish(['second']); calls[0].finish(['stale']);
  await turn();
  assert.deepEqual(second.replies, [{ kind: 'reply', requestId: 'same', outcome: { status: 'ok', value: ['second'] } }]);
  assert.equal(first.replies.length, 1);
  assert.equal(first.replies[0].requestId, 'same');
  assert.equal(first.replies[0].outcome.status, 'failed');
  assert.equal(first.replies[0].outcome.failure.code, 'cancelled');
  first.request('same');
  assert.equal(calls.length, 3, 'a settled ID does not block a later request');
  calls[2].finish(['later']); await turn();
  assert.deepEqual(first.replies[1].outcome, { status: 'ok', value: ['later'] });
});

test('port and gateway teardown abort outstanding commands without posting stale replies', async t => {
  const calls = delayedFetch(t);
  const gateway = createGateway(config);
  t.after(() => gateway.close());
  const first = attach(gateway), second = attach(gateway);
  first.request('a'); first.request('b'); second.request('a');
  first.port.close(); first.dispose();
  assert.deepEqual(calls.map(call => call.signal.aborted), [true, true, false]);
  gateway.close();
  assert.equal(calls[2].signal.aborted, true);
  for (const call of calls) call.finish('after close');
  await turn();
  assert.deepEqual([...first.replies, ...second.replies], []);
  assert.equal(first.port.listenerCount('message') + second.port.listenerCount('message'), 0);
});

test('an explicit incompatible coordinator hello never acknowledges readiness or opens a Host stream', t => {
  const calls = delayedFetch(t), gw = createGateway(config);
  t.after(() => gw.close());
  for (const protocolVersion of [4, null, '3']) {
    const session = attach(gw);
    session.send({ kind: 'lifecycle', phase: 'hello', protocolVersion });
    session.request('after-mismatch');
    assert.equal(session.port.listenerCount('message'), 0);
    assert.deepEqual(session.replies, []);
  }
  assert.equal(calls.length, 0);
});

test('a repeated hello never sends a second ready, and renderer shutdown cancels only its own port', async t => {
  let revoked = 0;
  const calls = delayedFetch(t), gw = createGateway(config, () => { revoked++; });
  t.after(() => gw.close());
  const first = attach(gw), other = attach(gw);
  const hello = { kind: 'lifecycle', phase: 'hello', protocolVersion: 3 };
  first.send(hello); first.send(hello); other.send(hello);
  first.request('work');
  first.send({ kind: 'lifecycle', phase: 'shutdown', reason: 'requested', detail: null });
  first.request('after-shutdown');
  assert.equal(calls.length, 3, 'one stream per port, one legitimate command, no post-shutdown call');
  assert.deepEqual(calls.map(call => call.signal.aborted), [true, false, true]);
  calls[2].finish({ error: 'late' }, 401); await turn();
  assert.equal(revoked, 0, 'an abandoned window must not revoke a live sibling');
  assert.deepEqual(first.replies, [{ kind: 'lifecycle', phase: 'ready', protocolVersion: 3 }]);
  assert.deepEqual(other.replies, first.replies);
});

test('an error page or partial HTTP response cannot make the event transport online', async t => {
  const mock = t.mock.method(globalThis, 'fetch', () => { throw new Error('missing fixture'); });
  for (const [status, type] of [[200, 'text/html'], [200, 'text/event-stream-extra'], [200, ''], [206, 'text/event-stream']]) {
    const control = new AbortController(), stages = [];
    mock.mock.mockImplementation(async () => new Response(Buffer.from('data: {"fixture":true}\n\n'), { status,
      headers: type ? { 'Content-Type': type } : {} }));
    await subscribe(config, '/events', () => stages.push('frame'), control.signal, {
      onConnected: () => stages.push('online'), onDisconnected: () => { stages.push('down'); control.abort(); },
    });
    assert.deepEqual(stages, ['down'], `${status} ${type || '(no SSE type)'}`);
  }
});

test('baseline hello opens one event stream, forwards its payload, and a revoked device cannot use the port', async t => {
  let revoked = 0;
  const gw = createGateway(config, () => { revoked++; });
  let streamControl;
  const port = attach(gw), stream = new ReadableStream({ start(s) {
    streamControl = s;
    s.enqueue(Buffer.from('id: one\ndata: {"channel":"fixture","payload":{"visible":true}}\n\n'));
  } });
  t.after(() => { gw.close(); streamControl.close(); });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, redirect: opts.redirect, authenticated: opts.headers.Authorization === `Bearer ${config.token}` });
    if (url.endsWith('/events')) return new Response(stream, { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } });
    return Response.json({ error: 'revoked' }, { status: 401 });
  });
  port.send({ kind: 'lifecycle', phase: 'hello' });
  port.send({ kind: 'lifecycle', phase: 'hello', protocolVersion: 3 });
  await turn();
  assert.deepEqual(port.replies.filter(f => f.phase === 'ready').map(f => f.protocolVersion), [3]);
  assert.deepEqual(port.replies.filter(f => f.family === 'fixture').map(f => f.payload), [{ visible: true }]);
  assert.equal(gw.getState(), 'online');
  port.request('unauthorized'); await turn(); port.request('after-close'); await turn();
  assert.equal(revoked, 1);
  assert.equal(gw.getState(), 'disconnected');
  assert.equal(port.replies.some(f => f.requestId === 'unauthorized'), false);
  assert.deepEqual(requests.map(r => r.url), [`${config.server}/events`, `${config.server}/api/listAgents`]);
  assert.ok(requests.every(r => r.authenticated && r.redirect === 'error'));
});
