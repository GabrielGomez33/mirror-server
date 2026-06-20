-- 017_intake_simulation_runs.sql
-- ---------------------------------------------------------------------------
-- Audit log for the admin Intake Simulation tool (controllers/
-- intakeSimulationController.ts + routes/adminSimulation.ts).
--
-- One row per simulation run. Records the throwaway sim user that was created,
-- the per-step outcome, and whether teardown completed. This table is also the
-- reconciliation source for the orphan sweeper: a run whose sim_user_id no
-- longer exists in `users` is marked cleaned_up = 1.
--
-- Purely additive — it does not touch any existing table. The controller also
-- creates this table lazily via CREATE TABLE IF NOT EXISTS, so applying this
-- migration is optional but recommended (it lets the history survive a cold
-- start before the first run, and documents the schema in version control).
--
-- Idempotent: safe to run repeatedly.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intake_simulation_runs (
  run_id        VARCHAR(36)  NOT NULL,
  operator      VARCHAR(128) NULL,                 -- admin-portal username (x-admin-user)
  label         VARCHAR(255) NULL,                 -- optional free-text run label
  status        VARCHAR(32)  NOT NULL,             -- running | passed | passed_with_warnings | failed
  dry_run       TINYINT(1)   NOT NULL DEFAULT 0,
  sim_user_id   INT          NULL,                 -- id of the throwaway user (NULL until created)
  sim_username  VARCHAR(128) NULL,                 -- reserved __sim_ prefix
  sim_email     VARCHAR(255) NULL,                 -- reserved non-routable domain
  steps         JSON         NULL,                 -- array of { name, ok, severity, ms, detail }
  warnings      JSON         NULL,
  error         TEXT         NULL,
  cleaned_up    TINYINT(1)   NOT NULL DEFAULT 0,
  duration_ms   INT          NULL,
  started_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME     NULL,
  PRIMARY KEY (run_id),
  KEY idx_sim_runs_started (started_at),
  KEY idx_sim_runs_cleanup (cleaned_up, sim_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;