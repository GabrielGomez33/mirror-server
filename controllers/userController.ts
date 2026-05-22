// controllers/userController.ts
//
// CHANGES vs previous version (Phase 2a — account deletion hardening):
//   - deleteUserFromDB is now transactional and explicitly purges every
//     dependent table BEFORE deleting the users row. The previous version
//     trusted `ON DELETE CASCADE` to clean up downstream tables, but in
//     production at least one FK was missing/restrictive, which made the
//     final `DELETE FROM users` blow up with a 500 after directories and
//     TruthStream were already cleaned up — leaving the account in a
//     half-deleted state.
//   - Missing-table errors are tolerated per-step so a fresh environment
//     (or one mid-migration) does not break the whole flow.
//   - Returns nothing on success; throws with a descriptive message on
//     failure so authController.deleteAccount can surface it.
//
// PRESERVED: createUserInDB, userLogin, createJWT, updateUserPassword,
// updateUserEmail, fetchUserInfo, searchUsers, all handlers.
//

import bcrypt from 'bcrypt';
import path from 'path';
import jwt from 'jsonwebtoken';
import { RequestHandler } from 'express';
import { ResultSetHeader, FieldPacket } from 'mysql2/promise';

import { DB } from '../db';
import { generateUserKeys } from './encryptionController';
import { createUserDirectories, deleteUserDirectories, DataAccessContext } from './directoryController';
import { cleanupUserTruthStreamData } from './truthstreamController';
const basePath = path.join(process.env.MIRRORSTORAGE!);
const storagePath = path.join(basePath, 'users');
const SALT_ROUNDS = 10;

// === CORE LOGIC FUNCTIONS ===

export async function createUserInDB(username: string, email: string, password: string): Promise<number> {
  console.log(`[CreateUserInDb()]: Attempting to create account for ${username}`);

  const [existing] = await DB.query('SELECT id FROM users WHERE email=?', [email]);
  if ((existing as any[]).length > 0) {
    throw new Error('EMAIL_ALREADY_REGISTERED');
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const [result] = await DB.query<ResultSetHeader>(
    'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [username, email, hashedPassword]
  )
	
  // Get the inserted user ID
  const userId = result.insertId;
  console.log(`[New user created with] -> ID:${userId}`);

  // Create user directories and keys
  await createUserDirectories(userId.toString(), storagePath);
  await generateUserKeys(userId.toString(), storagePath);

  // Return the user ID
  return userId;
}

export async function deleteUserFromDB(userId: string, adminUserId: number): Promise<void> {
  console.log(`[DeleteUserFromDB]: Attempting to delete user ${userId}`);

  const userIdNum = parseInt(userId, 10);
  if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
    throw new Error(`Invalid userId: ${userId}`);
  }

  // ----------------------------------------------------------------------
  // Phase 1: filesystem cleanup (idempotent — secureDeleteDirectory uses
  // fs.rm with { force: true } so a missing dir is fine on retry).
  // ----------------------------------------------------------------------
  try {
    const context: DataAccessContext = {
      userId: userIdNum,
      accessedBy: adminUserId,
      reason: 'user_account_deletion'
    };
    await deleteUserDirectories(userId, context);
  } catch (fsError) {
    // Filesystem cleanup is best-effort. We log and continue — the user
    // is still entitled to have their DB rows removed even if the disk
    // delete partially failed.
    console.warn(`[DeleteUserFromDB]: directory cleanup warning for user ${userId}:`, fsError);
  }

  // ----------------------------------------------------------------------
  // Phase 2: TruthStream cleanup (re-anonymises reviews this user wrote
  // for others; cascades on rows they own). Already idempotent.
  // ----------------------------------------------------------------------
  try {
    await cleanupUserTruthStreamData(userIdNum);
    console.log(`[DeleteUserFromDB]: TruthStream data cleaned up for user ${userId}`);
  } catch (tsError) {
    console.warn(`[DeleteUserFromDB]: TruthStream cleanup warning for user ${userId}:`, tsError);
  }

  // ----------------------------------------------------------------------
  // Phase 3: transactional DB purge.
  //
  // Why explicit deletes when most FKs say ON DELETE CASCADE? Because at
  // least one table in production does not (or has been re-created without
  // the CASCADE rule), and a single restrictive FK is enough to block the
  // final `DELETE FROM users`. The previous implementation trusted CASCADE
  // and surfaced a 500 to the client after directories and TruthStream had
  // already been cleaned up, leaving zombie accounts.
  //
  // We list every known per-user table. Tables protected by CASCADE on
  // users(id) become no-ops here (CASCADE has already wiped them). Tables
  // NOT protected by CASCADE are wiped explicitly. Missing tables are
  // tolerated.
  //
  // Order: child tables that reference *other* mirror-server tables go
  // first (e.g. group_message_reactions before mirror_group_messages),
  // then per-user-owned tables, finally users itself.
  // ----------------------------------------------------------------------
  type Step = { sql: string; params: any[]; tolerant: boolean; label: string };

  const steps: Step[] = [
    // -- Session / auth state ------------------------------------------
    { label: 'user_sessions', tolerant: true,
      sql: 'DELETE FROM user_sessions WHERE user_id = ?', params: [userIdNum] },
    { label: 'email_verification_tokens', tolerant: true,
      sql: 'DELETE FROM email_verification_tokens WHERE user_id = ?', params: [userIdNum] },
    { label: 'password_reset_tokens', tolerant: true,
      sql: 'DELETE FROM password_reset_tokens WHERE user_id = ?', params: [userIdNum] },

    // -- Activity / audit / access logs ---------------------------------
    { label: 'activity_logs', tolerant: true,
      sql: 'DELETE FROM activity_logs WHERE user_id = ?', params: [userIdNum] },
    { label: 'data_access_log[user_id]', tolerant: true,
      sql: 'DELETE FROM data_access_log WHERE user_id = ?', params: [userIdNum] },
    { label: 'data_access_log[accessed_by]', tolerant: true,
      sql: 'DELETE FROM data_access_log WHERE accessed_by = ?', params: [userIdNum] },

    // -- Intake / personal analyses ------------------------------------
    { label: 'intake_metadata', tolerant: true,
      sql: 'DELETE FROM intake_metadata WHERE user_id = ?', params: [userIdNum] },
    { label: 'personal_analyses', tolerant: true,
      sql: 'DELETE FROM personal_analyses WHERE user_id = ?', params: [userIdNum] },

    // -- Subscriptions / usage -----------------------------------------
    { label: 'subscription_events', tolerant: true,
      sql: 'DELETE FROM subscription_events WHERE user_id = ?', params: [userIdNum] },
    { label: 'subscriptions', tolerant: true,
      sql: 'DELETE FROM subscriptions WHERE user_id = ?', params: [userIdNum] },
    { label: 'user_subscriptions', tolerant: true,
      sql: 'DELETE FROM user_subscriptions WHERE user_id = ?', params: [userIdNum] },
    { label: 'usage_tracking', tolerant: true,
      sql: 'DELETE FROM usage_tracking WHERE user_id = ?', params: [userIdNum] },

    // -- Notifications --------------------------------------------------
    { label: 'user_notification_preferences', tolerant: true,
      sql: 'DELETE FROM user_notification_preferences WHERE user_id = ?', params: [userIdNum] },
    { label: 'push_subscriptions', tolerant: true,
      sql: 'DELETE FROM push_subscriptions WHERE user_id = ?', params: [userIdNum] },

    // -- Journal --------------------------------------------------------
    { label: 'mirror_journal_analytics', tolerant: true,
      sql: 'DELETE FROM mirror_journal_analytics WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_journal_entries', tolerant: true,
      sql: 'DELETE FROM mirror_journal_entries WHERE user_id = ?', params: [userIdNum] },

    // -- Group chat children (CASCADE-covered but explicit is safe) ----
    { label: 'mirror_group_message_reactions', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_reactions WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_message_reads', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_reads WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_typing_indicators', tolerant: true,
      sql: 'DELETE FROM mirror_group_typing_indicators WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_presence', tolerant: true,
      sql: 'DELETE FROM mirror_group_presence WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_message_mentions', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_mentions WHERE mentioned_user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_message_pins[pinned_by]', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_pins WHERE pinned_by_user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_message_attachments[uploader]', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_attachments WHERE uploader_user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_chat_preferences', tolerant: true,
      sql: 'DELETE FROM mirror_group_chat_preferences WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_message_queue', tolerant: true,
      sql: 'DELETE FROM mirror_group_message_queue WHERE recipient_user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_messages[sender]', tolerant: true,
      sql: 'DELETE FROM mirror_group_messages WHERE sender_user_id = ?', params: [userIdNum] },

    // -- Group membership / requests / shared data ---------------------
    { label: 'mirror_group_shared_data', tolerant: true,
      sql: 'DELETE FROM mirror_group_shared_data WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_join_requests', tolerant: true,
      sql: 'DELETE FROM mirror_group_join_requests WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_members', tolerant: true,
      sql: 'DELETE FROM mirror_group_members WHERE user_id = ?', params: [userIdNum] },

    // -- Vote / insight / transcript children (TS module covers some) --
    { label: 'mirror_group_votes_responses', tolerant: true,
      sql: 'DELETE FROM mirror_group_votes_responses WHERE user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_vote_proposals', tolerant: true,
      sql: 'DELETE FROM mirror_group_vote_proposals WHERE proposer_user_id = ?', params: [userIdNum] },
    { label: 'mirror_group_transcripts', tolerant: true,
      sql: 'DELETE FROM mirror_group_transcripts WHERE speaker_user_id = ?', params: [userIdNum] },

    // -- Groups owned BY this user (created_by). Children CASCADE on
    //    mirror_groups, so this last group delete clears any remaining
    //    rows in subsidiary tables. -------------------------------------
    { label: 'mirror_groups[created_by]', tolerant: true,
      sql: 'DELETE FROM mirror_groups WHERE created_by = ?', params: [userIdNum] },

    // -- Finally: users -------------------------------------------------
    { label: 'users', tolerant: false,
      sql: 'DELETE FROM users WHERE id = ?', params: [userIdNum] },
  ];

  const connection = await DB.getConnection();
  try {
    await connection.beginTransaction();

    for (const step of steps) {
      try {
        const [result] = await connection.query(step.sql, step.params);
        const affected = Number((result as any)?.affectedRows ?? 0);
        if (affected > 0) {
          console.log(`[DeleteUserFromDB]: ${step.label} -> ${affected} row(s) deleted`);
        }
      } catch (stepErr: any) {
        const msg: string = stepErr?.message || String(stepErr);
        const code: string = stepErr?.code || '';

        // Tables that don't exist in this environment are tolerated.
        const isMissingTable =
          code === 'ER_NO_SUCH_TABLE'
          || code === 'ER_BAD_FIELD_ERROR'
          || /doesn't exist|Unknown column/i.test(msg);

        if (step.tolerant && isMissingTable) {
          console.warn(`[DeleteUserFromDB]: skipping ${step.label} — ${msg.slice(0, 160)}`);
          continue;
        }

        // Anything else is fatal — roll the whole thing back so we don't
        // half-delete the account.
        throw new Error(`${step.label}: ${msg}`);
      }
    }

    await connection.commit();
    console.log(`[DeleteUserFromDB]: Successfully deleted user ${userId}`);
  } catch (error) {
    try { await connection.rollback(); } catch { /* non-fatal */ }
    console.error(`[DeleteUserFromDB ERROR]: Failed to delete user ${userId}:`, error);
    throw new Error(`Failed to delete user: ${(error as Error).message}`);
  } finally {
    try { connection.release(); } catch { /* non-fatal */ }
  }
}

export async function userLogin(email: string, password: string): Promise<string> {
  const [rows] = await DB.query('SELECT * FROM users WHERE email=?', [email]);
  const user = (rows as any[])[0];

  if (!user) throw new Error('INVALID CREDENTIALS');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw new Error('INVALID CREDENTIALS');

  const token = createJWT(user.id, user.email);
  await updateLastLogin(email);

  return token;
}

export function createJWT(id: number, email: string): string {
  return jwt.sign({ id, email }, process.env.JWT_KEY!, { expiresIn: '1h' });
}

async function updateLastLogin(email: string): Promise<void> {
  const now = new Date();
  await DB.query('UPDATE users SET last_login = ? WHERE email = ?', [now, email]);
}

export async function updateUserPassword(userId: string, newPassword: string): Promise<void> {
  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await DB.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, userId]);
}

export async function updateUserEmail(userId: string, newEmail: string): Promise<void> {
  const [existing] = await DB.query('SELECT id FROM users WHERE email = ?', [newEmail]);
  if ((existing as any[]).length > 0) {
    throw new Error('EMAIL ALREADY REGISTERED');
  }
  await DB.query('UPDATE users SET email = ? WHERE id = ?', [newEmail, userId]);
}

export async function fetchUserInfo(email: string): Promise<{ id: number; email: string; username: string; intakeCompleted: boolean }> {
  const [rows] = await DB.query('SELECT id, email, username, intake_completed FROM users WHERE email = ?', [email]);
  const users = rows as any[];

  if (users.length === 0) {
    throw new Error('User not found');
  }

  return {
    id: users[0].id,
    email: users[0].email,
    username: users[0].username,
    intakeCompleted: Boolean(users[0].intake_completed)
  };
}

// === EXPRESS HANDLERS ===

export const updateUserPasswordHandler: RequestHandler = async (req, res) => {
  const { userId, newPassword } = req.body;

  if (!userId || !newPassword) {
    res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  try {
    await updateUserPassword(userId, newPassword);
    res.status(200).json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[Password Update Error]', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
};

export const updateUserEmailHandler: RequestHandler = async (req, res) => {
  const { userId, newEmail } = req.body;

  if (!userId || !newEmail) {
    res.status(400).json({ error: 'Missing parameters' });
    return;
  }

  try {
    await updateUserEmail(userId, newEmail);
    res.status(200).json({ message: 'Email updated successfully' });
  } catch (err) {
    console.error('[Email Update Error]', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
};

export const deleteUserHandler: RequestHandler = async (req, res) => {
  const { userId, adminUserId } = req.body;

  if (!userId) {
    res.status(400).json({ error: 'Missing userId' });
    return;
  }

  // If adminUserId is not provided, assume the user is deleting their own account
  const effectiveAdminUserId = adminUserId || parseInt(userId);

  try {
    await deleteUserFromDB(userId, effectiveAdminUserId);
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('[User Deletion Error]', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

// === USER SEARCH ===

export async function searchUsers(query: string, limit: number = 10): Promise<{ id: number; username: string }[]> {
  if (!query || query.length < 2) {
    return [];
  }

  const searchPattern = `%${query}%`;
  const [rows] = await DB.query(
    `SELECT id, username FROM users
     WHERE username LIKE ?
     ORDER BY username ASC
     LIMIT ?`,
    [searchPattern, limit]
  );

  return (rows as any[]).map(row => ({
    id: row.id,
    username: row.username
  }));
}

export const searchUsersHandler: RequestHandler = async (req, res) => {
  const user = (req as any).user;
  if (!user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { q, limit } = req.query;
  const query = String(q || '');
  const limitNum = Math.min(Math.max(parseInt(String(limit)) || 10, 1), 50);

  if (query.length < 2) {
    res.status(400).json({
      success: false,
      error: 'Query must be at least 2 characters'
    });
    return;
  }

  try {
    const users = await searchUsers(query, limitNum);
    res.json({
      success: true,
      data: {
        users,
        count: users.length,
        query
      }
    });
  } catch (err) {
    console.error('[User Search Error]', err);
    res.status(500).json({ success: false, error: 'Failed to search users' });
  }
};