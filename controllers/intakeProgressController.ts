// controllers/intakeProgressController.ts
// ----------------------------------------------------------------------------
// HTTP layer for CORE per-step intake progress. Thin: it validates input,
// resolves the user from the JWT (req.user.id — never a param/body), and
// delegates all state to services/intakeCompletion. Mounted behind verifyToken
// in routes/intake.ts. There is no :userId param here, so no IDOR surface —
// a user can only ever read/mutate their own progress.
// ----------------------------------------------------------------------------

import type { RequestHandler } from 'express';
import {
  getProgress,
  getStepDraft,
  saveStepDraft,
  completeStep,
  isCoreStep,
  isIntakeComplete,
  DraftTooLargeError,
} from '../services/intakeCompletion';

function requireSelf(req: Parameters<RequestHandler>[0]): number | null {
  const id = Number(req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /mirror/api/intake/progress — the five steps + derived completion. */
export const getProgressHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }
  try {
    const steps = await getProgress(userId);
    const intakeCompleted = isIntakeComplete(
      steps.filter((s) => s.status === 'completed').map((s) => s.step)
    );
    res.json({ success: true, steps, intakeCompleted });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load intake progress.' });
  }
};

/**
 * GET /mirror/api/intake/progress/:step — read ONE step's saved draft + status,
 * for resuming a partially-filled step (server-backed, cross-device). The user
 * is req.user.id (no :userId), and :step is allowlisted before any SQL, so there
 * is no IDOR and no enum-injection surface.
 */
export const getProgressStepHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }
  const step = req.params.step;
  if (!isCoreStep(step)) {
    res.status(400).json({ success: false, error: 'Unknown intake step.' });
    return;
  }
  try {
    const draft = await getStepDraft(userId, step);
    res.json({ success: true, ...draft });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load intake draft.' });
  }
};

/** PUT /mirror/api/intake/progress/:step — save a resumable draft (in_progress). */
export const putProgressStepHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }
  const step = req.params.step;
  if (!isCoreStep(step)) {
    res.status(400).json({ success: false, error: 'Unknown intake step.' });
    return;
  }
  try {
    await saveStepDraft(userId, step, (req.body as { draftState?: unknown })?.draftState);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof DraftTooLargeError) {
      res.status(413).json({ success: false, error: 'Draft too large.' });
      return;
    }
    res.status(500).json({ success: false, error: 'Failed to save intake draft.' });
  }
};

/** POST /mirror/api/intake/progress/:step/complete — mark step done + rederive. */
export const completeProgressStepHandler: RequestHandler = async (req, res) => {
  const userId = requireSelf(req);
  if (userId === null) {
    res.status(401).json({ success: false, error: 'Unauthenticated.' });
    return;
  }
  const step = req.params.step;
  if (!isCoreStep(step)) {
    res.status(400).json({ success: false, error: 'Unknown intake step.' });
    return;
  }
  try {
    const { steps, intakeCompleted } = await completeStep(userId, step);
    res.json({ success: true, steps, intakeCompleted });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to complete intake step.' });
  }
};
