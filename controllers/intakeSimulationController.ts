// ============================================================================
// INTAKE SIMULATION CONTROLLER
// ============================================================================
// File: controllers/intakeSimulationController.ts
// ----------------------------------------------------------------------------
// A *real*, step-by-step intake simulation that mirrors the front-end intake
// journey against a throwaway, clearly-marked simulation user and then deletes
// every trace of it. It gives operators a one-click, legitimate way to confirm
// "is intake actually working end to end?" without manually clicking through the
// whole flow and without leaving residue.
//
// STEPS — these mirror the real front-end journey
// (Registration → Visual → Vocal → IQ → Astrology → Personality → Submit →
//  Results), with server-side verification folded in:
//
//   1. register     — provision a sim user via the SAME functions the real
//                      /auth/register handler uses (createUserInDB -> user row +
//                      tier1/2/3 directories + encryption keys; TokenManager
//                      session + access token). We bypass only the HTTP
//                      /auth/register wrapper so the per-IP register rate limit
//                      can't make this tool flaky and no verification email is
//                      sent to a fake address.
//   2. visual       — REAL POST /mirror/api/storage/store (tier1, photo) over
//                      loopback with the sim user's JWT, and assemble the
//                      faceAnalysis slice. (Front-end VisualStep.)
//   3. vocal        — REAL POST /mirror/api/storage/store (tier2, encrypted
//                      voice) + voiceMetadata slice. (Front-end VocalStep.)
//   4. iq           — assemble the IQ answers/results slice and exercise the
//                      REAL GET /mirror/api/intake/iq/norms endpoint the IQStep
//                      calls. (Front-end IQStep.)
//   5. astrology    — assemble + validate the astrology slice. (AstroLogicalStep;
//                      computed client-side in the real app, so this is the
//                      data-assembly equivalent.)
//   6. personality  — assemble + validate the personality slice. (PersonalityStep.)
//   7. submit       — REAL POST /mirror/api/intake/store with the assembled
//                      payload (6 encrypted tier3 JSON files + intake_metadata +
//                      iq_norm_samples + intake_completed). (Front-end SubmitStep.)
//   8. verify_db    — assert the DB side effects landed.
//   9. verify_files — assert the tier1/2/3 files exist on disk.
//  10. results      — REAL GET /mirror/api/intake/latest/:userId (decrypts the
//                      stored intake back out and checks it round-trips). This is
//                      the data the front-end ResultsStep renders.
//  11. cleanup      — delete the sim user through the EXISTING production teardown
//                      (deleteUserFromDB: filesystem + transactional DB cascade)
//                      and notify Dina's mirror module purge, so the rule "all
//                      Dina interaction flows through src/modules/mirror" holds.
//                      Then verify removal.
//
// If any step throws, the run still tears the sim user down (best-effort) so a
// failed run never leaves residue.
//
// SAFETY (this tool creates and deletes real users — it must never touch a real
// account):
//   - Sim users are minted with a reserved username prefix (__sim_) and a
//     reserved, non-routable email domain (SIM_EMAIL_DOMAIN, default a .invalid
//     TLD per RFC 2606 so no real inbox can ever collide).
//   - Every destructive teardown re-validates that the target user matches BOTH
//     the sim username prefix AND the sim email domain before deleting. A user
//     that fails either check is refused — defence in depth.
//   - Every run is recorded in an additive `intake_simulation_runs` audit table
//     (never alters existing tables). The orphan sweeper only ever purges users
//     it can prove are simulations.
//   - A process-level lock serialises runs so concurrent invocations can't race.
//
// This controller REUSES production code paths; it does not re-implement them.
// ============================================================================

import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { DB } from '../db';
import { Logger } from '../utils/logger';
import { TokenManager } from './authController';
import { createUserInDB, deleteUserFromDB } from './userController';
import { listTierFiles, TierType } from './directoryController';

const logger = new Logger('IntakeSimulation');

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

// Loopback base for self-directed HTTP calls. mirror-server listens HTTPS on
// MIRRORPORT (default 8444) on all interfaces, so 127.0.0.1 reaches it. The
// cert is self-signed for loopback, so TLS verification is relaxed ONLY for
// loopback hosts (same policy as admin-server's mirrorEmailClient).
const SELF_BASE_URL =
  process.env.MIRROR_SELF_BASE_URL ||
  `https://127.0.0.1:${process.env.MIRRORPORT || '8444'}`;

// Reserved identity space for simulation users. `.invalid` is guaranteed
// non-resolvable (RFC 2606), so a sim email can never be a real address.
const SIM_EMAIL_DOMAIN = (process.env.MIRROR_SIM_EMAIL_DOMAIN || 'simulation.mirror.invalid')
  .toLowerCase()
  .replace(/^@/, '');
const SIM_USERNAME_PREFIX = '__sim_';

// Per-call timeout for loopback HTTP requests.
const SELF_HTTP_TIMEOUT_MS = parseInt(process.env.MIRROR_SIM_HTTP_TIMEOUT_MS || '30000', 10);

// The IQ item set the front end ships. The synthetic answers below are keyed to
// this version so the server re-scores them as a *verified* norm sample. If the
// production item set changes, verify_db will surface a non-verified sample as a
// warning — an intentional signal that this fixture needs updating.
const SIM_IQ_ITEM_SET_VERSION = process.env.MIRROR_SIM_IQ_VERSION || 'mirror-iq-v1';

// ----------------------------------------------------------------------------
// TYPES
// ----------------------------------------------------------------------------

export type StepSeverity = 'pass' | 'warn' | 'fail';

export interface SimStep {
  name: string;
  ok: boolean;
  severity: StepSeverity;
  ms: number;
  detail: string;
  data?: Record<string, unknown>;
}

export interface SimRunReport {
  runId: string;
  status: 'passed' | 'passed_with_warnings' | 'failed';
  dryRun: boolean;
  operator: string;
  simUserId: number | null;
  simUsername: string;
  simEmail: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cleanedUp: boolean;
  steps: SimStep[];
  warnings: string[];
  error: string | null;
  // Login credentials for a KEPT test user (skipCleanup). Returned in the live
  // run response only — NEVER persisted to the audit table or logged — so the
  // operator can sign in as this account. null for ephemeral (cleaned-up) runs.
  credentials: { email: string; username: string; password: string } | null;
}

export interface RunOptions {
  dryRun?: boolean;
  // Leave the sim user in place after a run (debugging only). The run report
  // still reports which user was created so it can be swept later. When set, the
  // run returns login credentials (see SimRunReport.credentials) and marks the
  // user email-verified so it can be used as a real test account.
  skipCleanup?: boolean;
  // Optional password for the kept test user. If omitted (or shorter than 8
  // chars) a strong random one is generated and returned. Only meaningful with
  // skipCleanup. Username/email are always in the reserved sim namespace.
  password?: string;
  // Optional email LOCAL PART for the test user (e.g. "qa-alice" ->
  // qa-alice@<reserved sim domain>). The domain is ALWAYS forced to the reserved
  // sim domain and the username ALWAYS keeps the __sim_ prefix, so the teardown
  // safety guard and orphan sweeper keep working and a custom test user can
  // never collide with or impersonate a real account. Sanitized server-side.
  emailLocalPart?: string;
  // Free-text label stored with the audit row (e.g. "post-deploy smoke").
  label?: string;
}

// ----------------------------------------------------------------------------
// PROCESS-LEVEL LOCK — serialise runs
// ----------------------------------------------------------------------------

let runInFlight = false;

export class SimulationBusyError extends Error {
  constructor() {
    super('An intake simulation is already running. Try again shortly.');
    this.name = 'SimulationBusyError';
  }
}

// ----------------------------------------------------------------------------
// AUDIT TABLE — additive, created lazily (never alters existing tables)
// ----------------------------------------------------------------------------

let auditTableReady = false;

async function ensureAuditTable(): Promise<void> {
  if (auditTableReady) return;
  await DB.query(`
    CREATE TABLE IF NOT EXISTS intake_simulation_runs (
      run_id        VARCHAR(36)  NOT NULL,
      operator      VARCHAR(128) NULL,
      label         VARCHAR(255) NULL,
      status        VARCHAR(32)  NOT NULL,
      dry_run       TINYINT(1)   NOT NULL DEFAULT 0,
      sim_user_id   INT          NULL,
      sim_username  VARCHAR(128) NULL,
      sim_email     VARCHAR(255) NULL,
      steps         JSON         NULL,
      warnings      JSON         NULL,
      error         TEXT         NULL,
      cleaned_up    TINYINT(1)   NOT NULL DEFAULT 0,
      duration_ms   INT          NULL,
      started_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at   DATETIME     NULL,
      PRIMARY KEY (run_id),
      KEY idx_sim_runs_started (started_at),
      KEY idx_sim_runs_cleanup (cleaned_up, sim_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  auditTableReady = true;
}

async function insertAuditRow(report: SimRunReport, label?: string): Promise<void> {
  try {
    await DB.query(
      `INSERT INTO intake_simulation_runs
         (run_id, operator, label, status, dry_run, sim_username, sim_email, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        report.runId,
        report.operator?.slice(0, 128) || null,
        label?.slice(0, 255) || null,
        'running',
        report.dryRun ? 1 : 0,
        report.simUsername,
        report.simEmail,
      ],
    );
  } catch (err) {
    logger.warn('Failed to insert simulation audit row', { runId: report.runId, err: errMsg(err) });
  }
}

async function finalizeAuditRow(report: SimRunReport): Promise<void> {
  try {
    await DB.query(
      `UPDATE intake_simulation_runs
         SET status = ?, sim_user_id = ?, steps = ?, warnings = ?, error = ?,
             cleaned_up = ?, duration_ms = ?, finished_at = NOW()
       WHERE run_id = ?`,
      [
        report.status,
        report.simUserId,
        JSON.stringify(report.steps),
        JSON.stringify(report.warnings),
        report.error,
        report.cleanedUp ? 1 : 0,
        report.durationMs,
        report.runId,
      ],
    );
  } catch (err) {
    logger.warn('Failed to finalize simulation audit row', { runId: report.runId, err: errMsg(err) });
  }
}

// ----------------------------------------------------------------------------
// SMALL HELPERS
// ----------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/** Generate a password that satisfies the registration policy (upper, lower,
 *  digit, special, length 8–128). Used only for the throwaway sim user. */
function strongRandomPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const special = '!@#$%^&*()-_=+';
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const core = [pick(upper), pick(lower), pick(digit), pick(special)];
  const all = upper + lower + digit + special;
  for (let i = 0; i < 20; i++) core.push(pick(all));
  for (let i = core.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [core[i], core[j]] = [core[j], core[i]];
  }
  return core.join('');
}

/** True only for users this tool created. Teardown gates on this. */
function looksLikeSimUser(username: string | null | undefined, email: string | null | undefined): boolean {
  const u = String(username || '');
  const e = String(email || '').toLowerCase();
  return u.startsWith(SIM_USERNAME_PREFIX) && e.endsWith('@' + SIM_EMAIL_DOMAIN);
}

/** Sanitize an operator-supplied email local part into a safe token usable in
 *  BOTH the email local part and the username (so the reserved domain/prefix can
 *  be appended). Lowercased; restricted to [a-z0-9._-]; length-capped. Returns
 *  '' when nothing usable remains, in which case a run-id-based default is used. */
function sanitizeLocalPart(input?: string): string {
  if (!input) return '';
  return String(input).toLowerCase().trim().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}

// ----------------------------------------------------------------------------
// LOOPBACK HTTP — JSON + multipart, dependency-free (mirrors mirrorEmailClient)
// ----------------------------------------------------------------------------

interface SelfResponse {
  status: number;
  body: any;
}

function selfRequest(
  method: string,
  path: string,
  opts: { json?: unknown; body?: Buffer; contentType?: string; token?: string } = {},
): Promise<SelfResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(SELF_BASE_URL.replace(/\/$/, '') + path);
    } catch {
      reject(new Error(`Invalid MIRROR_SELF_BASE_URL: ${SELF_BASE_URL}`));
      return;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    let payload: Buffer | undefined;
    let contentType = opts.contentType;
    if (opts.body) {
      payload = opts.body;
    } else if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json));
      contentType = 'application/json';
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Mirror-Server/IntakeSimulation',
    };
    if (contentType) headers['Content-Type'] = contentType;
    if (payload) headers['Content-Length'] = String(payload.length);
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    const requestOptions: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: SELF_HTTP_TIMEOUT_MS,
    };
    // Relax TLS only for loopback self-signed certs; never for a remote host.
    if (isHttps) {
      (requestOptions as https.RequestOptions).rejectUnauthorized = !isLoopback(url.hostname);
    }

    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = { raw };
        }
        resolve({ status: res.statusCode || 502, body: parsed });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`loopback request timed out after ${SELF_HTTP_TIMEOUT_MS}ms`)));
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Build a multipart/form-data body for the storage upload endpoint. */
function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; buffer: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = '----MirrorSim' + crypto.randomBytes(16).toString('hex');
  const CRLF = '\r\n';
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
      `${value}${CRLF}`,
    ));
  }

  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}` +
    `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
  ));
  parts.push(file.buffer);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload one file to the real /storage/store endpoint and return its file ref. */
async function uploadToStorage(
  userId: number,
  tier: 'tier1' | 'tier2',
  file: { buffer: Buffer; filename: string; contentType: string },
  token: string | undefined,
): Promise<{ filename: string; tier: string; size: number; mimetype: string; uploadedAt: string; originalname?: string }> {
  const mp = buildMultipart(
    { userId: String(userId), tier, filename: file.filename },
    { field: 'file', filename: file.filename, contentType: file.contentType, buffer: file.buffer },
  );
  const res = await selfRequest('POST', '/mirror/api/storage/store', { body: mp.body, contentType: mp.contentType, token });
  if (res.status !== 200 || !res.body?.success) {
    throw new Error(`storage/store ${tier} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  // Mirror the front end's selection EXACTLY: SubmitStep's toPhotoFileRef /
  // toVoiceFileRef reference files[files.length - 1] (the last entry), not
  // files[0]. This matters because the storage handler currently returns two
  // entries per upload (see the README "Known finding"); the front end uses the
  // last one, so the simulation must too to stay faithful. Robust to a future
  // single-entry response as well (length-1 === 0).
  const arr: any[] = Array.isArray(res.body.files) ? res.body.files : [];
  const f = arr[arr.length - 1] || arr[0];
  if (!f?.filename) throw new Error(`storage/store ${tier} returned no filename`);
  return {
    filename: f.filename, tier, size: f.size, mimetype: f.mimetype,
    uploadedAt: res.body.timestamp || new Date().toISOString(), originalname: f.originalname,
  };
}

// ----------------------------------------------------------------------------
// SYNTHETIC FIXTURES — valid, compact, deterministic; no real PII
// ----------------------------------------------------------------------------

// A valid 1×1 PNG (transparent). The storage layer stores bytes verbatim and
// never parses the image (face analysis is a client-side concern), but using a
// genuinely valid image keeps the artifact inspectable.
const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function samplePhoto(): { buffer: Buffer; filename: string; contentType: string } {
  return { buffer: Buffer.from(SAMPLE_PNG_BASE64, 'base64'), filename: 'sim_face.png', contentType: 'image/png' };
}

// Generate a tiny but structurally valid mono 16-bit PCM WAV (~0.2s of silence).
function sampleVoice(): { buffer: Buffer; filename: string; contentType: string; durationMs: number } {
  const sampleRate = 8000;
  const durationMs = 200;
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataLen = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);           // audioFormat = PCM
  buf.writeUInt16LE(1, 22);           // channels = 1
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32);           // blockAlign
  buf.writeUInt16LE(16, 34);          // bitsPerSample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return { buffer: buf, filename: 'sim_voice.wav', contentType: 'audio/wav', durationMs };
}

// All 30 answers for mirror-iq-v1, keyed to the production answer key so the
// server re-scores this as a verified norm sample. (The sample is removed again
// by teardown via the iq_norm_samples ON DELETE CASCADE.)
const SIM_IQ_ANSWERS: Record<string, string> = {
  'iq-num-1': '32', 'iq-num-2': '10', 'iq-num-3': '20', 'iq-num-4': '3:30 PM',
  'iq-num-5': '21', 'iq-num-6': '7', 'iq-num-7': '20',
  'iq-spat-4': 'overlap', 'iq-spat-6': 'circle', 'iq-spat-7': '27', 'iq-spat-8': '11',
  'iq-log-1': 'It cannot be determined whether any roses fade quickly.',
  'iq-log-2': 'It is not raining.', 'iq-log-3': 'I16', 'iq-log-4': 'Foot',
  'iq-log-5': 'It is impossible to tell if any cats like blue fish.',
  'iq-log-6': 'All A are C', 'iq-log-7': 'Some polygons are not circles.',
  'iq-log-8': 'Some artists are writers.',
  'iq-verb-1': 'Carrot', 'iq-verb-2': 'Pessimistic', 'iq-verb-3': 'PLENTY',
  'iq-verb-4': 'Pervasive', 'iq-verb-5': 'Trumpet', 'iq-verb-6': 'Lasting a very short time',
  'iq-verb-7': 'Airplane',
  'iq-spat-1': 'No circles are squares.', 'iq-spat-2': 'The alarm is not set.',
  'iq-spat-3': 'A', 'iq-spat-5': 'Some musicians are not poets.',
};

// Per-modality slice builders (mirror the front-end step outputs).
const buildFaceAnalysis = () => ({
  detection: { score: 0.99, box: { x: 8, y: 8, width: 96, height: 96 } },
  landmarks: { positions: [[20, 30], [44, 30], [32, 48], [24, 62], [40, 62]] },
  unshiftedLandmarks: {},
  alignedRect: { x: 8, y: 8, width: 96, height: 96 },
  angle: { roll: 1.4, pitch: -2.1, yaw: 0.7 },
  expressions: { neutral: 0.74, happy: 0.18, sad: 0.02, angry: 0.01, fearful: 0.01, disgusted: 0.01, surprised: 0.03 },
});

const buildVoiceMetadata = (size: number, durationMs: number) => ({
  mimeType: 'audio/wav',
  duration: durationMs,
  size,
  deviceInfo: { isMobile: false, platform: 'Desktop', browser: 'Simulation' },
});

const buildIqResults = () => ({
  rawScore: 30,
  totalQuestions: 30,
  iqScore: 130,
  category: 'Simulation',
  strengths: ['logical', 'verbal'],
  description: 'Synthetic cognitive profile generated by the intake simulation.',
  itemSetVersion: SIM_IQ_ITEM_SET_VERSION,
});

const buildAstrology = () => ({
  western: { sunSign: 'Aquarius', moonSign: 'Libra', risingSign: 'Gemini', dominantElement: 'Air' },
  chinese: { animalSign: 'Tiger', element: 'Wood', yinYang: 'Yang' },
  african: { orishaGuardian: 'Obatala', elementalForce: 'Air', sacredAnimal: 'Owl' },
  numerology: { lifePathNumber: 7, destinyNumber: 3, soulUrgeNumber: 9 },
  synthesis: { coreThemes: ['curiosity', 'balance'], lifeDirection: 'Synthesis (simulated).' },
});

const buildPersonality = () => ({
  big5Profile: { openness: 82, conscientiousness: 67, extraversion: 55, agreeableness: 71, neuroticism: 38 },
  mbtiType: 'ENFP',
  dominantTraits: ['Openness', 'Agreeableness'],
  description: 'Synthetic personality profile generated by the intake simulation.',
});

// ----------------------------------------------------------------------------
// STEP RUNNER
// ----------------------------------------------------------------------------

async function step(
  steps: SimStep[],
  name: string,
  fn: () => Promise<{ detail: string; data?: Record<string, unknown>; severity?: StepSeverity }>,
): Promise<SimStep> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const s: SimStep = {
      name,
      ok: (r.severity ?? 'pass') !== 'fail',
      severity: r.severity ?? 'pass',
      ms: Date.now() - t0,
      detail: r.detail,
      data: r.data,
    };
    steps.push(s);
    return s;
  } catch (err) {
    const s: SimStep = {
      name,
      ok: false,
      severity: 'fail',
      ms: Date.now() - t0,
      detail: errMsg(err),
    };
    steps.push(s);
    throw err;
  }
}

// ----------------------------------------------------------------------------
// TEARDOWN — guarded; only ever deletes a proven simulation user
// ----------------------------------------------------------------------------

const DINA_PURGE_TIMEOUT_MS = 15000;

/** Notify Dina's mirror module to purge any downstream artefacts for this user.
 *  Mirrors authController.notifyDinaPurge so the simulation cleans up exactly
 *  like a real account deletion — through Dina's src/modules/mirror entry point.
 *  Best-effort: a Dina outage never fails the simulation's local teardown. */
async function notifyDinaPurge(userId: number, sessionId: string | undefined): Promise<{ notified: boolean; detail?: string }> {
  const base = process.env.DINA_SERVER_URL || 'https://theundergroundrailroad.world';
  const path = process.env.DINA_PURGE_PATH || '/dina/api/v1/mirror/purge-user';
  const url = `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;
  const serviceKey = process.env.MIRROR_SERVICE_KEY || '';

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mirror-Server/IntakeSimulation purge',
    };
    if (serviceKey) headers['X-Service-Key'] = serviceKey;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        userId: String(userId),
        sessionId: sessionId || null,
        reason: 'intake_simulation_cleanup',
        requestedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(DINA_PURGE_TIMEOUT_MS),
    });
    if (!response.ok) return { notified: false, detail: `dina_status_${response.status}` };
    return { notified: true };
  } catch (err) {
    return { notified: false, detail: errMsg(err) };
  }
}

/** Fully delete a simulation user (filesystem + DB cascade + Dina purge).
 *  Refuses to act on any user that does not pass the sim-identity guard. */
async function teardownSimUser(userId: number, sessionId: string | undefined): Promise<{ dinaNotified: boolean; dinaDetail?: string }> {
  // Re-load identity straight from the DB and gate on it. Never trust a caller
  // to have handed us a sim user — prove it here, immediately before deleting.
  const [rows] = await DB.query('SELECT username, email FROM users WHERE id = ?', [userId]);
  const row = (rows as any[])[0];
  if (!row) {
    // Already gone — idempotent success.
    return { dinaNotified: false, dinaDetail: 'user_absent' };
  }
  if (!looksLikeSimUser(row.username, row.email)) {
    throw new Error(
      `Refusing to delete user ${userId}: not a simulation user ` +
      `(username/email do not match the reserved sim namespace). This is a safety stop.`,
    );
  }

  // Local teardown is the source of truth (filesystem + transactional cascade).
  // deleteUserFromDB's adminUserId is used only for audit context during the
  // pre-delete filesystem cleanup; the sim user's own id is valid there.
  await deleteUserFromDB(String(userId), userId);
  // Downstream Dina purge through src/modules/mirror (best-effort).
  return await notifyDinaPurge(userId, sessionId).then((d) => ({ dinaNotified: d.notified, dinaDetail: d.detail }));
}

// ----------------------------------------------------------------------------
// MAIN: runIntakeSimulation
// ----------------------------------------------------------------------------

export async function runIntakeSimulation(options: RunOptions, operator: string): Promise<SimRunReport> {
  if (runInFlight) throw new SimulationBusyError();
  runInFlight = true;

  const startedAt = new Date();
  const runId = crypto.randomUUID();
  const shortId = runId.slice(0, 8);
  // Identity always stays in the reserved namespace so teardown + the orphan
  // sweeper keep working: username is `__sim_<x>` and email is `<x>@<sim domain>`.
  // The operator may choose `<x>` (sanitized) to make a memorable test account;
  // otherwise it defaults to the run's short id.
  const customLocal = sanitizeLocalPart(options.emailLocalPart);
  const simUsername = `${SIM_USERNAME_PREFIX}${customLocal || shortId}`;
  const simEmail = `${customLocal || `sim+${shortId}`}@${SIM_EMAIL_DOMAIN}`;
  const dryRun = !!options.dryRun;

  const steps: SimStep[] = [];
  const warnings: string[] = [];
  const report: SimRunReport = {
    runId,
    status: 'failed',
    dryRun,
    operator: operator || 'unknown',
    simUserId: null,
    simUsername,
    simEmail,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    cleanedUp: false,
    steps,
    warnings,
    error: null,
    credentials: null,
  };

  let userId: number | null = null;
  let sessionId: string | undefined;
  let accessToken: string | undefined;

  // Payload assembled slice-by-slice across the journey steps.
  const intakeData: Record<string, any> = {
    userLoggedIn: true,
    name: simUsername,
    progress: { lastStep: 'SubmitStep', completed: true, steps: {} },
  };

  try {
    await ensureAuditTable();
    await insertAuditRow(report, options.label);

    // ---- DRY RUN: validate readiness without creating anything -------------
    if (dryRun) {
      await step(steps, 'preflight', async () => {
        await DB.query('SELECT 1');
        const missing: string[] = [];
        if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
        if (missing.length) {
          return { detail: `DB reachable; missing env: ${missing.join(', ')}`, severity: 'warn' as StepSeverity };
        }
        return { detail: `DB reachable; self base ${SELF_BASE_URL}; sim domain @${SIM_EMAIL_DOMAIN}` };
      });
      report.status = steps.some((s) => s.severity === 'warn') ? 'passed_with_warnings' : 'passed';
      return report;
    }

    // ---- 1. REGISTER (provision via the same fns /auth/register uses) ------
    await step(steps, 'register', async () => {
      // Use the operator-supplied password when provided (>= 8 chars), else a
      // strong random one. The password is held only in memory for the duration
      // of the run and surfaced in report.credentials for KEPT users; it is
      // never written to the step detail, the audit table, or the logs.
      const password =
        options.password && options.password.length >= 8 ? options.password : strongRandomPassword();
      try {
        userId = await createUserInDB(simUsername, simEmail, password); // + dirs + keys
      } catch (e) {
        const m = errMsg(e);
        if (m === 'EMAIL_ALREADY_REGISTERED' || m === 'USERNAME_TAKEN') {
          throw new Error(
            `A test user with email "${simEmail}" already exists. Sweep it first ` +
            `(Sweep orphans) or choose a different email.`,
          );
        }
        throw e;
      }
      report.simUserId = userId;
      sessionId = TokenManager.generateSessionId();
      await TokenManager.createSession(userId, sessionId, {
        userAgent: 'IntakeSimulation',
        ipAddress: '127.0.0.1',
        fingerprint: `sim-${shortId}`,
      });
      accessToken = TokenManager.createAccessToken({ id: userId, email: simEmail, username: simUsername, sessionId });

      // For a KEPT user, make it a clean, fully-onboarded test account: mark the
      // email verified and return the credentials. Login itself does not require
      // a verified email (unverified users just see a "verify your email"
      // banner), but marking it verified removes that banner — and the .invalid
      // address can never receive a real verification link — and also keeps the
      // account loginable if LOGIN_REQUIRE_EMAIL_VERIFIED is ever enabled. Done
      // here, right after creation, so even a later-failing kept run still
      // yields a usable account. intake_completed is set by the submit step.
      // Ephemeral runs skip all of this (the user is deleted).
      if (options.skipCleanup) {
        await DB.query('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
        report.credentials = { email: simEmail, username: simUsername, password };
      }

      const keptNote = options.skipCleanup ? ' (kept: login-enabled, credentials in report)' : '';
      return { detail: `Created sim user #${userId} (${simUsername}) + directories + keys + session${keptNote}`, data: { userId } };
    });

    // ---- 2. VISUAL (real upload -> /storage/store tier1) -------------------
    await step(steps, 'visual', async () => {
      const ref = await uploadToStorage(userId!, 'tier1', samplePhoto(), accessToken);
      intakeData.photoFileRef = ref;
      intakeData.faceAnalysis = buildFaceAnalysis();
      intakeData.progress.steps.VisualStep = { completed: true, data: { source: 'simulation' } };
      return { detail: `Uploaded tier1 photo "${ref.filename}" (${ref.size} bytes) + face analysis`, data: { filename: ref.filename } };
    });

    // ---- 3. VOCAL (real upload -> /storage/store tier2, encrypted) ---------
    const voice = sampleVoice();
    await step(steps, 'vocal', async () => {
      const ref: any = await uploadToStorage(userId!, 'tier2', voice, accessToken);
      ref.duration = voice.durationMs;
      ref.deviceInfo = { isMobile: false, platform: 'Desktop', browser: 'Simulation' };
      intakeData.voiceFileRef = ref;
      intakeData.voiceMetadata = buildVoiceMetadata(ref.size, voice.durationMs);
      intakeData.progress.steps.VocalStep = { completed: true, data: { source: 'simulation' } };
      return { detail: `Uploaded tier2 voice "${ref.filename}" (${ref.size} bytes, encrypted) + metadata`, data: { filename: ref.filename } };
    });

    // ---- 4. IQ (assemble slice + exercise the real norms endpoint) ---------
    await step(steps, 'iq', async () => {
      intakeData.iqResults = buildIqResults();
      intakeData.iqAnswers = SIM_IQ_ANSWERS;
      intakeData.progress.steps.IQStep = { completed: true, data: { source: 'simulation' } };

      // The IQStep calls the self-norm endpoint to show a percentile. Exercise
      // it for real; a non-OK norms response is a warning (it doesn't block the
      // intake itself), not a failure.
      const q = `?itemSetVersion=${encodeURIComponent(SIM_IQ_ITEM_SET_VERSION)}&rawScore=30`;
      const res = await selfRequest('GET', `/mirror/api/intake/iq/norms${q}`, { token: accessToken });
      if (res.status !== 200 || !res.body?.success) {
        warnings.push(`iq/norms returned HTTP ${res.status}`);
        return { detail: `IQ slice assembled; norms endpoint HTTP ${res.status}`, severity: 'warn' as StepSeverity };
      }
      const ready = res.body.ready;
      const n = res.body.n;
      const pct = res.body.percentile;
      return {
        detail: `IQ slice assembled; norms endpoint OK (ready=${ready}, n=${n}${pct != null ? `, percentile≈${pct}` : ''})`,
        data: { ready, n, percentile: pct },
      };
    });

    // ---- 5. ASTROLOGY (assemble + validate slice) --------------------------
    await step(steps, 'astrology', async () => {
      const a = buildAstrology();
      if (!a.western?.sunSign || !a.numerology?.lifePathNumber) throw new Error('astrology slice failed validation');
      intakeData.astrologicalResult = a;
      intakeData.progress.steps.AstroLogicalStep = { completed: true, data: { source: 'simulation' } };
      return { detail: `Astrology slice assembled (sun=${a.western.sunSign}, chinese=${a.chinese.animalSign})` };
    });

    // ---- 6. PERSONALITY (assemble + validate slice) ------------------------
    await step(steps, 'personality', async () => {
      const p = buildPersonality();
      if (!p.mbtiType || !p.big5Profile) throw new Error('personality slice failed validation');
      intakeData.personalityResult = p;
      intakeData.personalityAnswers = { 'big5-o-1': { value: '5', score: 5 }, 'big5-c-1': { value: '4', score: 4 } };
      intakeData.progress.steps.PersonalityStep = { completed: true, data: { source: 'simulation' } };
      return { detail: `Personality slice assembled (MBTI=${p.mbtiType})` };
    });

    // ---- 7. SUBMIT (real POST -> /intake/store) ----------------------------
    await step(steps, 'submit', async () => {
      const res = await selfRequest('POST', '/mirror/api/intake/store', { json: { userId: String(userId), intakeData }, token: accessToken });
      if (res.status !== 200 || !res.body?.success) {
        throw new Error(`intake/store failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      return { detail: `Stored intake ${res.body.intakeId} (storedFiles=${res.body.storedFiles ?? '?'})`, data: { intakeId: res.body.intakeId } };
    });

    // ---- 8. VERIFY DB ------------------------------------------------------
    await step(steps, 'verify_db', async () => {
      const issues: string[] = [];

      const [metaRows] = await DB.query(
        'SELECT intake_id, has_photo, has_voice FROM intake_metadata WHERE user_id = ?',
        [String(userId)],
      );
      const meta = (metaRows as any[]);
      if (meta.length !== 1) issues.push(`expected 1 intake_metadata row, found ${meta.length}`);
      else {
        if (!meta[0].has_photo) issues.push('intake_metadata.has_photo is false');
        if (!meta[0].has_voice) issues.push('intake_metadata.has_voice is false');
      }

      const [userRows] = await DB.query('SELECT intake_completed FROM users WHERE id = ?', [userId]);
      const u = (userRows as any[])[0];
      if (!u) issues.push('user row missing');
      else if (!u.intake_completed) issues.push('users.intake_completed not set');

      let iqWarn = '';
      const [iqRows] = await DB.query(
        'SELECT verified FROM iq_norm_samples WHERE user_id = ? AND item_set_version = ?',
        [userId, SIM_IQ_ITEM_SET_VERSION],
      );
      const iq = (iqRows as any[]);
      if (iq.length !== 1) iqWarn = `expected 1 iq_norm_samples row, found ${iq.length}`;
      else if (!iq[0].verified) iqWarn = `iq_norm_samples recorded but verified=0 (IQ fixture "${SIM_IQ_ITEM_SET_VERSION}" may be stale)`;

      if (issues.length) throw new Error(issues.join('; '));
      if (iqWarn) { warnings.push(iqWarn); return { detail: `DB side effects OK; ${iqWarn}`, severity: 'warn' as StepSeverity }; }
      return { detail: 'intake_metadata, users.intake_completed and verified iq_norm_samples all present' };
    });

    // ---- 9. VERIFY FILES ON DISK ------------------------------------------
    await step(steps, 'verify_files', async () => {
      const counts: Record<string, number> = {};
      for (const tier of ['tier1', 'tier2', 'tier3'] as TierType[]) {
        const files = await listTierFiles(String(userId), tier);
        counts[tier] = files.length;
      }
      const issues: string[] = [];
      if (counts.tier1 < 1) issues.push('no tier1 (photo) files');
      if (counts.tier2 < 1) issues.push('no tier2 (voice/session) files');
      if (counts.tier3 < 1) issues.push('no tier3 (intake JSON) files');
      if (issues.length) throw new Error(issues.join('; '));
      return { detail: `Files present — tier1:${counts.tier1} tier2:${counts.tier2} tier3:${counts.tier3}`, data: counts };
    });

    // ---- 10. RESULTS (real GET -> /intake/latest, decrypt round-trip) ------
    await step(steps, 'results', async () => {
      const res = await selfRequest('GET', `/mirror/api/intake/latest/${userId}`, { token: accessToken });
      if (res.status !== 200 || !res.body?.success) {
        throw new Error(`intake/latest failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      }
      const name = res.body.intakeData?.name;
      if (name !== simUsername) throw new Error(`results name mismatch: "${name}" !== "${simUsername}"`);
      if (!res.body.intakeData?.personalityResult) throw new Error('results missing personalityResult');
      return { detail: 'Latest intake retrieved and decrypted (name + personality round-trip intact)' };
    });

    // ---- 11. CLEANUP -------------------------------------------------------
    if (options.skipCleanup) {
      warnings.push('skipCleanup=true — sim user kept as a login-enabled test account (credentials in this report); sweep it later via the cleanup endpoint');
      steps.push({ name: 'cleanup', ok: true, severity: 'warn', ms: 0, detail: 'skipped (skipCleanup=true) — user kept; log in with the credentials shown below' });
    } else {
      await step(steps, 'cleanup', async () => {
        const t = await teardownSimUser(userId!, sessionId);
        report.cleanedUp = true;

        const issues: string[] = [];
        const [u] = await DB.query('SELECT id FROM users WHERE id = ?', [userId]);
        if ((u as any[]).length !== 0) issues.push('users row still present');
        const [m] = await DB.query('SELECT intake_id FROM intake_metadata WHERE user_id = ?', [String(userId)]);
        if ((m as any[]).length !== 0) issues.push('intake_metadata rows still present');
        if (issues.length) throw new Error(`teardown incomplete: ${issues.join('; ')}`);

        const dinaNote = t.dinaNotified ? 'Dina purge acknowledged' : `Dina purge not confirmed (${t.dinaDetail || 'unknown'})`;
        if (!t.dinaNotified) warnings.push(`Dina purge not confirmed: ${t.dinaDetail || 'unknown'}`);
        return {
          detail: `Sim user #${userId} fully removed (filesystem + DB). ${dinaNote}`,
          severity: t.dinaNotified ? ('pass' as StepSeverity) : ('warn' as StepSeverity),
        };
      });
    }

    report.status = warnings.length || steps.some((s) => s.severity === 'warn') ? 'passed_with_warnings' : 'passed';
    return report;
  } catch (err) {
    report.error = errMsg(err);
    logger.error('Intake simulation failed', err as Error, { runId, simUserId: userId });

    // Best-effort cleanup so a failed run never leaves an orphan behind
    // (unless the operator explicitly asked to keep it).
    if (userId && !options.skipCleanup && !report.cleanedUp) {
      try {
        await teardownSimUser(userId, sessionId);
        report.cleanedUp = true;
        steps.push({ name: 'cleanup_after_failure', ok: true, severity: 'warn', ms: 0, detail: `Rolled back sim user #${userId} after failure` });
      } catch (cleanupErr) {
        warnings.push(`Cleanup after failure did not complete: ${errMsg(cleanupErr)} — sweep run ${runId} manually`);
        steps.push({ name: 'cleanup_after_failure', ok: false, severity: 'fail', ms: 0, detail: errMsg(cleanupErr) });
      }
    }
    report.status = 'failed';
    return report;
  } finally {
    const finishedAt = new Date();
    report.finishedAt = finishedAt.toISOString();
    report.durationMs = finishedAt.getTime() - startedAt.getTime();
    await finalizeAuditRow(report);
    runInFlight = false;
  }
}

// ----------------------------------------------------------------------------
// ORPHAN SWEEPER — purge sim users that a previous run failed to clean up
// ----------------------------------------------------------------------------

export interface CleanupResult {
  scanned: number;
  purged: number;
  failures: Array<{ userId: number; error: string }>;
  details: Array<{ userId: number; username: string; ok: boolean }>;
}

export async function cleanupOrphans(maxAgeMinutes = 0): Promise<CleanupResult> {
  // Find every user in the reserved sim namespace. The username prefix + email
  // domain guard inside teardownSimUser is the real safety net; the SQL filter
  // is just the candidate set.
  const [rows] = await DB.query(
    `SELECT id, username, email, created_at
       FROM users
      WHERE username LIKE ? AND email LIKE ?
        AND created_at < (NOW() - INTERVAL ? MINUTE)`,
    [`${SIM_USERNAME_PREFIX}%`, `%@${SIM_EMAIL_DOMAIN}`, Math.max(0, maxAgeMinutes)],
  );
  const candidates = rows as Array<{ id: number; username: string; email: string }>;

  const result: CleanupResult = { scanned: candidates.length, purged: 0, failures: [], details: [] };
  for (const c of candidates) {
    try {
      await teardownSimUser(c.id, undefined);
      result.purged++;
      result.details.push({ userId: c.id, username: c.username, ok: true });
    } catch (err) {
      result.failures.push({ userId: c.id, error: errMsg(err) });
      result.details.push({ userId: c.id, username: c.username, ok: false });
    }
  }

  // Mark audit rows whose user is now gone as cleaned up.
  try {
    await ensureAuditTable();
    await DB.query(
      `UPDATE intake_simulation_runs r
          SET cleaned_up = 1
        WHERE cleaned_up = 0
          AND sim_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.sim_user_id)`,
    );
  } catch (err) {
    logger.warn('Failed to reconcile audit rows after sweep', { err: errMsg(err) });
  }

  return result;
}

// ----------------------------------------------------------------------------
// READINESS + HISTORY
// ----------------------------------------------------------------------------

export async function simulationHealth(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    selfBaseUrl: SELF_BASE_URL,
    simEmailDomain: SIM_EMAIL_DOMAIN,
    iqItemSetVersion: SIM_IQ_ITEM_SET_VERSION,
    runInFlight,
    dbReachable: false,
    jwtConfigured: !!process.env.JWT_SECRET,
    internalSecretConfigured: !!process.env.MIRROR_INTERNAL_SECRET,
  };
  try {
    await DB.query('SELECT 1');
    out.dbReachable = true;
  } catch (err) {
    out.dbError = errMsg(err);
  }
  return out;
}

export async function listRuns(limit = 20): Promise<unknown[]> {
  await ensureAuditTable();
  const capped = Math.min(Math.max(1, limit), 100);
  const [rows] = await DB.query(
    `SELECT run_id, operator, label, status, dry_run, sim_user_id, sim_username,
            cleaned_up, duration_ms, started_at, finished_at, error
       FROM intake_simulation_runs
      ORDER BY started_at DESC
      LIMIT ?`,
    [capped],
  );
  return rows as unknown[];
}

export async function getRun(runId: string): Promise<unknown | null> {
  await ensureAuditTable();
  const [rows] = await DB.query('SELECT * FROM intake_simulation_runs WHERE run_id = ?', [runId]);
  const row = (rows as any[])[0];
  return row || null;
}