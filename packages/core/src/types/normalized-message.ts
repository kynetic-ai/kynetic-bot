/**
 * Normalized Message Type
 *
 * A platform-agnostic representation of a message from any chat platform.
 * This type provides a unified interface for handling messages across different channels.
 */

/**
 * Attachment to a message (e.g., images, files, documents)
 */
export interface Attachment {
  /** Type of attachment (e.g., 'image', 'file', 'video', 'audio') */
  type: string;
  /** URL or path to the attachment */
  url: string;
  /** MIME type of the attachment */
  mimeType?: string;
  /** File name */
  filename?: string;
  /** File size in bytes */
  size?: number;
  /** Additional attachment metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Sender information for a normalized message
 */
export interface MessageSender {
  /** Unique identifier for the sender on the platform */
  id: string;
  /** Platform the sender is on (e.g., 'whatsapp', 'telegram', 'discord') */
  platform: string;
  /** Display name of the sender (if available) */
  displayName?: string;
}

/**
 * Normalized message representation
 *
 * This type provides a platform-agnostic view of messages from any channel.
 * Platform-specific details are preserved in the metadata field.
 */
export interface NormalizedMessage {
  /** Unique message identifier */
  id: string;
  /** Message text content */
  text: string;
  /** Sender information */
  sender: MessageSender;
  /** When the message was sent */
  timestamp: Date;
  /** Channel identifier (platform-specific) */
  channel: string;
  /** Platform-specific metadata */
  metadata: Record<string, unknown>;
  /** Message attachments (if any) */
  attachments?: Attachment[];
}
