/**
 * Channel Registry
 *
 * Manages registration and lookup of platform channel adapters.
 */

import type { ChannelAdapter } from '@kynetic-bot/core';
import { ValidationError, type Result } from './types.js';

/**
 * Registry for channel adapters
 *
 * Provides registration, validation, and lookup of platform adapters.
 */
export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();

  /**
   * Register a new channel adapter
   *
   * Validates the adapter interface before registration.
   *
   * @param adapter - Channel adapter to register
   * @returns Result with void on success or ValidationError on failure
   */
  register(adapter: ChannelAdapter): Result<void, ValidationError> {
    // AC-1: Validate adapter interface before registration
    const validationError = this.validateAdapter(adapter);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    // AC-1: Add valid adapter to registry
    this.adapters.set(adapter.platform, adapter);
    return { ok: true, value: undefined };
  }

  /**
   * Get an adapter for a specific platform
   *
   * @param platform - Platform identifier (e.g., 'whatsapp', 'telegram')
   * @returns Channel adapter for the platform, or undefined if not found
   */
  getAdapter(platform: string): ChannelAdapter | undefined {
    // AC-2: Returns correct adapter for the platform
    return this.adapters.get(platform);
  }

  /**
   * List all registered adapters
   *
   * @returns Array of all registered channel adapters
   */
  listAdapters(): ChannelAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Unregister an adapter by platform
   *
   * @param platform - Platform identifier to unregister
   * @returns True if adapter was found and removed, false otherwise
   */
  unregister(platform: string): boolean {
    return this.adapters.delete(platform);
  }

  /**
   * Check if an adapter is registered for a platform
   *
   * @param platform - Platform identifier to check
   * @returns True if adapter is registered, false otherwise
   */
  hasAdapter(platform: string): boolean {
    return this.adapters.has(platform);
  }

  /**
   * Clear all registered adapters
   */
  clear(): void {
    this.adapters.clear();
  }

  /**
   * Validate that an adapter implements the required interface
   *
   * @param adapter - Adapter to validate
   * @returns ValidationError if invalid, null if valid
   */
  private validateAdapter(adapter: unknown): ValidationError | null {
    // AC-3: Validate adapter interface
    if (!adapter || typeof adapter !== 'object') {
      return new ValidationError('Adapter must be an object');
    }

    const required = ['platform', 'start', 'stop', 'sendMessage', 'onMessage'];
    const missing: string[] = [];

    for (const method of required) {
      const value = (adapter as Record<string, unknown>)[method];

      if (method === 'platform') {
        // platform is a readonly string property
        if (typeof value !== 'string') {
          missing.push(method);
        }
      } else {
        // All other methods are functions
        if (typeof value !== 'function') {
          missing.push(method);
        }
      }
    }

    // AC-3: Return validation error listing missing methods
    if (missing.length > 0) {
      return new ValidationError(
        `Adapter is missing required properties: ${missing.join(', ')}`,
        missing,
      );
    }

    return null;
  }
}
