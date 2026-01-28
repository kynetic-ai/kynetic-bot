/**
 * Shared test utilities for kynetic-bot packages
 */

/**
 * Creates a delay for testing async behavior
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mock factory helpers will be added here as types are defined
 * Example:
 * export const createMockMessage = (overrides?: Partial<Message>): Message => ({
 *   id: 'test-msg-123',
 *   content: 'test message',
 *   timestamp: Date.now(),
 *   ...overrides,
 * });
 */
