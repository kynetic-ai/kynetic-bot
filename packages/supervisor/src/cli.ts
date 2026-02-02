#!/usr/bin/env node
/**
 * Supervisor CLI Entry Point
 *
 * Spawns and manages the kbot process, handles restart requests with
 * checkpoint preservation, and implements graceful shutdown.
 *
 * @see @supervisor
 */

import process from 'node:process';
import { createLogger } from '@kynetic-bot/core';

const log = createLogger('supervisor');
const FORCE_EXIT_TIMEOUT = 30000;

let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

/**
 * Main entry point
 *
 * TODO: Spawn kbot process
 * TODO: Set up IPC communication
 * TODO: Handle restart requests
 */
async function main(): Promise<void> {
  log.info('Supervisor starting...');

  // TODO: Parse CLI args (--checkpoint flag)
  // TODO: Spawn kbot child process
  // TODO: Set up IPC message handlers
  // TODO: Monitor child process health

  log.info('Supervisor is running. Press Ctrl+C to stop.');
}

/**
 * Graceful shutdown handler
 *
 * Stops the child process gracefully before exiting.
 */
async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) {
    if (shutdownPromise) await shutdownPromise;
    return;
  }
  isShuttingDown = true;

  log.info(`Shutdown initiated: ${reason}`);

  const forceExitTimer = setTimeout(() => {
    log.error('Forced exit - shutdown timeout exceeded');
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT);
  forceExitTimer.unref();

  shutdownPromise = (async () => {
    try {
      // TODO: Send SIGTERM to child process
      // TODO: Wait for graceful shutdown
      // TODO: Force kill if timeout

      clearTimeout(forceExitTimer);
      log.info('Shutdown complete');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Shutdown error', { error: error.message });
      throw err;
    }
  })();

  try {
    await shutdownPromise;
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

// Signal handlers
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log.error('Unhandled rejection', { error: error.message });
  void shutdown('unhandledRejection');
});

// Run
main().catch(async (err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  log.error('Startup error', { error: error.message });
  process.exit(1);
});
