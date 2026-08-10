-- ============================================================================
-- 021_student_access.sql
-- ----------------------------------------------------------------------------
-- Free-for-verified-students program (Goal #1, L1 design).
--
-- CONTEXT
--   Grants the existing `premium` tier to verified college students as a
--   time-boxed COMPLIMENTARY subscription (provider='manual',
--   provider_plan_id='student_comp' on user_subscriptions — no schema change
--   to that table). This migration adds only the three tables the student
--   verification flow needs. It touches NOTHING that paying users rely on.
--
-- SEPARATION OF CONCERNS
--   Entitlement is resolved entirely inside mirror-server's paywall
--   (subscription.service.getSubscriptionTier). Dina is never consulted for
--   "is this user a student", so no dina-server change accompanies this.
--
-- DESIGN NOTES
--   * accredited_domains is the ALLOWLIST (status='active') and DENYLIST
--     (status='blocked') in one curatable table. Matching is exact-domain +
--     dot-boundary sub-domain (see services/studentDomainService.ts), NOT a
--     '.edu' suffix — so 'evilharvard.edu' can never satisfy 'harvard.edu'.
--   * student_verifications: ONE row per user (UNIQUE user_id) AND one claim
--     per campus mailbox (UNIQUE normalized_email). The second constraint is
--     the authoritative defense against one inbox minting many student seats;
--     the controller's pre-check is only UX — this UNIQUE is the real guard.
--   * student_verification_tokens mirrors email_verification_tokens but is a
--     SEPARATE table because it verifies a campus address that is decoupled
--     from users.email (students keep their normal login). Verifying it must
--     NOT touch users.email_verified.
--   * All charsets/collations match the paywall tables (utf8mb4_unicode_ci)
--     which already FK to users(id) — avoids the cross-table collation
--     mismatch class of bug (cf. 020_waitlist_collation_align.sql).
--
-- SAFETY
--   Every statement is IF NOT EXISTS / INSERT IGNORE, so re-applying is a
--   no-op. No DROP, no ALTER of existing tables, no data migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Accredited institution domains (allowlist + denylist in one table)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accredited_domains (
  id INT AUTO_INCREMENT PRIMARY KEY,
  domain VARCHAR(253) NOT NULL,
  institution_name VARCHAR(255) NULL,
  country CHAR(2) NOT NULL DEFAULT 'US',
  -- 'active'  => allowlisted (eligible)
  -- 'blocked' => denylisted (explicitly refused, e.g. K-12 / disposable reseller)
  status ENUM('active', 'blocked') NOT NULL DEFAULT 'active',
  notes VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_domain (domain),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Student verification state (source of truth for the comp grant lifecycle)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_verifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  -- canonical campus email: lowercased, "+tag" stripped (see studentDomainService)
  normalized_email VARCHAR(254) NOT NULL,
  matched_domain VARCHAR(253) NOT NULL,
  method ENUM('email_allowlist', 'email_suffix', 'vendor') NOT NULL DEFAULT 'email_allowlist',
  attested_18 TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active', 'expired', 'revoked') NOT NULL DEFAULT 'active',
  verified_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  revoked_reason VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- one active verification record per user...
  UNIQUE INDEX idx_user (user_id),
  -- ...and one campus mailbox can only ever be claimed once (anti-abuse core)
  UNIQUE INDEX idx_normalized_email (normalized_email),
  INDEX idx_status_expires (status, expires_at),
  CONSTRAINT fk_student_verif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Campus-email verification tokens (single-use, expiring; emailed credential)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_verification_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  normalized_email VARCHAR(254) NOT NULL,
  matched_domain VARCHAR(253) NOT NULL,
  attested_18 TINYINT(1) NOT NULL DEFAULT 0,
  token VARCHAR(128) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX idx_token (token),
  INDEX idx_user (user_id),
  INDEX idx_email (normalized_email),
  CONSTRAINT fk_student_token_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Seed: a STARTER allowlist. This is illustrative, not exhaustive — curate the
-- full set from an accredited-institution source (e.g. the US DoE database) via
-- the admin surface. INSERT IGNORE keeps re-application idempotent and lets
-- operators hand-edit rows without this seed clobbering them.
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO accredited_domains (domain, institution_name, country) VALUES
  ('harvard.edu',      'Harvard University',                         'US'),
  ('mit.edu',          'Massachusetts Institute of Technology',      'US'),
  ('stanford.edu',     'Stanford University',                        'US'),
  ('berkeley.edu',     'University of California, Berkeley',          'US'),
  ('ucla.edu',         'University of California, Los Angeles',       'US'),
  ('umich.edu',        'University of Michigan',                     'US'),
  ('utexas.edu',       'University of Texas at Austin',              'US'),
  ('nyu.edu',          'New York University',                        'US'),
  ('columbia.edu',     'Columbia University',                        'US'),
  ('cornell.edu',      'Cornell University',                         'US'),
  ('yale.edu',         'Yale University',                            'US'),
  ('princeton.edu',    'Princeton University',                       'US'),
  ('uchicago.edu',     'University of Chicago',                      'US'),
  ('upenn.edu',        'University of Pennsylvania',                 'US'),
  ('gatech.edu',       'Georgia Institute of Technology',            'US'),
  ('uw.edu',           'University of Washington',                   'US'),
  ('wisc.edu',         'University of Wisconsin-Madison',            'US'),
  ('illinois.edu',     'University of Illinois Urbana-Champaign',    'US'),
  ('umn.edu',          'University of Minnesota',                    'US'),
  ('asu.edu',          'Arizona State University',                   'US'),
  ('ufl.edu',          'University of Florida',                      'US'),
  ('psu.edu',          'Pennsylvania State University',              'US'),
  ('osu.edu',          'The Ohio State University',                  'US'),
  ('rutgers.edu',      'Rutgers University',                         'US'),
  ('bu.edu',           'Boston University',                          'US'),
  ('northeastern.edu', 'Northeastern University',                    'US'),
  ('usc.edu',          'University of Southern California',          'US'),
  ('duke.edu',         'Duke University',                            'US'),
  ('jhu.edu',          'Johns Hopkins University',                   'US'),
  ('umd.edu',          'University of Maryland',                     'US');

-- ----------------------------------------------------------------------------
-- Seed: a small STARTER denylist. Known disposable/abused patterns and an
-- example K-12 form. Expand as abuse is observed. (Real K-12 exclusion is
-- primarily achieved by simply NOT allowlisting K-12 domains.)
-- ----------------------------------------------------------------------------
INSERT IGNORE INTO accredited_domains (domain, institution_name, country, status, notes) VALUES
  ('mailinator.com', 'Disposable mailbox provider', 'US', 'blocked', 'disposable'),
  ('sharklasers.com','Disposable mailbox provider', 'US', 'blocked', 'disposable'),
  ('guerrillamail.com','Disposable mailbox provider','US','blocked', 'disposable');
