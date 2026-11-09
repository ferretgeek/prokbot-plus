// Shared pieces of the three model API formats: errors, SSE, media, reasoning
// provenance and optional-parameter fallback.
import { recordToolCallOrder } from './reliability/tool-order.mjs';

export class ModelRequestError extends Error {
  constructor(message, { status, code, retryAfterMs, cause, param } = {}) {
    super(message, { cause });
    this.name = 'ModelRequestError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.param = param;
  }
}

export function retryAfterMs(headers) {
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  // HTTP-date is the other Retry-After form; reject numeric-looking invalid values.
  if (!/[a-z]/i.test(value)) return undefined;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : undefined;
}

/** Build a ModelRequestError from an OpenAI- or Anthropic-style error payload. */
export function providerError(payload, status, headers, apiKey) {
  const error = payload?.error ?? payload?.response?.error ?? payload;
  let message = typeof error?.message === 'string' ? error.message : `Model request failed${status ? ` (HTTP ${status})` : ''}`;
  // Redact echoed credentials; very short values would only corrupt the message.
  if (apiKey && apiKey.length >= 8) message = message.split(apiKey).join('[redacted]');
  const reportedStatus = error?.status ?? error?.status_code;
  const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code
    : typeof error?.type === 'string' && error.type !== 'error' ? error.type : undefined;
  return new ModelRequestError(message, {
    status: status ?? (Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : undefined),
    code, param: typeof error?.param === 'string' ? error.param : undefined, retryAfterMs: retryAfterMs(headers),
  });
}

export async function errorFromResponse(http, apiKey) {
  let payload;
  try { payload = await http.json(); } catch { payload = undefined; }
  return providerError(payload, http.status, http.headers, apiKey);
}

/** SSE events can cross UTF-8 chunks and use LF, CRLF, or CR line endings. */
export async function* readSse(body) {
  if (!body) throw new ModelRequestError('Model response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', data = [];
  function accept(line) {
    if (line === '') {
      const event = data.length ? data.join('\n') : undefined;
      data = [];
      return event;
    }
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r\n|\r|\n/.exec(pending))) {
        if (!done && match[0] === '\r' && match.index === pending.length - 1) break;
        const line = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const event = accept(line);
        if (event !== undefined) yield event;
      }
      if (done) {
        if (pending) accept(pending);
        const event = accept('');
        if (event !== undefined) yield event;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseEvent(data) {
  try { return JSON.parse(data); }
  catch (cause) { throw new ModelRequestError('Invalid JSON in model SSE event', { cause }); }
}

function bytesToBase64(value) {
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.toString('base64');
}

/** An image or file part as an http(s) URL or a data URL. */
export function mediaUrl(part, fallbackType = 'image/png') {
  const value = part.image ?? part.data ?? part.url;
  const mimeType = part.mimeType ?? fallbackType;
  if (value instanceof URL) return mediaUrl({ ...part, image: value.href }, fallbackType);
  if (typeof value === 'string') {
    if (/^(https?:\/\/|data:)/i.test(value)) return value;
    if (/^[a-z][\w+.-]*:/i.test(value)) throw new TypeError('Unsupported media URL scheme');
    if (!value.trim()) throw new TypeError('Media content is empty');
    return `data:${mimeType};base64,${value}`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `data:${mimeType};base64,${bytesToBase64(value)}`;
  throw new TypeError('Media must contain a URL, base64 string, or bytes');
}

export function parseDataUrl(url) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(url);
  return match ? { mediaType: (match[1] ?? 'application/octet-stream').toLowerCase(), data: match[2] } : null;
}

/** File parts the model APIs read natively: PDFs and plain text. Others become a short note. */
export function fileKind(part) {
  const type = String(part.mimeType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || ['application/json', 'application/xml'].includes(type)) return 'text';
  if (type.startsWith('image/')) return 'image';
  return 'other';
}

export function fileText(part) {
  const url = mediaUrl(part, part.mimeType);
  const parsed = parseDataUrl(url);
  return parsed ? Buffer.from(parsed.data, 'base64').toString('utf8') : url;
}

export function unsupportedFileNote(part) {
  return `[Attached file ${part.filename ?? 'without a name'} (${part.mimeType ?? 'unknown type'}) cannot be read by this model API.]`;
}

export function textValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

export function messageParts(message) {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
}

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** An explicit level from the policy or router; 'default' and 'auto' mean the model default. */
export function explicitEffort(effort) {
  return EFFORT_ORDER.includes(effort) ? effort : undefined;
}

/**
 * Reasoning produced here is tagged with its API format and model. cursor.* mirrors the
 * original Harness convention (it summarizes and replays by modelName); grokbot.* lets
 * each format replay only reasoning it can read.
 */
export function reasoningProviderOptions({ format, model, summarized = false, itemId, emptyThinking = false }) {
  return { cursor: { modelName: model, ...(summarized ? { isAlreadySummarizedThinking: true } : {}) },
    grokbot: { format, model, ...(itemId ? { itemId } : {}), ...(emptyThinking ? { emptyThinking: true } : {}) } };
}

export function reasoningOrigin(part) {
  const own = part.providerOptions?.grokbot ?? part.experimental_providerMetadata?.grokbot;
  const cursor = part.providerOptions?.cursor ?? part.experimental_providerMetadata?.cursor;
  return { format: own?.format, model: own?.model ?? cursor?.modelName, itemId: own?.itemId,
    summarized: cursor?.isAlreadySummarizedThinking === true, phase: own?.phase, emptyThinking: own?.emptyThinking === true };
}

/**
 * Optional request parameters some compatible gateways reject. When a 400 names one of
 * them, the session removes it and retries; the decision is kept for later turns.
 */
export function rejectedOption(error, candidates) {
  if (error?.status !== 400) return undefined;
  const message = String(error.message ?? ''), param = error.param ?? '';
  return candidates.find(name => param === name || param.startsWith(`${name}.`) || param.startsWith(`${name}[`) ||
    new RegExp(`(^|[^\\w.])${name.replace(/[.[\]]/g, '\\$&')}(?![\\w])`).test(message));
}

export function deletePath(object, path) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target || typeof target !== 'object') return;
    target = target[key];
  }
  if (target && typeof target === 'object') delete target[keys.at(-1)];
  if (keys.length > 1) {
    const parent = keys.slice(0, -1).reduce((value, key) => value?.[key], object);
    if (parent && typeof parent === 'object' && !Object.keys(parent).length) deletePath(object, keys.slice(0, -1).join('.'));
  }
}

/**
 * POST with bounded retries. Format fallbacks (replayed reasoning, inline tool images) are
 * checked first, then rejected optional parameters; both decisions persist in `state`.
 */
export async function postWithFallback({ fetchImpl, url, headers, build, signal, apiKey, optional = [], state, fallbacks = [],
  log = message => console.warn(message) }) {
  for (let attempt = 0; ; attempt++) {
    const body = build();
    for (const name of state.dropped) deletePath(body, name);
    const http = await fetchImpl(url, { method: 'POST', headers: typeof headers === 'function' ? headers(body) : headers,
      body: JSON.stringify(body), signal });
    if (http.ok) return { http, body };
    const error = await errorFromResponse(http, apiKey);
    if (attempt < 6) {
      const fallback = fallbacks.find(item => !item.used && item.applies(error, body));
      if (fallback) { fallback.used = true; fallback.apply(); log(`[model] ${new URL(url).host}: ${fallback.name ?? 'fallback'} after HTTP ${error.status ?? 'error'}`); continue; }
      const option = rejectedOption(error, optional.filter(name => !state.dropped.has(name)));
      if (option) { state.dropped.add(option); log(`[model] ${new URL(url).host}: retrying without ${option}`); continue; }
    }
    throw error;
  }
}

/** A 400 about reasoning that was replayed from an earlier turn. */
export function replayRejected(error) {
  // Gateways join words with underscores (native_thinking_replay_mismatch): no word boundaries.
  return error?.status === 400 && /signature|thinking|encrypted|reasoning/i.test(`${error.message ?? ''} ${error.code ?? ''}`);
}

export function serializeToolCalls(calls) {
  // Calls are handed over together, so remember the written order of user-visible messages.
  recordToolCallOrder(calls);
  const parts = [];
  for (const call of calls) {
    // The original Harness consumes one argument stream at a time; serialize parallel calls.
    parts.push({ type: 'tool-call-streaming-start', toolCallId: call.toolCallId, toolName: call.toolName });
    parts.push({ type: 'tool-call-delta', toolCallId: call.toolCallId, toolName: call.toolName, argsTextDelta: JSON.stringify(call.args) });
    parts.push(call);
  }
  return parts;
}

export function parseToolArguments(name, text) {
  try { return JSON.parse(text || '{}'); }
  catch (cause) { throw new ModelRequestError(`Invalid tool arguments for ${name}`, { cause }); }
}

/** JSON Schema of a Harness tool. */
export function toolSchema(tool) {
  if (tool.type === 'provider-defined' || tool.customToolFormat) throw new TypeError('This session supports JSON function tools only');
  if (typeof tool.name !== 'string' || !tool.name) throw new TypeError('Tool name is required');
  const parameters = tool.parameters?.jsonSchema ?? tool.parameters;
  if (!parameters || typeof parameters !== 'object') throw new TypeError('Tool schema is required');
  return { name: tool.name, description: tool.description ?? '', parameters };
}
