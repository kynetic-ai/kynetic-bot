/**
 * Autonomous Loop
 *
 * Ralph-mode autonomous loop with circuit breaker for safe operation.
 * Processes tasks autonomously while protecting against cascading failures.
 *
 * @see @agent-autonomous
 */

import { EventEmitter } from 'node:events';
import { createLogger, KyneticError } from '@kynetic-bot/core';
import type { AgentLifecycle } from './lifecycle.js';
import type { SkillsRegistry } from './skills.js';

const log = createLogger('autonomous-loop');

// ============================================================================
// Types
// ============================================================================

/**
 * Circuit breaker states
 *
 * - closed: Normal operation, processing tasks
 * - open: Stopped after threshold exceeded, waiting for cooldown
 * - half-open: Testing with a single task after cooldown
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Autonomous loop states
 *
 * - idle: Not running
 * - running: Actively processing tasks
 * - paused: Manually paused or circuit breaker tripped
 * - stopping: Gracefully shutting down
 */
export type AutonomousState = 'idle' | 'running' | 'paused' | 'stopping';

/**
 * Configuration options for AutonomousLoop
 */
export interface AutonomousLoopOptions {
  /** Number of consecutive errors before circuit breaker trips (default: 3) */
  errorThreshold?: number;

  /** Cooldown period in milliseconds before recovery attempt (default: 60000) */
  cooldownMs?: number;

  /** Interval between task polls in milliseconds (default: 5000) */
  pollIntervalMs?: number;

  /** Optional task source for testing */
  taskSource?: TaskSource;
}

/**
 * Task representation for autonomous processing
 */
export interface AutoTask {
  /** Task reference/ID */
  ref: string;

  /** Task title */
  title: string;

  /** Optional spec reference */
  specRef?: string;

  /** Task priority */
  priority?: number;
}

/**
 * Interface for task sources (allows mocking in tests)
 */
export interface TaskSource {
  /** Poll for available tasks */
  poll(): Promise<AutoTask[]>;

  /** Mark task as started */
  start(ref: string): Promise<void>;

  /** Mark task as completed */
  complete(ref: string, reason: string): Promise<void>;

  /** Add note to task */
  note(ref: string, content: string): Promise<void>;
}

/**
 * Checkpoint data for state persistence
 */
export interface AutonomousCheckpoint {
  /** Timestamp when checkpoint was created */
  timestamp: number;

  /** Current autonomous state */
  state: AutonomousState;

  /** Circuit breaker state */
  circuitState: CircuitState;

  /** Consecutive error count */
  consecutiveErrors: number;

  /** Timestamp when circuit breaker tripped (null if not tripped) */
  circuitTrippedAt: number | null;

  /** Current task being processed (null if none) */
  currentTaskRef: string | null;
}

/**
 * Events emitted by AutonomousLoop
 */
export interface AutonomousLoopEvents {
  /** State transition occurred */
  'state:change': (from: AutonomousState, to: AutonomousState) => void;

  /** Circuit breaker state changed */
  'circuit:change': (from: CircuitState, to: CircuitState) => void;

  /** Circuit breaker tripped */
  'circuit:tripped': (consecutiveErrors: number) => void;

  /** Circuit breaker recovering (half-open) */
  'circuit:recovering': () => void;

  /** Circuit breaker reset (closed) */
  'circuit:reset': () => void;

  /** Task processing started */
  'task:start': (task: AutoTask) => void;

  /** Task processing completed */
  'task:complete': (task: AutoTask, durationMs: number) => void;

  /** Task processing failed */
  'task:error': (task: AutoTask, error: Error) => void;

  /** Poll completed */
  'poll:complete': (taskCount: number) => void;

  /** Error occurred */
  error: (error: Error, context: Record<string, unknown>) => void;

  /** Checkpoint was saved */
  'checkpoint:saved': (checkpoint: AutonomousCheckpoint) => void;

  /** Loop iteration completed */
  'loop:iteration': (iteration: number) => void;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Base error for autonomous loop operations
 */
export class AutonomousError extends KyneticError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `AUTONOMOUS_${code}`, context);
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends AutonomousError {
  constructor(cooldownRemainingMs: number) {
    super(
      `Circuit breaker is open, ${cooldownRemainingMs}ms until recovery attempt`,
      'CIRCUIT_OPEN',
      { cooldownRemainingMs },
    );
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULTS = {
  errorThreshold: 3,
  cooldownMs: 60000, // 1 minute
  pollIntervalMs: 5000, // 5 seconds
} as const;

// ============================================================================
// AutonomousLoop Implementation
// ============================================================================

/**
 * AutonomousLoop manages autonomous task processing with circuit breaker protection.
 *
 * The circuit breaker pattern provides protection against cascading failures:
 * - **Closed**: Normal operation, tasks are processed
 * - **Open**: After N consecutive errors, processing stops for cooldown
 * - **Half-open**: After cooldown, single task is attempted to test recovery
 *
 * @example
 * ```typescript
 * const loop = new AutonomousLoop(lifecycle, skills, {
 *   errorThreshold: 3,
 *   cooldownMs: 60000,
 * });
 *
 * // Start autonomous processing
 * await loop.start();
 *
 * // Listen for events
 * loop.on('circuit:tripped', (errors) => {
 *   console.log(`Circuit tripped after ${errors} errors`);
 * });
 *
 * // Stop when done
 * await loop.stop();
 * ```
 */
export class AutonomousLoop extends EventEmitter {
  private state: AutonomousState = 'idle';
  private circuitState: CircuitState = 'closed';
  private consecutiveErrors = 0;
  private circuitTrippedAt: number | null = null;
  private currentTask: AutoTask | null = null;
  private iteration = 0;

  private pollTimer: NodeJS.Timeout | null = null;
  private cooldownTimer: NodeJS.Timeout | null = null;

  private readonly options: Required<Omit<AutonomousLoopOptions, 'taskSource'>> & {
    taskSource: TaskSource;
  };

  constructor(
    private readonly lifecycle: AgentLifecycle,
    private readonly skills: SkillsRegistry,
    options: AutonomousLoopOptions = {},
  ) {
    super();

    this.options = {
      errorThreshold: options.errorThreshold ?? DEFAULTS.errorThreshold,
      cooldownMs: options.cooldownMs ?? DEFAULTS.cooldownMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      taskSource: options.taskSource ?? this.createDefaultTaskSource(),
    };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get current autonomous state
   */
  getState(): AutonomousState {
    return this.state;
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /**
   * Get consecutive error count
   */
  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  /**
   * Check if loop is running
   */
  isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start the autonomous loop
   *
   * AC: @agent-autonomous ac-1 - Processes tasks in autonomous loop
   */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'paused') {
      throw new AutonomousError(
        `Cannot start from state: ${this.state}`,
        'INVALID_STATE',
        { currentState: this.state },
      );
    }

    // Verify agent is healthy before starting
    if (!this.lifecycle.isHealthy()) {
      throw new AutonomousError(
        'Cannot start autonomous loop: agent is not healthy',
        'AGENT_NOT_HEALTHY',
        { agentState: this.lifecycle.getState() },
      );
    }

    this.transitionState('running');
    log.info('Autonomous loop started');

    // Start the polling loop in background (don't await)
    // Errors are handled internally via the error event
    void this.runLoop().catch((err) => {
      // Only emit error if we're still supposed to be running
      if (this.state === 'running') {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emitError(error, { operation: 'runLoop', fatal: true });
      }
    });
  }

  /**
   * Stop the autonomous loop gracefully
   */
  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.transitionState('stopping');
    log.info('Stopping autonomous loop');

    // Cancel timers
    this.cancelTimers();

    // Wait for current task to complete (with timeout)
    if (this.currentTask) {
      log.info('Waiting for current task to complete', { task: this.currentTask.ref });
      // Give current task a reasonable time to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.transitionState('idle');
    log.info('Autonomous loop stopped');
  }

  /**
   * Pause the autonomous loop
   */
  pause(): void {
    if (this.state !== 'running') {
      return;
    }

    this.transitionState('paused');
    this.cancelTimers();
    log.info('Autonomous loop paused');
  }

  /**
   * Resume the autonomous loop
   */
  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      throw new AutonomousError(
        'Can only resume from paused state',
        'INVALID_STATE',
        { currentState: this.state },
      );
    }

    // If circuit is open, check if we can recover
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - (this.circuitTrippedAt ?? 0);
      if (elapsed < this.options.cooldownMs) {
        throw new CircuitBreakerOpenError(this.options.cooldownMs - elapsed);
      }
    }

    await this.start();
  }

  /**
   * Manually reset the circuit breaker
   *
   * Use with caution - only when you're confident the underlying issue is resolved.
   */
  resetCircuitBreaker(): void {
    if (this.circuitState === 'closed') {
      return;
    }

    const oldState = this.circuitState;
    this.circuitState = 'closed';
    this.consecutiveErrors = 0;
    this.circuitTrippedAt = null;

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    this.emitCircuitChange(oldState, 'closed');
    this.emit('circuit:reset');
    log.info('Circuit breaker manually reset');
  }

  /**
   * Create checkpoint for state persistence
   *
   * AC: @trait-recoverable ac-1 - Saves checkpoint
   */
  getCheckpoint(): AutonomousCheckpoint {
    const checkpoint: AutonomousCheckpoint = {
      timestamp: Date.now(),
      state: this.state,
      circuitState: this.circuitState,
      consecutiveErrors: this.consecutiveErrors,
      circuitTrippedAt: this.circuitTrippedAt,
      currentTaskRef: this.currentTask?.ref ?? null,
    };

    this.emit('checkpoint:saved', checkpoint);
    return checkpoint;
  }

  /**
   * Restore from checkpoint
   *
   * AC: @trait-recoverable ac-2 - Restores from checkpoint
   *
   * @returns true if restoration succeeded
   */
  restoreFromCheckpoint(checkpoint: AutonomousCheckpoint): boolean {
    if (this.state !== 'idle') {
      log.warn('Cannot restore checkpoint, not in idle state', { currentState: this.state });
      return false;
    }

    this.circuitState = checkpoint.circuitState;
    this.consecutiveErrors = checkpoint.consecutiveErrors;
    this.circuitTrippedAt = checkpoint.circuitTrippedAt;

    log.info('Restored from checkpoint', {
      timestamp: checkpoint.timestamp,
      savedState: checkpoint.state,
      circuitState: checkpoint.circuitState,
      consecutiveErrors: checkpoint.consecutiveErrors,
    });

    // If circuit was open, schedule cooldown timer
    if (this.circuitState === 'open' && this.circuitTrippedAt) {
      const elapsed = Date.now() - this.circuitTrippedAt;
      const remaining = Math.max(0, this.options.cooldownMs - elapsed);

      if (remaining > 0) {
        this.scheduleCooldownRecovery(remaining);
      } else {
        // Cooldown already expired, transition to half-open
        this.transitionCircuitState('half-open');
      }
    }

    return true;
  }

  // ==========================================================================
  // Private - Main Loop
  // ==========================================================================

  /**
   * Main autonomous processing loop
   */
  private async runLoop(): Promise<void> {
    while (this.state === 'running') {
      this.iteration++;
      this.emit('loop:iteration', this.iteration);

      // Check if we should stop early
      if (this.state !== 'running') {
        break;
      }

      // Check circuit breaker
      if (this.circuitState === 'open') {
        // Wait for cooldown timer to transition to half-open
        await this.waitForNextPoll();
        continue;
      }

      try {
        // Check state again after each await
        if (this.state !== 'running') {
          break;
        }

        // Poll for tasks
        const tasks = await this.pollTasks();

        // Check state after poll
        if (this.state !== 'running') {
          break;
        }

        if (tasks.length === 0) {
          // No tasks available, wait and poll again
          await this.waitForNextPoll();
          continue;
        }

        // Process first available task
        const task = tasks[0];
        await this.processTask(task);

        // Check state after task processing
        if (this.state !== 'running') {
          break;
        }

        // Success - handle circuit breaker recovery
        if (this.circuitState === 'half-open') {
          // Recovery successful, close circuit
          this.transitionCircuitState('closed');
          this.consecutiveErrors = 0;
          this.emit('circuit:reset');
          log.info('Circuit breaker reset after successful recovery');
        } else {
          // Normal success, reset error count
          this.consecutiveErrors = 0;
        }
      } catch (err) {
        // Don't handle errors if we're stopping
        if (this.state !== 'running') {
          break;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        this.handleLoopError(error);
      }

      // Check if we should continue
      if (this.state !== 'running') {
        break;
      }

      // Wait before next iteration
      await this.waitForNextPoll();
    }
  }

  /**
   * Poll for available tasks
   */
  private async pollTasks(): Promise<AutoTask[]> {
    try {
      const tasks = await this.options.taskSource.poll();
      this.emit('poll:complete', tasks.length);
      log.debug('Polled for tasks', { count: tasks.length });
      return tasks;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error, { operation: 'poll' });
      throw error;
    }
  }

  /**
   * Process a single task
   *
   * AC: @agent-autonomous ac-1 - Processes task in autonomous loop
   */
  private async processTask(task: AutoTask): Promise<void> {
    const startTime = Date.now();
    this.currentTask = task;

    this.emit('task:start', task);
    log.info('Processing task', { ref: task.ref, title: task.title });

    try {
      // Mark task as started
      await this.options.taskSource.start(task.ref);

      // Execute task using skills
      // For now, we emit an event and let the orchestrator handle actual execution
      // In a full implementation, this would invoke the appropriate skill

      // Add processing note
      await this.options.taskSource.note(
        task.ref,
        `Autonomous processing started by autonomous loop`,
      );

      // Complete task
      await this.options.taskSource.complete(
        task.ref,
        'Processed by autonomous loop',
      );

      const durationMs = Date.now() - startTime;
      this.emit('task:complete', task, durationMs);
      log.info('Task completed', { ref: task.ref, durationMs });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('task:error', task, error);
      log.error('Task processing failed', { ref: task.ref, error: error.message });
      throw error;
    } finally {
      this.currentTask = null;
    }
  }

  /**
   * Handle errors in the main loop
   */
  private handleLoopError(error: Error): void {
    this.consecutiveErrors++;
    this.emitError(error, {
      operation: 'loop',
      consecutiveErrors: this.consecutiveErrors,
      circuitState: this.circuitState,
    });

    log.warn('Loop error', {
      error: error.message,
      consecutiveErrors: this.consecutiveErrors,
      threshold: this.options.errorThreshold,
    });

    // Check if circuit breaker should trip
    if (this.consecutiveErrors >= this.options.errorThreshold) {
      this.tripCircuitBreaker();
    }
  }

  // ==========================================================================
  // Private - Circuit Breaker
  // ==========================================================================

  /**
   * Trip the circuit breaker
   *
   * AC: @agent-autonomous ac-2 - Pauses operation and alerts on consecutive errors
   */
  private tripCircuitBreaker(): void {
    if (this.circuitState === 'open') {
      return; // Already open
    }

    this.transitionCircuitState('open');
    this.circuitTrippedAt = Date.now();

    // Emit alert
    this.emit('circuit:tripped', this.consecutiveErrors);
    log.warn('Circuit breaker tripped', {
      consecutiveErrors: this.consecutiveErrors,
      cooldownMs: this.options.cooldownMs,
    });

    // Pause the loop
    this.transitionState('paused');

    // Schedule recovery attempt after cooldown
    this.scheduleCooldownRecovery(this.options.cooldownMs);
  }

  /**
   * Schedule transition to half-open after cooldown
   *
   * AC: @agent-autonomous ac-3 - Transitions to half-open after cooldown
   */
  private scheduleCooldownRecovery(delayMs: number): void {
    this.cooldownTimer = setTimeout(() => {
      if (this.circuitState === 'open') {
        this.transitionCircuitState('half-open');
        this.emit('circuit:recovering');
        log.info('Circuit breaker transitioning to half-open for recovery');
      }
    }, delayMs);
  }

  /**
   * Transition circuit breaker state
   */
  private transitionCircuitState(newState: CircuitState): void {
    if (this.circuitState === newState) {
      return;
    }

    const oldState = this.circuitState;
    this.circuitState = newState;
    this.emitCircuitChange(oldState, newState);

    log.debug('Circuit state transition', { from: oldState, to: newState });
  }

  // ==========================================================================
  // Private - Helpers
  // ==========================================================================

  /**
   * Create default task source using kspec CLI
   */
  private createDefaultTaskSource(): TaskSource {
    return {
      poll: async () => {
        // In real implementation, this would call kspec CLI
        // kspec tasks ready --automation eligible --json
        return [];
      },
      start: async () => {
        // kspec task start @ref
      },
      complete: async () => {
        // kspec task complete @ref --reason "..."
      },
      note: async () => {
        // kspec task note @ref "..."
      },
    };
  }

  /**
   * Wait for next poll interval
   */
  private async waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      this.pollTimer = setTimeout(resolve, this.options.pollIntervalMs);
    });
  }

  /**
   * Cancel all timers
   */
  private cancelTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  /**
   * Transition autonomous state
   */
  private transitionState(newState: AutonomousState): void {
    if (this.state === newState) {
      return;
    }

    const oldState = this.state;
    this.state = newState;
    this.emit('state:change', oldState, newState);

    log.debug('State transition', { from: oldState, to: newState });
  }

  /**
   * Emit circuit change event
   */
  private emitCircuitChange(from: CircuitState, to: CircuitState): void {
    this.emit('circuit:change', from, to);
  }

  /**
   * Emit error event with context
   *
   * AC: @trait-observable ac-2 - Logs with context and severity
   */
  private emitError(error: Error, context: Record<string, unknown>): void {
    this.emit('error', error, {
      state: this.state,
      circuitState: this.circuitState,
      consecutiveErrors: this.consecutiveErrors,
      iteration: this.iteration,
      ...context,
    });
  }
}
