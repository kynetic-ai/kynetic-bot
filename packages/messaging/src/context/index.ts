/**
 * Context management exports for @kynetic-bot/messaging
 *
 * Provides context window management with token-based compaction.
 */

export {
  ContextWindowManager,
  type ContextWindowOptions,
  type CompactedSummary,
  type ContextEntry,
  type ContextResult,
  type SummaryProvider,
  type ContextWindowEvents,
} from './context-window.js';

export {
  HaikuSummaryProvider,
  MockSummaryProvider,
  type ACPPromptClient,
  type HaikuSummaryProviderOptions,
} from './haiku-summary-provider.js';
