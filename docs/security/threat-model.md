# mirror-server — Threat Model & Security Scorecard

> Living security baseline for the mirror-server service. Kept **in-repo** (not a
> public URL) because it enumerates attack paths. Update it when controls change.
> This is an informed engineering assessment from code review — NOT a certified
> penetration test. Monitoring/alerting, backups, and DR are **not** assessed here.
>
> Last reviewed: 2026-09-11 — state: **before de-privileging** (app runs as root).

## Trust boundaries

Public internet → Apache (TLS termination, Basic-Auth on staging, `trust proxy 1`)
→ Node/Express over HTTPS (`index.ts`) → MySQL + Redis + encrypted file storage.

The Node process currently runs as **root** (via `sudo pm2`). This is the dominant
residual risk — see "The amplifier" below.

## Attack vectors (path → controls → coverage → likelihood × impact)

| # | Vector | Path | Controls in place (evidence) | Coverage / gap | L × I |
|---|---|---|---|---|---|
| 1 | AuthZ / IDOR | Call an API with another user's id | Target is always `req.user.id`, never body/param (`controllers/intakeController.ts` storeIntakeDataHandler); `assertSelfBody`; per-route `SecurityLevel` (`middleware/authMiddleware`); group membership (`middleware/groupAuth`); regression-locked by `tests/securityInvariants.test.ts` | Strong; per-handler not global | Low × High |
| 2 | SQL injection | Malicious input in a query | Parameterized `?` placeholders (mysql2) throughout; `tests/piiColumnGuard.test.ts`; validators (`utils/entryIntakeValidation`, `utils/intakeValidation`) | Strong; no string-built SQL | Low × High |
| 3 | XSS | Script runs in a victim's browser | Strict CSP `script-src 'self'`, no `unsafe-inline`/`unsafe-eval`, `object-src`/`frame-ancestors 'none'` (`index.ts` helmet); client has no `dangerouslySetInnerHTML`/`eval`/`innerHTML=` (client `securityInvariants.test.ts`) | Good; `style-src 'unsafe-inline'` (Tailwind) is a minor residual | Low-Med × High |
| 4 | Token theft | Steal JWT, impersonate | 15-min access tokens + refresh rotation; HTTPS-only + HSTS preload; reactive refresh via `authedFetch` | Gap: tokens in `localStorage` → chainable with a successful XSS (#3) | Low-Med × High |
| 5 | CSRF | Forge state-changing request cross-site | Auth is a Bearer header (not a cookie) — cannot be set cross-site; strict CORS allowlist (`index.ts`, `EXTRA_ALLOWED_ORIGINS`); `form-action 'self'` | Strong | Low × Med |
| 6 | Transport / MITM | Intercept/downgrade | HTTPS server; HSTS preload; outbound TLS verify loopback-gated, never blanket-off (scanned by `securityInvariants.test.ts`) | Strong | Low × High |
| 7 | DoS / exhaustion | Flood or oversized payloads | Body limits (100kb global / 8kb analytics / 12mb email — `index.ts`); rate limits on login (`LoginSecurity`), join, password-reset, analysis (5/hr), push, truthstream; `max_memory_restart`; ws memory-DoS advisory patched | Gap: no global limiter; not every route limited | Med × Med |
| 8 | Secrets exposure | Leak creds / hit internal endpoints | Admin/sim gated by `MIRROR_INTERNAL_SECRET` header; sim namespace-locked + `teardownSimUser` safety stop; `.env` not committed; CI secret-scan | Strong | Low × High |
| 9 | Dependency / supply chain | Exploit a known CVE | 0 high/critical advisories; blocking CI audit gate (`scripts/auditGate.mjs`) with empty allowlist | Strong now; needs ongoing patching | Low × High |
| 10 | Data at rest | Read stored assessments off disk | Tiered encryption (tier1/2/3); per-user + per-group keys (`systems/GroupEncryptionManager`); `0600` files | Strong; keys co-located on host | Low × High |
| — | Detection / monitoring / DR | — | **Not assessed** (no IDS/alerting/backup review) | Unknown | Unknown |

## The amplifier — running as root

The realistic attack profile for a small public app is **automated** (credential
stuffing, injection/vuln scanners, CVE bots); the controls above cover that well.
The single factor that turns any low-probability RCE into a catastrophe is that
the process runs as **root**: a foothold *is* full control of the box and every
co-hosted service. De-privileging to `mirror_app` does not lower breach
*probability* — it caps *impact* and forces a separate privilege-escalation step.

## Scorecard (before de-privileging)

**Overall: 72 / 100** → **~83** after de-privileging.

| Domain | Score |
|---|---:|
| Injection (SQLi) | 95 |
| Transport / TLS | 94 |
| Dependency hygiene | 92 |
| XSS / content policy | 88 |
| AuthN / AuthZ / IDOR | 85 |
| Data at rest | 84 |
| Secrets / config | 84 |
| DoS / rate limiting | 68 |
| **Least privilege (blast radius)** | **30** |
| Detection / monitoring / DR | unassessed |

The app layer is strong (~87 weighted); the composite is dragged to 72 by the
root-privilege factor. Fixing it lifts least-privilege ~30 → ~85 and the
composite to ~83.

## Chance of a debilitating blow

- Opportunistic attacker (bots/scanners): **very low** — bounces off patched deps,
  parameterized SQL, rate limits, header-auth, CSP.
- Skilled targeted attacker: **moderate–high effort to get a foothold** (needs a
  real logic/0-day bug, or an XSS chained to the localStorage token).
- **Once a foothold exists, escalation to catastrophic is currently trivial**
  because the process is root (no privesc needed). De-privileging flips this.

**Threat level: MODERATE** (public consumer app with PII; dominant threat is
automated). **Exposure level: MODERATE–HIGH** (internet-facing HTTPS API + WS,
broad route surface; staging shielded by Basic Auth).

## Prioritized residual risks

1. **Root blast radius** — highest impact; addressed by the de-privilege step.
2. **Token-in-`localStorage` × XSS chain** — CSP makes it unlikely; an `HttpOnly`
   cookie would close it structurally (larger change).
3. **Rate-limit coverage** — a global per-IP/per-user limiter hardens the DoS surface.
4. **Detection/monitoring/DR** — unassessed; establish a baseline.
