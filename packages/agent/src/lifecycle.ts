/**
 * Agent Lifecycle
 *
 * Manages agent process lifecycle with health monitoring, spawn rate limiting,
 * and graceful shutdown.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { ulid } from 'ulid';
import { createLogger } from '@kynetic-bot/core';
import {
  ACPClient,
  type ACPClientHandlers,
  type CreateTerminalResponse,
  type KillTerminalCommandResponse,
  type ReleaseTerminalResponse,
  type RequestPermissionResponse,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
} from './acp/index.js';
import type {
  AgentCheckpoint,
  AgentLifecycleOptions,
  AgentLifecycleState,
  QueuedSpawnRequest,
} from './types.js';

/**
 * Terminal session state tracked by the lifecycle manager
 */
interface TerminalSession {
  /** Unique terminal identifier */
  id: string;
  /** Session ID this terminal belongs to */
  sessionId: string;
  /** The spawned child process */
  process: ChildProcess;
  /** Accumulated stdout/stderr output */
  output: string;
  /** Maximum output size before truncation (default: 1MB) */
  maxOutputSize: number;
  /** Whether output was truncated */
  truncated: boolean;
  /** Exit code if process exited normally */
  exitCode: number | null;
  /** Signal if process was killed */
  signal: string | null;
  /** Whether the process has exited */
  exited: boolean;
  /** Resolvers waiting for process exit */
  exitWaiters: Array<(result: { exitCode: number | null; signal: string | null }) => void>;
}

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

  /** Active terminal sessions */
  private terminals = new Map<string, TerminalSession>();

  /** Default max output size for terminals (1MB) */
  private readonly terminalMaxOutputSize = 1024 * 1024;

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
      healthCheckInterval: options.healthCheckInterval ?? DEFAULTS.healthCheckInterval,
      failureThreshold: options.failureThreshold ?? DEFAULTS.failureThreshold,
      shutdownTimeout: options.shutdownTimeout ?? DEFAULTS.shutdownTimeout,
      maxConcurrentSpawns: options.maxConcurrentSpawns ?? DEFAULTS.maxConcurrentSpawns,
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
   * Register a callback for stderr output from the agent process
   *
   * AC: @mem-context-usage ac-1 - Stderr output captured programmatically
   *
   * @param callback Function to call with each stderr chunk
   * @returns Unsubscribe function
   */
  onStderr(callback: (data: string) => void): () => void {
    this.on('stderr', callback);
    return () => this.off('stderr', callback);
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
    if (this.activeSpawns >= this.options.maxConcurrentSpawns || this.state === 'spawning') {
      return new Promise<void>((resolve, reject) => {
        this.spawnQueue.push({ env, resolve, reject });
        const queueLength = this.spawnQueue.length;
        log.warn('Spawn request queued', { queueLength });
        this.emit('spawn:queued', queueLength);
      });
    }

    // Can't spawn from certain states
    if (this.state !== 'idle' && this.state !== 'failed' && this.state !== 'unhealthy') {
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
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Wire up stdio streams
      if (this.process.stdin) {
        stdinStream.pipe(this.process.stdin);
      }
      if (this.process.stdout) {
        this.process.stdout.pipe(stdoutStream);
      }

      // AC: @mem-context-usage ac-1 - Capture stderr output programmatically
      if (this.process.stderr) {
        this.process.stderr.on('data', (chunk: Buffer) => {
          this.emit('stderr', chunk.toString());
        });
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
        handlers: this.createACPHandlers(),
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
        this.options.backoff.max
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
    while (this.spawnQueue.length > 0 && this.activeSpawns < this.options.maxConcurrentSpawns) {
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
    await new Promise((resolve) => setTimeout(resolve, this.currentBackoffMs));

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
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
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

    // Clean up terminal sessions
    this.cleanupTerminals();

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

  /**
   * Create ACP handlers for file operations, terminal, and permissions
   */
  private createACPHandlers(): ACPClientHandlers {
    return {
      // AC: @agent-lifecycle ac-5 - Handle file read requests from agent
      readFile: async (params) => {
        log.debug('Reading file for agent', { path: params.path });
        try {
          const content = await fs.readFile(params.path, 'utf8');
          const lines = content.split('\n');
          const start = (params.line ?? 1) - 1;
          const limit = params.limit ?? lines.length;
          const selectedLines = lines.slice(start, start + limit);
          return { content: selectedLines.join('\n') };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('Failed to read file', { path: params.path, error: error.message });
          throw error;
        }
      },

      // AC: @agent-lifecycle ac-12 - Handle file write requests from agent
      writeFile: async (params) => {
        log.debug('Writing file for agent', { path: params.path });
        try {
          await fs.writeFile(params.path, params.content, 'utf8');
          return {};
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn('Failed to write file', { path: params.path, error: error.message });
          throw error;
        }
      },

      // AC: @agent-lifecycle ac-6 - Handle permission requests (MVP: auto-allow)
      requestPermission: async (params): Promise<RequestPermissionResponse> => {
        log.debug('Permission requested', { toolCall: params.toolCall?.title });
        // Find the first "allow" option, or just use the first option
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always'
        );
        const selectedOption = allowOption ?? params.options[0];
        if (selectedOption) {
          log.info('Auto-allowing permission', {
            tool: params.toolCall?.title,
            option: selectedOption.name,
          });
          return {
            outcome: { outcome: 'selected', optionId: selectedOption.optionId },
          };
        }
        // No options available, cancel
        log.warn('No permission options available, cancelling');
        return { outcome: { outcome: 'cancelled' } };
      },

      // AC: @agent-lifecycle ac-7 - Create terminal session with command execution
      createTerminal: async (params): Promise<CreateTerminalResponse> => {
        const terminalId = ulid();
        log.info('Creating terminal', {
          terminalId,
          command: params.command,
          args: params.args,
          cwd: params.cwd,
        });

        // Build environment from params.env array
        const env: Record<string, string> = { ...process.env } as Record<string, string>;
        if (params.env) {
          for (const envVar of params.env) {
            env[envVar.name] = envVar.value;
          }
        }

        // Spawn the process
        const childProcess = spawn(params.command, params.args ?? [], {
          cwd: params.cwd ?? process.cwd(),
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });

        // Create terminal session
        const session: TerminalSession = {
          id: terminalId,
          sessionId: params.sessionId,
          process: childProcess,
          output: '',
          maxOutputSize: this.terminalMaxOutputSize,
          truncated: false,
          exitCode: null,
          signal: null,
          exited: false,
          exitWaiters: [],
        };

        // Capture stdout
        if (childProcess.stdout) {
          childProcess.stdout.on('data', (chunk: Buffer) => {
            this.appendTerminalOutput(session, chunk.toString());
          });
        }

        // Capture stderr (merge with stdout)
        if (childProcess.stderr) {
          childProcess.stderr.on('data', (chunk: Buffer) => {
            this.appendTerminalOutput(session, chunk.toString());
          });
        }

        // Handle process exit
        childProcess.on('exit', (code, signal) => {
          session.exitCode = code;
          session.signal = signal;
          session.exited = true;
          log.debug('Terminal process exited', { terminalId, code, signal });

          // Resolve all exit waiters
          for (const waiter of session.exitWaiters) {
            waiter({ exitCode: code, signal });
          }
          session.exitWaiters = [];
        });

        childProcess.on('error', (err) => {
          log.error('Terminal process error', { terminalId, error: err.message });
          session.exited = true;
          session.exitCode = 1;

          // Resolve all exit waiters with error
          for (const waiter of session.exitWaiters) {
            waiter({ exitCode: 1, signal: null });
          }
          session.exitWaiters = [];
        });

        this.terminals.set(terminalId, session);
        return { terminalId };
      },

      // AC: @agent-lifecycle ac-8 - Return stdout/stderr output since last read
      getTerminalOutput: (params): TerminalOutputResponse => {
        const session = this.terminals.get(params.terminalId);
        if (!session) {
          log.warn('Terminal not found', { terminalId: params.terminalId });
          return { output: '', truncated: false };
        }

        const response: TerminalOutputResponse = {
          output: session.output,
          truncated: session.truncated,
        };

        // Include exit status if process has exited
        if (session.exited) {
          response.exitStatus = {
            exitCode: session.exitCode,
            signal: session.signal,
          };
        }

        // Clear the output buffer after reading
        session.output = '';
        session.truncated = false;

        return response;
      },

      // AC: @agent-lifecycle ac-9 - Block until process completes and return exit code
      waitForTerminalExit: async (params): Promise<WaitForTerminalExitResponse> => {
        const session = this.terminals.get(params.terminalId);
        if (!session) {
          log.warn('Terminal not found for wait', { terminalId: params.terminalId });
          return { exitCode: 1, signal: null };
        }

        // If already exited, return immediately
        if (session.exited) {
          return {
            exitCode: session.exitCode,
            signal: session.signal,
          };
        }

        // Wait for exit
        const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
          (resolve) => {
            session.exitWaiters.push(resolve);
          }
        );

        return {
          exitCode: result.exitCode,
          signal: result.signal,
        };
      },

      // AC: @agent-lifecycle ac-10 - Terminate process and mark session as killed
      killTerminal: async (params): Promise<KillTerminalCommandResponse> => {
        const session = this.terminals.get(params.terminalId);
        if (!session) {
          log.warn('Terminal not found for kill', { terminalId: params.terminalId });
          return {};
        }

        if (!session.exited) {
          log.info('Killing terminal', { terminalId: params.terminalId });
          session.process.kill('SIGKILL');

          // Wait for the process to actually exit
          await new Promise<void>((resolve) => {
            if (session.exited) {
              resolve();
              return;
            }
            session.exitWaiters.push(() => resolve());
          });
        }

        return {};
      },

      // AC: @agent-lifecycle ac-11 - Clean up terminal resources and release session handle
      releaseTerminal: (params): ReleaseTerminalResponse => {
        const session = this.terminals.get(params.terminalId);
        if (!session) {
          log.debug('Terminal already released', { terminalId: params.terminalId });
          return {};
        }

        // Kill process if still running
        if (!session.exited) {
          log.debug('Killing terminal before release', { terminalId: params.terminalId });
          session.process.kill('SIGKILL');
        }

        // Remove from tracking
        this.terminals.delete(params.terminalId);
        log.debug('Terminal released', { terminalId: params.terminalId });

        return {};
      },
    };
  }

  /**
   * Append output to a terminal session, handling truncation
   */
  private appendTerminalOutput(session: TerminalSession, data: string): void {
    if (session.truncated) {
      // Already truncated, don't accumulate more
      return;
    }

    session.output += data;

    // Check if we need to truncate
    if (session.output.length > session.maxOutputSize) {
      session.output = session.output.slice(0, session.maxOutputSize);
      session.truncated = true;
      log.debug('Terminal output truncated', {
        terminalId: session.id,
        maxSize: session.maxOutputSize,
      });
    }
  }

  /**
   * Clean up all terminal sessions (called during shutdown)
   */
  private cleanupTerminals(): void {
    for (const [terminalId, session] of this.terminals) {
      if (!session.exited) {
        log.debug('Killing terminal during cleanup', { terminalId });
        session.process.kill('SIGKILL');
      }
    }
    this.terminals.clear();
  }
}
