/**
 * Restart protocol client for coordinating planned restarts with supervisor
 *
 * @see @restart-protocol
 */

import { createLogger, type Logger } from '@kynetic-bot/core';
import type { PlannedRestartMessage } from '@kynetic-bot/supervisor';

export interface RestartOptions {
  /**
   * Path to the checkpoint file for restart context
   */
  checkpointPath: string;

  /**
   * Timeout in milliseconds to wait for restart acknowledgment (default: 5000)
   * AC: @restart-protocol ac-7
   */
  timeoutMs?: number;

  /**
   * Number of retries after timeout (default: 1)
   * AC: @restart-protocol ac-7
   */
  maxRetries?: number;
}

/**
 * Error thrown when IPC channel is not available
 * AC: @restart-protocol ac-6
 */
export class NoIpcChannelError extends Error {
  constructor() {
    super('IPC channel not available - bot is not supervised');
    this.name = 'NoIpcChannelError';
  }
}

/**
 * Error thrown when restart request is already pending
 * AC: @restart-protocol ac-8
 */
export class RestartPendingError extends Error {
  constructor() {
    super('Restart request already pending');
    this.name = 'RestartPendingError';
  }
}

/**
 * Restart protocol client
 *
 * Manages IPC communication with supervisor for planned restarts.
 * AC: @restart-protocol ac-1 through ac-8
 */
export class RestartProtocol {
  private log: Logger;
  private pendingRestart: Promise<void> | null = null;
  private retryCount = 0;

  constructor() {
    this.log = createLogger('restart-protocol');
  }

  /**
   * Request a planned restart with checkpoint
   *
   * AC: @restart-protocol ac-1, ac-6, ac-7, ac-8
   */
  async requestRestart(options: RestartOptions): Promise<void> {
    // AC: @restart-protocol ac-8
    if (this.pendingRestart) {
      throw new RestartPendingError();
    }

    // AC: @restart-protocol ac-6
    if (!process.send) {
      throw new NoIpcChannelError();
    }

    const timeoutMs = options.timeoutMs ?? 5000;
    const maxRetries = options.maxRetries ?? 1;

    this.pendingRestart = this.performRestart(options.checkpointPath, timeoutMs, maxRetries);

    try {
      await this.pendingRestart;
    } finally {
      this.pendingRestart = null;
      this.retryCount = 0;
    }
  }

  /**
   * Perform restart request with timeout and retry logic
   *
   * AC: @restart-protocol ac-1, ac-7
   */
  private async performRestart(
    checkpointPath: string,
    timeoutMs: number,
    maxRetries: number
  ): Promise<void> {
    const msg: PlannedRestartMessage = {
      type: 'planned_restart',
      checkpoint: checkpointPath,
    };

    this.log.info('Requesting planned restart', {
      checkpoint: checkpointPath,
      timeout: timeoutMs,
    });

    // AC: @restart-protocol ac-1
    const ackReceived = this.waitForAck(timeoutMs);

    if (!process.send) {
      throw new NoIpcChannelError();
    }

    process.send(msg);

    try {
      await ackReceived;
      this.log.info('Restart acknowledged by supervisor');
    } catch (err) {
      // AC: @restart-protocol ac-7
      if (this.retryCount < maxRetries) {
        this.retryCount++;
        this.log.warn('Restart acknowledgment timeout - retrying', {
          attempt: this.retryCount,
          maxRetries,
        });
        return this.performRestart(checkpointPath, timeoutMs, maxRetries);
      }

      this.log.warn('Restart acknowledgment timeout - max retries exceeded', {
        retries: this.retryCount,
      });
      throw err;
    }
  }

  /**
   * Wait for restart acknowledgment with timeout
   *
   * AC: @restart-protocol ac-1, ac-7
   */
  private waitForAck(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Restart acknowledgment timeout'));
      }, timeoutMs);

      const messageHandler = (msg: unknown) => {
        // Type narrowing for IPC message
        if (
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          (msg as { type: string }).type === 'restart_ack'
        ) {
          cleanup();
          resolve();
        }
        // Ignore invalid messages - handled by supervisor
      };

      const cleanup = () => {
        clearTimeout(timeout);
        process.off('message', messageHandler);
      };

      process.on('message', messageHandler);
    });
  }

  /**
   * Check if IPC channel is available
   *
   * AC: @restart-protocol ac-6
   */
  isSupervised(): boolean {
    return !!process.send;
  }

  /**
   * Check if restart is currently pending
   *
   * AC: @restart-protocol ac-8
   */
  isPending(): boolean {
    return this.pendingRestart !== null;
  }
}

/**
 * Global singleton instance
 */
let restartProtocol: RestartProtocol | null = null;

/**
 * Get or create the global restart protocol instance
 */
export function getRestartProtocol(): RestartProtocol {
  if (!restartProtocol) {
    restartProtocol = new RestartProtocol();
  }
  return restartProtocol;
}
