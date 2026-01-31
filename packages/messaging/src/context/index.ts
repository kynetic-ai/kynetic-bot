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

export {
  ContextUsageTracker,
  parseUsageOutput,
  type ContextCategory,
  type ContextUsageUpdate,
  type ContextUsageTrackerOptions,
  type ContextUsageTrackerEvents,
  type UsagePromptClient,
  type StderrProvider,
} from './context-usage-tracker.js';

export { ToolSummarizer, type DetectedToolCall, type ToolSummary } from './tool-summarizer.js';

export {
  TurnSelector,
  type TurnSelectorOptions,
  type EstimatedTurn,
  type TurnSelectionResult,
} from './turn-selector.js';
