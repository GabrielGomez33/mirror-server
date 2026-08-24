# Entry & Core Intake — Architecture Specification

**Status:** Approved for build · **Branch:** `claude/conversion-rate-analysis-s5vnlh`
**Scope:** `mirror-server` (backend, data, security) + `Mirror/client` (frontend)
**Goal:** Convert cold traffic into retained clients by replacing the single 25–40 min
intake wall with a **two-tier intake**: a ~4-minute **Entry Intake** that makes the app
genuinely functional on day one, and the existing deep **Core Intake** re-shaped into
resumable, per-step, in-app enrichment.

---

## 1. Principle

Every ask must be proportional to the trust earned so far. The current app demands
maximum data (face, voice, 107 questions) at minimum trust (a cold click). The redesign
spreads each ask along the trust arc. **Value precedes ask, at every stage.**

Two pipelines that share **nothing but a read-model**:

| | Entry Intake ("initial") | Core Intake (existing "deep") |
|---|---|---|
| Purpose | Instant functional Mirror | Full-depth enrichment |
| Duration | ~4 min, one sitting | Resumable, come-back-later |
| Steps | name, birth data, mini-personality | visual, vocal, iq, astrology, personality |
| Completion flag | `users.initial_intake_completed` | `users.intake_completed` (derived) |
| Progress store | client-side (IndexedDB) draft | server-side `core_intake_progress` |
| Result store | **own table** `entry_intake_results` | existing tiered intake storage |

**Completion flags are fully decoupled.** `initial_intake_completed` and
`intake_completed` never read or write each other. Entry never writes a
`core_intake_progress` row. The mini-personality never marks the Core personality step
complete. This decoupling is the guarantee against intertwined logic.

---

## 2. Security mandate (non-negotiable)

### 2.1 Existing hole to fix in this change set (IDOR)

**Proof:**
- `index.ts:371` — `APP.use('/mirror/api/intake', intakeRoutes)` — mounted with **no**
  `verifyToken` and **no** `subscriptionGate` (contrast `/feedback`, `/subscription` →
  `verifyToken`; `/user`, `/journal`, `/groups`, `/truthstream`, `/personal-analysis` →
  `subscriptionGate`).
- `routes/intake.ts` — router adds no middleware of its own.
- `intakeController.ts:692` — target user taken from `req.body.userId`.
- `intakeController.ts:719` — `UPDATE users SET intake_completed = TRUE WHERE id = ?`
  with that body-supplied id.

**Impact:** unauthenticated `POST /mirror/api/intake/store {userId, intakeData}` can
overwrite and "complete" **any** user's intake. This is fixed as Phase 1, before any new
endpoint ships.

### 2.2 Rules for all new + fixed endpoints

1. Mount behind `AuthMiddleware.verifyToken`. The authenticated identity is
   `req.user.id` (set at `authMiddleware.ts:321`).
2. **Never trust a body/param `userId`.** Where a `:userId`/body id exists for
   backward compat, it is only *compared* to `req.user.id`; mismatch → `403` +
   `SecurityMonitor.logSecurityEvent(req.user.id, 'idor_attempt', …)`.
3. `:step` and all enumerable inputs validated against a server-side allowlist before
   any SQL. No free-form value reaches a query.
4. All SQL parameterized (existing house style, e.g. `intakeController.ts:719`).
5. No PII or secrets in logs. Draft state stores **no** media blobs.

A security hole in this feature is a build failure. Phase 6 includes an explicit authz
test pass and a `security-review` gate.

---

## 3. Data model

New migration `migrations/022_intake_progress.sql`. Follows the `021_student_access.sql`
house style: `InnoDB` / `utf8mb4_unicode_ci`, FK → `users(id) ON DELETE CASCADE`,
`UNIQUE` indexes as the real race/abuse guard, additive only (no DROP, no destructive
ALTER). Engine is **MySQL 8** (ledger collation `utf8mb4_0900_ai_ci`), so single-apply
is guaranteed by the runner's `schema_migrations` PK ledger rather than
`ADD COLUMN IF NOT EXISTS` (unsupported on MySQL 8).

```sql
-- (a) Entry-intake completion flag on users.
ALTER TABLE users
  ADD COLUMN initial_intake_completed TINYINT(1) NOT NULL DEFAULT 0;

-- (b) Entry-intake results — fully separate from Core storage (merged only on read).
CREATE TABLE IF NOT EXISTS entry_intake_results (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  user_id            INT NOT NULL,
  -- Frozen PersonalityResult shape (personalityResultAdapter.ts:13), JSON.
  personality_result JSON NULL,
  -- astrologicalResult from computeAstrology(birthData), JSON.
  astrology_result   JSON NULL,
  -- Non-identifying birth inputs kept for recompute/age-norms (no free-form PII beyond this).
  birth_date         DATE NULL,
  birth_time         TIME NULL,
  birth_place        VARCHAR(180) NULL,
  display_name       VARCHAR(120) NULL,
  -- 'preliminary' always, for Entry — signals reduced-N confidence downstream.
  confidence         ENUM('preliminary','full') NOT NULL DEFAULT 'preliminary',
  schema_version     SMALLINT NOT NULL DEFAULT 1,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_user (user_id),            -- one entry result per user; upsert key
  CONSTRAINT fk_entry_result_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (c) Per-step Core-intake progress — source of truth for derived intake_completed.
CREATE TABLE IF NOT EXISTS core_intake_progress (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  step_key      ENUM('visual','vocal','iq','astrology','personality') NOT NULL,
  status        ENUM('not_started','in_progress','completed') NOT NULL DEFAULT 'not_started',
  draft_state   JSON NULL,                    -- resumable NON-media draft only
  completed_at  TIMESTAMP NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_user_step (user_id, step_key),  -- upsert key + duplicate-row race guard
  INDEX idx_user_status (user_id, status),
  CONSTRAINT fk_core_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**Invariant — no duplicate progress rows:** completion is
`INSERT … ON DUPLICATE KEY UPDATE` against `UNIQUE(user_id, step_key)`. InnoDB enforces
uniqueness at the engine level, so concurrent completes for one `(user, step)` collapse
to a single idempotent update. (Same guarantee `021` relies on.)

**Derived `intake_completed`:** the unconditional write at `intakeController.ts:719` is
removed. `intake_completed` becomes TRUE ⟺ all 5 `core_intake_progress` rows are
`completed`, recomputed **inside the same transaction** that completes any step
(`SELECT … FOR UPDATE` over the user's rows). The `users.intake_completed` column is
retained and maintained so every existing reader (TruthStream gate
`truthstreamController.ts:184`, auth echoes, dashboard) is untouched — only the value is
now honest.

**Legacy bridge:** the monolithic `POST /intake/store` (still used by the existing
`SubmitStep`) upserts a `completed` progress row for each section present in the payload,
then recomputes `intake_completed`, all in one transaction. Old all-at-once flow and new
per-step flow converge on the same source of truth.

---

## 4. Migrations tooling (`npm run migrate <#>`)

`scripts/migrate.ts` already exposes `apply|up|status|baseline` and npm wraps them
(`migrate`, `migrate:status`, `migrate:pending`, `migrate:dev`). Enhancement: `apply`
accepts either a full filename **or** a numeric prefix and resolves it against
`migrations/<num>*.sql` (exactly one match required, else error). Usage:

```
npm run migrate 022          # resolves migrations/022_intake_progress.sql, applies once
npm run migrate:status       # ledger view
```

`migrate:dev` (ts-node) is the pre-build path. Idempotency is guaranteed by the
`schema_migrations` PK ledger; re-running `022` is a no-op.

---

## 5. Backend modules (separation of concerns)

```
routes/intakeEntry.ts             # NEW  — verifyToken-guarded Entry router
controllers/intakeEntryController.ts  # NEW  — Entry submit/status; writes entry_intake_results
routes/intake.ts                  # EDIT — add verifyToken + Core progress routes
controllers/intakeProgressController.ts # NEW — Core per-step progress + derivation
services/intakeReadModel.ts       # NEW  — resolveLatest(userId): merged read-view
services/intakeCompletion.ts      # NEW  — transactional derive+set of intake_completed
```

### 5.1 Endpoint contracts (all `verifyToken`; user = `req.user.id`)

**Entry** — `/mirror/api/intake/entry`
- `POST /submit` → body `{ personalityResult, astrologyResult, birthDate?, birthTime?, birthPlace?, displayName? }`.
  Upsert `entry_intake_results` (UNIQUE user_id), set `initial_intake_completed=1`,
  both in one transaction. **Idempotent** (re-submit overwrites; flag set is a no-op if
  already 1). Returns `{ completed:true, result }`.
- `GET /status` → `{ completed:boolean, result:EntryResult|null }`.

**Core progress** — `/mirror/api/intake`
- `GET /progress` → `{ steps:[{ step_key, status, completed_at }], intakeCompleted }`.
- `PUT /progress/:step` → body `{ draftState }`. Upsert `in_progress` + draft. (Server
  draft = cross-device resume.)
- `POST /progress/:step/complete` → mark `completed`, recompute `intake_completed`
  transactionally. Returns updated progress + `intakeCompleted`.

`:step` validated against `['visual','vocal','iq','astrology','personality']` before SQL.

### 5.2 Merged read-view (`intakeReadModel.resolveLatest`)

Single seam. Returns the existing `intakeData` shape so downstream extractors are
unchanged:

```
core   = IntakeDataManager.getLatestIntakeData(userId)?.intakeData ?? {}
entry  = SELECT * FROM entry_intake_results WHERE user_id = ?
merged = { ...entry-derived sections, ...core sections }   // CORE WINS per section
```

Per-section precedence (core preferred, entry fills the gap):
`personalityResult`, `astrologicalResult`, plus `birthDate` etc. Face/voice/IQ come only
from core. **Change sites:** `dashboard.ts:66` and the Dina personal-analysis worker's
intake fetch call `resolveLatest` instead of raw `getLatestIntakeData`. Everything
downstream (section extractors, mirror score, Dina prompt builder) is untouched because
the shape is identical.

---

## 6. Mini-personality scorer (reuse + honest degradation)

Decision: **reuse `IntegratedPersonalityScorer`, do not reinvent.** New file
`components/intake/entry/logic/entryScoring.ts`:

1. Curated subsets: `entryBig5Questions` (~8, ≥1 per Big-5 dimension) + `entryMbtiQuestions`
   (~4, one per MBTI axis), drawn from the existing banks so item semantics/keying are
   identical.
2. Build `DataQualityMetrics` from the mini answers via the existing
   `dataQualityMonitor` — with fewer items, `overallReliability` is naturally lower and
   `profileReliability` resolves to `adequate`/`questionable`.
3. `IntegratedPersonalityScorer.calculateComprehensiveResult(answers, entryBig5, entryMbti, quality)`
   → `PersonalityResultAdapter.adaptToExistingFormat()` → the **frozen** `PersonalityResult`.
4. Stamp `confidence:'preliminary'`; the Entry result table records the same.

This shows "truer data understanding with fewer data points" using the scorer's own
reliability machinery, and accounts for skew rather than hiding it.

**Proof obligation (Phase 3 test):** on a labeled fixture set, mini-scorer MBTI axis
assignment agrees with full-scorer above a documented threshold; `profileReliability` is
never `excellent`; adapter output always satisfies the frozen contract
(`big5Profile` 5 numeric 0–100, `mbtiType` matches `/^[EI][SN][TF][JP]$/`).

---

## 7. Frontend architecture

```
components/intake/entry/                      # NEW — self-contained Entry pipeline
  EntryIntakeFlow.tsx                         # mini-orchestrator (own step index; NOT the Core router)
  steps/ EntryWelcome.tsx EntryBirth.tsx EntryPersonalityMini.tsx EntryResult.tsx
  data/ entryQuestionBank.ts                  # curated mini items
  logic/ entryScoring.ts                      # §6
  logic/ entryDraft.ts                        # IndexedDB draft (one-sitting resume)
components/intake/shared/astrology/computeAstrology.ts  # EXTRACTED from AstroLogicalStep:278
components/dashboard/IntakeProgressCard.tsx   # NEW — the dropdown/accordion
components/dashboard/intakeStepCatalog.ts     # NEW — static content: title/description/benefit/time
services/intakeApi.ts                         # NEW — typed client for entry + progress endpoints
```

- **Routing:** logged-out `/` → value/register (not `/login`); post-signup →
  `/entry` (EntryIntakeFlow) → EntryResult → `/dashboard`. Core steps deep-linked from
  the dashboard card. (Router reconciliation + orphaned-step deletion tracked separately.)
- **Entry draft:** IndexedDB only (client, one sitting) — survives refresh, single device.
- **Progress card:** reads `GET /progress`; renders 5 steps with completed/not state,
  description + benefit from `intakeStepCatalog.ts` (content separated from logic), and a
  "Continue where you left off" CTA. Core drafts restore from server `draft_state`.

---

## 8. Failure modes, races, edge cases

| # | Scenario | Defense | Test |
|---|---|---|---|
| 1 | Concurrent step-complete | `UNIQUE(user,step)` + `ON DUPLICATE KEY UPDATE` | 50-way concurrent → 1 row |
| 2 | `intake_completed` flip race | recompute+set inside completing txn, `FOR UPDATE` | interleave 2 completers → flag=1 once |
| 3 | Entry submit retried | idempotent upsert (UNIQUE user_id); flag no-op | replay ×3 → one row |
| 4 | Body/param userId ≠ token | 403 + SecurityMonitor | user A cannot touch user B |
| 5 | Invalid `:step` | allowlist reject → 400 before SQL | fuzz param |
| 6 | Entry refresh mid-flow | IndexedDB draft restore | reload → answers restored |
| 7 | Mini vs full personality | Entry writes no core row; core-wins on read | §6 + read-model test |
| 8 | Partial legacy payload | per-section upsert + derive | personality-only → 1 row, flag=0 |
| 9 | Merge when only entry present | resolveLatest returns entry sections | dashboard renders real panel |
| 10 | Draft state bloat / media | schema forbids blobs; size-cap draft_state | reject oversized draft |

---

## 9. Non-goals (this change set)

Meta Pixel/analytics, bundle code-splitting, registration slimming, IndexedDB media
persistence for the Core media steps, and the landing/value page are **separate,
independently valuable** tracks. They are not required for the two-tier intake to be
correct and are sequenced after it. (Listed so scope stays honest.)

---

## 10. Phased rollout (each phase independently committable + tested)

1. **Security + schema foundation:** fix intake IDOR (auth mount + identity assertion);
   `022` migration; `npm run migrate <#>` numeric resolve. Tests: authz, migration apply.
2. **Core progress + derivation:** `core_intake_progress`, progress endpoints,
   `intakeCompletion` transactional derive, legacy-bridge in `/store`. Tests: rows 1/2/8.
3. **Entry backend + read-model:** `entry_intake_results`, Entry endpoints,
   `intakeReadModel.resolveLatest`, wire `dashboard.ts` + Dina worker. Tests: 3/4/9.
4. **Mini-scorer + Entry client flow:** astro extraction, `entryScoring`, EntryIntakeFlow
   + steps, IndexedDB draft. Tests: §6 fixtures, draft restore.
5. **Dashboard progress card + routing:** `IntakeProgressCard`, catalog, `intakeApi`,
   logged-out routing. Tests: card render/resume.
6. **Hardening:** full authz sweep, `security-review`, concurrency tests 1/2/5/10,
   end-to-end entry→dashboard→enrichment.

---

## Appendix — verified evidence (file:line)

- Unauthed intake mount: `index.ts:371`; body-trust + write: `intakeController.ts:692,719`.
- Auth contract: `authMiddleware.ts:254` (verifyToken), `:321` (req.user), `:356` (gate).
- Migration house style: `migrations/021_student_access.sql`; runner:
  `scripts/migrate.ts` (`apply`, ledger `:144–157`); engine MySQL 8 (`:151`).
- Frozen personality contract: `personalityResultAdapter.ts:13`; scorer signature:
  `integratedScoring.ts:54`.
- Dashboard read seam: `dashboard.ts:66` (`getLatestIntakeData`), null-tolerant
  extractors `:145–262`.
- Astrology pure calc: `AstroLogicalStep.tsx:278` (`sunSignFromDate`), stored `:542`.
- TruthStream gate (only hard `intake_completed` consumer): `truthstreamController.ts:184`.
</content>
</invoke>
