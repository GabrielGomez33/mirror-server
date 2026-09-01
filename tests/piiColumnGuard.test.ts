// tests/piiColumnGuard.test.ts
// Pure proof for the PII column-name guard. Run: ts-node tests/piiColumnGuard.test.ts
//
// This pins the definition of "a PII-shaped column" that the compliance record
// and the conversion_events schema-guard both rely on. The conversion_events
// columns MUST all read as clean; obvious identity/contact/location columns MUST
// flag; and known-safe funnel columns (session_token, utm_*) MUST NOT false-flag.

import { isPiiColumnName, findPiiColumns, tokenizeColumnName } from '../utils/piiColumnGuard';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

// --- the actual conversion_events columns must ALL be clean ------------------
const CONVERSION_COLUMNS = ['id', 'stage', 'session_token', 'utm_source', 'utm_medium', 'utm_campaign', 'surface', 'created_at'];
ok(findPiiColumns(CONVERSION_COLUMNS).length === 0, 'conversion_events columns are all non-PII');

// --- must NOT false-flag the known-safe funnel columns individually ----------
ok(!isPiiColumnName('session_token'), 'session_token is not PII (contains "token"/"session", neither is a PII term)');
ok(!isPiiColumnName('utm_source'), 'utm_source is not PII');
ok(!isPiiColumnName('utm_campaign'), 'utm_campaign is not PII');
ok(!isPiiColumnName('surface'), 'surface is not PII');
ok(!isPiiColumnName('stage'), 'stage is not PII');
ok(!isPiiColumnName('created_at'), 'created_at is not PII');
ok(!isPiiColumnName('recipient_count'), 'substring "ip" inside recipient must NOT flag (token-boundary)');

// --- must flag obvious PII ---------------------------------------------------
ok(isPiiColumnName('email'), 'email flagged');
ok(isPiiColumnName('user_id'), 'user_id flagged (user token)');
ok(isPiiColumnName('userId'), 'userId flagged (camelCase)');
ok(isPiiColumnName('ip_address'), 'ip_address flagged');
ok(isPiiColumnName('ip_truncated'), 'ip_truncated flagged (ip token)');
ok(isPiiColumnName('user_agent'), 'user_agent flagged (user token)');
ok(isPiiColumnName('display_name'), 'display_name flagged (name token)');
ok(isPiiColumnName('birth_date'), 'birth_date flagged (birth substring)');
ok(isPiiColumnName('password_hash'), 'password_hash flagged');
ok(isPiiColumnName('latitude'), 'latitude flagged');
ok(isPiiColumnName('phone_number'), 'phone_number flagged');

// --- tokenization sanity -----------------------------------------------------
ok(tokenizeColumnName('utm_source').join(',') === 'utm,source', 'snake_case tokenized');
ok(tokenizeColumnName('ipAddress').join(',') === 'ip,address', 'camelCase tokenized');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: piiColumnGuard ${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} assertions failed`);
