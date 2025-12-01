// ============================================================================
// GROUP VOTES API ROUTES - PHASE 4
// ============================================================================
// File: routes/groupVotes.ts
// ----------------------------------------------------------------------------
// Handles group voting functionality:
// - Propose new votes
// - Cast votes
// - Get vote details and results
// - Vote history
// ============================================================================

import express, { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DB } from '../db';
import AuthMiddleware from '../middleware/authMiddleware';
import { mirrorGroupNotifications } from '../systems/mirrorGroupNotifications';
import { mirrorRedis } from '../config/redis';

const router = express.Router();

// ============================================================================
// TYPES
// ============================================================================

interface VoteProposal {
  topic: string;
  argument?: string;
  voteType?: 'yes_no' | 'multiple_choice' | 'rating';
  options?: string[];
  durationSeconds?: number;
  minValue?: number;
  maxValue?: number;
}

interface VoteCast {
  response: string;
  responseIndex?: number;
}

interface VoteResult {
  id: string;
  groupId: string;
  topic: string;
  argument?: string;
  voteType: string;
  options?: string[];
  status: string;
  durationSeconds: number;
  createdAt: Date;
  expiresAt: Date;
  completedAt?: Date;
  proposer: {
    id: number;
    username: string;
  };
  results?: any;
  participationRate?: number;
  userVote?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function safeJsonParse<T = any>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

async function verifyGroupMembership(groupId: string, userId: number): Promise<boolean> {
  try {
    const [rows] = await DB.query(
      `SELECT id FROM mirror_group_members
       WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [groupId, userId]
    );
    return (rows as any[]).length > 0;
  } catch (error) {
    console.error('❌ Error verifying group membership:', error);
    return false;
  }
}

async function getGroupActiveMembers(groupId: string): Promise<number[]> {
  try {
    const [rows] = await DB.query(
      `SELECT user_id FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );
    return (rows as any[]).map(r => r.user_id);
  } catch (error) {
    console.error('❌ Error getting group members:', error);
    return [];
  }
}

// ============================================================================
// VOTE TIMER MANAGEMENT
// ============================================================================

const activeVoteTimers = new Map<string, NodeJS.Timeout>();

/**
 * Start a timer to auto-complete vote when duration expires
 */
function startVoteTimer(voteId: string, expiresAt: Date, groupId: string): void {
  const now = Date.now();
  const expiryTime = new Date(expiresAt).getTime();
  const delay = Math.max(0, expiryTime - now);

  console.log(`⏱️ Starting vote timer for ${voteId}, expires in ${Math.round(delay / 1000)}s`);

  const timer = setTimeout(async () => {
    try {
      await completeVote(voteId, groupId);
    } catch (error) {
      console.error('❌ Error in vote timer callback:', error);
    }
  }, delay);

  activeVoteTimers.set(voteId, timer);
}

/**
 * Cancel a vote timer
 */
function cancelVoteTimer(voteId: string): void {
  const timer = activeVoteTimers.get(voteId);
  if (timer) {
    clearTimeout(timer);
    activeVoteTimers.delete(voteId);
    console.log(`⏱️ Cancelled timer for vote ${voteId}`);
  }
}

/**
 * Complete a vote and broadcast results
 */
async function completeVote(voteId: string, groupId: string): Promise<void> {
  console.log(`✅ Completing vote ${voteId}`);

  try {
    // Get vote info
    const [voteRows] = await DB.query(
      `SELECT * FROM mirror_group_votes WHERE id = ?`,
      [voteId]
    );

    if ((voteRows as any[]).length === 0) {
      console.error('Vote not found:', voteId);
      return;
    }

    const vote = (voteRows as any[])[0];

    if (vote.status !== 'active') {
      console.log(`Vote ${voteId} already ${vote.status}`);
      return;
    }

    // Get total members
    const [memberRows] = await DB.query(
      `SELECT COUNT(*) as count FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );
    const totalMembers = (memberRows as any[])[0]?.count || 0;

    // Get responses
    const [responseRows] = await DB.query(
      `SELECT response, COUNT(*) as count
       FROM mirror_group_vote_responses
       WHERE vote_id = ?
       GROUP BY response`,
      [voteId]
    );

    // Calculate results
    const results: Record<string, number> = {};
    let totalResponses = 0;

    for (const row of responseRows as any[]) {
      results[row.response] = row.count;
      totalResponses += row.count;
    }

    const participationRate = totalMembers > 0
      ? (totalResponses / totalMembers) * 100
      : 0;

    // Build formatted results
    let finalResults: any;

    if (vote.vote_type === 'yes_no') {
      finalResults = {
        yes: results['yes'] || 0,
        no: results['no'] || 0,
        total: totalResponses,
        totalMembers,
        winner: (results['yes'] || 0) > (results['no'] || 0) ? 'yes' : 'no'
      };
    } else if (vote.vote_type === 'multiple_choice') {
      const options = safeJsonParse(vote.options, []);
      finalResults = {
        options: options.map((opt: string) => ({
          option: opt,
          count: results[opt] || 0,
          percentage: totalResponses > 0
            ? Math.round(((results[opt] || 0) / totalResponses) * 100)
            : 0
        })),
        total: totalResponses,
        totalMembers,
        winner: options.reduce((max: string, opt: string) =>
          (results[opt] || 0) > (results[max] || 0) ? opt : max,
          options[0] || ''
        )
      };
    } else {
      // Rating type
      finalResults = {
        votes: results,
        total: totalResponses,
        totalMembers
      };
    }

    // Update vote status
    await DB.query(
      `UPDATE mirror_group_votes
       SET status = 'completed',
           completed_at = NOW(),
           final_results = ?,
           participation_rate = ?
       WHERE id = ?`,
      [JSON.stringify(finalResults), participationRate, voteId]
    );

    // Broadcast results to all group members
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'vote:completed',
        payload: {
          voteId,
          groupId,
          topic: vote.topic,
          results: finalResults,
          participationRate: Math.round(participationRate),
          completedAt: new Date().toISOString()
        }
      });
    }

    // Also broadcast via Redis for WebSocket delivery
    await mirrorRedis.publish('mirror:group:events', JSON.stringify({
      type: 'vote:completed',
      groupId,
      voteId,
      results: finalResults,
      participationRate: Math.round(participationRate)
    }));

    // Clean up timer
    cancelVoteTimer(voteId);

  } catch (error) {
    console.error('❌ Error completing vote:', error);
    throw error;
  }
}

// ============================================================================
// PROPOSE VOTE
// ============================================================================

const proposeVoteHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const proposal: VoteProposal = req.body;

    // Validate required fields
    if (!proposal.topic || typeof proposal.topic !== 'string' || proposal.topic.trim().length === 0) {
      res.status(400).json({ success: false, error: 'Topic is required' });
      return;
    }

    if (proposal.topic.length > 200) {
      res.status(400).json({ success: false, error: 'Topic must be 200 characters or less' });
      return;
    }

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Check for active votes (only one active vote per group at a time)
    const [activeVotes] = await DB.query(
      `SELECT id FROM mirror_group_votes
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );

    if ((activeVotes as any[]).length > 0) {
      res.status(409).json({
        success: false,
        error: 'A vote is already in progress. Please wait for it to complete.'
      });
      return;
    }

    // Set defaults
    const voteType = proposal.voteType || 'yes_no';
    const durationSeconds = Math.min(
      Math.max(proposal.durationSeconds || 60, 10),  // Min 10 seconds
      300  // Max 5 minutes
    );

    // Validate options for multiple choice
    if (voteType === 'multiple_choice') {
      if (!proposal.options || !Array.isArray(proposal.options) || proposal.options.length < 2) {
        res.status(400).json({
          success: false,
          error: 'Multiple choice votes require at least 2 options'
        });
        return;
      }
      if (proposal.options.length > 10) {
        res.status(400).json({
          success: false,
          error: 'Maximum 10 options allowed'
        });
        return;
      }
    }

    // Create vote
    const voteId = uuidv4();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + durationSeconds * 1000);

    await DB.query(
      `INSERT INTO mirror_group_votes (
        id, group_id, proposer_user_id, topic, argument,
        vote_type, options, duration_seconds, status,
        created_at, expires_at, min_value, max_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        voteId,
        groupId,
        user.id,
        proposal.topic.trim(),
        proposal.argument || null,
        voteType,
        voteType === 'multiple_choice' ? JSON.stringify(proposal.options) : null,
        durationSeconds,
        createdAt,
        expiresAt,
        proposal.minValue || null,
        proposal.maxValue || null
      ]
    );

    // Start auto-complete timer
    startVoteTimer(voteId, expiresAt, groupId);

    // Get proposer username
    const [userRows] = await DB.query(
      `SELECT username FROM users WHERE id = ?`,
      [user.id]
    );
    const proposerUsername = (userRows as any[])[0]?.username || 'Unknown';

    // Broadcast vote proposal to all group members
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'vote:proposed',
        payload: {
          voteId,
          groupId,
          topic: proposal.topic,
          argument: proposal.argument,
          voteType,
          options: proposal.options,
          proposer: {
            id: user.id,
            username: proposerUsername
          },
          durationSeconds,
          expiresAt: expiresAt.toISOString()
        }
      });
    }

    // Also broadcast via Redis for WebSocket
    await mirrorRedis.publish('mirror:group:events', JSON.stringify({
      type: 'vote:proposed',
      groupId,
      voteId,
      topic: proposal.topic,
      expiresAt: expiresAt.toISOString()
    }));

    res.json({
      success: true,
      data: {
        voteId,
        topic: proposal.topic,
        voteType,
        options: proposal.options,
        durationSeconds,
        expiresAt: expiresAt.toISOString(),
        message: `Vote created. Members have ${durationSeconds} seconds to respond.`
      }
    });

  } catch (error) {
    console.error('❌ Error creating vote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create vote',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// CAST VOTE
// ============================================================================

const castVoteHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, voteId } = req.params;
    const { response, responseIndex }: VoteCast = req.body;

    // Validate response
    if (!response || typeof response !== 'string') {
      res.status(400).json({ success: false, error: 'Response is required' });
      return;
    }

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get vote info
    const [voteRows] = await DB.query(
      `SELECT * FROM mirror_group_votes WHERE id = ? AND group_id = ?`,
      [voteId, groupId]
    );

    if ((voteRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Vote not found' });
      return;
    }

    const vote = (voteRows as any[])[0];

    // Check if vote is still active
    if (vote.status !== 'active') {
      res.status(410).json({
        success: false,
        error: `Vote has already ${vote.status}`,
        code: 'VOTE_CLOSED'
      });
      return;
    }

    // Check if vote has expired
    const now = new Date();
    if (new Date(vote.expires_at) < now) {
      res.status(410).json({
        success: false,
        error: 'Vote has expired',
        code: 'VOTE_EXPIRED'
      });
      return;
    }

    // Validate response based on vote type
    if (vote.vote_type === 'yes_no') {
      if (!['yes', 'no'].includes(response.toLowerCase())) {
        res.status(400).json({
          success: false,
          error: 'Response must be "yes" or "no"'
        });
        return;
      }
    } else if (vote.vote_type === 'multiple_choice') {
      const options = safeJsonParse(vote.options, []);
      if (!options.includes(response)) {
        res.status(400).json({
          success: false,
          error: 'Invalid option selected',
          validOptions: options
        });
        return;
      }
    }

    // Check if user already voted
    const [existingVote] = await DB.query(
      `SELECT id FROM mirror_group_vote_responses WHERE vote_id = ? AND user_id = ?`,
      [voteId, user.id]
    );

    if ((existingVote as any[]).length > 0) {
      res.status(409).json({
        success: false,
        error: 'You have already voted',
        code: 'ALREADY_VOTED'
      });
      return;
    }

    // Record vote
    const responseId = uuidv4();
    await DB.query(
      `INSERT INTO mirror_group_vote_responses (
        id, vote_id, user_id, response, response_index
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        responseId,
        voteId,
        user.id,
        vote.vote_type === 'yes_no' ? response.toLowerCase() : response,
        responseIndex || null
      ]
    );

    // Get current vote count
    const [countRows] = await DB.query(
      `SELECT COUNT(*) as count FROM mirror_group_vote_responses WHERE vote_id = ?`,
      [voteId]
    );
    const totalVotes = (countRows as any[])[0]?.count || 0;

    // Get total members
    const [memberRows] = await DB.query(
      `SELECT COUNT(*) as count FROM mirror_group_members
       WHERE group_id = ? AND status = 'active'`,
      [groupId]
    );
    const totalMembers = (memberRows as any[])[0]?.count || 0;

    // Calculate remaining time
    const remainingSeconds = Math.max(0,
      Math.floor((new Date(vote.expires_at).getTime() - now.getTime()) / 1000)
    );

    // Broadcast vote cast event (without revealing who voted what)
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'vote:cast',
        payload: {
          voteId,
          groupId,
          totalVotes,
          totalMembers,
          remainingSeconds,
          percentage: Math.round((totalVotes / totalMembers) * 100)
        }
      });
    }

    // Check if everyone has voted
    if (totalVotes >= totalMembers) {
      // Complete vote early
      await completeVote(voteId, groupId);
    }

    res.json({
      success: true,
      data: {
        message: 'Vote recorded',
        totalVotes,
        totalMembers,
        remainingSeconds
      }
    });

  } catch (error) {
    console.error('❌ Error casting vote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cast vote',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET VOTE DETAILS
// ============================================================================

const getVoteHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, voteId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get vote with proposer info
    const [voteRows] = await DB.query(
      `SELECT v.*, u.username as proposer_username
       FROM mirror_group_votes v
       JOIN users u ON v.proposer_user_id = u.id
       WHERE v.id = ? AND v.group_id = ?`,
      [voteId, groupId]
    );

    if ((voteRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Vote not found' });
      return;
    }

    const vote = (voteRows as any[])[0];

    // Get user's vote if exists
    const [userVoteRows] = await DB.query(
      `SELECT response FROM mirror_group_vote_responses
       WHERE vote_id = ? AND user_id = ?`,
      [voteId, user.id]
    );
    const userVote = (userVoteRows as any[])[0]?.response || null;

    // Get current tally if vote is active
    let currentTally: Record<string, number> | null = null;
    if (vote.status === 'active') {
      const [tallyRows] = await DB.query(
        `SELECT response, COUNT(*) as count
         FROM mirror_group_vote_responses
         WHERE vote_id = ?
         GROUP BY response`,
        [voteId]
      );

      currentTally = {};
      let total = 0;
      for (const row of tallyRows as any[]) {
        currentTally[row.response] = row.count;
        total += row.count;
      }
      currentTally['_total'] = total;
    }

    // Calculate remaining time
    const now = new Date();
    const expiresAt = new Date(vote.expires_at);
    const remainingSeconds = vote.status === 'active'
      ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))
      : 0;

    const result: VoteResult = {
      id: vote.id,
      groupId: vote.group_id,
      topic: vote.topic,
      argument: vote.argument,
      voteType: vote.vote_type,
      options: safeJsonParse(vote.options, undefined),
      status: vote.status,
      durationSeconds: vote.duration_seconds,
      createdAt: vote.created_at,
      expiresAt: vote.expires_at,
      completedAt: vote.completed_at,
      proposer: {
        id: vote.proposer_user_id,
        username: vote.proposer_username
      },
      results: vote.status === 'completed'
        ? safeJsonParse(vote.final_results, null)
        : currentTally,
      participationRate: vote.participation_rate,
      userVote
    };

    res.json({
      success: true,
      data: {
        vote: result,
        remainingSeconds
      }
    });

  } catch (error) {
    console.error('❌ Error getting vote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get vote',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET VOTE HISTORY
// ============================================================================

const getVoteHistoryHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string; // Optional filter

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Build query
    let query = `
      SELECT v.*, u.username as proposer_username
      FROM mirror_group_votes v
      JOIN users u ON v.proposer_user_id = u.id
      WHERE v.group_id = ?
    `;
    const params: any[] = [groupId];

    if (status && ['active', 'completed', 'cancelled', 'expired'].includes(status)) {
      query += ` AND v.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY v.created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [voteRows] = await DB.query(query, params);

    // Get user's votes
    const voteIds = (voteRows as any[]).map(v => v.id);
    let userVotes: Record<string, string> = {};

    if (voteIds.length > 0) {
      const [userVoteRows] = await DB.query(
        `SELECT vote_id, response
         FROM mirror_group_vote_responses
         WHERE vote_id IN (?) AND user_id = ?`,
        [voteIds, user.id]
      );

      for (const row of userVoteRows as any[]) {
        userVotes[row.vote_id] = row.response;
      }
    }

    // Format results
    const votes: VoteResult[] = (voteRows as any[]).map(vote => ({
      id: vote.id,
      groupId: vote.group_id,
      topic: vote.topic,
      argument: vote.argument,
      voteType: vote.vote_type,
      options: safeJsonParse(vote.options, undefined),
      status: vote.status,
      durationSeconds: vote.duration_seconds,
      createdAt: vote.created_at,
      expiresAt: vote.expires_at,
      completedAt: vote.completed_at,
      proposer: {
        id: vote.proposer_user_id,
        username: vote.proposer_username
      },
      results: safeJsonParse(vote.final_results, null),
      participationRate: vote.participation_rate,
      userVote: userVotes[vote.id]
    }));

    // Get total count
    const [countRows] = await DB.query(
      `SELECT COUNT(*) as count FROM mirror_group_votes WHERE group_id = ?`,
      [groupId]
    );
    const totalCount = (countRows as any[])[0]?.count || 0;

    res.json({
      success: true,
      data: {
        votes,
        pagination: {
          total: totalCount,
          limit,
          offset,
          hasMore: offset + votes.length < totalCount
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting vote history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get vote history',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// CANCEL VOTE (Proposer only)
// ============================================================================

const cancelVoteHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId, voteId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get vote
    const [voteRows] = await DB.query(
      `SELECT * FROM mirror_group_votes WHERE id = ? AND group_id = ?`,
      [voteId, groupId]
    );

    if ((voteRows as any[]).length === 0) {
      res.status(404).json({ success: false, error: 'Vote not found' });
      return;
    }

    const vote = (voteRows as any[])[0];

    // Only proposer can cancel
    if (vote.proposer_user_id !== user.id) {
      res.status(403).json({
        success: false,
        error: 'Only the proposer can cancel a vote'
      });
      return;
    }

    // Only active votes can be cancelled
    if (vote.status !== 'active') {
      res.status(400).json({
        success: false,
        error: `Cannot cancel a ${vote.status} vote`
      });
      return;
    }

    // Cancel the vote
    await DB.query(
      `UPDATE mirror_group_votes SET status = 'cancelled', completed_at = NOW() WHERE id = ?`,
      [voteId]
    );

    // Cancel timer
    cancelVoteTimer(voteId);

    // Broadcast cancellation
    const members = await getGroupActiveMembers(groupId);
    for (const memberId of members) {
      await mirrorGroupNotifications.notify(memberId, {
        type: 'vote:cancelled',
        payload: {
          voteId,
          groupId,
          topic: vote.topic,
          cancelledBy: user.id
        }
      });
    }

    res.json({
      success: true,
      data: {
        message: 'Vote cancelled',
        voteId
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling vote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel vote',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// GET ACTIVE VOTE (Quick check)
// ============================================================================

const getActiveVoteHandler: RequestHandler = async (req, res) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const { groupId } = req.params;

    // Verify membership
    const isMember = await verifyGroupMembership(groupId, user.id);
    if (!isMember) {
      res.status(403).json({ success: false, error: 'Not a member of this group' });
      return;
    }

    // Get active vote
    const [voteRows] = await DB.query(
      `SELECT v.*, u.username as proposer_username
       FROM mirror_group_votes v
       JOIN users u ON v.proposer_user_id = u.id
       WHERE v.group_id = ? AND v.status = 'active'
       ORDER BY v.created_at DESC
       LIMIT 1`,
      [groupId]
    );

    if ((voteRows as any[]).length === 0) {
      res.json({
        success: true,
        data: {
          hasActiveVote: false,
          vote: null
        }
      });
      return;
    }

    const vote = (voteRows as any[])[0];

    // Check if user has voted
    const [userVoteRows] = await DB.query(
      `SELECT response FROM mirror_group_vote_responses
       WHERE vote_id = ? AND user_id = ?`,
      [vote.id, user.id]
    );
    const userVote = (userVoteRows as any[])[0]?.response || null;

    // Calculate remaining time
    const now = new Date();
    const remainingSeconds = Math.max(0,
      Math.floor((new Date(vote.expires_at).getTime() - now.getTime()) / 1000)
    );

    res.json({
      success: true,
      data: {
        hasActiveVote: true,
        vote: {
          id: vote.id,
          topic: vote.topic,
          argument: vote.argument,
          voteType: vote.vote_type,
          options: safeJsonParse(vote.options, undefined),
          proposer: {
            id: vote.proposer_user_id,
            username: vote.proposer_username
          },
          remainingSeconds,
          hasVoted: !!userVote,
          userVote
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting active vote:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active vote',
      details: (error as Error).message
    });
  }
};

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

const verified = AuthMiddleware.verifyToken as unknown as RequestHandler;

// Vote routes
router.post('/groups/:groupId/votes/propose', verified, proposeVoteHandler);
router.post('/groups/:groupId/votes/:voteId/cast', verified, castVoteHandler);
router.get('/groups/:groupId/votes/:voteId', verified, getVoteHandler);
router.get('/groups/:groupId/votes', verified, getVoteHistoryHandler);
router.delete('/groups/:groupId/votes/:voteId', verified, cancelVoteHandler);
router.get('/groups/:groupId/votes/active', verified, getActiveVoteHandler);

export default router;
