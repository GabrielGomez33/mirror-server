// ============================================================================
// PRODUCTION-READY LOGGER UTILITY
// ============================================================================
// File: utils/logger.ts
// ----------------------------------------------------------------------------
// Structured logging with levels, context, and metadata
// Thread-safe, performance-optimized, production-ready
// ============================================================================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4
}

export interface LogEntry {
  timestamp: string;
  level: string;
  context: string;
  message: string;
  metadata?: any;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class Logger {
  private context: string;
  private static minLevel: LogLevel = process.env.NODE_ENV === 'production'
    ? LogLevel.INFO
    : LogLevel.DEBUG;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Set minimum log level globally
   */
  static setMinLevel(level: LogLevel): void {
    Logger.minLevel = level;
  }

  /**
   * Debug level logging (development only)
   */
  debug(message: string, metadata?: any): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  /**
   * Info level logging
   */
  info(message: string, metadata?: any): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  /**
   * Warning level logging
   */
  warn(message: string, metadata?: any): void {
    this.log(LogLevel.WARN, message, metadata);
  }

  /**
   * Error level logging
   */
  error(message: string, error?: Error | any, metadata?: any): void {
    const errorData = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : error;

    this.log(LogLevel.ERROR, message, metadata, errorData);
  }

  /**
   * Fatal level logging
   */
  fatal(message: string, error?: Error | any, metadata?: any): void {
    const errorData = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack
    } : error;

    this.log(LogLevel.FATAL, message, metadata, errorData);
  }

  /**
   * Internal log method
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: any,
    error?: any
  ): void {
    // Skip if below minimum level
    if (level < Logger.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      context: this.context,
      message,
      ...(metadata && { metadata }),
      ...(error && { error })
    };

    // Output based on level
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(this.formatLog(entry));
        break;
      case LogLevel.INFO:
        console.log(this.formatLog(entry));
        break;
      case LogLevel.WARN:
        console.warn(this.formatLog(entry));
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(this.formatLog(entry));
        break;
    }

    // In production, could send to external logging service
    if (process.env.NODE_ENV === 'production' && level >= LogLevel.ERROR) {
      this.sendToExternalLogger(entry);
    }
  }

  /**
   * Format log entry for console output
   */
  private formatLog(entry: LogEntry): string {
    if (process.env.NODE_ENV === 'production') {
      // JSON format for production (easier to parse)
      return JSON.stringify(entry);
    } else {
      // Human-readable format for development
      const color = this.getLevelColor(entry.level);
      const reset = '\x1b[0m';

      let output = `${color}[${entry.timestamp}] [${entry.level}] [${entry.context}]${reset} ${entry.message}`;

      if (entry.metadata) {
        output += `\n  Metadata: ${JSON.stringify(entry.metadata, null, 2)}`;
      }

      if (entry.error) {
        output += `\n  Error: ${entry.error.message}`;
        if (entry.error.stack) {
          output += `\n${entry.error.stack}`;
        }
      }

      return output;
    }
  }

  /**
   * Get ANSI color code for log level
   */
  private getLevelColor(level: string): string {
    const colors: Record<string, string> = {
      DEBUG: '\x1b[36m',   // Cyan
      INFO: '\x1b[32m',    // Green
      WARN: '\x1b[33m',    // Yellow
      ERROR: '\x1b[31m',   // Red
      FATAL: '\x1b[35m'    // Magenta
    };
    return colors[level] || '\x1b[0m';
  }

  /**
   * Send to external logging service (placeholder)
   */
  private sendToExternalLogger(entry: LogEntry): void {
    // In production, integrate with:
    // - CloudWatch Logs
    // - DataDog
    // - Sentry
    // - Custom logging service

    // For now, just ensure it's in the log stream
    // Future: Send to remote endpoint
  }

  /**
   * Create child logger with extended context
   */
  child(subContext: string): Logger {
    return new Logger(`${this.context}:${subContext}`);
  }

  /**
   * Time a function execution
   */
  async time<T>(
    label: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    this.debug(`Starting: ${label}`);

    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.info(`Completed: ${label}`, { duration: `${duration}ms` });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.error(`Failed: ${label}`, error, { duration: `${duration}ms` });
      throw error;
    }
  }
}

// Export singleton for general use
export const logger = new Logger('Mirror');
