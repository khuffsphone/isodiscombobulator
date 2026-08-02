export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

/** Structured JSON lines on stderr, so stdout stays machine-parseable. */
export class StderrSink implements LogSink {
  write(entry: LogEntry): void {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly sink: LogSink = new StderrSink(),
    private readonly minLevel: LogLevel = 'info',
  ) {}

  child(scope: string): Logger {
    return new Logger(`${this.scope}.${scope}`, this.sink, this.minLevel);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const entry: LogEntry = { at: new Date().toISOString(), level, scope: this.scope, message };
    if (data) entry.data = data;
    this.sink.write(entry);
  }
}

export const silentLogger = new Logger('romlab', { write: () => {} }, 'error');
