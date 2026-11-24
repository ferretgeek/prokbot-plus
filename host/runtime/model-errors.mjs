import { ModelRequestError } from './model-session.mjs';

const CONFIG_CODES = new Set(['invalid_api_key', 'authentication_error']);
const TERMINAL_CODES = new Set([
  'invalid_request_error', 'model_not_found', 'permission_denied', 'insufficient_quota',
  'content_filter', 'length', 'repeated_user_delivery',
]);
const TERMINAL_STATUSES = new Set([400, 402, 403, 404, 405, 413, 415, 422]);
const RATE_LIMIT_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded']);

const OUTPUT_TOKEN_LIMIT_SUBJECT_RE = /\b(?:max_(?:output_|completion_)?tokens|output\s+tokens?|completion\s+tokens?)\b/i;
const RATE_LIMIT_OR_THROUGHPUT_RE = /(?:\b(?:tokens?\s+per\s+(?:minute|second|hour|day)|requests?\s+per\s+(?:minute|second|hour|day)|rate[\s_-]?limit|tpm|rpm|tpd)\b|每分钟|速率限制|限流)/i;
const RATE_LIMIT_PRIMARY_RE = /^(?:\s*(?:rate[\s_-]?limit|tpm|rpm|tpd|速率限制|限流)\b)|(?:rate[\s_-]?limit|tokens?\s+per\s+(?:minute|second|hour|day)|requests?\s+per\s+(?:minute|second|hour|day)|tpm|rpm|tpd)\s*(?:exceeded|reached|hit|limit)|exceed(?:s|ed)?\s+(?:the\s+)?(?:maximum\s+)?(?:tokens?\s+per\s+(?:minute|second|hour|day)|requests?\s+per\s+(?:minute|second|hour|day)|rate[\s_-]?limit|tpm|rpm|tpd)\b/i;
const COMPARISON_CONTEXT_RE = /(?:\d{1,3}(?:,\d{3})+|\d+)\s*(?:\+\s*(?:\d{1,3}(?:,\d{3})+|\d+)\s*)?>\s*(?:\d{1,3}(?:,\d{3})+|\d{4,9})\b/;
const EXPLICIT_INPUT_CEILING_RE = /(?:maximum context length|max_model_len|prompt\s+(?:is\s+)?too\s+long)/i;

function isOutputTokenLimitOnly(text) {
  if (!OUTPUT_TOKEN_LIMIT_SUBJECT_RE.test(text)) return false;
  if (COMPARISON_CONTEXT_RE.test(text) || EXPLICIT_INPUT_CEILING_RE.test(text)) return false;
  // Reject "context window limit of 8192 output tokens exceeded ... (prompt 120000 tokens)"
  if (/\b\d[\d,]*\s*(?:output|completion)\s+tokens?\b/i.test(text)) return true;
  return !/(?:\b(?:input|prompt|context)\b|最大上下文|上下文)/i.test(text);
}

const INPUT_TOKEN_LIMIT_MESSAGE_RE = new RegExp([
  'maximum context length',
  'max_model_len',
  'input token limit',
  'prompt (?:is )?too long',
  'context (?:window|limit|length).*exceed',
  'context\\s+(?:window|length)\\s+limit',
  "exceed(?:s|ed)?\\s+(?:the\\s+)?(?:model'?s?\\s+)?context\\s+(?:window|limit|length)",
  "exceed(?:s|ed)?\\s+(?:the\\s+)?(?:maximum|model'?s?)\\s+context",
  "(?:input|prompt|context)[^\\n]*exceed(?:s|ed)?\\s+(?:the\\s+)?(?:maximum|model'?s?)\\s+(?:number\\s+of\\s+)?tokens(?!\\s+per\\s+(?:minute|second|hour|day))",
  '最大上下文',
  '上下文(?:长度|窗口)?上限',
].join('|'), 'i');

function isRateLimitOnly(text, { status, code } = {}) {
  if (status === 429 || RATE_LIMIT_CODES.has(code)) return true;
  if (!RATE_LIMIT_OR_THROUGHPUT_RE.test(text)) return false;
  if (RATE_LIMIT_PRIMARY_RE.test(text)) return true;
  if (COMPARISON_CONTEXT_RE.test(text) || EXPLICIT_INPUT_CEILING_RE.test(text)) return false;
  return !INPUT_TOKEN_LIMIT_MESSAGE_RE.test(text);
}

const CONTEXT_LIMIT_PATTERNS = [
  // Comparison forms ("... > <limit>") take precedence so a sent token count is never mistaken for the ceiling.
  {
    re: /prompt\s+(?:is\s+)?too\s+long:\s*(?:\d{1,3}(?:,\d{3})+|\d+)\s*tokens?\s*>\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\s*maximum(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: true,
  },
  {
    re: /exceed(?:s|ed)?\s+(?:the\s+)?(?:model'?s?\s+)?context\s+(?:limit|window|length)[^>\n]*?(?:\d{1,3}(?:,\d{3})+|\d+)\s*\+\s*(\d{1,3}(?:,\d{3})+|\d+)\s*>\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: true,
    reserveGroup: 1,
    limitGroup: 2,
  },
  {
    re: /exceed(?:s|ed)?\s+(?:the\s+)?(?:model'?s?\s+)?context\s+(?:limit|window|length)[^>\n]*>\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: true,
  },
  // Explicit ceiling statements that cannot be confused with prompt length.
  {
    re: /(?:maximum context length|max_model_len)\s*(?:is|of|:|=|\()\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: false,
  },
  // Context window/limit with explicit ceiling wording ("is N", "of N", "= N", "limit (N)", "window: max N").
  {
    re: /\bcontext\s+(?:window(?:\s+limit)?|length\s+limit|limit)\s*(?:(?:is|of|=)\s*|(?::\s*|\(\s*)(?:max(?:imum)?|limit)\s*(?:is|of|:|=)?\s*)(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*tokens?\s*>)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: false,
  },
  {
    re: /\bcontext\s+(?:window\s+|length\s+)?limit\s*\(\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*tokens?\s*>)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: false,
  },
  {
    re: /(?<!exceed(?:s|ed)?\s+(?:the\s+)?(?:[\w'-]+\s+){0,2})\bcontext\s+(?:window(?:\s+limit)?|length\s+limit)\s*(?::\s*|\(\s*)(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*tokens?\s*>)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: false,
  },
  // Gemini-style input token limit messages (scoped to input/prompt/context so output limits are never parsed).
  {
    re: /\b(?:input|prompt|context)\b[^\n]*exceed(?:s|ed)?\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed\s*(?:\(|:\s*)\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)(?!\s*(?:output|completion)\s+tokens?\b)/i,
    isComparison: false,
  },
  {
    re: /(?:最大上下文(?:长度)?|上下文(?:长度|窗口)?上限)\s*(?:为|是|:|：)?\s*(\d{1,3}(?:,\d{3})+|\d{4,9})\b(?!,\d)/,
    isComparison: false,
  },
];

/** True when an upstream error indicates the input exceeded the model's context window. */
export function isInputTokenLimitError(error) {
  const status = error?.status;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message = String(error?.message ?? '');
  if (['context_length_exceeded', 'input_token_limit_exceeded', 'prompt_too_long'].includes(code)) {
    return true;
  }
  if (![400, 413, 422].includes(status) || isRateLimitOnly(message, { status, code }) || isOutputTokenLimitOnly(message)) {
    return false;
  }
  return INPUT_TOKEN_LIMIT_MESSAGE_RE.test(message);
}

/**
 * Extract the provider-reported context token ceiling, optional output reserve (`a + b > c`),
 * and whether the message used an unambiguous comparison expression.
 */
export function parseContextLimitDetailsFromError(message) {
  const text = String(message ?? '');
  if (!text || isRateLimitOnly(text) || isOutputTokenLimitOnly(text)) return undefined;
  for (const entry of CONTEXT_LIMIT_PATTERNS) {
    const match = entry.re.exec(text);
    if (!match) continue;
    const rawLimit = match[entry.limitGroup ?? 1];
    const digits = rawLimit.replace(/,/g, '');
    if (!/^\d{4,9}$/.test(digits)) continue;
    const limit = Number(digits);
    if (!Number.isSafeInteger(limit) || limit < 1_024 || limit > 100_000_000) continue;
    let reserve = 0;
    if (entry.reserveGroup && match[entry.reserveGroup]) {
      const reserveNum = Number(match[entry.reserveGroup].replace(/,/g, ''));
      if (Number.isSafeInteger(reserveNum) && reserveNum >= 1 && reserveNum < limit) {
        reserve = reserveNum;
      }
    }
    return { limit, reserve, isComparison: entry.isComparison };
  }
  return undefined;
}

/** Extract the provider-reported context token ceiling from an overflow error message, if present. */
export function parseContextLimitFromError(message) {
  return parseContextLimitDetailsFromError(message)?.limit;
}

/** Bridge local provider failures to the exact error constructors used by this Runner. */
export function createHarnessModelErrorMapper(library) {
  const { ConnectError, Code, ActionRequiredError, NonRetriableError, InputTokenLimitError } = library;
  if (![ConnectError, ActionRequiredError, NonRetriableError].every(value => typeof value === 'function')
      || ![Code?.ResourceExhausted, Code?.Unavailable, Code?.Internal].every(Number.isInteger)) {
    throw new TypeError('The original Harness error constructors must be exported by the loaded library');
  }
  return error => {
    // Preserve cancellation/deadline identities, network causes, and original Harness errors.
    if (!(error instanceof ModelRequestError)) return error;
    const status = error.status;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const options = { cause: error, displayInfo: { detail: error.message, isRetryable: false } };
    // Quota exhaustion is permanent until the account changes. Unlike a transient
    // 429, sending the same request again only creates a restart/retry storm.
    const quotaExhausted = code === 'API_KEY_QUOTA_EXHAUSTED' || code === 'insufficient_quota' ||
      (status === 402 && !code) ||
      /(?:api[ _-]?key|account)\s+(?:quota|credit|balance)\s+(?:is\s+)?(?:exhausted|used up|depleted|exceeded)|(?:账户|账户余额|API\s*额度|额度)\s*(?:已)?\s*(?:用完|耗尽|不足)/i.test(error.message);
    if (isInputTokenLimitError(error) && typeof InputTokenLimitError === 'function') {
      const mapped = new InputTokenLimitError(error.message);
      mapped.cause = error;
      const observedLimit = parseContextLimitFromError(error.message);
      if (observedLimit) mapped.observedContextLimit = observedLimit;
      return mapped;
    }
    if (status === 401 || CONFIG_CODES.has(code)) {
      // This is a local provider API key, so official-account login is not the remedy.
      return new ActionRequiredError(error.message, 'config', options);
    }
    if (quotaExhausted || TERMINAL_STATUSES.has(status) || TERMINAL_CODES.has(code)) {
      return new NonRetriableError(error.message, options);
    }
    const rateLimited = status === 429 || RATE_LIMIT_CODES.has(code);
    const unavailable = status === 503 || status === 529 || code === 'overloaded_error';
    if (rateLimited || unavailable || (status >= 500 && status <= 599 && error.retryAfterMs !== undefined)) {
      const metadata = new Headers();
      if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0) {
        metadata.set('retry-after', String(error.retryAfterMs / 1000));
      }
      return new ConnectError(error.message, rateLimited ? Code.ResourceExhausted
        : unavailable ? Code.Unavailable : Code.Internal,
        metadata, undefined, error);
    }
    return error;
  };
}
