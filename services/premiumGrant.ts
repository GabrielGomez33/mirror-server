// services/premiumGrant.ts
// ----------------------------------------------------------------------------
// Single source of truth for granting a user PERMANENT premium. Premium-gated
// features read tier from `user_subscriptions` via the subscription service, so
// we upsert tier=premium/status=active there ('active' alone confers the tier —
// no period_end needed, which also sidesteps the MySQL TIMESTAMP 2038 ceiling)
// and bust the 5-minute subscription cache so it takes effect on the next
// request. The row CASCADE-deletes with the user.
//
// Used by the intake simulation (sim users) and the demo-account provisioner
// (trial accounts) — both go through here so the grant can never drift.
// ----------------------------------------------------------------------------

import { DB } from '../db';
import { mirrorRedis } from '../config/redis';

export async function grantPermanentPremium(userId: number): Promise<void> {
  try {
    await DB.query(
      `INSERT INTO user_subscriptions (user_id, tier, status, provider)
       VALUES (?, 'premium', 'active', 'manual')
       ON DUPLICATE KEY UPDATE tier = 'premium', status = 'active', provider = 'manual',
         cancelled_at = NULL, grace_period_end = NULL, cancel_reason = NULL, updated_at = CURRENT_TIMESTAMP`,
      [userId],
    );
  } catch (e) {
    throw new Error(`failed to grant premium to user ${userId}: ${(e as Error)?.message || e}`);
  }
  // Best-effort cache bust so the gate sees premium on the very next request.
  try { await mirrorRedis.del(`subscription:${userId}`); } catch { /* cache optional */ }
}
