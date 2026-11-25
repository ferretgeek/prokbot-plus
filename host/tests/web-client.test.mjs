import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { Auth } from '../server/auth.mjs';
import { BUNDLE_SCHEMA, WebClient, bundlePath, readBundleZip, verifyBundle, webManifest } from '../server/web-client.mjs';

const REQUIRED = ['renderer/index.html', 'client/boot-data.js', 'client/compat.js', 'client/bridge.js', 'client/native.js',
  'client/web-shell.js', 'client/official-preload.js', 'client/vnc-bridge.js', 'client/vnc-preload.js', 'client/icon.png'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** A minimal ZIP writer: stored or deflated entries, as web/patchers/patch.mjs produces. */
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data, deflate = false] of entries) {
    const nameBytes = Buffer.from(name), body = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body); central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function bundleFiles(version = '1.1.0') {
  const files = new Map(REQUIRED.map(name => [name, Buffer.from(`/* ${name} */`)]));
  files.set('renderer/index.html', Buffer.from(`<!doctype html><title>Demo ${version}</title>`));
  files.set('renderer/assets/index-demo.js', Buffer.from('console.log("demo");\n'.repeat(200)));
  return files;
}
function bundle(files = bundleFiles(), { version = '1.1.0', manifestFiles } = {}) {
  const manifest = { schema: BUNDLE_SCHEMA, rendererVersion: version, recommended: true, builtAt: '2026-01-01T00:00:00.000Z',
    files: manifestFiles ?? Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }])) };
  return zip([['web-bundle.json', Buffer.from(JSON.stringify(manifest))], ...[...files].map(([name, bytes]) => [name, bytes, bytes.length > 512])]);
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-web-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = await new Auth(dir).load();
  const web = await new WebClient(dir, { auth }).load();
  return { dir, auth, web };
}

test('bundle paths stay inside renderer/ and client/', () => {
  for (const name of ['renderer/index.html', 'client/desktop/workspace.css', 'renderer/assets/a@2x~b+c.png'])
    assert.equal(bundlePath(name), name);
  for (const name of ['web-bundle.json', '../renderer/x', 'renderer/../client/x', 'renderer//x', 'renderer/./x', '/renderer/x',
    'renderer\\x', 'renderer/x y', 'other/x', 'renderer/', 'client/%2e%2e/x', `renderer/${'a'.repeat(600)}`, 7])
    assert.equal(bundlePath(name), null, String(name));
});

test('bundle ZIPs are read with every entry checked against the manifest', () => {
  const files = bundleFiles(), bytes = bundle(files);
  const entries = readBundleZip(bytes);
  assert.equal(entries.size, files.size + 1);
  assert.deepEqual(entries.get('renderer/assets/index-demo.js'), files.get('renderer/assets/index-demo.js'));
  assert.equal(verifyBundle(entries).rendererVersion, '1.1.0');

  const corrupt = Buffer.from(bytes);
  corrupt[bytes.indexOf('/* client/bridge.js */') + 3] ^= 1;
  assert.throws(() => readBundleZip(corrupt), /校验失败/);
  assert.throws(() => readBundleZip(Buffer.from('not a zip at all, just text padding the length')), /ZIP 目录无效/);
  assert.throws(() => readBundleZip(zip([['web-bundle.json', Buffer.from('{}')], ['../evil.js', Buffer.from('x')]])), /路径无效/);
  assert.throws(() => readBundleZip(zip([['web-bundle.json', Buffer.from('{}')], ['client/a.js', Buffer.from('1')], ['client/a.js', Buffer.from('2')]])), /路径重复/);

  const changed = new Map(files); changed.set('client/bridge.js', Buffer.from('changed'));
  const manifestFiles = Object.fromEntries([...files].map(([name, data]) => [name, { bytes: data.length, sha256: sha(data) }]));
  assert.throws(() => verifyBundle(readBundleZip(bundle(changed, { manifestFiles }))), /与清单不一致：client\/bridge\.js/);
  const extra = new Map(files); extra.set('client/extra.js', Buffer.from('extra'));
  assert.throws(() => verifyBundle(readBundleZip(bundle(extra, { manifestFiles }))), /与清单不一致/);
  const missing = new Map(files); missing.delete('client/web-shell.js');
  assert.throws(() => verifyBundle(readBundleZip(bundle(missing))), /缺少 client\/web-shell\.js/);
  assert.throws(() => verifyBundle(readBundleZip(bundle(files, { version: 'latest' }))), /版本无效/);
  assert.throws(() => verifyBundle(readBundleZip(zip([['web-bundle.json', Buffer.from('{"schema":"other"}')], ['client/a.js', Buffer.from('a')]]))), /格式不受支持/);
  assert.throws(() => verifyBundle(new Map([['client/a.js', Buffer.from('a')]])), /缺少 web-bundle\.json/);
});

test('installing enables the first bundle, serves it compressed and keeps the choice on replacement', async t => {
  const { dir, auth, web } = await fixture(t);
  assert.deepEqual([web.installed, web.available], [false, false]);
  await assert.rejects(web.setEnabled(true), /请先上传/);
  const status = await web.install(bundle());
  assert.deepEqual([status.installed, status.enabled, status.rendererVersion, status.files], [true, true, '1.1.0', REQUIRED.length + 1]);
  assert.equal(webManifest().start_url, '/web/');

  const server = http.createServer((request, response) => web.serve(request, response, decodeURIComponent(request.url.slice(1)))
    .catch(error => { response.writeHead(error.status ?? 500); response.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const asset = await fetch(base + 'renderer/assets/index-demo.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-encoding'), 'gzip');
  assert.equal(asset.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal(await asset.text(), 'console.log("demo");\n'.repeat(200));
  const page = await fetch(base + 'renderer/index.html');
  assert.equal(page.headers.get('cache-control'), 'private, no-cache');
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal((await fetch(base + 'renderer/index.html', { headers: { 'if-none-match': page.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(base + 'renderer/missing.js')).status, 404);

  await web.setEnabled(false);
  const second = await web.install(bundle(bundleFiles('1.2.0'), { version: '1.2.0' }));
  assert.deepEqual([second.enabled, second.rendererVersion], [false, '1.2.0']);
  assert.match(await (await fetch(base + 'renderer/index.html')).text(), /Demo 1\.2\.0/);
  assert.deepEqual((await readdir(join(dir, 'web-client'))).sort(), ['current']);
  await assert.rejects(web.install(Buffer.from('broken')), /大小无效|ZIP/);
  assert.equal(web.status().rendererVersion, '1.2.0', 'a rejected upload keeps the installed bundle');

  // A restart after an interrupted upload removes what the upload left behind.
  await mkdir(join(dir, 'web-client', 'stage-0123456789ab'));
  const reloaded = await new WebClient(dir, { auth }).load();
  assert.deepEqual((await readdir(join(dir, 'web-client'))).sort(), ['current']);
  assert.equal(reloaded.status().rendererVersion, '1.2.0');
  assert.equal((await reloaded.remove()).installed, false);
  assert.equal(existsSync(join(dir, 'web-client', 'current')), false);
});

test('the browser cookie is a device token only for web devices, with the header and the Host origin', async t => {
  const { auth, web } = await fixture(t);
  await web.install(bundle());
  const { pairingKey } = await auth.createPairing();
  const browser = await auth.pair({ pairingKey, deviceName: 'Web client · Demo' }, { web: true });
  assert.equal(auth.authenticate(browser.token).platform, 'web');
  const desktopKey = (await auth.createPairing()).pairingKey;
  const desktop = await auth.pair({ pairingKey: desktopKey, deviceName: 'Demo Mac', platform: 'desktop' });
  await assert.rejects(auth.pair({ pairingKey: (await auth.createPairing()).pairingKey, deviceName: 'Demo' }), /desktop 或 ios/);
  assert.equal(auth.authenticate((await auth.addWebDevice('Admin browser')).token).platform, 'web');

  const origin = 'https://host.example';
  const request = (token, headers = {}) => ({ headers: { cookie: `other=1; grokbot_web=${token}`, ...headers } });
  assert.equal(web.browserDevice(request(browser.token)).device.id, browser.deviceId);
  assert.equal(web.browserDevice(request(desktop.token)), null, 'a desktop token in the cookie is not a browser sign-in');
  assert.equal(web.deviceToken(request(browser.token, { 'x-grokbot-web': '1', origin }), origin), browser.token);
  assert.equal(web.deviceToken(request(browser.token, { 'x-grokbot-web': '1' }), origin), browser.token);
  assert.throws(() => web.deviceToken(request(browser.token), origin), /请从网页版发起请求/);
  assert.throws(() => web.deviceToken(request(browser.token, { 'x-grokbot-web': '1', origin: 'https://evil.example' }), origin), /来源不匹配/);
  assert.equal(web.deviceToken({ headers: {} }, origin), null);

  assert.match(web.sessionCookie(browser.token, origin), /^grokbot_web=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(web.sessionCookie(browser.token, 'http://192.0.2.1'), /Secure/);
  assert.match(web.sessionCookie('', origin), /Max-Age=0/);

  await web.setEnabled(false);
  assert.equal(web.browserDevice(request(browser.token)), null);
  assert.throws(() => web.deviceToken(request(browser.token, { 'x-grokbot-web': '1' }), origin), /网页版未启用/);
});

test('admin sign-in tickets work once and expire after two minutes', async t => {
  const { web } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'] });
  const ticket = web.issueTicket('Admin browser');
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(web.redeemTicket(ticket), 'Admin browser');
  assert.throws(() => web.redeemTicket(ticket), /登录链接已失效/);
  const late = web.issueTicket('Admin browser');
  t.mock.timers.tick(2 * 60_000);
  assert.throws(() => web.redeemTicket(late), /登录链接已失效/);
  assert.throws(() => web.redeemTicket('not a ticket'), /登录链接已失效/);
  assert.throws(() => web.issueTicket(' '), /设备名称/);
});

test('the noVNC page gains the computer-view bridge from the installed bundle', async t => {
  const { web } = await fixture(t);
  await web.install(bundle());
  assert.equal(WebClient.injectVncBridge('<html><head lang="en"><title>x</title></head></html>', '/vnc/desktop'),
    '<html><head lang="en"><script src="/vnc/desktop/__grokbot-vnc-bridge.js"></script>' +
    '<script src="/vnc/desktop/__grokbot-vnc-preload.js"></script><title>x</title></head></html>');
  assert.match(WebClient.injectVncBridge('<p>no head</p>', '/vnc/fork'), /^<script src="\/vnc\/fork\/__grokbot-vnc-bridge\.js">/);
  const script = String(await web.vncScript('vnc-bridge', 'https://host.example'));
  assert.equal(script, 'window.__grokbotAppOrigin = "https://host.example";\n/* client/vnc-bridge.js */');
  assert.equal(String(await web.vncScript('vnc-preload', 'https://host.example')), '/* client/vnc-preload.js */');
});

// The routes run the whole Host service, which needs its dependencies: npm ci --prefix host/server.
const dependencies = existsSync(new URL('../server/node_modules/ws/package.json', import.meta.url));
test('Host routes: separate web listener, sign-in, cookie API, VNC bridge and admin tickets', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-web-routes-'));
  const core = http.createServer((request, response) => {
    if (request.url === '/vnc.html') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<html><head><title>noVNC</title></head></html>'); }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/api/listAgents' ? [{ id: 'demo', name: 'Demo Bot' }] : null));
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  await assert.rejects(createSelfHostServer({ dataDir: dir, publicUrl: 'https://bot.example', webPublicUrl: 'https://bot.example/' }),
    /GROKBOT_WEB_PUBLIC_URL must differ/);
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl,
    internalToken: 'a'.repeat(40) });
  await host.start(0, '127.0.0.1', 0);
  t.after(async () => { await host.close(); await new Promise(resolve => core.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.server.address().port}`, webOrigin = `http://127.0.0.1:${host.webServer.address().port}`;
  const client = base => (path, { cookie, headers, ...options } = {}) => fetch(base + path, { redirect: 'manual', ...options,
    headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const call = client(origin), web = client(webOrigin);
  const json = { 'content-type': 'application/json', 'x-grokbot-web': '1' };
  const csrf = { 'content-type': 'application/json', 'x-grokbot-csrf': '1' };

  assert.equal((await web('/web/api/session').then(r => r.json())).available, false);
  assert.equal((await web('/web/renderer/index.html')).status, 404);
  const password = 'demo-admin-password', adminToken = await host.auth.setup(host.auth.setupKey, password);
  const admin = `grokbot_admin=${adminToken}`;
  assert.equal((await call('/admin/api/web-client', { method: 'PUT', body: bundle(), headers: { 'content-type': 'application/zip', 'x-grokbot-csrf': '1' } })).status, 401);
  const uploaded = await call('/admin/api/web-client', { method: 'PUT', body: bundle(), cookie: admin,
    headers: { 'content-type': 'application/zip', 'x-grokbot-csrf': '1' } });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json().then(value => [value.available, value.url]), [true, `${webOrigin}/web/`]);
  const status = (await call('/admin/api/status', { cookie: admin }).then(r => r.json())).webClient;
  assert.deepEqual([status.rendererVersion, status.url], ['1.1.0', `${webOrigin}/web/`]);

  // The main listener serves nothing of the web client; old links lead to its own listener.
  assert.equal((await call('/web/?agent=demo')).headers.get('location'), `${webOrigin}/web/?agent=demo`);
  assert.equal((await call('/web/login')).headers.get('location'), `${webOrigin}/web/login`);
  for (const path of ['/web/api/session', '/web/renderer/index.html', '/web/renderer/assets/index-demo.js', '/web/manifest.webmanifest', '/local-client/icon.png'])
    assert.equal((await call(path)).status, 404, path);
  for (const path of ['/web/api/pair', '/web/api/ticket', '/web/api/logout'])
    assert.equal((await call(path, { method: 'POST', headers: json, body: '{}' })).status, 404, path);

  // The web listener serves nothing of the administration, whatever cookie comes with the request.
  for (const path of ['/admin/api/session', '/admin/api/status', '/admin/api/model', '/connectors/result', '/healthz', '/app.js', '/model.js'])
    assert.equal((await web(path, { cookie: admin })).status, 404, path);
  for (const path of ['/admin/api/model', '/admin/api/pairing-keys', '/admin/api/web-client/open', '/admin/api/login'])
    assert.equal((await web(path, { method: path.endsWith('model') ? 'PUT' : 'POST', cookie: admin, headers: { ...csrf, origin: webOrigin },
      body: JSON.stringify({ baseUrl: 'https://collector.example', password }) })).status, 404, path);
  for (const path of ['/connect/pair', '/federation/v1/pair', '/internal/notifications', '/local-exec/responses'])
    assert.equal((await web(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404, path);
  assert.equal((await web('/admin')).headers.get('location'), `${origin}/admin`);
  assert.equal((await web('/')).headers.get('location'), '/web/');

  // A page on the web client's origin cannot use the administrator's cookie on the main listener:
  // writes fail the origin and CSRF checks, and no response carries CORS headers, so reads stay unreadable.
  const write = headers => call('/admin/api/model', { method: 'PUT', cookie: admin, headers: { ...headers, origin: webOrigin }, body: '{}' });
  assert.equal((await write(csrf)).status, 403);
  assert.equal((await write({ 'content-type': 'text/plain' })).status, 403);
  const preflight = await call('/admin/api/model', { method: 'OPTIONS', headers: { origin: webOrigin,
    'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-grokbot-csrf' } });
  assert.equal(preflight.status, 403);
  const read = await call('/admin/api/model', { cookie: admin, headers: { origin: webOrigin } });
  for (const response of [preflight, read])
    assert.deepEqual([...response.headers.keys()].filter(name => name.startsWith('access-control-')), []);

  // Signed out: the sign-in page is public, the interface is not.
  assert.equal((await web('/web/?agent=demo')).headers.get('location'), '/web/login?agent=demo');
  assert.equal((await web('/web/renderer/index.html')).headers.get('location'), '/web/login');
  assert.equal((await web('/web/renderer/assets/index-demo.js')).status, 401);
  const login = await web('/web/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(login.headers.get('x-content-type-options'), 'nosniff');
  for (const asset of (await login.text()).matchAll(/(?:href|src)="(\/[\w.-]+)"/g))
    assert.equal((await web(asset[1])).status, 200, asset[1]);
  assert.equal((await web('/i18n.js')).status, 200, 'imported by the sign-in script');

  const { pairingKey } = await host.auth.createPairing();
  const pair = body => web('/web/api/pair', { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal((await web('/web/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingKey, deviceName: 'Web client · Demo' }) })).status, 403);
  assert.equal((await web('/web/api/pair', { method: 'POST', headers: { ...json, origin },
    body: JSON.stringify({ pairingKey, deviceName: 'Web client · Demo' }) })).status, 403);
  assert.equal((await pair({ pairingKey: 'ZZZZ99', deviceName: 'Web client · Demo' })).status, 401);
  const signedIn = await pair({ pairingKey, deviceName: 'Web client · Demo' });
  assert.equal(signedIn.status, 201);
  const setCookie = signedIn.headers.get('set-cookie');
  assert.match(setCookie, /^grokbot_web=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const browser = setCookie.split(';')[0], deviceId = (await signedIn.json()).deviceId;
  assert.equal(host.auth.device(deviceId).platform, 'web');

  assert.equal((await web('/web/', { cookie: browser })).headers.get('location'), '/web/renderer/index.html');
  const page = await web('/web/renderer/index.html', { cookie: browser });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const asset = await web('/web/renderer/assets/index-demo.js', { cookie: browser });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal((await web('/local-client/icon.png', { cookie: browser })).status, 200);
  assert.equal((await web('/web/manifest.webmanifest')).status, 200);

  // The device API takes the cookie only on the web listener, with the header and the web client's origin.
  const agents = (headers, to = web, cookie = browser) => to('/api/listAgents', { method: 'POST', cookie, headers, body: '{}' });
  assert.deepEqual(await (await agents(json)).json(), [{ id: 'demo', name: 'Demo Bot' }]);
  assert.equal((await agents({ 'content-type': 'application/json' })).status, 403);
  assert.equal((await agents({ ...json, origin })).status, 403);
  assert.equal((await agents({ ...json, origin: webOrigin })).status, 200);
  assert.equal((await agents(json, call)).status, 401, 'the main listener ignores the web client cookie');
  const desktopKey = (await host.auth.createPairing()).pairingKey;
  const desktop = await host.auth.pair({ pairingKey: desktopKey, deviceName: 'Demo Mac', platform: 'desktop' });
  const bearer = token => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
  assert.equal((await agents(json, web, `grokbot_web=${desktop.token}`)).status, 401);
  assert.equal((await agents(bearer(desktop.token), call, null)).status, 200);
  assert.equal((await agents(bearer(desktop.token), web, null)).status, 401, 'apps use the main listener');
  assert.equal((await agents(bearer(browser.split('=')[1]), call, null)).status, 401, 'a web client token is no app token');

  // The computer view: the noVNC page gains the bridge, served with the page's ticket, on the web listener only.
  const ticket = host.tickets.issue(deviceId, 'desktop');
  assert.equal((await call(`/vnc/desktop/vnc.html?ticket=${ticket}`)).status, 401);
  const vnc = await web(`/vnc/desktop/vnc.html?ticket=${ticket}`);
  assert.match(await vnc.text(), /<head><script src="\/vnc\/desktop\/__grokbot-vnc-bridge\.js"><\/script>/);
  const vncCookie = vnc.headers.get('set-cookie').split(';')[0];
  const bridge = await web('/vnc/desktop/__grokbot-vnc-bridge.js', { cookie: vncCookie });
  assert.equal(bridge.status, 200);
  assert.match(await bridge.text(), new RegExp(`^window\\.__grokbotAppOrigin = "${webOrigin.replace(/\./g, '\\.')}";`));
  assert.equal((await web('/vnc/desktop/__grokbot-vnc-bridge.js')).status, 401);
  const desktopTicket = host.tickets.issue(desktop.deviceId, 'desktop');
  assert.equal((await web(`/vnc/desktop/vnc.html?ticket=${desktopTicket}`)).status, 401);
  assert.doesNotMatch(await (await call(`/vnc/desktop/vnc.html?ticket=${desktopTicket}`)).text(), /__grokbot-vnc/,
    'apps keep the unmodified noVNC page');

  // "Open in this browser": the admin page gets a one-time ticket for the web client's sign-in page, never a cookie.
  const open = () => call('/admin/api/web-client/open', { method: 'POST', cookie: admin, headers: csrf, body: JSON.stringify({ deviceName: 'Admin browser' }) });
  const opened = await open();
  assert.equal(opened.status, 201);
  assert.equal(opened.headers.get('set-cookie'), null);
  const [signInPage, fragment] = (await opened.json()).url.split('#');
  assert.equal(signInPage, `${webOrigin}/web/login`);
  const redeem = (value, cookie) => web('/web/api/ticket', { method: 'POST', cookie, headers: json, body: JSON.stringify({ ticket: value }) });
  const adminTicket = new URLSearchParams(fragment).get('ticket');
  assert.equal((await web('/web/api/ticket', { method: 'POST', headers: { ...json, origin }, body: JSON.stringify({ ticket: adminTicket }) })).status, 403);
  const exchanged = await redeem(adminTicket);
  assert.equal(exchanged.status, 201);
  const adminBrowser = exchanged.headers.get('set-cookie').split(';')[0];
  assert.equal((await redeem(adminTicket)).status, 401, 'a ticket works once');
  const again = await redeem(new URLSearchParams((await (await open()).json()).url.split('#')[1]).get('ticket'), adminBrowser);
  assert.equal(again.status, 200, 'a signed-in browser keeps its device');
  assert.equal(host.auth.devices().filter(item => item.platform === 'web' && !item.revokedAt).length, 2);

  // Signing out revokes this browser's device.
  assert.equal((await web('/web/api/logout', { method: 'POST', cookie: browser, headers: json, body: '{}' })).status, 200);
  assert.equal(host.auth.device(deviceId), undefined);
  assert.equal((await agents(json)).status, 401);

  // Turned off: no sign-in, no interface and no cookie API.
  await host.webClient.setEnabled(false);
  assert.equal((await web('/web/renderer/index.html', { cookie: adminBrowser })).headers.get('location'), '/web/login');
  assert.equal((await pair({ pairingKey: (await host.auth.createPairing()).pairingKey, deviceName: 'Web client · Demo' })).status, 404);
  assert.equal((await agents(json, web, adminBrowser)).status, 403);
  assert.equal((await open()).status, 409);
});

test('an invalid upload is refused before anything is written', async t => {
  const { dir, web } = await fixture(t);
  await assert.rejects(web.install(bundle(bundleFiles(), { version: 'x' })), /版本无效/);
  assert.equal(existsSync(join(dir, 'web-client')), false);
  assert.equal(web.status().installed, false);
});
