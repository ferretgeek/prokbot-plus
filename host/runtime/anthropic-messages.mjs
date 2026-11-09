// Anthropic Messages API format for the configured model.
// The original Harness speaks AI SDK CoreMessages; this module translates them to
// POST /v1/messages and back, keeping images, documents, tool results and signed thinking.
import { explicitEffort, fileKind, fileText, mediaUrl, messageParts, ModelRequestError, parseDataUrl, parseEvent,
  parseToolArguments, postWithFallback, providerError, readSse, reasoningOrigin, reasoningProviderOptions, replayRejected,
  serializeToolCalls, textValue, toolSchema, unsupportedFileNote } from './model-common.mjs';

export const FORMAT = 'anthropic';
export const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const INTERLEAVED_BETA = 'interleaved-thinking-2025-05-14';
const BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32000 };

/** Accept a host, a /v1 root or the full /v1/messages URL. */
export function anthropicEndpoint(baseUrl, resource = 'messages') {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/messages')) path = path.slice(0, -'/messages'.length);
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = `${path}/${resource}`;
  url.search = ''; url.hash = '';
  return url.href;
}

/**
 * Thinking controls differ by generation: Claude 4.6 and later think adaptively and take
 * an effort level; Claude 3.7 to 4.5 take a thinking budget (Opus 4.5 also takes effort).
 */
export function claudeTraits(model) {
  const id = String(model).toLowerCase();
  const modern = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?![\d.])/.exec(id);
  const old = /claude-(\d)-(\d)-(opus|sonnet|haiku)/.exec(id);
  const family = modern?.[1] ?? old?.[3];
  const version = modern ? Number(modern[2]) + Number(modern[3] ?? 0) / 10 : old ? Number(old[1]) + Number(old[2]) / 10 : NaN;
  if (!family || !Number.isFinite(version)) return { known: false, adaptive: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], disable: 'disabled', budget: false, maxOutput: 64_000 };
  const adaptive = version >= 4.6;
  const efforts = adaptive ? ['low', 'medium', 'high', ...(version >= 4.7 ? ['xhigh'] : []), 'max']
    : family === 'opus' && version === 4.5 ? ['low', 'medium', 'high'] : [];
  // How "no thinking" is expressed: never for always-thinking models.
  const disable = ['fable', 'mythos'].includes(family) || (family === 'opus' && version >= 5.5) ? 'never'
    : family === 'sonnet' && version >= 5.5 ? 'between_tools' : adaptive ? 'disabled' : 'omit';
  return { known: true, family, version, adaptive, efforts, disable, budget: !adaptive && version >= 3.7,
    maxOutput: adaptive ? 128_000 : family === 'opus' && version < 4.5 ? 32_000 : 64_000,
    fallbacks: /^claude-(?:opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/.test(id) };
}

/** The closest supported level: minimal maps to low, unsupported upper levels step down. */
function supportedEffort(level, efforts) {
  if (!level || !efforts.length) return undefined;
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  let index = order.indexOf(level === 'minimal' ? 'low' : level);
  while (index >= 0 && !efforts.includes(order[index])) index--;
  return index >= 0 ? order[index] : efforts[0];
}

/** Request parameters shared by chat, test and review requests. */
export function anthropicOptions(model, { effort, maxTokens } = {}) {
  const traits = claudeTraits(model), level = explicitEffort(effort);
  let limit = Number.isSafeInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, traits.maxOutput) : Math.min(64_000, traits.maxOutput);
  const options = {};
  if (level === 'none' && traits.disable !== 'never') {
    if (traits.disable === 'disabled' || traits.disable === 'between_tools') options.thinking = { type: traits.disable };
  } else if (traits.adaptive) {
    options.thinking = { type: 'adaptive', display: 'summarized' };
    const supported = supportedEffort(level === 'none' ? 'low' : level, traits.efforts);
    if (supported) options.output_config = { effort: supported };
  } else if (traits.budget && level && level !== 'none') {
    limit = Math.max(limit, Math.min(traits.maxOutput, BUDGETS[level] + 4096));
    options.thinking = { type: 'enabled', budget_tokens: Math.max(1024, Math.min(BUDGETS[level], limit - 2048)) };
    const supported = supportedEffort(level, traits.efforts);
    if (supported) options.output_config = { effort: supported };
  }
  if (traits.fallbacks) options.fallbacks = 'default';
  return { max_tokens: limit, ...options };
}

export function anthropicHeaders(apiKey, { stream = false, body = {} } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION });
  if (stream) headers.set('accept', 'text/event-stream');
  if (apiKey) headers.set('x-api-key', apiKey);
  const betas = [...(body.fallbacks ? [FALLBACK_BETA] : []), ...(body.thinking?.type === 'enabled' ? [INTERLEAVED_BETA] : [])];
  if (betas.length) headers.set('anthropic-beta', betas.join(','));
  return headers;
}

function source(url) {
  const parsed = parseDataUrl(url);
  if (parsed) return { type: 'base64', media_type: parsed.mediaType, data: parsed.data };
  if (/^https?:\/\//i.test(url)) return { type: 'url', url };
  throw new TypeError('Unsupported media URL');
}

function userBlock(part) {
  if (part.type === 'text') return part.text ? { type: 'text', text: part.text } : null;
  if (part.type === 'image') return { type: 'image', source: source(mediaUrl(part)) };
  if (part.type === 'file') {
    const kind = fileKind(part);
    if (kind === 'image') return { type: 'image', source: source(mediaUrl(part, part.mimeType)) };
    if (kind === 'pdf') return { type: 'document', source: source(mediaUrl(part, part.mimeType)), ...(part.filename ? { title: part.filename } : {}) };
    if (kind === 'text') return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: fileText(part) }, ...(part.filename ? { title: part.filename } : {}) };
    return { type: 'text', text: unsupportedFileNote(part) };
  }
  throw new TypeError(`Unsupported user content type: ${part.type}`);
}

/** Thinking that Anthropic wrote; other formats' reasoning is not replayed here. */
function anthropicReasoning(part) {
  const origin = reasoningOrigin(part);
  if (origin.format) return origin.format === FORMAT;
  if (part.type === 'reasoning') return Boolean(part.signature) && !origin.summarized;
  return !origin.model || /claude/i.test(origin.model);
}

/**
 * Convert CoreMessages. Signed thinking is replayed only when every Anthropic reasoning
 * part still carries its signature; otherwise all thinking is stripped, which the API
 * accepts, instead of sending a history with blocks missing from the middle.
 */
export function convertAnthropicMessages(messages, { stripThinking = false } = {}) {
  const reasoningParts = messages.filter(message => message.role === 'assistant' && Array.isArray(message.content))
    .flatMap(message => message.content.filter(part => (part.type === 'reasoning' || part.type === 'redacted-reasoning') && anthropicReasoning(part)));
  const replayThinking = !stripThinking && reasoningParts.every(part =>
    part.type === 'redacted-reasoning' ? typeof part.data === 'string' && part.data : typeof part.signature === 'string' && part.signature);
  const system = [], output = [];
  let leading = true;
  const push = (role, content) => {
    const blocks = content.filter(Boolean);
    if (!blocks.length) return;
    const previous = output.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else output.push({ role, content: blocks });
  };
  for (const message of messages) {
    const parts = messageParts(message);
    if (message.role === 'system' || message.role === 'developer') {
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
      if (!text) continue;
      if (leading) system.push({ type: 'text', text });
      // Later operator text stays in order as user-visible context.
      else push('user', [{ type: 'text', text: `<system-message>\n${text}\n</system-message>` }]);
      continue;
    }
    leading = false;
    if (message.role === 'user') {
      push('user', parts.map(userBlock));
    } else if (message.role === 'assistant') {
      push('assistant', parts.map(part => {
        if (part.type === 'text') return part.text ? { type: 'text', text: part.text } : null;
        if (part.type === 'reasoning') return replayThinking && anthropicReasoning(part) ? { type: 'thinking', thinking: part.text ?? '', signature: part.signature } : null;
        if (part.type === 'redacted-reasoning') {
          if (!replayThinking || !anthropicReasoning(part)) return null;
          return reasoningOrigin(part).emptyThinking ? { type: 'thinking', thinking: '', signature: part.data } : { type: 'redacted_thinking', data: part.data };
        }
        if (part.type === 'tool-call') return { type: 'tool_use', id: part.toolCallId, name: part.toolName,
          input: typeof part.args === 'string' ? JSON.parse(part.args || '{}') : part.args ?? {} };
        return null;
      }));
    } else if (message.role === 'tool') {
      push('user', parts.map(part => {
        if (part.type !== 'tool-result' || !part.toolCallId) throw new TypeError('Tool messages require tool-result parts and toolCallId');
        const extra = part.experimental_content ?? [];
        const text = part.result === undefined
          ? extra.filter(item => item.type === 'text').map(item => item.text).join('\n') : textValue(part.result);
        const content = [...(text ? [{ type: 'text', text }] : []),
          ...extra.filter(item => item.type === 'image').map(item => ({ type: 'image', source: source(mediaUrl(item)) }))];
        return { type: 'tool_result', tool_use_id: part.toolCallId, content: content.length ? content : [{ type: 'text', text: '(empty)' }],
          ...(part.isError ? { is_error: true } : {}) };
      }));
    } else {
      throw new TypeError(`Unsupported message role: ${message.role}`);
    }
  }
  // Tool results must lead the user turn that answers a tool call.
  for (const message of output) {
    if (message.role === 'user') message.content.sort((a, b) => (a.type === 'tool_result' ? 0 : 1) - (b.type === 'tool_result' ? 0 : 1));
  }
  if (output[0]?.role === 'assistant') output.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  // Two cache breakpoints: tools + system, and the whole history for the next turn.
  if (system.length) system.at(-1).cache_control = { type: 'ephemeral' };
  const lastBlock = output.at(-1)?.content.at(-1);
  if (lastBlock && ['text', 'image', 'document', 'tool_result'].includes(lastBlock.type)) lastBlock.cache_control = { type: 'ephemeral' };
  return { system, messages: output, replayedThinking: replayThinking && reasoningParts.length > 0 };
}

export function convertAnthropicTools(tools = []) {
  return tools.map(tool => {
    const { name, description, parameters } = toolSchema(tool);
    return { name, description, input_schema: parameters };
  });
}

/** Normalize Anthropic usage to the OpenAI-style fields the usage ledger records. */
export function anthropicUsage(raw = {}) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const uncached = count(raw.input_tokens), cacheRead = count(raw.cache_read_input_tokens),
    cacheWrite = count(raw.cache_creation_input_tokens), output = count(raw.output_tokens);
  const input = uncached + cacheRead + cacheWrite;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: cacheRead }, cache_creation_input_tokens: cacheWrite,
    completion_tokens_details: { reasoning_tokens: count(raw.output_tokens_details?.thinking_tokens) } };
}

/** True for a 400 caused by thinking blocks that no longer match their conversation. */
export function isThinkingReplayError(status, message) {
  return replayRejected({ status, message });
}

const OPTIONAL = ['fallbacks', 'thinking.display', 'output_config'];

/** One streamed Messages API turn; yields Harness stream parts and returns the assembled message. */
export async function* anthropicTurn(context) {
  const { fetchImpl, endpoint, apiKey, headers, model, messages, tools, effort, maxTokens, signal, state,
    notifyRequest, onModel, onId, onUsage } = context;
  const anthropicTools = convertAnthropicTools(tools);
  let replayed = false;
  const { http } = await postWithFallback({ fetchImpl, url: endpoint, apiKey, signal, state, optional: OPTIONAL,
    headers: body => {
      const value = anthropicHeaders(apiKey, { stream: true, body });
      for (const [key, entry] of new Headers(headers)) value.set(key, entry);
      return value;
    },
    // Signed thinking from an edited or summarized history: retry without it.
    fallbacks: [{ name: 'retry without replayed thinking', applies: error => replayed && replayRejected(error), apply: () => { state.stripReasoning = true; } }],
    build: () => {
      const converted = convertAnthropicMessages(messages, { stripThinking: state.stripReasoning });
      replayed = converted.replayedThinking;
      return { model, ...anthropicOptions(model, { effort, maxTokens }), stream: true,
        ...(converted.system.length ? { system: converted.system } : {}), messages: converted.messages,
        ...(anthropicTools.length ? { tools: anthropicTools } : {}) };
    } });
  notifyRequest(http.headers.get('request-id') ?? http.headers.get('x-request-id'));
  let id, responseModel = model, stopReason, stopDetails, stopped = false;
  const rawUsage = {}, blocks = new Map();
  const reasoningOptions = () => ({ providerOptions: reasoningProviderOptions({ format: FORMAT, model: responseModel }) });
  const emptyOptions = () => ({ providerOptions: reasoningProviderOptions({ format: FORMAT, model: responseModel, emptyThinking: true }) });
  const mergeUsage = usage => {
    if (!usage) return;
    for (const [key, value] of Object.entries(usage)) if (value !== null && value !== undefined) rawUsage[key] = value;
    onUsage(anthropicUsage(rawUsage));
  };
  for await (const data of readSse(http.body)) {
    signal.throwIfAborted();
    const event = parseEvent(data);
    if (event.type === 'error') throw providerError(event, undefined, http.headers, apiKey);
    if (event.type === 'message_start') {
      const message = event.message ?? {};
      if (message.id) { id = message.id; onId(id); notifyRequest(id); }
      if (message.model) { responseModel = message.model; onModel(responseModel); }
      mergeUsage(message.usage);
    } else if (event.type === 'content_block_start') {
      const block = event.content_block ?? {};
      if (block.type === 'text') {
        blocks.set(event.index, { type: 'text', text: block.text ?? '' });
        if (block.text) yield { type: 'text-delta', textDelta: block.text };
      } else if (block.type === 'thinking') {
        blocks.set(event.index, { type: 'reasoning', text: block.thinking ?? '', signature: block.signature ?? '' });
        if (block.thinking) yield { type: 'reasoning', textDelta: block.thinking, ...reasoningOptions() };
      } else if (block.type === 'redacted_thinking') {
        blocks.set(event.index, { type: 'redacted-reasoning', data: block.data ?? '' });
        if (block.data) yield { type: 'redacted-reasoning', data: block.data, ...reasoningOptions() };
      } else if (block.type === 'tool_use') {
        blocks.set(event.index, { type: 'tool-use', id: block.id ?? '', name: block.name ?? '', json: '' });
      }
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index), delta = event.delta ?? {};
      if (!block) continue;
      if (delta.type === 'text_delta' && block.type === 'text' && delta.text) {
        block.text += delta.text;
        yield { type: 'text-delta', textDelta: delta.text };
      } else if (delta.type === 'thinking_delta' && block.type === 'reasoning' && delta.thinking) {
        block.text += delta.thinking;
        yield { type: 'reasoning', textDelta: delta.thinking, ...reasoningOptions() };
      } else if (delta.type === 'signature_delta' && block.type === 'reasoning') {
        block.signature += delta.signature ?? '';
      } else if (delta.type === 'input_json_delta' && block.type === 'tool-use') {
        block.json += delta.partial_json ?? '';
      }
    } else if (event.type === 'content_block_stop') {
      const block = blocks.get(event.index);
      // The Harness keeps reasoning only with readable text; a signed block without text
      // travels as a redacted part holding its signature and is restored on replay.
      if (block?.type === 'reasoning' && block.signature) {
        if (block.text) yield { type: 'reasoning-signature', signature: block.signature };
        else yield { type: 'redacted-reasoning', data: block.signature, ...emptyOptions() };
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      if (event.delta?.stop_details) stopDetails = event.delta.stop_details;
      mergeUsage(event.usage);
    } else if (event.type === 'message_stop') {
      stopped = true;
      break;
    }
  }
  signal.throwIfAborted();
  if (!stopped && !stopReason) throw new ModelRequestError('Model SSE stream ended before a completion marker');
  if (stopReason === 'max_tokens') throw new ModelRequestError('Model response stopped with max_tokens', { code: 'length' });
  if (stopReason === 'model_context_window_exceeded') throw new ModelRequestError('Model context window exceeded', { code: 'context_length_exceeded' });
  if (stopReason === 'refusal') {
    const category = stopDetails?.category ? ` (${stopDetails.category})` : '';
    throw new ModelRequestError(`Model declined this request${category}`, { code: 'content_filter' });
  }
  const content = [], calls = [];
  for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    if (block.type === 'text') { if (block.text) content.push(block); continue; }
    if (block.type === 'reasoning' && !block.text) {
      if (block.signature) content.push({ type: 'redacted-reasoning', data: block.signature, ...emptyOptions() });
      continue;
    }
    if (block.type === 'reasoning' || block.type === 'redacted-reasoning') { content.push({ ...block, ...reasoningOptions() }); continue; }
    if (!block.id || !block.name) throw new ModelRequestError('Incomplete model tool call identity');
    const call = { type: 'tool-call', toolCallId: block.id, toolName: block.name, args: parseToolArguments(block.name, block.json) };
    calls.push(call); content.push(call);
  }
  yield* serializeToolCalls(calls);
  return { id, model: responseModel, content, toolCalls: calls.length, usage: anthropicUsage(rawUsage) };
}
