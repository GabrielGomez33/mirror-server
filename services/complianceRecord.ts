// services/complianceRecord.ts
// ----------------------------------------------------------------------------
// Builds the machine-readable COMPLIANCE RECORD that the admin portal can hand
// to an entity (a school district, a state agency, an enterprise procurement /
// legal team) doing vendor privacy due-diligence. ONE concern: assemble a
// truthful, self-describing privacy posture.
//
// Drift-proof by construction: the conversion-analytics section is generated
// FROM the live schema (getConversionInventory / getRetentionStatus), so the
// "no personal data" claim reflects the real database, not a hand-kept doc. The
// account-data section describes the ALREADY-EXISTING data-subject-rights
// machinery (export + deletion + consent), referenced by real endpoint.
//
// This is Mirror's own self-attestation — NOT a third-party certification. The
// human-readable companion is docs/COMPLIANCE.md.
// ----------------------------------------------------------------------------

import {
  getConversionInventory,
  getRetentionStatus,
  CONVERSION_RETENTION_DAYS,
  type ConversionInventory,
  type RetentionStatus,
} from './conversionAnalytics';

// Bump when the disclosure's substance changes. Date-based, human-legible.
export const COMPLIANCE_POLICY_VERSION = '2026-09-01';

// The regimes this posture is built to satisfy (strictest superset).
export const COMPLIANCE_REGIMES = [
  'GDPR (EU/EEA)',
  'UK-GDPR',
  'CCPA/CPRA (California)',
  'US state privacy laws (VCDPA, CPA, CTDPA, UCPA, TDPSA)',
];

export interface ComplianceRecord {
  document: string;
  attestation: string;
  policyVersion: string;
  generatedAt: string;
  regimes: string[];
  conversionAnalytics: {
    purpose: string;
    identityModel: 'anonymous+aggregate';
    noPersonalData: boolean;
    lawfulBasis: string;
    consentPosture: string;
    dataSubjectScope: string;
    inventory: ConversionInventory;
    retention: RetentionStatus;
  };
  accountData: {
    description: string;
    categories: string[];
    dataSubjectRights: Record<string, string>;
    retention: string;
    downstreamProcessors: string[];
  };
  privacySignals: Record<string, string>;
}

/**
 * Assemble the live compliance record. `noPersonalData` for the funnel is a
 * COMPUTED fact from the live schema (no PII-shaped column AND no users FK), not
 * an assertion — if a future migration broke it, this flips to false and the CI
 * schema-guard test fails first.
 */
export async function buildComplianceRecord(): Promise<ComplianceRecord> {
  const [inventory, retention] = await Promise.all([
    getConversionInventory(),
    getRetentionStatus(),
  ]);
  const noPersonalData = inventory.piiSuspectColumns.length === 0 && !inventory.hasUserForeignKey;

  return {
    document: 'Mirror — Privacy & Data-Handling Disclosure',
    attestation:
      'Self-attested by Mirror; generated from the live production schema at request time. ' +
      'Not a third-party certification.',
    policyVersion: COMPLIANCE_POLICY_VERSION,
    generatedAt: new Date().toISOString(),
    regimes: COMPLIANCE_REGIMES,
    conversionAnalytics: {
      purpose:
        'Measure anonymous acquisition-funnel drop-off (landing → signup → intake → first value → premium) to improve conversion.',
      identityModel: 'anonymous+aggregate',
      noPersonalData,
      lawfulBasis:
        'No personal data is processed (anonymous, aggregate). Where local law treats an ephemeral ' +
        'session token as personal data, the basis is legitimate interest in measuring and improving the service; ' +
        'Global Privacy Control and Do-Not-Track signals suppress collection client-side.',
      consentPosture:
        'Events carry no account id and no PII; the session token is a random, ephemeral, per-session value ' +
        '(sessionStorage, not a cookie) used only to correlate stages within one anonymous session. GPC/DNT honored.',
      dataSubjectScope:
        'Out of scope for access/erasure requests: the table holds no personal data and cannot be linked to a data subject.',
      inventory,
      retention,
    },
    accountData: {
      description:
        'Personal data tied to an authenticated account is stored separately from analytics and is fully subject ' +
        'to data-subject rights.',
      categories: [
        'account (email, username)',
        'entry intake (birth date/time/place, preliminary results)',
        'core intake (per-step progress, results)',
        'subscription + usage',
        'journal entries',
        'group memberships',
      ],
      dataSubjectRights: {
        access_portability:
          'GET /mirror/api/user/export — authenticated, self-scoped structured JSON export across all account data sections.',
        erasure:
          'DELETE /mirror/api/auth/delete-account — authenticated, self-scoped transactional purge across all account tables, ' +
          'with post-delete footprint verification.',
        downstream_erasure:
          'Account deletion notifies the downstream Dina service to purge mirror-module artifacts.',
        consent_records:
          'user_consent table records terms + privacy acceptance, versioned, with timestamp / IP / user-agent.',
      },
      retention:
        `Account data is retained for the life of the account; auth tokens are purged nightly; ` +
        `anonymous conversion events are retained ${CONVERSION_RETENTION_DAYS} days then deleted.`,
      downstreamProcessors: ['Dina (analysis; purged on account deletion)'],
    },
    privacySignals: {
      globalPrivacyControl: 'Honored — client suppresses conversion analytics when GPC is set.',
      doNotTrack: 'Honored — client suppresses conversion analytics when DNT is set.',
    },
  };
}
