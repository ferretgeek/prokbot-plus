// Versioned model-provider configuration and deterministic Bot route resolution.
// Credentials stay in model.env; callers of publicModelRouting never receive them.
import { validateContextPolicy } from './context-policy.mjs';
import { EFFORTS, effortLevels } from './model-policy.mjs';

export const API_FORMATS = Object.freeze(['openai', 'openai-responses', 'anthropic']);
export const CONTEXT_MODES = Object.freeze(['auto', 'manual']);
export const EFFORTS_MODES = Object.freeze(['auto', 'manual']);
export const MODEL_ROUTING_ENV = 'GROKBOT_MODEL_ROUTING';

const MAX_PROVIDERS = 32;
const MAX_PROFILES = 128;
const MAX_BOT_ROUTES = 512;
const MAX_FALLBACKS = 8;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new TypeError(message); };

function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n\0]/.test(value))
    fail(`Invalid ${label}`);
  return value.trim();
}

function identifier(value, label = 'ID') {
  const id = text(value, label, 64);
  if (!ID.test(id)) fail(`Invalid ${label}`);
  return id;
}

function endpoint(value) {
  let url;
  try { url = new URL(text(value, 'Base URL', 2048)); }
  catch { fail('Invalid Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('Invalid Base URL');
  return url.href.replace(/\/$/, '');
}

function key(value) {
  return text(value, 'API Key', 8192);
}

function modelId(value) {
  return text(value, 'model ID', 256);
}

function levels(value, model) {
  if (value === undefined) return effortLevels(model);
  if (!Array.isArray(value) || value.some(item => !EFFORTS.includes(item))) fail('Invalid effort levels');
  return EFFORTS.filter(level => value.includes(level));
}

function profileContext(value) {
  try { return validateContextPolicy(value); }
  catch (error) { fail(error.message); }
}

function contextForProfile(value, previous) {
  const hasContext = Object.prototype.hasOwnProperty.call(value, 'contextWindowTokens') && value.contextWindowTokens !== undefined;
  const hasThreshold = Object.prototype.hasOwnProperty.call(value, 'summaryThresholdTokens') && value.summaryThresholdTokens !== undefined;
  const hasMode = Object.prototype.hasOwnProperty.call(value, 'contextMode') && value.contextMode !== undefined;
  // A provider catalog is optional. Never invent a capacity: it would make the
  // Harness defer compaction past the actual context limit of an unknown model.
  const defaults = previous ?? {};
  const policy = profileContext({
    contextWindowTokens: hasContext ? value.contextWindowTokens : (defaults.contextWindowTokens ?? 0),
    summaryThresholdTokens: hasThreshold ? value.summaryThresholdTokens : (defaults.summaryThresholdTokens ?? 0),
  });
  let contextMode;
  if (hasMode) {
    if (!CONTEXT_MODES.includes(value.contextMode)) fail('Invalid context mode');
    contextMode = value.contextMode;
  } else if ((hasContext && policy.contextWindowTokens > 0) || (hasThreshold && policy.summaryThresholdTokens > 0)) {
    contextMode = 'manual';
  } else if (CONTEXT_MODES.includes(defaults.contextMode)) {
    contextMode = defaults.contextMode;
  } else {
    contextMode = 'manual';
  }
  return { ...policy, contextMode };
}

function effortsModeForProfile(value, previous) {
  const hasMode = Object.prototype.hasOwnProperty.call(value, 'effortsMode') && value.effortsMode !== undefined;
  if (hasMode) {
    if (!EFFORTS_MODES.includes(value.effortsMode)) fail('Invalid efforts mode');
    return value.effortsMode;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'efforts') && value.efforts !== undefined) return 'manual';
  if (EFFORTS_MODES.includes(previous?.effortsMode)) return previous.effortsMode;
  return 'manual';
}

function routeEffort(value, profile) {
  const effort = value ?? 'default';
  if (effort !== 'default' && !profile.efforts.includes(effort)) fail(`Unsupported effort for ${profile.id}`);
  return effort;
}

function normalizeProvider(value, previousProviders) {
  if (!plainObject(value)) fail('Invalid provider');
  const id = identifier(value.id, 'provider ID');
  const apiFormat = value.apiFormat;
  if (!API_FORMATS.includes(apiFormat)) fail('Invalid API format');
  const supplied = typeof value.apiKey === 'string' && value.apiKey.trim() ? key(value.apiKey) : undefined;
  const apiKey = supplied ?? previousProviders.get(id)?.apiKey;
  if (!apiKey) fail(`API Key is required for ${id}`);
  return { id, name: text(value.name, 'provider name', 120), apiFormat, baseUrl: endpoint(value.baseUrl), apiKey };
}

/** Validate one provider draft, retaining its existing credential when its stable ID is unchanged. */
export function validateModelProvider(input, { previous } = {}) {
  const previousProviders = new Map((previous?.providers ?? []).map(item => [item.id, item]));
  return normalizeProvider(input, previousProviders);
}

function normalizeRoute(value, profiles, label) {
  if (!plainObject(value)) fail(`Invalid ${label}`);
  const profileId = identifier(value.profileId, `${label} profile ID`);
  const primary = profiles.get(profileId);
  if (!primary) fail(`Unknown profile: ${profileId}`);
  const effort = routeEffort(value.effort, primary);
  const rawFallbacks = value.fallbacks ?? [];
  if (!Array.isArray(rawFallbacks) || rawFallbacks.length > MAX_FALLBACKS) fail(`Invalid ${label} fallbacks`);
  const seen = new Set([profileId]);
  const fallbacks = rawFallbacks.map((item, index) => {
    if (!plainObject(item)) fail(`Invalid ${label} fallback`);
    const fallbackProfileId = identifier(item.profileId, `${label} fallback profile ID`);
    if (seen.has(fallbackProfileId)) fail(`Duplicate ${label} fallback profile`);
    seen.add(fallbackProfileId);
    const profile = profiles.get(fallbackProfileId);
    if (!profile) fail(`Unknown profile: ${fallbackProfileId}`);
    return { profileId: fallbackProfileId, effort: routeEffort(item.effort, profile), order: index };
  });
  return { profileId, effort, fallbacks };
}

/** A usable empty draft for a new installation. It is intentionally not a persisted config. */
export function emptyModelRouting() {
  return { version: 1, providers: [], profiles: [], defaultRoute: null, botRoutes: {} };
}

/** Convert the old, single-provider environment shape into an editable draft. */
export function legacyModelRouting(legacy = {}) {
  const apiFormat = API_FORMATS.includes(legacy.apiFormat) ? legacy.apiFormat : 'openai';
  const baseUrl = typeof legacy.baseUrl === 'string' ? legacy.baseUrl : '';
  const apiKey = typeof legacy.apiKey === 'string' ? legacy.apiKey : '';
  const model = typeof legacy.model === 'string' ? legacy.model : '';
  if (!baseUrl && !apiKey && !model) return emptyModelRouting();
  const models = legacy.policy?.models;
  const previous = Array.isArray(models) ? models.find(item => item?.id === model) : undefined;
  const profile = model ? {
    id: 'default', name: '默认模型', providerId: 'default', model,
    efforts: Array.isArray(previous?.efforts) ? previous.efforts.filter(level => EFFORTS.includes(level)) : effortLevels(model),
    effortsMode: 'manual',
    ...profileContext({ contextWindowTokens: previous?.contextWindowTokens ?? legacy.contextWindowTokens ?? 0,
      summaryThresholdTokens: previous?.summaryThresholdTokens ?? 0 }),
    contextMode: 'manual',
  } : null;
  const provider = (baseUrl || apiKey || profile) ? { id: 'default', name: '默认服务', apiFormat, baseUrl, apiKey } : null;
  return { version: 1, providers: provider ? [provider] : [], profiles: profile ? [profile] : [],
    defaultRoute: provider && profile ? { profileId: profile.id, effort: legacy.policy?.effort ?? 'default', fallbacks: [] } : null,
    botRoutes: {} };
}

/** Parse a persisted JSON routing configuration. Missing JSON means legacy configuration. */
export function parseModelRouting(value, legacy) {
  if (!value) return { config: legacyModelRouting(legacy), migrated: true };
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { fail('Invalid multi-provider model configuration'); }
  return { config: validateModelRouting(parsed), migrated: false };
}

/**
 * Validate a configuration received from the admin API. Empty API key fields retain
 * the credential for a provider with the same stable ID; a newly added provider needs one.
 */
export function validateModelRouting(input, { previous } = {}) {
  if (!plainObject(input) || input.version !== 1) fail('Unsupported model routing configuration');
  if (!Array.isArray(input.providers) || !input.providers.length || input.providers.length > MAX_PROVIDERS)
    fail('Invalid providers');
  if (!Array.isArray(input.profiles) || !input.profiles.length || input.profiles.length > MAX_PROFILES)
    fail('Invalid model profiles');
  const providerIds = new Set();
  const providers = input.providers.map(item => {
    const provider = validateModelProvider(item, { previous });
    const { id } = provider;
    if (providerIds.has(id)) fail('Duplicate provider ID');
    providerIds.add(id);
    return provider;
  });
  const providersById = new Map(providers.map(item => [item.id, item]));
  const previousProfiles = new Map((previous?.profiles ?? []).map(item => [item.id, item]));
  const profileIds = new Set();
  const profiles = input.profiles.map(item => {
    if (!plainObject(item)) fail('Invalid model profile');
    const id = identifier(item.id, 'profile ID');
    if (profileIds.has(id)) fail('Duplicate profile ID');
    profileIds.add(id);
    const providerId = identifier(item.providerId, 'provider ID');
    if (!providersById.has(providerId)) fail(`Unknown provider: ${providerId}`);
    const model = modelId(item.model);
    const previousProfile = previousProfiles.get(id);
    const profileEfforts = levels(item.efforts, model);
    const effortsMode = effortsModeForProfile(item, previousProfile);
    const context = contextForProfile(item, previousProfile);
    return { id, name: text(item.name, 'profile name', 120), providerId, model, efforts: profileEfforts, effortsMode, ...context };
  });
  const profilesById = new Map(profiles.map(item => [item.id, item]));
  const defaultRoute = normalizeRoute(input.defaultRoute, profilesById, 'default route');
  if (input.botRoutes !== undefined && !plainObject(input.botRoutes)) fail('Invalid Bot routes');
  const entries = Object.entries(input.botRoutes ?? {});
  if (entries.length > MAX_BOT_ROUTES) fail('Too many Bot routes');
  const botRoutes = {};
  for (const [agentId, route] of entries) {
    if (!AGENT_ID.test(agentId)) fail('Invalid Bot ID');
    botRoutes[agentId] = normalizeRoute(route, profilesById, `Bot route ${agentId}`);
  }
  return { version: 1, providers, profiles, defaultRoute, botRoutes };
}

/** Safe form for administration API responses. */
export function publicModelRouting(config) {
  return {
    version: 1,
    providers: (config.providers ?? []).map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: Boolean(apiKey) })),
    profiles: (config.profiles ?? []).map(profile => ({ ...profile, efforts: [...profile.efforts] })),
    defaultRoute: config.defaultRoute ? structuredClone(config.defaultRoute) : null,
    botRoutes: structuredClone(config.botRoutes ?? {}),
  };
}

function candidate(profile, provider, route) {
  return {
    profileId: profile.id, profileName: profile.name, providerId: provider.id, providerName: provider.name,
    apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, apiKey: provider.apiKey,
    model: profile.model, efforts: [...profile.efforts], effort: route.effort,
    effortsMode: profile.effortsMode ?? 'manual',
    contextWindowTokens: profile.contextWindowTokens, summaryThresholdTokens: profile.summaryThresholdTokens,
    contextMode: profile.contextMode ?? 'manual',
  };
}

function routeContext(candidates) {
  const capacities = candidates.map(item => item.contextWindowTokens).filter(value => value > 0);
  const contextWindowTokens = capacities.length ? Math.min(...capacities) : 0;
  const thresholds = candidates.map(item => item.summaryThresholdTokens)
    .filter(value => value > 0 && (!contextWindowTokens || value < contextWindowTokens));
  return { contextWindowTokens, summaryThresholdTokens: thresholds.length ? Math.min(...thresholds) : 0 };
}

/** Resolve the configured direct route for a Bot. The returned values include private transport details. */
export function modelRouteForAgent(config, agentId) {
  const profiles = new Map(config.profiles.map(item => [item.id, item]));
  const providers = new Map(config.providers.map(item => [item.id, item]));
  const botRoute = agentId && config.botRoutes?.[agentId];
  const route = botRoute ?? config.defaultRoute;
  if (!route) fail('No default model route');
  const resolve = item => {
    const profile = profiles.get(item.profileId);
    const provider = profile ? providers.get(profile.providerId) : undefined;
    if (!profile || !provider) fail(`Invalid configured profile: ${item.profileId}`);
    return candidate(profile, provider, item);
  };
  const primary = resolve(route);
  const fallbacks = route.fallbacks.map(resolve);
  return { ...primary, fallbacks, routeSource: botRoute ? 'bot' : 'default', agentId: agentId || undefined,
    ...routeContext([primary, ...fallbacks]) };
}

/** Resolve one profile for catalog and connection tests without its route fallback chain. */
export function modelRouteForProfile(config, profileId, { effort = 'default' } = {}) {
  const profiles = new Map(config.profiles.map(item => [item.id, item]));
  const providers = new Map(config.providers.map(item => [item.id, item]));
  const id = identifier(profileId, 'profile ID');
  const profile = profiles.get(id);
  const provider = profile ? providers.get(profile.providerId) : undefined;
  if (!profile || !provider) fail(`Unknown profile: ${id}`);
  const route = { profileId: id, effort: routeEffort(effort, profile), fallbacks: [] };
  return { ...candidate(profile, provider, route), fallbacks: [], routeSource: 'profile', ...routeContext([candidate(profile, provider, route)]) };
}

export function isConfiguredModelRouting(config) {
  try {
    const route = modelRouteForAgent(config);
    return Boolean(route.baseUrl && route.apiKey && route.model);
  } catch {
    return false;
  }
}
