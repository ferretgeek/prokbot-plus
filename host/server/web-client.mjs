// The web client: a bundle built by web/patchers/patch.mjs from the administrator's own copy of
// the official Grok Bot Windows installer, uploaded from the admin page and served at /web/.
//
// - The bundle contains the official interface, so every one of its files goes only to a browser
//   that signed in with a pairing code. Nothing of it is public; the sign-in page is Host code.
// - The web client has a listener and origin of its own (web-routes.mjs), never the admin page's,
//   so code from the bundle cannot use the administrator's session.
// - A signed-in browser holds an HttpOnly, SameSite=Strict cookie with its device token. The web
//   listener's device API accepts that cookie only together with the `x-grokbot-web: 1` header,
//   which another site cannot send without a CORS preflight the Host never grants, and only from
//   the web client's origin. Bundle files are plain GETs and carry Cross-Origin-Resource-Policy.
// - The admin page signs its own browser in with a one-time ticket instead of a pairing code.
// - Upload replaces the whole bundle at once: it is checked against its own manifest, unpacked
//   beside the current one and swapped in by renaming.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback, inflateRawSync } from 'node:zlib';
import { JsonStore } from './storage.mjs';
import { validDeviceName } from './auth.mjs';
import { check, cookie, hash, secret } from './security.mjs';

const gzip = promisify(gzipCallback);
export const WEB_COOKIE = 'grokbot_web';
export const BUNDLE_SCHEMA = 'grokbot-web-bundle/v1';
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5000, MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const COOKIE_SECONDS = 400 * 24 * 60 * 60, TICKET_MS = 2 * 60_000, MAX_TICKETS = 32;
// The files the web client cannot start without; the rest is whatever the interface contains.
const REQUIRED = ['renderer/index.html', 'client/boot-data.js', 'client/compat.js', 'client/bridge.js', 'client/native.js',
  'client/web-shell.js', 'client/official-preload.js', 'client/vnc-bridge.js', 'client/vnc-preload.js', 'client/icon.png'];
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', wav: 'audio/wav',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['html', 'js', 'mjs', 'css', 'json', 'map', 'svg', 'txt', 'wasm']);
const extension = name => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? '';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) n = CRC_TABLE[(n ^ bytes[i]) & 255] ^ n >>> 8;
  return (n ^ 0xffffffff) >>> 0;
}

/** A bundle member path: renderer/... or client/..., plain relative segments only. */
export function bundlePath(name) {
  if (typeof name !== 'string' || name.length > 512 || !/^(renderer|client)\/[A-Za-z0-9._@+~/-]+$/.test(name)) return null;
  return name.split('/').every(part => part && part !== '.' && part !== '..') ? name : null;
}

/** Reads the bundle ZIP: stored or deflated entries, no encryption, no ZIP64, every CRC checked. */
export function readBundleZip(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= MAX_BUNDLE_BYTES, 400, '网页版界面包大小无效');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--)
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  check(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 400, '不是网页版界面包（ZIP 目录无效）');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  check(count > 1 && count <= MAX_FILES + 1 && count === bytes.readUInt16LE(end + 8) && start + size === end, 400, '网页版界面包目录无效');
  const files = new Map();
  let cursor = start, total = 0, previousEnd = 0;
  for (let index = 0; index < count; index++) {
    check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 400, '网页版界面包条目无效');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    check(!(flags & ~0x800) && [0, 8].includes(method) && expanded <= MAX_FILE_BYTES && (total += expanded) <= MAX_TOTAL_BYTES,
      400, '网页版界面包含不支持的条目');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    check(name === 'web-bundle.json' || bundlePath(name), 400, `网页版界面包路径无效：${name.slice(0, 120)}`);
    check(!files.has(name), 400, `网页版界面包路径重复：${name.slice(0, 120)}`);
    // Entries must follow each other without overlapping, before the central directory.
    check(offset >= previousEnd && offset + 30 <= start && bytes.readUInt32LE(offset) === 0x04034b50, 400, '网页版界面包条目位置无效');
    const data = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    check(data + compressed <= start && bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8') === name, 400, '网页版界面包条目无效');
    previousEnd = data + compressed;
    let content;
    try {
      content = method === 0 ? bytes.subarray(data, data + compressed)
        : inflateRawSync(bytes.subarray(data, data + compressed), { maxOutputLength: Math.max(1, expanded) });
    } catch { check(false, 400, `网页版界面包解压失败：${name.slice(0, 120)}`); }
    check(content.length === expanded && crc32(content) === crc, 400, `网页版界面包校验失败：${name.slice(0, 120)}`);
    files.set(name, Buffer.from(content));
    cursor += 46 + nameSize + extraSize + commentSize;
  }
  check(cursor === end, 400, '网页版界面包目录无效');
  return files;
}

/** Checks the manifest against the files: same set of paths, sizes and SHA-256. */
export function verifyBundle(entries) {
  const raw = entries.get('web-bundle.json');
  check(raw, 400, '缺少 web-bundle.json，请用 web/patchers/patch.mjs 生成网页版界面包');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { check(false, 400, 'web-bundle.json 格式错误'); }
  check(manifest?.schema === BUNDLE_SCHEMA, 400, '网页版界面包格式不受支持，请用同一版本的工具重新生成');
  check(/^\d+\.\d+\.\d+$/.test(manifest.rendererVersion ?? ''), 400, '网页版界面包的版本无效');
  check(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 400, 'web-bundle.json 缺少文件清单');
  const listed = Object.keys(manifest.files);
  check(listed.length === entries.size - 1, 400, '网页版界面包的文件与清单不一致');
  for (const name of listed) {
    const bytes = entries.get(name), item = manifest.files[name];
    check(bundlePath(name) && bytes && item?.bytes === bytes.length && item.sha256 === sha256(bytes), 400, `网页版界面包文件与清单不一致：${name.slice(0, 120)}`);
  }
  for (const name of REQUIRED) check(Object.hasOwn(manifest.files, name), 400, `网页版界面包缺少 ${name}`);
  return manifest;
}

export class WebClient {
  constructor(dataDir, { auth } = {}) {
    this.root = join(dataDir, 'web-client');
    this.auth = auth;
    this.store = new JsonStore(join(dataDir, 'web-client.json'), { version: 1, enabled: false, installedAt: null });
    this.index = null;
    this.manifest = null;
    this.installing = Promise.resolve();
    this.tickets = new Map();
  }
  async load() {
    await this.store.load();
    // An upload interrupted by a restart leaves its stage or the replaced bundle behind.
    const leftovers = await readdir(this.root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of leftovers.filter(name => /^(stage|previous)-[0-9a-f]{12}$/.test(name)))
      await rm(join(this.root, name), { recursive: true, force: true });
    await this.readCurrent();
    return this;
  }
  async readCurrent() {
    this.index = null; this.manifest = null;
    let manifest;
    try { manifest = JSON.parse(await readFile(join(this.root, 'current', 'web-bundle.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      console.error(`[web-client] installed bundle unreadable: ${error.code ?? error.name}`);
      return;
    }
    if (manifest?.schema !== BUNDLE_SCHEMA || !manifest.files) return;
    this.manifest = manifest;
    this.index = new Map(Object.entries(manifest.files).filter(([name]) => bundlePath(name)));
  }
  get installed() { return Boolean(this.index); }
  get available() { return this.installed && this.store.value.enabled === true; }
  status() {
    const manifest = this.manifest;
    return {
      installed: this.installed, enabled: this.store.value.enabled === true, available: this.available,
      installedAt: this.installed ? this.store.value.installedAt : null,
      rendererVersion: manifest?.rendererVersion ?? null, recommended: manifest?.recommended ?? null, builtAt: manifest?.builtAt ?? null,
      files: this.index?.size ?? 0, bytes: [...(this.index?.values() ?? [])].reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    };
  }
  install(bytes) {
    const work = this.installing.then(() => this.replace(bytes));
    this.installing = work.catch(() => {});
    return work;
  }
  async replace(bytes) {
    const entries = readBundleZip(bytes);
    const manifest = verifyBundle(entries);
    entries.delete('web-bundle.json');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const suffix = randomBytes(6).toString('hex');
    const stage = join(this.root, `stage-${suffix}`), previous = join(this.root, `previous-${suffix}`), current = join(this.root, 'current');
    try {
      for (const [name, content] of entries) {
        const target = join(stage, ...name.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        // Compressed once here, so each request only streams a file.
        if (COMPRESSIBLE.has(extension(name)) && content.length >= 1024) {
          const packed = await gzip(content, { level: 9 });
          if (packed.length < content.length) { await writeFile(`${target}.gz`, packed); manifest.files[name].gzip = true; }
        }
      }
      await writeFile(join(stage, 'web-bundle.json'), JSON.stringify(manifest));
      let replaced = false;
      try { await rename(current, previous); replaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await rename(stage, current); }
      catch (error) { if (replaced) await rename(previous, current).catch(() => {}); throw error; }
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(previous, { recursive: true, force: true });
    }
    // The first installation turns the web client on; a later one keeps the administrator's choice.
    await this.store.mutate(state => {
      if (!state.installedAt) state.enabled = true;
      state.installedAt = new Date().toISOString();
    });
    await this.readCurrent();
    return this.status();
  }
  async setEnabled(enabled) {
    check(typeof enabled === 'boolean', 400, '启用状态无效');
    check(!enabled || this.installed, 409, '请先上传网页版界面包');
    await this.store.mutate(state => { state.enabled = enabled; });
    return this.status();
  }
  async remove() {
    await this.installing;
    this.index = null; this.manifest = null;
    await rm(join(this.root, 'current'), { recursive: true, force: true });
    await this.store.mutate(state => { state.enabled = false; state.installedAt = null; });
    return this.status();
  }

  // ---- sign-in -------------------------------------------------------------------------------

  sessionCookie(token, origin) {
    return `${WEB_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? COOKIE_SECONDS : 0}${origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  /** The browser device signed in on this request, from its cookie; null when there is none. */
  browserDevice(request) {
    const token = cookie(request, WEB_COOKIE);
    if (!this.available || !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
    const device = this.auth.authenticate(token);
    return device?.platform === 'web' ? { device, token } : null;
  }
  /**
   * The device token for a device API request to the web listener, or null without the browser
   * cookie. A cookie without the header or from another origin is refused.
   */
  deviceToken(request, origin) {
    const token = cookie(request, WEB_COOKIE);
    if (!token) return null;
    check(this.available, 403, '网页版未启用');
    check(request.headers['x-grokbot-web'] === '1', 403, '请从网页版发起请求');
    check(!request.headers.origin || request.headers.origin === origin, 403, '请求来源不匹配');
    return token;
  }
  /** A ticket the admin page passes to the web client's sign-in page; it works once, for two minutes. */
  issueTicket(deviceName) {
    validDeviceName(deviceName);
    const now = Date.now();
    for (const [key, item] of this.tickets) if (item.expiresAt <= now) this.tickets.delete(key);
    check(this.tickets.size < MAX_TICKETS, 429, '请求过多，请稍后重试');
    const ticket = secret();
    this.tickets.set(hash(ticket), { deviceName, expiresAt: now + TICKET_MS });
    return ticket;
  }
  /** Consumes a ticket and returns the device name it was issued for. */
  redeemTicket(ticket) {
    const key = typeof ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? hash(ticket) : null;
    const item = key && this.tickets.get(key);
    if (item) this.tickets.delete(key);
    check(item && item.expiresAt > Date.now(), 401, '登录链接已失效，请在管理页重新打开网页版');
    return item.deviceName;
  }

  // ---- files ---------------------------------------------------------------------------------

  has(name) { return Boolean(this.index?.has(name)); }
  /** Streams one bundle file; the caller has checked the browser's sign-in. */
  async serve(request, response, name) {
    const item = this.index?.get(name);
    check(item, 404, '文件不存在');
    const etag = `"${item.sha256.slice(0, 40)}"`;
    // Hashed asset names never change content; everything else is revalidated.
    response.setHeader('cache-control', /^renderer\/assets\//.test(name) ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    response.setHeader('etag', etag);
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('vary', 'Accept-Encoding, Cookie');
    if (extension(name) === 'html') {
      // The interface may frame its own pages; nothing frames the interface itself.
      const ancestors = name === 'renderer/index.html' ? "'none'" : "'self'";
      response.setHeader('content-security-policy', `frame-ancestors ${ancestors}; object-src 'none'; base-uri 'self'`);
      response.setHeader('x-frame-options', name === 'renderer/index.html' ? 'DENY' : 'SAMEORIGIN');
    }
    if (request.headers['if-none-match'] === etag) { response.writeHead(304); return response.end(); }
    const packed = item.gzip && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
    const file = join(this.root, 'current', ...name.split('/')) + (packed ? '.gz' : '');
    const headers = { 'content-type': TYPES[extension(name)] ?? 'application/octet-stream', ...(packed ? { 'content-encoding': 'gzip' } : {}) };
    if (request.method === 'HEAD') { response.writeHead(200, headers); return response.end(); }
    await new Promise((resolve, reject) => {
      const stream = createReadStream(file);
      stream.once('open', () => { response.writeHead(200, headers); stream.pipe(response); });
      stream.once('error', reject);
      stream.once('end', resolve);
      response.once('close', () => { stream.destroy(); resolve(); });
    });
  }
  /** The scripts the Bot computer view loads beside the noVNC page (see android/client/vnc-bridge.js). */
  async vncScript(name, origin) {
    const file = name === 'vnc-bridge' ? 'client/vnc-bridge.js' : 'client/vnc-preload.js';
    check(this.has(file), 404, '文件不存在');
    const script = await readFile(join(this.root, 'current', ...file.split('/')));
    return name === 'vnc-bridge' ? Buffer.concat([Buffer.from(`window.__grokbotAppOrigin = ${JSON.stringify(origin)};\n`), script]) : script;
  }
  /** Adds the bridge scripts to the noVNC page right after <head>, in the page's own directory. */
  static injectVncBridge(html, directory) {
    const tags = `<script src="${directory}/__grokbot-vnc-bridge.js"></script><script src="${directory}/__grokbot-vnc-preload.js"></script>`;
    const opening = /<head(\s[^>]*)?>/i.exec(html);
    return opening ? html.slice(0, opening.index + opening[0].length) + tags + html.slice(opening.index + opening[0].length) : tags + html;
  }
}

/** Reads a raw request body up to `limit` bytes. */
export async function rawBody(request, limit = MAX_BUNDLE_BYTES) {
  const length = Number(request.headers['content-length'] ?? NaN);
  check(!Number.isFinite(length) || length <= limit, 413, '网页版界面包过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= limit, 413, '网页版界面包过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** The installable-app description for phones; it names the Host, never the interface's files. */
export function webManifest() {
  return {
    name: 'Grok Bot', short_name: 'Grok Bot', start_url: '/web/', scope: '/web/', display: 'standalone',
    background_color: '#111111', theme_color: '#111111',
    icons: [{ src: '/web/client/icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' }],
  };
}
