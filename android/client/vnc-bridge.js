// Runs inside the Bot computer view (noVNC from the Host), on the shell's desktop
// origin. The shell injects it before the page's own scripts and prepends
// `window.__grokbotAppOrigin`. It gives the original VNC preload (vnc-preload.js,
// copied from the user's official download) the Electron functions it expects and
// answers the workspace page, which is the only peer it accepts.
(() => {
  'use strict';
  const appOrigin = window.__grokbotAppOrigin;
  if (!appOrigin || window.parent === window) return;
  const listeners = new Map();
  const post = message => window.parent.postMessage({ grokbotWebview: 1, ...message }, appOrigin);
  const evaluate = code => (0, eval)(code);

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== appOrigin) return;
    const message = event.data;
    if (!message || message.grokbotWebview !== 1) return;
    if (message.type === 'exec') {
      Promise.resolve().then(() => evaluate(message.code)).then(
        value => { try { post({ type: 'result', id: message.id, ok: true, value }); } catch { post({ type: 'result', id: message.id, ok: true, value: null }); } },
        error => post({ type: 'result', id: message.id, ok: false, error: String(error && error.message || error) }));
    } else if (message.type === 'send') {
      for (const listener of [...(listeners.get(message.channel) ?? [])]) {
        try { listener({ sender: null }, ...(Array.isArray(message.args) ? message.args : [])); } catch {}
      }
    } else if (message.type === 'css') {
      const style = document.createElement('style');
      style.textContent = message.css;
      (document.head ?? document.documentElement).append(style);
    }
  });

  const ipcRenderer = {
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
    removeAllListeners(channel) { listeners.delete(channel); return ipcRenderer; },
    sendToHost(channel, ...args) { post({ type: 'ipc', channel, args }); },
    send() {},
    invoke: () => Promise.resolve(null),
  };
  const electron = {
    ipcRenderer,
    webFrame: { executeJavaScript: code => Promise.resolve().then(() => evaluate(code)), insertCSS() {} },
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
  };
  window.__grokbotVncPreload = {
    require: name => { if (name === 'electron') return electron; throw new Error(`Cannot find module '${name}'`); },
    process: { type: 'renderer', platform: 'linux', argv: [], env: {}, versions: {} },
  };
  const ready = () => post({ type: 'ready' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();
