import { defaultPolicy, effortLevels, parseModelPolicy, resolveModelCapabilities, summaryThresholdFor, validatePolicy } from '../runtime/model-policy.mjs';
import { extractProviderContextWindow, extractProviderEfforts, normalizeModelId } from '../runtime/model-specs.mjs';
import { clearObservedCache, contextCacheFilePath, contextEntryKey, DEFAULT_SYNC_SETTINGS, readContextCache, recordCatalogSync, resolveEffectiveContext, resolveEffectiveEfforts, updateSyncSettings } from '../runtime/model-context-cache.mjs';
import { createModelRouter } from '../runtime/model-router.mjs';
import { anthropicEndpoint, anthropicHeaders } from '../runtime/anthropic-messages.mjs';
import { createModelSession } from '../runtime/model-session.mjs';
import { API_FORMATS, MODEL_ROUTING_ENV, isConfiguredModelRouting, modelRouteForAgent, modelRouteForProfile,
  parseModelRouting, publicModelRouting, validateModelProvider, validateModelRouting } from '../runtime/model-routing.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check } from './security.mjs';
import { readJson, writePrivate } from './storage.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clean = (value, label, maximum = 2048) => {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value), 400,
    `${label}不能为空，也不能包含换行`);
  return value.trim();
};

function valuesFrom(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

function legacyConfig(values) {
  return {
    apiFormat: API_FORMATS.includes(values.MODEL_API_FORMAT) ? values.MODEL_API_FORMAT : 'openai',
    baseUrl: values.OPENAI_BASE_URL ?? '', model: values.OPENAI_MODEL ?? '', apiKey: values.OPENAI_API_KEY ?? '',
    contextWindowTokens: Number(values.OPENAI_CONTEXT_WINDOW_TOKENS ?? 0),
    policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, values.OPENAI_MODEL || undefined),
    jevApiKey: values.JEV_API_KEY || '',
  };
}

function context(value) {
  const parsed = Number(value ?? 0);
  check(Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100_000_000, 400,
    '上下文长度应为 0–100000000 的整数');
  return parsed;
}

function serviceUrl(value) {
  const baseUrl = clean(value, 'Base URL');
  let url;
  try { url = new URL(baseUrl); }
  catch { check(false, 400, 'Base URL 格式不正确'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    400, 'Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数');
  return url.href.replace(/\/$/, '');
}

function publicError(error) {
  return `模型配置无效：${String(error?.message ?? error).slice(0, 240)}`;
}

function compatibilityPolicy(route) {
  const policy = defaultPolicy(route.model);
  policy.effort = route.effort;
  policy.models = [{ id: route.model, efforts: route.efforts,
    contextWindowTokens: route.contextWindowTokens, summaryThresholdTokens: route.summaryThresholdTokens }];
  return policy;
}

const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const CODEX_MANIFEST_CLIENT_VERSION = '0.160.0';

function extractCatalogModelId(item) {
  if (typeof item?.id === 'string' && item.id.trim()) return item.id.trim();
  if (typeof item?.slug === 'string' && item.slug.trim()) return item.slug.trim();
  if (typeof item?.name === 'string' && item.name.trim()) return item.name.trim().replace(/^models\//, '');
  if (typeof item?.model === 'string' && item.model.trim()) return item.model.trim();
  return '';
}

async function readBoundedJson(response, maxBytes = MAX_CATALOG_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    check(false, 502, '模型列表响应过大');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (typeof response.text === 'function') {
      const text = await response.text();
      check(Buffer.byteLength(text, 'utf8') <= maxBytes, 502, '模型列表响应过大');
      return JSON.parse(text);
    }
    return response.json();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
      size += bytes.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        check(false, 502, '模型列表响应过大');
      }
      if (bytes.byteLength) chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export class Models {
  constructor(dataDir, { filename = join(dataDir, 'model.env'), fetchImpl, autoSync = false } = {}) {
    this.filename = filename;
    this.dataDir = dataDir;
    this.fetchImpl = fetchImpl;
    this.autoSync = Boolean(autoSync);
    this.contextCachePath = contextCacheFilePath(dataDir);
    this.syncInFlight = null;
    this.syncAbort = new AbortController();
    this.closed = false;
    this.tail = Promise.resolve();
  }
  async current() {
    const source = await readFile(this.filename, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const values = valuesFrom(source), legacy = legacyConfig(values);
    const parsed = parseModelRouting(values[MODEL_ROUTING_ENV], legacy);
    let primary;
    try { primary = modelRouteForAgent(parsed.config); }
    catch { primary = undefined; }
    return { ...legacy, routing: parsed.config, routingMigrated: parsed.migrated,
      legacyAdaptiveRouting: parsed.migrated && legacy.policy?.mode === 'adaptive',
      ...(primary ? { baseUrl: primary.baseUrl, apiKey: primary.apiKey, apiFormat: primary.apiFormat,
        model: primary.model, contextWindowTokens: primary.contextWindowTokens, policy: compatibilityPolicy(primary) } : {}) };
  }
  async publicConfig() {
    const current = await this.current();
    const { apiKey, jevApiKey, routing, ...summary } = current;
    const pub = publicModelRouting(routing);
    const cache = await readContextCache(this.contextCachePath);
    const providersById = new Map((routing.providers ?? []).map(item => [item.id, item]));
    const profiles = pub.profiles.map(profile => {
      const provider = providersById.get(profile.providerId);
      const effectiveContext = provider
        ? resolveEffectiveContext({ ...profile, apiFormat: provider.apiFormat, baseUrl: provider.baseUrl }, { cache })
        : {
          contextWindowTokens: profile.contextWindowTokens ?? 0,
          summaryThresholdTokens: profile.summaryThresholdTokens ?? 0,
          contextSource: (profile.contextWindowTokens ?? 0) > 0 ? 'manual' : 'unknown',
          contextMode: profile.contextMode ?? 'manual',
        };
      const effectiveEfforts = provider
        ? resolveEffectiveEfforts({ ...profile, apiFormat: provider.apiFormat, baseUrl: provider.baseUrl }, { cache })
        : {
          efforts: [...(profile.efforts ?? [])],
          effortsSource: (profile.efforts?.length ?? 0) > 0 ? 'manual' : 'unknown',
          effortsMode: profile.effortsMode ?? 'manual',
        };
      return { ...profile, effectiveContext, effectiveEfforts };
    });
    const providerSync = {};
    for (const provider of routing.providers ?? []) {
      if (cache.providers?.[provider.id]) providerSync[provider.id] = cache.providers[provider.id];
    }
    const syncSettings = { ...DEFAULT_SYNC_SETTINGS, ...(cache.settings ?? {}) };
    return {
      ...pub,
      profiles,
      ...summary,
      contextSync: { updatedAt: cache.updatedAt, providers: providerSync, ...syncSettings },
      hasApiKey: Boolean(apiKey), hasJevApiKey: Boolean(jevApiKey),
      configured: isConfiguredModelRouting(routing),
      reload: await this.reloadStatus(),
    };
  }
  async getSyncSettings() {
    const cache = await readContextCache(this.contextCachePath);
    return { ...DEFAULT_SYNC_SETTINGS, ...(cache.settings ?? {}) };
  }
  async saveSyncSettings(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '同步设置无效');
    for (const field of ['autoSync', 'codexManifestProbe']) {
      check(input[field] === undefined || typeof input[field] === 'boolean', 400, `Invalid ${field}`);
    }
    await updateSyncSettings(this.contextCachePath, {
      autoSync: input.autoSync,
      codexManifestProbe: input.codexManifestProbe,
    });
    return this.publicConfig();
  }
  async clearObserved(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '参数无效');
    if (input.profileId) {
      const current = await this.current();
      const profile = (current.routing?.profiles ?? []).find(item => item.id === input.profileId);
      const provider = profile ? (current.routing?.providers ?? []).find(item => item.id === profile.providerId) : undefined;
      check(profile && provider, 404, '模型档案不存在');
      const key = contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: profile.model });
      await clearObservedCache(this.contextCachePath, { keys: [key] });
    } else if (input.apiFormat && input.baseUrl && input.model) {
      await clearObservedCache(this.contextCachePath, { keys: [contextEntryKey(input)] });
    } else {
      await clearObservedCache(this.contextCachePath);
    }
    return this.publicConfig();
  }
  async reloadStatus() {
    const request = await readJson(join(this.dataDir, 'model-reload-request.json'), null);
    const status = await readJson(join(this.dataDir, 'model-reload-status.json'), null);
    if (!request) return status ?? { status: 'none' };
    if (status?.revision === request.revision) {
      const allowed = ['applied', 'waiting', 'error', 'pending'];
      return { revision: status.revision, status: allowed.includes(status.status) ? status.status : 'pending',
        updatedAt: status.updatedAt, message: status.status === 'error' ? 'Host 未能应用配置，请检查服务日志' : undefined };
    }
    return { revision: request.revision, status: 'pending', updatedAt: request.requestedAt };
  }
  legacyRouting(input, previous) {
    const apiFormat = input.apiFormat ?? previous.apiFormat;
    check(API_FORMATS.includes(apiFormat), 400, '接口格式无效');
    const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
    const model = clean(input.model ?? previous.model, '模型名称', 256);
    const active = (() => { try { return modelRouteForAgent(previous.routing); } catch { return undefined; } })();
    const apiKey = clean(input.apiKey || active?.apiKey || previous.apiKey, 'API Key', 8192);
    const contextWindowTokens = context(input.contextWindowTokens ?? active?.contextWindowTokens ?? previous.contextWindowTokens);
    let policy;
    try {
      policy = validatePolicy(input.policy ?? (previous.model === model ? previous.policy : defaultPolicy(model)), model);
    } catch (error) { check(false, 400, error.message); }
    check(policy.mode !== 'adaptive' || (input.jevApiKey || previous.jevApiKey), 400, '请填写 Jev API Key');
    const providerId = active?.providerId ?? 'default', profileId = active?.profileId ?? 'default';
    const rawPolicyModel = Array.isArray(input.policy?.models) ? input.policy.models.find(item => item?.id === model) : undefined;
    const capability = policy.models.find(item => item.id === model) ?? { efforts: effortLevels(model) };
    const explicitContext = own(input, 'contextWindowTokens') || own(rawPolicyModel ?? {}, 'contextWindowTokens') || own(rawPolicyModel ?? {}, 'summaryThresholdTokens');
    const explicitEfforts = own(rawPolicyModel ?? {}, 'efforts');
    const contextMode = own(input, 'contextMode') ? input.contextMode
      : own(rawPolicyModel ?? {}, 'contextMode') ? rawPolicyModel.contextMode
        : explicitContext ? 'manual' : undefined;
    const effortsMode = own(input, 'effortsMode') ? input.effortsMode
      : own(rawPolicyModel ?? {}, 'effortsMode') ? rawPolicyModel.effortsMode
        : explicitEfforts ? 'manual' : undefined;
    const providers = (previous.routing.providers ?? []).filter(item => item.id !== providerId);
    providers.push({ id: providerId, name: active?.providerName ?? '默认服务', apiFormat, baseUrl, apiKey });
    const profiles = (previous.routing.profiles ?? []).filter(item => item.id !== profileId);
    profiles.push({ id: profileId, name: active?.profileName ?? '默认模型', providerId, model,
      efforts: capability.efforts, ...(effortsMode ? { effortsMode } : {}),
      contextWindowTokens: capability.contextWindowTokens ?? contextWindowTokens,
      summaryThresholdTokens: capability.summaryThresholdTokens ?? 0,
      ...(contextMode ? { contextMode } : {}) });
    let routing;
    try {
      routing = validateModelRouting({ version: 1, providers, profiles,
        defaultRoute: { profileId, effort: policy.effort, fallbacks: previous.routing.defaultRoute?.fallbacks ?? [] },
        botRoutes: previous.routing.botRoutes ?? {} }, { previous: previous.routing });
    } catch (error) { check(false, 400, publicError(error)); }
    return { routing, jevApiKey: input.jevApiKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey,
      ...(previous.routingMigrated ? { legacy: { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } } : {}) };
  }
  async validated(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '模型配置无效');
    const previous = await this.current();
    const multiProvider = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1;
    if (!multiProvider) return this.legacyRouting(input, previous);
    check(!previous.routingMigrated || input.migrateLegacyRouting === true, 409,
      '检测到旧版模型配置。请在模型页确认迁移后再保存。');
    let routing;
    try { routing = validateModelRouting(input, { previous: previous.routing }); }
    catch (error) { check(false, 400, publicError(error)); }
    return { routing, jevApiKey: input.jevApiKey ? clean(input.jevApiKey, 'Jev API Key', 8192) : previous.jevApiKey };
  }
  async write(config) {
    if (config.legacy) {
      const { apiFormat, baseUrl, apiKey, model, contextWindowTokens, policy } = config.legacy;
      await writePrivate(this.filename, [
        `MODEL_API_FORMAT=${apiFormat}`,
        `OPENAI_BASE_URL=${baseUrl}`,
        `OPENAI_API_KEY=${apiKey}`,
        `OPENAI_MODEL=${model}`,
        `OPENAI_CONTEXT_WINDOW_TOKENS=${contextWindowTokens}`,
        `GROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
        `JEV_API_KEY=${config.jevApiKey}`,
        '',
      ].join('\n'));
      return;
    }
    const primary = modelRouteForAgent(config.routing);
    const policy = compatibilityPolicy(primary);
    await writePrivate(this.filename, [
      `${MODEL_ROUTING_ENV}=${JSON.stringify(config.routing)}`,
      `MODEL_API_FORMAT=${primary.apiFormat}`,
      `OPENAI_BASE_URL=${primary.baseUrl}`,
      `OPENAI_API_KEY=${primary.apiKey}`,
      `OPENAI_MODEL=${primary.model}`,
      `OPENAI_CONTEXT_WINDOW_TOKENS=${primary.contextWindowTokens}`,
      `GROKBOT_MODEL_POLICY=${JSON.stringify(policy)}`,
      `JEV_API_KEY=${config.jevApiKey}`,
      '',
    ].join('\n'));
  }
  save(input) {
    const pending = this.tail.then(async () => {
      const config = await this.validated(input);
      if (own(input, 'contextSync') && input.contextSync && typeof input.contextSync === 'object') {
        const { autoSync, codexManifestProbe } = input.contextSync;
        if (typeof autoSync === 'boolean' || typeof codexManifestProbe === 'boolean') {
          await updateSyncSettings(this.contextCachePath, { autoSync, codexManifestProbe });
        }
      }
      await this.write(config);
      const providersById = new Map((config.routing?.providers ?? []).map(item => [item.id, item]));
      const keysToClear = (config.routing?.profiles ?? []).map(profile => {
        const provider = providersById.get(profile.providerId);
        return provider ? contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: profile.model }) : null;
      }).filter(Boolean);
      if (keysToClear.length) {
        await clearObservedCache(this.contextCachePath, { keys: keysToClear }).catch(() => {});
      }
      const request = { revision: randomUUID(), requestedAt: new Date().toISOString() };
      await writePrivate(join(this.dataDir, 'model-reload-request.json'), `${JSON.stringify(request)}\n`);
      if (this.autoSync) {
        const syncSettings = await this.getSyncSettings();
        if (syncSettings.autoSync) void this.syncAllProviders().catch(() => {});
      }
      return this.publicConfig();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  async routeFor(input = {}, { profileId, direct = false } = {}) {
    const hasConfig = Array.isArray(input.providers) || own(input, 'defaultRoute') || input.version === 1 || own(input, 'baseUrl');
    const config = hasConfig ? await this.validated(input) : { routing: (await this.current()).routing };
    if (profileId) return { config, route: modelRouteForProfile(config.routing, profileId) };
    const route = modelRouteForAgent(config.routing);
    return { config, route: direct ? { ...route, fallbacks: [] } : route };
  }
  async catalog(input = {}, { persist, clearObserved = false } = {}) {
    const previous = await this.current();
    let provider;
    if (input.provider) {
      try { provider = validateModelProvider(input.provider, { previous: previous.routing }); }
      catch (error) { check(false, 400, publicError(error)); }
    } else if (input.providerId && !Array.isArray(input.providers) && !own(input, 'baseUrl')) {
      provider = previous.routing.providers.find(item => item.id === input.providerId);
      check(provider, 404, '模型服务不存在');
    } else {
      const { route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
      provider = route;
    }
    const syncSettings = await this.getSyncSettings();
    const allowCodexProbe = input.codexManifestProbe === true || syncSettings.codexManifestProbe === true;
    const anthropic = provider.apiFormat === 'anthropic';
    const fetcher = this.fetchImpl ?? globalThis.fetch;
    const baseEndpoint = anthropic ? anthropicEndpoint(provider.baseUrl, 'models') : `${provider.baseUrl}/models`;
    const headers = anthropic ? anthropicHeaders(provider.apiKey) : { authorization: `Bearer ${provider.apiKey}` };
    const MAX_MODELS = 2000;
    const seen = new Set();
    const seenCursors = new Set();
    const models = [];
    let afterId = '';

    for (let page = 0; page < 5 && models.length < MAX_MODELS; page++) {
      let url = baseEndpoint;
      if (afterId) {
        const nextUrl = new URL(baseEndpoint);
        nextUrl.searchParams.set('after_id', afterId);
        url = nextUrl.href;
      }
      let response, body;
      try {
        const timeout = AbortSignal.timeout(15_000);
        const signal = this.syncAbort ? AbortSignal.any([this.syncAbort.signal, timeout]) : timeout;
        response = await fetcher(url, {
          redirect: 'error',
          headers,
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          check(false, 502, `Model catalog HTTP ${response.status}`);
        }
        body = await readBoundedJson(response, MAX_CATALOG_BYTES);
      } catch (error) {
        if (error?.status) throw error;
        check(false, 502, '无法读取模型列表');
      }
      const list = Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.models)
          ? body.models
          : Array.isArray(body)
            ? body
            : null;
      check(Array.isArray(list), 502, '模型列表格式不兼容');
      for (const item of list) {
        if (models.length >= MAX_MODELS) break;
        const rawId = extractCatalogModelId(item);
        if (!rawId || rawId.length > 256 || /[\r\n\0]/.test(rawId) || seen.has(rawId)) continue;
        seen.add(rawId);
        const supplied = extractProviderEfforts(item);
        const capacity = extractProviderContextWindow(item);
        models.push(resolveModelCapabilities(rawId, { reportedEfforts: supplied, reportedCapacity: capacity }));
      }
      if (models.length >= MAX_MODELS) break;
      if (anthropic && body?.has_more === true && typeof body.last_id === 'string' && body.last_id && !seenCursors.has(body.last_id)) {
        seenCursors.add(body.last_id);
        afterId = body.last_id;
      } else {
        break;
      }
    }

    // Optional Codex-manifest enrichment (off by default) for self-hosted gateways whose bare
    // GET /models omits context_window / supported_reasoning_levels unless client_version is passed.
    if (!anthropic && allowCodexProbe && models.length > 0 && models.length < MAX_MODELS && !models.some(item => item.contextSource === 'provider')) {
      try {
        const manifestUrl = new URL(baseEndpoint);
        if (!manifestUrl.searchParams.has('client_version')) {
          manifestUrl.searchParams.set('client_version', CODEX_MANIFEST_CLIENT_VERSION);
        }
        const timeout = AbortSignal.timeout(8_000);
        const signal = this.syncAbort ? AbortSignal.any([this.syncAbort.signal, timeout]) : timeout;
        const manifestResp = await fetcher(manifestUrl.href, {
          redirect: 'error',
          headers,
          signal,
        });
        if (manifestResp.ok) {
          const manifestBody = await readBoundedJson(manifestResp, MAX_CATALOG_BYTES);
          const manifestList = Array.isArray(manifestBody?.models)
            ? manifestBody.models
            : Array.isArray(manifestBody?.data)
              ? manifestBody.data
              : null;
          if (Array.isArray(manifestList)) {
            const indexById = new Map(models.map((entry, idx) => [entry.id, idx]));
            for (const item of manifestList) {
              const rawId = extractCatalogModelId(item);
              if (!rawId || rawId.length > 256 || /[\r\n\0]/.test(rawId)) continue;
              const supplied = extractProviderEfforts(item);
              const capacity = extractProviderContextWindow(item);
              if (!capacity && !supplied) continue;
              const existingIdx = indexById.get(rawId);
              if (existingIdx !== undefined) {
                const current = models[existingIdx];
                const merged = resolveModelCapabilities(rawId, {
                  reportedEfforts: supplied ?? (current.source === 'provider' ? current.efforts : undefined),
                  reportedCapacity: capacity ?? (current.contextSource === 'provider' ? current.contextWindowTokens : undefined),
                });
                models[existingIdx] = merged;
              } else if (models.length < MAX_MODELS && !seen.has(rawId)) {
                seen.add(rawId);
                indexById.set(rawId, models.length);
                models.push(resolveModelCapabilities(rawId, { reportedEfforts: supplied, reportedCapacity: capacity }));
              }
            }
          }
        } else {
          await manifestResp.body?.cancel().catch(() => {});
        }
      } catch {
        /* Optional enrichment; never fail a successful /models catalog. */
      }
    }
    const cacheProvider = {
      id: provider.id ?? provider.providerId ?? 'default',
      apiFormat: provider.apiFormat,
      baseUrl: provider.baseUrl,
    };
    const savedProvider = (previous.routing?.providers ?? []).find(item => item.id === cacheProvider.id);
    const isSavedMatch = Boolean(
      savedProvider &&
      savedProvider.apiFormat === cacheProvider.apiFormat &&
      savedProvider.baseUrl === cacheProvider.baseUrl,
    );
    if (persist === true || (persist !== false && isSavedMatch)) {
      await recordCatalogSync(this.contextCachePath, cacheProvider, models, { status: 'ok', clearObserved }).catch(() => {});
    }
    return { models };
  }
  async syncAllProviders({ force = false, clearObserved = false } = {}) {
    if (this.closed) return { synced: 0, ok: 0, failed: 0, modelsDetected: 0, providerReported: 0, effortsDetected: 0, providerEfforts: 0, providers: {} };
    if (this.syncInFlight && !force) return this.syncInFlight;
    const run = (async () => {
      const current = await this.current();
      const providers = (current.routing?.providers ?? []).filter(item => item.baseUrl && item.apiKey);
      if (!providers.length || this.closed) {
        return { synced: 0, ok: 0, failed: 0, modelsDetected: 0, providerReported: 0, effortsDetected: 0, providerEfforts: 0, providers: {} };
      }
      const results = {};
      let ok = 0, failed = 0, modelsDetected = 0, providerReported = 0, effortsDetected = 0, providerEfforts = 0;
      const queue = [...providers];
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length && !this.closed) {
          const provider = queue.shift();
          try {
            const { models } = await this.catalog({ provider }, { persist: true, clearObserved });
            const detected = models.filter(item => item.contextWindowTokens > 0).length;
            const reported = models.filter(item => item.contextSource === 'provider' && item.contextWindowTokens > 0).length;
            const effortsCount = models.filter(item => item.efforts?.length > 0).length;
            const reportedEfforts = models.filter(item => item.source === 'provider' && item.efforts?.length > 0).length;
            ok++;
            modelsDetected += detected;
            providerReported += reported;
            effortsDetected += effortsCount;
            providerEfforts += reportedEfforts;
            results[provider.id] = {
              status: 'ok',
              modelCount: models.length,
              detectedCount: detected,
              providerReportedCount: reported,
              effortsDetectedCount: effortsCount,
              providerEffortsCount: reportedEfforts,
            };
          } catch (error) {
            if (this.closed) return;
            failed++;
            const message = String(error?.message ?? error).slice(0, 240);
            await recordCatalogSync(this.contextCachePath, provider, [], { status: 'error', error: message }).catch(() => {});
            results[provider.id] = { status: 'error', error: message };
          }
        }
      });
      await Promise.all(workers);
      return { synced: providers.length, ok, failed, modelsDetected, providerReported, effortsDetected, providerEfforts, providers: results };
    })();
    this.syncInFlight = run.finally(() => {
      if (this.syncInFlight === run) this.syncInFlight = null;
    });
    return this.syncInFlight;
  }
  async resolve(input = {}) {
    check(input && typeof input === 'object' && !Array.isArray(input), 400, '参数无效');
    const resolveFromCacheOrSpec = (id, provider, cache, liveByProvider) => {
      if (provider) {
        const normalizedId = normalizeModelId(id);
        const providerLive = liveByProvider?.get(provider.id);
        const live = providerLive?.get(id) ?? (normalizedId ? providerLive?.get(normalizedId) : undefined);
        if (live && (live.contextWindowTokens > 0 || live.efforts?.length > 0)) return live.id === id ? live : { ...live, id };
        const key = contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: id });
        const normalizedKey = normalizedId && normalizedId !== id.toLowerCase()
          ? contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: normalizedId })
          : null;
        const cached = cache?.catalog?.[key] ?? (normalizedKey ? cache?.catalog?.[normalizedKey] : undefined);
        const reportedCapacity = cached && cached.source === 'provider' && cached.contextWindowTokens > 0
          ? cached.contextWindowTokens : undefined;
        const reportedEfforts = cached && cached.effortsSource === 'provider' && cached.efforts?.length
          ? cached.efforts : undefined;
        const base = resolveModelCapabilities(id, { reportedCapacity, reportedEfforts });
        if (base.contextWindowTokens > 0) return base;
        const observed = cache?.observed?.[key];
        if (observed && Number.isSafeInteger(observed.contextWindowTokens) && observed.contextWindowTokens >= 1_024) {
          return {
            ...base,
            contextWindowTokens: observed.contextWindowTokens,
            summaryThresholdTokens: summaryThresholdFor(observed.contextWindowTokens),
            contextSource: 'observed',
          };
        }
        return base;
      }
      return resolveModelCapabilities(id);
    };

    if (Array.isArray(input.profiles)) {
      check(input.profiles.length <= 128, 400, '单次最多识别 128 个模型');
      const previous = await this.current();
      const providersById = new Map((previous.routing?.providers ?? []).map(item => [item.id, item]));
      const draftProviderIds = new Set();
      if (Array.isArray(input.providers)) {
        for (const draft of input.providers) {
          try {
            const validated = validateModelProvider(draft, { previous: previous.routing });
            const saved = providersById.get(validated.id);
            if (!saved || saved.apiFormat !== validated.apiFormat || saved.baseUrl !== validated.baseUrl) {
              draftProviderIds.add(validated.id);
            }
            providersById.set(validated.id, validated);
          } catch { /* Draft provider without key yet: fall back to saved/specs. */ }
        }
      }
      const liveByProvider = new Map();
      if (input.preferUpstream !== false) {
        const providerIds = [...new Set(input.profiles.map(item => item?.providerId).filter(id => id && providersById.has(id)))];
        const queue = [...providerIds];
        const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length) {
            const providerId = queue.shift();
            const provider = providersById.get(providerId);
            if (!provider?.baseUrl || !provider?.apiKey) continue;
            try {
              const { models } = await this.catalog({ provider }, { persist: !draftProviderIds.has(providerId) });
              liveByProvider.set(providerId, new Map(models.map(item => [item.id, item])));
            } catch { /* Unreachable upstream must not block built-in spec resolution. */ }
          }
        });
        await Promise.all(workers);
      }
      const cache = await readContextCache(this.contextCachePath);
      return {
        models: input.profiles.map(raw => {
          const id = clean(raw?.model, '模型名称', 256);
          const provider = raw?.providerId ? providersById.get(raw.providerId) : undefined;
          return resolveFromCacheOrSpec(id, provider, cache, liveByProvider);
        }),
      };
    }

    if (Array.isArray(input.models)) {
      check(input.models.length <= 128, 400, '单次最多识别 128 个模型');
      return {
        models: input.models.map((raw) => {
          const id = clean(raw, '模型名称', 256);
          return resolveModelCapabilities(id);
        }),
      };
    }
    const id = clean(input.model, '模型名称', 256);
    let provider;
    if (input.providerId || input.provider) {
      const previous = await this.current();
      if (input.provider) {
        try { provider = validateModelProvider(input.provider, { previous: previous.routing }); }
        catch { provider = undefined; }
      } else {
        provider = (previous.routing?.providers ?? []).find(item => item.id === input.providerId);
      }
    }
    const cache = provider ? await readContextCache(this.contextCachePath) : undefined;
    return { model: resolveFromCacheOrSpec(id, provider, cache) };
  }
  async close() {
    this.closed = true;
    this.syncAbort.abort(new DOMException('Models service closed', 'AbortError'));
    await Promise.allSettled([this.syncInFlight, this.tail]);
  }
  async classify(input) {
    const current = await this.current();
    const base = { ...current, ...(input ?? {}) };
    const config = await this.legacyRouting(base, current);
    const route = modelRouteForAgent(config.routing);
    check(config.jevApiKey, 400, '请填写 Jev API Key');
    const policy = { ...compatibilityPolicy(route), mode: 'adaptive' };
    const router = createModelRouter({ ...route, policy, jevApiKey: config.jevApiKey,
      usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
    const decision = await router({ messages: [{ role: 'user', content: clean(input.task, '任务', 10000) }] });
    const { requestOptions, apiKey, baseUrl, ...result } = decision;
    return result;
  }
  async test(input = {}) {
    const { config, route } = await this.routeFor(input, { profileId: input.profileId, direct: true });
    let usage;
    const session = createModelSession({ ...route, policy: compatibilityPolicy(route),
      onUsage: async value => { usage = value; }, selectRequest: async () => ({ ...route, fallbacks: [] }) });
    const result = session.getExecutor([{ role: 'user', content: 'Reply with OK.' }])
      .stream({ signal: AbortSignal.timeout(120_000) }, 'model-test', []);
    let text = '';
    try {
      for await (const part of result.fullStream) if (part.type === 'text-delta') text += part.textDelta;
      await result.response;
    } catch (error) {
      check(false, 502, error.name === 'TimeoutError' || error.name === 'AbortError' ? '模型服务连接超时，请检查地址与网络'
        : error.status ? `模型服务返回 HTTP ${error.status}：${String(error.message).slice(0, 300)}`
          : `模型请求失败：${String(error.message).slice(0, 300)}`);
    } finally {
      if (usage) await recordUsage(join(this.dataDir, 'usage'), { ...usage, kind: 'test' }).catch(() => {});
    }
    check(text.trim(), 502, '模型没有返回文字内容');
    return { ok: true, profileId: route.profileId, model: route.model, message: '模型接口已完成真实请求' };
  }
}
