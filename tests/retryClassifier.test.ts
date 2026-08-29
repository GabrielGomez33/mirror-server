// ============================================================================
// UNIT TESTS — DINA retry/fail-fast classifier (pure; no I/O)
// ============================================================================
// Run:  npx ts-node tests/retryClassifier.test.ts
// Exit 0 = all passed, 1 = at least one failed.
//
// Getting this wrong is a real resilience hazard: retry a 4xx and you amplify a
// client error; don't retry a transient 5xx/timeout and a blip becomes an outage.
// Proves 5xx/timeout/conn/429 -> retry, explicit 4xx -> terminal, the 429-before-
// 4xx ordering, word-boundary status matching (not arbitrary digits), and safe
// handling of malformed error objects.
// ============================================================================

import { isRetryableError } from '../utils/retryClassifier';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }
const E = (message: string, name?: string) => ({ message, ...(name ? { name } : {}) });

// ---------------------------------------------------------------------------
group('transient errors -> RETRY');
ok(isRetryableError(E('Request failed with status 500')) === true, '500 -> retry');
ok(isRetryableError(E('502 Bad Gateway')) === true, '502 -> retry');
ok(isRetryableError(E('upstream returned 503')) === true, '503 -> retry');
ok(isRetryableError(E('socket timeout')) === true, 'timeout -> retry');
ok(isRetryableError(E('The operation was aborted')) === true, 'aborted -> retry');
ok(isRetryableError(E('connect ECONNREFUSED 127.0.0.1:9445')) === true, 'ECONNREFUSED -> retry');
ok(isRetryableError(E('getaddrinfo ENOTFOUND dina.local')) === true, 'ENOTFOUND -> retry');
ok(isRetryableError(E('Failed to fetch', 'TypeError')) === true, 'TypeError fetch -> retry');

// ---------------------------------------------------------------------------
group('explicit 4xx client errors -> TERMINAL (no retry)');
ok(isRetryableError(E('Request failed with status 400')) === false, '400 -> no retry');
ok(isRetryableError(E('401 Unauthorized')) === false, '401 -> no retry');
ok(isRetryableError(E('404 Not Found')) === false, '404 -> no retry');
ok(isRetryableError(E('422 Unprocessable Entity')) === false, '422 -> no retry');

// ---------------------------------------------------------------------------
group('429 / rate limit is retryable even though it is 4xx-shaped (ordering)');
ok(isRetryableError(E('429 Too Many Requests')) === true, '429 -> retry (checked before generic 4xx)');
ok(isRetryableError(E('rate limit exceeded')) === true, 'rate limit text -> retry');

// ---------------------------------------------------------------------------
group('word-boundary safety — arbitrary digits are NOT status codes');
ok(isRetryableError(E('processed order 12400 items')) === true, '12400 is not a 4xx -> fail-open retry');
ok(isRetryableError(E('batch 5000 done but failed')) === true, '5000 is not a 5xx -> fail-open retry');
ok(isRetryableError(E('id 400500 unknown failure')) === true, 'embedded digits -> fail-open retry');

// ---------------------------------------------------------------------------
group('unknown / malformed errors -> fail-OPEN (retry), never throw');
ok(isRetryableError(E('something weird happened')) === true, 'unknown message -> retry');
ok(isRetryableError(null) === true, 'null error -> retry (no throw)');
ok(isRetryableError(undefined) === true, 'undefined error -> retry (no throw)');
ok(isRetryableError({}) === true, 'error with no message -> retry');
ok(isRetryableError({ message: 42 }) === true, 'non-string message -> retry (no throw)');
ok(isRetryableError('a plain string 503') === true, 'non-object with no .message -> fail-open retry');

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} retryClassifier: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
