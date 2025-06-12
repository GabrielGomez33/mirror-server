// routes/user.ts

import express from 'express';
import{
	updateUserPasswordHandler,
	updateUserEmailHandler,
	deleteUserHandler
} from '../controllers/userController';

const router = express.Router();

router.post('/update-password', updateUserPasswordHandler);
router.post('/update-email', updateUserEmailHandler);
router.post('/delete', deleteUserHandler);

export default router;
