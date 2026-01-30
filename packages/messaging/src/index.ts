// Types
export type { Session, SessionStore } from './types.js';

// Router
export { SessionKeyRouter, type Result } from './router.js';

// Transformer
export {
  MessageTransformer,
  type PlatformTransformer,
  UnsupportedTypeError,
  MissingTransformerError,
} from './transformer.js';

// Streaming
export {
  StreamCoalescer,
  BufferedCoalescer,
  type StreamOptions,
} from './streaming.js';

// History
export {
  ConversationHistory,
  type HistoryEntry,
  type HistoryOptions,
  type CleanupResult,
} from './history.js';
