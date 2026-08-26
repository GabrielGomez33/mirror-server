# Staging & Deployment Safety Pipeline

The runbook for the staging-gate pipeline that protects production from
disruptive deploys. Born from a multi-day production incident: a change reached
prod with no pre-production validation, no CI tests, and hand-applied
migrations. This pipeline makes that class of incident impossible to repeat
without deliberately bypassing a gate.

**Decisions in force** (chosen 2026-08): same-host isolated staging · real GPU
DINA in staging (via the GPU arbiter) · `develop` deploys to staging ·
required-reviewer approval on production.

---

## The 7 gates (defense in depth)

A change must pass each gate on its way to a user.

| # | Gate | Blocks | Status | Owner |
|---|------|--------|--------|-------|
| 0 | **CI unit tests** — every repo runs its unit suites as a blocking CI step | logic regressions | ✅ done (mirror-server, client) · ⏳ dina/admin triage | automated |
| 1 | **Local pre-push** — `npm run verify` + `.githooks/pre-push` | red code leaving your machine | ✅ scripts shipped · enable per clone | dev |
| 2 | **Branch protection** — feature → PR → `develop` → PR → `master`; green checks + CODEOWNERS review required; no direct push to `master` | unreviewed/unverified code on deploy branches | ⏳ GitHub settings | **you** |
| 3 | **Staging deploy** — `develop` auto-deploys to an isolated staging stack | integration/wiring/migration failures | ⏳ server + workflow | you (server) + automated |
| 4 | **Staging acceptance** — health + client smoke + the Admin intake-simulation E2E + dina liveSecurityE2E, all against staging | anything unit tests can't (real DB/endpoints/full journey) | ⏳ workflow | automated |
| 5 | **Prod promotion** — `production` Environment requires your approval; promote = `develop`→`master`; deploy order dina→mirror→client→admin | un-approved / mis-ordered prod deploys | ⏳ GitHub settings | **you** (approve) |
| 6 | **Migration safety** — migrations apply to staging DB first (validated by the sim), then prod on promote; `.env.example` documents the contract | schema drift / bad migrations in prod | ✅ `.env.example` · ⏳ migrate steps | automated |
| 7 | **Observability** — scheduled synthetic health + lightweight sim with alerting | a bad deploy that slips a gate | ⏳ scheduled workflow | automated |

---

## Staging architecture (same host, fully isolated)

Staging runs beside prod on the same box with **its own** ports, database,
storage, Redis keyspace, PM2 apps, secrets, and web root. Nothing staging does
can touch production data.

| Concern | Production | Staging |
|---|---|---|
| mirror-server port | `8444` | **`9444`** |
| dina-server port | `8445` | **`9445`** (real GPU via arbiter) |
| admin-server port | `8446` | **`9446`** |
| MySQL database | `mirror` / `dina` | **`mirror_staging` / `dina_staging`** |
| Redis logical DB | `0` | **`1`** |
| mirror storage dirs | `/var/mirror/{storage,users}` | **`/var/mirror/staging/{storage,users}`** |
| PM2 app names | `mirror-server`, `analysis-worker`, … | **`mirror-server-staging`, `analysis-worker-staging`, …** |
| Client web root | `/var/www/mirror-client/dist` | **`/var/www/mirror-client-staging/dist`** |
| Internal secret | `MIRROR_INTERNAL_SECRET` (prod) | **its own** distinct secret |
| Public origin | `www.theundergroundrailroad.world` | e.g. `staging.theundergroundrailroad.world` (or a path/subdomain you choose) |

GPU note: staging DINA shares GPU 0 with prod through `DINA_GPU_ARBITER`. Give
staging a smaller `DINA_GPU_RESERVE_MB` so prod always wins contention.

---

## One-time server provisioning (you run these on the host)

> Every command is additive. None touches a `mirror` / prod object. Substitute
> real paths/users. Full variable meanings are in `.env.example`.

### 1. Databases
```sql
CREATE DATABASE mirror_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE dina_staging   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mirror_staging'@'127.0.0.1' IDENTIFIED BY '<distinct-pw>';
GRANT ALL PRIVILEGES ON mirror_staging.* TO 'mirror_staging'@'127.0.0.1';
GRANT ALL PRIVILEGES ON dina_staging.*   TO 'mirror_staging'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 2. Storage dirs
```bash
sudo mkdir -p /var/mirror/staging/storage /var/mirror/staging/users
sudo chown -R "$USER" /var/mirror/staging
```

### 3. Staging env files
Copy each service's `.env.example` to a **staging** env file and apply the
`[env]` overrides from the table above. Generate FRESH secrets for staging:
```bash
# distinct staging secrets (never reuse prod's):
openssl rand -hex 48   # JWT_SECRET / JWT_REFRESH_SECRET / SYSTEM_MASTER_KEY / MIRROR_INTERNAL_SECRET
```
Set `EMAIL_DRY_RUN=true` in staging so it can never send real email.
The staging `MIRROR_INTERNAL_SECRET` must match between mirror-server-staging
and admin-server-staging.

### 4. PM2 (staging apps)
Each server repo ships an `ecosystem.staging.config.js` (staging app names +
staging env file + staging port). Start them once:
```bash
cd /var/www/mirror-server   && pm2 start ecosystem.staging.config.js
cd /var/www/dina-server     && pm2 start ecosystem.staging.config.js
cd /var/www/admin/server    && pm2 start ecosystem.staging.config.js
pm2 save
```

### 5. Migrations against staging (drift-aware)
mirror-server migrations are applied **per file** (the prod DB was built partly
by hand — do NOT assume `migrate up` is safe). Point the migrate command at the
staging env and apply each pending file:
```bash
# mirror-server (per-file):
DB_NAME=mirror_staging <staging-env> npm run migrate -- 022   # repeat per pending file
npm run migrate:status                                        # confirm ledger
# dina-server (batch is safe here):
DB_NAME=dina_staging <staging-env> npm run migrate
```

### 6. Web server (Apache/nginx) staging vhost
Serve `/var/www/mirror-client-staging/dist` at the staging origin, and reverse
-proxy the staging API/admin ports (9444/9446) as prod does for 8444/8446. Issue
a staging TLS cert (or reuse a wildcard). Keep it on a subdomain/path that is
clearly non-production.

---

## GitHub configuration (you set these in repo/org settings)

### Environments
- **`staging`** (new): no reviewers (auto-deploy). Add staging deploy secrets
  (see below).
- **`production`** (existing): add **Required reviewers = you**. Now every prod
  deploy pauses for a one-click approval.

### Branch protection (each repo)
- `master`: require PR, require the **Quality Gates** status check to pass,
  require CODEOWNERS review, require branch up to date, **no direct pushes**.
- `develop`: require the **Quality Gates** status check to pass.

### Secrets / variables
Per repo (or org-level), add staging equivalents of the prod deploy secrets the
workflows already use (`SERVER_HOST` is shared; the rest get a `STAGING_`
sibling): `STAGING_DEPLOY_PATH`, `STAGING_DIST_PATH`, staging `VITE_API_URL`, etc.
Set the repo **variable** `STAGING_ENABLED=true` — the staging workflow jobs are
inert until this flips, so merging the pipeline changes never breaks anything
before staging exists.

---

## The flow, end to end

```
feature branch
   │  (local: git push → pre-push runs npm run verify)
   ▼
Pull Request → develop
   │  CI: Quality Gates (lint · typecheck · UNIT TESTS · build)  ── must be green
   ▼  merge
develop  ──▶  deploy-staging (9444/9445/9446, mirror_staging DB)
   │            └─▶ acceptance: health + client smoke + intake-simulation E2E + dina liveSecurityE2E
   ▼  (all green)
Pull Request → master  (promotion)
   │  required reviewer approves the `production` environment
   ▼
master  ──▶  deploy PROD in order: dina → mirror → client → admin
              each with its existing health-check + automatic rollback
```

A red gate stops the line. Nothing reaches prod that has not first run, migrated,
and passed a full simulated intake on staging.

---

## What already exists and is reused
- **Per-repo health-check + rollback** in the current deploy jobs (Mirror dist
  backup + smoke; server PM2-online + `/health` + git rollback) — reused
  verbatim for both staging and prod.
- **The Admin intake-simulation** (`controllers/intakeSimulationController.ts`,
  `routes/adminSimulation.ts`) — a real register→entry→core→teardown journey. It
  is the staging acceptance test (point `MIRROR_SIM_API_BASE` at staging 9444).
- **dina `test/e2e/liveSecurityE2E.ts`** (`VERIFY_BASE_URL`) — the dina staging
  acceptance check.

## Deferred / follow-ups
- Gate 0 for **dina-server** and **admin**: install deps in a CI run, triage
  which unit suites are green, then wire them blocking (they currently keep the
  blocking `tsc` + `build` gates).
- Gate 7 observability workflow.
