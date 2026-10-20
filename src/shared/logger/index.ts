import { saveLog, type LogRecord } from '../db/index';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel | 'off', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 100
};

let currentLevel: LogLevel | 'off' = 'info';

export function setLogLevel(level: LogLevel | 'off'): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  if (currentLevel === 'off') return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emitConsole(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const payload = data ? { message, ...data } : message;
  if (level === 'error') {
    console.error('[beta]', payload);
  } else if (level === 'warn') {
    console.warn('[beta]', payload);
  } else {
    console.info('[beta]', payload);
  }
}

export async function log(level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> {
  if (!shouldLog(level)) return;
  emitConsole(level, message, data);
  try {
    await saveLog({
      level: level === 'debug' ? 'info' : level,
      message,
      data,
      createdAt: Date.now()
    } as LogRecord);
  } catch (err) {
    console.warn('[beta-logger] persist failed', err);
  }
}

export function info(message: string, data?: Record<string, unknown>): Promise<void> {
  return log('info', message, data);
}

export function warn(message: string, data?: Record<string, unknown>): Promise<void> {
  return log('warn', message, data);
}

export function error(message: string, data?: Record<string, unknown>): Promise<void> {
  return log('error', message, data);
}
