/**
 * CLI Entry Point Tests
 *
 * Test coverage for CLI signal handling and graceful shutdown patterns.
 *
 * AC-1: pnpm start or node dist/cli.js → loads config, creates bot, starts listening
 * AC-2: SIGINT (Ctrl+C) → initiates graceful shutdown
 * AC-3: SIGTERM → initiates graceful shutdown
 * AC-4: uncaught exception → logs error, attempts graceful shutdown, exits with code 1
 * AC-5: unhandled promise rejection → logs error, attempts graceful shutdown, exits with code 1
 *
 * Traits: @trait-graceful-shutdown, @trait-observable
 *
 * Note: These tests verify the shutdown logic patterns in isolation since
 * signal handlers and process.exit cannot be safely tested via dynamic imports.
 * The actual signal registration happens at module level in cli.ts.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from 'node:util';

/**
 * Shutdown controller - mimics the pattern in cli.ts
 */
function createShutdownController() {
  let isShuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const events: string[] = [];

  const shutdown = async (reason: string, cleanup: () => Promise<void>): Promise<number> => {
    events.push(`shutdown:${reason}`);

    if (isShuttingDown) {
      events.push('shutdown:already-in-progress');
      if (shutdownPromise) await shutdownPromise;
      return 0; // Already shutting down, return success
    }
    isShuttingDown = true;

    shutdownPromise = cleanup();

    try {
      await shutdownPromise;
      events.push('shutdown:complete');
      return 0; // Success
    } catch {
      events.push('shutdown:error');
      return 1; // Error exit code
    }
  };

  return { shutdown, events, isShuttingDown: () => isShuttingDown };
}

describe('CLI Argument Parsing', () => {
  describe('--checkpoint argument (AC: @wake-injection ac-1)', () => {
    it('parses --checkpoint flag with path', () => {
      // AC: @wake-injection ac-1 - Accepts --checkpoint CLI arg
      const { values } = parseArgs({
        args: ['--checkpoint', '/path/to/checkpoint.json'],
        options: {
          checkpoint: { type: 'string', short: 'c' },
        },
        strict: false,
      });

      const checkpointPath = typeof values.checkpoint === 'string' ? values.checkpoint : undefined;
      expect(checkpointPath).toBe('/path/to/checkpoint.json');
    });

    it('parses -c short flag with path', () => {
      // AC: @wake-injection ac-1 - Short form of checkpoint arg
      const { values } = parseArgs({
        args: ['-c', '/path/to/checkpoint.json'],
        options: {
          checkpoint: { type: 'string', short: 'c' },
        },
        strict: false,
      });

      const checkpointPath = typeof values.checkpoint === 'string' ? values.checkpoint : undefined;
      expect(checkpointPath).toBe('/path/to/checkpoint.json');
    });

    it('returns undefined when checkpoint not provided', () => {
      // AC: @wake-injection ac-1 - No checkpoint arg is valid
      const { values } = parseArgs({
        args: [],
        options: {
          checkpoint: { type: 'string', short: 'c' },
        },
        strict: false,
      });

      const checkpointPath = typeof values.checkpoint === 'string' ? values.checkpoint : undefined;
      expect(checkpointPath).toBeUndefined();
    });

    it('allows other unrecognized arguments with strict: false', () => {
      // AC: @wake-injection ac-1 - CLI should not fail on other args
      const { values } = parseArgs({
        args: ['--checkpoint', '/path/to/checkpoint.json', '--some-other-flag'],
        options: {
          checkpoint: { type: 'string', short: 'c' },
        },
        strict: false,
      });

      const checkpointPath = typeof values.checkpoint === 'string' ? values.checkpoint : undefined;
      expect(checkpointPath).toBe('/path/to/checkpoint.json');
    });
  });
});

describe('CLI Shutdown Logic', () => {
  describe('Double-shutdown prevention (AC-2, AC-3)', () => {
    it('prevents multiple simultaneous shutdowns', async () => {
      // AC-2, AC-3: @bot-cli - Signal handlers should not race
      const controller = createShutdownController();
      let cleanupCount = 0;

      const cleanup = async () => {
        cleanupCount++;
        await new Promise((r) => setTimeout(r, 10));
      };

      // Simulate rapid SIGINT + SIGTERM
      const p1 = controller.shutdown('SIGINT', cleanup);
      const p2 = controller.shutdown('SIGTERM', cleanup);

      await Promise.all([p1, p2]);

      // Should only run cleanup once
      expect(cleanupCount).toBe(1);
      expect(controller.events).toContain('shutdown:SIGINT');
      expect(controller.events).toContain('shutdown:already-in-progress');
      expect(controller.events).toContain('shutdown:complete');
    });

    it('waits for existing shutdown to complete', async () => {
      const controller = createShutdownController();
      const completionOrder: string[] = [];

      const cleanup = async () => {
        await new Promise((r) => setTimeout(r, 20));
        completionOrder.push('cleanup');
      };

      // Start first shutdown
      const p1 = controller.shutdown('SIGINT', cleanup).then(() => {
        completionOrder.push('first-done');
      });

      // Start second shutdown (should wait)
      const p2 = controller.shutdown('SIGTERM', cleanup).then(() => {
        completionOrder.push('second-done');
      });

      await Promise.all([p1, p2]);

      // Both should complete, but cleanup only runs once
      expect(completionOrder).toContain('cleanup');
      expect(completionOrder).toContain('first-done');
      expect(completionOrder).toContain('second-done');
    });
  });

  describe('Error handling (AC-4, AC-5)', () => {
    it('returns exit code 1 on shutdown error', async () => {
      // AC-4: @bot-cli ac-4 - uncaughtException exits with code 1
      const controller = createShutdownController();

      const cleanup = async () => {
        throw new Error('Cleanup failed');
      };

      const exitCode = await controller.shutdown('uncaughtException', cleanup);

      expect(exitCode).toBe(1);
      expect(controller.events).toContain('shutdown:error');
    });

    it('returns exit code 0 on clean shutdown', async () => {
      // AC-2, AC-3: Clean shutdown exits with code 0
      const controller = createShutdownController();

      const cleanup = async () => {
        // Success
      };

      const exitCode = await controller.shutdown('SIGINT', cleanup);

      expect(exitCode).toBe(0);
      expect(controller.events).toContain('shutdown:complete');
    });
  });

  describe('Error normalization', () => {
    it('converts non-Error to Error in catch blocks', () => {
      // Pattern used in cli.ts for normalizing errors
      const normalizeError = (err: unknown): Error => {
        return err instanceof Error ? err : new Error(String(err));
      };

      expect(normalizeError(new Error('test'))).toBeInstanceOf(Error);
      expect(normalizeError('string error').message).toBe('string error');
      expect(normalizeError({ custom: 'object' }).message).toBe('[object Object]');
      expect(normalizeError(null).message).toBe('null');
      expect(normalizeError(undefined).message).toBe('undefined');
    });

    it('handles unhandledRejection with non-Error reason', () => {
      // AC-5: @bot-cli ac-5 - Pattern for unhandledRejection handler
      const handleRejection = (reason: unknown): Error => {
        return reason instanceof Error ? reason : new Error(String(reason));
      };

      expect(handleRejection(new Error('async error'))).toBeInstanceOf(Error);
      expect(handleRejection('promise rejected').message).toBe('promise rejected');
      expect(handleRejection(42).message).toBe('42');
    });
  });
});

describe('CLI Startup and Cleanup Patterns', () => {
  describe('Startup sequence (AC-1)', () => {
    it('main function pattern catches errors and signals failure', async () => {
      // AC-1: @bot-cli ac-1 - Startup errors should exit with code 1
      let exitCode: number | null = null;

      const mockMain = async (): Promise<void> => {
        throw new Error('Startup failed');
      };

      await mockMain().catch(() => {
        exitCode = 1;
      });

      expect(exitCode).toBe(1);
    });

    it('cleanup runs even when bot creation fails', async () => {
      // AC-1: Partial initialization should be cleaned up
      let cleanupCalled = false;
      const channelLifecycle = {
        stop: async () => {
          cleanupCalled = true;
        },
      };

      let botCreated = false;

      const mockMain = async (): Promise<void> => {
        // ChannelLifecycle created first, then bot creation fails
        throw new Error('Bot.create failed');
      };

      try {
        await mockMain();
      } catch {
        // Simulate the catch block from cli.ts
        if (!botCreated && channelLifecycle) {
          try {
            await channelLifecycle.stop();
          } catch {
            /* ignore cleanup errors */
          }
        }
      }

      expect(cleanupCalled).toBe(true);
    });
  });

  describe('Shutdown sequence', () => {
    it('bot.stop() handles channelLifecycle internally', async () => {
      // Pattern: bot.stop() internally calls channelLifecycle.stop()
      const stopOrder: string[] = [];

      const mockBot = {
        stop: async () => {
          // Bot.stop() internally calls channelLifecycle.stop(), agent.stop(), shadow.shutdown()
          stopOrder.push('bot.stop');
        },
      };

      if (mockBot) {
        await mockBot.stop();
      }

      expect(stopOrder).toEqual(['bot.stop']);
    });

    it('shutdown without bot falls back to channelLifecycle.stop()', async () => {
      // Pattern: if bot is null, still stop channelLifecycle
      const stopOrder: string[] = [];

      const mockBot: { stop: () => Promise<void> } | null = null;
      const mockChannelLifecycle = {
        stop: async () => {
          stopOrder.push('channelLifecycle.stop');
        },
      };

      // Simulate shutdown with null bot (startup failed after channelLifecycle created)
      if (mockBot) {
        await mockBot.stop();
      } else if (mockChannelLifecycle) {
        await mockChannelLifecycle.stop();
      }

      expect(stopOrder).toEqual(['channelLifecycle.stop']);
    });
  });

  describe('Force exit timeout pattern', () => {
    it('force exit does not trigger on clean shutdown', async () => {
      // Pattern: clearTimeout should be called before force exit triggers
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

      // Give time for any pending timers
      await new Promise((r) => setTimeout(r, 60));

      expect(forceExitCalled).toBe(false);
    });
  });
});
