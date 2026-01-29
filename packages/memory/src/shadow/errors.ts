/**
 * Shadow Branch Error Types
 *
 * Custom error classes for kbot shadow branch operations.
 * Extends KyneticError base class for consistent error handling.
 */

import { KyneticError } from '@kynetic-bot/core';

/**
 * Error codes for shadow branch operations
 */
export type KbotShadowErrorCode =
  | 'NOT_INITIALIZED'
  | 'WORKTREE_DISCONNECTED'
  | 'DIRECTORY_MISSING'
  | 'GIT_ERROR'
  | 'RUNNING_FROM_SHADOW'
  | 'COMMIT_FAILED'
  | 'RECOVERY_FAILED';

/**
 * Error thrown for shadow branch operation failures.
 * Includes a suggestion for how to resolve the issue.
 *
 * AC-3: Returns clear error with init suggestion when .kbot/ not found
 */
export class KbotShadowError extends KyneticError {
  /** Suggestion for how to resolve the error */
  readonly suggestion: string;
  /** Specific shadow error code */
  readonly shadowCode: KbotShadowErrorCode;

  constructor(
    message: string,
    code: KbotShadowErrorCode,
    suggestion: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `KBOT_SHADOW_${code}`, context);
    this.name = 'KbotShadowError';
    this.shadowCode = code;
    this.suggestion = suggestion;
  }

  /**
   * Format error for display with suggestion
   */
  format(): string {
    return `${this.message}\n\nSuggestion: ${this.suggestion}`;
  }
}

/**
 * Error thrown when validation fails for state data.
 *
 * AC-5: Rejects with structured validation error for invalid state data
 */
export class KbotValidationError extends KyneticError {
  /** Field that failed validation */
  readonly field: string;
  /** Expected type for the field */
  readonly expectedType: string;
  /** Actual value received (for debugging) */
  readonly actualValue?: unknown;

  constructor(
    message: string,
    field: string,
    expectedType: string,
    actualValue?: unknown,
    context?: Record<string, unknown>,
  ) {
    super(message, 'KBOT_VALIDATION_ERROR', {
      ...context,
      field,
      expectedType,
      actualValue:
        actualValue !== undefined ? JSON.stringify(actualValue) : undefined,
    });
    this.name = 'KbotValidationError';
    this.field = field;
    this.expectedType = expectedType;
    this.actualValue = actualValue;
  }
}
