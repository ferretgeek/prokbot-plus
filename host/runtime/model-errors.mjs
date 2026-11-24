import { ModelRequestError } from './model-session.mjs';

const CONFIG_CODES = new Set(['invalid_api_key', 'authentication_error']);
const TERMINAL_CODES = new Set([
  'invalid_request_error', 'model_not_found', 'permission_denied', 'insufficient_quota',
  'content_filter', 'repeated_user_delivery',
]);
const TERMINAL_STATUSES = new Set([400, 402, 403, 404, 405, 413, 415, 422]);
const RATE_LIMIT_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded']);

/** Bridge local provider failures to the exact error constructors used by this Runner. */
export function createHarnessModelErrorMapper(library) {
  const { ConnectError, Code, ActionRequiredError, NonRetriableError, InputTokenLimitError } = library;
  const OutputTokensLimitExceededError =
    library.OutputTokensLimitExceededError ??
    library.getEngineRecoveryBindings?.()?.OutputTokensLimitExceededError;
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
    const inputLimit = ['context_length_exceeded', 'input_token_limit_exceeded', 'prompt_too_long'].includes(code) ||
      ([400, 413, 422].includes(status) && /(?:maximum context length|input token limit|prompt (?:is )?too long|context window.*exceed)/i.test(error.message));
    if (inputLimit && typeof InputTokenLimitError === 'function') {
      const mapped = new InputTokenLimitError(error.message); mapped.cause = error; return mapped;
    }
    // Map output-token truncation to the Harness OutputTokensLimitExceededError so
    // runWithMaxTokensRetry can inject its break-work-into-smaller-pieces reminder and continue.
    if (code === 'length') {
      if (typeof OutputTokensLimitExceededError === 'function') {
        const mapped = new OutputTokensLimitExceededError(error.message); mapped.cause = error; return mapped;
      }
      return new NonRetriableError(error.message, options);
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
