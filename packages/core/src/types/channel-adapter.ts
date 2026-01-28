/**
 * Channel Adapter Interface
 *
 * Defines the contract for platform-specific channel adapters.
 * Each platform (WhatsApp, Telegram, Discord, etc.) implements this interface.
 */

import type { NormalizedMessage } from './normalized-message.js';

/**
 * Channel adapter for a specific messaging platform
 *
 * Adapters translate between platform-specific message formats and the
 * normalized message format used internally.
 */
export interface ChannelAdapter {
  /** Platform identifier (e.g., 'whatsapp', 'telegram', 'discord') */
  readonly platform: string;

  /**
   * Start the adapter and begin listening for messages
   */
  start(): Promise<void>;

  /**
   * Stop the adapter and clean up resources
   */
  stop(): Promise<void>;

  /**
   * Send a message through this channel
   *
   * @param channel - Channel identifier (platform-specific)
   * @param text - Message text to send
   * @param options - Platform-specific send options
   */
  sendMessage(
    channel: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Register a handler for incoming messages
   *
   * @param handler - Callback to invoke when messages are received
   */
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): void;
}
