// ============================================================================
// UNIT TESTS — intake IDOR guard decision logic (pure; no DB, no env, no HTTP)
// ============================================================================
// Run:  npx ts-node tests/intakeAuthGuards.test.ts
// Exit code 0 = all passed, 1 = at least one failed.
//
// Tests the PURE predicates behind the intake IDOR fix (docs/entry-core-intake
// -spec.md §2). The Express guards in authMiddleware.ts are thin wrappers that
// map these verdicts to 401/403 + a security log; the decision RULES live in
// utils/selfAssertion and are proven here in isolation.
//
// Proves:
//   paramMatchesSelf
//     1. equal ids (number/number, number/string) -> true
//     2. different ids -> false
//     3. missing/undefined/null/NaN self or claimed -> false (fail closed)
//   bodyIdVerdict
//     4. no auth (undefined/null/NaN self) -> 'unauth'
//     5. auth + absent body id -> 'allow' (handler uses req.user.id)
//     6. auth + matching body id (number or string) -> 'allow'
//     7. auth + mismatched body id -> 'reject'
// ============================================================================

import { paramMatchesSelf, bodyIdVerdict } from '../utils/selfAssertion';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}`); }
}
function group(name: string): void { console.log(`\n• ${name}`); }

// ---------------------------------------------------------------------------
group('paramMatchesSelf — self-only access on :userId');
ok(paramMatchesSelf(48, 48) === true, 'equal numbers -> true');                    // 1
ok(paramMatchesSelf(48, '48') === true, 'number self vs string claimed -> true');  // 1
ok(paramMatchesSelf(48, 49) === false, 'different ids -> false');                  // 2
ok(paramMatchesSelf(48, '49') === false, 'different ids (string) -> false');       // 2
ok(paramMatchesSelf(undefined, 48) === false, 'no self -> false (fail closed)');   // 3
ok(paramMatchesSelf(null, 48) === false, 'null self -> false');                    // 3
ok(paramMatchesSelf(48, undefined) === false, 'no claimed -> false');              // 3
ok(paramMatchesSelf(48, 'abc') === false, 'non-numeric claimed -> false');         // 3
ok(paramMatchesSelf(NaN, NaN) === false, 'NaN/NaN -> false');                      // 3
ok(paramMatchesSelf(0, 0) === false, 'zero is NOT a valid user id -> false');      // 3
ok(paramMatchesSelf(-5, -5) === false, 'negative id -> false');                    // 3
ok(paramMatchesSelf('', '') === false, 'empty string (Number->0) -> false');       // 3
ok(paramMatchesSelf(48.5, 48.5) === false, 'non-integer id -> false');             // 3

// ---------------------------------------------------------------------------
// STRICT TYPING (fail-closed): only number|string may coerce to an id. Non-
// scalar / boolean inputs must be rejected outright, even when they would
// otherwise JS-coerce to a valid id (Number(['48'])===48, Number(true)===1).
// These cannot reach paramMatchesSelf via a path param (always a string), but
// bodyIdVerdict feeds JSON body values — which CAN be arrays/objects/booleans —
// through the same toUserId, so the rule is proven on both.
group('toUserId strict typing — non-scalars never become an id');
ok(paramMatchesSelf(48, [48]) === false, 'array claimed [48] -> false');
ok(paramMatchesSelf(48, ['48']) === false, "array claimed ['48'] -> false");
ok(paramMatchesSelf(48, {}) === false, 'object claimed -> false');
ok(paramMatchesSelf(1, true) === false, 'boolean claimed (Number(true)=1) -> false');
ok(bodyIdVerdict(48, [48]) === 'reject', 'array body id -> reject (even if coerces to self)');
ok(bodyIdVerdict(48, { id: 48 }) === 'reject', 'object body id -> reject');
ok(bodyIdVerdict(1, true) === 'reject', 'boolean body id -> reject');

// ---------------------------------------------------------------------------
group('bodyIdVerdict — optional body userId');
ok(bodyIdVerdict(undefined, 48) === 'unauth', 'no self + present id -> unauth');    // 4
ok(bodyIdVerdict(null, 48) === 'unauth', 'null self -> unauth');                    // 4
ok(bodyIdVerdict(NaN, 48) === 'unauth', 'NaN self -> unauth');                      // 4
ok(bodyIdVerdict(48, undefined) === 'allow', 'auth + absent id -> allow');          // 5
ok(bodyIdVerdict(48, null) === 'allow', 'auth + null id -> allow');                 // 5
ok(bodyIdVerdict(48, 48) === 'allow', 'auth + matching number -> allow');           // 6
ok(bodyIdVerdict(48, '48') === 'allow', 'auth + matching string -> allow');         // 6
ok(bodyIdVerdict(48, 49) === 'reject', 'auth + mismatched id -> reject');           // 7
ok(bodyIdVerdict(48, '49') === 'reject', 'auth + mismatched string -> reject');     // 7

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? '✓' : '✗'} intakeAuthGuards: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
