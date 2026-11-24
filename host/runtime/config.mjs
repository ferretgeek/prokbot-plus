import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defaultPolicy, parseModelPolicy } from './model-policy.mjs';
import { API_FORMATS, MODEL_ROUTING_ENV, modelRouteForAgent, parseModelRouting } from './model-routing.mjs';

export const root = resolve(import.meta.dirname, '..');

function envValues(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
}

function contextCapacity(value) {
  const capacity = String(value ?? '').trim();
  const parsed = capacity === '' ? 0 : Number(capacity);
  if ((capacity !== '' && !/^\d+$/.test(capacity)) || !Number.isSafeInteger(parsed))
    throw new Error('OPENAI_CONTEXT_WINDOW_TOKENS must be a nonnegative safe integer');
  return parsed;
}

function legacyConfig(values, env) {
  const model = env.GROKBOT_MODEL ?? values.OPENAI_MODEL ?? 'deepseek-v4.1-flash';
  return {
    baseUrl: values.OPENAI_BASE_URL,
    apiKey: values.OPENAI_API_KEY,
    apiFormat: API_FORMATS.includes(values.MODEL_API_FORMAT) ? values.MODEL_API_FORMAT : 'openai',
    model,
    contextWindowTokens: contextCapacity(env.OPENAI_CONTEXT_WINDOW_TOKENS ?? values.OPENAI_CONTEXT_WINDOW_TOKENS),
    policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, model),
    jevApiKey: values.JEV_API_KEY || '',
  };
}

export async function loadModelConfig({ env = process.env } = {}) {
  const path = env.GROKBOT_MODEL_ENV ?? resolve(root, '.runtime/model.env');
  const values = envValues(await readFile(path, 'utf8'));
  const legacy = legacyConfig(values, env);
  const dataDirectory = resolve(env.GROKBOT_DATA_DIR ?? resolve(path, '..'));
  const common = {
    jevApiKey: legacy.jevApiKey,
    dataDirectory,
    usageDirectory: resolve(dataDirectory, 'usage'),
    routingDirectory: resolve(dataDirectory, 'routing'),
  };
  if (!values[MODEL_ROUTING_ENV]) {
    if (!legacy.baseUrl || !legacy.apiKey) throw new Error('Missing model configuration');
    return { ...legacy, ...common, modelBaseUrls: [legacy.baseUrl] };
  }
  const { config: modelRouting } = parseModelRouting(values[MODEL_ROUTING_ENV], legacy);
  const route = modelRouteForAgent(modelRouting);
  if (!route.baseUrl || !route.apiKey || !route.model) throw new Error('Missing model configuration');
  // Auto-review intentionally remains on the global primary route. It does not inherit a Bot's
  // fallback chain because approval decisions should not change provider halfway through a review.
  const policy = defaultPolicy(route.model);
  policy.models = [{ id: route.model, efforts: route.efforts,
    contextWindowTokens: route.contextWindowTokens, summaryThresholdTokens: route.summaryThresholdTokens }];
  return { ...common, modelRouting, baseUrl: route.baseUrl, apiKey: route.apiKey, apiFormat: route.apiFormat,
    model: route.model, contextWindowTokens: route.contextWindowTokens, policy,
    modelBaseUrls: [...new Set(modelRouting.providers.map(provider => provider.baseUrl))] };
}
