import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelSession } from '../runtime/model-session.mjs';
import { ModelRequestError } from '../runtime/model-common.mjs';
import { createHarnessModelErrorMapper } from '../runtime/model-errors.mjs';

const done = text => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const toolCall = (id = 'call_1') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
  { index: 0, id, function: { name: 'record', arguments: '{}' } },
] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
const exhausted = () => new Response(JSON.stringify({ error: { message: 'API key quota exhausted', code: 'API_KEY_QUOTA_EXHAUSTED' } }), { status: 429 });
const failure = (status, message = `HTTP ${status}`, code) => new Response(JSON.stringify({ error: { message, ...(code ? { code } : {}) } }), { status });

function session(fetchImpl, selectRequest, onFallback = async () => {}) {
  return createModelSession({ baseUrl: 'https://primary.example/v1', apiKey: 'primary-key', model: 'primary',
    fetchImpl, selectRequest, onFallback, idleTimeoutMs: 1_000 });
}

test('an exhausted primary switches only to a fallback with independent credentials', async () => {
  const requests = [], fallbacks = [];
  const model = session(async (url, options) => {
    requests.push([url, JSON.parse(options.body).model, options.headers.get('authorization')]);
    return requests.length === 1 ? exhausted() : done('recovered');
  }, () => ({ model: 'primary', fallbacks: [{ baseUrl: 'https://backup.example/v1', apiKey: 'backup-key',
    apiFormat: 'openai', model: 'backup', providerId: 'backup' }] }), event => fallbacks.push(event));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  const parts = await Array.fromAsync(result.fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta), ['recovered']);
  assert.deepEqual(requests, [
    ['https://primary.example/v1/chat/completions', 'primary', 'Bearer primary-key'],
    ['https://backup.example/v1/chat/completions', 'backup', 'Bearer backup-key'],
  ]);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].reason, 'HTTP 429');
});

test('an exhausted primary does not retry a fallback sharing its API key', async () => {
  let requests = 0;
  const fallbacks = [];
  const model = session(async () => { requests++; return exhausted(); }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://another-gateway.example/v1', apiKey: 'primary-key', apiFormat: 'openai', model: 'other' },
  ] }), event => fallbacks.push(event));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  await assert.rejects(Array.fromAsync(result.fullStream), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'API_KEY_QUOTA_EXHAUSTED');
    return true;
  });
  assert.equal(requests, 1);
  assert.equal(fallbacks[0].reason, 'quota');
  assert.equal(fallbacks[0].skipped[0].model, 'other');
  assert.equal(JSON.stringify(fallbacks).includes('primary-key'), false);
});

test('an exhausted fallback still leaves a later fallback with its own key', async () => {
  const requests = [];
  const model = session(async (url, options) => {
    requests.push(JSON.parse(options.body).model);
    return requests.length === 1 ? failure(503) : requests.length === 2 ? failure(402, 'Insufficient balance') : done('recovered');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://primary.example/v1', apiKey: 'primary-key', apiFormat: 'openai', model: 'same-key' },
    { baseUrl: 'https://other.example/v1', apiKey: 'other-key', apiFormat: 'openai', model: 'other-key-model' },
  ] }));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  const parts = await Array.fromAsync(result.fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta), ['recovered']);
  assert.deepEqual(requests, ['primary', 'same-key', 'other-key-model']);
});

test('a transient primary failure retries a fallback sharing its API key', async () => {
  const requests = [];
  const model = session(async (url, options) => {
    requests.push([url, JSON.parse(options.body).model]);
    return requests.length === 1 ? failure(503) : done('recovered');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://same-key.example/v1', apiKey: 'primary-key', apiFormat: 'openai', model: 'other' },
  ] }));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  const parts = await Array.fromAsync(result.fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta), ['recovered']);
  assert.deepEqual(requests, [
    ['https://primary.example/v1/chat/completions', 'primary'],
    ['https://same-key.example/v1/chat/completions', 'other'],
  ]);
});

test('a fallback with an independent key can take over an HTTP 402 balance error', async () => {
  const requests = [];
  const model = session(async (url, options) => {
    requests.push([url, JSON.parse(options.body).model]);
    return requests.length === 1 ? failure(402, 'Insufficient balance') : done('recovered');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup' },
  ] }));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  const parts = await Array.fromAsync(result.fullStream);
  assert.deepEqual(parts.filter(part => part.type === 'text-delta').map(part => part.textDelta), ['recovered']);
  assert.equal(requests.length, 2);
});

test('a caller-owned timeout is not treated as an upstream idle timeout', async () => {
  let requests = 0;
  const cancellation = new AbortController();
  const started = Promise.withResolvers();
  const model = session(async () => {
    requests++;
    started.resolve();
    await new Promise(() => {});
    throw new DOMException('caller deadline', 'TimeoutError');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup' },
  ] }));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({ signal: cancellation.signal }, 'test', []);
  const reading = assert.rejects(Array.fromAsync(result.fullStream), { name: 'TimeoutError', message: 'caller deadline' });
  await started.promise;
  cancellation.abort(new DOMException('caller deadline', 'TimeoutError'));
  await reading;
  assert.equal(requests, 1);
});

test('cancellation during fallback logging prevents the backup request', async () => {
  let requests = 0;
  const cancellation = new AbortController();
  const fallbackStarted = Promise.withResolvers();
  const fallbackFinished = Promise.withResolvers();
  const model = createModelSession({ baseUrl: 'https://primary.example/v1', apiKey: 'primary-key', model: 'primary',
    fetchImpl: async () => { requests++; return failure(503); }, idleTimeoutMs: 1_000,
    selectRequest: async () => ({ model: 'primary', fallbacks: [
      { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup' },
    ] }),
    onFallback: async () => { fallbackStarted.resolve(); await fallbackFinished.promise; } });
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({ signal: cancellation.signal }, 'test', []);
  const reading = assert.rejects(Array.fromAsync(result.fullStream), { name: 'AbortError' });
  await fallbackStarted.promise;
  cancellation.abort(new DOMException('canceled while logging', 'AbortError'));
  fallbackFinished.resolve();
  await reading;
  assert.equal(requests, 1);
});

test('a tool loop stays on the accepted fallback for its next step', async () => {
  const requests = [];
  const model = session(async (url, options) => {
    const modelId = JSON.parse(options.body).model;
    requests.push(modelId);
    if (modelId === 'primary') return failure(503);
    return requests.length === 2 ? toolCall() : done('complete');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup' },
  ] }));
  const executor = model.getExecutor([{ role: 'user', content: 'hello' }]);
  await Array.fromAsync(executor.stream({}, 'first-step', []).fullStream);
  await Array.fromAsync(executor.stream({}, 'second-step', []).fullStream);
  assert.deepEqual(requests, ['primary', 'backup', 'backup']);
});

test('request and usage metadata come from the model that completed the turn', async () => {
  const ids = [], usages = [];
  const primaryFailure = new Response(JSON.stringify({ error: { message: 'HTTP 503' } }), { status: 503,
    headers: { 'x-request-id': 'failed-primary-id' } });
  const backupSuccess = new Response(`data: ${JSON.stringify({ id: 'successful-backup-id', model: 'backup',
    choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  const model = createModelSession({ baseUrl: 'https://primary.example/v1', apiKey: 'primary-key', model: 'primary',
    idleTimeoutMs: 1_000, onRequestId: id => ids.push(id), onUsage: value => usages.push(value),
    fetchImpl: async () => requests++ === 0 ? primaryFailure : backupSuccess,
    selectRequest: async () => ({ model: 'primary', fallbacks: [
      { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup',
        profileId: 'backup-profile', providerId: 'backup-provider' },
    ] }) });
  let requests = 0;
  await Array.fromAsync(model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []).fullStream);
  assert.deepEqual(ids, ['successful-backup-id']);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].model, 'backup');
  assert.equal(usages[0].requestId, 'successful-backup-id');
  assert.equal(usages[0].profileId, 'backup-profile');
  assert.equal(usages[0].providerId, 'backup-provider');
});

test('usage observed before a failed stream remains attributed to that attempt', async () => {
  const usages = [];
  const failed = new Response(`data: ${JSON.stringify({ id: 'primary-request', model: 'primary-returned',
    choices: [{ delta: { reasoning_content: 'partial' }, finish_reason: null }],
    usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`);
  const model = createModelSession({ baseUrl: 'https://primary.example/v1', apiKey: 'primary-key', model: 'primary',
    idleTimeoutMs: 1_000, onUsage: value => usages.push(value),
    fetchImpl: async () => usages.length ? done('recovered') : failed,
    selectRequest: async () => ({ model: 'primary', profileId: 'primary-profile', providerId: 'primary-provider', fallbacks: [
      { baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', apiFormat: 'openai', model: 'backup',
        profileId: 'backup-profile', providerId: 'backup-provider' },
    ] }) });
  await assert.rejects(Array.fromAsync(model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []).fullStream),
    /completion marker/);
  assert.equal(usages.length, 1);
  assert.equal(usages[0].model, 'primary-returned');
  assert.equal(usages[0].requestId, 'primary-request');
  assert.equal(usages[0].profileId, 'primary-profile');
  assert.equal(usages[0].providerId, 'primary-provider');
  assert.equal(usages[0].raw.prompt_tokens, 7);
});

test('quota exhaustion maps to a non-retryable Harness error after all routes fail', () => {
  class ConnectError extends Error {}
  class ActionRequiredError extends Error {}
  class NonRetriableError extends Error {
    constructor(message, options) { super(message, options); this.displayInfo = options.displayInfo; }
  }
  const map = createHarnessModelErrorMapper({ ConnectError, ActionRequiredError, NonRetriableError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 } });
  const mapped = map(new ModelRequestError('API key quota exhausted', { status: 429, code: 'API_KEY_QUOTA_EXHAUSTED' }));
  assert.ok(mapped instanceof NonRetriableError);
  assert.equal(mapped.displayInfo.isRetryable, false);
});

test('quota-like 429 errors remain retryable unless the API key is explicitly exhausted', () => {
  class ConnectError extends Error {}
  class ActionRequiredError extends Error {}
  class NonRetriableError extends Error {}
  const map = createHarnessModelErrorMapper({ ConnectError, ActionRequiredError, NonRetriableError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 } });
  for (const message of [
    'Requests to this model are temporarily over quota; retry later.',
    '429 temporary quota exceeded; retry later',
    'temporary quota exhausted; retry later',
  ]) {
    const mapped = map(new ModelRequestError(message, { status: 429 }));
    assert.ok(mapped instanceof ConnectError, message);
  }
  const permanent = map(new ModelRequestError('429 API key quota exhausted', { status: 429 }));
  assert.ok(permanent instanceof NonRetriableError);
});

test('a temporary quota 429 still reaches a same-key fallback', async () => {
  const requests = [];
  const model = session(async (url, options) => {
    requests.push(JSON.parse(options.body).model);
    return requests.length === 1 ? failure(429, 'temporary quota exceeded; retry later') : done('recovered');
  }, () => ({ model: 'primary', fallbacks: [
    { baseUrl: 'https://same-key.example/v1', apiKey: 'primary-key', apiFormat: 'openai', model: 'other' },
  ] }));
  const result = model.getExecutor([{ role: 'user', content: 'hello' }]).stream({}, 'test', []);
  await Array.fromAsync(result.fullStream);
  assert.deepEqual(requests, ['primary', 'other']);
});
