# Mirror — Privacy & Data-Handling Disclosure

**Document type:** Self-attested privacy & data-handling posture (not a third-party certification).
**Policy version:** 2026-09-01
**Authoritative, always-current copy:** `GET /mirror/api/admin/analytics/compliance` (admin-only) returns this posture generated **from the live production schema**, so it can never drift from what the system actually does. This Markdown copy is the human-readable companion; where the two differ, the live endpoint is authoritative.

This document is written to be handed to an entity performing vendor privacy due-diligence (a school district, a state agency, an enterprise procurement or legal team). It is built to satisfy the **strictest superset** of the regimes below.

## Regimes addressed

- **GDPR** (EU/EEA) and **UK-GDPR**
- **CCPA / CPRA** (California)
- **US state privacy laws** — VCDPA (Virginia), CPA (Colorado), CTDPA (Connecticut), UCPA (Utah), TDPSA (Texas)

The controlling design principle: **data minimization**. Conversion analytics are anonymous and aggregate, so most consent obligations never arise and there is structurally nothing to attribute to a person.

---

## 1. Conversion analytics — anonymous & aggregate

Mirror measures where anonymous visitors drop out of the acquisition funnel (landing → signup → intake → first value → premium) to improve conversion. This is done **without collecting personal data**.

**What is stored** (table `conversion_events`, migration `023`):

| Field | Purpose | Personal data? |
|-------|---------|----------------|
| `stage` | which funnel step occurred (closed vocabulary) | No |
| `session_token` | random, ephemeral, per-tab UUID (sessionStorage; not a cookie) — correlates stages *within one anonymous session* only | No — not linkable to an account |
| `utm_source` / `utm_medium` / `utm_campaign` | campaign attribution tags | No |
| `surface` | `web` or `pwa` | No |
| `created_at` | server receive time | No |

**What is deliberately NOT stored:** no `user_id`, no foreign key to `users`, no IP address, no user-agent, and no client-supplied timestamp. The client IP is used only as an in-memory rate-limit key at ingest and is never persisted.

**Enforced guarantees (tested in CI, not just asserted here):**
- The ingest sanitizer builds a fresh allowlist-only object, so no PII or unknown field a client sends can ever be stored (`tests/conversionFunnel.test.ts`, incl. an adversarial PII-smuggling case).
- A schema-guard integration test fails the build if `conversion_events` ever grows a PII-shaped column or a `users` foreign key (`tests/conversionStorage.int.test.ts`, run against a real MySQL in the blocking quality gate).

**Lawful basis:** No personal data is processed. Where a local regime treats an ephemeral session token as personal data, the basis is legitimate interest in measuring and improving the service.

**Privacy signals honored:** the client suppresses **all** conversion analytics when **Global Privacy Control** (`navigator.globalPrivacyControl`) or **Do-Not-Track** is set, or when the visitor has opted out locally. Events are sent with credentials omitted, so no session cookie is attached.

**Data-subject rights scope:** the funnel table is **out of scope** for access/erasure requests — it holds no personal data and cannot be linked to a data subject.

**Retention:** anonymous conversion events are retained **180 days**, then deleted. Enforcement is the application pruner `pruneConversionEvents()` (proven in CI); a nightly MySQL `EVENT` is installed as a convenience where the scheduler is enabled.

---

## 2. Account data — full data-subject rights

Personal data tied to an authenticated account is stored **separately** from analytics and is fully subject to data-subject rights.

**Categories held:** account (email, username); Entry intake (birth date/time/place, preliminary results); Core intake (per-step progress + results); subscription + usage; journal entries; group memberships.

**Rights honored (existing, by real endpoint):**
- **Access / portability** — `GET /mirror/api/user/export` (authenticated, self-scoped): a structured JSON export across all account-data sections.
- **Erasure** — `DELETE /mirror/api/auth/delete-account` (authenticated, self-scoped): a transactional purge across all account tables, followed by a footprint verification that proves the data is gone.
- **Downstream erasure** — account deletion notifies the downstream Dina service to purge its mirror-module artifacts.
- **Consent records** — the `user_consent` table records terms + privacy-notice acceptance, versioned, with timestamp / IP / user-agent.

**Retention:** account data is retained for the life of the account; authentication tokens are purged nightly.

---

## 3. Operations

- **Migration:** apply the analytics schema with `npm run migrate -- 023` on each environment (staging, production). Additive and idempotent; safe to re-run.
- **Admin access:** the aggregate funnel (`/mirror/api/admin/analytics/funnel`) and this compliance record (`/mirror/api/admin/analytics/compliance`) are reachable only server-to-server from the Admin portal over localhost, gated by the internal shared secret, and every access is audit-logged with the operator identity.

---

*Generated and maintained by Mirror. For the live, machine-readable version, query the compliance endpoint above.*
