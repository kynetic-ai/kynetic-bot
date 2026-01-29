/**
 * Discord Message Parser
 *
 * Transforms Discord.js Message objects into NormalizedMessage format.
 */

import type { Message, PartialMessage, Attachment as DiscordAttachment } from 'discord.js';
import type { NormalizedMessage, Attachment } from '@kynetic-bot/core';

/**
 * Discord-specific metadata included in NormalizedMessage
 */
export interface DiscordMessageMetadata extends Record<string, unknown> {
  /** Guild ID if message is in a server */
  guildId?: string;
  /** Guild name if available */
  guildName?: string;
  /** Whether this message is in a thread */
  isThread?: boolean;
  /** Parent channel ID if message is in a thread */
  parentChannelId?: string;
  /** Whether this message is a DM */
  isDM?: boolean;
  /** Message embeds (raw Discord embed data) */
  embeds?: unknown[];
  /** Referenced message ID if this is a reply */
  referencedMessageId?: string;
}

/**
 * Parse Discord attachments into normalized format
 *
 * @param attachments - Discord.js attachment collection
 * @returns Array of normalized attachments
 */
export function parseAttachments(
  attachments: Message['attachments'],
): Attachment[] {
  return attachments.map((attachment: DiscordAttachment) => ({
    type: getAttachmentType(attachment.contentType),
    url: attachment.url,
    mimeType: attachment.contentType ?? undefined,
    filename: attachment.name ?? undefined,
    size: attachment.size,
    metadata: {
      proxyUrl: attachment.proxyURL,
      width: attachment.width,
      height: attachment.height,
    },
  }));
}

/**
 * Determine attachment type from MIME type
 */
function getAttachmentType(contentType: string | null): string {
  if (!contentType) return 'file';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Parse an incoming Discord message into normalized format
 *
 * Returns null if the message should be filtered out (e.g., bot's own messages).
 *
 * @param message - Discord.js Message object
 * @param botUserId - The bot's user ID for self-filtering
 * @returns NormalizedMessage or null if message should be filtered
 */
export async function parseIncoming(
  message: Message | PartialMessage,
  botUserId: string,
): Promise<NormalizedMessage | null> {
  // AC-5: Filter out bot's own messages
  if (message.author?.id === botUserId) {
    return null;
  }

  // Handle partial messages - fetch full message if needed
  let fullMessage: Message;
  if (message.partial) {
    try {
      fullMessage = await message.fetch();
    } catch {
      // Failed to fetch partial message, skip it
      return null;
    }
  } else {
    fullMessage = message;
  }

  // Filter out messages from other bots (optional, but common pattern)
  if (fullMessage.author.bot) {
    return null;
  }

  // Build metadata
  const metadata: DiscordMessageMetadata = {};

  // Guild info
  if (fullMessage.guild) {
    metadata.guildId = fullMessage.guild.id;
    metadata.guildName = fullMessage.guild.name;
  }

  // AC-6: Thread handling
  if (fullMessage.channel.isThread()) {
    metadata.isThread = true;
    metadata.parentChannelId = fullMessage.channel.parentId ?? undefined;
  }

  // AC-7: DM handling
  if (fullMessage.channel.isDMBased()) {
    metadata.isDM = true;
  }

  // Embeds
  if (fullMessage.embeds.length > 0) {
    metadata.embeds = fullMessage.embeds.map((e) => e.toJSON());
  }

  // Reply reference
  if (fullMessage.reference?.messageId) {
    metadata.referencedMessageId = fullMessage.reference.messageId;
  }

  // Build normalized message (AC-1)
  const normalized: NormalizedMessage = {
    id: fullMessage.id,
    text: fullMessage.content,
    sender: {
      id: fullMessage.author.id,
      platform: 'discord',
      displayName:
        fullMessage.member?.displayName ?? fullMessage.author.displayName,
    },
    timestamp: fullMessage.createdAt,
    channel: fullMessage.channelId,
    metadata,
    attachments:
      fullMessage.attachments.size > 0
        ? parseAttachments(fullMessage.attachments)
        : undefined,
  };

  return normalized;
}
