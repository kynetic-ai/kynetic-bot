// Registry
export { ChannelRegistry } from './registry.js';

// Lifecycle
export { ChannelLifecycle, type LifecycleOptions, type LifecycleState } from './lifecycle.js';

// Media
export {
  MediaHandler,
  SizeLimitError,
  UnsupportedMediaTypeError,
  type MediaConfig,
  type MediaAttachment,
} from './media.js';

// DM Policy
export {
  DMPolicyManager,
  DMPolicyError,
  DMPolicyValidationError,
  DMPolicySchema,
  DMRequestStatusSchema,
  PendingDMRequestSchema,
  CreateDMRequestInputSchema,
  type DMPolicy,
  type DMRequestStatus,
  type PendingDMRequest,
  type CreateDMRequestInput,
  type ChannelPolicyConfig,
  type DMPolicyManagerOptions,
  type DMPolicyEvents,
} from './dm-policy.js';

// Discord Adapter
export {
  DiscordAdapter,
  DiscordAdapterConfigSchema,
  type DiscordAdapterConfig,
  type DiscordSendOptions,
  DiscordConnectionError,
  DiscordSendError,
  DiscordChannelNotFoundError,
  DiscordPermissionError,
  type DiscordMessageMetadata,
  StreamingSplitTracker,
  type SplitDecision,
} from './adapters/discord/index.js';

// Typing Indicator
export { TypingIndicatorManager } from './typing-indicator-manager.js';

// Types
export { ValidationError, type Result } from './types.js';
