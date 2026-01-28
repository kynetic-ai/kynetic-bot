/**
 * Error Types
 *
 * Custom error classes for kynetic-bot application errors.
 */

/**
 * Base error class for all kynetic-bot errors
 */
export class KyneticError extends Error {
  /** Error code for programmatic error handling */
  readonly code: string;
  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an unknown agent is referenced
 */
export class UnknownAgentError extends KyneticError {
  constructor(agentId: string, context?: Record<string, unknown>) {
    super(`Unknown agent: ${agentId}`, 'UNKNOWN_AGENT', {
      ...context,
      agentId,
    });
  }
}

/**
 * Error thrown when a session key is invalid or malformed
 */
export class InvalidSessionKeyError extends KyneticError {
  constructor(key: string, reason?: string, context?: Record<string, unknown>) {
    const message = reason ? `Invalid session key: ${reason}` : 'Invalid session key';
    super(message, 'INVALID_SESSION_KEY', {
      ...context,
      key,
      reason,
    });
  }
}
