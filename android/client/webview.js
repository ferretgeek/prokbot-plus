// Electron <webview> for the Bot computer view, rebuilt on an iframe.
//
// The original renderer shows the remote desktop (noVNC served by the Host) in a
// <webview> and talks to it through executeJavaScript, send, insertCSS and
// "ipc-message" events. Android WebView has no <webview>, so each one gets an
// iframe on the shell's separate desktop origin. The shell injects vnc-bridge.js
// into that page, which runs the original VNC preload and answers these calls
// over postMessage. Only /vnc/ addresses of the paired Host are loaded.
import { log } from './native.js';

const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-modals';

export function mapDesktopSource(src, { hostOrigin, vncOrigin, base = location.href }) {
  try {
    const url = new URL(src, base);
    const known = [hostOrigin, vncOrigin, new URL(base).origin].filter(Boolean);
    if (!known.includes(url.origin) || !/^\/vnc\/(desktop|fork)\//.test(url.pathname)) return null;
    const local = new URL(url.pathname + url.search, vncOrigin);
    // The page is plain HTTP on the phone even when the Host itself uses HTTPS.
    local.searchParams.set('encrypt', '0');
    return local.href;
  } catch {
    return null;
  }
}

export function installWebviewFrames({ hostOrigin, vncOrigin }) {
  const frames = new Map();
  let nextId = 1;
  const pending = new Map();

  addEventListener('message', event => {
    if (event.origin !== vncOrigin || !event.data || event.data.grokbotWebview !== 1) return;
    const element = frames.get(event.source);
    if (!element) return;
    const message = event.data;
    if (message.type === 'result') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error || 'Script failed'));
    } else if (message.type === 'ipc') {
      const ipc = new Event('ipc-message');
      ipc.channel = message.channel;
      ipc.args = Array.isArray(message.args) ? message.args : [];
      element.dispatchEvent(ipc);
    } else if (message.type === 'ready') {
      element.__grokbotReady = true;
      element.dispatchEvent(new Event('dom-ready'));
    }
  });

  const post = (element, message) => {
    const target = element.__grokbotFrame?.contentWindow;
    if (!target || !element.__grokbotReady) return false;
    target.postMessage({ grokbotWebview: 1, ...message }, vncOrigin);
    return true;
  };

  function upgrade(element) {
    if (element.__grokbotFrame) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.className = 'grokbot-webview-frame';
    element.__grokbotFrame = frame;
    element.__grokbotReady = false;

    const sync = () => {
      const src = element.getAttribute('src');
      const target = src ? mapDesktopSource(src, { hostOrigin, vncOrigin }) : null;
      if (src && !target) log('[webview] blocked source', new URL(src, location.href).pathname);
      const next = target ?? 'about:blank';
      if (frame.dataset.src === next) return;
      frame.dataset.src = next;
      element.__grokbotReady = false;
      frame.src = next;
    };
    frame.addEventListener('load', () => {
      if (frame.dataset.src === 'about:blank') return;
      // The bridge also reports DOM readiness; a page that failed to load never does.
      setTimeout(() => {
        if (!element.__grokbotReady) {
          const failed = new Event('did-fail-load');
          failed.errorCode = -2;
          element.dispatchEvent(failed);
          return;
        }
        element.dispatchEvent(new Event('did-finish-load'));
      }, 0);
    });

    Object.assign(element, {
      reload() {
        const current = frame.dataset.src;
        element.__grokbotReady = false;
        frame.dataset.src = 'about:blank';
        frame.src = 'about:blank';
        setTimeout(() => { frame.dataset.src = current; frame.src = current; }, 0);
      },
      isCrashed: () => false,
      getURL: () => frame.dataset.src ?? '',
      executeJavaScript(code) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out')); }, 15000);
          pending.set(id, { resolve, reject, timer });
          if (!post(element, { type: 'exec', id, code: String(code) })) {
            clearTimeout(timer); pending.delete(id); reject(new Error('Not ready'));
          }
        });
      },
      send(channel, ...args) {
        post(element, { type: 'send', channel: String(channel), args });
        return Promise.resolve();
      },
      insertCSS(css) {
        post(element, { type: 'css', css: String(css) });
        return Promise.resolve('');
      },
    });
    element.append(frame);
    // The WindowProxy of an iframe stays the same across its navigations.
    frames.set(frame.contentWindow, element);
    new MutationObserver(sync).observe(element, { attributes: true, attributeFilter: ['src'] });
    sync();
  }

  const scan = node => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.localName === 'webview') upgrade(node);
    node.querySelectorAll?.('webview').forEach(upgrade);
  };
  new MutationObserver(records => {
    for (const record of records) record.addedNodes.forEach(scan);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan(document.documentElement);
}
