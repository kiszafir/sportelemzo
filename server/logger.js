// Structured JSON-lines logger (stdout). One object per line, easy to grep or pipe into jq.
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  if (fields.err instanceof Error) rec.err = { message: fields.err.message, code: fields.err.code };
  const line = JSON.stringify(rec);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function createLogger(scope) {
  return {
    debug: (m, f) => emit('debug', m, { scope, ...f }),
    info: (m, f) => emit('info', m, { scope, ...f }),
    warn: (m, f) => emit('warn', m, { scope, ...f }),
    error: (m, f) => emit('error', m, { scope, ...f }),
  };
}

export const log = createLogger('app');
