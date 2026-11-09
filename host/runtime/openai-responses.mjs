// OpenAI Responses format (POST /v1/responses), used statelessly: store=false, with
// encrypted reasoning carried in the conversation instead of on the server.
import { createHash } from 'node:crypto';
import { explicitEffort, fileKind, fileText, mediaUrl, messageParts, ModelRequestError, parseEvent, parseToolArguments,
  postWithFallback, providerError, readSse, reasoningOrigin, reasoningProviderOptions, replayRejected, serializeToolCalls,
  textValue, toolSchema, unsupportedFileNote } from './model-common.mjs';

export const FORMAT = 'openai-responses';

export function responsesEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/responses')) url.pathname += '/responses';
  return url.href;
}

/** A model whose catalog lists only 'none' does not reason; unknown models are assumed to. */
export function reasons(efforts) {
  return !(Array.isArray(efforts) && efforts.length > 0 && efforts.every(level => level === 'none'));
}

/** Request options: stateless storage, reasoning effort with summaries, encrypted reasoning. */
export function responsesOptions(model, { effort, efforts, maxTokens } = {}) {
  const level = explicitEffort(effort), thinking = reasons(efforts) && level !== 'none';
  const reasoning = reasons(efforts) ? { ...(level ? { effort: level } : {}), ...(thinking ? { summary: 'auto' } : {}) } : null;
  return { store: false, parallel_tool_calls: true,
    ...(reasoning && Object.keys(reasoning).length ? { reasoning } : {}),
    ...(thinking ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { max_output_tokens: maxTokens } : {}) };
}

function userContent(part) {
  if (part.type === 'text') return part.text ? { type: 'input_text', text: part.text } : null;
  if (part.type === 'image') return { type: 'input_image', image_url: mediaUrl(part), detail: 'auto' };
  if (part.type === 'file') {
    const kind = fileKind(part);
    if (kind === 'image') return { type: 'input_image', image_url: mediaUrl(part, part.mimeType), detail: 'auto' };
    if (kind === 'pdf') {
      const url = mediaUrl(part, part.mimeType);
      return /^https?:/i.test(url) ? { type: 'input_file', file_url: url } : { type: 'input_file', filename: part.filename ?? 'document.pdf', file_data: url };
    }
    if (kind === 'text') return { type: 'input_text', text: `${part.filename ? `${part.filename}:\n` : ''}${fileText(part)}` };
    return { type: 'input_text', text: unsupportedFileNote(part) };
  }
  throw new TypeError(`Unsupported user content type: ${part.type}`);
}

/** Encrypted reasoning is readable only by the model that produced it. */
function replayableReasoning(part, model) {
  const origin = reasoningOrigin(part);
  if (origin.model !== model) return null;
  if (part.type === 'reasoning') {
    if (!part.signature || !(origin.format === FORMAT || (!origin.format && origin.summarized))) return null;
    return { type: 'reasoning', ...(origin.itemId ? { id: origin.itemId } : {}),
      summary: part.text ? [{ type: 'summary_text', text: part.text }] : [], encrypted_content: part.signature };
  }
  if (part.type === 'redacted-reasoning') {
    // The original Harness turns summarized reasoning into redacted parts when it rebuilds a turn.
    if (!part.data || (origin.format && origin.format !== FORMAT)) return null;
    return { type: 'reasoning', ...(origin.itemId ? { id: origin.itemId } : {}), summary: [], encrypted_content: part.data };
  }
  return null;
}

/** CoreMessages to Responses input items and instructions. */
export function convertResponsesInput(messages, { model, replayReasoning = true, inlineToolImages = true } = {}) {
  const instructions = [], input = [];
  let leading = true, pendingImages = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Screenshots from the preceding tool results:' }, ...pendingImages] });
    pendingImages = [];
  };
  let replayed = 0;
  for (const message of messages) {
    const parts = messageParts(message);
    if (message.role !== 'tool') flushImages();
    if (message.role === 'system' || message.role === 'developer') {
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
      if (!text) continue;
      if (leading) instructions.push(text);
      else input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
      continue;
    }
    leading = false;
    if (message.role === 'user') {
      const content = parts.map(userContent).filter(Boolean);
      if (content.length) input.push({ type: 'message', role: 'user', content });
    } else if (message.role === 'assistant') {
      const items = [];
      for (const part of parts) {
        if (part.type === 'reasoning' || part.type === 'redacted-reasoning') {
          const item = replayReasoning ? replayableReasoning(part, model) : null;
          if (item) { items.push(item); replayed++; }
        } else if (part.type === 'text') {
          if (!part.text) continue;
          const phase = reasoningOrigin(part).phase;
          const previous = items.at(-1);
          if (previous?.type === 'message' && previous.phase === phase) previous.content += part.text;
          else items.push({ type: 'message', role: 'assistant', content: part.text, ...(phase ? { phase } : {}) });
        } else if (part.type === 'tool-call') {
          items.push({ type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: textValue(part.args ?? {}) });
        }
      }
      // A reasoning item must be followed by the output it led to.
      while (items.at(-1)?.type === 'reasoning') { items.pop(); replayed--; }
      input.push(...items);
    } else if (message.role === 'tool') {
      for (const part of parts) {
        if (part.type !== 'tool-result' || !part.toolCallId) throw new TypeError('Tool messages require tool-result parts and toolCallId');
        const extra = part.experimental_content ?? [];
        const text = part.result === undefined ? extra.filter(item => item.type === 'text').map(item => item.text).join('\n') : textValue(part.result);
        const images = extra.filter(item => item.type === 'image').map(item => ({ type: 'input_image', image_url: mediaUrl(item), detail: 'auto' }));
        if (images.length && inlineToolImages) {
          input.push({ type: 'function_call_output', call_id: part.toolCallId, output: [...(text ? [{ type: 'input_text', text }] : []), ...images] });
        } else {
          input.push({ type: 'function_call_output', call_id: part.toolCallId, output: text || '(empty)' });
          pendingImages.push(...images);
        }
      }
    } else {
      throw new TypeError(`Unsupported message role: ${message.role}`);
    }
  }
  flushImages();
  return { instructions: instructions.join('\n\n'), input, replayed };
}

export function convertResponsesTools(tools = []) {
  return tools.map(tool => ({ type: 'function', ...toolSchema(tool), strict: false }));
}

/** Normalize Responses usage to the OpenAI Chat fields recorded by the usage ledger. */
export function responsesUsage(raw = {}) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const input = count(raw.input_tokens), output = count(raw.output_tokens);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: count(raw.total_tokens ?? input + output),
    prompt_tokens_details: { cached_tokens: count(raw.input_tokens_details?.cached_tokens) },
    cache_creation_input_tokens: count(raw.input_tokens_details?.cache_write_tokens),
    completion_tokens_details: { reasoning_tokens: count(raw.output_tokens_details?.reasoning_tokens) } };
}

// Routes the same conversation to the same cache shard: model, instructions and the opening request.
function promptCacheKey(model, instructions, input) {
  const first = input.find(item => item.type === 'message' && item.role === 'user');
  return createHash('sha256').update(JSON.stringify([model, instructions, first?.content ?? null])).digest('hex').slice(0, 48);
}

const OPTIONAL = ['reasoning.summary', 'include', 'prompt_cache_key', 'parallel_tool_calls', 'store', 'reasoning.effort', 'max_output_tokens'];

function incomplete(reason) {
  if (reason === 'max_output_tokens') return new ModelRequestError('Model response stopped with max_output_tokens', { code: 'length' });
  if (reason === 'content_filter') return new ModelRequestError('Model response stopped with content_filter', { code: 'content_filter' });
  return new ModelRequestError(`Model response is incomplete${reason ? ` (${reason})` : ''}`, { code: reason });
}

/** One streamed Responses turn; yields Harness stream parts, returns the assembled message. */
export async function* responsesTurn(context) {
  const { fetchImpl, endpoint, apiKey, headers, model, messages, tools, effort, efforts, maxTokens, signal, state,
    notifyRequest, onModel, onId, onUsage } = context;
  const functions = convertResponsesTools(tools);
  let replayed = 0, inlineImages = false;
  const { http } = await postWithFallback({ fetchImpl, url: endpoint, apiKey, signal, state, optional: OPTIONAL,
    headers: () => {
      const value = new Headers(headers);
      value.set('content-type', 'application/json');
      value.set('accept', 'text/event-stream');
      if (apiKey) value.set('authorization', `Bearer ${apiKey}`);
      return value;
    },
    fallbacks: [
      { name: 'retry without replayed reasoning', applies: error => replayed > 0 && replayRejected(error), apply: () => { state.stripReasoning = true; } },
      { name: 'tool screenshots as a message', applies: error => inlineImages && error.status === 400 && /function_call_output|input_image|output/i.test(error.message),
        apply: () => { state.toolImagesAsMessage = true; } },
    ],
    build: () => {
      const converted = convertResponsesInput(messages, { model, replayReasoning: !state.stripReasoning,
        inlineToolImages: !state.toolImagesAsMessage });
      replayed = converted.replayed;
      inlineImages = converted.input.some(item => item.type === 'function_call_output' && Array.isArray(item.output));
      return { model, ...(converted.instructions ? { instructions: converted.instructions } : {}), input: converted.input,
        ...(functions.length ? { tools: functions } : {}), stream: true,
        ...responsesOptions(model, { effort, efforts, maxTokens }),
        prompt_cache_key: promptCacheKey(model, converted.instructions, converted.input) };
    } });
  notifyRequest(http.headers.get('x-request-id') ?? http.headers.get('request-id'));
  let id, responseModel = model, rawUsage = {}, finished = false;
  const items = new Map();
  const item = index => {
    if (!items.has(index)) items.set(index, { type: undefined, summary: [], reasoning: '', text: '', arguments: '', emitted: false });
    return items.get(index);
  };
  const reasoningOptions = (entry, summarized) => ({
    providerOptions: reasoningProviderOptions({ format: FORMAT, model: responseModel, summarized, itemId: entry.id }) });
  const start = response => {
    if (response?.id && response.id !== id) { id = response.id; onId(id); notifyRequest(id); }
    if (response?.model) { responseModel = response.model; onModel(responseModel); }
  };
  for await (const data of readSse(http.body)) {
    signal.throwIfAborted();
    if (data.trim() === '[DONE]') break;
    const event = parseEvent(data);
    switch (event.type) {
      case 'response.created': case 'response.in_progress': case 'response.queued':
        start(event.response); break;
      case 'response.output_item.added': {
        const entry = item(event.output_index);
        Object.assign(entry, { type: event.item?.type, id: event.item?.id, name: event.item?.name, callId: event.item?.call_id, phase: event.item?.phase });
        break;
      }
      case 'response.reasoning_summary_text.delta': case 'response.reasoning_text.delta': {
        if (!event.delta) break;
        const entry = item(event.output_index), summarized = event.type === 'response.reasoning_summary_text.delta';
        let delta = event.delta;
        if (summarized) {
          const index = event.summary_index ?? 0;
          if (entry.summary[index] === undefined && entry.summary.length) delta = `\n\n${delta}`;
          entry.summary[index] = (entry.summary[index] ?? '') + event.delta;
        } else entry.reasoning += event.delta;
        entry.emitted = true;
        yield { type: 'reasoning', textDelta: delta, ...reasoningOptions(entry, summarized) };
        break;
      }
      case 'response.output_text.delta': case 'response.refusal.delta': {
        if (!event.delta) break;
        const entry = item(event.output_index);
        entry.text += event.delta;
        yield { type: 'text-delta', textDelta: event.delta };
        break;
      }
      case 'response.function_call_arguments.delta':
        item(event.output_index).arguments += event.delta ?? '';
        break;
      case 'response.output_item.done': {
        const entry = item(event.output_index), done = event.item ?? {};
        Object.assign(entry, { type: done.type ?? entry.type, id: done.id ?? entry.id });
        if (done.type === 'reasoning') {
          if (Array.isArray(done.summary) && done.summary.length) entry.summary = done.summary.map(part => part.text ?? '');
          if (Array.isArray(done.content) && done.content.length && !entry.reasoning) entry.reasoning = done.content.map(part => part.text ?? '').join('');
          entry.encrypted = done.encrypted_content ?? undefined;
          if (entry.encrypted) {
            // Readable reasoning carries the encrypted item as its signature; reasoning without
            // any readable text is a redacted part, which the Harness keeps without text.
            if (entry.emitted) yield { type: 'reasoning-signature', signature: entry.encrypted };
            else yield { type: 'redacted-reasoning', data: entry.encrypted, ...reasoningOptions(entry, true) };
          }
        } else if (done.type === 'message') {
          entry.phase = done.phase ?? entry.phase;
          const text = (done.content ?? []).map(part => part.text ?? part.refusal ?? '').join('');
          if (!entry.text && text) { entry.text = text; yield { type: 'text-delta', textDelta: text }; }
        } else if (done.type === 'function_call') {
          Object.assign(entry, { name: done.name ?? entry.name, callId: done.call_id ?? entry.callId,
            arguments: typeof done.arguments === 'string' ? done.arguments : entry.arguments });
        }
        break;
      }
      case 'response.completed':
        start(event.response);
        rawUsage = event.response?.usage ?? rawUsage; onUsage(responsesUsage(rawUsage));
        finished = true;
        break;
      case 'response.incomplete':
        rawUsage = event.response?.usage ?? rawUsage; onUsage(responsesUsage(rawUsage));
        throw incomplete(event.response?.incomplete_details?.reason);
      case 'response.failed':
        rawUsage = event.response?.usage ?? rawUsage; onUsage(responsesUsage(rawUsage));
        throw providerError({ error: event.response?.error ?? { message: 'Model response failed' } }, undefined, http.headers, apiKey);
      case 'error':
        throw providerError(event.error ? event : { error: event }, undefined, http.headers, apiKey);
      default:
        break;
    }
    if (finished) break;
  }
  signal.throwIfAborted();
  if (!finished) throw new ModelRequestError('Model SSE stream ended before a completion marker');
  const content = [], calls = [];
  for (const [, entry] of [...items.entries()].sort(([a], [b]) => a - b)) {
    if (entry.type === 'reasoning') {
      const summary = entry.summary.filter(Boolean).join('\n\n'), text = summary || entry.reasoning;
      if (!text && !entry.encrypted) continue;
      if (!text) { content.push({ type: 'redacted-reasoning', data: entry.encrypted, ...reasoningOptions(entry, true) }); continue; }
      content.push({ type: 'reasoning', text, ...(entry.encrypted ? { signature: entry.encrypted } : {}),
        ...reasoningOptions(entry, Boolean(summary) || !entry.reasoning) });
    } else if (entry.type === 'message') {
      if (entry.text) content.push({ type: 'text', text: entry.text, ...(entry.phase ? { providerOptions: { grokbot: { phase: entry.phase } } } : {}) });
    } else if (entry.type === 'function_call') {
      if (!entry.callId || !entry.name) throw new ModelRequestError('Incomplete model tool call identity');
      const call = { type: 'tool-call', toolCallId: entry.callId, toolName: entry.name, args: parseToolArguments(entry.name, entry.arguments) };
      // Output order is kept: each reasoning item must precede the output it led to on replay.
      calls.push(call); content.push(call);
    }
  }
  yield* serializeToolCalls(calls);
  return { id, model: responseModel, content, toolCalls: calls.length, usage: responsesUsage(rawUsage) };
}
