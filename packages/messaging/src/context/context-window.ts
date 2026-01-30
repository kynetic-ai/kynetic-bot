/**
 * ContextWindowManager - Context window management with compaction
 *
 * Manages conversation context with token-based compaction to maintain
 * optimal context size for LLM interactions.
 *
 * AC: @mem-context-window ac-1 - Compacts older messages when approaching token limit
 * AC: @mem-context-window ac-2 - Preserves semantic boundaries during compaction
 * AC: @mem-context-window ac-3 - Includes session file reference for direct agent access
 * AC: @mem-context-window ac-4 - Uses Haiku via ACP for summary generation
 *
 * @see @mem-context-window
 */

import { EventEmitter } from 'node:events';
import type { ConversationStore, ConversationTurn } from '@kynetic-bot/memory';
import type { ConversationHistory, HistoryEntry } from '../history.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration options for ContextWindowManager
 */
export interface ContextWindowOptions {
  /** Maximum tokens in context window (default: 100000) */
  maxTokens?: number;
  /** Soft compaction threshold as fraction of maxTokens (default: 0.7) */
  softThreshold?: number;
  /** Hard compaction threshold as fraction of maxTokens (default: 0.85) */
  hardThreshold?: number;
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
  /** Event emitter for observability (optional) */
  emitter?: EventEmitter;
}

/**
 * A compacted summary of older turns
 */
export interface CompactedSummary {
  /** Topics discussed in the summarized turns */
  topics: string[];
  /** Key user instructions or notes */
  keyInstructions: string[];
  /** Reference to session file for full context retrieval */
  sessionFileRef: string;
  /** Timestamp range of summarized turns */
  timestampRange: { start: number; end: number };
  /** Number of turns summarized */
  turnCount: number;
  /** Estimated tokens in summary */
  tokens: number;
}

/**
 * Context entry - either a full turn or a compacted summary
 */
export type ContextEntry =
  | { type: 'turn'; entry: HistoryEntry }
  | { type: 'summary'; summary: CompactedSummary };

/**
 * Result of getting context
 */
export interface ContextResult {
  /** Context entries in chronological order */
  entries: ContextEntry[];
  /** Total estimated tokens */
  totalTokens: number;
  /** Whether compaction was performed */
  compacted: boolean;
}

/**
 * Provider interface for summary generation
 *
 * AC: @mem-context-window ac-4 - Abstraction for Haiku summarization
 */
export interface SummaryProvider {
  /**
   * Generate a summary of conversation turns
   *
   * @param turns - Turns to summarize
   * @param sessionFileRef - Reference to the session file
   * @returns Summary text
   */
  summarize(turns: ConversationTurn[], sessionFileRef: string): Promise<string>;
}

/**
 * Events emitted by ContextWindowManager
 *
 * @trait-observable - Emits structured events for observability
 */
export interface ContextWindowEvents {
  'compaction:started': { sessionKey: string; currentTokens: number; threshold: 'soft' | 'hard' };
  'compaction:completed': { sessionKey: string; tokensBefore: number; tokensAfter: number; turnsSummarized: number };
  'context:retrieved': { sessionKey: string; totalTokens: number; entryCount: number };
  'error': { error: Error; operation: string; sessionKey?: string };
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MAX_TOKENS = 100000;
const DEFAULT_SOFT_THRESHOLD = 0.7;
const DEFAULT_HARD_THRESHOLD = 0.85;
const DEFAULT_CHARS_PER_TOKEN = 4;

// ============================================================================
// ContextWindowManager Implementation
// ============================================================================

/**
 * ContextWindowManager manages conversation context with token-based compaction.
 *
 * Key features:
 * - Token estimation for context size tracking
 * - Two-tier compaction (soft and hard thresholds)
 * - Semantic boundary preservation
 * - Summary generation via injectable provider
 *
 * @trait-observable - Emits events for state changes and errors
 * @trait-recoverable - Handles errors gracefully with event emission
 *
 * @example
 * ```typescript
 * const manager = new ContextWindowManager({
 *   store: conversationStore,
 *   history: conversationHistory,
 *   summaryProvider: myProvider,
 * });
 *
 * // Get context for a session
 * const context = await manager.getContext('discord:dm:user123');
 *
 * // Add a message and potentially trigger compaction
 * await manager.addMessage('discord:dm:user123', {
 *   role: 'user',
 *   content: 'Hello!',
 * });
 * ```
 */
export class ContextWindowManager {
  private readonly store: ConversationStore;
  private readonly history: ConversationHistory;
  private readonly summaryProvider?: SummaryProvider;
  private readonly emitter?: EventEmitter;

  private readonly maxTokens: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  private readonly charsPerToken: number;

  // Cache of compacted summaries per session key
  private readonly summaryCache = new Map<string, CompactedSummary[]>();

  constructor(
    store: ConversationStore,
    history: ConversationHistory,
    summaryProvider?: SummaryProvider,
    options: ContextWindowOptions = {},
  ) {
    this.store = store;
    this.history = history;
    this.summaryProvider = summaryProvider;
    this.emitter = options.emitter;

    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.softThreshold = options.softThreshold ?? DEFAULT_SOFT_THRESHOLD;
    this.hardThreshold = options.hardThreshold ?? DEFAULT_HARD_THRESHOLD;
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get context for a session, applying compaction if needed.
   *
   * AC: @mem-context-window ac-1 - Compacts older messages when approaching token limit
   * AC: @mem-context-window ac-2 - Preserves semantic boundaries during compaction
   * AC: @mem-context-window ac-3 - Includes session file reference in context
   *
   * @param sessionKey - Session key to get context for
   * @returns Context result with entries and token count
   */
  async getContext(sessionKey: string): Promise<ContextResult> {
    return this.getContextInternal(sessionKey, false);
  }

  /**
   * Internal implementation with recursion guard
   */
  private async getContextInternal(sessionKey: string, afterCompaction: boolean): Promise<ContextResult> {
    try {
      // Get history with semantic boundary markers
      const historyEntries = await this.history.getHistory(sessionKey);

      // Get cached summaries
      const summaries = this.summaryCache.get(sessionKey) ?? [];

      // Build context entries
      const entries: ContextEntry[] = [];

      // Add summaries first (they cover older turns)
      for (const summary of summaries) {
        entries.push({ type: 'summary', summary });
      }

      // Filter out turns that are covered by summaries
      const coveredUntil = summaries.length > 0
        ? Math.max(...summaries.map((s) => s.timestampRange.end))
        : 0;

      // Get only turns NOT covered by summaries
      const uncoveredEntries = historyEntries.filter((entry) => entry.turn.ts > coveredUntil);

      for (const entry of uncoveredEntries) {
        entries.push({ type: 'turn', entry });
      }

      const totalTokens = this.estimateContextTokens(entries);

      // Check if compaction is needed (only if not already compacted this call)
      const compactionLevel = this.shouldCompact(totalTokens);
      let compacted = false;

      if (!afterCompaction && compactionLevel !== 'none' && this.summaryProvider && uncoveredEntries.length >= 4) {
        compacted = await this.compact(sessionKey, uncoveredEntries, compactionLevel);
      }

      // Re-fetch if compaction occurred (only once)
      if (compacted) {
        return this.getContextInternal(sessionKey, true);
      }

      this.emit('context:retrieved', {
        sessionKey,
        totalTokens,
        entryCount: entries.length,
      });

      return { entries, totalTokens, compacted };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error, operation: 'getContext', sessionKey });
      throw error;
    }
  }

  /**
   * Add a message to the conversation and check for compaction.
   *
   * AC: @mem-context-window ac-1 - Compacts when new message pushes over threshold
   *
   * @param sessionKey - Session key for the conversation
   * @param input - Turn input (role, content, optional metadata)
   * @returns The created history entry
   */
  async addMessage(
    sessionKey: string,
    input: { role: 'user' | 'assistant' | 'system'; content: string; message_id?: string },
  ): Promise<HistoryEntry> {
    try {
      // Add the turn via history
      const entry = await this.history.addTurn(sessionKey, input);

      // Check if we need compaction after adding (result unused - compaction is a side effect)
      await this.getContext(sessionKey);

      return entry;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error, operation: 'addMessage', sessionKey });
      throw error;
    }
  }

  /**
   * Get conversation ID for a session key (for session file reference).
   *
   * AC: @mem-context-window ac-3 - Provides session file reference
   *
   * @param sessionKey - Session key to look up
   * @returns Conversation ID or null if not found
   */
  async getConversationId(sessionKey: string): Promise<string | null> {
    const conversation = await this.store.getConversationBySessionKey(sessionKey);
    return conversation?.id ?? null;
  }

  /**
   * Get the session file path for a conversation.
   *
   * AC: @mem-context-window ac-3 - Session file reference for agent access
   *
   * @param conversationId - Conversation ID
   * @returns Path to the turns.jsonl file
   */
  getSessionFilePath(conversationId: string): string {
    return `conversations/${conversationId}/turns.jsonl`;
  }

  /**
   * Clear cached summaries for a session.
   * Useful when conversation is archived or reset.
   *
   * @param sessionKey - Session key to clear cache for
   */
  clearCache(sessionKey: string): void {
    this.summaryCache.delete(sessionKey);
  }

  /**
   * Estimate tokens for a text string.
   *
   * @param text - Text to estimate
   * @returns Estimated token count
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }

  // ==========================================================================
  // Compaction Logic
  // ==========================================================================

  /**
   * Determine if compaction is needed based on current token count.
   */
  private shouldCompact(currentTokens: number): 'none' | 'soft' | 'hard' {
    const softLimit = this.maxTokens * this.softThreshold;
    const hardLimit = this.maxTokens * this.hardThreshold;

    if (currentTokens >= hardLimit) {
      return 'hard';
    }
    if (currentTokens >= softLimit) {
      return 'soft';
    }
    return 'none';
  }

  /**
   * Perform compaction on older turns.
   *
   * AC: @mem-context-window ac-1 - Compacts older messages
   * AC: @mem-context-window ac-2 - Preserves semantic boundaries
   * AC: @mem-context-window ac-4 - Uses Haiku via ACP for summaries
   *
   * @param sessionKey - Session key
   * @param entries - Current history entries
   * @param level - Compaction level (soft or hard)
   * @returns True if compaction was performed
   */
  private async compact(
    sessionKey: string,
    entries: HistoryEntry[],
    level: 'soft' | 'hard',
  ): Promise<boolean> {
    if (!this.summaryProvider || entries.length < 4) {
      return false;
    }

    const currentTokens = this.estimateHistoryTokens(entries);
    this.emit('compaction:started', { sessionKey, currentTokens, threshold: level });

    try {
      // Get conversation ID for session file reference
      const conversationId = await this.getConversationId(sessionKey);
      if (!conversationId) {
        return false;
      }

      const sessionFileRef = this.getSessionFilePath(conversationId);

      // Find compaction boundary based on semantic markers
      // AC-2: Preserve semantic boundaries
      const boundaryIndex = this.findCompactionBoundary(entries, level);
      if (boundaryIndex < 2) {
        // Not enough turns to compact
        return false;
      }

      // Get turns to summarize (before boundary)
      const turnsToSummarize = entries.slice(0, boundaryIndex).map((e) => e.turn);

      // Generate summary via provider
      // AC-4: Uses Haiku via ACP
      const summaryText = await this.summaryProvider.summarize(turnsToSummarize, sessionFileRef);

      // Parse summary into structured format
      const summary = this.parseSummary(summaryText, turnsToSummarize, sessionFileRef);

      // Add to cache
      const cachedSummaries = this.summaryCache.get(sessionKey) ?? [];
      cachedSummaries.push(summary);
      this.summaryCache.set(sessionKey, cachedSummaries);

      const tokensAfter = summary.tokens + this.estimateHistoryTokens(entries.slice(boundaryIndex));

      this.emit('compaction:completed', {
        sessionKey,
        tokensBefore: currentTokens,
        tokensAfter,
        turnsSummarized: turnsToSummarize.length,
      });

      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error, operation: 'compact', sessionKey });
      return false;
    }
  }

  /**
   * Find the index to compact up to, respecting semantic boundaries.
   *
   * AC: @mem-context-window ac-2 - Preserves boundary markers for topic continuity
   */
  private findCompactionBoundary(entries: HistoryEntry[], level: 'soft' | 'hard'): number {
    // Target: keep recent entries, summarize older ones
    // Soft: keep ~40% of entries
    // Hard: keep ~25% of entries
    const keepFraction = level === 'soft' ? 0.4 : 0.25;
    const targetKeep = Math.max(2, Math.floor(entries.length * keepFraction));
    const targetBoundary = entries.length - targetKeep;

    // Find nearest semantic boundary at or before target
    // Prefer boundaries to maintain topic continuity
    for (let i = targetBoundary; i >= 0; i--) {
      if (entries[i].semanticBoundary) {
        return i;
      }
    }

    // No semantic boundary found, use target directly
    // But ensure we keep at least 2 recent turns
    return Math.min(targetBoundary, entries.length - 2);
  }

  /**
   * Parse summary text into structured CompactedSummary.
   */
  private parseSummary(
    summaryText: string,
    turns: ConversationTurn[],
    sessionFileRef: string,
  ): CompactedSummary {
    // Extract topics and instructions from summary text
    // The summary format from the provider should include these sections
    const topics: string[] = [];
    const keyInstructions: string[] = [];

    // Simple parsing - look for bullet points or numbered items
    const lines = summaryText.split('\n').map((l) => l.trim()).filter((l) => l);
    let inTopics = false;
    let inInstructions = false;

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes('topic') || lower.includes('discussed')) {
        inTopics = true;
        inInstructions = false;
        continue;
      }
      if (lower.includes('instruction') || lower.includes('key') || lower.includes('note')) {
        inTopics = false;
        inInstructions = true;
        continue;
      }

      const bulletMatch = line.match(/^[-*•]\s*(.+)$/);
      const numberedMatch = line.match(/^\d+[.)]\s*(.+)$/);
      const content = bulletMatch?.[1] ?? numberedMatch?.[1];

      if (content) {
        if (inTopics) {
          topics.push(content);
        } else if (inInstructions) {
          keyInstructions.push(content);
        } else {
          // Default to topics if no section detected
          topics.push(content);
        }
      }
    }

    // If parsing didn't extract structured content, treat whole summary as a topic
    if (topics.length === 0 && keyInstructions.length === 0) {
      topics.push(summaryText);
    }

    const timestamps = turns.map((t) => t.ts);

    return {
      topics,
      keyInstructions,
      sessionFileRef,
      timestampRange: {
        start: Math.min(...timestamps),
        end: Math.max(...timestamps),
      },
      turnCount: turns.length,
      tokens: this.estimateTokens(summaryText),
    };
  }

  // ==========================================================================
  // Token Estimation
  // ==========================================================================

  /**
   * Estimate total tokens for context entries.
   */
  private estimateContextTokens(entries: ContextEntry[]): number {
    let total = 0;

    for (const entry of entries) {
      if (entry.type === 'turn') {
        total += this.estimateTokens(entry.entry.turn.content);
        // Add overhead for role, metadata
        total += 10;
      } else {
        total += entry.summary.tokens;
      }
    }

    return total;
  }

  /**
   * Estimate total tokens for history entries.
   */
  private estimateHistoryTokens(entries: HistoryEntry[]): number {
    return entries.reduce((total, entry) => {
      return total + this.estimateTokens(entry.turn.content) + 10;
    }, 0);
  }

  // ==========================================================================
  // Event Emission
  // ==========================================================================

  /**
   * Emit an event if emitter is configured.
   *
   * @trait-observable - Structured event emission
   */
  private emit<K extends keyof ContextWindowEvents>(
    event: K,
    data: ContextWindowEvents[K],
  ): void {
    if (this.emitter) {
      this.emitter.emit(event, data);
    }
  }
}
