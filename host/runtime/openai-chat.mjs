// OpenAI Chat Completions format (OpenAI and compatible services such as DeepSeek).
import { explicitEffort, fileKind, fileText, mediaUrl, messageParts, ModelRequestError, parseEvent, parseToolArguments,
  postWithFallback, readSse, reasoningOrigin, reasoningProviderOptions, serializeToolCalls, textValue, toolSchema,
  unsupportedFileNote } from './model-common.mjs';

export const FORMAT = 'openai';

export function chatEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

// Reasoning models of OpenAI take max_completion_tokens; most compatible servers take max_tokens.
const COMPLETION_TOKENS = /^(?:o\d|gpt-5|gpt-6|gpt-4\.1|codex)/i;
export function maxTokensParameter(model, dropped = new Set()) {
  const preferred = COMPLETION_TOKENS.test(model) ? 'max_completion_tokens' : 'max_tokens';
  const other = preferred === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  return !dropped.has(preferred) ? preferred : !dropped.has(other) ? other : undefined;
}

/** Chat reasoning parameters: reasoning_effort, plus DeepSeek's thinking switch. */
export function chatReasoning(model, effort) {
  const level = explicitEffort(effort);
  if (!level) return {};
  return { reasoning_effort: level, ...(/deepseek/i.test(model) ? { thinking: { type: level === 'none' ? 'disabled' : 'enabled' } } : {}) };
}

function contentPart(part, role) {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'image' && role === 'user') return { type: 'image_url', image_url: { url: mediaUrl(part) } };
  if (part.type === 'file' && role === 'user') {
    const kind = fileKind(part);
    if (kind === 'image') return { type: 'image_url', image_url: { url: mediaUrl(part, part.mimeType) } };
    if (kind === 'pdf') return { type: 'file', file: { filename: part.filename ?? 'document.pdf', file_data: mediaUrl(part, part.mimeType) } };
    if (kind === 'text') return { type: 'text', text: `${part.filename ? `${part.filename}:\n` : ''}${fileText(part)}` };
    return { type: 'text', text: unsupportedFileNote(part) };
  }
  throw new TypeError(`Unsupported ${role} content type: ${part.type}`);
}

/**
 * Translate CoreMessages without losing screenshots. reasoning_content is replayed only for
 * reasoning this format produced for the same model (DeepSeek needs it during tool use).
 */
export function convertChatMessages(messages, { model, replayReasoning = true } = {}) {
  const output = [];
  let toolImages = [];
  const flushToolImages = () => {
    if (!toolImages.length) return;
    output.push({ role: 'user', content: [{ type: 'text', text: 'Screenshots from the preceding tool results:' }, ...toolImages] });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') flushToolImages();
    const parts = messageParts(message);
    if (message.role === 'tool') {
      for (const part of parts) {
        if (part.type !== 'tool-result' || !part.toolCallId) throw new TypeError('Tool messages require tool-result parts and toolCallId');
        const extra = part.experimental_content ?? [];
        const fallback = extra.filter(p => p.type === 'text').map(p => p.text).join('\n');
        output.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.result === undefined ? fallback : textValue(part.result) });
        toolImages.push(...extra.filter(p => p.type === 'image').map(p => ({ type: 'image_url', image_url: { url: mediaUrl(p) } })));
      }
    } else if (message.role === 'assistant') {
      const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
      const reasoning = replayReasoning ? parts.filter(p => {
        if (p.type !== 'reasoning' || !p.text) return false;
        const origin = reasoningOrigin(p);
        // Legacy parts carry no origin; signed parts belong to another API format.
        return origin.format ? origin.format === FORMAT && (!model || origin.model === model) : !p.signature;
      }).map(p => p.text).join('') : '';
      const calls = parts.filter(p => p.type === 'tool-call').map(p => ({
        id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: textValue(p.args ?? {}) } }));
      output.push({ role: 'assistant', content: content || (calls.length ? null : ''),
        ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (['user', 'system', 'developer'].includes(message.role)) {
      const content = parts.map(part => contentPart(part, message.role));
      output.push({ role: message.role, content: content.every(p => p.type === 'text') ? content.map(p => p.text).join('') : content });
    } else {
      throw new TypeError(`Unsupported message role: ${message.role}`);
    }
  }
  flushToolImages();
  return output;
}

export function convertChatTools(tools = []) {
  return tools.map(tool => {
    const { name, description, parameters } = toolSchema(tool);
    return { type: 'function', function: { name, description, parameters } };
  });
}

const OPTIONAL = ['stream_options', 'reasoning_effort', 'thinking', 'max_tokens', 'max_completion_tokens', 'reasoning_content'];

/** One streamed Chat Completions turn; yields Harness stream parts, returns the assembled message. */
export async function* chatTurn(context) {
  const { fetchImpl, endpoint, apiKey, headers, model, messages, tools, effort, maxTokens, requestOptions, signal, state,
    notifyRequest, onModel, onId, onUsage } = context;
  const functions = convertChatTools(tools);
  const { http } = await postWithFallback({ fetchImpl, url: endpoint, apiKey, signal, state, optional: OPTIONAL,
    headers: () => {
      const value = new Headers(headers);
      value.set('content-type', 'application/json');
      value.set('accept', 'text/event-stream');
      if (apiKey) value.set('authorization', `Bearer ${apiKey}`);
      return value;
    },
    build: () => {
      const limit = maxTokens === undefined ? undefined : maxTokensParameter(model, state.dropped);
      return { ...requestOptions, ...chatReasoning(model, effort), model,
        messages: convertChatMessages(messages, { model, replayReasoning: !state.dropped.has('reasoning_content') }),
        stream: true, stream_options: { ...requestOptions?.stream_options, include_usage: true },
        ...(functions.length ? { tools: functions } : {}), ...(limit ? { [limit]: maxTokens } : {}) };
    } });
  notifyRequest(http.headers.get('x-request-id') ?? http.headers.get('request-id'));
  let id, responseModel = model, text = '', reasoning = '', rawUsage = {}, finishReason, receivedChoice = false, receivedDone = false;
  const toolCalls = new Map(), options = () => ({ providerOptions: reasoningProviderOptions({ format: FORMAT, model: responseModel }) });
  for await (const data of readSse(http.body)) {
    signal.throwIfAborted();
    if (data.trim() === '[DONE]') { receivedDone = true; break; }
    const chunk = parseEvent(data);
    if (chunk.error) throw new ModelRequestError(chunk.error.message ?? 'Model stream failed', { code: chunk.error.code ?? chunk.error.type });
    if (chunk.id) { id = chunk.id; onId(id); notifyRequest(id); }
    if (chunk.model) { responseModel = chunk.model; onModel(responseModel); }
    if (chunk.usage) { rawUsage = { ...rawUsage, ...chunk.usage }; onUsage(rawUsage); }
    const choice = chunk.choices?.find(item => (item.index ?? 0) === 0);
    if (!choice) continue;
    receivedChoice = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    // DeepSeek and Qwen use reasoning_content; OpenRouter and vLLM use reasoning.
    const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (thought) { reasoning += thought; yield { type: 'reasoning', textDelta: thought, ...options() }; }
    for (const value of [delta.content, delta.refusal]) {
      if (typeof value === 'string' && value) { text += value; yield { type: 'text-delta', textDelta: value }; }
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? 0;
      const call = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (part.id) call.id += part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      toolCalls.set(index, call);
    }
  }
  signal.throwIfAborted();
  if (!receivedChoice || (!receivedDone && !finishReason)) throw new ModelRequestError('Model SSE stream ended before a completion marker');
  if (finishReason === 'length' || finishReason === 'content_filter') {
    throw new ModelRequestError(`Model response stopped with ${finishReason}`, { code: finishReason });
  }
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning, ...options() });
  if (text) content.push({ type: 'text', text });
  const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
    if (!call.id || !call.name) throw new ModelRequestError('Incomplete model tool call identity');
    return { type: 'tool-call', toolCallId: call.id, toolName: call.name, args: parseToolArguments(call.name, call.arguments) };
  });
  yield* serializeToolCalls(calls);
  content.push(...calls);
  return { id, model: responseModel, content, toolCalls: calls.length, usage: rawUsage };
}
