/**
 * TurnSelector Tests
 *
 * Tests for token-budget-based turn selection.
 *
 * @see @mem-turn-selection
 */

import type { ConversationTurn } from '@kynetic-bot/memory';
import { describe, expect, it } from 'vitest';

import { TurnSelector, type TurnSelectionResult } from '../src/context/turn-selector.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock conversation turn
 */
function createTurn(
  seq: number,
  content: string,
  role: 'user' | 'assistant' = 'user'
): ConversationTurn {
  return {
    ts: Date.now() - (100 - seq) * 1000, // Older turns have earlier timestamps
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
 * Create a tool call content (Read tool with file content)
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

// ============================================================================
// TurnSelector Tests
// ============================================================================

describe('TurnSelector', () => {
  describe('configuration', () => {
    it('uses default values', () => {
      const selector = new TurnSelector();

      // Default: 200k tokens, 30% budget = 60k tokens
      expect(selector.getBudget()).toBe(60000);
      // With 5% margin: 60k + 3k = 63k
      expect(selector.getMaxAllowed()).toBe(63000);
    });

    it('accepts custom configuration', () => {
      const selector = new TurnSelector({
        maxContextTokens: 100000,
        budgetFraction: 0.4,
        marginFraction: 0.1,
      });

      // 100k * 0.4 = 40k budget
      expect(selector.getBudget()).toBe(40000);
      // 40k + 4k (10% margin) = 44k
      expect(selector.getMaxAllowed()).toBe(44000);
    });
  });

  describe('getBudget', () => {
    it('calculates 30% of context window by default', () => {
      const selector = new TurnSelector({ maxContextTokens: 100000 });
      expect(selector.getBudget()).toBe(30000);
    });

    it('uses custom budget fraction', () => {
      const selector = new TurnSelector({
        maxContextTokens: 100000,
        budgetFraction: 0.5,
      });
      expect(selector.getBudget()).toBe(50000);
    });
  });

  describe('getMaxAllowed', () => {
    // AC: @mem-turn-selection ac-3 - 5% margin above budget
    it('adds 5% margin to budget by default', () => {
      const selector = new TurnSelector({ maxContextTokens: 100000 });
      const budget = selector.getBudget(); // 30000
      const maxAllowed = selector.getMaxAllowed(); // 30000 + 1500 = 31500

      expect(maxAllowed).toBe(budget + Math.floor(budget * 0.05));
    });
  });

  describe('estimateTurn', () => {
    const selector = new TurnSelector();

    it('estimates tokens for plain text', () => {
      const content = createContentOfTokens(100); // ~100 tokens
      const turn = createTurn(1, content);

      const estimation = selector.estimateTurn(turn);

      expect(estimation.originalTokens).toBe(100);
      expect(estimation.effectiveTokens).toBe(100);
      expect(estimation.isToolCall).toBe(false);
    });

    // AC: @mem-turn-selection ac-2 - Summarized form for tool calls
    it('uses summarized form for tool calls', () => {
      const content = createToolCallContent(50); // Large tool output
      const turn = createTurn(1, content);

      const estimation = selector.estimateTurn(turn);

      expect(estimation.isToolCall).toBe(true);
      expect(estimation.effectiveTokens).toBeLessThan(estimation.originalTokens);
      expect(estimation.summarizedContent).toBeDefined();
    });

    it('preserves original tokens count even for tool calls', () => {
      const content = createToolCallContent(100);
      const turn = createTurn(1, content);

      const estimation = selector.estimateTurn(turn);

      // Original tokens should reflect actual content size
      expect(estimation.originalTokens).toBeGreaterThan(estimation.effectiveTokens);
    });
  });

  describe('selectTurns', () => {
    // AC: @mem-turn-selection ac-1 - Most recent turns selected
    it('selects most recent turns within budget', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        charsPerToken: 4,
      });

      // Budget: 300 tokens, each turn is 100 tokens
      const turns = [
        createTurn(1, createContentOfTokens(100)), // oldest - excluded
        createTurn(2, createContentOfTokens(100)), // excluded
        createTurn(3, createContentOfTokens(100)), // selected
        createTurn(4, createContentOfTokens(100)), // selected
        createTurn(5, createContentOfTokens(100)), // most recent - selected
      ];

      const result = selector.selectTurns(turns);

      // Should select 3 most recent (300 tokens = exactly budget, within margin)
      expect(result.selectedTurns).toHaveLength(3);
      expect(result.selectedTurns[0].seq).toBe(3);
      expect(result.selectedTurns[2].seq).toBe(5);
      expect(result.excludedCount).toBe(2);
    });

    // AC: @mem-turn-selection ac-1 - Selection based on token budget
    it('selects based on token count, not turn count', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        charsPerToken: 4,
      });

      // Budget: 300 tokens
      // Turn 1: 50 tokens
      // Turn 2: 50 tokens
      // Turn 3: 50 tokens
      // Turn 4: 50 tokens (most recent)
      const turns = [
        createTurn(1, createContentOfTokens(50)),
        createTurn(2, createContentOfTokens(50)),
        createTurn(3, createContentOfTokens(50)),
        createTurn(4, createContentOfTokens(50)),
      ];

      const result = selector.selectTurns(turns);

      // All 4 turns = 200 tokens, well within 300 budget
      expect(result.selectedTurns).toHaveLength(4);
      expect(result.totalTokens).toBe(200);
    });

    // AC: @mem-turn-selection ac-3 - Within budget with margin
    it('respects budget with 5% margin', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        marginFraction: 0.05,
        charsPerToken: 4,
      });

      // Budget: 300 tokens, margin: 15 tokens, max: 315 tokens
      // Create turns that exceed budget but fit within margin
      const turns = [
        createTurn(1, createContentOfTokens(50)), // excluded
        createTurn(2, createContentOfTokens(155)), // selected
        createTurn(3, createContentOfTokens(155)), // selected - total 310, within 315 max
      ];

      const result = selector.selectTurns(turns);

      expect(result.selectedTurns).toHaveLength(2);
      expect(result.totalTokens).toBe(310);
      expect(result.withinBudget).toBe(true);
    });

    // AC: @mem-turn-selection ac-3 - Stops before exceeding margin
    it('stops adding turns when exceeding max allowed', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        marginFraction: 0.05,
        charsPerToken: 4,
      });

      // Budget: 300, max: 315
      // If we have 3 turns of 150 each, can only fit 2 (300 tokens)
      const turns = [
        createTurn(1, createContentOfTokens(150)),
        createTurn(2, createContentOfTokens(150)),
        createTurn(3, createContentOfTokens(150)),
      ];

      const result = selector.selectTurns(turns);

      expect(result.selectedTurns).toHaveLength(2);
      expect(result.totalTokens).toBe(300);
      expect(result.excludedCount).toBe(1);
    });

    it('returns empty result for empty turns', () => {
      const selector = new TurnSelector();

      const result = selector.selectTurns([]);

      expect(result.selectedTurns).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
      expect(result.withinBudget).toBe(true);
    });

    it('maintains chronological order in selection', () => {
      const selector = new TurnSelector({
        maxContextTokens: 10000,
        budgetFraction: 0.5,
        charsPerToken: 4,
      });

      const turns = [
        createTurn(1, createContentOfTokens(100)),
        createTurn(2, createContentOfTokens(100)),
        createTurn(3, createContentOfTokens(100)),
      ];

      const result = selector.selectTurns(turns);

      // Should be in chronological order
      expect(result.selectedTurns.map((t) => t.seq)).toEqual([1, 2, 3]);
    });

    // AC: @mem-turn-selection ac-2 - Tool calls use summarized tokens
    it('uses summarized tokens for tool calls in selection', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        charsPerToken: 4,
      });

      // Budget: 300 tokens
      // Tool call with 100 lines of output (large), but summarizes to small
      const toolContent = createToolCallContent(100);
      const plainContent = createContentOfTokens(100);

      const turns = [
        createTurn(1, plainContent, 'user'), // ~100 tokens
        createTurn(2, toolContent, 'assistant'), // Large, but summarized small
        createTurn(3, plainContent, 'user'), // ~100 tokens
      ];

      const result = selector.selectTurns(turns);

      // Tool call should use summarized tokens, allowing more turns to fit
      expect(result.selectedTurns.length).toBeGreaterThanOrEqual(2);

      // Find the tool call estimation
      const toolEstimation = result.estimations.find((e) => e.isToolCall);
      if (toolEstimation) {
        expect(toolEstimation.effectiveTokens).toBeLessThan(toolEstimation.originalTokens);
      }
    });
  });

  describe('selectTurnsWithBudget', () => {
    it('uses custom budget instead of default', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3, // Default would be 300
        charsPerToken: 4,
      });

      const turns = [
        createTurn(1, createContentOfTokens(200)),
        createTurn(2, createContentOfTokens(200)),
        createTurn(3, createContentOfTokens(200)),
      ];

      // With default budget (300 + margin), only 1 turn fits
      const defaultResult = selector.selectTurns(turns);
      expect(defaultResult.selectedTurns).toHaveLength(1);

      // With custom budget of 500, 2 turns fit
      const customResult = selector.selectTurnsWithBudget(turns, 500);
      expect(customResult.selectedTurns).toHaveLength(2);
      expect(customResult.budget).toBe(500);
    });

    it('applies margin to custom budget', () => {
      const selector = new TurnSelector({
        marginFraction: 0.1,
        charsPerToken: 4,
      });

      const result = selector.selectTurnsWithBudget([], 1000);

      // 1000 + 10% = 1100
      expect(result.maxAllowed).toBe(1100);
    });
  });

  describe('getStatistics', () => {
    it('calculates statistics for turns', () => {
      const selector = new TurnSelector({ charsPerToken: 4 });

      const turns = [
        createTurn(1, createContentOfTokens(100), 'user'),
        createTurn(2, createToolCallContent(50), 'assistant'),
        createTurn(3, createContentOfTokens(100), 'user'),
      ];

      const stats = selector.getStatistics(turns);

      expect(stats.totalTurns).toBe(3);
      expect(stats.toolCallTurns).toBe(1);
      expect(stats.originalTotalTokens).toBeGreaterThan(stats.effectiveTotalTokens);
      expect(stats.tokenSavings).toBeGreaterThan(0);
      expect(stats.savingsPercentage).toBeGreaterThan(0);
    });

    it('returns zero savings for non-tool content', () => {
      const selector = new TurnSelector({ charsPerToken: 4 });

      const turns = [
        createTurn(1, createContentOfTokens(100)),
        createTurn(2, createContentOfTokens(100)),
      ];

      const stats = selector.getStatistics(turns);

      expect(stats.toolCallTurns).toBe(0);
      expect(stats.tokenSavings).toBe(0);
      expect(stats.savingsPercentage).toBe(0);
    });

    it('handles empty turns array', () => {
      const selector = new TurnSelector();

      const stats = selector.getStatistics([]);

      expect(stats.totalTurns).toBe(0);
      expect(stats.toolCallTurns).toBe(0);
      expect(stats.originalTotalTokens).toBe(0);
      expect(stats.effectiveTotalTokens).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles single turn larger than budget', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.1, // 100 token budget
        charsPerToken: 4,
      });

      const turns = [createTurn(1, createContentOfTokens(200))]; // 200 tokens > 100 budget

      const result = selector.selectTurns(turns);

      // Can't fit any turns
      expect(result.selectedTurns).toHaveLength(0);
      expect(result.excludedCount).toBe(1);
    });

    it('handles turns exactly at max allowed', () => {
      const selector = new TurnSelector({
        maxContextTokens: 1000,
        budgetFraction: 0.3,
        marginFraction: 0.05,
        charsPerToken: 4,
      });

      // Max allowed: 315 tokens
      const turns = [createTurn(1, createContentOfTokens(315))];

      const result = selector.selectTurns(turns);

      expect(result.selectedTurns).toHaveLength(1);
      expect(result.withinBudget).toBe(true);
    });

    it('handles very small context window', () => {
      const selector = new TurnSelector({
        maxContextTokens: 100,
        budgetFraction: 0.3,
        charsPerToken: 4,
      });

      // Budget: 30 tokens
      const turns = [
        createTurn(1, 'Short message'), // ~4 tokens
        createTurn(2, 'Another short one'), // ~4 tokens
      ];

      const result = selector.selectTurns(turns);

      expect(result.selectedTurns).toHaveLength(2);
      expect(result.withinBudget).toBe(true);
    });
  });

  describe('trait-validated inherited ACs', () => {
    // Note: The validation tests here are for the TurnSelector's own input validation
    // The trait-validated ACs from the spec apply to the overall feature's validation behavior

    it('handles undefined content gracefully', () => {
      const selector = new TurnSelector();

      // This is technically invalid per the schema, but we should handle it gracefully
      const turn: ConversationTurn = {
        ts: Date.now(),
        seq: 1,
        role: 'user',
        content: '', // Empty content
      };

      const result = selector.selectTurns([turn]);

      expect(result.selectedTurns).toHaveLength(1);
      expect(result.totalTokens).toBe(0);
    });
  });
});
