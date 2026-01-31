/**
 * ContextRestorer Tests
 *
 * Tests for context restoration prompt generation.
 *
 * @see @mem-context-restore
 */

import type { ConversationTurn } from '@kynetic-bot/memory';
import { describe, expect, it, vi } from 'vitest';

import { ContextRestorer, type ContextRestorerLogger } from '../src/context/context-restorer.js';
import { MockSummaryProvider } from '../src/context/haiku-summary-provider.js';
import type { SummaryProvider } from '../src/context/context-window.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock conversation turn
 */
function createTurn(
  seq: number,
  content: string,
  role: 'user' | 'assistant' | 'system' = 'user'
): ConversationTurn {
  return {
    ts: Date.now() - (100 - seq) * 1000,
    seq,
    role,
    content,
  };
}

/**
 * Create content of approximately N tokens (assuming 4 chars/token)
 */
function createContentOfTokens(tokenCount: number): string {
  return 'x'.repeat(tokenCount * 4);
}

/**
 * Create a tool call content with file results
 */
function createToolCallContent(lineCount: number): string {
  const lines: string[] = [];
  lines.push('<function_results>');
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`     ${i}→// Line ${i} of file content with some extra text here`);
  }
  lines.push('</function_results>');
  return lines.join('\n');
}

/**
 * Create a failing summary provider for testing error handling
 */
class FailingSummaryProvider implements SummaryProvider {
  async summarize(): Promise<string> {
    throw new Error('Summary generation failed');
  }
}

/**
 * Create a mock logger for testing warnings
 */
function createMockLogger(): ContextRestorerLogger & {
  calls: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const calls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    calls,
    warn(message: string, context?: Record<string, unknown>) {
      calls.push({ message, context });
    },
  };
}

// ============================================================================
// ContextRestorer Tests
// ============================================================================

describe('ContextRestorer', () => {
  const conversationId = '01ABC123';
  const baseDir = '.kbot';

  describe('generateRestorationPrompt', () => {
    // AC: @mem-context-restore ac-7 - No restoration if no prior turns
    it('returns skipped=true for empty turns', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const result = await restorer.generateRestorationPrompt([], conversationId, baseDir);

      expect(result.skipped).toBe(true);
      expect(result.prompt).toBe('');
      expect(result.stats.recentTurns).toBe(0);
      expect(result.stats.summarizedTurns).toBe(0);
    });

    // AC: @mem-context-restore ac-1 - Recent turns replayed verbatim up to 30% token budget
    it('replays recent turns within 30% token budget', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.3,
          charsPerToken: 4,
        },
      });

      // Budget: 300 tokens, each turn is 100 tokens
      const turns = [
        createTurn(1, createContentOfTokens(100), 'user'),
        createTurn(2, createContentOfTokens(100), 'assistant'),
        createTurn(3, createContentOfTokens(100), 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.skipped).toBe(false);
      expect(result.stats.recentTurns).toBe(3);
      // All turns fit within budget (300 tokens = exactly budget)
      expect(result.prompt).toContain('[User]:');
      expect(result.prompt).toContain('[Assistant]:');
    });

    // AC: @mem-context-restore ac-2 - Older turns summarized via HaikuSummaryProvider
    it('summarizes older turns via summary provider', async () => {
      const summaryProvider = new MockSummaryProvider();
      const restorer = new ContextRestorer(summaryProvider, {
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.3,
          charsPerToken: 4,
        },
      });

      // Budget: 300 tokens
      // Create 5 turns of 100 tokens each - only 3 fit in budget
      const turns = [
        createTurn(1, createContentOfTokens(100), 'user'),
        createTurn(2, createContentOfTokens(100), 'assistant'),
        createTurn(3, createContentOfTokens(100), 'user'),
        createTurn(4, createContentOfTokens(100), 'assistant'),
        createTurn(5, createContentOfTokens(100), 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      // 3 recent turns, 2 summarized
      expect(result.stats.recentTurns).toBe(3);
      expect(result.stats.summarizedTurns).toBe(2);
      expect(result.prompt).toContain('Summary of Earlier Conversation');

      // Verify summary provider was called
      const summaryCalls = summaryProvider.getSummaryCalls();
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0].turns).toHaveLength(2);
    });

    // AC: @mem-context-restore ac-3 - Tool calls summarized to [Tool: {name}] {brief_result}
    it('summarizes tool calls in recent turns', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [
        createTurn(1, 'Please read the file', 'user'),
        createTurn(2, createToolCallContent(50), 'assistant'),
        createTurn(3, 'Thanks for reading', 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      // Tool call should be summarized, not appear verbatim
      // ToolSummarizer outputs "Result: (N lines of file content)" format
      expect(result.prompt).toContain('Result:');
      expect(result.prompt).toContain('lines of file content');
      expect(result.prompt).not.toContain('<function_results>');
    });

    // AC: @mem-context-restore ac-4 - Includes session file reference
    it('includes session file reference', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, 'Hello', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('.kbot/conversations/01ABC123/turns.jsonl');
    });

    // AC: @mem-context-restore ac-5 - Format has sections: Summary, Recent History, Archived History
    it('has required sections in prompt', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.1, // Small budget to force summarization
          charsPerToken: 4,
        },
      });

      // Create enough turns to force some into summary
      const turns = [
        createTurn(1, createContentOfTokens(100), 'user'),
        createTurn(2, createContentOfTokens(100), 'assistant'),
        createTurn(3, 'Recent message', 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('## Session Context');
      expect(result.prompt).toContain('### Summary of Earlier Conversation');
      expect(result.prompt).toContain('### Recent Conversation History');
      expect(result.prompt).toContain('### Archived History');
    });

    // AC: @mem-context-restore ac-5 - Skips summary section when all turns are recent
    it('omits summary section when no older turns', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        turnSelectorOptions: {
          maxContextTokens: 100000, // Large enough to fit all turns
          budgetFraction: 0.3,
          charsPerToken: 4,
        },
      });

      const turns = [createTurn(1, 'Hello', 'user'), createTurn(2, 'Hi there!', 'assistant')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).not.toContain('Summary of Earlier Conversation');
      expect(result.prompt).toContain('### Recent Conversation History');
      expect(result.prompt).toContain('### Archived History');
    });

    // AC: @mem-context-restore ac-6 - Falls back to recent turns only; warning logged
    it('falls back when summary provider is unavailable', async () => {
      const logger = createMockLogger();
      const restorer = new ContextRestorer(null, {
        logger,
        turnSelectorOptions: {
          maxContextTokens: 100, // Very small context window
          budgetFraction: 0.1, // 10 token budget
          charsPerToken: 4,
        },
      });

      // Force some turns into older category (budget only fits ~10 tokens = 40 chars)
      const turns = [
        createTurn(1, createContentOfTokens(50), 'user'), // Will be summarized (200 chars)
        createTurn(2, 'Hi', 'assistant'), // Recent (~1 token)
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.stats.summarizedTurns).toBe(1); // First turn is summarized
      expect(result.stats.summaryFailed).toBe(true);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].message).toContain('No summary provider configured');
    });

    // AC: @mem-context-restore ac-6 - Falls back when summary provider throws
    it('falls back when summary provider throws', async () => {
      const logger = createMockLogger();
      const restorer = new ContextRestorer(new FailingSummaryProvider(), {
        logger,
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.1,
          charsPerToken: 4,
        },
      });

      // Force some turns into summarization
      const turns = [
        createTurn(1, createContentOfTokens(200), 'user'),
        createTurn(2, 'Short recent message', 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.stats.summaryFailed).toBe(true);
      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].message).toContain('Summary generation failed');
    });

    // AC: @mem-context-restore ac-8 - Turn truncated with [truncated] marker
    it('truncates oversized turns with marker', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        maxTurnChars: 100, // Very small limit
      });

      const turns = [
        createTurn(1, 'x'.repeat(200), 'user'), // Exceeds limit
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('[truncated]');
      expect(result.stats.truncatedTurns).toBe(1);
    });

    // AC: @mem-context-restore ac-8 - Does not truncate turns within limit
    it('does not truncate turns within limit', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        maxTurnChars: 1000,
      });

      const turns = [createTurn(1, 'Short message', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).not.toContain('[truncated]');
      expect(result.stats.truncatedTurns).toBe(0);
    });
  });

  describe('prompt format', () => {
    it('includes role labels for each turn', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [
        createTurn(1, 'User message', 'user'),
        createTurn(2, 'Assistant response', 'assistant'),
        createTurn(3, 'System notification', 'system'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('[User]: User message');
      expect(result.prompt).toContain('[Assistant]: Assistant response');
      expect(result.prompt).toContain('[System]: System notification');
    });

    it('includes footer instructions', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, 'Hello', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('Continue naturally');
      expect(result.prompt).toContain("user doesn't know the session rotated");
    });

    it('includes archived history reference with file path', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, 'Hello', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, 'conv123', '/data/kbot');

      expect(result.prompt).toContain(
        'Full conversation history: /data/kbot/conversations/conv123/turns.jsonl'
      );
      expect(result.prompt).toContain('Read this file if you need earlier context');
    });
  });

  describe('statistics', () => {
    it('tracks total tokens estimate', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        charsPerToken: 4,
      });

      const turns = [createTurn(1, 'x'.repeat(400), 'user')]; // ~100 tokens

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      // Prompt includes content plus formatting, so should be > 100 tokens
      expect(result.stats.totalTokens).toBeGreaterThan(100);
    });

    it('correctly counts recent vs summarized turns', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.2, // 200 token budget
          charsPerToken: 4,
        },
      });

      // 5 turns, 100 tokens each = 500 tokens total
      // Budget of 200 allows 2 recent turns, leaves 3 for summary
      const turns = [
        createTurn(1, createContentOfTokens(100), 'user'),
        createTurn(2, createContentOfTokens(100), 'assistant'),
        createTurn(3, createContentOfTokens(100), 'user'),
        createTurn(4, createContentOfTokens(100), 'assistant'),
        createTurn(5, createContentOfTokens(100), 'user'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.stats.recentTurns).toBe(2);
      expect(result.stats.summarizedTurns).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('handles single turn conversation', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, 'Only message', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.skipped).toBe(false);
      expect(result.stats.recentTurns).toBe(1);
      expect(result.stats.summarizedTurns).toBe(0);
      expect(result.prompt).toContain('[User]: Only message');
    });

    it('handles turns with empty content', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, '', 'system')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.skipped).toBe(false);
      expect(result.prompt).toContain('[System]:');
    });

    it('handles very large conversation', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider(), {
        turnSelectorOptions: {
          maxContextTokens: 1000,
          budgetFraction: 0.3, // 300 token budget
          charsPerToken: 4,
        },
      });

      // 100 turns, each ~20 tokens = ~2000 tokens total, budget only 300
      const turns = Array.from({ length: 100 }, (_, i) =>
        createTurn(i + 1, createContentOfTokens(20), i % 2 === 0 ? 'user' : 'assistant')
      );

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.skipped).toBe(false);
      expect(result.stats.recentTurns).toBeLessThan(100);
      expect(result.stats.summarizedTurns).toBeGreaterThan(0);
    });

    it('handles special characters in content', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [createTurn(1, 'Message with <tags> and "quotes" and \\backslashes', 'user')];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('<tags>');
      expect(result.prompt).toContain('"quotes"');
      expect(result.prompt).toContain('\\backslashes');
    });
  });

  describe('tool call handling', () => {
    // AC: @mem-context-restore ac-3 - Tool calls formatted properly
    it('formats multiple tool calls in sequence', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [
        createTurn(1, 'Run some commands', 'user'),
        createTurn(2, createToolCallContent(10), 'assistant'),
        createTurn(3, 'Continue', 'user'),
        createTurn(4, createToolCallContent(20), 'assistant'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      // Should have summarized tool calls, not raw XML
      expect(result.prompt).not.toContain('<function_results>');
      // ToolSummarizer outputs "Result:" format for function results
      const resultMatches = result.prompt.match(/Result:/g);
      expect(resultMatches).toBeTruthy();
      expect(resultMatches!.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves non-tool assistant messages', async () => {
      const restorer = new ContextRestorer(new MockSummaryProvider());

      const turns = [
        createTurn(1, 'Hello', 'user'),
        createTurn(2, 'Hi! How can I help you?', 'assistant'),
      ];

      const result = await restorer.generateRestorationPrompt(turns, conversationId, baseDir);

      expect(result.prompt).toContain('[Assistant]: Hi! How can I help you?');
    });
  });
});
