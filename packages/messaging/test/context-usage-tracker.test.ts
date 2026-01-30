/**
 * ContextUsageTracker Tests
 *
 * Tests for context usage tracking via /usage command parsing.
 *
 * @see @mem-context-usage
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContextUsageTracker,
  parseUsageOutput,
  type ContextUsageUpdate,
  type StderrProvider,
  type UsagePromptClient,
} from '../src/context/context-usage-tracker.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const SAMPLE_USAGE_OUTPUT = `
<local-command-stdout>
## Context Usage
**Model:** claude-opus-4-5-20251101
**Tokens:** 69.0k / 200.0k (34%)

### Categories
| Category | Tokens | Percentage |
| --- | --- | --- |
| System prompt | 3.1k | 1.5% |
| Messages | 136 | 0.1% |
| Tool calls | 45.2k | 22.6% |
| Tool results | 20.5k | 10.3% |
</local-command-stdout>
`;

const SAMPLE_USAGE_OUTPUT_NO_K = `
<local-command-stdout>
## Context Usage
**Model:** claude-sonnet-4-20250514
**Tokens:** 500 / 8000 (6.25%)

### Categories
| Category | Tokens | Percentage |
| --- | --- | --- |
| System prompt | 200 | 2.5% |
| Messages | 300 | 3.75% |
</local-command-stdout>
`;

// ============================================================================
// parseUsageOutput Tests
// ============================================================================

describe('parseUsageOutput', () => {
  // AC: @mem-context-usage ac-3 - Parse stderr response into structured update
  it('parses usage output with k suffix', () => {
    const result = parseUsageOutput(SAMPLE_USAGE_OUTPUT);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('context_usage');
    expect(result!.model).toBe('claude-opus-4-5-20251101');
    expect(result!.tokens).toEqual({
      current: 69000,
      max: 200000,
      percentage: 34,
    });
    expect(result!.categories).toHaveLength(4);
    expect(result!.categories[0]).toEqual({
      name: 'System prompt',
      tokens: 3100,
      percentage: 1.5,
    });
  });

  // AC: @mem-context-usage ac-3 - Parse different number formats
  it('parses usage output without k suffix', () => {
    const result = parseUsageOutput(SAMPLE_USAGE_OUTPUT_NO_K);

    expect(result).not.toBeNull();
    expect(result!.model).toBe('claude-sonnet-4-20250514');
    expect(result!.tokens).toEqual({
      current: 500,
      max: 8000,
      percentage: 6.25,
    });
    expect(result!.categories).toHaveLength(2);
  });

  // AC: @mem-context-usage ac-3 - Handle missing XML block
  it('returns null for output without XML block', () => {
    const result = parseUsageOutput('Some random output without the expected format');

    expect(result).toBeNull();
  });

  // AC: @mem-context-usage ac-3 - Handle malformed token line
  it('returns null for output with malformed tokens line', () => {
    const malformed = `
<local-command-stdout>
## Context Usage
**Model:** claude-opus-4-5-20251101
**Tokens:** invalid format
</local-command-stdout>
`;
    const result = parseUsageOutput(malformed);

    expect(result).toBeNull();
  });

  // AC: @mem-context-usage ac-3 - Handle empty categories
  it('parses output with no categories', () => {
    const noCategories = `
<local-command-stdout>
## Context Usage
**Model:** claude-opus-4-5-20251101
**Tokens:** 1.0k / 100.0k (1%)
</local-command-stdout>
`;
    const result = parseUsageOutput(noCategories);

    expect(result).not.toBeNull();
    expect(result!.categories).toHaveLength(0);
  });

  // AC: @mem-context-usage ac-3 - Timestamp is set
  it('sets timestamp on parsed output', () => {
    const before = Date.now();
    const result = parseUsageOutput(SAMPLE_USAGE_OUTPUT);
    const after = Date.now();

    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeGreaterThanOrEqual(before);
    expect(result!.timestamp).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// ContextUsageTracker Tests
// ============================================================================

describe('ContextUsageTracker', () => {
  let tracker: ContextUsageTracker;
  let mockClient: UsagePromptClient;
  let mockStderrProvider: StderrProvider;
  let stderrCallbacks: Array<(data: string) => void>;

  beforeEach(() => {
    stderrCallbacks = [];

    mockClient = {
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    };

    mockStderrProvider = {
      onStderr: vi.fn((callback) => {
        stderrCallbacks.push(callback);
        return () => {
          const index = stderrCallbacks.indexOf(callback);
          if (index >= 0) stderrCallbacks.splice(index, 1);
        };
      }),
    };

    tracker = new ContextUsageTracker({
      timeout: 1000,
      debounceInterval: 0, // Disable debouncing for tests
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // AC: @mem-context-usage ac-2 - Sends /usage command when triggered
  describe('checkUsage', () => {
    it('sends /usage prompt to agent', async () => {
      // Emit stderr output when prompt is called
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      const result = await tracker.checkUsage('session-1', mockClient, mockStderrProvider);

      expect(mockClient.prompt).toHaveBeenCalledWith({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: '/usage' }],
        promptSource: 'system',
      });
      expect(result).not.toBeNull();
    });

    // AC: @mem-context-usage ac-3 - Emits ContextUsageUpdate with parsed data
    it('emits usage:update event with parsed data', async () => {
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      const events: unknown[] = [];
      tracker.on('usage:update', (update) => events.push(update));

      await tracker.checkUsage('session-1', mockClient, mockStderrProvider);

      expect(events).toHaveLength(1);
      expect((events[0] as { model: string }).model).toBe('claude-opus-4-5-20251101');
    });

    // AC: @mem-context-usage ac-3 - Stores last known usage
    it('stores last known usage for session', async () => {
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await tracker.checkUsage('session-1', mockClient, mockStderrProvider);

      const lastKnown = tracker.getLastKnown('session-1');
      expect(lastKnown).not.toBeNull();
      expect(lastKnown!.model).toBe('claude-opus-4-5-20251101');
    });

    // AC: @mem-context-usage ac-4 - Falls back to stale data on error
    it('returns stale data on prompt error', async () => {
      // First call succeeds
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await tracker.checkUsage('session-1', mockClient, mockStderrProvider);

      // Second call fails
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      );

      const errorEvents: unknown[] = [];
      tracker.on('usage:error', (e) => errorEvents.push(e));

      const result = await tracker.checkUsage('session-1', mockClient, mockStderrProvider);

      // Should return stale data
      expect(result).not.toBeNull();
      expect(result!.model).toBe('claude-opus-4-5-20251101');
      expect(errorEvents).toHaveLength(1);
    });

    // AC: @mem-context-usage ac-4 - Handles timeout gracefully
    it('returns stale data on timeout', async () => {
      // Create tracker with very short timeout
      const fastTracker = new ContextUsageTracker({
        timeout: 50, // 50ms timeout
        debounceInterval: 0,
      });

      // First call succeeds - populates stale data cache
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await fastTracker.checkUsage('session-1', mockClient, mockStderrProvider);

      const timeoutEvents: unknown[] = [];
      fastTracker.on('usage:timeout', (e) => timeoutEvents.push(e));

      // Second call times out (never resolves within timeout)
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise(() => {}) // Never resolves
      );

      const result = await fastTracker.checkUsage('session-1', mockClient, mockStderrProvider);

      // Should return stale data from first call
      expect(result).not.toBeNull();
      expect(result!.model).toBe('claude-opus-4-5-20251101');
      expect(timeoutEvents).toHaveLength(1);
    });

    // AC: @mem-context-usage ac-4 - Returns null when no stale data and error
    it('returns null on error when no stale data', async () => {
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Failed'));

      const result = await tracker.checkUsage('new-session', mockClient, mockStderrProvider);

      expect(result).toBeNull();
    });
  });

  describe('debouncing', () => {
    it('skips check if last check was too recent', async () => {
      const debouncedTracker = new ContextUsageTracker({
        timeout: 1000,
        debounceInterval: 30000, // 30 seconds
      });

      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      // First call
      await debouncedTracker.checkUsage('session-1', mockClient, mockStderrProvider);
      expect(mockClient.prompt).toHaveBeenCalledTimes(1);

      // Second call should be debounced
      await debouncedTracker.checkUsage('session-1', mockClient, mockStderrProvider);
      expect(mockClient.prompt).toHaveBeenCalledTimes(1); // Still 1

      // Different session should not be debounced
      await debouncedTracker.checkUsage('session-2', mockClient, mockStderrProvider);
      expect(mockClient.prompt).toHaveBeenCalledTimes(2);
    });

    it('returns last known when debounced', async () => {
      const debouncedTracker = new ContextUsageTracker({
        timeout: 1000,
        debounceInterval: 30000,
      });

      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      // First call
      await debouncedTracker.checkUsage('session-1', mockClient, mockStderrProvider);

      // Second call should return cached
      const result = await debouncedTracker.checkUsage('session-1', mockClient, mockStderrProvider);

      expect(result).not.toBeNull();
      expect(result!.model).toBe('claude-opus-4-5-20251101');
    });
  });

  describe('clearSession', () => {
    it('clears cached data for session', async () => {
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await tracker.checkUsage('session-1', mockClient, mockStderrProvider);
      expect(tracker.getLastKnown('session-1')).not.toBeNull();

      tracker.clearSession('session-1');

      expect(tracker.getLastKnown('session-1')).toBeNull();
    });
  });

  describe('clearAll', () => {
    it('clears all cached data', async () => {
      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await tracker.checkUsage('session-1', mockClient, mockStderrProvider);
      await tracker.checkUsage('session-2', mockClient, mockStderrProvider);

      tracker.clearAll();

      expect(tracker.getLastKnown('session-1')).toBeNull();
      expect(tracker.getLastKnown('session-2')).toBeNull();
    });
  });

  describe('stderr cleanup', () => {
    it('unsubscribes from stderr after check', async () => {
      let subscriberCount = 0;

      const trackingStderrProvider: StderrProvider = {
        onStderr: (callback) => {
          subscriberCount++;
          stderrCallbacks.push(callback);
          return () => {
            subscriberCount--;
            const index = stderrCallbacks.indexOf(callback);
            if (index >= 0) stderrCallbacks.splice(index, 1);
          };
        },
      };

      (mockClient.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        for (const cb of stderrCallbacks) {
          cb(SAMPLE_USAGE_OUTPUT);
        }
        return { stopReason: 'end_turn' };
      });

      await tracker.checkUsage('session-1', mockClient, trackingStderrProvider);

      expect(subscriberCount).toBe(0);
    });

    it('unsubscribes from stderr even on error', async () => {
      let subscriberCount = 0;

      const trackingStderrProvider: StderrProvider = {
        onStderr: (callback) => {
          subscriberCount++;
          stderrCallbacks.push(callback);
          return () => {
            subscriberCount--;
            const index = stderrCallbacks.indexOf(callback);
            if (index >= 0) stderrCallbacks.splice(index, 1);
          };
        },
      };

      (mockClient.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Failed'));

      await tracker.checkUsage('session-1', mockClient, trackingStderrProvider);

      expect(subscriberCount).toBe(0);
    });
  });
});
