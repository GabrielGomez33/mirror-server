// ============================================================================
// retryClassifier — decide whether a thrown error is worth retrying.
// ============================================================================
// Extracted from DINALLMConnector so the retry/fail-fast decision is provable in
// isolation. Getting this wrong is a real hazard: retrying a 4xx client error
// wastes time and can amplify load, while NOT retrying a transient 5xx/timeout
// turns a blip into a user-visible outage.
//
// Policy: network/timeout/5xx/429/connection errors are transient (retry);
// explicit 4xx client errors are terminal (do not retry). Unknown shapes default
// to retryable — fail-OPEN on classification so a transient error with an
// unrecognised message is not permanently swallowed. Pure: no state, no I/O.
// ============================================================================

export function isRetryableError(error: unknown): boolean {
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  const message = (err && typeof err.message === 'string' ? err.message : '').toLowerCase();

  // Browser/undici fetch failures surface as TypeError('... fetch ...').
  if (err && err.name === 'TypeError' && message.includes('fetch')) return true;
  if (message.includes('timeout') || message.includes('aborted')) return true;
  // Word-boundary match on HTTP status codes, not arbitrary digit sequences.
  if (/\b5\d{2}\b/.test(message)) return true;                          // 5xx server error
  if (message.includes('429') || message.includes('rate limit')) return true;
  if (message.includes('econnrefused') || message.includes('enotfound')) return true;
  if (/\b4\d{2}\b/.test(message)) return false;                         // explicit 4xx client error
  return true;                                                         // unknown -> fail-open (retry)
}
