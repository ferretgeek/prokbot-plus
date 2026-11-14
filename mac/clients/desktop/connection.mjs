import { grokText } from './i18n.mjs';
import { normalizePairingCode } from './pairing-code.mjs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TailcatProcess, tailcatLink } from '../shared/tailcat-process.mjs';

export function credentialUnavailableText() {
  return process.platform === 'darwin'
    ? grokText('请解锁 macOS 钥匙串。', 'Unlock your macOS keychain.')
    : grokText('系统凭据加密不可用，请确认已登录 Windows 账户。', 'System credential encryption is unavailable. Sign in to your Windows account.');
}

export async function openTransport(address, enabled, { identity, binary } = {}) {
  if (!enabled) return { server: normalizeServer(address), address: normalizeServer(address), tailcat: false, close: async () => {} };
  address = tailcatLink(address);
  let networkIdentity = identity;
  const tunnel = new TailcatProcess({ mode: 'forward', link: address, identity }, { binary, onIdentity: value => { networkIdentity = value; } });
  try {
    const status = await tunnel.start();
    return { server: status.localURL, address, tailcat: true, networkIdentity, tunnel, close: () => tunnel.close() };
  } catch (error) { await tunnel.close(); throw error; }
}

export async function restoreConnection(store, binary, open = openTransport) {
  let config = null;
  try {
    config = await store.load();
    if (!config) return { config: null, transport: null, connectionError: '' };
    const transport = await open(config.address ?? config.server, config.tailcat, { identity: config.networkIdentity, binary });
    return { config: { ...config, ...transport }, transport, connectionError: '' };
  } catch {
    return { config, transport: null, connectionError: config
      ? grokText('无法打开已保存的连接，请重新连接。', 'Could not open the saved connection. Reconnect to try again.')
      : grokText('无法读取设备凭证，请重新配对。', 'Could not read device credentials. Pair again.') };
  }
}

export function finishPairingWindow(opening, current, connectionError) {
  // A revocation during workspace startup may reopen the same window to show the error.
  if (opening && current === opening && !connectionError) opening.close();
}

export function normalizeServer(input) {
  const url = new URL(String(input).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    throw new Error(grokText('请输入 Host 的 http:// 或 https:// 地址。', 'Enter the Host http:// or https:// address.'));
  return url.origin;
}

export function savedConnectionMatches(config, address, tunneled) {
  if (!config || (config.tailcat === true) !== tunneled) return false;
  try {
    if (tunneled) return tailcatLink(address) === tailcatLink(config.address);
    return normalizeServer(address) === normalizeServer(config.address ?? config.server);
  } catch { return false; }
}

function validDevice(record) {
  return typeof record?.deviceId === 'string' && Boolean(record.deviceId.trim()) &&
    typeof record.token === 'string' && record.token.length >= 16 && !/[^!-~]/.test(record.token);
}

export async function pair(server, pairingKey, fetcher = fetch, { tunneled = false } = {}) {
  server = normalizeServer(server);
  pairingKey = normalizePairingCode(pairingKey);
  if (!/^[A-Z0-9]{6}$/.test(pairingKey)) throw new Error(grokText('请输入 6 位配对码。', 'Enter a six-character pairing code.'));
  const response = await fetcher(`${server}/connect/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingKey, deviceName: os.hostname(), platform: 'desktop' }),
    signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? grokText('配对码 无效或已过期。', 'Pairing code is invalid or expired.') : grokText(`连接失败（HTTP ${response.status}）。`, `Connection failed (HTTP ${response.status}).`));
  if (!validDevice(result))
    throw new Error(grokText('Host 返回的设备凭证无效。', 'Host returned invalid device credentials.'));
  if (!tunneled && normalizeServer(result.gatewayUrl) !== server)
    throw new Error(grokText('Host 返回了不同的服务地址。', 'Host returned a different server address.'));
  return { server, deviceId: result.deviceId, token: result.token };
}

export async function verifyDevice(server, { token, deviceId }, fetcher = fetch) {
  const response = await fetcher(`${normalizeServer(server)}/connect/status`, { headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(35000), redirect: 'error' });
  if (response.ok) {
    const status = await response.json().catch(() => null);
    if (typeof deviceId === 'string' && status?.deviceId === deviceId) return;
  } else await response.body?.cancel();
  throw new Error(grokText('无法验证此 Host 的设备凭据。', 'Could not verify this device with the Host.'));
}

export function credentialStore(profile, safeStorage) {
  const filename = path.join(profile, 'connection.json');
  let writes = Promise.resolve();
  const update = task => { writes = writes.catch(() => {}).then(task); return writes; };
  function available() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(credentialUnavailableText());
  }
  return {
    async load() {
      await writes.catch(() => {});
      let record;
      try { record = JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      available();
      const device = { deviceId: record.deviceId, token: safeStorage.decryptString(Buffer.from(record.encryptedToken, 'base64')) };
      if (!validDevice(device)) throw new Error(grokText('保存的设备凭证无效。', 'Saved device credentials are invalid.'));
      const network = record.encryptedNetwork ? JSON.parse(safeStorage.decryptString(Buffer.from(record.encryptedNetwork, 'base64'))) : null;
      return { ...device, server: network?.tailcat ? '' : normalizeServer(record.server),
        address: network?.tailcat ? tailcatLink(network.address) : normalizeServer(record.server),
        tailcat: network?.tailcat === true, networkIdentity: network?.identity };
    },
    save: config => update(async () => {
      available();
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const record = { version: 1, server: config.tailcat ? '' : normalizeServer(config.address ?? config.server), deviceId: config.deviceId,
        encryptedToken: safeStorage.encryptString(config.token).toString('base64') };
      if (config.tailcat) record.encryptedNetwork = safeStorage.encryptString(JSON.stringify({ tailcat: true,
        address: tailcatLink(config.address), identity: config.networkIdentity })).toString('base64');
      try {
        await writeFile(`${filename}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await rename(`${filename}.tmp`, filename);
      } catch (error) { await rm(`${filename}.tmp`, { force: true }).catch(() => {}); throw error; }
    }),
    clear: () => update(() => rm(filename, { force: true })),
  };
}
