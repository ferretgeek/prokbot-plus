// Pairing page of the Android client: Host address and six-character pairing code,
// as in the desktop client's connection window (mac/clients/desktop/connect.js).
import { boot, native } from './native.js';

const locale = boot.locale || navigator.language || 'en';
window.connection = { locale };
const { grokText: text } = await import('./desktop/i18n.mjs');

const $ = selector => document.querySelector(selector);
const server = $('#server'), key = $('#key'), status = $('#status'), connect = $('#connect');
const paired = $('#paired'), background = $('#background'), disconnect = $('#disconnect'), workspace = $('#workspace');
let current = boot.connection ?? {};
let backgroundEnabled = boot.settings?.backgroundNotifications !== false;
let busy = false, composing = false;

document.documentElement.lang = /^zh/i.test(locale) ? 'zh-CN' : 'en';
document.title = text('连接 Grok Bot', 'Connect Grok Bot');
$('#edition').textContent = text('ProkBot Plus · 自开发 Android 客户端（非官方）', 'ProkBot Plus · Independently developed Android client (unofficial)');
$('h1').textContent = text('连接你的 Grok Bot', 'Connect your Grok Bot');
$('.lead').textContent = text('填写 Host 地址，再到 Host 管理页「设备与通知」生成 6 位配对码。',
  'Enter the Host address, then create a six-character pairing code under Devices & Notifications on the Host admin page.');
$('[for=server]').textContent = text('Host 地址', 'Host address');
$('[for=key]').textContent = text('配对码', 'Pairing code');
key.placeholder = text('6 位配对码', 'Six characters');
$('#background-label').textContent = text('后台接收通知', 'Notifications in the background');
$('#background-hint').textContent = text('保持与 Host 的连接，Bot 回复或需要你处理时发出通知。关闭后只在打开应用时更新。',
  'Keeps a connection to the Host so you are notified when a Bot replies or needs you. When off, updates arrive only while the app is open.');
disconnect.textContent = text('退出连接', 'Disconnect');
workspace.textContent = text('返回工作区', 'Back to workspace');

// A revoked or unreadable credential cannot open the workspace; only pairing again helps.
const usable = () => current.paired === true && !current.error;

function render() {
  const isPaired = current.paired === true;
  server.value ||= current.server ?? '';
  paired.hidden = !isPaired;
  workspace.hidden = !usable();
  background.checked = backgroundEnabled;
  connect.textContent = isPaired ? text('重新配对', 'Pair again') : text('连接', 'Connect');
  if (current.error) setStatus(current.error);
}
function setStatus(message, ok = false) {
  status.textContent = message;
  status.classList.toggle('ok', ok);
}
function setBusy(value) {
  busy = value;
  for (const control of [server, key, connect, disconnect, workspace, background]) control.disabled = value;
}
// Chinese input methods often type full-width characters and the ideographic full stop.
const halfWidth = value => value.normalize('NFKC').replace(/\u3002/g, '.').replace(/\s+/g, '');
// Rewriting the field while an input method is still composing would drop the composition.
const tidyKey = () => { key.value = halfWidth(key.value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
const form = $('#form');
form.addEventListener('compositionstart', () => { composing = true; });
form.addEventListener('compositionend', event => { composing = false; if (event.target === key) tidyKey(); });
key.addEventListener('input', event => { if (!composing && !event.isComposing) tidyKey(); });
server.addEventListener('change', () => { server.value = halfWidth(server.value); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || composing) return;
  tidyKey();
  const address = halfWidth(server.value), code = key.value.trim();
  if (!address) { setStatus(text('请输入 Host 地址。', 'Enter the Host address.')); server.focus(); return; }
  let sameOrigin = false;
  if (usable()) {
    try {
      const candidate = new URL(address), saved = new URL(current.server);
      sameOrigin = /^(https?:)$/.test(candidate.protocol) && !candidate.username && !candidate.password &&
        candidate.pathname === '/' && !candidate.search && !candidate.hash && candidate.origin === saved.origin;
    } catch { /* Native pairing validates the complete address before sending a new code. */ }
  }
  if (usable() && !code && !sameOrigin) {
    setStatus(text('更换 Host 地址须使用新 Host 的配对码。', 'Enter a new pairing code to change Host.'));
    key.focus(); return;
  }
  const edit = usable() && !code && sameOrigin;
  if (!edit && code.length !== 6) { setStatus(text('请输入 6 位配对码。', 'Enter the six-character pairing code.')); key.focus(); return; }
  setBusy(true);
  setStatus(text('正在连接…', 'Connecting…'), true);
  try {
    const result = await native('pair', { server: address, key: code, edit });
    if (!result.ok) throw new Error(result.error);
    key.value = '';
    setStatus(text('已连接，正在打开工作区…', 'Connected. Opening the workspace…'), true);
  } catch (error) {
    setStatus(error.message);
    setBusy(false);
  }
});
disconnect.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await native('disconnect');
    current = { paired: false };
    key.value = '';
    render();
    setStatus(text('已断开', 'Disconnected'), true);
  } catch (error) { setStatus(error.message); }
  finally { setBusy(false); }
});
workspace.addEventListener('click', () => { location.assign('/app/renderer/index.html'); });
background.addEventListener('change', async () => {
  if (busy) return;
  const value = background.checked;
  setBusy(true);
  try {
    const result = await native('settings', { key: 'backgroundNotifications', value });
    backgroundEnabled = result.settings?.backgroundNotifications ?? value;
    setStatus(current.error || '');
  } catch (error) { setStatus(error.message); }
  finally { background.checked = backgroundEnabled; setBusy(false); }
});

window.__grokbotAndroid = Object.freeze({
  back: () => usable() ? 'workspace' : 'exit',
  event: () => {},
});
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
void native('theme', { dark, background: dark ? '#111111' : '#ffffff' }).catch(() => {});
render();
