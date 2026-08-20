import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface LoggerConfig {
  level?: LogLevel;
  /** Human-readable output for a terminal; JSON lines otherwise. */
  pretty?: boolean;
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    base: null,
    ...(config.pretty === true
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : {}),
  };
  return pino(options);
}

/** Discards everything. Tests assert on behaviour, not log output. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
