/**
 * Discord Adapter Error Types
 *
 * Discord-specific errors extending KyneticError base class.
 */

import { KyneticError } from '@kynetic-bot/core';

/**
 * Error thrown when Discord connection fails
 */
export class DiscordConnectionError extends KyneticError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DISCORD_CONNECTION_ERROR', context);
  }
}

/**
 * Error thrown when sending a Discord message fails
 */
export class DiscordSendError extends KyneticError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DISCORD_SEND_ERROR', context);
  }
}

/**
 * Error thrown when a Discord channel is not found (Discord error 10003)
 */
export class DiscordChannelNotFoundError extends KyneticError {
  constructor(channelId: string, context?: Record<string, unknown>) {
    super(`Channel not found: ${channelId}`, 'DISCORD_CHANNEL_NOT_FOUND', {
      ...context,
      channelId,
    });
  }
}

/**
 * Error thrown when missing Discord permissions (Discord errors 50001, 50013)
 */
export class DiscordPermissionError extends KyneticError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'DISCORD_PERMISSION_ERROR', context);
  }
}
