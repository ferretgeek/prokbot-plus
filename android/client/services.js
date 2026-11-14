// Main-process services of the desktop client (mac/clients/desktop/local-services.mjs
// and its helpers), ported to the Android WebView. Host calls use the gateway;
// device functions use the Android shell.
import { grokText } from './desktop/i18n.mjs';
import { externalHttpUrl } from './desktop/external-url.mjs';
import { createConnectorHandlers } from './desktop/connectors.mjs';
import { boot as androidBoot, native, log, toBase64, fromBase64, toBytes, timeout, combineSignals } from './native.js';

export const auth = {
  kind: 'logged-in', authId: 'grokbot-local-workspace', email: '', displayName: '本地工作区',
  profileReady: true, isAnysphereUser: false, freshness: 0,
};
const access = {
  state: 'granted', reason: 'none', privacyDisclaimerRequired: false, purchasableTiers: [],
  proAndSuperGrokPlansGrantAccess: false, isUnified: false,
};

export function resolveLanguage(locale) {
  if (/^zh-(TW|HK|MO|Hant)/i.test(locale)) return 'zh-TW';
  if (/^zh/i.test(locale)) return 'zh-CN';
  return String(locale).split('-')[0] || 'en';
}

export function themeState(settings, systemDark) {
  const resolved = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  return { preference: settings.theme, resolved, systemAccentColor: null };
}

export function languageState(settings, systemLocale) {
  return { preference: settings.language, systemLanguage: systemLocale,
    resolved: settings.language === 'system' ? resolveLanguage(systemLocale) : settings.language };
}

/** The Host stores Linux paths; file URLs from it are remote paths, never local files. */
export function remoteAttachmentPath(source) {
  if (typeof source !== 'string' || !source || source.includes('\0')) return null;
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.host && url.host !== 'localhost') return null;
      return decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  return /^[a-z][a-z\d+.-]*:/i.test(source) ? null : source;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_HEAD_BYTES = 64 * 1024;
const PREVIEW_BYTES = 25 * 1024 * 1024;
const TEXT_HEAD_BYTES = 6 * 1024 * 1024;
const FILE_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 200 * 1024 * 1024;
const STAGING_PREFIX = '/grokbot-android-staging/';
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[/\\\0]/.test(name);
const byteLimit = name => /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ogv)$/i.test(name) ? VIDEO_LIMIT : FILE_LIMIT;
const sizeFailure = (size, name) => size === 0 ? 'empty' : size > byteLimit(name) ? 'too-large' : null;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  zip: 'application/zip', html: 'text/html', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export const mimeFor = name => MIME[String(name).split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';
const baseName = value => String(value ?? '').split('/').filter(Boolean).pop() || 'download';

function dataUrl(bytes, type) {
  return `data:${type};base64,${toBase64(bytes)}`;
}

async function decodeImage(url) {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  return image;
}

/** Attachments staged on the phone before sending; the original renderer keeps their previews. */
export function createStaging() {
  const files = new Map();
  const localPath = source => {
    const path = remoteAttachmentPath(source);
    return files.has(path) ? path : null;
  };
  return {
    localPath,
    read: source => { const path = localPath(source); return path ? files.get(path) : null; },
    put(filename, bytes) {
      const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(filename)?.[0] ?? '';
      const path = `${STAGING_PREFIX}${crypto.randomUUID()}${extension}`;
      files.set(path, { bytes, filename, type: mimeFor(filename) });
      return path;
    },
    remove: source => files.delete(localPath(source)),
  };
}

export function createAttachments({ command, staging, onProgress }) {
  const request = (method, args) => command(method, args, timeout(30000));
  const scope = ({ path: source, agentId }) => {
    const value = remoteAttachmentPath(source);
    return value === null ? null : { path: value, ...(agentId ? { agentId } : {}) };
  };
  const totalSize = chunk => {
    if (!Number.isSafeInteger(chunk?.totalSize) || chunk.totalSize < 0) throw new Error(grokText('附件大小无效。', 'Invalid attachment size.'));
    return chunk.totalSize;
  };
  function chunkBytes(chunk, length, expectedSize) {
    if (totalSize(chunk) !== expectedSize || typeof chunk.bytesBase64 !== 'string')
      throw new Error(grokText('附件已改变，请重试。', 'The attachment changed. Try again.'));
    const bytes = fromBase64(chunk.bytesBase64);
    if ((!bytes.length && expectedSize !== 0) || bytes.length > length) throw new Error(grokText('附件读取不完整，请重试。', 'Incomplete attachment. Try again.'));
    return bytes;
  }
  async function readChunk(args, offset, length, expectedSize) {
    const chunk = await request('readAttachmentChunk', { ...args, offset, length });
    return chunk === null ? null : chunkBytes(chunk, length, expectedSize);
  }
  const commits = new Map();
  async function upload({ agentId, path: source, filename }, progress, cancel) {
    const staged = staging.read(source);
    if (!staged) throw new Error('Invalid staged attachment');
    const size = staged.bytes.length;
    if (sizeFailure(size, filename)) throw new Error(grokText('附件为空或超过大小限制。', 'The attachment is empty or too large.'));
    const uploadId = crypto.randomUUID();
    for (let offset = 0; offset < size;) {
      if (cancel.aborted) throw cancel.reason;
      const piece = staged.bytes.subarray(offset, Math.min(size, offset + CHUNK_BYTES));
      const { signal, dispose } = combineSignals([cancel, timeout(120000)]);
      let result;
      try {
        result = await command('uploadAttachmentChunk', { agentId, uploadId, filename, offset, totalSize: size,
          bytesBase64: toBase64(piece) }, signal);
        if (signal.aborted) throw signal.reason;
      } finally { dispose(); }
      offset += piece.length;
      if (result?.committedPath) {
        if (offset !== size || typeof result.committedPath !== 'string') throw new Error('Incomplete attachment upload');
        return result.committedPath;
      }
      if (offset < size) progress(offset / size);
    }
    throw new Error(grokText('附件上传未完成，请重试。', 'The attachment upload did not complete. Try again.'));
  }
  return {
    async resolveAttachmentMedia({ source, rendition }) {
      const staged = staging.read(source);
      const remote = remoteAttachmentPath(source);
      if (!staged && (remote === null || remote.startsWith(STAGING_PREFIX))) throw new Error('Invalid attachment path');
      const result = staged ? { dataUrl: dataUrl(staged.bytes, staged.type) }
        : await command('readAttachmentImage', { path: remote, rendition: rendition === 'original' ? 'original' : 'preview' }, timeout(30000));
      if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(result?.dataUrl)) throw new Error('Unsupported attachment');
      const image = await decodeImage(result.dataUrl);
      const width = image.naturalWidth, height = image.naturalHeight;
      const tile = Number(/^tile-(\d+)$/.exec(rendition ?? '')?.[1]);
      let src = result.dataUrl;
      if (tile && width > tile) {
        const canvas = document.createElement('canvas');
        canvas.width = tile;
        canvas.height = Math.max(1, Math.round(height * tile / width));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        src = canvas.toDataURL('image/png');
      }
      return { kind: 'image', src, width, height };
    },
    async readAttachmentText(input) {
      const args = scope(input);
      if (args) {
        const staged = staging.read(args.path);
        if (staged) return { kind: 'text', text: new TextDecoder().decode(staged.bytes.subarray(0, TEXT_HEAD_BYTES)),
          bytes: staged.bytes.length, truncated: staged.bytes.length > TEXT_HEAD_BYTES };
        if (args.path.startsWith(STAGING_PREFIX)) return null;
      }
      return args === null ? null : request('readAttachmentText', args);
    },
    async readAttachmentBytes(input) {
      const args = scope(input);
      if (args === null) return null;
      const maxBytes = Number.isFinite(input.maxBytes) && input.maxBytes > 0 ? Math.min(Math.floor(input.maxBytes), PREVIEW_BYTES) : PREVIEW_BYTES;
      const staged = staging.read(args.path);
      if (staged) {
        if (staged.bytes.length > maxBytes) return { kind: 'too-large', size: staged.bytes.length };
        const text = /\.(?:md|markdown|txt|text)$/i.test(args.path);
        return { kind: 'bytes', bytes: staged.bytes.slice(0, text ? TEXT_HEAD_BYTES : maxBytes), size: staged.bytes.length };
      }
      if (args.path.startsWith(STAGING_PREFIX)) return null;
      const info = await request('readAttachmentChunk', { ...args, offset: 0, length: 0 });
      if (info === null) return null;
      const size = totalSize(info);
      const name = info.resolvedName ? { resolvedName: info.resolvedName } : {};
      if (size > maxBytes) return { kind: 'too-large', size, ...name };
      const text = /\.(?:md|markdown|txt|text)$/i.test(info.resolvedName ?? args.path);
      const bytes = new Uint8Array(Math.min(size, text ? TEXT_HEAD_BYTES : maxBytes));
      for (let offset = 0; offset < bytes.length;) {
        const chunk = await readChunk(args, offset, Math.min(CHUNK_BYTES, bytes.length - offset), size);
        if (chunk === null) return null;
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return { kind: 'bytes', bytes, size, ...name };
    },
    async downloadAttachment(input) {
      let id = null;
      try {
        const args = scope(input);
        if (args === null) throw new Error('Invalid attachment path');
        const staged = staging.read(args.path);
        if (!staged && args.path.startsWith(STAGING_PREFIX)) throw new Error('Attachment not found');
        // Prove the file is readable before Android creates a destination. Keep the probe small on cancellation.
        const info = staged ? { totalSize: staged.bytes.length, resolvedName: staged.filename }
          : await request('readAttachmentChunk', { ...args, offset: 0, length: DOWNLOAD_HEAD_BYTES });
        if (info === null) throw new Error('Attachment not found');
        const size = totalSize(info);
        const first = staged ? staged.bytes.subarray(0, CHUNK_BYTES) : chunkBytes(info, Math.min(size, DOWNLOAD_HEAD_BYTES), size);
        const name = baseName(input.suggestedName || info.resolvedName || args.path);
        const started = await native('save-begin', { name, mime: mimeFor(name) });
        if (!started.id) return false;
        id = started.id;
        for (let offset = 0; offset < size;) {
          const length = Math.min(CHUNK_BYTES, size - offset);
          const bytes = offset === 0 ? first : staged ? staged.bytes.subarray(offset, offset + length) : await readChunk(args, offset, length, size);
          if (bytes === null) throw new Error('Attachment not found');
          await native(`save-chunk?id=${encodeURIComponent(id)}`, null, { binary: bytes });
          offset += bytes.length;
        }
        await native('save-end', { id, ok: true });
        id = null;
        return true;
      } catch (error) {
        if (id) await native('save-end', { id, ok: false }).catch(() => {});
        log('[attachment-download]', error);
        alert(grokText('无法下载文件，请重试。', 'Could not download this file. Try again.'));
        return false;
      }
    },
    async stageAttachmentBytes({ filename, bytes }) {
      let data;
      try { data = toBytes(bytes); } catch { return { ok: false, reason: 'failed' }; }
      if (!validName(filename)) return { ok: false, reason: 'failed' };
      const reason = sizeFailure(data.byteLength, filename);
      return reason ? { ok: false, reason } : { ok: true, path: staging.put(filename, data.slice()) };
    },
    // There are no client file paths on Android; the preload falls back to bytes.
    stageAttachmentPath: async () => ({ ok: false, reason: 'failed' }),
    async commitStagedAttachments({ agentId, paths, filenames, progressKey }) {
      if (typeof agentId !== 'string' || !agentId || !Array.isArray(paths) || !Array.isArray(filenames) ||
          paths.length !== filenames.length || paths.some(source => !staging.localPath(source)) || filenames.some(name => !validName(name)))
        throw new Error('Invalid attachment upload');
      const report = fraction => { if (progressKey) onProgress({ key: progressKey, fraction }); };
      const results = [];
      report(0);
      for (let index = 0; index < paths.length; index++) {
        const source = staging.localPath(paths[index]), filename = filenames[index];
        const key = JSON.stringify([agentId, source, filename]);
        let pending = commits.get(key);
        if (!pending) {
          const controller = new AbortController();
          const result = upload({ agentId, path: source, filename }, fraction => report((index + fraction) / paths.length),
            controller.signal);
          pending = { path: source, controller, result };
          commits.set(key, pending);
          result.catch(() => { if (commits.get(key) === pending) commits.delete(key); });
        }
        results.push(await pending.result);
        report((index + 1) / paths.length);
      }
      return results;
    },
    async discardStagedAttachment({ path: source }) {
      const path = staging.localPath(source);
      if (!path) return;
      staging.remove(path);
      for (const [key, pending] of commits) if (pending.path === path) {
        pending.controller.abort();
        commits.delete(key);
      }
    },
    preuploadStagedAttachment: async () => {},
    releaseStagedAttachmentPreupload: async () => {},
    precaptionStagedAttachment: async () => {},
  };
}

/** The shared Host profile is the single local account; it is not a cloud identity. */
export function createProfile({ request, server, emit, onChange }) {
  let avatar = null, last = '', pending = null, current = null;
  auth.email = '';
  const apply = value => {
    current = { displayName: value.displayName, avatarDataUrl: value.avatarDataUrl ?? null, hostName: value.hostName || 'Grok Bot Host' };
    const next = JSON.stringify([current, value.updatedAt]);
    if (next === last) return { ...auth };
    last = next; avatar = value.avatarDataUrl ?? null;
    Object.assign(auth, { displayName: value.displayName, profilePictureUrl: avatar, freshness: Date.now() });
    emit('cursor-auth-changed', { ...auth });
    onChange?.();
    return { ...auth };
  };
  const refresh = () => pending ??= request('/local/profile', null, timeout(10000), 'GET').then(apply).finally(() => { pending = null; });
  const refreshIdentity = async () => {
    try { await refresh(); } catch (error) { if (error.httpStatus === 401) throw error; }
  };
  let updates = Promise.resolve();
  const update = value => {
    updates = updates.catch(() => {}).then(async () => {
      const latest = await request('/local/profile', null, timeout(10000), 'GET');
      return apply(await request('/local/profile', { displayName: latest.displayName, avatarDataUrl: latest.avatarDataUrl ?? null, ...value },
        timeout(15000), 'PUT'));
    });
    return updates;
  };
  return {
    refresh,
    current: () => current && { ...current },
    handlers: {
      getCursorAuthStatus: async () => { await refreshIdentity(); return { ...auth }; },
      getCursorAvatar: async () => { await refreshIdentity(); return avatar; },
      updateCursorAccountName: ({ name }) => update({ displayName: name }),
      updateCursorProfilePhoto: ({ photo }) => update({ avatarDataUrl: `data:${photo.contentType};base64,${toBase64(photo.bytes)}` }),
      getLocalAccountServer: () => server,
    },
  };
}

/** The original call entry follows the Host's speech services and the local preference. */
export function createVoiceAvailability({ request, experiments, emit, getPreference }) {
  let pending = null;
  experiments.featureGates.sand_voice_call = false;
  const refresh = () => pending ??= (async () => {
    let enabled = false;
    try {
      const value = await request('/local/voice/status', null, timeout(5000), 'GET');
      enabled = value?.enabled === true && getPreference() === true;
    } catch {}
    if (enabled !== experiments.featureGates.sand_voice_call) {
      experiments.featureGates.sand_voice_call = enabled;
      emit('experiments-changed', experiments);
    }
    return experiments;
  })().finally(() => { pending = null; });
  return { refresh };
}

/** Only a short-lived call ticket reaches the renderer; the socket goes through the shell. */
export async function mintVoiceCredential({ request }, agentId) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(agentId)) throw new Error(grokText('请选择 Bot。', 'Choose a Bot.'));
  const value = await request('/local/voice/session', { agentId, audioProcessing: 'native-aec-v1' }, timeout(15000));
  const expires = value?.expiresAtUnixSeconds;
  if (typeof value?.clientSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.clientSecret) ||
      typeof value.websocketUrl !== 'string' || new URL(value.websocketUrl).pathname !== '/local/voice/realtime' ||
      typeof value.model !== 'string' || !value.model || value.model.length > 128 || !Number.isInteger(expires) ||
      expires <= Date.now() / 1000 || expires > Date.now() / 1000 + 90)
    throw new Error(grokText('语音连接信息无效。', 'Invalid voice connection.'));
  const local = new URL('/local/voice/realtime', location.origin);
  local.protocol = 'ws:';
  return { clientSecret: value.clientSecret, websocketUrl: local.href, expiresAtUnixSeconds: expires, model: value.model };
}

/** Client persistence is kept by the shell, so it survives WebView data resets. */
export function createPersistence(initial) {
  const store = { ...(initial ?? {}) };
  let writes = Promise.resolve();
  const commit = ops => {
    writes = writes.catch(() => {}).then(async () => {
      await native('persistence', { ops });
      for (const { op, key, value } of ops) {
        if (op === 'remove') delete store[key]; else store[key] = value;
      }
    });
    return writes;
  };
  const longest = (key, prefixes) => prefixes.reduce((length, prefix) => key.startsWith(prefix) ? Math.max(length, prefix.length) : length, -1);
  return {
    readClientPersistence: ({ key }) => store[key] ?? null,
    readManyClientPersistence: ({ include, exclude = [] }) => Object.fromEntries(Object.entries(store).filter(([key]) => {
      const included = longest(key, include);
      return included >= 0 && included >= longest(key, exclude);
    })),
    writeClientPersistence: ({ key, value }) => commit([{ op: 'set', key, value }]),
    removeClientPersistence: ({ key }) => commit([{ op: 'remove', key }]),
    listClientPersistenceKeys: ({ prefix }) => Object.keys(store).filter(key => key.startsWith(prefix)),
    hasMigratedClientPersistence: () => true,
    migrateClientPersistence: ({ entries }) => commit(entries.map(entry => ({ op: 'set', key: entry.key, value: entry.value }))),
  };
}

function pickImageFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      input.remove();
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error(grokText('图片不能超过 20 MB。', 'Image must be smaller than 20 MB.'));
        const url = dataUrl(new Uint8Array(await file.arrayBuffer()), file.type || mimeFor(file.name));
        await decodeImage(url).catch(() => { throw new Error(grokText('无法读取图片。', 'Could not read this image.')); });
        resolve({ dataUrl: url, fileName: file.name });
      } catch (error) { reject(error); }
    }, { once: true });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function createServices(context) {
  const { gateway, server, emit, settings, systemLocale, theme, language, boot, experiments,
    profile, voice, persistence, attachments, onSettingsChanged } = context;
  const { command, request } = gateway;
  const notificationKey = 'grokbot-android:notification-preferences';
  const notificationPreferences = () => ({ sound: 'ping-1-open-blip', playSound: true,
    ...(persistence.readClientPersistence({ key: notificationKey }) ?? {}) });
  const saveSetting = async (key, value) => {
    const result = await native('settings', { key, value });
    if (result.settings) Object.assign(settings, result.settings);
    onSettingsChanged?.(key);
    return settings[key];
  };
  const updateTheme = systemDark => {
    Object.assign(theme, themeState(settings, systemDark ?? context.systemDark()));
    context.applyChrome();
    emit('theme-changed', { ...theme });
    return { ...theme };
  };
  const updateLanguage = () => {
    Object.assign(language, languageState(settings, systemLocale));
    emit('language-changed', { ...language });
    return { ...language };
  };
  const timeZone = () => ({ detectedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, overrideTimeZone: settings.timeZone ?? null });
  const hardware = () => ({ enabled: true, enabledAtLaunch: true, pdfRasterMode: 'gpu' });
  const unavailable = () => { throw new Error(grokText('Android 客户端不支持在手机上执行命令。', 'The Android client cannot run commands on this phone.')); };
  const known = {
    ...attachments,
    ...persistence,
    ...profile.handlers,
    ...createConnectorHandlers({ command, openExternal: url => native('open-external', { url }) }),
    getLinkMetadata: () => null,
    transcribeAudio: ({ audio, mimeType, language: spoken }) => request('/local/audio/transcriptions', {
      audioBase64: toBase64(audio), mimeType, ...(spoken ? { language: spoken } : {}),
    }, timeout(120000)),
    openSelfHostedConnection: () => context.showConnection(),
    loginCursor: () => context.showConnection(),
    addCursorAccount: () => context.showConnection(),
    logoutCursor: () => context.disconnect(),
    pickAvatarFile: () => pickImageFile(),
    listGrokBotAgentFiles: ({ agentId }) => request(`/local/files?agentId=${encodeURIComponent(agentId)}`, null, timeout(15000), 'GET'),
    uploadGrokBotAgentFile: ({ agentId, fileName, contentType, bytes }) => request('/local/files',
      { agentId, fileName, contentType, base64: toBase64(bytes) }, timeout(60000)),
    deleteGrokBotAgentFile: async ({ agentId, name }) => { await request('/local/files', { agentId, name }, timeout(15000), 'DELETE'); },
    getAutoReviewInstructions: async () => (await command('getHostSettings')).autoReviewInstructions ?? { isEnabled: false, allowInstructions: [], blockInstructions: [] },
    setAutoReviewInstructions: async ({ instructions }) => {
      await command('setHostSettings', { autoReviewInstructions: instructions });
      return (await command('getHostSettings')).autoReviewInstructions;
    },
    getDesktopNotificationPreferences: notificationPreferences,
    getNotificationPreferences: notificationPreferences,
    setDesktopNotificationPreferences: async ({ preferences }) => {
      const choices = ['ping-1-open-blip', 'ping-2-tick', 'ping-3-double-tick', 'ping-4-chime-a', 'ping-5-chime-b'];
      if (typeof preferences?.playSound !== 'boolean' || !choices.includes(preferences.sound)) throw new Error('Invalid notification preferences');
      const value = { sound: preferences.sound, playSound: preferences.playSound };
      await persistence.writeClientPersistence({ key: notificationKey, value });
      return { ...value };
    },
    setViewingAgent: ({ agentId }) => native('viewing-agent', { agentId: typeof agentId === 'string' ? agentId : '' }).then(() => null),
    setComposingAgent: () => null,
    clearLocalToolApprovals: () => null,
    peekUsageWarningAssignment: () => null,
    getCursorWeeklyUsage: () => null,
    reportClientFailure: () => null,
    signalBoxIntent: () => null,
    setComputerViewOpen: () => null,
    getOnboardingSeen: () => true,
    setOnboardingSeen: () => null,
    markDeepLinksReady: () => context.deepLinksReady(),
    getCursorPrReviewPreferences: () => ({}),
    getCursorUsageSummary: () => null,
    getBoxMigrationStatus: () => null,
    getBoxHostPhase: () => 'settled',
    getTeamMemberPolicy: () => null,
    getServerPinnedAgents: () => null,
    getHostPinnedAgents: async () => (await command('getHostSettings')).pinnedAgentIds ?? null,
    setHostPinnedAgents: async ({ pinnedAgentIds }) => (await command('setHostSettings', { pinnedAgentIds })).pinnedAgentIds ?? null,
    getHostSidebarSections: async () => (await command('getHostSettings')).sidebarSections ?? null,
    setHostSidebarSections: async ({ sections }) => (await command('setHostSettings', { sidebarSections: sections })).sidebarSections ?? null,
    getCursorLoginFlight: () => ({ kind: 'idle' }),
    listCursorAccounts: () => ({ accounts: [auth], activeAccountId: auth.authId, corrupt: false }),
    getCursorSelectedTeam: () => ({ selectedTeamId: null, fallback: null }),
    listCursorTeamMemberships: () => [],
    getSandAccess: () => access,
    getSandAccessFresh: () => access,
    getGrokBotTermsRecord: () => ({ seenAtMs: Date.now(), version: 1 }),
    getWindowState: () => ({ isMaximized: true, isFullScreen: false, isFullscreen: false, isFocused: document.hasFocus() }),
    minimizeWindow: () => null,
    focusWindow: () => null,
    closeWindow: () => null,
    toggleMaximizeWindow: () => null,
    getEgressTunnelEnabled: () => false,
    getWebauthnProxyEnabled: () => false,
    getEgressTunnelStatus: () => boot.egressTunnelStatus,
    // The desktop claims its egress tunnel when a Bot computer view opens; there is none here.
    claimEgressTunnel: () => undefined,
    // The desktop's on-disk transcript cache answers null while it is not in use; there is none here.
    readTranscriptStoreTail: () => null,
    getUpdateStatus: () => ({
      state: { type: 'disabled', reason: 'disabled-by-env' }, currentVersion: androidBoot.appVersion ?? '',
      currentTrack: 'stable', availableTracks: ['stable'], isTrackManagedByPolicy: true,
      delivery: 'package-manager', isBelowMinimumVersion: false, autoUpdateWhenIdle: false,
    }),
    getCredentialsState: () => ({ connections: [], credentials: [], catalogRevision: 'local' }),
    getCursorPrivacyModeEnabled: () => false,
    getCursorUnifyCta: () => null,
    getCurrentMachineMessagesEnabled: () => false,
    listSecrets: () => [],
    listMeetings: () => [],
    listMessagesAllowedRecipients: () => [],
    listComputerUseAllowedApps: () => [],
    attachProdBoxStatus: () => ({ enabled: false }),
    getSandMachines: () => ({ machines: [], currentMachineRemoved: false }),
    getLocalToolPermission: () => 'never',
    setLocalToolPermission: unavailable,
    recordLocalToolApproval: unavailable,
    getLocalExecutionStatus: () => ({ connected: false, machineId: null, root: null, permission: 'never' }),
    listCookieOriginGrants: () => [],
    putCookieOriginGrants: () => [],
    getFinanceOverview: () => ({ connections: [] }),
    forceReconnectGateway: async () => { await command('listAgents'); return { connected: true }; },
    openExternal: async ({ url }) => {
      if (url?.startsWith('grokbot-local:')) return null;
      const target = externalHttpUrl(url);
      if (!target) throw new Error(grokText('链接地址无效。', 'Invalid link address.'));
      await native('open-external', { url: target });
      return null;
    },
    getHostSettings: () => command('getHostSettings'),
    setHostSettings: args => command('setHostSettings', args),
    // Settings (mac/clients/desktop/settings.mjs)
    getRealtimeVoiceEnabled: () => settings.realtimeVoice === true,
    setRealtimeVoiceEnabled: async ({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid voice preference');
      await saveSetting('realtimeVoice', enabled);
      context.voicePreferenceChanged(enabled);
      await voice.refresh();
      return enabled;
    },
    getThemeState: () => ({ ...theme }),
    setThemePreference: async ({ preference }) => {
      if (!['dark', 'light', 'system'].includes(preference)) throw new Error('Invalid theme');
      await saveSetting('theme', preference);
      return updateTheme();
    },
    getLanguageState: () => ({ ...language }),
    setLanguagePreference: async ({ preference }) => { await saveSetting('language', preference); return updateLanguage(); },
    getSpellCheckEnabled: () => settings.spellCheck !== false,
    setSpellCheckEnabled: async ({ enabled }) => saveSetting('spellCheck', Boolean(enabled)),
    getBotColorInChatEnabled: () => settings.botColor === true,
    setBotColorInChatEnabled: async ({ enabled }) => {
      const value = await saveSetting('botColor', Boolean(enabled));
      boot.isBotColorInChatEnabled = value;
      return value;
    },
    getHardwareAcceleration: hardware,
    setHardwareAccelerationEnabled: async () => hardware(),
    relaunchDesktop: () => native('reload'),
    getTimeZone: timeZone,
    setTimeZoneOverride: async ({ timeZone: value }) => {
      if (value !== null) new Intl.DateTimeFormat('en', { timeZone: value }).format();
      await command('setHostSettings', { userTimeZone: timeZone().detectedTimeZone, userTimeZoneOverride: value ?? '' });
      await saveSetting('timeZone', value);
      return timeZone();
    },
    getMessagesAppIcon: () => null,
    updateCurrentMachineMessagesEnabled: () => { throw new Error(grokText('信息服务不可用。', 'Messages service unavailable.')); },
    getExperimentsSnapshot: () => voice.refresh(),
  };
  const missing = new Set();
  return {
    updateTheme,
    has: method => Boolean(known[method]),
    async call(method, args = {}) {
      if (known[method]) return known[method](args ?? {});
      if (/^(report|note|expose|log|setTitleBar|setUnreadFilter|setWindow|markGrokBotTerms|resizeWindow)/.test(method)) return null;
      if (!missing.has(method)) { missing.add(method); log('[missing local method]', method); }
      throw new Error(`The Android client does not implement ${method}`);
    },
  };
}
