/**
 * ContextRestorer - Generate context restoration prompts for session rotation
 *
 * Combines summary of old turns, verbatim recent turns (up to 30% token budget),
 * and file reference for full history access.
 *
 * @see @mem-context-restore
 */

import type { ConversationTurn, TurnReconstructor } from '@kynetic-bot/memory';
import { TurnSelector, type TurnSelectorOptions } from './turn-selector.js';
import { ToolSummarizer } from './tool-summarizer.js';
import type { SummaryProvider } from './context-window.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of context restoration generation
 */
export interface ContextRestorationResult {
  /** Generated restoration prompt */
  prompt: string;
  /** Statistics about the restoration */
  stats: ContextRestorationStats;
  /** Whether restoration was skipped (no prior turns) */
  skipped: boolean;
}

/**
 * Statistics about context restoration
 */
export interface ContextRestorationStats {
  /** Number of turns included verbatim */
  recentTurns: number;
  /** Number of turns that were summarized */
  summarizedTurns: number;
  /** Total token estimate for the restoration prompt */
  totalTokens: number;
  /** Whether summary generation failed and was skipped */
  summaryFailed: boolean;
  /** Number of turns that were truncated */
  truncatedTurns: number;
}

/**
 * Options for ContextRestorer
 */
export interface ContextRestorerOptions {
  /** TurnSelector options (budget, context window, etc.) */
  turnSelectorOptions?: TurnSelectorOptions;
  /** Characters per token for estimation (default: 4) */
  charsPerToken?: number;
  /** Maximum characters for a single turn before truncation */
  maxTurnChars?: number;
  /** TurnReconstructor for content retrieval (required for content access) */
  turnReconstructor?: TurnReconstructor;
}

/**
 * Logger interface for warnings
 */
export interface ContextRestorerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CHARS_PER_TOKEN = 4;
// Default max turn size: roughly 10k tokens
const DEFAULT_MAX_TURN_CHARS = 40000;

// ============================================================================
// ContextRestorer Implementation
// ============================================================================

/**
 * ContextRestorer generates context restoration prompts for session rotation.
 *
 * AC: @mem-context-restore ac-1 - Recent turns replayed verbatim up to 30% token budget
 * AC: @mem-context-restore ac-2 - Older turns summarized via HaikuSummaryProvider
 * AC: @mem-context-restore ac-3 - Tool calls summarized to [Tool: {name}] {brief_result} format
 * AC: @mem-context-restore ac-4 - Includes session file reference
 * AC: @mem-context-restore ac-5 - Format has Summary, Recent History, Archived History sections
 * AC: @mem-context-restore ac-6 - Falls back to recent turns only if summary provider fails
 * AC: @mem-context-restore ac-7 - No restoration if no prior turns
 * AC: @mem-context-restore ac-8 - Oversized turns truncated with [truncated] marker
 *
 * @example
 * ```typescript
 * const restorer = new ContextRestorer(summaryProvider, { logger: console });
 *
 * const turns = await conversationStore.readTurns(conversationId);
 * const result = await restorer.generateRestorationPrompt(
 *   turns,
 *   conversationId,
 *   '.kbot'
 * );
 *
 * if (!result.skipped) {
 *   await agent.injectSystemPrompt(result.prompt);
 * }
 * ```
 */
export class ContextRestorer {
  private readonly summaryProvider: SummaryProvider | null;
  private readonly turnSelector: TurnSelector;
  private readonly toolSummarizer: ToolSummarizer;
  private readonly charsPerToken: number;
  private readonly maxTurnChars: number;
  private readonly logger?: ContextRestorerLogger;
  private readonly turnReconstructor?: TurnReconstructor;

  constructor(
    summaryProvider: SummaryProvider | null,
    options: ContextRestorerOptions & { logger?: ContextRestorerLogger } = {}
  ) {
    this.summaryProvider = summaryProvider;
    this.turnReconstructor = options.turnReconstructor;
    this.turnSelector = new TurnSelector({
      ...options.turnSelectorOptions,
      turnReconstructor: options.turnReconstructor,
    });
    this.toolSummarizer = new ToolSummarizer();
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
    this.maxTurnChars = options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;
    this.logger = options.logger;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Generate a context restoration prompt for session rotation.
   *
   * AC: @mem-context-restore ac-1 - Recent turns within 30% budget replayed verbatim
   * AC: @mem-context-restore ac-2 - Older turns summarized
   * AC: @mem-context-restore ac-4 - Includes file reference
   * AC: @mem-context-restore ac-5 - Sections: Summary, Recent History, Archived History
   * AC: @mem-context-restore ac-7 - Returns skipped=true if no prior turns
   *
   * @param turns - All conversation turns (chronological order)
   * @param conversationId - Conversation ID for file reference
   * @param baseDir - Base directory for conversation storage (e.g., '.kbot')
   * @returns Context restoration result with prompt and stats
   */
  async generateRestorationPrompt(
    turns: ConversationTurn[],
    conversationId: string,
    baseDir: string
  ): Promise<ContextRestorationResult> {
    // AC: @mem-context-restore ac-7 - No restoration if no prior turns
    if (turns.length === 0) {
      return {
        prompt: '',
        stats: {
          recentTurns: 0,
          summarizedTurns: 0,
          totalTokens: 0,
          summaryFailed: false,
          truncatedTurns: 0,
        },
        skipped: true,
      };
    }

    // Select recent turns within budget
    // AC: @mem-context-restore ac-1 - Recent turns within 30% budget
    const selection = await this.turnSelector.selectTurns(turns);
    const recentTurns = selection.selectedTurns;
    const olderTurns = turns.slice(0, turns.length - recentTurns.length);

    // Build session file reference
    // AC: @mem-context-restore ac-4 - File reference
    const sessionFileRef = `${baseDir}/conversations/${conversationId}/turns.jsonl`;

    // Format recent turns for replay
    // AC: @mem-context-restore ac-3 - Tool calls summarized
    // AC: @mem-context-restore ac-8 - Oversized turns truncated
    const { formattedTurns, truncatedCount } = await this.formatRecentTurns(recentTurns);

    // Generate summary for older turns
    // AC: @mem-context-restore ac-2 - Older turns summarized
    // AC: @mem-context-restore ac-6 - Falls back if summary fails
    let summary = '';
    let summaryFailed = false;

    if (olderTurns.length > 0) {
      const summaryResult = await this.generateSummary(olderTurns, sessionFileRef);
      summary = summaryResult.summary;
      summaryFailed = summaryResult.failed;
    }

    // Build the restoration prompt
    // AC: @mem-context-restore ac-5 - Sections: Summary, Recent History, Archived History
    const prompt = this.buildPrompt(summary, formattedTurns, sessionFileRef, olderTurns.length > 0);

    // Calculate total tokens
    const totalTokens = Math.ceil(prompt.length / this.charsPerToken);

    return {
      prompt,
      stats: {
        recentTurns: recentTurns.length,
        summarizedTurns: olderTurns.length,
        totalTokens,
        summaryFailed,
        truncatedTurns: truncatedCount,
      },
      skipped: false,
    };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get content for a turn.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   */
  private async getTurnContent(turn: ConversationTurn): Promise<string> {
    if (!this.turnReconstructor) {
      return '';
    }
    return this.turnReconstructor.getContent(turn.session_id, turn.event_range);
  }

  /**
   * Format recent turns for verbatim replay.
   *
   * AC: @mem-context-restore ac-3 - Tool calls summarized
   * AC: @mem-context-restore ac-8 - Oversized turns truncated
   */
  private async formatRecentTurns(turns: ConversationTurn[]): Promise<{
    formattedTurns: string;
    truncatedCount: number;
  }> {
    let truncatedCount = 0;
    const formatted: string[] = [];

    for (const turn of turns) {
      let content = await this.getTurnContent(turn);

      // Check if turn contains tool calls and summarize them
      // AC: @mem-context-restore ac-3 - Tool calls summarized
      if (this.toolSummarizer.isToolCall(content)) {
        const summary = this.toolSummarizer.summarize(content);
        content = summary.summarized;
      }

      // Truncate if too long
      // AC: @mem-context-restore ac-8 - Oversized turns truncated
      if (content.length > this.maxTurnChars) {
        content = content.slice(0, this.maxTurnChars) + '\n\n[truncated]';
        truncatedCount++;
      }

      // Format with role marker
      const roleLabel = this.getRoleLabel(turn.role);
      formatted.push(`${roleLabel}: ${content}`);
    }

    return {
      formattedTurns: formatted.join('\n\n'),
      truncatedCount,
    };
  }

  /**
   * Get display label for turn role.
   */
  private getRoleLabel(role: string): string {
    switch (role) {
      case 'user':
        return '[User]';
      case 'assistant':
        return '[Assistant]';
      case 'system':
        return '[System]';
      default:
        return `[${role}]`;
    }
  }

  /**
   * Generate summary for older turns.
   *
   * AC: @mem-context-restore ac-2 - Uses HaikuSummaryProvider
   * AC: @mem-context-restore ac-6 - Falls back on failure
   */
  private async generateSummary(
    turns: ConversationTurn[],
    sessionFileRef: string
  ): Promise<{ summary: string; failed: boolean }> {
    if (!this.summaryProvider) {
      // No summary provider configured - log warning and skip
      this.logger?.warn('No summary provider configured, skipping summary generation', {
        turnCount: turns.length,
      });
      return { summary: '', failed: true };
    }

    try {
      const summary = await this.summaryProvider.summarize(turns, sessionFileRef);
      return { summary, failed: false };
    } catch (error) {
      // AC: @mem-context-restore ac-6 - Log warning and continue without summary
      this.logger?.warn('Summary generation failed, continuing with recent turns only', {
        error: error instanceof Error ? error.message : String(error),
        turnCount: turns.length,
      });
      return { summary: '', failed: true };
    }
  }

  /**
   * Build the final restoration prompt.
   *
   * AC: @mem-context-restore ac-5 - Sections: Summary, Recent History, Archived History
   */
  private buildPrompt(
    summary: string,
    formattedTurns: string,
    sessionFileRef: string,
    hasOlderTurns: boolean
  ): string {
    const sections: string[] = [];

    sections.push('## Session Context');
    sections.push('');
    sections.push('You are resuming a conversation. Here is the relevant context:');

    // Summary section (if we have older turns and a summary)
    if (hasOlderTurns) {
      sections.push('');
      sections.push('### Summary of Earlier Conversation');
      if (summary) {
        sections.push(summary);
      } else {
        sections.push('(Summary unavailable - see archived history reference for full context)');
      }
    }

    // Recent history section
    sections.push('');
    sections.push('### Recent Conversation History');
    sections.push('---');
    sections.push(formattedTurns);
    sections.push('---');

    // Archived history reference
    sections.push('');
    sections.push('### Archived History');
    sections.push(`Full conversation history: ${sessionFileRef}`);
    sections.push('Read this file if you need earlier context not included above.');

    // Footer
    sections.push('');
    sections.push('---');
    sections.push("Continue naturally. The user doesn't know the session rotated.");

    return sections.join('\n');
  }
}
