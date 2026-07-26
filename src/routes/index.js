import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import * as authController from '../controllers/authController.js';
import * as sessionController from '../controllers/sessionController.js';
import * as messageController from '../controllers/messageController.js';

const router = express.Router();

// Auth routes (no auth required)
router.post('/auth/login', authController.login);
router.post('/auth/logout', authController.logout);
router.get('/auth/check', authMiddleware, authController.checkAuth);

// Session routes (require auth)
router.get('/sessions', authMiddleware, sessionController.listSessions);
router.get('/sessions/:id', authMiddleware, sessionController.getSession);
router.post('/sessions/:id/connect', authMiddleware, sessionController.connectSession);
router.get('/sessions/:id/qr', authMiddleware, sessionController.getSessionQr);
router.delete('/sessions/:id', authMiddleware, sessionController.deleteSession);

// Message routes (require auth)
router.post('/sessions/:id/send', authMiddleware, messageController.sendMessage);
router.post('/sessions/:id/send-poll', authMiddleware, messageController.sendPoll);
router.post('/sessions/:id/send-buttons', authMiddleware, messageController.sendButtons);
router.post('/sessions/:id/send-interactive', authMiddleware, messageController.sendInteractive);

export default router;

