import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';
import { readZip, writeZip, createEntry, entryBytes, signApk, verifyApk, createSigningIdentity } from '../patchers/apk.mjs';
import { androidIndexHtml, preloadMethods, wrapPreload, wrapVncPreload, loadSigningIdentity, BRIDGE_TAGS } from '../patchers/patch.mjs';
import { RENDERER_PATCHES, patchRendererFile } from '../patchers/renderer-patches.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

// The client modules import ./desktop/*.mjs, which the patcher copies from the shared
// desktop client; load them from the same layout as inside the APK.
async function loadClient() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-client-'));
  await cp(path.join(repo, 'android/client'), root, { recursive: true });
  for (const name of ['i18n.mjs', 'external-url.mjs', 'connectors.mjs'])
    await cp(path.join(repo, 'mac/clients/desktop', name), path.join(root, 'desktop', name));
  const load = name => import(pathToFileURL(path.join(root, name)).href);
  return { root, services: await load('services.js'), webview: await load('webview.js'), gateway: await load('gateway.js'),
    layout: await load('layout.js'), anchors: await load('anchor-fallback.js') };
}
const client = await loadClient();
test.after(() => rm(client.root, { recursive: true, force: true }));

test('reconnecting releases abort listeners after each wait and handles an already closed workspace', async () => {
  const control = new AbortController();
  for (let i = 0; i < 3; i++) await client.gateway.wait(1, control.signal);
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  const pending = client.gateway.wait(5000, control.signal);
  control.abort(new Error('disconnected'));
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(client.gateway.wait(5000, control.signal), /disconnected/);
});

test('attachment download reports a failed system save even after all bytes were written', async t => {
  const calls = [], alerts = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    calls.push(endpoint);
    const body = endpoint.endsWith('save-begin') ? { id: 'demo' }
      : endpoint.endsWith('save-end') && JSON.parse(init.body).ok ? { ok: false, error: 'disk full' } : { ok: true };
    return Response.json(body);
  });
  const old = globalThis.alert; globalThis.alert = message => alerts.push(message);
  t.after(() => { if (old === undefined) delete globalThis.alert; else globalThis.alert = old; });
  const api = client.services.createAttachments({ command: async () => ({ totalSize: 1, bytesBase64: 'eA==' }) });
  assert.equal(await api.downloadAttachment({ path: '/data/demo.txt' }), false);
  assert.ok(calls.includes('/__native/save-chunk?id=demo'));
  assert.equal(alerts.length, 1);
});

test('APK entries are aligned, signed with scheme v2 and checked against tampering', () => {
  const identity = createSigningIdentity();
  const unsigned = writeZip([
    createEntry('AndroidManifest.xml', Buffer.from('manifest '.repeat(50))),
    createEntry('resources.arsc', Buffer.from('table'), { store: true }),
    createEntry('lib/x86_64/libdemo.so', Buffer.alloc(100, 7), { store: true }),
    createEntry('assets/web/client/bridge.js', Buffer.from('export {};\n'.repeat(20))),
  ]);
  const entries = readZip(unsigned).entries;
  assert.equal(entries.find(entry => entry.name === 'resources.arsc').dataStart % 4, 0);
  assert.equal(entries.find(entry => entry.name.endsWith('.so')).dataStart % 16384, 0);
  assert.equal(entryBytes(entries[0]).toString(), 'manifest '.repeat(50));

  const apk = signApk(unsigned, identity);
  assert.match(verifyApk(apk).subject, /Grok Bot Local/);
  assert.throws(() => signApk(apk, identity), /already signed/);
  const tampered = Buffer.from(apk);
  tampered[readZip(apk).entries.find(entry => entry.name === 'resources.arsc').dataStart] ^= 1;
  assert.throws(() => verifyApk(tampered), /do not match/);
});

test('the signing key is created once, private to the user, and reused', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-key-'));
  try {
    const filename = path.join(directory, 'nested', 'android-signing.json');
    const created = await loadSigningIdentity(filename);
    const loaded = await loadSigningIdentity(filename);
    assert.equal(created.created, true);
    assert.equal(loaded.created, false);
    assert.ok(loaded.certificate.equals(created.certificate));
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await writeFile(filename, JSON.stringify({ schema: 'other' }));
    await assert.rejects(loadSigningIdentity(filename), /签名文件格式不正确/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the interface entry gets the bridge before the renderer and may frame the local desktop port', () => {
  const html = '<!doctype html><html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; frame-src sand-html-preview: sand-canvas: sand-mcp-app:; img-src *">' +
    '<script type="module" crossorigin src="./assets/index-abc.js"></script></head><body></body></html>';
  const result = androidIndexHtml(html);
  assert.ok(result.indexOf(BRIDGE_TAGS) < result.indexOf('./assets/index-abc.js'));
  // The policy sits ahead of the module script; it must still be extended.
  assert.match(result, /frame-src sand-html-preview: sand-canvas: sand-mcp-app: http:\/\/127\.0\.0\.1:\*;/);
  assert.throws(() => androidIndexHtml(html.replace('frame-src', 'child-src')), /不一致/);
  assert.throws(() => androidIndexHtml(html.replace('</head>', '<script type="module" crossorigin src="./assets/index-x.js"></script></head>')), /不一致/);
});

test('the original preloads run as CommonJS inside their wrappers', async () => {
  const source = '"use strict";var e={};module.exports=e;exports.unused=1;' +
    'const c=require("electron");c.contextBridge.exposeInMainWorld("desktop",{ping:t().noArgs,send:t().args({x:1})});';
  assert.deepEqual(preloadMethods(source), ['ping', 'send']);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-preload-'));
  try {
    const file = path.join(directory, 'official-preload.mjs');
    await writeFile(file, wrapPreload(source));
    const exposed = {};
    const module = await import(pathToFileURL(file).href);
    globalThis.t = () => ({ noArgs: 'none', args: value => value });
    const electron = { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } } };
    module.default(name => name === 'electron' ? electron : null, {});
    delete globalThis.t;
    assert.deepEqual(Object.keys(exposed.desktop), ['ping', 'send']);
    assert.deepEqual(module.methods, ['ping', 'send']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const sent = [];
  const vncSource = '"use strict";var r={};module.exports=r;var U=require("electron");U.ipcRenderer.sendToHost("sand:vnc-session",process.type);';
  const window = { __grokbotVncPreload: {
    require: name => name === 'electron' ? { ipcRenderer: { sendToHost: (...args) => sent.push(args) } } : null,
    process: { type: 'renderer' } } };
  vm.runInNewContext(wrapVncPreload(vncSource), { window });
  assert.deepEqual(sent, [['sand:vnc-session', 'renderer']]);
});

test('renderer patches apply only to the pinned files and replace unique anchors', () => {
  assert.equal(patchRendererFile('assets/unrelated.js', Buffer.from('x')), null);
  for (const patch of RENDERER_PATCHES) {
    assert.match(patch.sha256, /^[0-9a-f]{64}$/);
    assert.throws(() => patchRendererFile(patch.file, Buffer.from('not the pinned file')), /不一致/);
    for (const [from, to] of patch.edits) assert.notEqual(from, to);
  }
});

test('attachments from the Host are remote paths, never local files', () => {
  const { remoteAttachmentPath, resolveLanguage, mimeFor } = client.services;
  assert.equal(remoteAttachmentPath('file:///home/bot/%E5%9B%BE.png'), '/home/bot/图.png');
  assert.equal(remoteAttachmentPath('/workspace/report.pdf'), '/workspace/report.pdf');
  assert.equal(remoteAttachmentPath('file://other-host/etc/passwd'), null);
  assert.equal(remoteAttachmentPath('https://example.com/a.png'), null);
  assert.equal(remoteAttachmentPath('a\0b'), null);
  assert.equal(resolveLanguage('zh-Hant-TW'), 'zh-TW');
  assert.equal(resolveLanguage('zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage('fr-FR'), 'fr');
  assert.equal(mimeFor('Photo.JPG'), 'image/jpeg');
  assert.equal(mimeFor('archive.unknown'), 'application/octet-stream');
});

test('only computer view pages of the paired Host load in the webview frame', () => {
  const { mapDesktopSource } = client.webview;
  const options = { hostOrigin: 'http://host.test:18080', vncOrigin: 'http://127.0.0.1:39720', base: 'http://127.0.0.1:39710/app/renderer/index.html' };
  const mapped = new URL(mapDesktopSource('http://host.test:18080/vnc/fork/vnc.html?path=%2Fvnc%2Ffork%2Fwebsockify&encrypt=1', options));
  assert.equal(mapped.origin, options.vncOrigin);
  assert.equal(mapped.pathname, '/vnc/fork/vnc.html');
  assert.equal(mapped.searchParams.get('encrypt'), '0');
  assert.equal(mapped.searchParams.get('path'), '/vnc/fork/websockify');
  assert.equal(mapDesktopSource('http://host.test:18080/api/listAgents', options), null);
  assert.equal(mapDesktopSource('http://elsewhere.test/vnc/desktop/vnc.html', options), null);
  assert.equal(mapDesktopSource('javascript:alert(1)', options), null);
});

test('server-sent events are parsed across chunk boundaries', async () => {
  const chunks = ['id: 1\nevent: agent\ndata: {"a":', '1}\n\n: keep-alive\n\ndata: {"b":2}\r\n', '\r\n'];
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const events = [];
  await client.gateway.readSse(body, event => { events.push(event); });
  assert.deepEqual(events, [{ data: { a: 1 }, id: '1', event: 'agent' }, { data: { b: 2 }, id: undefined, event: undefined }]);
});

test('anchor positions resolve against the containing block', () => {
  const { resolveAnchorExpression: resolve } = client.anchors;
  const anchor = { top: 100, left: 50, width: 200, height: 120 }, box = { top: 10, left: 0, width: 400, height: 800 };
  assert.equal(resolve('anchor(top)', 'top', anchor, box), '90px');
  assert.equal(resolve('anchor(bottom)', 'bottom', anchor, box), '590px');
  assert.equal(resolve('anchor(left)', 'left', anchor, box), '50px');
  assert.equal(resolve('anchor(right)', 'right', anchor, box), '150px');
  assert.equal(resolve('anchor-size(width)', 'width', anchor, box), '200px');
  assert.equal(resolve('anchor-size(height)', 'height', anchor, box), '120px');
  assert.equal(resolve('calc(anchor(start, 0px) + 16px)', 'insetInlineStart', anchor, box), 'calc(50px + 16px)');
  assert.equal(resolve('anchor(start)', 'insetInlineStart', anchor, box, { rtl: true }), '150px');
  assert.equal(resolve('anchor(--other center)', 'top', null, box, { named: () => anchor }), '150px');
  assert.equal(resolve('anchor(start, 0px)', 'insetInlineStart', null, box), '0px');
  assert.equal(resolve('anchor(top)', 'top', null, box), null);
});

test('wide image attachments are scaled down to the message column', () => {
  const frame = (width, height, available) => ({ style: { width: `${width}px`, height: `${height}px` }, parentElement: { clientWidth: available } });
  const wide = frame(320, 180, 240), narrow = frame(160, 90, 240);
  client.layout.fitAttachmentFrames({ querySelectorAll: () => [wide, narrow] });
  assert.deepEqual(wide.style, { width: '240px', height: '135px' });
  assert.deepEqual(narrow.style, { width: '160px', height: '90px' });
});


test('on a phone, a created Bot opens its conversation and a deleted one returns to the list', () => {
  const next = (change) => client.layout.screenAfterAgentChange({ previousListed: true, currentKnown: true, userCaused: true, ...change });
  // The list loading for the first time, or selecting nothing new, keeps the screen.
  assert.equal(next({ previous: undefined, current: 'a', screen: 'list', currentKnown: false }), 'list');
  assert.equal(next({ previous: 'a', current: 'a', screen: 'chat' }), 'chat');
  // In the list: a Bot the user just created opens; deleting the selected Bot selects another and stays.
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', currentKnown: false }), 'chat');
  assert.equal(next({ previous: null, current: 'b', screen: 'list', currentKnown: false }), 'chat');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', currentKnown: false, userCaused: false }), 'list');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', previousListed: false }), 'list');
  // The Host can take a while to make a Bot: after "Create" its conversation opens even when its
  // row was already listed and the tap was long ago; the selection clearing first keeps the list.
  assert.equal(next({ previous: null, current: 'b', screen: 'list', userCaused: false, creating: true }), 'chat');
  assert.equal(next({ previous: 'a', current: null, screen: 'list', creating: true }), 'list');
  // In a conversation: following a link to another Bot stays; the open Bot being deleted returns.
  assert.equal(next({ previous: 'a', current: 'b', screen: 'chat' }), 'chat');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'chat', previousListed: false }), 'list');
  assert.equal(next({ previous: 'a', current: null, screen: 'chat', previousListed: false }), 'list');
});

test('a Bot row shows when the Bot was last active, as the official phone app does', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime(); // a Wednesday
  const time = (date, locale = 'en-US') => {
    const text = client.layout.activityTime(date instanceof Date ? date.getTime() : date, now, locale);
    return text === null ? null : text.replace(/\s/g, ' ');
  };
  assert.equal(time(new Date(2026, 10, 11, 8, 41)), '8:41 AM');
  assert.equal(time(new Date(2026, 10, 11, 8, 41), 'zh-CN'), '8:41');
  assert.equal(time(new Date(2026, 10, 10, 23, 59)), 'Yesterday');
  assert.equal(time(new Date(2026, 10, 10, 0, 1), 'zh-CN'), '昨天');
  assert.equal(time(new Date(2026, 10, 9, 12, 0)), 'Monday');
  assert.equal(time(new Date(2026, 10, 1, 12, 0)), 'Nov 1');
  assert.equal(time(new Date(2025, 0, 2, 12, 0)), 'Jan 2, 2025');
  assert.equal(time(null), null);
  assert.equal(time(0), null);
});
