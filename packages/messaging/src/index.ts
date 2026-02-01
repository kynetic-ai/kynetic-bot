// Types
export type { Session, SessionStore } from './types.js';

// Session Store
export { InMemorySessionStore } from './session-store.js';

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
export { StreamCoalescer, BufferedCoalescer, type StreamOptions } from './streaming.js';

// History
export {
  ConversationHistory,
  type HistoryEntry,
  type HistoryOptions,
  type CleanupResult,
  type TurnInput,
} from './history.js';

// Context Window Management
export {
  ContextWindowManager,
  HaikuSummaryProvider,
  MockSummaryProvider,
  type ContextWindowOptions,
  type CompactedSummary,
  type ContextEntry,
  type ContextResult,
  type SummaryProvider,
  type ContextWindowEvents,
  type ACPPromptClient,
  type HaikuSummaryProviderOptions,
} from './context/index.js';

// Context Usage Tracking
export {
  ContextUsageTracker,
  parseUsageOutput,
  type ContextCategory,
  type ContextUsageUpdate,
  type ContextUsageTrackerOptions,
  type ContextUsageTrackerEvents,
  type UsagePromptClient,
  type StderrProvider,
} from './context/index.js';

// Turn Selection
export {
  ToolSummarizer,
  TurnSelector,
  type DetectedToolCall,
  type ToolSummary,
  type TurnSelectorOptions,
  type EstimatedTurn,
  type TurnSelectionResult,
} from './context/index.js';

// Context Restoration
export {
  ContextRestorer,
  type ContextRestorationResult,
  type ContextRestorationStats,
  type ContextRestorerOptions,
  type ContextRestorerLogger,
} from './context/index.js';

// Session Lifecycle
export {
  SessionLifecycleManager,
  type SessionState,
  type GetSessionResult,
  type SessionACPClient,
  type SessionConversationStore,
  type SessionMemoryStore,
  type SessionLifecycleManagerOptions,
  type SessionLifecycleEvents,
} from './session/index.js';
