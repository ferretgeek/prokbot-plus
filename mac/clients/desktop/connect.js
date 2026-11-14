import { grokText as text } from './i18n.mjs';
import { normalizePairingCode } from './pairing-code.mjs';
const server = document.querySelector('#server');
const tailcat = document.querySelector('#tailcat');
const key = document.querySelector('#key');
const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
let saved = null;
const canRetry = () => Boolean(saved && server.value === saved.server && tailcat.checked === saved.tailcat);
document.documentElement.lang = /^zh/i.test(window.connection.locale) ? 'zh-CN' : 'en';
document.title = text('连接 Grok Bot', 'Connect Grok Bot');
document.querySelector('h1').textContent = text('连接你的 Grok Bot', 'Connect your Grok Bot');
document.querySelector('[for=server]').textContent = text('Host 地址', 'Host address');
document.querySelector('[for=key]').textContent = text('配对码', 'Pairing code');
key.placeholder = text('配对码', 'Pairing code');
connect.textContent = text('连接', 'Connect');
const updateRetry = () => {
  const retry = canRetry();
  key.required = !retry;
  key.placeholder = retry ? text('可留空以重新连接', 'Leave blank to reconnect') : text('配对码', 'Pairing code');
  if (saved) connect.textContent = retry && !key.value ? text('重新连接', 'Reconnect') : text('重新配对', 'Pair again');
};
tailcat.onchange = () => { server.placeholder = tailcat.checked ? 'tailcat://connect/…' : 'https://bot.example.com'; updateRetry(); };
server.addEventListener('input', updateRetry);
const tidyKey = () => { key.value = normalizePairingCode(key.value); updateRetry(); };
key.addEventListener('input', event => { if (!event.isComposing) tidyKey(); });
key.addEventListener('compositionend', tidyKey);
disconnect.textContent = text('退出连接', 'Disconnect');
window.connection.status().then(result => {
  saved = result.paired && !result.connected ? result : null;
  server.value = result.server ?? ''; tailcat.checked = result.tailcat === true; tailcat.onchange();
  disconnect.hidden = !result.paired;
  if (result.error) status.textContent = result.error;
  if (result.connected) connect.textContent = text('重新配对', 'Pair again');
}).catch(error => { status.textContent = error.message; });
document.querySelector('#form').addEventListener('submit', async event => {
  event.preventDefault();
  if (connect.disabled) return;
  connect.disabled = true; disconnect.disabled = true;
  status.textContent = text('正在连接…', 'Connecting…'); status.style.color = '#aaa';
  try {
    const result = await window.connection.pair(server.value, key.value, tailcat.checked, canRetry() && !key.value);
    if (!result.ok) throw new Error(result.error);
    key.value = ''; status.textContent = text('已连接', 'Connected');
  } catch (error) { status.textContent = error.message; status.style.color = '#f09b94'; }
  finally { connect.disabled = false; disconnect.disabled = false; }
});
disconnect.addEventListener('click', async () => {
  if (disconnect.disabled) return;
  connect.disabled = true; disconnect.disabled = true;
  try {
    await window.connection.disconnect(); key.value = ''; disconnect.hidden = true; saved = null; updateRetry();
    connect.textContent = text('连接', 'Connect'); status.textContent = text('已断开', 'Disconnected');
  } catch (error) { status.textContent = error.message; status.style.color = '#f09b94'; }
  finally { connect.disabled = false; disconnect.disabled = false; }
});
