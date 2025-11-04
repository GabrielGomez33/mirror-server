// controllers/groupController.ts
// MirrorGroups Phase 1: Business logic - CORRECTED for actual database schema
// Matches actual schema with id, name, type+privacy, status enums, etc.

import { RequestHandler } from 'express';
import { DB } from '../db';
import crypto from 'crypto';
import { groupEncryptionManager } from '../systems/GroupEncryptionManager';

// ============================================================================
// TYPES - Matching actual schema
// ============================================================================

interface CreateGroupRequest {
  name: string;
  type?: 'family' | 'team' | 'friends' | 'community' | 'public';
  privacy?: 'private' | 'public';
  description?: string;
  max_members?: number;
}

interface InviteMemberRequest {
  email?: string;
  userId?: string;
  message?: string;
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

function validateGroupName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Group name is required' };
  }
  
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    return { valid: false, error: 'Group name must be at least 3 characters' };
  }
  if (trimmed.length > 255) {
    return { valid: false, error: 'Group name must be 255 characters or less' };
  }
  
  return { valid: true };
}
console.log('🔴🔴🔴 CORRECTED CONTROLLER RUNNING - VERSION 2.0 🔴🔴🔴');
console.log('🔴 User ID:', req.user!.id);
console.log('🔴 Group Name:', req.body.name);

function validateGroupType(type: string): { valid: boolean; error?: string } {
  const validTypes = ['family', 'team', 'friends', 'community', 'public'];
  if (!validTypes.includes(type)) {
    return { valid: false, error: `Group type must be one of: ${validTypes.join(', ')}` };
  }
  return { valid: true };
}

function validatePrivacy(privacy: string): { valid: boolean; error?: string } {
  if (!['private', 'public'].includes(privacy)) {
    return { valid: false, error: 'Privacy must be "private" or "public"' };
  }
  return { valid: true };
}

// ============================================================================
// GROUP CRUD HANDLERS
// ============================================================================

/**
 * Create a new group
 * POST /mirror/api/groups/create
 */
export const createGroupHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { 
      name, 
      type = 'family', 
      privacy = 'private',
      description, 
      max_members = 100 
    } = req.body as CreateGroupRequest;

    // Validate inputs
    const nameValidation = validateGroupName(name);
    if (!nameValidation.valid) {
      res.status(400).json({ error: nameValidation.error });
    }

    const typeValidation = validateGroupType(type);
    if (!typeValidation.valid) {
      res.status(400).json({ error: typeValidation.error });
    }

    const privacyValidation = validatePrivacy(privacy);
    if (!privacyValidation.valid) {
      res.status(400).json({ error: privacyValidation.error });
    }

    if (max_members < 2 || max_members > 100) {
      res.status(400).json({ error: 'max_members must be between 2 and 100' });
    }

    console.log(`📝 Creating group: ${name} (type: ${type}, privacy: ${privacy}) for user ${userId}`);

    // Start transaction
    await DB.query('START TRANSACTION');

    try {
      // Generate group ID
      const groupId = crypto.randomUUID();

      // Create group - using actual schema field names
      await DB.query(
        `INSERT INTO mirror_groups (
          id, name, description, type, privacy, max_members, 
          owner_user_id, current_member_count, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', NOW())`,
        [groupId, name.trim(), description || null, type, privacy, max_members, userId]
      );

      // Generate encryption key for group
      const keyId = await groupEncryptionManager.generateGroupKey(groupId);

      // Add creator as owner with status 'active'
      const memberId = crypto.randomUUID();
      await DB.query(
        `INSERT INTO mirror_group_members (
          id, group_id, user_id, role, status, joined_at
        ) VALUES (?, ?, ?, 'owner', 'active', NOW())`,
        [memberId, groupId, userId]
      );

      // Distribute key to owner
      await groupEncryptionManager.distributeKeyToMember(groupId, String(userId), keyId);

      // Commit transaction
      await DB.query('COMMIT');

      console.log(`✅ Group created successfully: ${groupId}`);

      // Return complete group data with actual schema fields
      res.status(201).json({
        success: true,
        group: {
          id: groupId,
          name: name.trim(),
          type,
          privacy,
          owner_user_id: userId,
          description,
          max_members,
          current_member_count: 1,
          status: 'active',
          created_at: new Date().toISOString()
        }
      });
    } catch (error) {
      await DB.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error creating group:', error);
    res.status(500).json({
      error: 'Failed to create group',
      details: (error as Error).message
    });
  }
};

/**
 * List user's groups
 * GET /mirror/api/groups/list
 */
export const listGroupsHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;

    console.log(`📋 Fetching groups for user ${userId}`);

    const [rows] = await DB.query(
      `SELECT 
        g.id,
        g.name,
        g.description,
        g.type,
        g.privacy,
        g.max_members,
        g.current_member_count,
        g.owner_user_id,
        g.status,
        g.created_at,
        g.updated_at,
        g.group_image_url,
        gm.role,
        gm.joined_at,
        gm.status as member_status
      FROM mirror_groups g
      INNER JOIN mirror_group_members gm ON g.id = gm.group_id
      WHERE gm.user_id = ? AND gm.status = 'active' AND g.status = 'active'
      ORDER BY gm.joined_at DESC`,
      [userId]
    );

    const groups = (rows as any[]).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      privacy: row.privacy,
      max_members: row.max_members,
      current_member_count: row.current_member_count,
      owner_user_id: row.owner_user_id,
      status: row.status,
      user_role: row.role,
      member_status: row.member_status,
      joined_at: row.joined_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      group_image_url: row.group_image_url,
      is_owner: row.owner_user_id === userId
    }));

    console.log(`✅ Found ${groups.length} groups for user ${userId}`);

    res.json({
      success: true,
      count: groups.length,
      groups
    });
  } catch (error) {
    console.error('❌ Error listing groups:', error);
    res.status(500).json({
      error: 'Failed to list groups',
      details: (error as Error).message
    });
  }
};

/**
 * Get group details
 * GET /mirror/api/groups/:groupId
 */
export const getGroupDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { groupId } = req.params;

    console.log(`📖 Fetching details for group ${groupId}, user ${userId}`);

    // Verify user is a member with status 'active'
    const [memberRows] = await DB.query(
      `SELECT role FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((memberRows as any[]).length === 0) {
      res.status(403).json({ error: 'You are not a member of this group' });
    }

    const userRole = (memberRows as any[])[0].role;

    // Get group details
    const [groupRows] = await DB.query(
      `SELECT * FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ error: 'Group not found' });
    }

    const group = (groupRows as any[])[0];

    // Get all active members
    const [membersRows] = await DB.query(
      `SELECT 
        gm.id as member_id,
        gm.user_id,
        gm.role,
        gm.status,
        gm.joined_at,
        gm.left_at,
        u.username,
        u.email
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

    console.log(`✅ Fetched details for group ${groupId}`);

    res.json({
      success: true,
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
        created_at: group.created_at,
        updated_at: group.updated_at,
        group_image_url: group.group_image_url,
        user_role: userRole,
        is_owner: group.owner_user_id === userId
      },
      members: (membersRows as any[]).map(m => ({
        member_id: m.member_id,
        user_id: m.user_id,
        username: m.username,
        email: m.email,
        role: m.role,
        status: m.status,
        joined_at: m.joined_at,
        left_at: m.left_at
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching group details:', error);
    res.status(500).json({
      error: 'Failed to fetch group details',
      details: (error as Error).message
    });
  }
};

/**
 * Invite member to group
 * POST /mirror/api/groups/:groupId/invite
 */
export const inviteMemberHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { groupId } = req.params;
    const { email, userId: inviteeUserId, message } = req.body as InviteMemberRequest;

    if (!email && !inviteeUserId) {
      res.status(400).json({ error: 'Either email or userId must be provided' });
    }

    console.log(`📨 Inviting member to group ${groupId} by user ${userId}`);

    // Verify user has permission to invite (owner or admin)
    const [memberRows] = await DB.query(
      `SELECT role FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );

    if ((memberRows as any[]).length === 0) {
      res.status(403).json({ error: 'You are not a member of this group' });
    }

    const userRole = (memberRows as any[])[0].role;
    if (!['owner', 'admin'].includes(userRole)) {
      res.status(403).json({ error: 'Only owners and admins can invite members' });
    }

    // Check group member limit
    const [groupRows] = await DB.query(
      `SELECT max_members, current_member_count FROM mirror_groups WHERE id = ?`,
      [groupId]
    );
    const { max_members, current_member_count } = (groupRows as any[])[0];

    if (current_member_count >= max_members) {
      res.status(400).json({ error: 'Group has reached maximum member limit' });
    }

    // Find user by email or userId
    let targetUserId: number;
    if (email) {
      const [userRows] = await DB.query(
        `SELECT id FROM users WHERE email = ?`,
        [email]
      );
      if ((userRows as any[]).length === 0) {
        res.status(404).json({ error: 'User not found with this email' });
      }
      targetUserId = (userRows as any[])[0].id;
    } else {
      targetUserId = parseInt(inviteeUserId!);
    }

    // Check if already a member
    const [existingRows] = await DB.query(
      `SELECT id, status FROM mirror_group_members 
       WHERE group_id = ? AND user_id = ?`,
      [groupId, targetUserId]
    );

    if ((existingRows as any[]).length > 0) {
      const status = (existingRows as any[])[0].status;
      if (status === 'active') {
        res.status(400).json({ error: 'User is already an active member of this group' });
      }
      if (status === 'invited') {
        res.status(400).json({ error: 'User already has a pending invitation' });
      }
    }

    // Create join request
    const requestId = crypto.randomUUID();
    await DB.query(
      `INSERT INTO mirror_group_join_requests (
        id, group_id, user_id, status, message, processed_by, requested_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, NOW())`,
      [requestId, groupId, targetUserId, message || `Invited by user ${userId}`, userId]
    );

    // Add to members table with status 'invited'
    const memberId = crypto.randomUUID();
    await DB.query(
      `INSERT INTO mirror_group_members (
        id, group_id, user_id, role, status, invited_by
      ) VALUES (?, ?, ?, 'member', 'invited', ?)`,
      [memberId, groupId, targetUserId, userId]
    );

    console.log(`✅ Invitation created: ${requestId}`);

    // TODO: Send notification to invited user (Phase 0 notification system)

    res.status(201).json({
      success: true,
      request_id: requestId,
      member_id: memberId,
      message: 'Invitation sent successfully'
    });
  } catch (error) {
    console.error('❌ Error inviting member:', error);
    res.status(500).json({
      error: 'Failed to invite member',
      details: (error as Error).message
    });
  }
};

/**
 * Accept group invitation / join group
 * POST /mirror/api/groups/:groupId/join
 */
export const joinGroupHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { groupId } = req.params;
    const { requestId } = req.body;

    console.log(`👥 User ${userId} joining group ${groupId}`);

    // Verify invitation exists and is pending
    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests 
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`,
      [requestId, groupId, userId]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    // Start transaction
    await DB.query('START TRANSACTION');

    try {
      // Update member status from 'invited' to 'active'
      await DB.query(
        `UPDATE mirror_group_members 
         SET status = 'active', joined_at = NOW() 
         WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
        [groupId, userId]
      );

      // Get active group key (latest version)
      const [keyRows] = await DB.query(
        `SELECT id, key_version FROM mirror_group_encryption_keys 
         WHERE group_id = ? AND status = 'active' 
         ORDER BY key_version DESC LIMIT 1`,
        [groupId]
      );

      if ((keyRows as any[]).length > 0) {
        const { id: keyId, key_version } = (keyRows as any[])[0];
        await groupEncryptionManager.distributeKeyToMember(groupId, String(userId), keyId, key_version);
      }

      // Update join request status
      await DB.query(
        `UPDATE mirror_group_join_requests 
         SET status = 'approved', processed_at = NOW() 
         WHERE id = ?`,
        [requestId]
      );

      // Increment member count
      await DB.query(
        `UPDATE mirror_groups 
         SET current_member_count = current_member_count + 1 
         WHERE id = ?`,
        [groupId]
      );

      await DB.query('COMMIT');

      console.log(`✅ User ${userId} joined group ${groupId}`);

      res.json({
        success: true,
        message: 'Successfully joined group'
      });
    } catch (error) {
      await DB.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error joining group:', error);
    res.status(500).json({
      error: 'Failed to join group',
      details: (error as Error).message
    });
  }
};

/**
 * Leave group
 * POST /mirror/api/groups/:groupId/leave
 */
export const leaveGroupHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { groupId } = req.params;

    console.log(`👋 User ${userId} leaving group ${groupId}`);

    // Check if user is the owner
    const [groupRows] = await DB.query(
      `SELECT owner_user_id FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ error: 'Group not found' });
    }

    if ((groupRows as any[])[0].owner_user_id === userId) {
      res.status(400).json({ 
        error: 'Owner cannot leave group. Delete the group or transfer ownership first.' 
      });
    }

    // Start transaction
    await DB.query('START TRANSACTION');

    try {
      // Update member status to 'left'
      await DB.query(
        `UPDATE mirror_group_members 
         SET status = 'left', left_at = NOW() 
         WHERE group_id = ? AND user_id = ?`,
        [groupId, userId]
      );

      // Revoke encryption key access
      await groupEncryptionManager.revokeUserAccess(groupId, String(userId));

      // Decrement member count
      await DB.query(
        `UPDATE mirror_groups 
         SET current_member_count = current_member_count - 1 
         WHERE id = ?`,
        [groupId]
      );

      await DB.query('COMMIT');

      console.log(`✅ User ${userId} left group ${groupId}`);

      res.json({
        success: true,
        message: 'Successfully left group'
      });
    } catch (error) {
      await DB.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('❌ Error leaving group:', error);
    res.status(500).json({
      error: 'Failed to leave group',
      details: (error as Error).message
    });
  }
};

/**
 * Update user's last active timestamp in group
 * POST /mirror/api/groups/:groupId/heartbeat
 */
export const updateActivityHandler: RequestHandler = async (req, res) => {
  try {
    const userId = req.user!.id;
    const { groupId } = req.params;

    // Note: Actual schema doesn't have last_active_at in mirror_group_members
    // This could be added or we could skip this endpoint
    // For now, just return success
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error updating activity:', error);
    res.status(500).json({
      error: 'Failed to update activity',
      details: (error as Error).message
    });
  }
};
