import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { androidIndexHtml, preloadMethods, wrapPreload, wrapVncPreload } from '../patchers/patch.mjs';
import { applyPinnedRendererPatch, RENDERER_PATCHES } from '../patchers/renderer-patches.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const client = new URL('../client/', import.meta.url);
const desktop = new URL('../../mac/clients/desktop/', import.meta.url);

test('Android input pins refer to the correct side of each Windows recipe', async () => {
  const windows = new URL('../../windows/patchers/desktop/', import.meta.url);
  const supported = await json(new URL('supported.json', windows));
  const android = await json(new URL('../patchers/supported.json', import.meta.url));
  const manifest = await json(new URL('recipes/manifest.json', windows));
  assert.equal(android.desktopVersion, supported.version);
  const inputs = [
    ['dist/renderer/index.html', 'windows-recipe', android.rendererIndexSha256],
    ['dist/electron-preload/preload.cjs', 'windows-recipe', android.preloadSha256],
    ['dist/electron-preload/preload-vnc.cjs', 'original', android.vncPreloadSha256],
    ...RENDERER_PATCHES.map(p => [`dist/renderer/${p.file}`, p.input, p.sha256]),
  ];
  assert.ok(RENDERER_PATCHES.length > 0);
  assert.equal(new Set(inputs.map(([path]) => path)).size, inputs.length);
  for (const [path, input, pin] of inputs) {
    assert.match(pin, /^[a-f0-9]{64}$/, path);
    const matches = manifest.files.filter(entry => entry.path === path);
    if (input === 'original') {
      assert.equal(matches.length, 0, `Windows now rewrites ${path}`);
      continue; // Only the user's verified original can prove an untouched asset's bytes.
    }
    assert.equal(input, 'windows-recipe', path);
    assert.equal(matches.length, 1, `missing or duplicate producer: ${path}`);
    const [entry] = matches;
    assert.match(entry.recipe, /^[\w.-]+\.gz$/);
    const bytes = await readFile(new URL(`recipes/${entry.recipe}`, windows));
    assert.equal(sha(bytes), entry.sha256, entry.recipe);
    const recipe = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }));
    assert.equal(recipe.schema, 'grokbot-bytepatch/v1');
    assert.equal(recipe.targetSha256, pin, `stale Android input: ${path}`);
    if (path === 'dist/electron-preload/preload.cjs') assert.equal(recipe.sourceSha256, supported.preloadSha256);
  }
});

function fixturePatch(source, edits) {
  return { file: 'fixture.js', sha256: sha(source), edits };
}

test('renderer replacements use original byte offsets, independent of edit order', () => {
  const wrap = text => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text), Buffer.from([0xff])]);
  const source = wrap('first :: last');
  const edits = [['first', 'last'], ['last', 'longer tail']];
  for (const order of [edits, edits.toReversed()]) {
    assert.deepEqual(applyPinnedRendererPatch(fixturePatch(source, order), source), wrap('last :: longer tail'));
  }
  assert.deepEqual(source, wrap('first :: last'));
});

test('renderer drift, manufactured, empty, duplicate and overlapping anchors fail closed', () => {
  const reject = (text, edits, error) => {
    const source = Buffer.from(text);
    assert.throws(() => applyPinnedRendererPatch(fixturePatch(source, edits), source), error);
    assert.deepEqual(source, Buffer.from(text));
  };
  reject('first', [['first', 'new anchor'], ['new anchor', 'final']], /fixture\.js \(#2\)/);
  reject('first', [], /fixture\.js$/);
  reject('first', [['first', 'first']], /fixture\.js \(#1\)/);
  reject('first', [['', 'prefix']], /fixture\.js \(#1\)/);
  reject('aaa', [['aa', 'x']], /fixture\.js \(#1\)/);
  reject('abc', [['ab', 'x'], ['bc', 'y']], /fixture\.js \(#2\)/);
  const patch = fixturePatch('expected', [['expected', 'patched']]);
  assert.throws(() => applyPinnedRendererPatch(patch, Buffer.from('expected!')), /fixture\.js$/);
});

test('the HTML handoff preserves other CSP directives and orders the bridge before the entry', () => {
  const frame = 'frame-src sand-html-preview: sand-canvas: sand-mcp-app:;';
  const policy = `default-src 'self'; ${frame} connect-src 'self'; object-src 'none';`;
  const html = `<head><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<script src="./stock.js"></script><script type="module" crossorigin src="./assets/index-fixture.js"></script></head>';
  const patched = androidIndexHtml(html);
  assert.deepEqual([...patched.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]), [
    './stock.js', '../client/boot-data.js', '../client/desktop/workspace-keys.js', '../client/bridge.js', './assets/index-fixture.js',
  ]);
  assert.equal(patched.match(/content="([^"]+)"/)[1], policy.replace(frame, frame.slice(0, -1) + ' http://127.0.0.1:*;'));
  assert.throws(() => androidIndexHtml(html.replace(frame, `${frame} ${frame}`)));
});

// Independent consumer of the project's IPC interface, not extracted desktop code.
const fixturePreload = `
  const { ipcRenderer: ipc, contextBridge: world } = require('electron');
  const t = () => ({ noArgs: null, args: () => null });
  const declarations = { getThemeState:t().noArgs, setThemePreference:t().args() };
  world.exposeInMainWorld('desktop', {
    snapshot: () => ipc.sendSync('sand:boot-snapshot-sync'),
    probe: method => ipc.invoke('dune-rpc:main:probe', method),
    call: (method, args) => ipc.invoke('dune-rpc:main:m:' + method, args),
  });
  world.exposeInMainWorld('coordinatorPort', { open: () => new Promise((resolve, reject) => {
    ipc.once('sand:coordinator-port', event => resolve(event.ports[0]));
    ipc.invoke('sand:coordinator-port-request').catch(reject);
  }) });`;

async function stageBridge(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prokbot-renderer-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'desktop'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['bridge.js', 'native.js', 'services.js', 'gateway.js', 'layout.js', 'webview.js', 'anchor-fallback.js'])
    await copyFile(new URL(name, client), join(dir, name));
  for (const name of ['i18n.mjs', 'connectors.mjs', 'external-url.mjs'])
    await copyFile(new URL(name, desktop), join(dir, 'desktop', name));
  await writeFile(join(dir, 'official-preload.js'), wrapPreload(fixturePreload));
  return pathToFileURL(join(dir, 'bridge.js')).href;
}

function provideGlobals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
}

test('project bridge serves a boot snapshot, RPC outcomes and a protocol-v3 coordinator port', { timeout: 5000 }, async t => {
  assert.deepEqual(preloadMethods(fixturePreload), ['getThemeState', 'setThemePreference']);
  const entry = await stageBridge(t);
  const events = new EventTarget(), window = {};
  provideGlobals(t, {
    window, __grokbotAndroidBoot: { settings: { theme: 'dark' }, systemLocale: 'en' },
    grokbotActivityTime: undefined, CSS: { supports: () => true },
    document: { documentElement: { nodeType: 1, classList: { add() {}, toggle() {} }, querySelectorAll: () => [] } },
    addEventListener: events.addEventListener.bind(events), MutationObserver: class { observe() {} },
    Node: { ELEMENT_NODE: 1 }, HTMLElement: class {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 0,
  });
  t.after(() => events.dispatchEvent(new Event('pagehide')));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unexpected = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url === '/events') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (url === '/local/profile') return Response.json({ displayName: 'Fixture' });
    if (url === '/local/voice/status') return Response.json({ enabled: false });
    if (url === '/local/device') return new Response(null, { status: 204 });
    unexpected.push(url);
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  await import(entry);
  assert.equal(window.localBot.platform, 'android');
  const api = window.desktop, boot = api.snapshot();
  assert.equal(boot.mainEdge, 'served');
  assert.equal(boot.theme.resolved, 'dark');
  assert.equal(boot.language.resolved, 'en');
  assert.deepEqual(await api.probe('getThemeState'), { ok: true, value: true });
  assert.deepEqual(await api.probe('fixtureUnsupported'), { ok: true, value: false });
  assert.deepEqual(await api.call('getThemeState'), { ok: true, value: boot.theme });
  assert.deepEqual(await api.call('getLocalToolPermission'), { ok: true, value: 'never' });
  const denied = await api.call('setThemePreference', { preference: 'invalid' });
  assert.equal(denied.ok, false);
  assert.equal(denied.failure.code, 'edge/handler-failed');
  const opening = window.coordinatorPort.open();
  t.mock.timers.tick(0);
  const port = await opening;
  t.after(() => port.close());
  port.start();
  const exchange = frame => new Promise(resolve => {
    port.addEventListener('message', ({ data }) => resolve(data), { once: true });
    port.postMessage(frame);
  });
  assert.deepEqual(await exchange({ kind: 'lifecycle', phase: 'hello' }), { kind: 'lifecycle', phase: 'ready', protocolVersion: 3 });
  assert.deepEqual(await exchange({ kind: 'request', requestId: 'fixture', method: 'getMainAgent', args: {} }),
    { kind: 'reply', requestId: 'fixture', outcome: { status: 'ok', value: { agentId: null } } });
  assert.deepEqual(unexpected, []);
});

test('VNC preload IPC accepts only the workspace parent at its assigned origin', async () => {
  const origin = 'https://workspace.test', messages = [];
  const parent = { postMessage: (value, target) => messages.push({ target, ...structuredClone(value) }) };
  let receive;
  const window = { parent, __grokbotAppOrigin: origin, addEventListener: (type, fn) => { if (type === 'message') receive = fn; } };
  const document = Object.assign(new EventTarget(), { readyState: 'loading' });
  const context = vm.createContext({ window, document });
  vm.runInContext(await readFile(new URL('vnc-bridge.js', client), 'utf8'), context);
  vm.runInContext(wrapVncPreload(`
    const { ipcRenderer } = require('electron');
    ipcRenderer.once('fixture:measure', (_event, width) => ipcRenderer.sendToHost('fixture:size', width, process.type));`), context);
  assert.deepEqual(messages, []);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  const send = (source, origin) => receive({ source, origin,
    data: { grokbotWebview: 1, type: 'send', channel: 'fixture:measure', args: [320] } });
  send({}, origin);
  send(parent, 'https://other.test');
  assert.deepEqual(messages, [{ target: origin, grokbotWebview: 1, type: 'ready' }]);
  send(parent, origin);
  send(parent, origin);
  assert.deepEqual(messages.slice(1), [{ target: origin, grokbotWebview: 1, type: 'ipc', channel: 'fixture:size', args: [320, 'renderer'] }]);
});
