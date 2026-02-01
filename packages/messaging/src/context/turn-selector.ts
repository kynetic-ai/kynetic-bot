/**
 * TurnSelector - Token-budget-based turn selection for context replay
 *
 * Selects conversation turns for verbatim replay based on a token budget
 * (default 30% of context window). Tool calls use summarized form for
 * token estimation to maximize content within budget.
 *
 * AC: @mem-turn-selection ac-1 - Most recent turns fitting within 30% budget selected
 * AC: @mem-turn-selection ac-3 - Selected turns fit within budget with 5% margin
 *
 * @see @mem-turn-selection
 */

import type { ConversationTurn, TurnReconstructor } from '@kynetic-bot/memory';
import { ToolSummarizer } from './tool-summarizer.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for TurnSelector
 */
export interface TurnSelectorOptions {
  /** Maximum context window tokens (default: 200000) */
  maxContextTokens?: number;
  /** Budget fraction of context window (default: 0.30) */
  budgetFraction?: number;
  /** Allowed margin above budget (default: 0.05 = 5%) */
  marginFraction?: number;
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
  /** Custom tool summarizer instance */
  toolSummarizer?: ToolSummarizer;
  /** TurnReconstructor for content retrieval (required for token estimation) */
  turnReconstructor?: TurnReconstructor;
}

/**
 * A turn with token estimation metadata
 */
export interface EstimatedTurn {
  /** The original conversation turn */
  turn: ConversationTurn;
  /** Estimated tokens for original content */
  originalTokens: number;
  /** Estimated tokens using summarized form (for tool calls) */
  effectiveTokens: number;
  /** Whether this turn contains tool calls */
  isToolCall: boolean;
  /** Summarized content (if tool call) */
  summarizedContent?: string;
}

/**
 * Result of turn selection
 */
export interface TurnSelectionResult {
  /** Selected turns in chronological order */
  selectedTurns: ConversationTurn[];
  /** Estimation details for each selected turn */
  estimations: EstimatedTurn[];
  /** Total effective tokens of selection */
  totalTokens: number;
  /** Token budget that was used */
  budget: number;
  /** Maximum tokens allowed (budget + margin) */
  maxAllowed: number;
  /** Number of turns that were excluded due to budget */
  excludedCount: number;
  /** Whether selection is within budget with margin */
  withinBudget: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MAX_CONTEXT_TOKENS = 200000;
const DEFAULT_BUDGET_FRACTION = 0.3;
const DEFAULT_MARGIN_FRACTION = 0.05;
const DEFAULT_CHARS_PER_TOKEN = 4;

// ============================================================================
// TurnSelector Implementation
// ============================================================================

/**
 * TurnSelector selects turns for verbatim replay based on token budget.
 *
 * Key features:
 * - Token-based selection, not turn count
 * - Tool calls use summarized form for estimation
 * - 30% default budget with 5% margin
 * - Most recent turns prioritized
 *
 * @example
 * ```typescript
 * const selector = new TurnSelector({
 *   maxContextTokens: 200000,
 *   budgetFraction: 0.30,
 * });
 *
 * const turns = await conversationStore.readTurns(conversationId);
 * const result = selector.selectTurns(turns);
 *
 * // Use result.selectedTurns for context
 * console.log(`Selected ${result.selectedTurns.length} turns using ${result.totalTokens} tokens`);
 * ```
 */
export class TurnSelector {
  private readonly maxContextTokens: number;
  private readonly budgetFraction: number;
  private readonly marginFraction: number;
  private readonly charsPerToken: number;
  private readonly toolSummarizer: ToolSummarizer;
  private readonly turnReconstructor?: TurnReconstructor;

  constructor(options: TurnSelectorOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.budgetFraction = options.budgetFraction ?? DEFAULT_BUDGET_FRACTION;
    this.marginFraction = options.marginFraction ?? DEFAULT_MARGIN_FRACTION;
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.toolSummarizer = options.toolSummarizer ?? new ToolSummarizer();
    this.turnReconstructor = options.turnReconstructor;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Calculate the token budget for turn selection.
   *
   * @returns Token budget (maxContextTokens * budgetFraction)
   */
  getBudget(): number {
    return Math.floor(this.maxContextTokens * this.budgetFraction);
  }

  /**
   * Calculate the maximum allowed tokens (budget + margin).
   *
   * AC: @mem-turn-selection ac-3 - 5% margin above budget
   *
   * @returns Maximum tokens allowed
   */
  getMaxAllowed(): number {
    const budget = this.getBudget();
    const margin = Math.floor(budget * this.marginFraction);
    return budget + margin;
  }

  /**
   * Get content for a turn.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   *
   * @param turn - Turn to get content for
   * @returns Reconstructed content, or empty string if no reconstructor
   */
  async getTurnContent(turn: ConversationTurn): Promise<string> {
    if (!this.turnReconstructor) {
      return '';
    }
    return this.turnReconstructor.getContent(turn.session_id, turn.event_range);
  }

  /**
   * Pre-fetch content for multiple turns.
   *
   * @param turns - Turns to fetch content for
   * @returns Map of turn seq to content
   */
  async prefetchTurnContent(turns: ConversationTurn[]): Promise<Map<number, string>> {
    const contentMap = new Map<number, string>();
    for (const turn of turns) {
      const content = await this.getTurnContent(turn);
      contentMap.set(turn.seq, content);
    }
    return contentMap;
  }

  /**
   * Estimate tokens for a single turn's content.
   *
   * AC: @mem-turn-selection ac-2 - Uses summarized form for tool calls
   *
   * @param turn - Conversation turn to estimate
   * @param content - Pre-fetched content for the turn
   * @returns Estimated turn with token counts
   */
  estimateTurnWithContent(turn: ConversationTurn, content: string): EstimatedTurn {
    const originalTokens = this.estimateTokens(content);

    // Check if this is a tool call
    const isToolCall = this.toolSummarizer.isToolCall(content);

    if (isToolCall) {
      // Use summarized form for token estimation
      const summary = this.toolSummarizer.summarize(content);
      return {
        turn,
        originalTokens,
        effectiveTokens: this.estimateTokens(summary.summarized),
        isToolCall: true,
        summarizedContent: summary.summarized,
      };
    }

    return {
      turn,
      originalTokens,
      effectiveTokens: originalTokens,
      isToolCall: false,
    };
  }

  /**
   * Estimate tokens for a single turn (async).
   *
   * AC: @mem-turn-selection ac-2 - Uses summarized form for tool calls
   *
   * @param turn - Conversation turn to estimate
   * @returns Estimated turn with token counts
   */
  async estimateTurn(turn: ConversationTurn): Promise<EstimatedTurn> {
    const content = await this.getTurnContent(turn);
    return this.estimateTurnWithContent(turn, content);
  }

  /**
   * Select turns for replay within token budget.
   *
   * AC: @mem-turn-selection ac-1 - Most recent turns fitting within budget selected
   * AC: @mem-turn-selection ac-3 - Fits within budget with 5% margin
   *
   * Selection algorithm:
   * 1. Estimate tokens for all turns (using summarized form for tool calls)
   * 2. Starting from most recent, add turns while within budget
   * 3. Stop when adding next turn would exceed budget + margin
   *
   * @param turns - All conversation turns (chronological order)
   * @returns Selection result with turns and metadata
   */
  async selectTurns(turns: ConversationTurn[]): Promise<TurnSelectionResult> {
    const budget = this.getBudget();
    const maxAllowed = this.getMaxAllowed();

    if (turns.length === 0) {
      return {
        selectedTurns: [],
        estimations: [],
        totalTokens: 0,
        budget,
        maxAllowed,
        excludedCount: 0,
        withinBudget: true,
      };
    }

    // Estimate all turns (async)
    const estimations: EstimatedTurn[] = await Promise.all(turns.map((t) => this.estimateTurn(t)));

    // Select from most recent, going backwards
    const selectedIndices: number[] = [];
    let totalTokens = 0;

    for (let i = estimations.length - 1; i >= 0; i--) {
      const estimation = estimations[i];
      const newTotal = totalTokens + estimation.effectiveTokens;

      // Check if adding this turn would exceed max allowed
      if (newTotal > maxAllowed) {
        // Can't add more - we've hit the budget
        break;
      }

      selectedIndices.unshift(i);
      totalTokens = newTotal;
    }

    // Build result
    const selectedTurns = selectedIndices.map((i) => turns[i]);
    const selectedEstimations = selectedIndices.map((i) => estimations[i]);
    const excludedCount = turns.length - selectedTurns.length;

    return {
      selectedTurns,
      estimations: selectedEstimations,
      totalTokens,
      budget,
      maxAllowed,
      excludedCount,
      withinBudget: totalTokens <= maxAllowed,
    };
  }

  /**
   * Select turns with a custom token budget.
   *
   * @param turns - All conversation turns
   * @param customBudget - Custom token budget to use
   * @returns Selection result
   */
  async selectTurnsWithBudget(
    turns: ConversationTurn[],
    customBudget: number
  ): Promise<TurnSelectionResult> {
    const margin = Math.floor(customBudget * this.marginFraction);
    const maxAllowed = customBudget + margin;

    if (turns.length === 0) {
      return {
        selectedTurns: [],
        estimations: [],
        totalTokens: 0,
        budget: customBudget,
        maxAllowed,
        excludedCount: 0,
        withinBudget: true,
      };
    }

    // Estimate all turns (async)
    const estimations: EstimatedTurn[] = await Promise.all(turns.map((t) => this.estimateTurn(t)));

    // Select from most recent, going backwards
    const selectedIndices: number[] = [];
    let totalTokens = 0;

    for (let i = estimations.length - 1; i >= 0; i--) {
      const estimation = estimations[i];
      const newTotal = totalTokens + estimation.effectiveTokens;

      if (newTotal > maxAllowed) {
        break;
      }

      selectedIndices.unshift(i);
      totalTokens = newTotal;
    }

    // Build result
    const selectedTurns = selectedIndices.map((i) => turns[i]);
    const selectedEstimations = selectedIndices.map((i) => estimations[i]);
    const excludedCount = turns.length - selectedTurns.length;

    return {
      selectedTurns,
      estimations: selectedEstimations,
      totalTokens,
      budget: customBudget,
      maxAllowed,
      excludedCount,
      withinBudget: totalTokens <= maxAllowed,
    };
  }

  /**
   * Get summary statistics for a set of turns.
   *
   * @param turns - Turns to analyze
   * @returns Statistics about token usage
   */
  async getStatistics(turns: ConversationTurn[]): Promise<{
    totalTurns: number;
    toolCallTurns: number;
    originalTotalTokens: number;
    effectiveTotalTokens: number;
    tokenSavings: number;
    savingsPercentage: number;
  }> {
    const estimations = await Promise.all(turns.map((t) => this.estimateTurn(t)));

    const toolCallTurns = estimations.filter((e) => e.isToolCall).length;
    const originalTotalTokens = estimations.reduce((sum, e) => sum + e.originalTokens, 0);
    const effectiveTotalTokens = estimations.reduce((sum, e) => sum + e.effectiveTokens, 0);
    const tokenSavings = originalTotalTokens - effectiveTotalTokens;
    const savingsPercentage =
      originalTotalTokens > 0 ? (tokenSavings / originalTotalTokens) * 100 : 0;

    return {
      totalTurns: turns.length,
      toolCallTurns,
      originalTotalTokens,
      effectiveTotalTokens,
      tokenSavings,
      savingsPercentage,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Estimate tokens for a string.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }
}
