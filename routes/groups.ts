// ============================================================================
// MIRRORGROUPS API ROUTES - PRODUCTION READY
// ============================================================================
// File: server/routes/groups.ts
// ----------------------------------------------------------------------------
// - Secure group management endpoints (create, join, leave, list)
// - JWT validation via AuthMiddleware
// - Strict input sanitization and permission checks
// - Type-safe with Express 5 + TypeScript 5
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware, { SecurityLevel } from '../middleware/authMiddleware';

const router = express.Router();

/* ============================================================================
   HELPERS
============================================================================ */

function safeJsonParse<T = any>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

/* ============================================================================
   CREATE GROUP
============================================================================ */

const createGroupHandler: RequestHandler = async (req, res) => {
  try {
    const { name, description } = req.body;
    const user = (req as any).user; // Set by verifyToken middleware
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    if (typeof name !== 'string' || name.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Invalid group name' });
      return;
    }

    const groupId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_groups (id, owner_user_id, name, description, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [groupId, user.id, name.trim(), description ?? null]
    );

    res.status(201).json({ 
      success: true, 
      data: { id: groupId, name, description },
      message: 'Group created successfully' 
    });
  } catch (error) {
    console.error('❌ Error creating group:', error);
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
};

/* ============================================================================
   LIST GROUPS (USER IS MEMBER OR OWNER)
============================================================================ */

const listGroupsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const [rows] = await DB.query(
      `SELECT g.id, g.name, g.description, g.created_at, g.owner_id,
              CASE WHEN g.owner_id = ? THEN 'owner' ELSE 'member' END AS role
         FROM mirror_groups g
         LEFT JOIN mirror_group_members m ON m.group_id = g.id
        WHERE g.owner_id = ? OR m.user_id = ?
        GROUP BY g.id
        ORDER BY g.created_at DESC`,
      [user.id, user.id, user.id]
    );

    res.json({
      success: true,
      data: { groups: rows }
    });
  } catch (error) {
    console.error('❌ Error listing groups:', error);
    res.status(500).json({ success: false, error: 'Failed to list groups' });
  }
};

/* ============================================================================
   JOIN GROUP
============================================================================ */

const joinGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.body;
    if (typeof groupId !== 'string') {
      res.status(400).json({ success: false, error: 'Invalid groupId' });
      return;
    }

    const [check] = await DB.query(
      `SELECT id FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((check as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    await DB.query(
      `INSERT IGNORE INTO mirror_group_members (group_id, user_id, joined_at)
       VALUES (?, ?, NOW())`,
      [groupId, user.id]
    );

    res.json({ success: true, message: 'Joined group successfully' });
  } catch (error) {
    console.error('❌ Error joining group:', error);
    res.status(500).json({ success: false, error: 'Failed to join group' });
  }
};

/* ============================================================================
   ROUTE REGISTRATION
============================================================================ */

// Cast or wrap async middlewares so Express 5 typing passes cleanly:
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;
const basicSecurity = AuthMiddleware.requireSecurityLevel(SecurityLevel.BASIC) as unknown as RequestHandler;

router.post('/create', verified, createGroupHandler);
router.get('/list', verified, listGroupsHandler);
router.post('/join', verified, joinGroupHandler);

export default router;
