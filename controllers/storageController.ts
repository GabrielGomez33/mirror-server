// controllers/storageController.ts
// Following existing pattern from authController and userController

import type { RequestHandler } from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  createUserDirectories,
  writeToTier,
  readFromTier,
  listTierFiles,
  TierType,
} from './directoryController';

// ---------- Helpers (minimal & safe) ----------

/** Map a client "type" value to a TierType */
const TYPE_TO_TIER: Record<string, TierType> = {
  photo: 'tier1',
  image: 'tier1',
  voice: 'tier2',
  audio: 'tier2',
};

const inferExtFromMime = (mime?: string): string => {
  if (!mime) return '';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  if (mime === 'image/heif') return '.heif';
  if (mime === 'image/tiff') return '.tiff';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'audio/webm') return '.webm';
  if (mime === 'audio/mpeg') return '.mp3';
  if (mime === 'audio/mp4') return '.m4a';
  if (mime === 'audio/wav') return '.wav';
  return '';
};

const safeBase = (name: string) => name.replace(/[^\w.-]/g, '_');

/** Convert arbitrary input (explicit tier or human labels) into TierType */
function normalizeTier(tierLike?: string, typeLike?: string): TierType {
  const t = (tierLike || '').toLowerCase().trim();
  if (t === 'tier1' || t === 'visual' || t === 'photos' || t === 'images') return 'tier1';
  if (t === 'tier2' || t === 'vocal' || t === 'voices' || t === 'audio') return 'tier2';
  if (t === 'tier3' || t === 'misc' || t === 'data' || t === 'other') return 'tier3';

  // No explicit tier — infer from "type"
  const type = (typeLike || '').toLowerCase().trim();
  if (TYPE_TO_TIER[type]) return TYPE_TO_TIER[type];

  // Safe default
  return 'tier3';
}

/** Gather files regardless of whether route used single/array/fields and file|data name */
function collectFiles(req: any) {
  const files: any[] = [];
  if (req.file) files.push(req.file);
  if (req.files?.file?.length) files.push(...(req.files.file as any[]));
  if (req.files?.data?.length) files.push(...(req.files.data as any[]));
  if (Array.isArray(req.files)) files.push(...req.files); // upload.array('file')
  return files;
}

/** Read a Buffer from a Multer file, regardless of storage engine */
async function getFileBuffer(f: any): Promise<Buffer> {
  if (f?.buffer && Buffer.isBuffer(f.buffer)) return f.buffer as Buffer;
  if (f?.path) return fs.readFile(f.path as string);
  throw new Error('Uploaded file is missing buffer/path (unsupported Multer storage?)');
}

/** Get numeric actor for DataAccessContext.accessedBy */
function resolveAccessedBy(userIdLike?: string | number): number {
  const n = Number(userIdLike);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------- Endpoints ----------

// Create user directories endpoint
export const createDirectoriesHandler: RequestHandler = async (req, res) => {
  try {
    const { userId } = (req.body ?? {}) as { userId?: string };
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return;
    }
    await createUserDirectories(String(userId));
    res.json({ success: true, userId: String(userId) });
    return;
  } catch (error) {
    console.error('[STORAGE] Directory creation failed:', error);
    res.status(500).json({
      success: false,
      error: 'Directory creation failed',
      details: (error as Error).message,
    });
    return;
  }
};

/**
 * Unified store handler:
 * - If multipart files exist -> store each using writeToTier(userId, tier, filename, buffer, metadata)
 * - Else fall back to JSON mode: expect { userId, tier, filename, data } (data as base64 or utf8 string)
 *
 * Distinguish tier vs type: explicit "tier" wins; otherwise infer from "type".
 */
export const storeDataHandler: RequestHandler = async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      userId?: string;
      tier?: string;
      type?: string;
      filename?: string;
      data?: string;
      accessedBy?: number | string;
      [k: string]: any;
    };

    const userIdRaw = body.userId;
    const tierRaw = body.tier;
    const typeRaw = body.type;
    const filenameRaw = body.filename;
    const accessedBy = resolveAccessedBy(body.accessedBy ?? userIdRaw);

    // 1) FILE MODE (multipart)
    const files = collectFiles(req as any);
    if (files.length > 0) {
      if (!userIdRaw) {
        res.status(400).json({ success: false, error: 'userId is required for file uploads' });
        return;
      }

      const userId = String(userIdRaw);
      const tier = normalizeTier(tierRaw, typeRaw);

      // Ensure user directories exist before writes
      await createUserDirectories(userId);

      const results: Array<{
        success: boolean;
        filename: string;
        size?: number;
        mimetype?: string;
        originalname?: string;
        error?: string;
        result?: any;
      }> = [];

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          const buf = await getFileBuffer(f);

          // Decide filename for this file
          const suggestedExt = inferExtFromMime(f.mimetype);
          const base =
            i === 0 && filenameRaw
              ? path.basename(String(filenameRaw), path.extname(String(filenameRaw)))
              : crypto.randomUUID();

          const finalName = `${safeBase(base)}${
            (i === 0 && filenameRaw ? path.extname(String(filenameRaw)) : '') || suggestedExt || ''
          }`;

		  const userIdNum = resolveAccessedBy(userIdRaw);

          // DataAccessContext — include required accessedBy
          const metadata = {
            fieldname: f.fieldname,
            originalname: f.originalname,
            mimetype: f.mimetype,
            size: f.size ?? buf.length,
            // DataAccessContext required fields (numbers):
            userId: userIdNum,          // <-- number, not string
            tier,                       // <-- TierType
            accessedBy: userIdNum,      // <-- number
            // Optional/extra context:
            type: typeRaw,
            uploadedAt: new Date().toISOString(),
          };

          const result = await writeToTier(userId, tier, finalName, buf, metadata);

          results.push({
            success: true,
            filename: finalName,
            size: f.size ?? buf.length,
            mimetype: f.mimetype,
            originalname: f.originalname,
            result,
          });
        } catch (e) {
          results.push({
            success: false,
            filename: files[i]?.originalname || `file-${i + 1}`,
            error: (e as Error).message,
          });
        }
      }

      const okCount = results.filter(r => r.success).length;

      res.json({
        success: okCount === results.length,
        mode: 'file',
        userId: String(userIdRaw),
        tier,
        count: results.length,
        files: results,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 2) JSON MODE (legacy / string data)
    const { userId, tier, filename, data } = body;
    if (!userId || !tier || !filename || typeof data !== 'string' || data.length === 0) {
      res
        .status(400)
        .json({ success: false, error: 'userId, tier, filename, and data are required' });
      return;
    }

    const normalizedTier = normalizeTier(String(tier), typeRaw);

    // Ensure user directories exist before writes
    await createUserDirectories(String(userId));

    // Detect base64 vs utf8
    const likelyBase64 = /^[A-Za-z0-9+/=\s]+$/.test(data) && data.length % 4 === 0;
    const dataBuffer = likelyBase64 ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
	const userIdNumJson = resolveAccessedBy(userId);
	
    const metadata = {
      // DataAccessContext required fields (numbers):
      userId: userIdNumJson,      // <-- number, not string
      tier: normalizedTier,       // <-- TierType
      accessedBy: userIdNumJson,  // <-- number
      // Optional/extra context:
      type: typeRaw,
      providedFilename: String(filename),
      encoding: likelyBase64 ? 'base64' : 'utf8',
      uploadedAt: new Date().toISOString(),
    };

    const jsonWriteResult = await writeToTier(
      String(userId),
      normalizedTier,
      String(filename),
      dataBuffer,
      metadata
    );

    res.json({
      success: true,
      mode: 'json',
      userId: String(userId),
      tier: normalizedTier,
      fileId: String(filename),
      result: jsonWriteResult,
      size: dataBuffer.length,
      timestamp: new Date().toISOString(),
    });
    return;
  } catch (error) {
    console.error('[STORAGE] Data storage failed:', error);
    res.status(500).json({
      success: false,
      error: 'Data storage failed',
      details: (error as Error).message,
    });
    return;
  }
};

// Retrieve a file by userId/tier/filename
export const retrieveDataHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, tier, filename } = req.params as {
      userId: string;
      tier: string;
      filename: string;
    };

    if (!userId || !tier || !filename) {
      res.status(400).json({ success: false, error: 'userId, tier, and filename are required' });
      return;
    }

    const normalizedTier = normalizeTier(String(tier));
    const file = await readFromTier(String(userId), normalizedTier, String(filename));
    if (!file) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }

    const mime = (file as any).mime;
    if (mime) res.setHeader('Content-Type', mime);

    const safeName = safeBase(String(filename));
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);

    const buf: Buffer = (file as any).buffer ?? (file as Buffer);
    res.end(buf);
    return;
  } catch (error) {
    console.error('[STORAGE] Data retrieval failed:', error);
    res.status(500).json({
      success: false,
      error: 'Data retrieval failed',
      details: (error as Error).message,
    });
    return;
  }
};

// List files in a tier
export const listFilesHandler: RequestHandler = async (req, res) => {
  try {
    const { userId, tier } = req.params as { userId: string; tier: string };
    if (!userId || !tier) {
      res.status(400).json({ success: false, error: 'userId and tier are required' });
      return;
    }

    const normalizedTier = normalizeTier(String(tier));
    const files = await listTierFiles(String(userId), normalizedTier);

    res.json({
      success: true,
      userId: String(userId),
      tier: normalizedTier,
      files,
      count: files.length,
      timestamp: new Date().toISOString(),
    });
    return;
  } catch (error) {
    console.error('[STORAGE] File listing failed:', error);
    res.status(500).json({
      success: false,
      error: 'File listing failed',
      details: (error as Error).message,
    });
    return;
  }
};
