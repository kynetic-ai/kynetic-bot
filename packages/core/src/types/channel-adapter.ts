/**
 * Channel Adapter Interface
 *
 * Defines the contract for platform-specific channel adapters.
 * Each platform (WhatsApp, Telegram, Discord, etc.) implements this interface.
 */

import type { NormalizedMessage } from './normalized-message.js';

/**
 * Result of editing a message that required splitting
 *
 * When message content exceeds platform limits during edit,
 * the adapter may split the content across multiple messages.
 */
export interface EditMessageResult {
  /** ID of the edited (first) message */
  editedId: string;
  /** IDs of overflow messages sent as follow-ups */
  overflowIds: string[];
}

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
    options?: Record<string, unknown>
  ): Promise<string | void>;

  /**
   * Edit an existing message (optional)
   *
   * Used for streaming responses on platforms that support message editing.
   * Not all platforms support this - check supportsEditing() or handle gracefully.
   *
   * For platforms with message length limits (e.g., Discord's 2000 char limit),
   * implementations may split content and send overflow as follow-up messages.
   *
   * @param channel - Channel identifier (platform-specific)
   * @param messageId - ID of the message to edit
   * @param newText - New message text
   * @returns Message ID, split result with overflow IDs, or void
   */
  editMessage?(
    channel: string,
    messageId: string,
    newText: string
  ): Promise<string | EditMessageResult | void>;

  /**
   * Register a handler for incoming messages
   *
   * @param handler - Callback to invoke when messages are received
   */
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): void;

  /**
   * Send a typing indicator to the channel (optional)
   *
   * Used to show the user that the bot is processing their message.
   * Not all platforms support this - adapters that don't support it
   * simply don't implement this method.
   *
   * @param channel - Channel identifier (platform-specific)
   */
  sendTyping?(channel: string): Promise<void>;

  /**
   * Perform platform-specific health check (optional)
   *
   * Used by lifecycle managers to verify the adapter's connection is healthy.
   * Platforms that support health checks (e.g., Discord's WebSocket ping)
   * should implement this method.
   *
   * @returns Promise that resolves to true if healthy, false otherwise
   */
  healthCheck?(): Promise<boolean>;
}
