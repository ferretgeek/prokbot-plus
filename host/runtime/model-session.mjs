// Model session for the original Harness: one streamed turn per call, in the configured
// API format. Formats share request selection, cancellation, usage and completion.
import { randomUUID } from 'node:crypto';
import { ModelRequestError } from './model-common.mjs';
import { chatEndpoint, chatTurn, convertChatMessages, convertChatTools } from './openai-chat.mjs';
import { responsesEndpoint, responsesTurn } from './openai-responses.mjs';
import { anthropicEndpoint, anthropicTurn } from './anthropic-messages.mjs';

export { ModelRequestError };
export const SUPPORTED_MODELS = Object.freeze([
  'deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg',
]);
export const API_FORMATS = Object.freeze(['openai', 'openai-responses', 'anthropic']);

/** Translate the original Harness CoreMessage representation (OpenAI Chat) without losing screenshots. */
export const convertMessages = messages => convertChatMessages(messages);
export const convertTools = convertChatTools;

const FORMATS = {
  openai: { endpoint: chatEndpoint, turn: chatTurn },
  'openai-responses': { endpoint: responsesEndpoint, turn: responsesTurn },
  anthropic: { endpoint: baseUrl => anthropicEndpoint(baseUrl), turn: anthropicTurn },
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Consumers read several promises after fullStream; reject all without unhandled rejections.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function abortError(reason) {
  return reason instanceof Error ? reason : new DOMException('Model stream was canceled', 'AbortError');
}

/** Usage arrives normalized to OpenAI Chat fields from every format. */
function usageValues(raw = {}, contextWindowTokens = 0) {
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const inputTokens = count(raw.prompt_tokens), outputTokens = count(raw.completion_tokens);
  return {
    usage: { promptTokens: inputTokens, completionTokens: outputTokens,
      totalTokens: count(raw.total_tokens ?? inputTokens + outputTokens) },
    extendedUsage: { inputTokens, outputTokens,
      cacheReadTokens: count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens),
      cacheWriteTokens: count(raw.cache_creation_input_tokens), maxTokens: count(contextWindowTokens) },
  };
}

export function createModelSession({ baseUrl, apiKey, model, onRequestId, apiFormat = 'openai', policy,
  fetchImpl = globalThis.fetch, headers = {}, requestOptions = {}, contextWindowTokens = 0,
  summaryThresholdTokens = 0, mapError = error => error, onUsage = async () => {}, selectRequest } = {}) {
  if (typeof model !== 'string' || !model.trim() || model !== model.trim() || model.length > 256 || /[\r\n\0]/.test(model)) {
    throw new TypeError('model must be an explicitly selected, nonempty model ID');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof mapError !== 'function') throw new TypeError('mapError must be a function');
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0) {
    throw new TypeError('contextWindowTokens must be a nonnegative integer');
  }
  const format = FORMATS[apiFormat];
  if (!format) throw new TypeError(`apiFormat must be one of ${API_FORMATS.join(', ')}`);
  const endpoint = format.endpoint(baseUrl);
  // Per-session adaptations: optional parameters a compatible service rejected, and
  // replayed reasoning that no longer matches this conversation.
  const state = { dropped: new Set(), stripReasoning: false, toolImagesAsMessage: false };
  const effortsFor = id => policy?.models?.find(entry => entry.id === id)?.efforts;
  let resolvedModelId;
  let selectedContext = { contextWindowTokens, summaryThresholdTokens };

  class Executor {
    constructor(initialMessages, trackModel) {
      this.messages = initialMessages ? [...(Array.isArray(initialMessages) ? initialMessages : [initialMessages])] : [];
      this.trackModel = trackModel;
    }
    appendMessages(value) { this.messages.push(...(Array.isArray(value) ? value : [value])); return this; }
    getState() { return [...this.messages]; }
    getMessages() { return [...this.messages]; }
    clearMessages() { this.messages = []; }
    stream(ctx, invocationId, tools, options = {}) {
      const slots = Object.fromEntries(['response', 'usage', 'extendedUsage', 'providerMetadata', 'invocationId'].map(key => [key, deferred()]));
      const controller = new AbortController();
      const signal = ctx?.signal;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        Object.values(slots).forEach(slot => slot.reject(error));
      };
      const cancel = () => {
        const error = abortError(signal?.reason);
        controller.abort(error);
        fail(error);
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      const messages = this.getMessages();
      const trackModel = this.trackModel;
      async function* produce() {
        let notified = false;
        let recordedUsage, reportedModel = model, reportedId, selectedEffort;
        const notifyRequest = id => {
          if (!notified && id) {
            notified = true;
            try { onRequestId?.(id); } catch { /* Observers do not control model execution. */ }
          }
        };
        try {
          controller.signal.throwIfAborted();
          const selected = await selectRequest?.({ messages, signal: controller.signal });
          const requestContext = { contextWindowTokens: selected?.contextWindowTokens ?? contextWindowTokens,
            summaryThresholdTokens: selected?.summaryThresholdTokens ?? summaryThresholdTokens };
          if (trackModel) selectedContext = requestContext;
          const selectedModel = selected?.model ?? model;
          reportedModel = selectedModel; selectedEffort = selected?.effort;
          const turn = yield* format.turn({ fetchImpl, endpoint, apiKey, headers, model: selectedModel, messages, tools,
            effort: selected?.effort ?? selected?.requestOptions?.reasoning_effort, efforts: effortsFor(selectedModel),
            maxTokens: options.maxTokens, requestOptions, signal: controller.signal, state, notifyRequest,
            onModel: value => { reportedModel = value; }, onId: value => { reportedId = value; },
            onUsage: value => { recordedUsage = value; } });
          const responseId = turn.id ?? randomUUID();
          notifyRequest(responseId);
          const timestamp = new Date();
          // Harness interprets maxTokens as context capacity, not the output token limit.
          const values = usageValues(turn.usage, requestContext.contextWindowTokens);
          if (trackModel) resolvedModelId = turn.model;
          slots.response.resolve({ id: responseId, timestamp, modelId: turn.model,
            messages: [{ id: responseId, role: 'assistant', content: turn.content }] });
          slots.usage.resolve(values.usage);
          slots.extendedUsage.resolve(values.extendedUsage);
          slots.providerMetadata.resolve(undefined);
          slots.invocationId.resolve(invocationId ?? responseId);
          settled = true;
          yield { type: 'finish', finishReason: turn.toolCalls ? 'tool-calls' : 'stop',
            usage: values.usage, response: { id: responseId, timestamp, modelId: turn.model } };
        } catch (error) {
          const mapped = mapError(error);
          fail(mapped);
          throw mapped;
        } finally {
          if (recordedUsage) {
            try { await onUsage({ raw: recordedUsage, model: reportedModel, requestId: reportedId, effort: selectedEffort }); }
            catch (error) { console.error(`[usage] ${error.message}`); }
          }
          signal?.removeEventListener('abort', cancel);
          if (!settled) fail(abortError());
          controller.abort();
        }
      }
      const iterator = produce();
      const fullStream = {
        [Symbol.asyncIterator]() { return this; },
        next: value => iterator.next(value),
        return: value => { cancel(); signal?.removeEventListener('abort', cancel); return iterator.return(value); },
        throw: error => {
          fail(error); controller.abort(error); signal?.removeEventListener('abort', cancel);
          return iterator.throw(error);
        },
      };
      return { fullStream, ...Object.fromEntries(Object.entries(slots).map(([key, slot]) => [key, slot.promise])) };
    }
  }
  return {
    getModelId: () => model,
    getResolvedModelId: () => resolvedModelId,
    getEarlyCompaction: () => undefined,
    getLocalContextPolicy: () => ({ ...selectedContext }),
    getExecutor: state => new Executor(state, true),
    getExecutorWithoutResolvedModelTracking: state => new Executor(state, false),
  };
}
