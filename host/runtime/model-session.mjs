// Model session for the original Harness: one streamed turn per call, in the configured
// API format. Formats share request selection, cancellation, usage and completion.
import { randomUUID } from 'node:crypto';
import { ModelRequestError } from './model-common.mjs';
import { isInputTokenLimitError, parseContextLimitFromError } from './model-errors.mjs';
import { summaryThresholdFor } from './model-policy.mjs';
import { contextEntryKey, persistObservedCeiling, readContextCacheSync, resolveEffectiveContext, resolveEffectiveEfforts } from './model-context-cache.mjs';
import { chatEndpoint, chatTurn, convertChatMessages, convertChatTools } from './openai-chat.mjs';
import { responsesEndpoint, responsesTurn } from './openai-responses.mjs';
import { anthropicEndpoint, anthropicTurn } from './anthropic-messages.mjs';

export const OBSERVED_CEILING_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_OBSERVED_CEILINGS = 256;
const DEFAULT_OBSERVED_CEILINGS = new Map();

export function clearObservedContextCeilings() {
  DEFAULT_OBSERVED_CEILINGS.clear();
}

function resolveCandidateContext(candidate, observedCeilings, contextCachePath, now = Date.now()) {
  const cache = contextCachePath ? readContextCacheSync(contextCachePath) : undefined;
  const resolved = resolveEffectiveContext(candidate, {
    cache,
    observedCeilings,
    now,
    observedMemoryTtlMs: OBSERVED_CEILING_TTL_MS,
  });
  return {
    contextWindowTokens: resolved.contextWindowTokens,
    summaryThresholdTokens: resolved.summaryThresholdTokens,
  };
}

function resolveCandidateEfforts(candidate, contextCachePath, fallbackEfforts) {
  if (candidate.effortsMode === 'auto' && contextCachePath) {
    const cache = readContextCacheSync(contextCachePath);
    const resolved = resolveEffectiveEfforts(candidate, { cache });
    if (resolved.efforts.length) return resolved.efforts;
  }
  return candidate.efforts ?? fallbackEfforts;
}

function recordObservedCeiling(candidate, observedLimit, observedCeilings, contextCachePath, now = Date.now()) {
  if (!observedCeilings || !Number.isSafeInteger(observedLimit) || observedLimit < 1_024) return null;
  const current = resolveCandidateContext(candidate, observedCeilings, contextCachePath, now);
  const effectiveWindow = current.contextWindowTokens ?? 0;
  const effectiveThreshold = current.summaryThresholdTokens ?? 0;
  const observedThreshold = summaryThresholdFor(observedLimit);
  if (effectiveWindow > 0 && observedLimit > effectiveWindow) return null;
  if (effectiveWindow > 0 && observedLimit === effectiveWindow &&
      effectiveThreshold > 0 && effectiveThreshold <= observedThreshold) return null;
  const key = contextEntryKey(candidate);
  let existing = observedCeilings.get(key);
  if (existing && Number.isFinite(existing.observedAt) && now - existing.observedAt >= OBSERVED_CEILING_TTL_MS) {
    observedCeilings.delete(key);
    existing = undefined;
  }
  const nextWindow = existing ? Math.min(existing.contextWindowTokens, observedLimit) : observedLimit;
  const nextThreshold = summaryThresholdFor(nextWindow);
  const entry = { contextWindowTokens: nextWindow, summaryThresholdTokens: nextThreshold, observedAt: now };
  if (existing) {
    observedCeilings.delete(key);
  } else if (observedCeilings.size >= MAX_OBSERVED_CEILINGS) {
    for (const [entryKey, item] of observedCeilings) {
      if (Number.isFinite(item?.observedAt) && now - item.observedAt >= OBSERVED_CEILING_TTL_MS) {
        observedCeilings.delete(entryKey);
      }
    }
    while (observedCeilings.size >= MAX_OBSERVED_CEILINGS) {
      const oldestKey = observedCeilings.keys().next().value;
      if (oldestKey === undefined) break;
      observedCeilings.delete(oldestKey);
    }
  }
  observedCeilings.set(key, entry);
  if (contextCachePath) {
    void persistObservedCeiling(contextCachePath, candidate, entry).catch(error => {
      console.warn(`[model-session] Unable to persist observed context ceiling: ${error.code ?? error.name}`);
    });
  }
  if (!existing || nextWindow < existing.contextWindowTokens) {
    console.warn(`[model-session] Observed provider context ceiling ${nextWindow} for ${candidate.model}; clamping compaction threshold to ${nextThreshold}`);
  }
  return entry;
}

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

// Arm a deadline only while waiting for upstream I/O, never while paused at a yield.
function ioDeadline(controller, ms) {
  const { signal } = controller;
  return async action => {
    signal.throwIfAborted();
    let onAbort;
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new DOMException(`Model upstream idle for ${ms} ms`, 'TimeoutError')), ms);
    timer.unref();
    try { return await Promise.race([canceled, Promise.resolve().then(() => { signal.throwIfAborted(); return action(); })]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  };
}

function candidateKey(candidate) {
  // Stable IDs keep provider URLs and credentials out of adaptation state and logs.
  return candidate.profileId ?? `${candidate.apiFormat}\n${candidate.baseUrl}\n${candidate.model}`;
}

function requestCandidate(value, defaults) {
  const candidate = {
    baseUrl: value?.baseUrl ?? defaults.baseUrl,
    apiKey: value?.apiKey ?? defaults.apiKey,
    apiFormat: value?.apiFormat ?? defaults.apiFormat,
    model: value?.model ?? defaults.model,
    effort: value?.effort ?? defaults.effort,
    efforts: value?.efforts ?? defaults.efforts,
    effortsMode: value?.effortsMode ?? defaults.effortsMode,
    requestOptions: value?.requestOptions ?? defaults.requestOptions,
    contextWindowTokens: value?.contextWindowTokens ?? defaults.contextWindowTokens,
    summaryThresholdTokens: value?.summaryThresholdTokens ?? defaults.summaryThresholdTokens,
    contextMode: value?.contextMode ?? defaults.contextMode,
    profileId: value?.profileId ?? defaults.profileId,
    profileName: value?.profileName ?? defaults.profileName,
    providerId: value?.providerId ?? defaults.providerId,
    providerName: value?.providerName ?? defaults.providerName,
  };
  if (typeof candidate.baseUrl !== 'string' || !candidate.baseUrl ||
      (candidate.apiKey !== undefined && typeof candidate.apiKey !== 'string') ||
      typeof candidate.model !== 'string' || !candidate.model.trim() ||
      !FORMATS[candidate.apiFormat]) {
    throw new TypeError('selected model must include a configured provider, format, and model');
  }
  return candidate;
}

function quotaExhausted(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'API_KEY_QUOTA_EXHAUSTED' || code === 'insufficient_quota') return true;
  // A bare 402 is a balance error, but a 429 or a model-specific quota
  // message can be temporary and must remain retryable.
  if (error?.status === 402 && !code) return true;
  return /(?:api[ _-]?key|account)\s+(?:quota|credit|balance)\s+(?:is\s+)?(?:exhausted|used up|depleted|exceeded)|(?:账户|账户余额|API\s*额度|额度)\s*(?:已)?\s*(?:用完|耗尽|不足)/i.test(error?.message ?? '');
}

function retryableFailure(error, { controller, upstreamSignal, idleTimedOut }) {
  if (controller.signal.aborted || upstreamSignal?.aborted) return idleTimedOut();
  if (error?.name === 'TimeoutError') return true;
  if (error?.name === 'AbortError') return false;
  if (error?.status === 408 || error?.status === 402 || error?.status === 429 ||
      (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599)) return true;
  if (Number.isInteger(error?.status) || error instanceof ModelRequestError) return false;
  return error?.name === 'TypeError' || ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
    'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.code);
}

function distinctCredentialCandidates(candidates, { exhausted = false } = {}) {
  if (!exhausted) return candidates;
  const keys = new Set();
  return candidates.filter(candidate => {
    // A fallback sharing a key has the same quota and cannot recover an exhausted account.
    if (keys.has(candidate.apiKey)) return false;
    keys.add(candidate.apiKey);
    return true;
  });
}

function skippedCredentialCandidates(candidates) {
  const keys = new Set();
  return candidates.filter(candidate => {
    const duplicate = keys.has(candidate.apiKey);
    keys.add(candidate.apiKey);
    return duplicate;
  });
}

function publicCandidate(candidate) {
  return { profileId: candidate.profileId, profileName: candidate.profileName,
    providerId: candidate.providerId, providerName: candidate.providerName,
    apiFormat: candidate.apiFormat, model: candidate.model };
}

function compactionCapabilities({ contextWindowTokens, summaryThresholdTokens }) {
  if (!Number.isSafeInteger(contextWindowTokens) || !Number.isSafeInteger(summaryThresholdTokens) ||
      summaryThresholdTokens <= 0 || summaryThresholdTokens >= contextWindowTokens) return {};
  return { supportsSelfSummary: true, earlyCompactionContextTokenThreshold: summaryThresholdTokens };
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
  summaryThresholdTokens = 0, contextMode, effortsMode, mapError = error => error, onUsage = async () => {}, selectRequest,
  onFallback = async () => {}, idleTimeoutMs = 300_000, profileId, providerId, efforts,
  observedCeilings = DEFAULT_OBSERVED_CEILINGS, contextCachePath } = {}) {
  if (typeof model !== 'string' || !model.trim() || model !== model.trim() || model.length > 256 || /[\r\n\0]/.test(model)) {
    throw new TypeError('model must be an explicitly selected, nonempty model ID');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof mapError !== 'function') throw new TypeError('mapError must be a function');
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 2_147_483_647) {
    throw new TypeError('idleTimeoutMs must be a positive timer interval');
  }
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 0) {
    throw new TypeError('contextWindowTokens must be a nonnegative integer');
  }
  if (!FORMATS[apiFormat]) throw new TypeError(`apiFormat must be one of ${API_FORMATS.join(', ')}`);
  // Adaptive routing may select models with different parameter and replay support.
  const adaptations = new Map();
  // Once a fallback accepts a call, keep using it for the rest of this session.
  // The Harness opens a session per turn, so the next turn tries the primary
  // again. Returning to a primary that expects its own signed thinking within
  // the tool loop would make the next step invalid when the fallback stripped it.
  let preferredKey;
  const defaults = { baseUrl, apiKey, apiFormat, model, requestOptions, contextWindowTokens,
    summaryThresholdTokens, contextMode, effortsMode, profileId, providerId, efforts };
  const effortsFor = id => policy?.models?.find(entry => entry.id === id)?.efforts;
  let resolvedModelId;
  let selectedContext = { contextWindowTokens, summaryThresholdTokens };
  let earlyCompaction;

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
      const waitForIO = ioDeadline(controller, idleTimeoutMs);
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        Object.values(slots).forEach(slot => slot.reject(error));
      };
      const messages = this.getMessages();
      const trackModel = this.trackModel;
      async function* produce() {
        let notified = false;
        let recordedUsage, reportedModel = model, reportedId, selectedEffort, reportedCandidate;
        let usageWrite, usagePending = false;
        const attemptUsages = [];
        const snapshotUsage = () => {
          if (!recordedUsage) return;
          attemptUsages.push({
            raw: recordedUsage,
            model: reportedModel,
            requestId: reportedId,
            effort: selectedEffort,
            profileId: reportedCandidate?.profileId,
            providerId: reportedCandidate?.providerId,
          });
          recordedUsage = undefined;
        };
        const recordUsage = () => {
          snapshotUsage();
          if (!usageWrite || usagePending) {
            usagePending = true;
            const queued = usageWrite ?? Promise.resolve();
            usageWrite = queued.then(async () => {
              for (const usage of attemptUsages.splice(0)) await onUsage(usage);
            }).catch(error => console.error(`[usage] ${error.message}`))
              .finally(() => { usagePending = false; });
          }
          return usageWrite;
        };
        const notifyRequest = id => {
          if (!notified && id) {
            notified = true;
            try { onRequestId?.(id); } catch { /* Observers do not control model execution. */ }
          }
        };
        try {
          controller.signal.throwIfAborted();
          const selected = selectRequest ? await waitForIO(() => selectRequest({ messages, signal: controller.signal })) : undefined;
          const requested = requestCandidate(selected, defaults);
          const configured = [requested,
            ...((selected?.fallbacks ?? []).map(candidate => requestCandidate(candidate, defaults)))];
          const preferredIndex = preferredKey ? configured.findIndex(candidate => candidateKey(candidate) === preferredKey) : -1;
          const ordered = preferredIndex > 0
            ? [configured[preferredIndex], ...configured.filter((_, index) => index !== preferredIndex)]
            : configured;
          const primary = ordered[0];
          let candidates = ordered;
          let requestContext = resolveCandidateContext(primary, observedCeilings, contextCachePath);
          if (trackModel) { selectedContext = requestContext; earlyCompaction = undefined; }
          let turn;
          let activeIterator;
          for (let attempt = 0; attempt < candidates.length; attempt++) {
            const candidate = candidates[attempt];
            requestContext = resolveCandidateContext(candidate, observedCeilings, contextCachePath);
            if (trackModel) selectedContext = requestContext;
            const format = FORMATS[candidate.apiFormat];
            const attemptController = new AbortController();
            const onCancel = () => attemptController.abort(controller.signal.reason);
            controller.signal.addEventListener('abort', onCancel, { once: true });
            const attemptSignal = attemptController.signal;
            let idleTimedOut = false;
            attemptSignal.addEventListener('abort', () => {
              if (attemptSignal.reason?.name === 'TimeoutError') idleTimedOut = true;
            }, { once: true });
            const attemptWaitForIO = ioDeadline(attemptController, idleTimeoutMs);
            const adaptationKey = candidateKey(candidate);
            if (!adaptations.has(adaptationKey)) adaptations.set(adaptationKey, { dropped: new Set(), stripReasoning: false, toolImagesAsMessage: false });
            let emittedVisibleOutput = false;
            recordedUsage = undefined;
            reportedId = undefined;
            reportedModel = candidate.model;
            selectedEffort = candidate.effort;
            reportedCandidate = candidate;
            try {
              const iterator = format.turn({ fetchImpl, endpoint: format.endpoint(candidate.baseUrl), apiKey: candidate.apiKey,
                headers, model: candidate.model, messages, tools,
                effort: candidate.effort ?? candidate.requestOptions?.reasoning_effort,
                efforts: resolveCandidateEfforts(candidate, contextCachePath, effortsFor(candidate.model)), maxTokens: options.maxTokens,
                requestOptions: candidate.requestOptions, signal: attemptSignal, waitForIO: attemptWaitForIO,
                state: adaptations.get(adaptationKey), notifyRequest,
                providerId: candidate.providerId,
                onModel: value => { reportedModel = value; }, onId: value => { reportedId = value; },
                onUsage: value => { recordedUsage = value; } });
              activeIterator = iterator;
              while (true) {
                const next = await iterator.next();
                if (next.done) { turn = next.value; break; }
                // Reasoning is hidden. A fallback is still safe until text or a tool call escapes.
                if (next.value?.type !== 'reasoning') emittedVisibleOutput = true;
                yield next.value;
              }
              activeIterator = undefined;
              break;
            } catch (error) {
              // A cancellation can arrive while onFallback() is still awaiting. Do
              // not attach another request to an already-canceled controller.
              controller.signal.throwIfAborted();
              if (isInputTokenLimitError(error)) {
                const observedLimit = parseContextLimitFromError(error.message);
                const recorded = recordObservedCeiling(candidate, observedLimit, observedCeilings, contextCachePath);
                if (recorded && trackModel) {
                  requestContext = resolveCandidateContext(candidate, observedCeilings, contextCachePath);
                  selectedContext = requestContext;
                }
              }
              if (quotaExhausted(error)) {
                const remaining = candidates.slice(attempt);
                const skipped = skippedCredentialCandidates(remaining);
                candidates = distinctCredentialCandidates(candidates, { exhausted: true });
                const nextDistinct = candidates[attempt + 1];
                if (skipped.length) {
                  try {
                    await onFallback({ from: publicCandidate(candidate), to: nextDistinct ? publicCandidate(nextDistinct) : undefined,
                      attempt: attempt + 1, reason: 'quota', skipped: skipped.map(publicCandidate) });
                  } catch (logError) {
                    console.warn(`[model-session] Unable to record skipped model fallback: ${logError.code ?? logError.name}`);
                  }
                }
              }
              const next = candidates[attempt + 1];
              if (emittedVisibleOutput || !next || !retryableFailure(error, {
                controller: attemptController, upstreamSignal: signal, idleTimedOut: () => idleTimedOut,
              })) throw error;
              try {
                await onFallback({ from: publicCandidate(candidate), to: publicCandidate(next), attempt: attempt + 1,
                  reason: idleTimedOut ? 'timeout'
                    : Number.isInteger(error?.status) ? `HTTP ${error.status}` : 'network' });
              } catch (logError) {
                console.warn(`[model-session] Unable to record model fallback: ${logError.code ?? logError.name}`);
              }
              preferredKey = candidateKey(next);
              controller.signal.throwIfAborted();
            } finally {
              if (activeIterator) {
                await activeIterator.return().catch(() => {});
                activeIterator = undefined;
              }
              controller.signal.removeEventListener('abort', onCancel);
              attemptController.abort();
            }
          }
          if (!turn) throw new ModelRequestError('All configured model attempts failed');
          controller.signal.throwIfAborted();
          const responseId = turn.id ?? randomUUID();
          notifyRequest(responseId);
          const timestamp = new Date();
          // Harness interprets maxTokens as context capacity, not the output token limit.
          const values = usageValues(turn.usage, requestContext.contextWindowTokens);
          const compaction = compactionCapabilities(requestContext);
          if (trackModel) {
            resolvedModelId = turn.model;
            earlyCompaction = compaction.earlyCompactionContextTokenThreshold === undefined ? undefined : {
              threshold: compaction.earlyCompactionContextTokenThreshold,
              inputTokens: values.extendedUsage.inputTokens,
            };
          }
          slots.response.resolve({ id: responseId, timestamp, modelId: turn.model,
            messages: [{ id: responseId, role: 'assistant', content: turn.content }], ...compaction });
          slots.usage.resolve(values.usage);
          slots.extendedUsage.resolve(values.extendedUsage);
          slots.providerMetadata.resolve(undefined);
          slots.invocationId.resolve(invocationId ?? responseId);
          settled = true;
          // A consumer may stop on finish without ever asking for the iterator's done step.
          signal?.removeEventListener('abort', onAbort);
          recordUsage();
          yield { type: 'finish', finishReason: turn.toolCalls ? 'tool-calls' : 'stop',
            usage: values.usage, response: { id: responseId, timestamp, modelId: turn.model } };
        } catch (error) {
          let mapped;
          try { mapped = controller.signal.aborted ? controller.signal.reason : mapError(error); }
          catch (mappingError) { mapped = mappingError; }
          fail(mapped);
          throw mapped;
        } finally {
          signal?.removeEventListener('abort', onAbort);
          if (!settled) fail(abortError());
          await recordUsage();
        }
      }
      const iterator = produce();
      let closing;
      const cancel = error => {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) { controller.abort(error); fail(controller.signal.reason); }
      };
      const onAbort = () => {
        cancel(abortError(signal.reason));
        // A paused consumer need not pull again to unlock the reader and record observed usage.
        closing ??= iterator.return().catch(() => {});
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const fullStream = {
        [Symbol.asyncIterator]() { return this; },
        async next(value) {
          controller.signal.throwIfAborted();
          const step = await iterator.next(value);
          controller.signal.throwIfAborted();
          return step;
        },
        async return(value) {
          cancel(abortError());
          return closing ? await closing : iterator.return(value);
        },
        throw: error => { cancel(error); return iterator.throw(error); },
      };
      return { fullStream, ...Object.fromEntries(Object.entries(slots).map(([key, slot]) => [key, slot.promise])) };
    }
  }
  return {
    getModelId: () => model,
    getResolvedModelId: () => resolvedModelId,
    getEarlyCompaction: () => earlyCompaction && { ...earlyCompaction },
    getLocalContextPolicy: () => ({ ...selectedContext }),
    getExecutor: state => new Executor(state, true),
    getExecutorWithoutResolvedModelTracking: state => new Executor(state, false),
  };
}
