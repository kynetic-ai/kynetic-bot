/**
 * Discord Adapter Module
 *
 * Re-exports all Discord adapter components.
 */

// Main adapter
export { DiscordAdapter, type DiscordSendOptions } from './adapter.js';

// Configuration
export {
  DiscordAdapterConfigSchema,
  type DiscordAdapterConfig,
} from './config.js';

// Errors
export {
  DiscordConnectionError,
  DiscordSendError,
  DiscordChannelNotFoundError,
  DiscordPermissionError,
} from './errors.js';

// Parser (for advanced use cases)
export {
  parseIncoming,
  parseAttachments,
  type DiscordMessageMetadata,
} from './parser.js';

// Splitter (for testing or custom splitting)
export { splitMessage } from './splitter.js';
