/**
 * Message Transformer
 *
 * Handles platform-specific message normalization and denormalization.
 */

import type { NormalizedMessage } from '@kynetic-bot/core';
import { KyneticError } from '@kynetic-bot/core';

/**
 * Result type for operations that can fail
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Error thrown when an unsupported content type is encountered
 */
export class UnsupportedTypeError extends KyneticError {
  constructor(contentType: string, platform: string, context?: Record<string, unknown>) {
    super(
      `Unsupported content type: ${contentType} for platform ${platform}`,
      'UNSUPPORTED_TYPE',
      {
        ...context,
        contentType,
        platform,
      },
    );
  }
}

/**
 * Error thrown when a platform transformer is not registered
 */
export class MissingTransformerError extends KyneticError {
  constructor(platform: string, context?: Record<string, unknown>) {
    super(
      `No transformer registered for platform: ${platform}`,
      'MISSING_TRANSFORMER',
      {
        ...context,
        platform,
      },
    );
  }
}

/**
 * Platform-specific message transformer
 *
 * Transforms between platform-specific and normalized message formats.
 */
export interface PlatformTransformer {
  /** Platform identifier (e.g., 'whatsapp', 'telegram') */
  platform: string;

  /**
   * Normalize a platform-specific message to standard format
   *
   * @param raw - Raw platform-specific message
   * @returns Result with normalized message or error
   */
  normalize(raw: unknown): Result<NormalizedMessage, KyneticError>;

  /**
   * Denormalize a standard message to platform-specific format
   *
   * @param message - Normalized message
   * @returns Result with platform-specific format or error
   */
  denormalize(message: NormalizedMessage): Result<unknown, KyneticError>;
}

/**
 * Message transformer registry and dispatcher
 *
 * Manages platform-specific transformers and routes transformation requests.
 */
export class MessageTransformer {
  private transformers = new Map<string, PlatformTransformer>();

  /**
   * Register a platform transformer
   *
   * @param transformer - Platform transformer to register
   */
  registerTransformer(transformer: PlatformTransformer): void {
    this.transformers.set(transformer.platform, transformer);
  }

  /**
   * Normalize a platform-specific message
   *
   * @param platform - Platform identifier
   * @param raw - Raw platform-specific message
   * @returns Result with normalized message or error
   */
  normalize(platform: string, raw: unknown): Result<NormalizedMessage, KyneticError> {
    const transformer = this.transformers.get(platform);

    // Check if transformer is registered
    if (!transformer) {
      return {
        ok: false,
        error: new MissingTransformerError(platform, { raw }),
      };
    }

    // AC-1: Transform platform message to normalized format
    return transformer.normalize(raw);
  }

  /**
   * Denormalize a message to platform-specific format
   *
   * @param platform - Target platform identifier
   * @param message - Normalized message
   * @returns Result with platform-specific format or error
   */
  denormalize(
    platform: string,
    message: NormalizedMessage,
  ): Result<unknown, KyneticError> {
    const transformer = this.transformers.get(platform);

    // Check if transformer is registered
    if (!transformer) {
      return {
        ok: false,
        error: new MissingTransformerError(platform, { messageId: message.id }),
      };
    }

    // AC-2: Transform normalized message to platform format
    return transformer.denormalize(message);
  }

  /**
   * Check if a transformer is registered for a platform
   *
   * @param platform - Platform identifier to check
   * @returns True if transformer exists, false otherwise
   */
  hasTransformer(platform: string): boolean {
    return this.transformers.has(platform);
  }

  /**
   * Get list of registered platforms
   *
   * @returns Array of platform identifiers
   */
  listPlatforms(): string[] {
    return Array.from(this.transformers.keys());
  }

  /**
   * Unregister a transformer by platform
   *
   * @param platform - Platform identifier to unregister
   * @returns True if transformer was found and removed, false otherwise
   */
  unregisterTransformer(platform: string): boolean {
    return this.transformers.delete(platform);
  }

  /**
   * Clear all registered transformers
   */
  clear(): void {
    this.transformers.clear();
  }
}
