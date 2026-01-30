// Configuration
export {
  BotConfigSchema,
  LogLevelSchema,
  loadConfig,
  type BotConfig,
  type LogLevel,
} from './config.js';

// Bot orchestration
export {
  Bot,
  type BotState,
  type BotOptions,
  type EscalationContext,
} from './bot.js';

// Re-export transformer types for convenience
export {
  MessageTransformer,
  type PlatformTransformer,
  UnsupportedTypeError,
  MissingTransformerError,
} from '@kynetic-bot/messaging';

// Identity
export {
  buildIdentityPrompt,
  loadCustomIdentity,
  getBaseIdentity,
  CustomIdentitySchema,
  type CustomIdentity,
} from './identity.js';
