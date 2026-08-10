# Student Access (Goal #1, L1) — mirror-server

Free Mirror **Premium** for verified college students, implemented as a
**time-boxed complimentary ("comp") subscription** gated behind a layered
`.edu` verification. This folder is the **decision record + proof pack +
copy-paste manifest**. The actual complete, updated source files live at their
real paths on this branch (listed in the manifest below) — they are already
typechecked and tested here.

> **Decision recap (agreed):** L1 — curated accredited-domain **allowlist** +
> **email round-trip** proof of control + **18+ attestation** +
> **plus-address/catch-all normalization** + **12-month re-verified grant**.
> A third-party enrollment vendor (SheerID/VerifyPass) is deliberately deferred;
> the verification step is isolated so it can be swapped in later without
> touching the grant logic.

---

## 1. Why this does not touch dina-server (separation of concerns)

Student status is an **entitlement** concern. Entitlement is resolved entirely
inside mirror-server's paywall via `subscription.service.getSubscriptionTier()`.
Dina's `src/modules/mirror` is analysis/truth-stream processing — it never asks
"is this user a student." Therefore **goal #1 requires zero dina-server
changes**, which is the correct low-blast-radius outcome, not an omission. The
only thing that could ever cross that boundary is a usage cap, and that is
enforced on the mirror-server side *before* any Dina call is made.

## 2. What was added / changed (copy-paste manifest)

**New files (drop in as-is):**

| Real path | Purpose |
|---|---|
| `services/studentDomainService.ts` | Pure eligibility: normalize + allowlist (dot-boundary) + age gate. No I/O. |
| `paywall/student.config.ts` | Env-tunable knobs + `addMonths`. Self-contained; does not touch `paywall.config.ts`. |
| `controllers/studentVerificationController.ts` | request / verify / status handlers; rate limits; race + dup-key handling. |
| `routes/studentRoutes.ts` | Route factory, mounted at `/mirror/api/student`. |
| `migrations/021_student_access.sql` | `accredited_domains`, `student_verifications`, `student_verification_tokens` + seed. Idempotent. |
| `tests/student/*.test.ts` | Executable proofs (see §8). |

**Modified files (complete updated files are on this branch at these paths):**

| Real path | Change |
|---|---|
| `paywall/services/subscription.service.ts` | Added `grantStudentComp`, `revokeStudentComp`, `checkAndExpireStudentComps`, `sendStudentCompExpiringNotifications`. Nothing existing altered. |
| `paywall/types/index.ts` | Added 3 comp event types to `SubscriptionEventType`. |
| `services/emailService.ts` | Added 4 templates (`student_verification`, `student_access_granted`, `student_access_expiring`, `student_access_expired`). |
| `index.ts` | Mounted `/mirror/api/student`; added comp expiry + re-verify notifications to the existing paywall cron blocks. |

**Frontend (in the Mirror repo, same branch):**
`client/src/services/studentAccessApi.ts`, `client/src/components/paywall/StudentAccessCard.tsx`,
`client/src/components/paywall/StudentVerifyPage.tsx`.

## 3. Data model

- **`accredited_domains`** — the allowlist (`status='active'`) **and** denylist
  (`status='blocked'`) in one curatable table. Matching is exact-domain +
  **dot-boundary** sub-domain (`g.harvard.edu` matches `harvard.edu`;
  `evilharvard.edu` does **not**).
- **`student_verifications`** — one row per user (`UNIQUE user_id`) **and** one
  claim per mailbox (`UNIQUE normalized_email`). The second constraint is the
  authoritative "one inbox → one seat" guard.
- **`student_verification_tokens`** — single-use, expiring campus-email tokens.
  Separate from `email_verification_tokens` because this verifies a campus
  address **decoupled from `users.email`** — verifying it must never flip
  `users.email_verified`.

## 4. Entitlement model (the comp)

A comp is stored on the **same `user_subscriptions` row** using
`provider='manual'` + the sentinel `provider_plan_id='student_comp'`,
`tier='premium'`, `status='active'`, `current_period_end=<grant expiry>`.

Invariants (see `grantStudentComp` and the integration test):
- **Never clobbers a live PayPal/Stripe subscription** — such users are already
  premium; the comp is skipped (`granted:false, reason:'active_provider_subscription'`).
- **No payment email** — reusing `activateSubscription` would email students a
  fake "$9.99 charged" receipt; a dedicated method avoids that.
- **Idempotent re-grant** — annual re-verification just moves the expiry forward.
- The sentinel is what lets the expiry cron and revoke find comps **without ever
  touching a paying subscriber's row.**

## 5. Verification flow

```
[Student]  POST /mirror/api/student/request  (auth)   { campusEmail, attest18 }
           │  normalize + allowlist + 18+  (studentDomainService, pure/tested)
           │  anti-abuse: claimed? cooldown? per-user cap? per-domain/day cap?
           │  issue single-use token -> email the CAMPUS address
           ▼
[Campus inbox]  clicks link -> /students/verify?token=…
           │
[Browser]  POST /mirror/api/student/verify  (NO auth — token is the credential) { token }
           │  validate token (format/expiry/used) ; race-check mailbox claim
           │  upsert student_verifications (no cross-row ON DUPLICATE hazard)
           │  grantStudentComp(userId=token.user_id, expiry=now+12mo)
           │  consume token ; audit ; email account owner
           ▼
[Cron, hourly]  checkAndExpireStudentComps  -> downgrade expired comps to free
[Cron, daily]   sendStudentCompExpiringNotifications (T-7d) -> re-verify nudge
```

## 6. Security analysis → mitigation → evidence

| Threat | Mitigation | Evidence |
|---|---|---|
| `.edu` look-alike (`evilharvard.edu`, `harvard.edu.co`) | Exact allowlist + dot-boundary match | `studentDomainService.test.ts` (dot-boundary + TLD cases) |
| One inbox → many seats (`me+1@`, `me+2@`) | Canonicalize (strip `+tag`, lowercase) **before** uniqueness; `UNIQUE(normalized_email)` | domain test (plus-tag collapse) + DB UNIQUE |
| Catch-all / bulk from one school | Per-domain/day cap + inbox click still required | controller `DOMAIN_RATE_LIMITED` |
| Minors on `.edu`/K-12 | Hard 18+ attestation (strict boolean) + K-12 simply not allowlisted (+ denylist) | domain test (age gate) |
| Token brute force / replay | 256-bit single-use token, format-validated, expiry, per-IP rate limit on `/verify` | controller + `studentRoutes.ts` |
| Privilege escalation to another account | `/verify` trusts **only** `token.user_id`, never client input | controller `verifyToken` |
| Clobbering a paying user | `grantStudentComp` skips live provider subs | integration test #3 |
| SQL injection | 100% bound parameters; zero string interpolation into SQL | code review + tsc |
| Enumeration | Neutral "already linked" message; no account identity leaked | controller (documented accepted minor signal) |
| Grant outliving enrollment | 12-month time-box + hourly expiry cron + re-verify email | integration test #4 |

## 7. Configuration (env — all optional, safe defaults)

See `.payenv.student.example`. Master switch `STUDENT_ACCESS_ENABLED=true`.
Default mode is `allowlist` (recommended). Curate `accredited_domains` from an
accredited-institution source (e.g. the US DoE database) — the seed in the
migration is a **starter set, not exhaustive**.

## 8. Proofs — how to reproduce (results observed here)

```bash
# Type safety (whole project, strict mode):
npm ci && npx tsc --noEmit            # => exit 0, 0 errors

# Pure security logic (48 assertions):
npx ts-node tests/student/studentDomainService.test.ts   # => ✓ PASS 48/0

# Config + date math (10 assertions):
npx ts-node tests/student/studentConfig.test.ts          # => ✓ PASS 10/0

# Stateful lifecycle (requires a throwaway DB user):
RUN_STUDENT_DB_TESTS=true TEST_USER_ID=<id> \
  npx ts-node tests/student/studentAccess.integration.test.ts
```

## 9. Install / deploy order

1. `npm run migrate` (applies `021_student_access.sql` — idempotent, additive).
2. Curate `accredited_domains` (seed is a starter set).
3. Set env from `.payenv.student.example` (or accept defaults).
4. Deploy mirror-server (`npm run build` then reload).
5. Deploy the Mirror frontend files + add the route
   `<Route path="/students/verify" element={<StudentVerifyPage/>} />` and drop
   `<StudentAccessCard/>` into the upgrade/account area.

## 10. Rollback

Additive and reversible. To disable instantly without a deploy:
`STUDENT_ACCESS_DISABLED` → set `STUDENT_ACCESS_ENABLED=false` (endpoints return
403; existing comps continue until expiry). Full rollback: revert the modified
files (complete versions on this branch) and, if desired, drop the three new
tables. No existing table is altered, so paying users are never affected.
