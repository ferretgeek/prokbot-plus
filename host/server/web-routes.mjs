// The web client's own listener (GROKBOT_WEB_PORT, 8001 by default) and origin.
//
// The uploaded bundle runs the official interface and whatever it loads. On the admin page's origin
// that code could call /admin/api with the administrator's cookie, so the web client gets an origin
// of its own: this listener serves the sign-in page, the bundle, /web/api and the part of the device
// API the bundle uses (WEB_DEVICE_PATHS), and nothing of the administration. Cookies do not depend
// on the port, so each listener also ignores the other's cookie: here devices sign in only with the
// web client cookie, and the main listener's device API takes bearer tokens only (index.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, cookie, HttpError, jsonBody, sendJson } from './security.mjs';
import { webManifest } from './web-client.mjs';

/** The device API the bundle calls (web/client and android/client in ProkBot Plus). */
export const WEB_DEVICE_PATHS = new RegExp('^/(?:api/[A-Za-z][A-Za-z0-9]*|events|connect/(?:status|attachment)|notifications(?:/events)?' +
  '|local/(?:profile|device|files(?:/content)?|usage|computers|connectors(?:/.+)?|notification-settings(?:/events)?' +
  '|audio/transcriptions|voice/(?:session|status))|vnc/.+)$');
// The computer view runs the bridge the Android shell injects (android/client/vnc-bridge.js).
const VNC_SCRIPT = /^\/vnc\/(desktop|fork)\/__grokbot-(vnc-bridge|vnc-preload)\.js$/;

/** The admin-page assets the sign-in page loads, followed through their static imports. */
export function loginAssets(publicDir) {
  const names = new Set(), pending = [];
  const add = name => { if (!names.has(name)) { names.add(name); pending.push(name); } };
  for (const [, name] of readFileSync(join(publicDir, 'web-login.html'), 'utf8').matchAll(/(?:href|src)="\/([\w.-]+\.(?:css|js|svg))"/g)) add(name);
  while (pending.length) {
    const name = pending.pop();
    if (name.endsWith('.js'))
      for (const [, next] of readFileSync(join(publicDir, name), 'utf8').matchAll(/\b(?:from|import)\s*'\.\/([\w.-]+\.js)'/g)) add(next);
  }
  return names;
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

/** On the main listener, old links to the web client lead to its own listener; nothing else of it is there. */
export function webMoved(request, response, path, url, webOrigin) {
  check(['GET', 'HEAD'].includes(request.method) && ['/web', '/web/', '/web/login'].includes(path), 404, '网页版使用单独的端口');
  redirect(response, `${webOrigin}${path}${url.search}`);
}

export function createWebRoutes({ webClient, auth, federation, tickets, limiter, revokeDevice, sendPage, publicDir }) {
  const assets = loginAssets(publicDir);

  async function respond(request, response, path, url, origin, mainOrigin) {
    const method = request.method, read = ['GET', 'HEAD'].includes(method);
    const fromPage = () => check(request.headers['x-grokbot-web'] === '1' &&
      (!request.headers.origin || request.headers.origin === origin), 403, '请从网页版登录页操作');
    if (read && path === '/') return redirect(response, '/web/');
    // The interface's link to the admin page uses the origin it runs on.
    if (read && path === '/admin') return redirect(response, `${mainOrigin}/admin`);
    if (method === 'GET' && path === '/web/login') return sendPage(response, 'web-login.html');
    if (method === 'GET' && assets.has(path.slice(1))) return sendPage(response, path.slice(1));
    if (method === 'GET' && path === '/web/api/session') {
      const signedIn = webClient.browserDevice(request), status = webClient.status();
      return sendJson(response, 200, { available: status.available, rendererVersion: status.rendererVersion,
        paired: Boolean(signedIn), deviceName: signedIn?.device.name ?? null, secure: origin.startsWith('https:') });
    }
    if (method === 'POST' && path === '/web/api/pair') {
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      fromPage();
      check(webClient.available, 404, '网页版未启用');
      limiter.check(`pair:${request.socket.remoteAddress}`, 6);
      limiter.check('pair:global', 60);
      const { pairingKey, deviceName } = await jsonBody(request);
      const previous = webClient.browserDevice(request);
      const result = await auth.pair({ pairingKey, deviceName }, { web: true });
      // Signing in again replaces this browser's earlier device instead of leaving it behind.
      if (previous) await revokeDevice(previous.device.id);
      response.setHeader('set-cookie', webClient.sessionCookie(result.token, origin));
      return sendJson(response, 201, { ok: true, deviceId: result.deviceId });
    }
    if (method === 'POST' && path === '/web/api/ticket') {
      // "Open in this browser" on the admin page: its one-time ticket instead of a pairing code.
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      fromPage();
      check(webClient.available, 404, '网页版未启用');
      limiter.check(`web-ticket:${request.socket.remoteAddress}`, 10);
      const deviceName = webClient.redeemTicket((await jsonBody(request)).ticket);
      // A browser that is already signed in keeps its device instead of gaining another.
      if (webClient.browserDevice(request)) return sendJson(response, 200, { ok: true });
      const result = await auth.addWebDevice(deviceName);
      response.setHeader('set-cookie', webClient.sessionCookie(result.token, origin));
      return sendJson(response, 201, { ok: true, deviceId: result.deviceId });
    }
    if (method === 'POST' && path === '/web/api/logout') {
      fromPage();
      const signedIn = webClient.browserDevice(request);
      if (signedIn) await revokeDevice(signedIn.device.id);
      response.setHeader('set-cookie', webClient.sessionCookie('', origin));
      return sendJson(response, 200, { ok: true });
    }
    if (method === 'GET' && path === '/web/manifest.webmanifest') {
      check(webClient.available, 404, '网页版未启用');
      response.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
      return response.end(JSON.stringify(webManifest()));
    }
    if (read && (path === '/web' || path === '/web/'))
      return redirect(response, `${webClient.browserDevice(request) ? '/web/renderer/index.html' : '/web/login'}${url.search}`);
    const file = /^\/web\/((?:renderer|client)\/.+)$/.exec(path);
    if (file && read) {
      let name = null;
      try { name = decodeURIComponent(file[1]); } catch {}
      check(name && webClient.has(name), 404, '文件不存在');
      const signedIn = webClient.browserDevice(request);
      if (!signedIn && name === 'renderer/index.html') return redirect(response, `/web/login${url.search}`);
      check(signedIn, 401, '请先登录网页版');
      void auth.touch(signedIn.device.id).catch(() => {});
      return webClient.serve(request, response, name);
    }
    if (method === 'GET' && path === '/local-client/icon.png') {
      // The desktop settings pages load the program icon from here.
      check(webClient.browserDevice(request) && webClient.has('client/icon.png'), 404, '页面不存在');
      return webClient.serve(request, response, 'client/icon.png');
    }
    const script = VNC_SCRIPT.exec(path);
    if (script && read) {
      const value = tickets.validate(cookie(request, `grokbot_vnc_${script[1]}`), script[1]);
      check(value && webClient.available && auth.device(value.deviceId)?.platform === 'web', 401, '桌面访问票据已失效，请重新打开电脑预览');
      const body = await webClient.vncScript(script[2], origin);
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cross-origin-resource-policy': 'same-origin' });
      return response.end(method === 'HEAD' ? undefined : body);
    }
    throw new HttpError(404, '页面不存在');
  }

  /** Answers a request to the web listener; false for the device API, which index.mjs shares with the apps. */
  return async function webRoute(request, response, path, url, origin, mainOrigin) {
    if (WEB_DEVICE_PATHS.test(path) && !VNC_SCRIPT.test(path)) return false;
    await respond(request, response, path, url, origin, mainOrigin);
    return true;
  };
}
