-- ============================================================================
-- 022_intake_progress.sql
-- ----------------------------------------------------------------------------
-- Two-tier intake: Entry (initial) intake + resumable per-step Core intake.
--
-- CONTEXT
--   Splits the old all-or-nothing intake into (a) a ~4-minute Entry intake that
--   makes the app functional on day one, and (b) the existing deep Core intake
--   re-shaped into resumable per-step enrichment. See
--   docs/entry-core-intake-spec.md for the full design + proofs.
--
-- SEPARATION OF CONCERNS
--   * Entry and Core completion are DECOUPLED. `initial_intake_completed`
--     (this migration) tracks Entry; `intake_completed` (existing column) is
--     re-derived from `core_intake_progress` in application code. Neither reads
--     the other. Entry NEVER writes a core_intake_progress row.
--   * Entry results live in their OWN table (entry_intake_results); Core data
--     stays in the existing tiered intake storage. They are merged only on READ
--     (services/intakeReadModel.resolveLatest), never co-mingled at rest.
--
-- DESIGN NOTES
--   * core_intake_progress: UNIQUE(user_id, step_key) is the real guard — it is
--     the upsert key AND the concurrency guard. Completion is
--     INSERT ... ON DUPLICATE KEY UPDATE, so concurrent completes for one
--     (user, step) collapse to a single idempotent row (cf. 021 UNIQUE guards).
--   * entry_intake_results: UNIQUE(user_id) — one Entry result per user; submit
--     is an idempotent upsert.
--   * draft_state / *_result are JSON. draft_state stores resumable NON-media
--     state only — never a photo/voice blob.
--   * Charsets/collations match the paywall + user-adjacent tables
--     (utf8mb4_unicode_ci) which already FK to users(id).
--
-- SAFETY
--   Additive only. No DROP, no destructive ALTER. CREATE TABLE IF NOT EXISTS is
--   self-idempotent; the single ALTER is guaranteed to run exactly once by the
--   runner's schema_migrations ledger (MySQL 8 has no ADD COLUMN IF NOT EXISTS).
--   Re-applying this file via `npm run migrate 022` is a ledger no-op.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (a) Entry-intake completion flag on users.
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN initial_intake_completed TINYINT(1) NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- (b) Entry-intake results — fully separate from Core storage (merged on read).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry_intake_results (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  user_id            INT NOT NULL,
  -- Frozen PersonalityResult shape (client personalityResultAdapter), as JSON.
  personality_result JSON NULL,
  -- astrologicalResult from computeAstrology(birthData), as JSON.
  astrology_result   JSON NULL,
  -- Non-identifying birth inputs retained for recompute / future age-banded norms.
  birth_date         DATE NULL,
  birth_time         TIME NULL,
  birth_place        VARCHAR(180) NULL,
  display_name       VARCHAR(120) NULL,
  -- Entry is always 'preliminary' (reduced-N confidence). Reserved 'full' for parity.
  confidence         ENUM('preliminary','full') NOT NULL DEFAULT 'preliminary',
  schema_version     SMALLINT NOT NULL DEFAULT 1,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- one Entry result per user; this is the idempotent upsert key
  UNIQUE INDEX idx_user (user_id),
  CONSTRAINT fk_entry_result_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- (c) Per-step Core-intake progress — source of truth for derived intake_completed.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core_intake_progress (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  step_key      ENUM('visual','vocal','iq','astrology','personality') NOT NULL,
  status        ENUM('not_started','in_progress','completed') NOT NULL DEFAULT 'not_started',
  -- Resumable NON-media draft only. Never a photo/voice blob.
  draft_state   JSON NULL,
  completed_at  TIMESTAMP NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- upsert key + duplicate-row race guard (one row per user+step)
  UNIQUE INDEX idx_user_step (user_id, step_key),
  INDEX idx_user_status (user_id, status),
  CONSTRAINT fk_core_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- (d) BACKFILL — protect users who already finished intake under the old
--     semantics. Before this migration, intake_completed was set TRUE on the
--     first /store, and the monolithic SubmitStep required ALL five sections
--     (photo, voice, iq, astrology, personality) to submit — so an existing
--     intake_completed=1 user genuinely provided all five. We seed all five
--     'completed' rows for them; otherwise the new derivation would recount 0
--     completed steps on their next write and REGRESS intake_completed to 0.
--     INSERT IGNORE + UNIQUE(user_id, step_key) makes this idempotent.
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO core_intake_progress (user_id, step_key, status, completed_at)
SELECT u.id, s.step_key, 'completed', NOW()
FROM users u
CROSS JOIN (
  SELECT 'visual'      AS step_key UNION ALL
  SELECT 'vocal'       UNION ALL
  SELECT 'iq'          UNION ALL
  SELECT 'astrology'   UNION ALL
  SELECT 'personality'
) s
WHERE u.intake_completed = 1;
