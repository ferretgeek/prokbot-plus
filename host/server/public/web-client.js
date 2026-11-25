import { t, html } from './i18n.js';
import { $, confirmAction, date } from './ui.js';
import { icon } from './icons.js';

const MiB = 1024 * 1024;

/** Uploads with progress; fetch cannot report how much of a request body has been sent. */
function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', '/admin/api/web-client');
    request.setRequestHeader('content-type', 'application/zip');
    request.setRequestHeader('x-grokbot-csrf', '1');
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => {
      let value = null;
      try { value = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300 && value) resolve(value);
      else reject(new Error(typeof value?.error === 'string' ? t(value.error) : t('请求失败 ({0})', request.status)));
    };
    request.onerror = () => reject(new Error(t('无法连接管理服务。')));
    request.send(file);
  });
}

function deviceName() {
  const agent = navigator.userAgent;
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android'
    : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
  return `${t('网页版')} · ${[system, browser].filter(Boolean).join(' ') || t('浏览器')}`.slice(0, 80);
}

export function createWebClientPage({ api, toast, busy, refresh, copy }) {
  $('[data-panel=web-client]').innerHTML = html(`<header class="page-header"><h1>网页版</h1><div class="page-actions"><button id="web-client-open" class="btn btn-primary" type="button" disabled>在此浏览器打开</button></div></header>
    <section class="section"><div class="section-head"><h2 class="section-title">访问</h2></div><div class="card">
      <label class="row"><span class="row-copy"><span class="row-title">启用网页版</span><span class="row-hint">在任何设备的浏览器里使用 Bot，不用安装客户端；只能使用 Host 上的 Bot 电脑</span></span><input id="web-client-enabled" type="checkbox" role="switch" aria-label="启用网页版" disabled /></label>
      <div class="row"><span class="row-copy"><span class="row-title">界面包</span></span><span id="web-client-bundle" class="row-value">未上传</span></div>
      <div class="row"><span class="row-copy"><span class="row-title">网页地址</span><span class="row-hint">在其他设备打开，输入「设备与通知」里创建的配对码登录。网页版使用单独的端口，经反向代理访问时需要为它单独配置入口</span></span>
        <span class="row-control auto"><code id="web-client-url" class="row-value" data-private></code><button id="web-client-copy" class="icon-btn" type="button" aria-label="复制网页地址">${icon('copy')}</button></span></div>
    </div><p id="web-client-insecure" class="row-hint web-client-warning" hidden>当前 Host 地址是 http。网页版可以使用，但语音输入、麦克风和浏览器通知需要 https；在公网使用时请配置 https。</p></section>
    <section class="section"><div class="section-head"><h2 class="section-title">界面包</h2></div><div class="card">
      <div class="row"><span class="row-copy"><span class="row-title">上传界面包</span><span class="row-hint">在电脑上运行 node web/patchers/patch.mjs，把 web/output/ 里生成的界面包上传。界面取自你自己下载的官方 Windows 安装包，只保存在这台 Host 上，未登录的访问者拿不到。</span></span>
        <span class="row-control auto"><input id="web-client-file" type="file" accept=".zip,application/zip" hidden /><button id="web-client-upload" class="btn" type="button">选择文件并上传</button></span></div>
      <div class="row"><span class="row-copy"><span class="row-title">删除界面包</span><span class="row-hint">网页版随之停用；已登录的浏览器仍列在「设备与通知」里，可在那里撤销</span></span><button id="web-client-remove" class="btn btn-danger" type="button" disabled>删除</button></div>
    </div></section>`);
  let url = '';

  function render(value) {
    const toggle = $('#web-client-enabled');
    toggle.checked = value.enabled; toggle.disabled = !value.installed;
    $('#web-client-bundle').textContent = value.installed
      ? t('界面 {0} · {1} 个文件 · {2} MB · 上传于 {3}', value.rendererVersion, value.files, (value.bytes / MiB).toFixed(1), date(value.installedAt))
      : t('未上传');
    $('#web-client-open').disabled = !value.available;
    $('#web-client-remove').disabled = !value.installed;
    url = value.url;
    $('#web-client-url').textContent = url;
    const address = new URL(url);
    $('#web-client-insecure').hidden = address.protocol !== 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
  }

  $('#web-client-copy').onclick = () => copy(url);
  $('#web-client-upload').onclick = () => $('#web-client-file').click();
  $('#web-client-file').onchange = () => {
    const file = $('#web-client-file').files[0];
    $('#web-client-file').value = '';
    if (!file) return;
    const control = $('#web-client-upload');
    busy(control, async () => {
      try {
        render(await upload(file, fraction => { control.textContent = t('正在上传 {0}%', Math.round(fraction * 100)); }));
        toast(t('网页版界面包已安装'));
        await refresh();
      } catch (error) { toast(error.message, true); }
    });
  };
  $('#web-client-enabled').onchange = event => {
    const enabled = event.target.checked;
    busy(event.target, async () => {
      try { render(await api('/admin/api/web-client', { method: 'PATCH', body: { enabled } })); toast(enabled ? t('网页版已启用') : t('网页版已停用')); }
      catch (error) { event.target.checked = !enabled; toast(error.message, true); }
    });
  };
  $('#web-client-remove').onclick = () => busy($('#web-client-remove'), async () => {
    if (!await confirmAction({ title: t('删除网页版界面包？'), message: t('网页版会停用。之后要使用，需要重新上传界面包。'), action: t('删除') })) return;
    try { render(await api('/admin/api/web-client', { method: 'DELETE' })); toast(t('网页版界面包已删除')); }
    catch (error) { toast(error.message, true); }
  });
  $('#web-client-open').onclick = () => {
    // Opened before the request finishes, or the browser treats the new tab as an unrequested popup.
    // The web client runs on another origin and gets no handle back to this page.
    const opened = window.open('', '_blank');
    if (opened) opened.opener = null;
    busy($('#web-client-open'), async () => {
      try {
        const { url: signIn } = await api('/admin/api/web-client/open', { method: 'POST', body: { deviceName: deviceName() } });
        if (opened) opened.location.href = signIn; else location.assign(signIn);
        await refresh();
      } catch (error) { opened?.close(); toast(error.message, true); }
    });
  };

  return {
    async load() { render(await api('/admin/api/web-client')); },
    status(state) {
      if (state.webClient) render(state.webClient);
    },
  };
}
