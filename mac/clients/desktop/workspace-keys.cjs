// Loaded by Electron preload and served as a plain script by the Android bridge.
(() => {
  if (window !== window.top) return;
  const layers = 'dialog[open], [role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]';
  window.addEventListener('keydown', event => {
    const field = event.target;
    if (event.key !== 'Escape' || event.isComposing || event.repeat || !field?.matches?.('input[role="combobox"][aria-autocomplete]') || field.value !== '') return;
    const layer = field.closest(layers), close = layer?.querySelector('button.sand-plugins-dialog__close');
    if (!close || close.closest(layers) !== layer || close.disabled || !close.getClientRects().length) return;
    event.preventDefault(); event.stopImmediatePropagation(); close.click();
  }, true);
  function guard(event) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return;
    const visible = el => el.isConnected && !el.closest('[inert],[aria-hidden="true"]') && el.getClientRects().length > 0;
    const layer = event.composedPath().find(el => el.nodeType === 1 && el.matches(layers) && visible(el));
    if (layer) {
      // Let handlers on the control and dialog run; do not bubble to the background chat.
      const contain = e => { if (e === event) e.stopPropagation(); };
      layer.addEventListener(event.type, contain);
      setTimeout(() => layer.removeEventListener(event.type, contain), 0);
    } else if ([...document.querySelectorAll(layers)].some(visible)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  window.addEventListener('keydown', guard, true);
  window.addEventListener('keyup', guard, true);
})();
