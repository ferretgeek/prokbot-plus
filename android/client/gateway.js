// Host access for the workspace, ported from mac/clients/desktop/gateway.mjs and
// streams.mjs. Requests go to the page's own origin; the Android shell forwards
// them to the paired Host and adds the device credential, which the page never holds.
import { grokText } from './desktop/i18n.mjs';
import { anySignal, timeout } from './native.js';

export async function readSse(body, consume) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw new Error('事件超过大小限制');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = block.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        await consume({ data: JSON.parse(data),
          id: lines.find(line => line.startsWith('id:'))?.slice(3).trim(),
          event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() });
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function subscribe(endpoint, consume, signal, options = {}) {
  let failures = 0, lastId = options.lastId ?? '';
  while (!signal.aborted) {
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => request.abort(), 15000);
    try {
      const response = await fetch(endpoint, {
        headers: lastId ? { 'Last-Event-ID': lastId } : {},
        signal: request.signal, redirect: 'error', credentials: 'same-origin', cache: 'no-store',
      });
      clearTimeout(timer);
      if (response.status === 401) { options.onUnauthorized?.(); return; }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      failures = 0;
      options.onConnected?.();
      await readSse(response.body, async frame => {
        await consume(frame);
        if (frame.id) lastId = frame.id;
      });
      throw new Error('事件连接结束');
    } catch {
      if (signal.aborted) return;
      options.onDisconnected?.();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      request.abort();
    }
    try { await wait(Math.min(500 * 2 ** Math.min(failures++, 4), 10000), signal); }
    catch { return; }
  }
}

export function createGateway({ onUnauthorized, onConnected, onStateChanged } = {}) {
  const lifetime = new AbortController();
  const streams = new Set();
  let state = 'connecting';
  const updateState = value => { if (state !== value) { state = value; onStateChanged?.(value); } };
  const closed = () => new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));

  async function request(endpoint, args, signal, method = 'POST') {
    if (lifetime.signal.aborted) throw closed();
    const response = await fetch(endpoint, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(args ?? {}) }),
      signal: signal ? anySignal([signal, lifetime.signal]) : lifetime.signal,
    });
    if (response.status === 401) onUnauthorized?.();
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.message ?? value?.error ?? `HTTP ${response.status}`),
      { httpStatus: response.status, failureCode: value?.failureCode });
    return value;
  }

  async function command(method, args = {}, signal) {
    if (lifetime.signal.aborted) throw closed();
    if (method === 'getServerAgentRoster') return { status: 'disabled' };
    if (method === 'getMainAgent') return { agentId: null };
    if (method === 'resolveAgentCreation') return { kind: 'box' };
    if (method === 'restoreTemporalAgentRouting' || method === 'noteMountedAgent') return null;
    if (method === 'createAgent') { const { creationRoute, ...rest } = args ?? {}; args = rest; }
    return request(`/api/${encodeURIComponent(method)}`, args, signal);
  }

  /** Serves the original coordinator protocol on a MessagePort from the renderer. */
  function attach(port) {
    const controller = new AbortController();
    if (lifetime.signal.aborted) { port.close(); return () => {}; }
    let subscribed = false, generation = 0;
    const send = frame => { if (!controller.signal.aborted) port.postMessage(frame); };
    const emit = (family, payload) => send({ kind: 'event', family, payload });
    const receive = async ({ data: frame }) => {
      if (!frame || controller.signal.aborted) return;
      if (frame.kind === 'lifecycle' && frame.phase === 'hello') {
        send({ kind: 'lifecycle', phase: 'ready', protocolVersion: 3 });
        if (!subscribed) {
          subscribed = true;
          void subscribe('/events', ({ data }) => {
            if (data.channel) emit(data.channel, data.payload);
          }, controller.signal, {
            onConnected: () => { streams.add(controller); updateState('online'); emit('transport-connected', { generation: ++generation }); onConnected?.(); },
            onDisconnected: () => { streams.delete(controller); if (!streams.size) updateState('reconnecting'); emit('transport-down', { generation, reason: 'stream-error', cause: null }); },
            onUnauthorized,
          });
        }
      } else if (frame.kind === 'request') {
        try {
          send({ kind: 'reply', requestId: frame.requestId,
            outcome: { status: 'ok', value: await command(frame.method, frame.args, controller.signal) } });
        } catch (error) {
          send({ kind: 'reply', requestId: frame.requestId, outcome: { status: 'failed', failure: {
            code: 'gateway-command-failed', message: error.message,
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
            ...(error.failureCode ? { failureCode: error.failureCode } : {}),
          } } });
        }
      }
    };
    const listener = event => { void receive(event); };
    const cleanup = () => {
      controller.abort(); streams.delete(controller);
      lifetime.signal.removeEventListener('abort', cleanup);
      port.removeEventListener('message', listener);
      if (!streams.size && !lifetime.signal.aborted) updateState('reconnecting');
    };
    lifetime.signal.addEventListener('abort', cleanup, { once: true });
    port.addEventListener('message', listener);
    port.addEventListener('close', cleanup);
    port.start();
    return () => { cleanup(); port.close(); };
  }

  return { command, request, attach, getState: () => state,
    close: () => { lifetime.abort(); updateState('disconnected'); } };
}

export { timeout };
