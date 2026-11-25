// Sign-in page of the web client (/web/login). A browser signs in with a pairing code from the
// admin page and receives an HttpOnly cookie; the interface itself is served only after that.
// "Open in this browser" on the admin page passes a one-time ticket in the fragment instead.
import { t, localize } from './i18n.js';
import { $ } from './ui.js';
import { createFace, lookAt, resetLook, blink } from './face.js';

localize(document.body);
const form = $('#web-form'), code = $('#web-code'), message = $('#web-message'), status = $('#web-status');
const face = createFace();
face.classList.add('login-face');
$('#web-face').append(face);
blink(() => [face]);
addEventListener('pointermove', event => lookAt(face, event.clientX, event.clientY, 0.075));
addEventListener('pointerleave', () => resetLook(face));

const say = text => { message.textContent = text; message.hidden = !text; };
const note = text => { status.textContent = text; status.hidden = !text; };
const next = () => {
  const params = new URLSearchParams(location.search);
  params.delete('expired');
  const query = params.toString();
  return `/web/${query ? `?${query}` : ''}`;
};

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-grokbot-web': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? t(value.error) : t('请求失败 ({0})', response.status));
  return value;
}

function deviceName() {
  const agent = navigator.userAgent;
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : '';
  return `${t('网页版')} · ${[system, browser].filter(Boolean).join(' ') || t('浏览器')}`.slice(0, 80);
}

// Chinese input methods often type full-width characters; codes use letters and digits only.
let composing = false;
const tidy = () => { code.value = code.value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); };
code.addEventListener('compositionstart', () => { composing = true; });
code.addEventListener('compositionend', () => { composing = false; tidy(); });
code.addEventListener('input', event => { if (!composing && !event.isComposing) tidy(); if (!message.hidden) say(''); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (composing) return;
  tidy();
  if (code.value.length !== 6) { say(t('请输入 6 位配对码。')); code.focus(); return; }
  $('.auth-talk').classList.add('pending');
  $('#web-submit').disabled = true;
  try {
    await call('/web/api/pair', { pairingKey: code.value, deviceName: deviceName() });
    // The click is the user gesture browsers require before asking about notifications.
    if (typeof Notification === 'function' && Notification.permission === 'default')
      await Promise.race([Notification.requestPermission().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
    location.assign(next());
  } catch (error) {
    say(error.message);
    $('.auth-talk').classList.remove('pending');
    $('#web-submit').disabled = false;
  }
});

$('#web-logout').addEventListener('click', async () => {
  $('#web-logout').disabled = true;
  try { await call('/web/api/logout', {}); location.reload(); }
  catch (error) { note(error.message); $('#web-logout').disabled = false; }
});
$('#web-open').href = next();

const insecure = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
$('#web-insecure').hidden = !insecure;
const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
if (ticket) history.replaceState(history.state, '', location.pathname + location.search);
async function redeem() {
  try { await call('/web/api/ticket', { ticket }); location.replace(next()); return true; }
  catch (error) { note(error.message); return false; }
}
async function start() {
  if (ticket && await redeem()) return;
  const session = await call('/web/api/session');
  if (!session.available) {
    $('#web-lead').hidden = true;
    note(t('网页版还没有启用。请管理员在 Host 管理页「网页版」上传界面包并启用。'));
  } else if (session.paired) {
    $('#web-title').textContent = t('已登录');
    $('#web-lead').hidden = true;
    $('#web-device').textContent = t('这个浏览器已登录为“{0}”。', session.deviceName ?? '');
    $('#web-paired').hidden = false;
  } else {
    form.hidden = false;
    if (new URLSearchParams(location.search).has('expired')) say(t('登录已失效，请输入新的配对码。'));
    code.focus();
  }
}
try {
  await start();
} catch (error) {
  note(t('无法连接 Host：{0}', error.message));
}
