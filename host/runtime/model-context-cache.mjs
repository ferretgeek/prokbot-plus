// Persistent caches for upstream /models capabilities (written only by the Admin Server
// to model-context-cache.json) and runtime-observed overflow ceilings (written only by the
// Host runtime to model-context-observed.json) so two processes never race on the same file.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EFFORTS, effortLevels, summaryThresholdFor } from './model-policy.mjs';
import { normalizeModelId } from './model-specs.mjs';

export const MODEL_CONTEXT_CACHE_FILE = 'model-context-cache.json';
export const MODEL_CONTEXT_OBSERVED_FILE = 'model-context-observed.json';
export const OBSERVED_PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CATALOG_ENTRIES = 4096;
export const MAX_OBSERVED_ENTRIES = 256;
export const DEFAULT_SYNC_SETTINGS = Object.freeze({ autoSync: true, codexManifestProbe: false });

const readCacheByPath = new Map();
const writeQueueByPath = new Map();

export function contextCacheFilePath(dataDir) {
  return dataDir ? join(dataDir, MODEL_CONTEXT_CACHE_FILE) : undefined;
}

export function observedCacheFilePath(filePath) {
  if (!filePath) return undefined;
  return join(dirname(filePath), MODEL_CONTEXT_OBSERVED_FILE);
}

export function contextEntryKey(candidate = {}) {
  return createHash('sha256')
    .update(`${candidate.apiFormat || ''}\n${candidate.baseUrl || ''}\n${candidate.model || ''}`)
    .digest('hex');
}

function emptyCatalogFile() {
  return {
    version: 1,
    updatedAt: null,
    settings: { ...DEFAULT_SYNC_SETTINGS },
    clearedObserved: { allAt: 0, keys: {} },
    providers: {},
    catalog: {},
  };
}

function emptyObservedFile() {
  return { version: 1, updatedAt: null, observed: {} };
}

function emptyCache() {
  return { ...emptyCatalogFile(), observed: {} };
}

function normalizeSettings(raw) {
  return {
    autoSync: typeof raw?.autoSync === 'boolean' ? raw.autoSync : DEFAULT_SYNC_SETTINGS.autoSync,
    codexManifestProbe: typeof raw?.codexManifestProbe === 'boolean' ? raw.codexManifestProbe : DEFAULT_SYNC_SETTINGS.codexManifestProbe,
  };
}

function normalizeClearedObserved(raw) {
  const allAt = Number.isFinite(raw?.allAt) && raw.allAt > 0 ? raw.allAt : 0;
  const keys = {};
  if (raw?.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys)) {
    for (const [key, value] of Object.entries(raw.keys)) {
      if (Number.isFinite(value) && value > 0) keys[key] = value;
    }
  }
  return { allAt, keys };
}

function normalizeCatalogFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCatalogFile();
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    settings: normalizeSettings(raw.settings),
    clearedObserved: normalizeClearedObserved(raw.clearedObserved),
    providers: raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers) ? { ...raw.providers } : {},
    catalog: raw.catalog && typeof raw.catalog === 'object' && !Array.isArray(raw.catalog) ? { ...raw.catalog } : {},
  };
}

function normalizeObservedFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyObservedFile();
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    observed: raw.observed && typeof raw.observed === 'object' && !Array.isArray(raw.observed) ? { ...raw.observed } : {},
  };
}

function clearedTimestampFor(clearedObserved, key) {
  const allAt = Number.isFinite(clearedObserved?.allAt) ? clearedObserved.allAt : 0;
  const keyAt = key && Number.isFinite(clearedObserved?.keys?.[key]) ? clearedObserved.keys[key] : 0;
  return Math.max(allAt, keyAt, 0);
}

function mergeCache(catalogData, observedData) {
  const cleared = catalogData.clearedObserved ?? { allAt: 0, keys: {} };
  const activeObserved = {};
  for (const [key, entry] of Object.entries(observedData.observed ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const clearedAt = clearedTimestampFor(cleared, key);
    if (clearedAt > 0 && (!Number.isFinite(entry.observedAt) || entry.observedAt <= clearedAt)) continue;
    activeObserved[key] = entry;
  }
  return {
    ...catalogData,
    observed: activeObserved,
  };
}

export function invalidateContextCache(filePath) {
  if (filePath) {
    readCacheByPath.delete(filePath);
    const observedPath = observedCacheFilePath(filePath);
    if (observedPath) readCacheByPath.delete(observedPath);
  } else {
    readCacheByPath.clear();
  }
}

function readJsonFileSyncCached(path, normalize, empty) {
  if (!path) return empty();
  let stats;
  try {
    stats = statSync(path);
  } catch {
    readCacheByPath.delete(path);
    return empty();
  }
  const cached = readCacheByPath.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.data;
  }
  let data;
  try {
    data = normalize(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Cache empty fallback for a damaged file keyed by (mtimeMs, size) so every turn does not re-read/re-parse it.
    data = empty();
  }
  readCacheByPath.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, data });
  return data;
}

export function readContextCacheSync(filePath) {
  if (!filePath) return emptyCache();
  const catalogData = readJsonFileSyncCached(filePath, normalizeCatalogFile, emptyCatalogFile);
  const observedFile = readJsonFileSyncCached(observedCacheFilePath(filePath), normalizeObservedFile, emptyObservedFile);
  // Also support legacy single-file caches that embedded `observed` directly in model-context-cache.json.
  const legacyRaw = readCacheByPath.get(filePath);
  const mergedObserved = {
    observed: {
      ...(legacyRaw?.legacyObserved ?? {}),
      ...observedFile.observed,
    },
  };
  return mergeCache(catalogData, mergedObserved);
}

async function readJsonFile(path, normalize, empty) {
  if (!path) return empty();
  try {
    return normalize(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return empty();
  }
}

export async function readContextCache(filePath) {
  if (!filePath) return emptyCache();
  let rawCatalog = null;
  try {
    rawCatalog = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    rawCatalog = null;
  }
  const catalogData = normalizeCatalogFile(rawCatalog);
  const observedFile = await readJsonFile(observedCacheFilePath(filePath), normalizeObservedFile, emptyObservedFile);
  const legacyObserved = rawCatalog?.observed && typeof rawCatalog.observed === 'object' && !Array.isArray(rawCatalog.observed)
    ? rawCatalog.observed : {};
  return mergeCache(catalogData, { observed: { ...legacyObserved, ...observedFile.observed } });
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
    const hasWindow = Number.isSafeInteger(item.contextWindowTokens) && item.contextWindowTokens >= 1_024;
    const hasEfforts = allowEffortsOnly && Array.isArray(item.efforts) && item.efforts.length > 0;
    if (!hasWindow && !hasEfforts) return false;
    if (maxAgeMs && Number.isFinite(item[timestampField]) && now - item[timestampField] >= maxAgeMs) return false;
    return true;
  });
  if (entries.length <= maxEntries) return Object.fromEntries(entries);
  entries.sort((a, b) => (b[1][timestampField] ?? 0) - (a[1][timestampField] ?? 0));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

async function writeAtomicJson(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await writeFile(temp, payload, { mode: 0o600 });
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  readCacheByPath.delete(filePath);
}

function enqueueFileUpdate(filePath, readFn, finalizeFn, mutator) {
  if (!filePath) return Promise.resolve(null);
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const current = await readFn(filePath);
    const now = Date.now();
    await mutator(current, now);
    const finalized = finalizeFn(current, now);
    await writeAtomicJson(filePath, finalized);
    return finalized;
  });
  writeQueueByPath.set(filePath, next.catch(() => {}));
  return next;
}

export function updateContextCache(filePath, mutator) {
  if (!filePath) return Promise.resolve(emptyCache());
  return enqueueFileUpdate(
    filePath,
    path => readJsonFile(path, normalizeCatalogFile, emptyCatalogFile),
    (current, now) => {
      current.version = 1;
      current.updatedAt = new Date(now).toISOString();
      current.settings = normalizeSettings(current.settings);
      current.clearedObserved = normalizeClearedObserved(current.clearedObserved);
      current.catalog = pruneMapByTimestamp(current.catalog, MAX_CATALOG_ENTRIES, 'syncedAt', 0, now, { allowEffortsOnly: true });
      return current;
    },
    mutator,
  );
}

export async function updateSyncSettings(filePath, settings = {}) {
  if (!filePath) return { ...DEFAULT_SYNC_SETTINGS };
  const updated = await updateContextCache(filePath, (draft) => {
    draft.settings = {
      autoSync: typeof settings.autoSync === 'boolean' ? settings.autoSync : draft.settings.autoSync,
      codexManifestProbe: typeof settings.codexManifestProbe === 'boolean'
        ? settings.codexManifestProbe : draft.settings.codexManifestProbe,
    };
  });
  return updated.settings;
}

export async function clearObservedCache(filePath, { keys, now = Date.now() } = {}) {
  if (!filePath) return emptyCache();
  const observedFile = await readJsonFile(observedCacheFilePath(filePath), normalizeObservedFile, emptyObservedFile);
  await updateContextCache(filePath, (draft) => {
    draft.clearedObserved ??= { allAt: 0, keys: {} };
    if (Array.isArray(keys) && keys.length > 0) {
      for (const key of keys) {
        if (typeof key === 'string' && key) {
          const existingAt = Number.isFinite(observedFile.observed?.[key]?.observedAt) ? observedFile.observed[key].observedAt : 0;
          draft.clearedObserved.keys[key] = Math.max(draft.clearedObserved.keys[key] ?? 0, now, existingAt);
        }
      }
    } else {
      const maxExistingAt = Object.values(observedFile.observed ?? {}).reduce(
        (max, item) => Math.max(max, Number.isFinite(item?.observedAt) ? item.observedAt : 0),
        0,
      );
      draft.clearedObserved.allAt = Math.max(draft.clearedObserved.allAt ?? 0, now, maxExistingAt);
      draft.clearedObserved.keys = {};
    }
  });
  return readContextCache(filePath);
}

export async function recordCatalogSync(filePath, provider, models, { status = 'ok', error = '', now = Date.now(), clearObserved = false } = {}) {
  if (!filePath || !provider?.id) return emptyCache();
  await updateContextCache(filePath, (draft) => {
    let detectedCount = 0;
    let providerReportedCount = 0;
    let effortsDetectedCount = 0;
    let providerEffortsCount = 0;
    const clearedKeys = [];
    if (Array.isArray(models)) {
      for (const item of models) {
        if (!item?.id) continue;
        const cap = Number(item.contextWindowTokens ?? 0);
        const validCap = item.contextSource === 'provider' && Number.isSafeInteger(cap) && cap >= 1_024 ? cap : 0;
        const incomingEfforts = item.source === 'provider' ? normalizeEfforts(item.efforts) : [];
        if (!validCap && !incomingEfforts.length) continue;

        const key = contextEntryKey({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: item.id });
        if (clearObserved) clearedKeys.push(key);

        if (validCap) {
          detectedCount++;
          providerReportedCount++;
        }
        if (incomingEfforts.length) {
          effortsDetectedCount++;
          providerEffortsCount++;
        }

        const existing = draft.catalog[key];
        const keepExistingContext = Boolean(
          existing &&
          existing.source === 'provider' &&
          Number.isSafeInteger(existing.contextWindowTokens) && existing.contextWindowTokens >= 1_024 &&
          !validCap,
        );
        const finalCap = keepExistingContext ? existing.contextWindowTokens : validCap;
        const finalContextSource = finalCap ? 'provider' : 'unknown';

        const existingEfforts = normalizeEfforts(existing?.efforts);
        const existingEffortsSource = existing?.effortsSource ?? (existingEfforts.length ? 'reference' : 'manual');
        const keepExistingEfforts = Boolean(
          existingEfforts.length > 0 &&
          existingEffortsSource === 'provider' &&
          !incomingEfforts.length,
        );
        const finalEfforts = keepExistingEfforts ? existingEfforts : incomingEfforts;
        const finalEffortsSource = finalEfforts.length ? 'provider' : 'manual';

        draft.catalog[key] = {
          model: item.id,
          contextWindowTokens: finalCap,
          summaryThresholdTokens: finalCap ? summaryThresholdFor(finalCap, { apiFormat: provider.apiFormat, model: item.id }) : 0,
          source: finalContextSource,
          efforts: finalEfforts,
          effortsSource: finalEffortsSource,
          syncedAt: now,
        };
      }
    }
    if (clearObserved) {
      draft.clearedObserved ??= { allAt: 0, keys: {} };
      if (clearedKeys.length) {
        for (const key of clearedKeys) {
          draft.clearedObserved.keys[key] = Math.max(draft.clearedObserved.keys[key] ?? 0, now);
        }
      } else {
        draft.clearedObserved.allAt = Math.max(draft.clearedObserved.allAt ?? 0, now);
        draft.clearedObserved.keys = {};
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
  return readContextCache(filePath);
}

export async function persistObservedCeiling(filePath, candidate, entry) {
  const observedPath = observedCacheFilePath(filePath);
  if (!observedPath || !candidate?.model || !entry || !Number.isSafeInteger(entry.contextWindowTokens) || entry.contextWindowTokens < 1_024) {
    return null;
  }
  const key = contextEntryKey(candidate);
  const catalogData = await readJsonFile(filePath, normalizeCatalogFile, emptyCatalogFile);
  const clearedAt = clearedTimestampFor(catalogData.clearedObserved, key);
  const rawNow = Number.isFinite(entry.observedAt) ? entry.observedAt : Date.now();
  const observedAt = rawNow <= clearedAt ? clearedAt + 1 : rawNow;

  await enqueueFileUpdate(
    observedPath,
    path => readJsonFile(path, normalizeObservedFile, emptyObservedFile),
    (current, now) => {
      current.version = 1;
      current.updatedAt = new Date(now).toISOString();
      current.observed = pruneMapByTimestamp(current.observed, MAX_OBSERVED_ENTRIES, 'observedAt', OBSERVED_PERSIST_TTL_MS, now);
      return current;
    },
    (draft, now) => {
      // Drop entries that have been cleared by the Admin Server.
      for (const [existingKey, item] of Object.entries(draft.observed)) {
        const keyClearedAt = clearedTimestampFor(catalogData.clearedObserved, existingKey);
        if (keyClearedAt > 0 && (!Number.isFinite(item?.observedAt) || item.observedAt <= keyClearedAt)) {
          delete draft.observed[existingKey];
        }
      }
      const existing = draft.observed[key];
      const validExisting = existing && Number.isFinite(existing.observedAt) && now - existing.observedAt < OBSERVED_PERSIST_TTL_MS
        ? existing : null;
      const nextWindow = validExisting && validExisting.observedAt >= observedAt - 60_000
        ? Math.min(validExisting.contextWindowTokens, entry.contextWindowTokens)
        : entry.contextWindowTokens;
      const nextThreshold = Number.isSafeInteger(entry.summaryThresholdTokens) && entry.summaryThresholdTokens > 0 && entry.summaryThresholdTokens < nextWindow
        ? entry.summaryThresholdTokens
        : summaryThresholdFor(nextWindow, { apiFormat: candidate.apiFormat, model: candidate.model });
      draft.observed[key] = {
        model: candidate.model,
        contextWindowTokens: nextWindow,
        summaryThresholdTokens: nextThreshold,
        observedAt,
      };
    },
  );
  return { ...entry, observedAt };
}

/**
 * Resolve the effective context window and summary threshold for one request candidate.
 *
 * - contextMode === 'auto':
 *     1. Cached upstream API catalog entry (source === 'provider', >= 1024)
 *     2. Configured profile snapshot (if positive)
 *     3. Active observed overflow ceiling (never superseded by periodic sync; cleared only explicitly or on TTL expiry)
 *     Never falls back to built-in reference guesses.
 * - contextMode === 'manual' (default for legacy profiles):
 *     Configured profile values, never clamped by observed ceilings.
 */
export function resolveEffectiveContext(candidate = {}, {
  cache,
  observedCeilings,
  now = Date.now(),
  maxTokens,
  observedMemoryTtlMs = 6 * 60 * 60 * 1000,
  observedPersistTtlMs = OBSERVED_PERSIST_TTL_MS,
} = {}) {
  const configuredWindow = Number.isSafeInteger(candidate.contextWindowTokens) && candidate.contextWindowTokens > 0
    ? candidate.contextWindowTokens : 0;
  const configuredThreshold = Number.isSafeInteger(candidate.summaryThresholdTokens) && candidate.summaryThresholdTokens > 0
    ? candidate.summaryThresholdTokens : 0;
  const autoFollow = candidate.contextMode === 'auto' || (candidate.contextMode === undefined && configuredWindow === 0);
  const key = contextEntryKey(candidate);
  const clearedAt = clearedTimestampFor(cache?.clearedObserved, key);

  let memObserved = null;
  if (observedCeilings) {
    const entry = observedCeilings.get(key);
    if (entry) {
      if ((clearedAt > 0 && (!Number.isFinite(entry.observedAt) || entry.observedAt <= clearedAt)) ||
          (Number.isFinite(entry.observedAt) && now - entry.observedAt >= observedMemoryTtlMs)) {
        observedCeilings.delete(key);
      } else if (Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens >= 1_024) {
        memObserved = entry;
      }
    }
  }
  let diskObserved = null;
  const rawDiskObserved = cache?.observed?.[key];
  if (rawDiskObserved && Number.isSafeInteger(rawDiskObserved.contextWindowTokens) && rawDiskObserved.contextWindowTokens >= 1_024) {
    const notCleared = clearedAt === 0 || (Number.isFinite(rawDiskObserved.observedAt) && rawDiskObserved.observedAt > clearedAt);
    const notExpired = !Number.isFinite(rawDiskObserved.observedAt) || now - rawDiskObserved.observedAt < observedPersistTtlMs;
    if (notCleared && notExpired) {
      diskObserved = rawDiskObserved;
    }
  }

  let activeObserved = null;
  if (memObserved && diskObserved) {
    activeObserved = memObserved.contextWindowTokens <= diskObserved.contextWindowTokens ? memObserved : diskObserved;
  } else {
    activeObserved = memObserved ?? diskObserved;
  }

  const observedInfo = activeObserved ? {
    contextWindowTokens: activeObserved.contextWindowTokens,
    summaryThresholdTokens: activeObserved.summaryThresholdTokens || summaryThresholdFor(activeObserved.contextWindowTokens, {
      apiFormat: candidate.apiFormat, model: candidate.model, maxTokens,
    }),
    observedAt: activeObserved.observedAt,
  } : undefined;

  if (!autoFollow) {
    return {
      contextWindowTokens: configuredWindow,
      summaryThresholdTokens: configuredThreshold,
      contextSource: configuredWindow > 0 ? 'manual' : 'unknown',
      contextMode: 'manual',
      ...(observedInfo ? { observed: observedInfo } : {}),
    };
  }

  // Auto mode: upstream provider catalog only (never built-in reference guesses), then observed clamp.
  const cachedCatalog = lookupCatalogEntry(cache, candidate);
  const providerCatalog = cachedCatalog && cachedCatalog.source === 'provider' &&
    Number.isSafeInteger(cachedCatalog.contextWindowTokens) && cachedCatalog.contextWindowTokens >= 1_024
    ? cachedCatalog : null;

  let baseWindow = 0;
  let baseThreshold = 0;
  let contextSource = 'unknown';

  if (providerCatalog) {
    baseWindow = providerCatalog.contextWindowTokens;
    baseThreshold = summaryThresholdFor(baseWindow, { apiFormat: candidate.apiFormat, model: candidate.model, maxTokens });
    contextSource = 'provider';
  } else if (configuredWindow > 0) {
    baseWindow = configuredWindow;
    baseThreshold = configuredThreshold > 0 && configuredThreshold < configuredWindow
      ? configuredThreshold
      : summaryThresholdFor(configuredWindow, { apiFormat: candidate.apiFormat, model: candidate.model, maxTokens });
    contextSource = 'configured';
  }

  if (activeObserved) {
    const clampedWindow = baseWindow > 0
      ? Math.min(baseWindow, activeObserved.contextWindowTokens)
      : activeObserved.contextWindowTokens;
    const defaultObservedThreshold = summaryThresholdFor(clampedWindow, {
      apiFormat: candidate.apiFormat, model: candidate.model, maxTokens,
    });
    const recordedThreshold = Number.isSafeInteger(activeObserved.summaryThresholdTokens) &&
      activeObserved.summaryThresholdTokens > 0 && activeObserved.summaryThresholdTokens < clampedWindow
      ? activeObserved.summaryThresholdTokens : 0;
    const observedThreshold = recordedThreshold > 0
      ? Math.min(recordedThreshold, defaultObservedThreshold)
      : defaultObservedThreshold;
    if (baseWindow === 0 || activeObserved.contextWindowTokens <= clampedWindow) {
      const validBase = baseThreshold > 0 && baseThreshold < clampedWindow ? baseThreshold : 0;
      const clampedThreshold = validBase > 0 ? Math.min(validBase, observedThreshold) : observedThreshold;
      return {
        contextWindowTokens: clampedWindow,
        summaryThresholdTokens: clampedThreshold,
        contextSource: (baseWindow === 0 || activeObserved.contextWindowTokens < baseWindow ||
          (validBase === 0 || observedThreshold < validBase)) ? 'observed' : contextSource,
        contextMode: 'auto',
        observed: observedInfo,
      };
    }
  }

  return {
    contextWindowTokens: baseWindow,
    summaryThresholdTokens: baseThreshold,
    contextSource,
    contextMode: 'auto',
    ...(observedInfo ? { observed: observedInfo } : {}),
  };
}

/**
 * Resolve the effective supported reasoning efforts for one profile/candidate.
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
