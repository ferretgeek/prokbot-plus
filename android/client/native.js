// Calls into the Android shell. The shell serves these on the page's own origin
// (`/__native/*`); embedded frames have other origins and are refused.
export const boot = globalThis.__grokbotAndroidBoot ?? {};

export async function native(name, body = {}, { binary } = {}) {
  const response = await fetch(`/__native/${name}`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' },
    body: binary ?? JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || value?.ok === false || !value) throw new Error(value?.error ?? `Invalid native response (HTTP ${response.status})`);
  return value;
}

export function log(...parts) {
  const message = parts.map(part => part instanceof Error ? `${part.name}: ${part.message}` :
    typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
  void native('log', { message: message.slice(0, 4000) }).catch(() => {});
}

export function toBase64(input) {
  const bytes = toBytes(input);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('Expected bytes');
}

/** AbortSignal.any with a fallback for older WebView releases. */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function timeout(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  return controller.signal;
}
