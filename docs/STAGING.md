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
The staging `MIRROR_INTERNAL_SECRET` must match between mirror-server-staging
and admin-server-staging.

**Email (staging).** Staging email uses the SAME variable NAMES as prod — only
the VALUES differ. Two invariants (both enforced by the `email_health` staging-
acceptance gate, and unit-proven in `tests/emailIsolation.test.ts`):
1. **Enabled** — a provider key is set (`RESEND_API_KEY` / `EMAIL_API_KEY`), so
   `/health` reports `email:enabled` and the `email-campaign-worker` (in
   `ecosystem.staging.config.js`) has something to send with.
2. **Isolated** — `APP_URL` and `EMAIL_PUBLIC_BASE_URL` point at the **staging**
   origin, never prod. Otherwise a staging signup's verification link resolves
   to production (the token lives in `mirror_staging`, so it fails on prod and
   hands the tester to the live app). The gate fails a staging run if a link
   base resolves to the prod host.

**Proving the send pipeline (not just config).** The `email_health` gate proves
email is enabled + isolated + the provider authenticates. To prove a real send
works end to end, set `STAGING_EMAIL_CANARY` to a mailbox you own (e.g.
`gabrielgomez@trymirror.world`). Each staging-acceptance run then fires the
`email_send` gate: it sends one real verification email through the actual
template + provider path and asserts the provider **accepted** it (messageId, no
error) — exercising template render, the staging `APP_URL` link base, and the
verified sending domain. Provider-acceptance is the automatable signal; confirm
true inbox **delivery** by eyeballing the canary box. Unset -> the gate warns
(pipeline unproven). Under `EMAIL_DRY_RUN=true` it passes with a note instead of
a real send.

Two ways to run it, both isolated:
- **Separate key + staging sending subdomain** (recommended, true separation):
  own `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS=noreply@staging.<domain>`,
  `EMAIL_DRY_RUN=false`. Staging bounces/quota/suppression never touch the prod
  domain. Real emails deliver — click-the-link testing works end to end.
- **Shared key + dry-run** (interim, zero external setup): reuse the prod
  `RESEND_API_KEY` but set `EMAIL_DRY_RUN=true`. The provider is loaded
  (`email:enabled`, gate passes) but is NEVER called — no sends, no prod
  reputation/quota/webhook intertwining. Read verification links from
  `pm2 logs mirror-server-staging`. Flip to `false` briefly for a one-off real
  send to your own inbox.

**Notifications (web push / VAPID).** Push runs inside mirror-server (routes
`/mirror/api/push`), so it is already part of the staging stack — it only needs
its OWN VAPID keypair. Generate a distinct one and put it in the staging `.env`:
```bash
npx web-push generate-vapid-keys   # -> VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```
Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (e.g.
`mailto:ops@staging.<domain>`) in the staging env. **Never reuse prod's keys:**
a browser push subscription is bound to BOTH the applicationServerKey (the public
key) AND the origin, so sharing keys crosses environments. No client change is
needed — the client fetches the public key at runtime from
`GET /mirror/api/push/vapid-public-key`, so the staging client automatically
subscribes with the staging key. The staging-acceptance `push_health` gate warns
if the keypair is unset (notifications unconfigured) and passes once it is set.

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

---

# BRING-UP ORDER — Mirror first (execute this now)

Stand up staging for the **Mirror** user-facing system (client + mirror-server
API) and validate the loop end-to-end. DINA staging comes next; admin later.
For this first pass, run mirror-server-staging with `USE_DINA_STUB=true` so it
boots cleanly without dina-staging (intake register/entry/core need no DINA; the
sim's DINA purge is best-effort). Flip the stub off once dina-staging exists.

## Exact GitHub secrets/variables the committed workflows expect
These names are referenced verbatim in the workflows — create them exactly.

**mirror-server repo:**
- secret `STAGING_DEPLOY_PATH` = the staging server checkout dir (e.g. `/var/www/mirror-server-staging`)
- secret `STAGING_MIRROR_INTERNAL_SECRET` = the staging internal secret (must equal `MIRROR_INTERNAL_SECRET` in the staging `.env`)
- variable `STAGING_ENABLED` = `false` for now (flip to `true` in step 6)
- (existing, reused: `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY`)

**Mirror repo:**
- secret `STAGING_DIST_PATH` = staging client web root (e.g. `/var/www/mirror-client-staging/dist`)
- secret `STAGING_VITE_API_URL` = staging API origin the client calls (e.g. `https://staging.theundergroundrailroad.world`)
- secret `STAGING_VITE_PAYPAL_CLIENT_ID` / `STAGING_VITE_PAYPAL_PLAN_ID` = PayPal **sandbox** creds
- variable `STAGING_ENABLED` = `false` for now

## Step 0 — get the pipeline onto develop
The staging jobs + test gates must exist ON `develop` to run there. Merge the
current branch into `develop` (open the PR; it will exercise the new blocking
Quality Gates for the first time). Do this before enabling branch protection so
you are not blocked bootstrapping.

## Step 1 — GitHub environments & protection
- Create environment **`staging`** (no reviewers).
- On environment **`production`**, add **Required reviewers = you**.
- Branch protection: `master` and `develop` → require the **Quality Gates**
  check + PR + CODEOWNERS review; no direct pushes to `master`.

## Step 2 — staging database (schema from prod, NO prod data)
The prod DB was built partly by hand, so migration files alone can't build it
from empty. Copy the STRUCTURE only, then baseline the ledger:
```bash
mysql -e "CREATE DATABASE mirror_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysqldump --no-data --routines --triggers mirror | mysql mirror_staging   # structure only — no rows
mysql -e "CREATE USER 'mirror_staging'@'127.0.0.1' IDENTIFIED BY '<pw>'; \
          GRANT ALL ON mirror_staging.* TO 'mirror_staging'@'127.0.0.1'; FLUSH PRIVILEGES;"
```
Then, from the staging checkout with the staging `.env`, record the ledger and
apply anything newer than the dump:
```bash
npm run migrate:baseline     # mark existing schema as applied
npm run migrate:status       # see what (if anything) is pending
npm run migrate -- <n>       # apply each pending file, per-file (drift-aware)
```

## Step 2b — seed REFERENCE/CONFIG data (NOT user data)
The `--no-data` dump gives us zero prod PII (good, secure) but also drops the
**reference/config** tables the app needs to function — e.g. the TruthStream
questionnaires. Copy the DATA of the config tables only (never the user tables),
data-only + `--replace` so it is idempotent and leaves staging's schema intact:
```bash
# Reference/config tables — safe to copy (no user PII). Extend this list as new
# config tables are discovered (the staging acceptance sim names any that are
# missing, e.g. "no active questionnaire for goal_category ...").
REF_TABLES="truth_stream_questionnaires"
for t in $REF_TABLES; do
  mysqldump --no-create-info --skip-triggers --replace --complete-insert mirror "$t" | mysql mirror_staging
done
# verify (example): active questionnaires present for every goal category
mysql -e "SELECT goal_category, is_active, version FROM mirror_staging.truth_stream_questionnaires ORDER BY goal_category;"
```
Also seed the **Dina system user** — the bot account that authors @Dina chat
replies (`mirror_group_messages.sender_user_id` FK). Its id is `DINA_USER_ID_SQL`
in the mirror `.env` (e.g. 59); without it, @Dina generates a reply but cannot
insert it (FK violation). It is a system account, not real PII:
```bash
DINA_UID=59   # match DINA_USER_ID_SQL in the staging .env
mysqldump --no-create-info --skip-triggers --replace --complete-insert --where="id=$DINA_UID" mirror users | mysql mirror_staging
mysql -e "SELECT id, username FROM mirror_staging.users WHERE id=$DINA_UID;"
```
Rule of thumb: a table/row is **reference/config** if it is authored by the team
and shared by all users (questionnaires, norms, templates, category lists, the
Dina system account); it is **user data** if rows are created per-account
(profiles, reviews, messages, intake) — those stay EMPTY in staging and are
created by the sim.

## Step 3 — storage dirs
```bash
sudo mkdir -p /var/mirror/staging/storage /var/mirror/staging/users
sudo chown -R "$USER" /var/mirror/staging
```

## Step 4 — staging server checkout + .env + PM2
```bash
git clone <mirror-server repo> /var/www/mirror-server-staging
cd /var/www/mirror-server-staging && git checkout develop
cp .env.example .env       # then edit per the [env] overrides:
#   MIRRORPORT=9444  DB_NAME=mirror_staging  REDIS_DB=1
#   MIRRORSTORAGE=/var/mirror/staging/storage  MIRRORUSERSTORAGE=/var/mirror/staging/users
#   MIRROR_SELF_BASE_URL=https://127.0.0.1:9444  APP_URL=<staging origin>
#   EMAIL_DRY_RUN=true  USE_DINA_STUB=true
#   MIRROR_INTERNAL_SECRET=<== same value you put in STAGING_MIRROR_INTERNAL_SECRET>
#   JWT_SECRET / JWT_REFRESH_SECRET / SYSTEM_MASTER_KEY = FRESH (openssl rand -hex 48)
#   TUGRRPRIV / TUGRRCERT = staging cert (or loopback self-signed)
npm ci && npm run build
pm2 start ecosystem.staging.config.js && pm2 save
curl -sk https://127.0.0.1:9444/mirror/api/health   # expect 200
```

## Step 5 — client staging web root + vhost
```bash
sudo mkdir -p /var/www/mirror-client-staging/dist
```
Add an Apache/nginx vhost for the staging origin: serve
`/var/www/mirror-client-staging/dist` (SPA fallback) and reverse-proxy
`/mirror/api` + WS to `https://127.0.0.1:9444`. Issue a staging TLS cert.

## Step 6 — enable and fire
- Set both repos' variable `STAGING_ENABLED=true`.
- Push a commit to `develop` (or re-run the latest develop workflow).
- Watch: **deploy-staging** (mirror-server + client) then **staging-acceptance**
  (the intake simulation) — both must go green.

## Step 7 — human validation
Open the staging origin, register a throwaway user, complete Entry + one Core
reflection, confirm it shows on MyMirror. Then you have a proven staging loop;
DINA staging replicates the same pattern (ports 9445, dina_staging, flip
USE_DINA_STUB=false).

## Gotchas to expect on first run
- **Health 200 but sim fails**: check the staging `MIRROR_INTERNAL_SECRET`
  matches `STAGING_MIRROR_INTERNAL_SECRET` exactly.
- **Server boots then workers error**: usually a missing staging env var — the
  `[req]` ones in `.env.example`.
- **Client loads but API 502**: the vhost isn't proxying `/mirror/api` to 9444,
  or `STAGING_VITE_API_URL` was baked wrong (rebuild after fixing).

# ============================================================================
# DINA-STAGING BRING-UP (second environment — validated)
# ============================================================================
# Same-host, fully isolated dina-server staging on 9445, owned by the `dina`
# system user (separation of concerns — NOT mirror_app). Validated end-to-end via
# mirror-server's acceptance sim (@Dina chat produces a real LLM reply against it).

## D1 — artifacts (committed)
`ecosystem.staging.config.js` (dina-server-staging, root PM2, GPU device 0) and
the `deploy-staging` job in dina-server `.github/workflows/ci-cd.yml`
(develop + STAGING_ENABLED, health-checks 9445/dina/api/v1/health). Staging
overrides are documented at the bottom of dina-server `.env.example`.

## D2 — storage + checkout (owned by `dina`)
```bash
sudo mkdir -p /var/www/staging/dina-storage /var/www/staging/saga-storage
sudo chown -R dina:dina /var/www/staging/dina-storage /var/www/staging/saga-storage
sudo mkdir -p /var/www/staging/dina-server && sudo chown dina:dina /var/www/staging/dina-server
sudo -u dina -H bash -c 'cd /var/www/staging/dina-server && \
  git clone -b develop <repo> . && npm ci && npm run build'
```

## D3 — DB + structure from prod (as administrator)
```bash
CREATE DATABASE dina_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'dina_staging'@'localhost'/'@127.0.0.1' IDENTIFIED BY '<pw>';
GRANT ALL ON dina_staging.* TO 'dina_staging'@...;
mysqldump --no-data --routines --triggers dina | mysql dina_staging   # structure only
```

## D4 — staging .env (as `dina`, in the checkout)
Key isolation values: `DINA_PORT=9445`, `DB_NAME=dina_staging` + dedicated user,
`REDIS_URL=redis://localhost:6379/2` + `REDIS_DB=2` (dina's Redis is 6379; mirror's
is 6380), staging `DINA_STORAGE`/`SAGA_ROOT`, DISTINCT `JWT_SECRET`/`ENCRYPTION_KEY`/
`DINA_ENCRYPTION_KEY`, `EMAIL_PROVIDER=console`, reuse prod TLS certs, shared
`LLM_ENDPOINT=http://localhost:11434` (Ollama serialises — safe), `DINA_GPU_ARBITER=off`.

## D5 — start + health (as `dina`, via `sudo pm2` — dina runs under root PM2)
```bash
cd /var/www/staging/dina-server && sudo pm2 start ecosystem.staging.config.js && sudo pm2 save
curl -sk https://127.0.0.1:9445/dina/api/v1/health    # -> {"status":"healthy",...}
```

## D6 — wire mirror-staging -> dina-staging THE SAME WAY PROD DOES (equivalence)
Address dina by the DOMAIN NAME on its port, exactly like prod — prod uses
`https://www.theundergroundrailroad.world:8445` (BASE/WS) directly on dina's
port. Staging is identical with the staging PORT 9445. No reverse proxy.

Why the DOMAIN, never the IP: the personal-analysis / truthstream workers call
dina with a plain `fetch` that verifies TLS, and TLS is verified against the URL
HOSTNAME, not the port. dina's cert is the domain cert (valid for
`www.theundergroundrailroad.world`; staging reuses the prod cert). So
`https://127.0.0.1:9445` FAILS (the IP isn't on the cert → "fetch failed" →
personal analysis never completes → its completion push never fires), while
`https://www.theundergroundrailroad.world:9445` VERIFIES (hostname matches) and
`:9445` is a distinct port so it reaches dina-STAGING, not prod dina. The port
was never the issue — using the IP instead of the domain name was. (The @Dina WS
client set `rejectUnauthorized:false`, so it tolerated the IP — which is exactly
why dina-chat "worked" while personal-analysis silently failed, masking it.)

mirror-staging `.env` — mirror prod, changing only the port 8445 -> 9445:
```
USE_DINA_STUB=false
DINA_ENDPOINT=https://www.theundergroundrailroad.world:9445/dina/api/v1/
DINA_WS_URL=wss://www.theundergroundrailroad.world:9445/dina/ws
DINA_BASE_URL=https://www.theundergroundrailroad.world:9445
DINA_SERVER_URL=https://www.theundergroundrailroad.world
```
`sudo pm2 restart ecosystem.staging.config.js --update-env`, then re-run the sim.
The `dina_http` gate must pass, `group_dina_chat` must report "@Dina replied in
group chat", AND a `personal-analysis` job must reach `status='completed'`
(dina-staging log shows the generate call), which fires the
`personal_analysis_complete` push. No TLS verification is relaxed anywhere — the
path is byte-for-byte the prod shape.

## D7 — reference data (see Step 2b): the Dina system user (mirror_staging.users
id DINA_USER_ID_SQL) MUST be seeded, or @Dina generates a reply but cannot insert
it (FK fk_message_sender). Also seed truth_stream_questionnaires.

## DINA GitHub config (dina-server repo)
- secret `STAGING_DEPLOY_PATH=/var/www/staging/dina-server`
- var `STAGING_ENABLED=true`
- secret `SERVER_USER=dina` (the dina user needs passwordless `sudo pm2`, same as
  mirror_app) — keeps deploys under the owning user (separation of concerns).
