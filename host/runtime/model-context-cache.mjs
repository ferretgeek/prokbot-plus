// Shared persistent cache for upstream /models context windows and runtime-observed
// overflow ceilings. Safely readable by Host runtime (mtime-cached sync read) and
// atomically updatable by both the Admin Server and Host runtime processes.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EFFORTS, effortLevels, summaryThresholdFor } from './model-policy.mjs';
import { normalizeModelId, referenceContextWindow } from './model-specs.mjs';

export const MODEL_CONTEXT_CACHE_FILE = 'model-context-cache.json';
export const OBSERVED_PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CATALOG_ENTRIES = 4096;
export const MAX_OBSERVED_ENTRIES = 256;

const readCacheByPath = new Map();
const writeQueueByPath = new Map();

export function contextCacheFilePath(dataDir) {
  return dataDir ? join(dataDir, MODEL_CONTEXT_CACHE_FILE) : undefined;
}

export function contextEntryKey(candidate = {}) {
  return createHash('sha256')
    .update(`${candidate.apiFormat || ''}\n${candidate.baseUrl || ''}\n${candidate.model || ''}`)
    .digest('hex');
}

function emptyCache() {
  return { version: 1, updatedAt: null, providers: {}, catalog: {}, observed: {} };
}

function normalizeCache(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCache();
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    providers: raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers) ? { ...raw.providers } : {},
    catalog: raw.catalog && typeof raw.catalog === 'object' && !Array.isArray(raw.catalog) ? { ...raw.catalog } : {},
    observed: raw.observed && typeof raw.observed === 'object' && !Array.isArray(raw.observed) ? { ...raw.observed } : {},
  };
}

export function invalidateContextCache(filePath) {
  if (filePath) readCacheByPath.delete(filePath);
  else readCacheByPath.clear();
}

export function readContextCacheSync(filePath) {
  if (!filePath) return emptyCache();
  try {
    const stats = statSync(filePath);
    const cached = readCacheByPath.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.data;
    }
    const parsed = normalizeCache(JSON.parse(readFileSync(filePath, 'utf8')));
    readCacheByPath.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, data: parsed });
    return parsed;
  } catch {
    readCacheByPath.delete(filePath);
    return emptyCache();
  }
}

export async function readContextCache(filePath) {
  if (!filePath) return emptyCache();
  try {
    return normalizeCache(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    return emptyCache();
  }
}

function normalizeEfforts(list) {
  if (!Array.isArray(list)) return [];
  return EFFORTS.filter(level => list.includes(level));
}

function lookupCatalogEntry(cache, candidate = {}) {
  const key = contextEntryKey(candidate);
  if (cache?.catalog?.[key]) return cache.catalog[key];
  const normalizedModel = normalizeModelId(candidate.model);
  if (normalizedModel && normalizedModel !== String(candidate.model ?? '').trim().toLowerCase()) {
    const normalizedKey = contextEntryKey({ ...candidate, model: normalizedModel });
    if (cache?.catalog?.[normalizedKey]) return cache.catalog[normalizedKey];
  }
  return undefined;
}

function pruneMapByTimestamp(mapObj, maxEntries, timestampField, maxAgeMs, now, { allowEffortsOnly = false } = {}) {
  const entries = Object.entries(mapObj).filter(([, item]) => {
    if (!item || typeof item !== 'object') return false;
    const hasWindow = Number.isSafeInteger(item.contextWindowTokens) && item.contextWindowTokens >= 1;
    const hasEfforts = allowEffortsOnly && Array.isArray(item.efforts) && item.efforts.length > 0;
    if (!hasWindow && !hasEfforts) return false;
    if (maxAgeMs && Number.isFinite(item[timestampField]) && now - item[timestampField] >= maxAgeMs) return false;
    return true;
  });
  if (entries.length <= maxEntries) return Object.fromEntries(entries);
  entries.sort((a, b) => (b[1][timestampField] ?? 0) - (a[1][timestampField] ?? 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export function updateContextCache(filePath, mutator) {
  if (!filePath) return Promise.resolve(emptyCache());
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const current = await readContextCache(filePath);
    const now = Date.now();
    await mutator(current, now);
    current.version = 1;
    current.updatedAt = new Date(now).toISOString();
    current.catalog = pruneMapByTimestamp(current.catalog, MAX_CATALOG_ENTRIES, 'syncedAt', 0, now, { allowEffortsOnly: true });
    current.observed = pruneMapByTimestamp(current.observed, MAX_OBSERVED_ENTRIES, 'observedAt', OBSERVED_PERSIST_TTL_MS, now);
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(current, null, 2)}\n`;
    try {
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, filePath);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    invalidateContextCache(filePath);
    return current;
  });
  writeQueueByPath.set(filePath, next.catch(() => {}));
  return next;
}

export async function recordCatalogSync(filePath, provider, models, { status = 'ok', error = '', now = Date.now() } = {}) {
  if (!filePath || !provider?.id) return emptyCache();
  return updateContextCache(filePath, (draft) => {
    let detectedCount = 0;
    let providerReportedCount = 0;
    let effortsDetectedCount = 0;
    let providerEffortsCount = 0;
    if (Array.isArray(models)) {
      for (const item of models) {
        if (!item?.id) continue;
        const cap = Number(item.contextWindowTokens ?? 0);
        const validCap = Number.isSafeInteger(cap) && cap >= 1 ? cap : 0;
        const incomingEfforts = normalizeEfforts(item.efforts);
        if (!validCap && !incomingEfforts.length) continue;

        const incomingContextSource = validCap
          ? (item.contextSource === 'provider' ? 'provider' : 'reference')
          : 'unknown';
        const incomingEffortsSource = incomingEfforts.length
          ? (item.source === 'provider' ? 'provider' : 'reference')
          : 'manual';

        if (validCap) {
          detectedCount++;
          if (incomingContextSource === 'provider') providerReportedCount++;
        }
        if (incomingEfforts.length) {
          effortsDetectedCount++;
          if (incomingEffortsSource === 'provider') providerEffortsCount++;
        }

        const key = contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: item.id });
        const existing = draft.catalog[key];
        const keepExistingContext = Boolean(
          existing &&
          Number.isSafeInteger(existing.contextWindowTokens) && existing.contextWindowTokens >= 1 &&
          (!validCap || (existing.source === 'provider' && incomingContextSource !== 'provider')),
        );
        const finalCap = keepExistingContext ? existing.contextWindowTokens : validCap;
        const finalContextSource = keepExistingContext ? existing.source : incomingContextSource;

        const existingEfforts = normalizeEfforts(existing?.efforts);
        const existingEffortsSource = existing?.effortsSource ?? (existingEfforts.length ? 'reference' : 'manual');
        const keepExistingEfforts = Boolean(
          existingEfforts.length > 0 &&
          (!incomingEfforts.length || (existingEffortsSource === 'provider' && incomingEffortsSource !== 'provider')),
        );
        const finalEfforts = keepExistingEfforts ? existingEfforts : incomingEfforts;
        const finalEffortsSource = keepExistingEfforts ? existingEffortsSource : incomingEffortsSource;

        draft.catalog[key] = {
          model: item.id,
          contextWindowTokens: finalCap,
          summaryThresholdTokens: finalCap ? summaryThresholdFor(finalCap) : 0,
          source: finalContextSource,
          efforts: finalEfforts,
          effortsSource: finalEffortsSource,
          syncedAt: now,
        };
      }
    }
    draft.providers[provider.id] = {
      syncedAt: new Date(now).toISOString(),
      status,
      modelCount: Array.isArray(models) ? models.length : 0,
      detectedCount,
      providerReportedCount,
      effortsDetectedCount,
      providerEffortsCount,
      error: status === 'error' ? String(error || 'Sync failed').slice(0, 240) : '',
    };
  });
}

export async function persistObservedCeiling(filePath, candidate, entry) {
  if (!filePath || !candidate?.model || !entry || !Number.isSafeInteger(entry.contextWindowTokens) || entry.contextWindowTokens < 1_024) {
    return null;
  }
  const key = contextEntryKey(candidate);
  const now = Number.isFinite(entry.observedAt) ? entry.observedAt : Date.now();
  await updateContextCache(filePath, (draft) => {
    const existing = draft.observed[key];
    const validExisting = existing && Number.isFinite(existing.observedAt) && now - existing.observedAt < OBSERVED_PERSIST_TTL_MS
      ? existing : null;
    const nextWindow = validExisting && validExisting.observedAt >= now - 60_000
      ? Math.min(validExisting.contextWindowTokens, entry.contextWindowTokens)
      : entry.contextWindowTokens;
    draft.observed[key] = {
      model: candidate.model,
      contextWindowTokens: nextWindow,
      summaryThresholdTokens: summaryThresholdFor(nextWindow),
      observedAt: now,
    };
  });
  return entry;
}

/**
 * Resolve the effective context window and summary threshold for one request candidate.
 *
 * Priority:
 * - contextMode === 'auto':
 *     1. Cached upstream API catalog entry (source === 'provider')
 *     2. Built-in reference model specification
 *     3. Persisted / in-memory observed overflow ceiling
 *     4. Configured profile snapshot (if positive)
 * - contextMode === 'manual' (or legacy explicit positive tokens):
 *     Configured profile values.
 *
 * Safety clamp: any active observed overflow ceiling (unless strictly superseded by a newer
 * provider-reported /models sync) always clamps the resolved window downward so compaction
 * triggers before hitting the provider's hard limit.
 */
export function resolveEffectiveContext(candidate = {}, {
  cache,
  observedCeilings,
  now = Date.now(),
  observedMemoryTtlMs = 6 * 60 * 60 * 1000,
  observedPersistTtlMs = OBSERVED_PERSIST_TTL_MS,
} = {}) {
  const configuredWindow = Number.isSafeInteger(candidate.contextWindowTokens) && candidate.contextWindowTokens > 0
    ? candidate.contextWindowTokens : 0;
  const configuredThreshold = Number.isSafeInteger(candidate.summaryThresholdTokens) && candidate.summaryThresholdTokens > 0
    ? candidate.summaryThresholdTokens : 0;
  const autoFollow = candidate.contextMode === 'auto';
  const key = contextEntryKey(candidate);

  // 1. Collect active observed ceiling from in-memory map + persistent disk cache.
  let memObserved = null;
  if (observedCeilings) {
    const entry = observedCeilings.get(key);
    if (entry) {
      if (Number.isFinite(entry.observedAt) && now - entry.observedAt >= observedMemoryTtlMs) {
        observedCeilings.delete(key);
      } else if (Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens >= 1_024) {
        memObserved = entry;
      }
    }
  }
  let diskObserved = null;
  const rawDiskObserved = cache?.observed?.[key];
  if (rawDiskObserved && Number.isSafeInteger(rawDiskObserved.contextWindowTokens) && rawDiskObserved.contextWindowTokens >= 1_024) {
    if (!Number.isFinite(rawDiskObserved.observedAt) || now - rawDiskObserved.observedAt < observedPersistTtlMs) {
      diskObserved = rawDiskObserved;
    }
  }

  let activeObserved = null;
  if (memObserved && diskObserved) {
    activeObserved = memObserved.contextWindowTokens <= diskObserved.contextWindowTokens ? memObserved : diskObserved;
  } else {
    activeObserved = memObserved ?? diskObserved;
  }

  // 2. Check cached upstream catalog entry (exact model ID first, then gateway-prefix-stripped ID e.g. cn:kimi-k3.1-pro).
  const cachedCatalog = lookupCatalogEntry(cache, candidate);
  const providerCatalog = cachedCatalog && cachedCatalog.source === 'provider' &&
    Number.isSafeInteger(cachedCatalog.contextWindowTokens) && cachedCatalog.contextWindowTokens > 0
    ? cachedCatalog : null;

  // A strictly newer provider-reported /models sync can supersede an older persisted overflow ceiling
  // (e.g. when the upstream provider expands a model's context window). If it still overflows at runtime,
  // self-healing will immediately record a newer observedAt > syncedAt.
  const observedSuperseded = Boolean(
    providerCatalog && activeObserved && !memObserved &&
    Number.isFinite(providerCatalog.syncedAt) && Number.isFinite(activeObserved.observedAt) &&
    providerCatalog.syncedAt > activeObserved.observedAt,
  );
  const effectiveObserved = observedSuperseded ? null : activeObserved;

  // 3. Base resolution according to mode.
  let baseWindow = configuredWindow;
  let baseThreshold = configuredThreshold;
  let contextSource = configuredWindow > 0 ? 'manual' : 'unknown';

  if (autoFollow) {
    if (providerCatalog) {
      baseWindow = providerCatalog.contextWindowTokens;
      baseThreshold = summaryThresholdFor(baseWindow);
      contextSource = 'provider';
    } else {
      const ref = referenceContextWindow(candidate.model);
      if (ref) {
        baseWindow = ref.contextWindowTokens;
        baseThreshold = summaryThresholdFor(baseWindow);
        contextSource = 'reference';
      } else if (effectiveObserved) {
        baseWindow = effectiveObserved.contextWindowTokens;
        baseThreshold = summaryThresholdFor(baseWindow);
        contextSource = 'observed';
      } else if (configuredWindow > 0) {
        baseWindow = configuredWindow;
        baseThreshold = configuredThreshold > 0 && configuredThreshold < configuredWindow
          ? configuredThreshold : summaryThresholdFor(configuredWindow);
        contextSource = 'configured';
      } else {
        baseWindow = 0;
        baseThreshold = 0;
        contextSource = 'unknown';
      }
    }
  }

  // 4. Safety clamp by any active observed overflow ceiling.
  if (effectiveObserved) {
    const clampedWindow = baseWindow > 0
      ? Math.min(baseWindow, effectiveObserved.contextWindowTokens)
      : effectiveObserved.contextWindowTokens;
    if (baseWindow === 0 || effectiveObserved.contextWindowTokens <= clampedWindow) {
      const observedThreshold = summaryThresholdFor(clampedWindow);
      const validBase = baseThreshold > 0 && baseThreshold < clampedWindow ? baseThreshold : 0;
      const clampedThreshold = validBase > 0 ? Math.min(validBase, observedThreshold) : observedThreshold;
      return {
        contextWindowTokens: clampedWindow,
        summaryThresholdTokens: clampedThreshold,
        contextSource: (baseWindow === 0 || effectiveObserved.contextWindowTokens < baseWindow) ? 'observed' : contextSource,
        contextMode: autoFollow ? 'auto' : 'manual',
      };
    }
  }

  return {
    contextWindowTokens: baseWindow,
    summaryThresholdTokens: baseThreshold,
    contextSource,
    contextMode: autoFollow ? 'auto' : 'manual',
  };
}

/**
 * Resolve the effective supported reasoning efforts for one profile/candidate.
 *
 * Priority:
 * - effortsMode === 'auto':
 *     1. Cached upstream API catalog entry (effortsSource === 'provider')
 *     2. Built-in reference effortLevels(model)
 *     3. Cached catalog efforts (for legacy caches written before effortsSource)
 *     4. Configured profile snapshot
 * - effortsMode === 'manual' (default for legacy profiles with manual efforts):
 *     Configured profile values.
 */
export function resolveEffectiveEfforts(candidate = {}, { cache } = {}) {
  const configured = normalizeEfforts(candidate.efforts);
  const autoFollow = candidate.effortsMode === 'auto';
  if (!autoFollow) {
    return {
      efforts: configured,
      effortsSource: configured.length ? 'manual' : 'unknown',
      effortsMode: 'manual',
    };
  }
  const cached = lookupCatalogEntry(cache, candidate);
  const cachedEfforts = normalizeEfforts(cached?.efforts);
  if (cached && cachedEfforts.length && cached.effortsSource === 'provider') {
    return {
      efforts: cachedEfforts,
      effortsSource: 'provider',
      effortsMode: 'auto',
    };
  }
  const refEfforts = effortLevels(candidate.model);
  if (refEfforts.length) {
    return {
      efforts: refEfforts,
      effortsSource: 'reference',
      effortsMode: 'auto',
    };
  }
  if (cached && cachedEfforts.length) {
    return {
      efforts: cachedEfforts,
      effortsSource: cached.effortsSource ?? (cached.source === 'provider' ? 'provider' : 'reference'),
      effortsMode: 'auto',
    };
  }
  return {
    efforts: configured,
    effortsSource: configured.length ? 'configured' : 'unknown',
    effortsMode: 'auto',
  };
}
