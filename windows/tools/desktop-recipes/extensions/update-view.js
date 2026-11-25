
// Appended to the original 1.3.0 Updates module; x is its JSX runtime and h is its settings section.
function GrokLocalVersion() {
  return (0, x.jsx)(h, { children: (0, x.jsxs)('div', { style: {
    display: 'flex', alignItems: 'center', gap: 16, padding: '22px 20px', minWidth: 0,
  }, children: [
    (0, x.jsx)('img', { src: new URL('../../../local-client/icon.png', import.meta.url).href, alt: '', style: { width: 48, height: 48, flexShrink: 0 } }),
    (0, x.jsxs)('div', { style: { display: 'grid', gap: 5, flex: 1, minWidth: 0 }, children: [
      (0, x.jsx)('strong', { style: { fontWeight: 550, fontSize: 16 }, children: 'Grok Bot' }),
      (0, x.jsx)('span', { style: { opacity: .55, fontSize: 13 }, children: '1.3.0' }),
    ] }),
    (0, x.jsx)('span', { style: { fontSize: 12, opacity: .55, whiteSpace: 'nowrap' }, children: grokText('本地版', 'Local') }),
  ] }) });
}
