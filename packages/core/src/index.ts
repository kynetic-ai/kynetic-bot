// Types
export type {
  NormalizedMessage,
  MessageSender,
  Attachment,
} from './types/normalized-message.js';
export type {
  SessionKey,
  ParsedSessionKey,
  PeerKind,
} from './types/session-key.js';
export type { ChannelAdapter } from './types/channel-adapter.js';

// Utilities - Logger
export { createLogger, type Logger } from './utils/logger.js';

// Utilities - Type Guards
export {
  hasProperty,
  isString,
  isNumber,
  isObject,
} from './utils/type-guards.js';

// Utilities - Session Keys
export {
  parseSessionKey,
  buildSessionKey,
  isValidSessionKey,
} from './utils/session-key.js';

// Utilities - Errors
export {
  KyneticError,
  UnknownAgentError,
  InvalidSessionKeyError,
} from './utils/errors.js';
