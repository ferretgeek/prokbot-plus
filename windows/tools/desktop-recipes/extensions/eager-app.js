
// Appended to the original 1.3.0 app module. X, Z, MPt, IN, Pw, eN, tN, YN, MD,
// $o, $, pu, LN, mo, ZS, QS and PC are its React, JSX runtime, Bot fields, dialog
// parts, InfoPane section/card/row controls, i18n and style helpers.
const GrokLibraryFiles = X.lazy(() => import(new URL(GROK_LIBRARY_CHUNK, import.meta.url).href)
  .then(module => ({ default: module.GrokLibraryFiles })));
function GrokLocalSettings({ agent }) {
  const [filesOpen, setFilesOpen] = X.useState(false);
  const [error, setError] = X.useState('');
  const [saving, setSaving] = X.useState(false);
  const save = async fields => {
    setSaving(true); setError('');
    try { await window.localBot.updateProfile(agent.id, fields); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { setSaving(false); }
  };
  const label = text => Z.jsx('div', { className: 'sand-1y1aw1k sand-jkvuk6 sand-mzvs34 sand-f159sx sand-1wm8ruf sand-10jubzo sand-1o0liin', children: text });
  const filesLabel = grokText('资料库文件', 'Library files');
  return Z.jsxs('div', { className: 'sand-agent-settings', style: { display: 'grid', gap: 12, marginTop: 20 }, children: [
    label(grokText('标题', 'Title')),
    Z.jsx(MPt, { ariaLabel: grokText('Bot 标题', 'Bot title'), initialValue: agent.title ?? '', placeholder: grokText('简短描述这个 Bot', 'Short description'), onCommit: title => save({ title }) }),
    label(grokText('指令', 'Instructions')),
    Z.jsx(IN, { ariaLabel: grokText('Bot 指令', 'Bot instructions'), isEditable: true, kind: 'description', value: agent.description ?? '', placeholder: grokText('这个 Bot 应遵循的指令', 'Instructions for this Bot'), onCommit: description => save({ description }) }),
    Z.jsx('button', { type: 'button', onClick: () => setFilesOpen(true), style: { border: '1px solid currentColor', borderRadius: 8, padding: '10px 12px', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' }, children: filesLabel }),
    saving ? Z.jsx('p', { role: 'status', children: grokText('正在保存…', 'Saving…') }) : null,
    error ? Z.jsx('p', { role: 'alert', style: { color: '#f09b94' }, children: error }) : null,
    filesOpen ? Z.jsxs(Pw.Root, { open: true, onOpenChange: setFilesOpen, size: 'lg', 'aria-label': filesLabel, children: [
      Z.jsx(Pw.Header, { children: Z.jsx(Pw.Title, { children: filesLabel }) }),
      Z.jsx(Pw.CloseButton, {}),
      Z.jsx(Pw.Body, { children: Z.jsx(X.Suspense, {
        fallback: Z.jsx('p', { role: 'status', children: grokText('正在读取资料库…', 'Loading library…') }),
        children: Z.jsx(GrokLibraryFiles, { agent }) }) }),
    ] }) : null,
  ] });
}
function GrokLocalOverviewSettingsBody({ agent }) {
  const instructionsHeadingId = X.useId();
  const notifyLabelId = X.useId();
  const [expanded, setExpanded] = X.useState(false);
  const [overflows, setOverflows] = X.useState(null);
  const [saving, setSaving] = X.useState(false);
  const [error, setError] = X.useState('');
  const [displayRef] = X.useState(() => {
    let currentObserver = null;
    return el => {
      currentObserver?.disconnect();
      currentObserver = null;
      if (el == null) { setOverflows(null); return; }
      const measure = () => setOverflows(el.scrollHeight > 111);
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        currentObserver = observer;
      }
      return () => { currentObserver?.disconnect(); currentObserver = null; };
    };
  });
  const { roster } = $();
  const { dispatch: setNotify, failure: notifyFailure, isPending: notifyPending } = pu(roster.setAgentNotifyOnUpdates);
  const saveDescription = async description => {
    setSaving(true); setError('');
    try { await window.localBot.updateProfile(agent.id, { description }); }
    catch (failure) { setError(failure.message || grokText('保存失败，请重试。', 'Could not save. Try again.')); }
    finally { setSaving(false); }
  };
  const collapsed = !expanded && overflows !== false && LN.collapsed;
  const faded = !expanded && overflows === true && LN.faded;
  const notifyDescription = notifyFailure == null ? Z.jsx($o, { id: 'ttdOeI' }) : Z.jsx($o, { id: 'QqKsGg' });
  return Z.jsxs(Z.Fragment, { children: [
    Z.jsx(eN, {
      heading: grokText('指令', 'Instructions'),
      headingId: instructionsHeadingId,
      children: Z.jsxs('div', {
        'aria-labelledby': instructionsHeadingId,
        role: 'group',
        className: 'sand-78zum5 sand-dt5ytf sand-1v2ro7d sand-96k8nx sand-1bjonze sand-dvlbce sand-1pixwil sand-4hv7ue sand-1y0btm7 sand-5fd6op sand-wwa1cs sand-10e981r',
        children: [
          Z.jsx(IN, {
            ariaLabel: grokText('Bot 指令', 'Bot instructions'),
            displayRef,
            displayStyle: [collapsed, faded],
            isEditable: true,
            kind: 'description',
            onCommit: saveDescription,
            placeholder: grokText('这个 Bot 应遵循的指令', 'Instructions for this Bot'),
            value: agent.description ?? '',
          }),
          overflows === true ? Z.jsx('button', {
            'aria-expanded': expanded,
            onClick: () => setExpanded(value => !value),
            type: 'button',
            ...mo(ZS.base, QS.regular, PC.keyboardFocus, LN.toggle),
            children: expanded ? Z.jsx($o, { id: '6lGV3K' }) : Z.jsx($o, { id: 'fMPkxb' }),
          }) : null,
          saving ? Z.jsx('p', { role: 'status', style: { margin: 0, fontSize: 12, opacity: 0.7 }, children: grokText('正在保存…', 'Saving…') }) : null,
          error ? Z.jsx('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: '#f09b94' }, children: error }) : null,
        ],
      }),
    }),
    Z.jsx(tN, {
      labelledBy: notifyLabelId,
      children: Z.jsx(YN, {
        description: notifyDescription,
        label: Z.jsx($o, { id: 'iDNBZe' }),
        labelId: notifyLabelId,
        layout: 'pane',
        children: Z.jsx(MD, {
          isChecked: Boolean(agent.notifyOnUpdatesEnabled),
          isDisabled: notifyPending,
          labelledBy: notifyLabelId,
          onToggle: enabled => setNotify(agent.id, enabled),
          size: 'md',
        }),
      }),
    }),
  ] });
}
function GrokLocalOverviewSettings({ agent }) {
  if (!agent || agent.isGroup || agent.viewerIsOwner === false) return null;
  return Z.jsx(GrokLocalOverviewSettingsBody, { agent }, agent.id);
}
