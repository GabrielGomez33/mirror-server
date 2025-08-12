// routes/storage.ts
// Following existing pattern from routes/auth.ts and routes/user.ts

import express from 'express';
import {
  createDirectoriesHandler,
  storeDataHandler,
  retrieveDataHandler,
  listFilesHandler
} from '../controllers/storageController';

const router = express.Router();

router.post('/directories/create', createDirectoriesHandler);
router.post('/store', storeDataHandler);
router.get('/retrieve/:userId/:tier/:filename', retrieveDataHandler);
router.get('/list/:userId/:tier', listFilesHandler);

export default router;
