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
   * @returns Optional message ID for platforms that support it
   */
  sendMessage(
    channel: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<string | void>;

  /**
   * Edit an existing message (optional)
   *
   * Used for streaming responses on platforms that support message editing.
   * Not all platforms support this - check supportsEditing() or handle gracefully.
   *
   * @param channel - Channel identifier (platform-specific)
   * @param messageId - ID of the message to edit
   * @param newText - New message text
   * @returns Optional updated message ID
   */
  editMessage?(
    channel: string,
    messageId: string,
    newText: string,
  ): Promise<string | void>;

  /**
   * Register a handler for incoming messages
   *
   * @param handler - Callback to invoke when messages are received
   */
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): void;
}
