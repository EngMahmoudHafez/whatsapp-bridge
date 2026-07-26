import fs from 'fs/promises';
import { config } from '../config/index.js';

const MAX_LOG_READ_BYTES = 512 * 1024;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 500;

// Cases: missing/non-integer uses the default; integers outside the bounds are clamped.
function requestedLineCount(rawCount) {
  const parsedCount = Number(rawCount || DEFAULT_LOG_LINES);
  if (!Number.isInteger(parsedCount)) return DEFAULT_LOG_LINES;
  return Math.min(Math.max(parsedCount, 1), MAX_LOG_LINES);
}

async function readLogTail() {
  const logFile = await fs.open(config.LOG_FILE, 'r');
  try {
    const { size } = await logFile.stat();
    const byteCount = Math.min(size, MAX_LOG_READ_BYTES);
    const logBuffer = Buffer.alloc(byteCount);
    await logFile.read(logBuffer, 0, byteCount, size - byteCount);
    return logBuffer.toString('utf8');
  } finally {
    await logFile.close();
  }
}

function parsedLogEntries(logText) {
  const entries = [];
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return entries;
}

export async function listLogs(req, res, next) {
  try {
    const lineCount = requestedLineCount(req.query.limit);
    const entries = parsedLogEntries(await readLogTail()).slice(-lineCount);
    res.json({ logFile: config.LOG_FILE, entries });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      res.json({ logFile: config.LOG_FILE, entries: [] });
      return;
    }
    next(error);
  }
}
