import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalServices } from '../../mac/clients/desktop/local-services.mjs';
import { createLocalLayoutPersistence, bindPersistenceContract, inspectPersistenceContract } from '../tools/compat/1.1.0/contract.mjs';

const readName = 'readManyClientPersistence', writeName = 'writeClientPersistence';
const probe = 'probe', read = 'readMany', write = 'write';
const wireProbe = 'dune-rpc:main:probe', wireRead = `dune-rpc:main:m:${readName}`, wireWrite = `dune-rpc:main:m:${writeName}`;
const key = 'sand.client.slice.ui-layout', privateKey = 'sand.client.slice.client-meta.account-slot';
const broad = { include: ['sand.'], exclude: [] }, exact = { include: [key], exclude: [] };
const frame = Object.freeze({}), sender = Object.freeze({ mainFrame: frame }), event = Object.freeze({ sender, senderFrame: frame });
const window = Object.freeze({ webContents: sender, isDestroyed: () => false });
const success = value => ({ ok: true, value });
const invalid = 'edge/invalid-args', unknown = 'edge/unknown-method', denied = 'edge/untrusted-sender', failed = 'edge/handler-failed';
function expectFailure(reply, code) {
  assert.deepEqual(Object.keys(reply).sort(), ['failure', 'ok']);
  assert.equal(reply.ok, false);
  assert.deepEqual(Object.keys(reply.failure).sort(), ['code', 'detail']);
  assert.equal(reply.failure.code, code);
  assert.equal(typeof reply.failure.detail, 'string'); assert.ok(reply.failure.detail.length > 0);
  assert.doesNotMatch(reply.failure.detail, /private fixture content/);
}

function fixture(overrides = {}) {
  const reads = [], writes = [];
  const adapter = createLocalLayoutPersistence({ window,
    readMany: args => { reads.push(args); return { [key]: 'layout', [privateKey]: 'private fixture content', [`${key}.other`]: 'sibling' }; },
    write: args => { writes.push(args); }, ...overrides });
  return { channels: adapter, revoke: adapter.revoke, reads, writes };
}

const here = fileURLToPath(import.meta.url);
const archive = process.env.PROKBOT_WINDOWS_110_ASAR;
const skipSource = archive === undefined ? 'set PROKBOT_WINDOWS_110_ASAR to the verified Windows archive' : false;
const contractUrl = new URL('../tools/compat/1.1.0/contract.mjs', import.meta.url).href;
test('official Windows 1.1.0 preload and main/renderer evidence pins bind exactly two local methods (static only)', { skip: skipSource }, async () => {
  let evidence;
  if (process.execArgv.includes('--expose-internals')) evidence = inspectPersistenceContract(archive);
  else {
    // Default test runner need not expose internals. Only first-party parsing code runs in this child.
    const child = spawnSync(process.execPath, ['--expose-internals', '--input-type=module', '-e',
      'const {inspectPersistenceContract}=await import(process.argv[1]); console.log(JSON.stringify(inspectPersistenceContract(process.argv[2])))',
      contractUrl, archive], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    evidence = JSON.parse(child.stdout);
  }
  assert.deepEqual(evidence, { version: '1.1.0', nativeVerified: false, fixedRegistrarMatches: 0,
    headerSha256: '9fb5f015b88ae9ae5da2033aa1c447b6ea57c26a53bf04bf56b4f4219d4baa6a',
    preloadSha256: '3204c8744260d6070dcffe2192b184bc6cdc9cb5d881d73e8b30c3517e91dac9',
    methods: [readName, writeName], key });
  const values = new Map();
  const { channels } = bindPersistenceContract(archive, { window,
    readMany: () => Object.fromEntries(values), write: args => { values.set(args.key, args.value); } });
  assert.deepEqual(Object.keys(channels).sort(), [wireProbe, wireRead, wireWrite].sort());
  assert.ok(Object.isFrozen(channels)); assert.equal(Object.getPrototypeOf(channels), null);
  assert.deepEqual(channels[wireProbe](event, readName), success(true));
  expectFailure(channels[wireProbe](event, 'stageAttachmentPath'), unknown);
  assert.deepEqual(await channels[wireWrite](event, { key, value: 'layout only' }), success(undefined));
  assert.deepEqual(await channels[wireRead](event, broad), success({ [key]: 'layout only' }));
});

test('one substituted byte in the preload, main edge or renderer binding fails closed without modifying the archive', { skip: skipSource }, t => {
  const original = fs.readSync, untouched = new Proxy({}, { get() { assert.fail('capability consulted'); } });
  let corruptAt, flipped = 0;
  const mock = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const count = original(fd, buffer, offset, length, position);
    if (position === corruptAt && count) { buffer[offset] ^= 1; flipped++; }
    return count;
  });
  try {
    syncBuiltinESMExports();
    for (const [offset, reason] of [[9516522, /preload|member digest mismatch/], [7044061, /replies evidence digest mismatch/],
      [5821773, /handlers evidence digest mismatch/], [49500404, /layout evidence digest mismatch/]]) {
      corruptAt = offset;
      assert.throws(() => bindPersistenceContract(archive, untouched), reason);
    }
    assert.equal(flipped, 4);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('wrong source is refused before opening any local capability', () => {
  const untouched = new Proxy({}, { get() { assert.fail('consulted a capability before verifying the source'); } });
  assert.throws(() => bindPersistenceContract(here, untouched), /unexpected archive size/);
  assert.throws(() => inspectPersistenceContract(here), /unexpected archive size/);
});

test('known probes succeed without dispatch; absent, privileged and inherited names are not channels', () => {
  const { channels, reads, writes } = fixture();
  assert.deepEqual(Object.keys(channels).sort(), [probe, read, write, 'revoke'].sort());
  assert.ok(Object.isFrozen(channels)); assert.equal(Object.getPrototypeOf(channels), null);
  for (const method of [readName, writeName]) assert.deepEqual(channels[probe](event, method), success(true));
  for (const method of ['readClientPersistence', 'removeClientPersistence', 'stageAttachmentPath', 'getHostSettings', '__proto__', 'toString', wireRead, '']) {
    expectFailure(channels[probe](event, method), unknown);
    assert.equal(channels[`dune-rpc:main:m:${method}`], undefined);
  }
  for (const method of [null, 1, { method: readName }]) expectFailure(channels[probe](event, method), invalid);
  assert.deepEqual([reads, writes], [[], []]);
  for (const owner of [null, true, { webContents: {}, isDestroyed: () => false }, { webContents: sender, isDestroyed: () => true }])
    assert.throws(() => createLocalLayoutPersistence({ readMany() {}, write() {}, window: owner }), TypeError);
  assert.throws(() => createLocalLayoutPersistence({ window, readMany() {} }), TypeError);
});

test('a matching include wins ties and a longer exclude wins; backend receives only the layout prefix', async () => {
  const { channels, reads } = fixture();
  for (const [include, exclude, matches] of [
    [[], [], false], [[''], [], true], [[''], ['sand.'], false], [['sand.'], ['sand.'], true],
    [['sand.'], [key], false], [['sand.', key], [key], true], [['no-match'], [], false],
    [[key], [`${key}.child`], true], [[privateKey], [], false],
  ]) {
    const at = reads.length;
    assert.deepEqual(await channels[read](event, { include, exclude }), success(matches ? { [key]: 'layout' } : {}));
    assert.deepEqual(reads.slice(at), matches ? [exact] : []);
  }
});

test('malformed or oversized inputs and keys outside layout never reach either handler', async () => {
  const { channels, reads, writes } = fixture();
  let traps = 0;
  const accessor = { get include() { ++traps; }, exclude: [] };
  const array = []; Object.defineProperty(array, 0, { enumerable: true, get() { ++traps; } });
  const proxy = new Proxy({}, { getPrototypeOf() { ++traps; }, ownKeys() { ++traps; } });
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  for (const args of [null, [], {}, { include: ['sand.'] }, { include: 'sand.', exclude: [] }, { include: [], exclude: null },
    { include: [1], exclude: [] }, { include: Array(1), exclude: [] }, { include: array, exclude: [] },
    { include: Array(65).fill(''), exclude: [] }, { include: [], exclude: ['x'.repeat(257)] }, { ...broad, extra: true },
    Object.create(broad), accessor, proxy, { include: revoked.proxy, exclude: [] }]) expectFailure(await channels[read](event, args), invalid);
  for (const badKey of [privateKey, 'sand.client.slice.account.demo.ui-agent-refs', `${key}.child`, 'sand.', '', '__proto__', 'constructor'])
    expectFailure(await channels[write](event, { key: badKey, value: '' }), invalid);
  for (const args of [null, { key }, { key, value: null }, { key, value: {} }, { key, value: 3 }, { key, value: '', method: readName },
    Object.create({ key, value: '' }), { key, get value() { ++traps; } }, { key, value: 'x'.repeat(65537) },
    { key, value: '\u00e9'.repeat(32769) }]) expectFailure(await channels[write](event, args), invalid);
  assert.equal(traps, 0); assert.deepEqual([reads, writes], [[], []]);
  const ceiling = { key, value: '\u00e9'.repeat(32768) };
  assert.deepEqual(await channels[write](event, ceiling), success(undefined));
  assert.deepEqual(writes, [ceiling]);
});

test('project desktop persistence reopens the opaque layout string without disclosing siblings or account data', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'project-layout-contract-'));
  const file = path.join(dir, 'local-client-persistence.json');
  t.after(async () => { if (existsSync(file)) await unlink(file); await rmdir(dir); });
  const offline = t.mock.method(globalThis, 'fetch', () => { assert.fail('unexpected network access'); });
  const deps = { command: assert.fail, request: assert.fail, openExternal: assert.fail };
  const bind = call => createLocalLayoutPersistence({ window,
    readMany: args => call(readName, args), write: args => call(writeName, args) });
  const original = await createLocalServices(dir, {}, deps), first = bind(original);
  await original(writeName, { key: privateKey, value: 'private fixture content' });
  await original(writeName, { key: `${key}.other`, value: 'private fixture content' });
  assert.deepEqual(await first[read](event, broad), success({}));
  const text = JSON.stringify({ schemaVersion: 3, value: { sidebar: { expandedWidth: 320, isCollapsed: false } } });
  assert.deepEqual(await first[write](event, { key, value: text }), success(undefined));
  const reopened = bind(await createLocalServices(dir, {}, deps));
  assert.deepEqual(await reopened[read](event, broad), success({ [key]: text }));
  expectFailure(await reopened[write](event, { key: privateKey, value: '' }), invalid);
  assert.deepEqual(await reopened[write](event, { key, value: '' }), success(undefined));
  assert.deepEqual(await reopened[read](event, exact), success({ [key]: '' }));
  const check = await createLocalServices(dir, {}, deps);
  assert.equal(await check('readClientPersistence', { key: privateKey }), 'private fixture content');
  assert.equal(offline.mock.callCount(), 0);
});

test('malformed results and handler faults use a failed envelope without leaking local details', async () => {
  const boom = () => { throw new Error('private fixture content'); };
  let getters = 0;
  const unreadable = { get [key]() { ++getters; return 'private fixture content'; } };
  for (const result of [null, [], { [key]: 1 }, unreadable, { [key]: 'x'.repeat(65537) }, Object.create({ [key]: 'inherited' })]) {
    const { channels } = fixture({ readMany: () => result });
    expectFailure(await channels[read](event, broad), failed);
  }
  const { channels } = fixture({ readMany: boom, write: async () => boom() });
  expectFailure(await channels[read](event, broad), failed);
  expectFailure(await channels[write](event, { key, value: 'layout' }), failed);
  expectFailure(await fixture({ write: () => true }).channels[write](event, { key, value: '' }), failed);
  assert.equal(getters, 0);
});

test('cross-window, subframe and untrusted events are denied before validation, storage or probing', async () => {
  const { channels, reads, writes } = fixture();
  for (const impostor of [null, {}, { trusted: true }, { sender, senderFrame: {} }, { sender: {}, senderFrame: frame },
    { get sender() { throw new Error('private fixture content'); } }]) {
    expectFailure(channels[probe](impostor, writeName), denied);
    expectFailure(channels[probe](impostor, 42), denied);
    expectFailure(await channels[read](impostor, null), denied);
    expectFailure(await channels[write](impostor, { key, value: '' }), denied);
  }
  assert.deepEqual([reads, writes], [[], []]);
  assert.deepEqual(channels[probe](event, writeName), success(true), 'a rejected stranger cannot revoke the owner');
});

test('revocation cuts off captured callbacks and suppresses both kinds of pending reply, including a rejection', async () => {
  for (const channel of [read, write]) for (const reject of [false, true]) {
    const delayed = Promise.withResolvers(), calls = [];
    const hold = args => { calls.push(args); return delayed.promise; };
    const { channels, revoke } = fixture({ readMany: hold, write: hold });
    const handle = channels[channel], args = channel === read ? broad : { key, value: 'layout' };
    const pending = handle(event, args);
    assert.deepEqual(calls, [channel === read ? exact : args]);
    revoke(); revoke();
    expectFailure(channels[probe](event, readName), denied);
    expectFailure(await handle(event, args), denied);
    if (reject) delayed.reject(new Error('private fixture content'));
    else delayed.resolve(channel === read ? { [key]: 'private fixture content' } : undefined);
    expectFailure(await pending, denied);
    assert.equal(calls.length, 1, 'no new operation after revocation');
  }
});

test('replacing the captured frame or contents, destroying the window or losing its state invalidates pending replies', async () => {
  for (const change of ['frame', 'contents', 'destroyed', 'unavailable']) {
    let invoked = 0;
    const delayed = Promise.withResolvers(), wc = { mainFrame: frame };
    const owner = { webContents: wc, isDestroyed: () => false }, sourceEvent = { sender: wc, senderFrame: frame };
    const { channels } = fixture({ window: owner, readMany: () => { invoked++; return delayed.promise; } });
    const pending = channels[read](sourceEvent, exact);
    if (change === 'frame') wc.mainFrame = {};
    if (change === 'contents') owner.webContents = { mainFrame: frame };
    if (change === 'destroyed') owner.isDestroyed = () => true;
    if (change === 'unavailable') owner.isDestroyed = () => { throw Error('private fixture content'); };
    delayed.resolve({ [key]: 'private fixture content' });
    expectFailure(await pending, denied);
    expectFailure(channels[probe]({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, readName), denied);
    owner.webContents = wc; wc.mainFrame = frame; owner.isDestroyed = () => false;
    expectFailure(await channels[read](sourceEvent, exact), denied, 'old binding must stay revoked');
    assert.equal(invoked, 1);
  }
});
