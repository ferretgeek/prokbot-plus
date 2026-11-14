import { setTimeout as delay } from 'node:timers/promises';

const FIRST_RETRY_MS = 500, MAX_RETRY_MS = 10000, STABLE_STREAM_MS = 30000;

export async function readSse(body, consume) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
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
}

export async function subscribe(config, endpoint, consume, signal, options = {}) {
  let retryMs = FIRST_RETRY_MS, lastId = options.lastId ?? '';
  while (!signal.aborted) {
    let openedAt;
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => request.abort(), 15000);
    try {
      signal.throwIfAborted();
      const response = await fetch(`${config.server}${endpoint}`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${config.token}`, ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
        signal: request.signal, redirect: 'error',
      });
      clearTimeout(timeout);
      request.signal.throwIfAborted();
      if (response.status === 401) { options.onUnauthorized?.(); return; }
      if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'text/event-stream') throw new Error('Expected a text/event-stream response');
      openedAt = performance.now();
      options.onConnected?.();
      await readSse(response.body, async frame => {
        request.signal.throwIfAborted();
        await consume(frame);
        if (frame.id !== undefined && !frame.id.includes('\0')) lastId = frame.id;
      });
      throw new Error('事件连接结束');
    } catch (error) {
      if (signal.aborted) return;
      // A proxy can repeatedly send 200 and close, even after an initial snapshot.
      if (openedAt !== undefined && performance.now() - openedAt >= STABLE_STREAM_MS) retryMs = FIRST_RETRY_MS;
      options.onDisconnected?.(error);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      request.abort();
    }
    try { await delay(retryMs, undefined, { signal }); }
    catch { return; }
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }
}
