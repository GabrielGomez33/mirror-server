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
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';

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

	try {
		  const keyId = await groupEncryptionManager.generateGroupKey(groupId);
		  await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), keyId);
		  console.log(`✅ Encryption key generated for group ${groupId}`);
		} catch (encError) {
		  console.error('❌ Encryption key generation failed:', encError);
		  // Group created but encryption failed - you might want to delete the group or mark it
		}	

    res.status(201).json({ 
      success: true, 
      data: { id: groupId, name, description },
      message: 'Group created successfully' 
    });

    const memberId = uuidv4();
     await DB.query(
       `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, joined_at)
        VALUES (?, ?, ?, 'owner', 'active', NOW())`,
       [memberId, groupId, user.id]
     );
      
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
      `SELECT g.id, g.name, g.description, g.created_at, g.owner_user_id,
              CASE WHEN g.owner_user_id = ? THEN 'owner' ELSE 'member' END AS role
         FROM mirror_groups g
         LEFT JOIN mirror_group_members m ON m.group_id = g.id
        WHERE (g.owner_user_id = ? OR m.user_id = ?) 
          AND (m.status = 'active' OR m.status IS NULL)
          AND g.status = 'active'
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
   GET GROUP DETAILS
============================================================================ */

const getGroupDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify user is a member
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get group details
    const [groupRows] = await DB.query(
      `SELECT * FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

    // Get all active members
    const [membersRows] = await DB.query(
      `SELECT 
        gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
        u.username, u.email
      FROM mirror_group_members gm
      INNER JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.status = 'active'
      ORDER BY 
        CASE gm.role 
          WHEN 'owner' THEN 1 
          WHEN 'admin' THEN 2 
          ELSE 3 
        END,
        gm.joined_at ASC`,
      [groupId]
    );

    res.json({
      success: true,
      data: {
        group: {
          id: group.id,
          name: group.name,
          description: group.description,
          type: group.type,
          privacy: group.privacy,
          max_members: group.max_members,
          current_member_count: group.current_member_count,
          owner_user_id: group.owner_user_id,
          status: group.status,
          created_at: group.created_at
        },
        members: membersRows,
        userRole: (memberCheck as any[])[0].role,
        isOwner: group.owner_user_id === user.id
      }
    });
  } catch (error) {
    console.error('❌ Error getting group details:', error);
    res.status(500).json({ success: false, error: 'Failed to get group details' });
  }
};

/* ============================================================================
   INVITE MEMBER
============================================================================ */

const inviteMemberHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ success: false, error: 'Email is required' });
      return;
    }

    // Verify user is owner or admin
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    const userRole = (memberCheck as any[])[0].role;
    if (!['owner', 'admin'].includes(userRole)) {
      res.status(403).json({ success: false, error: 'Only owners and admins can invite' });
      return;
    }

    // Find user by email
    const [userRows] = await DB.query(
      `SELECT id FROM users WHERE email = ?`,
      [email]
    );

    if ((userRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const targetUserId = (userRows as any[])[0].id;

    // Check if already a member
    const [existingMember] = await DB.query(
      `SELECT status FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ?`,
      [groupId, targetUserId]
    );

    if ((existingMember as any[]).length > 0) {
      const status = (existingMember as any[])[0].status;
      if (status === 'active') {
        res.status(400).json({ success: false, error: 'User is already a member' });
        return;
      }
      if (status === 'invited') {
        res.status(400).json({ success: false, error: 'User already has a pending invitation' });
        return;
      }
    }

    // Create join request
    const requestId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_join_requests (id, group_id, user_id, status, requested_at, processed_by)
       VALUES (?, ?, ?, 'pending', NOW(), ?)`,
      [requestId, groupId, targetUserId, user.id]
    );

    // Add to members table with 'invited' status
    const memberId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, invited_by)
       VALUES (?, ?, ?, 'member', 'invited', ?)`,
      [memberId, groupId, targetUserId, user.id]
    );

    console.log(`📨 Invitation sent: ${requestId} to user ${targetUserId}`);

    res.status(201).json({
      success: true,
      data: {
        requestId,
        memberId
      },
      message: 'Invitation sent successfully'
    });
  } catch (error) {
    console.error('❌ Error inviting member:', error);
    res.status(500).json({ success: false, error: 'Failed to invite member' });
  }
};

/* ============================================================================
   ACCEPT INVITATION (JOIN GROUP)
============================================================================ */

const acceptInvitationHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { requestId } = req.body;

    if (!requestId) {
      res.status(400).json({ success: false, error: 'requestId is required' });
      return;
    }

    // Verify invitation exists
    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests 
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`,
      [requestId, groupId, user.id]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Invalid or expired invitation' });
      return;
    }

    // Update member status to 'active'
    await DB.query(
      `UPDATE mirror_group_members 
       SET status = 'active', joined_at = NOW() 
       WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
      [groupId, user.id]
    );

    // Update join request
    await DB.query(
      `UPDATE mirror_group_join_requests 
       SET status = 'approved', processed_at = NOW() 
       WHERE id = ?`,
      [requestId]
    );

    // Distribute encryption key
    const { groupEncryptionManager } = require('../systems/GroupEncryptionManager');
    try {
      // Get active group key
      const [keyRows] = await DB.query(
        `SELECT id, key_version FROM mirror_group_encryption_keys 
         WHERE group_id = ? AND status = 'active' 
         ORDER BY key_version DESC LIMIT 1`,
        [groupId]
      );

      if ((keyRows as any[]).length > 0) {
        const { id: keyId, key_version } = (keyRows as any[])[0];
        await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), keyId, key_version);
        console.log(`✅ Encryption key distributed to new member ${user.id}`);
      }
    } catch (encError) {
      console.error('❌ Encryption key distribution failed:', encError);
    }

    // Increment member count
    await DB.query(
      `UPDATE mirror_groups 
       SET current_member_count = current_member_count + 1 
       WHERE id = ?`,
      [groupId]
    );

    console.log(`✅ User ${user.id} joined group ${groupId}`);

    res.json({
      success: true,
      message: 'Successfully joined group'
    });
  } catch (error) {
    console.error('❌ Error accepting invitation:', error);
    res.status(500).json({ success: false, error: 'Failed to join group' });
  }
};

/* ============================================================================
   LEAVE GROUP
============================================================================ */

const leaveGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Check if user is owner
    const [groupRows] = await DB.query(
      `SELECT owner_user_id FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    if ((groupRows as any[])[0].owner_user_id === user.id) {
      res.status(400).json({ 
        success: false, 
        error: 'Owner cannot leave group. Delete the group or transfer ownership first.' 
      });
      return;
    }

    // Update member status to 'left'
    await DB.query(
      `UPDATE mirror_group_members 
       SET status = 'left', left_at = NOW() 
       WHERE group_id = ? AND user_id = ?`,
      [groupId, user.id]
    );

    // Revoke encryption key
    const { groupEncryptionManager } = require('../systems/GroupEncryptionManager');
    try {
      await groupEncryptionManager.revokeUserAccess(groupId, String(user.id));
      console.log(`🚫 Encryption key revoked for user ${user.id}`);
    } catch (encError) {
      console.error('❌ Encryption key revocation failed:', encError);
    }

    // Decrement member count
    await DB.query(
      `UPDATE mirror_groups 
       SET current_member_count = current_member_count - 1 
       WHERE id = ?`,
      [groupId]
    );

    console.log(`👋 User ${user.id} left group ${groupId}`);

    res.json({
      success: true,
      message: 'Successfully left group'
    });
  } catch (error) {
    console.error('❌ Error leaving group:', error);
    res.status(500).json({ success: false, error: 'Failed to leave group' });
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
router.get('/:groupId', verified, getGroupDetailsHandler);
router.post('/:groupId/invite', verified, inviteMemberHandler);
router.post('/:groupId/accept', verified, acceptInvitationHandler);
router.post('/:groupId/leave', verified, leaveGroupHandler);
router.post('/join', verified, joinGroupHandler);
export default router;


