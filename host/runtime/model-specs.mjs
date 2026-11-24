// Curated conservative reference context-window specifications for well-known
// published model families. Shown as optional suggestions in the admin UI
// (never applied automatically in `auto` mode) when a provider's /models
// catalog omits context capacity.
//
// Safety rule: never match unknown or unpublished model variants (such as
// fictional test IDs or custom fine-tunes) so the Harness never defers
// compaction past an unknown model's real ceiling.

const PROVIDER_PREFIXES = [
  'openrouter/',
  'openai/',
  'anthropic/',
  'google/',
  'deepseek/',
  'deepseek-ai/',
  'x-ai/',
  'xai/',
  'meta-llama/',
  'qwen/',
  'moonshotai/',
  'moonshot/',
  'z-ai/',
  'zhipu/',
  'zhipuai/',
  'minimax/',
  'mistralai/',
  'bytedance/',
  'volcengine/',
  'doubao/',
  'models/',
  'pro/',
  'free/',
  'bedrock/',
  'vertex/',
  'azure/',
  'accounts/fireworks/models/',
];

const ROUTING_SUFFIX_RE = /(?::(?:free|beta|extended|thinking|online|nitro|floor|exacto)|@(?:default|latest|\d{8}))+$/i;
const DATE_SNAPSHOT_RE = /(?:-20\d{2}-\d{2}-\d{2}|-20\d{6}|-latest|-preview(?:-\d{2}-\d{2})?|-exp(?:-\d{4})?)$/i;

/**
 * Normalize a provider-prefixed or date-snapshotted model ID into a canonical
 * lowercase identifier for capability lookup.
 */
export function normalizeModelId(raw) {
  let id = String(raw ?? '').trim().toLowerCase();
  if (!id) return '';

  // Strip known aggregator / gateway prefixes (possibly nested, e.g. openrouter/anthropic/... or cn:...).
  let changed = true;
  while (changed) {
    changed = false;
    const regionStripped = id.replace(/^(?:cn|us|eu|ap|sg|jp|hk|global):/, '');
    if (regionStripped !== id) {
      id = regionStripped;
      changed = true;
    }
    for (const prefix of PROVIDER_PREFIXES) {
      if (id.startsWith(prefix)) {
        id = id.slice(prefix.length);
        changed = true;
      }
    }
  }

  // Strip OpenRouter / gateway routing suffixes (e.g. :free, :thinking, @20250514).
  id = id.replace(ROUTING_SUFFIX_RE, '');

  // Strip Bedrock cross-region prefix (us.anthropic.claude-... -> claude-...)
  id = id.replace(/^(?:us|eu|ap|global)\.(?:anthropic|amazon|meta|deepseek|mistral)\./, '');
  id = id.replace(/^(?:anthropic|amazon|meta|deepseek|mistral)\./, '');
  // Strip Bedrock version suffix (:0, -v1:0)
  id = id.replace(/-v\d+:\d+$/, '').replace(/:\d+$/, '');

  return id.trim();
}

function candidateIds(id) {
  const candidates = [id];
  let current = id;
  for (let i = 0; i < 3; i++) {
    const next = current.replace(DATE_SNAPSHOT_RE, '');
    if (!next || next === current) break;
    candidates.push(next);
    current = next;
  }
  return candidates;
}

// Explicit rules ordered from most specific to broader published families.
// Only published, documented models are listed; unknown future versions stay null.
const CONTEXT_SPEC_RULES = [
  // Anthropic Claude 4.6 / 4.7 (1M GA context window; older 4.x 1M aliases require a beta header we do not send)
  { family: 'claude-4.6+', match: /^claude-(?:opus|sonnet)-4[.-][67]$/, tokens: 1_000_000 },
  { family: 'claude-4.6+', match: /^claude-4[.-][67]-(?:opus|sonnet)$/, tokens: 1_000_000 },

  // Anthropic Claude 3 / 3.5 / 3.7 / 4 / 4.1 / 4.5 (200K standard baseline)
  { family: 'claude-4', match: /^claude-(?:opus|sonnet|haiku)-4(?:[.-][015])?$/, tokens: 200_000 },
  { family: 'claude-4', match: /^claude-4(?:[.-][015])?-(?:opus|sonnet|haiku)$/, tokens: 200_000 },
  { family: 'claude-3.x', match: /^claude-3(?:[.-][57])?-(?:opus|sonnet|haiku)$/, tokens: 200_000 },

  // OpenAI GPT-5.4 (1M for flagship/pro, 400K for mini/nano)
  { family: 'gpt-5.4-mini', match: /^gpt-5\.4-(?:mini|nano)$/, tokens: 400_000 },
  { family: 'gpt-5.4', match: /^gpt-5\.4(?:-pro|-codex|-chat)?$/, tokens: 1_050_000 },

  // OpenAI GPT-5 chat-latest (128K) before general GPT-5 / 5.1 / 5.2 / 5.3 (400K)
  { family: 'gpt-5-chat', match: /^gpt-5(?:\.[123])?-chat$/, tokens: 128_000 },
  { family: 'gpt-5', match: /^gpt-5(?:\.[123])?(?:-(?:mini|nano|pro|codex|codex-mini|codex-max))?$/, tokens: 400_000 },

  // OpenAI GPT-4.1 family (1,047,576 tokens)
  { family: 'gpt-4.1', match: /^gpt-4\.1(?:-(?:mini|nano))?$/, tokens: 1_047_576 },

  // OpenAI o1 / o3 / o4 reasoning families & codex-mini
  { family: 'openai-o-series', match: /^o1-(?:preview|mini)$/, tokens: 128_000 },
  { family: 'openai-o-series', match: /^o(?:1|3|4)(?:-(?:mini|pro|mini-high|deep-research))?$/, tokens: 200_000 },
  { family: 'codex-mini', match: /^codex-mini$/, tokens: 200_000 },

  // OpenAI GPT-4o / GPT-4 Turbo / legacy GPT-4 / GPT-OSS
  { family: 'gpt-4o', match: /^(?:chatgpt-)?gpt-4o(?:-(?:mini|audio|realtime|search))?$/, tokens: 128_000 },
  { family: 'gpt-4-turbo', match: /^gpt-4-turbo$/, tokens: 128_000 },
  { family: 'gpt-4-32k', match: /^gpt-4-32k$/, tokens: 32_768 },
  { family: 'gpt-4', match: /^gpt-4$/, tokens: 8_192 },
  { family: 'gpt-oss', match: /^gpt-oss-(?:20b|120b)$/, tokens: 131_072 },

  // Google Gemini 1.5 / 2.0 / 2.5 / 3.x
  { family: 'gemini-1.5-pro', match: /^gemini-1\.5-pro(?:-\d{3})?$/, tokens: 2_097_152 },
  { family: 'gemini-1.5-flash', match: /^gemini-1\.5-flash(?:-8b)?(?:-\d{3})?$/, tokens: 1_048_576 },
  { family: 'gemini-2.0-thinking-exp', match: /^gemini-2\.0-flash-thinking-exp(?:-1219)?$/, tokens: 32_768 },
  { family: 'gemini-2.x', match: /^gemini-2\.0-(?:pro|flash|flash-lite)(?:-\d{3})?$/, tokens: 1_048_576 },
  { family: 'gemini-2.x', match: /^gemini-2\.5-(?:pro|flash|flash-lite)(?:-thinking)?(?:-\d{3})?$/, tokens: 1_048_576 },
  { family: 'gemini-3.x', match: /^gemini-3(?:\.\d)?-(?:pro|flash|flash-lite)(?:-thinking)?$/, tokens: 1_048_576 },

  // DeepSeek official V3 / R1 / Chat / Reasoner (128K)
  { family: 'deepseek', match: /^deepseek-(?:chat|reasoner|coder)$/, tokens: 128_000 },
  { family: 'deepseek-v3', match: /^deepseek-v3(?:\.[12])?(?:-(?:base|chat|terminus|speciale|exp))?$/, tokens: 128_000 },
  { family: 'deepseek-r1', match: /^deepseek-r1(?:-0528|-zero|-distill-[a-z0-9.-]+)?$/, tokens: 128_000 },

  // xAI Grok 2 / 3 / 4
  { family: 'grok-4-fast', match: /^grok-4(?:[.-]1)?-fast(?:-reasoning|-non-reasoning)?$/, tokens: 2_000_000 },
  { family: 'grok-4', match: /^grok-4(?:-0709|-heavy)?$/, tokens: 256_000 },
  { family: 'grok-code-fast', match: /^grok-code-fast(?:-\d+)?$/, tokens: 256_000 },
  { family: 'grok-3', match: /^grok-3(?:-(?:mini|fast|mini-fast))?$/, tokens: 131_072 },
  { family: 'grok-2-vision', match: /^grok-2-vision(?:-\d{4})?$/, tokens: 32_768 },
  { family: 'grok-2', match: /^grok-2(?:-1212)?$/, tokens: 131_072 },

  // Alibaba Qwen / QwQ
  { family: 'qwen-long', match: /^qwen-(?:long|turbo|plus)$/, tokens: 1_000_000 },
  { family: 'qwen3-coder-plus', match: /^qwen3-coder-(?:plus|flash)$/, tokens: 1_000_000 },
  { family: 'qwen3-coder-480b', match: /^qwen3-coder-480b(?:-a35b)?(?:-instruct)?$/, tokens: 262_144 },
  { family: 'qwen3-32k', match: /^qwen3-(?:32b|14b|8b|4b)(?:-[a-z0-9.-]+)?$/, tokens: 32_768 },
  { family: 'qwen3', match: /^qwen3-(?:max|plus|turbo|235b|30b)(?:-[a-z0-9.-]+)?$/, tokens: 131_072 },
  { family: 'qwen2.5', match: /^qwen-?2\.5(?:-(?:coder|vl|max|plus|turbo|72b|32b|14b|7b)(?:-[a-z0-9.-]+)?)?$/, tokens: 131_072 },
  { family: 'qwen-max', match: /^qwen-max$/, tokens: 32_768 },
  { family: 'qwq', match: /^qwq-(?:32b|plus)$/, tokens: 131_072 },

  // Moonshot Kimi
  { family: 'kimi-k2-256k', match: /^kimi-k2(?:\.5|-0905|-thinking(?:-turbo)?|-turbo)$/, tokens: 262_144 },
  { family: 'kimi-k2', match: /^kimi-k2(?:-0711|-instruct)?$/, tokens: 131_072 },
  { family: 'moonshot-v1', match: /^moonshot-v1-128k$/, tokens: 131_072 },
  { family: 'moonshot-v1', match: /^moonshot-v1-32k$/, tokens: 32_768 },
  { family: 'moonshot-v1', match: /^moonshot-v1-8k$/, tokens: 8_192 },

  // Zhipu GLM
  { family: 'glm-4.6+', match: /^glm-(?:4\.[67]|5)(?:-(?:air|flash|flashx|plus|v|thinking))?$/, tokens: 200_000 },
  { family: 'glm-4.5', match: /^glm-4\.5(?:-(?:air|flash|x|v))?$/, tokens: 128_000 },
  { family: 'glm-4-long', match: /^glm-4-long$/, tokens: 1_000_000 },
  { family: 'glm-4-airx', match: /^glm-4-airx$/, tokens: 8_192 },
  { family: 'glm-4', match: /^glm-4(?:-(?:plus|air|flash|flashx|0520))?$/, tokens: 128_000 },

  // MiniMax
  { family: 'minimax-m1', match: /^minimax-m1(?:-40k|-80k)?$/, tokens: 1_000_000 },
  { family: 'minimax-m2', match: /^minimax-(?:m2(?:\.[15])?(?:-highspeed)?|text-01)$/, tokens: 204_800 },

  // ByteDance Doubao / Seed
  { family: 'doubao-seed-1.6', match: /^doubao-seed-1[.-]6(?:-(?:thinking|flash|vision))?$/, tokens: 256_000 },
  { family: 'doubao-1.5-256k', match: /^doubao-1[.-]5-(?:pro|lite|thinking-pro)-256k$/, tokens: 256_000 },
  { family: 'doubao-1.5-32k', match: /^doubao-1[.-]5-(?:pro|lite|thinking-pro)-32k$/, tokens: 32_768 },
  { family: 'doubao-1.5-thinking-pro', match: /^doubao-1[.-]5-thinking-pro$/, tokens: 128_000 },

  // Meta Llama & Mistral
  { family: 'llama-4', match: /^llama-4-(?:scout|maverick)(?:-[a-z0-9.-]+)?$/, tokens: 256_000 },
  { family: 'llama-3.x', match: /^llama-3\.[123]-[a-z0-9.-]+$/, tokens: 131_072 },
  { family: 'codestral-2405', match: /^codestral-2405$/, tokens: 32_768 },
  { family: 'codestral', match: /^codestral(?:-25\d{2}|-latest)?$/, tokens: 256_000 },
  { family: 'mistral-small-32k', match: /^mistral-small-(?:2402|2409|2501)$/, tokens: 32_768 },
  { family: 'mistral', match: /^(?:mistral-(?:large|medium|small)|pixtral-(?:large|12b))(?:-v\d+|-\d{4})?$/, tokens: 128_000 },
];

/**
 * Look up a documented reference context window for a well-known model ID.
 * Returns `{ contextWindowTokens, family }` or `null` for unknown/unpublished models.
 */
export function referenceContextWindow(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;

  // Try exact normalized ID first, then progressively snapshot-stripped candidates.
  for (const candidate of candidateIds(normalized)) {
    for (const rule of CONTEXT_SPEC_RULES) {
      if (rule.match.test(candidate)) {
        return { contextWindowTokens: rule.tokens, family: rule.family };
      }
    }
  }
  return null;
}

/**
 * Parse a positive safe integer token count (>= 1024) from an API catalog field
 * (accepts integers or clean numeric strings such as "128000").
 */
export function parseReportedCapacity(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1_024 && value <= 100_000_000 ? value : undefined;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim();
    if (/^\d{4,9}$/.test(cleaned)) {
      const parsed = Number(cleaned);
      return Number.isSafeInteger(parsed) && parsed >= 1_024 && parsed <= 100_000_000 ? parsed : undefined;
    }
  }
  return undefined;
}

/**
 * Extract a provider-reported context window across OpenAI, OpenRouter,
 * Anthropic, Gemini, vLLM, LiteLLM, and custom gateway /models schemas.
 */
export function extractProviderContextWindow(item) {
  if (!item || typeof item !== 'object') return undefined;
  const candidates = [
    item.context_window,
    item.max_context_window,
    item.max_input_tokens,
    item.context_length,
    item.top_provider?.context_length,
    item.max_context_length,
    item.max_context_tokens,
    item.max_model_len,
    item.input_token_limit,
    item.inputTokenLimit,
    item.contextWindow,
    item.maxContextWindow,
    item.contextLength,
    item.maxInputTokens,
    item.limits?.context,
    item.limits?.max_context_window,
    item.limits?.max_context_window_tokens,
    item.limits?.max_prompt_tokens,
    item.limits?.input_tokens,
    item.capabilities?.limits?.max_context_window_tokens,
    item.capabilities?.context_window,
    item.capabilities?.context_length,
    item.architecture?.context_length,
    item.model_info?.context_length,
  ];
  for (const raw of candidates) {
    const parsed = parseReportedCapacity(raw);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Extract supported reasoning effort strings from standard or Codex-manifest
 * /models entries (e.g. `supported_reasoning_levels: [{ effort: "high" }]`).
 * Returns `undefined` when absent or empty so built-in family defaults apply.
 */
export function extractProviderEfforts(item) {
  if (!item || typeof item !== 'object') return undefined;
  const raw =
    item.supported_reasoning_efforts ??
    item.supported_efforts ??
    item.supported_reasoning_levels ??
    item.reasoning_efforts ??
    item.reasoning?.efforts ??
    item.reasoning_effort?.values ??
    item.capabilities?.supported_reasoning_efforts ??
    item.capabilities?.reasoning_efforts;
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map(entry => (typeof entry === 'string'
      ? entry.trim().toLowerCase()
      : typeof entry?.effort === 'string'
        ? entry.effort.trim().toLowerCase()
        : ''))
    .filter(Boolean);
  return values.length ? values : undefined;
}
