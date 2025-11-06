// ============================================================================
// MIRRORGROUPS API ROUTES - PRODUCTION READY (PHASE 1 + 2)
// ============================================================================
// File: server/routes/groups.ts
// ----------------------------------------------------------------------------
// - Secure group management endpoints (create, join, leave, list)
// - Data sharing endpoints for assessment aggregation
// - JWT validation via AuthMiddleware
// - Strict input sanitization and permission checks
// - Type-safe with Express 5 + TypeScript 5
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { DB } from '../db';
import AuthMiddleware, { SecurityLevel } from '../middleware/authMiddleware';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';
import { publicAssessmentAggregator } from '../managers/PublicAssessmentAggregator';

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
   CREATE GROUP (WITH GOAL SUPPORT)
============================================================================ */

const createGroupHandler: RequestHandler = async (req, res) => {
  try {
    const { name, description, goal, goalMetadata } = req.body;
    const user = (req as any).user; // Set by verifyToken middleware
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    if (typeof name !== 'string' || name.trim().length < 3) {
      res.status(400).json({ success: false, error: 'Invalid group name' });
      return;
    }

    // Validate goal if provided
    const validGoals = ['therapy', 'conflict_resolution', 'mutual_understanding', 'team_building', 'personal_growth'];
    if (goal && !validGoals.includes(goal)) {
      res.status(400).json({ 
        success: false, 
        error: 'Invalid goal. Must be one of: ' + validGoals.join(', ') 
      });
      return;
    }

    const groupId = uuidv4();
    
    // Create group with goal field
    await DB.query(
      `INSERT INTO mirror_groups (
        id, owner_user_id, name, description, goal, goal_metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        groupId, 
        user.id, 
        name.trim(), 
        description ?? null,
        goal ?? 'mutual_understanding', // Default goal
        goalMetadata ? JSON.stringify(goalMetadata) : null
      ]
    );

    // Create owner membership
    const memberId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', NOW())`,
      [memberId, groupId, user.id]
    );

    // Generate encryption key
    try {
      const keyId = await groupEncryptionManager.generateGroupKey(groupId);
      await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), keyId);
      console.log(`✅ Encryption key generated for group ${groupId} with goal: ${goal || 'mutual_understanding'}`);
    } catch (encError) {
      console.error('❌ Encryption key generation failed:', encError);
      // Group created but encryption failed - consider cleanup
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

    // Get group details including goal
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
   SHARE DATA TO GROUP (PHASE 2) - FIXED ENCRYPTION
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
      dataType = 'full_profile',  // Must be one of the enum values
      consentText = 'I consent to share my assessment data with this group'
    } = req.body;

    console.log(`📤 User ${user.id} sharing data with group ${groupId}`);

    // 1. Verify user is an active member
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

    // 2. Get the active group encryption key - using ACTUAL columns
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

    // 3. Check if user already shared this data type
    const [existingShare] = await DB.query(
      `SELECT id, shared_at FROM mirror_group_shared_data 
       WHERE group_id = ? AND user_id = ? AND data_type = ?
       ORDER BY shared_at DESC LIMIT 1`,
      [groupId, user.id, dataType]
    );

    const alreadyShared = (existingShare as any[]).length > 0;

    // 4. Aggregate user's assessments
    const aggregationResult = await publicAssessmentAggregator.aggregateForUser(user.id);
    
    if (!aggregationResult.success || !aggregationResult.data) {
      res.status(400).json({ 
        success: false, 
        error: 'No assessment data available to share. Please complete your Mirror assessments first.' 
      });
      return;
    }

    // 5. Prepare data based on dataType
    let dataToShare: any;
    
    switch (dataType) {
      case 'personality':
        dataToShare = aggregationResult.data.personality;
        break;
      case 'cognitive':
        dataToShare = aggregationResult.data.cognitive;
        break;
      case 'facial':
        dataToShare = aggregationResult.data.emotional;
        break;
      case 'astrological':
        dataToShare = aggregationResult.data.astrology;
        break;
      case 'voice':
        dataToShare = aggregationResult.data.communication;
        break;
      case 'full_profile':
      default:
        dataToShare = aggregationResult.data;
        break;
    }

    if (!dataToShare) {
      res.status(400).json({ 
        success: false, 
        error: `No ${dataType} data available to share` 
      });
      return;
    }

    // 6. Encrypt data for the group
    const dataBuffer = Buffer.from(JSON.stringify(dataToShare));
    const encryptedPackage = await groupEncryptionManager.encryptForGroup(dataBuffer, keyId);

    // 7. Generate consent signature
    const consentSignature = crypto
      .createHash('sha256')
      .update(`${user.id}-${groupId}-${dataType}-${consentText}-${Date.now()}`)
      .digest('hex');

    // 8. Prepare encryption metadata JSON
    const encryptionMetadata = {
      keyId,
      keyVersion,
      algorithm: encryptedPackage.algorithm,
      encryptedAt: new Date().toISOString()
    };

    // 9. Store or update - using ONLY existing columns
    if (alreadyShared) {
      // Update existing share
      await DB.query(
        `UPDATE mirror_group_shared_data 
         SET encrypted_data = ?, 
             encryption_metadata = ?,
             consent_signature = ?,
             data_version = ?,
             shared_at = NOW()
         WHERE group_id = ? AND user_id = ? AND data_type = ?`,
        [
          encryptedPackage.encrypted,
          JSON.stringify(encryptionMetadata),
          consentSignature,
          '2.0',
          groupId,
          user.id,
          dataType
        ]
      );
      console.log(`📝 Updated ${dataType} share for user ${user.id}`);
    } else {
      // Create new share - id will auto-generate with uuid()
      await DB.query(
        `INSERT INTO mirror_group_shared_data 
         (group_id, user_id, data_type, encrypted_data, encryption_metadata, consent_signature, data_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          groupId,
          user.id,
          dataType,
          encryptedPackage.encrypted,
          JSON.stringify(encryptionMetadata),
          consentSignature,
          '2.0'
        ]
      );
      console.log(`✅ New ${dataType} share created for user ${user.id}`);
    }

    res.json({
      success: true,
      message: alreadyShared ? 'Data share updated successfully' : 'Data shared with group successfully',
      dataType,
      consentSignature: consentSignature.substring(0, 8) + '...'
    });

  } catch (error) {
    console.error('❌ Error sharing data with group:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to share data with group',
      details: (error as Error).message
    });
  }
};

/* ============================================================================
   GET SHARED DATA (PHASE 2) - FIXED DECRYPTION
============================================================================ */

const getSharedDataHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // 1. Verify user is a member
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ 
        success: false, 
        error: 'Not a member of this group' 
      });
      return;
    }

    // 2. Get all shared data - using ACTUAL columns
    const [sharedData] = await DB.query(
      `SELECT 
        sd.id,
        sd.user_id,
        sd.data_type,
        sd.encrypted_data,
        sd.encryption_metadata,
        sd.shared_at,
        sd.consent_signature,
        sd.data_version,
        u.username,
        u.email,
        gm.role as member_role
       FROM mirror_group_shared_data sd
       JOIN users u ON u.id = sd.user_id
       JOIN mirror_group_members gm ON gm.user_id = sd.user_id AND gm.group_id = sd.group_id
       WHERE sd.group_id = ? AND gm.status = 'active'
       ORDER BY sd.shared_at DESC`,
      [groupId]
    );

    // 3. Decrypt data for the requesting user
    const decryptedShares = await Promise.all(
      (sharedData as any[]).map(async (share) => {
        try {
          // Decrypt the data
          const decryptedResult = await groupEncryptionManager.decryptForUser(
            share.encrypted_data,
            String(user.id),
            groupId
          );

          // Parse the decrypted data
          const decryptedString = decryptedResult.data.toString('utf-8');
          const decryptedData = JSON.parse(decryptedString);

          // Parse encryption metadata
          const encryptionMeta = typeof share.encryption_metadata === 'string' 
            ? JSON.parse(share.encryption_metadata) 
            : share.encryption_metadata;

          return {
            id: share.id,
            userId: share.user_id,
            username: share.username,
            memberRole: share.member_role,
            dataType: share.data_type,
            data: decryptedData,
            sharedAt: share.shared_at,
            dataVersion: share.data_version,
            encryptionInfo: {
              keyVersion: encryptionMeta.keyVersion,
              algorithm: encryptionMeta.algorithm
            }
          };
        } catch (error) {
          console.error(`Failed to decrypt share ${share.id}:`, error);
          return {
            id: share.id,
            userId: share.user_id,
            username: share.username,
            memberRole: share.member_role,
            dataType: share.data_type,
            data: null,
            error: 'Unable to decrypt',
            sharedAt: share.shared_at
          };
        }
      })
    );

    // 4. Group shares by data type
    const sharesByType = {
      personality: decryptedShares.filter(s => s.dataType === 'personality'),
      cognitive: decryptedShares.filter(s => s.dataType === 'cognitive'),
      facial: decryptedShares.filter(s => s.dataType === 'facial'),
      astrological: decryptedShares.filter(s => s.dataType === 'astrological'),
      voice: decryptedShares.filter(s => s.dataType === 'voice'),
      full_profile: decryptedShares.filter(s => s.dataType === 'full_profile')
    };

    res.json({
      success: true,
      data: {
        groupId,
        totalShares: decryptedShares.length,
        sharesByType,
        allShares: decryptedShares
      }
    });

  } catch (error) {
    console.error('❌ Error retrieving shared data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve shared data',
      details: (error as Error).message
    });
  }
};
/* ============================================================================
   ROUTE REGISTRATION
============================================================================ */

// Cast or wrap async middlewares so Express 5 typing passes cleanly:
const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;
const basicSecurity = AuthMiddleware.requireSecurityLevel(SecurityLevel.BASIC) as unknown as RequestHandler;

// Phase 1 routes
router.post('/create', verified, createGroupHandler);
router.get('/list', verified, listGroupsHandler);
router.get('/:groupId', verified, getGroupDetailsHandler);
router.post('/:groupId/invite', verified, inviteMemberHandler);
router.post('/:groupId/accept', verified, acceptInvitationHandler);
router.post('/:groupId/leave', verified, leaveGroupHandler);
router.post('/join', verified, joinGroupHandler);

// Phase 2 routes
router.post('/:groupId/share-data', verified, basicSecurity, shareDataHandler);
router.get('/:groupId/shared-data', verified, getSharedDataHandler);

export default router;
