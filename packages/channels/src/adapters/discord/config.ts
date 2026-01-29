/**
 * Discord Adapter Configuration
 *
 * Zod schema for validating Discord adapter configuration.
 */

import { z } from 'zod';
import { GatewayIntentBits, Partials } from 'discord.js';

/**
 * Discord adapter configuration schema
 *
 * Required fields:
 * - token: Discord bot token
 *
 * Optional fields with defaults:
 * - intents: Gateway intents (default: Guilds, GuildMessages, DirectMessages, MessageContent)
 * - partials: Partial structures to receive (default: Channel for DM support)
 * - maxMessageLength: Maximum message length before splitting (default: 2000)
 * - splitStrategy: How to handle long messages (default: 'split')
 */
export const DiscordAdapterConfigSchema = z.object({
  // Required
  token: z
    .string({ required_error: 'Discord token is required' })
    .min(1, 'Discord token is required'),

  // Optional with defaults
  intents: z
    .array(z.nativeEnum(GatewayIntentBits))
    .default([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ]),

  partials: z
    .array(z.nativeEnum(Partials))
    .default([Partials.Channel]),

  maxMessageLength: z.number().int().positive().default(2000),

  splitStrategy: z.enum(['split', 'embed']).default('split'),
});

export type DiscordAdapterConfig = z.infer<typeof DiscordAdapterConfigSchema>;
