/**
 * Supervisor - Process lifecycle manager for kbot
 *
 * Spawns kbot as a child process with IPC channel, handles signals,
 * manages respawn with exponential backoff, and coordinates graceful shutdown.
 *
 * @see @supervisor-process-spawn
 */

import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createLogger, type Logger } from '@kynetic-bot/core';
import {
  IpcMessageSchema,
  type IpcMessage,
  type Checkpoint,
  type RestartReason,
} from './schemas.js';

export interface SupervisorConfig {
  /**
   * Path to the child process executable (e.g., kbot)
   */
  childPath: string;

  /**
   * Arguments to pass to the child process
   */
  childArgs?: string[];

  /**
   * Initial checkpoint path (for wake-up after restart)
   */
  checkpointPath?: string;

  /**
   * Minimum backoff delay in milliseconds (default: 1000)
   */
  minBackoffMs?: number;

  /**
   * Maximum backoff delay in milliseconds (default: 60000)
   */
  maxBackoffMs?: number;

  /**
   * Graceful shutdown timeout in milliseconds (default: 30000)
   */
  shutdownTimeoutMs?: number;
}

export interface SupervisorEvents {
  /**
   * Emitted when child process is spawned
   * AC: @supervisor-process-spawn ac-6
   */
  spawn: (pid: number) => void;

  /**
   * Emitted when child process exits
   */
  exit: (code: number | null, signal: string | null) => void;

  /**
   * Emitted when respawning after crash
   * AC: @supervisor-process-spawn ac-4
   */
  respawn: (attempt: number, backoffMs: number) => void;

  /**
   * Emitted when backoff reaches maximum
   * AC: @supervisor-process-spawn ac-5
   */
  escalation: (consecutiveFailures: number) => void;

  /**
   * Emitted when IPC channel setup fails
   * AC: @supervisor-process-spawn ac-7
   */
  ipc_error: (error: Error) => void;

  /**
   * Emitted when shutdown completes
   */
  shutdown: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface Supervisor {
  on<E extends keyof SupervisorEvents>(event: E, listener: SupervisorEvents[E]): this;
  emit<E extends keyof SupervisorEvents>(
    event: E,
    ...args: Parameters<SupervisorEvents[E]>
  ): boolean;
}

/**
 * Supervisor manages the kbot process lifecycle
 *
 * AC: @supervisor-process-spawn ac-1 through ac-9
 * AC: @trait-observable ac-1, ac-2, ac-3
 * AC: @trait-graceful-shutdown ac-1, ac-2, ac-3
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Supervisor extends EventEmitter {
  private log: Logger;
  private config: Required<SupervisorConfig>;
  private child: ChildProcess | null = null;
  private isShuttingDown = false;
  private currentBackoffMs: number;
  private consecutiveFailures = 0;
  private lastSpawnTime: number | null = null;
  private pendingCheckpointPath: string | null = null;

  constructor(config: SupervisorConfig) {
    super();
    this.log = createLogger('supervisor');

    // Apply defaults
    this.config = {
      childPath: config.childPath,
      childArgs: config.childArgs ?? [],
      checkpointPath: config.checkpointPath ?? '',
      minBackoffMs: config.minBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 60000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 30000,
    };

    this.currentBackoffMs = this.config.minBackoffMs;

    this.log.info('Supervisor initialized', {
      childPath: this.config.childPath,
      checkpointPath: this.config.checkpointPath || '(none)',
    });
  }

  /**
   * Spawn the child process with IPC channel
   *
   * AC: @supervisor-process-spawn ac-1, ac-6
   */
  async spawn(): Promise<void> {
    if (this.isShuttingDown) {
      this.log.warn('Cannot spawn during shutdown');
      return;
    }

    if (this.child) {
      this.log.warn('Child process already running', { pid: this.child.pid });
      return;
    }

    try {
      this.lastSpawnTime = Date.now();

      // Build args - include checkpoint if available
      const args = [...this.config.childArgs];
      if (this.config.checkpointPath) {
        args.push('--checkpoint', this.config.checkpointPath);
      }

      // Spawn with IPC channel
      this.log.info('Spawning child process', {
        childPath: this.config.childPath,
        args,
      });

      // AC: @supervisor-env ac-1, ac-2, ac-4
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KBOT_SUPERVISED: '1',
        KBOT_SUPERVISOR_PID: process.pid.toString(),
      };

      // AC: @supervisor-env ac-4
      if (this.config.checkpointPath) {
        env.KBOT_CHECKPOINT_PATH = this.config.checkpointPath;
      }

      this.child = fork(this.config.childPath, args, {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env,
      });

      if (!this.child.pid) {
        throw new Error('Failed to spawn child process - no PID');
      }

      // AC: @supervisor-process-spawn ac-6
      this.log.info('Child process spawned', { pid: this.child.pid });
      this.emit('spawn', this.child.pid);

      // Set up IPC handlers
      this.setupIpcHandlers();

      // Set up exit handler
      this.child.on('exit', (code, signal) => {
        void this.handleChildExit(code, signal);
      });

      // Note: Don't reset backoff/failures here - only reset on clean exit (code 0)
      // or after child runs successfully for a while
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // AC: @supervisor-process-spawn ac-7
      this.log.error('Failed to spawn child process', {
        error: error.message,
        stack: error.stack,
      });

      this.emit('ipc_error', error);
      this.child = null;

      // Schedule respawn if not shutting down
      if (!this.isShuttingDown) {
        await this.scheduleRespawn();
      }
    }
  }

  /**
   * Set up IPC message handlers
   *
   * AC: @supervisor-process-spawn ac-6
   */
  private setupIpcHandlers(): void {
    if (!this.child) return;

    this.child.on('message', (msg: unknown) => {
      try {
        this.handleIpcMessage(msg as IpcMessage);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('IPC message handling error', {
          error: error.message,
          message: msg,
        });
        this.emit('ipc_error', error);
      }
    });

    this.child.on('error', (err) => {
      this.log.error('Child process error', {
        error: err.message,
        pid: this.child?.pid,
      });
      this.emit('ipc_error', err);
    });
  }

  /**
   * Handle IPC messages from child process
   *
   * AC: @restart-protocol ac-2, ac-5
   */
  private handleIpcMessage(msg: IpcMessage): void {
    // AC: @restart-protocol ac-5
    // Validate message format
    const parseResult = IpcMessageSchema.safeParse(msg);
    if (!parseResult.success) {
      this.log.warn('Invalid IPC message received - ignoring', {
        message: msg,
        error: parseResult.error.message,
      });
      return;
    }

    const validMsg = parseResult.data;
    this.log.debug('IPC message received', { type: validMsg.type });

    switch (validMsg.type) {
      case 'planned_restart': {
        // AC: @restart-protocol ac-1, ac-2
        void this.handlePlannedRestart(validMsg.checkpoint);
        break;
      }

      case 'error': {
        this.log.error('IPC error message', { message: validMsg.message });
        break;
      }

      default:
        this.log.warn('Unknown IPC message type', { msg: validMsg });
    }
  }

  /**
   * Handle planned restart request
   *
   * AC: @restart-protocol ac-1, ac-2
   */
  private async handlePlannedRestart(checkpointPath: string): Promise<void> {
    this.log.info('Planned restart requested', { checkpoint: checkpointPath });

    // AC: @restart-protocol ac-2
    // Verify checkpoint file exists before acknowledging
    try {
      await access(checkpointPath, constants.R_OK);
      this.log.info('Checkpoint file verified', { path: checkpointPath });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Checkpoint file not accessible - rejecting restart', {
        path: checkpointPath,
        error: error.message,
      });

      // Send error response
      if (this.child) {
        this.child.send({
          type: 'error',
          message: `Checkpoint file not accessible: ${checkpointPath}`,
        });
      }
      return;
    }

    // Store pending checkpoint
    this.pendingCheckpointPath = checkpointPath;

    // AC: @restart-protocol ac-1
    // Send acknowledgment
    if (this.child) {
      this.child.send({ type: 'restart_ack' });
      this.log.info('Restart acknowledged - waiting for child to exit');
    }
  }

  /**
   * Handle child process exit
   *
   * AC: @supervisor-process-spawn ac-3, ac-4, ac-9
   */
  private async handleChildExit(code: number | null, signal: string | null): Promise<void> {
    const pid = this.child?.pid;
    this.child = null;

    this.log.info('Child process exited', { pid, code, signal });
    this.emit('exit', code, signal);

    if (this.isShuttingDown) {
      this.log.info('Exit during shutdown - not respawning');
      return;
    }

    // AC: @supervisor-process-spawn ac-3
    if (code === 0) {
      this.log.info('Clean exit (code 0) - supervisor exiting');
      // Reset failure tracking on clean exit
      this.currentBackoffMs = this.config.minBackoffMs;
      this.consecutiveFailures = 0;
      this.emit('shutdown');
      process.exit(0);
      return;
    }

    // AC: @supervisor-process-spawn ac-4, ac-9
    this.log.warn('Unexpected exit - will respawn', { code, signal });

    // AC: @supervisor-process-spawn ac-9
    // Create crash checkpoint if we don't have a pending checkpoint
    if (!this.pendingCheckpointPath) {
      await this.createCrashCheckpoint();
    }

    await this.scheduleRespawn();
  }

  /**
   * Create crash checkpoint with last known state
   *
   * AC: @supervisor-process-spawn ac-9
   */
  private async createCrashCheckpoint(): Promise<void> {
    try {
      const checkpointPath = `/tmp/crash-${Date.now()}.json`;
      const checkpoint: Checkpoint = {
        version: 1,
        session_id: this.generateSessionId(),
        restart_reason: 'crash' as RestartReason,
        wake_context: {
          prompt: 'The bot crashed unexpectedly. Resume from last known state.',
        },
        created_at: new Date().toISOString(),
      };

      await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));

      this.log.info('Created crash checkpoint', { path: checkpointPath });
      this.config.checkpointPath = checkpointPath;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Failed to create crash checkpoint', {
        error: error.message,
      });
    }
  }

  /**
   * Schedule respawn with exponential backoff
   *
   * AC: @supervisor-process-spawn ac-4, ac-5
   */
  private async scheduleRespawn(): Promise<void> {
    this.consecutiveFailures++;

    // Check if we need to use the pending checkpoint
    if (this.pendingCheckpointPath) {
      this.config.checkpointPath = this.pendingCheckpointPath;
      this.pendingCheckpointPath = null;
    }

    // AC: @supervisor-process-spawn ac-5
    if (this.currentBackoffMs >= this.config.maxBackoffMs) {
      this.log.error('Backoff at maximum', {
        consecutiveFailures: this.consecutiveFailures,
        backoffMs: this.currentBackoffMs,
      });
      this.emit('escalation', this.consecutiveFailures);
    }

    this.log.info('Scheduling respawn', {
      backoffMs: this.currentBackoffMs,
      attempt: this.consecutiveFailures,
    });

    this.emit('respawn', this.consecutiveFailures, this.currentBackoffMs);

    await new Promise((resolve) => setTimeout(resolve, this.currentBackoffMs));

    // Exponential backoff
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.config.maxBackoffMs);

    await this.spawn();
  }

  /**
   * Graceful shutdown
   *
   * AC: @supervisor-process-spawn ac-2
   * AC: @trait-graceful-shutdown ac-1, ac-2, ac-3
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.log.warn('Shutdown already in progress');
      return;
    }

    this.isShuttingDown = true;
    this.log.info('Initiating graceful shutdown');

    if (!this.child) {
      this.log.info('No child process to shut down');
      this.emit('shutdown');
      return;
    }

    try {
      const pid = this.child.pid;

      // AC: @supervisor-process-spawn ac-2
      this.log.info('Sending SIGTERM to child process', { pid });
      this.child.kill('SIGTERM');

      // Wait for graceful exit with timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          if (!this.child) {
            resolve();
            return;
          }
          this.child.once('exit', () => resolve());
        }),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            this.log.warn('Graceful shutdown timeout - forcing SIGKILL');
            if (this.child) {
              this.child.kill('SIGKILL');
            }
            resolve();
          }, this.config.shutdownTimeoutMs)
        ),
      ]);

      this.log.info('Shutdown complete');
      this.emit('shutdown');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Shutdown error', { error: error.message });
      throw err;
    }
  }

  /**
   * Generate a session ID (ULID-compatible)
   */
  private generateSessionId(): string {
    // Simple ULID-like ID generator (timestamp + random)
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 15).toUpperCase();
    return `${timestamp}${random}`.padEnd(26, '0').substring(0, 26);
  }

  /**
   * Get current child process PID
   */
  getPid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * Check if supervisor is shutting down
   */
  isShutdown(): boolean {
    return this.isShuttingDown;
  }
}
