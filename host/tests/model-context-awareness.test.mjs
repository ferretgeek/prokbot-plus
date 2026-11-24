import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  extractProviderContextWindow,
  normalizeModelId,
  parseReportedCapacity,
  referenceContextWindow,
} from '../runtime/model-specs.mjs';
import {
  catalogContextPolicy,
  clampSupportedEffort,
  effortLevels,
  resolveModelCapabilities,
  summaryThresholdFor,
} from '../runtime/model-policy.mjs';
import {
  createHarnessModelErrorMapper,
  isInputTokenLimitError,
  parseContextLimitDetailsFromError,
  parseContextLimitFromError,
} from '../runtime/model-errors.mjs';
import {
  createModelSession,
  MAX_OBSERVED_CEILINGS,
  OBSERVED_CEILING_TTL_MS,
} from '../runtime/model-session.mjs';
import { createInference } from '../runtime/host-extensions.mjs';
import { loadModelConfig } from '../runtime/config.mjs';
import {
  clearObservedCache,
  contextCacheFilePath,
  invalidateContextCache,
  observedCacheFilePath,
  persistObservedCeiling,
  readContextCache,
  readContextCacheSync,
  recordCatalogSync,
  resolveEffectiveContext,
  updateContextCache,
} from '../runtime/model-context-cache.mjs';
import { validateModelRouting } from '../runtime/model-routing.mjs';
import { ModelRequestError } from '../runtime/model-common.mjs';
import { Models } from '../server/models.mjs';

const exec = promisify(execFile);
const hostAdminCli = fileURLToPath(new URL('../tools/host-admin.mjs', import.meta.url));

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
  assert.equal(parseReportedCapacity(1), undefined);
  assert.equal(parseReportedCapacity(1_023), undefined);
  assert.equal(parseReportedCapacity(1_024), 1_024);
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
    ['gpt-5-chat-latest', 128_000],
    ['gpt-5.4', 1_050_000],
    ['gpt-5.4-mini', 400_000],
    ['claude-3-7-sonnet-20250219', 200_000],
    ['claude-sonnet-4-5-20250929', 200_000],
    ['claude-opus-4-6', 1_000_000],
    ['anthropic/claude-sonnet-4-7:extended', 1_000_000],
    ['google/gemini-2.5-pro-preview-06-05', 1_048_576],
    ['gemini-2.0-flash-thinking-exp-1219', 32_768],
    ['gemini-3-flash', 1_048_576],
    ['deepseek-chat', 128_000],
    ['deepseek-ai/DeepSeek-R1-0528', 128_000],
    ['x-ai/grok-4-fast-reasoning', 2_000_000],
    ['grok-4', 256_000],
    ['grok-3-mini', 131_072],
    ['grok-2-vision', 32_768],
    ['qwen/qwen3-coder-plus', 1_000_000],
    ['qwen3-235b-a22b', 131_072],
    ['qwen3-8b', 32_768],
    ['qwen-max', 32_768],
    ['moonshotai/kimi-k2-thinking', 262_144],
    ['z-ai/glm-4.6', 200_000],
    ['glm-4-airx', 8_192],
    ['minimax/minimax-m2.5', 204_800],
    ['doubao-seed-1-6-thinking', 256_000],
    ['meta-llama/llama-3.3-70b-instruct:free', 131_072],
    ['codestral-2405', 32_768],
    ['mistral-small-2501', 32_768],
  ];
  for (const [id, expectedTokens] of expectations) {
    const policy = catalogContextPolicy(id);
    assert.equal(policy.contextWindowTokens, expectedTokens, `expected ${id} -> ${expectedTokens}`);
    assert.equal(policy.summaryThresholdTokens, summaryThresholdFor(expectedTokens));
    assert.equal(policy.contextSource, 'reference');
  }

  // Claude 4.5 1M aliases require a beta header we do not send, so never guess 1M
  assert.equal(referenceContextWindow('claude-sonnet-4-5-1m'), null);

  // Anthropic deducts default 64K max_tokens output reserve before computing 75% threshold
  assert.equal(summaryThresholdFor(200_000, { apiFormat: 'anthropic', model: 'claude-sonnet-4-6' }), 102_000);
  assert.equal(summaryThresholdFor(1_000_000, { apiFormat: 'anthropic', model: 'claude-opus-4-6' }), 702_000);

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
    contextMode: 'auto',
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

  // Case B: auto profile with 1M provider window on a 200K relay -> clamps down to 200K / 150K
  const ceilingsB = new Map();
  let callsB = 0;
  const sessionB = createModelSession({
    ...baseCfg,
    profileId: 'claude-relay',
    model: 'claude-opus-4-6',
    contextMode: 'auto',
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

test('Anthropic overflow parsing, output-token & TPM exclusions, grouped integers, and tightened ceiling patterns', async () => {
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
    'Context window limit of 8192 output tokens exceeded for request (prompt 120000 tokens).',
  ];
  for (const msg of outputErrors) {
    const err = new ModelRequestError(msg, { status: 400, code: 'invalid_request_error' });
    assert.equal(isInputTokenLimitError(err), false, `output error must not be treated as input limit: ${msg}`);
    assert.equal(parseContextLimitFromError(msg), undefined, `output error must not parse ceiling: ${msg}`);
    const mapped = mapError(err);
    assert.ok(mapped instanceof NonRetriableError, `output error should map to NonRetriableError: ${msg}`);
  }

  // 413 TPM / rate-limit errors mentioning "input exceeds maximum tokens per minute" must NOT match input token limit
  const tpmErr = new ModelRequestError('Your input exceeds the maximum tokens per minute', { status: 413 });
  assert.equal(isInputTokenLimitError(tpmErr), false);
  assert.equal(parseContextLimitFromError(tpmErr.message), undefined);
  assert.ok(mapError(tpmErr) instanceof NonRetriableError);

  // Comparison a + b > c parses reserve for output-aware threshold adjustment
  assert.deepEqual(
    parseContextLimitDetailsFromError('input length and max_tokens exceed context limit: 140000 + 64000 > 200000'),
    { limit: 200_000, reserve: 64_000, isComparison: true },
  );

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

test('Progressive snapshot stripping fixes o1-preview/o1-mini 128K and splits doubao-1.5 rules', () => {
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

test('Observed ceiling key isolation, equal-window reserve clamping, TTL expiry, and cap eviction', async () => {
  // Finding #4: observedCeilingKey scopes by (apiFormat, baseUrl, model), NOT profileId
  const ceilings = new Map();
  let calls = 0;
  const sessionSmall = createModelSession({
    baseUrl: 'https://relay-a.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'small-32k-model',
    profileId: 'shared-profile-id',
    contextMode: 'auto',
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

  // configuredWindow === observedLimit with summaryThresholdTokens === 0 in auto mode activates compaction
  const eqCeilings = new Map();
  let eqCalls = 0;
  const sessionEqZero = createModelSession({
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextMode: 'auto',
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
    summaryThresholdTokens: 135_000,
  });
  const resEq2 = sessionEqZero.getExecutor([{ role: 'user', content: 'compacted' }]).stream({}, 'eq-2', []);
  for await (const _p of resEq2.fullStream) { /* consume */ }
  const respEq2 = await resEq2.response;
  assert.equal(respEq2.supportsSelfSummary, true);
  assert.equal(respEq2.earlyCompactionContextTokenThreshold, 135_000);

  // configuredWindow === observedLimit with 140000 + 64000 > 200000 clamps 150K down to 102K
  const reserveCeilings = new Map();
  const sessionReserve = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextMode: 'auto',
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 150_000,
    observedCeilings: reserveCeilings,
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'input length and max_tokens exceed context limit: 140000 + 64000 > 200000',
      },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _p of sessionReserve.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'res-1', []).fullStream) {
      // consume
    }
  });
  assert.deepEqual(sessionReserve.getLocalContextPolicy(), {
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 102_000,
  });

  // configuredWindow === observedLimit with threshold > summaryThresholdFor(observedLimit) clamps threshold down
  const highThreshCeilings = new Map();
  let htCalls = 0;
  const sessionHighThresh = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextMode: 'auto',
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

  // configuredWindow === observedLimit with already-strict threshold <= summaryThresholdFor bails out early
  const strictCeilings = new Map();
  const sessionStrict = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    contextMode: 'auto',
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
    contextMode: 'auto',
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

test('Models.catalog cancels error bodies, bounds 16 MiB payloads, caps 2000 items, stops cursor cycles, and enforces rate limits', async () => {
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

test('POST /admin/api/model/catalog and /resolve enforce 30 req/min rate limits via createSelfHostServer', { skip: !dependencies && 'run npm ci --prefix host/server' }, async () => {
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
      const blockedCatalog = await fetch(`${base}/admin/api/model/catalog`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ providerId: 'nonexistent-provider' }),
      });
      assert.equal(blockedCatalog.status, 429, '31st model catalog request within window must be rate-limited (429)');

      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${base}/admin/api/model/resolve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'deepseek-chat' }),
        });
        assert.equal(res.status, 200, `resolve request ${i + 1} should pass rate limiter`);
      }
      const blockedResolve = await fetch(`${base}/admin/api/model/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'deepseek-chat' }),
      });
      assert.equal(blockedResolve.status, 429, '31st model resolve request within window must be rate-limited (429)');
    } finally {
      await app.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Auto-sync: background sync, no built-in guesses in auto mode, 2-strike/comparison persistence, and manual/periodic clearing', async t => {
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

  // 1. Legacy profiles omitting contextMode / effortsMode stay manual (never silently switched to auto)
  const validated = validateModelRouting({
    version: 1,
    providers: [
      { id: 'p-a', name: 'Relay A', apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1', apiKey: 'sk-secret-a' },
      { id: 'p-b', name: 'Offline B', apiFormat: 'openai', baseUrl: 'https://offline-b.example/v1', apiKey: 'sk-secret-b' },
    ],
    profiles: [
      { id: 'auto-custom', name: 'Auto Custom', providerId: 'p-a', model: 'custom-private-x', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'auto-known', name: 'Auto Known', providerId: 'p-a', model: 'claude-sonnet-4-6', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'manual-lock', name: 'Manual Lock', providerId: 'p-a', model: 'custom-private-x', efforts: [], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 },
      { id: 'offline-auto', name: 'Offline Auto', providerId: 'p-b', model: 'deepseek-chat', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'legacy-zero', name: 'Legacy Zero', providerId: 'p-b', model: 'deepseek-chat', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
    ],
    defaultRoute: { profileId: 'auto-custom', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(validated.profiles.find(p => p.id === 'auto-custom').contextMode, 'auto');
  assert.equal(validated.profiles.find(p => p.id === 'auto-known').contextMode, 'auto');
  assert.equal(validated.profiles.find(p => p.id === 'manual-lock').contextMode, 'manual');
  assert.equal(validated.profiles.find(p => p.id === 'offline-auto').contextMode, 'auto');
  assert.equal(validated.profiles.find(p => p.id === 'legacy-zero').contextMode, 'manual');
  assert.equal(validated.profiles.find(p => p.id === 'legacy-zero').effortsMode, 'manual');

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

  // publicConfig exposes effectiveContext for every profile without breaking manual lock or guessing in auto mode
  const pub = await models.publicConfig();
  const byId = new Map(pub.profiles.map(p => [p.id, p]));
  assert.equal(byId.get('auto-custom').effectiveContext.contextWindowTokens, 512_000);
  assert.equal(byId.get('auto-custom').effectiveContext.summaryThresholdTokens, 384_000);
  assert.equal(byId.get('auto-custom').effectiveContext.contextSource, 'provider');
  assert.equal(byId.get('auto-known').effectiveContext.contextWindowTokens, 300_000);
  assert.equal(byId.get('auto-known').effectiveContext.contextSource, 'provider');
  assert.equal(byId.get('manual-lock').effectiveContext.contextWindowTokens, 128_000);
  assert.equal(byId.get('manual-lock').effectiveContext.contextSource, 'manual');
  // Auto mode NEVER falls back to built-in reference table when upstream is unreachable/omitted
  assert.equal(byId.get('offline-auto').effectiveContext.contextWindowTokens, 0);
  assert.equal(byId.get('offline-auto').effectiveContext.contextSource, 'unknown');
  assert.equal(byId.get('legacy-zero').effectiveContext.contextWindowTokens, 0);
  assert.equal(byId.get('legacy-zero').effectiveContext.contextMode, 'manual');
  assert.equal(pub.contextSync.providers['p-a'].status, 'ok');
  assert.equal(pub.contextSync.providers['p-b'].status, 'error');

  // 3. POST /admin/api/model/resolve with profiles + preferUpstream prioritizes live upstream API
  upstreamWindow = 640_000;
  const batchRes = await models.resolve({
    profiles: [
      { id: 'auto-custom', providerId: 'p-a', model: 'custom-private-x' },
      { id: 'offline-auto', providerId: 'p-b', model: 'deepseek-chat' },
    ],
    preferUpstream: true,
  });
  assert.equal(batchRes.models[0].contextWindowTokens, 640_000);
  assert.equal(batchRes.models[0].contextSource, 'provider');
  assert.equal(batchRes.models[1].contextWindowTokens, 128_000);
  assert.equal(batchRes.models[1].contextSource, 'reference');

  // 4. Runtime loadModelConfig -> createInference -> createModelSession picks up 640K dynamically without restart
  const loaded = await loadModelConfig({ env: { GROKBOT_MODEL_ENV: join(dir, 'model.env'), GROKBOT_DATA_DIR: dir } });
  assert.equal(loaded.dataDirectory, dir);
  const sseOkResp = () => new Response(
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
  let overflowErrorMsg = null;
  const inference = createInference(loaded, stubLib, {}, {
    fetchImpl: async () => {
      if (overflowErrorMsg) {
        return new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: overflowErrorMsg } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOkResp();
    },
  });

  // Turn 1: auto-follow sees live 640K / 480K from disk cache
  const s1 = inference.port.createSession(() => {}, {});
  const r1 = s1.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn-1', []);
  for await (const _ of r1.fullStream) {}
  const resp1 = await r1.response;
  assert.equal(resp1.supportsSelfSummary, true);
  assert.equal(resp1.earlyCompactionContextTokenThreshold, 480_000);

  // Turn 2a: single non-comparison overflow heals in-memory WITHOUT writing 30-day disk cache yet
  overflowErrorMsg = 'This model maximum context length is 200000 tokens.';
  const s2a = inference.port.createSession(() => {}, {});
  const r2a = s2a.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'turn-2a', []);
  await assert.rejects(async () => { for await (const _ of r2a.fullStream) {} });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(s2a.getLocalContextPolicy(), { contextWindowTokens: 200_000, summaryThresholdTokens: 150_000 });
  assert.equal(Object.values((await readContextCache(cachePath)).observed).length, 0,
    'single non-comparison overflow must not persist to 30-day disk cache yet');

  // Turn 2b: second consistent observation (200K again) persists to model-context-observed.json!
  const s2b = inference.port.createSession(() => {}, {});
  const r2b = s2b.getExecutor([{ role: 'user', content: 'huge-again' }]).stream({}, 'turn-2b', []);
  await assert.rejects(async () => { for await (const _ of r2b.fullStream) {} });
  await new Promise(resolve => setTimeout(resolve, 60));
  const diskAfterOverflow = await readContextCache(cachePath);
  const persistedEntries = Object.values(diskAfterOverflow.observed);
  assert.equal(persistedEntries.length, 1);
  assert.equal(persistedEntries[0].contextWindowTokens, 200_000);

  // Turn 3: simulate container restart (empty in-memory observedCeilings Map) -> persisted 200K ceiling survives!
  overflowErrorMsg = null;
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
    fetchImpl: async () => sseOkResp(),
  });
  const r3 = freshSession.getExecutor([{ role: 'user', content: 'after restart' }]).stream({}, 'turn-3', []);
  for await (const _ of r3.fullStream) {}
  const resp3 = await r3.response;
  assert.equal(resp3.earlyCompactionContextTokenThreshold, 150_000, 'persisted 200K ceiling must survive restart and clamp to 150K');

  // Turn 4: periodic background sync (clearObserved: false) MUST NOT wipe out the 30-day observed ceiling
  await recordCatalogSync(cachePath,
    { id: 'p-a', apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1' },
    [{ id: 'custom-private-x', contextWindowTokens: 1_000_000, contextSource: 'provider', efforts: [] }],
    { now: Date.now() + 10_000 });
  const stillClamped = resolveEffectiveContext(
    { apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1', model: 'custom-private-x', contextMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0 },
    { cache: await readContextCache(cachePath), observedCeilings: new Map() },
  );
  assert.equal(stillClamped.contextWindowTokens, 200_000);
  assert.equal(stillClamped.contextSource, 'observed');

  // Manual sync (clearObserved: true) or clearObserved API clears the observed ceiling
  await models.syncAllProviders({ force: true, clearObserved: true });
  const clearedAfterManualSync = await models.publicConfig();
  const autoCustomCleared = clearedAfterManualSync.profiles.find(p => p.id === 'auto-custom');
  assert.equal(autoCustomCleared.effectiveContext.contextWindowTokens, 640_000);
  assert.equal(autoCustomCleared.effectiveContext.contextSource, 'provider');
  assert.equal(autoCustomCleared.effectiveContext.observed, undefined);
});

test('Manual mode immunity, comparison-form immediate persistence, clearObserved, and re-save clearing', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-manual-immunity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const models = new Models(dir, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'relay-model', context_window: 500_000 }] }), { status: 200 }),
  });
  t.after(() => models.close());

  await models.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [{ id: 'p1', name: 'Relay', apiFormat: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-1' }],
    profiles: [
      { id: 'manual-128k', name: 'Manual', providerId: 'p1', model: 'relay-model', efforts: ['low'], effortsMode: 'manual', contextWindowTokens: 128_000, summaryThresholdTokens: 96_000, contextMode: 'manual' },
      { id: 'auto-500k', name: 'Auto', providerId: 'p1', model: 'other-model', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
    ],
    defaultRoute: { profileId: 'manual-128k', effort: 'low', fallbacks: [] },
    botRoutes: {},
  });

  // 1. Manual 128K receives an 8192 overflow error -> manual mode is NOT clamped and does NOT record an observed ceiling
  const manualCeilings = new Map();
  const cachePath = contextCacheFilePath(dir);
  const manualSession = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'sk-1',
    model: 'relay-model',
    contextMode: 'manual',
    contextWindowTokens: 128_000,
    summaryThresholdTokens: 96_000,
    observedCeilings: manualCeilings,
    contextCachePath: cachePath,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'prompt is too long: 10000 tokens > 8192 maximum' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of manualSession.getExecutor([{ role: 'user', content: 'x' }]).stream({}, 'm-1', []).fullStream) {}
  });
  assert.equal(manualCeilings.size, 0);
  assert.deepEqual(manualSession.getLocalContextPolicy(), { contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 });

  // Even if a 28-day-old observed ceiling exists on disk (e.g. from an earlier auto session without a subsequent clear), manual mode ignores it (day 29 included)
  await updateContextCache(cachePath, draft => { draft.clearedObserved = { allAt: 0, keys: {} }; });
  await persistObservedCeiling(cachePath, { apiFormat: 'openai', baseUrl: 'https://relay.example/v1', model: 'relay-model' }, {
    contextWindowTokens: 8_192,
    observedAt: Date.now() - 28 * 24 * 60 * 60 * 1000,
  });
  const pubManual = await models.publicConfig();
  const manualProf = pubManual.profiles.find(p => p.id === 'manual-128k');
  assert.equal(manualProf.effectiveContext.contextWindowTokens, 128_000);
  assert.equal(manualProf.effectiveContext.summaryThresholdTokens, 96_000);
  assert.equal(manualProf.effectiveContext.contextSource, 'manual');
  assert.equal(manualProf.effectiveContext.observed.contextWindowTokens, 8_192);

  // 2. Comparison-form error (a + b > c) on an auto profile persists immediately on 1st hit
  const autoCeilings = new Map();
  const autoSession = createModelSession({
    baseUrl: 'https://relay.example/v1',
    apiFormat: 'openai',
    apiKey: 'sk-1',
    model: 'other-model',
    contextMode: 'auto',
    contextWindowTokens: 0,
    summaryThresholdTokens: 0,
    observedCeilings: autoCeilings,
    contextCachePath: cachePath,
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'prompt is too long: 40000 tokens > 32768 maximum' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of autoSession.getExecutor([{ role: 'user', content: 'x' }]).stream({}, 'a-1', []).fullStream) {}
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  let pubAuto = (await models.publicConfig()).profiles.find(p => p.id === 'auto-500k');
  assert.equal(pubAuto.effectiveContext.contextWindowTokens, 32_768);
  assert.equal(pubAuto.effectiveContext.contextSource, 'observed');

  // 3. clearObserved(profileId) clears both disk and in-memory effective check
  await models.clearObserved({ profileId: 'auto-500k' });
  pubAuto = (await models.publicConfig()).profiles.find(p => p.id === 'auto-500k');
  assert.equal(pubAuto.effectiveContext.contextWindowTokens, 0);
  assert.equal(pubAuto.effectiveContext.observed, undefined);
  // In-memory map in autoSession also ignores cleared entry on next resolve
  const resolvedAfterClear = resolveEffectiveContext(
    { apiFormat: 'openai', baseUrl: 'https://relay.example/v1', model: 'other-model', contextMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0 },
    { cache: await readContextCache(cachePath), observedCeilings: autoCeilings },
  );
  assert.equal(resolvedAfterClear.contextWindowTokens, 0);

  // 4. Re-saving config via Models.save() clears observed ceilings for saved profiles
  await persistObservedCeiling(cachePath, { apiFormat: 'openai', baseUrl: 'https://relay.example/v1', model: 'other-model' }, {
    contextWindowTokens: 32_768,
    observedAt: Date.now() + 1_000,
  });
  await models.save({
    version: 1,
    providers: [{ id: 'p1', name: 'Relay', apiFormat: 'openai', baseUrl: 'https://relay.example/v1' }],
    profiles: [
      { id: 'manual-128k', name: 'Manual', providerId: 'p1', model: 'relay-model', efforts: ['low'], effortsMode: 'manual', contextWindowTokens: 128_000, summaryThresholdTokens: 96_000, contextMode: 'manual' },
      { id: 'auto-500k', name: 'Auto', providerId: 'p1', model: 'other-model', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
    ],
    defaultRoute: { profileId: 'manual-128k', effort: 'low', fallbacks: [] },
    botRoutes: {},
  });
  const afterResave = (await models.publicConfig()).profiles.find(p => p.id === 'auto-500k');
  assert.equal(afterResave.effectiveContext.observed, undefined);
});

test('Cache resilience: split cross-process files never clobber each other, and damaged JSON files are cached by mtime/size', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-cache-split-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cachePath = contextCacheFilePath(dir);
  const observedPath = observedCacheFilePath(cachePath);

  // 1. Concurrent catalog sync (writes model-context-cache.json) and observed persist (writes model-context-observed.json)
  await Promise.all([
    recordCatalogSync(
      cachePath,
      { id: 'p1', apiFormat: 'openai', baseUrl: 'https://relay.example/v1' },
      [{ id: 'model-a', contextWindowTokens: 256_000, contextSource: 'provider', efforts: ['low', 'high'], source: 'provider' }],
    ),
    persistObservedCeiling(
      cachePath,
      { apiFormat: 'openai', baseUrl: 'https://relay.example/v1', model: 'model-b' },
      { contextWindowTokens: 32_768, observedAt: Date.now() },
    ),
  ]);
  const combined = await readContextCache(cachePath);
  assert.equal(Object.keys(combined.catalog).length, 1);
  assert.equal(Object.keys(combined.observed).length, 1);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).observed, undefined, 'catalog file must not contain observed');
  assert.equal(JSON.parse(await readFile(observedPath, 'utf8')).catalog, undefined, 'observed file must not contain catalog');

  // 2. Damaged JSON cache files return empty safely and are cached by (mtimeMs, size)
  await writeFile(cachePath, '{broken json', 'utf8');
  await writeFile(observedPath, '{broken observed', 'utf8');
  invalidateContextCache(cachePath);
  const firstRead = readContextCacheSync(cachePath);
  const secondRead = readContextCacheSync(cachePath);
  assert.deepEqual(firstRead.catalog, {});
  assert.deepEqual(firstRead.observed, {});
  assert.deepEqual(secondRead.catalog, {});
  assert.deepEqual(secondRead.observed, {});
});

test('Codex manifest probe is OFF by default, only runs when enabled, and draft providers never pollute shared cache', async t => {
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
              supported_reasoning_levels: [],
            },
            {
              slug: 'gpt-5.6-terra',
              context_window: 272_000,
              supported_reasoning_levels: [
                { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
                { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
              ],
            },
            {
              slug: 'kimi-k3.1-pro',
              context_window: 272_000,
              supported_reasoning_levels: [{ effort: 'none' }],
            },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [
          { id: 'deepseek-v4.1-flash' },
          { id: 'gpt-5.6-terra' },
          { id: 'kimi-k3.1-pro' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => models.close());

  const provider = { id: 'sub2api', name: 'Sub2API', apiFormat: 'openai', baseUrl: 'https://sub2api.example/v1', apiKey: 'test-sub2api-key' };

  // Draft provider (not yet saved) must NOT send client_version and must NOT write to model-context-cache.json
  await models.catalog({ provider });
  assert.equal(fetchedUrls.length, 1, 'Codex client_version probe must be off by default');
  assert.equal(existsSync(contextCacheFilePath(dir)), false, 'draft provider catalog must not write shared cache');

  // Draft provider in resolve() must also not write to shared cache
  await models.resolve({
    providers: [{ ...provider, id: 'draft-p', baseUrl: 'https://draft.example/v1' }],
    profiles: [{ id: 'p-draft', providerId: 'draft-p', model: 'gpt-5.6-terra' }],
    preferUpstream: true,
  });
  assert.equal(existsSync(contextCacheFilePath(dir)), false, 'draft provider in resolve must not write shared cache');

  // Save provider, enable codexManifestProbe explicitly, and sync
  await models.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [provider],
    profiles: [{ id: 'p1', name: 'P1', providerId: 'sub2api', model: 'kimi-k3.1-pro', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' }],
    defaultRoute: { profileId: 'p1', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  await models.saveSyncSettings({ codexManifestProbe: true });
  fetchedUrls.length = 0;

  const res = await models.catalog({ providerId: 'sub2api' });
  assert.equal(fetchedUrls.length, 2, 'should probe ?client_version= when explicitly enabled');
  assert.match(fetchedUrls[1], /client_version=0\.160\.0/);

  const byId = new Map(res.models.map(item => [item.id, item]));
  assert.equal(byId.get('deepseek-v4.1-flash').contextWindowTokens, 1_000_000);
  assert.equal(byId.get('deepseek-v4.1-flash').contextSource, 'provider');
  assert.deepEqual(byId.get('gpt-5.6-terra').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);

  const cache = await readContextCache(contextCacheFilePath(dir));
  const resolvedAuto = resolveEffectiveContext(
    { apiFormat: 'openai', baseUrl: 'https://sub2api.example/v1', model: 'cn:kimi-k3.1-pro', contextMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0 },
    { cache },
  );
  assert.equal(resolvedAuto.contextWindowTokens, 272_000);
  assert.equal(resolvedAuto.contextSource, 'provider');
});

test('HTTP endpoints: autoSync toggle stops all background requests and sync-contexts updates effectiveContext', { skip: !dependencies && 'run npm ci --prefix host/server' }, async t => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-sync-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let catalogFetchCount = 0;
  const app = await createSelfHostServer({
    dataDir: dir,
    hostDataDir: join(dir, 'host-data'),
    modelFetch: async () => {
      catalogFetchCount++;
      return new Response(JSON.stringify({
        data: [{ id: 'custom-sync-model', context_window: 384_000 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
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

  // Turn OFF background autoSync via API
  const toggleRes = await fetch(`${base}/admin/api/model/sync-settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ autoSync: false }),
  });
  assert.equal(toggleRes.status, 200);
  const togglePub = await toggleRes.json();
  assert.equal(togglePub.contextSync.autoSync, false);
  assert.equal(togglePub.contextSync.codexManifestProbe, false);

  catalogFetchCount = 0;
  await app.models.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [{ id: 'p-sync', name: 'Sync Relay', apiFormat: 'openai', baseUrl: 'https://sync.example/v1', apiKey: 'test-key' }],
    profiles: [{ id: 'prof-sync', name: 'Auto Profile', providerId: 'p-sync', model: 'custom-sync-model', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' }],
    defaultRoute: { profileId: 'prof-sync', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(catalogFetchCount, 0, 'save must not trigger background /models when autoSync is disabled');

  // Explicit manual sync still works when triggered by admin
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

test('Upstream reasoning effort sync and runtime clamping when upstream drops selected effort', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-efforts-sync-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const models = new Models(dir, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.6-luna',
          context_window: 272_000,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        },
        {
          id: 'kimi-k3.1-pro',
          context_window: 272_000,
          supported_reasoning_levels: [{ effort: 'none' }],
        },
        {
          id: 'effort-only-custom',
          supported_reasoning_efforts: ['low', 'high'],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  t.after(() => models.close());

  const routing = validateModelRouting({
    version: 1,
    providers: [{ id: 'p-sub', name: 'Sub2API', apiFormat: 'openai-responses', baseUrl: 'https://sub2api.example/v1', apiKey: 'test-key' }],
    profiles: [
      { id: 'prof-luna', name: 'Luna', providerId: 'p-sub', model: 'gpt-5.6-luna', efforts: ['low', 'medium', 'high', 'xhigh'], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'prof-kimi', name: 'Kimi CN', providerId: 'p-sub', model: 'cn:kimi-k3.1-pro', efforts: ['high'], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'prof-manual', name: 'Manual Lock', providerId: 'p-sub', model: 'gpt-5.6-luna', efforts: ['max'], contextWindowTokens: 128_000, summaryThresholdTokens: 96_000 },
      { id: 'prof-legacy-default', name: 'Legacy Default Only', providerId: 'p-sub', model: 'gpt-5.6-luna', efforts: [], contextWindowTokens: 0, summaryThresholdTokens: 0 },
    ],
    defaultRoute: { profileId: 'prof-luna', effort: 'xhigh', fallbacks: [] },
    botRoutes: {},
  });
  assert.equal(routing.profiles.find(p => p.id === 'prof-luna').effortsMode, 'auto');
  assert.equal(routing.profiles.find(p => p.id === 'prof-manual').effortsMode, 'manual');
  assert.equal(routing.profiles.find(p => p.id === 'prof-legacy-default').effortsMode, 'manual');

  await models.save({ ...routing, migrateLegacyRouting: true });
  await models.syncAllProviders({ force: true });

  const pub = await models.publicConfig();
  const byId = new Map(pub.profiles.map(p => [p.id, p]));
  assert.deepEqual(byId.get('prof-luna').effectiveEfforts, {
    efforts: ['low', 'medium', 'high'],
    effortsSource: 'provider',
    effortsMode: 'auto',
  });
  assert.deepEqual(byId.get('prof-legacy-default').effectiveEfforts, {
    efforts: [],
    effortsSource: 'unknown',
    effortsMode: 'manual',
  });

  // Runtime clamps route effort 'xhigh' down to 'high' after upstream drops 'xhigh'
  assert.equal(clampSupportedEffort('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(clampSupportedEffort('high', ['none']), 'default');
  assert.equal(clampSupportedEffort('none', ['none']), 'none');
  assert.equal(clampSupportedEffort('minimal', ['none', 'low', 'high']), 'low');
  const cachePath = contextCacheFilePath(dir);
  let sentLunaBody;
  const lunaSession = createModelSession({
    baseUrl: 'https://sub2api.example/v1',
    apiKey: 'test-key',
    apiFormat: 'openai-responses',
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    effortsMode: 'auto',
    contextMode: 'auto',
    contextCachePath: cachePath,
    fetchImpl: async (_url, init) => {
      sentLunaBody = JSON.parse(init.body);
      const sse = [
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'OK' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.6-luna', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })}\n\n`,
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const lunaStream = lunaSession.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn-clamp', []);
  for await (const _ of lunaStream.fullStream) {}
  assert.equal(sentLunaBody.reasoning?.effort, 'high', 'dropped xhigh must clamp down to closest supported effort high');

  // Runtime openai-responses session picks up live efforts=['none'] for cn:kimi-k3.1-pro and omits reasoning block
  let sentKimiBody;
  const kimiSession = createModelSession({
    baseUrl: 'https://sub2api.example/v1',
    apiKey: 'test-key',
    apiFormat: 'openai-responses',
    model: 'cn:kimi-k3.1-pro',
    effort: 'high',
    efforts: ['high'],
    effortsMode: 'auto',
    contextMode: 'auto',
    contextCachePath: cachePath,
    fetchImpl: async (_url, init) => {
      sentKimiBody = JSON.parse(init.body);
      const sse = [
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'OK' })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_2', model: 'cn:kimi-k3.1-pro', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })}\n\n`,
      ].join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const kimiStream = kimiSession.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'turn-kimi', []);
  for await (const _ of kimiStream.fullStream) {}
  assert.equal(sentKimiBody.reasoning, undefined, 'auto-synced efforts=["none"] must omit reasoning block in openai-responses');
});

test('CLI host-admin and legacy save path: explicit --context/--efforts become manual, and CLI never stores reference guesses', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-cli-save-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const models = new Models(dir, {
    fetchImpl: async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5-chat-latest' },
        { id: 'provider-reported-model', context_window: 256_000, supported_reasoning_efforts: ['low', 'high'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  t.after(() => models.close());

  // Seed an auto profile
  await models.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [{ id: 'default', name: 'Default', apiFormat: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'sk-1' }],
    profiles: [{ id: 'default', name: 'Default', providerId: 'default', model: 'gpt-5-chat-latest', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' }],
    defaultRoute: { profileId: 'default', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });

  // Spin up minimal admin HTTP bridge to test host-admin.mjs end-to-end against Models
  const server = createServer(async (req, res) => {
    const path = req.url;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (path === '/admin/api/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (path === '/admin/api/model' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(await models.publicConfig()));
    }
    if (path === '/admin/api/model/catalog') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(await models.catalog(body)));
    }
    if (path === '/admin/api/model/test') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (path === '/admin/api/model' && req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(await models.save(body)));
    }
    if (path === '/admin/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ host: { connected: true }, model: { reload: { status: 'applied' } } }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const cliEnv = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GROKBOT_URL: `http://127.0.0.1:${server.address().port}`,
    GROKBOT_ADMIN_PASSWORD: 'demo-only-password',
    MODEL_API_KEY: 'sk-1',
  };

  // 1. model-set --model gpt-5-chat-latest WITHOUT --context or --efforts preserves existing auto mode and never stores reference guesses
  await exec(process.execPath, [hostAdminCli, 'model-set', '--model', 'gpt-5-chat-latest'], { env: cliEnv, timeout: 8000 });
  let current = await models.current();
  assert.equal(current.routing.profiles[0].contextWindowTokens, 0, 'CLI without --context must not store reference table guess');
  assert.equal(current.routing.profiles[0].contextMode, 'auto', 'CLI without --context must preserve auto mode');
  assert.equal(current.routing.profiles[0].effortsMode, 'auto', 'CLI without --efforts must preserve auto mode');

  // 2. model-set --context 128000 --efforts low,high overrides auto mode to manual
  await exec(process.execPath, [hostAdminCli, 'model-set', '--model', 'gpt-5-chat-latest', '--context', '128000', '--efforts', 'low,high'], { env: cliEnv, timeout: 8000 });
  current = await models.current();
  assert.equal(current.routing.profiles[0].contextMode, 'manual');
  assert.equal(current.routing.profiles[0].contextWindowTokens, 128_000);
  assert.equal(current.routing.profiles[0].effortsMode, 'manual');
  assert.deepEqual(current.routing.profiles[0].efforts, ['low', 'high']);

  // 3. model-set WITHOUT --context on a model whose provider DID report capacity adopts provider capacity
  await exec(process.execPath, [hostAdminCli, 'model-set', '--model', 'provider-reported-model'], { env: cliEnv, timeout: 8000 });
  current = await models.current();
  assert.equal(current.routing.profiles[0].contextWindowTokens, 256_000);
  assert.deepEqual(current.routing.profiles[0].efforts, ['low', 'high']);
});

test('Legacy env (0 context) stays manual at runtime, manual-only Hosts skip background sync, pre-clear observations do not resurrect, and Chat/Responses omit reasoning on none-only clamp', async t => {
  const dir = await mkdtemp(join(os.tmpdir(), 'grokbot-round2-fixes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cachePath = contextCacheFilePath(dir);

  // 1. Legacy env without GROKBOT_MODEL_ROUTING and OPENAI_CONTEXT_WINDOW_TOKENS=0 stays manual in loadModelConfig + createInference
  const legacyEnvPath = join(dir, 'model.env');
  await writeFile(legacyEnvPath, [
    'MODEL_API_FORMAT=openai',
    'OPENAI_BASE_URL=https://legacy.example/v1',
    'OPENAI_API_KEY=sk-legacy',
    'OPENAI_MODEL=legacy-zero-model',
    'OPENAI_CONTEXT_WINDOW_TOKENS=0',
    `GROKBOT_MODEL_POLICY=${JSON.stringify({
      mode: 'manual',
      effort: 'default',
      classifierModel: 'jev-latest',
      models: [{ id: 'legacy-zero-model', efforts: [] }],
      routes: {
        routine: { model: 'legacy-zero-model', effort: 'auto' },
        reasoning: { model: 'legacy-zero-model', effort: 'auto' },
        expert: { model: 'legacy-zero-model', effort: 'auto' },
      },
    })}`,
    'JEV_API_KEY=',
    '',
  ].join('\n'), 'utf8');

  await recordCatalogSync(
    cachePath,
    { id: 'default', apiFormat: 'openai', baseUrl: 'https://legacy.example/v1' },
    [{ id: 'legacy-zero-model', contextWindowTokens: 32_768, contextSource: 'provider', efforts: ['low', 'high'], source: 'provider' }],
  );

  const loadedLegacy = await loadModelConfig({ env: { GROKBOT_MODEL_ENV: legacyEnvPath, GROKBOT_DATA_DIR: dir } });
  assert.equal(loadedLegacy.contextMode, 'manual');
  assert.equal(loadedLegacy.effortsMode, 'manual');
  assert.deepEqual(
    resolveEffectiveContext(
      { apiFormat: 'openai', baseUrl: 'https://legacy.example/v1', model: 'legacy-zero-model', contextWindowTokens: 0, summaryThresholdTokens: 0 },
      { cache: await readContextCache(cachePath) },
    ),
    { contextWindowTokens: 0, summaryThresholdTokens: 0, contextSource: 'unknown', contextMode: 'manual' },
  );

  class StubErr extends Error {}
  const stubLib = {
    PrivacyMode: { NO_STORAGE: 'no-storage' },
    ConnectError: StubErr, ActionRequiredError: StubErr, NonRetriableError: StubErr,
    InputTokenLimitError: StubErr,
    Code: { ResourceExhausted: 8, Unavailable: 14, Internal: 13 },
  };
  let legacyCalls = 0;
  const legacyInference = createInference(loadedLegacy, stubLib, {}, {
    fetchImpl: async () => {
      legacyCalls++;
      if (legacyCalls <= 2) {
        return new Response(JSON.stringify({
          error: { code: 'context_length_exceeded', message: 'This model maximum context length is 16384 tokens.' },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return sseOk('Legacy OK');
    },
  });
  const legacyOverflowSession = legacyInference.port.createSession(() => {}, {});
  await assert.rejects(async () => {
    for await (const _ of legacyOverflowSession.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'leg-1', []).fullStream) {}
  });
  // Second overflow must NOT persist to model-context-observed.json or clamp contextWindowTokens
  const legacyOverflowSession2 = legacyInference.port.createSession(() => {}, {});
  await assert.rejects(async () => {
    for await (const _ of legacyOverflowSession2.getExecutor([{ role: 'user', content: 'huge' }]).stream({}, 'leg-2', []).fullStream) {}
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(legacyOverflowSession2.getLocalContextPolicy(), { contextWindowTokens: 0, summaryThresholdTokens: 0 });
  assert.equal(Object.keys((await readContextCache(cachePath)).observed).length, 0);

  const legacyOkSession = legacyInference.port.createSession(() => {}, {});
  const legacyOkStream = legacyOkSession.getExecutor([{ role: 'user', content: 'ok' }]).stream({}, 'leg-3', []);
  for await (const _ of legacyOkStream.fullStream) {}
  assert.equal((await legacyOkStream.extendedUsage).maxTokens, 0);

  // 2. Pre-clear observation (observedAt <= clearedAt) must be dropped, never bumped to clearedAt + 1
  const candidateA = { apiFormat: 'openai', baseUrl: 'https://relay-a.example/v1', model: 'm-a' };
  const tBeforeClear = Date.now() - 10_000;
  await clearObservedCache(cachePath, { now: tBeforeClear + 5_000 });
  const dropped = await persistObservedCeiling(cachePath, candidateA, { contextWindowTokens: 16_384, observedAt: tBeforeClear });
  assert.equal(dropped, null, 'pre-clear observation must be dropped rather than resurrected');
  assert.equal((await readContextCache(cachePath)).observed[Object.keys((await readContextCache(cachePath)).observed)[0]], undefined);

  // 3. Background sync skips manual-only profiles and only queries providers with at least one auto profile
  const syncedHosts = [];
  const syncModels = new Models(join(dir, 'sync-skip'), {
    autoSync: true,
    fetchImpl: async (url) => {
      const href = String(url);
      syncedHosts.push(new URL(href).host);
      return new Response(JSON.stringify({ data: [{ id: 'm1', context_window: 131_072 }] }), { status: 200 });
    },
  });
  t.after(() => syncModels.close());
  await syncModels.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [
      { id: 'p-manual', name: 'Manual Only', apiFormat: 'openai', baseUrl: 'https://manual-only.example/v1', apiKey: 'sk-m' },
      { id: 'p-auto', name: 'Has Auto', apiFormat: 'openai', baseUrl: 'https://has-auto.example/v1', apiKey: 'sk-a' },
    ],
    profiles: [
      { id: 'prof-m', name: 'M', providerId: 'p-manual', model: 'm1', efforts: [], effortsMode: 'manual', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'manual' },
    ],
    defaultRoute: { profileId: 'prof-m', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(syncedHosts, [], 'save with only manual profiles must skip background /models');
  const skippedBg = await syncModels.syncAllProviders();
  assert.equal(skippedBg.synced, 0);
  assert.deepEqual(syncedHosts, []);

  // Manual force sync still queries all providers
  const forcedAll = await syncModels.syncAllProviders({ force: true });
  assert.equal(forcedAll.synced, 2);
  assert.equal(syncedHosts.includes('manual-only.example'), true);
  assert.equal(syncedHosts.includes('has-auto.example'), true);

  // Mixed setup: background sync queries ONLY p-auto, never p-manual
  syncedHosts.length = 0;
  await syncModels.save({
    version: 1,
    providers: [
      { id: 'p-manual', name: 'Manual Only', apiFormat: 'openai', baseUrl: 'https://manual-only.example/v1' },
      { id: 'p-auto', name: 'Has Auto', apiFormat: 'openai', baseUrl: 'https://has-auto.example/v1' },
    ],
    profiles: [
      { id: 'prof-m', name: 'M', providerId: 'p-manual', model: 'm1', efforts: [], effortsMode: 'manual', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'manual' },
      { id: 'prof-a', name: 'A', providerId: 'p-auto', model: 'm1', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
    ],
    defaultRoute: { profileId: 'prof-a', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  await syncModels.syncAllProviders();
  assert.deepEqual(syncedHosts, ['has-auto.example']);

  // 4. Editing one provider preserves observed ceilings on untouched providers
  const splitDir = join(dir, 'per-provider-clear');
  const splitCache = contextCacheFilePath(splitDir);
  const splitModels = new Models(splitDir, { fetchImpl: async () => sseOk() });
  t.after(() => splitModels.close());
  await splitModels.save({
    version: 1,
    migrateLegacyRouting: true,
    providers: [
      { id: 'pa', name: 'A', apiFormat: 'openai', baseUrl: 'https://a.example/v1', apiKey: 'sk-a' },
      { id: 'pb', name: 'B', apiFormat: 'openai', baseUrl: 'https://b.example/v1', apiKey: 'sk-b' },
    ],
    profiles: [
      { id: 'pa-prof', name: 'PA', providerId: 'pa', model: 'model-a', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'pb-prof', name: 'PB', providerId: 'pb', model: 'model-b', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
    ],
    defaultRoute: { profileId: 'pa-prof', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  const obsAt = Date.now() + 50;
  await persistObservedCeiling(splitCache, { apiFormat: 'openai', baseUrl: 'https://a.example/v1', model: 'model-a' }, { contextWindowTokens: 32_768, observedAt: obsAt });
  await persistObservedCeiling(splitCache, { apiFormat: 'openai', baseUrl: 'https://b.example/v1', model: 'model-b' }, { contextWindowTokens: 16_384, observedAt: obsAt });
  // Edit only pb's baseUrl
  await splitModels.save({
    version: 1,
    providers: [
      { id: 'pa', name: 'A', apiFormat: 'openai', baseUrl: 'https://a.example/v1' },
      { id: 'pb', name: 'B', apiFormat: 'openai', baseUrl: 'https://b-v2.example/v1' },
    ],
    profiles: [
      { id: 'pa-prof', name: 'PA', providerId: 'pa', model: 'model-a', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
      { id: 'pb-prof', name: 'PB', providerId: 'pb', model: 'model-b', efforts: [], effortsMode: 'auto', contextWindowTokens: 0, summaryThresholdTokens: 0, contextMode: 'auto' },
    ],
    defaultRoute: { profileId: 'pa-prof', effort: 'default', fallbacks: [] },
    botRoutes: {},
  });
  const splitPub = await splitModels.publicConfig();
  assert.equal(splitPub.profiles.find(p => p.id === 'pa-prof').effectiveContext.contextWindowTokens, 32_768);
  assert.equal(splitPub.profiles.find(p => p.id === 'pb-prof').effectiveContext.observed, undefined);

  // 5. Auto fallback to configuredWindow deducts Anthropic output reserve (200K -> 102K)
  const anthAutoFallback = resolveEffectiveContext(
    { apiFormat: 'anthropic', baseUrl: 'https://anth.example/v1', model: 'claude-sonnet-4-5', contextMode: 'auto', contextWindowTokens: 200_000, summaryThresholdTokens: 150_000 },
    { cache: undefined },
  );
  assert.equal(anthAutoFallback.contextWindowTokens, 200_000);
  assert.equal(anthAutoFallback.summaryThresholdTokens, 102_000);
  assert.equal(anthAutoFallback.contextSource, 'configured');

  // 6. OpenAI Chat session with efforts=['none'] and effort='high' (plus stale requestOptions) sends no reasoning_effort or thinking
  const noneCacheDir = join(dir, 'none-effort');
  const noneCachePath = contextCacheFilePath(noneCacheDir);
  await recordCatalogSync(
    noneCachePath,
    { id: 'p-none', apiFormat: 'openai', baseUrl: 'https://none.example/v1' },
    [{ id: 'deepseek-chat', contextWindowTokens: 128_000, contextSource: 'provider', efforts: ['none'], source: 'provider' }],
  );
  let sentChatBody;
  const chatNoneSession = createModelSession({
    baseUrl: 'https://none.example/v1',
    apiKey: 'sk-1',
    apiFormat: 'openai',
    model: 'deepseek-chat',
    effort: 'high',
    efforts: ['high'],
    effortsMode: 'auto',
    contextMode: 'auto',
    requestOptions: { reasoning_effort: 'high', thinking: { type: 'enabled' } },
    contextCachePath: noneCachePath,
    fetchImpl: async (_url, init) => {
      sentChatBody = JSON.parse(init.body);
      return sseOk('OK');
    },
  });
  const chatNoneStream = chatNoneSession.getExecutor([{ role: 'user', content: 'hi' }]).stream({}, 'none-chat-1', []);
  for await (const _ of chatNoneStream.fullStream) {}
  assert.equal(sentChatBody.reasoning_effort, undefined, 'active effort clamped against ["none"] must not send reasoning_effort');
  assert.equal(sentChatBody.thinking, undefined, 'active effort clamped against ["none"] must not leak stale thinking option');

  // 7. Rate-limit exclusion only blocks 429 or primary rate-limit errors, not real context overflows mentioning TPM/rate limit
  const incidentalContextErr = new ModelRequestError(
    "This model's maximum context length is 128000 tokens. Please reduce prompt length (separate from rate limit / TPM quotas).",
    { status: 400 },
  );
  assert.equal(isInputTokenLimitError(incidentalContextErr), true);
  assert.deepEqual(parseContextLimitDetailsFromError(incidentalContextErr.message), {
    limit: 128_000,
    reserve: 0,
    isComparison: false,
  });
  const primaryRateErr = new ModelRequestError('Rate limit reached for tokens per minute (TPM): maximum context length note', { status: 400 });
  assert.equal(isInputTokenLimitError(primaryRateErr), false);
  const status429Err = new ModelRequestError('maximum context length is 128000 tokens', { status: 429 });
  assert.equal(isInputTokenLimitError(status429Err), false);
});
