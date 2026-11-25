
// Appended to the original 1.3.0 app module. X, Z, MPt, IN and Pw are its React,
// JSX runtime, single-line and multi-line Bot fields and dialog parts.
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
