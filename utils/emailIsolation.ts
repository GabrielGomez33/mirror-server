// ============================================================================
// emailIsolation — pure guard against cross-environment email link leakage.
// ============================================================================
// Email is a SHARED external service (one Resend account/domain can back both
// prod and staging). The one thing that must NEVER cross environments is the
// LINK BASE: verification / reset / confirm links are built from APP_URL and
// EMAIL_PUBLIC_BASE_URL. If a staging deployment keeps the prod values (an easy
// mistake when copying prod's .env), a staging signup's verification email
// links to PROD — the token lives in mirror_staging, so it fails on prod AND
// the tester is silently handed off to the production app. That is exactly the
// intertwining the separate-envs rule exists to prevent.
//
// This module owns ONE decision, purely and testably: "given this env, do the
// email link bases leak into prod while running against a staging database?"
// The staging-acceptance gate calls it; the app never sends against a leaking
// config without the gate going red.
// ============================================================================

export interface EmailEnvSnapshot {
  /** DB_NAME — the staging database is conventionally named '*staging*'. */
  dbName?: string;
  /** APP_URL — base for client-facing links (e.g. /verify-email?token=). */
  appUrl?: string;
  /** EMAIL_PUBLIC_BASE_URL — base for public email endpoints (unsubscribe…). */
  emailPublicBaseUrl?: string;
  /** EMAIL_FROM_ADDRESS — the sender. Staging must send as the staging
   *  subdomain, never the bare prod sending domain (shared reputation). */
  fromAddress?: string;
}

export interface EmailIsolationVerdict {
  isStaging: boolean;
  leaksToProd: boolean;
  reason: string;
}

// The production public host. A staging env must never emit links to it.
export const PROD_EMAIL_HOST = 'www.theundergroundrailroad.world';
// The production sending domain. Staging must send as its own subdomain
// (e.g. staging.theundergroundrailroad.world), never the bare prod domain —
// otherwise staging bounces/complaints hit the prod domain's reputation.
export const PROD_SENDER_DOMAIN = 'theundergroundrailroad.world';

/** True when the DB name marks this as a staging environment. */
export function isStagingEnv(dbName?: string): boolean {
  return /staging/i.test(dbName || '');
}

/** Domain part of an email address, lower-cased ('' if none/malformed). */
export function domainOf(email?: string): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

/** Host of a URL, tolerant of malformed values (returns '' rather than throw). */
export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Fall back to a simple //host[/…] extraction for non-parseable inputs.
    const m = url.match(/\/\/([^/]+)/);
    return (m ? m[1] : '').toLowerCase();
  }
}

/**
 * Decide whether the email link bases leak into prod from a staging env.
 * Only flags a leak when BOTH conditions hold: this is a staging DB, AND a link
 * base resolves to the production host. In prod (or any non-staging env) it is
 * never a leak — prod is supposed to use the prod host.
 */
export function emailLinksLeakAcrossEnv(env: EmailEnvSnapshot): EmailIsolationVerdict {
  const staging = isStagingEnv(env.dbName);
  const appHost = hostOf(env.appUrl);
  const baseHost = hostOf(env.emailPublicBaseUrl);
  const fromDomain = domainOf(env.fromAddress);
  const offenders = [
    appHost === PROD_EMAIL_HOST ? 'APP_URL' : null,
    baseHost === PROD_EMAIL_HOST ? 'EMAIL_PUBLIC_BASE_URL' : null,
    // Sending as the bare prod domain from staging shares prod's reputation.
    // The staging subdomain (staging.theundergroundrailroad.world) is fine —
    // only the exact prod sending domain is a leak.
    fromDomain === PROD_SENDER_DOMAIN ? 'EMAIL_FROM_ADDRESS' : null,
  ].filter(Boolean) as string[];

  if (staging && offenders.length > 0) {
    return {
      isStaging: true,
      leaksToProd: true,
      reason: `${offenders.join(' + ')} resolve to production (host ${PROD_EMAIL_HOST} / sender @${PROD_SENDER_DOMAIN}) from a staging DB — email would leak users/reputation into production.`,
    };
  }
  return {
    isStaging: staging,
    leaksToProd: false,
    reason: staging
      ? 'staging email link base is isolated from prod'
      : 'not a staging environment — prod host is expected',
  };
}
