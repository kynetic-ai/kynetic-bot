/**
 * Supervisor CLI Entry Point Tests
 *
 * Test coverage for CLI configuration and shutdown patterns.
 *
 * AC: @shutdown-modes ac-9, ac-10, ac-11 - Configurable shutdown timeout
 *
 * Note: These tests verify the configuration logic patterns in isolation since
 * the actual CLI module has side effects (signal handlers, process.exit).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

const DEFAULT_SHUTDOWN_TIMEOUT = 30000;

/**
 * Parse SHUTDOWN_TIMEOUT from environment variable
 * Replicates the logic from cli.ts for testing
 */
function getShutdownTimeout(envValue: string | undefined): {
  value: number;
  warning?: string;
} {
  if (!envValue) return { value: DEFAULT_SHUTDOWN_TIMEOUT };

  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed) || String(parsed) !== envValue.trim()) {
    return {
      value: DEFAULT_SHUTDOWN_TIMEOUT,
      warning: `Invalid SHUTDOWN_TIMEOUT value "${envValue}", using default ${DEFAULT_SHUTDOWN_TIMEOUT}ms`,
    };
  }
  if (parsed <= 0) {
    return {
      value: DEFAULT_SHUTDOWN_TIMEOUT,
      warning: `SHUTDOWN_TIMEOUT must be positive, using default ${DEFAULT_SHUTDOWN_TIMEOUT}ms`,
    };
  }
  return { value: parsed };
}

/**
 * Calculate force exit timeout from shutdown timeout
 * Replicates the logic from cli.ts
 */
function calculateForceExitTimeout(shutdownTimeoutMs: number): number {
  return Math.max(shutdownTimeoutMs + 5000, DEFAULT_SHUTDOWN_TIMEOUT);
}

describe('Supervisor CLI Configuration', () => {
  describe('SHUTDOWN_TIMEOUT parsing (AC: @shutdown-modes ac-9, ac-10)', () => {
    // AC: @shutdown-modes ac-9
    it('uses configured value when SHUTDOWN_TIMEOUT is valid', () => {
      const result = getShutdownTimeout('15000');
      expect(result.value).toBe(15000);
      expect(result.warning).toBeUndefined();
    });

    // AC: @shutdown-modes ac-9
    it('parses large timeout values', () => {
      const result = getShutdownTimeout('120000');
      expect(result.value).toBe(120000);
      expect(result.warning).toBeUndefined();
    });

    // AC: @shutdown-modes ac-10
    it('returns default when SHUTDOWN_TIMEOUT is not set', () => {
      const result = getShutdownTimeout(undefined);
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toBeUndefined();
    });

    // AC: @shutdown-modes ac-10
    it('returns default when SHUTDOWN_TIMEOUT is empty string', () => {
      const result = getShutdownTimeout('');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toBeUndefined();
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for non-numeric value', () => {
      const result = getShutdownTimeout('abc');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('Invalid SHUTDOWN_TIMEOUT');
      expect(result.warning).toContain('abc');
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for mixed alphanumeric value', () => {
      const result = getShutdownTimeout('123abc');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('Invalid SHUTDOWN_TIMEOUT');
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for value with units suffix', () => {
      const result = getShutdownTimeout('30s');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('Invalid SHUTDOWN_TIMEOUT');
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for zero value', () => {
      const result = getShutdownTimeout('0');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('must be positive');
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for negative value', () => {
      const result = getShutdownTimeout('-5000');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('must be positive');
    });

    // AC: @shutdown-modes ac-10
    it('returns default with warning for floating point value', () => {
      const result = getShutdownTimeout('30000.5');
      expect(result.value).toBe(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(result.warning).toContain('Invalid SHUTDOWN_TIMEOUT');
    });

    // AC: @shutdown-modes ac-9
    it('handles value with leading/trailing whitespace', () => {
      // Note: parseInt handles leading whitespace, but our validation checks exact match
      const result = getShutdownTimeout(' 15000 ');
      expect(result.value).toBe(15000);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('Force exit timeout calculation (AC: @shutdown-modes ac-11)', () => {
    // AC: @shutdown-modes ac-11
    it('adds 5000ms buffer to shutdown timeout', () => {
      const forceExit = calculateForceExitTimeout(10000);
      expect(forceExit).toBe(30000); // max(10000 + 5000, 30000) = 30000
    });

    // AC: @shutdown-modes ac-11
    it('uses minimum of 30000ms', () => {
      const forceExit = calculateForceExitTimeout(5000);
      expect(forceExit).toBe(30000); // max(5000 + 5000, 30000) = 30000
    });

    // AC: @shutdown-modes ac-11
    it('exceeds minimum when shutdown timeout is large', () => {
      const forceExit = calculateForceExitTimeout(30000);
      expect(forceExit).toBe(35000); // max(30000 + 5000, 30000) = 35000
    });

    // AC: @shutdown-modes ac-11
    it('provides adequate buffer for long timeouts', () => {
      const forceExit = calculateForceExitTimeout(60000);
      expect(forceExit).toBe(65000); // max(60000 + 5000, 30000) = 65000
    });

    // AC: @shutdown-modes ac-11
    it('handles default supervisor timeout (30s)', () => {
      const forceExit = calculateForceExitTimeout(DEFAULT_SHUTDOWN_TIMEOUT);
      expect(forceExit).toBe(35000); // 30000 + 5000 = 35000
    });
  });
});

describe('Supervisor CLI Shutdown Logic', () => {
  describe('Double-shutdown prevention', () => {
    it('prevents multiple simultaneous shutdowns', async () => {
      let isShuttingDown = false;
      let shutdownPromise: Promise<void> | null = null;
      let cleanupCount = 0;

      const shutdown = async (cleanup: () => Promise<void>): Promise<void> => {
        if (isShuttingDown) {
          if (shutdownPromise) await shutdownPromise;
          return;
        }
        isShuttingDown = true;

        shutdownPromise = cleanup();
        await shutdownPromise;
      };

      const cleanup = async () => {
        cleanupCount++;
        await new Promise((r) => setTimeout(r, 10));
      };

      // Simulate rapid shutdown calls
      const p1 = shutdown(cleanup);
      const p2 = shutdown(cleanup);

      await Promise.all([p1, p2]);

      expect(cleanupCount).toBe(1);
    });
  });

  describe('Force exit timeout pattern', () => {
    it('clears force exit timer on clean shutdown', async () => {
      let forceExitCalled = false;

      const mockShutdown = async (): Promise<void> => {
        const forceExitTimer = setTimeout(() => {
          forceExitCalled = true;
        }, 50);
        forceExitTimer.unref();

        // Clean shutdown (fast)
        await new Promise((r) => setTimeout(r, 10));
        clearTimeout(forceExitTimer);
      };

      await mockShutdown();
      await new Promise((r) => setTimeout(r, 60));

      expect(forceExitCalled).toBe(false);
    });
  });
});
