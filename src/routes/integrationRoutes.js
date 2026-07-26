import express from 'express';
import rateLimit from 'express-rate-limit';
import { apiAuthMiddleware } from '../middleware/apiAuth.js';
import { config } from '../config/index.js';
import * as sessionController from '../controllers/sessionController.js';
import * as messageController from '../controllers/messageController.js';

const router = express.Router();
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.API_KEY ? 1000 : 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

router.use((req, res, next) =>
  (req.method === 'GET' || req.method === 'HEAD' ? readLimiter : writeLimiter)(req, res, next)
);
router.use(apiAuthMiddleware);
router.get('/', sessionController.listSessions);
router.get('/:id', sessionController.getSession);
router.post('/:id/connect', sessionController.connectSession);
router.get('/:id/qr', sessionController.getSessionQr);
router.post('/:id/pair', sessionController.pairSession);
router.post('/:id/send', messageController.sendMessage);
router.post('/:id/send-image', messageController.sendImage);
router.post('/:id/send-poll', messageController.sendPoll);
router.post('/:id/send-buttons', messageController.sendButtons);
router.post('/:id/send-interactive', messageController.sendInteractive);
router.post('/:id/send-bulk', messageController.sendBulk);
router.delete('/:id', sessionController.deleteSession);

export default router;
