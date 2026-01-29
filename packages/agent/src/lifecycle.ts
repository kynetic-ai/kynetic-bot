/**
 * Agent Lifecycle
 *
 * Manages agent process lifecycle with health monitoring, spawn rate limiting,
 * and graceful shutdown.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLogger } from '@kynetic-bot/core';
import { ACPClient } from './acp/index.js';
import type {
  AgentCheckpoint,
  AgentLifecycleOptions,
  AgentLifecycleState,
  QueuedSpawnRequest,
} from './types.js';

const log = createLogger('agent-lifecycle');

/**
 * Default configuration values
 */
const DEFAULTS = {
  healthCheckInterval: 30000, // 30 seconds
  failureThreshold: 3,
  shutdownTimeout: 10000, // 10 seconds
  maxConcurrentSpawns: 1,
  backoff: {
    initial: 1000, // 1 second
    max: 60000, // 60 seconds
    multiplier: 2,
  },
} as const;

/**
 * AgentLifecycle
 *
 * Spawns, monitors, and manages agent processes using ACP client for communication.
 * Follows the ChannelLifecycle pattern for state machine management.
 */
export class AgentLifecycle extends EventEmitter {
  private state: AgentLifecycleState = 'idle';
  private process: ChildProcess | null = null;
  private acpClient: ACPClient | null = null;
  private sessionId: string | undefined;

  private healthTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private currentBackoffMs: number;

  private spawnQueue: QueuedSpawnRequest[] = [];
  private activeSpawns = 0;

  private readonly options: Required<
    Omit<AgentLifecycleOptions, 'backoff'> & {
      backoff: Required<NonNullable<AgentLifecycleOptions['backoff']>>;
    }
  >;

  constructor(options: AgentLifecycleOptions) {
    super();

    this.options = {
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? {},
      healthCheckInterval:
        options.healthCheckInterval ?? DEFAULTS.healthCheckInterval,
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      shutdownTimeout: options.shutdownTimeout ?? DEFAULTS.shutdownTimeout,
      maxConcurrentSpawns:
        options.maxConcurrentSpawns ?? DEFAULTS.maxConcurrentSpawns,
      backoff: {
        initial: options.backoff?.initial ?? DEFAULTS.backoff.initial,
        max: options.backoff?.max ?? DEFAULTS.backoff.max,
        multiplier: options.backoff?.multiplier ?? DEFAULTS.backoff.multiplier,
      },
    };

    this.currentBackoffMs = this.options.backoff.initial;
  }

  /**
   * Get the current lifecycle state
   */
  getState(): AgentLifecycleState {
    return this.state;
  }

  /**
   * Check if the agent is healthy
   */
  isHealthy(): boolean {
    return this.state === 'healthy';
  }

  /**
   * Get the ACP client for communication with the agent
   */
  getClient(): ACPClient | null {
    return this.acpClient;
  }

  /**
   * Get the current session ID if active
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Spawn the agent process
   *
   * If already spawning or at max concurrent spawns, the request is queued.
   * Environment variables are merged with KYNETIC_* vars.
   *
   * @param env Additional environment variables for this spawn
   */
  async spawn(env?: Record<string, string>): Promise<void> {
    // If we can't spawn right now, queue the request
    if (
      this.activeSpawns >= this.options.maxConcurrentSpawns ||
      this.state === 'spawning'
    ) {
      return new Promise<void>((resolve, reject) => {
        this.spawnQueue.push({ env, resolve, reject });
        const queueLength = this.spawnQueue.length;
        log.warn('Spawn request queued', { queueLength });
        this.emit('spawn:queued', queueLength);
      });
    }

    // Can't spawn from certain states
    if (
      this.state !== 'idle' &&
      this.state !== 'failed' &&
      this.state !== 'unhealthy'
    ) {
      throw new Error(`Cannot spawn from state: ${this.state}`);
    }

    await this.performSpawn(env);
  }

  /**
   * Stop the agent gracefully
   *
   * Sends SIGTERM and waits for shutdown timeout before force-killing.
   */
  async stop(): Promise<void> {
    // Already stopped or stopping
    if (this.state === 'idle' || this.state === 'stopping') {
      return;
    }

    // If spawning, wait for spawn to complete then stop
    if (this.state === 'spawning') {
      // Wait a bit for spawn to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.state === 'spawning') {
        // Still spawning, force kill
        await this.kill();
        return;
      }
    }

    this.transitionState('stopping');
    this.stopHealthMonitoring();

    if (!this.process) {
      this.cleanup();
      this.transitionState('idle');
      this.emit('shutdown:complete');
      return;
    }

    // Close ACP client first (stop accepting new work)
    if (this.acpClient) {
      this.acpClient.close();
    }

    // Send SIGTERM for graceful shutdown
    this.process.kill('SIGTERM');

    // Wait for process to exit or timeout
    let timeoutId: NodeJS.Timeout | null = null;

    const exitPromise = new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      // Check if already dead BEFORE adding listener (avoids TOCTOU race)
      if (this.process.exitCode !== null || this.process.signalCode !== null) {
        resolve();
        return;
      }

      this.process.once('exit', () => resolve());
    });

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), this.options.shutdownTimeout);
    });

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    if (result === 'timeout') {
      log.warn('Graceful shutdown timeout, force killing', {
        timeout: this.options.shutdownTimeout,
      });
      await this.kill();
    } else {
      // Emit shutdown:complete BEFORE cleanup (which removes listeners)
      this.transitionState('idle');
      this.emit('shutdown:complete');
      this.cleanup();
    }
  }

  /**
   * Force kill the agent process
   */
  async kill(): Promise<void> {
    if (!this.process) {
      this.cleanup();
      if (this.state !== 'idle') {
        this.transitionState('idle');
      }
      return;
    }

    this.transitionState('terminating');
    this.stopHealthMonitoring();

    // Close ACP client
    if (this.acpClient) {
      this.acpClient.close();
    }

    // Force kill
    this.process.kill('SIGKILL');

    // Wait for exit
    await new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      // Check if already dead BEFORE adding listener (avoids TOCTOU race)
      if (this.process.exitCode !== null || this.process.signalCode !== null) {
        resolve();
        return;
      }

      this.process.once('exit', () => resolve());
    });

    // Emit shutdown:complete BEFORE cleanup (which removes listeners)
    this.transitionState('idle');
    this.emit('shutdown:complete');
    this.cleanup();
  }

  /**
   * Create a checkpoint of current state
   */
  getCheckpoint(): AgentCheckpoint {
    const checkpoint: AgentCheckpoint = {
      timestamp: Date.now(),
      state: this.state,
      sessionId: this.sessionId,
      consecutiveFailures: this.consecutiveFailures,
      currentBackoffMs: this.currentBackoffMs,
    };

    this.emit('checkpoint:saved', checkpoint);
    return checkpoint;
  }

  /**
   * Restore from a checkpoint
   *
   * Note: This only restores state metadata. The actual process
   * must be re-spawned separately.
   *
   * @returns true if restoration succeeded, false if not in idle state
   */
  restoreFromCheckpoint(checkpoint: AgentCheckpoint): boolean {
    // Only restore if in idle state
    if (this.state !== 'idle') {
      log.warn('Cannot restore checkpoint, not in idle state', {
        currentState: this.state,
      });
      return false;
    }

    this.consecutiveFailures = checkpoint.consecutiveFailures;
    this.currentBackoffMs = checkpoint.currentBackoffMs;
    this.sessionId = checkpoint.sessionId;

    log.info('Restored from checkpoint', {
      timestamp: checkpoint.timestamp,
      savedState: checkpoint.state,
      consecutiveFailures: checkpoint.consecutiveFailures,
    });
    return true;
  }

  /**
   * Perform the actual spawn operation
   */
  private async performSpawn(env?: Record<string, string>): Promise<void> {
    this.activeSpawns++;
    this.transitionState('spawning');

    try {
      // Build environment with KYNETIC_* vars
      const kyneticEnv: Record<string, string> = {
        KYNETIC_AGENT: 'true',
        KYNETIC_SESSION_ID: this.sessionId ?? '',
      };

      const mergedEnv = {
        ...process.env,
        ...kyneticEnv,
        ...this.options.env,
        ...env, // Custom env overrides KYNETIC_*
      };

      // Create pass-through streams for stdio
      const stdinStream = new PassThrough();
      const stdoutStream = new PassThrough();

      // Spawn the process
      log.info('Spawning agent process', {
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.cwd,
      });

      this.process = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: mergedEnv as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      // Wire up stdio streams
      if (this.process.stdin) {
        stdinStream.pipe(this.process.stdin);
      }
      if (this.process.stdout) {
        this.process.stdout.pipe(stdoutStream);
      }

      // Handle early exit during spawn
      const earlyExitPromise = new Promise<'exited'>((resolve) => {
        this.process?.once('exit', () => resolve('exited'));
      });

      // Set up exit handler
      this.process.on('exit', (code, signal) => {
        this.handleProcessExit(code, signal);
      });

      this.process.on('error', (err) => {
        this.handleProcessError(err);
      });

      // Create ACP client with the process streams
      this.acpClient = new ACPClient({
        stdin: stdoutStream, // Agent's stdout is our stdin
        stdout: stdinStream, // Our stdout is agent's stdin
        clientInfo: {
          name: 'kynetic-bot',
          version: '0.0.0',
        },
      });

      // Wire up ACP events
      this.acpClient.on('close', () => {
        log.debug('ACP client closed');
      });

      this.acpClient.on('error', (err: Error) => {
        this.emitError(err, { source: 'acp-client' });
      });

      // Initialize the agent - race with early exit
      const initPromise = this.acpClient.initialize();
      const result = await Promise.race([initPromise, earlyExitPromise]);

      if (result === 'exited') {
        throw new Error('Agent process exited during initialization');
      }

      // Success!
      this.transitionState('healthy');
      this.consecutiveFailures = 0;
      this.currentBackoffMs = this.options.backoff.initial;

      const pid = this.process.pid;
      if (pid === undefined) {
        throw new Error('Process spawned but PID is undefined');
      }
      log.info('Agent spawned successfully', { pid });
      this.emit('agent:spawned', pid);

      // Start health monitoring
      this.startHealthMonitoring();

      // Process queued spawn requests
      this.processSpawnQueue();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error('Spawn failed', { error: error.message });
      this.emitError(error, { phase: 'spawn' });

      // Clean up failed spawn
      if (this.process) {
        this.process.kill('SIGKILL');
        this.process = null;
      }
      if (this.acpClient) {
        this.acpClient.close();
        this.acpClient = null;
      }

      this.transitionState('failed');

      // Apply backoff
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * this.options.backoff.multiplier,
        this.options.backoff.max,
      );

      // Reject queued spawns on failure
      this.rejectSpawnQueue(error);

      throw error;
    } finally {
      this.activeSpawns--;
    }
  }

  /**
   * Process queued spawn requests
   */
  private processSpawnQueue(): void {
    while (
      this.spawnQueue.length > 0 &&
      this.activeSpawns < this.options.maxConcurrentSpawns
    ) {
      const request = this.spawnQueue.shift()!;
      const queueLength = this.spawnQueue.length;

      log.info('Processing queued spawn request', { queueLength });
      this.emit('spawn:dequeued', queueLength);

      // Note: We don't await here since we want to continue processing
      this.performSpawn(request.env)
        .then(() => request.resolve())
        .catch((err: Error) => request.reject(err));
    }
  }

  /**
   * Reject all queued spawn requests
   */
  private rejectSpawnQueue(error: Error): void {
    for (const request of this.spawnQueue) {
      request.reject(error);
    }
    this.spawnQueue = [];
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    if (this.healthTimer) {
      return;
    }

    this.healthTimer = setInterval(() => {
      void this.performHealthCheck();
    }, this.options.healthCheckInterval);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Perform a health check
   *
   * Health is determined by:
   * 1. Process is alive (exitCode is null)
   * 2. ACP client has a valid session
   */
  private async performHealthCheck(): Promise<void> {
    if (this.state !== 'healthy' && this.state !== 'unhealthy') {
      return;
    }

    let passed = false;

    try {
      // Check 1: Process is alive
      if (!this.process || this.process.exitCode !== null) {
        throw new Error('Process is not running');
      }

      // Check 2: ACP client exists and has sessions
      // Note: ACP doesn't have a dedicated ping, so we check if client exists
      // and is not closed. The session state check acts as a liveness proxy.
      if (!this.acpClient) {
        throw new Error('ACP client not available');
      }

      // If we have a session, verify it still exists
      if (this.sessionId) {
        const session = this.acpClient.getSession(this.sessionId);
        if (!session) {
          throw new Error(`Session ${this.sessionId} no longer exists`);
        }
      }

      passed = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.debug('Health check failed', { error: error.message });
      passed = false;
    }

    // Update failure count
    if (passed) {
      const wasUnhealthy = this.state === 'unhealthy';

      if (this.consecutiveFailures > 0) {
        log.info('Health check passed, recovering', {
          previousFailures: this.consecutiveFailures,
        });
        this.consecutiveFailures = 0;
      }

      if (wasUnhealthy) {
        this.transitionState('healthy');
        this.emit('health:status', true, true);
      }

      this.emit('health:check', true, this.consecutiveFailures);
    } else {
      this.consecutiveFailures++;
      this.emit('health:check', false, this.consecutiveFailures);

      log.warn('Health check failed', {
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.options.failureThreshold,
      });

      // Check if we've exceeded the failure threshold
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        if (this.state !== 'unhealthy') {
          this.transitionState('unhealthy');
          this.emit('health:status', false, false);
        }

        // Terminate and respawn
        log.warn('Failure threshold exceeded, restarting agent');
        await this.restartUnhealthyAgent();
      }
    }
  }

  /**
   * Restart an unhealthy agent
   */
  private async restartUnhealthyAgent(): Promise<void> {
    // Stop current process
    await this.kill();

    // Wait for backoff
    log.info('Waiting for backoff before respawn', {
      backoffMs: this.currentBackoffMs,
    });
    await new Promise((resolve) =>
      setTimeout(resolve, this.currentBackoffMs),
    );

    // Try to respawn
    try {
      await this.performSpawn();
    } catch {
      // Check if we should escalate
      if (this.currentBackoffMs >= this.options.backoff.max) {
        log.error('Max backoff reached, escalating');
        this.emit('escalate', 'Max backoff reached after repeated spawn failures', {
          backoffMs: this.currentBackoffMs,
          consecutiveFailures: this.consecutiveFailures,
        });
      }
    }
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    log.info('Agent process exited', { code, signal });
    this.emit('agent:exited', code, signal);

    // Don't trigger respawn during intentional shutdown
    if (this.state === 'stopping' || this.state === 'terminating') {
      return;
    }

    // If we were healthy, this is unexpected - mark as unhealthy
    if (this.state === 'healthy' || this.state === 'unhealthy') {
      this.transitionState('unhealthy');

      // Trigger respawn
      void this.restartUnhealthyAgent();
    }
  }

  /**
   * Handle process error
   */
  private handleProcessError(err: Error): void {
    log.error('Agent process error', { error: err.message });
    this.emitError(err, { source: 'process' });
  }

  /**
   * Transition to a new state
   */
  private transitionState(newState: AgentLifecycleState): void {
    const oldState = this.state;
    if (oldState === newState) {
      return;
    }

    log.debug('State transition', { from: oldState, to: newState });
    this.state = newState;
    this.emit('state:change', oldState, newState);
  }

  /**
   * Emit an error event with context
   */
  private emitError(error: Error, context: Record<string, unknown>): void {
    this.emit('error', error, {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...context,
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    // Clear timers
    this.stopHealthMonitoring();

    // Remove ACP client listeners before nulling to prevent accumulation
    if (this.acpClient) {
      this.acpClient.removeAllListeners();
      this.acpClient.close();
    }

    // Clear references
    this.process = null;
    this.acpClient = null;
    this.sessionId = undefined;

    // Don't remove user-attached listeners - instance remains usable
  }
}
