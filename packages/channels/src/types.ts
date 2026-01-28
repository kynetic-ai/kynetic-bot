/**
 * Channel Registry Types
 *
 * Types for channel adapter registration and management.
 */

import type { KyneticError } from '@kynetic-bot/core';

/**
 * Result type for operations that can fail
 */
export type Result<T, E extends KyneticError = KyneticError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Validation error for invalid adapter registration
 */
export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly missingMethods: string[];

  constructor(message: string, missingMethods: string[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.missingMethods = missingMethods;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}
