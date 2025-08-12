// routes/debug.ts
// Following existing pattern from routes/auth.ts and routes/user.ts

import express from 'express';
import {
  getSystemStatusHandler,
  getUserStorageStatusHandler
} from '../controllers/debugController';

const router = express.Router();

router.get('/status', getSystemStatusHandler);
router.get('/user/:userId', getUserStorageStatusHandler);

export default router;
