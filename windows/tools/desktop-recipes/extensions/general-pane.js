
// Appended to the original 1.3.0 General settings module. $, Q, K, He, L, vr,
// Wn and X are its JSX runtime, React, button, toggle, dialog parts, account
// card styles, section and row. The dialogs reuse the original modal parts.
function GrokAccountHost() {
  const [host, setHost] = Q.useState('Grok Bot Host');
  Q.useEffect(() => {
    const apply = status => setHost(status.profile?.hostName || 'Grok Bot Host');
    void window.localBot.connectionStatus().then(apply).catch(() => {});
    return window.localBot.onConnectionChanged(apply);
  }, []);
  return host;
}
const grokInputClass = 'sand-9f619 sand-h8yej3 sand-dj266r sand-14z9mp sand-at24cr sand-1lziwak sand-1yrsyyn sand-2vl965 sand-10b6aqq sand-e2zdcy sand-mkeg23 sand-1y0btm7 sand-17tbahu sand-vk9egn sand-ur7f20 sand-10e981r sand-tyxrsu sand-jb2p0i sand-fc7y3v sand-1yxxptd sand-1t137rt sand-1h7ufjq';
const grokConnectionStyles = `
.grok-host-dialog{width:min(440px,calc(100vw - 32px))!important;max-width:calc(100vw - 32px)!important;height:auto!important;max-height:calc(100vh - 32px);overflow:auto}
.grok-host-dialog .grok-host-content{padding:30px;min-width:0;display:grid;gap:24px}
.grok-host-dialog header{display:grid;gap:10px;text-align:left}
.grok-host-dialog .grok-host-brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.grok-host-dialog .grok-host-brand img{display:block;width:44px;height:44px}
.grok-host-dialog .sand-dialog__title{font-size:24px;line-height:1.25;letter-spacing:-.45px;text-align:left}
.grok-host-identity{display:flex;align-items:center;gap:16px;min-width:0;padding:2px 0 4px}
.grok-host-avatar{width:64px;height:64px;border-radius:50%;flex:0 0 64px;object-fit:cover;background:color-mix(in srgb,currentColor 7%,transparent)}
.grok-host-avatar-fallback{display:grid;place-items:center;font-size:25px;font-weight:500}
.grok-host-person{min-width:0;display:grid;gap:7px}
.grok-host-person strong{font-size:21px;line-height:1.25;letter-spacing:-.4px;font-weight:550;overflow-wrap:anywhere}
.grok-host-person span{font-size:12px;opacity:.5}
.grok-host-details{padding:16px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);background:color-mix(in srgb,currentColor 3%,transparent);border-radius:14px;display:grid;gap:14px;min-width:0}
.grok-host-detail{display:flex;align-items:baseline;justify-content:space-between;gap:18px;min-width:0;font-size:13px;line-height:1.5}
.grok-host-detail>span:first-child{opacity:.55;flex-shrink:0}
.grok-host-detail>span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}
.grok-host-status{display:inline-flex;align-items:center;gap:7px}
.grok-host-status:before{content:'';width:6px;height:6px;border-radius:50%;background:#b49a60;flex-shrink:0}
.grok-host-status[data-online=true]:before{background:#62ad87}
.grok-host-paired-actions{justify-content:space-between!important;margin-top:2px!important}
.grok-host-fields{display:grid;gap:20px;min-width:0}
.grok-host-fields label{display:grid;gap:8px;font-size:13px;min-width:0}
.grok-host-fields input{min-width:0;width:100%;height:44px;padding:10px 12px;font-size:14px}
.grok-host-error{color:var(--sand-text-error,#df6464);margin:0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.grok-host-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:0}
.grok-account-name{display:inline-flex;align-items:center;gap:8px;max-width:100%;width:fit-content;border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.grok-account-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grok-account-name svg{width:14px;height:14px;flex:none;opacity:0;transition:opacity .12s}
.grok-account-name:hover svg,.grok-account-name:focus-visible svg{opacity:.5}
.grok-account-name:focus-visible{outline:2px solid currentColor;outline-offset:4px;border-radius:3px}
@media(prefers-reduced-motion:reduce){.grok-account-name svg{transition:none}}
@media(max-width:480px){.grok-host-dialog .grok-host-content{padding:26px 24px}.grok-host-dialog .sand-dialog__title{font-size:22px}}
`;
const grokBlockComposedEnter = composing => event => {
  if (event.key === 'Enter' && (event.nativeEvent.isComposing || composing.current || event.keyCode === 229)) event.preventDefault();
};
function GrokAccountName({ className, name, onCommit }) {
  const [open, setOpen] = Q.useState(false), [value, setValue] = Q.useState(name);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState('');
  const input = Q.useRef(null), composing = Q.useRef(false), submitting = Q.useRef(false);
  const edit = () => { setValue(name); setError(''); setOpen(true); };
  const save = async event => {
    event.preventDefault();
    if (composing.current || submitting.current || !value.trim()) return;
    submitting.current = true; setBusy(true); setError('');
    try { await onCommit(value.trim()); setOpen(false); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return $.jsxs($.Fragment, { children: [
    $.jsx('style', { children: grokConnectionStyles }),
    $.jsxs('button', { type: 'button', className: `grok-account-name ${className}`, onClick: edit,
      'aria-label': grokText('修改账户名称', 'Edit account name'), children: [$.jsx('span', { children: name }),
        $.jsx('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true,
          children: $.jsx('path', { d: 'm16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5' }) })] }),
    open ? $.jsxs(L.Root, { open: true, onOpenChange: setOpen, size: 'sm',
      className: 'grok-host-dialog', 'aria-label': grokText('修改账户名称', 'Edit account name'), initialFocus: input, children: [
      $.jsx(L.CloseButton, {}),
      $.jsxs('form', { className: 'grok-host-content', onSubmit: save, children: [
        $.jsx('header', { children: $.jsx(L.Title, { children: grokText('修改账户名称', 'Edit account name') }) }),
        $.jsx('div', { className: 'grok-host-fields', children:
          $.jsxs('label', { children: [grokText('账户名称', 'Account name'), $.jsx('input', { ref: input, className: grokInputClass,
            value, maxLength: 80, required: true, disabled: busy, 'aria-label': grokText('账户名称', 'Account name'),
            onChange: event => setValue(event.currentTarget.value),
            onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
            onKeyDown: grokBlockComposedEnter(composing) })] }) }),
        error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
        $.jsxs('div', { className: 'grok-host-actions', children: [
          $.jsx(L.Action, { type: 'button', variant: 'secondary', onClick: () => setOpen(false), disabled: busy, children: grokText('取消', 'Cancel') }),
          $.jsx(L.Action, { type: 'submit', variant: 'primary', disabled: busy || !value.trim(), pending: busy, children: grokText('保存', 'Save') })] })] })] }) : null,
  ] });
}
function GrokRealtimeVoiceSettings() {
  const [enabled, setEnabled] = Q.useState(false), [busy, setBusy] = Q.useState(true), [error, setError] = Q.useState('');
  Q.useEffect(() => {
    let alive = true;
    void window.localBot.getVoicePreference().then(value => { if (alive) { setEnabled(value === true); setBusy(false); } })
      .catch(() => { if (alive) setError(grokText('无法读取设置', 'Could not load setting')); });
    const release = window.localBot.onVoicePreferenceChanged(value => { if (alive) setEnabled(value === true); });
    return () => { alive = false; release(); };
  }, []);
  const toggle = async () => {
    setBusy(true); setError('');
    try { setEnabled(await window.localBot.setVoicePreference(!enabled)); }
    catch { setError(grokText('无法保存设置', 'Could not save setting')); }
    finally { setBusy(false); }
  };
  const label = grokText('实时语音（实验性）', 'Realtime voice (Experimental)');
  return $.jsx(Wn, { anchorId: 'outside-settings', title: grokText('语音', 'Voice'), children: $.jsx(X, {
    anchorId: null, label, description: error || null, variant: 'card',
    children: $.jsx(He, { isChecked: enabled, isDisabled: busy, label, onToggle: toggle, size: 'md' }),
  }) });
}
function GrokHostConnection() {
  const [open, setOpen] = Q.useState(false), [server, setServer] = Q.useState(''), [key, setKey] = Q.useState('');
  const [editing, setEditing] = Q.useState(false), [tailcat, setTailcat] = Q.useState(false);
  const [busy, setBusy] = Q.useState(false), [error, setError] = Q.useState(''), [status, setStatus] = Q.useState(null);
  const input = Q.useRef(null), submitting = Q.useRef(false), composing = Q.useRef(false), editingRef = Q.useRef(false);
  editingRef.current = editing;
  const applyStatus = value => { setStatus(value); if (!editingRef.current && !submitting.current) { setTailcat(value.tailcat === true); if (value.server) setServer(value.server); } };
  const refresh = () => window.localBot.connectionStatus().then(applyStatus).catch(failure => setError(failure.message));
  const request = () => { window.__grokLocalConnectionRequested = false; setError(''); setKey(''); setEditing(false); setOpen(true); void refresh(); };
  Q.useEffect(() => {
    void refresh();
    return window.localBot.onConnectionChanged(applyStatus);
  }, []);
  Q.useEffect(() => {
    if (!open) return;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open]);
  Q.useEffect(() => {
    // Opening the settings and the nested dialog in one commit hides the dialog from accessibility.
    const pending = window.__grokLocalConnectionRequested ? setTimeout(request, 0) : null;
    window.addEventListener('grokbot-local:connect-request', request);
    return () => { clearTimeout(pending); window.removeEventListener('grokbot-local:connect-request', request); };
  }, []);
  const connect = async event => {
    event.preventDefault();
    if (composing.current || submitting.current || !server.trim() || (!editing && !key.trim())) return;
    submitting.current = true; setBusy(true); setError('');
    try { const result = await window.localBot.pair({ server, key, tailcat, edit: editing }); if (!result.ok) throw new Error(result.error); setKey(''); setOpen(false); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  };
  const disconnect = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { await window.localBot.disconnect(); setStatus({ paired: false }); setKey(''); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  };
  Q.useEffect(() => { if (open && status && !status.paired) input.current?.focus(); }, [open, status?.paired]);
  const retainFocus = event => {
    if (event.key !== 'Tab') return;
    const fields = [...event.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter(element => element.tabIndex >= 0 && element.getClientRects().length);
    if (!fields.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = fields.indexOf(document.activeElement);
    fields[(current + (event.shiftKey ? -1 : 1) + fields.length) % fields.length].focus();
  };
  const field = (label, value, onChange, type, placeholder, ref) => $.jsxs('label', { children: [label,
    $.jsx('input', { className: grokInputClass, 'aria-label': label, type, value, placeholder, ref, required: true,
      autoComplete: 'off', spellCheck: false, disabled: busy,
      maxLength: type === 'text' ? 6 : undefined, pattern: type === 'text' ? '[A-Za-z0-9]{6}' : undefined, autoCapitalize: type === 'text' ? 'characters' : 'off', onChange: event => onChange(event.currentTarget.value),
      onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
      onKeyDown: grokBlockComposedEnter(composing) })] });
  const paired = Boolean(status?.paired), person = status?.profile;
  const title = paired ? grokText('连接设置', 'Connection settings') : grokText('连接你的 Grok Bot', 'Connect your Grok Bot');
  const stateLabel = status?.state === 'online' ? grokText('已连接', 'Connected') : status?.state === 'connecting' ? grokText('正在连接', 'Connecting') : grokText('正在重新连接', 'Reconnecting');
  return $.jsxs($.Fragment, { children: [
    $.jsx(K, { onClick: request, size: 'md', style: vr.actionWeakBorder, variant: 'secondary', children: grokText('连接设置', 'Connection settings') }),
    open ? $.jsxs(L.Root, { 'aria-label': title, open: true, onOpenChange: setOpen, size: 'sm',
      className: 'grok-host-dialog', initialFocus: input, onKeyDown: retainFocus, children: [
      $.jsx('style', { children: grokConnectionStyles }), $.jsx(L.CloseButton, {}),
      !status ? $.jsx('div', { className: 'grok-host-content', role: 'status', children: error || grokText('正在读取连接…', 'Loading connection…') }) : paired && !editing ?
      $.jsxs('section', { className: 'grok-host-content', children: [
        $.jsx('header', { children: $.jsx(L.Title, { children: title }) }),
        $.jsxs('div', { className: 'grok-host-identity', children: [
          person?.avatarDataUrl ? $.jsx('img', { className: 'grok-host-avatar', src: person.avatarDataUrl, alt: '' }) :
            $.jsx('span', { className: 'grok-host-avatar grok-host-avatar-fallback', 'aria-hidden': true, children: Array.from(person?.displayName || 'G')[0] }),
          $.jsxs('div', { className: 'grok-host-person', children: [
            $.jsx('strong', { children: person?.displayName || grokText('本地账户', 'Local account') }), $.jsx('span', { children: grokText('当前账户', 'Account') })] })] }),
        $.jsxs('div', { className: 'grok-host-details', children: [
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: 'Host' }), $.jsx('span', { children: person?.hostName || 'Grok Bot Host' })] }),
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: grokText('连接状态', 'Status') }),
            $.jsx('span', { className: 'grok-host-status', 'data-online': status.state === 'online', role: 'status', children: stateLabel })] }),
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: grokText('连接方式', 'Connection') }),
            $.jsx('span', { children: status.tailcat ? 'Tailcat' + (status.transportPath === 'relay' ? ' · ' + grokText('中继', 'Relay') : status.transportPath === 'direct' ? ' · ' + grokText('直连', 'Direct') : '') : grokText('直接连接', 'Direct') })] })] }),
        error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null,
        $.jsxs('div', { className: 'grok-host-actions grok-host-paired-actions', children: [
          $.jsx(L.Action, { type: 'button', onClick: disconnect, disabled: busy, pending: busy, variant: 'secondary', children: busy ? grokText('正在退出…', 'Disconnecting…') : grokText('退出连接', 'Disconnect') }),
          $.jsx(L.Action, { type: 'button', onClick: () => setEditing(true), variant: 'secondary', children: grokText('编辑连接', 'Edit connection') }),
          $.jsx(L.Action, { type: 'button', onClick: () => setOpen(false), variant: 'primary', children: grokText('完成', 'Done') })] })] }) :
      $.jsxs('form', { className: 'grok-host-content', onSubmit: connect, children: [
        $.jsxs('header', { children: [
          $.jsx('div', { className: 'grok-host-brand', children: $.jsx('img', { src: new URL('../../../local-client/icon.png', import.meta.url).href, alt: 'Grok Bot' }) }),
          $.jsx(L.Title, { children: grokText('连接你的 Grok Bot', 'Connect your Grok Bot') })] }),
        $.jsxs('div', { className: 'grok-host-fields', children: [
          $.jsxs('div', { className: 'grok-host-detail', children: [$.jsx('span', { children: 'Tailcat' }), $.jsx(He, { isChecked: tailcat, isDisabled: busy, label: 'Tailcat', onToggle: () => setTailcat(!tailcat), size: 'md' })] }),
          field(tailcat ? grokText('连接链接', 'Connection link') : grokText('Host 地址', 'Host address'), server, setServer, 'url', tailcat ? 'tailcat://connect/…' : 'https://bot.example.com', input),
          !editing && field(grokText('配对码', 'Pairing code'), key, value => setKey(value.toUpperCase()), 'text', grokText('输入新的配对码', 'Pairing code')),
          error ? $.jsx('p', { className: 'grok-host-error', role: 'alert', children: error }) : null] }),
        $.jsxs('div', { className: 'grok-host-actions', children: [
          $.jsx(L.Action, { type: 'button', onClick: () => setOpen(false), variant: 'secondary', children: grokText('取消', 'Cancel') }),
          $.jsx(L.Action, { type: 'submit', disabled: busy || !server.trim() || (!editing && !key.trim()), pending: busy,
            variant: 'primary', children: busy ? grokText('正在连接…', 'Connecting…') : editing ? grokText('保存', 'Save') : grokText('连接', 'Connect') })] })] })] }) : null,
  ] });
}
