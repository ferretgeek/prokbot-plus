import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractProviderContextWindow,
  normalizeModelId,
  parseReportedCapacity,
  referenceContextWindow,
} from '../runtime/model-specs.mjs';
import {
  catalogContextPolicy,
  effortLevels,
  resolveModelCapabilities,
  summaryThresholdFor,
} from '../runtime/model-policy.mjs';
import {
  createHarnessModelErrorMapper,
  isInputTokenLimitError,
  parseContextLimitFromError,
} from '../runtime/model-errors.mjs';
import {
  createModelSession,
  MAX_OBSERVED_CEILINGS,
  OBSERVED_CEILING_TTL_MS,
} from '../runtime/model-session.mjs';
import { createInference } from '../runtime/host-extensions.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import { contextCacheFilePath, readContextCache, recordCatalogSync, resolveEffectiveContext, resolveEffectiveEfforts } from '../runtime/model-context-cache.mjs';
import { validateModelRouting } from '../runtime/model-routing.mjs';
import { ModelRequestError } from '../runtime/model-common.mjs';
import { Models } from '../server/models.mjs';

// createSelfHostServer loads Connectors and the MCP SDK from host/server/node_modules, which release packages do not include.
const dependencies = existsSync(new URL('../server/node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url));

function sseOk(text = 'OK', usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }) {
  const chunks = [
    `data: ${JSON.stringify({ id: 'cmpl-1', model: 'demo-model', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(chunks, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('Layer 1: extractProviderContextWindow reads OpenAI, OpenRouter, vLLM, Gemini, Anthropic, LiteLLM, and numeric strings', () => {
  assert.equal(extractProviderContextWindow({ context_window: 200_000 }), 200_000);
  assert.equal(extractProviderContextWindow({ max_input_tokens: 1_000_000 }), 1_000_000);
  assert.equal(extractProviderContextWindow({ context_length: '128000' }), 128_000);
  assert.equal(extractProviderContextWindow({ top_provider: { context_length: 262_144 } }), 262_144);
  assert.equal(extractProviderContextWindow({ max_model_len: 65_536 }), 65_536);
  assert.equal(extractProviderContextWindow({ inputTokenLimit: 1_048_576 }), 1_048_576);
  assert.equal(extractProviderContextWindow({ input_token_limit: '1048576' }), 1_048_576);
  assert.equal(extractProviderContextWindow({ limits: { max_context_window_tokens: 400_000 } }), 400_000);
  assert.equal(extractProviderContextWindow({ capabilities: { limits: { max_context_window_tokens: 131_072 } } }), 131_072);
  assert.equal(extractProviderContextWindow({ max_context_length: 32_768 }), 32_768);
  assert.equal(extractProviderContextWindow({ contextWindow: 16_384 }), 16_384);
  assert.equal(extractProviderContextWindow({ context_length: 'not-a-number' }), undefined);
  assert.equal(extractProviderContextWindow({ context_length: 0 }), undefined);
  assert.equal(parseReportedCapacity(100_000_001), undefined);
});

test('Layer 1: Models.catalog handles multi-schema fields, Anthropic pagination, >200 models, Gemini models[], and invalid JSON', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'models-catalog-l1-'));
  try {
    // 1. OpenRouter/vLLM/Relay mix with >250 models (must not truncate at 200)
    const many = Array.from({ length: 260 }, (_, i) => ({ id: `custom/model-${i}`, max_model_len: 32_768 }));
    many.unshift(
      { id: 'openai/gpt-4.1-2025-04-14' }, // no provider field -> Layer 2 reference
      { id: 'anthropic/claude-sonnet-4-6', top_provider: { context_length: '200000' } }, // provider overrides reference!
      { id: 'deepseek-chat' }, // official DeepSeek bare item -> Layer 2 reference (128K)
      { id: 'private-finetune-v9' }, // truly unknown -> 0
    );
    const models = new Models(dir, {
      fetchImpl: async () => new Response(JSON.stringify({ data: many }), { status: 200 }),
    });
    const res = await models.catalog({
      provider: { id: 'p1', name: 'Relay', apiFormat: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'test-key' },
    });
    assert.equal(res.models.length, 264);
    const byId = new Map(res.models.map((m) => [m.id, m]));
    assert.deepEqual(byId.get('openai/gpt-4.1-2025-04-14'), {
      id: 'openai/gpt-4.1-2025-04-14',
      efforts: [],
      source: 'manual',
      contextWindowTokens: 1_047_576,
      summaryThresholdTokens: 785_000,
      contextSource: 'reference',
      matchedFamily: 'gpt-4.1',
    });
    assert.equal(byId.get('anthropic/claude-sonnet-4-6').contextWindowTokens, 200_000);
    assert.equal(byId.get('anthropic/claude-sonnet-4-6').summaryThresholdTokens, 150_000);
    assert.equal(byId.get('anthropic/claude-sonnet-4-6').contextSource, 'provider');
    assert.equal(byId.get('deepseek-chat').contextWindowTokens, 128_000);
    assert.equal(byId.get('deepseek-chat').summaryThresholdTokens, 96_000);
    assert.equal(byId.get('deepseek-chat').contextSource, 'reference');
    assert.equal(byId.get('private-finetune-v9').contextWindowTokens, 0);
    assert.equal(byId.get('private-finetune-v9').contextSource, 'unknown');
    assert.equal(byId.get('custom/model-259').contextWindowTokens, 32_768);
    assert.equal(byId.get('custom/model-259').contextSource, 'provider');

    // 2. Anthropic pagination (has_more + last_id)
    const calls = [];
    const anthModels = new Models(dir, {
      fetchImpl: async (url) => {
        calls.push(url);
        if (!url.includes('after_id=')) {
          return new Response(JSON.stringify({
            data: [{ id: 'claude-sonnet-4-5-20250929', max_input_tokens: 200_000 }],
            has_more: true,
            last_id: 'claude-sonnet-4-5-20250929',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [{ id: 'claude-opus-4-6', max_input_tokens: 1_000_000 }],
          has_more: false,
        }), { status: 200 });
      },
    });
    const anthRes = await anthModels.catalog({
      provider: { id: 'a1', name: 'Anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'test-key' },
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1], /after_id=claude-sonnet-4-5-20250929/);
    assert.equal(anthRes.models.length, 2);
    assert.equal(anthRes.models[1].contextWindowTokens, 1_000_000);
    assert.equal(anthRes.models[1].summaryThresholdTokens, 750_000);

    // 3. Gemini { models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576 }] } shape
    const gemModels = new Models(dir, {
      fetchImpl: async () => new Response(JSON.stringify({
        models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1_048_576 }],
      }), { status: 200 }),
    });
    const gemRes = await gemModels.catalog({
      provider: { id: 'g1', name: 'Gemini', apiFormat: 'openai', baseUrl: 'https://gem.example/v1', apiKey: 'test-key' },
    });
    assert.equal(gemRes.models[0].id, 'gemini-2.5-pro');
    assert.equal(gemRes.models[0].contextWindowTokens, 1_048_576);
    assert.equal(gemRes.models[0].contextSource, 'provider');

    // 4. Non-JSON 200 HTML -> 502
    const badModels = new Models(dir, {
      fetchImpl: async () => new Response('<html>login</html>', { status: 200 }),
    });
    await assert.rejects(
      badModels.catalog({
        provider: { id: 'b1', name: 'Bad', apiFormat: 'openai', baseUrl: 'https://bad.example/v1', apiKey: 'test-key' },
      }),
      { status: 502 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Layer 2: normalizeModelId, referenceContextWindow, effortLevels, and catalogContextPolicy cover major families safely', () => {
  assert.equal(normalizeModelId('openrouter/anthropic/claude-sonnet-4-6:thinking'), 'claude-sonnet-4-6');
  assert.equal(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5-20250929');
  assert.equal(normalizeModelId('openai/gpt-5.2-2025-12-11'), 'gpt-5.2-2025-12-11');

  const expectations = [
    ['gpt-4.1', 1_047_576],
    ['openai/gpt-4o-2024-11-20', 128_000],
    ['o3-mini', 200_000],
    ['gpt-5.2', 400_000],
    ['gpt-5.4', 1_050_000],
    ['gpt-5.4-mini', 400_000],
    ['claude-3-7-sonnet-20250219', 200_000],
    ['claude-sonnet-4-5-20250929', 200_000],
    ['claude-opus-4-6', 1_000_000],
    ['anthropic/claude-sonnet-4-7:extended', 1_000_000],
    ['claude-sonnet-4-5-1m', 1_000_000],
    ['google/gemini-2.5-pro-preview-06-05', 1_048_576],
    ['gemini-3-flash', 1_048_576],
    ['deepseek-chat', 128_000],
    ['deepseek-ai/DeepSeek-R1-0528', 128_000],
    ['x-ai/grok-4-fast-reasoning', 2_000_000],
    ['grok-4', 256_000],
    ['grok-3-mini', 131_072],
    ['qwen/qwen3-coder-plus', 1_000_000],
    ['qwen3-235b-a22b', 131_072],
    ['moonshotai/kimi-k2-thinking', 262_144],
    ['z-ai/glm-4.6', 200_000],
    ['minimax/minimax-m2.5', 204_800],
    ['doubao-seed-1-6-thinking', 256_000],
    ['meta-llama/llama-3.3-70b-instruct:free', 131_072],
  ];
  for (const [id, expectedTokens] of expectations) {
    const policy = catalogContextPolicy(id);
    assert.equal(policy.contextWindowTokens, expectedTokens, `expected ${id} -> ${expectedTokens}`);
    assert.equal(policy.summaryThresholdTokens, summaryThresholdFor(expectedTokens));
    assert.equal(policy.contextSource, 'reference');
  }

  // Provider-reported capacity always overrides built-in reference
  const overridden = catalogContextPolicy('claude-opus-4-6', 200_000);
  assert.equal(overridden.contextWindowTokens, 200_000);
  assert.equal(overridden.summaryThresholdTokens, 150_000);
  assert.equal(overridden.contextSource, 'provider');

  // Unknown / unpublished models MUST stay unknown (0)
  for (const unknown of ['gpt-5.6-terra', 'unpublished-model', 'my-local-gguf', '']) {
    assert.equal(referenceContextWindow(unknown), null, `${unknown} must not match a spec`);
    assert.deepEqual(catalogContextPolicy(unknown), {
      contextWindowTokens: 0,
      summaryThresholdTokens: 0,
      contextSource: 'unknown',
    });
  }

  // Provider-prefixed models also resolve effortLevels cleanly
  assert.deepEqual(effortLevels('openai/gpt-5.2'), ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortLevels('anthropic/claude-opus-4-6'), ['none', 'low', 'medium', 'high', 'max']);

  const resolved = resolveModelCapabilities('openai/gpt-5.2');
  assert.equal(resolved.contextWindowTokens, 400_000);
  assert.equal(resolved.summaryThresholdTokens, 300_000);
  assert.equal(resolved.source, 'reference');
  assert.equal(resolved.contextSource, 'reference');
});

test('Layer 3: POST /admin/api/model/resolve works for single and batch lookups via createSelfHostServer', { skip: !dependencies && 'run npm ci --prefix host/server' }, async () => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(os.tmpdir(), 'model-resolve-http-'));
  const app = await createSelfHostServer({
    dataDir: dir,
    hostDataDir: join(dir, 'host-data'),
    rateLimit: { check() {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const setupRes = await fetch(`${base}/admin/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-grokbot-csrf': '1' },
      body: JSON.stringify({ setupKey: app.auth.setupKey, password: 'AdminPassword12345!' }),
    });
    assert.equal(setupRes.status, 200);
    const cookie = setupRes.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'content-type': 'application/json', 'x-grokbot-csrf': '1' };

    const single = await (await fetch(`${base}/admin/api/model/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'deepseek-reasoner' }),
    })).json();
    assert.equal(single.model.contextWindowTokens, 128_000);
    assert.equal(single.model.summaryThresholdTokens, 96_000);
    assert.equal(single.model.contextSource, 'reference');

    const batch = await (await fetch(`${base}/admin/api/model/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ models: ['gpt-5.2', 'unpublished-custom'] }),
    })).json();
    assert.equal(batch.models.length, 2);
    assert.equal(batch.models[0].contextWindowTokens, 400_000);
    assert.equal(batch.models[0].summaryThresholdTokens, 300_000);
    assert.equal(batch.models[1].contextWindowTokens, 0);
    assert.equal(batch.models[1].contextSource, 'unknown');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Layer 4: parseContextLimitFromError parses OpenAI, Anthropic, Gemini, vLLM, and Chinese relay errors safely', () => {
  assert.equal(
    parseContextLimitFromError("This model's maximum context length is 128000 tokens. However, your messages resulted in 135420 tokens."),
    128_000,
  );
  assert.equal(
    parseContextLimitFromError('This model maximum context length is 65,536 tokens'),
    65_536,
  );
  assert.equal(
    parseContextLimitFromError('prompt is too long: 215432 tokens > 200000 maximum'),
    200_000,
  );
  assert.equal(
    parseContextLimitFromError('input length and max_tokens exceed context limit: 190000 + 20000 > 200000'),
    200_000,
  );
  assert.equal(
    parseContextLimitFromError('The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).'),
    1_048_576,
  );
  assert.equal(
    parseContextLimitFromError('ValueError: max_model_len is 32768'),
    32_768,
  );
  assert.equal(
    parseContextLimitFromError('请求失败：当前模型最大上下文长度为 65536'),
    65_536,
  );
  assert.equal(parseContextLimitFromError('HTTP 400 bad request with 42 messages'), undefined);
  assert.equal(
    isInputTokenLimitError({ status: 400, message: '请求失败：当前模型最大上下文长度为 65536' }),
    true,
  );

  // Error mapper attaches observedContextLimit on InputTokenLimitError
  class InputTokenLimitError extends Error {}
  class ConnectError extends Error {}
  class ActionRequiredError extends Error {}
  class NonRetriableError extends Error {}
  const mapError = createHarnessModelErrorMapper({
    ConnectError, ActionRequiredError, NonRetriableError, InputTokenLimitError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  });
  const mapped = mapError(new ModelRequestError('prompt is too long: 215432 tokens > 200000 maximum', { status: 400 }));
  assert.ok(mapped instanceof InputTokenLimitError);
  assert.equal(mapped.observedContextLimit, 200_000);
});

test('Layer 4: createModelSession self-heals unknown (0) and overestimated context windows after an overflow error', async () => {
  // Case A: profile starts with 0 (unknown), hits 65,536 overflow -> next turn clamps to 65,536 / 49,000
  const ceilingsA = new Map();
  let callsA = 0;
  const fetchA = async () => {
    callsA++;
    if (callsA === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 'context_length_exceeded',
          message: "This model's maximum context length is 65536 tokens. However, your messages resulted in 70123 tokens.",
        },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return sseOk('Recovered');
  };
  const baseCfg = {
    baseUrl: 'https://relay.example/v1',
    apiKey: 'test-key',
    model: 'relay-model',
    profileId: 'relay-prof',
    providerId: 'relay',
    contextWindowTokens: 0,
    summaryThresholdTokens: 0,
    observedCeilings: ceilingsA,
    fetchImpl: fetchA,
  };
  const session1 = createModelSession(baseCfg);
  await assert.rejects(
    async () => {
      for await (const _p of session1.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'turn-1', []).fullStream) {
        // consume
      }
    },
    /maximum context length is 65536/,
  );
  assert.deepEqual(session1.getLocalContextPolicy(), {
    contextWindowTokens: 65_536,
    summaryThresholdTokens: 49_000,
  });

  // Subsequent session sharing observedCeilings advertises the learned 65,536 / 49,000 policy immediately
  const session2 = createModelSession(baseCfg);
  const res2 = session2.getExecutor([{ role: 'user', content: 'compacted' }]).stream({}, 'turn-2', []);
  for await (const _p of res2.fullStream) { /* consume */ }
  const response2 = await res2.response;
  const ext2 = await res2.extendedUsage;
  assert.equal(ext2.maxTokens, 65_536);
  assert.equal(response2.supportsSelfSummary, true);
  assert.equal(response2.earlyCompactionContextTokenThreshold, 49_000);

  // Case B: profile configured at 1M (e.g. Claude 4.6 spec) on a 200K relay -> clamps down to 200K / 150K
  const ceilingsB = new Map();
  let callsB = 0;
  const sessionB = createModelSession({
    ...baseCfg,
    profileId: 'claude-relay',
    model: 'claude-opus-4-6',
    contextWindowTokens: 1_000_000,
    summaryThresholdTokens: 750_000,
    observedCeilings: ceilingsB,
    fetchImpl: async () => {
      callsB++;
      if (callsB === 1) {
        return new Response(JSON.stringify({
          error: { message: 'prompt is too long: 215432 tokens > 200000 maximum' },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOk('Clamped');
    },
  });
  await assert.rejects(
    async () => {
      for await (const _p of sessionB.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'b-1', []).fullStream) {
        // consume
      }
    },
    /200000 maximum/,
  );
  const resB2 = sessionB.getExecutor([{ role: 'user', content: 'compacted' }]).stream({}, 'b-2', []);
  for await (const _p of resB2.fullStream) { /* consume */ }
  const responseB2 = await resB2.response;
  const extB2 = await resB2.extendedUsage;
  assert.equal(extB2.maxTokens, 200_000);
  assert.equal(responseB2.earlyCompactionContextTokenThreshold, 150_000);
});

test('Review #1 & #2: Anthropic exceed context limit detection, output-token non-poisoning, grouped integers, and tightened pattern #4', async () => {
  class InputTokenLimitError extends Error {}
  class ConnectError extends Error {}
  class ActionRequiredError extends Error {}
  class NonRetriableError extends Error {}
  const mapError = createHarnessModelErrorMapper({
    ConnectError, ActionRequiredError, NonRetriableError, InputTokenLimitError,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  });

  // Finding #1: Anthropic HTTP 400 invalid_request_error with "exceed context limit"
  const anthropicMsg = 'input length and max_tokens exceed context limit: 190000 + 20000 > 200000, decrease input length or max_tokens and try again';
  const anthropicErr = new ModelRequestError(anthropicMsg, { status: 400, code: 'invalid_request_error' });
  assert.equal(isInputTokenLimitError(anthropicErr), true);
  assert.equal(parseContextLimitFromError(anthropicMsg), 200_000);
  const mappedAnthropic = mapError(anthropicErr);
  assert.ok(mappedAnthropic instanceof InputTokenLimitError);
  assert.equal(mappedAnthropic.observedContextLimit, 200_000);

  // Additional "exceed context window/length" & "context window/length limit" phrasings
  assert.equal(isInputTokenLimitError({ status: 400, message: "Your request exceeded the model's context window" }), true);
  assert.equal(isInputTokenLimitError({ status: 400, message: 'context window limit reached' }), true);
  assert.equal(isInputTokenLimitError({ status: 400, message: 'context length limit exceeded' }), true);

  // Finding #2a: Output-token limit errors must NOT match isInputTokenLimitError or parseContextLimitFromError
  const outputErrors = [
    'Requested max_tokens (32768) exceeds the maximum number of tokens allowed (8192).',
    'max_output_tokens (32768) exceeds the maximum number of tokens allowed (8192).',
    'max_completion_tokens (32768) exceeds the maximum number of tokens allowed (16384).',
    'Requested output tokens (16384) exceeds the maximum number of tokens allowed (8192).',
    'Requested completion tokens (16384) exceeds the maximum number of tokens allowed (8192).',
  ];
  for (const msg of outputErrors) {
    const err = new ModelRequestError(msg, { status: 400, code: 'invalid_request_error' });
    assert.equal(isInputTokenLimitError(err), false, `output error must not be treated as input limit: ${msg}`);
    assert.equal(parseContextLimitFromError(msg), undefined, `output error must not parse ceiling: ${msg}`);
    const mapped = mapError(err);
    assert.ok(mapped instanceof NonRetriableError, `output error should map to NonRetriableError: ${msg}`);
  }

  // Output-token error in a live session must not poison observedCeilings
  const ceilings = new Map();
  const outSession = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiKey: 'test-key',
    model: 'claude-opus-4-6',
    contextWindowTokens: 1_000_000,
    summaryThresholdTokens: 750_000,
    observedCeilings: ceilings,
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'Requested max_tokens (32768) exceeds the maximum number of tokens allowed (8192).',
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _p of outSession.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'out-1', []).fullStream) {
      // consume
    }
  });
  assert.equal(ceilings.size, 0);
  assert.deepEqual(outSession.getLocalContextPolicy(), {
    contextWindowTokens: 1_000_000,
    summaryThresholdTokens: 750_000,
  });

  // Finding #2b: Properly grouped thousands-or-plain integers (malformed commas must not concatenate)
  assert.notEqual(parseContextLimitFromError('max_model_len=4096,128'), 4_096_128);
  assert.equal(parseContextLimitFromError('max_model_len=4096,128'), undefined);
  assert.equal(parseContextLimitFromError('max_model_len=1,234,56'), undefined);
  assert.equal(parseContextLimitFromError('max_model_len=12,3456'), undefined);
  assert.equal(parseContextLimitFromError('max_model_len=65,536'), 65_536);
  assert.equal(parseContextLimitFromError('max_model_len=1,048,576'), 1_048_576);
  assert.equal(parseContextLimitFromError('max_model_len=4096, requested=5000'), 4_096);

  // Finding #2c: Tightened pattern #4 must not misread sent token count as ceiling
  assert.equal(parseContextLimitFromError('Request exceeds context window: 135000 tokens'), undefined);
  assert.equal(parseContextLimitFromError('Request exceeds context limit: 135000 tokens'), undefined);
  assert.equal(isInputTokenLimitError({ status: 400, message: 'Request exceeds context window: 135000 tokens' }), true);
  assert.equal(parseContextLimitFromError('Request exceeds context window: max 128000 tokens'), 128_000);
  assert.equal(parseContextLimitFromError('Request exceeds context limit (128000)'), 128_000);
  assert.equal(parseContextLimitFromError('Request exceeds context limit is 128000'), 128_000);
  assert.equal(parseContextLimitFromError('Request exceeds context window (135000 > 128000)'), 128_000);
  assert.equal(parseContextLimitFromError('input length and max_tokens exceed context window: 190000 + 20000 > 200000'), 200_000);
});

test('Review #3: progressive snapshot stripping fixes o1-preview/o1-mini 128K and splits doubao-1.5 rules', () => {
  const specs = [
    ['o1-preview', 128_000],
    ['o1-preview-2024-09-12', 128_000],
    ['openai/o1-preview-2024-09-12', 128_000],
    ['o1-mini', 128_000],
    ['o1-mini-2024-09-12', 128_000],
    ['openai/o1-mini-2024-09-12', 128_000],
    ['o1', 200_000],
    ['o1-2024-12-17', 200_000],
    ['o1-pro', 200_000],
    ['o3-mini', 200_000],
    ['doubao-1.5-pro-32k', 32_768],
    ['doubao-1.5-lite-32k', 32_768],
    ['doubao-1-5-pro-32k', 32_768],
    ['doubao-1.5-pro-256k', 256_000],
    ['doubao-1.5-lite-256k', 256_000],
    ['doubao-1.5-thinking-pro', 128_000],
    ['doubao-1.5-thinking-pro-256k', 256_000],
    ['doubao-1.5-thinking-pro-32k', 32_768],
  ];
  for (const [id, expected] of specs) {
    const res = referenceContextWindow(id);
    assert.ok(res, `expected reference spec for ${id}`);
    assert.equal(res.contextWindowTokens, expected, `expected ${id} -> ${expected}`);
  }
  // Unsuffixed doubao-1.5-pro / doubao-1.5-lite stay unknown rather than overestimating 32K endpoints at 128K
  assert.equal(referenceContextWindow('doubao-1.5-pro'), null);
  assert.equal(referenceContextWindow('doubao-1.5-lite'), null);
});

test('Review #4, #5, #8: observedCeilingKey isolation, equal-window compaction self-healing, TTL expiry, and cap eviction', async () => {
  // Finding #4: observedCeilingKey scopes by (apiFormat, baseUrl, model), NOT profileId
  const ceilings = new Map();
  let calls = 0;
  const sessionSmall = createModelSession({
    baseUrl: 'https://relay-a.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'small-32k-model',
    profileId: 'shared-profile-id',
    contextWindowTokens: 0,
    summaryThresholdTokens: 0,
    observedCeilings: ceilings,
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({
        error: { code: 'context_length_exceeded', message: 'maximum context length is 32768 tokens' },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(async () => {
    for await (const _p of sessionSmall.getExecutor([{ role: 'user', content: 'x' }]).stream({}, 'iso-1', []).fullStream) {
      // consume
    }
  });
  assert.equal(calls, 1);
  assert.equal(ceilings.size, 1);
  const [storedKey] = ceilings.keys();
  assert.match(storedKey, /^[0-9a-f]{64}$/, 'observedCeilingKey must be a SHA-256 hex digest');
  assert.ok(!storedKey.includes('shared-profile-id') && !storedKey.includes('relay-a.example'));

  // Same profileId edited to a different model must NOT inherit stale 32K ceiling
  const sessionDifferentModel = createModelSession({
    baseUrl: 'https://relay-a.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'large-1m-model',
    profileId: 'shared-profile-id',
    contextWindowTokens: 1_000_000,
    summaryThresholdTokens: 750_000,
    observedCeilings: ceilings,
    fetchImpl: async () => sseOk('OK'),
  });
  const resDiffModel = sessionDifferentModel.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'iso-2', []);
  for await (const _p of resDiffModel.fullStream) { /* consume */ }
  assert.equal((await resDiffModel.extendedUsage).maxTokens, 1_000_000);
  assert.equal((await resDiffModel.response).earlyCompactionContextTokenThreshold, 750_000);

  // Same profileId + model edited to a different baseUrl must NOT inherit stale 32K ceiling
  const sessionDifferentUrl = createModelSession({
    baseUrl: 'https://relay-b.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'small-32k-model',
    profileId: 'shared-profile-id',
    contextWindowTokens: 128_000,
    summaryThresholdTokens: 96_000,
    observedCeilings: ceilings,
    fetchImpl: async () => sseOk('OK'),
  });
  const resDiffUrl = sessionDifferentUrl.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'iso-3', []);
  for await (const _p of resDiffUrl.fullStream) { /* consume */ }
  assert.equal((await resDiffUrl.extendedUsage).maxTokens, 128_000);
  assert.equal((await resDiffUrl.response).earlyCompactionContextTokenThreshold, 96_000);

  // Finding #5a: configuredWindow === observedLimit with summaryThresholdTokens === 0 must activate compaction
  const eqCeilings = new Map();
  let eqCalls = 0;
  const sessionEqZero = createModelSession({
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 0,
    observedCeilings: eqCeilings,
    fetchImpl: async () => {
      eqCalls++;
      if (eqCalls === 1) {
        return new Response(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'input length and max_tokens exceed context limit: 190000 + 20000 > 200000, decrease input length or max_tokens and try again',
          },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOk('Compacted');
    },
  });
  await assert.rejects(async () => {
    for await (const _p of sessionEqZero.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'eq-1', []).fullStream) {
      // consume
    }
  });
  assert.deepEqual(sessionEqZero.getLocalContextPolicy(), {
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 150_000,
  });
  const resEq2 = sessionEqZero.getExecutor([{ role: 'user', content: 'compacted' }]).stream({}, 'eq-2', []);
  for await (const _p of resEq2.fullStream) { /* consume */ }
  const respEq2 = await resEq2.response;
  assert.equal(respEq2.supportsSelfSummary, true);
  assert.equal(respEq2.earlyCompactionContextTokenThreshold, 150_000);

  // Finding #5b: configuredWindow === observedLimit with threshold > summaryThresholdFor(observedLimit) clamps threshold down
  const highThreshCeilings = new Map();
  let htCalls = 0;
  const sessionHighThresh = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 190_000,
    observedCeilings: highThreshCeilings,
    fetchImpl: async () => {
      htCalls++;
      if (htCalls === 1) {
        return new Response(JSON.stringify({
          error: { message: 'prompt is too long: 201000 tokens > 200000 maximum' },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOk('ClampedThreshold');
    },
  });
  await assert.rejects(async () => {
    for await (const _p of sessionHighThresh.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'ht-1', []).fullStream) {
      // consume
    }
  });
  assert.deepEqual(sessionHighThresh.getLocalContextPolicy(), {
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 150_000,
  });

  // Finding #5c: configuredWindow === observedLimit with already-strict threshold <= summaryThresholdFor bails out early
  const strictCeilings = new Map();
  const sessionStrict = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 100_000,
    observedCeilings: strictCeilings,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'prompt is too long: 201000 tokens > 200000 maximum' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _p of sessionStrict.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'st-1', []).fullStream) {
      // consume
    }
  });
  assert.equal(strictCeilings.size, 0);

  // Finding #8a: TTL expiration deletes stale observed ceiling in applyObservedCeiling
  const staleEntry = ceilings.get(storedKey);
  staleEntry.observedAt = Date.now() - OBSERVED_CEILING_TTL_MS - 1_000;
  const sessionExpired = createModelSession({
    baseUrl: 'https://relay-a.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'small-32k-model',
    contextWindowTokens: 128_000,
    summaryThresholdTokens: 96_000,
    observedCeilings: ceilings,
    fetchImpl: async () => sseOk('Fresh'),
  });
  const resExp = sessionExpired.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'ttl-1', []);
  for await (const _p of resExp.fullStream) { /* consume */ }
  assert.equal(ceilings.has(storedKey), false, 'expired ceiling entry must be deleted');
  assert.equal((await resExp.extendedUsage).maxTokens, 128_000);
  assert.equal((await resExp.response).earlyCompactionContextTokenThreshold, 96_000);

  // Finding #8b: MAX_OBSERVED_CEILINGS (256) evicts oldest entry before inserting a new key
  const capped = new Map();
  const now = Date.now();
  for (let i = 0; i < MAX_OBSERVED_CEILINGS; i++) {
    capped.set(`synthetic-key-${i}`, { contextWindowTokens: 65_536, summaryThresholdTokens: 49_000, observedAt: now });
  }
  assert.equal(capped.size, MAX_OBSERVED_CEILINGS);
  const capSession = createModelSession({
    baseUrl: 'https://cap.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'cap-model',
    contextWindowTokens: 0,
    summaryThresholdTokens: 0,
    observedCeilings: capped,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'maximum context length is 32768 tokens' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _p of capSession.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'cap-1', []).fullStream) {
      // consume
    }
  });
  assert.equal(capped.size, MAX_OBSERVED_CEILINGS);
  assert.equal(capped.has('synthetic-key-0'), false, 'oldest key must be evicted when cap is reached');
  assert.equal(capped.has('synthetic-key-1'), true);
});

test('Review #9: Models.catalog cancels error bodies, bounds 16 MiB payloads, avoids stack overflow on 150k items, stops cursor cycles, and enforces rate limit', async () => {
  const dir = await mkdtemp(join(os.tmpdir(), 'models-catalog-harden-'));
  try {
    const provider = { id: 'p1', name: 'Relay', apiFormat: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'test-key' };

    // 1. Non-OK response cancels body before throwing 502
    let errorBodyCanceled = false;
    const errModels = new Models(dir, {
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('upstream error')); },
        cancel() { errorBodyCanceled = true; },
      }), { status: 500 }),
    });
    await assert.rejects(errModels.catalog({ provider }), { status: 502 });
    assert.equal(errorBodyCanceled, true, 'non-OK response body must be canceled');

    // 2a. Oversized Content-Length (>16 MiB) cancels body and rejects with 502
    let headerOversizeCanceled = false;
    const clOversizeModels = new Models(dir, {
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { headerOversizeCanceled = true; },
      }), { status: 200, headers: { 'content-length': String(17 * 1024 * 1024) } }),
    });
    await assert.rejects(clOversizeModels.catalog({ provider }), { status: 502 });
    assert.equal(headerOversizeCanceled, true, 'oversized Content-Length body must be canceled');

    // 2b. Oversized streamed body (>16 MiB without Content-Length) cancels reader and rejects with 502
    let streamOversizeCanceled = false;
    let chunksSent = 0;
    const chunk1MiB = new Uint8Array(1024 * 1024);
    const streamOversizeModels = new Models(dir, {
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          chunksSent++;
          controller.enqueue(chunk1MiB);
        },
        cancel() { streamOversizeCanceled = true; },
      }), { status: 200 }),
    });
    await assert.rejects(streamOversizeModels.catalog({ provider }), { status: 502 });
    assert.equal(streamOversizeCanceled, true, 'oversized streamed body must be canceled');
    assert.ok(chunksSent <= 18, `expected bounded streaming read, sent ${chunksSent} MiB chunks`);

    // 3. Large array (150,000 items) must NOT hit call-stack overflow and must cap cleanly at 2,000 models
    const hugeList = Array.from({ length: 150_000 }, (_, i) => ({ id: `m${i}` }));
    const hugePayload = JSON.stringify({ data: hugeList });
    assert.ok(Buffer.byteLength(hugePayload, 'utf8') < 16 * 1024 * 1024);
    const hugeModels = new Models(dir, {
      fetchImpl: async () => new Response(hugePayload, { status: 200 }),
    });
    const hugeRes = await hugeModels.catalog({ provider });
    assert.equal(hugeRes.models.length, 2000);
    assert.equal(hugeRes.models[0].id, 'm0');
    assert.equal(hugeRes.models[1999].id, 'm1999');

    // 4. 2-step Anthropic cursor cycle (A -> B -> A) terminates immediately without extra requests
    const anthProvider = { id: 'a1', name: 'Anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'test-key' };
    const cursorCalls = [];
    const cycleModels = new Models(dir, {
      fetchImpl: async (url) => {
        cursorCalls.push(url);
        const after = new URL(url).searchParams.get('after_id') ?? '';
        if (after === '') {
          return new Response(JSON.stringify({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'cursor-A' }), { status: 200 });
        }
        if (after === 'cursor-A') {
          return new Response(JSON.stringify({ data: [{ id: 'claude-b' }], has_more: true, last_id: 'cursor-B' }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ id: 'claude-c' }], has_more: true, last_id: 'cursor-A' }), { status: 200 });
      },
    });
    const cycleRes = await cycleModels.catalog({ provider: anthProvider });
    assert.equal(cursorCalls.length, 3, '2-step cursor cycle A -> B -> A must stop after 3 fetches');
    assert.deepEqual(cycleRes.models.map((m) => m.id), ['claude-a', 'claude-b', 'claude-c']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Review #9: POST /admin/api/model/catalog rate-limits at 30 req/min via createSelfHostServer', { skip: !dependencies && 'run npm ci --prefix host/server' }, async () => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(os.tmpdir(), 'models-catalog-ratelimit-'));
  try {
    const app = await createSelfHostServer({
      dataDir: dir,
      hostDataDir: join(dir, 'host-data'),
    });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const setupRes = await fetch(`${base}/admin/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-grokbot-csrf': '1' },
        body: JSON.stringify({ setupKey: app.auth.setupKey, password: 'AdminPassword12345!' }),
      });
      assert.equal(setupRes.status, 200);
      const cookie = setupRes.headers.get('set-cookie').split(';')[0];
      const headers = { cookie, 'content-type': 'application/json', 'x-grokbot-csrf': '1' };

      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${base}/admin/api/model/catalog`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ providerId: 'nonexistent-provider' }),
        });
        assert.equal(res.status, 404, `request ${i + 1} should pass rate limiter before 404`);
      }
      const blocked = await fetch(`${base}/admin/api/model/catalog`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ providerId: 'nonexistent-provider' }),
      });
      assert.equal(blocked.status, 429, '31st model catalog request within window must be rate-limited (429)');
    } finally {
      await app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Review #6, #7, #10: model.js guards dialog close, preserves manual edits & non-zero capacity, clears stale auto-fill, and re-validates bulk backfill snapshots', async () => {
  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.name = '';
      this.type = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.open = false;
      this.className = '';
      this.textContent = '';
      this.innerHTML = '';
      this.title = '';
      this.placeholder = '';
      this.style = {};
      this.offsetWidth = 100;
      this.offsetHeight = 100;
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.classList = { contains: (name) => this.className.split(/\s+/).includes(name) };
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === 'object') {
          n.parentNode = this;
          this.children.push(n);
        }
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
    }
    closest() { return null; }
    showPopover() {}
    hidePopover() { this.remove(); }
    getBoundingClientRect() { return { top: 0, right: 100, bottom: 20, left: 0 }; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    addEventListener(type, fn, opts) {
      const list = this.listeners.get(type) ?? [];
      list.push({ fn, once: Boolean(opts?.once) });
      this.listeners.set(type, list);
    }
    dispatch(type) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter((item) => !item.once));
      for (const item of list) item.fn({ type, target: this });
    }
    focus() {}
    reset() {}
    reportValidity() { return true; }
    showModal() { this.open = true; }
    close() {
      if (!this.open) return;
      this.open = false;
      this.dispatch('close');
    }
    descendants() {
      const out = [];
      const walk = (el) => {
        if (!Array.isArray(el?.children)) return;
        for (const child of el.children) {
          out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    get elements() {
      const map = {};
      for (const el of this.descendants()) {
        if (el.name) map[el.name] = el;
      }
      return map;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    querySelectorAll(sel) {
      const all = this.descendants();
      if (sel.startsWith('#')) return all.filter((el) => el.id === sel.slice(1));
      if (sel.startsWith('[name=')) {
        const name = sel.slice(6, -1).replace(/^["']|["']$/g, '');
        return all.filter((el) => el.name === name);
      }
      if (sel === '[role=status]') return all.filter((el) => el.getAttribute?.('role') === 'status');
      return all.filter((el) => el.tagName === sel.toUpperCase());
    }
  }

  const byId = new Map();
  const makeTracked = (tag, id) => {
    const el = new FakeElement(tag);
    el.id = id;
    byId.set(id, el);
    return el;
  };
  const panel = new FakeElement('section');
  panel.setAttribute('data-panel', 'model');
  const form = makeTracked('form', 'model-form');
  for (const [tag, id] of [
    ['div', 'model-providers'],
    ['div', 'model-profiles'],
    ['div', 'model-default-route'],
    ['div', 'model-bot-routes'],
    ['button', 'add-model-provider'],
    ['button', 'add-model-profile'],
    ['button', 'auto-fill-model-contexts'],
    ['button', 'refresh-model-bots'],
    ['button', 'refresh-routing'],
    ['p', 'legacy-routing-notice'],
    ['p', 'model-error'],
    ['span', 'model-apply-title'],
    ['div', 'routing-log'],
  ]) {
    form.append(makeTracked(tag, id));
  }
  panel.append(form);

  const prevDoc = globalThis.document;
  const prevNav = globalThis.navigator;
  const prevOption = globalThis.Option;
  const prevNodeFilter = globalThis.NodeFilter;
  const prevInnerWidth = globalThis.innerWidth;
  const prevInnerHeight = globalThis.innerHeight;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.innerWidth = 1024;
  globalThis.innerHeight = 768;
  globalThis.Option = class FakeOption {
    constructor(text = '', value = '') {
      this.text = text;
      this.value = value;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', languages: ['zh-CN'] },
    configurable: true,
    writable: true,
  });
  globalThis.document = {
    documentElement: { lang: '' },
    body: new FakeElement('body'),
    createElement: (tag) => {
      if (tag === 'template') {
        return { innerHTML: '', content: { querySelectorAll: () => [] } };
      }
      return new FakeElement(tag);
    },
    createTreeWalker: () => ({ nextNode: () => false }),
    querySelector: (sel) => {
      if (sel === '[data-panel=model]') return panel;
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        return byId.get(id) ?? panel.querySelector(sel);
      }
      return panel.querySelector(sel);
    },
    querySelectorAll: (sel) => panel.querySelectorAll(sel),
  };

  try {
    const { createModelPage } = await import('../server/public/model.js');
    const toasts = [];
    let apiHandler = async () => ({});
    const apiCalls = [];
    const page = createModelPage({
      api: (path, opts) => {
        apiCalls.push({ path, body: opts?.body });
        return apiHandler(path, opts);
      },
      toast: (msg, err) => toasts.push({ msg, err: Boolean(err) }),
      busy: async (_ctrl, work) => work(),
      refresh: async () => {},
    });

    const baseConfig = {
      version: 1,
      configured: true,
      providers: [
        { id: 'prov-1', name: 'OpenAI', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', hasApiKey: true },
      ],
      profiles: [
        { id: 'prof-existing', name: 'Existing', providerId: 'prov-1', model: 'claude-opus-4-6', efforts: ['high'], contextWindowTokens: 200_000, summaryThresholdTokens: 0 },
      ],
      defaultRoute: { profileId: 'prof-existing', effort: 'default', fallbacks: [] },
      botRoutes: {},
    };
    page.status({ model: baseConfig, host: { agents: [] } }, false);

    const dialog = panel.querySelector('#model-profile-editor');
    const addBtn = byId.get('add-model-profile');
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    // --- Finding #6a: Dialog close guard prevents stale resolve/catalog from mutating reopened dialog ---
    let resolveFirst;
    apiHandler = (path) => {
      if (path === '/admin/api/model/resolve') {
        return new Promise((r) => { resolveFirst = r; });
      }
      return Promise.resolve({ models: [] });
    };
    addBtn.onclick();
    assert.equal(dialog.open, true);
    const form1 = dialog.querySelector('form');
    form1.elements.model.value = 'gpt-5.2';
    form1.elements.model.onchange();
    dialog.close();
    // Reopen dialog for a fresh profile while first resolve is still in flight
    addBtn.onclick();
    const form2 = dialog.querySelector('form');
    resolveFirst({
      model: {
        id: 'gpt-5.2',
        efforts: ['low', 'high'],
        contextWindowTokens: 400_000,
        summaryThresholdTokens: 300_000,
        contextSource: 'reference',
        matchedFamily: 'gpt-5',
      },
    });
    await flush();
    assert.equal(form2.elements.contextWindowTokens.value, '', 'stale resolve from closed dialog must not touch reopened dialog');
    assert.equal(form2.elements['effort-high'].checked, false);

    // Catalog close guard: close dialog while /catalog is in flight -> no toast & no DOM update
    let resolveCatalog;
    apiHandler = (path) => {
      if (path === '/admin/api/model/catalog') {
        return new Promise((r) => { resolveCatalog = r; });
      }
      return Promise.resolve({});
    };
    const syncBtn = form2.descendants().find((el) => el.tagName === 'BUTTON' && el.textContent.includes('同步模型'));
    toasts.length = 0;
    syncBtn.onclick();
    dialog.close();
    resolveCatalog({ models: [{ id: 'gpt-5.2', efforts: ['high'], contextWindowTokens: 400_000, summaryThresholdTokens: 300_000, contextSource: 'provider' }] });
    await flush();
    assert.equal(toasts.length, 0, 'stale catalog response after dialog close must not toast');

    // --- Finding #6b: Manual edits to capacity/threshold/efforts cancel in-flight resolve and survive ---
    let resolveManualRace;
    apiHandler = () => new Promise((r) => { resolveManualRace = r; });
    addBtn.onclick();
    const formManual = dialog.querySelector('form');
    formManual.elements.model.value = 'gpt-5.2';
    formManual.elements.model.onchange();
    formManual.elements.contextWindowTokens.value = '256K';
    formManual.elements.contextWindowTokens.oninput();
    resolveManualRace({
      model: {
        id: 'gpt-5.2',
        efforts: ['low', 'high'],
        contextWindowTokens: 400_000,
        summaryThresholdTokens: 300_000,
        contextSource: 'reference',
        matchedFamily: 'gpt-5',
      },
    });
    await flush();
    assert.equal(formManual.elements.contextWindowTokens.value, '256K', 'manual capacity edit must not be overwritten by in-flight resolve');
    assert.equal(formManual.elements.summaryThresholdTokens.value, '192K');
    dialog.close();

    // Effort checkbox manual edit cancels in-flight resolve
    let resolveEffortRace;
    apiHandler = () => new Promise((r) => { resolveEffortRace = r; });
    addBtn.onclick();
    const formEffort = dialog.querySelector('form');
    formEffort.elements.model.value = 'gpt-5.2';
    formEffort.elements.model.onchange();
    formEffort.elements['effort-high'].checked = true;
    formEffort.elements['effort-high'].onchange();
    resolveEffortRace({
      model: {
        id: 'gpt-5.2',
        efforts: ['low'],
        contextWindowTokens: 400_000,
        summaryThresholdTokens: 300_000,
        contextSource: 'reference',
        matchedFamily: 'gpt-5',
      },
    });
    await flush();
    assert.equal(formEffort.elements['effort-high'].checked, true, 'manual effort edit must not be overwritten by in-flight resolve');
    assert.equal(formEffort.elements['effort-low'].checked, false);
    dialog.close();

    // --- Finding #7a: Switching from known auto-filled model to unknown model clears auto-filled values & family hint ---
    apiCalls.length = 0;
    apiHandler = async (_path, opts) => {
      if (opts?.body?.model === 'gpt-5.2') {
        return {
          model: {
            id: 'gpt-5.2',
            efforts: ['low', 'high'],
            contextWindowTokens: 400_000,
            summaryThresholdTokens: 300_000,
            contextSource: 'reference',
            matchedFamily: 'gpt-5',
          },
        };
      }
      return {
        model: {
          id: opts?.body?.model,
          efforts: [],
          contextWindowTokens: 0,
          summaryThresholdTokens: 0,
          contextSource: 'unknown',
        },
      };
    };
    addBtn.onclick();
    const formUnknown = dialog.querySelector('form');
    const statusHint = formUnknown.querySelector('[role=status]');
    formUnknown.elements.model.value = 'gpt-5.2';
    formUnknown.elements.model.onchange();
    await flush();
    assert.equal(formUnknown.elements.contextWindowTokens.value, '400K');
    assert.equal(formUnknown.elements.summaryThresholdTokens.value, '300K');
    assert.match(statusHint.textContent, /gpt-5/);
    // Deduplicate onchange when trimmed ID already resolved
    const callsAfterFirst = apiCalls.length;
    formUnknown.elements.model.onchange();
    await flush();
    assert.equal(apiCalls.length, callsAfterFirst, 'duplicate onchange for already-resolved ID must not re-fetch');
    // Now switch to unknown model -> auto-filled values and stale family hint must clear
    formUnknown.elements.model.value = 'private-unknown-v9';
    formUnknown.elements.model.onchange();
    await flush();
    assert.equal(formUnknown.elements.contextWindowTokens.value, '', 'auto-filled capacity must clear for unknown model');
    assert.equal(formUnknown.elements.summaryThresholdTokens.value, '', 'auto-filled threshold must clear for unknown model');
    assert.doesNotMatch(statusHint.textContent, /gpt-5/);
    assert.match(statusHint.textContent, /未知/);
    // Manual capacity entered on unknown model stays and updates hint to manual when switching to another unknown model
    formUnknown.elements.contextWindowTokens.value = '64K';
    formUnknown.elements.contextWindowTokens.oninput();
    formUnknown.elements.model.value = 'private-unknown-v10';
    formUnknown.elements.model.onchange();
    await flush();
    assert.equal(formUnknown.elements.contextWindowTokens.value, '64K', 'manual capacity must be preserved on unknown model');
    assert.match(statusHint.textContent, /手动/);
    dialog.close();

    // --- Finding #7b: onlyMissingContext: true must NEVER overwrite non-zero capacity when threshold is 0 ---
    // Open the existing profile (200K capacity, 0 threshold) via its menu's Edit action
    const profilesRoot = byId.get('model-profiles');
    const menuTrigger = profilesRoot.descendants().find((el) => el.getAttribute?.('aria-haspopup') === 'menu');
    menuTrigger.dispatch('click');
    const editMenuItem = document.body.descendants().find((el) => el.getAttribute?.('role') === 'menuitem' && el.textContent === '编辑');
    editMenuItem.dispatch('click');
    const formEdit = dialog.querySelector('form');
    assert.equal(formEdit.elements.contextWindowTokens.value, '200K');
    assert.equal(formEdit.elements.summaryThresholdTokens.value, '');
    apiHandler = async (path) => {
      if (path === '/admin/api/model/catalog') {
        return {
          models: [{
            id: 'claude-opus-4-6',
            efforts: ['none', 'low', 'medium', 'high', 'max'],
            contextWindowTokens: 1_000_000,
            summaryThresholdTokens: 750_000,
            contextSource: 'provider',
          }],
        };
      }
      return {};
    };
    const editSyncBtn = formEdit.descendants().find((el) => el.tagName === 'BUTTON' && el.textContent.includes('同步模型'));
    editSyncBtn.onclick();
    await flush();
    assert.equal(formEdit.elements.contextWindowTokens.value, '200K', 'onlyMissingContext must not overwrite non-zero capacity');
    assert.equal(formEdit.elements.summaryThresholdTokens.value, '', 'onlyMissingContext must not overwrite intentional empty threshold');
    assert.equal(formEdit.elements['effort-high'].checked, true);
    assert.equal(formEdit.elements['effort-low'].checked, false, 'existing manual efforts must not be overwritten by sync');
    dialog.close();

    // --- Finding #10: Bulk backfill snapshots re-lookup live profiles after await ---
    page.status({
      model: {
        version: 1,
        configured: true,
        providers: baseConfig.providers,
        profiles: [
          { id: 'prof-mutated', name: 'Mutated', providerId: 'prov-1', model: 'gpt-5.2', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
          { id: 'prof-intact', name: 'Intact', providerId: 'prov-1', model: 'deepseek-chat', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
        ],
        defaultRoute: { profileId: 'prof-mutated', effort: 'default', fallbacks: [] },
        botRoutes: {},
      },
      host: { agents: [] },
    }, false);
    // Reload clean config via page.load()
    apiHandler = async (path) => {
      if (path === '/admin/api/model') {
        return {
          version: 1,
          configured: true,
          providers: baseConfig.providers,
          profiles: [
            { id: 'prof-mutated', name: 'Mutated', providerId: 'prov-1', model: 'gpt-5.2', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
            { id: 'prof-intact', name: 'Intact', providerId: 'prov-1', model: 'deepseek-chat', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
          ],
          defaultRoute: { profileId: 'prof-mutated', effort: 'default', fallbacks: [] },
          botRoutes: {},
        };
      }
      return {};
    };
    await page.load();

    let resolveBackfill;
    apiHandler = (path) => {
      if (path === '/admin/api/model/resolve') {
        return new Promise((r) => { resolveBackfill = r; });
      }
      return Promise.resolve({});
    };
    const autoFillBtn = byId.get('auto-fill-model-contexts');
    const backfillDone = autoFillBtn.onclick();

    // While /admin/api/model/resolve is in flight, user edits prof-mutated to a different model ('custom-local') and saves it!
    const mutatedMenu = byId.get('model-profiles').descendants().find((el) => el.getAttribute?.('aria-haspopup') === 'menu');
    mutatedMenu.dispatch('click');
    const editMutatedItem = document.body.descendants().find((el) => el.getAttribute?.('role') === 'menuitem' && el.textContent === '编辑');
    editMutatedItem.dispatch('click');
    const formMut = dialog.querySelector('form');
    formMut.elements.model.value = 'custom-local';
    formMut.elements.model.oninput();
    formMut.onsubmit({ preventDefault() {} });
    await flush();

    // Now resolve the bulk backfill with specs for [gpt-5.2, deepseek-chat]
    resolveBackfill({
      models: [
        { id: 'gpt-5.2', efforts: ['high'], contextWindowTokens: 400_000, summaryThresholdTokens: 300_000, contextSource: 'reference' },
        { id: 'deepseek-chat', efforts: [], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000, contextSource: 'reference' },
      ],
    });
    await backfillDone;
    await flush();

    // Save the page form to inspect the exact serialized payload sent to PUT /admin/api/model
    let savedPayload;
    apiHandler = async (path, opts) => {
      if (path === '/admin/api/model' && opts?.method === 'PUT') {
        savedPayload = opts.body;
        return { ...opts.body, configured: true };
      }
      return {};
    };
    form.onsubmit({ preventDefault() {}, submitter: new FakeElement('button') });
    await flush();

    assert.ok(savedPayload, 'saving form should submit serialized profiles');
    const mutatedOut = savedPayload.profiles.find((p) => p.id === 'prof-mutated');
    const intactOut = savedPayload.profiles.find((p) => p.id === 'prof-intact');
    assert.equal(mutatedOut.model, 'custom-local');
    assert.equal(mutatedOut.contextWindowTokens, 0, 'profile whose model changed during backfill must NOT inherit old model capacity');
    assert.equal(intactOut.model, 'deepseek-chat');
    assert.equal(intactOut.contextWindowTokens, 128_000, 'untouched profile must still be backfilled');
    assert.equal(intactOut.summaryThresholdTokens, 96_000);

    // --- Upstream efforts sync in model.js: setConfig hydrates auto efforts ---
    apiHandler = async (path) => {
      if (path === '/admin/api/model') {
        return {
          version: 1,
          configured: true,
          providers: baseConfig.providers,
          profiles: [
            {
              id: 'prof-luna-ui',
              name: 'Luna UI',
              providerId: 'prov-1',
              model: 'gpt-5.6-luna',
              efforts: ['max'],
              effortsMode: 'auto',
              contextWindowTokens: 0,
              summaryThresholdTokens: 0,
              contextMode: 'auto',
              effectiveContext: { contextWindowTokens: 272_000, summaryThresholdTokens: 204_000, contextSource: 'provider', contextMode: 'auto' },
              effectiveEfforts: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortsSource: 'provider', effortsMode: 'auto' },
            },
          ],
          defaultRoute: { profileId: 'prof-luna-ui', effort: 'max', fallbacks: [] },
          botRoutes: {},
        };
      }
      return {};
    };
    await page.load();
    let savedAutoPayload;
    apiHandler = async (path, opts) => {
      if (path === '/admin/api/model' && opts?.method === 'PUT') {
        savedAutoPayload = opts.body;
        return { ...opts.body, configured: true };
      }
      return {};
    };
    form.onsubmit({ preventDefault() {}, submitter: new FakeElement('button') });
    await flush();
    assert.deepEqual(savedAutoPayload.profiles[0].efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(savedAutoPayload.profiles[0].effortsMode, 'auto');
  } finally {
    globalThis.document = prevDoc;
    globalThis.Option = prevOption;
    globalThis.NodeFilter = prevNodeFilter;
    globalThis.innerWidth = prevInnerWidth;
    globalThis.innerHeight = prevInnerHeight;
    Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true, writable: true });
  }
});

test('Auto-sync: background sync, auto-follow mode, persisted observed ceilings, and upstream-first resolve', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-auto-ctx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let upstreamWindow = 512_000;
  let catalogCalls = 0;
  const fakeFetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://relay-a.example/v1/models')) {
      catalogCalls++;
      return new Response(JSON.stringify({
        data: [
          { id: 'custom-private-x', context_window: upstreamWindow },
          { id: 'claude-sonnet-4-6', context_window: 300_000 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('ECONNREFUSED');
  };

  // 1. Validate contextMode normalization & persistence in model-routing
  const validated = validateModelRouting({
    version: 1,
    providers: [
      { id: 'p-a', name: 'Relay A', apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1', apiKey: 'sk-secret-a' },
      { id: 'p-b', name: 'Offline B', apiFormat: 'openai', baseUrl: 'https://offline-b.example/v1', apiKey: 'sk-secret-b' },
    ],
    profiles: [
      { id: 'auto-custom', name: 'Auto Custom', providerId: 'p-a', model: 'custom-private-x', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'auto-known', name: 'Auto Known', providerId: 'p-a', model: 'claude-sonnet-4-6', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
      { id: 'manual-lock', name: 'Manual Lock', providerId: 'p-a', model: 'custom-private-x', efforts: [], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 },
      { id: 'offline-spec', name: 'Offline Spec', providerId: 'p-b', model: 'deepseek-chat', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
    ],
    defaultRoute: { profileId: 'auto-custom', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(validated.profiles.find(p => p.id === 'auto-custom').contextMode, 'auto');
  assert.equal(validated.profiles.find(p => p.id === 'auto-known').contextMode, 'auto');
  assert.equal(validated.profiles.find(p => p.id === 'manual-lock').contextMode, 'manual');
  assert.equal(validated.profiles.find(p => p.id === 'offline-spec').contextMode, 'auto');

  // 2. Sync all configured providers directly via Models and verify cache privacy + publicConfig
  const models = new Models(dir, {
    fetchImpl: fakeFetch,
    autoSync: true,
  });
  t.after(() => models.close());

  await models.save({ ...validated, migrateLegacyRouting: true });
  await models.syncAllProviders({ force: true });
  assert.ok(catalogCalls >= 1, 'should fetch upstream /models');

  // Cache file must never contain API keys or provider URLs in plaintext
  const cachePath = contextCacheFilePath(dir);
  const rawCacheText = await readFile(cachePath, 'utf8');
  assert.equal(rawCacheText.includes('sk-secret-a'), false, 'cache must never store API keys');
  assert.equal(rawCacheText.includes('relay-a.example'), false, 'cache must hash provider URLs');

  // publicConfig exposes effectiveContext for every profile without breaking manual lock
  const pub = await models.publicConfig();
  const byId = new Map(pub.profiles.map(p => [p.id, p]));
  assert.equal(byId.get('auto-custom').effectiveContext.contextWindowTokens, 512_000);
  assert.equal(byId.get('auto-custom').effectiveContext.summaryThresholdTokens, 384_000);
  assert.equal(byId.get('auto-custom').effectiveContext.contextSource, 'provider');
  // Upstream provider-reported 300K overrides 1M static reference spec for auto-known!
  assert.equal(byId.get('auto-known').effectiveContext.contextWindowTokens, 300_000);
  assert.equal(byId.get('auto-known').effectiveContext.contextSource, 'provider');
  // Manual lock stays 128K despite upstream 512K
  assert.equal(byId.get('manual-lock').effectiveContext.contextWindowTokens, 128_000);
  assert.equal(byId.get('manual-lock').effectiveContext.contextSource, 'manual');
  // Offline provider falls back cleanly to built-in reference spec (128K)
  assert.equal(byId.get('offline-spec').effectiveContext.contextWindowTokens, 128_000);
  assert.equal(byId.get('offline-spec').effectiveContext.contextSource, 'reference');
  assert.equal(pub.contextSync.providers['p-a'].status, 'ok');
  assert.equal(pub.contextSync.providers['p-b'].status, 'error');

  // 3. POST /admin/api/model/resolve with profiles + preferUpstream prioritizes live upstream API
  upstreamWindow = 640_000;
  const batchRes = await models.resolve({
    profiles: [
      { id: 'auto-custom', providerId: 'p-a', model: 'custom-private-x' },
      { id: 'offline-spec', providerId: 'p-b', model: 'deepseek-chat' },
    ],
    preferUpstream: true,
  });
  assert.equal(batchRes.models[0].contextWindowTokens, 640_000);
  assert.equal(batchRes.models[0].contextSource, 'provider');
  assert.equal(batchRes.models[1].contextWindowTokens, 128_000);
  assert.equal(batchRes.models[1].contextSource, 'reference');

  // 4. Runtime loadModelConfig -> createInference -> createModelSession picks up 640K dynamically without restart!
  const loaded = await loadModelConfig({ env: { GROKBOT_MODEL_ENV: join(dir, 'model.env'), GROKBOT_DATA_DIR: dir } });
  assert.equal(loaded.dataDirectory, dir);
  const sseOk = () => new Response(
    `data: ${JSON.stringify({ id: 'chat_ok', model: 'custom-private-x', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  class StubErr extends Error {}
  const stubLib = {
    PrivacyMode: { NO_STORAGE: 'no-storage' },
    ConnectError: StubErr, ActionRequiredError: StubErr, NonRetriableError: StubErr,
    InputTokenLimitError: StubErr,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  };
  let failWithOverflow = false;
  const inference = createInference(loaded, stubLib, {}, {
    fetchImpl: async () => {
      if (failWithOverflow) {
        return new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'This model maximum context length is 200000 tokens.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOk();
    },
  });

  // Turn 1: auto-follow sees live 640K / 480K from disk cache
  const s1 = inference.port.createSession(() => {}, {});
  const r1 = s1.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn-1', []);
  for await (const _ of r1.fullStream) {}
  const resp1 = await r1.response;
  assert.equal(resp1.supportsSelfSummary, true);
  assert.equal(resp1.earlyCompactionContextTokenThreshold, 480_000);

  // Turn 2: upstream throws overflow citing real ceiling 200K -> persisted to /data/model-context-cache.json!
  failWithOverflow = true;
  const s2 = inference.port.createSession(() => {}, {});
  const r2 = s2.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'turn-2', []);
  await assert.rejects(async () => { for await (const _ of r2.fullStream) {} });
  // Give async persistence a tick to flush
  await new Promise(resolve => setTimeout(resolve, 60));
  const diskAfterOverflow = await readContextCache(cachePath);
  const persistedEntries = Object.values(diskAfterOverflow.observed);
  assert.equal(persistedEntries.length, 1);
  assert.equal(persistedEntries[0].contextWindowTokens, 200_000);

  // Turn 3: simulate container restart (brand-new session with empty in-memory observedCeilings Map!)
  failWithOverflow = false;
  const freshSession = createModelSession({
    baseUrl: 'https://relay-a.example/v1',
    apiKey: 'sk-secret-a',
    apiFormat: 'openai',
    model: 'custom-private-x',
    contextMode: 'auto',
    contextWindowTokens: 0,
    summaryThresholdTokens: 0,
    observedCeilings: new Map(),
    contextCachePath: cachePath,
    fetchImpl: async () => sseOk(),
  });
  const r3 = freshSession.getExecutor([{ role: 'user', content: 'after restart' }]).stream({}, 'turn-3', []);
  for await (const _ of r3.fullStream) {}
  const resp3 = await r3.response;
  assert.equal(resp3.earlyCompactionContextTokenThreshold, 150_000, 'persisted 200K ceiling must survive restart and clamp to 150K');

  // Turn 4: later upstream /models sync reports expanded 1M window -> newer syncedAt supersedes older disk observed ceiling!
  await recordCatalogSync(cachePath,
    { id: 'p-a', apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1' },
    [{ id: 'custom-private-x', contextWindowTokens: 1_000_000, contextSource: 'provider', efforts: [] }],
    { now: Date.now() + 10_000 });
  const expanded = resolveEffectiveContext(
    { apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1', model: 'custom-private-x', contextMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0 },
    { cache: await readContextCache(cachePath), observedCeilings: new Map() },
  );
  assert.equal(expanded.contextWindowTokens, 1_000_000);
  assert.equal(expanded.summaryThresholdTokens, 750_000);
  assert.equal(expanded.contextSource, 'provider');
});

test('Codex manifest enrichment: Sub2API /models?client_version=0.160.0 supplies context_window, reasoning levels, and region-prefix matching', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-codex-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fetchedUrls = [];
  const models = new Models(dir, {
    fetchImpl: async (url) => {
      const href = String(url);
      fetchedUrls.push(href);
      if (href.includes('client_version=')) {
        return new Response(JSON.stringify({
          models: [
            {
              slug: 'deepseek-v4.1-flash',
              context_window: 1_000_000,
              max_context_window: 1_000_000,
              supported_reasoning_levels: [],
            },
            {
              slug: 'gpt-5.6-terra',
              context_window: 272_000,
              max_context_window: 872_000,
              supported_reasoning_levels: [
                { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
                { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
              ],
            },
            {
              slug: 'kimi-k3.1-pro',
              context_window: 272_000,
              max_context_window: 272_000,
              supported_reasoning_levels: [{ effort: 'none' }],
            },
            {
              slug: 'only-max-window-model',
              max_context_window: 872_000,
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [
          { id: 'deepseek-v4.1-flash', type: 'model', display_name: 'deepseek-v4.1-flash', created_at: '2024-01-01T00:00:00Z' },
          { id: 'gpt-5.6-terra', type: 'model', display_name: 'gpt-5.6-terra', created_at: '2024-01-01T00:00:00Z' },
          { id: 'kimi-k3.1-pro', type: 'model', display_name: 'kimi-k3.1-pro', created_at: '2024-01-01T00:00:00Z' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const provider = { id: 'sub2api', name: 'Sub2API', apiFormat: 'openai', baseUrl: 'https://sub2api.example/v1', apiKey: 'test-sub2api-key' };
  const res = await models.catalog({ provider });
  assert.equal(fetchedUrls.length, 2, 'should automatically probe ?client_version= when bare /models omits context limits');
  assert.match(fetchedUrls[1], /client_version=0\.160\.0/);

  const byId = new Map(res.models.map(item => [item.id, item]));
  // deepseek-v4.1-flash gets 1M/750K from manifest and keeps built-in deepseek-v4 efforts when manifest levels are []
  assert.equal(byId.get('deepseek-v4.1-flash').contextWindowTokens, 1_000_000);
  assert.equal(byId.get('deepseek-v4.1-flash').summaryThresholdTokens, 750_000);
  assert.equal(byId.get('deepseek-v4.1-flash').contextSource, 'provider');
  assert.deepEqual(byId.get('deepseek-v4.1-flash').efforts, ['none', 'low', 'high', 'max']);

  // gpt-5.6-terra adopts safe context_window (272K) and filters supported_reasoning_levels (ignoring unsupported 'ultra')
  assert.equal(byId.get('gpt-5.6-terra').contextWindowTokens, 272_000);
  assert.equal(byId.get('gpt-5.6-terra').summaryThresholdTokens, 204_000);
  assert.equal(byId.get('gpt-5.6-terra').contextSource, 'provider');
  assert.deepEqual(byId.get('gpt-5.6-terra').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

  // Model with only max_context_window falls back cleanly to 872K / 654K
  assert.equal(byId.get('only-max-window-model').contextWindowTokens, 872_000);
  assert.equal(byId.get('only-max-window-model').summaryThresholdTokens, 654_000);
  assert.equal(byId.get('only-max-window-model').contextSource, 'provider');

  // Region-prefixed model (cn:kimi-k3.1-pro) matches cached upstream kimi-k3.1-pro in both resolveEffectiveContext and Models.resolve
  assert.equal(normalizeModelId('cn:kimi-k3.1-pro'), 'kimi-k3.1-pro');
  const cache = await readContextCache(contextCacheFilePath(dir));
  const resolvedAuto = resolveEffectiveContext(
    { apiFormat: 'openai', baseUrl: 'https://sub2api.example/v1', model: 'cn:kimi-k3.1-pro', contextMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0 },
    { cache },
  );
  assert.equal(resolvedAuto.contextWindowTokens, 272_000);
  assert.equal(resolvedAuto.summaryThresholdTokens, 204_000);
  assert.equal(resolvedAuto.contextSource, 'provider');

  // Non-Codex gateway returning 400 on ?client_version= must gracefully preserve bare /models without failing
  const plainModels = new Models(dir, {
    fetchImpl: async (url) => {
      if (String(url).includes('client_version=')) {
        return new Response('unsupported query', { status: 400 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
    },
  });
  const plainRes = await plainModels.catalog({
    provider: { id: 'plain', name: 'Plain', apiFormat: 'openai', baseUrl: 'https://plain.example/v1', apiKey: 'test-key' },
  });
  assert.equal(plainRes.models.length, 1);
  assert.equal(plainRes.models[0].id, 'deepseek-chat');
  assert.equal(plainRes.models[0].contextWindowTokens, 128_000);
});

test('HTTP endpoint: POST /admin/api/model/sync-contexts syncs upstream catalogs and returns updated effectiveContext', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-sync-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const app = await createSelfHostServer({
    dataDir: dir,
    hostDataDir: join(dir, 'host-data'),
    modelFetch: async () => new Response(JSON.stringify({
      data: [{ id: 'custom-sync-model', context_window: 384_000 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    modelAutoSync: true,
    modelContextSyncIntervalMs: 0,
    rateLimit: { check() {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());

  const base = `http://127.0.0.1:${app.server.address().port}`;
  const setupRes = await fetch(`${base}/admin/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-grokbot-csrf': '1' },
    body: JSON.stringify({ setupKey: app.auth.setupKey, password: 'AdminPassword12345!' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = setupRes.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', 'x-grokbot-csrf': '1' };

  await app.models.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [{ id: 'p-sync', name: 'Sync Relay', apiFormat: 'openai', baseUrl: 'https://sync.example/v1', apiKey: 'test-key' }],
    profiles: [{ id: 'prof-sync', name: 'Auto Profile', providerId: 'p-sync', model: 'custom-sync-model', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' }],
    defaultRoute: { profileId: 'prof-sync', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });

  const syncRes = await fetch(`${base}/admin/api/model/sync-contexts`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.equal(syncRes.status, 200);
  const payload = await syncRes.json();
  assert.equal(payload.syncResult.ok, 1);
  assert.equal(payload.syncResult.modelsDetected, 1);
  assert.equal(payload.profiles[0].effectiveContext.contextWindowTokens, 384_000);
  assert.equal(payload.profiles[0].effectiveContext.summaryThresholdTokens, 288_000);
  assert.equal(payload.profiles[0].effectiveContext.contextSource, 'provider');
});

test('Upstream reasoning effort sync: effortsMode, effort-only catalog caching, region-prefix matching, publicConfig effectiveEfforts, and runtime session sync', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-efforts-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const models = new Models(dir, {
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes('client_version=')) {
        return new Response(JSON.stringify({
          models: [
            {
              slug: 'gpt-5.6-luna',
              context_window: 272_000,
              supported_reasoning_levels: [
                { effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' },
              ],
            },
            {
              slug: 'kimi-k3.1-pro',
              context_window: 272_000,
              supported_reasoning_levels: [{ effort: 'none' }],
            },
            {
              slug: 'effort-only-custom',
              supported_reasoning_efforts: ['low', 'high'],
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.6-luna' },
          { id: 'kimi-k3.1-pro' },
          { id: 'effort-only-custom' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => models.close());

  const routing = validateModelRouting({
    version: 1,
    providers: [{ id: 'p-sub', name: 'Sub2API', apiFormat: 'openai-responses', baseUrl: 'https://sub2api.example/v1', apiKey: 'test-key' }],
    profiles: [
      { id: 'prof-luna', name: 'Luna', providerId: 'p-sub', model: 'gpt-5.6-luna', efforts: ['max'], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'prof-kimi', name: 'Kimi CN', providerId: 'p-sub', model: 'cn:kimi-k3.1-pro', efforts: ['high'], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'prof-manual', name: 'Manual Lock', providerId: 'p-sub', model: 'gpt-5.6-luna', efforts: ['max'], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 },
      { id: 'prof-effort-only', name: 'Effort Only', providerId: 'p-sub', model: 'effort-only-custom', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
    ],
    defaultRoute: { profileId: 'prof-luna', effort: 'max', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(routing.profiles.find(p => p.id === 'prof-luna').effortsMode, 'auto');
  assert.equal(routing.profiles.find(p => p.id === 'prof-manual').effortsMode, 'manual');
  assert.equal(routing.profiles.find(p => p.id === 'prof-effort-only').effortsMode, 'auto');

  await models.save({ ...routing, migrateLegacyRouting: true });
  const summary = await models.syncAllProviders({ force: true });
  assert.equal(summary.ok, 1);
  assert.equal(summary.modelsDetected, 2);
  assert.equal(summary.effortsDetected, 3);
  assert.equal(summary.providerEfforts, 3);

  const pub = await models.publicConfig();
  const byId = new Map(pub.profiles.map(p => [p.id, p]));
  assert.deepEqual(byId.get('prof-luna').effectiveEfforts, {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortsSource: 'provider',
    effortsMode: 'auto',
  });
  assert.deepEqual(byId.get('prof-kimi').effectiveEfforts, {
    efforts: ['none'],
    effortsSource: 'provider',
    effortsMode: 'auto',
  });
  assert.deepEqual(byId.get('prof-manual').effectiveEfforts, {
    efforts: ['max'],
    effortsSource: 'manual',
    effortsMode: 'manual',
  });
  assert.deepEqual(byId.get('prof-effort-only').effectiveEfforts, {
    efforts: ['low', 'high'],
    effortsSource: 'provider',
    effortsMode: 'auto',
  });

  // Resolve effort-only model from cache without losing provider source
  const resolvedOnly = await models.resolve({ model: 'effort-only-custom', providerId: 'p-sub' });
  assert.deepEqual(resolvedOnly.model.efforts, ['low', 'high']);
  assert.equal(resolvedOnly.model.source, 'provider');
  assert.equal(resolvedOnly.model.contextWindowTokens, 0);

  // Runtime openai-responses session picks up live efforts=['none'] for cn:kimi-k3.1-pro and omits reasoning block!
  const cachePath = contextCacheFilePath(dir);
  let sentBody;
  const session = createModelSession({
    baseUrl: 'https://sub2api.example/v1',
    apiKey: 'test-key',
    apiFormat: 'openai-responses',
    model: 'cn:kimi-k3.1-pro',
    efforts: ['high'],
    effortsMode: 'auto',
    contextMode: 'auto',
    contextCachePath: cachePath,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      const sse = [
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'OK' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', model: 'cn:kimi-k3.1-pro', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })}\n\n`,
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const stream = session.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn-efforts', []);
  for await (const _ of stream.fullStream) {}
  assert.equal(sentBody.reasoning, undefined, 'auto-synced efforts=["none"] must omit reasoning block in openai-responses');

  // Direct resolveEffectiveEfforts respects manual mode and region-prefix normalization
  const cache = await readContextCache(cachePath);
  assert.deepEqual(
    resolveEffectiveEfforts({ apiFormat: 'openai-responses', baseUrl: 'https://sub2api.example/v1', model: 'cn:kimi-k3.1-pro', efforts: ['high'], effortsMode: 'auto' }, { cache }),
    { efforts: ['none'], effortsSource: 'provider', effortsMode: 'auto' },
  );
  assert.deepEqual(
    resolveEffectiveEfforts({ apiFormat: 'openai-responses', baseUrl: 'https://sub2api.example/v1', model: 'cn:kimi-k3.1-pro', efforts: ['high'], effortsMode: 'manual' }, { cache }),
    { efforts: ['high'], effortsSource: 'manual', effortsMode: 'manual' },
  );
});
