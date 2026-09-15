// utils/passwordGen.ts
// ----------------------------------------------------------------------------
// Shared, dependency-light password generator that satisfies the registration
// policy (at least one upper, lower, digit, special; length 8–128). Used by the
// intake simulation (throwaway sim users) AND the demo-account provisioner
// (persistent trial accounts) — one source of truth so both stay policy-correct.
// Uses crypto.randomInt for unbiased selection; excludes visually ambiguous
// characters (0/O, 1/l/I) so a human can read/type a shared credential.
// ----------------------------------------------------------------------------

import crypto from 'node:crypto';

export function strongRandomPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%^&*()-_=+';
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const core = [pick(upper), pick(lower), pick(digit), pick(special)];
  const all = upper + lower + digit + special;
  for (let i = 0; i < 20; i++) core.push(pick(all));
  // Fisher–Yates shuffle so the guaranteed-class chars aren't always first.
  for (let i = core.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [core[i], core[j]] = [core[j], core[i]];
  }
  return core.join('');
}
