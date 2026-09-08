// tests/userContext.test.ts
// Pure proof for the user-context loader's ROBUSTNESS CONTRACT. Run:
//   ts-node tests/userContext.test.ts   (exit 0 = pass)
//
// The load-bearing guarantee: a CORE-row READ FAILURE THROWS
// UserContextUnavailableError — it is NEVER swallowed into an all-false
// ("unverified / not-onboarded / free") identity. That silent fallback was the
// footgun: a transient DB blip would strand an onboarded user in onboarding and
// hide their premium/verified state. A read that SUCCEEDS with no row is a
// definite "no such user" (empty/false, no throw); the subscription read is
// best-effort (degrades to free); and one transient blip is absorbed by a retry.

import {
  loadUserContext,
  projectUserContextRow,
  pickSubscriptionStatus,
  UserContextUnavailableError,
  type QueryFn,
} from '../utils/userContext';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

// A users row as mysql2 would hand it back (1/0 for TINYINT booleans).
const USER_ROW = { email: 'a@b.co', email_verified: 1, intake_completed: 0, initial_intake_completed: 1 };

// Build a QueryFn from a router keyed on which table the SQL hits.
function makeQuery(handlers: {
  user?: () => any;                    // SELECT ... FROM users
  userSubs?: () => any;                // SELECT tier FROM user_subscriptions
  subs?: () => any;                    // SELECT tier FROM subscriptions
}): QueryFn {
  return async (sql: string) => {
    if (/FROM users\b/.test(sql)) return (handlers.user ?? (() => [[USER_ROW]]))();
    if (/FROM user_subscriptions\b/.test(sql)) return (handlers.userSubs ?? (() => [[]]))();
    if (/FROM subscriptions\b/.test(sql)) return (handlers.subs ?? (() => [[]]))();
    return [[]];
  };
}

(async () => {
  // --- pure helpers ---------------------------------------------------------
  ok(pickSubscriptionStatus('premium') === 'premium', 'tier premium → premium');
  ok(pickSubscriptionStatus('enterprise') === 'enterprise', 'tier enterprise → enterprise');
  ok(pickSubscriptionStatus('active') === 'free', 'tier active (a status, not a tier) → free');
  ok(pickSubscriptionStatus(undefined) === 'free', 'no tier → free');
  ok(pickSubscriptionStatus(null) === 'free', 'null tier → free');

  const projected = projectUserContextRow(USER_ROW, 'free');
  ok(projected.email === 'a@b.co', 'projection maps email');
  ok(projected.emailVerified === true, 'projection coerces email_verified 1 → true');
  ok(projected.intakeCompleted === false, 'projection coerces intake_completed 0 → false');
  ok(projected.initialIntakeCompleted === true, 'projection coerces initial_intake_completed 1 → true');
  // A missing row is a definite "no such user" — empty/false, NEVER a throw.
  const empty = projectUserContextRow(undefined, 'free');
  ok(empty.email === '' && !empty.emailVerified && !empty.intakeCompleted && !empty.initialIntakeCompleted,
    'projection of a missing row → empty/false (definite no-user, not a lie)');

  // --- happy path -----------------------------------------------------------
  {
    const ctx = await loadUserContext(131, makeQuery({}), { delayMs: 0 });
    ok(ctx.email === 'a@b.co' && ctx.emailVerified && !ctx.intakeCompleted && ctx.initialIntakeCompleted,
      'loadUserContext returns the real flags on success');
    ok(ctx.subscriptionStatus === 'free', 'no active subscription → free');
  }

  // --- subscription precedence + best-effort --------------------------------
  {
    const ctx = await loadUserContext(1, makeQuery({ userSubs: () => [[{ tier: 'premium' }]] }), { delayMs: 0 });
    ok(ctx.subscriptionStatus === 'premium', 'user_subscriptions premium is honored');
  }
  {
    // user_subscriptions THROWS (table missing) → must degrade, try `subscriptions`.
    const ctx = await loadUserContext(1, makeQuery({
      userSubs: () => { throw new Error('no such table user_subscriptions'); },
      subs: () => [[{ tier: 'enterprise' }]],
    }), { delayMs: 0 });
    ok(ctx.subscriptionStatus === 'enterprise', 'subscription read is best-effort: falls back to legacy table');
  }
  {
    // BOTH subscription reads throw → core still returned, tier degrades to free.
    const ctx = await loadUserContext(1, makeQuery({
      userSubs: () => { throw new Error('boom'); },
      subs: () => { throw new Error('boom'); },
    }), { delayMs: 0 });
    ok(ctx.subscriptionStatus === 'free' && ctx.email === 'a@b.co',
      'both subscription reads failing degrades to free WITHOUT failing the whole load');
  }

  // --- THE HARDENING: a core-read failure THROWS, never all-false -----------
  {
    let threw: unknown = null;
    try {
      await loadUserContext(131, makeQuery({ user: () => { throw new Error('ECONNRESET'); } }), { retries: 0, delayMs: 0 });
    } catch (e) { threw = e; }
    ok(threw instanceof UserContextUnavailableError,
      'core-read failure THROWS UserContextUnavailableError (never fabricates all-false)');
  }

  // --- transient resilience: one blip then success is absorbed by the retry --
  {
    let calls = 0;
    const flaky: QueryFn = async (sql: string) => {
      if (/FROM users\b/.test(sql)) {
        calls++;
        if (calls === 1) throw new Error('transient pool hiccup');
        return [[USER_ROW]];
      }
      return [[]];
    };
    const ctx = await loadUserContext(131, flaky, { retries: 1, delayMs: 0 });
    ok(calls === 2 && ctx.initialIntakeCompleted === true,
      'a single transient core-read blip is retried and recovers (no spurious 503)');
  }

  // --- a sustained outage (throws past the retry budget) still fails loud ----
  {
    let threw: unknown = null;
    try {
      await loadUserContext(131, makeQuery({ user: () => { throw new Error('DB down'); } }), { retries: 1, delayMs: 0 });
    } catch (e) { threw = e; }
    ok(threw instanceof UserContextUnavailableError,
      'sustained core-read failure (beyond retries) still throws — never all-false');
  }

  if (fail) { console.error(`\nuserContext: ${pass} passed, ${fail} FAILED`); process.exit(1); }
  console.log(`userContext: ${pass} passed`);
})();
