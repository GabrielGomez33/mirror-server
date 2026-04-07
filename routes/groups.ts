// ============================================================================
// MIRRORGROUPS API ROUTES - PHASE 6: GROUP TYPES, DIRECTORY & GOALS
// ============================================================================
// File: server/routes/groups.ts
// ----------------------------------------------------------------------------
// CHANGES (Phase 6 - Group Types, Directory & Goals):
// 1. Updated createGroupHandler to support new group types (partners, teamwork)
//    with subtype, goal, goalCustom, and smart privacy defaults
// 2. Added searchPublicDirectoryHandler - GET /directory for public group search
// 3. Added requestToJoinHandler - POST /:groupId/request-join for public groups
// 4. Added getJoinRequestsHandler - GET /:groupId/join-requests for admins
// 5. Added approveJoinRequestHandler - POST /:groupId/join-requests/:requestId/approve
// 6. Added rejectJoinRequestHandler - POST /:groupId/join-requests/:requestId/reject
// 7. Updated listGroupsHandler to return new fields (subtype, goal, goalCustom)
// 8. Updated getGroupDetailsHandler with new fields
// 9. All previous Phase 1-5 functionality preserved unchanged
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
import { isUserOnline } from '../wss/setupWSS';

const router = express.Router();

/* ============================================================================
   MIDDLEWARE: Update last_active on every authenticated API request
============================================================================ */

router.use(((req, _res, next) => {
  const user = (req as any).user;
  if (user?.id) {
    DB.query(
      'UPDATE users SET last_active = NOW() WHERE id = ? AND (last_active IS NULL OR last_active < DATE_SUB(NOW(), INTERVAL 30 SECOND))',
      [user.id]
    ).catch(() => {});
  }
  next();
}) as RequestHandler);

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

/**
 * Sanitize user-provided string for safe DB insertion
 * Strips control characters, trims, and enforces max length
 */
function sanitizeInput(input: unknown, maxLength: number = 500): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return null;
  // Strip control characters except newlines/tabs
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  return cleaned.length > 0 ? cleaned.substring(0, maxLength) : null;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/**
 * Validate group type against allowed values
 */
const VALID_GROUP_TYPES = ['family', 'partners', 'teamwork', 'friends', 'professional', 'therapy', 'anonymous', 'open', 'private', 'team', 'community', 'public'] as const;
type ValidGroupType = typeof VALID_GROUP_TYPES[number];

function isValidGroupType(type: string): type is ValidGroupType {
  return (VALID_GROUP_TYPES as readonly string[]).includes(type);
}

const VALID_PRIVACY = ['private', 'public', 'secret'] as const;
function isValidPrivacy(privacy: string): boolean {
  return (VALID_PRIVACY as readonly string[]).includes(privacy);
}

const VALID_PARTNER_SUBTYPES = ['lover', 'platonic'] as const;
function isValidSubtype(subtype: string): boolean {
  return (VALID_PARTNER_SUBTYPES as readonly string[]).includes(subtype);
}

/**
 * Valid goal presets — mirrors the client-side GOAL_PRESETS arrays
 * and the ENUM values in the `goal` column. Used to route incoming
 * goal values to the correct column: recognized presets → `goal` (ENUM),
 * unrecognized text → `goal_custom` (VARCHAR 500).
 */
const VALID_GOAL_PRESETS: readonly string[] = [
  // Legacy values
  'therapy',
  'conflict_resolution',
  'mutual_understanding',
  'team_building',
  'personal_growth',
  // Family
  'Improve communication across generations',
  'Understand each other\'s emotional needs better',
  'Resolve long-standing conflicts',
  'Navigate a major family transition',
  'Build stronger family bonds',
  // Partners
  'Strengthen our relationship and communication',
  'Understand each other\'s love languages / working styles',
  'Prepare for major life transition together',
  'Deepen emotional connection and trust',
  'Improve conflict resolution skills',
  // Teamwork
  'Improve team collaboration and productivity',
  'Advance to leadership positions together',
  'Complete a major project by deadline',
  'Improve code review / creative process',
  'Build a high-performing team culture',
];

function isValidGoalPreset(goal: string): boolean {
  return VALID_GOAL_PRESETS.includes(goal);
}

/**
 * Get smart defaults for a given group type
 */
function getTypeDefaults(type: string): { privacy: string; maxMembers: number } {
  switch (type) {
    case 'family': return { privacy: 'private', maxMembers: 8 };
    case 'partners': return { privacy: 'private', maxMembers: 4 };
    case 'teamwork': return { privacy: 'private', maxMembers: 20 };
    case 'friends': return { privacy: 'private', maxMembers: 10 };
    case 'professional': return { privacy: 'private', maxMembers: 20 };
    case 'therapy': return { privacy: 'private', maxMembers: 12 };
    case 'anonymous': return { privacy: 'secret', maxMembers: 25 };
    default: return { privacy: 'private', maxMembers: 10 };
  }
}

/**
 * Enrich an array of member rows with shared data information.
 */
async function enrichMembersWithSharedData(groupId: string, members: any[]): Promise<any[]> {
  if (!members || members.length === 0) return [];

  try {
    const [sharedDataRows] = await DB.query(
      `SELECT sd.user_id, sd.data_type, sd.shared_at, sd.data_version
       FROM mirror_group_shared_data sd
       WHERE sd.group_id = ?
       ORDER BY sd.shared_at DESC`,
      [groupId]
    );

    const sharedDataMap = new Map<number, { dataTypes: string[]; sharedData: any[] }>();
    for (const row of (sharedDataRows as any[])) {
      const userId = row.user_id;
      if (!sharedDataMap.has(userId)) {
        sharedDataMap.set(userId, { dataTypes: [], sharedData: [] });
      }
      const entry = sharedDataMap.get(userId)!;
      if (!entry.dataTypes.includes(row.data_type)) {
        entry.dataTypes.push(row.data_type);
      }
      entry.sharedData.push({
        dataType: row.data_type,
        sharedAt: row.shared_at,
        dataVersion: row.data_version
      });
    }

    return members.map((member: any) => {
      const userId = member.user_id;
      const sharedInfo = sharedDataMap.get(userId);
      const hasSharedData = !!sharedInfo && sharedInfo.dataTypes.length > 0;
      const sharedDataTypes = sharedInfo ? sharedInfo.dataTypes : [];

      return {
        ...member,
        has_shared_data: hasSharedData,
        shared_data_types: sharedDataTypes,
        is_online: isUserOnline(userId)
      };
    });
  } catch (error) {
    console.error('Warning: Error enriching members with shared data:', error);
    return members.map((member: any) => ({
      ...member,
      has_shared_data: false,
      shared_data_types: []
    }));
  }
}

/**
 * Apply anonymous aliasing to a members array for anonymous groups.
 * Members are sorted by joined_at and assigned "Member N" aliases.
 */
function applyAnonymousAliases(
  members: any[],
  requestingUserId: number,
  requestingUserRole: string,
  groupType: string
): any[] {
  if (groupType !== 'anonymous') return members;

  const sorted = [...members].sort(
    (a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime()
  );

  const aliasMap = new Map<number, string>();
  sorted.forEach((member, index) => {
    aliasMap.set(member.user_id, `Member ${index + 1}`);
  });

  const isOwnerOrAdmin = ['owner', 'admin'].includes(requestingUserRole);

  return members.map((member) => {
    const alias = aliasMap.get(member.user_id) || 'Member';
    const isSelf = member.user_id === requestingUserId;

    if (isOwnerOrAdmin) {
      return {
        ...member,
        display_name: isSelf ? `${alias} (You)` : `${alias} — ${member.username}`,
        anonymous_alias: alias,
      };
    }

    return {
      ...member,
      username: isSelf ? `${alias} (You)` : alias,
      display_name: isSelf ? `${alias} (You)` : alias,
      email: undefined,
      anonymous_alias: alias,
      has_shared_data: false,
      shared_data_types: [],
      is_online: undefined,
      last_active: undefined,
    };
  });
}

/**
 * Build an alias map for a group's members (for use in chat, notifications, etc.)
 */
async function buildAnonymousAliasMap(groupId: string): Promise<Map<number, string>> {
  const [memberRows] = await DB.query(
    `SELECT user_id, joined_at FROM mirror_group_members
     WHERE group_id = ? AND status = 'active'
     ORDER BY joined_at ASC`,
    [groupId]
  );

  const aliasMap = new Map<number, string>();
  (memberRows as any[]).forEach((row: any, index: number) => {
    aliasMap.set(row.user_id, `Member ${index + 1}`);
  });

  return aliasMap;
}

/* ============================================================================
   ATOMIC MEMBER OPERATIONS
============================================================================ */

async function atomicAddMember(
  groupId: string,
  userId: number,
  role: 'owner' | 'admin' | 'member' = 'member'
): Promise<{ success: boolean; error?: string; code?: string }> {
  const conn = await DB.getConnection();
  try {
    await conn.beginTransaction();
    const [groupRows] = await conn.query(
      `SELECT max_members, current_member_count, status FROM mirror_groups WHERE id = ? FOR UPDATE`,
      [groupId]
    );
    const group = (groupRows as any[])[0];
    if (!group || group.status !== 'active') {
      await conn.rollback(); return { success: false, error: 'Group not found or inactive', code: 'GROUP_NOT_FOUND' };
    }
    if (group.current_member_count >= group.max_members) {
      await conn.rollback(); return { success: false, error: 'Group has reached maximum capacity', code: 'GROUP_FULL' };
    }
    const [existing] = await conn.query(
      `SELECT id, status FROM mirror_group_members WHERE group_id = ? AND user_id = ?`,
      [groupId, userId]
    );
    if ((existing as any[]).length > 0) {
      const status = (existing as any[])[0].status;
      if (status === 'active') { await conn.rollback(); return { success: false, error: 'Already a member', code: 'ALREADY_MEMBER' }; }
      if (status === 'banned') { await conn.rollback(); return { success: false, error: 'You are not permitted to join this group', code: 'BANNED' }; }
      await conn.query(
        `UPDATE mirror_group_members SET status = 'active', role = ?, joined_at = NOW() WHERE group_id = ? AND user_id = ?`,
        [role, groupId, userId]
      );
    } else {
      const memberId = uuidv4();
      await conn.query(
        `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())`,
        [memberId, groupId, userId, role]
      );
    }
    await conn.query(
      `UPDATE mirror_groups SET current_member_count = current_member_count + 1, updated_at = NOW() WHERE id = ?`,
      [groupId]
    );
    await conn.commit();
    return { success: true };
  } catch (error) {
    await conn.rollback();
    console.error('atomicAddMember failed:', error);
    return { success: false, error: 'Failed to add member', code: 'INTERNAL_ERROR' };
  } finally {
    conn.release();
  }
}

async function atomicRemoveMember(
  groupId: string,
  userId: number,
  removalStatus: 'left' | 'removed' | 'banned' = 'left'
): Promise<{ success: boolean; error?: string }> {
  const conn = await DB.getConnection();
  try {
    await conn.beginTransaction();
    const [memberRows] = await conn.query(
      `SELECT id, status, role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );
    if ((memberRows as any[]).length === 0) { await conn.rollback(); return { success: false, error: 'Not an active member' }; }
    await conn.query(
      `UPDATE mirror_group_members SET status = ?, left_at = NOW() WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [removalStatus, groupId, userId]
    );
    await conn.query(
      `UPDATE mirror_groups SET current_member_count = GREATEST(current_member_count - 1, 0), updated_at = NOW() WHERE id = ?`,
      [groupId]
    );
    await conn.commit();
    return { success: true };
  } catch (error) {
    await conn.rollback();
    console.error('atomicRemoveMember failed:', error);
    return { success: false, error: 'Failed to remove member' };
  } finally {
    conn.release();
  }
}

async function reconcileMemberCount(groupId: string): Promise<void> {
  try {
    await DB.query(
      `UPDATE mirror_groups g
       SET g.current_member_count = (
         SELECT COUNT(*) FROM mirror_group_members
         WHERE group_id = ? AND status = 'active'
       )
       WHERE g.id = ?`,
      [groupId, groupId]
    );
  } catch (error) {
    console.error(`Member count reconciliation failed for group ${groupId}:`, error);
  }
}

function validateGroupIdParam(groupId: string, res: express.Response): boolean {
  if (!isValidUUID(groupId)) {
    res.status(400).json({ success: false, error: 'Invalid group identifier', code: 'INVALID_GROUP_ID' });
    return false;
  }
  return true;
}

/* ============================================================================
   CREATE GROUP - ENHANCED WITH GROUP TYPES, SUBTYPES, GOALS
============================================================================ */

const createGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const {
      name,
      description,
      type,
      privacy,
      subtype,
      goal,
      goalCustom,
      goalMetadata,
      maxMembers,
      settings,
    } = req.body;

    // ---- Validate name ----
    const sanitizedName = sanitizeInput(name, 50);
    if (!sanitizedName || sanitizedName.length < 3) {
      res.status(400).json({ success: false, error: 'Group name must be between 3 and 50 characters' });
      return;
    }

    // ---- Validate & default type ----
    const groupType = (type && isValidGroupType(type)) ? type : 'family';

    // ---- Validate subtype (only for partners) ----
    let groupSubtype: string | null = null;
    if (groupType === 'partners') {
      if (subtype && isValidSubtype(subtype)) {
        groupSubtype = subtype;
      }
      // Partners without subtype is allowed - user may set later
    }

    // ---- Smart privacy defaults ----
    const defaults = getTypeDefaults(groupType);
    const groupPrivacy = (privacy && isValidPrivacy(privacy)) ? privacy : defaults.privacy;

    // ---- Validate max members ----
    let groupMaxMembers = typeof maxMembers === 'number' ? maxMembers : defaults.maxMembers;
    groupMaxMembers = Math.max(2, Math.min(100, groupMaxMembers));

    // ---- Sanitize & route goal ----
    // Recognized presets → `goal` (ENUM column).
    // Unrecognized text  → `goal_custom` (VARCHAR 500 column).
    const rawGoal = sanitizeInput(goal, 500) || null;
    let sanitizedGoal: string | null = null;
    let sanitizedGoalCustom = sanitizeInput(goalCustom, 500) || null;

    if (rawGoal) {
      if (isValidGoalPreset(rawGoal)) {
        sanitizedGoal = rawGoal;
      } else {
        // Not a known preset — route to goal_custom so no data is lost
        sanitizedGoalCustom = sanitizedGoalCustom || rawGoal;
      }
    }
    const sanitizedDescription = sanitizeInput(description, 500);

    // ---- Public groups require description ----
    if (groupPrivacy === 'public' && !sanitizedDescription) {
      res.status(400).json({ success: false, error: 'Public groups require a description' });
      return;
    }

    const groupId = uuidv4();

    console.log(`Creating group: ${sanitizedName} (type: ${groupType}, subtype: ${groupSubtype}, privacy: ${groupPrivacy}, goal: ${sanitizedGoal || sanitizedGoalCustom?.substring(0, 50) || 'none'})`);

    // ---- Insert group ----
    await DB.query(
      `INSERT INTO mirror_groups (
        id, owner_user_id, name, description, type, subtype, privacy,
        goal, goal_custom, goal_metadata, max_members, current_member_count,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', NOW())`,
      [
        groupId,
        user.id,
        sanitizedName,
        sanitizedDescription,
        groupType,
        groupSubtype,
        groupPrivacy,
        sanitizedGoal,
        sanitizedGoalCustom,
        goalMetadata ? JSON.stringify(goalMetadata) : null,
        groupMaxMembers,
      ]
    );

    // ---- Add creator as owner ----
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

    // ---- Generate encryption key ----
    try {
      const keyId = await groupEncryptionManager.generateGroupKey(groupId);
      await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), keyId);
      console.log(`Encryption key generated for group ${groupId}`);
    } catch (encError) {
      console.error('Encryption key generation failed (non-fatal):', encError);
    }

    // ---- Create directory settings for public groups ----
    if (groupPrivacy === 'public') {
      try {
        await DB.query(
          `INSERT INTO mirror_group_directory_settings (group_id, show_member_count, show_goal, show_description)
           VALUES (?, TRUE, TRUE, TRUE)
           ON DUPLICATE KEY UPDATE updated_at = NOW()`,
          [groupId]
        );
      } catch (dirError) {
        console.error('Directory settings creation failed (non-fatal):', dirError);
      }
    }

    res.status(201).json({
      success: true,
      data: {
        id: groupId,
        name: sanitizedName,
        description: sanitizedDescription,
        type: groupType,
        subtype: groupSubtype,
        privacy: groupPrivacy,
        goal: sanitizedGoal,
        goalCustom: sanitizedGoalCustom,
        maxMembers: groupMaxMembers,
        currentMemberCount: 1,
      },
      message: 'Group created successfully'
    });

  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
};

/* ============================================================================
   LIST GROUPS (USER IS MEMBER OR OWNER) - UPDATED WITH NEW FIELDS
============================================================================ */

const listGroupsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const [rows] = await DB.query(
      `SELECT g.id, g.name, g.description, g.type, g.subtype, g.privacy,
              g.goal, g.goal_custom, g.max_members, g.current_member_count,
              g.owner_user_id, g.status, g.created_at, g.updated_at,
              g.group_image_url,
              gm.role, gm.joined_at, gm.status as member_status
         FROM mirror_groups g
         INNER JOIN mirror_group_members gm ON g.id = gm.group_id
        WHERE gm.user_id = ? AND gm.status = 'active' AND g.status = 'active'
        ORDER BY gm.joined_at DESC`,
      [user.id]
    );

    const groups = (rows as any[]).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      subtype: row.subtype,
      privacy: row.privacy,
      goal: row.goal,
      goalCustom: row.goal_custom,
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
      is_owner: row.owner_user_id === user.id
    }));

    res.json({
      success: true,
      data: { groups }
    });
  } catch (error) {
    console.error('Error listing groups:', error);
    res.status(500).json({ success: false, error: 'Failed to list groups' });
  }
};

/* ============================================================================
   SUGGESTED GROUPS
============================================================================ */

const getSuggestedGroupsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);
    const [rows] = await DB.query(
      `SELECT g.id, g.name, g.description, g.type, g.subtype, g.privacy,
              g.goal, g.goal_custom, g.max_members, g.current_member_count,
              g.owner_user_id, g.status, g.created_at, g.updated_at, g.group_image_url
       FROM mirror_groups g
       WHERE g.privacy = 'public' AND g.status = 'active' AND g.current_member_count < g.max_members
         AND g.id NOT IN (
           SELECT gm.group_id FROM mirror_group_members gm WHERE gm.user_id = ? AND gm.status IN ('active', 'invited')
         )
       ORDER BY g.current_member_count DESC, g.created_at DESC LIMIT ?`,
      [user.id, limit]
    );
    res.json({ success: true, data: { groups: rows, total: (rows as any[]).length } });
  } catch (error) {
    console.error('Error fetching suggested groups:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch suggested groups' });
  }
};

/* ============================================================================
   PUBLIC DIRECTORY - SEARCH PUBLIC GROUPS
   GET /directory?q=search&type=teamwork&limit=50&offset=0
============================================================================ */

const searchPublicDirectoryHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: 'NO_AUTH' });
      return;
    }

    const query = sanitizeInput(req.query.q as string, 100) || '';
    const typeFilter = sanitizeInput(req.query.type as string, 30);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // Build dynamic WHERE clause
    const conditions: string[] = [
      "g.privacy = 'public'",
      "g.status = 'active'"
    ];
    const params: any[] = [];

    // Text search
    if (query) {
      conditions.push("(g.name LIKE ? OR g.description LIKE ?)");
      const searchTerm = `%${query}%`;
      params.push(searchTerm, searchTerm);
    }

    // Type filter
    if (typeFilter && isValidGroupType(typeFilter)) {
      conditions.push("g.type = ?");
      params.push(typeFilter);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const [countRows] = await DB.query(
      `SELECT COUNT(*) as total FROM mirror_groups g WHERE ${whereClause}`,
      params
    );
    const total = (countRows as any[])[0]?.total || 0;

    // Get paginated results
    const [rows] = await DB.query(
      `SELECT g.id, g.name, g.description, g.type, g.subtype, g.privacy,
              g.goal, g.goal_custom, g.max_members, g.current_member_count,
              g.owner_user_id, g.status, g.created_at, g.updated_at,
              g.group_image_url
       FROM mirror_groups g
       WHERE ${whereClause}
       ORDER BY g.current_member_count DESC, g.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const groups = (rows as any[]).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      subtype: row.subtype,
      privacy: row.privacy,
      goal: row.goal,
      goalCustom: row.goal_custom,
      maxMembers: row.max_members,
      memberCount: row.current_member_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      groupImageUrl: row.group_image_url,
    }));

    res.json({
      success: true,
      data: {
        groups,
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    console.error('Error searching public directory:', error);
    res.status(500).json({ success: false, error: 'Failed to search groups' });
  }
};

/* ============================================================================
   REQUEST TO JOIN (for public groups - user requests, admin approves)
   POST /:groupId/request-join
============================================================================ */

const requestToJoinHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const { message } = req.body;

    // Verify group exists and is public
    const [groupRows] = await DB.query(
      `SELECT id, name, privacy, max_members, current_member_count, status
       FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

    if (group.privacy !== 'public') {
      res.status(403).json({ success: false, error: 'This group is not public. You need an invitation to join.' });
      return;
    }

    // Check capacity
    if (group.current_member_count >= group.max_members) {
      res.status(400).json({ success: false, error: 'Group has reached maximum capacity' });
      return;
    }

    // Check if already a member
    const [existingMember] = await DB.query(
      `SELECT id, status FROM mirror_group_members WHERE group_id = ? AND user_id = ?`,
      [groupId, user.id]
    );

    if ((existingMember as any[]).length > 0) {
      const memberStatus = (existingMember as any[])[0].status;
      if (memberStatus === 'active') {
        res.status(400).json({ success: false, error: 'You are already a member of this group' });
        return;
      }
      if (memberStatus === 'invited') {
        res.status(400).json({ success: false, error: 'You already have a pending invitation. Check your invitations.' });
        return;
      }
    }

    // Check for existing pending request
    const [existingRequest] = await DB.query(
      `SELECT id FROM mirror_group_join_requests
       WHERE group_id = ? AND user_id = ? AND status = 'pending'`,
      [groupId, user.id]
    );

    if ((existingRequest as any[]).length > 0) {
      res.status(400).json({ success: false, error: 'You already have a pending join request for this group' });
      return;
    }

    // Check directory settings for auto-approve
    let autoApprove = false;
    try {
      const [dirSettings] = await DB.query(
        `SELECT auto_approve_joins FROM mirror_group_directory_settings WHERE group_id = ?`,
        [groupId]
      );
      if ((dirSettings as any[]).length > 0) {
        autoApprove = (dirSettings as any[])[0].auto_approve_joins;
      }
    } catch { /* no directory settings - default to manual approval */ }

    const requestId = uuidv4();
    const sanitizedMessage = sanitizeInput(message, 500);

    if (autoApprove) {
      // Auto-approve: add member atomically
      const addResult = await atomicAddMember(groupId, user.id, 'member');
      if (!addResult.success) {
        res.status(400).json({ success: false, error: addResult.error, code: addResult.code });
        return;
      }

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
        }
      } catch (encError) {
        console.error('Encryption key distribution failed (non-fatal):', encError);
      }

      // Notify members
      const [userInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
      const [membersRows] = await DB.query(
        `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
         FROM mirror_group_members gm
         JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = ? AND gm.status = 'active'`,
        [groupId]
      );

      await mirrorGroupNotifications.notifyMemberJoined(
        membersRows as any[],
        { userId: String(user.id), userName: (userInfo as any[])[0]?.username || 'Unknown' },
        group.name
      );

      res.status(201).json({
        success: true,
        data: { status: 'approved', autoApproved: true },
        message: 'You have been automatically added to the group!'
      });

    } else {
      // Manual approval: create join request
      await DB.query(
        `INSERT INTO mirror_group_join_requests (id, group_id, user_id, status, message, request_type, requested_at)
         VALUES (?, ?, ?, 'pending', ?, 'join_request', NOW())`,
        [requestId, groupId, user.id, sanitizedMessage]
      );

      // Notify group admins/owners
      const [adminRows] = await DB.query(
        `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
         FROM mirror_group_members gm
         JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = ? AND gm.status = 'active' AND gm.role IN ('owner', 'admin')`,
        [groupId]
      );

      const [requesterInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
      const requesterName = (requesterInfo as any[])[0]?.username || 'Someone';

      // Notify admins about the join request
      for (const admin of (adminRows as any[])) {
        try {
          await mirrorGroupNotifications.notifyGroupInvite({
            inviteeUserId: String(admin.userId),
            inviterName: requesterName,
            groupId: groupId,
            groupName: `${group.name} (Join Request)`,
            inviteCode: requestId
          });
        } catch { /* non-fatal */ }
      }

      res.status(201).json({
        success: true,
        data: { requestId, status: 'pending' },
        message: 'Join request submitted. An admin will review your request.'
      });
    }

  } catch (error) {
    console.error('Error requesting to join group:', error);
    res.status(500).json({ success: false, error: 'Failed to submit join request' });
  }
};

/* ============================================================================
   GET JOIN REQUESTS (for group admins)
   GET /:groupId/join-requests
============================================================================ */

const getJoinRequestsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify user is admin or owner
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'admin')`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Only admins and owners can view join requests' });
      return;
    }

    const statusFilter = req.query.status === 'all' ? '' : "AND jr.status = 'pending'";

    const [requests] = await DB.query(
      `SELECT
        jr.id as request_id,
        jr.group_id,
        jr.user_id,
        u.username,
        jr.status,
        jr.message,
        jr.request_type,
        jr.requested_at,
        jr.processed_at,
        jr.processed_by
       FROM mirror_group_join_requests jr
       JOIN users u ON jr.user_id = u.id
       WHERE jr.group_id = ? ${statusFilter}
       ORDER BY jr.requested_at DESC
       LIMIT 100`,
      [groupId]
    );

    res.json({
      success: true,
      data: {
        requests,
        total: (requests as any[]).length
      }
    });
  } catch (error) {
    console.error('Error fetching join requests:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch join requests' });
  }
};

/* ============================================================================
   APPROVE JOIN REQUEST
   POST /:groupId/join-requests/:requestId/approve
============================================================================ */

const approveJoinRequestHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, requestId } = req.params;

    // Verify user is admin or owner
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'admin')`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Only admins and owners can approve requests' });
      return;
    }

    // Verify request exists
    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests
       WHERE id = ? AND group_id = ? AND status = 'pending'`,
      [requestId, groupId]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Join request not found or already processed' });
      return;
    }

    const joinRequest = (requestRows as any[])[0];

    // Check capacity
    const [groupRows] = await DB.query(
      `SELECT max_members, current_member_count, name FROM mirror_groups WHERE id = ?`,
      [groupId]
    );
    const group = (groupRows as any[])[0];

    if (group.current_member_count >= group.max_members) {
      res.status(400).json({ success: false, error: 'Group has reached maximum capacity' });
      return;
    }

    // Add member or update existing
    const memberId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_members (id, group_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'member', 'active', NOW())
       ON DUPLICATE KEY UPDATE status = 'active', joined_at = NOW()`,
      [memberId, groupId, joinRequest.user_id]
    );

    // Update request status
    await DB.query(
      `UPDATE mirror_group_join_requests
       SET status = 'approved', processed_by = ?, processed_at = NOW()
       WHERE id = ?`,
      [user.id, requestId]
    );

    // Increment member count
    await DB.query(
      `UPDATE mirror_groups SET current_member_count = current_member_count + 1 WHERE id = ?`,
      [groupId]
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
        await groupEncryptionManager.distributeKeyToMember(groupId, String(joinRequest.user_id), keyId, key_version);
      }
    } catch (encError) {
      console.error('Encryption key distribution failed (non-fatal):', encError);
    }

    // Notify the requester that they were approved
    const [approverInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
    const approverName = (approverInfo as any[])[0]?.username || 'An admin';

    try {
      await mirrorGroupNotifications.notifyGroupInvite({
        inviteeUserId: String(joinRequest.user_id),
        inviterName: approverName,
        groupId: groupId,
        groupName: `${group.name} - Request Approved!`,
        inviteCode: requestId
      });
    } catch { /* non-fatal */ }

    // Notify all members about new member
    const [membersRows] = await DB.query(
      `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active'`,
      [groupId]
    );
    const [newMemberInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [joinRequest.user_id]);

    await mirrorGroupNotifications.notifyMemberJoined(
      membersRows as any[],
      { userId: String(joinRequest.user_id), userName: (newMemberInfo as any[])[0]?.username || 'Unknown' },
      group.name
    );

    res.json({
      success: true,
      message: 'Join request approved successfully'
    });
  } catch (error) {
    console.error('Error approving join request:', error);
    res.status(500).json({ success: false, error: 'Failed to approve join request' });
  }
};

/* ============================================================================
   REJECT JOIN REQUEST
   POST /:groupId/join-requests/:requestId/reject
============================================================================ */

const rejectJoinRequestHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, requestId } = req.params;

    // Verify user is admin or owner
    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'admin')`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Only admins and owners can reject requests' });
      return;
    }

    // Verify request exists
    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests
       WHERE id = ? AND group_id = ? AND status = 'pending'`,
      [requestId, groupId]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Join request not found or already processed' });
      return;
    }

    // Update request status
    await DB.query(
      `UPDATE mirror_group_join_requests
       SET status = 'rejected', processed_by = ?, processed_at = NOW()
       WHERE id = ?`,
      [user.id, requestId]
    );

    // Clean up any invited member record
    await DB.query(
      `DELETE FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
      [groupId, (requestRows as any[])[0].user_id]
    );

    res.json({
      success: true,
      message: 'Join request rejected'
    });
  } catch (error) {
    console.error('Error rejecting join request:', error);
    res.status(500).json({ success: false, error: 'Failed to reject join request' });
  }
};

/* ============================================================================
   JOIN GROUP - PRESERVED FROM EXISTING
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
      `SELECT id, privacy FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );

    if ((check as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    // If public group, redirect to request-to-join flow
    const groupData = (check as any[])[0];
    if (groupData.privacy === 'public') {
      // Forward to request-to-join handler
      req.params.groupId = groupId;
      return requestToJoinHandler(req, res, () => {});
    }

    await DB.query(
      `INSERT IGNORE INTO mirror_group_members (group_id, user_id, joined_at)
       VALUES (?, ?, NOW())`,
      [groupId, user.id]
    );

    res.json({ success: true, message: 'Joined group successfully' });
  } catch (error) {
    console.error('Error joining group:', error);
    res.status(500).json({ success: false, error: 'Failed to join group' });
  }
};

/* ============================================================================
   GET GROUP DETAILS - UPDATED WITH NEW FIELDS
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
        u.username, u.email,
        GREATEST(COALESCE(u.last_active, '1970-01-01'), COALESCE(u.last_login, '1970-01-01')) AS last_active
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

    const enrichedMembers = await enrichMembersWithSharedData(groupId, membersRows as any[]);

    // Apply anonymous aliasing if this is an anonymous group
    const userRole = (memberCheck as any[])[0].role;
    const finalMembers = applyAnonymousAliases(enrichedMembers, user.id, userRole, group.type);

    res.json({
      success: true,
      data: {
        group: {
          id: group.id,
          name: group.name,
          description: group.description,
          type: group.type,
          subtype: group.subtype,
          privacy: group.privacy,
          goal: group.goal,
          goalCustom: group.goal_custom,
          goalMetadata: safeJsonParse(group.goal_metadata, null),
          max_members: group.max_members,
          current_member_count: group.current_member_count,
          owner_user_id: group.type === 'anonymous' ? undefined : group.owner_user_id,
          status: group.status,
          created_at: group.created_at,
          isAnonymous: group.type === 'anonymous',
        },
        members: finalMembers,
        userRole,
        isOwner: Number(group.owner_user_id) === Number(user.id)
      }
    });
  } catch (error) {
    console.error('Error getting group details:', error);
    res.status(500).json({ success: false, error: 'Failed to get group details' });
  }
};

/* ============================================================================
   GET MEMBERS LIST
============================================================================ */

const getMembersHandler: RequestHandler = async (req, res) => {
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

    const [membersRows] = await DB.query(
      `SELECT
        gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
        u.username, u.email,
        GREATEST(COALESCE(u.last_active, '1970-01-01'), COALESCE(u.last_login, '1970-01-01')) AS last_active
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

    const enrichedMembers = await enrichMembersWithSharedData(groupId, membersRows as any[]);

    // Fetch group type for anonymous aliasing
    const [groupTypeRows] = await DB.query(
      `SELECT type FROM mirror_groups WHERE id = ?`,
      [groupId]
    );
    const groupType = (groupTypeRows as any[])[0]?.type || '';
    const userRole = (memberCheck as any[])[0].role;
    const finalMembers = applyAnonymousAliases(enrichedMembers, user.id, userRole, groupType);

    res.json({
      success: true,
      data: { members: finalMembers }
    });
  } catch (error) {
    console.error('Error getting members:', error);
    res.status(500).json({ success: false, error: 'Failed to get members' });
  }
};

/* ============================================================================
   GET MEMBER DETAILS
============================================================================ */

const getMemberDetailsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, memberId } = req.params;

    const [memberCheck] = await DB.query(
      `SELECT role FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    const isNumericId = /^\d+$/.test(memberId);
    const memberQuery = isNumericId
      ? `SELECT gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
                u.username, u.email, u.created_at as user_created_at,
                GREATEST(COALESCE(u.last_active, '1970-01-01'), COALESCE(u.last_login, '1970-01-01')) AS last_active
         FROM mirror_group_members gm
         INNER JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = ? AND gm.user_id = ? AND gm.status = 'active'`
      : `SELECT gm.id, gm.user_id, gm.role, gm.status, gm.joined_at,
                u.username, u.email, u.created_at as user_created_at,
                GREATEST(COALESCE(u.last_active, '1970-01-01'), COALESCE(u.last_login, '1970-01-01')) AS last_active
         FROM mirror_group_members gm
         INNER JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id = ? AND gm.id = ? AND gm.status = 'active'`;

    const [memberRows] = await DB.query(memberQuery, [groupId, memberId]);

    if ((memberRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Member not found' });
      return;
    }

    const member = (memberRows as any[])[0];

    const [sharedDataRows] = await DB.query(
      `SELECT data_type, shared_at, data_version
       FROM mirror_group_shared_data
       WHERE group_id = ? AND user_id = ?
       ORDER BY shared_at DESC`,
      [groupId, member.user_id]
    );

    const sharedData = (sharedDataRows as any[]).map((row: any) => ({
      dataType: row.data_type,
      sharedAt: row.shared_at,
      dataVersion: row.data_version
    }));

    const sharedDataTypes = [...new Set(sharedData.map((sd: any) => sd.dataType))];
    const hasSharedData = sharedDataTypes.length > 0;
    const hasSharedProfile = sharedDataTypes.includes('profile') || sharedDataTypes.includes('full_profile');

    const enrichedMember = {
      id: member.id,
      user_id: member.user_id,
      username: member.username,
      display_name: member.username,
      role: member.role,
      status: member.status,
      joined_at: member.joined_at,
      user_created_at: member.user_created_at,
      last_active: member.last_active,
      is_online: isUserOnline(member.user_id),
      has_shared_data: hasSharedData,
      shared_data_types: sharedDataTypes,
      ...(hasSharedProfile ? { email: member.email } : {})
    };

    const dataTypeCounts: Record<string, number> = {};
    for (const sd of sharedData) {
      dataTypeCounts[sd.dataType] = (dataTypeCounts[sd.dataType] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        member: enrichedMember,
        sharedData: sharedData,
        sharedDataSummary: { totalShared: sharedDataTypes.length, dataTypes: dataTypeCounts },
        hasSharedData: hasSharedData,
        hasSharedProfile: hasSharedProfile
      }
    });
  } catch (error) {
    console.error('Error getting member details:', error);
    res.status(500).json({ success: false, error: 'Failed to get member details' });
  }
};

/* ============================================================================
   INVITE MEMBER - PRESERVED FROM EXISTING
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
        `INSERT INTO mirror_group_join_requests (id, group_id, user_id, status, request_type, requested_at, processed_by) VALUES (?, ?, ?, 'pending', 'invite', NOW(), ?)`,
        [requestId, groupId, targetUserId, user.id]
      );
    }

    const [groupInfo] = await DB.query(`SELECT name FROM mirror_groups WHERE id = ?`, [groupId]);
    const [inviterInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
    const groupName = (groupInfo as any[])[0]?.name || 'Unknown Group';
    const inviterName = (inviterInfo as any[])[0]?.username || 'Someone';

    await mirrorGroupNotifications.notifyGroupInvite({
      inviteeUserId: String(targetUserId),
      inviterName: inviterName,
      groupId: groupId,
      groupName: groupName,
      inviteCode: requestId
    });

    console.log(`Invitation sent: ${requestId} to user ${targetUserId}`);
    res.status(201).json({ success: true, data: { requestId }, message: 'Invitation sent successfully' });
  } catch (error) {
    console.error('Error inviting member:', error);
    res.status(500).json({ success: false, error: 'Failed to invite member' });
  }
};

/* ============================================================================
   ACCEPT INVITATION - PRESERVED FROM EXISTING
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

    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`,
      [requestId, groupId, user.id]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Invalid or expired invitation' });
      return;
    }

    await DB.query(
      `UPDATE mirror_group_members
       SET status = 'active', joined_at = NOW()
       WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
      [groupId, user.id]
    );

    await DB.query(
      `DELETE FROM mirror_group_join_requests WHERE id = ?`,
      [requestId]
    );

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
      }
    } catch (encError) {
      console.error('Encryption key distribution failed:', encError);
    }

    await DB.query(
      `UPDATE mirror_groups SET current_member_count = current_member_count + 1 WHERE id = ?`,
      [groupId]
    );

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

    await mirrorGroupNotifications.notifyMemberJoined(
      membersRows as any[],
      newMemberInfo,
      groupName
    );

    res.json({ success: true, message: 'Successfully joined group' });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    res.status(500).json({ success: false, error: 'Failed to join group' });
  }
};

/* ============================================================================
   DECLINE INVITATION - PRESERVED FROM EXISTING
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

    const [requestRows] = await DB.query(
      `SELECT * FROM mirror_group_join_requests
       WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`,
      [requestId, groupId, user.id]
    );

    if ((requestRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Invalid or expired invitation' });
      return;
    }

    await DB.query(
      `DELETE FROM mirror_group_join_requests WHERE id = ?`,
      [requestId]
    );

    await DB.query(
      `DELETE FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'invited'`,
      [groupId, user.id]
    );

    res.json({ success: true, message: 'Invitation declined successfully' });
  } catch (error) {
    console.error('Error declining invitation:', error);
    res.status(500).json({ success: false, error: 'Failed to decline invitation' });
  }
};

/* ============================================================================
   GET MY INVITATIONS - PRESERVED FROM EXISTING
============================================================================ */

const getMyInvitationsHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const [invitations] = await DB.query(
      `SELECT
        jr.id as request_id,
        jr.group_id,
        g.name as group_name,
        g.description as group_description,
        g.type as group_type,
        g.subtype as group_subtype,
        g.goal as group_goal,
        g.goal_custom as group_goal_custom,
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

    res.json({
      success: true,
      data: { invitations }
    });
  } catch (error) {
    console.error('Error fetching invitations:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch invitations' });
  }
};

/* ============================================================================
   LEAVE GROUP - PRESERVED FROM EXISTING
============================================================================ */

const leaveGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

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

    const [userInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
    const userName = (userInfo as any[])[0]?.username || 'Unknown';

    const [membersRows] = await DB.query(
      `SELECT gm.user_id as userId, u.username as userName, u.email, gm.role
       FROM mirror_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active' AND gm.user_id != ?`,
      [groupId, user.id]
    );

    await DB.query(
      `UPDATE mirror_group_members SET status = 'left', left_at = NOW()
       WHERE group_id = ? AND user_id = ?`,
      [groupId, user.id]
    );

    try {
      await groupEncryptionManager.revokeUserAccess(groupId, String(user.id));
    } catch (encError) {
      console.error('Encryption key revocation failed:', encError);
    }

    await DB.query(
      `UPDATE mirror_groups SET current_member_count = current_member_count - 1 WHERE id = ?`,
      [groupId]
    );

    await mirrorGroupNotifications.notifyMemberLeft(
      membersRows as any[],
      { userId: String(user.id), userName: userName },
      group.name
    );

    res.json({ success: true, message: 'Successfully left group' });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ success: false, error: 'Failed to leave group' });
  }
};

/* ============================================================================
   DELETE GROUP (OWNER ONLY)
   DELETE /:groupId
============================================================================ */

const deleteGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify group exists and user is the owner
    const [groupRows] = await DB.query(
      `SELECT id, name, owner_user_id FROM mirror_groups WHERE id = ?`,
      [groupId]
    );

    if ((groupRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }

    const group = (groupRows as any[])[0];

    if (group.owner_user_id !== user.id) {
      res.status(403).json({ success: false, error: 'Only the group owner can delete the group' });
      return;
    }

    // Revoke all encryption keys before deleting
    try {
      const [memberRows] = await DB.query(
        `SELECT user_id FROM mirror_group_members WHERE group_id = ?`,
        [groupId]
      );
      for (const member of (memberRows as any[])) {
        try {
          await groupEncryptionManager.revokeUserAccess(groupId, String(member.user_id));
        } catch { /* non-fatal per member */ }
      }
    } catch (encError) {
      console.error('Encryption cleanup failed (non-fatal):', encError);
    }

    // Delete all related data in dependency order
    const cleanupQueries = [
      `DELETE FROM mirror_group_join_requests WHERE group_id = ?`,
      `DELETE FROM mirror_group_directory_settings WHERE group_id = ?`,
      `DELETE FROM mirror_group_shared_data WHERE group_id = ?`,
      `DELETE FROM mirror_group_encryption_keys WHERE group_id = ?`,
      `DELETE FROM mirror_group_members WHERE group_id = ?`,
    ];

    for (const query of cleanupQueries) {
      try {
        await DB.query(query, [groupId]);
      } catch (cleanupErr) {
        console.error(`Cleanup query failed (non-fatal): ${query}`, cleanupErr);
      }
    }

    // Delete the group itself
    await DB.query(`DELETE FROM mirror_groups WHERE id = ?`, [groupId]);

    console.log(`Group deleted: ${group.name} (${groupId}) by user ${user.id}`);

    res.json({ success: true, message: 'Group deleted successfully' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
};

/* ============================================================================
   JOIN GROUP BY ID - Enterprise unified join handler
   POST /:groupId/join
============================================================================ */

const joinGroupByIdHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Authentication required' }); return; }
    const { groupId } = req.params;
    if (!validateGroupIdParam(groupId, res)) return;
    const { joinCode } = req.body || {};
    const [groupRows] = await DB.query(
      `SELECT id, name, privacy, max_members, current_member_count, status, type FROM mirror_groups WHERE id = ? AND status = 'active'`,
      [groupId]
    );
    if ((groupRows as any[]).length === 0) { res.status(404).json({ success: false, error: 'Group not found' }); return; }
    const group = (groupRows as any[])[0];
    if (group.current_member_count >= group.max_members) { res.status(409).json({ success: false, error: 'Group full' }); return; }

    // Check existing membership
    const [existingMember] = await DB.query(
      `SELECT id, status FROM mirror_group_members WHERE group_id = ? AND user_id = ?`, [groupId, user.id]
    );
    if ((existingMember as any[]).length > 0) {
      const s = (existingMember as any[])[0].status;
      if (s === 'active') { res.status(409).json({ success: false, error: 'Already a member' }); return; }
      if (s === 'banned') { res.status(403).json({ success: false, error: 'You are not permitted to join this group' }); return; }
    }

    if (group.privacy === 'public') {
      const addResult = await atomicAddMember(groupId, user.id, 'member');
      if (!addResult.success) { res.status(addResult.code === 'GROUP_FULL' ? 409 : 500).json({ success: false, error: addResult.error }); return; }
      try {
        const [keyRows] = await DB.query(`SELECT id, key_version FROM mirror_group_encryption_keys WHERE group_id = ? AND status = 'active' ORDER BY key_version DESC LIMIT 1`, [groupId]);
        if ((keyRows as any[]).length > 0) { await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), (keyRows as any[])[0].id, (keyRows as any[])[0].key_version); }
      } catch {}
      try {
        const [userInfo] = await DB.query(`SELECT username FROM users WHERE id = ?`, [user.id]);
        const [membersRows] = await DB.query(`SELECT gm.user_id as userId, u.username as userName, u.email, gm.role FROM mirror_group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ? AND gm.status = 'active'`, [groupId]);
        await mirrorGroupNotifications.notifyMemberJoined(membersRows as any[], { userId: String(user.id), userName: (userInfo as any[])[0]?.username || 'Unknown' }, group.name);
      } catch {}
      res.status(201).json({ success: true, data: { status: 'approved', groupId }, message: 'You have been added to the group!' });
    } else {
      if (!joinCode) { res.status(403).json({ success: false, error: 'This group requires an invitation to join' }); return; }
      const [inviteRows] = await DB.query(`SELECT id FROM mirror_group_join_requests WHERE id = ? AND group_id = ? AND user_id = ? AND status = 'pending'`, [joinCode, groupId, user.id]);
      if ((inviteRows as any[]).length === 0) { res.status(404).json({ success: false, error: 'Invalid or expired invitation' }); return; }
      const addResult = await atomicAddMember(groupId, user.id, 'member');
      if (!addResult.success) { res.status(500).json({ success: false, error: addResult.error }); return; }
      await DB.query(`DELETE FROM mirror_group_join_requests WHERE id = ?`, [joinCode]);
      try {
        const [keyRows] = await DB.query(`SELECT id, key_version FROM mirror_group_encryption_keys WHERE group_id = ? AND status = 'active' ORDER BY key_version DESC LIMIT 1`, [groupId]);
        if ((keyRows as any[]).length > 0) { await groupEncryptionManager.distributeKeyToMember(groupId, String(user.id), (keyRows as any[])[0].id, (keyRows as any[])[0].key_version); }
      } catch {}
      res.status(201).json({ success: true, data: { status: 'approved', groupId }, message: 'Successfully joined group' });
    }
  } catch (error) {
    console.error('Error in joinGroupByIdHandler:', error);
    res.status(500).json({ success: false, error: 'Failed to process join request' });
  }
};

/* ============================================================================
   UPDATE GROUP - PUT /:groupId
============================================================================ */

const updateGroupHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId } = req.params;
    if (!validateGroupIdParam(groupId, res)) return;
    const [memberCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'admin')`, [groupId, user.id]);
    if ((memberCheck as any[]).length === 0) { res.status(403).json({ success: false, error: 'Only owners and admins can update group settings' }); return; }
    const { name, description, goal, goalCustom, maxMembers, settings } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { const s = sanitizeInput(name, 50); if (!s || s.length < 3) { res.status(400).json({ success: false, error: 'Name must be 3-50 chars' }); return; } updates.push('name = ?'); params.push(s); }
    if (description !== undefined) { updates.push('description = ?'); params.push(sanitizeInput(description, 500)); }
    if (goal !== undefined) { const g = sanitizeInput(goal, 500); if (g && isValidGoalPreset(g)) { updates.push('goal = ?'); params.push(g); } else if (g) { updates.push('goal_custom = ?'); params.push(g); } }
    if (goalCustom !== undefined) { updates.push('goal_custom = ?'); params.push(sanitizeInput(goalCustom, 500)); }
    if (maxMembers !== undefined) {
      const newMax = Math.max(2, Math.min(100, Number(maxMembers) || 10));
      const [gr] = await DB.query(`SELECT current_member_count FROM mirror_groups WHERE id = ?`, [groupId]);
      if (newMax < (gr as any[])[0]?.current_member_count) { res.status(400).json({ success: false, error: 'Cannot set max below current count' }); return; }
      updates.push('max_members = ?'); params.push(newMax);
    }
    if (settings !== undefined) { updates.push('settings = ?'); params.push(JSON.stringify(settings)); }
    if (updates.length === 0) { res.status(400).json({ success: false, error: 'No valid fields to update' }); return; }
    updates.push('updated_at = NOW()'); params.push(groupId);
    await DB.query(`UPDATE mirror_groups SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: 'Group updated successfully' });
  } catch (error) { console.error('Error updating group:', error); res.status(500).json({ success: false, error: 'Failed to update group' }); }
};

/* ============================================================================
   REMOVE MEMBER - DELETE /:groupId/members/:userId
============================================================================ */

const removeMemberHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId, userId: targetUserId } = req.params;
    const targetId = parseInt(targetUserId, 10);
    if (isNaN(targetId)) { res.status(400).json({ success: false, error: 'Invalid user ID' }); return; }
    if (targetId === user.id) { res.status(400).json({ success: false, error: 'Use leave endpoint instead' }); return; }
    const [requesterCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, user.id]);
    if ((requesterCheck as any[]).length === 0 || !['owner', 'admin'].includes((requesterCheck as any[])[0].role)) { res.status(403).json({ success: false, error: 'Only owners and admins can remove members' }); return; }
    const [targetCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, targetId]);
    if ((targetCheck as any[]).length === 0) { res.status(404).json({ success: false, error: 'Not an active member' }); return; }
    if ((targetCheck as any[])[0].role === 'owner') { res.status(403).json({ success: false, error: 'Cannot remove the group owner' }); return; }
    if ((targetCheck as any[])[0].role === 'admin' && (requesterCheck as any[])[0].role !== 'owner') { res.status(403).json({ success: false, error: 'Only the owner can remove admins' }); return; }
    const r = await atomicRemoveMember(groupId, targetId, 'removed');
    if (!r.success) { res.status(500).json({ success: false, error: r.error }); return; }
    try { await groupEncryptionManager.revokeUserAccess(groupId, String(targetId)); } catch {}
    res.json({ success: true, message: 'Member removed successfully' });
  } catch (error) { console.error('Error removing member:', error); res.status(500).json({ success: false, error: 'Failed to remove member' }); }
};

/* ============================================================================
   UPDATE MEMBER ROLE - PUT /:groupId/members/:userId/role
============================================================================ */

const updateMemberRoleHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId, userId: targetUserId } = req.params;
    const targetId = parseInt(targetUserId, 10);
    const { role: newRole } = req.body;
    const validRoles = ['admin', 'moderator', 'member'];
    if (!newRole || !validRoles.includes(newRole)) { res.status(400).json({ success: false, error: `Invalid role. Valid: ${validRoles.join(', ')}` }); return; }
    const [ownerCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role = 'owner'`, [groupId, user.id]);
    if ((ownerCheck as any[]).length === 0) { res.status(403).json({ success: false, error: 'Only the owner can change roles' }); return; }
    if (targetId === user.id) { res.status(400).json({ success: false, error: 'Cannot change your own role' }); return; }
    const [targetCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, targetId]);
    if ((targetCheck as any[]).length === 0) { res.status(404).json({ success: false, error: 'Not an active member' }); return; }
    await DB.query(`UPDATE mirror_group_members SET role = ? WHERE group_id = ? AND user_id = ? AND status = 'active'`, [newRole, groupId, targetId]);
    res.json({ success: true, message: `Role updated to ${newRole}` });
  } catch (error) { console.error('Error updating role:', error); res.status(500).json({ success: false, error: 'Failed to update role' }); }
};

/* ============================================================================
   BAN MEMBER - POST /:groupId/members/:userId/ban
============================================================================ */

const banMemberHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId, userId: targetUserId } = req.params;
    const targetId = parseInt(targetUserId, 10);
    if (targetId === user.id) { res.status(400).json({ success: false, error: 'Cannot ban yourself' }); return; }
    const [requesterCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, user.id]);
    if ((requesterCheck as any[]).length === 0 || !['owner', 'admin'].includes((requesterCheck as any[])[0].role)) { res.status(403).json({ success: false, error: 'Only owners and admins can ban members' }); return; }
    const [targetCheck] = await DB.query(`SELECT role, status FROM mirror_group_members WHERE group_id = ? AND user_id = ?`, [groupId, targetId]);
    if ((targetCheck as any[]).length === 0) { res.status(404).json({ success: false, error: 'User not found in group' }); return; }
    const td = (targetCheck as any[])[0];
    if (td.role === 'owner') { res.status(403).json({ success: false, error: 'Cannot ban the owner' }); return; }
    if (td.role === 'admin' && (requesterCheck as any[])[0].role !== 'owner') { res.status(403).json({ success: false, error: 'Only owner can ban admins' }); return; }
    if (td.status === 'banned') { res.status(409).json({ success: false, error: 'Already banned' }); return; }
    if (td.status === 'active') {
      const r = await atomicRemoveMember(groupId, targetId, 'banned');
      if (!r.success) { res.status(500).json({ success: false, error: r.error }); return; }
    } else {
      await DB.query(`UPDATE mirror_group_members SET status = 'banned', left_at = NOW() WHERE group_id = ? AND user_id = ?`, [groupId, targetId]);
    }
    try { await groupEncryptionManager.revokeUserAccess(groupId, String(targetId)); } catch {}
    await DB.query(`UPDATE mirror_group_join_requests SET status = 'rejected', processed_by = ?, processed_at = NOW() WHERE group_id = ? AND user_id = ? AND status = 'pending'`, [user.id, groupId, targetId]).catch(() => {});
    res.json({ success: true, message: 'Member has been banned', data: { userId: targetId, status: 'banned' } });
  } catch (error) { console.error('Error banning member:', error); res.status(500).json({ success: false, error: 'Failed to ban member' }); }
};

/* ============================================================================
   UNBAN MEMBER - POST /:groupId/members/:userId/unban
============================================================================ */

const unbanMemberHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId, userId: targetUserId } = req.params;
    const targetId = parseInt(targetUserId, 10);
    const [requesterCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, user.id]);
    if ((requesterCheck as any[]).length === 0 || !['owner', 'admin'].includes((requesterCheck as any[])[0].role)) { res.status(403).json({ success: false, error: 'Only owners and admins can unban' }); return; }
    const [targetCheck] = await DB.query(`SELECT id FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'banned'`, [groupId, targetId]);
    if ((targetCheck as any[]).length === 0) { res.status(404).json({ success: false, error: 'User is not banned' }); return; }
    await DB.query(`UPDATE mirror_group_members SET status = 'left', left_at = NOW() WHERE group_id = ? AND user_id = ? AND status = 'banned'`, [groupId, targetId]);
    res.json({ success: true, message: 'Member unbanned. They can now rejoin.' });
  } catch (error) { console.error('Error unbanning:', error); res.status(500).json({ success: false, error: 'Failed to unban member' }); }
};

/* ============================================================================
   GET BANNED MEMBERS - GET /:groupId/banned
============================================================================ */

const getBannedMembersHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId } = req.params;
    const [requesterCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active' AND role IN ('owner', 'admin')`, [groupId, user.id]);
    if ((requesterCheck as any[]).length === 0) { res.status(403).json({ success: false, error: 'Only owners and admins can view banned members' }); return; }
    const [rows] = await DB.query(`SELECT gm.user_id, u.username, gm.left_at as banned_at FROM mirror_group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ? AND gm.status = 'banned' ORDER BY gm.left_at DESC`, [groupId]);
    res.json({ success: true, data: { banned: rows, total: (rows as any[]).length } });
  } catch (error) { console.error('Error fetching banned:', error); res.status(500).json({ success: false, error: 'Failed to fetch banned members' }); }
};

/* ============================================================================
   TRANSFER OWNERSHIP - POST /:groupId/transfer-ownership
============================================================================ */

const transferOwnershipHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
    const { groupId } = req.params;
    const { newOwnerId } = req.body;
    const targetId = parseInt(newOwnerId, 10);
    if (isNaN(targetId) || targetId === user.id) { res.status(400).json({ success: false, error: 'Invalid new owner' }); return; }
    const [groupRows] = await DB.query(`SELECT owner_user_id, name FROM mirror_groups WHERE id = ? AND status = 'active'`, [groupId]);
    if ((groupRows as any[]).length === 0) { res.status(404).json({ success: false, error: 'Group not found' }); return; }
    if (Number((groupRows as any[])[0].owner_user_id) !== Number(user.id)) { res.status(403).json({ success: false, error: 'Only the current owner can transfer' }); return; }
    const [targetCheck] = await DB.query(`SELECT role FROM mirror_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`, [groupId, targetId]);
    if ((targetCheck as any[]).length === 0) { res.status(404).json({ success: false, error: 'Target is not an active member' }); return; }
    const conn = await DB.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE mirror_groups SET owner_user_id = ?, updated_at = NOW() WHERE id = ?`, [targetId, groupId]);
      await conn.query(`UPDATE mirror_group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?`, [groupId, targetId]);
      await conn.query(`UPDATE mirror_group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?`, [groupId, user.id]);
      await conn.commit();
    } catch (txError) { await conn.rollback(); throw txError; } finally { conn.release(); }
    res.json({ success: true, message: 'Ownership transferred successfully' });
  } catch (error) { console.error('Error transferring ownership:', error); res.status(500).json({ success: false, error: 'Failed to transfer ownership' }); }
};

/* ============================================================================
   SHARE DATA TO GROUP - PRESERVED FROM EXISTING
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
      'personality', 'cognitive', 'facial', 'voice', 'astrological', 'profile', 'full_profile'
    ];

    const invalidTypes = typesToShare.filter(t => !validDataTypes.includes(t as ShareableDataType));
    if (invalidTypes.length > 0) {
      res.status(400).json({
        success: false,
        error: `Invalid data type(s): ${invalidTypes.join(', ')}. Valid types: ${validDataTypes.join(', ')}`
      });
      return;
    }

    const [memberCheck] = await DB.query(
      `SELECT role, status FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, user.id]
    );

    if ((memberCheck as any[]).length === 0) {
      res.status(403).json({ success: false, error: 'Not an active member of this group' });
      return;
    }

    const [keyRows] = await DB.query(
      `SELECT id, key_version FROM mirror_group_encryption_keys
       WHERE group_id = ? AND status = 'active'
       ORDER BY key_version DESC LIMIT 1`,
      [groupId]
    );

    if ((keyRows as any[]).length === 0) {
      res.status(500).json({ success: false, error: 'No active encryption key for this group' });
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
        console.error(`Error sharing ${extractedData.dataType}:`, error);
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
      console.error('Failed to queue analysis:', queueError);
    }

    res.json({
      success: true,
      message: `Successfully shared ${shareResults.length} data type(s) with group`,
      shares: shareResults,
      errors: shareErrors.length > 0 ? shareErrors : undefined,
      cached: extractionResult.cached
    });

  } catch (error) {
    console.error('Error sharing data with group:', error);
    res.status(500).json({ success: false, error: 'Failed to share data with group' });
  }
};

/* ============================================================================
   GET SHARED DATA - PRESERVED FROM EXISTING
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
    console.error('Error retrieving shared data:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve shared data' });
  }
};

/* ============================================================================
   GET DATA SUMMARY - PRESERVED FROM EXISTING
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
    console.error('Error getting data summary:', error);
    res.status(500).json({ success: false, error: 'Failed to get data summary' });
  }
};

/* ============================================================================
   ROUTE REGISTRATION - UPDATED WITH PHASE 6 ENDPOINTS
============================================================================ */

const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;
const basicSecurity = AuthMiddleware.requireSecurityLevel(SecurityLevel.BASIC) as unknown as RequestHandler;

// ---- Global UUID validation for :groupId param ----
router.param('groupId', (req: express.Request, res: express.Response, next: express.NextFunction, value: string) => {
  if (!isValidUUID(value)) {
    res.status(400).json({ success: false, error: 'Invalid group identifier', code: 'INVALID_GROUP_ID' });
    return;
  }
  next();
});

// ---- Per-user rate limiting for join endpoints ----
const joinRateLimits = new Map<string, number[]>();
const rateLimitedJoin: RequestHandler = ((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const user = (req as any).user;
  if (!user?.id) { next(); return; }
  const key = `join:${user.id}`;
  const now = Date.now();
  const window = 60000;
  const max = 10;
  const timestamps = (joinRateLimits.get(key) || []).filter(t => now - t < window);
  if (timestamps.length >= max) { res.status(429).json({ success: false, error: 'Too many join attempts. Please wait.' }); return; }
  timestamps.push(now);
  joinRateLimits.set(key, timestamps);
  next();
}) as RequestHandler;

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of joinRateLimits.entries()) {
    const active = timestamps.filter(t => now - t < 60000);
    if (active.length === 0) joinRateLimits.delete(key);
    else joinRateLimits.set(key, active);
  }
}, 300000);

// Phase 6: Public directory (must be before /:groupId to avoid param collision)
router.get('/directory', verified, searchPublicDirectoryHandler);

// Phase 1 routes
router.post('/create', verified, createGroupHandler);
router.get('/list', verified, listGroupsHandler);
router.get('/suggested', verified, getSuggestedGroupsHandler);
router.get('/my-invitations', verified, getMyInvitationsHandler);
router.get('/:groupId', verified, getGroupDetailsHandler);
router.post('/:groupId/invite', verified, inviteMemberHandler);
router.post('/:groupId/accept', verified, acceptInvitationHandler);
router.post('/:groupId/decline', verified, declineInvitationHandler);
router.put('/:groupId', verified, updateGroupHandler);
router.post('/:groupId/leave', verified, leaveGroupHandler);
router.delete('/:groupId', verified, deleteGroupHandler);
router.post('/join', verified, rateLimitedJoin, joinGroupHandler);
router.post('/:groupId/join', verified, rateLimitedJoin, joinGroupByIdHandler);
router.post('/:groupId/transfer-ownership', verified, transferOwnershipHandler);

// Phase 6: Join request management for public groups
router.post('/:groupId/request-join', verified, rateLimitedJoin, requestToJoinHandler);
router.get('/:groupId/join-requests', verified, getJoinRequestsHandler);
router.post('/:groupId/join-requests/:requestId/approve', verified, approveJoinRequestHandler);
router.post('/:groupId/join-requests/:requestId/reject', verified, rejectJoinRequestHandler);

// Member management endpoints
router.get('/:groupId/members', verified, getMembersHandler);
router.get('/:groupId/members/:memberId', verified, getMemberDetailsHandler);
router.delete('/:groupId/members/:userId', verified, removeMemberHandler);
router.put('/:groupId/members/:userId/role', verified, updateMemberRoleHandler);
router.post('/:groupId/members/:userId/ban', verified, banMemberHandler);
router.post('/:groupId/members/:userId/unban', verified, unbanMemberHandler);
router.get('/:groupId/banned', verified, getBannedMembersHandler);

// Phase 2 routes
router.post('/:groupId/share-data', verified, basicSecurity, shareDataHandler);
router.get('/:groupId/shared-data', verified, getSharedDataHandler);
router.get('/data-summary', verified, getDataSummaryHandler);

export default router;
