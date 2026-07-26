import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { config } from './config/index.js';

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  return {
    type: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    statusCode: error.statusCode || error.response?.status
  };
}

fs.mkdirSync(path.dirname(config.LOG_FILE), { recursive: true });

const logOutput = pino.multistream([
  { stream: process.stdout },
  { stream: pino.destination({ dest: config.LOG_FILE, sync: false }) }
]);

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: serializeError },
    redact: {
      paths: [
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'headers["x-webhook-secret"]',
        'webhookSecret'
      ],
      censor: '[Redacted]'
    }
  },
  logOutput
);
