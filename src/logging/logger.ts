import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  const level = opts.level ?? 'info';
  if (opts.pretty) {
    return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } });
  }
  return pino({ level });
}

export const silentLogger: Logger = pino({ level: 'silent' });
