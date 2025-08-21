// routes/storage.ts
// routes/storage.ts
// Following existing pattern from routes/auth.ts and routes/user.ts

import express from 'express';
import {
  createDirectoriesHandler,
  storeDataHandler,
  retrieveDataHandler,
  listFilesHandler
} from '../controllers/storageController';

// ✅ Use the Multer instance you placed in utils/
import { upload } from '../utils/multer';

const router = express.Router();

// JSON body route (no multipart)
router.post('/directories/create', createDirectoriesHandler);

// ✅ Multipart route: Multer must run here so req.body and req.file are populated
// Field name must match client: "file"
router.post(
  '/store',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'data', maxCount: 1 },
  ]),
  (req, res, next) => {
    // Normalize to req.file so your controller can keep its logic minimal
    // If controller already reads from req.files/req.file, you can skip this block.
    const f =
      (req as any).files?.['file']?.[0] ??
      (req as any).files?.['data']?.[0] ??
      null;
    if (f && !(req as any).file) (req as any).file = f;
    next();
  },
  storeDataHandler
);
// Retrieval / listing
router.get('/retrieve/:userId/:tier/:filename', retrieveDataHandler);
router.get('/list/:userId/:tier', listFilesHandler);

export default router;
