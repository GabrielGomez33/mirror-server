// tests/conversionFunnel.test.ts
// Pure runtime proof for the conversion-funnel vocabulary + the ingest PII
// firewall. Run:  ts-node tests/conversionFunnel.test.ts  (exit 0 = pass)
//
// The load-bearing guarantee: sanitizeConversionEvent can NEVER emit anything
// but the six allowlisted, sanitized fields — so no PII or unknown key a client
// sends can ever be persisted. The adversarial "smuggling" case below is the
// compliance proof at the ingest boundary.

import {
  FUNNEL_STAGES,
  isFunnelStage,
  funnelStageOrder,
  sanitizeConversionEvent,
} from '../utils/conversionFunnel';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } };

// --- vocabulary --------------------------------------------------------------
ok(isFunnelStage('signup_completed'), 'known stage is a funnel stage');
ok(isFunnelStage('entry_first_value'), 'aha stage is a funnel stage');
ok(!isFunnelStage('haxor'), 'unknown stage rejected');
ok(!isFunnelStage(123 as any), 'non-string stage rejected');
ok(!isFunnelStage(''), 'empty stage rejected');
ok(funnelStageOrder('landing_view') === 0, 'landing is ordinal 0');
ok(funnelStageOrder('premium_activated') === FUNNEL_STAGES.length - 1, 'premium_activated is last');
ok(funnelStageOrder('nope') === -1, 'unknown stage order = -1');
ok(funnelStageOrder('entry_first_value') > funnelStageOrder('signup_completed'), 'funnel order is monotonic');

// --- sanitize: happy path ----------------------------------------------------
{
  const c = sanitizeConversionEvent({
    stage: 'signup_view',
    sessionToken: 'A1B2C3D4-e5f6-7788-99aa-bbccddeeff00',
    utmSource: 'instagram',
    utmMedium: 'paid_social',
    utmCampaign: 'launch-2026',
    surface: 'web',
  });
  ok(!!c, 'valid event sanitizes');
  ok(c!.stage === 'signup_view', 'stage preserved');
  ok(c!.sessionToken === 'a1b2c3d4-e5f6-7788-99aa-bbccddeeff00', 'uuid token lowercased + kept');
  ok(c!.utmSource === 'instagram' && c!.utmMedium === 'paid_social' && c!.utmCampaign === 'launch-2026', 'utm preserved');
  ok(c!.surface === 'web', 'surface preserved');
  ok(Object.keys(c!).sort().join(',') === 'sessionToken,stage,surface,utmCampaign,utmMedium,utmSource', 'exactly the six allowlisted keys');
}

// --- sanitize: rejects / defaults --------------------------------------------
ok(sanitizeConversionEvent({ stage: 'not_a_stage' }) === null, 'unknown stage -> null');
ok(sanitizeConversionEvent(null) === null, 'null -> null');
ok(sanitizeConversionEvent('nope' as any) === null, 'string -> null');
ok(sanitizeConversionEvent([] as any) === null, 'array -> null');
ok(sanitizeConversionEvent({}) === null, 'missing stage -> null');

{
  const c = sanitizeConversionEvent({ stage: 'dashboard_view', sessionToken: 'not-a-uuid', surface: 'hologram', utmSource: 12 });
  ok(c!.sessionToken === null, 'invalid session token -> null');
  ok(c!.surface === null, 'invalid surface -> null');
  ok(c!.utmSource === null, 'non-string utm -> null');
}

// --- sanitize: utm bounding + charset ----------------------------------------
{
  const c = sanitizeConversionEvent({ stage: 'landing_view', utmSource: '  ig<script>  ', utmCampaign: 'x'.repeat(500) });
  ok(c!.utmSource === 'igscript', 'utm strips non-slug chars (incl. angle brackets)');
  ok((c!.utmCampaign as string).length === 96, 'utm campaign capped at 96');
}

// --- THE COMPLIANCE PROOF: no PII / unknown key can pass through --------------
{
  const c = sanitizeConversionEvent({
    stage: 'signup_completed',
    // Everything below is hostile / PII and must be structurally dropped:
    email: 'victim@example.com',
    userId: 4242,
    user_id: 4242,
    ip: '203.0.113.7',
    ipAddress: '203.0.113.7',
    name: 'Jane Doe',
    displayName: 'Jane',
    birthDate: '1990-01-01',
    password: 'hunter2',
    photoDataUrl: 'data:image/png;base64,AAAA',
    metadata: { nested: 'secret' },
  } as any);
  ok(!!c, 'event with smuggled PII still sanitizes (on the valid stage)');
  const keys = Object.keys(c!);
  const forbidden = ['email', 'userId', 'user_id', 'ip', 'ipAddress', 'name', 'displayName', 'birthDate', 'password', 'photoDataUrl', 'metadata'];
  ok(forbidden.every((k) => !keys.includes(k)), 'NO PII / unknown key survives sanitize (compliance firewall)');
  ok(keys.length === 6, 'output is exactly the six allowlisted fields, nothing more');
  ok(!JSON.stringify(c).includes('victim@example.com'), 'no smuggled email anywhere in the output');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: conversionFunnel ${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} assertions failed`);
