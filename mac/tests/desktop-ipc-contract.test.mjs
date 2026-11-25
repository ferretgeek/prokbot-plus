import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGateway } from '../clients/desktop/gateway.mjs';
import { createLocalServices, desktopEdges, probeLocalMethod } from '../clients/desktop/local-services.mjs';
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
  assert.deepEqual(await call('getGrokBotUserSkills'), { heldOnBox: false, skills: [] });
  assert.deepEqual(await call('listPublicBotMarketplace'), { featuredListings: [], listings: [], hasMore: false });
  assert.deepEqual(await call('listGrokBotTeamAgents'), []);
  assert.deepEqual(await call('listCloudAgentPublishedApps'), { kind: 'off' });
  assert.deepEqual(await call('getCloudAgentPublishProposals'), { kind: 'off' });
  assert.deepEqual(await call('getLocalToolActionGrant'), { granted: false });
  assert.deepEqual(await call('readScmConnections'), { github: false, gitlab: false, bitbucket: false, 'azure-devops': false });
  // 1.3.0 main-edge reads answer with the official empty values.
  assert.deepEqual(await call('getBotPage', { agentId: 'a' }), {});
  assert.deepEqual(await call('getGrokBotAgentBotSkills', { agentId: 'a' }), []);
  assert.deepEqual(await call('getGrokBotAgentPreview', { agentId: 'a', maxPeople: 3 }), { people: [], stats: null, popularWithRoles: [] });
  assert.deepEqual(await call('browseGrokBotTeamAgents'), { kind: 'unranked' });
  assert.equal(await call('getPluginMcpServerLinks', { pluginId: '1' }), null);
  assert.equal(await call('getGrokBotAutomationPurchase', { agentId: 'a', automationId: 'b' }), null);
  assert.equal(await call('getGrokBotInviteByEmailEligibility'), 'unknown');
  assert.deepEqual(await call('listCursorTeamMembers', { teamId: 1 }), { members: [] });
  assert.deepEqual(await call('getMcpMarketplaceLinkNeeds'), { bitbucketServerHostIds: [] });
  assert.equal(await call('openBotDictationSettings'), null);
  for (const passive of ['reportComputerControl', 'reportInfoPaneToggled', 'reportTasksPanelOpened', 'reportTaskOpened'])
    assert.equal(await call(passive, {}), null, passive);
  // Cloud-only actions stay unimplemented so the renderer shows its own failure.
  for (const cloud of ['openGrokBotAddToX', 'uploadPluginZip', 'startPluginMcpConnectorSignIn', 'setGrokBotAutomationPurchase'])
    await assert.rejects(call(cloud, {}), /does not implement/, cloud);
});

test('desktop edges keep inline panel and Spotlight declarations out of the main edge in either minified style', () => {
  for (const helper of ['t', 'n']) {
    const preload = `x=ge("desktop-mount",{methods:{mount:${helper}().args({at:o({x:y()})}),notePointerRegion:${helper}().noArgs},events:te()}),`
      + `Fc={getThemeState:${helper}().noArgs,mount:${helper}().noArgs},jc={setEnabled:${helper}().args({enabled:y()})};`
      + `M=ge("main",{methods:{...Fc,...jc}}),S=ge("spotlight",{methods:{readSettings:${helper}().noArgs,setEnabled:${helper}().args({enabled:y()})}});`;
    const { main, others } = desktopEdges(preload);
    assert.deepEqual([...main].sort(), ['getThemeState', 'mount', 'setEnabled'], helper);
    assert.deepEqual([...others].map(([edge, names]) => [edge, [...names]]),
      [['desktop-mount', ['mount', 'notePointerRegion']], ['spotlight', ['readSettings', 'setEnabled']]], helper);
  }
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

test('1.1.0 global search uses the Host search methods and reports one complete page', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(opts.body) });
    return Response.json([{ agentId: 'a', entryId: 'e' }]);
  });
  const gateway = createGateway(config);
  t.after(() => gateway.close());
  for (const method of ['searchMessages', 'searchFiles']) {
    assert.deepEqual(await gateway.command(method, { query: 'q', continuation: 'ignored' }),
      { matches: [{ agentId: 'a', entryId: 'e' }], coverage: { kind: 'complete' } });
  }
  assert.deepEqual(requests, [{ path: '/api/searchAgents', body: { query: 'q' } }, { path: '/api/searchMedia', body: { query: 'q' } }]);
  assert.equal(await gateway.command('noteTranscriptOpened', { agentId: 'a' }), null);
  assert.deepEqual(await gateway.command('takeTeachLearningPrompts'), []);
  assert.equal(requests.length, 2);
});

test('the default main Bot is the first visible Bot, as the client requires a non-empty ID', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).pathname, '/api/listAgents');
    return Response.json([{ id: 'hidden', isHiddenFromSidebar: true }, { id: 'visible' }]);
  });
  const gateway = createGateway(config);
  t.after(() => gateway.close());
  assert.deepEqual(await gateway.command('ensureDefaultMainAgent'), { outcome: 'present', agentId: 'visible' });
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
  port.request('unauthorized'); for (let i = 0; i < 5; i++) await turn();
  port.request('after-close'); await turn();
  assert.equal(revoked, 1);
  assert.equal(gw.getState(), 'disconnected');
  assert.equal(port.replies.some(f => f.requestId === 'unauthorized'), false);
  assert.deepEqual(requests.map(r => r.url),
    [`${config.server}/events`, `${config.server}/api/listAgents`, `${config.server}/connect/status`]);
  assert.ok(requests.every(r => r.authenticated && r.redirect === 'error'));
});

test('a 401 from a Host feature fails only that request while the device is still accepted', async t => {
  let revoked = 0;
  const gw = createGateway(config, () => { revoked++; });
  t.after(() => gw.close());
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    if (url.endsWith('/connect/status')) return Response.json({ deviceId: 'fixture' });
    return Response.json({ error: '连接器授权已过期，请重新授权' }, { status: 401 });
  });
  const port = attach(gw);
  port.request('connector'); port.request('second-connector');
  for (let i = 0; i < 6; i++) await turn();
  assert.equal(revoked, 0);
  assert.notEqual(gw.getState(), 'disconnected');
  const failures = port.replies.filter(f => f.kind === 'reply').map(f => f.outcome.failure);
  assert.deepEqual(failures.map(f => [f.httpStatus, f.message]), [[401, '连接器授权已过期，请重新授权'], [401, '连接器授权已过期，请重新授权']]);
  assert.equal(urls.filter(url => url.endsWith('/connect/status')).length, 1, 'concurrent 401s share one device check');
  port.request('later'); for (let i = 0; i < 6; i++) await turn();
  assert.equal(port.replies.filter(f => f.kind === 'reply').length, 3, 'the gateway keeps serving requests');
});

test('a Host without the device status endpoint gets the original prompt to pair again', async t => {
  let prompted = 0;
  const gw = createGateway(config, () => { prompted++; });
  t.after(() => gw.close());
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/connect/status')
    ? new Response('not found', { status: 404 }) : Response.json({ error: 'unauthorized' }, { status: 401 }));
  const port = attach(gw);
  port.request('legacy'); for (let i = 0; i < 6; i++) await turn();
  assert.equal(prompted, 1);
  assert.notEqual(gw.getState(), 'disconnected');
  assert.equal(port.replies.find(f => f.requestId === 'legacy')?.outcome.failure.httpStatus, 401);
});
