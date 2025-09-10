// route/auth.ts

import express from 'express'
import {registerUser, loginUser, verifyToken, refreshToken} from '../controllers/authController'

const router = express.Router()

router.post('/register', registerUser)
router.post('/login', loginUser)
router.post('/refresh', refreshToken)
router.get('/verify', verifyToken)

export default router
