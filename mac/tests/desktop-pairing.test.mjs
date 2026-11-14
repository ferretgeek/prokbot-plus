import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as connection from '../clients/desktop/connection.mjs';
import { setLocaleSource } from '../clients/desktop/i18n.mjs';

setLocaleSource(() => 'en');
const server = 'https://fixture.invalid', deviceId = 'fixture-device', token = 'fixture-only-token'.repeat(2);
const record = { server, deviceId, token };
const reply = (extra = {}) => Response.json({ deviceId, token, gatewayUrl: server, ...extra }, { status: 201 });
const key = 'ABC234';

test('pairing normalizes a formatted full-width code and refuses malformed codes before contacting the Host', async () => {
  const requests = [];
  const fetcher = async (url, options) => { requests.push({ url, options }); return reply(); };
  assert.deepEqual(await connection.pair(server, '\uff41\uff42\uff43-\uff12\uff13\uff14', fetcher), record);
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url, `${server}/connect/pair`);
  assert.equal(options.redirect, 'error');
  assert.equal(JSON.parse(options.body).platform, 'desktop');
  assert.equal(JSON.parse(options.body).pairingKey, key);
  for (const invalid of ['', '12', 'ABCDEFG', 'ABC/23', null]) await assert.rejects(connection.pair(server, invalid, fetcher));
  assert.equal(requests.length, 1, 'invalid input should not spend a rate-limited Host attempt');
});

test('pairing preserves HTTP errors and rejects unusable device identities and wrong direct origins', async () => {
  await assert.rejects(connection.pair(server, key, async () => new Response('expired', { status: 401 })), /expired/i);
  await assert.rejects(connection.pair(server, key, async () => new Response('unavailable', { status: 503 })), /503/);
  for (const bad of [null, { deviceId: 42 }, { deviceId: ' ' }, { token: ' '.repeat(18) }]) {
    await assert.rejects(connection.pair(server, key, async () => bad ? reply(bad) : Response.json(null)), /invalid device credentials/i);
  }
  const different = { gatewayUrl: 'https://other-fixture.invalid' };
  await assert.rejects(connection.pair(server, key, async () => reply(different)), /different server address/i);
  assert.deepEqual(await connection.pair(server, key, async () => reply(different), { tunneled: true }), record);
});

async function formFixture(t, state, disconnect = async () => {}) {
  class Field extends EventTarget { value = ''; style = {}; }
  const fields = new Map(), requests = [];
  const document = { documentElement: {}, querySelector(id) {
    if (!fields.has(id)) fields.set(id, new Field());
    return fields.get(id);
  } };
  const window = { connection: { locale: 'en', status: async () => state, disconnect,
    pair: async (address, code, tailcat, edit) => { requests.push({ address, code, tailcat, edit }); return { ok: true }; } } };
  Object.assign(globalThis, { document, window });
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  await import(`../clients/desktop/connect.js?fixture=${encodeURIComponent(t.name)}`);
  await new Promise(resolve => setImmediate(resolve));
  return { fields, requests, submit: async () => {
    fields.get('#form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('pairing form preserves an active IME composition and submits the entire normalized paste', async t => {
  const { fields, requests, submit } = await formFixture(t, {});
  const field = fields.get('#key');
  const paste = '\uff41\uff42\uff43-\uff12\uff13\uff14';
  const html = await readFile(new URL('../clients/desktop/connect.html', import.meta.url), 'utf8');
  const maxLength = /<input id="key"[^>]*maxlength="(\d+)"/.exec(html)?.[1];
  field.value = paste.slice(0, Number(maxLength ?? Infinity));
  field.dispatchEvent(Object.assign(new Event('input'), { isComposing: true }));
  assert.equal(field.value, paste);
  field.dispatchEvent(new Event('compositionend'));
  assert.equal(field.value, key);
  fields.get('#server').value = server;
  await submit();
  assert.deepEqual(requests, [{ address: server, code: key, tailcat: false, edit: false }]);
});

test('the pairing window can retry a saved transport without a new code or explicitly forget it', async t => {
  let fail = true;
  const { fields, requests, submit } = await formFixture(t, { paired: true, connected: false, server, tailcat: true, error: 'offline' }, async () => {
    if (fail) throw new Error('fixture clear failed');
  });
  assert.equal(fields.get('#disconnect').hidden, false);
  assert.equal(fields.get('#key').required, false);
  fields.get('#server').value = 'https://changed-fixture.invalid';
  fields.get('#server').dispatchEvent(new Event('input'));
  assert.equal(fields.get('#key').required, true, 'automatic reuse is only for the saved address and transport');
  fields.get('#server').value = server;
  fields.get('#server').dispatchEvent(new Event('input'));
  await submit();
  assert.deepEqual(requests, [{ address: server, code: '', tailcat: true, edit: true }]);
  fields.get('#key').value = key;
  await submit();
  assert.equal(requests[1].edit, false, 'an explicit new code performs a fresh pairing');
  fields.get('#disconnect').dispatchEvent(new Event('click')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fields.get('#status').textContent, 'fixture clear failed');
  assert.equal(fields.get('#disconnect').hidden, false);
  fail = false;
  fields.get('#disconnect').dispatchEvent(new Event('click')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fields.get('#disconnect').hidden, true);
  assert.equal(fields.get('#key').required, true);
});

test('a saved device may retry its original origin or tunnel, never a different Host or transport', () => {
  assert.equal(connection.savedConnectionMatches(null, server, false), false);
  assert.equal(connection.savedConnectionMatches(record, `${server.toUpperCase()}:443/`, false), true);
  for (const address of ['http://fixture.invalid', 'https://other-fixture.invalid', `${server}:8443`, `${server}/other`, 'invalid']) {
    assert.equal(connection.savedConnectionMatches(record, address, false), false);
  }
  const link = `tc${'a'.repeat(32)}`;
  const tunnel = { ...record, tailcat: true, address: `tailcat://connect/${link}?port=8000` };
  assert.equal(connection.savedConnectionMatches(tunnel, link, true), true);
  assert.equal(connection.savedConnectionMatches(tunnel, `${link}b`, true), false);
  assert.equal(connection.savedConnectionMatches(tunnel, `tailcat://connect/${link}?port=8001`, true), false);
  assert.equal(connection.savedConnectionMatches(tunnel, server, false), false);
  assert.equal(connection.savedConnectionMatches(record, link, true), false);
});

test('editing a saved connection requires a status response for the same paired device', async () => {
  const status = value => connection.verifyDevice(server, record, async (url, options) => {
    assert.equal(url, `${server}/connect/status`);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    return value;
  });
  await status(Response.json({ deviceId }));
  for (const response of [Response.json({ deviceId: 'another-device' }), Response.json({}), new Response('proxy landing page'), new Response(null, { status: 401 })]) {
    await assert.rejects(status(response), /verify this device/i);
  }
});

test('only healthy workspace startup dismisses its original pairing window, never a revocation prompt', () => {
  let closed = 0;
  const pairing = { close() { closed++; } }, recovery = { close: () => assert.fail('closed the new recovery prompt') };
  connection.finishPairingWindow(pairing, pairing, 'fixture revoked');
  connection.finishPairingWindow(pairing, recovery, '');
  connection.finishPairingWindow(null, recovery, '');
  assert.equal(closed, 0);
  connection.finishPairingWindow(pairing, pairing, '');
  assert.equal(closed, 1);
});

test('failed tunnel startup keeps the saved device for retry but does not select a workspace transport', async () => {
  const saved = { ...record, server: '', address: 'synthetic-tunnel', tailcat: true, networkIdentity: 'synthetic-identity' };
  const store = { load: async () => saved };
  const binary = 'fixture-helper';
  const unavailable = await connection.restoreConnection(store, binary, async () => { throw new Error('fixture tunnel offline'); });
  assert.equal(unavailable.config, saved);
  assert.equal(unavailable.transport, null);
  assert.match(unavailable.connectionError, /reconnect/i);
  const recovered = await connection.restoreConnection(store, binary, async (address, enabled, options) => {
    assert.equal(address, saved.address); assert.equal(enabled, true);
    assert.deepEqual(options, { identity: saved.networkIdentity, binary });
    return { server, close() {} };
  });
  assert.equal(recovered.config.deviceId, deviceId); assert.equal(recovered.config.token, token);
  assert.equal(recovered.config.server, server); assert.equal(recovered.transport.server, server);
  assert.equal(recovered.connectionError, '');
});

test('concurrent credential changes persist in invocation order and logout cannot resurrect an old pairing', async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'prokbot-pair-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const store = connection.credentialStore(profile, storage);
  assert.equal(await store.load(), null);
  const writes = Array.from({ length: 16 }, (_, i) => store.save({ ...record, deviceId: `fixture-${i}` }));
  const results = await Promise.allSettled(writes);
  assert.ok(results.every(result => result.status === 'fulfilled'), 'pairing writes must not race over the same temporary file');
  assert.equal((await store.load()).deviceId, 'fixture-15');
  await Promise.all([store.save(record), store.clear()]);
  assert.equal(await store.load(), null);
  assert.deepEqual(await readdir(profile), []);
});

test('unusable saved credentials do not activate a workspace and a failed replacement preserves the existing device', async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'prokbot-credential-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  let available = true;
  const storage = { isEncryptionAvailable: () => available, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const store = connection.credentialStore(profile, storage);
  await store.save(record);
  available = false;
  await assert.rejects(store.save({ ...record, deviceId: 'different' }));
  available = true;
  assert.equal((await connection.credentialStore(profile, storage).load()).deviceId, record.deviceId);
  const file = path.join(profile, 'connection.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  for (const damaged of [{ deviceId: null }, { encryptedToken: '' }]) {
    await writeFile(file, JSON.stringify({ ...saved, ...damaged }));
    await assert.rejects(store.load(), /device credentials/i);
  }
  await store.save(record);
  assert.equal((await store.load()).token, token);
});
