/**
 * ContextUsageTracker - Track context usage via /usage command
 *
 * Monitors agent context usage by invoking /usage command and parsing
 * stderr output. Provides token counts to SessionLifecycleManager for
 * rotation decisions.
 *
 * AC: @mem-context-usage ac-2 - Sends /usage command when triggered
 * AC: @mem-context-usage ac-3 - Parses stderr, emits ContextUsageUpdate
 * AC: @mem-context-usage ac-4 - Handles failures with stale data fallback
 *
 * @see @mem-context-usage
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '@kynetic-bot/core';

const log = createLogger('context-usage-tracker');

// ============================================================================
// Context Usage Types
//
// These types mirror the ACP types but are defined locally to avoid
// circular dependencies between messaging and agent packages.
// ============================================================================

/**
 * A category of context usage (e.g., "System prompt", "Messages")
 */
export interface ContextCategory {
  name: string;
  tokens: number;
  percentage: number;
}

/**
 * Context usage update parsed from agent stderr /usage output
 *
 * AC: @mem-context-usage ac-3 - Structured output type
 */
export interface ContextUsageUpdate {
  type: 'context_usage';
  model: string;
  tokens: {
    current: number;
    max: number;
    percentage: number;
  };
  categories: ContextCategory[];
  timestamp: number;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal ACP client interface for sending prompts
 */
export interface UsagePromptClient {
  prompt(params: {
    sessionId: string;
    prompt: Array<{ type: 'text'; text: string }>;
    promptSource?: 'user' | 'system';
  }): Promise<unknown>;
}

/**
 * Minimal AgentLifecycle interface for stderr subscription
 */
export interface StderrProvider {
  onStderr(callback: (data: string) => void): () => void;
}

/**
 * Options for ContextUsageTracker
 */
export interface ContextUsageTrackerOptions {
  /** Timeout for /usage command in milliseconds (default: 10000) */
  timeout?: number;
  /** Minimum interval between usage checks in milliseconds (default: 30000) */
  debounceInterval?: number;
}

/**
 * Events emitted by ContextUsageTracker
 */
export interface ContextUsageTrackerEvents {
  'usage:update': ContextUsageUpdate;
  'usage:error': { error: Error; sessionId: string };
  'usage:timeout': { sessionId: string; lastKnown: ContextUsageUpdate | null };
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 10000; // 10 seconds
const DEFAULT_DEBOUNCE_INTERVAL = 30000; // 30 seconds

// ============================================================================
// Parser Functions
// ============================================================================

/**
 * Parse /usage output from stderr
 *
 * AC: @mem-context-usage ac-3 - Parse stderr response into structured update
 *
 * Expected format:
 * <local-command-stdout>
 * ## Context Usage
 * **Model:** claude-opus-4-5-20251101
 * **Tokens:** 69.0k / 200.0k (34%)
 *
 * ### Categories
 * | Category | Tokens | Percentage |
 * | System prompt | 3.1k | 1.5% |
 * ...
 * </local-command-stdout>
 */
export function parseUsageOutput(output: string): ContextUsageUpdate | null {
  // Extract content from XML block
  const xmlMatch = output.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (!xmlMatch) {
    return null;
  }

  const content = xmlMatch[1];

  // Parse model
  const modelMatch = content.match(/\*\*Model:\*\*\s*([^\n\r]+)/);
  const model = modelMatch?.[1]?.trim() ?? 'unknown';

  // Parse tokens: **Tokens:** 69.0k / 200.0k (34%)
  const tokensMatch = content.match(
    /\*\*Tokens:\*\*\s*([\d.]+)(k)?\s*\/\s*([\d.]+)(k)?\s*\((\d+(?:\.\d+)?)%\)/
  );
  if (!tokensMatch) {
    return null;
  }

  const currentRaw = parseFloat(tokensMatch[1]);
  const currentMultiplier = tokensMatch[2] === 'k' ? 1000 : 1;
  const maxRaw = parseFloat(tokensMatch[3]);
  const maxMultiplier = tokensMatch[4] === 'k' ? 1000 : 1;
  const percentage = parseFloat(tokensMatch[5]);

  const tokens = {
    current: Math.round(currentRaw * currentMultiplier),
    max: Math.round(maxRaw * maxMultiplier),
    percentage,
  };

  // Parse categories from table
  // | Category | Tokens | Percentage |
  // | System prompt | 3.1k | 1.5% |
  const categories: ContextCategory[] = [];
  const categoryRegex = /\|\s*([^|]+?)\s*\|\s*([\d.]+)(k)?\s*\|\s*([\d.]+)%\s*\|/g;
  let match;
  while ((match = categoryRegex.exec(content)) !== null) {
    const name = match[1].trim();
    // Skip header row
    if (name === 'Category' || name === '---' || name.startsWith('-')) {
      continue;
    }

    const tokensRaw = parseFloat(match[2]);
    const tokensMultiplier = match[3] === 'k' ? 1000 : 1;
    const pct = parseFloat(match[4]);

    categories.push({
      name,
      tokens: Math.round(tokensRaw * tokensMultiplier),
      percentage: pct,
    });
  }

  return {
    type: 'context_usage',
    model,
    tokens,
    categories,
    timestamp: Date.now(),
  };
}

// ============================================================================
// ContextUsageTracker Implementation
// ============================================================================

/**
 * Tracks context usage by invoking /usage command and parsing stderr.
 *
 * @trait-observable - Emits usage:update events with parsed data
 * @trait-recoverable - Handles timeouts and errors gracefully
 */
export class ContextUsageTracker extends EventEmitter {
  private readonly timeout: number;
  private readonly debounceInterval: number;

  /** Last known usage per session */
  private readonly lastKnown = new Map<string, ContextUsageUpdate>();

  /** Last check timestamp per session (for debouncing) */
  private readonly lastCheck = new Map<string, number>();

  constructor(options: ContextUsageTrackerOptions = {}) {
    super();
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.debounceInterval = options.debounceInterval ?? DEFAULT_DEBOUNCE_INTERVAL;
  }

  /**
   * Check context usage for a session
   *
   * AC: @mem-context-usage ac-2 - Sends /usage command to agent
   * AC: @mem-context-usage ac-3 - Parses response and emits ContextUsageUpdate
   * AC: @mem-context-usage ac-4 - Falls back to stale data on error/timeout
   *
   * @param sessionId - Session to check usage for
   * @param client - ACP client for sending prompts
   * @param stderrProvider - Provider for stderr events
   * @returns ContextUsageUpdate or null if failed
   */
  async checkUsage(
    sessionId: string,
    client: UsagePromptClient,
    stderrProvider: StderrProvider
  ): Promise<ContextUsageUpdate | null> {
    // Debounce: skip if last check was too recent
    const lastCheckTime = this.lastCheck.get(sessionId) ?? 0;
    const now = Date.now();
    if (now - lastCheckTime < this.debounceInterval) {
      log.debug('Skipping usage check (debounced)', {
        sessionId,
        msSinceLastCheck: now - lastCheckTime,
      });
      return this.lastKnown.get(sessionId) ?? null;
    }

    this.lastCheck.set(sessionId, now);

    try {
      const update = await this.performUsageCheck(sessionId, client, stderrProvider);

      if (update) {
        this.lastKnown.set(sessionId, update);
        this.emit('usage:update', update);
        log.debug('Usage check completed', {
          sessionId,
          tokens: update.tokens,
          categories: update.categories.length,
        });
      }

      return update;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn('Usage check failed', { sessionId, error: error.message });

      // AC-4: Continue with stale data on error
      this.emit('usage:error', { error, sessionId });

      return this.lastKnown.get(sessionId) ?? null;
    }
  }

  /**
   * Perform the actual usage check
   */
  private async performUsageCheck(
    sessionId: string,
    client: UsagePromptClient,
    stderrProvider: StderrProvider
  ): Promise<ContextUsageUpdate | null> {
    // Set up stderr capture
    let stderrBuffer = '';
    const unsubscribe = stderrProvider.onStderr((data) => {
      stderrBuffer += data;
    });

    try {
      // Send /usage command with timeout
      // AC-2: Send /usage command and await response
      const promptPromise = client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: '/usage' }],
        promptSource: 'system',
      });

      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.timeout);
      });

      const result = await Promise.race([promptPromise, timeoutPromise]);

      if (result === 'timeout') {
        // AC-4: Handle timeout gracefully
        log.warn('Usage check timed out', { sessionId, timeout: this.timeout });
        const lastKnown = this.lastKnown.get(sessionId) ?? null;
        this.emit('usage:timeout', { sessionId, lastKnown });
        return lastKnown;
      }

      // Parse stderr output
      // AC-3: Parse stderr response
      const update = parseUsageOutput(stderrBuffer);
      return update;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Get the last known usage for a session
   */
  getLastKnown(sessionId: string): ContextUsageUpdate | null {
    return this.lastKnown.get(sessionId) ?? null;
  }

  /**
   * Clear cached usage data for a session
   */
  clearSession(sessionId: string): void {
    this.lastKnown.delete(sessionId);
    this.lastCheck.delete(sessionId);
  }

  /**
   * Clear all cached data
   */
  clearAll(): void {
    this.lastKnown.clear();
    this.lastCheck.clear();
  }
}
