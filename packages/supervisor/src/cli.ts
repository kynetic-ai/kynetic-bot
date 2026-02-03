#!/usr/bin/env node
/**
 * Supervisor CLI Entry Point
 *
 * Spawns and manages the kbot process, handles restart requests with
 * checkpoint preservation, and implements graceful shutdown.
 *
 * @see @supervisor
 * AC: @wake-injection ac-1
 */

import process from 'node:process';
import { createLogger } from '@kynetic-bot/core';
import { Supervisor } from './supervisor.js';

const log = createLogger('supervisor:cli');
const DEFAULT_SHUTDOWN_TIMEOUT = 30000;

/**
 * Parse SHUTDOWN_TIMEOUT from environment variable
 * Returns the timeout in milliseconds, or the default if not set or invalid
 */
function getShutdownTimeout(): number {
  const envValue = process.env.SHUTDOWN_TIMEOUT;
  if (!envValue) return DEFAULT_SHUTDOWN_TIMEOUT;

  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed) || String(parsed) !== envValue.trim()) {
    log.warn(
      `Invalid SHUTDOWN_TIMEOUT value "${envValue}", using default ${DEFAULT_SHUTDOWN_TIMEOUT}ms`
    );
    return DEFAULT_SHUTDOWN_TIMEOUT;
  }
  if (parsed <= 0) {
    log.warn(`SHUTDOWN_TIMEOUT must be positive, using default ${DEFAULT_SHUTDOWN_TIMEOUT}ms`);
    return DEFAULT_SHUTDOWN_TIMEOUT;
  }
  return parsed;
}

let supervisor: Supervisor | null = null;
let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let forceExitTimeout = DEFAULT_SHUTDOWN_TIMEOUT;

/**
 * Parse CLI arguments
 */
function parseArgs(): { checkpointPath?: string; childPath: string } {
  const args = process.argv.slice(2);
  let checkpointPath: string | undefined;
  let childPath = 'kbot'; // Default child process name

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // AC: @wake-injection ac-1
    if (arg === '--checkpoint' && args[i + 1]) {
      checkpointPath = args[i + 1];
      i++; // Skip next arg
    } else if (arg === '--child' && args[i + 1]) {
      childPath = args[i + 1];
      i++;
    }
  }

  return { checkpointPath, childPath };
}

/**
 * Main entry point
 *
 * Spawns kbot process and monitors its lifecycle.
 */
async function main(): Promise<void> {
  log.info('Supervisor starting...');

  const { checkpointPath, childPath } = parseArgs();
  const shutdownTimeoutMs = getShutdownTimeout();

  // Force exit timer should be longer than shutdown timeout to allow graceful shutdown
  forceExitTimeout = Math.max(shutdownTimeoutMs + 5000, DEFAULT_SHUTDOWN_TIMEOUT);

  log.info('Configuration', {
    childPath,
    checkpointPath: checkpointPath ?? '(none)',
    shutdownTimeoutMs,
  });

  // Create supervisor
  supervisor = new Supervisor({
    childPath,
    checkpointPath,
    minBackoffMs: 1000,
    maxBackoffMs: 60000,
    shutdownTimeoutMs,
  });

  // Set up event logging
  supervisor.on('spawn', (pid) => {
    log.info('Child process spawned', { pid });
  });

  supervisor.on('exit', (code, signal) => {
    log.info('Child process exited', { code, signal });
  });

  supervisor.on('respawn', (attempt, backoffMs) => {
    log.warn('Respawning child process', { attempt, backoffMs });
  });

  supervisor.on('escalation', (failures) => {
    log.error('Respawn escalation - consecutive failures reached maximum', {
      failures,
    });
  });

  supervisor.on('ipc_error', (error) => {
    log.error('IPC communication error', { error: error.message });
  });

  supervisor.on('shutdown', () => {
    log.info('Supervisor shutdown complete');
  });

  // Spawn initial child process
  await supervisor.spawn();

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
  }, forceExitTimeout);
  forceExitTimer.unref();

  shutdownPromise = (async () => {
    try {
      if (supervisor) {
        await supervisor.shutdown();
      }

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
