// ============================================================================
// DATE UTILITIES - Shared helpers for timestamp handling
// ============================================================================
// File: utils/dateUtils.ts
// Used by: controllers/truthstreamController.ts, workers/TruthStreamQueueProcessor.ts
// ============================================================================

/**
 * Round a date to the nearest hour for anonymity protection.
 * Used to anonymize review timestamps so reviewers can't be
 * identified by exact submission time.
 */
export function roundToNearestHour(date: Date | string): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}
