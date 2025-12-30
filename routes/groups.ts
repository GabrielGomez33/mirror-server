// ============================================================================
// MIRRORGROUPS API ROUTES - UPDATED WITH DECLINE & MY-INVITATIONS
// ============================================================================
// File: server/routes/groups.ts
// ----------------------------------------------------------------------------
// CHANGES:
// 1. Added declineInvitationHandler - to decline invitations
// 2. Added getMyInvitationsHandler - to get user's pending invitations
// 3. Updated leaveGroupHandler - sends WebSocket notifications
// 4. Added routes: POST /:groupId/decline, GET /my-invitations
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { DB } from '../db';
import AuthMiddleware, { SecurityLevel } from '../middleware/authMiddleware';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';
import { publicAssessmentAggregator } from '../managers/PublicAssessmentAggregator';
import { groupDataExtractor, ShareableDataType } from '../services/GroupDataExtractor';
import { mirrorGroupNotifications } from '../systems/mirrorGroupNotifications';

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
   CREATE GROUP (WITH GOAL SUPPORT) - FIXED DUPLICATE MEMBER BUG
============================================================================ */

const createGroupHandler: RequestHandler = async (req, res) => {
  try {
    const { name, description, goal, goalMetadata } = req.body;
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    if (typeof name !== 'string' || name.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Invalid group name' });
      return;
    }

    const validGoals = ['therapy', 'conflict_resolution', 'mutual_understanding', 'team_building', 'personal_growth'];
    if (goal && !validGoals.includes(goal)) {
      res.status(400).json({
        success: false,
        error: 'Invalid goal. Must be one of: ' + validGoals.join(', ')
      });
      return;
    }

    const groupId = uuidv4();

    await DB.query(
      `INSERT INTO mirror_groups (
        id, owner_user_id, name, description, goal, goal_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        groupId,
        user.id,
        name.trim(),
        description ?? null,
        goal ?? 'mutual_understanding',
        goalMetadata ? JSON.stringify(goalMetadata) : null
      ]
    );

    const memberId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', NOW())
       ON DUPLICATE KEY UPDATE
         status = 'active',
         role = 'owner',
         joined_at = NOW()`,
      [memberId, groupId, user.id]
    );

    try {
      const keyId = await groupEncryptionManager.generateGroupKey(groupId);
      await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), keyId);
      console.log(`✅ Encryption key generated for group ${groupId} with goal: ${goal || 'mutual_understanding'}`);
    } catch (encError) {
      console.error('❌ Encryption key generation failed:', encError);
    }

    res.status(201).json({
      success: true,
      data: {
        id: groupId,
        name,
        description,
        goal: goal || 'mutual_understanding'
      },
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
      `SELECT g.id, g.name, g.description, g.goal, g.created_at, g.owner_user_id,
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

    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    const [groupRows] = await DB.query(
      `SELECT * FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

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
          goal: group.goal,
          goalMetadata: safeJsonParse(group.goal_metadata, null),
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
    const { email, userId, username } = req.body;

    if (!email && !userId && !username) {
      res.status(400).json({ success: false, error: 'Email, userId, or username is required' });
      return;
    }

    // Verify user is owner or admin
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`,
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

    // Find user by userId, username, or email
    let userRows: any[];
    if (userId) {
      const [rows] = await DB.query(`SELECT id, username FROM users WHERE id = ?`, [userId]);
      userRows = rows as any[];
    } else if (username) {
      const [rows] = await DB.query(`SELECT id, username FROM users WHERE username = ?`, [username]);
      userRows = rows as any[];
    } else {
      const [rows] = await DB.query(`SELECT id, username FROM users WHERE email = ?`, [email]);
      userRows = rows as any[];
    }

    if (userRows.length === 0) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const targetUserId = userRows[0].id;

    // Check existing membership - UPDATED: Also check for 'declined' status to allow re-invite
    const [existingMember] = await DB.query(
      `SELECT id, status FROM mirror_group_members WHERE group_id = ? AND user_id = ?`,
      [groupId, targetUserId]
    );

    if ((existingMember as any[]).length > 0) {
      const member = (existingMember as any[])[0];
      if (member.status === 'active') {
        res.status(400).json({ success: false, error: 'User is already a member' });
        return;
      }
      if (member.status === 'invited') {
        res.status(400).json({ success: false, error: 'User already has a pending invitation' });
        return;
      }
      // Re-invite removed/left/declined user
      await DB.query(
        `UPDATE mirror_group_members SET status = 'invited', invited_by = ?, joined_at = NULL WHERE id = ?`,
        [user.id, member.id]
      );
    } else {
      const memberId = uuidv4();
      await DB.query(
        `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, invited_by) VALUES (?, ?, ?, 'member', 'invited', ?)`,
        [memberId, groupId, targetUserId, user.id]
      );
    }

    // Handle existing pending request
    const [existingRequest] = await DB.query(
      `SELECT id FROM mirror_group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'`,
      [groupId, targetUserId]
    );

    let requestId: string;
    if ((existingRequest as any[]).length > 0) {
      requestId = (existingRequest as any[])[0].id;
      await DB.query(
        `UPDATE mirror_group_join_requests SET processed_by = ?, requested_at = NOW() WHERE id = ?`,
        [user.id, requestId]
      );
    } else {
      requestId = uuidv4();
      await DB.query(
        `INSERT INTO mirror_group_join_requests (id, group_id, user_id, status, requested_at, processed_by) VALUES (?, ?, ?, 'pending', NOW(), ?)`,
        [requestId, groupId, targetUserId, user.id]
      );
    }

    // Get group name and inviter username for notification
    const [groupInfo] = await DB.query(`SELECT name FROM mirror_groups WHERE id = ?`, [groupId]);
    const [inviterInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
    const groupName = (groupInfo as any[])[0]?.name || 'Unknown Group';
    const inviterName = (inviterInfo as any[])[0]?.username || 'Someone';

    // Send WebSocket notification to invitee
    await mirrorGroupNotifications.notifyGroupInvite({
      inviteeUserId: String(targetUserId),
      inviterName: inviterName,
      groupId: groupId,
      groupName: groupName,
      inviteCode: requestId
    });

    console.log(`📨 Invitation sent: ${requestId} to user ${targetUserId}`);
    res.status(201).json({ success: true, data: { requestId }, message: 'Invitation sent successfully' });
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
    try {
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

    // Get group members and new member info for notification
    const [groupInfo] = await DB.query(`SELECT name FROM mirror_groups WHERE id = ?`, [groupId]);
    const [userInfo] = await DB.query(`SELECT username, email FROM users WHERE id = ?`, [user.id]);
    const [membersRows] = await DB.query(
      `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active'`,
      [groupId]
    );

    const groupName = (groupInfo as any[])[0]?.name || 'Unknown Group';
    const newMemberInfo = {
      userId: String(user.id),
      userName: (userInfo as any[])[0]?.username || 'Unknown'
    };

    // Notify all members that a new member joined
    await mirrorGroupNotifications.notifyMemberJoined(
      membersRows as any[],
      newMemberInfo,
      groupName
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
   DECLINE INVITATION
============================================================================ */

const declineInvitationHandler: RequestHandler = async (req, res) => {
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

    console.log(`🚫 User ${user.id} declining invitation ${requestId} for group ${groupId}`);

    // Verify invitation exists and belongs to this user
    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`,
      [requestId, groupId, user.id]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Invalid or expired invitation' });
      return;
    }

    // DELETE the join request instead of updating
    await DB.query(
      `DELETE FROM mirror_group_join_requests WHERE id = ?`,
      [requestId]
    );

    // DELETE the member record (allows fresh re-invite later)
    await DB.query(
      `DELETE FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
      [groupId, user.id]
    );

    console.log(`✅ User ${user.id} declined invitation to group ${groupId}`);

    res.json({
      success: true,
      message: 'Invitation declined successfully'
    });
  } catch (error) {
    console.error('❌ Error declining invitation:', error);
    res.status(500).json({ success: false, error: 'Failed to decline invitation' });
  }
};

/* ============================================================================
   NEW: GET MY INVITATIONS
============================================================================ */

const getMyInvitationsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    console.log(`📨 Fetching pending invitations for user ${user.id}`);

    // Get all pending invitations for this user
    const [invitations] = await DB.query(
      `SELECT
        jr.id as request_id,
        jr.group_id,
        g.name as group_name,
        g.description as group_description,
        u.username as inviter_username,
        jr.processed_by as inviter_id,
        jr.requested_at,
        jr.status
       FROM mirror_group_join_requests jr
       JOIN mirror_groups g ON jr.group_id = g.id
       LEFT JOIN users u ON jr.processed_by = u.id
       WHERE jr.user_id = ? AND jr.status = 'pending'
       ORDER BY jr.requested_at DESC`,
      [user.id]
    );

    console.log(`✅ Found ${(invitations as any[]).length} pending invitations for user ${user.id}`);

    res.json({
      success: true,
      data: {
        invitations: invitations
      }
    });
  } catch (error) {
    console.error('❌ Error fetching invitations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch invitations' });
  }
};

/* ============================================================================
   LEAVE GROUP - UPDATED WITH NOTIFICATIONS
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
      `SELECT owner_user_id, name FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

    if (group.owner_user_id === user.id) {
      res.status(400).json({
        success: false,
        error: 'Owner cannot leave group. Delete the group or transfer ownership first.'
      });
      return;
    }

    // Get user info for notification
    const [userInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
    const userName = (userInfo as any[])[0]?.username || 'Unknown';

    // Get remaining members for notification (before removing this user)
    const [membersRows] = await DB.query(
      `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active' AND gm.user_id != ?`,
      [groupId, user.id]
    );

    // Update member status to 'left'
    await DB.query(
      `UPDATE mirror_group_members
       SET status = 'left', left_at = NOW()
       WHERE group_id = ? AND user_id = ?`,
      [groupId, user.id]
    );

    // Revoke encryption key
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

    // Send WebSocket notification to remaining members
    await mirrorGroupNotifications.notifyMemberLeft(
      membersRows as any[],
      { userId: String(user.id), userName: userName },
      group.name
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
   SHARE DATA TO GROUP (PHASE 2 COMPLETE)
============================================================================ */

const shareDataHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const {
      dataTypes,
      dataType,
      consentText = 'I consent to share my assessment data with this group'
    } = req.body;

    const typesToShare: ShareableDataType[] = Array.isArray(dataTypes)
      ? dataTypes
      : (dataType ? [dataType] : ['full_profile']);

    const validDataTypes: ShareableDataType[] = [
      'personality', 'cognitive', 'facial', 'voice', 'astrological', 'full_profile'
    ];

    const invalidTypes = typesToShare.filter(t => !validDataTypes.includes(t as ShareableDataType));
    if (invalidTypes.length > 0) {
      res.status(400).json({
        success: false,
        error: `Invalid data type(s): ${invalidTypes.join(', ')}. Valid types: ${validDataTypes.join(', ')}`
      });
      return;
    }

    console.log(`📤 User ${user.id} sharing data with group ${groupId}: ${typesToShare.join(', ')}`);

    const [memberCheck] = await DB.query(
      `SELECT role, status FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({
        success: false,
        error: 'Not an active member of this group'
      });
      return;
    }

    const [keyRows] = await DB.query(
      `SELECT id, key_version FROM mirror_group_encryption_keys
       WHERE group_id = ? AND status = 'active'
       ORDER BY key_version DESC LIMIT 1`,
      [groupId]
    );

    if ((keyRows as any[]).length === 0) {
      res.status(500).json({
        success: false,
        error: 'No active encryption key for this group'
      });
      return;
    }

    const keyId = (keyRows as any[])[0].id;
    const keyVersion = (keyRows as any[])[0].key_version;

    const extractionResult = await groupDataExtractor.extractData({
      userId: user.id,
      dataTypes: typesToShare as ShareableDataType[]
    });

    if (!extractionResult.success || !extractionResult.data || extractionResult.data.length === 0) {
      res.status(400).json({
        success: false,
        error: extractionResult.error || 'No assessment data available to share.'
      });
      return;
    }

    const shareResults: any[] = [];
    const shareErrors: any[] = [];

    for (const extractedData of extractionResult.data) {
      try {
        const [existingShare] = await DB.query(
          `SELECT id, shared_at FROM mirror_group_shared_data
           WHERE group_id = ? AND user_id = ? AND data_type = ?
           ORDER BY shared_at DESC LIMIT 1`,
          [groupId, user.id, extractedData.dataType]
        );

        const alreadyShared = (existingShare as any[]).length > 0;

        const dataBuffer = Buffer.from(JSON.stringify(extractedData.data));
        const encryptedPackage = await groupEncryptionManager.encryptForGroup(dataBuffer, keyId);

        const consentSignature = crypto
          .createHash('sha256')
          .update(`${user.id}-${groupId}-${extractedData.dataType}-${consentText}-${Date.now()}`)
          .digest('hex');

        const encryptionMetadata = {
          keyId,
          keyVersion,
          algorithm: encryptedPackage.algorithm,
          encryptedAt: new Date().toISOString()
        };

        if (alreadyShared) {
          await DB.query(
            `UPDATE mirror_group_shared_data
             SET encrypted_data = ?, encryption_metadata = ?, consent_signature = ?,
                 data_version = ?, shared_at = NOW()
             WHERE group_id = ? AND user_id = ? AND data_type = ?`,
            [encryptedPackage.encrypted, JSON.stringify(encryptionMetadata),
             consentSignature, extractedData.dataVersion, groupId, user.id, extractedData.dataType]
          );
        } else {
          await DB.query(
            `INSERT INTO mirror_group_shared_data
             (group_id, user_id, data_type, encrypted_data, encryption_metadata, consent_signature, data_version)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [groupId, user.id, extractedData.dataType, encryptedPackage.encrypted,
             JSON.stringify(encryptionMetadata), consentSignature, extractedData.dataVersion]
          );
        }

        shareResults.push({
          dataType: extractedData.dataType,
          status: alreadyShared ? 'updated' : 'created',
          consentSignature: consentSignature.substring(0, 8) + '...'
        });

      } catch (error) {
        console.error(`❌ Error sharing ${extractedData.dataType}:`, error);
        shareErrors.push({ dataType: extractedData.dataType, error: (error as Error).message });
      }
    }

    try {
      const analysisJobId = uuidv4();
      await DB.query(
        `INSERT INTO mirror_group_analysis_queue
         (id, group_id, analysis_type, priority, status, trigger_event, parameters, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
        [analysisJobId, groupId, 'data_update', 7, 'pending', 'new_data_share',
         JSON.stringify({ userId: user.id, dataTypes: typesToShare, timestamp: new Date().toISOString() })]
      );
    } catch (queueError) {
      console.error('❌ Failed to queue analysis:', queueError);
    }

    res.json({
      success: true,
      message: `Successfully shared ${shareResults.length} data type(s) with group`,
      shares: shareResults,
      errors: shareErrors.length > 0 ? shareErrors : undefined,
      cached: extractionResult.cached
    });

  } catch (error) {
    console.error('❌ Error sharing data with group:', error);
    res.status(500).json({ success: false, error: 'Failed to share data with group' });
  }
};

/* ============================================================================
   GET SHARED DATA (PHASE 2) - DECRYPTION
============================================================================ */

const getSharedDataHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    const [sharedData] = await DB.query(
      `SELECT sd.id, sd.user_id, sd.data_type, sd.encrypted_data, sd.encryption_metadata,
              sd.shared_at, sd.consent_signature, sd.data_version, u.username, u.email, gm.role as member_role
       FROM mirror_group_shared_data sd
       JOIN users u ON u.id = sd.user_id
       JOIN mirror_group_members gm ON gm.user_id = sd.user_id AND gm.group_id = sd.group_id
       WHERE sd.group_id = ? AND gm.status = 'active'
       ORDER BY sd.shared_at DESC`,
      [groupId]
    );

    const decryptedShares = await Promise.all(
      (sharedData as any[]).map(async (share) => {
        try {
          const decryptedResult = await groupEncryptionManager.decryptForUser(
            share.encrypted_data, String(user.id), groupId
          );
          const decryptedData = JSON.parse(decryptedResult.data.toString('utf-8'));
          const encryptionMeta = typeof share.encryption_metadata === 'string'
            ? JSON.parse(share.encryption_metadata) : share.encryption_metadata;

          return {
            id: share.id, userId: share.user_id, username: share.username,
            memberRole: share.member_role, dataType: share.data_type, data: decryptedData,
            sharedAt: share.shared_at, dataVersion: share.data_version,
            encryptionInfo: { keyVersion: encryptionMeta.keyVersion, algorithm: encryptionMeta.algorithm }
          };
        } catch (error) {
          return {
            id: share.id, userId: share.user_id, username: share.username,
            memberRole: share.member_role, dataType: share.data_type, data: null,
            error: 'Unable to decrypt', sharedAt: share.shared_at
          };
        }
      })
    );

    res.json({
      success: true,
      data: {
        groupId,
        totalShares: decryptedShares.length,
        sharesByType: {
          personality: decryptedShares.filter(s => s.dataType === 'personality'),
          cognitive: decryptedShares.filter(s => s.dataType === 'cognitive'),
          facial: decryptedShares.filter(s => s.dataType === 'facial'),
          astrological: decryptedShares.filter(s => s.dataType === 'astrological'),
          voice: decryptedShares.filter(s => s.dataType === 'voice'),
          full_profile: decryptedShares.filter(s => s.dataType === 'full_profile')
        },
        allShares: decryptedShares
      }
    });

  } catch (error) {
    console.error('❌ Error retrieving shared data:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve shared data' });
  }
};

/* ============================================================================
   GET DATA SUMMARY
============================================================================ */

const getDataSummaryHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const summary = await groupDataExtractor.getDataSummary(user.id);

    res.json({
      success: summary.success,
      data: {
        userId: user.id,
        available: summary.available,
        unavailable: summary.unavailable,
        details: summary.details
      }
    });
  } catch (error) {
    console.error('❌ Error getting data summary:', error);
    res.status(500).json({ success: false, error: 'Failed to get data summary' });
  }
};

/* ============================================================================
   ROUTE REGISTRATION
============================================================================ */

const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;
const basicSecurity = AuthMiddleware.requireSecurityLevel(SecurityLevel.BASIC) as unknown as RequestHandler;

// Phase 1 routes
router.post('/create', verified, createGroupHandler);
router.get('/list', verified, listGroupsHandler);
router.get('/my-invitations', verified, getMyInvitationsHandler);  // Get pending invitations
router.get('/:groupId', verified, getGroupDetailsHandler);
router.post('/:groupId/invite', verified, inviteMemberHandler);
router.post('/:groupId/accept', verified, acceptInvitationHandler);
router.post('/:groupId/decline', verified, declineInvitationHandler);  // Decline invitation
router.post('/:groupId/leave', verified, leaveGroupHandler);
router.post('/join', verified, joinGroupHandler);

// Phase 2 routes
router.post('/:groupId/share-data', verified, basicSecurity, shareDataHandler);
router.get('/:groupId/shared-data', verified, getSharedDataHandler);
router.get('/data-summary', verified, getDataSummaryHandler);

export default router;
