import pino, { type Logger } from 'pino';

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: {
      application: 'ithome-ironman-publisher',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
