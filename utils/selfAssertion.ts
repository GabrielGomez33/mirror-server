// utils/selfAssertion.ts
// ----------------------------------------------------------------------------
// PURE decision logic for user-scoped IDOR guards. No Express, no DB, no
// side effects — so it is unit-testable in isolation and cannot be broken by
// import-time environment coupling. The middleware in authMiddleware.ts wires
// these verdicts to an HTTP response + security log; the RULES live here.
// ----------------------------------------------------------------------------

/**
 * Coerce an unknown to a valid user id, or null. A valid user id is a POSITIVE
 * integer (users.id is AUTO_INCREMENT starting at 1). This deliberately rejects
 * 0, negatives, non-integers, NaN, and — critically — `null`/`''`, which
 * `Number()` would otherwise coerce to the finite value 0 and let slip through.
 */
export function toUserId(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * True iff `claimed` refers to the same user as the authenticated `selfId`.
 * Both must be valid user ids (fail closed on either being invalid). Used for
 * :param user ids that MUST equal the caller.
 */
export function paramMatchesSelf(selfId: unknown, claimed: unknown): boolean {
  const s = toUserId(selfId);
  const c = toUserId(claimed);
  return s !== null && c !== null && s === c;
}

export type BodyIdVerdict = 'allow' | 'reject' | 'unauth';

/**
 * Verdict for an OPTIONAL body user id:
 *   - 'unauth' : no valid authenticated user id -> 401.
 *   - 'allow'  : body id absent (handler will use req.user.id) OR present and
 *                equal to selfId.
 *   - 'reject' : body id present and NOT a valid id equal to selfId -> 403
 *                (tampering / malformed).
 */
export function bodyIdVerdict(selfId: unknown, rawBodyId: unknown): BodyIdVerdict {
  const s = toUserId(selfId);
  if (s === null) return 'unauth';
  if (rawBodyId === undefined || rawBodyId === null) return 'allow';
  const c = toUserId(rawBodyId);
  return c !== null && c === s ? 'allow' : 'reject';
}
