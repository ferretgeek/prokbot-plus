// Entry of the Android workspace page. It runs before the original renderer (the
// patcher inserts it ahead of the renderer's module script) and plays the role of
// the Electron main process and preload of the desktop client:
//
// - runs the original preload (official-preload.js, copied from the user's own
//   download) against a small `electron` stand-in, so the renderer gets exactly the
//   window.desktop / window.coordinatorPort API it was built for;
// - answers the preload's IPC with the services of mac/clients/desktop, ported in
//   services.js and gateway.js;
// - adds window.localBot, the API that the ProkBot Plus renderer patches use.
import officialPreload, { methods as preloadMethods } from './official-preload.js';
import { boot as androidBoot, native, log } from './native.js';
import { createGateway } from './gateway.js';
import { installWebviewFrames } from './webview.js';
import { installLayoutFixes, computerStageOpen, phoneBack, showConversation } from './layout.js';
import { installAnchorFallback } from './anchor-fallback.js';
import { grokText } from './desktop/i18n.mjs';
import {
  auth, themeState, languageState, createStaging, createAttachments, createProfile,
  createVoiceAvailability, mintVoiceCredential, createPersistence, createServices,
} from './services.js';

// Before the renderer sets any inline style (module scripts run in document order).
const anchorFallback = installAnchorFallback();

const settings = { theme: 'system', language: 'system', realtimeVoice: false, botColor: false, spellCheck: true, ...androidBoot.settings };
const systemLocale = androidBoot.systemLocale || navigator.language || 'en';
let systemDark = androidBoot.systemDark === true;
const server = androidBoot.connection?.server ?? '';
const locale = settings.language === 'system' ? systemLocale : settings.language;
document.documentElement.lang = /^zh/i.test(locale) ? 'zh-CN' : 'en';
document.documentElement.classList.add('grokbot-android');

const theme = themeState(settings, systemDark);
const language = languageState(settings, systemLocale);
const experiments = {
  featureGates: {
    sand_create_temporal_agents: false,
    grok_bot_box_harness_turns_blocked: false,
    sand_profile_photo_edit: true,
    // Recording a demonstration needs the desktop screen; it stays on the computer clients.
    sand_teach_by_demonstration: false,
    publish_user_skills: true,
    // No local browser profile to import cookies from on the phone.
    agent_prompted_cookie_sync: false,
    sand_voice_call: false,
    sand_voice_resumption: false,
  },
  dynamicConfigs: {},
};
const bootSnapshot = {
  mainEdge: 'served', theme, language, experiments,
  isAssistiveTechEnabled: false, isEgressTunnelEnabled: false, isWebauthnProxyEnabled: false,
  isBotColorInChatEnabled: settings.botColor === true,
  egressTunnelStatus: { enabled: false, active: false },
  rosterPhotos: null, computerUseHelperName: 'Grok Bot Computer Use',
};

// ---- IPC towards the renderer -------------------------------------------------------------

const listeners = new Map();
function emitIpc(channel, payload, ports = []) {
  const event = { sender: null, ports };
  for (const listener of [...(listeners.get(channel) ?? [])]) {
    try { listener(event, payload); } catch (error) { log('[ipc listener]', channel, error); }
  }
}
const emit = (name, payload) => emitIpc(`dune-rpc:main:e:${name}`, payload);

// ---- connection, services ----------------------------------------------------------------

let focused = document.visibilityState === 'visible';
const connectionListeners = new Set();
const voiceListeners = new Set();
let profile = null;
const gateway = createGateway({
  onUnauthorized: () => { void native('unauthorized').catch(() => {}); },
  onConnected: () => reportFocus(),
  onStateChanged: () => reportConnection(),
});
function connectionStatus() {
  return { paired: true, connected: true, server, tailcat: false, transportPath: 'direct',
    state: gateway.getState(), profile: profile?.current() ?? null, error: '' };
}
function reportConnection() {
  const status = connectionStatus();
  for (const listener of [...connectionListeners]) { try { listener(status); } catch {} }
}
function reportFocus() {
  void gateway.command('setWindowFocused', { isFocused: focused }).catch(() => {});
  if (focused) void profile?.refresh().catch(() => {});
}

profile = createProfile({ request: gateway.request, server, emit, onChange: reportConnection });
const voice = createVoiceAvailability({ request: gateway.request, experiments, emit, getPreference: () => settings.realtimeVoice === true });
const persistence = createPersistence(androidBoot.persistence);
const staging = createStaging();
const attachments = createAttachments({ command: gateway.command, staging,
  onProgress: progress => emit('attachment-commit-progress', progress) });

let deepLinksReady = false;
let pendingAgent = androidBoot.pendingAgent ?? null;
function openAgent(id) {
  pendingAgent = id;
  if (!deepLinksReady) return;
  pendingAgent = null;
  showConversation();
  emit('focus-agent', { id });
  void native('ready').catch(() => {});
}

function backgroundColor() {
  const parse = value => /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value ?? '');
  for (const element of [document.querySelector('#root > *'), document.body, document.documentElement]) {
    if (!element) continue;
    const match = parse(getComputedStyle(element).backgroundColor);
    if (match && (match[4] === undefined || Number(match[4]) > 0.9))
      return `#${match.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
  }
  return theme.resolved === 'dark' ? '#111111' : '#ffffff';
}
let chromeTimer = 0, lastChrome = '';
function applyChrome() {
  clearTimeout(chromeTimer);
  // Wait for the renderer to apply the theme before the system bars follow it.
  chromeTimer = setTimeout(() => {
    const chrome = { dark: theme.resolved === 'dark', background: backgroundColor() };
    const key = JSON.stringify(chrome);
    if (key === lastChrome) return;
    lastChrome = key;
    void native('theme', chrome).catch(() => { lastChrome = ''; });
  }, 120);
}

const services = createServices({
  gateway, server, emit, settings, systemLocale, theme, language, boot: bootSnapshot, experiments,
  profile, voice, persistence, attachments,
  systemDark: () => systemDark,
  applyChrome,
  showConnection: () => { location.assign('/app/client/connect.html'); return null; },
  disconnect: async () => { await native('disconnect'); return null; },
  deepLinksReady: async () => {
    deepLinksReady = true;
    const fromShell = await native('ready').then(value => value.pendingAgent).catch(() => null);
    const id = fromShell ?? pendingAgent;
    pendingAgent = null;
    if (id) setTimeout(() => { showConversation(); emit('focus-agent', { id }); }, 0);
    return null;
  },
  voicePreferenceChanged: enabled => {
    for (const listener of [...voiceListeners]) { try { listener(enabled); } catch {} }
  },
  onSettingsChanged: key => { if (key === 'theme') applyChrome(); },
});

// ---- the Electron stand-in for the original preload ---------------------------------------

const methodNames = new Set(preloadMethods);
const ports = new Set();
async function invoke(channel, args) {
  if (channel === 'dune-rpc:main:probe') return { ok: true, value: methodNames.has(args) || services.has(args) };
  if (channel.startsWith('dune-rpc:main:m:')) {
    const method = channel.slice('dune-rpc:main:m:'.length);
    try { return { ok: true, value: await services.call(method, args) }; }
    catch (error) { return { ok: false, failure: { code: 'edge/handler-failed', detail: error?.message ?? String(error) } }; }
  }
  if (channel === 'sand:coordinator-port-request') {
    const { port1, port2 } = new MessageChannel();
    const dispose = gateway.attach(port1);
    ports.add(dispose);
    setTimeout(() => emitIpc('sand:coordinator-port', null, [port2]), 0);
    return undefined;
  }
  if (channel.startsWith('dune-rpc:')) return { ok: false, failure: { code: 'edge/unavailable', detail: 'Not available on Android' } };
  return undefined;
}
function sendSync(channel) {
  if (channel === 'sand:boot-snapshot-sync') return bootSnapshot;
  if (channel === 'grokbot-local:locale') return locale;
  return undefined;
}
const ipcRenderer = {
  invoke: (channel, ...args) => invoke(channel, args[0]),
  send: () => {},
  sendSync: channel => sendSync(channel),
  postMessage: (_channel, _message, transfer) => { for (const port of transfer ?? []) port?.close?.(); },
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
    return ipcRenderer;
  },
  once(channel, listener) {
    const wrapper = (...args) => { ipcRenderer.off(channel, wrapper); listener(...args); };
    return ipcRenderer.on(channel, wrapper);
  },
  off(channel, listener) { listeners.get(channel)?.delete(listener); return ipcRenderer; },
  removeListener(channel, listener) { return ipcRenderer.off(channel, listener); },
  removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); return ipcRenderer; },
};
const electron = {
  ipcRenderer,
  contextBridge: { exposeInMainWorld: (name, api) => Object.defineProperty(window, name, { value: api, configurable: true }) },
  webFrame: { getZoomFactor: () => 1 },
  // Files picked on Android have no path; the preload then stages their bytes.
  webUtils: { getPathForFile: () => '' },
};
const preloadProcess = { platform: 'android', type: 'renderer', argv: [], env: {}, versions: {} };

window.localBot = Object.freeze({
  locale,
  platform: 'android',
  openManagement: () => { void native('open-external', { url: `${server}/admin` }).catch(() => {}); },
  updateProfile: async (id, fields) => {
    if (typeof id !== 'string' || !fields || Object.entries(fields).some(([key, value]) => !['title', 'description'].includes(key) || typeof value !== 'string'))
      throw new Error('Invalid Bot profile');
    const agents = await gateway.command('listAgents');
    const current = agents.find(agent => agent.id === id);
    if (!current) throw new Error(grokText('Bot 不存在', 'Bot not found'));
    return gateway.command('updateAgent', { id, profile: { name: current.name, title: current.title ?? '', description: current.description ?? '', ...fields } });
  },
  connectionStatus: async () => { await profile.refresh().catch(() => {}); return connectionStatus(); },
  mintVoiceCredential: async agentId => {
    try {
      if (settings.realtimeVoice !== true) throw new Error(grokText('请启用实时语音。', 'Enable realtime voice.'));
      return { ok: true, credential: await mintVoiceCredential({ request: gateway.request }, agentId) };
    } catch (error) { return { ok: false, fault: 'unavailable', detail: error.message }; }
  },
  getVoicePreference: () => services.call('getRealtimeVoiceEnabled'),
  setVoicePreference: enabled => services.call('setRealtimeVoiceEnabled', { enabled }),
  onVoicePreferenceChanged: callback => { voiceListeners.add(callback); return () => voiceListeners.delete(callback); },
  pair: async args => {
    if (args?.tailcat === true) return { ok: false, error: grokText('Android 客户端暂不支持 Tailcat，请填写 Host 的 http:// 或 https:// 地址。', 'Tailcat is not available on Android yet. Enter the Host http:// or https:// address.') };
    try { return await native('pair', { server: args?.server ?? '', key: args?.key ?? '', edit: args?.edit === true }); }
    catch (error) { return { ok: false, error: error.message }; }
  },
  disconnect: async () => { await native('disconnect'); return { ok: true }; },
  onConnectionChanged: callback => { connectionListeners.add(callback); return () => connectionListeners.delete(callback); },
});

officialPreload(name => {
  if (name === 'electron') return electron;
  throw new Error(`Cannot find module '${name}'`);
}, preloadProcess);

installWebviewFrames({ hostOrigin: server, vncOrigin: androidBoot.vncOrigin });
installLayoutFixes();
if (anchorFallback) log(`[webview] CSS anchor positioning fallback active (${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown'})`);

// ---- Android shell events and the back gesture --------------------------------------------

function visible(element) {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
}
function back() {
  const overlay = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [data-radix-popper-content-wrapper]')]
    .filter(visible).pop();
  if (overlay) {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : overlay;
    for (const type of ['keydown', 'keyup'])
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    return 'handled';
  }
  // Neither the large computer view nor the details pane closes on Escape; use their buttons.
  const button = computerStageOpen()
    ? document.querySelector('.sand-computer-fullscreen .sand-computer-top-bar__actions button')
    : paneBackButton() ?? [...document.querySelectorAll('[data-grokbot-back]')].filter(visible).pop();
  if (button) { button.click(); return 'handled'; }
  // On a phone a conversation is a screen of its own; back returns to the Bot list.
  return phoneBack() ? 'handled' : 'exit';
}

/** In a details sub-page (such as Bot settings) back returns to the details; otherwise it closes the pane. */
function paneBackButton() {
  const pane = document.querySelector('.sand-info-pane[data-open="true"]');
  if (!pane || !visible(pane)) return null;
  return [...pane.querySelectorAll('.sand-info-pane__back button')].find(visible)
    ?? [...pane.querySelectorAll('.sand-info-pane__actions button')].filter(visible).pop() ?? null;
}

window.__grokbotAndroid = Object.freeze({
  event({ type, payload } = {}) {
    if (type === 'focus') {
      focused = payload?.focused === true;
      reportFocus();
      if (focused) void voice.refresh();
    } else if (type === 'focus-agent' && typeof payload?.id === 'string') {
      openAgent(payload.id);
    } else if (type === 'system-theme') {
      systemDark = payload?.dark === true;
      if (settings.theme === 'system') services.updateTheme(systemDark);
    }
  },
  back,
});

// ---- start --------------------------------------------------------------------------------

addEventListener('pagehide', () => { for (const dispose of ports) dispose(); ports.clear(); gateway.close(); });
// The Host lists unnamed desktop clients as Macs; report this device once per session.
void gateway.request('/local/device', { kind: 'desktop', clientKind: 'android', appVersion: androidBoot.appVersion ?? '0.71.2' }, undefined, 'PUT').catch(() => {});
void profile.refresh().catch(() => {});
void voice.refresh();
applyChrome();
addEventListener('load', applyChrome, { once: true });
new MutationObserver(applyChrome).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
