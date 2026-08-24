// controllers/intakeEntryController.ts
// ----------------------------------------------------------------------------
// HTTP layer for the ENTRY ("initial") intake pipeline — the ~4-minute path
// that makes the app functional on day one. Separate from Core intake: it
// writes ONLY entry_intake_results + users.initial_intake_completed, and NEVER
// touches core_intake_progress or intake_completed. Mounted behind verifyToken;
// the user is req.user.id (never a body/param). See spec §5.1.
// ----------------------------------------------------------------------------

import type { RequestHandler } from 'express';
import { DB } from '../db';
import { validateEntrySubmit } from '../utils/entryIntakeValidation';
import { getEntryResult } from '../services/intakeReadModel';

function requireSelf(req: Parameters<RequestHandler>[0]): number | null {
  const id = Number(req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * POST /mirror/api/intake/entry/submit
 * Body: { personalityResult?, astrologyResult?, birthDate?, birthTime?,
 *         birthPlace?, displayName? }  (>=1 of personality/astrology required)
 * Idempotent upsert (UNIQUE user_id) + sets initial_intake_completed, atomically.
 */
export const submitEntryHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }

  const parsed = validateEntrySubmit(req.body);
  if (!parsed.ok) {
    res.status(400).json({ success: false, error: parsed.error });
    return;
  }
  const v = parsed.value;

  const conn = await DB.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO entry_intake_results
         (user_id, personality_result, astrology_result, birth_date, birth_time,
          birth_place, display_name, confidence, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'preliminary', 1)
       ON DUPLICATE KEY UPDATE
         personality_result = VALUES(personality_result),
         astrology_result   = VALUES(astrology_result),
         birth_date         = VALUES(birth_date),
         birth_time         = VALUES(birth_time),
         birth_place        = VALUES(birth_place),
         display_name       = VALUES(display_name),
         confidence         = 'preliminary',
         schema_version     = 1`,
      [
        userId,
        v.personalityResult === null ? null : JSON.stringify(v.personalityResult),
        v.astrologyResult === null ? null : JSON.stringify(v.astrologyResult),
        v.birthDate,
        v.birthTime,
        v.birthPlace,
        v.displayName,
      ]
    );
    await conn.query('UPDATE users SET initial_intake_completed = 1 WHERE id = ?', [userId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: 'Failed to save entry intake.' });
    return;
  } finally {
    conn.release();
  }

  try {
    const result = await getEntryResult(userId);
    res.json({ success: true, completed: true, result });
  } catch {
    // The write succeeded; a read-back failure should not fail the submit.
    res.json({ success: true, completed: true, result: null });
  }
};

/**
 * GET /mirror/api/intake/entry/status
 * -> { completed: boolean, result: EntryResult | null }
 */
export const getEntryStatusHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }
  try {
    const [rows] = await DB.query(
      'SELECT initial_intake_completed FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const flag = !!(rows as any[])[0]?.initial_intake_completed;
    const result = await getEntryResult(userId);
    res.json({ success: true, completed: flag || result !== null, result });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load entry status.' });
  }
};
